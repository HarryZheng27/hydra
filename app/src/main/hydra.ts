import { randomBytes } from 'node:crypto';
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
 * built as the IDE builds one per window (src/extension.ts's Manager), over the IDE's own storage. A project's
 * controller starts when the user opens it (a chat there), as the IDE's starts when a window opens a folder, and runs
 * until the project is removed or the app quits. It owns the project's repository meanwhile, so the IDE refuses it
 * and the app refuses one the IDE owns (a refused project is tried again the next time it is opened); each has its
 * own endpoint and discovery record, so `hydra` and a chat's bridge find it by folder. One process runs every
 * project's heads, so each project refuses every project's heads as leads (`otherHeads`).
 */

/** A JSON object of small values, read once and written whole (atomically) after each change. */
export class JsonValues implements ValueStore {
  private values: Record<string, unknown> = {};
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(key: string) => void>();
  constructor(private readonly file: string) {}
  async load(): Promise<this> {
    let text: string;
    try { text = await readFile(this.file, 'utf8'); } catch (error) {
      // Only a missing file starts empty: one that can't be read now (antivirus, a lock) must not be overwritten.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this;
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) this.values = parsed as Record<string, unknown>;
    } catch { throw new Error(`${path.basename(this.file)} isn't valid JSON; Hydra won't overwrite it.`); }
    return this;
  }
  get<T>(key: string, fallback: T): T { return Object.prototype.hasOwnProperty.call(this.values, key) && this.values[key] !== undefined ? structuredClone(this.values[key]) as T : fallback; }
  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) delete this.values[key]; else this.values[key] = structuredClone(value);
    for (const listener of this.listeners) listener(key);
    const text = JSON.stringify(this.values, null, 2);
    const write = this.queue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
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
  /** The trusted projects as they are now (sync), so a controller checks trust and removal against the latest. */
  private latest = new Map<string, Project>();
  constructor(private readonly options: HydraProjectsOptions) {}

  private async shared(): Promise<{ settings: JsonValues; globalState: JsonValues; audit: AuditLog }> {
    this.settings ??= await new JsonValues(path.join(this.options.userData, 'hydra', 'settings.json')).load();
    this.globalState ??= await new JsonValues(path.join(this.options.userData, 'hydra', 'global-state.json')).load();
    // One audit log in Hydra's storage, as each IDE window writes (5.2).
    this.audit ??= new AuditLog({ file: path.join(this.options.storage, 'audit', 'audit.jsonl') });
    return { settings: this.settings, globalState: this.globalState, audit: this.audit };
  }

  /** The projects as they are now: a removed or untrusted project's controller stops (or, still starting, never runs). */
  async sync(projects: Project[]): Promise<void> {
    this.latest = new Map(projects.filter(project => project.trustedAt).map(project => [project.id, project]));
    const ids = new Set([...this.running.keys(), ...this.starting.keys()]);
    await Promise.all([...ids].filter(id => !this.latest.has(id)).map(id => this.stop(id)));
  }

  /** The user opened a project (a chat in it): its controller starts if it isn't running, or tries again if refused. */
  open(project: Project): Promise<void> {
    if (!project.trustedAt) return Promise.resolve();
    this.latest.set(project.id, project);
    return this.start(project);
  }

  /** Every running project's heads' processes but this one's, refused as its leads too. */
  headsOutside(id: string): number[] {
    return [...this.running.values()].filter(running => running.project.id !== id).flatMap(running => [...running.controller.helperProcessIds()]);
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
    if (this.closing) return Promise.resolve();
    const current = this.running.get(project.id);
    if (current && !current.controller.disabled) return Promise.resolve();
    // Refused before (another Hydra owned it): try again now.
    if (current) return this.stop(project.id).then(() => this.start(project));
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
      trusted: () => !!this.latest.get(project.id)?.trustedAt, log, version: this.options.version, development: this.options.development,
      // `hydra close` in this project: its controller stops, as the IDE's window closes.
      closeWindow: () => { void this.stop(project.id); },
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
    controller = new HydraController({ host, ide, lanes, stop, audit, packs, headSandbox, storageDirectory, leadKey: key, quota, limitOfferTracker: tracker, otherHeads: () => this.headsOutside(project.id) });
    await controller.start();
    if (controller.disabled) {
      // Another Hydra (the IDE, say) owns this repository: nothing runs here for it.
      this.errors.set(project.id, `Hydra in another window already manages ${project.name}.`);
    } else this.errors.delete(project.id);
    // Quit began, or the project was removed or untrusted while this started: nothing of it stays.
    if (this.closing || !this.latest.get(project.id)?.trustedAt) { await controller.shutdown().catch(() => undefined); await quota.shutdown().catch(() => undefined); quota.dispose(); lanes.dispose(); host.dispose(); return; }
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
    running.quota.dispose();
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
