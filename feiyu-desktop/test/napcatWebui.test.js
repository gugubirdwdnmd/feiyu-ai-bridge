'use strict';
/**
 * napcatWebui.test.js —— NapCat WebUI 扫码登录链路单测。
 *
 * 覆盖：读取 webui.json、登录散列、鉴权失败、取到二维码、已登录、状态轮询。
 * 全部通过注入 deps.postJson，不发真实网络请求。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const svc = require('../src/services/napcatWebuiService');

function tmpNapcat(webui) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat-webui-'));
  const cfgDir = path.join(dir, 'napcat', 'config');
  fs.mkdirSync(cfgDir, { recursive: true });
  if (webui) fs.writeFileSync(path.join(cfgDir, 'webui.json'), JSON.stringify(webui));
  return dir;
}

test('readWebuiConfig: 读取 host/port/token', () => {
  const dir = tmpNapcat({ host: '127.0.0.1', port: 6099, token: 'abc123' });
  try {
    const c = svc.readWebuiConfig(dir);
    assert.strictEqual(c.port, 6099);
    assert.strictEqual(c.token, 'abc123');
    assert.strictEqual(c.host, '127.0.0.1');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readWebuiConfig: 无配置时返回默认端口且 token 为空', () => {
  const dir = tmpNapcat(null);
  try {
    const c = svc.readWebuiConfig(dir);
    assert.strictEqual(c.token, '');
    assert.strictEqual(c.port, svc.DEFAULT_WEBUI_PORT);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('webuiHash: sha256(token + .napcat)', () => {
  assert.strictEqual(
    svc.webuiHash('abc'),
    require('crypto').createHash('sha256').update('abc.napcat').digest('hex'),
  );
});

test('fetchQrcode: 鉴权+取码成功，返回 data:image', async () => {
  const calls = [];
  const post = async (o) => {
    calls.push(o);
    if (o.urlPath === '/api/auth/login') {
      return { ok: true, status: 200, json: { code: 0, data: { Credential: 'CRED' } } };
    }
    return { ok: true, status: 200, json: { code: 0, data: { qrcode: 'BASE64IMG' } } };
  };
  const r = await svc.fetchQrcode({ host: '127.0.0.1', port: 6099, token: 'T' }, { postJson: post });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.state, 'pending');
  assert.strictEqual(r.qrImage, 'data:image/png;base64,BASE64IMG');
  assert.strictEqual(calls[0].urlPath, '/api/auth/login');
  assert.strictEqual(calls[0].body.hash, svc.webuiHash('T'));
  assert.strictEqual(calls[1].headers.Authorization, 'Bearer CRED');
});

test('fetchQrcode: 已登录时给出可读提示', async () => {
  const post = async (o) => {
    if (o.urlPath === '/api/auth/login') return { ok: true, status: 200, json: { code: 0, data: { Credential: 'C' } } };
    return { ok: true, status: 200, json: { code: -1, message: 'QQ Is Logined' } };
  };
  const r = await svc.fetchQrcode({ host: '127.0.0.1', port: 6099, token: 'T' }, { postJson: post });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.state, 'ok');
  assert.ok(/已是登录状态/.test(r.error), r.error);
});

test('fetchQrcode: 缺少令牌时直接失败', async () => {
  const r = await svc.fetchQrcode({ host: '127.0.0.1', port: 6099, token: '' }, { postJson: async () => ({ ok: true, json: {} }) });
  assert.strictEqual(r.ok, false);
  assert.ok(/WebUI 令牌/.test(r.error), r.error);
});

test('fetchStatus: 登录成功返回 ok', async () => {
  const post = async (o) => {
    if (o.urlPath === '/api/auth/login') return { ok: true, status: 200, json: { code: 0, data: { Credential: 'C' } } };
    return { ok: true, status: 200, json: { code: 0, message: 'success', data: { success: true, uin: '10000', nick: 'tester' } } };
  };
  const r = await svc.fetchStatus({ host: '127.0.0.1', port: 6099, token: 'T' }, { postJson: post });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.state, 'ok');
  assert.strictEqual(r.uin, '10000');
});

test('fetchStatus: 等待扫码返回 pending', async () => {
  const post = async (o) => {
    if (o.urlPath === '/api/auth/login') return { ok: true, status: 200, json: { code: 0, data: { Credential: 'C' } } };
    return { ok: true, status: 200, json: { code: 0, message: 'wait', data: {} } };
  };
  const r = await svc.fetchStatus({ host: '127.0.0.1', port: 6099, token: 'T' }, { postJson: post });
  assert.strictEqual(r.state, 'pending');
});
