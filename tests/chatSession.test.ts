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
