import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planFromLeadInput, writeScopeOverlap } from '../src/core/plans';
import { planFileArguments } from '../src/core/hydraCli';
import { integrationFixJob, defaultIntegrationFixRounds } from '../src/core/integration';
// @ts-expect-error: a plain .mjs module with no type declarations.
import { defaultFixRounds, defaultPollSeconds, hydraReviewsRetried, defaultToolLocations, defaultUsd, firstReviewOf, jobCostUsd, parseCheckOutput, planSignature, pollDelayMs, registerFunctions, renderSummary, resolveTool, runRows, singleClaudeArgs, singleFixBrief, summarizeHydra, summarizeReview, summarizeSingle, withReviewLoop } from '../scripts/benchmark-lib.mjs';

/**
 * The fairness fixes to the benchmark (docs/Benchmark.md): Hydra's first-pass review, the single agent's fix loop,
 * the summary's columns, the fixtures' job counts and hidden checks, lighter polling and the tools' default paths.
 * Nothing here runs a model: the agents and the reviewer are stand-ins.
 */

const root = process.cwd();
const script = path.join(root, 'scripts', 'benchmark.mjs');
const fixturesDir = path.join(root, 'bench', 'fixtures');
const fakeReviewer = path.join(root, 'tests', 'fixtures', 'bench', 'fake-reviewer.cjs');
const fakeFixer = path.join(root, 'tests', 'fixtures', 'bench', 'fake-fixer.cjs');
const fakeHydra = path.join(root, 'tests', 'fixtures', 'bench', 'fake-hydra.cjs');
const cleanup = (dir: string) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

function node(args: string[], cwd = root, env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // A child `node --test` that inherits the runner's context only reports to it and exits 0: it must run on its own.
    const { NODE_TEST_CONTEXT: _context, ...clean } = env;
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, env: clean });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
const git = (cwd: string, ...args: string[]) => { const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };

// ---- the fixtures: job counts, the first layer, the kanban route index, module-refactor's structure test ----

type PlanFile = { title: string; brief: string; jobs: { key: string; title: string; brief: string; write_scope: string[]; depends_on?: string[] }[] };
async function fixturePlan(name: string): Promise<PlanFile> { return JSON.parse(await readFile(path.join(fixturesDir, name, '.hydra', 'plans', `${name}.json`), 'utf8')); }

test('job counts: kanban-app 10, cli-toolkit 9, module-refactor 10; each keeps room for both fix rounds under the default budget, with no two jobs sharing a file', async () => {
  const counts: Record<string, number> = { 'kanban-app': 10, 'cli-toolkit': 9, 'module-refactor': 10 };
  for (const [name, count] of Object.entries(counts)) {
    const plan = await fixturePlan(name);
    assert.equal(plan.jobs.length, count, `${name}: job count (docs/Benchmark.md lists it)`);
    assert.ok((plan.jobs.length + defaultIntegrationFixRounds) * jobCostUsd <= defaultUsd, `${name}: ${plan.jobs.length} jobs plus ${defaultIntegrationFixRounds} fix rounds at $${jobCostUsd} each fit the default $${defaultUsd}`);
    assert.equal(defaultFixRounds, defaultIntegrationFixRounds, 'the single agent gets the rounds Hydra has');
    for (const [index, a] of plan.jobs.entries()) for (const b of plan.jobs.slice(index + 1)) assert.equal(writeScopeOverlap(a.write_scope, b.write_scope), undefined, `${name}: ${a.key} and ${b.key} share a file`);
    // Valid the way hydra plan run needs it, with the fix rounds added.
    const text = await readFile(path.join(fixturesDir, name, '.hydra', 'plans', `${name}.json`), 'utf8');
    const created = planFromLeadInput(planFileArguments(text, `${name}.json`, { unattended: true, minutes: 120, usd: defaultUsd }, () => 'k') as never, { leadSessionId: 'user', idempotencyKey: 'k' }, 5);
    assert.equal(created.jobs.length, count);
  }
});

test('the dependency-free parts of the serial jobs run in the first layer: cli-toolkit\'s command line core, kanban-app\'s openServer and bin/serve.js', async () => {
  const cli = await fixturePlan('cli-toolkit');
  const core = cli.jobs.find(job => job.key === 'cli-core')!;
  assert.equal(core.depends_on, undefined, 'cli-core waits for nothing');
  assert.deepEqual([...core.write_scope].sort(), ['bin/toolkit.js', 'src/args.js', 'src/cli.js', 'src/commands/index.js', 'test/args.test.js', 'test/cli.test.js']);
  const last = cli.jobs.find(job => job.key === 'cli')!;
  assert.ok(last.depends_on!.includes('cli-core') && last.depends_on!.length === 8, 'the last job waits for the seven commands and the core');
  assert.deepEqual([...last.write_scope].sort(), ['README.md', 'test/toolkit.test.js']);
  const kanban = await fixturePlan('kanban-app');
  const persistence = kanban.jobs.find(job => job.key === 'persistence')!;
  assert.equal(persistence.depends_on, undefined);
  assert.ok(persistence.write_scope.includes('src/server.js') && persistence.write_scope.includes('bin/serve.js'), 'openServer and bin/serve.js come with persistence');
  assert.match(persistence.brief, /openServer/);
  const server = kanban.jobs.find(job => job.key === 'server')!;
  assert.deepEqual([...server.write_scope].sort(), ['README.md', 'src/routes/index.js', 'test/api.test.js']);
  assert.equal(server.depends_on!.length, 7);
});

test('kanban-app check: src/routes/index.js may export an array, an object of functions, or a nested array of the seven register functions', async () => {
  const [a, b, c, d, e, f, g] = Array.from({ length: 7 }, (_, index) => function register() { return index; });
  const list = [a!, b!, c!, d!, e!, f!, g!];
  assert.equal(registerFunctions(list).length, 7, 'an array');
  assert.equal(registerFunctions({ boards: a, columns: b, cards: c, labels: d, due: e, filters: f, export: g }).length, 7, 'an object of functions');
  assert.equal(registerFunctions([[a, b, c], [d, e], [f, g]]).length, 7, 'a nested array');
  assert.equal(registerFunctions({ routes: list }).length, 7, 'an object holding the array');
  assert.equal(registerFunctions(list.slice(0, 6)).length, 6, 'six are still six');
  assert.deepEqual([registerFunctions(undefined), registerFunctions('x'), registerFunctions({ n: 1 })], [[], [], []]);
  const source = await readFile(path.join(fixturesDir, 'kanban-app', 'check.mjs'), 'utf8');
  assert.match(source, /registerFunctions\(require\('\.\/src\/routes\/index\.js'\)\)\.length, 7/, 'the check counts register functions');
  assert.doesNotMatch(source, /routes\/index\.js'\)\.length/, 'not an array\'s length');
});

test('module-refactor: test/structure.test.js ships with the fixture, passes on the starting code, and fails a moved module that keeps a helper', async () => {
  const dir = path.join(fixturesDir, 'module-refactor');
  const plan = await fixturePlan('module-refactor');
  assert.deepEqual([...plan.jobs.find(job => job.key === 'finish')!.write_scope].sort(), ['README.md', 'src/core/index.js'], 'finish no longer writes the structure test');
  for (const job of plan.jobs) assert.ok(!job.write_scope.includes('test/structure.test.js'), `${job.key} doesn't own the structure test`);
  for (const key of ['invoices', 'payroll', 'expenses', 'subscriptions', 'reports', 'customers']) assert.match(plan.jobs.find(job => job.key === key)!.brief, /structure\.test\.js/, `${key}'s brief names the structure test`);
  const start = await node(['--test', path.join(dir, 'test', 'structure.test.js')], dir);
  assert.equal(start.code, 0, start.stdout + start.stderr);
  const copy = await mkdtemp(path.join(tmpdir(), 'hydra-structure-'));
  try {
    await cp(dir, copy, { recursive: true, filter: source => !/check\.mjs$/.test(source) });
    const invoices = path.join(copy, 'src', 'invoices.js');
    await writeFile(invoices, `const core = require('./core/money');\n${await readFile(invoices, 'utf8')}`);
    const moved = await node(['--test', path.join(copy, 'test', 'structure.test.js')], copy);
    assert.notEqual(moved.code, 0, 'invoices requires the core but still defines its helpers');
    assert.match(moved.stdout, /still defines .*parseAmount/);
    assert.match(moved.stdout, /not ok \d+ - invoices/);
    assert.doesNotMatch(moved.stdout, /not ok \d+ - payroll/, 'modules not moved yet are left alone');
  } finally { await cleanup(copy); }
});

test('module-refactor check: the index, the core\'s tests, the README and each module\'s leftover helpers are separate items', async () => {
  const dir = path.join(fixturesDir, 'module-refactor');
  const checked = await node([path.join(dir, 'check.mjs'), dir], dir);
  const result = parseCheckOutput(checked.stdout, checked.code);
  const failed = result.failed as string[];
  for (const item of ['core index re-exports every core function', 'the core has its own tests', 'the README has a section on the core', 'invoices: requires from ./core', 'invoices: keeps none of its private helpers']) assert.ok(failed.includes(item), `${item} is its own item`);
  assert.equal(failed.some((item: string) => /structure/.test(item)), false, 'the structure test is shipped, not scored');
  assert.ok(result.checks >= 15);
});

// ---- Hydra's first-pass review ----

const failBrief = [
  'Every job of plan "P" has landed on its integration branch, which you start from, but the plan\'s integration gate failed on the combined work.',
  'Fix the blocker and major findings below.',
  '',
  '### rigor-review (review) failed: The total ignores the discount.',
  '- [major] src/total.js:3: The discount is never applied.',
  '- [minor]: A name could be clearer.',
].join('\n');

test('Hydra\'s first-pass review: the final review when no fix round ran, else read from the round 1 fix job\'s brief (the gate record and the reviewer\'s reply are overwritten each round)', () => {
  assert.deepEqual(firstReviewOf({ jobKeys: ['a', 'b'], finalReview: { state: 'passed' } }), { source: 'the final gate (no fix round ran)', ran: true, passed: true });
  assert.equal(firstReviewOf({ jobKeys: ['a'], finalReview: { state: 'failed' } }).passed, false);
  assert.equal(firstReviewOf({ jobKeys: ['a'], finalReview: { state: 'notRun' } }).ran, false);
  assert.equal(firstReviewOf({ jobKeys: ['a'] }), undefined, 'no review at all');
  const first = firstReviewOf({ jobKeys: ['a', 'integration-fix-1'], fixBrief: failBrief, finalReview: { state: 'passed' } });
  assert.deepEqual([first.ran, first.passed, first.gateFailed, first.findings, first.summary], [true, false, true, { blocker: 0, major: 1, minor: 1 }, 'The total ignores the discount.'], 'failed first even though the final review passed');
  const command = firstReviewOf({ jobKeys: ['a', 'integration-fix-1'], fixBrief: '### test (command) failed: exit 1\nLast output:', finalReview: { state: 'passed' } });
  assert.deepEqual([command.ran, command.passed], [false, undefined], 'a command gate failed first, so the review never ran');
  const unknown = firstReviewOf({ jobKeys: ['a', 'integration-fix-1'], finalReview: { state: 'passed' } });
  assert.deepEqual([unknown.gateFailed, unknown.ran, unknown.passed], [true, undefined, undefined]);
});

test('the first review is read from a real fix brief, the one Hydra\'s integrationFixJob writes', () => {
  const record = { tip: 't', at: 'x', failed: true, checks: [
    { id: 'test', kind: 'command', required: true, state: 'passed', passed: true, exitCode: 0, durationMs: 1, outputTail: '' },
    { id: 'rigor-review', kind: 'review', required: true, state: 'failed', passed: false, exitCode: 0, durationMs: 1, outputTail: '', summary: 'Nope.', findings: [{ severity: 'blocker', file: 'a.js', line: 2, note: 'Broken.' }, { severity: 'major', note: 'Wrong.' }, { severity: 'minor', note: 'Meh.' }] },
  ] };
  const fix = integrationFixJob({ title: 'P', jobs: [{ key: 'a' }] }, record as never)!;
  const first = firstReviewOf({ jobKeys: ['a', fix.key], fixBrief: fix.brief, finalReview: { state: 'passed' } });
  assert.deepEqual([first.ran, first.passed, first.findings], [true, false, { blocker: 1, major: 1, minor: 1 }]);
  const view = { plan_id: 'p', state: 'done', jobs: [{ key: 'a', status: 'done' }, { key: 'integration-fix-1', status: 'done' }], integration: { landed: [], gate: { label: 'Passed', checks: [{ id: 'rigor-review', kind: 'review', state: 'passed' }] } } };
  const results = summarizeHydra({ view, wallClockSeconds: 1, passed: true, storedPlan: { jobs: [{ key: 'integration-fix-1', brief: fix.brief }] } });
  assert.equal(results.review.passed, true, 'the final review');
  assert.deepEqual([results.firstReview.passed, results.firstReview.source], [false, 'the round 1 fix brief']);
  assert.equal(summarizeHydra({ view: { ...view, jobs: [view.jobs[0]] }, wallClockSeconds: 1, passed: true }).firstReview.passed, true, 'no fix round: the final one');
});

test('the single agent\'s fix brief has the same sections as Hydra\'s fix brief', () => {
  const checks = [
    { id: 'test', kind: 'command', required: true, state: 'failed', passed: false, exitCode: 1, durationMs: 1, outputTail: 'not ok 1 - total\n  expected 3', summary: 'exit 1' },
    { id: 'rigor-review', kind: 'review', required: true, state: 'failed', passed: false, exitCode: 0, durationMs: 1, outputTail: '', summary: 'The total ignores   the discount.', findings: [{ severity: 'major', file: 'src/total.js', line: 3, note: 'The discount is never applied.' }, { severity: 'minor', note: 'A name could be clearer.' }] },
    { id: 'lint', kind: 'command', required: false, state: 'failed', passed: false, exitCode: 1, durationMs: 1, outputTail: 'x' },
    { id: 'shots', kind: 'review', required: true, state: 'notRun', passed: false, exitCode: null, durationMs: 0, outputTail: '' },
  ];
  const sections = (brief: string) => brief.slice(brief.indexOf('\n\n') + 2).split('\n').slice(1).join('\n');
  const single = singleFixBrief('Shop features', checks) as string;
  const hydra = integrationFixJob({ title: 'Shop features', jobs: [{ key: 'a' }] }, { tip: 't', at: 'x', failed: true, checks } as never)!.brief;
  assert.ok(sections(hydra).length > 0);
  assert.equal(single.slice(single.indexOf('### test')), hydra.slice(hydra.indexOf('### test')), 'the gates that failed, their findings and their last output: the same text');
  assert.match(single, /^You finished the work on plan "Shop features"/);
  assert.match(single, /Fix the blocker and major findings below/);
  assert.equal(singleFixBrief('P', [{ id: 'test', kind: 'command', required: true, state: 'passed', passed: true }]), undefined, 'nothing failed, nothing to fix');
  assert.ok((singleFixBrief('P', Array.from({ length: 40 }, (_, index) => ({ id: `c${index}`, kind: 'command', required: true, state: 'failed', passed: false, outputTail: 'x'.repeat(1400) }))) as string).length <= 4000, 'clipped as Hydra\'s is');
  assert.equal(singleClaudeArgs({ settingsFile: 's', mcpConfigFile: 'm', resume: 'sess' }).slice(-2).join(' '), '--resume sess');
  assert.equal(singleClaudeArgs({ settingsFile: 's', mcpConfigFile: 'm' }).includes('--resume'), false);
});

// ---- the single agent's fix loop, with a stand-in agent and reviewer ----

/** A run folder like a finished single run: a repository with a passing gate and uncommitted work, results, and the isolation files. */
async function singleRun(out: string, extra: Record<string, unknown> = {}): Promise<string> {
  const repo = path.join(out, 'single');
  await mkdir(repo, { recursive: true });
  await writeFile(path.join(repo, 'total.js'), 'module.exports = cents => cents;\n');
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --version' } }));
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@hydra.invalid');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'fixture');
  await writeFile(path.join(repo, 'total.js'), 'module.exports = (cents, off = 0) => cents - off;\n');
  await writeFile(path.join(out, 'single-results.json'), JSON.stringify({ version: 1, kind: 'single', fixture: 'shop', task: 'shop-features', agent: 'claude', wallClockSeconds: 300, agentExitCode: 0, gate: { passed: true, outputTail: '' }, cost: { usd: 2 }, sessionId: 'sess-1', ...extra }));
  await writeFile(path.join(out, 'single-settings.json'), '{}');
  await writeFile(path.join(out, 'single-mcp.json'), '{"mcpServers":{}}');
  return repo;
}
const fixCommand = `"${process.execPath}" "${fakeFixer}"`;
const reviewer = (mode: string) => `"${process.execPath}" "${fakeReviewer}" ${mode}`;

test('review --fix-rounds: a failed first review resumes the agent with the findings, then reviews again; time and cost of the fix count in the single run', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'hydra-bench-'));
  try {
    const repo = await singleRun(out);
    const ran = await node([script, 'review', '--results', out, '--reviewer-command', reviewer('fail-first'), '--claude', fixCommand]);
    assert.equal(ran.code, 0, ran.stderr + ran.stdout);
    const results = JSON.parse(await readFile(path.join(out, 'single-results.json'), 'utf8'));
    assert.equal(results.review.verdict, 'pass', 'the final review is the second');
    assert.deepEqual(results.review.firstPass, { verdict: 'fail', ran: true, passed: false, findings: { blocker: 0, major: 1, minor: 1 } });
    assert.deepEqual([results.review.fixRounds, results.review.fixRoundsAllowed, results.review.passedWithinRounds], [1, 2, true]);
    assert.equal(results.review.fixes.length, 1);
    assert.equal(results.review.fixes[0].usd, 0.5);
    assert.equal(typeof results.review.fixSeconds, 'number');
    assert.deepEqual([results.cost.usd, results.cost.fixUsd], [2, 0.5], 'the fix round\'s cost is in the single run');
    assert.deepEqual(results.review.afterFix, { gatePassed: true }, 'the fixed repository\'s gate ran again');
    // The agent was resumed with the fix brief, in Hydra's format.
    const brief = await readFile(path.join(out, 'fake-fix-brief-1.md'), 'utf8');
    assert.match(brief, /^You finished the work on plan "Shop features"/);
    assert.match(brief, /### rigor-review \(review\) failed: .*The total ignores the discount./);
    assert.match(brief, /- \[major\] src\/total\.js:3: The discount is never applied\./);
    const args = JSON.parse(await readFile(path.join(out, 'fake-fix-args-1.json'), 'utf8')) as string[];
    assert.deepEqual(args.slice(args.indexOf('--resume')), ['--resume', 'sess-1']);
    assert.ok(args.includes('--strict-mcp-config') && args.includes('--settings'), 'the same isolation as the first run');
    // The second review saw the fix.
    assert.match(await readFile(path.join(out, 'fake-reviewer-prompt.md'), 'utf8'), /fix round 1/);
    assert.match(git(repo, 'log', '--format=%s'), /fix round 1/);
    const record = JSON.parse(await readFile(path.join(out, 'single-review.json'), 'utf8'));
    assert.deepEqual([record.rounds.length, record.fixRounds, record.verdict], [2, 1, 'pass']);
    assert.ok(ran.stdout.includes('fix round 1 of 2'));
  } finally { await cleanup(out); }
});

test('review --fix-rounds: at most N rounds (default 2), 0 for none, and the review that still fails stays failed', async () => {
  for (const [args, mode, fixes, verdict, passedWithin] of [
    [[], 'fail-twice', 2, 'pass', true],
    [[], 'fail', 2, 'fail', false],
    [['--fix-rounds', '1'], 'fail-twice', 1, 'fail', false],
    [['--fix-rounds', '0'], 'fail', 0, 'fail', false],
  ] as const) {
    const out = await mkdtemp(path.join(tmpdir(), 'hydra-bench-'));
    try {
      await singleRun(out);
      const ran = await node([script, 'review', '--results', out, ...args, '--reviewer-command', reviewer(mode), '--fix-command', fixCommand]);
      assert.equal(ran.code, 0, `${args.join(' ')} ${mode}: ${ran.stderr}`);
      const results = JSON.parse(await readFile(path.join(out, 'single-results.json'), 'utf8'));
      assert.deepEqual([results.review.fixRounds, results.review.verdict, results.review.passedWithinRounds], [fixes, verdict, passedWithin], `${args.join(' ')} ${mode}`);
      assert.equal(results.review.firstPass.verdict, 'fail');
      if (fixes === 0) assert.equal(results.review.fixSeconds, undefined);
      else assert.equal(results.cost.fixUsd, 0.5 * fixes);
    } finally { await cleanup(out); }
  }
  const out = await mkdtemp(path.join(tmpdir(), 'hydra-bench-'));
  try {
    await singleRun(out);
    const bad = await node([script, 'review', '--results', out, '--fix-rounds', 'two']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /--fix-rounds is a whole number/);
  } finally { await cleanup(out); }
});

test('review --fix-rounds: a first review that passes needs no fix, and an agent that can\'t be resumed or fails is recorded, not fatal', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'hydra-bench-'));
  try {
    await singleRun(out);
    assert.equal((await node([script, 'review', '--results', out, '--reviewer-command', reviewer('pass'), '--fix-command', fixCommand])).code, 0);
    const passed = JSON.parse(await readFile(path.join(out, 'single-results.json'), 'utf8'));
    assert.deepEqual([passed.review.firstPass.passed, passed.review.fixRounds, passed.review.passedWithinRounds, passed.cost.fixUsd], [true, 0, true, undefined]);
  } finally { await cleanup(out); }
  const noSession = await mkdtemp(path.join(tmpdir(), 'hydra-bench-'));
  try {
    await singleRun(noSession, { sessionId: undefined });
    const ran = await node([script, 'review', '--results', noSession, '--reviewer-command', reviewer('fail')]);
    assert.equal(ran.code, 0, ran.stderr);
    const results = JSON.parse(await readFile(path.join(noSession, 'single-results.json'), 'utf8'));
    assert.match(results.review.fixSkipped, /no session id/);
    assert.deepEqual([results.review.fixRounds, results.review.verdict], [0, 'fail']);
  } finally { await cleanup(noSession); }
  const broken = await mkdtemp(path.join(tmpdir(), 'hydra-bench-'));
  try {
    await singleRun(broken);
    const ran = await node([script, 'review', '--results', broken, '--reviewer-command', reviewer('fail'), '--fix-command', `${fixCommand} fail`]);
    assert.equal(ran.code, 0, ran.stderr);
    const results = JSON.parse(await readFile(path.join(broken, 'single-results.json'), 'utf8'));
    assert.match(results.review.fixSkipped, /the agent failed: not signed in/);
    assert.equal(results.review.verdict, 'fail');
  } finally { await cleanup(broken); }
});

test('withReviewLoop: the first pass and the final review, the fix rounds, and the fix cost, without touching the agent\'s own cost', () => {
  const review = (verdict: string, durationSeconds: number, findings: { severity: string; note: string }[] = []) => ({ verdict, durationSeconds, gatesPassed: verdict !== 'fail', findings, ...(verdict === 'not run' ? {} : { reviewer: 'codex' }) });
  const single = { kind: 'single', wallClockSeconds: 100, cost: { usd: 2, fixUsd: 99 } };
  const looped = withReviewLoop(single, { rounds: [{ review: review('fail', 60, [{ severity: 'major', note: 'a' }]), fix: { seconds: 40, usd: 0.25, exitCode: 0 } }, { review: review('pass', 30) }], after: { gatePassed: true, checkPassed: true } });
  assert.deepEqual(looped.cost, { usd: 2, fixUsd: 0.25 }, 'a stale fixUsd from an earlier run is dropped');
  assert.deepEqual([looped.review.verdict, looped.review.passed, looped.review.durationSeconds, looped.review.fixSeconds, looped.review.fixRounds], ['pass', true, 90, 40, 1]);
  assert.deepEqual(looped.review.firstPass, { verdict: 'fail', ran: true, passed: false, findings: { blocker: 0, major: 1, minor: 0 } });
  const notRun = withReviewLoop(single, { rounds: [{ review: review('not run', 5) }] });
  assert.deepEqual([notRun.review.firstPass.ran, notRun.review.passed, notRun.review.passedWithinRounds], [false, undefined, false]);
});

// ---- the summary's columns ----

const reviewResult = (verdict: 'pass' | 'fail', firstPass: 'pass' | 'fail', extra: Record<string, unknown> = {}) => ({
  verdict, passed: verdict === 'pass', ran: true, gatesPassed: true, durationSeconds: 120, findings: { blocker: 0, major: 0, minor: 0 },
  firstPass: { verdict: firstPass, ran: true, passed: firstPass === 'pass', findings: { blocker: 0, major: 0, minor: 0 } }, fixRounds: 1, fixRoundsAllowed: 2, passedWithinRounds: verdict === 'pass', fixSeconds: 200, ...extra,
});

test('summarize reports first-pass review, final review, passed within N rounds, and time to working code before and after the review loop, for both setups', () => {
  const single = { kind: 'single', task: 'cli', wallClockSeconds: 600, gate: { passed: true }, check: { passed: true }, cost: { usd: 3, fixUsd: 0.5 }, review: reviewResult('pass', 'fail', { afterFix: { gatePassed: true, checkPassed: true } }) };
  const hydra = { kind: 'hydra', task: 'cli', wallClockSeconds: 1500, timeToWorkingCodeSeconds: 700, integrationGate: { passed: true, checks: [] }, check: { passed: true }, review: { state: 'passed' }, firstReview: { ran: true, passed: false }, fixRounds: 1, jobs: [{ key: 'a' }, { key: 'integration-fix-1' }], cost: { usd: 4, usdJobs: 2, fixUsd: 0.5 } };
  const rows = [...runRows(single, 'r1-single'), ...runRows(hydra, 'r1-hydra')];
  const byRow: Record<string, any> = Object.fromEntries(rows.map((row: { setup: string }) => [row.setup, row]));
  assert.deepEqual([byRow['single+review'].workSeconds, byRow['single+review'].workAfterSeconds, byRow['single+review'].totalSeconds], [600, 920, 920], 'before: the agent\'s run; after: plus the review (120) and the fix (200)');
  assert.deepEqual([byRow.hydra.workSeconds, byRow.hydra.workAfterSeconds, byRow.hydra.totalSeconds], [700, 1500, 1500], 'before: the last own job landed; after: the gate settled');
  assert.deepEqual([byRow['single+review'].firstReviewPassed, byRow['single+review'].reviewPassed, byRow['single+review'].passedWithin], [false, true, true]);
  assert.deepEqual([byRow.hydra.firstReviewPassed, byRow.hydra.reviewPassed, byRow.hydra.passedWithin], [false, true, true]);
  assert.equal(byRow['single+review'].usd, 3.5, 'the single agent\'s cost includes its fix round');
  assert.equal(byRow.single.usd, 3, 'the run before any review is the agent\'s own');
  const markdown = renderSummary(rows);
  const lines = markdown.split('\n');
  assert.equal(lines[0], '| Task | Setup | Runs | Working code, before the review loop | Working code, after the review loop | Total time | Cost (agent work, fix rounds included) | Gate passed | First-pass review | Final review | Passed within 2 fix rounds | Fix rounds | Check passed |');
  assert.equal(lines[2], '| cli | single | 1 | 10m 00s | – | 10m 00s | $3.00 | 1/1 | – | – | – | – | 1/1 |');
  assert.equal(lines[3], '| cli | single+review | 1 | 10m 00s | 15m 20s | 15m 20s | $3.50 | 1/1 | 0/1 | 1/1 | 1/1 | 1 | 1/1 |');
  assert.equal(lines[4], '| cli | hydra | 1 | 11m 40s | 25m 00s | 25m 00s | $4.00 | 1/1 | 0/1 | 1/1 | 1/1 | 1 | 1/1 |');
  assert.match(markdown, /Cost counts the agent's work and its fix rounds on both sides/);
  assert.ok(markdown.includes('| Run | Task | Setup | Working code (before review loop) | Working code (after review loop) | Total | Cost | Gate | First-pass review | Final review | Fix rounds | Check |'));
  assert.ok(markdown.includes('| r1-hydra | cli | hydra | 11m 40s | 25m 00s | 25m 00s | $4.00 | passed | failed | passed | 1 | passed |'), markdown);
});

test('summarize: a fix that broke the code loses the after-loop time, an old single review is one review with no rounds, and an old Hydra result reads its first review from the store', () => {
  const single = { kind: 'single', task: 'cli', wallClockSeconds: 600, gate: { passed: true }, check: { passed: true }, cost: { usd: 3 } };
  const broke = runRows({ ...single, review: reviewResult('pass', 'fail', { afterFix: { gatePassed: true, checkPassed: false } }) }, 'r')[1];
  assert.deepEqual([broke.workSeconds, broke.workAfterSeconds, broke.checkPassed], [600, null, false]);
  const old = runRows({ ...single, review: { verdict: 'fail', passed: false, ran: true, durationSeconds: 100 } }, 'r')[1];
  assert.deepEqual([old.firstReviewPassed, old.reviewPassed, old.fixRounds, old.passedWithin, old.totalSeconds], [false, false, 0, false, 700]);
  const oldHydra = { kind: 'hydra', task: 'cli', wallClockSeconds: 900, timeToWorkingCodeSeconds: 300, integrationGate: { passed: true, checks: [] }, review: { state: 'passed' }, jobs: [{ key: 'a' }, { key: 'integration-fix-1' }, { key: 'integration-fix-2' }], cost: { usd: 1, usdJobs: 1 } };
  assert.equal(runRows(oldHydra, 'r')[0].firstReviewPassed, undefined, 'the fix brief is not known');
  assert.equal(runRows(oldHydra, 'r', { fixBrief: failBrief })[0].firstReviewPassed, false, 'from the plan store');
  const [row] = runRows(oldHydra, 'r', { fixBrief: '### test (command) failed: x' });
  assert.deepEqual([row.firstReviewPassed, row.firstReviewNotRun], [undefined, true]);
  const markdown = renderSummary(runRows(oldHydra, 'r', { fixBrief: '### test (command) failed: x' }));
  assert.ok(markdown.includes('| 0/0; 1 not run |') || markdown.includes('| –; 1 not run |'), markdown);
});

test('benchmark.mjs summarize fills an old Hydra result\'s first-pass review from the plan store', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'hydra-bench-'));
  try {
    await mkdir(path.join(out, 'run-1'));
    await writeFile(path.join(out, 'run-1', 'hydra-results.json'), JSON.stringify({ kind: 'hydra', task: 'cli', planId: 'abc123abc123', wallClockSeconds: 900, timeToWorkingCodeSeconds: 300, integrationGate: { passed: true, checks: [] }, review: { state: 'passed' }, fixRounds: 1, jobs: [{ key: 'a' }, { key: 'integration-fix-1' }], cost: { usd: 1, usdJobs: 1 } }));
    await writeFile(path.join(out, 'plans.json'), JSON.stringify({ version: 1, plans: [{ id: 'abc123abc123', startedAt: '2026-09-28T10:00:00.000Z', jobs: [{ key: 'a' }, { key: 'integration-fix-1', brief: failBrief }] }] }));
    const ran = await node([script, 'summarize', '--runs', path.join(out, 'run-1'), '--plan-store', path.join(out, 'plans.json')]);
    assert.equal(ran.code, 0, ran.stderr);
    const summary = await readFile(path.join(out, 'summary.md'), 'utf8');
    assert.ok(summary.includes('| cli | hydra | 1 | 5m 00s | 15m 00s | 15m 00s | $1.00 | 1/1 | 0/1 | 1/1 | 1/1 | 1 | – |'), summary);
  } finally { await cleanup(out); }
});

test('a review the gate retried once is recorded on both sides and listed under the summary', () => {
  const retriedCheck = { id: 'rigor-review', kind: 'review', state: 'passed', required: true, durationMs: 1000, summary: 'Retried once: the first review didn\'t run. Reviewed by Codex. Fine.', retriedAfter: 'Codex exited with code 1.' };
  const reviewed = summarizeReview({ checks: [retriedCheck], durationMs: 1000, startedAt: 'x', base: 'b', head: 'h' });
  assert.equal(reviewed.retried, true);
  assert.equal(summarizeReview({ checks: [{ ...retriedCheck, retriedAfter: undefined, summary: 'Reviewed by Codex. Fine.' }], durationMs: 1000, startedAt: 'x', base: 'b', head: 'h' }).retried, undefined);
  const looped = withReviewLoop({ kind: 'single', wallClockSeconds: 100, cost: { usd: 1 } }, { rounds: [{ review: reviewed }] });
  assert.equal(looped.review.retried, 1);
  const single = { kind: 'single', task: 'cli', wallClockSeconds: 600, gate: { passed: true }, check: { passed: true }, cost: { usd: 3 }, review: looped.review };
  // Hydra: every round's review counts, the earlier ones read from the fix briefs that quote them (plan views keep only the summary).
  assert.equal(hydraReviewsRetried([`### rigor-review (review) failed: ${retriedCheck.summary.replace('Fine.', 'Broken.')}`, '### rigor-review (review) failed: Reviewed by Codex. Broken.'], { summary: retriedCheck.summary }), 2);
  assert.equal(hydraReviewsRetried([], { summary: 'Reviewed by Codex. Fine.' }), 0);
  const hydra = { kind: 'hydra', task: 'cli', wallClockSeconds: 900, timeToWorkingCodeSeconds: 300, integrationGate: { passed: true, checks: [] }, review: { state: 'passed' }, reviewsRetried: 1, jobs: [{ key: 'a' }], cost: { usd: 1, usdJobs: 1 } };
  const rows = [...runRows(single, 'r1-single'), ...runRows(hydra, 'r1-hydra')];
  assert.deepEqual(rows.map((row: { setup: string; reviewRetried?: number }) => [row.setup, row.reviewRetried]), [['single', undefined], ['single+review', 1], ['hydra', 1]]);
  assert.match(renderSummary(rows), /^Reviews retried once after the reviewer failed to run: r1-single \(single\+review\), r1-hydra \(hydra\)\.$/m);
  assert.doesNotMatch(renderSummary(runRows({ ...single, review: reviewResult('pass', 'pass') }, 'r')), /Reviews retried once/);
});

test('summarizeSingle keeps the Claude Code session id, so review can resume the agent', () => {
  assert.equal(summarizeSingle({ agent: 'claude', wallClockSeconds: 1, exitCode: 0, gatePassed: true, gateOutput: '', agentOutput: { session_id: 'abc' } }).sessionId, 'abc');
  assert.equal('sessionId' in summarizeSingle({ agent: 'claude', wallClockSeconds: 1, exitCode: 0, gatePassed: true, gateOutput: '', agentOutput: {} }), false);
  const review = summarizeReview({ checks: [], durationMs: 1000, startedAt: 'x', base: 'b', head: 'h' });
  assert.equal(review.verdict, 'not run');
});

// ---- lighter polling ----

test('polling: every 10 seconds by default, backing off while the plan is steady and back to the base when it changes', () => {
  assert.equal(defaultPollSeconds, 10);
  const base = defaultPollSeconds * 1000;
  assert.deepEqual([0, 1, 2].map(steady => pollDelayMs(base, steady)), [10_000, 10_000, 10_000]);
  assert.deepEqual([3, 5].map(steady => pollDelayMs(base, steady)), [15_000, 15_000]);
  assert.deepEqual([6, 8].map(steady => pollDelayMs(base, steady)), [20_000, 20_000]);
  assert.deepEqual([9, 50].map(steady => pollDelayMs(base, steady)), [30_000, 30_000], 'capped at three times the base');
  assert.equal(pollDelayMs(10, 0), 10, 'a test\'s tiny interval is honoured');
  const view = { state: 'running', jobs: [{ key: 'a', status: 'active', head: { job_id: 'h1', state: 'running', attempts: 1 } }], integration: { landed: [], gate: undefined } };
  assert.equal(planSignature(view), planSignature(JSON.parse(JSON.stringify(view))), 'the same plan is steady');
  const changed = [
    { ...view, state: 'done' }, { ...view, jobs: [{ ...view.jobs[0], status: 'done' }] }, { ...view, jobs: [{ ...view.jobs[0], head: { ...view.jobs[0]!.head, job_id: 'h2' } }] },
    { ...view, integration: { landed: ['a'], gate: undefined } }, { ...view, integration: { landed: [], gate: { label: 'Passed' } } }, { ...view, amendments: [{}] },
  ];
  for (const other of changed) assert.notEqual(planSignature(other), planSignature(view));
});

test('benchmark.mjs hydra polls at the interval it is given and says so, and warns about an interval under 10 seconds', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'hydra-bench-'));
  try {
    const repo = path.join(out, 'hydra');
    await mkdir(repo, { recursive: true });
    const ran = await node([script, 'hydra', '--repo', repo, '--poll', '0.01', '--plan-store', path.join(out, 'no-plans.json'), '--hydra', `"${process.execPath}" "${fakeHydra}"`]);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /Polling every 0\.01s: under 10s makes Hydra check its process table/);
    assert.match(ran.stdout, /watching it every 0\.01s, less often while nothing changes/);
    assert.match(ran.stdout, /Using hydra: .* \(--hydra\)/);
  } finally { await cleanup(out); }
});

// ---- default install locations ----

test('tool defaults: the flag, then PATH, then the usual install location, then the bare name; each says which', () => {
  const env = { USERPROFILE: 'C:\\Users\\n', LOCALAPPDATA: 'C:\\Users\\n\\AppData\\Local', APPDATA: 'C:\\Users\\n\\AppData\\Roaming', PATH: 'C:\\bin;C:\\tools' };
  assert.deepEqual(defaultToolLocations('claude', env, 'win32'), ['C:\\Users\\n\\.local\\bin\\claude.exe']);
  assert.deepEqual(defaultToolLocations('hydra', env, 'win32'), ['C:\\Users\\n\\AppData\\Local\\Programs\\Hydra\\bin\\hydra.cmd']);
  assert.deepEqual(defaultToolLocations('codex', env, 'win32'), ['C:\\Users\\n\\AppData\\Roaming\\npm\\codex.cmd', 'C:\\Users\\n\\AppData\\Roaming\\npm\\codex.exe']);
  assert.deepEqual(defaultToolLocations('codex', {}, 'win32'), []);
  assert.deepEqual(defaultToolLocations('claude', { HOME: '/home/n' }, 'linux'), ['/home/n/.local/bin/claude']);
  const files = new Set<string>();
  const exists = (file: string) => files.has(file);
  const where = (name: string, flag?: string) => resolveTool(name, { flag, env, platform: 'win32', exists });
  assert.deepEqual(where('claude', 'D:\\mine\\claude.exe'), { command: 'D:\\mine\\claude.exe', source: '--claude', explicit: true });
  files.add('C:\\Users\\n\\.local\\bin\\claude.exe');
  const found = where('claude');
  assert.equal(found.command, 'C:\\Users\\n\\.local\\bin\\claude.exe');
  assert.match(found.source, /^default install location/);
  files.add('C:\\tools\\claude.cmd');
  assert.deepEqual([where('claude').command, where('claude').onPath], ['claude', true], 'on PATH wins over the install location');
  assert.match(where('claude').source, /^PATH \(C:\\tools\\claude\.cmd\)/);
  files.add('C:\\Users\\n\\AppData\\Roaming\\npm\\codex.cmd');
  assert.equal(where('codex').command, 'C:\\Users\\n\\AppData\\Roaming\\npm\\codex.cmd');
  files.add('C:\\Users\\n\\AppData\\Local\\Programs\\Hydra\\bin\\hydra.cmd');
  assert.equal(where('hydra').command, 'C:\\Users\\n\\AppData\\Local\\Programs\\Hydra\\bin\\hydra.cmd');
  const missing = resolveTool('hydra', { env: { PATH: '' }, platform: 'win32', exists: () => false });
  assert.deepEqual([missing.command, missing.missing], ['hydra', true]);
  assert.match(missing.source, /not found/);
  assert.equal(resolveTool('claude', { env: { PATH: '/a:/b', HOME: '/h' }, platform: 'linux', exists: (file: string) => file === '/b/claude' }).command, 'claude');
});

test('benchmark.mjs hydra without --hydra uses Hydra\'s install location when hydra isn\'t on PATH, and logs it', { skip: process.platform !== 'win32' }, async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'hydra-bench-'));
  try {
    const home = path.join(out, 'local');
    await mkdir(path.join(home, 'Programs', 'Hydra', 'bin'), { recursive: true });
    await writeFile(path.join(home, 'Programs', 'Hydra', 'bin', 'hydra.cmd'), `@"${process.execPath}" "${fakeHydra}" %*\r\n`);
    const repo = path.join(out, 'hydra');
    await mkdir(repo, { recursive: true });
    const env = { ...process.env, LOCALAPPDATA: home, PATH: path.join(out, 'empty') };
    const ran = await node([script, 'hydra', '--repo', repo, '--poll', '0.01', '--plan-store', path.join(out, 'no-plans.json')], root, env);
    assert.equal(ran.code, 0, ran.stderr + ran.stdout);
    assert.match(ran.stdout, /Using hydra: .*hydra\.cmd \(default install location/);
    assert.equal(JSON.parse(await readFile(path.join(out, 'hydra-results.json'), 'utf8')).planState, 'done');
  } finally { await cleanup(out); }
});
