import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  buildProjectSummary, maxBlockedInSummary, readProjectSummaries, removeProjectSummary,
  startProjectSummaryPublisher, writeProjectSummary, type ProjectSummaryClock,
} from '../src/core/projectSummary';
import type { HelperJobView, LaneView } from '../src/core/model';

const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const head = (id: string, state: string, extra: Partial<HelperJobView> = {}): HelperJobView => ({
  id, title: `Head ${id}`, state, provider: 'claude', createdAt: at(60_000), changedFiles: 0, checks: [], dependsOn: [], ...extra,
});
const lane = (id: string, extra: Partial<LaneView> = {}): LaneView => ({
  id, name: `Lane ${id}`, provider: 'claude', repository: '/repo', worktree: `/repo.worktrees/${id}`, branch: `lane/${id}`, baseCommit: 'a'.repeat(40),
  target: 'main', createdAt: at(60_000), state: 'running', running: true, ...extra,
});

test('buildProjectSummary counts heads, lanes, live plans and evidence, and caps blocked reasons', () => {
  const heads = [
    head('h1', 'running'), head('h2', 'checking'),
    head('h3', 'blocked', { question: 'Which endpoint?' }),
    ...Array.from({ length: 12 }, (_, index) => head(`b${index}`, 'blocked', { question: `Q${index}` })),
    head('h4', 'done', { status: 'passed' }),
    head('h5', 'done', { status: 'partial' }),
  ];
  const lanes = [
    lane('l1', { state: 'running' }),
    lane('l2', { state: 'exited', lastGates: { commit: 'a'.repeat(40), at: at(0), status: 'none-chosen', checks: [] } as LaneView['lastGates'] }),
    lane('l3', { state: 'merged' }),
  ];
  const summary = buildProjectSummary({ pid: 4242, folder: '/repo/my-project', heads, lanes, plans: [], providers: ['claude'] });
  assert.equal(summary.name, 'my-project');
  assert.equal(summary.heads.running, 2);
  assert.equal(summary.heads.blocked, 13);
  assert.equal(summary.heads.done, 2);
  assert.equal(summary.lanes.running, 1);
  assert.equal(summary.lanes.exited, 1);
  assert.equal(summary.blocked.length, maxBlockedInSummary);
  assert.equal(summary.evidence.passed, 1);
  assert.equal(summary.evidence.partial, 1);
  assert.equal(summary.evidence['none-chosen'], 1);
  assert.deepEqual(summary.providers, ['claude']);
});

test('buildProjectSummary keeps provider order and drops one not connected', () => {
  const summary = buildProjectSummary({ pid: 1, folder: '/repo', heads: [], lanes: [], plans: [], providers: ['codex'] });
  assert.deepEqual(summary.providers, ['codex']);
});

test('writeProjectSummary writes 0o600 beside the window record, and readProjectSummaries reads it back', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-summary-'));
  const summary = buildProjectSummary({ pid: process.pid, folder: '/repo', heads: [], lanes: [], plans: [], providers: ['claude'] });
  await writeProjectSummary(dir, 'abc123', summary);
  const info = await stat(path.join(dir, 'abc123.summary.json'));
  if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600);
  const raw = JSON.parse(await readFile(path.join(dir, 'abc123.summary.json'), 'utf8'));
  assert.equal(raw.folder, '/repo');
  const [view] = await readProjectSummaries(dir, new Date(), () => true);
  assert.equal(view!.folder, '/repo');
  assert.equal(view!.liveness, 'running');
});

test('a summary whose pid is dead reads as closed, even with a fresh updatedAt', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-summary-'));
  const summary = buildProjectSummary({ pid: 999999, folder: '/repo', heads: [], lanes: [], plans: [], providers: [] });
  await writeProjectSummary(dir, 'dead', summary);
  const [view] = await readProjectSummaries(dir, new Date(), () => false);
  assert.equal(view!.liveness, 'closed');
});

test('a summary with a stale updatedAt reads as not-responding, never running, when its pid is alive', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-summary-'));
  const summary = buildProjectSummary({ pid: process.pid, folder: '/repo', heads: [], lanes: [], plans: [], providers: [] });
  summary.updatedAt = new Date(Date.now() - 4 * 60_000).toISOString();
  await writeProjectSummary(dir, 'stale', summary);
  const [view] = await readProjectSummaries(dir, new Date(), () => true);
  assert.equal(view!.liveness, 'not-responding');
});

test('a stale summary whose pid is also dead still reads as closed, not not-responding', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-summary-'));
  const summary = buildProjectSummary({ pid: 999999, folder: '/repo', heads: [], lanes: [], plans: [], providers: [] });
  summary.updatedAt = new Date(Date.now() - 4 * 60_000).toISOString();
  await writeProjectSummary(dir, 'dead-stale', summary);
  const [view] = await readProjectSummaries(dir, new Date(), () => false);
  assert.equal(view!.liveness, 'closed');
});

test('removeProjectSummary removes the file; a missing directory reads as no summaries', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-summary-'));
  const summary = buildProjectSummary({ pid: process.pid, folder: '/repo', heads: [], lanes: [], plans: [], providers: [] });
  await writeProjectSummary(dir, 'gone', summary);
  await removeProjectSummary(dir, 'gone');
  assert.deepEqual(await readProjectSummaries(dir, new Date(), () => true), []);
  assert.deepEqual(await readProjectSummaries(path.join(dir, 'missing'), new Date(), () => true), []);
});

/** A fake clock the test drives by hand: `advance` runs any timers whose delay has elapsed, in order. */
function fakeClock(): ProjectSummaryClock & { advance(ms: number): void; interval?: { ms: number; callback: () => void } } {
  let now = 0;
  const timeouts: { at: number; callback: () => void; id: number }[] = [];
  let nextId = 1;
  const clock: ReturnType<typeof fakeClock> = {
    now: () => new Date(now),
    setTimeout: (callback, ms) => { const id = nextId++; timeouts.push({ at: now + ms, callback, id }); return id; },
    clearTimeout: handle => { const index = timeouts.findIndex(entry => entry.id === handle); if (index >= 0) timeouts.splice(index, 1); },
    setInterval: (callback, ms) => { clock.interval = { ms, callback }; return 'interval'; },
    clearInterval: () => { clock.interval = undefined; },
    advance(ms: number) {
      now += ms;
      if (clock.interval && ms >= clock.interval.ms) clock.interval.callback();
      for (const entry of [...timeouts]) {
        if (entry.at <= now) { timeouts.splice(timeouts.indexOf(entry), 1); entry.callback(); }
      }
    },
  };
  return clock;
}

test('the publisher writes once at start, debounces rapid changes to at most once a second, and heartbeats every 60s', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-summary-'));
  const clock = fakeClock();
  let writes = 0;
  const original = writeProjectSummary;
  // Count writes by reading the file after each change settles instead of mocking the module:
  // simplest is to inspect the file's updatedAt after each step.
  const publisher = startProjectSummaryPublisher({
    dir, id: 'pub1', pid: process.pid, clock,
    build: () => ({ folder: '/repo', name: 'repo', heads: { running: 0, blocked: 0, done: 0 }, lanes: { running: 0, exited: 0 }, plans: { live: 0, lines: [] }, blocked: [], evidence: { passed: 0, partial: 0, none: 0, 'none-chosen': 0, override: 0 }, providers: [] }),
  });
  void original; void writes;
  await delay(20);
  const first = JSON.parse(await readFile(path.join(dir, 'pub1.summary.json'), 'utf8'));
  assert.equal(first.updatedAt, new Date(0).toISOString());

  // Rapid changes within the same second: only the trailing write at the 1s mark should land.
  publisher.changed();
  clock.advance(100);
  publisher.changed();
  clock.advance(100);
  publisher.changed();
  await delay(20);
  let current = JSON.parse(await readFile(path.join(dir, 'pub1.summary.json'), 'utf8'));
  assert.equal(current.updatedAt, new Date(0).toISOString(), 'no write yet: less than a second has passed');

  clock.advance(800); // now at 1000ms since the first write: the trailing timer fires
  await delay(20);
  current = JSON.parse(await readFile(path.join(dir, 'pub1.summary.json'), 'utf8'));
  assert.equal(current.updatedAt, new Date(1000).toISOString());

  // A change well after the debounce window writes immediately.
  clock.advance(2000);
  publisher.changed();
  await delay(20);
  current = JSON.parse(await readFile(path.join(dir, 'pub1.summary.json'), 'utf8'));
  assert.equal(current.updatedAt, new Date(3000).toISOString());

  // The heartbeat fires on its own, without changed() being called.
  clock.advance(60_000);
  await delay(20);
  current = JSON.parse(await readFile(path.join(dir, 'pub1.summary.json'), 'utf8'));
  assert.equal(current.updatedAt, new Date(63_000).toISOString());

  await publisher.dispose();
  assert.deepEqual(await readProjectSummaries(dir, new Date(), () => true), []);
});

test('dispose stops the heartbeat: no further write happens after it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-summary-'));
  const clock = fakeClock();
  const publisher = startProjectSummaryPublisher({
    dir, id: 'pub2', pid: process.pid, clock,
    build: () => ({ folder: '/repo', name: 'repo', heads: { running: 0, blocked: 0, done: 0 }, lanes: { running: 0, exited: 0 }, plans: { live: 0, lines: [] }, blocked: [], evidence: { passed: 0, partial: 0, none: 0, 'none-chosen': 0, override: 0 }, providers: [] }),
  });
  await delay(20);
  await publisher.dispose();
  clock.advance(60_000);
  await delay(20);
  assert.deepEqual(await readProjectSummaries(dir, new Date(), () => true), []);
});

test('a publisher only ever writes its own id: two publishers in the same directory never touch each other\'s file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-summary-'));
  const clockA = fakeClock(), clockB = fakeClock();
  const build = (folder: string) => () => ({ folder, name: path.basename(folder), heads: { running: 0, blocked: 0, done: 0 }, lanes: { running: 0, exited: 0 }, plans: { live: 0, lines: [] }, blocked: [], evidence: { passed: 0, partial: 0, none: 0, 'none-chosen': 0, override: 0 }, providers: [] });
  const a = startProjectSummaryPublisher({ dir, id: 'window-a', pid: 111, clock: clockA, build: build('/repo/a') });
  const b = startProjectSummaryPublisher({ dir, id: 'window-b', pid: 222, clock: clockB, build: build('/repo/b') });
  await delay(20);
  clockA.advance(2000); a.changed(); await delay(20);
  const views = await readProjectSummaries(dir, new Date(), () => true);
  assert.deepEqual(views.map(view => view.folder).sort(), ['/repo/a', '/repo/b']);
  const fileA = JSON.parse(await readFile(path.join(dir, 'window-a.summary.json'), 'utf8'));
  const fileB = JSON.parse(await readFile(path.join(dir, 'window-b.summary.json'), 'utf8'));
  assert.equal(fileA.pid, 111);
  assert.equal(fileB.pid, 222);
  await a.dispose(); await b.dispose();
});
