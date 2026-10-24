'use strict';
/**
 * installTestHelper.js —— 安装/升级/卸载验收的**纯逻辑**助手（可单测）。
 *
 * 用途：把「卸载后残留空目录导致重装失败」这类环境问题的**判定与处置策略**
 * 抽成可测的纯函数，供：
 *   - build/ 中的构建脚本（打包期 / 升级前检查）
 *   - 测试用例
 *   - 未来可能的「修复并重装」辅助流程
 *
 * 安全边界（重要）：
 *  - 只在**用户明确确认**且目录**确实为空**时才允许删除残留目录。
 *  - **绝不递归删除**含任何文件的目录（避免误删用户数据）。
 *  - **绝不**对机器人工作目录、发布副本做任何清理。
 *  - 目录不可读（权限不足）→ fail-closed，不做任何删除。
 *
 * 平台说明：本模块**会真实操作文件系统**（readdirSync / rmdirSync），
 * 因此路径解析使用**运行平台的** `path`（在 Windows 上即 Windows 语义）。
 * 「盘符根 / 目录根」的判定不依赖平台特有关键字：
 * 用 `path.parse(resolved).root` 取得该平台的根，再与解析结果比对，
 * 因此在 Windows（`C:\`）与 POSIX（`/`）下都能正确拒绝根目录。
 */
const fs = require('fs');
const path = require('path');

/** 受保护的目录名（任何情况下都不允许自动清理）。 */
const PROTECTED_NAMES = new Set([
  'napcat', 'napcat_publish', 'feiyu', 'feiyu-ai-bridge',
  'feiyu-desktop-control-center', 'users', 'windows', 'program files',
]);

/**
 * 判断一个路径是否可以安全地自动清理（仅空目录）。
 * 返回 {ok, reason, entries}
 *  - ok:true  → 目录存在、为空、且不在受保护名单里，可安全删除
 *  - ok:false → 给出明确原因（不存在 / 非空 / 权限不足 / 受保护 / 路径异常）
 */
function inspectResidualDir(dir, opts = {}) {
  const fsImpl = opts.fsImpl || fs;
  if (!dir || typeof dir !== 'string' || !dir.trim()) {
    return { ok: false, reason: 'invalid_path', detail: '路径为空或非法', entries: [] };
  }
  let resolved;
  try { resolved = path.resolve(dir); } catch (e) {
    return { ok: false, reason: 'invalid_path', detail: '路径无法解析: ' + e.message, entries: [] };
  }
  // 根目录 / 盘符根：绝不处理
  const parsed = path.parse(resolved);
  if (resolved === parsed.root || resolved === path.dirname(resolved)) {
    return { ok: false, reason: 'protected_path', detail: '拒绝处理文件系统根目录: ' + resolved, entries: [] };
  }
  // Windows 盘符根（如 C:\、D:/）与 UNC 根（如 \\server\share）：
  // 在 Windows 上已被上面的 root 判定覆盖，但 POSIX 平台的 path.parse('C:\\').root
  // 是 '/' 而非 'C:\'，会漏判。这里按**字面形态**再判一次，与平台无关。
  const raw = String(dir).trim();
  if (/^[A-Za-z]:[\\/]*$/.test(raw) || /^\\\\[^\\/]+[\\/][^\\/]+[\\/]*$/.test(raw)) {
    return { ok: false, reason: 'protected_path', detail: '拒绝处理文件系统根目录: ' + raw, entries: [] };
  }
  // 目录名（取最后一段，**去掉尾部分隔符**）。
  // POSIX 平台的 path.parse('NapCat\\').base 会带上尾反斜杠（'NapCat\\'），
  // 直接比对名单会漏判，因此这里统一剥掉分隔符再比。
  const base = String(parsed.base || '').replace(/[\\/]+$/, '').toLowerCase();
  if (PROTECTED_NAMES.has(base)) {
    return { ok: false, reason: 'protected_path', detail: '拒绝处理受保护目录: ' + resolved, entries: [] };
  }
  if (opts.isProtectedDir && opts.isProtectedDir(resolved)) {
    return { ok: false, reason: 'protected_path', detail: '拒绝处理受保护目录: ' + resolved, entries: [] };
  }

  let entries;
  try {
    entries = fsImpl.readdirSync(resolved);
  } catch (e) {
    // 权限不足 / 路径不存在 / IO 错误 → fail-closed，不做任何删除
    return {
      ok: false,
      reason: e && e.code === 'ENOENT' ? 'not_found' : 'not_readable',
      detail: (e && e.code === 'ENOENT') ? '目录不存在' : ('无法读取目录: ' + (e && e.message)),
      entries: [],
    };
  }
  // 隐藏的系统项（如 desktop.ini）也算残留内容 → 视为非空，安全起见
  if (entries.length) {
    return {
      ok: false,
      reason: 'not_empty',
      detail: '目录非空（含 ' + entries.length + ' 项），已保留不动',
      entries: entries.slice(0, 20),
    };
  }
  return { ok: true, reason: 'empty', detail: '目录为空，可安全清理', entries: [] };
}

/**
 * 清理卸载残留的空目录。
 * opts.confirm 必须为 true 才会真的删除（默认只报告）。
 * 返回 {ok, removed, reason, detail}
 */
function cleanupResidualDir(dir, opts = {}) {
  const fsImpl = opts.fsImpl || fs;
  const inspect = inspectResidualDir(dir, opts);
  if (!inspect.ok) return { ok: false, removed: false, reason: inspect.reason, detail: inspect.detail };
  if (!opts.confirm) {
    return { ok: true, removed: false, reason: 'dry_run', detail: inspect.detail };
  }
  try {
    fsImpl.rmdirSync(dir);
    return { ok: true, removed: true, reason: 'removed', detail: '已清理空目录: ' + dir };
  } catch (e) {
    return { ok: false, removed: false, reason: 'remove_failed', detail: '清理失败: ' + (e && e.message) };
  }
}

/**
 * 生成「重装前置检查」报告：把残留目录问题一次性讲清楚。
 * 供安装脚本/升级脚本在安装前调用。
 */
function preflightReinstall(installDir, opts = {}) {
  const inspect = inspectResidualDir(installDir, opts);
  return {
    installDir,
    safeToClean: inspect.ok,
    reason: inspect.reason,
    detail: inspect.detail,
    entries: inspect.entries,
    hint: inspect.ok
      ? '检测到卸载残留的空目录，可安全清理后重装'
      : (inspect.reason === 'not_empty'
        ? '目标目录非空：请人工确认内容后再处理，程序不会自动删除'
        : (inspect.reason === 'not_found' ? '目标目录不存在，可直接安装' : '无法确认目录状态：请人工检查')),
  };
}

module.exports = { PROTECTED_NAMES, inspectResidualDir, cleanupResidualDir, preflightReinstall };
