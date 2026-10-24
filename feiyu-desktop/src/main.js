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
 *
 * 优先级（不硬编码任何盘符 / 开发机路径）：
 *  1) 用户设置里保存的 botDir（用户在「机器人运行」页选过）
 *  2) 打包内自带 bot/（便携包把 bot 放在 exe 同级或上级时）
 *  3) 开发期：仓库根（app/..）
 *  4) 便携/安装场景：exe 同级及其上溯两级的常见位置（bot/、NapCat_publish/ 等）
 *  5) 兜底：用户主目录下的常见位置
 *
 * 说明：安装版 app.getAppPath() 指向 app.asar 内部，不能在其中找 bot；
 * 因此额外用 process.execPath 的目录做候选（便携包最常见）。
 */
function resolveDefaultBotDir() {
  const ud = getUserDataDir();
  try {
    const s = JSON.parse(fs.readFileSync(path.join(ud, 'feiyu-settings.json'), 'utf-8'));
    if (s.botDir && fs.existsSync(s.botDir)) return s.botDir;
  } catch (_) {}

  const candidates = [];
  const appPath = app.getAppPath();
  candidates.push(path.join(appPath, 'bot'), appPath, path.join(appPath, '..'));

  // 便携/安装版：exe 所在目录及其上溯
  try {
    const exeDir = path.dirname(process.execPath);
    candidates.push(
      path.join(exeDir, 'bot'),
      path.join(exeDir, '..', 'bot'),
      path.join(exeDir, '..', 'NapCat_publish'),
      path.join(exeDir, '..', '..', 'NapCat_publish'),
    );
  } catch (_) {}

  // 兜底：用户主目录常见位置
  try {
    const home = app.getPath('home');
    candidates.push(path.join(home, 'NapCat_publish'), path.join(home, 'bot'));
  } catch (_) {}

  const seen = new Set();
  for (const c of candidates) {
    if (!c) continue;
    const k = path.resolve(c);
    if (seen.has(k)) continue;
    seen.add(k);
    if (isBotDir(k)) return k;
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

app.whenReady().then(async () => {
  await initCredentialCodecAsync();
  ensureBotDirDefault();
  registerHandlers({ ipcMain, getUserDataDir, getAppVersion, pm });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
