// S4 item 2: load node-pty in Electron main and run a ConPTY child. No window is created.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// Keep Chromium's profile in the scratch folder (the default would be %APPDATA%\Electron).
app.setPath('userData', path.join(__dirname, 'userdata', 'pty-main'));
const out = path.join(__dirname, 'results', `pty-${process.versions.electron}.json`);
const result = { electron: process.versions.electron, node: process.versions.node, modules: process.versions.modules, napi: process.versions.napi };

function finish(code) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  app.exit(code);
}

// Hard stop so a hung pty can never leave Electron running.
setTimeout(() => { result.error = 'timeout'; finish(2); }, 20000).unref();

app.whenReady().then(() => {
  try {
    // Load exactly the way src/core/lanePty.ts loadNodePty does: require(<appRoot>/node_modules/node-pty).
    const appRoot = __dirname;
    const candidate = path.join(appRoot, 'node_modules', 'node-pty');
    const pty = require(candidate);
    result.loadedFrom = path.relative(appRoot, require.resolve(candidate));
    result.nativeModule = Object.keys(require.cache).filter(k => k.endsWith('.node')).map(k => path.relative(appRoot, k));
    const tests = [
      { file: 'cmd.exe', args: ['/d', '/c', 'echo hello-from-conpty'] },
      { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output "ps $($PSVersionTable.PSVersion.Major) $([Environment]::Is64BitProcess)"; exit 7'] },
    ];
    result.runs = [];
    let pending = tests.length;
    for (const t of tests) {
      let data = '';
      const started = Date.now();
      const p = pty.spawn(t.file, t.args, { name: 'xterm-256color', cols: 100, rows: 30, cwd: appRoot, env: process.env, useConpty: true });
      p.onData(d => { data += d; });
      p.onExit(({ exitCode }) => {
        // Strip VT sequences for the excerpt.
        const text = data.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b./g, '').replace(/\r/g, '').trim();
        result.runs.push({ cmd: [t.file, ...t.args].join(' '), pid: p.pid, exitCode, ms: Date.now() - started, output: text });
        if (--pending === 0) finish(0);
      });
    }
  } catch (error) {
    result.error = String(error && error.stack || error);
    finish(1);
  }
});
