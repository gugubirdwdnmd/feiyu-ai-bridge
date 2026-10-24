'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const us = require('../src/services/usageService');

test('aggregate sums tokens and model usage', () => {
  const a = us.aggregate([{ total_tokens: 10, prompt_tokens: 6, completion_tokens: 4, cache_hit_tokens: 2, cache_miss_tokens: 4, kind: 'answer', model: 'm' }, { total_tokens: 5, prompt_tokens: 3, completion_tokens: 2, kind: 'judge', model: 'm' }]);
  assert.strictEqual(a.total, 15); assert.strictEqual(a.answer, 1); assert.strictEqual(a.judge, 1);
  assert.strictEqual(a.modelUsage.m.tokens, 15); assert.strictEqual(a.modelUsage.m.calls, 2);
});
test('estimateCost no price -> not priced', () => {
  const c = us.estimateCost({ model: 'm', prompt_tokens: 1000, completion_tokens: 500, cache_hit_tokens: 100 }, null);
  assert.strictEqual(c.priced, false); assert.strictEqual(c.cost, null);
});
test('estimateCost with price table', () => {
  const price = { version: 'v1', models: { m: { input: 1, output: 2, cacheHit: 0.1 } } };
  const c = us.estimateCost({ model: 'm', prompt_tokens: 1000000, completion_tokens: 1000000, cache_hit_tokens: 100000 }, price);
  assert.strictEqual(c.priced, true);
  // (900000*1 + 100000*0.1 + 1000000*2)/1e6 = 2.91
  assert.ok(Math.abs(c.cost - 2.91) < 1e-6);
});
test('estimateCost unknown model -> not priced', () => {
  const c = us.estimateCost({ model: 'other', prompt_tokens: 10, completion_tokens: 10, cache_hit_tokens: 0 }, { version: 'v1', models: { m: { input: 1, output: 2 } } });
  assert.strictEqual(c.priced, false);
});
test('getUsage file fallback reads jsonl (real data source)', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-us-'));
  fs.mkdirSync(path.join(d, 'memory', 'usage'), { recursive: true });
  fs.writeFileSync(path.join(d, 'memory', 'usage', '2026-10-16.jsonl'),
    JSON.stringify({ time: '2026-10-16T10:00:00Z', kind: 'answer', model: 'm', prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 0, cache_hit_tokens: 10, cache_miss_tokens: 90, total_tokens: 150 }) + '\n');
  const r = await us.getUsage(d, 'all');
  assert.strictEqual(r.source, 'files');
  assert.strictEqual(r.totalTokens, 150);
  assert.strictEqual(r.recentRequests.length, 1);
  assert.strictEqual(r.recentRequests[0].model, 'm');
});
test('getUsage no data -> zeros not fabricated', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-us-'));
  const r = await us.getUsage(d, 'today');
  assert.strictEqual(r.totalTokens, 0); assert.strictEqual(r.recentRequests.length, 0);
});

test('aggregate counts success/fail, groups by provider, duration stats', () => {
  const a = us.aggregate([
    { time: 't1', status: 'success', kind: 'answer', model: 'm', prompt_tokens: 10, completion_tokens: 5, provider: 'deepseek', durationMs: 100 },
    { time: 't2', status: 'error', kind: 'answer', model: 'm', provider: 'deepseek', errorCategory: 'timeout', durationMs: 30000 },
    { time: 't3', kind: 'answer', model: 'm', prompt_tokens: 1, completion_tokens: 1, provider: 'openai' }, // 无 status → 视为 success（向后兼容）
  ]);
  assert.strictEqual(a.success, 2);
  assert.strictEqual(a.fail, 1);
  assert.strictEqual(a.providerUsage.deepseek.calls, 2);
  assert.strictEqual(a.providerUsage.deepseek.fail, 1);
  assert.strictEqual(a.providerUsage.openai.calls, 1);
  assert.strictEqual(a.errorCategories.timeout, 1);
  assert.strictEqual(a.durationMs.avg, Math.round((100 + 30000) / 2));
  assert.strictEqual(a.durationMs.count, 2); // 第三条无 durationMs
});

test('getUsage file: success/fail tallied from status; missing tokens stay null (not fabricated)', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-us-'));
  fs.mkdirSync(path.join(d, 'memory', 'usage'), { recursive: true });
  const f = path.join(d, 'memory', 'usage', '2026-10-17.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ time: '2026-10-17T10:00:00Z', status: 'success', kind: 'answer', model: 'm', prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }),
    JSON.stringify({ time: '2026-10-17T10:01:00Z', status: 'error', kind: 'answer', model: 'm', provider: 'deepseek', errorCategory: 'http_server' }),
    JSON.stringify({ time: '2026-10-17T10:02:00Z', status: 'success', kind: 'answer', model: 'm' }), // 无 token 字段
  ].join('\n') + '\n');
  const r = await us.getUsage(d, 'all');
  assert.strictEqual(r.successRequests, 2);
  assert.strictEqual(r.failRequests, 1);
  const noTok = r.recentRequests.find((x) => x.prompt_tokens == null);
  assert.ok(noTok, '缺失 token 字段应保留为 null');
  assert.strictEqual(r.totalTokens, 150); // 未把缺失行补成 0 以外的值
});

test('estimateCost: different models use different prices', () => {
  const price = { version: 'v', models: { a: { input: 1, output: 2 }, b: { input: 10, output: 20 } } };
  const ca = us.estimateCost({ model: 'a', prompt_tokens: 1000000, completion_tokens: 1000000 }, price);
  const cb = us.estimateCost({ model: 'b', prompt_tokens: 1000000, completion_tokens: 1000000 }, price);
  assert.ok(Math.abs(ca.cost - 3) < 1e-6);
  assert.ok(Math.abs(cb.cost - 30) < 1e-6);
});

test('estimateCost: historical price rule chosen by record time', () => {
  const price = {
    version: 'cur', currency: 'CNY', unit: 'M',
    models: { m: { input: 1, output: 2, history: [
      { effectiveFrom: '2026-01-01', version: 'old', input: 5, output: 10 },
      { effectiveFrom: '2026-06-01', version: 'new', input: 2, output: 4 },
    ] } },
  };
  const recOld = { model: 'm', time: '2026-03-15T00:00:00Z', prompt_tokens: 1000000, completion_tokens: 1000000 };
  const recNew = { model: 'm', time: '2026-07-15T00:00:00Z', prompt_tokens: 1000000, completion_tokens: 1000000 };
  const cOld = us.estimateCost(recOld, price);
  const cNew = us.estimateCost(recNew, price);
  assert.strictEqual(cOld.priceVersion, 'old');
  assert.ok(Math.abs(cOld.cost - 15) < 1e-6); // (5+10)
  assert.strictEqual(cNew.priceVersion, 'new');
  assert.ok(Math.abs(cNew.cost - 6) < 1e-6); // (2+4)
});

test('estimateCostForSet: priced only when price table present; marks estimate not bill', () => {
  const reqs = [{ model: 'm', prompt_tokens: 100, completion_tokens: 50 }, { model: 'other', prompt_tokens: 1, completion_tokens: 1 }];
  const price = { version: 'v', models: { m: { input: 1, output: 2 } } };
  const s = us.estimateCostForSet(reqs, price);
  assert.strictEqual(s.priced, true);
  assert.strictEqual(s.pricedCount, 1);
  assert.ok(s.note.includes('估算'));
  assert.strictEqual(us.estimateCostForSet(reqs, null).priced, false);
});

test('toCSV escapes commas, quotes and newlines (RFC4180)', () => {
  const csv = us.toCSV([{ time: '2026-01-01', status: 'success', kind: 'a,b', provider: 'p"x', model: 'm\nl', prompt_tokens: 1, completion_tokens: 2, reasoning_tokens: 0, cache_hit_tokens: 0, cache_miss_tokens: 1, total_tokens: 3, durationMs: 5, errorCategory: '' }]);
  assert.ok(csv.includes('"a,b"'), '含逗号的字段应加引号');
  assert.ok(csv.includes('"p""x"'), '含引号的字段应转义为双引号');
  assert.ok(csv.includes('"m\nl"'), '含换行的字段应加引号');
});
