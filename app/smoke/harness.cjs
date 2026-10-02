// Smoke harness: the Electron entry smoke/run.mjs starts instead of the app's package. It points the roaming AppData
// folder at a scratch one, keeps every window hidden (show and focus are recorded, not performed), loads the built
// app (dist/main.cjs) exactly as packaged, then reports what it finds. Never part of the app's build.
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const arg = name => { const hit = process.argv.find(a => a.startsWith(`--smoke-${name}=`)); return hit && hit.slice(name.length + 9); };
const role = arg('role');
const out = arg('out');
const appData = arg('appdata');
if (!role || !out || !appData) { console.error('harness: missing --smoke-role, --smoke-out or --smoke-appdata'); process.exit(2); }

const report = { role, events: [] };
const write = () => fs.writeFileSync(path.join(out, `${role}.json`), JSON.stringify(report, null, 2));
const event = name => { report.events.push(name); write(); };
const hardStop = setTimeout(() => { report.error = 'timeout'; write(); app.exit(3); }, Number(arg('timeout') || 60000));
hardStop.unref();

// Before the app runs: a scratch AppData, so identity.ts resolves <scratch>\Hydra App and nothing reaches the real one.
app.setPath('appData', appData);

app.on('browser-window-created', (_event, win) => {
  event('window-created');
  win.show = () => event('show');
  win.showInactive = () => event('show');
  win.focus = () => event('focus');
  win.restore = () => event('restore');
});
app.on('second-instance', () => event('second-instance'));
process.on('exit', () => { report.exitedWithLock = app.hasSingleInstanceLock(); write(); });

require(path.join(__dirname, '..', 'dist', 'main.cjs'));

if (role === 'first') {
  void app.whenReady().then(async () => {
    const win = await new Promise(resolve => {
      const found = BrowserWindow.getAllWindows()[0];
      if (found) resolve(found); else app.once('browser-window-created', (_e, w) => resolve(w));
    });
    await new Promise(resolve => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', resolve) : resolve()));
    report.paths = Object.fromEntries(['appData', 'userData', 'sessionData', 'logs', 'crashDumps'].map(name => [name, app.getPath(name)]));
    report.name = app.getName();
    report.title = win.getTitle();
    report.url = win.webContents.getURL();
    report.webPreferences = win.webContents.getLastWebPreferences();
    report.appInfo = await win.webContents.executeJavaScript('window.hydra.appInfo()');
    report.hydraKeys = await win.webContents.executeJavaScript('Object.keys(window.hydra)');
    report.nodeInRenderer = await win.webContents.executeJavaScript('typeof require + "/" + typeof process');
    report.hasLock = app.hasSingleInstanceLock();
    event('ready');
    // Wait for run.mjs's second launch to reach this instance, then leave.
    const deadline = Date.now() + 30000;
    while (!report.events.includes('second-instance') && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 300));
    event('done');
    app.quit();
  });
}
