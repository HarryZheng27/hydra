import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChatAnswer, ChatDefaults, ChatEvent, ChatImage, ChatRecord, ClaudePermissionMode, CodexApprovals } from '../shared/ipc';
import { foldEvents, type ChatItem } from './chatModel';
import { hydraCard, type HydraView } from './HydraCards';
import { Composer } from './Composer';
import { Icon } from './Icon';
import { Markdown } from './markdown';
import { ReviewPane } from './ReviewPane';
import { TerminalPane } from './TerminalPane';
import type { SlashCommand } from './SlashMenu';

interface Props {
  record: ChatRecord;
  /** The user's own CLI defaults, shown when the chat doesn't choose its own. */
  defaults?: ChatDefaults;
  events: ChatEvent[];
  /** Events before this position were settled when the chat was opened. */
  settledBefore?: number;
  onSend(text: string, images?: ChatImage[]): void;
  onOpenTerminal(): void;
  /** Opens Settings, where Your agents shows what is installed. */
  onOpenSettings?(): void;
  /** The chat is open in a terminal the user started: sends wait until they close it. */
  inTerminal?: boolean;
  /** The project's heads and plans (G5): a Hydra tool call shows as a live card. */
  hydra?: HydraView;
  onTerminalClosed?(): void;
  onAnswer(requestId: string, answer: ChatAnswer): void | Promise<unknown>;
  onStop(): void;
  onConfigure(change: { model?: string; effort?: string; permissionMode?: ClaudePermissionMode; approvals?: CodexApprovals; sandbox?: 'read-only' | 'workspace-write' }): void;
  /** G7: Local or Cloud, before a Claude chat's first message. */
  onWhere?(where: 'local' | 'cloud'): void;
  /** G7: a cloud chat's session, continued in a terminal in a fresh worktree. */
  onContinueCloud?(): void;
  /** The browser panel: the globe opens or closes it, with this chat's PR or cloud session to start with. */
  onBrowser?(url?: string): void;
  browserOpen?: boolean;
  /** The / menu's commands, from the chat's Claude Code process (with descriptions); else its session's names. */
  commands?: SlashCommand[];
  /** A cloud chat continued here: its terminal inside the chat (G7). */
  terminalId?: string;
  /** The project's name, for the header's pill. */
  projectName?: string;
  /** The header's ⋮ menu: Archive and Delete, as the sidebar's. */
  onArchive?(): void;
  onDelete?(): void;
}

/** The CLI's latest model list in this chat (Codex sends one when a thread starts). */
const latestModels = (events: ChatEvent[]) => { for (let i = events.length - 1; i >= 0; i--) { const event = events[i]!; if (event.type === 'models') return event.models; } return []; };

/** The slash commands the chat's latest Claude session offered (its init), skills marked. */
const latestCommands = (events: ChatEvent[]): SlashCommand[] => { for (let i = events.length - 1; i >= 0; i--) { const event = events[i]!; if (event.type === 'session' && event.commands) { const skills = new Set(event.skills ?? []); return event.commands.map(name => ({ name, skill: skills.has(name) })); } } return []; };
const latestSessionModel = (events: ChatEvent[]) => { for (let i = events.length - 1; i >= 0; i--) { const event = events[i]!; if (event.type === 'session' && event.model) return event.model; } return undefined; };

const pretty = (value: unknown) => { try { return JSON.stringify(value, null, 2); } catch { return String(value); } };

/** One collapsible block for a tool call and its result. Everything in it is text. */
function ToolBlock({ item }: { item: ChatItem & { kind: 'tool' } }) {
  const summary = typeof (item.input as { command?: unknown })?.command === 'string' ? String((item.input as { command: string }).command)
    : typeof (item.input as { file_path?: unknown })?.file_path === 'string' ? String((item.input as { file_path: string }).file_path) : '';
  return (
    <details className={`tool ${item.isError ? 'failed' : ''}`}>
      <summary><span className="tool-name">{item.name}</span>{summary && <span className="tool-summary">{summary}</span>}{item.output === undefined ? <span className="tool-state running">running…</span> : item.isError && <span className="tool-state failed">failed</span>}</summary>
      <pre className="code"><code>{pretty(item.input)}</code></pre>
      {item.output !== undefined && <pre className={`code output ${item.isError ? 'error' : ''}`}><code>{item.output || '(no output)'}</code></pre>}
    </details>
  );
}

/** An approval card. It is drawn only for an `approval` event, which only the CLI's structured request produces. */
function ApprovalCard({ item, active, onAnswer }: { item: ChatItem & { kind: 'request' }; active: boolean; onAnswer: Props['onAnswer'] }) {
  const event = item.event as Extract<ChatEvent, { type: 'approval' }>;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => pretty(event.input));
  const [problem, setProblem] = useState<string>();
  const submitEdit = () => {
    try { const value = JSON.parse(draft) as unknown; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The input must be a JSON object.'); onAnswer(event.id, { kind: 'approval', decision: 'allow', updatedInput: value }); }
    catch (error) { setProblem(error instanceof Error ? error.message : String(error)); }
  };
  return (
    <section className="card approval" data-request={event.id} aria-label={`Permission for ${event.tool}`}>
      <div className="card-title">Allow <strong>{event.tool}</strong>?</div>
      {event.description && <div className="card-detail">{event.description}</div>}
      {editing ? <textarea className="edit-input" value={draft} onChange={e => setDraft(e.target.value)} spellCheck={false} aria-label="Edited input" /> : <pre className="code"><code>{pretty(event.input)}</code></pre>}
      {problem && <div className="error">{problem}</div>}
      {item.resolved ? <div className={`card-outcome ${item.resolved.outcome}`}>{item.resolved.outcome === 'allowed' ? 'Allowed' : item.resolved.outcome === 'denied' ? 'Denied' : 'No longer needed'}{item.resolved.by === 'hydra' ? ' by Hydra' : ''}</div>
        : active && (
          <div className="card-actions">
            {editing ? <><button className="primary small" onClick={submitEdit}>Allow with these changes</button><button onClick={() => setEditing(false)}>Cancel</button></>
              : <><button className="primary small" onClick={() => onAnswer(event.id, { kind: 'approval', decision: 'allow' })}>Allow</button>
                {event.choices.includes('allow-session') && <button onClick={() => onAnswer(event.id, { kind: 'approval', decision: 'allow-session' })}>Allow for this session</button>}
                <button onClick={() => onAnswer(event.id, { kind: 'approval', decision: 'deny', message: 'The user denied this.' })}>Deny</button>
                {event.choices.includes('edit') && <button onClick={() => setEditing(true)}>Edit…</button>}</>}
          </div>
        )}
    </section>
  );
}

function QuestionCard({ item, active, onAnswer }: { item: ChatItem & { kind: 'request' }; active: boolean; onAnswer: Props['onAnswer'] }) {
  const event = item.event as Extract<ChatEvent, { type: 'question' }>;
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const toggle = (question: string, label: string, multi: boolean) => setChosen(current => ({ ...current, [question]: multi ? (current[question]?.includes(label) ? current[question]!.filter(l => l !== label) : [...(current[question] ?? []), label]) : [label] }));
  const complete = event.questions.every(q => chosen[q.question]?.length);
  return (
    <section className="card question" data-request={event.id}>
      {event.questions.map(q => (
        <fieldset key={q.question} disabled={!active || !!item.resolved}>
          <legend>{q.header ? <span className="chip">{q.header}</span> : null}{q.question}</legend>
          {q.options.map(option => (
            <label key={option.label} className="option">
              <input type={q.multiSelect ? 'checkbox' : 'radio'} name={`${event.id}:${q.question}`} checked={!!chosen[q.question]?.includes(option.label)} onChange={() => toggle(q.question, option.label, !!q.multiSelect)} />
              <span>{option.label}{option.description && <span className="option-detail"> · {option.description}</span>}</span>
            </label>
          ))}
        </fieldset>
      ))}
      {item.resolved ? <div className="card-outcome">Answered</div>
        : active && <div className="card-actions"><button className="primary small" disabled={!complete} onClick={() => onAnswer(event.id, { kind: 'question', answers: Object.fromEntries(Object.entries(chosen).map(([q, labels]) => [q, labels.join(', ')])) })}>Answer</button></div>}
    </section>
  );
}

function PlanCard({ item, active, onAnswer }: { item: ChatItem & { kind: 'request' }; active: boolean; onAnswer: Props['onAnswer'] }) {
  const event = item.event as Extract<ChatEvent, { type: 'plan' }>;
  const [feedback, setFeedback] = useState('');
  return (
    <section className="card plan" data-request={event.id}>
      <div className="card-title">Plan</div>
      <Markdown text={event.plan} />
      {item.resolved ? <div className={`card-outcome ${item.resolved.outcome}`}>{item.resolved.outcome === 'allowed' ? 'Approved' : 'Sent back'}</div>
        : active && (
          <div className="card-actions column">
            <textarea value={feedback} onChange={e => setFeedback(e.target.value)} placeholder="What should change? (optional)" aria-label="Plan feedback" />
            <div className="card-actions">
              <button className="primary small" onClick={() => onAnswer(event.id, { kind: 'plan', approve: true })}>Approve plan</button>
              <button onClick={() => onAnswer(event.id, { kind: 'plan', approve: false, ...(feedback.trim() ? { feedback: feedback.trim() } : {}) })}>Keep planning</button>
            </div>
          </div>
        )}
    </section>
  );
}

function usageLine(item: ChatItem & { kind: 'turn-end' }): string {
  const parts: string[] = [];
  if (item.status === 'interrupted') parts.push('Stopped');
  if (item.status === 'error') parts.push('Ended with an error');
  // No token counts or cost under a turn (Nico's ask): the context wheel shows how full the chat is.
  if (item.detail) parts.push(item.detail);
  return parts.join(' · ');
}

/** What a running turn is doing now, from its latest events: the tool it runs, or thinking, or writing. */
function activity(events: ChatEvent[]): string | undefined {
  const results = new Set(events.filter(event => event.type === 'tool-result').map(event => (event as { id: string }).id));
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === 'user') return undefined;
    if (event.type === 'tool-call' && !results.has(event.id)) {
      const input = event.input as { command?: unknown; file_path?: unknown; description?: unknown } | undefined;
      const detail = typeof input?.description === 'string' ? input.description : typeof input?.command === 'string' ? input.command : typeof input?.file_path === 'string' ? input.file_path : '';
      return detail ? `${event.name}: ${detail}` : event.name;
    }
    if (event.type === 'thinking') return 'Thinking';
    if (event.type === 'text') return 'Writing';
  }
  return undefined;
}

/**
 * Claude desktop's working row under a running turn: four dots shuffling in Claude's orange, what it's doing, and the
 * time so far.
 */
function Working({ provider, starting, doing }: { provider: ChatRecord['provider']; starting: boolean; doing?: string }) {
  const since = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const seconds = Math.floor((now - since.current) / 1000);
  const name = provider === 'claude' ? 'Claude Code' : 'Codex';
  const time = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
  return (
    <div className="working" role="status">
      <span className="working-dots" aria-hidden="true"><i /><i /><i /><i /></span>
      <span className="working-text">{starting ? `Starting ${name}` : doing ?? 'Working'}</span>
      {seconds >= 1 && <span className="working-time">{time}</span>}
    </div>
  );
}

/** How full the chat's context is after its latest turn, and the window when the CLI said it. */
function latestContext(events: ChatEvent[]): { used: number; window?: number } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type !== 'usage') continue;
    const used = event.contextTokens ?? ((event.inputTokens ?? 0) + (event.cachedTokens ?? 0));
    if (!used) continue;
    return { used, ...(event.contextWindow ? { window: event.contextWindow } : {}) };
  }
  return undefined;
}

export function ChatPane({ record, defaults, hydra, events, settledBefore = 0, onSend, onAnswer, onStop, onConfigure, onOpenTerminal, inTerminal = false, onTerminalClosed, onOpenSettings, onWhere, onContinueCloud, projectName, onArchive, onDelete, terminalId, onBrowser, browserOpen, commands }: Props) {
  // The header goes in the window's title bar, as Claude desktop's does (TitleBar's slot).
  const [slot, setSlot] = useState<Element | null>(null);
  useEffect(() => { setSlot(document.getElementById('titlebar-slot')); }, []);
  const [more, setMore] = useState(false);
  const moreRoot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!more) return undefined;
    const away = (event: MouseEvent) => { if (!moreRoot.current?.contains(event.target as Node)) setMore(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [more]);
  const view = useMemo(() => foldEvents(events, settledBefore), [events, settledBefore]);
  // A cloud chat's session exists once its log says so (G7): after that, the chat lives on claude.ai.
  const cloudStarted = events.some(event => event.type === 'cloud');
  const cloudUrl = (events.find(event => event.type === 'cloud') as { url?: string } | undefined)?.url;
  const [reviewing, setReviewing] = useState(false);
  // Each request is answered once: a second click on the same card sends nothing.
  const answered = useRef(new Set<string>());
  const answerOnce: Props['onAnswer'] = (id, answer) => {
    if (answered.current.has(id)) return;
    answered.current.add(id);
    // If the answer didn't get through, the card can be tried again.
    void Promise.resolve(onAnswer(id, answer)).catch(() => answered.current.delete(id));
  };
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [events.length]);
  return (
    <section className="chat" aria-label={record.title}>
      {slot && createPortal(
        <div className="chat-head">
          <Icon name={record.where === 'cloud' ? 'cloud' : 'laptop'} />
          <span className="chat-title" title={record.cwd}>{record.title}</span>
          {projectName && <span className="project-pill" title={record.cwd}>{projectName}</span>}
          <span className="chat-head-spacer" />
          {/* For anything the pane can't show: the CLI's own interactive resume of this chat. */}
          <button className="head-action terminal" onClick={onOpenTerminal} disabled={view.running || inTerminal} aria-label="Open in terminal" title={view.running ? 'Stop the chat first' : 'Open in terminal: continue this chat in the CLI itself, with its own default settings'}><Icon name="terminal" /></button>
          <button className="head-action" onClick={() => setReviewing(current => !current)} aria-pressed={reviewing} aria-label={reviewing ? 'Back to chat' : 'Review changes'} title={reviewing ? 'Back to chat' : 'Review changes'}><Icon name="diff" /></button>
          {onBrowser && <button className="head-action" onClick={() => onBrowser(record.pr?.url ?? cloudUrl)} aria-pressed={!!browserOpen} aria-label="Browser" title={record.pr ? 'Browser: opens the pull request' : cloudUrl ? 'Browser: opens the session on claude.ai' : 'Browser'}><Icon name="globe" /></button>}
          <div className="head-more" ref={moreRoot}>
            <button className="head-action" aria-label="More" aria-haspopup="menu" aria-expanded={more} title="More" onClick={() => setMore(value => !value)}><Icon name="more" /></button>
            {more && (
              <ul className="row-menu head-menu" role="menu">
                {onArchive && <li role="menuitem" tabIndex={0} onClick={() => { setMore(false); onArchive(); }}><Icon name="archive" /><span>Archive</span></li>}
                {onDelete && <li role="menuitem" tabIndex={0} className="danger" onClick={() => { setMore(false); onDelete(); }}><Icon name="close" /><span>Delete</span></li>}
              </ul>
            )}
          </div>
        </div>, slot)}
      {hydra?.error && <div className="banner hydra-banner" role="status">{hydra.error}</div>}
      {inTerminal && <div className="banner warning terminal-banner" role="status">This chat is open in a terminal. Close that window before sending here, so two programs don't write to one session. <button onClick={onTerminalClosed}>I closed the terminal</button></div>}
      {reviewing && <ReviewPane chatId={record.id} />}
      <div className="transcript" role="log" aria-live="polite" hidden={reviewing}>
        {view.items.map(item => {
          switch (item.kind) {
            case 'user': return <div key={item.key} className="msg user"><div className="bubble">{item.text}{item.images ? <span className="chip">{item.images} image{item.images > 1 ? 's' : ''}</span> : null}</div></div>;
            case 'text': return <div key={item.key} className="msg assistant"><Markdown text={item.text} /></div>;
            case 'thinking': return <details key={item.key} className="thinking"><summary>Thinking</summary><div className="thinking-text">{item.text}</div></details>;
            case 'tool': return hydraCard(item, hydra) ?? <ToolBlock key={item.key} item={item} />;
            case 'request': {
              const active = view.pending.includes(item.event.id);
              if (item.event.type === 'approval') return <ApprovalCard key={item.key} item={item} active={active} onAnswer={answerOnce} />;
              if (item.event.type === 'question') return <QuestionCard key={item.key} item={item} active={active} onAnswer={answerOnce} />;
              return <PlanCard key={item.key} item={item} active={active} onAnswer={answerOnce} />;
            }
            case 'error': {
              // Errors say what to do next: a missing CLI leads to Your agents; a usage limit is the plan's, not Hydra's.
              if (item.code === 'missing-cli') return <div key={item.key} className="msg chat-error" role="alert">{item.message} <button className="link" onClick={onOpenSettings}>Open Your agents</button></div>;
              if (item.code === 'limit') return <div key={item.key} className="msg chat-error limit" role="alert">{record.provider === 'claude' ? 'Claude Code' : 'Codex'} has reached your plan's usage limit. Try again when it resets{/reset/i.test(item.message) ? ` (${item.message})` : ''}. <span className="hint">Handing the chat to the other agent comes in a later version.</span></div>;
              if (item.code === 'malformed') return <div key={item.key} className="msg chat-error" role="alert">{item.message} Send a message to start it again, or use Open in terminal.</div>;
              return <div key={item.key} className="msg chat-error" role="alert">{item.message}</div>;
            }
            // Every turn keeps its end marker (empty when it simply finished), so what follows knows where a turn ended.
            case 'turn-end': return <div key={item.key} className={`turn-end ${item.status}`}>{usageLine(item)}</div>;
            case 'cloud': return (
              <div key={item.key} className="card cloud-card" role="status">
                <div className="card-title">Running on claude.ai: {item.title}</div>
                <p className="hint">Claude Code doesn't report progress while it works; follow it on claude.ai. Continue here opens its conversation in a terminal, in a fresh worktree on a new branch. Its file changes stay in the cloud.</p>
                <div className="card-actions"><a href={item.url} target="_blank" rel="noreferrer">Open on claude.ai</a> <button onClick={onContinueCloud} disabled={!onContinueCloud}>Continue here</button></div>
              </div>
            );
          }
        })}
        {view.running && !view.pending.length && <Working provider={record.provider} starting={events[events.length - 1]?.type === 'user'} doing={activity(events)} />}
        <div ref={end} />
      </div>
      {cloudStarted
        ? terminalId ? <div className="chat-terminal"><TerminalPane id={terminalId} /></div> : <p className="hint cloud-done">This chat runs on claude.ai. Open it there, or choose Continue here.</p>
        : <Composer record={record} running={view.running} onSend={onSend} onStop={onStop} onConfigure={onConfigure} models={latestModels(events)} defaults={defaults} sessionModel={latestSessionModel(events)} context={latestContext(events)} commands={commands?.length ? commands : latestCommands(events)}
            {...(record.provider === 'claude' && onWhere && !events.some(event => event.type === 'user') ? { onWhere } : {})} />}
    </section>
  );
}
