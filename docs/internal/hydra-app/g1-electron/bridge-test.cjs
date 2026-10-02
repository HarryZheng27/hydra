// Drive bridge.cjs through an Electron executable in run-as-node mode and print what came back.
// Usage: node bridge-test.cjs <exe> <script> [label]
const { spawn } = require('node:child_process');
const path = require('node:path');
const [exe, script, label = ''] = process.argv.slice(2);
const preload = path.join(__dirname, 'node-options-preload.cjs');

function run(name, extraEnv, extraArgs = []) {
  return new Promise(resolve => {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv };
    const child = spawn(exe, [...extraArgs, script], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); }, 15000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('exit', code => {
      clearTimeout(timer);
      const lines = out.trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return l; } });
      resolve({ name, code, responses: lines, stderr: err.trim().split('\n').slice(0, 3).join(' | ') || undefined });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: 'round-trip-ok' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'shutdown' }) + '\n');
  });
}

(async () => {
  const results = [];
  results.push(await run('plain', {}));
  results.push(await run('NODE_OPTIONS=--require preload', { NODE_OPTIONS: `--require "${preload.split(path.sep).join("/")}"` }));
  results.push(await run('--inspect=0 arg', {}, ['--inspect=127.0.0.1:0']));
  const home = process.env.USERPROFILE;
  console.log(JSON.stringify({ label, exe: path.relative(__dirname, exe), script: path.relative(__dirname, script), results }, null, 2).split(home).join('~'));
})();
