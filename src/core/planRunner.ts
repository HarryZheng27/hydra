import { readFile } from 'node:fs/promises';
import { gitRun, readOnlyGitTimeoutMs } from './git';
import { DependencyConflict, capDiff, dependencyBase, dependencyBrief, dependencyDiff, maxDependencyDiff, type DependencyResult } from './headStart';
import { gateBlocks, gateKind, type EvidenceStatus, type GatesConfigured, type JobCheckResult, type JobLimits, type JobState } from './jobs';
import {
  applyLanding, applySeamVerdict, conflictSection, isIntegrationFixKey, defaultLandingAttempts, defaultSeamFixRounds, effectiveDependencies, isIntegrationGateFixKey, seamVerdict, type LandingOutcome, enqueue, ensureIntegrationBranch, gateRecord, findingFiles, fixDiffMax, integrationFixJobs, integrationStart, landCommit, landedEntry, mergeIntegration, mergeRefusal,
  newIntegration, pushIntegration, queuePosition, reconcile, reconcileFacts, recreateIntegrationBranch, releaseConflict, warmFixSections, type FixContext, type IntegrationGateRecord, type PlanIntegration,
} from './integration';
import type { LaneCloseMode, LaneState } from './lanes';
import { singleHeadDecision, singleHeadJobBrief, singleHeadKey, singleHeadLimits, singleHeadPlan } from './planShape';
import type { StopSwitch } from './stopSwitch';
import {
  applyPlanAmendment, cycleMessage, findCycle, jobRunAs, jobStarted, planOutcomeReasonMax, planResultFilesMax, planResultNoteMax, topologicalOrder,
  validatePlanDispatch, type Plan, type PlanDispatch, type PlanJob, type PlanJobOutcome, type PlanJobRunAs, type PlanStore,
} from './plans';

/**
 * Running a plan whose jobs are heads or lanes (docs/internal/Plan_Lanes_Plan.md, section 2).
 *
 * `planSteps` is pure: from a plan and a look at its heads and lanes it gives each
 * job's status and what to do next. `PlanRunner` applies those steps on one queue
 * per plan, so two events never start the same job twice, and acts only through
 * injected starters, so tests use fakes. Nothing here knows about VS Code.
 */
export type PlanJobStatus = 'draft' | 'waiting' | 'active' | 'held' | 'done' | 'failed' | 'cancelled' | 'skipped';

/** What the runner needs to know about one head. */
export interface PlanHeadLook {
  state: JobState; title: string; limitHit?: boolean; reason?: string; branch?: string;
  result?: { commit: string; summary: string; changedFiles: string[]; status?: EvidenceStatus };
}
/** What the runner needs to know about one lane, closed or not. */
export interface PlanLaneLook {
  name: string; state: LaneState; branch: string; baseCommit: string;
  /** The lane HEAD that Merge merged. */
  mergedHead?: string;
  closedAs?: LaneCloseMode;
  /** Step A: the lane's last recorded evidence status, carried onto a merged job's result. */
  gatesStatus?: EvidenceStatus;
}
/** The runner's view of this window's heads and lanes. */
export interface PlanLook {
  head(jobId: string): PlanHeadLook | undefined;
  /** Undefined once the lane is gone from the store. */
  lane(laneId: string): PlanLaneLook | undefined;
  /** Open lanes whose plan link names a job of this plan: a start whose record was never saved is adopted. */
  planLanes(planId: string): { laneId: string; jobKey: string; attempt: number }[];
  /** False while this window has no lanes (not a trusted Git folder, or they failed to start): lane jobs neither start nor fail then. */
  lanesAvailable(): boolean;
}

/** One job as the canvas and the Lanes view show it. */
export interface PlanJobView {
  key: string; runAs: PlanJobRunAs; status: PlanJobStatus;
  /** A plain-English line: "Waiting for Schema, Auth", "Schema did not finish.", "Lane closed before its job was done." */
  reason?: string;
  jobId?: string; laneId?: string;
  /** The work it handed on (a head's result, a lane's recorded result or merge). */
  commit?: string;
  /** Step A: the evidence status for `commit`, when one was recorded. Named apart from `status` (the job's run status) above. */
  evidenceStatus?: EvidenceStatus;
  /** A lane job that was ready while the window started: Start lane starts it. */
  startable?: boolean;
  /** Step C: a lane job of a plan that auto-dispatches: its try against the gates ("attempt 2 of 3"). */
  dispatch?: { attempt: number; attempts: number };
  /** O3: the files a job held for the lead conflicts in, on the plan's integration branch. */
  conflict?: string[];
}
export type PlanRecord =
  | { key: string; kind: 'outcome'; outcome: Omit<PlanJobOutcome, 'at'> }
  | { key: string; kind: 'adopt'; laneId: string }
  | { key: string; kind: 'merged'; laneId: string; commit: string; status?: EvidenceStatus }
  /** O3: a job's work passed its gates: it joins the plan's landing queue. */
  | { key: string; kind: 'enqueue'; attempt: number; commit: string };
export interface PlanSteps {
  /** Every job, in the plan's order. */
  jobs: PlanJobView[];
  /** Facts to write down: skipped and failed jobs, adopted lanes, lanes done by merging. */
  record: PlanRecord[];
  /** Jobs to start now, dependencies first. */
  start: { key: string; runAs: PlanJobRunAs }[];
  /** What the plan's state becomes: done when every job is done; incomplete when nothing is left to wait for. */
  state: 'running' | 'done' | 'incomplete';
}
export interface PlanStepOptions {
  /** Lane jobs that were ready while the window started (keyed by job key): they wait for Start lane. */
  deferred?: ReadonlySet<string>;
  /** Why a job couldn't start yet, by job key ("Waiting: 24 lanes are open"). */
  waits?: ReadonlyMap<string, string>;
}

const ended: ReadonlySet<PlanJobStatus> = new Set(['failed', 'cancelled', 'skipped']);
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…` : text;
const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Each job's status and the next steps (pure; docs/internal/Plan_Lanes_Plan.md, "Job status" and "When a job starts").
 * - A lane job starts when every job it depends on is done.
 * - A head job starts when every lane job it depends on is done and every head job it depends on has
 *   started (HelperService then holds it until those heads are done). Jobs are walked dependencies
 *   first, so a chain of heads behind a lane is created in one pass.
 * - A job never starts after a dependency failed, was cancelled or was skipped: it is skipped. A held
 *   dependency (a head at its usage limit) makes it wait instead.
 */
export function planSteps(plan: Plan, look: PlanLook, options: PlanStepOptions = {}): PlanSteps {
  const byKey = new Map(plan.jobs.map(job => [job.key, job]));
  // A seam check that failed makes the jobs that depend on the job it blamed wait for its fix too (effectiveDependencies).
  const seams = plan.integration?.seams;
  const waitsFor = (job: PlanJob): string[] => effectiveDependencies(job, seams);
  const walked = seams?.length ? plan.jobs.map(job => ({ ...job, dependsOn: waitsFor(job) })) : plan.jobs;
  const cycle = findCycle(walked);
  const order = cycle ? plan.jobs.map(job => job.key).sort() : topologicalOrder(walked);
  const status = new Map<string, PlanJobStatus>();
  const views = new Map<string, PlanJobView>();
  const record: PlanRecord[] = [];
  const start: PlanSteps['start'] = [];
  const startingHeads = new Set<string>();
  const lanesAvailable = look.lanesAvailable();
  const adoptable = new Map<string, { laneId: string; attempt: number }>();
  if (lanesAvailable) for (const entry of look.planLanes(plan.id)) if (!adoptable.has(entry.jobKey)) adoptable.set(entry.jobKey, entry);
  const title = (key: string) => byKey.get(key)?.title ?? key;
  const integration = plan.integration;
  // Step C: with Auto-dispatch on, a ready lane job starts when one of the plan's lane slots is free. Every lane
  // job still running in a lane takes one, counted up front (adoptable lanes too), so a job walked early never
  // takes the slot of a lane found later in the walk.
  const dispatch = plan.dispatch;
  let busy = 0;
  if (dispatch && lanesAvailable) {
    for (const job of plan.jobs) {
      if (jobRunAs(job) !== 'lane' || job.outcome || job.result) continue;
      if (job.laneId) { const lane = look.lane(job.laneId); if (lane && lane.state !== 'closed' && !lane.mergedHead) busy++; }
      else if (adoptable.get(job.key)?.attempt === (job.attempt ?? 0)) busy++;
    }
  }

  for (const key of order) {
    const job = byKey.get(key)!;
    const runAs = jobRunAs(job);
    const view: PlanJobView = { key, runAs, status: 'waiting', ...(job.jobId ? { jobId: job.jobId } : {}), ...(job.laneId ? { laneId: job.laneId } : {}) };
    views.set(key, view);
    const set = (next: PlanJobStatus, reason?: string) => { view.status = next; if (reason) view.reason = reason; status.set(key, next); };
    if (dispatch && runAs === 'lane') view.dispatch = { attempt: Math.min((job.gateFailures ?? 0) + 1, dispatch.attempts), attempts: dispatch.attempts };
    const fail = (reason: string) => { record.push({ key, kind: 'outcome', outcome: { state: 'failed', reason } }); set('failed', reason); };

    if (job.outcome) { set(job.outcome.state, job.outcome.reason); continue; }
    // O3: out of tries to land on the integration branch; held for the lead (a retry gives it more).
    if (integration && job.conflict?.held) {
      view.conflict = job.conflict.files;
      set('failed', clip(`Couldn't land on ${integration.branch} after ${job.conflict.count} ${job.conflict.count === 1 ? 'try' : 'tries'}: conflicts in ${job.conflict.files.join(', ') || 'files git did not name'}.`, 500));
      continue;
    }
    /** Work that passed its gates: done at once without an integration branch; with one, done once it has landed there. */
    const finished = (commit: string | undefined, evidence?: EvidenceStatus) => {
      if (evidence) view.evidenceStatus = evidence;
      if (!integration || !commit) { if (commit) view.commit = commit; set('done'); return; }
      view.commit = commit;
      const attempt = job.attempt ?? 0;
      if (landedEntry(integration, key, attempt)) { set('done'); return; }
      if (queuePosition(integration, key, attempt) === -1) record.push({ key, kind: 'enqueue', attempt, commit });
      set('active', landingReason(integration, key, attempt));
    };
    if (runAs === 'lane' && job.result) { finished(job.result.commit, job.result.status); continue; }
    if (runAs === 'head' && job.jobId) {
      const head = look.head(job.jobId);
      if (!head) set('failed', 'Its head is gone from this window.');
      else if (head.state === 'done') finished(head.result?.commit, head.result?.status);
      else if (head.state === 'failed' && head.limitHit) set('held', head.reason || 'Its agent hit a usage limit.');
      else if (head.state === 'failed') set('failed', head.reason || 'Its head failed.');
      else if (head.state === 'cancelled') set('cancelled', head.reason || 'Its head was cancelled.');
      else set('active');
      continue;
    }
    if (runAs === 'lane' && job.laneId) {
      // Without lanes in this window a lane can't be looked at: the job is neither done nor failed.
      if (!lanesAvailable) { set('active', 'Lanes aren\'t available in this window.'); continue; }
      const lane = look.lane(job.laneId);
      if (lane?.mergedHead) {
        record.push({ key, kind: 'merged', laneId: job.laneId, commit: lane.mergedHead, ...(lane.gatesStatus ? { status: lane.gatesStatus } : {}) });
        view.commit = lane.mergedHead; if (lane.gatesStatus) view.evidenceStatus = lane.gatesStatus;
        // O3: it joins the landing queue once its result is written down (the next round).
        if (integration) set('active', `Merged; landing on ${integration.branch} next.`); else set('done');
        continue;
      }
      if (!lane || lane.state === 'closed') { fail(`Lane closed before its job was done${lane?.closedAs === 'keep' ? ` (branch ${lane.branch} kept)` : ''}.`); continue; }
      set('active');
      continue;
    }

    // ---- Not started ----
    if (job.draft) { set('draft', 'Added after the plan ran: Run plan starts it.'); continue; }
    // A lane whose plan link names this job, from a start whose record was never saved (a crash in between).
    const found = runAs === 'lane' ? adoptable.get(key) : undefined;
    if (found && found.attempt === (job.attempt ?? 0)) { record.push({ key, kind: 'adopt', laneId: found.laneId }); view.laneId = found.laneId; set('active'); continue; }
    const dependencies = waitsFor(job).filter(dependency => byKey.has(dependency));
    const broken = dependencies.find(dependency => ended.has(status.get(dependency)!));
    if (broken) {
      const reason = `${title(broken)} did not finish.`;
      record.push({ key, kind: 'outcome', outcome: { state: 'skipped', reason } });
      set('skipped', reason);
      continue;
    }
    if (cycle && cycle.includes(key)) { set('waiting', cycleMessage(plan.jobs, cycle)); continue; }
    const blocking = dependencies.filter(dependency => {
      const current = status.get(dependency);
      // O3: with an integration branch every job starts from its tip, so it waits for what it depends on to land there.
      if (integration || runAs === 'lane' || jobRunAs(byKey.get(dependency)!) === 'lane') return current !== 'done';
      // A head only needs its head dependencies started; a held one makes it wait, so giving up on that head skips it.
      return !(current === 'done' || (current === 'active' && (!!byKey.get(dependency)!.jobId || startingHeads.has(dependency))));
    });
    if (blocking.length) {
      const names = blocking.map(title).join(', ');
      set('waiting', runAs === 'lane' ? `Starts as a lane when ${names} ${blocking.length === 1 ? 'is' : 'are'} done` : integration ? `Waiting for ${names} to land` : `Waiting for ${names}`);
      continue;
    }
    if (runAs === 'head') { start.push({ key, runAs }); startingHeads.add(key); set('active', 'Starting…'); continue; }
    if (!lanesAvailable) { set('waiting', 'Waiting: lanes aren\'t available in this window.'); continue; }
    if (dispatch) {
      if (busy >= dispatch.lanes) { set('waiting', `Waiting for a free lane (${dispatch.lanes} of ${dispatch.lanes} in use).`); continue; }
      busy++;
    } else if (options.deferred?.has(key)) { view.startable = true; set('waiting', 'Ready to start: press Start lane.'); continue; }
    start.push({ key, runAs });
    set('waiting', options.waits?.get(key) ?? 'Starting…');
  }

  const jobs = plan.jobs.map(job => views.get(job.key)!);
  const state: PlanSteps['state'] = jobs.length && jobs.every(job => job.status === 'done') ? 'done'
    : start.length || jobs.some(job => job.status === 'waiting' || job.status === 'active' || job.status === 'held') ? 'running' : 'incomplete';
  return { jobs, record, start, state };
}

/** O3: where a job whose work passed its gates stands in its plan's landing queue. */
function landingReason(integration: PlanIntegration, key: string, attempt: number): string {
  if (integration.error) return clip(`Passed its gates, but can't land: ${integration.error}`, 500);
  if (integration.inFlight?.key === key && integration.inFlight.attempt === attempt) return `Landing on ${integration.branch}…`;
  const place = queuePosition(integration, key, attempt);
  if (place <= 0) return `Passed its gates; landing on ${integration.branch} next.`;
  return `Passed its gates; ${place} ${place === 1 ? 'job' : 'jobs'} ahead of it in the landing queue for ${integration.branch}.`;
}

/**
 * Why Run plan must refuse up front, or undefined: a lane job needs a terminal, and this build may have none
 * (docs/internal/Plan_Lanes_Plan.md, "When it can't start yet"). Names the lane jobs to switch to Head.
 */
export function planRunRefusal(plan: Pick<Plan, 'jobs'>, terminals: boolean): string | undefined {
  if (terminals) return undefined;
  const lanes = plan.jobs.filter(job => jobRunAs(job) === 'lane' && !jobStarted(job));
  return lanes.length ? `This build of Hydra has no terminals, so lane jobs can't run. Switch ${lanes.map(job => job.title).join(', ')} to Head.` : undefined;
}

/** A plan head's idempotency key: a retried head gets `-r<attempt>`, because the old key would return the old head. */
export const planHeadKey = (plan: Pick<Plan, 'id'>, job: Pick<PlanJob, 'key' | 'attempt'>): string => `plan-${plan.id}-${job.key}${job.attempt ? `-r${job.attempt}` : ''}`;

/**
 * What a plan's head job starts with (`hydra_start_head`'s input). A job with no write scope, such as
 * one added by hand, may change the whole repository: `"."` (an empty entry is refused).
 */
export function planHeadInput(plan: Pick<Plan, 'id' | 'title' | 'integration'> & Partial<Pick<Plan, 'brief' | 'singleHead'>>, job: Pick<PlanJob, 'key' | 'attempt' | 'title' | 'brief' | 'writeScope' | 'provider' | 'model' | 'role' | 'rigor' | 'conflict'>, dependsOn: string[], headDefaults?: JobLimits): Record<string, unknown> {
  // A plan run as one head (src/core/planShape.ts): its one job's head gets the plan and every job's own brief,
  // and, given your per-head defaults, as much time, turns and budget as its jobs would have had together.
  const single = plan.singleHead && job.key === singleHeadKey ? plan.singleHead : undefined;
  const own = single ? singleHeadJobBrief({ ...plan, singleHead: single }, job) : job.brief;
  // O3: a try re-queued after a conflict on the integration branch hears which files, and that its old work was carried over.
  const brief = plan.integration && job.conflict ? `${own}\n\n${conflictSection(job.conflict, plan.integration.branch)}` : own;
  return {
    title: job.title, brief, write_scope: job.writeScope?.length ? job.writeScope : ['.'],
    ...(job.provider ? { provider: job.provider } : {}), ...(job.model ? { model: job.model } : {}), ...(job.role ? { role: job.role } : {}), idempotency_key: planHeadKey(plan, job),
    // O6: rigor (docs/Heads.md, "Rigor") — hydra_start_head's own schema has no such property, so
    // only a plan job ever sets it. A plan saved before rigor existed has none: HelperService then
    // adds nothing beyond the project's own gates, exactly as it always has.
    ...(job.rigor ? { rigor: job.rigor } : {}),
    depends_on: dependsOn, lead_label: `Plan · ${plan.title}`.slice(0, 60),
    ...(single && headDefaults ? { limits: singleHeadLimits(headDefaults, single.jobs.length) } : {}),
  };
}

// ---- The runner ----

/**
 * A plan lane's .hydra-job/brief.md: the job's whole brief, then what the jobs it depends on handed on
 * (their notes or commit subjects, and changed files), as a head's brief has them (docs/internal/Plan_Lanes_Plan.md, decision 2).
 */
export function planLaneBrief(planTitle: string, job: Pick<PlanJob, 'title' | 'brief' | 'conflict'>, dependencies: readonly DependencyResult[], integrationBranchName?: string): string {
  const handedOn = dependencies.length ? `\n${dependencyBrief(dependencies)}\n` : '';
  // O3: a lane's worktree starts clean from the integration tip; its previous try is a commit it can merge itself.
  const conflict = job.conflict && integrationBranchName ? `\n${conflictSection(job.conflict, integrationBranchName, false)}\n` : '';
  return `# ${job.title}\n\nJob "${job.title}" of Hydra plan "${planTitle}". Hydra wrote this file for the lane; it is never committed.\n\n${job.brief.trim()}\n${handedOn}${conflict}`;
}

export interface PlanLaneStart {
  /** The commit the lane starts from: its dependencies' work, merged when there are several. Missing: the main checkout's HEAD. */
  baseCommit?: string;
  /** What the jobs it depends on handed on, for its first prompt. */
  dependencies: DependencyResult[];
}
export interface PlanRunnerOptions {
  store: Pick<PlanStore, 'get' | 'list' | 'update'>;
  look: PlanLook;
  /** The main checkout: a lane job's dependencies are merged into one starting commit here. */
  repository: string;
  /**
   * Start a head job. `dependsOn` are the ids of the head jobs it depends on; `inputs` the results of its lane jobs.
   * O3: with an integration branch, `start` names the commit it starts from (the branch's tip, which already has
   * every job it depends on), `dependsOn` is empty and `inputs` are all its dependencies, for its brief only;
   * `carry` is a previous try's commit to merge into its worktree after a conflict.
   */
  startHead(plan: Plan, job: PlanJob, dependsOn: string[], inputs: DependencyResult[], start?: { baseCommit: string; carry?: string }): Promise<{ jobId: string }>;
  /** Start a lane job, or say why it has to wait (24 lanes open). */
  startLane(plan: Plan, job: PlanJob, start: PlanLaneStart): Promise<{ laneId: string } | { wait: string }>;
  /** Cancel job on a head job: stop the head (or give up on one held at its usage limit). */
  cancelHead(jobId: string, reason: string): Promise<void>;
  /** Cancel job on a lane job: the lane stays open, without its plan link. */
  unlinkLane(laneId: string): Promise<void>;
  /** The subjects of the commits between two commits (at most 10, newest first), for a lane's summary. */
  commitSubjects(from: string, to: string): Promise<string[]>;
  /** The files changed between two commits, for a lane job done by merging. */
  changedFiles(from: string, to: string): Promise<string[]>;
  /** A lane-job's lane needs a terminal: Run plan refuses without one. */
  terminalsAvailable(): boolean;
  /** A plan's jobs or statuses changed. */
  onChange?(planId: string): void;
  /** O7: a plan just left 'running' (done or incomplete) — the morning report and its notification go here. */
  onSettled?(plan: Plan): void;
  /**
   * Small plans run as one head (docs/Heads.md, src/core/planShape.ts): read on a plan's first Run. True lets
   * Hydra run a small, tightly coupled plan as one head (hydra.plans.singleHeadForSmallPlans). Missing means off.
   */
  singleHead?(): boolean;
  /** How many heads may run at once (hydra.maxConcurrentHelpers), for the single-head decision. Missing means no cap. */
  maxConcurrent?(): number;
  /** O3: a plan's integration gate run finished (its record is on the plan): the morning report waits for this. */
  onGateDone?(plan: Plan): void;
  /** The runner started a plan's lane (the extension says so, with Show lane). */
  onLaneStarted?(plan: Plan, job: PlanJob, laneId: string): void;
  log?(line: string): void;
  now?(): Date;
  debounceMs?: number;
  // ---- 5.3: Stop All Agents ----
  /** Without it, a plan always advances (as before 5.3). */
  stop?: StopSwitch;
  // ---- O3: the integration branch and the integration gate (docs/Heads.md, "Landing a plan together") ----
  /**
   * Present means on: a plan's first Run cuts `hydra/plan-<id>` in `repository`, jobs land there through a
   * serial queue, dependents start from its tip, and the integration gate runs once everything has landed.
   * Without it, plans run as they did before O3 (tests of the runner alone, with no git repository).
   */
  integration?: PlanIntegrationOptions;
}

export interface PlanIntegrationOptions {
  /** Run the integration gate on the integrated tree at `tip`: the project's command gates, and one review of the combined diff for a plan with a standard or strict job. */
  runGate(plan: Plan, tip: string): Promise<{ checks: JobCheckResult[]; configured: GatesConfigured }>;
  /** Tries a job gets to land before it is held for the lead. Default 3. */
  attempts?: number;
  /**
   * Rounds of automatic fixes after a failed integration gate (integrationFixJob): each adds a job that starts from
   * the branch's tip with the gate's findings, and the gate runs again once it lands. Default 2; 0 turns it off.
   */
  fixRounds?(): number;
  /** The per-head budget an unattended plan's fix job is estimated at (hydra.heads.defaultBudgetUsd). Default 5. */
  headBudgetUsd?(): number;
  /**
   * The seam check (docs/Heads.md, "Seam checks"): the project's `onLanding` command gates run on the integrated tree at `tip`,
   * right after the job `key` landed there. No checks means none are configured. Without this option nothing is checked
   * (as before). A check Hydra can't run (it throws) never holds a plan up.
   */
  landingCheck?(plan: Plan, tip: string, key: string): Promise<JobCheckResult[]>;
  /** Fix rounds after one landing's seam check fails. Default 2; 0 turns the fixes off (a failing check then only logs). */
  seamFixRounds?(): number;
}
/** What hydra_plan_merge (or the canvas) asked for. */
export type PlanMergeVia = 'merge' | 'pr';
/** O3: how long a stopped landing queue waits before a plan event may try it again. */
export const queueRetryMs = 30_000;

/** What Mark job done records (docs/internal/Plan_Lanes_Plan.md, "What done means for a lane job"). */
export interface PlanLaneResultInput { commit: string; note?: string; changedFiles: string[]; status?: EvidenceStatus }

export class PlanRunner {
  private readonly queues = new Map<string, Promise<unknown>>();
  /** `<planId>:<key>` of lane jobs that were ready while the window started. */
  private readonly deferred = new Set<string>();
  /**
   * Step C: plans whose Auto-dispatch you turned off in this window. Their lane jobs that are or become ready
   * wait for Start lane, as at window start, instead of starting by themselves; Run plan or Retry lifts it.
   */
  private readonly undispatched = new Set<string>();
  private readonly waits = new Map<string, string>();
  private readonly shown = new Map<string, string>();
  private readonly soon = new Set<string>();
  private soonAll = false;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  constructor(private readonly options: PlanRunnerOptions) {}

  /**
   * Run one plan's work in turn: every advance and every job action for a plan waits for the one
   * before it, so two events can't start the same job twice.
   */
  withPlan<T>(planId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(planId) ?? Promise.resolve();
    const run = previous.then(work, work);
    const settled = run.then(() => undefined, () => undefined);
    this.queues.set(planId, settled);
    void settled.then(() => { if (this.queues.get(planId) === settled) this.queues.delete(planId); });
    return run;
  }

  /** Apply one plan's steps until nothing more changes. `startup`: lane jobs that are ready wait for Start lane. */
  advance(planId: string, options: { startup?: boolean } = {}): Promise<void> {
    return this.withPlan(planId, () => this.pass(planId, options));
  }
  /** Every running plan (at startup, with `startup`). O3: also every integration gate a restart cut short, or never started. */
  async advanceAll(options: { startup?: boolean } = {}): Promise<void> {
    await Promise.all(this.options.store.list().filter(plan => plan.state === 'running').map(plan => this.advance(plan.id, options)));
    if (this.options.integration) await this.resumeGates();
  }
  /** Debounced (200 ms): after heads and lanes change. Without an id, every running plan. */
  advanceSoon(planId?: string): void {
    if (this.disposed) return;
    if (planId) this.soon.add(planId); else this.soonAll = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const ids = this.soonAll ? this.options.store.list().filter(plan => plan.state === 'running').map(plan => plan.id) : [...this.soon];
      this.soon.clear(); this.soonAll = false;
      for (const id of ids) void this.advance(id).catch(error => this.options.log?.(`[plans] ${id}: ${describe(error)}`));
    }, this.options.debounceMs ?? 200);
    this.timer.unref?.();
  }
  dispose(): void { this.disposed = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }

  /** Each job's status now (pure; for the canvas, the Lanes view and the Hydra panel). */
  statuses(planId: string): PlanJobView[] | undefined {
    const plan = this.options.store.get(planId);
    return plan && planSteps(plan, this.options.look, this.stepOptions(plan.id)).jobs;
  }
  /** The plan job a lane runs, if any: found by the job's lane id. */
  jobForLane(laneId: string): { plan: Plan; job: PlanJob; view: PlanJobView } | undefined {
    for (const plan of this.options.store.list()) {
      const job = plan.jobs.find(item => item.laneId === laneId);
      if (!job) continue;
      const view = planSteps(plan, this.options.look, this.stepOptions(plan.id)).jobs.find(item => item.key === job.key)!;
      return { plan, job, view };
    }
    return undefined;
  }

  // ---- Actions (each on the plan's queue) ----

  /**
   * Run plan: refuses a plan being drafted, a done or empty plan, a cycle and, without terminals, lane jobs.
   * Jobs added with + Job since the last run are released; jobs that already started never start again.
   */
  run(planId: string): Promise<void> {
    return this.withPlan(planId, async () => {
      const plan = this.options.store.get(planId);
      if (!plan) throw new Error(`No plan ${planId}.`);
      if (plan.state === 'planning') throw new Error('This plan is still being drafted.');
      if (plan.state === 'done') throw new Error('This plan is already done.');
      if (!plan.jobs.length) throw new Error('Add a job to this plan first.');
      const cycle = findCycle(plan.jobs);
      if (cycle) throw new Error(cycleMessage(plan.jobs, cycle));
      const refusal = planRunRefusal(plan, this.options.terminalsAvailable());
      if (refusal) throw new Error(refusal);
      // O3: the first Run cuts the plan's integration branch from where the main checkout is now. A plan that
      // already started jobs before Hydra had integration branches carries on without one, as it began.
      const integration = this.options.integration && !plan.integration && !plan.jobs.some(jobStarted) ? await this.startIntegration(planId) : undefined;
      this.undispatched.delete(planId);
      // A plan that hasn't started yet may run as one head, decided from its shape once (src/core/planShape.ts).
      const firstRun = !plan.singleHead && !plan.startedAt && !plan.jobs.some(jobStarted) && !!this.options.singleHead?.();
      let decided: string | undefined;
      await this.options.store.update(planId, current => {
        const decision = firstRun && !current.singleHead && !current.jobs.some(jobStarted) ? singleHeadDecision(current, this.options.maxConcurrent?.()) : undefined;
        decided = decision ? `${decision.single ? 'runs as one head' : 'runs one head per job'}: ${decision.reason}` : undefined;
        return {
          ...(integration && !current.integration ? { integration } : {}),
          ...current, state: 'running', error: undefined, jobs: current.jobs.map(({ draft: _draft, ...job }) => job),
          ...(decision?.single ? singleHeadPlan(current, decision.reason) : {}),
          // O7: the wall-clock budget (docs/Heads.md, "Unattended plans") measures from here, set once.
          ...(current.startedAt ? {} : { startedAt: new Date().toISOString() }),
        };
      });
      if (decided) this.options.log?.(`[plans] Plan ${plan.title} ${decided}.`);
      await this.pass(planId, {});
    });
  }

  /** Retry failed jobs (incomplete → running): failed, cancelled and skipped jobs start again, each counting one more attempt. */
  retry(planId: string): Promise<void> {
    return this.withPlan(planId, async () => {
      const plan = this.options.store.get(planId);
      if (!plan) throw new Error(`No plan ${planId}.`);
      if (plan.state !== 'incomplete') throw new Error('Only an incomplete plan\'s jobs can be retried.');
      const again = new Set(planSteps(plan, this.options.look, this.stepOptions(planId)).jobs.filter(view => ended.has(view.status)).map(view => view.key));
      if (!again.size) throw new Error('This plan has no failed jobs to retry.');
      const refusal = planRunRefusal({ jobs: plan.jobs.filter(job => again.has(job.key)).map(job => ({ ...job, jobId: undefined, laneId: undefined, result: undefined, outcome: undefined })) }, this.options.terminalsAvailable());
      if (refusal) throw new Error(refusal);
      await this.options.store.update(planId, current => ({
        ...current, state: 'running',
        jobs: current.jobs.map(job => {
          if (!again.has(job.key)) return job;
          const { jobId: _jobId, laneId: _laneId, result: _result, outcome: _outcome, gateFailures: _gateFailures, conflict, ...rest } = job;
          // O3: a job held after its tries to land ran out gets a fresh set; its files and commit stay for its brief.
          const released = releaseConflict(conflict);
          return { ...rest, attempt: (job.attempt ?? 0) + 1, ...(released ? { conflict: released } : {}) };
        }),
      }));
      for (const key of again) { this.waits.delete(`${planId}:${key}`); this.deferred.delete(`${planId}:${key}`); }
      this.undispatched.delete(planId);
      await this.pass(planId, {});
    });
  }

  /** Start lane, on a lane job that was ready while the window started. */
  startJob(planId: string, key: string): Promise<void> {
    return this.withPlan(planId, async () => {
      if (!this.deferred.delete(`${planId}:${key}`)) throw new Error('That job isn\'t waiting to be started.');
      await this.pass(planId, { release: key });
    });
  }

  /**
   * Mark job done: record what a lane job hands on and start the jobs that wait for it. Pressing it
   * again moves the result forward, but only while no job that depends on it has started (decision 3).
   */
  markLaneDone(planId: string, key: string, laneId: string, input: PlanLaneResultInput, options: { first?: boolean } = {}): Promise<void> {
    return this.withPlan(planId, async () => {
      const plan = this.options.store.get(planId);
      const job = plan?.jobs.find(item => item.key === key);
      if (!plan || !job || jobRunAs(job) !== 'lane' || job.laneId !== laneId) throw new Error('That lane doesn\'t run this plan job any more.');
      if (job.outcome) throw new Error(`Job ${job.title} has already ended.`);
      // Step C: Auto-dispatch never moves a result: one you recorded by hand while its gates ran wins.
      if (options.first && job.result) throw new Error(`Job ${job.title} is already done.`);
      const started = plan.jobs.filter(item => item.dependsOn.includes(key) && (item.jobId || item.laneId || item.result));
      if (job.result && started.length) throw new Error(`${started.map(item => item.title).join(', ')} already started from ${job.result.commit.slice(0, 7)}, so this job's result can't move.`);
      if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.commit)) throw new Error('Mark job done needs a full commit id.');
      const note = input.note?.trim() ? clip(input.note.trim(), planResultNoteMax) : undefined;
      const result = { commit: input.commit, via: 'marked' as const, at: this.now().toISOString(), ...(note ? { note } : {}), changedFiles: input.changedFiles.slice(0, planResultFilesMax), ...(input.status ? { status: input.status } : {}) };
      await this.options.store.update(planId, current => ({ ...current, jobs: current.jobs.map(item => item.key === key ? { ...item, result } : item) }));
      await this.pass(planId, {});
    });
  }

  /**
   * Cancel job (docs/internal/Plan_Lanes_Plan.md, "Failures"): a head is stopped (a held one given up on); a lane
   * stays open as an ordinary lane, without its plan link; the jobs that depend on it are skipped.
   */
  cancelJob(planId: string, key: string, reason = 'Cancelled.'): Promise<void> {
    return this.withPlan(planId, async () => {
      const plan = this.options.store.get(planId);
      const job = plan?.jobs.find(item => item.key === key);
      if (!plan || !job) throw new Error('That job isn\'t in this plan.');
      const view = planSteps(plan, this.options.look, this.stepOptions(planId)).jobs.find(item => item.key === key)!;
      if (view.status === 'done') throw new Error(`Job ${job.title} is already done.`);
      if (ended.has(view.status)) throw new Error(`Job ${job.title} has already ended.`);
      const outcome: PlanJobOutcome = { state: 'cancelled', reason: clip(reason, planOutcomeReasonMax), at: this.now().toISOString() };
      if (job.jobId) await this.options.cancelHead(job.jobId, reason);
      await this.options.store.update(planId, current => ({ ...current, jobs: current.jobs.map(item => item.key === key && !item.outcome && !item.result ? { ...item, outcome } : item) }));
      this.waits.delete(`${planId}:${key}`); this.deferred.delete(`${planId}:${key}`);
      if (job.laneId) await this.options.unlinkLane(job.laneId).catch(error => this.options.log?.(`[plans] ${planId}: couldn't unlink lane ${job.laneId}: ${describe(error)}`));
      await this.pass(planId, {});
    });
  }

  // ---- Step C: Auto-dispatch to lanes ----

  /**
   * Turn Auto-dispatch on (with its settings) or off. Turning it on starts the lane jobs that are ready, as
   * slots allow; turning it off stops new starts (ready jobs wait for Start lane) and leaves running lanes alone.
   */
  setDispatch(planId: string, dispatch: PlanDispatch | undefined): Promise<void> {
    return this.withPlan(planId, async () => {
      const next = dispatch && validatePlanDispatch(dispatch);
      const was = !!this.options.store.get(planId)?.dispatch;
      const plan = await this.options.store.update(planId, current => {
        if (current.state === 'planning' || current.state === 'done') throw new Error(current.state === 'done' ? 'This plan is already done.' : 'This plan is still being drafted.');
        const { dispatch: _dispatch, ...rest } = current;
        return next ? { ...rest, dispatch: next } : rest;
      });
      if (!plan) throw new Error(`No plan ${planId}.`);
      if (next) this.undispatched.delete(planId); else if (was) this.undispatched.add(planId);
      this.options.log?.(`[plans] ${planId} auto-dispatch ${next ? `on (${next.lanes} lanes, ${next.provider}, ${next.attempts} attempts)` : 'off'}`);
      await this.pass(planId, {});
    });
  }

  /**
   * An auto-dispatched lane job's gates failed: count it. When that uses up the plan's attempts the job fails
   * ("Gates failed 3 times: …") and the jobs after it are skipped. With Auto-dispatch turned off meanwhile the
   * failure is counted but never fails the job: the lane is yours again. Undefined when the lane no longer
   * runs this job, or the job has already ended (a manual Mark job done or Cancel job came first).
   */
  recordGateFailure(planId: string, key: string, laneId: string, summary: string): Promise<{ failures: number; attempts?: number; failed: boolean } | undefined> {
    return this.withPlan(planId, async () => {
      const plan = this.options.store.get(planId);
      const job = plan?.jobs.find(item => item.key === key);
      if (!plan || !job || job.laneId !== laneId || job.outcome || job.result) return undefined;
      const failures = (job.gateFailures ?? 0) + 1, attempts = plan.dispatch?.attempts;
      const failed = attempts !== undefined && failures >= attempts;
      const outcome: PlanJobOutcome | undefined = failed ? { state: 'failed', reason: clip(`Gates failed ${failures} ${failures === 1 ? 'time' : 'times'}: ${summary.replace(/\s+/g, ' ').trim()}`, planOutcomeReasonMax), at: this.now().toISOString() } : undefined;
      await this.options.store.update(planId, current => ({ ...current, jobs: current.jobs.map(item => item.key === key && item.laneId === laneId && !item.outcome && !item.result ? { ...item, gateFailures: failures, ...(outcome ? { outcome } : {}) } : item) }));
      this.options.log?.(`[plans] ${planId} job ${key}: gates failed (${failures}${attempts ? ` of ${attempts}` : ''})${failed ? '; the job failed' : ''}`);
      await this.pass(planId, {});
      return { failures, ...(attempts !== undefined ? { attempts } : {}), failed };
    });
  }

  // ---- O3: the integration branch and the integration gate (docs/Heads.md, "Landing a plan together") ----

  /** Cuts the plan's integration branch from where the main checkout is now (or accepts one a crashed start already cut). */
  private async startIntegration(planId: string): Promise<PlanIntegration> {
    const { base, target } = await integrationStart(this.options.repository);
    const integration = newIntegration(planId, base, target);
    await ensureIntegrationBranch(this.options.repository, integration.branch, base);
    this.options.log?.(`[plans] ${planId} integration branch ${integration.branch} at ${base.slice(0, 7)}${target ? ` (from ${target})` : ''}`);
    return integration;
  }

  /**
   * The landing queue, one job at a time, on the plan's own queue (so nothing else moves the plan meanwhile).
   * Each landing first checks the branch against the record (reconcile), writes down what it's about to do
   * (inFlight), moves the branch, then writes down the outcome; a restart anywhere in between is resolved
   * by the next reconcile. True when anything changed.
   */
  private async drain(planId: string): Promise<boolean> {
    const repository = this.options.repository, attempts = this.options.integration?.attempts ?? defaultLandingAttempts;
    let progressed = false;
    for (let round = 0; round < 100 && !this.disposed; round++) {
      const plan = this.options.store.get(planId);
      const integration = plan?.integration;
      if (!plan || !integration || plan.state !== 'running') break;
      let facts;
      try { facts = await reconcileFacts(repository, integration); }
      catch (error) {
        if (!integration.error) await this.stopQueue(planId, `Hydra couldn't read ${integration.branch}: ${describe(error)}`);
        return !integration.error;
      }
      const verdict = reconcile(integration, facts);
      if (integration.error) {
        // A stopped queue goes on once the branch is back where Hydra left it (the fix its reason asks for), at the
        // next plan event at least queueRetryMs after it stopped, so a landing that keeps failing never spins.
        const stopped = this.queueStops.get(planId);
        if ((verdict.kind !== 'ok' && verdict.kind !== 'retry') || (stopped !== undefined && this.now().getTime() - stopped < queueRetryMs)) break;
        await this.options.store.update(planId, current => { if (!current.integration) return undefined; const { error: _error, ...rest } = current.integration; return { ...current, integration: rest }; });
        this.options.log?.(`[plans] ${planId}: ${integration.branch} is back at ${integration.tip.slice(0, 7)}; the landing queue goes on`);
        progressed = true; continue;
      }
      if (verdict.kind === 'recreate') {
        try { await recreateIntegrationBranch(repository, integration); }
        catch (error) { await this.stopQueue(planId, describe(error)); return true; }
        this.options.log?.(`[plans] ${planId}: ${integration.branch} was gone; put it back at ${integration.tip.slice(0, 7)}`);
        continue;
      }
      if (verdict.kind === 'moved') {
        await this.stopQueue(planId, verdict.added
          ? `${integration.branch} gained commits Hydra didn't land (now at ${verdict.actual.slice(0, 7)}). Only jobs' checked work goes on this branch, so Hydra won't take them in. Move it back to ${integration.tip.slice(0, 7)} for the queue to go on; to add that work, give it to a job.`
          : `${integration.branch} was moved by hand to ${verdict.actual.slice(0, 7)}, which doesn't contain what Hydra landed (${integration.tip.slice(0, 7)}). Move it back to ${integration.tip.slice(0, 7)} for the queue to go on.`);
        return true;
      }
      if (verdict.kind === 'landedBeforeRestart') {
        const flight = integration.inFlight!;
        await this.options.store.update(planId, current => current.integration ? { ...current, ...applyLanding(current, flight, { kind: 'landed', tip: verdict.tip, via: verdict.via }, () => this.now(), attempts) } : undefined);
        this.options.log?.(`[plans] ${planId}: job ${flight.key} had landed before Hydra stopped; recorded it`);
        progressed = true; continue;
      }
      if (verdict.kind === 'retry') {
        // The branch never moved for the landing Hydra wrote down: drop the note; the entry is still first in line.
        await this.options.store.update(planId, current => { if (!current.integration) return undefined; const { inFlight: _inFlight, ...rest } = current.integration; return { ...current, integration: rest }; });
        continue;
      }
      const entry = integration.queue[0];
      if (!entry) break;
      const job = plan.jobs.find(item => item.key === entry.key);
      if (!job || (job.attempt ?? 0) !== entry.attempt || job.outcome) {
        // A job cancelled or retried since it queued: its old try doesn't land.
        await this.options.store.update(planId, current => current.integration ? { ...current, integration: { ...current.integration, queue: current.integration.queue.filter(item => !(item.key === entry.key && item.attempt === entry.attempt)) } } : undefined);
        progressed = true; continue;
      }
      const from = integration.tip;
      await this.options.store.update(planId, current => current.integration ? { ...current, integration: { ...current.integration, inFlight: { key: entry.key, attempt: entry.attempt, commit: entry.commit, from, at: this.now().toISOString() } } } : undefined);
      let outcome: LandingOutcome;
      try { outcome = await landCommit(repository, integration.branch, from, entry.commit, `Hydra: land job "${job.title}" (${entry.key}) of plan "${plan.title}"`); }
      catch (error) { await this.stopQueue(planId, `Couldn't land ${job.title}: ${describe(error)}`); return true; }
      await this.options.store.update(planId, current => current.integration ? { ...current, ...applyLanding(current, entry, outcome, () => this.now(), attempts) } : undefined);
      this.options.log?.(`[plans] ${planId} job ${entry.key}: ${outcome.kind === 'landed' ? `landed on ${integration.branch} (${outcome.via}) at ${outcome.tip.slice(0, 7)}` : `conflicts with ${integration.branch} in ${outcome.files.join(', ')}`}`);
      progressed = true;
      // A job that landed for real (not one the branch already had) is checked before anything else lands or starts from it.
      if (outcome.kind === 'landed' && outcome.via !== 'contained') await this.seamCheck(planId, entry.key, outcome.tip);
    }
    return progressed;
  }

  /**
   * The seam check after one landing (docs/Heads.md, "Seam checks"), on the plan's own queue, so nothing lands or starts
   * meanwhile. A failure adds a fix job for the landed job's scope in the same update that records the open seam, so
   * a dependent never sees the broken branch as ready; a pass closes every open seam. Fails open: a check that can't
   * run, or a fix that can't be added, leaves the plan as it was (the integration gate is the backstop).
   */
  private async seamCheck(planId: string, key: string, tip: string): Promise<void> {
    const gate = this.options.integration;
    if (!gate?.landingCheck || isIntegrationGateFixKey(key)) return;
    const plan = this.options.store.get(planId);
    if (!plan?.integration || plan.integration.tip !== tip) return;
    let checks: JobCheckResult[];
    try { checks = await gate.landingCheck(plan, tip, key); }
    catch (error) { this.options.log?.(`[plans] ${planId} job ${key}: the seam check couldn't run: ${describe(error)}`); return; }
    if (!checks.length) return;
    let note: string | undefined;
    await this.options.store.update(planId, current => {
      const integration = current.integration;
      if (!integration || integration.tip !== tip) return undefined;
      const rounds = gate.seamFixRounds?.() ?? defaultSeamFixRounds;
      let verdict = seamVerdict({ title: current.title, jobs: current.jobs, integration }, key, tip, checks, () => this.now(), rounds);
      let jobs = current.jobs, amendments = current.amendments;
      if (verdict.kind === 'fix') {
        try {
          const amended = applyPlanAmendment(current, { add: [verdict.job] }, undefined, () => this.now(), gate.headBudgetUsd?.());
          jobs = amended.jobs; amendments = amended.amendments;
        } catch (error) {
          this.options.log?.(`[plans] ${planId}: couldn't add a fix for the seam after ${key}: ${describe(error)}`);
          verdict = { kind: 'exhausted', key: verdict.seam.key };
        }
      }
      note = verdict.kind === 'passed' ? undefined : verdict.kind === 'fix' ? `the seam check failed; ${verdict.job.key} fixes it before its dependents start` : verdict.kind === 'covered' ? 'the seam check still fails; a fix for an earlier landing is on its way' : 'the seam check still fails after its fixes; its dependents go on';
      const { seams: _seams, ...rest } = integration;
      const seams = applySeamVerdict(integration.seams, verdict);
      return { ...current, jobs, ...(amendments ? { amendments } : {}), integration: { ...rest, ...(seams.length ? { seams } : {}) } };
    });
    if (note) this.options.log?.(`[plans] ${planId} job ${key}: ${note}`);
  }
  /** The queue stops for a person: the reason shows on every job waiting to land, and Merge plan refuses. */
  private readonly queueStops = new Map<string, number>();
  private async stopQueue(planId: string, reason: string): Promise<void> {
    this.queueStops.set(planId, this.now().getTime());
    this.options.log?.(`[plans] ${planId} integration queue stopped: ${reason}`);
    await this.options.store.update(planId, current => current.integration ? { ...current, integration: { ...current.integration, error: clip(reason, 2000) } } : undefined);
  }

  private readonly gateRuns = new Map<string, Promise<IntegrationGateRecord>>();
  /** The integration gate, started now without waiting; a failure to start is logged, and shows on the plan. */
  private integrateSoon(planId: string): void {
    if (this.disposed) return;
    void this.integrate(planId).catch(error => this.options.log?.(`[plans] ${planId} integration gate: ${describe(error)}`));
  }
  /**
   * The integration gate (hydra_plan_integrate, or by itself after the last job lands): the project's command
   * gates, and one review of the combined diff for a plan with a standard or strict job, on the integrated tree at the branch's tip. Refused while jobs are
   * still landing; a run already going is joined rather than started twice. Returns the gate's record.
   */
  integrate(planId: string): Promise<IntegrationGateRecord> {
    // Set synchronously, so a second call (the lead's, while the automatic one waits its turn) joins this run.
    const running = this.gateRuns.get(planId);
    if (running) return running;
    const run = this.runGate(planId);
    this.gateRuns.set(planId, run);
    const clear = () => { if (this.gateRuns.get(planId) === run) this.gateRuns.delete(planId); };
    run.then(clear, clear);
    return run;
  }
  private async runGate(planId: string): Promise<IntegrationGateRecord> {
    const gate = this.options.integration;
    if (!gate) throw new Error('This Hydra window has no integration gate.');
    const plan = await this.withPlan(planId, async () => {
      const current = this.options.store.get(planId);
      if (!current) throw new Error(`No plan ${planId}.`);
      const integration = current.integration;
      if (!integration) throw new Error(`Plan "${current.title}" has no integration branch: it started before Hydra had one, or hasn't run yet.`);
      if (integration.error) throw new Error(`The integration queue stopped: ${integration.error}`);
      if (integration.queue.length || integration.inFlight) throw new Error(`${integration.queue.length || 1} job(s) are still landing on ${integration.branch}; the gate runs once they have.`);
      if (integration.tip === integration.base) throw new Error(`Nothing has landed on ${integration.branch} yet.`);
      const record: IntegrationGateRecord = { tip: integration.tip, at: this.now().toISOString(), running: true, checks: [] };
      return this.options.store.update(planId, item => item.integration ? { ...item, integration: { ...item.integration, gate: record } } : undefined);
    });
    if (!plan?.integration) throw new Error(`No plan ${planId}.`);
    this.notify(planId);
    const tip = plan.integration.tip;
    let record: IntegrationGateRecord;
    try {
      const { checks, configured } = await gate.runGate(plan, tip);
      record = gateRecord(tip, checks, configured, () => this.now());
    } catch (error) { record = { tip, at: this.now().toISOString(), error: clip(describe(error), 2000), checks: [] }; }
    // A failed gate hands its findings to a fix job in the same update that records it, so nothing waiting on the
    // plan (hydra plan wait, the report) ever sees it settled on a failure a fix is about to address.
    let fixing: string | undefined;
    await this.withPlan(planId, () => this.options.store.update(planId, current => {
      if (!current.integration?.gate?.running || current.integration.gate.tip !== tip) return undefined;
      const updated: Plan = { ...current, integration: { ...current.integration, gate: record } };
      const fixes = current.state === 'done' ? integrationFixJobs(current, record, gate.fixRounds?.()) : [];
      if (!fixes.length) return updated;
      try {
        const amended = applyPlanAmendment(current, { add: fixes }, undefined, () => this.now(), gate.headBudgetUsd?.());
        fixing = fixes.map(fix => fix.key).join(', ');
        return { ...updated, jobs: amended.jobs, amendments: amended.amendments, state: 'running' };
      } catch (error) {
        this.options.log?.(`[plans] ${planId}: couldn't add a fix for the integration gate: ${describe(error)}`);
        return updated;
      }
    }));
    this.options.log?.(`[plans] ${planId} integration gate on ${tip.slice(0, 7)}: ${record.error ? `couldn't run (${record.error})` : record.failed ? `failed${fixing ? `; ${fixing} ${fixing.includes(',') ? 'fix it' : 'fixes it'}` : ''}` : record.status ?? 'done'}`);
    this.notify(planId);
    if (fixing) { await this.advance(planId); return record; }
    const finished = this.options.store.get(planId);
    if (finished) this.options.onGateDone?.(finished);
    return record;
  }
  /** Whether this window is running a plan's integration gate now. */
  gateRunning(planId: string): boolean { return this.gateRuns.has(planId); }
  /** After a restart: a gate left "running" was cut short, and a done plan whose gate never ran (or ran on an older tip) runs it now. */
  private async resumeGates(): Promise<void> {
    for (const listed of this.options.store.list()) {
      const integration = listed.integration;
      if (!integration || this.gateRuns.has(listed.id)) continue;
      const interrupted = !!integration.gate?.running;
      if (interrupted) {
        await this.withPlan(listed.id, () => this.options.store.update(listed.id, current => {
          if (!current.integration?.gate?.running) return undefined;
          const { gate: _gate, ...rest } = current.integration;
          return { ...current, integration: rest };
        }));
      }
      const stale = interrupted || !integration.gate || integration.gate.tip !== integration.tip;
      if (listed.state === 'done' && stale && !integration.error && !integration.merged && integration.tip !== integration.base) this.integrateSoon(listed.id);
    }
  }

  /**
   * Merge plan or Open PR (hydra_plan_merge, or the canvas): refused unless the integration gate passed on the
   * branch's current tip, or you merged anyway on the canvas for this tip (mergeRefusal). Merge merges into the
   * branch the plan started from, in the main checkout; Open PR pushes the branch and gives the compare page.
   */
  merge(planId: string, via: PlanMergeVia = 'merge'): Promise<{ plan: Plan; commit?: string; into?: string; compareUrl?: string }> {
    return this.withPlan(planId, async () => {
      const plan = this.options.store.get(planId);
      if (!plan) throw new Error(`No plan ${planId}.`);
      const refusal = mergeRefusal(plan);
      if (refusal) throw new Error(refusal);
      const integration = plan.integration!;
      const at = this.now().toISOString();
      if (via === 'pr') {
        const pushed = await pushIntegration(this.options.repository, integration);
        const updated = await this.options.store.update(planId, current => current.integration ? { ...current, integration: { ...current.integration, merged: { via: 'pr' as const, tip: integration.tip, at, ...(integration.target ? { into: integration.target } : {}), ...(pushed.compareUrl ? { url: pushed.compareUrl } : {}) } } } : undefined);
        this.notify(planId);
        return { plan: updated!, ...(pushed.compareUrl ? { compareUrl: pushed.compareUrl } : {}) };
      }
      const merged = await mergeIntegration(this.options.repository, integration, plan.title);
      const updated = await this.options.store.update(planId, current => current.integration ? { ...current, integration: { ...current.integration, merged: { via: 'merge' as const, tip: integration.tip, at, into: merged.into, commit: merged.commit } } } : undefined);
      this.options.log?.(`[plans] ${planId} merged ${integration.branch} into ${merged.into} at ${merged.commit.slice(0, 7)}`);
      this.notify(planId);
      return { plan: updated!, commit: merged.commit, into: merged.into };
    });
  }
  /** Merge anyway, from the canvas only (never a lead's tool): lets Merge plan through for the branch's current tip, whatever the gate said. */
  overrideGate(planId: string): Promise<Plan> {
    return this.withPlan(planId, async () => {
      const plan = this.options.store.get(planId);
      if (!plan?.integration) throw new Error(`Plan ${plan?.title ?? planId} has no integration branch.`);
      if (plan.integration.queue.length || plan.integration.inFlight) throw new Error('Jobs are still landing; wait for them.');
      const tip = plan.integration.tip;
      const updated = await this.options.store.update(planId, current => current.integration ? { ...current, integration: { ...current.integration, override: { tip, at: this.now().toISOString() } } } : undefined);
      this.notify(planId);
      return updated!;
    });
  }

  // ---- The pass ----

  private stepOptions(planId: string): PlanStepOptions {
    const prefix = `${planId}:`;
    const deferred = new Set([...this.deferred].filter(id => id.startsWith(prefix)).map(id => id.slice(prefix.length)));
    const waits = new Map([...this.waits].filter(([id]) => id.startsWith(prefix)).map(([id, reason]) => [id.slice(prefix.length), reason]));
    return { deferred, waits };
  }

  /** `release`: the one lane job Start lane starts in a plan whose Auto-dispatch you turned off. */
  private async pass(planId: string, options: { startup?: boolean; release?: string }): Promise<void> {
    // 5.3: stopped means a plan starts nothing, head or lane, until Resume Agents.
    if (this.options.stop?.isStopped()) return;
    try {
      // Each round records what happened and starts what is ready; a start can make more ready (a
      // chain of heads is started in one round), and a failure can skip more, so repeat until quiet.
      for (let round = 0; round < 50 && !this.disposed; round++) {
        const plan = this.options.store.get(planId);
        if (!plan || plan.state !== 'running') break;
        const steps = planSteps(plan, this.options.look, this.stepOptions(planId));
        let progressed = false;
        if (steps.record.length) progressed = await this.record(planId, steps.record) || progressed;
        // O3: land what passed its gates, one at a time, before starting what waits for it.
        if (plan.integration && this.options.integration) progressed = await this.drain(planId) || progressed;
        for (const step of steps.start) {
          if (step.runAs === 'lane' && (options.startup || (this.undispatched.has(planId) && step.key !== options.release)) && !plan.dispatch) {
            // Hydra never opens a lane terminal while a window is starting: the job shows Start lane instead,
            // unless the plan auto-dispatches (Step C), which is you asking for its lanes to start by themselves.
            this.deferred.add(`${planId}:${step.key}`);
            continue;
          }
          progressed = await this.startOne(planId, step.key) || progressed;
        }
        if (progressed) continue;
        if (steps.state !== 'running') {
          const settled = await this.options.store.update(planId, current => current.state === 'running' ? { ...current, state: steps.state } : undefined);
          this.options.log?.(`[plans] ${planId} is ${steps.state}`);
          if (settled) this.options.onSettled?.(settled);
          // O3: the last job has landed: the integration gate runs on the integrated tree, off this plan's queue.
          if (settled?.state === 'done' && settled.integration && this.options.integration) this.integrateSoon(planId);
        }
        break;
      }
    } finally { this.notify(planId); }
  }

  /** Write down what planSteps found, on the plan as it is now (a record that no longer fits is dropped). */
  private async record(planId: string, records: readonly PlanRecord[]): Promise<boolean> {
    const at = this.now().toISOString();
    const merged = new Map<string, string[]>();
    for (const item of records) {
      if (item.kind !== 'merged') continue;
      const lane = this.options.look.lane(item.laneId);
      merged.set(item.key, lane ? (await this.options.changedFiles(lane.baseCommit, item.commit).catch(() => [])).slice(0, planResultFilesMax) : []);
    }
    let changed = false;
    await this.options.store.update(planId, current => {
      const jobs = current.jobs.map(job => {
        const item = records.find(entry => entry.key === job.key);
        if (!item || job.outcome || job.result) return job;
        // A skipped job never started; a failed one here is a lane that closed without a result.
        if (item.kind === 'outcome' && (item.outcome.state === 'skipped' ? !jobStarted(job) : !!job.laneId)) { changed = true; return { ...job, outcome: { ...item.outcome, reason: clip(item.outcome.reason, planOutcomeReasonMax), at } }; }
        if (item.kind === 'adopt' && !job.laneId && !job.jobId) { changed = true; return { ...job, laneId: item.laneId }; }
        if (item.kind === 'merged' && job.laneId === item.laneId) { changed = true; return { ...job, result: { commit: item.commit, via: 'merged' as const, at, changedFiles: merged.get(job.key) ?? [], ...(item.status ? { status: item.status } : {}) } }; }
        return job;
      });
      // O3: work that passed its gates joins the landing queue, in the order it was seen.
      let integration = current.integration;
      for (const item of records) {
        if (item.kind !== 'enqueue' || !integration) continue;
        const job = jobs.find(entry => entry.key === item.key);
        if (!job || (job.attempt ?? 0) !== item.attempt) continue;
        const next = enqueue(integration, item.key, item.attempt, item.commit, () => this.now());
        if (next !== integration) { integration = next; changed = true; }
      }
      return changed ? { ...current, jobs, ...(integration ? { integration } : {}) } : undefined;
    });
    return changed;
  }

  /** Start one job if it is still unstarted. True when something changed (it started, or failed to). */
  private async startOne(planId: string, key: string): Promise<boolean> {
    const plan = this.options.store.get(planId);
    const job = plan?.jobs.find(item => item.key === key);
    if (!plan || !job || plan.state !== 'running' || jobStarted(job) || job.draft) return false;
    const id = `${planId}:${key}`;
    try {
      if (plan.integration && this.options.integration) {
        // O3: every job starts from the integration branch's tip, which already has what it depends on (landed and
        // merged), so there is nothing to merge here; its dependencies' results go into its brief only.
        const tip = plan.integration.tip;
        const dependencies = await this.dependencyResults(plan, job, undefined, true);
        if (jobRunAs(job) === 'head') {
          // An integration fix isn't cold: it also gets the reviewer's full reply, the code the findings name and who wrote it.
          const warm = isIntegrationGateFixKey(job.key) ? await this.fixContext(plan, job).then(context => warmFixSections(context)).catch(() => '') : '';
          const { jobId } = await this.options.startHead(plan, warm ? { ...job, brief: `${job.brief}\n\n${warm}` } : job, [], dependencies, { baseCommit: tip, ...(job.conflict ? { carry: job.conflict.commit } : {}) });
          await this.options.store.update(planId, current => ({ ...current, jobs: current.jobs.map(item => item.key === key && !jobStarted(item) ? { ...item, jobId } : item) }));
          this.options.log?.(`[plans] ${planId} started head ${jobId} for job ${key} from ${plan.integration.branch} at ${tip.slice(0, 7)}`);
          return true;
        }
        const started = await this.options.startLane(plan, job, { baseCommit: tip, dependencies });
        if ('wait' in started) {
          const changed = this.waits.get(id) !== started.wait;
          this.waits.set(id, started.wait);
          if (changed) this.notify(planId);
          return false;
        }
        this.waits.delete(id);
        await this.options.store.update(planId, current => ({ ...current, jobs: current.jobs.map(item => item.key === key && !jobStarted(item) ? { ...item, laneId: started.laneId } : item) }));
        this.options.log?.(`[plans] ${planId} started lane ${started.laneId} for job ${key} from ${plan.integration.branch}`);
        this.options.onLaneStarted?.(plan, job, started.laneId);
        return true;
      }
      if (jobRunAs(job) === 'head') {
        const headIds: string[] = [];
        for (const dependency of job.dependsOn) {
          const other = plan.jobs.find(item => item.key === dependency);
          if (!other || jobRunAs(other) !== 'head') continue;
          if (!other.jobId) return false; // started later in this round; the next round has its id
          headIds.push(other.jobId);
        }
        const inputs = await this.dependencyResults(plan, job, 'lane');
        const { jobId } = await this.options.startHead(plan, job, headIds, inputs);
        await this.options.store.update(planId, current => ({ ...current, jobs: current.jobs.map(item => item.key === key && !jobStarted(item) ? { ...item, jobId } : item) }));
        this.options.log?.(`[plans] ${planId} started head ${jobId} for job ${key}`);
        return true;
      }
      const dependencies = await this.dependencyResults(plan, job);
      const baseCommit = dependencies.length ? await dependencyBase(this.options.repository, job.title, dependencies) : undefined;
      const started = await this.options.startLane(plan, job, { ...(baseCommit ? { baseCommit } : {}), dependencies });
      if ('wait' in started) {
        const changed = this.waits.get(id) !== started.wait;
        this.waits.set(id, started.wait);
        if (changed) this.notify(planId);
        return false;
      }
      this.waits.delete(id);
      await this.options.store.update(planId, current => ({ ...current, jobs: current.jobs.map(item => item.key === key && !jobStarted(item) ? { ...item, laneId: started.laneId } : item) }));
      this.options.log?.(`[plans] ${planId} started lane ${started.laneId} for job ${key}`);
      this.options.onLaneStarted?.(plan, job, started.laneId);
      return true;
    } catch (error) {
      this.waits.delete(id);
      // A plan names its dependencies "jobs", whoever did them (docs/internal/Plan_Lanes_Plan.md, "Starting a lane job").
      const reason = error instanceof DependencyConflict ? new DependencyConflict(error.files, 'jobs').message : `Couldn't start: ${describe(error)}`;
      this.options.log?.(`[plans] ${planId} job ${key}: ${reason}`);
      const outcome: PlanJobOutcome = { state: 'failed', reason: clip(reason, planOutcomeReasonMax), at: this.now().toISOString() };
      await this.options.store.update(planId, current => ({ ...current, jobs: current.jobs.map(item => item.key === key && !jobStarted(item) ? { ...item, outcome } : item) }));
      return true;
    }
  }

  /** What each job it depends on handed on, heads and lanes alike (or only lanes), in the order it names them. */
  private async dependencyResults(plan: Plan, job: PlanJob, only?: PlanJobRunAs, withDiff = false): Promise<DependencyResult[]> {
    const results: DependencyResult[] = [];
    const diffShare = Math.floor(maxDependencyDiff / Math.max(1, job.dependsOn.length));
    for (const key of job.dependsOn) {
      const other = plan.jobs.find(item => item.key === key);
      if (!other || (only && jobRunAs(other) !== only)) continue;
      if (jobRunAs(other) === 'lane') {
        if (!other.result || !other.laneId) throw new Error(`${other.title} has no result to start from.`);
        const lane = this.options.look.lane(other.laneId);
        const subjects = other.result.note ? [] : lane ? await this.options.commitSubjects(lane.baseCommit, other.result.commit).catch(() => []) : [];
        const summary = other.result.note || subjects.join('; ') || `Its work is in commit ${other.result.commit.slice(0, 12)}.`;
        results.push({ id: other.laneId, kind: 'lane', title: other.title, summary: clip(summary, 2000), commit: other.result.commit, ...(lane ? { branch: lane.branch } : {}), changedFiles: other.result.changedFiles, ...await this.diffOf(plan, other, withDiff && diffShare) });
      } else {
        const head = other.jobId ? this.options.look.head(other.jobId) : undefined;
        if (!head || head.state !== 'done' || !head.result) throw new Error(`${other.title} has no result to start from.`);
        results.push({ id: other.jobId!, kind: 'head', title: other.title, summary: clip(head.result.summary, 2000), commit: head.result.commit, ...(head.branch ? { branch: head.branch } : {}), changedFiles: head.result.changedFiles, ...await this.diffOf(plan, other, withDiff && diffShare) });
      }
    }
    return results;
  }

  /**
   * What a dependency landed on the integration branch, as a `diff` field for its dependents' briefs: the branch's
   * change from where it was before that job landed to the tip it made (so a merged landing shows only this job's work).
   * Best effort: a dependency without a landing, or a git that can't say, just leaves the brief as it was.
   */
  private async diffOf(plan: Plan, dependency: PlanJob, max: number | false): Promise<{ diff?: string }> {
    const integration = plan.integration;
    if (!max || !integration) return {};
    const index = integration.landed.findIndex(entry => entry.key === dependency.key && entry.attempt === (dependency.attempt ?? 0));
    if (index < 0) return {};
    const diff = await dependencyDiff(this.options.repository, integration.landed[index - 1]?.tip ?? integration.base, integration.landed[index]!.tip, max).catch(() => undefined);
    return diff ? { diff } : {};
  }

  /**
   * What an integration fix job starts with beyond its brief (warmFixSections): the failed reviews' full replies (read from
   * the files the gate kept), the plan's diff stat, the diff of the files its findings name (only those in its own write
   * scope), and the jobs that wrote them. Each part that can't be read is left out; a fix without any is as cold as before.
   */
  private async fixContext(plan: Plan, job: PlanJob): Promise<FixContext> {
    const integration = plan.integration!;
    const failed = (integration.gate?.checks ?? []).filter(gateBlocks);
    const scope = job.writeScope?.length ? job.writeScope : ['.'];
    const files = findingFiles(failed, scope);
    const replies: FixContext['replies'] = [];
    for (const check of failed) {
      const file = gateKind(check) === 'review' ? check.evidence?.find(item => /-reply(?:-retry)?\.txt$/.test(item)) : undefined;
      const text = file ? await readFile(file, 'utf8').catch(() => '') : '';
      if (text.trim()) replies.push({ id: check.id, text });
    }
    const [base, tip] = [integration.base, integration.tip];
    const stat = await gitRun(this.options.repository, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--stat=100', '--stat-count=40', base, tip, '--'], undefined, readOnlyGitTimeoutMs).then(result => result.code === 0 ? result.stdout : undefined).catch(() => undefined);
    const diff = files.length ? await gitRun(this.options.repository, ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--unified=3', base, tip, '--', ...files], undefined, readOnlyGitTimeoutMs).then(result => result.code === 0 && result.stdout.trim() ? capDiff(result.stdout, fixDiffMax) : undefined).catch(() => undefined) : undefined;
    const authors: FixContext['authors'] = [];
    for (const other of plan.jobs) {
      if (other.key === job.key || isIntegrationFixKey(other.key) || !landedEntry(integration, other.key, other.attempt ?? 0)) continue;
      const head = other.jobId ? this.options.look.head(other.jobId) : undefined;
      const changed = head?.result?.changedFiles ?? other.result?.changedFiles ?? [];
      const wrote = files.filter(file => changed.includes(file) || (!!other.writeScope?.length && other.writeScope.some(entry => { const prefix = entry.replace(/\/+$/, ''); return prefix === '' || prefix === '.' || file === prefix || file.startsWith(`${prefix}/`); })));
      if (!wrote.length) continue;
      authors.push({ key: other.key, title: other.title, brief: other.brief, ...(head?.result?.summary || other.result?.note ? { summary: head?.result?.summary ?? other.result?.note } : {}), files: wrote });
    }
    return { replies, ...(stat?.trim() ? { stat } : {}), ...(diff ? { diff } : {}), authors };
  }

  /** Tell the extension when a plan's jobs or statuses changed since it last heard. */
  private notify(planId: string): void {
    const plan = this.options.store.get(planId);
    const text = JSON.stringify(plan ? { updatedAt: plan.updatedAt, state: plan.state, jobs: planSteps(plan, this.options.look, this.stepOptions(planId)).jobs } : null);
    if (this.shown.get(planId) === text) return;
    this.shown.set(planId, text);
    this.options.onChange?.(planId);
  }
  private now(): Date { return this.options.now?.() ?? new Date(); }
}
