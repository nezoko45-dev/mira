const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lunaDesktop', {
  voiceStatus: () => ipcRenderer.invoke('voice-status')
});
