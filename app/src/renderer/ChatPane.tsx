import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatAnswer, ChatEvent, ChatImage, ChatRecord } from '../shared/ipc';
import { foldEvents, type ChatItem } from './chatModel';
import { Composer } from './Composer';
import { Markdown } from './markdown';
import { ReviewPane } from './ReviewPane';

interface Props {
  record: ChatRecord;
  events: ChatEvent[];
  /** Events before this position were settled when the chat was opened. */
  settledBefore?: number;
  onSend(text: string, images?: ChatImage[]): void;
  onOpenTerminal(): void;
  /** Opens Settings, where Your agents shows what is installed. */
  onOpenSettings?(): void;
  /** The chat is open in a terminal the user started: sends wait until they close it. */
  inTerminal?: boolean;
  onTerminalClosed?(): void;
  onAnswer(requestId: string, answer: ChatAnswer): void | Promise<unknown>;
  onStop(): void;
  onConfigure(change: { model?: string; effort?: string; permissionMode?: 'default' | 'acceptEdits' | 'plan'; sandbox?: 'read-only' | 'workspace-write' }): void;
}

/** The CLI's latest model list in this chat (Codex sends one when a thread starts). */
const latestModels = (events: ChatEvent[]) => { for (let i = events.length - 1; i >= 0; i--) { const event = events[i]!; if (event.type === 'models') return event.models; } return []; };

const pretty = (value: unknown) => { try { return JSON.stringify(value, null, 2); } catch { return String(value); } };

/** One collapsible block for a tool call and its result. Everything in it is text. */
function ToolBlock({ item }: { item: ChatItem & { kind: 'tool' } }) {
  const summary = typeof (item.input as { command?: unknown })?.command === 'string' ? String((item.input as { command: string }).command)
    : typeof (item.input as { file_path?: unknown })?.file_path === 'string' ? String((item.input as { file_path: string }).file_path) : '';
  return (
    <details className={`tool ${item.isError ? 'failed' : ''}`}>
      <summary><span className="tool-name">{item.name}</span>{summary && <span className="tool-summary">{summary}</span>}{item.output === undefined && <span className="tool-state">running…</span>}</summary>
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
  const usage = item.usage;
  if (usage?.inputTokens !== undefined || usage?.outputTokens !== undefined) parts.push(`${(usage.inputTokens ?? 0) + (usage.cachedTokens ?? 0)} in · ${usage.outputTokens ?? 0} out`);
  if (usage?.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(4)}`);
  if (item.detail) parts.push(item.detail);
  return parts.join(' · ');
}

/** The line under a running turn: what it waits on, and for how long once that's more than a few seconds. */
function Working({ provider, starting }: { provider: ChatRecord['provider']; starting: boolean }) {
  const since = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const seconds = Math.floor((now - since.current) / 1000);
  const name = provider === 'claude' ? 'Claude Code' : 'Codex';
  return <div className="working" role="status">{starting ? `Starting ${name}…` : `${name} is working…`}{seconds >= 5 ? ` ${seconds}s` : ''}</div>;
}

export function ChatPane({ record, events, settledBefore = 0, onSend, onAnswer, onStop, onConfigure, onOpenTerminal, inTerminal = false, onTerminalClosed, onOpenSettings }: Props) {
  const view = useMemo(() => foldEvents(events, settledBefore), [events, settledBefore]);
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
      <header className="chat-head">
        <span className="chat-title" title={record.cwd}>{record.title}</span>
        <span className="chip">{record.provider === 'claude' ? 'Claude Code' : 'Codex'}</span>
        {/* For anything the pane can't show: the CLI's own interactive resume of this chat. */}
        <button className="head-action" onClick={() => setReviewing(current => !current)} aria-pressed={reviewing}>{reviewing ? 'Back to chat' : 'Review changes'}</button>
        <button className="head-action terminal" onClick={onOpenTerminal} disabled={view.running || inTerminal} title={view.running ? 'Stop the chat first' : 'Continue this chat in the CLI itself, in a terminal window, with its own default settings'}>Open in terminal</button>
      </header>
      {inTerminal && <div className="banner warning terminal-banner" role="status">This chat is open in a terminal. Close that window before sending here, so two programs don't write to one session. <button onClick={onTerminalClosed}>I closed the terminal</button></div>}
      {reviewing && <ReviewPane chatId={record.id} />}
      <div className="transcript" role="log" aria-live="polite" hidden={reviewing}>
        {view.items.map(item => {
          switch (item.kind) {
            case 'user': return <div key={item.key} className="msg user"><div className="bubble">{item.text}{item.images ? <span className="chip">{item.images} image{item.images > 1 ? 's' : ''}</span> : null}</div></div>;
            case 'text': return <div key={item.key} className="msg assistant"><Markdown text={item.text} /></div>;
            case 'thinking': return <details key={item.key} className="thinking"><summary>Thinking</summary><div className="thinking-text">{item.text}</div></details>;
            case 'tool': return <ToolBlock key={item.key} item={item} />;
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
            case 'turn-end': { const line = usageLine(item); return line ? <div key={item.key} className={`turn-end ${item.status}`}>{line}</div> : null; }
          }
        })}
        {view.running && !view.pending.length && <Working provider={record.provider} starting={events[events.length - 1]?.type === 'user'} />}
        <div ref={end} />
      </div>
      <Composer record={record} running={view.running} onSend={onSend} onStop={onStop} onConfigure={onConfigure} models={latestModels(events)} />
    </section>
  );
}
