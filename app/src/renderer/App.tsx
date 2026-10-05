import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDelete, deleteConfirmed } from './ConfirmDelete';
import { nextStatus, type ChatStatus } from './chatStatus';
import type { AppInfo, AppSettings, AppState, ChatAnswer, ChatDefaults, ChatEvent, HydraTreeMessage, ChatEventsMessage, ChatRecord, ClaudePermissionMode, CodexApprovals, OnboardingReport, Project } from '../shared/ipc';
import { mergePush } from './chatModel';
import { resolveTheme, themeVariables, type ThemeName } from '../shared/theme';
import { ChatPane } from './ChatPane';
import { EmptyState, type KnownModels, type StartRequest } from './EmptyState';
import { SettingsView } from './SettingsView';
import { AgentsView } from './AgentsView';
import { HostLayer } from './HostLayer';
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
  // The Agents view's own light colours (webview/*.css) key on VS Code's body class.
  document.body?.classList.toggle('vscode-light', theme === 'light');
  root.style.colorScheme = theme;
}

export function App() {
  const [info, setInfo] = useState<AppInfo>();
  const [settings, setSettings] = useState<AppSettings>();
  const [state, setState] = useState<AppState>();
  const [view, setView] = useState<View>({ kind: 'home' });
  // Main asks to show a project (Hydra's Show All Projects) or the app's own Settings (Hydra Settings' Accounts).
  useEffect(() => window.hydra.onHydraHost(message => {
    if (message.kind !== 'navigate') return;
    if (message.to === 'settings') { setMode('chat'); setView({ kind: 'settings' }); }
    else if (message.projectId) setView({ kind: 'project', id: message.projectId });
  }), []);
  /** Chat or Agents (G5): the title bar's switch. Agents shows the open project's heads, plans and lanes. */
  const [mode, setMode] = useState<'chat' | 'agents'>('chat');
  const [error, setError] = useState<string>();
  const [setup, setSetup] = useState<OnboardingReport>();
  const [checking, setChecking] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [chats, setChats] = useState<ChatRecord[]>([]);
  const [deleting, setDeleting] = useState<ChatRecord>();
  // Each chat's dot in the sidebar (chatStatus.ts), from the events main pushes for every chat.
  const [statuses, setStatuses] = useState<Record<string, ChatStatus>>({});
  const waiting = useRef(new Map<string, Set<string>>());
  const onScreen = useRef<string | undefined>(undefined);
  const [chatEvents, setChatEvents] = useState<Record<string, ChatEvent[]>>({});
  /** Per chat: events before this position were already settled when it was opened (see foldEvents). */
  const [settled, setSettled] = useState<Record<string, number>>({});
  /** Chats open in a terminal the user started. */
  const [inTerminal, setInTerminal] = useState<Record<string, boolean>>({});
  const [defaults, setDefaults] = useState<Record<string, ChatDefaults>>({});
  /** Each running project's heads and plans (G5), by project id. */
  const [trees, setTrees] = useState<Record<string, HydraTreeMessage>>({});
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
    // The app opens with its sidebar, as Claude desktop does; hiding it lasts until the app closes.
    void window.hydra.getState().then(loaded => setState({ ...loaded, sidebarOpen: true }), fail);
    void checkSetup(false);
    void window.hydra.problems().then(list => setProblems(list), fail);
    void window.hydra.listChats().then(setChats, fail);
    // Each project's heads and plans (G5): the latest now, then every change.
    void window.hydra.hydraTree().then(list => setTrees(current => ({ ...Object.fromEntries(list.map(tree => [tree.projectId, tree])), ...current })), fail);
    const stopTrees = window.hydra.onHydraTree(tree => setTrees(current => ({ ...current, [tree.projectId]: tree })));
    // Live events for every chat this window has open; the list refreshes when a turn ends or a title appears.
    const stopChats = window.hydra.onChatEvents(message => {
      const { chatId, events, start } = message;
      if (start < 0) { const notice = events.find(event => event.type === 'error'); if (notice?.type === 'error') setError(notice.message); return; }
      const pending = waiting.current.get(chatId) ?? new Set<string>();
      waiting.current.set(chatId, pending);
      setStatuses(current => {
        const next = nextStatus(current[chatId], events, pending, onScreen.current === chatId);
        if (next === current[chatId]) return current;
        const copy = { ...current };
        if (next) copy[chatId] = next; else delete copy[chatId];
        return copy;
      });
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
    return () => { stopChats(); stopTrees(); };
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
  /** The latest chats, newest first, for the home screen. */
  // What chats so far reported about models, for the home's Model menu before a chat starts.
  const knownModels = useMemo((): KnownModels => {
    const claudeVersions: Record<string, string> = {};
    let codex: KnownModels['codex'] = [];
    for (const [id, events] of Object.entries(chatEvents)) {
      const provider = chats.find(chat => chat.id === id)?.provider;
      for (const event of events) {
        if (event.type === 'session' && event.model) { const version = /claude-(opus|sonnet|haiku)-(\d+)-(\d+)/i.exec(event.model); if (version) claudeVersions[version[1]!.toLowerCase()] = `${version[2]}.${version[3]}`; }
        if (event.type === 'models' && provider === 'codex' && event.models.length) codex = event.models;
      }
    }
    // The user's own Claude default mode, from any Claude chat opened so far (their settings' defaultMode).
    const claudeMode = Object.entries(defaults).find(([id]) => chats.find(chat => chat.id === id)?.provider === 'claude')?.[1]?.mode;
    return { claudeVersions, codex, ...(claudeMode ? { claudeMode } : {}) };
  }, [chatEvents, chats, defaults]);
  const recents = chats.filter(chat => !chat.archivedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8).map(chat => ({
    id: chat.id, title: chat.title, provider: chat.provider, updatedAt: chat.updatedAt,
    project: state?.projects.find(p => samePath(p.path, chat.cwd))?.name,
  }));
  const afterCliChange = (next: AppSettings) => { setSettings(next); void checkSetup(false); };

  const sidebarOpen = state?.sidebarOpen ?? true;
  // The sidebar follows the click at once; saving it is best effort, and a failed save only shows its error.
  useEffect(() => {
    onScreen.current = view.kind === 'chat' ? view.id : undefined;
    if (view.kind === 'chat') setStatuses(current => { if (current[view.id] !== 'unread') return current; const copy = { ...current }; delete copy[view.id]; return copy; });
  }, [view]);
  useEffect(() => {
    const timer = setInterval(() => { void window.hydra.listChats().then(setChats, () => undefined); }, 120_000);
    return () => clearInterval(timer);
  }, []);
  const removeChat = (chat: ChatRecord) => void run(window.hydra.removeChat(chat.id), () => {
    setChats(list => list.filter(c => c.id !== chat.id));
    if (view.kind === 'chat' && view.id === chat.id) setView(project ? { kind: 'project', id: project.id } : { kind: 'home' });
  });
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
  /** Clone a repo: main asks where it goes, clones it, and the clone opens as a project. Errors show in the banner. */
  const cloneRepo = async (url: string) => {
    try {
      const { state: next, picked } = await window.hydra.cloneRepo(url);
      setState(next);
      if (picked) setView({ kind: 'project', id: picked });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const chat = view.kind === 'chat' ? chats.find(c => c.id === view.id) : undefined;
  const project = view.kind === 'project' ? state?.projects.find(p => p.id === view.id)
    : chat ? state?.projects.find(p => samePath(p.path, chat.cwd)) : undefined;

  const openChat = (id: string, show = true) => {
    // One open at a time per chat: a second request while one runs only brings it to the front.
    if (opening.current.has(id)) { if (show) setView({ kind: 'chat', id }); return; }
    opening.current.set(id, []);
    void run(window.hydra.openChat(id, !show), opened => {
      let events: ChatEvent[] = opened.log.map(entry => entry.event);
      let gap = false;
      for (const message of opening.current.get(id) ?? []) { const merged = mergePush(events, message); if (merged) events = merged; else gap = true; }
      opening.current.delete(id);
      if (gap) setTimeout(() => reopen.current(id), 0);
      setChatEvents(current => ({ ...current, [id]: events }));
      setSettled(current => ({ ...current, [id]: opened.running ? 0 : opened.log.length }));
      setInTerminal(current => ({ ...current, [id]: opened.inTerminal }));
      setDefaults(current => ({ ...current, [id]: opened.defaults }));
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
      // Opening it starts Claude Code now, while the user types, and brings the user's own defaults.
      openChat(record.id);
    });
  };
  /** The home's prompt: a chat in the chosen project, with that agent (and place), and the message sent at once. */
  const startChat = async ({ project: target, provider, where, text, permissionMode, approvals, model, effort, images }: StartRequest): Promise<boolean> => {
    let current = target;
    try {
      if (!current.trustedAt) {
        const next = await window.hydra.trustProject(target.id);
        setState(next);
        current = next.projects.find(p => p.id === target.id) ?? target;
        if (!current.trustedAt) return false;
      }
      const record = await window.hydra.createChat({ projectId: current.id, provider, ...(where === 'cloud' ? { where: 'cloud' as const } : {}), ...(permissionMode ? { permissionMode } : {}), ...(approvals ? { approvals } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
      setChats(list => [record, ...list]);
      setChatEvents(events => ({ ...events, [record.id]: [] }));
      setSettled(settled => ({ ...settled, [record.id]: 0 }));
      setView({ kind: 'chat', id: record.id });
      openChat(record.id);
      await window.hydra.sendMessage(record.id, text, images);
      setError(undefined);
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; }
  };
  const configure = (id: string, change: { model?: string; effort?: string; permissionMode?: ClaudePermissionMode; approvals?: CodexApprovals; sandbox?: 'read-only' | 'workspace-write' }) =>
    void run(window.hydra.configureChat(id, Object.fromEntries(Object.entries(change).map(([key, value]) => [key, value ?? ''])) as typeof change), record => setChats(list => list.map(c => (c.id === record.id ? record : c))));

  return (
    <div className={`app ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
      <HostLayer />
      {deleting && <ConfirmDelete chat={deleting} onCancel={() => setDeleting(undefined)} onConfirm={() => { removeChat(deleting); setDeleting(undefined); }} />}
      <TitleBar sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} mode={mode} onMode={setMode} />
      <div className="body">
        {/* Kept mounted so the toggle can slide it; closed, it is inert (no focus, clicks or screen reader). */}
        {state && (
          <div className="sidebar-slot" inert={!sidebarOpen}>
            <Sidebar
              projects={state.projects}
              chats={chats}
              statuses={statuses}
              view={view}
              // New chat asks which agent: the project's page offers Claude Code and Codex (home when there's no project).
              onNewChat={() => setView(project ? { kind: 'project', id: project.id } : { kind: 'home' })}
              onOpenChat={openChat}
              onOpenProject={id => setView({ kind: 'project', id })}
              onAddProject={pickProject}
              onRemoveProject={id => void run(window.hydra.removeProject(id), next => { setState(next); if (view.kind === 'project' && view.id === id) setView({ kind: 'home' }); })}
              onOpenSettings={() => setView({ kind: 'settings' })}
              onRenameChat={(id, title) => void run(window.hydra.renameChat(id, title), record => setChats(list => list.map(c => (c.id === record.id ? record : c))))}
              onArchiveChat={(id, archived) => void run(window.hydra.archiveChat(id, archived), record => {
                setChats(list => list.map(c => (c.id === record.id ? record : c)));
                if (archived && view.kind === 'chat' && view.id === id) setView(project ? { kind: 'project', id: project.id } : { kind: 'home' });
              })}
              // Only the first Delete asks (ConfirmDelete.tsx); after that it just deletes.
              onDeleteChat={chat => { if (deleteConfirmed()) removeChat(chat); else setDeleting(chat); }}
            />
          </div>
        )}
        <main className="main">
          {problems.map(problem => <div className="banner warning" role="alert" key={problem}>{problem}</div>)}
          {error && <div className="banner error" role="alert">{error}{/Your agents/.test(error) && <> <button className="link" onClick={() => setView({ kind: 'settings' })}>Open Your agents</button></>}</div>}
          {mode === 'agents'
            ? (project?.trustedAt ? <AgentsView key={project.id} project={project} /> : <section className="empty"><h1>Agents</h1><p>{project ? 'Trust this project to run heads, plans and lanes in it: start a chat there.' : 'Open a project to see its heads, plans and lanes.'}</p></section>)
            : view.kind === 'settings' && settings
            ? <SettingsView settings={settings} info={info} onTheme={value => void run(window.hydra.setTheme(value), setSettings)} onPickCli={provider => void run(window.hydra.pickCliPath(provider), afterCliChange)} onClearCli={provider => void run(window.hydra.clearCliPath(provider), afterCliChange)} setup={setupPanel} />
            : view.kind === 'chat' && chat
              ? <ChatPane key={chat.id} record={chat} events={chatEvents[chat.id] ?? []} settledBefore={settled[chat.id] ?? 0} defaults={defaults[chat.id]} hydra={project ? trees[project.id] : undefined}
                  onSend={(text, images) => void run(window.hydra.sendMessage(chat.id, text, images), () => undefined)}
                  onOpenSettings={() => setView({ kind: 'settings' })}
                  onOpenTerminal={() => void run(window.hydra.openTerminal(chat.id), result => { if (!result.started) setError(result.error ?? 'The terminal didn\'t open.'); else setInTerminal(current => ({ ...current, [chat.id]: true })); })}
                  inTerminal={!!inTerminal[chat.id]}
                  onTerminalClosed={() => void run(window.hydra.terminalClosed(chat.id), () => setInTerminal(current => ({ ...current, [chat.id]: false })))}
                  onAnswer={(requestId: string, answer: ChatAnswer) => window.hydra.answer(chat.id, requestId, answer).catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)); throw e; })}
                  onStop={() => void run(window.hydra.stopChat(chat.id), () => undefined)}
                  onConfigure={change => configure(chat.id, change)}
                  onWhere={where => void run(window.hydra.setChatWhere(chat.id, where), record => setChats(list => list.map(c => (c.id === record.id ? record : c))))}
                  onContinueCloud={() => void run(window.hydra.continueCloud(chat.id), result => { if (!result.started) setError(result.error ?? "The terminal didn't open."); })} />
              : <EmptyState project={project} onPickFolder={pickProject} onClone={cloneRepo} onNewChat={(target, provider) => void newChat(target, provider)} recents={recents} onOpenChat={id => openChat(id)} projects={state?.projects ?? []} onStart={startChat}
                knownModels={knownModels}
                waiting={chats.filter(chat => !chat.archivedAt && (statuses[chat.id] === 'needs' || statuses[chat.id] === 'unread')).map(chat => ({ id: chat.id, title: chat.title, provider: chat.provider, updatedAt: chat.updatedAt, project: state?.projects.find(p => p.path.toLowerCase() === chat.cwd.toLowerCase())?.name, status: statuses[chat.id] as 'needs' | 'unread' }))} />}
        </main>
      </div>
    </div>
  );
}
