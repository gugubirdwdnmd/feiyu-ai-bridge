'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { USER_DATA_DIR_NAME, resolveUserDataDir } = require('../src/services/userDataPath');

// 升级兼容性核心约束：用户数据目录必须固定，不随显示名/品牌变化而迁移。
test('USER_DATA_DIR_NAME 固定为 feiyu-desktop-control-center（与 appId com.feiyu.desktop 对应）', () => {
  assert.strictEqual(USER_DATA_DIR_NAME, 'feiyu-desktop-control-center');
});

test('resolveUserDataDir 拼出固定目录，且不含任何品牌字串', () => {
  const appData = 'C:\\Users\\me\\AppData\\Roaming';
  const got = resolveUserDataDir(appData);
  assert.strictEqual(got, path.join(appData, 'feiyu-desktop-control-center'));
  assert.ok(!got.includes('玄枢'), '路径不得含新品牌字串');
  assert.ok(!got.includes('XUANSHU'), '路径不得含新品牌字串');
  assert.ok(!got.includes('肥鱼'), '路径不得含旧品牌字串');
});

test('resolveUserDataDir 与 v1.0.0 的 app.getPath("userData") 解析结果一致（升级不迁移数据）', () => {
  // v1.0.0 的 userData = <appData>/<app.name>，app.name 来自 npm name = feiyu-desktop-control-center
  const appData = '/home/me/.config'; // 类 Unix 示例
  const legacy = path.join(appData, 'feiyu-desktop-control-center');
  assert.strictEqual(resolveUserDataDir(appData), legacy);
});

test('resolveUserDataDir 对非法输入抛错（防止空路径导致数据落到错误位置）', () => {
  assert.throws(() => resolveUserDataDir(''));
  assert.throws(() => resolveUserDataDir(null));
  assert.throws(() => resolveUserDataDir(undefined));
});
