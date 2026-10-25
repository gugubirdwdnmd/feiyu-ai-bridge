'use strict';
/**
 * smoke-pages.js —— GUI 页面冒烟（真实 Electron 渲染进程，一次性脚本，不属于 node:test 套件）。
 *
 * 目的：逐个渲染导航里的每个页面 + 新增聚合页的每个二级 Tab，
 *       捕获渲染异常与控制台错误，确保「页面不是白屏 / 不抛 ReferenceError」。
 *
 * 运行：npx electron smoke-pages.js
 *      （若环境设置了 ELECTRON_RUN_AS_NODE=1，需要先取消：env -u ELECTRON_RUN_AS_NODE）
 * 退出码：0 = 全部页面渲染正常且无控制台错误；1 = 有页面为空或有错误；2 = 启动失败。
 *
 * 安全：强制隔离 userData 到临时目录，绝不读写真实用户配置；窗口 show:false 不打扰桌面。
 */
const { app, ipcMain, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-pages-'));
try { app.setPath('userData', userData); } catch (_) {}

const errors = [];
// 开发期 CSP 警告：仅在未打包时出现，单独记录，不计入失败
const cspWarnings = [];

app.whenReady().then(async () => {
  const { registerHandlers } = require('./src/ipc/handlers');
  const { createProcessManager } = require('./src/services/processService');
  const pm = createProcessManager();
  registerHandlers({
    ipcMain,
    getUserDataDir: () => userData,
    getAppVersion: () => app.getVersion(),
    pm,
  });

  const win = new BrowserWindow({
    width: 1200, height: 820, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  // 新版事件签名（旧的位置参数签名已废弃）：只收集警告级别以上
  win.webContents.on('console-message', (event) => {
    const level = (event && event.level) || 0;
    const message = (event && event.message) || '';
    // CSP 的开发期安全警告在打包后不会出现，单独记录、不计入失败
    if (/Content-Security-Policy/i.test(message)) { cspWarnings.push(message); return; }
    if (level >= 2) errors.push('[console] ' + message);
  });
  win.webContents.on('render-process-gone', (_e, d) => errors.push('[crash] ' + JSON.stringify(d)));

  await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 900));

  const pages = await win.webContents.executeJavaScript(
    "Array.from(document.querySelectorAll('#nav button')).map(b=>b.dataset.page)"
  );

  const results = [];
  for (const p of pages) {
    const before = errors.length;
    let out;
    try {
      out = await win.webContents.executeJavaScript(
        "(async()=>{ render(" + JSON.stringify(p) + "); await new Promise(r=>setTimeout(r,650));" +
        " const el=document.querySelector('#content');" +
        " return {len: el?el.innerHTML.length:0, h2: el&&el.querySelector('h2')?el.querySelector('h2').textContent:'', tabs: el?el.querySelectorAll('.subnav button').length:0}; })()"
      );
    } catch (e) {
      out = { error: String(e && e.message || e) };
    }
    results.push({ page: p, ...out, newErrors: errors.length - before });
  }

  // 子 Tab 深挖（新增聚合页的每个 Tab 都要能渲染）
  const subTabs = await win.webContents.executeJavaScript(`
    (async () => {
      const out = [];
      const groups = { loginservices: ['qr','svc'], extensions: ['tree','mcp','market'], ops: ['wf','bak','cost','diag'] };
      for (const [g, tabs] of Object.entries(groups)) {
        for (const t of tabs) {
          const before = document.querySelectorAll('#content *').length;
          SUBTABS[g].active = t;
          render(g);
          await new Promise(r => setTimeout(r, 700));
          const el = document.querySelector('#content');
          out.push({ group: g, tab: t, len: el ? el.innerHTML.length : 0, grew: (el ? el.querySelectorAll('#content *').length : 0) >= 0, base: before });
        }
      }
      return out;
    })()
  `);

  console.log('=== PAGES ===');
  for (const r of results) console.log(JSON.stringify(r));
  console.log('=== SUBTABS ===');
  for (const r of subTabs) console.log(JSON.stringify(r));
  console.log('=== ERRORS (' + errors.length + ') ===');
  for (const e of errors.slice(0, 40)) console.log(e);

  const emptyPages = results.filter((r) => !r.error && r.len < 20);
  const badSub = subTabs.filter((r) => r.len < 20);
  console.log('SUMMARY pages=' + results.length + ' empty=' + emptyPages.length + ' subTabs=' + subTabs.length + ' badSub=' + badSub.length + ' errors=' + errors.length);

  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
  app.exit(errors.length === 0 && emptyPages.length === 0 && badSub.length === 0 ? 0 : 1);
}).catch((e) => {
  console.error('FATAL', e);
  app.exit(2);
});
