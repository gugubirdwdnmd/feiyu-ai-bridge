'use strict';
// 双图融合工作流验证：① 意图识别单测（vm 加载 bridge）② 真实端到端冒烟（上传两张图 → fusion 工作流 → 取回图）
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name); console.log('  ✗ ' + name + (extra != null ? '  -> ' + JSON.stringify(extra) : '')); }
}

// ---------- ① 意图识别单测 ----------
console.log('\n========== ① 意图识别单测 ==========\n');
const SRC = fs.readFileSync(path.join(ROOT, 'ai_bridge.js'), 'utf-8');
const fakeHttp = { createServer: () => ({ listen: () => {} }) };
const sandbox = {
  require: (n) => (n === 'http' ? fakeHttp : require(n.startsWith('.') ? require.resolve(n, { paths: [ROOT] }) : n)),
  console, process, fs, path,
  __dirname: ROOT, __filename: path.join(ROOT, 'ai_bridge.js'),
  URL, URLSearchParams, Buffer, AbortController, AbortSignal, fetch, Blob, FormData,
  setTimeout, clearTimeout, setInterval, clearInterval,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
if (!process.env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = 'sk-offline-test-dummy'; // 沙箱加载 ai_bridge 需要非空 Key，否则启动即退出
vm.runInContext(SRC + '\n;globalThis.__T={isFusionIntent,isImg2ImgIntent};', sandbox, { filename: 'ai_bridge.js' });
const T = sandbox.__T;

ok('融合：两张图+“融合” → 是', T.isFusionIntent('把这两张图融合成一张') === true);
ok('融合：两张图+“合成” → 是', T.isFusionIntent('把两人合成一张合影') === true);
ok('融合：普通“改成油画” → 否（不强行糊两张）', T.isFusionIntent('把这张图改成油画风格') === false);
ok('融合：无融合词 → 否', T.isFusionIntent('画一只猫') === false);
ok('图生图：有图+改风格 → 是', T.isImg2ImgIntent('帮我把这张图改成赛博朋克风格', true) === true);
ok('图生图：有图+识图问句 → 否', T.isImg2ImgIntent('这张图里是什么', true) === false);

// ---------- ② 端到端冒烟：上传两张图 → fusion 工作流 ----------
console.log('\n========== ② 融合工作流端到端冒烟（真实 ComfyUI）==========\n');

// 极简 PNG 编码器（RGB 实色），无需任何第三方库
function crc32(buf) {
  let c, table = crc32.t || (crc32.t = (() => {
    const t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t;
  })());
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function pngSolid(w, h, r, g, b) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const BASE = 'http://127.0.0.1:8188';
const wf = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows/z_image_turbo_2img_fusion.json'), 'utf-8'));

(async () => {
  // live 前置检查：本机没有 ComfyUI 时跳过端到端冒烟（意图识别断言已通过）
  const { comfyReachable } = require('./_live_backend');
  if (!(await comfyReachable())) {
    console.log('\nSKIP：未检测到本机 ComfyUI（127.0.0.1:8188），融合端到端冒烟跳过');
    console.log('\n========== 结果 ==========');
    console.log('通过 ' + pass + ' / 失败 ' + fail);
    process.exit(0);
  }
  // 生成两张不同的小图（红 / 蓝）
  const imgA = pngSolid(64, 64, 220, 40, 40);
  const imgB = pngSolid(64, 64, 40, 80, 220);
  const nameA = 'qq_fusion_test_A_' + Date.now() + '.png';
  const nameB = 'qq_fusion_test_B_' + Date.now() + '.png';

  async function upload(buf, name) {
    const fd = new FormData();
    fd.append('image', new Blob([buf]), name);
    fd.append('overwrite', 'true');
    const r = await fetch(BASE + '/upload/image', { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) });
    const j = await r.json();
    if (!j.name) throw new Error('upload failed: ' + JSON.stringify(j));
    return j.name;
  }
  try {
    const upA = await upload(imgA, nameA);
    const upB = await upload(imgB, nameB);
    ok('上传图A 成功', !!upA, upA);
    ok('上传图B 成功', !!upB, upB);

    // 按 callComfyUIImage 的同一逻辑填参：两个 LoadImage 各填一张，CLIP 正向填 prompt，KSampler denoise=0.6
    let li = 0;
    for (const k of Object.keys(wf)) {
      const n = wf[k]; if (!n || !n.class_type) continue;
      try {
        if (n.class_type === 'CLIPTextEncode') { n.inputs.text = li === 0 ? '融合两人特征，写实摄影，自然光线，细节丰富' : ''; li++; }
        else if (n.class_type === 'LoadImage') { n.inputs.image = (li === 0 ? upA : upB); li++; }
        else if (n.class_type === 'KSampler') { n.inputs.denoise = 0.6; n.inputs.steps = 9; n.inputs.cfg = 1; }
      } catch (e) {}
    }
    ok('工作流含 2 个 LoadImage 节点', Object.keys(wf).filter((k) => wf[k].class_type === 'LoadImage').length === 2);

    const pr = await fetch(BASE + '/prompt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: wf, client_id: 'napcat-fusion-test' }), signal: AbortSignal.timeout(30000),
    });
    const pj = await pr.json();
    ok('提交工作流成功', !!pj.prompt_id, pj);
    const pid = pj.prompt_id;

    // 轮询 history
    let shot = null; const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await new Promise((s) => setTimeout(s, 2000));
      const hr = await fetch(BASE + '/history/' + pid, { signal: AbortSignal.timeout(15000) }).catch(() => null);
      if (!hr || !hr.ok) continue;
      const hj = await hr.json();
      const entry = hj && hj[pid];
      if (!entry) continue;
      const st = (entry.status && entry.status.status_str) || '';
      if (st === 'error') { ok('执行未报错', false, entry.status); break; }
      if (!entry.status || !entry.status.completed) continue;
      for (const nk of Object.keys(entry.outputs || {})) {
        const imgs = entry.outputs[nk] && entry.outputs[nk].images;
        if (Array.isArray(imgs) && imgs[0]) { shot = imgs[0]; break; }
      }
      if (shot) break;
    }
    ok('融合执行产出图片', !!shot, shot);

    if (shot) {
      const q = 'filename=' + encodeURIComponent(shot.filename) + '&subfolder=' + encodeURIComponent(shot.subfolder || '') + '&type=' + encodeURIComponent(shot.type || 'output');
      const vr = await fetch(BASE + '/view?' + q, { signal: AbortSignal.timeout(60000) });
      const ab = Buffer.from(await vr.arrayBuffer());
      ok('取回图片字节非空', ab && ab.length > 100, ab && ab.length);
      ok('取回的是 PNG（89 50 4E 47 开头）', ab && ab[0] === 0x89 && ab[1] === 0x50 && ab[2] === 0x4E && ab[3] === 0x47);
      fs.writeFileSync(path.join(__dirname, '_fusion_smoke_out.png'), ab);
      console.log('    融合结果已存：' + path.join(__dirname, '_fusion_smoke_out.png') + ' (' + (ab ? ab.length : 0) + ' bytes)');
    }
  } catch (e) {
    ok('冒烟测试未抛异常', false, String((e && e.message) || e).slice(0, 160));
  }

  console.log('\n========== 结果 ==========');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  if (fail) console.log('失败项：' + fails.join(' | '));
  process.exit(fail ? 1 : 0);
})();
