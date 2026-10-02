// Smoke harness: the Electron entry smoke/run.mjs starts instead of the app's package. It points the roaming AppData
// folder at a scratch one, keeps every window hidden (show and focus are recorded, not performed), answers the
// external-link confirm itself (no dialog is drawn, no browser opens), loads the built main bundle (dist/main.cjs),
// then reports what it finds. Electron starts it as a loose script, so what Electron itself writes before main.cjs
// runs isn't covered here; tests/identity.test.ts covers main's ordering. Never part of the app's build.
const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');
const { app, BrowserWindow, session } = electron;

const arg = name => { const hit = process.argv.find(a => a.startsWith(`--smoke-${name}=`)); return hit && hit.slice(name.length + 9); };
const role = arg('role');
const out = arg('out');
const appData = arg('appdata');
if (!role || !out || !appData) { console.error('harness: missing --smoke-role, --smoke-out or --smoke-appdata'); process.exit(2); }

const report = { role, events: [], console: [], confirms: [], opened: [] };
const write = () => fs.writeFileSync(path.join(out, `${role}.json`), JSON.stringify(report, null, 2));
const event = name => { report.events.push(name); write(); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const hardStop = setTimeout(() => { report.error = 'timeout'; write(); app.exit(3); }, Number(arg('timeout') || 60000));
hardStop.unref();

// Before the app runs: a scratch AppData, so identity.ts resolves <scratch>\Hydra App and nothing reaches the real one.
app.setPath('appData', appData);

// The confirm and the browser are stand-ins: the app reads electron.dialog and electron.shell when it calls them.
let confirmAnswer = 1; // Cancel
electron.dialog.showMessageBox = async (...args) => { const options = args.find(a => a && typeof a === 'object' && 'buttons' in a); report.confirms.push(options.detail); write(); return { response: confirmAnswer, checkboxChecked: false }; };
electron.dialog.showMessageBoxSync = () => { report.confirms.push('sync'); return 1; };
electron.shell.openExternal = async url => { report.opened.push(url); write(); };

app.on('browser-window-created', (_event, win) => {
  event('window-created');
  win.show = () => event('show');
  win.showInactive = () => event('show');
  win.focus = () => event('focus');
  win.restore = () => event('restore');
});
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', details => report.console.push({ level: details.level, message: details.message }));
});
app.on('second-instance', () => event('second-instance'));
process.on('exit', () => { report.exitedWithLock = app.hasSingleInstanceLock(); write(); });

// A crash must end the run, never leave Electron's error dialog on screen.
const fail = error => { report.error = String(error && error.stack || error); write(); app.exit(4); };
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

require(path.join(__dirname, '..', 'dist', 'main.cjs'));

const loaded = contents => new Promise(resolve => (contents.isLoading() ? contents.once('did-stop-loading', resolve) : resolve()));
const settle = async (fn, ms = 400) => { try { return await fn(); } finally { await wait(ms); } };

/** A second, hidden window on an app:// page whose preload hands the page raw ipcRenderer.invoke, as a compromised renderer would have. */
async function ipcProbe() {
  const probe = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'probe-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  await probe.loadURL('app://hydra/probe.html').catch(() => undefined);
  const call = expression => probe.webContents.executeJavaScript(`${expression}.then(v => ({ ok: true, value: v }), e => ({ ok: false, error: String(e && e.message || e) }))`);
  const result = {
    unknownTransport: await call(`window.probe.invoke('hydra:nope', { channel: 'app.info', payload: null })`),
    unknownChannel: await call(`window.probe.invoke('hydra:call', { channel: 'fs.read', payload: null })`),
    badPayload: await call(`window.probe.invoke('hydra:call', { channel: 'app.info', payload: { path: 'C:/' } })`),
    extraField: await call(`window.probe.invoke('hydra:call', { channel: 'app.info', payload: null, also: 1 })`),
    valid: await call(`window.probe.invoke('hydra:call', { channel: 'app.info', payload: null })`),
  };
  probe.destroy();
  return result;
}

if (role === 'first') {
  void app.whenReady().then(async () => {
    const win = await new Promise(resolve => {
      const found = BrowserWindow.getAllWindows()[0];
      if (found) resolve(found); else app.once('browser-window-created', (_e, w) => resolve(w));
    });
    const wc = win.webContents;
    await loaded(wc);
    await wait(300);
    report.paths = Object.fromEntries(['appData', 'userData', 'sessionData', 'logs', 'crashDumps'].map(name => [name, app.getPath(name)]));
    report.name = app.getName();
    report.title = win.getTitle();
    report.url = wc.getURL();
    report.webPreferences = wc.getLastWebPreferences();
    report.appInfo = await wc.executeJavaScript('window.hydra.appInfo()');
    report.hydraKeys = await wc.executeJavaScript('Object.keys(window.hydra)');
    report.nodeInRenderer = await wc.executeJavaScript('typeof require + "/" + typeof process');
    report.webviewTag = await wc.executeJavaScript('typeof customElements.get("webview")');
    report.hasLock = app.hasSingleInstanceLock();
    report.windowsAtLoad = BrowserWindow.getAllWindows().length;
    report.consoleAtLoad = [...report.console];

    // The CSP rides on every app:// response.
    const headers = {};
    for (const file of ['index.html', 'renderer.js', 'styles.css', 'missing.js']) {
      const response = await session.defaultSession.fetch(`app://hydra/${file}`);
      headers[file] = { status: response.status, csp: response.headers.get('content-security-policy'), nosniff: response.headers.get('x-content-type-options') };
    }
    report.headers = headers;

    // A script the CSP doesn't allow, an inline script and a remote fetch all fail.
    report.inlineScript = await wc.executeJavaScript(`(() => { try { const s = document.createElement('script'); s.textContent = 'window.__inline = 1'; document.body.appendChild(s); } catch (e) { return 'threw: ' + e.name; } return String(window.__inline); })()`);
    report.remoteFetch = await wc.executeJavaScript(`fetch('https://example.com/').then(() => 'loaded', e => 'failed: ' + e.name)`);
    report.evalBlocked = await wc.executeJavaScript(`(() => { try { return String(eval('1 + 1')); } catch (e) { return 'threw: ' + e.name; } })()`);
    report.mainSessionRemote = await session.defaultSession.fetch('https://example.com/').then(() => 'loaded', e => `failed: ${e.message}`);

    // Navigation is blocked; window.open is denied and an http(s) link goes through the confirm.
    await settle(() => wc.executeJavaScript(`location.href = 'https://example.com/'; 1`));
    report.urlAfterNavigate = wc.getURL();
    await settle(() => wc.executeJavaScript(`String(window.open('https://example.com/cancelled'))`).then(v => { report.openResult = v; }));
    confirmAnswer = 0;
    await settle(() => wc.executeJavaScript(`window.open('https://example.com/accepted'); window.open('file:///C:/Windows/win.ini'); window.open('javascript:alert(1)'); 1`));
    report.windowsAfterOpen = BrowserWindow.getAllWindows().length;
    report.permission = await wc.executeJavaScript(`Notification.requestPermission()`).catch(e => `threw: ${e.message}`);

    report.ipc = await ipcProbe();
    event('ready');
    // Wait for run.mjs's second launch to reach this instance, then leave.
    const deadline = Date.now() + 30000;
    while (!report.events.includes('second-instance') && Date.now() < deadline) await wait(100);
    await wait(300);
    event('done');
    app.quit();
  });
}
