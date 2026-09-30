import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, cp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planFromLeadInput, findCycle } from '../src/core/plans';
import { planFileArguments } from '../src/core/hydraCli';
// @ts-expect-error: a plain .mjs module with no type declarations.
import { observePlan, renderResults, summarizeHydra, summarizeSingle, taskFromPlan, tasks, withResults, resultsStart, resultsEnd, fixturePath, pickTask, taskLabel, workDoneSeconds, landingFromStore, parseCheckOutput, summarizeReview, withReview, runRows, renderSummary, spread, rate, median, globSegment, isFixJob } from '../scripts/benchmark-lib.mjs';

/**
 * O9 (docs/Benchmark.md): the benchmark's harness, without spending anything: the fixture and its plan file are
 * checked with Hydra's own code, and the runner is driven end to end with stand-ins for `hydra` and the agent.
 */

const root = process.cwd();
const fixture = path.join(root, 'bench', 'fixture');
const script = path.join(root, 'scripts', 'benchmark.mjs');

function node(args: string[], cwd = root): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // A child `node --test` (the fixtures' gate) that inherits the runner's context only reports to it and exits 0: it must run on its own.
    const { NODE_TEST_CONTEXT: _context, ...clean } = process.env;
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, env: clean });
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

test('the shop-features plan is seven independent jobs, then one that depends on all of them, and passes the same checks', async () => {
  const text = await readFile(path.join(fixture, '.hydra', 'plans', 'shop-features.json'), 'utf8');
  const args = planFileArguments(text, 'shop-features.json', { unattended: true, minutes: 120, usd: 60 }, () => 'k');
  const plan = planFromLeadInput(args as never, { leadSessionId: 'user', idempotencyKey: 'k' }, 5);
  const independent = plan.jobs.filter(job => !job.dependsOn.length).map(job => job.key);
  assert.deepEqual(independent, ['search', 'inventory', 'tax', 'shipping', 'reviews', 'export', 'receipt'], 'all seven features can run at once');
  const wire = plan.jobs.find(job => job.key === 'wire')!;
  assert.deepEqual([...wire.dependsOn].sort(), [...independent].sort(), 'the last job waits for every feature');
  for (const key of independent) assert.deepEqual(plan.jobs.find(job => job.key === key)!.writeScope, [`src/${key}.js`, `test/${key}.test.js`], `${key} touches only its own two files`);
  assert.deepEqual([...tasks], ['discounts', 'shop-features']);
});

test('the single agent\'s brief is generated from the plan file: its brief, then every job\'s title, brief and files, in order', async () => {
  for (const task of tasks as string[]) {
    const plan = JSON.parse(await readFile(path.join(fixture, '.hydra', 'plans', `${task}.json`), 'utf8'));
    const brief = taskFromPlan(plan);
    assert.ok(brief.startsWith(`# ${plan.title}\n\n${plan.brief}\n`), task);
    let at = 0;
    for (const [index, job] of (plan.jobs as { title: string; brief: string; write_scope: string[] }[]).entries()) {
      const heading = brief.indexOf(`## ${index + 1}. ${job.title}`, at);
      assert.ok(heading > at, `${task}: ${job.title} comes in order`);
      assert.ok(brief.includes(job.brief) && brief.includes(`Files: ${job.write_scope.join(', ')}`), `${task}: ${job.title}'s brief and files`);
      at = heading;
    }
  }
  const out = await mkdtemp(path.join(tmpdir(), 'hydra-bench-'));
  try {
    const ran = await node([script, 'single', '--repo', path.join(out, 'single'), '--task', 'nope']);
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /--task is one of discounts, shop-features/);
  } finally { await rm(out, { recursive: true, force: true }); }
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
    const ran = await node([script, 'hydra', '--repo', repo, '--poll', '0.01', '--plan-store', path.join(out, 'no-plans.json'), '--hydra', `"${process.execPath}" "${fake}"`]);
    assert.equal(ran.code, 0, ran.stderr);
    const results = JSON.parse(await readFile(path.join(out, 'hydra-results.json'), 'utf8'));
    assert.equal(results.kind, 'hydra');
    assert.equal(results.planState, 'done');
    assert.deepEqual(results.integrationGate, { label: 'Passed required gates', passed: true, checks: [{ id: 'test', state: 'passed' }] });
    assert.equal(results.conflicts.predicted, 1, 'the api job was predicted to conflict with the integration branch');
    assert.equal(results.conflicts.landingConflicts, 1, 'its head passed, then a new one started: its landing conflicted');
    assert.equal(results.amendments, 1);
    assert.equal(results.fixture, 'shop');
    assert.equal(results.fixRounds, 0);
    assert.equal(results.landingTimesFrom, 'watching', 'no plan store had the plan');
    assert.deepEqual(Object.keys(results.landedAtSeconds).sort(), ['api', 'discounts']);
    assert.equal(typeof results.timeToWorkingCodeSeconds, 'number', 'both jobs were seen landed');
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

test('benchmark.mjs single records nothing when the agent fails: an untouched fixture passing its own gate is not a result', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'hydra-bench-'));
  try {
    const repo = path.join(out, 'single');
    await cp(fixture, repo, { recursive: true });
    const failing = path.join(root, 'tests', 'fixtures', 'bench', 'failing-agent.cjs');
    const ran = await node([script, 'single', '--repo', repo, '--command', `"${process.execPath}" "${failing}"`]);
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /exited with 1 .*no result to record/s);
    assert.match(ran.stderr, /not signed in/);
    assert.equal((await readdir(out)).includes('single-results.json'), false);
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
  assert.equal(withResults(doc, history.runs), doc.replace(/(<!-- benchmark-results:start -->)[\s\S]*(<!-- benchmark-results:end -->)/, (_all: string, start: string, end: string) => `${start}\n${renderResults(history.runs)}\n${end}`), 'the published doc matches bench/results.json');
});
