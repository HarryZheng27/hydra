import path from 'node:path';
import { BrowserWindow, nativeTheme } from 'electron';
import { themeVariables, titleBarColors, type ThemeSetting } from '../shared/theme';
import { PRODUCT_NAME } from './identity';
import { APP_URL, hardenedWebPreferences } from './security';

/** The title bar's height, in CSS pixels; the renderer's title bar matches it. */
export const TITLE_BAR_HEIGHT = 40;

let mainWindow: BrowserWindow | undefined;

export const getMainWindow = (): BrowserWindow | undefined => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined);

const currentTheme = () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');

/** Opens the app's one window. It stays hidden until its first paint, so it never flashes. */
export function createMainWindow(distDir: string): BrowserWindow {
  const theme = currentTheme();
  const win = new BrowserWindow({
    title: PRODUCT_NAME,
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: themeVariables(theme)['--bg'],
    // The renderer draws the title bar (sidebar toggle, Chat / Agents); Windows draws its buttons over it.
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...titleBarColors(theme), height: TITLE_BAR_HEIGHT },
    autoHideMenuBar: true,
    webPreferences: hardenedWebPreferences(path.join(distDir, 'preload.cjs')),
  });
  mainWindow = win;
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { if (mainWindow === win) mainWindow = undefined; });
  void win.loadURL(APP_URL);
  return win;
}

/** Sets the theme the app follows; the page follows through prefers-color-scheme, and the title bar here. */
export function applyTheme(setting: ThemeSetting): void {
  nativeTheme.themeSource = setting;
  repaintTitleBar();
}

export function repaintTitleBar(): void {
  const win = getMainWindow();
  if (!win) return;
  const theme = currentTheme();
  win.setTitleBarOverlay({ ...titleBarColors(theme), height: TITLE_BAR_HEIGHT });
  win.setBackgroundColor(themeVariables(theme)['--bg']!);
}

/** A second launch brings the running window forward instead of opening another app. */
export function focusMainWindow(): void {
  const win = getMainWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
