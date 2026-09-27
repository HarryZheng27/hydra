import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { replaceAtomic } from './atomicFile';
import type { Provider } from './model';
import type { EvidenceStatus } from './jobs';
import type { PlanRigor } from './gates/config';
import { releaseConflict, validateIntegration, validateJobConflict, type PlanIntegration, type PlanJobConflict } from './integration';

/**
 * Hydra plans (docs/Lanes_And_Planner_Plan.md, section 4). A plan is a small,
 * hand- or brief-drafted graph of jobs; running it starts each job, in
 * dependency order, as a Hydra head under one lead (`plan-<id>`) so the heads
 * group together on the canvas, or as a lane you drive (docs/Plan_Lanes_Plan.md).
 * Pure model and storage; nothing here starts a process or knows about
 * HelperService, so it is trivial to unit test. src/core/planRunner.ts runs plans.
 */
export type PlanState = 'planning' | 'draft' | 'running' | 'incomplete' | 'done' | 'failed';
export const planStates: readonly PlanState[] = ['planning', 'draft', 'running', 'incomplete', 'done', 'failed'];
/**
 * The only allowed plan state changes. "planning" is the brief being drafted; "failed" also covers a cancelled draft.
 * A running plan is "incomplete" once nothing is left to wait for but some job didn't finish; Retry failed jobs, or
 * Run plan after adding jobs, runs it again.
 */
export const planTransitions: Readonly<Record<PlanState, readonly PlanState[]>> = {
  planning: ['draft', 'failed'],
  draft: ['planning', 'running'],
  failed: ['planning', 'draft', 'running'],
  running: ['done', 'incomplete'],
  incomplete: ['running'],
  done: [],
};
export const canTransitionPlan = (from: PlanState, to: PlanState): boolean => planTransitions[from].includes(to);

export const maxPlanJobs = 12;
export const planTitleMax = 200;
export const planBriefMax = 8000;
export const planJobTitleMax = 80;
export const planJobBriefMax = 4000;
export const planIdPattern = /^[a-f0-9]{12}$/;
export const planJobKeyPattern = /^[a-z0-9-]{1,24}$/;
/** A lane job's handed-on result (docs/Plan_Lanes_Plan.md, section 1): at most this many changed files, and a note this long. */
export const planResultFilesMax = 300;
export const planResultNoteMax = 2000;
export const planOutcomeReasonMax = 500;

// ---- Plan jobs that run as lanes (docs/Plan_Lanes_Plan.md, section 1) ----
export type PlanJobRunAs = 'head' | 'lane';
/** What a lane job handed on: the lane's HEAD when it merged or was marked done. It never moves afterwards. */
export interface PlanJobResult {
  commit: string; via: 'merged' | 'marked'; at: string; note?: string; changedFiles: string[];
  /** Step A: the lane's evidence status at this commit, when one was recorded. */
  status?: EvidenceStatus;
}
/** A job that won't finish. */
export interface PlanJobOutcome { state: 'failed' | 'cancelled' | 'skipped'; reason: string; at: string }

export interface PlanJob {
  key: string; title: string; brief: string; provider?: Provider;
  dependsOn: string[]; writeScope?: string[];
  /** Who drives it. Missing means 'head', as in every plan saved before lanes could run jobs. */
  runAs?: PlanJobRunAs;
  /** runAs 'head': the head's job id, once started; makes running the plan again idempotent. */
  jobId?: string;
  /** runAs 'lane': the lane's id, once started. */
  laneId?: string;
  /** runAs 'lane': the work it handed on. */
  result?: PlanJobResult;
  outcome?: PlanJobOutcome;
  /** How many times Retry failed jobs has restarted it. */
  attempt?: number;
  /** Added with + Job after the plan ran (decision 5): it waits for Run plan, so a half-written job never starts by itself. */
  draft?: boolean;
  /**
   * Packs (docs/Packs_Plan.md, "Plans and the planner"): a role from an active pack, as "pack/role".
   * A head job passes it to its head, a lane job to its lane; the job's provider comes first, then the role's.
   */
  role?: string;
  /** Step C: gate failures Hydra sent back to this try's auto-dispatched lane. Retry failed jobs clears it. */
  gateFailures?: number;
  /**
   * O6 (docs/Heads.md, "Rigor"): only ever adds to the project's own gate floor;
   * 'quick' adds nothing. A lead's plan defaults an unset job to 'standard' when
   * creating or adding it (planFromLeadInput, applyPlanAmendment); missing here
   * behaves as 'quick', which is every plan saved before rigor existed.
   */
  rigor?: PlanRigor;
  /**
   * O3 (docs/Heads.md, "Landing a plan together"): why this job's last try couldn't land on the plan's
   * integration branch, and the commit its next try carries over. `held` once its tries ran out: it
   * shows as failed, for the lead, until a retry.
   */
  conflict?: PlanJobConflict;
}
/**
 * Step C: Auto-dispatch to lanes. Present means on: at most `lanes` of the
 * plan's lane jobs run at once, each ready one starts by itself with `provider` (unless the job names its own),
 * and hydra_job_ready runs the gates, with `attempts` tries before the job fails.
 */
export interface PlanDispatch { lanes: number; provider: Provider; attempts: number }
export const planDispatchDefaults: PlanDispatch = { lanes: 2, provider: 'claude', attempts: 3 };
export const planDispatchMaxLanes = 4;
export const planDispatchMaxAttempts = 5;
/** Throws the first problem found. */
export function validatePlanDispatch(value: unknown): PlanDispatch {
  const dispatch = value as Partial<PlanDispatch> | undefined;
  if (!dispatch || typeof dispatch !== 'object' || Array.isArray(dispatch)) throw new Error('Auto-dispatch settings must be an object.');
  if (!Number.isInteger(dispatch.lanes) || dispatch.lanes! < 1 || dispatch.lanes! > planDispatchMaxLanes) throw new Error(`Lanes at once must be 1-${planDispatchMaxLanes}.`);
  if (dispatch.provider !== 'claude' && dispatch.provider !== 'codex') throw new Error('Auto-dispatch needs Claude or Codex as its provider.');
  if (!Number.isInteger(dispatch.attempts) || dispatch.attempts! < 1 || dispatch.attempts! > planDispatchMaxAttempts) throw new Error(`Attempts must be 1-${planDispatchMaxAttempts}.`);
  return { lanes: dispatch.lanes!, provider: dispatch.provider, attempts: dispatch.attempts! };
}
/** A plan job's role: "pack/role", as packs name their roles (src/core/packs/launch.ts). */
export const planJobRolePattern = /^[a-z0-9-]{1,24}\/[a-z0-9-]{1,24}$/;
export const planIdempotencyKeyMax = 200;
export interface Plan {
  version: 1; id: string; title: string; brief?: string; createdAt: string; updatedAt: string;
  state: PlanState; error?: string; jobs: PlanJob[];
  dispatch?: PlanDispatch;
  /**
   * O1: a lead created this plan with hydra_plan_create, from this chat's own lead session.
   * Repeating the call with the same idempotencyKey returns this same plan instead of making
   * another; `hydra_plan_amend` and `hydra_plan_cancel` work only on a plan that has this.
   */
  leadOrigin?: { leadSessionId: string; idempotencyKey: string };
  /** O4: structured messages between the lead and its plan's jobs (docs/Heads.md, "The plan board"). */
  board?: BoardPost[];
  /** O5: every hydra_plan_amend change, oldest first (docs/Heads.md, "Plans that adapt"). Its length is the amendment count hydra.plans.maxAmendments limits. */
  amendments?: PlanAmendment[];
  /** O7 (docs/Heads.md, "Unattended plans"): present means this plan runs unattended, capped by this budget. */
  unattended?: PlanBudget;
  /** O7: when Run first moved this plan to 'running'. Measures the wall-clock budget, and used in the report. */
  startedAt?: string;
  /**
   * O3 (docs/Heads.md, "Landing a plan together"): the plan's integration branch, its landing queue and
   * its integration gate. Set on the first Run; a plan that ran before O3 has none and runs as it did.
   */
  integration?: PlanIntegration;
}

// ---- O7: unattended plans (docs/Heads.md, "Unattended plans") ----

/** All optional: an unset dimension isn't capped. */
export interface PlanBudget { usd?: number; wallClockMinutes?: number; maxJobs?: number }

function validateBudget(budget: unknown): PlanBudget {
  const source = budget as Partial<PlanBudget> | undefined;
  if (!source || typeof source !== 'object') throw new Error('An unattended plan\'s budget must be an object.');
  if (source.usd !== undefined && (typeof source.usd !== 'number' || !Number.isFinite(source.usd) || source.usd <= 0)) throw new Error('budget.usd must be a positive number.');
  if (source.wallClockMinutes !== undefined && (typeof source.wallClockMinutes !== 'number' || !Number.isInteger(source.wallClockMinutes) || source.wallClockMinutes < 1 || source.wallClockMinutes > 7 * 24 * 60)) throw new Error('budget.wallClockMinutes must be 1 to 10080 (a week).');
  if (source.maxJobs !== undefined && (typeof source.maxJobs !== 'number' || !Number.isInteger(source.maxJobs) || source.maxJobs < 1 || source.maxJobs > maxPlanJobs)) throw new Error(`budget.maxJobs must be 1-${maxPlanJobs}.`);
  if (source.usd === undefined && source.wallClockMinutes === undefined && source.maxJobs === undefined) throw new Error('An unattended plan\'s budget needs at least one of usd, wall_clock_minutes or max_jobs.');
  return { ...(source.usd !== undefined ? { usd: source.usd } : {}), ...(source.wallClockMinutes !== undefined ? { wallClockMinutes: source.wallClockMinutes } : {}), ...(source.maxJobs !== undefined ? { maxJobs: source.maxJobs } : {}) };
}

/**
 * Refuses a job count this plan's own budget wouldn't cover, before anything is created or added:
 * `maxJobs` directly, and `usd` estimated as `jobCount × defaultHeadBudgetUsd`, since a plan job has
 * no budget of its own yet (every job uses the window's own per-head default). Both are static caps
 * checked up front, not a running total of what was actually spent, which Hydra has no way to see.
 */
export function refuseOverBudget(budget: PlanBudget, jobCount: number, defaultHeadBudgetUsd: number): void {
  if (budget.maxJobs !== undefined && jobCount > budget.maxJobs) throw new Error(`This plan's budget allows at most ${budget.maxJobs} jobs; it would have ${jobCount}.`);
  if (budget.usd !== undefined) {
    const estimate = jobCount * defaultHeadBudgetUsd;
    if (estimate > budget.usd) throw new Error(`This plan's budget is $${budget.usd}; ${jobCount} jobs at up to $${defaultHeadBudgetUsd} each could reach $${estimate}. Lower the job count, or raise the budget.`);
  }
}

// ---- O7: the morning report (docs/Heads.md, "Unattended plans") ----

/** One job's detail for the report, assembled by the caller from the plan job and (for a started one) its head. */
export interface PlanReportJobDetail {
  key: string;
  title: string;
  status: string;
  provider?: Provider;
  /** O6: a usage-limit handoff — the providers this job ran under before `provider`. */
  priorProviders?: Provider[];
  attempts?: number;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  changedFiles?: string[];
  checks?: { id: string; required: boolean; passed: boolean; state?: string; summary?: string }[];
  reason?: string;
  question?: string;
}

const reportDuration = (startedAt?: string, finishedAt?: string): string | undefined => {
  if (!startedAt) return undefined;
  const ms = (finishedAt ? new Date(finishedAt).getTime() : Date.now()) - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const minutes = Math.round(ms / 60000);
  return minutes < 1 ? '<1m' : minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

/**
 * The morning report (docs/Heads.md, "Unattended plans"): what an unattended plan did, written as Markdown,
 * kept with the plan and opened as a tab when the plan ends. Pure and snapshot-testable; the caller (extension.ts)
 * assembles each job's detail from the head store, since this module never reads one itself.
 */
export function buildPlanReport(plan: Pick<Plan, 'title' | 'state' | 'unattended' | 'startedAt' | 'amendments'>, jobs: readonly PlanReportJobDetail[], defaultHeadBudgetUsd = 5): string {
  const lines: string[] = [`# ${plan.title}`, ''];
  const ended = plan.state === 'done' ? 'finished' : plan.state === 'incomplete' ? 'stopped incomplete' : plan.state;
  lines.push(`Unattended plan, ${ended}.`);
  if (plan.unattended) {
    const parts: string[] = [];
    if (plan.unattended.usd !== undefined) parts.push(`$${plan.unattended.usd}`);
    if (plan.unattended.wallClockMinutes !== undefined) parts.push(`${plan.unattended.wallClockMinutes} minute(s)`);
    if (plan.unattended.maxJobs !== undefined) parts.push(`${plan.unattended.maxJobs} job(s) at once`);
    if (parts.length) lines.push(`Budget: ${parts.join(', ')}.`);
  }
  const overall = reportDuration(plan.startedAt, undefined);
  if (overall) lines.push(`Ran for ${overall}.`);
  lines.push('');
  for (const job of jobs) {
    lines.push(`## ${job.title}`, '');
    lines.push(`Status: ${job.status}.`);
    if (job.provider) {
      const handoff = job.priorProviders?.length ? ` (handed off from ${job.priorProviders.join(', ')})` : '';
      lines.push(`Provider: ${job.provider}${handoff}.`);
    }
    if (job.attempts !== undefined) lines.push(`Attempts: ${job.attempts}.`);
    const duration = reportDuration(job.startedAt, job.finishedAt);
    if (duration) lines.push(`Time: ${duration}.`);
    // No live spend tracking exists (only wall-clock is enforced), so cost is the same worst-case estimate the budget check uses, not an actual charge.
    lines.push(`Cost: not tracked live; budgeted up to $${defaultHeadBudgetUsd}.`);
    if (job.summary) lines.push('', job.summary);
    if (job.changedFiles?.length) lines.push('', 'Changed files:', ...job.changedFiles.map(file => `- ${file}`));
    if (job.checks?.length) {
      lines.push('', 'Gates:');
      for (const check of job.checks) {
        const icon = check.state === 'notRun' ? '–' : check.passed ? '✓' : '✗';
        lines.push(`- ${icon} ${check.id}${check.required ? '' : ' (optional)'}${check.summary ? `: ${check.summary}` : ''}`);
      }
    }
    if (job.reason) lines.push('', `Reason: ${job.reason}`);
    if (job.question) lines.push('', `Asked: ${job.question}`);
    lines.push('');
  }
  if (plan.amendments?.length) {
    lines.push('## Amendments', '');
    for (const amendment of plan.amendments) lines.push(`- ${amendment.at}: ${amendment.detail}`);
    lines.push('');
  }
  lines.push('## Integration gate', '');
  lines.push('Not available: Hydra doesn\'t yet run an integration gate across a plan\'s jobs (planned separately).', '');
  const needsYou = jobs.filter(job => job.status === 'failed' || job.question);
  lines.push('## Needs you', '');
  if (!needsYou.length) lines.push('Nothing — every job finished or was skipped on purpose.');
  else for (const job of needsYou) lines.push(`- ${job.title}: ${job.question ? `asked "${job.question}"` : job.reason ? job.reason : 'failed'}`);
  return lines.join('\n');
}

// ---- O5: plans that adapt (docs/Heads.md, "Plans that adapt") ----

export const amendmentDetailMax = 500;
export interface PlanAmendment { at: string; kind: 'add' | 'edit' | 'skip' | 'retry'; key?: string; detail: string }

function validateAmendments(amendments: unknown): void {
  if (!Array.isArray(amendments)) throw new Error('A plan\'s amendments must be a list.');
  for (const value of amendments) {
    const item = value as Partial<PlanAmendment> | undefined;
    if (!item || typeof item !== 'object') throw new Error('Each amendment must be an object.');
    if (!isTime(item.at)) throw new Error('An amendment has an invalid time.');
    if (item.kind !== 'add' && item.kind !== 'edit' && item.kind !== 'skip' && item.kind !== 'retry') throw new Error('An amendment has an unknown kind.');
    if (item.key !== undefined && (typeof item.key !== 'string' || !planJobKeyPattern.test(item.key))) throw new Error('An amendment has an invalid key.');
    if (typeof item.detail !== 'string' || !item.detail.trim() || item.detail.length > amendmentDetailMax) throw new Error(`An amendment's detail must be 1-${amendmentDetailMax} characters.`);
  }
}

/** Appends one entry to a plan's amendment history. Pure: the caller persists the result. */
export function appendAmendment(amendments: readonly PlanAmendment[] | undefined, entry: Omit<PlanAmendment, 'at'>, now: () => Date = () => new Date()): PlanAmendment[] {
  return [...(amendments ?? []), { at: now().toISOString(), ...entry }];
}

export interface PlanAmendEdit { key: string; title?: string; brief?: string; write_scope?: string[]; depends_on?: string[]; rigor?: PlanRigor }
export interface PlanAmendSkip { key: string; reason: string }
/** Retry a job that failed or was skipped, optionally with changes; refused for a job that's running, done or not started. */
export interface PlanAmendRetry { key: string; title?: string; brief?: string; write_scope?: string[]; provider?: Provider; rigor?: PlanRigor }
export interface PlanAmendInput { add?: PlanLeadJobInput[]; edit?: PlanAmendEdit[]; skip?: PlanAmendSkip[]; retry?: PlanAmendRetry[] }

/**
 * A job's live status ('failed', 'skipped', 'running', 'done', …), the same
 * words PlanRunner.statuses() uses. A head's failure lives only there — it's
 * never written to PlanJob.outcome — so retry needs this to know a head job
 * failed at all; add/edit/skip never do. Defaults to reading PlanJob.outcome
 * (right for a lane job, and enough for testing this function on its own).
 */
export type PlanJobStatusOf = (key: string) => string | undefined;
const statusFromOutcome = (jobs: readonly PlanJob[]): PlanJobStatusOf => key => {
  const job = jobs.find(item => item.key === key);
  if (!job) return undefined;
  return job.outcome?.state ?? (jobStarted(job) ? 'running' : 'not started');
};

/**
 * Applies one hydra_plan_amend call: add jobs, edit or skip jobs that haven't
 * started, or retry a failed one, then re-checks the whole plan (validatePlanJobs,
 * cycles, scope overlap) the same way a fresh plan is checked. Pure: the caller
 * persists the result and decides whether the plan's state needs to change (a
 * retry can make an incomplete plan worth running again). Throws the first
 * problem found, and appends nothing if it throws.
 */
export function applyPlanAmendment(current: { jobs: readonly PlanJob[]; amendments?: readonly PlanAmendment[]; unattended?: PlanBudget }, input: PlanAmendInput, statusOf: PlanJobStatusOf = statusFromOutcome(current.jobs), now: () => Date = () => new Date(), defaultHeadBudgetUsd = 5): { jobs: PlanJob[]; amendments: PlanAmendment[] } {
  let jobs = [...current.jobs];
  let amendments = current.amendments as PlanAmendment[] | undefined;
  const record = (kind: PlanAmendment['kind'], key: string, detail: string) => { amendments = appendAmendment(amendments, { kind, key, detail }, now); };
  for (const skip of input.skip ?? []) {
    const job = jobs.find(item => item.key === skip.key);
    if (!job) throw new Error(`No job "${skip.key}" in this plan.`);
    if (jobStarted(job)) throw new Error(`Job "${job.title}" has already started, so it can't be skipped.`);
    const reason = skip.reason.length > planOutcomeReasonMax ? `${skip.reason.slice(0, planOutcomeReasonMax - 1)}…` : skip.reason;
    const outcome: PlanJobOutcome = { state: 'skipped', reason, at: now().toISOString() };
    jobs = jobs.map(item => item.key === skip.key ? { ...item, outcome } : item);
    record('skip', skip.key, `Skipped: ${reason}`);
  }
  for (const edit of input.edit ?? []) {
    const job = jobs.find(item => item.key === edit.key);
    if (!job) throw new Error(`No job "${edit.key}" in this plan.`);
    if (jobStarted(job)) throw new Error(`Job "${job.title}" has already started, so it can't be edited.`);
    jobs = jobs.map(item => item.key === edit.key ? {
      ...item,
      ...(edit.title !== undefined ? { title: edit.title } : {}), ...(edit.brief !== undefined ? { brief: edit.brief } : {}),
      ...(edit.write_scope !== undefined ? { writeScope: edit.write_scope } : {}), ...(edit.depends_on !== undefined ? { dependsOn: edit.depends_on } : {}),
      ...(edit.rigor !== undefined ? { rigor: edit.rigor } : {}),
    } : item);
    const changed = [edit.title !== undefined && 'title', edit.brief !== undefined && 'brief', edit.write_scope !== undefined && 'write_scope', edit.depends_on !== undefined && 'depends_on', edit.rigor !== undefined && 'rigor'].filter(Boolean);
    record('edit', edit.key, `Edited: ${changed.join(', ')}`);
  }
  for (const retry of input.retry ?? []) {
    const job = jobs.find(item => item.key === retry.key);
    if (!job) throw new Error(`No job "${retry.key}" in this plan.`);
    // A job the lead skipped, or one skipped automatically because a dependency failed, is just as
    // retriable as one that failed itself: retrying the dependency alone never un-skips it, so the
    // lead names it too when the whole chain should resume.
    const status = statusOf(retry.key);
    if (status !== 'failed' && status !== 'skipped') throw new Error(`Job "${job.title}" is ${status ?? 'not started'}, so there's nothing to retry.`);
    const nextAttempt = (job.attempt ?? 0) + 1;
    const { jobId: _jobId, laneId: _laneId, result: _result, outcome: _outcome, gateFailures: _gateFailures, conflict, ...rest } = job;
    // O3: a job held after running out of tries to land gets a fresh set; its conflict files and commit stay for its next brief.
    const released = releaseConflict(conflict);
    jobs = jobs.map(item => item.key === retry.key ? {
      ...rest, attempt: nextAttempt, ...(released ? { conflict: released } : {}),
      ...(retry.title !== undefined ? { title: retry.title } : {}), ...(retry.brief !== undefined ? { brief: retry.brief } : {}),
      ...(retry.write_scope !== undefined ? { writeScope: retry.write_scope } : {}), ...(retry.provider !== undefined ? { provider: retry.provider } : {}),
      ...(retry.rigor !== undefined ? { rigor: retry.rigor } : {}),
    } : item);
    const changed = [retry.title !== undefined && 'title', retry.brief !== undefined && 'brief', retry.write_scope !== undefined && 'write_scope', retry.provider !== undefined && 'provider', retry.rigor !== undefined && 'rigor'].filter(Boolean);
    record('retry', retry.key, `Retried (attempt ${nextAttempt})${changed.length ? `, with a new ${changed.join(', ')}` : ''}.`);
  }
  if (input.add?.length) {
    const keys = new Set(jobs.map(item => item.key));
    const added: PlanJob[] = input.add.map(job => {
      if (keys.has(job.key)) throw new Error(`Job key "${job.key}" is already used in this plan.`);
      keys.add(job.key);
      return {
        key: job.key, title: job.title, brief: job.brief, writeScope: job.write_scope, dependsOn: job.depends_on ?? [], runAs: 'head', rigor: job.rigor ?? 'standard',
        ...(job.provider ? { provider: job.provider } : {}), ...(job.role ? { role: job.role } : {}),
      };
    });
    jobs = [...jobs, ...added];
    for (const job of input.add) record('add', job.key, `Added, depending on ${job.depends_on?.length ? job.depends_on.join(', ') : 'nothing'}.`);
  }
  validatePlanJobs(jobs);
  const cycle = findCycle(jobs);
  if (cycle) throw new Error(cycleMessage(jobs, cycle));
  refuseScopeOverlap(jobs);
  // O7: an unattended plan's own budget still applies to a job an amendment adds.
  if (current.unattended) refuseOverBudget(current.unattended, jobs.length, defaultHeadBudgetUsd);
  return { jobs, amendments: amendments ?? [] };
}

// ---- O4: the plan board (docs/Heads.md, "The plan board") ----

export const boardBodyMax = 2000;
export const boardTopicMax = 200;
/** Oldest posts drop off past this many, so a long-running plan's board can't grow without bound. */
export const boardPostsMax = 500;
export type BoardFrom = { kind: 'lead' } | { kind: 'job'; key: string };
export interface BoardPost { id: string; at: string; from: BoardFrom; to: 'all' | string[]; topic?: string; body: string }

function validateBoard(board: unknown, jobKeys: ReadonlySet<string>): void {
  if (!Array.isArray(board)) throw new Error('A plan\'s board must be a list.');
  for (const value of board) {
    const post = value as Partial<BoardPost> | undefined;
    if (!post || typeof post !== 'object') throw new Error('Each board post must be an object.');
    if (typeof post.id !== 'string' || !hexId.test(post.id)) throw new Error('Invalid board post id.');
    if (!isTime(post.at)) throw new Error('A board post has an invalid time.');
    const from = post.from as Partial<BoardFrom> | undefined;
    if (!from || typeof from !== 'object' || (from.kind !== 'lead' && from.kind !== 'job')) throw new Error('A board post has an invalid from.');
    if (from.kind === 'job' && (typeof from.key !== 'string' || !planJobKeyPattern.test(from.key))) throw new Error('A board post\'s from.key is invalid.');
    if (post.to !== 'all' && (!Array.isArray(post.to) || post.to.length < 1 || post.to.some(key => typeof key !== 'string' || !jobKeys.has(key)))) {
      throw new Error('A board post\'s to must be "all" or this plan\'s job keys.');
    }
    if (post.topic !== undefined && (typeof post.topic !== 'string' || post.topic.length > boardTopicMax)) throw new Error(`A board post's topic must be at most ${boardTopicMax} characters.`);
    if (typeof post.body !== 'string' || !post.body.trim() || post.body.length > boardBodyMax) throw new Error(`A board post's body must be 1-${boardBodyMax} characters.`);
  }
}

/** Appends a post, trimming the oldest once the board passes boardPostsMax. Pure: the caller persists the result. */
export function appendBoardPost(board: readonly BoardPost[] | undefined, post: { from: BoardFrom; to: 'all' | string[]; topic?: string; body: string }, now: () => Date = () => new Date()): BoardPost[] {
  const entry: BoardPost = { id: randomBytes(6).toString('hex'), at: now().toISOString(), ...post };
  const next = [...(board ?? []), entry];
  return next.length > boardPostsMax ? next.slice(next.length - boardPostsMax) : next;
}

/**
 * A job's own view of the board (hydra_board): posts addressed to it or to
 * everyone, plus its own posts (so it can see what it already said). `untrusted`
 * is true for everything but the reader's own posts — the job's tool result
 * fences them the same way, but this is what decides which posts qualify.
 */
export function boardForJob(board: readonly BoardPost[] | undefined, key: string): (BoardPost & { untrusted: boolean })[] {
  return (board ?? [])
    .filter(post => post.to === 'all' || (Array.isArray(post.to) && post.to.includes(key)) || (post.from.kind === 'job' && post.from.key === key))
    .map(post => ({ ...post, untrusted: !(post.from.kind === 'job' && post.from.key === key) }));
}

/** The lead's own view (hydra_plan_get/_wait/_create/_amend/_cancel): every post; a job's is untrusted, the lead's own isn't. */
export function boardForLead(board: readonly BoardPost[] | undefined): (BoardPost & { untrusted: boolean })[] {
  return (board ?? []).map(post => ({ ...post, untrusted: post.from.kind === 'job' }));
}

const trimmed = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const fullSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const hexId = /^[a-f0-9]{12}$/;
const isTime = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 64 && !Number.isNaN(Date.parse(value));
/** A job has started once it has a head, a lane, a result or an outcome. */
export const jobStarted = (job: Pick<PlanJob, 'jobId' | 'laneId' | 'result' | 'outcome'>): boolean => !!(job.jobId || job.laneId || job.result || job.outcome);
export const jobRunAs = (job: Pick<PlanJob, 'runAs'>): PlanJobRunAs => job.runAs ?? 'head';

/** The lane-job fields (docs/Plan_Lanes_Plan.md, section 1), for one job. Throws the first problem found. */
function validateRunFields(job: PlanJob): void {
  const where = `Job "${job.key}"`;
  if (job.runAs !== undefined && job.runAs !== 'head' && job.runAs !== 'lane') throw new Error(`${where} must run as a head or a lane.`);
  const lane = job.runAs === 'lane';
  if (job.jobId !== undefined && (lane || typeof job.jobId !== 'string' || !hexId.test(job.jobId))) throw new Error(`${where} can't have a head id.`);
  if (job.laneId !== undefined && (!lane || typeof job.laneId !== 'string' || !hexId.test(job.laneId))) throw new Error(`${where} can't have a lane id.`);
  if (job.result !== undefined) {
    const result = job.result as Partial<PlanJobResult>;
    if (!lane || !result || typeof result !== 'object') throw new Error(`${where} can't have a result.`);
    if (typeof result.commit !== 'string' || !fullSha.test(result.commit)) throw new Error(`${where} has a result without a full commit id.`);
    if (result.via !== 'merged' && result.via !== 'marked') throw new Error(`${where} has a result of an unknown kind.`);
    if (!isTime(result.at)) throw new Error(`${where} has a result with an invalid time.`);
    if (result.note !== undefined && (typeof result.note !== 'string' || result.note.length > planResultNoteMax || result.note.includes('\0'))) throw new Error(`${where} has a note longer than ${planResultNoteMax} characters.`);
    if (!Array.isArray(result.changedFiles) || result.changedFiles.length > planResultFilesMax || result.changedFiles.some(file => typeof file !== 'string' || !file || file.length > 1000)) throw new Error(`${where} has a result with at most ${planResultFilesMax} changed files.`);
    const statuses: readonly EvidenceStatus[] = ['passed', 'partial', 'none', 'none-chosen', 'override'];
    if (result.status !== undefined && !statuses.includes(result.status)) throw new Error(`${where} has a result with an invalid evidence status.`);
  }
  if (job.outcome !== undefined) {
    const outcome = job.outcome as Partial<PlanJobOutcome>;
    if (!outcome || typeof outcome !== 'object' || (outcome.state !== 'failed' && outcome.state !== 'cancelled' && outcome.state !== 'skipped')) throw new Error(`${where} has an unknown outcome.`);
    if (typeof outcome.reason !== 'string' || !outcome.reason.trim() || outcome.reason.length > planOutcomeReasonMax) throw new Error(`${where} needs a reason of 1-${planOutcomeReasonMax} characters.`);
    if (!isTime(outcome.at)) throw new Error(`${where} has an outcome with an invalid time.`);
  }
  if (job.result !== undefined && job.outcome !== undefined) throw new Error(`${where} can't have both a result and an outcome.`);
  if (job.attempt !== undefined && (!Number.isInteger(job.attempt) || job.attempt < 0 || job.attempt > 1000)) throw new Error(`${where} has an invalid attempt count.`);
  if (job.draft !== undefined && typeof job.draft !== 'boolean') throw new Error(`${where} has an invalid draft flag.`);
  if (job.gateFailures !== undefined && (!lane || !Number.isInteger(job.gateFailures) || job.gateFailures < 0 || job.gateFailures > 1000)) throw new Error(`${where} has an invalid gate failure count.`);
  if (job.conflict !== undefined) validateJobConflict(job.conflict, where);
}

/** Unique keys that exist, dependencies that resolve, and the plan's size and text limits. Throws the first problem found. */
export function validatePlanJobs(jobs: readonly PlanJob[]): void {
  if (!Array.isArray(jobs)) throw new Error('A plan\'s jobs must be a list.');
  if (jobs.length > maxPlanJobs) throw new Error(`A plan may have at most ${maxPlanJobs} jobs.`);
  const keys = new Set<string>();
  for (const job of jobs) {
    if (typeof job.key !== 'string' || !planJobKeyPattern.test(job.key)) throw new Error(`Invalid job key "${String(job.key)}".`);
    if (keys.has(job.key)) throw new Error(`Duplicate job key "${job.key}".`);
    keys.add(job.key);
    if (!trimmed(job.title) || job.title.length > planJobTitleMax) throw new Error(`Job "${job.key}" title must be 1-${planJobTitleMax} characters.`);
    // A lane job's brief has the same limit as a head's: the lane reads the whole brief from a file (decision 2).
    if (!trimmed(job.brief) || job.brief.length > planJobBriefMax) throw new Error(`Job "${job.key}" brief must be 1-${planJobBriefMax} characters.`);
    if (job.provider !== undefined && job.provider !== 'claude' && job.provider !== 'codex') throw new Error(`Job "${job.key}" has an unknown provider.`);
    if (job.role !== undefined && (typeof job.role !== 'string' || !planJobRolePattern.test(job.role))) throw new Error(`Job "${job.key}" names its role as "pack/role", like "coding/builder".`);
    if (job.rigor !== undefined && job.rigor !== 'quick' && job.rigor !== 'standard' && job.rigor !== 'strict') throw new Error(`Job "${job.key}" has an unknown rigor.`);
    if (!Array.isArray(job.dependsOn)) throw new Error(`Job "${job.key}" dependsOn must be a list.`);
    validateRunFields(job);
  }
  for (const job of jobs) {
    for (const dependency of job.dependsOn) {
      if (!keys.has(dependency)) throw new Error(`Job "${job.key}" depends on unknown job "${dependency}".`);
      if (dependency === job.key) throw new Error(`Job "${job.key}" cannot depend on itself.`);
    }
  }
}

/** The plan's own fields, then its jobs. Throws the first problem found. */
export function validatePlan(plan: Plan): void {
  if (plan.version !== 1) throw new Error('Unsupported plan version.');
  if (typeof plan.id !== 'string' || !planIdPattern.test(plan.id)) throw new Error('Invalid plan id.');
  if (!trimmed(plan.title) || plan.title.length > planTitleMax) throw new Error(`Plan title must be 1-${planTitleMax} characters.`);
  if (plan.brief !== undefined && (typeof plan.brief !== 'string' || plan.brief.length > planBriefMax)) throw new Error(`Plan brief must be at most ${planBriefMax} characters.`);
  if (!planStates.includes(plan.state)) throw new Error('Invalid plan state.');
  if (plan.dispatch !== undefined) validatePlanDispatch(plan.dispatch);
  if (plan.leadOrigin !== undefined) {
    const origin = plan.leadOrigin as Partial<Plan['leadOrigin']>;
    if (!origin || typeof origin !== 'object' || !trimmed(origin.leadSessionId) || !trimmed(origin.idempotencyKey) || origin.idempotencyKey.length > planIdempotencyKeyMax) {
      throw new Error('Invalid leadOrigin.');
    }
  }
  if (plan.board !== undefined) validateBoard(plan.board, new Set(plan.jobs.map(job => job.key)));
  if (plan.amendments !== undefined) validateAmendments(plan.amendments);
  if (plan.unattended !== undefined) validateBudget(plan.unattended);
  if (plan.startedAt !== undefined && !isTime(plan.startedAt)) throw new Error('Invalid startedAt.');
  if (plan.integration !== undefined) validateIntegration(plan.integration, plan.id);
  // O7: unattended plans take heads only — a lane needs a terminal someone drives, which unattended can't ask for.
  if (plan.unattended) {
    const lane = plan.jobs.find(job => job.runAs === 'lane');
    if (lane) throw new Error(`An unattended plan takes heads only; "${lane.title}" runs as a lane.`);
  }
  validatePlanJobs(plan.jobs);
}

/** The lead-created plan (docs/Heads.md, "Plans from the chat") with this idempotency key, from this lead session, if any. */
export function findPlanByIdempotencyKey(plans: readonly Plan[], leadSessionId: string, idempotencyKey: string): Plan | undefined {
  return plans.find(plan => plan.leadOrigin?.leadSessionId === leadSessionId && plan.leadOrigin.idempotencyKey === idempotencyKey);
}

/**
 * The first dependency cycle, as a path like `['a', 'b', 'c', 'a']` (a depends
 * on b depends on c depends on a). `undefined` when the graph is acyclic.
 * Jobs whose dependsOn names an unknown key are treated as having no such
 * dependency here; validatePlanJobs is what refuses that.
 */
export function findCycle(jobs: readonly PlanJob[]): string[] | undefined {
  const byKey = new Map(jobs.map(job => [job.key, job]));
  const state = new Map<string, 1 | 2>(); // 1 = on the current path, 2 = fully explored
  const stack: string[] = [];
  const visit = (key: string): string[] | undefined => {
    state.set(key, 1);
    stack.push(key);
    for (const dependency of byKey.get(key)?.dependsOn || []) {
      if (!byKey.has(dependency)) continue;
      if (state.get(dependency) === 1) return [...stack.slice(stack.indexOf(dependency)), dependency];
      if (state.get(dependency) !== 2) { const found = visit(dependency); if (found) return found; }
    }
    stack.pop();
    state.set(key, 2);
    return undefined;
  };
  for (const job of jobs) if (!state.has(job.key)) { const found = visit(job.key); if (found) return found; }
  return undefined;
}

/** The cycle as the live banner and the run-refusal message show it: job titles, arrow-joined. */
export function cycleMessage(jobs: readonly PlanJob[], cycle: readonly string[]): string {
  const titleOf = new Map(jobs.map(job => [job.key, job.title || job.key]));
  return `The plan has a dependency cycle: ${cycle.map(key => titleOf.get(key) || key).join(' → ')}`;
}

/** Dependencies before dependents; ties broken by key so the order is deterministic. Throws if the graph has a cycle. */
export function topologicalOrder(jobs: readonly PlanJob[]): string[] {
  const byKey = new Map(jobs.map(job => [job.key, job]));
  const remaining = new Map(jobs.map(job => [job.key, job.dependsOn.filter(dependency => byKey.has(dependency)).length]));
  const ready = jobs.filter(job => remaining.get(job.key) === 0).map(job => job.key).sort();
  const order: string[] = [];
  while (ready.length) {
    const key = ready.shift()!;
    order.push(key);
    for (const job of jobs) {
      if (!job.dependsOn.includes(key)) continue;
      const left = (remaining.get(job.key) ?? 0) - 1;
      remaining.set(job.key, left);
      if (left === 0) ready.push(job.key);
    }
    ready.sort();
  }
  if (order.length !== jobs.length) { const cycle = findCycle(jobs); throw new Error(cycle ? cycleMessage(jobs, cycle) : 'The plan has a dependency cycle.'); }
  return order;
}

/** Every job that depends on `key`, directly or through others. */
export function dependentsOf(jobs: readonly PlanJob[], key: string): PlanJob[] {
  const found = new Set<string>(), queue = [key];
  while (queue.length) {
    const current = queue.shift()!;
    for (const job of jobs) if (job.dependsOn.includes(current) && !found.has(job.key)) { found.add(job.key); queue.push(job.key); }
  }
  return jobs.filter(job => found.has(job.key));
}

// ---- The planner-output parser (docs/Lanes_And_Planner_Plan.md, "Planning a brief") ----

const minPlannerJobs = 2, maxPlannerJobs = 8;

/** The first balanced `{...}` in the text, skipping over braces inside strings. `undefined` if none is well-formed JSON. Also reads a review gate's verdict. */
export function extractFirstJsonObject(text: string): string | undefined {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = matchingBrace(text, start);
    if (end === -1) continue;
    const candidate = text.slice(start, end + 1);
    try { JSON.parse(candidate); return candidate; } catch { /* not this one; keep scanning */ }
  }
  return undefined;
}
function matchingBrace(text: string, start: number): number {
  let depth = 0, inString = false, escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}') { depth--; if (depth === 0) return index; }
  }
  return -1;
}
const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/**
 * `roles` is the active roles' refs (docs/Packs_Plan.md, "Plans and the
 * planner"): a role the model named that isn't one of them is dropped rather
 * than refused, since the model may have guessed or misspelled it.
 */
function parsePlanJobDraft(raw: unknown, index: number, roles?: ReadonlySet<string>): PlanJob {
  if (!raw || typeof raw !== 'object') throw new Error(`Job ${index + 1} of the planner output must be an object.`);
  const source = raw as Record<string, unknown>;
  if (typeof source.key !== 'string' || !planJobKeyPattern.test(source.key)) throw new Error(`Job ${index + 1} of the planner output has an invalid key.`);
  if (!trimmed(source.title)) throw new Error(`Job "${source.key}" of the planner output is missing a title.`);
  if (!trimmed(source.brief)) throw new Error(`Job "${source.key}" of the planner output is missing a brief.`);
  const provider = source.provider === 'claude' || source.provider === 'codex' ? source.provider : undefined;
  const writeScope = stringList(source.writeScope);
  const role = typeof source.role === 'string' && planJobRolePattern.test(source.role) && roles?.has(source.role) ? source.role : undefined;
  return {
    key: source.key, title: (source.title as string).trim().slice(0, planJobTitleMax), brief: (source.brief as string).trim().slice(0, planJobBriefMax),
    ...(provider ? { provider } : {}), dependsOn: stringList(source.dependsOn), ...(writeScope.length ? { writeScope } : {}), ...(role ? { role } : {}),
  };
}

/**
 * Take the first JSON object out of a planner's reply text, validate it as
 * `{ "jobs": [...] }` with 2-8 jobs, and return the draft jobs. Tolerates code
 * fences and surrounding prose; throws with a plain-English reason otherwise.
 * `roleRefs` are the active roles a job's optional "role" may name
 * (docs/Packs_Plan.md, "Plans and the planner"); any other value is dropped.
 */
export function parsePlannerOutput(text: string, roleRefs?: readonly string[]): PlanJob[] {
  const object = extractFirstJsonObject(text);
  if (!object) throw new Error('The planner did not return a JSON object.');
  const parsed = JSON.parse(object) as { jobs?: unknown };
  if (!Array.isArray(parsed.jobs)) throw new Error('The planner output must have a "jobs" list.');
  if (parsed.jobs.length < minPlannerJobs || parsed.jobs.length > maxPlannerJobs) throw new Error(`The planner must return ${minPlannerJobs}-${maxPlannerJobs} jobs (it returned ${parsed.jobs.length}).`);
  const roles = roleRefs ? new Set(roleRefs) : undefined;
  const jobs = parsed.jobs.map((job, index) => parsePlanJobDraft(job, index, roles));
  validatePlanJobs(jobs);
  return jobs;
}

// ---- Storage: one JSON file per workspace, atomic writes, one writer (this extension host) ----

interface PlanStoreFile { version: 1; plans: Plan[] }
function parseStoreFile(value: unknown): PlanStoreFile {
  const source = value as Partial<PlanStoreFile>;
  if (!source || source.version !== 1 || !Array.isArray(source.plans)) throw new Error('Unsupported plan store.');
  for (const plan of source.plans) validatePlan(plan as Plan);
  return { version: 1, plans: source.plans };
}

export function createPlan(input: { title: string; brief?: string; state?: PlanState }): Plan {
  const at = new Date().toISOString();
  return { version: 1, id: randomBytes(6).toString('hex'), title: input.title, ...(input.brief ? { brief: input.brief } : {}), createdAt: at, updatedAt: at, state: input.state ?? 'draft', jobs: [] };
}

// ---- O1: plans from the chat (docs/Heads.md, "Plans from the chat") ----

/** hydra_plan_create's job shape: the same fields hydra_start_head takes, keyed so dependencies name each other. */
export interface PlanLeadJobInput {
  key: string; title: string; brief: string; write_scope: string[]; depends_on?: string[]; provider?: Provider; role?: string; rigor?: PlanRigor;
}
/** O7: hydra_plan_create's own shape for a budget (snake_case, at the MCP boundary). */
export interface PlanBudgetInput { usd?: number; wall_clock_minutes?: number; max_jobs?: number }
export interface PlanCreateInput { title: string; brief?: string; jobs: PlanLeadJobInput[]; run?: 'attended' | 'unattended'; budget?: PlanBudgetInput }

/**
 * Builds a draft plan from a lead's hydra_plan_create arguments, run as heads only
 * (a lane job stays a user choice on the canvas). Throws the first problem found,
 * the same way validatePlan does; nothing here starts a process or touches storage.
 */
export function planFromLeadInput(input: PlanCreateInput, leadOrigin: { leadSessionId: string; idempotencyKey: string }, defaultHeadBudgetUsd = 5): Plan {
  if (!input || typeof input !== 'object') throw new Error('hydra_plan_create needs an object.');
  if (!Array.isArray(input.jobs) || input.jobs.length < 1) throw new Error('A plan needs at least one job.');
  if (input.jobs.length > maxPlanJobs) throw new Error(`A plan may have at most ${maxPlanJobs} jobs.`);
  const jobs: PlanJob[] = input.jobs.map(job => {
    if (!job || typeof job !== 'object') throw new Error('Each job must be an object.');
    if (!Array.isArray(job.write_scope) || job.write_scope.length < 1) throw new Error(`Job "${String(job.key)}" needs a write_scope with at least one path.`);
    return {
      key: job.key, title: job.title, brief: job.brief, runAs: 'head',
      dependsOn: Array.isArray(job.depends_on) ? job.depends_on : [],
      writeScope: job.write_scope, rigor: job.rigor ?? 'standard',
      ...(job.provider !== undefined ? { provider: job.provider } : {}),
      ...(job.role !== undefined ? { role: job.role } : {}),
    };
  });
  // O7: unattended plans (docs/Heads.md, "Unattended plans"): heads only (already every job a lead's
  // plan makes), and a budget checked up front, before the plan runs unwatched.
  const unattended: PlanBudget | undefined = input.run === 'unattended' ? validateBudget({
    ...(input.budget?.usd !== undefined ? { usd: input.budget.usd } : {}),
    ...(input.budget?.wall_clock_minutes !== undefined ? { wallClockMinutes: input.budget.wall_clock_minutes } : {}),
    ...(input.budget?.max_jobs !== undefined ? { maxJobs: input.budget.max_jobs } : {}),
  }) : undefined;
  if (unattended) refuseOverBudget(unattended, jobs.length, defaultHeadBudgetUsd);
  const plan: Plan = { ...createPlan({ title: input.title, brief: input.brief, state: 'draft' }), jobs, leadOrigin, ...(unattended ? { unattended } : {}) };
  validatePlan(plan);
  const cycle = findCycle(plan.jobs);
  if (cycle) throw new Error(cycleMessage(plan.jobs, cycle));
  refuseScopeOverlap(plan.jobs);
  return plan;
}

// ---- O2: scope contracts (docs/Heads.md, "Coordination") ----

/** Same prefix rule as inScope (src/core/helperService.ts): a trailing slash is stripped, and '.' means the whole repository, like an empty entry. */
function scopePrefix(entry: string): string {
  const normalized = entry.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized === '.' ? '' : normalized;
}
function prefixesOverlap(a: string, b: string): boolean {
  if (a === '' || b === '') return true; // the whole repository overlaps everything
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
/**
 * The first path two write scopes share, comparing case-insensitively (Hydra
 * ships for Windows only today, where paths differing only in case are the same
 * file). undefined when they share nothing. The shorter (more general) of the
 * two matching entries is returned, since that's the one naming the shared area.
 */
export function writeScopeOverlap(a: readonly string[], b: readonly string[]): string | undefined {
  for (const rawA of a) {
    const prefixA = scopePrefix(rawA);
    for (const rawB of b) {
      const prefixB = scopePrefix(rawB);
      if (!prefixesOverlap(prefixA.toLowerCase(), prefixB.toLowerCase())) continue;
      return prefixA.length <= prefixB.length ? (rawA || '.') : (rawB || '.');
    }
  }
  return undefined;
}

/**
 * Refuses a plan whose independent jobs (neither depends on the other, even
 * through others) would change the same path: they'd run at the same time with
 * no way to keep their changes apart, so this catches the collision before
 * either starts rather than at merge time. Only checked between jobs that both
 * name a write_scope; a canvas-drafted job that never sets one (the canvas has
 * no write_scope field yet) is skipped, so this never refuses one of those.
 */
export function refuseScopeOverlap(jobs: readonly PlanJob[]): void {
  const byKey = new Map(jobs.map(job => [job.key, job]));
  const reachable = (start: string): Set<string> => {
    const seen = new Set<string>(), queue = [start];
    while (queue.length) {
      const current = queue.shift()!;
      for (const dependency of byKey.get(current)?.dependsOn ?? []) if (!seen.has(dependency)) { seen.add(dependency); queue.push(dependency); }
    }
    return seen;
  };
  const closure = new Map(jobs.map(job => [job.key, reachable(job.key)]));
  for (let i = 0; i < jobs.length; i++) {
    for (let j = i + 1; j < jobs.length; j++) {
      const a = jobs[i]!, b = jobs[j]!;
      if (!a.writeScope?.length || !b.writeScope?.length) continue;
      if (closure.get(a.key)!.has(b.key) || closure.get(b.key)!.has(a.key)) continue;
      const path = writeScopeOverlap(a.writeScope, b.writeScope);
      if (path) throw new Error(`Job "${a.key}" and job "${b.key}" both change ${path}, but neither depends on the other. Add a dependency between them, or narrow their write_scope so they don't share paths.`);
    }
  }
}

export class PlanStore {
  private plans = new Map<string, Plan>();
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;
  constructor(private readonly directory: string, private readonly now: () => Date = () => new Date()) {}
  get file(): string { return path.join(this.directory, 'plans.json'); }
  /** O7: where an unattended plan's morning report is kept, alongside plans.json. */
  reportPath(id: string): string { return path.join(this.directory, 'reports', `${id}.md`); }
  async writeReport(id: string, markdown: string): Promise<string> {
    const file = this.reportPath(id);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, markdown, 'utf8');
    return file;
  }

  /** Load the store. A plan left "planning" when Hydra stopped lost its planner process, so it is failed with the reason. */
  async load(): Promise<Plan[]> {
    return this.serialize(async () => {
      await mkdir(this.directory, { recursive: true });
      let parsed: PlanStoreFile = { version: 1, plans: [] };
      try { parsed = parseStoreFile(JSON.parse(await readFile(this.file, 'utf8'))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Hydra plans could not be read: ${error instanceof Error ? error.message : String(error)}`); }
      this.plans = new Map(parsed.plans.map(plan => [plan.id, plan]));
      this.loaded = true;
      let changed = false;
      for (const plan of this.plans.values()) {
        if (plan.state === 'planning') { plan.state = 'failed'; plan.error = 'Hydra stopped while this plan was being drafted.'; plan.updatedAt = this.now().toISOString(); changed = true; }
      }
      if (changed) await this.write();
      return this.list();
    });
  }

  list(): Plan[] { return [...this.plans.values()].map(plan => structuredClone(plan)); }
  get(id: string): Plan | undefined { const plan = this.plans.get(id); return plan && structuredClone(plan); }

  /** Validate and store a whole plan (create or replace). Used by every plan edit, and by the `hydra.plans.save` test command. */
  async save(plan: Plan): Promise<Plan> {
    return this.serialize(async () => {
      this.assertLoaded();
      validatePlan(plan);
      const next = structuredClone(plan);
      next.updatedAt = this.now().toISOString();
      const previous = this.plans.get(plan.id);
      this.plans.set(plan.id, next);
      try { await this.write(); } catch (error) { if (previous) this.plans.set(plan.id, previous); else this.plans.delete(plan.id); throw error; }
      return structuredClone(next);
    });
  }

  /**
   * Change a stored plan in place: `change` gets the plan as it is when this
   * write's turn comes, so two edits queued at once never undo each other (the
   * plan runner starts jobs while you edit others). Returning undefined leaves it
   * as it is. Undefined when there is no such plan.
   */
  async update(id: string, change: (plan: Plan) => Plan | undefined): Promise<Plan | undefined> {
    return this.serialize(async () => {
      this.assertLoaded();
      const previous = this.plans.get(id);
      if (!previous) return undefined;
      const changed = change(structuredClone(previous));
      if (!changed) return structuredClone(previous);
      if (changed.id !== id) throw new Error('A plan update can\'t change its id.');
      validatePlan(changed);
      const next = structuredClone(changed);
      next.updatedAt = this.now().toISOString();
      this.plans.set(id, next);
      try { await this.write(); } catch (error) { this.plans.set(id, previous); throw error; }
      return structuredClone(next);
    });
  }

  async remove(id: string): Promise<void> {
    return this.serialize(async () => {
      this.assertLoaded();
      const previous = this.plans.get(id);
      if (!previous) return;
      this.plans.delete(id);
      try { await this.write(); } catch (error) { this.plans.set(id, previous); throw error; }
    });
  }

  private assertLoaded(): void { if (!this.loaded) throw new Error('Hydra plans are not loaded yet.'); }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async write(): Promise<void> {
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    const body: PlanStoreFile = { version: 1, plans: [...this.plans.values()] };
    await writeFile(temporary, JSON.stringify(body, null, 1), { encoding: 'utf8', mode: 0o600 });
    try { await replaceAtomic(temporary, this.file); } catch (error) { await rm(temporary, { force: true }); throw error; }
  }
}
