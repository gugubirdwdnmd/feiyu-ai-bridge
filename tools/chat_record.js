'use strict';
// ================= V14-B：Chat Record Tool =================
// 不重写 parser —— 直接复用 chat_record_parser/（其测试必须保持 73/73）。
//
// V14-B 只负责「解析」：
//   ① 从 forward segment / forward_id 拿到消息；
//   ② get_forward_msg → normalize → 统一结构；
//   ③ 识别图片 / 视频并保留元数据（不分析内容）。
// 真正的 image_analysis / video_analysis 留给 V14-C。

const parser = require('../chat_record_parser');
const router = require('../agent/tool_router');
const R = require('./result');

function register(deps) {
  const out = [];

  const r = router.registerTool({
    name: 'chat_record_analysis',
    description:
      '解析 QQ 合并转发/聊天记录，返回按时间顺序排列的结构化内容（发言人、时间、文本，以及图片/视频的位置与元数据），用于回答用户关于这段聊天记录的问题。',
    inputSchema: {
      type: 'object',
      properties: {
        forward_id: { type: 'string', maxLength: 200, description: '合并转发 id；留空则使用最近一次收到的聊天记录' },
        question: { type: 'string', maxLength: 200, description: '用户针对这段记录的问题' },
      },
      required: [],
      additionalProperties: false,
    },
    permission: router.PERMISSION.SAFE,
    timeout: 25000,
    tokenCost: 1,
    riskLevel: 'low',
    safety: (args) => {
      const fid = String(args.forward_id || '').trim();
      if (fid) {
        if (fid.indexOf('..') >= 0 || /[\\]/.test(fid) || fid.startsWith('/') || /^[a-zA-Z]:/.test(fid)) {
          return { ok: false, error: '★forward_id 只允许 NapCat 的转发 id，不接受路径' };
        }
        if (!/^[\w\-.:@]{1,200}$/.test(fid)) {
          return { ok: false, error: 'forward_id 含有非法字符' };
        }
      }
      return { ok: true };
    },
    handler: async (args, ctx) => {
      const t0 = R.nowMs();
      const fid = String(args.forward_id || '').trim();
      let record = null;

      if (fid && typeof deps.getForwardMsg === 'function') {
        record = await parser.buildChatRecord({ id: fid, getForwardMsg: deps.getForwardMsg });
      } else if (typeof deps.getPendingRecord === 'function') {
        record = await deps.getPendingRecord(ctx || {});   // 可能是 Promise（buildChatRecord 是 async）
      }

      const ms = R.nowMs() - t0;
      if (!record) {
        return R.failResult('chat_record_analysis', '当前没有待处理的聊天记录（请先在 QQ 里发送一条合并转发）', false, { durationMs: ms });
      }
      if (record.error === 'fetch_failed') {
        return R.failResult('chat_record_analysis', '拉取合并转发失败（get_forward_msg）', true, { durationMs: ms });
      }
      if (record.error === 'empty' || !record.messages || !record.messages.length) {
        return R.failResult('chat_record_analysis', '聊天记录为空', true, { durationMs: ms });
      }

      const counts = record.counts || { messages: 0, images: 0, videos: 0, textChars: 0 };
      const text = parser.buildTextForModel(record, { question: args.question });

      // V14-B：图片/视频只保留元数据，不做内容分析
      const media = [];
      for (const m of record.messages) {
        for (const c of (m.content || [])) {
          if (c.type === 'image') media.push({ type: 'image', mime: c.mime || '', from: m.nickname || '' });
          else if (c.type === 'video') media.push({ type: 'video', duration: c.duration || 0, mime: c.mime || '', from: m.nickname || '' });
        }
      }

      return R.okResult(
        'chat_record_analysis',
        {
          chatRecordId: record.chatRecordId,
          counts,
          text,
          media,                                   // 仅元数据
          limitsApplied: record.limitsApplied || {},
          note: '图片/视频当前只做了识别与元数据保留，未做内容分析（V14-C 接入）',
        },
        '聊天记录 ' + counts.messages + ' 条（图 ' + counts.images + ' / 视频 ' + counts.videos + '）',
        { durationMs: ms, itemCount: counts.messages }
      );
    },
  });
  if (r.ok) out.push('chat_record_analysis');

  return out;
}

module.exports = { register };
