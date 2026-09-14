const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
contextBridge.exposeInMainWorld('lunaDesktop', {
  voiceStatus: () => ipcRenderer.invoke('voice-status'),
  assetUrl: (name) => pathToFileURL(path.join(process.resourcesPath, name)).href
});
