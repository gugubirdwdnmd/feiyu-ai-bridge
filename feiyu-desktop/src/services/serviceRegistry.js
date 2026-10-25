'use strict';
/**
 * serviceRegistry.js —— 统一服务编排（模块 B）。
 *
 * 职责：
 *  1) 服务注册表：内置服务（bridge / napcat / comfyui）+ 用户自定义服务，
 *     持久化到 botDir/feiyu_services.json；内置服务只读、不可删。
 *  2) 预设组合：一键启动多服务（如「QQ 机器人完整启动」= napcat + bridge）。
 *  3) 依赖与端口安全：启动前检测依赖环、端口冲突，并给出拓扑启动顺序。
 *  4) 启动描述：只产出「如何启动」的纯描述（describeStart），真正拉起进程由
 *     处理器用 processService / 通用 spawn 完成 —— 本模块不自己 spawn，便于单测。
 *
 * 安全边界：
 *  - 不执行任何 shell 命令、不拼接用户命令字符串；command 只能是字符串数组。
 *  - 端口冲突 / 依赖环在启动前阻断，绝不静默重复监听或死循环。
 *  - 文件路径全部由注入的 botDir 推导，不硬编码盘符。
 *
 * 依赖注入：生产用默认 fs；测试注入 mock（fs / 内存）。纯图算法 detectCycles /
 * detectPortConflicts / topoOrder 不依赖 fs，可直接单测。
 */
const fs = require('fs');
const path = require('path');

const REGISTRY_FILE = 'feiyu_services.json';
const SCHEMA_VERSION = 1;

/**
 * 内置服务定义（只读，不落盘）。
 * 仅声明「已知服务」的元信息；实际启动逻辑由处理器按 type 分发。
 */
const BUILTIN_SERVICES = [
  { id: 'bridge', name: 'AI 桥 (ai_bridge.js)', type: 'bridge', command: ['ai_bridge.js'], port: 3001, builtin: true, description: '肥鱼 AI 桥主进程' },
  { id: 'napcat', name: 'NapCat 网关', type: 'napcat', command: ['index.js'], port: 3000, builtin: true, description: 'OneBot / QQ 网关' },
  { id: 'comfyui', name: 'ComfyUI', type: 'comfyui', command: ['main.py'], port: 8188, builtin: true, description: 'ComfyUI 生图服务' },
];

const DEFAULT_PRESETS = [
  { id: 'minimal', name: '最小启动（仅 AI 桥）', services: ['bridge'] },
  { id: 'qq-bot', name: 'QQ 机器人完整启动', services: ['napcat', 'bridge'] },
  { id: 'comfy-stack', name: '生图栈（QQ + AI 桥 + ComfyUI）', services: ['napcat', 'bridge', 'comfyui'] },
];

function clone(o) { try { return JSON.parse(JSON.stringify(o)); } catch (_) { return {}; } }

/** 校验用户自定义服务定义。内置服务的 id 也受此约束。 */
function validateServiceDef(s) {
  const errors = [];
  if (!s || typeof s !== 'object') return { valid: false, errors: ['服务定义必须是对象'] };
  if (typeof s.id !== 'string' || !s.id) errors.push('id 必须是非空字符串');
  else if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(s.id)) errors.push('id 仅允许字母数字、-、_，长度 1-32，且不能以 -/_ 开头');
  if (typeof s.name !== 'string' || !s.name.trim()) errors.push('name 必须是非空字符串');
  if (s.port != null && !(Number.isInteger(s.port) && s.port > 0 && s.port < 65536)) errors.push('port 必须是 1-65535 的整数');
  if (s.command != null && !Array.isArray(s.command)) errors.push('command 必须是数组（字符串列表，禁止拼接 shell）');
  if (s.dependsOn != null && !Array.isArray(s.dependsOn)) errors.push('dependsOn 必须是数组');
  if (s.dependsOn != null) {
    for (const d of s.dependsOn) {
      if (typeof d !== 'string') { errors.push('dependsOn 元素必须是字符串'); break; }
      if (d === s.id) errors.push('服务不能依赖自身: ' + s.id);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * 检测依赖环（迭代式 DFS，避免深递归爆栈）。
 * @returns { hasCycle:boolean, cycle:string[]|null }
 */
function detectCycles(services) {
  const deps = {};
  const ids = [];
  for (const s of services) {
    if (!s || typeof s.id !== 'string') continue;
    ids.push(s.id);
    deps[s.id] = Array.isArray(s.dependsOn) ? s.dependsOn.filter((d) => d !== s.id) : [];
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = {};
  for (const id of ids) color[id] = WHITE;
  for (const start of ids) {
    if (color[start] !== WHITE) continue;
    const stack = [{ id: start, i: 0 }];
    color[start] = GRAY;
    let path = [start];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const children = deps[top.id] || [];
      if (top.i < children.length) {
        const nx = children[top.i++];
        // 依赖了不存在的服务：忽略（planPresetPure 会在 missing 中报告）。
        // 注意必须用 `in` 判断，不能写 `if (!color[nx])` —— WHITE 的值是 0，
        // 是假值，那样会把所有**未访问**的节点当成不存在而跳过，导致漏掉环。
        if (!(nx in color)) continue;
        if (color[nx] === GRAY) {
          const idx = path.indexOf(nx);
          return { hasCycle: true, cycle: path.slice(idx).concat([nx]) };
        }
        if (color[nx] === WHITE) {
          color[nx] = GRAY;
          path.push(nx);
          stack.push({ id: nx, i: 0 });
        }
      } else {
        color[top.id] = BLACK;
        stack.pop();
        path = path.slice(0, -1);
      }
    }
  }
  return { hasCycle: false, cycle: null };
}

/** 检测端口冲突：同一端口被多个服务声明。 */
function detectPortConflicts(services) {
  const map = {};
  for (const s of services) {
    if (s && s.port != null) {
      const key = String(s.port);
      (map[key] = map[key] || []).push(s.id);
    }
  }
  const out = [];
  for (const p of Object.keys(map)) {
    if (map[p].length > 1) out.push({ port: Number(p), services: map[p].slice() });
  }
  return out;
}

/**
 * 拓扑排序，得到**启动顺序**（被依赖的服务排在前面）。
 *
 * 图的方向必须按「依赖 → 依赖者」建：节点的入度 = 它依赖的服务数量，
 * 入度为 0 的（没有依赖）先起；某服务起完后，把它从「依赖者」的待办里扣掉。
 *
 * 注意：不能用「按依赖者建图再反转结果」的做法 —— 那样会把**毫无依赖关系**的
 * 服务顺序也整体颠倒（内置预设 qq-bot 的 napcat/bridge 会被无故交换）。
 * @returns { ok:boolean, order:string[], cycle:string[]|null }
 */
function topoOrder(services) {
  const ids = [];
  const idSet = new Set();
  for (const s of services) {
    if (!s || typeof s.id !== 'string') continue;
    if (idSet.has(s.id)) continue;
    ids.push(s.id); idSet.add(s.id);
  }
  const deps = {};       // id -> 它依赖的（仅限集合内的）
  const dependents = {}; // dep -> 依赖它的
  for (const id of ids) { deps[id] = []; dependents[id] = []; }
  for (const s of services) {
    if (!s || typeof s.id !== 'string' || !idSet.has(s.id)) continue;
    for (const d of (Array.isArray(s.dependsOn) ? s.dependsOn : [])) {
      if (!idSet.has(d) || d === s.id) continue;
      if (deps[s.id].includes(d)) continue;
      deps[s.id].push(d);
      dependents[d].push(s.id);
    }
  }
  const indeg = {};
  for (const id of ids) indeg[id] = deps[id].length;
  const q = ids.filter((id) => indeg[id] === 0);
  const order = [];
  while (q.length) {
    const id = q.shift();
    order.push(id);
    for (const m of dependents[id]) {
      indeg[m]--;
      if (indeg[m] === 0) q.push(m);
    }
  }
  if (order.length !== ids.length) {
    const c = detectCycles(services);
    return { ok: false, order, cycle: c.cycle };
  }
  return { ok: true, order, cycle: null };
}

/**
 * 纯函数版预设启动计划（不依赖 fs，便于单测）。
 * @param preset {id, services:[]}
 * @param allServices 服务定义数组（含内置 + 用户），每项有 id/dependsOn/port
 */
function planPresetPure(preset, allServices) {
  if (!preset || !Array.isArray(preset.services)) return { ok: false, error: '预设格式错误' };
  const byId = {};
  for (const s of (allServices || [])) if (s && s.id) byId[s.id] = s;
  const chosen = preset.services.filter((id) => byId[id]).map((id) => byId[id]);
  const missing = preset.services.filter((id) => !byId[id]);
  const cycles = detectCycles(chosen);
  const ports = detectPortConflicts(chosen);
  const order = topoOrder(chosen);
  const warnings = [];
  for (const m of missing) warnings.push('预设引用了未注册的服务: ' + m);
  if (ports.length) warnings.push('存在端口冲突: ' + ports.map((p) => '端口' + p.port + '(' + p.services.join('/') + ')').join('、'));
  if (cycles.hasCycle) warnings.push('存在依赖环: ' + (cycles.cycle || []).join(' → '));
  return {
    ok: true,
    presetId: preset.id,
    services: chosen,
    missing,
    hasCycle: cycles.hasCycle,
    cycle: cycles.cycle,
    portConflicts: ports,
    order: order.order,
    orderOk: order.ok,
    warnings,
  };
}

/**
 * 纯函数：给出一个服务的「启动描述」。处理器据此拉起进程（不在此 spawn）。
 *  - napcat：需要账号/密码 MD5 注入环境变量（不返回明文密码）。
 *  - bridge：node ai_bridge.js
 *  - 通用：给定 command 数组（绝不允许字符串拼接到 shell）。
 */
function describeStart(service, opts = {}) {
  if (!service || typeof service !== 'object') return { ok: false, error: '服务定义缺失' };
  const out = { ok: true, id: service.id, type: service.type || 'generic', name: service.name || service.id, port: service.port || null, command: null, env: {}, cwdRelative: false };
  switch (service.type) {
    case 'bridge':
      out.command = ['ai_bridge.js'];
      break;
    case 'napcat':
      out.command = ['index.js'];
      // QR 模式无需账号；账号模式需账号 + 密码 MD5（值由调用方传入，此处只放键名占位，绝不内联明文）
      if (opts.account) {
        out.env = { NAPCAT_QUICK_ACCOUNT: String(opts.account), NAPCAT_QUICK_PASSWORD_MD5: opts.passwordMd5 != null ? String(opts.passwordMd5) : '' };
      } else {
        out.env = {};
      }
      break;
    case 'comfyui':
      out.command = Array.isArray(service.command) && service.command.length ? service.command.slice() : ['main.py'];
      out.cwdRelative = true;
      break;
    default:
      if (!Array.isArray(service.command) || !service.command.length) return { ok: false, error: '通用服务必须提供 command 数组' };
      out.command = service.command.slice();
  }
  return out;
}

/** 创建注册表实例（带持久化）。无 botDir 时退化为内存态（load 返回空）。 */
function createRegistry(opts = {}) {
  const fsImpl = opts.fs || fs;
  const dir = opts.botDir || '';
  const file = dir ? path.join(dir, REGISTRY_FILE) : null;

  function load() {
    if (!file) return { version: SCHEMA_VERSION, services: [], presets: [] };
    try {
      const o = JSON.parse(fsImpl.readFileSync(file, 'utf-8'));
      if (!o || typeof o !== 'object') return { version: SCHEMA_VERSION, services: [], presets: [] };
      return { version: SCHEMA_VERSION, services: Array.isArray(o.services) ? o.services : [], presets: Array.isArray(o.presets) ? o.presets : [] };
    } catch (_) { return { version: SCHEMA_VERSION, services: [], presets: [] }; }
  }
  function save(data) {
    if (!file) return { ok: false, error: '未配置机器人目录' };
    try { fsImpl.mkdirSync(dir, { recursive: true }); fsImpl.writeFileSync(file, JSON.stringify(Object.assign({ version: SCHEMA_VERSION }, data), null, 2)); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  }
  function allServices() { const d = load(); return BUILTIN_SERVICES.concat(d.services); }
  function presets() {
    const d = load();
    const out = DEFAULT_PRESETS.slice();
    for (const p of d.presets) if (!out.find((x) => x.id === p.id)) out.push(p);
    return out;
  }
  function addService(def) {
    const v = validateServiceDef(def);
    if (!v.valid) return { ok: false, errors: v.errors };
    if (allServices().find((s) => s.id === def.id)) return { ok: false, errors: ['已存在服务 id: ' + def.id] };
    const d = load(); d.services.push(clone(def)); const r = save(d);
    return r.ok ? { ok: true, id: def.id } : { ok: false, error: r.error };
  }
  function removeService(id) {
    if (BUILTIN_SERVICES.find((s) => s.id === id)) return { ok: false, errors: ['内置服务不可删除: ' + id] };
    const d = load(); const i = d.services.findIndex((s) => s.id === id);
    if (i < 0) return { ok: false, error: '未找到服务: ' + id };
    d.services.splice(i, 1); const r = save(d);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }
  function addPreset(p) {
    if (!p || typeof p.id !== 'string' || !p.id) return { ok: false, error: 'preset.id 必需' };
    const d = load();
    if (d.presets.find((x) => x.id === p.id) || DEFAULT_PRESETS.find((x) => x.id === p.id)) return { ok: false, error: '已存在预设: ' + p.id };
    d.presets.push(clone(p)); const r = save(d);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }
  function removePreset(id) {
    const d = load(); const i = d.presets.findIndex((p) => p.id === id);
    if (i < 0) return { ok: false, error: '未找到预设: ' + id };
    d.presets.splice(i, 1); const r = save(d);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }
  /** 基于持久化注册表生成启动计划（复用纯函数 planPresetPure）。 */
  function planPreset(presetId) {
    const ps = presets().find((p) => p.id === presetId);
    if (!ps) return { ok: false, error: '未找到预设: ' + presetId };
    return Object.assign({ preset: ps }, planPresetPure(ps, allServices()));
  }
  return {
    REGISTRY_FILE, BUILTIN_SERVICES, DEFAULT_PRESETS,
    allServices, presets, addService, removeService, addPreset, removePreset, planPreset, load, save,
  };
}

module.exports = {
  REGISTRY_FILE, SCHEMA_VERSION, BUILTIN_SERVICES, DEFAULT_PRESETS,
  clone, validateServiceDef, detectCycles, detectPortConflicts, topoOrder,
  planPresetPure, describeStart, createRegistry,
};
