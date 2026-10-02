import path from 'node:path';
import type { ChangeSide, Disposable, Host, HostFolder, HostPaths, HostSection, HostSettings, HostState, HostTerminal, InputOptions, NoticeLevel, PickItem } from '../../src/host/host';

/**
 * A Host for tests (docs/internal/hydra-app/G2-host-split.md): no editor, no window. It records what the controller
 * asked of it, and tests script the user's answers: `answers` for notifications and confirmations, `settings` for
 * Hydra's settings (keys relative to `hydra.`).
 */
export class FakeHost implements Host {
  readonly logs: string[] = [];
  readonly notices: { level: NoticeLevel; message: string; actions: string[] }[] = [];
  readonly confirms: { message: string; action: string; detail?: string }[] = [];
  readonly posted: unknown[] = [];
  readonly opened: { file?: string; url?: string; preview?: boolean }[] = [];
  /** What the next pickMany returns, by its title (a substring match): labels to pick, or undefined to dismiss. */
  readonly picks = new Map<string, string[] | undefined>();
  readonly stateValues = new Map<string, unknown>();
  readonly globalValues = new Map<string, unknown>();
  readonly globalState: HostState = {
    get: <T>(key: string, fallback: T) => (this.globalValues.has(key) ? structuredClone(this.globalValues.get(key)) : fallback) as T,
    update: async (key, value) => { if (value === undefined) this.globalValues.delete(key); else this.globalValues.set(key, structuredClone(value)); },
  };
  /** Commands run (id and arguments), and what each returns, by id. */
  readonly commands: { id: string; args: unknown[] }[] = [];
  readonly commandResults = new Map<string, (...args: unknown[]) => unknown>();
  /** Other settings sections, as "section.key". */
  readonly sectionValues = new Map<string, unknown>();
  theme: 'light' | 'dark' = 'dark';
  folderToPick: string | undefined;
  readonly revealed: string[] = [];
  readonly state: HostState = {
    get: <T>(key: string, fallback: T) => (this.stateValues.has(key) ? structuredClone(this.stateValues.get(key)) : fallback) as T,
    update: async (key, value) => { this.stateValues.set(key, structuredClone(value)); },
  };
  /** What the user picks, by the message's text (a substring match): an action for notify, true or false for confirm. */
  readonly answers = new Map<string, string | boolean>();
  readonly values = new Map<string, unknown>();
  /** Values only the user (never a repository) set, for `settings.machine`. */
  readonly machineValues = new Map<string, unknown>();
  readonly settings: HostSettings;
  readonly paths: HostPaths;
  /** The window's folders (paths), whether they're trusted, and the rest of what a window is, for lifecycle tests. */
  folderPaths: string[] = [];
  isTrusted = true;
  development = true;
  closed = 0;
  readonly kept: Disposable[] = [];
  readonly watchers: { folder: string; pattern: string; listener: () => void; disposed: boolean }[] = [];
  readonly extensions = new Map<string, { path: string; version?: string }>();
  readonly installed: ({ id: string } | { file: string })[] = [];
  private readonly listeners = new Set<(affects: (key: string) => boolean) => void>();
  /** `extension` defaults to the folder `dist` is in. */
  constructor(paths: Omit<HostPaths, 'extension'> & Partial<Pick<HostPaths, 'extension'>>, settings: Record<string, unknown> = {}) {
    this.paths = { extension: path.dirname(paths.dist), ...paths };
    for (const [key, value] of Object.entries(settings)) this.values.set(key, value);
    this.settings = {
      get: <T>(key: string, fallback: T) => (this.values.has(key) ? this.values.get(key) : fallback) as T,
      machine: <T>(key: string) => this.machineValues.get(key) as T | undefined,
      update: async (key, value) => { this.set(key, value); },
      onChange: (listener): Disposable => { this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener); } }; },
    };
  }
  /** Changes a setting as the user would, and tells every listener: a key, its parents and its children count as changed. */
  set(key: string, value: unknown): void {
    this.values.set(key, value);
    for (const listener of [...this.listeners]) listener(changed => changed === '' || changed === key || key.startsWith(`${changed}.`) || changed.startsWith(`${key}.`));
  }
  private answer(message: string): string | boolean | undefined {
    for (const [text, value] of this.answers) if (message.includes(text)) return value;
    return undefined;
  }
  log(line: string): void { this.logs.push(line); }
  async notify(level: NoticeLevel, message: string, ...actions: string[]): Promise<string | undefined> {
    this.notices.push({ level, message, actions });
    const picked = this.answer(message);
    return typeof picked === 'string' && actions.includes(picked) ? picked : undefined;
  }
  async confirm(message: string, action: string, detail?: string): Promise<boolean> {
    this.confirms.push({ message, action, ...(detail !== undefined ? { detail } : {}) });
    return this.answer(message) === true;
  }
  /** What each text box returns, by its title (a substring match); undefined dismisses it. */
  readonly inputs = new Map<string, string | undefined>();
  readonly clipboard: string[] = [];
  readonly textSources = new Map<string, (path: string, query: string) => Promise<string>>();
  readonly changes: { title: string; resources: [ChangeSide, ChangeSide, ChangeSide][] }[] = [];
  previews = true;
  async command<T = unknown>(id: string, ...args: unknown[]): Promise<T> {
    this.commands.push({ id, args });
    return await this.commandResults.get(id)?.(...args) as T;
  }
  section(name: string): HostSection {
    return {
      get: <T>(key: string, fallback: T) => (this.sectionValues.has(`${name}.${key}`) ? this.sectionValues.get(`${name}.${key}`) : fallback) as T,
      inspect: <T>(key: string) => (this.sectionValues.has(`${name}.${key}`) ? { globalValue: this.sectionValues.get(`${name}.${key}`) as T } : {}),
      update: async (key, value) => { if (value === undefined || value === null) this.sectionValues.delete(`${name}.${key}`); else this.sectionValues.set(`${name}.${key}`, value); },
    };
  }
  colorTheme(): 'light' | 'dark' { return this.theme; }
  onColorThemeChange(): Disposable { return { dispose: () => {} }; }
  iconThemes(): { id: string; label: string }[] { return [{ id: '', label: 'None' }]; }
  async pickFolder(): Promise<string | undefined> { return this.folderToPick; }
  async revealInOS(file: string): Promise<void> { this.revealed.push(file); }
  async ask(_level: 'info' | 'warning', message: string, detail: string | undefined, ...actions: string[]): Promise<string | undefined> {
    this.confirms.push({ message, action: actions.join(' | '), ...(detail !== undefined ? { detail } : {}) });
    const picked = this.answer(message);
    // A dialog with several buttons needs the button's own text: `true` would hide which one was pressed.
    return typeof picked === 'string' && actions.includes(picked) ? picked : undefined;
  }
  async input(options: InputOptions): Promise<string | undefined> {
    for (const [title, value] of this.inputs) if ((options.title ?? '').includes(title)) return value;
    return undefined;
  }
  async pick<T extends PickItem>(items: T[], options: { title?: string; placeHolder?: string; ignoreFocusOut?: boolean; matchOnDetail?: boolean }): Promise<T | undefined> {
    for (const [title, labels] of this.picks) if ((options.title ?? '').includes(title)) return labels && items.find(item => labels.includes(item.label));
    return undefined;
  }
  async copy(text: string): Promise<void> { this.clipboard.push(text); }
  readonly progress: string[] = [];
  withProgress<T>(_title: string, task: (progress: { report(value: { message?: string }): void }) => Promise<T>): Promise<T> { return task({ report: value => { if (value.message) this.progress.push(value.message); } }); }
  async openFolder(folder: string, _options: { forceNewWindow: boolean; forceReuseWindow?: boolean }): Promise<void> { this.opened.push({ file: folder }); }
  async openPreview(url: string): Promise<boolean> { if (this.previews) this.opened.push({ url }); return this.previews; }
  async openMarkdown(file: string): Promise<void> { this.opened.push({ file }); }
  registerTextSource(scheme: string, provide: (path: string, query: string) => Promise<string>): Disposable {
    this.textSources.set(scheme, provide);
    return { dispose: () => { this.textSources.delete(scheme); } };
  }
  async openChanges(title: string, resources: [ChangeSide, ChangeSide, ChangeSide][]): Promise<void> { this.changes.push({ title, resources }); }
  async pickMany<T extends PickItem>(items: T[], options: { title: string; placeHolder: string }): Promise<T[] | undefined> {
    for (const [title, labels] of this.picks) if (options.title.includes(title)) return labels && items.filter(item => labels.includes(item.label));
    return undefined;
  }
  async openFile(file: string, options: { preview: boolean }): Promise<void> { this.opened.push({ file, preview: options.preview }); }
  async openUrl(url: string): Promise<boolean> { this.opened.push({ url }); return true; }
  version = '0.0.0-test';
  remote = false;
  isFocused = true;
  focused(): boolean { return this.isFocused; }
  onFocusChange(): Disposable { return { dispose: () => {} }; }
  readonly terminals: { name: string; cwd: string; shellPath: string; shellArgs: string[]; close: () => void; disposed: boolean }[] = [];
  openTerminal(options: { name: string; cwd: string; shellPath: string; shellArgs: string[] }): HostTerminal {
    const listeners: (() => void)[] = [];
    const entry = { ...options, disposed: false, close: () => { for (const listener of listeners) listener(); } };
    this.terminals.push(entry);
    return { dispose: () => { entry.disposed = true; }, onClose: listener => { listeners.push(listener); return { dispose: () => {} }; } };
  }
  readonly texts: { content: string; language: string }[] = [];
  async openText(content: string, language: string): Promise<void> { this.texts.push({ content, language }); }
  async openFileBeside(file: string): Promise<void> { this.opened.push({ file, preview: true }); }
  folders(): HostFolder[] { return this.folderPaths.map(folder => ({ path: folder, uri: `file:///${folder.split('\\').join('/')}` })); }
  trusted(): boolean { return this.isTrusted; }
  windowProcessIds(): number[] { return [process.pid]; }
  watch(folder: string, pattern: string, listener: () => void): Disposable {
    const watcher = { folder, pattern, listener, disposed: false };
    this.watchers.push(watcher);
    return { dispose: () => { watcher.disposed = true; } };
  }
  keep(disposable: Disposable): void { this.kept.push(disposable); }
  async closeWindow(): Promise<void> { this.closed++; }
  extension(id: string): { path: string; version?: string } | undefined { return this.extensions.get(id); }
  async installExtension(source: { id: string } | { file: string }): Promise<void> { this.installed.push(source); }
  /** Disposes everything kept, as the host does when Hydra shuts down. */
  disposeKept(): void { for (const item of this.kept.splice(0)) item.dispose(); }
  async postToUi(message: unknown): Promise<void> { this.posted.push(structuredClone(message)); }
}
