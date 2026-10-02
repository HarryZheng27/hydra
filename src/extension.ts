import * as vscode from 'vscode';
import { machineSetting } from './core/machineSetting';
import { notices } from './notices';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { git, repositoryRoot } from './core/worktrees';
import { AppearanceSettings } from './extensionSettings';
import { SettingsImport } from './extensionImport';
import { Onboarding } from './extensionOnboarding';
import { ProviderAccounts } from './extensionAccounts';
import { ProviderQuota } from './extensionQuota';
import { findProvider } from './core/providers';
import { evidenceLabel, finalJobStates, type EvidenceStatus } from './core/jobs';
import { alive as isWindowAlive, discoveryDirectory } from './core/helperDiscovery';
// ---- Step D: a read-only view across projects ----
import { readProjectSummaries } from './core/projectSummary';
import { HeadSandbox } from './core/headSandbox';
import { headShellSentence } from './core/confine';
import { firstRunConnectKey, firstRunProviders, shouldConnectOnFirstRun } from './core/onboarding';
import { codexStatus, providerPaths, type ConnectableProvider } from './core/helperRegistration';
import type { LimitEvent } from './core/limitEvents';
import { ClaudeChatLimits, CodexChatLimits } from './extensionLimits';
import { addMcpServer, configuredSpec, defaultMcpContext, enableMcpServerFor, listMcpServers, removeMcpServer, testMcpServer, validateServerSpec, type McpAgent } from './core/mcpServers';
import { createRedactor } from './core/redact';
import { checkProvider } from './core/diagnostics';
import { settingsRequiringRefresh } from './core/settingsRefresh';
import { parseHandoff, officialProviders } from './core/handoff';
import { officialExtensionInfo, openOfficialExtension } from './extensionBridge';
import { claudeForRegistration } from './claudeExecutable';
import { registerChatLocationController, setChatLocation } from './chatLocationController';
import { registerLimitOffer } from './extensionLimitOffer';
import { codexLaneFanout } from './core/limitEvents';
import { LimitOfferTracker } from './core/limitOffer';
import { LanesController } from './host/lanes';
import { HydraTreeProvider } from './extensionTree';
// ---- Packs (docs/internal/Packs_Plan.md). Its own block. ----
import { createPackService } from './extensionPacks';
import type { PackService } from './core/packs/service';
import { type ClientMessage, type Provider, type ProviderDiagnostic, type Snapshot, type Handoff, type HandoffTask } from './core/model';
// ---- Planner (docs/internal/Lanes_And_Planner_Plan.md, section 4). Its own block; Phase 1 (Lanes) wires its own imports separately. ----
import { PlanStore, type Plan, type PlanDispatch } from './core/plans';
// ---- Plan lanes (docs/internal/Plan_Lanes_Plan.md). Their own block. ----
import { planIdPattern, planJobKeyPattern } from './core/plans';
import { PlanRunner } from './core/planRunner';
// ---- Gates (docs/internal/Gates_Plan.md). Their own block. ----
import { otherStillLimited } from './core/limitOffer';
import { buildEvidenceMarkdown } from './core/evidence';
// ---- Stop all (5.3). Its own line. ----
import { StopSwitch } from './core/stopSwitch';
// ---- Audit log (5.2). Its own line. ----
import { AuditLog, type AuditEvent } from './core/audit';
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
  private panel?: vscode.WebviewPanel;
  private mode: 'editor' | 'agents' = 'editor';
  private busy = false;
  private error?: string;
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
  private get repositories() { return this.controller.repositories; }
  private get disabled() { return this.controller.disabled; }
  private set disabled(value) { this.controller.disabled = value; }
  /** Every usage limit Hydra notices: the controller's (docs/internal/Hydra_Agent_Plan.md, Phase 1). */
  get limitEvents() { return this.controller.limitEvents; }
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
  /** Shared by the chat/head notification and every lane's tile banner, so "the other provider is limited too" sees all three (docs/internal/Gates_Plan.md, section 2). */
  private readonly limitOfferTracker = new LimitOfferTracker();
  // ---- Lanes (docs/internal/Lanes_And_Planner_Plan.md): state; the methods are in the Lanes block below ----
  private readonly lanes: LanesController;
  /** The Hydra activity-bar panel (section 3): one TreeView over lanes, heads and plans. */
  private readonly tree = new HydraTreeProvider();
  /** The Agents panel whose webview has sent "ready". */
  private readyPanel?: vscode.WebviewPanel;
  // ---- Packs (docs/internal/Packs_Plan.md): gates.json plus the active packs' gates, for heads and lanes ----
  private readonly packs: PackService;
  /** Step 2: Codex's sandbox for heads' shells and gate commands, checked once per window when first needed. */
  private readonly headSandbox: HeadSandbox;
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
    context.subscriptions.push(this.settings, this.onboarding, this.accounts, this.quota, this.tree);
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
      platform: this.host, log: line => this.output.appendLine(line),
      post: message => { void this.panel?.webview.postMessage(message); },
      openAgents: () => this.openAgents(), toEditor: () => this.toEditor(), webviewReady: () => !!this.panel && this.readyPanel === this.panel,
      helperServerSpec: provider => this.controller.helperServerSpec(provider), runningHeads: id => this.controller.laneHeads(id),
      changed: () => this.controller.laneFoldersChanged(),
      gatesExecutable: provider => this.helperExecutable(provider),
      gatesLimited: provider => otherStillLimited(this.controller.latestLimits.get(provider), new Date()),
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
      offerStarterGates: folder => void this.controller.offerStarterGatesIfNeeded(folder),
      openEvidence: async laneId => { await vscode.commands.executeCommand('hydra.openEvidence', 'lane', laneId); },
    }, this.limitOfferTracker);
    context.subscriptions.push(this.lanes);
    this.controller = new HydraController({
      host: this.host, lanes: this.lanes, stop: this.stop, audit: this.audit, packs: this.packs, headSandbox: this.headSandbox,
      storageDirectory: this.storageDirectory, leadKey: this.leadKey,
      ide: {
        view: () => this.view(),
        handle: message => this.handleIde(message),
        uiReady: () => { this.readyPanel = this.panel; },
        agentsOpen: () => !!this.panel,
        showingAgents: () => this.mode === 'agents',
        openAgents: () => this.openAgents(),
        tree: update => this.tree.update(update),
        inHandoff: () => !!this.handoff,
        refreshSettingsPages: async pages => { await this.settings.refreshPages(pages); },
        showSettings: page => this.settings.show(page),
        accounts: () => this.accounts.snapshot(),
        connectOnFirstRun: () => this.connectOnFirstRun(),
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
      await this.controller.stopAllAgents('Stopped with "Hydra: Stop All Agents".', 'Stop all agents');
      return true;
    });
    command('hydra.resumeAgents', async () => {
      await this.controller.resumeAgents('Resume agents');
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
    command('hydra.packs.state', async (folder?: unknown) => structuredClone(await this.packs.state(await this.controller.packsFolder(folder))));
    command('hydra.packs.setEnabled', async (folder: unknown, id: unknown, on: unknown) => {
      const root = await this.controller.packsFolder(folder);
      const packId = String(id), enable = !!on;
      // Turning on here never allows a pack: an off pack that isn't already allowed for this project stays "Needs your OK".
      if (enable && !(await this.packs.isAllowed(root, packId))) throw new Error(`The ${packId} pack needs your review first. Turn it on from Settings → Packs.`);
      await this.packs.setEnabled(root, packId, enable);
      await this.controller.rolesChanged();
      return structuredClone(await this.packs.state(root));
    });
    command('hydra.packs.skipGate', async (folder: unknown, id: unknown, gate: unknown, skip: unknown) => {
      const root = await this.controller.packsFolder(folder);
      await this.packs.skipGate(root, String(id), String(gate), !!skip);
      return structuredClone(await this.packs.state(root));
    });
    command('hydra.packs.addFolder', async (source: unknown) => {
      if (typeof source !== 'string' || !source) throw new Error('Pass the folder to add.');
      const installed = await this.packs.addFolder(source);
      // addFolder makes your packs folder if it didn't exist yet, so the watcher may need to start now.
      await this.controller.setupPacksFolderWatcher();
      return structuredClone(installed);
    });
    command('hydra.packs.reload', async () => { await this.controller.setupPacksFolderWatcher(); await this.controller.rolesChanged(); return true; });
    command('hydra.helperConnections', () => this.controller.helperConnections());
    command('hydra.connectHelpers', async (provider: ConnectableProvider) => ({ warning: await this.controller.connectHelpers(provider), connections: await this.controller.helperConnections() }));
    command('hydra.disconnectHelpers', async (provider: ConnectableProvider) => { await this.controller.disconnectHelpers(provider); return this.controller.helperConnections(); });
    command('hydra.installProviderExtension', async (provider: ConnectableProvider) => { await this.controller.installProviderExtension(provider); return this.controller.helperConnections(); });
    command('hydra.repairClaudeMem', () => this.controller.repairClaudeMem());
    command('hydra.helperWrittenEntries', () => this.controller.helperWrittenEntries());
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
      if (event.affectsConfiguration('hydra.packs.folder')) void this.controller.setupPacksFolderWatcher().catch(error => this.report(error));
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
      await this.controller.acquireOwnership();
    } catch (error) { this.disabled = true; this.report(error); }
    try {
      this.handoff = parseHandoff(vscode.workspace.getConfiguration('hydra').get('handoff'));
      if (this.handoff) { await this.verifyHandoffWorkspace(); await this.openAgents(); }
    } catch (error) { this.disabled = true; this.report(error); }
    await this.controller.startHelpers().catch(error => { this.output.appendLine(`[heads] not started: ${this.describe(error)}`); });
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
      otherReady: async provider => (await this.controller.helperConnections()).find(connection => connection.provider === provider)?.connected ?? false,
      continueWith: async (jobId, provider, markdown) => {
        if (!this.helpers) throw new Error('Hydra heads are still starting.');
        await this.helpers.service.continueWith(jobId, provider, markdown);
      },
      // O6: a plan job fails over on its own, unless turned off.
      autoContinuePlan: jobId => vscode.workspace.getConfiguration('hydra').get<boolean>('limits.autoContinuePlans', true) && !!this.controller.jobPlanFor(jobId),
      log: line => this.output.appendLine(line),
      tracker: this.limitOfferTracker,
    }));
    // Lanes (docs/internal/Gates_Plan.md, section 2): a lane's own tile banner, never a notification.
    this.context.subscriptions.push(this.limitEvents.event(event => { void this.lanes.onLimitEvent(event).catch(error => this.output.appendLine(`[lanes] limit offer: ${this.describe(error)}`)); }));
    await this.publish();
  }
  /** Chats in the official extensions: Claude's hook events and Codex's polled limits. Heads report through their service. */
  private startLimitDetection(): void {
    if (this.handoff || !vscode.workspace.isTrusted || vscode.env.remoteName) return;
    const fire = (event: LimitEvent) => this.limitEvents.fire(event);
    // Lanes (docs/internal/Gates_Plan.md, section 2): Claude's hook already tags its own lane's
    // events with HYDRA_LANE_ID; its worktree also counts as an owned folder like any
    // workspace folder. Codex has no per-session hook, so its account-limit event is
    // fanned out here to one lane event per running Codex lane.
    const claude = new ClaudeChatLimits(this.controller.limitEventsDirectory, providerPaths().claudeProjects, fire, () => this.lanes.laneWorktreeEntries());
    this.context.subscriptions.push(claude);
    void claude.start().catch(error => this.output.appendLine(`[limits] Claude chat limits not watched: ${this.describe(error)}`));
    const fireCodex = (event: LimitEvent) => {
      fire(event);
      for (const laneEvent of codexLaneFanout(event, this.lanes.runningLanes('codex'))) fire(laneEvent);
    };
    this.context.subscriptions.push(new CodexChatLimits(this.quota, async () =>
      this.settingsImport.available && vscode.workspace.isTrusted && !!vscode.extensions.getExtension('openai.chatgpt') && (await codexStatus(providerPaths().codexConfig, this.controller.helperServerSpec('codex'))).connected,
    fireCodex, line => this.output.appendLine(line)));
  }
  private helperExecutable(provider: Provider): Promise<string> { return this.controller.helperExecutable(provider); }
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
    const connections = await this.controller.helperConnections();
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
        try { await this.controller.connectHelpers(provider); done.push(name); }
        catch (error) { failed.push(`${name} (${this.describe(error)})`); this.output.appendLine(`[heads] first run: couldn't connect ${provider}: ${this.describe(error)}`); }
      }
    });
    this.onboarding.refreshConnections();
    if (failed.length) {
      const pick = await notices.warning(`Hydra couldn't connect ${failed.join(', ')}.${done.length ? ` ${done.join(' and ')} ${done.length === 1 ? 'is' : 'are'} connected.` : ''}`, 'Open Connectors');
      if (pick) await vscode.commands.executeCommand('hydra.openSettings', 'connectors');
    } else void notices.info(`${done.join(' and ')} ${done.length === 1 ? 'is' : 'are'} connected to Hydra: chat in ${done.length === 1 ? 'its extension' : 'their extensions'}, and they can start Hydra heads.`);
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
  private readonly auditSnapshots = new Map<string, string>();
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
  private async refresh(): Promise<void> { this.error = undefined; await this.controller.refreshRepositories(); await this.publish(); }
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
  private async publish(): Promise<void> { await this.controller.publish(); }
  /** The IDE's part of each snapshot, and the status bar that always changed with it. */
  private view(): Pick<Snapshot, 'mode' | 'busy' | 'error' | 'handoff' | 'officialExtensions'> {
    this.status.text = `$(layout) ${this.mode === 'agents' ? 'Agent Manager' : 'Editor'}${this.error ? ' $(warning)' : ''}`;
    this.status.tooltip = `Hydra: switch to the ${this.mode === 'agents' ? 'Editor' : 'Agent Manager'} (Alt+Shift+A)`;
    return { mode: this.mode, busy: this.busy || this.disabled, error: this.error, handoff: this.handoff, officialExtensions: ['claude', 'codex'].map(provider => officialExtensionInfo(provider as 'claude' | 'codex')) };
  }
  private plansChanged(): void { this.controller.plansChanged(); }
  private requirePlans(): { store: PlanStore; planning: Map<string, AbortController> } { return this.controller.requirePlans(); }

  /** hydra.learn: opens the "Work with Hydra" walkthrough (docs/internal/Lanes_And_Planner_Plan.md, "A walkthrough"). */
  private async openWalkthrough(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.openWalkthrough', `${this.context.extension.id}#hydra.workWithHydra`, false);
  }
  private newPlan(): Promise<void> { return this.controller.newPlan(); }
  private runPlanById(id: string): Promise<void> { return this.controller.runPlanById(id); }
  private requirePlanRunner(): PlanRunner { return this.controller.requirePlanRunner(); }
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
    await this.controller.stopHelpers().catch(error => this.report(error));
    await this.accounts.shutdown();
    await this.quota.shutdown();
    for (const controller of this.diagnosticChecks) controller.abort();
    await this.controller.releaseOwnership();
  }
}
