import type { Provider } from './model';

/**
 * A head whose stream goes silent (docs/Heads.md, "A silent head"). A head's CLI can stop producing
 * anything with a turn still open and no tool running: a response stream the provider stopped
 * sending, with no retry notice for providerWait.ts to see. One benchmark head sat like that for 25
 * minutes before its CLI gave up on the stream by itself. Hydra's watchdog reads each run's activity:
 *
 * - after `waitMs` of silence it records a wait on the provider ("No response from Claude for 3m"),
 *   through the same providerWait machinery, so it shows on the card and in the report;
 * - after `nudgeMs` it nudges the head once (HelperRun.nudge: Claude's turn is interrupted and a
 *   "continue" message sent; Codex's stalled exec is stopped and its thread resumed);
 * - after `failMs` it fails the attempt, so the plan isn't held up by it: the job then needs the lead's
 *   attention (a plan's `needs_attention`), and nothing retries it on its own.
 *
 * Silence is measured from the last **model output**, not the last line: the lines a nudge itself
 * produces (Claude's `control_response` and the interrupted turn's `result`, Codex's `thread.started`
 * and `turn.started`) never count, so a nudge can't restart the count, and a head that stays hung
 * after its one nudge is failed rather than interrupted again every few minutes.
 *
 * A tool call in flight (a long `npm test`, or a head's own hydra_stuck/hydra_done) is never silence,
 * and neither is the gap after a turn ended (the head is then waiting for a message, which
 * HelperService.turnEnded handles).
 */
export interface HeadSilenceLimits { waitMs: number; nudgeMs: number; failMs: number }
/**
 * Claude heads run with `--include-partial-messages`, so a response being written streams a line per
 * chunk: minutes with none really are silence.
 */
export const claudeSilenceLimits: HeadSilenceLimits = { waitMs: 3 * 60_000, nudgeMs: 5 * 60_000, failMs: 10 * 60_000 };
/**
 * `codex exec --json` has no partial output: a long message or a large file change arrives only when
 * it's complete, and a nudge stops the exec (discarding it). So Codex waits longer before either.
 */
export const codexSilenceLimits: HeadSilenceLimits = { waitMs: 3 * 60_000, nudgeMs: 10 * 60_000, failMs: 15 * 60_000 };
export const headSilenceLimits = (provider: Provider): HeadSilenceLimits => provider === 'codex' ? codexSilenceLimits : claudeSilenceLimits;

/** What the watchdog needs from a run's stream (HelperRun.activity). */
export interface HeadActivity {
  /** When the model last produced something (or the turn Hydra sent started, if it hasn't yet). */
  lastOutputAt: number;
  /** Tool calls started and not yet answered. */
  toolsInFlight: number;
  /** A turn is under way: Hydra sent a message and the CLI hasn't ended the turn. */
  turnOpen: boolean;
}

type Line = Record<string, unknown>;
const blocks = (line: Line): Record<string, unknown>[] => {
  const content = (line.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? content.filter((block): block is Record<string, unknown> => !!block && typeof block === 'object') : [];
};
/** Codex items that are work in progress between item.started and item.completed; its own messages and reasoning aren't. */
const codexTextItems = new Set(['agent_message', 'reasoning']);

/** Follows one run's stream for HeadActivity. `now` is injectable for tests. */
export class StreamActivity {
  private lastOutputAt: number;
  private readonly tools = new Set<string>();
  private open = false;
  constructor(private readonly now: () => number = Date.now) { this.lastOutputAt = now(); }

  /** Hydra sent a message that starts a turn. `fresh: false` (a nudge) keeps the silence it answers. */
  turnStarted(fresh = true): void { this.open = true; if (fresh) this.lastOutputAt = this.now(); }
  /** The turn ended (a Claude `result`, a Codex exec that exited): nothing is in flight any more. */
  turnEnded(): void { this.open = false; this.tools.clear(); }

  /**
   * One `claude -p --output-format stream-json` line. True when it's model output: an assistant message,
   * a partial-message chunk (`stream_event`), a tool's result, or a retry notice (the CLI is working on
   * it; providerWait.ts shows that wait). A `result`, `control_response`, `system` init or rate-limit note isn't.
   */
  observeClaude(line: Line): boolean {
    const output = line.type === 'assistant' || line.type === 'user' || line.type === 'stream_event' || (line.type === 'system' && line.subtype === 'api_retry');
    if (output) this.lastOutputAt = this.now();
    if (line.type === 'assistant') for (const block of blocks(line)) { if (block.type === 'tool_use' && typeof block.id === 'string') this.tools.add(block.id); }
    else if (line.type === 'user') for (const block of blocks(line)) { if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') this.tools.delete(block.tool_use_id); }
    else if (line.type === 'result') this.turnEnded();
    return output;
  }
  /**
   * One `codex exec --json` line. True when it's model output: any item event, or an error line (a
   * retry notice). `thread.started`, `turn.started` and `turn.completed` aren't.
   */
  observeCodex(line: Line): boolean {
    const output = (typeof line.type === 'string' && line.type.startsWith('item.')) || line.type === 'error';
    if (output) this.lastOutputAt = this.now();
    const item = line.item as { id?: unknown; type?: unknown } | undefined;
    if (!item || typeof item.id !== 'string') return output;
    if (line.type === 'item.started' && !codexTextItems.has(String(item.type))) this.tools.add(item.id);
    else if (line.type === 'item.completed') this.tools.delete(item.id);
    return output;
  }
  snapshot(): HeadActivity { return { lastOutputAt: this.lastOutputAt, toolsInFlight: this.tools.size, turnOpen: this.open }; }
}

/** How long a run has been silent, or undefined when it isn't (no turn open, or a tool running). */
export function headSilentMs(activity: HeadActivity | undefined, now: number): number | undefined {
  if (!activity || !activity.turnOpen || activity.toolsInFlight > 0) return undefined;
  return Math.max(0, now - activity.lastOutputAt);
}

export type HeadSilenceStep = 'record' | 'nudge' | 'fail';
/** The watchdog's next step for one silence, given what it already did about it. Pure. */
export function headSilenceStep(silentMs: number | undefined, done: { recorded: boolean; nudged: boolean }, limits: HeadSilenceLimits = claudeSilenceLimits): HeadSilenceStep | undefined {
  if (silentMs === undefined) return undefined;
  if (silentMs >= limits.failMs) return 'fail';
  if (silentMs >= limits.nudgeMs && !done.nudged) return 'nudge';
  if (silentMs >= limits.waitMs && !done.recorded) return 'record';
  return undefined;
}

/** What a silent head is told when it's nudged. */
export const headSilenceNudge = 'Hydra has seen no output from you for several minutes, so your last response may have been cut off. Continue where you left off: finish your work and call hydra_done with a summary (or hydra_stuck with one clear question).';

/**
 * A Claude head's nudge (HelperRun.nudge): an `interrupt` control request, then the "continue" message
 * once the interrupted turn has ended, so that turn's `result` is known to be the interrupt's and is
 * never mistaken for the head stopping; a later, real turn end is never swallowed. If the CLI answers
 * the interrupt with an error (nothing to interrupt), the message goes at once.
 */
export class ClaudeNudge {
  private pending: { id: string; text: string } | undefined;
  constructor(private readonly deliver: (text: string) => void) {}
  get waiting(): boolean { return !!this.pending; }
  /** The interrupt `request_id` was just sent, carrying `text` for after it. */
  started(id: string, text: string): void { this.pending = { id, text }; }
  /** The interrupt couldn't be sent: forget it, sending nothing. */
  cancel(): void { this.pending = undefined; }
  /** A `control_response` line. */
  controlResponse(line: Record<string, unknown>): void {
    const response = line.response as { subtype?: unknown; request_id?: unknown } | undefined;
    if (this.pending && response?.request_id === this.pending.id && response.subtype === 'error') this.send();
  }
  /** A `result` line: true when it ended the interrupted turn (not a turn end to report); the message is then sent. */
  result(): boolean {
    if (!this.pending) return false;
    this.send();
    return true;
  }
  private send(): void { const text = this.pending!.text; this.pending = undefined; this.deliver(text); }
}
