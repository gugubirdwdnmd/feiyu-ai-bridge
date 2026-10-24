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
  'src/services/skillService.js', 'src/services/comfyService.js',
  // v1.1.0 主题工坊
  'src/services/themeService.js',
  'renderer/index.html', 'renderer/renderer.js', 'renderer/styles.css', 'renderer/theme.js',
  'build/icon.ico', 'build/icon.png', 'build/make-icon.js',
];
for (const f of REQUIRED) {
  if (fs.existsSync(path.join(ROOT, f))) ok('存在 ' + f); else bad('缺失 ' + f);
}

// 3) 不应把真实机密打进包：仓库内不得有 secrets.json / ai_config.json
for (const f of ['secrets.json', 'ai_config.json', 'feiyu_provider_secrets.json', 'feiyu_providers.json', 'feiyu_personalities.json', 'feiyu_skills.json', 'theme.json']) {
  if (fs.existsSync(path.join(ROOT, f))) bad('仓库内含 ' + f + '（密钥/真实配置/用户数据不得入库）'); else ok('未含 ' + f);
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
const scanFiles = ['src/main.js', 'src/preload.js', 'src/ipc/handlers.js', 'renderer/renderer.js', 'src/services/configService.js', 'src/services/providerService.js', 'src/services/themeService.js', 'renderer/theme.js'];
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

// 11) 打包产物内容检查（若已构建）：产物内不得含密钥/配置/日志数据文件
const asarPath = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar');
if (fs.existsSync(asarPath)) {
  try {
    const asar = require(path.join(ROOT, 'node_modules', '@electron', 'asar'));
    const list = asar.listPackage(asarPath);
    const dataRe = /(^|[\\/])(secrets\.json|ai_config\.json|feiyu_provider_secrets\.json|feiyu_providers\.json|feiyu_personalities\.json|feiyu_skills\.json|theme\.json)$/i;
    const dataFiles = list.filter((f) => dataRe.test(f));
    const logFiles = list.filter((f) => /\.log$/i.test(f));
    if (dataFiles.length) bad('打包产物含数据文件: ' + dataFiles.join(', '));
    else ok('打包产物不含密钥/配置数据文件');
    if (logFiles.length) bad('打包产物含日志文件: ' + logFiles.join(', '));
    else ok('打包产物不含日志文件');
  } catch (e) {
    warn('无法检查打包产物内容: ' + e.message);
  }
} else {
  console.log('  · 尚未构建（无 dist/win-unpacked/resources/app.asar），跳过产物内容检查');
}

// 12) 机器人侧技能模块存在，且两侧工具白名单一致
// （不一致会导致「桌面能存、机器人拒收」的技能，界面看不出问题）
try {
  const botSkills = require(path.join(ROOT, '..', 'skills.js'));
  const deskSkills = require(path.join(ROOT, 'src', 'services', 'skillService.js'));
  const bot = Array.from(botSkills.ALLOWED_HANDLERS).sort();
  const desk = deskSkills.ALLOWED_HANDLERS.slice().sort();
  if (JSON.stringify(bot) === JSON.stringify(desk)) ok('技能工具白名单两侧一致（' + bot.length + ' 项）');
  else bad('技能工具白名单两侧不一致：bot=' + bot.join(',') + ' / desktop=' + desk.join(','));
  if (botSkills.ALLOWED_HANDLERS.has('remember')) bad('技能白名单含 remember（会写用户记忆，不应允许技能挂载）');
  else ok('技能白名单不含 remember');
} catch (e) {
  bad('无法校验技能白名单一致性: ' + e.message);
}

// 13) 主题工坊（v1.1.0）：CSS 变量齐全 + 主题页已进导航 + 主题只存 userData
try {
  const css = read('renderer/styles.css');
  const needVars = ['--bg', '--accent', '--accent2', '--surface', '--text', '--muted', '--radius', '--blur', '--speed'];
  const missVars = needVars.filter((v) => !css.includes(v + ':'));
  if (missVars.length) bad('styles.css 缺少 CSS 变量: ' + missVars.join(', '));
  else ok('styles.css 定义了全部主题 CSS 变量（' + needVars.length + ' 项）');

  const html = read('renderer/index.html');
  if (html.includes('data-page="theme"')) ok('导航含「主题工坊」入口');
  else bad('导航缺少主题页入口（data-page="theme"）');
  if (html.includes('theme.js')) ok('index.html 引入 renderer/theme.js');
  else bad('index.html 未引入 renderer/theme.js');

  const themeSvc = require(path.join(ROOT, 'src', 'services', 'themeService.js'));
  if (themeSvc.THEME_FILE === 'theme.json') ok('主题文件名固定为 theme.json');
  else bad('主题文件名应为 theme.json');
  if (themeSvc.FX_VALUES.join(',') === 'none,bubbles,aurora,waves') ok('背景动画枚举齐全（' + themeSvc.FX_VALUES.length + ' 项）');
  else bad('背景动画枚举不符: ' + themeSvc.FX_VALUES.join(','));

  // 主题服务不得引用 botDir 概念（必须与机器人目录分离）
  // 注意：只看代码，注释里为了说明隔离关系会提到 ai_config.json / secrets.json，
  // 因此先剥掉行注释与块注释再匹配。
  const themeSrc = read('src/services/themeService.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  if (/\bbotDir\b/.test(themeSrc)) bad('themeService.js 代码中引用了 botDir（主题必须与机器人目录分离）');
  else ok('themeService.js 代码不引用 botDir');
  if (/ai_config\.json|secrets\.json|feiyu_skills\.json/.test(themeSrc)) bad('themeService.js 代码中引用了机器人配置/密钥文件名');
  else ok('themeService.js 代码不引用 ai_config.json / secrets.json / feiyu_skills.json');
} catch (e) {
  bad('无法校验主题工坊: ' + e.message);
}

// 14) 应用图标：四处一致（安装包 / 便携版 / 窗口 / 快捷方式）
try {
  const icoPath = path.join(ROOT, 'build', 'icon.ico');
  const pngPath = path.join(ROOT, 'build', 'icon.png');
  const ico = fs.readFileSync(icoPath);
  // ICO 头：reserved(0) type(1) count
  if (ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1) {
    const count = ico.readUInt16LE(4);
    const sizes = [];
    for (let i = 0; i < count; i++) {
      const o = 6 + i * 16;
      const w = ico[o] === 0 ? 256 : ico[o];
      const h = ico[o + 1] === 0 ? 256 : ico[o + 1];
      if (w !== h) bad('ICO 尺寸非正方形: ' + w + 'x' + h);
      sizes.push(w);
    }
    if (sizes.indexOf(256) >= 0 && sizes.indexOf(32) >= 0 && sizes.indexOf(16) >= 0) {
      ok('build/icon.ico 含多尺寸（' + sizes.join('/') + '）');
    } else {
      bad('build/icon.ico 缺少常用尺寸（需含 16/32/256），实际: ' + sizes.join('/'));
    }
  } else {
    bad('build/icon.ico 头部非法（不是有效的 ICO 容器）');
  }

  const png = fs.readFileSync(pngPath);
  const isPng = png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4E && png[3] === 0x47;
  if (isPng) {
    const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
    if (w === 256 && h === 256) ok('build/icon.png 为 256×256 PNG');
    else bad('build/icon.png 尺寸异常: ' + w + '×' + h);
  } else {
    bad('build/icon.png 不是合法 PNG');
  }

  const win = (pkg.build && pkg.build.win) || {};
  if (win.icon === 'build/icon.ico') ok('electron-builder win.icon 指向 build/icon.ico');
  else bad('electron-builder win.icon 未指向 build/icon.ico: ' + win.icon);
  const nsis = (pkg.build && pkg.build.nsis) || {};
  const iconKeys = ['installerIcon', 'uninstallerIcon', 'installerHeaderIcon'];
  const missIcon = iconKeys.filter((k) => nsis[k] !== 'build/icon.ico');
  if (!missIcon.length) ok('NSIS 安装器/卸载器/标题栏图标均已配置');
  else bad('NSIS 图标未配置完整: ' + missIcon.join(', '));
  if (nsis.shortcutName) ok('开始菜单快捷方式名: ' + nsis.shortcutName);
  else warn('未设置 nsis.shortcutName');

  const mainSrc = read('src/main.js');
  if (/icon:\s*icon/.test(mainSrc)) ok('main.js 已为窗口设置图标');
  else bad('main.js 未给窗口设置图标');
} catch (e) {
  bad('无法校验应用图标: ' + e.message);
}

if (warnings.length) console.log('\n提示：' + warnings.length + ' 项非阻断警告');
if (errors.length) { console.error('\n打包前检查未通过：' + errors.length + ' 项'); process.exit(1); }
console.log('\n✅ 打包前检查通过');
