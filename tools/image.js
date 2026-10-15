'use strict';
// ================= V14-C：图片理解 Tool =================
// 原则（对应需求第五~九条）：
//   · **不重新实现图片下载**：完全复用 ai_bridge 现有的 fetchImageAsBase64
//     （get_image 本地缓存 → 本地路径 → CDN 下载带 Referer + 重试）；
//   · **不接收任何路径或 URL 参数**：工具入参里根本没有 path/url 字段，
//     图片只能来自「当前 QQ 消息」或「已解析的聊天记录」，模型无法指名本地文件；
//   · **强制走多模态模型**：由 ai_bridge 适配器使用 MULTIMODAL_MODEL（deepseek-flash），
//     绝不落到纯文本推理模型；
//   · 失败 = ok:false，绝不把「没拿到图」包装成「已分析」。

const router = require('../agent/tool_router');
const R = require('./result');

// 从受信任的运行上下文里取图片段（这些段来自真实 QQ 事件，不是模型编的）
function pickSegs(ctx, source) {
  const media = (ctx && ctx.input && ctx.input.media) || {};
  if (source === 'chat_record') {
    const rec = media.chatRecord || null;
    const list = (rec && Array.isArray(rec.images)) ? rec.images : [];
    // 聊天记录里的是已归一化的 {file,url}，包装成 OneBot 段形状以复用现有下载逻辑
    return list.map((im) => ({ type: 'image', data: { file: im.file || '', url: im.url || '' } }));
  }
  const list = Array.isArray(media.imageSegs) ? media.imageSegs : [];
  return list.filter((s) => s && s.type === 'image');
}

function register(deps) {
  const out = [];
  if (typeof deps.visionAnalyze !== 'function') return out;

  const r = router.registerTool({
    name: 'image_analysis',
    description:
      '识别图片内容。图片只能来自当前 QQ 消息或刚解析的聊天记录，' +
      '不接受文件路径或网址。用于「这图是什么 / 图里有什么 / 帮我识别一下」。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', minLength: 0, maxLength: 200, description: '用户想问这张图的问题，可为空' },
        source: {
          type: 'string',
          enum: ['current_message', 'chat_record'],
          description: '图片来源：当前消息 / 聊天记录',
        },
        index: { type: 'number', minimum: 0, maximum: 9, description: '多图时指定第几张（0 起）' },
      },
      required: [],
      additionalProperties: false,
    },
    permission: router.PERMISSION.SAFE,
    timeout: 45000,
    tokenCost: 3,
    riskLevel: 'low',
    // 安全：本工具不接受 path / url，这里再兜一层，防止将来有人加了字段被滥用
    safety: (args, ctx) => {
      const media = (ctx && ctx.input && ctx.input.media) || {};
      if (args.source === 'chat_record' && !media.chatRecord) {
        return { ok: false, error: '当前没有已解析的聊天记录，无法分析其中的图片' };
      }
      if (args.source !== 'chat_record') {
        const n = (Array.isArray(media.imageSegs) ? media.imageSegs : []).filter((s) => s && s.type === 'image').length;
        if (!n) return { ok: false, error: '当前消息里没有图片，无法分析' };
        if (args.index != null && args.index >= n) return { ok: false, error: 'index 超出当前图片数量（共 ' + n + ' 张）' };
      }
      return { ok: true };
    },
    handler: async (args, ctx) => {
      const t0 = R.nowMs();
      const source = args.source || 'current_message';
      let segs = pickSegs(ctx, source);
      if (args.index != null) segs = [segs[args.index]].filter(Boolean);
      if (!segs.length) {
        return R.failResult('image_analysis', '没有可用图片（来源=' + source + '）', false, { durationMs: R.nowMs() - t0 });
      }

      const res = await deps.visionAnalyze(segs, String(args.question || '').slice(0, 200), ctx || {});
      const ms = R.nowMs() - t0;
      if (!res || !res.ok) {
        return R.failResult('image_analysis', (res && res.error) || '图片分析失败', false, { durationMs: ms });
      }
      return R.okResult('image_analysis', {
        question: String(args.question || ''),
        answer: res.text,
        imageCount: res.imageCount,
        imageOK: res.imageOK,
        imageFail: res.imageFail,
        model: res.model,
        source,
      }, res.text ? String(res.text).slice(0, 220) : '（模型未返回内容）', {
        durationMs: ms, itemCount: res.imageOK || 0,
      });
    },
  });
  if (r.ok) out.push('image_analysis');
  return out;
}

module.exports = { register, pickSegs };
