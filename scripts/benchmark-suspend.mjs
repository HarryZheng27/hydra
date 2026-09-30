// Benchmark runs that spanned a machine sleep are garbage: wall time counts the sleep as work, and a timer can stall
// for hours. This module notices (a heartbeat comparing wall-clock gaps, then the Windows event log), marks the run
// void, and lets a driver rerun it (exit code 4; `prepare --replace-void`). See docs/Benchmark.md.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export const voidExitCode = 4;
export const heartbeatMs = 5000;
export const suspendGapMs = 60_000;

/**
 * A heartbeat: every `intervalMs`, compares the wall clock with the last beat; a gap over `gapMs` means the machine
 * slept or was starved. Clock and timers are injectable. `stop()` returns the gaps as [{ from, to, seconds }].
 */
export function createSuspendWatch({ now = Date.now, setInterval: every = setInterval, clearInterval: clear = clearInterval, intervalMs = heartbeatMs, gapMs = suspendGapMs } = {}) {
  const suspended = [];
  let last = now();
  const timer = every(() => {
    const at = now();
    if (at - last > gapMs) suspended.push({ from: new Date(last).toISOString(), to: new Date(at).toISOString(), seconds: Math.round((at - last) / 1000), source: 'heartbeat' });
    last = at;
  }, intervalMs);
  timer?.unref?.();
  return { stop() { clear(timer); return suspended; } };
}

/** Pairs Kernel-Power events (42 and 506 enter sleep, 107 and 507 resume) into sleep windows (pure). `events`: [{ id, at: ISO }]. */
export function pairSleepEvents(events) {
  const windows = [];
  let enteredAt;
  for (const event of [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    if ([42, 506].includes(event.id)) enteredAt ??= event.at;
    else if ([107, 507].includes(event.id) && enteredAt) {
      windows.push({ from: enteredAt, to: event.at, seconds: Math.round((Date.parse(event.at) - Date.parse(enteredAt)) / 1000), source: 'event log' });
      enteredAt = undefined;
    }
  }
  return windows;
}

/** Sleep windows in [fromMs, toMs] from the Windows System event log; [] elsewhere or when it can't be read (logged). */
export async function windowsSleepEvents(fromMs, toMs, { platform = process.platform, exec = execFile, log = console.log, timeoutMs = 30_000 } = {}) {
  if (platform !== 'win32') return [];
  // A sleep that began before the run and woke inside it would pair badly, so the query starts a little early.
  const script = `$e = Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-Power'; Id=42,107,506,507; StartTime=[datetime]'${new Date(fromMs - 60_000).toISOString()}'; EndTime=[datetime]'${new Date(toMs + 60_000).toISOString()}'} -ErrorAction SilentlyContinue; @($e | ForEach-Object { @{ id = $_.Id; at = $_.TimeCreated.ToUniversalTime().ToString('o') } }) | ConvertTo-Json -Compress`;
  try {
    const stdout = await new Promise((resolve, reject) => exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: timeoutMs }, (error, out) => error ? reject(error) : resolve(String(out))));
    const parsed = stdout.trim() ? JSON.parse(stdout) : [];
    return pairSleepEvents(Array.isArray(parsed) ? parsed : [parsed]).filter(window => Date.parse(window.to) >= fromMs && Date.parse(window.from) <= toMs);
  } catch (error) {
    log(`Couldn't read the system event log for sleep events (${error instanceof Error ? error.message.split('\n')[0] : error}); relying on the heartbeat.`);
    return [];
  }
}

const overlaps = (a, b) => Date.parse(a.from) <= Date.parse(b.to) && Date.parse(b.from) <= Date.parse(a.to);

/** The results marked void (pure). */
export const markVoid = (results, suspended) => ({ ...results, void: 'suspended', voidReason: `The machine was suspended for ${suspended.reduce((sum, window) => sum + window.seconds, 0)}s during the run, so its times are not comparable.`, suspended });

/**
 * Runs `work` under a suspend watch. When the machine slept (heartbeat gap, or an event-log sleep in the run's
 * window), marks every results file of this run (`files()`, written since the start) void and throws an error with
 * exit code 4; the error wins over whatever `work` threw, since a run that slept has no result either way.
 */
export async function guardSuspend(work, { files = () => [], watch = {}, events = windowsSleepEvents, now = Date.now, log = console.log } = {}) {
  const startedMs = now();
  const heartbeat = createSuspendWatch({ now, ...watch });
  let result, caught;
  try { result = await work(); } catch (error) { caught = error; }
  const suspended = [...heartbeat.stop()];
  for (const window of await Promise.resolve(events(startedMs, now())).catch(() => [])) if (!suspended.some(known => overlaps(known, window))) suspended.push(window);
  if (!suspended.length) { if (caught) throw caught; return result; }
  for (const file of files()) {
    try {
      if ((await fs.stat(file)).mtimeMs < startedMs - 1000) continue;
      await fs.writeFile(file, JSON.stringify(markVoid(JSON.parse(await fs.readFile(file, 'utf8')), suspended), null, 2) + '\n');
    } catch { /* no results file this run */ }
  }
  log(`VOID: the machine was suspended during this run (${suspended.map(window => `${window.from} to ${window.to}, ${window.seconds}s`).join('; ')}).`);
  const error = new Error(`VOID: the machine slept during the run, so it is not a result; run it again.${caught ? ` (it also failed: ${String(caught.message ?? caught).split('\n')[0]})` : ''}`);
  error.exitCode = voidExitCode;
  error.suspended = suspended;
  throw error;
}

/**
 * `prepare --replace-void`: when the run folder's results say `void`, moves it aside to `<name>.void-<timestamp>` and
 * returns the new path; otherwise undefined (and prepare refuses a non-empty folder as before).
 */
export async function replaceVoidFolder(out, { stamp = new Date().toISOString().replace(/[:.]/g, '-') } = {}) {
  const names = await fs.readdir(out).catch(() => []);
  let isVoid = false;
  for (const name of names.filter(item => item.endsWith('-results.json'))) {
    try { if (JSON.parse(await fs.readFile(path.join(out, name), 'utf8')).void) isVoid = true; } catch { /* unreadable */ }
  }
  if (!isVoid) return undefined;
  const aside = `${out}.void-${stamp}`;
  await fs.rename(out, aside);
  return aside;
}

/** "Void runs (machine slept)": each void run with its suspended windows, and a count per setup (pure). */
export function renderVoidRuns(voids) {
  if (!voids.length) return '';
  const bySetup = new Map();
  for (const item of voids) bySetup.set(item.setup, (bySetup.get(item.setup) ?? 0) + 1);
  const lines = ['## Void runs (machine slept)', '', 'Not in any median above: the machine slept during these, so their times are not comparable. Run them again (`prepare --replace-void`).', '', `Per setup: ${[...bySetup].sort().map(([setup, count]) => `${setup} ${count}`).join(', ')}.`, ''];
  for (const item of voids) lines.push(`- ${item.folder} (${item.task}, ${item.setup}): ${(item.suspended ?? []).map(window => `${window.from} to ${window.to} (${window.seconds}s)`).join('; ') || 'no window recorded'}`);
  return lines.join('\n') + '\n';
}
