'use strict';
/**
 * workflowService.js —— 可视化自动化工作流（模块 H）。
 *
 * 目标：**真正** 能保存 / 加载 / 执行（不是画个图放着）。
 *
 * 模型：
 *   workflow = { id, name, description, nodes:[node], edges:[{from,to,when?}] }
 *   node     = { id, type, title, params }
 *
 * 允许的节点类型（白名单，防止变成任意代码执行入口）：
 *   start      起点，只有一个，无参数
 *   log        写一条日志（进入运行记录）
 *   setVar     设置变量（纯内存）
 *   if         条件分支：params.expr 支持极其有限的比较语法 `var op literal`
 *   delay      等待（毫秒，硬上限 5000，且单次运行累计上限 15000）
 *   notify     发一条通知到通知中心（由处理器注入的 sink 落地）
 *   serviceCall 调用已注册服务（由处理器注入 executor，默认 dry-run 不真正启动）
 *   end        终点
 *
 * 执行语义：
 *   - 从 start 出发，按出边推进；if 节点按 condition 真假选择 when=true/false 边。
 *   - 步数预算（默认 200 步）与时间预算（默认 10s）双重保护，超限中止。
 *   - 支持 dryRun：不真正执行 serviceCall / notify / delay，只产出「将会发生什么」的轨迹。
 *
 * 安全边界：
 *  - 绝不 eval / new Function；if 的条件用受限解析器。
 *  - serviceCall 只能引用注册表里已存在的服务 id（由注入的 listServices 校验）。
 */
const fs = require('fs');
const path = require('path');

const WORKFLOW_FILE = 'feiyu_workflows.json';
const SCHEMA_VERSION = 1;
const NODE_TYPES = ['start', 'log', 'setVar', 'if', 'delay', 'notify', 'serviceCall', 'end'];
const MAX_NODES = 60;
const MAX_STEPS = 200;
const MAX_DELAY_MS = 5000;
const MAX_TOTAL_DELAY_MS = 15000;
const MAX_RUN_MS = 10000;

function isObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function clone(o) { try { return JSON.parse(JSON.stringify(o)); } catch (_) { return {}; } }
function validId(s) { return typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(s); }

/** 校验单个节点。 */
function validateNode(n, idx) {
  const errors = [];
  if (!isObject(n)) return { errors: ['nodes[' + idx + '] 必须是对象'] };
  if (!validId(n.id)) errors.push('nodes[' + idx + '].id 非法（字母数字 . _ -，1-48）');
  if (!NODE_TYPES.includes(n.type)) errors.push('nodes[' + idx + '].type 必须是 ' + NODE_TYPES.join('/'));
  const p = n.params == null ? {} : n.params;
  if (!isObject(p)) errors.push('nodes[' + idx + '].params 必须是对象');
  else {
    if (n.type === 'if') {
      if (typeof p.expr !== 'string' || !p.expr.trim()) errors.push('if 节点需要 params.expr（形如 `count > 3`）');
    }
    if (n.type === 'delay') {
      const ms = Number(p.ms);
      if (!Number.isFinite(ms) || ms < 0) errors.push('delay 节点需要非负 params.ms');
      else if (ms > MAX_DELAY_MS) errors.push('delay 单次不得超过 ' + MAX_DELAY_MS + 'ms');
    }
    if (n.type === 'setVar') {
      if (typeof p.name !== 'string' || !p.name.trim()) errors.push('setVar 节点需要 params.name');
    }
    if (n.type === 'serviceCall') {
      if (typeof p.serviceId !== 'string' || !p.serviceId.trim()) errors.push('serviceCall 节点需要 params.serviceId');
    }
    if (n.type === 'log' || n.type === 'notify') {
      if (p.message != null && typeof p.message !== 'string') errors.push(n.type + ' 节点 params.message 必须是字符串');
    }
  }
  return { errors };
}

/**
 * 校验整个工作流。
 * @returns { valid, errors[], warnings[], graph:{ byId, out, in } }
 */
function validateWorkflow(wf) {
  const errors = [];
  const warnings = [];
  if (!isObject(wf)) return { valid: false, errors: ['工作流必须是对象'], warnings, graph: null };
  if (!validId(wf.id)) errors.push('id 非法（字母数字 . _ -，1-48）');
  if (typeof wf.name !== 'string' || !wf.name.trim()) errors.push('name 必填');
  const nodes = Array.isArray(wf.nodes) ? wf.nodes : null;
  if (!nodes) { errors.push('nodes 必须是数组'); return { valid: false, errors, warnings, graph: null }; }
  if (!nodes.length) errors.push('工作流至少需要一个节点');
  if (nodes.length > MAX_NODES) errors.push('节点数不得超过 ' + MAX_NODES);

  const byId = {};
  for (let i = 0; i < nodes.length; i++) {
    const r = validateNode(nodes[i], i);
    for (const e of r.errors) errors.push(e);
    const n = nodes[i];
    if (isObject(n) && validId(n.id)) {
      if (byId[n.id]) errors.push('节点 id 重复: ' + n.id);
      byId[n.id] = n;
    }
  }
  const starts = nodes.filter((n) => isObject(n) && n.type === 'start');
  if (starts.length !== 1) errors.push('必须有且只有一个 start 节点（当前 ' + starts.length + '）');
  const ends = nodes.filter((n) => isObject(n) && n.type === 'end');
  if (ends.length !== 1) errors.push('必须有且只有一个 end 节点（当前 ' + ends.length + '）');

  const edges = Array.isArray(wf.edges) ? wf.edges : [];
  if (!Array.isArray(wf.edges)) errors.push('edges 必须是数组');
  const out = {};
  const inc = {};
  for (const id of Object.keys(byId)) { out[id] = []; inc[id] = []; }
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (!isObject(e) || typeof e.from !== 'string' || typeof e.to !== 'string') { errors.push('edges[' + i + '] 需要 {from, to}'); continue; }
    if (!byId[e.from]) errors.push('edges[' + i + '].from 指向不存在的节点: ' + e.from);
    if (!byId[e.to]) errors.push('edges[' + i + '].to 指向不存在的节点: ' + e.to);
    if (e.when != null && e.when !== true && e.when !== false) errors.push('edges[' + i + '].when 必须是布尔');
    if (byId[e.from] && byId[e.to]) {
      out[e.from].push({ to: e.to, when: e.when });
      inc[e.to].push({ from: e.from, when: e.when });
    }
  }
  // 分支歧义检查：执行器对「非 if 节点」只取第一条无条件出边，对「if 节点」按 when 取值。
  // 若不在这里阻断，多余的出边会被**静默忽略**（流程看起来连上了却不走）—— 必须报错。
  for (const id of Object.keys(out)) {
    const node = byId[id];
    if (!node) continue;
    const list = out[id];
    if (node.type === 'if') {
      const uncond = list.filter((e) => e.when === undefined);
      if (uncond.length) errors.push('if 节点的出边必须标注 when（true/false）: ' + id);
      if (list.filter((e) => e.when === true).length > 1) errors.push('if 节点最多只能有一条 when=true 分支: ' + id);
      if (list.filter((e) => e.when === false).length > 1) errors.push('if 节点最多只能有一条 when=false 分支: ' + id);
    } else if (list.filter((e) => e.when === undefined).length > 1) {
      errors.push('节点 ' + id + ' 有多条无条件出边（最多一条，否则后面的会被忽略）');
    }
  }

  // 环检测（有向图）
  const color = {};
  for (const id of Object.keys(byId)) color[id] = 0;
  let cycle = null;
  for (const startId of Object.keys(byId)) {
    if (color[startId] !== 0) continue;
    const stack = [{ id: startId, i: 0 }];
    color[startId] = 1;
    const pathArr = [startId];
    while (stack.length && !cycle) {
      const top = stack[stack.length - 1];
      const ch = out[top.id] || [];
      if (top.i < ch.length) {
        const nx = ch[top.i++].to;
        if (color[nx] === 1) { cycle = pathArr.slice(pathArr.indexOf(nx)).concat([nx]); break; }
        if (color[nx] === 0) { color[nx] = 1; pathArr.push(nx); stack.push({ id: nx, i: 0 }); }
      } else {
        color[top.id] = 2; stack.pop(); pathArr.pop();
      }
    }
    if (cycle) break;
  }
  if (cycle) errors.push('工作流存在环: ' + cycle.join(' → '));

  // 可达性（从 start 出发）
  let unreachable = [];
  if (starts.length === 1) {
    const seen = new Set([starts[0].id]);
    const q = [starts[0].id];
    while (q.length) {
      const id = q.shift();
      for (const e of (out[id] || [])) if (!seen.has(e.to)) { seen.add(e.to); q.push(e.to); }
    }
    unreachable = Object.keys(byId).filter((id) => !seen.has(id));
    if (unreachable.length) warnings.push('以下节点从 start 不可达，不会被执行: ' + unreachable.join('、'));
  }

  return { valid: errors.length === 0, errors, warnings, graph: { byId, out, inc, unreachable, startId: starts.length === 1 ? starts[0].id : null } };
}

/**
 * 受限条件解析：`var op literal`
 *   op ∈ == != > >= < <= contains
 *   literal 可为数字、带引号字符串、true/false
 * 绝不 eval。
 */
function evalCondition(expr, vars) {
  const s = String(expr || '').trim();
  const m = s.match(/^([A-Za-z_$][\w$.]*)\s*(==|!=|>=|<=|>|<|contains)\s*(.+)$/);
  if (!m) return { ok: false, error: '条件语法不支持（支持 `变量 op 值`，op 为 == != >= <= > < contains）' };
  const varName = m[1];
  const op = m[2];
  let rawLit = m[3].trim();
  let lit;
  if ((rawLit.startsWith('"') && rawLit.endsWith('"')) || (rawLit.startsWith("'") && rawLit.endsWith("'"))) {
    lit = rawLit.slice(1, -1);
  } else if (rawLit === 'true') lit = true;
  else if (rawLit === 'false') lit = false;
  else if (rawLit === 'null') lit = null;
  else if (/^-?\d+(\.\d+)?$/.test(rawLit)) lit = Number(rawLit);
  else lit = rawLit; // 裸标识符按字符串处理，避免误解析

  const getVar = (name) => {
    if (!name.includes('.')) return vars[name];
    return name.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), vars);
  };
  const left = getVar(varName);
  switch (op) {
    case '==': return { ok: true, value: left === lit || String(left) === String(lit) };
    case '!=': return { ok: true, value: !(left === lit || String(left) === String(lit)) };
    case '>': return { ok: true, value: Number(left) > Number(lit) };
    case '>=': return { ok: true, value: Number(left) >= Number(lit) };
    case '<': return { ok: true, value: Number(left) < Number(lit) };
    case '<=': return { ok: true, value: Number(left) <= Number(lit) };
    case 'contains': return { ok: true, value: String(left == null ? '' : left).includes(String(lit)) };
    default: return { ok: false, error: '不支持的操作符: ' + op };
  }
}

/** 极简模板替换：把 {{var}} 换成字符串值。 */
function interpolate(text, vars) {
  return String(text == null ? '' : text).replace(/\{\{\s*([A-Za-z_$][\w$.]*)\s*\}\}/g, (_, name) => {
    const v = name.includes('.') ? name.split('.').reduce((a, k) => (a == null ? undefined : a[k]), vars) : vars[name];
    return v == null ? '' : String(v);
  });
}

/**
 * 执行工作流。
 * @param wf 工作流
 * @param opts {
 *   dryRun=true 默认只演练,
 *   vars 初始变量,
 *   now 时间源,
 *   sleep: (ms)=>Promise,
 *   onNotify: ({title,message})=>{},
 *   onLog: (entry)=>{},
 *   onServiceCall: (serviceId, node)=>{ok, detail},
 *   budget { maxSteps, maxRunMs, maxTotalDelayMs }
 * }
 * @returns { ok, trace:[], vars, stopped, error }
 */
async function runWorkflow(wf, opts = {}) {
  const v = validateWorkflow(wf);
  if (!v.valid) return { ok: false, errors: v.errors, trace: [], vars: {} };
  const dryRun = opts.dryRun !== false; // 默认演练，必须显式 false 才真执行
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : ((ms) => new Promise((r) => setTimeout(r, ms)));
  const budget = Object.assign({ maxSteps: MAX_STEPS, maxRunMs: MAX_RUN_MS, maxTotalDelayMs: MAX_TOTAL_DELAY_MS }, opts.budget || {});
  const vars = Object.assign({}, opts.vars || {});
  const trace = [];
  const startedAt = now();
  let totalDelay = 0;
  let steps = 0;

  const outEdge = (id, when) => {
    const list = (v.graph.out[id] || []);
    if (when === undefined) return list.find((e) => e.when === undefined) || null;
    return list.find((e) => e.when === when) || null;
  };

  let cur = v.graph.startId;
  let lastNode = null;
  while (cur) {
    if (steps++ >= budget.maxSteps) return { ok: false, error: '超过步数上限 ' + budget.maxSteps + '，已中止', trace, vars, stopped: 'max_steps' };
    if (now() - startedAt > budget.maxRunMs) return { ok: false, error: '超过运行时长上限 ' + budget.maxRunMs + 'ms，已中止', trace, vars, stopped: 'max_time' };

    const node = v.graph.byId[cur];
    if (!node) return { ok: false, error: '节点不存在: ' + cur, trace, vars };
    const p = node.params || {};
    const rec = { step: steps, nodeId: node.id, type: node.type, title: node.title || '', status: 'ok', detail: null };
    let nextWhen;

    try {
      switch (node.type) {
        case 'start':
          rec.detail = '开始';
          break;
        case 'log': {
          const msg = interpolate(p.message || p.text || '（空日志）', vars);
          rec.detail = msg;
          if (!dryRun) opts.onLog && opts.onLog({ nodeId: node.id, message: msg });
          break;
        }
        case 'setVar': {
          let val = p.value;
          if (typeof val === 'string') val = interpolate(val, vars);
          vars[p.name] = val;
          rec.detail = p.name + ' = ' + JSON.stringify(val);
          break;
        }
        case 'if': {
          const r = evalCondition(p.expr, vars);
          if (!r.ok) { rec.status = 'error'; rec.detail = r.error; return { ok: false, error: 'if 节点条件解析失败: ' + r.error, trace, vars }; }
          nextWhen = r.value;
          rec.detail = p.expr + ' → ' + r.value;
          break;
        }
        case 'delay': {
          const ms = Math.max(0, Number(p.ms) || 0);
          if (totalDelay + ms > budget.maxTotalDelayMs) { rec.status = 'error'; rec.detail = '累计延时超限'; return { ok: false, error: '累计延时超过 ' + budget.maxTotalDelayMs + 'ms', trace, vars }; }
          totalDelay += ms;
          rec.detail = (dryRun ? '[演练] 等待 ' : '等待 ') + ms + 'ms';
          if (!dryRun && ms > 0) await sleep(ms);
          break;
        }
        case 'notify': {
          const title = interpolate(p.title || wf.name, vars);
          const message = interpolate(p.message || '', vars);
          rec.detail = title + ': ' + message;
          if (!dryRun) opts.onNotify && opts.onNotify({ title, message, workflowId: wf.id, nodeId: node.id });
          break;
        }
        case 'serviceCall': {
          const sid = p.serviceId;
          const allowed = typeof opts.listServices === 'function' ? opts.listServices() : null;
          if (allowed && !allowed.includes(sid)) { rec.status = 'error'; rec.detail = '服务未注册: ' + sid; return { ok: false, error: 'serviceCall 引用了未注册的服务: ' + sid, trace, vars }; }
          if (dryRun) { rec.detail = '[演练] 将调用服务 ' + sid; }
          else {
            const r = opts.onServiceCall ? await opts.onServiceCall(sid, node) : { ok: true, detail: '未配置执行器，跳过' };
            rec.detail = (r && r.detail) || ('调用服务 ' + sid);
            if (r && r.ok === false) { rec.status = 'error'; return { ok: false, error: (r && r.error) || ('服务调用失败: ' + sid), trace, vars }; }
          }
          break;
        }
        case 'end':
          // 只标记终止；统一在 switch 之后 push 一次 trace（避免 end 节点被记录两遍）
          rec.detail = '结束';
          nextWhen = 'STOP';
          break;
        default:
          rec.status = 'error'; rec.detail = '未知节点类型';
          return { ok: false, error: '未知节点类型: ' + node.type, trace, vars };
      }
    } catch (e) {
      rec.status = 'error'; rec.detail = e.message;
      trace.push(rec);
      return { ok: false, error: '执行节点失败(' + node.id + '): ' + e.message, trace, vars };
    }

    trace.push(rec);
    lastNode = node.id;
    if (nextWhen === 'STOP') break;
    if (node.type === 'if') {
      const e = outEdge(node.id, nextWhen);
      if (!e) {
        // 没有对应分支的边 → 正常终止（不视为错误，但记录）
        trace.push({ step: steps + 1, nodeId: node.id, type: 'route', status: 'warn', detail: '条件为 ' + nextWhen + ' 但没有对应分支，流程结束' });
        break;
      }
      cur = e.to;
    } else {
      const e = outEdge(node.id, undefined);
      cur = e ? e.to : null;
    }
  }
  return { ok: true, dryRun, trace, vars, steps, lastNode, elapsedMs: now() - startedAt };
}

function readStore(botDir, fsImpl = fs) {
  try {
    const o = JSON.parse(fsImpl.readFileSync(path.join(botDir, WORKFLOW_FILE), 'utf-8'));
    if (!o || typeof o !== 'object') return { version: SCHEMA_VERSION, workflows: [] };
    return { version: SCHEMA_VERSION, workflows: Array.isArray(o.workflows) ? o.workflows : [] };
  } catch (_) { return { version: SCHEMA_VERSION, workflows: [] }; }
}

function writeStore(botDir, data, fsImpl = fs) {
  const p = path.join(botDir, WORKFLOW_FILE);
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

function save(botDir, wf, { fsImpl = fs, now = new Date() } = {}) {
  const v = validateWorkflow(wf);
  if (!v.valid) return { ok: false, errors: v.errors, warnings: v.warnings };
  const st = readStore(botDir, fsImpl);
  const i = st.workflows.findIndex((x) => x.id === wf.id);
  const rec = Object.assign(clone(wf), { updatedAt: (now instanceof Date ? now : new Date()).toISOString() });
  if (i >= 0) { rec.createdAt = st.workflows[i].createdAt || rec.updatedAt; st.workflows[i] = rec; }
  else { rec.createdAt = rec.updatedAt; st.workflows.push(rec); }
  const w = writeStore(botDir, st, fsImpl);
  return w.ok ? { ok: true, id: wf.id, created: i < 0, warnings: v.warnings } : { ok: false, error: w.error };
}

function list(botDir, { fsImpl = fs } = {}) {
  const st = readStore(botDir, fsImpl);
  return {
    ok: true,
    workflows: st.workflows.map((w) => ({
      id: w.id, name: w.name, description: w.description || '',
      nodeCount: Array.isArray(w.nodes) ? w.nodes.length : 0,
      edgeCount: Array.isArray(w.edges) ? w.edges.length : 0,
      updatedAt: w.updatedAt || null,
    })),
  };
}

function get(botDir, id, { fsImpl = fs } = {}) {
  const st = readStore(botDir, fsImpl);
  const wf = st.workflows.find((x) => x.id === id);
  if (!wf) return { ok: false, error: '未找到工作流: ' + id };
  const v = validateWorkflow(wf);
  return { ok: true, workflow: wf, validation: { valid: v.valid, errors: v.errors, warnings: v.warnings } };
}

function remove(botDir, id, { fsImpl = fs } = {}) {
  const st = readStore(botDir, fsImpl);
  const i = st.workflows.findIndex((x) => x.id === id);
  if (i < 0) return { ok: false, error: '未找到工作流: ' + id };
  st.workflows.splice(i, 1);
  const w = writeStore(botDir, st, fsImpl);
  return w.ok ? { ok: true } : { ok: false, error: w.error };
}

module.exports = {
  WORKFLOW_FILE, SCHEMA_VERSION, NODE_TYPES, MAX_NODES, MAX_STEPS, MAX_DELAY_MS, MAX_TOTAL_DELAY_MS, MAX_RUN_MS,
  validateNode, validateWorkflow, evalCondition, interpolate, runWorkflow,
  readStore, writeStore, save, list, get, remove,
};
