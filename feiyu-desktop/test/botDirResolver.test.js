'use strict';
/**
 * botDirResolver.test.js —— botDir 定位与「工作目录 / 发布副本」区分的回归测试。
 *
 * 本轮 V1.0 验收发现的 P1：原实现硬编码 'NapCat_publish' 作为候选路径，
 * 导致安装版自动定位到**发布副本**而非真实工作目录，且便携版反而定位失败。
 * 这里逐条锁定修复行为。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const resolver = require('../src/services/botDirResolver');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'botdir-'));
}

/** 造一个「真实工作目录」：含 ai_bridge.js，无 .git / feiyu-desktop。 */
function makeWorkDir() {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'ai_bridge.js'), '// core\n');
  return d;
}

/** 造一个「发布副本」：含 ai_bridge.js + .git。 */
function makeCheckoutDir() {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'ai_bridge.js'), '// core\n');
  fs.mkdirSync(path.join(d, '.git'));
  return d;
}

/** 造一个「桌面端源码树」：含 ai_bridge.js + feiyu-desktop/。 */
function makeDesktopSourceDir() {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'ai_bridge.js'), '// core\n');
  fs.mkdirSync(path.join(d, 'feiyu-desktop'));
  return d;
}

// ————————————————————————————————————————
// 1) 硬编码路径必须消失
// ————————————————————————————————————————

test('P1-1: 候选路径不含任何硬编码的开发机目录名', () => {
  const list = resolver.candidateDirs({
    appPath: 'D:\\app\\resources\\app.asar',
    execPath: 'D:\\app\\肥鱼桌面控制中心.exe',
    home: 'C:\\Users\\AA',
  });
  const joined = list.join(' | ').toLowerCase();
  assert.ok(!joined.includes('napcat_publish'), '候选路径不得包含 NapCat_publish：' + joined);
  assert.ok(!joined.includes('napcat'), '候选路径不得包含任何 Napcat* 硬编码：' + joined);
  // 不得出现裸盘符根（如 D:\）——那等于硬编码了某台机器的布局
  for (const c of list) {
    assert.ok(!/^[a-z]:\\?$/i.test(c), '候选不得是裸盘符根：' + c);
  }
  // 注：像 D:\bot 这类「由 exeDir 推导出来」的路径是合法的，
  // 真正的硬编码检查由下面那条「源码字面量」测试负责。
});

test('P1-1: 源码中不含硬编码的 NapCat_publish 字面量', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'botDirResolver.js'), 'utf-8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!code.includes('NapCat_publish'), '实现代码不得出现 NapCat_publish 字面量');
});

// ————————————————————————————————————————
// 2) 工作目录 vs 发布副本的区分
// ————————————————————————————————————————

test('P1-2: isSourceCheckout 认得 .git 与 feiyu-desktop 两种形态', () => {
  const co = makeCheckoutDir();
  const ds = makeDesktopSourceDir();
  const work = makeWorkDir();
  assert.strictEqual(resolver.isSourceCheckout(co), true);
  assert.strictEqual(resolver.isSourceCheckout(ds), true);
  assert.strictEqual(resolver.isSourceCheckout(work), false);
  assert.strictEqual(resolver.isSourceCheckout(null), false);
  [co, ds, work].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

test('P1-2: 自动发现跳过发布副本，继续找真正的工作目录', () => {
  const root = tmpDir();
  // 布局：安装目录与发布副本、工作目录同级
  const install = path.join(root, 'feiyu-app');
  const checkout = path.join(root, 'publish-copy');
  const work = path.join(root, 'bot-work');
  fs.mkdirSync(install); fs.mkdirSync(checkout); fs.mkdirSync(work);
  fs.writeFileSync(path.join(checkout, 'ai_bridge.js'), '');
  fs.mkdirSync(path.join(checkout, '.git'));
  fs.writeFileSync(path.join(work, 'ai_bridge.js'), '');

  const r = resolver.resolveBotDir({
    appPath: path.join(install, 'resources', 'app.asar'),
    execPath: path.join(install, 'app.exe'),
    home: path.join(root, 'home'),
    fsImpl: fs,
  });
  assert.strictEqual(r.ok, true, '应找到工作目录');
  assert.strictEqual(path.resolve(r.botDir), path.resolve(work), '必须跳过发布副本，命中工作目录');
  assert.strictEqual(r.isCheckout, false);
  assert.strictEqual(r.source, 'discovered_sibling');
  fs.rmSync(root, { recursive: true, force: true });
});

test('P1-2: 全部候选都是发布副本时返回 not_found（而不是误判成功）', () => {
  const root = tmpDir();
  const co = path.join(root, 'copy');
  fs.mkdirSync(co);
  fs.writeFileSync(path.join(co, 'ai_bridge.js'), '');
  fs.mkdirSync(path.join(co, '.git'));

  const r = resolver.resolveBotDir({
    appPath: path.join(root, 'app', 'resources', 'app.asar'),
    execPath: path.join(root, 'app', 'app.exe'),
    home: path.join(root, 'home'),
    fsImpl: fs,
  });
  assert.strictEqual(r.ok, false, '只有发布副本时不得误判成功');
  assert.strictEqual(r.reason, 'not_found');
  assert.ok(r.warning.includes('手动选择'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('P1-2: 用户显式指定发布副本时仍允许，但标记 isCheckout 并给出提示', () => {
  const co = makeCheckoutDir();
  const r = resolver.resolveBotDir({ botDir: co, fsImpl: fs });
  assert.strictEqual(r.ok, true, '用户显式指定不得被拒绝');
  assert.strictEqual(r.isCheckout, true);
  assert.ok(r.note && r.note.includes('源码检出'), '应提示这是发布副本');
  fs.rmSync(co, { recursive: true, force: true });
});

test('P1-2: 用户显式指定正常工作目录时 isCheckout=false 且无提示', () => {
  const work = makeWorkDir();
  const r = resolver.resolveBotDir({ botDir: work, fsImpl: fs });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.isCheckout, false);
  assert.strictEqual(r.note, null);
  fs.rmSync(work, { recursive: true, force: true });
});

// ————————————————————————————————————————
// 3) 便携版场景（原先定位失败）
// ————————————————————————————————————————

test('P1-3: 便携版（exe 与工作目录同级）能定位', () => {
  const root = tmpDir();
  const portable = path.join(root, 'portable');
  const work = path.join(root, 'bot-work');
  fs.mkdirSync(portable); fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, 'ai_bridge.js'), '');

  const r = resolver.resolveBotDir({
    appPath: path.join(portable, 'resources', 'app.asar'),
    execPath: path.join(portable, 'app.exe'),
    home: path.join(root, 'home'),
    fsImpl: fs,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(path.resolve(r.botDir), path.resolve(work));
  fs.rmSync(root, { recursive: true, force: true });
});

test('P1-3: 工作目录在 exe 的上一级（bot/ 子目录）能定位', () => {
  const root = tmpDir();
  const app = path.join(root, 'app');
  const bot = path.join(root, 'bot');
  fs.mkdirSync(app); fs.mkdirSync(bot);
  fs.writeFileSync(path.join(bot, 'ai_bridge.js'), '');

  const r = resolver.resolveBotDir({
    appPath: path.join(app, 'resources', 'app.asar'),
    execPath: path.join(app, 'app.exe'),
    home: path.join(root, 'home'),
    fsImpl: fs,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(path.resolve(r.botDir), path.resolve(bot));
  fs.rmSync(root, { recursive: true, force: true });
});

// ————————————————————————————————————————
// 4) 失败路径与安全边界
// ————————————————————————————————————————

test('P1-4: 设置目录已消失时 fail-closed 并给出可理解原因', () => {
  const r = resolver.resolveBotDir({ botDir: 'C:\\definitely\\gone\\here', fsImpl: fs });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'settings_dir_missing');
  assert.ok(r.warning.includes('重新选择'));
});

test('P1-4: 显式指定但缺 ai_bridge.js 时 ok=true 并给出警告', () => {
  const d = tmpDir();
  const r = resolver.resolveBotDir({ botDir: d, fsImpl: fs });
  assert.strictEqual(r.ok, true);
  assert.ok(r.warning.includes('ai_bridge.js'));
  fs.rmSync(d, { recursive: true, force: true });
});

test('P1-4: 探测过程不创建/修改任何目录（只读）', () => {
  const root = tmpDir();
  const work = path.join(root, 'bot-work');
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, 'ai_bridge.js'), '');
  const before = fs.readdirSync(root).sort();

  resolver.resolveBotDir({
    appPath: path.join(root, 'app', 'resources', 'app.asar'),
    execPath: path.join(root, 'app', 'app.exe'),
    home: path.join(root, 'home'),
    fsImpl: fs,
  });
  const after = fs.readdirSync(root).sort();
  assert.deepStrictEqual(after, before, '探测不得创建任何目录');
  fs.rmSync(root, { recursive: true, force: true });
});

test('P1-4: siblingCandidates 遇到无权限目录不抛错', () => {
  const r = resolver.siblingCandidates('C:\\Windows\\System32\\config\\x.exe', {
    existsSync: () => true,
    readdirSync: () => { throw new Error('EACCES'); },
    statSync: () => { throw new Error('EACCES'); },
  });
  assert.deepStrictEqual(r, []);
});

test('P1-4: siblingCandidates 只返回目录，不返回文件', () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'a.txt'), 'x');
  fs.mkdirSync(path.join(root, 'dirB'));
  const list = resolver.siblingCandidates(path.join(root, 'app', 'app.exe'), fs);
  assert.ok(!list.some((p) => p.endsWith('a.txt')), '不得包含文件');
  fs.rmSync(root, { recursive: true, force: true });
});

test('P1-4: isBotDir 对不存在/空值返回 false 而不抛错', () => {
  assert.strictEqual(resolver.isBotDir(null), false);
  assert.strictEqual(resolver.isBotDir(''), false);
  assert.strictEqual(resolver.isBotDir('C:\\no\\such\\dir'), false);
});
