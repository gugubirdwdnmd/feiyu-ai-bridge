'use strict';
// ================= 生图 / 表情包 Tool（注册进 V14 Tool Registry）=================
// 关键：planner 是规则式的，只执行 intent.suggestedTools，模型不能自选工具。
// 所以光在 ai_bridge 的 TOOLS 数组里加函数没用 —— 必须注册进 agent/tool_router，
// 并在 agent/intent.js 里给出 suggestedTools，才会被真正执行。
//
// 本模块只做「注册 + 参数校验 + 结果包装」，真正的出图逻辑仍由 ai_bridge 注入的
// deps.generateImage / deps.sendSticker 承担（复用已有的队列、安全过滤、ComfyUI 链路）。

const router = require('../agent/tool_router');
const R = require('./result');

// 生图失败文案标记（ai_bridge 的 generateImageTool 用自然语言返回失败）
const FAIL_MARKERS = [
  '生图功能没开', '没写画面', '不能画', '冷却中', '已经有张图在排队',
  '队列满了', '没画出来', '没有可用的图', '没法做图生图', '没发出来', '不知道该发到哪个会话',
];

function register(deps) {
  const out = [];
  const d = deps || {};

  // —— generate_image：文生图 / 图生图 ——
  if (typeof d.generateImage === 'function') {
    const r = router.registerTool({
      name: 'generate_image',
      description:
        '画图（文生图 / 图生图）。想画什么就把画面写清楚（主体、动作、环境、光线、画风都可以写）。' +
        '要基于对方刚发的那张图来改（改风格、重绘、换个样子），把 source 填 "1"。' +
        '图会自动发到当前聊天里，不用你再转发。对方只是发图问问题、让你看图说话时，不要用这个工具。',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            minLength: 2,
            maxLength: 500,
            description: '画面描述。写具体一点：主体 + 动作/神态 + 环境 + 光线 + 画风。中文即可。',
          },
          source: {
            type: 'string',
            maxLength: 20,
            description: '图生图时填 "1"，表示用对方最近发的第 1 张图作为底图。文生图不要填。',
          },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      permission: router.PERMISSION.SAFE,
      timeout: 240000,          // 出图慢（实测 30~60s），超时给足
      tokenCost: 0,
      riskLevel: 'low',
      handler: async (args, ctx) => {
        const t0 = R.nowMs();
        let text;
        try {
          text = await d.generateImage(String(args.prompt || '').trim(), String(args.source || '').trim(), ctx || {});
        } catch (e) {
          return R.failResult('generate_image', '生图异常：' + String((e && e.message) || e).slice(0, 80), false,
            { durationMs: R.nowMs() - t0 });
        }
        const ms = R.nowMs() - t0;
        const failed = R.looksFailed(text, FAIL_MARKERS);
        if (failed) {
          return R.failResult('generate_image', String(text).slice(0, 180), false, { durationMs: ms });
        }
        return R.okResult('generate_image', {
          prompt: String(args.prompt || ''),
          img2img: !!String(args.source || '').trim(),
        }, String(text).slice(0, 220), { durationMs: ms, itemCount: 1 });
      },
    });
    if (r.ok) out.push('generate_image');
  }

  // —— send_sticker：发表情包 ——
  if (typeof d.sendSticker === 'function') {
    const r2 = router.registerTool({
      name: 'send_sticker',
      description:
        '发一个表情包图片。想吐槽、接梗、阴阳、乐一下、无语、夸人时用。' +
        'keyword 可以写心情或梗（如 开心、无语、绷不住了、666、我谢谢你），不写就随机发一个。',
      inputSchema: {
        type: 'object',
        properties: {
          keyword: { type: 'string', maxLength: 30, description: '表情包关键词，可不填（随机）' },
        },
        required: [],
        additionalProperties: false,
      },
      permission: router.PERMISSION.SAFE,
      timeout: 15000,
      tokenCost: 0,
      riskLevel: 'low',
      handler: async (args, ctx) => {
        const t0 = R.nowMs();
        let text;
        try {
          text = await d.sendSticker(String(args.keyword || '').trim(), ctx || {});
        } catch (e) {
          return R.failResult('send_sticker', '发送异常：' + String((e && e.message) || e).slice(0, 80), false,
            { durationMs: R.nowMs() - t0 });
        }
        const ms = R.nowMs() - t0;
        if (R.looksFailed(text, ['发不出去', '失败'])) {
          return R.failResult('send_sticker', String(text).slice(0, 120), false, { durationMs: ms });
        }
        return R.okResult('send_sticker', { keyword: String(args.keyword || '') }, String(text).slice(0, 120),
          { durationMs: ms, itemCount: 1 });
      },
    });
    if (r2.ok) out.push('send_sticker');
  }

  return out;
}

module.exports = { register, FAIL_MARKERS };
