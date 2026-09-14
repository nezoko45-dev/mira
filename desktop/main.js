const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let win;
let voiceProcess;

function startVoiceBackend() {
  const base = path.join(process.resourcesPath, 'openvoice');
  const candidates = process.platform === 'win32'
    ? [path.join(base, 'openvoice-server', 'openvoice-server.exe'), path.join(base, 'openvoice-server.exe')]
    : [path.join(base, 'openvoice-server', 'openvoice-server'), path.join(base, 'openvoice-server')];
  const target = candidates.find(fs.existsSync);
  if (!target) return;
  voiceProcess = spawn(target, [], { windowsHide: true, cwd: path.dirname(target), stdio: 'ignore' });
  voiceProcess.on('exit', () => { voiceProcess = null; });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: '#09070b',
    title: 'Luna — AI Gothic Companion',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'desktop.html'));
}

app.whenReady().then(() => {
  startVoiceBackend();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (voiceProcess) voiceProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('voice-status', () => ({ running: !!voiceProcess }));
