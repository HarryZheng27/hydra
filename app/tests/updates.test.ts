import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { releasesLatestUrl, type FetchLike } from '../../src/core/updateCheck';
import { AppUpdates, createUpdateStore, parseUpdateState, type AppUpdatesDeps, type UpdateDialog } from '../src/main/updates';

const installDir = 'C:\\Users\\n\\AppData\\Local\\Programs\\Hydra App';
const tag = 'v0.29.0';
const base = `https://github.com/ndunl075/hydra/releases/download/${tag}/`;
const installer = Buffer.from('MZ the Hydra app installer '.repeat(2000));
const sha = createHash('sha256').update(installer).digest('hex');

function release(extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag, prerelease: false, draft: false, html_url: `https://github.com/ndunl075/hydra/releases/tag/${tag}`,
    assets: [
      { name: 'HydraSetup.exe', browser_download_url: `${base}HydraSetup.exe` },
      { name: 'SHA256SUMS', browser_download_url: `${base}SHA256SUMS` },
      { name: 'HydraAppSetup.exe', browser_download_url: `${base}HydraAppSetup.exe` },
      { name: 'SHA256SUMS-app', browser_download_url: `${base}SHA256SUMS-app` },
    ],
    ...extra,
  };
}

/** GitHub, faked: the latest release, its checksum file and the app's installer. Records every URL asked for. */
function github(payload: unknown = release(), sums = `${sha}  HydraAppSetup.exe\n`) {
  const asked: string[] = [];
  const fetch: FetchLike = async url => {
    asked.push(url);
    if (url === releasesLatestUrl) return new Response(JSON.stringify(payload), { status: 200 });
    if (url === `${base}SHA256SUMS-app`) return new Response(sums, { status: 200 });
    if (url === `${base}HydraAppSetup.exe`) return new Response(installer, { status: 200, headers: { 'content-length': String(installer.length) } });
    return new Response('', { status: 404 });
  };
  return { fetch, asked };
}

async function harness(t: { after(fn: () => Promise<void>): void }, overrides: Partial<AppUpdatesDeps> & { answers?: number[] } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-app-updates-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const asked: UpdateDialog[] = [], told: string[] = [], helpers: string[] = [], progress: Array<number | undefined> = [];
  let quit = 0;
  const answers = [...(overrides.answers ?? [])];
  const deps: AppUpdatesDeps = {
    version: '0.28.0', channel: 'stable', packaged: true, platform: 'win32',
    execPath: `${installDir}\\Hydra.exe`, exists: file => file === `${installDir}\\unins000.exe`,
    store: createUpdateStore(dir), tempDir: dir,
    ask: async dialog => { asked.push(dialog); return answers.shift() ?? dialog.cancelId; },
    tell: async message => { told.push(message); },
    openExternal: async () => undefined,
    progress: fraction => { progress.push(fraction); },
    quit: () => { quit++; },
    startHelper: async helper => { helpers.push(helper); },
    log: () => undefined,
    ...overrides,
  };
  return { updates: new AppUpdates(deps), deps, dir, asked, told, helpers, progress, quits: () => quit };
}

test('a preview or development copy of the app never checks for updates, and Settings says why', async t => {
  for (const [overrides, reason] of [[{ channel: 'preview' }, /preview/], [{ channel: undefined }, /preview/], [{ packaged: false }, /development copy/], [{ exists: () => false }, /HydraAppSetup\.exe/]] as const) {
    const server = github();
    const { updates, told } = await harness(t, { ...overrides, fetch: server.fetch });
    const status = await updates.status();
    assert.equal(status.available, false);
    assert.match(status.reason ?? '', reason);
    await updates.check(true);
    assert.match(told[0] ?? '', reason);
    assert.deepEqual(server.asked, [], 'nothing is fetched');
  }
});

test('an installed stable app offers a newer release, downloads HydraAppSetup.exe checked against SHA256SUMS-app, and on Install and restart starts the helper in update mode and quits', async t => {
  const server = github();
  const { updates, asked, helpers, progress, quits, dir } = await harness(t, { fetch: server.fetch, answers: [0, 0] });
  await updates.check(false);
  assert.deepEqual(asked.map(dialog => dialog.buttons), [['Update', 'Release notes', 'Skip this version', 'Later'], ['Install and restart', 'Not now']]);
  assert.match(asked[1]!.message, /Install Hydra 0\.29\.0\?/);
  // The IDE's installer and SHA256SUMS are never asked for.
  assert.ok(!server.asked.some(url => url.endsWith('/HydraSetup.exe') || url.endsWith('/SHA256SUMS')));
  const downloaded = path.join(dir, 'hydra-app-update', 'HydraAppSetup-0.29.0.exe');
  assert.deepEqual(await readFile(downloaded), installer);
  assert.equal(progress.at(-1), undefined, 'the taskbar progress is cleared');
  assert.equal(helpers.length, 1);
  const script = (await readFile(helpers[0]!, 'utf8')).replace(/^\uFEFF/, '');
  assert.ok(script.includes(`$installer = '${downloaded}'`));
  assert.ok(script.includes(`$installDir = '${installDir}'`));
  assert.ok(script.includes("-ArgumentList '/HYDRAUPDATE=1','/SILENT','/SP-','/SUPPRESSMSGBOXES','/NORESTART' -Wait"));
  assert.ok(script.includes("'\\resources\\app.asar\\dist\\hydra-mcp.cjs'"));
  assert.equal(quits(), 1);
});

test('the app\'s update needs every click: Later, Not now and a mismatched download install nothing', async t => {
  {
    const { updates, helpers, quits, dir } = await harness(t, { fetch: github().fetch, answers: [3] });
    await updates.check(false);
    assert.deepEqual(await readdir(dir).then(names => names.filter(name => name !== 'updates.json')), [], 'Later downloads nothing');
    assert.equal(helpers.length + quits(), 0);
  }
  {
    const { updates, helpers, quits, dir } = await harness(t, { fetch: github().fetch, answers: [0, 1] });
    await updates.check(false);
    assert.deepEqual(await readdir(path.join(dir, 'hydra-app-update')), ['HydraAppSetup-0.29.0.exe'], 'Not now keeps the verified installer for next time');
    assert.equal(helpers.length + quits(), 0);
  }
  {
    const { updates, helpers, quits, told, dir } = await harness(t, { fetch: github(release(), `${'0'.repeat(64)}  HydraAppSetup.exe\n`).fetch, answers: [0, 0] });
    await updates.check(false);
    assert.match(told[0] ?? '', /doesn't match SHA256SUMS-app/);
    assert.deepEqual(await readdir(path.join(dir, 'hydra-app-update')), [], 'the mismatched download is deleted');
    assert.equal(helpers.length + quits(), 0);
  }
});

test('the app is offered only full releases with its own installer; Skip this version quiets the daily check, not a manual one', async t => {
  for (const payload of [release({ prerelease: true }), release({ tag_name: 'v0.29.0-app.1' }), release({ assets: release().assets.slice(0, 2) })]) {
    const { updates, asked } = await harness(t, { fetch: github(payload).fetch });
    await updates.check(false);
    assert.deepEqual(asked, [], JSON.stringify(payload).slice(0, 80));
  }
  const { updates, asked, deps } = await harness(t, { fetch: github().fetch, answers: [2] });
  await updates.check(false);
  assert.equal((await deps.store.load()).skipped, '0.29.0');
  await updates.check(false);
  assert.equal(asked.length, 1, 'the daily check stays quiet about a skipped version');
  await updates.check(true);
  assert.equal(asked.length, 2, 'a manual check still offers it');
  // The daily check can be turned off from Settings.
  assert.equal((await updates.setAutomatic(false)).automatic, false);
  assert.equal((await deps.store.load()).automatic, false);
});

test('the app\'s update state file is checked like its other stores', () => {
  assert.deepEqual(parseUpdateState({ version: 1, automatic: true }), { version: 1, automatic: true });
  assert.deepEqual(parseUpdateState({ version: 1, automatic: false, lastCheck: 5, skipped: '1.2.3' }), { version: 1, automatic: false, lastCheck: 5, skipped: '1.2.3' });
  for (const bad of [null, [], { version: 2, automatic: true }, { version: 1 }, { version: 1, automatic: 'yes' }, { version: 1, automatic: true, extra: 1 },
    { version: 1, automatic: true, skipped: '1.2' }, { version: 1, automatic: true, skipped: '1.2.3-x' }, { version: 1, automatic: true, lastCheck: Number.NaN }]) {
    assert.equal(parseUpdateState(bad), undefined, JSON.stringify(bad));
  }
});

test('the app\'s install confirm counts the heads and lanes the restart stops, and quitting abandons a download', async t => {
  const { updates, asked } = await harness(t, { fetch: github().fetch, answers: [0, 1], running: async () => ({ heads: 2, lanes: 1, stopped: true }) });
  await updates.check(false);
  assert.match(asked[1]!.detail ?? '', /2 heads and 1 lane are running and will be stopped\./);
  assert.match(asked[1]!.detail ?? '', /Stop All Agents is on/);
  // A download that never finishes: quitting aborts it, with no error shown and nothing left behind.
  const stalled: FetchLike = async (url, init) => {
    if (url === releasesLatestUrl) return new Response(JSON.stringify(release()), { status: 200 });
    if (url.endsWith('SHA256SUMS-app')) return new Response(`${sha}  HydraAppSetup.exe\n`, { status: 200 });
    return new Response(new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array(10)); init.signal?.addEventListener('abort', () => stream.error(new Error('aborted'))); } }), { status: 200 });
  };
  const quitting = await harness(t, { fetch: stalled, answers: [0] });
  const checking = quitting.updates.check(false);
  for (let wait = 0; wait < 100 && !(await readdir(path.join(quitting.dir, 'hydra-app-update')).then(names => names.length > 0, () => false)); wait++) await new Promise(resolve => setTimeout(resolve, 20));
  quitting.updates.stop();
  await checking;
  assert.deepEqual(quitting.told, []);
  assert.deepEqual(await readdir(path.join(quitting.dir, 'hydra-app-update')), [], 'the partial download is removed');
  assert.equal(quitting.helpers.length + quitting.quits(), 0);
});
