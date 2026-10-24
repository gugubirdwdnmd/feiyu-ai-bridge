'use strict';
/**
 * package-check.js —— 打包前检查脚本（CI / 发布前运行）。
 * 不擅自发布，只做静态合规校验：
 *  - Node 版本 >= 22
 *  - 关键源码存在
 *  - 仓库内不含真实 secrets.json / ai_config.json（防止把密钥打进包）
 *  - 依赖声明的 electron / electron-builder 已安装
 * 失败以非 0 退出。
 */
const fs = require('fs');
const path = require('path');
const ROOT = __dirname.replace(/[\\/]build$/, '');
const errors = [];
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { errors.push(m); console.error('  ✗ ' + m); };

// 1) Node 版本
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) bad('Node >= 22 需要，当前 ' + process.version); else ok('Node ' + process.version);

// 2) 关键源码存在
for (const f of ['src/main.js', 'src/preload.js', 'src/ipc/handlers.js', 'renderer/index.html', 'renderer/renderer.js']) {
  if (fs.existsSync(path.join(ROOT, f))) ok('存在 ' + f); else bad('缺失 ' + f);
}

// 3) 不应把真实机密打进包：仓库内不得有 secrets.json / ai_config.json
for (const f of ['secrets.json', 'ai_config.json']) {
  if (fs.existsSync(path.join(ROOT, f))) bad('仓库内含 ' + f + '（密钥/真实配置不得入库）'); else ok('未含 ' + f);
}

// 4) 依赖已安装
for (const dep of ['electron', 'electron-builder']) {
  try { require.resolve(dep, { paths: [path.join(ROOT, 'node_modules')] }); ok('已安装 ' + dep); }
  catch (_) { bad('未安装 ' + dep + '（先 npm install）'); }
}

if (errors.length) { console.error('\n打包前检查未通过：' + errors.length + ' 项'); process.exit(1); }
console.log('\n✅ 打包前检查通过');
