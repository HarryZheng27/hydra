// App smoke: starts the built app twice, hidden, against a scratch AppData folder, and checks what it finds.
// `npm run smoke` builds first. No window is ever shown and no provider CLI is started.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// G1's CSP (docs/internal/hydra-app/G1-spikes.md, S4 item 4), written out here so the smoke checks the app against
// the decision, not against itself.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types hydraWorker defaultWorkerFactory diffEditorWidget diffReview domLineBreaksComputer editorViewLayer richScreenReaderContent standaloneColorizer tokenizeToString stickyScrollViewLayer editorGhostText dompurify";
const electron = createRequire(import.meta.url)('electron');
const work = path.join(appDir, '.smoke', String(Date.now()));
const appData = path.join(work, 'AppData', 'Roaming');
const out = path.join(work, 'out');
fs.mkdirSync(appData, { recursive: true });
fs.mkdirSync(out, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // Claude Code's shell sets it; Electron would start as plain Node.

function launch(role) {
  const child = spawn(electron, [path.join(appDir, 'smoke', 'harness.cjs'), `--smoke-role=${role}`, `--smoke-out=${out}`, `--smoke-appdata=${appData}`], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  const killer = setTimeout(() => child.kill(), 90000);
  void exited.then(() => clearTimeout(killer));
  return { exited, log: () => log };
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = role => { try { return JSON.parse(fs.readFileSync(path.join(out, `${role}.json`), 'utf8')); } catch { return undefined; } };
async function until(test, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (test()) return; await wait(100); }
  throw new Error(`Timed out waiting for ${what}.`);
}

const checks = [];
const check = (name, fn) => { fn(); checks.push(name); console.log(`ok - ${name}`); };
const first = launch('first');
let failed = false;
try {
  await until(() => read('first')?.events.includes('ready'), 60000, 'the first instance to load');
  const second = launch('second');
  const secondCode = await second.exited;
  const firstCode = await first.exited;
  const a = read('first'), b = read('second');

  check('the app opens one window on app://hydra/', () => {
    assert.equal(a.windowsAtLoad, 1);
    assert.equal(a.url, 'app://hydra/index.html');
    assert.equal(a.title, 'Hydra');
    assert.equal(a.name, 'Hydra');
  });
  check('user data is under Hydra App, never the IDE Hydra folder', () => {
    const own = path.join(appData, 'Hydra App').toLowerCase();
    const ide = path.join(appData, 'Hydra').toLowerCase();
    for (const name of ['userData', 'sessionData', 'logs', 'crashDumps']) {
      const value = path.resolve(a.paths[name]).toLowerCase();
      assert.ok(value === own || value.startsWith(own + path.sep), `${name} is ${a.paths[name]}`);
      assert.ok(value !== ide && !value.startsWith(ide + path.sep), `${name} is inside the IDE's folder`);
    }
    assert.ok(fs.existsSync(path.join(appData, 'Hydra App')), 'Hydra App was not created');
    assert.ok(!fs.existsSync(path.join(appData, 'Hydra')), 'something was written to the IDE\'s %APPDATA%\\Hydra');
  });
  check('the preload exposes only the typed API, and the renderer has no Node', () => {
    assert.deepEqual(a.hydraKeys, ['appInfo']);
    assert.equal(a.appInfo.name, 'Hydra');
    assert.equal(a.nodeInRenderer, 'undefined/undefined');
  });
  check('windows are hardened: context isolation, sandbox, no Node, no webview tag', () => {
    const prefs = a.webPreferences;
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.sandbox, true);
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.nodeIntegrationInWorker, false);
    assert.equal(prefs.nodeIntegrationInSubFrames, false);
    assert.equal(prefs.webviewTag, false);
    assert.equal(prefs.webSecurity, true);
    assert.equal(a.webviewTag, 'undefined');
  });
  check('every app:// response carries the G1 CSP', () => {
    for (const [file, response] of Object.entries(a.headers)) {
      assert.equal(response.csp, CSP, file);
      assert.equal(response.nosniff, 'nosniff', file);
    }
    assert.equal(a.headers['missing.js'].status, 404);
  });
  check('the CSP holds in the page: no inline script, eval or remote fetch, and no violations from the app itself', () => {
    // Trusted Types refuses the script's text outright; failing that, the CSP would refuse to run it.
    assert.match(a.inlineScript, /^(threw: TypeError|undefined)$/);
    assert.match(a.evalBlocked, /^threw: EvalError/);
    assert.match(a.remoteFetch, /^failed/);
    assert.match(a.mainSessionRemote, /ERR_BLOCKED_BY_CLIENT/);
    const violations = a.consoleAtLoad.filter(m => /Content Security Policy|Trusted ?Type|TrustedHTML|TrustedScript/i.test(m.message));
    assert.deepEqual(violations, [], 'the app broke its own CSP while loading');
  });
  check('navigation is blocked, and window.open is denied with http(s) links sent through a confirm', () => {
    assert.equal(a.urlAfterNavigate, 'app://hydra/index.html');
    assert.equal(a.openResult, 'null');
    assert.deepEqual(a.confirms, ['https://example.com/cancelled', 'https://example.com/accepted']);
    assert.deepEqual(a.opened, ['https://example.com/accepted']);
    assert.equal(a.windowsAfterOpen, 1);
    assert.equal(a.permission, 'denied');
    assert.deepEqual(a.downloads, [{ prevented: true, name: 'invoice.bat' }], 'the download was not refused');
    assert.equal(a.saveDialogs, 0);
  });
  check('main refuses an unknown IPC channel, an unknown call and an invalid payload', () => {
    assert.equal(a.ipc.unknownTransport.ok, false);
    assert.match(a.ipc.unknownTransport.error, /No handler registered/);
    assert.equal(a.ipc.unknownChannel.ok, false);
    assert.match(a.ipc.unknownChannel.error, /Refused: Unknown channel/);
    assert.equal(a.ipc.badPayload.ok, false);
    assert.match(a.ipc.badPayload.error, /Refused: Invalid payload/);
    assert.equal(a.ipc.extraField.ok, false);
    assert.equal(a.ipc.valid.ok, true);
    assert.equal(a.ipc.foreignSender.ok, false);
    assert.match(a.ipc.foreignSender.error, /did not come from the app/);
  });
  check('a second launch focuses the first and exits', () => {
    assert.equal(a.hasLock, true);
    assert.equal(secondCode, 0, second.log());
    assert.equal(b.exitedWithLock, false);
    assert.ok(!b.events.includes('window-created'), 'the second launch opened a window');
    const at = a.events.indexOf('second-instance');
    assert.ok(at >= 0, 'the first instance never heard of the second');
    assert.ok(a.events.slice(at).includes('focus'), 'the first instance did not focus its window');
    assert.equal(firstCode, 0, first.log());
  });
} catch (error) {
  failed = true;
  console.error(`not ok - ${error.message}`);
  console.error(first.log());
} finally {
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
  else console.error(`Smoke output kept in ${work}`);
}
console.log(`${checks.length} smoke checks passed${failed ? ', then one failed' : ''}.`);
process.exitCode = failed ? 1 : 0;
