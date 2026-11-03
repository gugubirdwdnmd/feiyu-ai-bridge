'use strict';
/**
 * check-syntax.js —— 仓库级语法检查。
 *
 * 背景：原先根 package.json 的 `check` 脚本只列了 4 个文件
 * （ai_bridge.js / url_safety.js / safe_http.js / share_card.js），
 * 而 agent/、feiyu/、tools/、memory/、chat_record_parser/ 等目录下的
 * 数十个源码文件从未被语法检查覆盖 —— CI 跑 `check` 等于形同虚设。
 *
 * 本脚本遍历仓库内全部 .js 文件逐一做语法编译检查：
 *  - 排除 node_modules / .git / feiyu-desktop（桌面端有独立的 check 脚本）
 *  - 排除 dist / build 产物目录
 *  - 只做**语法**检查，不执行任何代码，不访问网络
 *
 * 运行：node build/check-syntax.js
 * 退出码：0 = 全部通过；1 = 有文件语法错误
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'feiyu-desktop', 'dist', 'backups', 'memory_log',
]);
// 这些是 .js 但不是源码（数据/日志目录里偶有 .js 备份），跳过
const SKIP_EXT = new Set(['.min.js']);

let checked = 0;
const errors = [];

function walk(dir) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const it of items) {
    if (it.name.startsWith('.') && it.name !== '.') {
      // 隐藏目录一律跳过（.git 等）
      if (it.isDirectory()) continue;
    }
    const p = path.join(dir, it.name);
    if (it.isDirectory()) {
      if (SKIP_DIRS.has(it.name)) continue;
      walk(p);
      continue;
    }
    if (!it.isFile()) continue;
    if (!it.name.endsWith('.js')) continue;
    if (SKIP_EXT.has(it.name)) continue;
    // 跳过可能的备份副本
    if (/\.(bak|orig|old)$/.test(it.name)) continue;
    check(p);
  }
}

function check(file) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  checked++;
  let src;
  try {
    src = fs.readFileSync(file, 'utf-8');
  } catch (e) {
    errors.push({ file: rel, message: '读取失败: ' + e.message });
    return;
  }
  // 用 vm.Script 只做编译（语法）检查，不执行
  try {
    // eslint-disable-next-line no-new
    new vm.Script(src, { filename: file });
  } catch (e) {
    errors.push({ file: rel, message: e.message });
  }
}

console.log('[语法检查] 扫描 ' + ROOT);
walk(ROOT);

if (errors.length) {
  console.error('\n✗ 发现 ' + errors.length + ' 个文件有语法错误：');
  for (const e of errors) console.error('  ' + e.file + '\n    ' + e.message);
  console.error('\nCHECK_SYNTAX_FAIL（已检查 ' + checked + ' 个文件）');
  process.exit(1);
}
console.log('✓ 全部通过（已检查 ' + checked + ' 个 .js 文件）');
console.log('\nCHECK_SYNTAX_OK');
