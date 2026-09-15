const { app, BrowserWindow } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let win;
let backend;
const PORT = 8787;

function runtimeRoot() {
  return path.join(process.resourcesPath, 'runtime');
}

function startBackend() {
  const root = runtimeRoot();
  const exe = path.join(root, 'Mira-Backend.exe');
  if (!fs.existsSync(exe)) throw new Error(`Mira-Backend.exe is missing: ${exe}`);

  backend = spawn(exe, [], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, MIRA_PORT: String(PORT) },
    stdio: 'ignore'
  });
  backend.on('exit', () => { backend = null; });
}

async function waitForBackend() {
  const url = `http://127.0.0.1:${PORT}/health`;
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Mira backend did not start on port 8787.');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: '#09070b',
    title: 'Luna — AI Gothic Companion',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadURL(`http://127.0.0.1:${PORT}/`);
}

app.whenReady().then(async () => {
  try {
    startBackend();
    await waitForBackend();
    createWindow();
  } catch (err) {
    const { dialog } = require('electron');
    await dialog.showMessageBox({
      type: 'error',
      title: 'Luna could not start',
      message: err.message,
      detail: 'Make sure Ollama is installed and qwen3:4b is available.'
    });
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (backend) {
    try { backend.kill(); } catch {}
    backend = null;
  }
  if (process.platform !== 'darwin') app.quit();
});
