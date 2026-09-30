import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  benchWindows, closeCli, closeDecision, closeLeftovers, closeOwnWindow, directCliPaths, helpListsClose, launcherLacksClose, markerFile, underBench, windowsDirectory,
// @ts-expect-error: a plain .mjs module with no type declarations.
} from '../scripts/benchmark-windows.mjs';
import { runCli } from '../src/core/hydraCli';

/**
 * docs/Benchmark.md, "Closing the windows": the harness closes the Hydra windows it opened (bench-open.ps1's marker
 * says which), never one that was already open, and deals with leftover benchmark windows before a run. Everything
 * runs against stand-ins: no Hydra window is opened or closed.
 */

const root = process.cwd();
const script = path.join(root, 'scripts', 'benchmark.mjs');
const fakeHydra = path.join(root, 'tests', 'fixtures', 'bench', 'fake-hydra.cjs');
const windows = process.platform === 'win32';

function spawnText(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const { NODE_TEST_CONTEXT: _context, ...clean } = env;
    const child = spawn(command, args, { cwd: root, windowsHide: true, env: clean });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
async function marker(folder: string, value: Record<string, unknown>) {
  await mkdir(path.join(folder, '.git'), { recursive: true });
  await writeFile(markerFile(folder), JSON.stringify(value));
}

const now = Date.parse('2026-09-30T12:00:00Z');
/** A marker as bench-open.ps1 writes it, `minutesAgo` before `now`. */
const opened = (folder: string, pid: unknown, minutesAgo = 5, extra: Record<string, unknown> = {}) =>
  ({ version: 1, folder, preexisting: false, pid, at: new Date(now - minutesAgo * 60_000).toISOString(), ...extra });

test('closeDecision: only a window bench-open.ps1 opened, for this very folder, and the same window it opened', () => {
  const folder = path.resolve('/runs/.bench/a/hydra');
  const status = { repository: folder, window: { pid: 7, port: 1 } };
  const decide = (input: Record<string, unknown>) => closeDecision({ folder, marker: opened(folder, 7), status, now, notBefore: now - 60 * 60_000, ...input });
  assert.deepEqual(decide({}), { close: true });
  assert.equal(decide({ status: { ...status, repository: folder.toUpperCase() }, platform: 'win32' }).close, true, 'Windows paths ignore case');
  assert.match(decide({ marker: undefined }).reason, /didn't open it/);
  assert.match(decide({ marker: opened(folder, 7, 5, { preexisting: true }) }).reason, /already had this folder open/);
  assert.match(decide({ marker: opened(folder, 7, 5, { preexisting: undefined }) }).reason, /already had this folder open/, 'an unclear marker never closes');
  assert.match(decide({ status: undefined }).reason, /no Hydra window owns it/);
  assert.match(decide({ status: { repository: path.dirname(folder), window: { pid: 7 } } }).reason, /the window that owns it is for/, 'a parent folder\'s window is never closed');
  assert.match(decide({ status: { ...status, window: { pid: 8 } } }).reason, /a different window \(8\)/);
});

test('a stale marker never closes a window: no pid, another folder\'s, from an earlier run, or undated', () => {
  const folder = path.resolve('/runs/.bench/a/hydra');
  // Nico's own window now owns the folder, as window 7.
  const status = { repository: folder, window: { pid: 7, port: 1 } };
  const decide = (marker: unknown, notBefore = now - 60 * 60_000) => closeDecision({ folder, marker, status, now, notBefore });
  // A failed wait, or -WaitSeconds 0: the marker names no window, so it closes nothing, whatever owns the folder later.
  for (const pid of [null, undefined, '7', 0, -1, 7.5]) assert.match(decide(opened(folder, pid)).reason, /names no window/, String(pid));
  // Copied into another repository's .git: written for another folder.
  assert.match(decide(opened(path.resolve('/elsewhere/repo'), 7)).reason, /another folder/);
  assert.match(decide(opened(folder, 7, 5, { folder: undefined })).reason, /another folder/);
  // Older than this run, undated, or dated in the future.
  assert.match(decide(opened(folder, 7, 120)).reason, /from an earlier run/);
  assert.match(decide(opened(folder, 7, 5, { at: undefined })).reason, /from an earlier run/);
  assert.match(decide(opened(folder, 7, 5, { at: 'yesterday' })).reason, /from an earlier run/);
  assert.match(decide(opened(folder, 7, -10)).reason, /from an earlier run/);
  // The same marker, fresh, for the same window: closes.
  assert.deepEqual(decide(opened(folder, 7, 30)), { close: true });
});

test('closeOwnWindow and closeLeftovers pass the run\'s cutoff: an old marker leaves the window open, and is kept', async () => {
  const folder = path.resolve('/r/.bench/old');
  const deps = fakeDeps({ [folder]: opened(folder, 7, 60 * 13) }, { [folder]: 7 }, { now: () => now });
  assert.deepEqual(await closeOwnWindow(folder, deps, { notBefore: now - 12 * 60 * 60_000 }), { closed: false, reason: 'its marker is from an earlier run' });
  assert.deepEqual(deps.closes, []);
  // A leftover may be older (up to 48 hours), but not older still.
  const repo = path.resolve('/r/.bench/now'), dayOld = path.resolve('/r/.bench/day'), weekOld = path.resolve('/r/.bench/week');
  const records = [repo, dayOld, weekOld].map((item, index) => ({ version: 2, pid: 10 + index, port: 1, folders: [item] }));
  const left = fakeDeps({ [dayOld]: opened(dayOld, 11, 60 * 24), [weekOld]: opened(weekOld, 12, 60 * 24 * 7) }, { [dayOld]: 11, [weekOld]: 12 }, { now: () => now, records: async () => records, alive: () => true });
  await closeLeftovers(repo, left);
  assert.deepEqual(left.closes, [dayOld]);
  assert.match(left.warnings.join('\n'), /week \(window 12\): its marker is from an earlier run/);
});

test('a launcher built before `hydra close` is spotted, so the harness never asks it to open a folder named "close"', () => {
  // The dispatch lines brandedLauncherCmd and brandedLauncherSh write (tests/desktop.test.mjs checks the real ones).
  const cmd = (words: string) => `set ELECTRON_RUN_AS_NODE=1\r\nfor %%C in (${words}) do if /I "%~1"=="%%C" goto hydracli\r\nendlocal\r\n:hydracli\r\n"%~dp0..\Hydra.exe" x %*\r\n`;
  const sh = (words: string) => `case "$1" in\n\t${words.replaceAll(' ', '|')})\n\t\tHYDRA_CLI="$VSCODE_PATH/x"\n\t\t;;\nesac\n`;
  const now = 'status plan heads stop resume report close', before = 'status plan heads stop resume report';
  assert.equal(launcherLacksClose(cmd(now)), false);
  assert.equal(launcherLacksClose(sh(now)), false);
  assert.equal(launcherLacksClose(cmd(before)), true);
  assert.equal(launcherLacksClose(sh(before)), true);
  assert.equal(launcherLacksClose(`@"node" "fake-hydra.cjs" %*`), false, 'not Hydra\'s launcher');
  assert.equal(launcherLacksClose(undefined), false);
});

test('an old launcher: the harness runs Hydra.exe on the installed hydra-cli.cjs directly, only when that script has close', async () => {
  // The real usage text lists close; an older one doesn't.
  let usage = '';
  await runCli(['--help'], { stdout: (text: string) => { usage += text; } } as never);
  assert.equal(helpListsClose(usage), true);
  assert.equal(helpListsClose(usage.replace(/^\s*close\b.*$/m, '')), false);

  const install = path.resolve('/Programs/Hydra'), launcherFile = path.join(install, 'bin', 'hydra.cmd');
  const oldLauncher = `set ELECTRON_RUN_AS_NODE=1\r\nfor %%C in (status plan heads stop resume report) do if /I "%~1"=="%%C" goto hydracli\r\n:hydracli\r\n"%~dp0..\\Hydra.exe" "%~dp0..\\resources\\app\\extensions\\hydra-agent-manager\\dist\\hydra-cli.cjs" %*\r\n`;
  const { exe, script } = directCliPaths(launcherFile, oldLauncher);
  assert.equal(exe, path.join(install, 'Hydra.exe'));
  assert.equal(script, path.join(install, 'resources', 'app', 'extensions', 'hydra-agent-manager', 'dist', 'hydra-cli.cjs'));

  const calls: { command: string; argv: string[]; cwd: string; env: Record<string, string> }[] = [];
  let help = usage;
  const run = async (command: string, argv: string[], options: { cwd: string; env: Record<string, string> }) => {
    calls.push({ command, argv, cwd: options.cwd, env: options.env });
    return argv[1] === '--help' ? { code: 0, stdout: help, stderr: '' } : { code: 0, stdout: '{"closing":true}', stderr: '' };
  };
  const logs: string[] = [];
  const launcherCli = async () => { throw new Error('the old launcher must not be asked to close'); };
  const deps = { launcherFile, launcherText: oldLauncher, cliIn: launcherCli, run, exists: () => true, log: (line: string) => { logs.push(line); } };
  const chosen = await closeCli(deps);
  assert.deepEqual([chosen.canClose, chosen.via], [true, 'hydra-cli.cjs directly']);
  assert.match(logs[0]!, /Closing windows with .*Hydra\.exe .*hydra-cli\.cjs \(ELECTRON_RUN_AS_NODE=1\)/);
  const repo = path.resolve('/r/.bench/a/hydra');
  await chosen.cli(repo, 'close', '--json');
  assert.deepEqual(calls.at(-1), { command: exe, argv: [script, 'close', '--json'], cwd: repo, env: { ELECTRON_RUN_AS_NODE: '1' } });

  // The installed script predates close too, or isn't there: nothing closes, and that is logged.
  help = usage.replace(/^\s*close\b.*$/m, '');
  assert.deepEqual([(await closeCli(deps)).canClose, (await closeCli({ ...deps, exists: () => false })).canClose], [false, false]);
  assert.match(logs.at(-1)!, /both predate `hydra close`/);
  // A launcher that has close is used as it is.
  const current = await closeCli({ ...deps, launcherText: oldLauncher.replace('report)', 'report close)') });
  assert.deepEqual([current.cli, current.via], [launcherCli, 'the hydra command']);
});

test('leftover detection: live discovery records whose folder is under .bench', () => {
  assert.equal(underBench('C:\\hydra\\.bench\\swebench-seed1\\x\\repo'), true);
  assert.equal(underBench('c:/hydra/.BENCH/a'), true);
  assert.equal(underBench('C:\\hydra'), false);
  assert.equal(underBench('C:\\hydra\\.benchmarks\\a'), false);
  const records = [
    { version: 2, pid: 1, port: 10, folders: ['c:\\hydra\\.bench\\a\\hydra'] },
    { version: 2, pid: 2, port: 11, folders: ['c:\\hydra'] },
    { version: 2, pid: 3, port: 12, folders: ['c:\\hydra\\.bench\\b\\hydra'] },
    { version: 2, pid: 4, port: 13, folders: ['c:\\hydra\\.bench\\dead'] },
    { version: 1, pid: 5, folders: ['c:\\hydra\\.bench\\old'] }, null,
  ];
  assert.deepEqual(benchWindows(records, (pid: number) => pid !== 4), [
    { pid: 1, port: 10, folder: 'c:\\hydra\\.bench\\a\\hydra' }, { pid: 3, port: 12, folder: 'c:\\hydra\\.bench\\b\\hydra' },
  ]);
  assert.equal(windowsDirectory({ HYDRA_HELPERS_DIR: 'X' }), path.join('X', 'windows'));
  assert.equal(windowsDirectory({ APPDATA: 'A' }), path.join('A', 'Hydra', 'User', 'globalStorage', 'nico-dunlap.hydra-agent-manager', 'helpers', 'windows'));
  assert.equal(windowsDirectory({}), undefined);
});

/** closeOwnWindow's deps, with a stand-in `hydra` that answers status as `owners[folder]` and records every close. */
function fakeDeps(markers: Record<string, unknown>, owners: Record<string, number>, extra: Record<string, unknown> = {}) {
  const closes: string[] = [], logs: string[] = [], warnings: string[] = [], removed: string[] = [];
  return {
    closes, logs, warnings, removed,
    readMarker: async (folder: string) => markers[folder],
    removeMarker: async (folder: string) => { removed.push(folder); },
    cli: async (folder: string, ...argv: string[]) => {
      if (argv[0] === 'status') return owners[folder] ? { code: 0, stdout: JSON.stringify({ repository: folder, window: { pid: owners[folder], port: 1 } }), stderr: '' } : { code: 3, stdout: '', stderr: 'none' };
      if (argv[0] === 'close') { closes.push(folder); return { code: 0, stdout: '{"closing":true}', stderr: '' }; }
      throw new Error(`unexpected ${argv.join(' ')}`);
    },
    log: (text: string) => { logs.push(text); }, warn: (text: string) => { warnings.push(text); }, now: () => now,
    ...extra,
  };
}

test('the harness closes only windows it opened: never one already open, one without a marker, or a different window', async () => {
  const mine = path.resolve('/r/.bench/mine'), nicos = path.resolve('/r/.bench/nicos'), unmarked = path.resolve('/r/.bench/unmarked'), swapped = path.resolve('/r/.bench/swapped');
  const deps = fakeDeps(
    { [mine]: opened(mine, 7), [nicos]: opened(nicos, 8, 5, { preexisting: true }), [swapped]: opened(swapped, 9) },
    { [mine]: 7, [nicos]: 8, [unmarked]: 10, [swapped]: 11 },
  );
  for (const folder of [mine, nicos, unmarked, swapped]) await closeOwnWindow(folder, deps);
  assert.deepEqual(deps.closes, [mine]);
  assert.deepEqual(deps.removed, [mine], 'its marker goes once it closed');
  // A window that refuses (still working) stays open, and says so loudly; the harness never forces.
  const busy = fakeDeps({ [mine]: opened(mine, 7) }, { [mine]: 7 });
  busy.cli = async (_folder: string, ...argv: string[]) => argv[0] === 'status'
    ? { code: 0, stdout: JSON.stringify({ repository: mine, window: { pid: 7 } }), stderr: '' }
    : { code: 1, stdout: JSON.stringify({ ok: false, error: 'This Hydra window is still working (1 head)' }), stderr: '' };
  assert.deepEqual(await closeOwnWindow(mine, busy), { closed: false, reason: 'This Hydra window is still working (1 head)' });
  assert.match(busy.warnings.join('\n'), /WARNING: .* didn't close: This Hydra window is still working/);
  assert.deepEqual(busy.removed, []);
  // An old launcher: nothing is run at all, and it says why.
  const old = fakeDeps({ [mine]: opened(mine, 7) }, { [mine]: 7 }, { canClose: false });
  assert.equal((await closeOwnWindow(mine, old)).closed, false);
  assert.deepEqual(old.closes, []);
  assert.match(old.warnings[0]!, /predates `hydra close`/);
});

test('before a run: leftover benchmark windows the harness opened are closed, others are named loudly, this run\'s own is kept', async () => {
  const repo = path.resolve('/r/.bench/now/hydra'), left = path.resolve('/r/.bench/old/hydra'), nicos = path.resolve('/r/.bench/looking');
  const records = [repo, left, nicos, path.resolve('/r')].map((folder, index) => ({ version: 2, pid: 100 + index, port: 1, folders: [folder] }));
  const deps = fakeDeps(
    { [repo]: opened(repo, 100), [left]: opened(left, 101), [nicos]: opened(nicos, 102, 5, { preexisting: true }) },
    { [repo]: 100, [left]: 101, [nicos]: 102 },
    { records: async () => records, alive: () => true },
  );
  const result = await closeLeftovers(repo, deps);
  assert.equal(result.open, 3, 'three windows under .bench; the fourth is not a benchmark folder');
  assert.deepEqual(deps.closes, [left], 'never this run\'s own window, nor one Nico had open');
  assert.deepEqual(result.left.map((window: { folder: string }) => window.folder), [nicos]);
  assert.match(deps.warnings.join('\n'), /WARNING: 2 Hydra benchmark windows are open[\s\S]*looking \(window 102\): a window already had this folder open/);
  // One benchmark window (this run's): nothing to do.
  const alone = fakeDeps({}, {}, { records: async () => records.slice(0, 1), alive: () => true });
  assert.deepEqual(await closeLeftovers(repo, alone), { open: 1, closed: [], left: [] });
  assert.deepEqual([alone.closes, alone.warnings], [[], []]);
});

test('benchmark.mjs hydra closes the window it opened once the results are written, and leaves an unmarked one open', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'hydra-bench-windows-'));
  try {
    const bench = path.join(out, '.bench');
    const openedRepo = path.join(bench, 'opened', 'hydra'), manual = path.join(bench, 'manual', 'hydra'), leftover = path.join(bench, 'leftover', 'hydra');
    for (const folder of [openedRepo, manual, leftover]) await mkdir(path.join(folder, '.git'), { recursive: true });
    await marker(openedRepo, { version: 1, folder: openedRepo, preexisting: false, pid: 4242, at: new Date().toISOString() });
    await marker(leftover, { version: 1, folder: leftover, preexisting: false, pid: 4242, at: new Date().toISOString() });
    // Discovery records a Hydra window would write: this run's window and a leftover, both under .bench.
    const helpers = path.join(out, 'helpers');
    await mkdir(path.join(helpers, 'windows'), { recursive: true });
    await writeFile(path.join(helpers, 'windows', 'a.json'), JSON.stringify({ version: 2, port: 1, pid: process.pid, folders: [openedRepo], writtenAt: '' }));
    await writeFile(path.join(helpers, 'windows', 'b.json'), JSON.stringify({ version: 2, port: 2, pid: process.pid, folders: [leftover], writtenAt: '' }));
    const env = { ...process.env, HYDRA_HELPERS_DIR: helpers };
    const hydra = ['--hydra', `"${process.execPath}" "${fakeHydra}"`];

    const ran = await spawnText(process.execPath, [script, 'hydra', '--repo', openedRepo, '--poll', '0.01', '--plan-store', path.join(out, 'no-plans.json'), ...hydra], env);
    assert.equal(ran.code, 0, ran.stderr);
    assert.ok(existsSync(path.join(bench, 'opened', 'hydra-results.json')), 'results first');
    assert.equal((await readFile(path.join(openedRepo, '.fake-hydra-closed'), 'utf8')).trim(), 'close --json --reason benchmark run finished');
    assert.equal(existsSync(markerFile(openedRepo)), false, 'its marker is gone once it closed');
    assert.equal((await readFile(path.join(leftover, '.fake-hydra-closed'), 'utf8')).trim(), 'close --json --reason benchmark run finished', 'the leftover the harness opened was closed before the run');
    assert.match(ran.stdout, /Closed the Hydra window the harness opened for .*leftover/);

    // A window Nico opened himself (no marker): the run leaves it open.
    await writeFile(path.join(helpers, 'windows', 'a.json'), JSON.stringify({ version: 2, port: 1, pid: process.pid, folders: [manual], writtenAt: '' }));
    await rm(path.join(helpers, 'windows', 'b.json'));
    const kept = await spawnText(process.execPath, [script, 'hydra', '--repo', manual, '--poll', '0.01', '--plan-store', path.join(out, 'no-plans.json'), ...hydra], env);
    assert.equal(kept.code, 0, kept.stderr);
    assert.equal(existsSync(path.join(manual, '.fake-hydra-closed')), false);
  } finally { await rm(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('bench-open.ps1 records whether a window already had the folder open, and which window it opened', { skip: !windows }, async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'hydra-bench-open-'));
  try {
    const launcher = path.join(out, 'hydra.cmd');
    await writeFile(launcher, `@"${process.execPath}" "${path.join(root, 'tests', 'fixtures', 'bench', 'fake-hydra-open.cjs')}" %*\r\n`);
    const open = (folder: string) => spawnText('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'bench-open.ps1'), '-Folder', folder, '-WaitSeconds', '30', '-Hydra', launcher]);
    const fresh = path.join(out, 'fresh');
    await mkdir(path.join(fresh, '.git'), { recursive: true });
    const first = await open(fresh);
    assert.equal(first.code, 0, first.stderr + first.stdout);
    assert.deepEqual((({ preexisting, pid }) => ({ preexisting, pid }))(JSON.parse(await readFile(markerFile(fresh), 'utf8'))), { preexisting: false, pid: 5151 });
    // Opening it again while its window is still open: still the harness's own window.
    assert.equal((await open(fresh)).code, 0);
    assert.equal(JSON.parse(await readFile(markerFile(fresh), 'utf8')).preexisting, false);

    const already = path.join(out, 'already');
    await mkdir(path.join(already, '.git'), { recursive: true });
    await writeFile(path.join(already, '.git', 'fake-owner'), '777');
    const second = await open(already);
    assert.equal(second.code, 0, second.stderr + second.stdout);
    assert.match(second.stdout, /already had .* open: the harness will leave it open/);
    assert.equal(JSON.parse(await readFile(markerFile(already), 'utf8')).preexisting, true);
  } finally { await rm(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
