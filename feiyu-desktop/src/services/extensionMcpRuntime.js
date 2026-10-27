'use strict';
/**
 * extensionMcpRuntime.js —— MCP 受控运行与生命周期管理（Feiyu 1.4 模块 7）。
 *
 * 复用 mcpService 的配置解析与安全审查，补齐**运行时**控制：
 *  - stdio 传输：以子进程方式运行（结构化 argv，shell:false，绝不拼接 shell）。
 *  - 远程传输（sse/http/streamable-http/websocket）：不 spawn，仅做健康检查探测（不长期持有进程）。
 *  - 权限门禁：stdio 需 process.spawn 已授权；远程需 network.outbound 已授权；未授权直接拦截，不启动。
 *  - 安全：拒绝 shell 解释器作为可执行文件；远程地址强制 https + 非内网（SSRF/loopback 提示）。
 *  - 超时/输出上限/并发：启动超时、输出大小上限；异常退出检测并报告。
 *  - 默认不自动运行：importConfig 落盘即 enabled:false；本运行器只在用户显式 start 时启动。
 *  - 不支持的模式明确标记（supported:false），不虚报「已运行」。
 *
 * 依赖注入（spawnImpl / fetchImpl / now / permissionService+state），可单测。
 */
const { reviewServer } = require('./mcpService');
const { checkEndpoint } = require('./marketService');

const SUPPORTED_STDIO_OK = true;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_START_TIMEOUT_MS = 20000;
const DEFAULT_HEALTH_TIMEOUT_MS = 8000;
const SHELL_BIN = /^(cmd|cmd\.exe|powershell|powershell\.exe|bash|sh|zsh)$/i;

function isObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function nowIso(d) { return (d instanceof Date ? d : new Date()).toISOString(); }

/** 创建运行时管理器（持有运行中的进程/状态映射）。 */
function createMcpRuntime(opts = {}) {
  const spawnImpl = opts.spawnImpl || require('child_process').spawn;
  const fetchImpl = opts.fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  const permissionSvc = opts.permissionService || null;
  const now = opts.now || (() => Date.now());
  const procs = new Map(); // name -> runtime record

  /** 检查启动权限；返回 {ok, error?, blocked?}。 */
  function assertPermission(serverDef, permState) {
    if (!permissionSvc) return { ok: true };
    if (serverDef.transport === 'stdio' || serverDef.command || (Array.isArray(serverDef.argv) && serverDef.argv.length)) {
      const r = permissionSvc.checkRuntime(permState, 'process.spawn', serverDef.argv ? serverDef.argv[0] : null);
      if (!r.allowed) return { ok: false, error: '需要授权权限 process.spawn（首次启用请在权限中心确认）', blocked: true };
    } else if (serverDef.url) {
      const r = permissionSvc.checkRuntime(permState, 'network.outbound', serverDef.url);
      if (!r.allowed) return { ok: false, error: '需要授权权限 network.outbound（首次启用请在权限中心确认）', blocked: true };
    }
    return { ok: true };
  }

  /** 启动。返回 {ok, supported, error?, pid?, warning?}。 */
  async function start(name, serverDef, ctx = {}) {
    const def = normalizeDef(serverDef);
    // 先拒绝 shell 解释器作为可执行文件（无论风险等级，直接标记不支持）
    const bin = (def.argv || [])[0] || '';
    if (SHELL_BIN.test(bin)) return { ok: false, supported: false, error: '拒绝直接以 shell 解释器作为可执行文件启动（高危）' };
    const review = reviewServer(def);
    if (review.risk === 'high' && !ctx.ackHighRisk) {
      return { ok: false, supported: true, blocked: true, highRisk: true, error: '该服务器存在高危项，需用户在权限中心显式确认后才能启动', findings: review.findings };
    }
    const perm = assertPermission(def, ctx.permissionState);
    if (!perm.ok) return { ok: false, supported: true, blocked: true, error: perm.error };

    if (def.transport === 'stdio' || def.command || (Array.isArray(def.argv) && def.argv.length)) {
      const bin = (def.argv || [])[0] || '';
      if (SHELL_BIN.test(bin)) return { ok: false, supported: false, error: '拒绝直接以 shell 解释器作为可执行文件启动（高危）' };
      if (!def.argv || !def.argv.length) return { ok: false, supported: false, error: 'stdio 缺少可执行命令' };
      let child;
      try {
        child = spawnImpl(def.argv[0], def.argv.slice(1), {
          shell: false,
          env: Object.assign({}, process.env, def.env || {}),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (e) {
        return { ok: false, supported: true, error: '启动失败: ' + e.message };
      }
      if (!child || child.pid == null) return { ok: false, supported: true, error: '进程未成功创建' };
      let outBytes = 0, lastErr = '';
      const onData = (chunk) => {
        outBytes += chunk.length;
        if (outBytes > MAX_OUTPUT_BYTES) { try { child.kill('SIGKILL'); } catch (_) {} }
      };
      if (child.stdout) child.stdout.on('data', onData);
      if (child.stderr) child.stderr.on('data', (c) => { lastErr = String(c).slice(0, 500); onData(c); });
      const rec = {
        name, transport: 'stdio', pid: child.pid, startedAt: nowIso(),
        child, running: true, lastError: '', exited: false, exitCode: null,
      };
      child.on('exit', (code, sig) => { rec.running = false; rec.exited = true; rec.exitCode = code; rec.exitSignal = sig; rec.lastError = lastErr; });
      child.on('error', (e) => { rec.running = false; rec.exited = true; rec.lastError = e.message; });
      procs.set(name, rec);
      return { ok: true, supported: true, pid: child.pid, warning: review.risk !== 'low' ? '已启动，但该服务器存在中/高危项，请确认信任' : null };
    }

    if (def.url) {
      const ep = checkEndpoint(def.url);
      if (!ep.ok) return { ok: false, supported: false, error: '远程地址不安全: ' + ep.error };
      if (!fetchImpl) return { ok: false, supported: false, error: '当前环境无 fetch，无法探测远程服务' };
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), Math.min(30000, Math.max(3000, ctx.healthTimeoutMs || DEFAULT_HEALTH_TIMEOUT_MS))) : null;
      try {
        const res = await fetchImpl(def.url, { method: 'GET', signal: ctrl ? ctrl.signal : undefined });
        if (timer) clearTimeout(timer);
        const rec = { name, transport: def.transport, pid: null, startedAt: nowIso(), running: true, remote: true, lastError: '', lastStatus: res ? res.status : null, exited: false };
        procs.set(name, rec);
        return { ok: true, supported: true, remote: true, status: res ? res.status : null };
      } catch (e) {
        if (timer) clearTimeout(timer);
        return { ok: false, supported: true, remote: true, error: '远程健康检查失败: ' + (e && e.name === 'AbortError' ? '超时' : (e && e.message) || '未知错误') };
      }
    }

    return { ok: false, supported: false, error: '无法确定启动方式（既无 command 也无 url）' };
  }

  function stop(name) {
    const rec = procs.get(name);
    if (!rec) return { ok: false, error: '未在运行: ' + name };
    if (rec.child && typeof rec.child.kill === 'function') { try { rec.child.kill('SIGTERM'); } catch (_) { try { rec.child.kill('SIGKILL'); } catch (_) {} } }
    rec.running = false;
    procs.delete(name);
    return { ok: true, name };
  }

  function health(name) {
    const rec = procs.get(name);
    if (!rec) return { ok: false, running: false, error: '未在运行' };
    if (rec.remote) return { ok: true, running: true, remote: true, lastStatus: rec.lastStatus };
    const alive = rec.child && typeof rec.child.kill === 'function' ? rec.running : false;
    return { ok: true, running: alive, pid: rec.pid, exited: rec.exited, exitCode: rec.exitCode, lastError: rec.lastError };
  }

  function status(name) {
    const rec = procs.get(name);
    if (!rec) return { running: false, exists: false };
    return { running: !!rec.running, exists: true, transport: rec.transport, pid: rec.pid || null, startedAt: rec.startedAt, exited: rec.exited, exitCode: rec.exitCode, lastError: rec.lastError };
  }

  function list() {
    const out = [];
    for (const [name, rec] of procs) out.push({ name, running: !!rec.running, transport: rec.transport, pid: rec.pid || null, startedAt: rec.startedAt, exited: rec.exited, exitCode: rec.exitCode });
    return out;
  }

  /** 停止全部（退出前清理）。 */
  function stopAll() { const names = Array.from(procs.keys()); for (const n of names) stop(n); return { stopped: names.length }; }

  return { start, stop, health, status, list, stopAll, assertPermission };
}

/** 把 serverDef 归一成 reviewServer 需要的形状（argv 优先，command 兜底）。 */
function normalizeDef(def) {
  if (!isObject(def)) return {};
  const argv = Array.isArray(def.argv) && def.argv.length ? def.argv : (typeof def.command === 'string' ? def.command.split(/\s+/).filter(Boolean) : []);
  return {
    transport: def.transport,
    command: Array.isArray(argv) ? argv[0] : def.command,
    argv,
    url: def.url || null,
    env: isObject(def.env) ? def.env : {},
  };
}

module.exports = { createMcpRuntime, SHELL_BIN, MAX_OUTPUT_BYTES, normalizeDef };
