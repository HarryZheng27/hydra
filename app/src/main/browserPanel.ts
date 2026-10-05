import { session as sessions, WebContentsView, type BrowserWindow } from 'electron';
import { browserUrl } from './browserUrl';

/** What the window's browser panel shows in its toolbar. */
export interface BrowserState { open: boolean; url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean }

/** The panel's own session: in memory, nothing shared with the app's (whose requests stay on the app's scheme). */
const PARTITION = 'hydra-browser';

/**
 * The browser panel beside a chat (Claude desktop's globe): a WebContentsView in its own session, laid over the space
 * the window gives it. It loads only http(s); it gets no preload, no Node, and nothing of the app's; every permission
 * and download is refused; a link that would open a window opens here instead.
 */
export class BrowserPanel {
  private view: WebContentsView | undefined;
  private guarded = false;

  constructor(private readonly deps: { window(): BrowserWindow | undefined; send(state: BrowserState): void }) {}

  private state(): BrowserState {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return { open: false, url: '', title: '', canGoBack: false, canGoForward: false, loading: false };
    return { open: true, url: contents.getURL(), title: contents.getTitle(), canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward(), loading: contents.isLoading() };
  }

  private report(): void { this.deps.send(this.state()); }

  private guardSession(): void {
    if (this.guarded) return;
    this.guarded = true;
    const browserSession = sessions.fromPartition(PARTITION);
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.on('will-download', event => event.preventDefault());
  }

  open(raw?: string): BrowserState {
    const win = this.deps.window();
    if (!win) throw new Error('The window is closed.');
    if (!this.view || this.view.webContents.isDestroyed()) {
      this.guardSession();
      const view = new WebContentsView({ webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false } });
      const contents = view.webContents;
      // Only http(s), in this panel: a navigation elsewhere is stopped, and a new window loads here instead.
      contents.on('will-navigate', (event, url) => { if (!browserUrl(url)) event.preventDefault(); });
      contents.on('will-redirect', (event, url) => { if (!browserUrl(url)) event.preventDefault(); });
      contents.setWindowOpenHandler(({ url }) => { const next = browserUrl(url); if (next) void contents.loadURL(next); return { action: 'deny' }; });
      contents.on('will-attach-webview', event => event.preventDefault());
      for (const event of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading'] as const) contents.on(event as 'did-stop-loading', () => this.report());
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      win.contentView.addChildView(view);
      this.view = view;
    }
    const url = raw === undefined ? undefined : browserUrl(raw);
    if (raw !== undefined && !url) throw new Error('The browser opens http and https pages only.');
    if (url) void this.view.webContents.loadURL(url);
    const state = this.state();
    this.deps.send(state);
    return state;
  }

  navigate(raw: string): BrowserState {
    const url = browserUrl(raw);
    if (!url) throw new Error('The browser opens http and https pages only.');
    return this.open(url);
  }

  /** Where the panel's page goes, in the window's CSS pixels; zero hides it (a dialog over it, say). */
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    if (!this.view) return;
    const round = (value: number) => Math.max(0, Math.round(value));
    this.view.setBounds({ x: round(bounds.x), y: round(bounds.y), width: round(bounds.width), height: round(bounds.height) });
  }

  back(): void { const history = this.view?.webContents.navigationHistory; if (history?.canGoBack()) history.goBack(); }
  forward(): void { const history = this.view?.webContents.navigationHistory; if (history?.canGoForward()) history.goForward(); }
  reload(): void { this.view?.webContents.reload(); }

  close(): void {
    const view = this.view;
    this.view = undefined;
    if (view) {
      try { this.deps.window()?.contentView.removeChildView(view); } catch { /* the window is gone */ }
      try { view.webContents.close(); } catch { /* already closed */ }
    }
    this.report();
  }
}
