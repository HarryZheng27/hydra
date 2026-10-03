import { useState } from 'react';
import type { Project } from '../shared/ipc';
import { Icon } from './Icon';

export interface Recent { id: string; title: string; project?: string; provider: 'claude' | 'codex'; updatedAt: string }

/** "3m", "2h", "5d": how long ago, for the recents list. */
function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

interface Props {
  project?: Project;
  onPickFolder(): void;
  onClone(url: string): Promise<void>;
  onNewChat(project: Project, provider: 'claude' | 'codex'): void;
  recents?: Recent[];
  onOpenChat?(id: string): void;
}

/** What the main pane shows before there's a chat: open or clone a project, and recent chats; or the chosen project. */
export function EmptyState({ project, onPickFolder, onClone, onNewChat, recents = [], onOpenChat }: Props) {
  const [cloning, setCloning] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  if (project) {
    return (
      <section className="empty">
        <h1>{project.name}</h1>
        <p className="path" title={project.path}>{project.path}</p>
        <div className="new-chat-choices">
          <button className="primary" onClick={() => onNewChat(project, 'claude')}><Icon name="plus" /><span>New chat with Claude Code</span></button>
          <button className="primary" onClick={() => onNewChat(project, 'codex')}><Icon name="plus" /><span>New chat with Codex</span></button>
        </div>
        <p className="hint">{project.trustedAt ? 'You trust this folder: chats here run its own hooks and MCP servers.' : 'Hydra asks you to trust this folder first: chats here run its own hooks and MCP servers.'}</p>
      </section>
    );
  }
  const clone = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    try { await onClone(url.trim()); setUrl(''); setCloning(false); } finally { setBusy(false); }
  };
  return (
    <section className="empty home">
      <h1>What are we working on?</h1>
      <div className="start-actions">
        <button className="primary" onClick={onPickFolder}><Icon name="folder" /><span>Open a project</span></button>
        <button className="secondary" onClick={() => setCloning(current => !current)} aria-expanded={cloning}><Icon name="clone" /><span>Clone a repo</span></button>
      </div>
      {cloning && (
        <form className="clone-form" onSubmit={event => { event.preventDefault(); void clone(); }}>
          <input autoFocus type="text" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://github.com/owner/repo" aria-label="Repository URL" spellCheck={false} disabled={busy} />
          <button className="primary small" type="submit" disabled={!url.trim() || busy}>{busy ? 'Cloning…' : 'Clone'}</button>
        </form>
      )}
      {recents.length > 0 && (
        <div className="recents">
          <h2>Recents</h2>
          <ul>
            {recents.map(recent => (
              <li key={recent.id}>
                <button onClick={() => onOpenChat?.(recent.id)}>
                  <span className="recent-title">{recent.title}</span>
                  <span className="recent-meta">{[recent.project, recent.provider === 'claude' ? 'Claude Code' : 'Codex'].filter(Boolean).join(' · ')}</span>
                  <span className="recent-when">{ago(recent.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
