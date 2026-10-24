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
test('validate provider list/delete/setDefault/apply require id string', () => {
  for (const ch of [CHANNELS.PROVIDER_LIST, CHANNELS.PROVIDER_DELETE, CHANNELS.PROVIDER_SET_DEFAULT, CHANNELS.PROVIDER_APPLY]) {
    assert.strictEqual(validate(ch, { id: 'p1' }).ok, true);
    assert.strictEqual(validate(ch, {}).ok, false);
    assert.strictEqual(validate(ch, { id: 5 }).ok, false);
  }
});
test('validate provider save requires provider object', () => {
  assert.strictEqual(validate(CHANNELS.PROVIDER_SAVE, { provider: { name: 'x', baseUrl: 'https://a/v1/chat/completions', model: 'm' } }).ok, true);
  assert.strictEqual(validate(CHANNELS.PROVIDER_SAVE, { id: 'p1' }).ok, false);
  assert.strictEqual(validate(CHANNELS.PROVIDER_SAVE, {}).ok, false);
});
test('validate provider test requires id or provider', () => {
  assert.strictEqual(validate(CHANNELS.PROVIDER_TEST, { id: 'p1' }).ok, true);
  assert.strictEqual(validate(CHANNELS.PROVIDER_TEST, { provider: { baseUrl: 'https://a', model: 'm' } }).ok, true);
  assert.strictEqual(validate(CHANNELS.PROVIDER_TEST, {}).ok, false);
});
test('validate skill list/templates/export accept no args', () => {
  for (const ch of [CHANNELS.SKILL_LIST, CHANNELS.SKILL_TEMPLATES, CHANNELS.SKILL_EXPORT]) {
    assert.strictEqual(validate(ch, undefined).ok, true, ch);
    assert.strictEqual(validate(ch, {}).ok, true, ch);
  }
});
test('validate skill save requires skill object', () => {
  assert.strictEqual(validate(CHANNELS.SKILL_SAVE, { skill: { name: 'x' } }).ok, true);
  assert.strictEqual(validate(CHANNELS.SKILL_SAVE, { skill: { id: 5 } }).ok, false);
  assert.strictEqual(validate(CHANNELS.SKILL_SAVE, {}).ok, false);
});
test('validate skill delete/copy require id string', () => {
  for (const ch of [CHANNELS.SKILL_DELETE, CHANNELS.SKILL_COPY]) {
    assert.strictEqual(validate(ch, { id: 's1' }).ok, true);
    assert.strictEqual(validate(ch, {}).ok, false);
    assert.strictEqual(validate(ch, { id: 5 }).ok, false);
  }
});
test('validate skill setEnabled requires boolean enabled', () => {
  assert.strictEqual(validate(CHANNELS.SKILL_SET_ENABLED, { id: 's1', enabled: true }).ok, true);
  assert.strictEqual(validate(CHANNELS.SKILL_SET_ENABLED, { id: 's1', enabled: 'yes' }).ok, false);
  assert.strictEqual(validate(CHANNELS.SKILL_SET_ENABLED, { id: 's1' }).ok, false);
});
test('validate skill importTemplate requires key string', () => {
  assert.strictEqual(validate(CHANNELS.SKILL_IMPORT_TEMPLATE, { key: 'draw_helper' }).ok, true);
  assert.strictEqual(validate(CHANNELS.SKILL_IMPORT_TEMPLATE, {}).ok, false);
});
test('validate skill import requires payload object', () => {
  assert.strictEqual(validate(CHANNELS.SKILL_IMPORT, { payload: { skills: [] } }).ok, true);
  assert.strictEqual(validate(CHANNELS.SKILL_IMPORT, {}).ok, false);
});
test('validate comfy detect/status/workflows/release/pickDir accept no args', () => {
  for (const ch of [CHANNELS.COMFY_DETECT, CHANNELS.COMFY_STATUS, CHANNELS.COMFY_WORKFLOWS, CHANNELS.COMFY_RELEASE, CHANNELS.COMFY_PICKDIR]) {
    assert.strictEqual(validate(ch, undefined).ok, true, ch);
    assert.strictEqual(validate(ch, {}).ok, true, ch);
  }
});
test('validate comfy release restricts variant whitelist', () => {
  assert.strictEqual(validate(CHANNELS.COMFY_RELEASE, { variant: 'nvidia' }).ok, true);
  assert.strictEqual(validate(CHANNELS.COMFY_RELEASE, { variant: 'amd' }).ok, true);
  assert.strictEqual(validate(CHANNELS.COMFY_RELEASE, { variant: 'evil' }).ok, false);
});
test('validate comfy prereq rejects non-string dir/endpoint', () => {
  assert.strictEqual(validate(CHANNELS.COMFY_PREREQ, { dir: 'D:/ComfyUI' }).ok, true);
  assert.strictEqual(validate(CHANNELS.COMFY_PREREQ, { dir: 5 }).ok, false);
  assert.strictEqual(validate(CHANNELS.COMFY_PREREQ, { endpoint: 5 }).ok, false);
});
test('validate comfy downloadModel requires key string', () => {
  assert.strictEqual(validate(CHANNELS.COMFY_DOWNLOAD_MODEL, { key: 'unet' }).ok, true);
  assert.strictEqual(validate(CHANNELS.COMFY_DOWNLOAD_MODEL, {}).ok, false);
  assert.strictEqual(validate(CHANNELS.COMFY_DOWNLOAD_MODEL, { key: 'unet', dir: 5 }).ok, false);
});
test('validate comfy install requires dir and restricts variant', () => {
  assert.strictEqual(validate(CHANNELS.COMFY_INSTALL, { dir: 'D:/ComfyUI' }).ok, true);
  assert.strictEqual(validate(CHANNELS.COMFY_INSTALL, { dir: 'D:/ComfyUI', variant: 'intel' }).ok, true);
  assert.strictEqual(validate(CHANNELS.COMFY_INSTALL, {}).ok, false);
  assert.strictEqual(validate(CHANNELS.COMFY_INSTALL, { dir: '  ' }).ok, false);
  assert.strictEqual(validate(CHANNELS.COMFY_INSTALL, { dir: 'D:/x', variant: 'evil' }).ok, false);
});
