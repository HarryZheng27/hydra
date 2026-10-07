import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatRecord, Project } from '../shared/ipc';
import type { View } from './App';
import { ChatRow } from './ChatRow';
import type { ChatStatus } from './chatStatus';
import { Icon } from './Icon';
import type { NeedsYouItem } from '../../../src/core/needsYou';
import { emptyNeedsYou, kindLabel } from '../../../src/core/needsYouList';

interface Props {
  projects: Project[];
  chats: ChatRecord[];
  /** Each chat's dot: working, waiting on the user, or finished unseen (chatStatus.ts). */
  statuses?: Record<string, ChatStatus>;
  /** Everything waiting on the user, in order (src/core/needsYou.ts): the group above the projects. */
  needsYou?: readonly NeedsYouItem[];
  onOpenNeedsYou?(item: NeedsYouItem): void;
  view: View;
  /** The account row: the Windows user's name and the agents that are signed in. */
  user?: string;
  agents?: string[];
  onNewChat(): void;
  onOpenChat(id: string): void;
  onOpenProject(id: string): void;
  /** A project's ⋯ menu: a new chat with that agent there. */
  onNewChatIn(id: string, provider: 'claude' | 'codex'): void;
  onAddProject(): void;
  onClone(url: string): Promise<void>;
  onRemoveProject(id: string): void;
  onOpenSettings(): void;
  /** The chat menu's Rename, Archive or Unarchive, and Delete. */
  onRenameChat(id: string, title: string): void;
  onArchiveChat(id: string, archived: boolean): void;
  onDeleteChat(chat: ChatRecord): void;
}

/** A small menu that closes on a click anywhere else, or Escape. */
function usePopup(): [boolean, (open: boolean) => void, React.RefObject<HTMLDivElement | null>] {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', escape); };
  }, [open]);
  return [open, setOpen, root];
}

function MenuItem({ icon, label, danger, onPick }: { icon?: Parameters<typeof Icon>[0]['name']; label: string; danger?: boolean; onPick(): void }) {
  return (
    <li role="menuitem" tabIndex={0} className={danger ? 'danger' : undefined} onClick={onPick} onKeyDown={event => { if (event.key === 'Enter') onPick(); }}>
      {icon && <Icon name={icon} />}<span>{label}</span>
    </li>
  );
}

/** Which projects are folded, kept across restarts in this window's storage. */
const FOLDED = 'hydra.foldedProjects.v1';
function readFolded(): Set<string> {
  try { const raw = JSON.parse(localStorage.getItem(FOLDED) ?? '[]') as unknown; return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []); } catch { return new Set(); }
}
function saveFolded(id: string, folded: boolean) {
  const set = readFolded();
  if (folded) set.add(id); else set.delete(id);
  try { localStorage.setItem(FOLDED, JSON.stringify([...set].slice(-500))); } catch { /* best effort */ }
}

/**
 * A project's group, as Claude desktop's: a muted label with a chevron on hover that folds the group to just its
 * name, a + that is always there, and ⋯ on hover.
 */
function ProjectGroup({ project, selected, children, onOpen, onNewChatIn, onRemove }: { project: Project; selected: boolean; children: ReactNode; onOpen(): void; onNewChatIn(provider: 'claude' | 'codex'): void; onRemove(): void }) {
  const [open, setOpenState] = useState(() => !readFolded().has(project.id));
  const setOpen = (next: boolean) => { setOpenState(next); saveFolded(project.id, !next); };
  const [menu, setMenu, root] = usePopup();
  const pick = (action: () => void) => () => { setMenu(false); action(); };
  return (
    <li className="project">
      <div ref={root} className={`project-row ${selected ? 'selected' : ''} ${menu ? 'menu-open' : ''}`}>
        <button className="project-name" title={open ? `${project.path}\nClick to hide its chats` : `${project.path}\nClick to show its chats`} onClick={() => setOpen(!open)} aria-expanded={open}>
          <span>{project.name}</span>
          <span className={`project-fold ${open ? '' : 'folded'}`} aria-hidden="true"><Icon name="chevronDown" /></span>
        </button>
        <button className="icon-button small hover-only project-more" aria-label={`More for ${project.name}`} aria-haspopup="menu" aria-expanded={menu} title="More" onClick={() => setMenu(!menu)}><Icon name="moreHorizontal" /></button>
        <button className="icon-button small project-new" aria-label={`New chat in ${project.name}`} title="New chat" onClick={onOpen}><Icon name="plus" /></button>
        {menu && (
          <ul className="row-menu" role="menu">
            <MenuItem label="New Claude Code chat" onPick={pick(() => onNewChatIn('claude'))} />
            <MenuItem label="New Codex chat" onPick={pick(() => onNewChatIn('codex'))} />
            <li className="separator" role="separator" />
            <MenuItem icon="close" label="Remove from Hydra" danger onPick={pick(onRemove)} />
          </ul>
        )}
      </div>
      {open && children}
    </li>
  );
}

/**
 * Claude desktop's sidebar: search, then New, Projects, Archived and More; each project's chats under its muted label;
 * loose chats under Other; and the account row at the bottom, whose menu holds Settings.
 */
export function Sidebar({ projects, chats: allChats, statuses = {}, needsYou, onOpenNeedsYou, view, user, agents = [], onNewChat, onOpenChat, onOpenProject, onNewChatIn, onAddProject, onClone, onRemoveProject, onOpenSettings, onRenameChat, onArchiveChat, onDeleteChat }: Props) {
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [more, setMore] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [account, setAccount, accountRoot] = usePopup();
  // Archived chats leave their project's list; the Archived row shows them instead of the projects.
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
  const orphans = chats.filter(chat => !projects.some(project => chat.cwd.toLowerCase() === project.path.toLowerCase())).filter(matches);
  const working = Object.values(statuses).includes('working');
  const clone = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try { await onClone(url.trim()); setUrl(''); setCloning(false); } finally { setBusy(false); }
  };

  return (
    <nav className="sidebar" aria-label="Projects and chats">
      <label className="search">
        <Icon name="search" />
        <input type="search" placeholder="Search" aria-label="Search projects and chats" value={query} onChange={event => setQuery(event.target.value)} spellCheck={false} />
      </label>
      <div className="side-nav">
        <button className="side-action new-action" onClick={onNewChat}><span className="new-plus"><Icon name="plus" /></span><span>New</span></button>
        <button className="side-action" onClick={onAddProject} title="Open a folder as a project"><Icon name="folder" /><span>Projects</span></button>
        <button className={`side-action ${showArchived ? 'selected' : ''}`} onClick={() => setShowArchived(value => !value)} aria-pressed={showArchived}><Icon name="archive" /><span>Archived</span></button>
        <button className="side-action" onClick={() => setMore(value => !value)} aria-expanded={more}><Icon name={more ? 'chevronUp' : 'chevronDown'} /><span>{more ? 'Less' : 'More'}</span></button>
        {more && <>
          <button className="side-action" onClick={() => setCloning(value => !value)} aria-expanded={cloning}><Icon name="clone" /><span>Clone a repo…</span></button>
          {cloning && (
            <form className="side-clone" onSubmit={event => { event.preventDefault(); void clone(); }}>
              <input autoFocus value={url} onChange={event => setUrl(event.target.value)} placeholder="https://github.com/owner/repo" aria-label="Repository URL" spellCheck={false} disabled={busy} />
              <button className="primary small" type="submit" disabled={!url.trim() || busy}>{busy ? 'Cloning…' : 'Clone'}</button>
            </form>
          )}
          <button className="side-action" onClick={onOpenSettings}><Icon name="settings" /><span>Your agents</span></button>
        </>}
      </div>
      <div className="side-scroll">
        {showArchived
          ? <div className="side-group">
              <div className="section-head"><span>Archived</span></div>
              {archived.filter(matches).length ? <ul className="chats">{archived.filter(matches).map(chat => row(chat, chat.cwd))}</ul> : <div className="sidebar-note">Nothing archived{needle ? ` matches “${query}”` : ''}.</div>}
            </div>
          : <>
              {needsYou && <div className="side-group needs-you-group" aria-label="Needs you">
                <div className="section-head"><span>Needs you</span>{needsYou.length > 0 && <span className="needs-you-count" aria-label={`${needsYou.length} waiting`}>{needsYou.length}</span>}</div>
                {needsYou.length
                  ? <ul className="chats needs-you-rows">{needsYou.slice(0, 6).map(item => <li key={item.id}>
                      <button className={`needs-you-row tier-${item.tier}`} title={`${kindLabel[item.kind]}: ${item.title}${item.projectName ? ` (${item.projectName})` : ''}`} onClick={() => onOpenNeedsYou?.(item)}>
                        <span className="needs-you-row-kind">{kindLabel[item.kind]}</span><span className="needs-you-row-title">{item.title}</span>
                      </button>
                    </li>)}{needsYou.length > 6 && <li className="sidebar-note">and {needsYou.length - 6} more in the Agents view</li>}</ul>
                  : <div className="sidebar-note">{emptyNeedsYou}</div>}
              </div>}
              <ul className="projects">
                {shown.map(project => (
                  <ProjectGroup key={project.id} project={project} selected={view.kind === 'project' && view.id === project.id}
                    onOpen={() => onOpenProject(project.id)} onNewChatIn={provider => onNewChatIn(project.id, provider)} onRemove={() => onRemoveProject(project.id)}>
                    {chatsOf(project).length
                      ? <ul className="chats">{chatsOf(project).filter(chat => matches(chat) || project.name.toLowerCase().includes(needle)).map(chat => row(chat))}</ul>
                      : <div className="chats-empty">No chats yet</div>}
                  </ProjectGroup>
                ))}
                {!projects.length && <li className="sidebar-note">Add a folder to start.</li>}
                {!!projects.length && !shown.length && !orphans.length && <li className="sidebar-note">Nothing matches “{query}”.</li>}
              </ul>
              {/* Chats whose folder is no longer a project stay reachable here. */}
              {!!orphans.length && (
                <div className="side-group orphans">
                  <div className="section-head"><span>Other</span></div>
                  <ul className="chats">{orphans.map(chat => row(chat, chat.cwd))}</ul>
                </div>
              )}
            </>}
      </div>
      <div ref={accountRoot} className="account">
        <button className={`account-button ${view.kind === 'settings' ? 'selected' : ''}`} aria-haspopup="menu" aria-expanded={account} onClick={() => setAccount(!account)}>
          <span className="avatar" aria-hidden="true">{(user?.trim()[0] ?? 'H').toUpperCase()}</span>
          <span className="account-name">{user || 'Hydra'}</span>
          {!!agents.length && <span className="account-plan">· {agents.join(' · ')}</span>}
          <Icon name="chevronDown" />
        </button>
        <span className={`account-activity ${working ? 'working' : ''}`} role="img" aria-label={working ? 'A chat is working' : 'Nothing running'} title={working ? 'A chat is working' : 'Nothing running'} />
        {account && (
          <ul className="row-menu account-menu" role="menu">
            <MenuItem icon="settings" label="Settings" onPick={() => { setAccount(false); onOpenSettings(); }} />
            <MenuItem icon="archive" label={showArchived ? 'Hide archived' : 'Archived chats'} onPick={() => { setAccount(false); setShowArchived(value => !value); }} />
          </ul>
        )}
      </div>
    </nav>
  );
}
