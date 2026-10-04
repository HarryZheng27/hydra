import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { confirmAndOpen, CONTENT_SECURITY_POLICY, externalLink, guardContents, guardSession, hardenedWebPreferences, requestAllowed, resolveAppFile, serveAppRequest } from '../src/main/security';

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

test('every app:// response, including errors, carries the CSP', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-app-csp-'));
  try {
    fs.writeFileSync(path.join(root, 'index.html'), '<p>hi</p>');
    for (const url of ['app://hydra/index.html', 'app://hydra/missing.js', 'app://other/index.html']) {
      assert.equal((await serveAppRequest(root, url)).headers.get('content-security-policy'), CONTENT_SECURITY_POLICY, url);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  assert.match(CONTENT_SECURITY_POLICY, /^default-src 'none'; script-src 'self';/);
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /unsafe-eval|https?:|\*/);
  assert.match(CONTENT_SECURITY_POLICY, /require-trusted-types-for 'script'/);
  // Images only as data: URLs main made (gate screenshots, G5): no image is fetched from anywhere.
  assert.match(CONTENT_SECURITY_POLICY, /; img-src data:;/);
});

test('navigation by any frame, redirects and webviews are blocked; window.open is denied and only http(s) goes to the confirm', () => {
  const listeners: Record<string, (event: { preventDefault(): void }, url?: string) => void> = {};
  let openHandler: ((details: { url: string }) => { action: 'deny' }) | undefined;
  const confirmed: string[] = [];
  guardContents({ on: (name: string, listener: never) => { listeners[name] = listener; }, setWindowOpenHandler: (handler: typeof openHandler) => { openHandler = handler; } } as never, url => confirmed.push(url));
  for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) {
    let prevented = false;
    listeners[name]!({ preventDefault: () => { prevented = true; } }, 'https://example.com/');
    assert.equal(prevented, true, name);
  }
  for (const url of ['https://example.com/a', 'http://example.com/b', 'file:///C:/x', 'javascript:alert(1)', 'app://hydra/index.html', 'https://user:pass@example.com/', 'mailto:a@b.c']) {
    assert.deepEqual(openHandler!({ url }), { action: 'deny' }, url);
  }
  assert.deepEqual(confirmed, ['https://example.com/a', 'http://example.com/b']);
});

test('an external link opens only after the user confirms it', async () => {
  const opened: string[] = [];
  const asked: string[] = [];
  const deps = (answer: boolean) => ({ ask: async (url: string) => { asked.push(url); return answer; }, open: async (url: string) => { opened.push(url); } });
  assert.equal(await confirmAndOpen('https://example.com/no', deps(false)), false);
  assert.equal(await confirmAndOpen('https://example.com/yes', deps(true)), true);
  assert.equal(await confirmAndOpen('file:///C:/Windows/win.ini', deps(true)), false);
  assert.deepEqual(asked, ['https://example.com/no', 'https://example.com/yes']);
  assert.deepEqual(opened, ['https://example.com/yes']);
  assert.equal(externalLink('HTTPS://Example.com'), 'https://example.com/');
  assert.equal(externalLink(`https://example.com/${'a'.repeat(3000)}`), undefined, 'an overlong link is dropped');
});

test('one confirm at a time per window: links a page sends while one is open are dropped', async () => {
  let release: (answer: boolean) => void = () => undefined;
  const asked: string[] = [];
  const window = {};
  const deps = { ask: (url: string) => { asked.push(url); return new Promise<boolean>(resolve => { release = resolve; }); }, open: async () => undefined };
  const first = confirmAndOpen('https://example.com/1', deps, window);
  assert.equal(await confirmAndOpen('https://example.com/2', deps, window), false);
  assert.equal(await confirmAndOpen('https://example.com/3', deps, window), false);
  release(false);
  assert.equal(await first, false);
  const again = confirmAndOpen('https://example.com/4', deps, window);
  release(true);
  assert.equal(await again, true);
  assert.deepEqual(asked, ['https://example.com/1', 'https://example.com/4']);
});

test('the session refuses every permission, every download and every request off the app scheme', () => {
  let request: ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void) | undefined;
  let check: (() => boolean) | undefined;
  let before: ((details: { url: string }, callback: (response: { cancel: boolean }) => void) => void) | undefined;
  let download: ((event: { preventDefault(): void }) => void) | undefined;
  guardSession({ setPermissionRequestHandler: h => { request = h; }, setPermissionCheckHandler: h => { check = h; }, webRequest: { onBeforeRequest: l => { before = l; } }, on: (_name, l) => { download = l; } });
  let downloadPrevented = false;
  download!({ preventDefault: () => { downloadPrevented = true; } });
  assert.equal(downloadPrevented, true, 'downloads are refused');
  for (const permission of ['media', 'notifications', 'clipboard-read', 'openExternal', 'geolocation']) request!(undefined, permission, granted => assert.equal(granted, false, permission));
  assert.equal(check!(), false);
  const cancelled = (url: string) => { let result: boolean | undefined; before!({ url }, response => { result = response.cancel; }); return result; };
  for (const url of ['app://hydra/index.html', 'data:text/plain,x', 'devtools://devtools/bundled/x.html']) assert.equal(cancelled(url), false, url);
  for (const url of ['https://example.com/', 'http://127.0.0.1:1234/', 'file:///C:/x', 'app://other/x', 'ws://example.com/', 'nonsense']) assert.equal(cancelled(url), true, url);
  assert.equal(requestAllowed('app://hydra/x'), true);
});

test('startup guards every webContents and the session before any window opens', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'startup.ts'), 'utf8');
  assert.match(source, /app\.on\('web-contents-created', \(_event, contents\) => guardContents\(/);
  assert.match(source, /app\.on\('session-created', created => guardSession\(created\)\)/);
  const ready = source.slice(source.indexOf('app.whenReady()'));
  assert.ok(ready.indexOf('guardSession(session.defaultSession)') >= 0);
  assert.ok(ready.indexOf('guardSession(') < ready.indexOf('createMainWindow('));
  assert.ok(ready.indexOf('registerIpc(') < ready.indexOf('createMainWindow('));
});
