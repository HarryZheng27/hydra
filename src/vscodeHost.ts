import * as vscode from 'vscode';
import { machineSetting } from './core/machineSetting';
import { notices } from './notices';
import type { ChangeSide, Disposable, Host, HostFolder, HostPaths, HostSection, HostSettings, HostState, HostTerminal, InputOptions, NoticeLevel, PickItem } from './host/host';

/**
 * The IDE's Host (docs/internal/hydra-app/G2-host-split.md): each method does exactly what the extension did before
 * the controller moved, so moving code behind Host changes nothing a user sees. Toasts go through `notices` (Hydra's
 * own toasts in the desktop app); modal confirmations stay the editor's own, as they always were.
 */
export class VsCodeHost implements Host {
  readonly settings: HostSettings;
  readonly state: HostState;
  readonly globalState: HostState;
  readonly paths: HostPaths;
  readonly development: boolean;
  readonly version: string;
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
    this.globalState = { get: <T>(key: string, fallback: T) => context.globalState.get<T>(key, fallback), update: async (key, value) => { await context.globalState.update(key, value); } };
    this.development = context.extensionMode !== vscode.ExtensionMode.Production;
    this.version = String((context.extension.packageJSON as { version?: unknown } | undefined)?.version ?? '0.0.0');
    this.paths = { storage: context.globalStorageUri.fsPath, dist: vscode.Uri.joinPath(context.extensionUri, 'dist').fsPath, appRoot: vscode.env.appRoot, extension: context.extensionPath };
  }
  log(line: string): void { this.output.appendLine(line); }
  notify(level: NoticeLevel, message: string, ...actions: string[]): Promise<string | undefined> { return notices[level](message, ...actions); }
  async confirm(message: string, action: string, detail?: string): Promise<boolean> {
    return await vscode.window.showWarningMessage(message, { modal: true, ...(detail !== undefined ? { detail } : {}) }, action) === action;
  }
  async command<T = unknown>(id: string, ...args: unknown[]): Promise<T> { return await vscode.commands.executeCommand<T>(id, ...args); }
  section(name: string): HostSection {
    const config = () => vscode.workspace.getConfiguration(name);
    return {
      get: <T>(key: string, fallback: T) => config().get<T>(key, fallback),
      inspect: <T>(key: string) => config().inspect<T>(key),
      update: async (key, value) => { await config().update(key, value, vscode.ConfigurationTarget.Global); },
    };
  }
  colorTheme(): 'light' | 'dark' {
    const kind = vscode.window.activeColorTheme.kind;
    return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark';
  }
  onColorThemeChange(listener: () => void): Disposable { return vscode.window.onDidChangeActiveColorTheme(() => listener()); }
  iconThemes(): { id: string; label: string }[] {
    const themes = [{ id: '', label: 'None' }];
    for (const extension of vscode.extensions.all) {
      const contributed = (extension.packageJSON as { contributes?: { iconThemes?: { id: string; label?: string }[] } } | undefined)?.contributes?.iconThemes;
      for (const theme of contributed || []) themes.push({ id: theme.id, label: theme.label || theme.id });
    }
    return themes;
  }
  async pickFolder(title: string): Promise<string | undefined> {
    const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title });
    return picked?.[0]?.fsPath;
  }
  async revealInOS(file: string): Promise<void> { await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(file)); }
  async ask(level: 'info' | 'warning', message: string, detail: string | undefined, ...actions: string[]): Promise<string | undefined> {
    const options = { modal: true, ...(detail !== undefined ? { detail } : {}) };
    return level === 'info' ? await vscode.window.showInformationMessage(message, options, ...actions) : await vscode.window.showWarningMessage(message, options, ...actions);
  }
  async input(options: InputOptions): Promise<string | undefined> { return await vscode.window.showInputBox(options); }
  async pick<T extends PickItem>(items: T[], options: { title?: string; placeHolder?: string; ignoreFocusOut?: boolean; matchOnDetail?: boolean }): Promise<T | undefined> { return await vscode.window.showQuickPick(items, options); }
  async copy(text: string): Promise<void> { await vscode.env.clipboard.writeText(text); }
  withProgress<T>(title: string, task: (progress: { report(value: { message?: string }): void }) => Promise<T>): Promise<T> { return notices.withProgress({ title }, progress => task(progress)); }
  async openFolder(folder: string, options: { forceNewWindow: boolean; forceReuseWindow?: boolean }): Promise<void> {
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), options);
  }
  /** VS Code's built-in Simple Browser (decision 4): untrusted content, no Hydra access. */
  async openPreview(url: string): Promise<boolean> {
    // simpleBrowser.api.open is Simple Browser's own API command and its activation event, so it works
    // before the extension has loaded (getCommands() doesn't list an unactivated extension's commands).
    try {
      await vscode.commands.executeCommand('simpleBrowser.api.open', vscode.Uri.parse(url, true), { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
      return true;
    } catch { return false; }
  }
  async openMarkdown(file: string, options: { fallback?: boolean } = {}): Promise<void> {
    const uri = vscode.Uri.file(file);
    if (options.fallback === false) { await vscode.commands.executeCommand('markdown.showPreview', uri); return; }
    try { await vscode.commands.executeCommand('markdown.showPreview', uri); }
    catch { const doc = await vscode.workspace.openTextDocument(uri); await vscode.window.showTextDocument(doc, { preview: true }); }
  }
  registerTextSource(scheme: string, provide: (path: string, query: string) => Promise<string>): Disposable {
    return vscode.workspace.registerTextDocumentContentProvider(scheme, { provideTextDocumentContent: uri => provide(uri.path, uri.query) });
  }
  async openChanges(title: string, resources: [ChangeSide, ChangeSide, ChangeSide][]): Promise<void> {
    const uri = (side: ChangeSide) => 'file' in side ? vscode.Uri.file(side.file) : vscode.Uri.from({ scheme: side.scheme, path: side.path, query: side.query });
    await vscode.commands.executeCommand('vscode.changes', title, resources.map(resource => resource.map(uri)));
  }
  async pickMany<T extends PickItem>(items: T[], options: { title: string; placeHolder: string }): Promise<T[] | undefined> {
    return await vscode.window.showQuickPick(items, { canPickMany: true, title: options.title, placeHolder: options.placeHolder });
  }
  async openFile(file: string, options: { preview: boolean }): Promise<void> {
    await this.toEditor();
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), { preview: options.preview });
  }
  async openUrl(url: string): Promise<boolean> { return await vscode.env.openExternal(vscode.Uri.parse(url, true)); }
  get remote(): boolean { return !!vscode.env.remoteName; }
  focused(): boolean { return vscode.window.state.focused; }
  onFocusChange(listener: (focused: boolean) => void): Disposable { return vscode.window.onDidChangeWindowState(state => listener(state.focused)); }
  openTerminal(options: { name: string; cwd: string; shellPath: string; shellArgs: string[] }): HostTerminal {
    const terminal = vscode.window.createTerminal({ ...options, isTransient: true });
    terminal.show(false);
    return {
      dispose: () => terminal.dispose(),
      onClose: listener => vscode.window.onDidCloseTerminal(closed => { if (closed === terminal) listener(); }),
    };
  }
  async openText(content: string, language: string): Promise<void> {
    await this.toEditor();
    const document = await vscode.workspace.openTextDocument({ language, content });
    await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  }
  async openFileBeside(file: string): Promise<void> {
    await this.toEditor();
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true, viewColumn: vscode.ViewColumn.Beside });
  }
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
