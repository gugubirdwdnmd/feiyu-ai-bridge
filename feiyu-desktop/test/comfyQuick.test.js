'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const comfy = require('../src/services/comfyService');

test('resolvePython: 无目录回落 PATH 上的 python', () => {
  assert.strictEqual(comfy.resolvePython(''), 'python');
});

test('resolvePython: 便携版 python_embeded 优先', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-py-'));
  try {
    // 真实便携版布局：<portable>/ComfyUI/main.py 与 <portable>/python_embeded/python.exe 同级
    const root = path.join(tmp, 'ComfyUI');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(tmp, 'python_embeded'), { recursive: true });
    fs.writeFileSync(path.join(root, 'main.py'), '');
    fs.writeFileSync(path.join(tmp, 'python_embeded', 'python.exe'), '');
    assert.strictEqual(comfy.resolvePython(root), path.join(tmp, 'python_embeded', 'python.exe'));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('launchSpec: 非 ComfyUI 目录报错', () => {
  const r = comfy.launchSpec('C:\\not-a-comfy-dir');
  assert.strictEqual(r.ok, false);
  assert.ok(/未找到 ComfyUI/.test(r.error));
});

test('launchSpec: 正常目录返回 spawn 参数（纯函数，不真正拉起）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-root-'));
  try {
    fs.writeFileSync(path.join(tmp, 'main.py'), '');
    const r = comfy.launchSpec(tmp, { port: 8188 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.spec.command, 'python');
    assert.deepStrictEqual(r.spec.args, ['main.py', '--port', '8188', '--listen', '127.0.0.1']);
    assert.strictEqual(r.spec.cwd, tmp);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('launchSpec: 默认端口为 8188', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-d-'));
  try {
    fs.writeFileSync(path.join(tmp, 'main.py'), '');
    const r = comfy.launchSpec(tmp);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.spec.args[2], '8188');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
