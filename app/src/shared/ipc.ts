/**
 * The app's IPC contract: one Electron channel, carrying `{ channel, payload }` calls named here. The preload exposes
 * a typed function per channel and nothing else; main checks the sender, the channel and the payload of every call
 * before it runs (app/src/main/ipc.ts). This file is shared by main, preload and renderer, so it imports only types.
 */
import type { ThemeSetting } from './theme';

export const IPC_TRANSPORT = 'hydra:call';

export type CliProvider = 'claude' | 'codex';
export interface AppInfo { name: string; version: string; electron: string; platform: string }
/** Preferences, in settings.json. CLI paths are machine-only: set from main's file picker, never from a project. */
export interface AppSettings { version: 1; theme: ThemeSetting; cliPaths: Partial<Record<CliProvider, string>> }
/** A folder the user picked. Chats arrive in G4. */
export interface Project { id: string; path: string; name: string }
/** The sidebar and the projects, in state.json. */
export interface AppState { version: 1; sidebarOpen: boolean; projects: Project[] }

/** Every call the renderer can make: its payload and its result. */
export interface Channels {
  'app.info': { payload: null; result: AppInfo };
  'settings.get': { payload: null; result: AppSettings };
  'settings.setTheme': { payload: { theme: ThemeSetting }; result: AppSettings };
  /** Main shows a file picker; the renderer never sends a path. */
  'settings.pickCliPath': { payload: { provider: CliProvider }; result: AppSettings };
  'settings.clearCliPath': { payload: { provider: CliProvider }; result: AppSettings };
  'state.get': { payload: null; result: AppState };
  'state.setSidebarOpen': { payload: { open: boolean }; result: AppState };
  /** Main shows a folder picker; the renderer never sends a path. */
  'projects.pick': { payload: null; result: AppState };
  'projects.remove': { payload: { id: string }; result: AppState };
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

/** A payload validator per channel. A channel missing here can't be called. */
export const validators: { [C in Channel]: Validator<Payload<C>> } = {
  'app.info': isNull,
  'settings.get': isNull,
  'settings.setTheme': exactly<{ theme: ThemeSetting }>({ theme: oneOf('dark', 'light', 'system') }),
  'settings.pickCliPath': exactly<{ provider: CliProvider }>({ provider: isProvider }),
  'settings.clearCliPath': exactly<{ provider: CliProvider }>({ provider: isProvider }),
  'state.get': isNull,
  'state.setSidebarOpen': exactly<{ open: boolean }>({ open: value => typeof value === 'boolean' }),
  'projects.pick': isNull,
  'projects.remove': exactly<{ id: string }>({ id: isId }),
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
  getSettings(): Promise<AppSettings>;
  setTheme(theme: ThemeSetting): Promise<AppSettings>;
  pickCliPath(provider: CliProvider): Promise<AppSettings>;
  clearCliPath(provider: CliProvider): Promise<AppSettings>;
  getState(): Promise<AppState>;
  setSidebarOpen(open: boolean): Promise<AppState>;
  pickProject(): Promise<AppState>;
  removeProject(id: string): Promise<AppState>;
}
