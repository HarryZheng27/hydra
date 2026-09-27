import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  checkIntervalMs, downloadVerified, latestRelease, nextAutoCheckDelay, runningNotice, updateEligibility, updateHelperFileContents, updateOffer, type LatestRelease,
} from './core/updateCheck';

/**
 * The in-app update prompt (README, "Updating"). An installed Hydra on Windows checks
 * GitHub's latest release 30 s after startup and then once a day, and offers
 * Update / Release notes / Skip this version. Update downloads HydraSetup.exe, checks it
 * against SHA256SUMS, asks once more, then starts a detached PowerShell helper that waits
 * for Hydra to close, runs the installer silently and reopens Hydra. Nothing is downloaded
 * or installed without those clicks. The logic lives in src/core/updateCheck.ts.
 */
export interface UpdateDeps {
  context: vscode.ExtensionContext;
  log: (line: string) => void;
  /** Heads and lanes running in this window, and whether Stop All Agents is on, for the confirm text. */
  running: () => { heads: number; lanes: number; stopped: boolean };
}

const lastCheckKey = 'hydra.updates.lastCheck';
const skippedKey = 'hydra.updates.skipped';
const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

export function registerUpdates(deps: UpdateDeps): vscode.Disposable {
  const { context, log } = deps;
  const current = String(context.extension.packageJSON?.version ?? '');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let disposed = false;

  const eligibility = () => updateEligibility({
    platform: process.platform, production: context.extensionMode === vscode.ExtensionMode.Production,
    execPath: process.execPath, exists: existsSync, testRun: !!process.env.HYDRA_TEST_REPOSITORY,
  });

  async function check(manual: boolean): Promise<void> {
    const eligible = eligibility();
    if (!eligible.eligible) {
      log(`[updates] not checking: ${eligible.reason}`);
      if (manual) void vscode.window.showInformationMessage(eligible.reason);
      return;
    }
    if (busy) { if (manual) void vscode.window.showInformationMessage('Hydra is already checking for updates.'); return; }
    busy = true;
    try {
      await context.globalState.update(lastCheckKey, Date.now());
      const result = await latestRelease(fetch, { userAgent: `Hydra/${current}` });
      if (!result.release) {
        log(`[updates] check failed: ${result.reason}`);
        if (manual) void vscode.window.showErrorMessage(`Hydra couldn't check for updates: ${result.reason}.`);
        return;
      }
      const offer = updateOffer(result.release.version, current, context.globalState.get<string>(skippedKey), manual);
      log(`[updates] latest ${result.release.tag}, this is ${current}: ${offer.kind}`);
      if (offer.kind === 'offer') void prompt(result.release, offer.message);
      else if (manual && offer.kind !== 'skipped') void vscode.window.showInformationMessage(offer.message);
    } finally { busy = false; }
  }

  async function prompt(release: LatestRelease, message: string): Promise<void> {
    const pick = await vscode.window.showInformationMessage(message, 'Update', 'Release notes', 'Skip this version');
    if (pick === 'Release notes') { await vscode.env.openExternal(vscode.Uri.parse(release.notesUrl)); return; }
    if (pick === 'Skip this version') { await context.globalState.update(skippedKey, release.version); log(`[updates] skipped ${release.version}`); return; }
    if (pick === 'Update') await update(release);
  }

  async function update(release: LatestRelease): Promise<void> {
    const eligible = eligibility();
    if (!eligible.eligible) { void vscode.window.showInformationMessage(eligible.reason); return; }
    const dir = path.join(os.tmpdir(), 'hydra-update');
    let file: string;
    let cancelled = false;
    try {
      file = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Downloading Hydra ${release.version}…`, cancellable: true }, async (progress, token) => {
        const controller = new AbortController();
        const cancel = token.onCancellationRequested(() => { cancelled = true; controller.abort(new Error('cancelled')); });
        let reported = 0;
        try {
          const result = await downloadVerified(release, dir, {
            signal: controller.signal,
            onProgress: (received, total) => {
              if (!total) return;
              const percent = Math.floor(received / total * 100);
              if (percent > reported) { progress.report({ increment: percent - reported, message: `${Math.round(received / 1048576)} of ${Math.round(total / 1048576)} MB` }); reported = percent; }
            },
          });
          log(`[updates] ${result.reused ? 'reused' : 'downloaded'} ${result.file} (sha256 ${result.sha256}, matches SHA256SUMS)`);
          return result.file;
        } finally { cancel.dispose(); }
      });
    } catch (error) {
      log(`[updates] ${describe(error)}`);
      if (cancelled) return;
      void vscode.window.showErrorMessage(describe(error));
      return;
    }

    const counts = deps.running();
    const detail = [`Hydra will close, install ${release.version}, and reopen. Unsaved changes are kept by the editor's hot exit.`, runningNotice(counts.heads, counts.lanes, counts.stopped)].filter(Boolean).join('\n\n');
    const confirm = await vscode.window.showWarningMessage(`Install Hydra ${release.version}?`, { modal: true, detail }, 'Install and restart');
    if (confirm !== 'Install and restart') { log('[updates] install not confirmed; the verified installer stays for next time'); return; }

    try {
      const helper = path.join(os.tmpdir(), `hydra-update-${release.version}.ps1`);
      await mkdir(path.dirname(helper), { recursive: true });
      await writeFile(helper, updateHelperFileContents({ installer: file, installDir: eligible.installDir, exe: process.execPath, log: path.join(os.tmpdir(), 'hydra-update.log') }));
      const systemRoot = process.env.SystemRoot || process.env.windir;
      const powershell = systemRoot ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
      const child = spawn(existsSync(powershell) ? powershell : 'powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', helper], { detached: true, stdio: 'ignore', windowsHide: true });
      await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject); });
      child.unref();
      log(`[updates] started the update helper (${helper}); quitting so it can install ${release.version}`);
    } catch (error) {
      log(`[updates] helper didn't start: ${describe(error)}`);
      void vscode.window.showErrorMessage(`Hydra couldn't start the update: ${describe(error)}`);
      return;
    }
    await vscode.commands.executeCommand('workbench.action.quit');
  }

  function schedule(): void {
    if (disposed) return;
    clearTimeout(timer);
    const delay = nextAutoCheckDelay(context.globalState.get<number>(lastCheckKey), Date.now());
    timer = setTimeout(() => {
      // Another window may have checked meanwhile: re-read the shared time before asking GitHub.
      const last = context.globalState.get<number>(lastCheckKey), now = Date.now();
      const due = typeof last !== 'number' || last > now || now - last >= checkIntervalMs - 60_000;
      const enabled = vscode.workspace.getConfiguration('hydra').get<boolean>('updates.check', true);
      const run = due && enabled ? check(false) : Promise.resolve();
      void run.catch(error => log(`[updates] ${describe(error)}`)).finally(schedule);
    }, delay);
  }

  const command = vscode.commands.registerCommand('hydra.checkForUpdates', () => check(true).catch(error => {
    log(`[updates] ${describe(error)}`);
    void vscode.window.showErrorMessage(`Hydra couldn't check for updates: ${describe(error)}`);
  }));
  const eligible = eligibility();
  if (eligible.eligible) schedule(); else log(`[updates] automatic checks off: ${eligible.reason}`);
  return new vscode.Disposable(() => { disposed = true; clearTimeout(timer); command.dispose(); });
}
