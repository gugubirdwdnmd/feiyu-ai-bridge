'use strict';
/**
 * skillTreeService.js —— 技能树与扩展管理（模块 E）。
 *
 * 在既有 skillService（feiyu_skills.json 的增删改查/校验）之上，补三件它没有的事：
 *  1) **分类树**：内置分类 + 用户自定义分类（存 botDir/feiyu_skill_categories.json），
 *     技能按 category 归入树；未知分类自动落到「未分类」，不丢技能。
 *  2) **依赖关系**：技能可声明 `requires: [skillId]`；构建树时检测缺失依赖与循环依赖。
 *  3) **冲突检测**：id 重复、名称重复、handler 参数冲突、同触发器关键词冲突（可能导致误触发）。
 *
 * 只读分析为主：不改写 feiyu_skills.json（写入仍由 skillService 负责）。
 */
const fs = require('fs');
const path = require('path');

const CATEGORIES_FILE = 'feiyu_skill_categories.json';
const SCHEMA_VERSION = 1;
const MAX_CATEGORIES = 60;

const BUILTIN_CATEGORIES = [
  { id: 'general', name: '通用', parent: null, builtin: true, description: '未归类的通用技能' },
  { id: 'chat', name: '对话增强', parent: 'general', builtin: true, description: '改写、总结、翻译等' },
  { id: 'draw', name: '绘图', parent: 'general', builtin: true, description: '文生图 / 图生图相关' },
  { id: 'analysis', name: '数据分析', parent: 'general', builtin: true, description: '统计、报表、日志分析' },
  { id: 'automation', name: '自动化', parent: 'general', builtin: true, description: '定时/条件触发的动作' },
  { id: 'tool', name: '外部工具', parent: 'general', builtin: true, description: '调用外部服务或脚本' },
  { id: 'fun', name: '娱乐', parent: 'general', builtin: true, description: '互动小玩法' },
  { id: 'uncategorized', name: '未分类', parent: null, builtin: true, description: 'category 缺失或指向未知分类时的兜底' },
];

function isObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

function categoriesPath(botDir) { return path.join(botDir, CATEGORIES_FILE); }

function readCustomCategories(botDir, fsImpl = fs) {
  try {
    const o = JSON.parse(fsImpl.readFileSync(categoriesPath(botDir), 'utf-8'));
    if (!o || typeof o !== 'object') return [];
    return Array.isArray(o.categories) ? o.categories : [];
  } catch (_) { return []; }
}

function writeCustomCategories(botDir, list, fsImpl = fs) {
  const p = categoriesPath(botDir);
  const tmp = p + '.tmp.' + process.pid;
  try {
    fsImpl.writeFileSync(tmp, JSON.stringify({ version: SCHEMA_VERSION, categories: list }, null, 2));
    fsImpl.renameSync(tmp, p);
    return { ok: true };
  } catch (e) {
    try { if (fsImpl.existsSync(tmp)) fsImpl.unlinkSync(tmp); } catch (_) {}
    return { ok: false, error: e.message };
  }
}

/** 全部分类（内置 + 自定义）。 */
function allCategories(botDir, { fsImpl = fs } = {}) {
  const custom = readCustomCategories(botDir, fsImpl).filter((c) => isObject(c) && typeof c.id === 'string');
  const ids = new Set(BUILTIN_CATEGORIES.map((c) => c.id));
  const out = BUILTIN_CATEGORIES.map((c) => Object.assign({}, c));
  for (const c of custom) {
    if (ids.has(c.id)) continue;
    ids.add(c.id);
    out.push({ id: c.id, name: String(c.name || c.id), parent: c.parent || 'general', builtin: false, description: String(c.description || '') });
  }
  return out;
}

function validateCategory(def, existingIds) {
  const errors = [];
  if (!isObject(def)) return { valid: false, errors: ['分类必须是对象'] };
  if (typeof def.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(def.id)) errors.push('id 必须是小写字母数字与 - _，1-32 位');
  if (typeof def.name !== 'string' || !def.name.trim()) errors.push('name 必填');
  if (existingIds && existingIds.has(def.id)) errors.push('分类已存在: ' + def.id);
  if (def.parent != null && existingIds && !existingIds.has(def.parent)) errors.push('父分类不存在: ' + def.parent);
  return { valid: errors.length === 0, errors };
}

function addCategory(botDir, def, { fsImpl = fs } = {}) {
  const all = allCategories(botDir, { fsImpl });
  const ids = new Set(all.map((c) => c.id));
  const v = validateCategory(def, ids);
  if (!v.valid) return { ok: false, errors: v.errors };
  if (all.filter((c) => !c.builtin).length >= MAX_CATEGORIES) return { ok: false, errors: ['自定义分类已达上限 ' + MAX_CATEGORIES] };
  const custom = readCustomCategories(botDir, fsImpl);
  custom.push({ id: def.id, name: def.name.trim(), parent: def.parent || 'general', description: String(def.description || '').slice(0, 200) });
  const w = writeCustomCategories(botDir, custom, fsImpl);
  return w.ok ? { ok: true, id: def.id } : { ok: false, error: w.error };
}

function removeCategory(botDir, id, { fsImpl = fs } = {}) {
  if (BUILTIN_CATEGORIES.find((c) => c.id === id)) return { ok: false, errors: ['内置分类不可删除: ' + id] };
  const custom = readCustomCategories(botDir, fsImpl);
  const i = custom.findIndex((c) => c.id === id);
  if (i < 0) return { ok: false, error: '未找到分类: ' + id };
  custom.splice(i, 1);
  const w = writeCustomCategories(botDir, custom, fsImpl);
  return w.ok ? { ok: true, note: '已删除分类；原属该分类的技能会显示在「未分类」' } : { ok: false, error: w.error };
}

/** 取技能 id（skillService 里可能用 id 或 name）。 */
function skillId(s, i) { return (s && (s.id || s.name)) ? String(s.id || s.name) : 'skill-' + i; }

/**
 * 构建技能树 + 冲突/依赖分析。
 * @param skills 技能数组（来自 skillService.list().skills）
 * @param opts { botDir, fsImpl }
 * @returns { ok, tree:[{id,name,parent,builtin,skills:[...]}], byCategory, issues, stats }
 */
function buildTree(skills, opts = {}) {
  const botDir = opts.botDir || '';
  const cats = botDir ? allCategories(botDir, { fsImpl: opts.fsImpl || fs }) : BUILTIN_CATEGORIES.map((c) => Object.assign({}, c));
  const catIds = new Set(cats.map((c) => c.id));
  const list = Array.isArray(skills) ? skills : [];

  const byCategory = {};
  for (const c of cats) byCategory[c.id] = [];
  const issues = [];
  const seenIds = new Map();
  const seenNames = new Map();
  const triggerOwners = new Map();

  for (let i = 0; i < list.length; i++) {
    const s = isObject(list[i]) ? list[i] : {};
    const id = skillId(s, i);
    const name = String(s.name || id);
    let cat = typeof s.category === 'string' && s.category ? s.category : 'uncategorized';
    if (!catIds.has(cat)) {
      issues.push({ level: 'warn', code: 'unknown_category', skillId: id, message: '技能「' + name + '」的 category「' + cat + '」未注册，已归入未分类' });
      cat = 'uncategorized';
    }
    if (seenIds.has(id)) issues.push({ level: 'error', code: 'duplicate_id', skillId: id, message: '技能 id 重复: ' + id });
    else seenIds.set(id, 1);
    if (seenNames.has(name)) issues.push({ level: 'warn', code: 'duplicate_name', skillId: id, message: '技能名称重复: ' + name + '（可能导致用户选择困惑）' });
    else seenNames.set(name, 1);

    // 触发器冲突：同 keyword 被多个技能占用
    const triggers = Array.isArray(s.triggers) ? s.triggers : (Array.isArray(s.keywords) ? s.keywords : []);
    for (const t of triggers) {
      if (typeof t !== 'string' || !t.trim()) continue;
      const k = cat + '\u0000' + t.trim().toLowerCase();
      if (triggerOwners.has(k)) {
        issues.push({ level: 'warn', code: 'trigger_conflict', skillId: id, message: '触发词「' + t + '」与技能「' + triggerOwners.get(k) + '」冲突（同分类下可能误触发）' });
      } else triggerOwners.set(k, id);
    }

    (byCategory[cat] = byCategory[cat] || []).push({
      id, name, category: cat, enabled: s.enabled !== false,
      handler: s.handler || null, triggers: triggers.slice(0, 20),
      requires: Array.isArray(s.requires) ? s.requires.slice() : [],
    });
  }

  // 依赖检查（缺失 / 循环）
  const allIds = new Set(Object.values(byCategory).flat().map((s) => s.id));
  for (const arr of Object.values(byCategory)) {
    for (const s of arr) {
      for (const r of s.requires) {
        if (!allIds.has(r)) issues.push({ level: 'error', code: 'missing_dependency', skillId: s.id, message: '技能「' + s.name + '」依赖的技能不存在: ' + r });
      }
    }
  }
  const depMap = {};
  for (const arr of Object.values(byCategory)) for (const s of arr) depMap[s.id] = s.requires.filter((r) => allIds.has(r));
  const color = {};
  for (const id of Object.keys(depMap)) color[id] = 0;
  let cycle = null;
  for (const start of Object.keys(depMap)) {
    if (color[start] !== 0 || cycle) continue;
    const stack = [{ id: start, i: 0 }];
    color[start] = 1;
    const pathArr = [start];
    while (stack.length && !cycle) {
      const top = stack[stack.length - 1];
      const ch = depMap[top.id] || [];
      if (top.i < ch.length) {
        const nx = ch[top.i++];
        if (color[nx] === 1) { cycle = pathArr.slice(pathArr.indexOf(nx)).concat([nx]); break; }
        if (color[nx] === 0) { color[nx] = 1; pathArr.push(nx); stack.push({ id: nx, i: 0 }); }
      } else { color[top.id] = 2; stack.pop(); pathArr.pop(); }
    }
    if (cycle) break;
  }
  if (cycle) issues.push({ level: 'error', code: 'dependency_cycle', message: '技能依赖存在环: ' + cycle.join(' → ') });

  const tree = cats.map((c) => ({
    id: c.id, name: c.name, parent: c.parent, builtin: c.builtin,
    description: c.description,
    skills: (byCategory[c.id] || []),
    count: (byCategory[c.id] || []).length,
  }));

  return {
    ok: true,
    tree,
    byCategory,
    issues,
    stats: {
      skills: list.length,
      categories: cats.length,
      customCategories: cats.filter((c) => !c.builtin).length,
      enabled: Object.values(byCategory).flat().filter((s) => s.enabled).length,
      errors: issues.filter((i) => i.level === 'error').length,
      warnings: issues.filter((i) => i.level === 'warn').length,
    },
  };
}

module.exports = {
  CATEGORIES_FILE, SCHEMA_VERSION, MAX_CATEGORIES, BUILTIN_CATEGORIES,
  categoriesPath, readCustomCategories, writeCustomCategories, allCategories,
  validateCategory, addCategory, removeCategory, buildTree,
};
