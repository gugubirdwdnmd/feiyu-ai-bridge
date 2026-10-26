'use strict';
/**
 * napcatToken.test.js —— NapCat OneBot 令牌读取（模块 K 启动链路）。
 *
 * 背景：NapCat 配了 access_token 时，AI 桥必须带同一令牌，否则
 * OneBot 调用返回 "token verify failed!"，表现为「机器人收得到消息但发不出去」。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ns = require('../src/services/napcatLoginService');

function makeNapcatDir(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat-tok-'));
  const cfgDir = path.join(dir, 'napcat', 'config');
  fs.mkdirSync(cfgDir, { recursive: true });
  if (cfg) fs.writeFileSync(path.join(cfgDir, 'onebot11_123.json'), JSON.stringify(cfg));
  return { dir, cfgDir };
}

test('readOnebotToken: 读取 httpServers 中 3000 端口的 token', () => {
  const { dir } = makeNapcatDir({
    network: { httpServers: [
      { name: 'other', enable: true, port: 3001, token: 'wrong-token' },
      { name: 'ai-http', enable: true, port: 3000, token: 'the-real-token' },
    ] },
  });
  try {
    const r = ns.readOnebotToken(dir);
    assert.strictEqual(r.token, 'the-real-token');
    assert.strictEqual(r.port, 3000);
    assert.ok(r.source.endsWith('onebot11_123.json'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readOnebotToken: 无 token / 无配置 / 目录不存在都返回空串', () => {
  const a = makeNapcatDir({ network: { httpServers: [{ enable: true, port: 3000, token: '' }] } });
  try { assert.strictEqual(ns.readOnebotToken(a.dir).token, ''); } finally { fs.rmSync(a.dir, { recursive: true, force: true }); }
  const b = makeNapcatDir(null);
  try { assert.strictEqual(ns.readOnebotToken(b.dir).token, ''); } finally { fs.rmSync(b.dir, { recursive: true, force: true }); }
  assert.strictEqual(ns.readOnebotToken('D:/definitely-not-exist-dir').token, '');
  assert.strictEqual(ns.readOnebotToken('').token, '');
});

test('readOnebotToken: 配置文件损坏时不抛错', () => {
  const { dir, cfgDir } = makeNapcatDir(null);
  try {
    fs.writeFileSync(path.join(cfgDir, 'onebot11_bad.json'), '{ not json');
    assert.strictEqual(ns.readOnebotToken(dir).token, '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
