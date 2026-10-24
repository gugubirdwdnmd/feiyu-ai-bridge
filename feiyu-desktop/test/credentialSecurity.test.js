'use strict';
/**
 * credentialSecurity.test.js —— 批次 C：凭据安全加固测试。
 *
 * 全部使用临时目录 + 假 codec（不依赖 Electron / safeStorage / 真实密钥）。
 * 覆盖：
 *  - codec 注入后的加解密往返
 *  - 旧明文文件仍可读（向后兼容）
 *  - 迁移：备份 → 加密写入 → 回读校验 → 幂等
 *  - 加密后磁盘上不含明文
 *  - 加密库不可解密时禁止写入（防止覆盖丢密钥）
 *  - 无主密钥清理（dry-run / confirm）
 *  - IPC 校验：SECRET_WRITE 字段白名单
 *  - 内网 Base URL 标记
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const providerService = require('../src/services/providerService');
const { validate, CHANNELS } = require('../src/services/ipcChannels');

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-cred-'));
  return d;
}
/** 可逆的假 codec（base64，非真实加密，仅验证加密态读写路径）。 */
function fakeCodec() {
  return {
    encrypt: (s) => Buffer.from(String(s), 'utf-8').toString('base64'),
    decrypt: (c) => Buffer.from(String(c), 'base64').toString('utf-8'),
  };
}
function resetCodec() { providerService.setCodec(null); }

test('providerService: codec 注入与加解密往返', () => {
  const d = tmpDir();
  resetCodec();
  providerService.setCodec(fakeCodec());
  try {
    const r = providerService.save(d, { name: 'P1', baseUrl: 'https://x.test/v1/chat/completions', model: 'm1', key: 'sk-testkey-1234567890' });
    assert.ok(r.ok, JSON.stringify(r));
    const raw = fs.readFileSync(providerService.secretsPath(d), 'utf-8');
    assert.ok(!raw.includes('sk-testkey'), '加密文件不得包含明文密钥');
    assert.ok(raw.includes('__encrypted'), '应标记为加密格式');
    const sec = providerService.loadSecrets(d);
    assert.strictEqual(sec[r.id], 'sk-testkey-1234567890');
  } finally { resetCodec(); }
});

test('providerService: 旧明文文件仍可读（向后兼容，不强制迁移）', () => {
  const d = tmpDir();
  resetCodec();
  const p = { id: 'legacy1' };
  fs.writeFileSync(providerService.secretsPath(d), JSON.stringify({ legacy1: 'sk-plain-legacy' }, null, 2));
  providerService.setCodec(fakeCodec());
  try {
    const r = providerService.readSecrets(d);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.encrypted, false);
    assert.strictEqual(r.data.legacy1, 'sk-plain-legacy');
  } finally { resetCodec(); }
});

test('providerService: 迁移到加密态 —— 备份 + 回读校验 + 幂等', () => {
  const d = tmpDir();
  resetCodec();
  fs.writeFileSync(providerService.secretsPath(d), JSON.stringify({ a: 'sk-a-key', b: 'sk-b-key' }, null, 2));
  providerService.setCodec(fakeCodec());
  try {
    const r = providerService.migrateSecretsToEncrypted(d);
    assert.strictEqual(r.migrated, true, JSON.stringify(r));
    assert.strictEqual(r.verified, true);
    assert.ok(r.backupDir && fs.existsSync(r.backupDir), '应生成备份目录');
    const bk = JSON.parse(fs.readFileSync(path.join(r.backupDir, 'feiyu_provider_secrets.json'), 'utf-8'));
    assert.strictEqual(bk.a, 'sk-a-key', '备份应保留明文原值');
    const after = providerService.readSecrets(d);
    assert.strictEqual(after.encrypted, true);
    assert.strictEqual(after.data.a, 'sk-a-key');
    assert.strictEqual(after.data.b, 'sk-b-key');
    // 幂等
    const r2 = providerService.migrateSecretsToEncrypted(d);
    assert.strictEqual(r2.migrated, false);
    assert.strictEqual(r2.reason, 'already_encrypted');
  } finally { resetCodec(); }
});

test('providerService: 加密库不可解密时拒绝写入（不丢其它 Provider 密钥）', () => {
  const d = tmpDir();
  resetCodec();
  providerService.setCodec(fakeCodec());
  const s = providerService.save(d, { name: 'P', baseUrl: 'https://x.test/v1/chat/completions', model: 'm', key: 'sk-secret-1' });
  assert.ok(s.ok);
  // 模拟「换了机器 / 系统凭据不可用」：清掉 codec
  resetCodec();
  const st = providerService.readSecrets(d);
  assert.strictEqual(st.encrypted, true);
  assert.strictEqual(st.ok, false);
  const w = providerService.save(d, { id: s.id, name: 'P2' });
  assert.strictEqual(w.ok, false, '不可解密时必须拒绝写入');
  assert.ok(/解密/.test(w.errors.join('')), '错误信息应说明原因');
  // 磁盘内容未被破坏（仍为密文，且原密钥条目仍在）
  const raw = JSON.parse(fs.readFileSync(providerService.secretsPath(d), 'utf-8'));
  assert.ok(raw.__encrypted);
  assert.ok(Object.prototype.hasOwnProperty.call(raw.data, s.id), '不应丢失原密钥条目');
});

test('providerService: 无主密钥清理（dry-run 与确认删除）', () => {
  const d = tmpDir();
  resetCodec();
  const s = providerService.save(d, { name: 'P', baseUrl: 'https://x.test/v1/chat/completions', model: 'm', key: 'sk-orphan-test' });
  assert.ok(s.ok);
  // 模拟历史残留：注册表里没有该 id，但密钥库里有（明文文件形态）
  const sp = providerService.secretsPath(d);
  const cur = JSON.parse(fs.readFileSync(sp, 'utf-8'));
  cur.ghost = 'sk-ghost-key';
  fs.writeFileSync(sp, JSON.stringify(cur, null, 2));

  const dry = providerService.pruneOrphanSecrets(d);
  assert.strictEqual(dry.ok, true);
  assert.strictEqual(dry.dryRun, true);
  assert.ok(dry.orphans.includes('ghost'));
  assert.ok(providerService.loadSecrets(d).ghost, 'dry-run 不应删除');

  const real = providerService.pruneOrphanSecrets(d, { confirm: true });
  assert.strictEqual(real.ok, true);
  assert.ok(real.pruned.includes('ghost'));
  assert.strictEqual(providerService.loadSecrets(d).ghost, undefined, '确认后应删除孤儿密钥');
});

test('providerService: 删除 Provider 时密钥一并删除（不留孤儿）', () => {
  const d = tmpDir();
  resetCodec();
  const s = providerService.save(d, { name: 'P', baseUrl: 'https://x.test/v1/chat/completions', model: 'm', key: 'sk-del-test' });
  assert.ok(s.ok);
  const r = providerService.remove(d, s.id);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(providerService.loadSecrets(d)[s.id], undefined);
});

test('ipcChannels: SECRET_WRITE 仅允许白名单字段', () => {
  const ok = validate(CHANNELS.SECRET_WRITE, { data: { apiKey: 'x', onebotToken: 'y' } });
  assert.strictEqual(ok.ok, true);
  const bad = validate(CHANNELS.SECRET_WRITE, { data: { evilKey: 'x' } });
  assert.strictEqual(bad.ok, false);
  const bad2 = validate(CHANNELS.SECRET_WRITE, { data: 'not-object' });
  assert.strictEqual(bad2.ok, false);
});

test('providerService: 内网 Base URL 被标记（自定义地址滥用提示）', () => {
  assert.strictEqual(providerService.isPrivateUrl('http://127.0.0.1:8080/v1/chat/completions'), true);
  assert.strictEqual(providerService.isPrivateUrl('http://192.168.1.10/v1'), true);
  assert.strictEqual(providerService.isPrivateUrl('http://10.0.0.5/v1'), true);
  assert.strictEqual(providerService.isPrivateUrl('http://172.20.1.2/v1'), true);
  assert.strictEqual(providerService.isPrivateUrl('https://api.deepseek.com/v1'), false);
  assert.strictEqual(providerService.isPrivateUrl('not-a-url'), false);
});
