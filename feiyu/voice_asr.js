'use strict';

/**
 * 语音识别（ASR）——把 QQ 语音消息转成文字，再交给既有对话流程。
 *
 * 设计原则（与项目其它 V15 模块一致）：
 *   1. 默认关闭（voice.enabled 必须为 true 才工作）。
 *   2. 默认不联网：provider='mock' 只产出占位文本；'cloud' 必须显式配置 endpoint + 域名白名单。
 *   3. 失败一律降级为「不识别」，绝不抛错打断聊天。
 *   4. 不落盘、不记录语音内容；日志只写原因码，不写转写文本。
 *
 * provider：
 *   'mock'  —— 占位（默认）。返回配置的占位文本，让下游知道这是一条语音。
 *   'local' —— 调用本机命令（如 whisper.cpp）。必须显式配置 cmd，且只允许传入文件路径参数
 *              （用 execFile 传数组参数，不经 shell，避免命令注入）。
 *   'cloud' —— 调用显式配置的 HTTP 端点。必须命中 allowHosts 白名单，且过 url_safety.isSafeUrl。
 *
 * ⚠ 真实识别（local/cloud）在本仓库环境【未验证 UNVERIFIED】：
 *    仓库零第三方依赖，本机未安装任何 ASR 引擎，也未配置云端端点，本轮未做真实联网/真实识别测试。
 */

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

let urlSafety = null;
try { urlSafety = require('../url_safety'); } catch (e) { urlSafety = null; }
let safeHttp = null;
try { safeHttp = require('../safe_http'); } catch (e) { safeHttp = null; }

const DEFAULTS = {
  enabled: false,
  provider: 'mock',            // mock | local | cloud
  mockText: '[语音]',           // mock 模式产出的占位文本
  maxDurationSec: 120,         // 超过时长不识别（避免长录音拖垮成本）
  maxBytes: 8 * 1024 * 1024,   // 单条语音文件上限
  timeoutMs: 20000,
  // local：本机命令（数组），{file} 会被替换成音频绝对路径
  cmd: [],
  // cloud：POST JSON 的识别端点；host 必须在 allowHosts 里
  endpoint: '',
  allowHosts: [],
  apiKeyRef: '',               // 仅记录字段名，不在此处读取任何密钥
  // 转写后如何拼进原文
  prefix: '',
  suffix: '',
};

let getCFG = () => ({});
function setConfig(fn) { if (typeof fn === 'function') getCFG = fn; }

function num(v, d, min) {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.max(min, n);
}

function cfg() {
  const c = (typeof getCFG === 'function' && getCFG()) || {};
  const s = c.voice || {};
  return {
    enabled: s.enabled === true,
    provider: String(s.provider || DEFAULTS.provider).toLowerCase(),
    mockText: typeof s.mockText === 'string' ? s.mockText : DEFAULTS.mockText,
    maxDurationSec: num(s.maxDurationSec, DEFAULTS.maxDurationSec, 1),
    maxBytes: num(s.maxBytes, DEFAULTS.maxBytes, 1024),
    timeoutMs: num(s.timeoutMs, DEFAULTS.timeoutMs, 1000),
    cmd: Array.isArray(s.cmd) ? s.cmd.slice(0, 16) : [],
    endpoint: String(s.endpoint || '').trim(),
    allowHosts: Array.isArray(s.allowHosts) ? s.allowHosts.map(String) : [],
    apiKeyRef: String(s.apiKeyRef || '').trim(),
    prefix: typeof s.prefix === 'string' ? s.prefix : DEFAULTS.prefix,
    suffix: typeof s.suffix === 'string' ? s.suffix : DEFAULTS.suffix,
  };
}

// —— 语音段识别：OneBot 里语音是 type='record' 的段 ——
function hasVoice(msgSegs) {
  return pickVoice(msgSegs) != null;
}

function pickVoice(msgSegs) {
  if (!Array.isArray(msgSegs)) return null;
  for (const s of msgSegs) {
    if (s && s.type === 'record') return s;
  }
  return null;
}

/** 取出语音段里的文件地址（file 字段可能是 本地路径 / base64:// / url） */
function voiceFileOf(seg) {
  const d = (seg && seg.data) || {};
  return String(d.file || d.path || d.url || '').trim();
}

function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; }
}

function hostAllowed(host, allowHosts) {
  if (!host || !allowHosts.length) return false;
  const h = String(host).toLowerCase();
  for (const a of allowHosts) {
    const p = String(a).toLowerCase().trim();
    if (!p) continue;
    if (p === h) return true;
    if (p.startsWith('*.') && h.endsWith(p.slice(1))) return true;
  }
  return false;
}

/**
 * 识别一条语音段。
 * @returns {{ok:boolean, text?:string, provider?:string, reason?:string}}
 *   reason: 'disabled' | 'no-voice' | 'too-long' | 'too-large' | 'unsupported-provider'
 *           | 'local-not-configured' | 'local-failed' | 'cloud-not-configured'
 *           | 'cloud-host-not-allowed' | 'cloud-unsafe-url' | 'cloud-failed'
 */
async function transcribe(seg, o) {
  o = o || {};
  const c = cfg();
  if (!c.enabled) return { ok: false, reason: 'disabled' };
  if (!seg) return { ok: false, reason: 'no-voice' };

  // 时长/体积门禁（拿不到就不拦，交给 provider 自己兜底）
  const dur = Number((seg.data || {}).duration);
  if (Number.isFinite(dur) && dur > 0 && dur > c.maxDurationSec) {
    return { ok: false, reason: 'too-long' };
  }
  const f = voiceFileOf(seg);
  if (f && !/^(https?:|base64:)/i.test(f)) {
    try {
      const st = fs.statSync(f);
      if (st && st.size > c.maxBytes) return { ok: false, reason: 'too-large' };
    } catch (e) { /* 读不到就交给 provider */ }
  }

  if (c.provider === 'mock') {
    return { ok: true, text: wrap(c.mockText, c), provider: 'mock' };
  }
  if (c.provider === 'local') {
    return await localTranscribe(f, c);
  }
  if (c.provider === 'cloud') {
    return await cloudTranscribe(f, c);
  }
  return { ok: false, reason: 'unsupported-provider' };
}

function wrap(text, c) {
  return String(c.prefix || '') + String(text || '') + String(c.suffix || '');
}

// —— 本机命令：execFile + 数组参数（不经 shell，避免命令注入）——
function localTranscribe(file, c) {
  if (!c.cmd.length) return Promise.resolve({ ok: false, reason: 'local-not-configured' });
  if (!file) return Promise.resolve({ ok: false, reason: 'local-not-configured' });
  const args = c.cmd.slice(1).map((a) => String(a).replace(/\{file\}/g, file));
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const t = setTimeout(() => finish({ ok: false, reason: 'local-failed' }), c.timeoutMs);
    try {
      const child = execFile(String(c.cmd[0]), args, { timeout: c.timeoutMs, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          clearTimeout(t);
          if (err) return finish({ ok: false, reason: 'local-failed' });
          const text = String(stdout || '').trim();
          if (!text) return finish({ ok: false, reason: 'local-failed' });
          finish({ ok: true, text: wrap(text.slice(0, 2000), c), provider: 'local' });
        });
      if (child && child.on) child.on('error', () => { clearTimeout(t); finish({ ok: false, reason: 'local-failed' }); });
    } catch (e) {
      clearTimeout(t);
      finish({ ok: false, reason: 'local-failed' });
    }
  });
}

// —— 云端端点：白名单 + SSRF 校验后才发请求（仓库零依赖，实际调用走 safe_http.safeFetch）——
async function cloudTranscribe(file, c) {
  if (!c.endpoint) return { ok: false, reason: 'cloud-not-configured' };
  if (!hostAllowed(hostOf(c.endpoint), c.allowHosts)) {
    return { ok: false, reason: 'cloud-host-not-allowed' };
  }
  if (urlSafety && typeof urlSafety.isSafeUrl === 'function') {
    if (!urlSafety.isSafeUrl(c.endpoint)) return { ok: false, reason: 'cloud-unsafe-url' };
  }
  if (!safeHttp || typeof safeHttp.safeFetch !== 'function') {
    return { ok: false, reason: 'cloud-not-configured' };
  }
  try {
    const r = await safeHttp.safeFetch(c.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: String(file || '').slice(0, 1024) }),
    });
    const txt = r && r.text != null ? String(r.text) : '';
    let out = '';
    try { out = String((JSON.parse(txt) || {}).text || ''); } catch (e) { out = txt.trim(); }
    if (!out) return { ok: false, reason: 'cloud-failed' };
    return { ok: true, text: wrap(out.slice(0, 2000), c), provider: 'cloud' };
  } catch (e) {
    return { ok: false, reason: 'cloud-failed' };
  }
}

/**
 * 把语音转写结果并入原始文本。
 * 关闭 / 失败 → 原样返回（changed=false），绝不破坏原有聊天流程。
 */
function mergeIntoText(text, tr) {
  const base = String(text || '');
  if (!tr || !tr.ok || !tr.text) return { text: base, changed: false };
  const merged = base ? (base + ' ' + tr.text) : tr.text;
  return { text: merged.trim(), changed: true, provider: tr.provider };
}

module.exports = {
  DEFAULTS,
  setConfig, cfg,
  hasVoice, pickVoice, voiceFileOf,
  hostAllowed,
  transcribe, mergeIntoText,
};
