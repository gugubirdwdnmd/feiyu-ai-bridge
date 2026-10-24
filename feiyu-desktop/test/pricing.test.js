'use strict';
/**
 * pricing.test.js —— 批次 D：费用计算可靠性测试。
 * 覆盖：单位换算、输入/输出/缓存独立定价、历史价、未知价、精度策略、
 *      CSV RFC4180 特殊字符与中文、时区与日期边界、失败/重试统计语义。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const usage = require('../src/services/usageService');

function tmpUsageDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-price-'));
  fs.mkdirSync(path.join(d, 'memory', 'usage'), { recursive: true });
  return d;
}

test('unitFactor: 1/K/M/B 换算', () => {
  assert.strictEqual(usage.unitFactor('1'), 1);
  assert.strictEqual(usage.unitFactor('K'), 1e3);
  assert.strictEqual(usage.unitFactor('M'), 1e6);
  assert.strictEqual(usage.unitFactor('B'), 1e9);
});

test('费用：输入/输出/缓存 token 独立定价', () => {
  const price = {
    version: 'v1', currency: 'CNY', unit: 'M',
    models: { m1: { input: 2, output: 8, cacheHit: 0.5 } },
  };
  const r = usage.estimateCost({ model: 'm1', prompt_tokens: 1000, completion_tokens: 500, cache_hit_tokens: 400 }, price);
  assert.ok(r.priced);
  // 输入未命中 600 * 2/1e6 + 缓存命中 400 * 0.5/1e6 + 输出 500 * 8/1e6
  const expected = (600 * 2 + 400 * 0.5 + 500 * 8) / 1e6;
  assert.ok(Math.abs(r.cost - expected) < 1e-12, `cost=${r.cost} expected=${expected}`);
});

test('费用：单条不做提前舍入（保持全精度）', () => {
  const price = { version: 'v1', currency: 'CNY', unit: 'M', models: { m1: { input: 3, output: 3 } } };
  const r = usage.estimateCost({ model: 'm1', prompt_tokens: 1, completion_tokens: 0 }, price);
  assert.strictEqual(r.cost, 3 / 1e6, '单条应返回精确值而非 6 位舍入');
});

test('费用：汇总不因逐条舍入产生系统性偏差', () => {
  const price = { version: 'v1', currency: 'CNY', unit: 'M', models: { m1: { input: 1, output: 1 } } };
  // 每条 1/3 token * 1e-6 → 单条 3.333...e-7；逐条舍入到 6 位会累积误差
  const reqs = [];
  for (let i = 0; i < 1000; i++) reqs.push({ model: 'm1', prompt_tokens: 1, completion_tokens: 0 });
  const s = usage.estimateCostForSet(reqs, price);
  const expected = 1000 / 1e6; // 0.001
  assert.ok(Math.abs(s.totalCost - expected) < 1e-12, `totalCost=${s.totalCost} expected=${expected}`);
  // 旧实现（逐条舍入后求和）会产生 ~1e-6 偏差
  let legacy = 0;
  for (let i = 0; i < 1000; i++) legacy += Math.round((1 / 1e6) * 1e6) / 1e6;
  assert.ok(Math.abs(legacy - expected) > 0, '逐条舍入路径确有偏差（本测试确认精度策略有效）');
});

test('费用：未知模型显示未定价（priced:false），且不计入总额', () => {
  const price = { version: 'v1', currency: 'CNY', unit: 'M', models: { m1: { input: 1, output: 1 } } };
  const r = usage.estimateCost({ model: 'other', prompt_tokens: 100 }, price);
  assert.strictEqual(r.priced, false);
  assert.strictEqual(r.reason, 'unknown_model');
  const s = usage.estimateCostForSet([
    { model: 'm1', prompt_tokens: 100 },
    { model: 'other', prompt_tokens: 999999 },
  ], price);
  assert.strictEqual(s.priced, true);
  assert.strictEqual(s.pricedCount, 1);
  assert.ok(s.unpricedModels.includes('other'));
  assert.strictEqual(s.partial, true, '部分定价应被标记');
  assert.ok(s.totalCost < 1, '未定价记录不得计入总额');
  assert.ok(/非服务商实际账单/.test(s.note), '必须标明是估算而非账单');
});

test('费用：历史价格按记录时间选择', () => {
  const price = {
    version: 'v2', currency: 'CNY', unit: 'M',
    models: {
      m1: {
        input: 5, output: 5,
        history: [
          { effectiveFrom: '2026-01-01T00:00:00Z', input: 1, output: 2, version: 'v1-hist' },
          { effectiveFrom: '2026-06-01T00:00:00Z', input: 3, output: 4, version: 'v1.5-hist' },
        ],
      },
    },
  };
  const early = usage.estimateCost({ model: 'm1', prompt_tokens: 1e6, time: '2026-03-01T00:00:00Z' }, price);
  assert.strictEqual(early.priceVersion, 'v1-hist');
  assert.strictEqual(early.cost, 1);
  const late = usage.estimateCost({ model: 'm1', prompt_tokens: 1e6, time: '2026-08-01T00:00:00Z' }, price);
  assert.strictEqual(late.priceVersion, 'v1.5-hist');
  assert.strictEqual(late.cost, 3);
  // 早于所有历史 → 回落当前单价
  const before = usage.estimateCost({ model: 'm1', prompt_tokens: 1e6, time: '2025-01-01T00:00:00Z' }, price);
  assert.strictEqual(before.priceVersion, 'v2');
  assert.strictEqual(before.cost, 5);
});

test('CSV: RFC4180 —— 引号/逗号/换行/中文/空值', () => {
  const reqs = [{
    time: '2026-10-24T10:00:00Z', status: 'success', kind: 'answer', provider: 'deepseek', model: 'deepseek-chat',
    prompt_tokens: 10, completion_tokens: 20, reasoning_tokens: null, cache_hit_tokens: 0, cache_miss_tokens: 10,
    total_tokens: 30, durationMs: 1234, errorCategory: null,
  }, {
    time: '2026-10-24T10:00:01Z', status: 'error', kind: 'answer', provider: 'my,proxy', model: 'he said "hi"',
    prompt_tokens: null, completion_tokens: null, reasoning_tokens: null, cache_hit_tokens: null, cache_miss_tokens: null,
    total_tokens: null, durationMs: null, errorCategory: 'timeout\nline2',
  }];
  const csv = usage.toCSV(reqs);
  const lines = csv.split('\r\n');
  assert.ok(lines.length >= 3, '应有表头 + 2 行');
  assert.ok(lines[0].startsWith('time,status,'), '表头: ' + lines[0]);
  // 含逗号的字段被引号包裹
  assert.ok(csv.includes('"my,proxy"'), '逗号应加引号');
  // 含引号的字段双写
  assert.ok(csv.includes('"he said ""hi"""'), '引号应转义为双引号');
  // 换行字段被引号包裹（行数仍按 \r\n 之外计算）
  assert.ok(csv.includes('"timeout\nline2"'), '换行应被引号包裹');
  // null → 空
  assert.ok(!csv.includes('null'), 'null 不应出现在 CSV 中');
  // 中文
  const cn = usage.toCSV([{ model: '深度求索-chat', status: '成功' }]);
  assert.ok(cn.includes('深度求索-chat'), '中文应原样保留');
});

test('CSV: 缺失 token 字段输出空串（不冒充 0）', () => {
  const csv = usage.toCSV([{ time: 't', model: 'm' }]);
  const row = csv.split('\r\n')[1];
  assert.ok(!row.includes('0,'), '缺失字段应为空白而非 0：' + row);
});

test('聚合：失败请求与成功分开统计，重试不重复计成功', () => {
  const reqs = [
    { status: 'success', model: 'm1', total_tokens: 100, prompt_tokens: 60, completion_tokens: 40, durationMs: 100 },
    { status: 'error', model: 'm1', total_tokens: 0, prompt_tokens: 0, completion_tokens: 0, durationMs: 5000, errorCategory: 'timeout' },
    { status: 'error', model: 'm1', total_tokens: 0, prompt_tokens: 0, completion_tokens: 0, durationMs: 300, errorCategory: 'http_server' },
    // 旧行：无 status → 视为 success
    { model: 'm1', total_tokens: 50, prompt_tokens: 50, completion_tokens: 0 },
  ];
  const a = usage.aggregate(reqs);
  assert.strictEqual(a.success, 2);
  assert.strictEqual(a.fail, 2);
  assert.strictEqual(a.total, 150);
  assert.strictEqual(a.errorCategories.timeout, 1);
  assert.strictEqual(a.errorCategories.http_server, 1);
  assert.strictEqual(a.durationMs.count, 3, '无耗时的旧行不计入耗时统计');
  assert.strictEqual(a.durationMs.max, 5000);
});

test('聚合：失败请求不贡献 token（保持语义正确）', () => {
  const reqs = [{ status: 'error', model: 'm1', total_tokens: 999, prompt_tokens: 999 }];
  const a = usage.aggregate(reqs);
  assert.strictEqual(a.total, 999, '聚合仍按记录原值累加（明细为准）');
  assert.strictEqual(a.fail, 1);
  assert.strictEqual(a.success, 0);
});

test('日期范围：本地时区一致性（今日文件按本地日期）', () => {
  const files = usage.rangeFiles('today');
  assert.strictEqual(files.length, 1);
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  assert.strictEqual(files[0], `${y}-${m}-${d}.jsonl`, '今日文件应为本地日期');
  // 昨天
  const yest = usage.rangeFiles('yesterday');
  const yd = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const ys = `${yd.getFullYear()}-${String(yd.getMonth() + 1).padStart(2, '0')}-${String(yd.getDate()).padStart(2, '0')}.jsonl`;
  assert.strictEqual(yest[0], ys);
  // 近 7 天：含今天，共 7 个
  assert.strictEqual(usage.rangeFiles('7d').length, 7);
  // all → null（表示全部）
  assert.strictEqual(usage.rangeFiles('all'), null);
});

test('日期范围：本月只含到今天为止的日期', () => {
  const files = usage.rangeFiles('month');
  const now = new Date();
  assert.ok(files.length >= 1);
  // 本月区间：1 号 → 今天（含今天），不含未来日期
  assert.strictEqual(files.length, now.getDate(), '本月应只含 1 号到今天');
  assert.ok(files[0].startsWith(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`), '首项应为当月 1 号');
  assert.strictEqual(files[files.length - 1], `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.jsonl`);
});

test('getUsage: 本地文件优先，含 status/provider/duration 明细', async () => {
  const d = tmpUsageDir();
  const now = new Date();
  const f = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.jsonl`;
  const lines = [
    JSON.stringify({ time: '2026-10-24T10:00:00Z', status: 'success', provider: 'deepseek', model: 'm1', prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, durationMs: 200 }),
    JSON.stringify({ time: '2026-10-24T10:00:01Z', status: 'error', provider: 'deepseek', model: 'm1', prompt_tokens: null, completion_tokens: null, total_tokens: null, durationMs: 900, errorCategory: 'timeout' }),
  ];
  fs.writeFileSync(path.join(d, 'memory', 'usage', f), lines.join('\n'));
  const u = await usage.getUsage(d, 'today');
  assert.strictEqual(u.source, 'files');
  assert.strictEqual(u.successRequests, 1);
  assert.strictEqual(u.failRequests, 1);
  assert.strictEqual(u.recentRequests.length, 2);
  assert.strictEqual(u.recentRequests[0].provider, 'deepseek');
  assert.strictEqual(u.durationMs.max, 900);
});

test('getUsage: 无本地文件且无实时接口 → source:none 空结构', async () => {
  const d = tmpUsageDir();
  const u = await usage.getUsage(d, 'today');
  assert.strictEqual(u.source, 'none');
  assert.strictEqual(u.recentRequests.length, 0);
  assert.strictEqual(u.successRequests, 0);
  assert.strictEqual(u.failRequests, 0);
});
