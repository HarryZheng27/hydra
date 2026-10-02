import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error: a plain .mjs module with no type declarations.
import { endFromStore, endOfRun, landingFromStore, renderSummary, runRows, summarizeHydra, summarizeSingle } from '../scripts/benchmark-lib.mjs';

/**
 * A run ends at Hydra's own timestamps, not at the poll that noticed the plan settled (docs/Benchmark.md).
 * Nothing here runs a model: the plan store is a fake plans.json.
 */

const script = path.join(process.cwd(), 'scripts', 'benchmark.mjs');
const start = Date.parse('2026-09-28T10:00:00.000Z');
const plan = {
  id: 'abc123abc123', state: 'done', startedAt: '2026-09-28T10:00:02.000Z', updatedAt: '2026-09-28T10:07:31.000Z',
  jobs: [{ key: 'a' }, { key: 'b' }],
  integration: { landed: [{ key: 'a', at: '2026-09-28T10:03:00.000Z' }, { key: 'b', at: '2026-09-28T10:04:10.000Z' }], gate: { at: '2026-09-28T10:07:20.000Z', checks: [] } },
};
const view = { plan_id: 'abc123abc123', state: 'done', amendments: [], jobs: [{ key: 'a', status: 'done' }, { key: 'b', status: 'done' }], integration: { landed: ['a', 'b'], gate: { label: 'Passed required gates', checks: [] } } };

test('the plan\'s end: the gate record\'s time, else the plan\'s settle time, else nothing', () => {
  assert.deepEqual(endFromStore(plan, start), { seconds: 440, source: 'integration gate record' });
  assert.deepEqual(endFromStore({ ...plan, integration: { ...plan.integration, gate: { at: plan.integration.gate.at, running: true, checks: [] } } }, start), { seconds: 451, source: 'plan settle time' });
  assert.deepEqual(endFromStore({ ...plan, integration: { landed: [] } }, start), { seconds: 451, source: 'plan settle time' });
  assert.equal(endFromStore({ ...plan, state: 'running', integration: { landed: [] } }, start), undefined);
  assert.equal(endFromStore({ id: 'x', jobs: [] }, start), undefined);
  assert.deepEqual(landingFromStore(plan, start).end, { seconds: 440, source: 'integration gate record' });
});

test('a poll that noticed late is replaced by Hydra\'s time; a poll time is kept as the fallback and says so', () => {
  const stored = summarizeHydra({ view, wallClockSeconds: 462, passed: true, landing: landingFromStore(plan, start) });
  assert.equal(stored.wallClockSeconds, 440);
  assert.equal(stored.wallClockFrom, 'integration gate record');
  const polled = summarizeHydra({ view, wallClockSeconds: 462, passed: true });
  assert.equal(polled.wallClockSeconds, 462);
  assert.equal(polled.wallClockFrom, 'polling');
  const timedOut = summarizeHydra({ view, wallClockSeconds: 462, passed: false, timedOut: true, landing: landingFromStore(plan, start) });
  assert.equal(timedOut.wallClockSeconds, 462, 'a timed-out run ended at its poll');
  // A store time before the last landing, or after the poll, isn't believable.
  assert.equal(endOfRun({ seconds: 100, source: 's' }, 462, 250).from, 'polling');
  assert.equal(endOfRun({ seconds: 500, source: 's' }, 462, 250).from, 'polling');
  assert.equal(endOfRun({ seconds: 462, source: 's' }, 462, 250).from, 's');
});

test('a single run ends at its process exit', () => {
  const single = summarizeSingle({ agent: 'claude', wallClockSeconds: 90, exitCode: 0, gatePassed: true, gateOutput: '' });
  assert.equal(single.wallClockFrom, 'process exit');
});

test('summarize: time to working and reviewed code come from the plan store, unless the result already has them', async () => {
  const result = { kind: 'hydra', task: 'cli', planId: 'abc123abc123', startedAt: new Date(start).toISOString(), wallClockSeconds: 462, timeToWorkingCodeSeconds: 250, integrationGate: { passed: true, checks: [] }, review: { state: 'passed' }, fixRounds: 0, jobs: [{ key: 'a' }, { key: 'b' }], cost: { usd: 1, usdJobs: 1 } };
  const fallback = landingFromStore(plan, start);
  assert.equal(runRows(result, 'r', fallback)[0].workAfterSeconds, 440, 'an old result is corrected from the store');
  assert.equal(runRows(result, 'r', fallback)[0].totalSeconds, 440);
  assert.equal(runRows({ ...result, wallClockFrom: 'polling' }, 'r', fallback)[0].totalSeconds, 440);
  assert.equal(runRows({ ...result, wallClockFrom: 'integration gate record', wallClockSeconds: 440 }, 'r', fallback)[0].totalSeconds, 440);
  assert.equal(runRows(result, 'r')[0].totalSeconds, 462, 'no store: the recorded time');
  const out = await mkdtemp(path.join(tmpdir(), 'hydra-bench-'));
  try {
    await mkdir(path.join(out, 'run-1'));
    await writeFile(path.join(out, 'run-1', 'hydra-results.json'), JSON.stringify(result));
    await writeFile(path.join(out, 'plans.json'), JSON.stringify({ version: 1, plans: [plan] }));
    const ran = await new Promise<{ code: number | null; stderr: string }>(resolve => {
      const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
      const child = spawn(process.execPath, [script, 'summarize', '--runs', path.join(out, 'run-1'), '--plan-store', path.join(out, 'plans.json')], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('close', code => resolve({ code, stderr }));
    });
    assert.equal(ran.code, 0, ran.stderr);
    const summary = await readFile(path.join(out, 'summary.md'), 'utf8');
    assert.ok(summary.includes('7m 20s'), summary);
    assert.ok(!summary.includes('7m 42s'), summary);
  } finally { await rm(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('a plan Hydra ran as one head is recorded as such (mode, why, its jobs), and summarize says in how many runs', () => {
  const single = { ...view, jobs: [{ key: 'whole-plan', status: 'done' }], integration: { ...view.integration, landed: ['whole-plan'] }, mode: 'single-head', mode_reason: '6 jobs in a dependency chain of 3', single_head_jobs: ['a', 'b'] };
  const recorded = summarizeHydra({ view: single, wallClockSeconds: 300, passed: true, task: 'discounts' });
  assert.deepEqual([recorded.mode, recorded.modeReason, recorded.singleHeadJobs], ['single-head', '6 jobs in a dependency chain of 3', ['a', 'b']]);
  const split = summarizeHydra({ view, wallClockSeconds: 300, passed: true, task: 'discounts' });
  assert.deepEqual([split.mode, split.modeReason], ['jobs', undefined]);
  const rows = [...runRows({ ...recorded, timeToWorkingCodeSeconds: 200 }, 'r1-hydra'), ...runRows({ ...split, timeToWorkingCodeSeconds: 200 }, 'r2-hydra')];
  assert.deepEqual(rows.map((row: { singleHead?: boolean }) => row.singleHead), [true, undefined]);
  assert.match(renderSummary(rows), /^Hydra ran discounts as one head in 1\/2 runs\.$/m);
});
