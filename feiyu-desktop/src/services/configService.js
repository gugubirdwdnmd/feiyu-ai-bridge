'use strict';
/**
 * configService.js —— ai_config.json 的读取 / 合并 / 校验 / 原子写入。
 * 复用 ai_bridge.js 的 mergeConfig 语义（深合并、只盖用户写了且类型对得上的字段、
 * 文件读坏回落、新增配置段不静默丢弃），保证桌面端改配置与 bot 运行时行为一致。
 * 不复制 bot 的 DEFAULT_CONFIG（太大且会漂移）：缺字段由 bot 运行时补默认，
 * 桌面端只读写用户可见的 ai_config.json。
 */
const fs = require('fs');
const path = require('path');

function configPath(botDir) { return path.join(botDir, 'ai_config.json'); }

/** 深合并（与 ai_bridge.js:532 mergeConfig 行为一致）。 */
function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!over || typeof over !== 'object') return out;
  for (const k of Object.keys(over)) {
    const bv = out[k];
    const ov = over[k];
    if (Array.isArray(bv)) {
      out[k] = Array.isArray(ov) ? ov.slice() : bv.slice();
    } else if (bv && typeof bv === 'object') {
      out[k] = deepMerge(bv, ov);
    } else if (bv === undefined && ov && typeof ov === 'object') {
      out[k] = Array.isArray(ov) ? deepMerge([], ov) : deepMerge({}, ov);
    } else if (typeof bv === typeof ov && ov !== undefined && ov !== null) {
      out[k] = ov;
    } else if (ov !== undefined && ov !== null) {
      if (typeof ov !== 'object') out[k] = ov;
    }
  }
  return out;
}

/** 读取原始 ai_config.json。返回 {exists, data, error}。 */
function readRaw(botDir) {
  const p = configPath(botDir);
  if (!fs.existsSync(p)) return { exists: false, data: null, error: null };
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!data || typeof data !== 'object') return { exists: true, data: null, error: '配置不是合法 JSON 对象' };
    return { exists: true, data, error: null };
  } catch (e) {
    return { exists: true, data: null, error: '读取失败: ' + e.message };
  }
}

/** 把 partial 深合并进现有配置，返回合并后对象（不落盘）。 */
function mergePartial(botDir, partial) {
  const cur = readRaw(botDir);
  const base = cur.data && !cur.error ? cur.data : {};
  return deepMerge(base, partial || {});
}

/** 字段类型校验（仅校验已知字段；未知字段宽松放过）。返回 {valid, errors[]}。 */
function validateConfig(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object') return { valid: false, errors: ['配置必须是对象'] };
  const isStr = (v) => typeof v === 'string';
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const isBool = (v) => typeof v === 'boolean';
  const isPosNum = (v) => isNum(v) && v > 0;

  const api = obj.api;
  if (api != null) {
    if (api.baseUrl != null && !isStr(api.baseUrl)) errors.push('api.baseUrl 必须是字符串');
    if (api.model != null && !isStr(api.model)) errors.push('api.model 必须是字符串');
    if (api.reasoningModel != null && !isStr(api.reasoningModel)) errors.push('api.reasoningModel 必须是字符串');
    if (api.timeoutMs != null && !isPosNum(api.timeoutMs)) errors.push('api.timeoutMs 必须是正数');
    if (api.maxRetries != null && !isNum(api.maxRetries)) errors.push('api.maxRetries 必须是数字');
  }
  const grp = obj.group;
  if (grp != null) {
    if (grp.mode != null && !['smart', 'at', 'all'].includes(grp.mode)) errors.push('group.mode 必须是 smart|at|all');
    if (grp.replyProbability != null && !(isNum(grp.replyProbability) && grp.replyProbability >= 0 && grp.replyProbability <= 100)) errors.push('group.replyProbability 必须 0-100');
  }
  const person = obj.personality;
  if (person != null) {
    if (person.name != null && !isStr(person.name)) errors.push('personality.name 必须是字符串');
    if (person.defaultResponseLength != null && !['short', 'normal', 'long'].includes(person.defaultResponseLength)) errors.push('personality.defaultResponseLength 必须是 short|normal|long');
  }
  const admin = obj.admin;
  if (admin != null && admin.qq != null) {
    if (!Array.isArray(admin.qq) || !admin.qq.every((x) => typeof x === 'number')) errors.push('admin.qq 必须是数字数组');
  }
  return { valid: errors.length === 0, errors };
}

/** 原子写入：先写临时文件再 rename，失败不破坏原文件。 */
function writeRaw(botDir, obj) {
  const p = configPath(botDir);
  const tmp = p + '.tmp.' + process.pid;
  const text = JSON.stringify(obj, null, 2);
  try {
    fs.writeFileSync(tmp, text, 'utf-8');
    fs.renameSync(tmp, p);
    return { ok: true, path: p, error: null };
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    return { ok: false, path: p, error: e.message };
  }
}

/** 高级写入：merge + 校验 + 原子写。返回 {ok, validated, errors, path}。 */
function applyConfig(botDir, partial, { validate = true } = {}) {
  const merged = mergePartial(botDir, partial);
  if (validate) {
    const v = validateConfig(merged);
    if (!v.valid) return { ok: false, validated: false, errors: v.errors, path: configPath(botDir) };
  }
  const w = writeRaw(botDir, merged);
  return { ok: w.ok, validated: true, errors: w.ok ? [] : [w.error], path: w.path };
}

module.exports = {
  configPath, deepMerge, readRaw, mergePartial, validateConfig, writeRaw, applyConfig,
};
