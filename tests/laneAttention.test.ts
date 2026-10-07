import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addClaudeLimitHook, attentionHookGroups, codexNotifyCommand, limitHookGroup, limitHookState, readClaudeLimitHooks, removeClaudeLimitHook } from '../src/core/claudeLimitHook';
import { addCodexNotify, codexHasOwnNotify, codexNotifyPaths, removeCodexNotify, addCodexBlock, removeCodexBlock, type HelperServerSpec } from '../src/core/helperRegistration';
import { inWorktreeRoot, normaliseClaudeAttention, normaliseCodexNotify, parseAttentionEventFile } from '../src/core/attentionEvents';
import { AttentionWatcher } from '../src/core/attentionWatcher';
import { LaneStore, type Lane } from '../src/core/lanes';
import { LaneService, attentionOutputGraceMs, isTypedInput } from '../src/core/laneService';
import { waitingFirst } from '../src/core/model';
import { git } from '../src/core/git';
import { fakePtyModule } from './lanePtyFake';

/** A lane's terminal output is batched for a few milliseconds before it reaches the service. */
const settle = () => new Promise(resolve => setTimeout(resolve, 120));
/** The hook script, bundled the way scripts/build.mjs does (esbuild itself can't be bundled into a test). */
function bundleHook(outfile: string): void {
  const code = `require('esbuild').buildSync({ entryPoints: ['src/hydraLimitHook.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: process.argv[1], logLevel: 'silent' })`;
  const built = spawnSync(process.execPath, ['-e', code, outfile], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(built.status, 0, built.stderr);
}
const options = { executable: 'C:\\Program Files\\Hydra\\Hydra.exe', script: 'C:\\Hydra\\dist\\hydra-limit-hook.cjs', eventsDir: "C:\\Users\\O'Brien\\limit-events", platform: 'win32' as const, systemRoot: 'C:\\Windows' };
const group = limitHookGroup(options);
const attention = attentionHookGroups({ ...options, worktreeRoot: 'D:\\work trees' });
const moved = { options: { ...options, executable: 'D:\\Hydra\\Hydra.exe', script: 'D:\\Hydra\\dist\\hydra-limit-hook.cjs' } };
const userStop = { hooks: [{ type: 'command', command: 'say done' }] };
const userNotification = { matcher: 'permission_prompt', hooks: [{ type: 'command', command: 'beep' }] };

test('the Stop and Notification groups are the same exec-form script, with the worktree root as one more argument', () => {
  const stop = attention.Stop.hooks[0]!;
  assert.equal(attention.Stop.matcher, ''); assert.equal(attention.Notification.matcher, 'permission_prompt|elicitation_dialog|elicitation_url_dialog');
  assert.equal(stop.command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(stop.args[4], "$env:ELECTRON_RUN_AS_NODE='1'; & 'C:\\Program Files\\Hydra\\Hydra.exe' 'C:\\Hydra\\dist\\hydra-limit-hook.cjs' 'C:\\Users\\O''Brien\\limit-events' 'D:\\work trees'; exit 0");
  assert.equal(stop.timeout, 10);
  const unix = attentionHookGroups({ executable: '/opt/h', script: '/opt/s.cjs', eventsDir: '/e', platform: 'linux' }).Stop.hooks[0]!;
  assert.deepEqual([unix.command, ...unix.args], ['/bin/sh', '-c', 'ELECTRON_RUN_AS_NODE=1 exec "$0" "$@"', '/opt/h', '/opt/s.cjs', '/e', '']);
  // The usage-limit group is unchanged, byte for byte.
  assert.ok(!group.hooks[0]!.args[4]!.includes("limit-events' '"));
});

test('the three Hydra hook groups go in and out of settings.json byte for byte, beside the user\'s own hooks', () => {
  const samples: Record<string, string> = {
    'nothing': '',
    'no hooks key': '{\n  "model": "opus"\n}\n',
    'the user\'s Stop hook': `{\n  "hooks": {\n    "Stop": [\n      ${JSON.stringify(userStop)}\n    ]\n  }\n}\n`,
    'the user\'s Stop and Notification hooks': `{\n    "hooks": {\n        "Stop": [\n            ${JSON.stringify(userStop)}\n        ],\n        "Notification": [\n            ${JSON.stringify(userNotification)}\n        ]\n    },\n    "theme": "dark"\n}`,
    'empty lists': '{\n  "hooks": {\n    "Stop": [],\n    "Notification": []\n  }\n}\n',
    'CRLF with a user StopFailure': '{\r\n  "hooks": {\r\n    "StopFailure": [\r\n      {"matcher": "x", "hooks": []}\r\n    ]\r\n  },\r\n  "model": "opus"\r\n}\r\n',
    'compact': '{"model":"opus","hooks":{"Notification":[{"hooks":[]}]}}',
    'tabs and a BOM': '\uFEFF{\n\t"model": "opus"\n}\n',
  };
  for (const [name, original] of Object.entries(samples)) {
    const added = addClaudeLimitHook(original || undefined, group, attention);
    const parsed = JSON.parse(added.replace(/^\uFEFF/, '')) as { hooks: Record<string, unknown[]> };
    for (const event of ['StopFailure', 'Stop', 'Notification'] as const) assert.equal(parsed.hooks[event]!.filter(item => JSON.stringify(item).includes('hydra-limit-hook')).length, 1, `${name}: one ${event} group`);
    assert.equal(limitHookState(added, group, attention), 'current', name);
    assert.equal(addClaudeLimitHook(added, group, attention), added, `${name}: connecting twice changes nothing`);
    if (original) assert.equal(removeClaudeLimitHook(added).text, original, `${name}: byte-identical after removal`);
    else assert.deepEqual(JSON.parse(removeClaudeLimitHook(added).text!), {}, `${name}: nothing left`);
    // A Hydra from before these groups has only StopFailure: it is stale, gets the other two, and still removes exactly.
    const old = addClaudeLimitHook(original || undefined, group);
    assert.equal(limitHookState(old, group, attention), 'stale', name);
    const upgraded = addClaudeLimitHook(old, group, attention);
    assert.equal(limitHookState(upgraded, group, attention), 'current', name);
    if (original) assert.equal(removeClaudeLimitHook(upgraded).text, original, `${name}: byte-identical after an upgrade and removal`);
    // A moved Hydra replaces all three, and still leaves the user's file exactly.
    const movedGroup = limitHookGroup(moved.options), movedAttention = attentionHookGroups(moved.options);
    const relocated = addClaudeLimitHook(added, movedGroup, movedAttention);
    for (const event of ['StopFailure', 'Stop', 'Notification'] as const) assert.equal(readClaudeLimitHooks(relocated, event).length, 1, `${name}: ${event} replaced`);
    if (original) assert.equal(removeClaudeLimitHook(relocated).text, original, `${name}: byte-identical after a move and removal`);
    // Claude too old for exec form: no attention groups wanted, the StopFailure state ignores them.
    assert.equal(limitHookState(old, group), 'current');
  }
  // The user's own hooks survive a removal that narrows to one install's groups.
  const both = addClaudeLimitHook(addClaudeLimitHook(samples['the user\'s Stop and Notification hooks']!, group, attention), limitHookGroup(moved.options), attentionHookGroups(moved.options));
  assert.equal(readClaudeLimitHooks(both, 'Stop').length, 1, 'adding another Hydra replaces, never duplicates');
  const onlyMoved = removeClaudeLimitHook(both, candidate => JSON.stringify(candidate).includes('D:\\\\Hydra'));
  assert.equal(onlyMoved.had, true); assert.equal(readClaudeLimitHooks(onlyMoved.text, 'Notification').length, 0);
  assert.throws(() => addClaudeLimitHook('{"hooks":{"Stop":{}}}', group, attention), /not a list/);
});

test('inWorktreeRoot: only a session inside Hydra\'s worktree root counts', () => {
  const win = process.platform === 'win32';
  const root = win ? 'D:\\work trees' : '/work trees';
  const join = (...parts: string[]) => path.join(root, ...parts);
  assert.equal(inWorktreeRoot(join('lane-0123456789ab'), root), true);
  assert.equal(inWorktreeRoot(join('lane-0123456789ab', 'src', 'deep'), root), true);
  assert.equal(inWorktreeRoot(root + '-other', root), false);
  assert.equal(inWorktreeRoot(win ? 'C:\\Users\\n\\project' : '/home/n/project', root), false);
  assert.equal(inWorktreeRoot(win ? 'C:\\Users\\n\\project' : '/home/n/project', undefined), false);
  // The default: a sibling `<repository>.worktrees` folder holding `lane-<id>`.
  const sibling = win ? 'C:\\code\\app.worktrees\\lane-0123456789ab\\x' : '/code/app.worktrees/lane-0123456789ab/x';
  assert.equal(inWorktreeRoot(sibling, undefined), true);
  assert.equal(inWorktreeRoot(win ? 'C:\\code\\app.worktrees\\other' : '/code/app.worktrees/other', undefined), false);
  assert.equal(inWorktreeRoot(win ? 'C:\\code\\app\\lane-0123456789ab' : '/code/app/lane-0123456789ab', undefined), false);
});

test('Claude\'s hook input becomes an attention event only for Stop and a waiting Notification', () => {
  const cwd = path.resolve('somewhere');
  const base = { session_id: 'abc-123', cwd, transcript_path: path.resolve('t.jsonl') };
  assert.equal(normaliseClaudeAttention({ ...base, hook_event_name: 'Stop', last_assistant_message: 'done' })?.attention, 'turn-ended');
  for (const type of ['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog']) assert.equal(normaliseClaudeAttention({ ...base, hook_event_name: 'Notification', notification_type: type, message: 'Allow?' })?.attention, 'waiting', type);
  for (const type of ['idle_prompt', 'auth_success', 'agent_completed', undefined]) assert.equal(normaliseClaudeAttention({ ...base, hook_event_name: 'Notification', notification_type: type }), undefined, String(type));
  assert.equal(normaliseClaudeAttention({ ...base, hook_event_name: 'StopFailure' }), undefined);
  assert.equal(normaliseClaudeAttention({ hook_event_name: 'Stop', cwd: 'relative' }), undefined);
  assert.equal(normaliseClaudeAttention('x'), undefined);
  assert.equal(normaliseClaudeAttention({ ...base, hook_event_name: 'Stop', message: 'x'.repeat(1000) })?.sessionId, 'abc-123');
  const codexCwd = path.resolve('lane');
  assert.deepEqual(normaliseCodexNotify({ type: 'agent-turn-complete', 'thread-id': 't1', cwd: codexCwd }, undefined, new Date(0)), { provider: 'codex', attention: 'turn-ended', at: new Date(0).toISOString(), cwd: codexCwd, sessionId: 't1' });
  assert.equal(normaliseCodexNotify({ type: 'something-else', cwd: codexCwd }), undefined);
  assert.equal(normaliseCodexNotify(undefined, codexCwd)?.cwd, codexCwd, 'the notifier\'s own cwd when the payload can\'t be read');
});

test('an attention event file is untrusted: wrong shapes, stale times and foreign fields are dropped', () => {
  const now = Date.now(), cwd = path.resolve('x');
  const good = { provider: 'claude', attention: 'waiting', at: new Date(now).toISOString(), cwd, laneId: 'abcdef012345', extra: 'ignored' };
  assert.deepEqual(parseAttentionEventFile(JSON.stringify(good), now), { provider: 'claude', attention: 'waiting', at: good.at, cwd, laneId: 'abcdef012345' });
  assert.equal(parseAttentionEventFile(JSON.stringify({ ...good, laneId: 'nope' }), now)?.laneId, undefined);
  for (const bad of [{ ...good, attention: 'x' }, { ...good, provider: 'other' }, { ...good, at: new Date(now - 11 * 60_000).toISOString() }, { ...good, at: 'soon' }]) assert.equal(parseAttentionEventFile(JSON.stringify(bad), now), undefined);
  assert.equal(parseAttentionEventFile('[]', now), undefined); assert.equal(parseAttentionEventFile('nope', now), undefined);
  // A usage-limit event file is not an attention event, and the reverse.
  assert.equal(parseAttentionEventFile(JSON.stringify({ provider: 'claude', source: 'chat', at: good.at }), now), undefined);
});

test('the built hook script records an attention event only inside the worktree root, and always exits 0', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra attention-'));
  try {
    const script = path.join(directory, 'hook.cjs');
    bundleHook(script);
    const events = path.join(directory, 'limit-events'), attentionDir = path.join(events, 'attention');
    const root = path.join(directory, 'worktrees'), lane = path.join(root, 'lane-0123456789ab'), elsewhere = path.join(directory, 'project');
    await mkdir(lane, { recursive: true }); await mkdir(elsewhere, { recursive: true });
    const run = (input: string, args: string[] = [events, root], env: Record<string, string | undefined> = {}) => spawnSync(process.execPath, [script, ...args], { input, timeout: 10_000, env: { ...process.env, ...env } });
    const names = async () => (await readdir(attentionDir).catch(() => [])).filter(name => name.endsWith('.json'));
    const stop = (cwd: string) => JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', cwd, last_assistant_message: 'x'.repeat(5000) });
    // Another Claude Code session on the machine: nothing is recorded, not even the folder.
    assert.equal(run(stop(elsewhere)).status, 0);
    assert.deepEqual(await names(), []);
    // A lane's session: one event, tagged with the lane from its environment.
    assert.equal(run(stop(lane), undefined, { HYDRA_LANE_ID: 'abcdef012345' }).status, 0);
    const [first] = await names();
    const recorded = JSON.parse(await readFile(path.join(attentionDir, first!), 'utf8')) as Record<string, unknown>;
    assert.deepEqual([recorded.attention, recorded.provider, recorded.laneId, recorded.cwd], ['turn-ended', 'claude', 'abcdef012345', lane]);
    assert.ok(!('last_assistant_message' in recorded) && !('message' in recorded), 'what the agent said is never kept');
    // A permission prompt waits; an idle prompt and other types don't count.
    assert.equal(run(JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow Bash?', cwd: lane })).status, 0);
    assert.equal(run(JSON.stringify({ hook_event_name: 'Notification', notification_type: 'idle_prompt', cwd: lane })).status, 0);
    assert.equal((await names()).length, 2);
    // The default root: no argument, a `<repository>.worktrees/lane-<id>` folder.
    const sibling = path.join(directory, 'app.worktrees', 'lane-abcdef012345');
    await mkdir(sibling, { recursive: true });
    assert.equal(run(stop(sibling), [events]).status, 0);
    assert.equal((await names()).length, 3);
    // A usage-limit event still goes where it always went, for any folder.
    assert.equal(run(JSON.stringify({ hook_event_name: 'StopFailure', error: 'rate_limit', session_id: 's', cwd: elsewhere }), [events]).status, 0);
    assert.equal((await readdir(events)).filter(name => name.endsWith('.json')).length, 1);
    // Garbage, huge input, no folder, and a notifier with nothing to read: all exit 0 and write nothing more.
    for (const input of ['', 'garbage', '[]', 'x'.repeat(400_000)]) assert.equal(run(input).status, 0);
    assert.equal(run(stop(lane), []).status, 0);
    assert.equal((await names()).length, 3);
    // Codex's notifier: the payload is the last argument, with nothing on stdin.
    const codex = (payload: unknown, env: Record<string, string | undefined> = {}) => spawnSync(process.execPath, [script, events, root, '--codex', JSON.stringify(payload)], { timeout: 10_000, env: { ...process.env, ...env }, input: '' });
    assert.equal(codex({ type: 'agent-turn-complete', cwd: lane, 'thread-id': 't' }, { HYDRA_LANE_ID: 'abcdef012345' }).status, 0);
    assert.equal(codex({ type: 'agent-turn-complete', cwd: elsewhere }).status, 0);
    assert.equal(codex({ type: 'other', cwd: lane }).status, 0);
    assert.equal((await names()).length, 4);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('the Windows notifier command survives PowerShell with Codex\'s payload appended', { skip: process.platform !== 'win32' && 'PowerShell only' }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra notify-'));
  try {
    const script = path.join(directory, 'hook.cjs');
    bundleHook(script);
    const lane = path.join(directory, 'wt', 'lane-0123456789ab'); await mkdir(lane, { recursive: true });
    const events = path.join(directory, 'events');
    const command = codexNotifyCommand({ executable: process.execPath, script, eventsDir: events, worktreeRoot: path.join(directory, 'wt') });
    const payload = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'x', cwd: lane, 'last-assistant-message': 'He said "hi"; then {left} it' });
    const ran = spawnSync(command[0]!, [...command.slice(1), payload], { cwd: lane, timeout: 30_000, windowsHide: true, input: '', env: { ...process.env, HYDRA_LANE_ID: 'abcdef012345' } });
    assert.equal(ran.status, 0, String(ran.stderr));
    const written = (await readdir(path.join(events, 'attention')).catch(() => [])).filter(name => name.endsWith('.json'));
    assert.equal(written.length, 1, 'the notifier recorded the turn');
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

const spec: HelperServerSpec = { command: 'C:\\Hydra\\Hydra.exe', args: ['C:\\Hydra\\dist\\hydra-mcp.cjs'], env: { ELECTRON_RUN_AS_NODE: '1', HYDRA_HELPERS_DIR: 'C:\\h' } };
test('Codex\'s notifier is Hydra\'s own marked block at the top, and a user\'s own notify is never replaced', () => {
  const command = codexNotifyCommand({ ...options, worktreeRoot: 'D:\\wt' });
  assert.equal(command.at(-1)!.endsWith('; exit 0 #'), true, 'the appended payload lands in a PowerShell comment');
  for (const original of ['', 'model = "gpt-5"\n', 'model = "gpt-5"\r\n\r\n[tui]\r\nnotifications = true\r\n', '# my notes\n[projects."C:\\\\x"]\ntrust_level = "trusted"\n']) {
    const withBlock = addCodexBlock(original, spec);
    const added = addCodexNotify(withBlock, command);
    assert.ok(added.startsWith('# >>> Hydra lane notifier'), 'at the top, where a top-level key must be');
    assert.equal(addCodexNotify(added, command), added, 'writing twice changes nothing');
    assert.equal(removeCodexBlock(removeCodexNotify(added).text).text, original, 'both blocks out, byte-identical');
    assert.equal(removeCodexNotify(added).text, withBlock);
    assert.deepEqual(codexNotifyPaths(added), { executable: options.executable, script: options.script });
    // Moving Hydra rewrites it; asking for none removes it.
    assert.ok(addCodexNotify(added, codexNotifyCommand({ ...options, executable: 'D:\\Hydra\\Hydra.exe' })).includes('D:\\\\Hydra\\\\Hydra.exe'));
    assert.equal(addCodexNotify(added, undefined), withBlock);
  }
  // The user's own notify: no signal, nothing written. If they add one after Hydra's, Hydra's goes at the next refresh.
  const theirs = 'notify = ["notify-send", "codex"]\nmodel = "gpt-5"\n';
  assert.equal(codexHasOwnNotify(theirs), true);
  assert.equal(addCodexNotify(theirs, command), theirs);
  const after = addCodexNotify('model = "x"\n', command).replace('model = "x"', 'notify = ["mine"]\nmodel = "x"');
  assert.equal(codexHasOwnNotify(after), true);
  assert.equal(addCodexNotify(after, command), 'notify = ["mine"]\nmodel = "x"\n');
  // A `notify` inside a table is that table's key, not the top-level one.
  assert.equal(codexHasOwnNotify('[tui]\nnotify = true\n'), false);
  assert.throws(() => removeCodexNotify('# >>> Hydra lane notifier (managed by Hydra: connect or disconnect in Hydra Settings)\nnotify = []\n'), /damaged/);
});

test('Codex\'s notifier survives Codex\'s own edits, a BOM, a comment above it, and tricky TOML of the user\'s', () => {
  const command = codexNotifyCommand({ ...options });
  const block = addCodexNotify('', command);
  // Codex writes a key between Hydra's own line and its end marker: only Hydra's three lines go.
  const [start, own, end] = block.trimEnd().split('\n');
  const edited = `${start}\n${own}\nmodel = "gpt-5"\n${end}\n`;
  assert.equal(removeCodexNotify(edited).text, 'model = "gpt-5"\n');
  assert.equal(addCodexNotify(edited, undefined), 'model = "gpt-5"\n');
  assert.equal(addCodexNotify(edited, command), edited, 'a refresh keeps what Codex added');
  // A BOM stays first; the block goes after it and comes out again.
  const bom = '\uFEFFmodel = "x"\n';
  const withBom = addCodexNotify(bom, command);
  assert.ok(withBom.startsWith('\uFEFF# >>> Hydra lane notifier'));
  assert.equal(removeCodexNotify(withBom).text, bom);
  assert.ok(codexNotifyPaths(withBom).script);
  // A comment above the block doesn't hide it from removal or reading.
  const commented = `#:schema x\n${block}model = "x"\n`;
  assert.equal(removeCodexNotify(commented).text, '#:schema x\nmodel = "x"\n');
  assert.equal(codexNotifyPaths(commented).script, options.script);
  // The user's own notify after a multi-line string or a nested array that has a line starting with `[`.
  for (const theirs of ['developer_instructions = """\n[Important] run tests\n"""\nnotify = ["mine"]\n', 'foo = [\n  [1, 2],\n]\nnotify = ["mine"]\n', 'a = \'\'\'\n[x]\n\'\'\'\n# [not a table]\nnotify = ["mine"]\n']) {
    assert.equal(codexHasOwnNotify(theirs), true, theirs);
    assert.equal(addCodexNotify(theirs, command), theirs);
  }
  assert.equal(codexHasOwnNotify('s = "[notify = 1]"\n[t]\nnotify = 1\n'), false);
  // A trailing separator on the worktree root would reach PowerShell 5.1 as a stray quote.
  assert.equal(attentionHookGroups({ ...options, worktreeRoot: 'D:\\Hydra Lanes\\' }).Stop.hooks[0]!.args[4]!.includes("'D:\\Hydra Lanes';"), true);
  assert.equal(codexNotifyCommand({ ...options, worktreeRoot: 'D:\\Hydra Lanes\\' })[5]!.includes("'D:\\Hydra Lanes' '--codex'"), true);
});

test('the watcher hands an event only to the window that owns its lane, once', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-watch-'));
  try {
    const folder = path.join(directory, 'attention'); await mkdir(folder);
    const write = (name: string, event: object) => writeFile(path.join(folder, name), JSON.stringify(event));
    const at = new Date().toISOString();
    await write(`${Date.now()}-0000000000000001.json`, { provider: 'claude', attention: 'waiting', at, laneId: 'aaaaaaaaaaaa' });
    await write(`${Date.now()}-0000000000000002.json`, { provider: 'claude', attention: 'waiting', at, laneId: 'bbbbbbbbbbbb' });
    await write(`${Date.now()}-0000000000000003.json`, { nonsense: true });
    const got: [string, string][] = [];
    const watcher = new AttentionWatcher({ directory: folder, laneOf: event => event.laneId === 'aaaaaaaaaaaa' ? event.laneId : undefined, scanMs: 60_000 });
    watcher.onAttention((laneId, event) => got.push([laneId, event.attention]));
    await watcher.start(); await watcher.scan(); watcher.dispose();
    assert.deepEqual(got, [['aaaaaaaaaaaa', 'waiting']]);
    // The other window's event stays for it; the nonsense is gone; the claimed one is gone.
    assert.deepEqual(await readdir(folder), [`${/(\d{13})/.exec((await readdir(folder))[0]!)![1]}-0000000000000002.json`]);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

async function laneService() {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-attn-lane-'));
  const repo = path.join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await git(root, ['init', '-q', '-b', 'main', repo]);
  await git(repo, ['config', 'user.email', 'test@example.invalid']); await git(repo, ['config', 'user.name', 'Test']);
  await writeFile(path.join(repo, 'a.txt'), 'a\n');
  await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'init']);
  const store = new LaneStore(path.join(root, 'store')); await store.load();
  const pty = fakePtyModule();
  let clock = 1_000_000;
  const service = new LaneService({
    store, repository: repo, worktreeRoot: () => path.join(root, 'wt'), pty, executable: async () => 'true', connected: async () => true,
    bridge: () => ({ command: 'node', args: [], env: {} }), helpersDir: path.join(root, 'helpers'), configDirectory: path.join(root, 'cfg'),
    testCommand: () => 'true', now: () => new Date(clock),
  });
  return { service, pty, advance: (ms: number) => { clock += ms; }, close: async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } };
}

test('a lane\'s attention is set by an event, shown on its view, and cleared by typing or resumed output', async () => {
  const { service, pty, advance, close } = await laneService();
  try {
    const lane = await service.create({ name: 'Lane 1', provider: 'claude' }), other = await service.create({ name: 'Lane 2', provider: 'codex' });
    const attentionOf = (id: string) => service.views().find(view => view.id === id)?.attention;
    assert.equal(attentionOf(lane.id), undefined);
    assert.equal(service.setAttention(lane.id, 'turn-ended'), true);
    assert.equal(attentionOf(lane.id), 'turn-ended'); assert.equal(attentionOf(other.id), undefined);
    // A question outranks "finished its turn", and a later "finished" doesn't hide it.
    service.setAttention(lane.id, 'waiting'); service.setAttention(lane.id, 'turn-ended');
    assert.equal(attentionOf(lane.id), 'waiting');
    // The agent's own redraw right after the signal is not "resumed".
    pty.spawned[0]!.emit('prompt redraw'); await settle(); assert.equal(attentionOf(lane.id), 'waiting');
    // Focus and mouse reports from the terminal aren't typing.
    for (const report of ['\u001b[I', '\u001b[O', '\u001b[<0;10;5M', '\u001b[<0;10;5m']) { assert.equal(isTypedInput(report), false); service.input(lane.id, report); }
    await settle();
    assert.equal(attentionOf(lane.id), 'waiting');
    // Answers to the agent's terminal queries aren't typing either.
    for (const reply of ['\u001b[12;40R', '\u001b[?62;c', '\u001b]11;rgb:0000/0000/0000\u0007', '\u001bP1$r0m\u001b\\']) { assert.equal(isTypedInput(reply), false, JSON.stringify(reply)); service.input(lane.id, reply); }
    assert.equal(isTypedInput('\u001b[A'), true, 'an arrow key is typing');
    assert.equal(attentionOf(lane.id), 'waiting');
    // Typing clears it.
    assert.equal(service.input(lane.id, 'y'), true); assert.equal(attentionOf(lane.id), undefined);
    // Output after the grace period clears it.
    service.setAttention(lane.id, 'turn-ended'); advance(attentionOutputGraceMs + 1); pty.spawned[0]!.emit('working…'); await settle();
    assert.equal(attentionOf(lane.id), undefined);
    // An exited lane isn't waiting for anyone; an event for an unknown lane is ignored.
    service.setAttention(other.id, 'waiting'); pty.spawned[1]!.exit(0); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(attentionOf(other.id), undefined);
    assert.equal(service.setAttention(other.id, 'waiting'), false);
    assert.equal(service.setAttention('ffffffffffff', 'waiting'), false);
    // An event signalled before the terminal started (a file left over from the last session) is ignored.
    assert.equal(service.setAttention(lane.id, 'waiting', 1_000_000 - 60_000), false);
    assert.equal(attentionOf(lane.id), undefined);
    assert.equal(service.setAttention(lane.id, 'waiting', 1_000_000 + 10_000), true);
  } finally { await close(); }
});

test('the Lanes view puts the lanes waiting for you first, and keeps each group\'s order', () => {
  const lanes = [{ id: 'a' }, { id: 'b', attention: 'turn-ended' as const }, { id: 'c', attention: 'waiting' as const }, { id: 'd' }, { id: 'e', attention: 'waiting' as const }];
  assert.deepEqual(waitingFirst(lanes).map(lane => lane.id), ['c', 'e', 'a', 'b', 'd']);
  assert.deepEqual(waitingFirst([]), []);
  assert.equal(lanes[0]!.id, 'a', 'the input is not reordered');
});

void ({} as Lane);
