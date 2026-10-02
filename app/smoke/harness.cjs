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
// The folder and file pickers are stand-ins too: they answer with what run.mjs passed, and record that main asked.
const pickedFolder = arg('folder');
report.pickers = [];
electron.dialog.showOpenDialog = async (...args) => {
  const options = args.find(a => a && typeof a === 'object' && 'properties' in a);
  report.pickers.push(options.properties.includes('openDirectory') ? 'folder' : 'file');
  write();
  return pickedFolder && options.properties.includes('openDirectory') ? { canceled: false, filePaths: [pickedFolder] } : { canceled: true, filePaths: [] };
};
report.saveDialogs = 0;
electron.dialog.showSaveDialog = async () => { report.saveDialogs++; write(); return { canceled: true }; };
electron.dialog.showSaveDialogSync = () => { report.saveDialogs++; write(); return undefined; };

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
  // The same raw invoke from a page that isn't on app://hydra/.
  const foreign = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'probe-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  await foreign.loadURL('data:text/html,<p>probe</p>').catch(() => undefined);
  result.foreignSender = await foreign.webContents.executeJavaScript(`window.probe.invoke('hydra:call', { channel: 'app.info', payload: null }).then(v => ({ ok: true }), e => ({ ok: false, error: String(e && e.message || e) }))`);
  foreign.destroy();
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
    // A page-made download is refused before any Save As dialog.
    report.downloads = [];
    session.defaultSession.on('will-download', (event, item) => report.downloads.push({ prevented: event.defaultPrevented, name: item.getFilename() }));
    await settle(() => wc.executeJavaScript(`(() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['echo hi'])); a.download = 'invoice.bat'; document.body.appendChild(a); a.click(); a.remove(); return 1; })()`), 800);

    report.ipc = await ipcProbe();

    // The UI shell: title bar, sidebar, empty state, themes and the stores.
    const ui = expression => wc.executeJavaScript(expression);
    report.ui = await ui(`({
      titleBar: !!document.querySelector('.titlebar'),
      sidebarToggle: !!document.querySelector('.titlebar [aria-label="Hide sidebar"]'),
      chatTab: document.querySelector('.mode-switch [aria-pressed=true]')?.textContent,
      agentsDisabled: document.querySelector('.mode-switch button[disabled]')?.textContent,
      sidebar: [...document.querySelectorAll('.sidebar .side-action span')].map(e => e.textContent),
      search: !!document.querySelector('.sidebar input[type=search]'),
      emptyButton: document.querySelector('.empty .primary')?.textContent,
    })`);
    const uiConsoleStart = report.console.length;
    // Each click goes through IPC and an atomic write; wait for the page to show its result rather than for a fixed time.
    const until = async (expression, what, ms = 10000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await ui(expression)) return; await wait(100); }
      throw new Error(`Timed out waiting for ${what}; the page shows: ${await ui(`[...document.querySelectorAll('.banner')].map(b => b.textContent).join(' | ')`)}`);
    };
    report.problems = await ui(`[...document.querySelectorAll('.banner')].map(b => b.textContent)`);
    const themeNow = () => ui(`({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(), body: getComputedStyle(document.body).backgroundColor })`);
    report.themes = { initial: await themeNow() };
    // `--smoke-shots=<dir>` saves what the hidden window draws, for a person to look at. Off in CI.
    const shots = arg('shots');
    const shot = async name => { if (shots) fs.writeFileSync(path.join(shots, `${name}.png`), (await wc.capturePage()).toPNG()); };
    await shot('home');
    await ui(`document.querySelector('.empty .primary').click(); 1`);
    await until(`document.querySelectorAll('.project-name').length === 1 && document.querySelector('.empty h1')?.textContent === 'Project One'`, 'the picked project');
    await shot('project-'+(await themeNow()).theme);
    report.afterPick = await ui(`({ projects: [...document.querySelectorAll('.project-name span')].map(e => e.textContent), heading: document.querySelector('.empty h1')?.textContent })`);
    await ui(`document.querySelector('.titlebar .icon-button').click(); 1`);
    await until(`!document.querySelector('.sidebar')`, 'the sidebar to hide');
    report.sidebarAfterToggle = await ui(`!!document.querySelector('.sidebar')`);
    await ui(`document.querySelector('.titlebar .icon-button').click(); 1`);
    await until(`!!document.querySelector('.sidebar')`, 'the sidebar to show');
    // Picking the same folder again, from Settings, leads back to its project and adds nothing.
    await ui(`[...document.querySelectorAll('.side-action')].find(b => b.textContent.includes('Settings')).click(); 1`);
    await until(`!!document.querySelector('.settings h1')`, 'Settings');
    await ui(`document.querySelector('.section-head .icon-button').click(); 1`);
    await until(`!document.querySelector('.settings h1') && document.querySelector('.project-row.selected .project-name span')?.textContent === 'Project One'`, 'the re-picked project');
    report.projectsAfterRepick = await ui(`document.querySelectorAll('.project-name').length`);
    await ui(`[...document.querySelectorAll('.side-action')].find(b => b.textContent.includes('Settings')).click(); 1`);
    await until(`document.querySelector('.settings h1')?.textContent === 'Settings'`, 'Settings');
    await shot('settings');
    report.settingsView = await ui(`({ heading: document.querySelector('.settings h1')?.textContent, themes: [...document.querySelectorAll('.segmented [role=radio]')].map(b => b.textContent + ':' + b.getAttribute('aria-checked')) })`);
    // Each theme through the Settings screen, as a user picks it.
    for (const [label, theme] of [['Light', 'light'], ['Dark', 'dark'], ['System', 'system']]) {
      await ui(`[...document.querySelectorAll('.segmented [role=radio]')].find(b => b.textContent === '${label}').click(); 1`);
      await until(`document.querySelector('.segmented [aria-checked=true]')?.textContent === '${label}'`, `${label} to be chosen`);
      // The page follows the system's preference through prefers-color-scheme, which reaches it a moment later.
      const expected = theme === 'system' ? (electron.nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : theme;
      for (let i = 0; i < 30 && (await themeNow()).theme !== expected; i++) await wait(100);
      await shot(`settings-${theme}`);
      report.themes[theme] = { ...(await themeNow()), native: electron.nativeTheme.themeSource, nativeDark: electron.nativeTheme.shouldUseDarkColors, checked: await ui(`document.querySelector('.segmented [aria-checked=true]')?.textContent`) };
    }
    report.badTheme = await ui(`window.hydra.setTheme('hacker').then(() => 'accepted', e => 'refused')`);
    await ui(`[...document.querySelectorAll('.setting-value button')][0].click(); 1`);
    await until(`true`, 'nothing', 100);
    for (let i = 0; i < 50 && !report.pickers.includes('file'); i++) await wait(100);
    const userData = app.getPath('userData');
    const readJson = name => { try { return JSON.parse(fs.readFileSync(path.join(userData, name), 'utf8')); } catch (e) { return String(e.message); } };
    report.stores = { settings: readJson('settings.json'), state: readJson('state.json'), files: fs.readdirSync(userData) };
    report.consoleErrors = report.console.slice(uiConsoleStart).filter(m => m.level === 'error' || m.level === 3);
    event('ready');
    // Wait for run.mjs's second launch to reach this instance, then leave.
    const deadline = Date.now() + 30000;
    while (!report.events.includes('second-instance') && Date.now() < deadline) await wait(100);
    await wait(300);
    event('done');
    app.quit();
  });
}
