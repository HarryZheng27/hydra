import { contextBridge, ipcRenderer } from 'electron';
import { IPC_TRANSPORT, type Channel, type HydraApi, type Payload, type Result } from '../shared/ipc';

// The renderer gets these typed functions and nothing else: no ipcRenderer, no channel names, no Node.
const call = <C extends Channel>(channel: C, payload: Payload<C>): Promise<Result<C>> =>
  ipcRenderer.invoke(IPC_TRANSPORT, { channel, payload }) as Promise<Result<C>>;

const api: HydraApi = {
  appInfo: () => call('app.info', null),
};

contextBridge.exposeInMainWorld('hydra', Object.freeze(api));
