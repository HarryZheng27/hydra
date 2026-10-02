/**
 * What Hydra's controller needs from the program it runs in (docs/internal/hydra-app/G2-host-split.md). The IDE
 * implements it with VS Code (src/vscodeHost.ts) and the Hydra app will with Electron, so both run the same
 * controller. It grows only as moved code needs it. Nothing here, or anywhere under src/host or src/core, may
 * import `vscode` or `electron` (tests/hostBoundary.test.ts).
 */
export interface Disposable { dispose(): void }

export type NoticeLevel = 'info' | 'warning' | 'error';

/** Hydra's settings: keys are relative to `hydra.`, for example `defaultProvider` or `heads.defaultBudgetUsd`. */
export interface HostSettings {
  /** The effective value, or `fallback` when the setting has none. */
  get<T>(key: string, fallback: T): T;
  /**
   * A setting that decides what Hydra runs (an executable, a folder, an opt-in install): only the user's own value
   * or the packaged default, never a repository's (src/core/machineSetting.ts).
   */
  machine<T>(key: string): T | undefined;
  /** Saves the user's value. */
  update(key: string, value: unknown): Promise<void>;
  /** Called after settings change, with a test for whether a given key (relative to `hydra.`, or `''` for any Hydra setting) changed. */
  onChange(listener: (affects: (key: string) => boolean) => void): Disposable;
}

/** Any of the program's own settings sections (`workbench`, `window`, …), read and written at the user's level. */
export interface HostSection {
  get<T>(key: string, fallback: T): T;
  /** Where a value comes from: the default, the user's own, or a workspace's. */
  inspect<T>(key: string): { defaultValue?: T; globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined;
  /** Saves the user's value; undefined or null clears it. */
  update(key: string, value: unknown): Promise<void>;
}

/** Small values kept for this window's folders across restarts (the IDE's workspace state). */
export interface HostState {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Promise<void>;
}

/** A folder open in this window: its path, and its URI as the program names it (Hydra's per-window storage key hashes these). */
export interface HostFolder { path: string; uri: string }

/** One choice in a list the user picks from. */
export interface PickItem { label: string; description?: string; detail?: string; picked?: boolean }

/** A text box the user types into: the editor's input box options. `validateInput` returns a problem, or undefined when the value is fine. */
export interface InputOptions { title?: string; prompt?: string; value?: string; placeHolder?: string; ignoreFocusOut?: boolean; validateInput?: (value: string) => string | undefined }

/** One side of a file in a multi-file diff: a file on disk, or text Hydra serves under its own scheme (registerTextSource). */
export type ChangeSide = { file: string } | { scheme: string; path: string; query: string };

/** A terminal the host opened for a command (a provider's own sign-in, for example). Hydra never reads what it shows. */
export interface HostTerminal extends Disposable {
  /** Called once, when the user closes it or it ends. */
  onClose(listener: () => void): Disposable;
}

/** Folders Hydra reads or writes outside the user's projects. */
export interface HostPaths {
  /** Hydra's own storage (the IDE's global storage folder): workspaces, helpers, audit, ownership locks. */
  storage: string;
  /** Hydra's built files (`dist/`): `hydra-mcp.cjs`, `hydra-limit-hook.cjs`, the webview bundle. */
  dist: string;
  /** The program's own install folder, where it keeps node-pty (src/core/lanePty.ts). */
  appRoot: string;
  /** Hydra's own folder: `dist/` and the built-in `packs/` are inside it. */
  extension: string;
}

export interface Host {
  /** One line in Hydra's log. The IDE redacts it before showing it in the Hydra output channel. */
  log(line: string): void;
  /** A non-modal notification. Resolves to the action pressed, or undefined when it was dismissed. */
  notify(level: NoticeLevel, message: string, ...actions: string[]): Promise<string | undefined>;
  /** A modal warning with one action. True only when that action was chosen. */
  confirm(message: string, action: string, detail?: string): Promise<boolean>;
  /** A list the user picks any number of items from. Undefined when they dismissed it, so nothing should change. */
  pickMany<T extends PickItem>(items: T[], options: { title: string; placeHolder: string }): Promise<T[] | undefined>;
  /** A modal question with any number of actions. Resolves to the action chosen, or undefined when dismissed. */
  ask(level: 'info' | 'warning', message: string, detail: string | undefined, ...actions: string[]): Promise<string | undefined>;
  /** A text box. Undefined when the user dismissed it. */
  input(options: InputOptions): Promise<string | undefined>;
  /** A list the user picks one item from. Undefined when dismissed. */
  pick<T extends PickItem>(items: T[], options: { title?: string; placeHolder?: string; ignoreFocusOut?: boolean; matchOnDetail?: boolean }): Promise<T | undefined>;
  /** Copies text to the clipboard. */
  copy(text: string): Promise<void>;
  /** Shows progress while `task` runs; `report` adds a line of what it is doing now. */
  withProgress<T>(title: string, task: (progress: { report(value: { message?: string }): void }) => Promise<T>): Promise<T>;
  /** Opens a folder as a window: a new one, or (both false) the window that already has it if there is one. */
  openFolder(folder: string, options: { forceNewWindow: boolean; forceReuseWindow?: boolean }): Promise<void>;
  /** Opens a web page inside the program, beside the current view. False when the program can't, so the caller can offer the browser. */
  openPreview(url: string): Promise<boolean>;
  /** Shows a Markdown file rendered, or (unless `fallback` is false, when it fails instead) as text when rendering isn't available. */
  openMarkdown(file: string, options?: { fallback?: boolean }): Promise<void>;
  /** Serves text for `scheme`, by path and query, to openChanges. */
  registerTextSource(scheme: string, provide: (path: string, query: string) => Promise<string>): Disposable;
  /** A multi-file diff: for each file, its label (on disk), its left side and its right side. */
  openChanges(title: string, resources: [ChangeSide, ChangeSide, ChangeSide][]): Promise<void>;
  /** Opens a text file for reading or editing; `preview: false` keeps its tab open. */
  openFile(file: string, options: { preview: boolean }): Promise<void>;
  /** Opens a web page in the user's browser. True when the browser was asked to open it. */
  openUrl(url: string): Promise<boolean>;
  /** Hydra's own version (its package.json). */
  readonly version: string;
  /** A window on another machine (a remote session), where Hydra's local-only features stay off. */
  readonly remote: boolean;
  /** Whether this window has focus, and a way to hear when that changes. */
  focused(): boolean;
  onFocusChange(listener: (focused: boolean) => void): Disposable;
  /** Opens a terminal that runs `shellPath` with `shellArgs` in `cwd`, and shows it without taking focus. */
  openTerminal(options: { name: string; cwd: string; shellPath: string; shellArgs: string[] }): HostTerminal;
  /** Opens text (a diff, for example) as an unsaved read-only document beside the current one. */
  openText(content: string, language: string): Promise<void>;
  /** Opens a file beside the current one, as a preview. */
  openFileBeside(file: string): Promise<void>;
  /** The folders open in this window. */
  folders(): HostFolder[];
  /** Whether the user trusts this window's folders. Hydra runs nothing in an untrusted one. */
  trusted(): boolean;
  /** The processes whose descendants count as this window, so their agents may act as its lead (src/core/leadVerification.ts). */
  windowProcessIds(): number[];
  /** Calls `listener` whenever a file matching `pattern` (a glob relative to `folder`) is created, changed or deleted. */
  watch(folder: string, pattern: string, listener: () => void): Disposable;
  /** Disposes `disposable` when the host shuts Hydra down. */
  keep(disposable: Disposable): void;
  /** Closes this window. */
  closeWindow(): Promise<void>;
  /** A development or test run of Hydra, which must never rewrite the user's own Claude Code or Codex connection to point at itself. */
  readonly development: boolean;
  /** An installed editor extension, by id: its folder and version; undefined when it isn't installed or the host has no extensions. */
  extension(id: string): { path: string; version?: string } | undefined;
  /** Installs an editor extension by id, or from a downloaded package file. */
  installExtension(source: { id: string } | { file: string }): Promise<void>;
  /** Runs a command by id: one of Hydra's own (`hydra.*`), or one of the program's. Resolves to what it returns. */
  command<T = unknown>(id: string, ...args: unknown[]): Promise<T>;
  /** One of the program's settings sections, beyond Hydra's own. */
  section(name: string): HostSection;
  /** Whether the program's current colour theme is light or dark, and a way to hear when it changes. */
  colorTheme(): 'light' | 'dark';
  onColorThemeChange(listener: () => void): Disposable;
  /** The installed file icon themes, after a "None" entry with an empty id. */
  iconThemes(): { id: string; label: string }[];
  /** A folder the user chooses; undefined when they cancel. */
  pickFolder(title: string): Promise<string | undefined>;
  /** Shows a file or folder in the system's file manager. */
  revealInOS(file: string): Promise<void>;
  readonly settings: HostSettings;
  readonly state: HostState;
  /** Small values kept for the user across every window (the IDE's global state). */
  readonly globalState: HostState;
  readonly paths: HostPaths;
  /** Sends a message to the UI (the Agents view). Dropped when no UI is open. */
  postToUi(message: unknown): Promise<void>;
}
