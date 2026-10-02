import type { Project } from '../shared/ipc';
import { Icon } from './Icon';

/** What the main pane shows before there's a chat: pick a folder, or the chosen project. */
export function EmptyState({ project, onPickFolder }: { project?: Project; onPickFolder(): void }) {
  if (project) {
    return (
      <section className="empty">
        <h1>{project.name}</h1>
        <p className="path" title={project.path}>{project.path}</p>
        <p>Chats with Claude Code and Codex arrive in a later version.</p>
      </section>
    );
  }
  return (
    <section className="empty">
      <h1>What are we working on?</h1>
      <p>Choose a project folder. Hydra runs your own Claude Code or Codex in it.</p>
      <button className="primary" onClick={onPickFolder}><Icon name="folder" /><span>Open a folder…</span></button>
    </section>
  );
}
