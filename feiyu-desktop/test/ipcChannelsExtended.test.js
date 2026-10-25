'use strict';
/**
 * ipcChannelsExtended.test.js —— 新增 IPC 通道的参数校验 + UI 一致性 / 隐私回归守护。
 *
 * 这里同时承担两条「回归防线」：
 *  1) 导航一致性：index.html 里每个 data-page 必须在 renderer.js 的页面映射里有入口，
 *     且渲染层引用的通道必须都存在于 CHANNELS 注册表（防止拼错通道名后静默失效）。
 *  2) 隐私回归：输入框 placeholder 不得再出现真实 QQ 号形态的数字串
 *     （历史上曾把真实 QQ 号写成占位符并推送到公开仓库）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { CHANNELS, validate } = require('../src/services/ipcChannels');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer', 'renderer.js');
const INDEX = path.join(ROOT, 'renderer', 'index.html');

test('CHANNELS 所有通道值唯一（防止复制粘贴造成冲突）', () => {
  const values = Object.values(CHANNELS);
  assert.strictEqual(new Set(values).size, values.length);
});

test('新通道全部注册了 validate 分支（不是落进 default 的未知通道）', () => {
  const newOnes = [
    CHANNELS.NAPCAT_QR_PLAN, CHANNELS.NAPCAT_QR_START, CHANNELS.NAPCAT_QR_POLL,
    CHANNELS.NAPCAT_INSTANCE_LIST, CHANNELS.NAPCAT_INSTANCE_SAVE, CHANNELS.NAPCAT_INSTANCE_DELETE,
    CHANNELS.SERVICE_LIST, CHANNELS.SERVICE_SAVE, CHANNELS.SERVICE_DELETE,
    CHANNELS.SERVICE_PRESETS, CHANNELS.SERVICE_PLAN, CHANNELS.SERVICE_START_PRESET,
    CHANNELS.SERVICE_PRESET_SAVE, CHANNELS.SERVICE_PRESET_DELETE,
    CHANNELS.ENV_DETECT,
    CHANNELS.MCP_LIST, CHANNELS.MCP_PARSE, CHANNELS.MCP_IMPORT, CHANNELS.MCP_SET_ENABLED,
    CHANNELS.MCP_DELETE, CHANNELS.MCP_EXPORT,
    CHANNELS.SKILL_TREE, CHANNELS.SKILL_CATEGORY_LIST, CHANNELS.SKILL_CATEGORY_ADD, CHANNELS.SKILL_CATEGORY_DELETE,
    CHANNELS.MARKET_SOURCES, CHANNELS.MARKET_PARSE, CHANNELS.MARKET_FETCH, CHANNELS.MARKET_PLAN,
    CHANNELS.BACKUP_LIST, CHANNELS.BACKUP_CREATE, CHANNELS.BACKUP_DIFF, CHANNELS.BACKUP_RESTORE, CHANNELS.BACKUP_DELETE,
    CHANNELS.WORKFLOW_LIST, CHANNELS.WORKFLOW_GET, CHANNELS.WORKFLOW_SAVE, CHANNELS.WORKFLOW_DELETE, CHANNELS.WORKFLOW_RUN,
    CHANNELS.COST_REPORT, CHANNELS.COST_BUDGET_GET, CHANNELS.COST_BUDGET_SET,
    CHANNELS.DIAG_COLLECT, CHANNELS.DIAG_EXPORT,
    CHANNELS.NOTIFY_LIST, CHANNELS.NOTIFY_MARK_READ, CHANNELS.NOTIFY_CLEAR,
  ];
  for (const ch of newOnes) {
    const r = validate(ch, {});
    assert.ok(!String(r.error || '').includes('未知通道'), '通道未注册校验分支: ' + ch);
  }
});

test('SERVICE_START_PRESET 必须带 presetId，且 force 只能是布尔', () => {
  assert.strictEqual(validate(CHANNELS.SERVICE_START_PRESET, {}).ok, false);
  assert.strictEqual(validate(CHANNELS.SERVICE_START_PRESET, { presetId: 'qq-bot' }).ok, true);
  assert.strictEqual(validate(CHANNELS.SERVICE_START_PRESET, { presetId: 'x', force: 'yes' }).ok, false);
});

test('MCP_PARSE / MCP_IMPORT 拒绝非对象非字符串 payload', () => {
  assert.strictEqual(validate(CHANNELS.MCP_PARSE, { payload: 123 }).ok, false);
  assert.strictEqual(validate(CHANNELS.MCP_PARSE, { payload: '{}' }).ok, true);
  assert.strictEqual(validate(CHANNELS.MCP_IMPORT, {}).ok, false);
});

test('MCP_SET_ENABLED 强制布尔 enabled', () => {
  assert.strictEqual(validate(CHANNELS.MCP_SET_ENABLED, { name: 'a', enabled: true }).ok, true);
  assert.strictEqual(validate(CHANNELS.MCP_SET_ENABLED, { name: 'a', enabled: 'yes' }).ok, false);
});

test('BACKUP_RESTORE 校验 id 与布尔开关', () => {
  assert.strictEqual(validate(CHANNELS.BACKUP_RESTORE, {}).ok, false);
  assert.strictEqual(validate(CHANNELS.BACKUP_RESTORE, { id: 'bak-1' }).ok, true);
  assert.strictEqual(validate(CHANNELS.BACKUP_RESTORE, { id: 'bak-1', includeSecret: 'yes' }).ok, false);
});

test('WORKFLOW_RUN 校验 id / dryRun / vars', () => {
  assert.strictEqual(validate(CHANNELS.WORKFLOW_RUN, {}).ok, false);
  assert.strictEqual(validate(CHANNELS.WORKFLOW_RUN, { id: 'w1' }).ok, true);
  assert.strictEqual(validate(CHANNELS.WORKFLOW_RUN, { id: 'w1', dryRun: 'no' }).ok, false);
  assert.strictEqual(validate(CHANNELS.WORKFLOW_RUN, { id: 'w1', vars: 'x' }).ok, false);
});

test('COST_REPORT 复用 range 白名单', () => {
  assert.strictEqual(validate(CHANNELS.COST_REPORT, { range: '7d' }).ok, true);
  assert.strictEqual(validate(CHANNELS.COST_REPORT, { range: 'bogus' }).ok, false);
});

test('COST_BUDGET_SET 要求 budget 对象', () => {
  assert.strictEqual(validate(CHANNELS.COST_BUDGET_SET, {}).ok, false);
  assert.strictEqual(validate(CHANNELS.COST_BUDGET_SET, { budget: {} }).ok, true);
});

test('NOTIFY_LIST 限制 limit 范围 1-200', () => {
  assert.strictEqual(validate(CHANNELS.NOTIFY_LIST, { limit: 0 }).ok, false);
  assert.strictEqual(validate(CHANNELS.NOTIFY_LIST, { limit: 201 }).ok, false);
  assert.strictEqual(validate(CHANNELS.NOTIFY_LIST, { limit: 50 }).ok, true);
});

test('MARKET_FETCH 要求 sourceId + endpoint', () => {
  assert.strictEqual(validate(CHANNELS.MARKET_FETCH, {}).ok, false);
  assert.strictEqual(validate(CHANNELS.MARKET_FETCH, { sourceId: 'generic', endpoint: 'https://a/b' }).ok, true);
  assert.strictEqual(validate(CHANNELS.MARKET_FETCH, { sourceId: 'generic', endpoint: 'https://a/b', token: 1 }).ok, false);
});

test('UI：index.html 的每个 data-page 都能在 renderer 的页面映射里找到', () => {
  const html = fs.readFileSync(INDEX, 'utf-8');
  const pages = [...html.matchAll(/data-page="([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]);
  assert.ok(pages.length >= 14, '导航项数量异常: ' + pages.length);
  const rjs = fs.readFileSync(RENDERER, 'utf-8');
  const mapMatch = rjs.match(/const map = \{([\s\S]*?)\};/);
  assert.ok(mapMatch, '未找到渲染层页面映射表');
  const mapBody = mapMatch[1];
  for (const p of pages) {
    assert.ok(new RegExp('\\b' + p + ':').test(mapBody), '页面缺少渲染入口: ' + p);
  }
});

test('UI：渲染层引用的通道必须都存在于 CHANNELS', () => {
  const rjs = fs.readFileSync(RENDERER, 'utf-8');
  const refs = [...rjs.matchAll(/\bC\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]);
  const unique = [...new Set(refs)];
  assert.ok(unique.length > 50, '通道引用数异常: ' + unique.length);
  const missing = unique.filter((k) => !(k in CHANNELS));
  assert.deepStrictEqual(missing, [], '以下通道在 CHANNELS 中不存在: ' + missing.join(', '));
});

test('隐私回归：placeholder 中不得出现真实 QQ 号形态（10 位数字）', () => {
  const rjs = fs.readFileSync(RENDERER, 'utf-8');
  // 形如 placeholder="如 1234567890" —— 历史上这里曾写死真实号码
  const hits = [...rjs.matchAll(/placeholder="[^"]*?\b\d{9,11}\b[^"]*?"/g)].map((m) => m[0]);
  assert.deepStrictEqual(hits, [], '发现疑似真实号码的占位符: ' + hits.join(' | '));
});

test('隐私回归：前后端源码不得包含 sk- 形态的硬编码密钥', () => {
  const files = [
    path.join(ROOT, 'src', 'ipc', 'handlers.js'),
    path.join(ROOT, 'src', 'main.js'),
    RENDERER,
  ];
  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf-8');
    const m = txt.match(/sk-[A-Za-z0-9]{20,}/g);
    assert.strictEqual(m, null, '发现硬编码密钥形态字符串: ' + f);
  }
});

test('安全检查：新增服务模块中没有任何 eval / new Function', () => {
  const dir = path.join(ROOT, 'src', 'services');
  const names = ['serviceRegistry', 'backupService', 'mcpService', 'workflowService', 'diagnosticService',
    'napcatLoginService', 'marketService', 'skillTreeService', 'envDetector', 'costService'];
  for (const n of names) {
    const txt = fs.readFileSync(path.join(dir, n + '.js'), 'utf-8');
    assert.ok(!/\beval\s*\(/.test(txt), n + ' 含 eval');
    assert.ok(!/new\s+Function\s*\(/.test(txt), n + ' 含 new Function');
  }
});

test('安全检查：workflow 的 mcp/服务调用不经 shell（无 child_process 直接引用）', () => {
  const dir = path.join(ROOT, 'src', 'services');
  for (const n of ['workflowService', 'mcpService', 'serviceRegistry']) {
    const txt = fs.readFileSync(path.join(dir, n + '.js'), 'utf-8');
    assert.ok(!/require\(['"]child_process['"]\)/.test(txt), n + ' 不应直接引 child_process');
  }
});
