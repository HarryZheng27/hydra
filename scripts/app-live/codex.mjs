// G1 spike S2: the Codex app-server protocol (docs/internal/hydra-app/G1-spikes.md, "S2: Codex").
// --live drives the real `codex app-server` over JSON-RPC stdio, records both directions,
// redacts and writes tests/fixtures/app/codex/<scenario>.jsonl. --fixture re-runs the checks
// on the committed fixtures only. Nico's ~/.codex/config.toml is never written: every MCP
// server it registers is disabled with `-c mcp_servers.<name>.enabled=false`, plugins, apps,
// memories, hooks and notify are switched off with overrides, and approvals go to the client.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { MessageBus, Transcript, TurnCapError, confinementProblem, parseOptions, runScenarios, scratchRepo, startProcess, waitFor } from './common.mjs';

const usage = 'Usage: node scripts/app-live/codex.mjs --fixture|--live --evidence <path> [--executable <path>] [--max-turns N] [--only a,b] [--workdir <dir>]';
const provider = 'codex';
const turnTimeoutMs = 240_000;
const requestTimeoutMs = 60_000;

/** A usage or rate limit stops the whole run, like the turn cap (runScenarios breaks on TurnCapError). */
class UsageLimitError extends TurnCapError {}
const limitCodes = new Set(['usageLimitExceeded', 'rateLimitExceeded', 'sessionBudgetExceeded']);

// ---- Environment and isolation ----

function childEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key === 'ELECTRON_RUN_AS_NODE' || key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key];
  return env;
}

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const userConfig = path.join(codexHome, 'config.toml');
function configHash() { try { return createHash('sha256').update(readFileSync(userConfig)).digest('hex'); } catch { return 'missing'; } }

let userServerNames = [];
const windowsSandbox = process.env.HYDRA_G1_WINDOWS_SANDBOX;
if (windowsSandbox && !/^(elevated|unelevated)$/.test(windowsSandbox)) throw new Error('HYDRA_G1_WINDOWS_SANDBOX must be elevated or unelevated.');

/** Config overrides that keep Nico's real setup out of the run without writing config.toml. */
function isolationArgs() {
  const args = [];
  let text = '';
  try { text = readFileSync(userConfig, 'utf8'); } catch {}
  // `-c mcp_servers={}` merges and leaves every server enabled, so disable each by name.
  // Every way TOML can name a server: [mcp_servers.x], [mcp_servers."x"], [mcp_servers.'x'], or inline.
  if (/^\s*mcp_servers\s*=/m.test(text) || /^\s*\[mcp_servers\]/m.test(text)) throw new Error('config.toml declares MCP servers inline; refusing to run, since they can\'t be disabled by name.');
  const names = new Set([...text.matchAll(/^\s*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))(?:\.[^\]]*)?\]/gm)].map(m => m[1] ?? m[2] ?? m[3]));
  userServerNames = [...names];
  for (const name of names) {
    if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Cannot disable MCP server "${name}" with a dotted override; refusing to run.`);
    args.push('-c', `mcp_servers.${name}.enabled=false`);
  }
  for (const feature of ['plugins', 'apps', 'memories', 'hooks', 'browser_use', 'computer_use', 'image_generation', 'multi_agent', 'goals', 'daemon_auto_start']) args.push('--disable', feature);
  // Unquoted values fall back to literal strings, which avoids cmd.exe quote handling for the npm shim.
  args.push('-c', 'notify=[]', '-c', 'approvals_reviewer=user');
  // The user's `[windows] sandbox = "elevated"` fails every command from a spawned app-server
  // ("apply deny-read ACLs", G1), so a run can pick the mode: HYDRA_G1_WINDOWS_SANDBOX=unelevated.
  if (windowsSandbox) args.push('-c', `windows.sandbox=${windowsSandbox}`);
  return args;
}

function resolveCodex(explicit) {
  if (explicit) return explicit;
  if (process.platform !== 'win32') return 'codex';
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean);
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  const hits = dirs.flatMap(d => ['codex.exe', 'codex.cmd'].map(n => path.join(d, n))).filter(p => existsSync(p));
  if (!hits.length) throw new Error('codex not found on PATH; pass --executable.');
  return hits.find(h => /\.exe$/i.test(h)) ?? hits.find(h => /\.cmd$/i.test(h)) ?? hits[0];
}

// ---- Redaction of scratch paths (all JSON escaping depths) ----

let redactions = [];
function addRedaction(value, label) {
  const variants = [value, value.replaceAll('\\', '/'), value.replaceAll('\\', '\\\\'), value.replaceAll('\\', '\\\\\\\\')];
  for (const v of new Set(variants)) { redactions.push([v, label]); redactions.push([v.toLowerCase(), label]); }
  redactions.sort((a, b) => b[0].length - a[0].length);
}

// common.mjs's account-key pattern expects `"accountId":"..."`, but a recorded protocol line is
// JSON inside JSON (`\"accountId\":\"...\"`), so it misses. Collect such values as exact redactions.
const accountKey = /^(accountId|accountUuid|userId|email|organizationId|organizationUuid|chatgptAccountId|workspaceId|account_id|user_id|org_id)$/;
function collectAccountValues(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return;
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === 'string' && accountKey.test(key) && v.length >= 4) addRedaction(v, '[account]');
    else if (v && typeof v === 'object') collectAccountValues(v, depth + 1);
  }
}

// ---- A JSON-RPC client over one app-server process ----

class CodexSession {
  constructor(ctx, transcript, cwd) {
    this.ctx = ctx; this.transcript = transcript; this.cwd = cwd;
    this.bus = new MessageBus(); this.nextId = 1; this.pending = new Map(); this.stderr = '';
    this.requestHandler = undefined;
    this.bus.on(message => this.dispatch(message));
    this.proc = startProcess(ctx.executable, ['app-server', '--listen', 'stdio://', ...ctx.isolation], {
      cwd, env: childEnv(), transcript, onLine: this.bus.lineHandler(),
      onStderr: chunk => { this.stderr = (this.stderr + chunk).slice(-8000); }
    });
    this.proc.exited.then(() => { for (const p of this.pending.values()) p.reject(new Error(`codex app-server exited. stderr tail: ${this.stderr.slice(-400)}`)); this.pending.clear(); });
  }
  dispatch(message) {
    collectAccountValues(message);
    if (message.method === 'item/started' && message.params?.item?.type === 'fileChange') (this.fileChanges ??= new Map()).set(message.params.item.id, message.params.item.changes ?? []);
    if (message.id !== undefined && message.method === undefined) {
      const entry = this.pending.get(message.id); if (!entry) return;
      this.pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(Object.assign(new Error(`${entry.method}: ${message.error.message}`), { rpc: message.error })); else entry.resolve(message.result);
      return;
    }
    if (message.id !== undefined && typeof message.method === 'string') {
      // A server request. Anything we do not handle is refused, never allowed by default.
      const handled = this.requestHandler?.(message);
      if (!handled) this.respondError(message.id, -32601, `G1 harness does not handle ${message.method}`);
    }
  }
  request(method, params, ms = requestTimeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${ms} ms`)); }, ms);
      this.pending.set(id, { resolve, reject, timer, method });
      this.proc.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }
  notify(method, params) { this.proc.write({ method, ...(params === undefined ? {} : { params }) }); }
  respond(id, result) { this.proc.write({ id, result }); }
  /** Answers an approval request; an accept only stands for work inside the scratch repository. */
  respondDecision(message, decision) {
    let problem;
    if (decision === 'accept' || decision === 'acceptForSession') {
      if (message.method === 'item/commandExecution/requestApproval') problem = typeof message.params.cwd === 'string' ? confinementProblem(this.cwd, 'Write', { path: message.params.cwd }) : undefined;
      else if (message.method === 'item/fileChange/requestApproval') {
        const changes = this.fileChanges?.get(message.params.itemId);
        problem = !changes ? 'the proposed changes were never shown' : changes.map(c => confinementProblem(this.cwd, 'Write', { path: String(c.path ?? '') })).find(Boolean);
      }
    }
    if (problem) { this.transcript.note(`confined: ${message.method} declined (${problem})`); decision = 'decline'; }
    this.respond(message.id, { decision });
    return decision;
  }
  respondError(id, code, message) { this.proc.write({ id, error: { code, message } }); }
  async initialize() {
    const init = await this.request('initialize', { clientInfo: { name: 'hydra-g1', title: 'Hydra G1 spike', version: '0.0.0' }, capabilities: { experimentalApi: false, requestAttestation: false } });
    this.notify('initialized', {});
    return init;
  }
  async close() {
    try { this.proc.child.stdin.end(); } catch {}
    const exited = await Promise.race([this.proc.exited, new Promise(r => setTimeout(() => r(null), 5000))]);
    if (!exited) { this.proc.kill(); await this.proc.exited; }
  }
  kill() { this.proc.kill(); return this.proc.exited; }
}

// ---- Shared steps ----

/**
 * The smallest model on offer, and its lowest effort at or above "low". 0.157.1 on Nico's plan lists no
 * "mini" model; the small tier is "luna" (gpt-6-luna), first in list order.
 */
async function pickModel(session, transcript) {
  const listed = await session.request('model/list', {});
  const models = (listed.data ?? []).filter(m => !m.hidden);
  const model = models.find(m => /mini/i.test(m.id)) ?? models.find(m => /luna/i.test(m.id)) ?? models.find(m => m.isDefault) ?? models[0];
  if (!model) throw new Error('model/list returned no models');
  const efforts = (model.supportedReasoningEfforts ?? []).map(e => e.reasoningEffort);
  const effort = ['low', 'minimal', 'medium'].find(e => efforts.includes(e)) ?? model.defaultReasoningEffort;
  transcript.note(`model chosen: ${model.id}; effort: ${effort}; supported efforts: ${efforts.join(',')}`);
  return { model: model.id, effort, models };
}

// thread/start with sandbox workspace-write in an untrusted folder persists trust_level = "trusted"
// into ~/.codex/config.toml (S2 finding). Threads start read-only; turns that must write pass a
// workspaceWrite sandboxPolicy on turn/start instead, which did not persist trust.
async function openThread(session, transcript, { approvalPolicy = 'on-request', sandbox = 'read-only', ...extra } = {}) {
  const init = await session.initialize();
  transcript.note(`initialize userAgent version: ${String(init.userAgent).match(/\d+\.\d+\.\d+/)?.[0] ?? 'unknown'}`);
  transcript.note(`windows sandbox override: ${windowsSandbox ?? "none (user config)"}`);
  const pick = await pickModel(session, transcript);
  const started = await session.request('thread/start', { cwd: session.cwd, model: pick.model, approvalPolicy, approvalsReviewer: 'user', sandbox, config: { model_reasoning_effort: pick.effort }, ...extra });
  transcript.note(`thread/start granted approvalPolicy=${JSON.stringify(started.approvalPolicy)} sandbox=${started.sandbox?.type} reviewer=${started.approvalsReviewer} effort=${started.reasoningEffort}`);
  // Before any turn: every server from the user's config must report disabled, or nothing runs.
  const status = await session.request('mcpServerStatus/list', { threadId: started.thread.id });
  const live = (status.data ?? []).filter(s => userServerNames.includes(s.name) && s.runtimeStatus !== 'disabled');
  if (live.length) throw new Error(`user MCP servers still enabled: ${live.map(s => s.name).join(', ')}; refusing to send a turn.`);
  return { threadId: started.thread.id, started, pick };
}

let usageLimited = false;
// No extra writable roots: the thread's cwd is writable already, and the unelevated Windows sandbox
// refuses a split set of roots, temp folders included ("cannot enforce split writable root sets directly", G1).
const workspaceWrite = () => ({ type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
/** Whether a process whose command line holds `marker` is running (hidden PowerShell, Windows only). */
function processAlive(marker) {
  if (process.platform !== 'win32') return 'unknown';
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.Name -eq 'node.exe' }).Count`], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    return Number(out.trim()) > 0;
  } catch { return 'unknown'; }
}
function text(t) { return { type: 'text', text: t, text_elements: [] }; }

/**
 * One user turn: budget, turn/start, then collect until turn/completed. `onRequest(message)`
 * answers server requests (approvals) and returns true when handled.
 */
async function runTurn(ctx, session, transcript, label, params, { onRequest, onNotification } = {}) {
  if (usageLimited) { transcript.note('stopped: usage limit'); throw new UsageLimitError('usage limit (account/rateLimits/read: ordinaryUsageAllowed false)'); }
  ctx.budget.take(label);
  const result = { label, approvals: [], items: [], deltas: '', methods: [] };
  session.requestHandler = message => onRequest ? onRequest(message, result) : false;
  const seen = message => {
    if (typeof message.method !== 'string' || message.id !== undefined) return;
    result.methods.push(message.method);
    if (message.method === 'item/completed') result.items.push(message.params.item);
    if (message.method === 'item/agentMessage/delta') result.deltas += message.params.delta ?? '';
    onNotification?.(message, result);
  };
  session.bus.on(seen);
  try {
    const completed = waitFor(session.bus, m => m.method === 'turn/completed' && m.params?.threadId === params.threadId, turnTimeoutMs, `${label} turn/completed`);
    completed.catch(() => {}); // awaited below; this only stops an early turn/start failure leaving it unhandled
    const started = await session.request('turn/start', params);
    result.turnId = started.turn.id;
    const done = await completed;
    result.turn = done.params.turn;
    result.reply = result.items.filter(i => i.type === 'agentMessage').map(i => i.text).join('\n');
    const code = result.turn.error?.codexErrorInfo;
    const codeName = typeof code === 'string' ? code : code && Object.keys(code)[0];
    if (result.turn.status === 'failed' && (limitCodes.has(codeName) || /usage limit|rate limit/i.test(result.turn.error?.message ?? ''))) {
      usageLimited = true; transcript.note('stopped: usage limit');
      throw new UsageLimitError(`usage limit (${codeName ?? result.turn.error?.message})`);
    }
    transcript.note(`${label}: turn status ${result.turn.status}; approvals ${result.approvals.length}`);
    return result;
  } finally { session.bus.off(seen); session.requestHandler = undefined; }
}

/** Every live scenario: a scratch repository, one transcript, config.toml must be untouched. */
async function withScratch(ctx, name, body) {
  const transcript = new Transcript(name, { cli: ctx.version });
  const dir = scratchRepo(`codex-${name}-`, ctx.workdir);
  addRedaction(dir, '<scratch>');
  const before = configHash();
  try { await body(transcript, dir); }
  finally {
    const unchanged = configHash() === before;
    transcript.note(`user config.toml unchanged: ${unchanged}`);
    if (!unchanged) {
      const removed = removeScratchTrust(dir);
      transcript.note(`removed trust entries Codex wrote for the scratch folder: ${removed}`);
      process.stderr.write(`WARNING: ${name} changed ~/.codex/config.toml; removed ${removed} scratch trust entr${removed === 1 ? 'y' : 'ies'}\n`);
    }
  }
  return transcript;
}

/**
 * Codex persists `trust_level = "trusted"` for a folder a workspace-write thread starts in (G1).
 * Remove only the [projects.'…'] tables under this run's scratch folder, so anything else the
 * user changed meanwhile stays.
 */
function removeScratchTrust(dir) {
  let text; try { text = readFileSync(userConfig, 'utf8'); } catch { return 0; }
  const scratch = path.resolve(dir).toLowerCase();
  let removed = 0;
  const kept = text.replace(/^\[projects\.(['"])(.+?)\1\]\r?\n(?:(?!\[)[^\r\n]*\r?\n?)*/gm, (block, _quote, key) => {
    const target = path.resolve(key.replaceAll('\\\\', '\\')).toLowerCase();
    if (target === scratch || target.startsWith(scratch + path.sep)) { removed++; return ''; }
    return block;
  });
  if (removed) writeFileSync(userConfig, kept);
  return removed;
}

// ---- Fixture helpers for checks ----

const recv = t => t.messages('recv');
const sent = t => t.messages('send');
const notifications = t => recv(t).filter(m => typeof m.method === 'string' && m.id === undefined);
const serverRequests = t => recv(t).filter(m => typeof m.method === 'string' && m.id !== undefined);
const methodsOf = t => [...new Set(notifications(t).map(m => m.method))];
const sentMethods = t => sent(t).filter(m => m.method).map(m => m.method);
const completions = t => notifications(t).filter(m => m.method === 'turn/completed').map(m => m.params.turn);
const noteMatching = (t, re) => t.notes().find(n => re.test(n));
const decisionsSent = t => { const ids = new Set(serverRequests(t).map(m => m.id)); return sent(t).filter(m => m.method === undefined && ids.has(m.id) && m.result).map(m => m.result.decision); };
const agentReplies = t => notifications(t).filter(m => m.method === 'item/completed' && m.params.item?.type === 'agentMessage').map(m => m.params.item.text);
function stoppedOnLimit(t) { return t.notes().includes('stopped: usage limit'); }
function common(t) {
  const failures = [];
  if (stoppedOnLimit(t)) return ['stopped: usage limit'];
  if (!sentMethods(t).includes('initialize') || !sentMethods(t).includes('initialized')) failures.push('no initialize/initialized handshake');
  if (noteMatching(t, /^user config\.toml unchanged: false/) && !t.notes().includes('expects config.toml trust write')) failures.push('~/.codex/config.toml was written during the run');
  return failures;
}

// ---- Tiny PNGs for image input ----

function crc32(buf) { let c, crc = 0xffffffff; for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function solidPng([r, g, b], size = 32) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array(size).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

// ---- Scenarios ----

const scenarios = [
  {
    name: 'turn-notifications',
    async run(ctx) {
      return withScratch(ctx, 'turn-notifications', async (t, dir) => {
        const session = new CodexSession(ctx, t, dir);
        try {
          const { threadId, pick } = await openThread(session, t);
          if (process.platform === 'win32') { try { const r = await session.request('windowsSandbox/readiness', undefined); t.note(`windowsSandbox/readiness: ${r.status}`); } catch (e) { t.note(`windowsSandbox/readiness error: ${e.message}`); } }
          const r = await runTurn(ctx, session, t, 'reply ok', { threadId, input: [text('Reply with exactly the word: ok')], effort: pick.effort });
          t.note(`notification methods in order: ${[...new Set(r.methods)].join(' ')}`);
          // Late notifications (token usage can trail turn/completed) land in the transcript too.
          await new Promise(res => setTimeout(res, 1500));
        } finally { await session.close(); }
      });
    },
    check(t) {
      const failures = common(t); if (failures.length) return failures;
      const methods = methodsOf(t);
      for (const m of ['thread/started', 'turn/started', 'item/started', 'item/completed', 'item/agentMessage/delta', 'turn/completed', 'thread/tokenUsage/updated']) if (!methods.includes(m)) failures.push(`missing notification ${m}`);
      const done = completions(t); if (done.length !== 1 || done[0].status !== 'completed') failures.push('expected exactly one completed turn');
      if (!agentReplies(t).some(r => /\bok\b/i.test(r))) failures.push('agent did not reply ok');
      const usage = notifications(t).find(m => m.method === 'thread/tokenUsage/updated');
      if (usage && typeof usage.params.tokenUsage?.last?.inputTokens !== 'number') failures.push('tokenUsage.last.inputTokens missing');
      return failures;
    },
    findings(t) {
      const usage = notifications(t).find(m => m.method === 'thread/tokenUsage/updated');
      return { notificationMethods: methodsOf(t), serverRequests: serverRequests(t).map(m => m.method), tokenUsageKeys: usage ? Object.keys(usage.params.tokenUsage) : [], notes: t.notes() };
    }
  },
  {
    name: 'command-approval',
    async run(ctx) {
      return withScratch(ctx, 'command-approval', async (t, dir) => {
        const session = new CodexSession(ctx, t, dir);
        try {
          const { threadId, pick } = await openThread(session, t, { approvalPolicy: 'untrusted', sandbox: 'read-only' });
          const answer = decisions => (message, result) => {
            if (message.method !== 'item/commandExecution/requestApproval' && message.method !== 'item/fileChange/requestApproval') return false;
            const decision = decisions[Math.min(result.approvals.length, decisions.length - 1)];
            result.approvals.push({ method: message.method, keys: Object.keys(message.params).sort(), decision });
            t.note(`approval ${message.method} keys: ${Object.keys(message.params).sort().join(',')} -> ${JSON.stringify(decision)}`);
            session.respondDecision(message, decision);
            return true;
          };
          const cmd = 'node -e "console.log(6*7)"';
          const r1 = await runTurn(ctx, session, t, 'decline', { threadId, effort: pick.effort, input: [text(`Use your shell tool to run exactly this command, nothing else: ${cmd}\nThen reply with its output. If the command is declined, reply "declined" and do not retry.`)] }, { onRequest: answer(['decline']) });
          t.note(`decline turn: approvals=${r1.approvals.length} reply mentions declined: ${/declin|denied|not approved|reject/i.test(r1.reply)}`);
          const r2 = await runTurn(ctx, session, t, 'accept', { threadId, effort: pick.effort, input: [text('Run that exact command once more now and reply with its output.')] }, { onRequest: answer(['accept']) });
          t.note(`accept turn: approvals=${r2.approvals.length} reply contains 42: ${/42/.test(r2.reply)}`);
          const r3 = await runTurn(ctx, session, t, 'acceptForSession', { threadId, effort: pick.effort, input: [text(`Run ${cmd} two more times, as two separate shell tool calls one after the other, then reply "done".`)] }, { onRequest: answer(['acceptForSession', 'acceptForSession']) });
          const runs = r3.items.filter(i => i.type === 'commandExecution').length;
          t.note(`acceptForSession turn: approvals=${r3.approvals.length} commandExecutions=${runs} (a second prompt would mean the session grant did not cover the repeat)`);
        } finally { await session.close(); }
      });
    },
    check(t) {
      const failures = common(t); if (failures.length) return failures;
      const reqs = serverRequests(t).filter(m => m.method === 'item/commandExecution/requestApproval');
      if (!reqs.length) failures.push('no item/commandExecution/requestApproval');
      for (const r of reqs) for (const k of ['threadId', 'turnId', 'itemId']) if (typeof r.params[k] !== 'string') failures.push(`approval request lacks ${k}`);
      const decisions = decisionsSent(t);
      for (const d of ['decline', 'accept', 'acceptForSession']) if (!decisions.includes(d)) failures.push(`never answered ${d}`);
      if (!methodsOf(t).includes('serverRequest/resolved')) failures.push('no serverRequest/resolved notification');
      if (completions(t).length !== 3) failures.push(`expected 3 completed turns, saw ${completions(t).length}`);
      if (!noteMatching(t, /^accept turn: .*contains 42: true/)) failures.push('accepted command output (42) not in the reply');
      return failures;
    },
    findings(t) {
      return { approvalParamKeys: [...new Set(serverRequests(t).map(m => `${m.method}: ${Object.keys(m.params).sort().join(',')}`))], decisionsSent: decisionsSent(t), sample: serverRequests(t)[0]?.params, notes: t.notes() };
    }
  },
  {
    name: 'file-change-approval',
    async run(ctx) {
      return withScratch(ctx, 'file-change-approval', async (t, dir) => {
        const session = new CodexSession(ctx, t, dir);
        try {
          const { threadId, pick } = await openThread(session, t, { approvalPolicy: 'on-request', sandbox: 'read-only' });
          const answer = decision => (message, result) => {
            if (message.method !== 'item/fileChange/requestApproval' && message.method !== 'item/commandExecution/requestApproval') return false;
            result.approvals.push({ method: message.method, decision });
            t.note(`approval ${message.method} keys: ${Object.keys(message.params).sort().join(',')} -> ${decision}`);
            session.respondDecision(message, decision);
            return true;
          };
          const r1 = await runTurn(ctx, session, t, 'decline', { threadId, effort: pick.effort, input: [text('Use apply_patch to create the file note.txt containing the single line: hi\nIf the change is declined, reply "declined" and do not retry.')] }, { onRequest: answer('decline') });
          t.note(`decline turn: approvals=${r1.approvals.map(a => a.method).join(',')} note.txt exists: ${existsSync(path.join(dir, 'note.txt'))}`);
          const r2 = await runTurn(ctx, session, t, 'accept', { threadId, effort: pick.effort, input: [text('Try again now: use apply_patch to create note.txt containing the single line: hi')] }, { onRequest: answer('accept') });
          t.note(`accept turn: approvals=${r2.approvals.map(a => a.method).join(',')} note.txt exists: ${existsSync(path.join(dir, 'note.txt'))}`);
          const r3 = await runTurn(ctx, session, t, 'acceptForSession', { threadId, effort: pick.effort, input: [text('Use apply_patch twice, as two separate patches: first create a.txt containing a, then create b.txt containing b. Reply "done".')] }, { onRequest: answer('acceptForSession') });
          t.note(`acceptForSession turn: approvals=${r3.approvals.length} (${r3.approvals.map(a => a.method).join(',')}) a.txt=${existsSync(path.join(dir, 'a.txt'))} b.txt=${existsSync(path.join(dir, 'b.txt'))}`);
        } finally { await session.close(); }
      });
    },
    check(t) {
      const failures = common(t); if (failures.length) return failures;
      const reqs = serverRequests(t).filter(m => m.method === 'item/fileChange/requestApproval');
      if (!reqs.length) failures.push('no item/fileChange/requestApproval');
      // A file approval refers to an item/started fileChange that carries the proposed changes.
      const started = notifications(t).filter(m => m.method === 'item/started' && m.params.item?.type === 'fileChange');
      for (const r of reqs) if (!started.some(s => s.params.item.id === r.params.itemId && Array.isArray(s.params.item.changes))) failures.push(`file approval ${r.params.itemId} has no earlier item/started fileChange with changes`);
      const decisions = decisionsSent(t);
      for (const d of ['decline', 'accept']) if (!decisions.includes(d)) failures.push(`never answered ${d}`);
      if (!noteMatching(t, /^decline turn: .*note\.txt exists: false/)) failures.push('declined change still wrote note.txt');
      if (!noteMatching(t, /^accept turn: .*note\.txt exists: true/)) failures.push('accepted change did not write note.txt');
      return failures;
    },
    findings(t) {
      const started = notifications(t).find(m => m.method === 'item/started' && m.params.item?.type === 'fileChange');
      return { approvalParamKeys: [...new Set(serverRequests(t).map(m => `${m.method}: ${Object.keys(m.params).sort().join(',')}`))], decisionsSent: decisionsSent(t), fileChangeItem: started?.params.item, notes: t.notes() };
    }
  },
  {
    name: 'interrupt',
    async run(ctx) {
      return withScratch(ctx, 'interrupt', async (t, dir) => {
        const session = new CodexSession(ctx, t, dir);
        try {
          const { threadId, pick } = await openThread(session, t, { approvalPolicy: 'never', sandbox: 'read-only' });
          let interruptedAt; let interruptResult;
          // Read-only on purpose: the unelevated Windows sandbox can't run workspace-write in a git
          // repository, and the elevated one fails from a spawned app-server (G1). The marker lets
          // Windows say whether the command's process outlived the interrupt.
          const marker = `g1-interrupt-${Math.random().toString(36).slice(2, 10)}`;
          const cmd = `node -e "/*${marker}*/setTimeout(()=>{},20000)"`;
          const alive = () => processAlive(marker);
          const r = await runTurn(ctx, session, t, 'interrupt mid-command', { threadId, effort: pick.effort, input: [text(`Run exactly this command with your shell tool in the foreground and wait for it to finish: ${cmd}\nThen reply "finished".`)] }, {
            onNotification: (message, result) => {
              if (interruptedAt || message.method !== 'item/started' || message.params.item?.type !== 'commandExecution') return;
              interruptedAt = Date.now();
              setTimeout(() => {
                t.note(`command process alive before interrupt: ${alive()}`);
                t.note('sending turn/interrupt 2 s after the command item started');
                session.request('turn/interrupt', { threadId, turnId: message.params.turnId }).then(res => { interruptResult = res; t.note(`turn/interrupt result: ${JSON.stringify(res)}`); }, e => t.note(`turn/interrupt error: ${e.message}`));
              }, 2000);
            }
          });
          t.note(`interrupt: turn status ${r.turn.status}; ms from command start to turn/completed: ${interruptedAt ? Date.now() - interruptedAt : 'n/a'}`);
          const cmdItem = r.items.find(i => i.type === 'commandExecution');
          t.note(`interrupted command item completed: ${!!cmdItem}; status: ${cmdItem?.status ?? 'none'}`);
          await new Promise(res => setTimeout(res, 3_000));
          t.note(`command process alive 3 s after the turn ended: ${alive()}`);
          await session.close();
          await new Promise(res => setTimeout(res, 1_000));
          t.note(`command process alive after the app-server exited: ${alive()}`);
          void interruptResult;
        } finally { await session.close(); }
      });
    },
    check(t) {
      const failures = common(t); if (failures.length) return failures;
      if (!sentMethods(t).includes('turn/interrupt')) failures.push('turn/interrupt never sent');
      const done = completions(t);
      if (done.length !== 1 || done[0].status !== 'interrupted') failures.push(`expected one interrupted turn, saw ${done.map(d => d.status).join(',') || 'none'}`);
      if (!noteMatching(t, /^command process alive before interrupt: true/)) failures.push('the command was not running when the interrupt was sent');
      // 0.157.1 leaves the command running after turn/interrupt (G1); a host must end it itself.
      // Record that fact either way, so a CLI update that changes it shows up in the findings.
      if (!noteMatching(t, /^command process alive 3 s after the turn ended: (true|false)/)) failures.push('the command process was not checked after the interrupt');
      return failures;
    },
    findings(t) { return { notes: t.notes(), methodsAfterInterrupt: methodsOf(t) }; }
  },
  {
    name: 'resume-after-restart',
    async run(ctx) {
      return withScratch(ctx, 'resume-after-restart', async (t, dir) => {
        let threadId; let pick;
        const first = new CodexSession(ctx, t, dir);
        try {
          ({ threadId, pick } = await openThread(first, t));
          await runTurn(ctx, first, t, 'remember', { threadId, effort: pick.effort, input: [text('Remember the code word PELICAN. Reply with exactly: ok')] });
        } finally { t.note('killing the first app-server process'); await first.kill(); }
        const second = new CodexSession(ctx, t, dir);
        try {
          await second.initialize();
          const resumed = await second.request('thread/resume', { threadId, cwd: dir, model: pick.model, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only' });
          t.note(`resumed thread id matched: ${resumed.thread.id === threadId}`);
          t.note(`resumed thread turns returned: ${resumed.thread.turns?.length ?? 'none'}; status: ${JSON.stringify(resumed.thread.status)}`);
          const r = await runTurn(ctx, second, t, 'recall', { threadId, effort: pick.effort, input: [text('What was the code word? Reply with just the word.')] });
          t.note(`recall reply contains PELICAN: ${/pelican/i.test(r.reply)}`);
        } finally { await second.close(); }
      });
    },
    check(t) {
      const failures = common(t); if (failures.length) return failures;
      if (!sentMethods(t).includes('thread/resume')) failures.push('thread/resume never sent');
      if (sentMethods(t).filter(m => m === 'initialize').length !== 2) failures.push('expected two processes (two initialize requests)');
      if (!t.notes().includes('resumed thread id matched: true')) failures.push('resumed thread id did not match');
      if (!t.notes().includes('recall reply contains PELICAN: true')) failures.push('resumed thread did not remember the code word');
      return failures;
    },
    findings(t) { return { notes: t.notes() }; }
  },
  {
    name: 'image-input',
    async run(ctx) {
      return withScratch(ctx, 'image-input', async (t, dir) => {
        const red = path.join(dir, 'red.png'); writeFileSync(red, solidPng([220, 20, 20]));
        const blueUrl = `data:image/png;base64,${solidPng([20, 40, 220]).toString('base64')}`;
        const session = new CodexSession(ctx, t, dir);
        try {
          const { threadId, pick } = await openThread(session, t);
          const model = pick.models.find(m => m.id === pick.model);
          t.note(`model inputModalities: ${(model?.inputModalities ?? []).join(',')}`);
          const r1 = await runTurn(ctx, session, t, 'localImage', { threadId, effort: pick.effort, input: [text('What single color fills this image? Reply with one word.'), { type: 'localImage', path: red }] });
          t.note(`localImage reply names red: ${/red/i.test(r1.reply)}`);
          const r2 = await runTurn(ctx, session, t, 'image data URL', { threadId, effort: pick.effort, input: [text('And this new image? Reply with one word.'), { type: 'image', url: blueUrl }] });
          t.note(`image data URL reply names blue: ${/blue/i.test(r2.reply)}`);
        } finally { await session.close(); }
      });
    },
    check(t) {
      const failures = common(t); if (failures.length) return failures;
      const inputs = sent(t).filter(m => m.method === 'turn/start').flatMap(m => m.params.input.map(i => i.type));
      for (const type of ['localImage', 'image']) if (!inputs.includes(type)) failures.push(`never sent a ${type} input`);
      if (!t.notes().includes('localImage reply names red: true')) failures.push('localImage not understood');
      if (!t.notes().includes('image data URL reply names blue: true')) failures.push('data URL image not understood');
      return failures;
    },
    findings(t) { return { userMessageItems: notifications(t).filter(m => m.method === 'item/completed' && m.params.item?.type === 'userMessage').map(m => m.params.item.content.map(c => ({ ...c, url: c.url ? `${c.url.slice(0, 30)}...` : undefined }))), notes: t.notes() }; }
  },
  {
    name: 'effort-per-turn',
    async run(ctx) {
      return withScratch(ctx, 'effort-per-turn', async (t, dir) => {
        const session = new CodexSession(ctx, t, dir);
        try {
          await session.initialize();
          const pick = await pickModel(session, t);
          // Thread without an effort: the response shows the configured default.
          const started = await session.request('thread/start', { cwd: dir, model: pick.model, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only' });
          const threadId = started.thread.id;
          t.note(`thread/start without effort -> reasoningEffort ${started.reasoningEffort}`);
          const r = await runTurn(ctx, session, t, 'effort per turn', { threadId, model: pick.model, effort: pick.effort, input: [text('Reply with exactly: ok')] }, {
            onNotification: m => { if (m.method === 'thread/settings/updated') t.note(`thread/settings/updated: ${JSON.stringify(m.params.threadSettings)}`); }
          });
          const read = await session.request('thread/read', { threadId });
          t.note(`after turn/start effort=${pick.effort}: thread/read reasoningEffort ${read.thread.reasoningEffort}; turn ${r.turn.status}`);
        } finally { await session.close(); }
      });
    },
    check(t) {
      const failures = common(t); if (failures.length) return failures;
      if (!sent(t).some(m => m.method === 'turn/start' && typeof m.params.effort === 'string')) failures.push('no turn/start with an effort');
      if (!noteMatching(t, /^after turn\/start effort=(\w+): thread\/read reasoningEffort \1;/)) failures.push('thread/read did not report the per-turn effort');
      return failures;
    },
    findings(t) { return { notes: t.notes() }; }
  }
];

/** Scenarios that spend no model turn (or only a refused one): they run first, so a usage limit cannot hide them. */
const preflight = [
  {
    name: 'rate-limits',
    async run(ctx) {
      return withScratch(ctx, 'rate-limits', async (t, dir) => {
        const session = new CodexSession(ctx, t, dir);
        try {
          await session.initialize();
          const limits = await session.request('account/rateLimits/read', undefined);
          for (const credit of limits.rateLimitResetCredits?.credits ?? []) if (credit.id) addRedaction(credit.id, '<credit-id>');
          const primary = limits.rateLimits?.primary;
          t.note(`ordinaryUsageAllowed: ${limits.ordinaryUsageAllowed}; primary usedPercent ${primary?.usedPercent} window ${primary?.windowDurationMins} min; reachedType ${limits.rateLimits?.rateLimitReachedType}`);
          if (limits.ordinaryUsageAllowed === false) {
            // Record the refused-turn shape once (a refused turn spends no quota), then stop every later turn.
            const pick = await pickModel(session, t);
            const started = await session.request('thread/start', { cwd: dir, model: pick.model, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only', ephemeral: true });
            ctx.budget.take('usage-limit turn shape');
            const done = waitFor(session.bus, m => m.method === 'turn/completed' && m.params?.threadId === started.thread.id, turnTimeoutMs, 'limited turn/completed');
            await session.request('turn/start', { threadId: started.thread.id, effort: pick.effort, input: [text('Reply with exactly: ok')] });
            const turn = (await done).params.turn;
            t.note(`limited turn: status ${turn.status}; codexErrorInfo ${JSON.stringify(turn.error?.codexErrorInfo)}`);
            usageLimited = true;
          }
        } finally { await session.close(); }
      });
    },
    check(t) {
      const failures = common(t); if (failures.length) return failures;
      const limits = recv(t).find(m => m.result && 'ordinaryUsageAllowed' in m.result);
      if (!limits) return ['no account/rateLimits/read result'];
      if (typeof limits.result.rateLimits?.primary?.usedPercent !== 'number') failures.push('rateLimits.primary.usedPercent missing');
      if (limits.result.ordinaryUsageAllowed === false) {
        const done = completions(t);
        if (done.length !== 1 || done[0].status !== 'failed' || done[0].error?.codexErrorInfo !== 'usageLimitExceeded') failures.push('limited turn did not fail with usageLimitExceeded');
        if (!notifications(t).some(m => m.method === 'error' && m.params.error?.codexErrorInfo === 'usageLimitExceeded')) failures.push('no error notification with usageLimitExceeded');
      }
      return failures;
    },
    findings(t) { return { notes: t.notes(), turnMethods: methodsOf(t) }; }
  },
  {
    name: 'model-list',
    async run(ctx) {
      return withScratch(ctx, 'model-list', async (t, dir) => {
        const session = new CodexSession(ctx, t, dir);
        try {
          const init = await session.initialize();
          t.note(`initialize result keys: ${Object.keys(init).sort().join(',')}; platformOs ${init.platformOs}`);
          const all = await session.request('model/list', { includeHidden: true });
          t.note(`model/list includeHidden: ${all.data.length} models, nextCursor ${all.nextCursor === null ? 'null' : 'set'}`);
          for (const m of all.data) t.note(`model ${m.id}: hidden=${m.hidden} default=${m.isDefault} efforts=${m.supportedReasoningEfforts.map(e => e.reasoningEffort).join('/')} defaultEffort=${m.defaultReasoningEffort} input=${m.inputModalities.join('/')}`);
          const pick = await pickModel(session, t);
          if (process.platform === 'win32') { try { const r = await session.request('windowsSandbox/readiness', undefined); t.note(`windowsSandbox/readiness: ${r.status}`); } catch (e) { t.note(`windowsSandbox/readiness error: ${e.message}`); } }
          const plain = await session.request('thread/start', { cwd: dir, model: pick.model, approvalsReviewer: 'user', ephemeral: true });
          t.note(`thread/start with no policy in an untrusted folder -> approvalPolicy ${JSON.stringify(plain.approvalPolicy)} sandbox ${plain.sandbox?.type} reasoningEffort ${plain.reasoningEffort}`);
          const withEffort = await session.request('thread/start', { cwd: dir, model: pick.model, approvalsReviewer: 'user', sandbox: 'read-only', ephemeral: true, config: { model_reasoning_effort: pick.effort } });
          t.note(`thread/start config.model_reasoning_effort=${pick.effort} -> reasoningEffort ${withEffort.reasoningEffort}`);
          // An effort that does not exist: rejected at turn/start, before any model call?
          // 0.157.1 accepts it and starts a real turn, so it counts against the budget and is interrupted at once.
          ctx.budget.take('invalid effort probe');
          const threadId = withEffort.thread.id;
          const done = waitFor(session.bus, m => m.method === 'turn/completed' && m.params?.threadId === threadId, turnTimeoutMs, 'invalid effort turn/completed');
          done.catch(() => {});
          try {
            const started = await session.request('turn/start', { threadId, effort: 'not-an-effort', input: [text('Reply with exactly: ok')] });
            t.note('invalid effort: accepted by turn/start');
            try { await session.request('turn/interrupt', { threadId, turnId: started.turn.id }); } catch (e) { t.note(`interrupt after invalid effort: ${e.message.slice(0, 120)}`); }
            const turn = (await done).params.turn;
            t.note(`invalid effort turn ended: ${turn.status}; codexErrorInfo ${JSON.stringify(turn.error?.codexErrorInfo ?? null)}`);
            if (turn.error?.codexErrorInfo === 'usageLimitExceeded') usageLimited = true;
          } catch (e) { t.note(`invalid effort: rejected by turn/start: ${e.rpc?.code ?? 'error'} ${String(e.rpc?.message ?? e.message).slice(0, 160)}`); }
        } finally { await session.close(); }
      });
    },
    check(t) {
      const failures = common(t); if (failures.length) return failures;
      const lists = recv(t).filter(m => m.result && Array.isArray(m.result.data) && m.result.data[0]?.supportedReasoningEfforts);
      if (!lists.length) failures.push('no model/list result with supportedReasoningEfforts');
      if (!noteMatching(t, /^model chosen: \S+; effort: \w+/)) failures.push('no model chosen from model/list');
      if (!noteMatching(t, /^thread\/start config\.model_reasoning_effort=(\w+) -> reasoningEffort \1$/)) failures.push('thread/start did not echo the requested effort');
      if (!noteMatching(t, /^invalid effort: (accepted|rejected)/)) failures.push('no observation for an unknown effort');
      return failures;
    },
    findings(t) { return { notes: t.notes() }; }
  },
  {
    name: 'untrusted-project-config',
    async run(ctx) {
      return withScratch(ctx, 'untrusted-project-config', async (t, dir) => {
        const probeDir = path.join(dir, '.codex'); mkdirSync(probeDir, { recursive: true });
        const marker = path.join(dir, 'mcp-started.txt');
        writeFileSync(path.join(probeDir, 'probe-mcp.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'started ' + Date.now());\nsetTimeout(() => process.exit(0), 3000);\n`);
        writeFileSync(path.join(probeDir, 'config.toml'), [
          'developer_instructions = "End every reply with the word ZEBRA."',
          '',
          '[mcp_servers.g1probe]',
          'command = "node"',
          `args = [${JSON.stringify(path.join(probeDir, 'probe-mcp.mjs'))}]`,
          'startup_timeout_sec = 5',
          ''
        ].join('\n'));
        const session = new CodexSession(ctx, t, dir);
        const warnings = [];
        session.bus.on(m => { if (m.method === 'configWarning' || m.method === 'warning') warnings.push(m.params.summary ?? m.params.message); });
        const mcpNames = async threadId => { try { const s = await session.request('mcpServerStatus/list', { threadId }); return (s.data ?? []).map(x => `${x.name}${x.runtimeStatus ? `(${JSON.stringify(x.runtimeStatus)})` : ''}`).join(',') || 'none'; } catch (e) { return `error ${e.message}`; } };
        try {
          // A: read-only thread, folder stays untrusted.
          const before = configHash();
          const { threadId, started, pick } = await openThread(session, t);
          t.note(`A read-only thread/start wrote config.toml: ${configHash() !== before}`);
          t.note(`A instructionSources: ${started.instructionSources.length}`);
          await new Promise(res => setTimeout(res, 6000));
          t.note(`A project MCP server started: ${existsSync(marker)}`);
          t.note(`A mcpServerStatus/list: ${await mcpNames(threadId)}`);
          if (!usageLimited) {
            const r = await runTurn(ctx, session, t, 'untrusted reply ok', { threadId, effort: pick.effort, input: [text('Reply with exactly the word: ok')] });
            t.note(`A project developer_instructions applied (reply has ZEBRA): ${/zebra/i.test(r.reply)}`);
            t.note(`A project MCP server started after a turn: ${existsSync(marker)}`);
          } else t.note('A turn skipped: usage limit');
          t.note(`A config warnings: ${warnings.length ? warnings.map(w => String(w).split('\n')[0]).join(' | ') : 'none'}`);
          // B: the same folder with sandbox workspace-write at thread/start: Codex persists trust, so
          // this phase writes Nico's config.toml and runs only when HYDRA_G1_TRUST_PROBE=1.
          if (process.env.HYDRA_G1_TRUST_PROBE !== '1') { t.note('B skipped: set HYDRA_G1_TRUST_PROBE=1 to persist a trust entry on purpose'); return; }
          t.note('expects config.toml trust write');
          const beforeB = configHash();
          const b = await session.request('thread/start', { cwd: dir, model: pick.model, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', ephemeral: true });
          t.note(`B workspace-write thread/start wrote config.toml: ${configHash() !== beforeB}; granted sandbox ${b.sandbox?.type}`);
          const tomlNow = readFileSync(userConfig, 'utf8');
          const trusted = tomlNow.toLowerCase().includes(dir.toLowerCase()) || tomlNow.toLowerCase().includes(dir.toLowerCase().replaceAll('\\', '/'));
          t.note(`B config.toml now has a [projects] entry for this folder: ${trusted}`);
          t.note(`B instructionSources: ${b.instructionSources.length}`);
          await new Promise(res => setTimeout(res, 6000));
          t.note(`B project MCP server started: ${existsSync(marker)}`);
          t.note(`B mcpServerStatus/list: ${await mcpNames(b.thread.id)}`);
          t.note(`config warnings: ${warnings.length ? warnings.join(' | ') : 'none'}`);
        } finally { await session.close(); }
      });
    },
    check(t) {
      const failures = common(t); if (failures.length) return failures;
      if (!t.notes().includes('A read-only thread/start wrote config.toml: false')) failures.push('a read-only thread/start wrote config.toml');
      if (!noteMatching(t, /^A project MCP server started: (true|false)/)) failures.push('no MCP start observation');
      if (t.notes().includes('A project MCP server started: false') && !notifications(t).some(m => m.method === 'configWarning' && /until the project is trusted/i.test(m.params.summary))) failures.push('project config skipped without the configWarning that says so');
      if (!noteMatching(t, /^B (skipped|workspace-write thread\/start wrote config\.toml: (true|false))/)) failures.push('no trust-write observation');
      // Recorded facts, not pass/fail on Codex's policy: the report decides what Hydra must do.
      return failures;
    },
    findings(t) { return { notes: t.notes() }; }
  }
];
scenarios.unshift(...preflight);

// ---- Main ----

const options = parseOptions(process.argv.slice(2), usage);
let live = {};
let evidenceExtra = {};
if (options.mode === 'live') {
  const executable = resolveCodex(options.executable);
  const isShim = /\.(cmd|bat)$/i.test(executable);
  const version = execFileSync(isShim ? (process.env.ComSpec || 'cmd.exe') : executable, isShim ? ['/d', '/c', executable, '--version'] : ['--version'], { encoding: 'utf8', windowsHide: true, env: childEnv() }).trim();
  const isolation = isolationArgs();
  const before = configHash();
  live = {
    executable, version, isolation, workdir: options.workdir,
    redactions: () => { const r = redactions; redactions = []; return r; }
  };
  evidenceExtra = { cli: version, isolation: isolation.filter(a => !a.startsWith('-')).map(a => a.replace(/^mcp_servers\.[^.]+\./, 'mcp_servers.<name>.')) };
  process.on('exit', () => { const unchanged = configHash() === before; process.stdout.write(`~/.codex/config.toml unchanged by this run: ${unchanged}\n`); });
}
await runScenarios({ provider, scenarios, options, live, evidenceExtra });
