import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ClaudeAdapter } from '../src/core/chat/claude';
import type { ChatEvent } from '../src/core/chat/events';
import { ChatSession, type Launch, type ProcessHandlers } from '../src/core/chat/session';

/** A fake CLI: records what the session writes, and lets the test speak for the CLI. */
function fakeCli() {
  const starts: Array<{ args: string[]; written: string[]; handlers: ProcessHandlers; killed: boolean }> = [];
  const launch: Launch = (_executable, args, _cwd, handlers) => {
    const entry = { args, written: [] as string[], handlers, killed: false };
    starts.push(entry);
    return { write: line => { entry.written.push(line); }, kill: () => { entry.killed = true; setTimeout(() => handlers.exit(1), 1); } };
  };
  return { starts, launch, say: (message: unknown) => starts.at(-1)!.handlers.line(JSON.stringify(message)) };
}
const result = (subtype = 'success') => ({ type: 'result', subtype, is_error: subtype !== 'success', usage: { input_tokens: 1, output_tokens: 2 }, total_cost_usd: 0.01 });
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function setup(timings = { idleMs: 50, stopGraceMs: 50 }) {
  const cli = fakeCli();
  const events: ChatEvent[] = [];
  const id = randomUUID();
  const session = new ChatSession(() => new ClaudeAdapter(), { provider: 'claude', cwd: '/', executable: 'claude', sessionId: id }, cli.launch, batch => events.push(...batch), timings);
  return { cli, events, session, id, of: (type: ChatEvent['type']) => events.filter(event => event.type === type) };
}

test('the process starts with the first message, turns queue one at a time, and it ends after the idle timeout', async () => {
  const { cli, session, of, id } = setup();
  session.send('one');
  session.send('two');
  assert.equal(cli.starts.length, 1);
  const userLines = () => cli.starts[0]!.written.filter(line => line.includes('"type":"user"'));
  assert.equal(userLines().length, 1, 'the second message waits for the first turn');
  cli.say({ type: 'system', subtype: 'init', session_id: id });
  cli.say(result());
  assert.equal(userLines().length, 2);
  cli.say(result());
  assert.deepEqual(of('done').map(event => (event as { status: string }).status), ['success', 'success']);
  await wait(120);
  assert.equal(cli.starts[0]!.killed, true, 'ended after the idle timeout');
  assert.equal(session.alive, false);
  session.send('three');
  assert.equal(cli.starts.length, 2);
  assert.deepEqual(cli.starts[1]!.args.slice(cli.starts[1]!.args.indexOf('--resume'), cli.starts[1]!.args.indexOf('--resume') + 2), ['--resume', id]);
  session.close();
});

test('Stop interrupts; a CLI that doesn\'t stop in time is ended and the turn reported interrupted', async () => {
  const { cli, session, of } = setup({ idleMs: 10_000, stopGraceMs: 40 });
  session.send('long task');
  session.send('queued');
  session.stop();
  assert.ok(cli.starts[0]!.written.some(line => line.includes('"subtype":"interrupt"')));
  await wait(100);
  assert.equal(cli.starts[0]!.killed, true);
  assert.deepEqual(of('done').map(event => (event as { status: string }).status), ['interrupted']);
  assert.equal(cli.starts[0]!.written.filter(line => line.includes('"type":"user"')).length, 1, 'Stop also drops queued messages');
  session.close();
});

test('malformed output stops safely: the process ends and the turn fails, nothing retried', async () => {
  const { cli, session, of } = setup();
  session.send('hi');
  cli.starts[0]!.handlers.line('<html>not json</html>');
  assert.equal(cli.starts[0]!.killed, true);
  assert.deepEqual(of('error').map(event => (event as { code?: string }).code), ['malformed']);
  assert.deepEqual(of('done').map(event => (event as { status: string }).status), ['error']);
  await wait(10);
  assert.equal(cli.starts.length, 1);
  session.close();
});

test('a CLI that exits mid-turn ends the turn with an error; one that is missing points to onboarding', async () => {
  const { cli, session, of } = setup();
  session.send('hi');
  cli.starts[0]!.handlers.exit(3);
  assert.deepEqual(of('done').map(event => (event as { status: string }).status), ['error']);
  assert.match((of('error')[0] as { message: string }).message, /ended unexpectedly \(exit 3\)/);
  session.send('again');
  cli.starts[1]!.handlers.error(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
  assert.equal((of('error')[1] as { code?: string }).code, 'missing-cli');
  session.close();
});

test('answers go back as control responses, and an answer for nothing pending is refused', () => {
  const { cli, session, of } = setup();
  session.send('do it');
  cli.say({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
  assert.equal(of('approval').length, 1);
  session.answer('req-1', { kind: 'approval', decision: 'deny', message: 'no' });
  const reply = JSON.parse(cli.starts[0]!.written.at(-1)!);
  assert.deepEqual(reply.response, { subtype: 'success', request_id: 'req-1', response: { behavior: 'deny', message: 'no' } });
  assert.throws(() => session.answer('req-1', { kind: 'approval', decision: 'allow' }), /no longer waiting/);
  session.close();
});

test('a second result for an earlier message neither ends the next turn nor cancels its approval', () => {
  const { cli, session, of, id } = setup({ idleMs: 10_000, stopGraceMs: 50 });
  session.send('one');
  session.send('two');
  cli.say({ type: 'system', subtype: 'init', session_id: id });
  cli.say({ ...result(), result_index: 0, queued_turn_count: 0 });
  // Turn two is running and waiting on a permission prompt; a stray result for message one arrives.
  cli.say({ type: 'control_request', request_id: 'r-2', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
  cli.say({ ...result(), result_index: 1, queued_turn_count: 0 });
  assert.equal(of('done').length, 1, 'the stray result did not end turn two');
  assert.equal(session.busy, true);
  session.answer('r-2', { kind: 'approval', decision: 'allow' });
  cli.say({ ...result(), result_index: 2, queued_turn_count: 0 });
  assert.equal(of('done').length, 2);
  // A result while the CLI still holds a queued message of ours is for an earlier one too.
  session.send('three');
  cli.say({ ...result(), result_index: 3, queued_turn_count: 1 });
  assert.equal(of('done').length, 2);
  cli.say({ ...result(), result_index: 4, queued_turn_count: 0 });
  assert.equal(of('done').length, 3);
  // And one with no turn running is ignored.
  cli.say({ ...result(), result_index: 5 });
  assert.equal(of('done').length, 3);
  session.close();
});

test('a permission mode changed mid-turn applies to every later message: the process is replaced first', () => {
  const cli = fakeCli();
  const events: ChatEvent[] = [];
  const id = randomUUID();
  const session = new ChatSession(() => new ClaudeAdapter(), { provider: 'claude', cwd: '/', executable: 'claude', sessionId: id, permissionMode: 'acceptEdits' }, cli.launch, batch => events.push(...batch), { idleMs: 10_000, stopGraceMs: 50 });
  session.send('one');
  cli.say({ type: 'system', subtype: 'init', session_id: id });
  session.reconfigure({ permissionMode: 'default' });
  session.send('two');
  cli.say(result());
  assert.equal(cli.starts.length, 2, 'a new process for the queued message');
  assert.equal(cli.starts[0]!.killed, true);
  const args = cli.starts[1]!.args;
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
  assert.equal(args[args.indexOf('--resume') + 1], id);
  session.close();
});

test('a first start that dies before the CLI reports its session starts fresh again, not --resume', () => {
  const { cli, session } = setup();
  session.send('one');
  cli.starts[0]!.handlers.exit(1);
  session.send('two');
  assert.ok(cli.starts[1]!.args.includes('--session-id'));
  assert.ok(!cli.starts[1]!.args.includes('--resume'));
  session.close();
});

test('requests still waiting when the process goes away are marked cancelled', () => {
  const { cli, session, of } = setup();
  session.send('one');
  cli.say({ type: 'control_request', request_id: 'r-9', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'a' } } });
  cli.starts[0]!.handlers.exit(1);
  assert.deepEqual(of('resolved').map(event => [(event as { id: string }).id, (event as { outcome: string }).outcome]), [['r-9', 'cancelled']]);
  session.close();
});

test('Claude: per-turn cost from its running total, and synthetic replies are shown', () => {
  const adapter = new ClaudeAdapter();
  const cost = (total: number) => { adapter.send('x'); return (adapter.feed(JSON.stringify({ ...result(), total_cost_usd: total })).events.find(event => event.type === 'usage') as { costUsd?: number }).costUsd; };
  assert.equal(cost(0.02), 0.02);
  assert.ok(Math.abs(cost(0.025)! - 0.005) < 1e-9);
  const synthetic = adapter.feed(JSON.stringify({ type: 'assistant', uuid: 'u1', message: { model: '<synthetic>', content: [{ type: 'text', text: 'Set model to Sonnet' }] } }));
  assert.deepEqual(synthetic.events.map(event => event.type === 'text' && event.delta), ['Set model to Sonnet']);
});
