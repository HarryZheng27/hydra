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

/** Folders Hydra reads or writes outside the user's projects. */
export interface HostPaths {
  /** Hydra's own storage (the IDE's global storage folder): workspaces, helpers, audit, ownership locks. */
  storage: string;
  /** Hydra's built files (`dist/`): `hydra-mcp.cjs`, `hydra-limit-hook.cjs`, the webview bundle. */
  dist: string;
}

export interface Host {
  /** One line in Hydra's log. The IDE redacts it before showing it in the Hydra output channel. */
  log(line: string): void;
  /** A non-modal notification. Resolves to the action pressed, or undefined when it was dismissed. */
  notify(level: NoticeLevel, message: string, ...actions: string[]): Promise<string | undefined>;
  /** A modal warning with one action. True only when that action was chosen. */
  confirm(message: string, action: string, detail?: string): Promise<boolean>;
  readonly settings: HostSettings;
  readonly paths: HostPaths;
  /** Sends a message to the UI (the Agents view). Dropped when no UI is open. */
  postToUi(message: unknown): Promise<void>;
}
