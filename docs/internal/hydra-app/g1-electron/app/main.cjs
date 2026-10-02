// S4 spike app main. One entry, several checks chosen with --spike=<pty|renderer|identity>.
// Never shows a window: renderer windows are offscreen and show:false.
// Results go to --out=<dir> (the app itself may be inside a read-only app.asar).
const { app, BrowserWindow, protocol, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const arg = name => { const hit = process.argv.find(a => a.startsWith(`--${name}=`)); return hit && hit.slice(name.length + 3); };
const mode = arg('spike');
const outDir = arg('out') || path.join(__dirname, '..', 'results');
const tag = arg('tag') || process.versions.electron;
const home = process.env.USERPROFILE || '';
const redact = s => (home ? String(s).split(home).join('~') : String(s));

// FIRST THING, every mode: never let Chromium use the default user data folder. With productName "Hydra" the
// default is %APPDATA%\Hydra, which is the IDE's real profile (an early renderer run of this spike wrote there).
const defaultUserData = app.getPath('userData');
const scratchUserData = arg('userdata') || path.join(__dirname, '..', 'userdata', `spike-${mode}`);
app.setPath('userData', scratchUserData);

function write(name, data) {
  fs.mkdirSync(outDir, { recursive: true });
  const text = redact(JSON.stringify(data, null, 2)).split(JSON.stringify(home).slice(1, -1)).join('~');
  fs.writeFileSync(path.join(outDir, name), text);
  console.log(text);
}

// Hard stop for every mode.
const hardStop = setTimeout(() => { try { write(`timeout-${mode}-${tag}.json`, { mode, error: 'timeout' }); } finally { app.exit(3); } }, Number(arg('timeout') || 45000));
hardStop.unref();

// ---------------------------------------------------------------- pty
// Locate node-pty the way src/core/lanePty.ts loadNodePty does, with appRoot = app.getAppPath().
function runPty() {
  const appRoot = app.getAppPath();
  const candidates = ['node_modules', 'node_modules.asar.unpacked', 'node_modules.asar'].map(f => path.join(appRoot, f, 'node-pty'));
  const tried = [], errors = [];
  let pty;
  for (const c of candidates) {
    tried.push(c);
    try { pty = require(c); if (pty && typeof pty.spawn === 'function') break; pty = undefined; }
    catch (e) { errors.push(`${c}: ${String(e.message).split('\n')[0]}`); }
  }
  const result = { electron: process.versions.electron, appRoot, packaged: app.isPackaged, tried, errors };
  if (!pty) { write(`pty-${tag}.json`, result); return app.exit(1); }
  let data = '';
  const p = pty.spawn('cmd.exe', ['/d', '/c', 'echo hello-from-conpty'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.env.SystemRoot || 'C:\\Windows', env: process.env });
  p.onData(d => { data += d; });
  p.onExit(({ exitCode }) => {
    result.exitCode = exitCode;
    result.output = data.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b./g, '').replace(/\r/g, '').trim();
    write(`pty-${tag}.json`, result);
    app.exit(result.output.includes('hello-from-conpty') && exitCode === 0 ? 0 : 1);
  });
}

// ---------------------------------------------------------------- renderer
const scheme = 'app';
const host = 'hydra';
// The tightest policy found with zero violations (see S4-result.md, item 4).
const CSP = arg('csp') || [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
  'trusted-types hydraWorker defaultWorkerFactory diffEditorWidget diffReview domLineBreaksComputer editorViewLayer richScreenReaderContent standaloneColorizer tokenizeToString stickyScrollViewLayer editorGhostText dompurify',
].join('; ');

if (mode === 'renderer') {
  protocol.registerSchemesAsPrivileged([{ scheme, privileges: { standard: true, secure: true } }]);
}

async function runRenderer() {
  const root = path.join(__dirname, 'renderer');
  const served = [];
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
  protocol.handle(scheme, async request => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(root, rel));
    if (url.host !== host || !file.startsWith(root + path.sep)) return new Response('forbidden', { status: 403 });
    let body;
    try { body = await fs.promises.readFile(file); } catch { served.push({ rel, status: 404 }); return new Response('not found', { status: 404 }); }
    served.push({ rel, status: 200 });
    // The CSP rides on every response, so dedicated workers get it too (a worker's CSP comes from its own response).
    return new Response(body, { headers: { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' } });
  });

  // Block everything that isn't our scheme (no remote loads at all).
  const blocked = [];
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    const ok = details.url.startsWith(`${scheme}://${host}/`) || details.url.startsWith('devtools:') || details.url.startsWith('blob:') || details.url.startsWith('data:');
    if (!ok) blocked.push(details.url);
    cb({ cancel: !ok });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  const win = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false, webviewTag: false, offscreen: true, spellcheck: false },
  });
  const wc = win.webContents;
  wc.setFrameRate(10);
  wc.on('will-navigate', e => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));

  const consoleMessages = [];
  wc.on('console-message', (e) => {
    consoleMessages.push({ level: e.level, message: redact(e.message), source: redact(e.sourceId || '') });
  });

  // DevTools protocol: catches CSP violations from the page and from workers (auto-attached).
  const cdp = [];
  const workers = [];
  // Commit to the app:// renderer process first, so the debugger isn't detached by a cross-site process swap.
  await win.loadURL(`${scheme}://${host}/blank.html`);
  wc.debugger.attach('1.3');
  wc.debugger.on('message', (_e, method, params, sessionId) => {
    if (method === 'Log.entryAdded') cdp.push({ where: sessionId ? 'worker' : 'page', level: params.entry.level, source: params.entry.source, text: redact(params.entry.text), url: redact(params.entry.url || '') });
    if (method === 'Runtime.exceptionThrown') cdp.push({ where: sessionId ? 'worker' : 'page', level: 'exception', text: redact(params.exceptionDetails.exception?.description || params.exceptionDetails.text) });
    if (method === 'Runtime.consoleAPICalled' && sessionId) cdp.push({ where: 'worker', level: params.type, text: redact(params.args.map(a => a.value ?? a.description).join(' ')) });
    if (method === 'Target.attachedToTarget') {
      workers.push({ type: params.targetInfo.type, url: redact(params.targetInfo.url) });
      const sid = params.sessionId;
      wc.debugger.sendCommand('Log.enable', {}, sid).catch(() => {});
      wc.debugger.sendCommand('Runtime.enable', {}, sid).catch(() => {});
      wc.debugger.sendCommand('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
    }
  });
  await wc.debugger.sendCommand('Log.enable');
  await wc.debugger.sendCommand('Runtime.enable');
  await wc.debugger.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

  await win.loadURL(`${scheme}://${host}/index.html`);
  // Wait for the page to say it is done (diff computed in the worker, xterm wrote its line).
  let state;
  for (let i = 0; i < 100; i++) {
    state = await wc.executeJavaScript('window.__spike && JSON.parse(JSON.stringify(window.__spike))');
    if (state && state.done) break;
    await new Promise(r => setTimeout(r, 200));
  }
  await new Promise(r => setTimeout(r, 1500));
  state = await wc.executeJavaScript('JSON.parse(JSON.stringify(window.__spike))');
  const probes = await wc.executeJavaScript(`({
    hasRequire: typeof require, hasProcess: typeof process,
    diffEditorDom: !!document.querySelector('.monaco-diff-editor'),
    insertedLines: document.querySelectorAll('.line-insert, .char-insert').length,
    deletedLines: document.querySelectorAll('.line-delete, .char-delete').length,
    xtermRows: document.querySelector('.xterm-rows') ? document.querySelector('.xterm-rows').innerText.slice(0, 120) : null,
    styleElements: document.querySelectorAll('style').length,
  })`);
  const image = await wc.capturePage();
  const png = path.join(outDir, `renderer-${tag}.png`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(png, image.toPNG());
  const size = image.getSize();
  // Crude "not blank" check: count distinct colours in a sample of the bitmap.
  const bmp = image.toBitmap();
  const colours = new Set();
  for (let i = 0; i < bmp.length; i += 4 * 97) colours.add(bmp.readUInt32LE(i));
  const violations = [...(state?.violations || []), ...cdp.filter(c => /Content Security Policy|Trusted Type/i.test(c.text))];
  write(`renderer-${tag}.json`, {
    electron: process.versions.electron, csp: CSP, state, probes, workers,
    screenshot: { file: path.basename(png), ...size, distinctColoursSampled: colours.size },
    violationCount: violations.length, violations, blockedRequests: blocked.map(redact),
    consoleMessages, cdpLog: cdp, served,
  });
  wc.debugger.detach();
  win.destroy();
  app.exit(violations.length || !state?.done ? 1 : 0);
}

// ---------------------------------------------------------------- identity
// userData must be set before requestSingleInstanceLock: Electron keys the lock on the userData path.
function runIdentity() {
  const role = arg('role');
  const userData = arg('userdata');
  if (!userData) { console.error('--userdata is required'); return app.exit(2); }
  const before = defaultUserData;
  app.setPath('userData', userData);
  app.setAppUserModelId(arg('aumid') || 'Hydra.App');
  const t0 = Date.now();
  const gotLock = app.requestSingleInstanceLock({ from: role, pid: process.pid });
  const result = { role, pid: process.pid, defaultUserData: before, userData: app.getPath('userData'), gotLock, lockMs: Date.now() - t0, events: [] };
  if (!gotLock) { write(`identity-${role}-${tag}.json`, result); return app.exit(0); }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `identity-${role}-${tag}.ready`), String(process.pid));
  result.userDataFiles = () => fs.readdirSync(userData);
  app.on('second-instance', (_e, argv, cwd, additionalData) => {
    result.events.push({ event: 'second-instance', argvHasRole: argv.find(a => a.startsWith('--role=')), additionalData });
  });
  const hold = Number(arg('hold') || 8000);
  setTimeout(() => {
    result.userDataFiles = fs.readdirSync(userData);
    write(`identity-${role}-${tag}.json`, result);
    app.exit(0);
  }, hold);
}

if (mode === 'identity') runIdentity();
app.whenReady().then(() => {
  if (mode === 'pty') return runPty();
  if (mode === 'renderer') return runRenderer().catch(e => { write(`renderer-${tag}.json`, { error: redact(e.stack || e) }); app.exit(1); });
  if (mode !== 'identity') { console.error('unknown --spike'); app.exit(2); }
});
app.on('window-all-closed', () => {});
