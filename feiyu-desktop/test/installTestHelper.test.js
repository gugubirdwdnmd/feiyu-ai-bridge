'use strict';
/**
 * installTestHelper.test.js —— 卸载残留目录处置策略的回归测试。
 *
 * 覆盖 V1.0 验收要求的四类场景：空目录 / 非空目录 / 权限不足 / 路径异常。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const helper = require('../build/installTestHelper');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'residual-'));
}

// ————————————————————————————————————————
// 空目录
// ————————————————————————————————————————

test('F-1: 存在且为空的目录 → 可安全清理', () => {
  const d = tmpDir();
  const r = helper.inspectResidualDir(d);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reason, 'empty');
  fs.rmSync(d, { recursive: true, force: true });
});

test('F-1: dry-run 不删除；confirm=true 才删', () => {
  const d = tmpDir();
  const dry = helper.cleanupResidualDir(d);
  assert.strictEqual(dry.ok, true);
  assert.strictEqual(dry.removed, false);
  assert.strictEqual(dry.reason, 'dry_run');
  assert.ok(fs.existsSync(d), 'dry-run 不得删除目录');

  const real = helper.cleanupResidualDir(d, { confirm: true });
  assert.strictEqual(real.ok, true);
  assert.strictEqual(real.removed, true);
  assert.strictEqual(fs.existsSync(d), false, 'confirm 后应删除空目录');
});

test('F-1: 清理后重装流程可重复执行（清完再清不报错）', () => {
  const d = tmpDir();
  const r1 = helper.cleanupResidualDir(d, { confirm: true });
  assert.strictEqual(r1.removed, true);
  const r2 = helper.cleanupResidualDir(d, { confirm: true });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'not_found', '目录已不存在应如实报告');
  assert.strictEqual(r2.removed, false);
});

// ————————————————————————————————————————
// 非空目录（用户数据保护）
// ————————————————————————————————————————

test('F-2: 非空目录 → 拒绝清理，且不删任何东西', () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'user-data.txt'), 'important');
  const r = helper.cleanupResidualDir(d, { confirm: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'not_empty');
  assert.strictEqual(r.removed, false);
  assert.ok(fs.existsSync(path.join(d, 'user-data.txt')), '用户数据必须保留');
  assert.ok(r.detail.includes('非空'));
  fs.rmSync(d, { recursive: true, force: true });
});

test('F-2: 非空目录的 preflight 给出人工确认提示', () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'x.txt'), 'x');
  const p = helper.preflightReinstall(d);
  assert.strictEqual(p.safeToClean, false);
  assert.strictEqual(p.reason, 'not_empty');
  assert.ok(p.hint.includes('人工'), '应提示人工确认');
  assert.ok(p.entries.includes('x.txt'));
  fs.rmSync(d, { recursive: true, force: true });
});

// ————————————————————————————————————————
// 权限不足
// ————————————————————————————————————————

test('F-3: 目录不可读 → fail-closed，不删除', () => {
  const fsMock = {
    readdirSync: () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; },
    rmdirSync: () => { throw new Error('不应被调用'); },
  };
  const r = helper.inspectResidualDir('C:\\some\\dir', { fsImpl: fsMock });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'not_readable');
  assert.ok(r.detail.includes('无法读取'));
});

test('F-3: readdir 抛错时 cleanupResidualDir 也不调用 rmdir', () => {
  let rmdirCalled = false;
  const fsMock = {
    readdirSync: () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; },
    rmdirSync: () => { rmdirCalled = true; },
  };
  const r = helper.cleanupResidualDir('C:\\some\\dir', { confirm: true, fsImpl: fsMock });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.removed, false);
  assert.strictEqual(rmdirCalled, false, '权限不足时绝不能调用删除');
});

test('F-3: 目录不存在 → not_found，不视为错误', () => {
  const r = helper.inspectResidualDir('C:\\definitely\\missing\\dir-' + Date.now());
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'not_found');
});

// ————————————————————————————————————————
// 路径异常与受保护目录
// ————————————————————————————————————————

test('F-4: 空路径 / 非字符串 → invalid_path', () => {
  assert.strictEqual(helper.inspectResidualDir('').reason, 'invalid_path');
  assert.strictEqual(helper.inspectResidualDir(null).reason, 'invalid_path');
  assert.strictEqual(helper.inspectResidualDir(123).reason, 'invalid_path');
  assert.strictEqual(helper.inspectResidualDir('   ').reason, 'invalid_path');
});

test('F-4: 文件系统根目录 → protected_path', () => {
  const r = helper.inspectResidualDir('C:\\');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'protected_path');
});

test('F-4: 受保护目录名（机器人目录/发布副本/安装目录）→ 拒绝清理', () => {
  for (const name of ['NapCat', 'NapCat_publish', 'feiyu', 'feiyu-desktop-control-center']) {
    const r = helper.inspectResidualDir(path.join('D:\\', name));
    assert.strictEqual(r.ok, false, name + ' 不应被自动清理');
    assert.strictEqual(r.reason, 'protected_path', name);
  }
});

test('F-4: 自定义 isProtectedDir 钩子生效', () => {
  const d = tmpDir();
  const r = helper.inspectResidualDir(d, { isProtectedDir: (p) => p === path.resolve(d) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'protected_path');
  fs.rmSync(d, { recursive: true, force: true });
});

test('F-4: 清理空目录使用的是 rmdir（不递归），不会误删子目录', () => {
  const d = tmpDir();
  const sub = path.join(d, 'sub');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'deep.txt'), 'x');
  // 父目录含子目录 → 非空 → 拒绝
  const r = helper.cleanupResidualDir(d, { confirm: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'not_empty');
  assert.ok(fs.existsSync(path.join(sub, 'deep.txt')), '深层数据必须完好');
  fs.rmSync(d, { recursive: true, force: true });
});

test('F-4: preflightReinstall 对可安装状态给出清晰提示', () => {
  const missing = helper.preflightReinstall('C:\\no\\such\\dir-' + Date.now());
  assert.strictEqual(missing.reason, 'not_found');
  assert.ok(missing.hint.includes('可直接安装'));
});
