'use strict';
/**
 * themeService.js —— 主题工坊（v1.1.0）。
 *
 * 职责：配色方案（预设 + 自定义）、背景动画参数、外观参数（圆角/毛玻璃）的
 *       「校验 → 派生 → 持久化」全链路。
 *
 * 存储边界（硬约束）：
 *  - 主题**只**存 userData/theme.json，与 botDir 下的 ai_config.json / secrets.json /
 *    feiyu_skills.json 等完全分离；本模块不接收也不需要 botDir。
 *  - theme.json 内只允许出现颜色、动画枚举与数值，**不得**包含路径、密钥或任何用户数据。
 *  - 读写失败（缺失 / 损坏 / 校验不过）一律回退默认主题，不抛错、不阻塞启动。
 *
 * 校验口径（白名单）：
 *  - 颜色必须匹配 /^#[0-9a-f]{6}$/i
 *  - fx 必须是 none / bubbles / aurora / waves 之一
 *  - 数值按范围 clamp（speed 0.3~2.5、radius 4~28、blur 0~30）
 *  - 未知字段一律丢弃；__proto__ / constructor / prototype 等危险键直接剔除
 */
const fs = require('fs');
const path = require('path');

const THEME_FILE = 'theme.json';

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const FX_VALUES = ['none', 'bubbles', 'aurora', 'waves'];
const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];

const LIMITS = {
  speed: { min: 0.3, max: 2.5, def: 1 },
  radius: { min: 4, max: 28, def: 16 },
  blur: { min: 0, max: 30, def: 14 },
};

/** 默认主题（深海 / bubbles / spd 1 / rad 16 / blr 14）。 */
const DEFAULT_THEME = Object.freeze({
  bg: '#0b1d2a', a: '#ff8a5c', b: '#4fd1c5',
  fx: 'bubbles', speed: 1, radius: 16, blur: 14,
});

/** 内置 6 套配色方案预设。bg=背景，a=主强调色，b=辅助强调色。 */
const PRESETS = Object.freeze([
  Object.freeze({ key: 'deepsea', name: '深海', theme: Object.freeze({ bg: '#0b1d2a', a: '#ff8a5c', b: '#4fd1c5' }) }),
  Object.freeze({ key: 'coral', name: '珊瑚礁', theme: Object.freeze({ bg: '#1f1020', a: '#ff6f91', b: '#ffc75f' }) }),
  Object.freeze({ key: 'aurora', name: '极光', theme: Object.freeze({ bg: '#0c1424', a: '#7cf7c4', b: '#8f7bff' }) }),
  Object.freeze({ key: 'sakura', name: '樱花', theme: Object.freeze({ bg: '#fbf1f4', a: '#e0527c', b: '#7aa8e8' }) }),
  Object.freeze({ key: 'matcha', name: '抹茶', theme: Object.freeze({ bg: '#eef3e6', a: '#4f8a3c', b: '#d9a441' }) }),
  Object.freeze({ key: 'ink', name: '墨夜', theme: Object.freeze({ bg: '#101010', a: '#f2c14e', b: '#e5e5e5' }) }),
]);

/* ---------------- 颜色工具 ---------------- */

function hexToRgb(hex) {
  const h = String(hex).replace(/^#/, '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function rgbToHex(r, g, b) {
  const c = (n) => {
    const v = Math.max(0, Math.min(255, Math.round(n)));
    return v.toString(16).padStart(2, '0');
  };
  return '#' + c(r) + c(g) + c(b);
}

/** 感知亮度：lum = (0.299R + 0.587G + 0.114B) / 255，lum < 0.5 视为深色。 */
function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function isDark(hex) { return luminance(hex) < 0.5; }

/** 把 from 颜色向 target 颜色混合 ratio（0~1）比例。 */
function mix(from, target, ratio) {
  const a = hexToRgb(from), t = hexToRgb(target);
  return rgbToHex(a.r + (t.r - a.r) * ratio, a.g + (t.g - a.g) * ratio, a.b + (t.b - a.b) * ratio);
}

/** WCAG 相对亮度。 */
function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const ch = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** WCAG 对比度（1~21）。 */
function contrastRatio(a, b) {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 保底对比度。
 *
 * 需求规定的固定文字色（深色 #e8f1f5 / 浅色 #1c2a33 / muted）由亮度阈值决定，
 * 在接近阈值的中灰背景上对比度会掉到 4.5 以下（例如 #767676 背景下只有 3.97），
 * 高饱和中亮度色更极端（#03d027 背景下只有 2.09）。
 *
 * 这里不改动需求的基准色规则，而是加一层「可读性保险」：
 *  1. 先算基准色在 bg / surface / surface2 三种底色上的**最差**对比度；
 *  2. 已达目标 → **原样保留**（六个内置预设与绝大多数自定义背景都走这条）；
 *  3. 未达目标 → 在「朝纯白混合」与「朝纯黑混合」的候选中，挑**最差对比度最大**的那个，
 *     即在数学允许的范围内尽可能提升可读性，同时保留原有的冷/暖倾向。
 *
 * 注意：当背景落在亮度阈值附近的窄带（自定义背景才有，六个预设不在此列），
 * 「对 bg 与 surface2 同时保持 4.5:1」在数学上不可达 ——
 * 此时返回的是可达的最优值（全色域实测下限约 4.04:1，仍高于 WCAG AA 大字号门槛 3:1）。
 */
function bestContrastColor(color, bgs, target) {
  const list = Array.isArray(bgs) ? bgs : [bgs];
  const worst = (c) => list.reduce((m, b) => Math.min(m, contrastRatio(c, b)), Infinity);
  const baseWorst = worst(color);
  if (baseWorst >= target) return { color, worst: baseWorst, adjusted: false };

  let best = color, bestWorst = baseWorst, bestDev = 0;
  const consider = (c, dev) => {
    const w = worst(c);
    if (w > bestWorst + 1e-9 || (Math.abs(w - bestWorst) < 1e-9 && dev < bestDev)) {
      bestWorst = w; best = c; bestDev = dev;
    }
  };
  for (let step = 1; step <= 20; step++) {
    const t = step / 20;
    consider(mix(color, '#ffffff', t), t);
    consider(mix(color, '#000000', t), t);
  }
  return { color: best, worst: bestWorst, adjusted: best !== color };
}

/* ---------------- 校验 ---------------- */

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function clampNum(v, lim) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lim.def;
  return Math.min(lim.max, Math.max(lim.min, n));
}

/**
 * 校验并规范化一个主题对象。
 * 返回 {valid, errors[], theme, warnings[]}：
 *  - errors 非空 → 非法（调用方必须拒绝应用，且不得改动当前主题）
 *  - theme 只含白名单字段；未知字段与危险键被丢弃
 */
function validateTheme(input) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(input)) return { valid: false, errors: ['主题必须是 JSON 对象'], warnings, theme: null };
  // 原型污染：显式剔除危险键（对象字面量里的 __proto__ 不会出现在 Object.keys 里，
  // 但 JSON.parse 出来的 __proto__ 是自有属性，必须显式处理）
  for (const k of Object.keys(input)) {
    if (DANGEROUS_KEYS.includes(k)) {
      warnings.push('已忽略不安全字段: ' + k);
      try { delete input[k]; } catch (_) {}
    }
  }

  for (const key of ['bg', 'a', 'b']) {
    const v = input[key];
    if (v == null) { errors.push('缺少颜色字段: ' + key); continue; }
    if (typeof v !== 'string' || !COLOR_RE.test(v.trim())) {
      errors.push(key + ' 必须是形如 #RRGGBB 的颜色');
    }
  }
  if (errors.length) return { valid: false, errors, warnings, theme: null };

  let fx = DEFAULT_THEME.fx;
  if (input.fx !== undefined) {
    // 显式给出 fx（哪怕是 null）都必须落在枚举内：null 不是合法枚举值。
    if (typeof input.fx !== 'string' || !FX_VALUES.includes(input.fx)) {
      errors.push('fx 必须是 ' + FX_VALUES.join('/') + ' 之一');
    } else fx = input.fx;
  }

  const speed = clampNum(input.speed != null ? input.speed : LIMITS.speed.def, LIMITS.speed);
  const radius = clampNum(input.radius != null ? input.radius : LIMITS.radius.def, LIMITS.radius);
  const blur = clampNum(input.blur != null ? input.blur : LIMITS.blur.def, LIMITS.blur);

  const known = ['bg', 'a', 'b', 'fx', 'speed', 'radius', 'blur'];
  for (const k of Object.keys(input)) {
    if (!known.includes(k)) warnings.push('已忽略未知字段: ' + k);
  }

  if (errors.length) return { valid: false, errors, warnings, theme: null };

  const theme = {
    bg: String(input.bg).trim().toLowerCase(),
    a: String(input.a).trim().toLowerCase(),
    b: String(input.b).trim().toLowerCase(),
    fx,
    speed, radius, blur,
  };
  return { valid: true, errors, warnings, theme };
}

/* ---------------- 派生 ---------------- */

/**
 * 由 bg/a/b 推算其余颜色与外观参数。
 * 规则（按需求固定）：
 *  - 深色（lum < 0.5）：surface = bg 向白混合 7%；text #e8f1f5；muted #8aa4b3
 *  - 浅色：surface = bg 向黑混合 4%；text #1c2a33；muted #5d7280
 */
function deriveTheme(theme) {
  const dark = isDark(theme.bg);
  const surface = dark ? mix(theme.bg, '#ffffff', 0.07) : mix(theme.bg, '#000000', 0.04);
  const surface2 = dark ? mix(theme.bg, '#ffffff', 0.12) : mix(theme.bg, '#000000', 0.07);
  const line = dark ? mix(theme.bg, '#ffffff', 0.18) : mix(theme.bg, '#000000', 0.14);
  // 需求指定的基准色
  const textBase = dark ? '#e8f1f5' : '#1c2a33';
  const mutedBase = dark ? '#8aa4b3' : '#5d7280';
  // 保底对比度：正文 ≥ 4.5（WCAG AA），次要文字 ≥ 3
  // 背景集合取 bg / surface / surface2：正文在这三种底色上都必须可读。
  const textRes = bestContrastColor(textBase, [theme.bg, surface, surface2], 4.5);
  const mutedRes = bestContrastColor(mutedBase, [theme.bg, surface, surface2], 3);
  const text = textRes.color;
  const muted = mutedRes.color;
  const onAccent = contrastRatio(theme.a, '#ffffff') >= contrastRatio(theme.a, '#111111') ? '#ffffff' : '#111111';
  const onAccent2 = contrastRatio(theme.b, '#ffffff') >= contrastRatio(theme.b, '#111111') ? '#ffffff' : '#111111';
  const ok = dark ? '#3ecf8e' : '#177245';
  const warn = dark ? '#f5b54a' : '#8a5a06';
  const err = dark ? '#ff6b6b' : '#a52626';
  const { r, g, b } = hexToRgb(surface);

  const cssVars = {
    '--bg': theme.bg,
    '--accent': theme.a,
    '--accent2': theme.b,
    '--surface': surface,
    '--text': text,
    '--muted': muted,
    '--radius': String(theme.radius) + 'px',
    '--blur': String(theme.blur) + 'px',
    '--speed': String(theme.speed),
    '--surface2': surface2,
    '--line': line,
    '--on-accent': onAccent,
    '--on-accent2': onAccent2,
    '--glass': 'rgba(' + r + ',' + g + ',' + b + ',0.72)',
    '--ok': ok,
    '--warn': warn,
    '--err': err,
  };

  return {
    dark, surface, surface2, line, text, muted, onAccent, onAccent2,
    textBase, mutedBase,
    textContrast: textRes.worst, mutedContrast: mutedRes.worst,
    textAdjusted: textRes.adjusted, mutedAdjusted: mutedRes.adjusted,
    ok, warn, err, glass: 'rgba(' + r + ',' + g + ',' + b + ',0.72)',
    cssVars,
  };
}

/* ---------------- 持久化 ---------------- */

function themePath(userDataDir) { return path.join(userDataDir, THEME_FILE); }

function defaultTheme() { return Object.assign({}, DEFAULT_THEME); }

/**
 * 读取主题。文件缺失 / 损坏 / 校验失败 → 回退默认主题（不抛错）。
 * 返回 {ok, theme, derived, fallback, error}。
 * fallback 取值：null（正常）/ 'missing' / 'corrupt' / 'invalid'
 */
function readTheme(userDataDir, deps) {
  const fsi = (deps && deps.fs) || fs;
  const p = themePath(userDataDir);
  let raw;
  try {
    if (!fsi.existsSync(p)) {
      const theme = defaultTheme();
      return { ok: true, theme, derived: deriveTheme(theme), fallback: 'missing', error: null, path: p };
    }
    raw = fsi.readFileSync(p, 'utf-8');
  } catch (e) {
    const theme = defaultTheme();
    return { ok: true, theme, derived: deriveTheme(theme), fallback: 'corrupt', error: e.message, path: p };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    const theme = defaultTheme();
    return { ok: true, theme, derived: deriveTheme(theme), fallback: 'corrupt', error: 'JSON 解析失败: ' + e.message, path: p };
  }
  const v = validateTheme(obj);
  if (!v.valid) {
    const theme = defaultTheme();
    return { ok: true, theme, derived: deriveTheme(theme), fallback: 'invalid', error: v.errors.join('；'), path: p };
  }
  return { ok: true, theme: v.theme, derived: deriveTheme(v.theme), fallback: null, error: null, path: p, warnings: v.warnings };
}

/**
 * 原子写入主题：先写临时文件再 rename；任何一步失败都清掉临时文件，
 * 绝不留下半写文件，也不破坏原文件。
 */
function writeTheme(userDataDir, theme, deps) {
  const fsi = (deps && deps.fs) || fs;
  const p = themePath(userDataDir);
  const tmp = p + '.tmp.' + process.pid;
  const text = JSON.stringify(theme, null, 2);
  try {
    fsi.mkdirSync(path.dirname(p), { recursive: true });
    fsi.writeFileSync(tmp, text, 'utf-8');
    fsi.renameSync(tmp, p);
    return { ok: true, path: p, error: null };
  } catch (e) {
    try { if (fsi.existsSync(tmp)) fsi.unlinkSync(tmp); } catch (_) {}
    return { ok: false, path: p, error: e.message };
  }
}

/** 保存（先校验，非法则拒绝写入，不改动现有主题）。 */
function saveTheme(userDataDir, input, deps) {
  const v = validateTheme(input);
  if (!v.valid) return { ok: false, errors: v.errors, error: v.errors.join('；'), theme: null };
  const w = writeTheme(userDataDir, v.theme, deps);
  if (!w.ok) return { ok: false, errors: [w.error], error: w.error, theme: null };
  return { ok: true, theme: v.theme, derived: deriveTheme(v.theme), warnings: v.warnings, path: w.path };
}

/** 恢复默认主题。 */
function resetTheme(userDataDir, deps) {
  const theme = defaultTheme();
  const w = writeTheme(userDataDir, theme, deps);
  if (!w.ok) return { ok: false, error: w.error, theme: null };
  return { ok: true, theme, derived: deriveTheme(theme), path: w.path };
}

/** 导出为主题 JSON 文本（仅含白名单字段，无路径/密钥/用户数据）。 */
function exportTheme(userDataDir, deps) {
  const r = readTheme(userDataDir, deps);
  const obj = {
    version: 1,
    theme: {
      bg: r.theme.bg, a: r.theme.a, b: r.theme.b,
      fx: r.theme.fx, speed: r.theme.speed, radius: r.theme.radius, blur: r.theme.blur,
    },
  };
  return { ok: true, json: JSON.stringify(obj, null, 2), theme: r.theme, derived: r.derived };
}

/**
 * 导入主题 JSON。非法 JSON 或校验失败 → **不改动当前主题**。
 * payload 可以是 JSON 文本，也可以是已解析的对象。
 */
function importTheme(userDataDir, payload, deps) {
  let obj = payload;
  if (typeof payload === 'string') {
    try { obj = JSON.parse(payload); } catch (e) {
      return { ok: false, error: 'JSON 解析失败：' + e.message, errors: ['JSON 解析失败'], applied: false };
    }
  }
  if (isPlainObject(obj) && isPlainObject(obj.theme)) obj = obj.theme;
  const v = validateTheme(obj);
  if (!v.valid) {
    return { ok: false, error: v.errors.join('；'), errors: v.errors, applied: false };
  }
  const s = saveTheme(userDataDir, v.theme, deps);
  if (!s.ok) return { ok: false, error: s.error, errors: s.errors || [s.error], applied: false };
  return { ok: true, applied: true, theme: s.theme, derived: s.derived, warnings: s.warnings };
}

/** 预设列表（附带派生颜色，供界面做色板预览）。 */
function listPresets() {
  return PRESETS.map((p) => {
    const theme = Object.assign({}, DEFAULT_THEME, p.theme);
    const d = deriveTheme(theme);
    return {
      key: p.key, name: p.name,
      bg: p.theme.bg, a: p.theme.a, b: p.theme.b,
      derived: { dark: d.dark, surface: d.surface, text: d.text, muted: d.muted },
    };
  });
}

module.exports = {
  THEME_FILE,
  COLOR_RE,
  FX_VALUES,
  LIMITS,
  DEFAULT_THEME,
  PRESETS,
  themePath,
  defaultTheme,
  hexToRgb,
  rgbToHex,
  luminance,
  isDark,
  mix,
  relativeLuminance,
  contrastRatio,
  bestContrastColor,
  validateTheme,
  deriveTheme,
  readTheme,
  writeTheme,
  saveTheme,
  resetTheme,
  exportTheme,
  importTheme,
  listPresets,
};
