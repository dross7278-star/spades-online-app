'use strict';

const { app, BrowserWindow, shell } = require('electron');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

let mainWindow;
let server;

function canBindPort(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function startLocalServer() {
  const portFile = path.join(app.getPath('userData'), 'server-port');
  let port;
  try {
    const savedPort = Number(fs.readFileSync(portFile, 'utf8'));
    if (Number.isInteger(savedPort) && savedPort > 0 && savedPort < 65536 && await canBindPort(savedPort)) port = savedPort;
  } catch {
    port = undefined;
  }
  if (!port) {
    port = await findFreePort();
    fs.mkdirSync(path.dirname(portFile), { recursive: true });
    fs.writeFileSync(portFile, String(port), 'utf8');
  }

  process.env.PORT = String(port);
  process.env.HOST = '127.0.0.1';
  ({ server } = require('../server'));
  if (!server.listening) {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  }
  return server.address().port;
}

async function createWindow() {
  const port = await startLocalServer();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 860,
    minHeight: 640,
    backgroundColor: '#060b13',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  await mainWindow.loadURL(`http://127.0.0.1:${port}`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.setAppUserModelId('com.dross7278.spades');
app.whenReady().then(createWindow).catch(error => {
  console.error('Could not start the Spades desktop app:', error);
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on('before-quit', () => {
  if (server.listening) server.close();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
