'use strict';
/**
 * dependencyResolver.js —— 扩展依赖 / 兼容性 / 冲突检查（Feiyu 1.4 模块 2）。
 *
 * 纯函数，不依赖 Electron，可单测。
 * 输入：待安装清单 + 现有注册表索引（已安装/已发现的扩展列表）+ 当前 app/api 版本。
 * 输出：缺失依赖、版本范围不满足、id 冲突、依赖环、兼容性不满足。
 *
 * 不改变任何文件；只做「安装前预检」与可解释失败原因。
 */
const { versionSatisfiesRange, validExtId } = require('./extensionManifest');

/**
 * @param manifest 待安装/升级的规范化清单（extensionManifest.validateManifest 结果）。
 * @param index 现有扩展索引数组：[{id, version, type, dependencies:[{id,version}], feiyuCompatibility, apiCompatibility, origin}]
 * @param opts { expectedAppVersion, expectedApiVersion, upgradingId? }
 */
function resolve(manifest, index, opts = {}) {
  const errors = [];
  const warnings = [];
  const missing = [];
  const conflicts = [];
  const incompatible = [];
  const byId = {};
  for (const e of (index || [])) byId[e.id] = e;

  // —— id 冲突：同一 id 已存在且不是本次升级对象 ——
  if (byId[manifest.id] && opts.upgradingId !== manifest.id) {
    const cur = byId[manifest.id];
    conflicts.push({
      code: 'id_conflict',
      id: manifest.id,
      current: cur.version,
      message: '扩展 id「' + manifest.id + '」已存在（当前版本 ' + cur.version + '），请走「升级」而非重复安装',
    });
    errors.push('id 冲突：' + manifest.id + ' 已安装 v' + cur.version);
  }

  // —— 依赖检查 ——
  for (const dep of (manifest.dependencies || [])) {
    const target = byId[dep.id];
    if (!target) { missing.push({ id: dep.id, version: dep.version }); errors.push('缺失依赖: ' + dep.id + '@' + dep.version); continue; }
    if (!versionSatisfiesRange(target.version, dep.version)) {
      errors.push('依赖版本不满足: ' + dep.id + ' 需要 ' + dep.version + '，当前 ' + target.version);
      incompatible.push({ code: 'dep_version', id: dep.id, need: dep.version, have: target.version });
    }
  }

  // —— 依赖环检测（以 manifest 为根，沿 index 可达依赖建图）——
  const graph = {};
  const collect = (m) => {
    const deps = (m && m.dependencies) || [];
    graph[m.id] = deps.map((d) => d.id);
    for (const d of deps) if (byId[d.id] && !graph[d.id]) collect(byId[d.id]);
  };
  collect(manifest);
  const cycle = detectCycle(graph);
  if (cycle) {
    errors.push('依赖存在环: ' + cycle.join(' → '));
    conflicts.push({ code: 'dependency_cycle', message: '依赖环: ' + cycle.join(' → ') });
  }

  // —— 兼容性 ——
  if (manifest.feiyuCompatibility && opts.expectedAppVersion) {
    const r = rangeFromCompat(manifest.feiyuCompatibility);
    if (!versionSatisfiesRange(opts.expectedAppVersion, r)) {
      incompatible.push({ code: 'feiyu_compat', expected: opts.expectedAppVersion, range: r });
      errors.push('与当前 Feiyu 版本不兼容：要求 ' + r + '，当前 ' + opts.expectedAppVersion);
    }
  }
  if (manifest.apiCompatibility && opts.expectedApiVersion) {
    if (!versionSatisfiesRange(opts.expectedApiVersion, '>=' + manifest.apiCompatibility)) {
      incompatible.push({ code: 'api_compat', expected: opts.expectedApiVersion, need: manifest.apiCompatibility });
      errors.push('插件 API 版本不兼容：需要 >= ' + manifest.apiCompatibility + '，当前 ' + opts.expectedApiVersion);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    missing,
    conflicts,
    incompatible,
    satisfiable: errors.length === 0,
  };
}

function rangeFromCompat(c) {
  if (!c) return '*';
  if (c.min && c.max) return '>=' + c.min + ' <=' + c.max;
  if (c.min) return '>=' + c.min;
  if (c.max) return '<=' + c.max;
  return '*';
}

/** 有向图环检测（DFS 三色）。 */
function detectCycle(graph) {
  const color = {};
  for (const k of Object.keys(graph)) color[k] = 0;
  for (const start of Object.keys(graph)) {
    if (color[start] !== 0) continue;
    const stack = [{ id: start, i: 0 }];
    const pathArr = [start];
    color[start] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const ch = graph[top.id] || [];
      if (top.i < ch.length) {
        const nx = ch[top.i++];
        if (color[nx] === 1) return pathArr.slice(pathArr.indexOf(nx)).concat([nx]);
        if (color[nx] === 0) { color[nx] = 1; pathArr.push(nx); stack.push({ id: nx, i: 0 }); }
      } else { color[top.id] = 2; stack.pop(); pathArr.pop(); }
    }
  }
  return null;
}

/** 在完整索引上检测所有扩展之间的 id 重复与依赖环（用于「管理」页整体诊断）。 */
function auditIndex(index) {
  const issues = [];
  const byId = {};
  for (const e of (index || [])) {
    if (byId[e.id]) issues.push({ level: 'error', code: 'duplicate_id', id: e.id, message: '扩展 id 重复: ' + e.id });
    byId[e.id] = e;
  }
  const graph = {};
  for (const e of (index || [])) graph[e.id] = (e.dependencies || []).map((d) => d.id);
  const cycle = detectCycle(graph);
  if (cycle) issues.push({ level: 'error', code: 'dependency_cycle', message: '依赖环: ' + cycle.join(' → ') });
  return { ok: issues.filter((i) => i.level === 'error').length === 0, issues };
}

module.exports = { resolve, auditIndex, detectCycle, validExtId };
