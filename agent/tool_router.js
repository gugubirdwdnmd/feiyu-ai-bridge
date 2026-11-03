'use strict';
// ================= V14-A：Tool Registry / Router =================
// 硬性规则（对应需求第四、五条）：
//   ① Tool 只能来自固定 Registry，禁止动态创建；
//   ② 模型给的高危工具名（shell/cmd/powershell/...）直接拒绝；
//   ③ 执行前必须经过：存在性 → Schema → 权限 → 安全 四道检查；
//   ④ V14 第一版只允许 SAFE / LIMITED，SENSITIVE 一律不注册、不执行。

const PERMISSION = { SAFE: 'SAFE', LIMITED: 'LIMITED', SENSITIVE: 'SENSITIVE' };
const ALLOWED_PERMISSIONS = [PERMISSION.SAFE, PERMISSION.LIMITED];   // V14 第一版

// 高危工具名黑名单：命中即 TOOL_REJECTED（无论是否注册过）
const FORBIDDEN_TOOLS = new Set([
  'execute_shell', 'shell', 'run_command', 'command', 'cmd', 'powershell', 'pwsh',
  'bash', 'sh', 'zsh', 'terminal', 'exec', 'eval', 'spawn', 'child_process',
  'open_program', 'start_program', 'launch_app', 'run_program', 'process',
  'delete_file', 'remove_file', 'rm_file', 'move_file', 'copy_file',
  'file_delete', 'file_remove', 'file_move', 'file_copy', 'rmdir', 'unlink',
  'write_file', 'edit_file', 'append_file',
  'keyboard', 'mouse', 'desktop', 'click', 'type_text', 'screenshot',
  'screen_record', 'camera', 'microphone', 'mic',
  'registry', 'regedit', 'system', 'system_setting', 'set_env',
  'kill_process', 'taskkill', 'sudo', 'admin', 'runas',
]);

const registry = new Map();   // name -> tool

function isForbidden(name) {
  return FORBIDDEN_TOOLS.has(String(name || '').toLowerCase());
}

function typeOK(spec, v) {
  const t = spec && spec.type;
  if (t === 'string') return typeof v === 'string';
  if (t === 'number') return typeof v === 'number' && !isNaN(v);
  if (t === 'boolean') return typeof v === 'boolean';
  if (t === 'array') return Array.isArray(v);
  if (t === 'object') return v && typeof v === 'object' && !Array.isArray(v);
  return true;
}

/**
 * 注册一个工具。缺字段会补全默认值；SENSITIVE 在 V14 第一版直接拒绝注册。
 */
function registerTool(def) {
  if (!def || !def.name) return { ok: false, error: 'tool 缺少 name' };
  const name = String(def.name);
  if (isForbidden(name)) return { ok: false, error: '高危工具名，拒绝注册：' + name };
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(name)) return { ok: false, error: '工具名不合法：' + name };

  const permission = def.permission || PERMISSION.SAFE;
  if (permission === PERMISSION.SENSITIVE) {
    return { ok: false, error: 'V14 第一版不允许 SENSITIVE 工具：' + name };
  }
  if (ALLOWED_PERMISSIONS.indexOf(permission) < 0) {
    return { ok: false, error: '未知权限等级：' + permission };
  }
  if (typeof def.handler !== 'function') {
    return { ok: false, error: '工具必须提供 handler：' + name };
  }

  const tool = {
    name,
    description: String(def.description || ''),
    inputSchema: def.inputSchema || { type: 'object', properties: {}, required: [] },
    permission,
    timeout: Number(def.timeout) > 0 ? Number(def.timeout) : 15000,
    tokenCost: Number(def.tokenCost) >= 0 ? Number(def.tokenCost) : 0,
    riskLevel: def.riskLevel || 'low',
    enabled: def.enabled !== false,
    handler: def.handler,
    safety: typeof def.safety === 'function' ? def.safety : null,
  };
  registry.set(name, tool);
  return { ok: true, name };
}

function unregisterTool(name) {
  return registry.delete(String(name || ''));
}

function getTool(name) {
  return registry.get(String(name || '')) || null;
}

function hasTool(name) {
  const t = getTool(name);
  return !!(t && t.enabled);
}

function listTools(opts) {
  const o = opts || {};
  const out = [];
  for (const t of registry.values()) {
    if (o.enabledOnly !== false && !t.enabled) continue;
    if (o.permission && t.permission !== o.permission) continue;
    out.push({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      permission: t.permission,
      timeout: t.timeout,
      tokenCost: t.tokenCost,
      riskLevel: t.riskLevel,
      enabled: t.enabled,
    });
  }
  return out;
}

function setEnabled(name, on) {
  const t = getTool(name);
  if (!t) return false;
  t.enabled = !!on;
  return true;
}

// —— Schema 校验（严格：类型、必填、长度、未知字段）——
function validateArgs(tool, args) {
  const schema = tool.inputSchema || { type: 'object', properties: {}, required: [] };
  if (schema.type !== 'object') return { ok: true, value: args };
  if (args == null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: 'arguments 必须是对象' };
  }
  const props = schema.properties || {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  for (const k of required) {
    if (!(k in args)) return { ok: false, error: '缺少必填参数：' + k };
  }
  for (const k of Object.keys(args)) {
    const spec = props[k];
    if (!spec) {
      if (schema.additionalProperties === false) return { ok: false, error: '未知参数：' + k };
      continue;
    }
    const v = args[k];
    if (!typeOK(spec, v)) return { ok: false, error: '参数 ' + k + ' 类型应为 ' + spec.type };
    if (spec.type === 'string') {
      if (spec.minLength != null && String(v).length < spec.minLength) return { ok: false, error: '参数 ' + k + ' 太短' };
      if (spec.maxLength != null && String(v).length > spec.maxLength) return { ok: false, error: '参数 ' + k + ' 太长' };
    }
    if (spec.type === 'number') {
      if (spec.minimum != null && Number(v) < spec.minimum) return { ok: false, error: '参数 ' + k + ' 小于下限' };
      if (spec.maximum != null && Number(v) > spec.maximum) return { ok: false, error: '参数 ' + k + ' 超过上限' };
    }
    if (Array.isArray(spec.enum) && spec.enum.indexOf(v) < 0) return { ok: false, error: '参数 ' + k + ' 不在允许取值内' };
  }
  // 去掉多余字段，避免把脏数据带进 handler
  const clean = {};
  for (const k of Object.keys(props)) if (k in args) clean[k] = args[k];
  if (schema.additionalProperties !== false) {
    for (const k of Object.keys(args)) if (!(k in clean)) clean[k] = args[k];
  }
  return { ok: true, value: clean };
}

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ __timeout: true });
    }, ms);
    Promise.resolve(promise).then(
      (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); },
      (e) => { if (done) return; done = true; clearTimeout(timer); resolve({ __error: e }); }
    );
  });
}

/**
 * 统一执行入口：存在性 → 黑名单 → Schema → 权限 → 安全 → 执行 → 超时
 * @returns {Promise<{ok:boolean, tool:string, result:*, error:string, rejected:boolean, reason:string, ms:number}>}
 */
async function execute(name, args, ctx) {
  const started = Date.now();
  const raw = String(name || '');
  const base = { tool: raw, ok: false, result: null, error: '', rejected: true, reason: '', ms: 0 };

  if (!raw) return Object.assign(base, { error: '工具名为空', reason: 'empty-name', ms: Date.now() - started });
  if (isForbidden(raw)) {
    return Object.assign(base, { error: '高危工具，已拒绝', reason: 'forbidden-tool', ms: Date.now() - started });
  }

  const tool = getTool(raw);
  if (!tool) {
    return Object.assign(base, { error: '工具未注册：' + raw, reason: 'not-registered', ms: Date.now() - started });
  }
  if (!tool.enabled) {
    return Object.assign(base, { error: '工具未启用：' + raw, reason: 'disabled', ms: Date.now() - started });
  }
  if (ALLOWED_PERMISSIONS.indexOf(tool.permission) < 0) {
    return Object.assign(base, { error: '权限等级不允许：' + tool.permission, reason: 'permission-denied', ms: Date.now() - started });
  }

  const v = validateArgs(tool, args);
  if (!v.ok) {
    return Object.assign(base, { error: v.error, reason: 'schema-invalid', ms: Date.now() - started });
  }

  if (tool.safety) {
    let safe;
    try { safe = tool.safety(v.value, ctx || {}); } catch (e) { safe = { ok: false, error: '安全检查异常' }; }
    if (safe && safe.ok === false) {
      return Object.assign(base, { error: safe.error || '安全检查未通过', reason: 'safety-blocked', ms: Date.now() - started });
    }
  }

  let out;
  try {
    out = await withTimeout(tool.handler(v.value, ctx || {}), tool.timeout);
  } catch (e) {
    out = { __error: e };
  }
  const ms = Date.now() - started;

  if (out && out.__timeout) {
    return Object.assign(base, { error: '工具超时（' + tool.timeout + 'ms）', reason: 'timeout', ms });
  }
  if (out && out.__error) {
    return Object.assign(base, { error: String(out.__error.message || out.__error), reason: 'handler-error', ms });
  }
  return { ok: true, tool: raw, result: out, error: '', rejected: false, reason: 'ok', ms };
}

function reset() {
  registry.clear();
}

module.exports = {
  PERMISSION, ALLOWED_PERMISSIONS, FORBIDDEN_TOOLS,
  registerTool, unregisterTool, getTool, hasTool, listTools, setEnabled,
  validateArgs, execute, isForbidden, reset,
};
