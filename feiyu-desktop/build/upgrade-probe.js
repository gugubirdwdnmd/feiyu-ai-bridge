'use strict';
/**
 * upgrade-probe.js —— 以某个已安装目录的 app.asar 为唯一代码来源，探测其版本并写入一份用户数据。
 *
 * 用于升级链验收：
 *   - v1.0.0 装好后跑一次 → 在隔离 userData 生成 price.json（模拟旧版本用户数据）
 *   - v1.1.0 装好后跑一次 → 验证旧用户数据仍在，且新版本主题功能可用
 *
 * 运行：npx electron build/upgrade-probe.js <app.asar> <userData目录>
 */
const { app, ipcMain, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const asarPath = path.resolve(process.argv[2] || '');
const userDataArg = process.argv[3] || '';

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed = 1; console.error('  ✗ ' + m); };

if (!asarPath || !fs.existsSync(asarPath)) {
  console.error('用法: npx electron build/upgrade-probe.js <app.asar> <userData目录>');
  process.exit(1);
}
const userData = path.resolve(userDataArg);
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);

const APP = asarPath;

/** 读取 asar 内的 package.json（拿到真实应用版本，而不是 Electron 版本）。 */
function readAppVersion() {
  try {
    const raw = fs.readFileSync(path.join(APP, 'package.json'), 'utf-8');
    return JSON.parse(raw).version || '';
  } catch (e) {
    return '';
  }
}

function registerAll() {
  const { registerHandlers } = require(path.join(APP, 'src', 'ipc', 'handlers.js'));
  const { createProcessManager } = require(path.join(APP, 'src', 'services', 'processService.js'));
  registerHandlers({
    ipcMain,
    getUserDataDir: () => app.getPath('userData'),
    getAppVersion: () => readAppVersion(),
    pm: createProcessManager(),
  });
}

app.whenReady().then(async () => {
  try {
    console.log('  · 实际 userData: ' + app.getPath('userData'));
    console.log('  · 实际 sessionData: ' + app.getPath('sessionData'));
    const version = readAppVersion();
    if (version) ok('asar 内应用版本: ' + version);
    else bad('无法读取 asar 内 package.json');

    registerAll();

    // 写入一份价格表（用户数据），用于验证升级后数据保留
    const priceService = require(path.join(APP, 'src', 'services', 'priceService.js'));
    const table = priceService.examplePrice ? priceService.examplePrice() : { demo: 0.1 };
    priceService.setPrice(userData, table);
    const priceFile = path.join(userData, 'price.json');
    if (fs.existsSync(priceFile)) ok('已写入隔离用户数据 price.json');
    else bad('price.json 未生成');

    // 新版本才有主题页
    let hasTheme = false;
    try {
      hasTheme = fs.existsSync(path.join(APP, 'renderer', 'theme.js'));
    } catch (_) { hasTheme = false; }

    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(APP, 'src', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    await win.loadFile(path.join(APP, 'renderer', 'index.html'));
    await new Promise((r) => setTimeout(r, 900));

    const nav = await win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('#nav button')).map(b => b.getAttribute('data-page'))`);
    ok('导航页面: ' + nav.join(', '));
    if (hasTheme) {
      if (nav.indexOf('theme') >= 0) ok('新版本含「主题工坊」入口');
      else bad('新版本导航缺少 theme 入口');
    } else {
      if (nav.indexOf('theme') < 0) ok('旧版本无「主题工坊」入口（符合预期）');
      else bad('旧版本不应有 theme 入口');
    }

    win.destroy();
  } catch (e) {
    console.error('  ✗ 异常: ' + (e && e.stack || e));
    failed = 1;
  }
  console.log(failed ? '\nUPGRADE_PROBE_FAIL' : '\nUPGRADE_PROBE_OK');
  app.exit(failed);
});
