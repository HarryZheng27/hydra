import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { git, gitRun, readOnlyGitTimeoutMs } from './git';
import { hydraIdentity, mergeTrees } from './headStart';
import { branchTip } from './laneSync';
import { githubCompareUrl, unlinkLinks } from './laneFinish';
import { isSafeBranchName } from './lanes';
import { evidenceLabel, evidenceStatus, gateBlocks, gateKind, gateState, type EvidenceStatus, type GatesConfigured, type JobCheckResult } from './jobs';
import { rigorReviewGateId, type Gate, type GatesConfig, type ReviewGate } from './gates/config';
import type { Provider } from './model';

/**
 * O3: land it together (docs/Heads.md, "Landing a plan together").
 *
 * Each plan that runs gets an integration branch, `hydra/plan-<id>`, cut from the
 * commit the plan started from. When a job passes its own gates, its commit joins a
 * serial queue that merges it onto that branch; the jobs that depend on it start from
 * the branch's tip, one base that is already merged. When everything has landed, the
 * integration gate runs the project's command gates (and, for a plan with a standard or strict job, one review of the combined diff)
 * on the integrated tree; only a pass offers Merge plan.
 *
 * Shape (the same as every other plan feature): the queue's whole state is data on the
 * plan (`Plan.integration`, `PlanJob.conflict`), so PlanStore persists it and a restart
 * just reloads it. The functions in the first half of this file are pure and decide what
 * the queue does next; the ones in the second half are the only git they need, and never
 * touch a worktree, the index or HEAD, with two exceptions that say so: the integration
 * gate's own detached worktree, and Merge plan, which merges into your checked-out branch.
 */

export const integrationBranchPrefix = 'hydra/plan-';
export const integrationBranch = (planId: string): string => `${integrationBranchPrefix}${planId}`;
/** How many tries a job gets to land before it is held for the lead: its first, and two more after a conflict. */
export const defaultLandingAttempts = 3;
export const conflictFilesMax = 50;

export interface IntegrationQueueEntry { key: string; attempt: number; commit: string; at: string }
export interface IntegrationLanded {
  key: string; attempt: number;
  /** The job's own commit. */
  commit: string;
  /** The integration branch's tip once it landed. */
  tip: string;
  via: 'fast-forward' | 'merge' | 'contained';
  at: string;
}
/** Written before the branch moves and cleared after, so a restart in between can tell whether it moved. */
export interface IntegrationInFlight { key: string; attempt: number; commit: string; from: string; at: string }
export interface IntegrationGateRecord {
  /** The integration tip the gate ran on: a later landing makes it stale. */
  tip: string;
  at: string;
  running?: boolean;
  /** A required gate failed. */
  failed?: boolean;
  /** Set when it didn't fail: the honest evidence label (Step A). */
  status?: EvidenceStatus;
  /** Hydra couldn't run the gate at all (no worktree, say). */
  error?: string;
  checks: JobCheckResult[];
}
export interface PlanIntegration {
  branch: string;
  /** The commit the plan started from. */
  base: string;
  /** The branch the plan started from, which Merge plan merges into. Missing when the checkout was on a detached HEAD. */
  target?: string;
  /** Where Hydra last left the branch. */
  tip: string;
  queue: IntegrationQueueEntry[];
  landed: IntegrationLanded[];
  inFlight?: IntegrationInFlight;
  gate?: IntegrationGateRecord;
  /** The user merged anyway on the canvas, for this tip only. */
  override?: { tip: string; at: string };
  merged?: { via: 'merge' | 'pr'; tip: string; at: string; into?: string; commit?: string; url?: string };
  /** The queue stopped and needs a person: the branch was moved by hand, say. */
  error?: string;
}
/** Why a job's try couldn't land, and the commit its next try carries over. `held`: out of tries, waiting for the lead. */
export interface PlanJobConflict { files: string[]; commit: string; tip: string; count: number; at: string; held?: boolean }

/** The fields of a plan job this file reads and writes (a structural slice of PlanJob, so nothing here imports plans.ts). */
export interface IntegrationJob {
  key: string; title: string; attempt?: number; jobId?: string; laneId?: string;
  result?: unknown; outcome?: unknown; gateFailures?: number; conflict?: PlanJobConflict;
}

// ---- Validation (plans.json is read back from disk) ----

const fullSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const jobKeyPattern = /^[a-z0-9-]{1,24}$/;
const isTime = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 64 && !Number.isNaN(Date.parse(value));
const isSha = (value: unknown): value is string => typeof value === 'string' && fullSha.test(value);
const isAttempt = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 1000;
const isFileList = (value: unknown, max: number): value is string[] => Array.isArray(value) && value.length <= max && value.every(file => typeof file === 'string' && !!file && file.length <= 1000 && !file.includes('\0'));

/** Throws the first problem found. */
export function validateIntegration(value: unknown, planId: string): void {
  const source = value as Partial<PlanIntegration> | undefined;
  if (!source || typeof source !== 'object') throw new Error('A plan\'s integration must be an object.');
  if (source.branch !== integrationBranch(planId)) throw new Error('A plan\'s integration branch must be hydra/plan-<its id>.');
  if (!isSha(source.base) || !isSha(source.tip)) throw new Error('A plan\'s integration needs full commit ids.');
  if (source.target !== undefined && !isSafeBranchName(source.target)) throw new Error('A plan\'s integration target is not a branch name.');
  if (!Array.isArray(source.queue) || source.queue.length > 100) throw new Error('A plan\'s integration queue must be a list.');
  for (const entry of source.queue) {
    if (!entry || !jobKeyPattern.test(String(entry.key)) || !isAttempt(entry.attempt) || !isSha(entry.commit) || !isTime(entry.at)) throw new Error('An integration queue entry is malformed.');
  }
  if (!Array.isArray(source.landed) || source.landed.length > 500) throw new Error('A plan\'s landed list must be a list.');
  for (const entry of source.landed) {
    if (!entry || !jobKeyPattern.test(String(entry.key)) || !isAttempt(entry.attempt) || !isSha(entry.commit) || !isSha(entry.tip) || !isTime(entry.at) || !['fast-forward', 'merge', 'contained'].includes(entry.via)) throw new Error('A landed entry is malformed.');
  }
  const flight = source.inFlight;
  if (flight !== undefined && (!flight || !jobKeyPattern.test(String(flight.key)) || !isAttempt(flight.attempt) || !isSha(flight.commit) || !isSha(flight.from) || !isTime(flight.at))) throw new Error('An in-flight landing is malformed.');
  const gate = source.gate;
  if (gate !== undefined) {
    if (!gate || !isSha(gate.tip) || !isTime(gate.at) || !Array.isArray(gate.checks) || gate.checks.length > 48) throw new Error('An integration gate record is malformed.');
    const statuses: readonly EvidenceStatus[] = ['passed', 'partial', 'none', 'none-chosen', 'override'];
    if (gate.status !== undefined && !statuses.includes(gate.status)) throw new Error('An integration gate record has an unknown status.');
    if (gate.error !== undefined && (typeof gate.error !== 'string' || gate.error.length > 2000)) throw new Error('An integration gate record has an invalid error.');
  }
  if (source.override !== undefined && (!source.override || !isSha(source.override.tip) || !isTime(source.override.at))) throw new Error('An integration override is malformed.');
  const merged = source.merged;
  if (merged !== undefined && (!merged || (merged.via !== 'merge' && merged.via !== 'pr') || !isSha(merged.tip) || !isTime(merged.at)
    || (merged.into !== undefined && !isSafeBranchName(merged.into)) || (merged.commit !== undefined && !isSha(merged.commit)) || (merged.url !== undefined && (typeof merged.url !== 'string' || merged.url.length > 8000)))) throw new Error('An integration merge record is malformed.');
  if (source.error !== undefined && (typeof source.error !== 'string' || !source.error || source.error.length > 2000)) throw new Error('An integration error must be text.');
}

/** Throws the first problem found. */
export function validateJobConflict(value: unknown, where: string): void {
  const conflict = value as Partial<PlanJobConflict> | undefined;
  if (!conflict || typeof conflict !== 'object' || !isFileList(conflict.files, conflictFilesMax) || !isSha(conflict.commit) || !isSha(conflict.tip)
    || !isAttempt(conflict.count) || !isTime(conflict.at) || (conflict.held !== undefined && typeof conflict.held !== 'boolean')) throw new Error(`${where} has a malformed conflict record.`);
}

// ---- The queue, as pure decisions ----

export function newIntegration(planId: string, base: string, target?: string): PlanIntegration {
  if (!isSha(base)) throw new Error('An integration branch starts from a full commit id.');
  return { branch: integrationBranch(planId), base, ...(target && isSafeBranchName(target) ? { target } : {}), tip: base, queue: [], landed: [] };
}

/** This try's landing, if it landed. */
export const landedEntry = (integration: Pick<PlanIntegration, 'landed'>, key: string, attempt: number): IntegrationLanded | undefined =>
  integration.landed.find(entry => entry.key === key && entry.attempt === attempt);
/** 0-based place in the queue, or -1. */
export const queuePosition = (integration: Pick<PlanIntegration, 'queue'>, key: string, attempt: number): number =>
  integration.queue.findIndex(entry => entry.key === key && entry.attempt === attempt);

/** Adds a job's commit to the back of the queue, once per try. */
export function enqueue(integration: PlanIntegration, key: string, attempt: number, commit: string, now: () => Date = () => new Date()): PlanIntegration {
  if (!isSha(commit)) throw new Error(`Job "${key}" has no full commit id to land.`);
  if (landedEntry(integration, key, attempt) || queuePosition(integration, key, attempt) !== -1) return integration;
  return { ...integration, queue: [...integration.queue, { key, attempt, commit, at: now().toISOString() }] };
}

export type LandingOutcome = { kind: 'landed'; tip: string; via: IntegrationLanded['via'] } | { kind: 'conflict'; files: string[] };

/**
 * What one landing does to the plan (pure). Landed: the queue's head moves to `landed` and the tip
 * moves. Conflict: it leaves the queue and its job spends a try: with tries left the job is reset
 * to run again from the integration tip (its old commit carried over and a "## Conflict" section in
 * its brief, see conflictSection); out of tries it is held for the lead, with the files named.
 */
export function applyLanding<J extends IntegrationJob>(current: { integration?: PlanIntegration; jobs: J[] }, entry: Pick<IntegrationQueueEntry, 'key' | 'attempt' | 'commit'>, outcome: LandingOutcome, now: () => Date = () => new Date(), attempts = defaultLandingAttempts): { integration: PlanIntegration; jobs: J[] } {
  const integration = current.integration;
  if (!integration) throw new Error('This plan has no integration branch.');
  const at = now().toISOString();
  const queue = integration.queue.filter(item => !(item.key === entry.key && item.attempt === entry.attempt));
  const { inFlight: _inFlight, ...rest } = integration;
  if (outcome.kind === 'landed') {
    const landed: IntegrationLanded = { key: entry.key, attempt: entry.attempt, commit: entry.commit, tip: outcome.tip, via: outcome.via, at };
    const jobs = current.jobs.map(job => job.key === entry.key && job.conflict ? withoutConflict(job) : job);
    return { integration: { ...rest, queue, tip: outcome.tip, landed: [...integration.landed.filter(item => !(item.key === entry.key && item.attempt === entry.attempt)), landed] }, jobs };
  }
  const files = outcome.files.slice(0, conflictFilesMax);
  const jobs = current.jobs.map(job => {
    if (job.key !== entry.key || (job.attempt ?? 0) !== entry.attempt) return job;
    const count = (job.conflict?.count ?? 0) + 1;
    const conflict: PlanJobConflict = { files, commit: entry.commit, tip: integration.tip, count, at };
    if (count >= attempts) return { ...job, conflict: { ...conflict, held: true } };
    const { jobId: _jobId, laneId: _laneId, result: _result, outcome: _outcome, gateFailures: _gateFailures, ...fresh } = job;
    return { ...fresh, attempt: (job.attempt ?? 0) + 1, conflict } as J;
  });
  return { integration: { ...rest, queue }, jobs };
}
const withoutConflict = <J extends IntegrationJob>(job: J): J => { const { conflict: _conflict, ...rest } = job; return rest as J; };

/** A retry (Retry failed jobs, hydra_plan_amend's retry) gives a held job a fresh set of tries; its files and commit stay for the brief and the carry-over. */
export function releaseConflict(conflict: PlanJobConflict | undefined): PlanJobConflict | undefined {
  if (!conflict) return undefined;
  const { held: _held, ...rest } = conflict;
  return { ...rest, count: 0 };
}

/** The "## Conflict" section a re-queued job's brief gets. */
export function conflictSection(conflict: PlanJobConflict, branch: string, carried = true): string {
  const files = conflict.files.length ? conflict.files.map(file => `- ${file}`).join('\n') : '- (git named no files)';
  return [
    '## Conflict',
    '',
    `Your previous try (commit ${conflict.commit.slice(0, 12)}) passed its gates but could not be merged onto the plan's integration branch ${branch}: jobs that landed first changed the same lines. The conflicting files:`,
    files,
    '',
    carried
      ? 'This try starts from the integration branch\'s tip, which already has their work. Hydra has merged your previous try into your worktree where it could; the files above have git conflict markers (<<<<<<<, =======, >>>>>>>). Resolve them so both changes survive, keep the rest of your earlier work, then call hydra_done as usual.'
      : `This try starts from the integration branch's tip, which already has their work. Redo your change on top of it: merge commit ${conflict.commit.slice(0, 12)} into this branch and resolve the files above so both changes survive, then commit.`,
  ].join('\n');
}

/** Facts about the branch, gathered by reconcileFacts, for reconcile below. */
export interface ReconcileFacts {
  /** The branch's tip now, or undefined when it no longer exists. */
  actual?: string;
  /** actual contains the recorded tip. */
  containsTip: boolean;
  /** actual contains the in-flight commit. */
  containsInFlight: boolean;
  /**
   * actual is exactly the in-flight landing Hydra would have made from where it left the branch: the job's
   * commit itself (a fast-forward), or a merge commit whose parents are those two and whose tree is their merge.
   */
  landedExactly?: boolean;
}
export type Reconcile =
  | { kind: 'ok' }
  /** The branch moved for the in-flight landing, but Hydra stopped before writing it down. */
  | { kind: 'landedBeforeRestart'; tip: string; via: 'fast-forward' | 'merge' }
  /** The in-flight landing never moved the branch: drop the note and land it again. */
  | { kind: 'retry' }
  /** The branch is gone: put it back where Hydra left it. */
  | { kind: 'recreate' }
  /**
   * The branch isn't where Hydra left it and it wasn't Hydra's own landing: the queue stops for a person.
   * `added`: it only gained commits on top. Those are never taken in: every commit on the branch must be a
   * job's work that passed that job's own gates and write scope, and a head shares the repository's git
   * metadata, so it could otherwise put anything there.
   */
  | { kind: 'moved'; actual: string; added: boolean };

/** How the recorded state and the real branch fit together, and what to do about it (pure). Checked before every landing and on every start. */
export function reconcile(integration: Pick<PlanIntegration, 'tip' | 'inFlight'>, facts: ReconcileFacts): Reconcile {
  const flight = integration.inFlight;
  if (!facts.actual) return { kind: 'recreate' };
  if (facts.actual === integration.tip) return flight ? { kind: 'retry' } : { kind: 'ok' };
  if (flight && flight.from === integration.tip && facts.containsInFlight && facts.containsTip && facts.landedExactly) return { kind: 'landedBeforeRestart', tip: facts.actual, via: facts.actual === flight.commit ? 'fast-forward' : 'merge' };
  return { kind: 'moved', actual: facts.actual, added: facts.containsTip };
}

/** The integration gate's one-line state, the honest label the plan shows. */
export function integrationGateLabel(gate: IntegrationGateRecord | undefined, tip: string): string {
  if (!gate) return 'Integration gate not run';
  if (gate.running) return 'Integration gate running';
  if (gate.tip !== tip) return 'Integration gate out of date (more work landed since)';
  if (gate.error) return `Integration gate couldn't run: ${gate.error}`;
  if (gate.failed) return 'Integration gate failed';
  return gate.status ? evidenceLabel(gate.status, gate.checks) : 'Integration gate not run';
}

/** The record a finished gate run leaves (pure): Step A's evidence status, or failed. */
export function gateRecord(tip: string, checks: JobCheckResult[], configured: GatesConfigured, now: () => Date = () => new Date()): IntegrationGateRecord {
  const failed = checks.some(gateBlocks);
  const status = failed ? undefined : evidenceStatus({ checks, configured }) ?? (checks.length ? undefined : 'none-chosen');
  return { tip, at: now().toISOString(), checks, ...(failed ? { failed: true } : {}), ...(status ? { status } : {}) };
}

/** Rounds of automatic fixes after a failed integration gate, unless the window says otherwise. */
export const defaultIntegrationFixRounds = 2;
/** The job key of a plan's nth automatic fix. */
export const integrationFixKey = (round: number): string => `integration-fix-${round}`;
const integrationFixPattern = /^integration-fix-\d+$/;
/** A plan's automatic fix job: added only once every other job has landed, and the next only once it has, so it never runs alongside another. */
export const isIntegrationFixKey = (key: string): boolean => integrationFixPattern.test(key);

/**
 * The job that fixes what a failed integration gate found (pure; docs/Heads.md, "Landing a plan together"), or
 * undefined when there is nothing to hand a head: the gate didn't fail (or couldn't run at all), or the plan has
 * had its rounds. It starts from the integration branch's tip like any plan job, may change the whole repository,
 * and runs the project's own gates only: the integration gate, run again once it lands, reviews it with the rest.
 */
export function integrationFixJob(plan: { title: string; jobs: readonly { key: string }[] }, record: IntegrationGateRecord, rounds = defaultIntegrationFixRounds): { key: string; title: string; brief: string; write_scope: string[]; rigor: 'quick' } | undefined {
  if (!record.failed || record.error || rounds <= 0) return undefined;
  const round = plan.jobs.filter(job => integrationFixPattern.test(job.key)).length + 1;
  if (round > rounds) return undefined;
  const failed = record.checks.filter(gateBlocks);
  if (!failed.length) return undefined;
  const sections = failed.map(check => {
    const lines = [`### ${check.id} (${gateKind(check)}) failed${check.summary ? `: ${oneLine(check.summary)}` : ''}`];
    for (const finding of (check.findings ?? []).slice(0, 20)) lines.push(`- [${finding.severity}]${finding.file ? ` ${finding.file}${finding.line ? `:${finding.line}` : ''}` : ''}: ${oneLine(finding.note)}`);
    if (gateKind(check) === 'command' && check.outputTail.trim()) lines.push('Last output:', '```', check.outputTail.trim().slice(-1500), '```');
    return lines.join('\n');
  });
  const brief = [
    `Every job of plan "${plan.title}" has landed on its integration branch, which you start from, but the plan's integration gate failed on the combined work.`,
    'Fix the blocker and major findings below, across whatever files that takes, without undoing what the jobs built; minor ones are optional, so leave them unless a fix is quick and safe. Keep every existing test passing, and add tests for what you fix. Then finish as usual: the integration gate runs again on the result.',
    '',
    ...sections,
  ].join('\n');
  return {
    key: integrationFixKey(round),
    title: rounds > 1 ? `Fix the integration gate's findings (round ${round} of ${rounds})` : "Fix the integration gate's findings",
    brief: brief.length > fixBriefMax ? `${brief.slice(0, fixBriefMax - 1)}…` : brief,
    write_scope: ['.'],
    rigor: 'quick',
  };
}
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 600);
/** plans.ts's planJobBriefMax: plans.ts imports this module, so the number is repeated rather than imported (tests/integration.test.ts checks they agree). */
const fixBriefMax = 4000;

/**
 * For a plan that has stopped running: true once its integration gate has nothing more to say on its own. A done
 * plan with work landed runs the gate by itself, so until a result for the current tip is in, a wait keeps waiting
 * (including the moment before that run starts). Anything else (incomplete, the queue stopped, already merged,
 * nothing landed, no integration branch) is settled now.
 */
export function integrationSettled(plan: { state: string; integration?: Pick<PlanIntegration, 'tip' | 'base' | 'gate' | 'error' | 'merged'> }): boolean {
  const integration = plan.integration;
  if (!integration || plan.state !== 'done' || integration.error || integration.merged || integration.tip === integration.base) return true;
  return !!integration.gate && !integration.gate.running && integration.gate.tip === integration.tip;
}

/**
 * Why a plan lane's own Merge must refuse (pure): its plan lands through an integration branch, so the job's work
 * reaches your branch only with the rest of the plan, after the integration gate. Mark job done lands it there.
 * Undefined for a plan without one (it started before Hydra had them), or once the plan was merged.
 */
export function laneMergeRefusal(plan: { title: string; integration?: Pick<PlanIntegration, 'branch' | 'target' | 'merged'> }, job: { title: string }): string | undefined {
  const integration = plan.integration;
  if (!integration || integration.merged) return undefined;
  return `This lane runs job "${job.title}" of plan "${plan.title}", which lands on ${integration.branch} and reaches ${integration.target ?? 'your branch'} only with the rest of the plan, once its integration gate has passed. Use Mark job done instead of Merge.`;
}

/** True when the integration gate passed every required gate on the branch's current tip. */
export const integrationPassed = (integration: Pick<PlanIntegration, 'gate' | 'tip'>): boolean =>
  !!integration.gate && !integration.gate.running && integration.gate.tip === integration.tip && !integration.gate.failed && !integration.gate.error && integration.gate.status === 'passed';

/**
 * Why Merge plan (or Open PR, or hydra_plan_merge) must refuse now, or undefined (pure). Only a gate that
 * passed on the current tip, "Passed required gates", lets it through, or your override on the canvas for
 * this same tip; nothing while work is still landing or the gate is running.
 */
export function mergeRefusal(plan: { title: string; integration?: PlanIntegration }): string | undefined {
  const integration = plan.integration;
  if (!integration) return `Plan "${plan.title}" has no integration branch: it started before Hydra had one, or hasn't run yet.`;
  if (integration.error) return `The integration queue stopped: ${integration.error}`;
  if (integration.merged && integration.merged.tip === integration.tip) return `Plan "${plan.title}" is already ${integration.merged.via === 'pr' ? 'pushed for a pull request' : `merged into ${integration.merged.into ?? 'its branch'}`}.`;
  if (integration.queue.length || integration.inFlight) return `${integration.queue.length || 1} job(s) are still landing on ${integration.branch}. Wait for them, then run the integration gate.`;
  if (integration.tip === integration.base) return `Nothing has landed on ${integration.branch} yet.`;
  if (integration.gate?.running) return 'The integration gate is still running.';
  if (integration.override?.tip === integration.tip) return undefined;
  if (!integration.gate) return `The integration gate hasn't run on ${integration.branch} yet. Run it first (hydra_plan_integrate).`;
  if (integration.gate.tip !== integration.tip) return `The integration gate ran on an older tip of ${integration.branch}; more work has landed since. Run it again (hydra_plan_integrate).`;
  if (!integrationPassed(integration)) return `The integration gate says "${integrationGateLabel(integration.gate, integration.tip)}", and only "Passed required gates" can merge. Fix it and run the gate again, or the user can merge anyway from the canvas.`;
  return undefined;
}

/**
 * The gates the integration gate runs (pure): the project's command gates, always; with a standard or strict
 * job in the plan (O6), also one review of the whole diff by the other provider: the project's own review gates,
 * or rigor's review when it has none. Screenshots belong to each job's own gates, not this one.
 */
export function integrationGates(config: Pick<GatesConfig, 'gates'> & { notRun?: JobCheckResult[] }, review: boolean): { gates: Gate[]; notRun: JobCheckResult[] } {
  const commands = config.gates.filter(gate => gate.type === 'command');
  const reviews = config.gates.filter((gate): gate is ReviewGate => gate.type === 'review');
  const reviewGates: ReviewGate[] = !review ? [] : reviews.length ? reviews : [{ id: rigorReviewGateId, type: 'review', required: true, reviewer: 'other', focus: 'Review the combined change of every job in this plan for correctness, safety and whether the pieces fit together.' }];
  const wanted = new Set<string>(['command', ...(review ? ['review'] : [])]);
  return { gates: [...commands, ...reviewGates], notRun: (config.notRun ?? []).filter(result => wanted.has(gateKind(result))) };
}

/** Who "wrote" the integrated diff, for the review's "other" (O6): with both providers among the jobs, no reviewer is independent, and the evidence says so. */
export function integrationAuthors(providers: readonly Provider[], fallback: Provider): { author: Provider; priorAuthors: Provider[] } {
  const unique = [...new Set(providers)];
  if (!unique.length) return { author: fallback, priorAuthors: [] };
  return { author: unique[0]!, priorAuthors: unique.slice(1) };
}

/** O3: a plan's integration branch as the lead's hydra_plan_* tools show it. */
export interface IntegrationLeadView {
  branch: string; base_commit: string; tip: string; target?: string;
  /** Job keys, in the order they landed. */
  landed: string[];
  /** Job keys waiting to land, first in line first. */
  queue: string[];
  gate: { label: string; tip?: string; stale?: boolean; running?: boolean; checks?: { id: string; kind: string; state: string; required: boolean; summary?: string }[] };
  can_merge: boolean;
  /** The integration gate passed every required gate on the branch as it is now ("Passed required gates"). */
  passed: boolean;
  /** Nothing more is coming from the integration gate on its own (integrationSettled): what `hydra plan wait` waits for. */
  settled: boolean;
  merge_refused?: string;
  merged?: PlanIntegration['merged'];
  error?: string;
}
/** The lead's view of the integration branch (pure). */
export function integrationLeadView(plan: { title: string; state: string; integration?: PlanIntegration }): IntegrationLeadView | undefined {
  const integration = plan.integration;
  if (!integration) return undefined;
  const gate = integration.gate;
  const refusal = mergeRefusal(plan);
  return {
    branch: integration.branch, base_commit: integration.base, tip: integration.tip, ...(integration.target ? { target: integration.target } : {}),
    landed: integration.landed.map(entry => entry.key), queue: integration.queue.map(entry => entry.key),
    gate: {
      label: integrationGateLabel(gate, integration.tip),
      ...(gate ? { tip: gate.tip, ...(gate.tip !== integration.tip ? { stale: true } : {}), ...(gate.running ? { running: true } : {}) } : {}),
      ...(gate?.checks.length ? { checks: gate.checks.map(check => ({ id: check.id, kind: gateKind(check), state: gateState(check), required: check.required, ...(check.summary ? { summary: check.summary } : {}) })) } : {}),
    },
    can_merge: !refusal, passed: integrationPassed(integration), settled: integrationSettled(plan), ...(refusal ? { merge_refused: refusal } : {}),
    ...(integration.merged ? { merged: integration.merged } : {}),
    ...(integration.error ? { error: integration.error } : {}),
  };
}

/** A short "### Integration gate" section for Open PR's body. */
export function integrationChecksSection(integration: Pick<PlanIntegration, 'gate' | 'tip' | 'branch'>): string {
  const gate = integration.gate;
  const lines = ['### Integration gate', '', integrationGateLabel(gate, integration.tip)];
  if (gate?.checks.length) {
    lines.push('');
    for (const check of gate.checks.slice(0, 20)) { const state = gateState(check); lines.push(`- ${state === 'passed' ? '✓' : state === 'notRun' ? '–' : '✗'} ${check.id} (${gateKind(check)})`); }
  }
  lines.push('', `${integration.branch} at ${integration.tip.slice(0, 7)}`);
  return lines.join('\n');
}

// ---- Git ----

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 300);
async function isAncestor(repository: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await gitRun(repository, ['merge-base', '--is-ancestor', ancestor, descendant]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new Error(result.stderr.trim() || `git merge-base exited with ${result.code}.`);
}
const assertBranch = (branch: string) => { if (!branch.startsWith(integrationBranchPrefix) || !isSafeBranchName(branch)) throw new Error(`${branch} isn't a Hydra integration branch.`); };

/** The commit and branch the main checkout is on now: where a plan's integration branch starts. */
export async function integrationStart(repository: string): Promise<{ base: string; target?: string }> {
  const base = (await git(repository, ['rev-parse', '--verify', 'HEAD^{commit}'], undefined, readOnlyGitTimeoutMs)).trim();
  const symbolic = await gitRun(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const target = symbolic.code === 0 ? symbolic.stdout.trim() : undefined;
  return { base, ...(target && isSafeBranchName(target) ? { target } : {}) };
}

/** Moves `branch` from `from` to `to`, only if it is still at `from` (git's own compare-and-swap). `from` '' means it must not exist yet. */
async function moveBranch(repository: string, branch: string, to: string, from: string, why: string): Promise<void> {
  const result = await gitRun(repository, ['update-ref', '-m', `hydra: ${why}`, `refs/heads/${branch}`, to, from]);
  if (result.code !== 0) throw new Error(`git couldn't move ${branch}: ${describe(result.stderr || result.stdout)}`);
}

/** Creates the plan's branch at `base`, or accepts it when it is already there (a start whose record wasn't saved). */
export async function ensureIntegrationBranch(repository: string, branch: string, base: string): Promise<void> {
  assertBranch(branch);
  const tip = await branchTip(repository, branch);
  if (tip === base) return;
  if (tip) throw new Error(`The branch ${branch} already exists at another commit. Delete or rename it, then run the plan again.`);
  await moveBranch(repository, branch, base, '', 'start the integration branch');
}

/** The facts reconcile() needs. */
export async function reconcileFacts(repository: string, integration: Pick<PlanIntegration, 'branch' | 'tip' | 'inFlight'>): Promise<ReconcileFacts> {
  const actual = await branchTip(repository, integration.branch);
  if (!actual || actual === integration.tip) return { ...(actual ? { actual } : {}), containsTip: !!actual, containsInFlight: false };
  const containsTip = await isAncestor(repository, integration.tip, actual).catch(() => false);
  const flight = integration.inFlight;
  const containsInFlight = flight ? await isAncestor(repository, flight.commit, actual).catch(() => false) : false;
  const landedExactly = flight && containsInFlight && containsTip ? await isExactLanding(repository, flight, actual).catch(() => false) : false;
  return { actual, containsTip, containsInFlight, landedExactly };
}
async function isExactLanding(repository: string, flight: Pick<IntegrationInFlight, 'from' | 'commit'>, actual: string): Promise<boolean> {
  if (actual === flight.commit) return true;
  const parents = (await git(repository, ['rev-list', '--parents', '-n', '1', actual])).trim().split(/\s+/).slice(1);
  if (parents.length !== 2 || parents[0] !== flight.from || parents[1] !== flight.commit) return false;
  const merged = await mergeTrees(repository, flight.from, flight.commit);
  if ('conflicts' in merged) return false;
  return (await git(repository, ['rev-parse', `${actual}^{tree}`], undefined, readOnlyGitTimeoutMs)).trim() === merged.tree;
}

/** Puts a deleted integration branch back where Hydra left it; throws when that commit is gone too. */
export async function recreateIntegrationBranch(repository: string, integration: Pick<PlanIntegration, 'branch' | 'tip'>): Promise<void> {
  assertBranch(integration.branch);
  if ((await gitRun(repository, ['cat-file', '-e', `${integration.tip}^{commit}`])).code !== 0) throw new Error(`${integration.branch} was deleted, and its last commit ${integration.tip.slice(0, 7)} is gone too.`);
  await moveBranch(repository, integration.branch, integration.tip, '', 'recreate the integration branch');
}

/** Worktrees that have `branch` checked out: Hydra never moves a branch someone has checked out. */
async function checkedOutAt(repository: string, branch: string): Promise<string | undefined> {
  const listed = await git(repository, ['worktree', 'list', '--porcelain', '-z']);
  let worktree: string | undefined;
  for (const line of listed.split('\0')) {
    if (line.startsWith('worktree ')) worktree = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}`) return worktree ?? '(unknown)';
  }
  return undefined;
}

/**
 * Lands one job's commit on the integration branch, which must still be at `from`: a fast-forward when the
 * job started from `from`; nothing when it is already in; else a merge commit made in the object database
 * (`git merge-tree --write-tree`, then `commit-tree`), never in a worktree or the index. A conflict moves
 * nothing and names the files. The branch moves with update-ref's compare-and-swap.
 */
export async function landCommit(repository: string, branch: string, from: string, commit: string, message: string): Promise<LandingOutcome> {
  assertBranch(branch);
  if (!isSha(from) || !isSha(commit)) throw new Error('Landing needs full commit ids.');
  const holder = await checkedOutAt(repository, branch);
  if (holder) throw new Error(`${branch} is checked out in ${holder}; Hydra only moves it while nobody has it checked out.`);
  if (await isAncestor(repository, commit, from)) return { kind: 'landed', tip: from, via: 'contained' };
  if (await isAncestor(repository, from, commit)) {
    await moveBranch(repository, branch, commit, from, message);
    return { kind: 'landed', tip: commit, via: 'fast-forward' };
  }
  const merged = await mergeTrees(repository, from, commit);
  if ('conflicts' in merged) return { kind: 'conflict', files: merged.conflicts };
  const next = (await git(repository, ['commit-tree', merged.tree, '-p', from, '-p', commit, '-m', message], hydraIdentity)).trim();
  if (!isSha(next)) throw new Error('git commit-tree gave no commit.');
  await moveBranch(repository, branch, next, from, message);
  return { kind: 'landed', tip: next, via: 'merge' };
}

/**
 * The integration gate's own place to run: a detached worktree at `tip` (never the branch itself, so the
 * branch is never checked out), under the worktree root, with git's hooks off. Removed afterwards, links
 * unlinked first, retrying while Windows still holds a file a gate's process just let go of.
 */
export async function withGateWorktree<T>(repository: string, root: string, planId: string, tip: string, work: (worktree: string) => Promise<T>): Promise<T> {
  if (!/^[a-f0-9]{12}$/.test(planId) || !isSha(tip)) throw new Error('Invalid integration gate input.');
  if (!path.isAbsolute(root)) throw new Error('The worktree root must be an absolute path.');
  await mkdir(root, { recursive: true });
  const worktree = path.join(root, `ig-${planId}-${randomBytes(3).toString('hex')}`);
  const hooksOff = await mkdtemp(path.join(root, 'nh-'));
  try {
    // No timeout: a checkout, so a kill mid-command could leave the new worktree half-populated
    // or its lock files behind.
    await git(repository, ['-c', `core.hooksPath=${hooksOff}`, 'worktree', 'add', '--detach', worktree, tip]);
    try { return await work(worktree); }
    finally { await removeGateWorktree(repository, worktree); }
  } finally { await rm(hooksOff, { recursive: true, force: true }).catch(() => undefined); }
}
async function removeGateWorktree(repository: string, worktree: string): Promise<void> {
  const exists = await lstat(worktree).then(() => true, () => false);
  if (exists) await unlinkLinks(worktree).catch(() => undefined);
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await gitRun(repository, ['worktree', 'remove', '--force', '--force', worktree]);
    if (result.code === 0 || /is not a working tree/i.test(result.stderr)) break;
    await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
  }
  if (await lstat(worktree).then(() => true, () => false)) await rm(worktree, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  await gitRun(repository, ['worktree', 'prune']).catch(() => undefined);
}

/**
 * Merge plan: `git merge --no-edit` of the integration branch into the branch the plan started from, in
 * the main checkout, which must be on that branch (a fast-forward when nothing else moved it, else a merge
 * commit). A merge git stops halfway is aborted, so nothing changes; git's message is the error.
 */
export async function mergeIntegration(repository: string, integration: Pick<PlanIntegration, 'branch' | 'tip' | 'target'>, title: string): Promise<{ commit: string; into: string }> {
  assertBranch(integration.branch);
  const target = integration.target;
  if (!target) throw new Error(`The plan started on a detached HEAD, so there's no branch to merge into. Use Open PR, or merge ${integration.branch} yourself.`);
  const symbolic = await gitRun(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const current = symbolic.code === 0 ? symbolic.stdout.trim() : undefined;
  if (current !== target) throw new Error(`The main checkout is on ${current ?? 'a detached HEAD'}, not ${target}. Switch it back to ${target} to merge the plan.`);
  if (await branchTip(repository, integration.branch) !== integration.tip) throw new Error(`${integration.branch} isn't where Hydra left it; run the integration gate again.`);
  const message = `Merge Hydra plan "${title.replace(/[\r\n]+/g, ' ').slice(0, 150)}" (${integration.branch})`;
  const result = await gitRun(repository, ['merge', '--no-edit', '-m', message, `refs/heads/${integration.branch}`]);
  if (result.code !== 0) {
    if ((await gitRun(repository, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], undefined, readOnlyGitTimeoutMs)).code === 0) await gitRun(repository, ['merge', '--abort']);
    throw new Error(`git refused the merge: ${(result.stderr.trim() || result.stdout.trim()).split('\n').slice(0, 6).join(' ')}`);
  }
  return { commit: (await git(repository, ['rev-parse', 'HEAD'], undefined, readOnlyGitTimeoutMs)).trim(), into: target };
}

/** Open PR: push the integration branch to origin (the lanes' own push, never prompting) and give GitHub's compare page, with the gate's result as the body. */
export async function pushIntegration(repository: string, integration: Pick<PlanIntegration, 'branch' | 'tip' | 'target' | 'gate'>): Promise<{ branch: string; compareUrl?: string }> {
  assertBranch(integration.branch);
  const remote = await gitRun(repository, ['remote', 'get-url', 'origin']);
  if (remote.code !== 0) throw new Error('This repository has no "origin" remote to push to.');
  const pushed = await gitRun(repository, ['push', '-u', 'origin', `refs/heads/${integration.branch}:refs/heads/${integration.branch}`], { GIT_TERMINAL_PROMPT: '0' }, 180_000);
  if (pushed.code !== 0) throw new Error(`git couldn't push ${integration.branch}: ${(pushed.stderr.trim() || pushed.stdout.trim()).split('\n').slice(0, 6).join(' ')}`);
  const body = encodeURIComponent(integrationChecksSection(integration));
  const compareUrl = integration.target ? githubCompareUrl(remote.stdout, integration.target, integration.branch, body) : undefined;
  return { branch: integration.branch, ...(compareUrl ? { compareUrl } : {}) };
}

/**
 * The carry-over for a job re-queued after a conflict: its previous try's commit merged into its fresh
 * worktree (`--no-commit`, hooks off), so the clean parts carry over and the conflicting files keep git's
 * markers for the head to resolve. hydra_done's own commit then records both parents. Best effort: when
 * git can't even start the merge, it is aborted and the head starts clean (its brief still names the files).
 */
export async function carryOver(worktree: string, commit: string, hooksOff: string): Promise<'merged' | 'conflicts' | 'skipped'> {
  if (!isSha(commit)) return 'skipped';
  const result = await gitRun(worktree, ['-c', `core.hooksPath=${hooksOff}`, '-c', 'user.name=Hydra', '-c', 'user.email=heads@hydra.invalid', 'merge', '--no-ff', '--no-commit', commit]);
  if (result.code === 0) return 'merged';
  const conflicted = (await gitRun(worktree, ['diff', '--name-only', '--diff-filter=U'], undefined, readOnlyGitTimeoutMs)).stdout.trim();
  if (conflicted) return 'conflicts';
  if ((await gitRun(worktree, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], undefined, readOnlyGitTimeoutMs)).code === 0) await gitRun(worktree, ['merge', '--abort']);
  return 'skipped';
}

