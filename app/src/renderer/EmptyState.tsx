import { useEffect, useRef, useState } from 'react';
import type { ClaudePermissionMode, CodexApprovals, Project } from '../shared/ipc';
import { approvalModes, modes } from './Composer';
import { Icon } from './Icon';
import { Picker } from './Picker';

export interface Recent { id: string; title: string; project?: string; provider: 'claude' | 'codex'; updatedAt: string }
/** A chat on the home's Sessions list: one waiting on the user, or finished while they were elsewhere. */
export interface Waiting extends Recent { status: 'needs' | 'unread' }

/** "3m", "2h", "5d": how long ago, for the recents list. */
function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

/** What the home's prompt starts: a chat in a project, with an agent, here or (Claude) in the cloud. */
export interface StartRequest { project: Project; provider: 'claude' | 'codex'; where: 'local' | 'cloud'; text: string; permissionMode?: ClaudePermissionMode; approvals?: CodexApprovals }

interface Props {
  project?: Project;
  onPickFolder(): void;
  onClone(url: string): Promise<void>;
  onNewChat(project: Project, provider: 'claude' | 'codex'): void;
  recents?: Recent[];
  onOpenChat?(id: string): void;
  /** The home's projects and prompt (Claude desktop's start screen); without projects, the first-run choices show. */
  projects?: Project[];
  onStart?(request: StartRequest): Promise<boolean>;
  /** The chats that need the user (the home's Sessions list, as Claude desktop's). */
  waiting?: Waiting[];
}

const agentOptions = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
];
const whereOptions = [
  { value: 'local', label: 'Local', description: 'Runs here, on your computer.' },
  { value: 'cloud', label: 'Cloud', description: 'Runs on claude.ai; this message starts it.' },
];

/**
 * Claude desktop's start screen: a greeting, and its prompt at the bottom. Above the box, where it runs and the project
 * (which also opens or clones one); inside, a quiet return arrow sends; below, the agent. Enter makes the chat in that
 * project and sends the message.
 */
const shownSessions = 3;

function HomeStart({ projects, recents, waiting, onOpenChat, onPickFolder, onClone, onStart }: { projects: Project[]; recents: Recent[]; waiting: Waiting[]; onOpenChat?(id: string): void; onPickFolder(): void; onClone(url: string): Promise<void>; onStart(request: StartRequest): Promise<boolean> }) {
  const [allSessions, setAllSessions] = useState(false);
  // The project of the most recent chat, else the first one.
  const initial = projects.find(project => project.name === recents[0]?.project)?.id ?? projects[0]?.id;
  const [projectId, setProjectId] = useState(initial);
  const [provider, setProvider] = useState<'claude' | 'codex'>('claude');
  const [where, setWhere] = useState<'local' | 'cloud'>('local');
  // 'settings': Claude Code follows the user's own default mode, as a new chat does; Codex asks, as Hydra starts it.
  const [mode, setMode] = useState<ClaudePermissionMode>('settings');
  const [approvals, setApprovals] = useState<CodexApprovals>('ask');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [url, setUrl] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!projects.some(project => project.id === projectId)) setProjectId(projects[0]?.id); }, [projects, projectId]);
  useEffect(() => { box.current?.focus(); }, []);
  const project = projects.find(candidate => candidate.id === projectId);
  const cloud = provider === 'claude' && where === 'cloud';
  const projectOptions = [
    ...projects.map(candidate => ({ value: candidate.id, label: candidate.name, description: candidate.path })),
    { value: 'open', label: 'Open a folder…' },
    { value: 'clone', label: 'Clone a repo…' },
  ];
  const start = async () => {
    if (!project || !text.trim() || busy) return;
    setBusy(true);
    const settings = provider === 'claude' ? (mode === 'settings' ? {} : { permissionMode: mode }) : { approvals };
    try { if (await onStart({ project, provider, where: cloud ? 'cloud' : 'local', text: text.trim(), ...settings })) setText(''); } finally { setBusy(false); }
  };
  const clone = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try { await onClone(url.trim()); setUrl(''); setCloning(false); } finally { setBusy(false); }
  };
  return (
    <section className="home-start">
      <div className="home-scroll">
        <div className="home-column">
          <h1><span className="home-mark" aria-hidden="true">✳</span>Welcome back</h1>
          {waiting.length > 0 && (
            <div className="sessions">
              <div className="sessions-head"><h2>Sessions</h2>{waiting.length > shownSessions && <button className="link-quiet" onClick={() => setAllSessions(value => !value)}>{allSessions ? 'Show fewer' : `Show ${waiting.length - shownSessions} more`}</button>}</div>
              <ul>
                {(allSessions ? waiting : waiting.slice(0, shownSessions)).map(chat => (
                  <li key={chat.id}>
                    <button onClick={() => onOpenChat?.(chat.id)}>
                      <span className={`session-state ${chat.status}`}>{chat.status === 'needs' ? 'Needs input' : 'Ready'}</span>
                      <span className="session-title">{chat.title}</span>
                      <span className="session-meta">{chat.project}</span>
                      <span className="session-when">{ago(chat.updatedAt)} ago</span>
                      <Icon name="chevron" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
      <div className="home-prompt composer">
        {cloning && (
          <form className="clone-form" onSubmit={event => { event.preventDefault(); void clone(); }}>
            <input autoFocus type="text" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://github.com/owner/repo" aria-label="Repository URL" spellCheck={false} disabled={busy} />
            <button className="primary small" type="submit" disabled={!url.trim() || busy}>{busy ? 'Cloning…' : 'Clone'}</button>
            <button className="icon-button small" type="button" aria-label="Cancel" onClick={() => setCloning(false)}><Icon name="close" /></button>
          </form>
        )}
        <div className="home-chips">
          {provider === 'claude' && <Picker chip bare icon={cloud ? 'cloud' : 'laptop'} label="Where" value={where} options={whereOptions} onChange={value => setWhere(value === 'cloud' ? 'cloud' : 'local')} />}
          <Picker chip bare icon="folder" label="Project" value={projectId} options={projectOptions} title={project?.path}
            onChange={value => { if (value === 'open') onPickFolder(); else if (value === 'clone') setCloning(true); else setProjectId(value); }} />
        </div>
        <div className="prompt-box">
          <textarea ref={box} rows={1} value={text} placeholder="Describe a task or ask a question" aria-label="Start a chat" disabled={busy}
            onChange={event => setText(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void start(); } }} />
          <button className="round send" onClick={() => void start()} disabled={!text.trim() || !project || busy} aria-label="Start the chat" title="Start the chat (Enter)"><Icon name="enter" /></button>
        </div>
        <div className="composer-bar">
          {provider === 'claude'
            ? <Picker bare label="Permission mode" value={mode} options={[{ value: 'settings', label: 'Your settings', description: 'Claude Code follows your own default mode' }, ...modes]} onChange={value => setMode(value as ClaudePermissionMode)} />
            : <Picker bare label="Approvals" value={approvals} options={approvalModes()} onChange={value => setApprovals(value as CodexApprovals)} />}
          <span className="composer-spacer" />
          <Picker bare label="Agent" value={provider} options={agentOptions} onChange={value => setProvider(value === 'codex' ? 'codex' : 'claude')} />
        </div>
        {cloud && <p className="hint cloud-hint">Cloud: this message starts a Claude Code session on claude.ai with this folder's tracked files as they are, uncommitted edits included; untracked and ignored files stay here.</p>}
      </div>
    </section>
  );
}

export function EmptyState({ project, onPickFolder, onClone, onNewChat, recents = [], onOpenChat, projects = [], onStart, waiting = [] }: Props) {
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
  if (projects.length && onStart) return <HomeStart projects={projects} recents={recents} waiting={waiting} onOpenChat={onOpenChat} onPickFolder={onPickFolder} onClone={onClone} onStart={onStart} />;
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
