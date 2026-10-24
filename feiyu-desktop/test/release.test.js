'use strict';
/**
 * release.test.js —— 批次 E：发布准备与 Electron 安全配置的静态测试。
 * 只做静态检查（不打包、不联网、不安装）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

test('Electron 安全配置：contextIsolation 开启、nodeIntegration 关闭', () => {
  const main = read('src/main.js');
  assert.ok(/contextIsolation:\s*true/.test(main), '必须开启 contextIsolation');
  assert.ok(/nodeIntegration:\s*false/.test(main), '必须关闭 nodeIntegration');
});

test('preload 只暴露受控 invoke，不泄漏 Node 能力', () => {
  const preload = read('src/preload.js');
  for (const bad of ['require(\'fs\')', 'require("fs")', 'child_process', 'shell.', 'ipcRenderer.send']) {
    assert.ok(!preload.includes(bad), 'preload 不应包含: ' + bad);
  }
  assert.ok(preload.includes('contextBridge.exposeInMainWorld'), '必须经 contextBridge 暴露');
  assert.ok(/invoke:\s*\(channel,\s*args\)\s*=>\s*ipcRenderer\.invoke/.test(preload), '应仅暴露 invoke');
});

test('IPC 通道固定且每个通道有参数校验', () => {
  const { CHANNELS, validate } = require('../src/services/ipcChannels');
  const vals = Object.values(CHANNELS);
  assert.ok(vals.length >= 30, '通道数量: ' + vals.length);
  assert.strictEqual(new Set(vals).size, vals.length, '通道名不得重复');
  // 所有通道都必须被 validate 覆盖（未知通道会走到 default 分支返回错误）
  for (const c of vals) {
    const r = validate(c, {});
    assert.strictEqual(typeof r.ok, 'boolean', '通道未校验: ' + c);
    assert.ok(!/未知通道/.test(r.error || ''), '通道未在 validate 中登记: ' + c);
  }
});

test('SECRET_READ 通道不回传明文（handler 层）', () => {
  const h = read('src/ipc/handlers.js');
  const idx = h.indexOf('CHANNELS.SECRET_READ');
  assert.ok(idx > 0, '应存在 SECRET_READ 处理器');
  const seg = h.slice(idx, idx + 900);
  assert.ok(/maskSecret|masked/.test(seg), 'SECRET_READ 应使用掩码而非明文');
  assert.ok(!/data:\s*r\.data\b/.test(seg), 'SECRET_READ 不得直接回传明文 data');
});

test('打包配置：产物命名、目标、卸载保留用户数据', () => {
  const pkg = JSON.parse(read('package.json'));
  const b = pkg.build;
  assert.strictEqual(b.appId, 'com.feiyu.desktop');
  assert.ok(b.win.target.some((t) => t.target === 'nsis'), '应含 nsis 目标');
  assert.ok(b.win.target.some((t) => t.target === 'portable'), '应含 portable 目标');
  assert.ok(b.win.target.every((t) => t.arch === 'x64'), '应仅 x64');
  assert.strictEqual(b.nsis.deleteAppDataOnUninstall, false, '卸载不得删除用户数据');
  assert.ok(b.files.includes('src/**/*') && b.files.includes('renderer/**/*'), '打包清单需含运行时目录');
});

test('package.json 与 electron-builder.yml 配置一致', () => {
  const pkg = JSON.parse(read('package.json'));
  const yml = read('build/electron-builder.yml');
  assert.ok(yml.includes('com.feiyu.desktop'), 'yml appId 应一致');
  assert.ok(yml.includes('deleteAppDataOnUninstall: false'), 'yml 也应保留用户数据');
  assert.ok(yml.includes('portable'), 'yml 应含 portable 目标');
});

test('Electron 版本声明与实际安装一致', () => {
  const pkg = JSON.parse(read('package.json'));
  const declared = pkg.devDependencies.electron;
  let actual = null;
  try { actual = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version; } catch (_) {}
  if (!actual) return; // 未安装依赖时跳过（不伪造通过）
  const range = declared.replace('^', '').split('.').map(Number);
  const ver = actual.split('.').map(Number);
  assert.strictEqual(ver[0], range[0], '主版本应一致');
  assert.ok(ver[1] >= range[1], '次版本不应低于声明下限');
});

test('lockfile 存在，npm ci 可复现', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'package-lock.json')), '缺少 package-lock.json');
});

test('源码不含硬编码本机绝对路径', () => {
  for (const f of ['src/main.js', 'src/preload.js', 'src/ipc/handlers.js', 'renderer/renderer.js']) {
    const txt = read(f);
    assert.ok(!/[A-Za-z]:[\\/]NapCat_publish/.test(txt), f + ' 含硬编码本机路径');
  }
});

test('用户数据与安装目录分离（设置写入 userData）', () => {
  const main = read('src/main.js');
  assert.ok(/getPath\('userData'\)/.test(main), '应使用 userData 目录');
  const h = read('src/ipc/handlers.js');
  assert.ok(/getUserDataDir\(\)/.test(h), 'handlers 应通过 userData 存设置/价格');
});

test('bot 目录解析不依赖开发机固定路径', () => {
  const main = read('src/main.js');
  assert.ok(/process\.execPath/.test(main), '应包含 exe 相对候选（便携/安装版定位 bot）');
  assert.ok(!/D:\\/.test(main), 'main.js 不应含 D:\\ 硬编码');
  assert.ok(/resolveDefaultBotDir/.test(main));
});
