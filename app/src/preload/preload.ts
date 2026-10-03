import { contextBridge, ipcRenderer } from 'electron';
import { CHAT_EVENTS, IPC_TRANSPORT, type Channel, type ChatEventsMessage, type HydraApi, type Payload, type Result } from '../shared/ipc';

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
  cloneRepo: url => call('projects.clone', { url }),
  removeProject: id => call('projects.remove', { id }),
  checkSetup: refresh => call('onboarding.check', { refresh }),
  signIn: provider => call('onboarding.signIn', { provider }),
  trustProject: id => call('projects.trust', { id }),
  listChats: () => call('chats.list', null),
  createChat: request => call('chats.create', request),
  openChat: (id, background) => call('chats.open', background ? { id, background: true } : { id }),
  sendMessage: (id, text, images) => call('chats.send', images?.length ? { id, text, images } : { id, text }),
  openTerminal: id => call('chats.openTerminal', { id }),
  reviewDiff: id => call('review.diff', { id }),
  openReviewFile: (id, path) => call('review.open', { id, path }),
  terminalClosed: id => call('chats.terminalClosed', { id }),
  answer: (id, requestId, answer) => call('chats.answer', { id, requestId, answer }),
  stopChat: id => call('chats.stop', { id }),
  configureChat: (id, change) => call('chats.configure', { id, change }),
  removeChat: id => call('chats.remove', { id }),
  // The page gets the message, never the Electron event or the sender.
  onChatEvents: listener => {
    const handler = (_event: unknown, message: ChatEventsMessage) => listener(message);
    ipcRenderer.on(CHAT_EVENTS, handler);
    return () => { ipcRenderer.removeListener(CHAT_EVENTS, handler); };
  },
};

contextBridge.exposeInMainWorld('hydra', Object.freeze(api));
