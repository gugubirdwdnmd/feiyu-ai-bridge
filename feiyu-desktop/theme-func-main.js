'use strict';
/**
 * theme-func-main.js —— 主题工坊功能端到端验证（Electron 运行时，一次性脚本）。
 *
 * 在**隔离的 userData** 下验证：
 *  1. 主题页可加载
 *  2. 切换预设 → 主题落盘 + CSS 变量同步变化
 *  3. 切换背景动画 → fx 参数落盘
 *  4. 导出 JSON → 内容合法
 *  5. 导入非法 JSON → 当前主题**不改动**
 *  6. 导入合法 JSON → 主题被替换
 *  7. 重启（重新读取 userData）→ 主题保留
 *
 * 运行：npx electron theme-func-main.js
 * 退出码：0 = 全部通过；1 = 有失败。
 */
const { app, ipcMain, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { CHANNELS } = require('./src/services/ipcChannels');
const themeService = require('./src/services/themeService');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed = 1; console.error('  ✗ ' + m); };

// 隔离 userData：绝不触碰真实用户数据目录
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-theme-func-'));
const userData = path.join(workDir, 'userData');
fs.mkdirSync(userData, { recursive: true });
try { app.setPath('userData', userData); } catch (_) {}

function registerAll() {
  const { registerHandlers } = require('./src/ipc/handlers');
  const { createProcessManager } = require('./src/services/processService');
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
      preload: path.join(__dirname, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

app.whenReady().then(async () => {
  try {
    registerAll();

    // ---------- 第一轮：交互 ----------
    let win = await newWindow();
    console.log('\n[1] 主题页加载');
    let r = await win.webContents.executeJavaScript(
      `(async () => {
        document.querySelector('#nav button[data-page="theme"]').click();
        await new Promise(r => setTimeout(r, 500));
        return { title: (document.querySelector('#content h2')||{}).textContent, presets: document.querySelectorAll('[data-preset]').length };
      })()`);
    if (r.title === '主题工坊') ok('主题页标题正确'); else bad('主题页标题异常: ' + r.title);
    if (r.presets === 6) ok('渲染出 6 套配色预设'); else bad('预设数量异常: ' + r.presets);

    console.log('\n[2] 切换预设（极光）');
    r = await win.webContents.executeJavaScript(
      `(async () => {
        const b = document.querySelector('[data-preset="aurora"]');
        b.click();
        await new Promise(r => setTimeout(r, 700));
        const cs = getComputedStyle(document.documentElement);
        return { bg: cs.getPropertyValue('--bg').trim(), accent: cs.getPropertyValue('--accent').trim(), text: cs.getPropertyValue('--text').trim() };
      })()`);
    if (r.bg === '#0c1424') ok('--bg 已切换为极光背景 #0c1424'); else bad('--bg 未切换: ' + r.bg);
    if (r.accent === '#7cf7c4') ok('--accent 已切换为 #7cf7c4'); else bad('--accent 未切换: ' + r.accent);
    if (r.text === '#e8f1f5') ok('--text 推算为深色主题正文色 #e8f1f5'); else bad('--text 异常: ' + r.text);

    const themeFile = path.join(app.getPath('userData'), themeService.THEME_FILE);
    if (fs.existsSync(themeFile)) ok('主题已落盘到隔离 userData: ' + themeFile);
    else bad('主题文件未生成');
    let onDisk = JSON.parse(fs.readFileSync(themeFile, 'utf-8'));
    if (onDisk.bg === '#0c1424' && onDisk.a === '#7cf7c4') ok('落盘内容与界面一致');
    else bad('落盘内容异常: ' + JSON.stringify(onDisk));

    console.log('\n[3] 切换背景动画（waves）+ 调整速度/圆角');
    r = await win.webContents.executeJavaScript(
      `(async () => {
        const fx = document.querySelector('#thFx');
        fx.value = 'waves'; fx.dispatchEvent(new Event('change'));
        const sp = document.querySelector('#thSpeed');
        sp.value = '2.0'; sp.dispatchEvent(new Event('input'));
        const rd = document.querySelector('#thRadius');
        rd.value = '24'; rd.dispatchEvent(new Event('input'));
        const bl = document.querySelector('#thBlur');
        bl.value = '20'; bl.dispatchEvent(new Event('input'));
        document.querySelector('#thApply').click();
        await new Promise(r => setTimeout(r, 700));
        const cs = getComputedStyle(document.documentElement);
        return { speed: cs.getPropertyValue('--speed').trim(), radius: cs.getPropertyValue('--radius').trim(), blur: cs.getPropertyValue('--blur').trim(), fx: document.documentElement.getAttribute('data-theme-fx') };
      })()`);
    if (r.fx === 'waves') ok('背景动画切换为 waves'); else bad('动画切换失败: ' + r.fx);
    if (r.speed === '2') ok('--speed = 2'); else bad('--speed 异常: ' + r.speed);
    if (r.radius === '24px') ok('--radius = 24px'); else bad('--radius 异常: ' + r.radius);
    if (r.blur === '20px') ok('--blur = 20px'); else bad('--blur 异常: ' + r.blur);
    onDisk = JSON.parse(fs.readFileSync(themeFile, 'utf-8'));
    if (onDisk.fx === 'waves' && onDisk.speed === 2 && onDisk.radius === 24 && onDisk.blur === 20) ok('动画与外观参数已落盘');
    else bad('落盘参数异常: ' + JSON.stringify(onDisk));

    console.log('\n[4] 导出主题 JSON');
    r = await win.webContents.executeJavaScript(
      `(async () => {
        document.querySelector('#thExport').click();
        await new Promise(r => setTimeout(r, 500));
        const t = document.querySelector('#thJson').value;
        return { json: t };
      })()`);
    let exported = null;
    try { exported = JSON.parse(r.json); } catch (_) {}
    if (exported && exported.theme && exported.theme.bg === '#0c1424') ok('导出 JSON 合法且内容正确');
    else bad('导出 JSON 异常: ' + String(r.json).slice(0, 120));

    console.log('\n[5] 导入非法 JSON → 当前主题不得改动');
    const beforeHash = fs.readFileSync(themeFile, 'utf-8');
    r = await win.webContents.executeJavaScript(
      `(async () => {
        const ta = document.querySelector('#thJson');
        ta.value = '{ this is not valid json';
        document.querySelector('#thImport').click();
        await new Promise(r => setTimeout(r, 500));
        const cs = getComputedStyle(document.documentElement);
        return { msg: (document.querySelector('#thJsonMsg')||{}).textContent || '', bg: cs.getPropertyValue('--bg').trim() };
      })()`);
    if (r.bg === '#0c1424') ok('界面主题未被非法导入改动'); else bad('非法导入改动了主题: ' + r.bg);
    if (/导入失败/.test(r.msg)) ok('界面给出导入失败提示: ' + r.msg.trim().slice(0, 60));
    else bad('缺少导入失败提示: ' + r.msg);
    if (fs.readFileSync(themeFile, 'utf-8') === beforeHash) ok('磁盘主题文件未被非法导入改动');
    else bad('磁盘主题文件被非法导入改动');

    console.log('\n[6] 导入合法 JSON → 主题被替换');
    r = await win.webContents.executeJavaScript(
      `(async () => {
        const ta = document.querySelector('#thJson');
        ta.value = JSON.stringify({version:1, theme:{bg:'#eef3e6', a:'#4f8a3c', b:'#d9a441', fx:'none', speed:0.5, radius:8, blur:2}});
        document.querySelector('#thImport').click();
        await new Promise(r => setTimeout(r, 800));
        const cs = getComputedStyle(document.documentElement);
        return { bg: cs.getPropertyValue('--bg').trim(), text: cs.getPropertyValue('--text').trim(), muted: cs.getPropertyValue('--muted').trim(), radius: cs.getPropertyValue('--radius').trim() };
      })()`);
    if (r.bg === '#eef3e6') ok('浅色主题已应用（--bg = #eef3e6）'); else bad('浅色主题未应用: ' + r.bg);
    if (r.text === '#1c2a33') ok('浅色主题正文色推算为 #1c2a33'); else bad('浅色正文色异常: ' + r.text);
    if (r.muted === '#5d7280') ok('浅色主题次要文字色推算为 #5d7280'); else bad('浅色 muted 异常: ' + r.muted);
    if (r.radius === '8px') ok('圆角随导入生效'); else bad('圆角未生效: ' + r.radius);

    console.log('\n[7] 重启后主题保留（重新读取同一 userData）');
    // 注意：Electron 默认在最后一个窗口关闭时退出应用，
    // 因此必须先创建新窗口再销毁旧窗口，否则应用会提前退出。
    const win2 = await newWindow();
    r = await win2.webContents.executeJavaScript(
      `(async () => {
        document.querySelector('#nav button[data-page="theme"]').click();
        await new Promise(r => setTimeout(r, 600));
        const cs = getComputedStyle(document.documentElement);
        return { bg: cs.getPropertyValue('--bg').trim(), fx: document.documentElement.getAttribute('data-theme-fx') };
      })()`);
    if (r.bg === '#eef3e6') ok('重启后主题保留（--bg = #eef3e6）'); else bad('重启后主题丢失: ' + r.bg);
    if (r.fx === 'none') ok('重启后动画设置保留（fx = none）'); else bad('重启后 fx 丢失: ' + r.fx);

    console.log('\n[8] 恢复默认');
    r = await win2.webContents.executeJavaScript(
      `(async () => {
        document.querySelector('#thReset').click();
        await new Promise(r => setTimeout(r, 800));
        const cs = getComputedStyle(document.documentElement);
        return { bg: cs.getPropertyValue('--bg').trim(), fx: document.documentElement.getAttribute('data-theme-fx') };
      })()`);
    if (r.bg === '#0b1d2a') ok('恢复默认背景 #0b1d2a'); else bad('恢复默认失败: ' + r.bg);
    if (r.fx === 'bubbles') ok('恢复默认动画 bubbles'); else bad('恢复默认动画失败: ' + r.fx);

    win2.destroy();
    win.destroy();
  } catch (e) {
    console.error('  ✗ 异常: ' + (e && e.stack || e));
    failed = 1;
  }

  console.log(failed ? '\nTHEME_FUNC_FAIL' : '\nTHEME_FUNC_OK');
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
  app.exit(failed);
});
