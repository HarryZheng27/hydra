import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { replaceAtomic } from './atomicFile';
import { livePlans, planProgressLine } from './hydraTree';
import type { HelperJobView, LaneView, Provider } from './model';
import type { EvidenceStatus } from './jobs';
import type { Plan } from './plans';
import type { PlanJobView } from './planRunner';

/**
 * Step D: a small, read-only summary each window
 * publishes beside its discovery record (`helperDiscovery.ts`), so "Hydra: Show All
 * Projects" can list every open project without any window reaching into another's
 * jobs. Pure build/read/write, like helperDiscovery.ts; the extension owns the
 * timing (on change, debounced, plus a heartbeat) and the fs watching.
 */
export interface ProjectSummary {
  version: 1;
  pid: number;
  folder: string;
  /** Shown only in this window's own UI, never sent anywhere: the folder's basename. */
  name: string;
  updatedAt: string;
  heads: { running: number; blocked: number; done: number };
  lanes: { running: number; exited: number };
  plans: { live: number; lines: string[] };
  /** Blocked heads and why, newest first, capped so a busy window can't blow up the file. */
  blocked: { title: string; reason: string }[];
  evidence: Record<EvidenceStatus, number>;
  providers: Provider[];
  /** Set by the window's own clean close, so the view says "Closed" rather than dropping the project. */
  closedAt?: string;
}

export const maxBlockedInSummary = 10;
/** A summary older than this reads as "not responding", even if its pid is still alive. */
export const summaryStaleAfterMs = 3 * 60 * 1000;
/** A closed window's summary is pruned after a day, so the list doesn't keep every project ever opened. */
export const closedSummaryKeptMs = 24 * 60 * 60 * 1000;

const runningHeadStates = new Set(['queued', 'starting', 'running', 'checking']);
const emptyEvidence = (): Record<EvidenceStatus, number> => ({ passed: 0, partial: 0, none: 0, 'none-chosen': 0, override: 0 });
const providerOrder: readonly Provider[] = ['claude', 'codex'];

export interface ProjectSummaryInputs {
  pid: number;
  folder: string;
  heads: readonly HelperJobView[];
  lanes: readonly LaneView[];
  plans: readonly Plan[];
  planJobs?: Readonly<Record<string, readonly PlanJobView[]>>;
  providers: readonly Provider[];
}

/** Pure: the same counts and labels the tree and lane tiles already show (Step A), gathered into one file. */
export function buildProjectSummary(inputs: ProjectSummaryInputs, now: Date = new Date()): ProjectSummary {
  const { heads, lanes, plans, planJobs = {}, folder, pid } = inputs;
  const evidence = emptyEvidence();
  for (const head of heads) if (head.status) evidence[head.status]++;
  for (const lane of lanes) if (lane.lastGates?.status) evidence[lane.lastGates.status]++;
  const blocked = heads
    .filter(head => head.state === 'blocked')
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, maxBlockedInSummary)
    .map(head => ({ title: head.title, reason: head.question || 'Needs an answer' }));
  const live = livePlans(plans);
  return {
    version: 1,
    pid,
    folder,
    name: path.basename(folder) || folder,
    updatedAt: now.toISOString(),
    heads: {
      running: heads.filter(head => runningHeadStates.has(head.state)).length,
      blocked: heads.filter(head => head.state === 'blocked').length,
      done: heads.filter(head => head.state === 'done').length,
    },
    lanes: {
      running: lanes.filter(lane => lane.state === 'running').length,
      exited: lanes.filter(lane => lane.state === 'exited').length,
    },
    plans: { live: live.length, lines: live.map(plan => planProgressLine(plan, planJobs[plan.id])) },
    blocked,
    evidence,
    providers: providerOrder.filter(provider => inputs.providers.includes(provider)),
  };
}

const summaryFile = (dir: string, id: string) => path.join(dir, `${id}.summary.json`);

/** Atomic write beside the window record, `0o600` like `writeWindowRecord`. `id` must be this window's own (the window record's file name, without `.json`). */
export async function writeProjectSummary(dir: string, id: string, summary: ProjectSummary): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = summaryFile(dir, id);
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(summary), { encoding: 'utf8', mode: 0o600 });
  await replaceAtomic(temporary, file);
}

export async function removeProjectSummary(dir: string, id: string): Promise<void> {
  await rm(summaryFile(dir, id), { force: true });
}

export type ProjectLiveness = 'running' | 'not-responding' | 'closed';
export type ProjectSummaryView = ProjectSummary & { liveness: ProjectLiveness };

/**
 * Every summary in `dir`, each labelled by liveness: `closed` when its pid is gone (or the
 * record can't be read at all), `not-responding` when its heartbeat is stale, `running`
 * otherwise. `isAlive` is injected (real check: `helperDiscovery.ts`'s, `process.kill(pid, 0)`)
 * so tests can fake a dead pid without touching a real process.
 */
export async function readProjectSummaries(dir: string, now: Date, isAlive: (pid: number) => boolean): Promise<ProjectSummaryView[]> {
  let names: string[];
  try { names = (await readdir(dir)).filter(name => name.endsWith('.summary.json')); } catch { return []; }
  const out: ProjectSummaryView[] = [];
  for (const name of names) {
    let summary: ProjectSummary;
    try { summary = JSON.parse(await readFile(path.join(dir, name), 'utf8')); } catch { continue; }
    if (summary?.version !== 1 || typeof summary.pid !== 'number' || typeof summary.folder !== 'string') continue;
    const closed = !!summary.closedAt || !isAlive(summary.pid);
    const age = now.getTime() - new Date(summary.closedAt ?? summary.updatedAt).getTime();
    // A window gone for over a day: its file is pruned, the same way findWindowFor prunes dead window records.
    if (closed && age > closedSummaryKeptMs) { await rm(path.join(dir, name), { force: true }).catch(() => undefined); continue; }
    out.push({ ...summary, liveness: closed ? 'closed' : age > summaryStaleAfterMs ? 'not-responding' : 'running' });
  }
  return out;
}

/** Millisecond clock and timers, injected so the publisher's debounce and heartbeat are testable without waiting on real time. */
export interface ProjectSummaryClock {
  now(): Date;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}
export const realProjectSummaryClock: ProjectSummaryClock = {
  now: () => new Date(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface ProjectSummaryPublisher {
  /** Call after any head, lane or plan change. Writes at once if a second has passed since the last write, else once, trailing, when it has. */
  changed(): void;
  /**
   * Stops the heartbeat. `closed` (the window is closing) leaves a final summary marked closed, so
   * other windows show it as closed; `remove` (the default: this id is being replaced) deletes the file.
   */
  dispose(mode?: 'closed' | 'remove'): Promise<void>;
}
export interface ProjectSummaryPublisherOptions {
  dir: string;
  /** This window's own id — the window record's file name, without `.json`. Nothing here ever takes another window's id. */
  id: string;
  pid: number;
  /** Recomputed on every write, so it always reflects the latest heads/lanes/plans. */
  build: () => Omit<ProjectSummary, 'version' | 'pid' | 'updatedAt'>;
  clock?: ProjectSummaryClock;
  onError?: (error: unknown) => void;
}
const debounceMs = 1000;
const heartbeatMs = 60_000;

/** Starts the heartbeat and writes an initial summary; `changed()` debounces the rest (Step D: "at most once a second, with a heartbeat every 60 seconds"). */
export function startProjectSummaryPublisher(options: ProjectSummaryPublisherOptions): ProjectSummaryPublisher {
  const { dir, id, pid, build, clock = realProjectSummaryClock, onError = () => undefined } = options;
  let lastWriteAt = -Infinity;
  let trailing: unknown;
  let disposed = false;
  // One write at a time, in order: two overlapping writes could otherwise land out of order and leave an older
  // summary on disk until the next heartbeat.
  let writing: Promise<void> = Promise.resolve();

  const write = (): Promise<void> => {
    lastWriteAt = clock.now().getTime();
    const summary: ProjectSummary = { version: 1, pid, updatedAt: new Date(lastWriteAt).toISOString(), ...build() };
    writing = writing.then(() => writeProjectSummary(dir, id, summary)).catch(error => onError(error));
    return writing;
  };

  const changed = (): void => {
    if (disposed) return;
    const elapsed = clock.now().getTime() - lastWriteAt;
    if (elapsed >= debounceMs) { void write(); return; }
    if (trailing !== undefined) return;
    trailing = clock.setTimeout(() => { trailing = undefined; void write(); }, debounceMs - elapsed);
  };

  const heartbeat = clock.setInterval(() => void write(), heartbeatMs);
  void write();

  return {
    changed,
    dispose: async (mode = 'remove') => {
      if (disposed) return;
      disposed = true;
      if (trailing !== undefined) clock.clearTimeout(trailing);
      clock.clearInterval(heartbeat);
      await writing;
      if (mode === 'remove') { await removeProjectSummary(dir, id).catch(() => undefined); return; }
      const at = clock.now().toISOString();
      await writeProjectSummary(dir, id, { version: 1, pid, updatedAt: at, closedAt: at, ...build() }).catch(error => onError(error));
    },
  };
}
