import path from 'node:path';
import { BrowserWindow } from 'electron';
import { PRODUCT_NAME } from './identity';
import { APP_URL, hardenedWebPreferences } from './security';

let mainWindow: BrowserWindow | undefined;

export const getMainWindow = (): BrowserWindow | undefined => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined);

/** Opens the app's one window. It stays hidden until its first paint, so it never flashes white. */
export function createMainWindow(distDir: string): BrowserWindow {
  const win = new BrowserWindow({
    title: PRODUCT_NAME,
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: '#141414',
    autoHideMenuBar: true,
    webPreferences: hardenedWebPreferences(path.join(distDir, 'preload.cjs')),
  });
  mainWindow = win;
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { if (mainWindow === win) mainWindow = undefined; });
  void win.loadURL(APP_URL);
  return win;
}

/** A second launch brings the running window forward instead of opening another app. */
export function focusMainWindow(): void {
  const win = getMainWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
