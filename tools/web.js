'use strict';
// ================= V14-B：Web Tool =================
// 原则：不重新实现搜索引擎，只包装现有 webSearch / fetchUrl。
//       SSRF 防护继续走现有 isSafeUrl()，不因为 Tool Router 有 Schema 就跳过。

const router = require('../agent/tool_router');
const R = require('./result');

const WEB_FAIL = ['没搜到相关结果'];
const FETCH_FAIL = ['这个地址不允许访问', '打开网页失败', '不是网页内容'];

// query 里不允许出现裸网址 / 裸 IP（那是 fetch_url 的活）
function stripUrls(q) {
  return String(q || '').replace(/https?:\/\/\S+/gi, ' ').replace(/\s+/g, ' ').trim();
}

function isBareIp(s) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(s || '').trim());
}

function register(deps) {
  const out = [];

  // ---------------- web_search ----------------
  if (typeof deps.webSearch === 'function') {
    const r = router.registerTool({
      name: 'web_search',
      description:
        '在互联网上搜索实时信息（新闻/天气/价格/最新进展）。query 要短，1~3 个核心词；不要塞网址。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 60, description: '搜索关键词' },
          count: { type: 'number', minimum: 1, maximum: 8, description: '返回条数，默认 4' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      permission: router.PERMISSION.SAFE,
      timeout: 20000,
      tokenCost: 1,
      riskLevel: 'low',
      safety: (args) => {
        const q = String(args.query || '');
        if (isBareIp(q)) return { ok: false, error: '不支持查询裸 IP 地址' };
        const stripped = stripUrls(q);
        if (!stripped) return { ok: false, error: 'query 里只有网址，请改用 fetch_url，或换个关键词' };
        return { ok: true };
      },
      handler: async (args) => {
        const t0 = R.nowMs();
        const query = stripUrls(args.query) || String(args.query || '').trim();
        const raw = await deps.webSearch(query, args.count);
        const ms = R.nowMs() - t0;
        const s = String(raw == null ? '' : raw);
        if (R.looksFailed(s, WEB_FAIL)) {
          return R.failResult('web_search', '搜索未返回任何结果（' + query + '）', true, { durationMs: ms });
        }
        const itemCount = (s.match(/^\d+\.\s/gm) || []).length || 1;
        return R.okResult('web_search', { query, text: s }, s.slice(0, 220), { durationMs: ms, itemCount });
      },
    });
    if (r.ok) out.push('web_search');
  }

  // ---------------- fetch_url ----------------
  if (typeof deps.fetchUrl === 'function') {
    const r = router.registerTool({
      name: 'fetch_url',
      description:
        '打开一个 http/https 网页并读取正文。内网地址、本机地址、file://、本地路径一律拒绝。',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', minLength: 8, maxLength: 500 } },
        required: ['url'],
        additionalProperties: false,
      },
      permission: router.PERMISSION.SAFE,
      timeout: 20000,
      tokenCost: 1,
      riskLevel: 'low',
      // 关键：继续复用 ai_bridge 现有的 isSafeUrl()，不另起炉灶
      safety: (args) => {
        const u = String(args.url || '');
        if (/^[a-zA-Z]:[\\/]/.test(u) || u.startsWith('file:') || u.startsWith('\\\\')) {
          return { ok: false, error: '不接受本地路径 / file:// 地址' };
        }
        if (typeof deps.isSafeUrl === 'function' && !deps.isSafeUrl(u)) {
          return { ok: false, error: 'URL 未通过 SSRF 安全校验（内网 / 本机 / 非 http(s) 一律拒绝）' };
        }
        return { ok: true };
      },
      handler: async (args) => {
        const t0 = R.nowMs();
        const raw = await deps.fetchUrl(args.url);
        const ms = R.nowMs() - t0;
        const s = String(raw == null ? '' : raw);
        if (R.looksFailed(s, FETCH_FAIL)) {
          return R.failResult('fetch_url', '读取网页失败：' + s.slice(0, 80), false, { durationMs: ms });
        }
        return R.okResult('fetch_url', { url: args.url, text: s }, s.slice(0, 220), { durationMs: ms, itemCount: 1 });
      },
    });
    if (r.ok) out.push('fetch_url');
  }

  return out;
}

module.exports = { register, WEB_FAIL, FETCH_FAIL, stripUrls, isBareIp };
