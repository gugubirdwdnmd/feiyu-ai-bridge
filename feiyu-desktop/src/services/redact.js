'use strict';
/**
 * redact.js —— 共享脱敏规则。
 * 口径与 ai_bridge.js 的 LEAK_RULES 一致：命中只替换片段，不整段丢弃。
 * 用于日志展示、诊断包、导入预览等任何可能暴露敏感的文本。
 */
const PATTERNS = [
  // API Key：sk- 开头长串
  { name: 'apikey', re: /sk-[A-Za-z0-9_-]{12,}/g, mask: 'sk-<KEY>' },
  // Windows 绝对路径（盘符开头，前面不是字母/数字，避免误伤 https://）
  // 字符类必须是 [^\\\s"'<>|]：
  //   - \\ 排除路径分隔符本身
  //   - \s 排除空白（结束当前路径片段）
  // 历史缺陷：曾写成 [^\\s"'<>|]，在字符类里 \s 被当作字面量 's'，
  //   导致首段含 s 的路径（如 D:\some\path、D:\secret\x）完全不被脱敏，
  //   且 C:\Users\me\x 只替换掉 "C:\U"、尾部 "sers\me\x" 泄漏。
  //   与 ai_bridge.js 的 LEAK_RULES.winpath 口径保持一致（那边是 [^\s"'<>|]）。
  { name: 'winpath', re: /(?<![A-Za-z0-9])([A-Za-z]:(?:\\[^\\\s"'<>|]+)+)/g, mask: '<本地路径>' },
  // 本地回环地址 + 端口
  { name: 'localport', re: /(?:127\.0\.0\.1|localhost|0\.0\.0\.0):\d{2,5}/g, mask: '<本地地址>' },
  // 内部组件名
  { name: 'infra', re: /\b(napcat|onebot|ai_bridge|ai_prompt|webui|secrets\.json)\b/gi, mask: '<内部组件>' },
  // 错误栈 / node_modules
  { name: 'stack', re: /\bat\s+[\w$.]+\s*\([^)]*:(\d+):\d+\)|node_modules|(?:TypeError|ReferenceError|SyntaxError|RangeError)\b/g, mask: '<错误栈>' },
  // 系统提示词泄露
  { name: 'promptleak', re: /系统提示词|系统提示|system\s*prompt|我的提示词/g, mask: '<内部配置>' },
  // Authorization 头
  { name: 'authheader', re: /Authorization:\s*Bearer\s+\S+/g, mask: 'Authorization: Bearer <TOKEN>' },
  // secrets.json 里的字段
  { name: 'onebottoken', re: /"onebotToken"\s*:\s*"[^"]*"/g, mask: '"onebotToken":"<TOKEN>"' },
  { name: 'apikeyfield', re: /"apiKey"\s*:\s*"[^"]*"/g, mask: '"apiKey":"<KEY>"' },
  { name: 'imagekeyfield', re: /"imageApiKey"\s*:\s*"[^"]*"/g, mask: '"imageApiKey":"<KEY>"' },
];

/** 对一段文本做脱敏；非字符串安全返回空串。 */
function redactText(text) {
  if (text == null) return '';
  let s = String(text);
  for (const p of PATTERNS) {
    try { s = s.replace(p.re, p.mask); } catch (_) { /* 正则异常不影响其余 */ }
  }
  return s;
}

/** 脱敏一个对象（仅对字符串字段递归脱敏，不改动结构/数字）。 */
function redactObject(obj) {
  if (obj == null) return obj;
  if (typeof obj === 'string') return redactText(obj);
  if (Array.isArray(obj)) return obj.map(redactObject);
  if (typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = redactObject(obj[k]);
    return out;
  }
  return obj;
}

/** 判断一段文本是否「可能含密钥/敏感」，用于诊断包提示。 */
function looksSecret(text) {
  if (text == null) return false;
  const s = String(text);
  return /sk-[A-Za-z0-9_-]{12,}|onebotToken|apiKey|imageApiKey|Authorization:\s*Bearer|D:\\|C:\\Users\\/i.test(s);
}

module.exports = { redactText, redactObject, looksSecret, PATTERNS };
