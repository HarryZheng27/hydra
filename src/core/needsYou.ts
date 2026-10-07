import { redactText } from './redact';

/**
 * "Needs you" (docs/internal/Needs_You_Plan.md, Phases 1 and 5): the decisions only the user can make, derived from
 * state Hydra already keeps. Nothing here is stored: a caller gathers `NeedsYouFacts` per project from its chats,
 * heads, plans and limit events, and `deriveNeedsYou` returns the items in the order the user should see them.
 *
 * Rules the plan sets, kept here:
 *  - Decisions, not agents. A head's question is the user's only when no lead is going to answer it
 *    (`leadWaiting`); likewise a plan that stopped.
 *  - Nothing an agent writes moves an item: the order depends on the kind, the time it began waiting and its id.
 *  - Banners (`AwayBanners`) say that something needs the user and where, never what: a project and a title only,
 *    redacted and cut short, since they show on a locked screen.
 *
 * Pure: no clock, no Electron, no files.
 */

/** What is waiting (the table in Needs_You_Plan.md, Phase 5). */
export type NeedsYouKind = 'head-question' | 'limit-offer' | 'chat-needs' | 'plan-merge' | 'plan-stopped' | 'lane-gates' | 'lane-waiting'
  | 'plan-report' | 'chat-unread' | 'lane-finished' | 'head-finished';

/** First the items on a clock, then decisions that unblock work, then things to read. */
export type NeedsYouTier = 'clock' | 'decision' | 'read';

export const needsYouTiers: Readonly<Record<NeedsYouKind, NeedsYouTier>> = {
  'head-question': 'clock',
  'limit-offer': 'clock',
  'chat-needs': 'decision',
  'plan-merge': 'decision',
  'plan-stopped': 'decision',
  'lane-gates': 'decision',
  'lane-waiting': 'decision',
  'plan-report': 'read',
  'chat-unread': 'read',
  'lane-finished': 'read',
  'head-finished': 'read',
};
/** Kinds that never raise an OS banner: things to read, which the list shows when the user is back (Phase 1 banners the rest). */
const quietKinds: ReadonlySet<NeedsYouKind> = new Set(['lane-finished', 'head-finished']);
const tierOrder: Readonly<Record<NeedsYouTier, number>> = { clock: 0, decision: 1, read: 2 };

/** A chat's status in the sidebar (app/src/renderer/chatStatus.ts). `working` and idle chats don't need the user. */
export interface ChatFact { id: string; title: string; status?: 'working' | 'needs' | 'unread'; since: number }
/** A head, from `headViews()`. `leadWaiting`: a lead is in hydra_wait_for_heads (or hydra_plan_wait, for a plan's job) and will answer. */
export interface HeadFact {
  id: string; title: string; state: string; since: number; leadWaiting: boolean; answersAt?: number;
  /** A blocked head's question and the choices it offered, numbered from 1 (exactly one recommended). Shown in the list, never in a banner. */
  question?: string; options?: readonly NeedsYouOption[];
}
export interface NeedsYouOption { option: number; text: string; recommended?: boolean }
/** A head that finished and nobody merged: no lead waiting on it, not a plan's job, and the Finished tray still shows it. */
export interface FinishedHeadFact { id: string; title: string; since: number; headline?: string; evidence?: string }
/**
 * A lane that isn't merged or closed. `attention`: its agent is waiting on you, or ended its turn (Phase 4).
 * `failedGates`: the gates that failed on its current commit and weren't accepted, so Merge would stop at them.
 */
export interface LaneFact { id: string; name: string; since: number; goal?: string; attention?: 'waiting' | 'turn-ended'; attentionSince?: number; failedGates?: readonly string[]; gatesSince?: number }
/**
 * A plan. `stopped`: nothing left to run but a job failed or is asking (`incomplete`). `readyToMerge`: its integration
 * gate passed on the current tip and it isn't merged. `leadWaiting`: a lead is in hydra_plan_wait for it.
 * `reportReady`: an unattended plan ended and its report is written.
 */
export interface PlanFact {
  id: string; title: string; since: number; stopped: boolean; readyToMerge: boolean; leadWaiting: boolean; reportReady: boolean;
  /** What the list says under the title: the integration gate's label and branch (ready to merge), or the jobs that failed (stopped). */
  gate?: string; branch?: string; failedJobs?: readonly string[];
}
/** The latest usage-limit event for a provider that is still limited, with a chat or head to offer to continue elsewhere. */
export interface LimitOfferFact { id: string; provider: string; since: number; resetsAt?: number }

export interface NeedsYouFacts {
  projectId: string;
  projectName: string;
  chats?: readonly ChatFact[];
  heads?: readonly HeadFact[];
  plans?: readonly PlanFact[];
  limitOffers?: readonly LimitOfferFact[];
  lanes?: readonly LaneFact[];
  finishedHeads?: readonly FinishedHeadFact[];
}

export interface NeedsYouItem {
  /** Stable while the item waits: kind, project and source. */
  id: string;
  kind: NeedsYouKind;
  tier: NeedsYouTier;
  projectId: string;
  projectName: string;
  /** The chat, head or plan's title; for a usage-limit offer, the provider. Free text: redact before it leaves the app. */
  title: string;
  /** The chat, head, plan or limit event it comes from. */
  sourceId: string;
  /** When it began waiting (ms). */
  since: number;
  /** Items on a clock only: when Hydra answers or the limit resets (ms). */
  deadline?: number;
  /** One line under the title: the question, the failed gates, the gate label. Free text from the work: it shows in the list, never in a banner. */
  detail?: string;
  /** A head's question's choices, numbered from 1. */
  options?: readonly NeedsYouOption[];
}

const itemId = (kind: NeedsYouKind, projectId: string, sourceId: string) => `${kind}:${projectId}:${sourceId}`;

/** An unattended plan's report stays a "read" item this long; older ones are history, not something waiting. */
export const reportMaxAgeMs = 24 * 60 * 60_000;

/** The order the user sees: tier, then the oldest first, then id so equal times never shuffle. */
export function compareNeedsYou(a: NeedsYouItem, b: NeedsYouItem): number {
  return tierOrder[a.tier] - tierOrder[b.tier] || a.since - b.since || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Every item waiting on the user across the given projects, in order. */
export function deriveNeedsYou(projects: readonly NeedsYouFacts[], now: number): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  for (const project of projects) {
    const add = (kind: NeedsYouKind, sourceId: string, title: string, since: number, extra: { deadline?: number; detail?: string; options?: readonly NeedsYouOption[] } = {}) =>
      items.push({
        id: itemId(kind, project.projectId, sourceId), kind, tier: needsYouTiers[kind], projectId: project.projectId, projectName: project.projectName, title, sourceId, since,
        ...(extra.deadline !== undefined ? { deadline: extra.deadline } : {}), ...(extra.detail ? { detail: extra.detail } : {}), ...(extra.options?.length ? { options: extra.options } : {}),
      });
    for (const chat of project.chats ?? []) {
      if (chat.status === 'needs') add('chat-needs', chat.id, chat.title, chat.since);
      else if (chat.status === 'unread') add('chat-unread', chat.id, chat.title, chat.since);
    }
    for (const head of project.heads ?? []) {
      if (head.state === 'blocked' && !head.leadWaiting) add('head-question', head.id, head.title, head.since, { deadline: head.answersAt, detail: head.question, options: head.options });
    }
    for (const plan of project.plans ?? []) {
      if (plan.readyToMerge && !plan.leadWaiting) add('plan-merge', plan.id, plan.title, plan.since, { detail: [plan.gate, plan.branch].filter(Boolean).join(' · ') });
      if (plan.stopped && !plan.leadWaiting) add('plan-stopped', plan.id, plan.title, plan.since, { detail: plan.failedJobs?.length ? `Failed: ${plan.failedJobs.join(', ')}` : undefined });
      if (plan.reportReady && now - plan.since < reportMaxAgeMs) add('plan-report', plan.id, plan.title, plan.since);
    }
    for (const lane of project.lanes ?? []) {
      if (lane.failedGates?.length) add('lane-gates', lane.id, lane.name, lane.gatesSince ?? lane.since, { detail: `Gates failed: ${lane.failedGates.join(', ')}` });
      if (lane.attention === 'waiting') add('lane-waiting', lane.id, lane.name, lane.attentionSince ?? lane.since, { detail: lane.goal });
      else if (lane.attention === 'turn-ended') add('lane-finished', lane.id, lane.name, lane.attentionSince ?? lane.since, { detail: lane.goal });
    }
    for (const head of project.finishedHeads ?? []) add('head-finished', head.id, head.title, head.since, { detail: [head.headline, head.evidence].filter(Boolean).join(' · ') });
    for (const offer of project.limitOffers ?? []) {
      if (offer.resetsAt === undefined || offer.resetsAt > now) add('limit-offer', offer.id, offer.provider, offer.since, { deadline: offer.resetsAt });
    }
  }
  return items.sort(compareNeedsYou);
}

// ---- Banners ----

/** Idle this long counts as away even with Hydra focused: the user may have walked off. */
export const awayIdleSeconds = 5 * 60;
/** About how long a banner's project and title may be. */
export const bannerTextLimit = 110;

export interface Presence { focused: boolean; idleSeconds: number }
/** Away: Hydra isn't the focused window, or the machine has been idle 5 minutes or more. Focused and active is never away. */
export const isAway = (presence: Presence): boolean => !presence.focused || presence.idleSeconds >= awayIdleSeconds;

const controlCharacters = /[\x00-\x1f\x7f-\x9f]+/g;

/**
 * One line, secrets masked, cut at a word boundary to at most `limit` characters ("…" included). Masked before it is
 * cut, so a cut never leaves half a secret the masker can no longer recognise.
 */
export function bannerText(text: string, limit = bannerTextLimit): string {
  const line = redactText(text).replace(controlCharacters, ' ').replace(/\s+/g, ' ').trim();
  if (line.length <= limit) return line;
  const room = limit - 1;
  const cut = line.slice(0, room + 1);
  const space = cut.lastIndexOf(' ');
  const head = (space > room / 2 ? cut.slice(0, space) : line.slice(0, room)).replace(/[\s.,;:!?-]+$/, '');
  return `${head}…`;
}

/** What an OS banner may say. Never a count, a question or a summary. */
/** `projectId`, `sourceId` and `kind` say where a click goes; they are never shown. */
export interface BannerContent { title: string; body: string; projectId: string; itemId: string; sourceId: string; kind: NeedsYouKind }

/** The banner for an item: "Hydra needs you in <project>" and the item's title. */
export function bannerFor(item: NeedsYouItem): BannerContent {
  return {
    title: `Hydra needs you in ${bannerText(item.projectName, 60)}`,
    body: bannerText(item.title),
    projectId: item.projectId, itemId: item.id, sourceId: item.sourceId, kind: item.kind,
  };
}

/**
 * When to show OS banners (Needs_You_Plan.md, Phase 1). Feed it the current items and whether the user is present,
 * on every change and on a timer (idle time is only known by asking); it returns the banner to show, if any.
 *
 *  - Nothing while Hydra is focused and the user is active.
 *  - One banner per stretch away, for the most urgent item not yet announced, however many arrive after it.
 *  - At most one more in the same stretch, for an item on a clock that arrives after the first.
 *  - An item has to have waited `graceMs` first: a lead that is about to answer a head's question, or a chat that
 *    resumes at once, never gets as far as a banner.
 *  - Coming back (focused and active) ends the stretch. An item already announced isn't announced again by a later
 *    stretch while it still waits; one that left and returned is new.
 */
export class AwayBanners {
  private announced = new Set<string>();
  private sent = 0;
  constructor(private readonly graceMs = 0) {}

  update(items: readonly NeedsYouItem[], presence: Presence, now: number): BannerContent | undefined {
    const live = new Set(items.map(item => item.id));
    for (const id of this.announced) if (!live.has(id)) this.announced.delete(id);
    if (!isAway(presence)) { this.sent = 0; return undefined; }
    const fresh = items.filter(item => !this.announced.has(item.id) && !quietKinds.has(item.kind) && now - item.since >= this.graceMs);
    if (!fresh.length) return undefined;
    // `items` is ordered most urgent first (deriveNeedsYou).
    let pick: NeedsYouItem | undefined;
    if (this.sent === 0) pick = fresh[0];
    else if (this.sent === 1) pick = fresh.find(item => item.tier === 'clock');
    // Everything that arrived is covered by "Hydra needs you", sent or not: only a clock item earns a second banner.
    for (const item of fresh) this.announced.add(item.id);
    if (!pick) return undefined;
    this.sent += 1;
    return bannerFor(pick);
  }
}
