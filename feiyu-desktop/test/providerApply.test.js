'use strict';
/**
 * providerApply.test.js —— 批次 D：Provider 切换的差异预览、备份与回滚测试。
 * 使用临时目录，不触碰真实配置。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const providerService = require('../src/services/providerService');
const providerApplyService = require('../src/services/providerApplyService');
const configService = require('../src/services/configService');
const secretService = require('../src/services/secretService');

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-apply-'));
  // 造一个最小可用配置
  fs.writeFileSync(path.join(d, 'ai_config.json'), JSON.stringify({
    api: { baseUrl: 'https://old.test/v1/chat/completions', model: 'old-model', timeoutMs: 30000, maxRetries: 2 },
  }, null, 2));
  fs.writeFileSync(path.join(d, 'secrets.json'), JSON.stringify({ apiKey: 'sk-old-key' }, null, 2));
  return d;
}
function addProvider(d, over) {
  const p = providerService.save(d, Object.assign({
    name: 'New', baseUrl: 'https://new.test/v1/chat/completions', model: 'new-model', key: 'sk-new-key',
  }, over || {}));
  assert.ok(p.ok, JSON.stringify(p));
  return p.id;
}

test('previewSwitch: 输出差异且不写入任何文件', () => {
  const d = tmpDir();
  const id = addProvider(d);
  const before = fs.readFileSync(path.join(d, 'ai_config.json'), 'utf-8');
  const pv = providerApplyService.previewSwitch(d, id);
  assert.ok(pv.ok, JSON.stringify(pv));
  assert.ok(pv.diff.baseUrl, 'baseUrl 应有差异');
  assert.strictEqual(pv.diff.baseUrl.from, 'https://old.test/v1/chat/completions');
  assert.strictEqual(pv.diff.baseUrl.to, 'https://new.test/v1/chat/completions');
  assert.strictEqual(pv.secretChanged, true, '密钥应标记为将更换');
  assert.strictEqual(fs.readFileSync(path.join(d, 'ai_config.json'), 'utf-8'), before, '预览不得写文件');
  // 不泄露明文密钥
  assert.ok(!JSON.stringify(pv).includes('sk-new-key'), '预览结果不得包含明文密钥');
});

test('applySwitch: 成功写入 + 生成备份', () => {
  const d = tmpDir();
  const id = addProvider(d);
  const r = providerApplyService.applySwitch(d, id, { backup: true });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(r.backupDir && fs.existsSync(r.backupDir), '应生成备份目录');
  const bk = JSON.parse(fs.readFileSync(path.join(r.backupDir, 'ai_config.json'), 'utf-8'));
  assert.strictEqual(bk.api.model, 'old-model', '备份应保留切换前配置');
  const cfg = configService.readRaw(d).data;
  assert.strictEqual(cfg.api.model, 'new-model');
  const sec = secretService.read(d).data;
  assert.strictEqual(sec.apiKey, 'sk-new-key');
});

test('applySwitch: 密钥缺失时拒绝应用（不破坏现有配置）', () => {
  const d = tmpDir();
  const id = addProvider(d);
  // 清掉该 Provider 密钥
  const sp = providerService.secretsPath(d);
  const raw = JSON.parse(fs.readFileSync(sp, 'utf-8'));
  delete raw[id];
  fs.writeFileSync(sp, JSON.stringify(raw, null, 2));

  const before = fs.readFileSync(path.join(d, 'ai_config.json'), 'utf-8');
  const r = providerApplyService.applySwitch(d, id, { backup: true });
  assert.strictEqual(r.ok, false);
  assert.ok(/密钥/.test(r.error), '错误应说明缺少密钥：' + r.error);
  assert.strictEqual(fs.readFileSync(path.join(d, 'ai_config.json'), 'utf-8'), before, '失败不得改动配置');
});

test('applySwitch: 写入失败时回滚到原配置', () => {
  const d = tmpDir();
  const id = addProvider(d);
  const beforeCfg = fs.readFileSync(path.join(d, 'ai_config.json'), 'utf-8');
  const beforeSec = fs.readFileSync(path.join(d, 'secrets.json'), 'utf-8');
  // 注入密钥写入失败（比「目录占位」更贴近真实故障，且不影响回滚路径本身）
  const r = providerApplyService.applySwitch(d, id, {
    backup: true,
    deps: { writeSecret: () => ({ ok: false, error: '磁盘写入失败（注入）' }) },
  });
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert.strictEqual(r.rolledBack, true, '应已回滚');
  assert.strictEqual(fs.readFileSync(path.join(d, 'ai_config.json'), 'utf-8'), beforeCfg, '配置应恢复');
  assert.strictEqual(fs.readFileSync(path.join(d, 'secrets.json'), 'utf-8'), beforeSec, '凭据应恢复');
});

test('applySwitch: 幂等 —— 重复应用同一 Provider 结果一致', () => {
  const d = tmpDir();
  const id = addProvider(d);
  const r1 = providerApplyService.applySwitch(d, id, { backup: true });
  assert.ok(r1.ok);
  const r2 = providerApplyService.applySwitch(d, id, { backup: true });
  assert.ok(r2.ok);
  const cfg = configService.readRaw(d).data;
  assert.strictEqual(cfg.api.model, 'new-model');
});
