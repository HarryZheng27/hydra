// A stand-in for the Codex reviewer in tests/benchmarkHarness.test.ts (benchmark.mjs review --reviewer-command): it
// reads the review prompt on stdin, keeps a copy in the current folder's parent, and answers as `codex exec --json`
// does. Its first argument picks the answer: nothing for "pass"; "fail" for a failed review with a major finding;
// "limit" for Codex's usage-limit error; "crash" for exiting with an error.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
let prompt = '';
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(process.cwd(), '..', 'fake-reviewer-prompt.md'), prompt);
  const mode = process.argv[2];
  const say = value => process.stdout.write(JSON.stringify(value) + '\n');
  say({ type: 'thread.started', thread_id: 't' });
  if (mode === 'limit') { say({ type: 'error', message: "You've hit your usage limit. Try again later." }); process.exitCode = 1; return; }
  if (mode === 'crash') { process.stderr.write('something broke'); process.exitCode = 2; return; }
  // "fail-first" fails the first review it is asked for and passes every later one (a fix round worked); "fail-twice" fails two.
  let failing = mode === 'fail';
  if (mode === 'fail-first' || mode === 'fail-twice') {
    const counter = path.join(process.cwd(), '..', 'fake-reviewer-count');
    const seen = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
    fs.writeFileSync(counter, String(seen + 1));
    failing = seen < (mode === 'fail-twice' ? 2 : 1);
  }
  const verdict = failing
    ? { verdict: 'fail', summary: 'The total ignores the discount.', findings: [{ file: 'src/total.js', line: 3, severity: 'major', note: 'The discount is never applied.' }, { severity: 'minor', note: 'A name could be clearer.' }] }
    : { verdict: 'pass', summary: 'It does what the task asks.', findings: [] };
  say({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: JSON.stringify(verdict) } });
  say({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
});
