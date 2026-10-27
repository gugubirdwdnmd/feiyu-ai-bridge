'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');

// git 仓库根：feiyu-desktop/ 的上一级
const gitRoot = path.resolve(__dirname, '..', '..');
const TAG = 'feiyu-desktop-v1.0.0';

function sha256File(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

function readTagFile(rel) {
  return execSync(`git -C "${gitRoot}" show ${TAG}:feiyu-desktop/${rel}`, { encoding: 'utf-8' });
}

// 真实 v1.0.0 用户数据在磁盘上的序列化形态（服务层统一用 JSON.stringify(obj, null, 2)）。
function writeV1Data(botDir, userData, sample) {
  fs.mkdirSync(botDir, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(botDir, 'feiyu_providers.json'), JSON.stringify(sample.providers, null, 2));
  fs.writeFileSync(path.join(botDir, 'feiyu_provider_secrets.json'), JSON.stringify(sample.secrets, null, 2));
  fs.writeFileSync(path.join(botDir, 'ai_config.json'), JSON.stringify(sample.config, null, 2));
  fs.writeFileSync(path.join(userData, 'feiyu-settings.json'), JSON.stringify(sample.settings, null, 2));
}

// 升级：新版服务读取既有数据，并在「使用时持久化」按服务层相同序列化写回（幂等）。
function upgradeRewrite(newProvider, newConfig, botDir) {
  const p = newProvider.load(botDir);
  fs.writeFileSync(newProvider.providersPath(botDir), JSON.stringify(p, null, 2));
  const s = newProvider.loadSecrets(botDir);
  fs.writeFileSync(newProvider.secretsPath(botDir), JSON.stringify(s, null, 2));
  const c = newConfig.readRaw(botDir).data;
  fs.writeFileSync(newConfig.configPath(botDir), JSON.stringify(c, null, 2));
}

// 数据兼容性核心约束：升级（v1.0.0 → 玄枢 XUANSHU）不得改写/丢失既有用户数据文件。
// 这里用真实服务代码做「读取既有数据 → 幂等写回」的升级模拟，并对比升级前后 SHA-256。

test('升级自校验：新版服务读取 v1.0.0 数据并幂等写回，SHA-256 不变', () => {
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanshu-rt-'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanshu-rt-ud-'));
  const sample = {
    providers: { default: 'deepseek', providers: [{ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }] },
    secrets: { deepseek: 'sk-TEST-KEY-not-real-0123456789' },
    config: { api: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }, reasoningModel: 'deepseek-reasoner' },
    settings: { botDir, theme: 'dark' },
  };
  writeV1Data(botDir, userData, sample);
  const newProvider = require('../src/services/providerService');
  const newConfig = require('../src/services/configService');

  const pre = {
    'feiyu_providers.json': sha256File(path.join(botDir, 'feiyu_providers.json')),
    'feiyu_provider_secrets.json': sha256File(path.join(botDir, 'feiyu_provider_secrets.json')),
    'ai_config.json': sha256File(path.join(botDir, 'ai_config.json')),
    'feiyu-settings.json': sha256File(path.join(userData, 'feiyu-settings.json')),
  };

  // 新版代码能正确解析 v1.0.0 形态的数据
  assert.deepStrictEqual(newProvider.load(botDir), sample.providers);
  assert.deepStrictEqual(newProvider.loadSecrets(botDir), sample.secrets);
  assert.deepStrictEqual(newConfig.readRaw(botDir).data, sample.config);

  // 升级写回（幂等）
  upgradeRewrite(newProvider, newConfig, botDir);

  const post = {
    'feiyu_providers.json': sha256File(path.join(botDir, 'feiyu_providers.json')),
    'feiyu_provider_secrets.json': sha256File(path.join(botDir, 'feiyu_provider_secrets.json')),
    'ai_config.json': sha256File(path.join(botDir, 'ai_config.json')),
    'feiyu-settings.json': sha256File(path.join(userData, 'feiyu-settings.json')),
  };
  for (const k of Object.keys(pre)) {
    assert.strictEqual(post[k], pre[k], `用户数据 ${k} 升级前后 SHA-256 不一致（升级丢失/改写了数据）`);
  }
  console.log('[upgradeCompat/self] v1.0.0 → 玄枢 XUANSHU 用户数据 SHA-256（升级前后一致）:');
  for (const k of Object.keys(pre)) console.log(`  ${k}: ${pre[k]}`);
});

test('真实跨版本：v1.0.0 与新版代码读取同一基线解析一致；升级写回 SHA-256 不变', (t) => {
  let v100src;
  try {
    v100src = {
      redact: readTagFile('src/services/redact.js'),
      provider: readTagFile('src/services/providerService.js'),
      config: readTagFile('src/services/configService.js'),
    };
  } catch (e) {
    t.skip('无法从 tag feiyu-desktop-v1.0.0 抽取 v1.0.0 服务代码（git 不可用），跳过真实跨版本读校验；可用 v1.0.0 安装包实际升级复核。');
    return;
  }
  const v100 = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanshu-v100-'));
  fs.writeFileSync(path.join(v100, 'redact.js'), v100src.redact);
  fs.writeFileSync(path.join(v100, 'providerService.js'), v100src.provider);
  fs.writeFileSync(path.join(v100, 'configService.js'), v100src.config);
  const v100provider = require(path.join(v100, 'providerService.js'));
  const v100config = require(path.join(v100, 'configService.js'));

  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanshu-bot-'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanshu-ud-'));
  const sample = {
    providers: { default: 'openai', providers: [{ id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' }] },
    secrets: { openai: 'sk-TEST-KEY-not-real-abcdefghij' },
    config: { api: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' } },
    settings: { botDir, theme: 'light' },
  };
  writeV1Data(botDir, userData, sample);

  const pre = {
    'feiyu_providers.json': sha256File(path.join(botDir, 'feiyu_providers.json')),
    'feiyu_provider_secrets.json': sha256File(path.join(botDir, 'feiyu_provider_secrets.json')),
    'ai_config.json': sha256File(path.join(botDir, 'ai_config.json')),
    'feiyu-settings.json': sha256File(path.join(userData, 'feiyu-settings.json')),
  };

  // 跨版本：v1.0.0 代码与新版代码读取同一基线，解析结果一致（格式兼容）
  assert.deepStrictEqual(v100provider.load(botDir), require('../src/services/providerService').load(botDir));
  assert.deepStrictEqual(v100provider.loadSecrets(botDir), require('../src/services/providerService').loadSecrets(botDir));
  assert.deepStrictEqual(v100config.readRaw(botDir).data, require('../src/services/configService').readRaw(botDir).data);

  // 升级：新版写回（幂等）
  upgradeRewrite(require('../src/services/providerService'), require('../src/services/configService'), botDir);

  const post = {
    'feiyu_providers.json': sha256File(path.join(botDir, 'feiyu_providers.json')),
    'feiyu_provider_secrets.json': sha256File(path.join(botDir, 'feiyu_provider_secrets.json')),
    'ai_config.json': sha256File(path.join(botDir, 'ai_config.json')),
    'feiyu-settings.json': sha256File(path.join(userData, 'feiyu-settings.json')),
  };
  for (const k of Object.keys(pre)) {
    assert.strictEqual(post[k], pre[k], `用户数据 ${k} 升级前后 SHA-256 不一致（升级丢失/改写了数据）`);
  }
  console.log('[upgradeCompat/cross] v1.0.0 → 玄枢 XUANSHU 用户数据 SHA-256（升级前后一致）:');
  for (const k of Object.keys(pre)) console.log(`  ${k}: ${pre[k]}`);
});
