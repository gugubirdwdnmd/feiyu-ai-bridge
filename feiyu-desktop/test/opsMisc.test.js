'use strict';
/**
 * opsMisc.test.js —— 模块 E（技能树）/ C（环境检测）/ I（成本）/ J（诊断通知）单测。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sk = require('../src/services/skillTreeService');
const env = require('../src/services/envDetector');
const cost = require('../src/services/costService');
const diag = require('../src/services/diagnosticService');

function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'feiyu-ops-')); }

/* ---------------- E. 技能树 ---------------- */

test('buildTree: 未知分类归入未分类并给出警告', () => {
  const r = sk.buildTree([{ id: 'a', name: 'A', category: 'not-exist' }], {});
  assert.strictEqual(r.byCategory.uncategorized.length, 1);
  assert.ok(r.issues.some((i) => i.code === 'unknown_category'));
});

test('buildTree: 重复 id 记为 error，重复名称记为 warn', () => {
  const r = sk.buildTree([{ id: 'a', name: '同名' }, { id: 'a', name: '同名' }], {});
  assert.ok(r.issues.some((i) => i.code === 'duplicate_id' && i.level === 'error'));
  assert.ok(r.issues.some((i) => i.code === 'duplicate_name' && i.level === 'warn'));
});

test('buildTree: 缺失依赖被报出', () => {
  const r = sk.buildTree([{ id: 'a', name: 'A', requires: ['ghost'] }], {});
  assert.ok(r.issues.some((i) => i.code === 'missing_dependency'));
});

test('buildTree: 依赖环被检测', () => {
  const r = sk.buildTree([{ id: 'a', name: 'A', requires: ['b'] }, { id: 'b', name: 'B', requires: ['a'] }], {});
  assert.ok(r.issues.some((i) => i.code === 'dependency_cycle'));
});

test('buildTree: 同分类下重复触发词给出冲突提示', () => {
  const r = sk.buildTree([
    { id: 'a', name: 'A', category: 'chat', triggers: ['总结'] },
    { id: 'b', name: 'B', category: 'chat', triggers: ['总结'] },
  ], {});
  assert.ok(r.issues.some((i) => i.code === 'trigger_conflict'));
});

test('buildTree: 统计口径正确', () => {
  const r = sk.buildTree([
    { id: 'a', name: 'A', category: 'chat', enabled: true },
    { id: 'b', name: 'B', category: 'draw', enabled: false },
  ], {});
  assert.strictEqual(r.stats.skills, 2);
  assert.strictEqual(r.stats.enabled, 1);
});

test('addCategory / removeCategory: 自定义分类可增可删，内置不可删', () => {
  const dir = tmpDir();
  try {
    const a = sk.addCategory(dir, { id: 'mine', name: '我的' });
    assert.strictEqual(a.ok, true);
    assert.ok(sk.allCategories(dir).some((c) => c.id === 'mine'));
    assert.strictEqual(sk.addCategory(dir, { id: 'mine', name: '重复' }).ok, false);
    assert.strictEqual(sk.removeCategory(dir, 'mine').ok, true);
    assert.strictEqual(sk.removeCategory(dir, 'chat').ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('validateCategory: 拒绝大写/非法 id 与不存在的父分类', () => {
  assert.strictEqual(sk.validateCategory({ id: 'Bad', name: 'x' }, new Set()).valid, false);
  assert.strictEqual(sk.validateCategory({ id: 'ok', name: 'x', parent: 'ghost' }, new Set(['ok'])).valid, false);
});

/* ---------------- C. 环境检测（只读、不伪造） ---------------- */

test('detectComfyRoot: 目录不存在 → missing 而不是编造', () => {
  const r = env.detectComfyRoot('D:/definitely/not/here', fs);
  assert.strictEqual(r.status, 'missing');
  assert.ok(r.error);
});

test('detectComfyRoot: 缺少 main.py → missing', () => {
  const dir = tmpDir('feiyu-comfy-');
  try {
    fs.writeFileSync(path.join(dir, 'readme.txt'), 'x');
    const r = env.detectComfyRoot(dir, fs);
    assert.strictEqual(r.status, 'missing');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('detectComfyRoot / scanModels: 真实目录结构被识别', () => {
  const dir = tmpDir('feiyu-comfy2-');
  try {
    fs.writeFileSync(path.join(dir, 'main.py'), '');
    fs.mkdirSync(path.join(dir, 'models'));
    fs.mkdirSync(path.join(dir, 'models', 'checkpoints'));
    fs.writeFileSync(path.join(dir, 'models', 'checkpoints', 'a.safetensors'), Buffer.alloc(1024));
    const root = env.detectComfyRoot(dir, fs);
    assert.strictEqual(root.status, 'detected');
    assert.strictEqual(root.value.looksLikeComfyUI, true);
    const m = env.scanModels(dir, fs);
    assert.strictEqual(m.status, 'detected');
    assert.strictEqual(m.value.totalFiles, 1);
    assert.strictEqual(m.value.totalBytes, 1024);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('detectGpu: 没有 runCommand 时返回 unknown（不伪造 GPU）', async () => {
  const r = await env.detectGpu({});
  assert.strictEqual(r.gpus.status, 'unknown');
  assert.ok(r.note);
});

test('detectGpu: 命令失败返回 unknown 并带原因', async () => {
  const r = await env.detectGpu({ runCommand: async () => ({ ok: false, error: 'not found' }) });
  assert.strictEqual(r.gpus.status, 'unknown');
  assert.strictEqual(r.gpus.value, null);
});

test('detectGpu: 成功时解析 GPU 名称与显存', async () => {
  const r = await env.detectGpu({ runCommand: async () => ({ ok: true, stdout: 'NVIDIA RTX 4090, 24564, 551.23\n' }) });
  assert.strictEqual(r.gpus.status, 'detected');
  assert.strictEqual(r.gpus.value[0].name, 'NVIDIA RTX 4090');
  assert.strictEqual(r.gpus.value[0].vramTotalMB, 24564);
});

test('detectPython: python 不可用时回退 python3', async () => {
  const r = await env.detectPython({
    runCommand: async (cmd) => (cmd === 'python3' ? { ok: true, stdout: 'Python 3.11.5' } : { ok: false, error: 'nf' }),
  });
  assert.strictEqual(r.status, 'detected');
  assert.strictEqual(r.value, 'Python 3.11.5');
});

test('detectDiskSpace: 无 statfs 支持时 unknown', async () => {
  const r = await env.detectDiskSpace('.', { statfs: null });
  assert.strictEqual(r.status, 'unknown');
});

test('detectEnvironment: unknown 全部带原因，不填假数值', async () => {
  const r = await env.detectEnvironment({ dir: '' });
  assert.strictEqual(r.ok, true);
  const gpu = r.checks.find((c) => c.id === 'gpu');
  assert.strictEqual(gpu.status, 'unknown');
  assert.ok(gpu.detail);
  assert.strictEqual(r.ready, false);
});

/* ---------------- I. 成本 ---------------- */

const PRICE = { version: '2026-01', currency: 'CNY', unit: 'M', models: { m1: { input: 1, output: 2 } } };

test('buildCostReport: 无价格表时金额为 null，不给 0 元假象', () => {
  const r = cost.buildCostReport({ totalTokens: 100, modelUsage: { m1: { prompt: 10, completion: 5 } } }, null, {});
  assert.strictEqual(r.priced, false);
  assert.strictEqual(r.totals.cost, null);
  assert.ok(r.note.includes('价格表'));
  assert.strictEqual(r.estimate, true);
});

test('buildCostReport: 有价格表时按模型计算并标注估算', () => {
  const r = cost.buildCostReport({ totalTokens: 15, modelUsage: { m1: { prompt: 1e6, completion: 1e6 } } }, PRICE, {});
  assert.strictEqual(r.priced, true);
  assert.strictEqual(r.estimate, true);
  assert.strictEqual(r.byModel[0].cost, 3);
  assert.strictEqual(r.coverage.complete, true);
});

test('buildCostReport: 未定价模型被单列，不计入总额', () => {
  const r = cost.buildCostReport({ modelUsage: { m1: { prompt: 1e6, completion: 0 }, mX: { prompt: 1e6, completion: 0 } } }, PRICE, {});
  assert.deepStrictEqual(r.unpricedModels, ['mX']);
  assert.strictEqual(r.totals.cost, 1);
  assert.strictEqual(r.coverage.complete, false);
});

test('buildCostReport: 预算超限给出 exceeded', () => {
  const r = cost.buildCostReport({ modelUsage: { m1: { prompt: 1e6, completion: 0 } } }, PRICE, { budget: { monthly: 0.5 } });
  assert.strictEqual(r.budget.level, 'exceeded');
});

test('buildCostReport: 预算接近阈值给出 warn', () => {
  const r = cost.buildCostReport({ modelUsage: { m1: { prompt: 0.9e6, completion: 0 } } }, PRICE, { budget: { monthly: 1, warnRatio: 0.8 } });
  assert.strictEqual(r.budget.level, 'warn');
});

test('buildCostReport: 恒带免责声明', () => {
  assert.ok(cost.buildCostReport({}, null, {}).disclaimer.includes('估算'));
});

test('setBudget/validateBudget: 校验非负与比例范围', () => {
  const dir = tmpDir();
  try {
    assert.strictEqual(cost.setBudget(dir, { monthly: -1 }).ok, false);
    assert.strictEqual(cost.setBudget(dir, { monthly: 10, warnRatio: 2 }).ok, false);
    assert.strictEqual(cost.setBudget(dir, { monthly: 10, warnRatio: 0.8 }).ok, true);
    assert.strictEqual(cost.getBudget(dir).monthly, 10);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ---------------- J. 诊断与通知 ---------------- */

test('collectDiagnostics: 未配置 botDir 时给出结构化警告', () => {
  const r = diag.collectDiagnostics({ botDir: '', userDataDir: '', appVersion: '1.0.0' });
  assert.strictEqual(r.schemaVersion, diag.SCHEMA_VERSION);
  assert.ok(r.timeline.some((t) => t.level === 'warn'));
  assert.strictEqual(r.paths.botDirConfigured, false);
});

test('collectDiagnostics: 只输出配置键名，不输出值', () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'ai_config.json'), JSON.stringify({ api: { apiKeyLike: 'SHOULD-NOT-APPEAR' } }));
    fs.writeFileSync(path.join(dir, 'ai_bridge.js'), '');
    const r = diag.collectDiagnostics({ botDir: dir, appVersion: '1.0.0' });
    const json = JSON.stringify(r);
    assert.ok(r.config.keys.includes('api'));
    assert.ok(!json.includes('SHOULD-NOT-APPEAR'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('collectDiagnostics: 秘密文件只报存在性', () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'secrets.json'), '{"apiKey":"sk-abcdefghijklmnop"}');
    const r = diag.collectDiagnostics({ botDir: dir });
    assert.strictEqual(r.secrets.botSecretsPresent, true);
    assert.ok(!JSON.stringify(r).includes('sk-abcdefghijklmnop'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('buildBundle: 输出可解析 JSON 且带脱敏说明', () => {
  const d = diag.collectDiagnostics({ botDir: '', appVersion: '1.0.0' });
  const b = diag.buildBundle(d);
  const o = JSON.parse(b);
  assert.strictEqual(o.kind, 'feiyu-desktop-diagnostic');
  assert.ok(o.note.includes('脱敏'));
});

test('buildBundle: 文本中的 sk- 密钥被脱敏', () => {
  const b = diag.buildBundle({ note: 'key sk-abcdefghijklmnopqrstuvwx leaked' });
  assert.ok(!b.includes('sk-abcdefghijklmnopqrstuvwx'));
});

test('pushNotification/listNotifications: 追加并按级别过滤，未读计数正确', () => {
  const dir = tmpDir();
  try {
    diag.pushNotification(dir, { title: 'A', message: 'a', level: 'info' });
    diag.pushNotification(dir, { title: 'B', message: 'b', level: 'error' });
    const all = diag.listNotifications(dir);
    assert.strictEqual(all.total, 2);
    assert.strictEqual(all.unread, 2);
    const onlyErr = diag.listNotifications(dir, { level: 'error' });
    assert.strictEqual(onlyErr.items.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('markRead: 单条与全部标记', () => {
  const dir = tmpDir();
  try {
    const a = diag.pushNotification(dir, { title: 'A', message: 'a' });
    diag.pushNotification(dir, { title: 'B', message: 'b' });
    assert.strictEqual(diag.markRead(dir, a.item.id).unread, 1);
    assert.strictEqual(diag.markRead(dir, 'all').unread, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pushNotification: 通知正文也被脱敏（防误把密钥写进通知）', () => {
  const dir = tmpDir();
  try {
    const r = diag.pushNotification(dir, { title: 'k', message: 'sk-abcdefghijklmnopqrstuvwx' });
    assert.ok(!r.item.message.includes('sk-abcdefghijklmnopqrstuvwx'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('clearNotifications: 清空', () => {
  const dir = tmpDir();
  try {
    diag.pushNotification(dir, { title: 'A', message: 'a' });
    diag.clearNotifications(dir);
    assert.strictEqual(diag.listNotifications(dir).total, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
