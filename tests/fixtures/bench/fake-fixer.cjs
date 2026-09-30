// A stand-in for the single agent's fix round in tests/benchmarkFairness.test.ts (benchmark.mjs review --fix-command):
// it reads the fix brief on stdin, keeps it (and its arguments) in the current folder's parent as fake-fix-brief-<n>.md
// and fake-fix-args-<n>.json, changes a file in the repository the way a fix would, and answers as
// `claude -p --output-format json` does. "fail" as the first argument exits with an error instead.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
let brief = '';
process.stdin.on('data', chunk => { brief += chunk; });
process.stdin.on('end', () => {
  const parent = path.join(process.cwd(), '..');
  const counter = path.join(parent, 'fake-fixer-count');
  const number = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;
  fs.writeFileSync(counter, String(number));
  fs.writeFileSync(path.join(parent, `fake-fix-brief-${number}.md`), brief);
  fs.writeFileSync(path.join(parent, `fake-fix-args-${number}.json`), JSON.stringify(process.argv.slice(2)));
  if (process.argv[2] === 'fail') { process.stderr.write('not signed in'); process.exitCode = 1; return; }
  fs.appendFileSync(path.join(process.cwd(), 'total.js'), `// fix round ${number}\n`);
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.5, num_turns: 3, session_id: 'sess-1', result: 'fixed' }) + '\n');
});
