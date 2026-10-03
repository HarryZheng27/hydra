// Builds the smoke's Claude stand-in session from real turns G1 recorded (tests/fixtures/app/claude/), so the app is
// driven through approve, deny, stop, restart and resume against Claude Code's own recorded protocol:
//   process 1: initialize, then approvals-route-a's Bash turn (allowed) and Write turn (denied), then interrupt's
//              mid-text turn (stopped);
//   process 2: kill-resume's resumed process (initialize, one turn).
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

export function composeClaudeSmoke(fixtures, out) {
  const approvals = part(records(path.join(fixtures, 'approvals-route-a.jsonl')), 0);
  const interrupt = part(records(path.join(fixtures, 'interrupt.jsonl')), 0);
  const resume = part(records(path.join(fixtures, 'kill-resume.jsonl')), 1);
  const lines = [
    { fixture: 'hydra-app-protocol/v1', provider: 'claude', scenario: 'app-smoke (composed from G1 recordings)' },
    approvals.args, ...opening(approvals.records), ...turn(approvals.records, 0), ...turn(approvals.records, 1), ...turn(interrupt.records, 1),
    resume.args, ...resume.records,
  ];
  fs.writeFileSync(out, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  return out;
}
