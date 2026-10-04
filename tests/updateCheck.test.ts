import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { preferenceOnlySettings } from '../src/core/settingsRefresh';
import {
  allowedDownloadUrl, compareVersions, downloadVerified, installerArguments, isNewer, latestRelease, parseSums, psQuote, releaseFromPayload,
  helperBridgeScripts, releasesLatestUrl, productFiles, appInstallerArguments, runningNotice, updateEligibility, updateHelperFileContents, updateHelperScript, updateLauncherArguments, nextAutoCheckDelay, updateOffer, helperEnvironment, type FetchLike, type LatestRelease,
} from '../src/core/updateCheck';

const tag = 'v0.25.0';
const base = `https://github.com/ndunl075/hydra/releases/download/${tag}/`;
const payload = (patch: Record<string, unknown> = {}) => ({
  tag_name: tag, prerelease: false, draft: false, html_url: `https://github.com/ndunl075/hydra/releases/tag/${tag}`,
  assets: [
    { name: 'HydraSetup.exe', browser_download_url: `${base}HydraSetup.exe` },
    { name: 'SHA256SUMS', browser_download_url: `${base}SHA256SUMS` },
  ],
  ...patch,
});
const release: LatestRelease = { version: '0.25.0', tag, notesUrl: `https://github.com/ndunl075/hydra/releases/tag/${tag}`, installerUrl: `${base}HydraSetup.exe`, sumsUrl: `${base}SHA256SUMS` };

test('compareVersions orders x.y.z numerically and refuses prerelease tags', () => {
  assert.equal(compareVersions('0.24.1', '0.24.1'), 0);
  assert.equal(compareVersions('0.24.10', '0.24.9'), 1);
  assert.equal(compareVersions('0.9.0', '0.24.1'), -1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions('0.25.0-beta.1', '0.24.1'), undefined);
  assert.equal(compareVersions('v0.25.0', '0.24.1'), undefined);
  assert.equal(compareVersions('0.25', '0.24.1'), undefined);
  assert.ok(isNewer('0.25.0', '0.24.1'));
  assert.ok(!isNewer('0.24.1', '0.24.1'));
  assert.ok(!isNewer('0.25.0-rc.1', '0.24.1'));
});

test('releaseFromPayload accepts a well-formed full release', () => {
  assert.deepEqual(releaseFromPayload(payload()), { release });
});

test('releaseFromPayload refuses prereleases, drafts, bad tags and missing or foreign assets', () => {
  const refused = (value: unknown, pattern: RegExp) => { const result = releaseFromPayload(value); assert.equal(result.release, undefined); assert.match(result.reason!, pattern); };
  refused(payload({ prerelease: true }), /prerelease/);
  refused(payload({ prerelease: undefined }), /prerelease/);
  refused(payload({ draft: true }), /draft/);
  refused(payload({ tag_name: '0.25.0' }), /v<x\.y\.z>/);
  refused(payload({ tag_name: 'v0.25.0-beta' }), /v<x\.y\.z>/);
  refused(payload({ tag_name: 'v0.25' }), /v<x\.y\.z>/);
  refused(payload({ assets: [payload().assets[1]] }), /HydraSetup\.exe/);
  refused(payload({ assets: [payload().assets[0]] }), /SHA256SUMS/);
  refused(payload({ assets: [{ name: 'HydraSetup.exe', browser_download_url: 'https://evil.example/HydraSetup.exe' }, payload().assets[1]] }), /HydraSetup\.exe/);
  // Another tag's folder, or another repository, is foreign too.
  refused(payload({ assets: [{ name: 'HydraSetup.exe', browser_download_url: 'https://github.com/ndunl075/hydra/releases/download/v0.1.0/HydraSetup.exe' }, payload().assets[1]] }), /HydraSetup\.exe/);
  refused(payload({ assets: [payload().assets[0], { name: 'SHA256SUMS', browser_download_url: 'https://github.com/someone/hydra/releases/download/v0.25.0/SHA256SUMS' }] }), /SHA256SUMS/);
  refused(payload({ assets: [payload().assets[0], payload().assets[0], payload().assets[1]] }), /HydraSetup\.exe/);
  refused(null, /JSON object/);
  refused('v0.25.0', /JSON object/);
});

test('latestRelease asks the GitHub API with a User-Agent and never throws', async () => {
  const seen: { url: string; headers?: Record<string, string> }[] = [];
  const ok: FetchLike = async (url, init) => { seen.push({ url, headers: init.headers }); return new Response(JSON.stringify(payload()), { status: 200 }); };
  assert.deepEqual(await latestRelease(ok), { release });
  assert.equal(seen[0]!.url, releasesLatestUrl);
  assert.equal(seen[0]!.headers!.Accept, 'application/vnd.github+json');
  assert.ok(seen[0]!.headers!['User-Agent']);
  assert.match((await latestRelease(async () => new Response('{}', { status: 403 }))).reason!, /403.*rate limited/);
  assert.match((await latestRelease(async () => { throw new Error('offline'); })).reason!, /offline/);
  assert.match((await latestRelease(async () => new Response('not json', { status: 200 }))).reason!, /couldn't reach GitHub/);
  assert.match((await latestRelease(async () => new Response('x'.repeat(3 * 1024 * 1024), { status: 200 }))).reason!, /larger than/);
  assert.equal((await latestRelease(async () => new Response(JSON.stringify(payload({ prerelease: true })), { status: 200 }))).release, undefined);
});

test('allowedDownloadUrl takes https on the three GitHub hosts only', () => {
  for (const url of ['https://github.com/x', 'https://objects.githubusercontent.com/x', 'https://release-assets.githubusercontent.com/x?sig=1']) assert.ok(allowedDownloadUrl(url), url);
  for (const url of ['http://github.com/x', 'https://github.com.evil.example/x', 'https://evil.example/github.com/', 'https://user@github.com/x', 'https://github.com:8443/x', 'https://api.github.com/x', 'ftp://github.com/x', 'nonsense'])
    assert.ok(!allowedDownloadUrl(url), url);
});

test('parseSums wants exactly one HydraSetup.exe line', () => {
  const hex = 'a'.repeat(64);
  assert.equal(parseSums(`${hex}  HydraSetup.exe\n`), hex);
  assert.equal(parseSums(`${hex.toUpperCase()} *HydraSetup.exe\r\n`), hex);
  assert.throws(() => parseSums(''), /exactly one line, and has 0/);
  assert.throws(() => parseSums(`${hex}  HydraSetup.exe\n${hex}  Other.exe\n`), /exactly one line, and has 2/);
  assert.throws(() => parseSums(`${hex}  Other.exe\n`), /no HydraSetup\.exe line/);
  assert.throws(() => parseSums(`${'a'.repeat(63)}  HydraSetup.exe\n`), /no HydraSetup\.exe line/);
});

// ---- downloadVerified against a local HTTP server ----
// The code only talks to https GitHub URLs, so the injected fetch maps https://<host>/<path>
// to http://127.0.0.1:<port>/<host>/<path>; redirects the server sends keep their https form
// and go back through the same checks.

type Route = { status?: number; location?: string; body?: Buffer | string; length?: number };
async function fixture(routes: Record<string, Route>): Promise<{ fetch: FetchLike; requested: string[]; close(): Promise<void> }> {
  const requested: string[] = [];
  const server: Server = createServer((request, response) => {
    const key = request.url!.slice(1).split('?')[0]!;
    requested.push(key);
    const route = routes[key];
    if (!route) { response.writeHead(404).end(); return; }
    const body = typeof route.body === 'string' ? Buffer.from(route.body) : route.body ?? Buffer.alloc(0);
    response.writeHead(route.status ?? 200, { ...(route.location ? { location: route.location } : {}), 'content-length': String(route.length ?? body.length) });
    response.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const fetchImpl: FetchLike = (url, init) => {
    const parsed = new URL(url);
    return fetch(`http://127.0.0.1:${port}/${parsed.host}${parsed.pathname}${parsed.search}`, init);
  };
  return { fetch: fetchImpl, requested, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

const installerBytes = Buffer.from('MZ fake Hydra installer '.repeat(5000));
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sumsOf = (bytes: Buffer) => `${digest(bytes)}  HydraSetup.exe\n`;
const releasePath = 'github.com/ndunl075/hydra/releases/download/v0.25.0/';

async function scratch(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-update-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('downloadVerified follows the real redirect shape (github.com, then release-assets) and keeps a matching installer', async t => {
  const server = await fixture({
    [`${releasePath}SHA256SUMS`]: { status: 302, location: 'https://release-assets.githubusercontent.com/sums?sig=abc' },
    'release-assets.githubusercontent.com/sums': { body: sumsOf(installerBytes) },
    [`${releasePath}HydraSetup.exe`]: { status: 302, location: 'https://objects.githubusercontent.com/one' },
    'objects.githubusercontent.com/one': { status: 301, location: '/two' },
    'objects.githubusercontent.com/two': { status: 307, location: 'https://release-assets.githubusercontent.com/installer?sig=xyz' },
    'release-assets.githubusercontent.com/installer': { body: installerBytes },
  });
  t.after(() => server.close());
  const dir = await scratch(t);
  const progress: number[] = [];
  const result = await downloadVerified(release, dir, { fetch: server.fetch, onProgress: received => progress.push(received) });
  assert.equal(result.file, path.join(dir, 'HydraSetup-0.25.0.exe'));
  assert.equal(result.sha256, digest(installerBytes));
  assert.equal(result.reused, false);
  assert.deepEqual(await readFile(result.file), installerBytes);
  assert.equal(progress.at(-1), installerBytes.length);
  assert.deepEqual(await readdir(dir), ['HydraSetup-0.25.0.exe'], 'no partial file is left behind');
  // A second Update reuses the verified file instead of downloading again.
  const before = server.requested.length;
  const again = await downloadVerified(release, dir, { fetch: server.fetch });
  assert.equal(again.reused, true);
  assert.ok(!server.requested.slice(before).some(key => key.includes('installer')));
});

test('downloadVerified deletes a download that does not match SHA256SUMS', async t => {
  const server = await fixture({
    [`${releasePath}SHA256SUMS`]: { body: sumsOf(Buffer.from('something else')) },
    [`${releasePath}HydraSetup.exe`]: { body: installerBytes },
  });
  t.after(() => server.close());
  const dir = await scratch(t);
  await assert.rejects(downloadVerified(release, dir, { fetch: server.fetch }), /doesn't match SHA256SUMS.*deleted/);
  assert.deepEqual(await readdir(dir), []);
});

test('downloadVerified replaces a stale file at the final name only after the new one verifies', async t => {
  const server = await fixture({ [`${releasePath}SHA256SUMS`]: { body: sumsOf(installerBytes) }, [`${releasePath}HydraSetup.exe`]: { body: installerBytes } });
  t.after(() => server.close());
  const dir = await scratch(t);
  await writeFile(path.join(dir, 'HydraSetup-0.25.0.exe'), 'stale');
  const result = await downloadVerified(release, dir, { fetch: server.fetch });
  assert.equal(result.reused, false);
  assert.deepEqual(await readFile(result.file), installerBytes);
});

test('downloadVerified refuses an oversized installer, by its declared length or by what arrives', async t => {
  const server = await fixture({ [`${releasePath}SHA256SUMS`]: { body: sumsOf(installerBytes) }, [`${releasePath}HydraSetup.exe`]: { body: installerBytes } });
  t.after(() => server.close());
  const dir = await scratch(t);
  await assert.rejects(downloadVerified(release, dir, { fetch: server.fetch, maxBytes: 1000 }), /larger than/);
  assert.deepEqual(await readdir(dir), []);
  // No content-length at all: the streamed count still stops it.
  const chunked: FetchLike = async url => url.endsWith('SHA256SUMS') ? new Response(sumsOf(installerBytes)) : new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(installerBytes)); controller.close(); } }));
  await assert.rejects(downloadVerified(release, dir, { fetch: chunked, maxBytes: 1000 }), /larger than/);
  assert.deepEqual(await readdir(dir), []);
});

test('downloadVerified refuses a redirect off the allowed hosts, to http, or past five hops', async t => {
  const dir = await scratch(t);
  for (const [location, pattern] of [
    ['https://evil.example/HydraSetup.exe', /refused to download from https:\/\/evil\.example/],
    ['http://objects.githubusercontent.com/x', /refused to download from http:/],
    ['https://objects.githubusercontent.com.evil.example/x', /refused/],
  ] as const) {
    const server = await fixture({ [`${releasePath}SHA256SUMS`]: { body: sumsOf(installerBytes) }, [`${releasePath}HydraSetup.exe`]: { status: 302, location } });
    await assert.rejects(downloadVerified(release, dir, { fetch: server.fetch }), pattern);
    assert.ok(!server.requested.some(key => key.includes('evil') || key.endsWith('/x')), 'the refused host is never contacted');
    await server.close();
  }
  const hops: Record<string, Route> = { [`${releasePath}SHA256SUMS`]: { body: sumsOf(installerBytes) }, [`${releasePath}HydraSetup.exe`]: { status: 302, location: 'https://objects.githubusercontent.com/0' } };
  for (let index = 0; index < 6; index++) hops[`objects.githubusercontent.com/${index}`] = { status: 302, location: `https://objects.githubusercontent.com/${index + 1}` };
  const loop = await fixture(hops);
  t.after(() => loop.close());
  await assert.rejects(downloadVerified(release, dir, { fetch: loop.fetch }), /more than 5 redirects/);
  assert.deepEqual(await readdir(dir), []);
});

test('downloadVerified refuses a SHA256SUMS with no line or extra lines, before downloading the installer', async t => {
  const dir = await scratch(t);
  for (const [sums, pattern] of [['', /has 0/], [`${sumsOf(installerBytes)}${'b'.repeat(64)}  HydraSetup.exe\n`, /has 2/], [`${digest(installerBytes)}  Other.exe\n`, /no HydraSetup\.exe line/]] as const) {
    const server = await fixture({ [`${releasePath}SHA256SUMS`]: { body: sums }, [`${releasePath}HydraSetup.exe`]: { body: installerBytes } });
    await assert.rejects(downloadVerified(release, dir, { fetch: server.fetch }), pattern);
    assert.ok(!server.requested.some(key => key.endsWith('HydraSetup.exe')));
    await server.close();
  }
  assert.deepEqual(await readdir(dir), []);
});

test('downloadVerified refuses a release whose URLs are outside its tag folder', async t => {
  const dir = await scratch(t);
  const never: FetchLike = async () => { throw new Error('should not fetch'); };
  await assert.rejects(downloadVerified({ ...release, installerUrl: 'https://objects.githubusercontent.com/HydraSetup.exe' }, dir, { fetch: never }), /outside/);
  await assert.rejects(downloadVerified({ ...release, version: '../x' }, dir, { fetch: never }), /x\.y\.z/);
});

test('downloadVerified stops when cancelled and leaves nothing', async t => {
  const dir = await scratch(t);
  const controller = new AbortController();
  const slow: FetchLike = async (url, init) => url.endsWith('SHA256SUMS') ? new Response(sumsOf(installerBytes)) : new Response(new ReadableStream({
    start(stream) { stream.enqueue(new Uint8Array(1024)); controller.abort(new Error('cancelled by you')); init.signal?.addEventListener('abort', () => stream.error(init.signal!.reason)); },
  }));
  await assert.rejects(downloadVerified(release, dir, { fetch: slow, signal: controller.signal }), /cancelled by you/);
  assert.deepEqual(await readdir(dir), []);
});

// ---- The helper script ----

test('psQuote doubles every kind of single quote and refuses control characters', () => {
  assert.equal(psQuote("C:\\Users\\O'Brien\\App Data\\Hydra"), "'C:\\Users\\O''Brien\\App Data\\Hydra'");
  assert.equal(psQuote('a\u2019b'), "'a\u2019\u2019b'");
  assert.equal(psQuote('$env:TEMP `n'), "'$env:TEMP `n'", 'no expansion inside single quotes');
  assert.throws(() => psQuote('a\nb'), /control character/);
});

test('updateHelperScript quotes paths with quotes and spaces, waits bounded, runs the installer silently, relaunches', () => {
  const input = { installer: "C:\\Users\\O'Brien\\AppData\\Local\\Temp\\hydra-update\\HydraSetup-0.25.0.exe", installDir: "C:\\Program Files\\O'Brien's Hydra", exe: "C:\\Program Files\\O'Brien's Hydra\\Hydra.exe", log: "C:\\Users\\O'Brien\\AppData\\Local\\Temp\\hydra-update.log" };
  const script = updateHelperScript(input);
  assert.ok(script.includes("$installer = 'C:\\Users\\O''Brien\\AppData\\Local\\Temp\\hydra-update\\HydraSetup-0.25.0.exe'"));
  assert.ok(script.includes("$installDir = 'C:\\Program Files\\O''Brien''s Hydra'"));
  assert.ok(script.includes("$exe = 'C:\\Program Files\\O''Brien''s Hydra\\Hydra.exe'"));
  assert.ok(script.includes("$log = 'C:\\Users\\O''Brien\\AppData\\Local\\Temp\\hydra-update.log'"));
  // No path appears anywhere unquoted.
  assert.ok(!script.includes("O'Brien"));
  assert.match(script, /AddMinutes\(10\)/);
  // Bridges other apps run on Hydra.exe (the MCP server lives as long as Claude Code or Codex does) don't hold the
  // update forever: it waits for Hydra itself, then stops only those, then waits for everything from the folder.
  assert.deepEqual([...helperBridgeScripts], ['hydra-mcp.cjs', 'hydra-limit-hook.cjs', 'hydra-cli.cjs']);
  assert.ok(script.includes("$bridgeScripts = @('\\resources\\app\\extensions\\hydra-agent-manager\\dist\\hydra-mcp.cjs', '\\resources\\app\\extensions\\hydra-agent-manager\\dist\\hydra-limit-hook.cjs', '\\resources\\app\\extensions\\hydra-agent-manager\\dist\\hydra-cli.cjs')"));
  const lines = script.split('\r\n');
  const waitForHydra = lines.indexOf('while (@(Get-HydraProcesses | Where-Object { -not (Test-Bridge $_) }).Count -gt 0) {');
  const stopBridges = lines.indexOf('foreach ($bridge in @(Get-HydraProcesses | Where-Object { Test-Bridge $_ })) {');
  const waitForAll = lines.indexOf('while ((Get-HydraProcesses).Count -gt 0) {');
  assert.ok(waitForHydra > 0 && waitForHydra < stopBridges && stopBridges < waitForAll, 'Hydra first, then the bridges, then nothing left');
  assert.deepEqual(lines.filter(line => /Stop-Process/.test(line)), ['  Stop-Process -Id $bridge.ProcessId -Force -ErrorAction SilentlyContinue'], 'only bridges are ever stopped');
  assert.match(script, /ExecutablePath\.StartsWith\(\$root/, 'only processes run from this install folder');
  assert.ok(script.includes("-ArgumentList '/SILENT','/SP-','/SUPPRESSMSGBOXES','/NORESTART','/NORESTARTAPPLICATIONS','/MERGETASKS=!runcode' -Wait -PassThru"));
  assert.deepEqual([...installerArguments], ['/SILENT', '/SP-', '/SUPPRESSMSGBOXES', '/NORESTART', '/NORESTARTAPPLICATIONS', '/MERGETASKS=!runcode']);
  assert.match(script, /Start-Process -FilePath \$exe/);
  // It removes only the installer, and only after a zero exit code.
  const removals = script.split('\r\n').filter(line => /Remove-Item|\brm\b|\bdel\b/i.test(line));
  assert.deepEqual(removals, ['if ($code -eq 0) { Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue }']);
  const bytes = updateHelperFileContents(input);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM, so Windows PowerShell reads non-ASCII paths');
});

// ---- Eligibility, confirm text, manifest ----

test('updateEligibility: only an installed production Hydra on Windows', () => {
  const exe = 'C:\\Users\\nico\\AppData\\Local\\Programs\\Hydra\\Hydra.exe';
  const installed = (file: string) => file === 'C:\\Users\\nico\\AppData\\Local\\Programs\\Hydra\\unins000.exe';
  assert.deepEqual(updateEligibility({ platform: 'win32', production: true, execPath: exe, exists: installed }), { eligible: true, installDir: 'C:\\Users\\nico\\AppData\\Local\\Programs\\Hydra' });
  assert.equal(updateEligibility({ platform: 'win32', production: true, execPath: exe, exists: () => false }).eligible, false, 'no unins000.exe beside the exe');
  assert.equal(updateEligibility({ platform: 'win32', production: false, execPath: exe, exists: installed }).eligible, false, 'development window');
  assert.equal(updateEligibility({ platform: 'win32', production: true, execPath: exe, exists: installed, testRun: true }).eligible, false, 'test run');
  assert.equal(updateEligibility({ platform: 'darwin', production: true, execPath: exe, exists: installed }).eligible, false);
  // The real check against this machine's node.exe: never an installed Hydra.
  assert.equal(updateEligibility({ platform: 'win32', production: true, execPath: process.execPath, exists: existsSync }).eligible, false);
});

test('runningNotice counts heads and lanes and mentions Stop All Agents', () => {
  assert.equal(runningNotice(0, 0, false), '');
  assert.equal(runningNotice(2, 1, false), '2 heads and 1 lane are running and will be stopped.');
  assert.equal(runningNotice(1, 0, false), '1 head is running and will be stopped.');
  assert.equal(runningNotice(0, 3, false), '3 lanes are running and will be stopped.');
  assert.equal(runningNotice(0, 0, true), 'Stop All Agents is on, and stays on after the restart.');
});

test('the manifest contributes hydra.updates.check and Hydra: Check for Updates', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const setting = manifest.contributes.configuration.properties['hydra.updates.check'];
  assert.equal(setting.type, 'boolean');
  assert.equal(setting.default, true);
  assert.ok(manifest.contributes.commands.some((command: { command: string; title: string }) => command.command === 'hydra.checkForUpdates' && command.title === 'Hydra: Check for Updates'));
  assert.ok(preferenceOnlySettings.has('hydra.updates.check'), 'turning the check off needs no provider refresh');
});

test('nextAutoCheckDelay waits 30 s after startup, then 24 h after the last check in any window', () => {
  const now = 1_000_000_000_000;
  assert.equal(nextAutoCheckDelay(undefined, now), 30_000);
  assert.equal(nextAutoCheckDelay(now - 25 * 3600_000, now), 30_000);
  assert.equal(nextAutoCheckDelay(now - 3600_000, now), 23 * 3600_000);
  assert.equal(nextAutoCheckDelay(now - 1000, now), 24 * 3600_000 - 1000);
  // A clock that went backwards (or a bad stored value) doesn't postpone checks forever.
  assert.equal(nextAutoCheckDelay(now + 5 * 24 * 3600_000, now), 30_000);
  assert.equal(nextAutoCheckDelay(Number.NaN, now), 30_000);
});

test('updateOffer: automatic checks respect Skip this version; a manual check always answers', () => {
  assert.deepEqual(updateOffer('0.25.0', '0.24.1', undefined, false), { kind: 'offer', message: 'Hydra 0.25.0 is available (you have 0.24.1).' });
  assert.deepEqual(updateOffer('0.25.0', '0.24.1', '0.25.0', false), { kind: 'skipped' });
  assert.equal(updateOffer('0.25.0', '0.24.1', '0.25.0', true).kind, 'offer');
  assert.equal(updateOffer('0.26.0', '0.24.1', '0.25.0', false).kind, 'offer', 'skipping one version does not skip the next');
  assert.deepEqual(updateOffer('0.24.1', '0.24.1', undefined, true), { kind: 'latest', message: "You're on the latest version (0.24.1)." });
  assert.equal(updateOffer('0.24.0', '0.24.1', undefined, true).kind, 'latest');
  assert.equal(updateOffer('0.25.0', '0.24.1-dev', undefined, true).kind, 'unknown');
});

test('helperEnvironment drops Electron and VS Code variables so the reopened Hydra opens a window', () => {
  assert.deepEqual(helperEnvironment({ PATH: 'C:\\Windows', TEMP: 'C:\\Temp', ELECTRON_RUN_AS_NODE: '1', VSCODE_IPC_HOOK: 'x', vscode_pid: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' }), { PATH: 'C:\\Windows', TEMP: 'C:\\Temp' });
});

test('the launcher starts the helper through WMI, hidden, with every path quoted inside an encoded command', () => {
  const shell = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
  const helper = String.raw`C:\Users\O'Brien Smith\AppData\Local\Temp\hydra-update-0.24.2.ps1`;
  const args = updateLauncherArguments(shell, helper);
  // Nothing but fixed flags and the encoded script on the command line: no path to mis-quote.
  assert.deepEqual(args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand']);
  const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
  assert.match(script, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/);
  assert.match(script, /ShowWindow = \[uint16\]0/);
  assert.match(script, /if \(\$result\.ReturnValue -ne 0\) \{ exit 1 \}/);
  // The helper's command line is one single-quoted PowerShell literal, its apostrophe doubled.
  assert.ok(script.includes(`CommandLine = '"${shell}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${helper.replaceAll("'", "''")}"'`));
});

// ---- The Hydra app (G6): the same check, its own installer and checksum file ----

const appPayload = (patch: Record<string, unknown> = {}) => payload({
  assets: [
    { name: 'HydraSetup.exe', browser_download_url: `${base}HydraSetup.exe` },
    { name: 'SHA256SUMS', browser_download_url: `${base}SHA256SUMS` },
    { name: 'HydraAppSetup.exe', browser_download_url: `${base}HydraAppSetup.exe` },
    { name: 'SHA256SUMS-app', browser_download_url: `${base}SHA256SUMS-app` },
  ],
  ...patch,
});
const reasonOf = (result: object): string => 'reason' in result && typeof result.reason === 'string' ? result.reason : '';

test('the IDE\'s update check is unchanged beside the app\'s installer: it still takes HydraSetup.exe and a one-line SHA256SUMS', () => {
  assert.deepEqual(releaseFromPayload(appPayload()), { release });
  assert.deepEqual(productFiles.ide, { installer: 'HydraSetup.exe', sums: 'SHA256SUMS' });
  const hash = 'a'.repeat(64);
  assert.equal(parseSums(`${hash}  HydraSetup.exe\n`), hash);
  // A release's SHA256SUMS never lists the app: installed IDEs refuse a second line.
  assert.throws(() => parseSums(`${hash}  HydraSetup.exe\n${'b'.repeat(64)}  HydraAppSetup.exe\n`), /exactly one line/);
  assert.throws(() => parseSums(`${hash}  HydraAppSetup.exe\n`), /no HydraSetup\.exe line/);
  const script = updateHelperScript({ installer: 'C:\\t\\HydraSetup-0.25.0.exe', installDir: 'C:\\Hydra', exe: 'C:\\Hydra\\Hydra.exe', log: 'C:\\t\\log' });
  assert.ok(script.includes(installerArguments.map(argument => psQuote(argument)).join(',')));
  assert.ok(script.includes("'\\resources\\app\\extensions\\hydra-agent-manager\\dist\\hydra-mcp.cjs'"));
  assert.match(reasonOf(updateEligibility({ platform: 'win32', production: true, execPath: 'C:\\x\\Hydra.exe', exists: () => false })), /HydraSetup\.exe/);
});

test('the app updates from HydraAppSetup.exe and its own one-line SHA256SUMS-app, from a full release only', () => {
  assert.deepEqual(releaseFromPayload(appPayload(), 'app'), { release: { ...release, installerUrl: `${base}HydraAppSetup.exe`, sumsUrl: `${base}SHA256SUMS-app` } });
  // A release without the app's files (every release before the app) offers the app nothing.
  assert.match(reasonOf(releaseFromPayload(payload(), 'app')), /no HydraAppSetup\.exe/);
  assert.match(reasonOf(releaseFromPayload(appPayload({ assets: appPayload().assets.slice(0, 3) }), 'app')), /no SHA256SUMS-app/);
  // Previews (prereleases, suffixed tags) are never offered.
  assert.match(reasonOf(releaseFromPayload(appPayload({ prerelease: true }), 'app')), /prerelease/);
  assert.match(reasonOf(releaseFromPayload(appPayload({ tag_name: 'v0.25.0-app.1' }), 'app')), /v<x\.y\.z>/);
  const hash = 'c'.repeat(64);
  assert.equal(parseSums(`${hash} *HydraAppSetup.exe\r\n`, 'app'), hash);
  assert.throws(() => parseSums(`${hash}  HydraSetup.exe\n`, 'app'), /SHA256SUMS-app has no HydraAppSetup\.exe line/);
  assert.throws(() => parseSums(`${hash}  HydraAppSetup.exe\n${hash}  HydraSetup.exe\n`, 'app'), /exactly one line/);
});

test('downloadVerified fetches the app\'s installer as HydraAppSetup-<version>.exe and checks it against SHA256SUMS-app', async t => {
  const server = await fixture({
    [`${releasePath}SHA256SUMS-app`]: { body: `${digest(installerBytes)}  HydraAppSetup.exe\n` },
    [`${releasePath}HydraAppSetup.exe`]: { body: installerBytes },
  });
  t.after(() => server.close());
  const dir = await scratch(t);
  const appRelease = { ...release, installerUrl: `${base}HydraAppSetup.exe`, sumsUrl: `${base}SHA256SUMS-app` };
  const result = await downloadVerified(appRelease, dir, { fetch: server.fetch, product: 'app' });
  assert.equal(result.file, path.join(dir, 'HydraAppSetup-0.25.0.exe'));
  assert.equal(result.sha256, digest(installerBytes));
  // The IDE's SHA256SUMS line never verifies the app's installer.
  const wrong = await fixture({
    [`${releasePath}SHA256SUMS-app`]: { body: `${digest(installerBytes)}  HydraSetup.exe\n` },
    [`${releasePath}HydraAppSetup.exe`]: { body: installerBytes },
  });
  t.after(() => wrong.close());
  await assert.rejects(downloadVerified(appRelease, await scratch(t), { fetch: wrong.fetch, product: 'app' }), /SHA256SUMS-app has no HydraAppSetup\.exe line/);
});

test('the app updates itself only as an installed stable release: never a preview, a development copy or an uninstalled one', () => {
  const folder = 'C:\\Users\\n\\AppData\\Local\\Programs\\Hydra App';
  const input = { platform: 'win32', production: true, execPath: `${folder}\\Hydra.exe`, exists: (file: string) => file === `${folder}\\unins000.exe`, product: 'app' as const };
  assert.deepEqual(updateEligibility({ ...input, channel: 'stable' }), { eligible: true, installDir: folder });
  for (const channel of ['preview', undefined, 'Stable']) assert.match(reasonOf(updateEligibility({ ...input, channel })), /preview/);
  assert.match(reasonOf(updateEligibility({ ...input, channel: 'stable', production: false })), /development copy/);
  assert.match(reasonOf(updateEligibility({ ...input, channel: 'stable', exists: () => false })), /HydraAppSetup\.exe/);
});

test('the app\'s update helper stops its archive\'s bridges and runs HydraAppSetup.exe in update mode', () => {
  assert.deepEqual([...appInstallerArguments], ['/HYDRAUPDATE=1', '/SILENT', '/SP-', '/SUPPRESSMSGBOXES', '/NORESTART']);
  const script = updateHelperScript({ installer: 'C:\\t\\HydraAppSetup-0.25.0.exe', installDir: 'C:\\Hydra App', exe: 'C:\\Hydra App\\Hydra.exe', log: 'C:\\t\\log', product: 'app' });
  assert.ok(script.includes("-ArgumentList '/HYDRAUPDATE=1','/SILENT','/SP-','/SUPPRESSMSGBOXES','/NORESTART' -Wait"));
  for (const name of helperBridgeScripts) assert.ok(script.includes(`'\\resources\\app.asar\\dist\\${name}'`), name);
  assert.ok(!script.includes('hydra-agent-manager'));
  assert.ok(!script.includes('/MERGETASKS'), 'update mode refuses task changes');
});
