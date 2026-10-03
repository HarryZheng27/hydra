import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, session, shell, type WebContents } from 'electron';
import type { CliProvider } from '../shared/ipc';
import { ChatStore } from '../../../src/core/chat/store';
import { nodeLaunch } from '../../../src/core/chat/launch';
import { findProvider } from '../../../src/core/providers';
import { providerPaths } from '../../../src/core/helperRegistration';
import { readFile } from 'node:fs/promises';
import { CHAT_EVENTS, type Project } from '../shared/ipc';
import { ChatManager } from './chats';
import { consoleLaunch, consoleScript, openConsole } from './console';
import { changedPaths, openInEditor, workingTreeDiff } from './review';
import { createHandlers } from './handlers';
import { onboardingReport, openSignIn } from './onboarding';
import { identityProblems, PRODUCT_NAME } from './identity';
import { registerIpc } from './ipc';
import { APP_SCHEME, confirmAndOpen, guardContents, guardSession, serveAppRequest } from './security';
import { createSettingsStore, createStateStore } from './settings';
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

async function pickFolder(): Promise<string | undefined> {
  const options = { title: 'Open a project folder', properties: ['openDirectory' as const, 'dontAddToRecent' as const] };
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
  const chats = new ChatManager({
    store: chatStore,
    launch: nodeLaunch(),
    warm: true,
    executable: async provider => { const found = await findProvider(provider, (await settings.load()).cliPaths[provider]).catch(() => undefined); return found?.available ? found.executable : undefined; },
    openConsole: (title, executable, args, cwd) => openConsole(consoleLaunch(title, consoleScript(title, executable, args, cwd)), cwd),
    codexConfig: () => readFile(providerPaths().codexConfig, 'utf8').catch(() => undefined),
    trusted: async cwd => (await state.load()).projects.some(project => !!project.trustedAt && samePath(project.path, cwd)),
    push: (chatId, events, start) => { const win = getMainWindow(); if (win && !win.webContents.isDestroyed()) win.webContents.send(CHAT_EVENTS, { chatId, events, start }); },
  });
  // Before quitting: end every chat's process, then wait for the store to write what it still holds.
  let flushed = false;
  app.on('before-quit', event => {
    if (flushed) return;
    event.preventDefault();
    try { chats.closeAll(); } catch { /* quit anyway */ }
    const timeout = new Promise(resolve => setTimeout(resolve, 5000));
    void Promise.race([chatStore.flush().catch(() => undefined), timeout]).finally(() => { flushed = true; app.quit(); });
  });
  const handlers = createHandlers({
    info: { name: PRODUCT_NAME, version: HYDRA_APP_VERSION, electron: process.versions.electron ?? '', platform: process.platform },
    settings,
    state,
    pickFolder: () => pickFolder(),
    pickExecutable: provider => pickExecutable(provider),
    applyTheme,
    // The checks run in user data, never a project folder, so no project's files are in reach.
    checkSetup: cliPaths => onboardingReport(cliPaths, userData),
    signIn: (provider, configured) => openSignIn(provider, configured, userData),
    confirmTrust,
    chats,
    review: { diff: workingTreeDiff, changed: changedPaths, open: (cwd, file) => openInEditor(cwd, file, full => shell.showItemInFolder(full)) },
  });

  app.on('window-all-closed', () => app.quit());
  void app.whenReady().then(async () => {
    guardSession(session.defaultSession);
    protocol.handle(APP_SCHEME, request => serveAppRequest(path.join(distDir, 'renderer'), request.url));
    registerIpc(ipcMain, handlers);
    nativeTheme.themeSource = (await settings.load()).theme;
    nativeTheme.on('updated', repaintTitleBar);
    createMainWindow(distDir);
  });
}
