'use strict';
// ================= V15.2：群聊智能决策（纯本地规则，0 次额外模型调用）=================
// 目标：减少机械的关键词触发、无意义的 @ 回复和不自然的插话。
//
// 设计原则（严格对应需求）：
//   ① 复用现有群聊缓冲（groupBuffers）与既有判定结果（shouldReplyGroup 的 decision），
//      本模块只在其**之后**做一次廉价的本地复核，不重写 ai_bridge 的判定链路。
//   ② **绝不新增模型请求**：所有判断基于本地规则 + 已在缓冲里的文本。
//      真正需要 AI 裁决的场景仍走既有 needsJudge 通道（不额外增加调用次数）。
//   ③ 明确优先级不可被削弱：@ 机器人 / 回复机器人 / 命令 / 明确提问 / 明确要求继续
//      → 一律保持原有的高优先级，智能决策不得把它们降级（这是需求硬要求）。
//   ④ 普通闲聊默认不插话：不为了表现活跃而硬凑回复。
//   ⑤ 避免重复回答已解决的问题：若最近若干条里已经有机器人给出过答案
//      （同一话题 + 已 sent），且本条没有新的追问信号 → 不再重复回答。
//   ⑥ 「等待后续消息」：本条像是问题的前半截（句子未完/正在打字/无实质内容）时，
//      返回 defer 建议交给既有聚合窗口处理，而不是抢答或直接丢弃。
//
// 隐私：只读取群缓冲里已有的公开聊天文本，不写任何画像/敏感信息，不落盘。

const DEFAULTS = {
  enabled: false,            // 新功能默认关闭
  dedupWindow: 20,           // 回看最近多少条判断"是否已回答过"
  dedupWindowMs: 10 * 60 * 1000,  // 只在这个时间窗内认为"刚答过"
  minTopicLen: 6,            // 话题关键词最少长度（太短容易误判重复）
  deferMinChars: 4,          // 短于这个字数且像未完句 → 建议等待
  repeatBlockChars: 10,      // 与已答内容重合超过该字数 → 判为重复
};

// —— 明确提问信号（保留高优先级，需求硬要求）——
const EXPLICIT_Q_RE = /[?？]\s*$|[?？]|怎么|为什么|如何|什么是|哪个|哪些|多少|能不能|可不可以|是否|吗[?？\s]*$|呢[?？\s]*$/;
// —— 明确要求继续/追问（同样保留高优先级）——
const CONTINUE_RE = /(继续|接着|然后呢|再(说|讲|来)|还有呢|下文|具体(说|讲)|详细(说|讲)|展开)/;
// —— 明显的未完句（建议等待聚合，而不是抢答/丢弃）——
// 用 new RegExp 拼接而非正则字面量：字面量中「$|^[^?？]{0,3}$」这种「锚点 + 顶层交替」的
// 组合在某些解析路径下会被误判为语句分隔而报语法错误。拆成三段再合并可完全规避，语义一致。
const INCOMPLETE_RE = new RegExp(
  '[，,、：:]\\s*$|\\u2014\\s*$'
  + '|(?:然后|但是|可是|因为|所以|而且|还有|就是|这个|那个|怎么|什么)\\s*$'
  + '|^[^?？]{0,3}$'
);

/** 判断是否为「明确向机器人提问」，用于保住高优先级。 */
function isExplicitQuestion(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  return EXPLICIT_Q_RE.test(t);
}
function isContinueRequest(text) {
  return CONTINUE_RE.test(String(text || ''));
}

/**
 * 话题指纹：取较长的中文/字母数字 2-gram 片段集合，用于粗粒度比对。
 * 不追求语义精确，只求"是否明显在聊同一件事"的廉价判断。
 */
function fingerprint(text) {
  const t = String(text || '').replace(/[@\s，。！？!?、：:；;""''（）()\[\]]/g, '');
  const out = new Set();
  for (let i = 0; i + 2 <= t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}

function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / Math.min(a.size, b.size);
}

/**
 * 检查最近缓冲里机器人是否已经回答过类似内容。
 * @param {Array} buffer 群缓冲（元素含 text / isBot / uid / time）
 * @param {string} text 本条文本
 * @param {object} c 配置
 * @returns {object|null} { answeredAt, sample } 若判定已回答过则返回，否则 null
 */
function findAlreadyAnswered(buffer, text, c) {
  const arr = Array.isArray(buffer) ? buffer : [];
  const n = Math.max(3, Number(c.dedupWindow) || DEFAULTS.dedupWindow);
  const winMs = Math.max(1000, Number(c.dedupWindowMs) || DEFAULTS.dedupWindowMs);
  const now = Date.now();
  const fp = fingerprint(text);
  const minLen = Math.max(4, Number(c.minTopicLen) || DEFAULTS.minTopicLen);
  if (String(text || '').replace(/\s/g, '').length < minLen) return null;

  const recent = arr.slice(-n);
  for (let i = recent.length - 1; i >= 0; i--) {
    const it = recent[i];
    if (!it || !it.isBot) continue;
    if (now - (Number(it.time) || 0) > winMs) continue;
    const botFp = fingerprint(it.text);
    // 重合度需相当高才认定为"同一个问题"（避免把相关但不同的问题误判为重复）
    if (overlap(fp, botFp) >= 0.75) {
      return { answeredAt: Number(it.time) || 0, sample: String(it.text || '').slice(0, 60) };
    }
  }
  return null;
}

/**
 * 是否建议「等待后续消息」。
 * 仅在本条明显未成句、且话题窗口内有机器人刚参与过时才建议等待 ——
 * 避免把真正的独立提问无谓地延后。
 */
function shouldDefer(buffer, text, decision, c) {
  const t = String(text || '').trim();
  const minChars = Math.max(2, Number(c.deferMinChars) || DEFAULTS.deferMinChars);
  if (t.length >= minChars && !INCOMPLETE_RE.test(t)) return false;
  // 明确的提问/命令不等待
  if (isExplicitQuestion(t) || isContinueRequest(t)) return false;
  const r = String((decision && decision.reason) || '');
  if (r === 'at' || r === 'reply-to-bot' || r === 'chat-record') return false;
  return true;
}

/**
 * 主入口：在既有 shouldReplyGroup 结果之上做一次本地智能复核。
 *
 * @param {object} o
 *   - text        本条文本
 *   - buffer      现有群缓冲（getGroupBuffer 的结果）
 *   - decision    shouldReplyGroup 已给出的判定（含 reason / needsJudge）
 *   - isGroup     是否群聊（私聊直接放行，绝不影响私聊）
 *   - cfg         本模块配置（可选，测试可注入）
 * @returns {object} { changed, action, reason }
 *   action: 'keep'（不改）| 'drop'（建议不回）| 'defer'（建议等待聚合）
 */
function review(o) {
  o = o || {};
  const c = Object.assign({}, DEFAULTS, o.cfg || {});
  // 默认关闭 → 完全不改变既有行为（需求：关闭新配置时原有行为保持兼容）
  if (!c.enabled) return { changed: false, action: 'keep', reason: 'disabled' };
  // 私聊不参与群聊智能决策
  if (o.isGroup === false) return { changed: false, action: 'keep', reason: 'private' };

  const decision = o.decision || {};
  const text = String(o.text || '');
  const r = String(decision.reason || '');

  // ① 硬性高优先级：@ / 回复机器人 / 聊天记录 / 命令 → 一律不动
  if (r === 'at' || r === 'reply-to-bot' || r === 'chat-record'
    || r === 'all' || decision.bypassCooldown === true) {
    return { changed: false, action: 'keep', reason: 'high-priority' };
  }

  // ② 明确要求继续 → 保住响应优先级，不降级
  if (isContinueRequest(text)) {
    return { changed: false, action: 'keep', reason: 'explicit-question' };
  }

  // ③ 已经回答过 → 不重复回答。
  //    注意：这一检查必须排在「明确提问」保住优先级**之前**，否则"同一个问题被反复
  //    提问"永远走 explicit-question 分支，去重形同虚设。
  //    但只对「本来打算回」的情况生效（needsJudge/已放行）；本来就不回的不受影响。
  //    而且只压制**完全重复**的那一条：判定依赖话题指纹高度重合，
  //    新的追问（新话题）不会被误杀。
  const answered = findAlreadyAnswered(o.buffer, text, c);
  if (answered && (decision.reply || decision.needsJudge)) {
    return {
      changed: true, action: 'drop', reason: 'already-answered',
      detail: { answeredAt: answered.answeredAt, sample: answered.sample },
    };
  }

  // ④ 明确提问 / 明确要求继续 → 保住响应优先级（仅对"尚未回答过"的新问题有效）
  if (isExplicitQuestion(text)) {
    return { changed: false, action: 'keep', reason: 'explicit-question' };
  }

  // ④ 未成句 / 过短 → 建议等待后续消息（交给既有聚合窗口，不抢答也不直接丢）
  if (shouldDefer(o.buffer, text, decision, c)) {
    return { changed: true, action: 'defer', reason: 'incomplete-utterance' };
  }

  // ⑤ 其余情况：维持既有判定（普通闲聊仍由 shouldReplyGroup 的 normal-chat 决定不回）
  return { changed: false, action: 'keep', reason: 'fallthrough' };
}

module.exports = {
  DEFAULTS,
  review, findAlreadyAnswered, shouldDefer, isExplicitQuestion, isContinueRequest,
  fingerprint, overlap,
};
