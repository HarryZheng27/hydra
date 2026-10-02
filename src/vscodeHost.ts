import * as vscode from 'vscode';
import { machineSetting } from './core/machineSetting';
import { notices } from './notices';
import type { Disposable, Host, HostPaths, HostSettings, NoticeLevel } from './host/host';

/**
 * The IDE's Host (docs/internal/hydra-app/G2-host-split.md): each method does exactly what the extension did before
 * the controller moved, so moving code behind Host changes nothing a user sees. Toasts go through `notices` (Hydra's
 * own toasts in the desktop app); modal confirmations stay the editor's own, as they always were.
 */
export class VsCodeHost implements Host {
  readonly settings: HostSettings;
  readonly paths: HostPaths;
  constructor(context: vscode.ExtensionContext, private readonly output: Pick<vscode.OutputChannel, 'appendLine'>, private readonly post: (message: unknown) => Thenable<unknown> | undefined) {
    const config = () => vscode.workspace.getConfiguration('hydra');
    this.settings = {
      get: <T>(key: string, fallback: T) => config().get<T>(key, fallback),
      machine: <T>(key: string) => machineSetting<T>(config(), key),
      update: async (key, value) => { await config().update(key, value, vscode.ConfigurationTarget.Global); },
      onChange: (listener): Disposable => vscode.workspace.onDidChangeConfiguration(event => {
        if (!event.affectsConfiguration('hydra')) return;
        listener(key => event.affectsConfiguration(key ? `hydra.${key}` : 'hydra'));
      }),
    };
    this.paths = { storage: context.globalStorageUri.fsPath, dist: vscode.Uri.joinPath(context.extensionUri, 'dist').fsPath };
  }
  log(line: string): void { this.output.appendLine(line); }
  notify(level: NoticeLevel, message: string, ...actions: string[]): Promise<string | undefined> { return notices[level](message, ...actions); }
  async confirm(message: string, action: string, detail?: string): Promise<boolean> {
    return await vscode.window.showWarningMessage(message, { modal: true, ...(detail !== undefined ? { detail } : {}) }, action) === action;
  }
  async postToUi(message: unknown): Promise<void> { await this.post(message); }
}
