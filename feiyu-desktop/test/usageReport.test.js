'use strict';
/* usageReport.test.js —— 机器人用量报告纯计算层（从 ai_bridge.js 抽离）的单元测试。
 * 覆盖：筛选(provider/model/status)、缺失 status 兜底、成功/失败聚合、Provider 分桶、
 * 错误类别、耗时、白名单投影(剔除未知字段/密钥)、明细分页上限、鉴权决策。 */
const test = require('node:test');
const assert = require('node:assert');
const rep = require('../../usage_report');

// 构造一组混合明细：成功/失败/历史(无status)/带伪造敏感字段
const REQS = [
  { time: '2026-01-01T10:00:00Z', kind: 'answer', model: 'deepseek-chat', provider: 'deepseek', status: 'success', prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, durationMs: 800, apiKey: 'sk-SHOULD-NOT-LEAK', fullPrompt: '机密' },
  { time: '2026-01-01T11:00:00Z', kind: 'judge', model: 'deepseek-chat', provider: 'deepseek', status: 'error', errorCategory: 'timeout', durationMs: 30000, prompt_tokens: null, completion_tokens: null, total_tokens: null },
  { time: '2026-01-02T09:00:00Z', kind: 'answer', model: 'gpt-4o', provider: 'openai', status: 'success', prompt_tokens: 200, completion_tokens: 100, total_tokens: 300, durationMs: 1200 },
  { time: '2026-01-02T10:00:00Z', kind: 'answer', model: 'deepseek-chat', provider: 'deepseek', total_tokens: 999 }, // 历史行：无 status → 视为 success
];

test('无筛选时聚合全量，成功/失败计数正确', () => {
  const r = rep.computeUsageReport(REQS, {});
  assert.strictEqual(r.requests, 4);
  assert.strictEqual(r.successRequests, 3); // 含历史无 status 行
  assert.strictEqual(r.failRequests, 1);
  assert.strictEqual(r.statusCounts.success, 3);
  assert.strictEqual(r.statusCounts.error, 1);
  assert.strictEqual(r.totalTokens, 150 + 300 + 999); // 失败行 total 为 0
  assert.deepStrictEqual(r.errorCategories, { timeout: 1 });
});

test('按 status=error 筛选只保留失败', () => {
  const r = rep.computeUsageReport(REQS, { status: 'error' });
  assert.strictEqual(r.requests, 1);
  assert.strictEqual(r.failRequests, 1);
  assert.strictEqual(r.successRequests, 0);
});

test('按 provider 筛选', () => {
  const r = rep.computeUsageReport(REQS, { provider: 'openai' });
  assert.strictEqual(r.requests, 1);
  assert.strictEqual(r.totalTokens, 300);
  assert.deepStrictEqual(r.providerUsage.openai, { calls: 1, tokens: 300, success: 1, fail: 0 });
});

test('按 model 筛选', () => {
  const r = rep.computeUsageReport(REQS, { model: 'deepseek-chat' });
  assert.strictEqual(r.requests, 3); // 两条 success(含历史) + 一条 error
});

test('耗时聚合（avg/max/count），失败行 durationMs 计入', () => {
  const r = rep.computeUsageReport(REQS, {});
  assert.strictEqual(r.durationMs.count, 3); // 历史行无 durationMs，不计入
  assert.strictEqual(r.durationMs.max, 30000);
  assert.strictEqual(r.durationMs.avg, Math.round((800 + 30000 + 1200) / 3));
});

test('白名单投影：剔除未知/敏感字段', () => {
  const r = rep.computeUsageReport(REQS, {});
  for (const d of r.detail) {
    assert.strictEqual(d.apiKey, undefined);
    assert.strictEqual(d.fullPrompt, undefined);
    assert.strictEqual(d.secret, undefined);
  }
  // detail 第一条（时间最新）为历史 deepseek 行（无 status 字段 → 投影后 status 为 undefined，聚合时按 success 兜底）
  const first = r.detail[0];
  assert.strictEqual(first.time, '2026-01-02T10:00:00Z');
  assert.strictEqual(first.apiKey, undefined);
  assert.strictEqual(first.fullPrompt, undefined);
  // 失败行仍在 detail 中，且 status='error'、无敏感字段
  const errLine = r.detail.find((d) => d.errorCategory === 'timeout');
  assert.ok(errLine);
  assert.strictEqual(errLine.status, 'error');
  assert.strictEqual(errLine.apiKey, undefined);
});

test('detail 按时间倒序且受 limit 限制', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ time: '2026-01-01T00:' + String(i).padStart(2, '0') + ':00Z', model: 'm', provider: 'p', status: 'success', total_tokens: 1 }));
  const r = rep.computeUsageReport(many, { limit: 10 });
  assert.strictEqual(r.detail.length, 10);
  assert.strictEqual(r.detail[0].time, '2026-01-01T00:49:00Z'); // 最新
});

test('limit 超过封顶被截断到 MAX_LIMIT', () => {
  const many = Array.from({ length: 5000 }, (_, i) => ({ time: '2026-01-01T00:00:' + String(i).padStart(2, '0') + 'Z', status: 'success' }));
  const r = rep.computeUsageReport(many, { limit: 999999 });
  assert.strictEqual(r.detail.length, rep.MAX_LIMIT);
});

test('鉴权：默认回环信任放行', () => {
  assert.strictEqual(rep.usageEndpointAllowed({}, { requireAuth: false, token: 'x' }), true);
  assert.strictEqual(rep.usageEndpointAllowed({ authorization: 'Bearer wrong' }, { requireAuth: false, token: 'x' }), true);
});

test('鉴权：要求鉴权但无 token → fail-closed 拒绝', () => {
  assert.strictEqual(rep.usageEndpointAllowed({}, { requireAuth: true, token: '' }), false);
  assert.strictEqual(rep.usageEndpointAllowed({}, { requireAuth: true, token: null }), false);
});

test('鉴权：token 校验', () => {
  assert.strictEqual(rep.usageEndpointAllowed({ authorization: 'Bearer abc' }, { requireAuth: true, token: 'abc' }), true);
  assert.strictEqual(rep.usageEndpointAllowed({ authorization: 'Bearer xyz' }, { requireAuth: true, token: 'abc' }), false);
  assert.strictEqual(rep.usageEndpointAllowed({}, { requireAuth: true, token: 'abc' }), false);
});
