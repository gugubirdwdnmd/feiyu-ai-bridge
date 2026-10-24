'use strict';
/**
 * personalityTemplateService.js —— 人格模板库（与运行配置分离）。
 *
 * 设计要点（任务书要求）：
 *  - 模板存 feiyu_personalities.json（botDir 下），与机器人实际生效的 ai_prompt.txt 分离。
 *    编辑/新建模板只改模板库，绝不直接触碰运行中的人格文件。
 *  - 「保存模板」= 仅写入模板库；「应用到机器人」= 显式把模板内容写入 ai_prompt.txt。
 *  - 应用前自动备份 ai_prompt.txt；应用失败时原子写保证原文件不变，并返回错误。
 *  - 机器人 loadPrompt() 每次请求重新读取 ai_prompt.txt，故应用即时生效，无需重启（不擅自重启服务）。
 *  - 提供与当前生效人格的一致性状态（active 模板内容 === 当前 ai_prompt.txt 内容？）。
 *  - 提供行级 diff 预览（模板 vs 当前生效人格，或模板 vs 模板）。
 *  - 所有文件写入走「临时文件 + rename」原子模式，失败不破坏原文件。
 */
const fs = require('fs');
const path = require('path');

function templatesPath(botDir) { return path.join(botDir, 'feiyu_personalities.json'); }
function nowISO() { return new Date().toISOString(); }
function genId() { return 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function load(botDir) {
  try {
    const o = JSON.parse(fs.readFileSync(templatesPath(botDir), 'utf-8'));
    if (o && typeof o === 'object' && Array.isArray(o.templates)) return o;
  } catch (_) {}
  return { activeId: null, templates: [] };
}
function saveAll(botDir, obj) {
  const fp = templatesPath(botDir);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = fp + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  fs.renameSync(tmp, fp);
  return { ok: true };
}

/** 校验模板结构（不含内容是否「有效」——那是用户判断；只校验必填字段类型）。 */
function validateTemplate(t) {
  const errors = [];
  if (!t || typeof t !== 'object') return { valid: false, errors: ['模板必须是对象'] };
  if (!t.name || typeof t.name !== 'string' || !t.name.trim()) errors.push('name 必填');
  if (typeof t.content !== 'string') errors.push('content 必须是字符串');
  return { valid: errors.length === 0, errors };
}

function save(botDir, input) {
  if (!input || typeof input !== 'object') return { ok: false, errors: ['需要 {name, content}'] };
  const data = load(botDir);
  const id = (input.id && data.templates.some((t) => t.id === input.id)) ? input.id : genId();
  const existing = id ? data.templates.find((t) => t.id === id) : null;
  const merged = existing ? Object.assign({}, existing, input) : Object.assign({ id }, input);
  const v = validateTemplate(merged);
  if (!v.valid) return { ok: false, errors: v.errors };
  const rec = {
    id,
    name: String(merged.name).trim(),
    content: String(merged.content != null ? merged.content : ''),
    createdAt: existing ? existing.createdAt : nowISO(),
    updatedAt: nowISO(),
  };
  if (existing) data.templates = data.templates.map((t) => (t.id === id ? rec : t));
  else data.templates.push(rec);
  if (!data.activeId) data.activeId = id;
  saveAll(botDir, data);
  return { ok: true, id, template: rec };
}

function remove(botDir, id) {
  const data = load(botDir);
  const before = data.templates.length;
  data.templates = data.templates.filter((t) => t.id !== id);
  if (data.templates.length === before) return { ok: false, error: '未找到该模板' };
  if (data.activeId === id) data.activeId = data.templates.length ? data.templates[0].id : null;
  saveAll(botDir, data);
  return { ok: true };
}

function copy(botDir, id) {
  const data = load(botDir);
  const src = data.templates.find((t) => t.id === id);
  if (!src) return { ok: false, error: '未找到该模板' };
  const nid = genId();
  const rec = { id: nid, name: src.name + ' 副本', content: src.content, createdAt: nowISO(), updatedAt: nowISO() };
  data.templates.push(rec);
  saveAll(botDir, data);
  return { ok: true, id: nid, template: rec };
}

function rename(botDir, id, name) {
  const data = load(botDir);
  const t = data.templates.find((x) => x.id === id);
  if (!t) return { ok: false, error: '未找到该模板' };
  if (!name || !String(name).trim()) return { ok: false, error: 'name 必填' };
  t.name = String(name).trim(); t.updatedAt = nowISO();
  saveAll(botDir, data);
  return { ok: true, id, template: t };
}

function setActive(botDir, id) {
  const data = load(botDir);
  if (!data.templates.some((t) => t.id === id)) return { ok: false, error: '未找到该模板' };
  data.activeId = id;
  saveAll(botDir, data);
  return { ok: true, activeId: id };
}

/** 备份 ai_prompt.txt 到 backups/（gitignore 已排除，不会入库）。不备份无关文件。 */
function backupPrompt(botDir) {
  const src = path.join(botDir, 'ai_prompt.txt');
  if (!fs.existsSync(src)) return { backedUp: false, backupDir: null };
  const dir = path.join(botDir, 'backups', 'feiyu-prompt-' + Date.now());
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(src, path.join(dir, 'ai_prompt.txt'));
    return { backedUp: true, backupDir: dir };
  } catch (e) { return { backedUp: false, backupDir: null, error: e.message }; }
}

/**
 * 应用模板到机器人：备份 ai_prompt.txt → 原子写入模板内容 → 设为 active。
 * 全程 try/catch：写入失败原配置保留，返回错误（不静默）。deps.writePrompt 可注入（测试用）。
 */
function apply(botDir, id, deps) {
  deps = deps || {};
  const data = load(botDir);
  const t = data.templates.find((x) => x.id === id);
  if (!t) return { ok: false, error: '未找到该模板' };
  const bk = backupPrompt(botDir);
  if (bk.error) return { ok: false, error: '备份失败：' + bk.error };
  const writer = deps.writePrompt || ((content) => {
    const p = path.join(botDir, 'ai_prompt.txt');
    const tmp = p + '.tmp.' + process.pid;
    try { fs.writeFileSync(tmp, content, 'utf-8'); fs.renameSync(tmp, p); return { ok: true }; }
    catch (e) { try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {} return { ok: false, error: e.message }; }
  });
  const w = writer(t.content);
  if (!w.ok) return { ok: false, error: '写入失败，原配置已保留：' + (w.error || ''), backupDir: bk.backupDir };
  data.activeId = id; saveAll(botDir, data);
  return {
    ok: true, id, backupDir: bk.backupDir,
    note: '已写入 ai_prompt.txt（机器人每次请求重新读取，下次消息即时生效，无需重启）',
  };
}

/** 模板库 + 当前生效人格 + 一致性状态。deps.readPrompt 可注入（测试用）。 */
function status(botDir, deps) {
  deps = deps || {};
  const data = load(botDir);
  const reader = deps.readPrompt || (() => {
    const p = path.join(botDir, 'ai_prompt.txt');
    if (!fs.existsSync(p)) return { content: '', exists: false };
    try { return { content: fs.readFileSync(p, 'utf-8'), exists: true }; } catch (_) { return { content: '', exists: false }; }
  });
  const cur = reader();
  const currentContent = cur.content || '';
  const active = data.activeId ? data.templates.find((t) => t.id === data.activeId) : null;
  let consistency = 'none';
  if (active) consistency = (active.content === currentContent) ? 'match' : 'diverged';
  else if (data.templates.length && currentContent) consistency = 'diverged';
  return {
    templates: data.templates.map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt, updatedAt: t.updatedAt, contentLen: (t.content || '').length, isActive: t.id === data.activeId })),
    activeId: data.activeId,
    activeName: active ? active.name : null,
    currentContent,
    currentExists: !!cur.exists,
    consistency,
  };
}

/** 行级 diff：模板(id) 与 目标文本（缺省=当前生效人格）比较。返回 [{type:' '/'-'/'+', text}]。 */
function diff(botDir, id, deps) {
  deps = deps || {};
  const data = load(botDir);
  const t = data.templates.find((x) => x.id === id);
  if (!t) return { ok: false, error: '未找到该模板' };
  const reader = deps.readPrompt || (() => {
    const p = path.join(botDir, 'ai_prompt.txt');
    if (!fs.existsSync(p)) return { content: '' };
    try { return { content: fs.readFileSync(p, 'utf-8') }; } catch (_) { return { content: '' }; }
  });
  const targetContent = (deps.target != null) ? String(deps.target) : (reader().content || '');
  return { ok: true, name: t.name, lines: lineDiff(t.content || '', targetContent) };
}

/** LCS 行级 diff。纯函数，无 I/O。 */
function lineDiff(a, b) {
  const A = String(a).split('\n'), B = String(b).split('\n');
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ type: ' ', text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: '-', text: A[i] }); i++; }
    else { out.push({ type: '+', text: B[j] }); j++; }
  }
  while (i < n) { out.push({ type: '-', text: A[i] }); i++; }
  while (j < m) { out.push({ type: '+', text: B[j] }); j++; }
  return out;
}

module.exports = {
  templatesPath, load, save, remove, copy, rename, setActive, apply, status, diff,
  backupPrompt, validateTemplate, lineDiff,
};
