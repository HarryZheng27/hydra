import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, cp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planFromLeadInput, findCycle } from '../src/core/plans';
import { planFileArguments } from '../src/core/hydraCli';
// @ts-expect-error: a plain .mjs module with no type declarations.
import { observePlan, renderResults, summarizeHydra, summarizeSingle, withResults, resultsStart, resultsEnd } from '../scripts/benchmark-lib.mjs';

/**
 * O9 (docs/Benchmark.md): the benchmark's harness, without spending anything: the fixture and its plan file are
 * checked with Hydra's own code, and the runner is driven end to end with stand-ins for `hydra` and the agent.
 */

const root = process.cwd();
const fixture = path.join(root, 'bench', 'fixture');
const script = path.join(root, 'scripts', 'benchmark.mjs');

function node(args: string[], cwd = root): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('the benchmark plan is six jobs in a diamond, and passes the same checks hydra plan run and hydra_plan_create make', async () => {
  const text = await readFile(path.join(fixture, '.hydra', 'plans', 'discounts.json'), 'utf8');
  const args = planFileArguments(text, 'discounts.json', { unattended: true, minutes: 120, usd: 60 }, () => 'k');
  const plan = planFromLeadInput(args as never, { leadSessionId: 'user', idempotencyKey: 'k' }, 5);
  assert.equal(plan.jobs.length, 6);
  assert.equal(findCycle(plan.jobs), undefined);
  const deps = Object.fromEntries(plan.jobs.map(job => [job.key, job.dependsOn]));
  assert.deepEqual(deps.discounts, []);
  assert.deepEqual(deps.api, ['discounts']);
  assert.deepEqual(deps.ui, ['discounts']);
  assert.deepEqual([...deps.docs!].sort(), ['api', 'ui'], 'the diamond: two branches off one job, joined again');
  assert.ok(plan.jobs.every(job => job.writeScope?.length && job.brief.length > 40));
});

test('the fixture passes its own gate before any agent touches it', async () => {
  const result = await node(['--test'], fixture);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const gates = JSON.parse(await readFile(path.join(fixture, '.hydra', 'gates.json'), 'utf8'));
  assert.deepEqual(gates.gates.map((gate: { id: string; command: string[] }) => [gate.id, gate.command.join(' ')]), [['test', 'npm test']]);
});

test('benchmark.mjs prepare makes two fresh repositories of the fixture, each with one commit', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'hydra-bench-'));
  try {
    const prepared = await node([script, 'prepare', '--out', out]);
    assert.equal(prepared.code, 0, prepared.stderr);
    for (const name of ['hydra', 'single']) {
      const repo = path.join(out, name);
      assert.ok((await readdir(path.join(repo, '.hydra', 'plans'))).includes('discounts.json'));
      const log = await new Promise<string>((resolve, reject) => { const child = spawn('git', ['log', '--oneline'], { cwd: repo, windowsHide: true }); let text = ''; child.stdout.on('data', chunk => { text += chunk; }); child.on('error', reject); child.on('close', () => resolve(text)); });
      assert.equal(log.trim().split('\n').length, 1);
    }
    assert.equal((await node([script, 'prepare', '--out', out])).code, 1, 'never over a run already there');
  } finally { await rm(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('benchmark.mjs hydra watches the plan to the end and records time, the gate, conflicts, amendments and cost', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'hydra-bench-'));
  try {
    const repo = path.join(out, 'hydra');
    await mkdir(repo, { recursive: true });
    const fake = path.join(root, 'tests', 'fixtures', 'bench', 'fake-hydra.cjs');
    const ran = await node([script, 'hydra', '--repo', repo, '--poll', '0.01', '--hydra', `"${process.execPath}" "${fake}"`]);
    assert.equal(ran.code, 0, ran.stderr);
    const results = JSON.parse(await readFile(path.join(out, 'hydra-results.json'), 'utf8'));
    assert.equal(results.kind, 'hydra');
    assert.equal(results.planState, 'done');
    assert.deepEqual(results.integrationGate, { label: 'Passed required gates', passed: true, checks: [{ id: 'test', state: 'passed' }] });
    assert.equal(results.conflicts.predicted, 1, 'the api job was predicted to conflict with the integration branch');
    assert.equal(results.conflicts.landingConflicts, 1, 'its head passed, then a new one started: its landing conflicted');
    assert.equal(results.amendments, 1);
    assert.deepEqual(results.cost, { usd: 1.25, usdJobs: 2, inputTokens: 0, outputTokens: 0, tokenJobs: 0, jobs: 2 });
    assert.match(await readFile(path.join(out, 'hydra-report.md'), 'utf8'), /^# Discount codes/);
  } finally { await rm(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('benchmark.mjs single runs one agent on the whole task, then the same gate, and records its time and reported cost', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'hydra-bench-'));
  try {
    const repo = path.join(out, 'single');
    await cp(fixture, repo, { recursive: true });
    const fake = path.join(root, 'tests', 'fixtures', 'bench', 'fake-agent.cjs');
    const ran = await node([script, 'single', '--repo', repo, '--command', `"${process.execPath}" "${fake}"`]);
    assert.equal(ran.code, 0, ran.stderr);
    const results = JSON.parse(await readFile(path.join(out, 'single-results.json'), 'utf8'));
    assert.equal(results.kind, 'single');
    assert.equal(results.gate.passed, true, 'the untouched fixture still passes npm test');
    assert.deepEqual(results.cost, { usd: 1.5 });
    assert.equal(results.turns, 12);
  } finally { await rm(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('benchmark results render every run, failures included, into docs/Benchmark.md\'s results section', async () => {
  assert.equal(renderResults([]), 'No run has been published yet.');
  const hydra = summarizeHydra({
    view: { plan_id: 'aaaaaaaa0001', state: 'incomplete', jobs: [{ key: 'a', status: 'done', head: { provider: 'claude', attempts: 1, usage: { runs: 1, cost_usd: 2 } } }, { key: 'b', status: 'failed' }], amendments: [], integration: { landed: ['a'], gate: { label: 'Integration gate failed', checks: [] } } },
    observed: observePlan(undefined, { jobs: [] }), wallClockSeconds: 1234, passed: false, timedOut: false,
  });
  const single = summarizeSingle({ agent: 'claude', wallClockSeconds: 2000, exitCode: 0, gatePassed: false, gateOutput: 'x', agentOutput: { total_cost_usd: 3.25 } });
  const markdown = renderResults([{ at: '2026-10-01T10:00:00.000Z', label: 'first run', hydra, single }]);
  assert.ok(markdown.includes('### 2026-10-01: first run'));
  assert.ok(markdown.includes('| Wall-clock | 20m 34s | 33m 20s (claude) |'));
  assert.ok(markdown.includes('| Gates at the end | Integration gate failed (did not pass) | `npm test` failed |'));
  assert.ok(markdown.includes('| Cost (as the providers reported it) | $2.00 (1 of 2 jobs) | $3.25 |'));
  assert.ok(markdown.includes('| Plan | incomplete; 1 of 2 jobs done | |'));
  const doc = await readFile(path.join(root, 'docs', 'Benchmark.md'), 'utf8');
  assert.ok(doc.includes(resultsStart) && doc.includes(resultsEnd));
  const updated = withResults(doc, [{ at: '2026-10-01T10:00:00.000Z', hydra, single }]);
  assert.ok(updated.includes('### 2026-10-01') && updated.includes(resultsEnd));
  assert.throws(() => withResults('no markers', []), /no results markers/);
  const history = JSON.parse(await readFile(path.join(root, 'bench', 'results.json'), 'utf8'));
  assert.equal(withResults(doc, history.runs), doc.replace(/(<!-- benchmark-results:start -->)[\s\S]*(<!-- benchmark-results:end -->)/, `$1\n${renderResults(history.runs)}\n$2`), 'the published doc matches bench/results.json');
});
