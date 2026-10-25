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

  return { getStatus, preCheck, startBot, stopByPids, findPortOwner, resolveNodeBin, spawnDetached, PORTS };
}

module.exports = { createProcessManager, createDefaultDeps, parseNetstat, PORTS };
