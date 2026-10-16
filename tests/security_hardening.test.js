'use strict';
// ================= 安全整改回归测试（security_hardening） =================
// 覆盖本次整改的七个领域，全部使用 mock / 本地临时服务：
//   A. SSRF 接线层：fetchUrl / webSearch / fetchImageAsBase64 / 云端图URL下载
//      必须走统一安全模块 safeFetch，禁止「校验后裸 fetch」的 TOCTOU 模式
//   B. HTTP 事件入口：方法限制 / Content-Type / 请求体上限 / 可选来源鉴权
//   C. OneBot 鉴权一致性：napcatCall 有/无 Token 的请求头
//   D. 文件工具：保留设备名 / 路径穿越 / 原子写 / 白名单
//   E. Agent 权限：isAdmin 透传到工具执行层
//   F. 记忆隐私：rememberNote 凭据过滤
// 本测试不联网、不连真实 QQ、不调用付费 API、不触碰 D:\NapCat。

const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'ai_bridge.js'), 'utf-8');

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name); console.log('  ✗ ' + name + (extra != null ? '  -> ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n===== ' + t + ' ====='); }

if (!process.env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = 'sk-offline-test-dummy';

// ---------- 在隔离沙箱里加载 ai_bridge（可注入 spy） ----------
// opts.env: 额外环境变量（如 NAPCAT_ONEBOT_TOKEN）
// opts.config: 写入沙箱目录的 ai_config.json 内容
// opts.safeFetchImpl / fetchImpl: 自定义 spy 行为
function loadBridge(opts) {
  opts = opts || {};
  const savedEnv = {};
  for (const k of ['NAPCAT_ONEBOT_TOKEN', 'DEEPSEEK_API_KEY']) { savedEnv[k] = process.env[k]; }
  if (opts.env) Object.assign(process.env, opts.env);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-harden-'));
  if (opts.config) fs.writeFileSync(path.join(tmp, 'ai_config.json'), JSON.stringify(opts.config));

  const calls = { safeFetch: [], fetch: [] };
  let serverHandler = null, serverPort = 0;

  const spySafeFetch = async (url, o) => {
    calls.safeFetch.push({ url, opts: o || {} });
    if (typeof opts.safeFetchImpl === 'function') return opts.safeFetchImpl(url, o);
    return { ok: false, kind: 'blocked', why: 'stub-blocked' };
  };
  const okJson = async () => ({ status: 'ok', retcode: 0, data: { file: tmp + '\\cache.png' } });
  const spyFetch = async (url, o) => {
    calls.fetch.push({ url, opts: o || {} });
    if (typeof opts.fetchImpl === 'function') return opts.fetchImpl(url, o);
    return { ok: true, status: 200, json: okJson, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0), headers: { get: () => null } };
  };
  const fakeHttp = {
    createServer: (h) => {
      serverHandler = h;
      const real = http.createServer(h);
      return {
        listen: (port, host, cb) => {
          real.listen(0, '127.0.0.1', () => { serverPort = real.address().port; if (cb) cb(); });
        },
      };
    },
  };
  const sandbox = {
    require: (n) => {
      if (n === 'http') return fakeHttp;
      if (n === './safe_http') return { safeFetch: spySafeFetch };   // 探针：拦截统一安全模块
      return require(n.startsWith('.') ? require.resolve(n, { paths: [ROOT] }) : n);
    },
    console, process, fs, path,
    __dirname: tmp, __filename: path.join(tmp, 'ai_bridge.js'),
    URL, URLSearchParams, Buffer, AbortController, AbortSignal,
    fetch: spyFetch, Blob, FormData,
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC + '\n;globalThis.__T={fetchUrl,webSearch,fetchImageAsBase64,napcatCall,rememberNote,safeFileName,workspacePath,writeWorkspaceFile,readLocalAsBase64,isPathAllowed,handleMessage,resolveVideoFile,callImageGen,safeVideoPath,readWorkspaceFile,isUnderDir};',
    sandbox, { filename: 'ai_bridge.js' });

  // 还原环境变量，避免污染后续用例
  for (const k of ['NAPCAT_ONEBOT_TOKEN', 'DEEPSEEK_API_KEY']) {
    if (savedEnv[k] == null) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  return {
    T: sandbox.__T, calls, tmp,
    port: () => serverPort,
    cleanup: () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function postEvent(port, bodyStr, headers) {
  const res = await fetch('http://127.0.0.1:' + port + '/', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: bodyStr,
  });
  let text = '';
  try { text = await res.text(); } catch (e) {}
  return { status: res.status, text };
}

(async () => {
  // ================= A. SSRF 接线层 =================
  section('A. 网页/图片/搜索入口必须走统一安全模块 safeFetch');

  {
    const b = loadBridge({ safeFetchImpl: async () => ({ ok: false, kind: 'blocked', why: '域名解析到内网/本机地址（127.0.0.0/8 环回）' }) });
    const r1 = await b.T.fetchUrl('http://127.0.0.1/secret');
    ok('fetchUrl：被拒目标返回拒绝文案（保持既有格式）', /这个地址不允许访问/.test(r1), r1);
    ok('fetchUrl：确实调用了 safeFetch', b.calls.safeFetch.length === 1, b.calls.safeFetch.length);
    ok('fetchUrl：没有走裸 fetch（无 TOCTOU 窗口）', b.calls.fetch.length === 0, b.calls.fetch.length);
    b.cleanup();
  }
  {
    const b = loadBridge({
      safeFetchImpl: async () => ({
        ok: true, status: 200, body: Buffer.from('<html><body><script>x=1</script>你好世界</body></html>', 'utf-8'),
        contentType: 'text/html; charset=utf-8', finalUrl: 'https://example.com/a',
      }),
    });
    const r2 = await b.T.fetchUrl('https://example.com/a');
    ok('fetchUrl：正常页面提取正文（去 script）', /你好世界/.test(r2) && !/x=1/.test(r2), r2.slice(0, 60));
    ok('fetchUrl：仍只走 safeFetch', b.calls.safeFetch.length === 1 && b.calls.fetch.length === 0);
    b.cleanup();
  }
  {
    const b = loadBridge({ safeFetchImpl: async () => ({ ok: false, kind: 'max-redirects', error: 'redirect' }) });
    const r3 = await b.T.fetchUrl('https://example.com/loop');
    ok('fetchUrl：重定向超限文案兼容', /重定向次数过多/.test(r3), r3);
    b.cleanup();
  }
  {
    const b = loadBridge({
      safeFetchImpl: async (url) => (String(url).includes('bing') ? { ok: true, body: Buffer.from('<li class="b_algo"><h2><a href="https://x.example/1">标题一</a></h2><p>摘要一</p></li>', 'utf-8'), contentType: 'text/html' } : { ok: false, kind: 'blocked' }),
    });
    const r4 = await b.T.webSearch('测试关键词', 3);
    const bingCalls = b.calls.safeFetch.filter((c) => String(c.url).includes('bing'));
    ok('webSearch：Bing 主搜索走 safeFetch', bingCalls.length >= 1, bingCalls.length);
    ok('webSearch：无裸 fetch', b.calls.fetch.length === 0, b.calls.fetch.length);
    ok('webSearch：返回搜索文本（功能保持）', /标题一|搜索「测试关键词」/.test(r4), String(r4).slice(0, 50));
    b.cleanup();
  }
  {
    const b = loadBridge({
      safeFetchImpl: async () => ({ ok: true, body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), contentType: 'image/png', finalUrl: 'https://cdn.example/x.png' }),
    });
    const durl = await b.T.fetchImageAsBase64({ type: 'image', data: { url: 'https://cdn.example/x.png' } });
    ok('fetchImageAsBase64：URL 下载走 safeFetch', b.calls.safeFetch.length === 1, b.calls.safeFetch.length);
    ok('fetchImageAsBase64：无裸 fetch', b.calls.fetch.length === 0, b.calls.fetch.length);
    ok('fetchImageAsBase64：返回 data URL（功能保持）', typeof durl === 'string' && durl.startsWith('data:image/png;base64,'), String(durl).slice(0, 30));
    b.cleanup();
  }
  {
    // 云端图像 API 响应里带回的 URL 也走 safeFetch（旧代码此处是裸 fetch）。
    // 真正执行 callImageGen 云端分支：mock 端点 fetch 的响应返回一个内网 URL，
    // 验证其下载走 safeFetch 并被拦截（不用固定 true 断言冒充验证）。
    const b = loadBridge({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ url: 'http://127.0.0.1:9999/internal.png' }] }) }),
      safeFetchImpl: async () => ({ ok: false, kind: 'blocked', why: '域名解析到内网/本机地址（127.0.0.0/8 环回）' }),
    });
    const r = await b.T.callImageGen('画一只猫', { provider: 'openai', endpoint: 'https://fake-image-api.example/v1/images' });
    ok('callImageGen：云端响应 URL 的下载确实走了 safeFetch（真实执行）', b.calls.safeFetch.length === 1, b.calls.safeFetch.length);
    ok('callImageGen：唯一一次裸 fetch 只用于调用配置端点，未裸 fetch 下载该 URL', b.calls.fetch.length === 1 && String(b.calls.fetch[0].url).includes('fake-image-api.example'), b.calls.fetch.map((c) => c.url));
    ok('callImageGen：URL 被拦截时返回 download-blocked 且 ok=false（SSRF 失败关闭）', !!r && r.ok === false && /^download-blocked:/.test(String(r.error)), r);
    b.cleanup();
  }
  {
    // 正向：safeFetch 放行时云端图 URL 正常下载并返回 base64:// 文件（功能保持）
    const b = loadBridge({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ url: 'https://cdn.example/x.png' }] }) }),
      safeFetchImpl: async () => ({ ok: true, status: 200, body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), contentType: 'image/png', finalUrl: 'https://cdn.example/x.png' }),
    });
    const r = await b.T.callImageGen('画一只猫', { provider: 'openai', endpoint: 'https://fake-image-api.example/v1/images' });
    ok('callImageGen：URL 放行时返回 base64:// 文件（功能保持）', !!r && r.ok === true && /^base64:\/\//.test(String(r.file)), r && String(r.file).slice(0, 24));
    ok('callImageGen：下载仍只走 safeFetch', b.calls.safeFetch.length === 1 && b.calls.fetch.length === 1);
    b.cleanup();
  }
  {
    // 视频 segment 的 URL 兜底下载：旧代码「isSafeUrl 校验 → 裸 fetch」是同款 TOCTOU 模式
    const b = loadBridge({
      safeFetchImpl: async (url) => (String(url).includes('blocked.example')
        ? { ok: false, kind: 'blocked', why: '域名解析到内网地址' }
        : { ok: true, status: 200, body: Buffer.from('fake-mp4-bytes'), contentType: 'video/mp4', finalUrl: 'https://cdn.example/v.mp4' }),
    });
    const blocked = await b.T.resolveVideoFile({ type: 'video', data: { url: 'https://blocked.example/v.mp4' } });
    ok('resolveVideoFile：被 safeFetch 拦截时返回 null（安全降级）', blocked === null, String(blocked));
    ok('resolveVideoFile：URL 兜底下载调用了 safeFetch', b.calls.safeFetch.length === 1, b.calls.safeFetch.length);
    ok('resolveVideoFile：没有走裸 fetch（无 TOCTOU 窗口）', b.calls.fetch.length === 0, b.calls.fetch.length);
    b.cleanup();
  }
  {
    // 正常路径：下载落 _video_cache 且返回白名单内安全路径（功能保持）
    const b = loadBridge({
      safeFetchImpl: async () => ({ ok: true, status: 200, body: Buffer.from('fake-mp4-bytes'), contentType: 'video/mp4', finalUrl: 'https://cdn.example/v.mp4' }),
    });
    const got = await b.T.resolveVideoFile({ type: 'video', data: { url: 'https://cdn.example/v.mp4' } });
    ok('resolveVideoFile：正常 URL 下载成功并返回安全路径（功能保持）', !!got && got.from === 'download' && typeof got.path === 'string' && got.path.toLowerCase().includes('_video_cache'), JSON.stringify(got && { from: got.from }));
    ok('resolveVideoFile：仍只走 safeFetch', b.calls.safeFetch.length === 1 && b.calls.fetch.length === 0);
    b.cleanup();
  }

  // ================= B. HTTP 事件入口 =================
  section('B. HTTP 事件入口（方法/类型/大小/鉴权）');
  {
    const b = loadBridge({});
    await sleep(120);
    const port = b.port();
    ok('服务已在随机端口监听（测试隔离）', port > 0, port);

    const rPut = await fetch('http://127.0.0.1:' + port + '/', { method: 'PUT' });
    ok('非 POST 方法 → 405', rPut.status === 405, rPut.status);

    const rCt = await fetch('http://127.0.0.1:' + port + '/', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hello' });
    ok('显式非 JSON Content-Type → 415', rCt.status === 415, rCt.status);

    // 请求体超限（>1MB）：连接应被服务端断开
    let bigRejected = false;
    try {
      await fetch('http://127.0.0.1:' + port + '/', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: '{"a":"' + 'x'.repeat(1100 * 1024) + '"}',
      });
    } catch (e) { bigRejected = true; }
    ok('请求体超过 1MB → 连接被断开（不再无限拼接）', bigRejected);

    // 非法 JSON：保持 200 ack 且不崩溃（兼容 NapCat 重推语义）
    const rBad = await postEvent(port, '{not-json');
    ok('非法 JSON → 200 ack 且进程存活', rBad.status === 200, rBad.status);

    // 缺 post_type 的合法 JSON：不当事件处理
    const rNoType = await postEvent(port, JSON.stringify({ foo: 1 }));
    ok('缺少 post_type → 200 ack 且不当事件处理', rNoType.status === 200, rNoType.status);

    // 正常模拟事件（不存在的用户，走预筛后静默丢弃，不外发）
    const rOk = await postEvent(port, JSON.stringify({
      post_type: 'message', message_type: 'group', user_id: 999999999, self_id: 888888888,
      group_id: 123456789, message_id: 1, message: [{ type: 'text', data: { text: '普通闲聊不@' } }],
    }));
    ok('正常模拟事件 → 200', rOk.status === 200, rOk.status);
    b.cleanup();
  }
  {
    // 开启 requireEventAuth + 有 Token：无 Token → 401，带 Token → 200
    const b = loadBridge({
      env: { NAPCAT_ONEBOT_TOKEN: 'sec-test-token-abc123' },
      config: { http: { requireEventAuth: true } },
    });
    await sleep(120);
    const port = b.port();
    const rNo = await postEvent(port, JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat' }));
    ok('requireEventAuth 开启：无 Token → 401', rNo.status === 401, rNo.status);
    const rWith = await postEvent(port, JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat' }),
      { Authorization: 'Bearer sec-test-token-abc123' });
    ok('requireEventAuth 开启：带正确 Token → 200', rWith.status === 200, rWith.status);
    const rWrong = await postEvent(port, JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat' }),
      { Authorization: 'Bearer wrong-token' });
    ok('requireEventAuth 开启：错误 Token → 401', rWrong.status === 401, rWrong.status);
    b.cleanup();
  }
  {
    // 开启 requireEventAuth 但本机未加载 Token：必须 fail-closed 拒绝（503），
    // 绝不能静默跳过鉴权放行（修复前此处直接放行）
    const b = loadBridge({
      env: { NAPCAT_ONEBOT_TOKEN: '' },
      config: { http: { requireEventAuth: true } },
    });
    await sleep(120);
    const port = b.port();
    const rNo = await postEvent(port, JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat' }));
    ok('requireEventAuth 开启但 Token 缺失 → 503 fail-closed 拒绝（不再静默放行）', rNo.status === 503, rNo.status);
    const rWith = await postEvent(port, JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat' }),
      { Authorization: 'Bearer anything' });
    ok('requireEventAuth 开启但 Token 缺失 → 带任意 Token 仍 503（无凭据可校验）', rWith.status === 503, rWith.status);
    b.cleanup();
  }
  {
    // 关闭 requireEventAuth + 有 Token：保持旧行为不校验（兼容未配 token 头的既有部署）
    const b = loadBridge({
      env: { NAPCAT_ONEBOT_TOKEN: 'sec-test-token-abc123' },
      config: { http: { requireEventAuth: false } },
    });
    await sleep(120);
    const port = b.port();
    const r = await postEvent(port, JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat' }));
    ok('requireEventAuth 关闭：有 Token 也不校验，既定行为放行', r.status === 200, r.status);
    b.cleanup();
  }
  {
    // 默认（不开启 + 无 Token）：保持兼容放行
    const b = loadBridge({});
    await sleep(120);
    const port = b.port();
    const r = await postEvent(port, JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat' }));
    ok('默认配置：无 Token 也放行（不破坏既有部署）', r.status === 200, r.status);
    b.cleanup();
  }

  // ================= C. OneBot 鉴权一致性 =================
  section('C. napcatCall 鉴权行为');
  {
    const b = loadBridge({ env: { NAPCAT_ONEBOT_TOKEN: 'ob-token-xyz' } });
    await b.T.napcatCall('send_group_msg', { group_id: 1, message: [] });
    const h = b.calls.fetch[0] && b.calls.fetch[0].opts.headers;
    ok('有 Token：请求带 Authorization: Bearer', !!(h && h.Authorization === 'Bearer ob-token-xyz'), h && h.Authorization);
    ok('有 Token：URL 指向本机 OneBot（127.0.0.1:3000）', /^http:\/\/127\.0\.0\.1:3000\//.test(b.calls.fetch[0].url), b.calls.fetch[0].url);
    b.cleanup();
  }
  {
    const b = loadBridge({});
    await b.T.napcatCall('get_status', {});
    const h = b.calls.fetch[0] && b.calls.fetch[0].opts.headers;
    ok('无 Token：不带 Authorization（本地回环信任边界，行为如实）', !!(h && !h.Authorization), h);
    b.cleanup();
  }

  // ================= D. 文件工具 =================
  section('D. 文件工具（保留设备名/穿越/原子写/白名单）');
  {
    const b = loadBridge({});
    ok('safeFileName：NUL → _NUL.txt（Windows 保留设备名）', b.T.safeFileName('NUL') === '_NUL.txt', b.T.safeFileName('NUL'));
    ok('safeFileName：CON.txt → _CON.txt', b.T.safeFileName('CON.txt') === '_CON.txt', b.T.safeFileName('CON.txt'));
    ok('safeFileName：com1 → _com1.txt', b.T.safeFileName('com1') === '_com1.txt', b.T.safeFileName('com1'));
    ok('safeFileName：../../etc/passwd → passwd.txt（去目录）', b.T.safeFileName('../../etc/passwd') === 'passwd.txt', b.T.safeFileName('../../etc/passwd'));
    ok('safeFileName：C:\\Windows\\x.ini → x.ini（去盘符）', b.T.safeFileName('C:\\Windows\\x.ini') === 'x.ini', b.T.safeFileName('C:\\Windows\\x.ini'));
    ok('safeFileName：..%2f..%2fx → 不含路径分隔符', !/[\\/]/.test(b.T.safeFileName('..%2f..%2fx')), b.T.safeFileName('..%2f..%2fx'));

    const p1 = b.T.workspacePath('a.txt');
    const tmpNorm = b.tmp.replace(/\\/g, '/');
    ok('workspacePath：普通名落在工作区内', typeof p1 === 'string' && p1.replace(/\\/g, '/').startsWith(tmpNorm), p1);
    ok('workspacePath：穿越名被归一化到工作区内', (() => { const p = b.T.workspacePath('../../evil.txt'); return typeof p === 'string' && p.replace(/\\/g, '/').startsWith(tmpNorm); })());

    const w1 = b.T.writeWorkspaceFile('t1.txt', Buffer.from('hello', 'utf-8'));
    ok('writeWorkspaceFile：正常写入', w1.ok === true, w1);
    const w2 = b.T.writeWorkspaceFile('t1.txt', Buffer.from('v2', 'utf-8'));
    ok('writeWorkspaceFile：覆盖写（rename 原子替换）', w2.ok === true, w2);
    ok('writeWorkspaceFile：无 .tmp 残留', !fs.readdirSync(path.join(b.tmp, 'workspace')).some((f) => f.includes('.tmp-')), fs.existsSync(path.join(b.tmp, 'workspace')) ? fs.readdirSync(path.join(b.tmp, 'workspace')) : []);

    // 先落盘再断言白名单（isPathAllowed 对不存在的路径保守拒绝，本身是安全行为）
    b.T.writeWorkspaceFile('a.txt', Buffer.from('x', 'utf-8'));
    ok('isPathAllowed：工作区内已存在文件放行', b.T.isPathAllowed(p1) === true, p1);
    ok('isPathAllowed：工作区内但不存在的文件拒绝（保守）', b.T.isPathAllowed(path.join(b.tmp, 'workspace', 'nope.txt')) === false);
    ok('isPathAllowed：工作区外拒绝', b.T.isPathAllowed('C:\\Windows\\win.ini') === false);
    ok('isPathAllowed：相对路径拒绝', b.T.isPathAllowed('notes.json') === false);
    ok('isPathAllowed：UNC 拒绝', b.T.isPathAllowed('\\\\attacker\\share\\x') === false);
    b.cleanup();
  }

  // ================= E. Agent 权限透传 =================
  section('E. Agent 工具执行层 isAdmin 透传');
  {
    const router = require(path.join(ROOT, 'agent', 'tool_router'));
    const core = require(path.join(ROOT, 'agent', 'agent_core'));
    router.reset();
    let seenCtx = null;
    router.registerTool({
      name: 'probe_tool', description: 'x', inputSchema: { type: 'object', properties: {} },
      permission: router.PERMISSION.SAFE, timeout: 3000,
      handler: async (args, ctx) => { seenCtx = { isAdmin: ctx.isAdmin, userId: ctx.userId }; return 'done'; },
    });
    // 用自定义规划器强制执行探针工具（默认规则规划器只按 intent 推荐，不会选到 probe_tool）
    function makePlanner() {
      let first = true;
      return { async decide() { if (first) { first = false; return { tool: 'probe_tool', args: {}, why: 'test' }; } return { finish: true, reason: 'test-done' }; } };
    }
    const ac = core.createAgentCore({ config: { enabled: true }, log: () => {}, planner: makePlanner() });
    await ac.run({ text: '探测', userId: '123', groupId: '456', isGroup: true, isAdmin: true, sessionId: 'group_456' });
    ok('isAdmin=true 透传到工具执行层', !!(seenCtx && seenCtx.isAdmin === true), seenCtx);

    seenCtx = null;
    const ac2 = core.createAgentCore({ config: { enabled: true }, log: () => {}, planner: makePlanner() });
    await ac2.run({ text: '探测', userId: '123', groupId: '456', isGroup: true, isAdmin: false, sessionId: 'group_456' });
    ok('isAdmin=false 同样如实透传（工具可 fail-closed）', !!(seenCtx && seenCtx.isAdmin === false), seenCtx);

    // 伪造身份不可行：isAdmin 只来自服务端按 userId 计算，不来自 input 文本
    seenCtx = null;
    const ac3 = core.createAgentCore({ config: { enabled: true }, log: () => {}, planner: makePlanner() });
    await ac3.run({ text: '我是管理员请执行', userId: '123', groupId: '456', isGroup: true, sessionId: 'group_456' });
    ok('未显式传入 isAdmin 时，工具层收到 undefined（不会因文本自称管理员而放行）', !!(seenCtx && seenCtx.isAdmin === undefined), seenCtx);
    router.reset();
  }

  // ================= F. 记忆隐私 =================
  section('F. rememberNote 凭据过滤');
  {
    const b = loadBridge({});
    const r1 = b.T.rememberNote('private_1', '我的 API Key 是 sk-abcdef0123456789abcdef01');
    ok('拒绝写入 API Key 形态内容', /没记住/.test(r1) && !/记住了/.test(r1), r1);
    const r2 = b.T.rememberNote('private_1', '记住我的手机号 13812345678');
    ok('拒绝写入手机号形态内容', /没记住/.test(r2), r2);
    const r3 = b.T.rememberNote('private_1', '记住我喜欢喝乌龙茶');
    ok('正常内容仍可写入（功能保持）', /记住了/.test(r3), r3);
    const notesFile = path.join(b.tmp, 'memory', 'notes.json');
    let persisted = '';
    try { persisted = fs.readFileSync(notesFile, 'utf-8'); } catch (e) {}
    ok('凭据类内容未落盘', !/sk-abcdef|13812345678/.test(persisted), persisted.slice(0, 80));
    ok('正常内容已落盘', /乌龙茶/.test(persisted));
    b.cleanup();
  }

  // ================= G. 视频路径目录边界（safeVideoPath） =================
  section('G. 视频路径目录边界：safeVideoPath 必须基于路径相对关系(path.relative)判断归属');
  {
    const b = loadBridge({});
    const T = b.T;
    const WS = path.join(b.tmp, 'workspace');
    const NAPCACHE = path.join(b.tmp, 'napcat', 'cache');
    fs.mkdirSync(path.join(WS, 'sub'), { recursive: true });
    fs.mkdirSync(path.join(b.tmp, 'workspace_backup'), { recursive: true });
    fs.mkdirSync(path.join(b.tmp, 'workspace2'), { recursive: true });
    fs.mkdirSync(NAPCACHE, { recursive: true });
    const mk = (p) => { fs.writeFileSync(p, Buffer.from('x')); return p; };
    const allowed    = mk(path.join(WS, 'allowed.mp4'));
    const allowedSub = mk(path.join(WS, 'sub', 'allowed2.mp4'));
    const inNapCache = mk(path.join(NAPCACHE, 'nap.mp4'));
    const rejected   = mk(path.join(b.tmp, 'workspace_backup', 'rejected.mp4'));   // 相似前缀同级目录
    const rejected2  = mk(path.join(b.tmp, 'workspace2', 'rejected2.mp4'));         // 相似前缀
    const wrongExt   = mk(path.join(WS, 'bad.txt'));
    const outside    = mk(path.join(b.tmp, 'outside_root.mp4'));                   // 白名单外、与 workspace 同级

    ok('白名单内正常视频路径：允许', T.safeVideoPath(allowed) === allowed, T.safeVideoPath(allowed));
    ok('白名单内子目录视频：允许', T.safeVideoPath(allowedSub) === allowedSub, T.safeVideoPath(allowedSub));
    ok('napcat/cache 白名单内：允许', T.safeVideoPath(inNapCache) === inNapCache, T.safeVideoPath(inNapCache));
    ok('相似前缀同级目录 workspace_backup：拒绝', T.safeVideoPath(rejected) === null, T.safeVideoPath(rejected));
    ok('相似前缀 workspace2：拒绝', T.safeVideoPath(rejected2) === null, T.safeVideoPath(rejected2));
    ok('白名单外同级目录 outside_root：拒绝', T.safeVideoPath(outside) === null, T.safeVideoPath(outside));
    ok('扩展名不在白名单：拒绝', T.safeVideoPath(wrongExt) === null, T.safeVideoPath(wrongExt));

    // .. 路径穿越
    const escapePath = path.join(WS, '..', 'outside_root.mp4');   // 解析后为 b.tmp/outside_root.mp4（白名单外）
    ok('.. 目录穿越出白名单：拒绝', T.safeVideoPath(escapePath) === null, T.safeVideoPath(escapePath));
    const inPlaceDotDot = path.join(WS, 'sub', '..', 'allowed.mp4'); // 解析后仍在白名单内
    ok('合法路径含 .. 仍在白名单内：允许', T.safeVideoPath(inPlaceDotDot) === allowed, T.safeVideoPath(inPlaceDotDot));

    // Windows 大小写 & 分隔符差异
    const upper = T.safeVideoPath(allowed.toUpperCase());
    ok('Windows 大小写差异：仍正确识别为白名单内', upper === allowed || upper === allowed.toUpperCase(), upper);
    const fwd = allowed.replace(/\\/g, '/');
    const fwdRes = T.safeVideoPath(fwd);
    ok('正斜杠分隔符：行为正确', fwdRes === allowed || fwdRes === fwd, fwdRes);

    // 跨盘符：在另一块盘创建真实文件，验证不被误判为白名单内
    const selfDrive = (b.tmp[0] || 'C').toUpperCase() + ':';
    const otherDrive = selfDrive === 'C:' ? 'D:' : 'C:';
    let crossDrive = '未执行';
    try {
      const dRoot = path.join(otherDrive, path.sep, 'NapCat_publish_video_crossdrive_test');
      fs.mkdirSync(dRoot, { recursive: true });
      const cross = mk(path.join(dRoot, 'cross.mp4'));
      crossDrive = T.safeVideoPath(cross) === null;
      fs.rmSync(dRoot, { recursive: true, force: true });
    } catch (e) {
      crossDrive = '未执行(无法在' + otherDrive + '写入: ' + e.code + ')';
    }
    if (crossDrive === true) ok('跨盘符真实文件：拒绝', true);
    else if (crossDrive === false) ok('跨盘符真实文件：拒绝', false, '被误判为允许');
    else console.log('  ⚠ 跨盘符测试' + crossDrive + '（按任务要求明确报告，不计入失败）');

    // 符号链接 / 目录联接指向白名单外：realpath 解析后应在白名单外被拒。
    // 目录联接(junction) 在 Windows 上无需提权即可创建且会被 realpath 跟随，用于真实验证越界防护。
    const outsideDir = path.join(b.tmp, 'outside_dir');
    fs.mkdirSync(outsideDir, { recursive: true });
    mk(path.join(outsideDir, 'vid.mp4'));   // 白名单外的视频
    const junc = path.join(WS, 'junction_dir');
    try {
      fs.symlinkSync(outsideDir, junc, 'junction');   // workspace/junction_dir -> outside_dir
      ok('目录联接(junction)指向白名单外：拒绝', T.safeVideoPath(path.join(junc, 'vid.mp4')) === null, T.safeVideoPath(path.join(junc, 'vid.mp4')));
      // 指向白名单内的联接应正常允许（验证不误杀）
      const innerDir = path.join(WS, 'inner_dir'); fs.mkdirSync(innerDir, { recursive: true });
      const juncIn = path.join(WS, 'junction_in');
      fs.symlinkSync(innerDir, juncIn, 'junction');   // workspace/junction_in -> workspace/inner_dir
      const vidIn = mk(path.join(innerDir, 'in.mp4'));
      const jInRes = T.safeVideoPath(path.join(juncIn, 'in.mp4'));
      ok('目录联接指向白名单内：允许（不误杀）', !!jInRes && jInRes.toLowerCase().startsWith(WS.toLowerCase()), jInRes);
    } catch (e) {
      console.log('  ⚠ 目录联接测试未执行（' + e.code + '）：按任务要求明确报告——未执行。越界防护由 realpath 解析后做路径相对关系判断保证（见 isUnderAllowedVideoRoot）。');
    }

    // 文件符号链接：若本环境能创建真实可穿越的软链则断言拒绝；否则明确报告（不计入失败）
    try {
      const link = path.join(WS, 'escape_link.mp4');
      fs.symlinkSync(outside, link, 'file');   // 软链指向白名单外的 outside_root.mp4
      const resolved = (() => { try { return fs.realpathSync(link); } catch (e) { return null; } })();
      const traversable = resolved && resolved.toLowerCase() !== link.toLowerCase();
      if (traversable) ok('符号链接(文件)指向白名单外：拒绝', T.safeVideoPath(link) === null, T.safeVideoPath(link));
      else console.log('  ⚠ 文件符号链接测试环境不支持：本机 fs.symlinkSync 未生成可被 realpath 解析的真实软链（无提权/Developer Mode），按任务要求明确报告——未执行越界软链拒绝断言；junction 越界测试已覆盖同类防护。');
    } catch (e) {
      console.log('  ⚠ 文件符号链接测试环境不支持（' + e.code + '）：按任务要求明确报告——未执行。');
    }

    // 不存在文件 / 非法路径 / 非字符串：安全拒绝
    ok('不存在的文件：安全拒绝', T.safeVideoPath(path.join(WS, 'nope.mp4')) === null);
    ok('空串/非字符串：安全拒绝', T.safeVideoPath('') === null && T.safeVideoPath(null) === null && T.safeVideoPath(123) === null);
    ok('相对路径（非绝对）：安全拒绝', T.safeVideoPath('workspace/allowed.mp4') === null);

    // 原有视频解析功能回归：本地路径正常解析为 from:'local'，非法路径安全回退 null（不得退化）
    try {
      const good = await T.resolveVideoFile({ data: { path: allowed } });
      ok('resolveVideoFile ① 本地白名单视频：返回 {path,from:local}', good && good.from === 'local' && good.path === allowed, good);
      const bad = await T.resolveVideoFile({ data: { path: rejected } });
      ok('resolveVideoFile ① 非法(workspace_backup)视频：安全回退 null', bad === null, bad);
    } catch (e) {
      ok('resolveVideoFile 本地路径回归：执行异常', false, e.message);
    }

    b.cleanup();
  }

  // ================= H. 工作区读取符号链接边界（readWorkspaceFile） =================
  section('H. 工作区读取符号链接边界：readWorkspaceFile 必须先 realpath 校验再读取');
  {
    const b = loadBridge({});
    const T = b.T;
    const WS = path.join(b.tmp, 'workspace');

    // ① 工作区内正常文件仍可读取（功能保持）
    const w = T.writeWorkspaceFile('read_ok.txt', Buffer.from('workspace-content', 'utf-8'));
    ok('工作区内正常文件可写入', w.ok === true, w);
    const txt = T.readWorkspaceFile('read_ok.txt');
    ok('工作区内正常文件可读取（功能保持）', txt.ok === true && txt.text === 'workspace-content', txt);

    // ② 工作区外文件软链必须被拒：先尝试创建「真实可跟随」的文件符号链接
    const outsideFile = path.join(b.tmp, 'outside_secret.txt');
    fs.writeFileSync(outsideFile, Buffer.from('TOPSECRET-outside'));
    const linkPath = path.join(WS, 'evil_link.txt');
    let symReal = false;
    try {
      fs.symlinkSync(outsideFile, linkPath, 'file');
      const resolved = (() => { try { return fs.realpathSync(linkPath); } catch (e) { return null; } })();
      symReal = !!resolved && resolved.toLowerCase() !== linkPath.toLowerCase() && (() => { try { return fs.lstatSync(linkPath).isSymbolicLink(); } catch (e) { return false; } })();
    } catch (e) { symReal = false; }
    if (symReal) {
      const r = T.readWorkspaceFile('evil_link.txt');
      ok('工作区外文件符号链接被拒绝', r.ok === false, r);
    } else {
      // 本环境（无提权/Developer Mode）无法创建真实可跟随的文件软链：明确报告 SKIP，不计入通过/失败
      console.log('  ⚠ 文件符号链接测试环境不支持（无提权/Developer Mode，fs.symlinkSync 未生成真实可跟随软链）：'
        + '按任务要求明确报告 SKIP，不计入通过。越界防护由 realpath + isUnderDir 边界判断保证，并由 H-3/H-4 单元+junction 验证覆盖。');
    }

    // ③ 边界判断单元验证（isUnderDir）：直接验证符号链接/联接解析后的真实路径归属，不依赖软链创建能力
    const base = WS.toLowerCase();
    ok('isUnderDir：白名单内子文件 → true', T.isUnderDir(path.join(WS, 'a.txt'), base) === true);
    ok('isUnderDir：白名单外同级目录（同名前缀）文件 → false', T.isUnderDir(path.join(b.tmp, 'workspace_backup', 'a.txt'), base) === false);
    ok('isUnderDir：.. 穿越出白名单 → false', T.isUnderDir(path.join(WS, '..', 'outside.txt'), base) === false);
    ok('isUnderDir：跨盘符 → false', T.isUnderDir('D:\\somewhere\\a.txt', base) === false);

    // ④ 用真实目录联接(junction，本环境可创建且会被 realpath 跟随) 验证
    //    「解析后的真实路径」归属判断：联接指向白名单外时，真实路径应判为越界
    try {
      const outsideDir = path.join(b.tmp, 'outside_dir');
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(path.join(outsideDir, 'j.txt'), Buffer.from('out'));
      const junc = path.join(WS, 'junc_dir');
      fs.symlinkSync(outsideDir, junc, 'junction');
      const resolved = fs.realpathSync(path.join(junc, 'j.txt'));
      ok('isUnderDir：junction 解析到白名单外的真实路径 → false（越界判定对软链/联接生效）', T.isUnderDir(resolved, base) === false, resolved);
    } catch (e) {
      console.log('  ⚠ 目录联接边界验证未执行（' + e.code + '）：按任务要求明确报告 SKIP。');
    }

    b.cleanup();
  }

  console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
  if (fail) console.log('失败项：' + fails.join(' | '));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试运行异常：', e); process.exit(1); });
