'use strict';
/**
 * loginMarket.test.js —— 模块 A（登录中心）+ 模块 F（市场适配）单测。
 * 安全重点：二维码/令牌不外泄；实例清单不保存密码；市场不绕过鉴权与付费。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nl = require('../src/services/napcatLoginService');
const mk = require('../src/services/marketService');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-login-')); }

/* ---------------- A. 登录中心 ---------------- */

test('maskAccount: 中间打码，长度不变', () => {
  const fake = '1000000000';
  const m = nl.maskAccount(fake);
  assert.ok(!m.includes(fake));
  assert.strictEqual(m.length, 10);
  assert.ok(m.startsWith('10') && m.endsWith('00'));
});

test('maskAccount: 短号全打码', () => {
  assert.strictEqual(nl.maskAccount('1234'), '****');
  assert.strictEqual(nl.maskAccount(''), '');
});

test('extractQr: 顶层 base64 转 data URL', () => {
  const r = nl.extractQr({ qrcode: 'AAAABBBB' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.qrImage.startsWith('data:image/png;base64,'));
});

test('extractQr: data.qrcode 嵌套形态', () => {
  const r = nl.extractQr({ data: { qrcode: 'ZZZZ' } });
  assert.strictEqual(r.ok, true);
  assert.ok(r.qrImage.includes('ZZZZ'));
});

test('extractQr: 只有 url 时返回 qrUrl', () => {
  const r = nl.extractQr({ qrcodeUrl: 'https://qr.example/x' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.qrUrl, 'https://qr.example/x');
  assert.strictEqual(r.qrImage, null);
});

test('extractQr: 找不到二维码时明确报错', () => {
  const r = nl.extractQr({ nothing: 1 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
});

test('extractQr: 附带 token 时只回传掩码', () => {
  const r = nl.extractQr({ qrcode: 'IMG', token: 'verysecrettoken123456' });
  assert.ok(r.tokenMasked);
  assert.ok(!r.tokenMasked.includes('verysecrettoken123456'));
});

test('parseStatus: 识别等待/已扫/成功/过期/失败', () => {
  assert.strictEqual(nl.parseStatus({ status: '等待扫码' }).state, 'pending');
  assert.strictEqual(nl.parseStatus({ message: '已扫码，请确认' }).state, 'scanned');
  assert.strictEqual(nl.parseStatus({ message: '登录成功' }).state, 'ok');
  assert.strictEqual(nl.parseStatus({ status: '二维码已过期' }).state, 'expired');
  assert.strictEqual(nl.parseStatus({ message: '登录失败' }).state, 'failed');
});

test('parseStatus: 错误码非 0 视为失败', () => {
  assert.strictEqual(nl.parseStatus({ retcode: 100 }).state, 'failed');
});

test('createSession/applyQr: 会话进入 pending 并带图', () => {
  const s = nl.createSession({ now: () => 1000 });
  nl.applyQr(s, { qrcode: 'IMG' });
  assert.strictEqual(s.state, 'pending');
  assert.ok(s.qrImage);
});

test('applyPoll: 成功后清空二维码内容', () => {
  const s = nl.createSession({ now: () => 1000 });
  nl.applyQr(s, { qrcode: 'IMG' });
  nl.applyPoll(s, { message: '登录成功' }, { now: () => 2000 });
  assert.strictEqual(s.state, 'ok');
  assert.strictEqual(s.qrImage, null);
});

test('applyPoll: 本地 TTL 过期覆盖远端 pending', () => {
  const s = nl.createSession({ now: () => 1000, ttlMs: 500 });
  nl.applyQr(s, { qrcode: 'IMG' });
  nl.applyPoll(s, { status: '等待扫码' }, { now: () => 5000 });
  assert.strictEqual(s.state, 'expired');
});

test('publicSession: 默认不含二维码内容', () => {
  const s = nl.createSession({ now: () => 1000 });
  nl.applyQr(s, { qrcode: 'IMG' });
  const p = nl.publicSession(s);
  assert.strictEqual(p.qrImage, undefined);
  const withQr = nl.publicSession(s, { withQr: true });
  assert.ok(withQr.qrImage);
});

test('validateInstance: 拒绝非法 QQ 号与非 32 位 MD5', () => {
  assert.strictEqual(nl.validateInstance({ id: 'a', name: 'A', account: 'abc' }).valid, false);
  assert.strictEqual(nl.validateInstance({ id: 'a', name: 'A', passwordMd5: 'plainpassword' }).valid, false);
  assert.strictEqual(nl.validateInstance({ id: 'a', name: 'A', passwordMd5: 'a'.repeat(32) }).valid, true);
});

test('sanitizeInstance: 清单里绝不保留 passwordMd5', () => {
  const rec = nl.sanitizeInstance({ id: 'a', name: 'A', account: '10001', passwordMd5: 'b'.repeat(32) });
  assert.strictEqual(rec.passwordMd5, undefined);
  assert.strictEqual(rec.hasQuickPassword, true);
  assert.strictEqual(rec.account, '10001');
});

test('saveInstance/listInstances: 落盘不含密码，列表账号被掩码', () => {
  const dir = tmpDir();
  try {
    const r = nl.saveInstance(dir, { id: 'main', name: '主号', account: '100012345', mode: 'quick', passwordMd5: 'c'.repeat(32) });
    assert.strictEqual(r.ok, true);
    const raw = fs.readFileSync(nl.instancesPath(dir), 'utf-8');
    assert.ok(!raw.includes('c'.repeat(32)), '磁盘上不应出现密码 MD5');
    const list = nl.listInstances(dir);
    assert.ok(!JSON.stringify(list).includes('100012345'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('saveInstance: 非法定义不落盘', () => {
  const dir = tmpDir();
  try {
    assert.strictEqual(nl.saveInstance(dir, { id: 'bad id', name: 'x' }).ok, false);
    assert.strictEqual(nl.listInstances(dir).count, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('removeInstance / markLoggedIn', () => {
  const dir = tmpDir();
  try {
    nl.saveInstance(dir, { id: 'a', name: 'A', account: '10001' });
    assert.strictEqual(nl.markLoggedIn(dir, 'a', { now: new Date('2026-06-01T00:00:00Z') }).ok, true);
    assert.ok(nl.listInstances(dir).instances[0].lastLoginAt);
    assert.strictEqual(nl.removeInstance(dir, 'a').ok, true);
    assert.strictEqual(nl.removeInstance(dir, 'a').ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('qrLoginPlan: 返回步骤与安全提示，不含任何令牌', () => {
  const p = nl.qrLoginPlan({ endpoint: 'http://127.0.0.1:3000/qr' });
  assert.strictEqual(p.ok, true);
  assert.ok(p.steps.length >= 3);
  assert.ok(p.securityNotes.some((s) => s.includes('请勿截图')));
  assert.strictEqual(p.endpointConfigured, true);
});

/* ---------------- F. 市场适配 ---------------- */

test('checkEndpoint: 只允许 https 公网地址', () => {
  assert.strictEqual(mk.checkEndpoint('https://market.example.com/c.json').ok, true);
  assert.strictEqual(mk.checkEndpoint('http://market.example.com/c.json').ok, false);
  assert.strictEqual(mk.checkEndpoint('https://127.0.0.1/c.json').ok, false);
  assert.strictEqual(mk.checkEndpoint('https://localhost/c.json').ok, false);
  assert.strictEqual(mk.checkEndpoint('file:///c.json').ok, false);
});

test('parseCatalog: 合法条目被解析，付费/鉴权被打标', () => {
  const r = mk.parseCatalog({
    items: [
      { id: 's1', name: '免费', downloadUrl: 'https://a/b.zip', sha256: 'a'.repeat(64) },
      { id: 's2', name: '付费', downloadUrl: 'https://a/c.zip', price: 9.9 },
      { id: 's3', name: '鉴权', downloadUrl: 'https://a/d.zip', requiresAuth: true },
    ],
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.items.length, 3);
  assert.strictEqual(r.items[1].paid, true);
  assert.strictEqual(r.items[2].requiresAuth, true);
  assert.ok(r.warnings.some((w) => w.includes('付费')));
});

test('parseCatalog: 缺失 sha256 标记 unverified 并警告', () => {
  const r = mk.parseCatalog({ items: [{ id: 's1', name: 'x', downloadUrl: 'https://a/b.zip' }] });
  assert.strictEqual(r.items[0].integrity, 'unverified');
  assert.ok(r.warnings.some((w) => w.includes('sha256')));
});

test('parseCatalog: 非法 items 被拒', () => {
  assert.strictEqual(mk.parseCatalog({}).ok, false);
  assert.strictEqual(mk.parseCatalog('not json').ok, false);
});

test('planImport: 需要鉴权但无令牌 → 阻止', () => {
  const p = mk.planImport({ requiresAuth: true, downloadUrl: 'https://a/b' }, { hasToken: false });
  assert.strictEqual(p.allowed, false);
  assert.strictEqual(p.needsAuth, true);
});

test('planImport: 付费条目永远阻止（不绕过付费）', () => {
  const p = mk.planImport({ paid: true, downloadUrl: 'https://a/b' }, { hasToken: true });
  assert.strictEqual(p.allowed, false);
  assert.strictEqual(p.needsPayment, true);
});

test('planImport: 无 downloadUrl 阻止', () => {
  const p = mk.planImport({ downloadUrl: null }, { hasToken: true });
  assert.strictEqual(p.allowed, false);
});

test('fetchItem: sha256 匹配时通过', async () => {
  const buf = Buffer.from('hello');
  const sha = mk.sha256Hex(buf);
  const fakeFetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => buf });
  const r = await mk.fetchItem({ downloadUrl: 'https://a/b.zip', sha256: sha }, { fetchFn: fakeFetch });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.verified, true);
});

test('fetchItem: sha256 不匹配时丢弃内容', async () => {
  const buf = Buffer.from('tampered');
  const fakeFetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => buf });
  const r = await mk.fetchItem({ downloadUrl: 'https://a/b.zip', sha256: 'f'.repeat(64) }, { fetchFn: fakeFetch });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('完整性'));
});

test('fetchItem: 付费条目不会发起请求', async () => {
  let called = false;
  const fakeFetch = async () => { called = true; return { ok: true, arrayBuffer: async () => Buffer.from('') }; };
  const r = await mk.fetchItem({ downloadUrl: 'https://a/b', paid: true }, { fetchFn: fakeFetch });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(called, false);
});

test('fetchCatalog: 华为云来源缺令牌直接拒绝（不尝试匿名）', async () => {
  let called = false;
  const fakeFetch = async () => { called = true; return { ok: true, text: async () => '{}' }; };
  const r = await mk.fetchCatalog('huaweicloud', 'https://market.example.com/api', { fetchFn: fakeFetch });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.needsAuth, true);
  assert.strictEqual(called, false);
});

test('fetchCatalog: local 来源不走网络', async () => {
  const r = await mk.fetchCatalog('local', '', {});
  assert.strictEqual(r.ok, false);
});

test('listSources: 三个来源齐备且标注鉴权需求', () => {
  const r = mk.listSources();
  const ids = r.sources.map((s) => s.id);
  assert.deepStrictEqual(ids, ['huaweicloud', 'generic', 'local']);
  assert.strictEqual(r.sources.find((s) => s.id === 'huaweicloud').requiresAuth, true);
});
