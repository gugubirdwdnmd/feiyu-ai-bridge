'use strict';
// ================= V14-C：Bilibili 搜索 Tool =================
// 现状（扫描确认）：项目此前**没有任何** Bilibili 代码，这是从零的最小实现。
// 原则：
//   · 零依赖，直接用 Node 内置 fetch；
//   · 请求地址**硬编码**为 api.bilibili.com，模型无法通过参数指定任意 URL → 结构上杜绝 SSRF；
//   · 只做「搜索」：拿标题 / BV号 / UP主 / 链接 / 简介，**绝不说成看懂了视频**；
//   · 拿不到字段就是 null，不编造。

const router = require('../agent/tool_router');
const R = require('./result');

const API_HOST = 'https://api.bilibili.com';
const SEARCH_PATH = '/x/web-interface/search/all/v2';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// B站搜索结果里的标题/简介带高亮标签，必须剥掉
function stripTags(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function toInt(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// 把 B站原始 item 收敛成稳定结构；字段缺失一律 null
function normalizeItem(d) {
  if (!d || typeof d !== 'object') return null;
  const bvid = typeof d.bvid === 'string' && /^BV[0-9A-Za-z]{6,}$/.test(d.bvid) ? d.bvid : null;
  // arcurl 有时是 av 号链接（http://），统一成 https + bvid 更可靠
  const url = bvid ? ('https://www.bilibili.com/video/' + bvid)
    : (/^https?:\/\/(www\.)?bilibili\.com\//.test(d.arcurl || '') ? String(d.arcurl).replace(/^http:/, 'https:') : null);
  return {
    title: stripTags(d.title) || null,
    bvid,
    author: stripTags(d.author) || null,
    url,
    description: stripTags(d.description) || null,
    duration: typeof d.duration === 'string' ? d.duration : null,
    pubdate: toInt(d.pubdate),
    play: toInt(d.play),
  };
}

// 输入清洗：拒绝空、超长、带协议/裸网址/纯符号的输入
function cleanQuery(q) {
  let s = String(q == null ? '' : q).trim();
  s = s.replace(/https?:\/\/\S+/gi, ' ').replace(/\s+/g, ' ').trim();
  return s;
}
function isBadQuery(q) {
  const s = String(q || '');
  if (!s.trim()) return 'query 不能为空';
  if (s.length > 60) return 'query 超长（上限 60 字）';
  if (/^[^\w\u4e00-\u9fa5]+$/.test(s.trim())) return 'query 不含有效内容';
  return '';
}

async function searchRaw(query, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = API_HOST + SEARCH_PATH + '?keyword=' + encodeURIComponent(query);
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/', 'Accept': 'application/json' },
    });
    const txt = await r.text();
    let j;
    try { j = JSON.parse(txt); } catch (e) { return { ok: false, error: 'B站返回非 JSON（可能被风控）' }; }
    if (!r.ok) return { ok: false, error: 'B站 HTTP ' + r.status };
    if (j.code !== 0) return { ok: false, error: 'B站接口错误 code=' + j.code + ' ' + String(j.message || '') };
    const groups = (j.data && Array.isArray(j.data.result)) ? j.data.result : [];
    const vg = groups.find((g) => g && g.result_type === 'video');
    const list = (vg && Array.isArray(vg.data)) ? vg.data : [];
    return { ok: true, items: list.map(normalizeItem).filter(Boolean) };
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? 'B站请求超时' : ('B站请求失败：' + String(e.message || e));
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

function register(deps) {
  const out = [];
  if (deps && deps.bilibiliEnabled === false) return out;

  const r = router.registerTool({
    name: 'bilibili_search',
    description:
      '在 B站（哔哩哔哩）搜索视频。只返回标题、BV号、UP主、链接和简介，' +
      '**不能**读取视频内容/字幕/音频。要分析视频画面请改用 video_analysis。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 60, description: '搜索关键词' },
        count: { type: 'number', minimum: 1, maximum: 8, description: '返回条数，默认 5' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    permission: router.PERMISSION.SAFE,
    timeout: 15000,
    tokenCost: 1,
    riskLevel: 'low',
    // 安全：请求地址是模块内硬编码的，这里只挡住"想通过 query 注入别的意图/地址"
    safety: (args) => {
      const bad = isBadQuery(args.query);
      if (bad) return { ok: false, error: bad };
      if (!cleanQuery(args.query)) return { ok: false, error: 'query 清洗后为空' };
      return { ok: true };
    },
    handler: async (args) => {
      const t0 = R.nowMs();
      const q = cleanQuery(args.query);
      const want = Math.max(1, Math.min(8, Number(args.count) || 5));
      const raw = await searchRaw(q, 12000);
      const ms = R.nowMs() - t0;
      if (!raw.ok) return R.failResult('bilibili_search', raw.error, true, { durationMs: ms });
      const items = raw.items.slice(0, want);
      if (!items.length) {
        return R.failResult('bilibili_search', 'B站没有搜到「' + q + '」相关视频', false, { durationMs: ms });
      }
      const lines = items.map((v, i) =>
        (i + 1) + '. ' + (v.title || '(无标题)') +
        ' | UP: ' + (v.author || '未知') +
        ' | ' + (v.duration || '?') +
        ' | ' + (v.url || '(无链接)'));
      return R.okResult('bilibili_search', {
        query: q,
        items,
        note: '仅搜索结果（标题/UP主/链接/简介），未获取视频内容，不要描述视频里讲了什么',
      }, 'B站搜索「' + q + '」共 ' + items.length + ' 条：' + lines.join('；').slice(0, 200), {
        durationMs: ms, itemCount: items.length,
      });
    },
  });
  if (r.ok) out.push('bilibili_search');
  return out;
}

module.exports = { register, stripTags, normalizeItem, cleanQuery, isBadQuery, searchRaw, API_HOST };
