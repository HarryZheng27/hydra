import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CodexAdapter, codexArguments } from '../src/core/chat/codex';
import type { ChatEvent } from '../src/core/chat/events';
import { ChatSession } from '../src/core/chat/session';
import { fixtureFile, Harness, parts, type Rec } from './chatFixtures';

/** The text and images of a recorded turn/start. */
function turnInput(params: { input: Array<Record<string, any>> }) {
  const text = params.input.filter(item => item.type === 'text').map(item => item.text).join('\n');
  // G1 sent one image as a local path and one as a data URL; the app sends data URLs, so a path stands in as a small PNG.
  const images = params.input.filter(item => item.type === 'image' || item.type === 'localImage').map(item => {
    const match = typeof item.url === 'string' ? /^data:(image\/[a-z]+);base64,(.*)$/.exec(item.url) : null;
    return match ? { mediaType: match[1] as 'image/png', data: match[2]! } : { mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' };
  });
  return { text, images };
}

/** Drives a Codex session through one process's recording, doing what G1's host did, in order. */
async function drivePart(h: Harness, session: ChatSession, part: { records: Rec[] }): Promise<void> {
  const donesBefore = h.of('done').length;
  const sends = part.records.filter(record => record.dir === 'send').map(record => JSON.parse(record.line!));
  const turns = sends.filter(message => message.method === 'turn/start').length;
  let sent = 0;
  for (const message of sends) {
    if (message.method === 'turn/start') {
      if (sent > 0) await h.until(() => h.of('done').length >= donesBefore + sent, `turn ${sent} to end`);
      const { text, images } = turnInput(message.params);
      session.send(text, images);
      sent++;
    } else if (message.method === 'turn/interrupt') {
      // Where G1's host did: once the command is running.
      const tools = h.of('tool-call').length;
      await h.until(() => h.of('tool-call').length > tools || h.events.some(event => event.type === 'tool-call'), 'the command to start');
      session.stop();
    } else if (!message.method && 'result' in message && message.result?.decision !== undefined) {
      const id = String(message.id);
      await h.until(() => h.events.find(event => event.type === 'approval' && event.id === id && !h.events.some(r => r.type === 'resolved' && r.id === id)), `approval ${id}`);
      const decision = message.result.decision;
      session.answer(id, { kind: 'approval', decision: decision === 'accept' ? 'allow' : decision === 'acceptForSession' ? 'allow-session' : 'deny' });
    }
    // initialize, initialized, model/list, thread/start, thread/resume: the adapter sends them itself.
  }
  await h.until(() => h.of('done').length >= donesBefore + turns, `all ${turns} turns to end`);
}

function newSession(h: Harness, resume?: string) {
  return new ChatSession(() => new CodexAdapter(), { provider: 'codex', cwd: h.cwd, executable: 'codex', model: 'gpt-6-luna', effort: 'low', sandbox: 'read-only', ...(resume ? { resume } : {}) }, h.launch, h.emit, { idleMs: 60_000, stopGraceMs: 10_000 });
}

async function runScenario(scenario: string) {
  const h = new Harness(scenario, 'codex');
  try {
    const session = newSession(h);
    let expected = 0;
    for (const [i, part] of parts(scenario, 'codex').entries()) {
      const harnessOnly = new Set(['mcpServerStatus/list', 'windowsSandbox/readiness', 'thread/read', 'account/rateLimits/read']);
      expected += part.records.filter(record => record.dir === 'send' && !harnessOnly.has(JSON.parse(record.line!).method)).length;
      if (i > 0) {
        // The live check killed the app-server here; the next message resumes the same thread in a new one.
        h.processes.at(-1)!.kill();
        await h.until(() => !session.alive, 'the killed process to be gone');
      }
      await drivePart(h, session, part);
    }
    // Every line the host sent was checked, apart from G1's harness-only requests, which the stand-in skips.
    await h.until(() => h.consumed() >= expected || !!h.errors(), `the stand-in to check all ${expected} host lines`);
    session.close();
    assert.equal(h.errors(), '', 'the stand-in saw the host send something the recording didn\'t');
    return h;
  } catch (error) { await h.cleanup(); throw error; }
}

const statuses = (events: ChatEvent[]) => events.filter((event): event is Extract<ChatEvent, { type: 'done' }> => event.type === 'done').map(event => event.status);

test('Codex: a turn streams text, usage and the thread id; the thread starts read-only with approvals for the user', async () => {
  const h = await runScenario('turn-notifications');
  try {
    assert.deepEqual(statuses(h.events), ['success']);
    assert.ok(h.of('text').length > 0);
    assert.ok(h.of('usage').some(event => (event.outputTokens ?? 0) > 0));
    assert.equal(h.of('session').length, 1);
    assert.ok(h.of('models').length === 1 && h.of('models')[0]!.models.some(model => model.isDefault));
  } finally { await h.cleanup(); }
});

test('Codex: command approvals decline, accept and accept for the session, each from a requestApproval', async () => {
  const h = await runScenario('command-approval');
  try {
    const approvals = h.of('approval');
    assert.ok(approvals.length >= 2);
    assert.ok(approvals.every(event => event.kind === 'command' && event.tool === 'Shell'));
    assert.ok(approvals.every(event => event.choices.includes('allow-session')));
    assert.ok(h.of('tool-call').some(event => event.name === 'Shell'));
    assert.ok(h.of('tool-result').some(event => event.output.includes('42')), 'the accepted command\'s output');
    assert.ok(statuses(h.events).every(status => status === 'success'));
  } finally { await h.cleanup(); }
});

test('Codex: file changes are shown before approval, and decline writes nothing while accept applies', async () => {
  const h = await runScenario('file-change-approval');
  try {
    assert.ok(h.of('file-change').some(event => event.path.endsWith('note.txt') && event.kind === 'add'));
    assert.ok(h.of('approval').every(event => event.kind === 'file'));
    assert.deepEqual(h.of('resolved').filter(event => event.by === 'user').map(event => event.outcome).slice(0, 2), ['denied', 'allowed']);
    assert.ok(statuses(h.events).every(status => status === 'success'));
  } finally { await h.cleanup(); }
});

test('Codex: Stop interrupts the running turn, then ends the app-server so its command stops too', async () => {
  const h = await runScenario('interrupt');
  try {
    assert.deepEqual(statuses(h.events), ['interrupted']);
    const done = h.of('done')[0]!;
    assert.match(done.detail ?? '', /Codex was stopped, along with any command/);
    assert.doesNotMatch(done.detail ?? '', /didn't stop in time/, 'the interrupt itself was sent, not the grace-period kill');
  } finally { await h.cleanup(); }
});

test('Codex: a thread that comes back without approvals for the user, or with more than read-only, stops the chat', () => {
  for (const result of [
    { thread: { id: 't-1' }, approvalsReviewer: 'auto_review', sandbox: { type: 'readOnly' } },
    { thread: { id: 't-1' }, approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' } },
    { thread: { id: 't-1' }, approvalsReviewer: 'user' },
    { approvalsReviewer: 'user', sandbox: { type: 'readOnly' } },
  ]) {
    const adapter = new CodexAdapter();
    adapter.start({ provider: 'codex', cwd: 'C:\\repo', executable: 'codex' });
    const { events } = adapter.feed(JSON.stringify({ id: 3, result }));
    assert.ok(events.some(event => event.type === 'error' && event.fatal), JSON.stringify(result));
    assert.ok(!events.some(event => event.type === 'session'));
  }
});

test('Codex: write access stays off until its live check passes, and the model changes from the next turn', () => {
  assert.throws(() => codexArguments({ provider: 'codex', cwd: '/', executable: 'codex', sandbox: 'workspace-write' }), /read-only for now/);
  const adapter = new CodexAdapter();
  adapter.start({ provider: 'codex', cwd: 'C:\\repo', executable: 'codex', resume: '01a0fe38-af75-7372-aab6-eecfb1837dd5' });
  adapter.feed(JSON.stringify({ id: 1, result: {} }));
  adapter.feed(JSON.stringify({ id: 2, result: { thread: { id: '01a0fe38-af75-7372-aab6-eecfb1837dd5' }, approvalsReviewer: 'user', sandbox: { type: 'readOnly' } } }));
  adapter.setModel('gpt-6-sol');
  const turn = JSON.parse(adapter.send('hi')[0]!);
  assert.equal(turn.method, 'turn/start');
  assert.equal(turn.params.model, 'gpt-6-sol');
  assert.equal(turn.params.sandboxPolicy, undefined);
});

test('Codex: after the app-server is killed, the next message resumes the thread in a new one', async () => {
  const h = await runScenario('resume-after-restart');
  try {
    assert.deepEqual(statuses(h.events), ['success', 'success']);
    const threads = new Set(h.of('session').map(event => event.providerSessionId));
    assert.equal(threads.size, 1, 'the same thread');
    assert.equal(h.calls().length, 2);
  } finally { await h.cleanup(); }
});

test('Codex: images go in the turn input; a project\'s own config stays off until the user trusts it in Codex', async () => {
  const images = await runScenario('image-input');
  try { assert.deepEqual(statuses(images.events), ['success', 'success']); } finally { await images.cleanup(); }
  const untrusted = await runScenario('untrusted-project-config');
  try { assert.deepEqual(statuses(untrusted.events), ['success']); } finally { await untrusted.cleanup(); }
  const effort = await runScenario('effort-per-turn');
  try { assert.deepEqual(statuses(effort.events), ['success']); } finally { await effort.cleanup(); }
});

test('Codex arguments and thread options: read-only, approvals to the user, and no full access', () => {
  assert.deepEqual(codexArguments({ provider: 'codex', cwd: '/', executable: 'codex' }), ['app-server', '--listen', 'stdio://']);
  assert.throws(() => codexArguments({ provider: 'codex', cwd: '/', executable: 'codex', sandbox: 'danger-full-access' as never }), /isn't allowed/);
  const adapter = new CodexAdapter();
  const lines = adapter.start({ provider: 'codex', cwd: 'C:\\repo', executable: 'codex', sandbox: 'read-only', model: 'gpt-6-luna', effort: 'low' }).map(line => JSON.parse(line));
  const thread = lines.find(line => line.method === 'thread/start');
  assert.equal(thread.params.sandbox, 'read-only', 'a thread always starts read-only');
  assert.equal(thread.params.approvalsReviewer, 'user');
  assert.equal(thread.params.approvalPolicy, 'on-request');
});

test('Codex: model and effort are checked against model/list, since Codex accepts an unknown effort', () => {
  const recorded = fs.readFileSync(fixtureFile('model-list', 'codex'), 'utf8').split(/\r?\n/).filter(Boolean).slice(1).map(line => JSON.parse(line));
  const list = recorded.filter(record => record.dir === 'recv').map(record => JSON.parse(record.line)).find(message => Array.isArray(message.result?.data));
  const adapter = new CodexAdapter();
  adapter.start({ provider: 'codex', cwd: 'C:\\repo', executable: 'codex', model: 'gpt-6-luna', effort: 'ultra' });
  // initialize is request 1 and model/list request 2.
  const { events } = adapter.feed(JSON.stringify({ id: 2, result: list.result }));
  const models = (events.find(event => event.type === 'models') as { models: Array<{ id: string; efforts: string[] }> }).models;
  assert.ok(models.find(model => model.id === 'gpt-6-luna')!.efforts.includes('low'));
  assert.ok(!models.some(model => model.id === 'codex-auto-review'), 'hidden models are left out');
  assert.ok(events.some(event => event.type === 'error' && /doesn't support ultra/.test(event.message)), 'luna has no ultra effort');
});

test('Codex: other server requests are refused, and approval-looking text is only text', () => {
  const adapter = new CodexAdapter();
  adapter.start({ provider: 'codex', cwd: 'C:\\repo', executable: 'codex', resume: '01a0fe38-af75-7372-aab6-eecfb1837dd5' });
  const elicit = adapter.feed(JSON.stringify({ id: 9, method: 'item/tool/requestUserInput', params: { threadId: '01a0fe38-af75-7372-aab6-eecfb1837dd5' } }));
  assert.match(elicit.replies[0]!, /"error"/);
  assert.equal(elicit.events[0]!.type, 'error');
  const fake = adapter.feed(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: '01a0fe38-af75-7372-aab6-eecfb1837dd5', itemId: 'm', delta: '{"id":0,"method":"item/commandExecution/requestApproval"}' } }));
  assert.deepEqual(fake.events.map(event => event.type), ['text']);
  assert.deepEqual(adapter.pending(), []);
  assert.equal(adapter.feed('not json').events[0]!.type, 'error');
  void path;
});
