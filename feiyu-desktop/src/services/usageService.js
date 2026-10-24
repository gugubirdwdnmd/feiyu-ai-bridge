'use strict';
/**
 * usageService.js —— 用量查询。
 * 真实数据源（不复写采集器）：
 *   1) bot 运行时：GET http://127.0.0.1:<port>/api/usage?range=   （聚合 + 最近明细）
 *   2) 文件回退：memory/usage/YYYY-MM-DD.jsonl（逐条明细，不含聊天内容与 Key）
 *               + memory/stats.json（聚合日账）
 * 费用估算：仅当用户提供价格表时才算；无价格表 → priced:false（显示「未计价」，绝不冒充账单）。
 */
const fs = require('fs');
const path = require('path');

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
  else if (range === 'all') { /* 由调用方列出目录 */ return null; }
  return want.map((d) => d + '.jsonl');
}

function safeReadLines(file) {
  try { return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean); } catch (_) { return []; }
}

function aggregate(reqs) {
  let total = 0, prompt = 0, completion = 0, reasoning = 0, cacheHit = 0, cacheMiss = 0, judge = 0, answer = 0, tool = 0;
  const modelUsage = {};
  for (const r of reqs) {
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
  }
  return { total, prompt, completion, reasoning, cacheHit, cacheMiss, judge, answer, tool, modelUsage };
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

/** 主入口：优先实时接口，回退读文件。返回结构含 source 标记。 */
async function getUsage(botDir, range, opts = {}) {
  if (opts.livePort) {
    const live = await fetchLive(opts.livePort, range, opts.deps);
    if (live && !live.error) return { source: 'live', range, ...live };
  }
  const files = rangeFiles(range);
  const names = files || safeReadLines; // null => all
  let list;
  if (files === null) {
    list = [];
    try { list = fs.readdirSync(usageDir(botDir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)); } catch (_) {}
  } else { list = files; }
  const reqs = [];
  for (const f of list) {
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
    modelUsage: a.modelUsage, recentRequests: reqs.slice(0, 50), stats, files: list.length,
  };
}

/**
 * 费用估算。priceTable 为空或模型未知 → priced:false（显示「未计价」）。
 * 单价单位：元 / 百万 token。缓存命中按 cacheHit 单价（通常更低）。
 */
function estimateCost(record, priceTable) {
  if (!priceTable || !priceTable.models) return { priced: false, cost: null, currency: 'CNY', priceVersion: null };
  const m = (record && record.model) || 'unknown';
  const pm = priceTable.models[m];
  if (!pm) return { priced: false, cost: null, currency: 'CNY', priceVersion: priceTable.version || null };
  const prompt = Number(record.prompt_tokens) || 0;
  const completion = Number(record.completion_tokens) || 0;
  const cacheHit = Number(record.cache_hit_tokens) || 0;
  const cacheMiss = prompt - cacheHit;
  const inRate = (pm.input != null ? pm.input : 0) / 1e6;
  const outRate = (pm.output != null ? pm.output : 0) / 1e6;
  const hitRate = (pm.cacheHit != null ? pm.cacheHit : inRate) / 1e6;
  const cost = cacheMiss * inRate + cacheHit * hitRate + completion * outRate;
  return { priced: true, cost: Math.round(cost * 1e6) / 1e6, currency: 'CNY', priceVersion: priceTable.version || null };
}

module.exports = { getUsage, estimateCost, rangeFiles, aggregate, usageDir, statsPath };
