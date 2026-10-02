import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPlanReport, createPlan, planFromLeadInput, PlanStore, validatePlan, type Plan, type PlanJob, type PlanLeadJobInput } from '../src/core/plans';
import { planShape, singleHeadBrief, singleHeadDecision, singleHeadKey, singleHeadMaxAverageWidth, singleHeadOrder, singleHeadPlan } from '../src/core/planShape';
import { planHeadInput, PlanRunner } from '../src/core/planRunner';
import { maxBriefLength, parseJobInput } from '../src/core/jobs';

/** Small plans run as one head (docs/Heads.md, src/core/planShape.ts). */
const job = (key: string, extra: Partial<PlanJob> = {}): PlanJob => ({ key, title: `Job ${key}`, brief: `Do ${key}.`, runAs: 'head', dependsOn: [], writeScope: [`src/${key}.js`], rigor: 'standard', ...extra });
const plan = (jobs: PlanJob[], extra: Partial<Plan> = {}): Plan => ({ ...createPlan({ title: 'Checkout', brief: 'The whole checkout.' }), jobs, ...extra });

/** A benchmark fixture's plan, built the way `hydra plan run` builds it (planFromLeadInput). */
function fixturePlan(file: string): Plan {
  const source = JSON.parse(readFileSync(path.resolve('bench', file), 'utf8')) as { title: string; brief?: string; jobs: PlanLeadJobInput[] };
  return planFromLeadInput(source, { leadSessionId: 's', idempotencyKey: file });
}
const fixtures = {
  discounts: 'fixture/.hydra/plans/discounts.json',
  'shop-features': 'fixture/.hydra/plans/shop-features.json',
  'kanban-app': 'fixtures/kanban-app/.hydra/plans/kanban-app.json',
  'cli-toolkit': 'fixtures/cli-toolkit/.hydra/plans/cli-toolkit.json',
  'module-refactor': 'fixtures/module-refactor/.hydra/plans/module-refactor.json',
};

test('the benchmark plans: discounts runs as one head; kanban-app, cli-toolkit, shop-features and module-refactor run one head per job', () => {
  const shapes = Object.fromEntries(Object.entries(fixtures).map(([name, file]) => { const built = fixturePlan(file); return [name, { ...planShape(built.jobs), single: singleHeadDecision(built).single }]; }));
  assert.deepEqual(shapes, {
    discounts: { jobs: 6, depth: 3, widest: 3, averageWidth: 2, single: true },
    'shop-features': { jobs: 8, depth: 2, widest: 7, averageWidth: 4, single: false },
    'kanban-app': { jobs: 10, depth: 3, widest: 8, averageWidth: 10 / 3, single: false },
    'cli-toolkit': { jobs: 9, depth: 2, widest: 8, averageWidth: 4.5, single: false },
    'module-refactor': { jobs: 10, depth: 3, widest: 6, averageWidth: 10 / 3, single: false },
  });
  assert.match(singleHeadDecision(fixturePlan(fixtures.discounts)).reason, /^6 jobs in a dependency chain of 3, about 2\.0 at once on average \(under 2\.5\)/);
  assert.match(singleHeadDecision(fixturePlan(fixtures['kanban-app'])).reason, /^10 jobs in a dependency chain of 3, about 3\.3 at once on average \(2\.5 or more runs them apart\)$/);
});

test('the threshold: under 2.5 jobs at once on average runs as one head, 2.5 or more doesn\'t, and jobs that can all start at once never do', () => {
  assert.equal(singleHeadMaxAverageWidth, 2.5);
  const chainOf = (width: number, depth: number): PlanJob[] => {
    const jobs: PlanJob[] = [];
    for (let level = 0; level < depth; level++) for (let i = 0; i < width; i++) jobs.push(job(`l${level}-${i}`, { dependsOn: level ? [`l${level - 1}-0`] : [] }));
    return jobs;
  };
  // 4 jobs over 2 levels: 2.0; 5 over 2: 2.5 exactly; 2 independent jobs: 1 level.
  assert.equal(singleHeadDecision(plan(chainOf(2, 2))).single, true);
  const five = [...chainOf(2, 2), job('l1-2', { dependsOn: ['l0-0'] })];
  assert.deepEqual([planShape(five).averageWidth, singleHeadDecision(plan(five)).single], [2.5, false]);
  assert.deepEqual(singleHeadDecision(plan([job('a'), job('b')])), { single: false, reason: 'its 2 jobs can all run at once' });
  assert.equal(singleHeadDecision(plan([job('a'), job('b', { dependsOn: ['a'] })])).single, true, 'a chain of two');
  assert.deepEqual(singleHeadDecision(plan([job('a')])), { single: false, reason: 'it has one job' });
});

test('only a plan one head could do: no lanes, one provider, no roles, nothing started, briefs that fit', () => {
  const chain = (extra: Partial<PlanJob> = {}) => [job('a'), job('b', { dependsOn: ['a'], ...extra })];
  assert.equal(singleHeadDecision(plan(chain({ runAs: 'lane' }))).reason, 'it has lane jobs');
  assert.equal(singleHeadDecision(plan(chain(), { dispatch: { lanes: 2, provider: 'claude', attempts: 3 } })).reason, 'it has lane jobs');
  assert.equal(singleHeadDecision(plan(chain({ role: 'coding/builder' }))).reason, 'its jobs have pack roles');
  assert.equal(singleHeadDecision(plan(chain({ provider: 'codex' }))).reason, 'its jobs use different providers');
  assert.equal(singleHeadDecision(plan([job('a', { provider: 'codex' }), job('b', { dependsOn: ['a'], provider: 'codex' })])).single, true, 'the same provider on every job is fine');
  assert.equal(singleHeadDecision(plan(chain({ jobId: '0123456789ab' }))).reason, 'some of its jobs already ran');
  assert.equal(singleHeadDecision(plan(chain({ attempt: 1 }))).reason, 'some of its jobs already ran');
  const long = Array.from({ length: 10 }, (_, i) => job(`j${i}`, { dependsOn: i ? [`j${i - 1}`] : [], brief: 'x'.repeat(3990) }));
  assert.equal(singleHeadDecision(plan(long)).reason, 'its briefs together are too long for one head');
});

test('the one job: every write scope, the strictest rigor, the shared provider; the jobs as they were stay on the plan, which still validates', () => {
  const jobs = [job('core', { rigor: 'quick', provider: 'codex' }), job('api', { dependsOn: ['core'], writeScope: ['src/api.js', 'src/core.js'], provider: 'codex' }), job('ui', { dependsOn: ['core'], rigor: 'strict', provider: 'codex', draft: true }), job('docs', { dependsOn: ['api', 'ui'], writeScope: ['README.md'], provider: 'codex' })];
  const before = plan(jobs);
  const after = { ...before, ...singleHeadPlan(before, 'a reason') };
  assert.equal(after.jobs.length, 1);
  const whole = after.jobs[0]!;
  assert.deepEqual([whole.key, whole.title, whole.runAs, whole.dependsOn, whole.rigor, whole.provider], [singleHeadKey, 'All 4 jobs, as one head', 'head', [], 'strict', 'codex']);
  assert.deepEqual(whole.writeScope, ['src/core.js', 'src/api.js', 'src/ui.js', 'README.md']);
  assert.equal(whole.brief, 'Every job of this plan, done by one head in this order: core, api, ui, docs. Hydra gives the head each job\'s own brief when it starts.');
  assert.deepEqual(after.singleHead!.jobs.map(item => item.key), ['core', 'api', 'ui', 'docs']);
  assert.equal(after.singleHead!.jobs.find(item => item.key === 'ui')!.draft, undefined, 'a draft flag is released, as Run releases it');
  validatePlan(after);
  // A job with no write scope may change anything: so may the one head.
  assert.equal(singleHeadPlan(plan([job('a', { writeScope: undefined }), job('b', { dependsOn: ['a'] })]), 'r').jobs[0]!.writeScope, undefined);
  assert.throws(() => validatePlan({ ...after, singleHead: { reason: '', jobs: after.singleHead!.jobs } }), /Invalid singleHead/);
  assert.throws(() => validatePlan({ ...after, singleHead: { reason: 'r', jobs: [job('a')] } }), /Invalid singleHead/);
  // A board post written to an original job before the plan ran as one head still validates.
  validatePlan({ ...after, board: [{ id: 'abcdef012345', at: new Date().toISOString(), from: { kind: 'lead' }, to: ['api'], body: 'Use the v2 schema.' }] });
});

test('the head\'s brief: why, the plan\'s brief, then each job in dependency order (plan order within a level), with its files', () => {
  const jobs = [job('docs', { dependsOn: ['api', 'ui'], writeScope: ['README.md'] }), job('ui', { dependsOn: ['core'] }), job('core'), job('api', { dependsOn: ['core'] })];
  assert.deepEqual(singleHeadOrder(jobs).map(item => item.key), ['core', 'ui', 'api', 'docs']);
  const brief = singleHeadBrief({ title: 'Checkout', brief: 'The whole checkout.' }, jobs, 'a reason');
  assert.ok(brief.startsWith('Hydra runs plan "Checkout" as one head, you: a reason.\n'), brief);
  assert.ok(brief.includes('\n## The plan\n\nThe whole checkout.\n'), brief);
  assert.ok(brief.includes('## Part 1 of 4: Job core (`core`)\n\nFiles: src/core.js.\n\nDo core.'), brief);
  assert.ok(brief.includes('## Part 4 of 4: Job docs (`docs`)\n\nFiles: README.md. Builds on: api, ui.\n\nDo docs.'), brief);
  assert.ok(brief.indexOf('Part 2 of 4: Job ui') < brief.indexOf('Part 3 of 4: Job api'));
  // The discounts plan's head brief fits a head's brief, and the head's input parses like any head's.
  const discounts = fixturePlan(fixtures.discounts);
  const collapsed = { ...discounts, ...singleHeadPlan(discounts, singleHeadDecision(discounts).reason) };
  const input = planHeadInput(collapsed, collapsed.jobs[0]!, []);
  assert.ok((input.brief as string).length <= maxBriefLength);
  for (const original of discounts.jobs) assert.ok((input.brief as string).includes(original.brief.trim()), `${original.key}'s brief is in the head's`);
  assert.deepEqual(parseJobInput(input).writeScope, [...new Set(discounts.jobs.flatMap(item => item.writeScope!))]);
  // A plan that didn't run as one head: the job's own brief, as before.
  assert.equal(planHeadInput(discounts, discounts.jobs[0]!, []).brief, discounts.jobs[0]!.brief);
});

test('the report says the plan ran as one head, and why', () => {
  const report = buildPlanReport({ title: 'Discounts', state: 'done', singleHead: { reason: '6 jobs in a dependency chain of 3', jobs: [job('a'), job('b')] } }, []);
  assert.match(report, /^Ran as one head: 6 jobs in a dependency chain of 3\. Its jobs: a, b\.$/m);
  assert.doesNotMatch(buildPlanReport({ title: 'Discounts', state: 'done' }, []), /one head/);
});

async function runnerFixture(jobs: PlanJob[], singleHead: (() => boolean) | undefined) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-plan-shape-'));
  const store = new PlanStore(directory);
  await store.load();
  const saved = await store.save({ ...createPlan({ title: 'Discounts', brief: 'Add discounts.' }), jobs });
  const started: { key: string; brief: string }[] = [];
  const logs: string[] = [];
  let counter = 0;
  const runner = new PlanRunner({
    store, repository: directory,
    look: { head: () => ({ state: 'queued', title: 't' }), lane: () => undefined, planLanes: () => [], lanesAvailable: () => true },
    startHead: async (current, item, dependsOn) => { started.push({ key: item.key, brief: planHeadInput(current, item, dependsOn).brief as string }); return { jobId: (++counter).toString(16).padStart(12, '0') }; },
    startLane: async () => { throw new Error('no lanes'); },
    cancelHead: async () => undefined, unlinkLane: async () => undefined,
    commitSubjects: async () => [], changedFiles: async () => [],
    terminalsAvailable: () => true, debounceMs: 1, log: line => logs.push(line),
    ...(singleHead ? { singleHead } : {}),
  });
  return { store, plan: saved, started, logs, runner, close: async () => { runner.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

test('Run plan: a small chained plan starts one head with every job\'s brief and records why; off, or a wide plan, starts one per job', async () => {
  const chain = [job('discounts'), job('api', { dependsOn: ['discounts'] }), job('ui', { dependsOn: ['discounts'] }), job('docs', { dependsOn: ['api', 'ui'] })];
  const on = await runnerFixture(chain, () => true);
  try {
    await on.runner.run(on.plan.id);
    const stored = on.store.get(on.plan.id)!;
    assert.deepEqual(on.started.map(item => item.key), [singleHeadKey]);
    assert.ok(on.started[0]!.brief.includes('## Part 4 of 4: Job docs (`docs`)'), on.started[0]!.brief);
    assert.deepEqual(stored.jobs.map(item => item.key), [singleHeadKey]);
    assert.deepEqual(stored.singleHead!.jobs.map(item => item.key), ['discounts', 'api', 'ui', 'docs']);
    assert.match(stored.singleHead!.reason, /^4 jobs in a dependency chain of 3/);
    assert.ok(on.logs.some(line => line.startsWith('[plans] Plan Discounts runs as one head: 4 jobs')), on.logs.join('\n'));
    // Run again (after + Job, say) never reshapes a plan that already ran.
    await on.store.update(on.plan.id, current => ({ ...current, state: 'incomplete' }));
    await on.runner.run(on.plan.id).catch(() => undefined);
    assert.deepEqual(on.store.get(on.plan.id)!.jobs.map(item => item.key), [singleHeadKey]);
  } finally { await on.close(); }
  const off = await runnerFixture(chain, () => false);
  try {
    await off.runner.run(off.plan.id);
    assert.deepEqual(off.started.map(item => item.key), ['discounts', 'api', 'ui', 'docs']);
    assert.equal(off.store.get(off.plan.id)!.singleHead, undefined);
  } finally { await off.close(); }
  const unset = await runnerFixture(chain, undefined);
  try {
    await unset.runner.run(unset.plan.id);
    assert.equal(unset.started.length, 4, 'a runner without the option runs one head per job, as before');
  } finally { await unset.close(); }
  const wide = await runnerFixture([job('a'), job('b'), job('c'), job('d'), job('wire', { dependsOn: ['a', 'b', 'c', 'd'] })], () => true);
  try {
    await wide.runner.run(wide.plan.id);
    assert.equal(wide.started.length, 5);
    assert.ok(wide.logs.some(line => line.startsWith('[plans] Plan Discounts runs one head per job: 5 jobs in a dependency chain of 2')), wide.logs.join('\n'));
  } finally { await wide.close(); }
});
