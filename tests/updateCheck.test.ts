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
  releasesLatestUrl, runningNotice, updateEligibility, updateHelperFileContents, updateHelperScript, type FetchLike, type LatestRelease,
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
