'use strict';
// ================= V14-C 测试套件 =================
// 覆盖：Image / Video / Bilibili 三个 Tool + 权限 + 安全 + 意图 + 回归
// 说明：单元部分用「假但真实形状」的依赖，真实 API 部分单独跑（见报告）。

const fs = require('fs');
const path = require('path');
const router = require('../agent/tool_router');
const intentMod = require('../agent/intent');
const tools = require('../tools');
const imageMod = require('../tools/image');
const videoMod = require('../tools/video');
const biliMod = require('../tools/bilibili');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name) { if (cond) pass++; else { fail++; fails.push(name); console.log('  ✗ ' + name); } }
function eq(a, b, name) { ok(a === b, name + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function group(t) { console.log('\n[' + t + ']'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SRC = fs.readFileSync(path.join(__dirname, '..', 'ai_bridge.js'), 'utf-8');
// 真实配置 ai_config.json 不入库（隐私），克隆仓库里只有模板：读不到就回落到 example
const cfgPath = fs.existsSync(path.join(__dirname, '..', 'ai_config.json'))
  ? path.join(__dirname, '..', 'ai_config.json')
  : path.join(__dirname, '..', 'ai_config.example.json');
const CFG = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));

// —— 假依赖（形状与 ai_bridge 注入的真实适配层一致）——
function makeDeps(over) {
  return Object.assign({
    getCurrentTime: () => '2026-10-08 19:00 星期四',
    webSearch: async (q) => '搜索「' + q + 0 + '」的结果：\n1. 标题一\n   https://a.com',
    fetchUrl: async (u) => '网页正文',
    isSafeUrl: (u) => { try { const p = new URL(u); return /^https?:$/.test(p.protocol) && !/^(127\.|10\.|192\.168\.|localhost)/.test(p.hostname); } catch (e) { return false; } },
    getNotes: () => [],
    getShortTerm: () => [],
    rememberNote: () => '记住了',
    readFile: (name) => (name === 'a.txt' ? { ok: true, name, text: '内容', size: 6, truncated: false } : { ok: false, error: '无' }),
    writeFile: () => ({ ok: true, name: 'a.txt', size: 3 }),
    listFiles: () => [{ name: 'a.txt', size: 6 }],
    isWritableName: (n) => !/\.(xlsx|zip|pdf|png|mp4)$/i.test(n),
    getForwardMsg: null,
    getPendingRecord: null,
    // V14-C
    visionAnalyze: async (segs, q) => ({ ok: true, text: '图中是 VISION_TEST_7319 标记', imageCount: segs.length, imageOK: segs.length, imageFail: 0, model: 'deepseek-chat' }),
    analyzeVideo: async () => ({ ok: true, data: { width: 1920, height: 1080, duration: 8, format: 'mp4', videoCodec: 'h264', firstFrameAvailable: true, firstFrameAnswer: '首帧显示一名人物', model: 'deepseek-chat' } }),
    bilibiliEnabled: true,
  }, over || {});
}

// 受信任的图片/视频引用（来自真实 QQ 事件，不是模型编的）
const IMG_SEG = { type: 'image', data: { file: 'a.jpg', url: 'https://multimedia.nt.qq.com.cn/a.jpg' } };
const VID_SEG = { type: 'video', data: { file: 'v.mp4', url: 'https://multimedia.nt.qq.com.cn/v.mp4' } };
function ctxWith(media) {
  return { input: { media: media || {}, chatId: 'c1', sessionId: 's1' }, userId: 1, groupId: 2, isGroup: false };
}

// ============================================================
group('Tool Registry：V14-C 注册与权限');

router.reset();
const registered = tools.registerAll(makeDeps());

ok(registered.indexOf('image_analysis') >= 0, '注册 image_analysis');
ok(registered.indexOf('video_analysis') >= 0, '注册 video_analysis');
ok(registered.indexOf('bilibili_search') >= 0, '注册 bilibili_search');
ok(registered.indexOf('web_search') >= 0, 'V14-B 的 web_search 仍在（未破坏）');
ok(registered.indexOf('chat_record_analysis') >= 0, 'V14-B 的 chat_record_analysis 仍在（未破坏）');
ok(registered.length >= 12, '工具总数 ≥ 12（实际 ' + registered.length + '）');

const pm = tools.permissionMap();
ok(pm.SAFE.indexOf('image_analysis') >= 0, 'image_analysis = SAFE');
ok(pm.SAFE.indexOf('video_analysis') >= 0, 'video_analysis = SAFE');
ok(pm.SAFE.indexOf('bilibili_search') >= 0, 'bilibili_search = SAFE');
eq(pm.SENSITIVE.length, 0, 'SENSITIVE 仍然为空');
ok(pm.LIMITED.indexOf('file_read') >= 0, 'V14-B 的 file_read 仍是 LIMITED（未被降级）');

const tImg = router.getTool('image_analysis');
const tVid = router.getTool('video_analysis');
const tBili = router.getTool('bilibili_search');
ok(!!(tImg && tImg.inputSchema && tImg.inputSchema.properties), 'image_analysis 有 inputSchema');
ok(!!(tVid && tVid.inputSchema && tVid.inputSchema.properties), 'video_analysis 有 inputSchema');
ok(!!(tBili && tBili.inputSchema && tBili.inputSchema.properties), 'bilibili_search 有 inputSchema');
ok(!!(tImg && typeof tImg.handler === 'function'), 'image_analysis 有 handler');
ok(!!(tVid && typeof tVid.handler === 'function'), 'video_analysis 有 handler');
ok(!!(tBili && typeof tBili.handler === 'function'), 'bilibili_search 有 handler');
ok(tImg.inputSchema.additionalProperties === false, 'image_analysis 禁止未知参数');
ok(tVid.inputSchema.additionalProperties === false, 'video_analysis 禁止未知参数');
ok(tBili.inputSchema.additionalProperties === false, 'bilibili_search 禁止未知参数');

// ============================================================
(async () => {

  // ---------- Image ----------
  group('Image：Schema / 安全 / 执行');

  let r = await router.execute('image_analysis', { path: 'D:\\qq\\a.png' }, ctxWith({ imageSegs: [IMG_SEG] }));
  ok(!r.ok && r.reason === 'schema-invalid', 'image_analysis 不接受 path 参数（结构级拒绝任意路径）');

  r = await router.execute('image_analysis', { url: 'https://x.com/a.png' }, ctxWith({ imageSegs: [IMG_SEG] }));
  ok(!r.ok && r.reason === 'schema-invalid', 'image_analysis 不接受 url 参数');

  r = await router.execute('image_analysis', { question: 'x'.repeat(201) }, ctxWith({ imageSegs: [IMG_SEG] }));
  ok(!r.ok && r.reason === 'schema-invalid', 'question 超长被 Schema 拒绝');

  r = await router.execute('image_analysis', { source: 'D:\\Windows' }, ctxWith({ imageSegs: [IMG_SEG] }));
  ok(!r.ok && r.reason === 'schema-invalid', 'source 必须是枚举值');

  r = await router.execute('image_analysis', {}, ctxWith({}));
  ok(!r.ok && r.reason === 'safety-blocked', '当前消息没有图片 → 安全检查拒绝');

  r = await router.execute('image_analysis', { index: 5 }, ctxWith({ imageSegs: [IMG_SEG] }));
  ok(!r.ok && r.reason === 'safety-blocked', 'index 超出图片数量 → 拒绝');

  r = await router.execute('image_analysis', { source: 'chat_record' }, ctxWith({ imageSegs: [IMG_SEG] }));
  ok(!r.ok && r.reason === 'safety-blocked', '没有已解析聊天记录却要分析记录里的图 → 拒绝');

  r = await router.execute('image_analysis', { question: '这图是什么' }, ctxWith({ imageSegs: [IMG_SEG] }));
  ok(r.ok, '正常图片：执行成功');
  eq(r.result.tool, 'image_analysis', '成功返回的 tool 名正确');
  ok(r.result.data.answer.indexOf('VISION_TEST_7319') >= 0, '分析结果里能读到图上的测试标记');
  eq(r.result.data.model, 'deepseek-chat', '图片用的是多模态模型 deepseek-chat');
  eq(r.result.data.source, 'current_message', '来源标记为 current_message');
  ok(r.result.metadata.itemCount >= 1, 'metadata.itemCount ≥ 1');
  ok(typeof r.result.metadata.durationMs === 'number', 'metadata.durationMs 是数字');

  r = await router.execute('image_analysis', {}, ctxWith({ imageSegs: [IMG_SEG, IMG_SEG, IMG_SEG] }));
  ok(r.ok && r.result.data.imageCount === 3, '多图片：imageCount 正确');

  r = await router.execute('image_analysis', { source: 'chat_record' }, ctxWith({ chatRecord: { images: [{ file: 'i.jpg', url: 'https://multimedia.nt.qq.com.cn/i.jpg' }], videos: [] } }));
  ok(r.ok && r.result.data.source === 'chat_record', '聊天记录里的图片：来源标记 chat_record');

  // 失败不伪装
  router.reset();
  tools.registerAll(makeDeps({
    visionAnalyze: async () => ({ ok: false, error: '图片全部获取失败' }),
  }));
  r = await router.execute('image_analysis', {}, ctxWith({ imageSegs: [IMG_SEG] }));
  ok(r.result && r.result.ok === false, '图片分析失败 → 工具返回 ok:false');
  eq(r.result.data, null, '失败时 data 为 null，不伪造内容');
  ok(String(r.result.error).indexOf('失败') >= 0, '失败时 error 写明原因');
  ok(String(r.result.tool) === 'image_analysis', '失败结果仍带正确 tool 名');

  // 超时（把超时阈值临时调到 300ms 以便快速验证，不改变任何安全策略）
  router.reset();
  tools.registerAll(makeDeps({ visionAnalyze: () => new Promise(() => {}) }));  // 永不 resolve
  const imgTool = router.getTool('image_analysis');
  const savedTimeout = imgTool.timeout;
  imgTool.timeout = 300;
  const t0 = Date.now();
  r = await router.execute('image_analysis', {}, ctxWith({ imageSegs: [IMG_SEG] }));
  ok(!r.ok && r.reason === 'timeout', '图片工具超时被强制终止（不卡死）');
  ok(Date.now() - t0 < 3000, '超时在合理时间内返回（' + (Date.now() - t0) + 'ms）');
  imgTool.timeout = savedTimeout;

  // 模型路由（源码级）
  ok(/MULTIMODAL_MODEL\s*=\s*'deepseek-chat'/.test(SRC), '★MULTIMODAL_MODEL 常量就是 deepseek-chat');
  ok(/kind:\s*'vision'/.test(SRC), '★图片分析调用计入 kind=vision');
  ok(/async function agentVisionAnalyze[\s\S]{0,1200}fetchImageAsBase64\(seg\)/.test(SRC), '★图片分析复用现有 fetchImageAsBase64（未重写下载）');
  ok(!/agentVisionAnalyze[\s\S]{0,800}deepseek-v4-pro/.test(SRC), '图片分析不会落到纯文本推理模型');
  eq(CFG.model.multimodal, 'deepseek-chat', '配置里 multimodal = deepseek-chat');

  // ---------- Video ----------
  group('Video：Schema / 安全 / 能力边界');

  router.reset();
  tools.registerAll(makeDeps());

  r = await router.execute('video_analysis', { path: 'C:\\Windows\\x.mp4' }, ctxWith({ videoSegs: [VID_SEG] }));
  ok(!r.ok && r.reason === 'schema-invalid', 'video_analysis 不接受 path（模型无法指名本地文件）');

  r = await router.execute('video_analysis', { url: 'https://evil.com/x.mp4' }, ctxWith({ videoSegs: [VID_SEG] }));
  ok(!r.ok && r.reason === 'schema-invalid', 'video_analysis 不接受 url');

  r = await router.execute('video_analysis', { source: 'D:\\qq' }, ctxWith({ videoSegs: [VID_SEG] }));
  ok(!r.ok && r.reason === 'schema-invalid', 'source 必须是枚举值');

  r = await router.execute('video_analysis', {}, ctxWith({}));
  ok(!r.ok && r.reason === 'safety-blocked', '当前消息没有视频 → 拒绝');

  r = await router.execute('video_analysis', { source: 'chat_record' }, ctxWith({ videoSegs: [VID_SEG] }));
  ok(!r.ok && r.reason === 'safety-blocked', '没有聊天记录却要分析记录里的视频 → 拒绝');

  r = await router.execute('video_analysis', { source: 'chat_record' }, ctxWith({ chatRecord: { images: [], videos: [] } }));
  ok(!r.ok && r.reason === 'safety-blocked', '聊天记录里没有视频 → 拒绝');

  r = await router.execute('video_analysis', { question: '看看这个视频' }, ctxWith({ videoSegs: [VID_SEG] }));
  ok(r.ok, '正常视频：执行成功');
  eq(r.result.data.analysisScope, 'metadata+first_frame', '有首帧时 analysisScope = metadata+first_frame');
  eq(r.result.data.width, 1920, '元数据 width 正确');
  eq(r.result.data.height, 1080, '元数据 height 正确');
  eq(r.result.data.duration, 8, '元数据 duration 正确');
  eq(r.result.data.videoCodec, 'h264', '元数据 videoCodec 正确');
  eq(r.result.data.firstFrameAvailable, true, 'firstFrameAvailable = true');
  ok(String(r.result.data.limitation).indexOf('未做逐帧') >= 0, '★返回里明确写出「未做逐帧」的能力边界');
  ok(String(router.getTool('video_analysis').description).indexOf('不做逐帧') >= 0, '★Tool 描述里写明不做逐帧分析');
  ok(String(router.getTool('video_analysis').description).indexOf('逐帧') >= 0, 'Tool 描述含逐帧限制说明');

  // 首帧不可用 → 只能元数据，仍不算失败，但 scope 必须降级
  router.reset();
  tools.registerAll(makeDeps({
    analyzeVideo: async () => ({ ok: true, data: { width: 640, height: 360, duration: 3, firstFrameAvailable: false } }),
  }));
  r = await router.execute('video_analysis', {}, ctxWith({ videoSegs: [VID_SEG] }));
  ok(r.ok, '首帧不可用：工具本身仍成功（拿到元数据）');
  eq(r.result.data.analysisScope, 'metadata_only', '★首帧不可用 → analysisScope 降为 metadata_only');
  eq(r.result.data.firstFrameAvailable, false, 'firstFrameAvailable = false，不假装成功');
  ok(String(r.result.summary).indexOf('首帧不可用') >= 0, 'summary 明确告知首帧不可用');

  // 拿不到文件 → 明确失败
  router.reset();
  tools.registerAll(makeDeps({ analyzeVideo: async () => ({ ok: false, error: '拿不到视频文件' }) }));
  r = await router.execute('video_analysis', {}, ctxWith({ videoSegs: [VID_SEG] }));
  ok(r.result && r.result.ok === false, '拿不到视频文件 → 工具返回 ok:false');
  eq(r.result.data, null, '失败时 data 为 null');

  // 视频路径安全（源码级：白名单根目录 / realpath / 扩展名 / 大小）
  ok(/function safeVideoPath/.test(SRC), '存在 safeVideoPath 路径校验函数');
  ok(/fs\.realpathSync\(p\)/.test(SRC), '★视频路径做了 realpath（防软链穿越）');
  ok(/VIDEO_ALLOWED_ROOTS\s*=\s*\[/.test(SRC), '★视频只允许白名单根目录');
  ok(/path\.join\(__dirname,\s*'workspace'\)/.test(SRC) && /path\.join\(__dirname,\s*'napcat',\s*'cache'\)/.test(SRC),
    '白名单根目录 = workspace + napcat/cache（不含 D:\\qq、不含任意盘符）');
  ok(/VIDEO_EXT\.has\(path\.extname\(real\)/.test(SRC), '视频扩展名走白名单');
  ok(/st\.size\s*>\s*MAX_VIDEO_BYTES/.test(SRC), '视频有大小上限');
  ok(/MAX_VIDEO_BYTES\s*=\s*100\s*\*\s*1024\s*\*\s*1024/.test(SRC), '视频大小上限 100MB（视频专用常量，未改文件工具限制）');
  ok(/isSafeUrl\(url\)/.test(SRC.slice(SRC.indexOf('async function resolveVideoFile'), SRC.indexOf('async function resolveVideoFile') + 3000)),
    '★视频 URL 下载继续走现有 isSafeUrl（SSRF 防护未绕过）');
  ok(/VIDEO_EXT\s*=\s*new Set\(\['\.mp4'/.test(SRC), '视频扩展名白名单含 .mp4');
  ok(!/'\.exe'|'\.bat'|'\.cmd'|'\.ps1'/.test(SRC.slice(SRC.indexOf('VIDEO_EXT'), SRC.indexOf('VIDEO_EXT') + 300)),
    '视频扩展名白名单不含可执行类型');

  // 真实能力探测（不是猜的）。addon 由 NapCat 框架提供，本仓库不含 NapCat：
  // 文件不在时这三条记为 SKIP 而不是失败。
  const addonPath = path.join(__dirname, '..', 'napcat', 'native', 'ffmpeg', 'ffmpegAddon.win32.x64.node');
  const addonPresent = fs.existsSync(addonPath);
  if (!addonPresent) console.log('  - SKIP napcat 自带 ffmpeg native addon（本仓库不含 NapCat 框架，属预期）');
  else ok(true, '★napcat 自带 ffmpeg native addon 文件存在');
  let addonOK = false, addonHasGetInfo = false;
  if (addonPresent) {
    try {
      const a = require(addonPath);
      addonOK = true;
      addonHasGetInfo = typeof a.getVideoInfo === 'function';
    } catch (e) { /* 加载失败就如实记为 false */ }
    ok(addonOK, '★ffmpeg native addon 可被加载（无需 ffmpeg.exe）');
    ok(addonHasGetInfo, '★addon 提供 getVideoInfo（元数据 + 首帧）');
  }
  ok(!fs.existsSync(path.join(__dirname, '..', 'ffmpeg.exe')), '项目内确实没有 ffmpeg.exe（如实）');

  // 视频调用计费
  ok(/kind:\s*'video'/.test(SRC), '★视频首帧分析计入 kind=video');

  // ---------- Bilibili ----------
  group('Bilibili：Schema / 清洗 / 结构化');

  router.reset();
  tools.registerAll(makeDeps());

  ok(biliMod.API_HOST === 'https://api.bilibili.com', '★请求地址硬编码为 api.bilibili.com（参数无法改 → 结构上杜绝 SSRF）');

  r = await router.execute('bilibili_search', {}, ctxWith({}));
  ok(!r.ok && r.reason === 'schema-invalid', '缺 query → Schema 拒绝');

  r = await router.execute('bilibili_search', { query: '' }, ctxWith({}));
  ok(!r.ok, '空 query → 拒绝');

  r = await router.execute('bilibili_search', { query: 'x'.repeat(61) }, ctxWith({}));
  ok(!r.ok && r.reason === 'schema-invalid', '超长 query → Schema 拒绝');

  r = await router.execute('bilibili_search', { query: '!!!@@@###' }, ctxWith({}));
  ok(!r.ok && r.reason === 'safety-blocked', '纯符号 query → 安全检查拒绝');

  r = await router.execute('bilibili_search', { query: 'GTA6', evil: 1 }, ctxWith({}));
  ok(!r.ok && r.reason === 'schema-invalid', '未知参数 → 拒绝');

  eq(biliMod.stripTags('<em class="keyword">GTA6</em> 最新消息'), 'GTA6 最新消息', '★高亮标签被剥掉');
  eq(biliMod.cleanQuery('搜一下 https://a.com/x GTA6'), '搜一下 GTA6', 'query 里的网址被清洗掉');
  eq(biliMod.isBadQuery('   '), 'query 不能为空', '空白 query 有明确错误文案');

  const it = biliMod.normalizeItem({ title: '<em class="keyword">A</em>B', bvid: 'BV1mRHy6fEaC', author: '某人', description: '', duration: '2:18', pubdate: 1791382221, play: 100 });
  eq(it.title, 'AB', '★标题里的 HTML 标签被剥离');
  eq(it.bvid, 'BV1mRHy6fEaC', '★BV 号原样保留');
  eq(it.author, '某人', '★UP 主字段保留');
  eq(it.url, 'https://www.bilibili.com/video/BV1mRHy6fEaC', '★链接由 BV 号拼出且是 https');
  eq(it.description, null, '★简介为空 → null，不编造');
  eq(it.duration, '2:18', '时长字段保留');

  const it2 = biliMod.normalizeItem({ title: 'x' });
  eq(it2.bvid, null, '★缺 BV 号 → null');
  eq(it2.author, null, '★缺 UP 主 → null');
  eq(it2.description, null, '★缺简介 → null');
  eq(it2.url, null, '★拼不出链接 → null');
  eq(biliMod.normalizeItem(null), null, '异常 item → null');

  // ---------- 意图 ----------
  group('Intent：图片 / 视频 / B站');

  let x = intentMod.detectIntent('帮我识别一下这张图', { hasImage: true });
  ok(x.intents.indexOf('image_analysis') >= 0, '「识别这张图」→ image_analysis 意图');
  ok(x.suggestedTools.some((t) => t.tool === 'image_analysis'), '→ 建议 image_analysis 工具');

  x = intentMod.detectIntent('这张图里有什么？', { hasImage: true });
  ok(x.suggestedTools.some((t) => t.tool === 'image_analysis'), '「图里有什么」→ image_analysis');

  x = intentMod.detectIntent('看看这个图片', { hasImage: true });
  ok(x.suggestedTools.some((t) => t.tool === 'image_analysis'), '「看看这个图片」→ image_analysis');

  x = intentMod.detectIntent('好看吧', { hasImage: true });
  ok(!x.suggestedTools.some((t) => t.tool === 'image_analysis'), '★带图但只是随口一句 → 不调用工具（避免重复计费）');

  x = intentMod.detectIntent('我今天聊到了图片和视频', {});
  ok(!x.suggestedTools.some((t) => t.tool === 'image_analysis' || t.tool === 'video_analysis'),
    '★普通聊天里出现「图片/视频」字样 → 不调用工具');

  x = intentMod.detectIntent('帮我分析一下这个视频', { hasVideo: true });
  ok(x.intents.indexOf('video_analysis') >= 0, '「分析这个视频」→ video_analysis');
  eq(x.suggestedTools.find((t) => t.tool === 'video_analysis').args.source, 'current_message', '视频来源 = 当前消息');

  x = intentMod.detectIntent('看看这个视频', { hasVideo: true });
  ok(x.suggestedTools.some((t) => t.tool === 'video_analysis'), '「看看这个视频」→ video_analysis');

  x = intentMod.detectIntent('这个视频讲了什么', { hasVideo: true });
  ok(x.suggestedTools.some((t) => t.tool === 'video_analysis'), '「视频讲了什么」→ video_analysis');

  x = intentMod.detectIntent('帮我找几个GTA6的B站视频', {});
  ok(x.suggestedTools.some((t) => t.tool === 'bilibili_search'), '「找几个B站视频」→ bilibili_search');

  x = intentMod.detectIntent('B站有没有这个', {});
  ok(x.suggestedTools.some((t) => t.tool === 'bilibili_search'), '「B站有没有这个」→ bilibili_search');

  x = intentMod.detectIntent('BV1mRHy6fEaC', {});
  ok(x.suggestedTools.some((t) => t.tool === 'bilibili_search'), '★直接给 BV 号 → bilibili_search');

  x = intentMod.detectIntent('我挺喜欢那个UP主的', {});
  ok(!x.suggestedTools.some((t) => t.tool === 'bilibili_search'), '★只是提到 UP 主、没有搜/找意图 → 不调用 B站工具');

  x = intentMod.detectIntent('看看里面的视频', { hasForward: true, hasChatRecordVideo: true, hasVideo: false });
  ok(x.suggestedTools.some((t) => t.tool === 'chat_record_analysis'), '合并转发 + 视频：先解析聊天记录');
  ok(x.suggestedTools.some((t) => t.tool === 'video_analysis'), '合并转发 + 视频：再分析视频');
  eq(x.suggestedTools.find((t) => t.tool === 'video_analysis').args.source, 'chat_record', '★记录里的视频来源 = chat_record');
  ok(x.intents.indexOf('multi_step_task') >= 0, '合并转发 + 视频 → 识别为多步骤任务');

  x = intentMod.detectIntent('看看里面的图片', { hasForward: true, hasChatRecordImage: true, hasImage: false });
  ok(x.suggestedTools.some((t) => t.tool === 'image_analysis'), '★合并转发里的图片 → image_analysis');
  eq(x.suggestedTools.find((t) => t.tool === 'image_analysis').args.source, 'chat_record', '图片来源 = chat_record');

  x = intentMod.detectIntent('你好', {});
  ok(!x.suggestedTools.length, '★「你好」仍然 0 工具调用');

  x = intentMod.detectIntent('你觉得GTA6怎么样？', {});
  ok(!x.suggestedTools.some((t) => t.tool === 'web_search' || t.tool === 'bilibili_search'),
    '★「你觉得GTA6怎么样」仍然不触发搜索');

  // ---------- 回归 ----------
  group('回归：V14-A / 安全边界 / 防重复计费');

  eq(CFG.agent.maxSteps, 5, 'maxSteps 仍为 5');
  eq(CFG.agent.maxToolCalls, 5, 'maxToolCalls 仍为 5');
  eq(CFG.agent.maxRetries, 1, 'maxRetries 仍为 1');

  r = await router.execute('execute_shell', { cmd: 'dir' }, ctxWith({}));
  ok(!r.ok && r.reason === 'forbidden-tool', '★execute_shell 仍被拒绝');
  r = await router.execute('powershell', {}, ctxWith({}));
  ok(!r.ok && r.reason === 'forbidden-tool', '★powershell 仍被拒绝');
  r = await router.execute('delete_file', {}, ctxWith({}));
  ok(!r.ok && r.reason === 'forbidden-tool', '★delete_file 仍被拒绝');
  r = await router.execute('screen_record', {}, ctxWith({}));
  ok(!r.ok && r.reason === 'forbidden-tool', '★录屏工具仍被拒绝');
  r = await router.execute('camera', {}, ctxWith({}));
  ok(!r.ok && r.reason === 'forbidden-tool', '★摄像头工具仍被拒绝');

  const SRC_NOCOMMENT = SRC.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  ok(!/child_process|execSync|spawnSync|spawn\(/.test(SRC_NOCOMMENT), '★ai_bridge 未引入任何子进程执行能力');
  ok(!/powershell|Start-Process|cmd\.exe/i.test(SRC_NOCOMMENT), '★ai_bridge 未引入 PowerShell / 程序启动');

  ok(/imageHandledByAgent/.test(SRC), '★存在「图已由 Agent 处理」标记');
  ok(/image_analysis 处理，本次不再重复发送原图/.test(SRC), '★Agent 分析过图后剥掉原图 parts（防重复计费）');
  ok(/parts\[i\]\.type === 'image_url'/.test(SRC), '剥离逻辑确实作用于 image_url parts');

  ok(/videoSegs\s*=\s*segments\(ev\.message\)/.test(SRC), '★视频段来自真实事件（不是模型给的路径）');
  ok(/chatRecordMediaRefs/.test(SRC), '聊天记录媒体只抽取 {file,url} 引用');

  // V14-B 未破坏
  ok(pm.SAFE.indexOf('web_search') >= 0 && pm.SAFE.indexOf('memory_search') >= 0, 'V14-B 的 SAFE 工具仍在');
  ok(pm.LIMITED.indexOf('memory_write') >= 0 && pm.LIMITED.indexOf('file_write') >= 0, 'V14-B 的 LIMITED 工具仍在');

  // ---------- 汇总 ----------
  console.log('\n' + '='.repeat(52));
  console.log(`V14-C 测试：通过 ${pass}，失败 ${fail}`);
  if (fail) { console.log('失败项：'); fails.forEach((f) => console.log('  - ' + f)); }
  console.log('='.repeat(52));
  process.exit(fail ? 1 : 0);
})();
