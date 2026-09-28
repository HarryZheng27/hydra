// A stand-in for the Codex reviewer in tests/benchmark.test.ts (benchmark.mjs review --reviewer-command): it reads
// the review prompt on stdin, keeps a copy beside itself in the current folder's parent, and answers as `codex exec
// --json` does, with a verdict: "pass" by default, or "fail" with a major finding when its first argument is "fail".
'use strict';
const fs = require('node:fs');
const path = require('node:path');
let prompt = '';
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(process.cwd(), '..', 'fake-reviewer-prompt.md'), prompt);
  const fail = process.argv[2] === 'fail';
  const verdict = fail
    ? { verdict: 'fail', summary: 'The total ignores the discount.', findings: [{ file: 'src/total.js', line: 3, severity: 'major', note: 'The discount is never applied.' }, { severity: 'minor', note: 'A name could be clearer.' }] }
    : { verdict: 'pass', summary: 'It does what the task asks.', findings: [] };
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't' }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: JSON.stringify(verdict) } }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }) + '\n');
});
