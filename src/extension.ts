import * as vscode from 'vscode';
import { machineSetting } from './core/machineSetting';
import { notices } from './notices';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat as fsStat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OwnershipLock } from './core/ownership';
import { git, repositoryRoot } from './core/worktrees';
import { AppearanceSettings } from './extensionSettings';
import { SettingsImport } from './extensionImport';
import { Onboarding } from './extensionOnboarding';
import { ProviderAccounts } from './extensionAccounts';
import { ProviderQuota } from './extensionQuota';
import { findProvider } from './core/providers';
import { JobStore, evidenceLabel, finalJobStates, resolveHeadDefaults, type EvidenceStatus } from './core/jobs';
import { HelperEndpoint } from './core/helperEndpoint';
import { HelperService, userPlanSession } from './core/helperService';
import { removeUserHandshake, sweepStaleHandshakes, writeUserHandshake } from './core/userHandshake';
import { alive as isWindowAlive, discoveryDirectory, removeWindowRecord, writeWindowRecord } from './core/helperDiscovery';
// ---- Step D: a read-only view across projects ----
import { buildProjectSummary, readProjectSummaries, startProjectSummaryPublisher, type ProjectSummaryPublisher } from './core/projectSummary';
import { startHelperRun } from './core/helperRunner';
import { HeadSandbox } from './core/headSandbox';
import { headShellSentence } from './core/confine';
import { createLeadVerifier, createUserVerifier } from './core/leadVerification';
import { claudeMemRowText, claudeMemStatus, setupClaudeMem, shouldSetUpClaudeMem } from './core/claudeMem';
import { installWithFallback } from './core/openVsx';
import { firstRunConnectKey, firstRunProviders, shouldConnectOnFirstRun } from './core/onboarding';
import { claudeStatus, codexStatus, connectClaude, connectCodex, disconnectClaude, disconnectCodex, helperWrittenEntries, providerPaths, read, runClaude, setClaudeLimitHook, type ConnectableProvider, type HelperServerSpec, type WrittenEntries } from './core/helperRegistration';
import { claudeSupportsLimitHook, limitHookGroup, limitHookState, type LimitHookGroup } from './core/claudeLimitHook';
import type { LimitEvent } from './core/limitEvents';
import { ClaudeChatLimits, CodexChatLimits } from './extensionLimits';
import type { ProviderConnectionView } from './helperConnectionsView';
import { addMcpServer, configuredSpec, defaultMcpContext, enableMcpServerFor, listMcpServers, maskSecret, removeMcpServer, testMcpServer, validateServerSpec, type McpAgent } from './core/mcpServers';
import { createRedactor, redactText } from './core/redact';
import { checkProvider } from './core/diagnostics';
import { settingsRequiringRefresh } from './core/settingsRefresh';
import { parseHandoff, officialProviders } from './core/handoff';
import { officialExtensionInfo, openOfficialExtension } from './extensionBridge';
import { claudeForRegistration } from './claudeExecutable';
import { registerChatLocationController, setChatLocation } from './chatLocationController';
import { registerLimitOffer } from './extensionLimitOffer';
import { codexLaneFanout } from './core/limitEvents';
import { LimitOfferTracker } from './core/limitOffer';
import { LanesController } from './extensionLanes';
import { HydraTreeProvider } from './extensionTree';
// ---- Packs (docs/internal/Packs_Plan.md). Its own block. ----
import { createPackService } from './extensionPacks';
import type { PackService } from './core/packs/service';
import { type ClientMessage, type HelperJobView, type Provider, type ProviderDiagnostic, type Snapshot, type Handoff, type HandoffTask } from './core/model';
// ---- Planner (docs/internal/Lanes_And_Planner_Plan.md, section 4). Its own block; Phase 1 (Lanes) wires its own imports separately. ----
import { PlanStore, type Plan, type PlanDispatch } from './core/plans';
// ---- Plan lanes (docs/internal/Plan_Lanes_Plan.md). Their own block. ----
import { planIdPattern, planJobKeyPattern } from './core/plans';
import { PlanRunner, type PlanJobStatus, type PlanJobView } from './core/planRunner';
// ---- O1: plans from the chat (docs/Heads.md, "Plans from the chat"). Their own block. ----
import { appendBoardPost, applyPlanAmendment, boardForJob, boardForLead, findPlanByIdempotencyKey, planFromLeadInput, type BoardFrom } from './core/plans';
import type { PlanBoardBridge, PlanLeadAmendInput, PlanLeadBridge, PlanLeadCreateInput, PlanLeadMessageInput, PlanLeadPlan } from './core/helperService';
// ---- O3: the integration branch and the integration gate (docs/Heads.md, "Landing a plan together"). Their own block. ----
import { integrationLeadView, isIntegrationFixKey, integrationSettled } from './core/integration';
import type { PlanMergeVia } from './core/planRunner';
// ---- Gates (docs/internal/Gates_Plan.md). Their own block. ----
import { otherStillLimited } from './core/limitOffer';
import { buildEvidenceMarkdown } from './core/evidence';
import { loadGates } from './core/gates';
import { detectTestScript, noGatesFile, starterTestGatesFile } from './core/starterGates';
// ---- Stop all (5.3). Its own line. ----
import { StopSwitch } from './core/stopSwitch';
// ---- Audit log (5.2). Its own line. ----
import { AuditLog, type AuditEvent } from './core/audit';
import { describeActivity, scheduleClose, windowActivity, type WindowActivity } from './core/windowClose';
// ---- Updates (docs/Releases.md, "Updating"). Its own line. ----
import { registerUpdates } from './extensionUpdates';
// ---- The host boundary (docs/internal/hydra-app/G2-host-split.md). Its own line. ----
import { VsCodeHost } from './vscodeHost';
import { HydraController } from './host/controller';

let manager: Manager | undefined;
// ---- Plan lanes (docs/internal/Plan_Lanes_Plan.md): arguments of the hydra.plans.* test commands ----
const planIdArgument = (value: unknown): string => { if (typeof value !== 'string' || !planIdPattern.test(value)) throw new Error('Pass a plan id.'); return value; };
const jobKeyArgument = (value: unknown): string => { if (typeof value !== 'string' || !planJobKeyPattern.test(value)) throw new Error('Pass a job key.'); return value; };
/** Every contributed Hydra setting except the preference-only ones (see settingsRefresh). */
function otherHydraSettings(context: vscode.ExtensionContext): string[] {
  return settingsRequiringRefresh([context.extension.packageJSON?.contributes?.configuration].flat().flatMap((section: { properties?: Record<string, unknown> } | undefined) => Object.keys(section?.properties || {})));
}
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  registerChatLocationController(context);
  manager = new Manager(context);
  await manager.initialize();
  await manager.showFirstRun();
}
export async function deactivate(): Promise<void> { await manager?.shutdown(); }

/**
 * 5.1: every line the Hydra output channel shows goes through the
 * one redactor first. Hydra's own endpoint tokens are kept only as a SHA-256 digest
 * (helperEndpoint.ts), never in the clear, and Hydra never logs one to this channel either
 * (grep for "never a token" in extension.ts); what this catches is a secret a head's tool
 * output, a gate command or an MCP server happened to print. A Proxy forwards everything else
 * (dispose, show, clear, …) to the real channel unchanged.
 */
function redactedChannel(channel: vscode.OutputChannel, redact: (text: string) => string): vscode.OutputChannel {
  return new Proxy(channel, {
    get(target, prop) {
      if (prop === 'appendLine') return (value: string) => target.appendLine(redact(value));
      if (prop === 'append') return (value: string) => target.append(redact(value));
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

class Manager {
  private repositories: string[] = [];
  private panel?: vscode.WebviewPanel;
  private mode: 'editor' | 'agents' = 'editor';
  private busy = false;
  private error?: string;
  private disabled = false;
  private closing = false;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  // ---- Stop all (5.3): the workspace-wide switch, and its status bar item ----
  private readonly stop: StopSwitch;
  private readonly stopStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  // ---- Audit log (5.2): one per window, denials/approvals/stops ----
  private readonly audit: AuditLog;
  private readonly output = redactedChannel(vscode.window.createOutputChannel('Hydra'), createRedactor(() => []));
  /** What the controller needs from VS Code (docs/internal/hydra-app/G2-host-split.md). */
  private readonly host: VsCodeHost;
  private readonly locks: OwnershipLock[] = [];
  private readonly storageDirectory: string;
  /** The Agents view, plans and the plan runner (docs/internal/hydra-app/G2-host-split.md); this class forwards to it. */
  private readonly controller: HydraController;
  // Helpers, plans, the plan runner and the active roles live in the controller.
  private get helpers() { return this.controller.helpers; }
  private set helpers(value) { this.controller.helpers = value; }
  private get plans() { return this.controller.plans; }
  private set plans(value) { this.controller.plans = value; }
  private get planRunner() { return this.controller.planRunner; }
  private set planRunner(value) { this.controller.planRunner = value; }
  private get roles() { return this.controller.roles; }
  private set roles(value) { this.controller.roles = value; }
  private get planWaiters() { return this.controller.planWaiters; }
  private readonly leadKey: string;
  private handoff?: Handoff;
  private readonly diagnostics = new Map<Provider, ProviderDiagnostic>();
  private readonly diagnosticChecks = new Set<AbortController>();
  private diagnosticGeneration = 0;
  private readonly settings: AppearanceSettings;
  private readonly settingsImport: SettingsImport;
  private readonly onboarding: Onboarding;
  private readonly accounts: ProviderAccounts;
  private readonly quota: ProviderQuota;
  /**
   * Every usage limit Hydra notices (docs/internal/Hydra_Agent_Plan.md, Phase 1): Claude chats
   * (StopFailure hook), Codex chats (rate-limit polling) and heads. The handoff UI
   * subscribes with `limitEvents.event(listener)`.
   */
  readonly limitEvents = new vscode.EventEmitter<LimitEvent>();
  /** Shared by the chat/head notification and every lane's tile banner, so "the other provider is limited too" sees all three (docs/internal/Gates_Plan.md, section 2). */
  private readonly limitOfferTracker = new LimitOfferTracker();
  // ---- Lanes (docs/internal/Lanes_And_Planner_Plan.md): state; the methods are in the Lanes block below ----
  private readonly lanes: LanesController;
  /** The Hydra activity-bar panel (section 3): one TreeView over lanes, heads and plans. */
  private readonly tree = new HydraTreeProvider();
  /** The Agents panel whose webview has sent "ready". */
  private readyPanel?: vscode.WebviewPanel;
  /** The window's discovery record lists its folders plus open lanes' worktrees. */
  private discovery?: { port: number; folders: string[]; written: string; queue: Promise<void> };
  /** Step D: this window's small summary, published beside its discovery record for "Hydra: Show All Projects". */
  private projectSummary?: ProjectSummaryPublisher;
  // ---- Gates (docs/internal/Gates_Plan.md): each provider's latest usage limit, so a review gate uses the other agent while one is limited ----
  private readonly latestLimits = new Map<Provider, LimitEvent>();
  // ---- Packs (docs/internal/Packs_Plan.md): gates.json plus the active packs' gates, for heads and lanes ----
  private readonly packs: PackService;
  /** Step 2: Codex's sandbox for heads' shells and gate commands, checked once per window when first needed. */
  private readonly headSandbox: HeadSandbox;
  /** Set once startHelpers finds it; the folder `hydra.packs.*` commands and the roles refresh use by default. */
  private packsLeadFolder?: string;
  /** Watches your packs folder (hydra.packs.folder), so a pack added or edited there refreshes without Reload. */
  private packsFolderWatcher?: vscode.FileSystemWatcher;
  constructor(private readonly context: vscode.ExtensionContext) {
    this.host = new VsCodeHost(context, this.output, message => this.panel?.webview.postMessage(message), () => this.toEditor());
    // Stop all (5.3): a workspace-wide switch, so it survives a reload until Resume Agents runs.
    this.stop = new StopSwitch(context.workspaceState);
    // Audit log (5.2): one file per window, under Hydra's own storage, never a worktree.
    this.audit = new AuditLog({ file: path.join(context.globalStorageUri.fsPath, 'audit', 'audit.jsonl') });
    this.settingsImport = new SettingsImport(context);
    this.accounts = new ProviderAccounts(context, this.settingsImport.available);
    this.quota = new ProviderQuota(context, this.settingsImport.available);
    this.packs = createPackService(context, line => this.output.appendLine(line), event => this.audit.record(event));
    this.settings = new AppearanceSettings(context, this.settingsImport, this.packs);
    this.onboarding = new Onboarding(context, this.settingsImport, this.settings, () => void this.openAgents().catch(error => this.report(error)));
    context.subscriptions.push(this.settings, this.onboarding, this.accounts, this.quota, this.limitEvents, this.tree);
    const identity = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.toString()).sort().join('|') || 'empty';
    const key = createHash('sha256').update(identity).digest('hex').slice(0, 16);
    this.storageDirectory = path.join(context.globalStorageUri.fsPath, 'workspaces', key);
    this.leadKey = key;
    // Its scripts live in Hydra's own storage, never in a worktree; Codex is the one Hydra would run (hydra.codexPath, else PATH).
    this.headSandbox = new HeadSandbox({
      // Short paths (Windows' 260-character limit): the sandbox's scripts and check folders, per window.
      folder: path.join(this.context.globalStorageUri.fsPath, 'sb', path.basename(this.storageDirectory)),
      codex: async () => (await findProvider('codex', machineSetting<string>(vscode.workspace.getConfiguration('hydra'), 'codexPath') || undefined)).executable,
      log: line => this.output.appendLine(line),
      audit: event => this.audit.record(event),
    });
    this.lanes = new LanesController({
      context, log: line => this.output.appendLine(line),
      post: message => { void this.panel?.webview.postMessage(message); },
      openAgents: () => this.openAgents(), toEditor: () => this.toEditor(), webviewReady: () => !!this.panel && this.readyPanel === this.panel,
      helperServerSpec: provider => this.helperServerSpec(provider), runningHeads: id => this.laneHeads(id),
      changed: () => this.laneFoldersChanged(),
      gatesExecutable: provider => this.helperExecutable(provider),
      gatesLimited: provider => otherStillLimited(this.latestLimits.get(provider), new Date()),
      // ---- Plan lanes (docs/internal/Plan_Lanes_Plan.md) ----
      planJob: laneId => this.controller.planJobOfLane(laneId),
      markJobDone: (laneId, result) => this.controller.markPlanJobDone(laneId, result),
      cancelPlanJob: laneId => this.controller.cancelPlanJobOfLane(laneId),
      planLaneMergeRefusal: laneId => this.controller.planLaneMergeRefusal(laneId),
      // Step C: Auto-dispatch checks a job through the runner.
      planRunner: () => this.planRunner,
      gates: this.packs.gates, roles: this.packs,
      // ---- Step 2: light limits for Claude lanes ----
      hydraStorage: context.globalStorageUri.fsPath,
      // ---- Stop all (5.3) ----
      stop: this.stop,
      // ---- Audit log (5.2) ----
      audit: event => this.audit.record(event),
      // ---- Step A ----
      offerStarterGates: folder => void this.offerStarterGatesIfNeeded(folder),
    }, this.limitOfferTracker);
    context.subscriptions.push(this.lanes);
    this.controller = new HydraController({
      host: this.host, lanes: this.lanes, stop: this.stop, audit: this.audit,
      ide: {
        view: () => this.view(),
        handle: message => this.handleIde(message),
        uiReady: () => { this.readyPanel = this.panel; },
        agentsOpen: () => !!this.panel,
        showingAgents: () => this.mode === 'agents',
        openAgents: () => this.openAgents(),
        tree: update => this.tree.update(update),
        summaryChanged: () => this.projectSummary?.changed(),
        offerStarterGates: folder => void this.offerStarterGatesIfNeeded(folder),
        report: error => this.report(error),
      },
    });
  }
  async initialize(): Promise<void> {
    const command = (name: string, callback: (...args: any[]) => unknown) => this.context.subscriptions.push(vscode.commands.registerCommand(name, (...args) =>
      Promise.resolve().then(() => callback(...args)).catch(error => { this.report(error); throw error; })));
    command('hydra.toggleMode', () => this.mode === 'editor' ? this.openAgents() : this.openEditor());
    command('hydra.openAgents', () => this.openAgents());
    command('hydra.openEditor', () => this.openEditor());
    // Not contributed: desktop builds made before the walkthrough change still link "New Task"
    // here, so it opens the Agents view.
    command('hydra.newTask', () => this.openAgents());
    command('hydra.openSettings', (pageId?: string) => this.settings.show(pageId));
    command('hydra.setChatLocation', (mode?: 'docked' | 'tabs') => setChatLocation(mode));
    command('hydra.getLayoutMode', () => ({ mode: this.mode }));
    command('hydra.openAccounts', (provider?: 'claude' | 'codex', autoLogin?: boolean) => this.accounts.show(provider, autoLogin));
    command('hydra.getAccountSetupState', () => this.accounts.snapshot());
    command('hydra.openQuotaStatus', () => this.quota.show());
    command('hydra.getQuotaState', () => this.quota.snapshot());
    command('hydra.refreshQuota', () => this.quota.refresh());
    command('hydra.cancelQuota', () => this.quota.cancel());
    command('hydra.openOnboarding', () => this.onboarding.show());
    // ---- The walkthrough (docs/internal/Lanes_And_Planner_Plan.md, "A walkthrough") ----
    command('hydra.learn', () => this.openWalkthrough());
    command('hydra.getOnboardingState', () => this.onboarding.snapshot());
    command('hydra.setAppearance', (mode: 'dark' | 'light') => this.settings.setAppearance(mode));
    command('hydra.previewImport', (source: unknown) => { if (typeof source !== 'string') throw new Error('Choose a settings folder.'); return this.settingsImport.preview(source); });
    command('hydra.applyImport', (token: string, categories: any) => this.settingsImport.apply(token, categories));
    command('hydra.undoImport', () => this.settingsImport.undo());
    command('hydra.getImportStatus', () => this.settingsImport.status());
    command('hydra.stopAllHelpers', async () => {
      const stopped = await this.helpers?.service.stopAll() ?? 0;
      void notices.info(stopped ? `Stopped ${stopped} Hydra head${stopped === 1 ? '' : 's'}.` : 'No Hydra heads are running.');
      return stopped;
    });
    command('hydra.listHelpers', () => structuredClone(this.helpers?.service.list() ?? []));
    // ---- Stop all (5.3) ----
    command('hydra.stopAllAgents', async (options?: { confirm?: boolean }) => {
      if (options?.confirm !== false) {
        const pick = await vscode.window.showWarningMessage('Stop every head and lane in this window?', { modal: true }, 'Stop all');
        if (pick !== 'Stop all') return false;
      }
      await this.stopAllAgents('Stopped with "Hydra: Stop All Agents".', 'Stop all agents');
      return true;
    });
    command('hydra.resumeAgents', async () => {
      await this.resumeAgents('Resume agents');
      return true;
    });
    // ---- Audit log (5.2) ----
    command('hydra.openAuditLog', () => this.openAuditLog());
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
    const mcp = async () => defaultMcpContext(await claudeForRegistration());
    command('hydra.mcpServers.list', async () => listMcpServers(await mcp()));
    command('hydra.mcpServers.add', async (name: unknown, spec: unknown, agents: unknown) => { const context = await mcp(); await addMcpServer(context, name, spec, agents); return listMcpServers(context); });
    command('hydra.mcpServers.remove', async (name: unknown, agent: unknown) => { const context = await mcp(); await removeMcpServer(context, name, agent); return listMcpServers(context); });
    command('hydra.mcpServers.enable', async (name: unknown, agent: unknown) => { const context = await mcp(); await enableMcpServerFor(context, name, agent); return listMcpServers(context); });
    command('hydra.mcpServers.test', async (target: unknown, agent?: McpAgent) => testMcpServer(typeof target === 'string' ? await configuredSpec(await mcp(), target, agent) : validateServerSpec(target)));
    command('hydra.openOfficialExtension', () => this.handle({ type: 'openOfficial' }));
    command('hydra.getHandoff', () => structuredClone(this.handoff));
    command('hydra.checkProvider', async (provider?: string) => {
      provider ||= vscode.workspace.getConfiguration('hydra').get('defaultProvider', 'claude');
      await this.handle({ type: 'checkProvider', provider });
      return structuredClone(this.diagnostics.get(provider as Provider));
    });
    command('hydra.getProviderDiagnostics', () => structuredClone([...this.diagnostics.values()]));
    this.lanes.registerCommands(command);
    // ---- Gates (docs/internal/Gates_Plan.md): View evidence, a read-only Markdown document built fresh each time it's opened. ----
    command('hydra.openEvidence', (kind: unknown, id: unknown) => {
      if ((kind !== 'head' && kind !== 'lane') || typeof id !== 'string' || !/^[a-f0-9]{12}$/.test(id)) throw new Error('openEvidence takes "head" or "lane" and a 12-hex id.');
      return this.openEvidence(kind, id);
    });
    // ---- The Hydra panel (docs/internal/Lanes_And_Planner_Plan.md, section 3) ----
    this.context.subscriptions.push(vscode.window.createTreeView('hydra.overview', { treeDataProvider: this.tree }));
    // ---- Step D: a read-only view across projects ----
    command('hydra.showAllProjects', () => this.showAllProjects());
    command('hydra.overview.mergeLane', (row: { item?: { id?: string } } = {}) => row.item?.id && this.lanes.action(row.item.id, 'merge', true));
    command('hydra.overview.closeLane', (row: { item?: { id?: string } } = {}) => row.item?.id && this.lanes.action(row.item.id, 'close', true));
    // Not in the palette: fires a made-up limit event, for the handoff UI and smoke tests.
    // A lane id (its own 12-hex id, source becomes "lane") simulates the limit for that lane's tile.
    command('hydra.debug.simulateLimit', (provider: unknown = 'claude', source: unknown = 'chat', laneId?: unknown) => {
      if ((provider !== 'claude' && provider !== 'codex') || (source !== 'chat' && source !== 'head' && source !== 'lane')) throw new Error('simulateLimit takes provider "claude" or "codex" and source "chat", "head" or "lane".');
      if (source === 'lane' && (typeof laneId !== 'string' || !this.lanes.exists(laneId))) throw new Error('simulateLimit with source "lane" needs the id of a lane open in this window.');
      const folder = vscode.workspace.workspaceFolders?.[0];
      const event: LimitEvent = { provider, source, at: new Date().toISOString(), message: 'Simulated usage limit (hydra.debug.simulateLimit).', ...(folder ? { cwd: folder.uri.fsPath } : {}), ...(source === 'lane' ? { laneId: laneId as string } : {}) };
      this.limitEvents.fire(event);
      return event;
    });
    this.context.subscriptions.push(this.limitEvents.event(event => this.output.appendLine(`[limits] ${event.provider} ${event.source}${event.jobId ? ` ${event.jobId}` : ''}${event.sessionId ? ` session ${event.sessionId}` : ''}${event.resetsAt ? `, resets ${event.resetsAt}` : ''}: ${event.message ?? 'usage limit reached'}`)));
    this.context.subscriptions.push(this.status, this.stopStatus, this.output);
    await vscode.commands.executeCommand('setContext', 'hydra.mode', this.mode);
    this.status.command = 'hydra.toggleMode';
    this.status.show();
    // Stop all (5.3): shown now if a previous session left Hydra stopped, and whenever it toggles.
    this.stopStatus.command = 'hydra.resumeAgents';
    this.context.subscriptions.push(this.stop.onChange(() => this.updateStopStatus()));
    this.updateStopStatus();
    this.context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('hydra')) return;
      // Packs: a changed packs folder re-creates the watcher on the new location (or none at all).
      if (event.affectsConfiguration('hydra.packs.folder')) void this.setupPacksFolderWatcher().catch(error => this.report(error));
      // A different Codex: check the head sandbox again when it's next needed.
      if (event.affectsConfiguration('hydra.codexPath')) this.headSandbox.reset();
      // Preference-only settings (the head cap) are read fresh wherever they are
      // used, so they only republish. Any other Hydra setting, including ones
      // added later, clears provider checks and refreshes.
      if (!otherHydraSettings(this.context).some(key => event.affectsConfiguration(key))) { void this.publish().catch(error => this.report(error)); return; }
      this.diagnosticGeneration++; this.diagnostics.clear();
      for (const controller of this.diagnosticChecks) controller.abort();
      void this.refresh().catch(error => this.report(error));
    }));
    try {
      await this.refreshRepositories();
      if (vscode.workspace.isTrusted) {
        // Lock each canonical repository, so different workspace configurations cannot own the same repo.
        for (const repository of [...this.repositories].sort()) {
          const lock = new OwnershipLock();
          await lock.acquire(path.join(this.context.globalStorageUri.fsPath, 'ownership'), repository);
          this.locks.push(lock);
        }
      }
    } catch (error) { this.disabled = true; this.report(error); }
    try {
      this.handoff = parseHandoff(vscode.workspace.getConfiguration('hydra').get('handoff'));
      if (this.handoff) { await this.verifyHandoffWorkspace(); await this.openAgents(); }
    } catch (error) { this.disabled = true; this.report(error); }
    await this.startHelpers().catch(error => { this.output.appendLine(`[heads] not started: ${this.describe(error)}`); });
    this.startLimitDetection();
    // ---- Updates (docs/Releases.md, "Updating"): the daily check and Hydra: Check for Updates ----
    this.context.subscriptions.push(registerUpdates({
      context: this.context,
      log: line => this.output.appendLine(line),
      running: () => ({
        heads: this.helpers?.service.list().filter(job => !finalJobStates.has(job.state)).length ?? 0,
        lanes: this.lanes.state().lanes.filter(lane => lane.running).length,
        stopped: this.stop.isStopped(),
      }),
    }));
    this.context.subscriptions.push(registerLimitOffer({
      limitEvents: this.limitEvents.event,
      storageDir: this.context.globalStorageUri.fsPath,
      offerEnabled: () => vscode.workspace.getConfiguration('hydra').get<boolean>('limits.offerHandoff', true),
      job: jobId => this.helpers?.store.get(jobId),
      otherReady: async provider => (await this.helperConnections()).find(connection => connection.provider === provider)?.connected ?? false,
      continueWith: async (jobId, provider, markdown) => {
        if (!this.helpers) throw new Error('Hydra heads are still starting.');
        await this.helpers.service.continueWith(jobId, provider, markdown);
      },
      // O6: a plan job fails over on its own, unless turned off.
      autoContinuePlan: jobId => vscode.workspace.getConfiguration('hydra').get<boolean>('limits.autoContinuePlans', true) && !!this.jobPlanFor(jobId),
      log: line => this.output.appendLine(line),
      tracker: this.limitOfferTracker,
    }));
    // Lanes (docs/internal/Gates_Plan.md, section 2): a lane's own tile banner, never a notification.
    this.context.subscriptions.push(this.limitEvents.event(event => { void this.lanes.onLimitEvent(event).catch(error => this.output.appendLine(`[lanes] limit offer: ${this.describe(error)}`)); }));
    await this.publish();
  }
  private get limitEventsDirectory(): string { return path.join(this.context.globalStorageUri.fsPath, 'limit-events'); }
  /** Claude's StopFailure hook: this editor's executable as Node, running dist/hydra-limit-hook.cjs into the shared events folder. */
  private limitHook(): LimitHookGroup {
    return limitHookGroup({ executable: process.execPath, script: path.join(this.context.extensionPath, 'dist', 'hydra-limit-hook.cjs'), eventsDir: this.limitEventsDirectory });
  }
  /** The hook, if this Claude runs exec-form hooks (2.1.139+); older ones would run it through a shell. */
  private async limitHookFor(claude: string): Promise<LimitHookGroup | undefined> {
    const version = await runClaude(claude, ['--version']);
    if (version.code === 0 && claudeSupportsLimitHook(version.output)) return this.limitHook();
    this.output.appendLine('[limits] Claude Code is older than 2.1.139; its usage-limit hook is not installed.');
    return undefined;
  }
  /** Chats in the official extensions: Claude's hook events and Codex's polled limits. Heads report through their service. */
  private startLimitDetection(): void {
    if (this.handoff || !vscode.workspace.isTrusted || vscode.env.remoteName) return;
    const fire = (event: LimitEvent) => this.limitEvents.fire(event);
    // Lanes (docs/internal/Gates_Plan.md, section 2): Claude's hook already tags its own lane's
    // events with HYDRA_LANE_ID; its worktree also counts as an owned folder like any
    // workspace folder. Codex has no per-session hook, so its account-limit event is
    // fanned out here to one lane event per running Codex lane.
    const claude = new ClaudeChatLimits(this.limitEventsDirectory, providerPaths().claudeProjects, fire, () => this.lanes.laneWorktreeEntries());
    this.context.subscriptions.push(claude);
    void claude.start().catch(error => this.output.appendLine(`[limits] Claude chat limits not watched: ${this.describe(error)}`));
    const fireCodex = (event: LimitEvent) => {
      fire(event);
      for (const laneEvent of codexLaneFanout(event, this.lanes.runningLanes('codex'))) fire(laneEvent);
    };
    this.context.subscriptions.push(new CodexChatLimits(this.quota, async () =>
      this.settingsImport.available && vscode.workspace.isTrusted && !!vscode.extensions.getExtension('openai.chatgpt') && (await codexStatus(providerPaths().codexConfig, this.helperServerSpec('codex'))).connected,
    fireCodex, line => this.output.appendLine(line)));
  }
  /** How a CLI starts Hydra's stdio bridge: this editor's executable as Node, running dist/hydra-mcp.cjs. */
  helperBridge(provider?: ConnectableProvider): { command: string; args: string[]; env: Record<string, string> } {
    return { command: process.execPath, args: [path.join(this.context.extensionPath, 'dist', 'hydra-mcp.cjs')], env: { ELECTRON_RUN_AS_NODE: '1', HYDRA_HELPERS_DIR: path.join(this.context.globalStorageUri.fsPath, 'helpers'), ...(provider ? { HYDRA_LEAD_PROVIDER: provider } : {}) } };
  }
  private helperExecutable(provider: Provider): Promise<string> { return this.controller.helperExecutable(provider); }
  /** Helpers need a trusted Git folder. The first repository in the window is the lead's folder. */
  private async startHelpers(): Promise<void> {
    if (this.disabled || this.handoff || !vscode.workspace.isTrusted || this.helpers) return;
    const folders = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
    let leadFolder: string | undefined;
    for (const folder of folders) { try { leadFolder = await repositoryRoot(folder); break; } catch { /* not a Git folder */ } }
    if (!leadFolder) return;
    const directory = path.join(this.storageDirectory, 'helpers');
    const store = new JobStore(directory, undefined, undefined, () => {
      const config = vscode.workspace.getConfiguration('hydra');
      return resolveHeadDefaults({
        minutes: config.get<number>('heads.defaultMinutes'),
        maxTurns: config.get<number>('heads.defaultMaxTurns'),
        budgetUsd: config.get<number>('heads.defaultBudgetUsd'),
      });
    });
    await store.load();
    const leadKey = path.basename(this.storageDirectory);
    let service: HelperService | undefined;
    const verifyLead = createLeadVerifier(() => ({
      // This window's extension host and its main process start the official
      // extensions' CLIs and Hydra's terminals; helpers are refused by process.
      allowedAncestors: new Set([process.pid, process.ppid]),
      deniedAncestors: service?.helperProcessIds() ?? new Set<number>(),
    }), undefined, undefined, line => this.output.appendLine(line));
    const verifyUser = createUserVerifier(() => ({ deniedAncestors: service?.helperProcessIds() ?? new Set<number>() }), undefined, undefined, line => this.output.appendLine(line));
    const endpoint = new HelperEndpoint(async (caller, tool, args, signal) => {
      if (!service) throw new Error('Hydra heads are still starting.');
      // Every action is logged, whoever calls it (plan, Phase 3 security note).
      this.output.appendLine(`[heads] ${caller.role}${caller.jobId ? ` ${caller.jobId}` : ''}: ${tool}`);
      return service.handle(caller, tool, args, signal);
    }, { leadKey, laneExists: id => this.lanes.exists(id),
      // Refusals are logged too (docs/THREAT_MODEL.md): who, what and why, never a token.
      onRefuse: event => {
        this.output.appendLine(`[heads] refused ${event.status}: ${event.reason}${event.role ? ` (${event.role}${event.jobId ? ` ${event.jobId}` : ''}${event.tool ? `, ${event.tool}` : ''})` : ''}`);
        // 5.2: a denial — every endpoint refusal.
        this.audit.record({ kind: 'denial', what: `endpoint refused: ${event.status}`, detail: event.reason, role: event.role, jobId: event.jobId });
      },
      // O8a: a user token (from the handshake file) is refused from inside a head, like a lead.
      verifyUser: async socket => {
        const verdict = await verifyUser(socket);
        if (!verdict.ok) this.output.appendLine(`[heads] user connection refused: ${verdict.reason}`);
        return verdict;
      },
      verifyLead: async socket => {
      const verdict = await verifyLead(socket);
      this.output.appendLine(`[heads] lead connection ${verdict.ok ? 'accepted' : `refused: ${verdict.reason}`}`);
      // 5.2: a denial — a refused lead connection.
      if (!verdict.ok) this.audit.record({ kind: 'denial', what: 'lead connection refused', detail: verdict.reason });
      return verdict;
    } });
    const port = await endpoint.start();
    service = new HelperService({
      store, endpoint, leadFolder, leadKey,
      worktreeRoot: () => machineSetting<string>(vscode.workspace.getConfiguration('hydra'), 'worktreeRoot') || undefined,
      startRun: startHelperRun, executable: provider => this.helperExecutable(provider),
      bridge: this.helperBridge(), logDirectory: path.join(directory, 'logs'),
      maxConcurrent: () => Math.max(1, Math.min(8, vscode.workspace.getConfiguration('hydra').get<number>('maxConcurrentHelpers', 3))),
      onChange: () => this.headsChanged(), log: line => this.output.appendLine(line),
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
      sandbox: this.headSandbox, hydraStorage: this.context.globalStorageUri.fsPath,
      // Heads' own TEMP folders: short, since Windows refuses paths past 260 characters.
      tempDirectory: path.join(this.context.globalStorageUri.fsPath, 't'),
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
      enforceUnattendedBudgets: () => this.controller.enforceUnattendedBudgets(),
    });
    this.context.subscriptions.push(service.onLimit(event => this.limitEvents.fire(event)));
    this.context.subscriptions.push(this.limitEvents.event(event => { this.latestLimits.set(event.provider, event); }));
    // Plans need the same trusted repository as heads (they read it, and running one starts heads in it). Loaded
    // before recover() (O3): a plan's head that was waiting for an answer goes back in the queue, not failed.
    const planStore = new PlanStore(path.join(this.storageDirectory, 'plans'));
    await planStore.load();
    this.plans = { store: planStore, planning: new Map() };
    await service.recover();
    await this.lanes.start(leadFolder, this.storageDirectory).catch(error => this.output.appendLine(`[lanes] not started: ${this.describe(error)}`));
    const record = await writeWindowRecord(path.join(this.context.globalStorageUri.fsPath, 'helpers'), { port, pid: process.pid, folders: [...folders, ...this.lanes.openWorktrees()] });
    this.discovery = { port, folders, written: JSON.stringify(this.lanes.openWorktrees()), queue: Promise.resolve() };
    this.helpers = { store, endpoint, service, record };
    // ---- O8a: the user role's handshake (docs/Heads.md, "Scripts and CI") ----
    // Hydra mints the user token here, once per window, and puts it only in the handshake file.
    // A failure leaves scripts without Hydra, never the window: the token is revoked with it.
    const helpersRoot = path.join(this.context.globalStorageUri.fsPath, 'helpers');
    await sweepStaleHandshakes(helpersRoot).catch(() => 0);
    const userToken = endpoint.issue({ role: 'user', leadKey, leadSessionId: userPlanSession });
    try { this.helpers.handshake = await writeUserHandshake(helpersRoot, { pid: process.pid, port, token: userToken, repository: leadFolder }); }
    catch (error) { endpoint.revoke(userToken); this.output.appendLine(`[heads] no handshake for scripts: ${this.describe(error)}`); }
    this.startProjectSummary(record, leadFolder);
    // Plan lanes: the runner picks up running plans; a lane job that is ready now waits for Start lane.
    this.planRunner = this.controller.createPlanRunner(planStore, service, leadFolder, this.leadKey);
    await this.planRunner.advanceAll({ startup: true }).catch(error => this.output.appendLine(`[plans] ${this.describe(error)}`));
    this.tree.update({ lanes: this.lanes.state().lanes, heads: this.headViews() ?? [], plans: planStore.list(), planJobs: this.planJobViews() });
    this.output.appendLine(`[heads] ready for ${leadFolder}`);
    void this.refreshHelperConnections().then(() => this.connectOnFirstRun()).catch(error => this.output.appendLine(`[heads] first run: ${this.describe(error)}`));
    // ---- Packs (docs/internal/Packs_Plan.md): the active roles for the pickers, and the notification for a ----
    // ---- project whose packs.json lists a pack that still needs your OK on this machine. ----
    this.packsLeadFolder = leadFolder;
    await this.rolesChanged();
    void this.notifyPacksIfNeeded(leadFolder);
    const packsWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(leadFolder), '.hydra/{packs.json,packs/**}'));
    const onPacksChange = () => void this.rolesChanged();
    packsWatcher.onDidChange(onPacksChange); packsWatcher.onDidCreate(onPacksChange); packsWatcher.onDidDelete(onPacksChange);
    this.context.subscriptions.push(packsWatcher);
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
  private async setupPacksFolderWatcher(): Promise<void> {
    this.packsFolderWatcher?.dispose();
    this.packsFolderWatcher = undefined;
    const folder = this.packs.places().user;
    if (!folder) return;
    const found = await fsStat(folder).then(info => info.isDirectory(), () => false);
    if (!found) return;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(folder), '**'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const debounced = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; void this.rolesChanged(); }, 500);
    };
    watcher.onDidChange(debounced); watcher.onDidCreate(debounced); watcher.onDidDelete(debounced);
    this.packsFolderWatcher = watcher;
    this.context.subscriptions.push(watcher);
  }
  /** The folder `hydra.packs.*` commands act on: the one given, else this window's lead folder. */
  private async packsFolder(folder?: unknown): Promise<string> {
    if (typeof folder === 'string' && folder) {
      // Any extension can run these commands, so a folder must be this window's lead or one of its
      // workspace folders: never a place to write .hydra/packs.json that the user hasn't opened.
      const key = (value: string) => { const resolved = path.resolve(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
      const open = [this.packsLeadFolder, ...(vscode.workspace.workspaceFolders || []).map(item => item.uri.fsPath)].filter((item): item is string => !!item);
      if (!open.some(item => key(item) === key(folder))) throw new Error('Packs can only be changed for a folder open in this window.');
      return folder;
    }
    if (this.packsLeadFolder) return this.packsLeadFolder;
    throw new Error('Hydra packs are not ready in this window yet: open a project folder (a Git repository) first.');
  }
  /** Re-read the active roles (Snapshot.roles) and publish, so every picker sees a pack change at once. */
  private async rolesChanged(): Promise<void> {
    if (!this.packsLeadFolder) { this.roles = []; return; }
    try {
      const roles = await this.packs.roles(this.packsLeadFolder);
      this.roles = roles.map(role => ({ ref: role.ref, pack: role.pack, packTitle: role.packTitle, id: role.id, title: role.title, description: role.description, provider: role.provider }));
    } catch (error) { this.roles = []; this.output.appendLine(`[packs] roles: ${this.describe(error)}`); }
    this.tree.update({ roles: this.roles });
    // A running lane whose role just went away (or came back) hears about it now, not only at its next launch.
    await this.lanes.activeRolesChanged().catch(error => this.output.appendLine(`[lanes] active roles: ${this.describe(error)}`));
    // An open Settings → Packs and Settings → Gates follow too: a pack added to your packs folder, or a
    // hand-edited packs.json, shows there without pressing Reload.
    await this.settings.refreshPages(['packs', 'gates']).catch(() => undefined);
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
      const notified = new Set(this.context.workspaceState.get<string[]>(key, []));
      if (notified.has(needsOk.id)) return;
      await this.context.workspaceState.update(key, [...notified, needsOk.id]);
      const pick = await notices.info(`This project uses the ${needsOk.title} pack. Nothing from it runs until you review it.`, 'Review', 'Not now');
      if (pick === 'Review') this.settings.show('packs');
    } catch { /* packs aren't available in this window; say nothing */ }
  }
  /**
   * Starter gates (Step A): once per project per window, when it
   * has no .hydra/gates.json at all, from the first lane merge or head acceptance in it. Never
   * blocks: heads are unattended, and a lane merge has already happened by the time this runs.
   */
  private async offerStarterGatesIfNeeded(folder: string): Promise<void> {
    if (process.env.HYDRA_TEST_REPOSITORY) return;
    try {
      const config = await (this.packs.gates ?? loadGates)(folder);
      if (config.source !== 'none') return;
      const key = 'hydra.starterGates.asked.v1';
      const asked = new Set(this.context.workspaceState.get<string[]>(key, []));
      if (asked.has(folder)) return;
      await this.context.workspaceState.update(key, [...asked, folder]);
      const hasTest = await detectTestScript(folder);
      const pick = await notices.info(
        'This project has no gates yet: nothing independently checks a head\'s work before it\'s accepted, or a lane before it merges.',
        hasTest ? 'Add a test gate (npm test)' : 'Add a test gate', 'No gates for this project', 'Not now',
      );
      if (!pick || pick === 'Not now') return;
      const file = path.join(folder, '.hydra', 'gates.json');
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, pick.startsWith('Add a test gate') ? starterTestGatesFile() : noGatesFile(), 'utf8');
      await this.settings.refreshPages(['gates']).catch(() => undefined);
    } catch { /* gates aren't available in this window; say nothing, and never block acceptance or the merge */ }
  }
  // ---- Lanes (docs/internal/Lanes_And_Planner_Plan.md). The editor side is LanesController (src/extensionLanes.ts). ----
  /** Unfinished heads started from a lane. */
  // ---- Step D: a read-only view across projects ----
  /**
   * (Re)starts this window's summary publisher, keyed by the discovery record's own file name
   * (so both files sit beside each other under the same id). Called once at startup and again
   * whenever the record's id changes (its folders changed, so its hash did too); the old
   * publisher's file is removed by its own dispose() before the new one starts.
   */
  private startProjectSummary(record: string, folder: string): void {
    const previous = this.projectSummary;
    const id = path.basename(record, '.json');
    const dir = discoveryDirectory(path.join(this.context.globalStorageUri.fsPath, 'helpers'));
    this.projectSummary = startProjectSummaryPublisher({
      dir, id, pid: process.pid,
      build: () => {
        const heads = this.headViews() ?? [];
        const lanes = this.lanes.state().lanes;
        const providers = [...new Set([...heads.map(head => head.provider), ...lanes.map(lane => lane.provider)])];
        return buildProjectSummary({ pid: process.pid, folder, heads, lanes, plans: this.plans?.store.list() ?? [], planJobs: this.planJobViews(), providers });
      },
      onError: error => this.output.appendLine(`[projects] summary not written: ${this.describe(error)}`),
    });
    void previous?.dispose().catch(() => undefined);
  }
  /**
   * "Hydra: Show All Projects" (Step D): every open window's summary, read-only. Selecting a
   * live entry opens its folder — VS Code focuses that folder's window if it already has one
   * open, rather than opening a second window on it, so this passes forceNewWindow: false,
   * forceReuseWindow: false (neither "always a new window" nor "always reuse this one"). A
   * closed or not-responding entry has nothing to focus, so it only explains itself.
   */
  private async showAllProjects(): Promise<void> {
    const dir = discoveryDirectory(path.join(this.context.globalStorageUri.fsPath, 'helpers'));
    const summaries = await readProjectSummaries(dir, new Date(), isWindowAlive);
    if (!summaries.length) { void notices.info('No Hydra projects found.'); return; }
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
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Every Hydra project window (read-only)', matchOnDetail: true });
    if (!pick || pick.isThisWindow) return;
    if (pick.summary.liveness === 'closed') { void notices.info(`${pick.summary.name}'s window has closed.`); return; }
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(pick.summary.folder), { forceNewWindow: false, forceReuseWindow: false });
  }
  private laneHeads(laneId: string): number {
    return this.helpers?.service.list().filter(job => job.lead?.lane === laneId && !finalJobStates.has(job.state)).length ?? 0;
  }
  /**
   * Rewrite the discovery record when the open lanes' worktrees change, so a
   * lane's bridge finds this window from inside its worktree. The old record goes.
   */
  private laneFoldersChanged(): void {
    this.tree.update({ lanes: this.lanes.state().lanes });
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
      const next = await writeWindowRecord(path.join(this.context.globalStorageUri.fsPath, 'helpers'), { port: discovery.port, pid: process.pid, folders: [...discovery.folders, ...worktrees] });
      // The record's file name (the summary's id) is a hash of its folders: a new one means a new id.
      if (next !== helpers.record) { await removeWindowRecord(helpers.record).catch(() => undefined); helpers.record = next; this.startProjectSummary(next, helpers.service.leadFolder); }
    }).catch(error => this.output.appendLine(`[lanes] discovery record not updated: ${this.describe(error)}`));
  }
  // ---- Connecting Claude Code and Codex to Hydra (plan, Phase 5) ----
  private helperServerSpec(provider: ConnectableProvider): HelperServerSpec { const bridge = this.helperBridge(provider); return { command: bridge.command, args: bridge.args, env: bridge.env }; }
  /** Claude's own CLI does the registration: the configured or PATH claude, else the extension's bundled one. */
  async helperConnections(): Promise<ProviderConnectionView[]> {
    const paths = providerPaths();
    const [claude, codex, memory] = await Promise.all([claudeStatus(paths, this.helperServerSpec('claude')), codexStatus(paths.codexConfig, this.helperServerSpec('codex')), claudeMemStatus()]);
    const accounts = this.accounts.snapshot();
    const claudeExtension = vscode.extensions.getExtension('anthropic.claude-code');
    const codexExtension = vscode.extensions.getExtension('openai.chatgpt');
    const development = this.context.extensionMode !== vscode.ExtensionMode.Production;
    const memoryEnabled = (machineSetting<boolean>(vscode.workspace.getConfiguration('hydra'), 'claudeMem.enabled') ?? false);
    const memoryRow = claudeMemRowText(memoryEnabled, claude.connected && claude.current, memory);
    return [
      { ...claude, name: 'Claude Code', extensionInstalled: !!claudeExtension, extensionVersion: (claudeExtension?.packageJSON as { version?: string } | undefined)?.version, memory: memoryEnabled ? (memory.plugin && memory.bun && memory.dependencies ? 'ready' : 'missing') : undefined, memoryEnabled, memoryText: memoryRow.text, memoryRepair: memoryRow.repair, signedIn: accounts.claude.status, ...(development ? { development } : {}) },
      { ...codex, name: 'Codex', extensionInstalled: !!codexExtension, extensionVersion: (codexExtension?.packageJSON as { version?: string } | undefined)?.version, signedIn: accounts.codex.status, ...(development ? { development } : {}) },
    ];
  }
  /** "What Hydra wrote" (Settings, Connectors): the exact user-level entries read back off disk, secrets masked. */
  async helperWrittenEntries(): Promise<WrittenEntries> {
    return helperWrittenEntries(providerPaths(), maskSecret);
  }
  /** Re-run claude-mem's setup idempotently: the Repair button, and reused by Connect. Both are gated on the opt-in setting. */
  private async repairClaudeMem(): Promise<{ status: Awaited<ReturnType<typeof claudeMemStatus>>; installed: string[] }> {
    if (!shouldSetUpClaudeMem((machineSetting<boolean>(vscode.workspace.getConfiguration('hydra'), 'claudeMem.enabled') ?? false))) throw new Error('Turn on Memory (claude-mem) in Settings → Connectors first.');
    const claude = await claudeForRegistration();
    if (!claude) throw new Error('Install the Claude Code extension or CLI first.');
    return setupClaudeMem(claude);
  }
  /** Install an official extension from the gallery, or straight from Open VSX when the gallery can't (installWithFallback). */
  private async installProviderExtension(provider: ConnectableProvider): Promise<void> {
    if (provider !== 'claude' && provider !== 'codex') throw new Error('Unknown provider.');
    const id = provider === 'claude' ? 'anthropic.claude-code' : 'openai.chatgpt';
    if (vscode.extensions.getExtension(id)) return;
    const via = await installWithFallback(id,
      extension => Promise.resolve(vscode.commands.executeCommand('workbench.extensions.installExtension', extension)),
      file => Promise.resolve(vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file))),
      undefined, line => this.output.appendLine(line));
    this.output.appendLine(`[heads] installed ${id} from ${via === 'gallery' ? 'the extension gallery' : 'Open VSX'}`);
  }
  /**
   * First run (docs/Heads.md, "Connecting Claude Code and Codex"): once, in an installed desktop Hydra, connect the
   * agents whose command-line tools are already on this computer (installing their extensions), so a new user
   * doesn't have to find Connect. Anything that fails says so, with a way to Settings → Connectors.
   */
  private async connectOnFirstRun(): Promise<void> {
    const host = await Promise.resolve(vscode.commands.executeCommand<{ development: boolean }>('hydra.desktop.startupContext')).catch(() => undefined);
    if (!shouldConnectOnFirstRun({ desktop: this.settingsImport.available, production: this.context.extensionMode === vscode.ExtensionMode.Production,
      development: host?.development !== false, test: !!process.env.HYDRA_TEST_REPOSITORY, handoff: !!this.handoff, done: !!this.context.globalState.get(firstRunConnectKey) })) return;
    await this.context.globalState.update(firstRunConnectKey, true);
    const connections = await this.helperConnections();
    const row = (provider: ConnectableProvider) => connections.find(item => item.provider === provider);
    const cli = async (provider: 'claude' | 'codex') => !!(await findProvider(provider, machineSetting<string>(vscode.workspace.getConfiguration('hydra'), provider === 'claude' ? 'claudePath' : 'codexPath') || undefined).catch(() => undefined))?.executable;
    const wanted = firstRunProviders({
      claude: { cli: await cli('claude'), connected: !!row('claude')?.connected, extension: !!row('claude')?.extensionInstalled },
      codex: { cli: await cli('codex'), connected: !!row('codex')?.connected, extension: !!row('codex')?.extensionInstalled },
    });
    if (!wanted.length) return;
    const done: string[] = [], failed: string[] = [];
    await notices.withProgress({ title: 'Hydra: connecting your agents' }, async progress => {
      for (const provider of wanted) {
        const name = provider === 'claude' ? 'Claude Code' : 'Codex';
        progress.report({ message: `${name}…` });
        try { await this.connectHelpers(provider); done.push(name); }
        catch (error) { failed.push(`${name} (${this.describe(error)})`); this.output.appendLine(`[heads] first run: couldn't connect ${provider}: ${this.describe(error)}`); }
      }
    });
    this.onboarding.refreshConnections();
    if (failed.length) {
      const pick = await notices.warning(`Hydra couldn't connect ${failed.join(', ')}.${done.length ? ` ${done.join(' and ')} ${done.length === 1 ? 'is' : 'are'} connected.` : ''}`, 'Open Connectors');
      if (pick) await vscode.commands.executeCommand('hydra.openSettings', 'connectors');
    } else void notices.info(`${done.join(' and ')} ${done.length === 1 ? 'is' : 'are'} connected to Hydra: chat in ${done.length === 1 ? 'its extension' : 'their extensions'}, and they can start Hydra heads.`);
  }
  /**
   * One Connect: install the official extension if it's missing, connect it to
   * Hydra, and for Claude set up claude-mem too, but only when the user turned on
   * Memory (claude-mem) in Settings → Connectors; off by default, so a plain
   * Connect never installs Bun or claude-mem. A claude-mem problem doesn't undo
   * the connection; it's reported and Connect can be pressed again.
   */
  private async connectHelpers(provider: ConnectableProvider): Promise<string | undefined> {
    await this.installProviderExtension(provider);
    const paths = providerPaths(), spec = this.helperServerSpec(provider);
    if (provider === 'codex') await connectCodex(paths.codexConfig, spec);
    else if (provider === 'claude') {
      const claude = await claudeForRegistration();
      if (!claude) throw new Error('Install the Claude Code extension or CLI first; Hydra connects through it.');
      await connectClaude(claude, paths, spec, await this.limitHookFor(claude));
      this.output.appendLine('[heads] connected claude to Hydra');
      if (!shouldSetUpClaudeMem((machineSetting<boolean>(vscode.workspace.getConfiguration('hydra'), 'claudeMem.enabled') ?? false))) return undefined;
      try {
        const memory = await setupClaudeMem(claude);
        if (memory.installed.length) this.output.appendLine(`[heads] set up ${memory.installed.join(' and ')} for claude-mem`);
        return undefined;
      } catch (error) { this.output.appendLine(`[heads] claude-mem setup failed: ${this.describe(error)}`); return `Connected, but claude-mem could not be set up: ${this.describe(error)}`; }
    } else throw new Error('Unknown provider.');
    this.output.appendLine(`[heads] connected ${provider} to Hydra`);
    return undefined;
  }
  private async disconnectHelpers(provider: ConnectableProvider): Promise<void> {
    const paths = providerPaths();
    if (provider === 'codex') await disconnectCodex(paths.codexConfig);
    else if (provider === 'claude') await disconnectClaude(await claudeForRegistration(), paths);
    else throw new Error('Unknown provider.');
    this.output.appendLine(`[heads] disconnected ${provider} from Hydra`);
  }
  /** A connection made by an older Hydra (a different executable path) is refreshed; nothing is connected here that the user didn't connect. */
  private async refreshHelperConnections(): Promise<void> {
    // A development or test window (another profile, another extension folder) would
    // point the user's real Claude and Codex at itself; only an installed Hydra refreshes.
    if (this.context.extensionMode !== vscode.ExtensionMode.Production) { this.output.appendLine('[heads] development window: leaving the Claude and Codex connections as they are'); return; }
    for (const connection of await this.helperConnections()) {
      if (connection.connected && !connection.current && !connection.error) {
        await this.connectHelpers(connection.provider).catch(error => this.output.appendLine(`[heads] could not refresh ${connection.provider}: ${this.describe(error)}`));
      } else if (connection.provider === 'claude' && connection.connected && !connection.error) {
        await this.refreshLimitHook().catch(error => this.output.appendLine(`[limits] could not refresh the Claude hook: ${this.describe(error)}`));
      }
    }
  }
  /**
   * A connected Claude gets the usage-limit hook: rewritten when Hydra's path moved,
   * added when a Connect from before the hook existed didn't write it.
   */
  private async refreshLimitHook(): Promise<void> {
    const paths = providerPaths(), group = this.limitHook();
    const state = limitHookState(await read(paths.claudeSettings), group);
    if (state === 'current') return;
    if (state === 'missing') { const claude = await claudeForRegistration(); if (!claude || !await this.limitHookFor(claude)) return; }
    await setClaudeLimitHook(paths, group);
    this.output.appendLine(`[limits] ${state === 'stale' ? 'updated' : 'added'} the Claude usage-limit hook`);
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
      const message = await vscode.window.showInputBox({ title: `Answer "${job.title}"`, prompt: job.question || 'The head is waiting for an answer.', placeHolder: 'Your answer', ignoreFocusOut: true, validateInput: value => value.trim() && value.length <= 8000 ? undefined : 'Write an answer (up to 8000 characters).' });
      if (message === undefined) return;
      await helpers.service.handle({ role: 'lead', leadKey: job.leadKey }, 'hydra_reply_to_head', { job_id: jobId, message }, new AbortController().signal);
      return;
    }
    if (action === 'helperLog') {
      const log = path.join(this.storageDirectory, 'helpers', 'logs', `${jobId}.jsonl`);
      await this.toEditor();
      await vscode.window.showTextDocument(vscode.Uri.file(log), { preview: true, viewColumn: vscode.ViewColumn.Beside });
      return;
    }
    if (!job.worktree || !job.baseCommit) throw new Error('This head has no changes yet.');
    const head = job.result?.commit || (await git(job.worktree, ['rev-parse', 'HEAD'])).trim();
    const diff = await git(job.worktree, ['diff', '--stat', '--patch', '--no-color', job.baseCommit, head, '--']);
    await this.toEditor();
    const document = await vscode.workspace.openTextDocument({ language: 'diff', content: `# ${job.title} (Hydra head ${job.id})\n# ${job.branch} ${job.baseCommit.slice(0, 12)}..${head.slice(0, 12)}\n# Merge it yourself with git when you're happy: git merge ${job.branch}\n\n${diff || '(no changes)'}` });
    await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  }
  /**
   * View evidence: the Markdown is written next to the evidence (in the run's log root) and
   * previewed from there, because the preview follows links and shows images relative to the
   * document but refuses `file:` links.
   */
  private async openEvidence(kind: 'head' | 'lane', id: string): Promise<void> {
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
    await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(file));
  }
  /**
   * Hydra: Open Audit Log (5.2). Opens a snapshot of the file's
   * current content as an untitled document, never the file itself, so it can't be edited in
   * place. `flush()` first, so a just-recorded event (this window's own) is included.
   */
  private async openAuditLog(): Promise<void> {
    await this.audit.flush();
    const file = path.join(this.context.globalStorageUri.fsPath, 'audit', 'audit.jsonl');
    const content = await readFile(file, 'utf8').catch(() => undefined);
    if (!content) { void notices.info('No audit events yet.'); return; }
    // A read-only document named audit.jsonl (a content provider's documents can't be saved);
    // the query changes each time, so it's never a stale cached copy.
    if (!this.auditProvider) {
      this.auditProvider = vscode.workspace.registerTextDocumentContentProvider('hydra-audit', { provideTextDocumentContent: uri => this.auditSnapshots.get(uri.query) ?? '' });
      this.context.subscriptions.push(this.auditProvider);
    }
    const key = String(Date.now());
    this.auditSnapshots.clear(); this.auditSnapshots.set(key, content);
    await this.toEditor();
    const document = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: 'hydra-audit', path: '/audit.jsonl', query: key }));
    await vscode.window.showTextDocument(document, { preview: true });
  }
  private auditProvider?: vscode.Disposable;
  /**
   * Stop All Agents (5.3), shared by the command (after its confirmation) and the user role's
   * hydra_stop_all (O8a), which asks nothing: the script is you. `what` is the audit line.
   */
  private async stopAllAgents(reason: string, what: string): Promise<{ heads: number; lanes: number }> {
    await this.stop.stop(reason);
    const heads = await this.helpers?.service.stopAll(reason) ?? 0;
    const lanes = await this.lanes.stopProcesses();
    const parts = [heads ? `${heads} head${heads === 1 ? '' : 's'}` : '', lanes ? `${lanes} lane${lanes === 1 ? '' : 's'}` : ''].filter(Boolean);
    // 5.2: a stop — Stop All Agents itself, distinct from each head's own "head cancelled" line.
    this.audit.record({ kind: 'stop', what, detail: parts.join(', ') || undefined });
    void notices.info(`Hydra stopped${parts.length ? `: ${parts.join(', ')}` : ''}. Starting heads, launching lanes and advancing plans are refused until you run "Hydra: Resume Agents".`);
    return { heads, lanes };
  }
  /**
   * HSEC-72: `hydra close` (the user role's hydra_close), after HelperService has checked that nothing is still working
   * here or the caller forced it. Logged and audited now; the window closes closeDelayMs later, so the caller gets its reply, after checking again (unless forced) that no work started meanwhile.
   */
  private closeFromScript(request: { force: boolean; activity: WindowActivity; reason?: string }): void {
    const working = describeActivity(request.activity);
    const detail = [request.reason, request.force && working ? `forced, cutting short ${working}` : ''].filter(Boolean).join('; ');
    this.output.appendLine(`[close] Closing this window, as a script asked (hydra close)${detail ? `: ${detail}` : ''}.`);
    this.audit.record({ kind: 'close', what: 'Close window (from a script)', ...(detail ? { detail } : {}) });
    scheduleClose({
      force: request.force,
      activity: () => this.windowActivityNow(),
      close: () => { void Promise.resolve(vscode.commands.executeCommand('workbench.action.closeWindow')).catch(error => this.output.appendLine(`[close] ${this.describe(error)}`)); },
      aborted: refusal => {
        // Work started between the reply and the close: the window stays open.
        this.output.appendLine(`[close] Not closing after all: ${refusal}`);
        this.audit.record({ kind: 'denial', what: 'Close window (from a script) stopped: work started before it closed', detail: refusal, role: 'user' });
      },
    });
  }
  /** What in this window is still working (HSEC-72). */
  private windowActivityNow(): WindowActivity {
    return windowActivity({ heads: this.helpers?.service.list() ?? [], lanes: this.lanes.state().lanes, plans: this.plans?.store.list() ?? [] });
  }
  /** Resume Agents (5.3), shared by the command and the user role's hydra_resume (O8a). */
  private async resumeAgents(what: string): Promise<void> {
    await this.stop.resume();
    await this.planRunner?.advanceAll().catch(error => this.output.appendLine(`[plans] ${this.describe(error)}`));
    // 5.2: a resume.
    this.audit.record({ kind: 'resume', what });
    void notices.info('Hydra resumed: heads, lanes and plans may start again.');
  }
  private readonly auditSnapshots = new Map<string, string>();
  private async stopHelpers(): Promise<void> {
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
  async showFirstRun(): Promise<void> {
    const firstRun = await this.firstRunLayoutOnce();
    const onboarding = this.disabled ? false : await this.onboarding.autoShow(!!vscode.workspace.getConfiguration('hydra').get('handoff'));
    // Onboarding opens the Agents view when it's finished or set aside (Onboarding's `finished`); a handoff window
    // is already forced to Agents in initialize(). Otherwise the first launch lands in Agents too, and later
    // launches follow the startup layout setting.
    if (!onboarding && !this.handoff && this.mode === 'editor' && (firstRun || vscode.workspace.getConfiguration('hydra').get<string>('startupLayout') === 'agents')) {
      await this.openAgents();
    }
  }
  /**
   * The packaged app's first launch: the Hydra side bar (New lane, New plan, Open Agent Manager) is shown, so the way
   * into Hydra is in plain sight rather than behind a closed side bar. Once; the user's later layout is theirs.
   * True on that first launch.
   */
  private async firstRunLayoutOnce(): Promise<boolean> {
    // The desktop smoke runs the installed build on a fresh profile; its test environment is how it's told apart:
    // it checks the editor and Agents switching from a known start.
    if (!this.settingsImport.available || process.env.HYDRA_TEST_REPOSITORY) return false;
    const key = 'hydra.firstRunLayout.v1';
    if (this.context.globalState.get(key)) return false;
    await this.context.globalState.update(key, true);
    await Promise.resolve(vscode.commands.executeCommand('workbench.view.extension.hydra')).catch(() => {});
    return true;
  }
  private async verifyHandoffWorkspace(): Promise<void> {
    if (!this.handoff) throw new Error('Open the handoff workspace to use this action.');
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length !== 1 || path.relative(await realpath(folders[0]!.uri.fsPath), await realpath(this.handoff.task.worktree)) !== '') throw new Error('Handoff workspace does not match the exact handoff worktree.');
    await this.verifyWorktree(this.handoff.task);
  }
  private async refreshRepositories(): Promise<void> {
    const repositories: string[] = [];
    for (const folder of vscode.workspace.workspaceFolders || []) {
      try { repositories.push(await repositoryRoot(folder.uri.fsPath)); }
      catch { /* Non-Git folders remain ordinary editor workspaces. */ }
    }
    this.repositories = [...new Set(repositories)];
  }
  private async refresh(): Promise<void> { this.error = undefined; await this.refreshRepositories(); await this.publish(); }
  private describe(error: unknown): string { return error instanceof Error ? error.message : String(error); }
  /** 5.3: the status bar item, shown only while Hydra is stopped. */
  private updateStopStatus(): void {
    if (!this.stop.isStopped()) { this.stopStatus.hide(); return; }
    const since = this.stop.since();
    this.stopStatus.text = '$(debug-stop) Hydra stopped';
    this.stopStatus.tooltip = `Stopped since ${since ? new Date(since).toLocaleString() : 'earlier'}. Click to resume.`;
    this.stopStatus.show();
  }
  private report(error: unknown): void {
    this.error = this.describe(error);
    this.output.appendLine(this.error);
    void notices.error(`Hydra: ${this.error}`);
    void this.publish();
  }
  private async verifyWorktree(task: Pick<HandoffTask, 'repository' | 'worktree' | 'branch'>): Promise<void> {
    const actual = await realpath(task.worktree);
    if (actual !== await repositoryRoot(actual)) throw new Error('Saved worktree is not a repository root.');
    const [taskCommon, mainCommon, branch] = await Promise.all([
      git(actual, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      git(task.repository, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      git(actual, ['symbolic-ref', '--short', 'HEAD'])
    ]);
    if (await realpath(taskCommon.trim()) !== await realpath(mainCommon.trim())) throw new Error('Handoff worktree belongs to a different repository.');
    if (branch.trim() !== task.branch) throw new Error('Handoff worktree branch changed. Restore its recorded branch.');
  }
  private headViews(): HelperJobView[] | undefined { return this.controller.headViews(); }
  private headsChanged(): void { this.controller.headsChanged(); }
  private async publish(): Promise<void> { await this.controller.publish(); }
  /** The IDE's part of each snapshot, and the status bar that always changed with it. */
  private view(): Pick<Snapshot, 'mode' | 'busy' | 'error' | 'handoff' | 'officialExtensions'> {
    this.status.text = `$(layout) ${this.mode === 'agents' ? 'Agent Manager' : 'Editor'}${this.error ? ' $(warning)' : ''}`;
    this.status.tooltip = `Hydra: switch to the ${this.mode === 'agents' ? 'Editor' : 'Agent Manager'} (Alt+Shift+A)`;
    return { mode: this.mode, busy: this.busy || this.disabled, error: this.error, handoff: this.handoff, officialExtensions: ['claude', 'codex'].map(provider => officialExtensionInfo(provider as 'claude' | 'codex')) };
  }
  private plansChanged(): void { this.controller.plansChanged(); }
  private requirePlans(): { store: PlanStore; planning: Map<string, AbortController> } { return this.controller.requirePlans(); }

  // ---- O1: plans from the chat (docs/Heads.md, "Plans from the chat") ----


  private createPlanLeadBridge(): PlanLeadBridge {
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
    const defaultHeadBudgetUsd = vscode.workspace.getConfiguration('hydra').get<number>('heads.defaultBudgetUsd', 5);
    const plan = planFromLeadInput(input, { leadSessionId, idempotencyKey: input.idempotencyKey }, defaultHeadBudgetUsd);
    await plans.store.save(plan);
    this.plansChanged();
    const needsApproval = vscode.workspace.getConfiguration('hydra').get<boolean>('plans.leadPlansNeedApproval', false);
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
    const max = Math.max(0, vscode.workspace.getConfiguration('hydra').get<number>('plans.maxAmendments', 10));
    // Hydra's own integration fixes don't use up the lead's amendments.
    const already = (owned.amendments ?? []).filter(amendment => !amendment.key || !isIntegrationFixKey(amendment.key)).length;
    if (max > 0 && already + requested > max) throw new Error(`Plan "${owned.title}" has ${already} of ${max} amendments already; this would add ${requested}. Cancel the plan, or start a new one for the rest.`);
    const runner = this.requirePlanRunner();
    const changed = await runner.withPlan(id, async () => {
      // A head's failure lives only in its own job, never written back to the plan's job (PlanRunner.statuses
      // reads it live); retry needs this to know a head job failed at all, so it's read once, just before applying.
      const statuses = new Map((runner.statuses(id) ?? []).map(view => [view.key, view.status as string]));
      const defaultHeadBudgetUsd = vscode.workspace.getConfiguration('hydra').get<number>('heads.defaultBudgetUsd', 5);
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
      await runner.cancelJob(id, view.key, reason).catch(error => this.output.appendLine(`[plans] ${id}: couldn't cancel job ${view.key}: ${this.describe(error)}`));
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

  private createPlanBoardBridge(): PlanBoardBridge {
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
  private jobPlanFor(jobId: string): { planId: string; jobKey: string } | undefined {
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
  /** hydra.learn: opens the "Work with Hydra" walkthrough (docs/internal/Lanes_And_Planner_Plan.md, "A walkthrough"). */
  private async openWalkthrough(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.openWalkthrough', `${this.context.extension.id}#hydra.workWithHydra`, false);
  }
  private newPlan(): Promise<void> { return this.controller.newPlan(); }
  private runPlanById(id: string): Promise<void> { return this.controller.runPlanById(id); }
  private requirePlanRunner(): PlanRunner { return this.controller.requirePlanRunner(); }
  private planReportMarkdown(plan: Plan): string { return this.controller.planReportMarkdown(plan); }
  private planJobViews(): Record<string, PlanJobView[]> { return this.controller.planJobViews(); }
  private connectWebview(webview: vscode.Webview): void {
    webview.onDidReceiveMessage(value => { void this.handle(value).catch(error => this.report(error)); }, undefined, this.context.subscriptions);
  }
  private async openAgents(): Promise<void> {
    this.mode = 'agents';
    const modeChanged = vscode.commands.executeCommand('setContext', 'hydra.mode', this.mode);
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel('hydra.manager', 'Agent Manager', vscode.ViewColumn.Active, {
        enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')]
      });
      this.panel = panel;
      panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'hydra-logo.png');
      panel.webview.html = this.html(panel.webview);
      panel.onDidDispose(() => {
        if (this.panel !== panel) return;
        this.panel = undefined;
        this.mode = 'editor';
        void vscode.commands.executeCommand('setContext', 'hydra.mode', this.mode);
        void this.publish();
      }, undefined, this.context.subscriptions);
      this.connectWebview(panel.webview);
    } else this.panel.reveal();
    await modeChanged;
    await this.publish();
  }
  /** The Agent Manager is the whole window, so opening a file, diff or log from it switches to the Editor first. */
  private async toEditor(): Promise<void> {
    if (this.mode === 'agents') await this.openEditor();
  }
  private async openEditor(): Promise<void> {
    this.mode = 'editor';
    // Closing only Hydra lets native tab history restore text, diff and custom editors.
    // Never choose a sidebar, resize a group, or reopen a text document here.
    this.panel?.dispose();
    await vscode.commands.executeCommand('setContext', 'hydra.mode', this.mode);
    await this.publish();
  }
  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(24).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'));
    const logo = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'hydra-logo.png'));
    // Lane terminals (xterm.js) write their font and ANSI colours into a <style> element they create,
    // so inline styles are allowed here. Scripts stay nonce-only; text is escaped by React and xterm.
    return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"><title>Hydra</title></head><body data-logo="${logo}"><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
  private async handle(value: unknown): Promise<void> { await this.controller.handle(value); }
  /** The Agents view's messages that stay with the IDE: the controller passes them back here. */
  private async handleIde(message: ClientMessage): Promise<void> {
    if (message.type === 'editor') { await this.openEditor(); return; }
    if (message.type === 'agents') { await this.openAgents(); return; }
    if (message.type === 'settings') { this.settings.show(); return; }
    if (message.type === 'refresh') { await this.refresh(); return; }
    if (message.type === 'helperStopAll') { await vscode.commands.executeCommand('hydra.stopAllHelpers'); return; }
    if (message.type === 'learn') { await vscode.commands.executeCommand('hydra.learn'); return; }
    if (message.type === 'helperReview' || message.type === 'helperLog' || message.type === 'helperCancel' || message.type === 'helperAnswer' || message.type === 'helperEvidence') { await this.helperAction(message.type, message.jobId); return; }
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to use Hydra.');
    if (this.disabled) throw new Error('Hydra is disabled in this window. Resolve the ownership or handoff error and reload this window.');
    if (message.type === 'checkProvider') {
      if (this.diagnostics.get(message.provider)?.status === 'checking') throw new Error('This provider check is already in progress.');
      const controller = new AbortController(), generation = this.diagnosticGeneration;
      this.diagnosticChecks.add(controller);
      this.diagnostics.set(message.provider, { provider: message.provider, status: 'checking', checkedAt: new Date().toISOString(), advertised: [], probes: [] });
      await this.publish();
      try {
        const info = await findProvider(message.provider, machineSetting<string>(vscode.workspace.getConfiguration('hydra'), `${message.provider}Path`));
        const diagnostic = await checkProvider(info, this.repositories[0] || this.context.extensionUri.fsPath, controller.signal);
        if (generation === this.diagnosticGeneration && !this.closing) this.diagnostics.set(message.provider, diagnostic);
      } catch (error) {
        if (generation === this.diagnosticGeneration && !this.closing) this.diagnostics.set(message.provider, { provider: message.provider, status: 'error', checkedAt: new Date().toISOString(), advertised: [], probes: [], error: this.describe(error) });
      } finally { this.diagnosticChecks.delete(controller); await this.publish(); }
      return;
    }
    // openOfficial, showOfficial and copyHandoffPrompt act only in a handoff window.
    await this.verifyHandoffWorkspace();
    const handoff = this.handoff!;
    if (message.type === 'openOfficial') await openOfficialExtension(handoff.task.provider);
    else if (message.type === 'showOfficial') await vscode.commands.executeCommand('workbench.extensions.search', `@id:${officialProviders[handoff.task.provider].extensionId}`);
    else await vscode.env.clipboard.writeText(handoff.task.prompt);
    await this.publish();
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    await this.stopHelpers().catch(error => this.report(error));
    await this.accounts.shutdown();
    await this.quota.shutdown();
    for (const controller of this.diagnosticChecks) controller.abort();
    for (const lock of this.locks) await lock.release();
  }
}
