'use strict';
/**
 * extensionRegistry.js —— 统一扩展注册表（Feiyu 1.4 模块 4）。
 *
 * 职责：
 *  - 持久化「由扩展管理器安装」的扩展（origin=installed, owned=true）到 userData。
 *  - 从现有 botDir 配置（feiyu_skills.json / feiyu_mcp.json / feiyu_workflows.json）
 *    发现「已有配置」扩展（origin=discovered, owned=false），以只读方式纳入统一索引，
 *    **绝不移动或删除用户原有文件**。
 *  - 构建供 dependencyResolver 使用的扁平索引。
 *  - 安装目录边界校验：任何 owned 文件的相对路径不得逃出扩展根目录。
 *
 * 边界：安装根目录位于 userData/feiyu-extensions，与 botDir 业务目录清晰分离。
 * 纯函数 + 依赖注入，可单测。
 */
const fs = require('fs');
const path = require('path');
const { normalizeRelPath } = require('./extensionManifest');
const skillService = require('./skillService');
const mcpService = require('./mcpService');
const workflowService = require('./workflowService');

const SCHEMA_VERSION = 1;
const REGISTRY_FILE = 'feiyu-extension-registry.json';
const EXT_ROOT = 'feiyu-extensions';

function isObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function nowIso(d) { return (d instanceof Date ? d : new Date()).toISOString(); }

function defaultRegistry() { return { schemaVersion: SCHEMA_VERSION, extensions: [] }; }

function loadRegistry(file, fsImpl = fs) {
  try {
    const o = JSONImpl(fsImpl).readJSON(file);
    if (!o || typeof o !== 'object') return defaultRegistry();
    return { schemaVersion: SCHEMA_VERSION, extensions: Array.isArray(o.extensions) ? o.extensions : [] };
  } catch (_) { return defaultRegistry(); }
}

function saveRegistry(file, reg, fsImpl = fs) {
  const tmp = file + '.tmp.' + process.pid;
  try {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    fsImpl.writeFileSync(tmp, JSON.stringify({ schemaVersion: SCHEMA_VERSION, extensions: reg.extensions }, null, 2), 'utf-8');
    fsImpl.renameSync(tmp, file);
    return { ok: true, path: file };
  } catch (e) {
    try { if (fsImpl.existsSync(tmp)) fsImpl.unlinkSync(tmp); } catch (_) {}
    return { ok: false, error: e.message };
  }
}

/** 校验安装目录下所有文件路径都在目录根内（防穿越）。 */
function validateOwnedPaths(entry) {
  const bad = [];
  for (const f of (entry.files || [])) {
    const np = normalizeRelPath(f.path);
    if (!np.ok) bad.push(f.path + ': ' + np.error);
  }
  return bad;
}

/** 登记/更新一个 installed 扩展。返回新 registry。 */
function upsert(reg, entry) {
  const bad = validateOwnedPaths(entry);
  if (bad.length) return { ok: false, error: '安装文件路径越界: ' + bad.join('; '), registry: reg };
  const ext = Object.assign({ owned: true, origin: 'installed' }, entry);
  const i = reg.extensions.findIndex((e) => e.id === ext.id);
  if (i >= 0) reg.extensions[i] = ext; else reg.extensions.push(ext);
  return { ok: true, registry: reg, entry: ext };
}

function getEntry(reg, id) { return reg.extensions.find((e) => e.id === id) || null; }

/** 删除 owned 扩展条目（只删注册表里 owned 的记录；磁盘文件删除由 lifecycle 负责）。 */
function removeEntry(reg, id) {
  const e = getEntry(reg, id);
  if (!e) return { ok: false, error: '未找到扩展: ' + id, registry: reg };
  if (e.owned === false) return { ok: false, error: '该扩展为「已有配置」类型，不能由管理器卸载', registry: reg };
  reg.extensions = reg.extensions.filter((x) => x.id !== id);
  return { ok: true, registry: reg };
}

/**
 * 从 botDir 现有配置发现「已有配置」扩展（只读，不写盘）。
 * 经 fsImpl 读取，便于单测；技能校验用纯函数 skillService.validateSkill（不依赖 fs）。
 * @returns [{id, name, version, type, status, owned:false, origin:'discovered', ref:{kind,key}, updatedAt}]
 */
function discover(botDir, fsImpl = fs) {
  const out = [];
  if (!botDir) return out;
  // 技能：直接读 feiyu_skills.json（skillService 不暴露 fsImpl 注入的 list）
  try {
    const raw = fsImpl.readFileSync(path.join(botDir, 'feiyu_skills.json'), 'utf-8');
    const o = JSON.parse(raw);
    for (const s of (o && Array.isArray(o.skills) ? o.skills : [])) {
      const v = skillService.validateSkill(s);
      out.push({
        id: 'legacy:skill:' + (s.id || '?'),
        name: s.name || s.id || '?',
        version: '1.0.0',
        type: 'skill',
        status: s.enabled ? 'enabled' : 'disabled',
        owned: false,
        origin: 'discovered',
        ref: { kind: 'skill', key: s.id },
        updatedAt: s.updatedAt || null,
        valid: v.valid !== false,
      });
    }
  } catch (_) {}
  // MCP
  try {
    const mc = mcpService.list(botDir, { fsImpl });
    for (const s of (mc.servers || [])) {
      out.push({
        id: 'legacy:mcp:' + s.name,
        name: s.name,
        version: '1.0.0',
        type: 'mcp',
        status: s.enabled ? 'enabled' : 'disabled',
        owned: false,
        origin: 'discovered',
        ref: { kind: 'mcp', key: s.name },
        risk: s.risk,
      });
    }
  } catch (_) {}
  // 工作流
  try {
    const wf = workflowService.list(botDir, { fsImpl });
    for (const w of (wf.workflows || [])) {
      out.push({
        id: 'legacy:workflow:' + w.id,
        name: w.name,
        version: '1.0.0',
        type: 'workflow',
        status: 'installed',
        owned: false,
        origin: 'discovered',
        ref: { kind: 'workflow', key: w.id },
        updatedAt: w.updatedAt || null,
      });
    }
  } catch (_) {}
  return out;
}

/**
 * 构建供 dependencyResolver 使用的扁平索引（installed + discovered 合并）。
 * installed 优先展示；discovered 提供类型/版本/依赖占位（依赖默认空）。
 */
function buildIndex(reg, discovered) {
  const byId = {};
  for (const e of (discovered || [])) byId[e.id] = { id: e.id, version: e.version, type: e.type, dependencies: [], feiyuCompatibility: null, apiCompatibility: null, origin: 'discovered' };
  for (const e of reg.extensions) {
    byId[e.id] = {
      id: e.id, version: e.version, type: e.type,
      dependencies: (e.dependencies || []).map((d) => ({ id: d.id, version: d.version })),
      feiyuCompatibility: e.feiyuCompatibility || null,
      apiCompatibility: e.apiCompatibility || null,
      origin: 'installed',
    };
  }
  return Object.keys(byId).map((k) => byId[k]);
}

function listAll(reg, discovered) {
  const installed = reg.extensions.map((e) => Object.assign({}, e));
  const discSet = new Set(installed.map((e) => e.id));
  const disc = (discovered || []).filter((d) => !discSet.has(d.id));
  return installed.concat(disc);
}

/** 小工具：避免直接耦合 fs 实现读取 JSON。 */
function JSONImpl(fsImpl) {
  return {
    readJSON(f) { return JSON.parse(fsImpl.readFileSync(f, 'utf-8')); },
  };
}

module.exports = {
  SCHEMA_VERSION, REGISTRY_FILE, EXT_ROOT,
  defaultRegistry, loadRegistry, saveRegistry,
  validateOwnedPaths, upsert, getEntry, removeEntry,
  discover, buildIndex, listAll,
};
