import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppInfo, AppSettings, AppState, ChatAnswer, ChatEvent, ChatEventsMessage, ChatRecord, OnboardingReport, Project } from '../shared/ipc';
import { mergePush } from './chatModel';
import { resolveTheme, themeVariables, type ThemeName } from '../shared/theme';
import { ChatPane } from './ChatPane';
import { EmptyState } from './EmptyState';
import { SettingsView } from './SettingsView';
import { Setup } from './Setup';
import { Sidebar } from './Sidebar';
import { TitleBar } from './TitleBar';

export type View = { kind: 'home' } | { kind: 'project'; id: string } | { kind: 'chat'; id: string } | { kind: 'settings' };

const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Follows the system's light or dark preference, which main sets from the theme setting. */
function useSystemDark(): boolean {
  const query = useMemo(() => window.matchMedia('(prefers-color-scheme: dark)'), []);
  const [dark, setDark] = useState(query.matches);
  useEffect(() => {
    const listener = () => setDark(query.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, [query]);
  return dark;
}

function applyThemeVariables(theme: ThemeName): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(themeVariables(theme))) root.style.setProperty(name, value);
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

export function App() {
  const [info, setInfo] = useState<AppInfo>();
  const [settings, setSettings] = useState<AppSettings>();
  const [state, setState] = useState<AppState>();
  const [view, setView] = useState<View>({ kind: 'home' });
  const [error, setError] = useState<string>();
  const [setup, setSetup] = useState<OnboardingReport>();
  const [checking, setChecking] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [chats, setChats] = useState<ChatRecord[]>([]);
  const [chatEvents, setChatEvents] = useState<Record<string, ChatEvent[]>>({});
  /** Per chat: events before this position were already settled when it was opened (see foldEvents). */
  const [settled, setSettled] = useState<Record<string, number>>({});
  /** Pushes that arrive while a chat's log is being read, merged once it is in. */
  const opening = useRef(new Map<string, ChatEventsMessage[]>());
  const reopen = useRef<(id: string) => void>(() => undefined);
  const systemDark = useSystemDark();
  const theme = resolveTheme(settings?.theme ?? 'system', systemDark);

  useEffect(() => { applyThemeVariables(theme); }, [theme]);
  useEffect(() => {
    const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
    void window.hydra.appInfo().then(setInfo, fail);
    void window.hydra.getSettings().then(setSettings, fail);
    void window.hydra.getState().then(setState, fail);
    void checkSetup(false);
    void window.hydra.problems().then(list => setProblems(list), fail);
    void window.hydra.listChats().then(setChats, fail);
    // Live events for every chat this window has open; the list refreshes when a turn ends or a title appears.
    return window.hydra.onChatEvents(message => {
      const { chatId, events, start } = message;
      if (start < 0) { const notice = events.find(event => event.type === 'error'); if (notice?.type === 'error') setError(notice.message); return; }
      const buffered = opening.current.get(chatId);
      if (buffered) buffered.push(message);
      else setChatEvents(current => {
        if (!current[chatId]) return current;
        const merged = mergePush(current[chatId]!, message);
        if (!merged) { setTimeout(() => reopen.current(chatId), 0); return current; }
        return merged === current[chatId] ? current : { ...current, [chatId]: merged };
      });
      if (events.some(event => event.type === 'done' || event.type === 'user')) void window.hydra.listChats().then(setChats, fail);
    });
  }, []);

  /** Runs a call to main and shows its error, if any, instead of throwing. */
  const run = async <T,>(call: Promise<T>, apply: (value: T) => void): Promise<void> => {
    try { apply(await call); setError(undefined); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  /** Onboarding's version and help checks. Main remembers the answer until a refresh or a new CLI path. */
  async function checkSetup(refresh: boolean): Promise<void> {
    setChecking(true);
    try { await run(window.hydra.checkSetup(refresh), setSetup); } finally { setChecking(false); }
  }
  const setupPanel = <Setup report={setup} checking={checking} onCheck={() => void checkSetup(true)} onSignIn={provider => window.hydra.signIn(provider)} />;
  const afterCliChange = (next: AppSettings) => { setSettings(next); void checkSetup(false); };

  const sidebarOpen = state?.sidebarOpen ?? true;
  // The sidebar follows the click at once; saving it is best effort, and a failed save only shows its error.
  const toggleSidebar = () => {
    if (!state) return;
    const open = !state.sidebarOpen;
    setState({ ...state, sidebarOpen: open });
    void window.hydra.setSidebarOpen(open).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  const pickProject = () => void run(window.hydra.pickProject(), ({ state: next, picked }) => {
    setState(next);
    if (picked) setView({ kind: 'project', id: picked });
  });
  const chat = view.kind === 'chat' ? chats.find(c => c.id === view.id) : undefined;
  const project = view.kind === 'project' ? state?.projects.find(p => p.id === view.id)
    : chat ? state?.projects.find(p => samePath(p.path, chat.cwd)) : undefined;

  const openChat = (id: string, show = true) => {
    // One open at a time per chat: a second request while one runs only brings it to the front.
    if (opening.current.has(id)) { if (show) setView({ kind: 'chat', id }); return; }
    opening.current.set(id, []);
    void run(window.hydra.openChat(id), opened => {
      let events: ChatEvent[] = opened.log.map(entry => entry.event);
      let gap = false;
      for (const message of opening.current.get(id) ?? []) { const merged = mergePush(events, message); if (merged) events = merged; else gap = true; }
      opening.current.delete(id);
      if (gap) setTimeout(() => reopen.current(id), 0);
      setChatEvents(current => ({ ...current, [id]: events }));
      setSettled(current => ({ ...current, [id]: opened.running ? 0 : opened.log.length }));
      if (show) setView({ kind: 'chat', id });
    }).finally(() => opening.current.delete(id));
  };
  reopen.current = id => openChat(id, false);
  /** A new chat in a project: main asks the user to trust the folder first, in its own dialog. */
  const newChat = async (target: Project, provider: 'claude' | 'codex' = 'claude') => {
    let current = target;
    if (!current.trustedAt) {
      try { const next = await window.hydra.trustProject(target.id); setState(next); current = next.projects.find(p => p.id === target.id) ?? target; }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); return; }
      if (!current.trustedAt) return;
    }
    await run(window.hydra.createChat({ projectId: current.id, provider }), record => {
      setChats(list => [record, ...list]);
      setChatEvents(events => ({ ...events, [record.id]: [] }));
      setSettled(current => ({ ...current, [record.id]: 0 }));
      setView({ kind: 'chat', id: record.id });
    });
  };
  const configure = (id: string, change: { model?: string; effort?: string; permissionMode?: 'default' | 'acceptEdits' | 'plan'; sandbox?: 'read-only' | 'workspace-write' }) =>
    void run(window.hydra.configureChat(id, Object.fromEntries(Object.entries(change).map(([key, value]) => [key, value ?? ''])) as typeof change), record => setChats(list => list.map(c => (c.id === record.id ? record : c))));

  return (
    <div className={`app ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
      <TitleBar sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
      <div className="body">
        {sidebarOpen && state && (
          <Sidebar
            projects={state.projects}
            chats={chats}
            view={view}
            onNewChat={() => (project ? void newChat(project) : setView({ kind: 'home' }))}
            onOpenChat={openChat}
            onOpenProject={id => setView({ kind: 'project', id })}
            onAddProject={pickProject}
            onRemoveProject={id => void run(window.hydra.removeProject(id), next => { setState(next); if (view.kind === 'project' && view.id === id) setView({ kind: 'home' }); })}
            onOpenSettings={() => setView({ kind: 'settings' })}
          />
        )}
        <main className="main">
          {problems.map(problem => <div className="banner warning" role="alert" key={problem}>{problem}</div>)}
          {error && <div className="banner error" role="alert">{error}</div>}
          {view.kind === 'settings' && settings
            ? <SettingsView settings={settings} info={info} onTheme={value => void run(window.hydra.setTheme(value), setSettings)} onPickCli={provider => void run(window.hydra.pickCliPath(provider), afterCliChange)} onClearCli={provider => void run(window.hydra.clearCliPath(provider), afterCliChange)} setup={setupPanel} />
            : view.kind === 'chat' && chat
              ? <ChatPane key={chat.id} record={chat} events={chatEvents[chat.id] ?? []} settledBefore={settled[chat.id] ?? 0}
                  onSend={text => void run(window.hydra.sendMessage(chat.id, text), () => undefined)}
                  onAnswer={(requestId: string, answer: ChatAnswer) => window.hydra.answer(chat.id, requestId, answer).catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); throw e; })}
                  onStop={() => void run(window.hydra.stopChat(chat.id), () => undefined)}
                  onConfigure={change => configure(chat.id, change)} />
              : <EmptyState project={project} onPickFolder={pickProject} onNewChat={(target, provider) => void newChat(target, provider)} setup={project ? undefined : setupPanel} />}
        </main>
      </div>
    </div>
  );
}
