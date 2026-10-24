'use strict';
/**
 * themeService.test.js —— 主题工坊（v1.1.0）单元测试。
 *
 * 覆盖：
 *  - 校验函数：合法/非法颜色、非法枚举、越界数值、未知字段、原型污染键
 *  - 颜色推算：深浅判断、对比度下限、预设完整性
 *  - 持久化：写后读回一致、文件损坏回退默认、缺失回退默认、写入失败不留半写文件
 *  - 隔离：保存主题前后 ai_config.json / secrets.json 的 SHA-256 完全不变
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const themeService = require('../src/services/themeService');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'theme-svc-'));
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/* ================= 校验 ================= */

test('validateTheme: 合法主题通过校验并被规范化', () => {
  const v = themeService.validateTheme({ bg: '#0B1D2A', a: '#ff8a5c', b: '#4fd1c5', fx: 'aurora', speed: 1.5, radius: 20, blur: 10 });
  assert.strictEqual(v.valid, true, v.errors.join('；'));
  assert.strictEqual(v.theme.bg, '#0b1d2a', '颜色应统一小写');
  assert.strictEqual(v.theme.fx, 'aurora');
  assert.strictEqual(v.theme.speed, 1.5);
});

test('validateTheme: 缺失 bg/a/b 被拒', () => {
  for (const missing of ['bg', 'a', 'b']) {
    const obj = { bg: '#000000', a: '#111111', b: '#222222' };
    delete obj[missing];
    const v = themeService.validateTheme(obj);
    assert.strictEqual(v.valid, false, missing + ' 缺失应被拒');
    assert.ok(v.errors.some((e) => e.includes(missing)));
  }
});

test('validateTheme: 非法颜色格式一律被拒', () => {
  const bad = ['#fff', '#12345', 'red', 'rgb(0,0,0)', '#12345g', '#1234567', '', '  ', null, 123, {}];
  for (const c of bad) {
    const v = themeService.validateTheme({ bg: c, a: '#111111', b: '#222222' });
    assert.strictEqual(v.valid, false, '颜色 ' + JSON.stringify(c) + ' 应被拒');
  }
});

test('validateTheme: 非法 fx 枚举被拒', () => {
  for (const fx of ['fire', 'BUBBLES', '', 123, null]) {
    const v = themeService.validateTheme({ bg: '#000000', a: '#111111', b: '#222222', fx });
    assert.strictEqual(v.valid, false, 'fx ' + JSON.stringify(fx) + ' 应被拒');
    assert.ok(v.errors.some((e) => e.includes('fx')));
  }
});

test('validateTheme: fx 合法枚举全部接受', () => {
  for (const fx of themeService.FX_VALUES) {
    const v = themeService.validateTheme({ bg: '#000000', a: '#111111', b: '#222222', fx });
    assert.strictEqual(v.valid, true, fx + ' 应通过');
    assert.strictEqual(v.theme.fx, fx);
  }
});

test('validateTheme: 越界数值被 clamp 到范围内', () => {
  const v = themeService.validateTheme({ bg: '#000000', a: '#111111', b: '#222222', speed: 99, radius: 999, blur: -50 });
  assert.strictEqual(v.valid, true);
  assert.strictEqual(v.theme.speed, 2.5, 'speed 上限 2.5');
  assert.strictEqual(v.theme.radius, 28, 'radius 上限 28');
  assert.strictEqual(v.theme.blur, 0, 'blur 下限 0');

  const v2 = themeService.validateTheme({ bg: '#000000', a: '#111111', b: '#222222', speed: 0.01, radius: -3, blur: 999 });
  assert.strictEqual(v2.theme.speed, 0.3, 'speed 下限 0.3');
  assert.strictEqual(v2.theme.radius, 4, 'radius 下限 4');
  assert.strictEqual(v2.theme.blur, 30, 'blur 上限 30');
});

test('validateTheme: 未知字段被丢弃且不进入结果', () => {
  const v = themeService.validateTheme({ bg: '#000000', a: '#111111', b: '#222222', hack: 'x', __extra: 1, path: 'C:/secret' });
  assert.strictEqual(v.valid, true);
  assert.deepStrictEqual(Object.keys(v.theme).sort(), ['a', 'b', 'bg', 'blur', 'fx', 'radius', 'speed']);
  assert.strictEqual(v.theme.hack, undefined);
  assert.strictEqual(v.theme.path, undefined);
  assert.ok(v.warnings.some((w) => w.includes('未知字段')));
});

test('validateTheme: 原型污染键被剔除，不污染 Object.prototype', () => {
  const payload = JSON.parse('{"bg":"#000000","a":"#111111","b":"#222222","__proto__":{"polluted":true},"constructor":{"x":1},"prototype":{"y":2}}');
  const v = themeService.validateTheme(payload);
  assert.strictEqual(v.valid, true, v.errors.join('；'));
  assert.strictEqual({}.polluted, undefined, 'Object.prototype 不得被污染');
  assert.strictEqual(Object.prototype.polluted, undefined);
  assert.strictEqual(v.theme.polluted, undefined);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(v.theme, '__proto__'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(v.theme, 'constructor'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(v.theme, 'prototype'), false);
  assert.ok(v.warnings.some((w) => w.includes('不安全字段')));
});

test('validateTheme: 非对象输入被拒', () => {
  for (const x of [null, undefined, 42, 'str', [1, 2, 3]]) {
    const v = themeService.validateTheme(x);
    assert.strictEqual(v.valid, false, JSON.stringify(x) + ' 应被拒');
  }
});

/* ================= 颜色推算 ================= */

test('isDark: 按 lum = (0.299R+0.587G+0.114B)/255 判定，阈值 0.5', () => {
  assert.strictEqual(themeService.isDark('#000000'), true);
  assert.strictEqual(themeService.isDark('#ffffff'), false);
  assert.strictEqual(themeService.isDark('#0b1d2a'), true);
  assert.strictEqual(themeService.isDark('#fbf1f4'), false);
  // 手工核算一个中间值
  const hex = '#808080';
  const { r, g, b } = themeService.hexToRgb(hex);
  const expect = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  assert.ok(Math.abs(themeService.luminance(hex) - expect) < 1e-9);
});

test('deriveTheme: 深色背景 → surface 向白 7%、text #e8f1f5、muted #8aa4b3', () => {
  const theme = Object.assign({}, themeService.DEFAULT_THEME, { bg: '#0b1d2a' });
  const d = themeService.deriveTheme(theme);
  assert.strictEqual(d.dark, true);
  assert.strictEqual(d.text, '#e8f1f5');
  assert.strictEqual(d.muted, '#8aa4b3');
  // surface = bg 向白混合 7%
  const expect = themeService.mix('#0b1d2a', '#ffffff', 0.07);
  assert.strictEqual(d.surface, expect);
  // surface 应比 bg 更亮
  assert.ok(themeService.luminance(d.surface) > themeService.luminance('#0b1d2a'));
});

test('deriveTheme: 浅色背景 → surface 向黑 4%、text #1c2a33、muted #5d7280', () => {
  const theme = Object.assign({}, themeService.DEFAULT_THEME, { bg: '#fbf1f4' });
  const d = themeService.deriveTheme(theme);
  assert.strictEqual(d.dark, false);
  assert.strictEqual(d.text, '#1c2a33');
  assert.strictEqual(d.muted, '#5d7280');
  const expect = themeService.mix('#fbf1f4', '#000000', 0.04);
  assert.strictEqual(d.surface, expect);
  assert.ok(themeService.luminance(d.surface) < themeService.luminance('#fbf1f4'));
});

test('deriveTheme: surface 混合比例严格按需求（深色向白 7%、浅色向黑 4%）', () => {
  for (const [bg, dark] of [['#0b1d2a', true], ['#fbf1f4', false], ['#101010', true], ['#eef3e6', false]]) {
    const d = themeService.deriveTheme(Object.assign({}, themeService.DEFAULT_THEME, { bg }));
    const expect = dark ? themeService.mix(bg, '#ffffff', 0.07) : themeService.mix(bg, '#000000', 0.04);
    assert.strictEqual(d.surface, expect, bg + ' surface 混合比例不符');
  }
});

test('deriveTheme: 正文与背景对比度达到可读下限（浅色主题也不糊）', () => {
  for (const p of themeService.PRESETS) {
    const theme = Object.assign({}, themeService.DEFAULT_THEME, p.theme);
    const d = themeService.deriveTheme(theme);
    const cText = themeService.contrastRatio(d.text, theme.bg);
    const cMuted = themeService.contrastRatio(d.muted, theme.bg);
    assert.ok(cText >= 4.5, p.name + ' 正文对比度 ' + cText.toFixed(2) + ' < 4.5');
    assert.ok(cMuted >= 3, p.name + ' 次要文字对比度 ' + cMuted.toFixed(2) + ' < 3');
    // 正文与面板色也要区分得开
    assert.ok(themeService.contrastRatio(d.text, d.surface) >= 4.5, p.name + ' 正文 vs 面板对比度不足');
  }
});

test('deriveTheme: cssVars 覆盖需求指定的全部变量', () => {
  const d = themeService.deriveTheme(themeService.DEFAULT_THEME);
  for (const k of ['--bg', '--accent', '--accent2', '--surface', '--text', '--muted', '--radius', '--blur', '--speed']) {
    assert.ok(d.cssVars[k] != null, '缺少变量 ' + k);
  }
  assert.strictEqual(d.cssVars['--radius'], '16px');
  assert.strictEqual(d.cssVars['--blur'], '14px');
  assert.strictEqual(d.cssVars['--speed'], '1');
});

test('deriveTheme: 强调色上的前景色按对比度自动选黑/白', () => {
  const light = themeService.deriveTheme(Object.assign({}, themeService.DEFAULT_THEME, { a: '#f5f5f5' }));
  assert.strictEqual(light.onAccent, '#111111', '浅强调色上应用深色前景');
  const dark = themeService.deriveTheme(Object.assign({}, themeService.DEFAULT_THEME, { a: '#101010' }));
  assert.strictEqual(dark.onAccent, '#ffffff', '深强调色上应用白色前景');
});

/* ================= 预设完整性 ================= */

test('PRESETS: 恰好 6 套，字段完整且颜色合法', () => {
  assert.strictEqual(themeService.PRESETS.length, 6);
  const keys = new Set();
  for (const p of themeService.PRESETS) {
    assert.ok(p.key && p.name, '预设缺少 key/name');
    assert.ok(!keys.has(p.key), '预设 key 重复: ' + p.key);
    keys.add(p.key);
    for (const c of ['bg', 'a', 'b']) {
      assert.match(p.theme[c], themeService.COLOR_RE, p.key + '.' + c + ' 颜色格式非法');
    }
    const v = themeService.validateTheme(Object.assign({}, themeService.DEFAULT_THEME, p.theme));
    assert.strictEqual(v.valid, true, p.key + ': ' + v.errors.join('；'));
  }
});

test('PRESETS: 六个预设名称与需求一致', () => {
  assert.deepStrictEqual(themeService.PRESETS.map((p) => p.name), ['深海', '珊瑚礁', '极光', '樱花', '抹茶', '墨夜']);
});

test('PRESETS: 需求给定的具体色值逐项核对', () => {
  const expect = {
    deepsea: { bg: '#0b1d2a', a: '#ff8a5c', b: '#4fd1c5' },
    coral: { bg: '#1f1020', a: '#ff6f91', b: '#ffc75f' },
    aurora: { bg: '#0c1424', a: '#7cf7c4', b: '#8f7bff' },
    sakura: { bg: '#fbf1f4', a: '#e0527c', b: '#7aa8e8' },
    matcha: { bg: '#eef3e6', a: '#4f8a3c', b: '#d9a441' },
    ink: { bg: '#101010', a: '#f2c14e', b: '#e5e5e5' },
  };
  for (const p of themeService.PRESETS) {
    assert.deepStrictEqual(Object.assign({}, p.theme), expect[p.key], p.key + ' 色值与需求不符');
  }
});

test('listPresets: 返回预设与派生色，界面可直接渲染色板', () => {
  const list = themeService.listPresets();
  assert.strictEqual(list.length, 6);
  for (const p of list) {
    assert.ok(p.name && p.bg && p.a && p.b);
    assert.strictEqual(typeof p.derived.dark, 'boolean');
    assert.match(p.derived.surface, themeService.COLOR_RE);
  }
});

test('DEFAULT_THEME: 深海 / bubbles / spd 1 / rad 16 / blr 14', () => {
  assert.deepStrictEqual(Object.assign({}, themeService.DEFAULT_THEME), {
    bg: '#0b1d2a', a: '#ff8a5c', b: '#4fd1c5',
    fx: 'bubbles', speed: 1, radius: 16, blur: 14,
  });
});

/* ================= 持久化 ================= */

test('持久化: 写入后读回完全一致', () => {
  const d = tmpDir();
  const theme = { bg: '#1f1020', a: '#ff6f91', b: '#ffc75f', fx: 'aurora', speed: 2, radius: 22, blur: 8 };
  const s = themeService.saveTheme(d, theme);
  assert.strictEqual(s.ok, true, s.error);
  const r = themeService.readTheme(d);
  assert.strictEqual(r.fallback, null);
  assert.deepStrictEqual(r.theme, theme);
  // 文件确实落在 userData/theme.json
  assert.ok(fs.existsSync(path.join(d, 'theme.json')));
  fs.rmSync(d, { recursive: true, force: true });
});

test('持久化: 文件缺失 → 回退默认主题且不抛错', () => {
  const d = tmpDir();
  const r = themeService.readTheme(d);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.fallback, 'missing');
  assert.deepStrictEqual(r.theme, themeService.defaultTheme());
  fs.rmSync(d, { recursive: true, force: true });
});

test('持久化: 文件损坏（非 JSON）→ 回退默认主题', () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'theme.json'), '{ this is not json');
  const r = themeService.readTheme(d);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.fallback, 'corrupt');
  assert.deepStrictEqual(r.theme, themeService.defaultTheme());
  fs.rmSync(d, { recursive: true, force: true });
});

test('持久化: 文件内容非法（颜色/枚举不合法）→ 回退默认主题', () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'theme.json'), JSON.stringify({ bg: 'red', a: '#111111', b: '#222222', fx: 'fire' }));
  const r = themeService.readTheme(d);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.fallback, 'invalid');
  assert.deepStrictEqual(r.theme, themeService.defaultTheme());
  fs.rmSync(d, { recursive: true, force: true });
});

test('持久化: 文件不是对象 → 回退默认主题', () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'theme.json'), '"just a string"');
  const r = themeService.readTheme(d);
  assert.strictEqual(r.fallback, 'invalid');
  assert.deepStrictEqual(r.theme, themeService.defaultTheme());
  fs.rmSync(d, { recursive: true, force: true });
});

test('持久化: 写入过程失败不留半写文件，原文件保持不变', () => {
  const d = tmpDir();
  const good = { bg: '#0b1d2a', a: '#ff8a5c', b: '#4fd1c5', fx: 'bubbles', speed: 1, radius: 16, blur: 14 };
  themeService.saveTheme(d, good);
  const target = path.join(d, 'theme.json');
  const before = fs.readFileSync(target, 'utf-8');

  // 注入故障：writeFileSync 写到一半抛错
  const brokenFs = Object.assign({}, fs, {
    writeFileSync(p, data, enc) {
      if (String(p).includes('theme.json.tmp.')) {
        fs.writeFileSync(p, '{"bg":"#ff0000"', enc);   // 半截内容
        throw new Error('模拟磁盘写入失败');
      }
      return fs.writeFileSync(p, data, enc);
    },
  });
  const w = themeService.writeTheme(d, Object.assign({}, good, { bg: '#ff0000' }), { fs: brokenFs });
  assert.strictEqual(w.ok, false);
  assert.ok(w.error);

  // 不应留下临时文件
  const leftovers = fs.readdirSync(d).filter((f) => f.includes('theme.json.tmp.'));
  assert.deepStrictEqual(leftovers, [], '写入失败后残留临时文件: ' + leftovers.join(','));

  // 原文件内容未被破坏
  assert.strictEqual(fs.readFileSync(target, 'utf-8'), before);
  fs.rmSync(d, { recursive: true, force: true });
});

test('持久化: rename 失败时同样不留临时文件且不破坏原文件', () => {
  const d = tmpDir();
  const good = { bg: '#0b1d2a', a: '#ff8a5c', b: '#4fd1c5', fx: 'bubbles', speed: 1, radius: 16, blur: 14 };
  themeService.saveTheme(d, good);
  const target = path.join(d, 'theme.json');
  const before = fs.readFileSync(target, 'utf-8');
  const brokenFs = Object.assign({}, fs, {
    renameSync() { throw new Error('模拟 rename 失败'); },
  });
  const w = themeService.writeTheme(d, Object.assign({}, good, { bg: '#00ff00' }), { fs: brokenFs });
  assert.strictEqual(w.ok, false);
  const leftovers = fs.readdirSync(d).filter((f) => f.includes('theme.json.tmp.'));
  assert.deepStrictEqual(leftovers, [], 'rename 失败后残留临时文件');
  assert.strictEqual(fs.readFileSync(target, 'utf-8'), before);
  fs.rmSync(d, { recursive: true, force: true });
});

test('持久化: 非法主题写入被拒，不改动已有主题文件', () => {
  const d = tmpDir();
  const good = { bg: '#0b1d2a', a: '#ff8a5c', b: '#4fd1c5', fx: 'bubbles', speed: 1, radius: 16, blur: 14 };
  themeService.saveTheme(d, good);
  const target = path.join(d, 'theme.json');
  const before = fs.readFileSync(target, 'utf-8');
  const r = themeService.saveTheme(d, { bg: 'not-a-color', a: '#111111', b: '#222222' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.length > 0);
  assert.strictEqual(fs.readFileSync(target, 'utf-8'), before, '被拒的写入不得改动文件');
  fs.rmSync(d, { recursive: true, force: true });
});

test('resetTheme: 恢复默认主题', () => {
  const d = tmpDir();
  themeService.saveTheme(d, { bg: '#ffffff', a: '#000000', b: '#111111', fx: 'waves', speed: 2, radius: 8, blur: 2 });
  const r = themeService.resetTheme(d);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.theme, themeService.defaultTheme());
  assert.deepStrictEqual(themeService.readTheme(d).theme, themeService.defaultTheme());
  fs.rmSync(d, { recursive: true, force: true });
});

/* ================= 导出 / 导入 ================= */

test('exportTheme: 导出 JSON 只含白名单字段，无路径/密钥', () => {
  const d = tmpDir();
  themeService.saveTheme(d, { bg: '#0c1424', a: '#7cf7c4', b: '#8f7bff', fx: 'aurora', speed: 1.2, radius: 10, blur: 5 });
  const e = themeService.exportTheme(d);
  assert.strictEqual(e.ok, true);
  const obj = JSON.parse(e.json);
  assert.deepStrictEqual(Object.keys(obj).sort(), ['theme', 'version']);
  assert.deepStrictEqual(Object.keys(obj.theme).sort(), ['a', 'b', 'bg', 'blur', 'fx', 'radius', 'speed']);
  // 不得出现路径或密钥样式的内容
  assert.ok(!/[A-Za-z]:[\\/]/.test(e.json), '导出内容不得含盘符路径');
  assert.ok(!/apiKey|secret|token/i.test(e.json), '导出内容不得含密钥字段');
  fs.rmSync(d, { recursive: true, force: true });
});

test('importTheme: 合法 JSON 应用成功', () => {
  const d = tmpDir();
  const json = JSON.stringify({ version: 1, theme: { bg: '#eef3e6', a: '#4f8a3c', b: '#d9a441', fx: 'none', speed: 0.5, radius: 12, blur: 0 } });
  const r = themeService.importTheme(d, json);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.applied, true);
  assert.deepStrictEqual(themeService.readTheme(d).theme.bg, '#eef3e6');
  fs.rmSync(d, { recursive: true, force: true });
});

test('importTheme: 非法 JSON 不改动当前主题', () => {
  const d = tmpDir();
  const good = { bg: '#0b1d2a', a: '#ff8a5c', b: '#4fd1c5', fx: 'bubbles', speed: 1, radius: 16, blur: 14 };
  themeService.saveTheme(d, good);
  const target = path.join(d, 'theme.json');
  const before = fs.readFileSync(target, 'utf-8');
  const r = themeService.importTheme(d, '{ broken json ');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.applied, false);
  assert.strictEqual(fs.readFileSync(target, 'utf-8'), before, '导入失败不得改动主题文件');
  assert.deepStrictEqual(themeService.readTheme(d).theme, good);
  fs.rmSync(d, { recursive: true, force: true });
});

test('importTheme: 颜色非法时拒绝导入且不改动当前主题', () => {
  const d = tmpDir();
  const good = { bg: '#0b1d2a', a: '#ff8a5c', b: '#4fd1c5', fx: 'bubbles', speed: 1, radius: 16, blur: 14 };
  themeService.saveTheme(d, good);
  const r = themeService.importTheme(d, JSON.stringify({ bg: 'chartreuse', a: '#111111', b: '#222222' }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.applied, false);
  assert.deepStrictEqual(themeService.readTheme(d).theme, good);
  fs.rmSync(d, { recursive: true, force: true });
});

test('importTheme: 未知字段被丢弃，导入结果仍是干净的主题对象', () => {
  const d = tmpDir();
  const r = themeService.importTheme(d, JSON.stringify({ bg: '#101010', a: '#f2c14e', b: '#e5e5e5', evil: 'x', path: 'D:/secret' }));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(Object.keys(r.theme).sort(), ['a', 'b', 'bg', 'blur', 'fx', 'radius', 'speed']);
  assert.strictEqual(r.theme.path, undefined);
  fs.rmSync(d, { recursive: true, force: true });
});

test('importTheme: 导入含 __proto__ 的 JSON 不污染原型', () => {
  const d = tmpDir();
  const r = themeService.importTheme(d, '{"bg":"#101010","a":"#f2c14e","b":"#e5e5e5","__proto__":{"polluted":true}}');
  assert.strictEqual(r.ok, true);
  assert.strictEqual({}.polluted, undefined);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(r.theme, '__proto__'), false);
  fs.rmSync(d, { recursive: true, force: true });
});

/* ================= 隔离性 ================= */

test('隔离: 保存主题前后 ai_config.json / secrets.json 的 SHA-256 完全不变', () => {
  const userData = tmpDir('theme-ud-');
  const botDir = tmpDir('theme-bot-');
  fs.writeFileSync(path.join(botDir, 'ai_config.json'), JSON.stringify({ api: { baseUrl: 'https://example.invalid/v1/chat/completions', model: 'demo' } }, null, 2));
  fs.writeFileSync(path.join(botDir, 'secrets.json'), JSON.stringify({ apiKey: 'sk-simulated-not-a-real-key' }, null, 2));
  fs.writeFileSync(path.join(botDir, 'feiyu_skills.json'), JSON.stringify({ version: 1, skills: [] }, null, 2));

  const cfgPath = path.join(botDir, 'ai_config.json');
  const secPath = path.join(botDir, 'secrets.json');
  const skPath = path.join(botDir, 'feiyu_skills.json');
  const before = {
    cfg: sha256(cfgPath), sec: sha256(secPath), skill: sha256(skPath),
  };

  const theme = { bg: '#1f1020', a: '#ff6f91', b: '#ffc75f', fx: 'waves', speed: 1.8, radius: 24, blur: 20 };
  assert.strictEqual(themeService.saveTheme(userData, theme).ok, true);
  themeService.resetTheme(userData);
  themeService.importTheme(userData, JSON.stringify(theme));

  assert.strictEqual(sha256(cfgPath), before.cfg, 'ai_config.json 被改动');
  assert.strictEqual(sha256(secPath), before.sec, 'secrets.json 被改动');
  assert.strictEqual(sha256(skPath), before.skill, 'feiyu_skills.json 被改动');

  // 主题文件只落在 userData，且内容不含路径/密钥
  assert.ok(fs.existsSync(path.join(userData, 'theme.json')));
  assert.ok(!fs.existsSync(path.join(botDir, 'theme.json')), '主题不得写进机器人目录');
  const ttext = fs.readFileSync(path.join(userData, 'theme.json'), 'utf-8');
  assert.ok(!/[A-Za-z]:[\\/]/.test(ttext));
  assert.ok(!/apiKey|secret|token/i.test(ttext));

  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(botDir, { recursive: true, force: true });
});

test('隔离: theme.json 与机器人目录文件完全分离（路径不重叠）', () => {
  const userData = tmpDir('theme-ud2-');
  const botDir = tmpDir('theme-bot2-');
  assert.strictEqual(path.resolve(themeService.themePath(userData)), path.resolve(path.join(userData, 'theme.json')));
  assert.notStrictEqual(path.dirname(themeService.themePath(userData)), path.resolve(botDir));
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(botDir, { recursive: true, force: true });
});
