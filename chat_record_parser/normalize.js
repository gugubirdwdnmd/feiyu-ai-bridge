'use strict';
// 把 NapCat / OneBot11 原始聊天记录节点规范成统一结构。
// 只读解析，绝不抛错（任何异常都降级处理，保证 二十六 的“不崩溃”要求）。

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska', '.webm': 'video/webm',
};

function guessMime(u, fallback) {
  const s = String(u || '').split('?')[0].toLowerCase();
  for (const ext of Object.keys(MIME_BY_EXT)) if (s.endsWith(ext)) return MIME_BY_EXT[ext];
  return fallback || 'application/octet-stream';
}

// ================= V14-C.3 C-2：聊天记录里的分享卡片受控提取 =================
// 旧实现把卡片的**整段原始 JSON** 当正文塞进聊天记录：既不可读，又会挤爆
// maxTextChars（20000）把后面的消息全截断。改为复用 V14-C.2 的 share_card 模块
// （同一套解析，不重复实现），只取 标题/摘要/URL，单条限长 200 字。
// 卡片里的 URL 同样要过 SSRF 校验（url_safety 也是零依赖独立模块，不是 ai_bridge）。
const shareCard = require('../share_card.js');
const urlSafety = require('../url_safety.js');
const CARD_TEXT_IN_RECORD_MAX = 200;

function normSender(s) {
  s = s || {};
  const uid = String(s.user_id != null ? s.user_id : '').trim();
  const nickname = String(s.nickname || s.card || '').trim();
  return {
    user_id: uid || 'unknown',
    nickname: nickname || ('用户' + (uid && uid !== 'unknown' ? uid : '?')),
    card: String(s.card || ''),
    role: s.role || '',
  };
}

function recurseNodes(arr) {
  return (Array.isArray(arr) ? arr : []).map((n, i) => normalizeNode(n, i)).filter(Boolean);
}

// 单个 segment → 统一 content 项；返回 null 表示忽略
function segToContent(seg) {
  if (seg == null) return null;
  if (typeof seg === 'string') return seg ? { type: 'text', text: seg } : null;
  if (typeof seg !== 'object') return null;
  const t = seg.type;
  const d = seg.data || {};
  switch (t) {
    case 'text': {
      const txt = String(d.text || '');
      return txt ? { type: 'text', text: txt } : null;
    }
    case 'image':
      return { type: 'image', file: String(d.file || ''), url: String(d.url || ''), mime: guessMime(d.url || d.file || '', 'image/jpeg'), sub_type: d.sub_type || '' };
    case 'video':
      return { type: 'video', file: String(d.file || ''), url: String(d.url || ''), duration: Number(d.duration) || 0, mime: guessMime(d.url || d.file || '', 'video/mp4') };
    case 'record': // 语音
      return { type: 'audio', file: String(d.file || ''), url: String(d.url || '') };
    case 'reply': // 引用/回复
      return { type: 'reply', id: String(d.id || ''), text: String(d.text || '') };
    case 'at':
      return { type: 'text', text: '@' + String(d.qq || d.name || '某人') + ' ' };
    case 'face':
    case 'bface':
    case 'sface':
      return { type: 'text', text: (d.text || '[表情]') + ' ' };
    case 'forward': {
      const inner = Array.isArray(d.content) ? d.content : null;
      const fid = String(d.id || '');
      if (inner && inner.length) return { type: 'forward', id: fid, messages: recurseNodes(inner) };
      // V14-C.3 C-1：无内联内容但带 id → 保留 id 与空 messages，
      // 由 parser 用已注入的 getForwardMsg 受限展开（深度 ≤2）；展开失败会标 unavailable。
      if (fid) return { type: 'forward', id: fid, messages: [] };
      return { type: 'text', text: '[合并转发]' };
    }
    case 'json':
    case 'xml': {
      // V14-C.3 C-2：只做「取字段 + 拼短文本」，卡片原文/指令一律不当正文也不执行
      const txt = shareCard.clipText(
        shareCard.extractShareCard([seg], {
          isSafeUrl: urlSafety.isSafeUrl,
          sanitizeUrl: urlSafety.sanitizeUrlForUse,
        }),
        CARD_TEXT_IN_RECORD_MAX
      );
      return txt ? { type: 'text', text: txt } : null;
    }
    default:
      if (d && d.text) return { type: 'text', text: String(d.text) };
      return null;
  }
}

function normalizeNode(raw, idx) {
  // 非对象（null / 字符串 / 数字 / 数组）不是合法节点 → 直接丢弃，
  // 否则会产生「用户?：」这种空壳消息，污染聊天记录文本。
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  raw = raw || {};
  const sender = normSender(raw.sender);
  let rawTime = raw.time != null ? raw.time : (raw.time || '');
  let ts = 0;
  if (typeof rawTime === 'number') ts = rawTime;
  else if (typeof rawTime === 'string') {
    if (/^\d+$/.test(rawTime)) ts = Number(rawTime);
    else { const t = Date.parse(rawTime); if (!isNaN(t)) ts = t; }
  }
  let timeStr;
  if (ts) {
    // QQ 时间戳通常是秒；毫秒(>1e12)则转换
    const ms = ts > 1e12 ? ts : ts * 1000;
    const dt = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    timeStr = `${p(dt.getMonth() + 1)}/${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
  } else {
    timeStr = typeof rawTime === 'string' && rawTime ? rawTime : ('#' + (idx + 1));
  }
  // 兼容 message / content / data.message 三种承载方式
  const msgArr = Array.isArray(raw.message) ? raw.message
    : Array.isArray(raw.data && raw.data.message) ? raw.data.message
    : Array.isArray(raw.content) ? raw.content : [];
  const content = [];
  for (const seg of msgArr) {
    const c = segToContent(seg);
    if (c) content.push(c);
  }
  return { time: timeStr, ts, user_id: sender.user_id, nickname: sender.nickname, card: sender.card, role: sender.role, content };
}

module.exports = { normSender, segToContent, normalizeNode, guessMime, MIME_BY_EXT };
