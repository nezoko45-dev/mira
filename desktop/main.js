const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let win;
let voiceProcess;

function startVoiceBackend() {
  const exe = process.platform === 'win32' ? 'openvoice-server.exe' : 'openvoice-server';
  const bundled = path.join(process.resourcesPath, 'openvoice', exe);
  const dev = path.join(__dirname, '..', 'openvoice', exe);
  const target = require('fs').existsSync(bundled) ? bundled : dev;
  if (!require('fs').existsSync(target)) return;
  voiceProcess = spawn(target, [], { windowsHide: true, stdio: 'ignore' });
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
