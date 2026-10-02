import * as vscode from 'vscode';
import type { SettingsImport } from './extensionImport';
import type { PackService } from './core/packs/service';
import { SettingsShell } from './settings/shell';
import { VsCodeHost } from './vscodeHost';

/**
 * Hydra Settings in the IDE: src/settings/shell.ts's pages in a webview panel. Exported as AppearanceSettings for
 * extension.ts and extensionOnboarding.ts, which only use the appearance methods and .show()/.dispose().
 */
export class AppearanceSettings implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly subscription: vscode.Disposable;
  private readonly shell: SettingsShell;
  constructor(private readonly context: vscode.ExtensionContext, imports: SettingsImport, packs: PackService) {
    // The pages' own Host: settings, commands and dialogs. They never log or post to the Agents view.
    const host = new VsCodeHost(context, { appendLine: () => undefined }, () => undefined);
    this.shell = new SettingsShell(host, imports, packs);
    this.subscription = host.onColorThemeChange(() => this.shell.publishAppearance());
  }
  show(pageId?: string): void {
    if (this.panel) {
      this.panel.reveal();
      if (pageId) void this.panel.webview.postMessage({ type: 'showPage', id: pageId });
      return;
    }
    const panel = vscode.window.createWebviewPanel('hydra.settings', 'Hydra Settings', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.panel = panel;
    const post = (message: unknown) => panel.webview.postMessage(message);
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'hydra-logo.png');
    panel.webview.html = this.shell.html();
    this.shell.attach(post);
    panel.onDidDispose(() => { if (this.panel === panel) this.panel = undefined; this.shell.detach(post); });
    panel.webview.onDidReceiveMessage((message: unknown) => this.shell.receive(message, post, pageId));
  }
  /** Re-post some pages' state to an open Settings panel, when something outside it changed (a packs folder or packs.json edit). */
  async refreshPages(ids: readonly string[]): Promise<void> {
    if (!this.panel) return;
    await this.shell.refreshPages(ids);
  }
  setAppearance(mode: 'dark' | 'light'): Promise<void> { return this.shell.setAppearance(mode); }
  dispose(): void { this.subscription.dispose(); this.panel?.dispose(); }
}
