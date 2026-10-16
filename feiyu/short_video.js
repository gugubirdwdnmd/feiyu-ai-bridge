'use strict';

/**
 * 短视频识别：认出消息里的短视频链接属于哪个平台，并**如实**告诉用户能看到什么。
 *
 * 重要边界（不吹牛）：
 *   - **不会去抓第三方页面**。抖音/快手等平台有强反爬，抓取既不稳定也可能违反其条款，
 *     本模块只做「认出平台 + 提取标题 + 如实说明看不了内容」，不假装能看懂。
 *   - 真正能"看内容"的只有 **QQ 原生视频段**（走既有的 video_analysis：元数据 + 首帧视觉理解）。
 *   - 若你自己有合规的解析接口，可配置 `parser`（默认关），才会去请求；
 *     且必须过域名白名单 + SSRF 校验。未配置时一律返回"看不了"，不猜。
 *
 * 设计原则：
 *   1. 默认启用识别（只是认平台，零成本、零网络）。
 *   2. 任何解析失败一律降级为"如实说明"，绝不打断聊天。
 *   3. 不打印、不记录完整链接正文（日志只记平台名）。
 */

const DEFAULTS = {
  enabled: true,
  // 是否向模型注入"这是什么链接、能看到什么"的说明
  injectHint: true,
  // 可选的解析接口（默认关）。配了才会发请求，且要过白名单。
  parser: {
    enabled: false,
    endpoint: '',            // 支持 {url} 占位
    allowHosts: [],
    timeoutMs: 10000,
  },
};

// —— 平台识别表：name + 域名/路径特征 ——
const PLATFORMS = [
  { name: '抖音', re: /(?:www\.)?(?:douyin|iesdouyin)\.com/i },
  { name: '快手', re: /(?:www\.)?(?:kuaishou|chenzhongtech|gifshow)\.com/i },
  { name: 'B站', re: /(?:www\.)?bilibili\.com\/video|b23\.tv|BV[0-9A-Za-z]{10}/i },
  { name: '小红书', re: /(?:www\.)?xiaohongshu\.com|xhslink\.com/i },
  { name: '微信视频号', re: /finder\.video\.qq\.com|channels\.weixin\.qq\.com/i },
  { name: '微博视频', re: /(?:www\.)?weibo\.com\/.*video|miaopai|video\.weibo\.com/i },
  { name: '西瓜视频', re: /(?:www\.)?ixigua\.com/i },
  { name: '微视', re: /(?:www\.)?weishi\.qq\.com/i },
  { name: 'QQ短视频', re: /qlive\.qq\.com|h5\.qzone\.qq\.com.*video/i },
];

const URL_RE = /https?:\/\/[^\s，,、）)"'】\]]+/gi;

let urlSafety = null;
try { urlSafety = require('../url_safety'); } catch (e) { urlSafety = null; }
let safeHttp = null;
try { safeHttp = require('../safe_http'); } catch (e) { safeHttp = null; }

let getCFG = () => ({});
function setConfig(fn) { if (typeof fn === 'function') getCFG = fn; }

function cfg() {
  const c = (typeof getCFG === 'function' && getCFG()) || {};
  const s = c.shortVideo || {};
  const p = s.parser || {};
  return {
    enabled: s.enabled !== false,
    injectHint: s.injectHint !== false,
    parser: {
      enabled: p.enabled === true,
      endpoint: String(p.endpoint || '').trim(),
      allowHosts: Array.isArray(p.allowHosts) ? p.allowHosts.map(String) : [],
      timeoutMs: Number(p.timeoutMs) > 0 ? Number(p.timeoutMs) : DEFAULTS.parser.timeoutMs,
    },
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

/**
 * 从文本里识别短视频链接。
 * @returns {{platform:string, url:string}|null}
 */
function detect(text) {
  const c = cfg();
  if (!c.enabled) return null;
  const t = String(text || '');
  if (!t) return null;
  const urls = t.match(URL_RE) || [];
  for (const u of urls) {
    for (const p of PLATFORMS) {
      if (p.re.test(u)) return { platform: p.name, url: u };
    }
  }
  return null;
}

/** 认出平台名（用于日志，不输出链接正文） */
function platformOf(url) {
  for (const p of PLATFORMS) if (p.re.test(String(url || ''))) return p.name;
  return null;
}

/**
 * 给模型注入的说明文本：如实告知"这是哪个平台的链接、目前能看到什么、看不了什么"。
 * 不做任何抓取，也不编造内容。
 */
function hint(detected) {
  if (!detected) return '';
  return `【短视频链接】这是「${detected.platform}」的分享链接。`
    + '你目前只能看到标题/文案，看不到视频画面内容——不要编造视频里有什么。'
    + '如果对方想让你看内容，请他直接把视频发到群里（或发截图）。';
}

/**
 * 可选解析（默认关闭）。只有显式配置了 endpoint 且 host 在白名单才发请求。
 * @returns {Promise<{ok:boolean, title?:string, text?:string, reason?:string}>}
 *   reason: 'disabled' | 'no-endpoint' | 'host-not-allowed' | 'unsafe-url' | 'fetch-failed'
 */
async function tryParse(detected, o) {
  o = o || {};
  const c = cfg();
  if (!c.enabled) return { ok: false, reason: 'disabled' };
  if (!detected) return { ok: false, reason: 'no-endpoint' };
  if (!c.parser.enabled || !c.parser.endpoint) return { ok: false, reason: 'no-endpoint' };
  if (!hostAllowed(hostOf(c.parser.endpoint), c.parser.allowHosts)) {
    return { ok: false, reason: 'host-not-allowed' };
  }
  if (urlSafety && typeof urlSafety.isSafeUrl === 'function' && !urlSafety.isSafeUrl(c.parser.endpoint)) {
    return { ok: false, reason: 'unsafe-url' };
  }
  const url = c.parser.endpoint.replace(/\{url\}/g, encodeURIComponent(detected.url));
  if (urlSafety && typeof urlSafety.isSafeUrl === 'function' && !urlSafety.isSafeUrl(url)) {
    return { ok: false, reason: 'unsafe-url' };
  }
  try {
    if (typeof o.fetch === 'function') {
      const r = await o.fetch(url);
      return { ok: true, text: String((r && r.text) || '') };
    }
    if (safeHttp && typeof safeHttp.safeFetch === 'function') {
      const r = await safeHttp.safeFetch(url, { method: 'GET', timeoutMs: c.parser.timeoutMs });
      return { ok: true, text: String((r && r.text) || '') };
    }
  } catch (e) { /* 落到下面 */ }
  return { ok: false, reason: 'fetch-failed' };
}

module.exports = {
  DEFAULTS, PLATFORMS,
  setConfig, cfg,
  detect, platformOf, hint, tryParse, hostAllowed,
};
