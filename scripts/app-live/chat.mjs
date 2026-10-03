#!/usr/bin/env node
// G4's live check: the real `claude` and `codex` driven through the Hydra app's own chat code (src/core/chat), the
// way the app drives them: ChatSession, the adapters, and a hidden process. It sends real turns on the user's own
// subscription, so it is never part of npm test or CI, and it stops at its turn cap.
//
//   node scripts/app-live/chat.mjs --provider claude --evidence <file> [--workdir <scratch>] [--max-turns N]
//   node scripts/app-live/chat.mjs --provider codex  --evidence <file> [--workdir <scratch>] [--max-turns N]
//
// Scenarios, in one chat each: a reply; a file write allowed; a file write denied; Stop while the reply streams;
// and, after the CLI's process is killed, a message that resumes the same session in a new one.
// Isolation, as G1's checks: Claude runs with --strict-mcp-config and --setting-sources project,local; Codex with
// each of the user's MCP servers and its other features off by name. Approvals stand only for files inside the scratch
// repository; anything else is denied. The user's ~/.claude/settings.json, the `hydra` entry in ~/.claude.json and
// ~/.codex/config.toml must come out unchanged. Evidence is redacted with G1's redactor.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { confinementProblem, redactLine, repoRoot, scratchRepo, TurnBudget, TurnCapError } from './common.mjs';

const usage = 'node scripts/app-live/chat.mjs --provider claude|codex --evidence <file> [--workdir <dir>] [--max-turns N] [--executable <path>]';
const options = { maxTurns: 10 };
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i], next = process.argv[i + 1];
  if (['--provider', '--evidence', '--workdir', '--max-turns', '--executable'].includes(arg) && next && !next.startsWith('--')) { options[arg.slice(2).replace('-t', 'T')] = next; i++; }
  else throw new Error(usage);
}
if (!['claude', 'codex'].includes(options.provider) || !options.evidence) throw new Error(usage);
const maxTurns = Number(options.maxTurns ?? 10);
if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 20) throw new Error('--max-turns must be 1 to 20.');

// The app's own chat code, bundled for Node.
const out = path.join(os.tmpdir(), `hydra-chat-live-${process.pid}.cjs`);
await build({ stdin: { contents: "export * from './src/core/chat/claude'; export * from './src/core/chat/codex'; export * from './src/core/chat/session'; export * from './src/core/chat/launch';", resolveDir: repoRoot, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'warning' });
const chat = createRequire(import.meta.url)(out);

// ---- the CLI and its isolation
function resolve(name) {
  if (options.executable) return options.executable;
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(os.homedir(), '.local', 'bin'));
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  const hits = dirs.flatMap(dir => ['.exe', '.cmd'].map(ext => path.join(dir, name + ext))).filter(file => existsSync(file));
  if (!hits.length) throw new Error(`${name} isn't on PATH; pass --executable.`);
  return hits.find(file => /\.exe$/i.test(file)) ?? hits[0];
}
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const claudeJson = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');
function isolation() {
  if (options.provider === 'claude') return ['--strict-mcp-config', '--setting-sources', 'project,local'];
  let text = '';
  try { text = readFileSync(path.join(codexHome, 'config.toml'), 'utf8'); } catch {}
  if (/^\s*mcp_servers\s*[=.]/m.test(text) || /^\s*\[mcp_servers\]/m.test(text)) throw new Error('config.toml declares MCP servers inline; refusing to run, since they can\'t be disabled by name.');
  const names = new Set([...text.matchAll(/^\s*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))(?:\.[^\]]*)?\]/gm)].map(m => m[1] ?? m[2] ?? m[3]));
  const args = [];
  for (const name of names) { if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Can't disable MCP server "${name}" by name; refusing to run.`); args.push('-c', `mcp_servers.${name}.enabled=false`); }
  for (const feature of ['plugins', 'apps', 'memories', 'hooks', 'browser_use', 'computer_use', 'image_generation', 'multi_agent', 'goals', 'daemon_auto_start']) args.push('--disable', feature);
  args.push('-c', 'notify=[]');
  return args;
}

// ---- the user's own setup, before and after
const hash = file => { try { return createHash('sha256').update(readFileSync(file)).digest('hex'); } catch { return 'missing'; } };
const hydraEntry = () => { try { return JSON.stringify(JSON.parse(readFileSync(claudeJson, 'utf8')).mcpServers?.hydra ?? null); } catch { return 'unreadable'; } };
const snapshot = () => ({ claudeSettings: hash(path.join(claudeDir, 'settings.json')), claudeHydraEntry: hydraEntry(), codexConfig: hash(path.join(codexHome, 'config.toml')) });
const before = snapshot();

// ---- one chat, driven like the app drives it
const executable = resolve(options.provider);
const workdir = scratchRepo(`hydra-g4-${options.provider}-`, options.workdir);
const budget = new TurnBudget(maxTurns);
const events = [];
const processes = [];
let waiters = [];
const emit = batch => { events.push(...batch); for (const wake of waiters.splice(0)) wake(); };
const inner = chat.nodeLaunch();
const launch = (exe, args, cwd, handlers) => { const child = inner(exe, args, cwd, handlers); processes.push({ child, args }); return child; };
const until = async (test, label, ms = 180_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const found = test();
    if (found) return found;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise(resolve => { waiters.push(resolve); setTimeout(resolve, 500); });
  }
};
const options_ = {
  provider: options.provider, cwd: workdir, executable, extraArgs: isolation(),
  ...(options.provider === 'claude' ? { model: 'haiku', effort: 'low', permissionMode: 'default', sessionId: crypto.randomUUID() } : { model: 'gpt-6-luna', effort: 'low', sandbox: 'read-only' }),
};
const session = new chat.ChatSession(() => (options.provider === 'claude' ? new chat.ClaudeAdapter() : new chat.CodexAdapter()), options_, launch, emit, { idleMs: 600_000, stopGraceMs: 15_000 });
const dones = () => events.filter(event => event.type === 'done');
let fileChanges = new Map(); // Codex: item id -> paths, from the file-change events before its approval

// Answers every request inside the scratch repository's rules; the scenario says allow or deny.
let decide = 'deny';
const answered = new Set();
const answerPending = () => {
  for (const event of events) {
    if (event.type === 'file-change') fileChanges.set(event.id, [...(fileChanges.get(event.id) ?? []), event.path]);
    if (event.type !== 'approval' || answered.has(event.id)) continue;
    answered.add(event.id);
    const input = event.input ?? {};
    const paths = event.kind === 'file' ? fileChanges.get(String(input.item ?? '')) ?? [] : [input.file_path ?? input.path].filter(Boolean);
    const outside = paths.some(file => confinementProblem(workdir, 'Write', { file_path: file })) || event.kind === 'command' || ['Bash', 'PowerShell', 'Shell', 'WebFetch'].includes(event.tool);
    const allow = decide === 'allow' && !outside && paths.length > 0;
    session.answer(event.id, allow ? { kind: 'approval', decision: 'allow' } : { kind: 'approval', decision: 'deny', message: 'The live check denied this.' });
  }
};
const turn = async (label, text, { whenText } = {}) => {
  budget.take(label);
  const start = dones().length;
  const from = events.length;
  session.send(text);
  let stopped = false;
  await until(() => {
    answerPending();
    // Stop once this turn's reply has started streaming.
    if (whenText && !stopped && events.slice(from).some(event => event.type === 'text') && dones().length === start) { stopped = true; session.stop(); }
    return dones().length > start;
  }, label);
  return dones().at(-1);
};

const results = [];
const check = (name, ok, detail) => { results.push({ scenario: name, status: ok ? 'pass' : 'fail', ...(ok ? {} : { detail }) }); process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}\n`); };
try {
  const reply = await turn('reply', 'Reply with exactly: ok');
  check('reply', reply.status === 'success' && events.some(event => event.type === 'text' && /ok/i.test(event.delta)), JSON.stringify(reply));

  decide = 'allow';
  const write = options.provider === 'claude' ? 'Use the Write tool to create allow.txt containing yes. Do nothing else.' : 'Using your file editing tool (apply_patch), create allow.txt containing yes. Do not run shell commands.';
  const allowed = await turn('approve', write);
  check('approve', allowed.status === 'success' && existsSync(path.join(workdir, 'allow.txt')) && events.some(event => event.type === 'resolved' && event.outcome === 'allowed'), `status ${allowed.status}, allow.txt ${existsSync(path.join(workdir, 'allow.txt'))}`);

  decide = 'deny';
  const denied = await turn('deny', write.replace('allow.txt containing yes', 'deny.txt containing no').replace('Do nothing else.', 'If it is denied, reply "denied" and do not retry.'));
  check('deny', denied.status === 'success' && !existsSync(path.join(workdir, 'deny.txt')) && events.some(event => event.type === 'resolved' && event.outcome === 'denied'), `status ${denied.status}, deny.txt ${existsSync(path.join(workdir, 'deny.txt'))}`);

  const startsBefore = processes.length;
  const stopped = await turn('stop', 'Write a 400-word story about a lighthouse keeper.', { whenText: true });
  check('stop', stopped.status === 'interrupted', JSON.stringify(stopped));

  // Kill the CLI the way a crash would, then the next message resumes the session in a new process.
  const id = session.sessionId;
  processes.at(-1)?.child.kill();
  await until(() => !session.alive, 'the killed process to be gone', 30_000);
  const resumed = await turn('resume', 'Which file did you create earlier in this conversation? Reply with just its name.');
  const last = processes.at(-1)?.args ?? [];
  const resumedWith = options.provider === 'claude' ? last[last.indexOf('--resume') + 1] : events.filter(event => event.type === 'session').at(-1)?.providerSessionId;
  const answer = events.slice(events.lastIndexOf(events.filter(event => event.type === 'user').at(-1))).filter(event => event.type === 'text').map(event => event.delta).join('');
  check('resume', resumed.status === 'success' && processes.length > startsBefore && resumedWith === id && /allow/i.test(answer), `status ${resumed.status}, resumed ${resumedWith === id}, answer ${answer.slice(0, 60)}`);
} catch (error) {
  check('run', false, error instanceof TurnCapError ? `stopped: ${error.message}` : String(error?.message ?? error));
} finally {
  session.close();
}

await new Promise(resolve => setTimeout(resolve, 1500));
const after = snapshot();
const unchanged = Object.fromEntries(Object.keys(before).map(key => [key, before[key] === after[key]]));
for (const [key, same] of Object.entries(unchanged)) process.stdout.write(`${key} unchanged: ${same}\n`);
const errors = events.filter(event => event.type === 'error').map(event => ({ code: event.code, message: event.message.slice(0, 300) }));
const evidence = {
  schema: `hydra-app-live/chat-${options.provider}/v1`, provider: options.provider, turnsUsed: budget.used, turnCap: budget.max,
  result: results.length && results.every(r => r.status === 'pass') && Object.values(unchanged).every(Boolean) ? 'pass' : 'fail',
  results, userStateUnchanged: unchanged, errors, processes: processes.length,
  eventCounts: events.reduce((counts, event) => ({ ...counts, [event.type]: (counts[event.type] ?? 0) + 1 }), {}),
};
writeFileSync(path.resolve(options.evidence), redactLine(JSON.stringify(evidence, null, 2).split(workdir).join('<scratch>')) + '\n', { encoding: 'utf8', flag: 'wx' });
process.stdout.write(`${evidence.result}: ${path.resolve(options.evidence)} (${budget.used}/${budget.max} turns)\n`);
process.exit(evidence.result === 'pass' ? 0 : 1);
