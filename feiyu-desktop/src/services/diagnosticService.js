'use strict';
/**
 * diagnosticService.js —— 统一日志 / 诊断 / 通知中心（模块 J）。
 *
 * 三件事：
 *  1) 诊断采集：把「环境 + 配置存在性 + 服务状态 + 近期告警」汇总成结构化报告。
 *     **只采集存在性/计数，不采集内容**；所有自由文本一律经 redactText 脱敏。
 *  2) 诊断包导出：生成可粘贴上报的 JSON（默认脱敏 + 不含任何密钥/路径/令牌）。
 *  3) 通知中心：持久化到 `<userData>/feiyu_notifications.json`，环形上限 200 条，
 *     支持已读/未读与按级别过滤。
 *
 * 安全边界：
 *  - 绝不读取 secrets.json 的内容；只判断文件是否存在、字段是否齐全（hasKey）。
 *  - 路径只输出「是否存在 / 是否源码检出」布尔值，不输出绝对路径。
 *  - 导出的诊断包是可复核的纯数据，不含可执行内容。
 */
const fs = require('fs');
const path = require('path');
const { redactText, redactObject } = require('./redact');

const NOTIFY_FILE = 'feiyu_notifications.json';
const NOTIFY_MAX = 200;
const SCHEMA_VERSION = 1;
const LEVELS = ['info', 'warn', 'error', 'success'];

function nowIso(d) { return (d instanceof Date ? d : new Date()).toISOString(); }

/** 安全地取文件 stat：只返回存在性与大小，不读内容。 */
function statOf(p, fsImpl = fs) {
  try {
    const st = fsImpl.statSync(p);
    return { exists: true, bytes: st.size, mtime: st.mtime ? st.mtime.toISOString() : null };
  } catch (_) { return { exists: false, bytes: 0, mtime: null }; }
}

/**
 * 采集诊断信息。
 * @param ctx {
 *   appVersion, electronVersion, nodeVersion, platform, arch, locale,
 *   userDataDir, botDir, isCheckout,
 *   settings: {…},           // 只取非敏感键，且不落值（只报 key 列表）
 *   services: [{id, port, running}],
 *   providerCount, providerApplied,
 *   skillsCount, mcpCount, workflowCount,
 *   logs: [{level, message, at}],
 *   fsImpl, now
 * }
 */
function collectDiagnostics(ctx = {}) {
  const fsImpl = ctx.fsImpl || fs;
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const botDir = ctx.botDir || '';
  const userDataDir = ctx.userDataDir || '';

  const timeline = [];
  const warn = (level, message) => timeline.push({ level, message, at: nowIso(now) });

  const env = {
    appVersion: ctx.appVersion || '',
    electronVersion: ctx.electronVersion || '',
    nodeVersion: ctx.nodeVersion || process.versions.node || '',
    platform: ctx.platform || process.platform,
    arch: ctx.arch || process.arch,
    locale: ctx.locale || '',
    totalMemMB: Math.round((require('os').totalmem ? require('os').totalmem() : 0) / (1024 * 1024)),
    freeMemMB: Math.round((require('os').freemem ? require('os').freemem() : 0) / (1024 * 1024)),
    cpus: (require('os').cpus ? require('os').cpus().length : 0),
  };

  // 配置存在性（不读内容，除 ai_config.json 的键名列表）
  const botDirExists = !!botDir && (() => { try { return fsImpl.existsSync(botDir); } catch (_) { return false; } })();
  const coreFile = botDir ? statOf(path.join(botDir, 'ai_bridge.js'), fsImpl) : { exists: false };
  if (!botDir) warn('warn', '未配置机器人目录');
  else if (!botDirExists) warn('error', '机器人目录不存在');
  else if (!coreFile.exists) warn('warn', '机器人目录缺少 ai_bridge.js');
  if (ctx.isCheckout) warn('warn', '当前机器人目录是源码检出（发布副本）');

  let configKeys = [];
  const cfgStat = botDir ? statOf(path.join(botDir, 'ai_config.json'), fsImpl) : { exists: false };
  if (cfgStat.exists) {
    try {
      const o = JSON.parse(fsImpl.readFileSync(path.join(botDir, 'ai_config.json'), 'utf-8'));
      if (o && typeof o === 'object') configKeys = Object.keys(o);
    } catch (_) { warn('error', 'ai_config.json 无法解析（可能是语法错误）'); }
  } else if (botDirExists) {
    warn('warn', '未找到 ai_config.json（机器人将使用内置默认值）');
  }

  // 秘密文件：只看存在性
  const secretStat = botDir ? statOf(path.join(botDir, 'secrets.json'), fsImpl) : { exists: false };
  const providerSecretStat = botDir ? statOf(path.join(botDir, 'feiyu_provider_secrets.json'), fsImpl) : { exists: false };

  const settingsKeys = ctx.settings && typeof ctx.settings === 'object' ? Object.keys(ctx.settings) : [];
  if (settingsKeys.length) warn('info', '已保存设置项: ' + settingsKeys.join(', '));

  // 服务状态
  const services = Array.isArray(ctx.services) ? ctx.services.map((s) => ({
    id: String(s.id || ''), port: s.port == null ? null : Number(s.port), running: !!s.running,
  })) : [];
  for (const s of services) {
    if (s.running) warn('info', '服务 ' + s.id + ' 运行中（端口 ' + s.port + '）');
  }

  // 统计类
  const counts = {
    providers: Number(ctx.providerCount) || 0,
    skills: Number(ctx.skillsCount) || 0,
    mcp: Number(ctx.mcpCount) || 0,
    workflows: Number(ctx.workflowCount) || 0,
  };
  if (counts.providers === 0) warn('warn', '尚未配置任何大模型 Provider');
  if (counts.mcp > 0) warn('info', '已导入 ' + counts.mcp + ' 个 MCP 服务器（均需显式启用）');

  const recentAlerts = Array.isArray(ctx.logs) ? ctx.logs.slice(-50).map((l) => ({
    level: LEVELS.includes(l.level) ? l.level : 'info',
    message: redactText(String(l.message || '')),
    at: l.at || null,
  })) : [];

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: nowIso(now),
    env,
    paths: {
      botDirConfigured: !!botDir,
      botDirExists,
      botCorePresent: !!coreFile.exists,
      isSourceCheckout: !!ctx.isCheckout,
      userDataPresent: !!userDataDir && (() => { try { return fsImpl.existsSync(userDataDir); } catch (_) { return false; } })(),
    },
    config: { keys: configKeys, bytes: cfgStat.bytes },
    secrets: {
      botSecretsPresent: !!secretStat.exists,
      providerSecretsPresent: !!providerSecretStat.exists,
      note: '仅统计存在性；内容从未被读取',
    },
    services,
    counts,
    timeline,
    recentAlerts,
    redacted: true,
  };
}

/**
 * 生成可上报的诊断包（纯 JSON 字符串，已脱敏）。
 */
function buildBundle(diag, { pretty = true } = {}) {
  const safe = redactObject(diag || {});
  const bundle = {
    kind: 'feiyu-desktop-diagnostic',
    schemaVersion: SCHEMA_VERSION,
    generatedAt: (diag && diag.generatedAt) || nowIso(),
    note: '本文件为脱敏诊断包：不含密钥、令牌、完整路径或配置内容。',
    diagnostics: safe,
  };
  return pretty ? JSON.stringify(bundle, null, 2) : JSON.stringify(bundle);
}

// ---------------- 通知中心 ----------------

function notifyPath(userDataDir) { return path.join(userDataDir, NOTIFY_FILE); }

function readNotifications(userDataDir, fsImpl = fs) {
  try {
    const o = JSON.parse(fsImpl.readFileSync(notifyPath(userDataDir), 'utf-8'));
    const list = o && Array.isArray(o.items) ? o.items : [];
    return { version: SCHEMA_VERSION, items: list };
  } catch (_) { return { version: SCHEMA_VERSION, items: [] }; }
}

function writeNotifications(userDataDir, data, fsImpl = fs) {
  const p = notifyPath(userDataDir);
  const tmp = p + '.tmp.' + process.pid;
  try {
    fsImpl.mkdirSync(userDataDir, { recursive: true });
    fsImpl.writeFileSync(tmp, JSON.stringify({ version: SCHEMA_VERSION, items: data.items }, null, 2));
    fsImpl.renameSync(tmp, p);
    return { ok: true };
  } catch (e) {
    try { if (fsImpl.existsSync(tmp)) fsImpl.unlinkSync(tmp); } catch (_) {}
    return { ok: false, error: e.message };
  }
}

/**
 * 追加一条通知。
 * @param n { title, message, level, source }
 */
function pushNotification(userDataDir, n, { fsImpl = fs, now = new Date(), max = NOTIFY_MAX } = {}) {
  if (!n || typeof n !== 'object') return { ok: false, error: '通知必须是对象' };
  const level = LEVELS.includes(n.level) ? n.level : 'info';
  const item = {
    id: 'n-' + (now instanceof Date ? now.getTime() : Date.now()) + '-' + Math.random().toString(36).slice(2, 8),
    title: redactText(String(n.title || '')).slice(0, 120),
    message: redactText(String(n.message || '')).slice(0, 2000),
    level,
    source: String(n.source || 'system').slice(0, 40),
    read: false,
    at: nowIso(now),
  };
  const data = readNotifications(userDataDir, fsImpl);
  data.items.unshift(item);
  if (data.items.length > max) data.items = data.items.slice(0, max);
  const w = writeNotifications(userDataDir, data, fsImpl);
  if (!w.ok) return { ok: false, error: w.error };
  return { ok: true, item, unread: data.items.filter((x) => !x.read).length };
}

function listNotifications(userDataDir, { fsImpl = fs, level = null, unreadOnly = false, limit = 50 } = {}) {
  const data = readNotifications(userDataDir, fsImpl);
  let items = data.items;
  if (level && LEVELS.includes(level)) items = items.filter((x) => x.level === level);
  if (unreadOnly) items = items.filter((x) => !x.read);
  const total = data.items.length;
  const unread = data.items.filter((x) => !x.read).length;
  return { ok: true, items: items.slice(0, Math.max(1, Math.min(200, Number(limit) || 50))), total, unread };
}

function markRead(userDataDir, id, { fsImpl = fs } = {}) {
  const data = readNotifications(userDataDir, fsImpl);
  const it = id === 'all' ? null : data.items.find((x) => x.id === id);
  if (id === 'all') { for (const x of data.items) x.read = true; }
  else if (!it) return { ok: false, error: '未找到通知: ' + id };
  else it.read = true;
  const w = writeNotifications(userDataDir, data, fsImpl);
  if (!w.ok) return { ok: false, error: w.error };
  return { ok: true, unread: data.items.filter((x) => !x.read).length };
}

function clearNotifications(userDataDir, { fsImpl = fs } = {}) {
  return writeNotifications(userDataDir, { items: [] }, fsImpl);
}

module.exports = {
  NOTIFY_FILE, NOTIFY_MAX, SCHEMA_VERSION, LEVELS,
  statOf, collectDiagnostics, buildBundle,
  notifyPath, readNotifications, writeNotifications, pushNotification,
  listNotifications, markRead, clearNotifications,
};
