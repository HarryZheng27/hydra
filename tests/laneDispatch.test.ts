import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../src/core/git';
import { createPlan, PlanStore, validatePlanDispatch, type Plan, type PlanDispatch, type PlanJob } from '../src/core/plans';
import { planLaneBrief, PlanRunner, type PlanLaneLook, type PlanLook, type PlanRunnerOptions } from '../src/core/planRunner';
import { LaneStore, laneNameFromTitle, lanePreamble, type LanePlanLink } from '../src/core/lanes';
import { LaneService } from '../src/core/laneService';
import { LaneDispatch, dispatchGatesEnding } from '../src/core/laneDispatch';
import { StopSwitch, fakeStopStore } from '../src/core/stopSwitch';
import { parseMessage } from '../src/core/model';
import type { GateRuntime } from '../src/core/gates';
import { fakePtyModule } from './lanePtyFake';

/**
 * Step C: Auto-dispatch to lanes. First the runner alone, with lanes as
 * entries in a fake world; then hydra_job_ready's check end to end, over real git, a LaneService with a
 * fake terminal and fake gate commands.
 */
const lane = (key: string, extra: Partial<PlanJob> = {}): PlanJob => ({ key, title: `Job ${key}`, brief: `Do ${key}.`, dependsOn: [], runAs: 'lane', ...extra });
const sha = (fill: string) => fill.repeat(40);
const dispatch = (extra: Partial<PlanDispatch> = {}): PlanDispatch => ({ lanes: 2, provider: 'claude', attempts: 3, ...extra });

// ---- The runner, with a fake world ----

type WorldLane = PlanLaneLook & { plan?: { planId: string; jobKey: string; attempt?: number } };
function world() {
  const lanes = new Map<string, WorldLane>();
  const look: PlanLook = {
    head: () => undefined,
    lane: id => lanes.get(id),
    planLanes: planId => [...lanes].filter(([, item]) => item.plan?.planId === planId && item.state !== 'closed').map(([laneId, item]) => ({ laneId, jobKey: item.plan!.jobKey, attempt: item.plan!.attempt ?? 0 })),
    lanesAvailable: () => true,
  };
  return { lanes, look };
}

async function runnerFixture(jobs: PlanJob[], planExtra: Partial<Plan> = {}, extra: Partial<PlanRunnerOptions> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-lane-dispatch-'));
  const store = new PlanStore(directory);
  await store.load();
  const plan = await store.save({ ...createPlan({ title: 'Checkout' }), jobs, ...planExtra });
  const { lanes, look } = world();
  const started: string[] = [];
  let counter = 0;
  const options = (): PlanRunnerOptions => ({
    store, look, repository: directory,
    startHead: async () => { throw new Error('no heads here'); },
    startLane: async (current, item) => {
      const id = (++counter).toString(16).padStart(12, '0');
      started.push(item.key);
      lanes.set(id, { name: item.title, state: 'running', branch: `lane/${item.key}-${id}`, baseCommit: sha('b'), plan: { planId: current.id, jobKey: item.key, attempt: item.attempt ?? 0 } });
      return { laneId: id };
    },
    cancelHead: async () => undefined,
    unlinkLane: async id => { const item = lanes.get(id); if (item) delete item.plan; },
    commitSubjects: async () => [], changedFiles: async () => [],
    terminalsAvailable: () => true, debounceMs: 1,
    ...extra,
  });
  const runner = new PlanRunner(options());
  const get = () => store.get(plan.id)!;
  const byKey = (key: string) => get().jobs.find(item => item.key === key)!;
  /** Lane jobs of this plan running in a lane now: the slots in use. */
  const running = () => get().jobs.filter(item => item.laneId && !item.result && !item.outcome && lanes.get(item.laneId)?.state !== 'closed').length;
  const done = (runnerNow: PlanRunner, key: string, fill = 'c') => runnerNow.markLaneDone(plan.id, key, byKey(key).laneId!, { commit: sha(fill), changedFiles: [`src/${key}.ts`] });
  return { store, plan, lanes, started, runner, options, get, byKey, running, done, close: async () => { runner.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

test('two slots and dependent jobs: each job is assigned once, dependencies first, and never more than two lanes at once', async () => {
  // d depends on a; a, b and c are ready at once.
  const f = await runnerFixture([lane('a'), lane('b'), lane('c'), lane('d', { dependsOn: ['a'] })], { dispatch: dispatch({ lanes: 2 }) });
  try {
    await Promise.all([f.runner.run(f.plan.id), f.runner.advance(f.plan.id), f.runner.advanceAll()]);
    assert.deepEqual(f.started, ['a', 'b'], 'two slots: the first two ready jobs');
    assert.equal(f.running(), 2);
    const waiting = f.runner.statuses(f.plan.id)!;
    assert.equal(waiting.find(item => item.key === 'c')!.reason, 'Waiting for a free lane (2 of 2 in use).');
    assert.equal(waiting.find(item => item.key === 'd')!.reason, 'Starts as a lane when Job a is done');
    assert.deepEqual(waiting.find(item => item.key === 'a')!.dispatch, { attempt: 1, attempts: 3 });

    await f.done(f.runner, 'a');
    await f.runner.advanceAll();
    assert.deepEqual(f.started, ['a', 'b', 'c'], 'a\'s slot goes to c, the next ready job; d is ready now but no slot is free');
    assert.equal(f.running(), 2);
    assert.equal(f.runner.statuses(f.plan.id)!.find(item => item.key === 'd')!.reason, 'Waiting for a free lane (2 of 2 in use).');

    await f.done(f.runner, 'b', 'd');
    await Promise.all([f.runner.advance(f.plan.id), f.runner.advance(f.plan.id)]);
    assert.deepEqual(f.started, ['a', 'b', 'c', 'd'], 'each job once');
    await f.done(f.runner, 'c', 'e'); await f.done(f.runner, 'd', 'f');
    assert.equal(f.get().state, 'done');
    assert.equal(new Set(f.started).size, f.started.length);
  } finally { await f.close(); }
});

test('without the setting a plan starts every ready lane job, as before; at window start it waits for Start lane', async () => {
  const f = await runnerFixture([lane('a'), lane('b'), lane('c')]);
  try {
    await f.runner.run(f.plan.id);
    assert.deepEqual(f.started, ['a', 'b', 'c']);
    assert.equal(f.runner.statuses(f.plan.id)!.find(item => item.key === 'a')!.dispatch, undefined);
  } finally { await f.close(); }
  const g = await runnerFixture([lane('a')], { state: 'running' });
  try {
    await g.runner.advanceAll({ startup: true });
    assert.deepEqual(g.started, []);
    assert.equal(g.runner.statuses(g.plan.id)![0]!.startable, true);
  } finally { await g.close(); }
});

test('a restart adopts the lanes that already exist and fills only the free slots; a second runner never starts a duplicate', async () => {
  const f = await runnerFixture([lane('a'), lane('b'), lane('c')], { state: 'running', dispatch: dispatch({ lanes: 2 }) });
  try {
    // A lane for a from before the window reloaded, whose start was never saved on the plan.
    f.lanes.set('0000000000aa', { name: 'Job a', state: 'exited', branch: 'lane/a', baseCommit: sha('b'), plan: { planId: f.plan.id, jobKey: 'a', attempt: 0 } });
    await f.runner.advanceAll({ startup: true });
    assert.equal(f.byKey('a').laneId, '0000000000aa', 'adopted, not started again');
    assert.deepEqual(f.started, ['b'], 'Auto-dispatch starts at window start, in the one free slot');
    const again = new PlanRunner(f.options());
    await Promise.all([again.advanceAll({ startup: true }), again.advanceAll(), f.runner.advanceAll()]);
    assert.deepEqual(f.started, ['b'], 'the same store and lanes: nothing new');
    again.dispose();
    assert.equal(f.running(), 2);
  } finally { await f.close(); }
});

test('Stop all: nothing dispatches while stopped, not even by turning the mode on; resuming fills the slots once', async () => {
  const stop = new StopSwitch(fakeStopStore(new Map()));
  await stop.stop('Stopped with "Hydra: Stop All Agents".');
  const f = await runnerFixture([lane('a'), lane('b'), lane('c')], { state: 'running' }, { stop });
  try {
    await f.runner.setDispatch(f.plan.id, dispatch({ lanes: 2 }));
    await f.runner.advanceAll({ startup: true });
    await f.runner.advance(f.plan.id);
    assert.deepEqual(f.started, []);
    assert.deepEqual(f.get().dispatch, dispatch({ lanes: 2 }), 'the setting is saved all the same');
    await stop.resume();
    await Promise.all([f.runner.advance(f.plan.id), f.runner.advanceAll()]);
    assert.deepEqual(f.started, ['a', 'b']);
  } finally { await f.close(); }
});

test('turning the mode off leaves running lanes alone and stops new dispatch: ready jobs wait for Start lane', async () => {
  const f = await runnerFixture([lane('a'), lane('b'), lane('c', { dependsOn: ['a'] })], { dispatch: dispatch({ lanes: 1 }) });
  try {
    await f.runner.run(f.plan.id);
    assert.deepEqual(f.started, ['a']);
    await f.runner.setDispatch(f.plan.id, undefined);
    assert.equal(f.get().dispatch, undefined);
    assert.deepEqual(f.started, ['a'], 'b was waiting for a slot; it doesn\'t start now');
    assert.equal(f.lanes.get(f.byKey('a').laneId!)!.state, 'running', 'a\'s lane carries on');
    await f.done(f.runner, 'a');
    await f.runner.advanceAll();
    assert.deepEqual(f.started, ['a']);
    const statuses = f.runner.statuses(f.plan.id)!;
    for (const key of ['b', 'c']) {
      const view = statuses.find(item => item.key === key)!;
      assert.deepEqual([view.startable, view.reason, view.dispatch], [true, 'Ready to start: press Start lane.', undefined], key);
    }
    await f.runner.startJob(f.plan.id, 'c');
    assert.deepEqual(f.started, ['a', 'c'], 'Start lane is yours');
    // Turning it on again dispatches what is ready.
    await f.runner.setDispatch(f.plan.id, dispatch({ lanes: 2 }));
    assert.deepEqual(f.started, ['a', 'c', 'b']);
  } finally { await f.close(); }
});

test('gate failures count attempts on the job; the last one fails it and skips the jobs after it; Retry starts over', async () => {
  const f = await runnerFixture([lane('a'), lane('b', { dependsOn: ['a'] })], { dispatch: dispatch({ attempts: 2 }) });
  try {
    await f.runner.run(f.plan.id);
    const laneId = f.byKey('a').laneId!;
    assert.deepEqual(await f.runner.recordGateFailure(f.plan.id, 'a', laneId, 'unit (command): exit 1'), { failures: 1, attempts: 2, failed: false });
    assert.deepEqual(f.runner.statuses(f.plan.id)!.find(item => item.key === 'a')!.dispatch, { attempt: 2, attempts: 2 });
    assert.equal(await f.runner.recordGateFailure(f.plan.id, 'a', '0000000000ff', 'x'), undefined, 'not from another lane');
    assert.deepEqual(await f.runner.recordGateFailure(f.plan.id, 'a', laneId, 'unit (command): exit 1\nlint (command): exit 2'), { failures: 2, attempts: 2, failed: true });
    assert.deepEqual([f.byKey('a').outcome?.state, f.byKey('a').outcome?.reason], ['failed', 'Gates failed 2 times: unit (command): exit 1 lint (command): exit 2']);
    assert.deepEqual([f.byKey('b').outcome?.state, f.byKey('b').outcome?.reason], ['skipped', 'Job a did not finish.']);
    assert.equal(f.get().state, 'incomplete');
    assert.equal(await f.runner.recordGateFailure(f.plan.id, 'a', laneId, 'late'), undefined, 'an ended job counts nothing more');
    await f.runner.retry(f.plan.id);
    assert.deepEqual([f.byKey('a').attempt, f.byKey('a').gateFailures], [1, undefined], 'a fresh try, with all its attempts');
    assert.deepEqual(f.started, ['a', 'a']);
  } finally { await f.close(); }
});

test('the setting is validated: lanes 1-4, Claude or Codex, attempts 1-5; the webview message too', async () => {
  assert.deepEqual(validatePlanDispatch({ lanes: 4, provider: 'codex', attempts: 5, extra: 1 }), { lanes: 4, provider: 'codex', attempts: 5 });
  for (const bad of [{ lanes: 0, provider: 'claude', attempts: 3 }, { lanes: 5, provider: 'claude', attempts: 3 }, { lanes: 1, provider: 'gpt', attempts: 3 }, { lanes: 1, provider: 'claude', attempts: 6 }, { lanes: 1.5, provider: 'claude', attempts: 3 }, null, []]) {
    assert.throws(() => validatePlanDispatch(bad), Error, JSON.stringify(bad));
  }
  assert.deepEqual(parseMessage({ type: 'planDispatch', id: 'abcdefabcdef', dispatch: { lanes: 2, provider: 'claude', attempts: 3 } }), { type: 'planDispatch', id: 'abcdefabcdef', dispatch: { lanes: 2, provider: 'claude', attempts: 3 } });
  assert.deepEqual(parseMessage({ type: 'planDispatch', id: 'abcdefabcdef', dispatch: null }), { type: 'planDispatch', id: 'abcdefabcdef', dispatch: null });
  assert.throws(() => parseMessage({ type: 'planDispatch', id: 'abcdefabcdef', dispatch: { lanes: 9, provider: 'claude', attempts: 3 } }), /Invalid auto-dispatch settings/);
  const f = await runnerFixture([lane('a')]);
  try {
    await assert.rejects(f.store.update(f.plan.id, plan => ({ ...plan, dispatch: { lanes: 7, provider: 'claude', attempts: 3 } })), /Lanes at once must be 1-4/);
    await assert.rejects(f.store.update(f.plan.id, plan => ({ ...plan, jobs: [{ ...plan.jobs[0]!, runAs: 'head', gateFailures: 1 }] })), /invalid gate failure count/);
  } finally { await f.close(); }
});

// ---- hydra_job_ready, end to end: real git, a fake terminal, fake gate commands ----

const unitGate = { lanes: 'onMerge', gates: [{ id: 'unit', type: 'command', command: ['unit'] }] };

async function laneFixture(jobs: PlanJob[], settings: PlanDispatch, gates?: unknown) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hydra-lane-dispatch-git-')));
  const repo = path.join(root, 'repo');
  await git(root, ['init', '-q', '-b', 'main', repo]);
  for (const [key, value] of [['user.email', 'test@example.invalid'], ['user.name', 'Test'], ['core.autocrlf', 'false']]) await git(repo, ['config', key!, value!]);
  await writeFile(path.join(repo, 'README.md'), 'hello\n');
  if (gates) { await mkdir(path.join(repo, '.hydra'), { recursive: true }); await writeFile(path.join(repo, '.hydra', 'gates.json'), JSON.stringify(gates)); }
  await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'init']);
  // Each gate command takes the next exit code from here (0 once it runs out); `hold` makes the next run wait.
  const exits: number[] = [];
  let hold: Promise<void> | undefined;
  const gatesRuntime: Partial<GateRuntime> = {
    pollMs: 5,
    runCommand: async () => { if (hold) await hold; return { exitCode: exits.shift() ?? 0, unavailable: false, interrupted: false, timedOut: false, logFailed: false, logged: true }; },
  };
  const laneStore = new LaneStore(path.join(root, 'storage'));
  await laneStore.load();
  const pty = fakePtyModule();
  const service = new LaneService({
    store: laneStore, repository: repo, worktreeRoot: () => undefined, pty,
    executable: async provider => path.join(root, 'bin', `${provider}.exe`), connected: async () => true,
    bridge: provider => ({ command: 'hydra.exe', args: ['hydra-mcp.cjs'], env: { HYDRA_LEAD_PROVIDER: provider } }),
    helpersDir: path.join(root, 'helpers'), configDirectory: path.join(root, 'storage', 'lanes'),
    syncIntervalMs: 60_000, env: () => ({ PATH: 'x' }),
    gatesExecutable: async provider => `fake-${provider}`, gatesLogDirectory: path.join(root, 'gates'), gatesRuntime,
  });
  const plans = new PlanStore(path.join(root, 'plans'));
  await plans.load();
  const plan = await plans.save({ ...createPlan({ title: 'Checkout' }), jobs, dispatch: settings });
  // As LanesController's laneLook, planLanes and startPlanLane do it.
  const runner = new PlanRunner({
    store: plans, repository: repo,
    look: {
      head: () => undefined,
      lane: id => { const item = service.record(id); return item && { name: item.name, state: item.state, branch: item.branch, baseCommit: item.baseCommit, ...(item.mergedHead ? { mergedHead: item.mergedHead } : {}) }; },
      planLanes: planId => service.lanes().filter(item => item.plan?.planId === planId).map(item => ({ laneId: item.id, jobKey: item.plan!.jobKey, attempt: item.plan!.attempt ?? 0 })),
      lanesAvailable: () => true,
    },
    startHead: async () => { throw new Error('no heads here'); },
    startLane: async (current, job, start) => {
      const link: LanePlanLink = { planId: current.id, jobKey: job.key, planTitle: current.title, jobTitle: job.title, ...(job.attempt ? { attempt: job.attempt } : {}), ...(current.dispatch ? { dispatched: true as const } : {}) };
      const created = await service.create({ name: laneNameFromTitle(job.title), provider: job.provider ?? current.dispatch?.provider ?? 'claude', goal: job.brief }, { ...(start.baseCommit ? { baseCommit: start.baseCommit } : {}), plan: link, brief: planLaneBrief(current.title, job, start.dependencies) });
      return { laneId: created.id };
    },
    cancelHead: async () => undefined, unlinkLane: id => service.unlinkPlan(id),
    commitSubjects: async () => [], changedFiles: async () => [], terminalsAvailable: () => true,
  });
  const checks: string[] = [];
  const dispatcher = new LaneDispatch({ lanes: service, runner: () => runner, enterDelayMs: 0, onChecked: (_id, check) => checks.push(check.kind) });
  const get = () => plans.get(plan.id)!;
  const byKey = (key: string) => get().jobs.find(item => item.key === key)!;
  const commit = async (worktree: string, file: string, text: string) => { await writeFile(path.join(worktree, file), text); await git(worktree, ['add', '-A']); await git(worktree, ['commit', '-qm', `change ${file}`]); return (await git(worktree, ['rev-parse', 'HEAD'])).trim(); };
  /** hydra_job_ready from a lane, then the check to its end. */
  const ready = async (laneId: string, note?: string) => { const answer = await dispatcher.ready(laneId, note); return { answer, check: await dispatcher.pending(laneId) }; };
  return {
    root, repo, service, pty, exits, plans, plan, runner, dispatcher, checks, get, byKey, commit, ready,
    hold: () => { let release!: () => void; hold = new Promise(resolve => { release = resolve; }); return () => { hold = undefined; release(); }; },
    close: async () => { runner.dispose(); await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); },
  };
}

test('a gate failure goes back to the same lane, with Enter, and counts an attempt; passing then marks the job done with its evidence and starts the next', async () => {
  const f = await laneFixture([lane('api'), lane('ui', { dependsOn: ['api'] })], dispatch({ lanes: 1, attempts: 3 }), unitGate);
  try {
    await f.runner.run(f.plan.id);
    const laneId = f.byKey('api').laneId!;
    const lane = f.service.get(laneId)!;
    const terminal = f.pty.spawned[0]!;
    assert.match(terminal.args.at(-1)!, /call hydra_job_ready; Hydra then runs the gates, marks the job done if they pass, and types any failures here for you to fix\./, 'its first prompt says how the job ends');
    assert.equal(f.dispatcher.handles(laneId), true);

    // Nothing committed yet: the agent hears so at once, and no attempt counts.
    assert.deepEqual(await f.dispatcher.ready(laneId), { checking: false, message: 'Nothing to hand on yet: commit your work, then call hydra_job_ready again.' });
    const head = await f.commit(lane.worktree, 'api.ts', 'api\n');
    f.exits.push(1);
    const failed = await f.ready(laneId);
    assert.equal(failed.answer.checking, true);
    assert.match(failed.answer.message, /Hydra is running the gates on [a-f0-9]{7}\./);
    assert.deepEqual({ ...failed.check, text: undefined }, { kind: 'retry', failures: 1, attempts: 3, sent: true, text: undefined });
    const typed = terminal.written.join('');
    assert.match(typed, /unit/);
    assert.ok(typed.endsWith(`${dispatchGatesEnding}\r`), 'the failures, then Enter');
    assert.equal(terminal.written.at(-1), '\r', 'Enter on its own write');
    assert.doesNotMatch(typed.slice(0, -1), /[\r\n]/, 'one line: nothing is sent early');
    assert.equal(f.byKey('api').gateFailures, 1);
    assert.equal(f.pty.spawned.length, 1, 'the same lane; no new one');

    // Fixed and committed: the gates pass, the job is done with its commit, files and evidence status.
    const fixed = await f.commit(lane.worktree, 'api.test.ts', 'test\n');
    assert.notEqual(fixed, head);
    const passed = await f.ready(laneId, 'The API is in api.ts.');
    assert.deepEqual(passed.check, { kind: 'passed', commit: fixed });
    const result = f.byKey('api').result!;
    assert.deepEqual([result.commit, result.via, result.note, result.changedFiles, result.status], [fixed, 'marked', 'The API is in api.ts.', ['api.test.ts', 'api.ts'], 'passed']);
    assert.ok(f.byKey('ui').laneId, 'the job after it starts in the freed slot');
    assert.equal(f.pty.spawned.length, 2);
    assert.equal(f.dispatcher.handles(laneId), false, 'a done job is no longer Hydra\'s to check');
    assert.deepEqual(f.checks, ['retry', 'passed']);
  } finally { await f.close(); }
});

test('when the attempts run out the job fails with the reason and the jobs after it are skipped; nothing more is typed', async () => {
  const f = await laneFixture([lane('api'), lane('ui', { dependsOn: ['api'] })], dispatch({ lanes: 1, attempts: 2 }), unitGate);
  try {
    await f.runner.run(f.plan.id);
    const laneId = f.byKey('api').laneId!;
    await f.commit(f.service.get(laneId)!.worktree, 'api.ts', 'api\n');
    f.exits.push(1, 1);
    assert.equal((await f.ready(laneId)).check?.kind, 'retry');
    const writes = f.pty.spawned[0]!.written.length;
    const last = await f.ready(laneId);
    assert.equal(last.check?.kind, 'failed');
    assert.match(last.check!.kind === 'failed' ? last.check.reason : '', /^Gates failed 2 times: unit \(command\): exit 1/);
    assert.equal(f.pty.spawned[0]!.written.length, writes, 'the lane is yours now: nothing typed');
    assert.deepEqual([f.byKey('api').outcome?.state, f.byKey('ui').outcome?.state, f.byKey('ui').outcome?.reason], ['failed', 'skipped', 'Job api did not finish.']);
    assert.equal(f.get().state, 'incomplete');
    assert.equal(f.pty.spawned.length, 1, 'ui never started');
    assert.equal(f.service.get(laneId)?.state, 'running', 'the lane stays open');
    assert.equal(f.dispatcher.handles(laneId), false);
  } finally { await f.close(); }
});

test('a manual Mark job done wins over a check in flight, whether its gates then fail or pass', async () => {
  const f = await laneFixture([lane('api'), lane('docs')], dispatch({ lanes: 2 }), unitGate);
  try {
    await f.runner.run(f.plan.id);
    for (const [key, exit] of [['api', 1], ['docs', 0]] as const) {
      const laneId = f.byKey(key).laneId!;
      const commit = await f.commit(f.service.get(laneId)!.worktree, `${key}.ts`, `${key}\n`);
      f.exits.push(exit);
      const release = f.hold();
      const answer = await f.dispatcher.ready(laneId);
      assert.equal(answer.checking, true);
      assert.deepEqual(await f.dispatcher.ready(laneId), { checking: true, message: 'Hydra is already running the gates for this job. Wait: if they fail, the failures are typed here.' }, 'one check at a time');
      await f.runner.markLaneDone(f.plan.id, key, laneId, { commit, note: 'By hand.', changedFiles: [`${key}.ts`] });
      const writes = f.pty.spawned.find(item => item.options?.cwd === f.service.get(laneId)!.worktree)!.written.length;
      release();
      assert.deepEqual(await f.dispatcher.pending(laneId), { kind: 'ended' }, key);
      assert.deepEqual([f.byKey(key).result?.note, f.byKey(key).gateFailures], ['By hand.', undefined], `${key}: yours stands, and no attempt counts`);
      assert.equal(f.pty.spawned.find(item => item.options?.cwd === f.service.get(laneId)!.worktree)!.written.length, writes, `${key}: nothing typed`);
    }
  } finally { await f.close(); }
});

test('a project without gates for lanes passes as "No gates configured"; a plan without the setting still asks you', async () => {
  const f = await laneFixture([lane('api')], dispatch(), undefined);
  try {
    await f.runner.run(f.plan.id);
    const laneId = f.byKey('api').laneId!;
    const commit = await f.commit(f.service.get(laneId)!.worktree, 'api.ts', 'api\n');
    assert.deepEqual((await f.ready(laneId)).check, { kind: 'passed', commit });
    assert.deepEqual([f.byKey('api').result?.commit, f.byKey('api').result?.status], [commit, 'none']);
    // Mode off: the check is no longer Hydra's; LanesController shows the Mark job done prompt as before.
    const other = await f.plans.save({ ...createPlan({ title: 'Manual' }), state: 'running', jobs: [lane('x')] });
    await f.runner.advance(other.id);
    const manual = f.plans.get(other.id)!.jobs[0]!.laneId!;
    assert.equal(f.dispatcher.handles(manual), false);
    assert.doesNotMatch(f.pty.spawned.at(-1)!.args.at(-1)!, /Hydra then runs the gates/);
  } finally { await f.close(); }
});

test('the first prompt of a dispatched lane says Hydra runs the gates; an ordinary plan lane\'s is unchanged', () => {
  const link: LanePlanLink = { planId: 'abcdefabcdef', jobKey: 'api', planTitle: 'Checkout', jobTitle: 'Build API' };
  const plain = lanePreamble({ name: 'Build API', branch: 'lane/x', goal: 'Build it', plan: link }, []);
  const dispatched = lanePreamble({ name: 'Build API', branch: 'lane/x', goal: 'Build it', plan: { ...link, dispatched: true } }, []);
  assert.match(plain, /call hydra_job_ready; the user marks the job done or merges the lane\./);
  assert.match(dispatched, /call hydra_job_ready; Hydra then runs the gates, marks the job done if they pass, and types any failures here for you to fix\..*Your task: Build it$/);
});

// ---- What you see ----

test('the plan header offers Auto-dispatch to lanes with its three settings; the lane tile says which attempt it is on', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { AgentsCanvas } = await import('../webview/AgentsCanvas');
  const { LanesView } = await import('../webview/LanesView');
  const base = { ...createPlan({ title: 'Checkout' }), jobs: [lane('api'), lane('ui', { dependsOn: ['api'] })] };
  const off = renderToStaticMarkup(React.createElement(AgentsCanvas, { heads: [], plans: [base], onAction: () => {} }));
  assert.match(off, /<input type="checkbox"\/> Auto-dispatch to lanes/);
  assert.doesNotMatch(off, /Lanes at once/);
  const on = renderToStaticMarkup(React.createElement(AgentsCanvas, { heads: [], plans: [{ ...base, dispatch: dispatch({ lanes: 3, provider: 'codex', attempts: 4 }) }], onAction: () => {} }));
  assert.match(on, /<input type="checkbox" checked=""\/> Auto-dispatch to lanes/);
  assert.match(on, /aria-label="Lanes at once"/); assert.match(on, /aria-label="Provider for new lanes"/); assert.match(on, /aria-label="Attempts before the job fails"/);
  assert.match(on, /<option value="3" selected="">3<\/option>/); assert.match(on, /<option value="codex" selected="">Codex<\/option>/); assert.match(on, /<option value="4" selected="">4<\/option>/);
  const heads = renderToStaticMarkup(React.createElement(AgentsCanvas, { heads: [], plans: [{ ...base, jobs: [{ key: 'h', title: 'Head job', brief: 'x', dependsOn: [] }] }], onAction: () => {} }));
  assert.doesNotMatch(heads, /Auto-dispatch/, 'a plan without lane jobs has nothing to dispatch');

  const tile = (planJob: Partial<NonNullable<import('../src/core/model').LaneView['planJob']>>) => renderToStaticMarkup(React.createElement(LanesView, {
    lanes: [{ id: '111111111111', name: 'Job api', provider: 'claude', repository: '/repo', worktree: '/w', branch: 'lane/x', baseCommit: sha('a'), target: 'main', createdAt: new Date().toISOString(), state: 'running', running: true,
      planJob: { planId: 'p1', planTitle: 'Checkout', jobKey: 'api', jobTitle: 'Job api', state: 'active', dependents: 1, dependentsStarted: 0, ...planJob } }],
    terminals: true, onSend: () => {}, onFocused: () => {},
  }));
  assert.match(tile({ dispatch: { attempt: 2, attempts: 3 } }), /Auto-dispatched · attempt 2 of 3/);
  assert.match(tile({ dispatch: { attempt: 2, attempts: 3 } }), /Mark job done/, 'you can still mark it done yourself');
  assert.doesNotMatch(tile({}), /Auto-dispatched/);
});
