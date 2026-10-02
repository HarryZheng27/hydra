import { contextBridge, ipcRenderer } from 'electron';
import { IPC_TRANSPORT, type Channel, type HydraApi, type Payload, type Result } from '../shared/ipc';

// The renderer gets these typed functions and nothing else: no ipcRenderer, no channel names, no Node.
const call = <C extends Channel>(channel: C, payload: Payload<C>): Promise<Result<C>> =>
  ipcRenderer.invoke(IPC_TRANSPORT, { channel, payload }) as Promise<Result<C>>;

const api: HydraApi = {
  appInfo: () => call('app.info', null),
  problems: () => call('app.problems', null),
  getSettings: () => call('settings.get', null),
  setTheme: theme => call('settings.setTheme', { theme }),
  pickCliPath: provider => call('settings.pickCliPath', { provider }),
  clearCliPath: provider => call('settings.clearCliPath', { provider }),
  getState: () => call('state.get', null),
  setSidebarOpen: open => call('state.setSidebarOpen', { open }),
  pickProject: () => call('projects.pick', null),
  removeProject: id => call('projects.remove', { id }),
};

contextBridge.exposeInMainWorld('hydra', Object.freeze(api));
