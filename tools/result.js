'use strict';
// ================= V14-B：Tool 统一返回结构 =================
// 目的：让上层（V14-D 的 Planner）能可靠判断下一步，而不是去猜一段字符串。
//
// 成功：{ ok:true,  tool, data, summary, metadata:{ durationMs, itemCount } }
// 失败：{ ok:false, tool, error, retryable, data:null, summary:'', metadata:{ durationMs } }
//
// 硬性要求：工具失败必须 ok:false，不允许「ok:true + 内容是失败提示」这种欺骗。

function okResult(tool, data, summary, metadata) {
  return {
    ok: true,
    tool,
    data: data == null ? null : data,
    summary: String(summary || '').slice(0, 300),
    metadata: Object.assign({ durationMs: 0, itemCount: 0 }, metadata || {}),
  };
}

function failResult(tool, error, retryable, metadata) {
  return {
    ok: false,
    tool,
    error: String(error || '未知错误').slice(0, 200),
    retryable: !!retryable,
    data: null,
    summary: '',
    metadata: Object.assign({ durationMs: 0, itemCount: 0 }, metadata || {}),
  };
}

// 现有 ai_bridge 的文件/网络函数返回的是「字符串」，失败也用字符串表达。
// 这里统一把「失败文案」识别出来，转成 ok:false，避免把失败当成功喂给模型。
function looksFailed(s, markers) {
  const t = String(s || '');
  if (!t.trim()) return true;
  for (const m of markers) if (t.indexOf(m) >= 0) return true;
  return false;
}

function nowMs() { return Date.now(); }

module.exports = { okResult, failResult, looksFailed, nowMs };
