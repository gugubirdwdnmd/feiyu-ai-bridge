'use strict';
/**
 * botDirFunctional.test.js —— 阶段 E「真实 botDir 功能联调」的自动化覆盖。
 *
 * 任务书要求覆盖：正常 / 缺失 / 无权限 / 结构异常 四类场景，
 * 并确认：能区分工作目录与发布副本、不硬编码发布副本、找不到时不自动创建目录、
 * BOTDIR_STATUS 结构化状态与 UI 一致、探测不泄漏敏感信息。
 *
 * 全部使用**临时模拟目录**；真实机器人目录只做只读检查（见文件末尾）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const resolver = require('../src/services/botDirResolver');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'botdir-e-')); }

// ————————————————————————————————————————
// 正常场景
// ————————————————————————————————————————

test('E-1: 用户可指定正常的机器人工作目录', () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'ai_bridge.js'), '// core');
  const r = resolver.resolveBotDir({ botDir: d, fsImpl: fs });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(path.resolve(r.botDir), path.resolve(d));
  assert.strictEqual(r.source, 'settings');
  fs.rmSync(d, { recursive: true, force: true });
});

test('E-2: 自动发现时明确给出解析出的绝对路径', () => {
  const root = tmpDir();
  const work = path.join(root, 'my-bot');
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, 'ai_bridge.js'), '// core');
  const r = resolver.resolveBotDir({
    appPath: path.join(root, 'app', 'resources', 'app.asar'),
    execPath: path.join(root, 'app', 'app.exe'),
    home: path.join(root, 'home'),
    fsImpl: fs,
  });
  assert.strictEqual(r.ok, true);
  assert.ok(path.isAbsolute(r.botDir), '必须返回绝对路径');
  assert.strictEqual(path.resolve(r.botDir), path.resolve(work));
  fs.rmSync(root, { recursive: true, force: true });
});

// ————————————————————————————————————————
// 缺失场景
// ————————————————————————————————————————

test('E-3: 路径不存在时给出可理解的失败原因（fail-closed）', () => {
  const r = resolver.resolveBotDir({ botDir: 'C:\\gone\\bot-' + Date.now(), fsImpl: fs });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'settings_dir_missing');
  assert.ok(r.warning.includes('重新选择'));
});

test('E-3: 目录存在但缺 ai_bridge.js → ok=true 但带明确警告（结构异常）', () => {
  const d = tmpDir();
  const r = resolver.resolveBotDir({ botDir: d, fsImpl: fs });
  assert.strictEqual(r.ok, true);
  assert.ok(r.warning.includes('ai_bridge.js'), '必须提示缺核心文件，不能静默误判成功');
  fs.rmSync(d, { recursive: true, force: true });
});

// ————————————————————————————————————————
// 无权限场景
// ————————————————————————————————————————

test('E-4: 目录不可读时不抛错、不误判成功', () => {
  const fsMock = {
    existsSync: () => true,
    readdirSync: () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; },
    statSync: () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; },
  };
  const r = resolver.resolveBotDir({
    appPath: 'C:\\app\\resources\\app.asar',
    execPath: 'C:\\app\\app.exe',
    home: 'C:\\home',
    fsImpl: fsMock,
  });
  assert.strictEqual(r.ok, false, '不可读时不得误判成功');
  assert.strictEqual(r.reason, 'not_found');
});

test('E-4: 无权限目录被选中时按「显式指定」处理并给出警告', () => {
  const fsMock = {
    // 目录本身可见，但列举/取属性/读核心文件都无权限 → 无法确认核心文件是否存在
    existsSync: (p) => String(p) === 'C:\\somewhere',
    readdirSync: () => { throw new Error('EACCES'); },
    statSync: () => { throw new Error('EACCES'); },
  };
  const r = resolver.resolveBotDir({ botDir: 'C:\\somewhere', fsImpl: fsMock });
  assert.strictEqual(r.ok, true, '用户显式指定且目录存在 → 仍接受');
  assert.ok(r.warning && r.warning.includes('ai_bridge.js'),
    '无法确认核心文件时应给出警告，而不是静默认为正常: ' + JSON.stringify(r.warning));
});

// ————————————————————————————————————————
// 工作目录 vs 发布副本
// ————————————————————————————————————————

test('E-5: 能区分工作目录与发布副本（自动发现跳过副本）', () => {
  const root = tmpDir();
  const co = path.join(root, 'publish-copy');
  const work = path.join(root, 'real-work');
  fs.mkdirSync(co); fs.mkdirSync(work);
  fs.writeFileSync(path.join(co, 'ai_bridge.js'), '');
  fs.mkdirSync(path.join(co, '.git'));
  fs.writeFileSync(path.join(work, 'ai_bridge.js'), '');

  const r = resolver.resolveBotDir({
    appPath: path.join(root, 'app', 'resources', 'app.asar'),
    execPath: path.join(root, 'app', 'app.exe'),
    home: path.join(root, 'home'),
    fsImpl: fs,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(path.resolve(r.botDir), path.resolve(work), '必须命中工作目录而非发布副本');
  assert.strictEqual(r.isCheckout, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('E-5: 只有发布副本时 fail-closed，不误判为工作目录', () => {
  const root = tmpDir();
  const co = path.join(root, 'publish-copy');
  fs.mkdirSync(co);
  fs.writeFileSync(path.join(co, 'ai_bridge.js'), '');
  fs.mkdirSync(path.join(co, '.git'));
  const r = resolver.resolveBotDir({
    appPath: path.join(root, 'app', 'resources', 'app.asar'),
    execPath: path.join(root, 'app', 'app.exe'),
    home: path.join(root, 'home'),
    fsImpl: fs,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'not_found');
  fs.rmSync(root, { recursive: true, force: true });
});

test('E-6: 不硬编码 D:\\NapCat_publish（源码字面量检查）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'botDirResolver.js'), 'utf-8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/NapCat_publish/i.test(code), '代码中不得出现 NapCat_publish');
  assert.ok(!/NapCat/i.test(code), '代码中不得出现任何 NapCat 硬编码');
});

test('E-6: 候选路径不含具体盘符根', () => {
  const list = resolver.candidateDirs({
    appPath: 'D:\\app\\resources\\app.asar',
    execPath: 'D:\\app\\x.exe',
    home: 'C:\\Users\\me',
  });
  for (const c of list) {
    assert.ok(!/^[a-z]:\\?$/i.test(c), '候选不得是裸盘符根: ' + c);
  }
});

// ————————————————————————————————————————
// 找不到时不得自动创建/覆盖/清理
// ————————————————————————————————————————

test('E-7: 找不到时不自动创建、覆盖或清理任何目录', () => {
  const root = tmpDir();
  const target = path.join(root, 'would-be-bot');
  const before = fs.readdirSync(root).sort();
  const r = resolver.resolveBotDir({
    appPath: path.join(root, 'app', 'resources', 'app.asar'),
    execPath: path.join(root, 'app', 'app.exe'),
    home: path.join(root, 'home'),
    fsImpl: fs,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(fs.existsSync(target), false, '不得创建目标目录');
  assert.deepStrictEqual(fs.readdirSync(root).sort(), before, '不得增删任何目录');
  fs.rmSync(root, { recursive: true, force: true });
});

// ————————————————————————————————————————
// 探测不泄漏敏感信息
// ————————————————————————————————————————

test('E-9: 探测结果不含用户目录/凭据等敏感信息（只回路径与结构化状态）', () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'ai_bridge.js'), '// core');
  const r = resolver.resolveBotDir({ botDir: d, fsImpl: fs });
  const keys = Object.keys(r);
  for (const k of keys) {
    assert.ok(!/key|token|secret|password|credential/i.test(k), '返回结构不得含敏感字段名: ' + k);
  }
  // tried 列表里只能是路径
  if (Array.isArray(r.tried)) {
    for (const t of r.tried) assert.strictEqual(typeof t, 'string');
  }
  fs.rmSync(d, { recursive: true, force: true });
});

test('E-9: 失败时的 warning 不含任何密钥样式字符串', () => {
  const r = resolver.resolveBotDir({ botDir: 'C:\\nope-' + Date.now(), fsImpl: fs });
  assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(r.warning || ''));
  assert.ok(!/Bearer/i.test(r.warning || ''));
});

// ————————————————————————————————————————
// 真实目录只读检查（不修改）
// ————————————————————————————————————————

test('E-10: 真实机器人目录只读检查：存在核心文件且不含副本特征', () => {
  const real = 'D:\\NapCat';
  if (!fs.existsSync(real)) return;   // 环境无该目录则跳过（不伪造）
  assert.ok(fs.existsSync(path.join(real, 'ai_bridge.js')), '真实机器人目录应含 ai_bridge.js');
  assert.strictEqual(resolver.isSourceCheckout(real), false, '真实机器人目录不应被判为发布副本');
  assert.strictEqual(resolver.isBotDir(real), true);
});

test('E-10: 真实发布副本只读检查：应被判为源码检出', () => {
  const pub = 'D:\\NapCat_publish';
  if (!fs.existsSync(pub)) return;
  assert.strictEqual(resolver.isSourceCheckout(pub), true, '发布副本应被识别为源码检出');
});
