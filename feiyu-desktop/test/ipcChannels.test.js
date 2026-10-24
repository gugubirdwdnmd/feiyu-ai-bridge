'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { CHANNELS, validate, ALLOWED_RANGE } = require('../src/services/ipcChannels');

test('validate config apply requires partial object', () => {
  assert.strictEqual(validate(CHANNELS.CONFIG_APPLY, {}).ok, false);
  assert.strictEqual(validate(CHANNELS.CONFIG_APPLY, { partial: {} }).ok, true);
});
test('validate personality write requires string content', () => {
  assert.strictEqual(validate(CHANNELS.PERSONALITY_WRITE, { content: 123 }).ok, false);
  assert.strictEqual(validate(CHANNELS.PERSONALITY_WRITE, { content: 'x' }).ok, true);
});
test('validate usage range restricted', () => {
  assert.strictEqual(validate(CHANNELS.USAGE_GET, { range: '7d' }).ok, true);
  assert.strictEqual(validate(CHANNELS.USAGE_GET, { range: 'bad' }).ok, false);
  assert.ok(ALLOWED_RANGE.includes('all'));
});
test('validate proc stop requires numeric pid array', () => {
  assert.strictEqual(validate(CHANNELS.PROC_STOP, { pids: [1, 2] }).ok, true);
  assert.strictEqual(validate(CHANNELS.PROC_STOP, { pids: 'x' }).ok, false);
});
test('validate secret write requires object', () => {
  assert.strictEqual(validate(CHANNELS.SECRET_WRITE, { data: { apiKey: 'x' } }).ok, true);
  assert.strictEqual(validate(CHANNELS.SECRET_WRITE, { data: 'x' }).ok, false);
});
test('validate rejects unknown channel', () => {
  assert.strictEqual(validate('evil-channel', {}).ok, false);
});
test('validate import apply requires object', () => {
  assert.strictEqual(validate(CHANNELS.IMPORT_APPLY, { incoming: { schemaVersion: 1 } }).ok, true);
  assert.strictEqual(validate(CHANNELS.IMPORT_APPLY, { incoming: 'x' }).ok, false);
});
