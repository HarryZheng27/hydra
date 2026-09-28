import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendAmendment, appendBoardPost, applyPlanAmendment, boardForJob, boardForLead, buildPlanReport, findPlanByIdempotencyKey, planFromLeadInput, refuseOverBudget, refuseScopeOverlap, validatePlan, writeScopeOverlap,
  type BoardPost, type Plan, type PlanAmendment, type PlanJob, type PlanLeadJobInput, type PlanReportJobDetail,
} from '../src/core/plans';

const leadJob = (key: string, extra: Partial<PlanLeadJobInput> = {}): PlanLeadJobInput => ({
  key, title: `Job ${key}`, brief: `Do ${key}.`, write_scope: [`src/${key}/`], ...extra,
});
const origin = { leadSessionId: 'session-1', idempotencyKey: 'key-1' };

test('planFromLeadInput: builds a valid draft plan of head jobs from hydra_plan_create arguments', () => {
  const plan = planFromLeadInput({ title: 'Checkout refactor', brief: 'Split the checkout work.', jobs: [leadJob('schema'), leadJob('api', { depends_on: ['schema'] })] }, origin);
  assert.equal(plan.title, 'Checkout refactor');
  assert.equal(plan.brief, 'Split the checkout work.');
  assert.equal(plan.state, 'draft');
  assert.equal(plan.jobs.length, 2);
  assert.equal(plan.jobs[0]!.runAs, 'head');
  assert.deepEqual(plan.jobs[1]!.dependsOn, ['schema']);
  assert.deepEqual(plan.jobs[0]!.writeScope, ['src/schema/']);
  assert.deepEqual(plan.leadOrigin, origin);
  assert.doesNotThrow(() => validatePlan(plan));
});

test('planFromLeadInput: needs at least one job, and each job needs a non-empty write_scope', () => {
  assert.throws(() => planFromLeadInput({ title: 'Empty', jobs: [] }, origin), /at least one job/);
  assert.throws(() => planFromLeadInput({ title: 'No scope', jobs: [leadJob('a', { write_scope: [] })] }, origin), /needs a write_scope/);
});

test('planFromLeadInput: refuses more than 12 jobs, duplicate keys, an unknown dependency, and a cycle', () => {
  assert.throws(() => planFromLeadInput({ title: 'Too many', jobs: Array.from({ length: 13 }, (_, i) => leadJob(`k${i}`)) }, origin), /at most 12 jobs/);
  assert.throws(() => planFromLeadInput({ title: 'Dup', jobs: [leadJob('a'), leadJob('a')] }, origin), /Duplicate job key/);
  assert.throws(() => planFromLeadInput({ title: 'Unknown dep', jobs: [leadJob('a', { depends_on: ['nope'] })] }, origin), /depends on unknown job/);
  assert.throws(() => planFromLeadInput({ title: 'Cycle', jobs: [leadJob('a', { depends_on: ['b'] }), leadJob('b', { depends_on: ['a'] })] }, origin), /dependency cycle/);
});

test('planFromLeadInput: passes through provider and role, and records leadOrigin for idempotency', () => {
  const plan = planFromLeadInput({ title: 'Roled', jobs: [leadJob('a', { provider: 'codex', role: 'coding/builder' })] }, origin);
  assert.equal(plan.jobs[0]!.provider, 'codex');
  assert.equal(plan.jobs[0]!.role, 'coding/builder');
});

test('planFromLeadInput (O6): a job defaults to "standard" rigor; an explicit rigor is kept; an unknown one is refused', () => {
  const defaulted = planFromLeadInput({ title: 'X', jobs: [leadJob('a')] }, origin);
  assert.equal(defaulted.jobs[0]!.rigor, 'standard');
  const quick = planFromLeadInput({ title: 'X', jobs: [leadJob('a', { rigor: 'quick' })] }, origin);
  assert.equal(quick.jobs[0]!.rigor, 'quick');
  assert.throws(() => planFromLeadInput({ title: 'X', jobs: [leadJob('a', { rigor: 'thorough' as never })] }, origin), /unknown rigor/);
});

test('validatePlan: refuses a malformed leadOrigin', () => {
  const plan: Plan = { ...planFromLeadInput({ title: 'Bad origin', jobs: [leadJob('a')] }, origin), leadOrigin: { leadSessionId: '', idempotencyKey: 'x' } };
  assert.throws(() => validatePlan(plan), /Invalid leadOrigin/);
});

test('findPlanByIdempotencyKey: matches only the same lead session and key; a canvas-drafted plan (no leadOrigin) never matches', () => {
  const a = planFromLeadInput({ title: 'A', jobs: [leadJob('a')] }, { leadSessionId: 'lead-1', idempotencyKey: 'k1' });
  const b = planFromLeadInput({ title: 'B', jobs: [leadJob('a')] }, { leadSessionId: 'lead-2', idempotencyKey: 'k1' });
  const canvasPlan: Plan = { ...planFromLeadInput({ title: 'Canvas', jobs: [leadJob('a')] }, { leadSessionId: 'x', idempotencyKey: 'y' }) };
  delete (canvasPlan as { leadOrigin?: unknown }).leadOrigin;
  const plans = [a, b, canvasPlan];
  assert.equal(findPlanByIdempotencyKey(plans, 'lead-1', 'k1'), a);
  assert.equal(findPlanByIdempotencyKey(plans, 'lead-2', 'k1'), b);
  assert.equal(findPlanByIdempotencyKey(plans, 'lead-1', 'k2'), undefined);
  assert.equal(findPlanByIdempotencyKey(plans, 'lead-3', 'k1'), undefined);
});

// ---- O2: scope contracts (docs/Heads.md, "Coordination") ----

test('writeScopeOverlap: exact paths, a folder and a file under it, and disjoint paths', () => {
  assert.equal(writeScopeOverlap(['src/api.ts'], ['src/api.ts']), 'src/api.ts');
  assert.equal(writeScopeOverlap(['src/parser/'], ['src/parser/lexer.ts']), 'src/parser/');
  assert.equal(writeScopeOverlap(['src/parser/lexer.ts'], ['src/parser/']), 'src/parser/');
  assert.equal(writeScopeOverlap(['src/parser'], ['src/parser/lexer.ts']), 'src/parser', 'a trailing slash makes no difference, like inScope');
  assert.equal(writeScopeOverlap(['src/api/'], ['src/apiary/']), undefined, 'a sibling that merely shares a prefix string is not inside it');
  assert.equal(writeScopeOverlap(['src/api/'], ['src/web/']), undefined);
});

test('writeScopeOverlap: the whole repository ("." or "") overlaps everything; comparison ignores case and backslashes', () => {
  assert.equal(writeScopeOverlap(['.'], ['src/anything.ts']), '.');
  assert.equal(writeScopeOverlap([''], ['src/anything.ts']), '.', 'an empty entry reads the same as "." — never a blank string');
  assert.equal(writeScopeOverlap(['src/Api.ts'], ['src/api.ts']), 'src/Api.ts');
  assert.equal(writeScopeOverlap(['src\\api\\'], ['src/api/lexer.ts']), 'src\\api\\');
});

test('refuseScopeOverlap: refuses two independent jobs that share a path, naming both jobs and the path', () => {
  const jobs: PlanJob[] = [
    { key: 'schema', title: 'Schema', brief: 'x', dependsOn: [], writeScope: ['src/schema/'] },
    { key: 'other', title: 'Other', brief: 'x', dependsOn: [], writeScope: ['src/schema/migrations.ts'] },
  ];
  assert.throws(() => refuseScopeOverlap(jobs), /Job "schema" and job "other" both change src\/schema\/.*neither depends on the other/);
});

test('refuseScopeOverlap: a dependency (direct or transitive, in either direction) excuses the same overlap', () => {
  const a: PlanJob = { key: 'a', title: 'A', brief: 'x', dependsOn: [], writeScope: ['src/shared/'] };
  const b: PlanJob = { key: 'b', title: 'B', brief: 'x', dependsOn: [], writeScope: ['src/shared/util.ts'] };
  assert.doesNotThrow(() => refuseScopeOverlap([a, { ...b, dependsOn: ['a'] }]), 'b depends on a directly');
  const c: PlanJob = { key: 'c', title: 'C', brief: 'x', dependsOn: ['a'] };
  assert.doesNotThrow(() => refuseScopeOverlap([a, c, { ...b, dependsOn: ['c'] }]), 'b depends on a transitively, through c');
  assert.doesNotThrow(() => refuseScopeOverlap([{ ...a, dependsOn: ['b'] }, b]), 'the other direction: a depends on b');
});

test('refuseScopeOverlap: skips a pair where either job has no write_scope (canvas-drafted jobs)', () => {
  const jobs: PlanJob[] = [
    { key: 'a', title: 'A', brief: 'x', dependsOn: [], writeScope: ['src/shared/'] },
    { key: 'b', title: 'B', brief: 'x', dependsOn: [] }, // no writeScope: unknown footprint, not checked
  ];
  assert.doesNotThrow(() => refuseScopeOverlap(jobs));
});

test('planFromLeadInput: refuses independent jobs with overlapping write_scope', () => {
  assert.throws(
    () => planFromLeadInput({ title: 'Overlap', jobs: [leadJob('a', { write_scope: ['src/shared/'] }), leadJob('b', { write_scope: ['src/shared/util.ts'] })] }, origin),
    /Job "a" and job "b" both change src\/shared\//,
  );
  // A dependency between them excuses it.
  assert.doesNotThrow(() => planFromLeadInput({ title: 'No overlap once dependent', jobs: [leadJob('a', { write_scope: ['src/shared/'] }), leadJob('b', { write_scope: ['src/shared/util.ts'], depends_on: ['a'] })] }, origin));
});

// ---- O4: the plan board (docs/Heads.md, "The plan board") ----

test('appendBoardPost: appends with a fresh id and time, and drops the oldest once boardPostsMax is passed', () => {
  const now = () => new Date('2026-09-27T12:00:00.000Z');
  const board = appendBoardPost(undefined, { from: { kind: 'lead' }, to: 'all', body: 'Hello' }, now);
  assert.equal(board.length, 1);
  assert.match(board[0]!.id, /^[a-f0-9]{12}$/);
  assert.equal(board[0]!.at, '2026-09-27T12:00:00.000Z');
  assert.equal(board[0]!.body, 'Hello');
  let grown: BoardPost[] | undefined;
  for (let i = 0; i < 505; i++) grown = appendBoardPost(grown, { from: { kind: 'lead' }, to: 'all', body: `Post ${i}` }, now);
  assert.equal(grown!.length, 500, 'the board never grows past boardPostsMax');
  assert.equal(grown![0]!.body, 'Post 5', 'the oldest posts drop off first');
  assert.equal(grown![499]!.body, 'Post 504');
});

test('boardForJob: a job sees posts addressed to it, to "all", and its own; everything but its own is untrusted', () => {
  const board: BoardPost[] = [
    { id: 'a'.repeat(12), at: '2026-09-27T12:00:00.000Z', from: { kind: 'lead' }, to: 'all', body: 'To everyone' },
    { id: 'b'.repeat(12), at: '2026-09-27T12:00:01.000Z', from: { kind: 'lead' }, to: ['schema'], body: 'To schema only' },
    { id: 'c'.repeat(12), at: '2026-09-27T12:00:02.000Z', from: { kind: 'lead' }, to: ['api'], body: 'To api only' },
    { id: 'd'.repeat(12), at: '2026-09-27T12:00:03.000Z', from: { kind: 'job', key: 'schema' }, to: 'all', body: 'From schema' },
  ];
  const forSchema = boardForJob(board, 'schema');
  assert.deepEqual(forSchema.map(post => post.body), ['To everyone', 'To schema only', 'From schema']);
  assert.deepEqual(forSchema.map(post => post.untrusted), [true, true, false], 'everything but its own post is untrusted');
  assert.deepEqual(boardForJob(board, 'api').map(post => post.body), ['To everyone', 'To api only', 'From schema'], '"From schema" was addressed to \'all\', so api sees it too');
  assert.deepEqual(boardForJob(undefined, 'schema'), [], 'no board yet: an empty list, not an error');
});

test('boardForLead: sees every post; a job\'s is untrusted, the lead\'s own isn\'t', () => {
  const board: BoardPost[] = [
    { id: 'a'.repeat(12), at: '2026-09-27T12:00:00.000Z', from: { kind: 'lead' }, to: 'all', body: 'From the lead' },
    { id: 'b'.repeat(12), at: '2026-09-27T12:00:01.000Z', from: { kind: 'job', key: 'schema' }, to: 'all', body: 'From schema' },
  ];
  const seen = boardForLead(board);
  assert.deepEqual(seen.map(post => post.untrusted), [false, true]);
});

test('validatePlan: refuses a board post addressed to an unknown job key, over the topic/body length limits, or with an invalid from', () => {
  const base = createBoardPlan();
  const withBoard = (board: unknown): Plan => ({ ...base, board: board as BoardPost[] });
  assert.throws(() => validatePlan(withBoard([{ id: 'a'.repeat(12), at: new Date().toISOString(), from: { kind: 'lead' }, to: ['nope'], body: 'x' }])), /"all" or this plan's job keys/);
  assert.throws(() => validatePlan(withBoard([{ id: 'a'.repeat(12), at: new Date().toISOString(), from: { kind: 'lead' }, to: 'all', body: 'x'.repeat(2001) }])), /body must be 1-2000/);
  assert.throws(() => validatePlan(withBoard([{ id: 'a'.repeat(12), at: new Date().toISOString(), from: { kind: 'lead' }, to: 'all', topic: 'x'.repeat(201), body: 'x' }])), /topic must be at most 200/);
  assert.throws(() => validatePlan(withBoard([{ id: 'a'.repeat(12), at: new Date().toISOString(), from: { kind: 'job', key: 'nope!' }, to: 'all', body: 'x' }])), /from\.key is invalid/);
  assert.doesNotThrow(() => validatePlan(withBoard([{ id: 'a'.repeat(12), at: new Date().toISOString(), from: { kind: 'lead' }, to: 'all', body: 'ok' }])));
});

function createBoardPlan(): Plan {
  return planFromLeadInput({ title: 'Board plan', jobs: [leadJob('a')] }, { leadSessionId: 'x', idempotencyKey: 'y' });
}

// ---- O5: plans that adapt (docs/Heads.md, "Plans that adapt") ----

test('appendAmendment: appends one entry with a fresh time', () => {
  const now = () => new Date('2026-09-27T12:00:00.000Z');
  const history = appendAmendment(undefined, { kind: 'skip', key: 'a', detail: 'Skipped: not needed.' }, now);
  assert.deepEqual(history, [{ at: '2026-09-27T12:00:00.000Z', kind: 'skip', key: 'a', detail: 'Skipped: not needed.' }]);
  const grown = appendAmendment(history, { kind: 'add', key: 'b', detail: 'Added.' }, now);
  assert.equal(grown.length, 2);
});

const failedJob = (key: string, extra: Partial<PlanJob> = {}): PlanJob => ({
  key, title: `Job ${key}`, brief: `Do ${key}.`, dependsOn: [], writeScope: [`src/${key}/`], attempt: 1,
  outcome: { state: 'failed', reason: 'Gates failed 3 times.', at: '2026-09-27T11:00:00.000Z' }, ...extra,
});

test('applyPlanAmendment: retry clears the outcome and bumps the attempt, only for a job that failed', () => {
  const jobs = [failedJob('a')];
  const result = applyPlanAmendment({ jobs }, { retry: [{ key: 'a' }] });
  assert.equal(result.jobs[0]!.outcome, undefined);
  assert.equal(result.jobs[0]!.attempt, 2);
  assert.equal(result.amendments[0]!.kind, 'retry');
  assert.match(result.amendments[0]!.detail, /attempt 2/);

  assert.throws(() => applyPlanAmendment({ jobs: [{ key: 'a', title: 'A', brief: 'x', dependsOn: [] }] }, { retry: [{ key: 'a' }] }), /is not started, so there's nothing to retry/);
  assert.throws(() => applyPlanAmendment({ jobs: [{ key: 'a', title: 'A', brief: 'x', dependsOn: [], outcome: { state: 'cancelled', reason: 'x', at: '2026-09-27T11:00:00.000Z' } }] }, { retry: [{ key: 'a' }] }), /is cancelled, so there's nothing to retry/);
});

test('applyPlanAmendment: retry also un-skips a job the lead skipped, or one skipped automatically because its dependency failed', () => {
  const autoSkipped: PlanJob = { key: 'c', title: 'C', brief: 'x', dependsOn: ['b'], outcome: { state: 'skipped', reason: 'B did not finish.', at: '2026-09-27T11:00:00.000Z' } };
  const result = applyPlanAmendment({ jobs: [failedJob('b'), autoSkipped] }, { retry: [{ key: 'b' }, { key: 'c' }] });
  assert.equal(result.jobs.find(job => job.key === 'b')!.outcome, undefined);
  assert.equal(result.jobs.find(job => job.key === 'c')!.outcome, undefined);
  assert.deepEqual(result.amendments.map(entry => entry.kind), ['retry', 'retry']);
});

test('applyPlanAmendment: a retry can change the write_scope, brief, title or provider, and still re-checks scope overlap', () => {
  const jobs = [failedJob('a'), { key: 'b', title: 'B', brief: 'x', dependsOn: [], writeScope: ['src/b/'] }];
  // a and b are independent; widening a's scope onto b's is refused, exactly like hydra_plan_create would.
  assert.throws(() => applyPlanAmendment({ jobs }, { retry: [{ key: 'a', write_scope: ['src/b/'] }] }), /both change src\/b\//);
  const ok = applyPlanAmendment({ jobs }, { retry: [{ key: 'a', write_scope: ['src/a2/'], brief: 'Try harder.', provider: 'codex' }] });
  assert.deepEqual(ok.jobs[0]!.writeScope, ['src/a2/']);
  assert.equal(ok.jobs[0]!.brief, 'Try harder.');
  assert.equal(ok.jobs[0]!.provider, 'codex');
});

test('applyPlanAmendment: skip, edit and add each record one amendment, and re-validate the whole plan', () => {
  const jobs = [
    { key: 'a', title: 'A', brief: 'x', dependsOn: [], writeScope: ['src/a/'] },
    { key: 'b', title: 'B', brief: 'x', dependsOn: [], writeScope: ['src/b/'] },
  ];
  const result = applyPlanAmendment({ jobs }, {
    skip: [{ key: 'b', reason: 'Not needed.' }],
    edit: [{ key: 'a', title: 'A (renamed)' }],
    add: [{ key: 'c', title: 'C', brief: 'x', write_scope: ['src/c/'], depends_on: ['a'] }],
  });
  assert.equal(result.jobs.find(job => job.key === 'a')!.title, 'A (renamed)');
  assert.equal(result.jobs.find(job => job.key === 'b')!.outcome!.state, 'skipped');
  assert.ok(result.jobs.some(job => job.key === 'c'));
  assert.deepEqual(result.amendments.map(entry => entry.kind), ['skip', 'edit', 'add']);
  assert.equal(result.jobs.find(job => job.key === 'c')!.rigor, 'standard', 'a job added by amend defaults to standard rigor too');
});

test('applyPlanAmendment (O6): edit and retry can change a job\'s rigor', () => {
  const jobs = [{ key: 'a', title: 'A', brief: 'x', dependsOn: [], rigor: 'standard' as const }];
  const edited = applyPlanAmendment({ jobs }, { edit: [{ key: 'a', rigor: 'strict' }] });
  assert.equal(edited.jobs[0]!.rigor, 'strict');
  const retried = applyPlanAmendment({ jobs: [failedJob('b')] }, { retry: [{ key: 'b', rigor: 'strict' }] });
  assert.equal(retried.jobs[0]!.rigor, 'strict');
});

test('applyPlanAmendment: refuses an edit or a skip on a job that has already started', () => {
  const started: PlanJob = { key: 'a', title: 'A', brief: 'x', dependsOn: [], jobId: 'a'.repeat(12) };
  assert.throws(() => applyPlanAmendment({ jobs: [started] }, { skip: [{ key: 'a', reason: 'x' }] }), /already started, so it can't be skipped/);
  assert.throws(() => applyPlanAmendment({ jobs: [started] }, { edit: [{ key: 'a', title: 'New' }] }), /already started, so it can't be edited/);
});

test('applyPlanAmendment: refuses a cycle or a duplicate key from add, exactly like planFromLeadInput', () => {
  const jobs = [{ key: 'a', title: 'A', brief: 'x', dependsOn: [] }];
  assert.throws(() => applyPlanAmendment({ jobs }, { add: [{ key: 'a', title: 'Dup', brief: 'x', write_scope: ['src/'] }] }), /already used/);
  const withB = [...jobs, { key: 'b', title: 'B', brief: 'x', dependsOn: ['a'] }];
  assert.throws(() => applyPlanAmendment({ jobs: withB }, { edit: [{ key: 'a', depends_on: ['b'] }] }), /dependency cycle/);
});

test('applyPlanAmendment: throws for the whole call when any part of it is invalid, even after an earlier part (retry, processed first) would have succeeded', () => {
  const jobs = [failedJob('a'), { key: 'b', title: 'B', brief: 'x', dependsOn: [] }];
  // The caller only persists what applyPlanAmendment returns; since it throws, nothing from
  // the retry that ran first is ever written back to the plan.
  assert.throws(() => applyPlanAmendment({ jobs }, { retry: [{ key: 'a' }], add: [{ key: 'a', title: 'Dup', brief: 'x', write_scope: ['src/'] }] }), /already used/);
});

// ---- O7: unattended plans and the morning report (docs/Heads.md, "Unattended plans") ----

test('planFromLeadInput (O7): run "unattended" needs a budget, and validates each dimension', () => {
  const jobs = [leadJob('a')];
  assert.throws(() => planFromLeadInput({ title: 'No budget', jobs, run: 'unattended' }, origin), /needs at least one of usd, wall_clock_minutes or max_jobs/);
  assert.throws(() => planFromLeadInput({ title: 'Bad usd', jobs, run: 'unattended', budget: { usd: -1 } }, origin), /budget.usd must be a positive number/);
  assert.throws(() => planFromLeadInput({ title: 'Bad minutes', jobs, run: 'unattended', budget: { wall_clock_minutes: 0 } }, origin), /wallClockMinutes must be 1 to 10080/);
  assert.throws(() => planFromLeadInput({ title: 'Bad jobs', jobs, run: 'unattended', budget: { max_jobs: 0 } }, origin), /maxJobs must be 1-/);
  const plan = planFromLeadInput({ title: 'Fine', jobs, run: 'unattended', budget: { usd: 20, wall_clock_minutes: 60, max_jobs: 5 } }, origin);
  assert.deepEqual(plan.unattended, { usd: 20, wallClockMinutes: 60, maxJobs: 5 });
  assert.doesNotThrow(() => validatePlan(plan));
});

test('planFromLeadInput (O7): without run: "unattended", a budget is ignored and the plan is an ordinary attended one', () => {
  const plan = planFromLeadInput({ title: 'Attended', jobs: [leadJob('a')], budget: { usd: 1 } }, origin);
  assert.equal(plan.unattended, undefined);
});

test('refuseOverBudget (O7): a job count over max_jobs is refused outright, regardless of dollars', () => {
  assert.throws(() => refuseOverBudget({ maxJobs: 2 }, 3, 5), /allows at most 2 jobs; it would have 3/);
  assert.doesNotThrow(() => refuseOverBudget({ maxJobs: 3 }, 3, 5));
});

test('refuseOverBudget (O7): a worst-case dollar estimate (job count × the default per-head budget) over budget.usd is refused', () => {
  assert.throws(() => refuseOverBudget({ usd: 10 }, 3, 5), /could reach \$15/);
  assert.doesNotThrow(() => refuseOverBudget({ usd: 15 }, 3, 5));
});

test('planFromLeadInput (O7): an unattended plan is refused up front when its own job count already exceeds its budget', () => {
  const jobs = [leadJob('a'), leadJob('b'), leadJob('c')];
  assert.throws(() => planFromLeadInput({ title: 'Too many', jobs, run: 'unattended', budget: { max_jobs: 2 } }, origin), /allows at most 2 jobs/);
  assert.throws(() => planFromLeadInput({ title: 'Too pricey', jobs, run: 'unattended', budget: { usd: 1 } }, origin), /could reach/);
});

test('applyPlanAmendment (O7): re-enforces an unattended plan\'s budget after adding jobs', () => {
  const jobs = [{ key: 'a', title: 'A', brief: 'x', dependsOn: [] }];
  const unattended = { maxJobs: 1 };
  assert.throws(
    () => applyPlanAmendment({ jobs, unattended }, { add: [{ key: 'b', title: 'B', brief: 'x', write_scope: ['src/b/'] }] }),
    /allows at most 1 job/,
  );
  // Skipping or editing (no new job) never grows the count, so it's unaffected by the same cap.
  assert.doesNotThrow(() => applyPlanAmendment({ jobs, unattended }, { edit: [{ key: 'a', title: 'A2' }] }));
});

test('validatePlan (O7): an unattended plan takes heads only — a lane job is refused', () => {
  const attended = { version: 1, id: 'a'.repeat(12), title: 'P', state: 'draft', jobs: [{ key: 'a', title: 'A', brief: 'x', dependsOn: [], runAs: 'lane' }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as unknown as Plan;
  assert.doesNotThrow(() => validatePlan(attended));
  const unattended: Plan = { ...attended, unattended: { maxJobs: 5 } };
  assert.throws(() => validatePlan(unattended), /takes heads only.*runs as a lane/);
});

test('buildPlanReport (O7): a snapshot of the morning report\'s shape for a mixed-outcome plan', () => {
  const plan: Plan = {
    id: 'p'.repeat(12), title: 'Nightly cleanup', state: 'incomplete',
    unattended: { usd: 20, wallClockMinutes: 120, maxJobs: 3 }, startedAt: '2026-01-01T00:00:00.000Z',
    jobs: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    amendments: [{ at: '2026-01-01T00:10:00.000Z', kind: 'retry', key: 'lint', detail: 'Retried: lint' }],
  } as unknown as Plan;
  const details: PlanReportJobDetail[] = [
    {
      key: 'build', title: 'Build the API', status: 'done', provider: 'claude', attempts: 1,
      startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:20:00.000Z',
      summary: 'Added the /orders endpoint.', changedFiles: ['src/orders.ts'],
      checks: [{ id: 'unit', required: true, passed: true }, { id: 'review', required: true, passed: true, summary: 'Looks good.' }],
    },
    {
      key: 'lint', title: 'Fix lint', status: 'failed', provider: 'codex', priorProviders: ['claude'], attempts: 2,
      startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:05:00.000Z', reason: 'Usage limit reached twice.',
    },
  ];
  const report = buildPlanReport(plan, details, 5);
  assert.match(report, /^# Nightly cleanup$/m);
  assert.match(report, /Budget: \$20, 120 minute\(s\), 3 job\(s\) at once\./);
  assert.match(report, /## Build the API/);
  assert.match(report, /Provider: claude\./);
  assert.match(report, /Cost: not reported; budgeted up to \$5\./);
  assert.match(report, /Gates:\n- ✓ unit\n- ✓ review: Looks good\./);
  assert.match(report, /## Fix lint/);
  assert.match(report, /Provider: codex \(handed off from claude\)\./);
  assert.match(report, /## Amendments/);
  assert.match(report, /Retried: lint/);
  assert.match(report, /## Integration gate/);
  assert.match(report, /None: this plan started before Hydra landed plans on an integration branch/);
  assert.match(report, /## Needs you/);
  assert.match(report, /- Fix lint: Usage limit reached twice\./);
});

test('buildPlanReport (O3): the integration gate\'s real result, what landed, and what the plan needs from you next', () => {
  const sha = (fill: string) => fill.repeat(40);
  const check = (id: string, passed: boolean) => ({ id, kind: 'command' as const, state: passed ? 'passed' as const : 'failed' as const, required: true, passed, exitCode: passed ? 0 : 1, durationMs: 1, outputTail: '', summary: passed ? 'ok' : 'boom' });
  const landed = [
    { key: 'api', attempt: 0, commit: sha('b'), tip: sha('b'), via: 'fast-forward' as const, at: '2026-01-01T00:00:00.000Z' },
    { key: 'ui', attempt: 0, commit: sha('d'), tip: sha('c'), via: 'merge' as const, at: '2026-01-01T00:00:00.000Z' },
  ];
  const integration = { branch: 'hydra/plan-aaaaaaaaaaaa', base: sha('a'), target: 'main', tip: sha('c'), queue: [], landed };
  const plan = (gate: unknown) => ({ title: 'Checkout', state: 'done', unattended: { usd: 20 }, startedAt: '2026-01-01T00:00:00.000Z', amendments: [], integration: { ...integration, gate } }) as unknown as Plan;
  const at = '2026-01-01T00:00:00.000Z';

  const passed = buildPlanReport(plan({ tip: sha('c'), at, status: 'passed', checks: [check('unit', true)] }), []);
  assert.ok(passed.includes('## Integration gate\n\nPassed required gates.'), passed);
  assert.ok(passed.includes('Branch: hydra/plan-aaaaaaaaaaaa at ccccccc, from aaaaaaa on main.'));
  assert.ok(passed.includes('Landed: api, ui.'));
  assert.ok(passed.includes('- ✓ unit: ok'));
  assert.ok(passed.includes('## Needs you\n\n- Merging the plan: its combined work passed; **Merge plan** lands hydra/plan-aaaaaaaaaaaa on main.'));

  const failed = buildPlanReport(plan({ tip: sha('c'), at, failed: true, checks: [check('unit', false)] }), []);
  assert.ok(failed.includes('Integration gate failed.'));
  assert.ok(failed.includes('- ✗ unit: boom'));
  assert.ok(failed.includes('- The integration gate: Integration gate failed. Fix it and run the gate again, or merge anyway from the canvas.'));
  assert.ok(!failed.includes('Ready to merge'));

  const stale = buildPlanReport(plan({ tip: sha('b'), at, status: 'passed', checks: [check('unit', true)] }), []);
  assert.ok(stale.includes('Integration gate out of date'));
  assert.ok(!stale.includes('- ✓ unit'), 'a result for an older tip is not shown as this one\'s');
});

test('buildPlanReport (O9): each job\'s cost as its provider reported it, and the plan\'s total', () => {
  const plan = { title: 'Checkout', state: 'done', amendments: [] } as unknown as Plan;
  const report = buildPlanReport(plan, [
    { key: 'api', title: 'API', status: 'done', provider: 'claude', costUsd: 1.25 },
    { key: 'ui', title: 'UI', status: 'done', provider: 'codex', inputTokens: 1200, outputTokens: 300 },
    { key: 'docs', title: 'Docs', status: 'done', provider: 'claude' },
  ], 5);
  assert.ok(report.includes('Reported cost: $1.25 over 1 Claude Code job, 1200 input and 300 output tokens over 1 Codex job (1 more reported nothing).'), report);
  assert.ok(report.includes('Cost: $1.25 (as Claude Code reported it).'));
  assert.ok(report.includes('Cost: 1200 input and 300 output tokens (Codex reports tokens, not dollars).'));
  assert.ok(report.includes('Cost: not reported; budgeted up to $5.'));
});
