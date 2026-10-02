import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatch, registerIpc, trustedSender, type Handlers } from '../src/main/ipc';
import { channels, IPC_TRANSPORT, parseCall } from '../src/shared/ipc';

const handlers: Handlers = { 'app.info': () => ({ name: 'Hydra', version: '1', electron: '44', platform: 'win32' }) };
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
  assert.deepEqual([...channels], ['app.info']);
  assert.equal(parseCall({ channel: 'app.info', payload: null }).ok, true);
});
