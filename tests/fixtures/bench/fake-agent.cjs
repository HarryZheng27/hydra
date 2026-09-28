// A stand-in for a single agent in tests/benchmark.test.ts: reads the task from stdin, keeps a copy of it beside the
// repository (fake-agent-task.md in the run folder), changes nothing, and reports the way
// `claude -p --output-format json` does.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
let task = '';
process.stdin.on('data', chunk => { task += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(process.cwd(), '..', 'fake-agent-task.md'), task);
  fs.writeFileSync(path.join(process.cwd(), '..', 'fake-agent-args.json'), JSON.stringify(process.argv.slice(2)));
  process.stdout.write(JSON.stringify({ type: 'result', total_cost_usd: 1.5, num_turns: 12, result: task.includes('discount') ? 'read the task' : 'no task' }));
});
