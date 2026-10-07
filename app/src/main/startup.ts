import os from 'node:os';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, powerMonitor, protocol, session, shell, type WebContents } from 'electron';
import { whenAwayOn, type CliProvider } from '../shared/ipc';
import { ChatStore } from '../../../src/core/chat/store';
import { nodeLaunch } from '../../../src/core/chat/launch';
import { findProvider } from '../../../src/core/providers';
import { pathWithUsualCliFolders } from './cliLookup';
import { providerPaths } from '../../../src/core/helperRegistration';
import { readFile } from 'node:fs/promises';
import { CHAT_EVENTS, HYDRA_HOST, HYDRA_TREE, HYDRA_UI, TERMINAL, TERMINAL_TABS, BROWSER, type HydraHostMessage, type Project } from '../shared/ipc';
import { AppTerminals } from './terminals';
import { AgentTerminal } from './agentTerminal';
import { ShellTabs } from './shellTabs';
import { BrowserPanel } from './browserPanel';
import { claudeCommands } from './claudeCommands';
import { pullRequests } from './pullRequests';
import { claudeTitle, codexTitle } from './chatTitles';
import { ChatManager } from './chats';
import { cloudChats } from './cloud';
import { TurnSnapshots } from './turnSnapshots';
import { consoleLaunch, consoleScript, openConsole } from './console';
import { branchSummary, changedPaths, openInEditor, workingTreeDiff } from './review';
import { createHandlers } from './handlers';
import { onboardingReport, signIn, stopSignIns } from './onboarding';
import { cloneRepo } from './clone';
import { ideStorageRoot } from './host';
import { startStandinHead } from './standinHeads';
import { HostUi } from './hostUi';
import { HydraSettingsWindow } from './settingsWindow';
import { HydraProjects } from './hydra';
import { identityProblems, PRODUCT_NAME } from './identity';
import { registerIpc } from './ipc';
import { APP_SCHEME, confirmAndOpen, guardContents, guardSession, serveAppRequest } from './security';
import { createSettingsStore, createStateStore } from './settings';
import { WhenAwayBanners } from './needsYouBanners';
import { AppUpdates, createUpdateStore } from './updates';
import { readFileSync } from 'node:fs';
import { applyTheme, createMainWindow, focusMainWindow, getMainWindow, repaintTitleBar } from './window';

declare const HYDRA_APP_VERSION: string;

/** Asks before an http(s) link leaves the app for the user's browser. */
function confirmExternal(contents: WebContents, url: string): void {
  void confirmAndOpen(url, {
    ask: async link => {
      const parent = BrowserWindow.fromWebContents(contents) ?? undefined;
      const options = { type: 'question' as const, buttons: ['Open in browser', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true, title: PRODUCT_NAME, message: 'Open this link in your browser?', detail: link };
      const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
      return response === 0;
    },
    open: link => shell.openExternal(link),
  }, contents);
}

async function pickFolder(purpose: 'project' | 'clone' = 'project'): Promise<string | undefined> {
  const options = { title: purpose === 'clone' ? 'Choose where to put the repository' : 'Open a project folder', properties: ['openDirectory' as const, 'dontAddToRecent' as const] };
  const win = getMainWindow();
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
}

async function pickExecutable(provider: CliProvider): Promise<string | undefined> {
  const name = provider === 'claude' ? 'Claude Code' : 'Codex';
  const options = { title: `Choose ${name}'s command-line tool`, properties: ['openFile' as const, 'dontAddToRecent' as const], filters: [{ name: 'Programs', extensions: ['exe', 'cmd', 'bat'] }] };
  const win = getMainWindow();
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
}

/**
 * The folder-trust confirm (hard rule 6), drawn by main so a page can't fake or skip it. `claude -p` and Codex run a
 * project's own hooks, MCP servers and commands with no prompt of their own.
 */
async function confirmTrust(project: Project): Promise<boolean> {
  const options = {
    type: 'warning' as const, buttons: ['Trust this folder', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true, title: PRODUCT_NAME,
    message: `Trust ${project.name}?`,
    detail: `${project.path}\n\nChats here run Claude Code or Codex with this project's own settings. Its hooks, MCP servers and commands will run on your computer, with your permissions, and neither tool asks first. Trust only folders whose contents you trust.`,
  };
  const win = getMainWindow();
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return response === 0;
}

/** Runs after identity.ts has set the app's paths (main.ts). */
export function start(): void {
  // Never run with a broken identity: it would write into another folder, possibly the IDE's.
  const problems = identityProblems(app);
  if (problems.length) {
    console.error(`Hydra won't start: ${problems.join('; ')}`);
    app.exit(1);
    return;
  }
  // Every CLI lookup in the app goes through PATH (after Settings' path): make sure the installers' folders are on it.
  const withClis = pathWithUsualCliFolders();
  if (withClis) process.env.PATH = withClis;
  // The lock is keyed on the user-data folder, which is already %APPDATA%\Hydra App, so the IDE's never collides.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => focusMainWindow());

  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  Menu.setApplicationMenu(null);
  // Every webContents, the main window's and any other, gets the navigation, window-open and webview guards.
  app.on('web-contents-created', (_event, contents) => guardContents(contents, url => confirmExternal(contents, url)));
  // Every session gets the permission, request and download guards, including any partition added later.
  app.on('session-created', created => guardSession(created));

  const distDir = __dirname;
  const userData = app.getPath('userData');
  const settings = createSettingsStore(userData);
  const state = createStateStore(userData);
  const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const chatStore = new ChatStore(path.join(userData, 'chats'));
  // The window's terminals (G7's Continue here), in node-pty as lanes are.
  // The browser panel beside a chat (Claude desktop's globe), in a session of its own.
  const browser = new BrowserPanel({ window: getMainWindow, send: state => { const win = getMainWindow(); if (win && !win.webContents.isDestroyed()) win.webContents.send(BROWSER, state); } });
  // The terminal panel's tabs per chat live in main (shellTabs.ts); what a terminal prints goes to its pane and to the tab's read buffer.
  const terminals = new AppTerminals({ appRoot: path.dirname(distDir), send: message => { shellTabs.feed(message); const win = getMainWindow(); if (win && !win.webContents.isDestroyed()) win.webContents.send(TERMINAL, message); } });
  const shellTabs: ShellTabs = new ShellTabs({
    terminals,
    shell: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    folder: chatId => chats.shellFolder(chatId),
    push: message => { const win = getMainWindow(); if (win && !win.webContents.isDestroyed()) win.webContents.send(TERMINAL_TABS, message); },
  });
  // A Claude chat's own terminal tools (agentTerminal.ts): if the endpoint or its private folder can't start, no chat gets them.
  const agentTerminal: AgentTerminal = new AgentTerminal({ tabs: shellTabs, dir: path.join(userData, 'agent-terminal'), script: path.join(distDir, 'hydra-terminal-mcp.cjs'), executable: process.execPath, log: line => { if (process.env.HYDRA_APP_LOG === '1') console.log(line); } });
  void agentTerminal.start().catch((error: unknown) => { if (process.env.HYDRA_APP_LOG === '1') console.log(`terminal tools off: ${error instanceof Error ? error.message : String(error)}`); });
  const chats: ChatManager = new ChatManager({
    store: chatStore,
    // The change summary card: a private snapshot repository per chat, never in the user's folder.
    snapshots: new TurnSnapshots(path.join(userData, 'turn-snapshots')),
    launch: nodeLaunch(),
    warm: true,
    agentTerminal,
    // G7: Claude cloud chats; Continue here's worktrees live under the app's own data.
    cloud: cloudChats({ appRoot: path.dirname(distDir), worktrees: path.join(userData, 'cloud-worktrees') }),
    // The PR icon: gh's own view of a pull request a chat opened. No gh, or no access: no icon change.
    prState: url => new Promise(resolve => execFile('gh', ['pr', 'view', url, '--json', 'state', '-q', '.state'], { windowsHide: true, timeout: 20_000 }, (error, stdout) => {
      const state = String(stdout).trim().toLowerCase();
      resolve(!error && (state === 'open' || state === 'merged' || state === 'closed') ? state : undefined);
    })),
    executable: async provider => { const found = await findProvider(provider, (await settings.load()).cliPaths[provider]).catch(() => undefined); return found?.available ? found.executable : undefined; },
    titleChat: async message => { const found = await findProvider('claude', (await settings.load()).cliPaths.claude).catch(() => undefined); return found?.available && found.executable ? claudeTitle(found.executable, message) : undefined; },
    titleCodexChat: async message => { const found = await findProvider('codex', (await settings.load()).cliPaths.codex).catch(() => undefined); return found?.available && found.executable ? codexTitle(found.executable, message) : undefined; },
    openConsole: (title, executable, args, cwd) => openConsole(consoleLaunch(title, consoleScript(title, executable, args, cwd)), cwd),
    codexConfig: () => readFile(providerPaths().codexConfig, 'utf8').catch(() => undefined),
    startTerminal: (executable, args, cwd) => terminals.start(executable, args, cwd),
    log: line => { if (process.env.HYDRA_APP_LOG === '1') console.log(line); },
    cliConfig: provider => readFile(provider === 'claude' ? providerPaths().claudeSettings : providerPaths().codexConfig, 'utf8').catch(() => undefined),
    trusted: async cwd => (await state.load()).projects.some(project => !!project.trustedAt && samePath(project.path, cwd)),
    push: (chatId, events, start) => { const win = getMainWindow(); if (win && !win.webContents.isDestroyed()) win.webContents.send(CHAT_EVENTS, { chatId, events, start }); },
  });
  // Hydra (G5): one controller per trusted project, over the IDE's own storage. A development or test run never
  // repairs the user's Claude and Codex connections on its own; an installed app repairs one only when what it runs
  // is gone (helperRegistration.ts shouldRepairConnection), so it and the IDE never take turns rewriting it.
  // Hydra's questions, notices and documents go to the window; its answers come back through hydra.reply.
  const hostUi = new HostUi(message => { const win = getMainWindow(); if (win && !win.webContents.isDestroyed()) win.webContents.send(HYDRA_HOST, message); });
  const settingsWindow = new HydraSettingsWindow(distDir);
  const navigate = (message: Extract<HydraHostMessage, { kind: 'navigate' }>) => { const win = getMainWindow(); if (win && !win.webContents.isDestroyed()) { win.webContents.send(HYDRA_HOST, message); win.show(); win.focus(); } };
  const hydra = new HydraProjects({
    ui: hostUi,
    settingsWindow,
    showAppSettings: () => navigate({ kind: 'navigate', to: 'settings' }),
    openProject: folder => { void state.load().then(loaded => {
      const project = loaded.projects.find(candidate => samePath(candidate.path, folder));
      if (project) navigate({ kind: 'navigate', to: 'project', projectId: project.id });
      else void hostUi.notice('app', 'info', `${folder} isn't one of the app's projects. Hydra IDE has it open; to work on it here, close it there and choose Open a project.`, []);
    }).catch(() => undefined); },
    // Under the appData folder this app uses (a test that moves appData moves this too), unless set outright.
    storage: ideStorageRoot({ ...process.env, APPDATA: app.getPath('appData') }), dist: distDir,
    // node-pty's root: the app folder its bundle is in (app.getAppPath() is wherever Electron was pointed, a test harness's folder say).
    appRoot: path.dirname(distDir),
    // The built-in packs: the repository's packs/ beside app/ (a packaged app ships its own, G6).
    extension: path.resolve(distDir, '..', '..'),
    userData, version: HYDRA_APP_VERSION, development: !app.isPackaged,
    cliPath: async provider => (await settings.load()).cliPaths[provider],
    log: line => { if (process.env.HYDRA_APP_LOG === '1') console.log(line); },
    openConsole: (title, executable, args, cwd) => openConsole(consoleLaunch(title, consoleScript(title, executable, args, cwd)), cwd),
    tree: message => { const win = getMainWindow(); if (win && !win.webContents.isDestroyed()) win.webContents.send(HYDRA_TREE, message); whenAway.changed(); },
    // The smoke's stand-in heads: an unpackaged app only, and only when the smoke asks.
    ...(!app.isPackaged && process.env.HYDRA_APP_STANDIN_HEADS === '1' ? { startRun: startStandinHead } : {}),
    post: (project, message) => { const win = getMainWindow(); if (win && !win.webContents.isDestroyed()) win.webContents.send(HYDRA_UI, { projectId: project.id, message }); },
  });
  // OS banners while the user is away (src/core/needsYou.ts decides; needsYouBanners.ts drives). The banner is held until
  // it closes, or Electron may collect it and lose the click.
  const banners = new Set<Notification>();
  const whenAway = new WhenAwayBanners({
    now: () => Date.now(),
    presence: () => { const win = getMainWindow(); return { focused: !!win && win.isFocused() && win.isVisible() && !win.isMinimized(), idleSeconds: powerMonitor.getSystemIdleTime() }; },
    enabled: async () => whenAwayOn(await settings.load()),
    projects: () => hydra.needsYouFacts(),
    chat: async chatId => { const record = await chatStore.get(chatId); return record ? { title: record.title, cwd: record.cwd } : undefined; },
    known: async () => (await state.load()).projects,
    show: (banner, click) => {
      if (!Notification.isSupported()) return;
      const notification = new Notification({ title: banner.title, body: banner.body, silent: false });
      banners.add(notification);
      notification.on('click', () => { click(); });
      notification.on('close', () => banners.delete(notification));
      notification.show();
    },
    // Focus the window and open what it was about: a chat, or the project's Agents view for a head, plan or limit.
    open: banner => {
      if (banner.kind === 'chat-needs' || banner.kind === 'chat-unread') navigate({ kind: 'navigate', to: 'chat', chatId: banner.sourceId, ...(banner.projectId ? { projectId: banner.projectId } : {}) });
      else navigate({ kind: 'navigate', to: 'agents', projectId: banner.projectId });
    },
    log: line => { if (process.env.HYDRA_APP_LOG === '1') console.log(line); },
  });
  const syncHydra = (projects: Project[]) => { void hydra.sync(projects).catch(() => undefined); };
  // Before quitting: end every chat's process, then wait for the store to write what it still holds.
  let flushed = false;
  app.on('before-quit', event => {
    if (flushed) return;
    event.preventDefault();
    try { chats.closeAll(); } catch { /* quit anyway */ }
    try { agentTerminal.stop(); } catch { /* quit anyway */ }
    try { terminals.closeAll(); } catch { /* quit anyway */ }
    try { browser.close(); } catch { /* quit anyway */ }
    try { stopSignIns(); } catch { /* quit anyway */ }
    const timeout = new Promise(resolve => setTimeout(resolve, 5000));
    void Promise.race([Promise.all([chatStore.flush().catch(() => undefined), hydra.shutdown().catch(() => undefined)]), timeout]).finally(() => { flushed = true; app.quit(); });
  });
  // In-app updates (G6): only an installed stable release checks; its channel is in the packaged package.json.
  const channel = (() => { try { return JSON.parse(readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')).hydraChannel as string | undefined; } catch { return undefined; } })();
  const updateDialog = async (options: { message: string; detail?: string; buttons: string[]; cancelId: number; type?: 'info' | 'error' }) => {
    const win = getMainWindow(), box = { type: options.type ?? 'info' as const, title: PRODUCT_NAME, message: options.message, ...(options.detail ? { detail: options.detail } : {}), buttons: options.buttons, cancelId: options.cancelId, defaultId: 0, noLink: true };
    return (win && !win.isDestroyed() ? await dialog.showMessageBox(win, box) : await dialog.showMessageBox(box)).response;
  };
  const updates = new AppUpdates({
    version: HYDRA_APP_VERSION, channel, packaged: app.isPackaged, execPath: process.execPath,
    store: createUpdateStore(userData), tempDir: app.getPath('temp'),
    ask: dialogOptions => updateDialog(dialogOptions),
    tell: async (message, error) => { await updateDialog({ message, buttons: ['OK'], cancelId: 0, type: error ? 'error' : 'info' }); },
    openExternal: url => shell.openExternal(url),
    progress: fraction => { const win = getMainWindow(); if (win && !win.isDestroyed()) win.setProgressBar(fraction ?? -1); },
    running: () => hydra.runningCounts(),
    quit: () => app.quit(),
    log: line => { if (process.env.HYDRA_APP_LOG === '1') console.log(line); },
  });
  app.on('will-quit', () => { updates.stop(); whenAway.stop(); });
  const handlers = createHandlers({
    terminals,
    shellTabs,
    browser,
    pullRequest: pullRequests(),
    fullName: windowsFullName,
    claudeCommands: async cwd => {
      const found = await findProvider('claude', (await settings.load()).cliPaths.claude).catch(() => undefined);
      return found?.available && found.executable ? claudeCommands(found.executable, cwd) : [];
    },
    updates,
    info: { name: PRODUCT_NAME, version: HYDRA_APP_VERSION, electron: process.versions.electron ?? '', platform: process.platform, user: accountName() },
    settings,
    state,
    pickFolder: purpose => pickFolder(purpose),
    cloneRepo: (url, parent) => cloneRepo(url, parent),
    pickExecutable: provider => pickExecutable(provider),
    applyTheme,
    // The checks run in user data, never a project folder, so no project's files are in reach.
    checkSetup: cliPaths => onboardingReport(cliPaths, userData),
    signIn: (provider, configured) => signIn(provider, configured, userData, { openUrl: url => shell.openExternal(url).then(() => true, () => false) }),
    confirmTrust,
    projectsChanged: next => syncHydra(next.projects),
    hydra: { connections: () => hydra.connections(), connect: provider => hydra.connect(provider), disconnect: provider => hydra.disconnect(provider), tree: () => hydra.tree(), agents: (project, message) => hydra.agents(project, message), reply: (requestId, value) => hostUi.reply(requestId, value), control: (project, action) => hydra.control(project, action) },
    projectOpened: cwd => { void state.load().then(loaded => { const project = loaded.projects.find(candidate => samePath(candidate.path, cwd)); if (project) return hydra.open(project); return undefined; }).catch(() => undefined); },
    chats,
    review: { diff: workingTreeDiff, branch: branchSummary, changed: changedPaths, open: (cwd, file) => openInEditor(cwd, file, full => shell.showItemInFolder(full)) },
  });

  app.on('window-all-closed', () => app.quit());
  void app.whenReady().then(async () => {
    guardSession(session.defaultSession);
    protocol.handle(APP_SCHEME, request => serveAppRequest(path.join(distDir, 'renderer'), request.url));
    registerIpc(ipcMain, handlers);
    nativeTheme.themeSource = (await settings.load()).theme;
    nativeTheme.on('updated', repaintTitleBar);
    const win = createMainWindow(distDir);
    // Hydra Settings goes with the window: closing it quits the app as before.
    win.on('closed', () => settingsWindow.close());
    // Focusing or leaving Hydra changes whether the user is away; an idle machine is noticed by the banners' own timer.
    win.on('focus', () => whenAway.changed());
    win.on('blur', () => whenAway.changed());
    win.on('minimize', () => whenAway.changed());
    whenAway.start();
    // A page that (re)loads gets Hydra's open questions again, and every Agents view starts closed until it says so.
    win.webContents.on('did-finish-load', () => { hydra.windowLoaded(); hostUi.resendAll(); });
    // Controllers start when a project is opened (a chat in it), not here: launching the app takes no repository.
    void hydra.sync((await state.load()).projects);
    updates.start();
  });
}

/**
 * Windows' full name for this account ("Nico D", a Microsoft account's display name), for the sidebar's account row:
 * PowerShell's Get-LocalUser, asked once, hidden, with a 10-second limit. Undefined when there is none.
 */
let fullNameAsked: Promise<string | undefined> | undefined;
function windowsFullName(): Promise<string | undefined> {
  if (process.platform !== 'win32') return Promise.resolve(undefined);
  fullNameAsked ??= new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-LocalUser -Name $env:USERNAME -ErrorAction Stop).FullName'], { windowsHide: true, timeout: 10_000 }, (error, stdout) => {
    const name = String(stdout ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    resolve(!error && name && name.length <= 60 ? name : undefined);
  }));
  return fullNameAsked;
}

/** The Windows account's name for the sidebar's account row, or nothing if the OS won't say. */
function accountName(): string | undefined {
  try { return os.userInfo().username || undefined; } catch { return undefined; }
}
