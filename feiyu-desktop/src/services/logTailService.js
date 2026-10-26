'use strict';
/**
 * logTailService.js —— ai_bridge.log 实时尾部流式推送（仅在 Main 进程运行）。
 *
 * 设计：
 *  - 轮询式（跨平台稳定，避开 fs.watch 在 Windows 上「替换文件只发 rename」的坑）：
 *    每 interval 毫秒读一次文件，从已记录的字节偏移 offset 读取新增内容，逐行脱敏后推送。
 *  - offset 追踪：文件被截断 / 轮转（长度小于 offset）时，自动把 offset 归零从头读，避免读到旧尾部。
 *  - 仅推送「新行」；开启时一次性返回的「最近 N 行」由 start 的返回值带出（不走事件）。
 *
 * 可注入 deps（测试用 mock setInterval / clearInterval / fs）。生产用 createDefaultDeps()。
 */
const fs = require('fs');
const path = require('path');
const { redactText } = require('./redact');

function createDefaultDeps() {
  return { fs, path, setInterval, clearInterval, redactText };
}

function createLogTailer({ emit, deps = {} }) {
  const d = Object.assign(createDefaultDeps(), deps);
  let timer = null;
  let offset = 0;
  let currentPath = null;

  function readRecent(p, lines) {
    if (!d.fs.existsSync(p)) return [];
    let buf;
    try { buf = d.fs.readFileSync(p); } catch (_) { return []; }
    let text;
    try { text = buf.toString('utf-8'); } catch (_) { text = buf.toString('latin1'); }
    offset = buf.length;
    const all = text.split('\n');
    if (all.length && all[all.length - 1] === '') all.pop(); // 去掉结尾换行产生的空元素
    return all.slice(Math.max(0, all.length - lines)).map((l) => d.redactText(l));
  }

  function poll() {
    if (!currentPath || !d.fs.existsSync(currentPath)) return;
    let buf;
    try { buf = d.fs.readFileSync(currentPath); } catch (_) { return; }
    if (buf.length < offset) offset = 0; // 被截断/轮转
    const chunk = buf.slice(offset);
    offset = buf.length;
    if (!chunk.length) return;
    let text;
    try { text = chunk.toString('utf-8'); } catch (_) { text = chunk.toString('latin1'); }
    for (const raw of text.split('\n')) {
      if (raw === '') continue;
      emit('LOG_STREAM_LINE', { line: d.redactText(raw), ts: Date.now() });
    }
  }

  function start(botDir, opts = {}) {
    stop();
    const p = d.path.join(botDir, 'ai_bridge.log');
    currentPath = p;
    const lines = (opts && opts.lines) || 200;
    const recent = readRecent(p, lines);
    const interval = (opts && opts.interval) || 1000;
    timer = d.setInterval(poll, interval);
    if (typeof timer === 'object' && timer && typeof timer.unref === 'function') {
      try { timer.unref(); } catch (_) {}
    }
    return { recent, path: p, exists: d.fs.existsSync(p) };
  }

  function stop() {
    if (timer != null) { try { d.clearInterval(timer); } catch (_) {} timer = null; }
    offset = 0;
    currentPath = null;
  }

  return { start, stop, _getState: () => ({ path: currentPath, offset }) };
}

module.exports = { createLogTailer, createDefaultDeps };
