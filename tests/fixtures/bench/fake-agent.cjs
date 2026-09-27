// A stand-in for a single agent in tests/benchmark.test.ts: reads the task from stdin, changes nothing, and reports
// the way `claude -p --output-format json` does.
'use strict';
let task = '';
process.stdin.on('data', chunk => { task += chunk; });
process.stdin.on('end', () => process.stdout.write(JSON.stringify({ type: 'result', total_cost_usd: 1.5, num_turns: 12, result: task.includes('discount') ? 'read the task' : 'no task' })));
