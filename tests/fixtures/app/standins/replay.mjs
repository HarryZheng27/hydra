#!/usr/bin/env node
// Stand-in CLI for the Hydra app's chat tests: replays one of G1's recorded protocol transcripts
// (tests/fixtures/app/<provider>/<scenario>.jsonl) as if it were `claude -p` or `codex app-server`.
//
//   HYDRA_STANDIN_FIXTURE  the fixture to replay
//   HYDRA_STANDIN_STATE    a folder for its state: which process this is (a fixture can hold several, split at its
//                          "args:" notes), and calls.log, one line per start with its arguments
//
// It runs in lockstep with the recording. At each line the host sent, it waits for the host's next line and checks it
// is the same message: the same kind (type and subtype, method, or approval decision), and for an approval the same
// updated input, for a user message the same kinds of content blocks. Anything else exits 2 with the reason on stderr
// and in errors.log. Each line it has checked is counted in consumed.log, so a test can wait until all were seen. Request ids the host chooses are mapped onto the recorded ones, so recorded replies answer the host's
// requests. Then it writes what the CLI wrote. At the end of its part it waits for stdin to close, as a CLI would.
// It never starts a model or touches the network.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const fixture = process.env.HYDRA_STANDIN_FIXTURE ?? '';
const state = process.env.HYDRA_STANDIN_STATE;
const args = process.argv.slice(2);

// Version and help answer like the real CLIs, for onboarding's checks, before anything needs a fixture.
const provider = /[\\/]codex[\\/]/.test(fixture) ? 'codex' : 'claude';
if (args[0] === '--version') { process.stdout.write(provider === 'claude' ? '2.1.282 (Claude Code)\n' : 'codex-cli 0.157.1\n'); process.exit(0); }
if (args.includes('--help')) { process.stdout.write('--output-format stream-json --input-format stream-json --resume --permission-prompt-tool app-server generate-json-schema\n'); process.exit(0); }
// Hydra's start-up check of a head's CLI (src/core/cliSelfCheck.ts: `-p … --strict-mcp-config`, one initialize, no
// session): answered as Claude Code would, outside the recording, so it doesn't take a chat's place in the fixture.
if (args[0] === '-p' && args.includes('--strict-mcp-config') && !args.includes('--session-id') && !args.includes('--resume')) {
  const { createInterface } = await import('node:readline');
  for await (const line of createInterface({ input: process.stdin })) {
    let request; try { request = JSON.parse(line); } catch { continue; }
    if (request?.type === 'control_request' && request.request?.subtype === 'initialize') { process.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: {} } })}\n`); process.exit(0); }
  }
  process.exit(2);
}
if (!fixture || !state) { process.stderr.write('replay: set HYDRA_STANDIN_FIXTURE and HYDRA_STANDIN_STATE\n'); process.exit(2); }
fs.mkdirSync(state, { recursive: true });

const counterFile = path.join(state, 'process-count');
const counter = () => Number(fs.existsSync(counterFile) ? fs.readFileSync(counterFile, 'utf8') : '0');
/** Takes the next process's place in the fixture, and logs the start. */
const claim = () => { const taken = counter(); fs.writeFileSync(counterFile, String(taken + 1)); fs.appendFileSync(path.join(state, 'calls.log'), `${JSON.stringify({ index: taken, args })}\n`); return taken; };
// Claude's process takes its place as it starts. Codex's waits until the host starts or resumes a thread: the app may
// start an app-server and replace it before that (a chat switching to "Ask me" first), and a server replaced before
// its first thread must not use up a place, or the next one would replay the wrong part. Until then it answers the
// opening (initialize), which every Codex part shares, from the part it would take.
const appServer = args[0] === 'app-server';
let index = appServer ? counter() : claim();
let claimed = !appServer;

const records = fs.readFileSync(fixture, 'utf8').split(/\r?\n/).filter(Boolean).slice(1).map(line => JSON.parse(line));
// Parts, one per process the live check started: Claude's fixtures mark each with an "args:" note; Codex's begin each
// process with the host's initialize request.
const parts = [];
const marked = records.some(record => record.dir === 'note' && record.text.startsWith('args:'));
for (const record of records) {
  const line = record.dir === 'send' ? (() => { try { return JSON.parse(record.line); } catch { return {}; } })() : undefined;
  if (marked ? record.dir === 'note' && record.text.startsWith('args:') : line?.method === 'initialize') parts.push([]);
  if (parts.length && (record.dir === 'send' || record.dir === 'recv' || record.dir === 'call')) parts.at(-1).push(record);
}
// Requests G1's harness sent for its own checks that a chat client doesn't (isolation, sandbox readiness, a read-back):
// when the host doesn't send one, it is skipped with its response.
const optional = new Set(['mcpServerStatus/list', 'windowsSandbox/readiness', 'thread/read', 'account/rateLimits/read', 'model/list']);
const skipped = new Set();
let part = parts[index];
if (!part) { process.stderr.write(`replay: ${path.basename(fixture)} has no process ${index + 1}\n`); process.exit(2); }

const fail = reason => { process.stderr.write(`replay: ${reason}\n`); fs.appendFileSync(path.join(state, 'errors.log'), `${reason}\n`); process.exit(2); };
const parse = line => { try { return JSON.parse(line); } catch { return undefined; } };
/** The kind of a message, as compared between host and recording. */
function kind(message) {
  if (!message || typeof message !== 'object') return 'unreadable';
  if (message.type === 'control_request') return `control_request:${message.request?.subtype}`;
  if (message.type === 'control_response') return `control_response:${message.response?.response?.behavior ?? message.response?.subtype}`;
  if (message.type) return message.type;
  if (message.method) return `method:${message.method}`;
  if ('id' in message && 'result' in message) {
    const decision = message.result?.decision;
    return decision === undefined ? 'response' : `response:${typeof decision === 'string' ? decision : Object.keys(decision)[0]}`;
  }
  if ('id' in message && 'error' in message) return 'error-response';
  return 'unknown';
}

// The fixtures replace session ids with placeholders such as [session-11]. A real CLI reports the session the host
// started or resumed, so the stand-in puts that id back in.
const flag = args.indexOf('--resume') >= 0 ? args.indexOf('--resume') : args.indexOf('--session-id');
const sessionId = flag >= 0 ? args[flag + 1] : undefined;
const withSession = line => (sessionId ? line.replace(/\[session-\d+\]/g, sessionId) : line);
const withSessionValue = value => JSON.parse(withSession(JSON.stringify(value)));

/** What must match beyond the kind: an approval's decision and input, and a user message's kinds of content. */
function detail(message) {
  if (message?.type === 'control_response') {
    const reply = message.response?.response ?? {};
    return JSON.stringify({ behavior: reply.behavior, updatedInput: reply.updatedInput ?? null });
  }
  if (message?.type === 'user') {
    const content = message.message?.content;
    return JSON.stringify(typeof content === 'string' ? ['text'] : (content ?? []).map(block => block.type));
  }
  // Codex: what decides a thread's safety and which thread or turn a request is about. (approvalPolicy is left out:
  // G1 recorded different policies per scenario; the app always asks for on-request.)
  const p = message?.params ?? {};
  if (message?.method === 'thread/start') return JSON.stringify({ sandbox: p.sandbox, approvalsReviewer: p.approvalsReviewer });
  if (message?.method === 'thread/resume') return JSON.stringify({ threadId: p.threadId, sandbox: p.sandbox, approvalsReviewer: p.approvalsReviewer });
  if (message?.method === 'turn/start') return JSON.stringify({ threadId: p.threadId, sandboxPolicy: p.sandboxPolicy ?? null });
  if (message?.method === 'turn/interrupt') return JSON.stringify({ threadId: p.threadId, turnId: p.turnId });
  return '';
}

/**
 * A "call" record (the app's G5 smoke): the stand-in calls one of Hydra's lead tools for real, as Claude Code would
 * through its `hydra` server: it starts Hydra's bridge (HYDRA_STANDIN_BRIDGE, run by this same Node) in the chat's
 * folder, so the call comes from the chat's own process chain. The tool's result text fills the recv lines'
 * __HYDRA_RESULT__ placeholders. A failed call fails the stand-in, so it can't pass unseen.
 */
async function hydraCall(tool, args) {
  const script = process.env.HYDRA_STANDIN_BRIDGE;
  if (!script) fail('a live call needs HYDRA_STANDIN_BRIDGE');
  const { spawn } = await import('node:child_process');
  const bridge = spawn(process.execPath, [script], { cwd: process.cwd(), env: { ...process.env, HYDRA_HELPERS_DIR: process.env.HYDRA_STANDIN_HELPERS_DIR ?? '', HYDRA_LEAD_PROVIDER: 'claude' }, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  return new Promise(resolve => {
    let out = '';
    const timer = setTimeout(() => fail(`the live ${tool} call timed out: ${out.slice(-300)}`), 60000);
    const send = message => bridge.stdin.write(`${JSON.stringify(message)}\n`);
    bridge.stdout.on('data', chunk => {
      out += chunk;
      for (const line of out.split('\n').slice(0, -1)) {
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }); }
        if (message.id === 2) {
          clearTimeout(timer); bridge.kill();
          if (message.error || message.result?.isError) fail(`the live ${tool} call failed: ${JSON.stringify(message).slice(0, 300)}`);
          resolve((message.result?.content ?? []).map(block => block.text ?? '').join(''));
        }
      }
      out = out.slice(out.lastIndexOf('\n') + 1);
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'replay', version: '1' } } });
  });
}

const ids = new Map(); // recorded host request id -> the host's own id
const lines = [];
let waiting;
let closed = false;
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => { if (waiting) { const resolve = waiting; waiting = undefined; resolve(line); } else lines.push(line); });
input.on('close', () => { closed = true; if (waiting) { const resolve = waiting; waiting = undefined; resolve(undefined); } });
const next = () => (lines.length ? Promise.resolve(lines.shift()) : closed ? Promise.resolve(undefined) : new Promise(resolve => { waiting = resolve; }));
const write = line => new Promise(resolve => { if (!process.stdout.write(`${line}\n`)) process.stdout.once('drain', resolve); else resolve(); });

let held; // a host line read while skipping optional requests, still to be matched
let threadAsked = false; // an unrecorded model/list is answered only at the start, before the thread
let live = ''; // the result text of the latest live call, JSON-escaped for __HYDRA_RESULT__
for (let at = 0; at < part.length; at++) {
  let record = part[at];
  if (record.dir === 'call') { live = JSON.stringify(await hydraCall(record.tool, record.arguments ?? {})).slice(1, -1); continue; }
  if (record.dir === 'send') {
    let line = held ?? await next();
    held = undefined;
    if (line === undefined) process.exit(0); // the host closed stdin: it ended the chat
    let actual = parse(line);
    let expected = parse(record.line);
    // A model list the recording didn't ask for (G1 recorded resumes without one) gets an empty list.
    while (actual?.method === 'model/list' && 'id' in actual && expected?.method !== 'model/list' && !threadAsked) {
      await write(JSON.stringify({ id: actual.id, result: { data: [] } }));
      line = await next();
      if (line === undefined) process.exit(0);
      actual = parse(line);
    }
    if (!claimed && /^thread\//.test(actual?.method ?? '')) {
      // Now this server is the chat's: it takes its place, which may be a later part than the one it opened with.
      claimed = true;
      const taken = claim();
      if (taken !== index) {
        index = taken; part = parts[index];
        if (!part) { process.stderr.write(`replay: ${path.basename(fixture)} has no process ${index + 1}\n`); process.exit(2); }
        at = part.findIndex(candidate => candidate.dir === 'send' && /^thread\//.test(parse(candidate.line)?.method ?? ''));
        if (at < 0) fail(`process ${index + 1} of ${path.basename(fixture)} starts no thread`);
        record = part[at];
        expected = parse(record.line);
      }
    }
    if (expected?.method && optional.has(expected.method) && kind(actual) !== kind(expected)) {
      if ('id' in expected) skipped.add(expected.id);
      held = line;
      continue;
    }
    if (kind(actual) !== kind(expected)) fail(`expected ${kind(expected)} from the host, got ${kind(actual)}: ${line.slice(0, 200)}`);
    if (detail(actual) !== detail(withSessionValue(expected))) fail(`expected ${detail(expected).slice(0, 300)} from the host, got ${detail(actual).slice(0, 300)}`);
    if (/^thread\//.test(actual?.method ?? '')) threadAsked = true;
    fs.appendFileSync(path.join(state, 'consumed.log'), `${index}\n`);
    if (expected.type === 'control_request') ids.set(expected.request_id, actual.request_id);
    if (expected.method && 'id' in expected) ids.set(expected.id, actual.id);
    continue;
  }
  const message = parse(withSession(record.line.split('__HYDRA_RESULT__').join(live)));
  if (message && !message.method && 'id' in message && skipped.has(message.id)) continue; // the skipped request's response
  if (message?.type === 'control_response' && ids.has(message.response?.request_id)) message.response.request_id = ids.get(message.response.request_id);
  if (message && !message.method && 'id' in message && ids.has(message.id)) message.id = ids.get(message.id);
  await write(message ? JSON.stringify(message) : withSession(record.line));
}
// The recording ends here; a CLI stays until its input closes. Anything more from the host is unexpected.
for (;;) {
  const line = await next();
  if (line === undefined) process.exit(0);
  if (line.trim()) fail(`the recording has ended, but the host sent: ${line.slice(0, 200)}`);
}
