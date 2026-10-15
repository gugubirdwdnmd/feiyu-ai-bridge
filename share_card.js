'use strict';
// ================= V14-C.2：QQ 原生分享卡片受控提取（独立零依赖模块，便于单测）=================
// 背景：QQ 分享卡片在 OneBot 里是 { type:'json', data:{ data:'{"app":"...","meta":{...}}' } }，
//       extractText() 只看 type==='text' → 卡片消息文本为空 → 被当空消息丢弃，机器人全程沉默。
// 做法：只做「取字段 + 拼短文本」，
//       · 不执行卡片里的任何内容（不 eval、不 evalScript、不取函数字段）
//       · 不把卡片原文交给模型（只交标题/摘要/URL 三段，且长度受限）
//       · URL 必须再过一次 SSRF 校验（由调用方传入校验函数，缺省则拒绝所有链接）

const SHARE_CARD_TAG = '[分享卡片]';
const CARD_TITLE_MAX = 60;
const CARD_DESC_MAX = 200;
const CARD_TEXT_MAX = 400;

function clipText(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return t.slice(0, n) + '…';
}

// 只取「字符串标量」，绝不取函数 / 嵌套对象 / 指令
function pickStr(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

// 从 meta.* 里挑一个「像内容载体」的对象（含 title/desc/url 任一）
function pickCardBody(meta) {
  if (!meta || typeof meta !== 'object') return null;
  for (const pref of ['news', 'detail_1', 'detail']) {
    if (meta[pref] && typeof meta[pref] === 'object') return meta[pref];
  }
  for (const k of Object.keys(meta)) {
    const v = meta[k];
    if (v && typeof v === 'object' && (v.title || v.desc)) return v;
  }
  return null;
}

// 兜底：结构化解析拿不到时，至少把 URL 和 QQ 给的 prompt 抽出来（绝不塞原文）
function fallbackFromRaw(raw) {
  const s = String(raw || '');
  const m = s.match(/https?:\/\/[^"'\s\\]{6,}/);
  const pm = s.match(/"prompt"\s*:\s*"([^"]{0,80})"/);
  return {
    url: m ? m[0].replace(/\\u0026/g, '&').replace(/&amp;/g, '&') : '',
    prompt: pm ? pm[1] : '',
  };
}

function stripPromptTag(s) {
  return String(s || '').replace(/^\[(分享|QQ小程序|链接|小程序)\]/, '').trim();
}

/**
 * 从消息段里提取分享卡片的可读文本
 * @param {Array} msgSegs OneBot 消息段数组
 * @param {object} opts { isSafeUrl(u)=>boolean, sanitizeUrl(u)=>string }
 * @returns {string} 形如「[分享卡片] 小黑盒｜标题\n摘要：…\n链接：…」；不是卡片返回 ''
 */
function extractShareCard(msgSegs, opts) {
  const o = opts || {};
  const isSafe = typeof o.isSafeUrl === 'function' ? o.isSafeUrl : function () { return false; };
  const sanitize = typeof o.sanitizeUrl === 'function' ? o.sanitizeUrl : function (u) { return u; };
  const segs = Array.isArray(msgSegs) ? msgSegs : [];

  for (const seg of segs) {
    if (!seg || (seg.type !== 'json' && seg.type !== 'xml')) continue;
    const raw = seg.data && seg.data.data;
    if (typeof raw !== 'string' || !raw.trim()) continue;

    let title = '', desc = '', url = '', tag = '';
    let j = null;
    try { j = JSON.parse(raw); } catch (e) { j = null; }

    if (j && typeof j === 'object') {
      const body = pickCardBody(j.meta);
      const prompt = stripPromptTag(pickStr(j, ['prompt']));
      title = pickStr(body, ['title']) || prompt;
      desc = pickStr(body, ['desc']);
      tag = pickStr(body, ['tag']) || pickStr(j.meta && j.meta.detail_1, ['title']) || '';
      // B站小程序卡片：title 只是平台名「哔哩哔哩」，真标题在 desc 里
      if ((body && body.title === '哔哩哔哩') && body.desc) { title = body.desc; desc = ''; }
      const rawUrl = pickStr(body, ['jumpUrl', 'qqdocurl', 'url']) || '';
      if (/^https?:\/\//i.test(rawUrl)) url = rawUrl;
    } else {
      const fb = fallbackFromRaw(raw);
      title = stripPromptTag(fb.prompt);
      if (/^https?:\/\//i.test(fb.url)) url = fb.url;
    }

    if (!title && !desc && !url) return SHARE_CARD_TAG + '（无法解析的分享卡片）';

    const lines = [];
    lines.push(clipText([SHARE_CARD_TAG, tag, title].filter(Boolean).join('｜'), CARD_TITLE_MAX));
    if (desc) lines.push('摘要：' + clipText(desc, CARD_DESC_MAX));
    if (url) {
      // 卡片里的 URL 同样要过 SSRF 校验，不因为是卡片内容就信任
      lines.push(isSafe(url)
        ? ('链接：' + clipText(sanitize(url), 200))
        : '链接：（未通过安全校验，已忽略）');
    }
    return clipText(lines.join('\n'), CARD_TEXT_MAX);
  }
  return '';
}

module.exports = {
  SHARE_CARD_TAG,
  CARD_TITLE_MAX,
  CARD_DESC_MAX,
  CARD_TEXT_MAX,
  clipText,
  pickStr,
  pickCardBody,
  fallbackFromRaw,
  extractShareCard,
};
