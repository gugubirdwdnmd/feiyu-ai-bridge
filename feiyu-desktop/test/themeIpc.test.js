'use strict';
/**
 * themeIpc.test.js —— 主题工坊的 IPC 通道白名单与渲染层运行时行为测试。
 *
 * 覆盖：
 *  - ipcChannels：主题通道全部在白名单内、参数校验拒绝非法载荷
 *  - theme.js：prefers-reduced-motion 命中时不启动动画循环；窗口隐藏/失焦时暂停循环
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { CHANNELS, validate } = require('../src/services/ipcChannels');

/* ================= IPC 通道 ================= */

test('ipcChannels: 主题通道已加入现有白名单', () => {
  for (const name of ['THEME_GET', 'THEME_SAVE', 'THEME_RESET', 'THEME_PRESETS', 'THEME_EXPORT', 'THEME_IMPORT']) {
    assert.ok(CHANNELS[name], '缺少通道 ' + name);
    assert.match(CHANNELS[name], /^theme:/);
  }
});

test('ipcChannels: 主题通道参数校验', () => {
  assert.strictEqual(validate(CHANNELS.THEME_GET, undefined).ok, true);
  assert.strictEqual(validate(CHANNELS.THEME_RESET, undefined).ok, true);
  assert.strictEqual(validate(CHANNELS.THEME_PRESETS, undefined).ok, true);
  assert.strictEqual(validate(CHANNELS.THEME_EXPORT, undefined).ok, true);

  // THEME_SAVE 必须带 theme 对象
  assert.strictEqual(validate(CHANNELS.THEME_SAVE, {}).ok, false);
  assert.strictEqual(validate(CHANNELS.THEME_SAVE, { theme: 'x' }).ok, false);
  assert.strictEqual(validate(CHANNELS.THEME_SAVE, { theme: {} }).ok, true);

  // THEME_IMPORT 必须带 JSON 字符串或对象
  assert.strictEqual(validate(CHANNELS.THEME_IMPORT, {}).ok, false);
  assert.strictEqual(validate(CHANNELS.THEME_IMPORT, { json: 123 }).ok, false);
  assert.strictEqual(validate(CHANNELS.THEME_IMPORT, { json: '{}' }).ok, true);
  assert.strictEqual(validate(CHANNELS.THEME_IMPORT, { json: {} }).ok, true);
});

test('ipcChannels: 未知通道仍被拒绝（白名单未被放宽）', () => {
  assert.strictEqual(validate('theme:anything-else', {}).ok, false);
  assert.strictEqual(validate('evil:channel', {}).ok, false);
});

/* ================= 渲染层运行时 ================= */

/** 造一个最小 DOM 桩，用于在 Node 里加载 renderer/theme.js。 */
function makeSandbox(opts) {
  const o = opts || {};
  const listeners = {};
  const rafCalls = { count: 0 };
  const canvas = {
    id: 'bgCanvas', isConnected: true, width: 0, height: 0, style: {},
    getContext: () => ({
      setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {},
      fillRect() {}, save() {}, restore() {}, moveTo() {}, lineTo() {}, closePath() {},
      createRadialGradient: () => ({ addColorStop() {} }),
      set fillStyle(v) {}, get fillStyle() { return '#000'; },
      set globalAlpha(v) {}, get globalAlpha() { return 1; },
    }),
  };
  const rootStyle = { props: {}, setProperty(k, v) { this.props[k] = v; } };
  const root = { style: rootStyle, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const body = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, insertBefore() {}, firstChild: null };
  const win = {
    innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1,
    __feiyuWindowInactive: false,
    matchMedia: (q) => ({ matches: !!(o.reducedMotion && /reduce/.test(q)), media: q }),
    requestAnimationFrame: (fn) => { rafCalls.count++; win.__lastRaf = fn; return rafCalls.count; },
    cancelAnimationFrame: () => { rafCalls.count--; },
    addEventListener: (k, fn) => { (listeners[k] = listeners[k] || []).push(fn); },
  };
  const doc = {
    hidden: false,
    documentElement: root,
    body,
    getElementById: (id) => (id === 'bgCanvas' ? canvas : null),
    createElement: () => canvas,
    addEventListener: (k, fn) => { (listeners[k] = listeners[k] || []).push(fn); },
  };
  const sandbox = { window: win, document: doc, console, Math, Date, JSON, Object, Array, String, Number };
  sandbox.globalThis = sandbox;
  sandbox.window.window = win;
  sandbox.window.document = doc;
  return { sandbox, win, doc, canvas, listeners, rafCalls, root };
}

function loadThemeJs(env) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'theme.js'), 'utf-8');
  vm.createContext(env.sandbox);
  vm.runInContext(src, env.sandbox, { filename: 'theme.js' });
  return env.sandbox.window.FeiyuTheme;
}

test('renderer/theme.js: applyVars 把派生值写进 CSS 变量', () => {
  const env = makeSandbox({});
  const T = loadThemeJs(env);
  const derived = { cssVars: { '--bg': '#101010', '--accent': '#f2c14e', '--text': '#e8f1f5', '--muted': '#8aa4b3' } };
  T.applyVars(derived, { radius: 20, blur: 6, speed: 1.5 });
  const props = env.root.style.props;
  assert.strictEqual(props['--bg'], '#101010');
  assert.strictEqual(props['--accent'], '#f2c14e');
  assert.strictEqual(props['--text'], '#e8f1f5');
  assert.strictEqual(props['--muted'], '#8aa4b3');
  assert.strictEqual(props['--radius'], '20px');
  assert.strictEqual(props['--blur'], '6px');
  assert.strictEqual(props['--speed'], '1.5');
});

test('renderer/theme.js: prefers-reduced-motion 命中时不启动动画循环', () => {
  const env = makeSandbox({ reducedMotion: true });
  const T = loadThemeJs(env);
  T.apply({ bg: '#0b1d2a', a: '#ff8a5c', b: '#4fd1c5', fx: 'bubbles', speed: 1, radius: 16, blur: 14 },
    { cssVars: { '--bg': '#0b1d2a' } });
  assert.strictEqual(env.rafCalls.count, 0, '减少动态效果时不得启动 rAF 循环');
  assert.strictEqual(T.state.running, false);
  assert.strictEqual(T.state.reduced, true);
});

test('renderer/theme.js: 未命中偏好时启动动画循环', () => {
  const env = makeSandbox({ reducedMotion: false });
  const T = loadThemeJs(env);
  T.apply({ bg: '#0b1d2a', a: '#ff8a5c', b: '#4fd1c5', fx: 'bubbles', speed: 1, radius: 16, blur: 14 },
    { cssVars: { '--bg': '#0b1d2a' } });
  assert.ok(env.rafCalls.count > 0, '应已启动 rAF 循环');
  assert.strictEqual(T.state.running, true);
});

test('renderer/theme.js: 窗口隐藏时暂停循环，恢复可见后继续', () => {
  const env = makeSandbox({ reducedMotion: false });
  const T = loadThemeJs(env);
  T.apply({ bg: '#0b1d2a', a: '#ff8a5c', b: '#4fd1c5', fx: 'aurora', speed: 1, radius: 16, blur: 14 },
    { cssVars: {} });
  assert.strictEqual(T.state.running, true);

  const vs = env.listeners['visibilitychange'];
  assert.ok(vs && vs.length, '应注册 visibilitychange 监听');
  env.doc.hidden = true;
  vs[0]();
  assert.strictEqual(T.state.running, false, '窗口隐藏时必须暂停');

  env.doc.hidden = false;
  vs[0]();
  assert.strictEqual(T.state.running, true, '恢复可见后必须继续');
});

test('renderer/theme.js: 窗口失焦时暂停循环，聚焦后继续', () => {
  const env = makeSandbox({ reducedMotion: false });
  const T = loadThemeJs(env);
  T.apply({ bg: '#0b1d2a', a: '#ff8a5c', b: '#4fd1c5', fx: 'waves', speed: 1, radius: 16, blur: 14 }, { cssVars: {} });
  const blurs = env.listeners['blur'];
  const focuses = env.listeners['focus'];
  assert.ok(blurs && blurs.length && focuses && focuses.length);

  blurs[0]();
  assert.strictEqual(T.state.running, false, '失焦时必须暂停');
  focuses[0]();
  assert.strictEqual(T.state.running, true, '聚焦后必须继续');
});

test('renderer/theme.js: fx=none 时不启动循环', () => {
  const env = makeSandbox({ reducedMotion: false });
  const T = loadThemeJs(env);
  T.apply({ bg: '#0b1d2a', a: '#ff8a5c', b: '#4fd1c5', fx: 'none', speed: 1, radius: 16, blur: 14 }, { cssVars: {} });
  assert.strictEqual(env.rafCalls.count, 0);
  assert.strictEqual(T.state.running, false);
});

test('renderer/theme.js: 速度被限制在 0.3~2.5', () => {
  const env = makeSandbox({ reducedMotion: false });
  const T = loadThemeJs(env);
  T.apply({ bg: '#0b1d2a', a: '#ff8a5c', b: '#4fd1c5', fx: 'bubbles', speed: 99, radius: 16, blur: 14 }, { cssVars: {} });
  assert.strictEqual(T.state.speed, 99, 'theme.js 保留原值，clamp 由 Main 端负责');
  assert.strictEqual(env.root.style.props['--speed'], '99');
});
