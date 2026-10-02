// App smoke: starts the built app twice, hidden, against a scratch AppData folder, and checks what it finds.
// `npm run smoke` builds first. No window is ever shown and no provider CLI is started.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
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
    assert.equal(a.events.filter(e => e === 'window-created').length, 1);
    assert.equal(a.url, 'app://hydra/index.html');
    assert.equal(a.title, 'Hydra');
    assert.equal(a.name, 'Hydra');
  });
  check('user data is under Hydra App, never the IDE\'s Hydra folder', () => {
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
