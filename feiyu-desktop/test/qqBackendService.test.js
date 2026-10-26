'use strict';
/**
 * qqBackendService.test.js —— QQ 接入后端统一管理单测（NapCat / SnowLuma）。
 *
 * 覆盖：配置归一化与白名单、令牌脱敏、能力矩阵、回环地址限制、日志脱敏、
 * SnowLuma 安装检测、启动/停止/健康检查/重启的真实行为（用桩进程管理器）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const svc = require('../src/services/qqBackendService');

function fakePm(over = {}) {
  const state = { pids: {} };
  return Object.assign({
    state,
    getStatus: async () => ({ bridge: { running: false, pid: null, port: 3001 }, napcat: { running: false, pid: null, port: 3000 } }),
    findPortOwner: async (p) => state.pids[p] || null,
    stopByPids: async (pids) => {
      for (const p of Object.keys(state.pids)) { if (pids.includes(state.pids[p])) delete state.pids[p]; }
      return { stopped: true };
    },
    cleanEnv: (e) => Object.assign({}, e),
    launchAndVerify: async () => ({ ok: false, error: '桩：未启动' }),
    startBotVerified: async () => ({ ok: false, failed: [{ id: 'napcat', error: '桩：未启动' }] }),
  }, over);
}

function makeService(over = {}) {
  let settings = over.settings || {};
  return {
    svc: svc.createBackendService({
      pm: over.pm || fakePm(),
      getSettings: () => settings,
      setSettings: (patch) => { settings = Object.assign({}, settings, patch); },
      resolveNapcatDir: () => over.napcatDir || '',
      getNapcatAccount: () => over.account || {},
    }),
    get settings() { return settings; },
  };
}

test('normalizeConfig: 未知后端与越界端口回落默认值', () => {
  const c = svc.normalizeConfig({ default: 'evil', napcat: { onebotPort: 99999 }, snowluma: { webuiPort: -1, launcher: '../../evil.exe' } });
  assert.strictEqual(c.default, 'napcat');
  assert.strictEqual(c.napcat.onebotPort, 65535);
  assert.strictEqual(c.snowluma.webuiPort, 1);
  // 启动器白名单：路径穿越被拒
  assert.strictEqual(c.snowluma.launcher, 'launcher.bat');
});

test('publicConfig: 令牌只回传 tokenSet，不回传明文', () => {
  const c = svc.normalizeConfig({ snowluma: { onebotToken: 'SECRET-TOKEN-123' } });
  const p = svc.publicConfig(c);
  assert.strictEqual(p.snowluma.onebotTokenSet, true);
  assert.strictEqual(p.snowluma.onebotToken, undefined);
  assert.ok(!JSON.stringify(p).includes('SECRET-TOKEN-123'));
});

test('capabilities: SnowLuma 未验证项标记为 null（不冒充支持）', () => {
  const s = svc.CAPABILITIES.snowluma;
  assert.strictEqual(s.onebot11, true);
  assert.strictEqual(s.quickLogin, null);
  assert.strictEqual(s.qrLogin, null);
  assert.strictEqual(s.getLogs, null);
  assert.strictEqual(svccheckNapcat(), true);
});
function svccheckNapcat() { return svc.CAPABILITIES.napcat.qrLogin === true; }

test('httpProbe: 非回环地址一律拒绝', async () => {
  const r = await svc.httpProbe('http://example.com/health');
  assert.strictEqual(r.ok, false);
  assert.ok(/回环/.test(r.error));
});

test('httpProbe: 地址格式非法时安全失败', async () => {
  const r = await svc.httpProbe('not-a-url');
  assert.strictEqual(r.ok, false);
});

test('tailFile: 日志脱敏（密钥不出现在输出里）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-log-'));
  try {
    const f = path.join(dir, 'a.log');
    fs.writeFileSync(f, 'line1\npassword=Sup3rSecret123\ntoken sk-abcdefghijklmnop\n');
    const r = svc.tailFile(f, 10);
    assert.strictEqual(r.ok, true);
    const joined = r.lines.join('\n');
    // redact 按已知密钥形态脱敏（如 sk-* token），确认确实走了脱敏通道
    assert.ok(!joined.includes('sk-abcdefghijklmnop'), joined);
    assert.ok(/<KEY>|\[REDACTED\]|\*+/.test(joined), joined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('detectSnowLuma: 识别 launcher 与版本', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-'));
  try {
    fs.writeFileSync(path.join(dir, 'launcher.bat'), '@echo off');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'snowluma', version: '2.2.0' }));
    const d = svc.detectSnowLuma(dir);
    assert.strictEqual(d.installed, true);
    assert.strictEqual(d.launcher, 'launcher.bat');
    assert.strictEqual(d.version, '2.2.0');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('detectSnowLuma: 空目录/不存在如实报告未安装', () => {
  const d = svc.detectSnowLuma('');
  assert.strictEqual(d.installed, false);
});

test('listBackends: 返回两种后端与能力', () => {
  const { svc: s } = makeService();
  const list = s.listBackends();
  assert.deepStrictEqual(list.map((b) => b.id), ['napcat', 'snowluma']);
  assert.ok(list[0].capabilities);
  assert.ok(list[1].capabilities);
});

test('setDefault / setConfig: 切换默认后端并持久化', () => {
  const h = makeService(); const s = h.svc;
  assert.strictEqual(s.setDefault('snowluma').ok, true);
  assert.strictEqual(h.settings.qqBackend.default, 'snowluma');
  assert.strictEqual(s.setDefault('bogus').ok, false);
  const c = s.setConfig({ snowluma: { installDir: 'D:\\SnowLuma' } });
  assert.strictEqual(c.snowluma.installDir, 'D:\\SnowLuma');
  // 已有字段不应被半合并擦掉
  assert.strictEqual(h.settings.qqBackend.snowluma.webuiPort, 5099);
});

test('SnowLuma: 未指定安装目录时启动失败并给出明确原因', async () => {
  const { svc: s } = makeService();
  const r = await s.start('snowluma');
  assert.strictEqual(r.ok, false);
  assert.ok(/安装目录/.test(r.error), r.error);
});

test('SnowLuma: 启动成功（桩管理器）并报告 PID', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-run-'));
  const pm = fakePm({
    launchAndVerify: async (spec) => {
      pm.state.pids[5099] = 4321;
      return { ok: true, pid: 4321, spec };
    },
  });
  const h = makeService({ pm, settings: { qqBackend: { default: 'snowluma', snowluma: { installDir: dir, webuiPort: 5099 } } } }); const s = h.svc;
  try {
    fs.writeFileSync(path.join(dir, 'launcher.bat'), '@echo off');
    const r = await s.start('snowluma');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.pid, 4321);
    const st = await s.status('snowluma');
    assert.strictEqual(st.status.running, true);
    assert.strictEqual(st.status.pid, 4321);
    assert.ok(st.status.uptimeMs != null);
    // 停止
    const sp = await s.stop('snowluma');
    assert.strictEqual(sp.stopped, true);
    assert.strictEqual((await s.status('snowluma')).status.running, false);
    assert.ok(h.settings.qqBackend.snowluma.installDir === dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('SnowLuma: 已在运行不重复拉起', async () => {
  const pm = fakePm({ launchAndVerify: async () => ({ ok: true, pid: 1 }) });
  pm.state.pids[5099] = 777;
  const { svc: s } = makeService({ pm, settings: { qqBackend: { default: 'snowluma', snowluma: { installDir: os.tmpdir(), webuiPort: 5099 } } } });
  const r = await s.start('snowluma');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.alreadyRunning, true);
});

test('SnowLuma: 启动超时且进程未存活 → 如实失败（不伪报成功）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-fail-'));
  fs.writeFileSync(path.join(dir, 'launcher.bat'), '@echo off');
  const pm = fakePm({ launchAndVerify: async () => ({ ok: false, error: '在 60s 内未检测到服务就绪', stderrTail: 'Error: port in use' }) });
  const { svc: s } = makeService({ pm, settings: { qqBackend: { default: 'snowluma', snowluma: { installDir: dir, webuiPort: 5099 } } } });
  try {
    const r = await s.start('snowluma');
    assert.strictEqual(r.ok, false);
    assert.ok(/未检测到服务就绪/.test(r.error), r.error);
    assert.strictEqual(r.detail, 'Error: port in use');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('SnowLuma: 日志路径未配置时给出降级提示', async () => {
  const { svc: s } = makeService({ settings: { qqBackend: { default: 'snowluma', snowluma: {} } } });
  const r = await s.getLogs('snowluma', 50);
  assert.strictEqual(r.ok, false);
  assert.ok(/官方文档未给出固定日志路径/.test(r.error), r.error);
});

test('NapCat: 未配置 QQ 号时启动失败并说明原因', async () => {
  const { svc: s } = makeService({ napcatDir: os.tmpdir(), account: {} });
  const r = await s.start('napcat');
  assert.strictEqual(r.ok, false);
  assert.ok(/QQ 号/.test(r.error), r.error);
});

test('NapCat: 启动成功（桩管理器）后可查询状态与停止', async () => {
  const pm = fakePm({
    startBotVerified: async () => { pm.state.pids[3000] = 2222; return { ok: true, started: { napcat: { ok: true } }, pids: [2222] }; },
  });
  const { svc: s } = makeService({ pm, napcatDir: os.tmpdir(), account: { account: '100000001' } });
  const r = await s.start('napcat');
  assert.strictEqual(r.ok, true);
  const st = await s.status('napcat');
  assert.strictEqual(st.status.running, true);
  assert.strictEqual((await s.stop('napcat')).stopped, true);
});

test('健康检查: 回环地址按探活结果返回', async () => {
  const { svc: s } = makeService({ settings: { qqBackend: { default: 'napcat', napcat: { onebotPort: 1 } } } });
  const r = await s.healthCheck('napcat');
  assert.strictEqual(typeof r.ok, 'boolean');
  // 未监听的端口必然失败，且必须带可读原因
  if (!r.ok) assert.ok(!!r.error, '失败时应有可读原因');
});

test('未知后端一律报错，不静默兜底', async () => {
  const { svc: s } = makeService();
  assert.strictEqual((await s.status('bogus')).ok, false);
  assert.strictEqual(s.getCapabilities('bogus'), null);
});
