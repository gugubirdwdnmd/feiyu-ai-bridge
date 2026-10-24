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
const providerService = require('./services/providerService');
const credentialStore = require('./services/credentialStore');
const botDirResolver = require('./services/botDirResolver');

const pm = createProcessManager();

/**
 * 凭据加固：Electron safeStorage 可用时，把桌面侧多 Provider 密钥的存储切换为密文。
 *  - 只影响桌面管理的 feiyu_provider_secrets.json；bot 的 secrets.json 保持明文（bot 需明文调用 API）。
 *  - 迁移是显式的（用户在 UI 触发 CREDENTIAL_MIGRATE），不在启动时自动改写用户数据；
 *    启动时只注入 codec，使后续写入自动加密。
 */
function initCredentialCodec() {
  try {
    const codec = credentialStore.makeProviderCodec();
    if (codec) providerService.setCodec(codec);
    return !!codec;
  } catch (_) { return false; }
}

/** 异步版初始化：优先用新版 safeStorage.isAsyncEncryptionAvailable（避免弃用告警）。 */
async function initCredentialCodecAsync() {
  try {
    const codec = await credentialStore.makeProviderCodecAsync();
    if (codec) providerService.setCodec(codec);
    return !!codec;
  } catch (_) { return initCredentialCodec(); }
}

function getUserDataDir() { return app.getPath('userData'); }
function getAppVersion() { return app.getVersion(); }

function isBotDir(p) {
  try { return !!p && fs.existsSync(path.join(p, 'ai_bridge.js')); } catch (_) { return false; }
}

/**
 * 解析默认 bot 目录（机器人项目根，含 ai_bridge.js）。
 * 实现在 botDirResolver.js（纯逻辑、可单测）；此处只负责注入 Electron 路径。
 *
 * 优先级：用户设置 > 打包内 bot/ > 开发期仓库根 > exe 相对（便携/安装）> 用户主目录。
 * 绝不硬编码任何盘符或开发机路径。找不到时返回空串（界面会提示手动选择）。
 */
function resolveDefaultBotDir() {
  let appPath = '';
  let execPath = '';
  let home = '';
  try { appPath = app.getAppPath(); } catch (_) {}
  try { execPath = process.execPath; } catch (_) {}
  try { home = app.getPath('home'); } catch (_) {}
  let botDir = '';
  try {
    const s = JSON.parse(fs.readFileSync(path.join(getUserDataDir(), 'feiyu-settings.json'), 'utf-8'));
    botDir = s.botDir || '';
  } catch (_) {}
  const r = botDirResolver.resolveBotDir({ appPath, execPath, home, botDir });
  return r.ok ? r.botDir : '';
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

app.whenReady().then(async () => {
  await initCredentialCodecAsync();
  ensureBotDirDefault();
  registerHandlers({ ipcMain, getUserDataDir, getAppVersion, pm });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
