'use strict';
/**
 * providerService.js —— 多 Provider 管理（桌面侧）。
 *
 * 设计原则（任务书要求）：
 *  - 复用现有肥鱼核心的「单 Provider」请求系统，不建第二套互相独立的请求逻辑。
 *    桌面维护一个 Provider 注册表，所谓「切换 Provider」= 把选中 Provider 的
 *    baseUrl/model/key 写回现有的 ai_config.json(api) + secrets.json(apiKey) 槽位，
 *    由机器人下次请求时读取（需重启 AI 桥生效）。
 *  - 密钥不进注册表明文：注册表只存 hasKey 布尔；明文密钥单独存 feiyu_provider_secrets.json
 *    （收紧权限，.gitignore 已排除）。
 *  - 自定义 OpenAI 兼容接口必须验证协议行为（返回 choices[].message.content），
 *    不能仅因 URL 可达就标记为可用。
 *  - testConnection 必须由用户主动触发；它会真正发一条最小 chat completion（可能产生极少量费用），
 *    调用方需先提示潜在费用。本服务不做任何网络请求，纯函数 + 注入 deps。
 */
const fs = require('fs');
const path = require('path');
const { redactText } = require('./redact');

// 加解密 codec（可选）：由主进程在 Electron safeStorage 可用时注入。
//  - null（默认）→ 明文存储（向后兼容旧 feiyu_provider_secrets.json，也用于无 safeStorage 的环境）。
//  - { encrypt(plain)->string, decrypt(cipher)->string } → 密钥在磁盘上以密文存储，仅本机可解密。
// 注意：bot 的 secrets.json 必须保持明文（bot 进程无 safeStorage），本 codec 只保护桌面侧的多 Provider 密钥。
let _codec = null;
function setCodec(c) { _codec = c || null; }
function hasCodec() { return !!_codec; }

function providersPath(botDir) { return path.join(botDir, 'feiyu_providers.json'); }
function secretsPath(botDir) { return path.join(botDir, 'feiyu_provider_secrets.json'); }

function load(p) {
  try {
    const o = JSON.parse(fs.readFileSync(providersPath(p), 'utf-8'));
    if (o && typeof o === 'object' && Array.isArray(o.providers)) return o;
  } catch (_) {}
  return { default: null, providers: [] };
}
function loadSecrets(p) {
  const r = readSecrets(p);
  return r.data;
}

/**
 * 读取密钥库并报告状态。
 *  - ok:true  → data 可用（明文旧文件，或已成功解密）
 *  - encrypted:true 且 ok:false → 磁盘上是密文但当前环境无法解密（无 codec / 解密失败）。
 *    此时严禁任何写入路径，否则会把其它 Provider 的密钥整体丢失。
 */
function readSecrets(p) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(secretsPath(p), 'utf-8')); }
  catch (_) { return { ok: true, data: {}, encrypted: false, error: null }; }
  if (!raw || typeof raw !== 'object') return { ok: true, data: {}, encrypted: false, error: null };
  if (!raw.__encrypted) return { ok: true, data: raw, encrypted: false, error: null };
  if (!_codec) return { ok: false, data: {}, encrypted: true, error: '密钥库已加密，但当前环境无法解密（系统凭据不可用）' };
  const data = {};
  try {
    for (const k of Object.keys(raw.data || {})) data[k] = _codec.decrypt(raw.data[k]);
  } catch (e) {
    return { ok: false, data: {}, encrypted: true, error: '密钥解密失败: ' + e.message };
  }
  return { ok: true, data, encrypted: true, error: null };
}

/** 写入前检查：加密库不可解密时拒绝写入（保护其它 Provider 密钥不被覆盖清空）。 */
function assertWritable(p) {
  const r = readSecrets(p);
  if (!r.ok) return { ok: false, error: r.error || '密钥库不可写' };
  return { ok: true };
}
function saveProviders(p, obj) {
  const fp = providersPath(p);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = fp + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  fs.renameSync(tmp, fp);
  return { ok: true };
}
function saveSecrets(p, obj) {
  const fp = secretsPath(p);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = fp + '.tmp.' + process.pid;
  let text;
  if (_codec) {
    const data = {};
    for (const k of Object.keys(obj)) data[k] = _codec.encrypt(String(obj[k]));
    text = JSON.stringify({ __encrypted: true, v: 1, data }, null, 2);
  } else {
    text = JSON.stringify(obj, null, 2);
  }
  fs.writeFileSync(tmp, text, 'utf-8');
  if (process.platform !== 'win32') { try { fs.chmodSync(fp, 0o600); } catch (_) {} }
  fs.renameSync(tmp, fp);
  return { ok: true };
}

/**
 * 把明文 feiyu_provider_secrets.json 迁移为密文（safeStorage）。
 * 兼容旧数据：先备份明文到 backups/（gitignore 已排除），再写密文，解密回读校验；
 * 校验失败则回滚到备份，绝不静默留下损坏数据；不直接删原明文备份。幂等（已加密则跳过）。
 */
function migrateSecretsToEncrypted(p) {
  const fp = secretsPath(p);
  if (!_codec) return { migrated: false, reason: 'no_codec' };
  if (!fs.existsSync(fp)) { saveSecrets(p, {}); return { migrated: true, reason: 'created_empty', verified: true }; }
  let cur;
  try { cur = JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch (_) { return { migrated: false, error: '读取失败' }; }
  if (cur && cur.__encrypted) return { migrated: false, reason: 'already_encrypted' };
  const plain = (cur && typeof cur === 'object') ? cur : {};
  const bkDir = path.join(p, 'backups', 'feiyu-provider-secrets-' + Date.now());
  try { fs.mkdirSync(bkDir, { recursive: true }); fs.copyFileSync(fp, path.join(bkDir, 'feiyu_provider_secrets.json')); }
  catch (e) { return { migrated: false, error: '备份失败: ' + e.message }; }
  // 备份已就位后才允许写入；写失败时用备份还原，保证原文件不丢
  let wrote = false;
  try { saveSecrets(p, plain); wrote = true; }
  catch (e) {
    try { fs.copyFileSync(path.join(bkDir, 'feiyu_provider_secrets.json'), fp); } catch (_) {}
    return { migrated: false, error: '写入失败，已回滚: ' + e.message, backupDir: bkDir };
  }
  const reloaded = loadSecrets(p);
  const ids = new Set([...Object.keys(plain), ...Object.keys(reloaded)]);
  let ok = true;
  for (const k of ids) {
    const a = plain[k] == null ? '' : String(plain[k]);
    const b = reloaded[k] == null ? '' : String(reloaded[k]);
    if (a !== b) { ok = false; break; }
  }
  if (!ok) {
    try { fs.copyFileSync(path.join(bkDir, 'feiyu_provider_secrets.json'), fp); } catch (_) {}
    return { migrated: false, error: '校验失败，已回滚', backupDir: bkDir };
  }
  return { migrated: true, verified: true, backupDir: bkDir, wrote };
}

/** 判断 URL 是否指向内网/回环/链路本地（非阻断：仅提示，避免被用作内网访问入口）。 */
function isPrivateUrl(u) {
  try {
    const x = new URL(u);
    const h = x.hostname;
    if (h === 'localhost' || h === '0.0.0.0' || h === '127.0.0.1' || h === '::1') return true;
    if (h.startsWith('192.168.') || h.startsWith('10.') || h.startsWith('169.254.')) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
    return false;
  } catch (_) { return false; }
}

function genId() { return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function validUrl(u) {
  try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; } catch (_) { return false; }
}

/** 校验单个 Provider 配置完整性（不含密钥；密钥单独判定）。 */
function validateProvider(p) {
  const errors = [];
  if (!p || typeof p !== 'object') return { valid: false, complete: false, errors: ['provider 必须是对象'] };
  if (!p.name || typeof p.name !== 'string' || !p.name.trim()) errors.push('name 必填');
  if (!p.baseUrl || !validUrl(p.baseUrl)) errors.push('baseUrl 必须是合法 http(s) URL');
  if (!p.model || typeof p.model !== 'string' || !p.model.trim()) errors.push('model 必填');
  if (p.reasoningModel != null && typeof p.reasoningModel !== 'string') errors.push('reasoningModel 必须是字符串');
  if (p.timeoutMs != null && (!(typeof p.timeoutMs === 'number') || p.timeoutMs < 1000 || p.timeoutMs > 600000)) errors.push('timeoutMs 必须 1000–600000');
  if (p.maxRetries != null && !(typeof p.maxRetries === 'number' && p.maxRetries >= 0 && p.maxRetries <= 10)) errors.push('maxRetries 必须 0–10');
  return { valid: errors.length === 0, complete: errors.length === 0 && !!p.hasKey, errors };
}

/** 列出 Provider（附 hasKey / complete / 当前是否已应用到配置）。 */
function list(p, currentConfig) {
  const data = load(p);
  const sr = readSecrets(p);
  const sec = sr.data;
  const providers = data.providers.map((x) => {
    const hasKey = !!(sec[x.id] != null && String(sec[x.id]).length > 0);
    const v = validateProvider(x);
    return Object.assign({}, x, { hasKey, complete: v.valid && hasKey, secret: undefined });
  });
  const appliedId = currentConfig ? currentAppliedId(currentConfig, providers) : null;
  return {
    default: data.default, providers, appliedId,
    encrypted: sr.encrypted, decryptError: sr.ok ? null : (sr.error || null),
  };
}

/** 根据现有 ai_config.json 推断当前应用的是哪个 Provider（按 baseUrl+model 匹配）。 */
function currentAppliedId(config, providers) {
  const api = (config && config.api) || {};
  if (!api.baseUrl) return null;
  for (const x of providers || []) {
    if (x.baseUrl === api.baseUrl && (x.model === api.model || !api.model)) return x.id;
  }
  return null;
}

/** 保存（新建或更新）一个 Provider。providerInput 可含 key（仅在显式传入时写密钥）。
 *  更新时未传入的字段保留原值（如只改密钥不会清空 baseUrl/model）。 */
function save(p, providerInput) {
  const w = assertWritable(p);
  if (!w.ok) return { ok: false, errors: [w.error] };
  const data = load(p);
  const sec = loadSecrets(p);
  const isNew = !providerInput.id || !data.providers.some((x) => x.id === providerInput.id);
  const id = isNew ? genId() : providerInput.id;
  const existing = isNew ? null : data.providers.find((x) => x.id === id);
  const merged = isNew ? providerInput : Object.assign({}, existing, providerInput);

  // 校验（不要求 hasKey 才能保存；但完整度依赖密钥）
  const stub = Object.assign({}, merged, { id, hasKey: !!(sec[id] != null && String(sec[id]).length > 0) });
  const v = validateProvider(stub);
  if (!v.valid) return { ok: false, errors: v.errors };

  // 写密钥（如提供）
  if (providerInput.key != null) {
    if (providerInput.key === '') delete sec[id];
    else sec[id] = providerInput.key;
    saveSecrets(p, sec);
  }
  const hasKey = !!(sec[id] != null && String(sec[id]).length > 0);

  const clean = {
    id,
    name: String(merged.name).trim(),
    baseUrl: merged.baseUrl,
    model: merged.model,
    reasoningModel: merged.reasoningModel || '',
    timeoutMs: merged.timeoutMs != null ? Number(merged.timeoutMs) : (merged.reasoningModel ? 60000 : 30000),
    maxRetries: merged.maxRetries != null ? Number(merged.maxRetries) : 2,
    hasKey,
  };
  if (isNew) data.providers.push(clean);
  else data.providers = data.providers.map((x) => (x.id === id ? clean : x));
  if (!data.default) data.default = id;
  saveProviders(p, data);
  return { ok: true, id, provider: clean, complete: v.errors.length === 0 && hasKey };
}

/** 删除 Provider（同时删其密钥）。若删的是默认，默认清空。 */
function remove(p, id) {
  const w = assertWritable(p);
  if (!w.ok) return { ok: false, error: w.error };
  const data = load(p);
  const before = data.providers.length;
  data.providers = data.providers.filter((x) => x.id !== id);
  if (data.providers.length === before) return { ok: false, error: '未找到该 Provider' };
  if (data.default === id) data.default = data.providers[0] ? data.providers[0].id : null;
  const sec = loadSecrets(p);
  if (sec[id] != null) { delete sec[id]; saveSecrets(p, sec); }
  saveProviders(p, data);
  return { ok: true, default: data.default };
}

/** 设置默认 Provider。 */
function setDefault(p, id) {
  const data = load(p);
  if (!data.providers.some((x) => x.id === id)) return { ok: false, error: '未找到该 Provider' };
  data.default = id;
  saveProviders(p, data);
  return { ok: true, default: id };
}

/**
 * 清理「无主密钥」：密钥库里存在、但注册表中已无对应 Provider 的条目。
 * 正常删除 Provider 时密钥已同步删除；此函数用于修复历史残留（例如迁移前遗留）。
 * 默认 dry-run，只报告；confirm=true 时才真正删除。
 *
 * 安全约束（验收发现并修复）：
 *  注册表文件缺失或损坏时，load() 会返回空 providers 列表 —— 若直接比对，
 *  密钥库里的**全部**密钥都会被误判为孤儿并删除（凭据全丢）。
 *  因此这里要求：注册表必须存在、可解析、且至少含一个 Provider，才允许清理。
 */
function pruneOrphanSecrets(p, { confirm = false } = {}) {
  const w = assertWritable(p);
  if (!w.ok) return { ok: false, error: w.error, orphans: [] };
  // 注册表缺失 → 无法判断谁是孤儿，绝不清理
  if (!fs.existsSync(providersPath(p))) {
    return { ok: false, error: 'Provider 注册表不存在，无法判断孤儿密钥（已跳过清理）', orphans: [], pruned: [] };
  }
  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(providersPath(p), 'utf-8')); } catch (e) {
    return { ok: false, error: 'Provider 注册表无法解析（可能已损坏），已跳过清理：' + e.message, orphans: [], pruned: [] };
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.providers)) {
    return { ok: false, error: 'Provider 注册表结构异常，已跳过清理', orphans: [], pruned: [] };
  }
  if (!parsed.providers.length) {
    // 空注册表 + 有密钥 = 高危组合（可能注册表被误清空），拒绝清理
    const sec0 = loadSecrets(p);
    if (Object.keys(sec0).length) {
      return { ok: false, error: 'Provider 注册表为空但密钥库非空，疑似注册表丢失，已跳过清理', orphans: [], pruned: [] };
    }
    return { ok: true, orphans: [], pruned: [], dryRun: !confirm };
  }
  const data = load(p);
  const ids = new Set(data.providers.map((x) => x.id));
  const sec = loadSecrets(p);
  const orphans = Object.keys(sec).filter((k) => !ids.has(k));
  if (!orphans.length) return { ok: true, orphans: [], pruned: [] };
  if (!confirm) return { ok: true, orphans, pruned: [], dryRun: true };
  for (const k of orphans) delete sec[k];
  saveSecrets(p, sec);
  return { ok: true, orphans, pruned: orphans, dryRun: false };
}

/**
 * 把选中的 Provider 转换为现有机器人的配置补丁（复用单 Provider 槽，不建第二套系统）。
 * 返回 { config:{api:{...}}, secret:{apiKey} }，由调用方写入 ai_config.json / secrets.json。
 */
function applyPatch(p, id) {
  const w = assertWritable(p);
  if (!w.ok) return { ok: false, error: w.error };
  const data = load(p);
  const prov = data.providers.find((x) => x.id === id);
  if (!prov) return { ok: false, error: '未找到该 Provider' };
  const sec = loadSecrets(p);
  const apiKey = sec[id] != null ? String(sec[id]) : '';
  if (!apiKey) return { ok: false, error: '该 Provider 未配置密钥，无法应用' };
  const config = {
    api: {
      baseUrl: prov.baseUrl,
      model: prov.model,
      reasoningModel: prov.reasoningModel || (prov.model || ''),
      timeoutMs: prov.timeoutMs || 30000,
      maxRetries: prov.maxRetries != null ? prov.maxRetries : 2,
    },
  };
  return { ok: true, id, config, secret: { apiKey }, provider: prov };
}

/**
 * 兼容迁移：若尚不存在 Provider 注册表，则用现有单 Provider 配置（ai_config.json.api +
 * secrets.json.apiKey）生成一个默认 Provider 并设为默认。已存在则跳过（不覆盖）。
 */
function migrateFromConfig(p, config, secrets) {
  const fp = providersPath(p);
  if (fs.existsSync(fp)) return { ok: true, migrated: false, reason: '已存在注册表' };
  const w = assertWritable(p);
  if (!w.ok) return { ok: false, migrated: false, error: w.error };
  const api = (config && config.api) || {};
  const apiKey = (secrets && (secrets.apiKey != null ? secrets.apiKey : secrets.api_key)) || '';
  if (!api.baseUrl || !api.model) return { ok: false, migrated: false, error: '现有配置缺少 baseUrl/model，无法迁移' };
  const id = genId();
  const prov = {
    id,
    name: (api.baseUrl || '').includes('deepseek') ? 'DeepSeek（现有配置）' : '现有 Provider',
    baseUrl: api.baseUrl,
    model: api.model,
    reasoningModel: api.reasoningModel || api.model,
    timeoutMs: api.timeoutMs || 30000,
    maxRetries: api.maxRetries != null ? api.maxRetries : 2,
    hasKey: !!apiKey,
  };
  saveProviders(p, { default: id, providers: [prov] });
  if (apiKey) saveSecrets(p, Object.assign(loadSecrets(p), { [id]: apiKey }));
  return { ok: true, migrated: true, id, provider: prov };
}

/**
 * 验证自定义 OpenAI 兼容接口的「协议行为」（非仅可达）：
 *   1) GET {baseUrl 去 /chat/completions}/models → 期望 { data:[...] }
 *   2) POST 一条 max_tokens=1 的 chat completion → 期望 choices[0].message.content
 * 仅当第 2 步成功才标记 protocolOk（模型可用）。返回 costWarning=true 提示调用方这会真正发请求。
 * 绝不在返回里泄漏密钥（对错误信息做脱敏）。
 */
async function testConnection(provider, deps) {
  deps = deps || {};
  const fetchFn = deps.fetch || (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  if (!fetchFn) return { ok: false, reachable: false, protocolOk: false, error: '运行环境无 fetch' };
  const apiKey = deps.apiKey != null ? String(deps.apiKey) : '';
  const timeoutMs = deps.timeoutMs || provider.timeoutMs || 30000;
  const Abort = deps.AbortSignal;
  const url = provider.baseUrl;
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey };
  let reachable = false, protocolOk = false, modelList = null, error = null;

  const toErr = (e) => redactText((e && e.message) || 'connect failed');

  // 1) models 列表（可选验证；失败不影响 chat 验证）
  try {
    const modelsUrl = url.replace(/\/chat\/completions\/?$/, '/models');
    const ctrl = Abort ? Abort.timeout(timeoutMs) : undefined;
    const mr = await fetchFn(modelsUrl, { headers: { Authorization: headers.Authorization }, signal: ctrl });
    reachable = true;
    if (mr.ok) {
      const mj = await mr.json().catch(() => null);
      if (mj && Array.isArray(mj.data)) modelList = mj.data.map((x) => (x && x.id) || '').filter(Boolean);
    }
  } catch (e) { error = toErr(e); }

  // 2) 真实协议行为：最小 chat completion
  try {
    const ctrl = Abort ? Abort.timeout(timeoutMs) : undefined;
    const cr = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: provider.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, temperature: 0 }),
      signal: ctrl,
    });
    reachable = true;
    if (cr.ok) {
      const cj = await cr.json().catch(() => null);
      if (cj && Array.isArray(cj.choices) && cj.choices[0] && cj.choices[0].message && typeof cj.choices[0].message.content === 'string') {
        protocolOk = true;
      } else if (cj && cj.error && cj.error.message) {
        error = redactText(cj.error.message);
      } else {
        error = '返回结构非 OpenAI 兼容（缺少 choices[0].message.content）';
      }
    } else {
      const t = await cr.text().catch(() => '');
      error = redactText('HTTP ' + cr.status + ' ' + (t || '').slice(0, 160));
    }
  } catch (e) { error = toErr(e); }

  return { ok: protocolOk, reachable, protocolOk, modelList, error, costWarning: true, localNetwork: isPrivateUrl(provider.baseUrl) };
}

module.exports = {
  providersPath, secretsPath, load, loadSecrets, readSecrets, assertWritable, validateProvider, list, currentAppliedId,
  save, remove, setDefault, applyPatch, migrateFromConfig, testConnection, pruneOrphanSecrets,
  setCodec, hasCodec, migrateSecretsToEncrypted, isPrivateUrl,
};
