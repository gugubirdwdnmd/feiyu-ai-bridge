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
