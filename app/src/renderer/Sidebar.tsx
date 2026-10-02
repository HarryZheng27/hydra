import { useState } from 'react';
import type { Project } from '../shared/ipc';
import type { View } from './App';
import { Icon } from './Icon';

interface Props {
  projects: Project[];
  view: View;
  onNewChat(): void;
  onOpenProject(id: string): void;
  onAddProject(): void;
  onRemoveProject(id: string): void;
  onOpenSettings(): void;
}

/** New chat, search, the projects with their chats, and Settings. Chats arrive with G4. */
export function Sidebar({ projects, view, onNewChat, onOpenProject, onAddProject, onRemoveProject, onOpenSettings }: Props) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const needle = query.trim().toLowerCase();
  const shown = needle ? projects.filter(project => project.name.toLowerCase().includes(needle) || project.path.toLowerCase().includes(needle)) : projects;

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
                <button className="twisty" aria-label={open ? `Collapse ${project.name}` : `Expand ${project.name}`} aria-expanded={open} onClick={() => setCollapsed(current => ({ ...current, [project.id]: open }))}>
                  <span className={`chevron ${open ? 'open' : ''}`}><Icon name="chevron" /></span>
                </button>
                <button className="project-name" title={project.path} onClick={() => onOpenProject(project.id)}>
                  <Icon name="folder" /><span>{project.name}</span>
                </button>
                <button className="icon-button small hover-only" aria-label={`Remove ${project.name} from Hydra`} title="Remove from Hydra (the folder stays on disk)" onClick={() => onRemoveProject(project.id)}><Icon name="close" /></button>
              </div>
              {open && <div className="chats-empty">No chats yet</div>}
            </li>
          );
        })}
        {!projects.length && <li className="sidebar-note">Add a folder to start.</li>}
        {!!projects.length && !shown.length && <li className="sidebar-note">Nothing matches “{query}”.</li>}
      </ul>
      <button className={`side-action settings-link ${view.kind === 'settings' ? 'selected' : ''}`} onClick={onOpenSettings}><Icon name="settings" /><span>Settings</span></button>
    </nav>
  );
}
