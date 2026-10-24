'use strict';
/**
 * usageService.js —— 用量查询与费用估算。
 * 真实数据源（不复写采集器）：
 *   1) bot 运行时：GET http://127.0.0.1:<port>/api/usage?range=   （聚合 + 最近明细）
 *   2) 文件回退：memory/usage/YYYY-MM-DD.jsonl（逐条明细，不含聊天内容与 Key）
 *               + memory/stats.json（聚合日账）
 * 费用估算：仅当用户提供价格表时才算；无价格表 → priced:false（显示「未计价」，绝不冒充账单）。
 *
 * Phase B 增强：
 *   - 明细支持 status（success/error）、provider、durationMs、errorCategory（旧行缺失时按兜底）。
 *   - 聚合新增 success/fail 计数、provider 分桶、错误类别分布、耗时统计。
 *   - estimateCost 支持历史价格规则（按记录时间套用生效版本）。
 *   - 新增 toCSV（RFC4180，正确处理逗号/引号/换行等特殊字符）。
 */
const fs = require('fs');
const path = require('path');

const DETAIL_CAP = 2000; // 明细上限，避免极端历史占内存；筛选/CSV 基于此集合

function usageDir(botDir) { return path.join(botDir, 'memory', 'usage'); }
function statsPath(botDir) { return path.join(botDir, 'memory', 'stats.json'); }
function fmtDate(d) { return d.toISOString().slice(0, 10); }

function rangeFiles(range) {
  const today = new Date();
  const want = [];
  if (range === 'today') want.push(fmtDate(today));
  else if (range === 'yesterday') { const y = new Date(today); y.setDate(y.getDate() - 1); want.push(fmtDate(y)); }
  else if (range === '7d') { for (let i = 0; i < 7; i++) { const d = new Date(today); d.setDate(d.getDate() - i); want.push(fmtDate(d)); } }
  else if (range === 'month') { const y = today.getFullYear(), m = today.getMonth(); const days = new Date(y, m + 1, 0).getDate(); for (let d = 1; d <= days; d++) { const dt = new Date(y, m, d); if (dt <= today) want.push(fmtDate(dt)); } }
  else if (range === 'all') { return null; }
  return want.map((d) => d + '.jsonl');
}

function safeReadLines(file) {
  try { return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean); } catch (_) { return []; }
}

function unitFactor(unit) {
  if (unit === 'K' || unit === 'k') return 1e3;
  if (unit === 'B' || unit === 'b') return 1e9;
  if (unit === '1') return 1;
  return 1e6; // 默认每百万 token（'M'）
}

function aggregate(reqs) {
  let total = 0, prompt = 0, completion = 0, reasoning = 0, cacheHit = 0, cacheMiss = 0, judge = 0, answer = 0, tool = 0;
  let success = 0, fail = 0;
  let durSum = 0, durMax = 0, durCount = 0;
  const modelUsage = {}, providerUsage = {}, errorCategories = {};
  for (const r of reqs) {
    // 旧行无 status 字段 → 视为 success（向后兼容）
    const status = r.status || 'success';
    if (status === 'error') {
      fail++;
      const ec = r.errorCategory || 'unknown';
      errorCategories[ec] = (errorCategories[ec] || 0) + 1;
    } else {
      success++;
    }
    const t = Number(r.total_tokens) || 0;
    const p = Number(r.prompt_tokens) || 0;
    const c = Number(r.completion_tokens) || 0;
    const rt = Number(r.reasoning_tokens) || 0;
    const ch = Number(r.cache_hit_tokens) || 0;
    const cm = Number(r.cache_miss_tokens) || 0;
    total += t; prompt += p; completion += c; reasoning += rt; cacheHit += ch; cacheMiss += cm;
    if (r.kind === 'judge') judge++; else if (r.kind === 'tool') tool++; else answer++;
    const m = r.model || 'unknown';
    if (!modelUsage[m]) modelUsage[m] = { calls: 0, tokens: 0 };
    modelUsage[m].calls++; modelUsage[m].tokens += t;
    const prov = r.provider || 'unknown';
    if (!providerUsage[prov]) providerUsage[prov] = { calls: 0, tokens: 0, success: 0, fail: 0 };
    providerUsage[prov].calls++; providerUsage[prov].tokens += t;
    if (status === 'error') providerUsage[prov].fail++; else providerUsage[prov].success++;
    const dm = Number(r.durationMs);
    if (Number.isFinite(dm) && dm >= 0) { durSum += dm; if (dm > durMax) durMax = dm; durCount++; }
  }
  return {
    total, prompt, completion, reasoning, cacheHit, cacheMiss, judge, answer, tool,
    success, fail, providerUsage, errorCategories,
    durationMs: { avg: durCount ? Math.round(durSum / durCount) : null, max: durCount ? durMax : null, count: durCount },
    modelUsage,
  };
}

async function fetchLive(port, range, deps) {
  const fetchFn = (deps && deps.fetch) || globalThis.fetch;
  if (!fetchFn || !port) return null;
  try {
    const ctrl = (deps && deps.AbortSignal && deps.AbortSignal.timeout) ? deps.AbortSignal.timeout(3000) : undefined;
    const r = await fetchFn(`http://127.0.0.1:${port}/api/usage?range=${encodeURIComponent(range)}`, ctrl ? { signal: ctrl } : {});
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
}

/** 选择适用于某记录时间的价格规则（支持历史价格变化）。 */
function selectPriceRule(pm, timeISO, fallbackVersion) {
  if (Array.isArray(pm.history) && pm.history.length) {
    const t = timeISO ? Date.parse(timeISO) : NaN;
    const candidates = pm.history
      .filter((h) => h && h.effectiveFrom && (!Number.isNaN(t) ? Date.parse(h.effectiveFrom) <= t : true))
      .sort((a, b) => Date.parse(a.effectiveFrom) - Date.parse(b.effectiveFrom));
    if (candidates.length) {
      const h = candidates[candidates.length - 1];
      return { input: h.input, output: h.output, cacheHit: h.cacheHit != null ? h.cacheHit : h.input, version: h.version || fallbackVersion, effectiveFrom: h.effectiveFrom };
    }
  }
  return { input: pm.input, output: pm.output, cacheHit: pm.cacheHit != null ? pm.cacheHit : pm.input, version: fallbackVersion, effectiveFrom: null };
}

/**
 * 费用估算。priceTable 为空 / 模型未知 → priced:false（显示「未计价/未定价」，绝不冒充账单）。
 * 单价单位：元 / 计量单位（默认每百万 token，由 price.unit 决定）。
 * 缓存命中按 cacheHit 单价（通常更低）；缓存未命中 = 输入 - 命中。
 * 历史价格：按记录 time 套用生效版本；无适用历史版本则回落当前单价（在报告里标注）。
 */
function estimateCost(record, price) {
  const currency = (price && price.currency) || 'CNY';
  const unit = (price && price.unit) || 'M';
  if (!price || !price.models) return { priced: false, cost: null, currency, unit, priceVersion: null, reason: 'no_price_table' };
  const m = (record && record.model) || 'unknown';
  const pm = price.models[m];
  if (!pm) return { priced: false, cost: null, currency, unit, priceVersion: price.version || null, reason: 'unknown_model' };
  const rule = selectPriceRule(pm, record && record.time, price.version || null);
  const f = unitFactor(unit);
  const inRate = (rule.input != null ? rule.input : 0) / f;
  const outRate = (rule.output != null ? rule.output : 0) / f;
  const hitRate = (rule.cacheHit != null ? rule.cacheHit : (rule.input != null ? rule.input : 0)) / f;
  const prompt = Number(record.prompt_tokens) || 0;
  const completion = Number(record.completion_tokens) || 0;
  const cacheHit = Number(record.cache_hit_tokens) || 0;
  const cacheMiss = Math.max(0, prompt - cacheHit);
  const cost = cacheMiss * inRate + cacheHit * hitRate + completion * outRate;
  return {
    priced: true,
    cost: Math.round(cost * 1e6) / 1e6,
    currency, unit,
    priceVersion: rule.version || price.version || null,
    effectiveFrom: rule.effectiveFrom || null,
  };
}

/** 对一组记录做费用汇总（估算，非实际账单）。 */
function estimateCostForSet(reqs, price) {
  if (!price || !price.models) return { priced: false, totalCost: null, currency: (price && price.currency) || 'CNY', unit: (price && price.unit) || 'M', priceVersion: null, reason: 'no_price_table' };
  let totalCost = 0, anyPriced = false, pricedCount = 0;
  for (const r of reqs) {
    const c = estimateCost(r, price);
    if (c.priced) { totalCost += c.cost; anyPriced = true; pricedCount++; }
  }
  return {
    priced: anyPriced,
    totalCost: anyPriced ? Math.round(totalCost * 1e6) / 1e6 : null,
    currency: price.currency || 'CNY',
    unit: price.unit || 'M',
    priceVersion: price.version || null,
    pricedCount,
    note: '估算值，非服务商实际账单',
  };
}

/** 导出用量明细为 CSV（RFC4180：含逗号/引号/换行的字段加引号，引号转义为双引号）。 */
function toCSV(reqs, opts) {
  opts = opts || {};
  const cols = [
    { key: 'time', label: 'time' },
    { key: 'status', label: 'status' },
    { key: 'kind', label: 'kind' },
    { key: 'provider', label: 'provider' },
    { key: 'model', label: 'model' },
    { key: 'prompt_tokens', label: 'prompt_tokens' },
    { key: 'completion_tokens', label: 'completion_tokens' },
    { key: 'reasoning_tokens', label: 'reasoning_tokens' },
    { key: 'cache_hit_tokens', label: 'cache_hit_tokens' },
    { key: 'cache_miss_tokens', label: 'cache_miss_tokens' },
    { key: 'total_tokens', label: 'total_tokens' },
    { key: 'durationMs', label: 'duration_ms' },
    { key: 'errorCategory', label: 'error_category' },
  ];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const rows = [cols.map((c) => c.label).join(',')];
  for (const r of reqs) rows.push(cols.map((c) => esc(r[c.key])).join(','));
  return rows.join('\r\n');
}

/** 主入口：优先读取本地 JSONL（含完整 status/provider/duration 明细，由机器人实时追加，数据最全最准），
 *  无本地文件时回退机器人实时 /api/usage（仅含其既有聚合，无新明细字段）。返回结构含 source 标记。 */
async function getUsage(botDir, range, opts = {}) {
  let fileList;
  if (range === 'all') {
    try { fileList = fs.readdirSync(usageDir(botDir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)); } catch (_) { fileList = []; }
  } else {
    fileList = (rangeFiles(range) || []).filter((f) => { try { return fs.existsSync(path.join(usageDir(botDir), f)); } catch (_) { return false; } });
  }
  if (fileList.length) {
    const reqs = [];
    for (const f of fileList) {
      for (const l of safeReadLines(path.join(usageDir(botDir), f))) {
        try { const o = JSON.parse(l); if (o && typeof o === 'object') reqs.push(o); } catch (_) {}
      }
    }
    reqs.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
    const a = aggregate(reqs);
    let stats = null;
    try { stats = JSON.parse(fs.readFileSync(statsPath(botDir), 'utf-8')); } catch (_) {}
    return {
      source: 'files', range,
      totalTokens: a.total, promptTokens: a.prompt, completionTokens: a.completion,
      reasoningTokens: a.reasoning, cacheHitTokens: a.cacheHit, cacheMissTokens: a.cacheMiss,
      judgeRequests: a.judge, answerRequests: a.answer, toolExecutions: a.tool,
      successRequests: a.success, failRequests: a.fail,
      providerUsage: a.providerUsage, errorCategories: a.errorCategories, durationMs: a.durationMs,
      modelUsage: a.modelUsage, recentRequests: reqs.slice(0, DETAIL_CAP), stats, files: fileList.length,
    };
  }
  // 无本地文件 → 回退实时接口
  if (opts.livePort) {
    const live = await fetchLive(opts.livePort, range, opts.deps);
    if (live && !live.error) {
      const out = { source: 'live', range, ...live };
      if (Array.isArray(out.recentRequests)) out.recentRequests = out.recentRequests.slice(0, DETAIL_CAP);
      return out;
    }
  }
  return {
    source: 'none', range,
    totalTokens: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0,
    cacheHitTokens: 0, cacheMissTokens: 0, judgeRequests: 0, answerRequests: 0, toolExecutions: 0,
    successRequests: 0, failRequests: 0, providerUsage: {}, errorCategories: {},
    durationMs: { avg: null, max: null, count: 0 }, modelUsage: {}, recentRequests: [], stats: null, files: 0,
  };
}

module.exports = {
  getUsage, estimateCost, estimateCostForSet, aggregate, toCSV, rangeFiles,
  usageDir, statsPath, unitFactor, selectPriceRule, DETAIL_CAP,
};
