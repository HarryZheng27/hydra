import { useEffect, useRef, useState } from 'react';
import type { ChatRecord } from '../shared/ipc';
import type { ChatStatus } from './chatStatus';
import { Icon } from './Icon';

const statusLabels: Record<ChatStatus, string> = { working: 'Working', needs: 'Needs your input', unread: 'Finished' };

/**
 * The row's mark, as Claude desktop's sidebar: a dot while it works, waits or has news; else its pull request (purple
 * once merged, red while open, grey if closed); else an empty circle.
 */
function Mark({ chat, status }: { chat: ChatRecord; status?: ChatStatus }) {
  if (status) return <span className={`chat-mark dot ${status}`} role="img" aria-label={statusLabels[status]} title={statusLabels[status]} />;
  if (chat.pr) return <span className={`chat-mark pr ${chat.pr.state}`} role="img" aria-label={`Pull request ${chat.pr.state}`} title={`Pull request ${chat.pr.state}`}><Icon name="pullRequest" /></span>;
  return <span className="chat-mark dot idle" aria-hidden="true" />;
}

interface Props {
  chat: ChatRecord;
  selected: boolean;
  status?: ChatStatus;
  /** The row's tooltip: the title, or the folder for a chat outside every project. */
  tooltip?: string;
  onOpen(): void;
  onRename(title: string): void;
  onArchive(archived: boolean): void;
  onDelete(): void;
}

/**
 * A chat in the sidebar, with Claude desktop's row menu: a ⋮ button on hover opens Rename, Archive (or Unarchive) and
 * Delete. Rename edits the title in place: Enter or leaving the field saves it, Escape cancels.
 */
export function ChatRow({ chat, selected, status, tooltip, onOpen, onRename, onArchive, onDelete }: Props) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(chat.title);
  const root = useRef<HTMLLIElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // The menu closes on a click anywhere else, or Escape.
  useEffect(() => {
    if (!menu) return undefined;
    const away = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setMenu(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', escape); };
  }, [menu]);
  useEffect(() => { if (editing) input.current?.select(); }, [editing]);

  const startRename = () => { setMenu(false); setDraft(chat.title); setEditing(true); };
  const finishRename = (save: boolean) => {
    setEditing(false);
    const title = draft.replace(/\s+/g, ' ').trim();
    if (save && title && title !== chat.title) onRename(title);
  };

  return (
    <li ref={root} className={`chat-row ${selected ? 'selected' : ''} ${menu ? 'menu-open' : ''}`}>
      {editing
        ? <input ref={input} className="chat-rename" aria-label="Chat name" value={draft} maxLength={200} spellCheck={false}
            onChange={event => setDraft(event.target.value)} onBlur={() => finishRename(true)}
            onKeyDown={event => { if (event.key === 'Enter') finishRename(true); else if (event.key === 'Escape') finishRename(false); }} />
        : <button className={`chat-link ${selected ? 'selected' : ''}`} title={tooltip ?? chat.title} onClick={onOpen}>
            <Mark chat={chat} status={status} /><span className="chat-title-text">{chat.title}</span>{chat.provider === 'codex' ? <span className="provider-tag">Codex</span> : null}
          </button>}
      {!editing && (
        <button className="icon-button small row-more" aria-label={`More for ${chat.title}`} aria-haspopup="menu" aria-expanded={menu} title="More" onClick={() => setMenu(open => !open)}><Icon name="more" /></button>
      )}
      {menu && (
        <ul className="row-menu" role="menu">
          <li role="menuitem" tabIndex={0} onClick={startRename} onKeyDown={event => { if (event.key === 'Enter') startRename(); }}><Icon name="pencil" /><span>Rename</span></li>
          <li role="menuitem" tabIndex={0} onClick={() => { setMenu(false); onArchive(!chat.archivedAt); }} onKeyDown={event => { if (event.key === 'Enter') { setMenu(false); onArchive(!chat.archivedAt); } }}><Icon name="archive" /><span>{chat.archivedAt ? 'Unarchive' : 'Archive'}</span></li>
          <li className="separator" role="separator" />
          <li role="menuitem" tabIndex={0} className="danger" onClick={() => { setMenu(false); onDelete(); }} onKeyDown={event => { if (event.key === 'Enter') { setMenu(false); onDelete(); } }}><Icon name="close" /><span>Delete</span></li>
        </ul>
      )}
    </li>
  );
}
