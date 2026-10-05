// App smoke: starts the built app twice, hidden, against a scratch AppData folder, and checks what it finds.
// `npm run smoke` builds first. No window is ever shown and no provider CLI is started.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeClaudeSmoke, composeCodexSmoke } from './compose.mjs';
import { standinCalls, writeStandins } from './standins.mjs';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// G1's CSP (docs/internal/hydra-app/G1-spikes.md, S4 item 4), written out here so the smoke checks the app against
// the decision, not against itself.
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'; font-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types hydraWorker defaultWorkerFactory diffEditorWidget diffReview domLineBreaksComputer editorViewLayer richScreenReaderContent standaloneColorizer tokenizeToString stickyScrollViewLayer editorGhostText dompurify";
const require = createRequire(import.meta.url);
const electron = require('electron');
const work = path.join(appDir, '.smoke', String(Date.now()));
const appData = path.join(work, 'AppData', 'Roaming');
const out = path.join(work, 'out');
const project = path.join(work, 'Project One');
fs.mkdirSync(project, { recursive: true });
// A git repository with one commit and changes on top, for the review pane.
{
  const { spawnSync } = await import('node:child_process');
  const git = (...args) => { const result = spawnSync('git', args, { cwd: project, windowsHide: true, encoding: 'utf8' }); if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`); };
  git('init', '-q');
  git('config', 'user.email', 'smoke@example.invalid');
  git('config', 'user.name', 'Smoke');
  fs.writeFileSync(path.join(project, 'hello.ts'), 'export const greeting = "one";\n');
  // G5: the project's one gate, which every head's and plan's work must pass (git is on the smoke's PATH).
  fs.mkdirSync(path.join(project, '.hydra'), { recursive: true });
  fs.writeFileSync(path.join(project, '.hydra', 'gates.json'), JSON.stringify({ gates: [{ id: 'smoke', type: 'command', required: true, command: ['git', '--version'], timeoutSeconds: 60 }] }));
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  fs.writeFileSync(path.join(project, 'hello.ts'), 'export const greeting = "two";\nexport const extra = 1;\n');
  fs.writeFileSync(path.join(project, 'notes.md'), '# new\n');
}
fs.mkdirSync(appData, { recursive: true });
fs.mkdirSync(out, { recursive: true });
// Stand-in CLIs on PATH, and scratch Claude and Codex config folders: the smoke never runs or reads the real ones.
const repoRoot = path.join(appDir, '..');
const replayScript = path.join(repoRoot, 'tests', 'fixtures', 'app', 'standins', 'replay.mjs');
const bin = writeStandins(path.join(work, 'bin'), { replay: { node: process.execPath, script: replayScript } });
const standinState = path.join(work, 'standin');
const chatFixture = composeClaudeSmoke(path.join(repoRoot, 'tests', 'fixtures', 'app', 'claude'), path.join(work, 'claude-smoke.jsonl'));
const codexFixture = composeCodexSmoke(path.join(repoRoot, 'tests', 'fixtures', 'app', 'codex'), path.join(work, 'codex-smoke.jsonl'));
const codexState = path.join(work, 'standin-codex');
const claudeConfig = path.join(work, 'claude-config'), codexHome = path.join(work, 'codex-home');
fs.mkdirSync(claudeConfig, { recursive: true });
fs.mkdirSync(codexHome, { recursive: true });
fs.writeFileSync(path.join(claudeConfig, '.claude.json'), JSON.stringify({ mcpServers: { hydra: { command: 'C:/Hydra/Hydra.exe', args: [], env: {} } } }));
fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "x"\n');
const configBefore = [path.join(claudeConfig, '.claude.json'), path.join(codexHome, 'config.toml')].map(file => fs.readFileSync(file, 'utf8'));
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
// git's own folder, for the review pane; nothing else from the user's PATH (no real claude or codex).
const gitFolder = (() => {
  const { spawnSync } = require('node:child_process');
  const found = spawnSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean);
  return found ? path.dirname(found) : undefined;
})();
// Hydra's storage (the IDE's, which the app shares): the smoke's own folder, never the user's.
const ideStorage = path.join(work, 'ide-storage');
const env = { ...process.env, HYDRA_APP_IDE_STORAGE: ideStorage, PATH: [bin, ...(gitFolder ? [gitFolder] : []), path.join(systemRoot, 'System32'), systemRoot].join(path.delimiter), CLAUDE_CONFIG_DIR: claudeConfig, CODEX_HOME: codexHome, HYDRA_STANDIN_FIXTURE: chatFixture, HYDRA_STANDIN_STATE: standinState, HYDRA_STANDIN_CODEX_FIXTURE: codexFixture, HYDRA_STANDIN_CODEX_STATE: codexState,
  // G5: stand-in heads (an unpackaged app only), and the chat stand-in's live calls through Hydra's own bridge.
  HYDRA_APP_STANDIN_HEADS: '1', HYDRA_STANDIN_BRIDGE: path.join(appDir, 'dist', 'hydra-mcp.cjs'), HYDRA_STANDIN_HELPERS_DIR: path.join(work, 'ide-storage', 'helpers') };
delete env.ELECTRON_RUN_AS_NODE; // Claude Code's shell sets it; Electron would start as plain Node.

function launch(role) {
  const child = spawn(electron, [path.join(appDir, 'smoke', 'harness.cjs'), `--smoke-role=${role}`, `--smoke-out=${out}`, `--smoke-appdata=${appData}`, `--smoke-folder=${project}`, `--smoke-timeout=240000`, ...process.argv.slice(2).filter(a => a.startsWith('--smoke-shots='))], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  const killer = setTimeout(() => child.kill(), 270000);
  void exited.then(() => clearTimeout(killer));
  return { exited, log: () => log };
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = role => { try { return JSON.parse(fs.readFileSync(path.join(out, `${role}.json`), 'utf8')); } catch { return undefined; } };
async function until(test, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (test()) return; await wait(100); }
  throw new Error(`Timed out waiting for ${what}.`);
}

// The app's canvas in each mode, from the design doc's colour tables (app/src/shared/theme.ts uses them; theme.test.ts checks).
const canvasColor = name => {
  const doc = fs.readFileSync(path.join(appDir, '..', 'docs', 'internal', 'hydra-app', 'UI-direction.md'), 'utf8');
  const start = doc.indexOf(`## ${name === 'dark' ? 'Dark' : 'Light'} mode`);
  return /^\| Canvas \| (#[0-9A-Fa-f]{6}) \|$/m.exec(doc.slice(start, doc.indexOf('\n## ', start + 3)))?.[1];
};
const standinErrors = (state = standinState) => { try { return fs.readFileSync(path.join(state, 'errors.log'), 'utf8'); } catch { return ''; } };
const chatStarts = (state = standinState) => { try { return fs.readFileSync(path.join(state, 'calls.log'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line).args); } catch { return []; } };
const checks = [];
const check = (name, fn) => { fn(); checks.push(name); console.log(`ok - ${name}`); };
const first = launch('first');
let failed = false;
try {
  await until(() => read('first')?.events.includes('ready'), 150000, 'the first instance to load');
  const second = launch('second');
  const secondCode = await second.exited;
  const firstCode = await first.exited;
  // Restart the app over the same user data, and resume the chat.
  const resume = launch('resume');
  const resumeCode = await resume.exited;
  const r = read('resume');
  const a = read('first'), b = read('second');

  check('the app opens one window on app://hydra/', () => {
    assert.equal(a.windowsAtLoad, 1);
    assert.equal(a.url, 'app://hydra/index.html');
    assert.equal(a.title, 'Hydra');
    assert.equal(a.name, 'Hydra');
  });
  check('user data is under Hydra App, never the IDE Hydra folder', () => {
    const own = path.join(appData, 'Hydra App').toLowerCase();
    const ide = path.join(appData, 'Hydra').toLowerCase();
    for (const name of ['userData', 'sessionData', 'logs', 'crashDumps']) {
      const value = path.resolve(a.paths[name]).toLowerCase();
      assert.ok(value === own || value.startsWith(own + path.sep), `${name} is ${a.paths[name]}`);
      assert.ok(value !== ide && !value.startsWith(ide + path.sep), `${name} is inside the IDE's folder`);
    }
    assert.ok(fs.existsSync(path.join(appData, 'Hydra App')), 'Hydra App was not created');
    assert.ok(!fs.existsSync(path.join(appData, 'Hydra')), 'something was written to the IDE\'s %APPDATA%\\Hydra');
  });
  check('the preload exposes only the typed API, and the renderer has no Node', () => {
    assert.deepEqual(a.hydraKeys, ['appInfo', 'problems', 'getSettings', 'setTheme', 'pickCliPath', 'clearCliPath', 'getState', 'setSidebarOpen', 'updateStatus', 'checkForUpdates', 'setAutomaticUpdates', 'pickProject', 'cloneRepo', 'removeProject', 'checkSetup', 'signIn', 'trustProject', 'listChats', 'createChat', 'prepareChat', 'openChat', 'sendMessage', 'openTerminal', 'setChatWhere', 'continueCloud', 'terminalWrite', 'terminalResize', 'terminalClose', 'claudeCommands', 'pullRequest', 'browserOpen', 'browserNavigate', 'browserBounds', 'browserBack', 'browserForward', 'browserReload', 'browserClose', 'reviewDiff', 'openReviewFile', 'terminalClosed', 'answer', 'stopChat', 'configureChat', 'removeChat', 'renameChat', 'archiveChat', 'hydraConnections', 'connectHydra', 'disconnectHydra', 'hydraTree', 'agentsMessage', 'hydraControl', 'hydraReply', 'onHydraHost', 'onHydraUi', 'onHydraTree', 'onBrowser', 'onTerminal', 'onChatEvents']);
    assert.equal(a.appInfo.name, 'Hydra');
    assert.equal(a.nodeInRenderer, 'undefined/undefined');
  });
  check('windows are hardened: context isolation, sandbox, no Node, no webview tag', () => {
    const prefs = a.webPreferences;
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.sandbox, true);
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.nodeIntegrationInWorker, false);
    assert.equal(prefs.nodeIntegrationInSubFrames, false);
    assert.equal(prefs.webviewTag, false);
    assert.equal(prefs.webSecurity, true);
    assert.equal(a.webviewTag, 'undefined');
  });
  check('every app:// response carries the G1 CSP', () => {
    for (const [file, response] of Object.entries(a.headers)) {
      assert.equal(response.csp, CSP, file);
      assert.equal(response.nosniff, 'nosniff', file);
    }
    assert.equal(a.headers['missing.js'].status, 404);
  });
  check('the CSP holds in the page: no inline script, eval or remote fetch, and no violations from the app itself', () => {
    // Trusted Types refuses the script's text outright; failing that, the CSP would refuse to run it.
    assert.match(a.inlineScript, /^(threw: TypeError|undefined)$/);
    assert.match(a.evalBlocked, /^threw: EvalError/);
    assert.match(a.remoteFetch, /^failed/);
    assert.match(a.mainSessionRemote, /ERR_BLOCKED_BY_CLIENT/);
    const violations = a.consoleAtLoad.filter(m => /Content Security Policy|Trusted ?Type|TrustedHTML|TrustedScript/i.test(m.message));
    assert.deepEqual(violations, [], 'the app broke its own CSP while loading');
  });
  check('navigation is blocked, and window.open is denied with http(s) links sent through a confirm', () => {
    assert.equal(a.urlAfterNavigate, 'app://hydra/index.html');
    assert.equal(a.openResult, 'null');
    assert.deepEqual(a.confirms, ['https://example.com/cancelled', 'https://example.com/accepted']);
    assert.deepEqual(a.opened, ['https://example.com/accepted']);
    assert.equal(a.windowsAfterOpen, 1);
    assert.equal(a.permission, 'denied');
    assert.deepEqual(a.downloads, [{ prevented: true, name: 'invoice.bat' }], 'the download was not refused');
    assert.equal(a.saveDialogs, 0);
  });
  check('main refuses an unknown IPC channel, an unknown call and an invalid payload', () => {
    assert.equal(a.ipc.unknownTransport.ok, false);
    assert.match(a.ipc.unknownTransport.error, /No handler registered/);
    assert.equal(a.ipc.unknownChannel.ok, false);
    assert.match(a.ipc.unknownChannel.error, /Refused: Unknown channel/);
    assert.equal(a.ipc.badPayload.ok, false);
    assert.match(a.ipc.badPayload.error, /Refused: Invalid payload/);
    assert.equal(a.ipc.extraField.ok, false);
    assert.equal(a.ipc.valid.ok, true);
    assert.equal(a.ipc.foreignSender.ok, false);
    assert.match(a.ipc.foreignSender.error, /did not come from the app/);
  });
  check('the shell: title bar with sidebar toggle and Chat / Agents, sidebar, and an empty state with a folder picker', () => {
    assert.equal(a.ui.titleBar, true);
    assert.equal(a.ui.sidebarToggle, true);
    assert.equal(a.ui.chatTab, 'Chat');
    assert.equal(a.ui.agentsDisabled, undefined, 'Agents is live (G5): with no project open it says to open one');
    assert.deepEqual(a.ui.sidebar, ['New', 'Projects', 'Archived', 'More']);
    assert.equal(a.ui.account, true, 'Settings is in the account row at the bottom');
    assert.equal(a.ui.search, true);
    assert.match(a.ui.emptyButton, /Open a project/);
    assert.deepEqual(a.home.buttons, ['Open a project', 'Clone a repo']);
    assert.equal(a.home.setupOnHome, false, 'Claude Code and Codex are in Settings, not on the home screen');
    assert.deepEqual(a.afterPick.projects, ['Project One']);
    assert.equal(a.afterPick.heading, 'Project One');
    assert.equal(a.sidebarAfterToggle, false);
    assert.equal(a.settingsView.heading, 'Settings');
    assert.deepEqual(a.pickers, ['folder', 'folder', 'file']);
    assert.equal(a.projectsAfterRepick, 1);
    assert.deepEqual(a.problems, []);
  });
  check('the app\'s dark and light palettes, with a Dark, Light or System setting', () => {
    assert.equal(a.themes.light.theme, 'light');
    assert.equal(a.themes.light.bg, canvasColor('light'));
    assert.equal(a.themes.light.native, 'light');
    assert.equal(a.themes.dark.theme, 'dark');
    assert.equal(a.themes.dark.bg, canvasColor('dark'));
    assert.equal(a.themes.dark.native, 'dark');
    assert.equal(a.themes.system.native, 'system');
    assert.equal(a.themes.system.theme, a.themes.system.nativeDark ? 'dark' : 'light');
    assert.equal(a.badTheme, 'refused');
    assert.deepEqual(a.settingsView.themes, ['Dark:false', 'Light:false', 'System:true']);
    assert.deepEqual([a.themes.light.checked, a.themes.dark.checked, a.themes.system.checked], ['Light', 'Dark', 'System']);
  });
  check('settings and state are stored in user data, schema-checked, with nothing left half-written', () => {
    assert.deepEqual(a.stores.settings, { version: 1, theme: 'system', cliPaths: {} });
    assert.equal(a.stores.state.version, 1);
    assert.equal(a.stores.state.sidebarOpen, true);
    assert.deepEqual(a.stores.state.projects.map(p => [p.name, p.path]), [['Project One', project]]);
    assert.deepEqual(a.stores.files.filter(f => f.endsWith('.tmp')), []);
    assert.deepEqual(a.consoleErrors, []);
  });
  check('onboarding shows each CLI version and support, whether it is signed in, and the hydra registration, read-only', () => {
    assert.deepEqual(a.setup.map(p => [p.provider, p.status, p.registration, p.account, p.signIn]), [
      ['claude', '2.1.282 · supported', 'Hydra tools: registered', 'Not signed in', true],
      ['codex', '0.157.1 · supported', 'Hydra tools: not registered', 'Signed in', false],
    ]);
    assert.deepEqual([path.join(claudeConfig, '.claude.json'), path.join(codexHome, 'config.toml')].map(file => fs.readFileSync(file, 'utf8')), configBefore, 'a config file changed');
    assert.deepEqual(fs.readdirSync(claudeConfig), ['.claude.json']);
    assert.deepEqual(fs.readdirSync(codexHome), ['config.toml']);
  });
  check('Sign in runs the CLI\'s own login out of sight: no window, no console, and the row then says signed in', () => {
    assert.deepEqual(a.afterSignIn.map(p => [p.provider, p.account, p.signIn]), [['claude', 'Signed in', false], ['codex', 'Signed in', false]]);
    assert.equal(a.consolesBeforeSignIn, 0);
    assert.equal(a.consolesAfterSignIn, 0, 'no console window was opened');
    assert.deepEqual(a.refusedLaunches, [], 'something tried to start a visible process');
    assert.deepEqual(a.secondSignIn.map(r => r.signedIn).sort(), [false, true]);
    assert.match(a.secondSignIn.find(r => !r.signedIn).error, /already/);
  });
  check('no provider process starts except the version, help and sign-in checks, and the logins asked for', () => {
    const all = standinCalls(bin);
    assert.equal(a.recheckDone, true);
    // The chats' own processes, each started by a message the user sent (per provider: the first run, and the resume).
    const isChat = call => (call.startsWith('claude -p ') && / --(session-id|resume) /.test(call)) || call.startsWith('codex app-server --listen');
    const chats = all.filter(isChat);
    // Claude: the first run, the resume, and the chat that starts a head (G5). Codex: the first run and the resume, plus
    // one more when the app-server started as the chat opened was replaced as the chat switched to Ask me before its
    // first message.
    assert.equal(chats.filter(call => call.startsWith('claude -p ')).length, 3, all.join(', '));
    const codexServers = chats.filter(call => call.startsWith('codex app-server')).length;
    assert.ok(codexServers === 2 || codexServers === 3, all.join(', '));
    const calls = all.filter(call => !isChat(call));
    // Hydra's start-up check of a head's CLI (cliSelfCheck.ts), and its look for Codex's sandbox: no plan in the smoke
    // asks for a review, so no other Claude or Codex run starts.
    const checks = ['claude --help', 'claude --version', 'codex --help', 'codex --version', 'codex app-server --help', 'claude auth status --json', 'codex login status',
      'claude -p --input-format stream-json --output-format stream-json --verbose --strict-mcp-config', 'codex exec --help'];
    // A lane's own CLI (G5 milestone 4): interactive, with its lane's settings file.
    const lane = call => /^claude --settings .*[\\/]lanes[\\/][0-9a-f]{12}\.settings\.json$/.test(call);
    assert.equal(calls.filter(lane).length, 1, 'the lane started its CLI once');
    assert.deepEqual(calls.filter(call => !checks.includes(call) && !lane(call)), ['claude auth login --claudeai', 'claude auth login --claudeai'], 'only the two sign-ins asked for (the button, and the one of two at once that ran)');
    const count = call => calls.filter(c => c === call).length;
    // At least three checks (the first run, its Check again, the restarted app); the last may be cut short by the quit.
    assert.ok(count('claude --version') >= 3 && count('codex --version') >= 3, calls.join(', '));
  });
  check('Hydra runs in the app: opening a chat starts its project\'s controller, and `hydra status` there reports the app', () => {
    const status = r.hydraStatus;
    assert.ok(status, 'no hydra status');
    assert.equal(status.error, undefined, status.error);
    assert.equal(status.status.window.pid, status.appPid, 'the window that owns the folder is the app');
    assert.equal(path.resolve(status.status.repository).toLowerCase(), path.resolve(project).toLowerCase());
    assert.ok(fs.existsSync(path.join(ideStorage, 'ownership')), 'the ownership lock is in the shared storage');
    assert.equal(fs.readdirSync(path.join(ideStorage, 'helpers', 'windows')).filter(name => name.endsWith('.json') && !name.endsWith('.summary.json')).length, 0, 'the app removed its discovery record when it quit');
  });
  check('a chat\'s lead tools: Hydra\'s bridge, started by the app as a chat\'s CLI is, is accepted as the project\'s lead', () => {
    const call = r.leadCall;
    assert.ok(call, 'no lead call');
    assert.equal(call.error, undefined, call.error);
    assert.equal(call.isError, false, call.text);
    assert.match(call.text, /"heads"/);
  });
  check('a chat calls a lead tool: a head starts in a worktree, its gate runs, and its card shows in the chat and on the canvas', () => {
    const agents = r.agents;
    assert.ok(agents, `no Agents results: ${r.error ?? ''}`);
    assert.equal(standinErrors(), '', 'the chat stand-in\'s live call failed');
    assert.equal(agents.chatCard.title, 'Smoke head');
    assert.match(agents.chatCard.state, /done|merged/i);
    assert.match(agents.chatCard.text, /smoke/);
    assert.match(agents.canvasHead.title, /Smoke head|smoke job/i);
    assert.match(agents.diffView.title, /Smoke head \(Hydra head [0-9a-f]{12}\)/);
    assert.ok(agents.diffView.added.some(line => /stand-in head/.test(line)), JSON.stringify(agents.diffView));
    assert.match(agents.evidenceView.title, /-evidence\.md$/);
    assert.match(agents.evidenceView.text, /smoke/);
    assert.deepEqual(agents.shownInExplorer, [], 'nothing opened outside the app');
  });
  check('a plan with stand-ins lands on its integration branch, its gate passes, and Merge plan merges it', () => {
    const agents = r.agents;
    assert.ok(agents?.planCreated, 'no plan');
    assert.equal(agents.planCreated.isError, false, agents.planCreated.text);
    assert.equal(agents.planWait.isError, false, agents.planWait.text);
    assert.match(agents.planWait.text, /"state"\s*:\s*"done"/);
    assert.deepEqual(agents.mergedFiles, ['one.txt', 'three.txt', 'two.txt'], 'the plan\'s three files are merged (the lone head\'s stays on its branch)');
    assert.match(agents.planStatus, /passed/i, 'Merge plan shows once the integration gate passed');
    assert.match(agents.planStatusAfter, /merged/i);
    assert.match(agents.mergedLog ?? '', /plan|Smoke plan/i);
  });
  check('a lane runs its CLI in a real terminal in its own worktree; the audit log, Stop all and Resume work from the Agents view', () => {
    const agents = r.agents;
    assert.equal(agents?.lanes?.unavailable, '', 'terminals are available (node-pty loads in the app)');
    assert.equal(agents.lanes.terminal, true, 'the lane showed an xterm terminal');
    assert.ok(agents.lanes.worktrees.length >= 1, 'the lane has its own worktree');
    assert.ok(standinCalls(bin).some(call => /^claude( |$)/.test(call) && !/^claude (-p|--version|--help|auth) ?/.test(call)), 'the lane started the CLI itself');
    assert.match(agents.audit, /"kind"\s*:\s*"stop"/, 'the audit log shows the stop');
    assert.equal(agents.stopConfirm.length, 1, 'Stop all asked first');
    assert.equal(agents.resumed, true);
  });
  check('Hydra Settings: the IDE\'s own pages in their own window, themed, over G2\'s bridge; a change is saved in the app; Show All Projects lists this one', () => {
    const settings = r.settingsWindow;
    assert.equal(settings?.found, true, 'no settings window');
    assert.match(settings.title, /^Hydra Settings · Project One$/);
    assert.equal(settings.url, 'data:text/html;charset=utf-8;b');
    for (const page of ['General', 'Connectors', 'Heads', 'Gates', 'Packs']) assert.ok(settings.pages.some(item => item.includes(page)), `${page} in ${settings.pages.join(', ')}`);
    assert.match(settings.themed, /^#[0-9a-fA-F]{6,8}$/);
    assert.equal(settings.bridge, 'function/undefined/undefined', 'the page has the bridge, and no Node or VS Code API');
    assert.equal(settings.saved, 5);
    assert.equal(settings.packs.empty, false, 'the built-in packs are found');
    assert.match(settings.packs.list, /Coding/);
    assert.ok(r.allProjects?.some(item => /Project One/.test(item) && /This window/.test(item)), JSON.stringify(r.allProjects));
  });
  check('a chat with Claude Code: trust first, then stream, approve, deny and stop', () => {
    assert.match(a.chat.trustedBefore, /asks you to trust this folder first/);
    assert.equal(a.trustPrompts.length, 1);
    assert.match(a.trustPrompts[0], /^Trust Project One\?/);
    assert.match(a.trustPrompts[0], /hooks, MCP servers and commands will run/);
    assert.match(a.chat.firstCard, /Allow Bash\?/);
    assert.deepEqual(a.chat.outcomes, ['Allowed', 'Denied']);
    assert.deepEqual(a.chat.turnEnds, ['success', 'success', 'interrupted']);
    assert.ok(a.chat.tools.includes('Bash'));
    assert.ok(a.chat.assistantTexts >= 2);
    assert.deepEqual(a.chat.title, ['Use the Bash tool to run exactly: mkdir g1-bash-dir']);
    assert.equal(a.chat.files.filter(f => f.endsWith('.jsonl')).length, 1, 'the Claude chat\'s log (the Codex one comes after)');
    assert.ok(a.chat.files.includes('index.json'));
    assert.equal(standinErrors(), '', 'the stand-in saw the app send something the recording did not');
  });
  check('after a restart the chat is still there, and the next message resumes its session', () => {
    assert.equal(resumeCode, 0, resume.log());
    assert.equal(r.resume.title, 'Use the Bash tool to run exactly: mkdir g1-bash-dir');
    assert.equal(r.resume.titles.length, 2);
    assert.equal(r.resume.restoredTurnEnds, 3);
    assert.deepEqual(r.resume.restoredCards, ['Allowed', 'Denied']);
    assert.match(r.resume.lastTurn, /success/);
    assert.ok(r.resume.terminal, 'Open in terminal launched nothing');
    assert.match(r.resume.terminal.line, /start "Claude Code chat"/);
    assert.ok(r.resume.terminal.script.includes(`Set-Location -LiteralPath '${project.replace(/'/g, "''")}'`), r.resume.terminal.script);
    assert.deepEqual(r.refusedLaunches, []);
    const starts = chatStarts();
    assert.equal(starts.length, 3, 'the chat, its resume, and the chat that starts a head (G5)');
    const first = starts[0], second = starts[1];
    const id = first[first.indexOf('--session-id') + 1];
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(second[second.indexOf('--resume') + 1], id);
    assert.ok(r.resume.terminal.script.includes(`'--resume' '${id}'`), 'the terminal resumes the same session');
    assert.equal(standinErrors(), '');
  });
  check('a chat with Codex: read-only by default, deny, allow, stop mid-command', () => {
    assert.deepEqual(a.codex.approvals, ['Codex decides', 'Ask me'], 'the first follows the user\'s own Codex config, named for what it does');
    assert.equal(a.codex.approvalsDefault, 'settings', 'a new chat follows the user\'s own Codex settings');
    assert.deepEqual(a.codex.choices, ['Allow', 'Allow for this session', 'Deny']);
    assert.ok(a.codex.models.length > 1 && !a.codex.models.some(label => /default/i.test(label)), 'models from Codex\'s own model/list, no "default" entry');
    assert.ok(a.codex.model && a.codex.model !== 'x', 'the menu shows the model Codex reports in use, not a config model it doesn\'t offer');
    assert.deepEqual(a.codex.outcomes, ['Denied', 'Allowed']);
    assert.deepEqual(a.codex.turnEnds, ['success', 'success', 'interrupted']);
    assert.match(a.codex.output, /42/, 'the allowed command\'s output');
    assert.equal(a.trustPrompts.length, 1, 'the folder was already trusted');
    assert.equal(standinErrors(codexState), '', 'the Codex stand-in saw the app send something the recording did not');
  });
  check('after a restart the Codex chat resumes its thread in a new app-server', () => {
    assert.equal(r.resume.codex.restoredTurnEnds, 3);
    assert.deepEqual(r.resume.codex.restoredCards, ['Denied', 'Allowed']);
    assert.match(r.resume.codex.lastTurn, /success/);
    assert.equal(chatStarts(codexState).length, 2);
    assert.equal(standinErrors(codexState), '');
  });
  check('the review pane shows the working tree against HEAD, read-only, with no CSP violation', () => {
    assert.deepEqual(a.review.files.sort(), ['Mhello.ts', 'Unotes.md']);
    assert.equal(a.review.readOnly, true);
    assert.deepEqual(a.review.cspViolations, []);
    assert.equal(a.review.shown.length, 1, 'Open in editor showed the file in its folder (no editor on the smoke\'s PATH)');
    assert.match(a.review.shown[0], /hello\.ts$/);
  });
  check('a second launch focuses the first and exits', () => {
    assert.equal(a.hasLock, true);
    assert.equal(secondCode, 0, second.log());
    assert.equal(b.exitedWithLock, false);
    assert.ok(!b.events.includes('window-created'), 'the second launch opened a window');
    const at = a.events.indexOf('second-instance');
    assert.ok(at >= 0, 'the first instance never heard of the second');
    assert.ok(a.events.slice(at).includes('focus'), 'the first instance did not focus its window');
    assert.equal(firstCode, 0, first.log());
  });
} catch (error) {
  failed = true;
  console.error(`not ok - ${error.message}`);
  console.error(first.log());
} finally {
  if (!failed) fs.rmSync(work, { recursive: true, force: true });
  else console.error(`Smoke output kept in ${work}`);
}
console.log(`${checks.length} smoke checks passed${failed ? ', then one failed' : ''}.`);
process.exitCode = failed ? 1 : 0;
