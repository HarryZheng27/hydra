/**
 * The app's IPC contract: one Electron channel, carrying `{ channel, payload }` calls named here. The preload exposes
 * a typed function per channel and nothing else; main checks the sender, the channel and the payload of every call
 * before it runs (app/src/main/ipc.ts). This file is shared by main, preload and renderer, so it imports only types.
 */
import type { ChatAnswer, ChatEvent, ChatImage, ChatModel, ChatProvider, ClaudePermissionMode, CodexApprovals, CodexSandbox } from '../../../src/core/chat/events';
import type { ChatRecord, LogEntry } from '../../../src/core/chat/store';
import type { ThemeSetting } from './theme';

export type { ChatAnswer, ChatEvent, ChatImage, ChatModel, ChatProvider, ChatRecord, ClaudePermissionMode, CodexApprovals, CodexSandbox, LogEntry };

export const IPC_TRANSPORT = 'hydra:call';
/** The one channel main pushes on: a chat's new events. The preload exposes a listener for it and nothing else. */
export const CHAT_EVENTS = 'hydra:chat-events';
/** A terminal in the window (G7's Continue here): its output, or that it ended. */
export const TERMINAL = 'hydra:terminal';
export interface TerminalMessage { id: string; data?: string; exit?: number }
/** The browser panel beside a chat: what its toolbar shows. */
export const BROWSER = 'hydra:browser';
export interface BrowserState { open: boolean; url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean }
/** Push: one project's heads and plans changed (G5). */
export const HYDRA_TREE = 'hydra:tree';
/** Push: a message from a project's controller to its Agents view (the IDE webview's own messages, G5). */
export const HYDRA_UI = 'hydra:ui';
export interface HydraUiMessage { projectId: string; message: unknown }
/** Push: Hydra's own questions, notices and read-only documents for the window (main/hostUi.ts, G5). */
export const HYDRA_HOST = 'hydra:host';
export interface HydraPickItemView { label: string; description: string; detail: string; picked: boolean }
export interface HydraViewImage { alt: string; src: string }
/** The Agents view's own controls (G5 milestone 4). */
export type HydraControl = 'stopState' | 'stopAll' | 'resume' | 'auditLog' | 'settings' | 'allProjects';
/** Whether Hydra runs in a project and, if so, whether Stop all has stopped it. */
export interface HydraStopState { running: boolean; stopped: boolean; since?: string; reason?: string }
export type HydraHostMessage =
  | { kind: 'pick'; requestId: string; projectId: string; title: string; placeHolder: string; items: HydraPickItemView[]; many: boolean; error?: string }
  | { kind: 'input'; requestId: string; projectId: string; title: string; prompt: string; placeHolder: string; value: string; error?: string }
  | { kind: 'notice'; requestId?: string; projectId: string; level: 'info' | 'warning' | 'error'; message: string; actions: string[]; error?: string }
  | { kind: 'view'; projectId: string; title: string; format: 'text' | 'markdown' | 'diff'; content: string; images: HydraViewImage[] }
  | { kind: 'dismiss'; requestId: string }
  /** Main asks the window to show a project (Show All Projects), or the app's own Settings. */
  | { kind: 'navigate'; projectId?: string; to: 'project' | 'settings' };

/** A head as a chat card shows it: no paths, no logs, nothing a page could act on beyond its id. */
export interface HeadCardView {
  id: string; title: string; state: string; provider: string; progress?: string; question?: string; summary?: string;
  branch?: string; changedFiles: number; merged?: boolean; checks: { id: string; passed: boolean; state: string; required: boolean }[];
  /** The chat session that started it (Claude's session id or Codex's thread id). */
  leadSessionId?: string;
}
export interface PlanCardView {
  id: string; title: string; state: string; error?: string; leadSessionId?: string;
  jobs: { key: string; title: string; status: string; reason?: string }[];
}
/** One project's heads and plans, as its controller last published them. */
export interface HydraTreeMessage {
  projectId: string; heads: HeadCardView[]; plans: PlanCardView[];
  /** Whether Hydra runs here: this app owns the project, or another Hydra (the IDE) does and it runs there. */
  owned: boolean;
  error?: string;
}
/** One CLI's `hydra` entry: Hydra's own here, another Hydra's (still installed), or none. */
export interface HydraConnection {
  provider: CliProvider; name: string; connected: boolean;
  /** Points at this app. */
  current: boolean;
  /** For another Hydra's entry: whether what it runs is still installed (then it works here too). */
  targetExists?: boolean;
  error?: string;
}
/** `start` is the first event's position in the chat's log (-1 for a notice that isn't in the log). */
export interface ChatEventsMessage { chatId: string; events: ChatEvent[]; start: number }
/** The user's own CLI defaults (model, effort, mode), which the composer shows when a chat doesn't choose its own. */
export interface ChatDefaults { model?: string; effort?: string; mode?: string; approvals?: string }
export interface OpenChat { record: ChatRecord; log: LogEntry[]; running: boolean; inTerminal: boolean; defaults: ChatDefaults }
export interface NewChatRequest { projectId: string; provider: ChatProvider; model?: string; effort?: string; permissionMode?: ClaudePermissionMode; sandbox?: CodexSandbox; approvals?: CodexApprovals; where?: 'cloud' }
export interface ReviewFile { path: string; status: 'added' | 'modified' | 'deleted' | 'untracked' | 'changed'; original: string; modified: string; skipped?: string }
export interface ReviewResult { files: ReviewFile[]; truncated: boolean; error?: string }
export interface ChatSettingsChange { model?: string; effort?: string; permissionMode?: ClaudePermissionMode; sandbox?: CodexSandbox; approvals?: CodexApprovals }

export type CliProvider = 'claude' | 'codex';
export interface AppInfo { name: string; version: string; electron: string; platform: string }
/** In-app updates: `available` is false for a preview or development copy, with the reason. */
export interface UpdateStatusView { available: boolean; reason?: string; automatic: boolean; busy: boolean; version: string }
/** Preferences, in settings.json. CLI paths are machine-only: set from main's file picker, never from a project. */
export interface AppSettings { version: 1; theme: ThemeSetting; cliPaths: Partial<Record<CliProvider, string>> }
/** A folder the user picked. `trustedAt` is set once the user agreed, in main's own confirm, that chats may run there. */
export interface Project { id: string; path: string; name: string; trustedAt?: string }
/** What the CLI says about the user's sign-in: only this, never who they are. */
export type AccountStatus = 'signed-in' | 'signed-out' | 'other' | 'unknown';
/** One provider CLI, as onboarding found it: its version, help and sign-in status checks. */
export interface ProviderStatus {
  provider: CliProvider; name: string; found: boolean; executable?: string; configured: boolean;
  version?: string; supported: boolean; minimum: string; requirement: string; advertised?: string[]; error?: string; account?: AccountStatus;
}
/** Whether the user-level `hydra` MCP server is registered with a CLI, read from its config file. */
export interface RegistrationStatus { registered: boolean; where: string; error?: string }
export interface OnboardingReport { providers: ProviderStatus[]; registration: Record<CliProvider, RegistrationStatus>; checkedAt: string }

/** The sidebar and the projects, in state.json. */
export interface AppState { version: 1; sidebarOpen: boolean; projects: Project[] }

/** Every call the renderer can make: its payload and its result. */
export interface Channels {
  'app.info': { payload: null; result: AppInfo };
  /** Anything that went wrong loading the stores, for the app to show. */
  'app.problems': { payload: null; result: string[] };
  'settings.get': { payload: null; result: AppSettings };
  'settings.setTheme': { payload: { theme: ThemeSetting }; result: AppSettings };
  /** Main shows a file picker; the renderer never sends a path. */
  'settings.pickCliPath': { payload: { provider: CliProvider }; result: AppSettings };
  'settings.clearCliPath': { payload: { provider: CliProvider }; result: AppSettings };
  'state.get': { payload: null; result: AppState };
  'state.setSidebarOpen': { payload: { open: boolean }; result: AppState };
  /** In-app updates (G6): whether this copy updates itself, the daily check, and a check now (main shows its own dialogs). */
  'updates.status': { payload: null; result: UpdateStatusView };
  'updates.check': { payload: null; result: UpdateStatusView };
  'updates.setAutomatic': { payload: { on: boolean }; result: UpdateStatusView };
  /** Main shows a folder picker; the renderer never sends a path. `picked` is the chosen folder's project, new or not. */
  'projects.pick': { payload: null; result: { state: AppState; picked?: string } };
  /** Clones a repository URL into a folder main asks for, and adds it as a project. */
  'projects.clone': { payload: { url: string }; result: { state: AppState; picked?: string } };
  'projects.remove': { payload: { id: string }; result: AppState };
  /** Runs the version and help checks (again, with refresh) and reads the registrations. */
  'onboarding.check': { payload: { refresh: boolean }; result: OnboardingReport };
  /** Resolves when the sign-in in the browser finishes, fails or times out. */
  'onboarding.signIn': { payload: { provider: CliProvider }; result: { signedIn: boolean; error?: string } };
  /** Main asks, in its own dialog, before a folder may run chats; the page only names the project. */
  'projects.trust': { payload: { id: string }; result: AppState };
  'chats.list': { payload: null; result: ChatRecord[] };
  'chats.create': { payload: NewChatRequest; result: ChatRecord };
  'chats.open': { payload: { id: string; background?: boolean }; result: OpenChat };
  'chats.send': { payload: { id: string; text: string; images?: ChatImage[] }; result: null };
  /** The CLI's own interactive resume of the chat, in a console window Hydra never reads. */
  'chats.openTerminal': { payload: { id: string }; result: { started: boolean; error?: string } };
  /** G7: Local or Cloud, before a Claude chat's first message; and Continue here for a cloud chat. */
  'chats.setWhere': { payload: { id: string; where: 'local' | 'cloud' }; result: ChatRecord };
  'chats.continueCloud': { payload: { id: string }; result: { started: boolean; worktree?: string; error?: string; terminalId?: string } };
  /** A terminal main started in the window: the window's keys, its size, and closing it. None can be started from here. */
  'terminal.write': { payload: { id: string; data: string }; result: null };
  'terminal.resize': { payload: { id: string; cols: number; rows: number }; result: null };
  'terminal.close': { payload: { id: string }; result: null };
  /** The browser panel (Claude desktop's globe): http(s) pages only, in a session of its own (browserPanel.ts). */
  'browser.open': { payload: { url?: string }; result: BrowserState };
  'browser.navigate': { payload: { url: string }; result: BrowserState };
  'browser.bounds': { payload: { x: number; y: number; width: number; height: number }; result: null };
  'browser.back': { payload: null; result: null };
  'browser.forward': { payload: null; result: null };
  'browser.reload': { payload: null; result: null };
  'browser.close': { payload: null; result: null };
  /** The chat folder's working tree against HEAD, read-only. */
  'review.diff': { payload: { id: string }; result: ReviewResult };
  /** Opens one of the changed files in an editor, or shows it in its folder. The path must be in the current diff. */
  'review.open': { payload: { id: string; path: string }; result: { opened: 'editor' | 'folder' } };
  /** Hydra's connection to Claude Code and Codex (Settings, Connectors), and Connect / Disconnect (G5). */
  'hydra.connections': { payload: null; result: HydraConnection[] };
  'hydra.connect': { payload: { provider: CliProvider }; result: HydraConnection[] };
  'hydra.disconnect': { payload: { provider: CliProvider }; result: HydraConnection[] };
  /** A message from a project's Agents view to its controller (src/core/model.ts ClientMessage; the controller checks it). */
  'hydra.agents': { payload: { projectId: string; message: unknown }; result: null };
  /** The Agents view's controls: the stop state, Stop all (asks first), Resume, and the audit log. */
  'hydra.control': { payload: { projectId: string; action: HydraControl }; result: HydraStopState };
  /** The window's answer to one of Hydra's questions (HYDRA_HOST): an item's index, indexes, text, an action, or null to dismiss. */
  'hydra.reply': { payload: { requestId: string; value: number | number[] | string | null }; result: null };
  /** Every running project's heads and plans, for a page that just opened. */
  'hydra.tree': { payload: null; result: HydraTreeMessage[] };
  /** The user closed the terminal they opened the chat in: it can run in the app again. */
  'chats.terminalClosed': { payload: { id: string }; result: null };
  'chats.answer': { payload: { id: string; requestId: string; answer: ChatAnswer }; result: null };
  'chats.stop': { payload: { id: string }; result: null };
  'chats.configure': { payload: { id: string; change: ChatSettingsChange }; result: ChatRecord };
  'chats.remove': { payload: { id: string }; result: null };
  /** The sidebar's chat menu: Rename and Archive (Delete is chats.remove). */
  'chats.rename': { payload: { id: string; title: string }; result: ChatRecord };
  'chats.archive': { payload: { id: string; archived: boolean }; result: ChatRecord };
}
export type Channel = keyof Channels;
export type Payload<C extends Channel> = Channels[C]['payload'];
export type Result<C extends Channel> = Channels[C]['result'];

type Validator<T> = (value: unknown) => value is T;
const isNull: Validator<null> = (value): value is null => value === null;
/** A plain object with exactly these keys, each passing its check. */
function exactly<T>(checks: { [K in keyof T]: (value: unknown) => boolean }): Validator<T> {
  const keys = Object.keys(checks);
  return (value): value is T => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const own = Object.keys(record);
    return own.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(record, key) && (checks as Record<string, (v: unknown) => boolean>)[key]!(record[key]));
  };
}
const oneOf = (...allowed: unknown[]) => (value: unknown): boolean => allowed.includes(value);
const isProvider = oneOf('claude', 'codex');
const isId = (value: unknown): boolean => typeof value === 'string' && /^[0-9a-f-]{8,64}$/.test(value);
const isRecordValue = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** A plain object whose keys are all known, with the required ones present and each passing its check. */
function shaped<T>(required: Record<string, (value: unknown) => boolean>, optional: Record<string, (value: unknown) => boolean> = {}): Validator<T> {
  return (value): value is T => {
    if (!isRecordValue(value)) return false;
    for (const key of Object.keys(value)) if (!(key in required) && !(key in optional)) return false;
    for (const [key, check] of Object.entries(required)) if (!Object.prototype.hasOwnProperty.call(value, key) || !check(value[key])) return false;
    for (const [key, check] of Object.entries(optional)) if (Object.prototype.hasOwnProperty.call(value, key) && !check(value[key])) return false;
    return true;
  };
}
/** A position or size in the window's CSS pixels. */
const isPixels = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 20_000;
const isText = (max: number) => (value: unknown): boolean => typeof value === 'string' && value.length <= max;
const isModel = (value: unknown): boolean => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,79}$/.test(value);
/** An effort word; each CLI checks it against its own list (Codex models offer `ultra`, for one). */
const isEffort = (value: unknown): boolean => typeof value === 'string' && /^[a-z]{1,20}$/.test(value);
const isPermissionMode = oneOf('settings', 'auto', 'default', 'acceptEdits', 'plan');
const isApprovals = oneOf('settings', 'ask');
/** At most four images, each a known type and at most 5 MB of base64, Claude's own limit (main checks the bytes too). */
const isImages = (value: unknown): boolean => Array.isArray(value) && value.length <= 4 && value.every(image => shaped({ mediaType: oneOf('image/png', 'image/jpeg', 'image/gif', 'image/webp'), data: (data: unknown) => typeof data === 'string' && data.length <= 5 * 1024 * 1024 })(image));
/**
 * Codex chats are read-only for now: write access waits for its live check (codexWriteVerified), and full access is
 * excluded in v1.
 */
const isSandbox = oneOf('read-only');
const isRequestId = (value: unknown): boolean => typeof value === 'string' && /^[\x21-\x7e]{1,200}$/.test(value);
/** An edited tool input: a JSON object of at most 1 MB. */
const isToolInput = (value: unknown): boolean => { if (!isRecordValue(value)) return false; try { return JSON.stringify(value).length <= 1_000_000; } catch { return false; } };
const isAnswers = (value: unknown): boolean => isRecordValue(value) && Object.keys(value).length <= 20 && Object.entries(value).every(([key, answer]) => key.length <= 1000 && typeof answer === 'string' && answer.length <= 4000);
const isAnswer = (value: unknown): boolean =>
  shaped({ kind: oneOf('approval'), decision: oneOf('allow', 'allow-session', 'deny') }, { updatedInput: isToolInput, message: isText(2000) })(value)
  || shaped({ kind: oneOf('question'), answers: isAnswers })(value)
  || shaped({ kind: oneOf('plan'), approve: (v: unknown) => typeof v === 'boolean' }, { feedback: isText(4000) })(value);

/** A payload validator per channel. A channel missing here can't be called. */
export const validators: { [C in Channel]: Validator<Payload<C>> } = {
  'app.info': isNull,
  'app.problems': isNull,
  'settings.get': isNull,
  'settings.setTheme': exactly<{ theme: ThemeSetting }>({ theme: oneOf('dark', 'light', 'system') }),
  'settings.pickCliPath': exactly<{ provider: CliProvider }>({ provider: isProvider }),
  'settings.clearCliPath': exactly<{ provider: CliProvider }>({ provider: isProvider }),
  'state.get': isNull,
  'state.setSidebarOpen': exactly<{ open: boolean }>({ open: value => typeof value === 'boolean' }),
  'updates.status': isNull,
  'updates.check': isNull,
  'updates.setAutomatic': exactly<{ on: boolean }>({ on: value => typeof value === 'boolean' }),
  'projects.pick': isNull,
  'projects.clone': exactly<{ url: string }>({ url: value => typeof value === 'string' && value.length > 0 && value.length <= 500 }),
  'projects.remove': exactly<{ id: string }>({ id: isId }),
  'onboarding.check': exactly<{ refresh: boolean }>({ refresh: value => typeof value === 'boolean' }),
  'onboarding.signIn': exactly<{ provider: CliProvider }>({ provider: isProvider }),
  'projects.trust': exactly<{ id: string }>({ id: isId }),
  'chats.list': isNull,
  'chats.create': shaped<NewChatRequest>({ projectId: isId, provider: oneOf('claude', 'codex') }, { model: isModel, effort: isEffort, permissionMode: isPermissionMode, sandbox: isSandbox, approvals: isApprovals, where: oneOf('cloud') }),
  'chats.open': shaped<{ id: string; background?: boolean }>({ id: isId }, { background: value => value === true }),
  'chats.send': shaped<{ id: string; text: string; images?: ChatImage[] }>({ id: isId, text: isText(200_000) }, { images: isImages }),
  'chats.openTerminal': exactly<{ id: string }>({ id: isId }),
  'chats.setWhere': exactly<{ id: string; where: 'local' | 'cloud' }>({ id: isId, where: oneOf('local', 'cloud') }),
  'chats.continueCloud': exactly<{ id: string }>({ id: isId }),
  'terminal.write': exactly<{ id: string; data: string }>({ id: isId, data: isText(65_536) }),
  'terminal.resize': exactly<{ id: string; cols: number; rows: number }>({ id: isId, cols: value => Number.isInteger(value) && (value as number) >= 2 && (value as number) <= 500, rows: value => Number.isInteger(value) && (value as number) >= 2 && (value as number) <= 300 }),
  'terminal.close': exactly<{ id: string }>({ id: isId }),
  'browser.open': exactly<{ url?: string }>({ url: isText(2048) }),
  'browser.navigate': exactly<{ url: string }>({ url: isText(2048) }),
  'browser.bounds': exactly<{ x: number; y: number; width: number; height: number }>({ x: isPixels, y: isPixels, width: isPixels, height: isPixels }),
  'browser.back': isNull,
  'browser.forward': isNull,
  'browser.reload': isNull,
  'browser.close': isNull,
  'review.diff': exactly<{ id: string }>({ id: isId }),
  // A path relative to the chat's folder, checked again in main against the files the diff lists.
  'review.open': exactly<{ id: string; path: string }>({ id: isId, path: value => typeof value === 'string' && value.length > 0 && value.length <= 1000 && !/[\u0000-\u001f]/.test(value) }),
  'hydra.connections': isNull,
  'hydra.connect': exactly<{ provider: CliProvider }>({ provider: isProvider }),
  'hydra.disconnect': exactly<{ provider: CliProvider }>({ provider: isProvider }),
  'hydra.tree': isNull,
  'hydra.control': exactly<{ projectId: string; action: HydraControl }>({ projectId: isId, action: oneOf('stopState', 'stopAll', 'resume', 'auditLog', 'settings', 'allProjects') }),
  'hydra.reply': exactly<{ requestId: string; value: number | number[] | string | null }>({ requestId: isId, value: value => value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 10_000) || (Array.isArray(value) && value.length <= 10_000 && value.every(index => typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < 10_000)) || (typeof value === 'string' && value.length <= 20_000) }),
  'hydra.agents': exactly<{ projectId: string; message: unknown }>({ projectId: isId, message: value => !!value && typeof value === 'object' && !Array.isArray(value) && JSON.stringify(value).length <= 200_000 }),
  'chats.terminalClosed': exactly<{ id: string }>({ id: isId }),
  'chats.answer': exactly<{ id: string; requestId: string; answer: ChatAnswer }>({ id: isId, requestId: isRequestId, answer: isAnswer }),
  'chats.stop': exactly<{ id: string }>({ id: isId }),
  // An empty model or effort means the CLI's default.
  'chats.configure': exactly<{ id: string; change: ChatSettingsChange }>({ id: isId, change: shaped({}, { model: v => v === '' || isModel(v), effort: v => v === '' || isEffort(v), permissionMode: isPermissionMode, sandbox: isSandbox, approvals: isApprovals }) }),
  'chats.remove': exactly<{ id: string }>({ id: isId }),
  'chats.rename': exactly<{ id: string; title: string }>({ id: isId, title: isText(400) }),
  'chats.archive': exactly<{ id: string; archived: boolean }>({ id: isId, archived: oneOf(true, false) }),
};

export const channels = Object.freeze(Object.keys(validators) as Channel[]);
export const isChannel = (value: unknown): value is Channel =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(validators, value);

export type ParsedCall = { ok: true; channel: Channel; payload: unknown } | { ok: false; error: string };

/** Checks a raw message from the renderer: a plain object with a known channel and a payload its validator accepts. */
export function parseCall(raw: unknown): ParsedCall {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'A call must be an object.' };
  const { channel, payload } = raw as { channel?: unknown; payload?: unknown };
  const keys = Object.keys(raw);
  if (keys.some(key => key !== 'channel' && key !== 'payload')) return { ok: false, error: 'A call has only a channel and a payload.' };
  if (!isChannel(channel)) return { ok: false, error: `Unknown channel: ${typeof channel === 'string' ? channel.slice(0, 80) : typeof channel}.` };
  const valid = validators[channel] as Validator<unknown>;
  if (!valid(payload)) return { ok: false, error: `Invalid payload for ${channel}.` };
  return { ok: true, channel, payload };
}

/** What the preload puts on `window.hydra`: one function per channel. */
export interface HydraApi {
  appInfo(): Promise<AppInfo>;
  problems(): Promise<string[]>;
  getSettings(): Promise<AppSettings>;
  setTheme(theme: ThemeSetting): Promise<AppSettings>;
  pickCliPath(provider: CliProvider): Promise<AppSettings>;
  clearCliPath(provider: CliProvider): Promise<AppSettings>;
  getState(): Promise<AppState>;
  setSidebarOpen(open: boolean): Promise<AppState>;
  updateStatus(): Promise<UpdateStatusView>;
  checkForUpdates(): Promise<UpdateStatusView>;
  setAutomaticUpdates(on: boolean): Promise<UpdateStatusView>;
  pickProject(): Promise<{ state: AppState; picked?: string }>;
  cloneRepo(url: string): Promise<{ state: AppState; picked?: string }>;
  removeProject(id: string): Promise<AppState>;
  checkSetup(refresh: boolean): Promise<OnboardingReport>;
  signIn(provider: CliProvider): Promise<{ signedIn: boolean; error?: string }>;
  trustProject(id: string): Promise<AppState>;
  listChats(): Promise<ChatRecord[]>;
  createChat(request: NewChatRequest): Promise<ChatRecord>;
  /** `background`: the page catching up on a chat the user isn't looking at. */
  openChat(id: string, background?: boolean): Promise<OpenChat>;
  sendMessage(id: string, text: string, images?: ChatImage[]): Promise<null>;
  openTerminal(id: string): Promise<{ started: boolean; error?: string }>;
  setChatWhere(id: string, where: 'local' | 'cloud'): Promise<ChatRecord>;
  continueCloud(id: string): Promise<{ started: boolean; worktree?: string; error?: string; terminalId?: string }>;
  terminalWrite(id: string, data: string): Promise<null>;
  terminalResize(id: string, cols: number, rows: number): Promise<null>;
  terminalClose(id: string): Promise<null>;
  onTerminal(listener: (message: TerminalMessage) => void): () => void;
  browserOpen(url?: string): Promise<BrowserState>;
  browserNavigate(url: string): Promise<BrowserState>;
  browserBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<null>;
  browserBack(): Promise<null>;
  browserForward(): Promise<null>;
  browserReload(): Promise<null>;
  browserClose(): Promise<null>;
  onBrowser(listener: (state: BrowserState) => void): () => void;
  reviewDiff(id: string): Promise<ReviewResult>;
  openReviewFile(id: string, path: string): Promise<{ opened: 'editor' | 'folder' }>;
  terminalClosed(id: string): Promise<null>;
  answer(id: string, requestId: string, answer: ChatAnswer): Promise<null>;
  stopChat(id: string): Promise<null>;
  configureChat(id: string, change: ChatSettingsChange): Promise<ChatRecord>;
  removeChat(id: string): Promise<null>;
  renameChat(id: string, title: string): Promise<ChatRecord>;
  archiveChat(id: string, archived: boolean): Promise<ChatRecord>;
  hydraConnections(): Promise<HydraConnection[]>;
  connectHydra(provider: CliProvider): Promise<HydraConnection[]>;
  disconnectHydra(provider: CliProvider): Promise<HydraConnection[]>;
  hydraTree(): Promise<HydraTreeMessage[]>;
  /** Sends a message from the Agents view to the project's controller. */
  agentsMessage(projectId: string, message: unknown): Promise<null>;
  /** Calls `listener` with each message a project's controller sends its Agents view. */
  onHydraUi(listener: (message: HydraUiMessage) => void): () => void;
  /** One of the Agents view's controls; resolves with the project's stop state after it. */
  hydraControl(projectId: string, action: HydraControl): Promise<HydraStopState>;
  /** Answers one of Hydra's questions. */
  hydraReply(requestId: string, value: number | number[] | string | null): Promise<null>;
  /** Calls `listener` with each of Hydra's questions, notices and documents for the window. */
  onHydraHost(listener: (message: HydraHostMessage) => void): () => void;
  /** Calls `listener` whenever a project's heads or plans change; returns a function that stops it. */
  onHydraTree(listener: (message: HydraTreeMessage) => void): () => void;
  /** Calls `listener` with each chat's new events; returns a function that stops it. */
  onChatEvents(listener: (message: ChatEventsMessage) => void): () => void;
}
