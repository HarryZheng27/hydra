import type { Disposable } from './host';

/** A minimal event emitter, the shape of the editor's own: `event(listener)` subscribes, `fire(value)` calls every listener. */
export class Emitter<T> implements Disposable {
  private readonly listeners = new Set<(value: T) => unknown>();
  readonly event = (listener: (value: T) => unknown): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };
  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      try { listener(value); } catch { /* one listener's failure never stops the others */ }
    }
  }
  dispose(): void { this.listeners.clear(); }
}
