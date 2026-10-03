import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, session, shell, type WebContents } from 'electron';
import type { CliProvider } from '../shared/ipc';
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
