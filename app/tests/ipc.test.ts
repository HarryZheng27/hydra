import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatch, registerIpc, trustedSender, type Handlers } from '../src/main/ipc';
import { channels, IPC_TRANSPORT, parseCall, validators } from '../src/shared/ipc';

// Only app.info runs in these tests; the rest are never reached.
const handlers = { 'app.info': () => ({ name: 'Hydra', version: '1', electron: '44', platform: 'win32' }) } as unknown as Handlers;
const frame = (url: string) => { const mainFrame = { url }; return { senderFrame: mainFrame, sender: { mainFrame } }; };
const fromApp = frame('app://hydra/index.html');

test('a known channel with a valid payload runs', async () => {
  assert.deepEqual(await dispatch(handlers, fromApp, { channel: 'app.info', payload: null }), handlers['app.info'](null));
});

test('unknown channels are refused in main', async () => {
  for (const channel of ['nope', '__proto__', 'constructor', 'toString', '', 42, undefined]) {
    await assert.rejects(dispatch(handlers, fromApp, { channel, payload: null }), /Refused: Unknown channel/);
  }
});

test('invalid payloads and malformed calls are refused in main', async () => {
  await assert.rejects(dispatch(handlers, fromApp, { channel: 'app.info', payload: { x: 1 } }), /Invalid payload/);
  await assert.rejects(dispatch(handlers, fromApp, { channel: 'app.info' }), /Invalid payload/);
  await assert.rejects(dispatch(handlers, fromApp, { channel: 'app.info', payload: null, extra: 1 }), /only a channel and a payload/);
  for (const raw of [null, undefined, 'app.info', [], 7]) await assert.rejects(dispatch(handlers, fromApp, raw), /must be an object/);
});

test('calls from anything but the main frame of an app:// page are refused', async () => {
  for (const url of ['https://example.com/', 'file:///C:/x.html', 'app://evil/index.html', 'about:blank', 'not a url', '']) {
    assert.equal(trustedSender(frame(url)), false, url);
    await assert.rejects(dispatch(handlers, frame(url), { channel: 'app.info', payload: null }), /did not come from the app/);
  }
  assert.equal(trustedSender({ senderFrame: null }), false);
  assert.equal(trustedSender({}), false);
  assert.equal(trustedSender(fromApp), true);
  // A subframe on the app's own origin is still refused: only the main frame may call.
  assert.equal(trustedSender({ senderFrame: { url: 'app://hydra/index.html' }, sender: { mainFrame: { url: 'app://hydra/index.html' } } }), false);
  assert.equal(trustedSender({ senderFrame: { url: 'app://hydra/index.html' } }), false);
});

test('main registers exactly one transport channel', () => {
  const registered: string[] = [];
  registerIpc({ handle: channel => registered.push(channel) }, handlers);
  assert.deepEqual(registered, [IPC_TRANSPORT]);
});

test('every channel has a validator, and parseCall agrees with it', () => {
  assert.deepEqual([...channels].sort(), ['app.info', 'app.problems', 'browser.back', 'browser.bounds', 'browser.close', 'browser.forward', 'browser.navigate', 'browser.open', 'browser.reload', 'chats.answer', 'chats.archive', 'chats.commands', 'chats.configure', 'chats.continueCloud', 'chats.create', 'chats.list', 'chats.open', 'chats.openTerminal', 'chats.prepare', 'chats.pullRequest', 'chats.remove', 'chats.rename', 'chats.send', 'chats.setWhere', 'chats.stop', 'chats.terminalClosed', 'chats.turnDiff', 'chats.undoTurn', 'hydra.agents', 'hydra.connect', 'hydra.connections', 'hydra.control', 'hydra.disconnect', 'hydra.reply', 'hydra.tree', 'onboarding.check', 'onboarding.signIn', 'projects.clone', 'projects.pick', 'projects.remove', 'projects.trust', 'review.branch', 'review.diff', 'review.open', 'settings.clearCliPath', 'settings.get', 'settings.pickCliPath', 'settings.setDisplayName', 'settings.setTheme', 'settings.setWhenAway', 'state.get', 'state.setSidebarOpen', 'terminal.close', 'terminal.resize', 'terminal.shell', 'terminal.tabs', 'terminal.write', 'updates.check', 'updates.setAutomatic', 'updates.status']);
  assert.equal(parseCall({ channel: 'app.info', payload: null }).ok, true);
  const good: Array<[string, unknown]> = [
    ['settings.setTheme', { theme: 'system' }], ['settings.pickCliPath', { provider: 'codex' }], ['settings.clearCliPath', { provider: 'claude' }],
    ['onboarding.check', { refresh: true }], ['onboarding.signIn', { provider: 'claude' }],
    ['state.setSidebarOpen', { open: false }], ['projects.remove', { id: '0f8fad5b-d9cb-469f-a165-70867728950e' }], ['projects.pick', null],
  ];
  for (const [channel, payload] of good) assert.equal(parseCall({ channel, payload }).ok, true, channel);
});

test('no payload field accepts a path, a command or free text', () => {
  const samples: Record<string, Record<string, unknown>> = {
    'settings.setTheme': { theme: 'dark' }, 'settings.pickCliPath': { provider: 'claude' }, 'settings.clearCliPath': { provider: 'codex' },
    'state.setSidebarOpen': { open: true }, 'projects.remove': { id: '0f8fad5b-d9cb-469f-a165-70867728950e' },
    'onboarding.check': { refresh: false }, 'onboarding.signIn': { provider: 'codex' }, 'updates.setAutomatic': { on: true },
    'chats.setWhere': { id: '0f8fad5b-d9cb-469f-a165-70867728950e', where: 'cloud' },
  };
  for (const channel of channels) {
    const sample = samples[channel];
    if (!sample) { assert.equal(parseCall({ channel, payload: { path: 'C:\\x.exe' } }).ok, false, channel); continue; }
    assert.equal(parseCall({ channel, payload: sample }).ok, true, channel);
    for (const key of Object.keys(sample)) {
      for (const hostile of ['C:\\Windows\\System32\\cmd.exe', '../../x', 'claude --dangerously-skip-permissions', 'x'.repeat(40)]) {
        assert.equal(parseCall({ channel, payload: { ...sample, [key]: hostile } }).ok, false, `${channel}.${key} took ${hostile}`);
      }
    }
  }
});

test('no channel takes a path or a command from the renderer', () => {
  const bad: Array<[string, unknown]> = [
    ['settings.setTheme', { theme: 'hacker' }], ['settings.setTheme', { theme: 'dark', extra: 1 }],
    ['settings.pickCliPath', { provider: 'claude', path: 'C:/evil.exe' }], ['settings.pickCliPath', { provider: 'bash' }],
    ['state.setSidebarOpen', { open: 'yes' }], ['projects.pick', { path: 'C:/Users' }], ['projects.remove', { id: '../x' }],
    ['projects.remove', { id: 'a'.repeat(100) }], ['settings.get', {}],
    ['onboarding.signIn', { provider: 'claude', args: ['--dangerously-skip-permissions'] }], ['onboarding.signIn', { provider: 'claude', executable: 'C:/evil.exe' }],
    ['onboarding.check', { refresh: true, cwd: 'C:/repo' }], ['onboarding.check', null],
  ];
  for (const [channel, payload] of bad) assert.equal(parseCall({ channel, payload }).ok, false, `${channel} ${JSON.stringify(payload)}`);
});

test('the Agents view\'s messages and Hydra\'s answers are checked in main (G5)', () => {
  const agents = validators['hydra.agents'], reply = validators['hydra.reply'];
  const id = '0123456789abcdef';
  assert.equal(agents({ projectId: id, message: { type: 'ready' } }), true);
  for (const message of [null, 'ready', [], { type: 'x', blob: 'x'.repeat(200_001) }]) assert.equal(agents({ projectId: id, message }), false, JSON.stringify(message).slice(0, 40));
  assert.equal(agents({ projectId: '../x', message: { type: 'ready' } }), false);
  assert.equal(agents({ projectId: id, message: { type: 'ready' }, extra: 1 }), false);
  for (const value of [null, 0, 3, [0, 2], 'an answer']) assert.equal(reply({ requestId: crypto.randomUUID(), value }), true, String(value));
  for (const value of [-1, 1.5, [0, -1], { a: 1 }, 'x'.repeat(20_001), undefined]) assert.equal(reply({ requestId: crypto.randomUUID(), value }), false, String(value));
  assert.equal(reply({ requestId: 'not an id', value: 0 }), false);
});
