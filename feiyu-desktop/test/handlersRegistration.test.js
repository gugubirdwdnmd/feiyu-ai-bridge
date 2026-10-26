'use strict';
/**
 * handlersRegistration.test.js —— Main 进程 IPC 注册的运行时冒烟测试。
 *
 * 为什么需要它：`node --check` 只查语法，查不出「通道声明了却没注册处理器」
 * 或「处理器一被调用就抛 ReferenceError」。这里用假的 electron / ipcMain
 * 真正跑一遍 registerHandlers，然后逐通道断言。
 *
 * 安全：所有涉及机器人的操作都必须在「未配置机器人目录」时**优雅返回错误**，
 * 绝不能抛异常或读写任何真实目录。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// 用假的 electron 模块替换真实模块（registerHandlers 顶层会 require('electron')）
const originalLoad = Module._load;
let electronStubUsed = false;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    electronStubUsed = true;
    return {
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      safeStorage: { isEncryptionAvailable: () => false },
      app: { getVersion: () => '1.1.0', getPath: () => os.tmpdir() },
    };
  }
  return originalLoad.apply(this, arguments);
};

const { CHANNELS, EVENT_CHANNELS } = require('../src/services/ipcChannels');
const { registerHandlers } = require('../src/ipc/handlers');
Module._load = originalLoad;

function buildHarness(userDataDir) {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, fn) {
      assert.ok(!handlers.has(channel), '通道被重复注册: ' + channel);
      handlers.set(channel, fn);
    },
  };
  const pm = {
    getStatus: async () => ({ bridge: { running: false, pid: null, port: 3001 }, napcat: { running: false, pid: null, port: 3000 } }),
    preCheck: async () => ({ alreadyRunning: false, status: await pm.getStatus() }),
    findPortOwner: async () => null,
    startBot: () => ({ started: {}, pids: [] }),
    stopByPids: async () => ({ stopped: true }),
    resolveNodeBin: () => 'node',
    spawnDetached: () => ({ ok: false, error: '测试环境不启动进程' }),
    PORTS: { bridge: 3001, napcat: 3000 },
  };
  registerHandlers({ ipcMain, getUserDataDir: () => userDataDir, getAppVersion: () => '1.1.0', pm });
  return { handlers, pm };
}

test('electron 被替换成了桩（确保测试不依赖真实 Electron 运行时）', () => {
  assert.strictEqual(electronStubUsed, true);
});

test('CHANNELS 里每个通道都注册了处理器', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-reg-'));
  try {
    const { handlers } = buildHarness(dir);
    // 单向推送通道（主→渲染事件）不需要 handler；其余每个通道都必须注册
    const missing = Object.values(CHANNELS).filter((ch) => !handlers.has(ch) && !EVENT_CHANNELS.includes(ch));
    assert.deepStrictEqual(missing, [], '以下通道没有注册处理器: ' + missing.join(', '));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('未配置机器人目录时，涉及目录的通道优雅返回错误而不抛异常', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-reg2-'));
  try {
    const { handlers } = buildHarness(dir);
    const calls = [
      [CHANNELS.CONFIG_READ, undefined],
      [CHANNELS.SKILL_LIST, undefined],
      [CHANNELS.SKILL_TREE, undefined],
      [CHANNELS.MCP_LIST, undefined],
      [CHANNELS.MCP_EXPORT, undefined],
      [CHANNELS.BACKUP_LIST, undefined],
      [CHANNELS.WORKFLOW_LIST, undefined],
      [CHANNELS.NAPCAT_INSTANCE_LIST, undefined],
      [CHANNELS.SERVICE_LIST, undefined],
      [CHANNELS.COST_REPORT, { range: 'today' }],
      [CHANNELS.ENV_DETECT, {}],
      [CHANNELS.DIAG_COLLECT, undefined],
    ];
    for (const [ch, args] of calls) {
      const fn = handlers.get(ch);
      const r = await fn({}, args);
      assert.strictEqual(typeof r, 'object', ch + ' 应返回对象');
      assert.ok(r.ok === false || r.ok === true, ch + ' 缺少 ok 字段');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('参数校验在业务逻辑之前生效（非法参数不会触碰文件）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-reg3-'));
  try {
    const { handlers } = buildHarness(dir);
    const r1 = await handlers.get(CHANNELS.MCP_SET_ENABLED)({}, { name: 123, enabled: true });
    assert.strictEqual(r1.ok, false);
    assert.ok(String(r1.error).includes('name'));
    const r2 = await handlers.get(CHANNELS.BACKUP_RESTORE)({}, { id: 5 });
    assert.strictEqual(r2.ok, false);
    const r3 = await handlers.get(CHANNELS.WORKFLOW_SAVE)({}, { workflow: 'not-object' });
    assert.strictEqual(r3.ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('通知中心通道在无 botDir 时仍可用（存 userData，不依赖机器人目录）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-reg4-'));
  try {
    const { handlers } = buildHarness(dir);
    const list = await handlers.get(CHANNELS.NOTIFY_LIST)({}, { limit: 10 });
    assert.strictEqual(list.ok, true);
    assert.ok(Array.isArray(list.items));
    const cleared = await handlers.get(CHANNELS.NOTIFY_CLEAR)({});
    assert.strictEqual(cleared.ok, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('市场来源 / 服务预设 / 通道计划等只读通道可直接响应', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-reg5-'));
  try {
    const { handlers } = buildHarness(dir);
    const src = await handlers.get(CHANNELS.MARKET_SOURCES)({});
    assert.strictEqual(src.ok, true);
    assert.ok(src.sources.length >= 3);
    const presets = await handlers.get(CHANNELS.SERVICE_PRESETS)({});
    assert.strictEqual(presets.ok, true);
    const plan = await handlers.get(CHANNELS.NAPCAT_QR_PLAN)({});
    assert.strictEqual(plan.ok, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('二维码登录：未配置接口时明确返回 needsEndpoint，不伪造二维码', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-reg6-'));
  try {
    const { handlers } = buildHarness(dir);
    const r = await handlers.get(CHANNELS.NAPCAT_QR_START)({}, {});
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.needsEndpoint, true);
    assert.strictEqual(r.session.qrImage, undefined);
    assert.ok(r.session.message.includes('尚未配置'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('二维码登录：传入已取得的载荷可推进到 pending 且只回传掩码令牌', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-reg7-'));
  try {
    const { handlers } = buildHarness(dir);
    const r = await handlers.get(CHANNELS.NAPCAT_QR_START)({}, { qrPayload: { qrcode: 'IMG', token: 'tok-abcdef123456' } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.session.state, 'pending');
    assert.ok(r.session.qrImage.startsWith('data:image/png;base64,'));
    assert.ok(!JSON.stringify(r).includes('tok-abcdef123456'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('工作流执行：未配置机器人目录时给出错误而不是崩溃', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-reg8-'));
  try {
    const { handlers } = buildHarness(dir);
    const r = await handlers.get(CHANNELS.WORKFLOW_RUN)({}, { id: 'nope', dryRun: true });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
