import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hardenedWebPreferences, resolveAppFile, serveAppRequest } from '../src/main/security';

test('app:// resolves only inside the renderer folder, on the hydra host', () => {
  const root = path.resolve(os.tmpdir(), 'app', 'dist', 'renderer');
  assert.equal(resolveAppFile(root, 'app://hydra/index.html'), path.join(root, 'index.html'));
  assert.equal(resolveAppFile(root, 'app://hydra/'), path.join(root, 'index.html'));
  assert.equal(resolveAppFile(root, 'app://hydra/a/b.js'), path.join(root, 'a', 'b.js'));
  // The URL parser folds a literal ../ away, so it can't leave the folder.
  assert.equal(resolveAppFile(root, 'app://hydra/../main.cjs'), path.join(root, 'main.cjs'));
  assert.equal(resolveAppFile(root, 'app://hydra/%2e%2e/main.cjs'), path.join(root, 'main.cjs'));
  // Encoded separators survive the parser, so the resolved path is what keeps them in.
  const bad = [
    'app://hydra/..%5cmain.cjs', 'app://hydra/..%2f..%2fsecret',
    'app://other/index.html', 'https://hydra/index.html', 'file:///C:/app/dist/renderer/index.html', 'app://hydra/%E0%A4%A', 'nonsense',
  ];
  for (const url of bad) assert.equal(resolveAppFile(root, url), undefined, url);
});

test('serving refuses escapes and missing files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-app-serve-'));
  try {
    fs.writeFileSync(path.join(root, 'index.html'), '<p>hi</p>');
    const ok = await serveAppRequest(root, 'app://hydra/index.html');
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await serveAppRequest(root, 'app://hydra/missing.js')).status, 404);
    assert.equal((await serveAppRequest(root, 'app://hydra/..%2f..%2fsecret')).status, 403);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('windows get context isolation, the sandbox, and no Node or webview tag', () => {
  const prefs = hardenedWebPreferences('preload.cjs');
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.nodeIntegrationInWorker, false);
  assert.equal(prefs.nodeIntegrationInSubFrames, false);
  assert.equal(prefs.webviewTag, false);
  assert.equal(prefs.webSecurity, true);
});
