import type { AppSettings, AppState, CliProvider, OnboardingReport, Project } from '../shared/ipc';
import type { ChatManager } from './chats';
import type { ThemeSetting } from '../shared/theme';
import type { Handlers } from './ipc';
import { addProject, projectFor, removeProject, setCliPath, trustProject, type JsonStore } from './settings';

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
  /** Main's own confirm before a folder may run chats. True only when the user chose to trust it. */
  confirmTrust(project: Project): Promise<boolean>;
  chats: Pick<ChatManager, 'list' | 'create' | 'open' | 'send' | 'answer' | 'stop' | 'configure' | 'remove' | 'closeFolder' | 'openTerminal' | 'terminalClosed'>;
}

/** What main does for each channel. Paths only ever come from main's own pickers, never from the renderer. */
export function createHandlers(deps: HandlerDeps): Handlers {
  // One check at a time, remembered until a refresh or a change of CLI path.
  let report: { key: string; value: Promise<OnboardingReport> } | undefined;
  let running: Promise<OnboardingReport> | undefined;
  let followUp: Promise<OnboardingReport> | undefined;
  const begin = (key: string, cliPaths: AppSettings['cliPaths']): Promise<OnboardingReport> => {
    const value = deps.checkSetup(cliPaths);
    report = { key, value };
    running = value;
    value.then(() => { if (running === value) running = undefined; }, () => { if (running === value) running = undefined; if (report?.value === value) report = undefined; });
    return value;
  };
  const checkSetup = async (refresh: boolean) => {
    const { cliPaths } = await deps.settings.load();
    const key = JSON.stringify(cliPaths);
    if (running && report?.key === key) {
      if (!refresh) return running;
      // A refresh while a check runs gets one fresh check after it, shared by every refresh that arrives meanwhile, so
      // its answer is never older than the click and a page can't start more than one extra set of processes.
      followUp ??= running.catch(() => undefined).then(() => { followUp = undefined; return begin(key, cliPaths); });
      return followUp;
    }
    if (refresh || !report || report.key !== key) return begin(key, cliPaths);
    return report.value;
  };
  // One sign-in window per provider every few seconds, so a page can't stack them up.
  const lastSignIn = new Map<CliProvider, number>();
  const SIGN_IN_GAP_MS = 5000;
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
    'projects.remove': async ({ id }) => {
      const project = (await deps.state.load()).projects.find(candidate => candidate.id === id);
      const next = await deps.state.update(current => removeProject(current, id));
      // A folder that is no longer a project runs nothing: its chats' processes end now.
      if (project) await deps.chats.closeFolder?.(project.path);
      return next;
    },
    'projects.trust': async ({ id }) => {
      const project = (await deps.state.load()).projects.find(candidate => candidate.id === id);
      if (!project) throw new Error('No such project.');
      if (project.trustedAt) return deps.state.load();
      return (await deps.confirmTrust(project)) ? deps.state.update(current => trustProject(current, id)) : deps.state.load();
    },
    'chats.list': () => deps.chats.list(),
    'chats.create': async ({ projectId, ...rest }) => {
      const project = (await deps.state.load()).projects.find(candidate => candidate.id === projectId);
      if (!project) throw new Error('No such project.');
      return deps.chats.create({ cwd: project.path, ...rest });
    },
    'chats.open': ({ id }) => deps.chats.open(id),
    'chats.send': async ({ id, text, images }) => { await deps.chats.send(id, text, images); return null; },
    'chats.openTerminal': ({ id }) => deps.chats.openTerminal(id),
    'chats.terminalClosed': ({ id }) => { deps.chats.terminalClosed(id); return null; },
    'chats.answer': ({ id, requestId, answer }) => { deps.chats.answer(id, requestId, answer); return null; },
    'chats.stop': ({ id }) => { deps.chats.stop(id); return null; },
    'chats.configure': ({ id, change }) => deps.chats.configure(id, change),
    'chats.remove': async ({ id }) => { await deps.chats.remove(id); return null; },
    'onboarding.check': ({ refresh }) => checkSetup(refresh),
    'onboarding.signIn': async ({ provider }) => {
      const now = Date.now();
      if (now - (lastSignIn.get(provider) ?? -Infinity) < SIGN_IN_GAP_MS) return { started: false, error: 'A sign-in window was just opened; finish there.' };
      lastSignIn.set(provider, now);
      const result = await deps.signIn(provider, (await deps.settings.load()).cliPaths[provider]);
      // Only an opened window uses up the slot; a failed try can be retried at once.
      if (!result.started) lastSignIn.delete(provider);
      return result;
    },
  };
}
