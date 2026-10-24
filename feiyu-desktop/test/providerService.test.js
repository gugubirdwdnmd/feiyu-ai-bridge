'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const prov = require('../src/services/providerService');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-prov-')); }

function mockFetch(resolver) {
  return async (url, opts) => resolver(url, opts);
}

test('save creates provider (incomplete without key), key stored separately', () => {
  const d = tmp();
  const r = prov.save(d, { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' });
  assert.strictEqual(r.ok, true);
  // 注册表明文不含密钥
  const reg = JSON.parse(fs.readFileSync(prov.providersPath(d), 'utf-8'));
  assert.strictEqual(reg.providers[0].hasKey, false);
  assert.ok(!('key' in reg.providers[0]) && !('apiKey' in reg.providers[0]));
  assert.strictEqual(r.complete, false);
  // 补密钥
  const r2 = prov.save(d, { id: r.id, key: 'sk-SECRET1234567890ABC' });
  assert.strictEqual(r2.ok, true);
  const sec = JSON.parse(fs.readFileSync(prov.secretsPath(d), 'utf-8'));
  assert.strictEqual(sec[r.id], 'sk-SECRET1234567890ABC');
  const reread = prov.list(d).providers[0];
  assert.strictEqual(reread.hasKey, true);
  assert.strictEqual(reread.complete, true);
});

test('validateProvider rejects bad baseUrl / missing model', () => {
  assert.strictEqual(prov.validateProvider({ name: 'x', baseUrl: 'ftp://bad', model: 'm' }).valid, false);
  assert.strictEqual(prov.validateProvider({ name: 'x', baseUrl: 'https://a/v1/chat/completions' }).valid, false);
  assert.strictEqual(prov.validateProvider({ name: 'x', baseUrl: 'https://a/v1/chat/completions', model: 'm' }).valid, true);
});

test('delete removes provider + secret and clears default', () => {
  const d = tmp();
  const r = prov.save(d, { name: 'A', baseUrl: 'https://a/v1/chat/completions', model: 'm', key: 'sk-SEC1234567890ABCD' });
  assert.strictEqual(prov.setDefault(d, r.id).ok, true);
  const del = prov.remove(d, r.id);
  assert.strictEqual(del.ok, true);
  assert.strictEqual(del.default, null);
  const sec = JSON.parse(fs.readFileSync(prov.secretsPath(d), 'utf-8'));
  assert.ok(!(r.id in sec));
  assert.strictEqual(prov.list(d).providers.length, 0);
});

test('setDefault switches default provider', () => {
  const d = tmp();
  const a = prov.save(d, { name: 'A', baseUrl: 'https://a/v1/chat/completions', model: 'm' });
  const b = prov.save(d, { name: 'B', baseUrl: 'https://b/v1/chat/completions', model: 'm' });
  assert.strictEqual(prov.setDefault(d, b.id).default, b.id);
});

test('migrateFromConfig seeds a default provider, idempotent', () => {
  const d = tmp();
  const cfg = { api: { baseUrl: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat', reasoningModel: 'deepseek-reasoner' } };
  const secrets = { apiKey: 'sk-SEED1234567890ABCD' };
  const m1 = prov.migrateFromConfig(d, cfg, secrets);
  assert.strictEqual(m1.ok, true);
  assert.strictEqual(m1.migrated, true);
  const lst = prov.list(d);
  assert.strictEqual(lst.providers.length, 1);
  assert.strictEqual(lst.default, lst.providers[0].id);
  assert.strictEqual(lst.providers[0].hasKey, true);
  // 第二次不应覆盖
  const m2 = prov.migrateFromConfig(d, cfg, secrets);
  assert.strictEqual(m2.migrated, false);
  assert.strictEqual(prov.list(d).providers.length, 1);
});

test('applyPatch writes existing single-provider config slots (reuses bot request system)', () => {
  const d = tmp();
  const r = prov.save(d, { name: 'A', baseUrl: 'https://a/v1/chat/completions', model: 'm-a', reasoningModel: 'm-r', key: 'sk-APPLY1234567890AB' });
  const patch = prov.applyPatch(d, r.id);
  assert.strictEqual(patch.ok, true);
  assert.strictEqual(patch.config.api.baseUrl, 'https://a/v1/chat/completions');
  assert.strictEqual(patch.config.api.model, 'm-a');
  assert.strictEqual(patch.secret.apiKey, 'sk-APPLY1234567890AB');
  // 无密钥则拒绝（不静默应用）
  const d2 = tmp();
  const r2 = prov.save(d2, { name: 'B', baseUrl: 'https://b/v1/chat/completions', model: 'm' });
  assert.strictEqual(prov.applyPatch(d2, r2.id).ok, false);
});

test('testConnection verifies protocol behavior, not just reachability', async () => {
  // 1) 协议可用：models 列表 + choices[].message.content
  const okFetch = mockFetch((url) => {
    if (url.endsWith('/models')) return { ok: true, json: async () => ({ data: [{ id: 'm1' }] }) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'hi' } }] }) };
  });
  const r1 = await prov.testConnection({ baseUrl: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' }, { fetch: okFetch, apiKey: 'sk-KEY1234567890ABC' });
  assert.strictEqual(r1.protocolOk, true);
  assert.strictEqual(r1.reachable, true);
  assert.strictEqual(r1.ok, true);
  assert.deepStrictEqual(r1.modelList, ['m1']);
  assert.strictEqual(r1.costWarning, true);

  // 2) 可达但非 OpenAI 兼容（无 choices）→ 不标记为可用
  const badFetch = mockFetch((url) => {
    if (url.endsWith('/models')) return { ok: true, json: async () => ({}) };
    return { ok: true, json: async () => ({ error: { message: 'unsupported' } }) };
  });
  const r2 = await prov.testConnection({ baseUrl: 'https://x/v1/chat/completions', model: 'm' }, { fetch: badFetch, apiKey: 'sk-KEY1234567890ABC' });
  assert.strictEqual(r2.reachable, true);
  assert.strictEqual(r2.protocolOk, false);
  assert.strictEqual(r2.ok, false);

  // 3) 网络错误 → 不可达
  const netFetch = mockFetch(() => { throw new Error('connect ECONNREFUSED'); });
  const r3 = await prov.testConnection({ baseUrl: 'https://x/v1/chat/completions', model: 'm' }, { fetch: netFetch, apiKey: 'sk-KEY1234567890ABC' });
  assert.strictEqual(r3.reachable, false);
  assert.strictEqual(r3.protocolOk, false);
  assert.ok(r3.error);
});

test('testConnection redacts any key leaked in API error response', async () => {
  const leakFetch = mockFetch((url) => {
    if (url.endsWith('/models')) return { ok: true, json: async () => ({}) };
    return { ok: false, text: async () => 'auth failed for sk-LEAK1234567890ABC' };
  });
  const r = await prov.testConnection({ baseUrl: 'https://x/v1/chat/completions', model: 'm' }, { fetch: leakFetch, apiKey: 'sk-LEAK1234567890ABC' });
  assert.ok(r.error, '应有错误信息');
  assert.ok(!r.error.includes('sk-LEAK1234567890ABC'), '错误中不应泄露明文密钥');
});
