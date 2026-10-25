'use strict';
/**
 * marketService.js —— 技能 / 扩展市场接入适配层（模块 F）。
 *
 * 支持来源：
 *  - huaweicloud：华为云（ModelArts / 开发者空间等）技能市场，走用户自填的 API 基础地址 + 访问令牌
 *  - generic     ：任意符合本文件 catalog 规范的 HTTPS 静态目录
 *  - local       ：本地导入的 catalog 文件内容（离线场景）
 *
 * 铁律（不可绕过）：
 *  1) **不绕过鉴权**：目录声明 requiresAuth 且未提供令牌 → 直接拒绝，不尝试匿名降级。
 *  2) **不绕过付费**：条目带 price/paid 标记 → 只允许「查看详情」，不提供下载动作。
 *  3) **完整性校验**：条目若提供 sha256，下载内容必须校验通过；不匹配即丢弃。
 *  4) **不自动安装**：全部走「解析 → 校验 → 展示 → 用户确认」，本模块只到「计划」为止。
 *  5) 只接受 https（local 来源除外）；拒绝 http、file://、内网明文地址。
 *
 * 依赖注入：fetchFn / fs 均可替换，便于离线单测。
 */
const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const MAX_ITEMS = 200;
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const ITEM_TYPES = ['skill', 'mcp', 'workflow', 'theme', 'prompt'];

const SOURCES = [
  {
    id: 'huaweicloud',
    name: '华为云技能市场',
    kind: 'remote',
    requiresEndpoint: true,
    requiresAuth: true,
    description: '需要填写华为云市场 API 基础地址与访问令牌；本工具不会代你申请或使用任何账号凭据。',
    docHint: '在华为云控制台创建访问密钥后，把 API 网关地址与令牌填入即可；不同市场产品的字段名可能不同，请以你的实际接口为准。',
  },
  {
    id: 'generic',
    name: '通用 HTTPS 目录',
    kind: 'remote',
    requiresEndpoint: true,
    requiresAuth: false,
    description: '任何返回本文件 catalog 格式 JSON 的 HTTPS 地址（可指向自己的静态服务器）。',
  },
  {
    id: 'local',
    name: '本地导入',
    kind: 'local',
    requiresEndpoint: false,
    requiresAuth: false,
    description: '粘贴或导入本地 catalog JSON 文件内容，完全离线。',
  },
];

function isObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

function listSources() {
  return { ok: true, sources: SOURCES.map((s) => Object.assign({}, s)) };
}

function getSource(id) { return SOURCES.find((s) => s.id === id) || null; }

/** 只允许 https（local 不涉及网络）。 */
function checkEndpoint(url) {
  let u;
  try { u = new URL(String(url || '')); } catch (_) { return { ok: false, error: '地址不是合法 URL' }; }
  if (u.protocol !== 'https:') return { ok: false, error: '只允许 https 地址（当前 ' + u.protocol + '）' };
  const host = u.hostname;
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host === 'localhost') {
    return { ok: false, error: '不允许指向内网/回环地址（' + host + '）' };
  }
  return { ok: true, url: u.toString() };
}

function sha256Hex(buf) {
  try { return crypto.createHash('sha256').update(buf).digest('hex'); } catch (_) { return ''; }
}

/** 校验单条目。 */
function validateItem(it, idx) {
  const errors = [];
  if (!isObject(it)) return { errors: ['items[' + idx + '] 必须是对象'] };
  if (typeof it.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(it.id)) errors.push('items[' + idx + '].id 非法');
  if (typeof it.name !== 'string' || !it.name.trim()) errors.push('items[' + idx + '].name 必填');
  if (it.type != null && !ITEM_TYPES.includes(it.type)) errors.push('items[' + idx + '].type 必须是 ' + ITEM_TYPES.join('/'));
  if (it.downloadUrl != null) {
    const c = checkEndpoint(it.downloadUrl);
    if (!c.ok) errors.push('items[' + idx + '].downloadUrl: ' + c.error);
  }
  if (it.sha256 != null && !/^[a-fA-F0-9]{64}$/.test(String(it.sha256))) errors.push('items[' + idx + '].sha256 必须是 64 位十六进制');
  if (it.price != null && (typeof it.price !== 'number' || it.price < 0)) errors.push('items[' + idx + '].price 必须是非负数');
  return { errors };
}

/**
 * 解析 catalog。
 * 规范：{ schemaVersion, name, items:[{id,name,type,version,description,downloadUrl,sha256,requiresAuth,price,paid,tags}] }
 */
function parseCatalog(payload) {
  let obj = payload;
  if (typeof payload === 'string') {
    try { obj = JSON.parse(payload); } catch (e) { return { ok: false, items: [], errors: ['JSON 解析失败: ' + e.message] }; }
  }
  if (!isObject(obj)) return { ok: false, items: [], errors: ['catalog 必须是对象'] };
  const raw = Array.isArray(obj.items) ? obj.items : (Array.isArray(obj.skills) ? obj.skills : null);
  if (!raw) return { ok: false, items: [], errors: ['catalog 缺少 items 数组'] };
  if (raw.length > MAX_ITEMS) return { ok: false, items: [], errors: ['条目数超过上限 ' + MAX_ITEMS] };

  const errors = [];
  const items = [];
  for (let i = 0; i < raw.length; i++) {
    const r = validateItem(raw[i], i);
    if (r.errors.length) { for (const e of r.errors) errors.push(e); continue; }
    const it = raw[i];
    const paid = !!(it.paid || (typeof it.price === 'number' && it.price > 0));
    const missingHash = !it.sha256;
    items.push({
      id: it.id,
      name: it.name,
      type: ITEM_TYPES.includes(it.type) ? it.type : 'skill',
      version: typeof it.version === 'string' ? it.version : '',
      description: typeof it.description === 'string' ? it.description.slice(0, 500) : '',
      downloadUrl: it.downloadUrl || null,
      sha256: it.sha256 ? String(it.sha256).toLowerCase() : null,
      requiresAuth: !!it.requiresAuth,
      paid,
      price: typeof it.price === 'number' ? it.price : null,
      tags: Array.isArray(it.tags) ? it.tags.filter((t) => typeof t === 'string').slice(0, 10) : [],
      integrity: missingHash ? 'unverified' : 'declared',
    });
  }
  const warns = [];
  if (items.some((i) => i.integrity === 'unverified')) warns.push('部分条目未提供 sha256，导入时无法做完整性校验');
  if (items.some((i) => i.paid)) warns.push('存在付费条目：本工具不提供购买或绕过付费的通道');
  return {
    ok: errors.length === 0,
    items,
    errors,
    warnings: warns,
    meta: { name: obj.name || '', schemaVersion: obj.schemaVersion || null, source: obj.source || null },
  };
}

/**
 * 是否允许对该条目执行导入，以及为什么。
 * @returns { allowed, reasons[], needsAuth, needsPayment, blocked }
 */
function planImport(item, { hasToken = false } = {}) {
  const reasons = [];
  if (!isObject(item)) return { allowed: false, blocked: true, reasons: ['条目无效'], needsAuth: false, needsPayment: false };
  let blocked = false;
  if (item.requiresAuth && !hasToken) { reasons.push('该条目需要市场鉴权令牌，未提供则不允许导入（不会尝试匿名访问）'); blocked = true; }
  if (item.paid) { reasons.push('该条目为付费内容，请先在市场侧完成购买；本工具不提供绕过付费的通道'); blocked = true; }
  if (!item.downloadUrl) { reasons.push('条目没有 downloadUrl，无法获取内容'); blocked = true; }
  if (item.integrity === 'unverified') reasons.push('未提供 sha256：导入后无法验证内容未被篡改，请自行确认来源可信');
  return { allowed: !blocked, blocked, reasons, needsAuth: !!item.requiresAuth, needsPayment: !!item.paid };
}

/**
 * 获取远端 catalog（仅 HTTPS，需显式调用）。
 * @param opts { fetchFn, timeoutMs, token }
 */
async function fetchCatalog(sourceId, endpoint, opts = {}) {
  const src = getSource(sourceId);
  if (!src) return { ok: false, error: '未知来源: ' + sourceId };
  if (src.kind === 'local') return { ok: false, error: '本地来源不需要网络获取，请直接粘贴 catalog 内容' };
  if (!src.requiresEndpoint) return { ok: false, error: '该来源不需要 endpoint' };
  const c = checkEndpoint(endpoint);
  if (!c.ok) return { ok: false, error: c.error };
  const fetchFn = opts.fetchFn || globalThis.fetch;
  if (typeof fetchFn !== 'function') return { ok: false, error: '当前环境不支持 fetch' };
  if (src.requiresAuth && !opts.token) return { ok: false, error: '该来源需要访问令牌（不会尝试匿名访问）', needsAuth: true };

  const headers = { Accept: 'application/json' };
  if (opts.token) headers.Authorization = 'Bearer ' + String(opts.token);
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), Math.min(30000, Math.max(3000, Number(opts.timeoutMs) || 15000))) : null;
  try {
    const res = await fetchFn(c.url, { method: 'GET', headers, signal: ctrl ? ctrl.signal : undefined });
    if (timer) clearTimeout(timer);
    if (!res || !res.ok) return { ok: false, error: '获取目录失败：HTTP ' + (res ? res.status : '无响应'), status: res ? res.status : null };
    const text = await res.text();
    const parsed = parseCatalog(text);
    return Object.assign({ source: src.id, endpoint: c.url }, parsed);
  } catch (e) {
    if (timer) clearTimeout(timer);
    return { ok: false, error: '获取目录失败: ' + (e && e.name === 'AbortError' ? '超时' : (e && e.message) || '未知错误') };
  }
}

/**
 * 下载条目内容并做完整性校验。**不安装**，只返回校验结论与字节缓冲。
 * @param opts { fetchFn, timeoutMs, token, maxBytes }
 */
async function fetchItem(item, opts = {}) {
  const plan = planImport(item, { hasToken: !!opts.token });
  if (!plan.allowed) return { ok: false, error: plan.reasons.join('；'), plan };
  const c = checkEndpoint(item.downloadUrl);
  if (!c.ok) return { ok: false, error: c.error, plan };
  const fetchFn = opts.fetchFn || globalThis.fetch;
  if (typeof fetchFn !== 'function') return { ok: false, error: '当前环境不支持 fetch' };
  const maxBytes = Math.min(MAX_DOWNLOAD_BYTES, Number(opts.maxBytes) || MAX_DOWNLOAD_BYTES);
  const headers = {};
  if (opts.token) headers.Authorization = 'Bearer ' + String(opts.token);
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), Math.min(60000, Math.max(3000, Number(opts.timeoutMs) || 20000))) : null;
  try {
    const res = await fetchFn(c.url, { method: 'GET', headers, signal: ctrl ? ctrl.signal : undefined });
    if (timer) clearTimeout(timer);
    if (!res || !res.ok) return { ok: false, error: '下载失败：HTTP ' + (res ? res.status : '无响应'), plan };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) return { ok: false, error: '内容超过大小上限 ' + maxBytes + ' 字节', plan };
    const actual = sha256Hex(buf);
    if (item.sha256) {
      if (actual !== item.sha256) {
        return { ok: false, error: '完整性校验失败：sha256 不匹配（内容可能被篡改），已丢弃', expected: item.sha256, actual, plan };
      }
      return { ok: true, verified: true, bytes: buf.length, sha256: actual, buffer: buf, plan };
    }
    return { ok: true, verified: false, bytes: buf.length, sha256: actual, buffer: buf, plan, warning: '来源未提供 sha256，无法验证完整性' };
  } catch (e) {
    if (timer) clearTimeout(timer);
    return { ok: false, error: '下载失败: ' + (e && e.name === 'AbortError' ? '超时' : (e && e.message) || '未知错误'), plan };
  }
}

module.exports = {
  SCHEMA_VERSION, MAX_ITEMS, MAX_DOWNLOAD_BYTES, ITEM_TYPES, SOURCES,
  listSources, getSource, checkEndpoint, sha256Hex, validateItem, parseCatalog,
  planImport, fetchCatalog, fetchItem,
};
