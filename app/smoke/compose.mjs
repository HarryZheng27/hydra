// Builds the smoke's stand-in sessions from real turns G1 recorded (tests/fixtures/app/), so the app is driven
// through approve, deny, stop, restart and resume against each CLI's own recorded protocol.
// Claude:
//   process 1: initialize, then approvals-route-a's Bash turn (allowed) and Write turn (denied), then interrupt's
//              mid-text turn (stopped);
//   process 2: kill-resume's resumed process (initialize, one turn).
// Codex:
//   process 1: command-approval's opening and its two turns (declined, accepted), then interrupt's turn (stopped);
//   process 2: resume-after-restart's resumed app-server (initialize, thread/resume, one turn).
//   The recordings ran on three threads; the composed session uses the first one's id throughout, as one chat would.
import fs from 'node:fs';
import path from 'node:path';

function records(fixture) {
  return fs.readFileSync(fixture, 'utf8').split(/\r?\n/).filter(Boolean).slice(1).map(line => JSON.parse(line));
}
/** One process's records: the part after the n-th "args:" note. */
function part(all, n) {
  const parts = [];
  for (const record of all) {
    if (record.dir === 'note' && record.text.startsWith('args:')) parts.push({ args: record, records: [] });
    else if (parts.length && (record.dir === 'send' || record.dir === 'recv')) parts.at(-1).records.push(record);
  }
  return parts[n];
}
const message = record => { try { return JSON.parse(record.line); } catch { return {}; } };
/** The records before the first user message (initialize and its answer). */
const opening = records => records.slice(0, records.findIndex(record => record.dir === 'send' && message(record).type === 'user'));
/** The n-th turn: from the n-th user message the host sent up to the result that ends it. */
function turn(records, n) {
  const starts = records.map((record, index) => (record.dir === 'send' && message(record).type === 'user' ? index : -1)).filter(index => index >= 0);
  const begin = starts[n];
  const end = n + 1 < starts.length ? starts[n + 1] : records.length;
  return records.slice(begin, end);
}

/**
 * Process 3 (G5): a chat that starts a Hydra head. Built from approvals' first turn, its Bash call replaced by a call to
 * Hydra's hydra_start_head that the stand-in makes for real through Hydra's bridge (a "call" record), whose result
 * fills the tool result, as Claude Code's own `hydra` server would.
 */
export const smokeHeadCall = { tool: 'hydra_start_head', arguments: { title: 'Smoke head', brief: 'Write one file under smoke/.', write_scope: ['smoke/'], idempotency_key: 'smoke-head-1' } };
function hydraHeadTurn(records) {
  const pick = predicate => { const found = records.find(record => predicate(message(record), record)); if (!found) throw new Error('compose: approvals-route-a changed shape'); return found; };
  const edit = (record, change) => { const value = message(record); change(value); return { ...record, line: JSON.stringify(value) }; };
  const user = pick((value, record) => record.dir === 'send' && value.type === 'user');
  const init = pick(value => value.type === 'system' && value.subtype === 'init');
  const call = pick(value => value.type === 'assistant' && value.message?.content?.[0]?.type === 'tool_use');
  const result = pick(value => value.type === 'user' && value.message?.content?.[0]?.type === 'tool_result');
  const text = pick(value => value.type === 'assistant' && value.message?.content?.[0]?.type === 'text');
  const end = pick(value => value.type === 'result');
  const id = 'toolu_smoke_hydra_head';
  return [
    user, init,
    edit(call, value => { value.message.content = [{ type: 'tool_use', id, name: `mcp__hydra__${smokeHeadCall.tool}`, input: smokeHeadCall.arguments }]; }),
    { dir: 'call', ...smokeHeadCall },
    edit(result, value => { value.message.content = [{ tool_use_id: id, type: 'tool_result', content: [{ type: 'text', text: '__HYDRA_RESULT__' }], is_error: false }]; delete value.tool_use_result; }),
    edit(text, value => { value.message.content = [{ type: 'text', text: 'Started a Hydra head for that.' }]; }),
    end,
  ];
}

export function composeClaudeSmoke(fixtures, out) {
  const approvals = part(records(path.join(fixtures, 'approvals-route-a.jsonl')), 0);
  const interrupt = part(records(path.join(fixtures, 'interrupt.jsonl')), 0);
  const resume = part(records(path.join(fixtures, 'kill-resume.jsonl')), 1);
  const lines = [
    { fixture: 'hydra-app-protocol/v1', provider: 'claude', scenario: 'app-smoke (composed from G1 recordings)' },
    approvals.args, ...opening(approvals.records), ...turn(approvals.records, 0), ...turn(approvals.records, 1), ...turn(interrupt.records, 1),
    resume.args, ...resume.records,
    approvals.args, ...opening(approvals.records), ...hydraHeadTurn(turn(approvals.records, 0)),
  ];
  fs.writeFileSync(out, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  return out;
}

/** Codex records: split into processes at each initialize the host sent. */
function codexProcesses(all) {
  const out = [];
  for (const record of all) {
    if (record.dir === 'send' && message(record).method === 'initialize') out.push([]);
    if (out.length && (record.dir === 'send' || record.dir === 'recv')) out.at(-1).push(record);
  }
  return out;
}
/** The n-th Codex turn: from the n-th turn/start the host sent up to the next one. */
function codexTurn(records, n) {
  const starts = records.map((record, index) => (record.dir === 'send' && message(record).method === 'turn/start' ? index : -1)).filter(index => index >= 0);
  return records.slice(starts[n], n + 1 < starts.length ? starts[n + 1] : records.length);
}
const codexOpening = records => records.slice(0, records.findIndex(record => record.dir === 'send' && message(record).method === 'turn/start'));
/** Thread ids a recording used (from thread/start and thread/resume). */
function threadIds(records) {
  const ids = new Set();
  for (const record of records) {
    const m = message(record);
    if (m.result?.thread?.id) ids.add(m.result.thread.id);
    if (m.method === 'thread/resume' && m.params?.threadId) ids.add(m.params.threadId);
  }
  return [...ids];
}

export function composeCodexSmoke(fixtures, out) {
  const approvals = codexProcesses(records(path.join(fixtures, 'command-approval.jsonl')))[0];
  const interrupt = codexProcesses(records(path.join(fixtures, 'interrupt.jsonl')))[0];
  const resumed = codexProcesses(records(path.join(fixtures, 'resume-after-restart.jsonl')))[1];
  const thread = threadIds(approvals)[0];
  const unify = list => {
    const others = [...threadIds(interrupt), ...threadIds(resumed), ...threadIds(records(path.join(fixtures, 'resume-after-restart.jsonl')))].filter(id => id !== thread);
    return list.map(record => (record.line ? { ...record, line: others.reduce((line, id) => line.split(id).join(thread), record.line) } : record));
  };
  const lines = [
    { fixture: 'hydra-app-protocol/v1', provider: 'codex', scenario: 'app-smoke (composed from G1 recordings)' },
    ...unify([...codexOpening(approvals), ...codexTurn(approvals, 0), ...codexTurn(approvals, 1), ...codexTurn(interrupt, 0)]),
    ...unify(resumed),
  ];
  fs.writeFileSync(out, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  return out;
}
