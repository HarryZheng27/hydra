import { useEffect, useRef } from 'react';
import type { ChatRecord } from '../shared/ipc';

/** Set once the user has confirmed a delete: after that, Delete in a chat's menu doesn't ask again. */
const confirmedKey = 'hydra.deleteConfirmed';

export function deleteConfirmed(): boolean {
  try { return window.localStorage.getItem(confirmedKey) === '1'; } catch { return false; }
}

/**
 * The first Delete's question, in the app's own dialog: Delete (Enter) removes the chat and, from then on, Delete
 * doesn't ask; Cancel (Escape, or a click outside) keeps it.
 */
export function ConfirmDelete({ chat, onConfirm, onCancel }: { chat: ChatRecord; onConfirm(): void; onCancel(): void }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => { button.current?.focus(); }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onCancel]);
  const confirm = () => {
    try { window.localStorage.setItem(confirmedKey, '1'); } catch { /* it asks again next time */ }
    onConfirm();
  };
  return (
    <div className="host-ask-backdrop confirm-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}>
      <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-text">
        <h2 id="confirm-title">Delete chat?</h2>
        <p id="confirm-text">“{chat.title}” and its conversation are removed from Hydra. This can't be undone. Hydra won't ask again.</p>
        <div className="confirm-actions">
          <button className="secondary-button" onClick={onCancel}>Cancel</button>
          <button ref={button} className="danger-button" onClick={confirm}>Delete</button>
        </div>
      </div>
    </div>
  );
}
