'use strict';
/**
 * themeMonFx.test.js —— 主题新增字段（状态动画 monFx / 鼠标视差 mouseParallax）校验。
 */
const test = require('node:test');
const assert = require('node:assert');
const ts = require('../src/services/themeService');

const BASE = { bg: '#0b1d2a', a: '#ff8a5c', b: '#4fd1c5' };

test('默认主题：monFx=breathe / mouseParallax=true', () => {
  assert.strictEqual(ts.DEFAULT_THEME.monFx, 'breathe');
  assert.strictEqual(ts.DEFAULT_THEME.mouseParallax, true);
});

test('validateTheme 接受合法 monFx 与 mouseParallax', () => {
  const v = ts.validateTheme(Object.assign({}, BASE, { monFx: 'flow', mouseParallax: false }));
  assert.strictEqual(v.valid, true);
  assert.strictEqual(v.theme.monFx, 'flow');
  assert.strictEqual(v.theme.mouseParallax, false);
});

test('validateTheme 拒绝非法 monFx', () => {
  const v = ts.validateTheme(Object.assign({}, BASE, { monFx: 'wobble' }));
  assert.strictEqual(v.valid, false);
  assert.ok(v.errors.some((e) => /monFx/.test(e)));
});

test('旧主题缺少新字段时回退默认值（向后兼容）', () => {
  const v = ts.validateTheme(Object.assign({}, BASE));
  assert.strictEqual(v.valid, true);
  assert.strictEqual(v.theme.monFx, 'breathe');
  assert.strictEqual(v.theme.mouseParallax, true);
});

test('monFx 覆盖全部合法枚举', () => {
  for (const fx of ts.MON_FX_VALUES) {
    const v = ts.validateTheme(Object.assign({}, BASE, { monFx: fx }));
    assert.strictEqual(v.valid, true, 'monFx=' + fx + ' 应合法');
    assert.strictEqual(v.theme.monFx, fx);
  }
});
