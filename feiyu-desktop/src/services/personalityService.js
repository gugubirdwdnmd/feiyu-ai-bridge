'use strict';
/**
 * personalityService.js —— ai_prompt.txt（系统提示词 / 人格）的读取与原子写入。
 * 保存即生效（bot 不缓存 system prompt 文件内容），所以写回能真正改变机器人行为。
 */
const fs = require('fs');
const path = require('path');

function personalityPath(botDir) { return path.join(botDir, 'ai_prompt.txt'); }

function read(botDir) {
  const p = personalityPath(botDir);
  if (!fs.existsSync(p)) return { exists: false, content: '', error: null };
  try {
    return { exists: true, content: fs.readFileSync(p, 'utf-8'), error: null };
  } catch (e) {
    return { exists: true, content: '', error: '读取失败: ' + e.message };
  }
}

function write(botDir, content) {
  if (typeof content !== 'string') return { ok: false, error: '内容必须是字符串' };
  const p = personalityPath(botDir);
  const tmp = p + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, p);
    return { ok: true, path: p, error: null };
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    return { ok: false, error: e.message };
  }
}

module.exports = { personalityPath, read, write };
