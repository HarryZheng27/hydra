import type { TerminalMessage } from '../shared/ipc';

/**
 * The window's terminals' output, held until their pane shows it: a CLI asks its terminal things as it starts, and a
 * pane that mounts a moment later must still see those. Capped, as a terminal's own scrollback is.
 */
const buffers = new Map<string, string[]>();
const ended = new Map<string, number>();
const listeners = new Map<string, Set<(message: TerminalMessage) => void>>();
const maxBuffered = 1024 * 1024;
let subscribed = false;

function ensure(): void {
  if (subscribed || typeof window === 'undefined' || !window.hydra?.onTerminal) return;
  subscribed = true;
  window.hydra.onTerminal(message => {
    if (message.exit !== undefined) { ended.set(message.id, message.exit); for (const listener of exits) listener(message.id); }
    if (message.data !== undefined) {
      const chunks = buffers.get(message.id) ?? [];
      chunks.push(message.data);
      let size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      while (size > maxBuffered && chunks.length > 1) size -= chunks.shift()!.length;
      buffers.set(message.id, chunks);
    }
    for (const listener of listeners.get(message.id) ?? []) listener(message);
  });
}

/** Listens before a terminal starts, so none of its output is missed. */
export function watchTerminals(): void { ensure(); }

/** What the terminal has printed so far, and whether it has ended; then each new message. */
export function subscribe(id: string, listener: (message: TerminalMessage) => void): { replay: string; exit?: number; stop(): void } {
  ensure();
  const set = listeners.get(id) ?? new Set();
  set.add(listener);
  listeners.set(id, set);
  return { replay: (buffers.get(id) ?? []).join(''), ...(ended.has(id) ? { exit: ended.get(id) } : {}), stop: () => { set.delete(listener); } };
}

const exits = new Set<(id: string) => void>();
/** Any terminal ending (the terminal panel marks its tab); returns a stop. */
export function onTerminalExit(listener: (id: string) => void): () => void {
  ensure();
  exits.add(listener);
  return () => { exits.delete(listener); };
}
