/**
 * 换脸接线集成测试：在 vm 沙箱加载真实 ai_bridge.js（不起服务），
 * 直接调 callComfyUIImage 走「换脸」路径（targetSeg + faceSeg + faceSwapWorkflow），
 * 验证：① 路由到 reactor_faceswap.json ② 两张图都上传 ③ 真实出图 ④ 返回 base64:// 且是合法 PNG
 * 不发送任何 QQ 消息。用法：node _test_faceswap_wiring.js [target] [source]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'ai_bridge.js'), 'utf-8');

const fakeHttp = { createServer: () => ({ listen: () => {} }) };
const sandbox = {
  require: (name) => (name === 'http' ? fakeHttp : require(name.startsWith('.') ? require.resolve(name, { paths: [ROOT] }) : name)),
  console, process, fs, path,
  __dirname: ROOT, __filename: path.join(ROOT, 'ai_bridge.js'),
  URL, URLSearchParams, Buffer, AbortController, AbortSignal, fetch, Blob, FormData,
  setTimeout, clearTimeout, setInterval, clearInterval,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
if (!process.env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = 'sk-offline-test-dummy'; // 沙箱加载 ai_bridge 需要非空 Key，否则启动即退出
vm.runInContext(SRC + '\n;globalThis.__T = { CFG: () => CFG, callComfyUIImage };', sandbox, { filename: 'ai_bridge.js' });
const T = sandbox.__T;

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name); console.log('  ✗ ' + name + (extra != null ? '  -> ' + extra : '')); }
}

const target = process.argv[2] || path.join(ROOT, 'tests', 'fixtures', 'face_target.png');
const source = process.argv[3] || path.join(ROOT, 'tests', 'fixtures', 'face_source.png');

(async () => {
  console.log('\n========== 换脸接线集成测试（callComfyUIImage 真实路径）==========\n');
  const img = T.CFG().image;

  const faceSwapWf = String(img.faceSwapWorkflow || '').trim();
  if (!faceSwapWf) {
    console.log('SKIP：未配置 image.faceSwapWorkflow（复制 ai_config.example.json 为 ai_config.json 即可启用）');
    console.log('\n结果：0 通过 / 0 失败（配置缺失，跳过）');
    process.exit(0);
  }
  ok('faceSwapWorkflow 已配置', true, faceSwapWf);
  ok('工作流文件存在', fs.existsSync(faceSwapWf), faceSwapWf);

  // live 前置检查：ComfyUI 不可达 / 缺人脸示例图 → 跳过
  const { comfyReachable } = require('./_live_backend');
  if (!(await comfyReachable()) || !fs.existsSync(target) || !fs.existsSync(source)) {
    console.log('SKIP：未检测到可用的本机 ComfyUI，或缺少人脸示例图（tests/fixtures/face_target.png 等）');
    console.log('      传两张含人脸的照片再跑：node _test_faceswap_wiring.js 目标图.png 源脸图.png');
    console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败（live 跳过）');
    process.exit(fail ? 1 : 0);
  }

  const segT = { type: 'image', data: { file: target } };
  const segS = { type: 'image', data: { file: source } };

  console.log('调用 callComfyUIImage(target=face图, source=脸图) ...');
  const r = await T.callComfyUIImage('换脸测试', Object.assign({}, img, {
    targetSeg: segT, faceSeg: segS, sourceSeg: null, sourceSeg2: null,
  }));

  if (!r || !r.ok) {
    fail++; fails.push('callComfyUIImage 失败');
    console.error('✗ callComfyUIImage 返回:', JSON.stringify(r));
    console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(1);
  }
  ok('callComfyUIImage 返回 ok', true);
  ok('返回 base64:// 图片', typeof r.file === 'string' && r.file.startsWith('base64://'), r.file && r.file.slice(0, 40));

  const buf = Buffer.from(String(r.file).replace(/^base64:\/\//, ''), 'base64');
  ok('取回字节非空', buf.length > 0, buf.length);
  ok('是 PNG 图', buf.slice(1, 4).toString('ascii') === 'PNG', buf.slice(1, 4).toString('hex'));

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) console.log('失败项：' + fails.join(' | '));
  process.exit(fail ? 1 : 0);
})();
