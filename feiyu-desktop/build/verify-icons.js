'use strict';
/**
 * verify-icons.js —— 校验三个产物 exe 的图标是否一致且为自定义图标。
 *
 * 做法：直接解析 PE 资源目录（.rsrc），枚举 RT_GROUP_ICON(14) / RT_ICON(3)：
 *  1. 确认三处（安装版主程序 / NSIS 安装包 / 便携版）都**内嵌了图标组**；
 *  2. 每个尺寸的图像数据与源 `build/icon.ico` 对应尺寸**逐字节一致**（sha256 比对）；
 *  3. 确认源 icon.ico 含 16/32/256 常用尺寸；
 *  4. 反向核对：Electron 默认图标是蓝紫渐变标志，自定义图标中心是奶白鱼身。
 *
 * 纯 Node 实现（不依赖 Electron），可直接 `node build/verify-icons.js <产物目录>`。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const DIST = process.argv[2] || 'D:/feiyu-v11-build/dist2';

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed = 1; console.error('  ✗ ' + m); };

const RT_ICON = 3;
const RT_GROUP_ICON = 14;

/* ---------------- PE 资源解析 ---------------- */

function parsePeResources(file) {
  const b = fs.readFileSync(file);
  if (b.length < 0x40) throw new Error('文件太小，不是 PE');
  const peOff = b.readUInt32LE(0x3C);
  if (b.toString('ascii', peOff, peOff + 4) !== 'PE\0\0') throw new Error('PE 签名无效');

  const numSec = b.readUInt16LE(peOff + 6);
  const optSize = b.readUInt16LE(peOff + 20);
  const optOff = peOff + 24;
  const magic = b.readUInt16LE(optOff);
  const ddOff = magic === 0x20b ? optOff + 112 : optOff + 96;
  const resRva = b.readUInt32LE(ddOff + 2 * 8);
  const resSize = b.readUInt32LE(ddOff + 2 * 8 + 4);
  if (!resRva) return { types: {}, resRva: 0, resSize: 0 };

  const secOff = optOff + optSize;
  const sections = [];
  for (let i = 0; i < numSec; i++) {
    const o = secOff + i * 40;
    sections.push({
      vSize: b.readUInt32LE(o + 8),
      vAddr: b.readUInt32LE(o + 12),
      rawSize: b.readUInt32LE(o + 16),
      rawPtr: b.readUInt32LE(o + 20),
    });
  }
  const rvaToOff = (rva) => {
    for (const s of sections) {
      if (rva >= s.vAddr && rva < s.vAddr + Math.max(s.vSize, s.rawSize)) {
        return s.rawPtr + (rva - s.vAddr);
      }
    }
    return -1;
  };

  const resBase = rvaToOff(resRva);
  if (resBase < 0) return { types: {}, resRva, resSize };

  const readDir = (off) => {
    const numNamed = b.readUInt16LE(off + 12);
    const numId = b.readUInt16LE(off + 14);
    const list = [];
    for (let i = 0; i < numNamed + numId; i++) {
      const eo = off + 16 + i * 8;
      const nameRaw = b.readUInt32LE(eo);
      const offRaw = b.readUInt32LE(eo + 4);
      list.push({
        id: nameRaw & 0x7fffffff,
        isDir: (offRaw & 0x80000000) !== 0,
        off: offRaw & 0x7fffffff,
      });
    }
    return list;
  };

  const types = {};
  for (const t of readDir(resBase)) {
    if (!t.isDir) continue;
    // 资源树三层：类型 → 名称（name id）→ 语言 → 数据项
    const named = [];
    for (const n of readDir(resBase + t.off)) {
      if (n.isDir) {
        for (const L of readDir(resBase + n.off)) {
          if (L.isDir) continue;
          const deOff = resBase + L.off;
          const dataRva = b.readUInt32LE(deOff);
          const dataSize = b.readUInt32LE(deOff + 4);
          const dOff = rvaToOff(dataRva);
          if (dOff < 0) continue;
          const data = b.slice(dOff, dOff + dataSize);
          named.push({
            id: n.id,          // 名称 id（图标 id）
            lang: L.id,        // 语言 id
            size: dataSize,
            sha: crypto.createHash('sha256').update(data).digest('hex'),
            data,
          });
        }
      } else {
        // 二层直挂数据（罕见）
        const deOff = resBase + n.off;
        const dataRva = b.readUInt32LE(deOff);
        const dataSize = b.readUInt32LE(deOff + 4);
        const dOff = rvaToOff(dataRva);
        if (dOff < 0) continue;
        const data = b.slice(dOff, dOff + dataSize);
        named.push({
          id: n.id, lang: 0, size: dataSize,
          sha: crypto.createHash('sha256').update(data).digest('hex'),
          data,
        });
      }
    }
    types[t.id] = named;
  }
  return { types, resRva, resSize };
}

/**
 * 从 PE 资源取出图标组：尺寸表 + 每个尺寸对应的图像数据（DIB）。
 * RT_GROUP_ICON 的每一项给出尺寸与 nID，nID 指向 RT_ICON 的名称 id。
 */
function extractIconSet(pe) {
  const groups = pe.types[RT_GROUP_ICON] || [];
  const icons = pe.types[RT_ICON] || [];
  if (!groups.length || !icons.length) return null;
  const g = groups[0].data;
  const count = g.readUInt16LE(4);
  const byId = new Map(icons.map((i) => [i.id, i]));
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 14;
    const w = g[o] === 0 ? 256 : g[o];
    const h = g[o + 1] === 0 ? 256 : g[o + 1];
    const bpp = g.readUInt16LE(o + 6);
    const nID = g.readUInt16LE(o + 12);
    const rec = byId.get(nID);
    if (!rec) continue;
    entries.push({
      size: w, height: h, bpp, id: nID,
      sha: crypto.createHash('sha256').update(rec.data).digest('hex'),
      bytes: rec.data.length,
      data: rec.data,
    });
  }
  return entries;
}

/* ---------------- DIB / PNG 解码（用于逐像素比对） ---------------- */

/**
 * 解码 PE 资源里的 RT_ICON 数据（DIB/BMP 无文件头）。
 * 结构：BITMAPINFOHEADER(40) + 像素（BGRA，自下而上）+ AND 掩码。
 * header 里的 height 是「像素高 × 2」（含掩码）。
 */
function decodeDib(dib) {
  if (dib.length < 40) return null;
  const headerSize = dib.readUInt32LE(0);
  const width = dib.readInt32LE(4);
  const heightRaw = dib.readInt32LE(8);
  const planes = dib.readUInt16LE(12);
  const bitCount = dib.readUInt16LE(14);
  const compression = dib.readUInt32LE(16);
  if (planes !== 1 || bitCount !== 32 || compression !== 0) return null;
  const height = Math.abs(heightRaw) / 2;   // 去掉 AND 掩码那一半
  const pxOff = headerSize;
  const stride = width * 4;
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    // DIB 自下而上：源第 (height-1-y) 行对应目标第 y 行
    const srcRow = height - 1 - y;
    const s = pxOff + srcRow * stride;
    for (let x = 0; x < width; x++) {
      const so = s + x * 4, o = (y * width + x) * 4;
      out[o] = dib[so + 2];       // R
      out[o + 1] = dib[so + 1];   // G
      out[o + 2] = dib[so];       // B
      out[o + 3] = dib[so + 3];   // A
    }
  }
  return { width, height, rgba: out };
}

/** 解码 PNG（8 位 RGBA，支持全部 5 种过滤器）→ RGBA 缓冲。 */
function decodePngBuffer(b) {
  let p = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p);
    const type = b.toString('ascii', p + 4, p + 8);
    if (type === 'IHDR') {
      w = b.readUInt32BE(p + 8); h = b.readUInt32BE(p + 12);
      depth = b[p + 16]; ctype = b[p + 17]; interlace = b[p + 20];
    } else if (type === 'IDAT') {
      idat.push(b.slice(p + 8, p + 8 + len));
    } else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || ctype !== 6 || interlace !== 0) return null;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = w * bpp;
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const bb = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      switch (ft) {
        case 0: break;
        case 1: v = (v + a) & 255; break;
        case 2: v = (v + bb) & 255; break;
        case 3: v = (v + ((a + bb) >> 1)) & 255; break;
        case 4: {
          const pa = Math.abs(bb - c), pb = Math.abs(a - c), pc = Math.abs(a + bb - 2 * c);
          const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : c);
          v = (v + pr) & 255; break;
        }
        default: return null;
      }
      cur[x] = v;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width: w, height: h, rgba: out };
}

function decodePng(file) {
  return decodePngBuffer(fs.readFileSync(file));
}

/**
 * 解码 PE 资源里的图标数据。
 * Windows 允许同一图标组里混用两种存储：PNG 压缩（Vista+）与经典 DIB。
 * 这里两种都支持。
 */
function decodeIconData(data) {
  const isPng = data.length > 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47;
  if (isPng) return decodePngBuffer(data);
  return decodeDib(data);
}

/** 比较两张同尺寸 RGBA 图的差异像素占比。 */
function diffRatio(a, b) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return 1;
  const n = a.width * a.height;
  let diff = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    // 允许极小的抗锯齿差异：任一通道差 > 8 才算不同
    if (Math.abs(a.rgba[o] - b.rgba[o]) > 8 ||
        Math.abs(a.rgba[o + 1] - b.rgba[o + 1]) > 8 ||
        Math.abs(a.rgba[o + 2] - b.rgba[o + 2]) > 8) diff++;
  }
  return diff / n;
}

/* ---------------- 主流程 ---------------- */

function main() {
  console.log('\n[图标一致性校验] 产物目录: ' + DIST + '\n');

  // 1) 源 icon.ico
  const icoPath = path.join(ROOT, 'build', 'icon.ico');
  const ico = fs.readFileSync(icoPath);
  const count = ico.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    sizes.push(ico[o] === 0 ? 256 : ico[o]);
  }
  if (ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1 &&
      sizes.indexOf(256) >= 0 && sizes.indexOf(32) >= 0 && sizes.indexOf(16) >= 0) {
    ok('build/icon.ico 合法且含多尺寸：' + sizes.join('/'));
  } else {
    bad('build/icon.ico 非法或缺少常用尺寸: ' + sizes.join('/'));
  }

  // 2) 参考图标不是 Electron 默认图标（解码 PNG 取中心区域颜色）
  const refPng = decodePng(path.join(ROOT, 'build', 'icon.png'));
  if (!refPng) {
    bad('build/icon.png 无法解码');
  } else {
    // 取鱼身中心区域的平均色
    let r = 0, g = 0, b = 0, n = 0;
    const cx = Math.floor(refPng.width / 2), cy = Math.floor(refPng.height / 2);
    for (let y = cy - 6; y <= cy + 6; y++) {
      for (let x = cx - 6; x <= cx + 6; x++) {
        const o = (y * refPng.width + x) * 4;
        if (refPng.rgba[o + 3] < 200) continue;
        r += refPng.rgba[o]; g += refPng.rgba[o + 1]; b += refPng.rgba[o + 2]; n++;
      }
    }
    const avg = n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : null;
    console.log('  · 参考图标中心区域平均色 RGB: ' + (avg ? avg.join(',') : '（无不透明像素）'));
    if (avg && avg[0] > 200 && avg[1] > 200 && avg[2] > 200) {
      ok('参考图标中心为奶白鱼身（非 Electron 默认标志）');
    } else {
      bad('参考图标中心颜色异常，疑似默认图标: ' + (avg ? avg.join(',') : 'null'));
    }
  }

  // 3) 三个产物的 PE 资源：解码内嵌图标，与源图逐像素比对
  const targets = [
    ['安装版主程序', path.join(DIST, 'win-unpacked', '肥鱼桌面控制中心.exe')],
    ['NSIS 安装包', path.join(DIST, '肥鱼桌面控制中心-1.1.0-win-x64.exe')],
    ['便携版', path.join(DIST, '肥鱼桌面控制中心-1.1.0-portable.exe')],
  ];
  for (const [name, file] of targets) {
    if (!fs.existsSync(file)) { bad(name + ' 文件不存在: ' + file); continue; }
    let pe;
    try { pe = parsePeResources(file); } catch (e) { bad(name + ' PE 解析失败: ' + e.message); continue; }
    const set = extractIconSet(pe);
    if (!set || !set.length) { bad(name + ' 未内嵌图标组'); continue; }
    ok(name + ' 内嵌图标组，含尺寸: ' + set.map((e) => e.size).join('/'));

    const sizes = set.map((e) => e.size);
    if (sizes.indexOf(256) >= 0 && sizes.indexOf(16) >= 0) ok(name + ' 含 256 与 16 常用尺寸');
    else bad(name + ' 缺少 256/16 尺寸，实际: ' + sizes.join('/'));

    // 逐像素比对：内嵌的 256×256 图 vs 源 build/icon.png
    const big = set.find((e) => e.size === 256) || set[set.length - 1];
    const dec = decodeIconData(big.data);
    if (!dec) { bad(name + ' 内嵌图标数据无法解码（size=' + big.size + '）'); continue; }
    if (!refPng) continue;
    if (dec.width !== refPng.width || dec.height !== refPng.height) {
      bad(name + ' 内嵌图标尺寸与源图不符: ' + dec.width + '×' + dec.height + ' vs ' + refPng.width + '×' + refPng.height);
      continue;
    }
    const ratio = diffRatio(dec, refPng);
    const pct = (ratio * 100).toFixed(2);
    if (ratio < 0.02) ok(name + ' 内嵌 ' + dec.width + '×' + dec.height + ' 图标与 build/icon.png 逐像素一致（差异 ' + pct + '%）');
    else bad(name + ' 内嵌图标与源图不一致（差异 ' + pct + '%）');
  }
}

main();
console.log(failed ? '\nICON_CHECK_FAIL' : '\nICON_CHECK_OK');
process.exit(failed ? 1 : 0);
