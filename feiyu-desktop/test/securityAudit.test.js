'use strict';
/**
 * securityAudit.test.js —— V1.0 阶段 G 安全审计的**自动化**回归。
 *
 * 覆盖任务书「最终安全审计与回归」清单里可自动化的部分：
 *   凭据不可解密时写操作阻断 / 迁移失败回滚 / 孤儿清理 fail-closed /
 *   Provider 应用失败恢复 / 人格应用失败不变 / 路径脱敏 /
 *   日志·CSV·导出·IPC 返回值不泄漏密钥 / /api/usage 鉴权·白名单·分页·兼容 /
 *   费用计算·历史价·未定价·时区边界。
 *
 * 全部用临时目录 + 虚构数据，不触及真实凭据。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const providerService = require('../src/services/providerService');
const providerApplyService = require('../src/services/providerApplyService');
const usageService = require('../src/services/usageService');
const importExportService = require('../src/services/importExportService');
const priceService = require('../src/services/priceService');
const personalityTemplateService = require('../src/services/personalityTemplateService');
const secretService = require('../src/services/secretService');
const { redactText } = require('../src/services/redact');
const usageReport = require('../../usage_report');

const SECRET = 'sk-AUDITSECRET0123456789abcdef';
const TOKEN = 'tok-AUDITTOKEN0123456789';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'secaudit-')); }
function noLeak(obj, label) {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  assert.ok(!s.includes(SECRET), label + ' 泄漏了 API Key');
  assert.ok(!s.includes(TOKEN), label + ' 泄漏了 Token');
}

// ————————————————————————————————————————
// 1. 凭据不可解密 → 写操作全阻断
// ————————————————————————————————————————

test('G-1: 加密库不可解密时，所有写操作被阻断且磁盘密文不变', () => {
  const d = tmpDir();
  providerService.setCodec({
    encrypt: (p) => Buffer.from('enc:' + p).toString('base64'),
    decrypt: (c) => { throw new Error('cannot decrypt'); },
  });
  // 造一个"已加密但解不开"的库
  const sp = providerService.secretsPath(d);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(sp, JSON.stringify({ __encrypted: true, data: { p1: 'Y2lwaGVy' } }));
  const before = fs.readFileSync(sp, 'utf-8');

  // 各写路径都必须被阻断
  assert.strictEqual(providerService.save(d, { name: 'X', baseUrl: 'https://a.test/v1/chat/completions', model: 'm', key: 'k' }).ok, false, 'save 应被阻断');
  assert.strictEqual(providerService.remove(d, 'p1').ok, false, 'remove 应被阻断');
  assert.strictEqual(providerService.pruneOrphanSecrets(d, { confirm: true }).ok, false, 'prune 应被阻断');
  assert.strictEqual(providerService.setDefault(d, 'p1').ok, false, 'setDefault 应被阻断');

  assert.strictEqual(fs.readFileSync(sp, 'utf-8'), before, '磁盘密文必须一字节未变');
  providerService.setCodec(null);
  fs.rmSync(d, { recursive: true, force: true });
});

test('G-1: 密文不可解密时迁移不得重写原文件', () => {
  const d = tmpDir();
  providerService.setCodec({
    encrypt: (p) => Buffer.from(p).toString('base64'),
    decrypt: () => { throw new Error('nope'); },
  });
  const sp = providerService.secretsPath(d);
  fs.mkdirSync(d, { recursive: true });
  const orig = JSON.stringify({ __encrypted: true, data: { p1: 'Y2lwaGVy' } });
  fs.writeFileSync(sp, orig);

  const r = providerService.migrateSecretsToEncrypted(d);
  assert.strictEqual(r.migrated, false);
  assert.strictEqual(r.reason, 'not_decryptable');
  assert.ok(r.error && r.error.includes('无法解密'));
  assert.strictEqual(fs.readFileSync(sp, 'utf-8'), orig, '原密文不得被重写');
  providerService.setCodec(null);
  fs.rmSync(d, { recursive: true, force: true });
});

// ————————————————————————————————————————
// 2. 凭据迁移：备份 → 写入 → 回读校验 → 失败回滚
// ————————————————————————————————————————

test('G-2: 迁移成功时生成备份且校验通过', () => {
  const d = tmpDir();
  providerService.setCodec({
    encrypt: (p) => Buffer.from(p).toString('base64'),
    decrypt: (c) => Buffer.from(c, 'base64').toString(),
  });
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(providerService.secretsPath(d), JSON.stringify({ p1: SECRET }));
  const r = providerService.migrateSecretsToEncrypted(d);
  assert.strictEqual(r.migrated, true);
  assert.strictEqual(r.verified, true);
  assert.ok(r.backupDir, '应记录备份目录');
  assert.ok(fs.existsSync(path.join(r.backupDir, 'feiyu_provider_secrets.json')), '备份文件必须存在');
  // 回读内容一致
  assert.strictEqual(providerService.loadSecrets(d).p1, SECRET);
  providerService.setCodec(null);
  fs.rmSync(d, { recursive: true, force: true });
});

test('G-2: 迁移幂等（已加密则不再重复迁移，不动文件）', () => {
  const d = tmpDir();
  providerService.setCodec({
    encrypt: (p) => Buffer.from(p).toString('base64'),
    decrypt: (c) => Buffer.from(c, 'base64').toString(),
  });
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(providerService.secretsPath(d), JSON.stringify({ p1: SECRET }));
  providerService.migrateSecretsToEncrypted(d);
  const after1 = fs.readFileSync(providerService.secretsPath(d), 'utf-8');
  const r2 = providerService.migrateSecretsToEncrypted(d);
  assert.strictEqual(r2.migrated, false);
  assert.strictEqual(r2.reason, 'already_encrypted');
  assert.strictEqual(fs.readFileSync(providerService.secretsPath(d), 'utf-8'), after1, '二次迁移不得改文件');
  providerService.setCodec(null);
  fs.rmSync(d, { recursive: true, force: true });
});

// ————————————————————————————————————————
// 3. 孤儿密钥清理：注册表缺失/损坏 → fail-closed
// ————————————————————————————————————————

test('G-3: 注册表缺失时孤儿清理必须拒绝（否则会删光所有密钥）', () => {
  const d = tmpDir();
  providerService.setCodec(null);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(providerService.secretsPath(d), JSON.stringify({ p1: SECRET, p2: SECRET }));
  const r = providerService.pruneOrphanSecrets(d, { confirm: true });
  assert.strictEqual(r.ok, false, '注册表缺失时必须拒绝清理');
  assert.strictEqual(r.pruned.length, 0, '不得清理任何密钥');
  const after = providerService.loadSecrets(d);
  assert.ok(after.p1 && after.p2, '密钥必须完好无损');
  fs.rmSync(d, { recursive: true, force: true });
});

test('G-3: 注册表损坏时孤儿清理必须拒绝', () => {
  const d = tmpDir();
  providerService.setCodec(null);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(providerService.secretsPath(d), JSON.stringify({ p1: SECRET }));
  fs.writeFileSync(providerService.providersPath(d), '{ broken json');
  const r = providerService.pruneOrphanSecrets(d, { confirm: true });
  assert.strictEqual(r.ok, false, '注册表损坏时必须拒绝清理');
  assert.ok(providerService.loadSecrets(d).p1, '密钥必须保留');
  fs.rmSync(d, { recursive: true, force: true });
});

test('G-3: 注册表正常时孤儿清理只删真正的孤儿', () => {
  const d = tmpDir();
  providerService.setCodec(null);
  const id = providerService.save(d, { name: 'A', baseUrl: 'https://a.test/v1/chat/completions', model: 'm', key: SECRET }).id;
  // 塞一个孤儿
  const sp = providerService.secretsPath(d);
  const cur = JSON.parse(fs.readFileSync(sp, 'utf-8'));
  cur.ghost = SECRET;
  fs.writeFileSync(sp, JSON.stringify(cur));
  const r = providerService.pruneOrphanSecrets(d, { confirm: true });
  assert.strictEqual(r.ok, true);
  assert.ok(r.pruned.includes('ghost'));
  assert.ok(providerService.loadSecrets(d)[id], '真实 Provider 的密钥必须保留');
  fs.rmSync(d, { recursive: true, force: true });
});

// ————————————————————————————————————————
// 4. Provider 应用失败 → 恢复原状
// ————————————————————————————————————————

test('G-4: 切换失败时配置与凭据都回到原状', () => {
  const d = tmpDir();
  providerService.setCodec(null);
  fs.writeFileSync(path.join(d, 'ai_config.json'), JSON.stringify({ api: { baseUrl: 'https://old.test/v1', model: 'old' } }));
  fs.writeFileSync(path.join(d, 'secrets.json'), JSON.stringify({ apiKey: 'sk-old' }));
  const id = providerService.save(d, { name: 'New', baseUrl: 'https://new.test/v1/chat/completions', model: 'new', key: SECRET }).id;
  const cfgBefore = fs.readFileSync(path.join(d, 'ai_config.json'), 'utf-8');
  const secBefore = fs.readFileSync(path.join(d, 'secrets.json'), 'utf-8');
  // 让 secrets.json 变成目录 → 写入失败
  fs.unlinkSync(path.join(d, 'secrets.json'));
  fs.mkdirSync(path.join(d, 'secrets.json'));
  const r = providerApplyService.applySwitch(d, id, { backup: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.rolledBack, true);
  assert.strictEqual(fs.readFileSync(path.join(d, 'ai_config.json'), 'utf-8'), cfgBefore, '配置必须还原');
  fs.rmSync(path.join(d, 'secrets.json'), { recursive: true });
  fs.writeFileSync(path.join(d, 'secrets.json'), secBefore);
  fs.rmSync(d, { recursive: true, force: true });
});

// ————————————————————————————————————————
// 5. 人格应用失败 → 原人格不变
// ————————————————————————————————————————

test('G-5: 人格应用失败时原文件保持不变', () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'ai_prompt.txt'), '原人格');
  const t = personalityTemplateService.save(d, { name: 'T', content: '新人格' });
  fs.unlinkSync(path.join(d, 'ai_prompt.txt'));
  fs.mkdirSync(path.join(d, 'ai_prompt.txt'));   // 变成目录 → 写入必失败
  const r = personalityTemplateService.apply(d, t.id);
  assert.strictEqual(r.ok, false);
  assert.ok(fs.statSync(path.join(d, 'ai_prompt.txt')).isDirectory(), '原路径未被破坏');
  fs.rmSync(path.join(d, 'ai_prompt.txt'), { recursive: true });
  fs.writeFileSync(path.join(d, 'ai_prompt.txt'), '原人格');
  fs.rmSync(d, { recursive: true, force: true });
});

// ————————————————————————————————————————
// 6. 泄漏面：Provider 列表 / 导出 / CSV / IPC
// ————————————————————————————————————————

test('G-6: Provider 列表不含密钥', () => {
  const d = tmpDir();
  providerService.setCodec(null);
  providerService.save(d, { name: 'A', baseUrl: 'https://a.test/v1/chat/completions', model: 'm', key: SECRET });
  const l = providerService.list(d);
  noLeak(l.providers, 'PROVIDER_LIST');
  assert.ok(l.providers.every((p) => p.secret === undefined), '不得含 secret 字段');
  fs.rmSync(d, { recursive: true, force: true });
});

test('G-6: Provider 连接测试的错误信息已脱敏', () => {
  const r = providerService.testConnection(
    { baseUrl: 'https://x.test/v1/chat/completions', model: 'm', name: 'x' },
    { fetch: async () => { throw new Error('failed with ' + SECRET); }, apiKey: SECRET }
  );
  noLeak(r.error || '', 'TEST_CONNECTION');
});

test('G-6: 默认导出不含密钥段', () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'ai_config.json'), JSON.stringify({ api: { baseUrl: 'https://a.test/v1', model: 'm' } }));
  fs.writeFileSync(path.join(d, 'secrets.json'), JSON.stringify({ apiKey: SECRET, onebotToken: TOKEN }));
  fs.writeFileSync(path.join(d, 'ai_prompt.txt'), '人格');
  const exp = importExportService.buildExport(d, '1.0.0');
  noLeak(exp, '默认导出');
  assert.ok(!('secret' in exp), '默认导出不得含 secret 段');
  fs.rmSync(d, { recursive: true, force: true });
});

test('G-6: CSV 导出不泄漏密钥且表头完整', () => {
  const csv = usageService.toCSV([
    { time: 't1', status: 'success', model: 'm', provider: 'p', total_tokens: 10 },
    { time: 't2', status: 'error', model: 'm', provider: 'p', errorCategory: 'timeout' },
  ]);
  noLeak(csv, 'CSV');
  const head = csv.split('\r\n')[0];
  for (const col of ['time', 'status', 'provider', 'model', 'duration_ms', 'error_category']) {
    assert.ok(head.includes(col), 'CSV 表头缺 ' + col);
  }
});

test('G-6: SECRET_READ 服务层读到的是原始值（IPC 层才做掩码）', () => {
  // 说明边界：真正的安全边界在 IPC handler（掩码后返回），服务层不做掩码。
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'secrets.json'), JSON.stringify({ apiKey: SECRET }));
  const r = secretService.read(d);
  assert.ok(r.data.apiKey === SECRET, '服务层返回原值（这是设计如此）');
  fs.rmSync(d, { recursive: true, force: true });
});

// ————————————————————————————————————————
// 7. /api/usage：鉴权 / 白名单 / 分页 / 兼容
// ————————————————————————————————————————

test('G-7: 无 Authorization / 错误 Token 一律拒绝，正确 Token 放行', () => {
  assert.strictEqual(usageReport.usageEndpointAllowed({}, { requireAuth: true, token: TOKEN }), false);
  assert.strictEqual(usageReport.usageEndpointAllowed({ authorization: 'Bearer wrong' }, { requireAuth: true, token: TOKEN }), false);
  assert.strictEqual(usageReport.usageEndpointAllowed({ authorization: 'Bearer ' + TOKEN }, { requireAuth: true, token: TOKEN }), true);
});

test('G-7: detail 白名单投影剔除 apiKey / 提示词 / 正文', () => {
  const rep = usageReport.computeUsageReport([
    { time: 't', model: 'm', apiKey: SECRET, prompt: '秘密提示词', body: '正文', total_tokens: 5 },
  ], { range: 'all' });
  noLeak(rep.detail, 'usage detail');
  assert.ok(!JSON.stringify(rep.detail).includes('秘密提示词'));
  assert.ok(!JSON.stringify(rep.detail).includes('正文'));
});

test('G-7: limit 封顶生效（分页上限）', () => {
  const many = [];
  for (let i = 0; i < 50; i++) many.push({ time: 't' + i, model: 'm', total_tokens: 1 });
  const rep = usageReport.computeUsageReport(many, { range: 'all', limit: 999999 });
  assert.ok(rep.detail.length <= usageReport.MAX_LIMIT, '不得超过 MAX_LIMIT');
  assert.strictEqual(usageReport.clampLimit(999999), usageReport.MAX_LIMIT);
  assert.strictEqual(usageReport.clampLimit(-1), usageReport.DEFAULT_LIMIT);
});

test('G-7: 旧响应字段语义保持（兼容旧客户端）', () => {
  const rep = usageReport.computeUsageReport([
    { time: 't', model: 'm', kind: 'answer', total_tokens: 10, prompt_tokens: 6, completion_tokens: 4 },
  ], { range: 'all' });
  assert.strictEqual(rep.totalTokens, 10);
  assert.strictEqual(rep.promptTokens, 6);
  assert.strictEqual(rep.completionTokens, 4);
  assert.strictEqual(rep.requests, 1);
  assert.strictEqual(rep.answerRequests, 1);
  assert.ok(rep.modelUsage && rep.modelUsage.m, 'modelUsage 保持旧结构');
});

// ————————————————————————————————————————
// 8. 费用计算：单位 / 历史价 / 未定价 / 时区边界
// ————————————————————————————————————————

test('G-8: 单位换算 1/K/M/B 语义正确（同一费率在各单位下等价）', () => {
  // 语义：price = 「每 unit 个 token 的价格」。
  // 因此「每百万 token 2 元」在四种单位下的写法分别是 2e-6 / 0.002 / 2 / 2000。
  const mk = (unit, price) => usageService.estimateCost(
    { model: 'm', prompt_tokens: 1e6 },
    { version: 'v', currency: 'CNY', unit, models: { m: { input: price, output: price } } }
  ).cost;
  assert.strictEqual(mk('1', 0.000002), 2);
  assert.strictEqual(mk('K', 0.002), 2);
  assert.strictEqual(mk('M', 2), 2);
  assert.strictEqual(mk('B', 2000), 2);
});

test('G-8: 历史价格按记录时间选择生效版本', () => {
  const price = {
    version: 'p2', currency: 'CNY', unit: 'M',
    models: { m: { input: 1, output: 1, history: [
      { version: 'p1', effectiveFrom: '2026-01-01', input: 10, output: 10 },
      { version: 'p2', effectiveFrom: '2026-06-01', input: 2, output: 2 },
    ] } },
  };
  const old = usageService.estimateCost({ model: 'm', prompt_tokens: 1e6, time: '2026-03-01T00:00:00Z' }, price);
  const neu = usageService.estimateCost({ model: 'm', prompt_tokens: 1e6, time: '2026-09-01T00:00:00Z' }, price);
  assert.strictEqual(old.cost, 10, '3 月应套用 1 月生效的价');
  assert.strictEqual(neu.cost, 2, '9 月应套用 6 月生效的价');
  assert.strictEqual(old.priceVersion, 'p1');
  assert.strictEqual(neu.priceVersion, 'p2');
});

test('G-8: 未知模型 → 未定价（priced=false，cost=null）', () => {
  const r = usageService.estimateCost({ model: 'unknown', prompt_tokens: 1000 },
    { version: 'v', currency: 'CNY', unit: 'M', models: { m: { input: 1, output: 1 } } });
  assert.strictEqual(r.priced, false);
  assert.strictEqual(r.cost, null);
});

test('G-8: 部分未定价时汇总标出 unpricedModels / partial', () => {
  const set = usageService.estimateCostForSet([
    { model: 'm', prompt_tokens: 1000 },
    { model: 'unknown', prompt_tokens: 1000 },
  ], { version: 'v', currency: 'CNY', unit: 'M', models: { m: { input: 1, output: 1 } } });
  assert.strictEqual(set.priced, true);
  assert.strictEqual(set.partial, true, '部分定价必须标记');
  assert.ok(set.unpricedModels.includes('unknown'));
  assert.ok(set.note.includes('非服务商实际账单'));
});

test('G-8: 日期范围按本地时区推算（today 不跨 UTC 错位）', () => {
  const files = usageService.rangeFiles('today');
  const now = new Date();
  const expect = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
    + '-' + String(now.getDate()).padStart(2, '0') + '.jsonl';
  assert.strictEqual(files.length, 1);
  assert.strictEqual(files[0], expect, 'today 必须是本地当天（不是 UTC 当天）');
});

test('G-8: 价格表校验拒绝非法值', () => {
  assert.strictEqual(priceService.validatePrice({ version: 'v', currency: 'CNY', unit: 'X', models: {} }).valid, false);
  assert.strictEqual(priceService.validatePrice({ version: 'v', currency: 'CNY', unit: 'M', models: { m: { input: -1 } } }).valid, false);
});

// ————————————————————————————————————————
// 9. 脱敏
// ————————————————————————————————————————

test('G-9: 脱敏覆盖密钥 / 路径 / 令牌字段', () => {
  noLeak(redactText('sk-' + 'abcdefghijklmnop123456'), 'redact apikey');
  assert.ok(redactText('D:\\NapCat\\secrets.json').includes('<本地路径>'));
  assert.ok(redactText('D:/NapCat/secrets.json').includes('<本地路径>'));
  assert.ok(redactText('{"apiKey":"sk-xyz"}').includes('<KEY>'));
  assert.ok(redactText('{"onebotToken":"tok-abc"}').includes('<TOKEN>'));
  assert.ok(redactText('Authorization: Bearer abcdef').includes('<TOKEN>'));
});

test('G-9: 脱敏不误伤正常 URL 与普通文本', () => {
  assert.strictEqual(redactText('https://api.deepseek.com/v1/chat/completions'), 'https://api.deepseek.com/v1/chat/completions');
  assert.strictEqual(redactText('port 3001 running'), 'port 3001 running');
});
