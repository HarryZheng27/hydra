import assert from 'node:assert/strict';
import { test } from 'node:test';
import { noSettingsImports, settingsDocument, settingsMessageFrom } from '../src/main/settingsWindow';
import { vscodeThemeVariables } from '../src/shared/theme';

const page = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-abc'; script-src 'nonce-abc';"><style nonce="abc">body{margin:0}</style></head><body><script nonce="abc">1</script></body></html>`;

test('Hydra Settings keeps the IDE page\'s own CSP and gets the app\'s theme as VS Code\'s variables, inside its nonce\'d style (G5)', () => {
  const dark = settingsDocument(page, 'dark');
  assert.ok(dark.includes(`content="default-src 'none'; style-src 'nonce-abc'; script-src 'nonce-abc';"`), 'the CSP is the IDE page\'s, unchanged');
  assert.match(dark, /<style nonce="abc">:root\{--vscode-font-family:[^}]*--vscode-editor-background:#[0-9a-fA-F]{6,8}[;}]/);
  assert.equal((dark.match(/<style/g) ?? []).length, 1, 'no other style element: the CSP allows only the nonce\'d one');
  assert.equal((dark.match(/<script/g) ?? []).length, 1);
  assert.notEqual(vscodeThemeVariables('dark')['--vscode-editor-background'], vscodeThemeVariables('light')['--vscode-editor-background']);
  for (const [name, value] of Object.entries(vscodeThemeVariables('light'))) {
    assert.match(name, /^--vscode-[a-zA-Z0-9-]+$/);
    assert.doesNotMatch(value, /[;{}<>]/, `${name} can't close the rule or the style`);
  }
  assert.throws(() => settingsDocument('<html></html>', 'dark'), /no style/);
});

test('the IDE\'s settings import isn\'t in the app: General shows it as unavailable, and every step refuses', async () => {
  assert.equal(noSettingsImports.available, false);
  assert.deepEqual(await noSettingsImports.status(), { available: false, interrupted: false });
  await assert.rejects(noSettingsImports.choose('vscode'), /IDE's/);
  await assert.rejects(noSettingsImports.apply('token', []), /IDE's/);
  await assert.rejects(noSettingsImports.undo(), /IDE's/);
});

test('main takes a settings message only from that window\'s own page, and only of a size it reads', () => {
  const mainFrame = {}, webContents = { mainFrame };
  const win = { isDestroyed: () => false, webContents };
  assert.equal(settingsMessageFrom({ sender: webContents, senderFrame: mainFrame }, win, { type: 'ready' }), true);
  assert.equal(settingsMessageFrom({ sender: { mainFrame }, senderFrame: mainFrame }, win, { type: 'ready' }), false, 'another window\'s page');
  assert.equal(settingsMessageFrom({ sender: webContents, senderFrame: {} }, win, { type: 'ready' }), false, 'a frame inside the page');
  assert.equal(settingsMessageFrom({ sender: webContents, senderFrame: mainFrame }, undefined, { type: 'ready' }), false, 'no settings window open');
  assert.equal(settingsMessageFrom({ sender: webContents, senderFrame: mainFrame }, { ...win, isDestroyed: () => true }, { type: 'ready' }), false, 'a closed one');
  assert.equal(settingsMessageFrom({ sender: webContents, senderFrame: mainFrame }, win, { type: 'x', blob: 'x'.repeat(200_001) }), false, 'too large');
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.equal(settingsMessageFrom({ sender: webContents, senderFrame: mainFrame }, win, cyclic), false, 'not JSON');
});
