'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLogTailer } = require('../src/services/logTailService');

function makeDeps(capture) {
  let pollCb = null;
  const deps = {
    fs,
    path,
    redactText: (s) => s, // 不脱敏，便于断言
    setInterval: (cb) => { pollCb = cb; return { unref() {} }; },
    clearInterval: () => {},
  };
  return { deps, getPoll: () => pollCb, emits: capture };
}

test('start 返回最近 N 行，轮询追加新行', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-log-'));
  try {
    const logPath = path.join(dir, 'ai_bridge.log');
    fs.writeFileSync(logPath, 'line1\nline2\nline3\n');
    const emits = [];
    const { deps, getPoll } = makeDeps(emits);
    const tailer = createLogTailer({ emit: (ch, p) => emits.push({ ch, p }), deps });
    const r = tailer.start(dir, { lines: 3, interval: 1000 });
    assert.deepStrictEqual(r.recent, ['line1', 'line2', 'line3']);

    fs.appendFileSync(logPath, 'line4\nline5\n');
    const poll = getPoll();
    assert.ok(poll);
    poll();
    const lines = emits.filter((e) => e.ch === 'LOG_STREAM_LINE').map((e) => e.p.line);
    assert.deepStrictEqual(lines, ['line4', 'line5']);
    tailer.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('文件被截断后轮询从头读', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-log2-'));
  try {
    const logPath = path.join(dir, 'ai_bridge.log');
    fs.writeFileSync(logPath, 'a\nb\nc\n');
    const emits = [];
    const { deps, getPoll } = makeDeps(emits);
    const tailer = createLogTailer({ emit: (ch, p) => emits.push({ ch, p }), deps });
    tailer.start(dir, { lines: 1 });
    fs.writeFileSync(logPath, 'x\ny\n');
    getPoll()();
    const lines = emits.filter((e) => e.ch === 'LOG_STREAM_LINE').map((e) => e.p.line);
    assert.deepStrictEqual(lines, ['x', 'y']);
    tailer.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stop 后不再推送', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-log3-'));
  try {
    const logPath = path.join(dir, 'ai_bridge.log');
    fs.writeFileSync(logPath, 'init\n');
    const emits = [];
    const { deps, getPoll } = makeDeps(emits);
    const tailer = createLogTailer({ emit: (ch, p) => emits.push({ ch, p }), deps });
    tailer.start(dir, { lines: 1 });
    tailer.stop();
    fs.appendFileSync(logPath, 'more\n');
    getPoll()(); // 闭包仍指向旧 poll，但 currentPath 已清空，应直接 return
    assert.strictEqual(emits.filter((e) => e.ch === 'LOG_STREAM_LINE').length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
