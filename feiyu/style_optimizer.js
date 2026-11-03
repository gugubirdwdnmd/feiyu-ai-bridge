'use strict';

/**
 * 发言风格优化：去「人机感」+ 简化 + emoji/表情包策略。
 *
 * 目标：让 AI 的话更像真人随口说的——去掉客套和套话、砍掉啰嗦的铺陈、
 * 按情绪随手带（或带好几个）emoji，并给出该发什么表情包的建议关键词。
 *
 * 设计原则：
 *   1. 默认关闭（style.enabled 必须为 true 才动一个字）。
 *   2. 纯本地规则，**不新增任何模型调用**。
 *   3. 确定性：同样的输入永远得到同样的输出（用文本哈希挑 emoji，不用 Math.random），
 *      这样测试可复现，也不会出现「同一句话一会儿带表情一会儿不带」。
 *   4. 只做减法与点缀，绝不改变事实内容：不删数字、代码、链接、列表结构。
 *   5. 任何异常都吞掉并原样返回，绝不打断发言。
 *
 * ⚠ 表情包「联网检索」不在这里，见 feiyu/meme_search.js（默认关闭、未验证）。
 */

const DEFAULTS = {
  enabled: false,

  // —— 去人机感 ——
  stripGreeting: true,      // 去掉开头的「好的，」「当然，」「没问题，」
  stripSignOff: true,       // 去掉结尾的「希望对你有帮助」「如有问题随时问我」
  stripAiSelf: true,        // 去掉「作为一个AI/人工智能助手…」这类自我介绍
  stripFiller: true,        // 去掉「总之、综上所述、首先/其次/最后」这类空洞连接词

  // —— 简化 ——
  simplify: true,
  maxChars: 120,            // 超过就按句截断（0 = 不限制）
  maxSentences: 3,          // 最多保留几句（0 = 不限制）
  collapsePunct: true,      // 收敛重复标点（！！！→！）

  // —— emoji ——
  emoji: {
    enabled: false,         // 默认关闭：改语气属于明显行为变化，需显式开启
    max: 3,                 // 单条最多几个
    density: 0.6,           // 命中情绪时的插入概率（0~1，用确定性哈希判定）
    allowRepeat: false,     // 是否允许同一条里出现重复 emoji
    pool: ['😄', '😅', '🙂', '😉', '😏', '🤔', '😮', '🥲', '😴', '👍', '👀', '🙌', '✨', '💡', '🔥'],
  },

  // —— 表情包建议（交给既有 sticker 系统去发）——
  sticker: {
    enabled: false,
    maxKeywords: 1,
  },
};

// 情绪关键词 → emoji 候选（按顺序取；同一个词只命中一组）
const MOOD_RULES = [
  { kw: /(哈哈|笑死|好笑|逗|乐|开心|高兴|太棒|厉害|牛)/, emoji: ['😄', '🔥', '🙌'] },
  { kw: /(无语|服了|无奈|尴尬|汗|emmm|呃)/, emoji: ['😅', '🙂'] },
  { kw: /(难过|伤心|委屈|哭|心疼|遗憾|抱歉|对不起)/, emoji: ['🥲', '😔'] },
  { kw: /(困|累|睡|熬夜|躺平|摸鱼)/, emoji: ['😴', '🙂'] },
  { kw: /(想|思考|为什么|是不是|难道|纠结|考虑)/, emoji: ['🤔', '👀'] },
  { kw: /(哇|真的吗|居然|居然|震惊|意外|没想到)/, emoji: ['😮', '✨'] },
  { kw: /(可以|没问题|搞定|成了|好了|收到|明白)/, emoji: ['👍', '✨'] },
  { kw: /(注意|小心|提醒|别忘了|记得)/, emoji: ['💡', '👀'] },
  { kw: /(坏笑|懂的都懂|你懂|嘿嘿|皮一下)/, emoji: ['😏', '😉'] },
];

// 表情包关键词（给既有 sticker 系统用）
const STICKER_RULES = [
  { kw: /(哈哈|笑死|好笑|逗|乐|开心|高兴)/, word: '开心' },
  { kw: /(无语|服了|无奈|尴尬)/, word: '无语' },
  { kw: /(厉害|牛|强|太棒|优秀)/, word: '点赞' },
  { kw: /(难过|委屈|心疼|哭)/, word: '委屈' },
  { kw: /(坏笑|嘿嘿|你懂|皮一下)/, word: '偷笑' },
  { kw: /(加油|冲|努力|别放弃)/, word: '加油' },
];

const GREETING_RE = /^\s*(好的|好嘞|当然|没问题|可以的|没问题～|收到|明白|好的呢|嗯[，,、]?)\s*[，,、!！~～]?\s*/;
const SIGNOFF_RE = /\s*(如果?(你|您)?还有?(任何|其它|其他)?(问题|疑问|需要)[^。！？!?]{0,20}[，,、]?(请)?(随时|尽管)[^。！？!?]{0,10}[。!！?？]?|希望?(以上|这些|这)?(对你|对您|能)?(有帮助|有用|帮到你)[^。！？!?]{0,10}[。!！?？]?|以上(就是|是)我(的)?(回答|建议)[^。！？!?]{0,10}[。!！?？]?)\s*$/;
const AI_SELF_RE = /^\s*(作为(一个)?(AI|人工智能|A\.?I\.?)[^。！？\n]{0,40}[，,、：:]?\s*)/i;
// 空洞连接词：整句起始处的「总之/首先/其次/另外」是典型的 AI 腔，删掉；
// 「最后」只在后面紧跟标点时才删（「最后一步是…」这类是有意义的，不能动）。
const FILLER_RE = /(?:^|[。！？!?\n]\s*)(?:总之|综上所述|总而言之|话说回来|值得一提的是|需要注意的是|首先|其次|另外|此外)[，,、]?\s*/g;
const FILLER_LAST_RE = /[，,、]\s*(?:最后)\s*[，,、]/g;
// 句中残留的「，其次…」，删掉连接词、保留逗号
const FILLER_MID_RE = /[，,、]\s*(?:其次|此外|另外)[，,、]?\s*/g;

// 确定性哈希（djb2），保证同输入同输出
function hash(s) {
  let h = 5381;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

let getCFG = () => ({});
function setConfig(fn) { if (typeof fn === 'function') getCFG = fn; }

function num(v, d, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, n));
}

function cfg() {
  const c = (typeof getCFG === 'function' && getCFG()) || {};
  const s = c.style || {};
  const e = s.emoji || {};
  const k = s.sticker || {};
  const pool = Array.isArray(e.pool) && e.pool.length ? e.pool.map(String) : DEFAULTS.emoji.pool.slice();
  return {
    enabled: s.enabled === true,
    stripGreeting: s.stripGreeting !== false,
    stripSignOff: s.stripSignOff !== false,
    stripAiSelf: s.stripAiSelf !== false,
    stripFiller: s.stripFiller !== false,
    simplify: s.simplify !== false,
    maxChars: num(s.maxChars, DEFAULTS.maxChars, 0, 5000),
    maxSentences: num(s.maxSentences, DEFAULTS.maxSentences, 0, 50),
    collapsePunct: s.collapsePunct !== false,
    emoji: {
      enabled: e.enabled === true,
      max: num(e.max, DEFAULTS.emoji.max, 1, 10),
      density: num(e.density, DEFAULTS.emoji.density, 0, 1),
      allowRepeat: e.allowRepeat === true,
      pool,
    },
    sticker: {
      enabled: k.enabled === true,
      maxKeywords: num(k.maxKeywords, DEFAULTS.sticker.maxKeywords, 1, 3),
    },
  };
}

// —— 是否已含 emoji（粗略：匹配常见 emoji 区段）——
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/u;
function hasEmoji(s) { return EMOJI_RE.test(String(s || '')); }
function countEmoji(s) {
  const m = String(s || '').match(new RegExp(EMOJI_RE.source, 'gu'));
  return m ? m.length : 0;
}

// 保护代码/链接/数字：这些段落不做简化
function isProtected(text) {
  const t = String(text || '');
  return /```/.test(t) || /https?:\/\//i.test(t) || /^\s*[-*+]\s/m.test(t);
}

function stripClichés(text, c) {
  let t = String(text || '');
  const applied = [];
  // 顺序很重要：先去掉开头的「好的，」，才能露出后面的「作为一个AI…」把它一起删掉
  if (c.stripGreeting) {
    const before = t;
    t = t.replace(GREETING_RE, '');
    if (t !== before) applied.push('greeting');
  }
  if (c.stripAiSelf && AI_SELF_RE.test(t)) { t = t.replace(AI_SELF_RE, ''); applied.push('ai-self'); }
  if (c.stripSignOff) {
    const before = t;
    t = t.replace(SIGNOFF_RE, '');
    if (t !== before) applied.push('signoff');
  }
  if (c.stripFiller && !isProtected(t)) {
    const before = t;
    // 多次扫描：删掉「总之，」后后面的「首先」才轮到句首，一轮扫不干净
    for (let i = 0; i < 3; i++) {
      const prev = t;
      t = t.replace(FILLER_RE, (m) => (m.match(/^[。！？!?\n]/) ? m.charAt(0) : ''));
      if (t === prev) break;
    }
    t = t.replace(FILLER_LAST_RE, '，').replace(FILLER_MID_RE, '，')
         // 删掉连接词后会留下「。，」这类断头标点，统一收敛
         .replace(/[，,、]\s*(?=[。！？!?])/g, '')
         .replace(/[，,、]{2,}/g, '，')
         .replace(/^[，,、。！？!?\s]+/, '');
    if (t !== before) applied.push('filler');
  }
  if (c.collapsePunct) {
    const before = t;
    t = t.replace(/([!！])\1{1,}/g, '$1').replace(/([?？])\1{1,}/g, '$1').replace(/([。])\1{1,}/g, '$1');
    if (t !== before) applied.push('punct');
  }
  return { text: t.trim(), applied };
}

function simplifyText(text, c) {
  let t = String(text || '').trim();
  const applied = [];
  if (!c.simplify || isProtected(t)) return { text: t, applied };

  // 按句末标点切句（保留标点）
  const parts = t.split(/(?<=[。！？!?；;\n])/).filter((x) => x.trim());
  if (c.maxSentences > 0 && parts.length > c.maxSentences) {
    t = parts.slice(0, c.maxSentences).join('').trim();
    applied.push('sentences');
  }
  if (c.maxChars > 0 && t.length > c.maxChars) {
    // 按句回退，尽量在句末截断，避免半句话
    const ps = t.split(/(?<=[。！？!?；;\n])/).filter((x) => x.trim());
    let out = '';
    for (const p of ps) {
      if ((out + p).length > c.maxChars) break;
      out += p;
    }
    t = (out || t.slice(0, c.maxChars)).trim();
    applied.push('chars');
  }
  return { text: t, applied };
}

/** 按情绪挑 emoji（确定性） */
function pickEmoji(text, c) {
  if (!c.emoji.enabled || !c.emoji.pool.length) return [];
  const t = String(text || '');
  if (!t) return [];
  const h = hash(t);
  // 概率门：density=1 时恒成立；density=0 时恒不成立
  if (c.emoji.density < 1 && (h % 1000) / 1000 >= c.emoji.density) return [];

  const picks = [];
  for (const rule of MOOD_RULES) {
    if (rule.kw.test(t)) {
      const cand = rule.emoji.filter((x) => c.emoji.pool.indexOf(x) >= 0);
      if (cand.length) picks.push(cand[(h + picks.length) % cand.length]);
      if (picks.length >= c.emoji.max) break;
    }
  }
  if (!picks.length) {
    // 没命中情绪：按 density 偶尔随手带一个，让语气不那么"端着"
    picks.push(c.emoji.pool[h % c.emoji.pool.length]);
  }
  if (!c.emoji.allowRepeat) {
    const seen = new Set();
    return picks.filter((x) => (seen.has(x) ? false : (seen.add(x), true))).slice(0, c.emoji.max);
  }
  return picks.slice(0, c.emoji.max);
}

/** 建议的表情包关键词（交给既有 sticker 系统） */
function suggestStickerKeywords(text, c) {
  if (!c.sticker || !c.sticker.enabled) return [];
  const t = String(text || '');
  const out = [];
  for (const rule of STICKER_RULES) {
    if (rule.kw.test(t) && out.indexOf(rule.word) < 0) out.push(rule.word);
    if (out.length >= (c.sticker.maxKeywords || 1)) break;
  }
  return out;
}

/**
 * 主入口：优化一段待发送的文字。
 * @param {string} text
 * @param {object} o  { cfg?, force?:boolean }
 * @returns {{text:string, changed:boolean, applied:string[], emoji:string[], stickers:string[]}}
 */
function polish(text, o) {
  o = o || {};
  const c = cfg();
  const src = String(text == null ? '' : text);
  if (!c.enabled && !o.force) {
    return { text: src, changed: false, applied: [], emoji: [], stickers: [] };
  }
  try {
    let t = src;
    const applied = [];

    const a = stripClichés(t, c);
    t = a.text; applied.push(...a.applied);

    const b = simplifyText(t, c);
    t = b.text; applied.push(...b.applied);

    // emoji：已有 emoji、超预算、或内容受保护（代码/链接/列表）时不再点缀
    let emoji = [];
    if (!isProtected(t)) {
      emoji = pickEmoji(t, c);
      if (emoji.length && countEmoji(t) < c.emoji.max) {
        const room = c.emoji.max - countEmoji(t);
        const add = emoji.slice(0, Math.max(0, room));
        if (add.length) {
          t = (t + ' ' + add.join('')).trim();
          applied.push('emoji');
        }
      }
    }

    const stickers = suggestStickerKeywords(src, c);
    // 兜底：如果整段话被删空了（比如原话就只是「好的」），宁可原样发，也不发一条空白消息
    if (!t.trim()) {
      return { text: src, changed: false, applied: [], emoji: [], stickers };
    }
    return {
      text: t,
      changed: t !== src,
      applied,
      emoji,
      stickers,
    };
  } catch (e) {
    return { text: src, changed: false, applied: [], emoji: [], stickers: [] };
  }
}

module.exports = {
  DEFAULTS, MOOD_RULES, STICKER_RULES,
  setConfig, cfg, hash,
  polish, stripClichés, simplifyText, pickEmoji, suggestStickerKeywords,
  hasEmoji, countEmoji, isProtected,
};
