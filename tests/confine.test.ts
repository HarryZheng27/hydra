import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../src/core/git';
import { JobStore } from '../src/core/jobs';
import { HelperEndpoint, callHelperEndpoint } from '../src/core/helperEndpoint';
import { HelperService, commitAll, helperPrompt } from '../src/core/helperService';
import { claudeHelperArguments, codexHelperArguments, type HelperRun, type HelperRunSpec } from '../src/core/helperRunner';
import {
  bashQuote, claudeHeadTools, codexCarry, codexIsolationArguments, confinedEnvironment, guardScript, headEnvironment, headSettings, headShellSentence, homeFolders, insideScript, laneSettings,
  rulePath, ruleCovers, sandboxEnvironmentPolicy, sandboxProfile, sandboxProfileToml, secretTargets, settingsProblems, storageReadDeny, treeScript, userPluginIds, wrapperScript, type HeadShell, type StorageListing,
} from '../src/core/confine';
import { userClaudePlugins } from '../src/core/confineFiles';
import { HeadSandbox, codexSandboxExecutable, findGitBash, type CommandSandbox, type WrappedCommand } from '../src/core/headSandbox';
import { runCommandGate } from '../src/core/gates/command';
import { defaultGateRuntime, type GateRuntime } from '../src/core/gates';
import { LaneStore } from '../src/core/lanes';
import { LaneService, laneLaunch } from '../src/core/laneService';
import { fakePtyModule } from './lanePtyFake';

/**
 * Step 2: confining heads, and light limits for lanes. The settings
 * files, tool lists, environments and wrapper are built by confine.ts from typed inputs; these tests
 * pin them exactly, since Claude Code silently ignores a whole settings file with one bad value.
 */

// ---- Rule paths ----

test('rule paths: //c/... on Windows, //... elsewhere; never a drive, a top folder or a UNC path; pattern characters only widen', () => {
  assert.equal(rulePath('C:\\Users\\me\\.ssh', 'win32'), '//c/Users/me/.ssh');
  assert.equal(rulePath('D:/Work/repo.worktrees/abc/', 'win32'), '//d/Work/repo.worktrees/abc');
  assert.equal(rulePath('/c/Users/me', 'win32'), '//c/Users/me', 'a Git Bash HOME');
  assert.equal(rulePath('C:\\Program Files (x86)\\x', 'win32'), '//c/Program Files (x86)/x', 'parentheses are literal in rules');
  assert.equal(rulePath('C:\\a[b]\\c', 'win32'), '//c/a?b?/c');
  for (const bad of ['C:\\', 'C:\\Users', '\\\\server\\share\\x', 'relative\\x', '', 'C:\\x\u0000\\y']) assert.equal(rulePath(bad, 'win32'), undefined, JSON.stringify(bad));
  assert.equal(rulePath('/home/me/.ssh', 'linux'), '//home/me/.ssh');
  assert.equal(rulePath('/home/me/a*b?[c]\\d', 'linux'), '//home/me/a?b??c??d');
  for (const bad of ['/', '/home', 'home/me']) assert.equal(rulePath(bad, 'linux'), undefined, bad);
  assert.ok(ruleCovers('Read(//c/Users/me/**)', '//c/users/ME/x', 'win32'), 'Windows paths ignore case');
  assert.ok(ruleCovers('Read(//c/a?b/**)', '//c/aXb/c', 'win32'));
  assert.ok(ruleCovers('Read(//c/wt/aaa/sub/**)', '//c/wt/aaa', 'win32'), 'a rule inside the folder hides part of it');
  assert.ok(!ruleCovers('Read(//c/wt/bbb/**)', '//c/wt/aaa', 'win32'));
  assert.ok(!ruleCovers('Read(//c/wt/aa/**)', '//c/wt/aaa', 'win32'));
});

test('home folders: USERPROFILE, and HOME only when it is another folder; their secret places, CLAUDE_CONFIG_DIR and CODEX_HOME', () => {
  assert.deepEqual(homeFolders({ USERPROFILE: 'C:\\Users\\me', HOME: 'D:\\home\\me' }, 'win32'), ['C:\\Users\\me', 'D:\\home\\me']);
  assert.deepEqual(homeFolders({ USERPROFILE: 'C:\\Users\\me', HOME: 'c:\\users\\ME\\' }, 'win32'), ['C:\\Users\\me'], 'the same folder, spelled differently');
  assert.deepEqual(homeFolders({ userprofile: 'C:\\Users\\me', HOME: '/c/Users/me' }, 'win32'), ['C:\\Users\\me'], 'names ignore case; a Git Bash HOME is the same folder');
  const targets = secretTargets({ USERPROFILE: 'C:\\Users\\me', HOME: 'D:\\home\\me', CLAUDE_CONFIG_DIR: 'E:\\claude-config', CODEX_HOME: 'E:\\codex' }, 'win32');
  const paths = targets.map(target => `${target.path}${target.dir ? '\\' : ''}`);
  for (const home of ['C:\\Users\\me', 'D:\\home\\me']) {
    for (const folder of ['.ssh', '.aws', '.azure', '.config\\gcloud', '.kube', '.docker', '.codex', '.claude', 'AppData\\Roaming\\gcloud', 'AppData\\Roaming\\GitHub CLI']) assert.ok(paths.includes(`${home}\\${folder}\\`), `${home}\\${folder}`);
    for (const file of ['.claude.json', '.git-credentials', '.npmrc', '.netrc']) assert.ok(paths.includes(`${home}\\${file}`), `${home}\\${file}`);
  }
  assert.ok(paths.includes('E:\\claude-config\\') && paths.includes('E:\\codex\\'));
});

// ---- Settings files ----

const winHome = { USERPROFILE: 'C:\\Users\\me' };
const homeRules = [
  ...['.ssh', '.aws', '.azure', '.config/gcloud', '.kube', '.docker', '.codex', '.claude', 'AppData/Roaming/gcloud', 'AppData/Roaming/GitHub CLI'].flatMap(folder => [`Read(//c/Users/me/${folder}/**)`, `Edit(//c/Users/me/${folder}/**)`]),
  ...['.claude.json', '.git-credentials', '.npmrc', '.netrc'].flatMap(file => [`Read(//c/Users/me/${file})`, `Edit(//c/Users/me/${file})`]),
];

test('a Claude head\'s settings: exactly the read block and the deny pairs, and nothing else', () => {
  const settings = headSettings({
    platform: 'win32', env: winHome, storage: 'C:\\Data\\Hydra', storageRead: [{ path: 'C:\\Data\\Hydra', dir: true }],
    worktree: 'C:\\wt\\aaa', addDirs: [], otherWorktrees: ['C:\\wt\\bbb', 'C:\\wt\\lane-ccc'], leadFolder: 'C:\\repo',
  });
  assert.deepEqual(settings, { disableAllHooks: true, permissions: { blockReadsOutsideWorkingDirectories: true, deny: [
    'Read(//c/Data/Hydra/**)', 'Edit(//c/Data/Hydra/**)',
    'Read(//c/wt/bbb/**)', 'Edit(//c/wt/bbb/**)', 'Read(//c/wt/lane-ccc/**)', 'Edit(//c/wt/lane-ccc/**)',
    'Read(//c/repo/.hydra/**)', 'Edit(//c/repo/.hydra/**)', 'Read(//c/repo/.git/**)', 'Edit(//c/repo/.git/**)',
    ...homeRules,
  ] } });
  // What goes into the file is what Claude reads back: only known keys, each rule in the form R1 showed works.
  const written = JSON.parse(JSON.stringify(settings, null, 2));
  assert.deepEqual(Object.keys(written), ['disableAllHooks', 'permissions'], 'HSEC-70: every hook off');
  assert.deepEqual(Object.keys(written.permissions).sort(), ['blockReadsOutsideWorkingDirectories', 'deny']);
  for (const rule of written.permissions.deny) assert.match(rule, /^(Read|Edit)\(\/\/c\/[^\\[\]*]+(\/\*\*)?\)$/);
  assert.deepEqual(settingsProblems(written, { platform: 'win32', blockReads: true, readable: ['C:\\wt\\aaa'] }), []);
});

test('the settings checker refuses anything Claude might reject or that would hide the head\'s own files', () => {
  const good = { disableAllHooks: true, permissions: { blockReadsOutsideWorkingDirectories: true, deny: ['Read(//c/Data/Hydra/**)', 'Edit(//c/Data/Hydra/**)'] } };
  const check = (value: unknown, readable: string[] = []) => settingsProblems(value, { platform: 'win32', blockReads: true, readable });
  assert.deepEqual(check(good), []);
  // HSEC-70: a head's hooks are off, exactly; a lane keeps yours.
  assert.match(check({ permissions: good.permissions })[0]!, /a head's hooks must be off/);
  assert.match(check({ ...good, disableAllHooks: false })[0]!, /a head's hooks must be off/);
  assert.match(settingsProblems({ disableAllHooks: true, permissions: { deny: ['Read(//home/me/.ssh/**)'] } }, { platform: 'linux', blockReads: false })[0]!, /a lane keeps your own hooks/);
  assert.match(check({ ...good, sandbox: { enabled: true } })[0]!, /unknown setting "sandbox"/);
  assert.match(check({ ...good, permissions: { ...good.permissions, defaultMode: 'notAMode' } })[0]!, /unknown permission setting "defaultMode"/);
  assert.match(check({ ...good, permissions: { deny: good.permissions.deny } })[0]!, /reads outside the worktree must be blocked/);
  for (const rule of ['Read(C:\\Users\\me\\.ssh)', 'Bash(rm -rf *)', 'Read(//C/Users/me/x)', 'Read(//c/Users)', 'Read(//c/a[b]/c)', 'Read(//c/a/**/b)', 'Read(~/.ssh/**)', 7]) {
    assert.match(check({ ...good, permissions: { ...good.permissions, deny: [rule] } })[0]!, /isn't a Read or Edit rule on an absolute path/, String(rule));
  }
  assert.match(check({ ...good, permissions: { ...good.permissions, deny: ['Read(//c/x/y)', 'Read(//c/x/y)'] } })[0]!, /listed twice/);
  assert.match(check(good, ['C:\\Data\\Hydra\\packs\\cache\\kit'])[0]!, /would stop it reading/);
  // A worktree inside the storage folder would be hidden from its own head: it doesn't start.
  assert.throws(() => headSettings({ platform: 'win32', env: winHome, storage: 'C:\\Data\\Hydra', storageRead: [{ path: 'C:\\Data\\Hydra', dir: true }], worktree: 'C:\\Data\\Hydra\\wt\\aaa', addDirs: [], otherWorktrees: [], leadFolder: 'C:\\repo' }), /would stop it reading C:\\Data\\Hydra\\wt\\aaa/);
  assert.deepEqual(settingsProblems({ permissions: { deny: ['Read(//home/me/.ssh/**)'] } }, { platform: 'linux', blockReads: false }), []);
  assert.match(settingsProblems({ permissions: { deny: ['Read(//home/me/.ssh/**)'], blockReadsOutsideWorkingDirectories: true } }, { platform: 'linux', blockReads: false })[0]!, /a lane keeps your own read settings/);
});

test('a Claude head turns your plugins off, and the checker lets enabledPlugins only turn plugins off, and only for a head', async () => {
  // From settings.json's enabledPlugins and installed_plugins.json: deduplicated, sorted, odd ids left out, bad text ignored.
  const settingsText = '\uFEFF' + JSON.stringify({ enabledPlugins: { 'claude-mem@thedotmack': true, 'off@market': false, 'bad id@x': true, '"quoted"@x': true }, hooks: {} });
  const installedText = JSON.stringify({ version: 2, plugins: { 'claude-mem@thedotmack': [{ scope: 'user' }], 'tools@other.market': [{ scope: 'project' }], 'noMarket': [] } });
  assert.deepEqual(userPluginIds(settingsText, installedText), ['claude-mem@thedotmack', 'off@market', 'tools@other.market']);
  assert.deepEqual(userPluginIds(undefined, '{not json'), []);
  assert.deepEqual(userPluginIds('null', '{"plugins": []}'), []);

  const input = { platform: 'win32' as const, env: winHome, storage: 'C:\\Data\\Hydra', storageRead: [{ path: 'C:\\Data\\Hydra', dir: true }], worktree: 'C:\\wt\\aaa', addDirs: [], otherWorktrees: [], leadFolder: 'C:\\repo' };
  const settings = headSettings({ ...input, userPlugins: ['tools@other.market', 'claude-mem@thedotmack', 'claude-mem@thedotmack', 'bad id@x'] });
  assert.deepEqual(settings.enabledPlugins, { 'claude-mem@thedotmack': false, 'tools@other.market': false });
  assert.equal(settings.permissions.blockReadsOutsideWorkingDirectories, true, 'the read block and deny rules are unchanged');
  assert.deepEqual(Object.keys(headSettings(input)), ['disableAllHooks', 'permissions'], 'no plugins, no key');
  assert.deepEqual(settingsProblems(JSON.parse(JSON.stringify(settings)), { platform: 'win32', blockReads: true, readable: ['C:\\wt\\aaa'] }), []);

  const check = (enabledPlugins: unknown, blockReads = true) => settingsProblems({ ...settings, permissions: blockReads ? settings.permissions : { deny: settings.permissions.deny }, enabledPlugins }, { platform: 'win32', blockReads });
  assert.match(check({ 'claude-mem@thedotmack': true })[0]!, /doesn't turn a plugin off/, 'never turns one on');
  assert.match(check({ 'bad id@x': false })[0]!, /doesn't turn a plugin off/);
  assert.match(check({})[0]!, /non-empty object/);
  assert.match(check(['claude-mem@thedotmack'])[0]!, /non-empty object/);
  assert.ok(check({ 'claude-mem@thedotmack': false }, false).some(problem => /a lane keeps your own plugins/.test(problem)));
  assert.match(settingsProblems({ ...settings, hooks: {} }, { platform: 'win32', blockReads: true })[0]!, /unknown setting "hooks"/, 'still an allowlist');

  // Read from CLAUDE_CONFIG_DIR, where the head's Claude Code finds them.
  const folder = await mkdtemp(path.join(tmpdir(), 'hydra-plugins-'));
  try {
    await mkdir(path.join(folder, 'plugins'));
    await writeFile(path.join(folder, 'settings.json'), settingsText);
    await writeFile(path.join(folder, 'plugins', 'installed_plugins.json'), installedText);
    assert.deepEqual(await userClaudePlugins({ CLAUDE_CONFIG_DIR: folder }), ['claude-mem@thedotmack', 'off@market', 'tools@other.market']);
    assert.deepEqual(await userClaudePlugins({ CLAUDE_CONFIG_DIR: path.join(folder, 'missing') }), [], 'no files, no plugins');
  } finally { await rm(folder, { recursive: true, force: true }); }
});

const storage = 'C:\\Users\\me\\AppData\\Roaming\\Hydra\\User\\globalStorage\\nico-dunlap.hydra-agent-manager';
const cache = `${storage}\\packs\\cache`;
const copy = `${cache}\\kit-abc123abc123`, plugin = `${cache}\\kit-abc123abc123.plugins\\builder`;
const listing: StorageListing = new Map([
  [storage, [{ name: 'workspaces', dir: true }, { name: 'helpers', dir: true }, { name: 'packs', dir: true }, { name: 'state.json', dir: false }]],
  [`${storage}\\packs`, [{ name: 'allowed.json', dir: false }, { name: 'cache', dir: true }]],
  [cache, [{ name: 'kit-abc123abc123', dir: true }, { name: 'kit-abc123abc123.plugins', dir: true }, { name: 'other-999999999999', dir: true }]],
  [`${cache}\\kit-abc123abc123.plugins`, [{ name: 'builder', dir: true }, { name: 'reviewer', dir: true }]],
]);

test('Hydra\'s storage: reads denied entry by entry around a role\'s pack copy, which is never under a Read deny; edits denied on all of it', () => {
  const read = storageReadDeny(storage, [copy, plugin], listing, 'win32');
  assert.deepEqual(read.map(item => `${item.path.slice(storage.length)}${item.dir ? '\\**' : ''}`), [
    '\\workspaces\\**', '\\helpers\\**', '\\packs\\allowed.json', '\\packs\\cache\\kit-abc123abc123.plugins\\reviewer\\**', '\\packs\\cache\\other-999999999999\\**', '\\state.json',
  ]);
  const settings = headSettings({ platform: 'win32', env: winHome, storage, storageRead: read, worktree: 'C:\\wt\\aaa', addDirs: [copy], otherWorktrees: [], leadFolder: 'C:\\repo' });
  const deny = settings.permissions.deny;
  assert.ok(deny.includes('Edit(//c/Users/me/AppData/Roaming/Hydra/User/globalStorage/nico-dunlap.hydra-agent-manager/**)'), 'the pack copy can\'t be written');
  assert.ok(!deny.some(rule => rule.startsWith('Read(') && (ruleCovers(rule, rulePath(copy, 'win32')!, 'win32') || ruleCovers(rule, rulePath(plugin, 'win32')!, 'win32'))), 'the copy and the plugin stay readable');
  assert.ok(deny.includes('Read(//c/Users/me/AppData/Roaming/Hydra/User/globalStorage/nico-dunlap.hydra-agent-manager/packs/allowed.json)'), 'the allow record is a file rule');
  // Nothing to keep, or a folder on the way that couldn't be listed: the whole folder, which is safe.
  assert.deepEqual(storageReadDeny(storage, [], listing, 'win32'), [{ path: storage, dir: true }]);
  assert.deepEqual(storageReadDeny(storage, [copy], new Map([[storage, listing.get(storage)!]]), 'win32'), [{ path: storage, dir: true }]);
  assert.deepEqual(storageReadDeny(storage, ['D:\\elsewhere\\kit'], listing, 'win32'), [{ path: storage, dir: true }], 'a copy outside the storage folder changes nothing');
});

test('a Claude lane\'s settings: only the deny pairs for Hydra\'s storage and the other worktrees, and no read block', () => {
  const read = storageReadDeny(storage, [copy, plugin], listing, 'win32');
  const settings = laneSettings({ platform: 'win32', storage, storageRead: read, worktree: 'C:\\wt\\lane-aaa', readable: [copy, plugin], otherWorktrees: ['C:\\wt\\bbb', 'C:\\wt\\lane-ccc'] });
  assert.deepEqual(Object.keys(settings.permissions), ['deny']);
  const prefix = '//c/Users/me/AppData/Roaming/Hydra/User/globalStorage/nico-dunlap.hydra-agent-manager';
  assert.deepEqual(settings.permissions.deny, [
    `Read(${prefix}/workspaces/**)`, `Read(${prefix}/helpers/**)`, `Read(${prefix}/packs/allowed.json)`, `Read(${prefix}/packs/cache/kit-abc123abc123.plugins/reviewer/**)`, `Read(${prefix}/packs/cache/other-999999999999/**)`, `Read(${prefix}/state.json)`,
    `Edit(${prefix}/**)`,
    'Read(//c/wt/bbb/**)', 'Edit(//c/wt/bbb/**)', 'Read(//c/wt/lane-ccc/**)', 'Edit(//c/wt/lane-ccc/**)',
  ]);
  assert.ok(!settings.permissions.deny.some(rule => rule.includes('/.ssh')), 'your own secrets are yours: a lane is your terminal');
  // laneLaunch passes it on every launch of a Claude lane, fresh or resumed.
  const base = { lane: { id: 'a'.repeat(12), name: 'L', branch: 'lane/l-aaa', provider: 'claude' as const }, executable: 'C:\\bin\\claude.exe', resume: false, connected: true, bridge: { command: 'Hydra.exe', args: ['b.cjs'], env: {} }, mcpConfigFile: 'C:\\s\\lane.mcp.json', helpersDir: 'C:\\h', env: {}, settingsFile: 'C:\\s\\lane.settings.json' };
  assert.deepEqual(laneLaunch({ ...base, prompt: 'Go' }).args, ['--settings', 'C:\\s\\lane.settings.json', 'Go']);
  assert.deepEqual(laneLaunch({ ...base, resume: true }).args, ['--continue', '--settings', 'C:\\s\\lane.settings.json']);
  assert.ok(!laneLaunch({ ...base, lane: { ...base.lane, provider: 'codex' }, executable: 'C:\\bin\\codex.exe' }).args.includes('--settings'), 'Codex lanes are unchanged');
});

// ---- Tools and arguments ----

test('a Claude head\'s tools: an explicit list, writes only inside the worktree, PowerShell never, Bash only with a shell', () => {
  const plain = claudeHeadTools(false);
  assert.deepEqual(plain.tools, ['Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep']);
  assert.deepEqual(plain.allowed, ['Glob', 'Grep', 'Edit(/**)', 'Write(/**)', 'NotebookEdit(/**)', 'mcp__hydra__hydra_done', 'mcp__hydra__hydra_stuck', 'mcp__hydra__hydra_progress']);
  const shell = claudeHeadTools(true, ['Skill', 'mcp__kit-local', 'WebSearch', 'WebFetch']);
  assert.deepEqual(shell.tools, ['Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep', 'Bash', 'Skill', 'WebSearch', 'WebFetch']);
  assert.deepEqual(shell.allowed, ['Glob', 'Grep', 'Edit(/**)', 'Write(/**)', 'NotebookEdit(/**)', 'Bash', 'mcp__hydra__hydra_done', 'mcp__hydra__hydra_stuck', 'mcp__hydra__hydra_progress', 'Skill', 'mcp__kit-local', 'WebSearch', 'WebFetch']);
  for (const list of [plain.tools, plain.allowed, shell.tools, shell.allowed]) assert.ok(!list.some(tool => /powershell/i.test(tool)));
  for (const list of [plain.allowed, shell.allowed]) assert.ok(!list.some(tool => ['Read', 'Edit', 'Write', 'NotebookEdit'].includes(tool)), 'no bare Read, Edit or Write: outside writes stay denied (R1)');
  assert.deepEqual(claudeHeadTools(false, ['PowerShell', 'Bash', 'Edit', 'mcp__x(y)', 'Skill']).allowed.slice(-1), ['Skill'], 'a role adds only its skills, web and servers');
});

const spec = (extra: Partial<HelperRunSpec> = {}): HelperRunSpec => ({
  provider: 'claude', executable: 'claude', worktree: 'C:\\wt\\aaa', prompt: 'P', maxTurns: 7, maxBudgetUsd: 2,
  bridge: { command: 'Hydra.exe', args: ['b.cjs'], env: { HYDRA_HELPER_TOKEN: 'tok', HYDRA_HELPER_PORT: '1' } }, logFile: 'l',
  confine: { settingsFile: 'C:\\logs\\aaa-1.settings.json', addDirs: [], shell: false, env: {} }, ...extra,
});
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

test('Claude head arguments: user settings only, its settings file, its tool lists; Bash and the MCP marker only with the sandbox', () => {
  const off = claudeHelperArguments(spec());
  assert.equal(flag(off, '--setting-sources'), 'user');
  assert.equal(flag(off, '--settings'), 'C:\\logs\\aaa-1.settings.json');
  assert.equal(flag(off, '--permission-mode'), 'dontAsk');
  assert.equal(flag(off, '--tools'), 'Read,Edit,Write,NotebookEdit,Glob,Grep');
  assert.ok(!off.join(' ').includes('Bash') && !off.join(' ').includes('PowerShell'));
  assert.ok(!off.join(' ').includes('HYDRA_SHELL_DIRECT'), 'no wrapper, no marker');
  assert.ok(!off.includes('--add-dir'));

  const sandboxed = claudeHelperArguments(spec({ confine: { settingsFile: 'C:\\logs\\aaa-1.settings.json', addDirs: [], shell: true, env: { CLAUDE_CODE_SHELL_PREFIX: 'C:\\h\\hydra-shell.sh' } } }));
  assert.equal(flag(sandboxed, '--tools'), 'Read,Edit,Write,NotebookEdit,Glob,Grep,Bash');
  assert.match(flag(sandboxed, '--allowedTools')!, /,Bash,/);
  const inline = JSON.parse(sandboxed.find(arg => arg.startsWith('--mcp-config={'))!.slice('--mcp-config='.length));
  assert.equal(inline.mcpServers.hydra.env.HYDRA_SHELL_DIRECT, '1', 'Hydra\'s bridge starts through the wrapper as itself');
  assert.equal(inline.mcpServers.hydra.env.HYDRA_HELPER_TOKEN, 'tok', 'the token still travels inline, never in a file');
  assert.ok(!sandboxed.join(' ').includes('PowerShell'));

  const role = { mcpConfigFile: 'C:\\logs\\aaa.mcp.json', pluginDir: 'C:\\cache\\kit.plugins\\builder', allowedTools: ['Skill', 'mcp__kit-local', 'WebSearch', 'WebFetch'], codexConfig: [], webSearch: 'live' as const, env: {} };
  const withRole = claudeHelperArguments(spec({ role, confine: { settingsFile: 'C:\\logs\\aaa-1.settings.json', addDirs: ['C:\\cache\\kit-abc'], shell: true, env: {} } }));
  assert.equal(flag(withRole, '--tools'), 'Read,Edit,Write,NotebookEdit,Glob,Grep,Bash,Skill,WebSearch,WebFetch');
  assert.deepEqual(withRole.slice(withRole.indexOf('--add-dir'), withRole.indexOf('--add-dir') + 2), ['--add-dir', 'C:\\cache\\kit-abc'], 'the role\'s pack copy is readable through --add-dir');
  assert.ok(withRole.indexOf('--add-dir') > withRole.indexOf('--strict-mcp-config'));
  assert.equal(flag(withRole, '--plugin-dir'), role.pluginDir);
  assert.throws(() => claudeHelperArguments(spec({ confine: { addDirs: [], shell: false, env: {} } })), /needs its settings file/);
});

test('Codex head arguments are as before: workspace-write, approval never; the environment carries the confinement', () => {
  const codex = codexHelperArguments(spec({ provider: 'codex' }));
  assert.ok(codex.includes('workspace-write') && codex.includes("approval_policy='never'"));
  assert.ok(!codex.some(arg => /--settings|--tools|deny/.test(arg)), 'no read-deny profiles for Codex heads (R4)');
  // HSEC-70: the isolation flags come first, then Hydra's server, the only one; on a resume too.
  const isolation = codexIsolationArguments({ model: 'gpt-x', windowsSandbox: 'elevated' });
  const isolated = codexHelperArguments(spec({ provider: 'codex', confine: { addDirs: [], shell: false, env: {}, codexArgs: isolation } }));
  assert.deepEqual(isolated.slice(0, 2 + isolation.length), ['exec', '--json', ...isolation]);
  assert.ok(isolated.indexOf('--ignore-user-config') < isolated.findIndex(arg => arg.startsWith('mcp_servers.hydra.command=')));
  assert.deepEqual([...new Set(isolated.filter(arg => arg.startsWith('mcp_servers.')).map(arg => arg.split('.')[1]))], ['hydra'], 'no other server');
  const resumed = codexHelperArguments(spec({ provider: 'codex', confine: { addDirs: [], shell: false, env: {}, codexArgs: isolation } }), 'thread-1');
  assert.deepEqual(resumed.slice(0, 3 + isolation.length), ['exec', 'resume', '--json', ...isolation]);
});

test('HSEC-70: Codex heads and reviewers keep only your model, effort, tier and Windows sandbox; everything else of your config stays out', () => {
  const config = [
    '\uFEFFmodel = "gpt-main"', 'model_reasoning_effort = "medium"', "service_tier = 'default'", 'personality = "pragmatic"',
    'developer_instructions = "Call me Sam"', 'notify = ["x.exe"]', 'model_provider = "evil provider"',
    '[windows]', 'sandbox = "elevated"  # set up once', '',
    '[mcp_servers.hydra]', 'command = "Hydra.exe"', 'model = "not-top-level"',
    '[profiles.fast]', 'model = "gpt-fast"', '[[skills.config]]', 'sandbox = "nope"',
  ].join('\r\n');
  assert.deepEqual(codexCarry(config), { model: 'gpt-main', model_reasoning_effort: 'medium', service_tier: 'default', windowsSandbox: 'elevated' });
  assert.deepEqual(codexCarry(undefined), {});
  assert.deepEqual(codexCarry('model = "a b"\nmodel_reasoning_effort = "x\'y"'), {}, 'a value with odd characters is left out');
  const args = codexIsolationArguments(codexCarry(config));
  assert.equal(args[0], '--ignore-user-config');
  for (const feature of ['apps', 'plugins', 'remote_plugin', 'hooks', 'memories', 'browser_use', 'computer_use']) assert.ok(args.includes(`features.${feature}=false`), feature);
  assert.ok(args.includes('skills.include_instructions=false'));
  assert.deepEqual(args.slice(-8), ['-c', "model='gpt-main'", '-c', "model_reasoning_effort='medium'", '-c', "service_tier='default'", '-c', "windows.sandbox='elevated'"]);
  assert.ok(args.every(arg => !/["%^&|<>!]/.test(arg)), 'every value passes a .cmd shim unchanged');
  assert.ok(!codexIsolationArguments({}).some(arg => /model|windows/.test(arg)), 'nothing carried, nothing set');
  assert.ok(!codexIsolationArguments({ model: "x'; rm" }).some(arg => arg.startsWith('model=')), 'never mis-quoted');
});

// ---- Environment ----

const hydraEnv = {
  Path: 'C:\\Windows\\system32;C:\\Program Files\\nodejs', SystemRoot: 'C:\\Windows', PATHEXT: '.COM;.EXE;.CMD', USERPROFILE: 'C:\\Users\\me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
  TEMP: 'C:\\Users\\me\\AppData\\Local\\Temp', JAVA_HOME: 'C:\\jdk', HTTPS_PROXY: 'http://proxy:8080', no_proxy: 'localhost', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe',
  GITHUB_TOKEN: 'gh', AWS_SECRET_ACCESS_KEY: 'aws', NPM_TOKEN: 'npm', MY_APP_SECRET: 's', DB_PASSWORD: 'p', SSH_AUTH_SOCK: 'sock', GIT_ASKPASS: 'askpass', RANDOM_TOOL_SETTING: 'x',
  ANTHROPIC_API_KEY: 'ak', CLAUDE_CODE_OAUTH_TOKEN: 'ct', ANTHROPIC_BASE_URL: 'https://gw', OPENAI_API_KEY: 'ok', CODEX_HOME: 'C:\\codex',
  CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1', ELECTRON_RUN_AS_NODE: '1', VSCODE_PID: '9', CURSOR_TRACE: 'x', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'sdk', HYDRA_SHELL_DIRECT: '1', LOOKUP_KEY: 'role-secret',
};

test('the environment: the allowlist, each provider\'s own sign-in, a role\'s variables; never secrets, editor markers or CLAUDE_CODE_SUBPROCESS_ENV_SCRUB', () => {
  const claude = confinedEnvironment({ base: hydraEnv, platform: 'win32', provider: 'claude', roleNames: ['LOOKUP_KEY'] });
  const codex = confinedEnvironment({ base: hydraEnv, platform: 'win32', provider: 'codex' });
  const gate = confinedEnvironment({ base: hydraEnv, platform: 'win32' });
  for (const env of [claude, codex, gate]) {
    for (const kept of ['Path', 'SystemRoot', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'JAVA_HOME', 'HTTPS_PROXY', 'no_proxy', 'CLAUDE_CODE_GIT_BASH_PATH']) assert.equal(env[kept], hydraEnv[kept as keyof typeof hydraEnv], kept);
    assert.equal(env.TEMP, undefined, 'never the shared TEMP, which Codex\'s sandbox makes writable: Hydra sets its own');
    for (const gone of ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN', 'MY_APP_SECRET', 'DB_PASSWORD', 'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'RANDOM_TOOL_SETTING', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB', 'ELECTRON_RUN_AS_NODE', 'VSCODE_PID', 'CURSOR_TRACE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'HYDRA_SHELL_DIRECT']) assert.equal(env[gone], undefined, gone);
  }
  assert.deepEqual([claude.ANTHROPIC_API_KEY, claude.CLAUDE_CODE_OAUTH_TOKEN, claude.ANTHROPIC_BASE_URL, claude.OPENAI_API_KEY, claude.CODEX_HOME], ['ak', 'ct', 'https://gw', undefined, undefined]);
  assert.deepEqual([codex.OPENAI_API_KEY, codex.CODEX_HOME, codex.ANTHROPIC_API_KEY, codex.CLAUDE_CODE_OAUTH_TOKEN], ['ok', 'C:\\codex', undefined, undefined]);
  assert.deepEqual([gate.ANTHROPIC_API_KEY, gate.OPENAI_API_KEY], [undefined, undefined], 'a gate command gets no sign-in');
  assert.equal(claude.LOOKUP_KEY, 'role-secret', 'a role\'s variable passes: you allowed the pack');
  assert.equal(codex.LOOKUP_KEY, undefined);
  // Hydra's own values are set last and never filtered.
  const set = confinedEnvironment({ base: hydraEnv, platform: 'win32', set: { ELECTRON_RUN_AS_NODE: '1', PORT: '4000', PATH: 'X' } });
  assert.deepEqual([set.ELECTRON_RUN_AS_NODE, set.PORT, set.PATH, set.Path], ['1', '4000', 'X', undefined], 'on Windows one PATH, whatever its case');
  assert.equal(confinedEnvironment({ base: { Path: 'a', PATH: 'b' }, platform: 'linux' }).Path, undefined, 'elsewhere names keep their case');
});

test('a head\'s environment: its own TEMP and TMP, background tasks off, and the wrapper only for a Claude head with a sandboxed shell', () => {
  const sandboxed: HeadShell = { kind: 'sandboxed', wrapper: 'C:\\h\\hydra-shell.sh', gitBin: 'C:\\Program Files\\Git\\bin' };
  const claude = headEnvironment({ base: hydraEnv, platform: 'win32', provider: 'claude', temp: 'C:\\h\\temp\\aaa-1', worktree: 'C:\\wt\\aaa', shell: sandboxed });
  assert.deepEqual([claude.TEMP, claude.TMP], ['C:\\h\\temp\\aaa-1', 'C:\\h\\temp\\aaa-1']);
  assert.deepEqual([claude.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, claude.DISABLE_AUTOUPDATER], ['1', '1']);
  assert.equal(claude.CLAUDE_CODE_SHELL_PREFIX, 'C:\\h\\hydra-shell.sh');
  assert.equal(claude.HYDRA_WT, 'C:\\wt\\aaa');
  assert.equal(claude.PATH, 'C:\\Program Files\\Git\\bin;C:\\Windows\\system32;C:\\Program Files\\nodejs', 'Git\'s bin first, so the `bash` that starts Hydra\'s servers is Git\'s');
  assert.equal(claude.Path, undefined);
  assert.equal(claude.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, undefined, 'it would force permission mode "default", and the head would hang');
  const off = headEnvironment({ base: hydraEnv, platform: 'win32', provider: 'claude', temp: 'T', worktree: 'W', shell: { kind: 'off', reason: 'r' } });
  assert.equal(off.CLAUDE_CODE_SHELL_PREFIX, undefined); assert.equal(off.HYDRA_WT, undefined);
  const codex = headEnvironment({ base: hydraEnv, platform: 'win32', provider: 'codex', temp: 'C:\\h\\temp\\bbb-1', worktree: 'W', shell: sandboxed, roleValues: { KIT_TOKEN: 'v' } });
  assert.equal(codex.CLAUDE_CODE_SHELL_PREFIX, undefined, 'Codex heads keep Codex\'s own sandbox');
  assert.deepEqual([codex.TEMP, codex.TMP, codex.KIT_TOKEN], ['C:\\h\\temp\\bbb-1', 'C:\\h\\temp\\bbb-1', 'v']);
  // HSEC-70: a Claude head loads no CLAUDE.md and no auto memory; a Codex head gets Hydra's own CODEX_HOME when there is one.
  assert.deepEqual([claude.CLAUDE_CODE_DISABLE_CLAUDE_MDS, claude.CLAUDE_CODE_DISABLE_AUTO_MEMORY], ['1', '1']);
  assert.equal(codex.CLAUDE_CODE_DISABLE_CLAUDE_MDS, undefined);
  assert.equal(codex.CODEX_HOME, 'C:\\codex', 'without its own home, your CODEX_HOME as before');
  const ownHome = headEnvironment({ base: hydraEnv, platform: 'win32', provider: 'codex', temp: 'T', worktree: 'W', codexHome: 'C:\\h\\codex-home' });
  assert.equal(ownHome.CODEX_HOME, 'C:\\h\\codex-home');
  assert.equal(headEnvironment({ base: hydraEnv, platform: 'win32', provider: 'claude', temp: 'T', worktree: 'W', codexHome: 'C:\\h\\codex-home' }).CODEX_HOME, undefined, 'a Claude head never gets it');
});

// ---- The wrapper ----

test('the wrapper: Hydra\'s own servers by an environment marker only, the sandbox for everything else, closed when Codex is missing', () => {
  const text = wrapperScript({ codex: 'C:\\Users\\O\'Brien\\codex.exe', bash: 'C:\\Program Files\\Git\\usr\\bin\\bash.exe', inside: 'C:\\h\\in.sh', guard: 'C:\\h\\g.sh', tree: 'C:\\h\\t.ps1', powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' });
  const lines = text.split('\n');
  assert.equal(lines[0], '#!/bin/bash');
  assert.ok(text.indexOf('HYDRA_SHELL_DIRECT') < text.indexOf('codex='), 'the marker is checked before anything else, from the environment');
  assert.ok(!text.includes('eval \''), 'never decided by the command line, which a head writes');
  assert.ok(text.includes(`codex='C:\\Users\\O'\\''Brien\\codex.exe'`), 'paths are quoted, quotes included');
  assert.match(text, /if \[ ! -f "\$codex" \]; then .* exit 126; fi/);
  assert.match(text, /if \[ -z "\$\{HYDRA_WT:-\}" \] \|\| \[ ! -d "\$HYDRA_WT" \]; then .* exit 126; fi/);
  const call = lines.find(line => line.startsWith('"$codex" sandbox'))!;
  assert.ok(call, 'Codex runs as a child, not exec\'d, so the guard can see the wrapper');
  for (const part of ["-c \"windows.sandbox='elevated'\"", `-P ${sandboxProfile}`, '-C "$HYDRA_WT"', `-c ${bashQuote(`permissions.${sandboxProfile}=${sandboxProfileToml}`)}`, ...sandboxEnvironmentPolicy.map(setting => `-c ${bashQuote(setting)}`)]) assert.ok(call.includes(part), part);
  for (const part of ["extends = ':workspace'", 'network = { enabled = true }', "'.claude' = 'read'", "'.hydra' = 'read'"]) assert.ok(sandboxProfileToml.includes(part), part);
  assert.deepEqual([...sandboxEnvironmentPolicy], ["shell_environment_policy.inherit='all'", 'shell_environment_policy.ignore_default_excludes=false', 'shell_environment_policy.exclude=[]', 'shell_environment_policy.include_only=[]', 'shell_environment_policy.set={}']);
  assert.ok(!/'deny'/.test(text), 'no deny entries: each is a lasting access-list entry for every Codex sandbox on the machine (R4)');
  assert.equal(lines[lines.indexOf(call) + 1], 'exit $?');
  assert.equal(bashQuote("a'b"), `'a'\\''b'`);
  const inside = insideScript();
  assert.match(inside, /export TMPDIR="\$TEMP"/); assert.match(inside, /set -m/); assert.match(inside, /kill -9 -- "-\$guard"/);
  const guard = guardScript();
  assert.match(guard, /ps -W \| awk/); assert.match(guard, /kill -9 -- "-\$1"/); assert.match(guard, /\/usr\/bin\/kill -f -W/);
  assert.match(treeScript(), /CreateToolhelp32Snapshot/);
});

test('the wrapper fails closed without Codex, and the marker can\'t be set from the command line', async (t) => {
  const git = process.platform === 'win32' ? await findGitBash(process.env) : undefined;
  if (!git) { t.skip('Git Bash is only on Windows here'); return; }
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-wrapper-'));
  try {
    const wrapper = path.join(root, 'hydra-shell.sh');
    await writeFile(wrapper, wrapperScript({ codex: path.join(root, 'missing', 'codex.exe'), bash: git.bash, inside: 'x', guard: 'x', tree: 'x', powershell: 'x' }));
    const env = { ...process.env, HYDRA_WT: root };
    delete (env as Record<string, string | undefined>).HYDRA_SHELL_DIRECT;
    const run = (line: string, extra: Record<string, string> = {}) => spawnSync(path.join(git.bin, 'bash.exe'), [wrapper, line], { env: { ...env, ...extra }, encoding: 'utf8', cwd: root });
    const closed = run('echo hydra-ran');
    assert.equal(closed.status, 126); assert.doesNotMatch(closed.stdout, /hydra-ran/); assert.match(closed.stderr, /Codex is missing/);
    const sneaky = run('HYDRA_SHELL_DIRECT=1 echo hydra-ran; export HYDRA_SHELL_DIRECT=1; echo hydra-ran');
    assert.equal(sneaky.status, 126, 'the command line never chooses the direct route'); assert.doesNotMatch(sneaky.stdout, /hydra-ran/);
    const direct = run(`${bashQuote(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'))} '/d' '/c' 'echo hydra-direct'`, { HYDRA_SHELL_DIRECT: '1' });
    assert.equal(direct.status, 0, direct.stderr); assert.match(direct.stdout, /hydra-direct/, 'Hydra\'s own servers start as they would without a prefix, cmd switches intact');
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ---- Finding Codex and Git Bash; the check ----

test('Codex\'s own executable from the npm shim, hoisted or nested; Git Bash from its setting, PATH or the usual folders', async () => {
  const files = new Set(['C:\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe', 'D:\\npm\\node_modules\\@openai\\codex-win32-arm64\\vendor\\aarch64-pc-windows-msvc\\bin\\codex.exe', 'E:\\tools\\codex.exe']);
  const has = async (file: string) => files.has(file);
  assert.equal(await codexSandboxExecutable('C:\\npm\\codex.cmd', 'x64', has), [...files][0]);
  assert.equal(await codexSandboxExecutable('D:\\npm\\codex.cmd', 'arm64', has), [...files][1]);
  assert.equal(await codexSandboxExecutable('E:\\tools\\codex.exe', 'x64', has), 'E:\\tools\\codex.exe');
  assert.equal(await codexSandboxExecutable('F:\\npm\\codex.cmd', 'x64', has), undefined);
  const git = new Set(['D:\\Git\\usr\\bin\\bash.exe', 'D:\\Git\\bin\\bash.exe', 'E:\\PortableGit\\cmd\\git.exe', 'E:\\PortableGit\\usr\\bin\\bash.exe', 'E:\\PortableGit\\bin\\bash.exe']);
  const hasGit = async (file: string) => git.has(file);
  assert.deepEqual(await findGitBash({ CLAUDE_CODE_GIT_BASH_PATH: 'D:\\Git\\bin\\bash.exe' }, hasGit), { root: 'D:\\Git', bash: 'D:\\Git\\usr\\bin\\bash.exe', bin: 'D:\\Git\\bin' });
  assert.deepEqual(await findGitBash({ Path: 'C:\\Windows;E:\\PortableGit\\cmd' }, hasGit), { root: 'E:\\PortableGit', bash: 'E:\\PortableGit\\usr\\bin\\bash.exe', bin: 'E:\\PortableGit\\bin' });
  assert.equal(await findGitBash({ Path: 'C:\\Windows' }, hasGit), undefined);
});

test('the check: unconfined off Windows; off without Codex; off when a test write gets out; sandboxed when both runs pass', async (t) => {
  assert.deepEqual(await new HeadSandbox({ folder: 'unused', codex: async () => undefined, platform: 'linux' }).shell(), { kind: 'unconfined' });
  const none = new HeadSandbox({ folder: 'unused', codex: async () => undefined, platform: 'win32' });
  assert.deepEqual(await none.shell(), { kind: 'off', reason: 'Codex isn\'t installed, and a head\'s shell runs in its Windows sandbox' });
  assert.equal(await none.wrap({ executable: 'npm', args: ['test'] }, 'W', 'T'), undefined, 'gate commands run as before');
  assert.equal(headShellSentence(await none.shell()), 'Head shells are off: Codex isn\'t installed, and a head\'s shell runs in its Windows sandbox.');
  assert.equal(headShellSentence({ kind: 'sandboxed', wrapper: 'w', gitBin: 'g' }), 'Head shells run in Codex\'s Windows sandbox.');
  assert.equal(headShellSentence(undefined), 'Head shells are checked when the first head starts.');
  const git = process.platform === 'win32' ? await findGitBash(process.env) : undefined;
  if (!git) { t.skip('the rest needs Git Bash, which is only on Windows here'); return; }
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-check-'));
  try {
    const codex = path.join(root, 'codex.exe'); await writeFile(codex, '');
    // A stand-in for the two runs: the first writes inside (and outside when `escape`), the second answers.
    const fake = (escape: boolean) => async (_executable: string, args: string[], options: { cwd: string; env: Record<string, string> }) => {
      if (options.env.HYDRA_SHELL_DIRECT === '1') return { code: 0, stdout: 'hydra-direct-ok\n', stderr: '', timedOut: false };
      await writeFile(path.join(options.cwd, 'inside.txt'), 'hydra-inside');
      if (escape) await writeFile(path.join(options.cwd, '..', 'outside', 'escape.txt'), 'x');
      assert.equal(args[0], path.join(root, 'sandbox', 'hydra-shell.sh')); assert.match(args[1]!, /^eval '/);
      assert.equal(options.env.HYDRA_WT, options.cwd); assert.equal(options.env.TEMP, path.join(path.dirname(options.cwd), 'temp'));
      return { code: 0, stdout: 'hydra-check-ran\n', stderr: '', timedOut: false };
    };
    const leaky = new HeadSandbox({ folder: path.join(root, 'sandbox'), codex: async () => codex, platform: 'win32', run: fake(true) });
    assert.deepEqual(await leaky.shell(), { kind: 'off', reason: 'Codex\'s sandbox let a test command write outside its folder' });
    const good = new HeadSandbox({ folder: path.join(root, 'sandbox'), codex: async () => codex, platform: 'win32', run: fake(false) });
    const shell = await good.shell();
    assert.deepEqual(shell, { kind: 'sandboxed', wrapper: path.join(root, 'sandbox', 'hydra-shell.sh'), gitBin: git.bin });
    assert.equal(good.status(), shell);
    assert.deepEqual((await readdir(path.join(root, 'sandbox'))).sort(), ['hydra-process-tree.ps1', 'hydra-shell-guard.sh', 'hydra-shell-inside.sh', 'hydra-shell.sh'], 'the scripts stay; the check\'s folders are gone');
    // Gate commands: through the wrapper, the allowlisted environment plus the gate's own, a TEMP of their own.
    const wrapped = (await good.wrap({ executable: 'C:\\tools\\app.exe', args: ['--port', "it's"], env: { PORT: '4000', ELECTRON_RUN_AS_NODE: '1' } }, 'C:\\wt\\aaa', path.join(root, 'gate-temp')))!;
    assert.equal(wrapped.executable, path.join(git.bin, 'bash.exe'));
    assert.deepEqual(wrapped.args, [shell.kind === 'sandboxed' ? shell.wrapper : '', `'C:\\tools\\app.exe' '--port' 'it'\\''s'`]);
    assert.deepEqual([wrapped.environment.PORT, wrapped.environment.ELECTRON_RUN_AS_NODE, wrapped.environment.HYDRA_WT, wrapped.environment.TEMP], ['4000', '1', 'C:\\wt\\aaa', path.join(root, 'gate-temp')]);
    assert.equal(wrapped.environment.GITHUB_TOKEN, undefined);
    await access(path.join(root, 'gate-temp'));
    // npm's .cmd has an extensionless script beside it, which takes arguments as they are.
    await writeFile(path.join(root, 'npm'), '#!/bin/sh\n'); await writeFile(path.join(root, 'npm.cmd'), '');
    assert.equal((await good.wrap({ executable: path.join(root, 'npm.cmd'), args: ['test'] }, 'W', path.join(root, 'gate-temp')))!.args[1], `${bashQuote(path.join(root, 'npm'))} 'test'`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('gate commands go through the sandbox only when it is available', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-gatecmd-'));
  try {
    const calls: { executable: string; args: string[]; env?: Record<string, string>; environment?: Record<string, string> }[] = [];
    const runtime: GateRuntime = { ...defaultGateRuntime(), runCommand: async command => { calls.push(command); return { exitCode: 0, unavailable: false, interrupted: false, timedOut: false, logFailed: false, logged: true }; } };
    const gate = { id: 'unit', type: 'command' as const, command: [process.execPath, 'test.js'], timeoutSeconds: 60, required: true, env: { PACK: '1' } };
    const run = { author: 'claude' as const, logDirectory: root, worktree: path.join(root, 'wt'), baseCommit: 'b', runtime, earlier: [] };
    const wrappedCommand: WrappedCommand = { executable: 'C:\\Git\\bin\\bash.exe', args: ['C:\\h\\hydra-shell.sh', 'line'], environment: { HYDRA_WT: 'x' } };
    const seen: [string, string][] = [];
    const available: CommandSandbox = { wrap: async (command, worktree, temp) => { seen.push([worktree, temp]); assert.deepEqual(command, { executable: process.execPath, args: ['test.js'], env: { PACK: '1' } }); return wrappedCommand; } };
    const unavailable: CommandSandbox = { wrap: async () => undefined };
    assert.equal((await runCommandGate(gate, { ...run, sandbox: available })).state, 'passed');
    assert.deepEqual(calls[0], { executable: wrappedCommand.executable, args: wrappedCommand.args, environment: wrappedCommand.environment });
    assert.deepEqual(seen, [[path.join(root, 'wt'), path.join(root, 'unit-temp')]]);
    await runCommandGate({ ...gate, id: 'plain' }, { ...run, sandbox: unavailable });
    await runCommandGate({ ...gate, id: 'none' }, run);
    for (const call of calls.slice(1)) assert.deepEqual(call, { executable: process.execPath, args: ['test.js'], env: { PACK: '1' } }, 'as before');
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ---- Hydra's commits ----

test('Hydra commits a head\'s work with hooks off: a planted pre-commit hook and a hooksPath hook never run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-nohooks-'));
  try {
    const repo = path.join(root, 'repo');
    await git(root, ['init', '-q', '-b', 'main', repo]);
    await git(repo, ['config', 'user.email', 'test@example.invalid']); await git(repo, ['config', 'user.name', 'Test']);
    const hook = (marker: string) => `#!/bin/sh\necho ran > "${path.join(root, marker).replace(/\\/g, '/')}"\n`;
    await writeFile(path.join(repo, '.git', 'hooks', 'pre-commit'), hook('planted-ran'), { mode: 0o755 });
    await writeFile(path.join(repo, 'a.txt'), 'a\n');
    await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'control']);
    assert.ok(await access(path.join(root, 'planted-ran')).then(() => true, () => false), 'the control commit ran the hook, so it would run');
    await rm(path.join(root, 'planted-ran'));
    await mkdir(path.join(repo, '.husky')); await writeFile(path.join(repo, '.husky', 'pre-commit'), hook('husky-ran'), { mode: 0o755 });
    await git(repo, ['config', 'core.hooksPath', '.husky']);
    await writeFile(path.join(repo, 'b.txt'), 'b\n');
    const empty = await mkdtemp(path.join(root, 'no-hooks-'));
    await commitAll(repo, 'head work', empty);
    assert.equal((await git(repo, ['log', '-1', '--format=%s'])).trim(), 'head work');
    for (const marker of ['planted-ran', 'husky-ran']) assert.equal(await access(path.join(root, marker)).then(() => true, () => false), false, marker);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ---- Heads and lanes, end to end with stand-ins for the CLIs ----

async function repoIn(root: string): Promise<string> {
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await git(root, ['init', '-q', '-b', 'main', repo]);
  await git(repo, ['config', 'user.email', 'test@example.invalid']); await git(repo, ['config', 'user.name', 'Test']);
  await writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'init']);
  return repo;
}

test('a Claude head starts confined: its settings file on disk (0600, valid, the other head\'s worktree denied), its own TEMP, both gone when it ends', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-confined-'));
  const repo = await repoIn(root);
  const store = new JobStore(path.join(root, 'jobs')); await store.load();
  let service!: HelperService;
  const endpoint = new HelperEndpoint((caller, tool, args, signal) => service.handle(caller, tool, args, signal));
  const port = await endpoint.start();
  const runs: { spec: HelperRunSpec; settings?: unknown; mode?: number; tempExists: boolean }[] = [];
  const sandboxed: HeadShell = { kind: 'sandboxed', wrapper: path.join(root, 'sandbox', 'hydra-shell.sh'), gitBin: path.join(root, 'git', 'bin') };
  let shell: HeadShell = sandboxed;
  service = new HelperService({
    store, endpoint, leadFolder: repo, leadKey: 'window', worktreeRoot: () => path.join(root, 'worktrees'),
    executable: async provider => `fake-${provider}`, bridge: { command: 'hydra.exe', args: ['hydra-mcp.cjs'] },
    logDirectory: path.join(root, 'storage', 'logs'), hydraStorage: path.join(root, 'storage'), maxConcurrent: () => 2, watchdogMs: 20,
    sandbox: { shell: async () => shell, wrap: async () => undefined },
    startRun: spec => {
      const entry: (typeof runs)[number] = { spec, tempExists: false };
      runs.push(entry);
      let exit!: (code: number) => void; let stopped = false;
      const exited = new Promise<{ code: number | null }>(resolve => { exit = code => { if (!stopped) { stopped = true; resolve({ code }); } }; });
      const run: HelperRun = { onTurnEnd: () => undefined, exited, send: async () => !stopped, stop: async () => exit(137) };
      setTimeout(() => void (async () => {
        if (spec.confine.settingsFile) { entry.settings = JSON.parse(await readFile(spec.confine.settingsFile, 'utf8')); entry.mode = (await stat(spec.confine.settingsFile)).mode; }
        entry.tempExists = await access(spec.confine.env.TEMP!).then(() => true, () => false);
        await writeFile(path.join(spec.worktree, 'src', `${spec.prompt.includes('Job second') ? 'b' : 'c'}.ts`), 'x\n');
        await callHelperEndpoint(Number(spec.bridge.env.HYDRA_HELPER_PORT), spec.bridge.env.HYDRA_HELPER_TOKEN!, 'hydra_done', { summary: 'Done.' });
        exit(0);
      })(), 0);
      return run;
    },
  });
  const lead = endpoint.issue({ role: 'lead', leadKey: 'window' });
  const call = (tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: any; error?: string }> => callHelperEndpoint(port, lead, tool, args);
  const start = async (key: string, provider = 'claude') => (await call('hydra_start_head', { title: `Job ${key}`, brief: 'Do it.', write_scope: ['src/'], idempotency_key: key, provider })).result.job_id as string;
  try {
    const first = await start('first');
    await call('hydra_wait_for_heads', { job_ids: [first], max_wait_s: 60 });
    shell = { kind: 'off', reason: 'Git Bash wasn\'t found' };
    const second = await start('second');
    const third = await start('third', 'codex');
    const waited = (await call('hydra_wait_for_heads', { job_ids: [second, third], max_wait_s: 60 })).result;
    assert.deepEqual(waited.heads.map((head: { state: string }) => head.state), ['done', 'done']);

    const [one, two, three] = runs;
    const args = claudeHelperArguments(one!.spec);
    assert.equal(flag(args, '--setting-sources'), 'user');
    assert.equal(flag(args, '--settings'), one!.spec.confine.settingsFile);
    assert.match(path.basename(one!.spec.confine.settingsFile!), /^[a-f0-9]{12}-[a-f0-9]{8}\.settings\.json$/);
    assert.ok(path.dirname(one!.spec.confine.settingsFile!) === path.join(root, 'storage', 'logs'), 'beside its .mcp.json, in Hydra\'s storage');
    if (process.platform !== 'win32') assert.equal(one!.mode! & 0o777, 0o600);
    assert.deepEqual(settingsProblems(one!.settings, { platform: process.platform, blockReads: true, readable: [one!.spec.worktree] }), []);
    const deny = (one!.settings as { permissions: { deny: string[] } }).permissions.deny;
    assert.ok(deny.includes(`Edit(${rulePath(path.join(root, 'storage'))}/**)`) && deny.includes(`Read(${rulePath(path.join(root, 'storage'))}/**)`));
    assert.ok(deny.includes(`Edit(${rulePath(path.join(repo, '.hydra'))}/**)`) && deny.includes(`Read(${rulePath(path.join(repo, '.git'))}/**)`));
    const secondDeny = (two!.settings as { permissions: { deny: string[] } }).permissions.deny;
    assert.ok(secondDeny.includes(`Edit(${rulePath(one!.spec.worktree)}/**)`), 'the first head\'s worktree is another worktree to the second');
    assert.ok(!secondDeny.some(rule => ruleCovers(rule, rulePath(two!.spec.worktree)!, process.platform)), 'never its own');
    // With the sandbox: Bash, the wrapper in its environment, and Hydra's bridge marked. Without: no shell, and it hears why.
    assert.equal(one!.spec.confine.shell, true); assert.equal(one!.spec.confine.env.CLAUDE_CODE_SHELL_PREFIX, sandboxed.wrapper); assert.equal(one!.spec.confine.env.HYDRA_WT, one!.spec.worktree);
    assert.match(flag(args, '--tools')!, /,Bash$/);
    assert.doesNotMatch(one!.spec.prompt, /Your shell is off/);
    assert.equal(two!.spec.confine.shell, false); assert.equal(two!.spec.confine.env.CLAUDE_CODE_SHELL_PREFIX, undefined);
    assert.doesNotMatch(flag(claudeHelperArguments(two!.spec), '--tools')!, /Bash|PowerShell/);
    assert.match(two!.spec.prompt, /Your shell is off: Codex's Windows sandbox isn't available \(Git Bash wasn't found\)\. Hydra's gates run the tests\./);
    assert.equal(waited.heads[0].summary, 'Done.');
    assert.equal((await call('hydra_get_head', { job_id: second })).result.note, 'This head had no shell: Git Bash wasn\'t found.', 'said in its result');
    for (const run of [one, two]) assert.match(run!.spec.prompt, /Hydra commits your changes for you, so don't commit yourself/);
    // The Codex head: no settings file, its own TEMP, no secrets.
    assert.equal(three!.spec.provider, 'codex'); assert.equal(three!.spec.confine.settingsFile, undefined);
    for (const run of runs) {
      assert.ok(run.tempExists, 'its TEMP existed while it ran');
      assert.match(path.basename(run.spec.confine.env.TEMP!), /^[a-f0-9]{12}-/); assert.equal(run.spec.confine.env.TEMP, run.spec.confine.env.TMP);
      assert.ok(run.spec.confine.env.TEMP!.startsWith(path.join(root, 'storage', 'temp')));
      assert.equal(run.spec.confine.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, undefined);
    }
    // Gone when the head ends.
    const gone = async (file: string) => !(await access(file).then(() => true, () => false));
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !(await Promise.all(runs.flatMap(run => [run.spec.confine.settingsFile, run.spec.confine.env.TEMP].filter((file): file is string => !!file).map(gone)))).every(Boolean)) await new Promise(resolve => setTimeout(resolve, 50));
    for (const run of runs) { if (run.spec.confine.settingsFile) assert.ok(await gone(run.spec.confine.settingsFile)); assert.ok(await gone(run.spec.confine.env.TEMP!)); }
  } finally { await service.dispose(); await endpoint.close(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test('a Claude lane starts with its settings file on every launch; the other lane\'s worktree is denied; it goes when the lane closes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-lanelimits-'));
  try {
    const repo = await repoIn(root);
    const store = new LaneStore(path.join(root, 'store')); await store.load();
    const pty = fakePtyModule();
    const service = new LaneService({
      store, repository: repo, worktreeRoot: () => undefined, pty, executable: async provider => `C:\\bin\\${provider}.exe`, connected: async () => true,
      bridge: () => ({ command: 'node', args: [], env: {} }), helpersDir: path.join(root, 'storage', 'helpers'), configDirectory: path.join(root, 'storage', 'lanes'),
      hydraStorage: path.join(root, 'storage'),
    });
    const first = await service.create({ name: 'First', provider: 'claude' });
    const codex = await service.create({ name: 'Third', provider: 'codex' });
    const second = await service.create({ name: 'Second', provider: 'claude' });
    const file = path.join(root, 'storage', 'lanes', `${second.id}.settings.json`);
    assert.deepEqual(flag(pty.spawned[2]!.args, '--settings'), file);
    assert.ok(!pty.spawned[1]!.args.includes('--settings'), 'Codex lanes are unchanged');
    const settings = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(settingsProblems(settings, { platform: process.platform, blockReads: false, readable: [second.worktree] }), []);
    assert.ok(settings.permissions.deny.includes(`Edit(${rulePath(first.worktree)}/**)`) && settings.permissions.deny.includes(`Read(${rulePath(codex.worktree)}/**)`));
    assert.ok(settings.permissions.deny.includes(`Edit(${rulePath(path.join(root, 'storage'))}/**)`));
    assert.ok(!settings.permissions.deny.some((rule: string) => ruleCovers(rule, rulePath(repo)!, process.platform)), 'the main checkout isn\'t another lane');
    await service.close(second.id, 'delete');
    assert.equal(await access(file).then(() => true, () => false), false);
    await service.dispose();
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test('the first message says Hydra commits the work, and why a shell is off', () => {
  const job = { id: 'a'.repeat(12), title: 'T', brief: 'B', writeScope: ['src/'], worktree: 'W', branch: 'b', baseCommit: 'c', provider: 'claude' as const };
  assert.match(helperPrompt(job), /Hydra commits your changes for you, so don't commit yourself: git commands that write \(commit, checkout, config\) may fail in your sandbox\./);
  assert.doesNotMatch(helperPrompt(job), /Your shell is off/);
  assert.match(helperPrompt(job, undefined, 'heads', undefined, 'Codex isn\'t installed'), /- Your shell is off: Codex's Windows sandbox isn't available \(Codex isn't installed\)\. Hydra's gates run the tests\./);
});
