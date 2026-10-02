/**
 * The app's IPC contract: one Electron channel, carrying `{ channel, payload }` calls named here. The preload exposes
 * a typed function per channel and nothing else; main checks the sender, the channel and the payload of every call
 * before it runs (app/src/main/ipc.ts). This file is shared by main, preload and renderer, so it imports nothing.
 */
export const IPC_TRANSPORT = 'hydra:call';

export interface AppInfo { name: string; version: string; electron: string; platform: string }

/** Every call the renderer can make: its payload and its result. */
export interface Channels {
  'app.info': { payload: null; result: AppInfo };
}
export type Channel = keyof Channels;
export type Payload<C extends Channel> = Channels[C]['payload'];
export type Result<C extends Channel> = Channels[C]['result'];

type Validator<T> = (value: unknown) => value is T;
const isNull: Validator<null> = (value): value is null => value === null;

/** A payload validator per channel. A channel missing here can't be called. */
export const validators: { [C in Channel]: Validator<Payload<C>> } = {
  'app.info': isNull,
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

/** What the preload puts on `window.hydra`. */
export interface HydraApi {
  appInfo(): Promise<AppInfo>;
}
