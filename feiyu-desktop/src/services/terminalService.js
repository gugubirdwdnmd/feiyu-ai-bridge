'use strict';
/**
 * terminalService.js —— 本地终端（Shell）会话管理（仅在 Main 进程运行）。
 *
 * 安全模型：
 *  - 渲染进程**绝不直接**接触 child_process / fs：它只能通过固定 IPC 通道发「打开 / 输入 / 关闭」，
 *    真正的 Shell 在本服务里 spawn，输出经 `emit('TERMINAL_OUTPUT', …)` 推回渲染进程。
 *  - 每个会话一个持久 Shell（cwd 跟随一次 open 时传入的工作目录；命令中的 cd 由 Shell 自身处理）。
 *  - 内置控制命令（help/status/start/stop…）由调用方在 TERMINAL_INPUT 处理器里识别，
 *    本服务只负责「把行写进 Shell 标准输入并回传其输出」。
 *  - 命令字符串整体交给 Shell 执行（交互式控制台），不在此做 shell 元字符白名单——
 *    因为用户显式要求「任何指令必须听从终端」，且这是本机、用户自愿发起的本地控制台。
 *
 * 可注入 deps（测试用 mock spawn / platform）。生产用 createDefaultDeps()。
 */
const cp = require('child_process');

function createDefaultDeps() {
  return { spawn: cp.spawn, platform: process.platform };
}

function shellFor(platform) {
  if (platform === 'win32') return { command: 'cmd.exe', args: ['/q'] }; // /q 关闭命令回显
  const sh = process.env.SHELL || '/bin/sh';
  return { command: sh, args: [] };
}

function createTerminalManager({ emit, deps = {} }) {
  const d = Object.assign(createDefaultDeps(), deps);
  const sessions = new Map();
  let seq = 0;

  function open(opts = {}) {
    const id = 'term-' + (++seq);
    const cwd = (opts && opts.cwd) || process.cwd();
    const sh = shellFor(d.platform);
    let child;
    try {
      child = d.spawn(sh.command, sh.args, {
        cwd, shell: false, windowsHide: true,
        env: Object.assign({}, process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return { ok: false, error: '终端启动失败: ' + e.message };
    }
    if (!child || !child.pid) return { ok: false, error: '无法启动终端进程' };

    const session = { id, cwd, alive: true, child, history: [] };
    try { child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); } catch (_) {}
    child.stdout.on('data', (chunk) => emit('TERMINAL_OUTPUT', { sessionId: id, stream: 'stdout', text: String(chunk) }));
    child.stderr.on('data', (chunk) => emit('TERMINAL_OUTPUT', { sessionId: id, stream: 'stderr', text: String(chunk) }));
    child.on('error', (err) => {
      emit('TERMINAL_OUTPUT', { sessionId: id, stream: 'system', text: '\r\n[终端错误] ' + (err && err.message || err) + '\r\n' });
    });
    child.on('exit', (code, signal) => {
      session.alive = false;
      emit('TERMINAL_OUTPUT', {
        sessionId: id, stream: 'system',
        text: '\r\n[Shell 退出 code=' + (code == null ? '' : code) + (signal ? ' signal=' + signal : '') + ']\r\n',
      });
      emit('TERMINAL_EXIT', { sessionId: id, code: code == null ? null : code, signal: signal || null });
      sessions.delete(id);
    });
    sessions.set(id, session);
    return { ok: true, sessionId: id, cwd };
  }

  function write(sessionId, text) {
    const s = sessions.get(sessionId);
    if (!s || !s.alive) return { ok: false, error: '终端会话不存在或已关闭' };
    try {
      s.child.stdin.write(text);
      s.history.push(text.replace(/\r?\n$/, ''));
      if (s.history.length > 200) s.history = s.history.slice(-200);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  function close(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return { ok: false, error: '会话不存在' };
    try { s.child.kill('SIGKILL'); } catch (_) {}
    sessions.delete(sessionId);
    return { ok: true };
  }

  function closeAll() {
    for (const id of Array.from(sessions.keys())) close(id);
  }

  return { open, write, close, closeAll, _sessions: sessions };
}

module.exports = { createTerminalManager, createDefaultDeps, shellFor };
