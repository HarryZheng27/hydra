import { useEffect, useRef, useState } from 'react';
import type { ChatEvent, PullRequestInfo } from '../shared/ipc';
import { Icon } from './Icon';

const link = /https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/pull\/\d{1,9}(?![\d/])/g;
const createsPr = (input: unknown) => {
  const command = (input as { command?: unknown })?.command;
  const text = typeof command === 'string' ? command : Array.isArray(command) ? command.join(' ') : '';
  return /(^|[\s;&|(])gh(\.exe)?\s+pr\s+create\b/.test(text);
};

/** The pull requests this chat opened, newest first: the links its own `gh pr create` calls printed. */
export function chatPullRequests(events: readonly ChatEvent[], known?: string): string[] {
  const creating = new Set<string>();
  const found: string[] = [];
  for (const event of events) {
    if (event.type === 'tool-call' && createsPr(event.input)) creating.add(event.id);
    else if (event.type === 'tool-result' && creating.has(event.id)) for (const url of event.output.match(link) ?? []) if (!found.includes(url)) found.push(url);
  }
  if (known && !found.includes(known)) found.push(known);
  return found.reverse();
}

const DISMISSED = 'hydra.dismissedPullRequests.v1';
function dismissed(): Set<string> {
  try { const raw = JSON.parse(localStorage.getItem(DISMISSED) ?? '[]') as unknown; return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []); } catch { return new Set(); }
}
function dismiss(url: string) {
  try { localStorage.setItem(DISMISSED, JSON.stringify([...dismissed(), url].slice(-500))); } catch { /* best effort */ }
}

const ciLabel: Record<PullRequestInfo['ci'], string> = { pending: 'CI running', success: 'CI passed', failure: 'CI failed', none: 'No CI' };

/** One bar, as Claude desktop's: PR icon, #, repo, branch; then +/− lines and a CI pill with its checks; ×. */
function PrBar({ url, info, onOpen, onDismiss }: { url: string; info?: PullRequestInfo; onOpen(url: string): void; onDismiss(): void }) {
  const [checks, setChecks] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!checks) return undefined;
    const away = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setChecks(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [checks]);
  const number = info?.number ?? Number(/\/pull\/(\d+)$/.exec(url)?.[1]);
  const repo = info?.repo ?? /github\.com\/[^/]+\/([^/]+)\//.exec(url)?.[1];
  const state = info?.state ?? 'open';
  return (
    <div ref={root} className={`pr-bar ${state}`} title={info?.title}>
      <button className="pr-main" onClick={() => onOpen(url)} aria-label={`Open pull request #${number}`}>
        <span className={`pr-icon ${state}`}><Icon name={state === 'merged' ? 'merged' : 'pullRequest'} /></span>
        <span className="pr-number">#{number}</span>
        <span className="pr-repo">{repo}</span>
        {info?.branch && <span className="pr-branch">{info.branch}</span>}
      </button>
      {state === 'merged' ? <span className="pr-status merged">Merged</span>
        : state === 'closed' ? <span className="pr-status closed">Closed</span>
        : info && <>
            <span className="pr-pill pr-lines" aria-label={`${info.additions} lines added, ${info.deletions} removed`}><span className="add">+{info.additions}</span> <span className="del">−{info.deletions}</span></span>
            <button className="pr-pill pr-ci" aria-haspopup="menu" aria-expanded={checks} onClick={() => setChecks(value => !value)} title={ciLabel[info.ci]} aria-label={ciLabel[info.ci]}>
              <span className={`ci-dot ${info.ci}`} aria-hidden="true" />CI<Icon name="chevronDown" />
            </button>
            {checks && (
              <ul className="row-menu pr-checks" role="menu">
                {info.checks.length ? info.checks.map((check, index) => (
                  <li key={`${check.name}:${index}`} role="menuitem" tabIndex={-1}><span className={`ci-dot ${check.status}`} aria-hidden="true" /><span>{check.name}</span><span className="hint">{check.status === 'pending' ? 'running' : check.status === 'success' ? 'passed' : check.status === 'failure' ? 'failed' : 'skipped'}</span></li>
                )) : <li className="pr-checks-empty">No checks on this pull request.</li>}
              </ul>
            )}
          </>}
      <button className="icon-button small pr-close" onClick={onDismiss} aria-label={`Hide pull request #${number}`} title="Hide"><Icon name="close" /></button>
    </div>
  );
}

/**
 * Claude desktop's pull request bars above the prompt box: the chat's PRs, newest first, two showing and the rest
 * behind "Show N more". Open ones refresh every 20 seconds while CI runs, else every minute; merged and closed stop.
 */
export function PrBars({ urls, onOpen }: { urls: string[]; onOpen(url: string): void }) {
  const [hidden, setHidden] = useState(dismissed);
  const [infos, setInfos] = useState<Record<string, PullRequestInfo>>({});
  const [all, setAll] = useState(false);
  const shown = urls.filter(url => !hidden.has(url));
  const key = shown.join(' ');
  useEffect(() => {
    if (!shown.length) return undefined;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = new Set<string>();
    const load = async () => {
      const live = shown.filter(url => !settled.has(url));
      const results = await Promise.all(live.map(url => window.hydra.pullRequest(url).then(info => info, () => undefined)));
      if (stop) return;
      const next: Record<string, PullRequestInfo> = {};
      results.forEach(info => { if (info) { next[info.url] = info; if (info.state !== 'open') settled.add(info.url); } });
      setInfos(current => ({ ...current, ...next }));
      if (settled.size === shown.length) return;
      timer = setTimeout(() => void load(), results.some(info => info?.ci === 'pending') ? 20_000 : 60_000);
    };
    void load();
    return () => { stop = true; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!shown.length) return null;
  const visible = all ? shown : shown.slice(0, 2);
  return (
    <div className="pr-bars" aria-label="Pull requests">
      {visible.map(url => <PrBar key={url} url={url} info={infos[url]} onOpen={onOpen} onDismiss={() => { dismiss(url); setHidden(dismissed()); }} />)}
      {shown.length > 2 && <button className="pr-more" onClick={() => setAll(value => !value)}>{all ? 'Show less' : `Show ${shown.length - 2} more`}</button>}
    </div>
  );
}
