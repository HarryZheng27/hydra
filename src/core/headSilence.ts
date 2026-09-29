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
 * - after `failMs` it fails the attempt, so the plan goes on (or a retry starts) instead of hanging.
 *
 * A tool call in flight (a long `npm test`, or a head's own hydra_stuck/hydra_done) is never silence,
 * and neither is the gap after a turn ended (the head is then waiting for a message, which
 * HelperService.turnEnded handles).
 */
export interface HeadSilenceLimits { waitMs: number; nudgeMs: number; failMs: number }
export const headSilenceLimits: HeadSilenceLimits = { waitMs: 3 * 60_000, nudgeMs: 5 * 60_000, failMs: 10 * 60_000 };

/** What the watchdog needs from a run's stream (HelperRun.activity). */
export interface HeadActivity {
  /** When the stream's last line arrived (or the turn started, if nothing has arrived since). */
  lastLineAt: number;
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
  private lastLineAt: number;
  private readonly tools = new Set<string>();
  private open = false;
  constructor(private readonly now: () => number = Date.now) { this.lastLineAt = now(); }

  /** Hydra sent a message that starts a turn. `fresh: false` (a nudge) keeps the silence it answers. */
  turnStarted(fresh = true): void { this.open = true; if (fresh) this.lastLineAt = this.now(); }
  /** The turn ended (a Claude `result`, a Codex exec that exited): nothing is in flight any more. */
  turnEnded(): void { this.open = false; this.tools.clear(); }

  /** One `claude -p --output-format stream-json` line. */
  observeClaude(line: Line): void {
    this.lastLineAt = this.now();
    if (line.type === 'assistant') for (const block of blocks(line)) { if (block.type === 'tool_use' && typeof block.id === 'string') this.tools.add(block.id); }
    else if (line.type === 'user') for (const block of blocks(line)) { if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') this.tools.delete(block.tool_use_id); }
    else if (line.type === 'result') this.turnEnded();
  }
  /** One `codex exec --json` line. */
  observeCodex(line: Line): void {
    this.lastLineAt = this.now();
    const item = line.item as { id?: unknown; type?: unknown } | undefined;
    if (!item || typeof item.id !== 'string') return;
    if (line.type === 'item.started' && !codexTextItems.has(String(item.type))) this.tools.add(item.id);
    else if (line.type === 'item.completed') this.tools.delete(item.id);
  }
  snapshot(): HeadActivity { return { lastLineAt: this.lastLineAt, toolsInFlight: this.tools.size, turnOpen: this.open }; }
}

/** How long a run has been silent, or undefined when it isn't (no turn open, or a tool running). */
export function headSilentMs(activity: HeadActivity | undefined, now: number): number | undefined {
  if (!activity || !activity.turnOpen || activity.toolsInFlight > 0) return undefined;
  return Math.max(0, now - activity.lastLineAt);
}

export type HeadSilenceStep = 'record' | 'nudge' | 'fail';
/** The watchdog's next step for one silence, given what it already did about it. Pure. */
export function headSilenceStep(silentMs: number | undefined, done: { recorded: boolean; nudged: boolean }, limits: HeadSilenceLimits = headSilenceLimits): HeadSilenceStep | undefined {
  if (silentMs === undefined) return undefined;
  if (silentMs >= limits.failMs) return 'fail';
  if (silentMs >= limits.nudgeMs && !done.nudged) return 'nudge';
  if (silentMs >= limits.waitMs && !done.recorded) return 'record';
  return undefined;
}

/** What a silent head is told when it's nudged. */
export const headSilenceNudge = 'Hydra has seen no output from you for several minutes, so your last response may have been cut off. Continue where you left off: finish your work and call hydra_done with a summary (or hydra_stuck with one clear question).';
