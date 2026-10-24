'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ps = require('../src/services/processService');

test('parseNetstat extracts pid for listening port', () => {
  const out = '  TCP    0.0.0.0:3001    0.0.0.0:0    LISTENING    12345\r\n  TCP    0.0.0.0:3000   LISTENING  999';
  assert.strictEqual(ps.parseNetstat(out, 3001), 12345);
  assert.strictEqual(ps.parseNetstat(out, 3000), 999);
  assert.strictEqual(ps.parseNetstat(out, 8188), null);
});
test('getStatus via mock execFile', async () => {
  const deps = { spawn: () => ({ pid: null, unref() {} }), execFile: (cmd, args, opts, cb) => cb(null, '  TCP    0.0.0.0:3001    0.0.0.0:0    LISTENING    999\n'), sleep: async () => {}, platform: 'win32' };
  const pm = ps.createProcessManager({ deps });
  const st = await pm.getStatus();
  assert.strictEqual(st.bridge.running, true); assert.strictEqual(st.bridge.pid, 999);
  assert.strictEqual(st.napcat.running, false);
});
test('startBot spawns bridge and napcat with env, no miskill', () => {
  const spawned = [];
  const deps = { spawn: (bin, args, o) => { spawned.push({ bin, args, cwd: o.cwd, env: o.env, detached: o.detached }); return { pid: spawned.length + 1000, unref() {} }; }, execFile: (c, a, o, cb) => cb(null, ''), sleep: async () => {}, platform: 'win32' };
  const pm = ps.createProcessManager({ deps });
  const r = pm.startBot('C:\\bot', { napcat: { account: '123', passwordMd5: 'abc' } });
  assert.ok(spawned.find((s) => s.args[0] === 'ai_bridge.js' && s.cwd === 'C:\\bot'));
  const nc = spawned.find((s) => s.args[0] === 'index.js' && s.args.includes('-q'));
  assert.ok(nc); assert.strictEqual(nc.env.NAPCAT_QUICK_ACCOUNT, '123'); assert.strictEqual(nc.env.NAPCAT_QUICK_PASSWORD_MD5, 'abc');
  assert.ok(r.pids.length >= 2);
});
test('startBot without napcat only starts bridge', () => {
  const spawned = [];
  const deps = { spawn: (bin, args, o) => { spawned.push(args[0]); return { pid: 1, unref() {} }; }, execFile: (c, a, o, cb) => cb(null, ''), sleep: async () => {}, platform: 'win32' };
  const pm = ps.createProcessManager({ deps });
  pm.startBot('C:\\bot', {});
  assert.ok(spawned.includes('ai_bridge.js')); assert.ok(!spawned.includes('index.js'));
});
test('stopByPids calls taskkill /T /F on win32 mock', async () => {
  const killed = [];
  const deps = { spawn: () => ({ pid: 1, unref() {} }), execFile: (c, a, o, cb) => { killed.push(a.join(' ')); cb(null, ''); }, sleep: async () => {}, platform: 'win32' };
  const pm = ps.createProcessManager({ deps });
  const r = await pm.stopByPids([555], { timeoutMs: 100 });
  assert.ok(killed.some((k) => k.includes('555') && k.includes('/T') && k.includes('/F')));
  assert.strictEqual(r.stopped, true);
});
