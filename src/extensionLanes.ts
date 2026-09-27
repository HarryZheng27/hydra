import * as vscode from 'vscode';
import path from 'node:path';
import { git, gitMetaChanges, gitMetaFingerprint } from './core/git';
import { findProvider } from './core/providers';
import { claudeStatus, codexStatus, providerPaths, type HelperServerSpec } from './core/helperRegistration';
import { loadNodePty, terminalText, terminalsUnavailable, type PtyModule } from './core/lanePty';
import { LaneStore, isLaneId, laneGoalMax, parseLaneName, type Lane } from './core/lanes';
import { LaneService, gatesPassNote, maxOpenLanes } from './core/laneService';
import { defaultCommitMessage, laneDiffFiles, type CloseMode } from './core/laneFinish';
import { flattenGateFailureMessage, summarizeGateFailures, type GatesLoader, type GatesOutcome } from './core/gates';
import { parsePreviewConfig, savePreviewConfig, splitPreviewCommand, type PreviewConfig } from './core/lanePreview';
import type { EvidenceStatus, JobCheckResult } from './core/jobs';
import { laneActions, type AgentsView, type LaneAction, type LaneClientMessage, type LaneLimitOfferView, type LaneOfferButtonId, type LaneServerMessage, type LaneView, type Provider } from './core/model';
import { otherProvider, type LimitEvent } from './core/limitEvents';
import { buildHandoff } from './core/limitHandoff';
import { laneOfferButtons, laneOfferMessage, laneSwitchCountdownSeconds, LimitOfferTracker } from './core/limitOffer';
import { openHandoffPreview, saveHandoff } from './extensionLimitOffer';
// ---- Plan lanes (docs/Plan_Lanes_Plan.md). Their own block. ----
import { laneNameFromTitle, type LanePlanLink } from './core/lanes';
import type { LanePlanJobView } from './core/model';
import type { Plan, PlanJob } from './core/plans';
import { planLaneBrief, type PlanLaneLook, type PlanLaneResultInput, type PlanLaneStart } from './core/planRunner';
// ---- Auto-dispatch (Step C) ----
import { LaneDispatch, type DispatchCheck, type DispatchRunner } from './core/laneDispatch';
// ---- Packs (docs/Packs_Plan.md) ----
import type { RoleSource } from './core/packs/launch';
// ---- Stop all (5.3) ----
import type { StopSwitch } from './core/stopSwitch';
// ---- Audit log (5.2) ----
import { laneOverrideEvent, type AuditEvent } from './core/audit';

/**
 * The editor side of Hydra lanes (docs/Lanes_And_Planner_Plan.md): commands,
 * the Agents webview's lane messages, confirmations before git writes, and the
 * multi-file diff. The lanes themselves live in LaneService.
 */
export interface LanesHost {
  context: vscode.ExtensionContext;
  log(line: string): void;
  /** Post to the Agents panel, if it is open. */
  post(message: LaneServerMessage): void;
  openAgents(): Promise<void>;
  /** The Agents panel is open and its webview has said it's ready. */
  webviewReady(): boolean;
  helperServerSpec(provider: Provider): HelperServerSpec;
  runningHeads(laneId: string): number;
  /** The open lanes changed (the discovery record lists their worktrees). */
  changed(): void;
  // ---- Gates (docs/Gates_Plan.md, "Lanes"): the same checked executable and limit awareness as HelperService's ----
  gatesExecutable(provider: Provider): Promise<string>;
  gatesLimited(provider: Provider): boolean;
  // ---- Plan lanes (docs/Plan_Lanes_Plan.md): the plan job a lane runs, and what its plan actions do ----
  /** The plan job this lane runs, with its status; undefined for an ordinary lane. */
  planJob?(laneId: string): LanePlanJobView | undefined;
  /** Mark job done: record what the lane hands on; the jobs after it start. */
  markJobDone?(laneId: string, result: PlanLaneResultInput): Promise<void>;
  /** Cancel job: the job is cancelled and the lane stays open, as an ordinary lane. */
  cancelPlanJob?(laneId: string): Promise<void>;
  // ---- Packs (docs/Packs_Plan.md): gates.json plus the active packs' gates. Undefined reads gates.json only. ----
  gates?: GatesLoader;
  /** The active packs' roles, resolved at each lane launch. Undefined: a lane's role is never available. */
  roles?: RoleSource;
  // ---- Step 2 ----
  /** Hydra's global storage folder: a Claude lane's settings deny it (design 6). */
  hydraStorage?: string;
  // ---- Stop all (5.3) ----
  /** Without it, a lane always may launch or relaunch. */
  stop?: StopSwitch;
  // ---- 5.2: the audit log ----
  /** Without it, a "Merge with these changes"/"Merge anyway" override and similar aren't recorded. */
  audit?: (event: AuditEvent) => void;
  /** Step A: offer the one-time "Starter gates" choice for a project with no gates.json yet, after a lane merges into it. Never blocks the merge; fire-and-forget. */
  offerStarterGates?: (repository: string) => void;
  /** Step C: the plan runner, for checking an auto-dispatched job when its lane calls hydra_job_ready. */
  planRunner?: () => DispatchRunner | undefined;
}
/** Options for `hydra.lanes.action` (automation): no dialogs, so choices are passed in. */
export interface LaneActionOptions { message?: string; close?: CloseMode }


const laneMessages: ReadonlySet<string> = new Set(['laneNew', 'laneAttach', 'laneInput', 'laneResize', 'laneAction', 'laneLimitAction', 'laneCancelSwitch', 'view']);
export const isLaneMessage = (message: { type: string }): message is LaneClientMessage => laneMessages.has(message.type);
const baseScheme = 'hydra-lane';
const providerLabel = (provider: Provider) => provider === 'codex' ? 'Codex' : 'Claude Code';
const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function parseActionOptions(value: unknown): LaneActionOptions {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object') throw new Error('Lane action options must be an object.');
  const { message, close } = value as Record<string, unknown>;
  if (message !== undefined && (typeof message !== 'string' || !message.trim() || message.length > 5000)) throw new Error('The commit message must be 1–5000 characters.');
  if (close !== undefined && close !== 'merged' && close !== 'keep' && close !== 'delete') throw new Error('close must be "merged", "keep" or "delete".');
  return { ...(message !== undefined ? { message } : {}), ...(close !== undefined ? { close } : {}) };
}

export class LanesController implements vscode.Disposable {
  private service?: LaneService;
  private pty?: { module?: PtyModule };
  private pendingShow?: LaneServerMessage;
  /** The view the webview last reported (Canvas or Lanes), and what it focused. */
  private view: { view: AgentsView; focus?: string } = { view: 'canvas' };
  private posted = '';
  private readonly disposables: vscode.Disposable[] = [];
  private storageDirectory?: string;
  /** The main checkout lanes branch from: where the active packs are read. */
  private repository?: string;
  // ---- The usage-limit banner (docs/Gates_Plan.md, section 2), one per lane at most ----
  private readonly limitOffers = new Map<string, LaneLimitOfferView & { event: LimitEvent }>();
  private readonly switchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Lanes whose agent called hydra_job_ready and whose prompt is still showing (decision 6). */
  private readonly readyAsked = new Set<string>();
  /** Step C: hydra_job_ready in a plan that auto-dispatches: Hydra runs the gates instead of asking. */
  private dispatch?: LaneDispatch;
  /** Shared with registerLimitOffer's chat/head notifications, so "the other provider is limited too" sees every source. */
  constructor(private readonly host: LanesHost, private readonly limitTracker = new LimitOfferTracker()) {}

  /** node-pty from the host, loaded once on first use. */
  private ptyModule(): PtyModule | undefined {
    if (!this.pty) {
      const loaded = loadNodePty(vscode.env.appRoot);
      this.pty = loaded;
      if (!loaded.module) this.host.log(`[lanes] ${terminalsUnavailable} ${loaded.errors.join('; ')}`);
    }
    return this.pty.module;
  }

  registerCommands(command: (name: string, callback: (...args: any[]) => unknown) => void): void {
    command('hydra.newLane', () => this.newLane());
    command('hydra.openLanes', (focus?: unknown) => this.show('lanes', focus));
    command('hydra.openCanvas', (focus?: unknown) => this.show('canvas', focus));
    // Not contributed: for tests and automation. They never ask anything.
    command('hydra.lanes.list', () => this.state());
    command('hydra.lanes.start', async (input: unknown) => { const lane = await this.requireService().create(input); return this.viewOf(lane.id); });
    command('hydra.lanes.action', (id: unknown, action: unknown, options?: unknown) => this.action(id, action, false, parseActionOptions(options)));
    command('hydra.lanes.replay', (id: unknown) => this.requireService().replayOf(id));
  }

  /** Lanes need the window's lead folder, like heads: started with them. */
  async start(repository: string, storageDirectory: string): Promise<void> {
    if (this.service) return;
    this.storageDirectory = storageDirectory;
    this.repository = repository;
    const store = new LaneStore(storageDirectory, line => this.host.log(line));
    await store.load();
    const config = () => vscode.workspace.getConfiguration('hydra');
    this.service = new LaneService({
      store, repository,
      worktreeRoot: () => config().get<string>('worktreeRoot') || undefined,
      pty: this.ptyModule(),
      executable: async provider => {
        const info = await findProvider(provider, config().get<string>(`${provider}Path`) || undefined);
        if (!info.executable) throw new Error(`${providerLabel(provider)} CLI not found. Install it or set Hydra's ${provider} path.`);
        return info.executable;
      },
      connected: async provider => provider === 'claude'
        ? (await claudeStatus(providerPaths(), this.host.helperServerSpec('claude'))).connected
        : (await codexStatus(providerPaths().codexConfig, this.host.helperServerSpec('codex'))).connected,
      bridge: provider => this.host.helperServerSpec(provider),
      helpersDir: path.join(this.host.context.globalStorageUri.fsPath, 'helpers'),
      configDirectory: path.join(storageDirectory, 'lanes'),
      testCommand: () => process.env.HYDRA_TEST_LANE_COMMAND || undefined,
      runningHeads: id => this.host.runningHeads(id),
      onChange: () => this.changed(),
      onData: (id, data) => this.host.post({ type: 'laneData', id, data }),
      log: line => this.host.log(line),
      gatesExecutable: provider => this.host.gatesExecutable(provider),
      gatesLimited: provider => this.host.gatesLimited(provider),
      gatesLogDirectory: path.join(storageDirectory, 'lanes', 'gates'),
      previewLogDirectory: path.join(storageDirectory, 'lanes', 'preview'),
      planOf: id => { const job = this.planJobOf(id); return job ? { title: job.planTitle, job: job.jobTitle, dependents: job.dependents } : undefined; },
      ...(this.host.gates ? { gates: this.host.gates } : {}),
      ...(this.host.roles ? { roles: this.host.roles } : {}),
      ...(this.host.hydraStorage ? { hydraStorage: this.host.hydraStorage } : {}),
      ...(this.host.stop ? { stop: this.host.stop } : {}),
    });
    this.disposables.push(vscode.workspace.registerTextDocumentContentProvider(baseScheme, { provideTextDocumentContent: uri => this.baseContent(uri) }));
    this.dispatch = new LaneDispatch({
      lanes: this.service, runner: () => this.host.planRunner?.(),
      onGatesProgress: (id, progress) => this.host.post({ type: 'laneGates', id, done: progress.done, ...(progress.running ? { running: progress.running } : {}) }),
      onChecked: (id, check, job) => this.dispatchChecked(id, check, job),
      log: line => this.host.log(line),
    });
    this.service.activate();
    this.host.log(`[lanes] ready (${store.open().length} open, terminals ${this.ptyModule() ? 'available' : 'unavailable'})`);
  }

  // ---- For the heads service, the endpoint and the discovery record ----

  exists(id: string): boolean { return !!this.service?.exists(id); }
  laneName(id: string): string | undefined { return this.service?.name(id); }
  /** For View evidence (docs/Gates_Plan.md): the lane's last gates run, or undefined when none has run yet. */
  laneEvidence(id: string): { title: string; worktree: string; results: JobCheckResult[]; status?: EvidenceStatus; commit?: string; stale?: boolean } | undefined {
    const lane = this.service?.get(id);
    if (!lane?.lastGates?.results.length) return undefined;
    const stale = this.viewOf(id)?.gatesStale;
    return { title: lane.name, worktree: lane.worktree, results: lane.lastGates.results, ...(lane.lastGates.status ? { status: lane.lastGates.status, commit: lane.lastGates.commit, stale } : {}) };
  }
  /** Where this window's lane gate runs keep their logs and screenshots, for the evidence document's path check. */
  laneGatesLogRoot(): string | undefined { return this.storageDirectory ? path.join(this.storageDirectory, 'lanes', 'gates') : undefined; }
  describe(you?: string): Promise<unknown> {
    if (!this.service) throw new Error('Lanes are not available in this Hydra window.');
    return this.service.describe(you);
  }
  openWorktrees(): string[] { return this.service?.openWorktrees() ?? []; }
  /** Packs (docs/Packs_Plan.md): the active roles changed. Tell running lanes right away, instead of only at their next launch. */
  async activeRolesChanged(): Promise<void> { await this.service?.activeRolesChanged(); this.changed(); }
  /** For ClaudeChatLimits (src/extensionLimits.ts): this window's open lanes, for owning a chat cwd or a lane id. */
  laneWorktreeEntries(): { id: string; worktree: string }[] { return this.service?.lanes().map(lane => ({ id: lane.id, worktree: lane.worktree })) ?? []; }
  /** For the Codex account-limit fan-out (src/extension.ts): this window's running lanes of one provider. */
  runningLanes(provider: Provider): { id: string; worktree: string }[] { return (this.service?.views() ?? []).filter(lane => lane.running && lane.provider === provider).map(lane => ({ id: lane.id, worktree: lane.worktree })); }
  /** 5.3: Hydra: Stop All Agents. Ends every open lane's process, keeping the lane and its worktree. */
  async stopProcesses(): Promise<number> { return this.service?.stopProcesses() ?? 0; }

  // ---- The Agents webview ----

  state(): { lanes: LaneView[]; terminals: boolean } {
    const lanes = (this.service?.views() ?? []).map(view => { const planJob = this.planJobOf(view.id); return planJob ? { ...view, planJob } : view; });
    return { lanes, terminals: !!this.ptyModule() };
  }
  private viewOf(id: string): LaneView | undefined { return this.service?.views().find(view => view.id === id); }
  private postState(force = false): void {
    const state = this.state(), text = JSON.stringify(state);
    if (!force && text === this.posted) return;
    this.posted = text;
    this.host.post({ type: 'lanes', ...state });
  }
  private changed(): void { this.postState(); this.host.changed(); }

  /** The webview (re)loaded: send the lanes, and a Canvas or Lanes request that was waiting for it. */
  webviewReady(): void {
    this.postState(true);
    const pending = this.pendingShow; this.pendingShow = undefined;
    if (pending) this.host.post(pending);
  }

  async handle(message: LaneClientMessage): Promise<void> {
    switch (message.type) {
      case 'view': this.view = { view: message.view, ...(message.focus ? { focus: message.focus } : {}) }; return;
      case 'laneAttach':
        this.postState(true);
        for (const { id, data } of this.service?.replay() ?? []) this.host.post({ type: 'laneReplay', id, data });
        for (const [id, offer] of this.limitOffers) this.host.post({ type: 'laneLimit', id, offer });
        return;
      case 'laneInput': this.service?.input(message.id, message.data); return;
      case 'laneResize':
        // A tile can report its size just as its lane closes; that isn't worth an error.
        try { this.service?.resize(message.id, message.cols, message.rows); } catch (error) { this.host.log(`[lanes] resize: ${describe(error)}`); }
        return;
      case 'laneNew':
        try {
          const lane = await this.requireService().create(message);
          this.postState(true);
          this.host.post({ type: 'show', view: 'lanes', focus: lane.id });
        } catch (error) { this.host.post({ type: 'laneError', message: describe(error) }); }
        return;
      case 'laneAction': await this.action(message.id, message.action, true); return;
      case 'laneLimitAction': await this.handleLimitAction(message.id, message.action); return;
      case 'laneCancelSwitch': this.cancelSwitch(message.id); return;
    }
  }

  // ---- The usage-limit banner (docs/Gates_Plan.md, section 2) ----

  /**
   * A `source: "lane"` limit event for one of this window's lanes: banner it (or
   * count down to an automatic switch, for `hydra.lanes.onLimit: "switch"`).
   * Events for other windows' lanes, or events without a lane, are ignored here.
   */
  async onLimitEvent(event: LimitEvent): Promise<void> {
    if (event.source !== 'lane' || !event.laneId || !this.exists(event.laneId)) return;
    const laneId = event.laneId;
    // A late event from the agent a lane has already switched away from is stale.
    if (this.service?.lanes().find(lane => lane.id === laneId)?.provider !== event.provider) return;
    const considered = this.limitTracker.consider(event, new Date());
    if (!considered) return; // a repeat of the same lane within the dedupe window
    // The choice lives on the tile; a notification makes sure it isn't missed when the Lanes view is out of sight.
    void vscode.window.showWarningMessage(`Lane ${this.laneName(laneId) ?? laneId}: ${laneOfferMessage(event, new Date())}`, 'Show lane')
      .then(choice => { if (choice) void this.show('lanes', laneId); });
    if (considered.otherAlsoLimited) { this.setOffer(laneId, event, true); return; }
    const onLimit = vscode.workspace.getConfiguration('hydra').get<string>('lanes.onLimit', 'ask');
    if (onLimit === 'switch') { this.startSwitchCountdown(laneId, event); return; }
    this.setOffer(laneId, event, false);
  }

  private setOffer(laneId: string, event: LimitEvent, otherAlsoLimited: boolean): void {
    const offer: LaneLimitOfferView = { provider: event.provider, message: laneOfferMessage(event, new Date()), buttons: laneOfferButtons(otherAlsoLimited) };
    this.limitOffers.set(laneId, { ...offer, event });
    this.host.post({ type: 'laneLimit', id: laneId, offer });
  }
  private clearOffer(laneId: string): void {
    if (!this.limitOffers.delete(laneId)) return;
    this.host.post({ type: 'laneLimit', id: laneId });
  }

  private startSwitchCountdown(laneId: string, event: LimitEvent): void {
    this.switchTimers.get(laneId) && this.cancelSwitch(laneId);
    const to = otherProvider(event.provider);
    const deadline = Date.now() + laneSwitchCountdownSeconds * 1000;
    this.host.post({ type: 'laneSwitchCountdown', id: laneId, to, deadline });
    const timer = setTimeout(() => {
      this.switchTimers.delete(laneId);
      this.host.post({ type: 'laneSwitchCancelled', id: laneId }); // the countdown ended (successfully or not); either way, stop showing it
      void this.performSwitch(laneId, 'limit', event).catch(error => this.host.log(`[lanes] ${laneId} auto-switch: ${describe(error)}`));
    }, laneSwitchCountdownSeconds * 1000);
    this.switchTimers.set(laneId, timer);
  }
  /** `hydra.lanes.onLimit: "switch"`'s Cancel button on the countdown. */
  cancelSwitch(laneId: string): void {
    const timer = this.switchTimers.get(laneId);
    if (!timer) return;
    clearTimeout(timer);
    this.switchTimers.delete(laneId);
    this.host.post({ type: 'laneSwitchCancelled', id: laneId });
  }

  private async handleLimitAction(laneId: string, action: LaneOfferButtonId): Promise<void> {
    const offer = this.limitOffers.get(laneId);
    try {
      switch (action) {
        case 'wait': this.clearOffer(laneId); return;
        case 'viewHandoff': {
          const event = offer?.event ?? { provider: offer?.provider ?? 'claude', source: 'lane' as const, laneId, at: new Date().toISOString(), cwd: this.service?.get(laneId)?.worktree };
          const handoff = await buildHandoff({ event });
          const file = await saveHandoff(this.storageDirectory ?? '', event, handoff.markdown);
          await openHandoffPreview(file);
          return;
        }
        case 'continueOther':
          this.clearOffer(laneId);
          await this.performSwitch(laneId, 'limit', offer?.event);
          return;
      }
    } catch (error) {
      this.host.log(`[lanes] ${laneId} ${action}: ${describe(error)}`);
      void vscode.window.showErrorMessage(`Hydra: ${describe(error)}`);
    }
  }

  /** The actual switch, whether from the banner, the countdown, or "⋯ → Switch to <Other>". */
  private async performSwitch(laneId: string, reason: 'limit' | 'manual', event?: LimitEvent): Promise<void> {
    this.clearOffer(laneId);
    await this.requireService().switchProvider(laneId, reason, event);
    this.postState(true);
  }

  // ---- Plan lanes (docs/Plan_Lanes_Plan.md) ----

  /** Whether this window has lanes at all (a trusted Git folder, started): without them a plan's lane jobs neither start nor fail. */
  get available(): boolean { return !!this.service; }
  /** The plan job a lane runs, while the lane still carries its plan link. */
  private planJobOf(laneId: string): LanePlanJobView | undefined {
    return this.service?.record(laneId)?.plan ? this.host.planJob?.(laneId) : undefined;
  }
  /** A lane as the plan runner sees it, closed or not, while the store keeps it. */
  laneLook(id: string): PlanLaneLook | undefined {
    const lane = this.service?.record(id);
    return lane && { name: lane.name, state: lane.state, branch: lane.branch, baseCommit: lane.baseCommit, ...(lane.mergedHead ? { mergedHead: lane.mergedHead } : {}), ...(lane.closedAs ? { closedAs: lane.closedAs } : {}), ...(lane.lastGates?.status && lane.lastGates.commit === lane.mergedHead ? { gatesStatus: lane.lastGates.status } : {}) };
  }
  /** Open lanes whose plan link names a job of this plan, for adopting a start whose record was never saved. */
  planLanes(planId: string): { laneId: string; jobKey: string; attempt: number }[] {
    return (this.service?.lanes() ?? []).filter(lane => lane.plan?.planId === planId).map(lane => ({ laneId: lane.id, jobKey: lane.plan!.jobKey, attempt: lane.plan!.attempt ?? 0 }));
  }
  /**
   * Start a plan's lane job (docs/Plan_Lanes_Plan.md, "Starting a lane job"): named from the job's title,
   * with its brief as the goal (the full brief in .hydra-job/brief.md), from the commit its dependencies
   * handed on. With 24 lanes open it waits instead.
   */
  async startPlanLane(plan: Plan, job: PlanJob, start: PlanLaneStart, defaultProvider: Provider): Promise<{ laneId: string } | { wait: string }> {
    const service = this.requireService();
    if (!service.terminalsAvailable) throw new Error(terminalsUnavailable);
    if (service.lanes().length >= maxOpenLanes) return { wait: `Waiting: ${maxOpenLanes} lanes are open.` };
    const brief = job.brief.trim();
    const goal = brief.length > laneGoalMax ? `${brief.slice(0, laneGoalMax - 1).trimEnd()}…` : brief;
    const link: LanePlanLink = {
      planId: plan.id, jobKey: job.key, planTitle: plan.title, jobTitle: job.title, ...(job.attempt ? { attempt: job.attempt } : {}),
      ...(start.dependencies.length ? { startsFrom: start.dependencies.slice(0, 12).map(dependency => ({ title: dependency.title.slice(0, 80), commit: dependency.commit })) } : {}),
      ...(job.writeScope?.length ? { writeScope: job.writeScope.slice(0, 32) } : {}),
      ...(plan.dispatch ? { dispatched: true as const } : {}),
    };
    const file = planLaneBrief(plan.title, job, start.dependencies);
    // Packs (docs/Packs_Plan.md, "Plans"): the job's provider, then its role's, then hydra.defaultProvider. A role
    // that isn't active now still goes with the lane, which starts without it and says why on its tile.
    const roleProvider = job.role && !job.provider ? (await this.host.roles?.roles(this.repository ?? '').catch(() => []))?.find(role => role.ref === job.role)?.provider : undefined;
    // Step C: an auto-dispatched plan's provider stands in for hydra.defaultProvider; the job's own choice still comes first.
    const lane = await service.create({ name: laneNameFromTitle(job.title), provider: job.provider ?? roleProvider ?? plan.dispatch?.provider ?? defaultProvider, goal, ...(job.role ? { role: job.role } : {}) }, { ...(start.baseCommit ? { baseCommit: start.baseCommit } : {}), plan: link, brief: file });
    this.postState(true);
    return { laneId: lane.id };
  }
  /** Cancel job: the lane carries on as an ordinary lane. */
  async unlinkPlan(id: string): Promise<void> {
    await this.requireService().unlinkPlan(id);
    this.postState(true);
  }
  /** A plan's jobs changed: the tiles' plan chips follow. */
  planStatesChanged(): void { this.postState(); }
  /**
   * hydra_job_ready (decision 6): the lane's agent says its plan job is ready. You get a Mark job done
   * prompt; Hydra never marks the job itself. Its note, if any, is the note's default. In a plan that
   * auto-dispatches (Step C), Hydra checks the job instead: LaneDispatch runs the gates and marks it or sends failures back.
   */
  async jobReady(laneId: string, note?: string): Promise<unknown> {
    const lane = this.service?.get(laneId);
    const job = lane ? this.planJobOf(laneId) : undefined;
    if (!lane || !job) throw new Error('This lane doesn\'t run a plan job, so there is nothing to mark done.');
    if (job.state === 'failed' || job.state === 'cancelled' || job.state === 'skipped') throw new Error(`Job ${job.jobTitle} has ended (${job.state}); it can't be marked done.`);
    if (job.dependentsStarted) throw new Error(`Job ${job.jobTitle} is done, and the jobs after it have already started from its result.`);
    // Step C: the plan auto-dispatches, so Hydra checks the job itself; no prompt.
    if (this.dispatch?.handles(laneId)) return this.dispatch.ready(laneId, note);
    if (this.readyAsked.has(laneId)) return { asked: true, message: 'The user already has a prompt to mark this job done. Wait for them.' };
    this.readyAsked.add(laneId);
    void vscode.window.showInformationMessage(`Lane ${lane.name} says job ${job.jobTitle} of plan ${job.planTitle} is ready.`, 'Mark job done', 'Show lane').then(async pick => {
      this.readyAsked.delete(laneId);
      if (pick === 'Mark job done') await this.action(laneId, 'markJobDone', true, note ? { message: note } : {});
      else if (pick === 'Show lane') await this.show('lanes', laneId);
    }, () => { this.readyAsked.delete(laneId); });
    return { asked: true, message: 'Hydra asked the user to mark the job done. It never marks the job by itself: the user decides, and may merge the lane instead. Wait for them.' };
  }

  /** Step C: how an auto-dispatched job's check ended, as a notification. A failure sent back to the lane needs none. */
  private dispatchChecked(laneId: string, check: DispatchCheck, job: { planTitle: string; jobTitle: string }): void {
    this.postState(true);
    const name = this.laneName(laneId) ?? job.jobTitle;
    const showLane = (pick: string | undefined) => { if (pick) void this.show('lanes', laneId); };
    switch (check.kind) {
      case 'passed':
        void vscode.window.showInformationMessage(`Job ${job.jobTitle} of plan ${job.planTitle} passed its gates and is done at ${check.commit.slice(0, 7)}.`, 'Show lane').then(showLane);
        return;
      case 'failed':
        void vscode.window.showWarningMessage(`Job ${job.jobTitle} of plan ${job.planTitle} failed. ${check.reason}`, 'Show lane').then(showLane);
        return;
      case 'error':
        void vscode.window.showWarningMessage(`Hydra couldn't check job ${job.jobTitle} in lane ${name}: ${check.message} Mark it done yourself when it's ready.`, 'Show lane').then(showLane);
        return;
      case 'retry':
        if (check.sent) return;
        // Its session has ended (Stop all, or it exited). Nothing ran unasked: the clipboard is yours, so copying waits for you.
        void vscode.window.showWarningMessage(`Gates failed for job ${job.jobTitle} (attempt ${check.failures}${check.attempts ? ` of ${check.attempts}` : ''}), but lane ${name} isn't running, so the failures weren't sent.`, 'Copy failures', 'Resume')
          .then(async pick => {
            if (pick === 'Copy failures') await vscode.env.clipboard.writeText(terminalText(check.text));
            else if (pick === 'Resume') { await this.service?.resume(laneId); await this.show('lanes', laneId); }
          });
        return;
    }
  }

  /** `hydra.openLanes` / `hydra.openCanvas`: open the Agents view on that view, optionally focusing a lane or head. */
  async show(view: AgentsView, focus?: unknown): Promise<void> {
    const message: LaneServerMessage = { type: 'show', view, ...(typeof focus === 'string' && isLaneId(focus) ? { focus } : {}) };
    await this.host.openAgents();
    if (this.host.webviewReady()) this.host.post(message);
    else this.pendingShow = message;
  }
  get currentView(): { view: AgentsView; focus?: string } { return { ...this.view }; }

  // ---- Commands ----

  /** `hydra.newLane`: a Role step first when roles are active, then provider, name and goal (docs/Packs_Plan.md, "Picking a role"). */
  private async newLane(): Promise<void> {
    const service = this.requireService();
    if (!service.terminalsAvailable) { void vscode.window.showErrorMessage(`Hydra: ${terminalsUnavailable}`); return; }
    const config = vscode.workspace.getConfiguration('hydra');
    const preferred = config.get<Provider>('defaultProvider', 'claude') === 'codex' ? 'codex' : 'claude';
    const roles = await this.host.roles?.roles(this.repository ?? '').catch(() => []) ?? [];
    const steps = roles.length ? 4 : 3;
    let role: { ref: string; provider: Provider } | undefined;
    if (roles.length) {
      const roleItems = [{ label: 'No role', role: undefined as { ref: string; provider: Provider } | undefined },
        ...roles.map(candidate => ({ label: candidate.title, description: candidate.packTitle, role: { ref: candidate.ref, provider: candidate.provider } }))];
      const pickedRole = await vscode.window.showQuickPick(roleItems, { title: `New lane (1/${steps})`, placeHolder: 'Role, optional', ignoreFocusOut: true });
      if (!pickedRole) return;
      role = pickedRole.role;
    }
    const providers = await Promise.all((['claude', 'codex'] as const).map(async provider => ({ provider, available: (await findProvider(provider, config.get<string>(`${provider}Path`) || undefined).catch(() => ({ available: false }))).available })));
    const defaultProvider = role?.provider ?? preferred;
    const items = providers.sort((a, b) => Number(b.provider === defaultProvider) - Number(a.provider === defaultProvider))
      .map(({ provider, available }) => ({ label: providerLabel(provider), description: available ? (provider === defaultProvider ? 'Default' : '') : 'Not installed', provider }));
    const picked = await vscode.window.showQuickPick(items, { title: `New lane (${roles.length ? 2 : 1}/${steps})`, placeHolder: 'Which agent runs in this lane?', ignoreFocusOut: true });
    if (!picked) return;
    const taken = new Set(service.lanes().map(lane => lane.name.toLowerCase()));
    let number = service.lanes().length + 1;
    while (taken.has(`lane ${number}`)) number++;
    const name = await vscode.window.showInputBox({
      title: `New lane (${roles.length ? 3 : 2}/${steps})`, prompt: 'Name the lane', value: `Lane ${number}`, ignoreFocusOut: true,
      validateInput: value => { try { parseLaneName(value); return undefined; } catch (error) { return describe(error); } },
    });
    if (name === undefined) return;
    const goal = await vscode.window.showInputBox({
      title: `New lane (${steps}/${steps})`, prompt: `Goal, optional: what should ${picked.label} do? Leave it empty to start without a prompt.`, ignoreFocusOut: true,
      validateInput: value => value.length <= laneGoalMax ? undefined : `Keep the goal under ${laneGoalMax} characters.`,
    });
    if (goal === undefined) return;
    const lane = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Starting lane ${name.trim()}…` },
      () => service.create({ name, provider: picked.provider, goal, ...(role ? { role: role.ref } : {}) }));
    await this.show('lanes', lane.id);
  }

  /**
   * A lane action. From the webview (`interactive`) it asks before git writes and
   * reports failures as messages; from `hydra.lanes.action` it asks nothing and throws.
   */
  async action(id: unknown, action: unknown, interactive: boolean, options: LaneActionOptions = {}): Promise<unknown> {
    if (typeof action !== 'string' || !laneActions.includes(action as LaneAction)) throw new Error('Unknown lane action.');
    const service = this.requireService();
    const lane = typeof id === 'string' ? service.get(id) : undefined;
    if (!lane) throw new Error('That lane isn\'t open in this window.');
    try { return await this.run(service, lane, action as LaneAction, interactive, options); }
    catch (error) {
      this.host.log(`[lanes] ${lane.id} ${action}: ${describe(error)}`);
      if (!interactive) throw error;
      void vscode.window.showErrorMessage(`Hydra: ${describe(error)}`);
      return undefined;
    }
  }

  private async run(service: LaneService, lane: Lane, action: LaneAction, interactive: boolean, options: LaneActionOptions): Promise<unknown> {
    const info = (message: string, ...items: string[]) => interactive ? vscode.window.showInformationMessage(message, ...items) : Promise.resolve(undefined);
    switch (action) {
      case 'refresh': await service.sync(); this.postState(true); return this.viewOf(lane.id);
      case 'resume': await service.resume(lane.id); return this.viewOf(lane.id);
      case 'restart': {
        if (interactive && this.viewOf(lane.id)?.running) {
          const pick = await vscode.window.showWarningMessage(`Start lane ${lane.name} fresh?`, { modal: true, detail: 'Its current session ends and a new conversation starts in the same worktree.' }, 'Start fresh');
          if (pick !== 'Start fresh') return undefined;
        }
        await service.restart(lane.id);
        return this.viewOf(lane.id);
      }
      case 'switchProvider': {
        const to = otherProvider(lane.provider);
        if (interactive) {
          const label = `Switch to ${providerLabel(to)}`;
          const pick = await vscode.window.showWarningMessage(`Switch lane ${lane.name} to ${providerLabel(to)}?`, { modal: true, detail: 'Its current session ends and a handoff opens the new CLI in the same worktree. Uncommitted work is untouched.' }, label);
          if (pick !== label) return undefined;
        }
        await this.performSwitch(lane.id, 'manual');
        return this.viewOf(lane.id);
      }
      case 'commit': {
        let message = options.message;
        if (interactive) {
          message = await vscode.window.showInputBox({ title: `Commit lane ${lane.name}`, prompt: 'Commit message (all changes in the lane are committed)', value: defaultCommitMessage(lane), ignoreFocusOut: true, validateInput: value => value.trim() && value.length <= 5000 ? undefined : 'Write a commit message.' });
          if (message === undefined) return undefined;
        }
        const commit = await service.commit(lane.id, message);
        void info(commit ? `Committed ${commit.slice(0, 7)} in lane ${lane.name}.` : `Lane ${lane.name} has nothing to commit.`);
        return { commit };
      }
      case 'merge': {
        const check = await service.checkMerge(lane.id);
        if (!check.ok) {
          if (!interactive) throw new Error(check.message);
          if (check.reason === 'nothing') { void info(check.message); return undefined; }
          if (check.reason === 'dirty') {
            const pick = await vscode.window.showWarningMessage(check.message, { modal: true }, 'Commit…');
            if (pick !== 'Commit…') return undefined;
            const committed = await this.run(service, lane, 'commit', true, {}) as { commit?: string } | undefined;
            return committed?.commit ? this.run(service, service.get(lane.id) ?? lane, 'merge', true, {}) : undefined;
          }
          if (check.reason === 'conflicts') {
            const update = `Update from ${lane.target}`;
            const pick = await vscode.window.showWarningMessage(check.message, { modal: true }, update);
            return pick === update ? this.run(service, lane, 'update', true, {}) : undefined;
          }
          throw new Error(check.message);
        }
        // Gates (docs/Gates_Plan.md, "Merge"): after the commit-first refusals, before the merge
        // confirmation, when this project's gates.json says lanes: "onMerge" and there are gates.
        // 1.4: planted git config or hooks first, before the gates run anything in the worktree.
        if (!await this.gitMetaBefore(lane, interactive, 'Merge with these changes', 'Merging runs git in your main checkout, which would run them.')) return undefined;
        const gated = await this.gatesBefore(service, lane, interactive, 'Merge anyway?', 'Merge anyway');
        if (!gated) return undefined; // cancelled, sent to the lane, or gates couldn't run and this was interactive
        const gatesNote = gated.note;
        if (interactive) {
          const pick = await vscode.window.showInformationMessage(`Merge lane ${lane.name} into ${lane.target}?`, { modal: true, detail: `${plural(check.commits, 'commit')}, ${plural(check.files, 'file')}. Merges cleanly.${gatesNote}` }, 'Merge');
          if (pick !== 'Merge') return undefined;
        }
        const commit = await service.merge(lane.id);
        this.host.offerStarterGates?.(lane.repository);
        if (interactive) {
          const next = await vscode.window.showInformationMessage(`Merged lane ${lane.name} into ${lane.target}.`, 'Close lane');
          if (next === 'Close lane' && service.get(lane.id)) await this.run(service, service.get(lane.id)!, 'close', true, {});
        }
        return { commit };
      }
      case 'update': {
        const result = await service.update(lane.id);
        if (interactive) {
          if (result.conflicts.length) void vscode.window.showWarningMessage(`Conflicts in ${plural(result.conflicts.length, 'file')}. Resolve them in the lane.`);
          else void info(result.upToDate ? `Lane ${lane.name} is already up to date with ${lane.target}.` : `Updated lane ${lane.name} from ${lane.target}.`);
        }
        return result;
      }
      case 'pr': {
        if (interactive) {
          const pick = await vscode.window.showInformationMessage(`Push ${lane.branch} to origin?`, { modal: true, detail: 'For a GitHub repository, Hydra then opens the page to create the pull request.' }, 'Push');
          if (pick !== 'Push') return undefined;
        }
        const pushed = await service.push(lane.id);
        if (interactive) {
          if (pushed.compareUrl) await vscode.env.openExternal(vscode.Uri.parse(pushed.compareUrl, true));
          else void info(`Pushed ${pushed.branch}.`);
        }
        return pushed;
      }
      case 'close': {
        const kind = await service.closeKind(lane.id);
        // Plan lanes (docs/Plan_Lanes_Plan.md, "Before you close"): closing before the job is done fails it.
        const planJob = this.planJobOf(lane.id);
        const planWarning = planJob?.state === 'active' && lane.state !== 'merged'
          ? `This lane runs job ${planJob.jobTitle} of plan ${planJob.planTitle}. Closing it without marking the job done fails the job${planJob.dependents ? `, and ${plural(planJob.dependents, 'job')} that depend on it won't start` : ''}.\n\n` : '';
        let mode: CloseMode;
        if (!interactive) {
          if (options.close) mode = options.close;
          else if (kind === 'merged') mode = 'merged';
          else throw new Error(`Lane ${lane.name} isn't merged: pass close "keep" or "delete".`);
        } else if (kind === 'merged') {
          const pick = await vscode.window.showInformationMessage(`Close lane ${lane.name}?`, { modal: true, detail: `${planWarning}Its terminal session ends, and its worktree and branch ${lane.branch} are removed. Its work is already in ${lane.target}.` }, 'Close lane');
          if (pick !== 'Close lane') return undefined;
          mode = 'merged';
        } else {
          const pick = await vscode.window.showWarningMessage(`Close lane ${lane.name}? Its work isn't merged.`, { modal: true, detail: `${planWarning}Keep branch: commits any changes as "WIP: ${lane.name}", removes the worktree and keeps ${lane.branch}.\nDelete everything: removes the worktree and the branch, with all their changes.` }, 'Keep branch', 'Delete everything');
          if (!pick) return undefined;
          mode = pick === 'Keep branch' ? 'keep' : 'delete';
        }
        await service.close(lane.id, mode);
        this.cancelSwitch(lane.id); this.clearOffer(lane.id);
        if (mode === 'keep') void info(`Closed lane ${lane.name}. Its branch ${lane.branch} is kept.`);
        return { closed: true, mode };
      }
      case 'diff': return this.openDiff(lane);
      case 'openWindow': await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(lane.worktree), { forceNewWindow: true }); return undefined;
      case 'runGates': {
        const outcome = await this.runGatesFlow(service, lane, interactive);
        if (outcome && interactive) {
          if (outcome.failed.length) void vscode.window.showWarningMessage(`Gates failed for lane ${lane.name}.`, { modal: true, detail: summarizeGateFailures(outcome.results) }, 'View evidence')
            .then(pick => { if (pick === 'View evidence') void this.run(service, service.get(lane.id) ?? lane, 'evidence', true, {}); });
          else void info(`Gates passed for lane ${lane.name}.`);
        }
        return outcome;
      }
      case 'evidence': {
        if (!service.get(lane.id)?.lastGates?.results.length) { void info(`Lane ${lane.name} has no gate results yet.`); return undefined; }
        await vscode.commands.executeCommand('hydra.openEvidence', 'lane', lane.id);
        return undefined;
      }
      // ---- Step E: a preview for each lane ----
      case 'preview': return this.previewLane(service, lane, interactive);
      case 'stopPreview': await service.stopPreview(lane.id); this.postState(true); return { stopped: true };
      // ---- Plan lanes (docs/Plan_Lanes_Plan.md, "What done means for a lane job" and "Failures") ----
      case 'markJobDone': return this.markJobDone(service, lane, interactive, options);
      case 'cancelJob': {
        const job = this.planJobOf(lane.id);
        if (!job) throw new Error(`Lane ${lane.name} doesn't run a plan job.`);
        if (interactive) {
          const waiting = job.dependents ? ` ${plural(job.dependents, 'job')} that depend on it won't start.` : '';
          const pick = await vscode.window.showWarningMessage(`Cancel job ${job.jobTitle} of plan ${job.planTitle}?`, { modal: true, detail: `The lane stays open, as an ordinary lane.${waiting}` }, 'Cancel job');
          if (pick !== 'Cancel job') return undefined;
        }
        if (!this.host.cancelPlanJob) throw new Error('Plans aren\'t ready in this window yet.');
        await this.host.cancelPlanJob(lane.id);
        this.postState(true);
        return { cancelled: true };
      }
      case 'showPlan': {
        const job = this.planJobOf(lane.id);
        if (!job) throw new Error(`Lane ${lane.name} doesn't run a plan job.`);
        await this.show('canvas', job.planId);
        return undefined;
      }
    }
  }

  /**
   * Mark job done (docs/Plan_Lanes_Plan.md, "What done means for a lane job"): refuse a lane with uncommitted
   * work (offering Commit…) or nothing to hand on; run the gates as Merge does; ask for a note for the next
   * jobs (the commit subjects by default; Esc cancels); then record the lane's HEAD. The lane stays open.
   * Pressing it again moves the result forward while no job after it has started (decision 3).
   */
  private async markJobDone(service: LaneService, lane: Lane, interactive: boolean, options: LaneActionOptions): Promise<unknown> {
    const job = this.planJobOf(lane.id);
    if (!job) throw new Error(`Lane ${lane.name} doesn't run a plan job.`);
    if (job.state === 'failed' || job.state === 'cancelled' || job.state === 'skipped') throw new Error(`Job ${job.jobTitle} has ended; it can't be marked done.`);
    if (lane.state === 'merged') throw new Error(`Lane ${lane.name} is merged, so its job is done with what was merged.`);
    if (job.dependentsStarted) throw new Error(`The jobs after ${job.jobTitle} have already started from ${job.commit ? job.commit.slice(0, 7) : 'its result'}, so its result can't move.`);
    if (options.message !== undefined && options.message.length > 2000) throw new Error('The note must be at most 2000 characters.');
    if (!this.host.markJobDone) throw new Error('Plans aren\'t ready in this window yet.');
    const work = await service.handOn(lane.id);
    if (!work.ok) {
      if (!interactive) throw new Error(work.message);
      if (work.reason === 'nothing') { void vscode.window.showInformationMessage(work.message); return undefined; }
      const pick = await vscode.window.showWarningMessage(work.message, { modal: true }, 'Commit…');
      if (pick !== 'Commit…') return undefined;
      const committed = await this.run(service, lane, 'commit', true, {}) as { commit?: string } | undefined;
      return committed?.commit ? this.markJobDone(service, service.get(lane.id) ?? lane, true, options) : undefined;
    }
    if (!await this.gitMetaBefore(lane, interactive, 'Mark done with these changes', 'Marking the job done runs git in this lane\'s worktree, which would run them.')) return undefined;
    const gated = await this.gatesBefore(service, lane, interactive, 'Mark the job done anyway?', 'Mark done anyway');
    if (!gated) return undefined;
    let note = options.message;
    if (interactive) {
      note = await vscode.window.showInputBox({
        title: `Mark job ${job.jobTitle} done`, prompt: 'What should the next jobs know? (optional)', value: options.message ?? work.subjects.join('; ').slice(0, 2000), ignoreFocusOut: true,
        validateInput: value => value.length <= 2000 && !value.includes('\0') ? undefined : 'Keep the note under 2000 characters.',
      });
      if (note === undefined) return undefined; // Esc cancels
    }
    const current = service.get(lane.id);
    const status = current?.lastGates?.commit === work.commit ? current.lastGates.status : undefined;
    await this.host.markJobDone(lane.id, { commit: work.commit, ...(note?.trim() ? { note: note.trim() } : {}), changedFiles: work.changedFiles, ...(status ? { status } : {}) });
    this.postState(true);
    if (interactive) void vscode.window.showInformationMessage(`Job ${job.jobTitle} is done at ${work.commit.slice(0, 7)}.${gated.note} The jobs after it can start.`);
    return { commit: work.commit };
  }

  /**
   * 1.4: the git metadata check before Merge or Mark job done. `true`
   * means carry on (no snapshot to compare against, the fingerprint couldn't be taken again, or
   * nothing changed, or the user chose to go ahead anyway); `false` means stop. Non-interactive
   * (`hydra.lanes.action`) refuses outright, naming the files, rather than asking.
   */
  private async gitMetaBefore(lane: Lane, interactive: boolean, anyway: string, reason: string): Promise<boolean> {
    if (!lane.gitMeta) return true;
    const now = await gitMetaFingerprint(lane.worktree).catch(() => undefined);
    if (!now) return true;
    const changed = gitMetaChanges(lane.gitMeta, now);
    if (!changed.length) return true;
    const message = `Your repository's git configuration or hooks changed since this lane started (${changed.join(', ')}). ${reason}`;
    if (!interactive) throw new Error(message);
    const pick = await vscode.window.showWarningMessage(message, { modal: true }, anyway);
    // 5.2: an approval — "Merge with these changes" / "Mark done with these changes".
    if (pick === anyway) this.host.audit?.(laneOverrideEvent(anyway, lane.id, changed.join(', ')));
    return pick === anyway;
  }

  /**
   * The gates before Merge or Mark job done (docs/Gates_Plan.md, "Merge"; docs/Plan_Lanes_Plan.md, section 3), when
   * gates.json says lanes "onMerge" and there are gates. A passing run on the lane's current commit is reused
   * instead of run again. If they fail: Send to lane (the default, so a quick Enter never hands on failing
   * work), `anyway`, or Cancel. Undefined means stop; `note` is what the confirmation adds.
   */
  private async gatesBefore(service: LaneService, lane: Lane, interactive: boolean, question: string, anyway: string): Promise<{ note: string } | undefined> {
    // Step A: with no gates for lanes, handOnGates records which kind of "no gates" this is for the commit.
    const gates = await service.handOnGates(lane.id);
    if (gates.kind === 'none') return { note: '' };
    const reused = gates.kind === 'reused' ? gates.record : undefined;
    if (reused?.commit) return { note: gatesPassNote(reused.results, ` on ${reused.commit.slice(0, 7)} at ${new Date(reused.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`) };
    const outcome = await this.runGatesFlow(service, lane, interactive);
    if (!outcome) return undefined; // cancelled, or gates couldn't run and this was interactive
    if (!outcome.failed.length) return { note: gatesPassNote(outcome.results) };
    if (!interactive) throw new Error(`Gates failed for lane ${lane.name}:\n${summarizeGateFailures(outcome.results)}`);
    const choice = await vscode.window.showWarningMessage(`Gates failed for lane ${lane.name}. ${question}`, { modal: true, detail: summarizeGateFailures(outcome.results) }, 'Send to lane', anyway);
    if (choice === 'Send to lane') { this.sendGatesToLane(service, lane, outcome.results); return undefined; }
    // 5.2: an approval — "Merge anyway" / "Mark done anyway" after a failed gate.
    if (choice === anyway) {
      this.host.audit?.(laneOverrideEvent(anyway, lane.id, summarizeGateFailures(outcome.results)));
      // Step A: record the override so the tile, the plan view and
      // the PR body all say "Human override" for this commit, instead of the plain failed run.
      const commit = await git(lane.worktree, ['rev-parse', 'HEAD']).then(text => text.trim()).catch(() => undefined);
      if (commit) await service.recordGatesOverride(lane.id, commit).catch(() => undefined);
    }
    return choice === anyway ? { note: '' } : undefined; // Cancel
  }

  /**
   * Run this project's gates on the lane, relaying progress to its tile header
   * ("Gates: unit ✓ · review …"). The lane need not be committed: gates read the
   * worktree as it is, so uncommitted work is included, but a dirty lane still
   * gets a heads-up, since a lead's gates always run on a commit.
   */
  private async runGatesFlow(service: LaneService, lane: Lane, interactive: boolean): Promise<GatesOutcome | undefined> {
    if (interactive && this.viewOf(lane.id)?.sync?.dirty) void vscode.window.showInformationMessage(`Lane ${lane.name} has uncommitted changes; the gates run against them too.`);
    try {
      return await service.runGates(lane.id, progress => this.host.post({ type: 'laneGates', id: lane.id, done: progress.done, ...(progress.running ? { running: progress.running } : {}) }));
    } catch (error) {
      this.host.post({ type: 'laneGates', id: lane.id, done: [] });
      if (!interactive) throw error;
      void vscode.window.showErrorMessage(`Hydra: ${describe(error)}`);
      return undefined;
    }
  }
  /** "Send to lane" (docs/Gates_Plan.md, "Merge"): the failures as one line in the lane's terminal input, never pressing Enter. */
  private sendGatesToLane(service: LaneService, lane: Lane, results: readonly JobCheckResult[]): void {
    const text = flattenGateFailureMessage(results);
    // 1.3: this text includes gate output, which the checked agent
    // (or a command it ran) produced, so it goes through typeText rather than input.
    if (service.typeText(lane.id, text)) {
      void this.show('lanes', lane.id);
      void vscode.window.showInformationMessage(`The gate failures are typed into lane ${lane.name}. Press Enter there to send them.`);
      return;
    }
    // Its session has ended: nothing to type into. Keep the text for when it's resumed.
    void vscode.env.clipboard.writeText(terminalText(text));
    void vscode.window.showInformationMessage(`Lane ${lane.name} isn't running, so the gate failures are on the clipboard. Resume it and paste them.`, 'Resume')
      .then(async pick => { if (pick) { await service.resume(lane.id); await this.show('lanes', lane.id); } });
  }

  /** The multi-file diff of the lane against where it meets its target, uncommitted work included. */
  private async openDiff(lane: Lane): Promise<unknown> {
    const { base, files } = await laneDiffFiles(lane);
    if (!files.length) { void vscode.window.showInformationMessage(`Lane ${lane.name} has no changes yet.`); return { files: 0 }; }
    const baseUri = (commit: string, file: string) => vscode.Uri.from({ scheme: baseScheme, path: `/${file}`, query: `${lane.id}.${commit}` });
    const resources = files.map(file => {
      const onDisk = vscode.Uri.file(path.join(lane.worktree, ...file.path.split('/')));
      return [onDisk, file.status === 'A' ? baseUri('empty', file.path) : baseUri(base, file.path), file.status === 'D' ? baseUri('empty', file.path) : onDisk];
    });
    await vscode.commands.executeCommand('vscode.changes', `Lane ${lane.name} (${lane.branch})`, resources);
    return { files: files.length };
  }

  /**
   * Preview app (Step E): the project's screenshots gate wins;
   * else `.hydra/preview.json`; else ask once and save it. Then start the server in the lane's
   * worktree and open the page in Simple Browser. Reusing an already-running preview just reopens it.
   */
  private async previewLane(service: LaneService, lane: Lane, interactive: boolean): Promise<unknown> {
    let config: PreviewConfig | undefined;
    try { config = await service.previewConfig(lane.id); }
    catch (error) { if (!interactive) throw error; void vscode.window.showErrorMessage(`Hydra: ${describe(error)}`); return undefined; }
    if (!config) {
      if (!interactive) throw new Error(`Lane ${lane.name} has no preview command yet; set .hydra/preview.json or a screenshots gate.`);
      config = await this.askPreviewConfig(lane);
      if (!config) return undefined;
    }
    const already = service.previewOf(lane.id);
    try {
      const entry = already ?? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Starting the preview for lane ${lane.name}…` }, () => service.startPreview(lane.id, config!));
      await this.openPreview(entry.url);
      return entry;
    } catch (error) {
      if (!interactive) throw error;
      void vscode.window.showErrorMessage(`Hydra: the preview didn't start. ${describe(error)}`);
      return undefined;
    }
  }

  /** Asked once, per project, when there's neither a screenshots gate nor `.hydra/preview.json` yet. */
  private async askPreviewConfig(lane: Lane): Promise<PreviewConfig | undefined> {
    const command = await vscode.window.showInputBox({
      title: 'Preview command', prompt: 'The command that starts the dev server; use {port} for the port Hydra picks',
      placeHolder: 'npm run dev -- --port {port}', ignoreFocusOut: true,
      validateInput: value => splitPreviewCommand(value).length ? undefined : 'Enter a command.',
    });
    if (command === undefined) return undefined;
    const url = await vscode.window.showInputBox({
      title: 'Preview URL', prompt: 'Where the app answers once it is ready', value: 'http://127.0.0.1:{port}/', ignoreFocusOut: true,
      validateInput: value => { try { parsePreviewConfig({ command: ['x'], url: value }); return undefined; } catch (error) { return describe(error); } },
    });
    if (url === undefined) return undefined;
    const config: PreviewConfig = { command: splitPreviewCommand(command), url };
    await savePreviewConfig(lane.repository, config);
    return config;
  }

  /** VS Code's built-in Simple Browser (decision 4): untrusted content, no Hydra access. */
  private async openPreview(url: string): Promise<void> {
    // simpleBrowser.api.open is Simple Browser's own API command and its activation event, so it works
    // before the extension has loaded (getCommands() doesn't list an unactivated extension's commands).
    try {
      await vscode.commands.executeCommand('simpleBrowser.api.open', vscode.Uri.parse(url, true), { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
      return;
    } catch { /* not in this build: offer the browser below, never open one unasked */ }
    const pick = await vscode.window.showInformationMessage(`Hydra: the preview is running at ${url}, but Simple Browser isn't available in this build.`, 'Open in browser');
    if (pick === 'Open in browser') await vscode.env.openExternal(vscode.Uri.parse(url, true));
  }

  /** A file's content at the lane's base commit, for the diff's left side. Only an open lane's files, at a full commit id. */
  private async baseContent(uri: vscode.Uri): Promise<string> {
    const [id, commit] = uri.query.split('.');
    const lane = id && isLaneId(id) ? this.service?.get(id) : undefined;
    if (!lane || commit === 'empty') return '';
    const file = uri.path.replace(/^\/+/, '');
    if (!commit || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit) || !file || file.includes('\0') || file.split('/').some(part => part === '..' || part === '')) return '';
    try { return await git(lane.worktree, ['cat-file', 'blob', `${commit}:${file}`]); } catch { return ''; }
  }

  private requireService(): LaneService {
    if (!this.service) throw new Error('Lanes need a trusted Git folder open in this window.');
    return this.service;
  }

  /** Window closing: stop every lane's terminal. */
  async stop(): Promise<void> { await this.service?.dispose(); }
  dispose(): void {
    for (const timer of this.switchTimers.values()) clearTimeout(timer);
    this.switchTimers.clear();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}
