'use strict';
/**
 * apply-icon.js —— 构建后给主程序 exe 注入应用图标（后处理步骤）。
 *
 * 背景：
 *  `electron-builder --win ... -c.win.signAndEditExecutable=false` 会**同时**跳过
 *  「签名」与「rcedit 编辑（写入 exe 图标/版本信息）」两步 —— 于是产物里
 *  主程序仍是 Electron 默认图标（NSIS 安装包 / 便携版有自己的图标设置，不受影响）。
 *
 *  本脚本用 electron-builder 缓存里的 rcedit-x64.exe 单独补上这一步：
 *  对 win-unpacked 的主程序 exe 执行 `--set-icon build/icon.ico`。
 *  rcedit 只改 PE 资源，不涉及签名，因此不影响「不做代码签名」的决定。
 *
 * 用法：node build/apply-icon.js <产物目录>
 * 退出码：0 = 成功；1 = 失败。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.resolve(process.argv[2] || 'dist');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed = 1; console.error('  ✗ ' + m); };

/** 定位 rcedit：优先用 electron-builder 缓存里的官方副本。 */
function findRcedit() {
  const cacheRoot = process.env.ELECTRON_BUILDER_CACHE ||
    path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache');
  const cacheDir = path.join(cacheRoot, 'winCodeSign');
  if (!fs.existsSync(cacheDir)) return null;
  // 缓存下有多个版本目录（按内容哈希命名），找最新的一个含 rcedit-x64.exe
  const dirs = fs.readdirSync(cacheDir)
    .map((d) => ({ d, t: fs.statSync(path.join(cacheDir, d)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { d } of dirs) {
    const p = path.join(cacheDir, d, 'rcedit-x64.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function main() {
  console.log('\n[注入应用图标] 产物目录: ' + DIST + '\n');

  const ico = path.join(ROOT, 'build', 'icon.ico');
  if (!fs.existsSync(ico)) { bad('缺少 build/icon.ico'); return; }
  ok('图标源: build/icon.ico');

  const rcedit = findRcedit();
  if (!rcedit) {
    bad('未找到 rcedit-x64.exe（electron-builder 缓存缺失）；'
      + '请先成功跑过一次 electron-builder 以填充缓存');
    return;
  }
  ok('rcedit: ' + rcedit);

  const targets = [
    ['安装版主程序', path.join(DIST, 'win-unpacked', '玄枢 XUANSHU.exe')],
  ];
  for (const [name, file] of targets) {
    if (!fs.existsSync(file)) { bad(name + ' 不存在: ' + file); continue; }
    try {
      execFileSync(rcedit, [file, '--set-icon', ico], { stdio: 'pipe' });
      ok(name + ' 已注入图标（' + path.basename(file) + '）');
    } catch (e) {
      const msg = (e.stderr && e.stderr.toString()) || e.message;
      bad(name + ' 注入图标失败: ' + msg.trim().split('\n').slice(-3).join(' '));
    }
  }
}

main();
console.log(failed ? '\nAPPLY_ICON_FAIL' : '\nAPPLY_ICON_OK');
process.exit(failed ? 1 : 0);
