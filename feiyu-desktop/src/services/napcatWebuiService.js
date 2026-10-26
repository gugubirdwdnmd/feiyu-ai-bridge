'use strict';
/**
 * napcatWebuiService.js —— NapCat WebUI（默认 6099）的扫码登录链路。
 *
 * 背景与真因：
 *   NapCat 的「一键快捷登录」靠 OneBot(3000) 的 HTTP 接口取二维码是**错的**：
 *   OneBot 11 协议里没有 get_qrcode 这个 action（实测返回「不支持的Api get_qrcode」），
 *   而且 NapCat 的 OneBot 端口配了 access_token，不带 Authorization 就直接 403
 *   「token verify failed!」。
 *   NapCat 真正的二维码接口在 WebUI 上：
 *     POST /api/auth/login              {hash: sha256(webuiToken + '.napcat')} → data.Credential
 *     POST /api/QQLogin/GetQQLoginQrcode  (Authorization: Bearer <Credential>) → data.qrcode
 *     POST /api/QQLogin/GetQQLoginInfo    (同上) → uin / nick
 *     POST /api/QQLogin/CheckLoginStatus  (同上) → 登录进度
 *
 * 设计要点：
 *   - 令牌只在本机内存中使用，不写日志、不回传渲染进程（只回传二维码与状态）。
 *   - 全部纯函数/可注入依赖，便于单测。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');

const DEFAULT_WEBUI_PORT = 6099;
const WEBUI_CONFIG = 'webui.json';

/** 读取 NapCat WebUI 配置（host/port/token）。找不到时 token 为空串。 */
function readWebuiConfig(napcatDir) {
  const out = { host: '127.0.0.1', port: DEFAULT_WEBUI_PORT, token: '', source: '', dir: '' };
  if (!napcatDir) return out;
  try {
    const p = path.join(napcatDir, 'napcat', 'config', WEBUI_CONFIG);
    if (!fs.existsSync(p)) return out;
    const j = JSON.parse(fs.readFileSync(p, 'utf-8')) || {};
    out.host = String(j.host || '127.0.0.1');
    out.port = Number(j.port) || DEFAULT_WEBUI_PORT;
    out.token = String(j.token || '').trim();
    out.source = p;
    out.dir = napcatDir;
  } catch (_) {}
  return out;
}

/** WebUI 登录散列：sha256(token + '.napcat') */
function webuiHash(token) {
  return crypto.createHash('sha256').update(String(token || '') + '.napcat').digest('hex');
}

/** 极简 JSON POST（不抛异常，失败以 {ok:false,error} 返回）。 */
function postJson({ host, port, urlPath, body, headers, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let data = '';
    try { data = JSON.stringify(body || {}); } catch (_) { data = '{}'; }
    let req;
    try {
      req = http.request({
        host: host || '127.0.0.1',
        port: Number(port) || DEFAULT_WEBUI_PORT,
        path: urlPath,
        method: 'POST',
        headers: Object.assign({
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        }, headers || {}),
      }, (res) => {
        let b = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => { b += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(b); } catch (_) { json = null; }
          finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json, raw: b.slice(0, 500) });
        });
      });
    } catch (e) {
      finish({ ok: false, status: 0, json: null, raw: '', error: e.message });
      return;
    }
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch (_) {} finish({ ok: false, status: 0, json: null, raw: '', error: '请求超时' }); });
    req.on('error', (e) => finish({ ok: false, status: 0, json: null, raw: '', error: e.message }));
    req.write(data);
    req.end();
  });
}

/** 登录 WebUI，拿 Credential（作为 Bearer 令牌使用）。 */
async function login(cfg, deps = {}) {
  const post = deps.postJson || postJson;
  if (!cfg || !cfg.token) return { ok: false, error: '未找到 NapCat WebUI 令牌（webui.json），无法扫码登录' };
  const r = await post({
    host: cfg.host, port: cfg.port, urlPath: '/api/auth/login',
    body: { hash: webuiHash(cfg.token) },
  });
  if (!r.ok) return { ok: false, error: 'NapCat WebUI 登录失败（HTTP ' + (r.status || 0) + '）' };
  const cred = r.json && r.json.data && r.json.data.Credential;
  if (!cred) return { ok: false, error: 'NapCat WebUI 未返回登录凭据：' + ((r.json && r.json.message) || '未知原因') };
  return { ok: true, credential: String(cred) };
}

/** 取二维码。返回 {ok, qrImage, qrUrl, message, state}。 */
async function fetchQrcode(cfg, deps = {}) {
  const post = deps.postJson || postJson;
  const lg = await login(cfg, deps);
  if (!lg.ok) return { ok: false, state: 'failed', error: lg.error, message: lg.error };
  const auth = { Authorization: 'Bearer ' + lg.credential };
  const r = await post({
    host: cfg.host, port: cfg.port, urlPath: '/api/QQLogin/GetQQLoginQrcode',
    body: {}, headers: auth,
  });
  const msg = (r.json && r.json.message) || '';
  if (!r.ok) return { ok: false, state: 'failed', error: 'NapCat WebUI 请求失败（HTTP ' + (r.status || 0) + '）' };
  if (r.json && r.json.code !== 0) {
    const state = /Logined|已登录/i.test(msg) ? 'ok' : 'failed';
    return {
      ok: false, state,
      message: msg || 'NapCat 未返回二维码',
      error: /Logined|已登录/i.test(msg)
        ? '当前 QQ 已是登录状态；如需换号请先在 NapCat WebUI 退出登录'
        : (msg || 'NapCat 未返回二维码'),
    };
  }
  const data = (r.json && r.json.data) || {};
  const raw = String(data.qrcode || '');
  let qrImage = null, qrUrl = null;
  if (raw) {
    if (/^https?:\/\//i.test(raw) || raw.startsWith('//')) qrUrl = raw;
    else qrImage = raw.startsWith('data:') ? raw : ('data:image/png;base64,' + raw);
  }
  const qrUrl2 = data.qrcodeUrl || data.url || null;
  if (!qrImage && !qrUrl && qrUrl2) qrUrl = String(qrUrl2);
  if (!qrImage && !qrUrl) {
    return { ok: false, state: 'failed', error: 'NapCat 返回的二维码为空', message: 'NapCat 返回的二维码为空' };
  }
  return { ok: true, state: 'pending', qrImage, qrUrl, message: '二维码已就绪，请用手机 QQ 扫码' };
}

/** 轮询登录状态。返回 {ok, state, message, uin}。 */
async function fetchStatus(cfg, deps = {}) {
  const post = deps.postJson || postJson;
  const lg = await login(cfg, deps);
  if (!lg.ok) return { ok: false, state: 'failed', error: lg.error, message: lg.error };
  const auth = { Authorization: 'Bearer ' + lg.credential };
  const r = await post({
    host: cfg.host, port: cfg.port, urlPath: '/api/QQLogin/CheckLoginStatus',
    body: {}, headers: auth,
  });
  if (!r.ok) return { ok: false, state: 'failed', error: 'NapCat 状态查询失败（HTTP ' + (r.status || 0) + '）' };
  const msg = (r.json && r.json.message) || '';
  if (r.json && r.json.code !== 0) {
    return { ok: false, state: 'failed', message: msg || 'NapCat 状态查询失败', error: msg || 'NapCat 状态查询失败' };
  }
  const data = (r.json && r.json.data) || {};
  const uin = data.uin || data.Uin || data.QQ || null;
  const nick = data.nick || data.nickname || '';
  const success = data.success === true || /success|成功/i.test(msg) || (uin && /success|成功|已登录/i.test(msg));
  if (success) return { ok: true, state: 'ok', message: '登录成功' + (nick ? '（' + nick + '）' : ''), uin };
  if (/超时|expire|过期/i.test(msg)) return { ok: true, state: 'expired', message: '二维码已过期，请重新获取', uin };
  if (/已扫|scanned|确认/i.test(msg)) return { ok: true, state: 'scanned', message: '已扫码，请在手机上确认', uin };
  return { ok: true, state: 'pending', message: msg || '等待扫码', uin };
}

module.exports = {
  DEFAULT_WEBUI_PORT,
  readWebuiConfig,
  webuiHash,
  postJson,
  login,
  fetchQrcode,
  fetchStatus,
};
