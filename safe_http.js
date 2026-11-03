'use strict';
// ================= V14 阶段三 B2：统一安全下载传输层 =================
// 零第三方依赖（只用 node:http / node:https / node:zlib / node:dns / node:crypto）。
//
// 设计约定（对应阶段三要求）：
//   1. 每一跳都「先校验目标 → 再连接校验通过的 IP」，连接阶段禁止重新解析域名：
//      自定义 lookup 只返回已校验的固定 IP，并且会校验被解析的主机名与预期一致。
//   2. 连接建立后，用 socket.remoteAddress 复核「实际远端 IP == 固定 IP」，
//      不一致立即中止（这是防代理/防 rebinding 的最后一道硬闸）。
//   3. TLS 证书校验始终保持开启（rejectUnauthorized = true，不提供关闭入口）；
//      SNI 用原始域名（servername），Host 头用原始 host（含非默认端口）。
//   4. DNS 结果严格策略：解析出的每一个地址都必须是公网，混合公私网一律拒绝。
//   5. 环境代理不得静默绕过：一旦检测到运行时会改由代理解析域名，直接失败关闭。
//   6. 流式限额同时覆盖「实际接收字节」与「解压后字节」，超限立即中止并释放资源。
//   7. 四档超时（连接 / 响应头 / body 空闲 / 总时长）贯穿整个请求生命周期与每一跳。
//   8. 重定向逐跳重新校验、限制次数、默认禁止 https→http 降级、跨源丢弃凭据头。
//   9. 测试策略必须显式启用：createTestPolicy() 返回带随机 token 的 policy，
//      safeFetch 只有在 opts.testToken 与该 token 完全匹配时才允许使用；
//      缺省与 token 不匹配一律按失败关闭处理，生产路径不传 policy 即走严格默认策略。

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const dnsPromises = require('dns').promises;
const urlSafety = require('./url_safety');

// —— 默认参数（冻结，防止被业务代码随手改松）——
const DEFAULTS = Object.freeze({
  method: 'GET',
  maxRedirects: 5,
  maxBytes: 8 * 1024 * 1024,          // 实际接收字节上限
  maxDecompressedBytes: 8 * 1024 * 1024, // 解压后字节上限
  connectTimeoutMs: 5000,
  headersTimeoutMs: 10000,
  bodyIdleTimeoutMs: 10000,
  totalTimeoutMs: 30000,
  allowDowngrade: false,
  acceptEncoding: 'gzip, deflate',
});

// —— 生产默认策略：严格，冻结 ——
const DEFAULT_POLICY = Object.freeze({
  name: 'default',
  testOnly: false,
  resolveTarget: (urlStr, opts) => urlSafety.resolveTarget(urlStr, opts),
  lookup: dnsPromises.lookup,
});

/**
 * 仅供测试使用的策略（显式启用，带一次性随机 token）。
 * 生产代码不应调用本函数；即使调用，也必须把返回的 token 通过 opts.testToken 传入，
 * 否则 safeFetch 一律失败关闭。测试策略只能替换「目标解析」，
 * 不能关闭固定 IP、socket 复核、超时和限额等传输层保护。
 */
function createTestPolicy(spec) {
  const s = spec || {};
  const token = crypto.randomBytes(24).toString('hex');
  const fallback = (urlStr, opts) => urlSafety.resolveTarget(urlStr, {
    lookup: typeof s.lookup === 'function' ? s.lookup : dnsPromises.lookup,
  });
  return Object.freeze({
    name: 'test',
    testOnly: true,
    token,
    lookup: typeof s.lookup === 'function' ? s.lookup : dnsPromises.lookup,
    resolveTarget: typeof s.resolveTarget === 'function' ? s.resolveTarget : fallback,
  });
}

// ================= 工具 =================

function ipBytes(ip) {
  const s = String(ip == null ? '' : ip).trim().toLowerCase();
  if (!s) return null;
  let bare = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
  const zi = bare.indexOf('%');
  if (zi >= 0) bare = bare.slice(0, zi);
  if (bare.indexOf(':') >= 0) {
    const b = urlSafety.parseIpv6(bare);
    if (!b) return null;
    // IPv4-mapped（::ffff:a.b.c.d）归一成 4 字节，便于与 IPv4 端点比较
    const mapped = b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
    return mapped ? [b[12], b[13], b[14], b[15]] : Array.from(b);
  }
  return urlSafety.parseIpv4(bare);
}

// 实际远端地址与固定 IP 的一致性比较（兼容 IPv4 / IPv6 / IPv4-mapped 写法差异）
function sameIp(a, b) {
  const x = ipBytes(a);
  const y = ipBytes(b);
  if (!x || !y || x.length !== y.length) return false;
  return x.every((v, i) => v === y[i]);
}

function hasHeader(h, name) {
  const k = String(name).toLowerCase();
  return Object.keys(h || {}).some((x) => String(x).toLowerCase() === k);
}

// 代理守卫：一旦「无法保证连接目标 == 校验 IP」，必须失败关闭，而不是打日志了事
function checkProxyEnv() {
  const blockers = [];
  const flag = process.env.NODE_USE_ENV_PROXY;
  if (flag && !/^(0|false|no|off)$/i.test(String(flag).trim())) {
    blockers.push('NODE_USE_ENV_PROXY=' + flag);
  }
  const nodeOptions = String(process.env.NODE_OPTIONS || '');
  if (/--use-env-proxy/.test(nodeOptions)) blockers.push('NODE_OPTIONS 含 --use-env-proxy');
  if (blockers.length) {
    return {
      ok: false,
      error: '检测到运行时会改由代理解析域名，无法保证连接目标等于校验 IP，按失败关闭处理：' + blockers.join('；'),
    };
  }
  const present = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
    .filter((k) => process.env[k]);
  return {
    ok: true,
    warn: present.length
      ? '环境变量存在代理设置（' + present.join(',') + '）。当前 Node 版本不读取该变量，固定 IP 仍然有效；一旦运行时开始支持，本函数会直接失败关闭。'
      : '',
  };
}

function failResult(kind, error, extra) {
  return Object.assign({ ok: false, kind, error: error || kind, why: error || kind, retryable: false }, extra || {});
}

function makeDecoder(encoding) {
  const list = String(encoding || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  for (const e of list) {
    if (e === 'gzip' || e === 'x-gzip') return zlib.createGunzip();
    if (e === 'deflate') return zlib.createInflate();
    if (e === 'br') return zlib.createBrotliDecompress();
  }
  return null;
}

// ================= 单跳请求 =================

function once(u, resolved, addr, headersIn, o, state) {
  return new Promise((settle) => {
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const host = resolved.host;
    const expectedHost = urlSafety.normalizeHost(host);
    const pin = addr || resolved.pin;

    const headers = Object.assign({}, headersIn || {});
    if (!hasHeader(headers, 'host')) headers.Host = u.host;          // Host 保留原始域名（含非默认端口）
    if (o.acceptEncoding && !hasHeader(headers, 'accept-encoding')) headers['Accept-Encoding'] = o.acceptEncoding;
    if (!hasHeader(headers, 'connection')) headers.Connection = 'close';

    const options = {
      protocol: u.protocol,
      host,                                  // 原始域名：Host 头与 SNI 都来自这里
      port: resolved.port,
      method: o.method,
      path: (u.pathname || '/') + (u.search || ''),
      headers,
      agent: false,                          // 禁用连接池，确保每次都走我们控制的 socket
      // 固定 IP：不查 DNS，只返回已经过安全校验的地址
      lookup: (hostname, lopts, cb) => {
        if (urlSafety.normalizeHost(hostname) !== expectedHost) {
          const err = new Error('意外的解析请求：' + hostname);
          err.code = 'EAI_AGAIN';
          return cb(err);
        }
        if (lopts && lopts.all) return cb(null, [{ address: pin.address, family: pin.family }]);
        return cb(null, pin.address, pin.family);
      },
    };
    if (isHttps) {
      options.rejectUnauthorized = true;                       // 证书校验永远开启，不提供关闭入口
      if (!urlSafety.isIpLiteral(host)) options.servername = host; // SNI 用原始域名
    }

    let settled = false;
    let req = null;
    let sock = null;
    let decoder = null;
    const timers = new Set();

    function armTimer(name, ms) {
      const t = setTimeout(() => { abort('timeout:' + name, '超时（' + name + ' ' + ms + 'ms）'); }, ms);
      timers.add(t);
      return t;
    }
    function clearTimer(t) { if (t) { clearTimeout(t); timers.delete(t); } }
    function clearAllTimers() { for (const t of Array.from(timers)) clearTimeout(t); timers.clear(); }
    function release() {
      clearAllTimers();
      try { if (decoder) decoder.destroy(); } catch (e) {}
      try { if (sock) sock.destroy(); } catch (e) {}
      try { if (req) req.destroy(); } catch (e) {}
    }
    function finish(result) {
      if (settled) return;
      settled = true;
      clearAllTimers();
      settle(result);
    }
    function abort(kind, error) {
      if (settled) return;
      settled = true;
      clearAllTimers();
      try { if (decoder) decoder.destroy(); } catch (e) {}
      try { if (sock) sock.destroy(); } catch (e) {}
      try { if (req) req.destroy(); } catch (e) {}
      settle(failResult(kind, error, { retryable: kind === 'timeout:connect' || kind === 'timeout:headers' || kind === 'connect' }));
    }

    const remain = state.deadline - Date.now();
    if (remain <= 0) return settle(failResult('timeout:total', '总超时（' + o.totalTimeoutMs + 'ms）'));
    const totalTimer = armTimer('total', remain);
    let connectTimer = null;
    let phaseTimer = null;

    let req2;
    try {
      req2 = mod.request(options);
    } catch (e) {
      clearAllTimers();
      return settle(failResult('url', '构造请求失败：' + e.message));
    }
    req = req2;

    // 连接阶段计时：HTTPS 要等 TLS 握手完成（secureConnect），HTTP 等到 TCP connect
    const connectEvent = isHttps ? 'secureConnect' : 'connect';
    connectTimer = armTimer('connect', o.connectTimeoutMs);
    req.on('socket', (s) => {
      sock = s;
      if (s.connecting || isHttps) {
        s.once(connectEvent, () => clearTimer(connectTimer));
      } else {
        clearTimer(connectTimer);
      }
    });

    req.on('error', (e) => {
      abort('connect', '请求失败：' + (e && e.message));
    });

    req.on('response', (res) => {
      clearTimer(connectTimer);
      if (res.socket) sock = res.socket;

      // —— 硬闸：实际 socket 远端 IP 必须等于固定 IP ——
      const remote = res.socket && res.socket.remoteAddress;
      if (!remote || !sameIp(remote, pin.address)) {
        try { res.resume(); } catch (e) {}
        return abort('pin-mismatch', '实际连接远端 ' + (remote || '(未知)') + ' 与校验通过的固定 IP ' + pin.address + ' 不一致');
      }
      state.remoteIp = remote;
      state.pinnedIp = pin.address;

      const status = res.statusCode || 0;
      const resHeaders = res.headers || {};

      // 重定向：不读 body，直接交给外层重新校验下一跳
      if (status >= 300 && status < 400) {
        const loc = resHeaders.location;
        try { res.resume(); } catch (e) {}
        try { req.destroy(); } catch (e) {}
        if (!loc) return finish(failResult('redirect-no-location', '重定向响应缺少 Location 头'));
        let next;
        try {
          next = new URL(loc, u.href);
        } catch (e) {
          return finish(failResult('redirect-bad-url', '重定向地址无法解析：' + String(loc).slice(0, 80)));
        }
        return finish({
          ok: false,
          kind: 'redirect',
          status,
          headers: resHeaders,
          location: next,
          pinnedIp: pin.address,
          remoteIp: remote,
          error: 'redirect',
        });
      }

      clearTimer(phaseTimer);                    // 已收到响应头，响应头超时结束

      const chunks = [];
      let rawBytes = 0;
      let outBytes = 0;
      const encoding = resHeaders['content-encoding'];
      decoder = makeDecoder(encoding);

      const onLimit = (kind, limit) => {
        try { res.destroy(); } catch (e) {}
        abort(kind, '响应体超过上限（' + limit + ' 字节），已中止并释放连接');
      };

      // 压缩与未压缩两条路径统一：① 累计「实际接收字节」并受 maxBytes 约束；
      // ② 每收到一个数据分片都刷新 body 空闲超时（真正的空闲超时而非固定截止）；
      // 超限立即中止并清空已缓冲内容、释放 decoder/socket/请求。
      const onRawChunk = (c) => {
        rawBytes += c.length;
        if (rawBytes > o.maxBytes) {
          chunks.length = 0;
          return onLimit('size-limit-raw', o.maxBytes);
        }
        clearTimer(phaseTimer);
        phaseTimer = armTimer('body', o.bodyIdleTimeoutMs);
      };

      if (decoder) {
        // 压缩分支：原始字节来自 res 流（onRawChunk），解压后字节来自 decoder（独立限额）
        res.on('data', onRawChunk);
        decoder.on('data', (c) => {
          outBytes += c.length;
          if (outBytes > o.maxDecompressedBytes) {
            chunks.length = 0;
            return onLimit('size-limit-decompressed', o.maxDecompressedBytes);
          }
          chunks.push(c);
        });
        decoder.on('end', () => {
          finish({
            ok: true, status, headers: resHeaders,
            body: Buffer.concat(chunks),
            finalUrl: u.href, hops: state.hops,
            pinnedIp: pin.address, remoteIp: remote,
            bytes: rawBytes, decompressedBytes: outBytes,
            contentType: resHeaders['content-type'] || '',
          });
        });
        decoder.on('error', () => abort('decode-error', '响应体解压失败（content-encoding=' + encoding + '）'));
        res.pipe(decoder);
      } else {
        // 未压缩：单一数据流，超限即为「实际接收字节超限」
        res.on('data', (c) => {
          onRawChunk(c);
          if (settled) return;          // 超限已中止则不继续累积
          chunks.push(c);
        });
        res.on('end', () => {
          finish({
            ok: true, status, headers: resHeaders,
            body: Buffer.concat(chunks),
            finalUrl: u.href, hops: state.hops,
            pinnedIp: pin.address, remoteIp: remote,
            bytes: rawBytes, decompressedBytes: rawBytes,
            contentType: resHeaders['content-type'] || '',
          });
        });
        res.on('error', (e) => abort('body-error', '读取响应体失败：' + (e && e.message)));
      }

      // 无论压缩与否，从收到响应头起开启 body 空闲超时（之后每收到数据分片都会刷新）
      clearTimer(phaseTimer);
      phaseTimer = armTimer('body', o.bodyIdleTimeoutMs);
    });

    req.end();
    // 响应头超时：从请求发出开始计时，收到响应头即清除
    phaseTimer = armTimer('headers', o.headersTimeoutMs);
  });
}

// ================= 一次「校验 + 连接」（含已校验地址列表内的 failover）=================

async function attempt(u, headers, o, policy, state) {
  let resolved;
  try {
    resolved = await policy.resolveTarget(u.href, { lookup: policy.lookup });
  } catch (e) {
    return failResult('blocked', '目标校验异常：' + (e && e.message));
  }
  if (!resolved || !resolved.ok) {
    return failResult('blocked', (resolved && resolved.why) || '目标未通过安全校验');
  }
  const cands = (resolved.addresses && resolved.addresses.length) ? resolved.addresses : [resolved.pin];
  let last = null;
  for (const addr of cands) {
    // eslint-disable-next-line no-await-in-loop
    const r = await once(u, resolved, addr, headers, o, state);
    if (r.ok || r.kind === 'redirect') return r;
    last = r;
    if (!r.retryable) return r;
  }
  return last || failResult('connect', '连接失败');
}

// ================= 对外主入口 =================

async function safeFetch(urlStr, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});

  // —— 策略选择（生产默认严格；测试策略必须带匹配 token）——
  let policy = o.policy;
  if (!policy) {
    policy = DEFAULT_POLICY;
  } else if (policy.testOnly) {
    if (!o.testToken || o.testToken !== policy.token) {
      return failResult('policy', '拒绝使用测试策略：缺少或不匹配 testToken（必须用 createTestPolicy() 返回的 policy.token 显式传入 opts.testToken）');
    }
  }
  if (typeof policy.resolveTarget !== 'function') {
    return failResult('policy', 'policy.resolveTarget 必须是函数');
  }

  // —— 代理守卫（无法保证连接目标 → 失败关闭）——
  const guard = checkProxyEnv();
  if (!guard.ok) return failResult('proxy', guard.error);
  if (o.agent) return failResult('agent', '不允许传入自定义 agent（会绕过固定 IP 连接）');

  let cur;
  try {
    cur = new URL(urlStr);
  } catch (e) {
    return failResult('url', 'URL 无法解析');
  }

  const state = { hops: 0, deadline: Date.now() + o.totalTimeoutMs, remoteIp: null, pinnedIp: null };
  const headers = Object.assign({}, o.headers || {});

  for (;;) {
    if (state.hops > o.maxRedirects) {
      return failResult('max-redirects', '重定向次数超过上限（' + o.maxRedirects + ' 次）');
    }
    // eslint-disable-next-line no-await-in-loop
    const r = await attempt(cur, headers, o, policy, state);
    if (!r.ok && r.kind !== 'redirect') {
      return Object.assign({}, r, { finalUrl: cur.href, hops: state.hops, pinnedIp: state.pinnedIp, remoteIp: state.remoteIp });
    }
    if (r.kind === 'redirect') {
      const next = r.location;
      // 协议降级：默认禁止 https → http
      if (!o.allowDowngrade && cur.protocol === 'https:' && next.protocol !== 'https:') {
        return failResult('downgrade', '禁止从 HTTPS 降级到 ' + next.protocol, { finalUrl: cur.href, hops: state.hops });
      }
      // 跨源重定向：不把凭据头带到别的主机
      if (next.origin !== cur.origin) {
        for (const k of Object.keys(headers)) {
          if (/^(authorization|proxy-authorization|cookie)$/i.test(k)) delete headers[k];
        }
      }
      state.hops += 1;
      cur = next;
      continue;
    }
    return r;
  }
}

module.exports = {
  DEFAULTS,
  DEFAULT_POLICY,
  createTestPolicy,
  safeFetch,
  sameIp,
  ipBytes,
  checkProxyEnv,
};
