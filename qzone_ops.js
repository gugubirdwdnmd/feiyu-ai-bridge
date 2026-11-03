/**
 * QQ空间（QZone）操作模块 —— 删除说说/评论、回复评论。
 *
 * 重要说明（务必先读）：
 *   · OneBot / NapCat 只标准化了「发空间说说」(send_qzone_msg，见 ai_bridge 的 publishQzoneTool)，
 *     并没有「删说说 / 删评论 / 回评论」的标准 action。
 *   · 这些操作只能走 QQ 的 Web 私接口（taotao.qq.com 的 cgi-bin），需要空间主人的
 *     cookie（p_uin / p_skey）。这是「源码可见、非标准、随时可能随腾讯改版失效」的接口。
 *   · 本模块默认【不启用】，必须在 ai_config.json 的 qq_privileges.qzone 里填好
 *     uin / p_uin / p_skey 并设 enabled=true 才会真正发起请求。
 *   · 接口字段/路径是社区已知的「最佳努力」版本，未经线上验证；若腾讯改版，需同步调整。
 *     任何失败都会如实返回，绝不会假装操作成功。
 *
 * 仅到固定的腾讯官方域名（user.qzone.qq.com），不做任何外部/内网跳转，无 SSRF 面。
 */
'use strict';

// g_tk：QZone 接口要求的 CSRF 校验值，由 p_skey 算得（社区通用算法）。
function g_tk(p_skey) {
  let hash = 5381;
  const s = String(p_skey || '');
  for (let i = 0; i < s.length; i++) hash += (hash << 5) + s.charCodeAt(i);
  return (hash & 0x7fffffff) >>> 0;
}

let CREDS = { uin: '', p_uin: '', p_skey: '' };
function setCreds(c) {
  CREDS = {
    uin: String((c && c.uin) || '').trim(),
    p_uin: String((c && c.p_uin) || '').trim(),
    p_skey: String((c && c.p_skey) || '').trim(),
  };
}
function ready() {
  return !!(CREDS.uin && CREDS.p_uin && CREDS.p_skey);
}

// 统一 POST 表单到 QZone 代理接口。host 固定为官方域名。
async function qzonePost(path, form) {
  if (!ready()) return { ok: false, error: 'QQ空间未配置 cookie' };
  const gtk = g_tk(CREDS.p_skey);
  const url = 'https://user.qzone.qq.com/proxy/domain/' + path + '?g_tk=' + gtk;
  const body = Object.keys(form)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(form[k]))
    .join('&');
  const cookie = 'p_uin=o' + CREDS.uin + '; p_skey=' + CREDS.p_skey + '; uin=o' + CREDS.uin;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookie,
        'Referer': 'https://user.qzone.qq.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body,
      signal: AbortSignal.timeout(20000),
    });
    const txt = await r.text();
    // QZone 接口通常返回 callback({code:0,...}) 或 _Callback(...)；code=0 表示成功
    const m = txt.match(/"code"\s*:\s*(-?\d+)/) || txt.match(/code['"]?\s*[:=]\s*(-?\d+)/);
    const code = m ? Number(m[1]) : -999;
    if (code === 0) return { ok: true, raw: txt.slice(0, 200) };
    return { ok: false, error: '接口返回 code=' + code + ' ' + txt.slice(0, 120) };
  } catch (e) {
    return { ok: false, error: '请求异常：' + e.message };
  }
}

// 删除一条说说。hostuin=空间主人；tid=说说 id。
async function deleteMood(tid) {
  if (!tid) return { ok: false, error: '缺少 tid' };
  return qzonePost('taotao.qq.com/cgi-bin/emotion_cgi_delete_v6', {
    uin: CREDS.uin,
    hostuin: CREDS.uin,
    appid: '311',
    op: '1',
    fid: tid,
    type: '0',
    hash: '',
    format: 'json',
    outcharset: 'utf-8',
    qzreferrer: 'https://user.qzone.qq.com/' + CREDS.uin,
  });
}

// 删除某条说说下的评论。commentid=评论 id；tid=所属说说。
async function deleteComment(commentId) {
  if (!commentId) return { ok: false, error: '缺少 comment_id' };
  return qzonePost('w.qzone.qq.com/cgi-bin/emotion_cgi_delete_comment_v6', {
    uin: CREDS.uin,
    hostuin: CREDS.uin,
    appid: '311',
    op: '2',
    commentid: commentId,
    type: '0',
    format: 'json',
    outcharset: 'utf-8',
    qzreferrer: 'https://user.qzone.qq.com/' + CREDS.uin,
  });
}

// 在某条评论下回复。commentid=被回复的评论；content=回复正文。
async function replyComment(commentId, content) {
  if (!commentId || !content) return { ok: false, error: '缺少 comment_id 或 content' };
  return qzonePost('w.qzone.qq.com/cgi-bin/emotion_cgi_re_cmt_v6', {
    uin: CREDS.uin,
    hostuin: CREDS.uin,
    appid: '311',
    op: '0',
    commentid: commentId,
    content: content,
    richtype: '',
    richval: '',
    format: 'json',
    outcharset: 'utf-8',
    qzreferrer: 'https://user.qzone.qq.com/' + CREDS.uin,
  });
}

module.exports = {
  setCreds,
  ready,
  deleteContent: ({ tid, commentId }) => (tid ? deleteMood(tid) : deleteComment(commentId)),
  replyComment: ({ commentId, content }) => replyComment(commentId, content),
};
