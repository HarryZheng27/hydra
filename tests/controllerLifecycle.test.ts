import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from '../src/core/git';
import { callHelperEndpoint } from '../src/core/helperEndpoint';
import type { HelperRun, HelperRunSpec } from '../src/core/helperRunner';
import type { AgentIsolation } from '../src/core/agentHome';
import { HydraController, type ControllerIde, type ControllerLanes } from '../src/host/controller';
import { StopSwitch } from '../src/core/stopSwitch';
import { AuditLog } from '../src/core/audit';
import type { Snapshot } from '../src/core/model';
import type { PackService } from '../src/core/packs/service';
import type { HeadSandbox } from '../src/core/headSandbox';
import { LimitOfferTracker } from '../src/core/limitOffer';
import { FakeHost } from './host/fakeHost';

/**
 * G2's acceptance test (docs/internal/hydra-app/G2-host-split.md): the controller end to end with no VS Code. A FakeHost
 * opens a fixture repository; the controller starts its heads service, endpoint, discovery record and plan runner; a plan
 * made and run through the Agents view's own messages runs a stand-in head (as tests/helperService.test.ts's do); and
 * the state it publishes shows the plan done. Shutting down removes what the window wrote.
 */
const noIsolation = async (): Promise<AgentIsolation> => ({ env: {}, codexArgs: [], claudePlugins: [] });

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!check()) { if (Date.now() > deadline) throw new Error(`Timed out waiting: ${what}`); await new Promise(resolve => setTimeout(resolve, 25)); }
}

test('the controller runs a plan end to end on a FakeHost, with a stand-in head', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hydra-controller-e2e-'));
  // Registered first, so it runs last: after the window has shut down (below).
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await git(root, ['init', '-q', '-b', 'main', repo]);
  await git(repo, ['config', 'user.email', 'test@example.invalid']); await git(repo, ['config', 'user.name', 'Test']);
  await writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'init']);

  const storage = path.join(root, 'storage');
  const host = new FakeHost({ storage, dist: path.join(root, 'dist'), appRoot: path.join(root, 'app') }, { maxConcurrentHelpers: 2 });
  host.folderPaths = [repo];
  host.machineValues.set('worktreeRoot', path.join(root, 'worktrees'));
  const ide: ControllerIde = {
    view: () => ({ mode: 'agents', busy: false }), handle: async () => {}, uiReady: () => {}, agentsOpen: () => true, showingAgents: () => true,
    openAgents: async () => {}, tree: () => {}, report: error => { host.log(`[report] ${error instanceof Error ? error.message : String(error)}`); },
    inHandoff: () => false, refreshSettingsPages: async () => {}, showSettings: () => {},
    accounts: () => ({ claude: { status: 'unchecked' }, codex: { status: 'unchecked' } }), connectionsChanged: () => {}, desktop: () => false, openOfficial: async () => {},
  };
  const lanes: ControllerLanes = {
    available: false, state: () => ({ lanes: [], terminals: false }), laneLook: () => undefined, planLanes: () => [],
    startPlanLane: async () => ({ wait: 'no lanes' }), unlinkPlan: async () => {}, laneName: () => undefined, show: async () => {},
    planStatesChanged: () => {}, handle: async () => {}, webviewReady: () => {}, start: async () => {}, stop: async () => {},
    stopProcesses: async () => 0, exists: () => false, describe: async () => ({ lanes: [] }), jobReady: async () => ({}), openWorktrees: () => [],
    activeRolesChanged: async () => {}, onLimitEvent: async () => {}, laneWorktreeEntries: () => [], runningLanes: () => [], laneEvidence: () => undefined, laneGatesLogRoot: () => undefined,
  };
  const stopValues = new Map<string, unknown>();
  const stop = new StopSwitch({ get: <T>(key: string, fallback: T) => (stopValues.has(key) ? stopValues.get(key) : fallback) as T, update: async (key, value) => { stopValues.set(key, value); } });
  const packs = { gates: undefined, roles: async () => [], places: () => ({}), state: async () => ({ packs: [] }) } as unknown as PackService;
  const runs: HelperRunSpec[] = [];
  const controller = new HydraController({
    host, ide, lanes, stop, audit: new AuditLog({ file: path.join(storage, 'audit', 'audit.jsonl') }), packs,
    headSandbox: {} as HeadSandbox, storageDirectory: path.join(storage, 'workspaces', 'e2e'), leadKey: 'e2e', quota: { refresh: async () => {}, snapshot: () => ({ status: 'unchecked', text: '' }) }, limitOfferTracker: new LimitOfferTracker(),
    helperService: {
      sandbox: undefined, gateRuntime: { isolation: noIsolation }, agentIsolation: noIsolation, watchdogMs: 20,
      executable: async provider => `fake-${provider}`,
      // The stand-in head: commits in its scope and reports done through the real endpoint, with its own token.
      startRun: spec => {
        runs.push(spec);
        let exit!: (code: number) => void, stopped = false;
        const listeners: (() => void)[] = [];
        const exited = new Promise<{ code: number | null }>(resolve => { exit = code => { if (!stopped) { stopped = true; resolve({ code }); } }; });
        const run: HelperRun = { onTurnEnd: listener => { listeners.push(listener); }, exited, send: async () => false, stop: async () => exit(137), limitHit: () => undefined };
        setTimeout(() => void (async () => {
          await writeFile(path.join(spec.worktree, 'src', 'b.ts'), 'export const b = 2;\n');
          await git(spec.worktree, ['add', '.']); await git(spec.worktree, ['commit', '-qm', 'head: b']);
          await callHelperEndpoint(Number(spec.bridge.env.HYDRA_HELPER_PORT), spec.bridge.env.HYDRA_HELPER_TOKEN!, 'hydra_done', { summary: 'Added b.ts' });
          for (const listener of listeners) listener();
        })().catch(error => host.log(`[stand-in] ${error instanceof Error ? error.message : String(error)}`)), 0);
        return run;
      },
    },
  });
  let shutDown = false;
  t.after(async () => { if (!shutDown) await controller.stopHelpers().catch(() => undefined); });

  await controller.acquireOwnership();
  assert.deepEqual(controller.repositories.length, 1, 'the fixture repository is this window\'s');
  await controller.startHelpers();
  assert.ok(controller.helpers, `heads started (log: ${host.logs.join(' | ')})`);
  assert.ok(host.logs.some(line => line.startsWith('[heads] ready for ')));
  const records = await readdir(path.join(storage, 'helpers', 'windows'));
  assert.ok(records.some(name => name.endsWith('.json')), 'the window wrote its discovery record');
  assert.equal((await readdir(path.join(storage, 'helpers', 'handshakes'))).length, 1, 'the window wrote its handshake for scripts');
  assert.ok(host.watchers.some(watcher => watcher.folder === repo && watcher.pattern === '.hydra/{packs.json,packs/**}'), 'it watches the project\'s packs');

  // A plan made and run through the Agents view's own messages.
  await controller.handle({ type: 'planCreateEmpty', title: 'End to end' });
  const id = controller.plans!.store.list().find(plan => plan.title === 'End to end')!.id;
  await controller.handle({ type: 'planAddJob', id });
  await controller.handle({ type: 'planSaveJob', id, key: 'job-1', title: 'Add b', brief: 'Add src/b.ts.' });
  await controller.plans!.store.update(id, plan => ({ ...plan, jobs: plan.jobs.map(job => ({ ...job, writeScope: ['src/'] })) }));
  await controller.handle({ type: 'planRun', id });
  await until(() => controller.plans!.store.get(id)?.state === 'done', `the plan finishes (state ${controller.plans!.store.get(id)?.state}; log: ${host.logs.slice(-5).join(' | ')})`);
  assert.equal(runs.length, 1, 'one stand-in head ran');

  // What the Agents view shows: the controller publishes the finished plan by itself, without being asked.
  const snapshots = () => host.posted.filter((message): message is { type: 'snapshot'; snapshot: Snapshot } => (message as { type?: string }).type === 'snapshot').map(message => message.snapshot);
  await until(() => snapshots().some(item => item.plans?.find(plan => plan.id === id)?.state === 'done'), 'a published snapshot shows the plan done');
  const snapshot = snapshots().at(-1)!;
  assert.equal(snapshot.helpers?.[0]?.state, 'done');
  assert.equal(snapshot.helpers?.[0]?.summary, 'Added b.ts');
  assert.equal(snapshot.plans?.find(plan => plan.id === id)?.state, 'done');

  // Stop all, then resume, are audited and reported through the host.
  await controller.stopAllAgents('Stopped for a test.', 'Stop all agents');
  assert.equal(stop.isStopped(), true);
  await controller.resumeAgents('Resume agents');
  assert.equal(stop.isStopped(), false);
  assert.ok(host.notices.some(notice => notice.message.startsWith('Hydra stopped')) && host.notices.some(notice => notice.message.startsWith('Hydra resumed')));

  // Shutting down removes the discovery record and the handshake for scripts.
  await controller.stopHelpers();
  await controller.releaseOwnership();
  shutDown = true;
  assert.equal(controller.helpers, undefined);
  assert.deepEqual((await readdir(path.join(storage, 'helpers', 'windows'))).filter(name => name.endsWith('.json') && !name.includes('summary')), []);
  assert.deepEqual(await readdir(path.join(storage, 'helpers', 'handshakes')), [], 'the handshake for scripts is gone');
});
