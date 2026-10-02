import { findProvider } from '../core/providers';
import { selfCheckCli } from '../core/cliSelfCheck';
import { git } from '../core/worktrees';
import { resolveHeadDefaults, toHeadCheckView, type JobStore } from '../core/jobs';
import type { HelperEndpoint } from '../core/helperEndpoint';
import type { HelperService } from '../core/helperService';
import { isLaneMessage, parseMessage, type ClientMessage, type HelperJobView, type LaneClientMessage, type LanePlanJobView, type LaneView, type Provider, type Snapshot, type SnapshotRole } from '../core/model';
import { createPlan, cycleMessage, dependentsOf, findCycle, jobRunAs, jobStarted, maxPlanJobs, buildPlanReport, type Plan, type PlanJob, type PlanJobRunAs, type PlanReportJobDetail, PlanStore } from '../core/plans';
import { planBrief } from '../core/planner';
import { planHeadInput, PlanRunner, type PlanJobStatus, type PlanJobView, type PlanLaneLook, type PlanLaneResultInput, type PlanLaneStart, type PlanMergeVia } from '../core/planRunner';
import { defaultIntegrationFixRounds, integrationLeadView, integrationSettled, laneMergeRefusal, mergeRefusal } from '../core/integration';
import type { StopSwitch } from '../core/stopSwitch';
import type { AuditLog } from '../core/audit';
import type { Host } from './host';

/** The lanes the controller drives (src/extensionLanes.ts's LanesController in the IDE). */
export interface ControllerLanes {
  readonly available: boolean;
  state(): { lanes: LaneView[]; terminals: boolean };
  laneLook(id: string): PlanLaneLook | undefined;
  planLanes(planId: string): { laneId: string; jobKey: string; attempt: number }[];
  startPlanLane(plan: Plan, job: PlanJob, start: PlanLaneStart, defaultProvider: Provider): Promise<{ laneId: string } | { wait: string }>;
  unlinkPlan(id: string): Promise<void>;
  laneName(id: string): string | undefined;
  show(view: 'lanes', focus?: unknown): Promise<void>;
  planStatesChanged(): void;
  handle(message: LaneClientMessage): Promise<void>;
  webviewReady(): void;
}

/** What the tree of lanes, heads and plans shows (the IDE's Hydra panel). */
export interface TreeUpdate { lanes?: readonly LaneView[]; heads?: readonly HelperJobView[]; plans?: readonly Plan[]; planJobs?: Readonly<Record<string, readonly PlanJobView[]>>; roles?: readonly SnapshotRole[] }

/**
 * What the IDE still does itself while G2 moves code (docs/internal/hydra-app/G2-host-split.md): its window layout,
 * its tree, and the parts of the controller that haven't moved yet. Later milestones shrink it.
 */
export interface ControllerIde {
  /** The IDE's part of each snapshot. Also refreshes the IDE's status bar, as each publish always did. */
  view(): Pick<Snapshot, 'mode' | 'busy' | 'error' | 'handoff' | 'officialExtensions'>;
  /** Webview messages the controller doesn't handle: switching views, settings, head actions, provider checks, handoff. */
  handle(message: ClientMessage): Promise<void>;
  /** The Agents view's webview said it's ready. */
  uiReady(): void;
  /** Whether the Agents view is open, and whether it is what the user is looking at. */
  agentsOpen(): boolean;
  showingAgents(): boolean;
  openAgents(): Promise<void>;
  tree(update: TreeUpdate): void;
  /** Something this window's project summary counts changed. */
  summaryChanged(): void;
  /** A head finished: the one-time starter-gates offer for this folder. */
  offerStarterGates(folder: string): void;
  /** Shows an error to the user and republishes. */
  report(error: unknown): void;
}

export interface ControllerOptions {
  host: Host;
  ide: ControllerIde;
  lanes: ControllerLanes;
  stop: StopSwitch;
  audit: AuditLog;
}

const describe = (error: unknown): string => error instanceof Error ? error.message : String(error);
// ---- Canvas tidy-up (docs/internal/Lanes_And_Planner_Plan.md, "Canvas tidy-up"): the Finished tray's Clear button, kept across reloads. ----
const dismissedTrayKey = 'hydra.tray.dismissed.v1';

/**
 * Hydra's controller (docs/internal/hydra-app/G2-host-split.md): the Agents view's state and messages, plans and the
 * plan runner. It runs the same in the IDE and the Hydra app, reaching its program only through Host.
 */
export class HydraController {
  private readonly host: Host;
  private readonly ide: ControllerIde;
  private readonly lanes: ControllerLanes;
  /** Hydra helpers for this window (docs/internal/Official_Extensions_Plan.md): job store, local endpoint, service, discovery record. */
  helpers?: { store: JobStore; endpoint: HelperEndpoint; service: HelperService; record: string; handshake?: string };
  // ---- Planner (docs/internal/Lanes_And_Planner_Plan.md, section 4): its own store, and the brief-planning ----
  // ---- CLI runs in flight (by plan id), so Cancel and window close can abort them. ----
  plans?: { store: PlanStore; planning: Map<string, AbortController> };
  // ---- Plan lanes (docs/internal/Plan_Lanes_Plan.md): runs plans whose jobs are heads or lanes ----
  planRunner?: PlanRunner;
  /** The active packs' roles (Snapshot.roles), refreshed whenever packs change. */
  roles: SnapshotRole[] = [];
  /** hydra.newPlan on a panel that is still loading: shown once its webview says it is ready. */
  private pendingNewPlan = false;
  private snapshotGeneration = 0;
  private publishTimer: ReturnType<typeof setTimeout> | undefined;
  private dismissedTrayIds = new Set<string>();
  /** Woken by plansChanged (any plan or plan-job change), for hydra_plan_wait. */
  readonly planWaiters = new Set<() => void>();
  /** O7: the morning report (docs/Heads.md, "Unattended plans"): the ending each plan was last reported at. */
  private readonly reportedPlans = new Map<string, string>();
  constructor(private readonly options: ControllerOptions) {
    this.host = options.host; this.ide = options.ide; this.lanes = options.lanes;
    const storedDismissed = this.host.state.get<string[] | undefined>(dismissedTrayKey, undefined);
    if (Array.isArray(storedDismissed)) this.dismissedTrayIds = new Set(storedDismissed.filter(id => typeof id === 'string'));
  }

  async helperExecutable(provider: Provider): Promise<string> {
    const info = await findProvider(provider, this.host.settings.machine<string>(`${provider}Path`));
    if (!info.executable) throw new Error(`${provider === 'claude' ? 'Claude Code' : 'Codex'} CLI not found. Install it or set Hydra's ${provider} path.`);
    const check = await selfCheckCli(provider, info.executable);
    if (!check.ok) throw new Error(check.error);
    return info.executable;
  }

  // ---- The Agents view: what it shows, and its messages ----

  /** The heads the webview shows (Agents canvas and dashboard), newest first. */
  headViews(): HelperJobView[] | undefined {
    const service = this.helpers?.service;
    return service?.list().map(job => ({
      id: job.id, title: job.title, state: job.state, provider: job.provider, createdAt: job.createdAt, finishedAt: job.finishedAt,
      progress: job.progress, question: job.state === 'blocked' ? job.question : undefined, reason: job.state === 'running' ? undefined : job.reason,
      branch: job.branch, commit: job.result?.commit, summary: job.result?.summary, changedFiles: job.result?.changedFiles.length ?? 0,
      checks: job.result?.checks.map(toHeadCheckView) ?? [],
      repository: service.leadFolder, worktree: job.worktree, dependsOn: job.dependsOn,
      lead: job.lead, merged: service.isMerged(job.id), startedAt: job.startedAt, writeScope: job.writeScope,
      ...(job.role ? { role: { ref: job.role.ref, title: job.role.title, packTitle: job.role.packTitle } } : {}),
      ...(job.result?.status ? { status: job.result.status } : {}),
      ...(service.headConflicts(job.id).length ? { conflicts: service.headConflicts(job.id) } : {}),
      ...(service.headIntegrationConflict(job.id) ? { integrationConflict: { branch: service.headIntegrationConflict(job.id)!.branch, files: service.headIntegrationConflict(job.id)!.files } } : {}),
      ...(job.providerWait && job.state === 'running' ? { providerWait: job.providerWait } : {}),
      ...(job.providerWaitMs ? { providerWaitMs: job.providerWaitMs } : {}),
    })).reverse();
  }
  /** Head changes go to the webview at once (the Agents canvas animates them); the full snapshot follows, debounced. */
  headsChanged(): void {
    const heads = this.headViews() ?? [];
    void this.broadcast({ type: 'heads', heads }).catch(() => undefined);
    this.ide.tree({ heads });
    // Plan lanes: the runner moves running plans along (it also makes them done or incomplete).
    this.planRunner?.advanceSoon();
    this.ide.summaryChanged();
    this.publishSoon();
    // Step A: a head just finished — the one-time starter-gates offer, non-blocking.
    if (this.helpers && heads.some(head => head.state === 'done')) this.ide.offerStarterGates(this.helpers.service.leadFolder);
  }
  /** One trailing publish for high-frequency updates; an immediate publish() supersedes it. */
  publishSoon(): void {
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = setTimeout(() => { this.publishTimer = undefined; void this.publish().catch(error => this.ide.report(error)); }, 200);
  }
  async publish(): Promise<void> {
    if (this.publishTimer) { clearTimeout(this.publishTimer); this.publishTimer = undefined; }
    const generation = ++this.snapshotGeneration;
    const view = this.ide.view();
    if (generation !== this.snapshotGeneration) return;
    const snapshot: Snapshot = {
      mode: view.mode, busy: view.busy, error: view.error,
      helpers: this.headViews(), plans: this.plans?.store.list(), defaultProvider: this.host.settings.get('defaultProvider', 'claude'),
      handoff: view.handoff, officialExtensions: view.officialExtensions,
      dismissedTray: [...this.dismissedTrayIds],
      planJobs: this.planJobViews(),
      roles: this.roles,
    };
    await this.broadcast({ type: 'snapshot', snapshot });
  }
  async broadcast(message: unknown): Promise<void> {
    await this.host.postToUi(message);
  }
  async handle(value: unknown): Promise<void> {
    const message = parseMessage(value);
    if (message.type === 'ready') {
      await this.publish();
      this.ide.uiReady(); this.lanes.webviewReady();
      if (this.pendingNewPlan) { this.pendingNewPlan = false; await this.broadcast({ type: 'showNewPlan' }); }
      return;
    }
    if (isLaneMessage(message)) { await this.lanes.handle(message); return; }
    if (message.type === 'trayClear') { await this.trayClear(message.ids); return; }
    // ---- Planner (docs/internal/Lanes_And_Planner_Plan.md, section 4): its own block. ----
    if (message.type === 'planCreate') { await this.planCreate(message.title, message.brief); return; }
    if (message.type === 'planCreateEmpty') { await this.planCreateEmpty(message.title); return; }
    if (message.type === 'planRetry') { await this.planRetry(message.id); return; }
    if (message.type === 'planCancel') { this.planCancel(message.id); return; }
    if (message.type === 'planDelete') { await this.planDelete(message.id); return; }
    if (message.type === 'planStartEmpty') { await this.planStartEmpty(message.id); return; }
    if (message.type === 'planAddJob') { await this.planAddJob(message.id); return; }
    if (message.type === 'planSaveJob') { await this.planSaveJob(message.id, message.key, message.title, message.brief, message.provider, message.runAs, message.role); return; }
    if (message.type === 'planDeleteJob') { await this.planDeleteJob(message.id, message.key); return; }
    if (message.type === 'planDependsOn') { await this.planDependsOn(message.id, message.key); return; }
    if (message.type === 'planAddDependency') { await this.planAddDependency(message.id, message.key, message.dependsOn); return; }
    if (message.type === 'planRemoveDependency') { await this.planRemoveDependency(message.id, message.key, message.dependsOn); return; }
    if (message.type === 'planRun') { await this.runPlanById(message.id); return; }
    // ---- Plan lanes (docs/internal/Plan_Lanes_Plan.md) ----
    if (message.type === 'planRetryJobs') { await this.requirePlanRunner().retry(message.id); return; }
    if (message.type === 'planCancelJob') { await this.planCancelJob(message.id, message.key); return; }
    if (message.type === 'planStartJob') { await this.requirePlanRunner().startJob(message.id, message.key); return; }
    // Step C: Auto-dispatch to lanes, on (with its settings) or off. Stop all may leave the runner quiet, so say it changed.
    if (message.type === 'planDispatch') { await this.requirePlanRunner().setDispatch(message.id, message.dispatch ?? undefined); this.plansChanged(); return; }
    // ---- O3: the integration gate, Merge plan, Open PR and Merge anyway ----
    if (message.type === 'planIntegrate') { await this.requirePlanRunner().integrate(message.id); this.plansChanged(); return; }
    if (message.type === 'planMerge') { await this.planMergeFromCanvas(message.id, message.via); return; }
    if (message.type === 'planMergeAnyway') { await this.planMergeAnyway(message.id); return; }
    await this.ide.handle(message);
  }
  /** The Finished tray's Clear button: hide these heads from the tray, kept across reloads; a new finished head still shows up. */
  private async trayClear(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.dismissedTrayIds.add(id);
    await this.host.state.update(dismissedTrayKey, [...this.dismissedTrayIds]);
    await this.publish();
  }

  // ---- Planner (docs/internal/Lanes_And_Planner_Plan.md, section 4): its own block. ----

  /** Plan changes go to the webview at once (mirrors headsChanged); the full snapshot follows, debounced. */
  plansChanged(): void {
    const plans = this.plans?.store.list() ?? [];
    void this.broadcast({ type: 'plans', plans, planJobs: this.planJobViews() }).catch(() => undefined);
    this.ide.tree({ plans, planJobs: this.planJobViews() });
    this.lanes.planStatesChanged();
    this.ide.summaryChanged();
    this.publishSoon();
    this.wakePlanWaiters();
  }
  private wakePlanWaiters(): void { for (const wake of [...this.planWaiters]) wake(); }
  requirePlans(): { store: PlanStore; planning: Map<string, AbortController> } {
    if (!this.plans) throw new Error('Hydra plans are not ready in this window yet.');
    return this.plans;
  }
  async newPlan(): Promise<void> {
    const loaded = this.ide.agentsOpen();
    this.pendingNewPlan = !loaded;
    await this.ide.openAgents();
    if (loaded) await this.broadcast({ type: 'showNewPlan' });
  }
  private async planCreateEmpty(title: string): Promise<void> {
    const plans = this.requirePlans();
    await plans.store.save(createPlan({ title, state: 'draft' }));
    this.plansChanged();
  }
  private async planCreate(title: string, brief: string): Promise<void> {
    const plans = this.requirePlans();
    const plan = await plans.store.save(createPlan({ title, brief, state: 'planning' }));
    this.plansChanged();
    void this.draftPlan(plan.id, brief);
  }
  private async planRetry(id: string): Promise<void> {
    const plans = this.requirePlans();
    const current = plans.store.get(id);
    if (!current) throw new Error(`No plan ${id}.`);
    if (current.state !== 'failed') throw new Error('Only a failed plan can be retried.');
    if (!current.brief) throw new Error('This plan has no brief to retry; use "+ Job" instead.');
    await plans.store.save({ ...current, state: 'planning', error: undefined });
    this.plansChanged();
    void this.draftPlan(id, current.brief);
  }
  private planCancel(id: string): void {
    this.plans?.planning.get(id)?.abort();
  }
  /** The failed state's "Start empty": keep the plan, but clear the failed brief attempt to an empty draft. */
  private async planStartEmpty(id: string): Promise<void> {
    const plans = this.requirePlans();
    const current = plans.store.get(id);
    if (!current) throw new Error(`No plan ${id}.`);
    plans.planning.get(id)?.abort();
    plans.planning.delete(id);
    await plans.store.save({ ...current, state: 'draft', jobs: [], error: undefined });
    this.plansChanged();
  }
  /** Run the planner CLI and record the result. Runs in the background (called with `void`); `plansChanged` tells the webview when it settles. */
  private async draftPlan(id: string, brief: string): Promise<void> {
    const plans = this.plans;
    if (!plans) return; // the window closed between starting this and getting here
    const controller = new AbortController();
    plans.planning.set(id, controller);
    try {
      const helpers = this.helpers;
      if (!helpers) throw new Error('Hydra heads are not ready in this window yet.');
      const provider: Provider = this.host.settings.get('defaultProvider', 'claude');
      const executable = await this.helperExecutable(provider);
      const roles = this.roles.map(role => ({ ref: role.ref, title: role.title, description: role.description }));
      const result = await planBrief({ provider, executable, repository: helpers.service.leadFolder, brief, signal: controller.signal, ...(roles.length ? { roles } : {}) });
      const current = plans.store.get(id);
      if (!current || current.state !== 'planning') return; // deleted, or cancelled and already marked failed
      await plans.store.save(result.ok ? { ...current, jobs: result.jobs, state: 'draft', error: undefined } : { ...current, state: 'failed', error: result.error });
    } catch (error) {
      const current = plans.store.get(id);
      if (current?.state === 'planning') await plans.store.save({ ...current, state: 'failed', error: describe(error) }).catch(() => undefined);
    } finally {
      plans.planning.delete(id);
      this.plansChanged();
    }
  }
  private async planDelete(id: string): Promise<void> {
    const plans = this.requirePlans();
    // Plan lanes (docs/internal/Plan_Lanes_Plan.md, section 4): deleting a plan that ran asks first, and stops nothing.
    const current = plans.store.get(id);
    if (current && (current.state === 'running' || current.state === 'incomplete')) {
      if (!await this.host.confirm(`Delete plan ${current.title}?`, 'Delete plan', 'Its heads and lanes keep going; they are no longer part of a plan.')) return;
    }
    plans.planning.get(id)?.abort();
    plans.planning.delete(id);
    await plans.store.remove(id);
    this.plansChanged();
  }
  /** + Job. On a plan that has run (decision 5) the new job waits for Run plan, so a half-written job never starts by itself. */
  private async planAddJob(id: string): Promise<void> {
    await this.editPlan(id, plan => {
      if (plan.state === 'done' || plan.state === 'planning') throw new Error(plan.state === 'done' ? 'This plan is done.' : 'This plan is still being drafted.');
      if (plan.jobs.length >= maxPlanJobs) throw new Error(`A plan may have at most ${maxPlanJobs} jobs.`);
      let index = plan.jobs.length + 1, key = `job-${index}`;
      while (plan.jobs.some(job => job.key === key)) key = `job-${++index}`;
      const ran = plan.state === 'running' || plan.state === 'incomplete';
      const job: PlanJob = { key, title: 'New job', brief: 'Describe what this job should do.', dependsOn: [], ...(ran ? { draft: true } : {}) };
      return { ...plan, jobs: [...plan.jobs, job] };
    });
  }
  /**
   * `role` (docs/internal/Packs_Plan.md, "Picking a role") is "pack/role" to set it, ""
   * to clear it, or undefined to leave it as it was. A role that isn't active
   * is refused unless it's the job's own unchanged value, so a role whose pack
   * went away stays on the job instead of being silently dropped.
   */
  private async planSaveJob(id: string, key: string, title: string, brief: string, provider?: Provider, runAs?: PlanJobRunAs, role?: string): Promise<void> {
    await this.editPlan(id, plan => {
      const job = plan.jobs.find(item => item.key === key);
      if (!job) throw new Error(`No job "${key}" in this plan.`);
      // A job that has started keeps what drives it (docs/internal/Plan_Lanes_Plan.md, "Editing").
      if (runAs && runAs !== jobRunAs(job) && jobStarted(job)) throw new Error(`Job ${job.title} has started, so it can't switch between Head and Lane.`);
      if (role !== undefined && role !== '' && role !== job.role && !this.roles.some(candidate => candidate.ref === role)) throw new Error(`There's no active role "${role}".`);
      const nextRole = role === undefined ? job.role : role === '' ? undefined : role;
      return { ...plan, jobs: plan.jobs.map(item => item.key === key ? { ...item, title, brief, provider, ...(runAs ? { runAs } : {}), ...(nextRole ? { role: nextRole } : { role: undefined }) } : item) };
    });
  }
  private async planDeleteJob(id: string, key: string): Promise<void> {
    await this.editPlan(id, plan => {
      const job = plan.jobs.find(item => item.key === key);
      if (job && jobStarted(job) && plan.state !== 'draft' && plan.state !== 'failed') throw new Error(`Job ${job.title} has started; cancel it instead.`);
      return { ...plan, jobs: plan.jobs.filter(item => item.key !== key).map(item => ({ ...item, dependsOn: item.dependsOn.filter(dependency => dependency !== key) })) };
    });
  }
  /** "Depends on…": a multi-select list of the plan's other jobs. */
  private async planDependsOn(id: string, key: string): Promise<void> {
    const plans = this.requirePlans();
    const plan = plans.store.get(id);
    const job = plan?.jobs.find(item => item.key === key);
    if (!plan || !job) throw new Error(`No job "${key}" in this plan.`);
    const others = plan.jobs.filter(item => item.key !== key);
    const picked = await this.host.pickMany(
      others.map(item => ({ label: item.title, description: item.key, picked: job.dependsOn.includes(item.key) })),
      { title: `"${job.title}" depends on…`, placeHolder: 'Select the jobs that must finish first' },
    );
    if (picked === undefined) return; // Esc: leave it as it was
    const dependsOn = picked.map(item => item.description!);
    await this.editPlan(id, current => this.withDependencies(current, key, () => dependsOn));
  }
  private async planAddDependency(id: string, key: string, dependsOn: string): Promise<void> {
    await this.editPlan(id, plan => {
      if (!plan.jobs.some(job => job.key === key) || !plan.jobs.some(job => job.key === dependsOn)) throw new Error('Unknown job.');
      return this.withDependencies(plan, key, current => current.includes(dependsOn) ? current : [...current, dependsOn]);
    });
  }
  private async planRemoveDependency(id: string, key: string, dependsOn: string): Promise<void> {
    await this.editPlan(id, plan => this.withDependencies(plan, key, current => current.filter(dependency => dependency !== dependsOn)));
  }
  /** Run plan: the plan runner starts every job that is ready, dependencies first (docs/internal/Plan_Lanes_Plan.md, section 2). Running it again starts only jobs added since. */
  async runPlanById(id: string): Promise<void> {
    if (!this.helpers) throw new Error('Hydra heads are not ready in this window yet.');
    await this.requirePlanRunner().run(id);
  }

  // ---- Plan lanes (docs/internal/Plan_Lanes_Plan.md): the runner, its lookups, and the plan actions ----

  requirePlanRunner(): PlanRunner {
    if (!this.planRunner) throw new Error('Hydra plans are not ready in this window yet.');
    return this.planRunner;
  }
  /**
   * Change a plan in place, on the plan runner's queue for that plan, so an edit and a job being
   * started never overwrite each other.
   */
  private async editPlan(id: string, change: (plan: Plan) => Plan | undefined): Promise<void> {
    const plans = this.requirePlans();
    const work = async () => { if (!await plans.store.update(id, change)) throw new Error(`No plan ${id}.`); };
    await (this.planRunner ? this.planRunner.withPlan(id, work) : work());
    this.plansChanged();
  }
  /** A job's new dependencies. Once a plan has run, a job that started keeps its own, and no edit may make a cycle. */
  private withDependencies(plan: Plan, key: string, change: (current: string[]) => string[]): Plan {
    const job = plan.jobs.find(item => item.key === key);
    if (!job) throw new Error(`No job "${key}" in this plan.`);
    const ran = plan.state !== 'draft' && plan.state !== 'failed' && plan.state !== 'planning';
    if (ran && jobStarted(job)) throw new Error(`Job ${job.title} has started, so what it depends on can't change.`);
    const next = { ...plan, jobs: plan.jobs.map(item => item.key === key ? { ...item, dependsOn: change(item.dependsOn) } : item) };
    const cycle = ran ? findCycle(next.jobs) : undefined;
    if (cycle) throw new Error(cycleMessage(next.jobs, cycle));
    return next;
  }
  createPlanRunner(store: PlanStore, service: HelperService, leadFolder: string, leadKey: string): PlanRunner {
    const jobs = this.helpers!.store;
    const settings = this.host.settings;
    const defaultProvider = (): Provider => settings.get<string>('defaultProvider', 'claude') === 'codex' ? 'codex' : 'claude';
    const lines = (text: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    return new PlanRunner({
      store, repository: leadFolder,
      look: {
        head: id => { const job = jobs.get(id); return job && { state: job.state, title: job.title, ...(job.limitHit ? { limitHit: true } : {}), ...(job.reason ? { reason: job.reason } : {}), ...(job.branch ? { branch: job.branch } : {}), ...(job.result ? { result: { commit: job.result.commit, summary: job.result.summary, changedFiles: job.result.changedFiles, ...(job.result.status ? { status: job.result.status } : {}) } } : {}) }; },
        lane: id => this.lanes.laneLook(id),
        planLanes: planId => this.lanes.planLanes(planId),
        lanesAvailable: () => this.lanes.available,
      },
      // A plan's heads group under its lead `plan-<id>`; a retried head gets a new idempotency key.
      // Provider (docs/internal/Packs_Plan.md, "Plans"): the job's own, then its role's, then hydra.defaultProvider.
      startHead: async (plan, job, dependsOn, inputs, start) => {
        const headDefaults = resolveHeadDefaults({ minutes: settings.get<number | undefined>('heads.defaultMinutes', undefined), maxTurns: settings.get<number | undefined>('heads.defaultMaxTurns', undefined), budgetUsd: settings.get<number | undefined>('heads.defaultBudgetUsd', undefined) });
        const result = await service.startForPlan(planHeadInput(plan, job, dependsOn, headDefaults), `plan-${plan.id}`, inputs, defaultProvider(), start) as { job_id: string };
        return { jobId: result.job_id };
      },
      startLane: (plan, job, start) => this.lanes.startPlanLane(plan, job, start, defaultProvider()),
      cancelHead: async (jobId, reason) => { await service.handle({ role: 'lead', leadKey }, 'hydra_cancel_head', { job_id: jobId, reason }, new AbortController().signal); },
      unlinkLane: id => this.lanes.unlinkPlan(id),
      commitSubjects: async (from, to) => lines(await git(leadFolder, ['log', '--format=%s', '-n', '10', `${from}..${to}`])),
      changedFiles: async (from, to) => (await git(leadFolder, ['diff', '--name-only', '-z', '--no-renames', from, to, '--'])).split('\0').filter(Boolean),
      terminalsAvailable: () => this.lanes.state().terminals,
      onChange: () => this.plansChanged(),
      // "Plan Checkout started lane Build API", with Show lane. It never switches views by itself.
      onLaneStarted: (plan, job, laneId) => {
        void this.host.notify('info', `Plan ${plan.title} started lane ${this.lanes.laneName(laneId) ?? job.title}.`, 'Show lane')
          .then(pick => { if (pick) void this.lanes.show('lanes', laneId); });
      },
      // O7: an unattended plan writes its morning report and notifies when it settles; an attended one is unaffected.
      // O7/O3: an unattended plan writes its morning report once there's nothing more to wait for: at once when it
      // ends incomplete (or has no integration branch), else after its integration gate has a result for the tip.
      onSettled: plan => { if (plan.unattended && integrationSettled(plan)) void this.writePlanReport(plan); },
      // Small plans run as one head (docs/Heads.md): on unless hydra.plans.singleHeadForSmallPlans is off.
      singleHead: () => settings.get<boolean>('plans.singleHeadForSmallPlans', true),
      onGateDone: plan => { if (plan.unattended && plan.state === 'done' && integrationSettled(plan)) void this.writePlanReport(plan); },
      log: line => this.host.log(line),
      // ---- Stop all (5.3) ----
      stop: this.options.stop,
      // ---- O3: the integration branch and the integration gate (docs/Heads.md, "Landing a plan together") ----
      integration: {
        runGate: (plan, tip) => service.runIntegrationGate({
          planId: plan.id, title: plan.title, ...(plan.brief ? { brief: plan.brief } : {}), base: plan.integration!.base, tip,
          // One review of the combined work, not one per job (O6): any standard or strict job asks for it.
          review: plan.jobs.some(job => job.rigor === 'standard' || job.rigor === 'strict'),
          providers: plan.jobs.flatMap(job => { const head = job.jobId ? jobs.get(job.jobId) : undefined; return head ? [...(head.priorProviders ?? []), head.provider] : []; }),
        }),
        fixRounds: () => settings.get<number>('plans.integrationFixRounds', defaultIntegrationFixRounds),
        headBudgetUsd: () => settings.get<number>('heads.defaultBudgetUsd', 5),
      },
    });
  }
  /** O3: Merge plan / Open PR from the canvas: the same refusal as hydra_plan_merge; a pull request opens its compare page. */
  private async planMergeFromCanvas(id: string, via: PlanMergeVia): Promise<void> {
    const result = await this.requirePlanRunner().merge(id, via);
    this.plansChanged();
    if (result.compareUrl) await this.host.openUrl(result.compareUrl);
    else void this.host.notify('info', via === 'pr' ? `Pushed ${result.plan.integration?.branch}. Open a pull request for it on your host.` : `Merged plan "${result.plan.title}" into ${result.into}.`);
  }
  /** O3: Merge anyway (the canvas only; a lead's tool never can): asks first, records the approval in the audit log, then merges. */
  private async planMergeAnyway(id: string): Promise<void> {
    const plan = this.requirePlans().store.get(id);
    if (!plan?.integration) throw new Error(`No plan ${id} with an integration branch.`);
    const reason = mergeRefusal(plan);
    if (!await this.host.confirm(`Merge plan "${plan.title}" anyway?`, 'Merge anyway', `${reason ?? 'The integration gate passed.'}\n\nThis merges ${plan.integration.branch} into ${plan.integration.target ?? 'its branch'} as it is now.`)) return;
    await this.requirePlanRunner().overrideGate(id);
    this.options.audit.record({ kind: 'approval', what: 'Merge plan anyway', detail: `${plan.title} (${plan.integration.branch} at ${plan.integration.tip.slice(0, 7)}): ${reason ?? 'gate passed'}` });
    await this.planMergeFromCanvas(id, 'merge');
  }
  /** O7: the morning report (docs/Heads.md, "Unattended plans") — written next to plans.json, opened as a tab, and notified. */
  private async writePlanReport(plan: Plan): Promise<void> {
    const plans = this.plans;
    if (!plans) return;
    const file = await plans.store.writeReport(plan.id, this.planReportMarkdown(plan));
    // A gate run again later rewrites the report; only a new ending opens it and tells you.
    const ending = `${plan.state}:${plan.integration?.tip ?? ''}`;
    if (this.reportedPlans.get(plan.id) === ending) return;
    this.reportedPlans.set(plan.id, ending);
    const openReport = async () => { try { await this.host.openFile(file, { preview: false }); } catch { /* best effort: the report is still saved */ } };
    const verdict = plan.integration && plan.state === 'done' ? ` Integration gate: ${integrationLeadView(plan)?.gate.label ?? 'not run'}.` : '';
    const ended = `Plan "${plan.title}" ${plan.state === 'done' ? 'finished' : 'stopped'}.${verdict}`;
    // In the Agent Manager, the report waits to be asked for rather than pulling you out to the Editor.
    if (this.ide.showingAgents()) { void this.host.notify('info', `${ended} Its report is ready.`, 'Open report').then(pick => { if (pick) void openReport(); }); return; }
    await openReport();
    void this.host.notify('info', `${ended} Its report is open.`);
  }
  /** A plan's report as Markdown: the morning report (O7) and hydra_plan_report (O8b) are the same text. */
  planReportMarkdown(plan: Plan): string {
    const defaultHeadBudgetUsd = this.host.settings.get<number>('heads.defaultBudgetUsd', 5);
    const details: PlanReportJobDetail[] = plan.jobs.map(job => {
      const head = job.jobId ? this.helpers?.store.get(job.jobId) : undefined;
      const view = this.planRunner?.statuses(plan.id)?.find(item => item.key === job.key);
      return {
        key: job.key, title: job.title, status: view?.status ?? job.outcome?.state ?? 'draft',
        ...(head?.provider ? { provider: head.provider } : {}),
        ...(head?.priorProviders?.length ? { priorProviders: head.priorProviders } : {}),
        ...(head?.attempts !== undefined ? { attempts: head.attempts } : {}),
        ...(head?.startedAt ? { startedAt: head.startedAt } : {}),
        ...(head?.finishedAt ? { finishedAt: head.finishedAt } : {}),
        ...(head?.result?.summary ? { summary: head.result.summary } : {}),
        ...(head?.result?.changedFiles?.length ? { changedFiles: head.result.changedFiles } : {}),
        ...(head?.result?.checks?.length ? { checks: head.result.checks.map(check => ({ id: check.id, required: check.required, passed: check.passed, ...(check.state ? { state: check.state } : {}), ...(check.summary ? { summary: check.summary } : {}) })) } : {}),
        ...(job.outcome?.reason ? { reason: job.outcome.reason } : head?.reason ? { reason: head.reason } : {}),
        ...(head?.question ? { question: head.question } : {}),
        ...(head?.usage?.costUsd !== undefined ? { costUsd: head.usage.costUsd } : {}),
        ...(head?.usage?.inputTokens !== undefined ? { inputTokens: head.usage.inputTokens } : {}),
        ...(head?.usage?.outputTokens !== undefined ? { outputTokens: head.usage.outputTokens } : {}),
        ...(head?.providerWaitMs ? { providerWaitMs: head.providerWaitMs } : {}),
        ...(head?.replies.some(reply => reply.auto) ? { autoAnswered: head.replies.filter(reply => reply.auto).map(reply => ({ at: reply.at, why: reply.auto!, ...(reply.question ? { question: reply.question } : {}) })) } : {}),
      };
    });
    return buildPlanReport(plan, details, defaultHeadBudgetUsd);
  }
  /** O7: unattended plans cancel themselves when their wall-clock budget runs out; checked on HelperService's own watchdog tick. */
  async enforceUnattendedBudgets(): Promise<void> {
    const running = this.plans?.store.list().filter(plan => plan.state === 'running' && plan.unattended?.wallClockMinutes !== undefined && plan.startedAt);
    const runner = this.planRunner;
    if (!running?.length || !runner) return;
    const endedStatuses: PlanJobStatus[] = ['done', 'failed', 'cancelled', 'skipped'];
    for (const plan of running) {
      const limitMs = plan.unattended!.wallClockMinutes! * 60_000;
      if (Date.now() - new Date(plan.startedAt!).getTime() < limitMs) continue;
      const reason = `Unattended budget: the ${plan.unattended!.wallClockMinutes} minute wall-clock limit was reached.`;
      for (const view of runner.statuses(plan.id) ?? []) {
        if (endedStatuses.includes(view.status)) continue;
        await runner.cancelJob(plan.id, view.key, reason).catch(error => this.host.log(`[plans] ${plan.id}: couldn't cancel job ${view.key}: ${describe(error)}`));
      }
    }
  }
  /** Each plan's job statuses, for plans that have run. */
  planJobViews(): Record<string, PlanJobView[]> {
    const runner = this.planRunner, views: Record<string, PlanJobView[]> = {};
    if (!runner) return views;
    for (const plan of this.plans?.store.list() ?? []) {
      if (plan.state !== 'running' && plan.state !== 'incomplete' && plan.state !== 'done') continue;
      const statuses = runner.statuses(plan.id);
      if (statuses) views[plan.id] = statuses;
    }
    return views;
  }
  /** The plan job a lane runs, as its tile and actions see it. */
  planJobOfLane(laneId: string): LanePlanJobView | undefined {
    const found = this.planRunner?.jobForLane(laneId);
    if (!found) return undefined;
    const { plan, job, view } = found;
    return {
      planId: plan.id, planTitle: plan.title, jobKey: job.key, jobTitle: job.title, state: view.status, ...(view.commit ? { commit: view.commit } : {}),
      dependents: dependentsOf(plan.jobs, job.key).filter(item => !jobStarted(item)).length,
      dependentsStarted: plan.jobs.filter(item => item.dependsOn.includes(job.key) && !!(item.jobId || item.laneId || item.result)).length,
      ...(view.dispatch ? { dispatch: view.dispatch } : {}),
    };
  }
  /** O3: a plan lane's own Merge refuses while its plan lands through an integration branch (laneMergeRefusal). */
  planLaneMergeRefusal(laneId: string): string | undefined {
    const found = this.planRunner?.jobForLane(laneId);
    return found ? laneMergeRefusal(found.plan, found.job) : undefined;
  }
  async markPlanJobDone(laneId: string, result: PlanLaneResultInput): Promise<void> {
    const found = this.requirePlanRunner().jobForLane(laneId);
    if (!found) throw new Error('This lane doesn\'t run a plan job.');
    await this.requirePlanRunner().markLaneDone(found.plan.id, found.job.key, laneId, result);
  }
  async cancelPlanJobOfLane(laneId: string): Promise<void> {
    const found = this.requirePlanRunner().jobForLane(laneId);
    if (!found) throw new Error('This lane doesn\'t run a plan job.');
    await this.requirePlanRunner().cancelJob(found.plan.id, found.job.key, 'Cancelled from its lane.');
  }
  /** Cancel job on a job's node (docs/internal/Plan_Lanes_Plan.md, "Failures"), after asking. */
  private async planCancelJob(id: string, key: string): Promise<void> {
    const plan = this.requirePlans().store.get(id);
    const job = plan?.jobs.find(item => item.key === key);
    if (!plan || !job) throw new Error(`No job "${key}" in this plan.`);
    const waiting = dependentsOf(plan.jobs, key).filter(item => !jobStarted(item)).length;
    const what = job.laneId ? 'Its lane stays open, as an ordinary lane.' : job.jobId ? 'Its head is stopped; its branch is kept.' : 'It won\'t start.';
    if (!await this.host.confirm(`Cancel job ${job.title} of plan ${plan.title}?`, 'Cancel job', `${what}${waiting ? ` ${waiting} ${waiting === 1 ? 'job' : 'jobs'} that depend on it won't start.` : ''}`)) return;
    await this.requirePlanRunner().cancelJob(id, key, 'Cancelled from the plan.');
  }
}
