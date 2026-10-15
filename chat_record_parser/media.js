'use strict';
// 聊天记录媒体处理：安全校验 + 提取图片/视频引用 + 转结构化文本 + 组装多模态 parts。
// 不依赖 ai_bridge：
//   - 真实取图字节由外部注入 fetchImageBytes(ref) -> dataURL|null；
//   - 取视频关键帧同样注入 fetchVideoFrames(ref,maxFrames) -> dataURL[] | null（本项目无 ffmpeg，默认不可用）。
const { guessMime } = require('./normalize');
const { LIMITS } = require('./parser');

// 媒体引用安全检查（路径穿越 / 危险目录 / 非 http(s) 一律拒绝）。
// 聊天记录里的 file 通常是 NapCat 缓存的绝对路径；url 通常是 QQ CDN 的 https 链接。
function isSafeMediaRef(ref) {
  if (!ref || typeof ref !== 'object') return false;
  const file = String(ref.file || '');
  const url = String(ref.url || '');

  if (url) {
    if (!/^https?:\/\//i.test(url)) return false;   // 仅放行 http(s)
    return true;
  }
  if (file) {
    if (/(\.\.\/)|(\.\.\\)/.test(file)) return false;        // 拒绝路径穿越
    if (/^file:\/\//i.test(file)) return true;               // file:// 形式（已由 NapCat 校验）
    if (/^[a-zA-Z]:[\\/]/.test(file) || file.startsWith('/')) {
      // 保守拒绝系统敏感目录
      if (/^[a-zA-Z]:[\\/]?(windows|system32|boot|programdata)/i.test(file)) return false;
      if (/^[a-zA-Z]:[\\/]?users\\[^\\]+\\(appdata|application data)/i.test(file)) return false;
      return true;
    }
  }
  return false;
}

// 收集图片引用（已按上限裁剪）
function collectImageRefs(messages, maxImages) {
  const cap = maxImages || LIMITS.maxImages;
  const out = [];
  if (!Array.isArray(messages)) return out;
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi] || {};
    for (let ci = 0; ci < (m.content || []).length; ci++) {
      const c = m.content[ci];
      if (c.type === 'image' && isSafeMediaRef(c)) {
        out.push({ messageIndex: mi, contentIndex: ci, ref: c });
        if (out.length >= cap) return out;
      }
    }
  }
  return out;
}

// 收集视频引用（已按上限裁剪）
function collectVideoRefs(messages, maxVideos) {
  const cap = maxVideos || LIMITS.maxVideos;
  const out = [];
  if (!Array.isArray(messages)) return out;
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi] || {};
    for (let ci = 0; ci < (m.content || []).length; ci++) {
      const c = m.content[ci];
      if (c.type === 'video' && isSafeMediaRef(c)) {
        out.push({ messageIndex: mi, contentIndex: ci, ref: c });
        if (out.length >= cap) return out;
      }
    }
  }
  return out;
}

// 把聊天记录转成“结构化纯文本”（不含 base64），供纯文本模型理解上下文。
// question 作为开头提示；maxTextChars 控制总长度。
function buildTextForModel(record, opts) {
  opts = opts || {};
  const maxChars = opts.maxTextChars || LIMITS.maxTextChars;
  const lines = [];
  if (record.summary) lines.push('【聊天记录摘要】' + record.summary);
  if (record.source) lines.push('【来源】' + record.source);
  const msgs = record.messages || [];
  lines.push('【聊天记录（按时间顺序，共 ' + msgs.length + ' 条）】');
  for (const m of msgs) {
    const who = m.nickname || ('用户' + (m.user_id || '?'));
    const time = m.time ? ('[' + m.time + '] ') : '';
    const parts = [];
    for (const c of (m.content || [])) {
      if (c.type === 'text') parts.push(c.text);
      else if (c.type === 'image') parts.push('[图片]');
      else if (c.type === 'video') parts.push('[视频' + (c.duration ? ' ' + c.duration + 's' : '') + (c.mime ? ' ' + c.mime : '') + ']');
      else if (c.type === 'audio') parts.push('[语音]');
      else if (c.type === 'reply') parts.push('[引用消息]');
      else if (c.type === 'forward') {
        // V14-C.3 C-1：内层拉到了就渲染成缩进子列表；拉不到就如实说明，绝不编造
        const inner = Array.isArray(c.messages) ? c.messages : [];
        if (inner.length) {
          const NEST_SHOW = 20;
          const sub = inner.slice(0, NEST_SHOW).map((im) => {
            const iwho = im && (im.nickname || ('用户' + ((im.user_id || '?'))));
            const itxt = ((im && im.content) || []).filter((x) => x && x.type === 'text')
              .map((x) => x.text).join(' ').trim();
            const hasOther = ((im && im.content) || []).some((x) => x && x.type !== 'text');
            return '    · ' + iwho + '：' + (itxt || (hasOther ? '[图片/视频等非文本内容]' : '（空）'));
          });
          if (inner.length > NEST_SHOW) sub.push('    · …（该层共 ' + inner.length + ' 条，仅展示前 ' + NEST_SHOW + ' 条）');
          parts.push('[嵌套合并转发，共 ' + inner.length + ' 条]\n' + sub.join('\n'));
        } else {
          const why = c.unavailable === 'fetch_failed' ? '（无权限或已过期，读不到内容）'
            : (c.unavailable === 'loop' ? '（循环引用，已跳过）'
              : (c.unavailable === 'capped' ? '（超出展开上限，已跳过）' : '（内容为空）'));
          parts.push('[嵌套合并转发' + why + ']');
        }
      }
      else parts.push('[' + (c.type || 'unknown') + ']');
    }
    lines.push(time + who + '：' + parts.join(' ').trim());
  }
  let text = lines.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…[文本已截断，超出 ' + maxChars + ' 字符上限]';
  return text;
}

// 组装发给多模态模型的 parts：提问文本 + 结构化文本（不含图 base64）+ 图片（dataURL）。
// 视频默认不塞（除非显式 analyzeVideos=true，且 fetchVideoFrames 可用）。
// fetchImageBytes(ref) 注入：传入统一 image content 项，返回 dataURL 或 null。
async function buildMultimodalParts(record, question, opts) {
  opts = opts || {};
  const fetchImageBytes = opts.fetchImageBytes;     // (ref) => Promise<dataURL|null>
  const fetchVideoFrames = opts.fetchVideoFrames;   // (ref,max) => Promise<dataURL[]|null>
  const parts = [];

  const intro = question ? ('用户的问题：' + question + '\n\n') : '';
  parts.push({
    type: 'text',
    text: intro + '以下是提交给你的 QQ 聊天记录（按时间顺序）。请结合用户的问题理解并回答（若用户没问具体问题，就概括这段对话讲了什么）。\n\n' + buildTextForModel(record, opts),
  });

  let imageOK = 0, imageFail = 0;
  const imgRefs = collectImageRefs(record.messages, opts.maxImages || LIMITS.maxImages);
  if (typeof fetchImageBytes === 'function') {
    for (const it of imgRefs) {
      try {
        const dataUrl = await fetchImageBytes(it.ref);
        if (dataUrl) { parts.push({ type: 'image_url', image_url: { url: dataUrl } }); imageOK++; }
        else imageFail++;
      } catch (e) { imageFail++; }
    }
  }

  // 视频：默认不自动分析（规格要求“视频不自动分析，仅用户显式要求时才处理”）
  let videoFrames = 0, videoNote = '';
  if (opts.analyzeVideos && typeof fetchVideoFrames === 'function') {
    const vidRefs = collectVideoRefs(record.messages, opts.maxVideos || LIMITS.maxVideos);
    for (const it of vidRefs) {
      try {
        const frames = await fetchVideoFrames(it.ref, opts.maxVideoFrames || LIMITS.maxVideoFrames);
        if (Array.isArray(frames)) {
          for (const f of frames.slice(0, opts.maxVideoFrames || LIMITS.maxVideoFrames)) {
            parts.push({ type: 'image_url', image_url: { url: f } }); videoFrames++;
          }
        }
      } catch (e) {}
    }
    videoNote = videoFrames ? ('（已附 ' + videoFrames + ' 帧视频关键帧）') : '（视频关键帧提取失败）';
  } else {
    const vidRefs = collectVideoRefs(record.messages, LIMITS.maxVideos);
    if (vidRefs.length) videoNote = '（本段含 ' + vidRefs.length + ' 个视频，默认未分析；如要看视频内容请明确说“分析这个视频”）';
  }

  if (videoNote) parts.push({ type: 'text', text: videoNote });

  return { parts, imageCount: imgRefs.length, imageOK, imageFail, videoFrames };
}

// 视频关键帧提取是“已知限制”：本项目无 ffmpeg CLI，无法直接抽帧。
// 这里只汇总已收集的视频元信息，供调用方在“用户显式要求”时再决定如何处理。
function summarizeVideos(record) {
  const refs = collectVideoRefs(record.messages, LIMITS.maxVideos);
  return refs.map((it, i) => ({
    index: i,
    messageIndex: it.messageIndex,
    duration: it.ref.duration || 0,
    hasUrl: !!it.ref.url,
    hasFile: !!it.ref.file,
    mime: it.ref.mime || guessMime(it.ref.url || it.ref.file || '', 'video/mp4'),
  }));
}

module.exports = {
  isSafeMediaRef, collectImageRefs, collectVideoRefs,
  buildTextForModel, buildMultimodalParts, summarizeVideos,
};
