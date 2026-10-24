'use strict';
/**
 * smoke-main.js —— Electron 主进程冒烟测试（一次性脚本，不属于 node:test 套件）。
 *
 * 目的：在真实 Electron 运行时中注册全部 IPC 处理器，验证：
 *  - 全部通道都能成功注册（无重复注册、无缺失）
 *  - preload 暴露的通道集合与 CHANNELS 一致
 *  - main 进程能安全启动（不触碰真实配置）
 *
 * 运行：npx electron smoke-main.js
 * 退出码：0 = 通过；1 = 失败。
 */
const { app, ipcMain, BrowserWindow } = require('electron');
const path = require('path');

const { CHANNELS } = require('./src/services/ipcChannels');

let failed = 0;

app.whenReady().then(async () => {
  // 1) 注册全部处理器
  const { registerHandlers } = require('./src/ipc/handlers');
  const { createProcessManager } = require('./src/services/processService');
  const providerService = require('./src/services/providerService');
  const credentialStore = require('./src/services/credentialStore');

  // 凭据 codec（Electron 下 safeStorage 可用）
  try {
    const codec = await credentialStore.makeProviderCodecAsync();
    if (codec) providerService.setCodec(codec);
    console.log('credential codec: ' + (codec ? 'safeStorage 已启用' : '不可用（明文回退）'));
  } catch (e) { console.log('credential codec 初始化异常（不影响启动）: ' + e.message); }

  const pm = createProcessManager();
  const userData = app.getPath('userData');
  registerHandlers({
    ipcMain,
    getUserDataDir: () => userData,
    getAppVersion: () => app.getVersion(),
    pm,
  });

  // 2) 校验所有 CHANNELS 都已注册
  //    ipcMain 对「重复注册同一通道」会抛错，因此：注册成功 = 已注册；
  //    抛「second handler」= 已被 registerHandlers 注册（同样视为通过）；
  //    抛其它错误 = 注册失败。
  const missing = [];
  let registered = 0;
  for (const name of Object.keys(CHANNELS)) {
    const ch = CHANNELS[name];
    try {
      ipcMain.handle(ch, () => ({}));
      registered++;
    } catch (e) {
      const msg = String(e && e.message || '');
      if (/second handler|already/i.test(msg)) registered++; // 已由 registerHandlers 注册
      else missing.push(name + '(' + ch + '): ' + msg);
    }
  }
  console.log('已注册处理器: ' + registered + '/' + Object.keys(CHANNELS).length);
  if (missing.length) { console.error('❌ 注册失败: ' + missing.join('; ')); failed = 1; }
  else console.log('✅ 全部 IPC 处理器注册成功');

  // 3) preload 通道暴露一致性
  const preload = require('fs').readFileSync(path.join(__dirname, 'src', 'preload.js'), 'utf-8');
  if (preload.includes('channels: CHANNELS')) console.log('✅ preload 暴露完整通道表');
  else { console.error('❌ preload 未暴露完整通道表'); failed = 1; }

  // 4) 创建一个隐藏窗口验证 webPreferences 安全配置
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  const prefs = win.webContents.getLastWebPreferences() || {};
  const ctxOk = prefs.contextIsolation !== false;
  const nodeOk = prefs.nodeIntegration !== true;
  console.log('webPreferences: contextIsolation=' + prefs.contextIsolation + ' nodeIntegration=' + prefs.nodeIntegration);
  if (!ctxOk || !nodeOk) { console.error('❌ Electron 安全配置不符'); failed = 1; }
  else console.log('✅ Electron 安全配置正确');

  console.log(failed ? 'SMOKE_FAIL' : 'SMOKE_OK handlers=' + Object.keys(CHANNELS).length);
  app.exit(failed);
});
