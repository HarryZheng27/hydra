import type { ClientMessage } from './model';
import type { NeedsYouItem, NeedsYouKind } from './needsYou';

/**
 * The Needs you list's keys and put-offs (docs/internal/Needs_You_Plan.md, Phase 5). Pure: the views call these and
 * keep nothing of their own but the cursor.
 *
 * Every action is a message the canvas already sends, so it takes the same controller path and asks the same
 * confirmations. The one thing the list adds is that a key never merges: a merge asks in the list first.
 */

/** What a key does to an item, as the view should carry it out. */
export type NeedsYouAction =
  /** Send this to the controller, as the canvas would. */
  | { kind: 'send'; message: ClientMessage }
  /** Ask in the list first, then send. Merging is never one key. */
  | { kind: 'confirm'; message: ClientMessage; question: string; button: string }
  /** Go to the head on the canvas or the lane in the Lanes view. */
  | { kind: 'open'; view: 'canvas' | 'lanes'; focus?: string }
  /** A chat: the app opens it (the IDE has no chats of its own to open). */
  | { kind: 'chat'; chatId: string };

/** The primary action's label (E). */
export const primaryLabel: Readonly<Record<NeedsYouKind, string>> = {
  'head-question': 'Answer',
  'limit-offer': 'Continue in the other provider',
  'chat-needs': 'Open chat',
  'plan-merge': 'Merge plan',
  'plan-stopped': 'Retry failed jobs',
  'lane-gates': 'Send to lane',
  'lane-waiting': 'Open lane',
  'plan-report': 'Open report',
  'chat-unread': 'Open chat',
  'lane-finished': 'Open lane',
  'head-finished': 'Open diff',
};

const isChat = (kind: NeedsYouKind) => kind === 'chat-needs' || kind === 'chat-unread';
const isLane = (kind: NeedsYouKind) => kind === 'lane-waiting' || kind === 'lane-finished' || kind === 'lane-gates';
const isHead = (kind: NeedsYouKind) => kind === 'head-question' || kind === 'head-finished';

/** Enter: show the item where it lives. */
export function openAction(item: NeedsYouItem): NeedsYouAction {
  if (isChat(item.kind)) return { kind: 'chat', chatId: item.sourceId };
  if (isLane(item.kind)) return { kind: 'open', view: 'lanes', focus: item.sourceId };
  if (isHead(item.kind)) return { kind: 'open', view: 'canvas', focus: item.sourceId };
  return { kind: 'open', view: 'canvas' };
}

/** E: the item's primary action, through the message the canvas sends for it. */
export function primaryAction(item: NeedsYouItem): NeedsYouAction {
  switch (item.kind) {
    case 'head-question': return { kind: 'send', message: { type: 'helperAnswer', jobId: item.sourceId } };
    case 'head-finished': return { kind: 'send', message: { type: 'helperReview', jobId: item.sourceId } };
    case 'limit-offer': return { kind: 'send', message: { type: 'limitContinue', id: item.sourceId } };
    case 'plan-merge': return { kind: 'confirm', message: { type: 'planMerge', id: item.sourceId, via: 'merge' }, question: `Merge plan "${item.title}"?${item.detail ? ` ${item.detail}.` : ''}`, button: 'Merge plan' };
    case 'plan-stopped': return { kind: 'send', message: { type: 'planRetryJobs', id: item.sourceId } };
    case 'plan-report': return { kind: 'send', message: { type: 'planReport', id: item.sourceId } };
    case 'lane-gates': return { kind: 'send', message: { type: 'laneAction', id: item.sourceId, action: 'sendGates' } };
    default: return openAction(item);
  }
}

/** 1 to 4 on a head's question: that choice. Undefined when the item has no such option. */
export function optionAction(item: NeedsYouItem, option: number): NeedsYouAction | undefined {
  if (item.kind !== 'head-question' || !item.options?.some(candidate => candidate.option === option)) return undefined;
  return { kind: 'send', message: { type: 'headOption', jobId: item.sourceId, option } };
}

/** R: a head's question, answered in your own words. */
export function replyAction(item: NeedsYouItem): NeedsYouAction | undefined {
  return item.kind === 'head-question' ? { kind: 'send', message: { type: 'helperReply', jobId: item.sourceId } } : undefined;
}

export const kindLabel: Readonly<Record<NeedsYouKind, string>> = {
  'head-question': 'Question', 'limit-offer': 'Usage limit', 'chat-needs': 'Chat waiting', 'plan-merge': 'Ready to merge', 'plan-stopped': 'Plan stopped',
  'lane-gates': 'Gates failed', 'lane-waiting': 'Lane waiting', 'plan-report': 'Plan report', 'chat-unread': 'Chat finished', 'lane-finished': 'Lane finished', 'head-finished': 'Head finished',
};

export const emptyNeedsYou = 'Nothing needs you.';

/** "12m", "1h 05m": how long until a deadline, for an item on a clock. */
export function timeLeft(deadline: number, now: number): string {
  const seconds = Math.max(0, Math.round((deadline - now) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

// ---- Put-offs ----

/** L: how long it puts an item off, from the choices the view offers. The most a put-off can be is `maxPutOffMs`. */
export const putOffChoices: readonly { label: string; ms: number }[] = [
  { label: '1 hour', ms: 60 * 60_000 },
  { label: '4 hours', ms: 4 * 60 * 60_000 },
  { label: 'Tomorrow', ms: 24 * 60 * 60_000 },
];
export const maxPutOffMs = 30 * 24 * 60 * 60_000;
/** The most put-offs kept, so the stored list can't grow without bound. */
export const maxPutOffs = 200;

/** What an item is put off by: its kind and source, not its project, so a controller that doesn't know its own project id can still keep them. */
export const putOffKey = (item: Pick<NeedsYouItem, 'kind' | 'sourceId'>): string => `${item.kind}:${item.sourceId}`;

export interface PutOff { id: string; until: number }

/**
 * Items the user put off until a time they chose, kept locally by the view and never touching the work itself. An
 * item comes back by itself when its time passes; Z brings back the last one put off at once.
 */
export class PutOffs {
  private entries: PutOff[];
  constructor(entries: readonly PutOff[] = []) { this.entries = entries.map(entry => ({ ...entry })); }

  /** Reads what `toJSON` wrote; anything else (a bad or missing value) is no put-offs. */
  static parse(raw: unknown, now: number): PutOffs {
    const list = typeof raw === 'string' ? safeJson(raw) : raw;
    if (!Array.isArray(list)) return new PutOffs();
    const entries: PutOff[] = [];
    for (const value of list) {
      if (!value || typeof value !== 'object') continue;
      const { id, until } = value as Record<string, unknown>;
      if (typeof id === 'string' && id.length <= 400 && typeof until === 'number' && Number.isFinite(until) && until > now) entries.push({ id, until });
    }
    return new PutOffs(entries.slice(-maxPutOffs));
  }

  /** Puts an item off (by `putOffKey`); putting it off again moves it to the end, so Z undoes the latest. */
  putOff(id: string, until: number): void {
    this.entries = [...this.entries.filter(entry => entry.id !== id), { id, until }].slice(-maxPutOffs);
  }
  /** Z: brings back the item put off last that is still put off; its id, or undefined when there is nothing to undo. */
  undo(now: number): string | undefined {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index]!;
      if (entry.until <= now) continue;
      this.entries.splice(index, 1);
      return entry.id;
    }
    return undefined;
  }
  /** Brings back one item put off, by its key; whether it was put off. */
  remove(id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter(entry => entry.id !== id);
    return this.entries.length !== before;
  }
  isPutOff(id: string, now: number): boolean { return this.entries.some(entry => entry.id === id && entry.until > now); }
  /** The items to show: everything not put off right now. */
  visible(items: readonly NeedsYouItem[], now: number): NeedsYouItem[] { return items.filter(item => !this.isPutOff(putOffKey(item), now)); }
  /** The next time a put-off ends (ms), so a view can wake then and no sooner. */
  nextReturn(now: number): number | undefined {
    const times = this.entries.map(entry => entry.until).filter(until => until > now);
    return times.length ? Math.min(...times) : undefined;
  }
  /** Drops the ones that ended, and ids of items that are gone (they were handled elsewhere). */
  prune(now: number, live?: ReadonlySet<string>): void { this.entries = this.entries.filter(entry => entry.until > now && (!live || live.has(entry.id))); }
  get size(): number { return this.entries.length; }
  toJSON(): PutOff[] { return this.entries.map(entry => ({ ...entry })); }
}

function safeJson(text: string): unknown { try { return JSON.parse(text); } catch { return undefined; } }

/** The count the status bar and the sidebar show: what is waiting and not put off. */
export const needsYouCount = (items: readonly NeedsYouItem[], putOffs: PutOffs, now: number): number => putOffs.visible(items, now).length;

/** Where put-offs are kept (the controller's workspace state; the app's own file for chats). */
export const putOffStorageKey = 'hydra.needsYou.putOff.v1';

// ---- Keys ----

/** What the list remembers between keys: the item the cursor is on, the open put-off menu, the item asking to merge. */
export interface ListState { cursor: number; menu?: string; confirming?: string }
export type KeyEffect =
  | { kind: 'action'; action: NeedsYouAction; item: NeedsYouItem }
  | { kind: 'putOff'; item: NeedsYouItem; ms: number }
  | { kind: 'undo' };
/** `handled`: the key was the list's, so the view stops the browser acting on it too. */
export interface KeyResult { state: ListState; effect?: KeyEffect; handled: boolean }

/** Where the cursor goes when items change: it stays on the same item when that is still there, else the nearest. */
export function clampCursor(items: readonly NeedsYouItem[], cursor: number, selectedId?: string): number {
  const at = selectedId ? items.findIndex(item => item.id === selectedId) : -1;
  return at >= 0 ? at : Math.min(Math.max(cursor, 0), Math.max(items.length - 1, 0));
}

/**
 * One key in the list (J/K or the arrows, Enter, 1-4, R, E, L, Z). Pure: the view carries out `effect`.
 *
 *  - Enter only opens. E runs the primary action, but for a merge it only asks (`confirming`): nothing is sent until the
 *    view's own Merge button is pressed, so no single key ever merges.
 *  - With the put-off menu open, 1-3 pick how long and Escape closes it; every other key is ignored.
 */
export function keyStep(state: ListState, items: readonly NeedsYouItem[], rawKey: string): KeyResult {
  const key = rawKey.length === 1 ? rawKey.toLowerCase() : rawKey;
  const none: KeyResult = { state, handled: false };
  if (key === 'z') return { state, effect: { kind: 'undo' }, handled: true };
  if (!items.length) return none;
  const cursor = clampCursor(items, state.cursor);
  const current = items[cursor]!;
  if (state.menu) {
    if (key === 'Escape') return { state: { cursor }, handled: true };
    const choice = /^[1-9]$/.test(key) ? putOffChoices[Number(key) - 1] : undefined;
    const target = items.find(item => item.id === state.menu) ?? current;
    if (choice) return { state: { cursor }, effect: { kind: 'putOff', item: target, ms: choice.ms }, handled: true };
    return { state, handled: true };
  }
  const move = (to: number): KeyResult => ({ state: { cursor: Math.min(Math.max(to, 0), items.length - 1) }, handled: true });
  if (key === 'j' || key === 'ArrowDown') return move(cursor + 1);
  if (key === 'k' || key === 'ArrowUp') return move(cursor - 1);
  if (key === 'Escape') return { state: { cursor }, handled: !!state.confirming };
  if (key === 'Enter') return { state: { cursor }, effect: { kind: 'action', action: openAction(current), item: current }, handled: true };
  if (key === 'e') {
    const action = primaryAction(current);
    return action.kind === 'confirm' ? { state: { cursor, confirming: current.id }, handled: true } : { state: { cursor }, effect: { kind: 'action', action, item: current }, handled: true };
  }
  if (key === 'r') { const action = replyAction(current); return action ? { state: { cursor }, effect: { kind: 'action', action, item: current }, handled: true } : none; }
  if (key === 'l') return { state: { cursor, menu: current.id }, handled: true };
  if (key >= '1' && key <= '4') { const action = optionAction(current, Number(key)); return action ? { state: { cursor }, effect: { kind: 'action', action, item: current }, handled: true } : none; }
  return none;
}
