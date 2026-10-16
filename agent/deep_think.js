'use strict';

/**
 * 深度思考判定：判断这条消息值不值得先"想清楚"再回答。
 *
 * 背景：项目已有「complex → reasoning 模型」的分级，但只按字数和几个关键词判断，
 * 很多真正需要推理的问题（"为什么""该不该""一步步推"）会被判成 normal，
 * 直接用快模型随口答了。本模块补上"需要长思考"的识别。
 *
 * 设计原则：
 *   1. 纯本地规则，**不新增任何模型调用**（判定本身零成本）。
 *   2. 命中后只是**换用推理模型 + 多带上下文**，不改变任何事实性行为。
 *   3. 有图时一律让位给多模态模型（deepseek-reasoner 实测不支持图片输入，
 *      把图发给它会返回空内容 —— 这是之前踩过的坑，不能重演）。
 *   4. 判定失败 → 回落 normal，绝不打断主流程。
 *   5. 可通过配置关闭，关掉后行为与原来完全一致。
 */

const DEFAULTS = {
  enabled: true,              // 用户明确要求"长思考任务优先深度思考"，故默认开
  minChars: 4,                // 中文 4 字就能是一个完整问题，别设太大
  boostContext: true,         // 命中时按 complex 带上下文
  // 触发信号（命中任一即认为需要深度思考）
  explicit: true,             // 显式要求："深度思考""仔细想""一步步"
  reasoning: true,            // 推理型：为什么/原因是/推导/逻辑
  planning: true,             // 规划型：方案/计划/架构/怎么实现/步骤
  code: true,                 // 代码/调试型
  compare: true,              // 对比/权衡/利弊
  math: true,                 // 计算/数学
  longform: true,             // 长文/总结/详细
  // 命中后使用的模型（空 = 沿用配置里的 reasoning 模型）
  model: '',
};

// —— 信号规则：每条给出 { key, re, weight }，命中即记录 ——
const RULES = [
  { key: 'explicit', re: /(深度思考|仔细想|认真分析|好好想想|想清楚|一步步|逐步推|详细推理|深思|慎重考虑|别急着答|想明白了再)/ },
  { key: 'reasoning', re: /(为什么|怎么会|咋会|原因是|根源|本质|逻辑|推导|推理|论[证据]|凭什么|到底.*怎么|想不通|解释一下.*原理)/ },
  { key: 'planning', re: /(方案|计划|规划|架构|设计一下|怎么实现|如何实现|步骤|流程|策略|路线|安排一下|给我.*思路)/ },
  { key: 'code', re: /(代码|报错|bug|debug|异常|堆栈|重构|优化.*性能|算法|正则|函数|接口报错|编译)/ },
  { key: 'compare', re: /(对[比比]|区[别]|利弊|优缺点|该不该|值不值|要不要|哪个更|如何选|怎么选|权衡|还是.*好)/ },
  { key: 'math', re: /(计算|求解|概率|方程|公式|统计|百分比|数[学值]|怎么算|等于多少)/ },
  { key: 'longform', re: /(长文|详细|总结|综述|报告|论文|大纲|全文|展开讲|系统地讲|全面)/ },
];

// 明确不需要深度思考的（闲聊/打招呼/简单确认）。
// 只在整句很短时才算闲聊——「早」开头也有可能接一句正经问题（"早上那笔账怎么算"）。
const CHATTER_RE = /^(你好|hi|hello|在吗|在么|嗯+|哦+|哈哈+|好+|收到|谢谢|辛苦|早|晚安|bye|拜拜|owo)/i;

let getCFG = () => ({});
function setConfig(fn) { if (typeof fn === 'function') getCFG = fn; }

function cfg() {
  const c = (typeof getCFG === 'function' && getCFG()) || {};
  const s = c.deepThink || {};
  const on = (k) => s[k] !== false;   // 未配置时沿用默认 true
  return {
    enabled: s.enabled !== false,
    minChars: Number(s.minChars) > 0 ? Number(s.minChars) : DEFAULTS.minChars,
    boostContext: s.boostContext !== false,
    model: String(s.model || '').trim(),
    flags: {
      explicit: on('explicit'), reasoning: on('reasoning'), planning: on('planning'),
      code: on('code'), compare: on('compare'), math: on('math'), longform: on('longform'),
    },
  };
}

/**
 * 判定是否需要深度思考。
 * @param {string} text 用户消息（已去掉 @ 等噪声）
 * @param {object} o { hasImage?:boolean, force?:boolean }
 * @returns {{deep:boolean, reason:string, signals:string[], model:string}}
 *   reason: 'disabled' | 'too-short' | 'has-image' | 'chatter' | 'explicit' | 'reasoning' | ... | 'none'
 */
function judge(text, o) {
  o = o || {};
  const c = cfg();
  const t = String(text || '').trim();
  const empty = { deep: false, reason: 'none', signals: [], model: '' };
  if (!c.enabled && !o.force) return Object.assign(empty, { reason: 'disabled' });
  if (!t) return Object.assign(empty, { reason: 'too-short' });
  // 有图 → 必须让位给多模态模型（reasoner 不支持图片，发了会返回空）
  if (o.hasImage) return Object.assign(empty, { reason: 'has-image' });

  // 先算信号：用户**明确要求**深度思考时，不看长度（"深度思考：1+1" 也得认真想）
  const signals = [];
  for (const r of RULES) {
    if (c.flags[r.key] === false) continue;   // 该类信号被配置关掉
    if (r.re.test(t)) signals.push(r.key);
  }
  if (signals.indexOf('explicit') >= 0) {
    return { deep: true, reason: 'explicit', signals, model: c.model };
  }

  if (t.length < c.minChars) return Object.assign(empty, { reason: 'too-short' });
  if (CHATTER_RE.test(t) && t.length <= 12) return Object.assign(empty, { reason: 'chatter' });

  if (!signals.length) return Object.assign(empty, { reason: 'none' });

  return {
    deep: true,
    reason: signals[0],
    signals,
    model: c.model,
  };
}

/** 给日志/调试用的一句话说明（不输出用户原文） */
function describe(r) {
  if (!r || !r.deep) return '不需要深度思考（' + (r && r.reason) + '）';
  return '深度思考：命中 ' + r.signals.join('/');
}

module.exports = {
  DEFAULTS, RULES, CHATTER_RE,
  setConfig, cfg, judge, describe,
};
