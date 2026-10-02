// G1 spike S1: Claude Code's stream-json chat protocol (docs/internal/hydra-app/G1-spikes.md).
// node scripts/app-live/claude.mjs --fixture|--live --evidence <path> [--executable <path>] [--max-turns N] [--only a,b] [--workdir <dir>]
// --live drives the real, signed-in CLI with the smallest model and writes redacted fixtures to
// tests/fixtures/app/claude; --fixture re-runs every check on those fixtures alone.
// Isolation from the user's own setup: --strict-mcp-config (or, where .mcp.json itself is under
// test, an allowlist proven first under strict), --setting-sources project,local, and a child
// environment without the parent session's CLAUDE*/ANTHROPIC_BASE_URL/MCP_* variables.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { MessageBus, Transcript, TurnCapError, confinementProblem, parseOptions, repoRoot, runScenarios, scratchRepo, startProcess, waitFor } from './common.mjs';

const usage = 'Usage: node scripts/app-live/claude.mjs --fixture|--live --evidence <path> [--executable <path>] [--max-turns N] [--only a,b] [--workdir <dir>]';
const stubScript = path.join(repoRoot, 'scripts', 'app-live', 'stub-mcp.mjs');
const turnTimeoutMs = 150_000;

class UsageLimitError extends TurnCapError {}

// Route A. On 2.1.282 `--permission-prompts host` alone does not reach the host: every prompt
// becomes a `system/permission_denied` event. The Agent SDK's canUseTool adds
// `--permission-prompt-tool stdio`, which turns prompts into `can_use_tool` control requests.
const routeA = ['--permission-prompt-tool', 'stdio', '--permission-prompts', 'host'];

// ---- Child environment: a fresh CLI, not a nested session ----
function childEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^CLAUDE/i.test(key) || /^ANTHROPIC_BASE_URL$/i.test(key) || /^MCP_/i.test(key) || /^ELECTRON_RUN_AS_NODE$/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

function baseArgs({ sessionId, resume, model = 'haiku', effort = 'low', extra = [] } = {}) {
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    ...(resume ? ['--resume', resume] : ['--session-id', sessionId]),
    '--model', model, '--effort', effort, '--setting-sources', 'project,local', ...extra];
}

function stubServer(name, logFile, approve = 'allow', root) {
  return { type: 'stdio', command: process.execPath, args: [stubScript, '--name', name, '--log', logFile, '--approve', approve, ...(root ? ['--root', root] : [])] };
}
function writeMcpConfig(dir, servers) {
  const file = path.join(dir, '..', `${path.basename(dir)}-mcp.json`);
  writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2));
  return file;
}
const readLog = file => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

// ---- One CLI process ----
const openSessions = new Set();
function openSession(ctx, transcript, { cwd, args, onControl, env, commands = [] }) {
  const bus = new MessageBus();
  let stderr = ''; let limited; let controls = 0;
  const proc = startProcess(ctx.executable, args, { cwd, env: env ?? childEnv(), onLine: bus.lineHandler(), onStderr: chunk => { stderr += chunk; }, transcript });
  transcript.note(`args: ${args.map(a => (a.length > 120 ? `${a.slice(0, 117)}...` : a)).join(' ')}`);
  bus.on(async message => {
    if (message.type === 'control_request') {
      let response; let error;
      try { response = await onControl?.(message.request ?? {}, message); } catch (e) { error = e.message; }
      // Whatever a scenario allows, nothing runs outside its scratch repository.
      const request = message.request ?? {};
      const problem = request.subtype === 'can_use_tool' && response?.behavior === 'allow' ? confinementProblem(cwd, request.tool_name, response.updatedInput ?? request.input, { commands }) : undefined;
      if (problem) { transcript.note(`confined: ${request.tool_name} denied (${problem})`); response = { behavior: 'deny', message: `The G1 host only allows work inside the scratch repository: ${problem}.` }; }
      if (response) proc.write({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } });
      else proc.write({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: error ?? `G1 host does not handle ${message.request?.subtype}` } });
    }
    if (isUsageLimit(message)) limited = describeLimit(message);
  });
  const session = {
    bus, proc,
    get stderr() { return stderr; },
    async turn(content, label, ms = turnTimeoutMs) {
      ctx.budget.take(label);
      const done = waitFor(bus, m => m.type === 'result', ms, `result of ${label}`);
      proc.write({ type: 'user', message: { role: 'user', content } });
      const result = await done;
      if (limited || /usage limit|rate limit/i.test(stderr)) throw new UsageLimitError(`usage limit (${limited ?? 'stderr'}) during ${label}`);
      return result;
    },
    async control(subtype, extra = {}, ms = 30_000) {
      const request_id = `g1-control-${++controls}`;
      const answer = waitFor(bus, m => m.type === 'control_response' && m.response?.request_id === request_id, ms, `control_response ${subtype}`);
      proc.write({ type: 'control_request', request_id, request: { subtype, ...extra } });
      return (await answer).response;
    },
    async close() {
      try { proc.child.stdin.end(); } catch {}
      const timer = new Promise(resolve => setTimeout(() => resolve('timeout'), 15_000));
      if (await Promise.race([proc.exited, timer]) === 'timeout') proc.kill();
      await proc.exited;
      openSessions.delete(session);
      if (stderr.trim()) transcript.note(`stderr: ${stderr.trim().slice(-1500)}`);
    }
  };
  openSessions.add(session);
  return session;
}

function isUsageLimit(m) {
  if (m.type === 'rate_limit_event' && m.rate_limit_info?.status === 'rejected') return true;
  if (m.type === 'assistant' && (m.error === 'rate_limit' || m.error === 'billing_error')) return true;
  if (m.type === 'result' && m.is_error && /usage limit|rate limit|limit reached|out of extra usage/i.test(`${m.result ?? ''} ${(m.errors ?? []).join(' ')}`)) return true;
  return false;
}
const describeLimit = m => String(m.error ?? m.result ?? m.subtype).slice(0, 200);

// ---- Helpers shared by checks ----
const recv = t => t.messages('recv');
const sent = t => t.messages('send');
const results = t => recv(t).filter(m => m.type === 'result');
const canUse = (t, tool) => recv(t).filter(m => m.type === 'control_request' && m.request?.subtype === 'can_use_tool' && (!tool || m.request.tool_name === tool));
const responseTo = (t, requestId) => sent(t).find(m => m.type === 'control_response' && m.response?.request_id === requestId)?.response?.response;
const hasNote = (t, text) => t.notes().some(n => n.includes(text));
const resultText = r => typeof r?.result === 'string' ? r.result : '';
function eventTypes(t) {
  const seen = new Set();
  for (const m of recv(t)) {
    if (!m.type) continue;
    let key = m.type;
    if (m.subtype) key += `/${m.subtype}`;
    if (m.type === 'stream_event') key += `/${m.event?.type}${m.event?.delta?.type ? `:${m.event.delta.type}` : ''}${m.event?.content_block?.type ? `:${m.event.content_block.type}` : ''}`;
    if (m.type === 'control_request' || m.type === 'control_response') key += `/${m.request?.subtype ?? m.response?.subtype}`;
    if ((m.type === 'assistant' || m.type === 'user') && Array.isArray(m.message?.content)) key += `[${[...new Set(m.message.content.map(c => c.type))].join(',')}]`;
    seen.add(key);
  }
  return [...seen].sort();
}
const allSuccessful = (t, n) => { const r = results(t); const f = []; if (r.length < n) f.push(`expected ${n} results, saw ${r.length}`); return f; };

// ---- Scenarios ----
const interruptCommand = `node -e "setTimeout(() => console.log('finished'), 30000)"`;
const scenarios = [];

// 1. Three turns in one process.
scenarios.push({
  name: 'three-turns',
  async run(ctx) {
    const t = new Transcript('three-turns'); const dir = scratchRepo('three-', ctx.workdir); const sessionId = randomUUID();
    const mcp = writeMcpConfig(dir, {});
    const s = openSession(ctx, t, { cwd: dir, args: baseArgs({ sessionId, extra: ['--strict-mcp-config', '--mcp-config', mcp] }) });
    const init = await s.control('initialize');
    t.note(`initialize response keys: ${Object.keys(init?.response ?? init ?? {}).join(',')}`);
    for (const word of ['one', 'two', 'three']) await s.turn(`Reply with just the word ${word}.`, `three-turns ${word}`);
    const ids = new Set(recv(t).filter(m => m.session_id).map(m => m.session_id));
    t.note(`session ids seen: ${ids.size}; matches --session-id: ${ids.size === 1 && ids.has(sessionId)}`);
    const inits = recv(t).filter(m => m.type === 'system' && m.subtype === 'init');
    t.note(`system/init count: ${inits.length}`);
    await s.close();
    return t;
  },
  check(t) {
    const f = allSuccessful(t, 3);
    results(t).forEach((r, i) => { if (r.is_error || r.subtype !== 'success') f.push(`result ${i + 1} was ${r.subtype}`); if (!resultText(r).toLowerCase().includes(['one', 'two', 'three'][i])) f.push(`result ${i + 1} text: ${resultText(r)}`); });
    if (!hasNote(t, 'matches --session-id: true')) f.push('session id did not match --session-id');
    if (!recv(t).some(m => m.type === 'system' && m.subtype === 'init')) f.push('no system/init');
    return f;
  },
  findings: t => ({ eventTypes: eventTypes(t), notes: t.notes().filter(n => !n.startsWith('args')) })
});

// 2. Route A approvals: Bash allow, Write deny, Write allow with edited input, WebFetch deny, MCP allow.
scenarios.push({
  name: 'approvals-route-a',
  async run(ctx) {
    const t = new Transcript('approvals-route-a'); const dir = scratchRepo('approve-', ctx.workdir); const sessionId = randomUUID();
    const log = path.join(dir, '..', `${path.basename(dir)}-stub.log`);
    const mcp = writeMcpConfig(dir, { g1stub: stubServer('g1stub', log) });
    let policy = () => undefined;
    const s = openSession(ctx, t, {
      cwd: dir, args: baseArgs({ sessionId, extra: [...routeA, '--strict-mcp-config', '--mcp-config', mcp] }),
      onControl: request => request.subtype === 'can_use_tool' ? policy(request) : undefined
    });
    await s.control('initialize');
    policy = r => r.tool_name === 'Bash' ? { behavior: 'allow', updatedInput: r.input } : { behavior: 'deny', message: 'Only Bash is allowed in this turn.' };
    await s.turn('Use the Bash tool to run exactly: mkdir g1-bash-dir', 'bash allow');
    policy = r => ({ behavior: 'deny', message: 'The G1 host denied this write.' });
    await s.turn('Use the Write tool to create denied.txt containing the word no. If it is denied, stop and say denied.', 'write deny');
    policy = r => r.tool_name === 'Write' ? { behavior: 'allow', updatedInput: { ...r.input, content: 'edited-by-host\n' } } : { behavior: 'deny', message: 'Only Write is allowed in this turn.' };
    await s.turn('Use the Write tool to create edited.txt containing exactly: original', 'write allow edited');
    policy = r => ({ behavior: 'deny', message: 'The G1 host denied this fetch.' });
    await s.turn('Use the WebFetch tool to fetch https://example.com and tell me the title. If it is denied, stop and say denied.', 'webfetch deny');
    policy = r => r.tool_name.startsWith('mcp__') ? { behavior: 'allow', updatedInput: r.input } : { behavior: 'deny', message: 'Only MCP tools are allowed in this turn.' };
    await s.turn('Call the mcp__g1stub__echo tool with text hi, then reply with its output.', 'mcp allow');
    await s.close();
    t.note(`denied.txt exists: ${existsSync(path.join(dir, 'denied.txt'))}`);
    const edited = existsSync(path.join(dir, 'edited.txt')) ? readFileSync(path.join(dir, 'edited.txt'), 'utf8').trim() : '(missing)';
    t.note(`edited.txt content: ${edited}`);
    t.note(`stub echo calls: ${readLog(log).filter(e => e.event === 'call' && e.tool === 'echo').length}`);
    return t;
  },
  check(t) {
    const f = allSuccessful(t, 5);
    for (const tool of ['Bash', 'Write', 'WebFetch', 'mcp__g1stub__echo']) if (!canUse(t, tool).length) f.push(`no can_use_tool for ${tool}`);
    const bash = canUse(t, 'Bash')[0]; if (bash && responseTo(t, bash.request_id)?.behavior !== 'allow') f.push('Bash was not allowed');
    if (!hasNote(t, 'denied.txt exists: false')) f.push('denied write still happened');
    if (!hasNote(t, 'edited.txt content: edited-by-host')) f.push('updatedInput did not change the written content');
    if (!hasNote(t, 'stub echo calls: 1') && !t.notes().some(n => /stub echo calls: [1-9]/.test(n))) f.push('MCP tool did not run after allow');
    const web = canUse(t, 'WebFetch')[0]; if (web && responseTo(t, web.request_id)?.behavior !== 'deny') f.push('WebFetch was not denied');
    return f;
  },
  findings: t => ({
    eventTypes: eventTypes(t),
    canUseTool: canUse(t).map(m => ({ tool: m.request.tool_name, requestKeys: Object.keys(m.request).sort(), answer: responseTo(t, m.request_id)?.behavior })),
    notes: t.notes().filter(n => !n.startsWith('args'))
  })
});

// 3. AskUserQuestion answered via updatedInput.answers; ExitPlanMode denied with feedback, then allowed.
scenarios.push({
  name: 'questions-plan-route-a',
  async run(ctx) {
    const t = new Transcript('questions-plan-route-a'); const dir = scratchRepo('plan-', ctx.workdir);
    const mcp = writeMcpConfig(dir, {});
    const strict = [...routeA, '--strict-mcp-config', '--mcp-config', mcp];
    const ask = openSession(ctx, t, {
      cwd: dir, args: baseArgs({ sessionId: randomUUID(), extra: strict }),
      onControl: r => {
        if (r.subtype !== 'can_use_tool') return undefined;
        if (r.tool_name !== 'AskUserQuestion') return { behavior: 'deny', message: 'Only AskUserQuestion is allowed here.' };
        const answers = Object.fromEntries((r.input?.questions ?? []).map(q => [q.question, q.options?.find(o => /blue/i.test(o.label))?.label ?? 'Blue']));
        return { behavior: 'allow', updatedInput: { ...r.input, answers } };
      }
    });
    await ask.control('initialize');
    const askResult = await ask.turn('Use the AskUserQuestion tool to ask me one question, "Pick a color", with the options Red and Blue. Then reply with just the color I picked.', 'ask question');
    const initTools = recv(t).find(m => m.type === 'system' && m.subtype === 'init')?.tools ?? [];
    t.note(`AskUserQuestion in init tools: ${initTools.includes('AskUserQuestion')}`);
    t.note(`question answer reached the model: ${/blue/i.test(resultText(askResult))}`);
    await ask.close();

    let exitPlanCalls = 0;
    const plan = openSession(ctx, t, {
      cwd: dir, args: baseArgs({ sessionId: randomUUID(), extra: ['--permission-mode', 'plan', ...strict] }),
      onControl: r => {
        if (r.subtype !== 'can_use_tool') return undefined;
        if (r.tool_name === 'ExitPlanMode') {
          exitPlanCalls++;
          return exitPlanCalls === 1 ? { behavior: 'deny', message: 'Feedback from the user: name the file plan-v2.txt instead, then present the plan again.' } : { behavior: 'allow', updatedInput: r.input };
        }
        if (r.tool_name === 'Write') return { behavior: 'allow', updatedInput: r.input };
        return { behavior: 'deny', message: 'Not needed for this plan.' };
      }
    });
    await plan.control('initialize');
    await plan.turn('Plan creating a file plan.txt containing hi. Do no research; present the plan with ExitPlanMode right away. After approval, create the file.', 'plan exit');
    await plan.close();
    t.note(`ExitPlanMode requests: ${exitPlanCalls}`);
    t.note(`plan-v2.txt exists: ${existsSync(path.join(dir, 'plan-v2.txt'))}; plan.txt exists: ${existsSync(path.join(dir, 'plan.txt'))}`);
    return t;
  },
  check(t) {
    const f = allSuccessful(t, 2);
    if (!canUse(t, 'AskUserQuestion').length) f.push('no can_use_tool for AskUserQuestion');
    if (!hasNote(t, 'question answer reached the model: true')) f.push('the AskUserQuestion answer did not reach the model');
    const exits = canUse(t, 'ExitPlanMode');
    if (exits.length < 2) f.push(`expected ExitPlanMode deny then allow, saw ${exits.length} requests`);
    else { if (responseTo(t, exits[0].request_id)?.behavior !== 'deny') f.push('first ExitPlanMode not denied'); if (responseTo(t, exits[1].request_id)?.behavior !== 'allow') f.push('second ExitPlanMode not allowed'); }
    // The feedback counts as followed when the re-presented plan names plan-v2.txt. Where the model
    // then writes the file is model behavior (haiku once wrote it one folder up), so it is only noted.
    if (exits.length >= 2 && !/plan-v2/.test(exits[1].request?.input?.plan ?? '')) f.push('the plan feedback (plan-v2.txt) was not followed');
    if (!recv(t).some(m => m.type === 'assistant' && (m.message?.content ?? []).some(c => c.type === 'tool_use' && c.name === 'Write' && /plan-v2/.test(c.input?.file_path ?? '')))) f.push('nothing acted on the approved plan');
    return f;
  },
  findings: t => ({
    eventTypes: eventTypes(t),
    askRequest: canUse(t, 'AskUserQuestion')[0]?.request, askAnswer: (() => { const r = canUse(t, 'AskUserQuestion')[0]; return r && responseTo(t, r.request_id); })(),
    // Summarized, not copied: the plan text is long and model-written, and the evidence only needs its shape.
    exitPlan: canUse(t, 'ExitPlanMode').map(m => { const a = responseTo(t, m.request_id); return { inputKeys: Object.keys(m.request.input ?? {}), planNamesV2: /plan-v2/.test(m.request.input?.plan ?? ''), behavior: a?.behavior, message: a?.message, updatedInputKeys: a?.updatedInput && Object.keys(a.updatedInput) }; }),
    notes: t.notes().filter(n => !n.startsWith('args'))
  })
});

// 4. Route B: --permission-prompt-tool with a stub MCP approve tool.
scenarios.push({
  name: 'route-b-stub-mcp',
  async run(ctx) {
    const t = new Transcript('route-b-stub-mcp'); const dir = scratchRepo('routeb-', ctx.workdir);
    const log = path.join(dir, '..', `${path.basename(dir)}-stub.log`);
    const mcp = writeMcpConfig(dir, { g1stub: stubServer('g1stub', log, 'allow', dir) });
    const s = openSession(ctx, t, {
      cwd: dir, args: baseArgs({ sessionId: randomUUID(), extra: ['--permission-prompt-tool', 'mcp__g1stub__approve', '--strict-mcp-config', '--mcp-config', mcp] }),
      onControl: r => { t.note(`route B saw a control_request: ${r.subtype}${r.tool_name ? ` ${r.tool_name}` : ''}`); return r.subtype === 'can_use_tool' ? { behavior: 'deny', message: 'Route B host should not be asked.' } : undefined; }
    });
    await s.control('initialize');
    await s.turn('Use the Bash tool to run exactly: mkdir g1-route-b-dir', 'route b bash');
    const askResult = await s.turn('Use the AskUserQuestion tool to ask me one question, "Pick a color", with the options Red and Blue. Then reply with just the color I picked, or with just: question failed if the tool failed.', 'route b question');
    t.note(`route B question result: ${resultText(askResult).slice(0, 200)}`);
    await s.close();
    // ExitPlanMode through route B: the stub allows it, then the Write that follows.
    const plan = openSession(ctx, t, { cwd: dir, args: baseArgs({ sessionId: randomUUID(), extra: ['--permission-mode', 'plan', '--permission-prompt-tool', 'mcp__g1stub__approve', '--strict-mcp-config', '--mcp-config', mcp] }) });
    await plan.control('initialize');
    await plan.turn('Plan creating a file routeb-plan.txt containing hi. Do no research; present the plan with ExitPlanMode right away. After approval, create the file.', 'route b plan');
    await plan.close();
    t.note(`route B plan approved and followed: ${existsSync(path.join(dir, 'routeb-plan.txt'))}`);
    const calls = readLog(log).filter(e => e.event === 'call');
    for (const c of calls) t.note(`stub call: ${JSON.stringify({ tool: c.tool, arguments: c.arguments, meta: c.meta })}`);
    const modelCalls = recv(t).flatMap(m => m.type === 'assistant' ? (m.message?.content ?? []).filter(c => c.type === 'tool_use' && c.name === 'mcp__g1stub__approve') : []);
    t.note(`model tool_use blocks naming mcp__g1stub__approve: ${modelCalls.length}`);
    const initTools = recv(t).find(m => m.type === 'system' && m.subtype === 'init')?.tools ?? [];
    t.note(`approve tool visible to the model: ${initTools.includes('mcp__g1stub__approve')}; echo visible: ${initTools.includes('mcp__g1stub__echo')}`);
    const toolResults = recv(t).flatMap(m => m.type === 'user' ? (m.message?.content ?? []).filter(c => c.type === 'tool_result') : []).map(c => typeof c.content === 'string' ? c.content : JSON.stringify(c.content));
    t.note(`route B tool results: ${JSON.stringify(toolResults).slice(0, 600)}`);
    t.note(`route B question answer reached the model: ${/\bred\b/i.test(resultText(askResult))}`);
    const count = name => calls.filter(c => c.tool === 'approve' && c.arguments?.tool_name === name).length;
    t.note(`approve calls for Bash: ${count('Bash')}; for AskUserQuestion: ${count('AskUserQuestion')}; for ExitPlanMode: ${count('ExitPlanMode')}; for mcp__g1stub__approve: ${count('mcp__g1stub__approve')}`);
    t.note(`every approve call carried _meta claudecode/toolUseId equal to its tool_use_id: ${calls.filter(c => c.tool === 'approve').every(c => c.meta?.['claudecode/toolUseId'] === c.arguments?.tool_use_id)}`);
    return t;
  },
  // Records 2.1.282's behavior, which differs from the plan: route B carries AskUserQuestion answers
  // (updatedInput.answers) and ExitPlanMode allows, and the approve tool is hidden from the model.
  check(t) {
    const f = allSuccessful(t, 3);
    if (!t.notes().some(n => /approve calls for Bash: [1-9]/.test(n))) f.push('the approve tool was not called for Bash');
    if (canUse(t).length) f.push('route B still sent can_use_tool control requests');
    if (!hasNote(t, 'route B question answer reached the model: true')) f.push('route B no longer carries question answers');
    if (!hasNote(t, 'route B plan approved and followed: true')) f.push('route B did not carry the ExitPlanMode approval');
    if (!hasNote(t, 'approve tool visible to the model: false')) f.push('the permission prompt tool is visible to the model');
    if (!hasNote(t, 'mcp__g1stub__approve: 0')) f.push('the model called the approve tool itself');
    return f;
  },
  findings: t => ({ eventTypes: eventTypes(t), notes: t.notes().filter(n => !n.startsWith('args')) })
});

// 5a. Interrupt mid-tool and mid-text; the process keeps working afterwards.
scenarios.push({
  name: 'interrupt',
  async run(ctx) {
    const t = new Transcript('interrupt'); const dir = scratchRepo('interrupt-', ctx.workdir);
    const mcp = writeMcpConfig(dir, {});
    let s;
    let toolAllowedAt;
    s = openSession(ctx, t, {
      commands: [interruptCommand],
      cwd: dir, args: baseArgs({ sessionId: randomUUID(), extra: [...routeA, '--strict-mcp-config', '--mcp-config', mcp] }),
      onControl: r => { if (r.subtype !== 'can_use_tool') return undefined; toolAllowedAt = Date.now(); return { behavior: 'allow', updatedInput: r.input }; }
    });
    await s.control('initialize');
    // Mid-tool: interrupt three seconds after the 30-second command was allowed.
    // Not `sleep 30`: 2.1.282 blocks a bare long sleep and steers the model to background it.
    const toolTurn = s.turn(`Use the Bash tool in the foreground (not in the background) to run exactly: ${interruptCommand}`, 'interrupt mid-tool');
    await waitFor(s.bus, m => m.type === 'assistant' && (m.message?.content ?? []).some(c => c.type === 'tool_use' && c.name === 'Bash'), 60_000, 'Bash tool_use');
    await new Promise(r => setTimeout(r, 4000));
    t.note(`mid-tool: Bash was ${toolAllowedAt ? 'prompted and allowed' : 'not prompted'}`);
    toolAllowedAt ??= Date.now() - 4000;
    const before = Date.now();
    const ack = await s.control('interrupt');
    const toolResult = await toolTurn;
    t.note(`mid-tool: interrupt acknowledged ${ack?.subtype}; result ${toolResult.subtype} ${Date.now() - before} ms after interrupt, ${Date.now() - toolAllowedAt} ms after allow`);
    // Mid-text: interrupt on the first text delta.
    const textTurn = s.turn('Write a 400-word story about a lighthouse keeper.', 'interrupt mid-text');
    await waitFor(s.bus, m => m.type === 'stream_event' && m.event?.delta?.type === 'text_delta', 60_000, 'first text delta');
    const textBefore = Date.now();
    await s.control('interrupt');
    const textResult = await textTurn;
    const deltas = recv(t).filter(m => m.type === 'stream_event' && m.event?.delta?.type === 'text_delta').length;
    t.note(`mid-text: result ${textResult.subtype} ${Date.now() - textBefore} ms after interrupt; text deltas in transcript: ${deltas}`);
    // Seen on 2.1.282: after an early mid-text interrupt, the next message can produce two results
    // (the interrupted request answered first, then the new one), so wait for the matching result.
    const resultsBefore = results(t).length;
    const still = waitFor(s.bus, m => m.type === 'result' && /still here/i.test(resultText(m)), turnTimeoutMs, 'still here');
    await s.turn('Reply with just: still here', 'after interrupt');
    const after = await still;
    t.note(`after interrupts: ${resultText(after).slice(0, 80)}; results for that one message: ${results(t).length - resultsBefore}`);
    await s.close();
    return t;
  },
  check(t) {
    const f = [];
    const r = results(t);
    if (r.length < 3) f.push(`expected 3 results, saw ${r.length}`);
    const interrupts = sent(t).filter(m => m.type === 'control_request' && m.request?.subtype === 'interrupt');
    if (interrupts.length !== 2) f.push(`expected 2 interrupts sent, saw ${interrupts.length}`);
    for (const i of interrupts) { const ack = recv(t).find(m => m.type === 'control_response' && m.response?.request_id === i.request_id); if (ack?.response?.subtype !== 'success') f.push(`interrupt ${i.request_id} not acknowledged`); }
    const mid = t.notes().find(n => n.startsWith('mid-tool:') && n.includes('ms after interrupt')); const ms = Number(/(\d+) ms after interrupt/.exec(mid ?? '')?.[1]);
    if (!(ms < 20_000)) f.push(`mid-tool interrupt did not end the turn early: ${mid}`);
    if (!t.notes().some(n => /^after interrupts: still here/i.test(n))) f.push('process did not answer after interrupts');
    return f;
  },
  findings: t => ({ eventTypes: eventTypes(t), resultSubtypes: results(t).map(r => `${r.subtype}${r.is_error ? ' (error)' : ''}`), notes: t.notes().filter(n => !n.startsWith('args')) })
});

// 5b. /model and /effort sent as user messages, plus the set_model control request.
scenarios.push({
  name: 'model-effort',
  async run(ctx) {
    const t = new Transcript('model-effort'); const dir = scratchRepo('model-', ctx.workdir);
    const mcp = writeMcpConfig(dir, {});
    const s = openSession(ctx, t, { cwd: dir, args: baseArgs({ sessionId: randomUUID(), extra: [...routeA, '--strict-mcp-config', '--mcp-config', mcp] }) });
    await s.control('initialize');
    const model = await s.turn('/model sonnet', '/model');
    t.note(`/model result: ${resultText(model).slice(0, 200)}`);
    const effort = await s.turn('/effort medium', '/effort');
    t.note(`/effort result: ${resultText(effort).slice(0, 200)}`);
    await s.turn('Reply with just: ok', 'after /model');
    const models = recv(t).filter(m => m.type === 'assistant' && m.message?.model).map(m => m.message.model);
    t.note(`assistant models after /model: ${[...new Set(models)].join(',')}`);
    const setModel = await s.control('set_model', { model: 'haiku' });
    t.note(`set_model control response: ${setModel?.subtype}`);
    await s.close();
    return t;
  },
  check(t) {
    const f = [];
    if (results(t).length < 3) f.push(`expected 3 results, saw ${results(t).length}`);
    if (!t.notes().some(n => n.startsWith('assistant models after /model:') && /sonnet/i.test(n))) f.push('/model sonnet did not change the model');
    return f;
  },
  findings: t => ({ eventTypes: eventTypes(t), results: results(t).map(r => ({ subtype: r.subtype, is_error: r.is_error, result: resultText(r).slice(0, 200) })), notes: t.notes().filter(n => !n.startsWith('args')) })
});

// 5c. A project slash command and a project skill.
scenarios.push({
  name: 'slash-command-skill',
  async run(ctx) {
    const t = new Transcript('slash-command-skill'); const dir = scratchRepo('slash-', ctx.workdir);
    mkdirSync(path.join(dir, '.claude', 'commands'), { recursive: true });
    mkdirSync(path.join(dir, '.claude', 'skills', 'g1skill'), { recursive: true });
    writeFileSync(path.join(dir, '.claude', 'commands', 'g1cmd.md'), '---\ndescription: G1 test command\n---\nReply with exactly: G1-COMMAND-OK $ARGUMENTS\n');
    writeFileSync(path.join(dir, '.claude', 'skills', 'g1skill', 'SKILL.md'), '---\nname: g1skill\ndescription: Replies with the G1 skill phrase. Use when asked for the G1 skill.\n---\nReply with exactly: G1-SKILL-OK\n');
    const mcp = writeMcpConfig(dir, {});
    const s = openSession(ctx, t, { cwd: dir, args: baseArgs({ sessionId: randomUUID(), extra: [...routeA, '--strict-mcp-config', '--mcp-config', mcp] }) });
    const init = await s.control('initialize');
    const commands = (init?.response?.commands ?? init?.commands ?? []).map(c => c.name);
    t.note(`initialize lists g1cmd: ${commands.includes('g1cmd')}; g1skill: ${commands.includes('g1skill')}`);
    const cmd = await s.turn('/g1cmd alpha', '/g1cmd');
    t.note(`command result: ${resultText(cmd).slice(0, 200)}`);
    const skill = await s.turn('/g1skill', '/g1skill');
    t.note(`skill result: ${resultText(skill).slice(0, 200)}`);
    const init2 = recv(t).find(m => m.type === 'system' && m.subtype === 'init');
    t.note(`init slash_commands has g1cmd: ${(init2?.slash_commands ?? []).includes('g1cmd')}; g1skill: ${(init2?.slash_commands ?? []).includes('g1skill')}; skills has g1skill: ${(init2?.skills ?? []).includes('g1skill')}`);
    await s.close();
    return t;
  },
  check(t) {
    const f = [];
    if (!t.notes().some(n => n.startsWith('command result:') && n.includes('G1-COMMAND-OK'))) f.push('custom slash command did not run');
    if (!t.notes().some(n => n.startsWith('skill result:') && n.includes('G1-SKILL-OK'))) f.push('skill did not run');
    return f;
  },
  findings: t => ({ eventTypes: eventTypes(t), notes: t.notes().filter(n => !n.startsWith('args')) })
});

// 5d. An image content block in a user message.
function redPng() {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const size = 16; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.concat(Array.from({ length: size }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([255, 0, 0]))])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
scenarios.push({
  name: 'image',
  async run(ctx) {
    const t = new Transcript('image'); const dir = scratchRepo('image-', ctx.workdir);
    const mcp = writeMcpConfig(dir, {});
    const s = openSession(ctx, t, { cwd: dir, args: baseArgs({ sessionId: randomUUID(), extra: [...routeA, '--strict-mcp-config', '--mcp-config', mcp] }) });
    await s.control('initialize');
    const r = await s.turn([{ type: 'text', text: 'What single color fills this image? Reply with one word.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: redPng() } }], 'image');
    t.note(`image answer: ${resultText(r).slice(0, 100)}`);
    await s.close();
    return t;
  },
  check(t) {
    const f = allSuccessful(t, 1);
    if (!t.notes().some(n => n.startsWith('image answer:') && /red/i.test(n))) f.push('the model did not see the red image');
    return f;
  },
  findings: t => ({ eventTypes: eventTypes(t), notes: t.notes().filter(n => !n.startsWith('args')) })
});

// 6. Kill the process mid-session, restart with --resume, continue.
scenarios.push({
  name: 'kill-resume',
  async run(ctx) {
    const t = new Transcript('kill-resume'); const dir = scratchRepo('resume-', ctx.workdir); const sessionId = randomUUID();
    const mcp = writeMcpConfig(dir, {});
    const extra = [...routeA, '--strict-mcp-config', '--mcp-config', mcp];
    const first = openSession(ctx, t, { cwd: dir, args: baseArgs({ sessionId, extra }) });
    await first.control('initialize');
    await first.turn('Remember the code word PELICAN. Reply with just: ok', 'before kill');
    first.proc.kill();
    const exit = await first.proc.exited;
    t.note(`killed first process: code ${exit.code} signal ${exit.signal}`);
    const second = openSession(ctx, t, { cwd: dir, args: baseArgs({ resume: sessionId, extra }) });
    await second.control('initialize');
    const r = await second.turn('What was the code word? Reply with one word.', 'after resume');
    t.note(`resumed answer: ${resultText(r).slice(0, 100)}`);
    const inits = recv(t).filter(m => m.type === 'system' && m.subtype === 'init');
    t.note(`resumed session id matched: ${inits.length === 2 && inits[1].session_id === sessionId}; result session id matched: ${r.session_id === sessionId}`);
    await second.close();
    return t;
  },
  check(t) {
    const f = allSuccessful(t, 2);
    if (!t.notes().some(n => n.startsWith('resumed answer:') && /pelican/i.test(n))) f.push('the resumed session lost the conversation');
    if (!hasNote(t, 'resumed session id matched: true')) f.push('resumed session id differed');
    return f;
  },
  findings: t => ({ eventTypes: eventTypes(t), notes: t.notes().filter(n => !n.startsWith('args')) })
});

// 7. Project hooks and .mcp.json in a never-trusted folder run under -p without a trust prompt.
// .mcp.json can't load under --strict-mcp-config, so an allowlist in --settings keeps the user's
// own servers out instead. Step one proves, under strict, that --settings allowedMcpServers is honored.
scenarios.push({
  name: 'untrusted-hooks-mcp',
  async run(ctx) {
    const t = new Transcript('untrusted-hooks-mcp');
    const probeDir = scratchRepo('allowprobe-', ctx.workdir);
    const probeLog = path.join(probeDir, '..', `${path.basename(probeDir)}-stub.log`);
    const probeMcp = writeMcpConfig(probeDir, { g1allowed: stubServer('g1allowed', probeLog), g1blocked: stubServer('g1blocked', probeLog) });
    const probeSettings = JSON.stringify({ allowedMcpServers: [{ serverName: 'g1allowed' }] });
    const probe = openSession(ctx, t, { cwd: probeDir, args: baseArgs({ sessionId: randomUUID(), extra: ['--strict-mcp-config', '--mcp-config', probeMcp, '--settings', probeSettings] }) });
    await probe.control('initialize');
    const status = await probe.control('mcp_status').catch(e => ({ error: e.message }));
    t.note(`allowlist probe mcp_status: ${JSON.stringify(status).slice(0, 600)}`);
    await probe.close();
    const started = new Set(readLog(probeLog).filter(e => e.event === 'start').map(e => e.server));
    t.note(`allowlist probe started: g1allowed=${started.has('g1allowed')} g1blocked=${started.has('g1blocked')}`);
    if (started.has('g1blocked') || !started.has('g1allowed')) { t.note('allowlist not honored from --settings: skipped the non-strict run'); return t; }

    const dir = scratchRepo('untrusted-', ctx.workdir);
    const log = path.join(dir, 'mcp-started.log');
    mkdirSync(path.join(dir, '.claude'), { recursive: true });
    writeFileSync(path.join(dir, '.claude', 'g1-hook.mjs'), "import { appendFileSync } from 'node:fs';\nlet input = '';\nprocess.stdin.on('data', d => { input += d; });\nprocess.stdin.on('end', () => { let event = 'unknown'; try { event = JSON.parse(input).hook_event_name; } catch {} appendFileSync('hook-ran.txt', event + '\\n'); });\n");
    const hook = { hooks: [{ type: 'command', command: 'node .claude/g1-hook.mjs' }] };
    writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [hook], UserPromptSubmit: [hook] } }, null, 2));
    writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { g1proj: { type: 'stdio', command: process.execPath, args: [stubScript, '--name', 'g1proj', '--log', 'mcp-started.log'] } } }, null, 2));
    const settings = JSON.stringify({ allowedMcpServers: [{ serverName: 'g1proj' }], deniedMcpServers: [{ serverName: 'hydra' }] });
    const s = openSession(ctx, t, { cwd: dir, args: baseArgs({ sessionId: randomUUID(), extra: [...routeA, '--include-hook-events', '--settings', settings] }), env: childEnv({ ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }) });
    await s.control('initialize');
    await s.turn('Reply with just: ok', 'untrusted folder');
    await s.close();
    const init = recv(t).filter(m => m.type === 'system' && m.subtype === 'init').at(-1);
    t.note(`init mcp_servers: ${JSON.stringify((init?.mcp_servers ?? []).map(m => `${m.name}:${m.status}`))}`);
    t.note(`hook marker: ${existsSync(path.join(dir, 'hook-ran.txt')) ? readFileSync(path.join(dir, 'hook-ran.txt'), 'utf8').trim().split('\n').join(',') : '(missing)'}`);
    t.note(`.mcp.json server started: ${readLog(log).some(e => e.event === 'start' && e.server === 'g1proj')}`);
    return t;
  },
  check(t) {
    const f = [];
    if (!hasNote(t, 'allowlist probe started: g1allowed=true g1blocked=false')) f.push('allowlist probe failed; the non-strict run was skipped');
    if (hasNote(t, 'skipped the non-strict run')) return f;
    f.push(...allSuccessful(t, 1));
    if (!t.notes().some(n => n.startsWith('hook marker:') && n.includes('SessionStart'))) f.push('project SessionStart hook did not run');
    if (!t.notes().some(n => n.startsWith('hook marker:') && n.includes('UserPromptSubmit'))) f.push('project UserPromptSubmit hook did not run');
    if (!hasNote(t, '.mcp.json server started: true')) f.push('.mcp.json server did not start');
    if (t.notes().some(n => n.startsWith('init mcp_servers:') && /hydra:connected/.test(n))) f.push('the user-level hydra server connected');
    return f;
  },
  findings: t => ({ eventTypes: eventTypes(t), notes: t.notes().filter(n => !n.startsWith('args')) })
});

// 8. Two headless defaults the app must not rely on: `--permission-prompts host` without
// `--permission-prompt-tool stdio` turns every prompt into system/permission_denied (no
// can_use_tool reaches the host), and --strict-mcp-config ignores the project's .mcp.json.
scenarios.push({
  name: 'headless-defaults',
  async run(ctx) {
    const t = new Transcript('headless-defaults'); const dir = scratchRepo('defaults-', ctx.workdir); const sessionId = randomUUID();
    const log = path.join(dir, '..', `${path.basename(dir)}-stub.log`);
    writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { g1project: stubServer('g1project', log) } }, null, 2));
    const mcp = writeMcpConfig(dir, {});
    const s = openSession(ctx, t, {
      cwd: dir, args: baseArgs({ sessionId, extra: ['--permission-prompts', 'host', '--strict-mcp-config', '--mcp-config', mcp] }),
      onControl: request => request.subtype === 'can_use_tool' ? { behavior: 'allow', updatedInput: request.input } : undefined
    });
    await s.control('initialize');
    await s.turn('Use the Write tool to create denied.txt containing exactly: hi. If it is not allowed, reply "not allowed".', 'prompts host only');
    t.note(`denied.txt exists: ${existsSync(path.join(dir, 'denied.txt'))}`);
    t.note(`project .mcp.json server started: ${readLog(log).some(e => e.event === 'start')}`);
    await s.close();
    return t;
  },
  check(t) {
    const f = allSuccessful(t, 1);
    if (canUse(t).length) f.push('a can_use_tool reached the host without --permission-prompt-tool stdio');
    if (!recv(t).some(m => m.type === 'system' && m.subtype === 'permission_denied')) f.push('no system/permission_denied event');
    if (!hasNote(t, 'denied.txt exists: false')) f.push('the write happened');
    const init = recv(t).find(m => m.type === 'system' && m.subtype === 'init');
    if (!init) f.push('no system/init');
    else if ((init.mcp_servers ?? []).some(s => String(s.name ?? s).includes('g1project'))) f.push('--strict-mcp-config loaded the project .mcp.json');
    if (!hasNote(t, 'project .mcp.json server started: false')) f.push('the project .mcp.json server started');
    return f;
  },
  findings: t => ({ permissionDenied: recv(t).filter(m => m.subtype === 'permission_denied').map(m => ({ tool: m.tool_name, keys: Object.keys(m).sort() })), notes: t.notes().filter(n => !n.startsWith('args')) })
});

// ---- Main ----
const options = parseOptions(process.argv.slice(2), usage);
// Fixture mode needs no CLI, so it works on machines (and CI) without Claude Code.
const executable = options.mode === 'live' ? options.executable ?? defaultExecutable() : undefined;
function defaultExecutable() {
  if (process.platform !== 'win32') return 'claude';
  // A spawn without a shell needs the real file: where.exe first, then the native installer's location.
  try { const found = execFileSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).filter(Boolean); const pick = found.find(f => /\.exe$/i.test(f)) ?? found.find(f => /\.cmd$/i.test(f)); if (pick) return pick; } catch {}
  const native = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
  if (existsSync(native)) return native;
  throw new Error('Claude Code not found; pass --executable.');
}
const workdir = options.workdir ? path.resolve(options.workdir) : undefined;
if (options.mode === 'live' && !workdir) throw new Error('--live needs --workdir outside the repository.');
// Session ids become stable labels ([session-1], ...) so equality survives redaction; the
// initialize response's account block is dropped. Both happen before writeFixture's redaction.
const sessionLabels = new Map();
for (const scenario of scenarios) {
  const run = scenario.run;
  scenario.run = async ctx => {
    let t;
    try { t = await run(ctx); } finally { for (const s of openSessions) { s.proc.kill(); openSessions.delete(s); } }
    removeOwnPlanFiles(t);
    for (const entry of t.entries) {
      if (entry.dir !== 'recv') continue;
      let m; try { m = JSON.parse(entry.line); } catch { continue; }
      if (typeof m.session_id === 'string' && !sessionLabels.has(m.session_id)) sessionLabels.set(m.session_id, `[session-${sessionLabels.size + 1}]`);
      const inner = m.type === 'control_response' ? m.response?.response : undefined;
      if (inner?.account) { inner.account = '[account]'; entry.line = JSON.stringify(m); }
    }
    return t;
  };
}
// Plan mode writes to the user's ~/.claude/plans even with --setting-sources project,local (G1).
// Delete exactly the files this run's sessions named in ExitPlanMode's planFilePath, nothing else.
const plansDir = path.join(os.homedir(), '.claude', 'plans');
function removeOwnPlanFiles(t) {
  const paths = new Set();
  const walk = v => { if (!v || typeof v !== 'object') return; for (const [k, x] of Object.entries(v)) { if (k === 'planFilePath' && typeof x === 'string') paths.add(x); else walk(x); } };
  for (const entry of t.entries) { if (!entry.line) continue; try { walk(JSON.parse(entry.line)); } catch {} }
  let removed = 0;
  for (const file of paths) {
    const resolved = path.resolve(file);
    if (path.dirname(resolved).toLowerCase() !== plansDir.toLowerCase() || !/\.md$/i.test(resolved) || !existsSync(resolved)) continue;
    try { unlinkSync(resolved); removed++; } catch {}
  }
  if (paths.size) t.note(`plan files this run wrote under ~/.claude/plans: ${paths.size}; removed: ${removed}`);
}

// The user's own Claude setup must come out of a live run unchanged (M3 of G1's review).
const userClaudeState = () => {
  const hash = file => { try { return createHash('sha256').update(readFileSync(file)).digest('hex'); } catch { return 'missing'; } };
  let hydra = 'missing'; try { hydra = JSON.stringify(JSON.parse(readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).mcpServers?.hydra ?? null); } catch {}
  return { settings: hash(path.join(os.homedir(), '.claude', 'settings.json')), hydra };
};
const stateBefore = options.mode === 'live' ? userClaudeState() : undefined;
const userStateUnchanged = () => {
  const after = userClaudeState();
  return { '~/.claude/settings.json': after.settings === stateBefore.settings, '~/.claude.json hydra MCP entry': after.hydra === stateBefore.hydra };
};

const redactions = () => {
  if (!workdir) return [];
  const variants = [workdir, workdir.replaceAll('\\', '/'), workdir.replaceAll('\\', '\\\\'), workdir.replaceAll('\\', '\\\\\\\\')];
  return [...[...new Set(variants)].sort((a, b) => b.length - a.length).map(v => [v, '[workdir]']), ...sessionLabels];
};
await runScenarios({ provider: 'claude', scenarios, options, live: { executable, workdir, redactions, userStateUnchanged }, evidenceExtra: { cli: 'claude', model: 'haiku', effort: 'low' } });
