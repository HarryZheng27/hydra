import * as vscode from 'vscode';
import { machineSetting } from './core/machineSetting';
import { notices } from './notices';
import type { Disposable, Host, HostFolder, HostPaths, HostSettings, HostState, NoticeLevel, PickItem } from './host/host';

/**
 * The IDE's Host (docs/internal/hydra-app/G2-host-split.md): each method does exactly what the extension did before
 * the controller moved, so moving code behind Host changes nothing a user sees. Toasts go through `notices` (Hydra's
 * own toasts in the desktop app); modal confirmations stay the editor's own, as they always were.
 */
export class VsCodeHost implements Host {
  readonly settings: HostSettings;
  readonly state: HostState;
  readonly paths: HostPaths;
  readonly development: boolean;
  /**
   * `toEditor` leaves the Agent Manager first when a file is about to open, since the Agent Manager is the whole window.
   */
  constructor(private readonly context: vscode.ExtensionContext, private readonly output: Pick<vscode.OutputChannel, 'appendLine'>, private readonly post: (message: unknown) => Thenable<unknown> | undefined, private readonly toEditor: () => Promise<void> = async () => {}) {
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
    this.state = { get: <T>(key: string, fallback: T) => context.workspaceState.get<T>(key, fallback), update: async (key, value) => { await context.workspaceState.update(key, value); } };
    this.development = context.extensionMode !== vscode.ExtensionMode.Production;
    this.paths = { storage: context.globalStorageUri.fsPath, dist: vscode.Uri.joinPath(context.extensionUri, 'dist').fsPath };
  }
  log(line: string): void { this.output.appendLine(line); }
  notify(level: NoticeLevel, message: string, ...actions: string[]): Promise<string | undefined> { return notices[level](message, ...actions); }
  async confirm(message: string, action: string, detail?: string): Promise<boolean> {
    return await vscode.window.showWarningMessage(message, { modal: true, ...(detail !== undefined ? { detail } : {}) }, action) === action;
  }
  async pickMany<T extends PickItem>(items: T[], options: { title: string; placeHolder: string }): Promise<T[] | undefined> {
    return await vscode.window.showQuickPick(items, { canPickMany: true, title: options.title, placeHolder: options.placeHolder });
  }
  async openFile(file: string, options: { preview: boolean }): Promise<void> {
    await this.toEditor();
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), { preview: options.preview });
  }
  async openUrl(url: string): Promise<void> { await vscode.env.openExternal(vscode.Uri.parse(url, true)); }
  folders(): HostFolder[] { return (vscode.workspace.workspaceFolders || []).map(folder => ({ path: folder.uri.fsPath, uri: folder.uri.toString() })); }
  trusted(): boolean { return vscode.workspace.isTrusted; }
  /** This window's extension host and its main process start the official extensions' CLIs and Hydra's terminals. */
  windowProcessIds(): number[] { return [process.pid, process.ppid]; }
  watch(folder: string, pattern: string, listener: () => void): Disposable {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(folder), pattern));
    watcher.onDidChange(listener); watcher.onDidCreate(listener); watcher.onDidDelete(listener);
    this.context.subscriptions.push(watcher);
    return watcher;
  }
  keep(disposable: Disposable): void { this.context.subscriptions.push(disposable); }
  async closeWindow(): Promise<void> { await vscode.commands.executeCommand('workbench.action.closeWindow'); }
  extension(id: string): { path: string; version?: string } | undefined {
    const found = vscode.extensions.getExtension(id);
    return found && { path: found.extensionPath, version: (found.packageJSON as { version?: string } | undefined)?.version };
  }
  async installExtension(source: { id: string } | { file: string }): Promise<void> {
    await vscode.commands.executeCommand('workbench.extensions.installExtension', 'id' in source ? source.id : vscode.Uri.file(source.file));
  }
  async postToUi(message: unknown): Promise<void> { await this.post(message); }
}
