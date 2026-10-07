import path from 'node:path';
import { isInside, maxEventAgeMs, maxEventFileBytes } from './limitDetection';
import { isLaneId } from './lanes';

/**
 * A lane's agent says it's waiting on you, or has ended its turn (docs/internal/Needs_You_Plan.md,
 * Phase 4). Claude Code's Stop and Notification hooks and Codex's turn-complete notifier produce
 * these; the lane's tile shows them. They are hints for the tile, never a source of truth for the work.
 */
export type LaneAttention = 'waiting' | 'turn-ended';
export const laneAttentions: readonly LaneAttention[] = ['waiting', 'turn-ended'];
export interface AttentionEvent {
  provider: 'claude' | 'codex';
  attention: LaneAttention;
  /** ISO time. */
  at: string;
  cwd?: string;
  sessionId?: string;
  /** The lane's 12-hex id, from HYDRA_LANE_ID in the hook's environment. */
  laneId?: string;
}

/** Event files go in this folder inside the limit events folder, which the usage-limit watcher never reads into. */
export const attentionFolder = 'attention';
export const attentionDirectory = (eventsDir: string): string => path.join(eventsDir, attentionFolder);

const absolute = (value: unknown): string | undefined => typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && path.isAbsolute(value) ? value : undefined;
const sessionId = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : undefined;

/** Notification types that mean the agent is waiting on you: a permission prompt or a question. (`idle_prompt` is the turn's end, which Stop already says.) */
export const waitingNotificationTypes: ReadonlySet<string> = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog']);

/**
 * Claude Code's hook input (code.claude.com/docs/en/hooks): Stop is `{ hook_event_name: "Stop", cwd, session_id, … }`;
 * Notification adds `notification_type` and `message`. Only those two events, and only the types above, count.
 * `at` is the time the hook ran; a bad or missing `cwd` gives no event.
 */
export function normaliseClaudeAttention(payload: unknown, now = new Date()): AttentionEvent | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const data = payload as Record<string, unknown>;
  const cwd = absolute(data.cwd);
  if (!cwd) return undefined;
  let attention: LaneAttention;
  if (data.hook_event_name === 'Stop') attention = 'turn-ended';
  else if (data.hook_event_name === 'Notification' && typeof data.notification_type === 'string' && waitingNotificationTypes.has(data.notification_type)) attention = 'waiting';
  else return undefined;
  const id = sessionId(data.session_id);
  return { provider: 'claude', attention, at: now.toISOString(), cwd, ...(id ? { sessionId: id } : {}) };
}

/**
 * Codex's `notify` program gets one JSON argument: `{ "type": "agent-turn-complete", "thread-id", "cwd", … }`
 * (the only type Codex sends). `fallbackCwd` is where the notifier itself runs, for when the argument can't be read.
 */
export function normaliseCodexNotify(payload: unknown, fallbackCwd?: string, now = new Date()): AttentionEvent | undefined {
  const data = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
  if (data && data.type !== 'agent-turn-complete') return undefined;
  const cwd = absolute(data?.cwd) ?? absolute(fallbackCwd);
  if (!cwd) return undefined;
  const id = sessionId(data?.['thread-id']);
  return { provider: 'codex', attention: 'turn-ended', at: now.toISOString(), cwd, ...(id ? { sessionId: id } : {}) };
}

const sameOrInside = (cwd: string, root: string): boolean => {
  const api = process.platform === 'win32' ? path.win32 : path;
  return api.relative(api.resolve(root), api.resolve(cwd)) === '' || isInside(cwd, root);
};
/**
 * Whether a session's cwd is inside Hydra's worktree root: the configured one (the hook's fourth argument, empty
 * when none), or the default sibling `<repository>.worktrees` folder. A lane's worktree is `<root>/lane-<12 hex>`.
 * Any other Claude Code or Codex session on the machine is none of Hydra's, so nothing is recorded for it.
 */
export function inWorktreeRoot(cwd: string, configuredRoot?: string): boolean {
  if (configuredRoot && path.isAbsolute(configuredRoot) && sameOrInside(cwd, configuredRoot)) return true;
  const api = process.platform === 'win32' ? path.win32 : path;
  for (let at = api.resolve(cwd); ; at = api.dirname(at)) {
    const parent = api.dirname(at);
    if (parent === at) return false;
    if (/^lane-[a-f0-9]{12}$/.test(api.basename(at)) && /\.worktrees$/.test(api.basename(parent))) return true;
  }
}

/** The event's lane, when the hook ran in a lane's process (laneService.ts sets HYDRA_LANE_ID there). */
export const withLaneId = (event: AttentionEvent, env: Record<string, string | undefined>): AttentionEvent => isLaneId(env.HYDRA_LANE_ID) ? { ...event, laneId: env.HYDRA_LANE_ID } : event;

/** An event file (untrusted: anything running as the user can write there). Every field is checked again. */
export function parseAttentionEventFile(text: string, now: number): AttentionEvent | undefined {
  if (text.length > maxEventFileBytes) return undefined;
  let data: Record<string, unknown>;
  try { const parsed = JSON.parse(text) as unknown; if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined; data = parsed as Record<string, unknown>; } catch { return undefined; }
  if (data.provider !== 'claude' && data.provider !== 'codex') return undefined;
  if (data.attention !== 'waiting' && data.attention !== 'turn-ended') return undefined;
  const at = typeof data.at === 'string' ? Date.parse(data.at) : NaN;
  if (!Number.isFinite(at) || at < now - maxEventAgeMs || at > now + 60_000) return undefined;
  const cwd = absolute(data.cwd), id = sessionId(data.sessionId), laneId = isLaneId(data.laneId) ? data.laneId : undefined;
  return { provider: data.provider, attention: data.attention, at: new Date(at).toISOString(), ...(cwd ? { cwd } : {}), ...(id ? { sessionId: id } : {}), ...(laneId ? { laneId } : {}) };
}
