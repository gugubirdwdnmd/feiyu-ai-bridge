'use strict';
// ================= V15.2：群友轻量画像（扩展既有 memory_store，不另建存储）=================
// 设计原则（严格对应需求）：
//   ① 复用 memory/memory_store.js —— 画像就是 scope='user' 且带 profile 标记的记忆条目，
//      共用同一份 notes_v2.json、同一套隔离/去重/容量/TTL 治理，**不创建第二套记忆**。
//   ② 隔离键 = 群号 + 用户 QQ 号（profileKey = `${groupId}:${userId}`）：
//      不同群、不同成员的画像绝不混用（memoryStore 的 scope/userId 过滤天然保证这点，
//      这里再显式校验一次 groupId，避免把 A 群画像用到 B 群）。
//   ③ 只记「对聊天有实际帮助」的低敏感信息：称呼偏好 / 交流风格 / 明确表达的兴趣 /
//      持续进行的项目 / 用户主动纠正过的偏好。全部靠**显式线索**（正则），不做模型推断。
//   ④ 严格区分「用户明确说过的事实」与「系统推测」：
//      - source='stated'  ← 消息里出现明确的自我陈述句式（我叫…/我是做…的/以后叫我…）
//        confidence 高（0.75~0.9）
//      - source='inferred' ← 只能从表达方式推测出的弱信号（说话简短/爱用表情/常问技术）
//        confidence **低（0.3）**，且注入时明确标注「推测」，绝不当事实用。
//   ⑤ 不推断、不保存敏感个人属性：年龄/性别/婚恋/健康/宗教/政治/收入/住址/身份证等
//      一律**拒收**（即使用户自己说了也不入画像），避免贴标签与隐私风险。
//   ⑥ 不凭单条消息定性：inferred 类需要**至少 minSamples 条**样本才允许升为画像条目，
//      显式陈述（stated）1 条即可（因为那是用户自己说的）。
//   ⑦ 三重上限：单人条目数 / 单条长度 / 总体积；重复信息**合并更新**而非累加。
//   ⑧ 默认关闭（groupProfile.enabled=false），且**默认不向群内公开**任何成员的画像。
//   ⑨ 零第三方依赖、零额外付费 API、不引入向量库；更新走 memoryStore 既有异步落盘。

const path = require('path');
const memoryStore = require('./memory_store');
const crypto = require('crypto');

const PROFILE_SOURCE = 'profile';

// —— 默认配置（新功能默认关闭；数值均为保守上限，避免 token/磁盘成本增长）——
const DEFAULTS = {
  enabled: false,            // 默认关闭
  maxPerUser: 12,            // 单人画像条目上限
  maxLen: 60,                // 单条画像长度上限（画像要简洁，不塞长文）
  injectLimit: 3,            // 单次注入模型上下文的画像条数上限
  injectChars: 200,          // 单次注入的总字数上限
  minIntervalMs: 10 * 60 * 1000,  // 同一成员的画像更新最小间隔（避免每条消息都写）
  minSamples: 3,             // inferred（推测类）升为画像所需的最少样本数
  ttlDays: 90,               // 画像保留天数（比普通记忆短，避免长期贴标签）
  inferredConfidence: 0.3,   // 推测类固定低置信度
  statedConfidence: 0.8,     // 明确陈述类置信度
  shareToGroup: false,       // 默认不向群内公开任何成员的画像
  // 任务书 B5：不能只限条数而忽略总体积。这是**全部画像条目**的总字节上限，
  // 超了优先淘汰「低置信 + 最久未更新」的，避免画像把记忆文件撑大。
  maxTotalBytes: 256 * 1024, // 画像总字节上限（默认 256KB）
};

function cfg() {
  const c = (module.exports.getCFG && module.exports.getCFG()) || {};
  const s = c.groupProfile || {};
  // 注意：显式 0 是有意义的取值（例如 minIntervalMs=0 关闭频率限制、
  // injectLimit=0 关闭注入），所以不能用 `Number(v) || d` —— 那会把 0 吞掉。
  // 这里区分「未提供(undefined/null/空串)」与「显式 0」。
  const raw = (v) => (v === undefined || v === null || v === '') ? undefined : Number(v);
  const num = (v, d, min) => { const n = raw(v); return Math.max(min, n === undefined || isNaN(n) ? d : n); };
  return {
    enabled: s.enabled === true,        // 只有显式 true 才开
    maxPerUser: num(s.maxPerUser, DEFAULTS.maxPerUser, 1),
    maxLen: num(s.maxLen, DEFAULTS.maxLen, 10),
    injectLimit: num(s.injectLimit, DEFAULTS.injectLimit, 0),
    injectChars: num(s.injectChars, DEFAULTS.injectChars, 0),
    minIntervalMs: num(s.minIntervalMs, DEFAULTS.minIntervalMs, 0),
    minSamples: num(s.minSamples, DEFAULTS.minSamples, 2),
    ttlDays: num(s.ttlDays, DEFAULTS.ttlDays, 1),
    maxTotalBytes: num(s.maxTotalBytes, DEFAULTS.maxTotalBytes, 4096),
    inferredConfidence: DEFAULTS.inferredConfidence,   // 不允许调高（保持"推测"低置信）
    statedConfidence: num(s.statedConfidence, DEFAULTS.statedConfidence, 0.5),
    shareToGroup: s.shareToGroup === true,             // 默认不公开
  };
}

function enabled() { return cfg().enabled; }

// ================= 敏感属性：一律拒收（即使用户自己说的也不入画像）=================
// 需求明确："不推断或保存敏感个人属性"。这里只拦「画像维度」上的敏感属性，
// 不影响正常聊天记忆（那是另一个 scope 的既有功能）。
//
// 注意：规则必须覆盖**自然自述句式**，不能只覆盖名词标签 ——
// 例如「我今年35岁」「我是男的」「我住某某小区」都不含"年龄/性别/住址"字样，
// 但它们恰恰是最典型的敏感自述。只写名词会漏掉最需要拦的那些。
const SENSITIVE_ATTR_RE = [
  // 年龄 / 生日
  /(年龄|多大了|几岁|出生|生日|哪年|今年\s*\d{1,2}\s*岁|我\s*\d{1,2}\s*岁|\d{1,2}\s*岁)/,
  // 性别
  /(性别|我是\s*[男女](生|的|人)?|男生|女生|男的女的|是不是男|是不是女)/,
  // 婚恋
  /(婚|恋爱|结婚|相亲|对象|脱单|男朋友|女朋友|老公|老婆|未婚|已婚)/,
  // 健康 / 心理（含具体病名，避免"我有高血压"这类自述漏网）
  /(健康|疾病|生病|住院|手术|吃药|在吃.{0,4}药|抑郁|焦虑症|自闭|残疾|智力|怀孕|高血压|糖尿病|癌症|肿瘤|发烧|过敏|哮喘)/,
  // 宗教 / 政治
  /(宗教|信仰|信佛|信教|基督教|伊斯兰|清真|党员|党籍|投票|共产党|支持.{0,4}党)/,
  // 收入 / 资产
  /(工资|收入|月薪|年薪|存款|资产|房贷|车贷|贷款|赚\s*\d|月薪\s*\d)/,
  // 住址 / 户籍
  /(住址|住哪|住在|住\s*\S{2,}(小区|村|城|市|区|路|街|号|栋|单元)|哪个小区|户籍|门牌|几楼)/,
  // 证件 / 金融账号
  /(身份证|护照号|银行卡|社保号|学号)/,
  // 敏感编号（独立于上面的词，避免只靠关键词漏掉裸数字）
  /\b\d{17}[\dXx]\b/,     // 身份证
  /\b1[3-9]\d{9}\b/,      // 手机号
];
function looksSensitiveAttr(text) {
  const t = String(text || '');
  return SENSITIVE_ATTR_RE.some((re) => re.test(t));
}

// 凭据类内容直接拒收（复用 memory_store 的判定，避免重复实现且保持一致）
function looksSecret(text) {
  try { return typeof memoryStore.looksSecret === 'function' && memoryStore.looksSecret(text); }
  catch (e) { return false; }
}

// ================= 显式陈述线索（stated：用户自己说的，可高置信）=================
// 每条规则：{ re, kind, build(m) } —— 只捕捉明确的自述句式。
const STATED_RULES = [
  { re: /(?:我(?:叫|名字叫|的名字是))\s*([^\s，。！？,.!?]{1,12})/, kind: '称呼', build: (m) => `希望被称呼为「${m[1]}」` },
  { re: /(?:以后|下次)(?:就)?叫我\s*([^\s，。！？,.!?]{1,12})/, kind: '称呼', build: (m) => `明确要求以后称呼为「${m[1]}」` },
  { re: /(?:我是|我这边是|我做的是|我是做)\s*([^\s，。！？,.!?]{1,16})(?:的|工作|行业)?/, kind: '身份', build: (m) => `自述身份/工作：${m[1]}` },
  { re: /(?:我(?:喜欢|偏好|习惯|常用|爱用))\s*([^\s，。！？,.!?]{1,16})/, kind: '偏好', build: (m) => `明确表示喜欢/偏好：${m[1]}` },
  { re: /(?:我不喜欢|我讨厌|我不用|别给我)\s*([^\s，。！？,.!?]{1,16})/, kind: '偏好', build: (m) => `明确表示不喜欢/不用：${m[1]}` },
  { re: /(?:我(?:最近|正在)(?:在做|在写|在开发|在学|在看))\s*([^\s，。！？,.!?]{1,20})/, kind: '进行中', build: (m) => `正在做的事：${m[1]}` },
  { re: /(?:我(?:的)?项目是|(?:这个|我们的)项目叫)\s*([^\s，。！？,.!?]{1,20})/, kind: '项目', build: (m) => `持续进行的项目：${m[1]}` },
  { re: /(?:以后)?(?:回答|回复)(?:我)?(?:时)?\s*(?:请)?(简短|简洁|详细|长一点|短一点|用中文|用英文)/, kind: '纠正偏好', build: (m) => `明确纠正过：希望回复${m[1]}` },
  { re: /(?:说话|表达)(?:请)?(直接点|别绕|直白|客气)/, kind: '纠正偏好', build: (m) => `明确纠正过：希望说话${m[1]}` },
];

// ================= 弱信号线索（inferred：推测，低置信、需多样本）=================
// 只从「表达习惯」这种弱信号推测，不涉及任何个人属性。
const INFERRED_RULES = [
  { re: /^[^?？]{0,6}[?？]\s*$/, kind: '风格', build: () => '偏好简短提问式交流' },      // 只问短句
  { re: /^(哈+|呵+|233|草)/, kind: '风格', build: () => '常用简短网络用语' },
  { re: /(谢谢|多谢|thx|感谢)/i, kind: '风格', build: () => '习惯表达感谢' },
];

function profileKey(groupId, userId) {
  return String(groupId == null ? '' : groupId) + ':' + String(userId == null ? '' : userId);
}

// —— 样本计数（仅内存，重启即清零；用于 inferred 的多样本门槛，不持久化）——
const samples = new Map();      // profileKey -> { lastAt, sig: Map(sig -> count) }
function sampleBucket(key) {
  let b = samples.get(key);
  if (!b) { b = { lastAt: 0, sig: new Map() }; samples.set(key, b); }
  return b;
}

// ================= 观察一条群消息 → 抽取候选画像（不落盘）=================
// 返回 { stated:[], inferred:[] }，调用方决定是否写入。
function extract(text) {
  const t = String(text || '').trim();
  if (!t) return { stated: [], inferred: [] };
  const stated = [];
  for (const r of STATED_RULES) {
    const m = t.match(r.re);
    if (m && m[1]) {
      const content = r.build(m);
      // 双保险：敏感属性 + 凭据内容一律不进画像
      if (looksSensitiveAttr(content) || looksSecret(content)) continue;
      if (looksSensitiveAttr(t)) continue;
      stated.push({ kind: r.kind, content, source: 'stated' });
    }
  }
  const inferred = [];
  for (const r of INFERRED_RULES) {
    if (r.re.test(t)) inferred.push({ kind: r.kind, content: r.build(), source: 'inferred' });
  }
  return { stated, inferred };
}

/**
 * 观察一条群消息并按需更新画像。
 * @param {object} o { groupId, userId, text }
 * @returns {object} { ok, skipped, added, merged, candidates }
 */
function observe(o) {
  o = o || {};
  const c = cfg();
  if (!c.enabled) return { ok: false, skipped: 'disabled' };
  const gid = o.groupId == null ? null : String(o.groupId);
  const uid = o.userId == null ? null : String(o.userId);
  // 隔离键必须同时有群号与用户号；缺任一 → 不处理（绝不做跨群/跨成员混用）
  if (!gid || !uid) return { ok: false, skipped: 'no-isolation-key' };

  const key = profileKey(gid, uid);
  const bucket = sampleBucket(key);
  const now = Date.now();

  // ① 先累计样本（inferred 需要多样本；即使本轮不写盘也要累计）
  const got = extract(o.text);
  for (const s of got.inferred) {
    const sig = s.kind + '|' + s.content;
    bucket.sig.set(sig, (bucket.sig.get(sig) || 0) + 1);
  }

  // ② 更新频率限制：同一成员最小间隔内不落盘（避免每条消息都写，控制成本）
  const rateLimited = (now - (bucket.lastAt || 0)) < c.minIntervalMs;
  const out = { ok: true, added: 0, merged: 0, candidates: got.stated.length, skipped: null };

  // ③ 明确陈述：用户自己说的 → 立即可入画像（不受多样本门槛，但仍受频率限制）
  if (got.stated.length && !rateLimited) {
    for (const s of got.stated) {
      const r = writeProfile(gid, uid, s.content, 'stated', c.statedConfidence, s.kind, c);
      if (r.ok) { if (r.merged) out.merged++; else out.added++; }
    }
    bucket.lastAt = now;
  }

  // ④ 推测类：达到多样本门槛才允许入画像，且置信度固定为低值
  if (!rateLimited) {
    for (const [sig, n] of bucket.sig) {
      if (n < c.minSamples) continue;
      const i = sig.indexOf('|');
      const kind = sig.slice(0, i);
      const content = sig.slice(i + 1);
      const r = writeProfile(gid, uid, content, 'inferred', c.inferredConfidence, kind, c);
      if (r.ok) { if (r.merged) out.merged++; else out.added++; }
    }
  }
  return out;
}

// —— 写入单条画像（走 memoryStore，天然获得隔离/去重合并/容量/TTL）——
// 关键：scope='user' + groupId+userId；source 带 profile 标记，便于按来源查看/清理。
// 容量：仅**新增**时才按单人条数上限腾位；总字节治理按「写入后的预计总量」进行。
// —— 写入单条画像 ——
// 为什么不直接用 memoryStore.add()：
//   add() 的相似合并只按 scope + userId 过滤，**不比对 groupId**
//   （普通个人记忆的设计是「同一人跨群共享」，属既有行为，不应改动）。
//   而画像的隔离键是「群号+QQ号」。实测：群A 的「希望被称呼为「阿甲」」与
//   群B 的「希望被称呼为「阿丙」」相似度 0.857 ≥ 0.8，会被 add() 判为同一项而
//   **互相覆盖** —— 既跨群泄漏又丢数据。因此画像完全自己管理合并：
//   ① 只在「本群 + 本人」的画像条目里找相似项，找到就更新（hits++、刷新时间）；
//   ② 本群没有相似项才新增，且用 upsertRaw（按 id 直接覆盖，不做任何相似合并）。
//   存储、容量治理、原子落盘、敏感拒收仍全部复用 memory_store（同一份数据文件）。
function writeProfile(gid, uid, content, source, confidence, kind, c) {
  c = c || cfg();
  const text = String(content || '').replace(/\s+/g, ' ').trim().slice(0, c.maxLen);
  if (!text) return { ok: false, error: 'empty' };
  if (looksSecret(text) || looksSensitiveAttr(text)) return { ok: false, error: 'sensitive' };

  const src = PROFILE_SOURCE + ':' + source + ':' + kind;

  // ① 先判断「本群 + 本人」是否已有可合并条目。
  // ⚠ 这一步必须在任何淘汰动作**之前**完成：
  //   旧实现先跑 enforcePerUser/enforceTotalBytes 再找相似项，结果「重复陈述同一件事」
  //   也会先被腾位删掉一条（往往是另一条画像），更新变成「新增一条 + 误删一条」。
  //   正确顺序：先判定能否合并 → 能合并就走更新（不腾位、不淘汰），不能合并才走新增。
  const hit = findMergable(gid, uid, text);

  if (hit) {
    // ② 更新既有条目：**不调用 enforcePerUser**。
    //   更新不占用新名额（条目总数不变），因此不需要、也不允许为了它去淘汰其它条目。
    const keep = Object.assign({}, hit);
    keep.hits = (Number(keep.hits) || 0) + 1;
    keep.updatedAt = Date.now();          // 刷新时间 → 更新后不会被当成"最久未更新"淘汰
    keep.lastHitAt = 0;
    // 再次陈述同一件事 → 视为「再次确认」，刷新最后确认时间（过期/淘汰策略用）
    keep.lastConfirmedAt = Date.now();
    // 再次陈述同一件事 → 置信度小幅提升；推测类不因重复而变成事实
    if (String(keep.source || '').indexOf(PROFILE_SOURCE + ':stated') === 0) {
      keep.confidence = Math.min(1, (Number(keep.confidence) || 0.6) + 0.05);
    }
    // 容量：按「写入后的预计总量」治理 —— 预计 =（现有画像总量 − 旧条目）+ 本条目。
    // 旧条目用 protectId 保护，避免被自己的容量治理淘汰掉（否则更新会变成"什么都没写"）。
    const need = byteLen(keep);
    if (c.maxTotalBytes && need > c.maxTotalBytes) {
      // 单条本身就超过总预算 → 淘汰谁都解决不了，明确拒绝，绝不假装写入成功
      return { ok: false, error: 'over-budget', reason: 'single-item', needBytes: need, maxBytes: c.maxTotalBytes };
    }
    const ev = enforceTotalBytes(c, { reserveBytes: need, protectId: keep.id });
    if (!ev.ok) {
      // 腾不出足够空间（单条超限 / 淘汰失败）→ 拒绝写入，不留下"写了但超预算"的状态
      return { ok: false, error: 'over-budget', reason: ev.reason || 'evict-failed', evicted: ev.removed, needBytes: need, maxBytes: c.maxTotalBytes };
    }
    // upsertRaw 按 id 覆盖 → 条目总数不变。
    // （不再"先 remove 再 upsert"：那会在两步之间留下丢数据的窗口，且旧实现依赖的
    //   "upsertRaw 是追加" 的假设已经在本次修复后不成立，先删后写纯属多余。）
    const w = memoryStore.upsertRaw(keep);
    if (!w || !w.ok) return { ok: false, error: (w && w.error) || 'write-failed' };
    return { ok: true, merged: true, id: keep.id };
  }

  // ③ 本群无相似项 → 新增（upsertRaw 只按 id 覆盖、不做相似合并，天然不跨群污染）
  const now = Date.now();
  const item = {
    id: 'p_' + now.toString(36) + '_' + crypto.randomBytes(4).toString('hex'),
    scope: 'user',
    groupId: String(gid),
    userId: String(uid),
    content: text,
    source: src,
    createdAt: now,
    updatedAt: now,
    lastConfirmedAt: now,        // 最后确认时间（过期/淘汰策略用）
    expireAt: now + c.ttlDays * 86400000,
    confidence: Math.max(0, Math.min(1, Number(confidence) || 0.6)),
    hits: 0,
    lastHitAt: 0,
    storedAt: now,
  };
  // 单条就超过总预算 → 直接拒绝（不腾位、不淘汰、不写）
  const need = byteLen(item);
  if (c.maxTotalBytes && need > c.maxTotalBytes) {
    return { ok: false, error: 'over-budget', reason: 'single-item', needBytes: need, maxBytes: c.maxTotalBytes };
  }
  // 只有「新增」才占新名额，所以单人条数上限只在这里治理
  try { enforcePerUser(gid, uid, c); } catch (e) { /* 裁剪失败不阻断写入 */ }
  // 容量治理按「写入后的预计总量」：现有条目的预算 = 总上限 − 本次将占用的字节。
  // 这样"当前还没超限、但加上这条就超限"的情形也能被治理，而不是等超了才管。
  const ev = enforceTotalBytes(c, { reserveBytes: need });
  if (!ev.ok) {
    return { ok: false, error: 'over-budget', reason: ev.reason || 'evict-failed', evicted: ev.removed, needBytes: need, maxBytes: c.maxTotalBytes };
  }
  const w = memoryStore.upsertRaw(item);
  return w && w.ok ? { ok: true, merged: false, id: item.id } : { ok: false, error: (w && w.error) || 'write-failed' };
}

// —— 在「本群 + 本人」的画像里找可合并条目（阈值 0.8，与 memory_store.add 一致）——
// 只在本群本人范围内比对：跨群内容相似的画像绝不能互相合并（那是画像泄漏的根因）。
function findMergable(gid, uid, text) {
  for (const it of listRaw(gid, uid)) {
    if (memoryStore.similarity(text, it.content) >= 0.8) return it;
  }
  return null;
}

// —— 单人条目上限：超出时删最旧（画像要短小精悍）——
function enforcePerUser(gid, uid, c) {
  c = c || cfg();
  const mine = listRaw(gid, uid);
  // ⚠ 必须是「条数已达上限就腾位置」，不能写成 `<=` 才裁剪。
  //   用 `<=` 时：已有 2 条（上限 2）→ 2<=2 不裁剪 → 写入后变 3 条，上限形同虚设。
  //   正确做法：满员时先删掉最旧的一条，再写入新条目，保证结果恒 <= maxPerUser。
  if (mine.length < c.maxPerUser) return 0;
  const overflow = mine.length - c.maxPerUser + 1;   // +1 是给即将写入的新条目腾位
  // mine 已按时间倒序（新的在前），从尾部删最旧的
  const victims = mine.slice(-overflow);
  let removed = 0;
  for (const it of victims) {
    try {
      const r = memoryStore.remove(it.id, { userId: uid, isAdmin: true });
      if (r && r.ok) removed++;
    } catch (e) { /* 单条删除失败不影响其他 */ }
  }
  return removed;
}

// —— 取该成员在本群的画像条目（按 updatedAt 倒序）——
// ⚠ 必须在 memoryStore 过滤**之上再按 groupId 收紧一次**：
//   memory_store.visible() 对 scope='user' 只比对 userId、不比对 groupId
//   （那是普通个人记忆「同一人跨群可见」的既有设计，不能改）。
//   但画像的隔离键是「群号+QQ号」，若不额外收紧，群A 的画像会在群B 被读到 ——
//   这会造成跨群个人信息泄漏，属需求明确禁止的情形。
function listRaw(gid, uid) {
  const f = { groupId: String(gid), userId: String(uid), allowAll: false };
  const all = memoryStore.list(f, 1000);
  const g = String(gid), u = String(uid);
  return all.filter((x) => String(x.source || '').indexOf(PROFILE_SOURCE) === 0
    // 画像必须群内可见：groupId 完全一致（私聊场景画像不适用，故不放开 null）
    && String(x.groupId) === g
    && String(x.userId) === u);
}

/**
 * 查看画像（供 /画像 命令复用既有风格）。
 * @param {object} o { groupId, userId, actor:{userId,isAdmin}, all:boolean }
 */
function view(o) {
  o = o || {};
  const c = cfg();
  if (!c.enabled) return { ok: false, error: 'disabled' };
  const gid = o.groupId == null ? null : String(o.groupId);
  const uid = o.userId == null ? null : String(o.userId);
  if (!gid || !uid) return { ok: false, error: 'no-isolation-key' };

  // 隐私：非管理员只能看自己的画像；且默认不提供"看别人"的能力。
  const actor = o.actor || {};
  const actorId = actor.userId == null ? null : String(actor.userId);
  const self = actorId === uid;
  if (!self && !actor.isAdmin) return { ok: false, error: 'forbidden' };
  if (!self && !o.all && !actor.isAdmin) return { ok: false, error: 'forbidden' };

  const items = listRaw(gid, uid);
  return {
    ok: true,
    groupId: gid,
    userId: uid,
    items: items.map((x) => ({
      content: x.content,
      // 明确区分事实与推测：inferred 一律标注
      kind: (String(x.source || '').split(':')[2] || ''),
      stated: String(x.source || '').indexOf(PROFILE_SOURCE + ':stated') === 0,
      confidence: x.confidence,
      updatedAt: x.updatedAt,
    })),
    limits: { maxPerUser: c.maxPerUser, maxLen: c.maxLen, injectLimit: c.injectLimit, injectChars: c.injectChars },
  };
}

/**
 * 清除某成员画像。
 * @param {object} o { groupId, userId, actor:{userId,isAdmin} }
 */
function clearProfile(o) {
  o = o || {};
  if (!cfg().enabled) return { ok: false, error: 'disabled' };
  const gid = o.groupId == null ? null : String(o.groupId);
  const uid = o.userId == null ? null : String(o.userId);
  if (!gid || !uid) return { ok: false, error: 'no-isolation-key' };
  const actor = o.actor || {};
  const actorId = actor.userId == null ? null : String(actor.userId);
  if (String(actorId) !== uid && !actor.isAdmin) return { ok: false, error: 'forbidden' };

  const items = listRaw(gid, uid);
  let removed = 0;
  for (const it of items) {
    try { if (memoryStore.remove(it.id, { userId: uid, isAdmin: true }).ok) removed++; } catch (e) {}
  }
  samples.delete(profileKey(gid, uid));
  return { ok: true, removed };
}

// ================= 总字节治理（任务书 B5：不能只限条数）=================
function byteLen(it) {
  // 内容 + 元数据（id/scope/source/时间等）的粗略开销
  return String(it.content || '').length + 120;
}

/** 取出全库所有画像条目（跨群，仅用于总量治理与统计） */
function allProfiles() {
  try {
    return memoryStore.list({ groupId: null, userId: null, allowAll: true }, 5000)
      .filter((x) => String(x.source || '').indexOf(PROFILE_SOURCE) === 0);
  } catch (e) { return []; }
}

/**
 * 画像总字节上限治理：超限优先淘汰「低置信度 + 最久未更新」的条目。
 * 明确陈述（stated，高置信）尽量保留，推测类先走。
 *
 * ⚠ 关键：治理依据是**本次写入后的预计总量**，不是"当前已经超了才治"。
 *   调用方通过 opts.reserveBytes 声明"即将写入的这条将占用多少字节"，
 *   于是现有条目的可用预算 = maxTotalBytes − reserveBytes。
 *   这样"当前未超限、但再写一条就超"的情形也会被治理，写入后总量恒 ≤ 上限。
 *
 * @param {object} c 配置（cfg()）
 * @param {object} [opts] { reserveBytes:number, protectId:string }
 *        reserveBytes — 即将写入条目占用的字节（0 表示不预留）
 *        protectId    — 该 id 的条目不参与淘汰（用于"更新旧条目"：旧条目会被本条覆盖，
 *                       不应被自己的容量治理删掉）
 * @returns {{ok:boolean, removed:number, bytes:number, budget:number, reason:string|null}}
 *   ok=false 表示腾不出足够空间（reason: 'single-item' 单条即超限 / 'evict-failed' 淘汰失败），
 *   调用方必须据此**拒绝写入**，不能当作成功。
 *
 * 只淘汰画像条目（source 以 'profile:' 开头），绝不碰普通长期记忆。
 */
function enforceTotalBytes(c, opts) {
  c = c || cfg();
  opts = opts || {};
  if (!c.maxTotalBytes) return { ok: true, removed: 0, bytes: 0, budget: Infinity, reason: null };

  const reserve = Math.max(0, Number(opts.reserveBytes) || 0);
  const protectId = opts.protectId == null ? null : String(opts.protectId);
  // ① 单条（即将写入的那条）就比总预算还大 → 淘汰任何条目都救不了，直接判失败
  if (reserve > c.maxTotalBytes) {
    return { ok: false, removed: 0, bytes: currentBytes(protectId), budget: c.maxTotalBytes - reserve, reason: 'single-item' };
  }

  const budget = c.maxTotalBytes - reserve;      // 现有（不含被保护条目）允许的字节数
  const all = allProfiles().filter((x) => !(protectId && String(x.id) === protectId));
  let bytes = 0;
  for (const it of all) bytes += byteLen(it);
  if (bytes <= budget) return { ok: true, removed: 0, bytes, budget, reason: null };

  const sorted = all.slice().sort((a, b) => {
    const ca = Number(a.confidence) || 0, cb = Number(b.confidence) || 0;
    if (ca !== cb) return ca - cb;                                   // 低置信先淘汰
    return (Number(a.updatedAt) || 0) - (Number(b.updatedAt) || 0);  // 再按最久未更新
  });
  let removed = 0;
  for (const it of sorted) {
    if (bytes <= budget) break;
    // 双保险：只淘汰画像条目，任何情况下都不删普通长期记忆
    if (String(it.source || '').indexOf(PROFILE_SOURCE) !== 0) continue;
    try {
      const r = memoryStore.remove(it.id, { userId: it.userId, isAdmin: true });
      if (r && r.ok) { bytes -= byteLen(it); removed++; }
    } catch (e) { /* 单条失败不影响其它 */ }
  }
  // ② 淘汰完仍然放不下（例如删除全部失败 / 权限被拒）→ 明确失败，由调用方拒绝写入
  return { ok: bytes <= budget, removed, bytes, budget, reason: bytes <= budget ? null : 'evict-failed' };
}

/** 当前画像总字节（可排除 protectId 那一条） */
function currentBytes(protectId) {
  const pid = protectId == null ? null : String(protectId);
  let n = 0;
  for (const it of allProfiles()) {
    if (pid && String(it.id) === pid) continue;
    n += byteLen(it);
  }
  return n;
}

// ================= 单条删除 / 更正（任务书 B6）=================
/** 权限：本人或管理员；作用域严格限定「本群 + 本人」 */
function _canManage(o, gid, uid) {
  const actor = o.actor || {};
  const actorId = actor.userId == null ? null : String(actor.userId);
  return String(actorId) === uid || actor.isAdmin === true;
}

/**
 * 删除单条画像（按关键词或 id 命中）。
 * @returns {{ok:boolean, removed?:number, content?:string, error?:string}}
 *   error: 'disabled' | 'no-isolation-key' | 'forbidden' | 'not-found'
 */
function removeProfile(o) {
  o = o || {};
  if (!cfg().enabled) return { ok: false, error: 'disabled' };
  const gid = o.groupId == null ? null : String(o.groupId);
  const uid = o.userId == null ? null : String(o.userId);
  if (!gid || !uid) return { ok: false, error: 'no-isolation-key' };
  if (!_canManage(o, gid, uid)) return { ok: false, error: 'forbidden' };

  const items = listRaw(gid, uid);
  const kw = String(o.keyword || '').trim();
  const hit = kw
    ? items.find((x) => String(x.content || '').includes(kw))
    : (o.id ? items.find((x) => x.id === o.id) : null);
  if (!hit) return { ok: false, error: 'not-found' };
  try {
    const r = memoryStore.remove(hit.id, { userId: uid, isAdmin: true });
    if (r && r.ok) return { ok: true, removed: 1, content: hit.content };
  } catch (e) { /* 落到下面 */ }
  return { ok: false, error: 'remove-failed' };
}

/**
 * 更正某条画像：更新旧条目内容，而不是同时保留互相矛盾的两条事实。
 * - 命中条目的内容被替换为 newText，来源标记为 stated（用户明确纠正）、置信度提到 statedConfidence，
 *   并刷新 lastConfirmedAt。
 * - 与本条高度相似（>=0.8）的其它条目会被一并删除，避免矛盾并存。
 * @returns {{ok:boolean, before?:string, after?:string, mergedAway?:number, error?:string}}
 */
function correctProfile(o) {
  o = o || {};
  const c = cfg();
  if (!c.enabled) return { ok: false, error: 'disabled' };
  const gid = o.groupId == null ? null : String(o.groupId);
  const uid = o.userId == null ? null : String(o.userId);
  if (!gid || !uid) return { ok: false, error: 'no-isolation-key' };
  if (!_canManage(o, gid, uid)) return { ok: false, error: 'forbidden' };

  const newText = String(o.newText || '').replace(/\s+/g, ' ').trim().slice(0, c.maxLen);
  if (!newText) return { ok: false, error: 'empty' };
  if (looksSecret(newText) || looksSensitiveAttr(newText)) return { ok: false, error: 'sensitive' };

  const items = listRaw(gid, uid);
  const kw = String(o.keyword || '').trim();
  const hit = kw
    ? items.find((x) => String(x.content || '').includes(kw))
    : (o.id ? items.find((x) => x.id === o.id) : null);
  if (!hit) return { ok: false, error: 'not-found' };

  const before = hit.content;
  // 删掉其它高度相似的条目，避免「旧值和新值同时存在」这种矛盾状态
  let mergedAway = 0;
  for (const it of items) {
    if (it.id === hit.id) continue;
    if (memoryStore.similarity(newText, it.content) >= 0.8) {
      try { if (memoryStore.remove(it.id, { userId: uid, isAdmin: true }).ok) mergedAway++; } catch (e) {}
    }
  }

  const now = Date.now();
  hit.content = newText;
  hit.source = PROFILE_SOURCE + ':stated:corrected';
  hit.confidence = c.statedConfidence;
  hit.updatedAt = now;
  hit.lastConfirmedAt = now;
  try { memoryStore.upsertRaw(hit); } catch (e) { return { ok: false, error: 'write-failed' }; }
  return { ok: true, before, after: newText, mergedAway };
}

/**
 * 重建某成员画像：先清除，再把给定语料重新观察一遍（不调用任何模型，纯规则重放）。
 * @param {object} o { groupId, userId, actor, texts:[] }
 */
function rebuild(o) {
  o = o || {};
  const c = cfg();
  if (!c.enabled) return { ok: false, error: 'disabled' };
  const clr = clearProfile(o);
  if (!clr.ok) return clr;
  // 重建期间放宽频率限制（同一批语料要能一次性重放完）
  const texts = Array.isArray(o.texts) ? o.texts.slice(0, 200) : [];
  let added = 0;
  for (const t of texts) {
    const got = extract(t);
    for (const s of got.stated) {
      if (writeProfile(String(o.groupId), String(o.userId), s.content, 'stated', c.statedConfidence, s.kind, c).ok) added++;
    }
  }
  return { ok: true, removed: clr.removed, added, replayed: texts.length };
}

/**
 * 取可注入模型上下文的画像文本（简洁、受条数与字数双上限）。
 * 返回 '' 表示无可注入内容；调用方直接把结果拼进提示词即可。
 * @param {object} o { groupId, userId, text }  text 用于相关性排序（可选）
 */
function injectText(o) {
  o = o || {};
  const c = cfg();
  if (!c.enabled || !c.injectLimit) return '';
  const gid = o.groupId == null ? null : String(o.groupId);
  const uid = o.userId == null ? null : String(o.userId);
  if (!gid || !uid) return '';

  let items = listRaw(gid, uid);
  if (!items.length) return '';
  // 相关性排序：有当前话题时按 2-gram 重合度把相关的前置（仅重排，不额外调模型）
  const q = String(o.text || '').replace(/\s+/g, '');
  if (q.length >= 2) {
    const grams = new Set();
    for (let i = 0; i + 2 <= q.length; i++) grams.add(q.slice(i, i + 2));
    const total = Math.max(1, grams.size);
    items = items.slice().sort((a, b) => score(b, grams, total) - score(a, grams, total));
  }

  const out = [];
  let chars = 0;
  for (const it of items) {
    if (out.length >= c.injectLimit) break;
    const stated = String(it.source || '').indexOf(PROFILE_SOURCE + ':stated') === 0;
    const line = (stated ? '' : '（推测）') + it.content;
    if (chars + line.length > c.injectChars) continue;
    out.push(line);
    chars += line.length;
  }
  if (!out.length) return '';
  // 明确告知模型：stated 是用户自述，inferred 是低置信推测，不可当事实
  return '（该群成员画像，仅用于调整语气，不要主动向群里提及此人的个人信息；'
    + '带「（推测）」的是低置信观察、不可当成事实）：\n- ' + out.join('\n- ');
}

// —— 相关性打分：与 memory_store.retrieve() 保持同一套权重 ——
// 说明：任务书要求「优先复用 retrieve()」。评估结论是**不能直接复用**：
//   retrieve() 内部走 list(filter)，而 list() 对 scope='user' 只比对 userId、不比对 groupId
//   （普通个人记忆的既有设计是「同一人跨群共享」）。画像的隔离键是「群号+QQ号」，
//   直接复用会把别的群画像检索进来。因此这里仍走严格隔离的 listRaw()，
//   但打分公式与 retrieve() 对齐（重合度 0.7 + 置信度 0.2 + 命中 0.02），保证排序语义一致。
function score(item, grams, totalGrams) {
  let inter = 0;
  const t = String(item.content || '');
  for (const g of grams) if (t.includes(g)) inter++;
  const overlap = totalGrams ? inter / totalGrams : 0;
  return overlap * 0.7 + (Number(item.confidence) || 0) * 0.2 + Math.min(0.1, (Number(item.hits) || 0) * 0.02);
}

function stats() {
  const c = cfg();
  let count = 0, stated = 0;
  try {
    for (const it of memoryStore.list({ groupId: null, userId: null, allowAll: true }, 5000)) {
      if (String(it.source || '').indexOf(PROFILE_SOURCE) === 0) {
        count++;
        if (String(it.source).indexOf(PROFILE_SOURCE + ':stated') === 0) stated++;
      }
    }
  } catch (e) { /* 统计失败不影响主流程 */ }
  return { enabled: c.enabled, total: count, stated, inferred: count - stated, limits: DEFAULTS };
}

module.exports = {
  DEFAULTS, PROFILE_SOURCE,
  cfg, enabled, observe, extract, view, clearProfile, rebuild, injectText, stats,
  profileKey, listRaw, writeProfile, findMergable, enforcePerUser, enforceTotalBytes,
  allProfiles, currentBytes, byteLen,
  removeProfile, correctProfile, looksSensitiveAttr,
  setConfig: (fn) => { module.exports.getCFG = fn; },
  _resetSamples: () => { samples.clear(); },
};
