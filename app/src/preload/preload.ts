import { contextBridge, ipcRenderer } from 'electron';
import { CHAT_EVENTS, HYDRA_HOST, HYDRA_TREE, HYDRA_UI, IPC_TRANSPORT, type Channel, type ChatEventsMessage, type HydraApi, type HydraHostMessage, type HydraTreeMessage, type HydraUiMessage, type Payload, type Result } from '../shared/ipc';

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
  updateStatus: () => call('updates.status', null),
  checkForUpdates: () => call('updates.check', null),
  setAutomaticUpdates: on => call('updates.setAutomatic', { on }),
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
  setChatWhere: (id, where) => call('chats.setWhere', { id, where }),
  continueCloud: id => call('chats.continueCloud', { id }),
  reviewDiff: id => call('review.diff', { id }),
  openReviewFile: (id, path) => call('review.open', { id, path }),
  terminalClosed: id => call('chats.terminalClosed', { id }),
  answer: (id, requestId, answer) => call('chats.answer', { id, requestId, answer }),
  stopChat: id => call('chats.stop', { id }),
  configureChat: (id, change) => call('chats.configure', { id, change }),
  removeChat: id => call('chats.remove', { id }),
  renameChat: (id, title) => call('chats.rename', { id, title }),
  archiveChat: (id, archived) => call('chats.archive', { id, archived }),
  hydraConnections: () => call('hydra.connections', null),
  connectHydra: provider => call('hydra.connect', { provider }),
  disconnectHydra: provider => call('hydra.disconnect', { provider }),
  hydraTree: () => call('hydra.tree', null),
  agentsMessage: (projectId, message) => call('hydra.agents', { projectId, message }),
  hydraControl: (projectId, action) => call('hydra.control', { projectId, action }),
  hydraReply: (requestId, value) => call('hydra.reply', { requestId, value }),
  onHydraHost: listener => {
    const handler = (_event: unknown, message: HydraHostMessage) => listener(message);
    ipcRenderer.on(HYDRA_HOST, handler);
    return () => { ipcRenderer.removeListener(HYDRA_HOST, handler); };
  },
  onHydraUi: listener => {
    const handler = (_event: unknown, message: HydraUiMessage) => listener(message);
    ipcRenderer.on(HYDRA_UI, handler);
    return () => { ipcRenderer.removeListener(HYDRA_UI, handler); };
  },
  onHydraTree: listener => {
    const handler = (_event: unknown, message: HydraTreeMessage) => listener(message);
    ipcRenderer.on(HYDRA_TREE, handler);
    return () => { ipcRenderer.removeListener(HYDRA_TREE, handler); };
  },
  // The page gets the message, never the Electron event or the sender.
  onChatEvents: listener => {
    const handler = (_event: unknown, message: ChatEventsMessage) => listener(message);
    ipcRenderer.on(CHAT_EVENTS, handler);
    return () => { ipcRenderer.removeListener(CHAT_EVENTS, handler); };
  },
};

contextBridge.exposeInMainWorld('hydra', Object.freeze(api));
