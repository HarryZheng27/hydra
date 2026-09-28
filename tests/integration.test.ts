import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git, gitRun } from '../src/core/git';
import { createPlan, PlanStore, applyPlanAmendment, planJobBriefMax, type Plan, type PlanJob } from '../src/core/plans';
import { PlanRunner, planHeadInput, type PlanHeadLook, type PlanLook, type PlanRunnerOptions } from '../src/core/planRunner';
import {
  applyLanding, conflictSection, ensureIntegrationBranch, integrationBranch, integrationGates, integrationLeadView, integrationSettled, landCommit, mergeRefusal, newIntegration, reconcile,
  integrationFixJob, laneMergeRefusal, reconcileFacts, releaseConflict, withGateWorktree, type IntegrationGateRecord, type PlanIntegration,
} from '../src/core/integration';
import { parseGatesConfig, runGateList } from '../src/core/gates';
import { JobStore, gatesConfigured, type JobCheckResult } from '../src/core/jobs';
import { HelperEndpoint, callHelperEndpoint } from '../src/core/helperEndpoint';
import { HelperService, type PlanLeadBridge, type PlanLeadPlan } from '../src/core/helperService';
import type { DependencyResult } from '../src/core/headStart';

/**
 * O3: the integration branch and the integration gate (docs/Heads.md, "Landing a plan together").
 * Everything git-shaped here runs against a real temporary repository: commits are made with git's
 * plumbing (a temporary index, never a worktree), and the plan runner lands them for real.
 */

const sha = (fill: string) => fill.repeat(40);
let counter = 0;

async function repoFixture(files: Record<string, string>) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hydra-integration-')));
  const repo = path.join(root, 'repo');
  await git(root, ['init', '-q', '-b', 'main', repo]);
  await git(repo, ['config', 'user.email', 'test@example.invalid']); await git(repo, ['config', 'user.name', 'Test']);
  for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(repo, file)), { recursive: true }); await writeFile(path.join(repo, file), text); }
  await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'init']);
  const base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  /** A commit on `parent` that sets these files, made without any worktree. */
  const commitFrom = async (parent: string, changes: Record<string, string>, message: string): Promise<string> => {
    const index = path.join(root, `index-${++counter}`);
    const env = { GIT_INDEX_FILE: index };
    await git(repo, ['read-tree', parent], env);
    for (const [file, text] of Object.entries(changes)) {
      const temporary = path.join(root, `blob-${++counter}`);
      await writeFile(temporary, text);
      const blob = (await git(repo, ['hash-object', '-w', temporary])).trim();
      await git(repo, ['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], env);
    }
    const tree = (await git(repo, ['write-tree'], env)).trim();
    return (await git(repo, ['commit-tree', tree, '-p', parent, '-m', message])).trim();
  };
  const show = async (commit: string, file: string) => (await gitRun(repo, ['show', `${commit}:${file}`])).stdout;
  const tip = async (branch: string) => (await git(repo, ['rev-parse', `refs/heads/${branch}`])).trim();
  const isAncestor = async (a: string, b: string) => (await gitRun(repo, ['merge-base', '--is-ancestor', a, b])).code === 0;
  return { root, repo, base, commitFrom, show, tip, isAncestor, close: () => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) };
}
type Repo = Awaited<ReturnType<typeof repoFixture>>;

const passed = (id = 'unit'): JobCheckResult => ({ id, kind: 'command', state: 'passed', required: true, passed: true, exitCode: 0, durationMs: 1, outputTail: '' });
const failedCheck = (id = 'unit'): JobCheckResult => ({ id, kind: 'command', state: 'failed', required: true, passed: false, exitCode: 1, durationMs: 1, outputTail: 'boom' });
const passingGate: NonNullable<PlanRunnerOptions['integration']>['runGate'] = async () => ({ checks: [passed()], configured: 'file' });

/** The project's real command gate run on the integrated tree: the same two calls HelperService.runIntegrationGate makes. */
function commandGate(repo: Repo, command: string[]) {
  return async (plan: Pick<Plan, 'id'> & { integration?: PlanIntegration }, tip: string) => {
    const config = parseGatesConfig({ gates: [{ id: 'unit', type: 'command', command }] });
    const { gates, notRun } = integrationGates({ ...config }, false);
    const logDirectory = path.join(repo.root, 'logs', `${++counter}`);
    const checks = await withGateWorktree(repo.repo, path.join(repo.root, 'worktrees'), plan.id, tip, worktree => runGateList(gates, worktree, plan.integration?.base ?? tip, { author: 'claude', logDirectory }));
    return { checks: [...checks, ...notRun], configured: gatesConfigured('gates', gates.length) };
  };
}

interface Started { key: string; id: string; dependsOn: string[]; inputs: DependencyResult[]; start?: { baseCommit: string; carry?: string }; brief: string }
const headJob = (key: string, extra: Partial<PlanJob> = {}): PlanJob => ({ key, title: `Job ${key}`, brief: `Do ${key}.`, dependsOn: [], runAs: 'head', ...extra });

/** A plan runner over a real repository, with fake heads that a test finishes with real commits. */
async function planFixture(repo: Repo, jobs: PlanJob[], options: { runGate?: NonNullable<PlanRunnerOptions['integration']>['runGate']; attempts?: number; fixRounds?: number; directory?: string; now?: () => Date; hooks?: Pick<PlanRunnerOptions, 'onSettled' | 'onGateDone'> } = {}) {
  const directory = options.directory ?? path.join(repo.root, `plans-${++counter}`);
  const heads = new Map<string, PlanHeadLook>();
  const started: Started[] = [];
  let ids = 0;
  const look: PlanLook = { head: id => heads.get(id), lane: () => undefined, planLanes: () => [], lanesAvailable: () => true };
  const makeRunner = (store: PlanStore) => new PlanRunner({
    store, look, repository: repo.repo,
    startHead: async (plan, job, dependsOn, inputs, start) => {
      const id = (++ids).toString(16).padStart(12, '0');
      started.push({ key: job.key, id, dependsOn, inputs, ...(start ? { start } : {}), brief: String(planHeadInput(plan, job, dependsOn).brief) });
      heads.set(id, { state: 'running', title: job.title, branch: `agent/${job.key}-${id}` });
      return { jobId: id };
    },
    startLane: async () => { throw new Error('no lanes here'); },
    cancelHead: async id => { const head = heads.get(id); if (head) head.state = 'cancelled'; },
    unlinkLane: async () => undefined,
    commitSubjects: async () => [], changedFiles: async () => [],
    terminalsAvailable: () => true, debounceMs: 1,
    ...(options.now ? { now: options.now } : {}), ...options.hooks,
    // Automatic fixes are off unless a test asks for them, so each test sees one gate run of its own.
    integration: { runGate: options.runGate ?? passingGate, fixRounds: () => options.fixRounds ?? 0, ...(options.attempts ? { attempts: options.attempts } : {}) },
  });
  let store = new PlanStore(directory);
  await store.load();
  const plan = await store.save({ ...createPlan({ title: 'Checkout' }), jobs });
  let runner = makeRunner(store);
  const get = () => store.get(plan.id)!;
  const startedFor = (key: string) => started.filter(item => item.key === key);
  const jobId = (key: string) => get().jobs.find(item => item.key === key)!.jobId!;
  /** A head reports done with this commit, and the runner hears of it. */
  const finish = async (key: string, commit: string) => {
    const head = heads.get(jobId(key))!;
    head.state = 'done'; head.result = { commit, summary: `${key} is done.`, changedFiles: [] };
    await runner.advance(plan.id);
  };
  const status = (key: string) => runner.statuses(plan.id)!.find(item => item.key === key)!;
  /** Hydra restarts: a fresh store read from disk, and a fresh runner; the heads' own store (this map) survives, as jobs.json does. */
  const restart = async () => { runner.dispose(); store = new PlanStore(directory); await store.load(); runner = makeRunner(store); return runner; };
  return { plan, directory, heads, started, startedFor, get, finish, status, restart, get runner() { return runner; }, get store() { return store; }, dispose: () => runner.dispose() };
}

// ---- Pure: the queue's decisions ----

test('applyLanding (O3): a landing moves the tip and records it; a conflict re-queues the job for another try, then holds it once its tries run out', () => {
  const integration = { ...newIntegration('aaaaaaaaaaaa', sha('a')), queue: [{ key: 'api', attempt: 0, commit: sha('b'), at: '2026-09-27T00:00:00.000Z' }] };
  const jobs: PlanJob[] = [headJob('api', { jobId: '000000000001' })];
  const landed = applyLanding({ integration, jobs }, integration.queue[0]!, { kind: 'landed', tip: sha('c'), via: 'merge' });
  assert.equal(landed.integration.tip, sha('c'));
  assert.deepEqual(landed.integration.queue, []);
  assert.deepEqual(landed.integration.landed.map(entry => [entry.key, entry.attempt, entry.commit, entry.via]), [['api', 0, sha('b'), 'merge']]);

  const first = applyLanding({ integration, jobs }, integration.queue[0]!, { kind: 'conflict', files: ['src/api.ts'] });
  assert.equal(first.integration.tip, sha('a'), 'a conflict never moves the branch');
  assert.deepEqual(first.integration.queue, []);
  const retried = first.jobs[0]!;
  assert.equal(retried.jobId, undefined, 'the job runs again');
  assert.equal(retried.attempt, 1, 'and spends a try');
  assert.deepEqual(retried.conflict && [retried.conflict.files, retried.conflict.commit, retried.conflict.count, retried.conflict.held], [['src/api.ts'], sha('b'), 1, undefined]);

  // Its third conflict (of three tries) holds it for the lead instead.
  const third = applyLanding({ integration: { ...integration, queue: [{ key: 'api', attempt: 2, commit: sha('d'), at: '2026-09-27T00:00:00.000Z' }] }, jobs: [headJob('api', { jobId: '000000000003', attempt: 2, conflict: { files: ['src/api.ts'], commit: sha('b'), tip: sha('a'), count: 2, at: '2026-09-27T00:00:00.000Z' } })] },
    { key: 'api', attempt: 2, commit: sha('d') }, { kind: 'conflict', files: ['src/api.ts', 'src/db.ts'] });
  assert.equal(third.jobs[0]!.conflict?.held, true);
  assert.equal(third.jobs[0]!.jobId, '000000000003', 'a held job keeps its head, for the lead to look at');
  assert.deepEqual(third.jobs[0]!.conflict?.files, ['src/api.ts', 'src/db.ts']);
  assert.deepEqual(releaseConflict(third.jobs[0]!.conflict), { files: ['src/api.ts', 'src/db.ts'], commit: sha('d'), tip: sha('a'), count: 0, at: third.jobs[0]!.conflict!.at }, 'a retry gives it a fresh set of tries');
});

test('reconcile (O3): the recorded queue and the real branch — landed before a restart, never moved, gained commits, moved away, or deleted', () => {
  const flight = { key: 'api', attempt: 0, commit: sha('b'), from: sha('a'), at: '2026-09-27T00:00:00.000Z' };
  assert.deepEqual(reconcile({ tip: sha('a') }, { actual: sha('a'), containsTip: true, containsInFlight: false }), { kind: 'ok' });
  assert.deepEqual(reconcile({ tip: sha('a'), inFlight: flight }, { actual: sha('a'), containsTip: true, containsInFlight: false }), { kind: 'retry' }, 'the branch never moved: land it again');
  assert.deepEqual(reconcile({ tip: sha('a'), inFlight: flight }, { actual: sha('c'), containsTip: true, containsInFlight: true, landedExactly: true }), { kind: 'landedBeforeRestart', tip: sha('c'), via: 'merge' });
  assert.deepEqual(reconcile({ tip: sha('a'), inFlight: flight }, { actual: sha('b'), containsTip: true, containsInFlight: true, landedExactly: true }), { kind: 'landedBeforeRestart', tip: sha('b'), via: 'fast-forward' });
  assert.deepEqual(reconcile({ tip: sha('a'), inFlight: flight }, { actual: sha('c'), containsTip: true, containsInFlight: true, landedExactly: false }), { kind: 'moved', actual: sha('c'), added: true }, 'the in-flight landing plus something else on top is not Hydra\'s landing');
  assert.deepEqual(reconcile({ tip: sha('a') }, { actual: sha('e'), containsTip: true, containsInFlight: false }), { kind: 'moved', actual: sha('e'), added: true }, 'commits added on top are never taken in');
  assert.deepEqual(reconcile({ tip: sha('a') }, { actual: sha('f'), containsTip: false, containsInFlight: false }), { kind: 'moved', actual: sha('f'), added: false });
  assert.deepEqual(reconcile({ tip: sha('a') }, { containsTip: false, containsInFlight: false }), { kind: 'recreate' });
});

test('mergeRefusal (O3): only a gate that passed on the current tip lets Merge plan through, or the user\'s override for that same tip', () => {
  const base = newIntegration('aaaaaaaaaaaa', sha('a'), 'main');
  const plan = (integration?: Partial<PlanIntegration>) => ({ title: 'Checkout', ...(integration ? { integration: { ...base, ...integration } } : {}) });
  const gate = (extra: Partial<IntegrationGateRecord>): IntegrationGateRecord => ({ tip: sha('c'), at: '2026-09-27T00:00:00.000Z', checks: [passed()], ...extra });
  assert.match(mergeRefusal(plan())!, /no integration branch/);
  assert.match(mergeRefusal(plan({}))!, /Nothing has landed/);
  assert.match(mergeRefusal(plan({ tip: sha('c'), queue: [{ key: 'b', attempt: 0, commit: sha('d'), at: '2026-09-27T00:00:00.000Z' }] }))!, /still landing/);
  assert.match(mergeRefusal(plan({ tip: sha('c') }))!, /hasn't run/);
  assert.match(mergeRefusal(plan({ tip: sha('c'), gate: gate({ running: true, checks: [] }) }))!, /still running/);
  assert.match(mergeRefusal(plan({ tip: sha('c'), gate: gate({ failed: true, checks: [failedCheck()] }) }))!, /Integration gate failed.*only "Passed required gates" can merge/);
  assert.match(mergeRefusal(plan({ tip: sha('c'), gate: gate({ status: 'partial' }) }))!, /Some gates not run/, 'a partial run is honest, but not a pass');
  assert.match(mergeRefusal(plan({ tip: sha('e'), gate: gate({ status: 'passed' }) }))!, /older tip/, 'a pass on an older tip is stale');
  assert.equal(mergeRefusal(plan({ tip: sha('c'), gate: gate({ status: 'passed' }) })), undefined);
  assert.equal(mergeRefusal(plan({ tip: sha('c'), gate: gate({ failed: true }), override: { tip: sha('c'), at: '2026-09-27T00:00:00.000Z' } })), undefined, 'merged anyway, on the canvas');
  assert.match(mergeRefusal(plan({ tip: sha('e'), gate: gate({ failed: true }), override: { tip: sha('c'), at: '2026-09-27T00:00:00.000Z' } }))!, /older tip/, 'an override is for one tip only');
});

test('integrationSettled (O3): a done plan waits for its integration gate on the current tip; anything else is settled now', () => {
  const base = newIntegration('aaaaaaaaaaaa', sha('a'), 'main');
  const landed = { ...base, tip: sha('c') };
  const gate = (extra: Partial<IntegrationGateRecord>): IntegrationGateRecord => ({ tip: sha('c'), at: '2026-09-27T00:00:00.000Z', checks: [passed()], ...extra });
  assert.equal(integrationSettled({ state: 'done' }), true, 'no integration branch');
  assert.equal(integrationSettled({ state: 'incomplete', integration: landed }), true);
  assert.equal(integrationSettled({ state: 'done', integration: base }), true, 'nothing landed');
  assert.equal(integrationSettled({ state: 'done', integration: landed }), false, 'the gate hasn\'t started yet');
  assert.equal(integrationSettled({ state: 'done', integration: { ...landed, gate: gate({ running: true }) } }), false);
  assert.equal(integrationSettled({ state: 'done', integration: { ...landed, gate: gate({ tip: sha('b'), status: 'passed' }) } }), false, 'a result for an older tip');
  assert.equal(integrationSettled({ state: 'done', integration: { ...landed, gate: gate({ status: 'passed' }) } }), true);
  assert.equal(integrationSettled({ state: 'done', integration: { ...landed, gate: gate({ failed: true }) } }), true);
  assert.equal(integrationSettled({ state: 'done', integration: { ...landed, error: 'stopped' } }), true);
});

test('integrationGates (O3): the project\'s command gates always; one review of the whole diff for a plan that asks for it (any standard or strict job)', () => {
  const config = parseGatesConfig({ gates: [{ id: 'unit', type: 'command', command: ['npm', 'test'] }, { id: 'ui', type: 'screenshots', start: ['npm', 'start'], url: 'http://localhost:{port}/' }] });
  assert.deepEqual(integrationGates(config, false).gates.map(gate => gate.id), ['unit']);
  assert.deepEqual(integrationGates(config, true).gates.map(gate => [gate.id, gate.type]), [['unit', 'command'], ['rigor-review', 'review']]);
  const reviewed = parseGatesConfig({ gates: [{ id: 'unit', type: 'command', command: ['npm', 'test'] }, { id: 'review', type: 'review' }] });
  assert.deepEqual(integrationGates(reviewed, true).gates.map(gate => gate.id), ['unit', 'review'], 'the project\'s own review is used, not a second one');
  assert.deepEqual(integrationGates(reviewed, false).gates.map(gate => gate.id), ['unit']);
});

test('conflictSection (O3): names every conflicting file and the previous try\'s commit', () => {
  const text = conflictSection({ files: ['src/api.ts', 'src/db.ts'], commit: sha('b'), tip: sha('a'), count: 1, at: '2026-09-27T00:00:00.000Z' }, 'hydra/plan-aaaaaaaaaaaa');
  assert.match(text, /^## Conflict/);
  assert.match(text, /- src\/api\.ts\n- src\/db\.ts/);
  assert.match(text, /bbbbbbbbbbbb/);
  assert.match(text, /hydra\/plan-aaaaaaaaaaaa/);
});

// ---- Git: landing, never through a worktree ----

test('landCommit (O3): fast-forward, merge commit, already contained, and a conflict that moves nothing — never touching a worktree or the index', async () => {
  const f = await repoFixture({ 'src/a.txt': 'a\n', 'src/shared.txt': 'one\ntwo\nthree\n' });
  try {
    const branch = integrationBranch('aaaaaaaaaaaa');
    await ensureIntegrationBranch(f.repo, branch, f.base);
    await ensureIntegrationBranch(f.repo, branch, f.base); // idempotent: a start whose record wasn't saved
    const statusBefore = await git(f.repo, ['status', '--porcelain=v1']);
    const one = await f.commitFrom(f.base, { 'src/one.txt': '1\n' }, 'one');
    const ff = await landCommit(f.repo, branch, f.base, one, 'land one');
    assert.deepEqual(ff, { kind: 'landed', tip: one, via: 'fast-forward' });
    const two = await f.commitFrom(f.base, { 'src/two.txt': '2\n' }, 'two');
    const merged = await landCommit(f.repo, branch, one, two, 'land two');
    assert.equal(merged.kind, 'landed');
    const tip = (merged as { tip: string }).tip;
    assert.equal(await f.tip(branch), tip);
    assert.equal(await f.show(tip, 'src/one.txt'), '1\n'); assert.equal(await f.show(tip, 'src/two.txt'), '2\n');
    assert.deepEqual(await landCommit(f.repo, branch, tip, one, 'again'), { kind: 'landed', tip, via: 'contained' }, 'work already in is not landed twice');
    const left = await f.commitFrom(f.base, { 'src/shared.txt': 'one\nLEFT\nthree\n' }, 'left');
    const right = await f.commitFrom(f.base, { 'src/shared.txt': 'one\nRIGHT\nthree\n' }, 'right');
    const withLeft = (await landCommit(f.repo, branch, tip, left, 'left')) as { tip: string };
    assert.deepEqual(await landCommit(f.repo, branch, withLeft.tip, right, 'right'), { kind: 'conflict', files: ['src/shared.txt'] });
    assert.equal(await f.tip(branch), withLeft.tip, 'a conflict leaves the branch where it was');
    assert.equal(await git(f.repo, ['status', '--porcelain=v1']), statusBefore, 'the main checkout and its index are untouched');
    assert.equal((await git(f.repo, ['rev-parse', 'HEAD'])).trim(), f.base);
    await assert.rejects(landCommit(f.repo, branch, f.base, right, 'stale'), /couldn't move/, 'the branch moves only from where the queue last left it');
    await assert.rejects(ensureIntegrationBranch(f.repo, branch, one), /already exists at another commit/);
    // Checked out somewhere, it is left alone.
    await git(f.repo, ['worktree', 'add', '-q', path.join(f.root, 'holder'), branch]);
    await assert.rejects(landCommit(f.repo, branch, withLeft.tip, two, 'held'), /is checked out in .*holder/);
    assert.equal(await f.tip(branch), withLeft.tip);
    await git(f.repo, ['worktree', 'remove', '--force', path.join(f.root, 'holder')]);
  } finally { await f.close(); }
});

// ---- The queue, end to end (acceptance) ----

test('O3 acceptance: three disjoint jobs land in order, and a job that depends on two of them starts from the integration tip with both', async () => {
  const f = await repoFixture({ 'README.md': 'hi\n' });
  const p = await planFixture(f, [headJob('a'), headJob('b'), headJob('c'), headJob('d', { dependsOn: ['a', 'b'] })]);
  try {
    await p.runner.run(p.plan.id);
    const integration = p.get().integration!;
    assert.equal(integration.branch, `hydra/plan-${p.plan.id}`);
    assert.equal(integration.base, f.base); assert.equal(integration.target, 'main');
    assert.equal(await f.tip(integration.branch), f.base, 'the branch is cut from the plan\'s base commit');
    assert.deepEqual(p.started.map(item => item.key), ['a', 'b', 'c'], 'd waits for what it depends on to land');
    for (const item of p.started) assert.deepEqual(item.start, { baseCommit: f.base });
    assert.match(p.status('d').reason!, /Waiting for Job a, Job b to land/);

    // They pass their gates in the order b, a, c; they land in that order.
    await p.finish('b', await f.commitFrom(f.base, { 'src/b.txt': 'b\n' }, 'b'));
    assert.equal(p.status('b').status, 'done');
    assert.equal(p.status('d').status, 'waiting');
    await p.finish('a', await f.commitFrom(f.base, { 'src/a.txt': 'a\n' }, 'a'));
    const afterA = p.get().integration!.tip;
    // d starts now, from the tip that has both a and b: one base, already merged.
    const d = p.startedFor('d');
    assert.equal(d.length, 1);
    assert.deepEqual(d[0]!.start, { baseCommit: afterA });
    assert.deepEqual(d[0]!.dependsOn, [], 'no in-memory merge of its dependencies');
    assert.deepEqual(d[0]!.inputs.map(input => input.title), ['Job a', 'Job b'], 'it still hears what they did');
    assert.equal(await f.show(afterA, 'src/a.txt'), 'a\n'); assert.equal(await f.show(afterA, 'src/b.txt'), 'b\n');
    await p.finish('c', await f.commitFrom(f.base, { 'src/c.txt': 'c\n' }, 'c'));

    const landed = p.get().integration!.landed;
    assert.deepEqual(landed.map(entry => entry.key), ['b', 'a', 'c']);
    assert.deepEqual(landed.map(entry => entry.via), ['fast-forward', 'merge', 'merge']);
    const tip = p.get().integration!.tip;
    assert.equal(await f.tip(p.get().integration!.branch), tip);
    // Each landing's tip contains the one before it: a straight line, in queue order.
    assert.ok(await f.isAncestor(landed[0]!.tip, landed[1]!.tip) && await f.isAncestor(landed[1]!.tip, landed[2]!.tip));
    assert.equal((await git(f.repo, ['rev-parse', 'HEAD'])).trim(), f.base, 'the main checkout never moved');
    assert.equal(await git(f.repo, ['status', '--porcelain=v1']), '');
  } finally { p.dispose(); await f.close(); }
});

test('O3 acceptance: a conflicting job is re-queued from the integration tip with the conflict files named, its old try carried over; out of tries it is held for the lead', async () => {
  const f = await repoFixture({ 'src/shared.txt': 'one\ntwo\nthree\n' });
  const p = await planFixture(f, [headJob('left'), headJob('right')], { attempts: 2 });
  try {
    await p.runner.run(p.plan.id);
    await p.finish('left', await f.commitFrom(f.base, { 'src/shared.txt': 'one\nLEFT\nthree\n' }, 'left'));
    const afterLeft = p.get().integration!.tip;
    const firstRight = await f.commitFrom(f.base, { 'src/shared.txt': 'one\nRIGHT\nthree\n' }, 'right');
    await p.finish('right', firstRight);

    const right = p.get().jobs.find(item => item.key === 'right')!;
    assert.equal(right.attempt, 1, 'the conflict spent a try');
    assert.deepEqual(right.conflict?.files, ['src/shared.txt']);
    assert.equal(right.conflict?.commit, firstRight);
    const again = p.startedFor('right');
    assert.equal(again.length, 2, 'it went back in the queue as a new try');
    assert.deepEqual(again[1]!.start, { baseCommit: afterLeft, carry: firstRight }, 'rebased on the integration tip, carrying its old work');
    assert.match(again[1]!.brief, /## Conflict/);
    assert.match(again[1]!.brief, /- src\/shared\.txt/);
    assert.equal(p.get().integration!.tip, afterLeft, 'the conflict moved nothing');

    // Its second try conflicts too (2 tries in this plan): it is held for the lead, naming the file, and the plan stops to ask.
    await p.finish('right', await f.commitFrom(f.base, { 'src/shared.txt': 'one\nRIGHT AGAIN\nthree\n' }, 'right again'));
    const held = p.status('right');
    assert.equal(held.status, 'failed');
    assert.deepEqual(held.conflict, ['src/shared.txt']);
    assert.match(held.reason!, /Couldn't land on hydra\/plan-[a-f0-9]{12} after 2 tries: conflicts in src\/shared\.txt/);
    assert.equal(p.get().state, 'incomplete');
    assert.equal(p.startedFor('right').length, 2, 'a held job doesn\'t start again by itself');
    const view = integrationLeadView(p.get())!;
    assert.deepEqual([view.landed, view.can_merge], [['left'], false]);

    // Retry failed jobs (or hydra_plan_amend's retry) gives it a fresh set of tries; this one resolves it.
    await p.runner.retry(p.plan.id);
    const third = p.startedFor('right');
    assert.equal(third.length, 3);
    assert.deepEqual(third[2]!.start?.baseCommit, afterLeft);
    await p.finish('right', await f.commitFrom(afterLeft, { 'src/shared.txt': 'one\nLEFT\nRIGHT\nthree\n' }, 'right, resolved'));
    assert.deepEqual(p.get().integration!.landed.map(entry => entry.key), ['left', 'right']);
    assert.equal(p.get().state, 'done');
    await p.runner.integrate(p.plan.id); // the gate Hydra starts by itself once everything has landed
  } finally { p.dispose(); await f.close(); }
});

// The fixture the plan names: one job renames a function, the other adds a call to its old name.
const renameFixture = {
  'src/math.js': 'exports.add = (a, b) => a + b;\n',
  'check.js': [
    'const fs = require(\'fs\');',
    'const math = require(\'./src/math.js\');',
    'if (typeof (math.add || math.sum) !== \'function\') process.exit(1);',
    'if (fs.existsSync(\'./src/use.js\') && require(\'./src/use.js\')() !== 3) process.exit(1);',
    '',
  ].join('\n'),
};
const renamed = { 'src/math.js': 'exports.sum = (a, b) => a + b;\n' };
const callsOldName = { 'src/use.js': 'const { add } = require(\'./math.js\');\nmodule.exports = () => add(1, 2);\n' };

test('O3 acceptance: two jobs that each pass alone but fail together are caught by the integration gate', async () => {
  const f = await repoFixture(renameFixture);
  const gate = commandGate(f, [process.execPath, 'check.js']);
  const p = await planFixture(f, [headJob('rename'), headJob('caller')], { runGate: gate });
  try {
    await p.runner.run(p.plan.id);
    const renameCommit = await f.commitFrom(f.base, renamed, 'rename add to sum');
    const callerCommit = await f.commitFrom(f.base, callsOldName, 'call add');
    // Each passes the project's gate on its own.
    const alone = async (commit: string) => (await gate({ id: p.plan.id, integration: newIntegration(p.plan.id, f.base) }, commit)).checks[0]!;
    assert.equal((await alone(renameCommit)).state, 'passed');
    assert.equal((await alone(callerCommit)).state, 'passed');

    await p.finish('rename', renameCommit);
    await p.finish('caller', callerCommit);
    assert.equal(p.get().state, 'done', 'both landed: they merge cleanly, different files');
    const record = await p.runner.integrate(p.plan.id); // joins the gate Hydra started by itself
    assert.equal(record.failed, true, 'together they break');
    assert.equal(record.tip, p.get().integration!.tip);
    assert.equal(record.checks[0]!.state, 'failed');
    assert.equal(integrationLeadView(p.get())!.gate.label, 'Integration gate failed');
    assert.match(mergeRefusal(p.get())!, /Integration gate failed/);
    await assert.rejects(p.runner.merge(p.plan.id), /only "Passed required gates" can merge/);
    const worktrees = await git(f.repo, ['worktree', 'list', '--porcelain']);
    assert.doesNotMatch(worktrees, /ig-/, 'the gate\'s own worktree is removed afterwards');
  } finally { p.dispose(); await f.close(); }
});

/** A HelperService with its real endpoint, whose plans bridge is backed by the real plan runner (as extension.ts's is). */
async function leadEndpoint(f: Repo, runner: () => PlanRunner, store: () => PlanStore) {
  const jobs = new JobStore(path.join(f.root, `jobs-${++counter}`)); await jobs.load();
  let service!: HelperService;
  const endpoint = new HelperEndpoint((caller, tool, args, signal) => service.handle(caller, tool, args, signal));
  await endpoint.start();
  const summary = (id: string): PlanLeadPlan => {
    const plan = store().get(id)!;
    return { planId: plan.id, title: plan.title, state: plan.state, jobs: [], board: [], amendments: [], ...(plan.integration ? { integration: integrationLeadView(plan) } : {}) };
  };
  const refuse = async () => { throw new Error('not in this test'); };
  const plans: PlanLeadBridge = {
    create: refuse, get: id => summary(id), wait: refuse, amend: refuse, cancel: refuse, message: refuse, run: refuse, report: refuse,
    integrate: async id => { await runner().integrate(id); return summary(id); },
    merge: async (id, _session, via) => { const result = await runner().merge(id, via); return { plan: summary(id), ...(result.commit ? { commit: result.commit } : {}), ...(result.into ? { into: result.into } : {}) }; },
  };
  service = new HelperService({
    store: jobs, endpoint, leadFolder: f.repo, leadKey: 'window', executable: async provider => `fake-${provider}`, bridge: { command: 'hydra.exe', args: [] },
    logDirectory: path.join(f.root, 'logs'), maxConcurrent: () => 1, watchdogMs: 1000, plans,
    startRun: () => { throw new Error('no heads here'); },
  });
  const lead = endpoint.issue({ role: 'lead', leadKey: 'window', leadSessionId: 'abcdef012345' });
  const helper = endpoint.issue({ role: 'helper', leadKey: 'window', jobId: 'aaaaaaaaaaaa' });
  return {
    asLead: (tool: string, args: Record<string, unknown>) => callHelperEndpoint(endpoint.port, lead, tool, args) as Promise<{ ok: boolean; result?: any; error?: string }>,
    asHelper: (tool: string, args: Record<string, unknown>) => callHelperEndpoint(endpoint.port, helper, tool, args),
    close: async () => { await service.dispose(); await endpoint.close(); },
  };
}

test('O3 acceptance: hydra_plan_merge is refused before the integration gate passes, and merges once it has', async () => {
  const f = await repoFixture({ 'README.md': 'hi\n' });
  let passes = false;
  const p = await planFixture(f, [headJob('a'), headJob('b')], { runGate: async () => ({ checks: [passes ? passed() : failedCheck()], configured: 'file' }) });
  const tools = await leadEndpoint(f, () => p.runner, () => p.store);
  try {
    await p.runner.run(p.plan.id);
    let refused = await tools.asLead('hydra_plan_merge', { plan_id: p.plan.id });
    assert.equal(refused.ok, false); assert.match(refused.error!, /Nothing has landed/);

    await p.finish('a', await f.commitFrom(f.base, { 'src/a.txt': 'a\n' }, 'a'));
    refused = await tools.asLead('hydra_plan_merge', { plan_id: p.plan.id });
    assert.equal(refused.ok, false); assert.match(refused.error!, /hasn't run/, 'b hasn\'t landed, and the gate hasn\'t run');

    await p.finish('b', await f.commitFrom(f.base, { 'src/b.txt': 'b\n' }, 'b'));
    await p.runner.integrate(p.plan.id); // the automatic run, which fails
    refused = await tools.asLead('hydra_plan_merge', { plan_id: p.plan.id });
    assert.equal(refused.ok, false); assert.match(refused.error!, /Integration gate failed.*only "Passed required gates" can merge/);
    assert.equal((await git(f.repo, ['rev-parse', 'main'])).trim(), f.base, 'nothing reached main');

    // A head can't call it at all: it's a lead's tool.
    const denied = await tools.asHelper('hydra_plan_merge', { plan_id: p.plan.id });
    assert.equal(denied.ok, false); assert.match(denied.error!, /not available to a Hydra head/);

    passes = true;
    const integrated = await tools.asLead('hydra_plan_integrate', { plan_id: p.plan.id });
    assert.equal(integrated.ok, true);
    assert.equal(integrated.result.integration.gate.label, 'Passed required gates');
    assert.equal(integrated.result.integration.can_merge, true);
    const merged = await tools.asLead('hydra_plan_merge', { plan_id: p.plan.id });
    assert.equal(merged.ok, true, merged.error);
    const tip = p.get().integration!.tip;
    assert.equal(merged.result.merged_commit, tip, 'a fast-forward: main didn\'t move meanwhile');
    assert.equal(merged.result.merged_into, 'main');
    assert.equal((await git(f.repo, ['rev-parse', 'main'])).trim(), tip);
    assert.equal((await readFile(path.join(f.repo, 'src', 'b.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'b\n', 'the checkout now has the plan\'s work');
    const again = await tools.asLead('hydra_plan_merge', { plan_id: p.plan.id });
    assert.equal(again.ok, false); assert.match(again.error!, /already merged into main/);
  } finally { await tools.close(); p.dispose(); await f.close(); }
});

test('O3 acceptance: a simulated restart mid-queue resumes the queue — a landing the branch already has is recorded once, and the rest land in order', async () => {
  const f = await repoFixture({ 'README.md': 'hi\n' });
  const p = await planFixture(f, [headJob('a'), headJob('b'), headJob('c')]);
  try {
    await p.runner.run(p.plan.id);
    const commits: Record<string, string> = {};
    for (const key of ['a', 'b', 'c']) commits[key] = await f.commitFrom(f.base, { [`src/${key}.txt`]: `${key}\n` }, key);
    // All three passed their gates while Hydra ran; the queue had them in order a, b, c, and Hydra stopped just after
    // moving the branch for a, before writing that down. (What plans.json and the repository look like at that moment.)
    for (const key of ['a', 'b', 'c']) { const head = p.heads.get(p.get().jobs.find(item => item.key === key)!.jobId!)!; head.state = 'done'; head.result = { commit: commits[key]!, summary: key, changedFiles: [] }; }
    p.dispose();
    const at = '2026-09-27T00:00:00.000Z';
    await p.store.update(p.plan.id, plan => ({ ...plan, integration: {
      ...plan.integration!, queue: ['a', 'b', 'c'].map(key => ({ key, attempt: 0, commit: commits[key]!, at })),
      inFlight: { key: 'a', attempt: 0, commit: commits.a!, from: f.base, at },
    } }));
    assert.deepEqual(await landCommit(f.repo, p.get().integration!.branch, f.base, commits.a!, 'land a'), { kind: 'landed', tip: commits.a!, via: 'fast-forward' });

    // Hydra starts again: plans.json is read back from disk, and the runner picks up running plans.
    const runner = await p.restart();
    assert.deepEqual(p.get().integration!.queue.map(entry => entry.key), ['a', 'b', 'c'], 'the queue survived the restart');
    await runner.advanceAll({ startup: true });
    const integration = p.get().integration!;
    assert.deepEqual(integration.landed.map(entry => [entry.key, entry.via]), [['a', 'fast-forward'], ['b', 'merge'], ['c', 'merge']]);
    assert.equal(integration.inFlight, undefined);
    assert.deepEqual(integration.queue, []);
    assert.equal(p.get().state, 'done');
    const firstParents = (await git(f.repo, ['rev-list', '--first-parent', integration.tip])).trim().split(/\s+/);
    assert.deepEqual(firstParents.slice(-2), [commits.a!, f.base], 'a landed exactly once, first');
    assert.equal(firstParents.length, 4, 'b and c on top of it, one landing each');
    await runner.integrate(p.plan.id);

    // And the other half: Hydra wrote down a landing but stopped before the branch moved; it lands it now.
    const q = await planFixture(f, [headJob('x')]);
    try {
      await q.runner.run(q.plan.id);
      const x = await f.commitFrom(f.base, { 'src/x.txt': 'x\n' }, 'x');
      const head = q.heads.get(q.get().jobs[0]!.jobId!)!; head.state = 'done'; head.result = { commit: x, summary: 'x', changedFiles: [] };
      q.dispose();
      await q.store.update(q.plan.id, plan => ({ ...plan, integration: { ...plan.integration!, queue: [{ key: 'x', attempt: 0, commit: x, at }], inFlight: { key: 'x', attempt: 0, commit: x, from: f.base, at } } }));
      await (await q.restart()).advanceAll({ startup: true });
      assert.deepEqual(q.get().integration!.landed.map(entry => entry.key), ['x']);
      assert.equal(await f.tip(q.get().integration!.branch), x);
      await q.runner.integrate(q.plan.id);
    } finally { q.dispose(); }
  } finally { p.dispose(); await f.close(); }
});

test('O3: a branch moved by hand stops the queue with the reason, instead of landing on top of it', async () => {
  const f = await repoFixture({ 'README.md': 'hi\n' });
  const p = await planFixture(f, [headJob('a'), headJob('b')]);
  try {
    await p.runner.run(p.plan.id);
    await p.finish('a', await f.commitFrom(f.base, { 'src/a.txt': 'a\n' }, 'a'));
    const elsewhere = await f.commitFrom(f.base, { 'src/other.txt': 'x\n' }, 'elsewhere');
    await git(f.repo, ['update-ref', `refs/heads/${p.get().integration!.branch}`, elsewhere]);
    await p.finish('b', await f.commitFrom(f.base, { 'src/b.txt': 'b\n' }, 'b'));
    assert.match(p.get().integration!.error!, /was moved by hand/);
    assert.match(p.status('b').reason!, /can't land: .*was moved by hand/);
    assert.equal(await f.tip(p.get().integration!.branch), elsewhere, 'Hydra never moves it back or lands on it by itself');
    assert.match(mergeRefusal(p.get())!, /queue stopped/);
  } finally { p.dispose(); await f.close(); }
});

test('O3: commits added on top of the integration branch are never taken in; the queue stops, and goes on once the branch is back', async () => {
  const f = await repoFixture({ 'README.md': 'hi\n' });
  let clock = Date.parse('2026-09-27T00:00:00.000Z');
  const p = await planFixture(f, [headJob('a'), headJob('b')], { now: () => new Date(clock) });
  try {
    await p.runner.run(p.plan.id);
    await p.finish('a', await f.commitFrom(f.base, { 'src/a.txt': 'a\n' }, 'a'));
    const branch = p.get().integration!.branch, afterA = p.get().integration!.tip;
    // Something sharing the repository's git metadata (a head, say) puts its own commit on the branch.
    const sneaky = await f.commitFrom(afterA, { 'src/outside-scope.txt': 'x\n' }, 'not a job');
    await git(f.repo, ['update-ref', `refs/heads/${branch}`, sneaky]);
    await p.finish('b', await f.commitFrom(f.base, { 'src/b.txt': 'b\n' }, 'b'));
    assert.match(p.get().integration!.error!, /gained commits Hydra didn't land/);
    assert.equal(p.get().integration!.tip, afterA, 'the record never moves onto the added commit');
    assert.deepEqual(p.get().integration!.landed.map(entry => entry.key), ['a']);
    assert.equal(await f.tip(branch), sneaky, 'and Hydra never moves the branch back by itself');

    // Put back where Hydra left it: a plan event within the backoff leaves the queue stopped; after it, it goes on.
    await git(f.repo, ['update-ref', `refs/heads/${branch}`, afterA]);
    clock += 5_000; await p.runner.advance(p.plan.id);
    assert.ok(p.get().integration!.error, 'still stopped inside the backoff');
    clock += 30_000; await p.runner.advance(p.plan.id);
    const integration = p.get().integration!;
    assert.equal(integration.error, undefined);
    assert.deepEqual(integration.landed.map(entry => entry.key), ['a', 'b']);
    assert.equal(await f.isAncestor(sneaky, integration.tip), false, 'the added commit never reaches the integrated tree');
    assert.equal(p.get().state, 'done');
  } finally { p.dispose(); await f.close(); }
});

test('reconcileFacts (O3): only Hydra\'s own in-flight landing counts as landed before a restart — not one with more on top, nor a forged merge', async () => {
  const f = await repoFixture({ 'README.md': 'hi\n' });
  try {
    const branch = integrationBranch('bbbbbbbbbbbb');
    await ensureIntegrationBranch(f.repo, branch, f.base);
    const a = await f.commitFrom(f.base, { 'src/a.txt': 'a\n' }, 'a');
    const b = await f.commitFrom(f.base, { 'src/b.txt': 'b\n' }, 'b');
    await landCommit(f.repo, branch, f.base, a, 'land a');
    const inFlight = { key: 'b', attempt: 0, commit: b, from: a, at: '2026-09-27T00:00:00.000Z' };
    const landed = await landCommit(f.repo, branch, a, b, 'land b');
    assert.equal(landed.kind, 'landed');
    const real = await reconcileFacts(f.repo, { branch, tip: a, inFlight });
    assert.equal(real.landedExactly, true);
    assert.equal(reconcile({ tip: a, inFlight }, real).kind, 'landedBeforeRestart');

    const onTop = await f.commitFrom(await f.tip(branch), { 'src/extra.txt': 'x\n' }, 'extra');
    await git(f.repo, ['update-ref', `refs/heads/${branch}`, onTop]);
    const more = await reconcileFacts(f.repo, { branch, tip: a, inFlight });
    assert.equal(more.landedExactly, false);
    assert.deepEqual(reconcile({ tip: a, inFlight }, more), { kind: 'moved', actual: onTop, added: true });

    const forgedTree = (await git(f.repo, ['rev-parse', `${onTop}^{tree}`])).trim();
    const forged = (await git(f.repo, ['commit-tree', forgedTree, '-p', a, '-p', b, '-m', 'looks like a landing'])).trim();
    await git(f.repo, ['update-ref', `refs/heads/${branch}`, forged]);
    const fake = await reconcileFacts(f.repo, { branch, tip: a, inFlight });
    assert.equal(fake.landedExactly, false, 'the right parents but not their merge\'s tree');
    assert.equal(reconcile({ tip: a, inFlight }, fake).kind, 'moved');
  } finally { await f.close(); }
});

test('O3: a restart cut the integration gate short: it runs again on its own', async () => {
  const f = await repoFixture({ 'README.md': 'hi\n' });
  let runs = 0;
  const p = await planFixture(f, [headJob('a')], { runGate: async () => { runs++; return { checks: [passed()], configured: 'file' }; } });
  try {
    await p.runner.run(p.plan.id);
    await p.finish('a', await f.commitFrom(f.base, { 'src/a.txt': 'a\n' }, 'a'));
    await p.runner.integrate(p.plan.id);
    assert.equal(runs, 1);
    p.dispose();
    await p.store.update(p.plan.id, plan => ({ ...plan, integration: { ...plan.integration!, gate: { tip: plan.integration!.tip, at: plan.integration!.gate!.at, running: true, checks: [] } } }));
    const runner = await p.restart();
    await runner.advanceAll({ startup: true });
    await runner.integrate(p.plan.id);
    assert.equal(runs, 2);
    assert.equal(p.get().integration!.gate!.status, 'passed');
    assert.equal(p.get().integration!.gate!.running, undefined);
  } finally { p.dispose(); await f.close(); }
});

test('applyPlanAmendment (O3): retrying a job held for a conflict gives it a fresh set of tries, keeping its files for the brief', () => {
  const at = '2026-09-27T00:00:00.000Z';
  const jobs: PlanJob[] = [headJob('api', { jobId: '000000000001', attempt: 2, writeScope: ['src/api/'], conflict: { files: ['src/api/x.ts'], commit: sha('b'), tip: sha('a'), count: 3, at, held: true } })];
  const result = applyPlanAmendment({ jobs }, { retry: [{ key: 'api', brief: 'Keep both changes.' }] }, () => 'failed');
  const job = result.jobs[0]!;
  assert.equal(job.jobId, undefined);
  assert.equal(job.attempt, 3);
  assert.deepEqual(job.conflict, { files: ['src/api/x.ts'], commit: sha('b'), tip: sha('a'), count: 0, at });
  assert.match(String(planHeadInput({ id: 'aaaaaaaaaaaa', title: 'X', integration: newIntegration('aaaaaaaaaaaa', sha('a')) }, job, []).brief), /Keep both changes\.\n\n## Conflict/);
});

test('laneMergeRefusal (O3): a plan lane\'s own Merge refuses while its plan lands through an integration branch', () => {
  const integration = newIntegration('aaaaaaaaaaaa', sha('a'), 'main');
  const refusal = laneMergeRefusal({ title: 'Checkout', integration }, { title: 'Build API' });
  assert.match(refusal!, /job "Build API" of plan "Checkout", which lands on hydra\/plan-aaaaaaaaaaaa and reaches main only with the rest of the plan/);
  assert.match(refusal!, /Use Mark job done instead of Merge/);
  assert.equal(laneMergeRefusal({ title: 'Old' }, { title: 'x' }), undefined, 'a plan from before integration branches merges as it always did');
  assert.equal(laneMergeRefusal({ title: 'Done', integration: { ...integration, merged: { via: 'merge', tip: sha('a'), at: '2026-09-27T00:00:00.000Z' } } }, { title: 'x' }), undefined);
});

test('O3: a done plan settles before its integration gate runs, and onGateDone follows with the gate\'s result on the plan', async () => {
  const f = await repoFixture({ 'README.md': 'hi\n' });
  const settled: Plan[] = [], gated: Plan[] = [];
  const p = await planFixture(f, [headJob('a')], { hooks: { onSettled: plan => settled.push(plan), onGateDone: plan => gated.push(plan) } });
  try {
    await p.runner.run(p.plan.id);
    await p.finish('a', await f.commitFrom(f.base, { 'src/a.txt': 'a\n' }, 'a'));
    assert.equal(settled.length, 1);
    assert.equal(settled[0]!.state, 'done');
    assert.equal(integrationSettled(settled[0]!), false, 'when the plan settles, its gate is still to come: the morning report waits');
    await p.runner.integrate(p.plan.id); // joins the run the last landing started
    assert.equal(gated.length, 1);
    assert.equal(integrationSettled(gated[0]!), true);
    assert.equal(gated[0]!.integration!.gate!.status, 'passed');
  } finally { p.dispose(); await f.close(); }
});

test('integrationFixJob (O3): a failed gate becomes one fix job with its findings, round by round, until the rounds run out', () => {
  const review: JobCheckResult = { id: 'rigor-review', kind: 'review', state: 'failed', required: true, passed: false, exitCode: null, durationMs: 1, outputTail: '', summary: 'Input is not validated.', findings: [{ file: 'src/tax.js', line: 4, severity: 'major', note: 'Negative\n amounts pass.' }] };
  const record = (checks: JobCheckResult[], extra: Partial<IntegrationGateRecord> = {}): IntegrationGateRecord => ({ tip: sha('c'), at: '2026-09-28T00:00:00.000Z', checks, failed: true, ...extra });
  const plan = { title: 'Shop', jobs: [{ key: 'tax' }] };
  const fix = integrationFixJob(plan, record([failedCheck(), review]))!;
  assert.equal(fix.key, 'integration-fix-1');
  assert.deepEqual(fix.write_scope, ['.'], 'a fix may touch whatever the findings need');
  assert.equal(fix.rigor, 'quick', 'the integration gate, run again, reviews it with the rest');
  assert.match(fix.title, /round 1 of 2/);
  assert.match(fix.brief, /plan "Shop"/);
  assert.match(fix.brief, /### unit \(command\) failed/);
  assert.match(fix.brief, /boom/, 'a command gate\'s output');
  assert.match(fix.brief, /### rigor-review \(review\) failed: Input is not validated\./);
  assert.match(fix.brief, /- \[major\] src\/tax\.js:4: Negative amounts pass\./, 'each finding, on one line');
  assert.equal(integrationFixJob({ ...plan, jobs: [...plan.jobs, { key: 'integration-fix-1' }] }, record([failedCheck()]))!.key, 'integration-fix-2');
  assert.equal(integrationFixJob({ ...plan, jobs: [...plan.jobs, { key: 'integration-fix-1' }, { key: 'integration-fix-2' }] }, record([failedCheck()])), undefined, 'two rounds by default');
  assert.equal(integrationFixJob(plan, record([failedCheck()]), 0), undefined, '0 turns it off');
  assert.equal(integrationFixJob(plan, record([passed()], { failed: undefined, status: 'passed' })), undefined);
  assert.equal(integrationFixJob(plan, record([], { error: 'no worktree' })), undefined, 'a gate that couldn\'t run has nothing to fix');
  const long = integrationFixJob(plan, record([{ ...review, findings: Array.from({ length: 20 }, () => ({ severity: 'minor' as const, note: 'x'.repeat(600) })) }]))!;
  assert.equal(long.brief.length, planJobBriefMax, 'clipped to what a plan job brief may hold');
});

test('O3 acceptance: a failed integration gate adds a fix job from the branch tip with the findings, and the gate passes once the fix lands', async () => {
  const f = await repoFixture(renameFixture);
  const gated: Plan[] = [];
  const p = await planFixture(f, [headJob('rename', { writeScope: ['src/math.js'] }), headJob('caller', { writeScope: ['src/use.js'] })], { runGate: commandGate(f, [process.execPath, 'check.js']), fixRounds: 2, hooks: { onGateDone: plan => gated.push(plan) } });
  try {
    await p.runner.run(p.plan.id);
    await p.finish('rename', await f.commitFrom(f.base, renamed, 'rename add to sum'));
    await p.finish('caller', await f.commitFrom(f.base, callsOldName, 'call add'));
    const first = await p.runner.integrate(p.plan.id);
    assert.equal(first.failed, true, 'together they break');
    assert.equal(p.get().state, 'running', 'a fix is under way: the plan isn\'t over, so hydra plan wait keeps waiting');
    assert.equal(gated.length, 0, 'no report yet: the fix may still pass');
    const fix = p.startedFor('integration-fix-1');
    assert.equal(fix.length, 1, 'one fix head');
    assert.equal(fix[0]!.start?.baseCommit, first.tip, 'it starts from the combined work');
    assert.match(fix[0]!.brief, /### unit \(command\) failed/);
    assert.equal(p.get().amendments?.at(-1)?.kind, 'add');

    const tip = p.get().integration!.tip;
    await p.finish('integration-fix-1', await f.commitFrom(tip, { 'src/use.js': 'const { sum } = require(\'./math.js\');\nmodule.exports = () => sum(1, 2);\n' }, 'fix: call sum'));
    const second = await p.runner.integrate(p.plan.id);
    assert.equal(second.status, 'passed');
    assert.equal(p.get().state, 'done');
    assert.equal(gated.length, 1, 'the report follows the last gate run');
    assert.equal(mergeRefusal(p.get()), undefined, 'and the plan can merge');
  } finally { p.dispose(); await f.close(); }
});

test('O3: automatic fixes run round after round alongside scoped jobs, then stop, leaving the failed gate for you', async () => {
  const f = await repoFixture({ 'README.md': 'hi\n' });
  const gated: Plan[] = [];
  const failing: NonNullable<PlanRunnerOptions['integration']>['runGate'] = async () => ({ checks: [failedCheck()], configured: 'file' });
  // Scoped jobs, as a lead's always are: a fix may change any file, yet never collides with them (or with the fix before it).
  const p = await planFixture(f, [headJob('a', { writeScope: ['src/a.txt'] }), headJob('b', { writeScope: ['src/b.txt'] })], { runGate: failing, fixRounds: 2, hooks: { onGateDone: plan => gated.push(plan) } });
  try {
    await p.runner.run(p.plan.id);
    await p.finish('a', await f.commitFrom(f.base, { 'src/a.txt': 'a\n' }, 'a'));
    await p.finish('b', await f.commitFrom(f.base, { 'src/b.txt': 'b\n' }, 'b'));
    await p.runner.integrate(p.plan.id);
    assert.equal(p.startedFor('integration-fix-1').length, 1, 'round 1, next to scoped jobs');
    await p.finish('integration-fix-1', await f.commitFrom(p.get().integration!.tip, { 'src/a.txt': 'fixed?\n' }, 'try a fix'));
    await p.runner.integrate(p.plan.id);
    assert.equal(p.startedFor('integration-fix-2').length, 1, 'round 2, after round 1');
    await p.finish('integration-fix-2', await f.commitFrom(p.get().integration!.tip, { 'src/b.txt': 'fixed?\n' }, 'try again'));
    const last = await p.runner.integrate(p.plan.id);
    assert.equal(last.failed, true);
    assert.equal(p.startedFor('integration-fix-3').length, 0, 'two rounds only');
    assert.equal(p.get().state, 'done');
    assert.equal(integrationSettled(p.get()), true);
    assert.equal(gated.length, 1);
    assert.match(mergeRefusal(p.get())!, /Integration gate failed/);
  } finally { p.dispose(); await f.close(); }
});
