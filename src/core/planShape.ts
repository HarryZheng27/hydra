// Small plans run as one head (docs/Heads.md, "Small plans run as one head"). Each job of a plan costs a
// worktree, its own gates and a landing on the integration branch; on a small or tightly coupled plan that
// overhead buys no parallel work. Hydra notices that from the plan's shape when it first runs, and runs the
// whole plan as one head with every job's write scope, then the same integration gate and review.
import { maxBriefLength, type JobLimits } from './jobs';
import type { PlanRigor } from './gates/config';
import type { Plan, PlanJob } from './plans';

/** The key of the one job a plan run as one head has. */
export const singleHeadKey = 'whole-plan';
/**
 * A plan runs as one head when its jobs, on average, can't run more than this many at once: its job count over
 * the length of its longest dependency chain. The benchmark's discounts (6 jobs in a chain of 3: 2.0) falls under
 * it; kanban-app (10 over 3: 3.3), module-refactor (10 over 3: 3.3), shop-features (8 over 2: 4.0) and
 * cli-toolkit (9 over 2: 4.5) don't.
 */
export const singleHeadMaxAverageWidth = 2.5;
/** A head's write scope lists at most this many paths (parseWriteScope). */
export const singleHeadMaxScope = 32;
/** Room left in the head's brief for what a later try adds: a lead's retry brief (at most 4,000 characters) and a landing conflict's section. */
const briefMargin = 6000;

export interface PlanShape {
  jobs: number;
  /** The longest dependency chain, in jobs: 1 when every job can start at once. */
  depth: number;
  /** The most jobs on one level of the chain, all of which can run at once. */
  widest: number;
  /** jobs / depth: how many jobs run at once, on average, with nothing waiting longer than it must. */
  averageWidth: number;
}

/** Each job's level: 1 with no dependencies, else one more than its deepest dependency (pure; a cycle is refused before this). */
function levels(jobs: readonly Pick<PlanJob, 'key' | 'dependsOn'>[]): Map<string, number> {
  const byKey = new Map(jobs.map(job => [job.key, job]));
  const level = new Map<string, number>();
  const visit = (key: string, path: Set<string>): number => {
    const known = level.get(key);
    if (known !== undefined) return known;
    if (path.has(key)) return 1;
    path.add(key);
    const job = byKey.get(key);
    const value = 1 + Math.max(0, ...(job?.dependsOn ?? []).filter(dependency => byKey.has(dependency)).map(dependency => visit(dependency, path)));
    path.delete(key);
    level.set(key, value);
    return value;
  };
  for (const job of jobs) visit(job.key, new Set());
  return level;
}

/** A plan's shape, from its jobs and their dependencies (pure). */
export function planShape(jobs: readonly Pick<PlanJob, 'key' | 'dependsOn'>[]): PlanShape {
  if (!jobs.length) return { jobs: 0, depth: 0, widest: 0, averageWidth: 0 };
  const level = levels(jobs);
  const counts = new Map<number, number>();
  for (const value of level.values()) counts.set(value, (counts.get(value) ?? 0) + 1);
  const depth = Math.max(...level.values());
  return { jobs: jobs.length, depth, widest: Math.max(...counts.values()), averageWidth: jobs.length / depth };
}

/** The jobs in the order one head does them: level by level, and in the plan's own order within a level (pure). */
export function singleHeadOrder<J extends Pick<PlanJob, 'key' | 'dependsOn'>>(jobs: readonly J[]): J[] {
  const level = levels(jobs);
  return jobs.map((job, index) => ({ job, index })).sort((a, b) => level.get(a.job.key)! - level.get(b.job.key)! || a.index - b.index).map(({ job }) => job);
}

const rigorRank: Record<PlanRigor, number> = { quick: 0, standard: 1, strict: 2 };
const round = (value: number) => (Math.round(value * 10) / 10).toFixed(1);

/** One head's whole brief for a plan run as one head: the plan, then each job in order (pure). */
export function singleHeadBrief(plan: Pick<Plan, 'title' | 'brief'>, jobs: readonly PlanJob[]): string {
  const ordered = singleHeadOrder(jobs);
  const parts = ordered.map((job, index) => [
    `## Part ${index + 1} of ${ordered.length}: ${job.title} (\`${job.key}\`)`,
    '',
    `Files: ${job.writeScope?.length ? job.writeScope.join(', ') : 'any'}.${job.dependsOn.length ? ` Builds on: ${job.dependsOn.join(', ')}.` : ''}`,
    '',
    job.brief.trim(),
  ].join('\n'));
  return [
    `Hydra runs plan "${plan.title}" as one head: you do all ${ordered.length} of its jobs.`,
    `Do every part below yourself, in this order, in this one worktree. Each part was written as a separate job: where one mentions another job, that job is one of these parts, so you build both sides of it, and where one limits its files or leaves something to another job, that limit no longer applies. Your write scope is every part's files together. Run the project's tests before you finish.`,
    ...(plan.brief?.trim() ? ['', '## The plan', '', plan.brief.trim()] : []),
    '',
    ...parts.flatMap(part => [part, '']),
  ].join('\n').trimEnd();
}

export type SingleHeadDecision = { single: true; reason: string } | { single: false; reason: string };

/**
 * Whether a plan that hasn't started should run as one head, and why (pure). Only a plan of head jobs that could
 * all be one head: no lanes or auto-dispatch, one provider, no pack roles, nothing started or carried over. Then it
 * runs as one head when its jobs form a dependency chain (more than one level) and, on average, fewer than
 * singleHeadMaxAverageWidth of them could run at once.
 */
export function singleHeadDecision(plan: Pick<Plan, 'title' | 'brief' | 'jobs' | 'dispatch' | 'leadOrigin'>): SingleHeadDecision {
  const jobs = plan.jobs;
  // A plan you built on the canvas runs as you drew it; only a lead's (or `hydra plan run`'s) plan is reshaped.
  if (!plan.leadOrigin) return { single: false, reason: 'it was made on the canvas' };
  if (jobs.length < 2) return { single: false, reason: 'it has one job' };
  if (plan.dispatch || jobs.some(job => (job.runAs ?? 'head') !== 'head')) return { single: false, reason: 'it has lane jobs' };
  if (jobs.some(job => job.role)) return { single: false, reason: 'its jobs have pack roles' };
  if (new Set(jobs.map(job => job.provider ?? '')).size > 1) return { single: false, reason: 'its jobs use different providers' };
  if (new Set(jobs.map(job => job.model ?? '')).size > 1) return { single: false, reason: 'its jobs use different models' };
  if (jobs.some(job => job.jobId || job.laneId || job.result || job.outcome || job.attempt || job.conflict)) return { single: false, reason: 'some of its jobs already ran' };
  const shape = planShape(jobs);
  if (shape.depth < 2) return { single: false, reason: `its ${shape.jobs} jobs can all run at once` };
  const shapeText = `${shape.jobs} jobs in a dependency chain of ${shape.depth}, about ${round(shape.averageWidth)} at once on average`;
  if (shape.averageWidth >= singleHeadMaxAverageWidth) return { single: false, reason: `${shapeText} (${singleHeadMaxAverageWidth} or more runs them apart)` };
  const reason = `${shapeText} (under ${singleHeadMaxAverageWidth}), so running them apart would cost a worktree, gates and a landing per job for little parallel work`;
  if (singleHeadBrief(plan, jobs).length > maxBriefLength - briefMargin) return { single: false, reason: 'its briefs together are too long for one head' };
  if (jobs.every(job => job.writeScope?.length) && new Set(jobs.flatMap(job => job.writeScope!)).size > singleHeadMaxScope) return { single: false, reason: `its write scopes together list more than ${singleHeadMaxScope} paths, more than one head takes` };
  return { single: true, reason };
}

/**
 * The plan's jobs replaced by one job that does them all (pure): every job's write scope (the whole repository if
 * any job had none), the strictest rigor, and the shared provider. The jobs as they were stay on the plan
 * (`singleHead.jobs`): the head's brief is built from them when it starts (planHeadInput), and the report lists them.
 */
export function singleHeadPlan(plan: Pick<Plan, 'jobs' | 'board'>, reason: string): Pick<Plan, 'jobs' | 'singleHead' | 'board'> {
  const jobs = plan.jobs.map(({ draft: _draft, ...job }) => job);
  const scopes = jobs.every(job => job.writeScope?.length) ? [...new Set(jobs.flatMap(job => job.writeScope!))] : undefined;
  const rigors = jobs.map(job => job.rigor).filter((rigor): rigor is PlanRigor => !!rigor);
  const rigor = rigors.length ? rigors.reduce((a, b) => rigorRank[b] > rigorRank[a] ? b : a) : undefined;
  const provider = jobs[0]?.provider;
  const model = jobs[0]?.model;
  const order = singleHeadOrder(jobs).map(job => job.key);
  const whole: PlanJob = {
    key: singleHeadKey, title: `All ${jobs.length} jobs, as one head`, runAs: 'head', dependsOn: [],
    brief: singleHeadPlaceholder(order),
    ...(scopes ? { writeScope: scopes } : {}), ...(rigor ? { rigor } : {}), ...(provider ? { provider } : {}), ...(model ? { model } : {}),
  };
  // A post the lead addressed to one of the jobs now goes to the head doing it.
  const keys = new Set(jobs.map(job => job.key));
  const board = plan.board?.map(post => post.to === 'all' || !post.to.some(key => keys.has(key)) ? post : { ...post, to: [...new Set(post.to.map(key => keys.has(key) ? singleHeadKey : key))] });
  return { jobs: [whole], singleHead: { reason, jobs }, ...(board ? { board } : {}) };
}

/** The one job's stored brief (pure): short, since the head's real brief is built from the jobs when it starts. */
export const singleHeadPlaceholder = (order: readonly string[]): string =>
  `Every job of this plan, done by one head in this order: ${order.join(', ')}. Hydra gives the head each job's own brief when it starts.`;

/**
 * The one head's whole brief (pure): the plan and every job's brief, then a brief the lead gave the job itself
 * since (hydra_plan_amend's edit or retry), which would otherwise be lost.
 */
export function singleHeadJobBrief(plan: Pick<Plan, 'title' | 'brief' | 'singleHead'>, job: Pick<PlanJob, 'brief'>): string {
  const single = plan.singleHead!;
  const own = singleHeadBrief(plan, single.jobs);
  const placeholder = singleHeadPlaceholder(singleHeadOrder(single.jobs).map(item => item.key));
  return job.brief.trim() && job.brief.trim() !== placeholder ? `${own}\n\n## From the lead, for this try\n\n${job.brief.trim()}` : own;
}

/**
 * The one head's limits (pure): your per-head defaults times the number of jobs it does, as the jobs would have had
 * together. parseJobInput caps them (4 hours, 500 turns, $100).
 */
export function singleHeadLimits(defaults: JobLimits, jobCount: number): { wall_clock_minutes: number; max_turns: number; max_budget_usd: number } {
  const times = Math.max(1, jobCount);
  return { wall_clock_minutes: Math.round(defaults.wallClockMs / 60_000) * times, max_turns: defaults.maxTurns * times, max_budget_usd: Math.round(defaults.maxBudgetUsd * times * 100) / 100 };
}
