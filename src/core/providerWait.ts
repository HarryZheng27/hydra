import type { Provider } from './model';

/**
 * A head waiting on its provider (docs/Heads.md, "Waiting on the provider"): the CLI
 * is retrying a request the provider refused or dropped, or the account is rate-limited,
 * and the head produces nothing until it gets through. Without this, a head that sat
 * for 13 minutes behind its account's limit just looked like a slow Hydra.
 *
 * This is only what the stream shows while the CLI keeps retrying. A turn that ends on a
 * usage limit is a hard limit, handled by limitDetection (claudeHeadLimit, codexHeadLimit)
 * exactly as before; nothing here changes that.
 */
export interface ProviderWait {
  /** When the head went quiet: the stream's last line before the first retry notice (the request that stalled). */
  since: string;
  /** Retry notices seen in this wait. */
  retries: number;
  /** The CLI's own retry attempt and its most, from the latest notice. */
  attempt?: number;
  maxRetries?: number;
  /** The provider said it's a rate or usage limit (a 429, `rate_limit`, a rejected rate-limit event), not some other error. */
  limit?: boolean;
  /** When the limit resets, if the provider said. */
  resetsAt?: string;
  /** What the notice said, shortened: the error, or the limit window and how much of it is used. */
  detail?: string;
  /**
   * No retry notice at all: the stream went silent with a turn open and no tool running (headSilence.ts).
   * Opened by Hydra's watchdog, closed by the next line like any other wait.
   */
  silent?: boolean;
}

/** What one stream line says about waiting on the provider. `undefined`: nothing either way. */
export type ProviderWaitSignal =
  /** A retry notice: the head is waiting (or still waiting). */
  | { kind: 'retry'; attempt?: number; maxRetries?: number; limit: boolean; detail?: string; resetsAt?: string }
  /** The provider refused the account outright (a rejected rate-limit event): waiting, but not a retry. */
  | { kind: 'limited'; detail?: string; resetsAt?: string }
  /** Limit information that doesn't mean waiting on its own; kept as the detail of a wait already open. */
  | { kind: 'note'; detail?: string; resetsAt?: string }
  /** Ordinary output: the provider answered, and any wait is over. */
  | { kind: 'resume' };

const clean = (value: unknown, max = 200): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : undefined;
};
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000 ? value : undefined;
/** Epoch seconds (Claude Code's `resetsAt`) as ISO, or undefined. */
const epochSeconds = (value: unknown): string | undefined => typeof value === 'number' && Number.isFinite(value) && value > 1e9 && value < 1e11 ? new Date(value * 1000).toISOString() : undefined;
const windowName = (value: unknown): string | undefined => {
  const name = clean(value, 40);
  return name ? name.replace(/_/g, '-').replace(/^five-hour$/, '5-hour').replace(/^seven-day$/, '7-day') : undefined;
};

/**
 * One `claude -p --output-format stream-json` line (Claude Code 2.1, from a real head's transcript):
 * - `{ type: "system", subtype: "api_retry", attempt, max_retries, retry_delay_ms, error_status, error }` while it retries
 *   (`error: "rate_limit"` / `error_status: 429` against a limit; `error: "unknown"`, `error_status: null` for a dropped request);
 * - `{ type: "rate_limit_event", rate_limit_info: { status, resetsAt, rateLimitType, utilization, … } }` at each request,
 *   `status` "allowed" or "allowed_warning" normally and "rejected" when the account is limited.
 * Any other line is ordinary output.
 */
export function claudeProviderWaitSignal(line: Record<string, unknown>): ProviderWaitSignal {
  if (line.type === 'system' && line.subtype === 'api_retry') {
    const status = typeof line.error_status === 'number' ? line.error_status : undefined, error = clean(line.error, 80);
    const limit = status === 429 || error === 'rate_limit';
    const detail = [error && error !== 'unknown' ? error.replace(/_/g, ' ') : undefined, status !== undefined ? `HTTP ${status}` : undefined].filter(Boolean).join(', ') || undefined;
    const attempt = count(line.attempt), maxRetries = count(line.max_retries);
    return { kind: 'retry', limit, ...(attempt !== undefined ? { attempt } : {}), ...(maxRetries !== undefined ? { maxRetries } : {}), ...(detail ? { detail } : {}) };
  }
  if (line.type === 'rate_limit_event') {
    const info = (line.rate_limit_info ?? {}) as Record<string, unknown>;
    const resetsAt = epochSeconds(info.resetsAt), name = windowName(info.rateLimitType);
    const used = typeof info.utilization === 'number' && Number.isFinite(info.utilization) ? Math.round(Math.min(Math.max(info.utilization, 0), 1) * 100) : undefined;
    const detail = name || used !== undefined ? `${name ? `${name} limit` : 'limit'}${used !== undefined ? ` ${used}% used` : ''}` : undefined;
    const signal = { ...(detail ? { detail } : {}), ...(resetsAt ? { resetsAt } : {}) };
    return info.status === 'rejected' ? { kind: 'limited', ...signal } : { kind: 'note', ...signal };
  }
  return { kind: 'resume' };
}

const codexRetryText = /reconnecting\W*(\d+)\s*\/\s*(\d+)|\bretrying\b/i;
const codexLimitText = /usage limit|rate limit|too many requests|\b429\b/i;
/**
 * One `codex exec --json` line. Codex reports a stream it's retrying as an error line whose
 * message reads "Reconnecting... 2/5 (…)": either `{ type: "error", message }` or an error
 * item (`{ type: "item.completed", item: { type: "error", message } }`). Other error lines are
 * neither (a final one is codexHeadLimit's); anything else is ordinary output.
 */
export function codexProviderWaitSignal(line: Record<string, unknown>): ProviderWaitSignal | undefined {
  const item = line.item as { type?: unknown; message?: unknown } | undefined;
  const errorItem = typeof line.type === 'string' && line.type.startsWith('item.') && item?.type === 'error';
  if (line.type === 'error' || errorItem) {
    const message = clean(errorItem ? item!.message : line.message, 400);
    const match = message ? codexRetryText.exec(message) : null;
    if (!match) return undefined;
    const attempt = match[1] !== undefined ? count(Number(match[1])) : undefined, maxRetries = match[2] !== undefined ? count(Number(match[2])) : undefined;
    return { kind: 'retry', limit: codexLimitText.test(message!), ...(attempt !== undefined ? { attempt } : {}), ...(maxRetries !== undefined ? { maxRetries } : {}), detail: clean(message) };
  }
  return { kind: 'resume' };
}

/**
 * Follows one head run's stream: opens a wait at the first retry notice (dated from the last
 * line before it), keeps it current, and closes it at the next ordinary line, reporting how long
 * it lasted. `quiet()` marks the start of a turn Hydra sent, so a wait is never dated from the
 * previous turn's end.
 */
export class ProviderWaitTracker {
  private wait: ProviderWait | undefined;
  private lastLineAt: number | undefined;
  constructor(private readonly onChange: (wait: ProviderWait | undefined, waitedMs: number) => void, private readonly now: () => number = Date.now) {}

  get current(): ProviderWait | undefined { return this.wait && { ...this.wait }; }
  quiet(): void { this.lastLineAt = this.now(); }
  observe(signal: ProviderWaitSignal | undefined): void {
    const at = this.now();
    // A silent wait ends at any line; a retry notice turns it into an ordinary wait, dated from the same silence.
    if (this.wait?.silent && (!signal || signal.kind === 'note')) this.close(at);
    else if (this.wait?.silent && signal && (signal.kind === 'retry' || signal.kind === 'limited')) { const { silent: _silent, ...rest } = this.wait; this.wait = rest; }
    if (!signal) { this.lastLineAt = at; return; }
    if (signal.kind === 'resume') { this.close(at); this.lastLineAt = at; return; }
    if (signal.kind === 'note') {
      this.lastLineAt = at;
      if (!this.wait) return;
      const next = { ...this.wait, ...(signal.detail ? { detail: signal.detail } : {}), ...(signal.resetsAt ? { resetsAt: signal.resetsAt } : {}) };
      if (next.detail === this.wait.detail && next.resetsAt === this.wait.resetsAt) return;
      this.wait = next; this.onChange(this.current, 0);
      return;
    }
    const open = this.wait ?? { since: new Date(this.lastLineAt ?? at).toISOString(), retries: 0 };
    this.wait = {
      ...open,
      retries: open.retries + (signal.kind === 'retry' ? 1 : 0),
      ...(signal.kind === 'retry' && signal.attempt !== undefined ? { attempt: signal.attempt } : {}),
      ...(signal.kind === 'retry' && signal.maxRetries !== undefined ? { maxRetries: signal.maxRetries } : {}),
      ...(signal.kind === 'limited' || (signal.kind === 'retry' && signal.limit) || open.limit ? { limit: true } : {}),
      ...(signal.detail ? { detail: signal.detail } : {}),
      ...(signal.resetsAt ? { resetsAt: signal.resetsAt } : {}),
    };
    this.onChange(this.current, 0);
  }
  /**
   * Hydra's watchdog saw the stream go silent (headSilence.ts): open a wait dated from the last line,
   * unless one is already open (a retry wait already says the head is waiting).
   */
  stall(): void {
    if (this.wait) return;
    this.wait = { since: new Date(this.lastLineAt ?? this.now()).toISOString(), retries: 0, silent: true };
    this.onChange(this.current, 0);
  }
  /** The run ended: a wait still open ends with it. */
  end(): void { this.close(this.now()); }
  private close(at: number): void {
    if (!this.wait) return;
    const waitedMs = Math.max(0, at - Date.parse(this.wait.since));
    this.wait = undefined;
    this.onChange(undefined, waitedMs);
  }
}

const providerName = (provider: Provider) => provider === 'codex' ? 'Codex' : 'Claude';
/** A wait's length: "45s", "13m", "1h 05m". */
export function waitDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}
/**
 * What a head's card, the heads list and hydra_get_head say while it waits:
 * "Waiting on your Claude usage limit for 13m (retry 3)", or, for a request the
 * provider dropped, "Waiting on Claude's servers for 2m (retry 3 of 10)".
 */
export function providerWaitLabel(provider: Provider, wait: ProviderWait, now?: number): string {
  const name = providerName(provider);
  const since = Date.parse(wait.since);
  const lasted = now !== undefined && Number.isFinite(since) && now - since >= 1000 ? ` for ${waitDuration(now - since)}` : '';
  if (wait.silent) return `No response from ${name}${lasted}`;
  const what = wait.limit ? `Waiting on your ${name} usage limit` : `Waiting on ${name}'s servers`;
  const attempt = wait.attempt ?? wait.retries;
  const retry = attempt ? ` (retry ${attempt}${!wait.limit && wait.maxRetries ? ` of ${wait.maxRetries}` : ''})` : '';
  return `${what}${lasted}${retry}`;
}
/** The rest of a wait, for a tooltip: its detail and when the limit resets. */
export function providerWaitDetail(wait: ProviderWait): string | undefined {
  const parts = [wait.detail, wait.resetsAt ? `resets ${wait.resetsAt}` : undefined].filter(Boolean);
  return parts.length ? parts.join('; ') : undefined;
}

/** An open wait as hydra_get_head and hydra_list_heads return it (`provider_wait`). */
export function describeProviderWait(provider: Provider, wait: ProviderWait, now: number) {
  const since = Date.parse(wait.since);
  return {
    message: providerWaitLabel(provider, wait, now), since: wait.since, retries: wait.retries,
    ...(wait.attempt !== undefined ? { attempt: wait.attempt } : {}), ...(wait.maxRetries !== undefined ? { max_retries: wait.maxRetries } : {}),
    limit: !!wait.limit, ...(wait.silent ? { silent: true } : {}), ...(wait.resetsAt ? { resets_at: wait.resetsAt } : {}), ...(wait.detail ? { detail: wait.detail } : {}),
    ...(Number.isFinite(since) ? { waited_ms: Math.max(0, now - since) } : {}),
  };
}

/** A stored wait, shape-checked on load (an invalid one is dropped). */
export function validateProviderWait(value: unknown): ProviderWait | undefined {
  const wait = value as Partial<ProviderWait> | undefined;
  if (!wait || typeof wait !== 'object' || typeof wait.since !== 'string' || !Number.isFinite(Date.parse(wait.since)) || count(wait.retries) === undefined) return undefined;
  return {
    since: wait.since, retries: wait.retries!,
    ...(count(wait.attempt) !== undefined ? { attempt: wait.attempt } : {}),
    ...(count(wait.maxRetries) !== undefined ? { maxRetries: wait.maxRetries } : {}),
    ...(wait.limit === true ? { limit: true } : {}),
    ...(wait.silent === true ? { silent: true } : {}),
    ...(typeof wait.resetsAt === 'string' && Number.isFinite(Date.parse(wait.resetsAt)) ? { resetsAt: wait.resetsAt } : {}),
    ...(clean(wait.detail) ? { detail: clean(wait.detail) } : {}),
  };
}
