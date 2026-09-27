import test from 'node:test';
import assert from 'node:assert/strict';
import { findPlanByIdempotencyKey, planFromLeadInput, validatePlan, type Plan, type PlanLeadJobInput } from '../src/core/plans';

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
