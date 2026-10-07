import * as vscode from 'vscode';
import { machineSetting } from './core/machineSetting';
import { notices } from './notices';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { git, repositoryRoot } from './core/worktrees';
import { AppearanceSettings } from './extensionSettings';
import { SettingsImport } from './extensionImport';
import { Onboarding } from './extensionOnboarding';
import { ProviderAccounts } from './extensionAccounts';
import { ProviderQuota } from './extensionQuota';
import { findProvider } from './core/providers';
import { finalJobStates } from './core/jobs';
// ---- Step D: a read-only view across projects ----
import { HeadSandbox } from './core/headSandbox';
import type { LimitEvent } from './core/limitEvents';
import { createRedactor } from './core/redact';
import { checkProvider } from './core/diagnostics';
import { settingsRequiringRefresh } from './core/settingsRefresh';
import { parseHandoff, officialProviders } from './core/handoff';
import { officialExtensionInfo, openOfficialExtension } from './extensionBridge';
import { registerChatLocationController, setChatLocation } from './chatLocationController';
import { LimitOfferTracker } from './core/limitOffer';
import { LanesController } from './host/lanes';
import { HydraTreeProvider } from './extensionTree';
// ---- Packs (docs/internal/Packs_Plan.md). Its own block. ----
import { createPackService } from './host/packs';
import type { PackService } from './core/packs/service';
import { type ClientMessage, type Provider, type ProviderDiagnostic, type Snapshot, type Handoff, type HandoffTask } from './core/model';
// ---- Planner (docs/internal/Lanes_And_Planner_Plan.md, section 4). Its own block; Phase 1 (Lanes) wires its own imports separately. ----
// ---- Plan lanes (docs/internal/Plan_Lanes_Plan.md). Their own block. ----
// ---- Gates (docs/internal/Gates_Plan.md). Their own block. ----
import { otherStillLimited } from './core/limitOffer';
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
  /** Needs_You_Plan.md, Phase 5: how many decisions wait on the user, for the status bar item. */
  private needsYouCount = 0;
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
    this.packs = createPackService(this.host, line => this.output.appendLine(line), event => this.audit.record(event));
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
      storageDirectory: this.storageDirectory, leadKey: this.leadKey, quota: this.quota.service, limitOfferTracker: this.limitOfferTracker,
      ide: {
        view: () => this.view(),
        handle: message => this.handleIde(message),
        uiReady: () => { this.readyPanel = this.panel; },
        agentsOpen: () => !!this.panel,
        showingAgents: () => this.mode === 'agents',
        openAgents: () => this.openAgents(),
        tree: update => this.tree.update(update),
        inHandoff: () => !!this.handoff,
        needsYouChanged: count => { this.needsYouCount = count; this.updateStatusText(); },
        refreshSettingsPages: async pages => { await this.settings.refreshPages(pages); },
        showSettings: page => this.settings.show(page),
        accounts: () => this.accounts.snapshot(),
        connectionsChanged: () => this.onboarding.refreshConnections(),
        desktop: () => this.settingsImport.available,
        openOfficial: provider => openOfficialExtension(provider),
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
    // ---- Audit log (5.2) ----
    command('hydra.openAuditLog', () => this.openAuditLog());
    this.controller.registerCommands(command);
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
      return this.controller.openEvidence(kind, id);
    });
    // ---- The Hydra panel (docs/internal/Lanes_And_Planner_Plan.md, section 3) ----
    this.context.subscriptions.push(vscode.window.createTreeView('hydra.overview', { treeDataProvider: this.tree }));
    // ---- Step D: a read-only view across projects ----
    command('hydra.showAllProjects', () => this.controller.showAllProjects());
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
    this.controller.startLimitDetection();
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
    this.controller.startLimitOffer();
    await this.publish();
  }
  private helperExecutable(provider: Provider): Promise<string> { return this.controller.helperExecutable(provider); }
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
  /** The mode item: "Agent Manager" or "Editor", with how many things need the user when any do. */
  private updateStatusText(): void {
    const waiting = this.needsYouCount > 0 ? ` · ${this.needsYouCount} need${this.needsYouCount === 1 ? 's' : ''} you` : '';
    this.status.text = `$(layout) ${this.mode === 'agents' ? 'Agent Manager' : 'Editor'}${waiting}${this.error ? ' $(warning)' : ''}`;
    this.status.tooltip = `Hydra: switch to the ${this.mode === 'agents' ? 'Editor' : 'Agent Manager'} (Alt+Shift+A)${this.needsYouCount > 0 ? `
${this.needsYouCount} waiting on you: open the Agent Manager's Needs you tab.` : ''}`;
  }
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
    this.updateStatusText();
    return { mode: this.mode, busy: this.busy || this.disabled, error: this.error, handoff: this.handoff, officialExtensions: ['claude', 'codex'].map(provider => officialExtensionInfo(provider as 'claude' | 'codex')) };
  }

  /** hydra.learn: opens the "Work with Hydra" walkthrough (docs/internal/Lanes_And_Planner_Plan.md, "A walkthrough"). */
  private async openWalkthrough(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.openWalkthrough', `${this.context.extension.id}#hydra.workWithHydra`, false);
  }
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
