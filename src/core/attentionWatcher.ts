import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { parseAttentionEventFile, type AttentionEvent } from './attentionEvents';
import { maxEventAgeMs, maxEventFileBytes } from './limitDetection';

/**
 * Picks up the attention event files the Stop and Notification hooks (and Codex's notifier) drop for Hydra's lanes
 * (attentionEvents.ts). Each lane belongs to one window, so only the window that owns the event's lane takes it
 * (`laneOf` says which lane that is, or undefined): it claims the file by renaming it away, which only one caller can do.
 * Stale, oversized or malformed files are deleted unread or unused, and an event nobody here owns is left for its own
 * window until it goes stale.
 */
export interface AttentionWatcherOptions {
  directory: string;
  /** The open lane (in this window) the event is about, from its laneId or its cwd; undefined when it isn't one of this window's. */
  laneOf: (event: AttentionEvent) => string | undefined;
  now?: () => number;
  scanMs?: number;
}
const eventName = /^(\d{13})-[0-9a-f]{16}\.json$/;

export class AttentionWatcher {
  private readonly listeners = new Set<(laneId: string, event: AttentionEvent) => void>();
  private readonly now: () => number;
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setInterval>;
  private scanning?: Promise<void>;
  private again = false;
  private disposed = false;
  constructor(private readonly options: AttentionWatcherOptions) { this.now = options.now || Date.now; }

  onAttention(listener: (laneId: string, event: AttentionEvent) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }
  async start(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true });
    try { this.watcher = watch(this.options.directory, () => { void this.scan(); }); this.watcher.on('error', () => undefined); } catch { /* the periodic scan still runs */ }
    this.timer = setInterval(() => { void this.scan(); }, this.options.scanMs ?? 15_000);
    this.timer.unref?.();
    await this.scan();
  }
  dispose(): void { this.disposed = true; this.watcher?.close(); clearInterval(this.timer); this.listeners.clear(); }
  /** One pass over the folder. Calls during a pass run one more pass after it. */
  scan(): Promise<void> {
    if (this.scanning) { this.again = true; return this.scanning; }
    this.scanning = (async () => {
      try { do { this.again = false; await this.pass(); } while (this.again && !this.disposed); }
      finally { this.scanning = undefined; }
    })();
    return this.scanning;
  }
  private async pass(): Promise<void> {
    const directory = this.options.directory, now = this.now();
    let names: string[];
    try { names = await readdir(directory); } catch { return; }
    // Oldest first, so a later event for a lane wins.
    for (const name of names.sort()) {
      if (this.disposed) return;
      const file = path.join(directory, name), match = eventName.exec(name);
      if (!match) {
        if (/\.(tmp|claimed-[0-9a-f]+)$/.test(name)) { const info = await stat(file).catch(() => undefined); if (info && now - info.mtimeMs > 60_000) await discard(file); }
        continue;
      }
      if (now - Number(match[1]) > maxEventAgeMs) { await discard(file); continue; }
      const info = await stat(file).catch(() => undefined);
      if (!info) continue;
      if (info.size > maxEventFileBytes) { await discard(file); continue; }
      const text = await readFile(file, 'utf8').catch(() => undefined);
      if (text === undefined) continue;
      const event = parseAttentionEventFile(text, now);
      if (!event) { await discard(file); continue; }
      let laneId: string | undefined;
      try { laneId = this.options.laneOf(event); } catch { laneId = undefined; }
      if (!laneId) continue;
      if (!await claim(file)) continue;
      for (const listener of [...this.listeners]) { try { listener(laneId, event); } catch { /* a listener's problem stays its own */ } }
    }
  }
}
/** Exactly one caller gets true: a rename of one file succeeds once. */
async function claim(file: string): Promise<boolean> {
  const claimed = `${file}.claimed-${randomBytes(6).toString('hex')}`;
  try { await rename(file, claimed); } catch { return false; }
  await discard(claimed);
  return true;
}
const discard = (file: string) => rm(file, { force: true }).catch(() => undefined);
