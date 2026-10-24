'use strict';
/**
 * install-theme-check.js —— 安装版产物的主题链路验收（Electron 运行时，一次性脚本）。
 *
 * 直接以**安装目录里的 app.asar** 为唯一代码来源，userData 指向隔离目录，验证：
 *  1. 安装版能启动并加载主题页
 *  2. 切换预设 + 切换动画 + 导出/导入
 *  3. 重启后主题保留
 *  4. 主题文件只落在隔离 userData，不写进安装目录
 *
 * 运行：npx electron install-theme-check.js <app.asar> <userData目录>
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
  console.error('用法: npx electron install-theme-check.js <app.asar> <userData目录>');
  process.exit(1);
}
const userData = path.resolve(userDataArg);
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);

const APP = asarPath;

function registerAll() {
  const { registerHandlers } = require(path.join(APP, 'src', 'ipc', 'handlers.js'));
  const { createProcessManager } = require(path.join(APP, 'src', 'services', 'processService.js'));
  registerHandlers({
    ipcMain,
    getUserDataDir: () => app.getPath('userData'),
    getAppVersion: () => app.getVersion(),
    pm: createProcessManager(),
  });
}

async function newWindow() {
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
  return win;
}

app.whenReady().then(async () => {
  try {
    registerAll();
    const themeFile = path.join(userData, 'theme.json');

    console.log('\n[1] 安装版启动 + 主题页加载');
    const win = await newWindow();
    let r = await win.webContents.executeJavaScript(
      `(async () => {
        document.querySelector('#nav button[data-page="theme"]').click();
        await new Promise(r => setTimeout(r, 700));
        const cs = getComputedStyle(document.documentElement);
        return {
          title: (document.querySelector('#content h2')||{}).textContent,
          presets: document.querySelectorAll('[data-preset]').length,
          bg: cs.getPropertyValue('--bg').trim(),
          hasCanvas: !!document.getElementById('bgCanvas'),
        };
      })()`);
    if (r.title === '主题工坊') ok('安装版主题页加载成功'); else bad('主题页标题异常: ' + r.title);
    if (r.presets === 6) ok('安装版渲染出 6 套配色预设'); else bad('预设数量异常: ' + r.presets);
    if (r.hasCanvas) ok('背景动画 canvas 已注入'); else bad('未找到背景动画 canvas');
    if (r.bg === '#0b1d2a') ok('默认主题 CSS 变量生效（--bg=#0b1d2a）'); else bad('--bg 异常: ' + r.bg);

    console.log('\n[2] 切换预设（极光）+ 切换动画（aurora）');
    r = await win.webContents.executeJavaScript(
      `(async () => {
        document.querySelector('[data-preset="aurora"]').click();
        await new Promise(r => setTimeout(r, 800));
        const fx = document.querySelector('#thFx');
        fx.value = 'aurora'; fx.dispatchEvent(new Event('change'));
        const sp = document.querySelector('#thSpeed');
        sp.value = '1.8'; sp.dispatchEvent(new Event('input'));
        document.querySelector('#thApply').click();
        await new Promise(r => setTimeout(r, 800));
        const cs = getComputedStyle(document.documentElement);
        return { bg: cs.getPropertyValue('--bg').trim(), fx: document.documentElement.getAttribute('data-theme-fx'), speed: cs.getPropertyValue('--speed').trim() };
      })()`);
    if (r.bg === '#0c1424') ok('预设切换生效（极光 #0c1424）'); else bad('预设切换失败: ' + r.bg);
    if (r.fx === 'aurora') ok('背景动画切换为 aurora'); else bad('动画切换失败: ' + r.fx);
    if (r.speed === '1.8') ok('动画速度已应用（1.8）'); else bad('速度异常: ' + r.speed);

    console.log('\n[3] 导出 / 导入（非法 JSON 不得改动主题）');
    r = await win.webContents.executeJavaScript(
      `(async () => {
        document.querySelector('#thExport').click();
        await new Promise(r => setTimeout(r, 500));
        const exported = document.querySelector('#thJson').value;
        let parsed = null; try { parsed = JSON.parse(exported); } catch (_) {}
        const ta = document.querySelector('#thJson');
        ta.value = '{ broken json';
        document.querySelector('#thImport').click();
        await new Promise(r => setTimeout(r, 500));
        const afterBad = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
        ta.value = JSON.stringify({version:1, theme:{bg:'#fbf1f4', a:'#e0527c', b:'#7aa8e8', fx:'bubbles', speed:0.9, radius:18, blur:12}});
        document.querySelector('#thImport').click();
        await new Promise(r => setTimeout(r, 900));
        const cs = getComputedStyle(document.documentElement);
        return { exportedOk: !!(parsed && parsed.theme && parsed.theme.bg), afterBad, afterGood: cs.getPropertyValue('--bg').trim(), text: cs.getPropertyValue('--text').trim() };
      })()`);
    if (r.exportedOk) ok('导出 JSON 合法'); else bad('导出 JSON 异常');
    if (r.afterBad === '#0c1424') ok('非法 JSON 导入未改动当前主题'); else bad('非法导入改动了主题: ' + r.afterBad);
    if (r.afterGood === '#fbf1f4') ok('合法 JSON 导入生效（樱花 #fbf1f4）'); else bad('合法导入失败: ' + r.afterGood);
    if (r.text === '#1c2a33') ok('浅色主题正文色推算正确（#1c2a33）'); else bad('正文色异常: ' + r.text);

    console.log('\n[4] 主题文件只落 userData，不写安装目录');
    if (fs.existsSync(themeFile)) ok('主题文件落在隔离 userData: ' + themeFile);
    else bad('主题文件未生成');
    const installDir = path.dirname(path.dirname(asarPath));
    const stray = [];
    const scan = (dir, depth) => {
      if (depth > 2) return;
      let items = [];
      try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const it of items) {
        const p = path.join(dir, it.name);
        if (it.isFile() && it.name === 'theme.json') stray.push(p);
        else if (it.isDirectory()) scan(p, depth + 1);
      }
    };
    scan(installDir, 0);
    if (!stray.length) ok('安装目录内无 theme.json'); else bad('安装目录内出现 theme.json: ' + stray.join(', '));

    console.log('\n[5] 重启后主题保留');
    const win2 = await newWindow();
    r = await win2.webContents.executeJavaScript(
      `(async () => {
        document.querySelector('#nav button[data-page="theme"]').click();
        await new Promise(r => setTimeout(r, 700));
        const cs = getComputedStyle(document.documentElement);
        return { bg: cs.getPropertyValue('--bg').trim(), fx: document.documentElement.getAttribute('data-theme-fx'), speed: cs.getPropertyValue('--speed').trim() };
      })()`);
    if (r.bg === '#fbf1f4') ok('重启后主题保留（--bg=#fbf1f4）'); else bad('重启后主题丢失: ' + r.bg);
    if (r.fx === 'bubbles') ok('重启后动画设置保留（bubbles）'); else bad('重启后 fx 丢失: ' + r.fx);
    if (r.speed === '0.9') ok('重启后速度保留（0.9）'); else bad('重启后速度丢失: ' + r.speed);

    win2.destroy();
    win.destroy();
  } catch (e) {
    console.error('  ✗ 异常: ' + (e && e.stack || e));
    failed = 1;
  }
  console.log(failed ? '\nINSTALL_THEME_FAIL' : '\nINSTALL_THEME_OK');
  app.exit(failed);
});
