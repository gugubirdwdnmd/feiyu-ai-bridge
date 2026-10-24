'use strict';
/**
 * skills.js —— 可插拔「技能」运行时（纯计算层，零依赖，可单测）。
 *
 * 设计目标：
 *  - 技能是「行为增强包」：一段注入系统提示词的说明 + 可选挂载的工具定义 + 可选触发条件。
 *  - 技能只允许复用机器人已有的内置工具实现（handler 指向既有工具名），
 *    绝不执行技能文件里的任意代码 / 脚本 —— 这是安全边界，不可放宽。
 *  - 技能注册表与机器人运行配置分离：存 feiyu_skills.json，机器人每轮重新读取，
 *    因此「保存技能」即时生效，无需重启（与 ai_prompt.txt 同机制）。
 *
 * 注册表格式（feiyu_skills.json）：
 * {
 *   "version": 1,
 *   "skills": [
 *     {
 *       "id": "skill_xxx",
 *       "name": "示例技能",
 *       "description": "一句话说明",
 *       "enabled": true,
 *       "trigger": { "mode": "always" | "keyword", "keywords": ["画图"] },
 *       "prompt": "注入系统提示词的文本",
 *       "tools": [
 *         { "name": "generate_image",
 *           "handler": "generate_image",
 *           "description": "覆盖后的描述",
 *           "parameters": { ... } }
 *       ]
 *     }
 *   ]
 * }
 */
const fs = require('fs');
const path = require('path');

const SKILLS_FILE = 'feiyu_skills.json';

// 技能可挂载的内置工具白名单：handler 只能取这些值。
// 与 ai_bridge.js 的 TOOLS 中 function.name 对齐（不含 'remember' 等有副作用且会写记忆的工具，
// 避免技能被误挂后无意写用户记忆）。
const ALLOWED_HANDLERS = new Set([
  'web_search',
  'fetch_url',
  'get_current_time',
  'send_sticker',
  'generate_image',
  'create_file',
  'create_table',
  'read_file',
  'list_files',
  'send_file',
]);

const TRIGGER_MODES = new Set(['always', 'keyword']);
const MAX_SKILLS = 50;
const MAX_PROMPT_CHARS = 4000;
const MAX_TOOLS_PER_SKILL = 5;
const MAX_KEYWORDS = 20;

function skillsPath(botDir) {
  return path.join(botDir, SKILLS_FILE);
}

/** 校验单个技能。返回 {valid, errors[]}。 */
function validateSkill(s) {
  const errors = [];
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    return { valid: false, errors: ['技能必须是对象'] };
  }
  if (typeof s.id !== 'string' || !s.id.trim()) errors.push('id 必须是非空字符串');
  if (typeof s.name !== 'string' || !s.name.trim()) errors.push('name 必须是非空字符串');
  if (s.description != null && typeof s.description !== 'string') errors.push('description 必须是字符串');
  if (s.enabled != null && typeof s.enabled !== 'boolean') errors.push('enabled 必须是布尔值');
  if (s.prompt != null && typeof s.prompt !== 'string') errors.push('prompt 必须是字符串');
  if (s.prompt != null && s.prompt.length > MAX_PROMPT_CHARS) {
    errors.push('prompt 超过 ' + MAX_PROMPT_CHARS + ' 字符上限');
  }

  const trig = s.trigger;
  if (trig != null) {
    if (!trig || typeof trig !== 'object' || Array.isArray(trig)) {
      errors.push('trigger 必须是对象');
    } else {
      if (trig.mode != null && !TRIGGER_MODES.has(trig.mode)) {
        errors.push('trigger.mode 必须是 always 或 keyword');
      }
      if (trig.keywords != null) {
        if (!Array.isArray(trig.keywords)) errors.push('trigger.keywords 必须是数组');
        else {
          if (trig.keywords.length > MAX_KEYWORDS) {
            errors.push('trigger.keywords 超过 ' + MAX_KEYWORDS + ' 项上限');
          }
          if (!trig.keywords.every((k) => typeof k === 'string')) {
            errors.push('trigger.keywords 每项必须是字符串');
          }
        }
      }
      if (trig.mode === 'keyword' && (!Array.isArray(trig.keywords) || !trig.keywords.length)) {
        errors.push('trigger.mode=keyword 时必须提供至少一个关键词');
      }
    }
  }

  if (s.tools != null) {
    if (!Array.isArray(s.tools)) errors.push('tools 必须是数组');
    else {
      if (s.tools.length > MAX_TOOLS_PER_SKILL) {
        errors.push('tools 超过 ' + MAX_TOOLS_PER_SKILL + ' 项上限');
      }
      for (const t of s.tools) {
        if (!t || typeof t !== 'object') { errors.push('tools 每项必须是对象'); continue; }
        if (typeof t.name !== 'string' || !t.name.trim()) errors.push('tools[].name 必须是非空字符串');
        if (typeof t.handler !== 'string' || !t.handler.trim()) {
          errors.push('tools[].handler 必须是非空字符串');
        } else if (!ALLOWED_HANDLERS.has(t.handler)) {
          errors.push('tools[].handler 不在允许清单内（不允许技能执行自定义代码）');
        }
        if (t.description != null && typeof t.description !== 'string') errors.push('tools[].description 必须是字符串');
        if (t.parameters != null && (typeof t.parameters !== 'object' || t.parameters === null)) {
          errors.push('tools[].parameters 必须是对象');
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

/** 读取注册表。返回 {skills, errors, exists}；文件坏掉时返回空列表而不是抛错。 */
function loadSkills(botDir) {
  const p = skillsPath(botDir);
  if (!fs.existsSync(p)) return { skills: [], errors: [], exists: false };
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (e) {
    return { skills: [], errors: ['读取失败: ' + e.message], exists: true };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { skills: [], errors: ['JSON 解析失败: ' + e.message], exists: true };
  }
  const list = obj && Array.isArray(obj.skills) ? obj.skills : [];
  if (list.length > MAX_SKILLS) {
    return { skills: [], errors: ['技能数量超过 ' + MAX_SKILLS + ' 项上限'], exists: true };
  }
  const out = [];
  const errors = [];
  for (const s of list) {
    const v = validateSkill(s);
    if (!v.valid) {
      const label = (s && (s.name || s.id)) ? (s.name || s.id) : '?';
      const idPart = (s && s.id && s.name) ? ('（id=' + s.id + '）') : '';
      errors.push('技能「' + label + '」' + idPart + '无效: ' + v.errors.join('；'));
      continue;
    }
    out.push(normalizeSkill(s));
  }
  return { skills: out, errors, exists: true };
}

/** 规范化：补默认值，裁剪长度。 */
function normalizeSkill(s) {
  return {
    id: String(s.id).trim(),
    name: String(s.name).trim(),
    description: s.description != null ? String(s.description) : '',
    enabled: s.enabled !== false,
    trigger: {
      mode: (s.trigger && TRIGGER_MODES.has(s.trigger.mode)) ? s.trigger.mode : 'always',
      keywords: (s.trigger && Array.isArray(s.trigger.keywords))
        ? s.trigger.keywords.map((k) => String(k)).slice(0, MAX_KEYWORDS)
        : [],
    },
    prompt: s.prompt != null ? String(s.prompt).slice(0, MAX_PROMPT_CHARS) : '',
    tools: (Array.isArray(s.tools) ? s.tools : []).slice(0, MAX_TOOLS_PER_SKILL).map((t) => ({
      name: String(t.name).trim(),
      handler: String(t.handler).trim(),
      description: t.description != null ? String(t.description) : '',
      parameters: t.parameters && typeof t.parameters === 'object' ? t.parameters : null,
    })),
  };
}

/** 原子写注册表。返回 {ok, error}。 */
function saveSkills(botDir, skills) {
  const p = skillsPath(botDir);
  const obj = { version: 1, skills: Array.isArray(skills) ? skills : [] };
  const tmp = p + '.tmp.' + process.pid;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
    fs.renameSync(tmp, p);
    return { ok: true, error: null };
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    return { ok: false, error: e.message };
  }
}

/**
 * 判断技能是否在当前文本下命中。
 * mode=always → 始终命中；mode=keyword → 文本含任一关键词（不区分大小写）。
 */
function matches(skill, text) {
  if (!skill || skill.enabled === false) return false;
  const trig = skill.trigger || { mode: 'always', keywords: [] };
  if (trig.mode !== 'keyword') return true;
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  return (trig.keywords || []).some((k) => {
    const kw = String(k || '').trim().toLowerCase();
    return !!kw && t.indexOf(kw) !== -1;
  });
}

/** 选出当前命中的技能。 */
function selectSkills(skills, text) {
  return (Array.isArray(skills) ? skills : []).filter((s) => matches(s, text));
}

/**
 * 渲染技能的系统提示词块。命中技能才有内容。
 * 返回 '' 表示无需注入。
 */
function renderSkillPrompt(skills, text) {
  const hit = selectSkills(skills, text);
  const withPrompt = hit.filter((s) => s.prompt && s.prompt.trim());
  if (!withPrompt.length) return '';
  let out = '\n\n【已启用的技能（当前命中）】\n';
  for (const s of withPrompt) {
    out += `\n▸ ${s.name}\n${s.prompt.trim()}\n`;
  }
  return out;
}

/**
 * 把命中技能的工具定义转成 OpenAI function calling 形状。
 * handler 字段被剥离（那是机器人内部实现细节，不该暴露给模型）。
 */
function skillToolDefs(skills, text) {
  const hit = selectSkills(skills, text);
  const seen = new Set();
  const out = [];
  for (const s of hit) {
    for (const t of s.tools || []) {
      if (!ALLOWED_HANDLERS.has(t.handler)) continue;   // 双重保险
      if (seen.has(t.name)) continue;                   // 同名工具只挂一次
      seen.add(t.name);
      out.push({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || ('技能「' + s.name + '」提供的工具'),
          parameters: t.parameters && typeof t.parameters === 'object'
            ? t.parameters
            : { type: 'object', properties: {} },
        },
      });
    }
  }
  return out;
}

/**
 * 技能工具名 → 内置 handler 映射。
 * 只有注册表里出现过的 handler 才会进入这张表（其余走既有 TOOLS）。
 */
function skillHandlerMap(skills, text) {
  const hit = selectSkills(skills, text);
  const map = {};
  for (const s of hit) {
    for (const t of s.tools || []) {
      if (!ALLOWED_HANDLERS.has(t.handler)) continue;
      if (map[t.name]) continue;
      map[t.name] = t.handler;
    }
  }
  return map;
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
  loadSkills,
  saveSkills,
  normalizeSkill,
  matches,
  selectSkills,
  renderSkillPrompt,
  skillToolDefs,
  skillHandlerMap,
};
