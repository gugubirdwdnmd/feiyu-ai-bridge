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
vm.runInContext(
  SRC + '\n;globalThis.__T={TOOLS,TOOL_GROUPS,selectToolsOnDemand,toolsForMode,generateImageTool,setImageToolCtx,CFG:()=>CFG,checkImagePromptSafety};',
  sandbox, { filename: 'ai_bridge.js' }
);
const T = sandbox.__T;

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name); console.log('  ✗ ' + name + (extra != null ? '  -> ' + JSON.stringify(extra) : '')); }
}

const names = T.TOOLS.map((t) => t.function.name);

console.log('\n========== generate_image 工具接入验证 ==========\n');

console.log('[工具注册]');
ok('TOOLS 含 generate_image', names.includes('generate_image'), names);
const gt = T.TOOLS.find((t) => t.function.name === 'generate_image');
ok('必填 prompt', JSON.stringify(gt.function.parameters.required) === '["prompt"]');
ok('有 source 可选参数', !!gt.function.parameters.properties.source);
ok('image 组含 generate_image', (T.TOOL_GROUPS.image || []).includes('generate_image'), T.TOOL_GROUPS.image);
ok('enhanced 模式挂上该工具', T.toolsForMode('帮我画只猫').some((t) => t.function.name === 'generate_image'));
ok('economy-生图意图也挂上', T.selectToolsOnDemand('画一只猫').some((t) => t.function.name === 'generate_image'));
ok('economy-普通闲聊不挂（省 token）', !T.selectToolsOnDemand('今天天气不错啊').some((t) => t.function.name === 'generate_image'));

console.log('\n[异常分支]');
(async () => {
  const { comfyReachable } = require('./_live_backend');
  const imgCfg = T.CFG().image;
  const imgEnabled = imgCfg.enabled === true;
  const wfOk = (p) => !!p && fs.existsSync(path.resolve(ROOT, p));
  const live = (await comfyReachable()) && imgEnabled && wfOk(imgCfg.workflow) && wfOk(imgCfg.img2imgWorkflow);
  if (!(await comfyReachable())) console.log('\n[提示] 未检测到本机 ComfyUI（127.0.0.1:8188）：真实出图用例跳过，离线断言继续执行');
  if (!imgEnabled) console.log('\n[提示] image.enabled=false（未配置生图）：异常分支与真实出图用例跳过（复制 ai_config.example.json 为 ai_config.json 可启用）');
  // 用一个不存在的会话 id：能跑完真实出图，但不会真的发消息到 QQ
  const SID = 'test_nochat_' + Date.now();
  const ctx = {};
  if (imgEnabled) {
  const r0 = await T.generateImageTool(SID, { prompt: '' }, ctx);
  ok('空描述 → 拒绝', /没写画面描述/.test(r0), r0);

  // 内置安全词判定已按用户要求删除 → 不再拦截，交由用户自己的实现接管
  // （只验证判定函数放行，不真的拿这类词去出图）
  const s1 = T.checkImagePromptSafety('naked sexy girl');
  ok('内置安全词判定已移除（返回 null 放行）', s1 === null, s1);
  const s2 = T.checkImagePromptSafety('一只橘猫趴在窗台上');
  ok('正常词同样放行', s2 === null, s2);

  const r2 = await T.generateImageTool(SID, { prompt: '一只猫', source: '1' }, ctx);
  ok('没有图却要图生图 → 明确提示', /没有图|没有可用/.test(r2), r2);
  }

  if (live) {
  console.log('\n[真实出图：文生图]');
  const t0 = Date.now();
  const r3 = await T.generateImageTool(SID, { prompt: '一只橘猫趴在窗台上晒太阳，暖光', }, ctx);
  console.log('  耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's -> ' + String(r3).slice(0, 60));
  ok('文生图跑通（未知会话应提示发到哪/已画好）', /不知道该发到哪个会话|已经画好/.test(r3), r3);

  console.log('\n[真实出图：图生图]');
  // 生成一张本地源图（放在仓库 tests 目录内，本地读图白名单放行机器人自身目录）
  const { pngSolid } = require('./_png_util');
  const srcPath = path.join(__dirname, '_gen_tool_src.png');
  fs.writeFileSync(srcPath, pngSolid(64, 64, 60, 120, 200));
  // 换一个会话 id：既是新用户（避开 60s 冷却），也不会真发消息
  const SID2 = 'test_nochat2_' + Date.now();
  T.setImageToolCtx(SID2, null, [{ type: 'image', data: { path: srcPath } }]);
  const t1 = Date.now();
  const r4 = await T.generateImageTool(SID2, { prompt: '改成油画风格，厚涂笔触', source: '1' }, ctx);
  console.log('  耗时 ' + ((Date.now() - t1) / 1000).toFixed(1) + 's -> ' + String(r4).slice(0, 60));
  ok('图生图跑通', /不知道该发到哪个会话|已经画好/.test(r4), r4);
  ok('图生图真的跑了后端（耗时>10s）', (Date.now() - t1) > 10000, (Date.now() - t1));
  try { fs.unlinkSync(srcPath); } catch (e) {}
  }

  console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
  if (fail) console.log('失败项：' + fails.join(' | '));
})();
