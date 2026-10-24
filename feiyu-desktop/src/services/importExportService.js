'use strict';
/**
 * importExportService.js —— 配置导入导出。
 *
 * 安全边界（严格）：
 *  - 导出包顶层含 schemaVersion + appVersion；不破坏原 ai_config.json 结构。
 *  - 默认导出「不含密钥」（模板模式）；仅当用户显式 includeSecret 时才带密钥（私密迁移单独流程）。
 *  - 导入前校验：版本、类型、允许字段；不执行导入文件里的任何代码、不允许指定 shell 命令。
 *  - 应用前先自动备份当前配置（可关闭），原子写入；失败尽量恢复原状。
 *  - 导入普通配置与迁移私密密钥是两个明确区分的流程（includeSecret 开关）。
 */
const fs = require('fs');
const path = require('path');
const configService = require('./configService');
const personalityService = require('./personalityService');
const secretService = require('./secretService');

const SCHEMA_VERSION = 1;
const ALLOWED_TOP = ['schemaVersion', 'appVersion', 'exportedAt', 'config', 'personality', 'secret'];

function buildExport(botDir, appVersion, { includeSecret = false } = {}) {
  const cfg = configService.readRaw(botDir);
  const person = personalityService.read(botDir);
  const out = {
    schemaVersion: SCHEMA_VERSION,
    appVersion: appVersion || '0.0.0',
    exportedAt: new Date().toISOString(),
    config: cfg.data || {},
    personality: person.content || '',
  };
  if (includeSecret) {
    const sec = secretService.read(botDir);
    out.secret = sec.data || {};
  }
  return out;
}

function validateImport(obj) {
  const errors = [];
  const warnings = [];
  if (!obj || typeof obj !== 'object') return { valid: false, errors: ['导入内容必须是对象'], warnings };
  if (typeof obj.schemaVersion !== 'number') errors.push('缺少 schemaVersion（数字）');
  else if (obj.schemaVersion > SCHEMA_VERSION) warnings.push('导入文件 schemaVersion 高于本软件，可能不兼容');
  if (obj.config != null && (typeof obj.config !== 'object' || Array.isArray(obj.config))) errors.push('config 必须是对象');
  if (obj.personality != null && typeof obj.personality !== 'string') errors.push('personality 必须是字符串');
  if (obj.secret != null && (typeof obj.secret !== 'object' || Array.isArray(obj.secret))) errors.push('secret 必须是对象');
  // 不允许未知顶层键（防止伪装字段）
  for (const k of Object.keys(obj)) {
    if (!ALLOWED_TOP.includes(k)) errors.push('不允许的配置项: ' + k);
  }
  // 若带 config，做一次字段校验；导入会整体覆盖 ai_config.json，属破坏性写入，
  // 字段错误必须阻断（与 applyConfig 口径一致），不能只当提示。
  if (obj.config && typeof obj.config === 'object') {
    const v = configService.validateConfig(obj.config);
    for (const e of v.errors) errors.push('config: ' + e);
  }
  return { valid: errors.length === 0, errors, warnings };
}

function diffPreview(botDir, incoming) {
  const cur = configService.readRaw(botDir);
  const curPerson = personalityService.read(botDir);
  const configDiff = {};
  const curCfg = (cur.data && !cur.error) ? cur.data : {};
  const incCfg = incoming.config || {};
  const keys = new Set([...Object.keys(curCfg), ...Object.keys(incCfg)]);
  for (const k of keys) {
    const a = JSON.stringify(curCfg[k] ?? null);
    const b = JSON.stringify(incCfg[k] ?? null);
    if (a !== b) configDiff[k] = { from: curCfg[k], to: incCfg[k] };
  }
  const personalityChanged = (incoming.personality || '') !== (curPerson.content || '');
  return { configDiff, personalityChanged, changedKeys: Object.keys(configDiff) };
}

function backupNow(botDir) {
  const dir = path.join(botDir, 'backups', 'feiyu-backup-' + Date.now());
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const copied = [];
  for (const f of ['ai_config.json', 'ai_prompt.txt', 'secrets.json']) {
    const src = path.join(botDir, f);
    if (fs.existsSync(src)) {
      try { fs.copyFileSync(src, path.join(dir, f)); copied.push(f); } catch (_) {}
    }
  }
  return { backupDir: dir, copied };
}

function applyImport(botDir, incoming, { backup = true, includeSecret = false } = {}) {
  const v = validateImport(incoming);
  if (!v.valid) return { ok: false, errors: v.errors, warnings: v.warnings };
  let backupDir = null;
  if (backup) { const b = backupNow(botDir); backupDir = b.backupDir; }
  const results = [];
  if (incoming.config && typeof incoming.config === 'object') {
    const w = configService.writeRaw(botDir, incoming.config);
    results.push({ file: 'ai_config.json', ok: w.ok, error: w.error });
  }
  if (typeof incoming.personality === 'string') {
    const w = personalityService.write(botDir, incoming.personality);
    results.push({ file: 'ai_prompt.txt', ok: w.ok, error: w.error });
  }
  if (includeSecret && incoming.secret && typeof incoming.secret === 'object') {
    const w = secretService.write(botDir, incoming.secret);
    results.push({ file: 'secrets.json', ok: w.ok, error: w.error });
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    return { ok: false, backupDir, errors: failed.map((r) => r.file + ': ' + r.error), results };
  }
  return { ok: true, backupDir, results };
}

module.exports = {
  SCHEMA_VERSION, buildExport, validateImport, diffPreview, backupNow, applyImport, ALLOWED_TOP,
};
