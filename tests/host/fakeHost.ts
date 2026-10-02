import type { Disposable, Host, HostPaths, HostSettings, NoticeLevel } from '../../src/host/host';

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
  /** What the user picks, by the message's text (a substring match): an action for notify, true or false for confirm. */
  readonly answers = new Map<string, string | boolean>();
  readonly values = new Map<string, unknown>();
  /** Values only the user (never a repository) set, for `settings.machine`. */
  readonly machineValues = new Map<string, unknown>();
  readonly settings: HostSettings;
  readonly paths: HostPaths;
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
  async postToUi(message: unknown): Promise<void> { this.posted.push(structuredClone(message)); }
}
