import { mkdir, appendFile, rename, rm, stat, chmod } from 'node:fs/promises';
import path from 'node:path';
import { redactText } from './redact';

/**
 * 5.2: one audit log per window, appended to
 * `<globalStorage>/audit/audit.jsonl`. It records the things that let you
 * later answer "what did a head try, and what did I approve": every
 * endpoint refusal, a refused lead connection, a head's hydra_done refused
 * for changed git settings or hooks, a failed sandbox self-test, a pack
 * server refused by 5.4 (denials); Merge/Mark done with these changes,
 * Merge anyway, turning on a pack (approvals); a head cancelled, Stop all,
 * Resume (stops); a window closed by `hydra close` (close); a head's question Hydra answered itself because nobody did (auto).
 */
export interface AuditEvent {
  /** `auto`: Hydra decided something on its own that a person would otherwise have, such as answering a head's question nobody answered. */
  kind: 'denial' | 'approval' | 'stop' | 'resume' | 'auto' | 'close';
  what: string;
  detail?: string;
  role?: string;
  jobId?: string;
  laneId?: string;
  pack?: string;
}

export interface AuditLogOptions {
  /** `<globalStorage>/audit/audit.jsonl`. */
  file: string;
  /** Rotated at this size (default 2 MB): the file is renamed to its ".1" sibling and a fresh one started. */
  maxBytes?: number;
  now?: () => Date;
  /** Defaults to redactText: every string field is masked before it reaches disk. */
  redact?: (text: string) => string;
}

const defaultMaxBytes = 2 * 1024 * 1024;

/**
 * Appends one redacted JSON line per event. `record` never throws to the caller: writes are
 * serialized through a promise queue (so lines never interleave), and a failed write is logged
 * nowhere else but doesn't break whatever called it. `flush` is for tests, to wait for the queue.
 */
export class AuditLog {
  private readonly file: string;
  private readonly maxBytes: number;
  private readonly now: () => Date;
  private readonly redact: (text: string) => string;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: AuditLogOptions) {
    this.file = options.file;
    this.maxBytes = options.maxBytes ?? defaultMaxBytes;
    this.now = options.now ?? (() => new Date());
    this.redact = options.redact ?? redactText;
  }

  /** Fire-and-forget: queues the write and returns at once. */
  record(event: AuditEvent): void {
    this.queue = this.queue.then(() => this.append(event)).catch(() => { /* a broken audit log never breaks its caller */ });
  }

  /** Waits for every queued write so far. Tests only. */
  async flush(): Promise<void> {
    await this.queue;
  }

  private async append(event: AuditEvent): Promise<void> {
    const record: Record<string, unknown> = { at: this.now().toISOString(), ...event };
    for (const key of Object.keys(record)) {
      const value = record[key];
      if (typeof value === 'string') record[key] = this.redact(value);
    }
    const line = `${JSON.stringify(record)}\n`;
    await mkdir(path.dirname(this.file), { recursive: true });
    const size = await stat(this.file).then(info => info.size, () => 0);
    if (size + Buffer.byteLength(line) > this.maxBytes) await this.rotate();
    await appendFile(this.file, line, { mode: 0o600 });
    await chmod(this.file, 0o600).catch(() => { /* best effort: some filesystems (FAT, some CI runners) ignore chmod */ });
  }

  /** audit.jsonl -> audit.1.jsonl, replacing any older one. One previous file is kept. */
  private async rotate(): Promise<void> {
    const previous = rotatedPath(this.file);
    await rm(previous, { force: true });
    await rename(this.file, previous).catch(() => { /* nothing to rotate yet */ });
  }
}

function rotatedPath(file: string): string {
  const ext = path.extname(file);
  const base = ext ? file.slice(0, -ext.length) : file;
  return `${base}.1${ext}`;
}

/**
 * The audit event for an override picked at a lane's git-settings or gates prompt (Merge with
 * these changes / Mark done with these changes / Merge anyway / Mark done anyway). Factored out
 * as a pure function because the dialogs themselves (src/host/lanes.ts) need a host to test.
 */
export function laneOverrideEvent(what: string, laneId: string, detail?: string): AuditEvent {
  return { kind: 'approval', what, laneId, ...(detail ? { detail } : {}) };
}
