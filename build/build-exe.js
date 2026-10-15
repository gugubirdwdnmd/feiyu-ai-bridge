/**
 * build/build-exe.js —— 把 ai_bridge.js 及其本地模块打成一个 exe（dist/qq-ai-bot.exe）。
 *
 * 用法：node build/build-exe.js   （要求 Node >= 20；首次运行需要网络拉取 esbuild / postject）
 *
 * 原理（Node 22 官方 SEA，分两步）：
 *   1. esbuild 把 ai_bridge.js + 全部本地 require 捆成单文件 build/sea-bundle.js
 *      （SEA 只打包 main 单个文件，不解析应用自身的相对 require，必须先捆）
 *   2. 生成 sea-config.json（main = build/sea-bundle.js）
 *   3. node --experimental-sea-config → sea-prep.blob（注入用的 JS 包）
 *   4. 复制当前 node 二进制为 dist/qq-ai-bot.exe
 *   5. postject 把 blob 注入 exe（NODE_SEA_BLOB 资源 + NODE_SEA_FUSE 哨兵）
 *
 * 运行时 exe 仍在同目录读写 ai_config.json / secrets.json / memory/ / workspace/，
 * 所以发布时把这些（可写）文件和 exe 放一起即可（__dirname 在 SEA 中指向 exe 所在目录）。
 */
'use strict';
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const BUNDLE = path.join(__dirname, 'sea-bundle.js');
const BLOB = path.join(ROOT, 'sea-prep.blob');   // 与 sea-config 的 output 一致（相对 cwd=ROOT）
const SEA_CONFIG = path.join(__dirname, 'sea-config.json');
const EXE = path.join(DIST, 'qq-ai-bot.exe');
// Node SEA 熔断哨兵：不同 Node 版本可能不同，构建时从 node 二进制自动探测，失败再用已知默认值
function detectFuse(binPath) {
  try {
    const s = fs.readFileSync(binPath).toString('latin1');
    const m = s.match(/NODE_SEA_FUSE_[0-9a-f]+/);
    return m ? m[0] : null;
  } catch (e) { return null; }
}
const FUSE = detectFuse(process.execPath) || 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.error('需要 Node >= 20（推荐 22），当前：' + process.version);
  process.exit(1);
}

function run(cmd, opts) {
  console.log('  $ ' + cmd);
  execSync(cmd, Object.assign({ stdio: 'inherit', cwd: ROOT }, opts || {}));
}

// 1) esbuild 捆成单文件（项目零第三方依赖：本地模块 + Node 内置模块，无需 external）
console.log('[1/5] esbuild 捆包（node ' + process.version + '）');
const r1 = spawnSync('npx', ['--yes', 'esbuild', 'ai_bridge.js',
  '--bundle', '--platform=node', '--format=cjs', '--target=node22',
  '--outfile=build/sea-bundle.js'], { stdio: 'inherit', cwd: ROOT, shell: true });
if (r1.status !== 0 || !fs.existsSync(BUNDLE)) { console.error('esbuild 捆包失败'); process.exit(1); }
console.log('  → ' + BUNDLE + ' (' + Math.round(fs.statSync(BUNDLE).size / 1024) + ' KB)');

// 2) sea-config
const seaConfig = {
  main: 'build/sea-bundle.js',
  output: 'sea-prep.blob',
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: true,
};
fs.writeFileSync(SEA_CONFIG, JSON.stringify(seaConfig, null, 2));
console.log('[2/5] 生成 sea-config.json（main=build/sea-bundle.js）');

// 3) 生成 blob（用当前 node，保证版本匹配）
console.log('[3/5] 生成 sea-prep.blob');
run('"' + process.execPath + '" --experimental-sea-config "' + SEA_CONFIG + '"');
if (!fs.existsSync(BLOB)) { console.error('sea-prep.blob 未生成'); process.exit(1); }

// 4) 复制 node 二进制
fs.mkdirSync(DIST, { recursive: true });
fs.copyFileSync(process.execPath, EXE);
console.log('[4/5] 复制运行时 → ' + EXE + ' (' + Math.round(fs.statSync(EXE).size / 1048576) + ' MB)');

// 5) postject 注入（本地没有就用 npx 临时拉）
//    新版 postject 用法：postject <exe> <resource_name> <resource>，Node SEA 的资源名固定 NODE_SEA_BLOB
console.log('[5/5] 注入 blob（postject）');
const INJECT_ARGS = [EXE, 'NODE_SEA_BLOB', BLOB, '--sentinel-fuse', FUSE, '--overwrite'];
let injected = false;
try {
  const localPostject = path.join(ROOT, 'node_modules', 'postject', 'postject.js');
  if (fs.existsSync(localPostject)) {
    run('"' + process.execPath + '" "' + localPostject + '" ' + INJECT_ARGS.map((a) => '"' + a + '"').join(' '));
    injected = true;
  }
} catch (e) { /* 落到 npx */ }
if (!injected) {
  const r = spawnSync('npx', ['--yes', 'postject'].concat(INJECT_ARGS), { stdio: 'inherit', cwd: ROOT, shell: true });
  injected = r.status === 0;
}
if (!injected) { console.error('postject 注入失败'); process.exit(1); }

console.log('\n✅ 打包完成：' + EXE);
console.log('   运行时把 ai_config.json / secrets.json 放到 exe 同目录，双击即可运行（端口 3001）。');
