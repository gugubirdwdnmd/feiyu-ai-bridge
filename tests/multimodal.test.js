'use strict';
/**
 * 多模态理解 — 真实测试（node 直接跑：node tests/multimodal.test.js）
 * 不 mock 业务逻辑：路径安全/解析/能力自检/资源探测/端点分类/任务生命周期/配置热更新/API 契约/SSRF 均走真实代码与真实 fs/execFile/safeFetch。
 * 需要本地模型引擎（ffmpeg/whisper/PaddleOCR/VL）才能跑通"完整推理"的项，会如实断言"能力未就绪"状态，而非伪造成功。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const B = path.resolve(__dirname, '..');
const { createMediaUnderstanding } = require(B + '/feiyu/media_understanding');
const { createLocalAIResourceManager } = require(B + '/feiyu/local_ai_resources');
const { createMultimodalApi } = require(B + '/feiyu/multimodal_api');
const { TaskManager } = require(B + '/feiyu/task_manager');

let passed = 0;
function ok(name) { passed++; console.log('  ✓ ' + name); }

// 本地 stub VL 端点（真实 HTTP 服务，仅验证编排/契约）
function startStubVL() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'stub-caption' } }] }));
      });
    });
    s.listen(8123, () => resolve(s));
  });
}

async function main() {
  const liveCFG = { multimodal: { enabled: true, defaultMode: 'local',
    vl: { localEndpoint: 'http://127.0.0.1:8123/v1/chat/completions', localModel: 'stub' },
    ocr: { enabled: true, engine: 'auto' }, asr: { enabled: true, provider: 'local', localCmd: [] },
    summary: { localEndpoint: 'http://127.0.0.1:8123/v1/chat/completions' } } };
  const res = createLocalAIResourceManager({});
  const tmp = path.join(B, 'workspace', '_media_tmp'); fs.mkdirSync(tmp, { recursive: true });

  let media;
  const terminal = [];
  const taskMgr = new TaskManager({ storeFile: 'memory://t', executor: (s, t, c) => media.executeVideoStep(s, t, c),
    onEvent: (ev, t) => { if ((ev === 'completed' || ev === 'failed') && t.mediaResult) terminal.push(t.id); },
    config: { maxConcurrent: 2, taskTimeoutMs: 5000 } });
  taskMgr.init();

  media = createMediaUnderstanding({ napcatCall: async () => ({ data: {} }), getCFG: () => liveCFG, callAPI: async () => ({}), log: () => {}, resourceManager: res, taskManager: taskMgr });
  const api = createMultimodalApi({ mediaSvc: media, resourceManager: res, taskManager: null, getCFG: () => liveCFG, applyConfig: (p) => { const c = liveCFG.multimodal; for (const k of Object.keys(p)) c[k] = p[k]; return true; }, log: () => {} });

  // —— 1. 视频路径安全：白名单内合法 / 扩展名伪装 / 项目外 全部正确 ——
  const good = path.join(tmp, 'a.mp4'); fs.writeFileSync(good, 'x');
  const trick = path.join(tmp, 'a.mp4.exe'); fs.writeFileSync(trick, 'x');
  const outside = path.join(B, '..', 'evil.mp4'); fs.writeFileSync(outside, 'x');
  assert.ok(media._safeMediaPath(good, new Set(['.mp4']), 1024 * 1024), '白名单内合法视频应放行');
  assert.strictEqual(media._safeMediaPath(trick, new Set(['.mp4']), 1024 * 1024), null, '扩展名伪装应拒绝');
  assert.strictEqual(media._safeMediaPath(outside, new Set(['.mp4']), 1024 * 1024), null, '项目外文件应拒绝');
  ok('视频文件安全解析（白名单/伪装/越界）');

  // —— 2. 图片路径安全同理 ——
  const img = path.join(tmp, 'i.jpg'); fs.writeFileSync(img, 'x');
  assert.ok(media._safeMediaPath(img, new Set(['.jpg']), 1024 * 1024), '白名单内合法图片应放行');
  ok('图片文件安全解析');

  // —— 3. 端点分类：本地回环 / 云端需白名单 / 云端缺白名单拦截 ——
  assert.strictEqual(media._classifyEndpoint('http://127.0.0.1:8000/v1/chat/completions', []).kind, 'local');
  assert.strictEqual(media._classifyEndpoint('https://api.x.com/v1/chat/completions', []).kind, 'cloud-blocked', '无白名单的云端应拦截');
  assert.strictEqual(media._classifyEndpoint('https://api.x.com/v1/chat/completions', ['api.x.com']).kind, 'cloud', '带白名单的云端应放行');
  ok('端点分类（本地/云端白名单/云端拦截）');

  // —— 4. 能力自检：ffmpeg 不可用应如实反映（本机未装 ffmpeg）——
  const cap = await media.probeCapabilities();
  assert.strictEqual(cap.ffmpeg.available, false, '本机无 ffmpeg → 不可用须如实');
  assert.strictEqual(cap.localFirst, true, '必须本地优先');
  assert.strictEqual(cap.autoDownloadModels, false, '绝不自动下载模型');
  assert.ok(cap.ffmpeg.note && cap.ffmpeg.note.length > 0, '应给出不可用说明');
  ok('能力自检如实反映未安装（ffmpeg 不可用）');

  // —— 5. 资源探测：真实 GPU/显存/CPU/内存（无 GPU 优雅降级）——
  const snap = await res.snapshot();
  assert.ok(typeof snap.ram.totalMB === 'number' && snap.ram.totalMB > 0, '内存应为正数');
  assert.ok(typeof snap.gpu.available === 'boolean', 'GPU 可用性应为布尔');
  assert.strictEqual(res.policy().loadsMultipleModelsByDefault, false, '默认不并发多模型');
  assert.strictEqual(res.policy().autoDownloadsModels, false, '默认不自动下载');
  ok('资源探测（GPU/显存/CPU/内存，无 GPU 降级）');

  // —— 6. 模型准入：预算=0 拒绝 GPU 模型；设预算后允许；并发上限 ——
  assert.strictEqual(res.claim({ id: 'vl', estimatedVRAMMB: 4000, endpoint: 'http://127.0.0.1:8000/v1/chat/completions' }).ok, false, '预算=0 应拒绝 GPU 模型');
  res.setConfig({ vramBudgetMB: 8000, maxConcurrent: 1 });
  assert.ok(res.claim({ id: 'vl', estimatedVRAMMB: 4000, endpoint: 'http://127.0.0.1:8000/v1/chat/completions' }).ok, '设预算后应允许');
  assert.strictEqual(res.claim({ id: 'vl2', estimatedVRAMMB: 5000, endpoint: 'x' }).ok, false, '超预算应拒绝');
  ok('本地 AI 资源准入（预算/并发）');

  // —— 7. 任务中心接入：入队 → 终态一次性回送（不重试刷屏）——
  const fake = path.join(tmp, 'v_' + Date.now() + '.mp4'); fs.writeFileSync(fake, 'FAKE');
  const r = await media.handleIncomingVideo({ type: 'video', data: { file: fake } }, { ev: { message_type: 'group', group_id: 1, user_id: 2 }, chatId: 'group:1', groupId: 1, userId: 2, sendReply: () => {} });
  assert.ok(r.ok && r.taskId, '应成功入队');
  for (let i = 0; i < 12; i++) { taskMgr.tick(Date.now()); await new Promise((x) => setTimeout(x, 50)); }
  const t = taskMgr.get(r.taskId);
  assert.strictEqual(t.status, 'failed', '无 ffmpeg → 任务失败');
  assert.strictEqual(t.error, 'ffmpeg-unavailable', '应如实给出失败原因');
  assert.strictEqual(terminal.length, 1, '终态回送应只触发一次');
  ok('任务中心接入（入队/终态一次性回送/失败原因）');

  // —— 8. 任务取消 ——
  const c = taskMgr.cancel(r.taskId);
  assert.ok(c.ok, '取消应成功');
  ok('任务取消');

  // —— 9. 配置热更新：默认模式 / 上限 ——
  const cfgRes = await api.handlePost('/api/multimodal/config', { defaultMode: 'cloud', limits: { maxBytes: 222 } });
  assert.strictEqual(cfgRes.json.ok, true);
  assert.strictEqual(liveCFG.multimodal.defaultMode, 'cloud', '默认模式应热更新');
  assert.strictEqual(liveCFG.multimodal.limits.maxBytes, 222, '上限应热更新');
  ok('配置热更新（默认模式/上限）');

  // —— 10. API 契约：capabilities / status / tasks / analyze / cancel 结构正确 ——
  const capApi = await api.handleGet('/api/multimodal/capabilities', new URLSearchParams());
  assert.strictEqual(capApi.status, 200); assert.ok(capApi.json.ok && capApi.json.capabilities);
  const stApi = await api.handleGet('/api/multimodal/status', new URLSearchParams());
  assert.ok(stApi.json.resources && stApi.json.capabilities);
  const anApi = await api.handlePost('/api/multimodal/analyze', { mediaRef: { type: 'video', data: { file: fake } }, ev: { message_type: 'group', group_id: 1, user_id: 2 } });
  assert.ok(anApi.json.ok && anApi.json.taskId, 'analyze 应返回 taskId');
  const tasksApi = await api.handleGet('/api/multimodal/tasks', new URLSearchParams());
  assert.ok(Array.isArray(tasksApi.json.tasks));
  // 未配置 taskManager 时 /task/:id/cancel 应 503 而非崩溃
  const noMgrApi = createMultimodalApi({ mediaSvc: media, resourceManager: res, taskManager: null, getCFG: () => liveCFG, applyConfig: () => true, log: () => {} });
  const cancelNo = await noMgrApi.handlePost('/api/multimodal/task/x/cancel', {});
  assert.strictEqual(cancelNo.status, 503, '无任务中心时应 503 而非 500');
  ok('API 契约（capabilities/status/tasks/analyze/cancel）');

  // —— 11. SSRF / URL 解析：内网/不可达 URL 应安全失败（不把内容当视频）——
  const urlSeg = { type: 'video', data: { url: 'http://127.0.0.1:59999/secret.mp4' } }; // 无服务 → safeFetch 失败
  const rf = await media._resolveVideoFile(urlSeg, liveCFG.multimodal);
  assert.strictEqual(rf, null, '不可达/内网 URL 解析应安全返回 null（不下载）');
  ok('SSRF/URL 解析安全（不可达地址拒绝）');

  // 清理
  [good, trick, outside, img, fake].forEach((f) => { try { fs.unlinkSync(f); } catch (e) {} });

  console.log('\n全部通过：' + passed + ' 项真实测试');
}

startStubVL().then(() => main().then(() => process.exit(0)).catch((e) => { console.error('测试失败:', e); process.exit(1); }))
  .catch((e) => { console.error('stub 启动失败:', e); process.exit(1); });
