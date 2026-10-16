'use strict';

/**
 * 生图确认——「先问一句，确认了再画」。
 *
 * 背景：生图（本机 ComfyUI/SD）一次要几十秒到几分钟，还占 GPU。
 * 用户随口一句「画只猫」就直接开画，既浪费算力，也常画出不是他想要的东西。
 * 开启后：识别到生图意图 → 先把要画的内容复述一遍请用户确认，
 * 用户回「确认/画/来吧/开始/嗯」才真的开画；回「算了/取消/不画/别画」就作废。
 *
 * 设计原则：
 *   1. 默认关闭（imageConfirm.enabled 必须为 true）。关闭时行为与原来 100% 一致。
 *   2. 纯内存，不落盘任何用户数据；带 TTL，过期自动作废。
 *   3. 只拦「生图意图」，不碰其它任何消息。
 *   4. 确认词/取消词可配置；未命中就保持等待，不猜测。
 *   5. 幂等：同一会话只保留一个待确认，新的生图意图会覆盖旧的。
 */

const DEFAULTS = {
  enabled: false,
  ttlMs: 5 * 60 * 1000,          // 待确认多久作废
  maxPromptChars: 200,           // 复述给用户的提示词长度上限
  confirmWords: ['确认', '确定', '画', '画吧', '开画', '开始画', '来吧', '来一张', '生成', '开始', '好的', '好', '嗯', '要', 'ok', 'yes', 'y', '搞', '冲'],
  cancelWords: ['取消', '算了', '不画', '别画', '不要了', '不用了', '不生成', '停', '罢了', 'no', 'n', 'cancel'],
  askTemplate: '要画的是：{prompt}\n确认就回「画」，不画就回「算了」。',
  cancelReply: '好，那就不画了～',
  expireReply: '刚才那张图等太久没确认，已经取消了～想画再说一声。',
  // 需要确认的场景（默认都要确认）
  requireForText2Img: true,
  requireForImg2Img: true,
};

let getCFG = () => ({});
function setConfig(fn) { if (typeof fn === 'function') getCFG = fn; }

function num(v, d, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, n));
}

function cfg() {
  const c = (typeof getCFG === 'function' && getCFG()) || {};
  const s = c.imageConfirm || {};
  const cw = Array.isArray(s.confirmWords) && s.confirmWords.length ? s.confirmWords.map(String) : DEFAULTS.confirmWords.slice();
  const nw = Array.isArray(s.cancelWords) && s.cancelWords.length ? s.cancelWords.map(String) : DEFAULTS.cancelWords.slice();
  return {
    enabled: s.enabled === true,
    ttlMs: num(s.ttlMs, DEFAULTS.ttlMs, 1000, 24 * 3600 * 1000),
    maxPromptChars: num(s.maxPromptChars, DEFAULTS.maxPromptChars, 20, 2000),
    confirmWords: cw,
    cancelWords: nw,
    askTemplate: typeof s.askTemplate === 'string' && s.askTemplate ? s.askTemplate : DEFAULTS.askTemplate,
    cancelReply: typeof s.cancelReply === 'string' ? s.cancelReply : DEFAULTS.cancelReply,
    expireReply: typeof s.expireReply === 'string' ? s.expireReply : DEFAULTS.expireReply,
    requireForText2Img: s.requireForText2Img !== false,
    requireForImg2Img: s.requireForImg2Img !== false,
  };
}

// —— 待确认表：chatKey -> { prompt, at, kind } ——
const pending = new Map();

/** 生成会话键：群用 g<群号>:<用户号>，私聊用 p<用户号> */
function chatKeyOf(o) {
  const isGroup = !!(o && o.isGroup);
  const gid = o && o.groupId != null ? String(o.groupId) : '';
  const uid = o && o.userId != null ? String(o.userId) : '';
  return isGroup ? ('g' + gid + ':' + uid) : ('p' + uid);
}

function sweep(now) {
  const c = cfg();
  const t = Number(now) || Date.now();
  let n = 0;
  for (const [k, v] of Array.from(pending.entries())) {
    if (t - (v.at || 0) > c.ttlMs) { pending.delete(k); n++; }
  }
  return n;
}

function peek(chatKey, now) {
  if (!chatKey) return null;
  sweep(now);
  const v = pending.get(chatKey);
  if (!v) return null;
  return Object.assign({}, v);
}

/**
 * 登记一次「待确认」。
 * @returns {{ok:boolean, askText?:string, reason?:string}}
 *   reason: 'disabled' | 'not-required'
 */
function request(chatKey, o) {
  o = o || {};
  const c = cfg();
  if (!c.enabled) return { ok: false, reason: 'disabled' };
  const kind = String(o.kind || 'text2img');
  if (kind === 'text2img' && !c.requireForText2Img) return { ok: false, reason: 'not-required' };
  if (kind === 'img2img' && !c.requireForImg2Img) return { ok: false, reason: 'not-required' };
  if (!chatKey) return { ok: false, reason: 'disabled' };

  const prompt = String(o.prompt || '').trim().slice(0, c.maxPromptChars);
  const at = Number(o.now) || Date.now();
  pending.set(chatKey, { prompt, at, kind });
  sweep(at);
  return {
    ok: true,
    askText: String(c.askTemplate).replace(/\{prompt\}/g, prompt || '(空)'),
    pending: { prompt, at, kind },
  };
}

/**
 * 判断用户这句是不是在「确认 / 取消」。
 * @returns {'confirm'|'cancel'|null}
 */
function match(chatKey, text, now) {
  if (!chatKey) return null;
  if (!peek(chatKey, now)) return null;
  const c = cfg();
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  // 取消优先：避免「算了不画了」里的「画」被误判成确认
  for (const w of c.cancelWords) {
    if (t === String(w).toLowerCase()) return 'cancel';
  }
  for (const w of c.confirmWords) {
    if (t === String(w).toLowerCase()) return 'confirm';
  }
  return null;
}

/** 取走并清除待确认（真的要画时调用） */
function take(chatKey, now) {
  if (!chatKey) return null;
  if (!peek(chatKey, now)) return null;
  const v = pending.get(chatKey);
  pending.delete(chatKey);
  return v;
}

function cancel(chatKey) {
  if (!chatKey) return false;
  return pending.delete(chatKey);
}

function _reset() { pending.clear(); }
function size() { return pending.size; }

module.exports = {
  DEFAULTS,
  setConfig, cfg,
  chatKeyOf, request, match, take, cancel, peek, sweep,
  _reset, size,
};
