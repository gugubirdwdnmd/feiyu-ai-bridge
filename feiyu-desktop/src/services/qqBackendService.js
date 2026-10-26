'use strict';
/**
 * qqBackendService.js —— QQ 接入后端统一管理（NapCat / SnowLuma）。
 *
 * 设计目标：把「QQ 接入后端」的差异隔离在一处，桌面只依赖统一接口：
 *   getStatus() / start() / stop() / restart() / healthCheck() / getLogs() / getCapabilities()
 *
 * 事实依据（不臆造）：
 *   - NapCat：本机目录含 index.js + node.exe，OneBot HTTP（默认 3000），WebUI（默认 6099）。
 *   - SnowLuma：官方定位为「面向 QQ 客户端的 TypeScript 互操作运行时」，把 QQ 原生会话
 *     转换为 **OneBot v11** 动作与事件，经 WebSocket / HTTP / WebUI / SDK / MCP 暴露；
 *     Windows 发行包用 `launcher.bat` 启动，WebUI 默认端口 **5099**；
 *     Node.js 24+（完整发行包自带运行时，Lite 版需自备）；
 *     许可为「SnowLuma Source-Available Non-Commercial License v1.0」——**非商业、非 OSI 开源**，
 *     原生组件 snowluma-*.node 为专有组件。
 *     ⇒ 因此本集成**不打包、不内嵌、不自动再分发** SnowLuma 的任何源码或二进制：
 *       只支持「用户指定已有安装目录」，下载入口仅打开官方 Release 页面。
 *
 * 安全：
 *   - 令牌只在本机内存/配置中使用，对外只回传 tokenSet 布尔值，绝不回传明文。
 *   - 日志回传前统一经 redactText 脱敏。
 *   - 启动子进程前剥离 Electron 注入的环境变量（cleanEnv），不把凭据拼进命令行。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { redactText } = require('./redact');
const { readOnebotToken } = require('./napcatLoginService');

const BACKEND_IDS = ['napcat', 'snowluma'];

const DEFAULT_CONFIG = Object.freeze({
  default: 'napcat',
  napcat: { dir: '', onebotPort: 3000, webuiPort: 6099 },
  snowluma: { installDir: '', launcher: 'launcher.bat', exePath: '', webuiPort: 5099, onebotUrl: '', onebotToken: '', logPath: '' },
});

/**
 * 能力矩阵：true=已确认支持；false=已确认不支持/不适用；null=未在官方文档确认（界面标注「未验证」）。
 * 严禁把 null 当成 true 用。
 */
const CAPABILITIES = Object.freeze({
  napcat: {
    onebot11: true, http: true, websocket: true, webui: true,
    quickLogin: true, qrLogin: true, multiAccount: false, mcp: false,
    sendMessage: true, getLogs: true, restart: true,
    notes: ['OneBot v11 动作与事件', 'WebUI 6099 提供扫码登录'],
  },
  snowluma: {
    onebot11: true, http: true, websocket: true, webui: true,
    quickLogin: null, qrLogin: null, multiAccount: true, mcp: true,
    sendMessage: true, getLogs: null, restart: true,
    notes: [
      '官方 README：QQ 原生会话 → OneBot v11 动作与事件，经 WS/HTTP/WebUI/SDK/MCP 暴露',
      '官方提供 @snowluma/mcp（MCP 工具服务）',
      'WebUI 默认 5099；OneBot 端口需在 WebUI 内配置，官方文档未给出默认值',
      '「快速登录 / 扫码登录」官方文档未确认，故不提供，登录请在 SnowLuma WebUI 完成',
      '日志路径官方文档未确认 → 需在设置里指定，或在其 WebUI 实时日志查看',
    ],
  },
});

/** 合并用户配置与默认值（未知键丢弃，防止配置注入）。 */
function normalizeConfig(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const num = (v, def, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.trunc(n)));
  };
  const nap = src.napcat && typeof src.napcat === 'object' ? src.napcat : {};
  const sn = src.snowluma && typeof src.snowluma === 'object' ? src.snowluma : {};
  return {
    default: BACKEND_IDS.includes(src.default) ? src.default : 'napcat',
    napcat: {
      dir: typeof nap.dir === 'string' ? nap.dir.slice(0, 400) : '',
      onebotPort: num(nap.onebotPort, 3000, 1, 65535),
      webuiPort: num(nap.webuiPort, 6099, 1, 65535),
    },
    snowluma: {
      installDir: typeof sn.installDir === 'string' ? sn.installDir.slice(0, 400) : '',
      // launcher 只允许白名单文件名：防止路径穿越 / 任意可执行文件
      launcher: ['launcher.bat', 'launcher.sh', 'SnowLuma.exe'].includes(sn.launcher) ? sn.launcher : 'launcher.bat',
      exePath: typeof sn.exePath === 'string' ? sn.exePath.slice(0, 400) : '',
      webuiPort: num(sn.webuiPort, 5099, 1, 65535),
      onebotUrl: typeof sn.onebotUrl === 'string' ? sn.onebotUrl.slice(0, 400) : '',
      onebotToken: typeof sn.onebotToken === 'string' ? sn.onebotToken.slice(0, 400) : '',
      logPath: typeof sn.logPath === 'string' ? sn.logPath.slice(0, 400) : '',
    },
  };
}

/** 对外回传的配置视图：令牌只回传 tokenSet，绝不回传明文。 */
function publicConfig(cfg) {
  return {
    default: cfg.default,
    napcat: { dir: cfg.napcat.dir, onebotPort: cfg.napcat.onebotPort, webuiPort: cfg.napcat.webuiPort },
    snowluma: {
      installDir: cfg.snowluma.installDir,
      launcher: cfg.snowluma.launcher,
      exePath: cfg.snowluma.exePath,
      webuiPort: cfg.snowluma.webuiPort,
      onebotUrl: cfg.snowluma.onebotUrl,
      onebotTokenSet: !!cfg.snowluma.onebotToken,
      logPath: cfg.snowluma.logPath,
    },
  };
}

/** 极简 HTTP 探活（只连回环地址）。 */
function httpProbe(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || 3000;
  const headers = opts.headers || {};
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve({ ok: false, error: '地址格式无效' }); }
    if (!/^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname)) {
      return resolve({ ok: false, error: '出于安全考虑只探测回环地址（127.0.0.1）' });
    }
    const req = http.request({
      host: u.hostname === 'localhost' ? '127.0.0.1' : u.hostname.replace(/[[\]]/g, ''),
      port: u.port || 80,
      path: u.pathname || '/',
      method: 'GET',
      timeout: timeoutMs,
      headers,
    }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode < 500, statusCode: res.statusCode });
    });
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch (_) {} resolve({ ok: false, error: '连接超时' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.code === 'ECONNREFUSED' ? '连接被拒绝（服务未启动？）' : e.message }));
    req.end();
  });
}

/** 读文件末尾 N 行并脱敏。 */
function tailFile(file, lines = 120) {
  try {
    if (!file || !fs.existsSync(file)) return { ok: false, error: '文件不存在' };
    const st = fs.statSync(file);
    const size = Math.min(st.size, 512 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, Math.max(0, st.size - size));
    fs.closeSync(fd);
    const all = buf.toString('utf-8').split('\n');
    if (all.length && all[all.length - 1] === '') all.pop();
    return { ok: true, file, lines: all.slice(Math.max(0, all.length - lines)).map((l) => redactText(l)) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 在目录里找最近修改的日志文件（只看 *.log，限制搜索深度避免扫全盘）。 */
function findLatestLog(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return null;
    const cands = [dir, path.join(dir, 'logs'), path.join(dir, 'log')];
    let best = null; let bestT = 0;
    for (const d of cands) {
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d).slice(0, 200)) {
        if (!/\.log$/i.test(f)) continue;
        const p = path.join(d, f);
        try {
          const st = fs.statSync(p);
          if (st.isFile() && st.mtimeMs > bestT) { bestT = st.mtimeMs; best = p; }
        } catch (_) {}
      }
    }
    return best;
  } catch (_) { return null; }
}

/** 检测 SnowLuma 安装状态（只读，不启动任何东西）。 */
function detectSnowLuma(dir) {
  const out = { installed: false, dir: dir || '', version: null, launcher: null, nodeVersion: null, notes: [] };
  if (!dir) { out.notes.push('未指定安装目录'); return out; }
  if (!fs.existsSync(dir)) { out.notes.push('目录不存在'); return out; }
  out.installed = true;
  // 启动器（白名单）
  for (const l of ['launcher.bat', 'launcher.sh', 'SnowLuma.exe']) {
    if (fs.existsSync(path.join(dir, l))) { out.launcher = l; break; }
  }
  if (!out.launcher) out.notes.push('未找到 launcher.bat / launcher.sh / SnowLuma.exe');
  // 版本：package.json
  try {
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj)) {
      const j = JSON.parse(fs.readFileSync(pj, 'utf-8'));
      if (j && j.version) out.version = String(j.version);
    }
  } catch (_) {}
  // Node 基线
  try {
    const nv = path.join(dir, '.node-version');
    if (fs.existsSync(nv)) out.nodeVersion = fs.readFileSync(nv, 'utf-8').trim();
  } catch (_) {}
  if (!out.version) out.notes.push('未能从 package.json 读出版本（可在运行后从状态里看）');
  return out;
}

/**
 * 创建后端服务。
 * @param {object} o
 * @param {object} o.pm 进程管理器（processService.createProcessManager()）
 * @param {() => object} o.getSettings
 * @param {(patch: object) => void} o.setSettings
 * @param {() => string} o.resolveNapcatDir
 * @param {() => object} o.getNapcatAccount 返回 {account, passwordMd5}
 */
function createBackendService({ pm, getSettings, setSettings, resolveNapcatDir = () => '', getNapcatAccount = () => ({}) } = {}) {
  const startedAt = Object.create(null); // 内存态：各后端最近一次成功启动时间

  const cfg = () => normalizeConfig((getSettings() || {}).qqBackend);

  const saveConfig = (next) => { if (typeof setSettings === 'function') setSettings({ qqBackend: normalizeConfig(next) }); };

  const uptimeOf = (id) => (startedAt[id] ? Date.now() - startedAt[id] : null);

  // —— NapCat 适配器 ——
  const napcat = {
    id: 'napcat',
    name: 'NapCat',
    async getStatus() {
      const c = cfg().napcat;
      const st = await pm.getStatus();
      const n = (st && st.napcat) || {};
      let running = !!n.running; let pid = n.pid || null;
      if (!running) { const owner = await pm.findPortOwner(c.onebotPort || 3000); if (owner) { running = true; pid = owner; } }
      return { id: 'napcat', running, pid, port: c.onebotPort || 3000, uptimeMs: running ? uptimeOf('napcat') : null, endpoint: 'http://127.0.0.1:' + (c.onebotPort || 3000), version: null, error: null };
    },
    async start() {
      const s = getSettings() || {};
      const acc = getNapcatAccount() || {};
      if (!acc.account) return { ok: false, error: '未配置 QQ 号：请先在「登录与服务」填写 QQ 号（NapCat 需要账号才能登录）' };
      const dir = resolveNapcatDir();
      if (!dir) return { ok: false, error: '未找到 NapCat 目录（需含 index.js）' };
      const r = await pm.startBotVerified(s.botDir || dir, { napcat: acc, settings: s, napcatDir: dir, onlyNapcat: true, timeoutMs: 20000 });
      if (!r.ok) return { ok: false, error: (r.failed && r.failed[0] && r.failed[0].error) || 'NapCat 启动失败' };
      startedAt.napcat = Date.now();
      return { ok: true, pid: (r.pids || [])[0] || null };
    },
    async stop() {
      const c = cfg().napcat;
      const owner = await pm.findPortOwner(c.onebotPort || 3000);
      if (!owner) return { ok: true, alreadyStopped: true };
      const r = await pm.stopByPids([owner], { timeoutMs: 8000 });
      startedAt.napcat = 0;
      return { ok: !!r.stopped, stopped: !!r.stopped };
    },
    async healthCheck() {
      const c = cfg().napcat;
      // OneBot 端口配了 access_token 时，不带令牌必然 403，会被误判为「服务没起来」
      let headers = {};
      try {
        const t = readOnebotToken(resolveNapcatDir());
        if (t && t.token) headers = { Authorization: 'Bearer ' + t.token };
      } catch (_) {}
      return httpProbe('http://127.0.0.1:' + (c.onebotPort || 3000) + '/get_status', { headers });
    },
    async getLogs(lines) {
      const dir = resolveNapcatDir();
      const p = findLatestLog(dir && path.join(dir, 'napcat', 'logs')) || findLatestLog(dir);
      if (!p) return { ok: false, error: '未找到 NapCat 日志文件' };
      return tailFile(p, lines);
    },
  };

  // —— SnowLuma 适配器 ——
  const snowluma = {
    id: 'snowluma',
    name: 'SnowLuma',
    async getStatus() {
      const c = cfg().snowluma;
      const det = detectSnowLuma(c.installDir);
      const owner = await pm.findPortOwner(c.webuiPort || 5099);
      const running = !!owner;
      return {
        id: 'snowluma', running, pid: owner || null, port: c.webuiPort || 5099,
        uptimeMs: running ? uptimeOf('snowluma') : null,
        endpoint: 'http://127.0.0.1:' + (c.webuiPort || 5099),
        version: det.version, installed: det.installed, launcher: det.launcher,
        error: det.installed ? null : '未指定或未找到 SnowLuma 安装目录',
      };
    },
    async start() {
      const c = cfg().snowluma;
      const port = c.webuiPort || 5099;
      // 先判重：已在运行就不重复拉起（端口占用要给出明确提示，不伪造成功）
      const existing = await pm.findPortOwner(port);
      if (existing) return { ok: true, alreadyRunning: true, pid: existing };
      const det = detectSnowLuma(c.installDir);
      if (!det.installed) return { ok: false, error: '未找到 SnowLuma 安装目录，请先在下方选择安装目录' };
      const launcher = c.exePath && fs.existsSync(c.exePath) ? c.exePath : (det.launcher ? path.join(c.installDir, det.launcher) : '');
      if (!launcher || !fs.existsSync(launcher)) return { ok: false, error: '未找到启动器（launcher.bat / launcher.sh / SnowLuma.exe）' };
      // Windows 下 .bat/.cmd 不能作为可执行文件直接 spawn（会 EINVAL），必须经 cmd.exe /c 拉起。
      // 这里不拼接任何用户输入到命令行：启动器路径来自白名单文件名 + 已校验的安装目录。
      const isWin = process.platform === 'win32';
      let spec;
      if (/\.(bat|cmd)$/i.test(launcher)) {
        spec = { command: (isWin ? (process.env.ComSpec || 'cmd.exe') : 'cmd.exe'), args: ['/c', launcher], cwd: c.installDir, env: pm.cleanEnv(process.env) };
      } else {
        spec = { command: launcher, args: [], cwd: c.installDir, env: pm.cleanEnv(process.env) };
      }
      const r = await pm.launchAndVerify(spec, {
          checkUp: async () => (await httpProbe('http://127.0.0.1:' + port + '/')).ok,
          timeoutMs: 60000,
        });
      if (!r.ok) {
        const alive = !!(r.pid && (await pm.findPortOwner(port)));
        if (alive) { startedAt.snowluma = Date.now(); return { ok: true, starting: true, pid: r.pid }; }
        return { ok: false, error: (r.error || 'SnowLuma 启动失败'), detail: r.stderrTail || null };
      }
      startedAt.snowluma = Date.now();
      return { ok: true, pid: r.pid };
    },
    async stop() {
      const c = cfg().snowluma;
      const owner = await pm.findPortOwner(c.webuiPort || 5099);
      if (!owner) return { ok: true, alreadyStopped: true };
      const r = await pm.stopByPids([owner], { timeoutMs: 8000 });
      startedAt.snowluma = 0;
      return { ok: !!r.stopped, stopped: !!r.stopped };
    },
    async healthCheck() {
      const c = cfg().snowluma;
      const webui = await httpProbe('http://127.0.0.1:' + (c.webuiPort || 5099) + '/');
      const out = { ok: webui.ok, webui };
      if (c.onebotUrl) {
        const c2 = cfg().snowluma;
        out.onebot = await httpProbe(c2.onebotUrl, c2.onebotToken ? { headers: { Authorization: 'Bearer ' + c2.onebotToken } } : {});
      }
      if (!webui.ok) out.error = webui.error || 'WebUI 未响应';
      return out;
    },
    async getLogs(lines) {
      const c = cfg().snowluma;
      const p = (c.logPath && fs.existsSync(c.logPath)) ? c.logPath : findLatestLog(c.installDir);
      if (!p) return { ok: false, error: '未找到 SnowLuma 日志文件。官方文档未给出固定日志路径，可在设置里指定日志路径，或在 SnowLuma WebUI 的实时日志中查看。' };
      return tailFile(p, lines);
    },
  };

  const adapters = { napcat, snowluma };

  function adapterOf(id) {
    const a = adapters[id];
    if (!a) return null;
    return a;
  }

  return {
    BACKEND_IDS,
    getCapabilities: (id) => CAPABILITIES[id] || null,
    listBackends() {
      return BACKEND_IDS.map((id) => ({ id, name: adapters[id].name, capabilities: CAPABILITIES[id] }));
    },
    getConfig: () => publicConfig(cfg()),
    setConfig(patch) {
      const next = Object.assign({}, cfg(), patch && typeof patch === 'object' ? patch : {});
      // 只允许整体替换子对象，避免半合并导致脏字段
      if (patch && patch.napcat) next.napcat = Object.assign({}, cfg().napcat, patch.napcat);
      if (patch && patch.snowluma) next.snowluma = Object.assign({}, cfg().snowluma, patch.snowluma);
      saveConfig(next);
      return publicConfig(normalizeConfig(next));
    },
    setDefault(id) {
      if (!BACKEND_IDS.includes(id)) return { ok: false, error: '未知后端：' + id };
      saveConfig(Object.assign({}, cfg(), { default: id }));
      return { ok: true, default: id };
    },
    async status(id) {
      const a = adapterOf(id); if (!a) return { ok: false, error: '未知后端：' + id };
      try { return { ok: true, status: await a.getStatus() }; } catch (e) { return { ok: false, error: e.message }; }
    },
    async start(id) {
      const a = adapterOf(id); if (!a) return { ok: false, error: '未知后端：' + id };
      try { return await a.start(); } catch (e) { return { ok: false, error: e.message }; }
    },
    async stop(id) {
      const a = adapterOf(id); if (!a) return { ok: false, error: '未知后端：' + id };
      try { return await a.stop(); } catch (e) { return { ok: false, error: e.message }; }
    },
    async restart(id) {
      const a = adapterOf(id); if (!a) return { ok: false, error: '未知后端：' + id };
      const s = await a.stop();
      if (s && s.ok === false) return { ok: false, error: '停止失败：' + s.error };
      await new Promise((r) => setTimeout(r, 1200));
      try { return await a.start(); } catch (e) { return { ok: false, error: e.message }; }
    },
    async healthCheck(id) {
      const a = adapterOf(id); if (!a) return { ok: false, error: '未知后端：' + id };
      try { return await a.healthCheck(); } catch (e) { return { ok: false, error: e.message }; }
    },
    async getLogs(id, lines) {
      const a = adapterOf(id); if (!a) return { ok: false, error: '未知后端：' + id };
      try { return await a.getLogs(lines || 120); } catch (e) { return { ok: false, error: e.message }; }
    },
    detectSnowLuma,
  };
}

module.exports = {
  BACKEND_IDS, DEFAULT_CONFIG, CAPABILITIES,
  normalizeConfig, publicConfig, httpProbe, tailFile, findLatestLog, detectSnowLuma,
  createBackendService,
};
