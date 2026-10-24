'use strict';
/**
 * install-preflight.js —— 重装/升级前的目录状态预检 CLI。
 *
 * 用法：
 *   node build/install-preflight.js <installDir> [--clean]
 *
 * 行为：
 *   - 默认只**报告**残留目录状态（不改任何东西）。
 *   - 加 --clean 时，仅当目录**确实为空**且不在受保护名单里，才会删除它。
 *     非空 / 权限不足 / 受保护 → 一律拒绝并说明原因。
 *   - 绝不递归删除；绝不碰机器人工作目录、发布副本、安装目录自身。
 *
 * 退出码：
 *   0 = 可以安装（目录不存在或为空）
 *   1 = 需要人工处理（非空 / 受保护 / 不可读）
 *   2 = 参数错误
 */
const path = require('path');
const helper = require('./installTestHelper');

function main(argv) {
  const args = argv.slice(2);
  if (!args.length || args[0] === '--help' || args[0] === '-h') {
    console.log('用法: node build/install-preflight.js <installDir> [--clean]');
    console.log('');
    console.log('  <installDir>  安装目标目录（NSIS /D= 参数用的那个）');
    console.log('  --clean       确认后清理「空的」残留目录（非空则拒绝）');
    return 2;
  }
  const dir = args[0];
  const doClean = args.includes('--clean');

  const pf = helper.preflightReinstall(dir);
  console.log('安装目标目录 : ' + pf.installDir);
  console.log('状态         : ' + pf.reason);
  console.log('说明         : ' + pf.detail);
  if (pf.entries && pf.entries.length) {
    console.log('残留条目     : ' + pf.entries.join(', '));
  }
  console.log('建议         : ' + pf.hint);

  if (doClean) {
    const r = helper.cleanupResidualDir(dir, { confirm: true });
    console.log('');
    console.log('清理结果     : ' + (r.ok ? (r.removed ? '已删除空目录' : '无需清理') : '拒绝清理'));
    if (!r.ok) console.log('原因         : ' + r.reason + ' — ' + r.detail);
    if (!r.ok) return 1;
  }

  return pf.safeToClean || pf.reason === 'not_found' ? 0 : 1;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { main };
