import { IPC_TRANSPORT, parseCall, type Channel, type Payload, type Result } from '../shared/ipc';
import { APP_HOST, APP_SCHEME } from './security';

export type Handlers = { [C in Channel]: (payload: Payload<C>) => Result<C> | Promise<Result<C>> };

/** The parts of an IpcMainInvokeEvent the check reads. */
export interface CallSender { senderFrame?: { url: string } | null; sender?: { mainFrame: unknown } }

/** Only the main frame of the app's own pages, served from app://hydra/, may call main; never a subframe. */
export function trustedSender(event: CallSender): boolean {
  const url = event.senderFrame?.url;
  if (!url || !event.sender || event.senderFrame !== event.sender.mainFrame) return false;
  try { const parsed = new URL(url); return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST; } catch { return false; }
}

/**
 * Runs one call from the renderer, after checking who sent it and what it carries. Anything unexpected is refused
 * with an error, never run: an untrusted sender, an unknown channel, or a payload its validator rejects.
 */
export async function dispatch(handlers: Handlers, event: CallSender, raw: unknown): Promise<unknown> {
  if (!trustedSender(event)) throw new Error('Refused: the call did not come from the app.');
  const call = parseCall(raw);
  if (!call.ok) throw new Error(`Refused: ${call.error}`);
  const handler = handlers[call.channel] as (payload: unknown) => unknown;
  return handler(call.payload);
}

export interface IpcMainLike {
  handle(channel: string, listener: (event: CallSender, raw: unknown) => Promise<unknown>): void;
}

/** Registers the single transport channel. Electron itself refuses an invoke on any other channel: none has a handler. */
export function registerIpc(ipcMain: IpcMainLike, handlers: Handlers): void {
  ipcMain.handle(IPC_TRANSPORT, (event, raw) => dispatch(handlers, event, raw));
}
