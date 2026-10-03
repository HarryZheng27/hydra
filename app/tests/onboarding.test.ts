import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHandlers } from '../src/main/handlers';
import { spawn } from 'node:child_process';
import { accountStatus, providerStatus, registrationStatus, signIn, signInArgs, statusArgs } from '../src/main/onboarding';
import { standinCalls, writeStandins } from '../smoke/standins.mjs';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-app-onboarding-'));
const windows = process.platform === 'win32';

test('onboarding finds each CLI, reads its version, and runs nothing but the version, help and sign-in status checks', { skip: !windows }, async () => {
  const dir = writeStandins(scratch());
  try {
    const claude = await providerStatus('claude', path.join(dir, 'claude.cmd'), dir);
    assert.equal(claude.found, true);
    assert.equal(claude.version, '2.1.282');
    assert.equal(claude.supported, true);
    assert.equal(claude.error, undefined);
    assert.ok(claude.advertised?.includes('Structured output'));
    const codex = await providerStatus('codex', path.join(dir, 'codex.cmd'), dir);
    assert.equal(codex.version, '0.157.1');
    assert.equal(codex.supported, true);
    assert.equal(claude.account, 'signed-out');
    assert.equal(codex.account, 'signed-in');
    assert.deepEqual(standinCalls(dir), ['claude --version', 'claude --help', 'claude auth status --json', 'codex --version', 'codex --help', 'codex app-server --help', 'codex login status']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an old CLI is found but not supported, and a missing one says so', { skip: !windows }, async () => {
  const dir = writeStandins(scratch(), { claude: '2.0.5', codex: false });
  try {
    const claude = await providerStatus('claude', path.join(dir, 'claude.cmd'), dir);
    assert.equal(claude.found, true);
    assert.equal(claude.supported, false);
    assert.match(claude.error ?? '', /needs Claude Code 2\.1\.270 or newer/);
    const missing = await providerStatus('codex', path.join(dir, 'codex.cmd'), dir);
    assert.equal(missing.found, false);
    assert.match(missing.error ?? '', /can't find/);
    const relative = await providerStatus('codex', 'codex.cmd', dir);
    assert.equal(relative.found, false);
    const savedPath = process.env.PATH;
    process.env.PATH = dir;
    try { assert.match((await providerStatus('codex', undefined, dir)).error ?? '', /isn't on your PATH/); } finally { process.env.PATH = savedPath; }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the hydra registration is read from Claude\'s and Codex\'s config files, and nothing is written', async () => {
  const dir = scratch();
  try {
    const paths = { claudeJson: path.join(dir, '.claude.json'), claudeSettings: path.join(dir, 'settings.json'), codexConfig: path.join(dir, 'config.toml'), claudeProjects: path.join(dir, 'projects') };
    assert.deepEqual(await registrationStatus(paths), { claude: { registered: false, where: paths.claudeJson }, codex: { registered: false, where: paths.codexConfig } });
    fs.writeFileSync(paths.claudeJson, JSON.stringify({ mcpServers: { hydra: { command: 'C:/Hydra/Hydra.exe', args: ['x'], env: { HYDRA_TOKEN: 'secret' } } } }));
    fs.writeFileSync(paths.codexConfig, 'model = "x"\n# >>> Hydra helpers (managed by Hydra: connect or disconnect in Hydra Settings)\n[mcp_servers.hydra]\ncommand = \'C:/Hydra/Hydra.exe\'\n# <<< Hydra helpers\n');
    const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const before = [hash(paths.claudeJson), hash(paths.codexConfig)];
    const found = await registrationStatus(paths);
    assert.equal(found.claude.registered, true);
    assert.equal(found.codex.registered, true);
    assert.equal(JSON.stringify(found).includes('secret'), false, 'no value from the files comes back');
    assert.deepEqual([hash(paths.claudeJson), hash(paths.codexConfig)], before);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['.claude.json', 'config.toml']);
    fs.writeFileSync(paths.claudeJson, '{ broken');
    assert.equal((await registrationStatus(paths)).claude.registered, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Sign in runs the CLI\'s own login out of sight, reads none of its output, then asks the CLI whether it worked', { skip: !windows }, async () => {
  const dir = writeStandins(scratch(), { codex: false });
  try {
    assert.deepEqual(signInArgs, { claude: ['auth', 'login', '--claudeai'] });
    assert.deepEqual(statusArgs, { claude: ['auth', 'status', '--json'], codex: ['login', 'status'] });
    const exe = path.join(dir, 'claude.cmd');
    assert.equal(await accountStatus('claude', exe, dir), 'signed-out');
    const started: Array<{ args: readonly string[]; options: Record<string, unknown> }> = [];
    const recording = ((executable: string, args: readonly string[], options: Record<string, unknown>) => { started.push({ args, options }); return spawn(executable, args, options); }) as never;
    const result = await signIn('claude', exe, dir, { openUrl: async () => { throw new Error('Claude opens its own browser'); }, spawn: recording });
    assert.deepEqual(result, { signedIn: true });
    assert.equal(started.length, 1);
    assert.equal(started[0]!.options.windowsHide, true, 'no window');
    assert.deepEqual(started[0]!.options.stdio, ['pipe', 'ignore', 'ignore'], 'its output is never read');
    assert.deepEqual(standinCalls(dir), ['claude auth status --json', 'claude auth login --claudeai', 'claude auth status --json']);
    assert.equal(await accountStatus('claude', exe, dir), 'signed-in');

    const missing = await signIn('codex', path.join(dir, 'codex.cmd'), dir, { openUrl: async () => true });
    assert.equal(missing.signedIn, false);
    assert.match(missing.error ?? '', /isn't installed/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a sign-in that never finishes is ended after the timeout and reported', { skip: !windows }, async () => {
  const dir = scratch();
  try {
    // A login that waits for ever (as one would if the browser never came back).
    fs.writeFileSync(path.join(dir, 'claude.cmd'), '@echo off\r\nif "%~1"=="auth" if "%~2"=="status" (echo {"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}& exit /b 1)\r\nping -n 6 127.0.0.1 >nul\r\n');
    const result = await signIn('claude', path.join(dir, 'claude.cmd'), dir, { openUrl: async () => true, timeoutMs: 1500 });
    assert.equal(result.signedIn, false);
    assert.match(result.error ?? '', /didn't finish/);
  } finally { await new Promise(resolve => setTimeout(resolve, 500)); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a page can\'t stack sign-ins or checks: one sign-in per provider at a time, and a refresh joins a running check', async () => {
  const signIns: string[] = [];
  let checks = 0;
  let nextStart = true;
  let finishSignIn = () => undefined as void;
  const tick = () => new Promise(resolve => setTimeout(resolve, 10));
  const releases: Array<() => void> = [];
  const store = { load: async () => ({ version: 1, theme: 'system', cliPaths: {} }) } as never;
  const handlers = createHandlers({
    info: { name: 'Hydra', version: '0', electron: '44', platform: 'win32' }, settings: store, state: store,
    pickFolder: async () => undefined, pickExecutable: async () => undefined, applyTheme: () => undefined,
    checkSetup: () => { const n = ++checks; return new Promise(resolve => { releases.push(() => resolve({ providers: [], registration: {} as never, checkedAt: String(n) })); }); },
    signIn: provider => { signIns.push(provider); return new Promise(resolve => { finishSignIn = () => resolve(nextStart ? { signedIn: true } : { signedIn: false, error: 'missing' }); }); },
    confirmTrust: async () => false,
    chats: {} as never,
  });
  const first = handlers['onboarding.signIn']({ provider: 'claude' });
  await tick();
  assert.match((await handlers['onboarding.signIn']({ provider: 'claude' })).error ?? '', /already/, 'a second sign-in while one runs is refused');
  finishSignIn();
  assert.deepEqual(await first, { signedIn: true });
  nextStart = false;
  const failed = handlers['onboarding.signIn']({ provider: 'codex' });
  await tick();
  finishSignIn();
  assert.equal((await failed).error, 'missing');
  nextStart = true;
  const retry = handlers['onboarding.signIn']({ provider: 'codex' });
  await tick();
  finishSignIn();
  assert.deepEqual(await retry, { signedIn: true }, 'a failed try can be retried at once');
  assert.deepEqual(signIns, ['claude', 'codex', 'codex']);

  // A plain check joins the running one; refreshes during it share one fresh check after it, never the older answer.
  const firstCheck = handlers['onboarding.check']({ refresh: false });
  await tick();
  const joined = handlers['onboarding.check']({ refresh: false });
  const refreshes = [handlers['onboarding.check']({ refresh: true }), handlers['onboarding.check']({ refresh: true })];
  await tick();
  assert.equal(checks, 1);
  releases.shift()!();
  await tick();
  assert.equal(checks, 2, 'one follow-up check for both refreshes');
  releases.shift()!();
  assert.deepEqual([(await firstCheck).checkedAt, (await joined).checkedAt], ['1', '1']);
  assert.deepEqual((await Promise.all(refreshes)).map(report => report.checkedAt), ['2', '2']);
  assert.equal((await handlers['onboarding.check']({ refresh: false })).checkedAt, '2', 'the latest answer is remembered');
  assert.equal(checks, 2);
});

test('onboarding never imports the self-check that starts a provider', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'onboarding.ts'), 'utf8');
  assert.ok(!source.includes("from '../../../src/core/cliSelfCheck'"));
  assert.ok(!/selfCheckCli\(/.test(source));
});
