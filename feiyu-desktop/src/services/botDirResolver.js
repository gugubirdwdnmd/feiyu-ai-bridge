'use strict';
/**
 * botDirResolver.js —— 机器人项目目录（botDir）的定位与判定（纯逻辑，可单测）。
 *
 * 背景：安装版 / 便携版里 app.getAppPath() 指向 app.asar 内部，
 * 在其中永远找不到 ai_bridge.js —— 只有开发期（仓库根）才碰巧能命中。
 *
 * 本轮修复（P1）：原实现把 'NapCat_publish' 硬编码进候选路径，
 * 导致安装版自动定位到**发布副本**（源码检出）而非用户真正的工作目录，
 * 且便携版反而定位失败。现改为：
 *   1) 候选路径**全部由 appPath/execPath/home 推导**，不含任何硬编码目录名；
 *   2) 新增「源码检出识别」：含 .git 或 feiyu-desktop/ 的目录是**发布副本**，
 *      自动发现时**排除**，用户显式指定时**仍允许**（用户可能有正当理由）；
 *   3) 自动发现增加「exe 祖先目录的兄弟目录扫描」—— 真实工作目录通常与
 *      安装目录同级或相邻（如 D:\NapCat 与 D:\feiyu\... 同盘根），
 *      这是通用的，不依赖任何具体盘符或目录名；
 *   4) 找不到时返回结构化原因，由界面提示用户手动选择（不得静默失败）。
 *
 * 约束：
 *  - 绝不硬编码盘符或开发机路径。
 *  - 不自动创建、覆盖或清理任何候选目录（只读探测）。
 */
const fs = require('fs');
const path = require('path');

/** 目录是否是机器人项目根（含 ai_bridge.js）。 */
function isBotDir(p, fsImpl) {
  const f = fsImpl || fs;
  try { return !!p && f.existsSync(path.join(p, 'ai_bridge.js')); } catch (_) { return false; }
}

/**
 * 目录是否是「源码检出 / 发布副本」（而非用户真正的工作目录）。
 * 判据（任一命中即视为副本）：
 *   - 含 .git 目录（Git 工作树）
 *   - 含 feiyu-desktop/ 目录（桌面端源码树）
 *
 * 注意：这**不是**「目录无效」的判据 —— 用户显式指定时依然接受，
 * 只是自动发现时优先跳过，避免把发布副本误当工作目录。
 */
function isSourceCheckout(p, fsImpl) {
  const f = fsImpl || fs;
  if (!p) return false;
  try {
    if (f.existsSync(path.join(p, '.git'))) return true;
    if (f.existsSync(path.join(p, 'feiyu-desktop'))) return true;
  } catch (_) {}
  return false;
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
  }
  if (o.home) {                                        // 5) 用户主目录
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
 * 扫描「exe 所在目录的祖先目录」的兄弟目录，寻找机器人工作目录。
 *
 * 通用做法（不含任何硬编码路径）：从 exe 目录向上最多 3 级，
 * 每一级的**同级目录**都试一次。真实部署常见形态：
 *   D:\feiyu\feiyu-desktop-control-center\app.exe   ← 安装目录
 *   D:\NapCat\ai_bridge.js                          ← 工作目录（同盘根，兄弟）
 *   D:\Tools\feiyu\app.exe  →  D:\Tools\NapCat\      ← 同级
 *
 * 只读探测，绝不创建/修改任何目录。
 */
function siblingCandidates(execPath, fsImpl, maxDepth = 3) {
  const f = fsImpl || fs;
  if (!execPath) return [];
  let dir;
  try { dir = path.dirname(path.resolve(execPath)); } catch (_) { return []; }
  const out = [];
  const seen = new Set();
  let depth = 0;
  while (dir && depth < maxDepth) {
    let entries = [];
    try { entries = f.readdirSync(dir); } catch (_) { entries = []; }
    for (const name of entries) {
      let full;
      try { full = path.join(dir, name); } catch (_) { continue; }
      let st = null;
      try { st = f.statSync(full); } catch (_) { continue; }
      if (!st || !st.isDirectory()) continue;
      const key = path.resolve(full);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(full);
    }
    const parent = path.dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
    depth++;
  }
  return out;
}

/**
 * 解析 botDir。
 * 返回 {ok, botDir, reason, warning, source, isCheckout, tried}
 *  - ok:true  → botDir 为有效机器人项目根
 *  - ok:false → botDir 为空，reason 说明原因（界面据此提示用户手动选择）
 *
 * isCheckout=true 表示命中的是「源码检出 / 发布副本」——
 * 自动发现时会跳过并继续找下一个；用户显式指定时不跳过，
 * 但会把 isCheckout 告知调用方，由界面提示「这是发布副本，确认这是你要的工作目录吗」。
 */
function resolveBotDir(o) {
  o = o || {};
  const f = o.fsImpl || fs;
  // 1) 用户设置优先：即使目录里已无 ai_bridge.js，也按「用户显式指定」处理
  //    （但会记录警告，让界面知道核心文件缺失）
  if (o.botDir) {
    const exists = (() => { try { return f.existsSync(o.botDir); } catch (_) { return false; } })();
    if (exists) {
      const checkout = isSourceCheckout(o.botDir, f);
      if (isBotDir(o.botDir, f)) {
        return {
          ok: true, botDir: o.botDir, source: 'settings', isCheckout: checkout, warning: null,
          note: checkout ? '所选目录是源码检出（发布副本）：机器人会读写其配置与数据，建议改用实际运行的工作目录' : null,
        };
      }
      return {
        ok: true, botDir: o.botDir, source: 'settings', isCheckout: checkout,
        warning: '所选目录未找到 ai_bridge.js，机器人功能可能不可用', note: null,
      };
    }
    return { ok: false, botDir: '', reason: 'settings_dir_missing', warning: '设置中的机器人目录已不存在，请重新选择', tried: [o.botDir], isCheckout: false, source: 'settings' };
  }

  const candidates = candidateDirs(o);
  const tried = candidates.slice();
  // 2) 直接候选（打包内 bot/、开发期仓库根、exe 相对、home/bot）
  for (const c of candidates) {
    if (!isBotDir(c, f)) continue;
    if (isSourceCheckout(c, f)) {
      // 发布副本：记录并跳过，继续找真正的工作目录
      tried.push(c);
      continue;
    }
    return { ok: true, botDir: c, source: 'discovered', isCheckout: false, warning: null, tried };
  }
  // 3) exe 祖先目录的兄弟目录扫描（通用，不依赖硬编码路径）
  const siblings = siblingCandidates(o.execPath, f);
  for (const c of siblings) {
    tried.push(c);
    if (!isBotDir(c, f)) continue;
    if (isSourceCheckout(c, f)) continue;   // 发布副本同样跳过
    return { ok: true, botDir: c, source: 'discovered_sibling', isCheckout: false, warning: null, tried };
  }
  return {
    ok: false,
    botDir: '',
    reason: 'not_found',
    warning: '未找到机器人项目（含 ai_bridge.js 的目录），请在「机器人运行」页手动选择机器人目录',
    tried,
    isCheckout: false,
    source: 'none',
  };
}

module.exports = { isBotDir, isSourceCheckout, candidateDirs, siblingCandidates, resolveBotDir };
