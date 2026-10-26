'use strict';
/**
 * napcatLoginService.js —— NapCat 实例与 QQ 登录中心（模块 A）。
 *
 * 能力：
 *  1) 登录方式：二维码登录（推荐）/ 快速登录（账号 + 密码 MD5）。
 *  2) 多实例管理：实例清单存 `<botDir>/feiyu_instances.json`（只存元信息）。
 *  3) 安全：**绝不明文存储密码**；二维码内容只在内存与展示层流转，不写日志、
 *     不进通知、不进诊断包；实例列表对外只给出掩码账号。
 *
 * 重要设计取舍：
 *  - 本模块**不自己发起登录**，只做「协议载荷解析 + 会话状态机 + 实例清单」。
 *    真正与 NapCat 通信由处理器注入的 transport（fetch 包装）完成，
 *    因此全部逻辑可离线单测，且不会在测试中触碰真实机器人。
 *  - 二维码载荷的解析必须容错：NapCat 不同版本/不同接口返回结构不一致
 *    （顶层 qrcode / data.qrcode / base64 / url 都可能出现）。
 *
 * 安全边界：绝不修改真实机器人目录；不重启/停止真实进程；不发送真实消息。
 */
const fs = require('fs');
const path = require('path');

const INSTANCES_FILE = 'feiyu_instances.json';
const SCHEMA_VERSION = 1;
const MAX_INSTANCES = 20;
const SESSION_TTL_MS = 3 * 60 * 1000;

/** 账号掩码：只露首 2 位与末 2 位。 */
function maskAccount(acc) {
  const s = String(acc == null ? '' : acc);
  if (!s) return '';
  if (s.length <= 4) return '*'.repeat(s.length);
  return s.slice(0, 2) + '*'.repeat(Math.max(3, s.length - 4)) + s.slice(-2);
}

/** 敏感串掩码（二维码 token / 票据）。 */
function maskToken(t) {
  const s = String(t == null ? '' : t);
  if (!s) return '';
  if (s.length <= 8) return '********';
  return s.slice(0, 4) + '*'.repeat(Math.min(24, Math.max(4, s.length - 8))) + s.slice(-4);
}

/**
 * 从任意形态的载荷中提取二维码。
 * 支持：
 *   { qrcode: '<base64>' }                       → data image
 *   { data: { qrcode } }                         → 同上
 *   { qrcodeUrl: 'https://...' }                 → 链接
 *   { data: { url } }                            → 链接
 *   { qrCodeBase64: 'iVBOR...' }                 → data image
 * @returns { ok, qrImage|null, qrUrl|null, token|null(掩码), raw:undefined }
 */
function extractQr(payload) {
  const p = payload && typeof payload === 'object' ? (payload.data && typeof payload.data === 'object' ? Object.assign({}, payload, payload.data) : payload) : {};
  const pick = (...keys) => {
    for (const k of keys) {
      const v = p[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  };
  const b64 = pick('qrcode', 'qrCode', 'qrCodeBase64', 'qrcodeBase64', 'base64');
  const url = pick('qrcodeUrl', 'qrCodeUrl', 'qrcode_url', 'url', 'qr_url');
  const token = pick('token', 'qrcodeToken', 'ticket');
  if (b64) {
    const img = /^data:image\//.test(b64) ? b64 : ('data:image/png;base64,' + b64.replace(/\s+/g, ''));
    return { ok: true, qrImage: img, qrUrl: null, tokenMasked: token ? maskToken(token) : null };
  }
  if (url) return { ok: true, qrImage: null, qrUrl: url, tokenMasked: token ? maskToken(token) : null };
  return { ok: false, qrImage: null, qrUrl: null, tokenMasked: null, error: '载荷中未找到二维码（qrcode / qrcodeUrl / base64）' };
}

/** 从载荷判定登录状态。 */
function parseStatus(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const d = p.data && typeof p.data === 'object' ? p.data : {};
  const code = p.retcode != null ? p.retcode : (p.code != null ? p.code : d.retcode);
  const raw = [p.status, d.status, p.state, d.state, p.message, d.message].filter((x) => typeof x === 'string').join(' ').toLowerCase();

  if (/expire|过期|失效/.test(raw)) return { state: 'expired', message: '二维码已过期，请重新获取' };
  if (/success|ok|successful|已登录|登录成功|online/.test(raw) || code === 0 && /成功/.test(raw)) {
    if (/wait|scan|pending|待|未/.test(raw) && !/success|成功/.test(raw)) return { state: 'pending', message: '等待扫码' };
    return { state: 'ok', message: '登录成功' };
  }
  if (/confirm|已扫|待确认|verify/.test(raw)) return { state: 'scanned', message: '已扫码，请在手机上确认' };
  if (/fail|error|失败|拒绝/.test(raw)) return { state: 'failed', message: raw || '登录失败' };
  if (/wait|pending|scan|待扫码|未扫/.test(raw)) return { state: 'pending', message: '等待扫码' };
  if (code != null && code !== 0) return { state: 'failed', message: '登录接口返回错误码 ' + code };
  return { state: 'pending', message: '等待扫码' };
}

/**
 * 登录会话（纯内存状态机，便于单测）。
 * 状态：created → pending → scanned → ok | expired | failed
 */
function createSession({ now = () => Date.now(), ttlMs = SESSION_TTL_MS, instanceId = 'default' } = {}) {
  const s = {
    id: 'qr-' + now() + '-' + Math.random().toString(36).slice(2, 8),
    instanceId,
    createdAt: now(),
    expiresAt: now() + ttlMs,
    state: 'created',
    polls: 0,
    message: '已创建登录会话',
    qrImage: null,
    qrUrl: null,
    tokenMasked: null,
  };
  return s;
}

/** 应用一次「取二维码」结果。 */
function applyQr(session, payload) {
  const q = extractQr(payload);
  if (!q.ok) { session.state = 'failed'; session.message = q.error; return session; }
  session.qrImage = q.qrImage;
  session.qrUrl = q.qrUrl;
  session.tokenMasked = q.tokenMasked;
  session.state = 'pending';
  session.message = '二维码已就绪，请用手机 QQ 扫码';
  return session;
}

/** 应用一次「轮询状态」结果；过期按 TTL 覆盖。 */
function applyPoll(session, payload, { now = () => Date.now() } = {}) {
  session.polls += 1;
  if (session.state !== 'ok' && now() > session.expiresAt) {
    session.state = 'expired';
    session.message = '二维码已过期（本地计时），请重新获取';
    return session;
  }
  const st = parseStatus(payload);
  // 已成功不要被后续 pending 覆盖
  if (session.state === 'ok' && st.state !== 'ok') return session;
  session.state = st.state;
  session.message = st.message;
  if (st.state === 'ok') { session.qrImage = null; session.qrUrl = null; }
  return session;
}

/** 对外可见的会话视图：**不含**二维码内容（除显式要图时）。 */
function publicSession(s, { withQr = false } = {}) {
  if (!s) return null;
  const out = {
    id: s.id, instanceId: s.instanceId, state: s.state, message: s.message,
    polls: s.polls, createdAt: s.createdAt, expiresAt: s.expiresAt,
  };
  if (withQr) { out.qrImage = s.qrImage; out.qrUrl = s.qrUrl; }
  return out;
}

/** 校验实例定义。密码 MD5 绝不出现在清单里（只允许 transient 传入，不入库）。 */
function validateInstance(def) {
  const errors = [];
  if (!def || typeof def !== 'object') return { valid: false, errors: ['实例定义必须是对象'] };
  if (typeof def.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(def.id)) errors.push('id 非法（字母数字 . _ -，1-32）');
  if (typeof def.name !== 'string' || !def.name.trim()) errors.push('name 必填');
  if (def.mode != null && !['qr', 'quick'].includes(def.mode)) errors.push('mode 必须是 qr|quick');
  if (def.account != null && !/^\d{5,12}$/.test(String(def.account))) errors.push('account 必须是 5-12 位数字 QQ 号');
  if (def.passwordMd5 != null && def.passwordMd5 !== '') {
    if (!/^[a-fA-F0-9]{32}$/.test(String(def.passwordMd5))) errors.push('passwordMd5 必须是 32 位十六进制（不是明文密码）');
  }
  if (def.port != null && !(Number.isInteger(def.port) && def.port > 0 && def.port < 65536)) errors.push('port 必须是 1-65535');
  return { valid: errors.length === 0, errors };
}

/** 入库前剔除敏感字段：清单里**永不**保存 passwordMd5。 */
function sanitizeInstance(def) {
  const out = {
    id: def.id,
    name: String(def.name || def.id),
    mode: def.mode === 'quick' ? 'quick' : 'qr',
    account: def.account ? String(def.account) : '',
    port: Number.isInteger(def.port) ? def.port : null,
    note: typeof def.note === 'string' ? def.note.slice(0, 200) : '',
    createdAt: def.createdAt || null,
    lastLoginAt: def.lastLoginAt || null,
  };
  // 只记录「是否已有密码」，不记录密码本身
  out.hasQuickPassword = !!(def.passwordMd5 && String(def.passwordMd5).length);
  return out;
}

function instancesPath(botDir) { return path.join(botDir, INSTANCES_FILE); }

function readInstances(botDir, fsImpl = fs) {
  try {
    const o = JSON.parse(fsImpl.readFileSync(instancesPath(botDir), 'utf-8'));
    if (!o || typeof o !== 'object') return { version: SCHEMA_VERSION, instances: [] };
    return { version: SCHEMA_VERSION, instances: Array.isArray(o.instances) ? o.instances : [] };
  } catch (_) { return { version: SCHEMA_VERSION, instances: [] }; }
}

function writeInstances(botDir, data, fsImpl = fs) {
  const p = instancesPath(botDir);
  const tmp = p + '.tmp.' + process.pid;
  try {
    fsImpl.writeFileSync(tmp, JSON.stringify({ version: SCHEMA_VERSION, instances: data.instances }, null, 2));
    fsImpl.renameSync(tmp, p);
    return { ok: true };
  } catch (e) {
    try { if (fsImpl.existsSync(tmp)) fsImpl.unlinkSync(tmp); } catch (_) {}
    return { ok: false, error: e.message };
  }
}

/** 列表：账号一律掩码输出。 */
function listInstances(botDir, { fsImpl = fs } = {}) {
  const d = readInstances(botDir, fsImpl);
  return {
    ok: true,
    instances: d.instances.map((i) => Object.assign({}, i, { account: maskAccount(i.account), accountMasked: true })),
    count: d.instances.length,
  };
}

function saveInstance(botDir, def, { fsImpl = fs, now = new Date() } = {}) {
  const v = validateInstance(def);
  if (!v.valid) return { ok: false, errors: v.errors };
  const d = readInstances(botDir, fsImpl);
  const i = d.instances.findIndex((x) => x.id === def.id);
  const rec = sanitizeInstance(def);
  if (i >= 0) {
    rec.createdAt = d.instances[i].createdAt || now.toISOString();
    rec.lastLoginAt = d.instances[i].lastLoginAt || null;
    d.instances[i] = rec;
  } else {
    if (d.instances.length >= MAX_INSTANCES) return { ok: false, errors: ['实例数量已达上限 ' + MAX_INSTANCES] };
    rec.createdAt = now.toISOString();
    d.instances.push(rec);
  }
  const w = writeInstances(botDir, d, fsImpl);
  if (!w.ok) return { ok: false, error: w.error };
  return { ok: true, instance: Object.assign({}, rec, { account: maskAccount(rec.account) }), created: i < 0 };
}

function removeInstance(botDir, id, { fsImpl = fs } = {}) {
  const d = readInstances(botDir, fsImpl);
  const i = d.instances.findIndex((x) => x.id === id);
  if (i < 0) return { ok: false, error: '未找到实例: ' + id };
  d.instances.splice(i, 1);
  const w = writeInstances(botDir, d, fsImpl);
  return w.ok ? { ok: true } : { ok: false, error: w.error };
}

function markLoggedIn(botDir, id, { fsImpl = fs, now = new Date() } = {}) {
  const d = readInstances(botDir, fsImpl);
  const it = d.instances.find((x) => x.id === id);
  if (!it) return { ok: false, error: '未找到实例: ' + id };
  it.lastLoginAt = now.toISOString();
  const w = writeInstances(botDir, d, fsImpl);
  return w.ok ? { ok: true } : { ok: false, error: w.error };
}

/**
 * 描述二维码登录的交互步骤（供 UI 展示；不含任何真实令牌）。
 * 说明：不同 NapCat 版本的接口路径可能不同，实际端点由 settings.napcatQrEndpoint 决定，
 * 未配置时给出常见候选，由用户确认。
 */
function qrLoginPlan(opts = {}) {
  return {
    ok: true,
    mode: 'qr',
    endpointConfigured: !!opts.endpoint,
    candidateEndpoints: opts.endpoint ? [opts.endpoint] : ['/get_qrcode', '/api/qrcode', '/qrcode'],
    steps: [
      '确认机器人目录指向正在运行的 NapCat 实例目录',
      '点击「获取二维码」：桌面端调用 NapCat 二维码接口，取得二维码图片',
      '用手机 QQ 扫码并在手机上确认登录',
      '桌面端轮询登录状态，成功后写入实例的最近登录时间',
    ],
    securityNotes: [
      '二维码内容等同于一次性的登录凭据，请勿截图外传',
      '桌面端不会把二维码内容写入日志或诊断包',
      '快速登录的密码只以 MD5 形式经环境变量注入子进程，不落盘',
    ],
  };
}

module.exports = {
  INSTANCES_FILE, SCHEMA_VERSION, MAX_INSTANCES, SESSION_TTL_MS,
  maskAccount, maskToken, extractQr, parseStatus,
  createSession, applyQr, applyPoll, publicSession,
  validateInstance, sanitizeInstance,
  instancesPath, readInstances, writeInstances,
  listInstances, saveInstance, removeInstance, markLoggedIn, qrLoginPlan,
  readOnebotToken,
};

/**
 * 读取 NapCat OneBot HTTP 服务端的 access_token。
 *
 * 背景：NapCat 侧配了 token（onebot11_*.json → network.httpServers[].token）时，
 * 任何不带 Authorization 头的 OneBot 调用都会返回 "token verify failed!"，
 * 表现为「机器人收得到消息但发不出去」。
 * AI 桥从环境变量 NAPCAT_ONEBOT_TOKEN 读取该令牌，因此桌面在拉起桥时注入即可，
 * 无需改动机器人目录里的任何文件。
 *
 * @returns { token:string, source:string, port:number } 找不到时 token 为空串
 */
function readOnebotToken(napcatDir) {
  const out = { token: '', source: '', port: 0 };
  if (!napcatDir) return out;
  try {
    const cfgDir = path.join(napcatDir, 'napcat', 'config');
    if (!fs.existsSync(cfgDir)) return out;
    const files = fs.readdirSync(cfgDir).filter((f) => /^onebot11_.*\.json$/i.test(f));
    for (const f of files) {
      let j = null;
      try { j = JSON.parse(fs.readFileSync(path.join(cfgDir, f), 'utf-8')); } catch (_) { continue; }
      const net = (j && j.network) || {};
      const servers = Array.isArray(net.httpServers) ? net.httpServers : [];
      const hit = servers.find((s) => s && s.enable !== false && Number(s.port) === 3000)
        || servers.find((s) => s && s.token);
      if (hit && hit.token) {
        out.token = String(hit.token).trim();
        out.source = path.join(cfgDir, f);
        out.port = Number(hit.port) || 0;
        return out;
      }
    }
  } catch (_) {}
  return out;
}
