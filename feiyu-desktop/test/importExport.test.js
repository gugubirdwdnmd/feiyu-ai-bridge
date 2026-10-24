'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ie = require('../src/services/importExportService');
const cs = require('../src/services/configService');
const ps = require('../src/services/personalityService');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-ie-')); }

test('buildExport excludes secret by default, includes schemaVersion', () => {
  const d = tmp(); cs.writeRaw(d, { api: { model: 'm' } }); ps.write(d, 'prompt');
  const ex = ie.buildExport(d, '0.1.0');
  assert.strictEqual(ex.schemaVersion, 1); assert.strictEqual(ex.appVersion, '0.1.0');
  assert.strictEqual(ex.secret, undefined);
  assert.strictEqual(ex.config.api.model, 'm'); assert.strictEqual(ex.personality, 'prompt');
});
test('buildExport includes secret when asked', () => {
  const d = tmp(); cs.writeRaw(d, {}); fs.writeFileSync(path.join(d, 'secrets.json'), JSON.stringify({ apiKey: 'sk-x' }));
  const ex = ie.buildExport(d, '0.1.0', { includeSecret: true });
  assert.strictEqual(ex.secret.apiKey, 'sk-x');
});
test('validateImport rejects unknown top key', () => {
  const r = ie.validateImport({ schemaVersion: 1, config: {}, evil: 1 });
  assert.strictEqual(r.valid, false);
});
test('validateImport accepts valid', () => {
  const r = ie.validateImport({ schemaVersion: 1, config: { api: { model: 'm' } }, personality: 'p' });
  assert.strictEqual(r.valid, true);
});
test('validateImport rejects bad schemaVersion', () => {
  const r = ie.validateImport({ schemaVersion: 'x', config: {} });
  assert.strictEqual(r.valid, false);
});
test('applyImport writes config+personality and backs up', () => {
  const d = tmp(); cs.writeRaw(d, { api: { model: 'old' } });
  const r = ie.applyImport(d, { schemaVersion: 1, config: { api: { model: 'new' } }, personality: 'np' }, { backup: true });
  assert.strictEqual(r.ok, true); assert.ok(r.backupDir);
  assert.strictEqual(cs.readRaw(d).data.api.model, 'new');
  assert.strictEqual(ps.read(d).content, 'np');
  const bak = JSON.parse(fs.readFileSync(path.join(r.backupDir, 'ai_config.json'), 'utf-8'));
  assert.strictEqual(bak.api.model, 'old');
});
test('applyImport fails closed on invalid input (no write)', () => {
  const d = tmp(); cs.writeRaw(d, { api: { model: 'keep' } });
  const r = ie.applyImport(d, { schemaVersion: 1, config: { group: { mode: 'bad' } } }, { backup: false });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(cs.readRaw(d).data.api.model, 'keep');
});
test('diffPreview detects changed key', () => {
  const d = tmp(); cs.writeRaw(d, { api: { model: 'a' } });
  const diff = ie.diffPreview(d, { schemaVersion: 1, config: { api: { model: 'b' } } });
  assert.ok(diff.configDiff.api); assert.strictEqual(diff.configDiff.api.to.model, 'b');
});
