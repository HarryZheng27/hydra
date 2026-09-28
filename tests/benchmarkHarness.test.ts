import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reviewRepository } from '../scripts/benchmark-review';
// @ts-expect-error: a plain .mjs module with no type declarations.
import { fixturePath, pickTask, taskLabel, observePlan, summarizeHydra, summarizeSingle, workDoneSeconds, landingFromStore, parseCheckOutput, summarizeReview, withReview, runRows, renderSummary, spread, rate, reviewRate, median, globSegment, isFixJob, singleSettings, singleClaudeArgs, singleAllowedTools, usageLimited } from '../scripts/benchmark-lib.mjs';

/**
 * O9 (docs/Benchmark.md): the harness's review of a single agent's result and its summary of many runs, without
 * spending anything: the reviewer is a stand-in that answers as Codex does, and results are written by hand.
 */

const root = process.cwd();
const script = path.join(root, 'scripts', 'benchmark.mjs');
const fakeReviewer = path.join(root, 'tests', 'fixtures', 'bench', 'fake-reviewer.cjs');

function node(args: string[], cwd = root): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
const git = (cwd: string, ...args: string[]) => { const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };

/** A repository like a prepared single run: one commit of a fixture with a command gate, then the agent's work. */
async function singleRepo(out: string, { commitWork }: { commitWork: boolean }): Promise<{ repo: string; base: string }> {
  const repo = path.join(out, 'single');
  await mkdir(path.join(repo, '.hydra'), { recursive: true });
  await writeFile(path.join(repo, '.hydra', 'gates.json'), JSON.stringify({ gates: [{ id: 'test', type: 'command', required: true, command: [process.execPath, '-e', 'process.exit(0)'] }] }));
  await writeFile(path.join(repo, 'total.js'), 'module.exports = cents => cents;\n');
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --version' } }));
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@hydra.invalid');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'fixture');
  const base = git(repo, 'rev-parse', 'HEAD');
  await writeFile(path.join(repo, 'total.js'), 'module.exports = (cents, off = 0) => cents - off;\n');
  if (commitWork) { git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'work'); }
  return { repo, base };
}

test('the review module runs the integration gate\'s checks on a repository: the command gate, then one review by the other agent, with a plan\'s title and brief', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'hydra-bench-'));
  try {
    const { repo, base } = await singleRepo(out, { commitWork: true });
    let clock = 1_000;
    const reviewed = await reviewRepository({ repo, base, planTitle: 'Shop features', planBrief: 'Seven features.', logDirectory: path.join(out, 'logs'), reviewerCommand: [process.execPath, fakeReviewer, 'fail'], now: () => (clock += 500) });
    assert.deepEqual(reviewed.checks.map(check => [check.id, check.kind, check.state]), [['test', 'command', 'passed'], ['rigor-review', 'review', 'failed']]);
    const review = reviewed.checks[1]!;
    assert.equal(review.reviewer, 'codex', 'Claude Code wrote it, so Codex reviews');
    assert.equal(review.findings?.length, 2);
    assert.equal(reviewed.durationMs, 500);
    const prompt = await readFile(path.join(out, 'fake-reviewer-prompt.md'), 'utf8');
    assert.match(prompt, /Plan "Shop features": every job's work together/);
    assert.match(prompt, /Seven features\./);
    assert.match(prompt, /off = 0/, 'the diff base..HEAD is in the prompt');
  } finally { await rm(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('benchmark.mjs review commits what the agent left, reviews base..HEAD, and adds the verdict and timing to the single results', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'hydra-bench-'));
  try {
    const { repo } = await singleRepo(out, { commitWork: false });
    // The agent changed its repository's gates to one that fails: the review must use the fixture's (npm test) instead.
    await writeFile(path.join(repo, '.hydra', 'gates.json'), JSON.stringify({ gates: [{ id: 'test', type: 'command', required: true, command: [process.execPath, '-e', 'process.exit(1)'] }] }));
    const single = { version: 1, kind: 'single', fixture: 'shop', task: 'shop-features', agent: 'claude', wallClockSeconds: 300, agentExitCode: 0, gate: { passed: true, outputTail: '' }, cost: { usd: 2 } };
    await writeFile(path.join(out, 'single-results.json'), JSON.stringify(single));
    const ran = await node([script, 'review', '--results', out, '--reviewer-command', `"${process.execPath}" "${fakeReviewer}"`]);
    assert.equal(ran.code, 0, ran.stderr + ran.stdout);
    const review = JSON.parse(await readFile(path.join(out, 'single-review.json'), 'utf8'));
    assert.equal(review.kind, 'single-review');
    assert.equal(review.verdict, 'pass');
    assert.equal(review.gatesPassed, true);
    assert.equal(review.committedLeftovers, true, 'the agent\'s uncommitted work was committed first');
    assert.equal(review.reviewer, 'codex');
    assert.equal(typeof review.durationSeconds, 'number');
    assert.deepEqual(review.checks.map((check: { id: string; state: string }) => [check.id, check.state]), [['test', 'passed'], ['rigor-review', 'passed']]);
    assert.ok((await readdir(out)).includes(review.logs), 'the reviewer\'s prompt and reply are kept');
    const updated = JSON.parse(await readFile(path.join(out, 'single-results.json'), 'utf8'));
    assert.deepEqual(updated.review, { verdict: 'pass', passed: true, ran: true, gatesPassed: true, durationSeconds: review.durationSeconds, reviewer: 'codex', findings: { blocker: 0, major: 0, minor: 0 } });
    assert.equal(updated.cost.usd, 2, 'the rest of the results are kept');
    assert.match(await readFile(path.join(out, 'fake-reviewer-prompt.md'), 'utf8'), /Plan "Shop features": every job's work together/, 'the plan comes from the fixture the results name');
    assert.equal(review.ran, true);
    const missing = await node([script, 'review', '--results', path.join(out, 'nowhere')]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /no single-results\.json/);
  } finally { await rm(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('benchmark.mjs review: a review that didn\'t run is recorded as not run, never failed, and the command fails; a usage limit exits 3', async () => {
  for (const [mode, exitCode, limited] of [['limit', 3, true], ['crash', 1, false]] as const) {
    const out = await mkdtemp(path.join(tmpdir(), 'hydra-bench-'));
    try {
      await singleRepo(out, { commitWork: true });
      await writeFile(path.join(out, 'single-results.json'), JSON.stringify({ version: 1, kind: 'single', fixture: 'shop', task: 'shop-features', agent: 'claude', wallClockSeconds: 300, gate: { passed: true }, cost: {} }));
      const ran = await node([script, 'review', '--results', out, '--reviewer-command', `"${process.execPath}" "${fakeReviewer}" ${mode}`]);
      assert.equal(ran.code, exitCode, mode + ': ' + ran.stderr);
      assert.match(ran.stderr, limited ? /^USAGE LIMIT: The review didn't run/ : /^The review didn't run/);
      const review = JSON.parse(await readFile(path.join(out, 'single-review.json'), 'utf8'));
      assert.deepEqual([review.verdict, review.ran, review.usageLimit], ['not run', false, limited]);
      const updated = JSON.parse(await readFile(path.join(out, 'single-results.json'), 'utf8'));
      assert.equal(updated.review.passed, undefined, 'not a failure');
      assert.equal(updated.review.ran, false);
      assert.equal(runRows(updated, 'r')[1].reviewNotRun, true);
    } finally { await rm(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }
});

test('a review summary: the verdict comes from the review check, gates pass unless a required one failed, and findings are counted by severity', () => {
  const checks = [
    { id: 'test', kind: 'command', required: true, state: 'passed', passed: true, exitCode: 0, durationMs: 4200, outputTail: '' },
    { id: 'rigor-review', kind: 'review', required: true, state: 'failed', passed: false, exitCode: 0, durationMs: 61_000, outputTail: '', reviewer: 'codex', summary: 'Reviewed by Codex. No.', findings: [{ severity: 'blocker', note: 'a' }, { severity: 'minor', note: 'b' }] },
  ];
  const review = summarizeReview({ checks, durationMs: 65_400, startedAt: 'x', base: 'b', head: 'h', committedLeftovers: false, fixture: 'kanban-app', task: 'kanban-app' });
  assert.equal(review.verdict, 'fail');
  assert.equal(review.gatesPassed, false);
  assert.equal(review.durationSeconds, 65);
  assert.deepEqual(review.checks.map((check: { durationSeconds: number }) => check.durationSeconds), [4, 61]);
  assert.deepEqual(withReview({ kind: 'single' }, review).review.findings, { blocker: 1, major: 0, minor: 1 });
  const notRun = summarizeReview({ checks: [{ ...checks[0], state: 'failed' }, { ...checks[1], state: 'notRun', summary: 'Skipped: test failed first.', findings: undefined }], durationMs: 0, startedAt: 'x', base: 'b', head: 'h' });
  assert.equal(notRun.verdict, 'not run');
  assert.equal(notRun.gatesPassed, false);
  assert.deepEqual([notRun.ran, notRun.notRunReason, notRun.usageLimit], [false, 'Skipped: test failed first.', false]);
  assert.equal('passed' in withReview({ kind: 'single' }, notRun).review, false, 'no verdict is not a failed one');
  assert.equal(usageLimited('Codex hit its usage limit (resets 5pm).'), true);
  assert.equal(usageLimited('Codex didn\'t finish its review in 5 minutes.'), false);
});

test('fixtures: the default is bench/fixture with discounts; another fixture\'s task defaults to its only plan; labels name the fixture', () => {
  assert.equal(fixturePath('R', undefined), 'R/bench/fixture');
  assert.equal(fixturePath('R', 'shop'), 'R/bench/fixture');
  assert.equal(fixturePath('R', 'kanban-app'), 'R/bench/fixtures/kanban-app');
  assert.throws(() => fixturePath('R', '../x'), /isn't a fixture name/);
  assert.equal(pickTask('shop', ['discounts', 'shop-features'], undefined), 'discounts');
  assert.equal(pickTask('kanban-app', ['kanban-app'], undefined), 'kanban-app');
  assert.throws(() => pickTask('two', ['a', 'b'], undefined), /--task is one of a, b/);
  assert.throws(() => pickTask('shop', ['discounts', 'shop-features'], 'nope'), /--task is one of discounts, shop-features/);
  assert.equal(taskLabel({ task: 'shop-features' }), 'shop-features');
  assert.equal(taskLabel({}), 'discounts', 'the first published runs had no task');
  assert.equal(taskLabel({ fixture: 'cli-toolkit', task: 'cli-toolkit' }), 'cli-toolkit/cli-toolkit');
});

test('time to working code for Hydra: when the last of the plan\'s own jobs landed, from watching or from the plan store; fix jobs don\'t count', () => {
  assert.equal(isFixJob('integration-fix-2'), true);
  assert.equal(isFixJob('integration'), false);
  let seen = observePlan(undefined, { jobs: [], integration: { landed: ['a'] } }, 40.4);
  seen = observePlan(seen, { jobs: [], integration: { landed: ['a', 'b'] } }, 95);
  seen = observePlan(seen, { jobs: [], integration: { landed: ['a', 'b', 'integration-fix-1'] } }, 300);
  assert.deepEqual(seen.landedAt, { a: 40, b: 95, 'integration-fix-1': 300 }, 'first seen, never moved later');
  assert.equal(workDoneSeconds(['a', 'b', 'integration-fix-1'], seen.landedAt), 95);
  assert.equal(workDoneSeconds(['a', 'b', 'c'], seen.landedAt), null, 'c never landed');
  const start = Date.parse('2026-09-28T10:00:00.000Z');
  const plan = { startedAt: '2026-09-28T10:00:05.000Z', jobs: [{ key: 'a' }, { key: 'b' }], integration: { landed: [{ key: 'a', at: '2026-09-28T10:03:00.000Z' }, { key: 'b', at: '2026-09-28T10:04:10.000Z' }] } };
  assert.deepEqual(landingFromStore(plan, start).landedAtSeconds, { a: 180, b: 250 });
  assert.deepEqual(landingFromStore(plan).landedAtSeconds, { a: 175, b: 245 }, 'without the benchmark\'s start, from the plan\'s');
  const view = {
    plan_id: 'p', state: 'done', amendments: [], jobs: [{ key: 'a', status: 'done' }, { key: 'b', status: 'done' }, { key: 'integration-fix-1', status: 'done' }],
    integration: { landed: ['a', 'b', 'integration-fix-1'], gate: { label: 'Passed required gates', checks: [{ id: 'test', kind: 'command', state: 'passed' }, { id: 'rigor-review', kind: 'review', state: 'passed', summary: 'Fine.' }] } },
  };
  const results = summarizeHydra({ view, observed: seen, wallClockSeconds: 400, passed: true, timedOut: false, task: 't', fixture: 'f', landing: landingFromStore(plan, start) });
  assert.equal(results.timeToWorkingCodeSeconds, 250, 'the plan store\'s exact times win over watching');
  assert.equal(results.landingTimesFrom, 'plan store');
  assert.equal(results.fixRounds, 1);
  assert.deepEqual(results.review, { id: 'rigor-review', state: 'passed', passed: true, summary: 'Fine.' });
  assert.deepEqual(results.integrationGate.checks[1], { id: 'rigor-review', kind: 'review', state: 'passed' });
});

test('a fixture\'s hidden check: its last JSON line is the summary; no summary or a failed check is a failure', () => {
  assert.deepEqual(parseCheckOutput('ok - a\nok - b\n{"checks":2,"passed":2,"failed":[]}\n', 0, 3), { passed: true, checks: 2, passedChecks: 2, failed: [], seconds: 3, outputTail: 'ok - a\nok - b\n{"checks":2,"passed":2,"failed":[]}\n' });
  const failed = parseCheckOutput('not ok - b: nope\n{"checks":2,"passed":1,"failed":["b"]}', 1);
  assert.equal(failed.passed, false);
  assert.deepEqual(failed.failed, ['b']);
  const crashed = parseCheckOutput('SyntaxError: bad', 1);
  assert.equal(crashed.passed, false);
  assert.match(crashed.error, /no summary/);
});

test('summary statistics: the median, min–max and pass rates, saying how many runs had a value', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  const seconds = (value: number) => `${value}s`;
  assert.equal(spread([10, 30, 20], seconds), '20s (10s–30s)');
  assert.equal(spread([10], seconds), '10s');
  assert.equal(spread([10, null, 30], seconds), '20s (10s–30s); 2 of 3 runs');
  assert.equal(spread([undefined], seconds), '–');
  assert.equal(rate([true, false, true]), '2/3');
  assert.equal(rate([undefined, undefined]), '–');
  assert.equal(globSegment('bench-p1-r*-single').test('BENCH-P1-R12-single'), true);
  assert.equal(globSegment('run-?').test('run-10'), false);
  assert.equal(globSegment('a.b').test('axb'), false);
});

test('runs become rows per setup: single, single+review once reviewed (its total adds the review), and hydra with fix rounds', () => {
  const single = { kind: 'single', fixture: 'kanban-app', task: 'kanban-app', wallClockSeconds: 3000, gate: { passed: true }, cost: { usd: 9 }, check: { passed: true }, review: { verdict: 'fail', passed: false, durationSeconds: 200 } };
  const rows = runRows(single, 'r1');
  assert.deepEqual(rows.map((row: { setup: string; totalSeconds: number; reviewPassed?: boolean }) => [row.setup, row.totalSeconds, row.reviewPassed]), [['single', 3000, undefined], ['single+review', 3200, false]]);
  assert.equal(runRows({ ...single, gate: { passed: false } }, 'r1')[0].workSeconds, null, 'no working code when its tests failed');
  const oldHydra = { kind: 'hydra', task: 'shop-features', wallClockSeconds: 790, integrationGate: { passed: true, checks: [{ id: 'test', state: 'passed' }, { id: 'rigor-review', state: 'failed' }] }, jobs: [{ key: 'a' }, { key: 'integration-fix-1' }, { key: 'integration-fix-2' }], cost: { usd: 2.86, usdJobs: 3 } };
  const [row] = runRows(oldHydra, 'r2', { jobKeys: [], landedAtSeconds: { a: 227 } });
  assert.deepEqual([row.setup, row.workSeconds, row.fixRounds, row.reviewPassed, row.usd], ['hydra', 227, 2, false, 2.86], 'results from before these fields: the store\'s timings, fix jobs counted, the review found by its id');
  assert.equal(runRows({ ...oldHydra, cost: { usd: 0, usdJobs: 0 } }, 'r2')[0].usd, undefined, 'no job reported a cost');
});

test('the summary table groups by task and setup, and lists every run below it', () => {
  const rows = [
    ...runRows({ kind: 'hydra', task: 'shop-features', wallClockSeconds: 600, timeToWorkingCodeSeconds: 200, integrationGate: { passed: true, checks: [] }, review: { passed: true }, fixRounds: 1, jobs: [], cost: { usd: 3, usdJobs: 8 } }, 'r1-hydra'),
    ...runRows({ kind: 'hydra', task: 'shop-features', wallClockSeconds: 800, timeToWorkingCodeSeconds: 260, integrationGate: { passed: true, checks: [] }, review: { passed: false }, fixRounds: 3, jobs: [], cost: { usd: 4, usdJobs: 8 } }, 'r2-hydra'),
    ...runRows({ kind: 'single', task: 'shop-features', wallClockSeconds: 400, gate: { passed: true }, cost: { usd: 2 }, review: { passed: true, durationSeconds: 100 } }, 'r1-single'),
  ];
  const markdown = renderSummary(rows);
  const lines = markdown.split('\n');
  assert.ok(lines[0]!.startsWith('| Task | Setup | Runs | Time to working code | Total time | Cost reported | Gate passed | Review passed | Fix rounds | Check passed |'));
  assert.equal(lines[2], '| shop-features | single | 1 | 6m 40s | 6m 40s | $2.00 | 1/1 | – | – | – |');
  assert.equal(lines[3], '| shop-features | single+review | 1 | 6m 40s | 8m 20s | $2.00 | 1/1 | 1/1 | – | – |');
  assert.equal(lines[4], '| shop-features | hydra | 2 | 3m 50s (3m 20s–4m 20s) | 11m 40s (10m 00s–13m 20s) | $3.50 ($3.00–$4.00) | 2/2 | 1/2 | 2 (1–3) | – |');
  assert.ok(markdown.includes('| r2-hydra | shop-features | hydra | 4m 20s | 13m 20s | $4.00 | passed | failed | 3 | – |'));
});

test('benchmark.mjs summarize reads every run folder a glob matches, fills old Hydra results\' timing from the plan store, and writes the table', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'hydra-bench-'));
  try {
    const write = async (folder: string, name: string, value: unknown) => { await mkdir(path.join(out, folder), { recursive: true }); await writeFile(path.join(out, folder, name), JSON.stringify(value)); };
    await write('bench-p1-r1-single', 'single-results.json', { kind: 'single', task: 'shop-features', wallClockSeconds: 400, gate: { passed: true }, cost: { usd: 2 } });
    await write('bench-p1-r1-hydra', 'hydra-results.json', { kind: 'hydra', task: 'shop-features', planId: 'abc123abc123', wallClockSeconds: 790, integrationGate: { passed: true, checks: [] }, jobs: [{ key: 'a' }, { key: 'b' }], cost: { usd: 3, usdJobs: 2 } });
    await mkdir(path.join(out, 'bench-p1-r2-hydra'));
    await write('store', 'plans.json', { version: 1, plans: [{ id: 'abc123abc123', startedAt: '2026-09-28T10:00:00.000Z', jobs: [{ key: 'a' }, { key: 'b' }], integration: { landed: [{ key: 'a', at: '2026-09-28T10:01:00.000Z' }, { key: 'b', at: '2026-09-28T10:03:47.000Z' }] } }] });
    const ran = await node([script, 'summarize', '--runs', path.join(out, 'bench-p1-*'), '--plan-store', path.join(out, 'store', 'plans.json')]);
    assert.equal(ran.code, 0, ran.stderr);
    const summary = await readFile(path.join(out, 'summary.md'), 'utf8');
    assert.ok(summary.includes('| shop-features | hydra | 1 | 3m 47s | 13m 10s | $3.00 | 1/1 | – | 0 | – |'), summary);
    assert.ok(summary.includes('| shop-features | single | 1 | 6m 40s |'));
    assert.match(summary, /No results in: bench-p1-r2-hydra/);
    assert.ok(ran.stdout.includes('| Task | Setup |'), 'printed as well as written');
    const none = await node([script, 'summarize', '--runs', path.join(out, 'nothing-*')]);
    assert.equal(none.code, 1);
  } finally { await rm(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('working code needs the hidden check too, when there is one, and a single agent that reported an error has none', () => {
  const single = { kind: 'single', task: 't', wallClockSeconds: 600, gate: { passed: true }, cost: {} };
  assert.equal(runRows({ ...single, check: { passed: false } }, 'r')[0].workSeconds, null, 'the untouched fixture passes npm test');
  assert.equal(runRows({ ...single, check: { passed: true } }, 'r')[0].workSeconds, 600);
  assert.equal(runRows(single, 'r')[0].workSeconds, 600, 'results from before the check');
  assert.equal(runRows({ ...single, check: { passed: true }, agentResult: { subtype: 'error_max_turns', isError: true } }, 'r')[0].workSeconds, null);
  const hydra = { kind: 'hydra', task: 't', wallClockSeconds: 900, timeToWorkingCodeSeconds: 400, integrationGate: { passed: true, checks: [] }, jobs: [], cost: {} };
  assert.equal(runRows({ ...hydra, check: { passed: false } }, 'r')[0].workSeconds, null);
  assert.equal(runRows({ ...hydra, check: { passed: true }, integrationGate: { passed: false, checks: [] } }, 'r')[0].workSeconds, null);
  assert.equal(runRows({ ...hydra, check: { passed: true } }, 'r')[0].workSeconds, 400);
  const agent = summarizeSingle({ agent: 'claude', wallClockSeconds: 5, exitCode: 0, gatePassed: true, gateOutput: '', agentOutput: { subtype: 'error_during_execution', is_error: true, total_cost_usd: 1 } });
  assert.deepEqual(agent.agentResult, { subtype: 'error_during_execution', isError: true });
  assert.deepEqual(summarizeSingle({ agent: 'claude', wallClockSeconds: 5, exitCode: 0, gatePassed: true, gateOutput: '', agentOutput: { subtype: 'success', is_error: false } }).agentResult, { subtype: 'success', isError: false });
});

test('a review that didn\'t run is left out of the pass rate, and counted beside it, for single agents and Hydra', () => {
  const hydra = (state: string) => runRows({ kind: 'hydra', task: 't', wallClockSeconds: 1, integrationGate: { passed: false, checks: [] }, review: { id: 'rigor-review', state }, jobs: [], cost: {} }, 'r')[0];
  assert.deepEqual([hydra('passed').reviewPassed, hydra('failed').reviewPassed, hydra('notRun').reviewPassed, hydra('notRun').reviewNotRun], [true, false, undefined, true]);
  const view = { plan_id: 'p', state: 'done', jobs: [], integration: { landed: [], gate: { label: 'x', checks: [{ id: 'rigor-review', kind: 'review', state: 'notRun', summary: 'Codex hit its usage limit.' }] } } };
  assert.deepEqual(summarizeHydra({ view, wallClockSeconds: 1, passed: false }).review, { id: 'rigor-review', state: 'notRun', ran: false, usageLimit: true, summary: 'Codex hit its usage limit.' });
  assert.equal(reviewRate([hydra('passed'), hydra('failed'), hydra('notRun')]), '1/2; 1 not run');
  assert.equal(reviewRate([hydra('notRun')]), '–; 1 not run');
  const markdown = renderSummary([hydra('passed'), hydra('notRun')]);
  assert.ok(markdown.includes('| 1/1; 1 not run |'), markdown);
  assert.ok(markdown.includes('| not run |'));
});

test('the single Claude Code agent runs isolated like a head: no user plugins, no MCP servers, and the project\'s tools allowed', () => {
  assert.deepEqual(singleSettings(['b@market', 'a@market', 'bad id', 'a@market']), { enabledPlugins: { 'a@market': false, 'b@market': false } });
  assert.deepEqual(singleSettings([]), {});
  const args = singleClaudeArgs({ settingsFile: 's.json', mcpConfigFile: 'm.json' });
  assert.deepEqual(args.slice(0, 5), ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits']);
  assert.equal(args[args.indexOf('--settings') + 1], 's.json');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--mcp-config') + 1], 'm.json');
  const allowed = args[args.indexOf('--allowedTools') + 1]!.split(',');
  for (const tool of ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(npm:*)', 'Bash(node:*)', 'Bash(git:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(tail:*)']) assert.ok(allowed.includes(tool), tool);
  assert.deepEqual(allowed, [...singleAllowedTools]);
});
