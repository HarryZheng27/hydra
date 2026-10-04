import { useEffect, useMemo, useRef, useState } from 'react';
import type { HydraHostMessage } from '../shared/ipc';
import { Markdown } from './markdown';

type Ask = Extract<HydraHostMessage, { kind: 'pick' | 'input' }>;
type Notice = Extract<HydraHostMessage, { kind: 'notice' }> & { key: number };
type View = Extract<HydraHostMessage, { kind: 'view' }>;

/**
 * Hydra's own questions, notices and documents in the window (main/hostUi.ts), where the IDE shows its quick picks,
 * input boxes, notifications and read-only editor tabs. Every answer goes back by request id through hydra.reply, and
 * main checks it; Escape or Cancel dismisses. Documents are text and images main read itself: nothing here loads a
 * path or a URL, and Markdown is rendered without HTML (markdown.tsx).
 */
export function HostLayer() {
  const [asks, setAsks] = useState<Ask[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [view, setView] = useState<View>();
  const seed = useRef(0);

  useEffect(() => window.hydra.onHydraHost(message => {
    if (message.kind === 'pick' || message.kind === 'input') setAsks(current => [...current.filter(ask => ask.requestId !== message.requestId), message]);
    else if (message.kind === 'notice') {
      const key = ++seed.current;
      setNotices(current => {
        const next = [...current.filter(notice => !message.requestId || notice.requestId !== message.requestId), { ...message, key }];
        // At most five: the oldest that asks nothing goes first; one waiting for an answer stays until answered.
        while (next.length > 5) { const drop = next.findIndex(notice => !notice.requestId); if (drop < 0) break; next.splice(drop, 1); }
        return next;
      });
      // A notice that asks nothing goes after a while (an error after longer); one with actions waits for an answer.
      if (!message.requestId) setTimeout(() => setNotices(current => current.filter(notice => notice.key !== key)), message.level === 'error' ? 20000 : 8000);
    } else if (message.kind === 'view') setView(message);
    else if (message.kind === 'dismiss') {
      setAsks(current => current.filter(ask => ask.requestId !== message.requestId));
      setNotices(current => current.filter(notice => notice.requestId !== message.requestId));
    }
  }), []);

  const answer = (requestId: string, value: number | number[] | string | null) => {
    setAsks(current => current.filter(ask => ask.requestId !== requestId));
    setNotices(current => current.filter(notice => notice.requestId !== requestId));
    void window.hydra.hydraReply(requestId, value).catch(() => undefined);
  };
  const ask = asks[0];

  return <>
    {view && <ViewSheet view={view} active={!ask} onClose={() => setView(undefined)} />}
    {/* A click outside dismisses a list, never a text box: an answer being typed isn't lost to a stray click. */}
    {ask && <div className="host-ask-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && ask.kind === 'pick') answer(ask.requestId, null); }}>
      {ask.kind === 'pick' ? <PickDialog key={ask.requestId + (ask.error ?? '')} ask={ask} onAnswer={value => answer(ask.requestId, value)} /> : <InputDialog key={ask.requestId + (ask.error ?? '')} ask={ask} onAnswer={value => answer(ask.requestId, value)} />}
    </div>}
    {!!notices.length && <div className="host-notices" role="status" aria-live="polite">
      {notices.map(notice => <div key={notice.key} className={`host-notice ${notice.level}`}>
        <p>{notice.message}</p>
        <div className="host-notice-actions">
          {notice.actions.map(action => <button key={action} className="link" onClick={() => answer(notice.requestId!, action)}>{action}</button>)}
          <button className="icon-button" aria-label="Dismiss" onClick={() => (notice.requestId ? answer(notice.requestId, null) : setNotices(current => current.filter(item => item.key !== notice.key)))}>×</button>
        </div>
      </div>)}
    </div>}
  </>;
}

function useEscape(onEscape: () => void, active = true) {
  useEffect(() => {
    if (!active) return undefined;
    const listener = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onEscape(); } };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [onEscape, active]);
}

function PickDialog({ ask, onAnswer }: { ask: Extract<Ask, { kind: 'pick' }>; onAnswer: (value: number | number[] | null) => void }) {
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<Set<number>>(() => new Set(ask.items.flatMap((item, index) => (item.picked ? [index] : []))));
  useEscape(useMemo(() => () => onAnswer(null), [onAnswer]));
  const shown = ask.items.map((item, index) => ({ item, index })).filter(({ item }) => !filter || `${item.label} ${item.description} ${item.detail}`.toLowerCase().includes(filter.toLowerCase()));
  return <div className="host-ask" role="dialog" aria-modal="true" aria-label={ask.title || 'Pick'}>
    {ask.title && <h2>{ask.title}</h2>}
    <input autoFocus type="search" placeholder={ask.placeHolder || 'Filter'} value={filter} onChange={event => setFilter(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter' && !ask.many && shown.length === 1) onAnswer(shown[0]!.index); }} />
    {ask.error && <p className="host-ask-error" role="alert">{ask.error}</p>}
    <ul className="host-pick-list">
      {shown.map(({ item, index }) => <li key={index}>
        <button className={picked.has(index) ? 'picked' : ''} aria-pressed={ask.many ? picked.has(index) : undefined}
          onClick={() => (ask.many ? setPicked(current => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; }) : onAnswer(index))}>
          {ask.many && <span className="host-check" aria-hidden="true">{picked.has(index) ? '✓' : ''}</span>}
          <span className="host-pick-label">{item.label}</span>
          {item.description && <span className="host-pick-description">{item.description}</span>}
          {item.detail && <span className="host-pick-detail">{item.detail}</span>}
        </button>
      </li>)}
      {!shown.length && <li className="host-pick-empty">Nothing matches.</li>}
    </ul>
    <div className="host-ask-actions">
      <button onClick={() => onAnswer(null)}>Cancel</button>
      {ask.many && <button className="primary" onClick={() => onAnswer([...picked].sort((a, b) => a - b))}>OK</button>}
    </div>
  </div>;
}

function InputDialog({ ask, onAnswer }: { ask: Extract<Ask, { kind: 'input' }>; onAnswer: (value: string | null) => void }) {
  const [value, setValue] = useState(ask.value);
  useEscape(useMemo(() => () => onAnswer(null), [onAnswer]));
  return <form className="host-ask" role="dialog" aria-modal="true" aria-label={ask.title || 'Answer'} onSubmit={event => { event.preventDefault(); onAnswer(value); }}>
    {ask.title && <h2>{ask.title}</h2>}
    {ask.prompt && <p className="host-ask-prompt">{ask.prompt}</p>}
    <textarea autoFocus rows={3} placeholder={ask.placeHolder} value={value} onChange={event => setValue(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onAnswer(value); } }} />
    {ask.error && <p className="host-ask-error" role="alert">{ask.error}</p>}
    <div className="host-ask-actions">
      <button type="button" onClick={() => onAnswer(null)}>Cancel</button>
      <button type="submit" className="primary">OK</button>
    </div>
  </form>;
}

function ViewSheet({ view, active, onClose }: { view: View; active: boolean; onClose: () => void }) {
  // While a question is open over it, Escape answers the question, not the viewer.
  useEscape(onClose, active);
  return <div className="host-view-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="host-view" role="dialog" aria-modal="true" aria-label={view.title}>
      <header>
        <h2 title={view.title}>{view.title}</h2>
        <button className="icon-button" aria-label="Close" onClick={onClose}>×</button>
      </header>
      <div className={`host-view-body ${view.format}`}>
        {view.format === 'markdown'
          ? <><Markdown text={view.content} />{view.images.map((image, index) => <figure key={index}><img src={image.src} alt={image.alt} /><figcaption>Screenshot {index + 1}: {image.alt}</figcaption></figure>)}</>
          : <pre>{view.format === 'diff' ? view.content.split('\n').map((line, index) => <span key={index} className={diffLine(line)}>{line}{'\n'}</span>) : view.content}</pre>}
      </div>
    </section>
  </div>;
}

const diffLine = (line: string): string => (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') ? 'meta' : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('#') ? 'note' : '');
