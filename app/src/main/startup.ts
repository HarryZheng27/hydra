import path from 'node:path';
import { app, ipcMain, Menu, protocol } from 'electron';
import { PRODUCT_NAME } from './identity';
import { registerIpc, type Handlers } from './ipc';
import { APP_SCHEME, serveAppRequest } from './security';
import { createMainWindow, focusMainWindow } from './window';

declare const HYDRA_APP_VERSION: string;

/** Runs after identity.ts has set the app's paths (main.ts). */
export function start(): void {
  // The lock is keyed on the user-data folder, which is already %APPDATA%\Hydra App, so the IDE's never collides.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => focusMainWindow());

  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  Menu.setApplicationMenu(null);

  const distDir = __dirname;
  const handlers: Handlers = {
    'app.info': () => ({ name: PRODUCT_NAME, version: HYDRA_APP_VERSION, electron: process.versions.electron ?? '', platform: process.platform }),
  };

  app.on('window-all-closed', () => app.quit());
  void app.whenReady().then(() => {
    protocol.handle(APP_SCHEME, request => serveAppRequest(path.join(distDir, 'renderer'), request.url));
    registerIpc(ipcMain, handlers);
    createMainWindow(distDir);
  });
}
