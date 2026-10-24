'use strict';
/**
 * package-check.js —— 打包前检查脚本（CI / 发布前运行）。
 * 不擅自发布，只做静态合规校验：
 *  - Node 版本 >= 22
 *  - 关键源码存在
 *  - 仓库内不含真实 secrets.json / ai_config.json（防止把密钥打进包）
 *  - 依赖声明的 electron / electron-builder 已安装，且实际 electron 版本满足声明范围
 *  - lockfile 存在（保证 npm ci 可复现）
 *  - Electron 安全配置检查（contextIsolation / nodeIntegration / sandbox）
 *  - preload 不泄漏 fs / child_process / shell 等高危能力
 *  - 源码中不出现硬编码盘符路径（如 D:\NapCat_publish）
 *  - 打包清单（files）覆盖运行时所需目录
 * 失败以非 0 退出。
 */
const fs = require('fs');
const path = require('path');
const ROOT = __dirname.replace(/[\\/]build$/, '');
const errors = [];
const warnings = [];
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { errors.push(m); console.error('  ✗ ' + m); };
const warn = (m) => { warnings.push(m); console.log('  ! ' + m); };
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf-8'); } catch (_) { return ''; } };

// 1) Node 版本
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) bad('Node >= 22 需要，当前 ' + process.version); else ok('Node ' + process.version);

// 2) 关键源码存在
const REQUIRED = [
  'src/main.js', 'src/preload.js', 'src/ipc/handlers.js', 'src/services/ipcChannels.js',
  'src/services/credentialStore.js', 'src/services/providerService.js', 'src/services/providerApplyService.js',
  'src/services/personalityTemplateService.js', 'src/services/usageService.js', 'src/services/priceService.js',
  'renderer/index.html', 'renderer/renderer.js', 'renderer/styles.css',
];
for (const f of REQUIRED) {
  if (fs.existsSync(path.join(ROOT, f))) ok('存在 ' + f); else bad('缺失 ' + f);
}

// 3) 不应把真实机密打进包：仓库内不得有 secrets.json / ai_config.json
for (const f of ['secrets.json', 'ai_config.json', 'feiyu_provider_secrets.json', 'feiyu_providers.json']) {
  if (fs.existsSync(path.join(ROOT, f))) bad('仓库内含 ' + f + '（密钥/真实配置不得入库）'); else ok('未含 ' + f);
}

// 4) 依赖已安装 + Electron 版本与声明一致
let pkg = {};
try { pkg = JSON.parse(read('package.json')); } catch (_) { bad('package.json 不可解析'); }
for (const dep of ['electron', 'electron-builder']) {
  try { require.resolve(dep, { paths: [path.join(ROOT, 'node_modules')] }); ok('已安装 ' + dep); }
  catch (_) { bad('未安装 ' + dep + '（先 npm install）'); }
}
try {
  const declared = (pkg.devDependencies && pkg.devDependencies.electron) || '';
  const actual = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;
  const range = declared.replace('^', '').split('.').map(Number);
  const ver = actual.split('.').map(Number);
  const satisfies = ver[0] === range[0] && (range[1] === undefined || ver[1] >= range[1]);
  if (satisfies) ok('Electron 版本匹配：声明 ' + declared + '，实际 ' + actual);
  else bad('Electron 版本不匹配：声明 ' + declared + '，实际 ' + actual);
} catch (e) { warn('无法校验 Electron 版本：' + e.message); }

// 5) lockfile 存在（npm ci 可复现）
if (fs.existsSync(path.join(ROOT, 'package-lock.json'))) ok('package-lock.json 存在（npm ci 可复现）');
else bad('缺少 package-lock.json：无法用 npm ci 复现安装');

// 6) Electron 安全配置
const main = read('src/main.js');
if (/contextIsolation:\s*true/.test(main)) ok('contextIsolation: true'); else bad('main.js 未启用 contextIsolation');
if (/nodeIntegration:\s*false/.test(main)) ok('nodeIntegration: false'); else bad('main.js 未禁用 nodeIntegration');
if (/sandbox:\s*true/.test(main)) ok('sandbox: true'); else warn('未启用 renderer sandbox（当前 preload 只暴露 invoke，影响有限）');

// 7) preload 不泄漏高危能力
const preload = read('src/preload.js');
const leaks = ['require(\'fs\')', 'require("fs")', 'child_process', 'exec(', 'spawn(', 'shell.', 'ipcRenderer.send'];
const found = leaks.filter((k) => preload.includes(k));
if (found.length) bad('preload.js 疑似泄漏高危能力: ' + found.join(', ')); else ok('preload.js 未暴露 fs/child_process/shell');

// 8) 不硬编码开发机路径
const scanFiles = ['src/main.js', 'src/preload.js', 'src/ipc/handlers.js', 'renderer/renderer.js', 'src/services/configService.js', 'src/services/providerService.js'];
let hardcoded = [];
for (const f of scanFiles) {
  const txt = read(f);
  const m = txt.match(/[A-Za-z]:[\\/]NapCat_publish/g);
  if (m) hardcoded.push(f + ':' + m.length);
}
if (hardcoded.length) bad('源码含硬编码本机路径: ' + hardcoded.join(', ')); else ok('源码无硬编码本机路径');

// 9) 打包清单覆盖运行时目录
const files = (pkg.build && pkg.build.files) || [];
for (const need of ['src/**/*', 'renderer/**/*', 'package.json']) {
  if (files.includes(need)) ok('打包清单包含 ' + need); else bad('打包清单缺少 ' + need);
}

// 10) 卸载不删用户数据
const nsis = (pkg.build && pkg.build.nsis) || {};
if (nsis.deleteAppDataOnUninstall === false) ok('nsis.deleteAppDataOnUninstall=false（卸载保留用户数据）');
else warn('未显式设置 nsis.deleteAppDataOnUninstall=false，默认行为随 electron-builder 版本变化');

if (warnings.length) console.log('\n提示：' + warnings.length + ' 项非阻断警告');
if (errors.length) { console.error('\n打包前检查未通过：' + errors.length + ' 项'); process.exit(1); }
console.log('\n✅ 打包前检查通过');
