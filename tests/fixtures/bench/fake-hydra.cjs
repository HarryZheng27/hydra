// A stand-in for the `hydra` command in tests/benchmark.test.ts: it walks a plan through a run (a conflict predicted
// against the integration branch, one caught at landing, then done with the integration gate passed), one step per
// `plan show`, keeping its place in a file in the current folder.
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const stateFile = '.fake-hydra-step';
const step = fs.existsSync(stateFile) ? Number(fs.readFileSync(stateFile, 'utf8')) : 0;
const id = 'aaaaaaaa0001';
const head = (jobId, state, extra = {}) => ({ job_id: jobId, state, provider: 'claude', attempts: 1, ...extra });
const job = (key, status, headView) => ({ key, title: key, status, ...(headView ? { head: headView } : {}) });
const views = [
  { plan_id: id, title: 'Discount codes', state: 'running', jobs: [job('discounts', 'done', head('000000000001', 'done')), job('api', 'active', head('000000000002', 'running', { integration_conflict: { branch: 'hydra/plan-' + id, files: ['src/orders.js'] } }))], amendments: [] },
  { plan_id: id, title: 'Discount codes', state: 'running', jobs: [job('discounts', 'done', head('000000000001', 'done')), job('api', 'active', head('000000000002', 'done'))], amendments: [] },
  { plan_id: id, title: 'Discount codes', state: 'running', jobs: [job('discounts', 'done', head('000000000001', 'done')), job('api', 'active', head('000000000003', 'running'))], amendments: [] },
  {
    plan_id: id, title: 'Discount codes', state: 'done', amendments: [{ at: '2026-09-27T00:00:00.000Z', kind: 'retry', key: 'api', detail: 'Retried' }],
    jobs: [job('discounts', 'done', head('000000000001', 'done', { usage: { runs: 1, cost_usd: 0.5 } })), job('api', 'done', head('000000000003', 'done', { usage: { runs: 1, cost_usd: 0.75 } }))],
    integration: { branch: 'hydra/plan-' + id, landed: ['discounts', 'api'], queue: [], gate: { label: 'Passed required gates', checks: [{ id: 'test', state: 'passed' }] }, passed: true, settled: true, can_merge: true },
  },
];
const say = value => process.stdout.write(JSON.stringify(value));
const [first, second] = args;
if (first === 'status') say({ repository: process.cwd() });
else if (first === 'plan' && second === 'run') say({ ...views[0], created: true });
else if (first === 'plan' && second === 'show') { say(views[Math.min(step, views.length - 1)]); fs.writeFileSync(stateFile, String(step + 1)); }
else if (first === 'plan' && second === 'wait') say({ ...views[views.length - 1], passed: true, timed_out: false });
else if (first === 'report') process.stdout.write('# Discount codes\n\nUnattended plan, finished.\n');
else { process.stderr.write('unexpected: ' + args.join(' ')); process.exitCode = 2; }
