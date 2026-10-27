'use strict';
/**
 * after-pack-icon.js —— electron-builder 的 afterPack 钩子：给主程序 exe 注入应用图标。
 *
 * 为什么需要：
 *  `-c.win.signAndEditExecutable=false` 会**同时**跳过「签名」与「rcedit 编辑
 *  （写入 exe 图标/版本信息）」，于是 win-unpacked 主程序仍是 Electron 默认图标。
 *  而 NSIS 安装包 / 便携版是**基于 win-unpacked 打包**的 —— 必须在 afterPack 阶段
 *  （即 win-unpacked 生成后、NSIS 打包前）注入图标，三处才会一致。
 *
 * 用 electron-builder 缓存里的 rcedit-x64.exe 执行 `--set-icon build/icon.ico`。
 * rcedit 只改 PE 资源，不涉及签名，因此不影响「不做代码签名」的决定。
 *
 * 失败不阻断构建（图标不是功能必需），但会打印醒目警告。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** 定位 rcedit：优先用 electron-builder 缓存里的官方副本。 */
function findRcedit() {
  const cacheRoot = process.env.ELECTRON_BUILDER_CACHE ||
    path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache');
  const cacheDir = path.join(cacheRoot, 'winCodeSign');
  if (!fs.existsSync(cacheDir)) return null;
  const dirs = fs.readdirSync(cacheDir)
    .map((d) => ({ d, t: fs.statSync(path.join(cacheDir, d)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { d } of dirs) {
    const p = path.join(cacheDir, d, 'rcedit-x64.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

module.exports = async function afterPackIcon(context) {
  const appOutDir = context && context.appOutDir;
  if (!appOutDir) return;
  if (context.electronPlatformName && context.electronPlatformName !== 'win32') return;

  const ROOT = path.join(__dirname, '..');
  const ico = path.join(ROOT, 'build', 'icon.ico');
  if (!fs.existsSync(ico)) {
    console.warn('  ! afterPack: 缺少 build/icon.ico，跳过图标注入');
    return;
  }
  // 主程序 exe：与 package.json 的 productName 一致
  const exeName = '玄枢 XUANSHU.exe';
  const exe = path.join(appOutDir, exeName);
  if (!fs.existsSync(exe)) {
    console.warn('  ! afterPack: 未找到 ' + exeName + '，跳过图标注入');
    return;
  }
  const rcedit = findRcedit();
  if (!rcedit) {
    console.warn('  ! afterPack: 未找到 rcedit-x64.exe，跳过图标注入');
    return;
  }
  try {
    execFileSync(rcedit, [exe, '--set-icon', ico], { stdio: 'pipe' });
    console.log('  • afterPack: 已注入应用图标 → ' + exeName);
  } catch (e) {
    const msg = (e.stderr && e.stderr.toString()) || e.message;
    console.warn('  ! afterPack: 图标注入失败（不阻断构建）: ' + msg.trim().split('\n').slice(-2).join(' '));
  }
};
