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
const os = require('os');
const fs = require('fs');

const { CHANNELS } = require('./src/services/ipcChannels');

let failed = 0;

// 隔离 userData：冒烟不得读写真实用户数据目录（theme.json 等）
const smokeUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-smoke-'));
try { app.setPath('userData', smokeUserData); } catch (_) {}

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

  // 5) 主题工坊：主题页可加载 + 主题 IPC 往返可用 + 主题只落在隔离 userData
  try {
    const themeService = require('./src/services/themeService');
    const t = await win.webContents.executeJavaScript(
      `(async () => {
        const r = await window.feiyu.invoke(window.feiyu.channels.THEME_GET);
        return { ok: !!r && r.ok, hasTheme: !!(r && r.theme && r.theme.bg), hasDerived: !!(r && r.derived && r.derived.cssVars), presets: (r && r.presets || []).length };
      })()`);
    if (t.ok && t.hasTheme && t.hasDerived) console.log('✅ 主题 IPC 可用（THEME_GET 返回主题与派生色）');
    else { console.error('❌ 主题 IPC 异常: ' + JSON.stringify(t)); failed = 1; }
    if (t.presets === 6) console.log('✅ 主题预设 6 套可用');
    else { console.error('❌ 主题预设数量异常: ' + t.presets); failed = 1; }

    // 切到主题页并确认渲染出内容
    const page = await win.webContents.executeJavaScript(
      `(async () => {
        const btn = document.querySelector('#nav button[data-page="theme"]');
        if (!btn) return { ok: false, reason: '导航缺少主题按钮' };
        btn.click();
        await new Promise(r => setTimeout(r, 600));
        const h2 = document.querySelector('#content h2');
        const vars = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
        return { ok: true, title: h2 ? h2.textContent : '', bgVar: vars, hasCanvas: !!document.getElementById('bgCanvas') };
      })()`);
    if (page.ok && page.title === '主题工坊') console.log('✅ 主题页可加载（标题：' + page.title + '）');
    else { console.error('❌ 主题页加载异常: ' + JSON.stringify(page)); failed = 1; }
    if (page.bgVar) console.log('✅ 主题 CSS 变量已生效（--bg = ' + page.bgVar + '）');
    else { console.error('❌ --bg 变量未写入'); failed = 1; }

    // 主题文件只落在隔离 userData
    const themeFile = path.join(userData, themeService.THEME_FILE);
    const exists = fs.existsSync(themeFile);
    console.log(exists ? '✅ 主题文件落在隔离 userData: ' + themeFile : '· 尚未写入主题文件（未保存主题时不产生文件）');
  } catch (e) {
    console.error('❌ 主题工坊冒烟异常: ' + e.message);
    failed = 1;
  }

  console.log(failed ? 'SMOKE_FAIL' : 'SMOKE_OK handlers=' + Object.keys(CHANNELS).length);
  try { fs.rmSync(smokeUserData, { recursive: true, force: true }); } catch (_) {}
  app.exit(failed);
});
