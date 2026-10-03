import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AuditLog } from '../../../src/core/audit';
import { replaceAtomic } from '../../../src/core/atomicFile';
import { HeadSandbox } from '../../../src/core/headSandbox';
import { LimitOfferTracker, otherStillLimited } from '../../../src/core/limitOffer';
import { findProvider } from '../../../src/core/providers';
import { StopSwitch } from '../../../src/core/stopSwitch';
import { HydraController, type ControllerIde } from '../../../src/host/controller';
import type { Disposable, HostPaths, NoticeLevel } from '../../../src/host/host';
import { LanesController } from '../../../src/host/lanes';
import { createPackService } from '../../../src/host/packs';
import { QuotaService } from '../../../src/host/quota';
import type { Project } from '../shared/ipc';
import { ElectronHost, folderKey, type ValueStore } from './host';

/**
 * Hydra in the app (docs/internal/hydra-app/G5-orchestration.md, milestone 1): one controller per trusted project,
 * built as the IDE builds one per window (src/extension.ts's Manager), over the IDE's own storage. Each owns its
 * project's repository while the app runs, so the IDE refuses it and the app refuses one the IDE owns; each has its
 * own endpoint and discovery record, so `hydra` and a chat's bridge find it by folder.
 */

/** A JSON object of small values, read once and written whole (atomically) after each change. */
export class JsonValues implements ValueStore {
  private values: Record<string, unknown> = {};
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(key: string) => void>();
  constructor(private readonly file: string) {}
  async load(): Promise<this> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) this.values = parsed as Record<string, unknown>;
    } catch { /* missing or unreadable: start empty */ }
    return this;
  }
  get<T>(key: string, fallback: T): T { return Object.prototype.hasOwnProperty.call(this.values, key) && this.values[key] !== undefined ? structuredClone(this.values[key]) as T : fallback; }
  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) delete this.values[key]; else this.values[key] = structuredClone(value);
    for (const listener of this.listeners) listener(key);
    const text = JSON.stringify(this.values, null, 2);
    const write = this.queue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await (await import('node:fs/promises')).writeFile(temporary, text, 'utf8');
      await replaceAtomic(temporary, this.file);
    });
    this.queue = write.catch(() => undefined);
    return write;
  }
  onChange(listener: (key: string) => void): Disposable { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }
  flush(): Promise<unknown> { return this.queue; }
}

export interface HydraProjectsOptions {
  /** The IDE's global storage (host.ts ideStorageRoot). */
  storage: string;
  /** The app's bundles (`hydra-mcp.cjs`, `hydra-cli.cjs`, `hydra-limit-hook.cjs`), node-pty's root, and the built-in packs. */
  dist: string;
  appRoot: string;
  extension: string;
  /** The app's own folder for Hydra's settings and per-project state. */
  userData: string;
  version: string;
  development: boolean;
  cliPath: (provider: 'claude' | 'codex') => Promise<string | undefined>;
  log: (line: string) => void;
  notice?: (project: Project, level: NoticeLevel, message: string) => void;
  openConsole?: (title: string, executable: string, args: string[], cwd: string) => Promise<{ started: boolean; error?: string }>;
  post?: (project: Project, message: unknown) => void;
}

interface Running { project: Project; host: ElectronHost; controller: HydraController; lanes: LanesController; quota: QuotaService; state: JsonValues }

export interface ProjectHydraStatus { id: string; running: boolean; owned: boolean; error?: string }

export class HydraProjects {
  private readonly running = new Map<string, Running>();
  private readonly starting = new Map<string, Promise<void>>();
  private readonly errors = new Map<string, string>();
  private settings?: JsonValues;
  private globalState?: JsonValues;
  private audit?: AuditLog;
  private closing = false;
  constructor(private readonly options: HydraProjectsOptions) {}

  private async shared(): Promise<{ settings: JsonValues; globalState: JsonValues; audit: AuditLog }> {
    this.settings ??= await new JsonValues(path.join(this.options.userData, 'hydra', 'settings.json')).load();
    this.globalState ??= await new JsonValues(path.join(this.options.userData, 'hydra', 'global-state.json')).load();
    // One audit log in Hydra's storage, as each IDE window writes (5.2).
    this.audit ??= new AuditLog({ file: path.join(this.options.storage, 'audit', 'audit.jsonl') });
    return { settings: this.settings, globalState: this.globalState, audit: this.audit };
  }

  /** Starts a controller for each trusted project not yet running, and stops those whose project is gone or untrusted. */
  async sync(projects: Project[]): Promise<void> {
    const wanted = new Map(projects.filter(project => project.trustedAt).map(project => [project.id, project]));
    for (const id of [...this.running.keys()]) if (!wanted.has(id)) await this.stop(id);
    await Promise.all([...wanted.values()].map(project => this.start(project)));
  }

  status(): ProjectHydraStatus[] {
    const ids = new Set([...this.running.keys(), ...this.errors.keys()]);
    return [...ids].map(id => {
      const running = this.running.get(id);
      const error = this.errors.get(id);
      return { id, running: !!running, owned: !!running && !running.controller.disabled, ...(error ? { error } : {}) };
    });
  }
  controller(id: string): HydraController | undefined { return this.running.get(id)?.controller; }

  start(project: Project): Promise<void> {
    if (this.closing || this.running.has(project.id)) return Promise.resolve();
    let pending = this.starting.get(project.id);
    if (!pending) {
      pending = this.boot(project).catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        this.errors.set(project.id, message);
        this.options.log(`[hydra] ${project.name}: not started: ${message}`);
      }).finally(() => this.starting.delete(project.id));
      this.starting.set(project.id, pending);
    }
    return pending;
  }

  private async boot(project: Project): Promise<void> {
    const { storage, dist, appRoot, extension } = this.options;
    await mkdir(storage, { recursive: true });
    const { settings, globalState, audit } = await this.shared();
    const key = folderKey(project.path);
    const storageDirectory = path.join(storage, 'workspaces', key);
    const state = await new JsonValues(path.join(this.options.userData, 'hydra', 'projects', `${key}.json`)).load();
    const paths: HostPaths = { storage, dist, appRoot, extension };
    const log = (line: string) => this.options.log(`[${project.name}] ${line}`);
    const cliPaths: Partial<Record<'claude' | 'codex', string>> = {};
    for (const provider of ['claude', 'codex'] as const) { const configured = await this.options.cliPath(provider); if (configured) cliPaths[provider] = configured; }
    const host = new ElectronHost({
      folder: project.path, paths, settings, state, globalState,
      machine: name => (name === 'claudePath' ? cliPaths.claude : name === 'codexPath' ? cliPaths.codex : undefined),
      trusted: () => !!project.trustedAt, log, version: this.options.version, development: this.options.development,
      post: message => this.options.post?.(project, message),
      notice: (level, message) => this.options.notice?.(project, level, message),
      ...(this.options.openConsole ? { openConsole: this.options.openConsole } : {}),
    });
    const stop = new StopSwitch(host.state);
    const record = (event: Parameters<AuditLog['record']>[0]) => audit.record(event);
    const packs = createPackService(host, log, record);
    const headSandbox = new HeadSandbox({
      // Short paths (Windows' 260-character limit), per project as the IDE keeps them per window.
      folder: path.join(storage, 'sb', key),
      codex: async () => (await findProvider('codex', cliPaths.codex)).executable,
      log, audit: record,
    });
    const quota = new QuotaService(host, true);
    const tracker = new LimitOfferTracker();
    let controller!: HydraController;
    // Lanes (milestone 4 shows them); their service runs now so plans and discovery see the same lanes the IDE would.
    const lanes = new LanesController({
      platform: host, log, post: message => { void host.postToUi(message); },
      openAgents: async () => undefined, toEditor: async () => undefined, webviewReady: () => false,
      helperServerSpec: provider => controller.helperServerSpec(provider), runningHeads: id => controller.laneHeads(id),
      changed: () => controller.laneFoldersChanged(),
      gatesExecutable: provider => controller.helperExecutable(provider),
      gatesLimited: provider => otherStillLimited(controller.latestLimits.get(provider), new Date()),
      planJob: laneId => controller.planJobOfLane(laneId),
      markJobDone: (laneId, result) => controller.markPlanJobDone(laneId, result),
      cancelPlanJob: laneId => controller.cancelPlanJobOfLane(laneId),
      planLaneMergeRefusal: laneId => controller.planLaneMergeRefusal(laneId),
      planRunner: () => controller.planRunner,
      gates: packs.gates, roles: packs,
      hydraStorage: storage, stop, audit: record,
      offerStarterGates: folder => void controller.offerStarterGatesIfNeeded(folder),
      openEvidence: async laneId => { await controller.openEvidence('lane', laneId); },
    }, tracker);
    const ide: ControllerIde = {
      view: () => ({ mode: 'agents', busy: false }),
      handle: async () => undefined,
      uiReady: () => undefined,
      agentsOpen: () => false,
      showingAgents: () => false,
      openAgents: async () => undefined,
      tree: () => undefined,
      inHandoff: () => false,
      refreshSettingsPages: async () => undefined,
      showSettings: () => undefined,
      accounts: () => ({ claude: { status: 'unchecked' }, codex: { status: 'unchecked' } }),
      connectionsChanged: () => undefined,
      desktop: () => !this.options.development,
      openOfficial: async () => undefined,
      report: error => { const message = error instanceof Error ? error.message : String(error); log(`[error] ${message}`); this.options.notice?.(project, 'error', message); },
    };
    controller = new HydraController({ host, ide, lanes, stop, audit, packs, headSandbox, storageDirectory, leadKey: key, quota, limitOfferTracker: tracker });
    await controller.start();
    if (controller.disabled) {
      // Another Hydra (the IDE, say) owns this repository: nothing runs here for it.
      this.errors.set(project.id, `Hydra in another window already manages ${project.name}.`);
    } else this.errors.delete(project.id);
    if (this.closing) { await controller.shutdown().catch(() => undefined); host.dispose(); return; }
    this.running.set(project.id, { project, host, controller, lanes, quota, state });
  }

  async stop(id: string): Promise<void> {
    await this.starting.get(id);
    const running = this.running.get(id);
    this.errors.delete(id);
    if (!running) return;
    this.running.delete(id);
    await running.controller.shutdown().catch(error => this.options.log(`[hydra] ${running.project.name}: shutdown: ${error instanceof Error ? error.message : String(error)}`));
    await running.quota.shutdown().catch(() => undefined);
    running.lanes.dispose();
    running.host.dispose();
    await running.state.flush();
  }

  /** Every project's controller stops: heads, lanes and plans end, discovery records go, ownership is released. */
  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.starting.values()]);
    await Promise.all([...this.running.keys()].map(id => this.stop(id)));
    await Promise.all([this.settings?.flush(), this.globalState?.flush(), this.audit?.flush()]);
  }
}
