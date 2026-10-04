import { contextBridge, ipcRenderer } from 'electron';

/**
 * The Hydra Settings window's preload (G5 milestone 5): G2's `window.hydraBridge` for the IDE's own settings page.
 * Its messages go to main on one channel; main's come back as `message` events on the page's window, as VS Code's
 * webview delivers them. Nothing else reaches the page.
 */
const SETTINGS_POST = 'hydra-settings:post';
const SETTINGS_MESSAGE = 'hydra-settings:message';
let state: unknown;

contextBridge.exposeInMainWorld('hydraBridge', {
  postMessage: (message: unknown) => { ipcRenderer.send(SETTINGS_POST, message); },
  getState: () => state,
  setState: (value: unknown) => { state = value; },
});
ipcRenderer.on(SETTINGS_MESSAGE, (_event, message: unknown) => { window.postMessage(message, '*'); });
