import type { AppSettings, AppState, CliProvider, OnboardingReport, Project } from '../shared/ipc';
import { repoUrlProblem } from './clone';
import type { ChatManager } from './chats';
import type { ThemeSetting } from '../shared/theme';
import type { Handlers } from './ipc';
import { addProject, projectFor, removeProject, setCliPath, trustProject, type JsonStore } from './settings';

export interface HandlerDeps {
  info: { name: string; version: string; electron: string; platform: string };
  settings: JsonStore<AppSettings>;
  state: JsonStore<AppState>;
  /** Main's own folder picker (for a project, or where a clone goes). Undefined when the user cancels. */
  pickFolder(purpose?: 'project' | 'clone'): Promise<string | undefined>;
  /** The projects changed (one trusted or removed): Hydra starts or stops its controllers (app/src/main/hydra.ts). */
  projectsChanged?(state: AppState): void;
  /** A chat in this folder was created or opened: Hydra starts its project's controller (app/src/main/hydra.ts). */
  projectOpened?(cwd: string): void;
  /** Clones a repository into a new folder under `parent`, returning it (app/src/main/clone.ts). */
  cloneRepo?(url: string, parent: string): Promise<string>;
  /** Main's own file picker for a provider's command-line tool. Undefined when the user cancels. */
  pickExecutable(provider: CliProvider): Promise<string | undefined>;
  /** Applies a theme setting to the window: the native theme and the title bar. */
  applyTheme(theme: ThemeSetting): void;
  /** Onboarding's version and help checks, and the registration lookup, for these CLI paths. */
  checkSetup(cliPaths: AppSettings['cliPaths']): Promise<OnboardingReport>;
  /** The CLI's own sign-in, out of sight in the browser; resolves when it ends. */
  signIn(provider: CliProvider, configured: string | undefined): Promise<{ signedIn: boolean; error?: string }>;
  /** Main's own confirm before a folder may run chats. True only when the user chose to trust it. */
  confirmTrust(project: Project): Promise<boolean>;
  chats: Pick<ChatManager, 'list' | 'create' | 'open' | 'send' | 'answer' | 'stop' | 'configure' | 'remove' | 'closeFolder' | 'openTerminal' | 'terminalClosed' | 'reviewFolder'>;
  review?: { diff(cwd: string): Promise<import('../shared/ipc').ReviewResult>; changed(cwd: string): Promise<string[]>; open(cwd: string, path: string): Promise<'editor' | 'folder'> };
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
  // One sign-in per provider at a time, so a page can't stack up browser logins.
  const signingIn = new Set<CliProvider>();
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
    'projects.clone': async ({ url }) => {
      if (!deps.cloneRepo) throw new Error('Cloning isn\'t available here.');
      const problem = repoUrlProblem(url);
      if (problem) throw new Error(problem);
      const parent = await deps.pickFolder('clone');
      if (!parent) return { state: await deps.state.load() };
      const folder = await deps.cloneRepo(url, parent);
      const state = await deps.state.update(current => addProject(current, folder));
      return { state, picked: projectFor(state, folder)?.id };
    },
    'projects.remove': async ({ id }) => {
      const project = (await deps.state.load()).projects.find(candidate => candidate.id === id);
      const next = await deps.state.update(current => removeProject(current, id));
      // A folder that is no longer a project runs nothing: its chats' processes end now.
      if (project) await deps.chats.closeFolder?.(project.path);
      deps.projectsChanged?.(next);
      return next;
    },
    'projects.trust': async ({ id }) => {
      const project = (await deps.state.load()).projects.find(candidate => candidate.id === id);
      if (!project) throw new Error('No such project.');
      if (project.trustedAt) return deps.state.load();
      if (!(await deps.confirmTrust(project))) return deps.state.load();
      const next = await deps.state.update(current => trustProject(current, id));
      deps.projectsChanged?.(next);
      // The user is in this project now: its controller starts.
      deps.projectOpened?.(project.path);
      return next;
    },
    'chats.list': () => deps.chats.list(),
    'chats.create': async ({ projectId, ...rest }) => {
      const project = (await deps.state.load()).projects.find(candidate => candidate.id === projectId);
      if (!project) throw new Error('No such project.');
      const created = await deps.chats.create({ cwd: project.path, ...rest });
      deps.projectOpened?.(project.path);
      return created;
    },
    'chats.open': async ({ id, background }) => {
      const opened = await deps.chats.open(id, { warm: !background });
      if (!background) deps.projectOpened?.(opened.record.cwd);
      return opened;
    },
    'chats.send': async ({ id, text, images }) => { await deps.chats.send(id, text, images); return null; },
    'chats.openTerminal': ({ id }) => deps.chats.openTerminal(id),
    'review.diff': async ({ id }) => {
      if (!deps.review) throw new Error('Review isn\'t available here.');
      return deps.review.diff(await deps.chats.reviewFolder(id));
    },
    'review.open': async ({ id, path }) => {
      if (!deps.review) throw new Error('Review isn\'t available here.');
      const cwd = await deps.chats.reviewFolder(id);
      // Only a file the diff lists right now can be opened.
      if (!(await deps.review.changed(cwd)).includes(path)) throw new Error('That file isn\'t among this folder\'s changes.');
      return { opened: await deps.review.open(cwd, path) };
    },
    'chats.terminalClosed': ({ id }) => { deps.chats.terminalClosed(id); return null; },
    'chats.answer': ({ id, requestId, answer }) => { deps.chats.answer(id, requestId, answer); return null; },
    'chats.stop': ({ id }) => { deps.chats.stop(id); return null; },
    'chats.configure': ({ id, change }) => deps.chats.configure(id, change),
    'chats.remove': async ({ id }) => { await deps.chats.remove(id); return null; },
    'onboarding.check': ({ refresh }) => checkSetup(refresh),
    'onboarding.signIn': async ({ provider }) => {
      // One sign-in per provider at a time: a page can't stack browser logins.
      if (signingIn.has(provider)) return { signedIn: false, error: 'Signing in already: finish in your browser.' };
      signingIn.add(provider);
      try { return await deps.signIn(provider, (await deps.settings.load()).cliPaths[provider]); } finally { signingIn.delete(provider); }
    },
  };
}
