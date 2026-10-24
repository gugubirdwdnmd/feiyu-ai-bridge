'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cs = require('../src/services/configService');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-cfg-')); }

test('readRaw missing -> exists false', () => { const d = tmp(); const r = cs.readRaw(d); assert.strictEqual(r.exists, false); assert.strictEqual(r.error, null); });
test('readRaw corrupt -> error not crash', () => {
  const d = tmp(); fs.writeFileSync(path.join(d, 'ai_config.json'), '{ bad json');
  const r = cs.readRaw(d); assert.strictEqual(r.exists, true); assert.ok(r.error);
});
test('applyConfig writes merged and reads back', () => {
  const d = tmp();
  const w = cs.applyConfig(d, { api: { model: 'deepseek-chat', baseUrl: 'https://x' } });
  assert.strictEqual(w.ok, true);
  const r = cs.readRaw(d); assert.strictEqual(r.data.api.model, 'deepseek-chat'); assert.strictEqual(r.data.api.baseUrl, 'https://x');
});
test('validateConfig rejects bad group.mode', () => {
  const d = tmp();
  const w = cs.applyConfig(d, { group: { mode: 'bogus' } });
  assert.strictEqual(w.ok, false); assert.ok(w.errors.length > 0);
});
test('deepMerge preserves unspecified fields across writes', () => {
  const d = tmp();
  cs.applyConfig(d, { api: { model: 'a' } });
  cs.applyConfig(d, { personality: { name: 'X' } });
  const r = cs.readRaw(d);
  assert.strictEqual(r.data.api.model, 'a');
  assert.strictEqual(r.data.personality.name, 'X');
});
test('writeRaw atomic round-trip', () => { const d = tmp(); const w = cs.writeRaw(d, { x: 1 }); assert.strictEqual(w.ok, true); assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(d, 'ai_config.json'), 'utf-8')), { x: 1 }); });
