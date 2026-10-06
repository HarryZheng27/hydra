import path from 'node:path';
import { mkdir, stat as fsStat, writeFile } from 'node:fs/promises';
import { findProvider } from '../core/providers';
import { OwnershipLock } from '../core/ownership';
import { repositoryRoot } from '../core/worktrees';
import { HelperEndpoint } from '../core/helperEndpoint';
import { HelperService, userPlanSession, type HelperServiceOptions } from '../core/helperService';
import { removeUserHandshake, sweepStaleHandshakes, writeUserHandshake } from '../core/userHandshake';
import { alive as isWindowAlive, discoveryDirectory, removeWindowRecord, writeWindowRecord } from '../core/helperDiscovery';
import { buildProjectSummary, readProjectSummaries, startProjectSummaryPublisher, type ProjectSummaryPublisher } from '../core/projectSummary';
import { buildEvidenceMarkdown } from '../core/evidence';
import { firstRunConnectKey, firstRunProviders, shouldConnectOnFirstRun } from '../core/onboarding';
import { startHelperRun } from '../core/helperRunner';
import type { HeadSandbox } from '../core/headSandbox';
import { createLeadVerifier, createUserVerifier } from '../core/leadVerification';
import { claudeMemRowText, claudeMemStatus, setupClaudeMem, shouldSetUpClaudeMem } from '../core/claudeMem';
import { installWithFallback } from '../core/openVsx';
import { claudeStatus, codexStatus, connectClaude, connectCodex, disconnectClaude, disconnectCodex, helperWrittenEntries, providerPaths, read, runClaude, setClaudeLimitHook, shouldRepairConnection, isStandardHelpersDir, type ConnectableProvider, type HelperServerSpec, type WrittenEntries } from '../core/helperRegistration';
import { claudeSupportsLimitHook, limitHookGroup, limitHookState, limitHookReachesThisHydra, type LimitHookGroup } from '../core/claudeLimitHook';
import type { LimitEvent } from '../core/limitEvents';
import { addMcpServer, configuredSpec, defaultMcpContext, enableMcpServerFor, listMcpServers, maskSecret, removeMcpServer, testMcpServer, validateServerSpec, type McpAgent } from '../core/mcpServers';
import { headShellOffNotice, headShellSentence } from '../core/confine';
import { claudeForRegistration as claudeFor } from './claudeExecutable';
import { otherStillLimited, type LimitOfferTracker } from '../core/limitOffer';
import { codexLaneFanout } from '../core/limitEvents';
import { ClaudeChatLimits, CodexChatLimits, type QuotaSource } from './chatLimits';
import { registerLimitOffer } from './limitOffer';
import { loadGates } from '../core/gates';
import { detectTestScript, noGatesFile, starterGateActions, starterGateChoices, starterTestGatesFile } from '../core/starterGates';
import { describeActivity, scheduleClose, windowActivity, type WindowActivity } from '../core/windowClose';
import type { PackService } from '../core/packs/service';
import { Emitter } from './emitter';
import { selfCheckCli } from '../core/cliSelfCheck';
import { git } from '../core/worktrees';
import type { JobCheckResult } from '../core/jobs';
import { JobStore, evidenceLabel, finalJobStates, resolveHeadDefaults, toHeadCheckView, type EvidenceStatus } from '../core/jobs';
import type { PlanBoardBridge, PlanLeadAmendInput, PlanLeadBridge, PlanLeadCreateInput, PlanLeadMessageInput, PlanLeadPlan } from '../core/helperService';
import { isLaneMessage, parseMessage, type ClientMessage, type HelperJobView, type LaneClientMessage, type LanePlanJobView, type LaneView, type ProviderConnectionView, type Provider, type Snapshot, type SnapshotRole } from '../core/model';
import { planIdPattern, planJobKeyPattern, type PlanDispatch, appendBoardPost, applyPlanAmendment, boardForJob, boardForLead, findPlanByIdempotencyKey, planFromLeadInput, type BoardFrom, createPlan, cycleMessage, dependentsOf, findCycle, jobRunAs, jobStarted, maxPlanJobs, buildPlanReport, type Plan, type PlanJob, type PlanJobRunAs, type PlanReportJobDetail, PlanStore } from '../core/plans';
import { planBrief } from '../core/planner';
import { planHeadInput, PlanRunner, type PlanJobStatus, type PlanJobView, type PlanLaneLook, type PlanLaneResultInput, type PlanLaneStart, type PlanMergeVia } from '../core/planRunner';
import { defaultIntegrationFixRounds, integrationLeadView, integrationSettled, isIntegrationFixKey, laneMergeRefusal, mergeRefusal } from '../core/integration';
import { redactText } from '../core/redact';
import type { StopSwitch } from '../core/stopSwitch';
import type { AuditLog } from '../core/audit';
import type { Disposable, Host } from './host';

/** The lanes the controller drives (src/host/lanes.ts's LanesController). */
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
  start(repository: string, storageDirectory: string): Promise<void>;
  stop(): Promise<void>;
  stopProcesses(): Promise<number>;
  exists(id: string): boolean;
  describe(you?: string): Promise<unknown>;
  jobReady(laneId: string, note?: string): Promise<unknown>;
  openWorktrees(): string[];
  activeRolesChanged(): Promise<void>;
  onLimitEvent(event: LimitEvent): Promise<void>;
  laneEvidence(id: string): { title: string; worktree: string; results: JobCheckResult[]; status?: EvidenceStatus; commit?: string; stale?: boolean } | undefined;
  laneGatesLogRoot(): string | undefined;
  laneWorktreeEntries(): { id: string; worktree: string }[];
  runningLanes(provider: Provider): { id: string; worktree: string }[];
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
  /** A handoff window (one piece of work handed to an official extension) runs no heads. */
  inHandoff(): boolean;
  /** Refreshes open Settings pages, so they show a change made elsewhere. */
  refreshSettingsPages(pages: string[]): Promise<void>;
  showSettings(page: string): void;
  /** Each provider's sign-in, as the Accounts page last saw it. */
  accounts(): Record<'claude' | 'codex', { status: NonNullable<ProviderConnectionView['signedIn']> }>;
  /** Providers were connected or disconnected here: what shows connections (onboarding) refreshes. */
  connectionsChanged(): void;
  /** The local Hydra desktop build (not a development host, a remote window or another editor). */
  desktop(): boolean;
  /** Opens a provider's official chat, following Docked/Tabs: where a chat continues after a usage limit. */
  openOfficial(provider: Provider): Promise<void>;
  /** Shows an error to the user and republishes. */
  report(error: unknown): void;
}

export interface ControllerOptions {
  host: Host;
  ide: ControllerIde;
  lanes: ControllerLanes;
  stop: StopSwitch;
  audit: AuditLog;
  packs: PackService;
  headSandbox: HeadSandbox;
  /** This window's own storage folder (under Hydra's storage, keyed by its folders), and the key heads group under. */
  storageDirectory: string;
  leadKey: string;
  /** Codex's usage limits (src/host/quota.ts), polled for its chats' limits. */
  quota: QuotaSource;
  /** Shared with every lane's tile banner, so "the other provider is limited too" sees chats, heads and lanes. */
  limitOfferTracker: LimitOfferTracker;
  /** Tests only: stand-ins (head processes, executables, isolation) laid over the heads service's real options. */
  helperService?: Partial<HelperServiceOptions>;
  /**
   * Heads of other controllers in the same program, refused as leads and as the user here too (G5: the Hydra app runs
   * one controller per project in one process, so the window's process is every project's heads' ancestor). The IDE
   * runs one controller per window process and leaves this out.
   */
  otherHeads?: () => Iterable<number>;
}

// ---- Plan lanes (docs/internal/Plan_Lanes_Plan.md): arguments of the hydra.plans.* test commands ----
const planIdArgument = (value: unknown): string => { if (typeof value !== 'string' || !planIdPattern.test(value)) throw new Error('Pass a plan id.'); return value; };
const jobKeyArgument = (value: unknown): string => { if (typeof value !== 'string' || !planJobKeyPattern.test(value)) throw new Error('Pass a job key.'); return value; };
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
  /** Step 2: a head started with its shell off, and the window said so (once per window). */
  private shellOffShown = false;
  private snapshotGeneration = 0;
  private publishTimer: ReturnType<typeof setTimeout> | undefined;
  private dismissedTrayIds = new Set<string>();
  /** Woken by plansChanged (any plan or plan-job change), for hydra_plan_wait. */
  private readonly planWaiters = new Set<() => void>();
  /** O7: the morning report (docs/Heads.md, "Unattended plans"): the ending each plan was last reported at. */
  private readonly reportedPlans = new Map<string, string>();
  /** This window's Git repositories (canonical roots), and whether Hydra is off here (an ownership or handoff error). */
  repositories: string[] = [];
  disabled = false;
  private readonly locks: OwnershipLock[] = [];
  /** The window's discovery record lists its folders plus open lanes' worktrees. */
  private discovery?: { port: number; folders: string[]; written: string; queue: Promise<void> };
  /** Step D: this window's small summary, published beside its discovery record for "Hydra: Show All Projects". */
  private projectSummary?: ProjectSummaryPublisher;
  /**
   * Every usage limit Hydra notices (docs/internal/Hydra_Agent_Plan.md, Phase 1): Claude chats
   * (StopFailure hook), Codex chats (rate-limit polling) and heads. The handoff UI
   * subscribes with `limitEvents.event(listener)`.
   */
  readonly limitEvents = new Emitter<LimitEvent>(error => this.host.log(`[limits] a listener failed: ${describe(error)}`));
  // ---- Gates (docs/internal/Gates_Plan.md): each provider's latest usage limit, so a review gate uses the other agent while one is limited ----
  readonly latestLimits = new Map<Provider, LimitEvent>();
  /** This controller's heads' processes (none before its heads start), for a program that runs several controllers. */
  helperProcessIds(): ReadonlySet<number> { return this.helpers?.service.helperProcessIds() ?? new Set<number>(); }
  /** Set once startHelpers finds it; the folder `hydra.packs.*` commands and the roles refresh use by default. */
  packsLeadFolder?: string;
  /** Watches your packs folder (hydra.packs.folder), so a pack added or edited there refreshes without Reload. */
  private packsFolderWatcher?: Disposable;
  constructor(private readonly options: ControllerOptions) {
    this.host = options.host; this.ide = options.ide; this.lanes = options.lanes;
    this.host.keep(this.limitEvents);
    const storedDismissed = this.host.state.get<string[] | undefined>(dismissedTrayKey, undefined);
    if (Array.isArray(storedDismissed)) this.dismissedTrayIds = new Set(storedDismissed.filter(id => typeof id === 'string'));
  }

  private get stop(): StopSwitch { return this.options.stop; }
  private get audit(): AuditLog { return this.options.audit; }
  private get packs(): PackService { return this.options.packs; }
  private get headSandbox(): HeadSandbox { return this.options.headSandbox; }
  private get storageDirectory(): string { return this.options.storageDirectory; }
  private get leadKey(): string { return this.options.leadKey; }

  /** The claude CLI Hydra registers with (src/host/claudeExecutable.ts). */
  private claudeForRegistration(): Promise<string | undefined> {
    return claudeFor(this.host.settings.machine<string>('claudePath'), this.host.extension('anthropic.claude-code')?.path);
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
    this.projectSummary?.changed();
    this.publishSoon();
    // Step A: a head just finished — the one-time starter-gates offer, non-blocking.
    if (this.helpers && heads.some(head => head.state === 'done')) void this.offerStarterGatesIfNeeded(this.helpers.service.leadFolder);
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
    if (message.type === 'helperReview' || message.type === 'helperLog' || message.type === 'helperCancel' || message.type === 'helperAnswer' || message.type === 'helperEvidence') { await this.helperAction(message.type, message.jobId); return; }
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
    this.projectSummary?.changed();
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

  // ---- O1: plans from the chat (docs/Heads.md, "Plans from the chat") ----


  createPlanLeadBridge(): PlanLeadBridge {
    return {
      create: (input, leadSessionId) => this.planLeadCreate(input, leadSessionId),
      get: (id, leadSessionId) => this.planLeadGet(id, leadSessionId),
      wait: (id, leadSessionId, maxWaitS, signal) => this.planLeadWait(id, leadSessionId, maxWaitS, signal),
      amend: (id, leadSessionId, input) => this.planLeadAmend(id, leadSessionId, input),
      cancel: (id, leadSessionId, reason) => this.planLeadCancel(id, leadSessionId, reason),
      message: (id, leadSessionId, input) => this.planLeadMessage(id, leadSessionId, input),
      integrate: (id, leadSessionId) => this.planLeadIntegrate(id, leadSessionId),
      merge: (id, leadSessionId, via) => this.planLeadMerge(id, leadSessionId, via),
      run: (id, leadSessionId) => this.planLeadRun(id, leadSessionId),
      report: async (id, leadSessionId) => this.planReportMarkdown(this.planLeadOwn(id, leadSessionId)),
    };
  }
  /** O8b: hydra_plan_run — a draft starts (as Run plan does); an incomplete plan retries its failed jobs (as Retry failed jobs does). */
  private async planLeadRun(id: string, leadSessionId: string): Promise<PlanLeadPlan> {
    const plan = this.planLeadOwn(id, leadSessionId);
    const runner = this.requirePlanRunner();
    if (plan.state === 'draft') await runner.run(id);
    else if (plan.state === 'incomplete') await runner.retry(id);
    else throw new Error(`Plan "${plan.title}" is ${plan.state}; only a draft or an incomplete plan can be run.`);
    this.plansChanged();
    return this.planLeadSummary(this.planLeadOwn(id, leadSessionId));
  }
  /** A plan as hydra_plan_* show it to the lead that made it: each job's run status from the plan runner, and the board. */
  private planLeadSummary(plan: Plan): PlanLeadPlan {
    const views = this.requirePlanRunner().statuses(plan.id) ?? [];
    const viewByKey = new Map(views.map(view => [view.key, view]));
    return {
      planId: plan.id, title: plan.title, state: plan.state, ...(plan.error ? { error: plan.error } : {}),
      jobs: plan.jobs.map(job => {
        const view = viewByKey.get(job.key);
        return { key: job.key, title: job.title, status: view?.status ?? 'draft', ...(view?.reason ? { reason: view.reason } : {}), ...(job.jobId ? { jobId: job.jobId } : {}), ...(view?.conflict?.length ? { conflict: view.conflict } : {}) };
      }),
      board: boardForLead(plan.board),
      amendments: plan.amendments ?? [],
      ...(plan.unattended ? { unattended: plan.unattended } : {}),
      ...(plan.integration ? { integration: integrationLeadView(plan) } : {}),
      ...(plan.singleHead ? { singleHead: { reason: plan.singleHead.reason, jobs: plan.singleHead.jobs.map(job => job.key) } } : {}),
    };
  }
  /** O3: hydra_plan_integrate — the integration gate on what has landed; waits for its result. */
  private async planLeadIntegrate(id: string, leadSessionId: string): Promise<PlanLeadPlan> {
    this.planLeadOwn(id, leadSessionId);
    await this.requirePlanRunner().integrate(id);
    return this.planLeadSummary(this.planLeadOwn(id, leadSessionId));
  }
  /** O3: hydra_plan_merge — Merge plan or Open PR; the runner refuses unless the integration gate passed on the current tip (or you merged anyway on the canvas). */
  private async planLeadMerge(id: string, leadSessionId: string, via: PlanMergeVia) {
    this.planLeadOwn(id, leadSessionId);
    const result = await this.requirePlanRunner().merge(id, via);
    this.plansChanged();
    return { plan: this.planLeadSummary(this.planLeadOwn(id, leadSessionId)), ...(result.commit ? { commit: result.commit } : {}), ...(result.into ? { into: result.into } : {}), ...(result.compareUrl ? { compareUrl: result.compareUrl } : {}) };
  }
  /** hydra_plan_create: a repeated idempotency key from the same chat returns the plan it already made. */
  private async planLeadCreate(input: PlanLeadCreateInput, leadSessionId: string): Promise<{ plan: PlanLeadPlan; created: boolean }> {
    const plans = this.requirePlans();
    const repeat = findPlanByIdempotencyKey(plans.store.list(), leadSessionId, input.idempotencyKey);
    if (repeat) return { plan: this.planLeadSummary(repeat), created: false };
    const defaultHeadBudgetUsd = this.host.settings.get<number>('heads.defaultBudgetUsd', 5);
    const plan = planFromLeadInput(input, { leadSessionId, idempotencyKey: input.idempotencyKey }, defaultHeadBudgetUsd);
    await plans.store.save(plan);
    this.plansChanged();
    const needsApproval = this.host.settings.get<boolean>('plans.leadPlansNeedApproval', false);
    if (!needsApproval) await this.requirePlanRunner().run(plan.id);
    return { plan: this.planLeadSummary(plans.store.get(plan.id) ?? plan), created: true };
  }
  /** hydra_plan_get: undefined unless this exact chat made the plan (a lead never sees another lead's or the canvas's own plans). */
  private planLeadGet(id: string, leadSessionId: string): PlanLeadPlan | undefined {
    const plan = this.plans?.store.get(id);
    if (!plan || plan.leadOrigin?.leadSessionId !== leadSessionId) return undefined;
    return this.planLeadSummary(plan);
  }
  private planLeadOwn(id: string, leadSessionId: string): Plan {
    const plan = this.plans?.store.get(id);
    if (!plan || plan.leadOrigin?.leadSessionId !== leadSessionId) throw new Error(`No plan ${id} in this window.`);
    return plan;
  }
  /** hydra_plan_wait: like hydra_wait_for_heads, but for every job of a plan. */
  private async planLeadWait(id: string, leadSessionId: string, maxWaitS: number, signal: AbortSignal): Promise<PlanLeadPlan> {
    const settled = () => {
      const plan = this.plans?.store.get(id);
      if (!plan || plan.leadOrigin?.leadSessionId !== leadSessionId) return true;
      // O3: a finished plan's integration gate (running, or about to start) is worth waiting for.
      if (plan.state !== 'running') return integrationSettled(plan);
      // O5: a job that ran out of attempts, or one asking a question, needs the lead now, even mid-run
      // (independent jobs keep going regardless; only its own dependents wait for it).
      const views = this.planRunner?.statuses(id) ?? [];
      return views.some(view => view.status === 'failed' || (view.jobId && this.helpers?.store.get(view.jobId)?.state === 'blocked'));
    };
    const deadline = Date.now() + maxWaitS * 1000;
    while (!settled() && !signal.aborted && Date.now() < deadline) {
      await new Promise<void>(resolve => {
        const wake = () => { this.planWaiters.delete(wake); clearTimeout(timer); resolve(); };
        const timer = setTimeout(wake, Math.min(5000, Math.max(1, deadline - Date.now())));
        this.planWaiters.add(wake); signal.addEventListener('abort', wake, { once: true });
      });
    }
    return this.planLeadSummary(this.planLeadOwn(id, leadSessionId));
  }
  /**
   * hydra_plan_amend: add, edit or skip jobs that haven't started, retry a failed one (O5,
   * docs/Heads.md, "Plans that adapt"), then let the runner advance. Capped by
   * hydra.plans.maxAmendments (default 10, 0 means unlimited), counting every change ever
   * made this way; every one is kept in the plan's own history.
   */
  private async planLeadAmend(id: string, leadSessionId: string, input: PlanLeadAmendInput): Promise<PlanLeadPlan> {
    const plans = this.requirePlans();
    const owned = this.planLeadOwn(id, leadSessionId);
    if (owned.state !== 'draft' && owned.state !== 'running' && owned.state !== 'incomplete') throw new Error(`Plan "${owned.title}" is ${owned.state}, so it can't be amended.`);
    const requested = (input.add?.length ?? 0) + (input.edit?.length ?? 0) + (input.skip?.length ?? 0) + (input.retry?.length ?? 0);
    const max = Math.max(0, this.host.settings.get<number>('plans.maxAmendments', 10));
    // Hydra's own integration fixes don't use up the lead's amendments.
    const already = (owned.amendments ?? []).filter(amendment => !amendment.key || !isIntegrationFixKey(amendment.key)).length;
    if (max > 0 && already + requested > max) throw new Error(`Plan "${owned.title}" has ${already} of ${max} amendments already; this would add ${requested}. Cancel the plan, or start a new one for the rest.`);
    const runner = this.requirePlanRunner();
    const changed = await runner.withPlan(id, async () => {
      // A head's failure lives only in its own job, never written back to the plan's job (PlanRunner.statuses
      // reads it live); retry needs this to know a head job failed at all, so it's read once, just before applying.
      const statuses = new Map((runner.statuses(id) ?? []).map(view => [view.key, view.status as string]));
      const defaultHeadBudgetUsd = this.host.settings.get<number>('heads.defaultBudgetUsd', 5);
      const updated = await plans.store.update(id, plan => {
        const result = applyPlanAmendment(plan, input, key => statuses.get(key), () => new Date(), defaultHeadBudgetUsd);
        // A retry (or a new job) can make an incomplete plan worth running again; pass() settles
        // it back to incomplete on its own if nothing it just changed can actually start.
        return { ...plan, jobs: result.jobs, amendments: result.amendments, ...(plan.state === 'incomplete' ? { state: 'running' as const } : {}) };
      });
      if (!updated) throw new Error(`No plan ${id} in this window.`);
      return updated;
    });
    this.plansChanged();
    if (changed.state === 'running') await runner.advance(id);
    return this.planLeadSummary(this.plans!.store.get(id) ?? changed);
  }
  /** hydra_plan_cancel: cancel every unfinished job (running heads are cancelled, branches kept); the plan settles to incomplete. */
  private async planLeadCancel(id: string, leadSessionId: string, reason: string): Promise<PlanLeadPlan> {
    const owned = this.planLeadOwn(id, leadSessionId);
    if (owned.state === 'done' || owned.state === 'failed') throw new Error(`Plan "${owned.title}" has already ended.`);
    const runner = this.requirePlanRunner();
    const ended: PlanJobStatus[] = ['done', 'failed', 'cancelled', 'skipped'];
    for (const view of runner.statuses(id) ?? []) {
      if (ended.includes(view.status)) continue;
      await runner.cancelJob(id, view.key, reason).catch(error => this.host.log(`[plans] ${id}: couldn't cancel job ${view.key}: ${describe(error)}`));
    }
    return this.planLeadSummary(this.planLeadOwn(id, leadSessionId));
  }
  /** hydra_plan_message: the lead posts to specific jobs (checked against this plan's own keys) or the whole plan. */
  private async planLeadMessage(id: string, leadSessionId: string, input: PlanLeadMessageInput): Promise<PlanLeadPlan> {
    const owned = this.planLeadOwn(id, leadSessionId);
    if (input.to !== 'all') {
      const keys = new Set(owned.jobs.map(job => job.key));
      for (const key of input.to) if (!keys.has(key)) throw new Error(`No job "${key}" in this plan.`);
    }
    await this.planBoardPost(id, { from: { kind: 'lead' }, to: input.to, ...(input.topic ? { topic: input.topic } : {}), body: input.body });
    return this.planLeadSummary(this.plans!.store.get(id) ?? owned);
  }

  // ---- O4: the plan board (docs/Heads.md, "The plan board") ----

  createPlanBoardBridge(): PlanBoardBridge {
    return {
      jobPlan: jobId => this.jobPlanFor(jobId),
      // O7: an unattended plan's heads get an automatic answer to hydra_stuck (docs/Heads.md, "When nobody answers").
      unattended: planId => !!this.plans?.store.get(planId)?.unattended,
      // O3: what a plan's head is checked against while it runs: its plan's integration branch, until the plan is merged.
      integrationTarget: jobId => {
        const found = this.jobPlanFor(jobId);
        const integration = found ? this.plans?.store.get(found.planId)?.integration : undefined;
        return integration && !integration.merged ? { branch: integration.branch, tip: integration.tip } : undefined;
      },
      post: (planId, input) => this.planBoardPost(planId, input),
      boardFor: (planId, jobKey) => boardForJob(this.plans?.store.get(planId)?.board, jobKey),
    };
  }
  /** The plan and job key a running head belongs to: found by which plan job carries this head's job id. */
  jobPlanFor(jobId: string): { planId: string; jobKey: string } | undefined {
    for (const plan of this.plans?.store.list() ?? []) {
      const job = plan.jobs.find(item => item.jobId === jobId);
      if (job) return { planId: plan.id, jobKey: job.key };
    }
    return undefined;
  }
  /** Appends a post to a plan's board, redacted, on the plan runner's own queue so it can't race an amendment or a job landing. */
  private async planBoardPost(planId: string, input: { from: BoardFrom; to: 'all' | string[]; topic?: string; body: string }): Promise<void> {
    const plans = this.requirePlans();
    const runner = this.requirePlanRunner();
    await runner.withPlan(planId, async () => {
      const updated = await plans.store.update(planId, plan => ({ ...plan, board: appendBoardPost(plan.board, { from: input.from, to: input.to, ...(input.topic ? { topic: input.topic } : {}), body: redactText(input.body) }) }));
      if (!updated) throw new Error(`No plan ${planId} in this window.`);
    });
    this.plansChanged();
  }

  // ---- The window's lifecycle: ownership, heads, discovery, connections, Stop all ----

  /**
   * The window's startup in one call, for a host with nothing of its own to do in between (the Hydra app): take
   * ownership of its repositories (an error turns Hydra off here, as in the IDE), then start heads, lanes and plans.
   * The IDE runs these steps itself, with its handoff check between them. Limit detection and the limit offer start
   * separately (startLimitDetection, startLimitOffer).
   */
  async start(): Promise<void> {
    try { await this.acquireOwnership(); } catch (error) { this.disabled = true; this.ide.report(error); }
    await this.startHelpers().catch(error => { this.host.log(`[heads] not started: ${describe(error)}`); });
  }
  /** The window's shutdown in one call: heads, lanes, plans and the endpoint stop, then ownership is released. */
  async shutdown(): Promise<void> {
    await this.stopHelpers().catch(error => this.ide.report(error));
    await this.releaseOwnership();
  }
  /** Chats in the official extensions: Claude's hook events and Codex's polled limits. Heads report through their service. */
  startLimitDetection(): void {
    if (this.ide.inHandoff() || !this.host.trusted() || this.host.remote) return;
    const fire = (event: LimitEvent) => this.limitEvents.fire(event);
    // Lanes (docs/internal/Gates_Plan.md, section 2): Claude's hook already tags its own lane's
    // events with HYDRA_LANE_ID; its worktree also counts as an owned folder like any
    // workspace folder. Codex has no per-session hook, so its account-limit event is
    // fanned out here to one lane event per running Codex lane.
    const claude = new ClaudeChatLimits(this.host, this.limitEventsDirectory, providerPaths().claudeProjects, fire, () => this.lanes.laneWorktreeEntries());
    this.host.keep(claude);
    void claude.start().catch(error => this.host.log(`[limits] Claude chat limits not watched: ${describe(error)}`));
    const fireCodex = (event: LimitEvent) => {
      fire(event);
      for (const laneEvent of codexLaneFanout(event, this.lanes.runningLanes('codex'))) fire(laneEvent);
    };
    this.host.keep(new CodexChatLimits(this.host, this.options.quota, async () =>
      this.ide.desktop() && this.host.trusted() && !!this.host.extension('openai.chatgpt') && (await codexStatus(providerPaths().codexConfig, this.helperServerSpec('codex'))).connected,
    fireCodex, line => this.host.log(line)));
  }
  /** What to offer when a chat or head hits its usage limit (docs/internal/Hydra_Agent_Plan.md, Phase 3), and each lane's tile banner. */
  startLimitOffer(): void {
    const settings = this.host.settings;
    this.host.keep(registerLimitOffer({
      host: this.host, openOfficial: provider => this.ide.openOfficial(provider),
      limitEvents: this.limitEvents.event,
      storageDir: this.host.paths.storage,
      offerEnabled: () => settings.get<boolean>('limits.offerHandoff', true),
      job: jobId => this.helpers?.store.get(jobId),
      otherReady: async provider => (await this.helperConnections()).find(connection => connection.provider === provider)?.connected ?? false,
      continueWith: async (jobId, provider, markdown) => {
        if (!this.helpers) throw new Error('Hydra heads are still starting.');
        await this.helpers.service.continueWith(jobId, provider, markdown);
      },
      // O6: a plan job fails over on its own, unless turned off.
      autoContinuePlan: jobId => settings.get<boolean>('limits.autoContinuePlans', true) && !!this.jobPlanFor(jobId),
      log: line => this.host.log(line),
      tracker: this.options.limitOfferTracker,
    }));
    // Lanes (docs/internal/Gates_Plan.md, section 2): a lane's own tile banner, never a notification.
    this.host.keep(this.limitEvents.event(event => { void this.lanes.onLimitEvent(event).catch(error => this.host.log(`[lanes] limit offer: ${describe(error)}`)); }));
  }
  /** Lock each canonical repository, so different workspace configurations cannot own the same repo. */
  async acquireOwnership(): Promise<void> {
    await this.refreshRepositories();
    if (this.host.trusted()) {
      for (const repository of [...this.repositories].sort()) {
        const lock = new OwnershipLock();
        await lock.acquire(path.join(this.host.paths.storage, 'ownership'), repository);
        this.locks.push(lock);
      }
    }
  }
  async releaseOwnership(): Promise<void> {
    for (const lock of this.locks) await lock.release();
  }
  get limitEventsDirectory(): string { return path.join(this.host.paths.storage, 'limit-events'); }
  /** Claude's StopFailure hook: this editor's executable as Node, running dist/hydra-limit-hook.cjs into the shared events folder. */
  limitHook(): LimitHookGroup {
    return limitHookGroup({ executable: process.execPath, script: path.join(this.host.paths.dist, 'hydra-limit-hook.cjs'), eventsDir: this.limitEventsDirectory });
  }
  /** The hook, if this Claude runs exec-form hooks (2.1.139+); older ones would run it through a shell. */
  async limitHookFor(claude: string): Promise<LimitHookGroup | undefined> {
    const version = await runClaude(claude, ['--version']);
    if (version.code === 0 && claudeSupportsLimitHook(version.output)) return this.limitHook();
    this.host.log('[limits] Claude Code is older than 2.1.139; its usage-limit hook is not installed.');
    return undefined;
  }
  /** How a CLI starts Hydra's stdio bridge: this editor's executable as Node, running dist/hydra-mcp.cjs. */
  helperBridge(provider?: ConnectableProvider): { command: string; args: string[]; env: Record<string, string> } {
    return { command: process.execPath, args: [path.join(this.host.paths.dist, 'hydra-mcp.cjs')], env: { ELECTRON_RUN_AS_NODE: '1', HYDRA_HELPERS_DIR: path.join(this.host.paths.storage, 'helpers'), ...(provider ? { HYDRA_LEAD_PROVIDER: provider } : {}) } };
  }
  /** Helpers need a trusted Git folder. The first repository in the window is the lead's folder. */
  async startHelpers(): Promise<void> {
    if (this.disabled || this.ide.inHandoff() || !this.host.trusted() || this.helpers) return;
    const folders = this.host.folders().map(folder => folder.path);
    let leadFolder: string | undefined;
    for (const folder of folders) { try { leadFolder = await repositoryRoot(folder); break; } catch { /* not a Git folder */ } }
    if (!leadFolder) return;
    const directory = path.join(this.storageDirectory, 'helpers');
    const store = new JobStore(directory, undefined, undefined, () => {
      const settings = this.host.settings;
      return resolveHeadDefaults({
        minutes: settings.get<number | undefined>('heads.defaultMinutes', undefined),
        maxTurns: settings.get<number | undefined>('heads.defaultMaxTurns', undefined),
        budgetUsd: settings.get<number | undefined>('heads.defaultBudgetUsd', undefined),
      });
    });
    await store.load();
    const leadKey = path.basename(this.storageDirectory);
    let service: HelperService | undefined;
    const verifyLead = createLeadVerifier(() => ({
      // This window's extension host and its main process start the official
      // extensions' CLIs and Hydra's terminals; helpers are refused by process.
      allowedAncestors: new Set(this.host.windowProcessIds()),
      deniedAncestors: new Set([...(service?.helperProcessIds() ?? []), ...(this.options.otherHeads?.() ?? [])]),
    }), undefined, undefined, line => this.host.log(line));
    const verifyUser = createUserVerifier(() => ({ deniedAncestors: new Set([...(service?.helperProcessIds() ?? []), ...(this.options.otherHeads?.() ?? [])]) }), undefined, undefined, line => this.host.log(line));
    const endpoint = new HelperEndpoint(async (caller, tool, args, signal) => {
      if (!service) throw new Error('Hydra heads are still starting.');
      // Every action is logged, whoever calls it (plan, Phase 3 security note).
      this.host.log(`[heads] ${caller.role}${caller.jobId ? ` ${caller.jobId}` : ''}: ${tool}`);
      return service.handle(caller, tool, args, signal);
    }, { leadKey, laneExists: id => this.lanes.exists(id),
      // Refusals are logged too (docs/THREAT_MODEL.md): who, what and why, never a token.
      onRefuse: event => {
        this.host.log(`[heads] refused ${event.status}: ${event.reason}${event.role ? ` (${event.role}${event.jobId ? ` ${event.jobId}` : ''}${event.tool ? `, ${event.tool}` : ''})` : ''}`);
        // 5.2: a denial — every endpoint refusal.
        this.audit.record({ kind: 'denial', what: `endpoint refused: ${event.status}`, detail: event.reason, role: event.role, jobId: event.jobId });
      },
      // O8a: a user token (from the handshake file) is refused from inside a head, like a lead.
      verifyUser: async socket => {
        const verdict = await verifyUser(socket);
        if (!verdict.ok) this.host.log(`[heads] user connection refused: ${verdict.reason}`);
        return verdict;
      },
      verifyLead: async socket => {
      const verdict = await verifyLead(socket);
      this.host.log(`[heads] lead connection ${verdict.ok ? 'accepted' : `refused: ${verdict.reason}`}`);
      // 5.2: a denial — a refused lead connection.
      if (!verdict.ok) this.audit.record({ kind: 'denial', what: 'lead connection refused', detail: verdict.reason });
      return verdict;
    } });
    const port = await endpoint.start();
    service = new HelperService({
      store, endpoint, leadFolder, leadKey,
      worktreeRoot: () => this.host.settings.machine<string>('worktreeRoot') || undefined,
      startRun: startHelperRun, executable: provider => this.helperExecutable(provider),
      bridge: this.helperBridge(), logDirectory: path.join(directory, 'logs'),
      maxConcurrent: () => Math.max(1, Math.min(8, this.host.settings.get<number>('maxConcurrentHelpers', 3))),
      onChange: () => this.headsChanged(), log: line => this.host.log(line),
      lanes: { describe: you => this.lanes.describe(you), name: id => this.lanes.laneName(id),
        // Gates plan, section 3: a lane's heads branch from the lane's HEAD.
        worktree: id => this.lanes.state().lanes.find(lane => lane.id === id)?.worktree,
        // Plan lanes (docs/internal/Plan_Lanes_Plan.md, decision 6): a plan lane's agent asks you to mark its job done.
        jobReady: (laneId, note) => this.lanes.jobReady(laneId, note) },
      // ---- Gates (docs/internal/Gates_Plan.md) ----
      providerLimited: provider => otherStillLimited(this.latestLimits.get(provider), new Date()),
      // ---- Packs (docs/internal/Packs_Plan.md) ----
      gates: this.packs.gates, roles: this.packs,
      // ---- Step 2: confining heads ----
      sandbox: this.headSandbox, hydraStorage: this.host.paths.storage,
      defaultProvider: () => this.host.settings.get<string>('defaultProvider', 'claude') === 'codex' ? 'codex' : 'claude',
      // A head without a shell can't run tests or builds: said once per window, not only in its result.
      shellOff: reason => {
        if (this.shellOffShown) return;
        this.shellOffShown = true;
        void this.host.notify('warning', headShellOffNotice(reason), 'Open Settings').then(pick => { if (pick) this.ide.showSettings('heads'); }, () => undefined);
      },
      // Heads' own TEMP folders: short, since Windows refuses paths past 260 characters.
      tempDirectory: path.join(this.host.paths.storage, 't'),
      // ---- Stop all (5.3) ----
      stop: this.stop,
      // ---- Audit log (5.2) ----
      audit: event => this.audit.record(event),
      // ---- O8a: the user role's stop and resume ----
      control: {
        stopAll: reason => this.stopAllAgents(reason, 'Stop all agents (from a script)'),
        resume: () => this.resumeAgents('Resume agents (from a script)'),
        // HSEC-72: `hydra close`.
        activity: () => this.windowActivityNow(),
        closeWindow: request => this.closeFromScript(request),
      },
      // ---- O1: plans from the chat (docs/Heads.md, "Plans from the chat") ----
      plans: this.createPlanLeadBridge(),
      planBoard: this.createPlanBoardBridge(),
      // ---- O7: unattended plans (docs/Heads.md, "Unattended plans") ----
      enforceUnattendedBudgets: () => this.enforceUnattendedBudgets(),
      ...this.options.helperService,
    });
    this.host.keep(service.onLimit(event => this.limitEvents.fire(event)));
    this.host.keep(this.limitEvents.event(event => { this.latestLimits.set(event.provider, event); }));
    // Plans need the same trusted repository as heads (they read it, and running one starts heads in it). Loaded
    // before recover() (O3): a plan's head that was waiting for an answer goes back in the queue, not failed.
    const planStore = new PlanStore(path.join(this.storageDirectory, 'plans'));
    await planStore.load();
    this.plans = { store: planStore, planning: new Map() };
    await service.recover();
    await this.lanes.start(leadFolder, this.storageDirectory).catch(error => this.host.log(`[lanes] not started: ${describe(error)}`));
    const record = await writeWindowRecord(path.join(this.host.paths.storage, 'helpers'), { port, pid: process.pid, folders: [...folders, ...this.lanes.openWorktrees()] });
    this.discovery = { port, folders, written: JSON.stringify(this.lanes.openWorktrees()), queue: Promise.resolve() };
    this.helpers = { store, endpoint, service, record };
    // ---- O8a: the user role's handshake (docs/Heads.md, "Scripts and CI") ----
    // Hydra mints the user token here, once per window, and puts it only in the handshake file.
    // A failure leaves scripts without Hydra, never the window: the token is revoked with it.
    const helpersRoot = path.join(this.host.paths.storage, 'helpers');
    await sweepStaleHandshakes(helpersRoot).catch(() => 0);
    const userToken = endpoint.issue({ role: 'user', leadKey, leadSessionId: userPlanSession });
    try { this.helpers.handshake = await writeUserHandshake(helpersRoot, { pid: process.pid, port, token: userToken, repository: leadFolder }); }
    catch (error) { endpoint.revoke(userToken); this.host.log(`[heads] no handshake for scripts: ${describe(error)}`); }
    this.startProjectSummary(record, leadFolder);
    // Plan lanes: the runner picks up running plans; a lane job that is ready now waits for Start lane.
    this.planRunner = this.createPlanRunner(planStore, service, leadFolder, this.leadKey);
    await this.planRunner.advanceAll({ startup: true }).catch(error => this.host.log(`[plans] ${describe(error)}`));
    this.ide.tree({ lanes: this.lanes.state().lanes, heads: this.headViews() ?? [], plans: planStore.list(), planJobs: this.planJobViews() });
    this.host.log(`[heads] ready for ${leadFolder}`);
    void this.refreshHelperConnections().then(() => this.connectOnFirstRun()).catch(error => this.host.log(`[heads] first run: ${describe(error)}`));
    // ---- Packs (docs/internal/Packs_Plan.md): the active roles for the pickers, and the notification for a ----
    // ---- project whose packs.json lists a pack that still needs your OK on this machine. ----
    this.packsLeadFolder = leadFolder;
    await this.rolesChanged();
    void this.notifyPacksIfNeeded(leadFolder);
    this.host.watch(leadFolder, '.hydra/{packs.json,packs/**}', () => void this.rolesChanged());
    await this.setupPacksFolderWatcher();
  }
  /**
   * Your packs folder (hydra.packs.folder, default ~/.hydra/packs): watched too, so a pack you
   * add or edit there refreshes roles, the Packs page and Settings → Gates' "From packs" without
   * pressing Reload (docs/internal/Packs_Plan.md, "Not done"). Debounced, like the packs.json watcher above
   * isn't (a pack folder can see several files change at once). Never creates the folder just to
   * watch it: with no folder there yet, this simply watches nothing until Reload, addFolder or a
   * setting change calls it again.
   */
  async setupPacksFolderWatcher(): Promise<void> {
    this.packsFolderWatcher?.dispose();
    this.packsFolderWatcher = undefined;
    const folder = this.packs.places().user;
    if (!folder) return;
    const found = await fsStat(folder).then(info => info.isDirectory(), () => false);
    if (!found) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const debounced = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; void this.rolesChanged(); }, 500);
    };
    this.packsFolderWatcher = this.host.watch(folder, '**', debounced);
  }
  /** The folder `hydra.packs.*` commands act on: the one given, else this window's lead folder. */
  async packsFolder(folder?: unknown): Promise<string> {
    if (typeof folder === 'string' && folder) {
      // Any extension can run these commands, so a folder must be this window's lead or one of its
      // workspace folders: never a place to write .hydra/packs.json that the user hasn't opened.
      const key = (value: string) => { const resolved = path.resolve(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
      const open = [this.packsLeadFolder, ...this.host.folders().map(item => item.path)].filter((item): item is string => !!item);
      if (!open.some(item => key(item) === key(folder))) throw new Error('Packs can only be changed for a folder open in this window.');
      return folder;
    }
    if (this.packsLeadFolder) return this.packsLeadFolder;
    throw new Error('Hydra packs are not ready in this window yet: open a project folder (a Git repository) first.');
  }
  /** Re-read the active roles (Snapshot.roles) and publish, so every picker sees a pack change at once. */
  async rolesChanged(): Promise<void> {
    if (!this.packsLeadFolder) { this.roles = []; return; }
    try {
      const roles = await this.packs.roles(this.packsLeadFolder);
      this.roles = roles.map(role => ({ ref: role.ref, pack: role.pack, packTitle: role.packTitle, id: role.id, title: role.title, description: role.description, provider: role.provider }));
    } catch (error) { this.roles = []; this.host.log(`[packs] roles: ${describe(error)}`); }
    this.ide.tree({ roles: this.roles });
    // A running lane whose role just went away (or came back) hears about it now, not only at its next launch.
    await this.lanes.activeRolesChanged().catch(error => this.host.log(`[lanes] active roles: ${describe(error)}`));
    // An open Settings → Packs and Settings → Gates follow too: a pack added to your packs folder, or a
    // hand-edited packs.json, shows there without pressing Reload.
    await this.ide.refreshSettingsPages(['packs', 'gates']).catch(() => undefined);
    await this.publish();
  }
  /**
   * "This project uses the Coding pack. Nothing from it runs until you review
   * it." (docs/internal/Packs_Plan.md, "Notification"): once per window per project,
   * never in a test run.
   */
  private async notifyPacksIfNeeded(folder: string): Promise<void> {
    if (process.env.HYDRA_TEST_REPOSITORY) return;
    try {
      const { packs } = await this.packs.state(folder);
      const needsOk = packs.find(pack => pack.state === 'needsOk');
      if (!needsOk) return;
      const key = 'hydra.packs.notified.v1';
      const notified = new Set(this.host.state.get<string[]>(key, []));
      if (notified.has(needsOk.id)) return;
      await this.host.state.update(key, [...notified, needsOk.id]);
      const pick = await this.host.notify('info', `This project uses the ${needsOk.title} pack. Nothing from it runs until you review it.`, 'Review', 'Not now');
      if (pick === 'Review') this.ide.showSettings('packs');
    } catch { /* packs aren't available in this window; say nothing */ }
  }
  /**
   * Starter gates (Step A): once per project per window, when it
   * has no .hydra/gates.json at all, from the first lane merge or head acceptance in it. Never
   * blocks: heads are unattended, and a lane merge has already happened by the time this runs.
   */
  async offerStarterGatesIfNeeded(folder: string): Promise<void> {
    if (process.env.HYDRA_TEST_REPOSITORY) return;
    try {
      const config = await (this.packs.gates ?? loadGates)(folder);
      if (config.source !== 'none') return;
      const key = 'hydra.starterGates.asked.v1';
      const asked = new Set(this.host.state.get<string[]>(key, []));
      if (asked.has(folder)) return;
      await this.host.state.update(key, [...asked, folder]);
      const hasTest = await detectTestScript(folder);
      // Without a test script, an npm test gate would fail every head: the offer opens Settings → Gates instead.
      const pick = await this.host.notify('info',
        `This project has no gates yet: nothing independently checks a head's work before it's accepted, or a lane before it merges.${hasTest ? '' : ' Its package.json has no "test" script, so set up a gate in Settings.'}`,
        ...starterGateActions(hasTest),
      );
      if (!pick || pick === starterGateChoices.later) return;
      if (pick === starterGateChoices.settings) { this.ide.showSettings('gates'); return; }
      const file = path.join(folder, '.hydra', 'gates.json');
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, pick === starterGateChoices.test ? starterTestGatesFile() : noGatesFile(), 'utf8');
      await this.ide.refreshSettingsPages(['gates']).catch(() => undefined);
    } catch { /* gates aren't available in this window; say nothing, and never block acceptance or the merge */ }
  }
  // ---- Lanes (docs/internal/Lanes_And_Planner_Plan.md). The editor side is LanesController (src/host/lanes.ts). ----
  /** Unfinished heads started from a lane. */
  // ---- Step D: a read-only view across projects ----
  /**
   * (Re)starts this window's summary publisher, keyed by the discovery record's own file name
   * (so both files sit beside each other under the same id). Called once at startup and again
   * whenever the record's id changes (its folders changed, so its hash did too); the old
   * publisher's file is removed by its own dispose() before the new one starts.
   */
  startProjectSummary(record: string, folder: string): void {
    const previous = this.projectSummary;
    const id = path.basename(record, '.json');
    const dir = discoveryDirectory(path.join(this.host.paths.storage, 'helpers'));
    this.projectSummary = startProjectSummaryPublisher({
      dir, id, pid: process.pid,
      build: () => {
        const heads = this.headViews() ?? [];
        const lanes = this.lanes.state().lanes;
        const providers = [...new Set([...heads.map(head => head.provider), ...lanes.map(lane => lane.provider)])];
        return buildProjectSummary({ pid: process.pid, folder, heads, lanes, plans: this.plans?.store.list() ?? [], planJobs: this.planJobViews(), providers });
      },
      onError: error => this.host.log(`[projects] summary not written: ${describe(error)}`),
    });
    void previous?.dispose().catch(() => undefined);
  }
  laneHeads(laneId: string): number {
    return this.helpers?.service.list().filter(job => job.lead?.lane === laneId && !finalJobStates.has(job.state)).length ?? 0;
  }
  /**
   * Rewrite the discovery record when the open lanes' worktrees change, so a
   * lane's bridge finds this window from inside its worktree. The old record goes.
   */
  laneFoldersChanged(): void {
    this.ide.tree({ lanes: this.lanes.state().lanes });
    // Plan lanes: a lane merged, marked, closed or started may move its plan along.
    this.planRunner?.advanceSoon();
    this.projectSummary?.changed();
    const discovery = this.discovery;
    if (!discovery) return;
    const worktrees = this.lanes.openWorktrees(), key = JSON.stringify(worktrees);
    if (key === discovery.written) return;
    discovery.written = key;
    discovery.queue = discovery.queue.then(async () => {
      const helpers = this.helpers;
      if (!helpers || this.discovery !== discovery) return;
      const next = await writeWindowRecord(path.join(this.host.paths.storage, 'helpers'), { port: discovery.port, pid: process.pid, folders: [...discovery.folders, ...worktrees] });
      // The record's file name (the summary's id) is a hash of its folders: a new one means a new id.
      if (next !== helpers.record) { await removeWindowRecord(helpers.record).catch(() => undefined); helpers.record = next; this.startProjectSummary(next, helpers.service.leadFolder); }
    }).catch(error => this.host.log(`[lanes] discovery record not updated: ${describe(error)}`));
  }
  // ---- Connecting Claude Code and Codex to Hydra (plan, Phase 5) ----
  helperServerSpec(provider: ConnectableProvider): HelperServerSpec { const bridge = this.helperBridge(provider); return { command: bridge.command, args: bridge.args, env: bridge.env }; }
  /** Claude's own CLI does the registration: the configured or PATH claude, else the extension's bundled one. */
  async helperConnections(): Promise<ProviderConnectionView[]> {
    const paths = providerPaths();
    const [claude, codex, memory] = await Promise.all([claudeStatus(paths, this.helperServerSpec('claude')), codexStatus(paths.codexConfig, this.helperServerSpec('codex')), claudeMemStatus()]);
    const accounts = this.ide.accounts();
    const claudeExtension = this.host.extension('anthropic.claude-code');
    const codexExtension = this.host.extension('openai.chatgpt');
    const development = this.host.development;
    const memoryEnabled = (this.host.settings.machine<boolean>('claudeMem.enabled') ?? false);
    const memoryRow = claudeMemRowText(memoryEnabled, claude.connected && claude.current, memory);
    return [
      { ...claude, name: 'Claude Code', extensionInstalled: !!claudeExtension, extensionVersion: claudeExtension?.version, memory: memoryEnabled ? (memory.plugin && memory.bun && memory.dependencies ? 'ready' : 'missing') : undefined, memoryEnabled, memoryText: memoryRow.text, memoryRepair: memoryRow.repair, signedIn: accounts.claude.status, ...(development ? { development } : {}) },
      { ...codex, name: 'Codex', extensionInstalled: !!codexExtension, extensionVersion: codexExtension?.version, signedIn: accounts.codex.status, ...(development ? { development } : {}) },
    ];
  }
  /** "What Hydra wrote" (Settings, Connectors): the exact user-level entries read back off disk, secrets masked. */
  async helperWrittenEntries(): Promise<WrittenEntries> {
    return helperWrittenEntries(providerPaths(), maskSecret);
  }
  /** Re-run claude-mem's setup idempotently: the Repair button, and reused by Connect. Both are gated on the opt-in setting. */
  async repairClaudeMem(): Promise<{ status: Awaited<ReturnType<typeof claudeMemStatus>>; installed: string[] }> {
    if (!shouldSetUpClaudeMem((this.host.settings.machine<boolean>('claudeMem.enabled') ?? false))) throw new Error('Turn on Memory (claude-mem) in Settings → Connectors first.');
    const claude = await this.claudeForRegistration();
    if (!claude) throw new Error('Install the Claude Code extension or CLI first.');
    return setupClaudeMem(claude);
  }
  /** Install an official extension from the gallery, or straight from Open VSX when the gallery can't (installWithFallback). */
  async installProviderExtension(provider: ConnectableProvider): Promise<void> {
    if (provider !== 'claude' && provider !== 'codex') throw new Error('Unknown provider.');
    const id = provider === 'claude' ? 'anthropic.claude-code' : 'openai.chatgpt';
    // The Hydra app has no editor extensions: Connect registers the CLIs only (G2's Result).
    if (this.host.hasExtensions === false || this.host.extension(id)) return;
    const via = await installWithFallback(id,
      extension => this.host.installExtension({ id: extension }),
      file => this.host.installExtension({ file }),
      undefined, line => this.host.log(line));
    this.host.log(`[heads] installed ${id} from ${via === 'gallery' ? 'the extension gallery' : 'Open VSX'}`);
  }
  /**
   * One Connect: install the official extension if it's missing, connect it to
   * Hydra, and for Claude set up claude-mem too, but only when the user turned on
   * Memory (claude-mem) in Settings → Connectors; off by default, so a plain
   * Connect never installs Bun or claude-mem. A claude-mem problem doesn't undo
   * the connection; it's reported and Connect can be pressed again.
   */
  async connectHelpers(provider: ConnectableProvider): Promise<string | undefined> {
    await this.installProviderExtension(provider);
    const paths = providerPaths(), spec = this.helperServerSpec(provider);
    if (provider === 'codex') await connectCodex(paths.codexConfig, spec);
    else if (provider === 'claude') {
      const claude = await this.claudeForRegistration();
      if (!claude) throw new Error('Install the Claude Code extension or CLI first; Hydra connects through it.');
      await connectClaude(claude, paths, spec, await this.limitHookFor(claude));
      this.host.log('[heads] connected claude to Hydra');
      if (!shouldSetUpClaudeMem((this.host.settings.machine<boolean>('claudeMem.enabled') ?? false))) return undefined;
      try {
        const memory = await setupClaudeMem(claude);
        if (memory.installed.length) this.host.log(`[heads] set up ${memory.installed.join(' and ')} for claude-mem`);
        return undefined;
      } catch (error) { this.host.log(`[heads] claude-mem setup failed: ${describe(error)}`); return `Connected, but claude-mem could not be set up: ${describe(error)}`; }
    } else throw new Error('Unknown provider.');
    this.host.log(`[heads] connected ${provider} to Hydra`);
    return undefined;
  }
  async disconnectHelpers(provider: ConnectableProvider): Promise<void> {
    const paths = providerPaths();
    if (provider === 'codex') await disconnectCodex(paths.codexConfig);
    else if (provider === 'claude') await disconnectClaude(await this.claudeForRegistration(), paths);
    else throw new Error('Unknown provider.');
    this.host.log(`[heads] disconnected ${provider} from Hydra`);
  }
  /** A connection made by an older Hydra (a different executable path) is refreshed; nothing is connected here that the user didn't connect. */
  private async refreshHelperConnections(): Promise<void> {
    // A development or test window (another profile, another extension folder) would
    // point the user's real Claude and Codex at itself; only an installed Hydra refreshes.
    if (this.host.development) { this.host.log('[heads] development window: leaving the Claude and Codex connections as they are'); return; }
    for (const connection of await this.helperConnections()) {
      if (shouldRepairConnection(connection)) {
        await this.connectHelpers(connection.provider).catch(error => this.host.log(`[heads] could not refresh ${connection.provider}: ${describe(error)}`));
        continue;
      }
      if (connection.connected && !connection.current && !connection.error) {
        // Another Hydra's entry (the IDE's or the app's), still installed: it reaches this one too (G5).
        this.host.log(`[heads] ${connection.provider}'s Hydra connection points at another Hydra that is still installed; leaving it as it is`);
      }
      // The hook too, but a window on its own profile adds or rewrites it only beside its own entry.
      if (connection.provider === 'claude' && connection.connected && !connection.error && (connection.current || isStandardHelpersDir(this.helperServerSpec('claude').env.HYDRA_HELPERS_DIR))) {
        await this.refreshLimitHook().catch(error => this.host.log(`[limits] could not refresh the Claude hook: ${describe(error)}`));
      }
    }
  }
  /**
   * A connected Claude gets the usage-limit hook: rewritten when Hydra's path moved,
   * added when a Connect from before the hook existed didn't write it.
   */
  private async refreshLimitHook(): Promise<void> {
    const paths = providerPaths(), group = this.limitHook();
    const text = await read(paths.claudeSettings);
    const state = limitHookState(text, group);
    if (state === 'current') return;
    // Another Hydra's hook, still installed and writing where this one reads, tells every Hydra window too: leave it (G5).
    if (state === 'stale' && limitHookReachesThisHydra(text, group, undefined, isStandardHelpersDir(this.helperServerSpec('claude').env.HYDRA_HELPERS_DIR))) return;
    if (state === 'missing') { const claude = await this.claudeForRegistration(); if (!claude || !await this.limitHookFor(claude)) return; }
    await setClaudeLimitHook(paths, group);
    this.host.log(`[limits] ${state === 'stale' ? 'updated' : 'added'} the Claude usage-limit hook`);
  }
  /**
   * Stop All Agents (5.3), shared by the command (after its confirmation) and the user role's
   * hydra_stop_all (O8a), which asks nothing: the script is you. `what` is the audit line.
   */
  async stopAllAgents(reason: string, what: string): Promise<{ heads: number; lanes: number }> {
    await this.stop.stop(reason);
    const heads = await this.helpers?.service.stopAll(reason) ?? 0;
    const lanes = await this.lanes.stopProcesses();
    const parts = [heads ? `${heads} head${heads === 1 ? '' : 's'}` : '', lanes ? `${lanes} lane${lanes === 1 ? '' : 's'}` : ''].filter(Boolean);
    // 5.2: a stop — Stop All Agents itself, distinct from each head's own "head cancelled" line.
    this.audit.record({ kind: 'stop', what, detail: parts.join(', ') || undefined });
    void this.host.notify('info', `Hydra stopped${parts.length ? `: ${parts.join(', ')}` : ''}. Starting heads, launching lanes and advancing plans are refused until you run "Hydra: Resume Agents".`);
    return { heads, lanes };
  }
  /**
   * HSEC-72: `hydra close` (the user role's hydra_close), after HelperService has checked that nothing is still working
   * here or the caller forced it. Logged and audited now; the window closes closeDelayMs later, so the caller gets its reply, after checking again (unless forced) that no work started meanwhile.
   */
  closeFromScript(request: { force: boolean; activity: WindowActivity; reason?: string }): void {
    const working = describeActivity(request.activity);
    const detail = [request.reason, request.force && working ? `forced, cutting short ${working}` : ''].filter(Boolean).join('; ');
    this.host.log(`[close] Closing this window, as a script asked (hydra close)${detail ? `: ${detail}` : ''}.`);
    this.audit.record({ kind: 'close', what: 'Close window (from a script)', ...(detail ? { detail } : {}) });
    scheduleClose({
      force: request.force,
      activity: () => this.windowActivityNow(),
      close: () => { void this.host.closeWindow().catch(error => this.host.log(`[close] ${describe(error)}`)); },
      aborted: refusal => {
        // Work started between the reply and the close: the window stays open.
        this.host.log(`[close] Not closing after all: ${refusal}`);
        this.audit.record({ kind: 'denial', what: 'Close window (from a script) stopped: work started before it closed', detail: refusal, role: 'user' });
      },
    });
  }
  /** What in this window is still working (HSEC-72). */
  windowActivityNow(): WindowActivity {
    return windowActivity({ heads: this.helpers?.service.list() ?? [], lanes: this.lanes.state().lanes, plans: this.plans?.store.list() ?? [] });
  }
  /** Resume Agents (5.3), shared by the command and the user role's hydra_resume (O8a). */
  async resumeAgents(what: string): Promise<void> {
    await this.stop.resume();
    await this.planRunner?.advanceAll().catch(error => this.host.log(`[plans] ${describe(error)}`));
    // 5.2: a resume.
    this.audit.record({ kind: 'resume', what });
    void this.host.notify('info', 'Hydra resumed: heads, lanes and plans may start again.');
  }
  async stopHelpers(): Promise<void> {
    this.planRunner?.dispose(); this.planRunner = undefined;
    const plans = this.plans; this.plans = undefined;
    for (const controller of plans?.planning.values() ?? []) controller.abort();
    const helpers = this.helpers; this.helpers = undefined;
    await this.lanes.stop().catch(() => undefined);
    const summary = this.projectSummary; this.projectSummary = undefined;
    await summary?.dispose('closed').catch(() => undefined);
    if (!helpers) return;
    await this.discovery?.queue.catch(() => undefined); this.discovery = undefined;
    await removeWindowRecord(helpers.record).catch(() => undefined);
    if (helpers.handshake) await removeUserHandshake(helpers.handshake).catch(() => undefined);
    await helpers.service.dispose();
    await helpers.endpoint.close();
  }
  async refreshRepositories(): Promise<void> {
    const repositories: string[] = [];
    for (const folder of this.host.folders()) {
      try { repositories.push(await repositoryRoot(folder.path)); }
      catch { /* Non-Git folders remain ordinary editor workspaces. */ }
    }
    this.repositories = [...new Set(repositories)];
  }

  /**
   * Hydra's commands that drive the controller: heads, Stop all, plans, packs, connections and MCP servers. The IDE
   * registers them as VS Code commands (with its own error reporting); the app maps them to its own calls.
   */
  registerCommands(command: (name: string, callback: (...args: any[]) => unknown) => void): void {
    command('hydra.stopAllHelpers', async () => {
      const stopped = await this.helpers?.service.stopAll() ?? 0;
      void this.host.notify('info', stopped ? `Stopped ${stopped} Hydra head${stopped === 1 ? '' : 's'}.` : 'No Hydra heads are running.');
      return stopped;
    });
    command('hydra.listHelpers', () => structuredClone(this.helpers?.service.list() ?? []));
    // ---- Stop all (5.3) ----
    command('hydra.stopAllAgents', async (options?: { confirm?: boolean }) => {
      if (options?.confirm !== false) {
        if (!await this.host.confirm('Stop every head and lane in this window?', 'Stop all')) return false;
      }
      await this.stopAllAgents('Stopped with "Hydra: Stop All Agents".', 'Stop all agents');
      return true;
    });
    command('hydra.resumeAgents', async () => {
      await this.resumeAgents('Resume agents');
      return true;
    });
    // Not contributed: Settings → Heads asks it, to show whether Hydra is stopped now.
    command('hydra.getStopState', () => ({ stopped: this.stop.isStopped(), since: this.stop.since(), reason: this.stop.reason() }));
    // Not contributed: Settings → Heads asks it. Checks the head sandbox once per window if it hasn't been yet.
    command('hydra.headShellStatus', async () => { const shell = await this.headSandbox.shell(); return { kind: shell.kind, text: headShellSentence(shell) }; });
    // ---- Planner (docs/internal/Lanes_And_Planner_Plan.md, section 4). newPlan is public; the plans.* commands are test-only, not in menus. ----
    command('hydra.newPlan', () => this.newPlan());
    command('hydra.plans.list', () => structuredClone(this.plans?.store.list() ?? []));
    command('hydra.plans.save', async (plan: unknown) => { const saved = await this.requirePlans().store.save(plan as Plan); this.plansChanged(); return saved; });
    command('hydra.plans.run', async (id: unknown) => { await this.runPlanById(String(id)); return structuredClone(this.requirePlans().store.get(String(id))); });
    // ---- Plan lanes (docs/internal/Plan_Lanes_Plan.md): test and automation commands, never asking anything ----
    command('hydra.plans.status', (id: unknown) => structuredClone(this.requirePlanRunner().statuses(planIdArgument(id)) ?? []));
    command('hydra.plans.retry', async (id: unknown) => { await this.requirePlanRunner().retry(planIdArgument(id)); return structuredClone(this.requirePlans().store.get(planIdArgument(id))); });
    command('hydra.plans.cancelJob', async (id: unknown, key: unknown) => { await this.requirePlanRunner().cancelJob(planIdArgument(id), jobKeyArgument(key), 'Cancelled.'); return structuredClone(this.requirePlans().store.get(planIdArgument(id))); });
    command('hydra.plans.startJob', async (id: unknown, key: unknown) => { await this.requirePlanRunner().startJob(planIdArgument(id), jobKeyArgument(key)); return structuredClone(this.requirePlans().store.get(planIdArgument(id))); });
    // Step C: Auto-dispatch to lanes; null or nothing turns it off. setDispatch validates the settings.
    // O3: the integration gate and Merge plan, for tests and automation (never asking anything; no override here).
    command('hydra.plans.integrate', async (id: unknown) => { await this.requirePlanRunner().integrate(planIdArgument(id)); return structuredClone(this.requirePlans().store.get(planIdArgument(id))); });
    command('hydra.plans.merge', async (id: unknown, via?: unknown) => { await this.requirePlanRunner().merge(planIdArgument(id), via === 'pr' ? 'pr' : 'merge'); return structuredClone(this.requirePlans().store.get(planIdArgument(id))); });
    command('hydra.plans.dispatch', async (id: unknown, dispatch?: unknown) => { await this.requirePlanRunner().setDispatch(planIdArgument(id), dispatch == null ? undefined : dispatch as PlanDispatch); this.plansChanged(); return structuredClone(this.requirePlans().store.get(planIdArgument(id))); });
    // ---- Packs (docs/internal/Packs_Plan.md, section 6). The Packs page and smoke tests call these; there is ----
    // ---- no hydra.packs.allow command — allowing a pack only ever happens from the review panel's   ----
    // ---- own button (src/settings/pages/packs.ts), never through a command any extension could call. ----
    command('hydra.packs.state', async (folder?: unknown) => structuredClone(await this.packs.state(await this.packsFolder(folder))));
    command('hydra.packs.setEnabled', async (folder: unknown, id: unknown, on: unknown) => {
      const root = await this.packsFolder(folder);
      const packId = String(id), enable = !!on;
      // Turning on here never allows a pack: an off pack that isn't already allowed for this project stays "Needs your OK".
      if (enable && !(await this.packs.isAllowed(root, packId))) throw new Error(`The ${packId} pack needs your review first. Turn it on from Settings → Packs.`);
      await this.packs.setEnabled(root, packId, enable);
      await this.rolesChanged();
      return structuredClone(await this.packs.state(root));
    });
    command('hydra.packs.skipGate', async (folder: unknown, id: unknown, gate: unknown, skip: unknown) => {
      const root = await this.packsFolder(folder);
      await this.packs.skipGate(root, String(id), String(gate), !!skip);
      return structuredClone(await this.packs.state(root));
    });
    command('hydra.packs.addFolder', async (source: unknown) => {
      if (typeof source !== 'string' || !source) throw new Error('Pass the folder to add.');
      const installed = await this.packs.addFolder(source);
      // addFolder makes your packs folder if it didn't exist yet, so the watcher may need to start now.
      await this.setupPacksFolderWatcher();
      return structuredClone(installed);
    });
    command('hydra.packs.reload', async () => { await this.setupPacksFolderWatcher(); await this.rolesChanged(); return true; });
    command('hydra.helperConnections', () => this.helperConnections());
    command('hydra.connectHelpers', async (provider: ConnectableProvider) => ({ warning: await this.connectHelpers(provider), connections: await this.helperConnections() }));
    command('hydra.disconnectHelpers', async (provider: ConnectableProvider) => { await this.disconnectHelpers(provider); return this.helperConnections(); });
    command('hydra.installProviderExtension', async (provider: ConnectableProvider) => { await this.installProviderExtension(provider); return this.helperConnections(); });
    command('hydra.repairClaudeMem', () => this.repairClaudeMem());
    command('hydra.helperWrittenEntries', () => this.helperWrittenEntries());
    // MCP servers (Settings plan, Phase 4). Lists come back with secrets masked; changes return the fresh list.
    const mcp = async () => defaultMcpContext(await this.claudeForRegistration());
    command('hydra.mcpServers.list', async () => listMcpServers(await mcp()));
    command('hydra.mcpServers.add', async (name: unknown, spec: unknown, agents: unknown) => { const context = await mcp(); await addMcpServer(context, name, spec, agents); return listMcpServers(context); });
    command('hydra.mcpServers.remove', async (name: unknown, agent: unknown) => { const context = await mcp(); await removeMcpServer(context, name, agent); return listMcpServers(context); });
    command('hydra.mcpServers.enable', async (name: unknown, agent: unknown) => { const context = await mcp(); await enableMcpServerFor(context, name, agent); return listMcpServers(context); });
    command('hydra.mcpServers.test', async (target: unknown, agent?: McpAgent) => testMcpServer(typeof target === 'string' ? await configuredSpec(await mcp(), target, agent) : validateServerSpec(target)));
  }

  // ---- Show all projects, the first run's connections, head actions and evidence ----

  /**
   * "Hydra: Show All Projects" (Step D): every open window's summary, read-only. Selecting a
   * live entry opens its folder — VS Code focuses that folder's window if it already has one
   * open, rather than opening a second window on it, so this passes forceNewWindow: false,
   * forceReuseWindow: false (neither "always a new window" nor "always reuse this one"). A
   * closed or not-responding entry has nothing to focus, so it only explains itself.
   */
  async showAllProjects(): Promise<void> {
    const dir = discoveryDirectory(path.join(this.host.paths.storage, 'helpers'));
    const summaries = await readProjectSummaries(dir, new Date(), isWindowAlive);
    if (!summaries.length) { void this.host.notify('info', 'No Hydra projects found.'); return; }
    const livenessLabel = { running: undefined, 'not-responding': 'Not responding', closed: 'Closed' } as const;
    const items = summaries
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(summary => {
        const isThisWindow = summary.pid === process.pid && summary.folder === this.helpers?.service.leadFolder;
        const counts = [
          summary.heads.running ? `${summary.heads.running} head${summary.heads.running === 1 ? '' : 's'} running` : undefined,
          summary.lanes.running ? `${summary.lanes.running} lane${summary.lanes.running === 1 ? '' : 's'}` : undefined,
          summary.blocked.length ? `${summary.blocked.length} blocked` : undefined,
        ].filter(Boolean).join(' · ') || 'Nothing running';
        const label = livenessLabel[summary.liveness];
        const detail = summary.liveness === 'closed' ? 'This window has closed.'
          : summary.liveness === 'not-responding' ? 'No update from this window in over 3 minutes.'
          : summary.blocked.length ? summary.blocked.map(item => `${item.title}: ${item.reason}`).join(' · ')
          : Object.entries(summary.evidence).filter(([, count]) => count).map(([status, count]) => `${count} ${evidenceLabel(status as EvidenceStatus)}`).join(' · ') || 'No evidence recorded yet.';
        return { label: summary.name, description: [isThisWindow ? 'This window' : undefined, label, counts].filter(Boolean).join(' · '), detail, summary, isThisWindow };
      });
    const pick = await this.host.pick(items, { placeHolder: 'Every Hydra project window (read-only)', matchOnDetail: true });
    if (!pick || pick.isThisWindow) return;
    if (pick.summary.liveness === 'closed') { void this.host.notify('info', `${pick.summary.name}'s window has closed.`); return; }
    await this.host.openFolder(pick.summary.folder, { forceNewWindow: false, forceReuseWindow: false });
  }
  /**
   * First run (docs/Heads.md, "Connecting Claude Code and Codex"): once, in an installed desktop Hydra, connect the
   * agents whose command-line tools are already on this computer (installing their extensions), so a new user
   * doesn't have to find Connect. Anything that fails says so, with a way to Settings → Connectors.
   */
  async connectOnFirstRun(): Promise<void> {
    const startup = await this.host.command<{ development: boolean }>('hydra.desktop.startupContext').catch(() => undefined);
    if (!shouldConnectOnFirstRun({ desktop: this.ide.desktop(), production: !this.host.development,
      development: startup?.development !== false, test: !!process.env.HYDRA_TEST_REPOSITORY, handoff: this.ide.inHandoff(), done: !!this.host.globalState.get(firstRunConnectKey, undefined) })) return;
    await this.host.globalState.update(firstRunConnectKey, true);
    const connections = await this.helperConnections();
    const row = (provider: ConnectableProvider) => connections.find(item => item.provider === provider);
    const cli = async (provider: 'claude' | 'codex') => !!(await findProvider(provider, this.host.settings.machine<string>(provider === 'claude' ? 'claudePath' : 'codexPath') || undefined).catch(() => undefined))?.executable;
    const wanted = firstRunProviders({
      claude: { cli: await cli('claude'), connected: !!row('claude')?.connected, extension: !!row('claude')?.extensionInstalled },
      codex: { cli: await cli('codex'), connected: !!row('codex')?.connected, extension: !!row('codex')?.extensionInstalled },
    });
    if (!wanted.length) return;
    const done: string[] = [], failed: string[] = [];
    await this.host.withProgress('Hydra: connecting your agents', async progress => {
      for (const provider of wanted) {
        const name = provider === 'claude' ? 'Claude Code' : 'Codex';
        progress.report({ message: `${name}…` });
        try { await this.connectHelpers(provider); done.push(name); }
        catch (error) { failed.push(`${name} (${describe(error)})`); this.host.log(`[heads] first run: couldn't connect ${provider}: ${describe(error)}`); }
      }
    });
    this.ide.connectionsChanged();
    if (failed.length) {
      const pick = await this.host.notify('warning', `Hydra couldn't connect ${failed.join(', ')}.${done.length ? ` ${done.join(' and ')} ${done.length === 1 ? 'is' : 'are'} connected.` : ''}`, 'Open Connectors');
      if (pick) await this.host.command('hydra.openSettings', 'connectors');
    } else void this.host.notify('info', `${done.join(' and ')} ${done.length === 1 ? 'is' : 'are'} connected to Hydra: chat in ${done.length === 1 ? 'its extension' : 'their extensions'}, and they can start Hydra heads.`);
  }
  /** Dashboard actions: review a helper's changes as a diff, open its log, view its gate evidence, or cancel it. */
  private async helperAction(action: 'helperReview' | 'helperLog' | 'helperCancel' | 'helperAnswer' | 'helperEvidence', jobId: string): Promise<void> {
    const helpers = this.helpers;
    const job = helpers?.store.get(jobId);
    if (!helpers || !job) throw new Error('That head is not in this window.');
    if (action === 'helperCancel') { await helpers.service.handle({ role: 'lead', leadKey: job.leadKey }, 'hydra_cancel_head', { job_id: jobId, reason: 'Cancelled from the Agents view.' }, new AbortController().signal); return; }
    if (action === 'helperEvidence') { await this.openEvidence('head', jobId); return; }
    if (action === 'helperAnswer') {
      // The head is waiting on the lead; you can answer in its place from the Agents view.
      if (job.state !== 'blocked') throw new Error('That head is not waiting for an answer.');
      const message = await this.host.input({ title: `Answer "${job.title}"`, prompt: job.question || 'The head is waiting for an answer.', placeHolder: 'Your answer', ignoreFocusOut: true, validateInput: value => value.trim() && value.length <= 8000 ? undefined : 'Write an answer (up to 8000 characters).' });
      if (message === undefined) return;
      await helpers.service.handle({ role: 'lead', leadKey: job.leadKey }, 'hydra_reply_to_head', { job_id: jobId, message }, new AbortController().signal);
      return;
    }
    if (action === 'helperLog') {
      const log = path.join(this.storageDirectory, 'helpers', 'logs', `${jobId}.jsonl`);
      await this.host.openFileBeside(log);
      return;
    }
    if (!job.worktree || !job.baseCommit) throw new Error('This head has no changes yet.');
    const head = job.result?.commit || (await git(job.worktree, ['rev-parse', 'HEAD'])).trim();
    const diff = await git(job.worktree, ['diff', '--stat', '--patch', '--no-color', job.baseCommit, head, '--']);
    await this.host.openText(`# ${job.title} (Hydra head ${job.id})\n# ${job.branch} ${job.baseCommit.slice(0, 12)}..${head.slice(0, 12)}\n# Merge it yourself with git when you're happy: git merge ${job.branch}\n\n${diff || '(no changes)'}`, 'diff');
  }
  /**
   * View evidence: the Markdown is written next to the evidence (in the run's log root) and
   * previewed from there, because the preview follows links and shows images relative to the
   * document but refuses `file:` links.
   */
  async openEvidence(kind: 'head' | 'lane', id: string): Promise<void> {
    let base: string, markdown: string;
    if (kind === 'head') {
      const job = this.helpers?.store.get(id);
      if (!job?.result?.checks.length) throw new Error('This head has no gate results yet.');
      base = path.join(this.storageDirectory, 'helpers', 'logs');
      markdown = buildEvidenceMarkdown({ title: job.title, worktree: job.worktree ?? this.helpers!.service.leadFolder, logDirectories: [base], baseDirectory: base, results: job.result.checks, ...(job.result.status ? { status: job.result.status, commit: job.result.commit } : {}) });
    } else {
      const evidence = this.lanes.laneEvidence(id), root = this.lanes.laneGatesLogRoot();
      if (!evidence || !root) throw new Error('This lane has no gate results yet.');
      base = root;
      markdown = buildEvidenceMarkdown({ title: evidence.title, worktree: evidence.worktree, logDirectories: [root], baseDirectory: root, results: evidence.results, ...(evidence.status ? { status: evidence.status, commit: evidence.commit, stale: evidence.stale } : {}) });
    }
    await mkdir(base, { recursive: true });
    const file = path.join(base, `${id}-evidence.md`);
    await writeFile(file, markdown, 'utf8');
    await this.host.openMarkdown(file, { fallback: false });
  }
}
