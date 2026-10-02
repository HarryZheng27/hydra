import type { AppSettings, AppState, CliProvider } from '../shared/ipc';
import type { ThemeSetting } from '../shared/theme';
import type { Handlers } from './ipc';
import { addProject, projectFor, removeProject, setCliPath, type JsonStore } from './settings';

export interface HandlerDeps {
  info: { name: string; version: string; electron: string; platform: string };
  settings: JsonStore<AppSettings>;
  state: JsonStore<AppState>;
  /** Main's own folder picker. Undefined when the user cancels. */
  pickFolder(): Promise<string | undefined>;
  /** Main's own file picker for a provider's command-line tool. Undefined when the user cancels. */
  pickExecutable(provider: CliProvider): Promise<string | undefined>;
  /** Applies a theme setting to the window: the native theme and the title bar. */
  applyTheme(theme: ThemeSetting): void;
}

/** What main does for each channel. Paths only ever come from main's own pickers, never from the renderer. */
export function createHandlers(deps: HandlerDeps): Handlers {
  return {
    'app.info': () => deps.info,
    'app.problems': async () => {
      await Promise.all([deps.settings.load(), deps.state.load()]);
      return [deps.settings.problem, deps.state.problem].filter((problem): problem is string => !!problem);
    },
    'settings.get': () => deps.settings.load(),
    'settings.setTheme': async ({ theme }) => {
      const next = await deps.settings.update(current => ({ ...current, theme }));
      deps.applyTheme(next.theme);
      return next;
    },
    'settings.pickCliPath': async ({ provider }) => {
      const file = await deps.pickExecutable(provider);
      return file ? deps.settings.update(current => setCliPath(current, provider, file)) : deps.settings.load();
    },
    'settings.clearCliPath': ({ provider }) => deps.settings.update(current => setCliPath(current, provider, undefined)),
    'state.get': () => deps.state.load(),
    'state.setSidebarOpen': ({ open }) => deps.state.update(current => ({ ...current, sidebarOpen: open })),
    'projects.pick': async () => {
      const folder = await deps.pickFolder();
      if (!folder) return { state: await deps.state.load() };
      const state = await deps.state.update(current => addProject(current, folder));
      return { state, picked: projectFor(state, folder)?.id };
    },
    'projects.remove': ({ id }) => deps.state.update(current => removeProject(current, id)),
  };
}
