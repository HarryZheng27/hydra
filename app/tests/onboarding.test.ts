import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openSignIn, providerStatus, registrationStatus, signInArgs, signInLaunch, type Spawner } from '../src/main/onboarding';
import { standinCalls, writeStandins } from '../smoke/standins.mjs';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-app-onboarding-'));
const windows = process.platform === 'win32';
const decode = (args: string[]) => Buffer.from(args[args.indexOf('-EncodedCommand') + 1]!, 'base64').toString('utf16le');

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
  const launch = signInLaunch('claude', "C:\\Users\\O'Neil\\claude.exe");
  assert.match(launch.executable, /powershell\.exe$/i);
  const script = decode(launch.args);
  assert.ok(script.includes("& 'C:\\Users\\O''Neil\\claude.exe' 'auth' 'login' '--claudeai'"), script);
  assert.match(script, /WindowTitle = 'Claude Code sign-in'/);
  assert.match(script, /Read-Host 'Press Enter to close this window'/);
  assert.match(decode(signInLaunch('codex', 'C:\\x\\codex.cmd').args), /& 'C:\\x\\codex\.cmd' 'login'/);
  assert.throws(() => signInLaunch('codex', 'C:\\x\ny.exe'));
});

test('Sign in opens a window it never reads, and does nothing when the CLI is missing', { skip: !windows }, async () => {
  const dir = writeStandins(scratch(), { codex: false });
  try {
    const spawned: Array<{ executable: string; args: string[]; options: unknown }> = [];
    const fake: Spawner = (executable, args, options) => { spawned.push({ executable, args, options }); return { unref: () => undefined, once: () => undefined }; };
    assert.deepEqual(await openSignIn('claude', path.join(dir, 'claude.cmd'), dir, fake), { started: true });
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0]!.options, { cwd: dir, detached: true, windowsHide: false, stdio: 'ignore' });
    assert.match(decode(spawned[0]!.args), /claude\.cmd' 'auth' 'login' '--claudeai'/);
    const missing = await openSignIn('codex', path.join(dir, 'codex.cmd'), dir, fake);
    assert.equal(missing.started, false);
    assert.equal(spawned.length, 1, 'nothing was started for a missing CLI');
    assert.deepEqual(standinCalls(dir), [], 'the CLI itself was never run here');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('onboarding never imports the self-check that starts a provider', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'onboarding.ts'), 'utf8');
  assert.ok(!source.includes("from '../../../src/core/cliSelfCheck'"));
  assert.ok(!/selfCheckCli\(/.test(source));
});
