import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  checkIntervalMs, downloadVerified, helperEnvironment, latestRelease, nextAutoCheckDelay, runningNotice, updateEligibility, updateHelperFileContents,
  updateLauncherArguments, updateOffer, type FetchLike, type LatestRelease,
} from '../../../src/core/updateCheck';
import { JsonStore } from './settings';

/**
 * The app's in-app update (G6), the IDE's own (src/extensionUpdates.ts, src/core/updateCheck.ts) for the app's
 * installer: an installed stable app checks GitHub's latest full release 30 s after it starts and then once a day,
 * and offers Update / Release notes / Skip this version / Later. Update downloads HydraAppSetup.exe, checks it against
 * the release's SHA256SUMS-app, asks once more, then starts the hidden helper (through WMI) that waits for Hydra to
 * close, runs the installer in update mode and reopens Hydra. A preview or development copy never updates itself.
 * Nothing is downloaded or installed without those clicks.
 */

export const UPDATES_FILE = 'updates.json';
export interface UpdateState { version: 1; automatic: boolean; lastCheck?: number; skipped?: string }
export const defaultUpdateState = (): UpdateState => ({ version: 1, automatic: true });
export function parseUpdateState(raw: unknown): UpdateState | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || typeof value.automatic !== 'boolean' || !Object.keys(value).every(key => ['version', 'automatic', 'lastCheck', 'skipped'].includes(key))) return undefined;
  if (value.lastCheck !== undefined && (typeof value.lastCheck !== 'number' || !Number.isFinite(value.lastCheck))) return undefined;
  if (value.skipped !== undefined && (typeof value.skipped !== 'string' || !/^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(value.skipped))) return undefined;
  return { version: 1, automatic: value.automatic, ...(value.lastCheck !== undefined ? { lastCheck: value.lastCheck } : {}), ...(value.skipped !== undefined ? { skipped: value.skipped } : {}) };
}
export const createUpdateStore = (userData: string): JsonStore<UpdateState> => new JsonStore(path.join(userData, UPDATES_FILE), parseUpdateState, defaultUpdateState);

/** What the app's Settings shows. */
export interface UpdateStatus { available: boolean; reason?: string; automatic: boolean; busy: boolean; version: string }

export interface UpdateDialog { message: string; detail?: string; buttons: string[]; cancelId: number }
export interface AppUpdatesDeps {
  /** This app's version and its package's release channel (`hydraChannel`: "stable" or "preview"). */
  version: string;
  channel: string | undefined;
  packaged: boolean;
  execPath: string;
  platform?: string;
  exists?: (file: string) => boolean;
  store: JsonStore<UpdateState>;
  /** Where the verified installer and the helper go. */
  tempDir: string;
  fetch?: FetchLike;
  now?: () => number;
  /** A message box over the window; resolves with the index of the button clicked. */
  ask: (dialog: UpdateDialog) => Promise<number>;
  /** An information or error message, with no choices. */
  tell: (message: string, error?: boolean) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  /** Download progress for the window (0..1), or undefined when done. */
  progress: (fraction: number | undefined) => void;
  quit: () => void;
  /** Heads and lanes running in every project, and whether Stop all is on, for the confirm text (as the IDE's). */
  running?: () => Promise<{ heads: number; lanes: number; stopped: boolean }>;
  /** Starts the update helper; resolves once it runs. Tests replace it. */
  startHelper?: (helper: string) => Promise<void>;
  log: (line: string) => void;
}

const describe = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** The default helper start, as the IDE does it: a short hidden PowerShell asks WMI to start the helper outside the app's process tree. */
async function startHelperWithWmi(helper: string): Promise<void> {
  const systemRoot = process.env.SystemRoot || process.env.windir;
  const candidate = systemRoot ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
  const shell = existsSync(candidate) ? candidate : 'powershell.exe';
  const launcher = spawn(shell, updateLauncherArguments(shell, helper), { stdio: 'ignore', windowsHide: true, env: helperEnvironment(process.env) });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { launcher.kill(); reject(new Error('the update helper took too long to start')); }, 30_000);
    launcher.once('error', error => { clearTimeout(timer); reject(error); });
    launcher.once('exit', exitCode => { clearTimeout(timer); resolve(exitCode); });
  });
  if (code !== 0) throw new Error(`the update helper didn't start (launcher exit ${code})`);
}

export class AppUpdates {
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  /** The download in progress, which quitting abandons. */
  private download: AbortController | undefined;

  constructor(private readonly deps: AppUpdatesDeps) {}

  private eligibility() {
    return updateEligibility({
      platform: this.deps.platform ?? process.platform, production: this.deps.packaged, execPath: this.deps.execPath,
      exists: this.deps.exists ?? existsSync, product: 'app', channel: this.deps.channel,
    });
  }

  async status(): Promise<UpdateStatus> {
    const eligible = this.eligibility(), state = await this.deps.store.load();
    return { available: eligible.eligible, ...(eligible.eligible ? {} : { reason: eligible.reason }), automatic: state.automatic, busy: this.busy, version: this.deps.version };
  }

  async setAutomatic(on: boolean): Promise<UpdateStatus> {
    await this.deps.store.update(state => ({ ...state, automatic: on }));
    return this.status();
  }

  /** Checks now. A manual check always answers; an automatic one only offers a newer, unskipped version. */
  async check(manual: boolean): Promise<void> {
    const eligible = this.eligibility();
    if (!eligible.eligible) {
      this.deps.log(`[updates] not checking: ${eligible.reason}`);
      if (manual) await this.deps.tell(eligible.reason);
      return;
    }
    if (this.busy) { if (manual) await this.deps.tell('Hydra is already checking for updates.'); return; }
    this.busy = true;
    try {
      const now = (this.deps.now ?? Date.now)();
      await this.deps.store.update(state => ({ ...state, lastCheck: now })).catch(() => undefined);
      const result = await latestRelease(this.deps.fetch ?? fetch, { userAgent: `Hydra-App/${this.deps.version}`, product: 'app' });
      if (!result.release) {
        this.deps.log(`[updates] check failed: ${result.reason}`);
        if (manual) await this.deps.tell(`Hydra couldn't check for updates: ${result.reason}.`, true);
        return;
      }
      const offer = updateOffer(result.release.version, this.deps.version, (await this.deps.store.load()).skipped, manual);
      this.deps.log(`[updates] latest ${result.release.tag}, this is ${this.deps.version}: ${offer.kind}`);
      if (offer.kind === 'offer') await this.prompt(result.release, offer.message, eligible.installDir);
      else if (manual && offer.kind !== 'skipped') await this.deps.tell(offer.message);
    } finally { this.busy = false; }
  }

  private async prompt(release: LatestRelease, message: string, installDir: string): Promise<void> {
    const pick = await this.deps.ask({ message, buttons: ['Update', 'Release notes', 'Skip this version', 'Later'], cancelId: 3 });
    if (pick === 1) { await this.deps.openExternal(release.notesUrl); return; }
    if (pick === 2) { await this.deps.store.update(state => ({ ...state, skipped: release.version })); this.deps.log(`[updates] skipped ${release.version}`); return; }
    if (pick === 0) await this.update(release, installDir);
  }

  private async update(release: LatestRelease, installDir: string): Promise<void> {
    const dir = path.join(this.deps.tempDir, 'hydra-app-update');
    let file: string;
    const controller = new AbortController();
    this.download = controller;
    try {
      const result = await downloadVerified(release, dir, {
        product: 'app', signal: controller.signal, ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
        onProgress: (received, total) => { if (total) this.deps.progress(received / total); },
      });
      file = result.file;
      this.deps.log(`[updates] ${result.reused ? 'reused' : 'downloaded'} ${result.file} (sha256 ${result.sha256}, matches SHA256SUMS-app)`);
    } catch (error) {
      this.deps.log(`[updates] ${describe(error)}`);
      if (!controller.signal.aborted) await this.deps.tell(describe(error), true);
      return;
    } finally { this.download = undefined; this.deps.progress(undefined); }

    const counts = await this.deps.running?.().catch(() => undefined);

    const confirm = await this.deps.ask({
      message: `Install Hydra ${release.version}?`,
      detail: ['Hydra will close, install the update, and reopen. Your chats are saved.', counts ? runningNotice(counts.heads, counts.lanes, counts.stopped) : ''].filter(Boolean).join('\n\n'),
      buttons: ['Install and restart', 'Not now'], cancelId: 1,
    });
    if (confirm !== 0) { this.deps.log('[updates] install not confirmed; the verified installer stays for next time'); return; }
    try {
      const helper = path.join(this.deps.tempDir, `hydra-app-update-${release.version}.ps1`);
      await mkdir(path.dirname(helper), { recursive: true });
      await writeFile(helper, updateHelperFileContents({ installer: file, installDir, exe: this.deps.execPath, log: path.join(this.deps.tempDir, 'hydra-app-update.log'), product: 'app' }));
      await (this.deps.startHelper ?? startHelperWithWmi)(helper);
      this.deps.log(`[updates] started the update helper (${helper}); quitting so it can install ${release.version}`);
    } catch (error) {
      this.deps.log(`[updates] helper didn't start: ${describe(error)}`);
      await this.deps.tell(`Hydra couldn't start the update: ${describe(error)}`, true);
      return;
    }
    this.deps.quit();
  }

  /** Automatic checks: 30 s after start, then a day after the last one, while the setting is on. */
  start(): void {
    if (!this.eligibility().eligible) return;
    void this.schedule();
  }

  private async schedule(): Promise<void> {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const state = await this.deps.store.load().catch(() => defaultUpdateState());
    if (this.stopped) return;
    const now = (this.deps.now ?? Date.now)();
    this.timer = setTimeout(() => {
      void this.deps.store.load().then(current => {
        const later = (this.deps.now ?? Date.now)();
        const due = typeof current.lastCheck !== 'number' || current.lastCheck > later || later - current.lastCheck >= checkIntervalMs - 60_000;
        return due && current.automatic ? this.check(false) : undefined;
      }).catch(error => this.deps.log(`[updates] ${describe(error)}`)).finally(() => { void this.schedule(); });
    }, nextAutoCheckDelay(state.lastCheck, now));
    this.timer.unref?.();
  }

  /** On quit: no more checks, and a download in progress is abandoned (its partial file is removed). */
  stop(): void { this.stopped = true; clearTimeout(this.timer); this.download?.abort(new Error('Hydra is quitting')); }
}
