import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHandlers } from '../src/main/handlers';
import { openSignIn, providerStatus, registrationStatus, signInArgs, signInLaunch, signInScript, type Spawner } from '../src/main/onboarding';
import { standinCalls, writeStandins } from '../smoke/standins.mjs';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-app-onboarding-'));
const windows = process.platform === 'win32';

test('onboarding finds each CLI, reads its version, and runs nothing but the version and help checks', { skip: !windows }, async () => {
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
    assert.deepEqual(standinCalls(dir), ['claude --version', 'claude --help', 'codex --version', 'codex --help', 'codex app-server --help']);
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

test('Sign in runs the CLI\'s own login in a console window, quoted, and waits for Enter', () => {
  assert.deepEqual(signInArgs, { claude: ['auth', 'login', '--claudeai'], codex: ['login'] });
  const script = signInScript('claude', "C:\\Users\\O'Neil\\claude.exe");
  assert.ok(script.includes("& 'C:\\Users\\O''Neil\\claude.exe' 'auth' 'login' '--claudeai'"), script);
  assert.match(script, /WindowTitle = 'Claude Code sign-in'/);
  assert.match(script, /Read-Host 'Press Enter to close this window'/);
  assert.match(signInScript('codex', 'C:\\x\\codex.cmd'), /& 'C:\\x\\codex\.cmd' 'login'/);
  assert.throws(() => signInScript('codex', 'C:\\x\ny.exe'));
  // cmd's `start` gives PowerShell its own console; cmd sees only the title, PowerShell's path and base64.
  const launch = signInLaunch('codex', 'C:\\Users\\a&b %PATH% "q"\\codex.cmd');
  assert.match(launch.executable, /cmd\.exe$/i);
  const match = /^\/d \/s \/c "start "Codex sign-in" "([^"]+powershell\.exe)" -NoLogo -NoProfile -EncodedCommand ([A-Za-z0-9+/=]+)"$/.exec(launch.commandLine);
  assert.ok(match, launch.commandLine);
  assert.ok(!launch.commandLine.includes('a&b') && !launch.commandLine.includes('%PATH%'), 'the CLI path never reaches cmd');
  assert.equal(Buffer.from(match[2]!, 'base64').toString('utf16le'), signInScript('codex', 'C:\\Users\\a&b %PATH% "q"\\codex.cmd'));
});

test('Sign in opens a window it never reads, and does nothing when the CLI is missing', { skip: !windows }, async () => {
  const dir = writeStandins(scratch(), { codex: false });
  try {
    const spawned: Array<{ executable: string; args: string[]; options: unknown }> = [];
    let exitCode = 0;
    const fake: Spawner = (executable, args, options) => {
      spawned.push({ executable, args, options });
      return { once: (event: string, listener: (value: never) => void) => { if (event === 'exit') setTimeout(() => listener(exitCode as never), 5); } } as never;
    };
    assert.deepEqual(await openSignIn('claude', path.join(dir, 'claude.cmd'), dir, fake), { started: true });
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0]!.options, { cwd: dir, windowsHide: true, windowsVerbatimArguments: true, stdio: 'ignore' });
    assert.match(spawned[0]!.executable, /cmd\.exe$/i);
    assert.equal(spawned[0]!.args.length, 1);
    assert.match(Buffer.from(/-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(spawned[0]!.args[0]!)![1]!, 'base64').toString('utf16le'), /claude\.cmd' 'auth' 'login' '--claudeai'/);
    exitCode = 1;
    assert.equal((await openSignIn('claude', path.join(dir, 'claude.cmd'), dir, fake)).started, false, 'a start that fails is not reported as opened');
    const missing = await openSignIn('codex', path.join(dir, 'codex.cmd'), dir, fake);
    assert.equal(missing.started, false);
    assert.equal(spawned.length, 2, 'nothing was started for a missing CLI');
    assert.deepEqual(standinCalls(dir), [], 'the CLI itself was never run here');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a page can\'t stack sign-in windows or checks: one sign-in per provider at a time, and a refresh joins a running check', async () => {
  const signIns: string[] = [];
  let checks = 0;
  let nextStart = true;
  const releases: Array<() => void> = [];
  const store = { load: async () => ({ version: 1, theme: 'system', cliPaths: {} }) } as never;
  const handlers = createHandlers({
    info: { name: 'Hydra', version: '0', electron: '44', platform: 'win32' }, settings: store, state: store,
    pickFolder: async () => undefined, pickExecutable: async () => undefined, applyTheme: () => undefined,
    checkSetup: () => { const n = ++checks; return new Promise(resolve => { releases.push(() => resolve({ providers: [], registration: {} as never, checkedAt: String(n) })); }); },
    signIn: async provider => { signIns.push(provider); return nextStart ? { started: true } : { started: false, error: 'missing' }; },
    confirmTrust: async () => false,
    chats: {} as never,
  });
  const tick = () => new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(await handlers['onboarding.signIn']({ provider: 'claude' }), { started: true });
  assert.equal((await handlers['onboarding.signIn']({ provider: 'claude' })).started, false, 'a second window straight away is refused');
  nextStart = false;
  assert.equal((await handlers['onboarding.signIn']({ provider: 'codex' })).error, 'missing');
  nextStart = true;
  assert.deepEqual(await handlers['onboarding.signIn']({ provider: 'codex' }), { started: true }, 'a failed try can be retried at once');
  assert.deepEqual(signIns, ['claude', 'codex', 'codex']);

  // A plain check joins the running one; refreshes during it share one fresh check after it, never the older answer.
  const first = handlers['onboarding.check']({ refresh: false });
  await tick();
  const joined = handlers['onboarding.check']({ refresh: false });
  const refreshes = [handlers['onboarding.check']({ refresh: true }), handlers['onboarding.check']({ refresh: true })];
  await tick();
  assert.equal(checks, 1);
  releases.shift()!();
  await tick();
  assert.equal(checks, 2, 'one follow-up check for both refreshes');
  releases.shift()!();
  assert.deepEqual([(await first).checkedAt, (await joined).checkedAt], ['1', '1']);
  assert.deepEqual((await Promise.all(refreshes)).map(report => report.checkedAt), ['2', '2']);
  assert.equal((await handlers['onboarding.check']({ refresh: false })).checkedAt, '2', 'the latest answer is remembered');
  assert.equal(checks, 2);
});

test('onboarding never imports the self-check that starts a provider', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'onboarding.ts'), 'utf8');
  assert.ok(!source.includes("from '../../../src/core/cliSelfCheck'"));
  assert.ok(!/selfCheckCli\(/.test(source));
});
