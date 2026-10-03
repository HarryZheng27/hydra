import { createHash } from 'node:crypto';
import { watch as watchFolder, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { BrowserWindow, clipboard, dialog, nativeTheme, shell, type MessageBoxOptions } from 'electron';
import type { ChangeSide, Disposable, Host, HostFolder, HostPaths, HostSection, HostSettings, HostState, HostTerminal, InputOptions, NoticeLevel, PickItem } from '../../../src/host/host';
import { ideHydraStorage } from './identity';
import { getMainWindow } from './window';

/**
 * The Hydra app's Host (docs/internal/hydra-app/G5-orchestration.md): what the controller needs from the program it
 * runs in, one per project (the app's projects are what the IDE's windows are: a folder, its own controller and
 * storage). Paths, settings and state are the app's; storage is the IDE's own, so the two share heads, plans and
 * ownership. G2's Result lists where this must differ from the IDE's; each method below says what it does here.
 */

/** The IDE's Hydra storage, which the app shares (identity.ts is the one place that names the IDE's data folder). */
export const ideStorageRoot = (env: NodeJS.ProcessEnv = process.env): string => ideHydraStorage(env);

/**
 * A folder as VS Code writes its URI (`Uri.file(path).toString()`): `file:///c%3A/Users/...`, the drive letter lower
 * case and everything but `A-Z a-z 0-9 - . _ ~ /` percent-encoded. The IDE keys a window's storage by these, so the
 * app's key for a folder is the IDE's key for a window of that one folder (checked against the IDE's own folders).
 */
export function vscodeFolderUri(folder: string): string {
  const resolved = path.resolve(folder);
  const drive = /^([A-Za-z]):[\\/]?(.*)$/.exec(resolved);
  const encode = (text: string) => text.replace(/[^A-Za-z0-9\-._~/]/g, character => [...Buffer.from(character, 'utf8')].map(byte => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join(''));
  if (drive) return `file:///${drive[1]!.toLowerCase()}%3A/${encode(drive[2]!.replace(/\\/g, '/'))}`;
  // A share (`\\server\share\x`): VS Code makes the server the URI's authority.
  const unc = /^[\\/]{2}([^\\/]+)[\\/]?(.*)$/.exec(resolved);
  if (unc) return `file://${encode(unc[1]!.toLowerCase())}/${encode(unc[2]!.replace(/\\/g, '/'))}`;
  return `file://${encode(resolved.replace(/\\/g, '/'))}`;
}
/** The IDE's per-window storage key for a window with just this folder. */
export const folderKey = (folder: string): string => createHash('sha256').update(vscodeFolderUri(folder)).digest('hex').slice(0, 16);

/** Synchronous reads over a store that writes in the background: the controller reads settings and state synchronously. */
export interface ValueStore {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Promise<void>;
  onChange?(listener: (key: string) => void): Disposable;
}

export interface ElectronHostOptions {
  folder: string;
  paths: HostPaths;
  settings: ValueStore;
  /** CLI paths from the app's own settings (machine settings: never from a project). */
  machine: (key: string) => unknown;
  state: ValueStore;
  globalState: ValueStore;
  trusted: () => boolean;
  log: (line: string) => void;
  version: string;
  /** Never rewrites the user's Claude and Codex connections (G5 milestone 2 adds the registration rule). */
  development: boolean;
  /** Sends to the app's window; dropped when it has no Agents view open. */
  post?: (message: unknown) => void;
  /** Shows a notice in the app's window. */
  notice?: (level: NoticeLevel, message: string) => void;
  /** `hydra close` here: the project's controller stops. */
  closeWindow?: () => void;
  /** Opens a console window the user owns (Open in terminal's): for a CLI's own interactive flow. */
  openConsole?: (title: string, executable: string, args: string[], cwd: string) => Promise<{ started: boolean; error?: string }>;
}

const globToRegExp = (glob: string): RegExp => {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '/' && glob.slice(i + 1, i + 3) === '**' && i + 3 === glob.length) { out += '(?:/.*)?'; break; }
    if (c === '*' && glob[i + 1] === '*') { out += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (c === '*') out += '[^/]*';
    else if (c === '{') { const end = glob.indexOf('}', i); out += `(?:${glob.slice(i + 1, end).split(',').map(part => part.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')).join('|')})`; i = end; }
    else out += c.replace(/[.+^$()|[\]\\?]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
};

export class ElectronHost implements Host {
  readonly settings: HostSettings;
  readonly state: HostState;
  readonly globalState: HostState;
  readonly paths: HostPaths;
  readonly development: boolean;
  readonly version: string;
  readonly remote = false;
  readonly hasExtensions = false;
  private readonly kept: Disposable[] = [];
  private readonly commands = new Map<string, (...args: unknown[]) => unknown>();
  private readonly textSources = new Map<string, (path: string, query: string) => Promise<string>>();

  constructor(private readonly options: ElectronHostOptions) {
    this.paths = options.paths;
    this.development = options.development;
    this.version = options.version;
    this.settings = {
      get: <T>(key: string, fallback: T) => options.settings.get(key, fallback),
      machine: <T>(key: string) => options.machine(key) as T | undefined,
      update: (key, value) => options.settings.update(key, value),
      onChange: listener => options.settings.onChange?.(changed => listener(key => !key || changed === key || changed.startsWith(`${key}.`))) ?? { dispose: () => undefined },
    };
    this.state = { get: (key, fallback) => options.state.get(key, fallback), update: (key, value) => options.state.update(key, value) };
    this.globalState = { get: (key, fallback) => options.globalState.get(key, fallback), update: (key, value) => options.globalState.update(key, value) };
  }

  log(line: string): void { this.options.log(line); }
  /** A notice in the app's window; actions aren't offered yet (G5 milestone 5), so it resolves as dismissed. */
  async notify(level: NoticeLevel, message: string): Promise<string | undefined> { this.options.notice?.(level, message); this.log(`[notice] ${message}`); return undefined; }

  // ---- Modal questions: main's own native dialog, so the page can never answer one (G2: "in-window equivalents"). ----
  private async box(options: MessageBoxOptions): Promise<number> {
    const win = getMainWindow();
    return (win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)).response;
  }
  async confirm(message: string, action: string, detail?: string): Promise<boolean> {
    return await this.box({ type: 'warning', message, ...(detail ? { detail } : {}), buttons: [action, 'Cancel'], defaultId: 1, cancelId: 1, noLink: true }) === 0;
  }
  async ask(level: 'info' | 'warning', message: string, detail: string | undefined, ...actions: string[]): Promise<string | undefined> {
    const response = await this.box({ type: level, message, ...(detail ? { detail } : {}), buttons: [...actions, 'Cancel'], cancelId: actions.length, defaultId: actions.length, noLink: true });
    return actions[response];
  }
  /** Lists and text boxes need the app's own in-window picker (G5 milestone 5); until then they resolve as dismissed. */
  async pick<T extends PickItem>(_items: T[], options: { title?: string }): Promise<T | undefined> { this.log(`[host] a list (${options.title ?? 'untitled'}) isn't shown in the app yet`); return undefined; }
  async pickMany<T extends PickItem>(_items: T[], options: { title: string }): Promise<T[] | undefined> { this.log(`[host] a list (${options.title}) isn't shown in the app yet`); return undefined; }
  async input(options: InputOptions): Promise<string | undefined> { this.log(`[host] a text box (${options.title ?? options.prompt ?? 'untitled'}) isn't shown in the app yet`); return undefined; }
  async copy(text: string): Promise<void> { clipboard.writeText(text); }
  async withProgress<T>(title: string, task: (progress: { report(value: { message?: string }): void }) => Promise<T>): Promise<T> {
    this.log(`[progress] ${title}`);
    return task({ report: value => { if (value.message) this.log(`[progress] ${title}: ${value.message}`); } });
  }

  // ---- Opening things: the app has no editor; it shows files in their folder and pages in the browser. ----
  async openFolder(folder: string): Promise<void> { this.log(`[host] open folder ${folder}: open it as a project in the app`); }
  async openPreview(): Promise<boolean> { return false; }
  async openMarkdown(file: string): Promise<void> { shell.showItemInFolder(file); }
  registerTextSource(scheme: string, provide: (path: string, query: string) => Promise<string>): Disposable {
    this.textSources.set(scheme, provide);
    return { dispose: () => { if (this.textSources.get(scheme) === provide) this.textSources.delete(scheme); } };
  }
  async openChanges(title: string): Promise<void> { this.log(`[host] ${title}: use Review changes in the chat`); }
  async openFile(file: string): Promise<void> { shell.showItemInFolder(file); }
  async openText(_content: string, language: string): Promise<void> { this.log(`[host] a ${language} document isn't shown in the app yet`); }
  async openFileBeside(file: string): Promise<void> { shell.showItemInFolder(file); }
  async openUrl(url: string): Promise<boolean> {
    if (!/^https?:\/\//i.test(url)) return false;
    try { await shell.openExternal(url); return true; } catch { return false; }
  }
  async revealInOS(file: string): Promise<void> { shell.showItemInFolder(file); }
  async pickFolder(title: string): Promise<string | undefined> {
    const win = getMainWindow();
    const options = { title, properties: ['openDirectory' as const, 'dontAddToRecent' as const] };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return result.canceled ? undefined : result.filePaths[0];
  }
  async closeWindow(): Promise<void> { this.options.closeWindow?.(); }

  focused(): boolean { return !!BrowserWindow.getFocusedWindow(); }
  onFocusChange(listener: (focused: boolean) => void): Disposable {
    const win = getMainWindow();
    if (!win) return { dispose: () => undefined };
    const focus = () => listener(true), blur = () => listener(false);
    win.on('focus', focus); win.on('blur', blur);
    return { dispose: () => { if (!win.isDestroyed()) { win.off('focus', focus); win.off('blur', blur); } } };
  }
  /** A CLI's own interactive flow (Claude's sign-in, for one), in a console window the user owns and Hydra never reads. */
  openTerminal(options: { name: string; cwd: string; shellPath: string; shellArgs: string[] }): HostTerminal {
    const closers = new Set<() => void>();
    void this.options.openConsole?.(options.name, options.shellPath, options.shellArgs, options.cwd).then(result => { if (!result.started) for (const close of closers) close(); });
    return { dispose: () => undefined, onClose: listener => { closers.add(listener); return { dispose: () => closers.delete(listener) }; } };
  }

  folders(): HostFolder[] { return [{ path: this.options.folder, uri: vscodeFolderUri(this.options.folder) }]; }
  trusted(): boolean { return this.options.trusted(); }
  /** The app's main process starts every chat's CLI, so its descendants are this project's leads (src/core/leadVerification.ts). */
  windowProcessIds(): number[] { return [process.pid]; }
  watch(folder: string, pattern: string, listener: () => void): Disposable {
    const glob = pattern.replace(/\\/g, '/');
    const match = globToRegExp(glob);
    // Only the pattern's fixed leading folder is watched (`.hydra` for `.hydra/{packs.json,packs/**}`), never the whole
    // repository: a build or an install there would flood the main process. Until that folder exists, the project's
    // top level is watched (not recursively) for it to appear.
    const fixed = glob.split('/').findIndex(part => /[*?{[]/.test(part));
    const prefix = glob.split('/').slice(0, fixed < 0 ? -1 : fixed).join('/');
    let inner: FSWatcher | undefined, outer: FSWatcher | undefined;
    const fire = (name: string) => { if (match.test(name)) listener(); };
    const arm = () => {
      if (inner || !prefix) return;
      try {
        inner = watchFolder(path.join(folder, prefix), { recursive: true }, (_event, name) => fire(name ? `${prefix}/${String(name).replace(/\\/g, '/')}` : prefix));
        inner.on('error', () => { inner?.close(); inner = undefined; });
        listener();
      } catch { /* not there yet */ }
    };
    try {
      outer = watchFolder(folder, { recursive: !prefix }, (_event, name) => {
        const changed = String(name ?? '').replace(/\\/g, '/');
        if (prefix && changed === prefix.split('/')[0]) arm();
        fire(changed);
      });
      outer.on('error', () => undefined);
      arm();
    } catch (error) { this.log(`[host] can't watch ${pattern} in ${folder}: ${error instanceof Error ? error.message : String(error)}`); }
    const disposable = { dispose: () => { inner?.close(); outer?.close(); const at = this.kept.indexOf(disposable); if (at >= 0) this.kept.splice(at, 1); } };
    this.kept.push(disposable);
    return disposable;
  }
  keep(disposable: Disposable): void { this.kept.push(disposable); }
  /** Disposes everything kept, as the IDE does when its window closes. */
  dispose(): void { for (const disposable of this.kept.splice(0).reverse()) { try { disposable.dispose(); } catch { /* keep going */ } } }

  // ---- The editor's own pieces, which the app doesn't have (G2's Result). ----
  extension(): { path: string; version?: string } | undefined { return undefined; }
  async installExtension(): Promise<void> { throw new Error('The Hydra app has no editor extensions.'); }
  /** `hydra.*` commands the app supports; any other (a `workbench.*` one) is refused. */
  register(id: string, run: (...args: unknown[]) => unknown): Disposable {
    this.commands.set(id, run);
    return { dispose: () => { if (this.commands.get(id) === run) this.commands.delete(id); } };
  }
  async command<T = unknown>(id: string, ...args: unknown[]): Promise<T> {
    const run = this.commands.get(id);
    if (!run) throw new Error(`The Hydra app doesn't run the command ${id}.`);
    return await run(...args) as T;
  }
  section(): HostSection {
    return { get: <T>(_key: string, fallback: T) => fallback, inspect: () => undefined, update: async () => { throw new Error('The Hydra app has no editor settings.'); } };
  }
  colorTheme(): 'light' | 'dark' { return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'; }
  onColorThemeChange(listener: () => void): Disposable { nativeTheme.on('updated', listener); return { dispose: () => nativeTheme.off('updated', listener) }; }
  iconThemes(): { id: string; label: string }[] { return [{ id: '', label: 'None' }]; }
  async postToUi(message: unknown): Promise<void> { this.options.post?.(message); }
}

export type { ChangeSide };
