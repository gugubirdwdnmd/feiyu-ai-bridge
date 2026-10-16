'use strict';
// ================= 可管理的长期记忆（带元数据 / 权限隔离 / 容量治理）=================
// 复用现有的 memory/notes.json，但**原地升级格式**并兼容旧数据：
//   旧：{ "group_123456789": ["内容1", "内容2"], "private_10001": [...] }
//   新：{ version:2, items:[ {id, scope, groupId, userId, content, source,
//                            createdAt, updatedAt, expireAt, confidence, hits, lastHitAt} ] }
// 读到的旧格式会自动迁移（group_* → 群级公共记忆；private_* → 该用户的私有记忆），
// 不会丢历史条目，也不需要维护两份存储。
//
// 满足需求的要点：
//   · 元数据：来源 / 创建时间 / 更新时间 / 置信度（不确定的不会被当成事实）
//   · 过期：expireAt 到期自动清理
//   · 去重合并：新条目与旧条目高度相似时合并（累加 hits，刷新 updatedAt），不无限膨胀
//   · 容量：条数与文件体积双上限，超了按「低置信度 → 久未命中 → 最旧」淘汰
//   · 检索：retrieve() 只返回与当前问题相关的少量条目（限制条数与总字数）
//   · 权限：数据访问一律带 scope/groupId/userId 过滤；普通成员只能碰自己的记忆
//   · 安全：显式拒绝保存密码 / API Key / token 等凭据类内容

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// —— 与旧记忆系统（notes.json + saveMemory）**刻意分离** ——
// 原因：旧系统每次 saveMemory() 都会用 Object.fromEntries(notes) 整体覆写 notes.json。
// 若新模块也写这个文件，两套结构会互相覆盖（谁后写谁赢），必然丢数据。
// 因此：新模块用自己的 notes_v2.json；老 notes.json 保持原样、继续由旧系统使用，
// 首次启动时把老数据**一次性只读导入**为初始条目，让 /记忆 能看到历史。
const DEFAULT_FILE = path.join(__dirname, 'notes_v2.json');
const DEFAULT_LEGACY = path.join(__dirname, 'notes.json');
let FILE = DEFAULT_FILE;      // 测试可用 _setFile 重定向到临时文件
let LEGACY = DEFAULT_LEGACY;  // 旧的 notes.json（只读导入源）；测试可设为 null，避免污染真实记忆

const DEFAULTS = {
  maxItems: 500,            // 总条数上限
  maxBytes: 1024 * 1024,    // 文件体积上限（1MB）
  defaultTtlDays: 180,      // 默认保留天数
  maxTtlDays: 365,          // 最长保留天数
  retrieveLimit: 6,         // 注入提示词的记忆条数上限
  retrieveChars: 900,       // 注入提示词的记忆总字数上限
  minLen: 2,
  maxLen: 200,              // 单条内容最长
};

let cache = null;
let dirty = false;
let flushTimer = null;

// ———— 明显凭据类内容一律拒收（需求：不保存密码/密钥/账号凭据）————
const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/,          // OpenAI/DeepSeek 等 key
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,               // GitHub token
  /\bAKIA[0-9A-Z]{12,}/,                        // AWS
  /\bAIza[0-9A-Za-z_-]{20,}/,                   // Google
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,             // Slack
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /(?:密码|口令|passwd|password|secret|token|私钥|密钥)\s*[:：=]\s*\S{4,}/i,
  /\b1[3-9]\d{9}\b/,                            // 手机号
  /\b\d{17}[\dXx]\b/,                           // 身份证
];

function looksSecret(text) {
  const t = String(text || '');
  return SECRET_PATTERNS.some((re) => re.test(t));
}

function cfg() {
  const c = (module.exports.getCFG && module.exports.getCFG()) || {};
  const s = c.memoryStore || {};
  return {
    maxItems: Math.max(20, Number(s.maxItems) || DEFAULTS.maxItems),
    maxBytes: Math.max(64 * 1024, Number(s.maxBytes) || DEFAULTS.maxBytes),
    defaultTtlDays: Math.max(1, Number(s.defaultTtlDays) || DEFAULTS.defaultTtlDays),
    maxTtlDays: Math.max(1, Number(s.maxTtlDays) || DEFAULTS.maxTtlDays),
    retrieveLimit: Math.max(1, Number(s.retrieveLimit) || DEFAULTS.retrieveLimit),
    retrieveChars: Math.max(100, Number(s.retrieveChars) || DEFAULTS.retrieveChars),
    minLen: Math.max(1, Number(s.minLen) || DEFAULTS.minLen),
    maxLen: Math.max(20, Number(s.maxLen) || DEFAULTS.maxLen),
  };
}

// ———— 读盘；不存在时从旧 notes.json 一次性导入 ————
function load() {
  if (cache) return cache;
  let obj = null;
  let existed = true;
  try { obj = JSON.parse(fs.readFileSync(FILE, 'utf-8')); }
  catch (e) { obj = null; existed = false; }

  if (obj && obj.version === 2 && Array.isArray(obj.items)) {
    cache = obj;
  } else {
    cache = { version: 2, items: [], importedFrom: null, importedAt: Date.now() };
    // 从旧文件导入（只读，绝不修改旧文件）
    if (!existed && LEGACY) {
      try {
        const old = JSON.parse(fs.readFileSync(LEGACY, 'utf-8'));
        if (old && typeof old === 'object' && !Array.isArray(old)) {
          for (const sessionId of Object.keys(old)) {
            const arr = old[sessionId];
            if (!Array.isArray(arr)) continue;
            const gm = /^group_(\d+)$/.exec(sessionId);
            const pm = /^private_(\d+)$/.exec(sessionId);
            for (const content of arr) {
              const text = String(content == null ? '' : content).trim();
              if (!text) continue;
              cache.items.push(newItem({
                scope: gm ? 'group' : 'user',
                groupId: gm ? gm[1] : null,
                userId: pm ? pm[1] : null,
                content: text,
                source: 'legacy-import',
                confidence: 0.6,
                ttlDays: null,               // 旧记忆不设过期
              }));
            }
          }
          cache.importedFrom = 'notes.json';
        }
      } catch (e) { /* 导入失败不影响启动 */ }
    }
    markDirty();
  }
  cache.items = cache.items.filter((x) => x && typeof x === 'object' && x.content);
  return cache;
}

function newItem(o) {
  const c = cfg();
  const now = Date.now();
  const days = Number(o.ttlDays) > 0
    ? Math.min(c.maxTtlDays, Number(o.ttlDays))
    : c.defaultTtlDays;
  return {
    id: 'm_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex'),
    scope: o.scope === 'group' ? 'group' : 'user',
    groupId: o.groupId ? String(o.groupId) : null,
    userId: o.userId ? String(o.userId) : null,
    content: String(o.content || '').slice(0, c.maxLen),
    source: String(o.source || 'manual'),
    createdAt: now,
    updatedAt: now,
    expireAt: o.ttlDays === null ? null : now + days * 86400000,
    confidence: Math.max(0, Math.min(1, Number(o.confidence) > 0 ? Number(o.confidence) : 0.6)),
    hits: 0,
    lastHitAt: 0,
  };
}

function markDirty() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 300);
  if (flushTimer.unref) flushTimer.unref();
}

function flush() {
  if (!cache || !dirty) return true;
  prune();
  try {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache), 'utf-8');
    fs.renameSync(tmp, FILE);
    dirty = false;
    return true;
  } catch (e) {
    return false;
  }
}

// ———— 过期清理 + 容量淘汰 ————
function prune() {
  const c = cfg();
  const all = load();
  const now = Date.now();
  const before = all.items.length;
  all.items = all.items.filter((x) => !x.expireAt || Number(x.expireAt) > now);
  if (all.items.length !== before) markDirty();

  if (all.items.length > c.maxItems) {
    // 淘汰顺序：置信度低 → 命中少 → 久未命中 → 最旧
    all.items.sort((a, b) => {
      if (a.confidence !== b.confidence) return a.confidence - b.confidence;
      if (a.hits !== b.hits) return a.hits - b.hits;
      if ((a.lastHitAt || 0) !== (b.lastHitAt || 0)) return (a.lastHitAt || 0) - (b.lastHitAt || 0);
      return (a.updatedAt || 0) - (b.updatedAt || 0);
    });
    all.items = all.items.slice(-c.maxItems);
    markDirty();
  }
  // 体积兜底
  try {
    while (JSON.stringify(all).length > c.maxBytes && all.items.length > 20) {
      all.items.sort((a, b) => (a.confidence - b.confidence) || ((a.lastHitAt || 0) - (b.lastHitAt || 0)));
      all.items.shift();
      markDirty();
    }
  } catch (e) { /* 体积估算失败就算了 */ }
  return all.items;
}

function isExpired(item) {
  return !!(item && item.expireAt && Number(item.expireAt) <= Date.now());
}

// 可见性过滤：**这是权限隔离的唯一入口**
//   普通成员  → 只能看自己的 user 记忆 + 所在群的 group 记忆（只读）
//   管理员    → 可传 allowAll 跨群查看
function visible(item, f) {
  if (!item || isExpired(item)) return false;
  if (!f) return false;
  const gid = f.groupId == null ? null : String(f.groupId);
  const uid = f.userId == null ? null : String(f.userId);
  if (item.scope === 'group') {
    if (f.allowAll) return true;
    return gid != null && String(item.groupId) === gid;   // 只看本群
  }
  // user 级记忆：本人可见；管理员在 allowAll 时可见
  if (f.allowAll) return true;
  return uid != null && String(item.userId) === uid;
}

// 可管理（改/删）：普通成员只能管理自己的 user 记忆；群级记忆仅管理员
function canMutate(item, actor) {
  if (!item || !actor) return false;
  if (actor.isAdmin) return true;
  if (item.scope === 'group') return false;               // 群级公共记忆不开放给普通成员
  return String(item.userId) === String(actor.userId);
}

// ———— 相似度（用于去重合并）————
function bigrams(s) {
  const t = String(s || '').replace(/[\s\p{P}]/gu, '');
  const out = new Set();
  for (let i = 0; i + 2 <= t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}
function similarity(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / Math.min(A.size, B.size);
}

// ———— 新增 / 合并 ————
function add(o) {
  const c = cfg();
  const text = String(o.content || '').replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, error: 'empty' };
  if (text.length < c.minLen) return { ok: false, error: 'too-short' };
  if (looksSecret(text)) return { ok: false, error: 'looks-like-secret' };

  const all = load();
  prune();
  // 同 scope 下高度相似 → 合并（不重复膨胀）
  const filter = { groupId: o.groupId, userId: o.userId, allowAll: false };
  for (const it of all.items) {
    if (!visible(it, filter)) continue;
    if (it.scope !== (o.scope === 'group' ? 'group' : 'user')) continue;
    if (o.scope !== 'group' && String(it.userId) !== String(o.userId)) continue;
    if (similarity(text, it.content) >= 0.8) {
      it.hits = (it.hits || 0) + 1;
      it.updatedAt = Date.now();
      it.confidence = Math.min(1, (Number(it.confidence) || 0.6) + 0.05);
      markDirty();
      return { ok: true, merged: true, item: clone(it) };
    }
  }
  const item = newItem(o);
  all.items.push(item);
  markDirty();
  prune();
  return { ok: true, merged: false, item: clone(item) };
}

function clone(x) { return JSON.parse(JSON.stringify(x)); }

// ———— V15.2：按 id 直接写入/覆盖一条条目，**不做相似合并**（与 add 明确区分）————
// 为什么需要：add() 的相似合并只按 scope + userId 过滤，**不比对 groupId**
//   （普通个人记忆的设计是「同一人跨群可见」，属既有行为，不应改动）。
//   群友画像的隔离键是「群号+QQ号」，若用 add()，不同群里内容相似的画像会互相覆盖
//   （实测「希望被称呼为「阿甲」」与「希望被称呼为「阿丙」」相似度 0.857 ≥ 0.8）。
//   因此画像自行判断"合并 or 新增"，需要一种"按 id 精确写入、不触发相似合并"的能力。
// 本函数只操作本模块的 cache（与 add/list/remove 同一份数据），不新建独立存储，
// 也不会绕过容量治理：写入后照常 markDirty + prune。
function upsertRaw(item) {
  if (!item || !item.id) return { ok: false, error: 'item-need-id' };
  const text = String(item.content == null ? '' : item.content);
  if (!text) return { ok: false, error: 'empty' };
  // 复用既有的凭据拒收规则，保持与 add() 一致的安全边界
  if (looksSecret(text)) return { ok: false, error: 'looks-like-secret' };
  const all = load();
  const it = clone(item);
  if (!it.createdAt) it.createdAt = Date.now();
  if (!it.updatedAt) it.updatedAt = Date.now();
  if (it.storedAt == null) it.storedAt = Date.now();
  if (it.hits == null) it.hits = 0;
  // ⚠ 必须「按 id 覆盖」而不是无脑 push。
  //   初版这里写成了 all.items.push(it)，导致同一条画像每次更新（hits++/更正）
  //   都会被追加成一份副本 —— 画像越用越多、磁盘越涨，且出现互相矛盾的多份。
  //   upsert 的语义就是「存在则替换」，这里按 id 精确定位后再决定替换或追加。
  const idx = all.items.findIndex((x) => x && x.id === it.id);
  if (idx >= 0) all.items[idx] = it; else all.items.push(it);
  markDirty();
  prune();
  return { ok: true, item: clone(it) };
}

// ———— 查询 / 搜索 / 检索 ————
function list(filter, limit) {
  const all = load();
  const out = all.items.filter((x) => visible(x, filter));
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return limit ? out.slice(0, limit) : out;
}

// 关键词搜索（同一套可见性过滤，天然防越权）
function search(kw, filter, limit) {
  const q = String(kw || '').trim().toLowerCase();
  const all = list(filter);
  if (!q) return all.slice(0, limit || 10);
  const hit = all.filter((x) => String(x.content).toLowerCase().includes(q));
  return hit.slice(0, limit || 10);
}

// 与「当前问题」相关的少量记忆：按 2-gram 重合度打分，只取 topN 且受总字数限制
function retrieve(query, filter, limitOverride) {
  const c = cfg();
  const limit = Math.max(1, Number(limitOverride) || c.retrieveLimit);
  const q = String(query || '').replace(/\s+/g, '');
  if (q.length < 2) return [];
  const qg = bigrams(q);
  const cands = list(filter, 200);
  const scored = cands.map((it) => {
    const ig = bigrams(it.content);
    let inter = 0;
    for (const g of qg) if (ig.has(g)) inter++;
    const overlap = qg.size ? inter / qg.size : 0;
    const score = overlap * 0.7 + (it.confidence || 0) * 0.2 + Math.min(0.1, (it.hits || 0) * 0.02);
    return { it, score };
  }).filter((x) => x.score >= 0.12);
  scored.sort((a, b) => b.score - a.score);

  const out = [];
  let chars = 0;
  for (const s of scored) {
    if (out.length >= limit) break;
    const t = s.it.content;
    if (chars + t.length > c.retrieveChars) continue;
    out.push({ id: s.it.id, content: t, score: Number(s.score.toFixed(2)), confidence: s.it.confidence, scope: s.it.scope, source: s.it.source });
    chars += t.length;
    s.it.hits = (s.it.hits || 0) + 1;
    s.it.lastHitAt = Date.now();
  }
  if (out.length) markDirty();
  return out;
}

// ———— 删除 / 清空 ————
function remove(id, actor) {
  const all = load();
  const i = all.items.findIndex((x) => x.id === id);
  if (i < 0) return { ok: false, error: 'not-found' };
  if (!canMutate(all.items[i], actor)) return { ok: false, error: 'forbidden' };
  all.items.splice(i, 1);
  markDirty();
  return { ok: true, removed: 1 };
}

// 按关键词删（只能删自己有权管的）
function removeByKeyword(kw, actor) {
  const q = String(kw || '').trim().toLowerCase();
  if (!q) return { ok: false, error: 'empty' };
  const all = load();
  const gone = [];
  for (let i = all.items.length - 1; i >= 0; i--) {
    const it = all.items[i];
    if (!String(it.content).toLowerCase().includes(q)) continue;
    if (!canMutate(it, actor)) continue;
    all.items.splice(i, 1);
    gone.push(it.id);
  }
  markDirty();
  return { ok: true, removed: gone.length, ids: gone };
}

// 按作用域清空。filter 为 null 表示「当前用户有权管理的全部」。
// 注意：filter.groupId / filter.userId 为空时表示**不限该项** ——
// 私聊场景下 groupId 本就是 null，若严格比较会导致「清空个人记忆」一条都删不掉。
function clear(actor, filter) {
  const all = load();
  const gone = [];
  for (let i = all.items.length - 1; i >= 0; i--) {
    const it = all.items[i];
    if (filter) {
      if (it.scope !== filter.scope) continue;
      if (filter.groupId && String(it.groupId) !== String(filter.groupId)) continue;
      if (filter.userId && String(it.userId) !== String(filter.userId)) continue;
    }
    if (!canMutate(it, actor)) continue;
    all.items.splice(i, 1);
    gone.push(it.id);
  }
  markDirty();
  return { ok: true, removed: gone.length };
}

function stats() {
  const all = load();
  const now = Date.now();
  let expired = 0, group = 0, user = 0;
  for (const x of all.items) {
    if (x.expireAt && Number(x.expireAt) <= now) expired++;
    if (x.scope === 'group') group++; else user++;
  }
  let fileBytes = 0;
  try { fileBytes = fs.statSync(FILE).size; } catch (e) { fileBytes = 0; }
  let latest = 0;
  for (const x of all.items) if ((x.updatedAt || 0) > latest) latest = x.updatedAt;
  return {
    total: all.items.length, groupScope: group, userScope: user, expired,
    bytes: fileBytes, latest, path: FILE, version: all.version || 2,
  };
}

module.exports = {
  FILE, DEFAULTS,
  add, list, search, retrieve, remove, removeByKeyword, clear, stats, prune, flush,
  looksSecret, similarity, isExpired,
  // V15.2：按 id 直接写入/覆盖一条条目，**不做相似合并**（与 add 明确区分）。
  // 群友画像需要「严格按 群号+QQ号 隔离」：add() 的相似合并只比对 userId，
  // 会把不同群里内容相似的画像互相覆盖。画像因此自行判断合并与新增，用本函数落盘。
  // 仅新增导出，不改变 add/remove/list 等任何既有函数的行为。
  upsertRaw,
  setConfig: (fn) => { module.exports.getCFG = fn; },
  _setFile: (p) => { FILE = p; cache = null; dirty = false; if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; } },
  _setLegacyFile: (p) => { LEGACY = p; cache = null; },
  _reset: () => { cache = null; dirty = false; },
};
