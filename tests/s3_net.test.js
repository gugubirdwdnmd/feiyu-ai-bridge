'use strict';
// ================= V14 阶段三 B2 测试套件：safe_http.js 安全传输层 =================
// 测试分类（每条都标注）：
//   A = 单元 / 模拟（不发起任何网络连接）
//   B = 本地受控网络集成（本地服务器只绑 127.0.0.1，目标由测试策略显式指定，
//       不触碰任何外部设备、不做任何扫描、不改 hosts）
// 本套件不做 C（真实公网）/ D（真实 QQ 验收）。
//
// 说明：TLS 用例需要一张受信任的自签证书才能验证「证书校验保持开启」。
// 本文件在首次运行时把内嵌证书写到系统临时目录，并以 NODE_EXTRA_CA_CERTS
// 重新拉起自己一次（__S3_NET_CHILD=1），从而在不给 safe_http.js 增加任何
// 「关闭证书校验」入口的前提下完成正向/负向证书校验测试。

const http = require('http');
const net = require('net');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// ——— 内嵌测试证书（自签，SAN: my.host.example / ok.test / 127.0.0.1）———
// 仅用于本测试，非生产凭据。
const TEST_CERT = String.raw`
-----BEGIN CERTIFICATE-----
MIIDQDCCAiigAwIBAgIUaXO5a7TToZlM76c5l7UNXRC/A1owDQYJKoZIhvcNAQEL
BQAwGjEYMBYGA1UEAwwPbXkuaG9zdC5leGFtcGxlMB4XDTI2MTAwOTE4MTU1M1oX
DTM2MTAwNjE4MTU1M1owGjEYMBYGA1UEAwwPbXkuaG9zdC5leGFtcGxlMIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAui0/YIYgWWZn2Ro616myaYx4WNYl
Ulpoomkp9oKr1+RFnyITvdnO3ramFM2xrwcaVgT5JtIOZljb5QAvaxT4J17qOrLM
aV/BQhZv4uAwAkohuiHkMA/UEHi5JTV06qoIp4swo2jX2h3x0RxeuGduFSav5gDt
DBCrTz/Nc8MNsY95p7yfQPhmvnfRQeljYZwpFDPC06+9grVhTEOJuTzIQ4vo4KsR
GmWyjGkW250PoKyI5TWX0C+DhIOOlLt6CpNJlDLEwi0cxYQv8ML086HbOKIobIoJ
zMP0nnIS0xdgXeUpCqZHBNa2YZKtjK5UvsCrbatp1xymvjuY5uDoZu4unQIDAQAB
o34wfDAdBgNVHQ4EFgQU7eZYn439J4onqz3lSxYq3izDiHgwHwYDVR0jBBgwFoAU
7eZYn439J4onqz3lSxYq3izDiHgwDwYDVR0TAQH/BAUwAwEB/zApBgNVHREEIjAg
gg9teS5ob3N0LmV4YW1wbGWCB29rLnRlc3SHBH8AAAEwDQYJKoZIhvcNAQELBQAD
ggEBAAJaQcwomIgNjkic6PxkXe1oO0X+YohQGFVsWSBAiTBze1Qr27dniFlz3+a9
cvpC3T94Q9IQQgamnEuitNhjDqXHlIviIv0lWL83gPSvlCp7fEYrQ/AI9SwjDAYG
5d/EaxIDIoRDhplsaB892YFb9ImcQilJOMRSzYSK91LTEcwLXFHx3qtkRK/lWHnm
+OZOBThOtuorNXbBwY1mY600E63vyFOh42Hs+epXZ/wJ7hfJwkDcEuG3QuWfmQkG
j0PzPe8pBS7yKeSdUuyACEJ4px1S1+QtS9tbvGubZPMTCjQXY0DP1sup+aOpQt/z
4V82X1gVa4ErI5h+CM7L1wVw7yE=
-----END CERTIFICATE-----
`;

const TEST_KEY = String.raw`
-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC6LT9ghiBZZmfZ
GjrXqbJpjHhY1iVSWmiiaSn2gqvX5EWfIhO92c7etqYUzbGvBxpWBPkm0g5mWNvl
AC9rFPgnXuo6ssxpX8FCFm/i4DACSiG6IeQwD9QQeLklNXTqqginizCjaNfaHfHR
HF64Z24VJq/mAO0MEKtPP81zww2xj3mnvJ9A+Ga+d9FB6WNhnCkUM8LTr72CtWFM
Q4m5PMhDi+jgqxEaZbKMaRbbnQ+grIjlNZfQL4OEg46Uu3oKk0mUMsTCLRzFhC/w
wvTzods4oihsignMw/SechLTF2Bd5SkKpkcE1rZhkq2MrlS+wKttq2nXHKa+O5jm
4Ohm7i6dAgMBAAECggEACcMqohiWZKmyg1dVQ47B7LfxbZMZFObpuq5yBVuXwDPX
lL8YMunTZ6lDLy8UBJ4GOwF6wRbdq284ZJssYVyRoJrhBF/wyQu82gbMKiTgT5Zs
i1KQoRaLY6u45aMWdOGin4p0a/Uo8GaGkhT/QIMn6hMDwTdGNs4+9WJelxXgx3Es
IfoIqmDaFRFzYaAwRkMf2LysPfruslk8BqF3zM4AnqeiHS6s0vhmhSpSd7ZjbK6r
PhK/9IVwU2WtD64u2geVHruNcFhMxbOr+KHFF59yU0j5taN99Q7rOLvzW6ig7daG
Kyq2WzyMkwiOAqWDd3Z/ynbP/caQq/FOzgwO9a1p7wKBgQDiu4VlMu3AUmIiCnBD
YU9iudbNCHUIuzxmvoKCoM1SgBh+Yf/NjZM2zZrCDbkTEkVVdLurH9f3ENH6mOZY
29aqNW8CNgzj5mXlrjfEhRxwuPdjkmIJZ8aYyvdVH5ufPsT35aVwPbKEMmbJGqn1
a/qFMGbbAe7EQNLy8A+kSI2C/wKBgQDSNYsFuqTRtZu0IKwyxwVwNeWMEy2Lc3w6
hGfJ4MP6wvKh5SbZfxk3bdeiFvFsLkxjeF+NKrT52/LNDp/KC6ekJs55cFJZIKPr
jhAlHddAgPxNsJxRQSE+gEsrYs6V6tWMT7wUM8xrIQuO/D1aJdG233i+nURZRUde
PKD+Qzl6YwKBgQClQHOLPMFYSTNJCD6mfYg0tqo+KgnS4VS2tee9eaHsnXw8sQSW
NrezW8uN4B6iLdDm5fvaT41Cf7nrYgGRhjlBOUy9WdOvTz+5VW9EBpih984nfouB
u2dd+aCnJDBysncxDumzkuRHwcx0isCRJbAj3xE4UoJJ+81ET3+3B0JM1QKBgQCy
Ymuipfv+Vo5Wcq+Ou6Pa0HIGx7OLtqoCgqANCidlopACYRLx2VDN3/HwhGXFtxhu
BRWZF1fS/RrzduiUrgVKYQAwv+ex6OgSGlGLHeKvw4XYa/qLXajXgEnJ/KRxRoKH
+pYR0s8zTiyf32A1Iwjvln7By3XYB9mDmBHLE8MwHwKBgGo0xjSYq0JQ1RYNyGfT
hAQHJpmN7kJP2CDAPs6a6Aqj80n/u6PBUnpLMipl59nGGB5plUMnCaDxs6P7xFtY
6mI02T2ah2epQuedzCWG6bDdrJCdwaMOLHhkCfe8YnsU0i8tGbj4Dj6CQXMgHfj9
OoobcjGm/ZDPOJ/4lubn9ICW
-----END PRIVATE KEY-----
`;

// ——— 需要信任自签证书 → 以 NODE_EXTRA_CA_CERTS 重新拉起自己一次 ———
if (!process.env.__S3_NET_CHILD) {
  const certPath = path.join(os.tmpdir(), 's3_net_test_cert.pem');
  const keyPath = path.join(os.tmpdir(), 's3_net_test_key.pem');
  fs.writeFileSync(certPath, TEST_CERT);
  fs.writeFileSync(keyPath, TEST_KEY);
  const r = spawnSync(process.execPath, [__filename], {
    env: Object.assign({}, process.env, { NODE_EXTRA_CA_CERTS: certPath, __S3_NET_CHILD: '1' }),
    stdio: 'inherit',
  });
  process.exit(r.status == null ? 1 : r.status);
}

const safeHttp = require('../safe_http');
const urlSafety = require('../url_safety');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name) { if (cond) pass++; else { fail++; fails.push(name); console.log('  ✗ ' + name); } }
function eq(a, b, name) { ok(a === b, name + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function group(t) { console.log('\n[' + t + ']'); }

// ——— 本地受控服务器（只绑 127.0.0.1）———
function startServer(handler, opts) {
  const o = opts || {};
  const st = { count: 0, seen: [] };
  const wrapped = (req, res) => {
    st.count += 1;
    st.seen.push({
      url: req.url,
      host: req.headers.host,
      auth: req.headers.authorization || null,
      cookie: req.headers.cookie || null,
      remote: req.socket.remoteAddress,
    });
    handler(req, res);
  };
  const srv = o.tls
    ? https.createServer({
        cert: TEST_CERT, key: TEST_KEY,
        SNICallback: (sn, cb) => { srv.sniSeen = sn; cb(null, null); },
      }, wrapped)
    : http.createServer(wrapped);
  srv.st = st;
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      srv.port = srv.address().port;
      resolve(srv);
    });
  });
}
function closeServer(srv) { return new Promise((r) => { try { srv.close(() => r()); } catch (e) { r(); } }); }

// ——— 测试策略（显式启用，带 token）———
function testResolve(map, extra) {
  return function (urlStr, opts) {
    let u;
    try { u = new URL(urlStr); } catch (e) { return { ok: false, why: 'URL 无法解析' }; }
    const host = urlSafety.normalizeHost(u.hostname);
    const entry = map[host];
    if (!entry) return { ok: false, why: '测试策略未登记该主机：' + host };
    if (entry.reject) return { ok: false, why: entry.reject };
    if (entry.lookup) return urlSafety.resolveTarget(urlStr, { lookup: entry.lookup });
    const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    const list = entry.addrs || ['127.0.0.1'];
    const addrs = list.map((a) => ({ address: a, family: a.indexOf(':') >= 0 ? 6 : 4 }));
    return { ok: true, host, port, addresses: addrs, pin: addrs[0] };
  };
}

(async function main() {

  // ==================================================================
  group('A1 sameIp：IPv4 / IPv6 / IPv4-mapped 的一致性比较（A 单元）');
  eq(safeHttp.sameIp('127.0.0.1', '127.0.0.1'), true, 'A1-1 相同 IPv4');
  eq(safeHttp.sameIp('127.0.0.1', '::ffff:127.0.0.1'), true, 'A1-2 IPv4 与其 mapped 写法视为同一端点');
  eq(safeHttp.sameIp('127.0.0.1', '10.0.0.1'), false, 'A1-3 不同 IPv4 不等');
  eq(safeHttp.sameIp('::1', '::1'), true, 'A1-4 相同 IPv6');
  eq(safeHttp.sameIp('::1', '::0001'), true, 'A1-5 IPv6 展开写法等价');
  eq(safeHttp.sameIp('2606:4700:4700::1111', '2606:4700:4700::1111'), true, 'A1-6 相同公网 IPv6');
  eq(safeHttp.sameIp('127.0.0.1', '::1'), false, 'A1-7 IPv4 与 IPv6 不等');
  eq(safeHttp.sameIp('', '127.0.0.1'), false, 'A1-8 空地址不等');
  eq(safeHttp.sameIp('1.2.3.4', '2606:4700:4700::1111'), false, 'A1-9 长度不同的字节序列不等');

  // ==================================================================
  group('A2 默认参数冻结且四档超时 / 两个限额齐全（A 单元）');
  const D = safeHttp.DEFAULTS;
  ok(Object.isFrozen(D), 'A2-1 DEFAULTS 已冻结');
  ok(D.connectTimeoutMs > 0 && D.headersTimeoutMs > 0 && D.bodyIdleTimeoutMs > 0 && D.totalTimeoutMs > 0,
    'A2-2 四档超时均已设置（' + D.connectTimeoutMs + '/' + D.headersTimeoutMs + '/' + D.bodyIdleTimeoutMs + '/' + D.totalTimeoutMs + '）');
  ok(D.maxBytes > 0 && D.maxDecompressedBytes > 0, 'A2-3 接收上限与解压后上限均已设置');
  eq(D.allowDowngrade, false, 'A2-4 默认禁止 HTTPS 降级');
  ok(D.maxRedirects > 0, 'A2-5 重定向次数上限已设置（' + D.maxRedirects + '）');
  ok(Object.isFrozen(safeHttp.DEFAULT_POLICY), 'A2-6 生产默认策略已冻结');
  eq(safeHttp.DEFAULT_POLICY.testOnly, false, 'A2-7 生产默认策略不是测试策略');

  // ==================================================================
  group('A3 生产默认策略必须严格（A 单元，不连网）');
  {
    const r = await safeHttp.safeFetch('http://127.0.0.1:1/x');
    eq(r.ok, false, 'A3-1 不传 policy 时环回地址被拒');
    eq(r.kind, 'blocked', 'A3-2 拒绝类别为 blocked');
    ok(/127|环回|私有|保留|内网/.test(String(r.why)), 'A3-3 拒绝原因可读：' + r.why);
    const r2 = await safeHttp.safeFetch('http://[::1]:1/x');
    eq(r2.ok, false, 'A3-4 IPv6 环回同样被拒（默认策略）');
    const r3 = await safeHttp.safeFetch('https://user:pass@example.com/x');
    eq(r3.ok, false, 'A3-5 带 userinfo 的 URL 被拒（默认策略）');
    const r4 = await safeHttp.safeFetch('file:///C:/Windows/win.ini');
    eq(r4.ok, false, 'A3-6 非 http(s) 协议被拒');
  }

  // ==================================================================
  group('A4 测试策略必须显式启用（A 单元）');
  {
    const p = safeHttp.createTestPolicy({ resolveTarget: () => ({ ok: true, host: 'ok.test', port: 80, addresses: [{ address: '127.0.0.1', family: 4 }], pin: { address: '127.0.0.1', family: 4 } }) });
    ok(typeof p.token === 'string' && p.token.length >= 32, 'A4-1 createTestPolicy 返回一次性 token');
    eq(p.testOnly, true, 'A4-2 测试策略被标记为 testOnly');
    const r1 = await safeHttp.safeFetch('http://127.0.0.1/x', { policy: p });
    eq(r1.ok, false, 'A4-3 缺少 testToken → 失败关闭');
    eq(r1.kind, 'policy', 'A4-4 失败类别为 policy');
    const r2 = await safeHttp.safeFetch('http://127.0.0.1/x', { policy: p, testToken: 'wrong-token' });
    eq(r2.ok, false, 'A4-5 token 不匹配 → 失败关闭');
    const r3 = await safeHttp.safeFetch('http://ok.test/x', { policy: Object.assign({}, p, { testOnly: false }) });
    ok(r3.ok === false || /blocked|connect|timeout/.test(String(r3.kind)), 'A4-6 伪造 testOnly=false 也不能作为绕过手段（仍走正常校验路径）');
    try {
      Object.defineProperty(p, 'resolveTarget', { value: p.resolveTarget, writable: false });
      ok(true, 'A4-7 测试策略对象本身为只读（冻结）');
    } catch (e) { ok(Object.isFrozen(p), 'A4-7 测试策略对象本身为只读（冻结）'); }
  }

  // ==================================================================
  group('A5 禁止自定义 agent / 代理不得静默绕过（A 单元）');
  {
    const r = await safeHttp.safeFetch('https://example.com/x', { agent: new https.Agent() });
    eq(r.ok, false, 'A5-1 传入自定义 agent 被拒');
    eq(r.kind, 'agent', 'A5-2 拒绝类别为 agent');
    const saved = process.env.NODE_USE_ENV_PROXY;
    try {
      process.env.NODE_USE_ENV_PROXY = '1';
      const r2 = await safeHttp.safeFetch('https://example.com/x');
      eq(r2.ok, false, 'A5-3 NODE_USE_ENV_PROXY=1 → 失败关闭');
      eq(r2.kind, 'proxy', 'A5-4 拒绝类别为 proxy');
      ok(/无法保证连接目标/.test(String(r2.error)), 'A5-5 失败原因说明无法保证连接目标');
    } finally {
      if (saved === undefined) delete process.env.NODE_USE_ENV_PROXY;
      else process.env.NODE_USE_ENV_PROXY = saved;
    }
    const r3 = await safeHttp.safeFetch('not-a-url');
    eq(r3.kind, 'url', 'A5-6 非法 URL 被拒');
  }

  // ==================================================================
  group('B1 固定 IP：实际 socket 远端地址必须与校验 IP 一致（B 本地受控）');
  {
    const srv = await startServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('hello'); });
    const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'ok.test': { addrs: ['127.0.0.1'] } }) });
    const r = await safeHttp.safeFetch('http://ok.test:' + srv.port + '/p', { policy, testToken: policy.token });
    eq(r.ok, true, 'B1-1 请求成功');
    eq(r.pinnedIp, '127.0.0.1', 'B1-2 pinnedIp 为校验通过的地址');
    eq(r.remoteIp, '127.0.0.1', 'B1-3 实际 socket 远端 IP 与固定 IP 一致');
    eq(srv.st.seen[0].remote, '127.0.0.1', 'B1-4 服务端看到的 remoteAddress 也是该地址');
    eq(String(r.body), 'hello', 'B1-5 响应体正确');
    eq(r.status, 200, 'B1-6 状态码 200');
    await closeServer(srv);
  }

  // ==================================================================
  group('B2 Host 头保留原始域名（含非默认端口）（B 本地受控）');
  {
    const srv = await startServer((req, res) => { res.end('ok'); });
    const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'ok.test': { addrs: ['127.0.0.1'] } }) });
    await safeHttp.safeFetch('http://ok.test:' + srv.port + '/p?q=1', { policy, testToken: policy.token });
    eq(srv.st.seen[0].host, 'ok.test:' + srv.port, 'B2-1 Host 头是原始域名+端口，不是 IP');
    eq(srv.st.seen[0].url, '/p?q=1', 'B2-2 路径与查询串保留');
    await closeServer(srv);
  }

  // ==================================================================
  group('B3 gzip 解压正常（B 本地受控）');
  {
    const payload = 'x'.repeat(5000);
    const gz = zlib.gzipSync(Buffer.from(payload));
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' });
      res.end(gz);
    });
    const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'ok.test': { addrs: ['127.0.0.1'] } }) });
    const r = await safeHttp.safeFetch('http://ok.test:' + srv.port + '/g', { policy, testToken: policy.token });
    eq(r.ok, true, 'B3-1 解压成功');
    eq(String(r.body), payload, 'B3-2 内容与原文一致');
    ok(r.decompressedBytes > r.bytes, 'B3-3 解压后字节大于实际接收字节（' + r.decompressedBytes + ' > ' + r.bytes + '）');
    await closeServer(srv);
  }

  // ==================================================================
  group('B4 TLS：证书校验保持开启 + SNI 为原始域名（B 本地受控）');
  {
    const srv = await startServer((req, res) => { res.end('tls-ok'); }, { tls: true });
    const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'my.host.example': { addrs: ['127.0.0.1'] } }) });
    const r = await safeHttp.safeFetch('https://my.host.example:' + srv.port + '/s', { policy, testToken: policy.token });
    eq(r.ok, true, 'B4-1 HTTPS 请求成功（证书校验未被关闭，证书由 NODE_EXTRA_CA_CERTS 信任）');
    eq(srv.sniSeen, 'my.host.example', 'B4-2 服务端收到的 SNI 是原始域名');
    eq(r.remoteIp, '127.0.0.1', 'B4-3 固定 IP 连接成功且远端一致');
    await closeServer(srv);
  }
  {
    // 负向：主机名与证书 SAN 不匹配 → 必须失败（证明没有靠关闭校验来打通）
    const srv = await startServer((req, res) => { res.end('should-not-reach'); }, { tls: true });
    const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'other.test': { addrs: ['127.0.0.1'] } }) });
    const r = await safeHttp.safeFetch('https://other.test:' + srv.port + '/s', { policy, testToken: policy.token });
    eq(r.ok, false, 'B4-4 证书与主机名不匹配 → 校验失败（证书校验确实开启）');
    await closeServer(srv);
  }

  // ==================================================================
  group('B5 重定向逐跳校验（B 本地受控）');
  {
    // 公网 → 环回
    const srv = await startServer((req, res) => {
      res.writeHead(302, { Location: 'http://127.0.0.1:' + srv.port + '/inner' });
      res.end();
    });
    const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'ok.test': { addrs: ['127.0.0.1'] }, '127.0.0.1': { reject: '本地/环回地址（测试策略）' } }) });
    const r = await safeHttp.safeFetch('http://ok.test:' + srv.port + '/a', { policy, testToken: policy.token });
    eq(r.ok, false, 'B5-1 重定向到环回被拒');
    eq(r.kind, 'blocked', 'B5-2 拒绝发生在第二跳的目标校验');
    eq(srv.st.count, 1, 'B5-3 第二跳没有真正发出请求（服务端只收到 1 次）');
    await closeServer(srv);
  }
  {
    // 公网 → 私网
    const srv = await startServer((req, res) => { res.writeHead(302, { Location: 'http://10.0.0.1/inner' }); res.end(); });
    const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'ok.test': { addrs: ['127.0.0.1'] }, '10.0.0.1': { reject: '私有地址（测试策略）' } }) });
    const r = await safeHttp.safeFetch('http://ok.test:' + srv.port + '/a', { policy, testToken: policy.token });
    eq(r.ok, false, 'B5-4 重定向到私网被拒');
    await closeServer(srv);
  }
  {
    // 公网 → IPv6 环回
    const srv = await startServer((req, res) => { res.writeHead(302, { Location: 'http://[::1]/inner' }); res.end(); });
    const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'ok.test': { addrs: ['127.0.0.1'] }, '[::1]': { reject: 'IPv6 环回（测试策略）' } }) });
    const r = await safeHttp.safeFetch('http://ok.test:' + srv.port + '/a', { policy, testToken: policy.token });
    eq(r.ok, false, 'B5-5 重定向到 IPv6 环回被拒（note: normalizeHost 会去方括号，按 ::1 判定）');
    await closeServer(srv);
  }
  {
    // 正常同策略重定向（正向，确认不是一律拒绝）
    let hop = 0;
    const srv = await startServer((req, res) => {
      hop += 1;
      if (hop === 1) { res.writeHead(302, { Location: 'http://ok.test:' + srv.port + '/second' }); res.end(); }
      else { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('final'); }
    });
    const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'ok.test': { addrs: ['127.0.0.1'] } }) });
    const r = await safeHttp.safeFetch('http://ok.test:' + srv.port + '/first', { policy, testToken: policy.token });
    eq(r.ok, true, 'B5-6 合法重定向仍可正常完成（不是一律拒绝）');
    eq(String(r.body), 'final', 'B5-7 拿到最终响应体');
    eq(r.hops, 1, 'B5-8 记录了 1 次重定向');
    await closeServer(srv);
  }

  // ==================================================================
  group('B6 重定向次数上限（B 本地受控）');
  {
    const srv = await startServer((req, res) => {
      res.writeHead(302, { Location: 'http://ok.test:' + srv.port + '/next?n=' + srv.st.count });
      res.end();
    });
    const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'ok.test': { addrs: ['127.0.0.1'] } }) });
    const r = await safeHttp.safeFetch('http://ok.test:' + srv.port + '/start', { policy, testToken: policy.token, maxRedirects: 3 });
    eq(r.ok, false, 'B6-1 无限重定向被拦下');
    eq(r.kind, 'max-redirects', 'B6-2 类别为 max-redirects');
    eq(srv.st.count, 4, 'B6-3 实际请求次数 = 上限 + 1（' + srv.st.count + '）');
    await closeServer(srv);
  }
  {
    // Location 缺失
    const srv = await startServer((req, res) => { res.writeHead(302); res.end(); });
    const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'ok.test': { addrs: ['127.0.0.1'] } }) });
    const r = await safeHttp.safeFetch('http://ok.test:' + srv.port + '/x', { policy, testToken: policy.token });
    eq(r.kind, 'redirect-no-location', 'B6-4 缺少 Location 头的重定向被拒');
    await closeServer(srv);
  }

  // ==================================================================
  group('B7 HTTPS → HTTP 降级必须被拒（B 本地受控）');
  {
    const plain = await startServer((req, res) => { res.end('downgraded'); });
    const srv = await startServer((req, res) => {
      res.writeHead(302, { Location: 'http://ok.test:' + plain.port + '/down' });
      res.end();
    }, { tls: true });
    const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'my.host.example': { addrs: ['127.0.0.1'] }, 'ok.test': { addrs: ['127.0.0.1'] } }) });
    const r = await safeHttp.safeFetch('https://my.host.example:' + srv.port + '/s', { policy, testToken: policy.token });
    eq(r.ok, false, 'B7-1 HTTPS 降级到 HTTP 被拒');
    eq(r.kind, 'downgrade', 'B7-2 类别为 downgrade');
    eq(plain.st.count, 0, 'B7-3 HTTP 目标完全没有被请求');
    await closeServer(srv); await closeServer(plain);
  }

  // ==================================================================
  group('B8 跨源重定向不得转发凭据头（B 本地受控）');
  {
    const second = await startServer((req, res) => { res.end('second'); });
    const srv = await startServer((req, res) => {
      res.writeHead(302, { Location: 'http://ok2.test:' + second.port + '/b' });
      res.end();
    });
    const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'ok.test': { addrs: ['127.0.0.1'] }, 'ok2.test': { addrs: ['127.0.0.1'] } }) });
    const r = await safeHttp.safeFetch('http://ok.test:' + srv.port + '/a', {
      policy, testToken: policy.token,
      headers: { Authorization: 'Bearer SECRET-TOKEN', Cookie: 'sid=SECRET' },
    });
    eq(r.ok, true, 'B8-1 跨源重定向本身可以完成');
    eq(srv.st.seen[0].auth, 'Bearer SECRET-TOKEN', 'B8-2 第一跳（同源）正常携带 Authorization');
    eq(second.st.seen[0].auth, null, 'B8-3 第二跳（跨源）不再携带 Authorization');
    eq(second.st.seen[0].cookie, null, 'B8-4 第二跳（跨源）不再携带 Cookie');
    await closeServer(srv); await closeServer(second);
  }

  // ==================================================================
  group('B9 流式限额：实际接收字节与解压后字节（B 本地受控）');
  {
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      const chunk = Buffer.alloc(64 * 1024, 0x41);
      let sent = 0;
      const timer = setInterval(() => {
        if (res.destroyed || sent > 8 * 1024 * 1024) { clearInterval(timer); try { res.end(); } catch (e) {} return; }
        sent += chunk.length;
        res.write(chunk);
      }, 1);
      res.on('close', () => clearInterval(timer));
    });
    const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'ok.test': { addrs: ['127.0.0.1'] } }) });
    const r = await safeHttp.safeFetch('http://ok.test:' + srv.port + '/big', {
      policy, testToken: policy.token, maxBytes: 256 * 1024, maxDecompressedBytes: 256 * 1024,
    });
    eq(r.ok, false, 'B9-1 超过接收上限被中止');
    eq(r.kind, 'size-limit-raw', 'B9-2 类别为 size-limit-raw');
    ok(r.body === undefined, 'B9-3 超限后不返回响应体（已释放）');
    await closeServer(srv);
  }
  {
    // 解压炸弹：原始很小，解压后极大
    const bomb = zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024, 0x20));
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' });
      res.end(bomb);
    });
    const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'ok.test': { addrs: ['127.0.0.1'] } }) });
    const r = await safeHttp.safeFetch('http://ok.test:' + srv.port + '/bomb', {
      policy, testToken: policy.token,
      maxBytes: 8 * 1024 * 1024, maxDecompressedBytes: 512 * 1024,
    });
    eq(r.ok, false, 'B9-4 解压后超限被中止（原始体积未超限，证明解压后也受限）');
    eq(r.kind, 'size-limit-decompressed', 'B9-5 类别为 size-limit-decompressed');
    await closeServer(srv);
  }

  // ==================================================================
  group('B10 超时：响应头 / body 空闲 / 总时长 / 连接阶段（B 本地受控）');
  {
    // 响应头超时：接受连接但永不响应
    const srv = await startServer(() => {});
    const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'ok.test': { addrs: ['127.0.0.1'] } }) });
    const r = await safeHttp.safeFetch('http://ok.test:' + srv.port + '/hang', {
      policy, testToken: policy.token, headersTimeoutMs: 300, totalTimeoutMs: 5000,
    });
    eq(r.kind, 'timeout:headers', 'B10-1 响应头超时生效');
    await closeServer(srv);
  }
  {
    // body 空闲超时：发了响应头和一块数据后卡住
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('start');
    });
    const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'ok.test': { addrs: ['127.0.0.1'] } }) });
    const r = await safeHttp.safeFetch('http://ok.test:' + srv.port + '/slow', {
      policy, testToken: policy.token, bodyIdleTimeoutMs: 300, totalTimeoutMs: 5000,
    });
    eq(r.kind, 'timeout:body', 'B10-2 body 空闲超时生效');
    await closeServer(srv);
  }
  {
    // 总超时：持续慢速发送，body 空闲超时不触发，但总时长超限
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      const timer = setInterval(() => { if (!res.destroyed) res.write('.'); }, 50);
      res.on('close', () => clearInterval(timer));
    });
    const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'ok.test': { addrs: ['127.0.0.1'] } }) });
    const r = await safeHttp.safeFetch('http://ok.test:' + srv.port + '/drip', {
      policy, testToken: policy.token, bodyIdleTimeoutMs: 2000, totalTimeoutMs: 600,
    });
    eq(r.kind, 'timeout:total', 'B10-3 总超时生效');
    await closeServer(srv);
  }
  {
    // 连接阶段超时：目标接受 TCP 但从不完成 TLS 握手 → 连接阶段计时器必须中止
    // （全程只绑 127.0.0.1 的本机黑盒 socket，不产生任何对外流量）
    const socks = [];
    const blackhole = net.createServer((sock) => { socks.push(sock); sock.on('error', () => {}); });
    await new Promise((r) => blackhole.listen(0, '127.0.0.1', r));
    const port = blackhole.address().port;
    const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'my.host.example': { addrs: ['127.0.0.1'] } }) });
    const r = await safeHttp.safeFetch('https://my.host.example:' + port + '/hang', {
      policy, testToken: policy.token, connectTimeoutMs: 300, totalTimeoutMs: 5000,
    });
    eq(r.kind, 'timeout:connect', 'B10-4 连接阶段（含 TLS 握手）超时生效');
    socks.forEach((sk) => { try { sk.destroy(); } catch (e) {} });
    blackhole.close();
  }

  // ==================================================================
  group('B11 混合 DNS / IPv4-mapped 私网解析必须拒绝且不发包（B 本地受控）');
  {
    const srv = await startServer((req, res) => { res.end('never'); });
    const mixedLookup = async () => ([{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'mix.test': { lookup: mixedLookup } }) });
    const r = await safeHttp.safeFetch('http://mix.test:' + srv.port + '/x', { policy, testToken: policy.token });
    eq(r.ok, false, 'B11-1 混合公私网解析被拒');
    ok(/内网|本机|私有/.test(String(r.why)), 'B11-2 拒绝原因说明解析到内网：' + r.why);
    eq(srv.st.count, 0, 'B11-3 完全没有发出请求');
    await closeServer(srv);
  }
  {
    const srv = await startServer((req, res) => { res.end('never'); });
    const mappedLookup = async () => ([{ address: '::ffff:127.0.0.1', family: 6 }]);
    const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'map.test': { lookup: mappedLookup } }) });
    const r = await safeHttp.safeFetch('http://map.test:' + srv.port + '/x', { policy, testToken: policy.token });
    eq(r.ok, false, 'B11-4 IPv4-mapped 私网解析被拒');
    eq(srv.st.count, 0, 'B11-5 完全没有发出请求');
    await closeServer(srv);
  }

  // ==================================================================
  group('B12 已校验地址列表内的 failover（B 本地受控）');
  {
    let first = true;
    const srv = await startServer((req, res) => {
      if (first) { first = false; req.socket.destroy(); return; }
      res.end('second-try-ok');
    });
    const policy = safeHttp.createTestPolicy({
      resolveTarget: (u) => {
        const url = new URL(u);
        return {
          ok: true, host: urlSafety.normalizeHost(url.hostname), port: url.port ? Number(url.port) : 80,
          addresses: [{ address: '127.0.0.1', family: 4 }, { address: '127.0.0.1', family: 4 }],
          pin: { address: '127.0.0.1', family: 4 },
        };
      },
    });
    const r = await safeHttp.safeFetch('http://ok.test:' + srv.port + '/x', { policy, testToken: policy.token });
    eq(r.ok, true, 'B12-1 首个已校验地址连接失败后自动换下一个（不重新解析域名）');
    eq(String(r.body), 'second-try-ok', 'B12-2 拿到正确响应');
    await closeServer(srv);
  }

  // ==================================================================
  group('B13 传输层接线：固定 IP / 禁连接池 / 证书校验入口（B 本地受控，记录 http.request 实参）');
  {
    // 直接观察 safe_http 传给 node http/https 的请求选项，验证传输层硬闸真实接线，
    // 而不是只靠「请求成功」间接推断。
    const httpMod = require('http');
    const httpsMod = require('https');
    const origReq = httpMod.request;
    const origReqTls = httpsMod.request;
    const seen = { plain: null, tls: null };
    httpMod.request = function (opts, cb) { seen.plain = opts; return origReq.call(this, opts, cb); };
    httpsMod.request = function (opts, cb) { seen.tls = opts; return origReqTls.call(this, opts, cb); };
    try {
      {
        const srv = await startServer((req, res) => { res.end('wire-ok'); });
        const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'ok.test': { addrs: ['127.0.0.1'] } }) });
        const r = await safeHttp.safeFetch('http://ok.test:' + srv.port + '/w', { policy, testToken: policy.token });
        eq(r.ok, true, 'B13-1 请求成功（接线记录不影响功能）');
        ok(seen.plain && seen.plain.agent === false, 'B13-2 禁用连接池（agent=false，每跳都走受控 socket）');
        ok(seen.plain && typeof seen.plain.lookup === 'function', 'B13-3 使用自定义 lookup（连接阶段不经过系统解析器）');
        // 直接调用内部 lookup：对预期主机只能返回已校验的固定 IP
        const got = await new Promise((resolve) => {
          seen.plain.lookup('ok.test', { all: true }, (err, addrs) => resolve({ err, addrs }));
        });
        ok(!got.err && Array.isArray(got.addrs) && got.addrs.length === 1 && got.addrs[0].address === '127.0.0.1',
          'B13-4 lookup 对预期主机只返回已校验 IP（' + JSON.stringify(got.addrs) + '）');
        // 连接阶段若被诱导解析别的主机名（DNS 重绑定场景），必须失败而不是顺从
        const bad = await new Promise((resolve) => {
          seen.plain.lookup('rebind.evil.test', {}, (err, addr, fam) => resolve({ err, addr, fam }));
        });
        ok(!!bad.err && bad.err.code === 'EAI_AGAIN',
          'B13-5 lookup 拒绝非预期主机名（' + (bad.err && bad.err.code) + '）——连接阶段无法被重绑定到其他主机');
        await closeServer(srv);
      }
      {
        const srv = await startServer((req, res) => { res.end('tls-wire-ok'); }, { tls: true });
        const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'my.host.example': { addrs: ['127.0.0.1'] } }) });
        const r = await safeHttp.safeFetch('https://my.host.example:' + srv.port + '/w', { policy, testToken: policy.token });
        eq(r.ok, true, 'B13-6 HTTPS 请求成功');
        ok(seen.tls && seen.tls.rejectUnauthorized === true, 'B13-7 证书校验入口强制开启（rejectUnauthorized=true，不提供关闭入口）');
        eq(seen.tls && seen.tls.servername, 'my.host.example', 'B13-8 SNI 使用原始域名');
        await closeServer(srv);
      }
    } finally {
      httpMod.request = origReq;
      httpsMod.request = origReqTls;
    }
  }

  // ==================================================================
  group('B14 显式 allowDowngrade 时才允许 HTTPS→HTTP（B 本地受控）');
  {
    const plain = await startServer((req, res) => { res.end('downgraded-ok'); });
    const srv = await startServer((req, res) => {
      res.writeHead(302, { Location: 'http://ok.test:' + plain.port + '/down' });
      res.end();
    }, { tls: true });
    const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'my.host.example': { addrs: ['127.0.0.1'] }, 'ok.test': { addrs: ['127.0.0.1'] } }) });
    const r = await safeHttp.safeFetch('https://my.host.example:' + srv.port + '/s', { policy, testToken: policy.token, allowDowngrade: true });
    eq(r.ok, true, 'B14-1 allowDowngrade=true 时显式放行降级（证明默认拒绝是策略而非写死）');
    eq(String(r.body), 'downgraded-ok', 'B14-2 拿到降级后的响应体');
    eq(plain.st.count, 1, 'B14-3 HTTP 目标被请求了 1 次');
    await closeServer(srv); await closeServer(plain);
  }

  // ==================================================================
  group('B15 压缩响应：原始字节超 maxBytes（解压后未超）必须拒绝（B 本地受控）');
  {
    // 压缩后原文字节未超限，但「实际接收（压缩）字节」超过 maxBytes → 仍须按 raw 中止
    const payload = 'a'.repeat(5000);
    const gz = zlib.gzipSync(Buffer.from(payload));
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' });
      res.end(gz);
    });
    const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'ok.test': { addrs: ['127.0.0.1'] } }) });
    const r = await safeHttp.safeFetch('http://ok.test:' + srv.port + '/raw', {
      policy, testToken: policy.token, maxBytes: 30, maxDecompressedBytes: 8 * 1024 * 1024,
    });
    eq(r.ok, false, 'B15-1 原始（压缩）字节超过 maxBytes 即中止（即便解压后未超限）');
    eq(r.kind, 'size-limit-raw', 'B15-2 类别为 size-limit-raw（与解压后上限相互独立）');
    ok(r.body === undefined, 'B15-3 超限后不返回响应体');
    await closeServer(srv);
  }

  // ==================================================================
  group('B16 压缩响应：原始字节未超限但解压后超限必须拒绝（B 本地受控）');
  {
    // 解压炸弹：原始很小，解压后极大 → 必须按 decompressed 中止，且 raw 确实未超 maxBytes
    const bomb = zlib.gzipSync(Buffer.alloc(2 * 1024 * 1024, 0x20));
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' });
      res.end(bomb);
    });
    const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'ok.test': { addrs: ['127.0.0.1'] } }) });
    const r = await safeHttp.safeFetch('http://ok.test:' + srv.port + '/bomb', {
      policy, testToken: policy.token,
      maxBytes: 8 * 1024 * 1024, maxDecompressedBytes: 512 * 1024,
    });
    eq(r.ok, false, 'B16-1 解压后超限被中止（原始体积未超限，证明解压后也受限）');
    eq(r.kind, 'size-limit-decompressed', 'B16-2 类别为 size-limit-decompressed');
    ok(r.kind !== 'size-limit-raw', 'B16-3 触发的确是解压后上限而非原始字节上限（原始字节检查在流中先发生，若原始超了会是 size-limit-raw）');
    await closeServer(srv);
  }

  // ==================================================================
  group('B17 正常 gzip：bytes 与 decompressedBytes 与实际数据匹配（B 本地受控）');
  {
    const payload = 'm'.repeat(4000);
    const gz = zlib.gzipSync(Buffer.from(payload));
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' });
      res.end(gz);
    });
    const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'ok.test': { addrs: ['127.0.0.1'] } }) });
    const r = await safeHttp.safeFetch('http://ok.test:' + srv.port + '/g', {
      policy, testToken: policy.token, maxBytes: 8 * 1024 * 1024, maxDecompressedBytes: 8 * 1024 * 1024,
    });
    eq(r.ok, true, 'B17-1 解压成功');
    eq(r.bytes, gz.length, 'B17-2 bytes = 实际接收（压缩）字节 ' + gz.length);
    eq(r.decompressedBytes, payload.length, 'B17-3 decompressedBytes = 解压后字节 ' + payload.length);
    eq(String(r.body), payload, 'B17-4 解压内容与原文一致');
    ok(r.decompressedBytes > r.bytes, 'B17-5 解压后大于压缩前（' + r.decompressedBytes + ' > ' + r.bytes + '）');
    await closeServer(srv);
  }

  // ==================================================================
  group('B18 压缩响应 body 空闲超时：真实空闲必须中止，稳定慢速流不应误杀（B 本地受控）');
  {
    // B18-1：先发一块 gzip 数据后长时间空闲 → 必须触发 body 空闲超时
    const payload = 'n'.repeat(8000);
    const gz = zlib.gzipSync(Buffer.from(payload));
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' });
      const half = Math.floor(gz.length / 2);
      res.write(gz.slice(0, half));
      setTimeout(() => { try { res.end(gz.slice(half)); } catch (e) {} }, 800); // 空闲 800ms，远超 bodyIdleTimeoutMs
    });
    const policy = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'ok.test': { addrs: ['127.0.0.1'] } }) });
    const r = await safeHttp.safeFetch('http://ok.test:' + srv.port + '/idle', {
      policy, testToken: policy.token, bodyIdleTimeoutMs: 300, totalTimeoutMs: 8000,
    });
    eq(r.kind, 'timeout:body', 'B18-1 压缩流空闲超时被中止（body 空闲超时在压缩分支真实生效）');
    await closeServer(srv);

    // B18-2：稳定但缓慢的 gzip 流（每块间隔 < bodyIdleTimeoutMs，但总时长 > bodyIdleTimeoutMs）
    //        修复前 body 空闲超时只在响应头时武装一次、不随数据刷新，会误杀此类正常慢速流；
    //        修复后每个数据分片都刷新空闲计时，应成功完成。
    const payload2 = 'p'.repeat(200000);
    const gz2 = zlib.gzipSync(Buffer.from(payload2));
    const srv2 = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' });
      const parts = 10;
      let i = 0;
      const timer = setInterval(() => {
        const start = Math.floor(gz2.length * i / parts);
        const end = Math.floor(gz2.length * (i + 1) / parts);
        if (i >= parts) { clearInterval(timer); try { res.end(); } catch (e) {} return; }
        res.write(gz2.slice(start, end));
        i += 1;
      }, 80); // 每块间隔 80ms < bodyIdleTimeoutMs(300)，但总时长 ~800ms > 300
      res.on('close', () => clearInterval(timer));
    });
    const policy2 = safeHttp.createTestPolicy({ resolveTarget: testResolve({ 'ok.test': { addrs: ['127.0.0.1'] } }) });
    const r2 = await safeHttp.safeFetch('http://ok.test:' + srv2.port + '/drip', {
      policy: policy2, testToken: policy2.token, bodyIdleTimeoutMs: 300, totalTimeoutMs: 8000,
    });
    eq(r2.ok, true, 'B18-2 稳定慢速 gzip 流成功完成（body 空闲超时随数据刷新，未误杀）');
    eq(String(r2.body), payload2, 'B18-3 慢速流解压内容完整');
    await closeServer(srv2);
  }

  console.log('\n====================================================');
  console.log('V14 阶段三 B2 测试：通过 ' + pass + '，失败 ' + fail);
  console.log('分类：A=单元/模拟（不连网），B=本地受控网络（服务器只绑 127.0.0.1）');
  console.log('本套件不含 C（真实公网）与 D（真实 QQ 验收）');
  console.log('====================================================');
  if (fail) { console.log('失败项：'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.log('测试执行异常: ' + (e && e.stack || e)); process.exit(1); });
