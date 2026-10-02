// Shared harness for the app's live protocol checks (docs/internal/hydra-app/G1-spikes.md).
// Each provider script defines scenarios. In --live mode a scenario drives the real CLI,
// records every protocol line in both directions, redacts it and writes a fixture; then its
// check runs on the recorded transcript. In --fixture mode only the checks run, against the
// committed fixtures, so the same assertions guard both. G4's stand-in CLIs replay the fixtures.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactText, secretKeyPattern } from '../../src/core/redact.ts';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const fixtureLimitBytes = 200 * 1024;
export const defaultTurnCap = 30;

export function parseOptions(argv, usage) {
  const value = { executable: undefined, maxTurns: defaultTurnCap, only: undefined };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--fixture' || arg === '--live') { if (value.mode) throw new Error('Choose exactly one of --fixture or --live.'); value.mode = arg.slice(2); }
    else if (arg === '--evidence' || arg === '--executable' || arg === '--max-turns' || arg === '--only' || arg === '--workdir') {
      const next = argv[++index]; if (!next || next.startsWith('--')) throw new Error(`${arg} requires a value.`);
      if (arg === '--max-turns') { const n = Number(next); if (!Number.isInteger(n) || n < 1 || n > defaultTurnCap) throw new Error(`--max-turns must be 1 to ${defaultTurnCap}.`); value.maxTurns = n; }
      else if (arg === '--only') value.only = new Set(next.split(','));
      else value[arg.slice(2)] = next;
    } else throw new Error(`Unsupported argument: ${arg}\n\n${usage}`);
  }
  if (!value.mode || !value.evidence) throw new Error(usage);
  return value;
}

/** Counts user turns sent to a provider and refuses to send past the cap. */
export class TurnBudget {
  constructor(max) { this.max = max; this.used = 0; }
  take(label) {
    if (this.used >= this.max) throw new TurnCapError(`Turn cap of ${this.max} reached before "${label}".`);
    this.used++;
  }
}
export class TurnCapError extends Error {}

// ---- Redaction: redact.ts, then home paths, emails, account and organization ids ----

const home = os.homedir();
const homeVariants = [...new Set([home, home.replaceAll('\\', '/'), home.replaceAll('\\', '\\\\'), home.replaceAll('\\', '\\\\\\\\'), home.replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`).replaceAll('\\', '/')])]
  .filter(v => v.length > 3).sort((a, b) => b.length - a.length);
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const homePattern = new RegExp(homeVariants.map(escapeRegExp).join('|'), 'gi');
const userName = path.basename(home);
const userNamePattern = userName.length >= 3 ? new RegExp(`\\b${escapeRegExp(userName)}\\b`, 'gi') : undefined;
const emailPattern = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Matches plain and escaped JSON (a JSON string holding JSON: \"accountId\":\"...\").
const accountKeyPattern = /(\\*)"((?:account|organization|org|user|workspace|chatgpt_account)_?(?:uuid|id|Id|Uuid)|account|email|emailAddress|email_address)\1"\s*:\s*\1"(?:[^"\\]|\\(?!\1")[\s\S])*?\1"/g;

// The machine's name and the user's own name (from git), which models and CLIs echo back.
const machineNames = [...new Set([os.hostname(), process.env.COMPUTERNAME].filter(v => v && v.length >= 3))];
const machinePattern = machineNames.length ? new RegExp(machineNames.map(escapeRegExp).join('|'), 'gi') : undefined;
let personPattern;
function personNames() {
  if (personPattern !== undefined) return personPattern;
  let full = '';
  try { full = execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); } catch {}
  const tokens = full.split(/\s+/).filter(t => t.length >= 3);
  // A first name is often shortened ("Nicolas" -> "Nico"), so mask its four-letter form too.
  if (tokens[0]?.length > 4) tokens.push(tokens[0].slice(0, 4));
  // Not \b: in escaped text a name often follows "\n", and that "n" is a word character.
  personPattern = tokens.length ? new RegExp(`(?<=^|[^A-Za-z]|\\\\[nrt])(?:${tokens.map(escapeRegExp).join('|')})(?![A-Za-z])`, 'gi') : null;
  return personPattern;
}

/** Masks everything the G1 rules ask for. `extra` holds exact values to mask (scratch paths, ids). */
export function redactLine(text, extra = []) {
  let out = text;
  for (const [value, label] of extra) if (value && value.length >= 4) out = out.split(value).join(label);
  if (machinePattern) out = out.replace(machinePattern, '[machine]');
  out = out.replace(homePattern, '~');
  // Any other profile path, including one cut short by a streamed delta (C:\\Users\\ndu).
  out = out.replace(/[A-Za-z]:(?:\\+|\/+)Users(?:\\+|\/+)(?!\[user\])[^\\/"\s]+/gi, '~');
  if (userNamePattern) out = out.replace(userNamePattern, '[user]');
  // A user name cut short by a streamed delta, after "Users\" or "Users-" (scratch folder names).
  out = out.replace(/(Users(?:\\+|\/+|-))([A-Za-z0-9._]{2,})/gi, (whole, prefix, name) => userName.toLowerCase().startsWith(name.toLowerCase()) ? `${prefix}[user]` : whole);
  out = out.replace(emailPattern, '[email]');
  const person = personNames();
  if (person) out = out.replace(person, '[name]');
  out = out.replace(accountKeyPattern, (_whole, slashes, key) => `${slashes}"${key}${slashes}":${slashes}"[account]${slashes}"`);
  return redactText(out);
}

// ---- Structured redaction ----
// A recorded line is JSON inside JSON, often a level deeper still (a tool result holding JSON),
// so key-based masking can't work on the escaped text. Walk the parsed values instead, collect
// what must go, and mask each value everywhere in the transcript with one stable label, so
// ids that the checks correlate stay equal to each other.

const identityKeyPattern = /^(serverName|installationId|machineId|deviceId|hostname|hostName|computerName|orgName|organizationName|organization_name|email|emailAddress|email_address|fullName|full_name|given_name|family_name)$/i;
const identityParentPattern = /^(account|organization|org|profile|workspace)$/i;

function collectSensitive(value, parentKey, found, depth = 0) {
  if (depth > 24) return;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length < 4_000_000) { try { collectSensitive(JSON.parse(trimmed), parentKey, found, depth + 1); } catch {} }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [entryKey, v] of Object.entries(value)) {
    const key = Array.isArray(value) ? parentKey : entryKey;
    if (typeof v === 'string' && !/^\[[^\]]*\]$/.test(v)) {
      const identity = identityKeyPattern.test(key) || (identityParentPattern.test(parentKey ?? '') && /(id|uuid|name|email)$/i.test(key));
      // Secret-looking keys, except the session and thread ids the checks follow (a label already replaces Claude's).
      const secret = secretKeyPattern.test(key) && !/session|thread/i.test(key) && v.length >= 8 && /\d/.test(v);
      if ((identity && v.length >= 4) || secret) found.add(v);
    }
    collectSensitive(v, key, found, depth + 1);
  }
}

/** Exact-value redactions for a transcript's identity and secret fields, at every escaping depth. */
export function structuredRedactions(entries) {
  const found = new Set();
  for (const entry of entries) if (entry.line) collectSensitive(entry.line, undefined, found);
  const pairs = []; let n = 0;
  for (const value of [...found].sort((a, b) => b.length - a.length)) {
    const label = `[redacted-${++n}]`;
    let escaped = value;
    for (let depth = 0; depth < 4; depth++) { pairs.push([escaped, label]); escaped = JSON.stringify(escaped).slice(1, -1); }
  }
  return pairs.filter(([value], i, all) => all.findIndex(([other]) => other === value) === i).sort((a, b) => b[0].length - a[0].length);
}

/** A streamed delta can split the user name ("…Users\\ndun" + "l\\AppData…"): drop the tail left after a masked name. */
function dropNameTails(lines) {
  if (userName.length < 2) return lines;
  let previous = '';
  return lines.map(line => {
    let entry; try { entry = JSON.parse(line); } catch { return line; }
    if (entry.dir !== 'recv' || typeof entry.line !== 'string') return line;
    let message; try { message = JSON.parse(entry.line); } catch { return line; }
    const holder = message?.event?.delta ?? (typeof message?.params?.delta === 'string' ? message.params : undefined);
    const field = holder && ['partial_json', 'text', 'delta'].find(f => typeof holder[f] === 'string');
    if (!field) return line;
    const text = holder[field];
    let changed = false;
    const lower = text.toLowerCase(); const name = userName.toLowerCase();
    if (/(\[user\]|~)$/.test(previous)) {
      // The name was masked at the end of the last delta (alone, or inside a home path now "~"); drop the rest of it here.
      // A later piece of the name, which may still be followed by more of it in the next delta.
      for (let cut = Math.min(text.length, name.length - 1); cut >= 1; cut--) {
        const piece = lower.slice(0, cut);
        const continues = [...Array(name.length - 1).keys()].some(k => name.slice(k + 1).startsWith(piece));
        if (continues && /^[\\/"]|^$/.test(text.slice(cut))) { holder[field] = text.slice(cut); changed = true; break; }
      }
    } else if (/Users(?:\\+|\/+|-)$/i.test(previous)) {
      // The last delta stopped right before the name; mask whatever part of it starts this one.
      for (let cut = name.length; cut >= 1; cut--) {
        if (lower.startsWith(name.slice(0, cut)) && (cut === name.length || text.length === cut || /^[\\/"]/.test(text.slice(cut)))) { holder[field] = '[user]' + text.slice(cut); changed = true; break; }
      }
    }
    previous = (previous + holder[field]).slice(-64); // the joined stream: a separator can arrive as its own delta
    if (!changed) return line;
    entry.line = JSON.stringify(message);
    return JSON.stringify(entry);
  });
}

/** The redacted fixture lines for a transcript: header first, then every entry. */
export function redactTranscript(header, entries, extra = []) {
  const all = [...extra, ...structuredRedactions(entries)];
  return dropNameTails([JSON.stringify(header), ...entries.map(e => JSON.stringify(e))].map(l => redactLine(l, all)));
}

// ---- Transcripts ----

/** One scenario's record: protocol lines in both directions plus notes the check can use. */
export class Transcript {
  constructor(scenario, meta = {}) { this.scenario = scenario; this.entries = []; this.meta = meta; this.started = Date.now(); }
  send(line) { this.entries.push({ dir: 'send', t: Date.now() - this.started, line }); }
  recv(line) { this.entries.push({ dir: 'recv', t: Date.now() - this.started, line }); }
  note(text) { this.entries.push({ dir: 'note', t: Date.now() - this.started, text }); }
  /** Parsed JSON messages in one direction (non-JSON lines come back as { raw }). */
  messages(dir) { return this.entries.filter(e => e.dir === dir).map(e => { try { return JSON.parse(e.line); } catch { return { raw: e.line }; } }); }
  notes() { return this.entries.filter(e => e.dir === 'note').map(e => e.text); }
}

export function fixturePath(provider, scenario) { return path.join(repoRoot, 'tests', 'fixtures', 'app', provider, `${scenario}.jsonl`); }

export function writeFixture(provider, transcript, extra) {
  const file = fixturePath(provider, transcript.scenario);
  mkdirSync(path.dirname(file), { recursive: true });
  const header = { fixture: 'hydra-app-protocol/v1', provider, scenario: transcript.scenario, ...transcript.meta };
  const lines = redactTranscript(header, transcript.entries, extra);
  let body = lines.join('\n') + '\n';
  if (Buffer.byteLength(body) > fixtureLimitBytes) {
    // Drop the bulkiest partial-stream lines first, keeping both ends of the transcript.
    const kept = [lines[0]]; let size = Buffer.byteLength(lines[0]) + 1; const marker = JSON.stringify({ dir: 'note', t: 0, text: 'fixture trimmed to stay under 200 KB' });
    const budget = fixtureLimitBytes - Buffer.byteLength(marker) - 2;
    for (const line of lines.slice(1)) { const n = Buffer.byteLength(line) + 1; if (size + n > budget) continue; kept.push(line); size += n; }
    body = [...kept, marker].join('\n') + '\n';
  }
  writeFileSync(file, body, 'utf8');
  return file;
}

export function readFixture(provider, scenario) {
  const file = fixturePath(provider, scenario);
  if (!existsSync(file)) return undefined;
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const [header, ...entries] = lines;
  const t = new Transcript(scenario, header); t.entries = entries; t.size = Buffer.byteLength(readFileSync(file));
  return t;
}

// ---- Processes ----

/** Starts a provider CLI hidden, with line-oriented stdout. `.cmd` shims go through cmd.exe without a window. */
export function startProcess(executable, args, { cwd, env, onLine, onStderr, transcript }) {
  const isShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable);
  const child = isShim
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', [executable, ...args].map(quoteForCmd).join(' ')], { cwd, env, windowsHide: true, windowsVerbatimArguments: true, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    pending += chunk; let i;
    while ((i = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, i).replace(/\r$/, ''); pending = pending.slice(i + 1); if (!line.trim()) continue; transcript?.recv(line); onLine?.(line); }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => onStderr?.(chunk));
  const exited = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  child.on('error', error => onStderr?.(`spawn error: ${error.message}`));
  return {
    child, exited,
    write(obj) { const line = typeof obj === 'string' ? obj : JSON.stringify(obj); transcript?.send(line); child.stdin.write(line + '\n'); },
    kill() { killTree(child.pid); }
  };
}

function quoteForCmd(value) { return /[\s"&|<>^]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value; }

/** Kills a process and its children (a .cmd shim's real CLI is a grandchild). */
export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') { try { execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }); } catch {} }
  else { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

/** Resolves when `predicate(message)` matches a later stdout JSON message, or rejects after `ms`. */
export function waitFor(bus, predicate, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { bus.off(handler); reject(new Error(`Timed out after ${ms} ms waiting for ${label}.`)); }, ms);
    const handler = message => { let hit = false; try { hit = predicate(message); } catch {} if (hit) { clearTimeout(timer); bus.off(handler); resolve(message); } };
    bus.on(handler);
  });
}

/** A tiny listener set for parsed stdout messages. */
export class MessageBus {
  constructor() { this.handlers = new Set(); }
  on(h) { this.handlers.add(h); } off(h) { this.handlers.delete(h); }
  emit(m) { for (const h of [...this.handlers]) h(m); }
  /** onLine callback for startProcess. */
  lineHandler() { return line => { let m; try { m = JSON.parse(line); } catch { return; } this.emit(m); }; }
}

// ---- Scratch repositories (never this repository: CONTRIBUTING.md) ----

export function scratchRepo(prefix, workdir) {
  const base = workdir ? path.resolve(workdir) : os.tmpdir();
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, prefix));
  if (path.resolve(dir).toLowerCase().startsWith(repoRoot.toLowerCase())) throw new Error('Scratch repositories must be outside the Hydra repository.');
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore', windowsHide: true });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=Hydra G1', '-c', 'user.email=g1@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'scratch');
  return dir;
}

// ---- Confining what a live run allows ----

/**
 * Why an approval for `tool` with `input` must become a deny in the scratch repository `root`,
 * or undefined when it may stand. File paths must resolve inside root; Bash may only run the
 * small commands the scenarios ask for, with no absolute or parent paths.
 */
export function confinementProblem(root, tool, input = {}) {
  const inside = candidate => { const resolved = path.resolve(root, candidate); const rel = path.relative(path.resolve(root), resolved); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
  for (const key of ['file_path', 'notebook_path', 'path']) {
    if (typeof input[key] === 'string' && !inside(input[key])) return `${key} is outside the scratch repository`;
  }
  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = String(input.command ?? '');
    if (!/^(mkdir|node|echo)\b/.test(command.trim())) return 'only mkdir, node and echo may run';
    if (/\.\.[\\/]|(^|[\s"'=])([A-Za-z]:[\\/]|[\\/]{1,2}[A-Za-z])/.test(command)) return 'the command names a path outside the scratch repository';
  }
  return undefined;
}

// ---- Running scenarios ----

/**
 * scenarios: [{ name, run(ctx) -> Transcript, check(transcript) -> string[] of failures }].
 * Live: run, write the fixture, then check. Fixture: check the committed fixture.
 */
export async function runScenarios({ provider, scenarios, options, live, evidenceExtra = {} }) {
  const results = []; const budget = new TurnBudget(options.maxTurns);
  for (const scenario of scenarios) {
    if (options.only && !options.only.has(scenario.name)) continue;
    let transcript; let error;
    try {
      if (options.mode === 'live') {
        transcript = await scenario.run({ ...live, budget });
        writeFixture(provider, transcript, live.redactions?.() ?? []);
        transcript = readFixture(provider, scenario.name);
      } else {
        transcript = readFixture(provider, scenario.name);
        if (!transcript) throw new Error('fixture missing');
      }
    } catch (e) { error = e; }
    let failures = error ? [error instanceof TurnCapError ? `stopped: ${error.message}` : `error: ${error.message}`] : [];
    if (transcript && !error) {
      if (transcript.size > fixtureLimitBytes) failures.push(`fixture is ${transcript.size} bytes, over 200 KB`);
      try { failures.push(...scenario.check(transcript)); } catch (e) { failures.push(`check threw: ${e.message}`); }
    }
    const status = failures.length ? 'fail' : 'pass';
    results.push({ scenario: scenario.name, status, failures, findings: transcript && scenario.findings ? safe(() => scenario.findings(transcript)) : undefined });
    process.stdout.write(`${status.toUpperCase()} ${scenario.name}${failures.length ? `\n  - ${failures.join('\n  - ')}` : ''}\n`);
    if (error instanceof TurnCapError) break;
  }
  const evidence = {
    schema: `hydra-app-live/${provider}/v1`, provider, mode: options.mode, turnsUsed: budget.used, turnCap: budget.max,
    result: results.length && results.every(r => r.status === 'pass') ? 'pass' : 'fail', results, ...evidenceExtra
  };
  writeFileSync(path.resolve(options.evidence), redactLine(JSON.stringify(evidence, null, 2)) + '\n', { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`${evidence.result}: ${path.resolve(options.evidence)} (${budget.used}/${budget.max} turns)\n`);
  if (evidence.result !== 'pass') process.exitCode = 1;
  return evidence;
}
function safe(fn) { try { return fn(); } catch (e) { return { error: e.message }; } }
