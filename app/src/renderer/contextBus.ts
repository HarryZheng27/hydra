import { MAX_ATTACHMENTS, type Attachment } from './attachments';

/**
 * Attachments waiting for a chat's next message, held here (not in the composer) so they survive switching chats, and
 * so a terminal panel or transcript can hand one to a composer it knows only by the chat's id.
 */
const pending = new Map<string, readonly Attachment[]>();
const listeners = new Map<string, Set<() => void>>();

const emit = (chatId: string) => { for (const listener of listeners.get(chatId) ?? []) listener(); };

/** What the chat's next message will carry. */
export function pendingFor(chatId: string): readonly Attachment[] { return pending.get(chatId) ?? []; }

/** Adds one; false when the chat already has the most a message takes. */
export function attach(chatId: string, item: Attachment): boolean {
  const current = pendingFor(chatId);
  if (current.length >= MAX_ATTACHMENTS) return false;
  pending.set(chatId, [...current, item]);
  emit(chatId);
  return true;
}

export function remove(chatId: string, id: string): void {
  const next = pendingFor(chatId).filter(item => item.id !== id);
  if (next.length) pending.set(chatId, next); else pending.delete(chatId);
  emit(chatId);
}

/** Drops them all, once the message is sent. */
export function clear(chatId: string): void { if (pending.delete(chatId)) emit(chatId); }

/** Calls the listener whenever the chat's attachments change; returns a stop. */
export function subscribe(chatId: string, listener: () => void): () => void {
  const set = listeners.get(chatId) ?? new Set();
  set.add(listener);
  listeners.set(chatId, set);
  return () => { set.delete(listener); };
}
