import { useState } from 'react';
import type { ChatRecord, Project } from '../shared/ipc';
import type { View } from './App';
import { ChatRow } from './ChatRow';
import type { ChatStatus } from './chatStatus';
import { Icon } from './Icon';

interface Props {
  projects: Project[];
  chats: ChatRecord[];
  /** Each chat's dot: working, waiting on the user, or finished unseen (chatStatus.ts). */
  statuses?: Record<string, ChatStatus>;
  view: View;
  onNewChat(): void;
  onOpenChat(id: string): void;
  onOpenProject(id: string): void;
  onAddProject(): void;
  onRemoveProject(id: string): void;
  onOpenSettings(): void;
  /** The chat menu's Rename, Archive or Unarchive, and Delete. */
  onRenameChat(id: string, title: string): void;
  onArchiveChat(id: string, archived: boolean): void;
  onDeleteChat(chat: ChatRecord): void;
}

/** New chat, search, the projects with their chats, and Settings. */
export function Sidebar({ projects, chats: allChats, statuses = {}, view, onNewChat, onOpenChat, onOpenProject, onAddProject, onRemoveProject, onOpenSettings, onRenameChat, onArchiveChat, onDeleteChat }: Props) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [showArchived, setShowArchived] = useState(false);
  // Archived chats leave their project's list for the Archived section at the bottom.
  const chats = allChats.filter(chat => !chat.archivedAt);
  const archived = allChats.filter(chat => chat.archivedAt);
  const row = (chat: ChatRecord, tooltip?: string) => (
    <ChatRow key={chat.id} chat={chat} status={statuses[chat.id]} tooltip={tooltip} selected={view.kind === 'chat' && view.id === chat.id} onOpen={() => onOpenChat(chat.id)}
      onRename={title => onRenameChat(chat.id, title)} onArchive={value => onArchiveChat(chat.id, value)} onDelete={() => onDeleteChat(chat)} />
  );
  const needle = query.trim().toLowerCase();
  const chatsOf = (project: Project) => chats.filter(chat => chat.cwd.toLowerCase() === project.path.toLowerCase());
  const matches = (chat: ChatRecord) => !needle || chat.title.toLowerCase().includes(needle);
  const shown = needle ? projects.filter(project => project.name.toLowerCase().includes(needle) || project.path.toLowerCase().includes(needle) || chatsOf(project).some(matches)) : projects;

  return (
    <nav className="sidebar" aria-label="Projects and chats">
      <button className="side-action" onClick={onNewChat}><Icon name="plus" /><span>New chat</span></button>
      <label className="search">
        <Icon name="search" />
        <input type="search" placeholder="Search" aria-label="Search projects and chats" value={query} onChange={event => setQuery(event.target.value)} spellCheck={false} />
      </label>
      <div className="section-head">
        <span>Projects</span>
        <button className="icon-button small" onClick={onAddProject} aria-label="Add a project folder" title="Add a project folder"><Icon name="plus" /></button>
      </div>
      <ul className="projects">
        {shown.map(project => {
          const open = !collapsed[project.id];
          const selected = view.kind === 'project' && view.id === project.id;
          return (
            <li key={project.id} className="project">
              <div className={`project-row ${selected ? 'selected' : ''}`}>
                <button className="project-name" title={project.path} onClick={() => onOpenProject(project.id)} onDoubleClick={() => setCollapsed(current => ({ ...current, [project.id]: open }))} aria-expanded={open}>
                  <span>{project.name}</span>
                </button>
                <button className="icon-button small hover-only" aria-label={`New chat in ${project.name}`} title="New chat" onClick={() => onOpenProject(project.id)}><Icon name="plus" /></button>
                <button className="icon-button small hover-only" aria-label={`Remove ${project.name} from Hydra`} title="Remove from Hydra (the folder stays on disk)" onClick={() => onRemoveProject(project.id)}><Icon name="close" /></button>
              </div>
              {open && (chatsOf(project).length
                ? <ul className="chats">{chatsOf(project).filter(chat => matches(chat) || project.name.toLowerCase().includes(needle)).map(chat => row(chat))}</ul>
                : <div className="chats-empty">No chats yet</div>)}
            </li>
          );
        })}
        {!projects.length && <li className="sidebar-note">Add a folder to start.</li>}
        {!!projects.length && !shown.length && <li className="sidebar-note">Nothing matches “{query}”.</li>}
      </ul>
      {(() => {
        // Chats whose folder is no longer a project stay reachable here.
        const orphans = chats.filter(chat => !projects.some(project => chat.cwd.toLowerCase() === project.path.toLowerCase())).filter(matches);
        return orphans.length ? (
          <div className="orphans">
            <div className="section-head"><span>Other chats</span></div>
            <ul className="chats">{orphans.map(chat => row(chat, chat.cwd))}</ul>
          </div>
        ) : null;
      })()}
      {!!archived.length && (
        <div className="archived">
          <button className="section-head archived-head" aria-expanded={showArchived} onClick={() => setShowArchived(open => !open)}>
            <span>Archived ({archived.length})</span><Icon name={showArchived ? 'chevronDown' : 'chevron'} />
          </button>
          {showArchived && <ul className="chats">{archived.filter(matches).map(chat => row(chat, chat.cwd))}</ul>}
        </div>
      )}
      <button className={`side-action settings-link ${view.kind === 'settings' ? 'selected' : ''}`} onClick={onOpenSettings}><Icon name="settings" /><span>Settings</span></button>
    </nav>
  );
}
