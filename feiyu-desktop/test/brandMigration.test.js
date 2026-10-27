'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const eb = fs.readFileSync(path.join(root, 'build/electron-builder.yml'), 'utf-8');
const mainJs = fs.readFileSync(path.join(root, 'src/main.js'), 'utf-8');
const indexHtml = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf-8');
const rendererJs = fs.readFileSync(path.join(root, 'renderer/renderer.js'), 'utf-8');

// 阶段 1：品牌升级「只改显示名」。用户可见品牌 → 玄枢 XUANSHU。
test('package.json: build.productName 已改为 玄枢 XUANSHU（显示名）', () => {
  assert.strictEqual(pkg.build.productName, '玄枢 XUANSHU');
});

test('electron-builder.yml: productName / portable artifactName 已改为 玄枢 XUANSHU（显示名）', () => {
  assert.ok(/^productName:\s*玄枢 XUANSHU\s*$/m.test(eb), 'productName 应为 玄枢 XUANSHU');
  assert.ok(eb.includes('玄枢 XUANSHU-${version}-portable.${ext}'), 'portable artifactName 应含新显示名');
});

test('main.js: 窗口标题改为 玄枢 XUANSHU', () => {
  assert.ok(mainJs.includes("title: '玄枢 XUANSHU'"), '窗口标题应已改为新显示名');
});

test('index.html: <title> 与品牌区改为 玄枢 XUANSHU', () => {
  assert.ok(indexHtml.includes('<title>玄枢 XUANSHU</title>'), 'HTML title 应已改');
  assert.ok(indexHtml.includes('玄枢 XUANSHU'), '品牌区应已改');
});

test('renderer.js: 关于页产品名改为 玄枢 XUANSHU（用户可见文案）', () => {
  assert.ok(rendererJs.includes('玄枢 XUANSHU：基于现有'), '关于页应出现新显示名');
  assert.ok(!rendererJs.includes('肥鱼桌面控制中心：基于现有'), '关于页旧显示名应已移除');
});

// 兼容性标识全部保留（数据迁移不丢）。
test('package.json: 内部标识符保留（name / appId / author 不变）', () => {
  assert.strictEqual(pkg.name, 'feiyu-desktop-control-center', 'npm name 决定 userData 目录，必须保留');
  assert.strictEqual(pkg.build.appId, 'com.feiyu.desktop', 'appId 决定 NSIS GUID，必须保留');
  assert.strictEqual(pkg.author, 'Feiyu', 'author 为发布者元数据，本轮不改');
});

test('electron-builder.yml: appId 保留（NSIS 安装器 GUID 由 appId 推导，不变则 GUID 不变）', () => {
  assert.ok(/^appId:\s*com\.feiyu\.desktop\s*$/m.test(eb), 'appId 必须保留');
});

test('main.js: userData 路径已显式固定，不再隐式依赖 productName', () => {
  assert.ok(mainJs.includes("require('./services/userDataPath')"), '应引入显式路径模块');
  assert.ok(mainJs.includes("resolveUserDataDir(app.getPath('appData'))"), '应使用显式固定路径');
  assert.ok(!mainJs.includes("app.getPath('userData')"), '不得再隐式依赖 productName 派生的 userData');
});

test('renderer.js: 非显示名内容未过度修改（保留代码注释与示例占位）', () => {
  // 文件头注释不是显示名，按「只改显示名」原则保留。
  assert.ok(rendererJs.includes('renderer.js —— 肥鱼桌面控制中心 UI 逻辑'), '代码注释按约定保留');
});
