import path from 'node:path';
import { BrowserWindow, ipcMain, nativeTheme, type IpcMainEvent } from 'electron';
import { SettingsShell } from '../../../src/settings/shell';
import type { SettingsImports } from '../../../src/settings/types';
import type { PackService } from '../../../src/core/packs/service';
import type { Host } from '../../../src/host/host';
import { vscodeThemeVariables } from '../shared/theme';
import { hardenedWebPreferences } from './security';

/** The settings window's two channels: its page's messages to main, and main's back. */
export const SETTINGS_POST = 'hydra-settings:post';
export const SETTINGS_MESSAGE = 'hydra-settings:message';

/** Settings → General's import (the IDE's, from VS Code or Cursor) isn't in the app: the page shows it as unavailable. */
export const noSettingsImports: SettingsImports = {
  available: false,
  status: async () => ({ available: false, interrupted: false }),
  choose: async () => { throw new Error('Importing editor settings is the IDE\'s.'); },
  apply: async () => { throw new Error('Importing editor settings is the IDE\'s.'); },
  undo: async () => { throw new Error('Importing editor settings is the IDE\'s.'); },
};

/**
 * The settings page's HTML (SettingsShell.html, the IDE's own pages) with the app's theme as VS Code's CSS variables,
 * added inside its own nonce'd style, so the page's CSP (nonce-only styles and scripts) stays exactly the IDE's.
 */
export function settingsDocument(html: string, theme: 'dark' | 'light'): string {
  const variables = Object.entries(vscodeThemeVariables(theme)).map(([name, value]) => `${name}:${value}`).join(';');
  const style = /<style nonce="([^"]+)">/.exec(html);
  if (!style) throw new Error('The settings page has no style to theme.');
  return html.replace(style[0], `${style[0]}:root{${variables}}body{background:var(--vscode-editor-background);color:var(--vscode-foreground)}`);
}

/**
 * Hydra Settings in the app (G5 milestone 5): the IDE's own settings pages (src/settings), unchanged, in their own
 * window, for one project at a time, as the IDE shows them per window. The page is a data: document with the IDE's
 * CSP (scripts and styles only by its nonce); its preload gives it `window.hydraBridge` (G2's bridge), and only its
 * own main frame's messages are taken. Each one goes to the project's SettingsShell, which checks it as in the IDE.
 */
export class HydraSettingsWindow {
  private win?: BrowserWindow;
  private shell?: SettingsShell;
  private projectId?: string;
  private pageId?: string;
  private readonly onPost = (event: IpcMainEvent, message: unknown) => {
    const win = this.win, shell = this.shell;
    if (!win || win.isDestroyed() || !shell || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return;
    if (JSON.stringify(message ?? null).length > 200_000) return;
    void shell.receive(message, this.post, this.pageId);
  };
  private readonly post = async (message: unknown): Promise<boolean> => {
    const win = this.win;
    if (!win || win.isDestroyed()) return false;
    win.webContents.send(SETTINGS_MESSAGE, message);
    return true;
  };

  constructor(private readonly distDir: string) { ipcMain.on(SETTINGS_POST, this.onPost); }

  /** Opens (or brings forward) Hydra Settings for a project, on a page. Another project's settings are replaced. */
  async open(projectId: string, projectName: string, parts: { host: Host; packs: PackService }, pageId?: string): Promise<void> {
    if (this.win && !this.win.isDestroyed() && this.projectId === projectId) {
      this.pageId = pageId;
      if (pageId) await this.post({ type: 'showPage', id: pageId });
      this.win.show(); this.win.focus();
      return;
    }
    this.close();
    const shell = new SettingsShell(parts.host, noSettingsImports, parts.packs);
    const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    const win = new BrowserWindow({
      title: `Hydra Settings · ${projectName}`, width: 980, height: 720, minWidth: 640, minHeight: 420, show: false, autoHideMenuBar: true,
      backgroundColor: theme === 'dark' ? '#141414' : '#FAFBF9', icon: path.join(this.distDir, 'icon.png'),
      webPreferences: hardenedWebPreferences(path.join(this.distDir, 'settings-preload.cjs')),
    });
    this.win = win; this.shell = shell; this.projectId = projectId; this.pageId = pageId;
    shell.attach(this.post);
    win.on('closed', () => { if (this.win === win) { shell.detach(this.post); this.win = undefined; this.shell = undefined; this.projectId = undefined; } });
    // The window keeps its name, with the project's, over the page's own <title>.
    win.on('page-title-updated', event => event.preventDefault());
    win.once('ready-to-show', () => win.show());
    const document = settingsDocument(shell.html(), theme);
    await win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(document, 'utf8').toString('base64')}`);
  }
  /** The project whose settings are open, if any. */
  get openFor(): string | undefined { return this.win && !this.win.isDestroyed() ? this.projectId : undefined; }
  /** Pages to post again when something outside them changed (the controller's refreshSettingsPages). */
  async refresh(projectId: string, pages: string[]): Promise<void> { if (this.openFor === projectId) await this.shell?.refreshPages(pages); }
  close(): void { if (this.win && !this.win.isDestroyed()) this.win.destroy(); this.win = undefined; this.shell = undefined; this.projectId = undefined; }
  /** The project stopped or was removed: its settings close. */
  closeFor(projectId: string): void { if (this.projectId === projectId) this.close(); }
}
