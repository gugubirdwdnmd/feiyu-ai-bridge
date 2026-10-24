'use strict';
/**
 * acceptance.test.js —— 发布候选验收测试（10 项关键路径）。
 *
 * 全部使用临时目录 + 模拟密钥，绝不触碰真实配置/真实凭据。
 * 覆盖验收清单：
 *  1. 凭据加密库无法解密时，所有写操作是否安全阻断
 *  2. 凭据迁移的备份/写入/回读校验/失败回滚
 *  3. 删除 Provider 后孤儿密钥清理是否误删其他 Provider 密钥
 *  4. Provider 切换失败时配置与凭据能否恢复原状
 *  5. 人格应用失败时原人格是否保持不变
 *  6. 费用单位换算 / 历史价格 / 部分未定价
 *  7. /api/usage 鉴权、字段白名单、分页限制、旧响应兼容
 *  8. 打包后定位机器人目录 + 找不到时的错误提示
 *  9. 安装/升级/卸载的数据保留策略
 * 10. 敏感字段是否进入普通日志 / 导出文件 / 诊断信息
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const providerService = require('../src/services/providerService');
const providerApplyService = require('../src/services/providerApplyService');
const personalityTemplateService = require('../src/services/personalityTemplateService');
const usageService = require('../src/services/usageService');
const priceService = require('../src/services/priceService');
const importExportService = require('../src/services/importExportService');
const logService = require('../src/services/logService');
const redact = require('../src/services/redact');
const botDirResolver = require('../src/services/botDirResolver');
const usageReport = require('../../usage_report');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-acc-'));
}
function fakeCodec() {
  return {
    encrypt: (s) => Buffer.from(String(s), 'utf-8').toString('base64'),
    decrypt: (c) => Buffer.from(String(c), 'base64').toString('utf-8'),
  };
}
function resetCodec() { providerService.setCodec(null); }

/* ================= 1. 加密库不可解密 → 写操作全部阻断 ================= */

test('验收1: 加密库不可解密时，所有写路径均被阻断且磁盘数据完好', () => {
  const d = tmpDir();
  resetCodec();
  const s = providerService.save(d, { name: 'A', baseUrl: 'https://a.test/v1/chat/completions', model: 'm1', key: 'sk-aaa-111111' });
  const s2 = providerService.save(d, { name: 'B', baseUrl: 'https://b.test/v1/chat/completions', model: 'm2', key: 'sk-bbb-222222' });
  assert.ok(s.ok && s2.ok);
  const before = fs.readFileSync(providerService.secretsPath(d), 'utf-8');

  // 切到加密态，然后模拟「换机器 / 系统凭据不可用」
  providerService.setCodec(fakeCodec());
  const mig = providerService.migrateSecretsToEncrypted(d);
  assert.strictEqual(mig.migrated, true);
  const encryptedRaw = fs.readFileSync(providerService.secretsPath(d), 'utf-8');
  resetCodec(); // codec 失效

  const st = providerService.readSecrets(d);
  assert.strictEqual(st.encrypted, true);
  assert.strictEqual(st.ok, false, '应报告无法解密');

  // 逐一验证所有写路径被阻断
  const blocked = [];
  const rSave = providerService.save(d, { id: s.id, name: 'A2' });
  if (!rSave.ok) blocked.push('save');
  const rRemove = providerService.remove(d, s2.id);
  if (!rRemove.ok) blocked.push('remove');
  const rApply = providerService.applyPatch(d, s.id);
  if (!rApply.ok) blocked.push('applyPatch');
  const rPrune = providerService.pruneOrphanSecrets(d, { confirm: true });
  if (!rPrune.ok) blocked.push('pruneOrphanSecrets');
  const rMigrate = providerService.migrateFromConfig(d, { api: { baseUrl: 'https://c.test/v1', model: 'm3' } }, { apiKey: 'x' });
  if (!rMigrate.ok || !rMigrate.migrated) blocked.push('migrateFromConfig');

  assert.deepStrictEqual(blocked.sort(), ['applyPatch', 'migrateFromConfig', 'pruneOrphanSecrets', 'remove', 'save'].sort(),
    '全部写路径都应被阻断，实际: ' + JSON.stringify(blocked));

  // 关键：磁盘上的密文数据一个字节都没变
  assert.strictEqual(fs.readFileSync(providerService.secretsPath(d), 'utf-8'), encryptedRaw, '磁盘密钥库不得被改动');
  // 且原始两个 Provider 的密钥条目仍在
  const raw = JSON.parse(encryptedRaw);
  assert.ok(Object.prototype.hasOwnProperty.call(raw.data, s.id));
  assert.ok(Object.prototype.hasOwnProperty.call(raw.data, s2.id));
  assert.ok(before.length > 0);
  fs.rmSync(d, { recursive: true, force: true });
});

/* ================= 2. 凭据迁移：备份/写入/回读/回滚 ================= */

test('验收2a: 迁移产生明文备份、写入密文、回读校验一致', () => {
  const d = tmpDir();
  resetCodec();
  fs.writeFileSync(providerService.secretsPath(d), JSON.stringify({ p1: 'sk-p1-key', p2: 'sk-p2-key' }, null, 2));
  providerService.setCodec(fakeCodec());
  try {
    const r = providerService.migrateSecretsToEncrypted(d);
    assert.strictEqual(r.migrated, true);
    assert.strictEqual(r.verified, true, '必须回读校验通过');
    assert.ok(r.backupDir, '必须有备份目录');
    const bkPath = path.join(r.backupDir, 'feiyu_provider_secrets.json');
    assert.ok(fs.existsSync(bkPath), '备份文件必须存在');
    const bk = JSON.parse(fs.readFileSync(bkPath, 'utf-8'));
    assert.strictEqual(bk.p1, 'sk-p1-key', '备份必须是明文原值');
    assert.strictEqual(bk.p2, 'sk-p2-key');
    // 磁盘上已是密文
    const now = fs.readFileSync(providerService.secretsPath(d), 'utf-8');
    assert.ok(!now.includes('sk-p1-key'), '磁盘不得含明文');
    assert.ok(now.includes('__encrypted'));
    // 回读一致
    const back = providerService.loadSecrets(d);
    assert.strictEqual(back.p1, 'sk-p1-key');
    assert.strictEqual(back.p2, 'sk-p2-key');
    // 备份不被删除
    assert.ok(fs.existsSync(bkPath), '迁移后不得删除原明文备份');
  } finally { resetCodec(); }
  fs.rmSync(d, { recursive: true, force: true });
});

test('验收2b: 迁移回读校验失败时回滚到明文原文件', () => {
  const d = tmpDir();
  resetCodec();
  fs.writeFileSync(providerService.secretsPath(d), JSON.stringify({ p1: 'sk-p1-key' }, null, 2));
  const original = fs.readFileSync(providerService.secretsPath(d), 'utf-8');
  // 故障注入：codec 解密返回错误值 → 回读校验必然不一致
  providerService.setCodec({
    encrypt: (s) => Buffer.from(String(s), 'utf-8').toString('base64'),
    decrypt: () => 'CORRUPTED',
  });
  try {
    const r = providerService.migrateSecretsToEncrypted(d);
    assert.strictEqual(r.migrated, false, '校验失败必须判定为未迁移');
    assert.ok(/回滚/.test(r.error || ''), '错误应说明已回滚: ' + r.error);
    // 磁盘已恢复为原始明文
    assert.strictEqual(fs.readFileSync(providerService.secretsPath(d), 'utf-8'), original, '必须回滚到原文件');
    // 备份仍保留
    assert.ok(r.backupDir && fs.existsSync(path.join(r.backupDir, 'feiyu_provider_secrets.json')));
  } finally { resetCodec(); }
  fs.rmSync(d, { recursive: true, force: true });
});

test('验收2c: 迁移幂等 —— 已加密时重复迁移不改动数据', () => {
  const d = tmpDir();
  resetCodec();
  fs.writeFileSync(providerService.secretsPath(d), JSON.stringify({ p1: 'sk-p1-key' }, null, 2));
  providerService.setCodec(fakeCodec());
  try {
    providerService.migrateSecretsToEncrypted(d);
    const after1 = fs.readFileSync(providerService.secretsPath(d), 'utf-8');
    const r2 = providerService.migrateSecretsToEncrypted(d);
    assert.strictEqual(r2.migrated, false);
    assert.strictEqual(r2.reason, 'already_encrypted');
    assert.strictEqual(fs.readFileSync(providerService.secretsPath(d), 'utf-8'), after1, '重复迁移不得改动数据');
  } finally { resetCodec(); }
  fs.rmSync(d, { recursive: true, force: true });
});

/* ================= 3. 孤儿密钥清理不得误删 ================= */

test('验收3a: 注册表缺失时孤儿清理必须拒绝执行（否则会删光所有密钥）', () => {
  const d = tmpDir();
  resetCodec();
  fs.writeFileSync(providerService.secretsPath(d), JSON.stringify({ p1: 'sk-p1', p2: 'sk-p2', p3: 'sk-p3' }, null, 2));
  const r = providerService.pruneOrphanSecrets(d, { confirm: true });
  assert.strictEqual(r.ok, false, '注册表不存在时必须拒绝清理');
  assert.ok(/跳过清理/.test(r.error || ''), '错误应说明已跳过: ' + r.error);
  const sec = providerService.loadSecrets(d);
  assert.strictEqual(sec.p1, 'sk-p1', '密钥必须完好');
  assert.strictEqual(sec.p2, 'sk-p2');
  assert.strictEqual(sec.p3, 'sk-p3');
  fs.rmSync(d, { recursive: true, force: true });
});

test('验收3b: 注册表损坏时孤儿清理必须拒绝执行', () => {
  const d = tmpDir();
  resetCodec();
  fs.writeFileSync(providerService.secretsPath(d), JSON.stringify({ p1: 'sk-p1' }, null, 2));
  fs.writeFileSync(providerService.providersPath(d), '{ 这不是合法 JSON');
  const r = providerService.pruneOrphanSecrets(d, { confirm: true });
  assert.strictEqual(r.ok, false);
  assert.ok(/跳过清理/.test(r.error || ''));
  assert.strictEqual(providerService.loadSecrets(d).p1, 'sk-p1');
  fs.rmSync(d, { recursive: true, force: true });
});

test('验收3c: 注册表为空但密钥库非空时拒绝清理（疑似注册表被清空）', () => {
  const d = tmpDir();
  resetCodec();
  fs.writeFileSync(providerService.secretsPath(d), JSON.stringify({ p1: 'sk-p1' }, null, 2));
  fs.writeFileSync(providerService.providersPath(d), JSON.stringify({ default: null, providers: [] }));
  const r = providerService.pruneOrphanSecrets(d, { confirm: true });
  assert.strictEqual(r.ok, false);
  assert.ok(/跳过清理/.test(r.error || ''));
  assert.strictEqual(providerService.loadSecrets(d).p1, 'sk-p1');
  fs.rmSync(d, { recursive: true, force: true });
});

test('验收3d: 注册表正常时只删真正的孤儿，不动其它 Provider 的密钥', () => {
  const d = tmpDir();
  resetCodec();
  const a = providerService.save(d, { name: 'A', baseUrl: 'https://a.test/v1/chat/completions', model: 'm1', key: 'sk-a' });
  const b = providerService.save(d, { name: 'B', baseUrl: 'https://b.test/v1/chat/completions', model: 'm2', key: 'sk-b' });
  // 模拟历史残留：注册表里没有的 ghost
  const sp = providerService.secretsPath(d);
  const cur = JSON.parse(fs.readFileSync(sp, 'utf-8'));
  cur.ghost = 'sk-ghost';
  fs.writeFileSync(sp, JSON.stringify(cur, null, 2));

  const dry = providerService.pruneOrphanSecrets(d);
  assert.deepStrictEqual(dry.orphans, ['ghost'], '只应识别出 ghost 一个孤儿');
  const real = providerService.pruneOrphanSecrets(d, { confirm: true });
  assert.strictEqual(real.ok, true);
  const sec = providerService.loadSecrets(d);
  assert.strictEqual(sec[a.id], 'sk-a', 'A 的密钥必须保留');
  assert.strictEqual(sec[b.id], 'sk-b', 'B 的密钥必须保留');
  assert.strictEqual(sec.ghost, undefined, '只有孤儿被删');
  fs.rmSync(d, { recursive: true, force: true });
});

/* ================= 4. Provider 切换失败 → 恢复原状 ================= */

function seededBotDir() {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'ai_config.json'), JSON.stringify({
    api: { baseUrl: 'https://old.test/v1/chat/completions', model: 'old-model', timeoutMs: 30000, maxRetries: 2 },
  }, null, 2));
  fs.writeFileSync(path.join(d, 'secrets.json'), JSON.stringify({ apiKey: 'sk-old-key' }, null, 2));
  return d;
}

test('验收4a: 切换时密钥写入失败 → 配置与凭据都回到原状', () => {
  const d = seededBotDir();
  resetCodec();
  const id = providerService.save(d, { name: 'New', baseUrl: 'https://new.test/v1/chat/completions', model: 'new-model', key: 'sk-new' }).id;
  const cfgBefore = fs.readFileSync(path.join(d, 'ai_config.json'), 'utf-8');
  const secBefore = fs.readFileSync(path.join(d, 'secrets.json'), 'utf-8');
  // 注入密钥写入失败（模拟磁盘/权限故障）
  const r = providerApplyService.applySwitch(d, id, {
    backup: true,
    deps: { writeSecret: () => ({ ok: false, error: '磁盘写入失败（注入）' }) },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.rolledBack, true, '必须回滚');
  assert.strictEqual(fs.readFileSync(path.join(d, 'ai_config.json'), 'utf-8'), cfgBefore, '配置必须恢复原状');
  assert.strictEqual(fs.readFileSync(path.join(d, 'secrets.json'), 'utf-8'), secBefore, '凭据必须恢复原状');
  fs.rmSync(d, { recursive: true, force: true });
});

test('验收4b: 全新目录（无旧配置）切换失败 → 不留半应用残留', () => {
  const d = tmpDir();
  resetCodec();
  const id = providerService.save(d, { name: 'New', baseUrl: 'https://new.test/v1/chat/completions', model: 'new-model', key: 'sk-new' }).id;
  const r = providerApplyService.applySwitch(d, id, {
    backup: true,
    deps: { writeSecret: () => ({ ok: false, error: '磁盘写入失败（注入）' }) },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.rolledBack, true);
  assert.strictEqual(fs.existsSync(path.join(d, 'ai_config.json')), false, '不得残留新建的配置文件（半应用状态）');
  fs.rmSync(d, { recursive: true, force: true });
});

test('验收4c: 切换成功后配置与凭据一致，且备份可用', () => {
  const d = seededBotDir();
  resetCodec();
  const id = providerService.save(d, { name: 'New', baseUrl: 'https://new.test/v1/chat/completions', model: 'new-model', key: 'sk-new' }).id;
  const r = providerApplyService.applySwitch(d, id, { backup: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const cfg = JSON.parse(fs.readFileSync(path.join(d, 'ai_config.json'), 'utf-8'));
  assert.strictEqual(cfg.api.model, 'new-model');
  const sec = JSON.parse(fs.readFileSync(path.join(d, 'secrets.json'), 'utf-8'));
  assert.strictEqual(sec.apiKey, 'sk-new');
  // 备份可用于手工恢复
  assert.ok(fs.existsSync(path.join(r.backupDir, 'ai_config.json')));
  const bk = JSON.parse(fs.readFileSync(path.join(r.backupDir, 'ai_config.json'), 'utf-8'));
  assert.strictEqual(bk.api.model, 'old-model');
  fs.rmSync(d, { recursive: true, force: true });
});

/* ================= 5. 人格应用失败 → 原人格不变 ================= */

test('验收5a: 人格应用失败时原 ai_prompt.txt 保持不变', () => {
  const d = tmpDir();
  const original = '原人格内容\n第二行';
  fs.writeFileSync(path.join(d, 'ai_prompt.txt'), original);
  const id = personalityTemplateService.save(d, { name: 'T', content: '新人格' }).id;
  // 注入写入失败
  const r = personalityTemplateService.apply(d, id, { writePrompt: () => ({ ok: false, error: '磁盘只读' }) });
  assert.strictEqual(r.ok, false);
  assert.ok(/原配置已保留/.test(r.error || ''), '错误应说明原配置已保留: ' + r.error);
  assert.strictEqual(fs.readFileSync(path.join(d, 'ai_prompt.txt'), 'utf-8'), original, '原人格必须一字未改');
  fs.rmSync(d, { recursive: true, force: true });
});

test('验收5b: 人格应用前必有备份，且备份内容等于原人格', () => {
  const d = tmpDir();
  const original = '原人格';
  fs.writeFileSync(path.join(d, 'ai_prompt.txt'), original);
  const id = personalityTemplateService.save(d, { name: 'T', content: '新人格' }).id;
  const r = personalityTemplateService.apply(d, id);
  assert.strictEqual(r.ok, true);
  assert.ok(r.backupDir, '必须有备份目录');
  const bk = fs.readFileSync(path.join(r.backupDir, 'ai_prompt.txt'), 'utf-8');
  assert.strictEqual(bk, original, '备份内容必须是原人格');
  assert.strictEqual(fs.readFileSync(path.join(d, 'ai_prompt.txt'), 'utf-8'), '新人格');
  fs.rmSync(d, { recursive: true, force: true });
});

test('验收5c: 保存模板不触碰运行中人格文件', () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'ai_prompt.txt'), '运行中人格');
  const before = fs.readFileSync(path.join(d, 'ai_prompt.txt'), 'utf-8');
  personalityTemplateService.save(d, { name: 'A', content: 'X' });
  personalityTemplateService.save(d, { name: 'B', content: 'Y' });
  personalityTemplateService.copy(d, 'nope'); // 失败也不应影响
  assert.strictEqual(fs.readFileSync(path.join(d, 'ai_prompt.txt'), 'utf-8'), before, '保存模板不得改运行配置');
  fs.rmSync(d, { recursive: true, force: true });
});

/* ================= 6. 费用：单位 / 历史价 / 部分未定价 ================= */

test('验收6a: 单位换算 1/K/M/B 结果一致（单价语义 = 每 N 个 token 多少钱）', () => {
  // 输入 1e6 tokens，输入单价 2 元/单位
  const mk = (unit) => usageService.estimateCost({ model: 'm', prompt_tokens: 1e6 }, { version: 'v', currency: 'CNY', unit, models: { m: { input: 2, output: 2 } } });
  assert.strictEqual(mk('1').cost, 2 * 1e6, 'unit=1 → 每 token 2 元 → 2e6');
  assert.strictEqual(mk('K').cost, 2 * 1e3, 'unit=K → 每千 token 2 元 → 2000');
  assert.strictEqual(mk('M').cost, 2, 'unit=M → 每百万 token 2 元 → 2');
  assert.strictEqual(mk('B').cost, 2 / 1e3, 'unit=B → 每十亿 token 2 元 → 0.002');
  // 同一份用量在不同单位下换算结果自洽：
  //   cost = tokens × 单价 / factor。单价单位越小，数值越大（2元/百万 = 0.002元/千 = 2000元/十亿）
  const m = usageService.estimateCost({ model: 'm', prompt_tokens: 1e6 }, { version: 'v', currency: 'CNY', unit: 'M', models: { m: { input: 2, output: 2 } } }).cost;
  const k = usageService.estimateCost({ model: 'm', prompt_tokens: 1e6 }, { version: 'v', currency: 'CNY', unit: 'K', models: { m: { input: 0.002, output: 0.002 } } }).cost;
  const b = usageService.estimateCost({ model: 'm', prompt_tokens: 1e6 }, { version: 'v', currency: 'CNY', unit: 'B', models: { m: { input: 2000, output: 2000 } } }).cost;
  assert.ok(Math.abs(m - k) < 1e-9, `M(${m}) 与 K(${k}) 表示同一单价时结果应相同`);
  assert.ok(Math.abs(m - b) < 1e-9, `M(${m}) 与 B(${b}) 表示同一单价时结果应相同`);
});

test('验收6b: 历史价格按记录时间选择，早于历史回落当前价', () => {
  const price = {
    version: 'v3', currency: 'CNY', unit: 'M',
    models: { m: { input: 9, output: 9, history: [
      { effectiveFrom: '2026-01-01T00:00:00Z', input: 1, output: 1, version: 'h1' },
      { effectiveFrom: '2026-06-01T00:00:00Z', input: 3, output: 3, version: 'h2' },
    ] } },
  };
  const at = (t) => usageService.estimateCost({ model: 'm', prompt_tokens: 1e6, time: t }, price);
  assert.strictEqual(at('2026-03-01T00:00:00Z').priceVersion, 'h1');
  assert.strictEqual(at('2026-03-01T00:00:00Z').cost, 1);
  assert.strictEqual(at('2026-09-01T00:00:00Z').priceVersion, 'h2');
  assert.strictEqual(at('2026-09-01T00:00:00Z').cost, 3);
  assert.strictEqual(at('2025-01-01T00:00:00Z').priceVersion, 'v3');
  assert.strictEqual(at('2025-01-01T00:00:00Z').cost, 9);
});

test('验收6c: 部分未定价 —— 未定价模型不计入总额并被显式列出', () => {
  const price = { version: 'v', currency: 'CNY', unit: 'M', models: { known: { input: 1, output: 1 } } };
  const s = usageService.estimateCostForSet([
    { model: 'known', prompt_tokens: 100 },
    { model: 'unknown', prompt_tokens: 100000 },
  ], price);
  assert.strictEqual(s.priced, true);
  assert.strictEqual(s.pricedCount, 1);
  assert.ok(s.unpricedModels.includes('unknown'));
  assert.strictEqual(s.partial, true);
  assert.ok(s.totalCost < 1, '未定价记录不得进入总额');
  assert.ok(/非服务商实际账单/.test(s.note));
});

test('验收6d: 无价格表时整段标为未定价，不给数字', () => {
  const s = usageService.estimateCostForSet([{ model: 'm', prompt_tokens: 100 }], null);
  assert.strictEqual(s.priced, false);
  assert.strictEqual(s.totalCost, null);
});

test('验收6e: 价格表校验拒绝非法单位与负单价', () => {
  const bad = priceService.validatePrice({ version: 'v', currency: 'CNY', unit: 'X', models: { m: { input: 1, output: 1 } } });
  assert.strictEqual(bad.valid, false);
  const neg = priceService.validatePrice({ version: 'v', currency: 'CNY', unit: 'M', models: { m: { input: -1, output: 1 } } });
  assert.strictEqual(neg.valid, false);
});

/* ================= 7. /api/usage 鉴权 / 白名单 / 分页 / 兼容 ================= */

test('验收7a: 未启用鉴权时放行（回环信任，旧客户端兼容）', () => {
  assert.strictEqual(usageReport.usageEndpointAllowed({}, { requireAuth: false }), true);
});

test('验收7b: 启用鉴权但无 token → fail-closed 拒绝', () => {
  assert.strictEqual(usageReport.usageEndpointAllowed({}, { requireAuth: true, token: '' }), false);
  assert.strictEqual(usageReport.usageEndpointAllowed({ authorization: 'Bearer x' }, { requireAuth: true, token: '' }), false);
});

test('验收7c: 启用鉴权时校验 Bearer 头', () => {
  assert.strictEqual(usageReport.usageEndpointAllowed({ authorization: 'Bearer tok' }, { requireAuth: true, token: 'tok' }), true);
  assert.strictEqual(usageReport.usageEndpointAllowed({ authorization: 'Bearer wrong' }, { requireAuth: true, token: 'tok' }), false);
  assert.strictEqual(usageReport.usageEndpointAllowed({}, { requireAuth: true, token: 'tok' }), false);
});

test('验收7d: 明细只含白名单字段 —— 密钥/提示词/正文一律不出现', () => {
  const reqs = [{
    time: '2026-10-24T10:00:00Z', kind: 'answer', model: 'm', provider: 'p', status: 'success',
    prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, durationMs: 100,
    apiKey: 'sk-SHOULD-NOT-LEAK', fullPrompt: '机密提示词', content: '对话正文', secret: 'x',
  }];
  const r = usageReport.computeUsageReport(reqs, {});
  assert.ok(r.detail.length === 1);
  const d = r.detail[0];
  for (const banned of ['apiKey', 'fullPrompt', 'content', 'secret']) {
    assert.ok(!(banned in d), '明明白名单字段不得出现: ' + banned);
  }
  assert.ok(!JSON.stringify(r.detail).includes('sk-SHOULD-NOT-LEAK'));
  assert.ok(!JSON.stringify(r.detail).includes('机密提示词'));
});

test('验收7e: 分页 limit 生效且被封顶', () => {
  const reqs = [];
  for (let i = 0; i < 2500; i++) reqs.push({ time: '2026-10-24T10:00:00Z', model: 'm', status: 'success' });
  assert.strictEqual(usageReport.computeUsageReport(reqs, { limit: 10 }).detail.length, 10);
  assert.strictEqual(usageReport.computeUsageReport(reqs, { limit: 999999 }).detail.length, usageReport.MAX_LIMIT);
  assert.strictEqual(usageReport.computeUsageReport(reqs, {}).detail.length, usageReport.DEFAULT_LIMIT);
});

test('验收7f: 旧响应字段保持不变（向后兼容）', () => {
  const reqs = [{ time: 't', kind: 'answer', model: 'm', status: 'success', prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }];
  const r = usageReport.computeUsageReport(reqs, {});
  for (const f of ['totalTokens', 'promptTokens', 'completionTokens', 'requests', 'judgeRequests', 'answerRequests', 'avg', 'modelUsage', 'cacheRate']) {
    assert.ok(f in r, '旧字段缺失: ' + f);
  }
  assert.strictEqual(r.requests, 1);
  assert.strictEqual(r.totalTokens, 15);
});

test('验收7g: 缺失 status 的历史行按 success 处理，筛选语义正确', () => {
  const reqs = [{ time: 't', model: 'm' }, { time: 't2', model: 'm', status: 'error', errorCategory: 'timeout' }];
  const all = usageReport.computeUsageReport(reqs, {});
  assert.strictEqual(all.successRequests, 1);
  assert.strictEqual(all.failRequests, 1);
  assert.strictEqual(usageReport.computeUsageReport(reqs, { status: 'error' }).detail.length, 1);
  assert.strictEqual(usageReport.computeUsageReport(reqs, { status: 'success' }).detail.length, 1);
  assert.strictEqual(usageReport.computeUsageReport(reqs, { provider: 'nope' }).detail.length, 0);
});

/* ================= 8. 打包后定位机器人目录 ================= */

test('验收8a: 安装版（appPath 在 app.asar 内）能通过 exe 相对路径找到 bot', () => {
  // V1.0 验收修正：原断言依赖硬编码的 'NapCat_publish' 候选路径（那正是 P1 缺陷本身）。
  // 现改为验证**通用**规则：工作目录在 exe 的祖先目录下（同级兄弟）时能被定位，
  // 且定位结果不含任何硬编码目录名。专门的回归用例见 test/botDirResolver.test.js。
  const norm = (p) => String(p).replace(/\\/g, '/');
  const fsMock = {
    existsSync: (p) => norm(p).endsWith('/MyBotRoot/ai_bridge.js'),
    // 兄弟目录扫描：只有 C:/Users/me 下有一个名为 MyBotRoot 的目录
    readdirSync: (p) => (norm(p) === 'C:/Users/me' ? ['MyBotRoot'] : []),
    statSync: () => ({ isDirectory: () => true }),
  };
  const r = botDirResolver.resolveBotDir({
    appPath: 'C:\\Program Files\\App\\resources\\app.asar',
    execPath: 'C:\\Users\\me\\Desktop\\肥鱼桌面控制中心.exe',
    home: 'C:\\Users\\me',
    fsImpl: fsMock,
  });
  assert.strictEqual(r.ok, true);
  assert.ok(r.botDir.includes('MyBotRoot'), '应定位到实际工作目录: ' + r.botDir);
  assert.ok(!/napcat/i.test(r.botDir), '不得依赖硬编码的目录名: ' + r.botDir);
});

test('验收8b: 便携版（bot 目录在 exe 同级）能定位', () => {
  // exe 在 ...\portable\下，bot 在 ...\portable\bot\ → 命中候选 exeDir/bot
  const fsMock = {
    existsSync: (p) => String(p).replace(/\\/g, '/').endsWith('/portable/bot/ai_bridge.js'),
  };
  const r = botDirResolver.resolveBotDir({
    appPath: 'C:\\Users\\me\\Desktop\\portable\\resources\\app.asar',
    execPath: 'C:\\Users\\me\\Desktop\\portable\\肥鱼桌面控制中心.exe',
    home: 'C:\\Users\\me',
    fsImpl: fsMock,
  });
  assert.strictEqual(r.ok, true, '应能定位便携版 bot 目录');
  assert.ok(r.botDir.replace(/\\/g, '/').endsWith('/portable/bot'), '实际: ' + r.botDir);
});

test('验收8c: 找不到时返回明确原因与提示文案（不得静默失败）', () => {
  const r = botDirResolver.resolveBotDir({
    appPath: 'C:\\Program Files\\App\\resources\\app.asar',
    execPath: 'C:\\Program Files\\App\\肥鱼桌面控制中心.exe',
    home: 'C:\\Users\\me',
    fsImpl: { existsSync: () => false },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'not_found');
  assert.ok(/请.*选择.*机器人目录/.test(r.warning || ''), '应有引导性提示: ' + r.warning);
});

test('验收8d: 设置中的目录已消失时明确报告原因', () => {
  const r = botDirResolver.resolveBotDir({
    botDir: 'C:\\gone\\bot',
    fsImpl: { existsSync: () => false },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'settings_dir_missing');
});

test('验收8e: 用户显式指定的目录即使缺 ai_bridge.js 也保留（但给出警告）', () => {
  // 目录本身存在，但里面没有 ai_bridge.js
  const fsMock = {
    existsSync: (p) => String(p).replace(/\\/g, '/').endsWith('/somewhere'),
  };
  const r = botDirResolver.resolveBotDir({
    botDir: 'C:\\somewhere',
    fsImpl: fsMock,
  });
  assert.strictEqual(r.ok, true, '用户显式指定的目录应保留');
  assert.strictEqual(r.botDir, 'C:\\somewhere');
  assert.ok(/ai_bridge/.test(r.warning || ''), '应警告缺少核心文件，实际: ' + r.warning);
});

/* ================= 9. 安装/升级/卸载的数据保留 ================= */

test('验收9a: 打包配置声明卸载不删除用户数据', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
  assert.strictEqual(pkg.build.nsis.deleteAppDataOnUninstall, false);
  const yml = fs.readFileSync(path.join(__dirname, '..', 'build', 'electron-builder.yml'), 'utf-8');
  assert.ok(/deleteAppDataOnUninstall:\s*false/.test(yml), 'yml 也必须一致');
});

test('验收9b: 用户数据（设置/价格）写在 userData，不在安装目录', () => {
  const h = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc', 'handlers.js'), 'utf-8');
  assert.ok(/getUserDataDir\(\)/.test(h), '必须走 userData');
  assert.ok(!/path\.join\(app\.getAppPath\(\)/.test(h), '不得写入安装目录');
});

test('验收9c: 机器人数据（配置/记忆/日志）始终在 botDir，不受安装/卸载影响', () => {
  const ps = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'personalityService.js'), 'utf-8');
  assert.ok(/path\.join\(botDir/.test(ps), '人格文件应在 botDir');
  const us = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'usageService.js'), 'utf-8');
  assert.ok(/path\.join\(botDir, 'memory'/.test(us), '用量数据应在 botDir/memory');
});

/* ================= 10. 敏感字段不进日志/导出/诊断 ================= */

test('验收10a: 默认导出不含密钥，显式含密钥才带', () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'ai_config.json'), JSON.stringify({ api: { baseUrl: 'https://x/v1', model: 'm' } }));
  fs.writeFileSync(path.join(d, 'secrets.json'), JSON.stringify({ apiKey: 'sk-REAL-KEY-123456' }));
  const plain = importExportService.buildExport(d, '0.1.0');
  assert.ok(!('secret' in plain), '默认导出不得含 secret 段');
  assert.ok(!JSON.stringify(plain).includes('sk-REAL-KEY'));
  const withSec = importExportService.buildExport(d, '0.1.0', { includeSecret: true });
  assert.ok('secret' in withSec, '显式请求时应包含');
  fs.rmSync(d, { recursive: true, force: true });
});

test('验收10b: 差异预览不泄露密钥', () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'ai_config.json'), JSON.stringify({ api: { baseUrl: 'https://x/v1', model: 'm' } }));
  fs.writeFileSync(path.join(d, 'secrets.json'), JSON.stringify({ apiKey: 'sk-REAL-KEY-123456' }));
  const dv = importExportService.diffPreview(d, { config: { api: { model: 'm2' } } });
  assert.ok(!JSON.stringify(dv).includes('sk-REAL-KEY'), '差异预览不得含密钥');
  fs.rmSync(d, { recursive: true, force: true });
});

test('验收10c: 日志读取对密钥/路径/内部组件脱敏', () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'ai_bridge.log'), [
    '调用 API，key=sk-REALKEY-abcdefghijkl',
    '配置文件位于 D:\\NapCat_publish\\ai_config.json',
    '监听 127.0.0.1:5920 的事件入口',
    'Authorization: Bearer onetoken123456',
  ].join('\n'));
  const tail = logService.readTail(d, 100);
  const text = tail.lines.join('\n');
  assert.ok(!text.includes('sk-REALKEY-abcdefghijkl'), '日志不得回显密钥');
  assert.ok(!text.includes('D:\\NapCat_publish'), '日志不得回显本机路径');
  assert.ok(!text.includes('onetoken123456'), '日志不得回显 token');
  assert.ok(text.includes('sk-<KEY>'));
  fs.rmSync(d, { recursive: true, force: true });
});

test('验收10d: 脱敏规则覆盖 API Key / 路径 / 端口 / 内部组件', () => {
  assert.ok(redact.redactText('sk-abcdefghijklmnop').includes('sk-<KEY>'));
  assert.ok(redact.redactText('D:\\some\\path\\file.txt').includes('<本地路径>'));
  assert.ok(redact.redactText('127.0.0.1:5920').includes('<本地地址>'));
  assert.ok(!redact.redactText('调用 ai_bridge.js 处理').includes('ai_bridge'));
  assert.ok(redact.looksSecret('包含 sk-abcdefghijklmnop 的文本'));
});

test('验收10e: Provider 列表与切换预览不回显密钥明文', () => {
  const d = seededBotDir();
  resetCodec();
  const id = providerService.save(d, { name: 'New', baseUrl: 'https://new.test/v1/chat/completions', model: 'new-model', key: 'sk-SECRET-VALUE-9999' }).id;
  const list = providerService.list(d);
  assert.ok(!JSON.stringify(list).includes('sk-SECRET-VALUE-9999'), '列表不得含密钥');
  const pv = providerApplyService.previewSwitch(d, id);
  assert.ok(pv.ok);
  assert.ok(!JSON.stringify(pv).includes('sk-SECRET-VALUE-9999'), '预览不得含密钥明文');
  fs.rmSync(d, { recursive: true, force: true });
});
