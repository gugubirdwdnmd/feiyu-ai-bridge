'use strict';
/**
 * mcpService.test.js —— 模块 D（MCP 导入与权限中心）单测。
 * 重点验证：只解析/审查/登记，绝不执行；环境变量回传掩码。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mcp = require('../src/services/mcpService');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-mcp-')); }

test('parseConfig: 解析标准 mcpServers 对象', () => {
  const r = mcp.parseConfig({ mcpServers: { 'fs-tool': { command: 'npx', args: ['-y', '@mcp/fs'] } } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.servers.length, 1);
  assert.strictEqual(r.servers[0].name, 'fs-tool');
  assert.strictEqual(r.servers[0].transport, 'stdio');
});

test('parseConfig: 接受 servers 数组形态', () => {
  const r = mcp.parseConfig({ servers: [{ name: 'a', url: 'https://example.com/mcp', transport: 'sse' }] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.servers[0].url, 'https://example.com/mcp');
});

test('parseConfig: 拒绝不认识的格式', () => {
  const r = mcp.parseConfig({ foo: 1 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors[0].includes('mcpServers'));
});

test('parseConfig: JSON 字符串语法错误被捕获', () => {
  const r = mcp.parseConfig('{bad json');
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors[0].includes('JSON'));
});

test('parseConfig: 非法服务器名称被拒', () => {
  const r = mcp.parseConfig({ mcpServers: { 'bad name!': { command: 'x' } } });
  assert.strictEqual(r.ok, false);
});

test('reviewServer: shell 元字符判定为高危', () => {
  const r = mcp.reviewServer({ argv: ['node', 'x.js; rm -rf /'] });
  assert.strictEqual(r.risk, 'high');
  assert.ok(r.findings.some((f) => f.code === 'shell_meta'));
});

test('reviewServer: 直接调用解释器判定为高危', () => {
  const r = mcp.reviewServer({ argv: ['powershell', '-c', 'echo hi'] });
  assert.ok(r.findings.some((f) => f.code === 'interpreter'));
});

test('reviewServer: 非 https 远程地址判定为高危', () => {
  const r = mcp.reviewServer({ url: 'http://example.com/mcp' });
  assert.ok(r.findings.some((f) => f.code === 'insecure_url'));
  assert.strictEqual(r.risk, 'high');
});

test('reviewServer: 普通 stdio 服务为中危', () => {
  const r = mcp.reviewServer({ argv: ['npx', '-y', 'pkg'] });
  assert.strictEqual(r.risk, 'medium');
});

test('reviewServer: env 含密钥键名时标记 secret_env', () => {
  const r = mcp.reviewServer({ argv: ['node', 'x.js'], env: { API_TOKEN: 'abc' } });
  assert.ok(r.findings.some((f) => f.code === 'secret_env'));
});

test('parseConfig: 统计高/中/低数量', () => {
  const r = mcp.parseConfig({
    mcpServers: {
      good: { command: 'npx', args: ['-y', 'pkg'] },
      bad: { command: 'powershell', args: ['-c', 'x'] },
    },
  });
  assert.strictEqual(r.counts.total, 2);
  assert.strictEqual(r.counts.high, 1);
  assert.strictEqual(r.counts.medium, 1);
});

test('parseConfig: 导入结果 enabled=false 且 executed=false（绝不自动执行）', () => {
  const r = mcp.parseConfig({ mcpServers: { a: { command: 'node', args: ['a.js'] } } });
  assert.strictEqual(r.servers[0].enabled, false);
  assert.strictEqual(r.servers[0].executed, false);
});

test('permissionModel: 按定义推导进程/网络/环境变量权限', () => {
  assert.ok(mcp.permissionModel({ command: 'node' }).some((p) => p.id === 'process.spawn'));
  assert.ok(mcp.permissionModel({ url: 'https://x/y' }).some((p) => p.id === 'network.outbound'));
  assert.ok(mcp.permissionModel({ command: 'n', env: { A: '1' } }).some((p) => p.id === 'env.inject'));
});

test('normalizeCommand: 单字符串按空白拆分并标记来源', () => {
  const r = mcp.normalizeCommand('npx -y pkg');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.argv, ['npx', '-y', 'pkg']);
  assert.strictEqual(r.fromString, true);
});

test('importConfig: 落盘后仍为禁用；列表回传 env 掩码', () => {
  const dir = tmpDir();
  try {
    const r = mcp.importConfig(dir, { mcpServers: { a: { command: 'node', args: ['a.js'], env: { MY_SECRET_TOKEN: 'super-secret-value' } } } });
    assert.strictEqual(r.ok, true);
    const list = mcp.list(dir);
    assert.strictEqual(list.servers.length, 1);
    assert.strictEqual(list.servers[0].enabled, false);
    // 不泄露明文
    assert.ok(!JSON.stringify(list).includes('super-secret-value'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('importConfig: 默认不覆盖同名，overwrite=true 才覆盖', () => {
  const dir = tmpDir();
  try {
    mcp.importConfig(dir, { mcpServers: { a: { command: 'node', args: ['v1.js'] } } });
    const r2 = mcp.importConfig(dir, { mcpServers: { a: { command: 'node', args: ['v2.js'] } } });
    assert.ok(r2.replaced.some((x) => x.name === 'a' && x.skipped === true));
    assert.ok(!JSON.stringify(mcp.list(dir)).includes('v2.js'));
    const r3 = mcp.importConfig(dir, { mcpServers: { a: { command: 'node', args: ['v2.js'] } } }, { overwrite: true });
    assert.strictEqual(r3.ok, true);
    assert.ok(JSON.stringify(mcp.list(dir)).includes('v2.js'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setEnabled: 仅登记状态，不启动任何东西', () => {
  const dir = tmpDir();
  try {
    mcp.importConfig(dir, { mcpServers: { a: { command: 'node', args: ['a.js'] } } });
    const r = mcp.setEnabled(dir, 'a', true);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(mcp.list(dir).servers[0].enabled, true);
    assert.ok(r.note.includes('不代表已运行'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('remove: 删除后列表为空', () => {
  const dir = tmpDir();
  try {
    mcp.importConfig(dir, { mcpServers: { a: { command: 'node' } } });
    assert.strictEqual(mcp.remove(dir, 'a').ok, true);
    assert.strictEqual(mcp.list(dir).servers.length, 0);
    assert.strictEqual(mcp.remove(dir, 'a').ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('exportAll: 导出为 mcpServers 结构', () => {
  const dir = tmpDir();
  try {
    mcp.importConfig(dir, { mcpServers: { a: { command: 'node', args: ['a.js'] } } });
    const e = mcp.exportAll(dir);
    assert.ok(e.payload.mcpServers.a);
    assert.strictEqual(e.payload.mcpServers.a.command, 'node');
    assert.deepStrictEqual(e.payload.mcpServers.a.args, ['a.js']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
