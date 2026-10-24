'use strict';
/**
 * make-icon.js —— 生成应用图标。
 *
 * 用 SVG 描述图形，再用 **Electron（Chromium）** 渲染成 PNG —— 矢量可读、可复现、
 * 抗锯齿由浏览器保证，不依赖任何第三方图形库。
 *
 * 产出：
 *  - build/icon.ico   —— 多尺寸 ICO（安装包 / 便携版 / 快捷方式 / 窗口图标共用）
 *  - build/icon.png   —— 256×256 PNG（窗口图标 / 备用）
 *
 * 运行：npx electron build/make-icon.js
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = __dirname;
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** 图标源：深海渐变圆角底 + 白色肥鱼剪影 + 珊瑚橙尾鳍 + 青色气泡。 */
const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0b1d2a"/>
      <stop offset="100%" stop-color="#1a4256"/>
    </linearGradient>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#dceaf2"/>
    </linearGradient>
  </defs>

  <!-- 圆角底 -->
  <rect x="16" y="16" width="480" height="480" rx="112" ry="112" fill="url(#bg)"/>

  <!-- 气泡 -->
  <circle cx="360" cy="118" r="30" fill="#4fd1c5" opacity="0.85"/>
  <circle cx="418" cy="72" r="17" fill="#4fd1c5" opacity="0.65"/>

  <!-- 尾鳍 -->
  <path d="M330 256 L470 148 L470 364 Z" fill="#ff8a5c"/>

  <!-- 背鳍 -->
  <path d="M186 158 L246 62 L290 166 Z" fill="#ff8a5c"/>

  <!-- 鱼身 -->
  <ellipse cx="212" cy="256" rx="140" ry="96" fill="url(#body)"/>

  <!-- 腹鳍 -->
  <path d="M196 348 L250 428 L286 340 Z" fill="#ff8a5c"/>

  <!-- 眼睛 -->
  <circle cx="140" cy="232" r="20" fill="#0b1d2a"/>
  <circle cx="134" cy="225" r="7" fill="#ffffff"/>

  <!-- 嘴 -->
  <path d="M78 292 q26 22 54 4" stroke="#0b1d2a" stroke-width="11"
        stroke-linecap="round" fill="none" opacity="0.75"/>
</svg>`;

/* ---------------- PNG / ICO 编码 ---------------- */

function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

/** 由 RGBA 像素缓冲编码 PNG。 */
function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO 容器（目录项 + PNG 负载，Windows Vista+ 支持）。 */
function encodeICO(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.data.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

/* ---------------- 主流程 ---------------- */

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 512, height: 512 });
  const svgDataUrl = 'data:image/svg+xml;base64,' + Buffer.from(SVG, 'utf-8').toString('base64');
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!DOCTYPE html><html><body style="margin:0;background:transparent">' +
    '<img id="i" src="' + svgDataUrl + '" style="display:block"></body></html>'));

  const entries = [];
  for (const size of SIZES) {
    // 用 canvas 绘制 SVG 并导出 PNG（保证抗锯齿与缩放质量）
    const dataUrl = await win.webContents.executeJavaScript(`(async () => {
      const size = ${size};
      const img = document.getElementById('i');
      if (!img.complete) await new Promise(r => img.onload = r);
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(img, 0, 0, size, size);
      return c.toDataURL('image/png');
    })()`);
    const png = Buffer.from(String(dataUrl).split(',')[1], 'base64');
    entries.push({ size, data: png });
    if (size === 256) {
      fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png);
      console.log('  ✓ build/icon.png  (' + png.length + ' 字节)');
    }
  }

  const ico = encodeICO(entries);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);
  console.log('  ✓ build/icon.ico  (' + ico.length + ' 字节，尺寸: ' + SIZES.join('/') + ')');

  win.destroy();
  app.exit(0);
});
