import { useEffect, useMemo, useState } from 'react';
import type { AppInfo, AppSettings, AppState } from '../shared/ipc';
import { resolveTheme, themeVariables, type ThemeName } from '../shared/theme';
import { EmptyState } from './EmptyState';
import { SettingsView } from './SettingsView';
import { Sidebar } from './Sidebar';
import { TitleBar } from './TitleBar';

export type View = { kind: 'home' } | { kind: 'project'; id: string } | { kind: 'settings' };

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
  const [problems, setProblems] = useState<string[]>([]);
  const systemDark = useSystemDark();
  const theme = resolveTheme(settings?.theme ?? 'system', systemDark);

  useEffect(() => { applyThemeVariables(theme); }, [theme]);
  useEffect(() => {
    const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
    void window.hydra.appInfo().then(setInfo, fail);
    void window.hydra.getSettings().then(setSettings, fail);
    void window.hydra.getState().then(setState, fail);
    void window.hydra.problems().then(list => setProblems(list), fail);
  }, []);

  /** Runs a call to main and shows its error, if any, instead of throwing. */
  const run = async <T,>(call: Promise<T>, apply: (value: T) => void): Promise<void> => {
    try { apply(await call); setError(undefined); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

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
  const project = view.kind === 'project' ? state?.projects.find(p => p.id === view.id) : undefined;

  return (
    <div className={`app ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
      <TitleBar sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
      <div className="body">
        {sidebarOpen && state && (
          <Sidebar
            projects={state.projects}
            view={view}
            onNewChat={() => setView(project ? view : { kind: 'home' })}
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
            ? <SettingsView settings={settings} info={info} onTheme={value => void run(window.hydra.setTheme(value), setSettings)} onPickCli={provider => void run(window.hydra.pickCliPath(provider), setSettings)} onClearCli={provider => void run(window.hydra.clearCliPath(provider), setSettings)} />
            : <EmptyState project={project} onPickFolder={pickProject} />}
        </main>
      </div>
    </div>
  );
}
