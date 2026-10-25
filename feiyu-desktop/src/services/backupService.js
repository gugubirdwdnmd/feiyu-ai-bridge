'use strict';
/**
 * backupService.js —— 配置备份 / 恢复 / 升级保护（模块 G）。
 *
 * 设计要点：
 *  - 备份目录固定在 `<botDir>/feiyu-desktop-backups/bak-<时间戳>/`，每份备份带 manifest.json。
 *  - **默认排除秘密文件**（secrets.json / feiyu_provider_secrets.json）；只有用户显式
 *    includeSecret 才纳入，且 manifest 里标明 `includeSecret:true` 以便恢复时警示。
 *  - 恢复前**先做一次差异预览**（diffBackup）：逐文件 added/removed/changed/same，
 *    并对「备份比当前旧」「备份含密钥」给出警告。
 *  - 恢复是破坏性写入：先自动生成 pre-restore 快照（含当前所有白名单文件），
 *    再逐文件原子写入（临时文件 + rename），任一失败立即回滚已写文件。
 *
 * 安全边界：
 *  - 备份 id 严格白名单校验（防路径穿越）；解析后的目录必须仍在备份根内。
 *  - 绝不跨出 botDir 读写；不删除用户其它文件。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BACKUP_ROOT = 'feiyu-desktop-backups';
const MANIFEST = 'manifest.json';
const SCHEMA_VERSION = 1;

/** 可备份的普通配置白名单（相对 botDir）。 */
const BACKUP_FILES = [
  'ai_config.json',
  'ai_prompt.txt',
  'feiyu_skills.json',
  'feiyu_personalities.json',
  'feiyu_providers.json',
  'feiyu_services.json',
  'feiyu_mcp.json',
  'feiyu_workflows.json',
];

/** 秘密文件：默认不备份。 */
const SECRET_FILES = ['secrets.json', 'feiyu_provider_secrets.json'];

const ID_RE = /^bak-[A-Za-z0-9_-]{1,64}$/;

function sha256(buf) { try { return crypto.createHash('sha256').update(buf).digest('hex'); } catch (_) { return ''; } }

function stamp(d) {
  const t = d instanceof Date ? d : new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return t.getFullYear() + p(t.getMonth() + 1) + p(t.getDate()) + '-' + p(t.getHours()) + p(t.getMinutes()) + p(t.getSeconds()) + '-' + p(t.getMilliseconds(), 3);
}

function backupRootOf(botDir) { return path.join(botDir, BACKUP_ROOT); }

function isValidId(id) { return typeof id === 'string' && ID_RE.test(id); }

/** 把 id 解析为绝对目录，并确认仍在备份根内（防 ../ 穿越）。 */
function resolveBackupDir(botDir, id) {
  if (!isValidId(id)) return null;
  const root = path.resolve(backupRootOf(botDir));
  const full = path.resolve(root, id);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

/** 读取 manifest；损坏时返回 error。 */
function readManifest(botDir, id, fsImpl = fs) {
  const dir = resolveBackupDir(botDir, id);
  if (!dir) return { ok: false, error: '非法备份 id' };
  const p = path.join(dir, MANIFEST);
  try {
    const o = JSON.parse(fsImpl.readFileSync(p, 'utf-8'));
    if (!o || typeof o !== 'object') return { ok: false, error: '备份清单损坏' };
    return { ok: true, manifest: o, dir };
  } catch (e) {
    return { ok: false, error: '读取备份清单失败: ' + e.message };
  }
}

/** 列出全部备份（按创建时间倒序）。 */
function listBackups(botDir, { fsImpl = fs } = {}) {
  const root = backupRootOf(botDir);
  let entries = [];
  try { entries = fsImpl.readdirSync(root); } catch (_) { return { ok: true, backups: [] }; }
  const out = [];
  for (const name of entries) {
    if (!isValidId(name)) continue;
    const r = readManifest(botDir, name, fsImpl);
    if (!r.ok) { out.push({ id: name, broken: true, error: r.error }); continue; }
    const m = r.manifest;
    out.push({
      id: name,
      createdAt: m.createdAt || null,
      label: m.label || '',
      appVersion: m.appVersion || '',
      includeSecret: !!m.includeSecret,
      fileCount: Array.isArray(m.files) ? m.files.length : 0,
      bytes: Array.isArray(m.files) ? m.files.reduce((a, f) => a + (f.bytes || 0), 0) : 0,
      broken: false,
    });
  }
  out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return { ok: true, backups: out };
}

/**
 * 创建备份。
 * @param opts { includeSecret, label, appVersion, now, fsImpl }
 */
function createBackup(botDir, opts = {}) {
  const fsImpl = opts.fsImpl || fs;
  const includeSecret = !!opts.includeSecret;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const id = 'bak-' + stamp(now);
  const dir = path.join(backupRootOf(botDir), id);
  try { fsImpl.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, error: '创建备份目录失败: ' + e.message }; }

  const wanted = BACKUP_FILES.concat(includeSecret ? SECRET_FILES : []);
  const files = [];
  const skipped = [];
  for (const name of wanted) {
    const src = path.join(botDir, name);
    let buf;
    try { buf = fsImpl.readFileSync(src); } catch (_) { skipped.push(name); continue; }
    try {
      fsImpl.writeFileSync(path.join(dir, name), buf);
      files.push({ name, bytes: buf.length, sha256: sha256(buf) });
    } catch (e) {
      return { ok: false, error: '写入备份文件失败(' + name + '): ' + e.message };
    }
  }
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    createdAt: now.toISOString(),
    appVersion: opts.appVersion || '',
    label: String(opts.label || '').slice(0, 80),
    includeSecret,
    excluded: includeSecret ? [] : SECRET_FILES.slice(),
    files,
  };
  try { fsImpl.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2)); }
  catch (e) { return { ok: false, error: '写入备份清单失败: ' + e.message }; }
  return { ok: true, id, dir, fileCount: files.length, skipped, includeSecret, note: files.length ? null : '没有可备份的配置文件' };
}

/**
 * 备份与当前状态的差异预览（只读）。
 * 返回 { ok, files:[{name,status:'added'|'removed'|'changed'|'same', bytesFrom, bytesTo}], counts, warnings }
 */
function diffBackup(botDir, id, { fsImpl = fs } = {}) {
  const r = readManifest(botDir, id, fsImpl);
  if (!r.ok) return { ok: false, error: r.error };
  const m = r.manifest;
  const backupFiles = Array.isArray(m.files) ? m.files : [];
  const warnings = [];
  if (m.includeSecret) warnings.push('该备份包含密钥文件，恢复会把其中的密钥写回机器人目录');
  if (m.appVersion && m.appVersion !== '') warnings.push('备份来自版本 ' + m.appVersion + '，恢复前请确认与当前版本兼容');

  const seen = new Set();
  const files = [];
  for (const f of backupFiles) {
    seen.add(f.name);
    let cur = null;
    try { cur = fsImpl.readFileSync(path.join(botDir, f.name)); } catch (_) { cur = null; }
    if (cur === null) {
      files.push({ name: f.name, status: 'added', bytesFrom: 0, bytesTo: f.bytes || 0 });
      continue;
    }
    const curHash = sha256(cur);
    files.push({
      name: f.name,
      status: curHash === f.sha256 ? 'same' : 'changed',
      bytesFrom: cur.length,
      bytesTo: f.bytes || 0,
    });
  }
  // 当前存在、但备份里没有的普通白名单文件 → 恢复后不会被删除，仅提示
  for (const name of BACKUP_FILES) {
    if (seen.has(name)) continue;
    let exists = false;
    try { fsImpl.accessSync(path.join(botDir, name)); exists = true; } catch (_) { /* 不存在 */ }
    if (exists) files.push({ name, status: 'removed', bytesFrom: null, bytesTo: null });
  }
  const counts = { added: 0, removed: 0, changed: 0, same: 0 };
  for (const f of files) counts[f.status] = (counts[f.status] || 0) + 1;
  if (counts.removed) warnings.push('有文件仅存在于当前目录、不在备份中：恢复不会删除它们（避免误删）');
  return { ok: true, id, files, counts, warnings, includeSecret: !!m.includeSecret };
}

/** 原子写单文件（临时文件 + rename）。 */
function atomicWrite(fsImpl, target, buf) {
  const tmp = target + '.restore.' + process.pid + '.tmp';
  try {
    fsImpl.writeFileSync(tmp, buf);
    fsImpl.renameSync(tmp, target);
    return { ok: true };
  } catch (e) {
    try { if (fsImpl.existsSync(tmp)) fsImpl.unlinkSync(tmp); } catch (_) {}
    return { ok: false, error: e.message };
  }
}

/**
 * 恢复备份。
 * @param opts { includeSecret, force, now, appVersion, fsImpl }
 *  - includeSecret=false 时，备份里的密钥文件**不恢复**（即使备份里有）。
 *  - 恢复前自动创建 pre-restore 快照；失败回滚已写文件。
 */
function restoreBackup(botDir, id, opts = {}) {
  const fsImpl = opts.fsImpl || fs;
  const r = readManifest(botDir, id, fsImpl);
  if (!r.ok) return { ok: false, error: r.error };
  const m = r.manifest;
  const dir = r.dir;
  const includeSecret = !!opts.includeSecret;

  const diff = diffBackup(botDir, id, { fsImpl });
  if (!diff.ok) return { ok: false, error: diff.error };
  const willChange = diff.counts.changed + diff.counts.added;
  if (!willChange && !opts.force) {
    return { ok: true, noop: true, restored: 0, note: '当前配置与备份一致，无需恢复', preRestoreId: null };
  }

  // 1) 恢复前快照（含密钥，保证可完整回滚）
  const pre = createBackup(botDir, { includeSecret: true, label: 'pre-restore of ' + id, appVersion: opts.appVersion, now: opts.now, fsImpl });

  const restored = [];
  const skipped = [];
  const written = [];
  for (const f of (Array.isArray(m.files) ? m.files : [])) {
    const isSecret = SECRET_FILES.includes(f.name);
    if (isSecret && !includeSecret) { skipped.push({ name: f.name, reason: 'secret_excluded' }); continue; }
    let buf;
    try { buf = fsImpl.readFileSync(path.join(dir, f.name)); } catch (e) { skipped.push({ name: f.name, reason: 'backup_file_missing' }); continue; }
    const w = atomicWrite(fsImpl, path.join(botDir, f.name), buf);
    if (!w.ok) {
      // 回滚：把已写文件恢复为快照内容
      let rolledBack = true;
      for (const name of written) {
        try {
          const snap = fsImpl.readFileSync(path.join(backupRootOf(botDir), pre.id, name));
          atomicWrite(fsImpl, path.join(botDir, name), snap);
        } catch (_) { rolledBack = false; }
      }
      return {
        ok: false, error: '恢复失败(' + f.name + '): ' + w.error,
        rolledBack, preRestoreId: pre.ok ? pre.id : null, restored,
      };
    }
    written.push(f.name);
    restored.push(f.name);
  }
  return {
    ok: true,
    restored,
    skipped,
    preRestoreId: pre.ok ? pre.id : null,
    warnings: diff.warnings,
    note: skipped.length ? '部分文件因策略未恢复（见 skipped）' : '恢复完成',
  };
}

/** 删除一份备份（仅限备份根内）。 */
function deleteBackup(botDir, id, { fsImpl = fs } = {}) {
  const dir = resolveBackupDir(botDir, id);
  if (!dir) return { ok: false, error: '非法备份 id' };
  try { fsImpl.rmSync(dir, { recursive: true, force: true }); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

module.exports = {
  BACKUP_ROOT, MANIFEST, SCHEMA_VERSION, BACKUP_FILES, SECRET_FILES,
  backupRootOf, isValidId, resolveBackupDir, readManifest,
  listBackups, createBackup, diffBackup, restoreBackup, deleteBackup,
};
