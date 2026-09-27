import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendBoardPost, boardForJob, boardForLead, findPlanByIdempotencyKey, planFromLeadInput, refuseScopeOverlap, validatePlan, writeScopeOverlap,
  type BoardPost, type Plan, type PlanJob, type PlanLeadJobInput,
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
