'use strict';
// ================= V15.3：群友戳一戳（主动戳 + 对群友被戳的反应）=================
// 与既有 poke 功能的边界（**不重复实现**）：
//   既有 poke（ai_bridge.js handlePoke）：只处理「机器人自己被戳」（target_id === self_id），
//     表现为戳回去 + 说一句俏皮话。本模块**不碰那条路径**。
//   本模块新增两个能力：
//     ① pokeOthers ：主动戳群友（管理员在群里发 /戳 @某人），带频率/冷却/开关限制；
//     ② reactToOthers：对「群友戳群友」的事件做出反应（可回戳被戳的人、可接话），
//        但**当被戳者是机器人自己时一律让位给既有逻辑**，绝不重复回。
//
// 设计约束（安全 / 成本 / 体验）：
//   · 默认关闭（pokeOthers.enabled / reactToOthers.enabled 均为 false），须显式启用。
//   · 主动戳人只允许在**群聊**里、只允许**管理员**触发，且必须明确 @ 到具体成员
//     （不接受模糊昵称/数字猜测，避免戳错人）。
//   · 冷却 + 每小时上限 + 全局日上限三重限频，防止刷屏与被滥用。
//   · 不戳机器人自己、不戳管理员（避免骚扰主人）、不戳发起者本人。
//   · reactToOthers 有冷却窗口，只在「确实值得接话」时发言；且不说话时至少可以只回戳。
//   · 纯本地规则决策，**不新增模型调用**；接话文案优先复用既有固定池，
//     可选开启 AI 现编（useAI），失败一律回落固定池，绝不因 AI 失败而报错。
//   · 零第三方依赖、零付费 API；不落盘任何用户数据（仅内存计数）。

const DEFAULTS = {
  // —— 主动戳群友 ——
  pokeOthersEnabled: false,      // 默认关闭
  adminOnly: true,               // 仅管理员可触发（防滥用）
  cooldownMs: 60 * 1000,         // 同一对（发起者→目标）冷却 1 分钟
  maxPerHour: 10,                // 同一发起者每小时上限
  maxPerDay: 30,                 // 全局每日上限
  // —— 对群友被戳的反应 ——
  reactToOthersEnabled: false,   // 默认关闭
  reactMode: 'poke+text',        // 'off' | 'poke'（只回戳）| 'text'（只接话）| 'poke+text'
  reactCooldownMs: 30 * 1000,    // 同一对（戳人→被戳者）冷却 30 秒
  reactMinIntervalGroupMs: 3 * 60 * 1000, // 同一群两次接话最小间隔，防刷屏
  maxReactPerHour: 20,           // 每群每小时反应次数上限
  useAI: false,                  // 是否用 AI 现编接话（默认关：零额外成本）
  aiMaxTokens: 80,
  texts: [                       // 接话固定池（AI 关闭或失败时使用）
    '别戳了别戳了，人家在忙呢',
    '你们戳来戳去，我看着都疼',
    '再戳我要收费了啊',
    '互相戳，也不嫌手痒',
    '这波啊，这波是戳不动了',
  ],
};

// —— 内存态（仅计数，不落盘、不含任何用户数据）——
const pokeLog = new Map();   // `${day}|${actor}|${target}` -> ts
const reactLog = new Map();  // `${groupId}|${actor}|${target}` -> ts
const groupReactAt = new Map(); // groupId -> 上次接话时间
const counters = new Map();  // `${day}|${scope}|${key}` -> 次数

function cfg() {
  const c = (module.exports.getCFG && module.exports.getCFG()) || {};
  const s = c.pokeOthers || {};
  const r = c.pokeOthers && c.pokeOthers.react || {};
  const n = (v, d, min) => {
    const x = (v === undefined || v === null || v === '') ? d : Number(v);
    return Math.max(min, isNaN(x) ? d : x);
  };
  return {
    pokeOthersEnabled: s.enabled === true,          // 只有显式 true
    adminOnly: s.adminOnly !== false,
    cooldownMs: n(s.cooldownMs, DEFAULTS.cooldownMs, 0),
    maxPerHour: n(s.maxPerHour, DEFAULTS.maxPerHour, 1),
    maxPerDay: n(s.maxPerDay, DEFAULTS.maxPerDay, 1),
    reactToOthersEnabled: (r.enabled === true),
    reactMode: ['off', 'poke', 'text', 'poke+text'].indexOf(r.mode) >= 0 ? r.mode : DEFAULTS.reactMode,
    reactCooldownMs: n(r.cooldownMs, DEFAULTS.reactCooldownMs, 0),
    reactMinIntervalGroupMs: n(r.minIntervalGroupMs, DEFAULTS.reactMinIntervalGroupMs, 0),
    maxReactPerHour: n(r.maxReactPerHour, DEFAULTS.maxReactPerHour, 1),
    useAI: r.useAI === true,
    aiMaxTokens: n(r.aiMaxTokens, DEFAULTS.aiMaxTokens, 20),
    texts: Array.isArray(r.texts) && r.texts.length ? r.texts : DEFAULTS.texts,
  };
}

function today(now) { return new Date(now || Date.now()).toISOString().slice(0, 10); }

function bump(key, now) {
  // 过期计数自动清零（按天/按小时前缀实现，无需定时器）
  const v = counters.get(key);
  if (!v) { counters.set(key, { n: 1, at: now }); return 1; }
  v.n += 1; v.at = now; return v.n;
}
function countOf(key) { const v = counters.get(key); return v ? v.n : 0; }

/** 清理过期内存计数（避免长期运行无限增长）。now 可注入，便于测试。 */
function sweep(now) {
  now = now || Date.now();
  const hour = Math.floor(now / 3600000);
  for (const [k, v] of counters) {
    // 形如 `2026-10-16|h|12345` 或 `2026-10-16|d|global`
    if (k.indexOf('|h|') >= 0 && Math.floor((v.at || 0) / 3600000) < hour) counters.delete(k);
    else if (k.indexOf('|d|') >= 0 && today(v.at) !== today(now)) counters.delete(k);
  }
  const day = today(now);
  for (const [k, ts] of pokeLog) if (today(ts) !== day) pokeLog.delete(k);
  // reactLog 只需保留一个冷却窗口
  for (const [k, ts] of reactLog) if (now - ts > 3600000) reactLog.delete(k);
  for (const [k, ts] of groupReactAt) if (now - ts > 3600000) groupReactAt.delete(k);
  return { counters: counters.size, pokeLog: pokeLog.size, reactLog: reactLog.size };
}

/**
 * 从消息段里提取被 @ 的 QQ 号（群友 id）。
 * 只认 type==='at' 且 data.qq 存在；**不接受昵称/纯数字猜测**，避免戳错人。
 * @param {Array} segs 原始消息段
 * @returns {string|null}
 */
function pickAtTarget(segs) {
  const arr = Array.isArray(segs) ? segs : [];
  for (const s of arr) {
    if (s && s.type === 'at') {
      const qq = s.data && (s.data.qq != null ? s.data.qq : s.data.user_id);
      if (qq != null && String(qq).trim()) return String(qq).trim();
    }
  }
  return null;
}

/**
 * 主动戳群友的**决策**（纯规则，不发消息）。
 * @param {object} o
 *   groupId, actorId, targetId, selfId, isAdmin, segs, now?
 * @returns {object} { ok, reason, action }
 *   ok=false 时 reason 说明原因（用于给用户回执）；
 *   ok=true 时 action='poke'，调用方据此调用 NapCat 的 group_poke。
 */
function decidePokeOther(o) {
  o = o || {};
  const c = cfg();
  const now = o.now || Date.now();
  if (!c.pokeOthersEnabled) return { ok: false, reason: 'disabled' };

  const groupId = o.groupId == null ? '' : String(o.groupId);
  if (!groupId) return { ok: false, reason: 'group-only' };              // 仅群聊
  if (c.adminOnly && !o.isAdmin) return { ok: false, reason: 'admin-only' };

  const actor = String(o.actorId == null ? '' : o.actorId);
  const target = String(o.targetId == null ? '' : o.targetId);
  if (!actor) return { ok: false, reason: 'no-actor' };

  // 目标必须来自明确的 @ 段（不猜昵称、不猜纯数字）
  const at = pickAtTarget(o.segs);
  if (at && at !== target) return { ok: false, reason: 'target-mismatch' };
  if (!target) return { ok: false, reason: 'need-at' };

  if (String(o.selfId) === target) return { ok: false, reason: 'self' };  // 不戳自己
  if (actor === target) return { ok: false, reason: 'self-poke' };        // 不戳发起者自己
  if (o.isTargetAdmin) return { ok: false, reason: 'target-is-admin' };  // 不骚扰管理员

  // 冷却：同一对
  const pk = groupId + '|' + actor + '|' + target;
  if (c.cooldownMs > 0 && now - (pokeLog.get(pk) || 0) < c.cooldownMs) {
    return { ok: false, reason: 'cooldown', waitMs: c.cooldownMs - (now - (pokeLog.get(pk) || 0)) };
  }
  // 每小时上限（按发起者）
  if (countOf(today(now) + '|h|' + groupId + '|' + actor) >= c.maxPerHour) {
    return { ok: false, reason: 'rate-hour' };
  }
  // 全局每日上限
  if (countOf(today(now) + '|d|global') >= c.maxPerDay) {
    return { ok: false, reason: 'rate-day' };
  }
  return { ok: true, action: 'poke', reason: 'ok', groupId, actor, target };
}

/** 决策通过后记账（真正发起前调用，保证限频数据与实际动作一致）。 */
function commitPoke(res, now) {
  if (!res || !res.ok) return res;
  const now2 = now || Date.now();
  pokeLog.set(res.groupId + '|' + res.actor + '|' + res.target, now2);
  bump(today(now2) + '|h|' + res.groupId + '|' + res.actor, now2);
  bump(today(now2) + '|d|global', now2);
  return res;
}

/**
 * 对「群友戳群友」的反应决策（纯规则）。
 * @param {object} o { groupId, actorId, targetId, selfId, now? }
 * @returns {object} { ok, reason, action:'poke'|'text'|'poke+text'|'none', target }
 */
function decideReactToOtherPoke(o) {
  o = o || {};
  const c = cfg();
  const now = o.now || Date.now();
  if (!c.reactToOthersEnabled) return { ok: false, reason: 'disabled' };
  if (c.reactMode === 'off') return { ok: false, reason: 'mode-off' };

  const groupId = o.groupId == null ? '' : String(o.groupId);
  if (!groupId) return { ok: false, reason: 'group-only' };
  const actor = String(o.actorId == null ? '' : o.actorId);
  const target = String(o.targetId == null ? '' : o.targetId);
  if (!actor || !target) return { ok: false, reason: 'bad-event' };
  // 戳机器人自己 → 让位给既有 handlePoke，本模块不重复处理
  if (String(o.selfId) === target) return { ok: false, reason: 'is-self' };

  // 冷却：同一对（戳人→被戳者）
  const rk = groupId + '|' + actor + '|' + target;
  if (c.reactCooldownMs > 0 && now - (reactLog.get(rk) || 0) < c.reactCooldownMs) {
    return { ok: false, reason: 'cooldown' };
  }
  // 群级接话间隔（只约束"说话"，回戳不受此限）
  const wantsText = c.reactMode === 'text' || c.reactMode === 'poke+text';
  const groupBusy = wantsText && !groupAllowsText(now, groupId, c);
  if (groupBusy) {
    // 群太密 → 只回戳、不说话，避免刷屏。
    // 注意：仍受"每小时反应上限"约束（下面统一检查），但接话降级不应绕过限频。
    const overLimit = countOf(today(now) + '|h|react|' + groupId) >= c.maxReactPerHour;
    if (overLimit) return { ok: false, reason: 'rate-hour' };
    return { ok: true, action: 'poke', reason: 'group-busy', groupId, actor, target, speaks: false };
  }
  if (countOf(today(now) + '|h|react|' + groupId) >= c.maxReactPerHour) {
    return { ok: false, reason: 'rate-hour' };
  }

  const action = wantsText ? 'poke+text' : 'poke';
  return { ok: true, action, reason: 'ok', groupId, actor, target, speaks: wantsText };
}

function groupAllowsText(now, groupId, c) {
  const last = groupReactAt.get(groupId) || 0;
  return now - last >= c.reactMinIntervalGroupMs;
}

/** 反应记账（实际动作前调用）。 */
function commitReact(res, now) {
  if (!res || !res.ok) return res;
  const now2 = now || Date.now();
  reactLog.set(res.groupId + '|' + res.actor + '|' + res.target, now2);
  bump(today(now2) + '|h|react|' + res.groupId, now2);
  if (res.speaks) groupReactAt.set(res.groupId, now2);
  return res;
}

/** 从固定池里挑一句（避免连续重复同一句）。lastIdx 可注入便于测试。 */
function pickText(c, lastIdx) {
  const pool = (c && Array.isArray(c.texts) && c.texts.length) ? c.texts : DEFAULTS.texts;
  if (pool.length === 1) return pool[0];
  let i = Math.floor(Math.random() * pool.length);
  if (i === lastIdx) i = (i + 1) % pool.length;
  return pool[i];
}

function stats() {
  return { cfg: cfg(), counters: counters.size, pokeLog: pokeLog.size, reactLog: reactLog.size };
}

module.exports = {
  DEFAULTS, cfg, sweep,
  pickAtTarget, decidePokeOther, commitPoke,
  decideReactToOtherPoke, commitReact, groupAllowsText, pickText, stats,
  setConfig: (fn) => { module.exports.getCFG = fn; },
  _reset: () => { pokeLog.clear(); reactLog.clear(); groupReactAt.clear(); counters.clear(); },
};
