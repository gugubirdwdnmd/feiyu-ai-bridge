'use strict';
/**
 * permissionService.js —— 扩展权限声明 / 授权 / 撤销 / 运行时校验（Feiyu 1.4 模块 3）。
 *
 * 最小权限模型：
 *  - 权限目录（PERMISSION_CATALOG）列出所有已知权限：id / label / 风险等级 / 作用范围 / 说明。
 *  - 默认不授予任何权限；高风险权限必须由用户在 UI 显式确认（caller 传 source）。
 *  - 申请 / 授权 / 撤销 / 运行时调用使用同一套规则。
 *  - 运行时校验若未授权，记录「拦截」到调用日志，供权限中心展示（不只是 UI 提示）。
 *
 * 重要边界（如实声明）：本工具无法对第三方扩展代码做真正的操作系统沙箱隔离。
 * 权限模型是「声明 + 授权 + 调用点校验 + 日志审计」的纵深防线，不是进程级沙箱。
 * 标记为 high 的能力（启动进程、网络、读写文件、发送消息/自动化）在 UI 侧必须二次确认。
 *
 * 纯函数 + 依赖注入（fsImpl / now），不依赖 Electron，可单测。
 */
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const STATE_FILE = 'feiyu-extension-permissions.json';
const CALL_LOG_MAX = 500;

const PERMISSION_CATALOG = [
  { id: 'ext.meta.read', label: '读取扩展元数据', risk: 'low', scope: 'none', description: '读取扩展的清单、状态与基本信息' },
  { id: 'file.read.scoped', label: '读取授权范围内的文件', risk: 'medium', scope: 'path', description: '只读访问用户明确授权的目录或文件' },
  { id: 'config.write.scoped', label: '写入授权配置/扩展目录', risk: 'medium', scope: 'path', description: '向用户授权的配置或扩展目录写入' },
  { id: 'network.outbound', label: '访问网络', risk: 'medium', scope: 'url', description: '向远程地址发起网络请求' },
  { id: 'process.spawn', label: '启动外部进程', risk: 'high', scope: 'cmd', description: '以子进程方式启动外部程序（如 MCP 服务器）' },
  { id: 'feiyu.service.call', label: '调用已注册 Feiyu 服务', risk: 'medium', scope: 'service', description: '触发工作流中声明的已注册服务' },
  { id: 'message.send', label: '发送消息/执行自动化', risk: 'high', scope: 'target', description: '代用户发送消息或执行自动化动作（高风险）' },
  { id: 'data.modify.business', label: '修改业务数据', risk: 'high', scope: 'target', description: '修改机器人配置、记忆或其他业务数据（高风险）' },
];

const CATALOG_BY_ID = {};
for (const p of PERMISSION_CATALOG) CATALOG_BY_ID[p.id] = p;

function isObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function nowIso(d) { return (d instanceof Date ? d : new Date()).toISOString(); }

function getCatalog() { return PERMISSION_CATALOG.map((p) => Object.assign({}, p)); }

function knownPermission(id) { return !!CATALOG_BY_ID[id]; }
function riskOf(id) { return CATALOG_BY_ID[id] ? CATALOG_BY_ID[id].risk : 'high'; }

/** 作用域是否匹配：grant.scope 为 '*' 或 exact 匹配。 */
function scopeMatches(grantScope, askedScope) {
  if (grantScope === '*' || grantScope == null) return true;
  if (askedScope == null) return grantScope === '*';
  return grantScope === askedScope;
}

function defaultState() { return { schemaVersion: SCHEMA_VERSION, grants: [], calls: [] }; }

function loadState(file, fsImpl = fs) {
  try {
    const o = JSON.parse(fsImpl.readFileSync(file, 'utf-8'));
    if (!o || typeof o !== 'object') return defaultState();
    return { schemaVersion: SCHEMA_VERSION, grants: Array.isArray(o.grants) ? o.grants : [], calls: Array.isArray(o.calls) ? o.calls : [] };
  } catch (_) { return defaultState(); }
}

function saveState(file, state, fsImpl = fs) {
  const p = file;
  const tmp = p + '.tmp.' + process.pid;
  try {
    fsImpl.mkdirSync(path.dirname(p), { recursive: true });
    fsImpl.writeFileSync(tmp, JSON.stringify({ schemaVersion: SCHEMA_VERSION, grants: state.grants, calls: state.calls }, null, 2), 'utf-8');
    fsImpl.renameSync(tmp, p);
    return { ok: true, path: p };
  } catch (e) {
    try { if (fsImpl.existsSync(tmp)) fsImpl.unlinkSync(tmp); } catch (_) {}
    return { ok: false, error: e.message };
  }
}

/** 授权。返回新 state（不落盘，落盘由调用方决定）。 */
function grant(state, id, scope, source, now = new Date()) {
  if (!knownPermission(id)) return { ok: false, error: '未知权限: ' + id, state };
  const sc = scope || '*';
  const grants = state.grants.filter((g) => !(g.id === id && scopeMatches(g.scope, sc) && (g.scope === sc || sc === '*' || g.scope === '*')));
  grants.push({ id, scope: sc, grantedAt: nowIso(now), source: typeof source === 'string' ? source : 'unknown', risk: riskOf(id) });
  return { ok: true, state: Object.assign({}, state, { grants }) };
}

/** 撤销（按 id；若给 scope 则只撤该作用域）。 */
function revoke(state, id, scope, now = new Date()) {
  const before = state.grants.length;
  const grants = state.grants.filter((g) => {
    if (g.id !== id) return true;
    if (scope == null) return false; // 撤全部
    return !scopeMatches(g.scope, scope);
  });
  const calls = state.calls.concat([{ ts: nowIso(now), id, scope: scope || null, allowed: false, detail: 'revoked' }]).slice(-CALL_LOG_MAX);
  return { ok: before !== grants.length || scope == null, state: Object.assign({}, state, { grants, calls }) };
}

/** 查询是否已授权。 */
function isGranted(state, id, scope) {
  return state.grants.some((g) => g.id === id && scopeMatches(g.scope, scope || '*'));
}

function listGrants(state) {
  return state.grants.map((g) => Object.assign({ label: CATALOG_BY_ID[g.id] ? CATALOG_BY_ID[g.id].label : g.id, risk: g.risk || riskOf(g.id) }, g));
}

/** 运行时校验：未授权则记录拦截。返回 {allowed, reason}（不落盘；调用方决定持久化）。 */
function checkRuntime(state, id, scope, opts = {}) {
  if (!knownPermission(id)) return { allowed: false, reason: '未知权限: ' + id, blocked: true };
  const ok = isGranted(state, id, scope);
  if (!ok) {
    const reason = '未授权权限「' + id + '」' + (scope ? '（作用域 ' + scope + '）' : '') + '，已拦截';
    return { allowed: false, reason, blocked: true };
  }
  return { allowed: true, reason: '已授权', blocked: false };
}

/** 记录一次调用（无论放行/拦截），追加到调用日志。返回新 state。 */
function recordCall(state, id, scope, allowed, detail, now = new Date()) {
  const calls = state.calls.concat([{ ts: nowIso(now), id, scope: scope || null, allowed: !!allowed, detail: typeof detail === 'string' ? detail.slice(0, 500) : '' }]).slice(-CALL_LOG_MAX);
  return Object.assign({}, state, { calls });
}

/** 取拦截记录（仅 allowed=false）。 */
function blockedCalls(state) {
  return state.calls.filter((c) => !c.allowed);
}

module.exports = {
  STATE_FILE, PERMISSION_CATALOG, CALL_LOG_MAX,
  getCatalog, knownPermission, riskOf, scopeMatches,
  defaultState, loadState, saveState,
  grant, revoke, isGranted, listGrants, checkRuntime, recordCall, blockedCalls,
};
