import type { AppSettings, AppState, CliProvider, HydraConnection, HydraTreeMessage, OnboardingReport, Project, HydraControl, HydraStopState, UpdateStatusView } from '../shared/ipc';
import type { BrowserPanel } from './browserPanel';
import type { AppTerminals } from './terminals';
import type { ShellTabs } from './shellTabs';
import { repoUrlProblem } from './clone';
import type { ChatManager } from './chats';
import type { ThemeSetting } from '../shared/theme';
import type { Handlers } from './ipc';
import { addProject, cleanDisplayName, projectFor, removeProject, setCliPath, trustProject, type JsonStore } from './settings';

export interface HandlerDeps {
  /** Windows' full name for the signed-in account (Get-LocalUser), for the sidebar; undefined when it has none. */
  fullName?(): Promise<string | undefined>;
  /** A chat's PR bar: gh's view of a pull request (pullRequests.ts). */
  pullRequest?(url: string): Promise<import('../shared/ipc').PullRequestInfo>;
  info: { name: string; version: string; electron: string; platform: string; user?: string };
  settings: JsonStore<AppSettings>;
  state: JsonStore<AppState>;
  /** Main's own folder picker (for a project, or where a clone goes). Undefined when the user cancels. */
  pickFolder(purpose?: 'project' | 'clone'): Promise<string | undefined>;
  /** Hydra in the app (app/src/main/hydra.ts): its connections to the CLIs, and each project's heads and plans. */
  hydra?: {
    connections(): Promise<HydraConnection[]>;
    connect(provider: CliProvider): Promise<HydraConnection[]>;
    disconnect(provider: CliProvider): Promise<HydraConnection[]>;
    tree(): HydraTreeMessage[];
    /** A message from the project's Agents view: its controller starts if needed, then handles it. */
    agents(project: Project, message: unknown): Promise<void>;
    /** The Agents view's controls (stop state, Stop all, Resume, audit log). */
    control(project: Project, action: HydraControl): Promise<HydraStopState>;
    /** The window's answer to one of Hydra's questions (hostUi.ts drops one that isn't pending). */
    reply(requestId: string, value: unknown): void;
  };
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
  /** The window's terminals (G7's Continue here). */
  terminals?: Pick<AppTerminals, 'write' | 'resize' | 'close' | 'start'>;
  /** The terminal panel's tabs per chat, kept in main (the user's and the chat's agent's). */
  shellTabs?: Pick<ShellTabs, 'openForUser' | 'closeById' | 'list' | 'resize'>;
  /** Claude Code's slash commands for a trusted folder (claudeCommands.ts). */
  claudeCommands?(cwd: string): Promise<Array<{ name: string; description?: string; argumentHint?: string; builtin?: boolean }>>;
  /** The browser panel beside a chat. */
  browser?: Pick<BrowserPanel, 'open' | 'navigate' | 'setBounds' | 'back' | 'forward' | 'reload' | 'close'>;
  chats: Pick<ChatManager, 'list' | 'create' | 'prepare' | 'open' | 'send' | 'answer' | 'stop' | 'configure' | 'remove' | 'closeFolder' | 'openTerminal' | 'shellFolder' | 'terminalClosed' | 'reviewFolder' | 'setWhere' | 'continueCloud' | 'rename' | 'archive'>;
  review?: { diff(cwd: string): Promise<import('../shared/ipc').ReviewResult>; branch(cwd: string): Promise<import('../shared/ipc').BranchSummary | undefined>; changed(cwd: string): Promise<string[]>; open(cwd: string, path: string): Promise<'editor' | 'folder'> };
  /** In-app updates (app/src/main/updates.ts). A manual check shows main's own dialogs. */
  updates?: { status(): Promise<UpdateStatusView>; check(manual: boolean): Promise<void>; setAutomatic(on: boolean): Promise<UpdateStatusView> };
}

const noUpdates = (version: string): UpdateStatusView => ({ available: false, reason: "Updates aren't set up in this copy of Hydra.", automatic: false, busy: false, version });

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
  const requireHydra = () => { if (!deps.hydra) throw new Error('Hydra isn\'t available here.'); return deps.hydra; };
  const requireBrowser = () => { if (!deps.browser) throw new Error('The browser isn\'t available here.'); return deps.browser; };
  return {
    // The account's full name from Windows ("Nico D"), once asked; the folder name ("ndunl") until then or without one.
    'app.info': async () => { const full = await deps.fullName?.().catch(() => undefined); return full ? { ...deps.info, user: full } : deps.info; },
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
    'settings.setDisplayName': async ({ name }) => {
      const clean = cleanDisplayName(name);
      if (name.trim() && !clean) throw new Error('A name is one line of at most 60 characters.');
      return deps.settings.update(current => { const { displayName: _old, ...rest } = current; return clean ? { ...rest, displayName: clean } : rest; });
    },
    'settings.pickCliPath': async ({ provider }) => {
      const file = await deps.pickExecutable(provider);
      return file ? deps.settings.update(current => setCliPath(current, provider, file)) : deps.settings.load();
    },
    'settings.clearCliPath': ({ provider }) => deps.settings.update(current => setCliPath(current, provider, undefined)),
    'state.get': () => deps.state.load(),
    'state.setSidebarOpen': ({ open }) => deps.state.update(current => ({ ...current, sidebarOpen: open })),
    'updates.status': () => deps.updates ? deps.updates.status() : Promise.resolve(noUpdates(deps.info.version)),
    'updates.check': async () => { if (!deps.updates) return noUpdates(deps.info.version); await deps.updates.check(true); return deps.updates.status(); },
    'updates.setAutomatic': ({ on }) => deps.updates ? deps.updates.setAutomatic(on) : Promise.resolve(noUpdates(deps.info.version)),
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
    'chats.prepare': async ({ projectId, ...rest }) => {
      // Only a folder the user trusted in Hydra: starting the agent there runs the project's hooks.
      const project = (await deps.state.load()).projects.find(candidate => candidate.id === projectId);
      if (!project?.trustedAt) return null;
      // As opening a chat does: the project's Hydra starts first, so the agent's hydra tools find it.
      deps.projectOpened?.(project.path);
      await deps.chats.prepare({ cwd: project.path, ...rest });
      return null;
    },
    'chats.open': async ({ id, background }) => {
      const opened = await deps.chats.open(id, { warm: !background });
      if (!background) deps.projectOpened?.(opened.record.cwd);
      return opened;
    },
    'chats.send': async ({ id, text, images }) => { await deps.chats.send(id, text, images); return null; },
    'chats.openTerminal': ({ id }) => deps.chats.openTerminal(id),
    'chats.setWhere': ({ id, where }) => deps.chats.setWhere(id, where),
    'chats.continueCloud': ({ id }) => deps.chats.continueCloud(id),
    'terminal.write': ({ id, data }) => { deps.terminals?.write(id, data); return null; },
    'terminal.resize': ({ id, cols, rows }) => { deps.terminals?.resize(id, cols, rows); deps.shellTabs?.resize(id, cols, rows); return null; },
    'terminal.close': ({ id }) => { deps.shellTabs?.closeById(id); deps.terminals?.close(id); return null; },
    'terminal.shell': async ({ chatId }) => {
      // Only in the folder of a chat the user trusted, as a chat runs there; the window names the chat, never a path.
      if (!deps.shellTabs) throw new Error("Hydra can't open a terminal here.");
      return { id: await deps.shellTabs.openForUser(chatId) };
    },
    'terminal.tabs': ({ chatId }) => deps.shellTabs?.list(chatId) ?? [],
    'chats.commands': async ({ projectId }) => {
      // Only in a folder the user trusted: starting Claude Code there runs the project's hooks.
      const project = (await deps.state.load()).projects.find(candidate => candidate.id === projectId);
      if (!project?.trustedAt || !deps.claudeCommands) return [];
      return deps.claudeCommands(project.path);
    },
    'chats.pullRequest': ({ url }) => { if (!deps.pullRequest) throw new Error("Pull requests can't be read here."); return deps.pullRequest(url); },
    'browser.open': ({ url }) => requireBrowser().open(url),
    'browser.navigate': ({ url }) => requireBrowser().navigate(url),
    'browser.bounds': bounds => { deps.browser?.setBounds(bounds); return null; },
    'browser.back': () => { deps.browser?.back(); return null; },
    'browser.forward': () => { deps.browser?.forward(); return null; },
    'browser.reload': () => { deps.browser?.reload(); return null; },
    'browser.close': () => { deps.browser?.close(); return null; },
    'review.diff': async ({ id }) => {
      if (!deps.review) throw new Error('Review isn\'t available here.');
      return deps.review.diff(await deps.chats.reviewFolder(id));
    },
    'review.branch': async ({ id }) => {
      if (!deps.review) return null;
      return (await deps.review.branch(await deps.chats.reviewFolder(id))) ?? null;
    },
    'review.open': async ({ id, path }) => {
      if (!deps.review) throw new Error('Review isn\'t available here.');
      const cwd = await deps.chats.reviewFolder(id);
      // Only a file the diff lists right now can be opened.
      if (!(await deps.review.changed(cwd)).includes(path)) throw new Error('That file isn\'t among this folder\'s changes.');
      return { opened: await deps.review.open(cwd, path) };
    },
    'hydra.connections': () => requireHydra().connections(),
    'hydra.connect': ({ provider }) => requireHydra().connect(provider),
    'hydra.disconnect': ({ provider }) => requireHydra().disconnect(provider),
    'hydra.tree': async () => deps.hydra?.tree() ?? [],
    'hydra.control': async ({ projectId, action }) => {
      const project = (await deps.state.load()).projects.find(candidate => candidate.id === projectId);
      if (!project) throw new Error('No such project.');
      if (!project.trustedAt) return { running: false, stopped: false };
      return requireHydra().control(project, action);
    },
    'hydra.reply': async ({ requestId, value }) => { requireHydra().reply(requestId, value); return null; },
    'hydra.agents': async ({ projectId, message }) => {
      const project = (await deps.state.load()).projects.find(candidate => candidate.id === projectId);
      if (!project) throw new Error('No such project.');
      if (!project.trustedAt) throw new Error('Trust this project first: Hydra runs nothing in a folder you haven\'t trusted.');
      await requireHydra().agents(project, message);
      return null;
    },
    'chats.terminalClosed': ({ id }) => { deps.chats.terminalClosed(id); return null; },
    'chats.answer': ({ id, requestId, answer }) => { deps.chats.answer(id, requestId, answer); return null; },
    'chats.stop': ({ id }) => { deps.chats.stop(id); return null; },
    'chats.configure': ({ id, change }) => deps.chats.configure(id, change),
    'chats.remove': async ({ id }) => { await deps.chats.remove(id); return null; },
    'chats.rename': ({ id, title }) => deps.chats.rename(id, title),
    'chats.archive': ({ id, archived }) => deps.chats.archive(id, archived),
    'onboarding.check': ({ refresh }) => checkSetup(refresh),
    'onboarding.signIn': async ({ provider }) => {
      // One sign-in per provider at a time: a page can't stack browser logins.
      if (signingIn.has(provider)) return { signedIn: false, error: 'Signing in already: finish in your browser.' };
      signingIn.add(provider);
      try { return await deps.signIn(provider, (await deps.settings.load()).cliPaths[provider]); } finally { signingIn.delete(provider); }
    },
  };
}
