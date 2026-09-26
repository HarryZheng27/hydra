/**
 * 5.3 (docs/Hydra_Improvements.md): Hydra: Stop All Agents / Resume Agents. One switch per
 * window, persisted through an injected store (the extension passes `context.workspaceState`;
 * tests pass a Map-backed fake), so a reload keeps it stopped until Resume Agents runs.
 */
export interface StopState { stopped: boolean; since?: number; reason?: string }
/** The slice of vscode.Memento this needs: get/update, by key. A test fake needs the same shape. */
export interface StopStore { get<T>(key: string, defaultValue: T): T; update(key: string, value: unknown): Thenable<void> | Promise<void> }

const storeKey = 'hydra.stopSwitch';

export class StopSwitch {
  private state: StopState;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly store: StopStore, private readonly now: () => number = Date.now) {
    this.state = this.store.get<StopState>(storeKey, { stopped: false });
  }

  isStopped(): boolean { return this.state.stopped; }
  since(): number | undefined { return this.state.since; }
  reason(): string | undefined { return this.state.reason; }

  onChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  async stop(reason: string): Promise<void> {
    this.state = { stopped: true, since: this.now(), reason };
    await this.store.update(storeKey, this.state);
    this.changed();
  }

  async resume(): Promise<void> {
    this.state = { stopped: false };
    await this.store.update(storeKey, this.state);
    this.changed();
  }

  /** Throws a clear, uniform refusal while stopped; a no-op otherwise. */
  assertRunning(what: string): void {
    if (!this.state.stopped) return;
    const since = this.state.since ? new Date(this.state.since).toLocaleString() : 'earlier';
    throw new Error(`Hydra is stopped (since ${since}): ${what} is refused. Run "Hydra: Resume Agents" to allow it again.`);
  }

  private changed(): void { for (const listener of [...this.listeners]) listener(); }
}

/** A Map-backed StopStore for tests: no vscode.Memento available there. */
export function fakeStopStore(backing = new Map<string, unknown>()): StopStore {
  return {
    get: <T,>(key: string, defaultValue: T) => (backing.has(key) ? backing.get(key) as T : defaultValue),
    update: (key: string, value: unknown) => { backing.set(key, value); return Promise.resolve(); },
  };
}
