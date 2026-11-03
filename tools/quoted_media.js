'use strict';
/**
 * 被引用消息（QQ 引用/回复段）的图片与文本抽取 —— 纯函数，零依赖，可单测。
 *
 * 背景：OneBot/NapCat 里「引用某条消息」表现为消息段里的 { type:'reply', data:{ id } }。
 * 被引用的那条消息可能：
 *   ① 还在本地群缓冲里（ai_bridge 的 groupBuffers）→ 直接读缓冲条目；
 *   ② 已不在缓冲（机器人当时不在线 / 缓冲滚动）→ 需调 get_msg 拉回。
 * 本模块只负责「给定一段消息结构，抽出其中的图片段与文本」，不碰网络与状态，
 * 便于对「群聊引用图片未正确回复」这条链路做单测。
 */

// 与 ai_bridge.js 的 MAX_IMAGES 保持一致；仅作为本模块单测的默认上限。
const MAX_IMAGES = 3;

// 把 OneBot 的 message 归一成段数组：
//   - 已是数组 → 直接用
//   - 是对象且带 .message → 取 .message（数组或 CQ 字符串）
//   - 是 CQCode 字符串（[CQ:image,...]）→ 解析成段数组
function toSegments(message) {
  if (message == null) return [];
  if (Array.isArray(message)) return message;
  if (typeof message === 'string') return parseCQ(message);
  if (Array.isArray(message.message)) return message.message;
  if (typeof message.message === 'string') return parseCQ(message.message);
  return [];
}

// 极简 CQCode 解析（只取 type 与 data.*，不做任何外部请求）
function parseCQ(str) {
  const out = [];
  const re = /\[CQ:([a-z0-9_]+)(?:,([^\]]*))?\]/g;
  let m;
  while ((m = re.exec(str))) {
    const type = m[1];
    const data = {};
    if (m[2]) {
      for (const kv of m[2].split(',')) {
        const i = kv.indexOf('=');
        if (i >= 0) {
          const k = decodeURIComponent(kv.slice(0, i));
          const v = decodeURIComponent(kv.slice(i + 1));
          data[k] = v;
        }
      }
    }
    out.push({ type, data });
  }
  return out;
}

// 从任意消息结构里抽出所有图片段
function imageSegsOf(message) {
  return toSegments(message).filter((s) => s && s.type === 'image');
}

// 从任意消息结构里抽出纯文本（拼多段 text）
function textOf(message) {
  return toSegments(message)
    .filter((s) => s && s.type === 'text')
    .map((s) => (s.data && s.data.text) || '')
    .join('')
    .trim();
}

// 图片段的去重键：优先 file / url / path，兜底整段 JSON
function segKey(seg) {
  return (seg && seg.data && (seg.data.file || seg.data.url || seg.data.path)) || JSON.stringify(seg && seg.data);
}

// 合并「被引用消息」的图片段：
//   - buffered：本地缓冲命中的被引用条目（{ imgSegs:[...], text }）—— 优先、更快、更可信
//   - fetched：get_msg 拉回的原始结果（{ data:{ message } } 或 message 数组）—— 作为补充
//   按 file/url 去重，上限 maxImages，绝不返回非图片段。
function coalesceQuotedImages({ buffered, fetched, maxImages = MAX_IMAGES } = {}) {
  const seen = new Set();
  const out = [];
  const push = (seg) => {
    if (!seg || seg.type !== 'image') return;
    const key = segKey(seg);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(seg);
  };
  if (buffered && Array.isArray(buffered.imgSegs)) {
    for (const s of buffered.imgSegs) push(s);
  }
  if (fetched != null) {
    const src = (fetched && fetched.data) ? fetched.data : fetched;
    for (const s of imageSegsOf(src)) push(s);
  }
  return out.slice(0, maxImages);
}

// 视觉拼接：当前消息图片在前（保证图生图 source="1" 语义不变），被引用图片在后。
// 去重避免当前图与被引用图重复计费。
function mergeVisionSegs(baseSegs, quotedSegs, maxImages = MAX_IMAGES) {
  const seen = new Set();
  const out = [];
  const push = (seg) => {
    if (!seg || seg.type !== 'image') return;
    const key = segKey(seg);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(seg);
  };
  for (const s of (baseSegs || [])) push(s);
  for (const s of (quotedSegs || [])) push(s);
  return out.slice(0, maxImages);
}

module.exports = {
  MAX_IMAGES,
  parseCQ,
  toSegments,
  imageSegsOf,
  textOf,
  coalesceQuotedImages,
  mergeVisionSegs,
};
