'use strict';
// ================= URL 安全（独立零依赖模块，便于单测）=================
// 演进：
//   V14-C.2  ① isSafeUrl()        基础 SSRF（协议 + 主机名黑名单）
//            ② assertSafeTarget() 重定向逐跳校验（协议 + 主机名 + DNS 解析后的 IP）
//   V14 阶段三 B1（本次）：
//            ③ IP 分类内核重写：IPv4 全覆盖特殊用途段；IPv6 先展开成 16 字节再判定，
//               覆盖 IPv4-mapped / IPv4-compatible / NAT64 / 6to4 / ULA / 链路本地 /
//               组播 / 文档 / Teredo / 基准 / ORCHID / 丢弃段
//            ④ 拒绝带用户名密码（userinfo）的 URL（S6）
//            ⑤ 新增 resolveTarget()，把「域名 → 待固定 IP」的结果显式返回，
//               供后续 B2 的 safe_http.js 做固定 IP 连接（S5）
// 原则：解析失败 / 不认识的地址一律「保守拒绝」，绝不放宽任何既有规则。

const dnsPromises = require('dns').promises;

const MAX_REDIRECTS = 5;

// ============================ IPv4 ============================

// 严格解析点分十进制；不合法返回 null（调用方一律按「不认识 → 拒绝」处理）
function parseIpv4(s) {
  const t = String(s == null ? '' : s).trim();
  const m = t.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  for (const v of o) if (!(v >= 0 && v <= 255)) return null;
  return o;
}

// 返回 { isPrivate, reason }。IPv4 特殊用途段只增不减，全部按「拒绝」处理。
function classifyIpv4(o) {
  const a = o[0], b = o[1], c = o[2];
  if (a === 0) return { isPrivate: true, reason: '0.0.0.0/8 本网络' };
  if (a === 10) return { isPrivate: true, reason: '10.0.0.0/8 私网' };
  if (a === 127) return { isPrivate: true, reason: '127.0.0.0/8 环回' };
  if (a === 100 && b >= 64 && b <= 127) return { isPrivate: true, reason: '100.64.0.0/10 CGNAT' };
  if (a === 169 && b === 254) return { isPrivate: true, reason: '169.254.0.0/16 链路本地' };
  if (a === 172 && b >= 16 && b <= 31) return { isPrivate: true, reason: '172.16.0.0/12 私网' };
  if (a === 192 && b === 168) return { isPrivate: true, reason: '192.168.0.0/16 私网' };
  if (a === 192 && b === 0 && c === 0) return { isPrivate: true, reason: '192.0.0.0/24 IETF 协议分配' };
  if (a === 192 && b === 0 && c === 2) return { isPrivate: true, reason: '192.0.2.0/24 TEST-NET-1' };
  if (a === 192 && b === 88 && c === 99) return { isPrivate: true, reason: '192.88.99.0/24 6to4 中继' };
  if (a === 198 && (b === 18 || b === 19)) return { isPrivate: true, reason: '198.18.0.0/15 基准测试' };
  if (a === 198 && b === 51 && c === 100) return { isPrivate: true, reason: '198.51.100.0/24 TEST-NET-2' };
  if (a === 203 && b === 0 && c === 113) return { isPrivate: true, reason: '203.0.113.0/24 TEST-NET-3' };
  if (a >= 224) return { isPrivate: true, reason: '224.0.0.0/4 组播或保留（含 240/4、255.255.255.255）' };
  return { isPrivate: false, reason: '公网 IPv4' };
}

// ============================ IPv6 ============================

// 展开成 16 字节；无法解析返回 null（→ 保守拒绝）
function parseIpv6(s) {
  let str = String(s == null ? '' : s).trim().toLowerCase();
  if (str.startsWith('[') && str.endsWith(']')) str = str.slice(1, -1);
  const zi = str.indexOf('%');                       // 去掉 scope id（fe80::1%eth0）
  if (zi >= 0) str = str.slice(0, zi);
  if (!str) return null;
  if (/[^0-9a-f:.]/i.test(str)) return null;
  if ((str.match(/::/g) || []).length > 1) return null;

  // 末尾嵌入 IPv4（::ffff:127.0.0.1 / 64:ff9b::127.0.0.1 等）
  let tailV4 = null;
  const li = str.lastIndexOf(':');
  const last = li >= 0 ? str.slice(li + 1) : str;
  if (last.indexOf('.') >= 0) {
    const v4 = parseIpv4(last);
    if (!v4) return null;
    tailV4 = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    str = li >= 0 ? str.slice(0, li + 1) : '';
  }

  let head = str, tail = '';
  const di = str.indexOf('::');
  if (di >= 0) { head = str.slice(0, di); tail = str.slice(di + 2); }
  const hg = head ? head.split(':').filter((x) => x.length > 0) : [];
  const tg = tail ? tail.split(':').filter((x) => x.length > 0) : [];
  const stringGroups = (di >= 0 ? hg.concat(tg) : hg);
  for (const g of stringGroups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;      // tailV4 是数值，不参与此校验
  }
  const headNum = hg.map((g) => parseInt(g, 16));
  const tailNum = tg.map((g) => parseInt(g, 16));
  const v4Num = tailV4 || [];
  let numeric;
  if (di < 0) {
    numeric = headNum.concat(v4Num);
    if (numeric.length !== 8) return null;
  } else {
    const fill = 8 - (headNum.length + tailNum.length + v4Num.length);
    if (fill < 1) return null;                          // '::' 至少要补 1 段
    numeric = headNum.concat(new Array(fill).fill(0)).concat(tailNum).concat(v4Num);
  }
  const bytes = new Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (numeric[i] >> 8) & 0xff;
    bytes[i * 2 + 1] = numeric[i] & 0xff;
  }
  return bytes;
}

function classifyIpv6(b) {
  const g = [];
  for (let i = 0; i < 8; i++) g[i] = (b[i * 2] << 8) | b[i * 2 + 1];

  if (g.every((x) => x === 0)) return { isPrivate: true, reason: ':: 未指定地址' };
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return { isPrivate: true, reason: '::1 IPv6 环回' };

  const emb = [b[12], b[13], b[14], b[15]];
  // IPv4-mapped ::ffff:0:0/96 → 按内嵌 IPv4 判定（公网则放行，避免误伤双栈解析）
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    const r = classifyIpv4(emb);
    return r.isPrivate
      ? { isPrivate: true, reason: 'IPv4-mapped 内嵌内网地址（' + r.reason + '）' }
      : { isPrivate: false, reason: 'IPv4-mapped 公网地址' };
  }
  // IPv4-compatible ::/96（已废弃，但仍按内嵌 IPv4 判定）
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    const r = classifyIpv4(emb);
    return r.isPrivate
      ? { isPrivate: true, reason: 'IPv4-compatible 内嵌内网地址（' + r.reason + '）' }
      : { isPrivate: false, reason: 'IPv4-compatible 公网地址' };
  }
  // NAT64 / IPv4-IPv6 转换 64:ff9b::/32（含 64:ff9b:1::/48 等变体，一律保守拒绝）
  if (g[0] === 0x0064 && g[1] === 0xff9b) return { isPrivate: true, reason: '64:ff9b::/32 NAT64 转换地址' };
  // 6to4 2002::/16（IPv4 嵌在 2~5 字节）
  if (g[0] === 0x2002) {
    const r = classifyIpv4([b[2], b[3], b[4], b[5]]);
    return r.isPrivate
      ? { isPrivate: true, reason: '2002::/16 6to4 内嵌内网地址（' + r.reason + '）' }
      : { isPrivate: false, reason: '2002::/16 6to4 公网地址' };
  }
  if ((g[0] & 0xfe00) === 0xfc00) return { isPrivate: true, reason: 'fc00::/7 唯一本地地址' };
  if ((g[0] & 0xffc0) === 0xfe80) return { isPrivate: true, reason: 'fe80::/10 链路本地' };
  if ((g[0] & 0xff00) === 0xff00) return { isPrivate: true, reason: 'ff00::/8 组播' };
  if (g[0] === 0x2001 && g[1] === 0x0db8) return { isPrivate: true, reason: '2001:db8::/32 文档地址' };
  if (g[0] === 0x2001 && g[1] === 0x0000) return { isPrivate: true, reason: '2001::/32 Teredo' };
  if (g[0] === 0x2001 && g[1] === 0x0002) return { isPrivate: true, reason: '2001:2::/48 基准测试' };
  if (g[0] === 0x2001 && (g[1] & 0xfff0) === 0x0010) return { isPrivate: true, reason: '2001:10::/28 ORCHID' };
  if (g[0] === 0x2001 && (g[1] & 0xfff0) === 0x0020) return { isPrivate: true, reason: '2001:20::/28 ORCHIDv2' };
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return { isPrivate: true, reason: '100::/64 丢弃专用' };
  return { isPrivate: false, reason: '公网 IPv6' };
}

// ============================ 统一分类入口 ============================

/**
 * 分类 IP 地址（IPv4 / IPv6 字面量，可带方括号）
 * @returns { version: 0|4|6, isPrivate: boolean, reason: string }
 *           version 0 表示不认识——调用方一律按拒绝处理
 */
function classifyIp(ip) {
  const raw = String(ip == null ? '' : ip).trim().toLowerCase();
  if (!raw) return { version: 0, isPrivate: true, reason: '空地址' };
  let s = raw;
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zi = s.indexOf('%');
  if (zi >= 0) s = s.slice(0, zi);

  if (s.indexOf(':') >= 0) {                          // IPv6
    const b = parseIpv6(s);
    if (!b) return { version: 6, isPrivate: true, reason: 'IPv6 无法解析' };
    return Object.assign({ version: 6 }, classifyIpv6(b));
  }
  const v4 = parseIpv4(s);
  if (!v4) return { version: 4, isPrivate: true, reason: 'IPv4 无法解析' };
  return Object.assign({ version: 4 }, classifyIpv4(v4));
}

// 旧接口保留（布尔语义不变），内部改走 classifyIp
function isPrivateIpLiteral(ip) {
  return classifyIp(ip).isPrivate;
}

// ============================ 主机名 ============================

function normalizeHost(h) {
  let s = String(h == null ? '' : h).trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zi = s.indexOf('%');
  if (zi >= 0) s = s.slice(0, zi);
  while (s.endsWith('.')) s = s.slice(0, -1);         // 去掉根点（a.com.）
  return s;
}

function isIpLiteral(h) {
  const s = normalizeHost(h);
  if (!s) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return true;
  return s.indexOf(':') >= 0;
}

// 只按「名字」判断（IP 字面量不进这里）
function isPrivateHostname(h) {
  const s = normalizeHost(h);
  if (!s) return { isPrivate: true, reason: '缺少主机名' };
  if (s === 'localhost') return { isPrivate: true, reason: 'localhost' };
  if (s.endsWith('.localhost')) return { isPrivate: true, reason: '.localhost 本机域' };
  if (s.endsWith('.local')) return { isPrivate: true, reason: '.local 本地域' };
  if (s.endsWith('.internal')) return { isPrivate: true, reason: '.internal 内部域' };
  if (s.endsWith('.home.arpa')) return { isPrivate: true, reason: '.home.arpa 家庭网域' };
  return { isPrivate: false, reason: '公网域名' };
}

// S6：URL 携带用户名 / 密码一律拒绝（凭据会随 Authorization 头发给目标主机，
//     且 user@host 形式本身也常被用来迷惑解析器）
function hasCredentials(u) {
  let p = u;
  if (typeof u === 'string') {
    try { p = new URL(u); } catch (e) { return false; }
  }
  if (!p || typeof p !== 'object') return false;
  return !!(p.username || p.password);
}

// ============================ 基础校验 ============================

function isSafeUrl(u) {
  let p;
  try { p = new URL(u); } catch (e) { return false; }
  if (!/^https?:$/.test(p.protocol)) return false;
  if (hasCredentials(p)) return false;                       // B1 新增：S6
  const host = normalizeHost(p.hostname);
  if (!host) return false;
  if (isIpLiteral(host)) return !classifyIp(host).isPrivate;  // B1 新增：IPv4 + IPv6 统一分类
  return !isPrivateHostname(host).isPrivate;
}

// 单跳校验的同步部分：协议 + 主机名 + IP 字面量
// 返回 { ok:false, why } | { ok:true, host, port } | { ok:true, host, port, needResolve:true }
function safeTargetSync(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch (e) { return { ok: false, why: 'URL 无法解析' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, why: '只允许 http/https' };
  if (hasCredentials(u)) return { ok: false, why: 'URL 不允许携带用户名或密码' };
  const host = normalizeHost(u.hostname);
  if (!host) return { ok: false, why: '缺少主机名' };
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (isIpLiteral(host)) {
    const c = classifyIp(host);
    if (c.isPrivate) return { ok: false, why: '本地/保留地址（' + c.reason + '）' };
    return { ok: true, host, port, family: classifyFamily(c.version) };
  }
  const n = isPrivateHostname(host);
  if (n.isPrivate) return { ok: false, why: '本机地址（' + n.reason + '）' };
  return { ok: true, host, port, needResolve: true };
}

function classifyFamily(version) {
  return version === 6 ? 6 : 4;
}

/**
 * 完整校验 + 返回「待固定的 IP」（供 B2 的 safe_http.js 做固定 IP 连接）
 * @param {string} urlStr
 * @param {object} [opts] { lookup(host, {all:true}) => Promise<[{address,family}]> } 仅供测试注入
 * @returns { ok:false, why } | { ok:true, host, port, addresses:[{address,family}], pin:{address,family} }
 */
async function resolveTarget(urlStr, opts) {
  const s = safeTargetSync(urlStr);
  if (!s.ok) return { ok: false, why: s.why };
  if (!s.needResolve) {
    const addr = { address: s.host, family: s.family };
    return { ok: true, host: s.host, port: s.port, addresses: [addr], pin: addr };
  }
  const o = opts || {};
  const lookup = typeof o.lookup === 'function' ? o.lookup : dnsPromises.lookup;
  let raw = [];
  try {
    raw = await lookup(s.host, { all: true });
  } catch (e) {
    return { ok: false, why: '域名解析失败' };
  }
  const addrs = (Array.isArray(raw) ? raw : []).map((a) => {
    if (typeof a === 'string') {
      const c = classifyIp(a);
      return { address: a, family: c.version === 6 ? 6 : 4 };
    }
    return { address: String((a && a.address) || ''), family: Number((a && a.family) || 0) || (String((a && a.address) || '').indexOf(':') >= 0 ? 6 : 4) };
  }).filter((a) => a.address);
  if (!addrs.length) return { ok: false, why: '域名解析为空' };
  // 保守：解析出的每一个地址都必须是公网；只要有一个落在内网/本机，整体拒绝
  for (const a of addrs) {
    const c = classifyIp(a.address);
    if (c.isPrivate) return { ok: false, why: '域名解析到内网/本机地址（' + c.reason + '）' };
  }
  return { ok: true, host: s.host, port: s.port, addresses: addrs, pin: addrs[0] };
}

// 完整校验（旧签名保持）：同步部分 + DNS 解析后的 IP
async function assertSafeTarget(urlStr, opts) {
  const r = await resolveTarget(urlStr, opts);
  return r.ok ? { ok: true } : { ok: false, why: r.why };
}

// ============================ 脱敏 ============================

// 日志用：只留「协议 + 域名 + 路径首段」，去掉全部查询串（防 h_session_id 之类会话参数外泄）
function safeUrlForLog(u) {
  try {
    const p = new URL(u);
    const seg = String(p.pathname || '/').split('/').filter(Boolean).slice(0, 2).join('/');
    return p.protocol + '//' + p.hostname + (seg ? '/' + seg : '/');
  } catch (e) { return '(非法URL)'; }
}

// 交给模型 / 存进会话的 URL：只剥「会话凭据类」查询参数，保留功能性参数（如 link_id），
// 既不把 h_session_id 之类写进记忆文件，也不破坏链接本身可用性。
const SECRET_QUERY_KEYS = /^(h_session_id|session_id|token|access_token|auth|key|apikey|api_key|password|pwd|secret|sig|sign|cookie|session)$/i;
function sanitizeUrlForUse(u) {
  try {
    const p = new URL(u);
    let changed = false;
    // B1 新增：URL 里若带 userinfo，一并剥掉后再交给模型/存记忆
    if (p.username || p.password) {
      p.username = '';
      p.password = '';
      changed = true;
    }
    for (const k of Array.from(p.searchParams.keys())) {
      if (SECRET_QUERY_KEYS.test(k)) { p.searchParams.delete(k); changed = true; }
    }
    return changed ? p.toString() : u;
  } catch (e) { return u; }
}

module.exports = {
  MAX_REDIRECTS,
  // 原有导出（语义保持；isSafeUrl 只更严不放宽）
  isSafeUrl,
  isPrivateIpLiteral,
  safeTargetSync,
  assertSafeTarget,
  safeUrlForLog,
  sanitizeUrlForUse,
  // B1 新增
  classifyIp,
  parseIpv4,
  parseIpv6,
  classifyIpv4,
  classifyIpv6,
  normalizeHost,
  isIpLiteral,
  isPrivateHostname,
  hasCredentials,
  resolveTarget,
};
