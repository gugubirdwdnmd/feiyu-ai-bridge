'use strict';
/**
 * credentialStore.js —— 桌面侧密钥的加密存储封装（基于 Electron safeStorage）。
 *
 * 仅用于保护「桌面管理的多 Provider 密钥」(feiyu_provider_secrets.json)：
 *  - Windows 下 safeStorage 使用系统 DPAPI（CryptProtectData），密钥与当前用户会话绑定，
 *    比明文文件 + chmod 600 提供更强的静态保护（chmod 600 在 Windows 上并不提供等效保护）。
 *  - macOS / Linux 需系统密钥环；不可用时 safeStorage.isEncryptionAvailable() 为 false，
 *    此时 makeProviderCodec() 返回 null，providerService 退化为明文存储（与之前行为一致）。
 *
 * 重要边界：bot 的 secrets.json 必须保持明文（bot 进程独立、无 safeStorage，且需明文调用 API）。
 * 本模块只加密桌面侧多 Provider 密钥；应用 Provider 时由 providerService 解密后再写回明文 secrets.json。
 *
 * electron 采用惰性加载：纯 Node（node:test）环境下 require 本模块不会失败，
 * available() 返回 false，makeProviderCodec() 返回 null（明文回退）。
 */
let _safeStorage = null;
function safeStorageRef() {
  if (_safeStorage !== null) return _safeStorage;
  try { _safeStorage = require('electron').safeStorage || null; }
  catch (_) { _safeStorage = null; }
  return _safeStorage;
}

function available() {
  try {
    const ss = safeStorageRef();
    if (!ss) return false;
    // 新版 Electron（>=45）提供 isAsyncEncryptionAvailable；同步版 isEncryptionAvailable 已废弃。
    // 若只有异步版，available() 无法同步判定，保守返回 false（明文回退）；
    // 需要准确状态请用 availableAsync() / makeProviderCodecAsync()。
    if (typeof ss.isAsyncEncryptionAvailable === 'function') return false;
    if (typeof ss.isEncryptionAvailable === 'function') return !!ss.isEncryptionAvailable();
    return false;
  } catch (_) { return false; }
}

/**
 * 异步版本的可用性判定（推荐）：优先使用新版 isAsyncEncryptionAvailable，
 * 旧版回退同步的 isEncryptionAvailable。返回 Promise<boolean>。
 */
async function availableAsync() {
  try {
    const ss = safeStorageRef();
    if (!ss) return false;
    if (typeof ss.isAsyncEncryptionAvailable === 'function') return !!(await ss.isAsyncEncryptionAvailable());
    if (typeof ss.isEncryptionAvailable === 'function') return !!ss.isEncryptionAvailable();
    return false;
  } catch (_) { return false; }
}

/** 构造 codec（不重复做可用性判定，由调用方负责）。 */
function buildCodec() {
  const ss = safeStorageRef();
  if (!ss) return null;
  try {
    return {
      encrypt: (plain) => ss.encryptString(String(plain)).toString('base64'),
      decrypt: (cipher) => ss.decryptString(Buffer.from(String(cipher), 'base64')),
    };
  } catch (_) { return null; }
}

/** 生成加解密 codec；环境不支持时返回 null（明文回退）。 */
function makeProviderCodec() {
  if (!available()) return null;
  return buildCodec();
}

/** 推荐入口：异步判定可用性后再构造 codec（避免调用已废弃的同步 API）。 */
async function makeProviderCodecAsync() {
  if (!(await availableAsync())) return null;
  return buildCodec();
}

module.exports = { available, availableAsync, makeProviderCodec, makeProviderCodecAsync };
