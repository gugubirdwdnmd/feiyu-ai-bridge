'use strict';
// ================= V14-C：视频理解 Tool =================
// 真实能力边界（必须如实，对应需求第十、十一条）：
//   当前版本 = 视频元数据（width/height/duration/format/videoCodec）
//              + **首帧**画面理解（napcat 自带 ffmpeg native addon，无需 ffmpeg.exe）。
//   **不是**逐帧分析，也没有时间维度，不能判断「视频里一直在做什么」。
//   Tool description 与返回里的 analysisScope 都必须写清楚这一点。
//
// 安全（对应需求第十二条）：
//   · 入参里**没有** path / url 字段，模型无法指名 C:\Windows\xx.mp4；
//   · 视频只能来自「当前 QQ 消息」或「已解析的聊天记录」的可信 segment；
//   · 本地文件必须落在白名单根目录内（realpath + 前缀校验，防穿越/软链）；
//   · 走 URL 下载时继续复用现有 SSRF 校验。

const router = require('../agent/tool_router');
const R = require('./result');

const SCOPE_FULL = 'metadata+first_frame';
const SCOPE_META = 'metadata_only';

function pickSegs(ctx, source) {
  const media = (ctx && ctx.input && ctx.input.media) || {};
  if (source === 'chat_record') {
    const rec = media.chatRecord || null;
    const list = (rec && Array.isArray(rec.videos)) ? rec.videos : [];
    return list.map((v) => ({ type: 'video', data: { file: v.file || '', url: v.url || '' } }));
  }
  const list = Array.isArray(media.videoSegs) ? media.videoSegs : [];
  return list.filter((s) => s && s.type === 'video');
}

function register(deps) {
  const out = [];
  if (typeof deps.analyzeVideo !== 'function') return out;

  const r = router.registerTool({
    name: 'video_analysis',
    description:
      '分析视频。当前版本只能给出**视频元数据 + 首帧画面**的理解，' +
      '不做逐帧/时间轴分析，不能判断整个视频里发生了什么。' +
      '视频只能来自当前 QQ 消息或刚解析的聊天记录，不接受文件路径或网址。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', minLength: 0, maxLength: 200, description: '用户想问这个视频的问题，可为空' },
        source: {
          type: 'string',
          enum: ['current_message', 'chat_record'],
          description: '视频来源：当前消息 / 聊天记录',
        },
        index: { type: 'number', minimum: 0, maximum: 2, description: '多个视频时指定第几个（0 起）' },
      },
      required: [],
      additionalProperties: false,
    },
    permission: router.PERMISSION.SAFE,
    timeout: 90000,
    tokenCost: 5,
    riskLevel: 'low',
    safety: (args, ctx) => {
      const media = (ctx && ctx.input && ctx.input.media) || {};
      if (args.source === 'chat_record') {
        if (!media.chatRecord) return { ok: false, error: '当前没有已解析的聊天记录' };
        const n = ((media.chatRecord.videos) || []).length;
        if (!n) return { ok: false, error: '这段聊天记录里没有视频' };
        if (args.index != null && args.index >= n) return { ok: false, error: 'index 超出视频数量（共 ' + n + ' 个）' };
        return { ok: true };
      }
      const n = (Array.isArray(media.videoSegs) ? media.videoSegs : []).filter((s) => s && s.type === 'video').length;
      if (!n) return { ok: false, error: '当前消息里没有视频，无法分析' };
      if (args.index != null && args.index >= n) return { ok: false, error: 'index 超出视频数量（共 ' + n + ' 个）' };
      return { ok: true };
    },
    handler: async (args, ctx) => {
      const t0 = R.nowMs();
      const source = args.source || 'current_message';
      let segs = pickSegs(ctx, source);
      if (args.index != null) segs = [segs[args.index]].filter(Boolean);
      if (!segs.length) {
        return R.failResult('video_analysis', '没有可用视频（来源=' + source + '）', false, { durationMs: R.nowMs() - t0 });
      }

      const res = await deps.analyzeVideo(segs, String(args.question || '').slice(0, 200), ctx || {});
      const ms = R.nowMs() - t0;
      if (!res || !res.ok) {
        return R.failResult('video_analysis', (res && res.error) || '视频分析失败', false, { durationMs: ms });
      }

      const d = res.data || {};
      const scope = d.firstFrameAvailable ? SCOPE_FULL : SCOPE_META;
      const data = {
        duration: d.duration == null ? null : d.duration,
        width: d.width == null ? null : d.width,
        height: d.height == null ? null : d.height,
        format: d.format == null ? null : d.format,
        videoCodec: d.videoCodec == null ? null : d.videoCodec,
        firstFrameAvailable: !!d.firstFrameAvailable,
        analysisScope: scope,
        firstFrameAnswer: d.firstFrameAnswer || null,
        model: d.model || null,
        source,
        // 明确的能力边界，交给上层回答时照实说
        limitation: '仅分析视频元数据与首帧画面，未做逐帧/时间轴分析，不能推断整个视频的情节',
      };
      const summary = scope === SCOPE_FULL
        ? ('视频 ' + (d.duration != null ? Math.round(d.duration * 10) / 10 + 's ' : '') +
           (d.width ? d.width + 'x' + d.height + ' ' : '') + '首帧分析：' + String(d.firstFrameAnswer || '').slice(0, 120))
        : ('视频元数据：' + (d.duration != null ? Math.round(d.duration * 10) / 10 + 's ' : '') +
           (d.width ? d.width + 'x' + d.height + ' ' : '') + '；首帧不可用，只能做元数据分析');

      return R.okResult('video_analysis', data, summary, { durationMs: ms, itemCount: 1 });
    },
  });
  if (r.ok) out.push('video_analysis');
  return out;
}

module.exports = { register, pickSegs, SCOPE_FULL, SCOPE_META };
