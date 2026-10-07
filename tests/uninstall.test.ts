import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { attentionHookGroups, codexNotifyCommand, limitHookGroup, limitHookPaths } from '../src/core/claudeLimitHook';
import { addClaudeAllowRule, addCodexBlock, addCodexNotify, addGuidanceBlock, providerPaths, type HelperServerSpec } from '../src/core/helperRegistration';
import { addClaudeLimitHook } from '../src/core/claudeLimitHook';
import { cleanupInstall, codexBlockCommand, insideInstall, removeClaudeServer, type CleanupOptions } from '../src/core/uninstallCleanup';

const app = 'C:\\Users\\n\\AppData\\Local\\Programs\\Hydra';
const other = 'C:\\Dev\\hydra-build\\Hydra';
const specFor = (root: string): HelperServerSpec => ({ command: `${root}\\Hydra.exe`, args: [`${root}\\resources\\app\\extensions\\hydra-agent-manager\\dist\\hydra-mcp.cjs`], env: { ELECTRON_RUN_AS_NODE: '1', HYDRA_HELPERS_DIR: 'C:\\Users\\n\\AppData\\Roaming\\Hydra\\helpers' } });
const hookProgram = (root: string) => ({ executable: `${root}\\Hydra.exe`, script: `${root}\\resources\\app\\extensions\\hydra-agent-manager\\dist\\hydra-limit-hook.cjs`, eventsDir: 'C:\\Users\\n\\AppData\\Roaming\\Hydra\\User\\globalStorage\\limit-events', platform: 'win32' as const, systemRoot: 'C:\\Windows' });
const hookFor = (root: string) => limitHookGroup(hookProgram(root));

// Needs_You_Plan.md, Phase 4: the Stop and Notification hooks and Codex's notifier go with the rest, byte for byte.
const attentionFor = (root: string) => attentionHookGroups(hookProgram(root));
const notifyFor = (root: string) => codexNotifyCommand(hookProgram(root));

test('ownership: only paths inside this installation, compared the way Windows does', () => {
  assert.equal(insideInstall(`${app}\\Hydra.exe`, app, 'win32'), true);
  assert.equal(insideInstall(`${app.toUpperCase()}\\HYDRA.EXE`, app, 'win32'), true, 'case-insensitive');
  assert.equal(insideInstall(`${app.replace(/\\/g, '/')}/Hydra.exe`, app, 'win32'), true, 'forward slashes');
  assert.equal(insideInstall(`${app}\\resources\\..\\Hydra.exe`, `${app}\\`, 'win32'), true, 'normalised, trailing separator');
  assert.equal(insideInstall(app, app, 'win32'), true);
  assert.equal(insideInstall(`${app}\\..\\Hydra-other\\Hydra.exe`, app, 'win32'), false, 'no .. escape');
  assert.equal(insideInstall(`${app}-old\\Hydra.exe`, app, 'win32'), false, 'a sibling with the same prefix');
  assert.equal(insideInstall(`${other}\\Hydra.exe`, app, 'win32'), false);
  assert.equal(insideInstall('Hydra.exe', app, 'win32'), false, 'relative');
  assert.equal(insideInstall('C:Hydra\\Hydra.exe', 'C:Hydra', 'win32'), false, 'drive-relative');
  assert.equal(insideInstall('\\Users\\n\\AppData\\Local\\Programs\\Hydra\\Hydra.exe', app, 'win32'), false, 'rooted without a drive');
  assert.equal(insideInstall('C:\\Windows\\notepad.exe', 'C:\\', 'win32'), false, 'a drive root is never an installation');
  assert.equal(insideInstall('\\\\server\\share\\x.exe', '\\\\server\\share\\', 'win32'), false, 'a share root neither');
  assert.equal(insideInstall('\\\\server\\share\\Hydra\\Hydra.exe', '\\\\server\\share\\Hydra', 'win32'), true);
  for (const bad of [undefined, 42, '', `${app}\\Hydra.exe\0`, `${app}\n\\Hydra.exe`]) assert.equal(insideInstall(bad, app, 'win32'), false);
  assert.equal(insideInstall('/opt/Hydra/hydra', '/opt/Hydra', 'linux'), true);
  assert.equal(insideInstall('/opt/hydra/hydra', '/opt/Hydra', 'linux'), false, 'case matters off Windows');
  assert.equal(insideInstall('/opt/x', '/', 'linux'), false);
});

test('the hook group\'s executable and script read back from both of its forms', () => {
  const quoted = limitHookGroup({ executable: 'C:\\O\'Brien\u2019s\\Hydra.exe', script: 'C:\\O\'Brien\u2019s\\hydra-limit-hook.cjs', eventsDir: 'C:\\e', platform: 'win32', systemRoot: 'C:\\Windows' });
  assert.deepEqual(limitHookPaths(quoted), { executable: 'C:\\O\'Brien\u2019s\\Hydra.exe', script: 'C:\\O\'Brien\u2019s\\hydra-limit-hook.cjs' });
  assert.deepEqual(limitHookPaths(limitHookGroup({ executable: '/opt/Hydra/hydra', script: '/opt/Hydra/hydra-limit-hook.cjs', eventsDir: '/e', platform: 'linux' })), { executable: '/opt/Hydra/hydra', script: '/opt/Hydra/hydra-limit-hook.cjs' });
  assert.deepEqual(limitHookPaths({ matcher: 'rate_limit', hooks: [{ type: 'command', command: 'notify hydra-limit-hook' }] }), {});
  assert.deepEqual(limitHookPaths({ matcher: 'x', hooks: [{ type: 'command', command: 'echo hi' }] }), {});
});

test('the MCP entry comes out of ~/.claude.json with every other byte kept', () => {
  const keep = { type: 'stdio', command: 'npx', args: ['keep-me'] };
  const hydra = { type: 'stdio', command: `${app}\\Hydra.exe`, args: [] };
  const cases: [Record<string, unknown>, Record<string, unknown>][] = [
    [{ numStartups: 3, mcpServers: { 'keep-me': keep } }, { numStartups: 3, mcpServers: { 'keep-me': keep, hydra } }],
    [{ mcpServers: { 'keep-me': keep }, x: 1 }, { mcpServers: { hydra, 'keep-me': keep }, x: 1 }],
    [{ mcpServers: { a: keep, b: keep } }, { mcpServers: { a: keep, hydra, b: keep } }],
    [{ mcpServers: {}, x: [1] }, { mcpServers: { hydra }, x: [1] }],
  ];
  for (const [before, connected] of cases) {
    assert.equal(removeClaudeServer(JSON.stringify(connected, null, 2)), JSON.stringify(before, null, 2));
    assert.equal(removeClaudeServer(JSON.stringify(connected, null, 2).replace(/\n/g, '\r\n')), JSON.stringify(before, null, 2).replace(/\n/g, '\r\n'), 'CRLF');
  }
  assert.equal(removeClaudeServer('{"mcpServers":{"other":{}}}'), '{"mcpServers":{"other":{}}}');
  assert.equal(codexBlockCommand(addCodexBlock('model = "x"\n', specFor(app))), `${app}\\Hydra.exe`);
  assert.equal(codexBlockCommand('model = "x"\n'), undefined);
});

// ---- The whole cleanup against a temporary HOME ----

interface Home { root: string; paths: ReturnType<typeof providerPaths>; originals: { claudeJson: string; settings: string; codex: string; agents: string } }
async function home(owner: string, options: { hydraAgents?: boolean } = {}): Promise<Home> {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-uninstall-'));
  const paths = providerPaths({ CLAUDE_CONFIG_DIR: path.join(root, '.claude'), CODEX_HOME: path.join(root, '.codex') });
  await mkdir(path.dirname(paths.claudeSettings), { recursive: true });
  await mkdir(path.dirname(paths.codexConfig), { recursive: true });
  const originals = {
    claudeJson: JSON.stringify({ numStartups: 4, mcpServers: { 'keep-me': { type: 'stdio', command: 'npx', args: ['-y', 'keep-me'], env: {} } }, projects: {} }, null, 2),
    settings: '{\n  "permissions": {\n    "allow": [\n      "Bash(npm test)"\n    ]\n  },\n  "hooks": {\n    "Stop": [\n      { "hooks": [{ "type": "command", "command": "echo done" }] }\n    ]\n  }\n}\n',
    codex: 'model = "gpt-5"\r\n\r\n[mcp_servers.keep-me]\r\ncommand = "npx"\r\n',
    agents: options.hydraAgents ? '' : '# My rules\n\nBe brief.\n',
  };
  const spec = specFor(owner);
  const claudeJson = JSON.parse(originals.claudeJson) as { mcpServers: Record<string, unknown> };
  claudeJson.mcpServers.hydra = { type: 'stdio', command: spec.command, args: spec.args, env: spec.env, timeout: 3_600_000 };
  await writeFile(paths.claudeJson, JSON.stringify(claudeJson, null, 2));
  await writeFile(paths.claudeSettings, addClaudeLimitHook(addClaudeAllowRule(originals.settings), hookFor(owner), attentionFor(owner)));
  await writeFile(paths.codexConfig, addCodexNotify(addCodexBlock(originals.codex, spec), notifyFor(owner)));
  await writeFile(path.join(root, '.codex', 'AGENTS.md'), addGuidanceBlock(originals.agents));
  return { root, paths, originals };
}
const snapshot = async (h: Home) => Promise.all([h.paths.claudeJson, h.paths.claudeSettings, h.paths.codexConfig, path.join(h.root, '.codex', 'AGENTS.md')].map(file => readFile(file, 'utf8').catch(() => undefined)));
const run = (h: Home, extra: Partial<CleanupOptions> = {}) => { const lines: string[] = []; return cleanupInstall({ app, paths: h.paths, platform: 'win32', log: line => lines.push(line), ...extra }).then(report => ({ report, lines })); };

test('uninstalling removes this installation\'s entries and keeps everything else byte-for-byte', async () => {
  const h = await home(app);
  try {
    const { report } = await run(h);
    assert.deepEqual(report, { claudeServer: true, claudeAllowRule: true, claudeLimitHook: true, codexBlock: true, codexGuidance: true });
    const [claudeJson, settings, codex, agents] = await snapshot(h);
    assert.equal(claudeJson, h.originals.claudeJson);
    assert.equal(settings, h.originals.settings);
    assert.equal(codex, h.originals.codex);
    assert.equal(agents, h.originals.agents);
  } finally { await rm(h.root, { recursive: true, force: true }); }
});

test('a guidance-only AGENTS.md that Hydra created is removed with the block', async () => {
  const h = await home(app, { hydraAgents: true });
  try {
    assert.equal((await run(h)).report.codexGuidance, true);
    assert.equal(existsSync(path.join(h.root, '.codex', 'AGENTS.md')), false);
  } finally { await rm(h.root, { recursive: true, force: true }); }
});

test('another Hydra\'s entries, and the path-less rule and guidance with them, are left alone', async () => {
  const h = await home(other);
  try {
    const before = await snapshot(h);
    const { report, lines } = await run(h);
    assert.deepEqual(report, { claudeServer: false, claudeAllowRule: false, claudeLimitHook: false, codexBlock: false, codexGuidance: false });
    assert.deepEqual(await snapshot(h), before);
    assert.ok(lines.some(line => /belongs to another Hydra/.test(line)));
  } finally { await rm(h.root, { recursive: true, force: true }); }
});

test('the allow rule stays when only this install\'s hook is present (another Hydra owns the server)', async () => {
  const h = await home(other);
  try {
    // This install's hook replaced the other one's, but the MCP entry is still the other Hydra's.
    const settings = await readFile(h.paths.claudeSettings, 'utf8');
    await writeFile(h.paths.claudeSettings, addClaudeLimitHook(settings, hookFor(app)));
    const { report } = await run(h);
    assert.equal(report.claudeLimitHook, true);
    assert.equal(report.claudeAllowRule, false);
    const after = await readFile(h.paths.claudeSettings, 'utf8');
    assert.equal(after, addClaudeAllowRule(h.originals.settings), 'the rule stays for the other Hydra');
  } finally { await rm(h.root, { recursive: true, force: true }); }
});

test('the Claude CLI removes the entry when there is one, with a direct edit if it fails', async () => {
  const h = await home(app);
  try {
    const calls: string[][] = [];
    const cli = async (_executable: string, args: string[]) => { calls.push(args); await writeFile(h.paths.claudeJson, h.originals.claudeJson); return 0; };
    assert.equal((await run(h, { claude: 'C:\\claude.exe', runClaude: cli })).report.claudeServer, true);
    assert.deepEqual(calls, [['mcp', 'remove', '-s', 'user', 'hydra']]);
  } finally { await rm(h.root, { recursive: true, force: true }); }
  const failing = await home(app);
  try {
    const { report, lines } = await run(failing, { claude: 'C:\\claude.exe', runClaude: async () => 1 });
    assert.equal(report.claudeServer, true);
    assert.ok(lines.some(line => /did not remove the entry \(exit 1\)/.test(line)));
    assert.equal(await readFile(failing.paths.claudeJson, 'utf8'), failing.originals.claudeJson);
  } finally { await rm(failing.root, { recursive: true, force: true }); }
  const foreign = await home(other);
  try {
    let called = false;
    await run(foreign, { claude: 'C:\\claude.exe', runClaude: async () => { called = true; return 0; } });
    assert.equal(called, false, 'the CLI is never run for another Hydra\'s entry');
  } finally { await rm(foreign.root, { recursive: true, force: true }); }
});

test('a ~/.claude.json changed underneath is retried, and one that keeps changing is left alone', async () => {
  const h = await home(app);
  try {
    // Claude rewrites the file (one more startup) between our read and write, once.
    const beforeWrite = async (file: string, attempt: number) => {
      if (file !== h.paths.claudeJson || attempt !== 1) return;
      const current = JSON.parse(await readFile(file, 'utf8')) as { numStartups: number };
      current.numStartups = 5;
      await writeFile(file, JSON.stringify(current, null, 2));
    };
    const { report, lines } = await run(h, { beforeWrite });
    assert.equal(report.claudeServer, true);
    assert.ok(lines.some(line => /changed while editing; trying again/.test(line)));
    assert.equal(await readFile(h.paths.claudeJson, 'utf8'), h.originals.claudeJson.replace('"numStartups": 4', '"numStartups": 5'));
  } finally { await rm(h.root, { recursive: true, force: true }); }
  const busy = await home(app);
  try {
    let startups = 10;
    const beforeWrite = async (file: string) => {
      if (file !== busy.paths.claudeJson) return;
      const current = JSON.parse(await readFile(file, 'utf8')) as { numStartups: number };
      current.numStartups = startups++;
      await writeFile(file, JSON.stringify(current, null, 2));
    };
    const { report, lines } = await run(busy, { beforeWrite });
    assert.equal(report.claudeServer, false);
    assert.equal(report.claudeAllowRule, false, 'the rule stays while the entry does');
    assert.ok(lines.some(line => /gave up/.test(line)));
    assert.ok((JSON.parse(await readFile(busy.paths.claudeJson, 'utf8')) as { mcpServers: Record<string, unknown> }).mcpServers.hydra, 'the entry is still there');
  } finally { await rm(busy.root, { recursive: true, force: true }); }
});

test('broken or missing files never throw', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-uninstall-'));
  try {
    const paths = providerPaths({ CLAUDE_CONFIG_DIR: path.join(root, '.claude'), CODEX_HOME: path.join(root, '.codex') });
    assert.deepEqual((await cleanupInstall({ app, paths, platform: 'win32' })).claudeServer, false, 'nothing there');
    await mkdir(paths.claudeJson, { recursive: true });
    await mkdir(path.dirname(paths.claudeSettings), { recursive: true });
    await writeFile(paths.claudeSettings, '{ not json');
    await mkdir(path.dirname(paths.codexConfig), { recursive: true });
    await writeFile(paths.codexConfig, `x = 1\n# >>> Hydra helpers (managed by Hydra: connect or disconnect in Hydra Settings)\n[mcp_servers.hydra]\ncommand = '${app}\\Hydra.exe'\n`);
    const lines: string[] = [];
    const report = await cleanupInstall({ app, paths, platform: 'win32', log: line => lines.push(line) });
    assert.equal(report.codexBlock, false);
    assert.ok(lines.some(line => /^skipped/.test(line)));
    assert.equal(await readFile(paths.codexConfig, 'utf8'), `x = 1\n# >>> Hydra helpers (managed by Hydra: connect or disconnect in Hydra Settings)\n[mcp_servers.hydra]\ncommand = '${app}\\Hydra.exe'\n`);
    assert.equal((await cleanupInstall({ app: 'C:\\', paths, platform: 'win32' })).claudeServer, false, 'a drive root claims nothing');
    assert.equal((await cleanupInstall({ app: '', paths, platform: 'win32' })).claudeServer, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a dry run reports what it would remove and changes nothing', async () => {
  const h = await home(app);
  try {
    const before = await snapshot(h);
    let called = false;
    const { report, lines } = await run(h, { dryRun: true, claude: 'C:\\claude.exe', runClaude: async () => { called = true; return 0; } });
    assert.deepEqual(report, { claudeServer: true, claudeAllowRule: true, claudeLimitHook: true, codexBlock: true, codexGuidance: true });
    assert.deepEqual(await snapshot(h), before);
    assert.equal(called, false);
    assert.ok(lines.every(line => !/^removed/.test(line)) && lines.some(line => /^would remove/.test(line)));
  } finally { await rm(h.root, { recursive: true, force: true }); }
});
