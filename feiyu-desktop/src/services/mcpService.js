'use strict';
/**
 * mcpService.js —— 外部 MCP 导入与权限中心（模块 D）。
 *
 * 核心原则（安全第一）：
 *  1) **解析 → 校验 → 安全审查 → 展示**，任一步失败都不落盘。
 *  2) **绝不执行** MCP 服务器：不 spawn、不联网、不解析后自动信任。
 *     导入后一律 `enabled:false`，由用户在界面显式开启（且仅代表「保存了配置」，
 *     真正由机器人侧消费需另行接入）。
 *  3) 权限中心：为每个服务器推导「它可能需要的能力」（进程/网络/文件/环境变量），
 *     并把高危项（shell 元字符、非 https、疑似密钥 env）显式标红。
 *
 * 支持的导入形态（均为业界常见 MCP 配置）：
 *   { "mcpServers": { "name": { "command":"npx", "args":[...], "env":{...} } } }
 *   { "mcpServers": { "name": { "url":"https://...", "transport":"sse" } } }
 *   { "servers": [ { "name":"x", "command":[...] } ] }
 */
const fs = require('fs');
const path = require('path');

const MCP_FILE = 'feiyu_mcp.json';
const SCHEMA_VERSION = 1;
const TRANSPORTS = ['stdio', 'sse', 'http', 'streamable-http', 'websocket'];
const MAX_SERVERS = 100;
const RISK_ORDER = { low: 0, medium: 1, high: 2 };

const SHELL_META = /[&|<>;`$(){}[\]\\\n\r]/;
const SECRETISH = /(key|token|secret|password|passwd|credential|authorization)/i;

function isObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function clone(o) { try { return JSON.parse(JSON.stringify(o)); } catch (_) { return {}; } }

/** 校验名称：仅字母数字与 - _ . ，1-48 字符。 */
function validName(n) { return typeof n === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(n); }

/**
 * 把 command 归一化为字符串数组。
 * 允许 "npx -y pkg" 这种单字符串形态 —— 但会**标记为需要拆分**，
 * 且拆分结果只作为 argv 使用（绝不拼进 shell）。
 */
function normalizeCommand(cmd) {
  if (Array.isArray(cmd)) {
    if (!cmd.length) return { ok: false, error: 'command 数组为空' };
    if (!cmd.every((x) => typeof x === 'string')) return { ok: false, error: 'command 数组元素必须是字符串' };
    return { ok: true, argv: cmd.slice(), fromString: false };
  }
  if (typeof cmd === 'string') {
    const s = cmd.trim();
    if (!s) return { ok: false, error: 'command 为空字符串' };
    // 按空白拆分（不经过 shell），并记录来源便于界面提示
    return { ok: true, argv: s.split(/\s+/).filter(Boolean), fromString: true };
  }
  return { ok: false, error: 'command 必须是字符串数组或字符串' };
}

/** 单个服务器的安全审查。返回 { risk, findings:[{level, code, message}] } */
function reviewServer(srv) {
  const findings = [];
  const add = (level, code, message) => findings.push({ level, code, message });

  // 只要有 command 或 argv，就按 stdio 子进程路径审查（外部配置可能只给 args/argv）
  const isStdio = srv.transport === 'stdio' || !!srv.command || (Array.isArray(srv.argv) && srv.argv.length > 0);
  if (isStdio) {
    if (!srv.argv || !srv.argv.length) add('high', 'no_command', '声明为 stdio 但没有可执行的 command');
    const joined = (srv.argv || []).join(' ');
    if (SHELL_META.test(joined)) add('high', 'shell_meta', '命令参数含 shell 元字符（& | > < ; ` $() 等），可能试图注入命令');
    const bin = (srv.argv || [])[0] || '';
    if (/^(cmd|cmd\.exe|powershell|powershell\.exe|bash|sh|zsh)$/i.test(bin)) add('high', 'interpreter', '直接调用 shell 解释器（' + bin + '），风险很高');
    if (/\b(rm|del|rmdir|format|mkfs|diskpart|reg\s+delete)\b/i.test(joined)) add('high', 'destructive', '命令含删除/格式化类危险操作');
    add('medium', 'process', '会以子进程方式运行外部程序（stdio 传输）');
  }
  if (srv.url) {
    let u = null;
    try { u = new URL(srv.url); } catch (_) { add('high', 'bad_url', 'url 不是合法地址'); }
    if (u) {
      if (u.protocol !== 'https:') add('high', 'insecure_url', '远程地址不是 https（' + u.protocol + '），可能被中间人篡改');
      if (/^(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])$/.test(u.hostname)) add('low', 'loopback', '指向本机地址（' + u.hostname + '），请确认为你信任的本地服务');
      add('medium', 'network', '会向远程服务发起网络请求');
    }
  }
  if (!srv.url && !srv.command && !(Array.isArray(srv.argv) && srv.argv.length)) {
    add('high', 'no_endpoint', '既没有 command 也没有 url，无法确定如何连接');
  }

  const envKeys = Object.keys(srv.env || {});
  const secretKeys = envKeys.filter((k) => SECRETISH.test(k));
  if (secretKeys.length) add('high', 'secret_env', '环境变量疑含密钥：' + secretKeys.join('、') + '（导入时会保留键名，界面只显示掩码）');
  if (envKeys.length) add('medium', 'env', '会向子进程注入 ' + envKeys.length + ' 个环境变量');

  const risk = findings.reduce((acc, f) => (RISK_ORDER[f.level] > RISK_ORDER[acc] ? f.level : acc), 'low');
  return { risk, findings };
}

/** 推导该服务器「可能需要的权限」（权限中心展示用，不代表已授予）。 */
function permissionModel(srv) {
  const perms = [];
  if (srv.command) perms.push({ id: 'process.spawn', label: '启动子进程', granted: false });
  if (srv.url) perms.push({ id: 'network.outbound', label: '访问远程网络', granted: false });
  const envKeys = Object.keys(srv.env || {});
  if (envKeys.length) perms.push({ id: 'env.inject', label: '注入环境变量（' + envKeys.length + ' 项）', granted: false });
  if (srv.transport === 'stdio') perms.push({ id: 'io.pipe', label: '标准输入输出管道', granted: false });
  return perms;
}

/** 把一处原始定义解析为标准结构。 */
function parseOne(name, raw) {
  const errors = [];
  const srv = { name, transport: 'stdio', command: null, argv: [], url: null, env: {}, args: [] };
  if (!isObject(raw)) return { ok: false, errors: ['服务器定义必须是对象'] };

  const tr = raw.transport || raw.type;
  if (tr != null) {
    if (typeof tr !== 'string' || !TRANSPORTS.includes(tr)) errors.push('transport 必须是 ' + TRANSPORTS.join('/'));
    else srv.transport = tr;
  } else if (raw.url) {
    srv.transport = 'sse';
  }

  if (raw.url != null) {
    if (typeof raw.url !== 'string') errors.push('url 必须是字符串');
    else srv.url = raw.url;
  }
  const cmdSrc = raw.command != null ? raw.command : (Array.isArray(raw.args) && typeof raw.command === 'undefined' ? null : null);
  if (cmdSrc != null) {
    const c = normalizeCommand(cmdSrc);
    if (!c.ok) errors.push(c.error);
    else { srv.command = Array.isArray(cmdSrc) ? cmdSrc[0] : String(cmdSrc).split(/\s+/)[0]; srv.argv = c.argv; srv.fromStringCommand = c.fromString; }
  }
  if (raw.args != null) {
    if (!Array.isArray(raw.args) || !raw.args.every((x) => typeof x === 'string')) errors.push('args 必须是字符串数组');
    else srv.args = raw.args.slice();
  }
  // command 与 args 合并为完整 argv（stdio 实际启动用）
  if (srv.argv.length && srv.args.length) srv.argv = srv.argv.concat(srv.args);
  else if (!srv.argv.length && srv.args.length) srv.argv = srv.args.slice();

  if (raw.env != null) {
    if (!isObject(raw.env)) errors.push('env 必须是对象');
    else {
      for (const k of Object.keys(raw.env)) {
        if (typeof raw.env[k] !== 'string') { errors.push('env.' + k + ' 必须是字符串'); continue; }
        srv.env[k] = raw.env[k];
      }
    }
  }
  return { ok: errors.length === 0, errors, server: srv };
}

/**
 * 解析外部 MCP 配置。返回 { ok, servers:[{...}], errors, warnings, counts }
 * 不写盘、不执行。
 */
function parseConfig(payload) {
  let obj = payload;
  if (typeof payload === 'string') {
    try { obj = JSON.parse(payload); } catch (e) { return { ok: false, servers: [], errors: ['JSON 解析失败: ' + e.message], warnings: [] }; }
  }
  if (!isObject(obj)) return { ok: false, servers: [], errors: ['配置必须是对象'], warnings: [] };

  const errors = [];
  const warnings = [];
  const parsed = [];

  const container = obj.mcpServers || obj.servers || null;
  if (!container) return { ok: false, servers: [], errors: ['未找到 mcpServers 或 servers 字段（不是你支持的 MCP 配置格式）'], warnings: [] };

  let pairs = [];
  if (Array.isArray(container)) {
    for (const item of container) {
      if (!isObject(item) || typeof item.name !== 'string') { errors.push('servers[] 元素必须含 name 字符串'); continue; }
      pairs.push([item.name, item]);
    }
  } else if (isObject(container)) {
    for (const name of Object.keys(container)) pairs.push([name, container[name]]);
  } else {
    return { ok: false, servers: [], errors: ['mcpServers 必须是对象或数组'], warnings: [] };
  }

  if (!pairs.length) errors.push('配置中没有任何 MCP 服务器');
  if (pairs.length > MAX_SERVERS) errors.push('一次最多导入 ' + MAX_SERVERS + ' 个服务器（当前 ' + pairs.length + '）');

  for (const [name, raw] of pairs.slice(0, MAX_SERVERS)) {
    if (!validName(name)) { errors.push('服务器名称非法（仅字母数字 . _ -）: ' + name); continue; }
    const p = parseOne(name, raw);
    if (!p.ok) { for (const e of p.errors) errors.push(name + ': ' + e); continue; }
    const srv = p.server;
    const review = reviewServer(srv);
    const item = {
      name,
      transport: srv.transport,
      command: srv.command,
      argv: srv.argv,
      url: srv.url,
      env: srv.env,
      envKeys: Object.keys(srv.env),
      risk: review.risk,
      findings: review.findings,
      permissions: permissionModel(srv),
      enabled: false,
      executed: false,
      importedAt: null,
    };
    if (srv.fromStringCommand) warnings.push(name + ': command 为单字符串，已按空白拆分为 argv（不经过 shell）');
    if (review.risk === 'high') warnings.push(name + ': 存在高危项，导入后默认禁用，请逐条确认');
    parsed.push(item);
  }
  return {
    ok: errors.length === 0,
    servers: parsed,
    errors,
    warnings,
    counts: {
      total: parsed.length,
      high: parsed.filter((s) => s.risk === 'high').length,
      medium: parsed.filter((s) => s.risk === 'medium').length,
      low: parsed.filter((s) => s.risk === 'low').length,
    },
  };
}

function readRegistry(botDir, fsImpl = fs) {
  try {
    const o = JSON.parse(fsImpl.readFileSync(path.join(botDir, MCP_FILE), 'utf-8'));
    if (!o || typeof o !== 'object') return { version: SCHEMA_VERSION, servers: [] };
    return { version: SCHEMA_VERSION, servers: Array.isArray(o.servers) ? o.servers : [] };
  } catch (_) {
    return { version: SCHEMA_VERSION, servers: [] };
  }
}

function writeRegistry(botDir, data, fsImpl = fs) {
  const p = path.join(botDir, MCP_FILE);
  const tmp = p + '.tmp.' + process.pid;
  try {
    fsImpl.writeFileSync(tmp, JSON.stringify(Object.assign({ version: SCHEMA_VERSION }, data), null, 2));
    fsImpl.renameSync(tmp, p);
    return { ok: true, path: p };
  } catch (e) {
    try { if (fsImpl.existsSync(tmp)) fsImpl.unlinkSync(tmp); } catch (_) {}
    return { ok: false, error: e.message };
  }
}

/**
 * 导入并保存（仍需用户显式点击；落盘后 enabled 一律 false）。
 * @param opts { fsImpl, now, overwrite }
 */
function importConfig(botDir, payload, opts = {}) {
  const fsImpl = opts.fsImpl || fs;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const parsed = parseConfig(payload);
  if (!parsed.ok) return { ok: false, errors: parsed.errors, warnings: parsed.warnings, servers: parsed.servers };
  const reg = readRegistry(botDir, fsImpl);
  const byName = {};
  for (const s of reg.servers) byName[s.name] = s;
  const added = [];
  const replaced = [];
  for (const s of parsed.servers) {
    const rec = Object.assign({}, s, { importedAt: now.toISOString(), enabled: false, executed: false });
    if (byName[s.name] && !opts.overwrite) { replaced.push({ name: s.name, skipped: true }); continue; }
    if (byName[s.name]) { replaced.push({ name: s.name, skipped: false }); }
    byName[s.name] = rec;
    added.push(s.name);
  }
  const next = { version: SCHEMA_VERSION, servers: Object.keys(byName).map((k) => byName[k]) };
  const w = writeRegistry(botDir, next, fsImpl);
  if (!w.ok) return { ok: false, error: w.error };
  return {
    ok: true,
    added,
    replaced,
    counts: parsed.counts,
    warnings: parsed.warnings,
    note: '已保存（全部为禁用状态，不会被执行）。启用前请确认权限项。',
  };
}

/** 启用/禁用 —— 只是登记状态，**不会**启动任何进程。 */
function setEnabled(botDir, name, enabled, { fsImpl = fs } = {}) {
  const reg = readRegistry(botDir, fsImpl);
  const s = reg.servers.find((x) => x.name === name);
  if (!s) return { ok: false, error: '未找到 MCP 服务器: ' + name };
  s.enabled = !!enabled;
  if (enabled) s.enabledAt = new Date().toISOString();
  const w = writeRegistry(botDir, reg, fsImpl);
  if (!w.ok) return { ok: false, error: w.error };
  return { ok: true, name, enabled: !!enabled, note: enabled ? '已标记为启用（仅登记，不代表已运行）' : '已禁用' };
}

function remove(botDir, name, { fsImpl = fs } = {}) {
  const reg = readRegistry(botDir, fsImpl);
  const i = reg.servers.findIndex((x) => x.name === name);
  if (i < 0) return { ok: false, error: '未找到 MCP 服务器: ' + name };
  reg.servers.splice(i, 1);
  const w = writeRegistry(botDir, reg, fsImpl);
  return w.ok ? { ok: true } : { ok: false, error: w.error };
}

/** 列表（env 值掩码，绝不回传明文）。 */
function list(botDir, { fsImpl = fs } = {}) {
  const reg = readRegistry(botDir, fsImpl);
  const servers = reg.servers.map((s) => {
    const envMasked = {};
    for (const k of Object.keys(s.env || {})) {
      const v = String(s.env[k] || '');
      envMasked[k] = v ? (v.length <= 6 ? '******' : v.slice(0, 2) + '******' + v.slice(-2)) : '';
    }
    return Object.assign({}, s, { env: envMasked, envKeys: Object.keys(s.env || {}) });
  });
  return {
    ok: true,
    servers,
    counts: {
      total: servers.length,
      enabled: servers.filter((s) => s.enabled).length,
      high: servers.filter((s) => s.risk === 'high').length,
    },
  };
}

function exportAll(botDir, { fsImpl = fs } = {}) {
  const reg = readRegistry(botDir, fsImpl);
  return {
    ok: true,
    payload: { mcpServers: reg.servers.reduce((acc, s) => {
      const item = {};
      if (s.url) { item.url = s.url; item.transport = s.transport; }
      if (s.argv && s.argv.length) { item.command = s.argv[0]; item.args = s.argv.slice(1); }
      if (s.env && Object.keys(s.env).length) item.env = clone(s.env);
      acc[s.name] = item;
      return acc;
    }, {}) },
    note: '导出的配置含密钥类环境变量明文；请妥善保管',
  };
}

module.exports = {
  MCP_FILE, SCHEMA_VERSION, TRANSPORTS, MAX_SERVERS,
  validName, normalizeCommand, reviewServer, permissionModel, parseOne, parseConfig,
  readRegistry, writeRegistry, importConfig, setEnabled, remove, list, exportAll,
};
