'use strict';
/**
 * main.js —— Electron 主进程。
 * 职责：窗口生命周期、目录解析、进程管理、IPC 注册。
 * 安全：Renderer 经 preload 仅能调用固定 IPC 通道；不暴露 fs / child_process / shell 给渲染进程。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { registerHandlers } = require('./ipc/handlers');
const { createProcessManager } = require('./services/processService');

const pm = createProcessManager();

function getUserDataDir() { return app.getPath('userData'); }
function getAppVersion() { return app.getVersion(); }

/** 解析默认 bot 目录：设置 > 打包内 bot/ > 开发期仓库根（含 ai_bridge.js）。不硬编码 D 盘。 */
function resolveDefaultBotDir() {
  const ud = getUserDataDir();
  try {
    const s = JSON.parse(fs.readFileSync(path.join(ud, 'feiyu-settings.json'), 'utf-8'));
    if (s.botDir && fs.existsSync(s.botDir)) return s.botDir;
  } catch (_) {}
  const appPath = app.getAppPath();
  const candidates = [path.join(appPath, 'bot'), path.join(appPath, '..')];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'ai_bridge.js'))) return c;
  }
  return '';
}

function ensureBotDirDefault() {
  const d = resolveDefaultBotDir();
  if (!d) return;
  const sf = path.join(getUserDataDir(), 'feiyu-settings.json');
  let s = {};
  try { s = JSON.parse(fs.readFileSync(sf, 'utf-8')); } catch (_) {}
  if (!s.botDir) {
    s.botDir = d;
    try { fs.mkdirSync(getUserDataDir(), { recursive: true }); fs.writeFileSync(sf, JSON.stringify(s, null, 2)); } catch (_) {}
  }
}

let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 1120, height: 740, minWidth: 920, minHeight: 600,
    title: '肥鱼桌面控制中心',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  ensureBotDirDefault();
  registerHandlers({ ipcMain, getUserDataDir, getAppVersion, pm });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
