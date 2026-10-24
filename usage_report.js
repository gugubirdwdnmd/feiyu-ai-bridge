'use strict';
/**
 * usage_report.js —— 用量报告「纯计算」层（从 ai_bridge.js 抽离，便于独立测试与复用）。
 *
 * 设计原则：
 *  - 纯函数、无文件 I/O、无网络、无全局副作用，可直接 require 做单元测试。
 *  - 向后兼容：返回对象保留 ai_bridge 旧 /api/usage 的全部字段（totalTokens / promptTokens /
 *    completionTokens / requests / judgeRequests / modelUsage / recentRequests …）。
 *  - 在旧字段之外，新增向后兼容的可选明细：
 *      · detail          —— 经筛选 + 白名单投影的请求明细数组（不含 Key / 提示词 / 聊天正文）
 *      · successRequests / failRequests / statusCounts
 *      · providerUsage / errorCategories / durationMs / modelUsage（带 success/fail）
 *  - 白名单投影（DETAIL_FIELDS）确保即使 JSONL 意外混入未知字段也会被剔除，杜绝隐私泄漏。
 *  - 筛选只使用后端数据确实支持的字段（provider / model / status），缺失字段按兜底语义处理。
 *  - 响应上限：detail 受 limit 控制（默认 DEFAULT_LIMIT，封顶 MAX_LIMIT），避免大历史拖垮内存/响应。
 *
 * 鉴权决策（usageEndpointAllowed）亦放此处，便于对「接口权限」做纯函数测试。
 */

// detail 白名单：仅这些字段可出现在对外用量明细中（防御性投影，杜绝 Key/提示词/正文外泄）
const DETAIL_FIELDS = [
  'time', 'kind', 'model', 'provider', 'durationMs', 'status', 'errorCategory',
  'prompt_tokens', 'completion_tokens', 'reasoning_tokens',
  'cache_hit_tokens', 'cache_miss_tokens', 'total_tokens', 'chatId', 'chatRecordId',
];
const DETAIL_CAP = 2000;          // 明细硬上限（与桌面侧一致）
const DEFAULT_LIMIT = 200;        // 单页默认条数
const MAX_LIMIT = 2000;           // 单页封顶

function clampLimit(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(x), MAX_LIMIT);
}

/** 按白名单投影单条明细（剔除一切未知字段）。 */
function projectDetail(r) {
  const o = {};
  for (const k of DETAIL_FIELDS) {
    if (r && Object.prototype.hasOwnProperty.call(r, k)) o[k] = r[k];
  }
  return o;
}

/**
 * 纯计算：根据已解析的请求数组 + 筛选/分页选项，产出完整报告（不含 stats / chatRecords / budget，由调用方补）。
 * @param {Array} reqs    memory/usage/<date>.jsonl 解析后的对象数组
 * @param {Object} opts   { range, provider, model, status, limit }
 */
function computeUsageReport(reqs, opts) {
  opts = opts || {};
  const provider = opts.provider ? String(opts.provider) : '';
  const model = opts.model ? String(opts.model) : '';
  const status = opts.status ? String(opts.status) : '';
  const limit = clampLimit(opts.limit);

  // —— 筛选（仅后端确实支持的字段；缺失 status 视为 success，兼容历史数据）——
  const filtered = (reqs || []).filter((r) => {
    if (provider && (r.provider || 'unknown') !== provider) return false;
    if (model && (r.model || 'unknown') !== model) return false;
    if (status) {
      const s = r.status || 'success'; // 历史行无 status → 视为 success
      if (status === 'error') { if (s !== 'error') return false; }
      else if (s !== status) return false; // 其它（如 success）只保留匹配
    }
    return true;
  });

  // —— 聚合 ——
  let total = 0, prompt = 0, completion = 0, reasoning = 0, cacheHit = 0, cacheMiss = 0;
  let judge = 0, answer = 0, tool = 0, chatrecord = 0, chatRecordTokens = 0;
  let success = 0, fail = 0;
  let durSum = 0, durMax = 0, durCount = 0;
  const modelUsage = {}, providerUsage = {}, errorCategories = {};
  const statusCounts = { success: 0, error: 0 };
  for (const r of filtered) {
    const s = r.status || 'success';
    if (s === 'error') { fail++; statusCounts.error++; const ec = r.errorCategory || 'unknown'; errorCategories[ec] = (errorCategories[ec] || 0) + 1; }
    else { success++; statusCounts.success++; }
    total += Number(r.total_tokens) || 0;
    prompt += Number(r.prompt_tokens) || 0;
    completion += Number(r.completion_tokens) || 0;
    reasoning += Number(r.reasoning_tokens) || 0;
    cacheHit += Number(r.cache_hit_tokens) || 0;
    cacheMiss += Number(r.cache_miss_tokens) || 0;
    if (r.kind === 'judge') judge++;
    else if (r.kind === 'tool') tool++;
    else if (r.kind === 'chatrecord') { chatrecord++; chatRecordTokens += Number(r.total_tokens) || 0; }
    else answer++;
    const m = r.model || 'unknown';
    if (!modelUsage[m]) modelUsage[m] = { calls: 0, tokens: 0 };
    modelUsage[m].calls++; modelUsage[m].tokens += Number(r.total_tokens) || 0;
    const prov = r.provider || 'unknown';
    if (!providerUsage[prov]) providerUsage[prov] = { calls: 0, tokens: 0, success: 0, fail: 0 };
    providerUsage[prov].calls++; providerUsage[prov].tokens += Number(r.total_tokens) || 0;
    if (s === 'error') providerUsage[prov].fail++; else providerUsage[prov].success++;
    const dm = Number(r.durationMs);
    if (Number.isFinite(dm) && dm >= 0) { durSum += dm; if (dm > durMax) durMax = dm; durCount++; }
  }

  // —— detail：筛选后按时间倒序、白名单投影、分页 ——
  const detail = filtered
    .slice()
    .sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')))
    .slice(0, limit)
    .map(projectDetail);

  return {
    totalTokens: total, promptTokens: prompt, completionTokens: completion, reasoningTokens: reasoning,
    cacheHitTokens: cacheHit, cacheMissTokens: cacheMiss,
    cacheRate: (cacheHit + cacheMiss) > 0 ? Math.round((cacheHit / (cacheHit + cacheMiss)) * 100) : 0,
    requests: filtered.length, judgeRequests: judge, answerRequests: answer, toolRequests: tool,
    chatRecordRequests: chatrecord, chatRecordTokens,
    avg: filtered.length ? Math.round(total / filtered.length) : 0,
    successRequests: success, failRequests: fail, statusCounts,
    modelUsage, providerUsage, errorCategories,
    durationMs: { avg: durCount ? Math.round(durSum / durCount) : null, max: durCount ? durMax : null, count: durCount },
    // 旧字段 recentRequests 仍返回「最近 50 条（未筛选）」以保持旧客户端兼容；新客户端请用 detail
    detail,
  };
}

/**
 * 用量接口鉴权决策（纯函数）。
 *  - requireAuth=false（默认，依赖 127.0.0.1 回环信任）→ 一律放行。
 *  - requireAuth=true 但本机未加载 token → fail-closed 拒绝（返回 false）。
 *  - 否则校验 Authorization: Bearer <token>。
 */
function usageEndpointAllowed(headers, { requireAuth, token } = {}) {
  if (!requireAuth) return true;
  if (!token) return false; // 要求鉴权却无凭据可校验：绝不静默放行
  const auth = (headers && (headers.authorization || headers.Authorization)) || '';
  return auth === 'Bearer ' + token;
}

module.exports = {
  DETAIL_FIELDS, DETAIL_CAP, DEFAULT_LIMIT, MAX_LIMIT, clampLimit, projectDetail,
  computeUsageReport, usageEndpointAllowed,
};
