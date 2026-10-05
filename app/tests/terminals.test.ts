import assert from 'node:assert/strict';
import test from 'node:test';
import { AppTerminals, type TerminalMessage } from '../src/main/terminals';
import { parseCall } from '../src/shared/ipc';

function standIn() {
  const spawned: Array<{ file: string; args: string[] | string; cwd: string; env: Record<string, string> }> = [];
  const typed: string[] = [], sizes: Array<[number, number]> = [];
  let emit: (data: string) => void = () => undefined, end: (code: number) => void = () => undefined, killed = 0;
  const spawn = (file: string, args: string[] | string, options: { cwd: string; env: Record<string, string> }) => {
    spawned.push({ file, args, cwd: options.cwd, env: options.env });
    return { pid: 1, onData: (listener: (data: string) => void) => { emit = listener; }, onExit: (listener: (event: { exitCode: number }) => void) => { end = code => listener({ exitCode: code }); },
      write: (data: string) => { typed.push(data); }, resize: (cols: number, rows: number) => { sizes.push([cols, rows]); }, kill: () => { killed++; } };
  };
  return { spawn, spawned, typed, sizes, emit: (data: string) => emit(data), end: (code: number) => end(code), killed: () => killed };
}

test('a terminal in the window: the CLI main started streams out, the window\'s keys and size go in, and only by its id', () => {
  const pty = standIn();
  const sent: TerminalMessage[] = [];
  const terminals = new AppTerminals({ send: message => sent.push(message), spawn: pty.spawn });
  const saved = process.env.CLAUDECODE;
  process.env.CLAUDECODE = '1';
  const id = terminals.start('claude.exe', ['--teleport', 'session_01ApFs1X7hjubWFrUBiN4Bht'], 'C:\wt');
  if (saved === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = saved;
  assert.equal(pty.spawned[0]!.cwd, 'C:\wt');
  assert.equal(pty.spawned[0]!.env.CLAUDECODE, undefined, 'no parent Claude Code session markers');
  if (process.platform === 'win32') assert.equal(pty.spawned[0]!.args, '"--teleport" "session_01ApFs1X7hjubWFrUBiN4Bht"');
  pty.emit('Session resumed');
  terminals.write(id, '/compact\r');
  terminals.write('0f8fad5b-d9cb-469f-a165-70867728950e', 'nope');
  terminals.resize(id, 100, 40);
  terminals.resize(id, 100000, 40);
  assert.deepEqual(pty.typed, ['/compact\r']);
  assert.deepEqual(pty.sizes, [[100, 40]]);
  pty.end(0);
  assert.deepEqual(sent, [{ id, data: 'Session resumed' }, { id, exit: 0 }]);
  terminals.write(id, 'after');
  assert.deepEqual(pty.typed, ['/compact\r'], 'an ended terminal takes nothing');
  terminals.start('claude.exe', ['--teleport', 'session_01ApFs1X7hjubWFrUBiN4Bht'], 'C:\wt');
  terminals.closeAll();
  assert.equal(pty.killed(), 1, 'quitting closes what is still open');
  assert.equal(parseCall({ channel: 'terminal.resize', payload: { id, cols: 1.5, rows: 40 } }).ok, false);
  assert.equal(parseCall({ channel: 'terminal.write', payload: { id, data: 'x'.repeat(65_537) } }).ok, false);
});
