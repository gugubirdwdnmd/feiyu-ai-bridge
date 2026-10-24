'use strict';
/**
 * secretService.js —— secrets.json 的读取与写入（密钥保管在磁盘，供 bot 启动读取）。
 * 安全边界：
 *  - 绝不在返回值里直接打印明文；调用方展示前用 redact.js 脱敏。
 *  - 写入时尽量收紧文件权限（POSIX chmod 600；Windows 依赖 .gitignore + 用户数据目录隔离）。
 *  - 不把密钥写进任何导出/诊断包（导出由 importExportService 单独处理，且默认排除 secret）。
 *  - Electron safeStorage 的加解密由 main 进程在「内存↔磁盘」之间完成；本服务只负责明文文件读写。
 */
const fs = require('fs');
const path = require('path');

function secretPath(botDir) { return path.join(botDir, 'secrets.json'); }

function read(botDir) {
  const p = secretPath(botDir);
  if (!fs.existsSync(p)) return { exists: false, data: null, error: null };
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!data || typeof data !== 'object') return { exists: true, data: null, error: 'secrets.json 不是合法 JSON 对象' };
    return { exists: true, data, error: null };
  } catch (e) {
    return { exists: true, data: null, error: '读取失败: ' + e.message };
  }
}

function write(botDir, data) {
  if (!data || typeof data !== 'object') return { ok: false, error: '密钥数据必须是对象' };
  const p = secretPath(botDir);
  const tmp = p + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, p);
    // 收紧权限：POSIX 下 600；Windows 无等效原生命令，依赖 .gitignore 与目录隔离
    try { fs.chmodSync(p, 0o600); } catch (_) {}
    return { ok: true, path: p, error: null };
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    return { ok: false, error: e.message };
  }
}

/** 判断磁盘上是否存在可启动的密钥（apiKey 非空）。 */
function hasUsableKey(botDir) {
  const r = read(botDir);
  return !!(r.data && typeof r.data.apiKey === 'string' && r.data.apiKey.trim().length > 0);
}

module.exports = { secretPath, read, write, hasUsableKey };
