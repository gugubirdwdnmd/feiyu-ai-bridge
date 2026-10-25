'use strict';
/**
 * workflowService.test.js —— 模块 H（可视化自动化工作流）单测。
 * 重点：真正的保存/加载/执行、DAG 校验、受限条件解析（不 eval）、预算保护。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const wf = require('../src/services/workflowService');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-wf-')); }

function baseFlow(extraNodes, extraEdges) {
  return {
    id: 'f1', name: '流程',
    nodes: [
      { id: 's', type: 'start' },
      { id: 'e', type: 'end' },
    ].concat(extraNodes || []),
    edges: [{ from: 's', to: 'e' }].concat(extraEdges || []),
  };
}

test('validateWorkflow: 最小合法流程通过', () => {
  const v = wf.validateWorkflow(baseFlow());
  assert.strictEqual(v.valid, true, JSON.stringify(v.errors));
});

test('validateWorkflow: 缺少 start / end 被拒', () => {
  const v = wf.validateWorkflow({ id: 'x', name: 'x', nodes: [{ id: 'a', type: 'log' }], edges: [] });
  assert.strictEqual(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes('start')));
  assert.ok(v.errors.some((e) => e.includes('end')));
});

test('validateWorkflow: 未知节点类型被拒', () => {
  const v = wf.validateWorkflow({
    id: 'x', name: 'x',
    nodes: [{ id: 's', type: 'start' }, { id: 'z', type: 'evil' }, { id: 'e', type: 'end' }],
    edges: [],
  });
  assert.strictEqual(v.valid, false);
});

test('validateWorkflow: 环被拒', () => {
  const v = wf.validateWorkflow({
    id: 'x', name: 'x',
    nodes: [{ id: 's', type: 'start' }, { id: 'a', type: 'log' }, { id: 'e', type: 'end' }],
    edges: [{ from: 's', to: 'a' }, { from: 'a', to: 'a' }],
  });
  assert.strictEqual(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes('环')));
});

test('validateWorkflow: 边指向不存在的节点被拒', () => {
  const v = wf.validateWorkflow({
    id: 'x', name: 'x',
    nodes: [{ id: 's', type: 'start' }, { id: 'e', type: 'end' }],
    edges: [{ from: 's', to: 'ghost' }],
  });
  assert.strictEqual(v.valid, false);
});

test('validateWorkflow: if 节点缺 expr 被拒', () => {
  const v = wf.validateWorkflow(baseFlow([{ id: 'c', type: 'if', params: {} }]));
  assert.strictEqual(v.valid, false);
});

test('validateWorkflow: delay 超上限被拒', () => {
  const v = wf.validateWorkflow(baseFlow([{ id: 'd', type: 'delay', params: { ms: 999999 } }]));
  assert.strictEqual(v.valid, false);
});

test('validateWorkflow: 不可达节点给出警告但不阻断', () => {
  const v = wf.validateWorkflow(baseFlow([{ id: 'orphan', type: 'log', params: { message: 'x' } }]));
  assert.strictEqual(v.valid, true);
  assert.ok(v.warnings.some((w) => w.includes('不可达')));
});

test('validateWorkflow: 非 if 节点多条无条件出边被拒（否则会被静默忽略）', () => {
  const v = wf.validateWorkflow({
    id: 'x', name: 'x',
    nodes: [{ id: 's', type: 'start' }, { id: 'a', type: 'log' }, { id: 'e', type: 'end' }],
    edges: [{ from: 's', to: 'a' }, { from: 's', to: 'e' }],
  });
  assert.strictEqual(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes('无条件出边')));
});

test('validateWorkflow: if 节点出边未标注 when 被拒', () => {
  const v = wf.validateWorkflow({
    id: 'x', name: 'x',
    nodes: [{ id: 's', type: 'start' }, { id: 'c', type: 'if', params: { expr: 'a > 1' } }, { id: 'e', type: 'end' }],
    edges: [{ from: 's', to: 'c' }, { from: 'c', to: 'e' }],
  });
  assert.strictEqual(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes('when')));
});

test('evalCondition: 数值比较', () => {
  assert.strictEqual(wf.evalCondition('n > 2', { n: 3 }).value, true);
  assert.strictEqual(wf.evalCondition('n > 2', { n: 1 }).value, false);
  assert.strictEqual(wf.evalCondition('n == 3', { n: 3 }).value, true);
  assert.strictEqual(wf.evalCondition('n != 3', { n: 3 }).value, false);
});

test('evalCondition: 字符串与 contains', () => {
  assert.strictEqual(wf.evalCondition('s == "ok"', { s: 'ok' }).value, true);
  assert.strictEqual(wf.evalCondition('s contains ell', { s: 'hello' }).value, true);
});

test('evalCondition: 非法语法返回错误而不是抛异常', () => {
  const r = wf.evalCondition('this is not valid', {});
  assert.strictEqual(r.ok, false);
});

test('evalCondition: 不执行任意代码（注入 attempt 只会解析失败或按字符串比较）', () => {
  const r = wf.evalCondition('constructor == "x"', {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value, false);
});

test('interpolate: 替换 {{var}}，缺失变量为空串', () => {
  assert.strictEqual(wf.interpolate('hi {{n}}', { n: 3 }), 'hi 3');
  assert.strictEqual(wf.interpolate('hi {{missing}}', {}), 'hi ');
});

test('runWorkflow: 默认 dryRun，if 分支按条件选择路径', async () => {
  const flow = {
    id: 'f2', name: '分支',
    nodes: [
      { id: 's', type: 'start' },
      { id: 'set', type: 'setVar', params: { name: 'n', value: '3' } },
      { id: 'c', type: 'if', params: { expr: 'n > 2' } },
      { id: 'yes', type: 'log', params: { message: 'yes {{n}}' } },
      { id: 'no', type: 'log', params: { message: 'no' } },
      { id: 'e', type: 'end' },
    ],
    edges: [
      { from: 's', to: 'set' }, { from: 'set', to: 'c' },
      { from: 'c', to: 'yes', when: true }, { from: 'c', to: 'no', when: false },
      { from: 'yes', to: 'e' }, { from: 'no', to: 'e' },
    ],
  };
  const r = await wf.runWorkflow(flow, { dryRun: true });
  assert.strictEqual(r.ok, true);
  const ids = r.trace.map((t) => t.nodeId);
  assert.ok(ids.includes('yes'));
  assert.ok(!ids.includes('no'));
  assert.strictEqual(r.vars.n, '3');
});

test('runWorkflow: end 节点只被记录一次', async () => {
  const r = await wf.runWorkflow(baseFlow(), { dryRun: true });
  assert.strictEqual(r.trace.filter((t) => t.nodeId === 'e').length, 1);
});

test('runWorkflow: notify 在 dryRun 下不触发 sink，真执行时触发', async () => {
  const flow = {
    id: 'f3', name: '通知',
    nodes: [{ id: 's', type: 'start' }, { id: 'n', type: 'notify', params: { title: 'T', message: 'M' } }, { id: 'e', type: 'end' }],
    edges: [{ from: 's', to: 'n' }, { from: 'n', to: 'e' }],
  };
  let hits = 0;
  await wf.runWorkflow(flow, { dryRun: true, onNotify: () => { hits++; } });
  assert.strictEqual(hits, 0);
  await wf.runWorkflow(flow, { dryRun: false, onNotify: () => { hits++; } });
  assert.strictEqual(hits, 1);
});

test('runWorkflow: delay 在 dryRun 下不真正等待', async () => {
  const flow = {
    id: 'f4', name: '延时',
    nodes: [{ id: 's', type: 'start' }, { id: 'd', type: 'delay', params: { ms: 4000 } }, { id: 'e', type: 'end' }],
    edges: [{ from: 's', to: 'd' }, { from: 'd', to: 'e' }],
  };
  const t0 = Date.now();
  const r = await wf.runWorkflow(flow, { dryRun: true, sleep: () => { throw new Error('不应被调用'); } });
  assert.strictEqual(r.ok, true);
  assert.ok(Date.now() - t0 < 1000);
});

test('runWorkflow: 步数超预算中止', async () => {
  const r = await wf.runWorkflow(baseFlow(), { dryRun: true, budget: { maxSteps: 1 } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stopped, 'max_steps');
});

test('runWorkflow: serviceCall 引用未注册服务被拒', async () => {
  const flow = {
    id: 'f5', name: '服务',
    nodes: [{ id: 's', type: 'start' }, { id: 'sc', type: 'serviceCall', params: { serviceId: 'ghost' } }, { id: 'e', type: 'end' }],
    edges: [{ from: 's', to: 'sc' }, { from: 'sc', to: 'e' }],
  };
  const r = await wf.runWorkflow(flow, { dryRun: true, listServices: () => ['bridge'] });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('未注册'));
});

test('runWorkflow: serviceCall 引用已注册服务在 dryRun 下通过', async () => {
  const flow = {
    id: 'f6', name: '服务2',
    nodes: [{ id: 's', type: 'start' }, { id: 'sc', type: 'serviceCall', params: { serviceId: 'bridge' } }, { id: 'e', type: 'end' }],
    edges: [{ from: 's', to: 'sc' }, { from: 'sc', to: 'e' }],
  };
  const r = await wf.runWorkflow(flow, { dryRun: true, listServices: () => ['bridge'] });
  assert.strictEqual(r.ok, true);
});

test('save/get/list/remove: 真正的持久化往返', () => {
  const dir = tmpDir();
  try {
    const flow = {
      id: 'f1', name: '流程',
      nodes: [{ id: 's', type: 'start' }, { id: 'l', type: 'log', params: { message: 'hi' } }, { id: 'e', type: 'end' }],
      edges: [{ from: 's', to: 'l' }, { from: 'l', to: 'e' }],
    };
    const s = wf.save(dir, flow);
    assert.strictEqual(s.ok, true);
    const list = wf.list(dir);
    assert.strictEqual(list.workflows.length, 1);
    assert.strictEqual(list.workflows[0].id, 'f1');
    const g = wf.get(dir, 'f1');
    assert.strictEqual(g.ok, true);
    assert.strictEqual(g.workflow.nodes.length, 3);
    assert.strictEqual(wf.remove(dir, 'f1').ok, true);
    assert.strictEqual(wf.list(dir).workflows.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('save: 非法工作流不落盘', () => {
  const dir = tmpDir();
  try {
    const r = wf.save(dir, { id: 'bad id!', name: '', nodes: [], edges: [] });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(wf.list(dir).workflows.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
