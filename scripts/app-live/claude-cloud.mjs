// G7 spike S3 (Claude): what `claude --cloud` and `claude --teleport` print, run as the app would run them
// (docs/internal/hydra-app/G7-cloud.md, "Spike S3").
//   node scripts/app-live/claude-cloud.mjs --cwd <git folder> --cloud "<task>"   [--seconds 60] [--trust] [--scenario <name>]
//   node scripts/app-live/claude-cloud.mjs --cwd <git folder> --teleport <session_id> [--seconds 90] [--trust] [--scenario <name>]
// Each run uses the user's own Claude subscription; a --cloud run creates a real cloud session (G7's budget: 10).
// `--cloud` refuses a pipe ("--cloud requires an interactive terminal"), so this runs the CLI in a pseudo-terminal
// (node-pty, the app's own dependency), answers the terminal queries a real terminal would, and, with --trust,
// answers Claude Code's folder-trust prompt with "Yes, I trust this folder". The child environment drops the parent
// session's CLAUDE* and ANTHROPIC* variables: inherited, they turn off Claude Code's transcript saving.
// With --scenario, the readable capture is redacted (src/core/redact.ts, through common.mjs), its session ids and
// folder replaced by stand-ins, and written to tests/fixtures/app/claude-cloud/<scenario>.txt.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactLine, repoRoot } from './common.mjs';

const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const cwd = option('--cwd'), cloud = option('--cloud'), teleport = option('--teleport'), scenario = option('--scenario');
const seconds = Number(option('--seconds') ?? (teleport ? 90 : 60));
if (!cwd || (!cloud === !teleport) || !(seconds > 0 && seconds <= 600) || (scenario && !/^[a-z0-9-]+$/.test(scenario))) {
  console.error('Usage: claude-cloud.mjs --cwd <folder> (--cloud "<task>" | --teleport <session_id>) [--seconds N] [--trust] [--scenario name]');
  process.exit(2);
}
const pty = createRequire(path.join(repoRoot, 'app', 'package.json'))('node-pty');
const executable = process.env.HYDRA_CLAUDE ?? path.join(os.homedir(), '.local', 'bin', 'claude.exe');
const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (/^(CLAUDE|ANTHROPIC)/i.test(key)) delete env[key];

/** Readable lines from a terminal capture: cursor moves become spaces and line breaks, other escapes are dropped. */
export function renderTerminal(raw) {
  return raw
    .replace(/\x1b\[(\d*)C/g, (m, n) => ' '.repeat(Number(n || 1)))
    .replace(/\x1b\[\d+;\d+H/g, '\n')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1bP[^\x1b]*\x1b\\/g, '')
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '')
    .replace(/\x1b./g, '')
    .split(/\r?\n|\r/).map(line => line.trimEnd()).filter(line => line.trim() && !/^[◐◑◒◓◯\s]+$/.test(line)).join('\n');
}

const term = pty.spawn(executable, cloud ? ['--cloud', cloud] : ['--teleport', teleport], { name: 'xterm-256color', cols: 160, rows: 50, cwd, env });
let raw = '', trusted = false;
term.onData(data => {
  raw += data;
  if (data.includes('\x1b[>0q')) term.write('\x1bP>|xterm(388)\x1b\\');
  if (/\x1b\[0?c/.test(data)) term.write('\x1b[?62;22c');
  if (data.includes('\x1b[6n')) term.write('\x1b[1;1R');
  if (args.includes('--trust') && !trusted && /Yes,\s*(\x1b\[\d*C)?I\s*(\x1b\[\d*C)?trust\s*(\x1b\[\d*C)?this\s*(\x1b\[\d*C)?folder/.test(raw)) {
    trusted = true;
    setTimeout(() => term.write('\x1b[B'), 500);
    setTimeout(() => term.write('\r'), 1200);
  }
});
const finish = why => {
  const text = `# ${cloud ? 'claude --cloud' : 'claude --teleport'}: ${why}\n${renderTerminal(raw)}\n`;
  console.log(text);
  if (scenario) {
    const sessions = new Map();
    const standIn = text
      .split(path.resolve(cwd)).join('<project>')
      .replace(/session_01[A-Za-z0-9]{20,}/g, id => { if (!sessions.has(id)) sessions.set(id, `session_01StandIn${String(sessions.size + 1).padStart(14, '0')}`); return sessions.get(id); });
    const file = path.join(repoRoot, 'tests', 'fixtures', 'app', 'claude-cloud', `${scenario}.txt`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, standIn.split('\n').map(line => redactLine(line)).join('\n'));
    console.log(`wrote ${path.relative(repoRoot, file)}`);
  }
  process.exit(0);
};
term.onExit(({ exitCode }) => finish(`exited ${exitCode}`));
setTimeout(() => { try { term.kill(); } catch { /* already gone */ } finish(`stopped after ${seconds}s`); }, seconds * 1000);
