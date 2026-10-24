'use strict';
/**
 * botDirResolver.js —— 机器人项目目录（botDir）的定位与判定（纯逻辑，可单测）。
 *
 * 背景：安装版 / 便携版里 app.getAppPath() 指向 app.asar 内部，
 * 在其中永远找不到 ai_bridge.js —— 只有开发期（仓库根）才碰巧能命中。
 * 因此定位逻辑必须同时考虑：
 *   1) 用户设置里保存的 botDir（用户在界面上手动选过）
 *   2) 打包内自带 bot/
 *   3) 开发期仓库根
 *   4) exe 所在目录及其上溯两级（便携包最常见：exe 与 bot 同级或 bot 在上一级）
 *   5) 用户主目录下的常见位置
 *
 * 约束：
 *  - 绝不硬编码盘符或开发机路径；所有候选都由 appPath/execPath/home 推导。
 *  - 找不到时返回空串 + 明确原因，由界面提示用户手动选择（不得静默失败）。
 */
const fs = require('fs');
const path = require('path');

/** 目录是否是机器人项目根（含 ai_bridge.js）。 */
function isBotDir(p, fsImpl) {
  const f = fsImpl || fs;
  try { return !!p && f.existsSync(path.join(p, 'ai_bridge.js')); } catch (_) { return false; }
}

/**
 * 生成候选目录列表（按优先级）。参数均为注入点，便于测试。
 * @param {object} o { appPath, execPath, home, botDir }
 */
function candidateDirs(o) {
  o = o || {};
  const list = [];
  if (o.botDir) list.push(o.botDir);                    // 1) 用户设置
  if (o.appPath) {                                     // 2)(3) 打包内 / 开发期
    list.push(path.join(o.appPath, 'bot'));
    list.push(o.appPath);
    list.push(path.join(o.appPath, '..'));
  }
  if (o.execPath) {                                    // 4) exe 相对（便携/安装）
    const exeDir = path.dirname(o.execPath);
    list.push(path.join(exeDir, 'bot'));
    list.push(path.join(exeDir, '..', 'bot'));
    list.push(path.join(exeDir, '..', 'NapCat_publish'));
    list.push(path.join(exeDir, '..', '..', 'NapCat_publish'));
  }
  if (o.home) {                                        // 5) 用户主目录
    list.push(path.join(o.home, 'NapCat_publish'));
    list.push(path.join(o.home, 'bot'));
  }
  // 去重（按解析后的绝对路径），保持优先级顺序
  const seen = new Set();
  const out = [];
  for (const c of list) {
    if (!c) continue;
    let k;
    try { k = path.resolve(c); } catch (_) { continue; }
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/**
 * 解析 botDir。
 * 返回 {ok, botDir, reason, tried}
 *  - ok:true  → botDir 为有效机器人项目根
 *  - ok:false → botDir 为空，reason 说明原因（界面据此提示用户手动选择）
 */
function resolveBotDir(o) {
  o = o || {};
  const f = o.fsImpl || fs;
  // 1) 用户设置优先：即使目录里已无 ai_bridge.js，也按「用户显式指定」处理
  //    （但会记录警告，让界面知道核心文件缺失）
  if (o.botDir) {
    const exists = (() => { try { return f.existsSync(o.botDir); } catch (_) { return false; } })();
    if (exists) {
      if (isBotDir(o.botDir, f)) return { ok: true, botDir: o.botDir, source: 'settings', warning: null };
      return { ok: true, botDir: o.botDir, source: 'settings', warning: '所选目录未找到 ai_bridge.js，机器人功能可能不可用' };
    }
    return { ok: false, botDir: '', reason: 'settings_dir_missing', warning: '设置中的机器人目录已不存在，请重新选择', tried: [o.botDir] };
  }
  const candidates = candidateDirs(o);
  for (const c of candidates) {
    if (isBotDir(c, f)) return { ok: true, botDir: c, source: 'discovered', warning: null, tried: candidates };
  }
  return {
    ok: false,
    botDir: '',
    reason: 'not_found',
    warning: '未找到机器人项目（含 ai_bridge.js 的目录），请在「机器人运行」页手动选择机器人目录',
    tried: candidates,
  };
}

module.exports = { isBotDir, candidateDirs, resolveBotDir };
