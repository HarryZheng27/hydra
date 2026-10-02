import type { ChangeSide, Disposable, Host, HostFolder, HostPaths, HostSettings, HostState, InputOptions, NoticeLevel, PickItem } from '../../src/host/host';

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
  constructor(paths: HostPaths, settings: Record<string, unknown> = {}) {
    this.paths = paths;
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
  async pick<T extends PickItem>(items: T[], options: { title?: string; placeHolder?: string; ignoreFocusOut?: boolean }): Promise<T | undefined> {
    for (const [title, labels] of this.picks) if ((options.title ?? '').includes(title)) return labels && items.find(item => labels.includes(item.label));
    return undefined;
  }
  async copy(text: string): Promise<void> { this.clipboard.push(text); }
  withProgress<T>(_title: string, task: () => Promise<T>): Promise<T> { return task(); }
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
  async openUrl(url: string): Promise<void> { this.opened.push({ url }); }
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
