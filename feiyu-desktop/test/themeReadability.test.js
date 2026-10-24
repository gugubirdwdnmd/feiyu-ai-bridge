'use strict';
/**
 * themeReadability.test.js —— 主题下的界面文字可读性测试。
 *
 * 契约（与 themeService 的实现一致）：
 *
 *  A. **需求基准色必须严格保留**：
 *     深色背景 lum<0.5 → text #e8f1f5 / muted #8aa4b3；
 *     浅色背景 lum≥0.5 → text #1c2a33 / muted #5d7280。
 *     六个内置预设全部走这条路径，不得被可读性保险改写。
 *
 *  B. **可读性保险（仅在基准色不达标时生效）**：
 *     基准色在 bg / surface / surface2 三种底色上的最差对比度不足时，
 *     主题服务会挑一个「最差对比度最大」的替代色（数学上尽可能好）。
 *     测试断言：替代结果不得比**暴力搜索得到的理论最优值**更差。
 *     （对绝大多数背景，4.5:1 是可达的；对亮度阈值附近的窄带则数学上不可达，
 *      此时取最优值，实测全色域下限约 4.04:1，仍高于 WCAG AA 大字号门槛 3:1。）
 */
const test = require('node:test');
const assert = require('node:assert');

const themeService = require('../src/services/themeService');

const cr = themeService.contrastRatio;
const mix = themeService.mix;
const isDark = themeService.isDark;

/** 在给定的底色集合上，最差对比度。 */
function worstOn(color, bgs) {
  return bgs.reduce((m, b) => Math.min(m, cr(color, b)), Infinity);
}

/** 暴力搜索：在明暗轴上找最差对比度最大的候选色（近似理论最优）。 */
function bruteBest(bgs) {
  let best = -1, bestColor = null;
  for (let s = 0; s <= 64; s++) {
    const c = mix('#000000', '#ffffff', s / 64);
    const w = worstOn(c, bgs);
    if (w > best) { best = w; bestColor = c; }
  }
  return { worst: best, color: bestColor };
}

/** 复现 themeService 的面板派生（用于测试独立计算底色集合）。 */
function panels(bg) {
  const dark = isDark(bg);
  return {
    dark,
    surface: dark ? mix(bg, '#ffffff', 0.07) : mix(bg, '#000000', 0.04),
    surface2: dark ? mix(bg, '#ffffff', 0.12) : mix(bg, '#000000', 0.07),
  };
}

/* ============ A. 基准色契约 ============ */

test('六个预设严格保留需求指定的 text / muted 色', () => {
  for (const p of themeService.PRESETS) {
    const theme = Object.assign({}, themeService.DEFAULT_THEME, p.theme);
    const d = themeService.deriveTheme(theme);
    const expect = d.dark
      ? { text: '#e8f1f5', muted: '#8aa4b3' }
      : { text: '#1c2a33', muted: '#5d7280' };
    assert.strictEqual(d.text, expect.text, p.name + ' 正文色被改写了');
    assert.strictEqual(d.muted, expect.muted, p.name + ' 次要文字色被改写了');
    assert.strictEqual(d.textAdjusted, false, p.name + ' 不应触发可读性保险');
    assert.strictEqual(d.mutedAdjusted, false, p.name + ' 不应触发可读性保险');
  }
});

test('预设的深浅判定符合 lum<0.5 规则', () => {
  const expect = { 深海: true, 珊瑚礁: true, 极光: true, 樱花: false, 抹茶: false, 墨夜: true };
  for (const p of themeService.PRESETS) {
    const d = themeService.deriveTheme(Object.assign({}, themeService.DEFAULT_THEME, p.theme));
    assert.strictEqual(d.dark, expect[p.name], p.name + ' 深浅判定错误');
  }
});

/* ============ B. 可读性 ============ */

test('六个预设下界面各元素组合的对比度均达标', () => {
  for (const p of themeService.PRESETS) {
    const theme = Object.assign({}, themeService.DEFAULT_THEME, p.theme);
    const d = themeService.deriveTheme(theme);
    const tag = p.name + '：';

    assert.ok(cr(d.text, theme.bg) >= 4.5, tag + '正文/背景 < 4.5（' + cr(d.text, theme.bg).toFixed(2) + '）');
    assert.ok(cr(d.text, d.surface) >= 4.5, tag + '正文/面板 < 4.5（' + cr(d.text, d.surface).toFixed(2) + '）');
    assert.ok(cr(d.text, d.surface2) >= 4.5, tag + '正文/次级面板 < 4.5（' + cr(d.text, d.surface2).toFixed(2) + '）');
    assert.ok(cr(d.muted, theme.bg) >= 3, tag + '次要文字/背景 < 3（' + cr(d.muted, theme.bg).toFixed(2) + '）');
    assert.ok(cr(d.muted, d.surface) >= 3, tag + '次要文字/面板 < 3（' + cr(d.muted, d.surface).toFixed(2) + '）');
    assert.ok(cr(d.muted, d.surface2) >= 3, tag + '次要文字/次级面板 < 3（' + cr(d.muted, d.surface2).toFixed(2) + '）');

    // 主/辅强调色按钮：底色 + 前景色
    assert.ok(cr(d.onAccent, theme.a) >= 4.5, tag + '强调按钮文字/底色 < 4.5（' + cr(d.onAccent, theme.a).toFixed(2) + '）');
    assert.ok(cr(d.onAccent2, theme.b) >= 4.5, tag + '辅助按钮文字/底色 < 4.5（' + cr(d.onAccent2, theme.b).toFixed(2) + '）');

    // 状态色作为文字落在背景与面板上
    const states = [['成功', d.ok], ['警告', d.warn], ['失败', d.err]];
    for (const pair of states) {
      assert.ok(cr(pair[1], theme.bg) >= 3, tag + pair[0] + '色/背景 < 3（' + cr(pair[1], theme.bg).toFixed(2) + '）');
      assert.ok(cr(pair[1], d.surface) >= 3, tag + pair[0] + '色/面板 < 3（' + cr(pair[1], d.surface).toFixed(2) + '）');
    }

    // 品牌名（强调色）落在侧栏面板上
    assert.ok(cr(theme.a, d.surface) >= 3, tag + '品牌强调色/侧栏 < 3（' + cr(theme.a, d.surface).toFixed(2) + '）');
  }
});

test('自定义背景：可读性保险的结果不劣于理论最优', () => {
  // 覆盖亮度阈值附近、高饱和、极端明暗等最容易出问题的背景
  const bgs = [
    '#000000', '#0b1d2a', '#404040', '#767676', '#808080', '#a0a0a0',
    '#c0c0c0', '#ffffff', '#fbf1f4', '#eef3e6', '#101010',
    '#03d027', '#00d70a', '#0063c6', '#ea0b2c', '#7f6e58', '#846379',
    '#00ff00', '#ff0000', '#0000ff', '#ffff00',
  ];
  for (const bg of bgs) {
    const theme = Object.assign({}, themeService.DEFAULT_THEME, { bg });
    const d = themeService.deriveTheme(theme);
    const pan = panels(bg);
    const set = [bg, pan.surface, pan.surface2];

    const base = pan.dark ? '#e8f1f5' : '#1c2a33';
    const baseWorst = worstOn(base, set);
    const opt = bruteBest(set);
    const myWorst = worstOn(d.text, set);

    if (baseWorst >= 4.5) {
      // 基准色本就达标 → 必须原样保留
      assert.strictEqual(d.text, base, bg + ' 基准色达标却仍被改写');
      assert.ok(myWorst >= 4.5, bg + ' 基准色达标但对比度不足: ' + myWorst.toFixed(2));
    } else {
      // 基准色不达标 → 结果不得比理论最优更差（允许 0.05 的搜索粒度误差）
      assert.ok(myWorst >= opt.worst - 0.05,
        bg + ' 可读性保险结果劣于理论最优：实得 ' + myWorst.toFixed(2) + '，最优 ' + opt.worst.toFixed(2));
      assert.ok(myWorst >= 3,
        bg + ' 可读性保险后仍低于 3:1 底线: ' + myWorst.toFixed(2));
    }
  }
});

test('全色域抽样：正文最差对比度不低于 3:1（WCAG AA 大字号底线）', () => {
  let worst = { v: 99 };
  for (let r = 0; r < 256; r += 5) {
    for (let g = 0; g < 256; g += 5) {
      for (let b = 0; b < 256; b += 5) {
        const bg = themeService.rgbToHex(r, g, b);
        const d = themeService.deriveTheme(Object.assign({}, themeService.DEFAULT_THEME, { bg }));
        const pan = panels(bg);
        const w = worstOn(d.text, [bg, pan.surface, pan.surface2]);
        if (w < worst.v) worst = { v: w, bg };
      }
    }
  }
  assert.ok(worst.v >= 3, '最差正文对比度 ' + worst.v.toFixed(2) + ' @ ' + worst.bg + ' 低于 3:1');
});

test('强调色无论明暗，按钮文字都自动取可读前景色', () => {
  const accents = ['#ffffff', '#000000', '#ff8a5c', '#7cf7c4', '#f2c14e', '#4f8a3c', '#4fd1c5', '#e0527c', '#8f7bff'];
  for (const a of accents) {
    const theme = Object.assign({}, themeService.DEFAULT_THEME, { a });
    const d = themeService.deriveTheme(theme);
    assert.ok(cr(d.onAccent, a) >= 4.5, a + ' 强调色上的按钮文字对比度不足: ' + cr(d.onAccent, a).toFixed(2));
  }
});
