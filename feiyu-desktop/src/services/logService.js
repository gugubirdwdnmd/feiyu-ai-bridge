'use strict';
/**
 * logService.js —— ai_bridge.log 的尾部读取、搜索与脱敏。
 * 展示前一律经 redact.js 脱敏（Key / 路径 / 端口 / 内部组件名）。
 */
const fs = require('fs');
const path = require('path');
const { redactText } = require('./redact');

function logPath(botDir) { return path.join(botDir, 'ai_bridge.log'); }

/** 读取尾部 N 行（中文 GBK 日志按 latin1 安全读，避免丢行）。 */
function readTail(botDir, lines = 200) {
  const p = logPath(botDir);
  if (!fs.existsSync(p)) return { exists: false, lines: [], error: null };
  try {
    const buf = fs.readFileSync(p);
    // 尝试 UTF-8，失败回退 latin1（GBK 场景不丢字节）
    let text;
    try { text = buf.toString('utf-8'); } catch (_) { text = buf.toString('latin1'); }
    const all = text.split('\n');
    const tail = all.slice(Math.max(0, all.length - lines));
    return { exists: true, lines: tail.map(redactText), error: null };
  } catch (e) {
    return { exists: true, lines: [], error: '读取失败: ' + e.message };
  }
}

/** 按关键字搜索（不区分大小写），返回脱敏后匹配行。 */
function search(botDir, keyword, { max = 200 } = {}) {
  const p = logPath(botDir);
  if (!fs.existsSync(p)) return { exists: false, lines: [], error: null };
  try {
    const buf = fs.readFileSync(p);
    let text; try { text = buf.toString('utf-8'); } catch (_) { text = buf.toString('latin1'); }
    const kw = String(keyword || '').toLowerCase();
    const out = [];
    for (const raw of text.split('\n')) {
      if (kw && !raw.toLowerCase().includes(kw)) continue;
      out.push(redactText(raw));
      if (out.length >= max) break;
    }
    return { exists: true, lines: out, error: null };
  } catch (e) {
    return { exists: true, lines: [], error: '读取失败: ' + e.message };
  }
}

module.exports = { logPath, readTail, search };
