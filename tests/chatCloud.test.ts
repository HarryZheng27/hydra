import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cloudEnvironment, isClaudeCloudUrl, windowsCommandLine, parseClaudeCloudStart, renderTerminal, startClaudeCloud, type PseudoTerminal, type SpawnPseudoTerminal } from '../src/core/chat/cloud';

// Spike S3's redacted captures of the real CLI (docs/internal/hydra-app/G7-cloud.md).
const fixture = (name: string) => readFileSync(path.join(__dirname, '..', 'tests', 'fixtures', 'app', 'claude-cloud', `${name}.txt`), 'utf8').replace(/\r\n/g, '\n');

test('a started Claude cloud session is read from what the real CLI printed, and nothing else is', () => {
  for (const name of ['cloud-created', 'cloud-no-github-remote', 'cloud-dirty-tree']) {
    const session = parseClaudeCloudStart(fixture(name));
    assert.ok(session, name);
    assert.match(session.sessionId, /^session_01StandIn\d{14}$/);
    assert.equal(session.url, `https://claude.ai/code/${session.sessionId}?from=cli&m=0`, 'the link keeps the CLI\'s plain query, which claude.ai may need');
  }
  assert.equal(parseClaudeCloudStart(fixture('cloud-created'))!.title, 'README sandbox note');
  for (const name of ['cloud-requires-tty', 'resume-rejects-cloud-id', 'teleport-push-refused']) assert.equal(parseClaudeCloudStart(fixture(name)), undefined, name);
  const ok = 'Created cloud session: T\nView: https://claude.ai/code/session_01abcdefghijkl?from=cli\nResume with: claude --teleport session_01abcdefghijkl';
  assert.ok(parseClaudeCloudStart(ok));
  // The three lines must agree on one id, and the link must be claude.ai/code's own.
  assert.equal(parseClaudeCloudStart(ok.replace('teleport session_01abcdefghijkl', 'teleport session_01zzzzzzzzzzzz')), undefined);
  assert.equal(parseClaudeCloudStart(ok.replace('https://claude.ai/code/', 'https://evil.example/code/')), undefined);
  assert.equal(parseClaudeCloudStart(ok.replace('Created cloud session: T\n', '')), undefined);
});

test('a terminal capture renders as readable lines', () => {
  assert.equal(renderTerminal('\x1b[2J\x1b[3;2HCreated\x1b[1Ccloud\x1b[1Csession:\x1b[1CT\x1b]0;title\x07\r\n\x1b[38;2;1;2;3m◐\r\nView: x'), 'Created cloud session: T\nView: x');
});

test('a cloud chat\'s CLI never inherits another Claude Code session\'s markers or Electron\'s run-as-node switch, and keeps the user\'s own settings', () => {
  const env = cloudEnvironment({ PATH: 'p', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'x', ELECTRON_RUN_AS_NODE: '1', CLAUDE_CONFIG_DIR: 'c', ANTHROPIC_API_KEY: 'k' });
  assert.deepEqual(env, { PATH: 'p', CLAUDE_CONFIG_DIR: 'c', ANTHROPIC_API_KEY: 'k', TERM: 'xterm-256color' });
});

/** A stand-in pseudo-terminal that plays the real CLI's capture and records what Hydra types. */
function standIn(script: (term: { emit(data: string): void; exit(code: number): void; typed: string[] }) => void): { spawn: SpawnPseudoTerminal; calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }>; typed: string[] } {
  const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const typed: string[] = [];
  const spawn: SpawnPseudoTerminal = (file, args, options) => {
    calls.push({ file, args, env: options.env });
    let onData: (data: string) => void = () => undefined, onExit: (event: { exitCode: number }) => void = () => undefined;
    const term: PseudoTerminal = { onData: listener => { onData = listener; }, onExit: listener => { onExit = listener; }, write: data => { typed.push(data); }, kill: () => onExit({ exitCode: 1 }) };
    setImmediate(() => script({ emit: data => onData(data), exit: code => onExit({ exitCode: code }), typed }));
    return term;
  };
  return { spawn, calls, typed };
}
const trustScreen = '\x1b[14;2H❯\x1b[1CNo,\x1b[1Cexit\x1b[15;4HYes,\x1b[1CI\x1b[1Ctrust\x1b[1Cthis\x1b[1Cfolder';
const created = '\r\nCreated cloud session: README sandbox note\r\nView: https://claude.ai/code/session_01ApFs1X7hjubWFrUBiN4Bht?from=cli&m=0\r\nResume with: claude --teleport session_01ApFs1X7hjubWFrUBiN4Bht\r\n';

test('a cloud chat starts with --cloud in a pseudo-terminal, answering Claude Code\'s own trust prompt only for a folder Hydra trusts', async () => {
  const run = standIn(term => {
    term.emit('\x1b[>0q' + trustScreen);
    const wait = setInterval(() => { if (term.typed.includes('\r')) { clearInterval(wait); term.emit(created); term.exit(0); } }, 20);
  });
  const session = await startClaudeCloud({ executable: 'claude.exe', cwd: 'C:\\repo', message: 'Add a line to README.md', spawn: run.spawn, answerTrust: true, env: { PATH: 'p', CLAUDECODE: '1' } });
  assert.deepEqual(session, { sessionId: 'session_01ApFs1X7hjubWFrUBiN4Bht', title: 'README sandbox note', url: 'https://claude.ai/code/session_01ApFs1X7hjubWFrUBiN4Bht?from=cli&m=0' });
  assert.deepEqual(run.calls[0]!.args, ['--cloud', 'Add a line to README.md']);
  assert.equal(run.calls[0]!.env.CLAUDECODE, undefined);
  // It answered the terminal's version query, then chose "Yes, I trust this folder": down, then Enter.
  assert.deepEqual(run.typed, ['\x1bP>|xterm(388)\x1b\\', '\x1b[B', '\r']);

  const refused = standIn(term => term.emit(trustScreen));
  await assert.rejects(startClaudeCloud({ executable: 'claude.exe', cwd: 'C:\\repo', message: 'x', spawn: refused.spawn, answerTrust: false }), /hasn't trusted it/);
  assert.deepEqual(refused.typed, [], 'nothing typed into a prompt Hydra may not answer');
});

test('what the CLI says when it doesn\'t start a session reaches the chat; option-like, empty or huge messages never reach the CLI', async () => {
  const failing = standIn(term => { term.emit(fixture('cloud-requires-tty')); term.exit(1); });
  await assert.rejects(startClaudeCloud({ executable: 'claude.exe', cwd: 'C:\\repo', message: 'x', spawn: failing.spawn, answerTrust: true }), /didn't start a cloud session: .*interactive terminal/);
  const never = standIn(() => assert.fail('started'));
  for (const [message, pattern] of [['--dangerously-skip-permissions', /can't start with "-"/], ['   ', /Type a message/], ['x'.repeat(20_001), /at most/]] as const) {
    await assert.rejects(startClaudeCloud({ executable: 'claude.exe', cwd: 'C:\\repo', message, spawn: never.spawn, answerTrust: true }), pattern);
  }
  assert.equal(never.calls.length, 0);
  const silent = standIn(() => undefined);
  await assert.rejects(startClaudeCloud({ executable: 'claude.exe', cwd: 'C:\\repo', message: 'x', spawn: silent.spawn, answerTrust: true, timeoutMs: 50 }), /took too long/);
});

test('a cloud chat\'s message reaches the CLI as one argument: quoted by Hydra on Windows, and refused through a .cmd shim if cmd.exe would read it', async () => {
  const hostile = ['"go" --permission-mode bypassPermissions --add-dir C:\\ "x"', 'a\\" b', 'ends in \\', 'tab\there', '', 'plain'];
  assert.equal(windowsCommandLine(['--cloud', 'say "hi" C:\\dir\\']), '"--cloud" "say \\"hi\\" C:\\dir\\\\"');
  if (process.platform === 'win32') {
    // A real Windows process splits Hydra's command line back into exactly the arguments it was given.
    const echo = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
    const out = spawnSync(process.execPath, [windowsCommandLine(['-e', echo, '--', ...hostile])], { argv0: `"${process.execPath}"`, windowsVerbatimArguments: true, windowsHide: true, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out.stdout).slice(-hostile.length), hostile, out.stderr);
  }
  const never = standIn(() => assert.fail('started'));
  for (const message of ['fix a" & calc & "b', 'echo %PATH%', 'two\nlines', 'a ^ b', 'wow!']) {
    await assert.rejects(startClaudeCloud({ executable: 'C:\\npm\\claude.cmd', cwd: 'C:\\repo', message, spawn: never.spawn, answerTrust: true, platform: 'win32' }), /\.cmd launcher/, message);
  }
  assert.equal(never.calls.length, 0);
  // The native claude.exe takes them: Hydra's own quoting carries each as one argument.
  const run = standIn(term => { term.emit(created); term.exit(0); });
  await startClaudeCloud({ executable: 'C:\\bin\\claude.exe', cwd: 'C:\\repo', message: 'fix a" & calc & "b', spawn: run.spawn, answerTrust: true, platform: 'win32' });
  assert.deepEqual(run.calls[0]!.args, ['--cloud', 'fix a" & calc & "b']);
});

test('Stop, removing the chat or quitting kills a cloud chat\'s CLI before its session starts', async () => {
  let killed = 0;
  const abort = new AbortController();
  const spawn: SpawnPseudoTerminal = () => {
    let onExit: (event: { exitCode: number }) => void = () => undefined;
    setTimeout(() => abort.abort(), 20);
    return { onData: () => undefined, onExit: listener => { onExit = listener; }, write: () => undefined, kill: () => { killed++; onExit({ exitCode: 1 }); } };
  };
  await assert.rejects(startClaudeCloud({ executable: 'claude.exe', cwd: 'C:\\repo', message: 'x', spawn, answerTrust: true, signal: abort.signal }), /Stopped before the cloud session started/);
  assert.equal(killed, 1);
});

test('a cloud link is claude.ai/code\'s own for its session, with at most a plain query', () => {
  const id = 'session_01ApFs1X7hjubWFrUBiN4Bht';
  for (const ok of [`https://claude.ai/code/${id}`, `https://claude.ai/code/${id}?from=cli&m=0`]) assert.equal(isClaudeCloudUrl(ok, id), true, ok);
  for (const bad of [`https://claude.ai/code/${id}?x=<script>`, `https://claude.ai/code/${id}?a=1#frag`, `https://claude.ai/code/${id}/../x`, `https://claude.ai.evil.example/code/${id}`, `https://claude.ai/code/${id}?`, 'https://claude.ai/code/session_01Other0000000']) {
    assert.equal(isClaudeCloudUrl(bad, id), false, bad);
  }
  assert.equal(isClaudeCloudUrl('https://claude.ai/code/--x', '--x'), false);
});

