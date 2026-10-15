/**
 * 生图后端切换验证：在 vm 沙箱里加载真实 ai_bridge.js（桩掉 http.createServer，不起服务），
 * 直接调 callImageGen 打本机 ComfyUI（127.0.0.1:8188，不出网），验证：
 *   ① provider=comfyui 走新分支  ② 真实出图成功  ③ 返回 base64:// 且能存成合法 PNG
 *   ④ LoRA 工作流也能出图  ⑤ 参数未越界（1024/9步/CFG1）
 * 不发送任何 QQ 消息。
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
  URL, URLSearchParams, Buffer, AbortController, AbortSignal, fetch,
  setTimeout, clearTimeout, setInterval, clearInterval,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const patched = SRC + '\n;globalThis.__T = { CFG: () => CFG, callImageGen, isImageGenIntent, checkImagePromptSafety };';
if (!process.env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = 'sk-offline-test-dummy'; // 沙箱加载 ai_bridge 需要非空 Key，否则启动即退出
vm.runInContext(patched, sandbox, { filename: 'ai_bridge.js' });
const T = sandbox.__T;

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name); console.log('  ✗ ' + name + (extra != null ? '  -> ' + extra : '')); }
}

const OUT = path.join(__dirname, '_out');
function saveB64(file, name) {
  const b64 = String(file).replace(/^base64:\/\//, '');
  const buf = Buffer.from(b64, 'base64');
  fs.mkdirSync(OUT, { recursive: true });
  const p = path.join(OUT, name);
  fs.writeFileSync(p, buf);
  return { p, size: buf.length, isPng: buf.slice(1, 4).toString('ascii') === 'PNG' };
}

(async () => {
  console.log('\n========== 生图后端切换验证 ==========\n');
  const img = T.CFG().image;
  console.log('[配置]');
  // 未配置本机 ComfyUI（provider 不是 comfyui / 没配工作流）时，配置类断言不适用：
  // 如实提示并跳过，离线意图断言照常执行。
  const comfyConfigured = String(img.provider).toLowerCase() === 'comfyui' && !!String(img.workflow || '').trim();
  if (!comfyConfigured) {
    console.log('  （提示）当前未配置本机 ComfyUI 生图（provider=' + img.provider + '）：配置类断言与 live 用例跳过');
    console.log('        配置方法：复制 ai_config.example.json 为 ai_config.json 并配好 image.workflow（见 workflows/README.md）');
  } else {
    ok('provider=comfyui', true, img.provider);
    ok('endpoint 指向 127.0.0.1:8188', img.endpoint === 'http://127.0.0.1:8188', img.endpoint);
    if (!fs.existsSync(img.workflow)) console.log('  （提示）主工作流文件不在本机：' + img.workflow);
    ok('尺寸=1024 步数=9 CFG=1', img.width === 1024 && img.steps === 9 && img.cfgScale === 1);
  }

  console.log('\n[意图识别]');
  ok('「画只猫」命中', T.isImageGenIntent('画只猫') === true);
  ok('「你会画画吗」不命中', T.isImageGenIntent('你会画画吗') === false);
  ok('内置安全词判定已移除（返回 null 放行，交由部署方自管）', T.checkImagePromptSafety('画个裸体少女') === null);

  // live 类用例：本机没有 ComfyUI（或没配主工作流）时跳过，离线断言不受影响
  const { comfyReachable } = require('./_live_backend');
  const live = comfyConfigured && (await comfyReachable()) && fs.existsSync(img.workflow);
  if (!live) {
    console.log('\nSKIP：未检测到可用的本机 ComfyUI / 主工作流，真实出图用例跳过');
    console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
    process.exit(fail ? 1 : 0);
  }

  console.log('\n[真实出图 #1 基础（Z-Image-Turbo）]');
  const t0 = Date.now();
  const r1 = await T.callImageGen('一只橘色的猫坐在窗台上晒太阳，柔和午后光线，高清细节');
  console.log('  耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's  ' + (r1.ok ? 'ok' : 'error=' + r1.error));
  ok('出图成功', r1.ok === true, r1.error);
  if (r1.ok) {
    const s = saveB64(r1.file, 'bridge_base.png');
    ok('返回 base64:// 且可存为合法 PNG', s.isPng && s.size > 50000, s.size + 'B');
    console.log('  → ' + s.p + '  (' + Math.round(s.size / 1024) + ' KB)');
  }

  console.log('\n[真实出图 #2 LoRA 工作流]');
  const cfg = T.CFG().image;
  const backup = cfg.loraName;
  cfg.loraName = 'pixel_art_style_z_image_turbo.safetensors';
  const t1 = Date.now();
  const r2 = await T.callImageGen('一只橘色的猫坐在窗台上晒太阳');
  console.log('  耗时 ' + ((Date.now() - t1) / 1000).toFixed(1) + 's  ' + (r2.ok ? 'ok' : 'error=' + r2.error));
  ok('LoRA 工作流出图成功', r2.ok === true, r2.error);
  if (r2.ok) {
    const s2 = saveB64(r2.file, 'bridge_lora.png');
    ok('LoRA 图合法', s2.isPng && s2.size > 50000, s2.size + 'B');
    console.log('  → ' + s2.p + '  (' + Math.round(s2.size / 1024) + ' KB)');
  }
  cfg.loraName = backup;

  console.log('\n[异常分支] 工作流文件不存在 → 应优雅失败不抛异常');
  const badCfg = T.CFG().image;
  const keep = badCfg.workflow;
  badCfg.workflow = 'D:\\ComfyUI\\workflows\\__not_exist__.json';
  const rBad = await T.callImageGen('一只猫');
  ok('工作流缺失时返回 ok=false 且不抛异常', rBad && rBad.ok === false, JSON.stringify(rBad));
  console.log('  → error=' + (rBad && rBad.error));
  badCfg.workflow = keep;

  console.log('\n[异常分支] ComfyUI 端口不可达 → 应优雅失败');
  const keepEp = badCfg.endpoint;
  badCfg.endpoint = 'http://127.0.0.1:8199';
  const rDown = await T.callImageGen('一只猫').catch((e) => ({ ok: false, error: 'threw:' + e.message }));
  ok('服务不可达时返回 ok=false 且不抛异常', rDown && rDown.ok === false, JSON.stringify(rDown));
  console.log('  → error=' + (rDown && rDown.error));
  badCfg.endpoint = keepEp;

  console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
  if (fail) console.log('失败项：' + fails.join(' | '));
  process.exit(fail ? 1 : 0);
})();
