'use strict';
/**
 * serviceRegistry.test.js —— 模块 B（统一服务编排）单测。
 * 覆盖：依赖环、拓扑启动顺序、端口冲突、自定义服务校验、预设计划、启动描述。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sr = require('../src/services/serviceRegistry');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-svc-')); }

test('detectCycles: 无环返回 false', () => {
  const r = sr.detectCycles([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: [] }]);
  assert.strictEqual(r.hasCycle, false);
});

test('detectCycles: 二元环被检测到（曾被 WHITE=0 假值缺陷漏报）', () => {
  const r = sr.detectCycles([{ id: 'x', dependsOn: ['y'] }, { id: 'y', dependsOn: ['x'] }]);
  assert.strictEqual(r.hasCycle, true);
  assert.deepStrictEqual(r.cycle, ['x', 'y', 'x']);
});

test('detectCycles: 三元环被检测到', () => {
  const r = sr.detectCycles([
    { id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['c'] }, { id: 'c', dependsOn: ['a'] },
  ]);
  assert.strictEqual(r.hasCycle, true);
});

test('topoOrder: 被依赖的服务排在前面（启动顺序）', () => {
  const r = sr.topoOrder([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: [] }]);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.order, ['b', 'a']);
});

test('topoOrder: 链式 a→b→c 得到 c,b,a', () => {
  const r = sr.topoOrder([
    { id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['c'] }, { id: 'c', dependsOn: [] },
  ]);
  assert.deepStrictEqual(r.order, ['c', 'b', 'a']);
});

test('topoOrder: 有环时 ok=false 并返回环', () => {
  const r = sr.topoOrder([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }]);
  assert.strictEqual(r.ok, false);
  assert.ok(Array.isArray(r.cycle));
});

test('topoOrder: 忽略指向不存在服务的依赖', () => {
  const r = sr.topoOrder([{ id: 'a', dependsOn: ['ghost'] }]);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.order, ['a']);
});

test('detectPortConflicts: 同端口多服务被报出', () => {
  const r = sr.detectPortConflicts([{ id: 'a', port: 3001 }, { id: 'b', port: 3001 }, { id: 'c', port: 3002 }]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].port, 3001);
  assert.deepStrictEqual(r[0].services, ['a', 'b']);
});

test('detectPortConflicts: 无冲突返回空数组', () => {
  assert.deepStrictEqual(sr.detectPortConflicts([{ id: 'a', port: 1 }, { id: 'b', port: 2 }]), []);
});

test('validateServiceDef: 合法定义通过', () => {
  const v = sr.validateServiceDef({ id: 'my-svc', name: '我的服务', port: 9100, command: ['node', 'x.js'] });
  assert.strictEqual(v.valid, true);
});

test('validateServiceDef: 非法 id / 端口 / command 被拒', () => {
  assert.strictEqual(sr.validateServiceDef({ id: '-bad', name: 'x' }).valid, false);
  assert.strictEqual(sr.validateServiceDef({ id: 'ok', name: 'x', port: 70000 }).valid, false);
  assert.strictEqual(sr.validateServiceDef({ id: 'ok', name: 'x', command: 'node x.js' }).valid, false);
});

test('validateServiceDef: 禁止依赖自身', () => {
  const v = sr.validateServiceDef({ id: 'a', name: 'A', dependsOn: ['a'] });
  assert.strictEqual(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes('自身')));
});

test('planPresetPure: 报告缺失服务并给出警告', () => {
  const plan = sr.planPresetPure({ id: 'p', services: ['ghost'] }, []);
  assert.strictEqual(plan.ok, true);
  assert.deepStrictEqual(plan.missing, ['ghost']);
  assert.ok(plan.warnings.some((w) => w.includes('未注册')));
});

test('planPresetPure: 端口冲突进入 warnings 且被结构化返回', () => {
  const plan = sr.planPresetPure({ id: 'p', services: ['a', 'b'] }, [{ id: 'a', port: 3001 }, { id: 'b', port: 3001 }]);
  assert.strictEqual(plan.portConflicts.length, 1);
  assert.ok(plan.warnings.some((w) => w.includes('端口冲突')));
});

test('describeStart: bridge 命令为固定 argv', () => {
  const d = sr.describeStart({ id: 'bridge', type: 'bridge' });
  assert.strictEqual(d.ok, true);
  assert.deepStrictEqual(d.command, ['ai_bridge.js']);
});

test('describeStart: napcat 无账号时不注入任何凭据环境变量', () => {
  const d = sr.describeStart({ id: 'napcat', type: 'napcat' });
  assert.deepStrictEqual(d.env, {});
});

test('describeStart: napcat 有账号时注入账号与 MD5（值来自调用方，不在本模块落盘）', () => {
  const md5 = 'a'.repeat(32);
  const d = sr.describeStart({ id: 'napcat', type: 'napcat' }, { account: '10001', passwordMd5: md5 });
  assert.strictEqual(d.env.NAPCAT_QUICK_ACCOUNT, '10001');
  assert.strictEqual(d.env.NAPCAT_QUICK_PASSWORD_MD5, md5);
});

test('describeStart: 通用服务缺少 command 时拒绝', () => {
  const d = sr.describeStart({ id: 'x', type: 'generic', command: [] });
  assert.strictEqual(d.ok, false);
});

test('createRegistry: 增删自定义服务，内置服务不可删', () => {
  const dir = tmpDir();
  try {
    const reg = sr.createRegistry({ botDir: dir });
    const add = reg.addService({ id: 'mine', name: '我的', port: 9200, command: ['node', 'a.js'] });
    assert.strictEqual(add.ok, true);
    assert.ok(reg.allServices().some((s) => s.id === 'mine'));
    assert.strictEqual(reg.removeService('mine').ok, true);
    assert.strictEqual(reg.removeService('bridge').ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('createRegistry: 重复 id 被拒', () => {
  const dir = tmpDir();
  try {
    const reg = sr.createRegistry({ botDir: dir });
    assert.strictEqual(reg.addService({ id: 'dup', name: 'A' }).ok, true);
    const second = reg.addService({ id: 'dup', name: 'B' });
    assert.strictEqual(second.ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('createRegistry: 内置预设始终存在且可生成计划', () => {
  const dir = tmpDir();
  try {
    const reg = sr.createRegistry({ botDir: dir });
    const ids = reg.presets().map((p) => p.id);
    assert.ok(ids.includes('qq-bot'));
    const plan = reg.planPreset('qq-bot');
    assert.strictEqual(plan.ok, true);
    assert.deepStrictEqual(plan.order, ['napcat', 'bridge']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('createRegistry: 未找到预设给出错误', () => {
  const dir = tmpDir();
  try {
    const reg = sr.createRegistry({ botDir: dir });
    assert.strictEqual(reg.planPreset('nope').ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
