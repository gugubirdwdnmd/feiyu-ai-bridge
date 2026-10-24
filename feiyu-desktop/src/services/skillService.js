'use strict';
/**
 * skillService.js —— 桌面端「技能库」管理。
 *
 * 与机器人侧 skills.js 共用同一份注册表文件（botDir/feiyu_skills.json）：
 *  - 机器人每轮重新读取该文件 → 桌面端保存后即时生效，**不需要重启 AI 桥**。
 *  - 桌面端只做「注册表的增删改查 + 模板库 + 应用/回滚」，不重复实现技能语义
 *    （命中、提示词渲染、工具挂载全部由机器人侧 skills.js 负责，避免两套逻辑漂移）。
 *
 * 安全边界：
 *  - 技能只能挂载「已有内置工具」（handler 白名单），不能执行自定义代码。
 *  - 校验规则与机器人侧一致（通过共享校验函数），避免桌面存了机器人拒收的技能。
 */
const fs = require('fs');
const path = require('path');

const SKILLS_FILE = 'feiyu_skills.json';

function skillsPath(botDir) { return path.join(botDir, SKILLS_FILE); }
function nowISO() { return new Date().toISOString(); }
function genId() { return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

/** 技能可挂载的内置工具（与机器人侧 skills.js 的 ALLOWED_HANDLERS 对齐）。 */
const ALLOWED_HANDLERS = [
  'web_search', 'fetch_url', 'get_current_time', 'send_sticker',
  'generate_image', 'create_file', 'create_table', 'read_file', 'list_files', 'send_file',
];
const TRIGGER_MODES = ['always', 'keyword'];
const MAX_SKILLS = 50;
const MAX_PROMPT_CHARS = 4000;
const MAX_TOOLS_PER_SKILL = 5;

/** 校验单个技能（与机器人侧同口径）。返回 {valid, errors[]}。 */
function validateSkill(s) {
  const errors = [];
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { valid: false, errors: ['技能必须是对象'] };
  if (typeof s.id !== 'string' || !s.id.trim()) errors.push('id 必须是非空字符串');
  if (typeof s.name !== 'string' || !s.name.trim()) errors.push('name 必须是非空字符串');
  if (s.description != null && typeof s.description !== 'string') errors.push('description 必须是字符串');
  if (s.enabled != null && typeof s.enabled !== 'boolean') errors.push('enabled 必须是布尔值');
  if (s.prompt != null) {
    if (typeof s.prompt !== 'string') errors.push('prompt 必须是字符串');
    else if (s.prompt.length > MAX_PROMPT_CHARS) errors.push('prompt 超过 ' + MAX_PROMPT_CHARS + ' 字符上限');
  }
  const trig = s.trigger;
  if (trig != null) {
    if (!trig || typeof trig !== 'object' || Array.isArray(trig)) errors.push('trigger 必须是对象');
    else {
      if (trig.mode != null && !TRIGGER_MODES.includes(trig.mode)) errors.push('trigger.mode 必须是 always 或 keyword');
      if (trig.keywords != null) {
        if (!Array.isArray(trig.keywords)) errors.push('trigger.keywords 必须是数组');
        else if (!trig.keywords.every((k) => typeof k === 'string')) errors.push('trigger.keywords 每项必须是字符串');
      }
      if (trig.mode === 'keyword' && (!Array.isArray(trig.keywords) || !trig.keywords.length)) {
        errors.push('trigger.mode=keyword 时必须提供至少一个关键词');
      }
    }
  }
  if (s.tools != null) {
    if (!Array.isArray(s.tools)) errors.push('tools 必须是数组');
    else {
      if (s.tools.length > MAX_TOOLS_PER_SKILL) errors.push('tools 超过 ' + MAX_TOOLS_PER_SKILL + ' 项上限');
      for (const t of s.tools) {
        if (!t || typeof t !== 'object') { errors.push('tools 每项必须是对象'); continue; }
        if (typeof t.name !== 'string' || !t.name.trim()) errors.push('tools[].name 必须是非空字符串');
        if (typeof t.handler !== 'string' || !t.handler.trim()) errors.push('tools[].handler 必须是非空字符串');
        else if (!ALLOWED_HANDLERS.includes(t.handler)) {
          errors.push('tools[].handler 不在允许清单内：' + ALLOWED_HANDLERS.join('/'));
        }
        if (t.description != null && typeof t.description !== 'string') errors.push('tools[].description 必须是字符串');
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

/** 读取注册表。文件坏掉时返回空列表 + 错误，不抛异常。 */
function load(botDir) {
  const p = skillsPath(botDir);
  if (!fs.existsSync(p)) return { version: 1, skills: [] };
  try {
    const o = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (o && typeof o === 'object' && Array.isArray(o.skills)) return { version: o.version || 1, skills: o.skills };
  } catch (_) {}
  return { version: 1, skills: [] };
}

/** 原子写注册表。 */
function saveAll(botDir, obj) {
  const fp = skillsPath(botDir);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = fp + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  fs.renameSync(tmp, fp);
  return { ok: true };
}

/** 列出技能（含每条的校验状态，便于界面标出无效项）。 */
function list(botDir) {
  const data = load(botDir);
  const skills = data.skills.map((s) => {
    const v = validateSkill(s);
    return Object.assign({}, s, { valid: v.valid, errors: v.errors });
  });
  return {
    version: data.version || 1,
    skills,
    enabledCount: skills.filter((s) => s.enabled && s.valid).length,
    invalidCount: skills.filter((s) => !s.valid).length,
    path: skillsPath(botDir),
    allowedHandlers: ALLOWED_HANDLERS,
  };
}

/** 新建或更新技能。 */
function save(botDir, input) {
  if (!input || typeof input !== 'object') return { ok: false, errors: ['需要技能对象'] };
  const data = load(botDir);
  const isNew = !(input.id && data.skills.some((s) => s.id === input.id));
  const id = isNew ? genId() : input.id;
  const existing = isNew ? null : data.skills.find((s) => s.id === id);
  if (isNew && data.skills.length >= MAX_SKILLS) {
    return { ok: false, errors: ['技能数量已达上限 ' + MAX_SKILLS] };
  }
  const merged = existing ? Object.assign({}, existing, input, { id }) : Object.assign({ id }, input);
  const v = validateSkill(merged);
  if (!v.valid) return { ok: false, errors: v.errors };

  const rec = {
    id,
    name: String(merged.name).trim(),
    description: merged.description != null ? String(merged.description) : '',
    enabled: merged.enabled !== false,
    trigger: {
      mode: (merged.trigger && TRIGGER_MODES.includes(merged.trigger.mode)) ? merged.trigger.mode : 'always',
      keywords: (merged.trigger && Array.isArray(merged.trigger.keywords))
        ? merged.trigger.keywords.map(String).slice(0, 20) : [],
    },
    prompt: merged.prompt != null ? String(merged.prompt).slice(0, MAX_PROMPT_CHARS) : '',
    tools: (Array.isArray(merged.tools) ? merged.tools : []).slice(0, MAX_TOOLS_PER_SKILL).map((t) => ({
      name: String(t.name).trim(),
      handler: String(t.handler).trim(),
      description: t.description != null ? String(t.description) : '',
      parameters: (t.parameters && typeof t.parameters === 'object') ? t.parameters : null,
    })),
    createdAt: existing && existing.createdAt ? existing.createdAt : nowISO(),
    updatedAt: nowISO(),
  };
  if (existing) data.skills = data.skills.map((s) => (s.id === id ? rec : s));
  else data.skills.push(rec);
  saveAll(botDir, data);
  return { ok: true, id, skill: rec };
}

/** 删除技能。 */
function remove(botDir, id) {
  const data = load(botDir);
  const before = data.skills.length;
  data.skills = data.skills.filter((s) => s.id !== id);
  if (data.skills.length === before) return { ok: false, error: '未找到该技能' };
  saveAll(botDir, data);
  return { ok: true };
}

/** 复制技能。 */
function copy(botDir, id) {
  const data = load(botDir);
  const src = data.skills.find((s) => s.id === id);
  if (!src) return { ok: false, error: '未找到该技能' };
  const nid = genId();
  const rec = Object.assign({}, src, {
    id: nid,
    name: src.name + ' 副本',
    createdAt: nowISO(),
    updatedAt: nowISO(),
  });
  data.skills.push(rec);
  saveAll(botDir, data);
  return { ok: true, id: nid, skill: rec };
}

/** 启用/停用。 */
function setEnabled(botDir, id, enabled) {
  const data = load(botDir);
  const s = data.skills.find((x) => x.id === id);
  if (!s) return { ok: false, error: '未找到该技能' };
  s.enabled = !!enabled;
  s.updatedAt = nowISO();
  data.skills = data.skills.map((x) => (x.id === id ? s : x));
  saveAll(botDir, data);
  return { ok: true, id, enabled: s.enabled };
}

/** 内置技能模板（用户可一键导入作为起点）。 */
function builtinTemplates() {
  return [
    {
      key: 'draw_helper',
      name: '画图小助手',
      description: '让机器人在被要求画图时更主动、更会描述画面',
      skill: {
        name: '画图小助手',
        description: '被要求画图时，先用一句话描述画面，再画',
        trigger: { mode: 'keyword', keywords: ['画', '画图', '画一张', '生图', '出图'] },
        prompt: '当对方让你画画时，先用一句简短的话描述你准备画的内容（主体/场景/画风），然后调用画图工具。不要只发图不说话。',
        tools: [{
          name: 'draw_picture',
          handler: 'generate_image',
          description: '画一张图。prompt 用中文描述画面内容，越具体越好（主体、动作、场景、光线、画风）。',
          parameters: {
            type: 'object',
            properties: { prompt: { type: 'string', description: '画面描述，中文自然语言' } },
            required: ['prompt'],
          },
        }],
      },
    },
    {
      key: 'web_analyst',
      name: '联网查证',
      description: '遇到时效性问题时优先联网搜索并给出来源',
      skill: {
        name: '联网查证',
        description: '对新闻/天气/价格等时效性问题先搜索再回答',
        trigger: { mode: 'keyword', keywords: ['最新', '今天', '现在', '天气', '新闻', '多少钱', '价格'] },
        prompt: '遇到需要实时信息的问题（新闻、天气、价格、比分、日期）时，先用搜索工具查证，再用查到的事实回答，并说明信息来源。查不到就直说查不到，不要编。',
        tools: [{
          name: 'search_web',
          handler: 'web_search',
          description: '在互联网上搜索实时信息。query 只用 1~3 个核心词。',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string', description: '搜索关键词，1~3 个词' } },
            required: ['query'],
          },
        }],
      },
    },
    {
      key: 'note_keeper',
      name: '随手记事',
      description: '对方提到值得记住的事时主动记录',
      skill: {
        name: '随手记事',
        description: '识别值得长期记住的信息并落盘',
        trigger: { mode: 'always', keywords: [] },
        prompt: '如果对方提到值得长期记住的信息（名字、喜好、约定、重要事实），就把它记下来。只记有长期价值的，闲聊和一次性信息不要记。',
        tools: [],
      },
    },
  ];
}

/** 导入内置模板（已存在同名同 key 则跳过，幂等）。 */
function importTemplate(botDir, key) {
  const tpl = builtinTemplates().find((t) => t.key === key);
  if (!tpl) return { ok: false, error: '未找到该内置模板' };
  const data = load(botDir);
  const dup = data.skills.some((s) => s.name === tpl.skill.name);
  if (dup) return { ok: false, error: '同名技能已存在，未重复导入' };
  const id = genId();
  const rec = Object.assign({}, tpl.skill, {
    id,
    enabled: true,
    trigger: tpl.skill.trigger || { mode: 'always', keywords: [] },
    prompt: tpl.skill.prompt || '',
    tools: tpl.skill.tools || [],
    createdAt: nowISO(),
    updatedAt: nowISO(),
    fromTemplate: key,
  });
  const v = validateSkill(rec);
  if (!v.valid) return { ok: false, errors: v.errors };
  data.skills.push(rec);
  saveAll(botDir, data);
  return { ok: true, id, skill: rec };
}

/** 导出全部技能（不含任何密钥，仅用于备份）。 */
function exportAll(botDir) {
  const data = load(botDir);
  return { ok: true, version: data.version || 1, skills: data.skills };
}

/** 从导出内容导入（合并，id 冲突则重新分配）。 */
function importAll(botDir, payload) {
  if (!payload || !Array.isArray(payload.skills)) return { ok: false, error: '需要 {skills: []}' };
  const data = load(botDir);
  const existingIds = new Set(data.skills.map((s) => s.id));
  let added = 0, skipped = 0;
  for (const raw of payload.skills) {
    const v = validateSkill(raw);
    if (!v.valid) { skipped++; continue; }
    let id = raw.id;
    if (!id || existingIds.has(id)) id = genId();
    existingIds.add(id);
    data.skills.push(Object.assign({}, raw, { id, updatedAt: nowISO() }));
    added++;
  }
  saveAll(botDir, data);
  return { ok: true, added, skipped };
}

/** 回滚到备份文件。 */
function restoreFromBackup(botDir, backupPath) {
  try {
    const o = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
    if (!o || !Array.isArray(o.skills)) return { ok: false, error: '备份文件格式不正确' };
    saveAll(botDir, o);
    return { ok: true, restored: o.skills.length };
  } catch (e) {
    return { ok: false, error: '回滚失败: ' + e.message };
  }
}

module.exports = {
  SKILLS_FILE,
  ALLOWED_HANDLERS,
  TRIGGER_MODES,
  MAX_SKILLS,
  MAX_PROMPT_CHARS,
  MAX_TOOLS_PER_SKILL,
  skillsPath,
  validateSkill,
  load,
  list,
  save,
  remove,
  copy,
  setEnabled,
  builtinTemplates,
  importTemplate,
  exportAll,
  importAll,
  restoreFromBackup,
};
