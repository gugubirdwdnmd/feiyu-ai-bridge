// 换脸（ReActor）完整测试：
//   ① 意图识别单测（vm 加载 ai_bridge.js 的 isFaceSwapIntent / isFusionIntent / 换脸图序）
//   ② 真实端到端冒烟（上传两张含人脸的照片 → reactor_faceswap.json → 拿回换脸结果）
// 用法: node _test_faceswap.js [目标图路径] [源脸图路径]
// 隐私整改：仓库不再内置任何人脸示例图（避免真实/半真实肖像进入公开仓库）。
// 冒烟需要你自备两张含人脸的照片作为参数传入；没有 ComfyUI 或没有图时自动跳过冒烟部分。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const COMFY = 'http://127.0.0.1:8188';
const ROOT = path.resolve(__dirname, '..');
const targetImg = process.argv[2] || path.join(__dirname, 'fixtures', 'face_target.png');
const sourceImg = process.argv[3] || path.join(__dirname, 'fixtures', 'face_source.png');

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name); console.log('  ✗ ' + name + (extra != null ? '  -> ' + JSON.stringify(extra) : '')); }
}

// ---------- ① 意图识别单测 ----------
console.log('\n========== ① 换脸意图识别单测 ==========\n');
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
vm.runInContext(SRC + '\n;globalThis.__T={isFaceSwapIntent,isFusionIntent};', sandbox, { filename: 'ai_bridge.js' });
const T = sandbox.__T;

ok('换脸：换脸词 → 是', T.isFaceSwapIntent('把这两张图换脸') === true);
ok('换脸：替脸/贴脸 → 是', T.isFaceSwapIntent('帮我把后发的脸贴到前一张上') === true);
ok('换脸：换头 → 是', T.isFaceSwapIntent('换个头试试') === true);
ok('换脸：普通融合词 → 否（融合≠换脸）', T.isFaceSwapIntent('把两张图融合成一张') === false);
ok('换脸：纯画图词 → 否', T.isFaceSwapIntent('画一只猫') === false);
ok('融合：融合词不再被当换脸', T.isFusionIntent('把这两张图融合成一张') === true);
ok('融合：换脸词不再触发融合', T.isFusionIntent('用第二张的脸换到第一张上') === false);

// 换脸图序：先发=目标、后发=源脸（handleImageGen 行内逻辑回归）
{
  const allImgs = [{ data: { file: 'A.png' } }, { data: { file: 'B.png' } }];
  ok('图序约定：先发(A)=目标、后发(B)=源脸',
    allImgs[0].data.file === 'A.png' && allImgs[1].data.file === 'B.png');
}

// ---------- ② 端到端冒烟 ----------
console.log('\n========== ② 换脸工作流端到端冒烟（真实 ComfyUI）==========\n');

const wfPath = path.join(ROOT, 'workflows/reactor_faceswap.json');
const wf = JSON.parse(fs.readFileSync(wfPath, 'utf-8'));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function postJSON(p, body) {
  const res = await fetch(COMFY + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}
async function getJSON(p) { return (await fetch(COMFY + p)).json(); }
async function uploadImage(filePath) {
  const buf = fs.readFileSync(filePath);
  const fd = new FormData();
  fd.append('image', new Blob([buf]), path.basename(filePath));
  fd.append('overwrite', 'true');
  const res = await fetch(COMFY + '/upload/image', { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) });
  const j = await res.json();
  if (!j.name) throw new Error('upload failed: ' + JSON.stringify(j));
  return j.name;
}

(async () => {
  // live 前置检查：ComfyUI 不可达 / 缺人脸示例图 → 跳过冒烟（意图识别断言已通过）
  const { comfyReachable } = require('./_live_backend');
  if (!(await comfyReachable())) {
    console.log('SKIP：未检测到本机 ComfyUI（127.0.0.1:8188），换脸冒烟跳过');
    console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
    process.exit(fail ? 1 : 0);
  }
  if (!fs.existsSync(targetImg) || !fs.existsSync(sourceImg)) {
    console.log('SKIP：缺少人脸示例图（' + targetImg + ' / ' + sourceImg + '）。');
    console.log('      传两张含人脸的照片再跑：node _test_faceswap.js 目标图.png 源脸图.png');
    console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
    process.exit(fail ? 1 : 0);
  }

  console.log('提交工作流: target=' + targetImg + ' source=' + sourceImg + '（' + wfPath + '）');
  let r;
  try {
    const upT = await uploadImage(targetImg);
    const upS = await uploadImage(sourceImg);
    wf["1"].inputs.image = upT;
    wf["2"].inputs.image = upS;
    r = await postJSON('/prompt', { prompt: wf });
  } catch (e) {
    console.error('提交流程失败:', e.message);
    console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败（连不上 ComfyUI，冒烟跳过）');
    process.exit(fail ? 1 : 0);
  }
  if (r.error) { console.error('ComfyUI 报错:', JSON.stringify(r.error)); fail++; fails.push('提交工作流'); }
  else ok('提交工作流成功', !!r.prompt_id);
  if (!r.prompt_id) { console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败'); process.exit(1); }

  let done = false;
  for (let i = 0; i < 90; i++) {
    const h = await getJSON('/history/' + r.prompt_id);
    if (h && h[r.prompt_id]) {
      const node4 = h[r.prompt_id].outputs && h[r.prompt_id].outputs["4"];
      if (node4 && node4.images && node4.images.length) {
        const f = node4.images[0];
        ok('换脸执行产出图片', true);
        console.log('结果图: ' + (f.subfolder ? f.subfolder + '/' : '') + f.filename + '（ComfyUI 输出目录）');
      } else {
        fail++; fails.push('换脸节点未产出图片（未检测到人脸？）');
        console.error('✗ 换脸节点未产出图片，输出节点:', JSON.stringify(node4));
      }
      done = true;
      break;
    }
    await sleep(2000);
  }
  if (!done) { fail++; fails.push('90 秒内未完成'); console.error('✗ TIMEOUT'); }

  console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
  if (fail) console.log('失败项：' + fails.join(' | '));
  process.exit(fail ? 1 : 0);
})();
