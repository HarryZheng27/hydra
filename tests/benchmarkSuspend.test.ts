import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error: a plain .mjs module with no type declarations.
import { createSuspendWatch, guardSuspend, pairSleepEvents, replaceVoidFolder, renderVoidRuns, voidExitCode } from '../scripts/benchmark-suspend.mjs';
// @ts-expect-error: a plain .mjs module with no type declarations.
import { run } from '../scripts/benchmark-run.mjs';
// @ts-expect-error: a plain .mjs module with no type declarations.
import { usageLimitText } from '../scripts/benchmark-swebench.mjs';
// @ts-expect-error: a plain .mjs module with no type declarations.
import { renderSummary } from '../scripts/benchmark-lib.mjs';

/** A clock and heartbeat the test drives by hand. */
function fakeClock(start = Date.parse('2026-09-29T00:00:00Z')) {
  let at = start; const beats: Array<() => void> = [];
  return {
    now: () => at, advance: (ms: number) => { at += ms; }, beat: () => beats.forEach(fn => fn()),
    setInterval: (fn: () => void) => { beats.push(fn); return { unref() {} }; }, clearInterval: () => { beats.length = 0; },
  };
}
type Failure = Error & { exitCode?: number; suspended?: unknown };

test('the heartbeat records a gap over 60 s and ignores ordinary beats', () => {
  const clock = fakeClock();
  const watch = createSuspendWatch(clock);
  clock.advance(5000); clock.beat();
  clock.advance(1_800_000); clock.beat();
  clock.advance(5000); clock.beat();
  const gaps = watch.stop();
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].seconds, 1800);
  assert.equal(gaps[0].from, '2026-09-29T00:00:05.000Z');
});

test('a run that slept is marked void, exits with code 4, and keeps the gap', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-bench-void-'));
  try {
    const file = path.join(dir, 'single-results.json');
    const clock = fakeClock();
    const error = await guardSuspend(async () => {
      await writeFile(file, JSON.stringify({ kind: 'single', wallClockSeconds: 1800 }));
      clock.advance(1_800_000); clock.beat();
    }, { files: () => [file], watch: clock, now: clock.now, events: async () => [], log: () => {} }).then(() => undefined, (e: Failure) => e);
    assert.equal(error?.exitCode, voidExitCode);
    assert.equal(voidExitCode, 4);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.void, 'suspended');
    assert.match(saved.voidReason, /suspended for 1800s/);
    assert.equal(saved.suspended[0].seconds, 1800);
    assert.equal(saved.wallClockSeconds, 1800);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an event-log sleep voids a run the heartbeat missed, and a clean run passes through', async () => {
  const clock = fakeClock();
  const window = { from: '2026-09-29T00:10:00.000Z', to: '2026-09-29T00:40:00.000Z', seconds: 1800, source: 'event log' };
  const error = await guardSuspend(async () => 'x', { watch: clock, now: clock.now, events: async () => [window], log: () => {} }).then(() => undefined, (e: Failure) => e);
  assert.equal(error?.exitCode, 4);
  assert.deepEqual(error?.suspended, [window]);
  assert.equal(await guardSuspend(async () => 'fine', { watch: clock, now: clock.now, events: async () => [], log: () => {} }), 'fine');
  await assert.rejects(guardSuspend(async () => { throw new Error('boom'); }, { watch: clock, now: clock.now, events: async () => [], log: () => {} }), /boom/);
});

test('sleep and wake events pair into windows', () => {
  const events = [{ id: 107, at: '2026-09-29T02:00:00.000Z' }, { id: 42, at: '2026-09-29T01:00:00.000Z' }, { id: 506, at: '2026-09-29T03:00:00.000Z' }, { id: 507, at: '2026-09-29T03:10:00.000Z' }];
  assert.deepEqual(pairSleepEvents(events).map((w: { seconds: number }) => w.seconds), [3600, 600]);
});

test('a wall-clock deadline kills a stalled child even when the timer never fires', async () => {
  const started = Date.now();
  // The timer is 10 minutes away; the clock jumps past the deadline half a second in, and the heartbeat kills the child.
  const result = await run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { shell: false, timeoutMs: 600_000, now: () => Date.now() + (Date.now() - started > 500 ? 700_000 : 0), heartbeatMs: 50 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 15_000);
});

test('summarize lists void runs on their own, counted per setup', () => {
  const text = renderVoidRuns([
    { folder: 'run-1', task: 'discounts', setup: 'single', suspended: [{ from: 'a', to: 'b', seconds: 1800 }] },
    { folder: 'run-2', task: 'discounts', setup: 'single', suspended: [{ from: 'c', to: 'd', seconds: 90 }] },
    { folder: 'run-3', task: 'discounts', setup: 'hydra', suspended: [] },
  ]);
  assert.match(text, /## Void runs \(machine slept\)/);
  assert.match(text, /Per setup: hydra 1, single 2\./);
  assert.match(text, /run-1 .*a to b \(1800s\)/);
  assert.equal(renderVoidRuns([]), '');
  assert.doesNotMatch(renderSummary([{ folder: 'ok', task: 'discounts', setup: 'single', workSeconds: 100, totalSeconds: 100, gatePassed: true }]), /Void/);
});

test('replaceVoidFolder moves only a void run aside', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'hydra-bench-replace-'));
  try {
    const bad = path.join(parent, 'run-a'), good = path.join(parent, 'run-b');
    for (const dir of [bad, good]) await mkdir(path.join(dir, 'single'), { recursive: true });
    await writeFile(path.join(bad, 'single-results.json'), JSON.stringify({ void: 'suspended' }));
    await writeFile(path.join(good, 'single-results.json'), JSON.stringify({ kind: 'single' }));
    assert.equal(await replaceVoidFolder(good, { stamp: 'T' }), undefined);
    assert.equal(await replaceVoidFolder(bad, { stamp: 'T' }), `${bad}.void-T`);
    assert.deepEqual((await readdir(parent)).sort(), ['run-a.void-T', 'run-b']);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('the usage-limit detector matches real limit messages, never a bare 429', () => {
  for (const text of ['HTTP 429', 'API Error: 429 Too Many Requests', 'rate_limit_error', 'rate limit exceeded', 'Claude AI usage limit reached', 'status: 429'])
    assert.ok(usageLimitText(text), text);
  for (const text of ['"duration_ms": 1.1429', 'took 4290 ms', 'line 429 of file', 'exit 1', '', undefined])
    assert.ok(!usageLimitText(text), String(text));
});
