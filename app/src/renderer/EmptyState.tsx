import type { ReactNode } from 'react';
import type { Project } from '../shared/ipc';
import { Icon } from './Icon';

/** What the main pane shows before there's a chat: pick a folder, or the chosen project. */
export function EmptyState({ project, onPickFolder, onNewChat, setup }: { project?: Project; onPickFolder(): void; onNewChat(project: Project, provider: 'claude' | 'codex'): void; setup?: ReactNode }) {
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
  return (
    <section className="empty">
      <h1>What are we working on?</h1>
      <p>Choose a project folder. Hydra runs your own Claude Code or Codex in it.</p>
      <button className="primary" onClick={onPickFolder}><Icon name="folder" /><span>Open a folder…</span></button>
      {setup}
    </section>
  );
}
