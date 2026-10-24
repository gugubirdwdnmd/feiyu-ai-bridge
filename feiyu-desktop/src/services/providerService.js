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
  try {
    const o = JSON.parse(fs.readFileSync(secretsPath(p), 'utf-8'));
    if (o && typeof o === 'object') return o;
  } catch (_) {}
  return {};
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
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  if (process.platform !== 'win32') { try { fs.chmodSync(fp, 0o600); } catch (_) {} }
  fs.renameSync(tmp, fp);
  return { ok: true };
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
  const sec = loadSecrets(p);
  const providers = data.providers.map((x) => {
    const hasKey = !!(sec[x.id] != null && String(sec[x.id]).length > 0);
    const v = validateProvider(x);
    return Object.assign({}, x, { hasKey, complete: v.valid && hasKey, secret: undefined });
  });
  const appliedId = currentConfig ? currentAppliedId(currentConfig, providers) : null;
  return { default: data.default, providers, appliedId };
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
 * 把选中的 Provider 转换为现有机器人的配置补丁（复用单 Provider 槽，不建第二套系统）。
 * 返回 { config:{api:{...}}, secret:{apiKey} }，由调用方写入 ai_config.json / secrets.json。
 */
function applyPatch(p, id) {
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

  return { ok: protocolOk, reachable, protocolOk, modelList, error, costWarning: true };
}

module.exports = {
  providersPath, secretsPath, load, loadSecrets, validateProvider, list, currentAppliedId,
  save, remove, setDefault, applyPatch, migrateFromConfig, testConnection,
};
