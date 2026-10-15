'use strict';
// chat_record_parser 公共入口。
// 用法（在 ai_bridge 里）：
//   const crp = require('./chat_record_parser');
//   const segs = crp.detectForwardSegments(msgSegs);
//   const record = await crp.buildChatRecord({ id, summary, source, prompt, content, getForwardMsg });
//   const parts = await crp.buildMultimodalParts(record, question, { fetchImageBytes });
const parser = require('./parser');
const media = require('./media');
const normalize = require('./normalize');

// 便捷组合：从一条消息数组里尝试解析第一条聊天记录（自动拉取）。
// getForwardMsg 必须注入；解析失败返回 {type:'chat_record', error, ...} 而非抛错。
async function parseFromMessage(message, opts) {
  opts = opts || {};
  const segs = parser.detectForwardSegments(message);
  if (!segs.length) return null;
  const seg = segs[0];
  return parser.buildChatRecord(Object.assign({}, seg, opts));
}

module.exports = Object.assign({}, parser, media, normalize, { parseFromMessage });
