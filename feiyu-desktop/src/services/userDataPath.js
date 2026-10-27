'use strict';
/**
 * userDataPath.js —— 显式固定用户数据目录。
 *
 * 升级兼容性关键约束（玄枢 XUANSHU 阶段 1）：
 *  - 用户数据目录必须固定为 feiyu-desktop-control-center，不随「显示名 / productName /
 *    品牌」变化而迁移，保证 v1.0.0 → 新版升级时既有设置、凭据、插件、用量不丢。
 *  - 该目录名取自 npm package.name（feiyu-desktop-control-center），与 appId
 *    com.feiyu.desktop 一致；此处用常量显式写出，避免任何隐式依赖 productName。
 *  - NSIS 安装器 GUID 由 electron-builder 依据 appId 推导，appId 不变则 GUID 不变。
 *
 * 纯函数，可脱离 Electron 单测：resolveUserDataDir(appDataPath) 仅拼路径，不触碰 electron。
 */
const path = require('path');

// 固定目录名：即使 productName 改为「玄枢 XUANSHU」，此值也不变。
const USER_DATA_DIR_NAME = 'feiyu-desktop-control-center';

/**
 * 由系统 AppData 根目录推导用户数据目录。
 * @param {string} appDataPath 例如 C:\Users\me\AppData\Roaming
 * @returns {string} 例如 C:\Users\me\AppData\Roaming\feiyu-desktop-control-center
 */
function resolveUserDataDir(appDataPath) {
  if (typeof appDataPath !== 'string' || appDataPath.length === 0) {
    throw new Error('resolveUserDataDir: appDataPath 必须是非空字符串');
  }
  return path.join(appDataPath, USER_DATA_DIR_NAME);
}

module.exports = { USER_DATA_DIR_NAME, resolveUserDataDir };
