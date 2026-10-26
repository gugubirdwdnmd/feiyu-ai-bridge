'use strict';
/**
 * theme.js —— 渲染进程的主题运行时。
 *
 * 职责：
 *  1. 把 Main 进程算好的派生值写进 CSS 变量（--bg --accent --accent2 --surface
 *     --text --muted --radius --blur --speed 等），界面全部改用变量，不再写死颜色。
 *  2. 背景动画：none / bubbles / aurora / waves，速度受 --speed 控制（0.3~2.5）。
 *
 * 节能与无障碍约束（硬要求）：
 *  - 命中 prefers-reduced-motion: reduce 时**不启动动画循环**（只画一帧静态图）。
 *  - 窗口最小化 / 隐藏 / 失焦时**暂停 canvas 循环**，避免空耗 CPU。
 */
(function () {
  const VAR_KEYS = [
    '--bg', '--accent', '--accent2', '--surface', '--text', '--muted',
    '--radius', '--blur', '--speed', '--surface2', '--line',
    '--on-accent', '--on-accent2', '--glass', '--ok', '--warn', '--err',
  ];

  let canvas = null;
  let ctx = null;
  let raf = 0;
  let running = false;
  let lastTs = 0;
  let fx = 'none';
  let speed = 1;
  let palette = { bg: '#0b1d2a', a: '#ff8a5c', b: '#4fd1c5' };
  let bubbles = [];
  // 鼠标视差：tgt 为目标归一化坐标(-1..1)，par 为当前平滑偏移；指数缓动逼近 → 丝滑
  let parOn = true;
  let tgtX = 0, tgtY = 0;
  let parX = 0, parY = 0;

  /** 是否命中「减少动态效果」系统偏好。 */
  function reducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (_) { return false; }
  }

  /** 窗口是否处于最小化 / 隐藏 / 失焦状态（此时应暂停动画）。 */
  function windowInactive() {
    if (typeof document !== 'undefined' && document.hidden) return true;
    return !!(window.__feiyuWindowInactive);
  }

  function ensureCanvas() {
    if (canvas && canvas.isConnected) return canvas;
    canvas = document.getElementById('bgCanvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'bgCanvas';
      document.body.insertBefore(canvas, document.body.firstChild);
    }
    ctx = canvas.getContext('2d');
    resize();
    return canvas;
  }

  function resize() {
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = window.innerWidth, h = window.innerHeight;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** 把派生颜色写进 CSS 变量。 */
  function applyVars(derived, theme) {
    const root = document.documentElement;
    const vars = (derived && derived.cssVars) || {};
    for (const k of VAR_KEYS) {
      const v = vars[k];
      if (v != null) root.style.setProperty(k, String(v));
    }
    if (theme) {
      if (theme.radius != null) root.style.setProperty('--radius', theme.radius + 'px');
      if (theme.blur != null) root.style.setProperty('--blur', theme.blur + 'px');
      if (theme.speed != null) root.style.setProperty('--speed', String(theme.speed));
    }
    root.setAttribute('data-theme-fx', fx);
  }

  function hexToRgb(hex) {
    const h = String(hex || '#000000').replace('#', '');
    return {
      r: parseInt(h.slice(0, 2), 16) || 0,
      g: parseInt(h.slice(2, 4), 16) || 0,
      b: parseInt(h.slice(4, 6), 16) || 0,
    };
  }
  function rgba(hex, a) {
    const c = hexToRgb(hex);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
  }

  function seedBubbles() {
    const w = window.innerWidth, h = window.innerHeight;
    const n = Math.max(10, Math.min(38, Math.round((w * h) / 46000)));
    bubbles = [];
    for (let i = 0; i < n; i++) {
      bubbles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        r: 6 + Math.random() * 34,
        v: 0.25 + Math.random() * 0.85,
        d: Math.random() * Math.PI * 2,
        o: 0.05 + Math.random() * 0.13,
      });
    }
  }

  function drawFrame(ts) {
    if (!ctx) return;
    const w = window.innerWidth, h = window.innerHeight;
    const dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 0;
    lastTs = ts;
    const k = Math.max(0.3, Math.min(2.5, speed));

    // 鼠标视差：指数缓动（帧率无关）逼近目标，丝滑无跳变；关闭/减少动态时平滑归零
    if (parOn && !reducedMotion()) {
      const ease = 1 - Math.exp(-dt * 7);
      parX += (tgtX - parX) * ease;
      parY += (tgtY - parY) * ease;
    } else {
      const back = 1 - Math.exp(-dt * 4);
      parX += (0 - parX) * back;
      parY += (0 - parY) * back;
    }

    ctx.clearRect(0, 0, w, h);

    if (fx === 'bubbles') {
      const ox = parX * 34, oy = parY * 26;
      for (const b of bubbles) {
        b.y -= b.v * 14 * k * dt;
        b.d += 0.4 * dt;
        b.x += Math.sin(b.d) * 8 * k * dt;
        if (b.y + b.r < 0) { b.y = h + b.r; b.x = Math.random() * w; }
        const color = b.o > 0.1 ? palette.a : palette.b;
        const cx = b.x + ox, cy = b.y + oy;
        // 柔和径向渐变，比纯色圆更通透（观感提升）
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, b.r);
        g.addColorStop(0, rgba(color, Math.min(0.9, b.o * 1.2)));
        g.addColorStop(0.6, rgba(color, b.o * 0.55));
        g.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, b.r, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (fx === 'aurora') {
      const t = ts / 1000 * k;
      const px = parX * w * 0.06, py = parY * h * 0.06;
      const blob = (cx, cy, rad, color, alpha) => {
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
        g.addColorStop(0, rgba(color, alpha));
        g.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      };
      blob(w * (0.28 + 0.16 * Math.sin(t * 0.42)) + px, h * (0.34 + 0.12 * Math.cos(t * 0.33)) + py, Math.max(w, h) * 0.48, palette.a, 0.20);
      blob(w * (0.74 + 0.14 * Math.cos(t * 0.31)) + px, h * (0.62 + 0.14 * Math.sin(t * 0.27)) + py, Math.max(w, h) * 0.44, palette.b, 0.18);
    } else if (fx === 'waves') {
      const t = ts / 1000 * k;
      const band = 46;
      const off = (t * 46) % band + parX * band * 1.4;
      ctx.save();
      ctx.globalAlpha = 0.10;
      for (let i = -band; i < w + band; i += band) {
        ctx.fillStyle = (i / band) % 2 === 0 ? palette.a : palette.b;
        ctx.beginPath();
        const x = i + off;
        ctx.moveTo(x, 0);
        ctx.lineTo(x + band * 0.5, 0);
        ctx.lineTo(x + band * 0.5 - h * 0.35, h);
        ctx.lineTo(x - h * 0.35, h);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function loop(ts) {
    if (!running) return;
    drawFrame(ts);
    raf = window.requestAnimationFrame(loop);
  }

  /** 启动动画循环。命中减少动态效果偏好时只画静态一帧，不启动 rAF。 */
  function start() {
    stop();
    ensureCanvas();
    if (fx === 'none') { if (ctx) ctx.clearRect(0, 0, window.innerWidth, window.innerHeight); return; }
    if (reducedMotion()) {
      // 减少动态效果：画一帧静态画面，绝不启动循环
      lastTs = 0;
      drawFrame(0);
      return;
    }
    if (!bubbles.length) seedBubbles();
    running = true;
    lastTs = 0;
    raf = window.requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    if (raf) { window.cancelAnimationFrame(raf); raf = 0; }
  }

  /** 应用主题（派生值 + 动画参数）。 */
  function apply(theme, derived) {
    fx = (theme && theme.fx) || 'none';
    speed = (theme && theme.speed) != null ? theme.speed : 1;
    // 鼠标视差默认开启；主题显式关闭时停止跟随并把偏移平滑归零
    parOn = !(theme && theme.mouseParallax === false);
    if (!parOn) { tgtX = 0; tgtY = 0; }
    palette = { bg: (theme && theme.bg) || palette.bg, a: (theme && theme.a) || palette.a, b: (theme && theme.b) || palette.b };
    applyVars(derived, theme);
    if (document.body) {
      document.body.setAttribute('data-fx', fx);
      document.body.setAttribute('data-mon-fx', (theme && theme.monFx) || 'breathe');
    }
    start();
  }

  window.addEventListener('resize', () => { resize(); if (fx === 'bubbles') seedBubbles(); });
  // 窗口隐藏 / 最小化 → 暂停；恢复可见 → 继续（减少动态效果偏好下不启动）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else if (!reducedMotion()) start();
  });
  window.addEventListener('blur', () => { window.__feiyuWindowInactive = true; stop(); });
  window.addEventListener('focus', () => { window.__feiyuWindowInactive = false; if (!reducedMotion()) start(); });

  // 鼠标位置 → 目标归一化坐标（-1..1）；真正平滑在每帧 drawFrame 里做指数缓动
  window.addEventListener('mousemove', (e) => {
    if (!parOn) return;
    try {
      const w = window.innerWidth || 1, h = window.innerHeight || 1;
      tgtX = (e.clientX / w - 0.5) * 2;
      tgtY = (e.clientY / h - 0.5) * 2;
    } catch (_) {}
  }, { passive: true });

  window.FeiyuTheme = {
    apply, applyVars, start, stop, reducedMotion,
    setMouseParallax(on) { parOn = !!on; if (!parOn) { tgtX = 0; tgtY = 0; } },
    get state() { return { fx, speed, running, reduced: reducedMotion(), parOn }; },
  };
})();
