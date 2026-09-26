import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../src/core/git';
import { JobStore } from '../src/core/jobs';
import { HelperEndpoint, callHelperEndpoint } from '../src/core/helperEndpoint';
import { HelperService, type HelperServiceOptions } from '../src/core/helperService';
import type { HelperRun, HelperRunSpec } from '../src/core/helperRunner';
import type { HeadLimit } from '../src/core/limitDetection';
import { StopSwitch, fakeStopStore } from '../src/core/stopSwitch';
import { LaneStore } from '../src/core/lanes';
import { LaneService } from '../src/core/laneService';
import { fakePtyModule } from './lanePtyFake';
import { createPlan, PlanStore, type PlanJob } from '../src/core/plans';
import { PlanRunner, type PlanHeadLook, type PlanLaneLook, type PlanLook, type PlanRunnerOptions } from '../src/core/planRunner';

/** A scripted stand-in for a head process (trimmed from tests/helperService.test.ts's fixture). */
type Script = (helper: { spec: HelperRunSpec; call: (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>; endTurn: () => void }) => Promise<void>;

async function helperFixture(options: { script: Script; maxConcurrent?: number; stop?: StopSwitch }) {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-stopall-helpers-'));
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await git(root, ['init', '-q', '-b', 'main', repo]);
  await git(repo, ['config', 'user.email', 'test@example.invalid']); await git(repo, ['config', 'user.name', 'Test']);
  await writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'init']);
  const store = new JobStore(path.join(root, 'storage')); await store.load();
  let service!: HelperService;
  const endpoint = new HelperEndpoint((caller, tool, args, signal) => service.handle(caller, tool, args, signal));
  const port = await endpoint.start();
  const runs: HelperRunSpec[] = [];
  service = new HelperService({
    store, endpoint, leadFolder: repo, leadKey: 'window', worktreeRoot: () => path.join(root, 'worktrees'),
    executable: async provider => `fake-${provider}`, bridge: { command: 'hydra.exe', args: ['hydra-mcp.cjs'] },
    logDirectory: path.join(root, 'logs'), maxConcurrent: () => options.maxConcurrent ?? 2, watchdogMs: 20,
    ...(options.stop ? { stop: options.stop } : {}),
    startRun: spec => {
      runs.push(spec);
      const listeners: (() => void)[] = []; let exit!: (code: number) => void; let stopped = false; let limit: HeadLimit | undefined;
      const exited = new Promise<{ code: number | null }>(resolve => { exit = code => { if (!stopped) { stopped = true; resolve({ code }); } }; });
      const run: HelperRun = {
        onTurnEnd: listener => { listeners.push(listener); }, exited,
        send: async () => false,
        stop: async () => exit(137),
        limitHit: () => limit,
      };
      const token = spec.bridge.env.HYDRA_HELPER_TOKEN!;
      setTimeout(() => void options.script({
        spec,
        call: (tool, args = {}) => callHelperEndpoint(Number(spec.bridge.env.HYDRA_HELPER_PORT), token, tool, args),
        endTurn: () => { for (const listener of listeners) listener(); },
      }).catch(() => undefined), 0);
      return run;
    },
  } as HelperServiceOptions);
  const lead = endpoint.issue({ role: 'lead', leadKey: 'window' });
  const call = (tool: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; result?: any; error?: string }> => callHelperEndpoint(port, lead, tool, args);
  const start = async (key: string, extra: Record<string, unknown> = {}): Promise<any> => call('hydra_start_head', { title: `Job ${key}`, brief: 'Do the thing.', write_scope: ['src/'], idempotency_key: key, ...extra });
  return { root, repo, store, service, endpoint, runs, call, start, close: async () => { await service.dispose(); await endpoint.close(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) { if (Date.now() > deadline) throw new Error(`Timed out waiting: ${what}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}

test('StopSwitch: stop and resume persist through the injected store, over a fresh instance', async () => {
  const backing = new Map<string, unknown>();
  const a = new StopSwitch(fakeStopStore(backing), () => 1_700_000_000_000);
  assert.equal(a.isStopped(), false);
  assert.doesNotThrow(() => a.assertRunning('Doing a thing'));
  await a.stop('Stopped for a test.');
  assert.equal(a.isStopped(), true);
  assert.throws(() => a.assertRunning('Starting a head'), /Hydra is stopped \(since .+\): Starting a head is refused\. Run "Hydra: Resume Agents" to allow it again\./);
  // A fresh instance over the same backing store (an extension reload): still stopped.
  const b = new StopSwitch(fakeStopStore(backing));
  assert.equal(b.isStopped(), true);
  assert.equal(b.reason(), 'Stopped for a test.');
  await b.resume();
  assert.equal(b.isStopped(), false);
  // The first instance never hears about it on its own, but the store (and a third instance) does.
  const c = new StopSwitch(fakeStopStore(backing));
  assert.equal(c.isStopped(), false);
  const changes: boolean[] = [];
  const subscription = c.onChange(() => changes.push(c.isStopped()));
  await c.stop('again');
  subscription.dispose();
  assert.deepEqual(changes, [true]);
});

test('hydra_start_head is refused while stopped, with the reason; a new HelperService over the same store stays refused', async () => {
  const backing = new Map<string, unknown>();
  const stop = new StopSwitch(fakeStopStore(backing));
  await stop.stop('Stopped with "Hydra: Stop All Agents".');
  const f = await helperFixture({ stop, script: async () => { throw new Error('never runs'); } });
  try {
    const started = await f.start('one');
    assert.equal(started.ok, false);
    assert.match(started.error, /Hydra is stopped.*Starting a head is refused.*Resume Agents/);
    assert.equal(f.runs.length, 0, 'no head process was ever started');
    // A fresh service over the same job store and a fresh StopSwitch over the same backing: still refused.
    await f.service.dispose(); await f.endpoint.close();
    const store2 = f.store; // same on-disk store
    const stop2 = new StopSwitch(fakeStopStore(backing));
    assert.equal(stop2.isStopped(), true);
    let service2!: HelperService;
    const endpoint2 = new HelperEndpoint((caller, tool, args, signal) => service2.handle(caller, tool, args, signal));
    const port2 = await endpoint2.start();
    service2 = new HelperService({
      store: store2, endpoint: endpoint2, leadFolder: f.repo, leadKey: 'window', worktreeRoot: () => undefined,
      executable: async provider => `fake-${provider}`, bridge: { command: 'hydra.exe', args: ['hydra-mcp.cjs'] },
      logDirectory: path.join(f.root, 'logs2'), maxConcurrent: () => 2, stop: stop2,
      startRun: () => { throw new Error('a head must not start while stopped'); },
    });
    const lead2 = endpoint2.issue({ role: 'lead', leadKey: 'window' });
    const again = await callHelperEndpoint(port2, lead2, 'hydra_start_head', { title: 'Job two', brief: 'x', write_scope: ['src/'], idempotency_key: 'two' });
    assert.equal(again.ok, false);
    assert.match(again.error || '', /Hydra is stopped/);
    await service2.dispose(); await endpoint2.close();
  } finally { await f.close(); }
});

test('Stop All Agents cancels a running head and a queued one; resuming lets a fresh head start', async () => {
  const backing = new Map<string, unknown>();
  const stop = new StopSwitch(fakeStopStore(backing));
  const f = await helperFixture({ maxConcurrent: 1, stop, script: async helper => { await helper.call('hydra_progress', { note: 'working' }); } });
  try {
    const first = await f.start('one');
    const second = await f.start('two');
    await until(() => f.store.get(first.result.job_id)?.state === 'running', 'first head running');
    assert.equal(f.store.get(second.result.job_id)?.state, 'queued', 'the second waits behind maxConcurrent');
    await stop.stop('Stopped with "Hydra: Stop All Agents".');
    const stopped = await f.service.stopAll(stop.reason());
    assert.equal(stopped, 2, 'both the running and the queued head were open');
    assert.equal(f.store.get(first.result.job_id)?.state, 'cancelled');
    assert.equal(f.store.get(second.result.job_id)?.state, 'cancelled');
    // Refused while stopped, whether the head would run at once or queue behind the cap.
    const refused = await f.start('three');
    assert.equal(refused.ok, false);
    await stop.resume();
    const third = await f.start('three');
    assert.equal(third.ok, true);
    await until(() => f.store.get(third.result.job_id)?.state === 'running', 'a head starts again after resume');
  } finally { await f.close(); }
});

test('lane: create, resume, restart and switchProvider are refused while stopped; Stop All Agents ends a lane\'s process but keeps the lane and its worktree', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-stopall-lanes-'));
  const repo = path.join(root, 'repo');
  await git(root, ['init', '-q', '-b', 'main', repo]);
  await git(repo, ['config', 'user.email', 'test@example.invalid']); await git(repo, ['config', 'user.name', 'Test']);
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'init']);
  const pty = fakePtyModule();
  const store = new LaneStore(path.join(root, 'storage'));
  await store.load();
  const backing = new Map<string, unknown>();
  const stop = new StopSwitch(fakeStopStore(backing));
  const killed: number[] = [];
  const service = new LaneService({
    store, repository: repo, worktreeRoot: () => undefined, pty,
    executable: async provider => path.join(root, 'bin', `${provider}.exe`),
    connected: async () => true,
    bridge: provider => ({ command: 'hydra.exe', args: ['hydra-mcp.cjs'], env: { ELECTRON_RUN_AS_NODE: '1', HYDRA_LEAD_PROVIDER: provider } }),
    helpersDir: path.join(root, 'helpers'), configDirectory: path.join(root, 'storage', 'lanes'),
    onChange: () => {}, onData: () => {}, killTree: async pid => { killed.push(pid); }, syncIntervalMs: 60_000,
    env: () => ({ PATH: 'x' }),
    stop,
  });
  try {
    const lane = await service.create({ name: 'Checkout fix', provider: 'claude', goal: 'Fix it' });
    const [first] = pty.spawned;
    assert.equal(service.get(lane.id)?.state, 'running');

    await stop.stop('Stopped with "Hydra: Stop All Agents".');
    await assert.rejects(service.create({ name: 'Second', provider: 'claude' }), /Hydra is stopped/);
    await assert.rejects(service.resume(lane.id), /Hydra is stopped/);
    await assert.rejects(service.restart(lane.id), /Hydra is stopped/);
    await assert.rejects(service.switchProvider(lane.id, 'manual'), /Hydra is stopped/);

    // Stop All Agents itself: end the lane's process, keep the lane and its worktree.
    const stoppedCount = await service.stopProcesses();
    assert.equal(stoppedCount, 1);
    await until(() => service.get(lane.id)?.state === 'exited', 'the lane\'s process ends, but the lane stays');
    assert.equal(killed.includes(first!.pid), true);
    assert.equal(service.exists(lane.id), true, 'the lane is kept, not closed');
    await assert.rejects(service.resume(lane.id), /Hydra is stopped/, 'still refused: the global stop, not "already running", is why');

    await stop.resume();
    await service.resume(lane.id);
    assert.equal(pty.spawned.length, 2, 'resume relaunches the CLI once Hydra is resumed');
    assert.equal(service.get(lane.id)?.state, 'running');
  } finally { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

// ---- Plans ----

const job = (key: string, extra: Partial<PlanJob> = {}): PlanJob => ({ key, title: `Job ${key}`, brief: `Do ${key}.`, dependsOn: [], ...extra });

async function planFixture(jobs: PlanJob[], stop?: StopSwitch) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-stopall-plans-'));
  const store = new PlanStore(directory);
  await store.load();
  const plan = await store.save({ ...createPlan({ title: 'Checkout' }), jobs, state: 'running' as const });
  const heads = new Map<string, PlanHeadLook>();
  const lanes = new Map<string, PlanLaneLook>();
  const look: PlanLook = { head: id => heads.get(id), lane: id => lanes.get(id), planLanes: () => [], lanesAvailable: () => true };
  const started: string[] = [];
  const options: PlanRunnerOptions = {
    store, look, repository: directory,
    startHead: async (_current, item) => { started.push(item.key); const id = 'a'.repeat(12); heads.set(id, { state: 'running', title: item.title }); return { jobId: id }; },
    startLane: async () => { throw new Error('no lane jobs in this fixture'); },
    cancelHead: async () => {}, unlinkLane: async () => {},
    commitSubjects: async () => [], changedFiles: async () => [],
    terminalsAvailable: () => true,
    debounceMs: 1,
    ...(stop ? { stop } : {}),
  };
  const runner = new PlanRunner(options);
  return { store, plan, started, runner, get: () => store.get(plan.id)!, close: async () => { runner.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

test('a plan does not advance (starts nothing) while stopped, and advances again once resumed', async () => {
  const backing = new Map<string, unknown>();
  const stop = new StopSwitch(fakeStopStore(backing));
  await stop.stop('Stopped with "Hydra: Stop All Agents".');
  const f = await planFixture([job('build')], stop);
  try {
    await f.runner.advance(f.plan.id);
    assert.deepEqual(f.started, [], 'nothing starts while stopped');
    assert.equal(f.get().jobs[0]!.jobId, undefined);
    await f.runner.advanceAll({ startup: true });
    assert.deepEqual(f.started, [], 'advanceAll at startup does nothing either');

    await stop.resume();
    await f.runner.advance(f.plan.id);
    assert.deepEqual(f.started, ['build']);
    assert.equal(f.get().jobs[0]!.jobId, 'a'.repeat(12));
  } finally { await f.close(); }
});
