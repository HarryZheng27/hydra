import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HydraController, type ControllerIde, type ControllerLanes, type TreeUpdate } from '../src/host/controller';
import { PlanStore, type Plan } from '../src/core/plans';
import { StopSwitch } from '../src/core/stopSwitch';
import { AuditLog } from '../src/core/audit';
import type { ClientMessage, Snapshot } from '../src/core/model';
import { JobStore } from '../src/core/jobs';
import type { HelperService } from '../src/core/helperService';
import type { PackService } from '../src/core/packs/service';
import type { HeadSandbox } from '../src/core/headSandbox';
import { LimitOfferTracker } from '../src/core/limitOffer';
import { FakeHost } from './host/fakeHost';

/** The controller with no editor (docs/internal/hydra-app/G2-host-split.md): a FakeHost, fake lanes and a temporary plan store. */
async function setup(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hydra-controller-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = new FakeHost({ storage: root, dist: path.join(root, 'dist'), appRoot: path.join(root, 'app') });
  const ideMessages: ClientMessage[] = [], trees: TreeUpdate[] = [];
  let agentsOpen = true, opened = 0, ready = 0;
  const ide: ControllerIde = {
    view: () => ({ mode: 'agents', busy: false }),
    handle: async message => { ideMessages.push(message); },
    uiReady: () => { ready++; },
    agentsOpen: () => agentsOpen,
    showingAgents: () => true,
    openAgents: async () => { opened++; agentsOpen = true; },
    tree: update => { trees.push(update); },
    inHandoff: () => false,
    refreshSettingsPages: async () => {},
    showSettings: () => {},
    accounts: () => ({ claude: { status: 'unchecked' }, codex: { status: 'unchecked' } }),
    connectionsChanged: () => {}, desktop: () => false, openOfficial: async () => {},
    report: error => { throw error; },
  };
  const laneMessages: unknown[] = [];
  const lanes: ControllerLanes = {
    available: false, state: () => ({ lanes: [], terminals: false }), laneLook: () => undefined, planLanes: () => [],
    startPlanLane: async () => ({ wait: 'no lanes' }), unlinkPlan: async () => {}, laneName: () => undefined, show: async () => {},
    planStatesChanged: () => {}, handle: async message => { laneMessages.push(message); }, webviewReady: () => {},
    start: async () => {}, stop: async () => {}, stopProcesses: async () => 0, exists: () => false, describe: async () => ({ lanes: [] }),
    jobReady: async () => ({}), openWorktrees: () => [], activeRolesChanged: async () => {}, onLimitEvent: async () => {}, laneForAttention: () => undefined, onAttention: () => {}, laneWorktreeEntries: () => [], runningLanes: () => [], laneEvidence: () => undefined, laneGatesLogRoot: () => undefined,
  };
  const store = new PlanStore(path.join(root, 'plans'));
  await store.load();
  const stopValues = new Map<string, unknown>();
  const stop = new StopSwitch({ get: <T>(key: string, fallback: T) => (stopValues.has(key) ? stopValues.get(key) : fallback) as T, update: async (key, value) => { stopValues.set(key, value); } });
  const packs = { gates: undefined, roles: async () => [], places: () => ({}), state: async () => ({ packs: [] }) } as unknown as PackService;
  const headSandbox = { shell: async () => ({ kind: 'unconfined' }), reset: () => {} } as unknown as HeadSandbox;
  const controller = new HydraController({ host, ide, lanes, stop, audit: new AuditLog({ file: path.join(root, 'audit', 'audit.jsonl') }), packs, headSandbox, storageDirectory: path.join(root, 'workspaces', 'lead'), leadKey: 'lead', quota: { refresh: async () => {}, snapshot: () => ({ status: 'unchecked', text: '' }) }, limitOfferTracker: new LimitOfferTracker() });
  controller.plans = { store, planning: new Map() };
  return { host, controller, store, ideMessages, trees, laneMessages, closeAgents: () => { agentsOpen = false; }, counts: () => ({ opened, ready }) };
}
const snapshots = (host: FakeHost) => host.posted.filter((message): message is { type: 'snapshot'; snapshot: Snapshot } => (message as { type?: string }).type === 'snapshot').map(message => message.snapshot);
const planNamed = (store: PlanStore, title: string): Plan => { const plan = store.list().find(item => item.title === title); assert.ok(plan, `plan ${title}`); return plan; };

test('the controller publishes a snapshot with the IDE part, settings and plans', async t => {
  const { host, controller, store } = await setup(t);
  host.set('defaultProvider', 'codex');
  await controller.handle({ type: 'planCreateEmpty', title: 'Checkout' });
  await controller.publish();
  const snapshot = snapshots(host).at(-1)!;
  assert.equal(snapshot.mode, 'agents');
  assert.equal(snapshot.defaultProvider, 'codex');
  assert.deepEqual(snapshot.plans?.map(plan => plan.title), ['Checkout']);
  assert.ok(host.posted.some(message => (message as { type?: string }).type === 'plans'), 'plan changes go out at once');
  assert.equal(planNamed(store, 'Checkout').state, 'draft');
});

test('ready publishes, and a New plan asked for while the view loaded is shown then', async t => {
  const { host, controller, closeAgents, counts } = await setup(t);
  closeAgents();
  await controller.newPlan();
  assert.equal(counts().opened, 1);
  assert.ok(!host.posted.some(message => (message as { type?: string }).type === 'showNewPlan'));
  await controller.handle({ type: 'ready' });
  assert.equal(counts().ready, 1);
  assert.ok(host.posted.some(message => (message as { type?: string }).type === 'snapshot'));
  assert.equal(host.posted.filter(message => (message as { type?: string }).type === 'showNewPlan').length, 1);
  await controller.newPlan();
  assert.equal(host.posted.filter(message => (message as { type?: string }).type === 'showNewPlan').length, 2, 'an open view shows it at once');
});

test('lane messages go to the lanes, and IDE-only messages back to the IDE', async t => {
  const { controller, ideMessages, laneMessages } = await setup(t);
  await controller.handle({ type: 'laneAttach' });
  await controller.handle({ type: 'editor' });
  await controller.handle({ type: 'checkProvider', provider: 'claude' });
  assert.deepEqual(laneMessages, [{ type: 'laneAttach' }]);
  assert.deepEqual(ideMessages.map(message => message.type), ['editor', 'checkProvider']);
  await controller.handle({ type: 'planCreateEmpty', title: 'Kept here' });
  await controller.handle({ type: 'trayClear', ids: [] });
  assert.deepEqual(ideMessages.map(message => message.type), ['editor', 'checkProvider'], 'plan and tray messages never reach the IDE');
  await assert.rejects(controller.handle({ type: 'nonsense' }), 'malformed messages are refused before routing');
  assert.equal(ideMessages.length, 2);
});

test('Clear in the Finished tray is kept in the host state', async t => {
  const { host, controller } = await setup(t);
  await controller.handle({ type: 'trayClear', ids: ['aaaaaaaaaaaa'] });
  assert.deepEqual(host.state.get('hydra.tray.dismissed.v1', []), ['aaaaaaaaaaaa']);
  assert.deepEqual(snapshots(host).at(-1)!.dismissedTray, ['aaaaaaaaaaaa']);
});

test('plan jobs are edited through the host: dependencies picked from a list, deletion confirmed', async t => {
  const { host, controller, store } = await setup(t);
  await controller.handle({ type: 'planCreateEmpty', title: 'Build' });
  const id = planNamed(store, 'Build').id;
  await controller.handle({ type: 'planAddJob', id });
  await controller.handle({ type: 'planAddJob', id });
  await controller.handle({ type: 'planSaveJob', id, key: 'job-1', title: 'API', brief: 'Build the API.' });
  await controller.handle({ type: 'planSaveJob', id, key: 'job-2', title: 'UI', brief: 'Build the UI.' });
  host.picks.set('"UI" depends on', ['API']);
  await controller.handle({ type: 'planDependsOn', id, key: 'job-2' });
  assert.deepEqual(planNamed(store, 'Build').jobs.find(job => job.key === 'job-2')?.dependsOn, ['job-1']);
  host.picks.set('"UI" depends on', undefined);
  await controller.handle({ type: 'planDependsOn', id, key: 'job-2' });
  assert.deepEqual(planNamed(store, 'Build').jobs.find(job => job.key === 'job-2')?.dependsOn, ['job-1'], 'dismissing the list changes nothing');
  // A draft plan is deleted without asking; a running one asks first, and No keeps it.
  await store.update(id, plan => ({ ...plan, state: 'running' }));
  await controller.handle({ type: 'planDelete', id });
  assert.equal(host.confirms.at(-1)?.message, 'Delete plan Build?');
  assert.ok(store.get(id), 'not confirmed: kept');
  host.answers.set('Delete plan Build?', true);
  await controller.handle({ type: 'planDelete', id });
  assert.equal(store.get(id), undefined);
});

test('a plan report is Markdown built from the plan', async t => {
  const { controller, store } = await setup(t);
  await controller.handle({ type: 'planCreateEmpty', title: 'Report me' });
  const markdown = controller.planReportMarkdown(planNamed(store, 'Report me'));
  assert.match(markdown, /Report me/);
});

// ---- Milestone 3: the lead's plan tools and the plan board, through the controller ----

async function withRunner(t: { after(fn: () => Promise<void>): void }) {
  const context = await setup(t);
  const { controller, store, host } = context;
  const jobs = new JobStore(path.join(host.paths.storage, 'helpers'));
  await jobs.load();
  const service = { leadFolder: host.paths.storage, list: () => [], handle: async () => ({}), startForPlan: async () => { throw new Error('no heads in this test'); }, runIntegrationGate: async () => { throw new Error('no gates in this test'); } } as unknown as HelperService;
  controller.helpers = { store: jobs, endpoint: undefined as never, service, record: '' };
  controller.planRunner = controller.createPlanRunner(store, service, host.paths.storage, 'lead');
  t.after(async () => { controller.planRunner?.dispose(); });
  // Plans a lead makes wait for approval here, so nothing tries to start a head.
  host.set('plans.leadPlansNeedApproval', true);
  return context;
}
const leadInput = (key: string) => ({ title: 'From the chat', idempotencyKey: key, jobs: [{ key: 'api', title: 'API', brief: 'Build the API.', write_scope: ['src/api'] }, { key: 'ui', title: 'UI', brief: 'Build the UI.', write_scope: ['src/ui'], depends_on: ['api'] }] });

test('a lead creates a plan once per idempotency key, and only its own chat sees it', async t => {
  const { controller, store } = await withRunner(t);
  const bridge = controller.createPlanLeadBridge();
  const first = await bridge.create(leadInput('k1'), 'chat-a');
  assert.equal(first.created, true);
  assert.deepEqual(first.plan.jobs.map(job => job.key), ['api', 'ui']);
  const again = await bridge.create(leadInput('k1'), 'chat-a');
  assert.equal(again.created, false);
  assert.equal(again.plan.planId, first.plan.planId);
  assert.equal(store.list().length, 1);
  assert.equal(bridge.get(first.plan.planId, 'chat-b'), undefined, 'another chat never sees it');
  await assert.rejects(bridge.cancel(first.plan.planId, 'chat-b', 'no'), /No plan/);
  assert.equal(bridge.get(first.plan.planId, 'chat-a')?.title, 'From the chat');
  assert.match(await bridge.report(first.plan.planId, 'chat-a'), /From the chat/);
});

test('amendments are capped by the setting, and messages go only to the plan\'s own jobs', async t => {
  const { controller, host } = await withRunner(t);
  const bridge = controller.createPlanLeadBridge();
  const { plan } = await bridge.create(leadInput('k2'), 'chat-a');
  host.set('plans.maxAmendments', 1);
  await bridge.amend(plan.planId, 'chat-a', { add: [{ key: 'docs', title: 'Docs', brief: 'Write docs.', write_scope: ['docs'] }] });
  assert.deepEqual(bridge.get(plan.planId, 'chat-a')?.jobs.map(job => job.key), ['api', 'ui', 'docs']);
  await assert.rejects(bridge.amend(plan.planId, 'chat-a', { skip: [{ key: 'docs' }] } as never), /1 of 1 amendments/);
  await assert.rejects(bridge.message(plan.planId, 'chat-a', { to: ['nope'], body: 'hi' }), /No job "nope"/);
  await bridge.message(plan.planId, 'chat-a', { to: ['api'], body: 'Use token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 for it.' });
  const board = controller.createPlanBoardBridge().boardFor(plan.planId, 'api');
  assert.equal(board.length, 1);
  assert.doesNotMatch(JSON.stringify(board), /abcdefghijklmnopqrstuvwxyz0123456789/, 'board posts are redacted');
});

test('the board bridge finds a head\'s plan and its integration target', async t => {
  const { controller, store } = await withRunner(t);
  const { plan } = await controller.createPlanLeadBridge().create(leadInput('k3'), 'chat-a');
  await store.update(plan.planId, current => ({ ...current, jobs: current.jobs.map(job => job.key === 'api' ? { ...job, jobId: 'abcdefabcdef' } : job), integration: { branch: `hydra/plan-${plan.planId}`, base: 'a'.repeat(40), tip: 'b'.repeat(40), queue: [], landed: [] } }));
  const board = controller.createPlanBoardBridge();
  assert.deepEqual(controller.jobPlanFor('abcdefabcdef'), { planId: plan.planId, jobKey: 'api' });
  assert.equal(controller.jobPlanFor('000000000000'), undefined);
  assert.deepEqual(board.integrationTarget?.('abcdefabcdef'), { branch: `hydra/plan-${plan.planId}`, tip: 'b'.repeat(40) });
  assert.equal(board.unattended?.(plan.planId), false);
});
