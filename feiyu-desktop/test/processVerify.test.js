'use strict';
/**
 * processVerify.test.js —— 启动「真实校验」相关单测。
 *
 * 覆盖：
 *  - cleanEnv：剥离电子壳环境变量，保留系统必需变量
 *  - launchAndVerify：成功（checkUp 就绪）/ 进程崩退（带退出码与 stderr 尾）/ 端口超时
 *  - startBotVerified：端口监听 → ok；端口始终不监听 → failed
 *
 * 说明：这些用例用假 spawn 造出可控的子进程（含 on/emit/stderr），
 * 在 Node 里验证「不再假成功」的核心承诺。
 */
const test = require('node:test');
const assert = require('node:assert');
const ps = require('../src/services/processService');

/** 可控子进程桩：支持 exit 事件与 stderr 数据推送。 */
function mockChild(pid) {
  const exitHandlers = [];
  const dataHandlers = [];
  return {
    pid,
    unref() {},
    on(ev, cb) { if (ev === 'exit') exitHandlers.push(cb); },
    emitExit(code, signal) { exitHandlers.forEach((cb) => cb(code, signal)); },
    stderr: {
      setEncoding() {},
      on(ev, cb) { if (ev === 'data') dataHandlers.push(cb); },
      emitData(s) { dataHandlers.forEach((cb) => cb(s)); },
    },
  };
}

test('cleanEnv 剥离电子壳变量，保留 PATH', () => {
  const pm = ps.createProcessManager({ deps: {} });
  const out = pm.cleanEnv({
    PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows',
    ELECTRON_RUN_AS_NODE: '1', ELECTRON_HOME: 'x',
    ATOM_SHELL_INTERNAL_LEAK: '1', NODE_OPTIONS: '--max-old-space-size=1',
  });
  assert.strictEqual(out.PATH, 'C:\\Windows');
  assert.strictEqual(out.SystemRoot, 'C:\\Windows');
  assert.strictEqual(out.ELECTRON_RUN_AS_NODE, undefined);
  assert.strictEqual(out.ELECTRON_HOME, undefined);
  assert.strictEqual(out.ATOM_SHELL_INTERNAL_LEAK, undefined);
  assert.strictEqual(out.NODE_OPTIONS, undefined);
});

test('launchAndVerify 成功：checkUp 立即就绪', async () => {
  const child = mockChild(4321);
  const deps = { spawn: () => child, execFile: (c, a, o, cb) => cb(null, ''), sleep: async () => {}, platform: 'win32' };
  const pm = ps.createProcessManager({ deps });
  const r = await pm.launchAndVerify(
    { command: 'node', args: ['ai_bridge.js'], cwd: process.cwd() },
    { checkUp: async () => true, timeoutMs: 3000 },
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.verified, true);
  assert.strictEqual(r.pid, 4321);
});

test('launchAndVerify 失败：进程立即退出，错误含退出码与 stderr 尾', async () => {
  const child = mockChild(5000);
  const deps = { spawn: () => child, execFile: (c, a, o, cb) => cb(null, ''), sleep: async () => {}, platform: 'win32' };
  const pm = ps.createProcessManager({ deps });
  const p = pm.launchAndVerify(
    { command: 'node', args: ['ai_bridge.js'], cwd: process.cwd() },
    { checkUp: async () => false, timeoutMs: 3000 },
  );
  // 同步喂入 stderr 与退出事件（此刻 exit/ stderr 监听已挂好）
  child.stderr.emitData('Error: Cannot find module ai_bridge.js\n');
  child.emitExit(1, null);
  const r = await p;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.verified, false);
  assert.strictEqual(r.exitCode, 1);
  assert.match(r.error, /进程已退出/);
  assert.match(r.error, /Cannot find module/);
});

test('launchAndVerify 失败：端口始终不监听 → 超时报错', async () => {
  const child = mockChild(6000);
  const deps = { spawn: () => child, execFile: (c, a, o, cb) => cb(null, ''), sleep: (ms) => new Promise((r) => setTimeout(r, 20)), platform: 'win32' };
  const pm = ps.createProcessManager({ deps });
  const r = await pm.launchAndVerify(
    { command: 'node', args: ['x.js'], cwd: process.cwd() },
    { port: 3999, timeoutMs: 200 },
  );
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /未检测到服务就绪/);
});

test('startBotVerified 成功：AI 桥与 NapCat 端口均监听', async () => {
  const os = require('os'); const fs = require('fs'); const path = require('path');
  const ncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat-'));
  fs.writeFileSync(path.join(ncDir, 'index.js'), '');
  try {
    const netstat = '  TCP    0.0.0.0:3001    0.0.0.0:0    LISTENING    111\n  TCP    0.0.0.0:3000    0.0.0.0:0    LISTENING    222\n';
    const deps = { spawn: () => mockChild(999), execFile: (c, a, o, cb) => cb(null, netstat), sleep: async () => {}, platform: 'win32' };
    const pm = ps.createProcessManager({ deps });
    const r = await pm.startBotVerified(process.cwd(), { napcat: { account: '123', passwordMd5: 'abc' }, napcatDir: ncDir, timeoutMs: 2000 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.failed.length, 0);
    assert.strictEqual(r.started.bridge.ok, true);
    assert.strictEqual(r.started.napcat.ok, true);
  } finally { fs.rmSync(ncDir, { recursive: true, force: true }); }
});

test('startBotVerified：NapCat 目录缺少 index.js → 明确失败', async () => {
  const deps = { spawn: () => mockChild(777), execFile: (c, a, o, cb) => cb(null, ''), sleep: async () => {}, platform: 'win32' };
  const pm = ps.createProcessManager({ deps });
  const r = await pm.startBotVerified(process.cwd(), { napcat: { account: '123', passwordMd5: 'x' }, napcatDir: process.cwd(), onlyNapcat: true, timeoutMs: 200 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.failed.find((f) => f.id === 'napcat' && /index\.js/.test(f.error)));
});

test('startBotVerified 失败：端口始终不监听 → failed 记录 bridge', async () => {
  const deps = { spawn: () => mockChild(888), execFile: (c, a, o, cb) => cb(null, ''), sleep: (ms) => new Promise((r) => setTimeout(r, 20)), platform: 'win32' };
  const pm = ps.createProcessManager({ deps });
  const r = await pm.startBotVerified(process.cwd(), { napcat: null, timeoutMs: 200 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.failed.find((f) => f.id === 'bridge'), '应把未就绪的 bridge 记入 failed');
});
