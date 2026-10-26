'use strict';
/**
 * processService.js —— 机器人进程生命周期管理（启动 / 停止 / 状态）。
 *
 * 安全约束：
 *  - 停止时按精确 PID 结束（从端口 LISTENING 拥有者反查），绝不 taskkill /IM node.exe（会误杀 WorkBuddy 等）。
 *  - 启动前查端口是否已被占用，避免重复启动多实例。
 *  - 优雅关闭：先 SIGTERM / taskkill，等待有界超时后再强制。
 *  - 所有外部命令均为固定参数（netstat / taskkill），绝不执行 UI 传入的任意命令行字符串。
 *
 * 依赖注入：生产用 createDefaultDeps()，测试注入 mock（execFile / spawn / sleep / platform）。
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const PORTS = { bridge: 3001, napcat: 3000 };

function createDefaultDeps() {
  return {
    spawn: cp.spawn,
    execFile: cp.execFile,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    platform: process.platform,
  };
}

/** 从 netstat 输出解析某端口的 LISTENING 拥有者 PID。 */
function parseNetstat(stdout, port) {
  for (const line of String(stdout).split('\n')) {
    if (line.includes(`:${port} `)) {
      const m = line.match(/LISTENING\s+(\d+)/);
      if (m) return Number(m[1]);
      // 某些语言环境 LISTENING 后可能无空格
      const m2 = line.match(/(\d+)\s+LISTENING/);
      if (m2) return Number(m2[1]);
    }
  }
  return null;
}

function createProcessManager(opts = {}) {
  const deps = Object.assign(createDefaultDeps(), opts.deps || {});

  async function findPortOwner(port) {
    return new Promise((resolve) => {
      try {
        deps.execFile('netstat', ['-ano'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
          if (err) return resolve(null);
          resolve(parseNetstat(stdout, port));
        });
      } catch (_) { resolve(null); }
    });
  }

  async function getStatus() {
    const [bridge, napcat] = await Promise.all([findPortOwner(PORTS.bridge), findPortOwner(PORTS.napcat)]);
    return {
      bridge: { running: !!bridge, pid: bridge, port: PORTS.bridge },
      napcat: { running: !!napcat, pid: napcat, port: PORTS.napcat },
    };
  }

  /** 解析 node 二进制：显式设置 > botDir/node.exe > 系统 node。 */
  function resolveNodeBin(botDir, settings) {
    if (settings && settings.nodeBin && fs.existsSync(settings.nodeBin)) return settings.nodeBin;
    const local = path.join(botDir, 'node.exe');
    if (fs.existsSync(local)) return local;
    const localSh = path.join(botDir, 'node');
    if (fs.existsSync(localSh)) return localSh;
    return 'node';
  }

  /** 启动前查重：任一端口已监听则视为已在运行。 */
  async function preCheck() {
    const s = await getStatus();
    return { alreadyRunning: s.bridge.running || s.napcat.running, status: s };
  }

  /**
   * 启动机器人。
   * @param botDir 机器人目录
   * @param opts { napcat?: {account, passwordMd5}, settings?: {nodeBin} }
   * @returns { started:{bridge, napcat}, pids:[] }
   */
  function startBot(botDir, opts = {}) {
    const nodeBin = resolveNodeBin(botDir, opts.settings);
    const pids = [];
    // AI 桥
    const bridge = deps.spawn(nodeBin, ['ai_bridge.js'], {
      cwd: botDir, detached: true, stdio: 'ignore', env: process.env,
    });
    if (bridge.pid) { bridge.unref(); pids.push(bridge.pid); }
    // NapCat（可选）
    let napcatPid = null;
    if (opts.napcat && opts.napcat.account) {
      const env = Object.assign({}, process.env, {
        NAPCAT_QUICK_ACCOUNT: String(opts.napcat.account),
        NAPCAT_QUICK_PASSWORD_MD5: String(opts.napcat.passwordMd5 || ''),
      });
      const nc = deps.spawn(nodeBin, ['index.js', '-q', String(opts.napcat.account)], {
        cwd: botDir, detached: true, stdio: 'ignore', env,
      });
      if (nc.pid) { nc.unref(); napcatPid = nc.pid; pids.push(nc.pid); }
    }
    return { started: { bridge: bridge.pid || null, napcat: napcatPid }, pids };
  }

  async function stopOne(pid) {
    if (!pid) return;
    if (deps.platform === 'win32') {
      await new Promise((resolve) => {
        deps.execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' }, () => resolve());
      });
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch (_) {}
    }
  }

  /** 优雅关闭：先发终止信号，等待 timeoutMs，仍存活则强制。 */
  async function stopByPids(pids, { timeoutMs = 5000 } = {}) {
    const list = Array.isArray(pids) ? pids : [pids];
    for (const pid of list) await stopOne(pid);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await deps.sleep(300);
      let alive = false;
      for (const pid of list) {
        try { process.kill(pid, 0); alive = true; break; } catch (_) {}
      }
      if (!alive) return { stopped: true, forced: false };
    }
    // 强制
    for (const pid of list) {
      if (deps.platform === 'win32') {
        await new Promise((resolve) => { deps.execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' }, () => resolve()); });
      } else { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
    }
    return { stopped: true, forced: true };
  }

  /**
   * 通用「分离式启动」：用于服务编排（模块 B）拉起 ComfyUI / 自定义服务。
   *
   * 安全约束（与 startBot 一致）：
   *  - 只接受**固定的 argv 数组**，绝不把用户输入拼成命令行字符串；
   *  - command 不得包含 shell 元字符（即使用 spawn 不走 shell，也做防御性拒绝）；
   *  - 工作目录必须已存在，不自动创建。
   * @param spec { command, args[], cwd, env }
   */
  function spawnDetached(spec = {}) {
    const cmd = spec.command;
    if (typeof cmd !== 'string' || !cmd.trim()) return { ok: false, error: 'command 必须是非空字符串' };
    if (/[&|<>;`\n\r]/.test(cmd)) return { ok: false, error: 'command 不得包含 shell 元字符' };
    const args = Array.isArray(spec.args) ? spec.args : [];
    if (!args.every((a) => typeof a === 'string')) return { ok: false, error: 'args 必须是字符串数组' };
    const cwd = spec.cwd || process.cwd();
    try { if (!fs.existsSync(cwd)) return { ok: false, error: '工作目录不存在' }; } catch (_) { return { ok: false, error: '工作目录不可访问' }; }
    try {
      const child = deps.spawn(cmd, args, {
        cwd, detached: true, stdio: 'ignore',
        env: Object.assign({}, process.env, spec.env || {}),
      });
      if (child && child.pid) { child.unref(); return { ok: true, pid: child.pid }; }
      return { ok: false, error: '进程未返回 pid' };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  /**
   * 剥离电子壳（Electron）专用环境变量，避免泄漏到被拉起的子进程。
   *
   * 根因：桌面控制中心本身跑在 Electron 主进程里，process.env 带有
   * ELECTRON_RUN_AS_NODE / ELECTRON_* / ATOM_SHELL_INTERNAL_* / NODE_OPTIONS 等。
   * 直接把整份 env 透传给机器人子进程，会让 node.exe 误以为处于电子壳上下文，
   * 轻则行为异常，重则直接退出 —— 这正是「机器人启动失败但显示成功」的常见诱因。
   * 这里只保留 PATH / SystemRoot / 等系统必需变量，剔除电子壳相关键。
   */
  function cleanEnv(src) {
    const out = {};
    const drop = (k) => {
      const u = String(k).toUpperCase();
      if (u === 'ELECTRON_RUN_AS_NODE') return true;
      if (u.startsWith('ELECTRON_')) return true;
      if (u.startsWith('ATOM_SHELL_INTERNAL_')) return true;
      if (u === 'NODE_OPTIONS') return true;
      return false;
    };
    for (const k of Object.keys(src || {})) {
      if (!drop(k)) out[k] = src[k];
    }
    return out;
  }

  /**
   * 同 spawnDetached，但把子进程 stderr 捕获进一个上限 4KB 的尾部缓冲，
   * 并返回 child 句柄（供调用方监听 exit / 做启动校验）。
   * 返回 { ok, pid, error, child, getTail }。
   */
  function spawnDetachedCapture(spec = {}) {
    const cmd = spec.command;
    if (typeof cmd !== 'string' || !cmd.trim()) return { ok: false, error: 'command 必须是非空字符串' };
    if (/[&|<>;`\n\r]/.test(cmd)) return { ok: false, error: 'command 不得包含 shell 元字符' };
    const args = Array.isArray(spec.args) ? spec.args : [];
    if (!args.every((a) => typeof a === 'string')) return { ok: false, error: 'args 必须是字符串数组' };
    const cwd = spec.cwd || process.cwd();
    try { if (!fs.existsSync(cwd)) return { ok: false, error: '工作目录不存在' }; } catch (_) { return { ok: false, error: '工作目录不可访问' }; }
    let tail = '';
    try {
      const child = deps.spawn(cmd, args, {
        cwd, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
        env: Object.assign({}, cleanEnv(process.env), spec.env || {}),
      });
      if (!child || !child.pid) return { ok: false, error: '进程未返回 pid' };
      child.unref();
      if (child.stderr && typeof child.stderr.on === 'function') {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (c) => {
          tail += c;
          if (tail.length > 4000) tail = tail.slice(-4000);
        });
      }
      return { ok: true, pid: child.pid, child, getTail: () => tail };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  /**
   * 校验一次启动是否真的成功：spawn 后轮询端口监听 / 进程存活，捕获崩溃退出码。
   * checkUp 优先级：opts.checkUp（异步，返回 true=就绪）> opts.port（查 LISTENING）> 仅查进程存活。
   * 返回 { ok, pid, verified, error, stderrTail, exitCode }。
   */
  async function launchAndVerify(spec = {}, opts = {}) {
    const cap = spawnDetachedCapture(spec);
    if (!cap.ok) return { ok: false, error: cap.error };
    const { pid, child, getTail } = cap;
    const timeoutMs = opts.timeoutMs || 12000;
    let exitInfo = null;
    if (child && typeof child.on === 'function') {
      child.on('exit', (code, signal) => { exitInfo = { code, signal }; });
    }
    const checkUp = opts.checkUp
      ? opts.checkUp
      : (opts.port
        ? (async () => !!(await findPortOwner(opts.port)))
        : (async () => { try { process.kill(pid, 0); return true; } catch (_) { return false; } }));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (exitInfo) {
        return {
          ok: false, pid, verified: false, exitCode: exitInfo.code,
          error: '进程已退出（code=' + exitInfo.code + (exitInfo.signal ? ' signal=' + exitInfo.signal : '') + '）：' + (getTail() || '（无错误输出，请检查机器人目录与依赖）'),
          stderrTail: getTail(),
        };
      }
      let up = false;
      try { up = await checkUp(); } catch (_) { up = false; }
      if (up) return { ok: true, pid, verified: true };
      await deps.sleep(400);
    }
    return {
      ok: false, pid, verified: false,
      error: '在 ' + Math.round(timeoutMs / 1000) + 's 内未检测到服务就绪（端口 ' + (opts.port || '?') + ' 未监听），可能依赖缺失、配置错误或启动缓慢。',
      stderrTail: getTail(),
    };
  }

  /**
   * 启动机器人并校验 AI 桥 / NapCat 真实监听端口。
   * 与 startBot 区别：异步、带环境清理、带校验；崩溃或端口未起都如实返回 failed。
   * 返回 { started:{bridge,napcat}, pids[], failed[], ok }。
   */
  async function startBotVerified(botDir, opts = {}) {
    const nodeBin = resolveNodeBin(botDir, opts.settings);
    const timeoutMs = opts.timeoutMs || 15000;
    const results = { bridge: null, napcat: null };
    results.bridge = await launchAndVerify(
      { command: nodeBin, args: ['ai_bridge.js'], cwd: botDir, env: cleanEnv(process.env) },
      { port: PORTS.bridge, timeoutMs },
    );
    if (opts.napcat && opts.napcat.account) {
      const nenv = Object.assign({}, cleanEnv(process.env), {
        NAPCAT_QUICK_ACCOUNT: String(opts.napcat.account),
        NAPCAT_QUICK_PASSWORD_MD5: String(opts.napcat.passwordMd5 || ''),
      });
      results.napcat = await launchAndVerify(
        { command: nodeBin, args: ['index.js', '-q', String(opts.napcat.account)], cwd: botDir, env: nenv },
        { port: PORTS.napcat, timeoutMs },
      );
    }
    const pids = [];
    const failed = [];
    if (results.bridge && results.bridge.pid) pids.push(results.bridge.pid);
    if (results.napcat && results.napcat.pid) pids.push(results.napcat.pid);
    if (results.bridge && !results.bridge.ok) failed.push({ id: 'bridge', error: results.bridge.error });
    if (results.napcat && !results.napcat.ok) failed.push({ id: 'napcat', error: results.napcat.error });
    return { started: results, pids, failed, ok: failed.length === 0 };
  }

  return { getStatus, preCheck, startBot, stopByPids, findPortOwner, resolveNodeBin, spawnDetached, spawnDetachedCapture, cleanEnv, launchAndVerify, startBotVerified, PORTS };
}

module.exports = { createProcessManager, createDefaultDeps, parseNetstat, PORTS };
