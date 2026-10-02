import type { Disposable } from './host';

/**
 * A minimal event emitter, the shape of the editor's own: `event(listener)` subscribes, `fire(value)` calls every
 * listener. A listener that throws doesn't stop the others; `onError` hears about it, as the editor logs it.
 */
export class Emitter<T> implements Disposable {
  private readonly listeners = new Set<(value: T) => unknown>();
  constructor(private readonly onError: (error: unknown) => void = () => {}) {}
  readonly event = (listener: (value: T) => unknown): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };
  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      try { listener(value); } catch (error) { try { this.onError(error); } catch { /* reporting never breaks firing */ } }
    }
  }
  dispose(): void { this.listeners.clear(); }
}
