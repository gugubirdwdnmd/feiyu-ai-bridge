'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createTerminalManager } = require('../src/services/terminalService');

/** 构造一个假的 Shell 子进程：捕获 on 处理器，供测试手动触发 data/exit。 */
function makeFakeChild(pid) {
  const handlers = {};
  const writes = [];
  const child = {
    pid,
    killed: false,
    writes,
    stdin: { write: (t) => { writes.push(t); return true; } },
    stdout: { setEncoding() {}, on(ev, cb) { handlers['stdout:' + ev] = cb; } },
    stderr: { setEncoding() {}, on(ev, cb) { handlers['stderr:' + ev] = cb; } },
    on(ev, cb) { handlers['child:' + ev] = cb; },
    kill() { this.killed = true; },
    _fire(name, ...args) { if (handlers[name]) handlers[name](...args); },
  };
  return child;
}

test('open 成功并返回 sessionId；write 写入 stdin', () => {
  const child = makeFakeChild(12345);
  const tm = createTerminalManager({ emit: () => {}, deps: { spawn: () => child, platform: 'win32' } });
  const o = tm.open({ cwd: 'C:\\tmp' });
  assert.strictEqual(o.ok, true);
  assert.ok(o.sessionId);
  const w = tm.write(o.sessionId, 'echo hi\n');
  assert.strictEqual(w.ok, true);
  assert.deepStrictEqual(child.writes, ['echo hi\n']);
});

test('stdout/stderr 经 emit 推回，sessionId 一致', () => {
  const child = makeFakeChild(7);
  const emits = [];
  const tm = createTerminalManager({ emit: (ch, p) => emits.push({ ch, p }), deps: { spawn: () => child, platform: 'win32' } });
  const sid = tm.open({ cwd: 'C:\\tmp' }).sessionId;
  child._fire('stdout:data', 'hello');
  child._fire('stderr:data', 'oops');
  const out = emits.find((e) => e.ch === 'TERMINAL_OUTPUT' && e.p.stream === 'stdout');
  const err = emits.find((e) => e.ch === 'TERMINAL_OUTPUT' && e.p.stream === 'stderr');
  assert.ok(out); assert.strictEqual(out.p.text, 'hello'); assert.strictEqual(out.p.sessionId, sid);
  assert.ok(err); assert.strictEqual(err.p.text, 'oops');
});

test('exit 触发 TERMINAL_EXIT 并从会话表移除；之后写返回错误', () => {
  const child = makeFakeChild(7);
  const emits = [];
  const tm = createTerminalManager({ emit: (ch, p) => emits.push({ ch, p }), deps: { spawn: () => child, platform: 'win32' } });
  const sid = tm.open({ cwd: 'C:\\tmp' }).sessionId;
  child._fire('child:exit', 0, null);
  const exit = emits.find((e) => e.ch === 'TERMINAL_EXIT');
  assert.ok(exit); assert.strictEqual(exit.p.code, 0);
  assert.strictEqual(tm._sessions.has(sid), false);
  assert.strictEqual(tm.write(sid, 'x\n').ok, false);
});

test('close 杀掉子进程；spawn 抛错返回错误', () => {
  const child = makeFakeChild(99);
  const tm = createTerminalManager({ emit: () => {}, deps: { spawn: () => child, platform: 'win32' } });
  const sid = tm.open({ cwd: 'C:\\tmp' }).sessionId;
  tm.close(sid);
  assert.strictEqual(child.killed, true);

  const tm2 = createTerminalManager({ emit: () => {}, deps: { spawn: () => { throw new Error('boom'); }, platform: 'win32' } });
  const o = tm2.open({ cwd: 'C:\\tmp' });
  assert.strictEqual(o.ok, false);
  assert.ok(/启动失败/.test(o.error));
});
