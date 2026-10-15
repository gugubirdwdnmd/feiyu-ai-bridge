'use strict';
// 聊天记录解析编排：检测合并转发 → 拉取 → 规范 → 限流 → 统一结构。
// 设计原则（V13.5 硬性要求）：
//   ① 只读解析，绝不抛错（任何异常都降级处理）；
//   ② 不依赖 ai_bridge：外部能力（get_forward_msg）通过参数注入，便于独立 ≥30 项测试；
//   ③ 统一输出 {type:"chat_record", messages:[{time,user_id,nickname,content:[...]}]}。
const { normalizeNode } = require('./normalize');

// 限流上限（与规格一致）：消息数 / 图片数 / 视频数 / 视频关键帧 / 文本字符
const LIMITS = {
  maxMessages: 100,
  maxImages: 10,
  maxVideos: 3,
  maxVideoFrames: 8,
  maxTextChars: 20000,
};

// 生成聊天记录 ID：cr_YYYYMMDD_xxxxxx（与现有 chatId 区分）
function genChatRecordId(d) {
  const now = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  const rnd = Math.random().toString(36).slice(2, 8);
  return `cr_${date}_${rnd}`;
}

// 从一条 OneBot message 数组里找出所有 forward 段（兼容合并转发 / 普通转发）
function detectForwardSegments(message) {
  const segs = Array.isArray(message) ? message : [];
  const out = [];
  for (const s of segs) {
    if (s && s.type === 'forward') {
      const d = s.data || {};
      out.push({
        id: String(d.id || ''),
        summary: d.summary != null ? String(d.summary) : '',
        source: d.source != null ? String(d.source) : '',
        prompt: d.prompt != null ? String(d.prompt) : '',
        news: Array.isArray(d.news) ? d.news : null,
        content: Array.isArray(d.content) ? d.content : null, // 仅当 NapCat 直接内联时才存在
      });
    }
  }
  return out;
}

// 限流：裁剪消息数、图片数、视频数、单条累计文本长度；返回 {messages, limitsApplied}
function applyLimits(record, opts) {
  const o = Object.assign({}, LIMITS, opts || {});
  const limitsApplied = { truncated: false };
  let messages = record.messages || [];

  if (messages.length > o.maxMessages) {
    messages = messages.slice(0, o.maxMessages);
    limitsApplied.truncated = true;
    limitsApplied.messagesCappedAt = o.maxMessages;
  }

  let imgCount = 0, vidCount = 0, textChars = 0;
  for (const m of messages) {
    if (!m.content) continue;
    let ti = 0;
    const newContent = [];
    for (const c of m.content) {
      if (c.type === 'image') {
        if (imgCount >= o.maxImages) { limitsApplied.truncated = true; continue; } // 丢弃超上限图片
        imgCount++;
      } else if (c.type === 'video') {
        if (vidCount >= o.maxVideos) { limitsApplied.truncated = true; continue; } // 丢弃超上限视频
        vidCount++;
      } else if (c.type === 'text') {
        if (ti + c.text.length > o.maxTextChars) {
          const MARK = '…[截断]';
          const remain = o.maxTextChars - ti;
          // 截断后总长严格 <= maxTextChars（给省略标记预留位置）
          const keep = Math.max(0, remain - MARK.length);
          c.text = keep > 0 ? c.text.slice(0, keep) + MARK : (remain > 0 ? c.text.slice(0, remain) : '');
          ti = o.maxTextChars;
          limitsApplied.truncated = true;
        } else {
          ti += c.text.length;
        }
      } else if (c.type === 'forward') {
        // 嵌套合并转发：保留其内部结构，不展开（避免递归爆炸）
        c.messages = Array.isArray(c.messages) ? c.messages.slice(0, o.maxMessages) : c.messages;
      }
      newContent.push(c);
    }
    m.content = newContent;
    textChars += ti;
  }
  limitsApplied.images = imgCount;
  limitsApplied.videos = vidCount;
  limitsApplied.textChars = textChars;
  return { messages, limitsApplied };
}

// ================= V14-C.3 C-1：嵌套合并转发受限展开 =================
// 现象：合并转发里再套一层合并转发时，内层节点只有 id 没有内联 content，
//       旧实现只能退化成「[合并转发]」占位符 → 用户看到「只能读外层标题」。
// 硬边界（防无限递归 / 无限 API 调用）：
//   · NEST_MAX_DEPTH：最大递归深度 2（外层记录算第 1 层，内层展开 1 次即停）
//   · NEST_MAX_CALLS：getForwardMsg 总调用次数上限
//   · NEST_MAX_NODES：累计额外拉取并写入的节点数上限
//   · 已访问过的 id 不再拉（防循环引用 / 自引用）
//   · 拉取抛错或返回空 → 标 unavailable='fetch_failed'，绝不编造内容
const NEST_MAX_DEPTH = 2;
const NEST_MAX_CALLS = 5;
const NEST_MAX_NODES = 60;

async function expandNestedForwards(messages, getForwardMsg, depth, state) {
  if (depth >= NEST_MAX_DEPTH) return;
  if (!Array.isArray(messages)) return;
  for (const m of messages) {
    if (!m || !Array.isArray(m.content)) continue;
    for (const c of m.content) {
      if (!c || c.type !== 'forward') continue;
      // 已有内联内容 → 不必拉取，继续往下层走（深度仍受控）
      if (Array.isArray(c.messages) && c.messages.length) {
        await expandNestedForwards(c.messages, getForwardMsg, depth + 1, state);
        continue;
      }
      if (!c.id) { c.unavailable = 'no_id'; continue; }
      if (state.ids.has(c.id)) { c.unavailable = 'loop'; continue; }          // 循环引用
      if (state.calls >= NEST_MAX_CALLS) { c.unavailable = 'capped'; continue; }
      if (state.nodes >= NEST_MAX_NODES) { c.unavailable = 'capped'; continue; }

      state.ids.add(c.id);
      state.calls++;
      let raw = [];
      try {
        const r = await getForwardMsg(c.id);
        if (Array.isArray(r) && r.length) raw = r;
      } catch (e) {
        raw = [];                                    // 无权限 / 已过期 / 接口异常 → 不抛
      }
      if (!raw.length) { c.unavailable = 'fetch_failed'; continue; }

      const inner = [];
      raw.slice(0, NEST_MAX_NODES - state.nodes).forEach((n, i) => {
        try { const mm = normalizeNode(n, i); if (mm) inner.push(mm); } catch (e) { /* 单条失败不影响整体 */ }
      });
      state.nodes += inner.length;
      c.messages = inner;
      if (inner.length) delete c.unavailable; else c.unavailable = 'empty';
      await expandNestedForwards(inner, getForwardMsg, depth + 1, state);
    }
  }
}

// 主入口。input: {id, summary, source, prompt, content?, getForwardMsg?(id), limits?}
// getForwardMsg 由外部注入（ai_bridge 里 = napcatCall('get_forward_msg',{id}).data.messages）
async function buildChatRecord(input) {
  input = input || {};
  const id = input.id || '';
  let rawNodes = [];

  // 优先用内联 content（部分来源直接给出），否则走 API 拉取
  if (Array.isArray(input.content) && input.content.length) {
    rawNodes = input.content;
  } else if (id && typeof input.getForwardMsg === 'function') {
    try {
      const r = await input.getForwardMsg(id);
      if (Array.isArray(r) && r.length) rawNodes = r;
    } catch (e) {
      // 拉取失败 → 降级，由调用方决定是否提示用户
      return { type: 'chat_record', error: 'fetch_failed', id, messages: [], chatRecordId: genChatRecordId(), counts: { messages: 0, images: 0, videos: 0, textChars: 0 }, limitsApplied: {} };
    }
  }

  if (!rawNodes.length) {
    return { type: 'chat_record', error: 'empty', id, messages: [], chatRecordId: genChatRecordId(), counts: { messages: 0, images: 0, videos: 0, textChars: 0 }, limitsApplied: {} };
  }

  const normalized = [];
  rawNodes.forEach((n, i) => {
    try {
      const m = normalizeNode(n, i);
      if (m) normalized.push(m);
    } catch (e) { /* 单条规范失败不影响整体 */ }
  });

  // V14-C.3 C-1：受限展开嵌套合并转发（失败不影响主流程）
  if (typeof input.getForwardMsg === 'function') {
    try {
      await expandNestedForwards(normalized, input.getForwardMsg, 1,
        { ids: new Set(id ? [id] : []), calls: 0, nodes: 0 });
    } catch (e) { /* 展开异常一律降级，保留已解析内容 */ }
  }

  const base = {
    type: 'chat_record',
    id,
    summary: input.summary != null ? String(input.summary) : '',
    source: input.source != null ? String(input.source) : '',
    prompt: input.prompt != null ? String(input.prompt) : '',
    messages: normalized,
    chatRecordId: genChatRecordId(),
  };

  const { messages, limitsApplied } = applyLimits(base, input.limits);
  base.messages = messages;
  base.limitsApplied = limitsApplied;

  // 统计（限流后的真实规模）
  let imageCount = 0, videoCount = 0, textChars = 0;
  for (const m of messages) {
    for (const c of (m.content || [])) {
      if (c.type === 'image') imageCount++;
      else if (c.type === 'video') videoCount++;
      else if (c.type === 'text') textChars += (c.text || '').length;
    }
  }
  base.counts = { messages: messages.length, images: imageCount, videos: videoCount, textChars };
  return base;
}

module.exports = { LIMITS, genChatRecordId, detectForwardSegments, applyLimits, buildChatRecord,
  NEST_MAX_DEPTH, NEST_MAX_CALLS, NEST_MAX_NODES, expandNestedForwards };
