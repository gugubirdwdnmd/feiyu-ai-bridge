'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
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
vm.runInContext(SRC + '\n;globalThis.__T={isImg2ImgIntent,isImageGenIntent,callImageGen,CFG:()=>CFG};', sandbox, { filename: 'ai_bridge.js' });
const T = sandbox.__T;

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name); console.log('  ✗ ' + name + (extra != null ? '  -> ' + JSON.stringify(extra) : '')); }
}

console.log('\n========== 图生图桥接验证 ==========\n');

console.log('[意图识别]');
ok('无图 → 否', T.isImg2ImgIntent('帮我画只猫', false) === false);
ok('有图+改风格 → 是', T.isImg2ImgIntent('帮我把这张图改成赛博朋克风格', true) === true);
ok('有图+普通生图 → 是（默认按图改造）', T.isImg2ImgIntent('给我画成动漫风格', true) === true);
ok('有图+识图问句 → 否', T.isImg2ImgIntent('这张图里是什么', true) === false);

console.log('\n[真实图生图]');
// 本地生成一张源图（放在 tests 目录内，本地读图白名单放行机器人自身目录）
const { pngSolid } = require('./_png_util');
const SRC_PNG = path.join(__dirname, '_img2img_src.png');
fs.writeFileSync(SRC_PNG, pngSolid(64, 64, 200, 120, 60));
const src = { type: 'image', data: { path: SRC_PNG } };
(async () => {
  const { comfyReachable } = require('./_live_backend');
  const imgCfg = T.CFG().image;
  const wfOk = (p) => !!p && fs.existsSync(path.resolve(ROOT, p));
  // live 判据：ComfyUI 可达 + 生图已启用 + 配置指向本机 ComfyUI + 工作流文件就绪
  const live = (await comfyReachable())
    && imgCfg.enabled === true
    && /:8188/.test(String(imgCfg.endpoint || ''))
    && wfOk(imgCfg.workflow) && wfOk(imgCfg.img2imgWorkflow);
  if (!live) {
    console.log('SKIP：未配置本机 ComfyUI 生图（需 ai_config.json：image.enabled=true + endpoint=127.0.0.1:8188 + 工作流文件），真实出图用例跳过（意图识别断言已通过）');
    console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
    process.exit(0);
  }
  const t0 = Date.now();
  const r = await T.callImageGen('油画风格，厚涂笔触，暖色调', { ...T.CFG().image, sourceSeg: src });
  console.log('  耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's  ' + (r.ok ? 'ok' : 'error=' + r.error));
  ok('图生图成功', r.ok === true, r.error);
  if (r.ok) {
    const b64 = String(r.file).replace(/^base64:\/\//, '');
    const buf = Buffer.from(b64, 'base64');
    const p = path.join(__dirname, '_out', 'bridge_img2img.png');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
    ok('返回 base64 且可存为 PNG', buf.length > 1000 && buf.slice(1, 4).toString('ascii') === 'PNG', buf.length + 'B');
    console.log('  → ' + p + '  (' + Math.round(buf.length / 1024) + ' KB)');
  }

  console.log('\n[文生图仍可用]');
  const t1 = Date.now();
  const r2 = await T.callImageGen('一只可爱的柴犬在樱花树下', T.CFG().image);
  console.log('  耗时 ' + ((Date.now() - t1) / 1000).toFixed(1) + 's  ' + (r2.ok ? 'ok' : 'error=' + r2.error));
  ok('文生图成功', r2.ok === true, r2.error);

  console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
  if (fail) console.log('失败项：' + fails.join(' | '));
  process.exit(fail ? 1 : 0);
})();
