'use strict';
// chat_record_parser 测试套件（单元测试 + 接近真实的 NapCat 合并转发模拟）。
// 运行：node chat_record_parser/test.js
// 覆盖：normalize / parser / media 三大类，断言数 > 30。
const { normalizeNode, segToContent, normSender, guessMime } = require('./normalize');
const { detectForwardSegments, buildChatRecord, applyLimits, genChatRecordId } = require('./parser');
const { isSafeMediaRef, collectImageRefs, collectVideoRefs, buildTextForModel, buildMultimodalParts, summarizeVideos } = require('./media');
const crpIndex = require('./index');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond) { if (cond) { pass++; } else { fail++; fails.push(name); } }
function eq(name, a, b) { ok(name + ' (期望 ' + JSON.stringify(b) + ' 实得 ' + JSON.stringify(a) + ')', JSON.stringify(a) === JSON.stringify(b)); }

async function main() {
  // ============ index 公共入口 ============
  ok('index 导出 buildChatRecord', typeof crpIndex.buildChatRecord === 'function');
  ok('index 导出 buildMultimodalParts', typeof crpIndex.buildMultimodalParts === 'function');
  ok('index 导出 normalizeNode', typeof crpIndex.normalizeNode === 'function');

  // ============ normalize ============
  eq('guessMime jpg', guessMime('a.jpg'), 'image/jpeg');
  eq('guessMime 未知回退', guessMime('a.xyz', 'image/png'), 'image/png');
  eq('normSender 缺昵称', normSender({ user_id: '123' }).nickname, '用户123');
  eq('normSender 用 card', normSender({ user_id: '1', card: '小明' }).nickname, '小明');

  eq('segToContent text', segToContent({ type: 'text', data: { text: 'hi' } }).text, 'hi');
  eq('segToContent 字符串', segToContent('raw').type, 'text');
  eq('segToContent null', segToContent(null), null);
  const img = segToContent({ type: 'image', data: { file: 'F', url: 'http://x/y.png' } });
  eq('segToContent image type', img.type, 'image');
  eq('segToContent image url', img.url, 'http://x/y.png');
  eq('segToContent image mime', img.mime, 'image/png');
  const vid = segToContent({ type: 'video', data: { file: 'V', url: 'http://x/v.mp4', duration: 12 } });
  eq('segToContent video duration', vid.duration, 12);
  eq('segToContent reply', segToContent({ type: 'reply', data: { id: '9' } }).type, 'reply');
  eq('segToContent at→text', segToContent({ type: 'at', data: { qq: '5' } }).text, '@5 ');
  eq('segToContent face→表情', segToContent({ type: 'face', data: {} }).text, '[表情] ');
  // V14-C.3 C-2：卡片不再把整段原文当正文，改为受控提取；无法解析时给明确占位，不塞原文
  eq('segToContent json→受控提取', segToContent({ type: 'json', data: { data: '<x>' } }).text, '[分享卡片]（无法解析的分享卡片）');
  eq('segToContent forward 内联', segToContent({ type: 'forward', data: { content: [{ type: 'text', data: { text: 'n' } }] } }).type, 'forward');

  // normalizeNode 时间处理
  const n1 = normalizeNode({ time: 1700000000, sender: { user_id: '1', nickname: 'A' }, message: [{ type: 'text', data: { text: 'x' } }] }, 0);
  ok('normalizeNode 秒时间戳', /^\d+\/\d+ \d+:\d+$/.test(n1.time));
  const n2 = normalizeNode({ time: 1700000000000, sender: { user_id: '1', nickname: 'A' }, message: [] }, 0);
  ok('normalizeNode 毫秒时间戳', /^\d+\/\d+ \d+:\d+$/.test(n2.time));
  const n3 = normalizeNode({ time: '2024-11-14T08:30:00Z', sender: {}, message: [] }, 0);
  ok('normalizeNode 字符串时间', /^\d+\/\d+ \d+:\d+$/.test(n3.time));
  const n4 = normalizeNode({ sender: { user_id: '7' }, message: [] }, 2);
  eq('normalizeNode 缺时间用序号', n4.time, '#3');
  const n5 = normalizeNode({ sender: { user_id: '1' }, data: { message: [{ type: 'text', data: { text: 'dm' } }] } }, 0);
  eq('normalizeNode data.message', n5.content[0].text, 'dm');
  const n6 = normalizeNode({ sender: { user_id: '1' }, content: [{ type: 'text', data: { text: 'ct' } }] }, 0);
  eq('normalizeNode content', n6.content[0].text, 'ct');
  const n7 = normalizeNode({ sender: { user_id: '1', nickname: 'B' }, message: [] }, 0);
  eq('normalizeNode sender 昵称', n7.nickname, 'B');
  ok('normalizeNode 垃圾输入不抛错', (() => { try { normalizeNode({ sender: null, message: null }, 0); return true; } catch (e) { return false; } })());

  // ============ parser ============
  eq('detectForwardSegments 命中', detectForwardSegments([{ type: 'forward', data: { id: 'abc' } }])[0].id, 'abc');
  eq('detectForwardSegments 空', detectForwardSegments([{ type: 'text', data: { text: '1' } }]).length, 0);
  ok('genChatRecordId 格式', /^cr_\d{8}_[a-z0-9]{6}$/.test(genChatRecordId()));

  // applyLimits 限流
  const big = { messages: [] };
  for (let i = 0; i < 120; i++) big.messages.push({ time: '#' + i, user_id: '1', nickname: 'A', content: [{ type: 'text', text: 'm' + i }] });
  const lim = applyLimits(big, {});
  eq('applyLimits 消息上限100', lim.messages.length, 100);
  ok('applyLimits 标记截断', lim.limitsApplied.truncated === true);

  const manyImg = { messages: [{ time: 't', user_id: '1', nickname: 'A', content: Array.from({ length: 20 }, () => ({ type: 'image', file: 'f', url: 'u' })) }] };
  eq('applyLimits 图片上限10', applyLimits(manyImg, {}).limitsApplied.images, 10);

  const manyVid = { messages: [{ time: 't', user_id: '1', nickname: 'A', content: Array.from({ length: 8 }, () => ({ type: 'video', file: 'f', url: 'u' })) }] };
  eq('applyLimits 视频上限3', applyLimits(manyVid, {}).limitsApplied.videos, 3);

  const longText = { messages: [{ time: 't', user_id: '1', nickname: 'A', content: [{ type: 'text', text: 'x'.repeat(25000) }] }] };
  ok('applyLimits 文本截断<20000', applyLimits(longText, {}).messages[0].content[0].text.length <= 20000);

  // buildChatRecord 内联 content
  const recInline = await buildChatRecord({
    summary: 'S', source: 'G',
    content: [
      { type: 'node', sender: { user_id: '1', nickname: 'A' }, time: 1700000000, message: [{ type: 'text', data: { text: '你好' } }] },
      { type: 'node', sender: { user_id: '2', nickname: 'B' }, time: 1700000060, message: [{ type: 'image', data: { file: 'F', url: 'http://x/y.png' } }] },
    ],
  });
  eq('buildChatRecord 类型', recInline.type, 'chat_record');
  eq('buildChatRecord 消息数', recInline.messages.length, 2);
  eq('buildChatRecord 摘要', recInline.summary, 'S');
  eq('buildChatRecord 计数图片', recInline.counts.images, 1);
  ok('buildChatRecord 时间顺序', recInline.messages[0].ts <= recInline.messages[1].ts);

  // buildChatRecord 走 getForwardMsg
  let fetchCalls = 0;
  const recFetch = await buildChatRecord({
    id: 'fwd1',
    getForwardMsg: async (id) => { fetchCalls++; return [{ type: 'node', sender: { user_id: '1', nickname: 'A' }, time: 1, message: [{ type: 'text', data: { text: 'zz' } }] }]; },
  });
  eq('buildChatRecord getForwardMsg 调用', fetchCalls, 1);
  eq('buildChatRecord 来自拉取', recFetch.messages[0].content[0].text, 'zz');

  // buildChatRecord 失败场景
  eq('buildChatRecord 空→error', (await buildChatRecord({ id: 'x' })).error, 'empty');
  eq('buildChatRecord 拉取失败→error', (await buildChatRecord({ id: 'y', getForwardMsg: async () => { throw new Error('boom'); } })).error, 'fetch_failed');
  const recBad = await buildChatRecord({
    content: [
      null,
      { type: 'node', sender: { user_id: '1', nickname: 'A' }, time: 1, message: [{ type: 'text', data: { text: 'ok' } }] },
      'garbage',
    ],
  });
  eq('buildChatRecord 坏节点降级', recBad.messages.length, 1);

  // ============ media ============
  ok('isSafeMediaRef http', isSafeMediaRef({ url: 'https://cdn/1.png' }));
  ok('isSafeMediaRef 路径穿越拒绝', !isSafeMediaRef({ file: '../../etc/passwd' }));
  ok('isSafeMediaRef 系统目录拒绝', !isSafeMediaRef({ file: 'C:\\Windows\\system32\\x' }));
  ok('isSafeMediaRef 本地缓存路径', isSafeMediaRef({ file: 'D:\\NapCat\\data\\1.png' }));
  ok('isSafeMediaRef 非http拒绝', !isSafeMediaRef({ url: 'ftp://x' }));

  const recForMedia = await buildChatRecord({
    content: Array.from({ length: 15 }, (_, i) => ({ type: 'node', sender: { user_id: '1', nickname: 'A' }, time: i, message: [{ type: 'image', data: { file: 'f' + i, url: 'http://x/' + i + '.png' } }] })),
  });
  eq('collectImageRefs 上限10', collectImageRefs(recForMedia.messages).length, 10);
  const vidRec = await buildChatRecord({
    content: Array.from({ length: 6 }, (_, i) => ({ type: 'node', sender: { user_id: '1', nickname: 'A' }, time: i, message: [{ type: 'video', data: { file: 'v' + i, url: 'http://x/' + i + '.mp4', duration: i } }] })),
  });
  eq('collectVideoRefs 上限3', collectVideoRefs(vidRec.messages).length, 3);

  const recText = await buildChatRecord({
    summary: '摘要S', source: '来源G',
    content: [
      { type: 'node', sender: { user_id: '1', nickname: '小红' }, time: 1700000000, message: [{ type: 'text', data: { text: '在吗' } }, { type: 'image', data: { file: 'f.png', url: 'http://cdn.qq.com/a.png' } }] },
      { type: 'node', sender: { user_id: '2', nickname: '小明' }, time: 1700000060, message: [{ type: 'text', data: { text: '在的' } }, { type: 'video', data: { file: 'v.mp4', url: 'http://cdn.qq.com/v.mp4', duration: 5 } }] },
    ],
  });
  const txt = buildTextForModel(recText, {});
  ok('buildTextForModel 含摘要', txt.includes('摘要S'));
  ok('buildTextForModel 含发言人', txt.includes('小红'));
  ok('buildTextForModel 含图片占位', txt.includes('[图片]'));
  ok('buildTextForModel 含视频占位', txt.includes('[视频'));
  ok('buildTextForModel 不含base64', !txt.includes('base64'));
  const longRec = await buildChatRecord({ content: [{ type: 'node', sender: { user_id: '1', nickname: 'A' }, time: 1, message: [{ type: 'text', data: { text: '字'.repeat(30000) } }] }] });
  ok('buildTextForModel 截断', buildTextForModel(longRec, { maxTextChars: 20000 }).length <= 20050);

  // buildMultimodalParts：注入 fetchImageBytes
  const mm = await buildMultimodalParts(recText, '总结一下', { fetchImageBytes: async () => 'data:image/png;base64,AAA' });
  eq('buildMultimodalParts 含提问', mm.parts[0].text.includes('总结一下'), true);
  ok('buildMultimodalParts 注入图片', mm.parts.some((p) => p.type === 'image_url'));
  eq('buildMultimodalParts 图片成功数', mm.imageOK, 1);
  eq('buildMultimodalParts 视频未分析提示', mm.parts[mm.parts.length - 1].text.includes('视频'), true);

  const mmNull = await buildMultimodalParts(recText, '说说', { fetchImageBytes: async () => null });
  eq('buildMultimodalParts 取图失败 imageFail', mmNull.imageFail, 1);

  const vids = summarizeVideos(recText);
  eq('summarizeVideos 数量', vids.length, 1);
  eq('summarizeVideos 时长', vids[0].duration, 5);

  // ============ 接近真实的 NapCat 合并转发结构（与 napcat.mjs 对齐）============
  const napcatForwardSeg = { type: 'forward', data: { id: 'aBcD123', summary: '群聊的聊天记录', source: '群名称', prompt: '聊天记录' } };
  eq('真实结构 检测 id', detectForwardSegments([napcatForwardSeg])[0].id, 'aBcD123');
  eq('真实结构 摘要', detectForwardSegments([napcatForwardSeg])[0].summary, '群聊的聊天记录');

  // get_forward_msg 返回结构（OB11MessageNode 数组，含 sender/time/message）
  const napcatNodes = [
    { type: 'node', sender: { user_id: 10001, nickname: '张三', card: '三哥', role: 'admin' }, time: 1700000000, message: [{ type: 'text', data: { text: '早' } }], content: [] },
    { type: 'node', sender: { user_id: 10002, nickname: '李四' }, time: 1700000100, message: [{ type: 'text', data: { text: '早啊' } }, { type: 'image', data: { file: 'a.png', url: 'http://cdn/a.png' } }], content: [] },
  ];
  const realRec = await buildChatRecord({
    id: 'aBcD123', summary: '群聊的聊天记录', source: '群名称',
    getForwardMsg: async () => napcatNodes,
  });
  eq('真实结构 消息数', realRec.messages.length, 2);
  eq('真实结构 昵称', realRec.messages[0].nickname, '张三');
  eq('真实结构 角色', realRec.messages[0].role, 'admin');
  eq('真实结构 图片计数', realRec.counts.images, 1);
  eq('真实结构 chatRecordId 前缀', realRec.chatRecordId.startsWith('cr_'), true);
  eq('真实结构 时间顺序', realRec.messages[0].time <= realRec.messages[1].time, true);

  // ============ 报告 ============
  console.log('\n==== chat_record_parser 测试 ====');
  console.log('通过 ' + pass + ' / 失败 ' + fail + '（共 ' + (pass + fail) + ' 项断言）');
  if (fail) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exit(1); }
  else console.log('全部通过 ✅  断言数 = ' + pass + '（要求 ≥30）');
}

main().catch((e) => { console.error('测试运行异常：', e); process.exit(1); });
