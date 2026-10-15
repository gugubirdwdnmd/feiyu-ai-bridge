'use strict';
// ================= V14 阶段三 B1 测试套件：IP 分类内核 + userinfo 拒绝 =================
// 类别：全部为【A 单元 / 模拟】——不发起任何网络连接，DNS 一律通过注入的 lookup 模拟。
// 覆盖：
//   G1 IPv4 特殊用途地址段分类（S4）
//   G2 IPv6 展开与分类：环回/未指定/ULA/链路本地/组播/文档/mapped/compatible/NAT64/6to4（S3+S4）
//   G3 isSafeUrl 拒绝矩阵（字面量、域名、协议、变形）
//   G4 isSafeUrl 放行矩阵（合法公网必须放行，不能靠一律拒绝通过测试）
//   G5 userinfo 拒绝与剥离（S6）
//   G6 resolveTarget：注入 lookup 的全公网 / 混合 / 全私 / 空 / 抛错场景 + 端口推导
//   G7 safeTargetSync 返回形状（旧调用方依赖）
//   G8 旧导出与常量保持存在
//   G9 sanitizeUrlForUse

const urlSafety = require('../url_safety');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name) { if (cond) pass++; else { fail++; fails.push(name); console.log('  ✗ ' + name); } }
function eq(a, b, name) { ok(a === b, name + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function group(t) { console.log('\n[' + t + ']'); }

// ——— 注入式 DNS（A 级：绝不真实解析）———
function fakeLookup(map) {
  return async function (host, opts) {
    fakeLookup.calls.push(host);
    const v = map[host];
    if (v && typeof v.reject === 'string') throw new Error(v.reject);
    if (!v) throw new Error('ENOTFOUND ' + host);
    return (v.addrs || []).map((a) => {
      const fam = typeof a === 'string' && a.indexOf(':') >= 0 ? 6 : 4;
      return { address: a, family: fam };
    });
  };
}
fakeLookup.calls = [];

(async function main() {

  // ================= G1 IPv4 =================
  group('G1 IPv4 特殊用途地址段必须判为私有/保留（S4）');
  const v4Bad = [
    ['0.0.0.0', '0.0.0.0/8'],
    ['0.255.255.255', '0.0.0.0/8 上界'],
    ['10.0.0.1', '10/8'],
    ['10.255.255.254', '10/8 上界'],
    ['127.0.0.1', '127/8 环回'],
    ['127.1.2.3', '127/8 环回'],
    ['100.64.0.1', '100.64/10 CGNAT 下界'],
    ['100.127.255.255', '100.64/10 CGNAT 上界'],
    ['169.254.169.254', '169.254/16 云元数据'],
    ['172.16.0.1', '172.16/12 下界'],
    ['172.31.255.254', '172.16/12 上界'],
    ['192.168.1.1', '192.168/16'],
    ['192.0.0.1', '192.0.0.0/24'],
    ['192.0.2.1', 'TEST-NET-1'],
    ['192.88.99.1', '6to4 中继'],
    ['198.18.0.1', '198.18/15 基准'],
    ['198.19.255.255', '198.18/15 基准上界'],
    ['198.51.100.1', 'TEST-NET-2'],
    ['203.0.113.1', 'TEST-NET-3'],
    ['224.0.0.1', '224/4 组播'],
    ['239.255.255.255', '224/4 组播上界'],
    ['240.0.0.1', '240/4 保留'],
    ['255.255.255.255', '广播'],
  ];
  for (const [ip, why] of v4Bad) {
    const c = urlSafety.classifyIp(ip);
    eq(c.isPrivate, true, 'G1 判私有 ' + ip + '（' + why + '）实际 reason=' + c.reason);
  }
  const v4Good = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '114.114.114.114', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1', '192.0.1.1', '198.17.255.255', '198.20.0.1', '223.255.255.255'];
  for (const ip of v4Good) eq(urlSafety.classifyIp(ip).isPrivate, false, 'G1 判公网 ' + ip + '（实际 reason=' + urlSafety.classifyIp(ip).reason + '）');
  eq(urlSafety.classifyIp('256.1.1.1').isPrivate, true, 'G1-末 非法 IPv4（256.x）保守拒绝');
  eq(urlSafety.classifyIp('1.2.3').isPrivate, true, 'G1-末 三段地址保守拒绝');
  eq(urlSafety.classifyIp('').isPrivate, true, 'G1-末 空地址保守拒绝');

  // ================= G2 IPv6 =================
  group('G2 IPv6 展开与分类（S3 + S4）');
  const v6Bad = [
    ['::', '未指定'],
    ['::1', '环回'],
    ['0:0:0:0:0:0:0:1', '环回（完全展开写法）'],
    ['0000:0000:0000:0000:0000:0000:0000:0001', '环回（零填充写法）'],
    ['fc00::1', 'ULA fc00::/7 下界'],
    ['fdff:ffff::1', 'ULA fc00::/7 上界'],
    ['fe80::1', '链路本地'],
    ['febf:ffff::1', '链路本地上界'],
    ['ff02::1', '组播'],
    ['ff00::', '组播下界'],
    ['2001:db8::1', '文档地址'],
    ['2001:0db8:0000:0000:0000:0000:0000:0001', '文档地址（展开）'],
    ['::ffff:127.0.0.1', 'IPv4-mapped 环回（点分写法）'],
    ['::ffff:7f00:1', 'IPv4-mapped 环回（十六进制写法）'],
    ['::ffff:10.0.0.1', 'IPv4-mapped 私网'],
    ['::ffff:169.254.169.254', 'IPv4-mapped 链路本地'],
    ['::127.0.0.1', 'IPv4-compatible 环回'],
    ['::7f00:1', 'IPv4-compatible 环回（十六进制）'],
    ['64:ff9b::7f00:1', 'NAT64 内嵌环回'],
    ['64:ff9b::10.0.0.1', 'NAT64 内嵌私网'],
    ['64:ff9b:1::7f00:1', 'NAT64 本地用变体'],
    ['2002:7f00:1::', '6to4 内嵌环回'],
    ['2002:a00:1::', '6to4 内嵌私网 10.0.0.1'],
    ['2002:c0a8:101::', '6to4 内嵌私网 192.168.1.1'],
    ['2001::1', 'Teredo'],
    ['2001:2::1', '基准测试'],
    ['2001:10::1', 'ORCHID'],
    ['2001:20::1', 'ORCHIDv2'],
    ['100::1', '丢弃专用'],
  ];
  for (const [ip, why] of v6Bad) {
    const c = urlSafety.classifyIp(ip);
    eq(c.isPrivate, true, 'G2 判私有 ' + ip + '（' + why + '）实际 reason=' + c.reason);
  }
  const v6Good = ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '2002:0808:0808::', '2400:3200::1'];
  for (const ip of v6Good) eq(urlSafety.classifyIp(ip).isPrivate, false, 'G2 判公网 ' + ip + '（实际 reason=' + urlSafety.classifyIp(ip).reason + '）');
  eq(urlSafety.classifyIp('gggg::1').isPrivate, true, 'G2-末 非法 IPv6 保守拒绝');
  eq(urlSafety.classifyIp('1:2:3:4:5:6:7:8:9').isPrivate, true, 'G2-末 段数超限保守拒绝');
  eq(urlSafety.classifyIp('1::2::3').isPrivate, true, 'G2-末 多个 :: 保守拒绝');
  eq(urlSafety.classifyIp('[::1]').isPrivate, true, 'G2-末 带方括号也能正确判定（S3 根因）');
  eq(urlSafety.classifyIp('[fe80::1]').isPrivate, true, 'G2-末 带方括号的链路本地也能判定');

  // ================= G3 isSafeUrl 拒绝矩阵 =================
  group('G3 isSafeUrl 拒绝矩阵');
  const badUrls = [
    'http://127.0.0.1:3000/x', 'http://localhost/x', 'http://LOCALHOST/x',
    'http://10.0.0.5/x', 'http://192.168.1.1/x', 'http://172.16.0.1/x', 'http://172.31.0.1/x',
    'http://169.254.169.254/latest', 'http://100.64.0.1/x', 'http://192.0.2.1/x',
    'http://198.51.100.1/x', 'http://203.0.113.1/x', 'http://198.18.0.1/x', 'http://192.0.0.1/x',
    'http://224.0.0.1/x', 'http://240.0.0.1/x', 'http://255.255.255.255/x',
    'http://[::1]/x', 'http://[::]/x', 'http://[0:0:0:0:0:0:0:1]/x', 'http://[fe80::1]/x',
    'http://[fd00::1]/x', 'http://[ff02::1]/x', 'http://[2001:db8::1]/x',
    'http://[::ffff:127.0.0.1]/x', 'http://[64:ff9b::7f00:1]/x', 'http://[2002:7f00:1::]/x',
    'http://2130706433/x', 'http://0177.0.0.1/x', 'http://0x7f000001/x',
    'file:///C:/Windows/win.ini', 'ftp://example.com/a', 'data:text/html,x',
    'javascript:alert(1)', 'gopher://127.0.0.1/_x', 'ws://127.0.0.1/x',
    'http://foo.local/x', 'http://foo.localhost/x', 'http://foo.internal/x', 'http://foo.home.arpa/x',
    'https://user:pass@example.com/x', 'https://user@example.com/x', 'https://:pass@example.com/x',
    'https://example.com@127.0.0.1/x', 'http://user:pass@[::1]/x',
  ];
  for (const u of badUrls) eq(urlSafety.isSafeUrl(u), false, 'G3 拒绝 ' + u);

  // ================= G4 isSafeUrl 放行矩阵（不能靠一律拒绝通过测试）=================
  group('G4 合法公网必须放行');
  const goodUrls = [
    'https://example.com/x', 'http://example.com/x', 'https://example.com:8080/x/y',
    'https://www.xiaoheihe.cn/bbs/post_share?link_id=90cb7283ee5b',
    'https://b23.tv/uYyD4B3', 'https://api.bilibili.com/x', 'https://www.bilibili.com/video/BV1ihH96TECf',
    'https://sub.domain.example.co.uk/a/b?c=1&d=2', 'https://8.8.8.8/x', 'https://1.1.1.1:8443/x',
    'https://[2606:4700:4700::1111]/x', 'https://example.com./x',
  ];
  for (const u of goodUrls) eq(urlSafety.isSafeUrl(u), true, 'G4 放行 ' + u);

  // ================= G5 userinfo（S6）=================
  group('G5 userinfo 拒绝与剥离（S6）');
  eq(urlSafety.hasCredentials('https://u:p@a.com/x'), true, 'G5-1 用户名+密码');
  eq(urlSafety.hasCredentials('https://u@a.com/x'), true, 'G5-2 只有用户名');
  eq(urlSafety.hasCredentials('https://:p@a.com/x'), true, 'G5-3 只有密码');
  eq(urlSafety.hasCredentials('https://a.com/x'), false, 'G5-4 无凭据不误判');
  eq(urlSafety.hasCredentials('https://a.com/x?u=1&p=2'), false, 'G5-5 查询参数不算凭据');
  eq(urlSafety.safeTargetSync('https://u:p@a.com/x').ok, false, 'G5-6 safeTargetSync 拒绝 userinfo');
  eq(urlSafety.safeTargetSync('https://u:p@127.0.0.1/x').why, 'URL 不允许携带用户名或密码', 'G5-7 拒绝原因可读');
  const stripped = urlSafety.sanitizeUrlForUse('https://u:p@a.com/x?token=abc&k=1');
  ok(stripped.indexOf('u:p@') < 0, 'G5-8 交给模型的 URL 已剥离 userinfo（实际 ' + stripped + '）');
  ok(stripped.indexOf('token') < 0, 'G5-9 剥离 userinfo 的同时仍剥敏感参数 token');

  // ================= G6 resolveTarget（注入 lookup，A 级）=================
  group('G6 resolveTarget：解析结果与待固定 IP（S5 前置）');
  {
    fakeLookup.calls = [];
    const map = { 'pub.example': { addrs: ['93.184.216.34'] } };
    const r = await urlSafety.resolveTarget('https://pub.example/a', { lookup: fakeLookup(map) });
    eq(r.ok, true, 'G6-1 全公网解析放行');
    eq(r.pin.address, '93.184.216.34', 'G6-2 pin 指向第一个公网地址');
    eq(r.pin.family, 4, 'G6-3 pin family 正确');
    eq(r.port, 443, 'G6-4 https 默认端口 443');
    eq(fakeLookup.calls.length, 1, 'G6-5 只解析一次');
  }
  {
    const r = await urlSafety.resolveTarget('http://pub.example:8080/a', { lookup: fakeLookup({ 'pub.example': { addrs: ['93.184.216.34'] } }) });
    eq(r.port, 8080, 'G6-6 显式端口保留');
  }
  {
    const r = await urlSafety.resolveTarget('https://mix.example/a', { lookup: fakeLookup({ 'mix.example': { addrs: ['93.184.216.34', '127.0.0.1'] } }) });
    eq(r.ok, false, 'G6-7 混合解析（公+私）整体拒绝');
    ok(/内网/.test(r.why), 'G6-8 拒绝原因可读：' + r.why);
  }
  {
    const r = await urlSafety.resolveTarget('https://mix2.example/a', { lookup: fakeLookup({ 'mix2.example': { addrs: ['10.0.0.1', '93.184.216.34'] } }) });
    eq(r.ok, false, 'G6-9 私网出现在第一个也要拒绝');
  }
  {
    const r = await urlSafety.resolveTarget('https://v6.example/a', { lookup: fakeLookup({ 'v6.example': { addrs: ['2606:4700:4700::1111', '[::1]'] } }) });
    eq(r.ok, false, 'G6-10 混合解析含 IPv6 环回也要拒绝');
  }
  {
    const r = await urlSafety.resolveTarget('https://empty.example/a', { lookup: fakeLookup({ 'empty.example': { addrs: [] } }) });
    eq(r.ok, false, 'G6-11 解析为空拒绝');
  }
  {
    const r = await urlSafety.resolveTarget('https://throw.example/a', { lookup: fakeLookup({ 'throw.example': { reject: 'ENOTFOUND' } }) });
    eq(r.ok, false, 'G6-12 解析抛错 → 保守拒绝');
    eq(r.why, '域名解析失败', 'G6-13 抛错的拒绝原因');
  }
  {
    const r = await urlSafety.resolveTarget('https://mapped.example/a', { lookup: fakeLookup({ 'mapped.example': { addrs: ['::ffff:93.184.216.34'] } }) });
    eq(r.ok, true, 'G6-14 IPv4-mapped 公网解析结果放行（不误伤双栈）');
  }
  {
    fakeLookup.calls = [];
    const r = await urlSafety.resolveTarget('https://1.1.1.1:8443/a', { lookup: fakeLookup({}) });
    eq(r.ok, true, 'G6-15 IP 字面量直接放行');
    eq(fakeLookup.calls.length, 0, 'G6-16 IP 字面量不触发 DNS');
    eq(r.port, 8443, 'G6-17 IP 字面量端口正确');
  }
  {
    const r = await urlSafety.resolveTarget('https://[2606:4700:4700::1111]/a', { lookup: fakeLookup({}) });
    eq(r.ok, true, 'G6-18 公网 IPv6 字面量放行');
    eq(r.pin.family, 6, 'G6-19 IPv6 字面量 family=6');
  }
  {
    const a = await urlSafety.assertSafeTarget('https://pub.example/a', { lookup: fakeLookup({ 'pub.example': { addrs: ['93.184.216.34'] } }) });
    eq(a.ok, true, 'G6-20 assertSafeTarget 注入解析仍可用（旧签名）');
    const b = await urlSafety.assertSafeTarget('https://bad.example/a', { lookup: fakeLookup({ 'bad.example': { addrs: ['192.168.0.1'] } }) });
    eq(b.ok, false, 'G6-21 assertSafeTarget 私网解析拒绝');
  }

  // ================= G7 safeTargetSync 形状（旧调用方依赖）=================
  group('G7 safeTargetSync 返回形状保持（旧调用方依赖）');
  eq(urlSafety.safeTargetSync('http://127.0.0.1:8080/inner').ok, false, 'G7-1 环回被拒');
  eq(urlSafety.safeTargetSync('http://10.0.0.5/inner').ok, false, 'G7-2 私网 10.x 被拒');
  eq(urlSafety.safeTargetSync('http://192.168.0.9/inner').ok, false, 'G7-3 192.168.x 被拒');
  eq(urlSafety.safeTargetSync('http://172.20.1.1/inner').ok, false, 'G7-4 172.16-31 被拒');
  eq(urlSafety.safeTargetSync('http://169.254.169.254/latest').ok, false, 'G7-5 云元数据被拒');
  eq(urlSafety.safeTargetSync('http://[::1]/inner').ok, false, 'G7-6 IPv6 ::1 被拒');
  eq(urlSafety.safeTargetSync('http://[fc00::1]/inner').ok, false, 'G7-7 fc00:: 被拒');
  eq(urlSafety.safeTargetSync('http://[fe80::1]/inner').ok, false, 'G7-8 fe80:: 被拒');
  eq(urlSafety.safeTargetSync('http://[::ffff:127.0.0.1]/inner').ok, false, 'G7-9 ::ffff:127.0.0.1 被拒');
  eq(urlSafety.safeTargetSync('file:///etc/passwd').ok, false, 'G7-10 非 http(s) 被拒');
  eq(urlSafety.safeTargetSync('https://example.com/ok').needResolve, true, 'G7-11 公网域名仍需 DNS 校验');
  eq(urlSafety.safeTargetSync('https://1.1.1.1/ok').needResolve, undefined, 'G7-12 IP 字面量不需要解析');
  eq(urlSafety.safeTargetSync('http://100.64.0.1/x').ok, false, 'G7-13 CGNAT 被拒');
  eq(urlSafety.safeTargetSync('http://[2002:7f00:1::]/x').ok, false, 'G7-14 6to4 被拒');

  // ================= G8 旧导出与常量 =================
  group('G8 旧导出与常量未丢失');
  for (const fn of ['isSafeUrl', 'isPrivateIpLiteral', 'safeTargetSync', 'assertSafeTarget', 'safeUrlForLog', 'sanitizeUrlForUse']) {
    eq(typeof urlSafety[fn], 'function', 'G8 导出 ' + fn + ' 仍存在');
  }
  eq(urlSafety.MAX_REDIRECTS, 5, 'G8 重定向上限仍为 5');
  eq(urlSafety.safeUrlForLog('https://a.com/p?h_session_id=SECRET&x=1'), 'https://a.com/p', 'G8 日志脱敏未变');
  eq(urlSafety.sanitizeUrlForUse('https://a.com/p?token=SECRET&x=1'), 'https://a.com/p?x=1', 'G8 敏感参数剥离未变');
  eq(urlSafety.isPrivateIpLiteral('[::1]'), true, 'G8 isPrivateIpLiteral 现在也能处理方括号');
  eq(urlSafety.isPrivateIpLiteral('8.8.8.8'), false, 'G8 isPrivateIpLiteral 公网仍返回 false');

  // ================= G9 端到端：入口层三重校验一致 =================
  group('G9 isSafeUrl / safeTargetSync / resolveTarget 结论必须一致');
  const samples = ['https://example.com/x', 'http://127.0.0.1/x', 'http://[::1]/x', 'https://u:p@example.com/x', 'http://100.64.0.1/x', 'http://foo.internal/x'];
  for (const u of samples) {
    const a = urlSafety.isSafeUrl(u);
    const b = urlSafety.safeTargetSync(u).ok;
    const c = await urlSafety.resolveTarget(u, { lookup: fakeLookup({ 'example.com': { addrs: ['93.184.216.34'] }, 'foo.internal': { addrs: ['10.0.0.1'] } }) });
    eq(a, b, 'G9 isSafeUrl 与 safeTargetSync 一致：' + u);
    eq(b, c.ok, 'G9 safeTargetSync 与 resolveTarget 一致：' + u);
  }

  console.log('\n====================================================');
  console.log('V14 阶段三 B1 测试：通过 ' + pass + '，失败 ' + fail + '（全部为 A 类：单元/模拟，未发起任何网络连接）');
  console.log('====================================================');
  if (fail) { console.log('失败项：'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.log('测试执行异常: ' + (e && e.stack || e)); process.exit(1); });
