// S4 item 5: two app instances with the app's userData (a scratch stand-in for %APPDATA%\Hydra App) plus an
// "IDE-like" instance on a scratch stand-in for %APPDATA%\Hydra. Usage: node identity-test.cjs <electron.exe> [appDir] [tag]
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const exe = path.resolve(process.argv[2]);
const appDir = process.argv[3] && process.argv[3] !== '-' ? path.resolve(process.argv[3]) : null; // null: packaged exe
const tag = process.argv[4] || 'identity';
const out = path.join(__dirname, 'results', tag);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const appUserData = path.join(__dirname, 'userdata', 'Hydra App');
const ideUserData = path.join(__dirname, 'userdata', 'Hydra');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const home = process.env.USERPROFILE;
const redact = s => String(s).split(home).join('~');

function launch(role, userData, extra = []) {
  const args = [...(appDir ? [appDir] : []), '--spike=identity', `--role=${role}`, `--userdata=${userData}`, `--out=${out}`, `--tag=${tag}`, ...extra];
  const child = spawn(exe, args, { env, windowsHide: true, stdio: 'ignore' });
  const done = new Promise(resolve => child.on('exit', code => resolve(code)));
  const killer = setTimeout(() => child.kill(), 30000);
  done.then(() => clearTimeout(killer));
  return { child, done };
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(file, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (fs.existsSync(file)) return true; await wait(100); }
  return false;
}
// Chromium's ProcessSingleton on Windows: a hidden message-only window of class Chrome_MessageWindow whose title is the
// user data folder. List them (titles only) to show what the lock is keyed on.
function messageWindows() {
  const ps = `Add-Type -TypeDefinition @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class W {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static List<string> All() { var r = new List<string>(); IntPtr h = IntPtr.Zero; IntPtr HWND_MESSAGE = new IntPtr(-3);
    while ((h = FindWindowEx(HWND_MESSAGE, h, "Chrome_MessageWindow", null)) != IntPtr.Zero) { var sb = new StringBuilder(1024); GetWindowText(h, sb, 1024); r.Add(sb.ToString()); }
    return r; }
}
"@
[W]::All() | ForEach-Object { $_ }`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  return r.stdout.split(/\r?\n/).filter(Boolean).map(redact);
}

(async () => {
  const report = { exe: redact(path.relative(__dirname, exe)), appDir: appDir && path.relative(__dirname, appDir), appUserData: redact(appUserData), ideUserData: redact(ideUserData) };
  const first = launch('first', appUserData, ['--hold=9000']);
  report.firstReady = await waitFor(path.join(out, `identity-first-${tag}.ready`));
  const windows = messageWindows();
  report.messageWindowsWhileFirstRuns = { ours: windows.filter(w => w.includes("userdata")), otherAppsCount: windows.filter(w => !w.includes("userdata")).length };
  const second = launch('second', appUserData);
  report.secondExit = await second.done;
  const ide = launch('ide-sim', ideUserData, ['--hold=1500', '--aumid=Hydra.IDE']);
  report.ideSimExit = await ide.done;
  report.firstExit = await first.done;
  for (const role of ['first', 'second', 'ide-sim']) {
    const f = path.join(out, `identity-${role}-${tag}.json`);
    report[role] = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  }
  report.appUserDataFiles = fs.readdirSync(appUserData);
  const text = JSON.stringify(report, null, 2);
  fs.writeFileSync(path.join(out, 'identity-report.json'), text);
  console.log(text);
})();
