'use strict';
/**
 * extensionManifest.js —— Feiyu Extension Hub 统一扩展清单（Feiyu 1.4 模块 1）。
 *
 * 职责：解析、规范化、严格校验扩展清单（manifest）。
 * 设计原则：
 *  - 纯函数 + 依赖注入（fsImpl 可选），不依赖 Electron，可单测。
 *  - 严格限制字符串长度 / 对象层级 / 数组条目数 / 文件大小，防止畸形清单拖垮 UI 或写入。
 *  - 清单里**绝不**包含可执行的脚本/钩子。任何 `scripts`/`postinstall`/`hooks`/`loadModule`
 *    等危险字段一律拒绝（不是警告）。
 *  - 未知字段采用白名单策略：明确列出允许的字段，其余标记 warning 并剥离，避免悄悄携带数据。
 *  - 文件路径只接受「相对且规范化后不出目录根」的形式；清单里的路径绝不直接当写入目标。
 */
const path = require('path');

const SCHEMA_VERSION = 1;
const EXTENSION_TYPES = ['skill', 'mcp', 'workflow', 'theme', 'prompt'];
const MAX_MANIFEST_BYTES = 256 * 1024; // 清单本身上限 256KB
const MAX_ID = 64;
const MAX_NAME = 120;
const MAX_DESC = 1000;
const MAX_AUTHOR = 120;
const MAX_STR_FIELD = 2000;
const MAX_DEPS = 50;
const MAX_FILES = 500;
const MAX_PERMS = 30;
const MAX_FILE_SIZE = 64 * 1024 * 1024; // 单个安装文件上限 64MB
const MAX_TOTAL_SIZE = 256 * 1024 * 1024; // 整包上限 256MB
const MAX_DEPTH = 6; // 对象嵌套深度

/** 已知危险字段：出现即拒绝（绝不执行扩展自带脚本）。 */
const DENY_FIELDS = new Set([
  'scripts', 'postinstall', 'preinstall', 'install', 'hooks', 'loadModule',
  'require', 'nativeModule', 'exec', 'command', 'run', 'main',
]);

/** 允许的顶层字段白名单（未知字段仅警告并剥离，不致命）。 */
const ALLOWED_FIELDS = new Set([
  'schemaVersion', 'id', 'name', 'version', 'description', 'author',
  'type', 'entry', 'dependencies', 'feiyuCompatibility', 'apiCompatibility',
  'permissions', 'files', 'source', 'integrity', 'signature', 'homepage',
  'license', 'testReport', 'updateInfo',
]);

/** 扩展 id：前缀 ext: 避免与遗留技能 id 冲突。 */
function validExtId(id) {
  return typeof id === 'string' && /^ext:[a-z0-9][a-z0-9._-]{0,63}$/.test(id);
}

/** 版本：宽松 semver（x.y.z，允许前缀 v，允许 -pre）。 */
function validVersion(v) {
  return typeof v === 'string' && /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v);
}

function isObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

/** 计算对象嵌套深度（防深层畸形）。 */
function depthOf(o, cur = 1) {
  if (!isObject(o) && !Array.isArray(o)) return cur;
  let max = cur;
  const arr = Array.isArray(o) ? o : Object.values(o);
  for (const x of arr) {
    if (isObject(x) || Array.isArray(x)) max = Math.max(max, depthOf(x, cur + 1));
  }
  return max;
}

/** 把相对文件路径规范化，返回 {ok, normalized, error}；拒绝绝对路径与目录穿越。 */
function normalizeRelPath(p) {
  if (typeof p !== 'string' || !p.trim()) return { ok: false, error: '路径必须是非空字符串' };
  if (path.isAbsolute(p)) return { ok: false, error: '拒绝绝对路径: ' + p };
  let norm;
  try { norm = path.normalize(p).replace(/\\/g, '/'); } catch (e) { return { ok: false, error: '路径非法: ' + p }; }
  if (norm.startsWith('../') || norm.includes('/../') || norm === '..') {
    return { ok: false, error: '拒绝目录穿越: ' + p };
  }
  if (norm.startsWith('/') || norm.startsWith('./')) return { ok: false, error: '路径不能带前导 / 或 ./: ' + p };
  if (norm.includes('\0')) return { ok: false, error: '路径含空字节: ' + p };
  return { ok: true, normalized: norm };
}

/**
 * 校验清单。
 * @param raw 已解析的对象或 JSON 字符串。
 * @param opts { expectedAppVersion, expectedApiVersion } 用于兼容性检查。
 * @returns { ok, errors[], warnings[], manifest? }
 */
function validateManifest(raw, opts = {}) {
  const errors = [];
  const warnings = [];
  let obj = raw;
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw, 'utf-8') > MAX_MANIFEST_BYTES) errors.push('清单超过 ' + MAX_MANIFEST_BYTES + ' 字节上限');
    try { obj = JSON.parse(raw); } catch (e) { return { ok: false, errors: ['JSON 解析失败: ' + e.message], warnings: [] }; }
  }
  if (!isObject(obj)) return { ok: false, errors: ['清单必须是对象'], warnings: [] };
  if (depthOf(obj) > MAX_DEPTH) errors.push('清单对象嵌套超过 ' + MAX_DEPTH + ' 层');

  // 危险字段：致命
  for (const k of Object.keys(obj)) {
    if (DENY_FIELDS.has(k)) errors.push('拒绝危险字段「' + k + '」（扩展清单不得携带可执行脚本/钩子）');
  }
  // 未知字段：警告并剥离
  const known = {};
  for (const k of Object.keys(obj)) {
    if (ALLOWED_FIELDS.has(k)) known[k] = obj[k];
    else warnings.push('未知字段「' + k + '」已忽略（不在允许清单内）');
  }
  obj = known;

  // schemaVersion
  if (obj.schemaVersion == null) errors.push('缺少 schemaVersion');
  else if (obj.schemaVersion !== SCHEMA_VERSION) errors.push('schemaVersion 必须为 ' + SCHEMA_VERSION + '（收到 ' + obj.schemaVersion + '）');

  // id
  if (obj.id == null) errors.push('缺少 id');
  else if (!validExtId(obj.id)) errors.push('id 非法：需以 ext: 开头，仅含小写字母数字 . _ -，最长 ' + MAX_ID);

  // name
  if (typeof obj.name !== 'string' || !obj.name.trim()) errors.push('name 必填');
  else if (obj.name.length > MAX_NAME) errors.push('name 超过 ' + MAX_NAME + ' 字符');

  // version
  if (obj.version == null) errors.push('缺少 version');
  else if (!validVersion(obj.version)) errors.push('version 非法（应为 x.y.z）: ' + obj.version);

  // description / author 长度
  if (obj.description != null) {
    if (typeof obj.description !== 'string') errors.push('description 必须是字符串');
    else if (obj.description.length > MAX_DESC) errors.push('description 超过 ' + MAX_DESC + ' 字符');
  }
  if (obj.author != null) {
    if (typeof obj.author !== 'string') errors.push('author 必须是字符串');
    else if (obj.author.length > MAX_AUTHOR) errors.push('author 超过 ' + MAX_AUTHOR + ' 字符');
  }

  // type
  if (!EXTENSION_TYPES.includes(obj.type)) errors.push('type 必须是 ' + EXTENSION_TYPES.join('/') + '（收到 ' + obj.type + '）');

  // entry
  if (obj.entry != null) {
    if (!isObject(obj.entry)) errors.push('entry 必须是对象');
    else {
      if (obj.entry.path != null) {
        const np = normalizeRelPath(obj.entry.path);
        if (!np.ok) errors.push('entry.path: ' + np.error);
      }
      if (obj.entry.ref != null && typeof obj.entry.ref !== 'string') errors.push('entry.ref 必须是字符串');
    }
  }

  // dependencies
  let deps = [];
  if (obj.dependencies != null) {
    if (!Array.isArray(obj.dependencies)) errors.push('dependencies 必须是数组');
    else {
      if (obj.dependencies.length > MAX_DEPS) errors.push('dependencies 超过 ' + MAX_DEPS + ' 条');
      for (let i = 0; i < obj.dependencies.length; i++) {
        const d = obj.dependencies[i];
        if (!isObject(d)) { errors.push('dependencies[' + i + '] 必须是对象'); continue; }
        if (!validExtId(d.id)) errors.push('dependencies[' + i + '].id 非法');
        if (typeof d.version !== 'string' || !d.version.trim()) errors.push('dependencies[' + i + '].version 必填（版本范围）');
        else if (!isValidRange(d.version)) errors.push('dependencies[' + i + '].version 版本范围非法: ' + d.version);
        deps.push({ id: d.id, version: String(d.version) });
      }
    }
  }

  // feiyuCompatibility / apiCompatibility
  let feiyuCompat = null;
  if (obj.feiyuCompatibility != null) {
    if (!isObject(obj.feiyuCompatibility)) errors.push('feiyuCompatibility 必须是对象');
    else {
      if (obj.feiyuCompatibility.min != null && !validVersion(obj.feiyuCompatibility.min)) errors.push('feiyuCompatibility.min 非法');
      if (obj.feiyuCompatibility.max != null && !validVersion(obj.feiyuCompatibility.max)) errors.push('feiyuCompatibility.max 非法');
      feiyuCompat = { min: obj.feiyuCompatibility.min || null, max: obj.feiyuCompatibility.max || null };
    }
  }
  if (obj.apiCompatibility != null && (typeof obj.apiCompatibility !== 'string' || !obj.apiCompatibility.trim())) {
    errors.push('apiCompatibility 必须是非空字符串');
  }

  // permissions
  let perms = [];
  if (obj.permissions != null) {
    if (!Array.isArray(obj.permissions)) errors.push('permissions 必须是数组');
    else {
      if (obj.permissions.length > MAX_PERMS) errors.push('permissions 超过 ' + MAX_PERMS + ' 条');
      for (let i = 0; i < obj.permissions.length; i++) {
        const p = obj.permissions[i];
        if (typeof p === 'string') perms.push({ id: p, purpose: '' });
        else if (isObject(p)) {
          if (typeof p.id !== 'string') { errors.push('permissions[' + i + '].id 必填'); continue; }
          if (p.purpose != null && (typeof p.purpose !== 'string' || p.purpose.length > MAX_STR_FIELD)) errors.push('permissions[' + i + '].purpose 超长');
          perms.push({ id: p.id, purpose: typeof p.purpose === 'string' ? p.purpose : '' });
        } else errors.push('permissions[' + i + '] 必须是字符串或对象');
      }
    }
  }

  // files
  let files = [];
  let totalSize = 0;
  if (obj.files != null) {
    if (!Array.isArray(obj.files)) errors.push('files 必须是数组');
    else {
      if (obj.files.length > MAX_FILES) errors.push('files 超过 ' + MAX_FILES + ' 条');
      const seenPaths = new Set();
      for (let i = 0; i < obj.files.length; i++) {
        const f = obj.files[i];
        if (!isObject(f)) { errors.push('files[' + i + '] 必须是对象'); continue; }
        if (typeof f.path !== 'string') { errors.push('files[' + i + '].path 必填'); continue; }
        const np = normalizeRelPath(f.path);
        if (!np.ok) { errors.push('files[' + i + '].path: ' + np.error); continue; }
        if (seenPaths.has(np.normalized)) errors.push('files 重复路径: ' + np.normalized);
        else seenPaths.add(np.normalized);
        if (f.size != null) {
          if (!Number.isFinite(Number(f.size)) || Number(f.size) < 0) errors.push('files[' + i + '].size 非法');
          else if (Number(f.size) > MAX_FILE_SIZE) errors.push('files[' + i + '].size 超过单文件上限 ' + MAX_FILE_SIZE);
          else totalSize += Number(f.size);
        }
        if (f.sha256 != null && !/^[a-fA-F0-9]{64}$/.test(String(f.sha256))) errors.push('files[' + i + '].sha256 必须是 64 位十六进制');
        files.push({ path: np.normalized, size: f.size == null ? null : Number(f.size), sha256: f.sha256 ? String(f.sha256).toLowerCase() : null });
      }
      if (totalSize > MAX_TOTAL_SIZE) errors.push('整包文件大小超过 ' + MAX_TOTAL_SIZE + ' 字节上限');
    }
  }

  // source / integrity
  if (obj.source != null && !['market', 'local', 'bundled'].includes(obj.source)) errors.push('source 必须是 market/local/bundled');
  if (obj.integrity != null) {
    if (typeof obj.integrity !== 'string') errors.push('integrity 必须是字符串');
    else if (!/^(sha256:)?[a-fA-F0-9]{64}$/.test(obj.integrity)) errors.push('integrity 必须是 64 位十六进制 SHA-256');
  }

  // 兼容性预检（给出 warnings，不致命；致命由 dependencyResolver 在装前统一做）
  if (feiyuCompat && opts.expectedAppVersion && !versionSatisfiesRange(opts.expectedAppVersion, rangeFromCompat(feiyuCompat))) {
    warnings.push('该扩展声明的 Feiyu 兼容范围 ' + JSON.stringify(feiyuCompat) + ' 与当前版本 ' + opts.expectedAppVersion + ' 可能不匹配');
  }

  if (errors.length) return { ok: false, errors, warnings };
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    id: obj.id,
    name: obj.name.trim(),
    version: obj.version,
    description: typeof obj.description === 'string' ? obj.description : '',
    author: typeof obj.author === 'string' ? obj.author : '',
    type: obj.type,
    entry: obj.entry && isObject(obj.entry) ? { path: obj.entry.path || null, ref: obj.entry.ref || null } : null,
    dependencies: deps,
    feiyuCompatibility: feiyuCompat,
    apiCompatibility: typeof obj.apiCompatibility === 'string' ? obj.apiCompatibility : null,
    permissions: perms,
    files,
    source: obj.source || 'local',
    integrity: obj.integrity || null,
    signature: obj.signature || null,
    homepage: typeof obj.homepage === 'string' ? obj.homepage.slice(0, MAX_STR_FIELD) : null,
    license: typeof obj.license === 'string' ? obj.license.slice(0, 80) : null,
    updateInfo: obj.updateInfo || null,
  };
  return { ok: true, errors: [], warnings, manifest };
}

/** 把兼容性声明转成版本范围字符串（给 versionSatisfiesRange 用）。 */
function rangeFromCompat(c) {
  if (!c) return '*';
  if (c.min && c.max) return '>=' + c.min + ' <=' + c.max;
  if (c.min) return '>=' + c.min;
  if (c.max) return '<=' + c.max;
  return '*';
}

/* ---------- 版本范围解析（轻量 semver 子集） ---------- */

/** 合法范围字符：^ ~ >= <= > < = . 数字 与 * 以及空格/逗号分隔。 */
function isValidRange(r) {
  if (typeof r !== 'string' || !r.trim()) return false;
  if (r.trim() === '*') return true;
  // 允许逗号或空格分隔的多个约束（AND）
  return r.split(/[\s,]+/).filter(Boolean).every((part) => {
    const t = part.trim();
    if (!t) return false;
    return /^(\^|~|>=|<=|>|<|=)?v?\d+(\.\d+(\.\d+)?)?$/.test(t) || /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(t);
  });
}

/** 把单个版本字符串解析为 [major, minor, patch] 数字数组。 */
function parseVer(v) {
  const m = String(v).replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmpVer(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** 单个约束（含 ^/~ 与比较符）作用于版本。 */
function matchSingleConstraint(ver, constraint) {
  const t = constraint.trim();
  const base = parseVer(t.replace(/^(\^|~|>=|<=|>|<|=)/, ''));
  if (!base) return false;
  const cmp = cmpVer(ver, base);
  if (t.startsWith('^')) {
    // ^1.2.3 → >=1.2.3 <2.0.0；^0.2.3 → >=0.2.3 <0.3.0；^0.0.3 → >=0.0.3 <0.0.4
    if (base[0] > 0) return cmp >= 0 && ver[0] === base[0];
    if (base[1] > 0) return cmp >= 0 && ver[0] === 0 && ver[1] === base[1];
    return cmp >= 0 && ver[0] === 0 && ver[1] === 0 && ver[2] === base[2];
  }
  if (t.startsWith('~')) {
    // ~1.2.3 → >=1.2.3 <1.3.0；~1.2 → >=1.2.0 <1.3.0
    return cmp >= 0 && ver[0] === base[0] && ver[1] === base[1];
  }
  if (t.startsWith('>=')) return cmp >= 0;
  if (t.startsWith('<=')) return cmp <= 0;
  if (t.startsWith('>')) return cmp > 0;
  if (t.startsWith('<')) return cmp < 0;
  if (t.startsWith('=')) return cmp === 0;
  return cmp === 0; // 裸版本 = 精确匹配
}

/** 版本是否满足范围（逗号或空格分隔的多个约束，AND 关系）。 */
function versionSatisfiesRange(version, range) {
  const ver = parseVer(version);
  if (!ver) return false;
  const r = String(range || '*').trim();
  if (r === '' || r === '*') return true;
  const parts = r.split(/[\s,]+/).filter(Boolean);
  return parts.length > 0 && parts.every((part) => matchSingleConstraint(ver, part));
}

module.exports = {
  SCHEMA_VERSION, EXTENSION_TYPES,
  MAX_MANIFEST_BYTES, MAX_FILE_SIZE, MAX_TOTAL_SIZE, MAX_DEPS, MAX_FILES,
  ALLOWED_FIELDS, DENY_FIELDS,
  validExtId, validVersion, isObject, normalizeRelPath, depthOf,
  validateManifest, rangeFromCompat, isValidRange, parseVer, cmpVer,
  versionSatisfiesRange,
};
