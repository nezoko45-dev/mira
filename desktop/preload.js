const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const assets = {
  'luna mouth open.png': pathToFileURL(path.join(process.resourcesPath, 'luna mouth open.png')).href,
  'luna mouth closed.png': pathToFileURL(path.join(process.resourcesPath, 'luna mouth closed.png')).href
};
function fixLunaImage(img) {
  if (!img || !img.src) return;
  const name = decodeURIComponent(img.src.split('/').pop() || '');
  if (assets[name] && img.src !== assets[name]) img.src = assets[name];
}
window.addEventListener('DOMContentLoaded', () => {
  const img = document.getElementById('luna');
  fixLunaImage(img);
  if (img) new MutationObserver(() => fixLunaImage(img)).observe(img, { attributes: true, attributeFilter: ['src'] });
});
contextBridge.exposeInMainWorld('lunaDesktop', {
  voiceStatus: () => ipcRenderer.invoke('voice-status'),
  assetUrl: (name) => assets[name] || ''
});
