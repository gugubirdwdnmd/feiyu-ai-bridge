'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ps = require('../src/services/priceService');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-price-')); }

test('validatePrice accepts a well-formed table', () => {
  const v = ps.validatePrice({ version: '2026-10-01', currency: 'CNY', unit: 'M', models: { 'deepseek-chat': { input: 1, output: 2, cacheHit: 0.1 } } });
  assert.strictEqual(v.valid, true);
});

test('validatePrice rejects negative / wrong unit / bad history', () => {
  assert.strictEqual(ps.validatePrice({ models: { m: { input: -1, output: 2 } } }).valid, false);
  assert.strictEqual(ps.validatePrice({ unit: 'X', models: { m: { input: 1, output: 2 } } }).valid, false);
  assert.strictEqual(ps.validatePrice({ models: { m: { input: 1, output: 2, history: [{ effectiveFrom: 'not-a-date', input: 1, output: 2 }] } } }).valid, false);
});

test('getPrice / setPrice round trip', () => {
  const d = tmp();
  const t = { version: 'v1', currency: 'CNY', unit: 'M', models: { m: { input: 1, output: 2 } } };
  assert.strictEqual(ps.setPrice(d, t).ok, true);
  assert.deepStrictEqual(ps.getPrice(d), t);
});

test('examplePrice has expected shape', () => {
  const e = ps.examplePrice();
  assert.ok(e.models['deepseek-chat'] && typeof e.models['deepseek-chat'].input === 'number');
  assert.strictEqual(e.unit, 'M');
  assert.strictEqual(e.currency, 'CNY');
});
