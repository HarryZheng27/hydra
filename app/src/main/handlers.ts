import type { AppSettings, AppState, CliProvider, OnboardingReport } from '../shared/ipc';
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
  /** Onboarding's version and help checks, and the registration lookup, for these CLI paths. */
  checkSetup(cliPaths: AppSettings['cliPaths']): Promise<OnboardingReport>;
  /** Opens the CLI's own sign-in in a console window. */
  signIn(provider: CliProvider, configured: string | undefined): Promise<{ started: boolean; error?: string }>;
}

/** What main does for each channel. Paths only ever come from main's own pickers, never from the renderer. */
export function createHandlers(deps: HandlerDeps): Handlers {
  // One check at a time, remembered until a refresh or a change of CLI path.
  let report: { key: string; value: Promise<OnboardingReport> } | undefined;
  const checkSetup = async (refresh: boolean) => {
    const { cliPaths } = await deps.settings.load();
    const key = JSON.stringify(cliPaths);
    if (refresh || !report || report.key !== key) {
      const value = deps.checkSetup(cliPaths);
      report = { key, value };
      value.catch(() => { if (report?.value === value) report = undefined; });
    }
    return report.value;
  };
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
    'onboarding.check': ({ refresh }) => checkSetup(refresh),
    'onboarding.signIn': async ({ provider }) => deps.signIn(provider, (await deps.settings.load()).cliPaths[provider]),
  };
}
