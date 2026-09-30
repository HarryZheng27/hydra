// The Hydra windows the benchmark opens (docs/Benchmark.md, "Closing the windows"): each Hydra run's window is closed
// with `hydra close` once its results are written, but only a window the harness opened itself (scripts/bench-open.ps1
// leaves a marker saying so), never one Nico already had open. Before a run, leftover benchmark windows (discovery
// records for folders under .bench) are closed the same way, or named loudly. Each window is 400 to 600 MB.
//
// The pure parts decide; closeOwnWindow and closeLeftovers take everything effectful as deps, so the tests drive them
// with fakes.
import fs from 'node:fs/promises';
import path from 'node:path';

/** What bench-open.ps1 writes into the folder's .git: whether a window already had the folder open, and the window it opened. */
export const markerName = 'hydra-bench-window.json';
export const markerFile = folder => path.join(folder, '.git', markerName);
/** The extension's global storage id (src/core/hydraCli.ts's extensionStorageId). */
const extensionStorageId = 'nico-dunlap.hydra-agent-manager';

const normalize = (value, platform = process.platform) => {
  const resolved = path.resolve(String(value)).replace(/[\\/]+$/, '');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
};
export const samePath = (a, b, platform = process.platform) => normalize(a, platform) === normalize(b, platform);
/** A folder inside a `.bench` folder (any depth), where the benchmark keeps its run folders. */
export const underBench = folder => String(folder).split(/[\\/]+/).some(part => part.toLowerCase() === '.bench');

/** Where Hydra's windows write their discovery records (helpersRootCandidates in src/core/hydraCli.ts, for the installed Hydra). */
export function windowsDirectory(env = process.env) {
  if (env.HYDRA_HELPERS_DIR) return path.join(env.HYDRA_HELPERS_DIR, 'windows');
  if (!env.APPDATA) return undefined;
  return path.join(env.APPDATA, 'Hydra', 'User', 'globalStorage', extensionStorageId, 'helpers', 'windows');
}

/**
 * How old a marker may be. The run's own window: its marker comes from the bench-open.ps1 that set up this run, so
 * it is written at most this long before the run started. A leftover's: at most this long before now. Anything older
 * is ignored, so a marker left behind can't close a window that opens on the folder later.
 */
export const ownMarkerMaxAgeMs = 12 * 60 * 60_000;
export const leftoverMarkerMaxAgeMs = 48 * 60 * 60_000;

/**
 * Whether to close the window that owns `folder` (pure). The marker bench-open.ps1 wrote must be for this folder,
 * written no earlier than `notBefore`, say no window had the folder before, and name the pid of the window it opened.
 * The window that owns the folder now must be the folder's own (not a parent folder's) and have exactly that pid. A
 * marker without a pid (the wait never saw the window) never closes anything. `status` is `hydra status --json`'s
 * answer, or undefined when no window owns the folder.
 */
export function closeDecision({ folder, marker, status, notBefore, now = Date.now(), platform = process.platform }) {
  if (!marker || typeof marker !== 'object') return { close: false, reason: 'the harness didn\'t open it (no marker from bench-open.ps1)' };
  if (marker.preexisting !== false) return { close: false, reason: 'a window already had this folder open before bench-open.ps1 ran' };
  if (typeof marker.folder !== 'string' || !samePath(marker.folder, folder, platform)) return { close: false, reason: 'its marker was written for another folder' };
  if (!Number.isInteger(marker.pid) || marker.pid <= 0) return { close: false, reason: 'its marker names no window (bench-open.ps1 never saw the window open)' };
  const at = typeof marker.at === 'string' ? Date.parse(marker.at) : NaN;
  if (!Number.isFinite(at) || at > now + 60_000 || (typeof notBefore === 'number' && at < notBefore)) return { close: false, reason: 'its marker is from an earlier run' };
  if (!status) return { close: false, reason: 'no Hydra window owns it now' };
  if (!status.repository || !samePath(status.repository, folder, platform)) return { close: false, reason: `the window that owns it is for ${status.repository ?? 'another folder'}` };
  if (status.window?.pid !== marker.pid) return { close: false, reason: `a different window (${status.window?.pid ?? 'unknown'}) owns it than the one bench-open.ps1 opened (${marker.pid})` };
  return { close: true };
}

/**
 * Whether a launcher is Hydra's bin/hydra built before `close` existed (pure): its dispatch doesn't list `close`, so
 * `hydra close` would open a window on a folder named "close" instead. Anything that isn't Hydra's launcher (the
 * bundled hydra-cli.cjs run directly, a test's stand-in) is fine.
 */
export function launcherLacksClose(text) {
  if (typeof text !== 'string' || !/:hydracli|HYDRA_CLI=/i.test(text)) return false;
  const dispatch = text.split(/\r?\n/).filter(line => /for %%C in \(|^\s*[a-z|]+\)\s*$/i.test(line));
  return !dispatch.some(line => /\bclose\b/.test(line));
}

/**
 * The launcher's own target, for when it predates `close` (pure): the app's executable beside its `bin` folder (the
 * name the launcher calls, `"%~dp0..\Hydra.exe"`) and the built-in extension's dist/hydra-cli.cjs, which a light
 * refresh of the extension's files updates without a desktop rebuild. brandedLauncherCmd (scripts/desktop.mjs) runs
 * exactly this, with ELECTRON_RUN_AS_NODE=1.
 */
export function directCliPaths(launcherFile, launcherText) {
  const install = path.dirname(path.dirname(launcherFile));
  const named = /%~dp0\.\.\\([^"\\]+\.exe)"/i.exec(launcherText ?? '')?.[1];
  return { exe: path.join(install, named ?? 'Hydra.exe'), script: path.join(install, 'resources', 'app', 'extensions', 'hydra-agent-manager', 'dist', 'hydra-cli.cjs') };
}
/** Whether `hydra --help` (the usage text) lists the close command (pure). */
export const helpListsClose = text => /^\s*close\b/m.test(String(text ?? ''));

/**
 * How the harness runs `hydra` for closing windows: the launcher, when it dispatches `close`; else, when the launcher
 * predates it, Hydra.exe running the installed hydra-cli.cjs directly, but only if that script's --help lists close;
 * else nothing (canClose false). `via` says which, and is logged. deps: launcherFile, launcherText, cliIn(cwd, ...argv),
 * run(command, argv, options), exists(file), log.
 */
export async function closeCli({ launcherFile, launcherText, cliIn, run, exists, log }) {
  if (!launcherLacksClose(launcherText)) return { cli: cliIn, canClose: true, via: 'the hydra command' };
  const { exe, script } = directCliPaths(launcherFile, launcherText);
  const env = { ELECTRON_RUN_AS_NODE: '1' };
  const direct = (cwd, ...argv) => run(exe, [script, ...argv], { cwd, env, shell: false, timeoutMs: 5 * 60_000 });
  if (exists(exe) && exists(script)) {
    const help = await direct(path.dirname(script), '--help').catch(() => undefined);
    if (help?.code === 0 && helpListsClose(help.stdout)) {
      log(`Closing windows with ${exe} ${script} (ELECTRON_RUN_AS_NODE=1): the hydra launcher predates \`hydra close\`, the installed hydra-cli.cjs has it.`);
      return { cli: direct, canClose: true, via: 'hydra-cli.cjs directly' };
    }
  }
  log('The hydra launcher and its hydra-cli.cjs both predate `hydra close`: the harness will close no windows.');
  return { cli: cliIn, canClose: false, via: 'none' };
}

/** The live benchmark windows among discovery records (pure apart from `alive`): a folder under .bench, its process alive. */
export function benchWindows(records, alive) {
  const windows = [];
  for (const record of records) {
    if (record?.version !== 2 || typeof record.pid !== 'number' || !Array.isArray(record.folders)) continue;
    const folder = record.folders.find(underBench);
    if (folder && alive(record.pid)) windows.push({ pid: record.pid, port: record.port, folder });
  }
  return windows;
}

export const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } };

export async function readMarker(folder) {
  try { return JSON.parse(await fs.readFile(markerFile(folder), 'utf8')); } catch { return undefined; }
}
export async function readWindowRecords(env = process.env) {
  const directory = windowsDirectory(env);
  if (!directory) return [];
  let names;
  try { names = (await fs.readdir(directory)).filter(name => name.endsWith('.json')); } catch { return []; }
  const records = [];
  for (const name of names) { try { records.push(JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'))); } catch { /* half-written or gone */ } }
  return records;
}

const parse = text => { try { return JSON.parse(text); } catch { return undefined; } };

/**
 * Closes the window that owns `folder` if the harness opened it (closeDecision), with `hydra close` run in the folder.
 * Never forces: a window still working refuses, and that is said loudly. deps: cli(folder, ...argv) → { code, stdout,
 * stderr }, readMarker, removeMarker, log, warn, and canClose (false when the launcher predates `hydra close`).
 */
export async function closeOwnWindow(folder, deps, { notBefore } = {}) {
  const marker = await deps.readMarker(folder);
  if (!marker) return { closed: false, reason: 'the harness didn\'t open it (no marker from bench-open.ps1)' };
  if (deps.canClose === false) {
    deps.warn(`Not closing the Hydra window for ${folder}: the installed hydra command predates \`hydra close\`, and so does its hydra-cli.cjs. Refresh Hydra's extension files, or close the window yourself.`);
    return { closed: false, reason: 'the hydra command has no close' };
  }
  const status = await deps.cli(folder, 'status', '--json');
  const decision = closeDecision({ folder, marker, status: status.code === 0 ? parse(status.stdout) : undefined, notBefore, now: (deps.now ?? Date.now)() });
  if (!decision.close) { deps.log(`Leaving the Hydra window for ${folder} open: ${decision.reason}.`); return { closed: false, reason: decision.reason }; }
  const closed = await deps.cli(folder, 'close', '--json', '--reason', 'benchmark run finished');
  if (closed.code !== 0) {
    const reason = (parse(closed.stdout)?.error ?? closed.stderr ?? '').trim() || `hydra close exited ${closed.code}`;
    deps.warn(`WARNING: the Hydra window for ${folder} didn't close: ${reason}`);
    return { closed: false, reason };
  }
  await deps.removeMarker(folder);
  deps.log(`Closed the Hydra window the harness opened for ${folder}${deps.via ? ` (via ${deps.via})` : ''}.`);
  return { closed: true };
}

/**
 * Before a run: the benchmark windows open besides this run's own. More than one open means leftovers from earlier
 * runs; each is closed when the harness opened it (closeOwnWindow), and any that stays open is named loudly.
 * deps: records() and alive, and closeOwnWindow's.
 */
export async function closeLeftovers(repo, deps) {
  const windows = benchWindows(await deps.records(), deps.alive ?? alive);
  if (windows.length <= 1) return { open: windows.length, closed: [], left: [] };
  const others = windows.filter(window => !samePath(window.folder, repo));
  const closed = [], left = [];
  for (const window of others) {
    const result = await closeOwnWindow(window.folder, deps, { notBefore: (deps.now ?? Date.now)() - leftoverMarkerMaxAgeMs });
    (result.closed ? closed : left).push({ ...window, ...(result.reason ? { reason: result.reason } : {}) });
  }
  if (left.length) {
    deps.warn([
      `WARNING: ${windows.length - closed.length} Hydra benchmark windows are open (about 400-600 MB each). These stayed open:`,
      ...left.map(window => `  ${window.folder} (window ${window.pid}): ${window.reason}`),
      'Close the ones you don\'t need before the run eats the memory.',
    ].join('\n'));
  }
  return { open: windows.length, closed, left };
}
