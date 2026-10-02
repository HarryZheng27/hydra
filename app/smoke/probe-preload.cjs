// Smoke only: a preload that gives its page raw ipcRenderer.invoke on any channel, standing in for a compromised
// renderer, so the smoke can prove main itself refuses unknown channels and bad payloads. The app never loads this.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('probe', { invoke: (channel, payload) => ipcRenderer.invoke(channel, payload) });
