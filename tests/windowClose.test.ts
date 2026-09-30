import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HelperEndpoint, type HelperCaller } from '../src/core/helperEndpoint';
import { HelperService, userPlanSession, type UserControl } from '../src/core/helperService';
import { JobStore } from '../src/core/jobs';
import type { AuditEvent } from '../src/core/audit';
import { closeRefusal, describeActivity, windowActivity, type WindowActivity } from '../src/core/windowClose';

/** HSEC-72 (docs/THREAT_MODEL.md; docs/Heads.md, "Scripts and CI"): `hydra close`'s refusal, in the window. */

const idle: WindowActivity = { heads: 0, lanes: 0, plans: 0, landing: 0 };
const integration = (extra: Record<string, unknown> = {}) => ({ queue: [], ...extra }) as never;

test('windowActivity counts unfinished heads, running lanes, plans in progress and plans still landing', () => {
  assert.deepEqual(windowActivity({ heads: [], lanes: [], plans: [] }), idle);
  assert.deepEqual(windowActivity({
    heads: [{ state: 'queued' }, { state: 'running' }, { state: 'blocked' }, { state: 'checking' }, { state: 'done' }, { state: 'failed' }, { state: 'cancelled' }],
    lanes: [{ running: true }, { running: false }, {}],
    plans: [
      { state: 'planning' }, { state: 'running', integration: integration({ queue: [{}] }) }, { state: 'draft' },
      // Finished, but still landing: a queued landing, one in flight, the integration gate running.
      { state: 'done', integration: integration({ queue: [{}] }) }, { state: 'incomplete', integration: integration({ inFlight: {} }) },
      { state: 'done', integration: integration({ gate: { running: true } }) },
      // Settled: the gate ran; merged; failed with nothing queued.
      { state: 'done', integration: integration({ gate: { running: false } }) }, { state: 'done', integration: integration({ queue: [{}], merged: {} }) }, { state: 'failed', integration: integration() },
    ],
  }), { heads: 4, lanes: 1, plans: 2, landing: 3 });
});

test('closeRefusal refuses while anything still works, unless forced, and says what and how to force it', () => {
  assert.equal(closeRefusal(idle, false), undefined);
  assert.equal(closeRefusal(idle, true), undefined);
  for (const busy of [{ heads: 1 }, { lanes: 1 }, { plans: 1 }, { landing: 1 }]) {
    const activity = { ...idle, ...busy };
    assert.match(closeRefusal(activity, false)!, /still working .*won't close.*hydra close --force/, JSON.stringify(busy));
    assert.equal(closeRefusal(activity, true), undefined, 'forced');
  }
  assert.equal(describeActivity({ heads: 2, lanes: 1, plans: 1, landing: 3 }), '2 heads, 1 lane, 1 plan in progress, 3 plans landing');
});

test('hydra_close in the window: refused and audited while work runs, closes once idle or forced, and checks its arguments', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-close-'));
  const store = new JobStore(path.join(root, 'storage')); await store.load();
  const endpoint = new HelperEndpoint(async () => ({}), { leadKey: 'window' });
  let activity: WindowActivity = { ...idle, heads: 1, landing: 1 };
  const closes: Parameters<NonNullable<UserControl['closeWindow']>>[0][] = [];
  const audit: AuditEvent[] = [];
  const control: UserControl = { stopAll: async () => ({ heads: 0, lanes: 0 }), resume: async () => undefined, activity: () => activity, closeWindow: request => { closes.push(request); } };
  const make = (withControl: UserControl | undefined) => new HelperService({
    store, endpoint, leadFolder: root, leadKey: 'window', executable: async provider => `fake-${provider}`, bridge: { command: 'x', args: [] },
    logDirectory: path.join(root, 'logs'), maxConcurrent: () => 1, startRun: () => { throw new Error('no heads in this test'); },
    ...(withControl ? { control: withControl } : {}), audit: event => { audit.push(event); },
  });
  const service = make(control);
  const user: HelperCaller = { role: 'user', leadKey: 'window', leadSessionId: userPlanSession };
  const close = (args: Record<string, unknown>, on = service) => on.handle(user, 'hydra_close', args, new AbortController().signal);
  try {
    await assert.rejects(close({}), /still working \(1 head, 1 plan landing\)/);
    assert.equal(closes.length, 0, 'nothing closes while work runs');
    assert.deepEqual(audit.map(event => [event.kind, event.role]), [['denial', 'user']]);

    assert.deepEqual(await close({ force: true, reason: '  bench  ' }), { closing: true, in_ms: 1500, forced: true, activity });
    assert.deepEqual(closes[0], { force: true, activity, reason: 'bench' });

    activity = { ...idle };
    assert.deepEqual(await close({}), { closing: true, in_ms: 1500, forced: false, activity: idle });
    assert.equal(closes.length, 2);

    await assert.rejects(close({ force: 'yes' }), /force must be true or false/);
    await assert.rejects(close({ reason: 3 }), /reason must be text/);
    // A window without the control (or without its close half) refuses, rather than closing unchecked.
    const bare = make(undefined), half = make({ stopAll: control.stopAll, resume: control.resume });
    await assert.rejects(close({}, bare), /not available/);
    await assert.rejects(close({ force: true }, half), /not available/);
    // Only the user role has it: a lead's or a head's call is an unknown action to the handler too.
    await assert.rejects(service.handle({ role: 'lead', leadKey: 'window', leadSessionId: 'aaaaaaaaaaaa' }, 'hydra_close', {}, new AbortController().signal), /Unknown Hydra action/);
    assert.equal(closes.length, 2);
    await bare.dispose(); await half.dispose();
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
