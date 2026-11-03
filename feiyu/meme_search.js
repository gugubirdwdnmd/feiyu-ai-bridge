'use strict';

/**
 * 表情包联网检索——可选能力，**默认关闭**。
 *
 * 只做一件事：按关键词去【你自己配置好的】表情包接口检索，返回图片 URL 列表，
 * 交给既有的表情包发送链路（ai_bridge 的 send_sticker / [[表情]] 标记）去发。
 *
 * 安全约束（重要）：
 *   1. enabled 必须为 true 才启用；provider 只能是 'custom'（不内置任何第三方站点，
 *      避免把请求打到未知的、可能变更或收费的接口上）。
 *   2. endpoint 的 host 必须在 allowHosts 白名单里，且要过 url_safety.isSafeUrl
 *      （拦截私网/回环/链路本地/云元数据等 SSRF 目标）。
 *   3. 返回的图片 URL **也必须**逐个过 isSafeUrl，防止接口返回内网地址被直接下载。
 *   4. 有频率上限与结果缓存，避免刷接口；不缓存任何个人数据。
 *   5. 不读取、不输出任何密钥；apiKeyRef 只是「去 secrets.json 取哪个字段」的名字。
 *
 * ⚠ 本模块【未验证 UNVERIFIED】：
 *    仓库零第三方依赖、本机未配置任何表情包接口，本轮**未做真实联网检索**，
 *    测试全部为注入式 mock。真实效果需在配置好 endpoint 后自行验证。
 */

let urlSafety = null;
try { urlSafety = require('../url_safety'); } catch (e) { urlSafety = null; }
let safeHttp = null;
try { safeHttp = require('../safe_http'); } catch (e) { safeHttp = null; }

const DEFAULTS = {
  enabled: false,
  provider: 'none',        // 'none' | 'custom'
  endpoint: '',            // GET 检索端点，{q} 会被替换成 encodeURIComponent(关键词)
  allowHosts: [],          // 域名白名单（支持 *.example.com）
  timeoutMs: 8000,
  maxItems: 5,
  maxBytes: 4 * 1024 * 1024,
  cacheTtlMs: 10 * 60 * 1000,
  maxPerHour: 60,          // 每小时最多检索多少次
  apiKeyRef: '',           // 仅记录字段名，本模块不读取密钥
  // 结果里允许的字段（防止接口返回任意字段被直接使用）
  urlFields: ['url', 'image', 'img', 'src', 'file', 'gif'],
  titleFields: ['title', 'name', 'text', 'desc'],
};

let getCFG = () => ({});
function setConfig(fn) { if (typeof fn === 'function') getCFG = fn; }

// —— 进程内状态（不落盘）——
const cache = new Map();     // keyword -> { at, items }
let hourBucket = '';
let hourCount = 0;

function num(v, d, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, n));
}

function cfg() {
  const c = (typeof getCFG === 'function' && getCFG()) || {};
  const s = c.meme || {};
  return {
    enabled: s.enabled === true,
    provider: String(s.provider || DEFAULTS.provider).toLowerCase(),
    endpoint: String(s.endpoint || '').trim(),
    allowHosts: Array.isArray(s.allowHosts) ? s.allowHosts.map(String) : [],
    timeoutMs: num(s.timeoutMs, DEFAULTS.timeoutMs, 1000, 60000),
    maxItems: num(s.maxItems, DEFAULTS.maxItems, 1, 20),
    maxBytes: num(s.maxBytes, DEFAULTS.maxBytes, 1024, 32 * 1024 * 1024),
    cacheTtlMs: num(s.cacheTtlMs, DEFAULTS.cacheTtlMs, 0, 24 * 3600 * 1000),
    maxPerHour: num(s.maxPerHour, DEFAULTS.maxPerHour, 1, 10000),
    apiKeyRef: String(s.apiKeyRef || '').trim(),
    urlFields: Array.isArray(s.urlFields) && s.urlFields.length ? s.urlFields.map(String) : DEFAULTS.urlFields.slice(),
    titleFields: Array.isArray(s.titleFields) && s.titleFields.length ? s.titleFields.map(String) : DEFAULTS.titleFields.slice(),
  };
}

function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; }
}

function hostAllowed(host, allowHosts) {
  if (!host || !allowHosts.length) return false;
  const h = String(host).toLowerCase();
  for (const a of allowHosts) {
    const p = String(a).toLowerCase().trim();
    if (!p) continue;
    if (p === h) return true;
    if (p.startsWith('*.') && h.endsWith(p.slice(1))) return true;
  }
  return false;
}

function safe(u) {
  if (!u) return false;
  if (urlSafety && typeof urlSafety.isSafeUrl === 'function') return !!urlSafety.isSafeUrl(u);
  return /^https:\/\//i.test(String(u));   // 兜底：至少要 https
}

function takeRate(now) {
  const bucket = String(Math.floor(Number(now || Date.now()) / 3600000));
  if (bucket !== hourBucket) { hourBucket = bucket; hourCount = 0; }
  if (hourCount >= cfg().maxPerHour) return false;
  hourCount++;
  return true;
}

/**
 * 检索表情包。
 * @param {string} keyword
 * @param {object} o { now?:number, fetch?:function }  fetch 仅供测试注入（不联网）
 * @returns {{ok:boolean, items?:Array<{url:string,title:string,source:string}>, reason?:string}}
 *   reason: 'disabled' | 'provider-none' | 'no-endpoint' | 'host-not-allowed'
 *           | 'unsafe-url' | 'no-keyword' | 'rate-limited' | 'fetch-failed'
 *           | 'bad-response' | 'no-safe-items'
 */
async function search(keyword, o) {
  o = o || {};
  const c = cfg();
  const kw = String(keyword || '').trim();
  if (!c.enabled) return { ok: false, reason: 'disabled' };
  if (!kw) return { ok: false, reason: 'no-keyword' };
  if (c.provider !== 'custom') return { ok: false, reason: 'provider-none' };
  if (!c.endpoint) return { ok: false, reason: 'no-endpoint' };
  if (!hostAllowed(hostOf(c.endpoint), c.allowHosts)) return { ok: false, reason: 'host-not-allowed' };
  if (!safe(c.endpoint)) return { ok: false, reason: 'unsafe-url' };

  const now = Number(o.now) || Date.now();
  // 缓存命中
  const hit = cache.get(kw.toLowerCase());
  if (hit && c.cacheTtlMs > 0 && now - hit.at < c.cacheTtlMs) {
    return { ok: true, items: hit.items.slice(0, c.maxItems), source: 'cache' };
  }
  if (!takeRate(now)) return { ok: false, reason: 'rate-limited' };

  const url = c.endpoint.replace(/\{q\}/g, encodeURIComponent(kw));
  if (!safe(url)) return { ok: false, reason: 'unsafe-url' };

  let text = '';
  try {
    if (typeof o.fetch === 'function') {
      // 测试注入（不联网）
      const r = await o.fetch(url);
      text = r && r.text != null ? String(r.text) : '';
    } else if (safeHttp && typeof safeHttp.safeFetch === 'function') {
      const r = await safeHttp.safeFetch(url, { method: 'GET', timeoutMs: c.timeoutMs, maxBytes: c.maxBytes });
      text = r && r.text != null ? String(r.text) : '';
    } else {
      return { ok: false, reason: 'fetch-failed' };
    }
  } catch (e) {
    return { ok: false, reason: 'fetch-failed' };
  }

  const items = parseItems(text, c);
  if (!items.length) return { ok: false, reason: 'bad-response' };
  const safeItems = items.filter((x) => safe(x.url));
  if (!safeItems.length) return { ok: false, reason: 'no-safe-items' };

  const finalItems = safeItems.slice(0, c.maxItems);
  cache.set(kw.toLowerCase(), { at: now, items: finalItems });
  return { ok: true, items: finalItems, source: 'net' };
}

/** 从响应文本里提取条目：兼容 {"data":[...]} / [...]} / 纯文本行 */
function parseItems(text, c) {
  const out = [];
  const push = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    let url = '';
    for (const f of c.urlFields) {
      const v = obj[f];
      if (typeof v === 'string' && /^https?:\/\//i.test(v)) { url = v; break; }
    }
    if (!url) return;
    let title = '';
    for (const f of c.titleFields) {
      const v = obj[f];
      if (typeof v === 'string') { title = v.slice(0, 60); break; }
    }
    out.push({ url, title, source: 'custom' });
  };

  try {
    const j = JSON.parse(text);
    const arr = Array.isArray(j) ? j : (Array.isArray(j && j.data) ? j.data : (Array.isArray(j && j.items) ? j.items : (Array.isArray(j && j.result) ? j.result : null)));
    if (arr) { arr.slice(0, 50).forEach(push); return out; }
    push(j);
    return out;
  } catch (e) { /* 不是 JSON，按行处理 */ }

  String(text || '').split(/\r?\n/).slice(0, 50).forEach((line) => {
    const m = String(line).match(/https?:\/\/\S+/);
    if (m) push({ url: m[0], title: '' });
  });
  return out;
}

/** 清空进程内缓存与计数（测试用） */
function _reset() {
  cache.clear();
  hourBucket = '';
  hourCount = 0;
}

module.exports = {
  DEFAULTS,
  setConfig, cfg,
  search, parseItems, hostAllowed, safe,
  _reset,
};
