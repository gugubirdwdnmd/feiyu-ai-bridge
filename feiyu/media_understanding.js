'use strict';

/**
 * media_understanding.js —— 多模态理解服务（视频理解为核心，图片/语音/文字统一接口）。
 *
 * 设计目标（对应 1.4.9「多模态理解升级」）：
 *   - 本地优先：优先用本机算力（本地 OpenAI 兼容 VL 端点 / 本地 ASR / 本地 OCR），
 *     云端视觉 API 仅作「可选增强」，且必须在用户显式配置 endpoint + 域名白名单后才启用。
 *   - 不破坏既有图片/语音链路：本模块是"统一服务"，既有的 processReply 内联图片处理保持不变；
 *     本模块只新增视频段处理，并对外暴露 analyzeImage/analyzeVideo/extractText/
 *     transcribeAudio/summarizeMedia/answerMediaQuestion 供消息处理函数按需调用。
 *   - 逻辑不写进 QQ 消息处理函数：所有繁重流程在本模块；handleMessage 只做"识别视频段→入队任务"。
 *
 * 安全（对应需求§7，逐条落实）：
 *   - 所有 FFmpeg/ASR/OCR 调用一律 execFile + 数组参数，绝不拼 shell、绝不走 exec；
 *   - 视频/图片文件必须落在白名单根目录（realpath + 前缀校验，防穿越/软链/项目外），超尺寸/非白名单扩展名拒绝；
 *   - URL 兜底下载走 safeFetch（固定 IP + socket 复核 + 逐跳重校验 + 限额）；
 *   - 临时帧/音频写入每任务独立隔离目录，分析结束强制清理；
 *   - 并发受 resourceManager 槽位约束，默认不并发多模型；
 *   - 默认本地：云端端点必须显式配置 + 命中 allowHosts + 过 isSafeUrl，否则一律不可用。
 *
 * 本模块零第三方依赖，纯 Node 内置 + 复用 safe_http / url_safety / task_manager。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const urlSafety = require('../url_safety');
const { safeFetch } = require('../safe_http');

const DEFAULTS = {
  // 默认关闭：遵循项目「新功能默认全关，仅按配置启用」基调；用户需在多模态管理 UI / ai_config.json
  // 显式开启并配置本地模型端点后才生效。避免在无本地算力时装傻发送"无法理解"刷屏。
  enabled: false,
  defaultMode: 'local', // local | cloud | hybrid
  ffmpeg: { binPath: '' },
  vl: { localEndpoint: '', localModel: '', cloudEndpoint: '', cloudModel: '', allowHosts: [], apiKeyRef: '' },
  ocr: { enabled: true, engine: 'auto', paddleCmd: [], cloudEndpoint: '', allowHosts: [], apiKeyRef: '' },
  asr: { enabled: true, provider: 'local', localCmd: [], cloudEndpoint: '', allowHosts: [], apiKeyRef: '' },
  summary: { localEndpoint: '', cloudEndpoint: '', cloudModel: '', allowHosts: [], apiKeyRef: '' },
  limits: {
    maxBytes: 100 * 1024 * 1024,
    maxDurationSec: 300,
    maxFrames: 12,
    maxConcurrent: 1,
    taskTimeoutMs: 5 * 60 * 1000,
  },
  autoDownloadModels: false, // 永远 false：绝不自动下载大模型
};

// 视频/媒体文件允许的扩展名
const MEDIA_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.flv', '.m4v', '.3gp', '.wmv', '.ts']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp']);

function num(v, d, min) {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return min != null ? Math.max(min, n) : n;
}

function deepMerge(base, over) {
  if (!over || typeof over !== 'object') return Object.assign({}, base);
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(over)) {
    const bv = base[k], ov = over[k];
    if (ov && typeof ov === 'object' && !Array.isArray(ov) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[k] = deepMerge(bv, ov);
    } else if (ov !== undefined) {
      out[k] = ov;
    }
  }
  return out;
}

/**
 * @param {object} deps
 *   - napcatCall(action, payload)
 *   - getCFG(): 返回 CFG（CFG.multimodal 为本模块配置）
 *   - callAPI(messages, allowTools, opts): 云端视觉/摘要兜底
 *   - log(line, kind?)
 *   - resourceManager: createLocalAIResourceManager 实例
 *   - taskManager: feiyu/task_manager 的 TaskManager 实例（可选，用于入队）
 *   - nowImpl()
 *   - baseDir: 项目根（用于白名单根目录），默认 __dirname/..
 */
function createMediaUnderstanding(deps) {
  deps = deps || {};
  const napcatCall = typeof deps.napcatCall === 'function' ? deps.napcatCall : async () => { throw new Error('napcatCall 未注入'); };
  const getCFG = typeof deps.getCFG === 'function' ? deps.getCFG : () => ({});
  const callAPI = typeof deps.callAPI === 'function' ? deps.callAPI : async () => { throw new Error('callAPI 未注入'); };
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const resourceManager = deps.resourceManager || null;
  const taskManager = deps.taskManager || null;
  const now = typeof deps.nowImpl === 'function' ? deps.nowImpl : () => Date.now();
  const BASE_DIR = deps.baseDir || path.resolve(__dirname, '..');
  const WORKSPACE = path.join(BASE_DIR, 'workspace');
  const NAPCAT_CACHE = path.join(BASE_DIR, 'napcat', 'cache');
  const MEDIA_TMP = path.join(WORKSPACE, '_media_tmp');

  // 白名单根目录（realpath + 相对关系校验，防穿越/软链/项目外）
  const ALLOWED_ROOTS = [WORKSPACE, NAPCAT_CACHE, MEDIA_TMP];

  function cfg() {
    const c = (typeof getCFG === 'function' && getCFG()) || {};
    const m = c.multimodal || {};
    const merged = deepMerge(DEFAULTS, m);
    // 兜底：绝不自动下载模型
    merged.autoDownloadModels = false;
    return merged;
  }

  // ============ 路径安全 ============
  function isUnderDir(real, base) {
    let r, b;
    try { r = fs.realpathSync(real); b = fs.realpathSync(base); } catch (e) { return false; }
    const rel = path.relative(b, r);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }
  function isUnderAllowedRoot(real) {
    for (const r of ALLOWED_ROOTS) if (isUnderDir(real, r)) return true;
    return false;
  }
  function isLocalPath(p) { return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/'); }

  /** 仅接受落在白名单根、扩展名合法、大小合规的媒体文件。返回 realpath 或 null。 */
  function safeMediaPath(p, extSet, maxBytes) {
    if (typeof p !== 'string' || !p) return null;
    if (!isLocalPath(p)) return null;
    let real;
    try { real = fs.realpathSync(p); } catch (e) { return null; }
    let st;
    try { st = fs.statSync(real); } catch (e) { return null; }
    if (!st.isFile()) return null;
    if (!isUnderAllowedRoot(real)) return null;
    if (extSet && !extSet.has(path.extname(real).toLowerCase())) return null;
    if (maxBytes && st.size > maxBytes) return null;
    return real;
  }

  // ============ 文件解析（视频/图片）============
  async function resolveVideoFile(seg, c) {
    c = c || cfg();
    const maxBytes = num(c.limits && c.limits.maxBytes, DEFAULTS.limits.maxBytes, 1024);
    const d = (seg && seg.data) || {};
    // ① 段内本地路径
    for (const cand of [d.path, d.file]) {
      if (typeof cand !== 'string' || !cand) continue;
      const p = /^file:\/\//i.test(cand) ? decodeURIComponent(cand.replace(/^file:\/\//i, '')) : cand;
      if (!isLocalPath(p)) continue;
      const ok = safeMediaPath(p, MEDIA_EXT, maxBytes);
      if (ok) return { path: ok, from: 'local' };
    }
    // ② NapCat get_file
    for (const key of ['file', 'file_id']) {
      const v = d[key];
      if (typeof v !== 'string' || !v) continue;
      try {
        const r = await napcatCall('get_file', { file_id: v, file: v });
        const cands = [r && r.data && r.data.file, r && r.data && r.data.path];
        for (const cand of cands) {
          if (typeof cand !== 'string' || !cand) continue;
          const ok = safeMediaPath(cand, MEDIA_EXT, maxBytes);
          if (ok) return { path: ok, from: 'napcat' };
        }
      } catch (e) { /* 拿不到继续 */ }
    }
    // ③ URL 兜底（safeFetch：固定 IP + socket 复核 + 限额）
    const url = /^https?:/i.test(d.url || '') ? d.url : '';
    if (url) {
      try {
        if (!fs.existsSync(MEDIA_TMP)) fs.mkdirSync(MEDIA_TMP, { recursive: true });
        const r = await safeFetch(url, { maxRedirects: 3, maxBytes: maxBytes + 1024, headers: { 'User-Agent': 'feiyu-media/1.0', 'Referer': 'https://qq.com/' } });
        if (r && r.ok) {
          const ab = r.body;
          if (ab && ab.byteLength > 0 && ab.byteLength <= maxBytes) {
            const ext = path.extname(new URL(r.finalUrl || url).pathname).toLowerCase();
            const name = 'v_' + now() + '_' + Math.random().toString(36).slice(2, 8) + (MEDIA_EXT.has(ext) ? ext : '.mp4');
            const fp = path.join(MEDIA_TMP, name);
            fs.writeFileSync(fp, ab);
            const ok = safeMediaPath(fp, MEDIA_EXT, maxBytes);
            if (ok) return { path: ok, from: 'download' };
          }
        }
      } catch (e) { log('[视频] 下载失败: ' + (e && e.message || e)); }
    }
    return null;
  }

  async function resolveImageAsBase64(seg, c) {
    c = c || cfg();
    const maxBytes = num(c.limits && c.limits.maxBytes, DEFAULTS.limits.maxBytes, 1024);
    const d = (seg && seg.data) || {};
    // 本地路径
    for (const cand of [d.path, d.file]) {
      if (typeof cand !== 'string' || !cand) continue;
      const p = /^file:\/\//i.test(cand) ? decodeURIComponent(cand.replace(/^file:\/\//i, '')) : cand;
      if (!isLocalPath(p)) continue;
      const ok = safeMediaPath(p, IMAGE_EXT, maxBytes);
      if (ok) { try { return 'data:image/' + (path.extname(ok).slice(1) || 'jpeg') + ';base64,' + fs.readFileSync(ok).toString('base64'); } catch (e) {} }
    }
    // get_file
    for (const key of ['file', 'file_id']) {
      const v = d[key];
      if (typeof v !== 'string' || !v) continue;
      try {
        const r = await napcatCall('get_file', { file_id: v, file: v });
        const cands = [r && r.data && r.data.file, r && r.data && r.data.path];
        for (const cand of cands) {
          if (typeof cand !== 'string' || !cand) continue;
          const ok = safeMediaPath(cand, IMAGE_EXT, maxBytes);
          if (ok) { try { return 'data:image/' + (path.extname(ok).slice(1) || 'jpeg') + ';base64,' + fs.readFileSync(ok).toString('base64'); } catch (e) {} }
        }
      } catch (e) {}
    }
    // URL
    const url = /^https?:/i.test(d.url || '') ? d.url : '';
    if (url) {
      try {
        const r = await safeFetch(url, { maxRedirects: 3, maxBytes: maxBytes + 1024, headers: { 'User-Agent': 'feiyu-media/1.0' } });
        if (r && r.ok && r.body) return 'data:' + (r.contentType || 'image/jpeg') + ';base64,' + Buffer.from(r.body).toString('base64');
      } catch (e) {}
    }
    return null;
  }

  // ============ FFmpeg 探测与定位 ============
  function ffmpegBin(c) {
    c = c || cfg();
    if (c.ffmpeg && c.ffmpeg.binPath && typeof c.ffmpeg.binPath === 'string' && c.ffmpeg.binPath.trim()) {
      return c.ffmpeg.binPath.trim();
    }
    // 自动探测：优先 napcat/native/ffmpeg/ffmpeg.exe，否则走 PATH 上的 ffmpeg
    const localExe = path.join(BASE_DIR, 'napcat', 'native', 'ffmpeg', 'ffmpeg.exe');
    if (fs.existsSync(localExe)) return localExe;
    return 'ffmpeg';
  }

  /** 探测 ffmpeg 是否可用 + 版本。execFile 数组参数，绝不拼 shell。 */
  function probeFFmpeg(c) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => { if (!done) { done = true; resolve(r); } };
      const t = setTimeout(() => finish({ available: false, reason: 'timeout' }), 3000);
      try {
        execFile(ffmpegBin(c), ['-version'], { timeout: 3000, maxBuffer: 256 * 1024 }, (err, stdout) => {
          clearTimeout(t);
          if (err) return finish({ available: false, reason: String(err.message || err).slice(0, 80) });
          const v = String(stdout || '').split('\n')[0] || '';
          finish({ available: true, version: v.slice(0, 60) });
        });
      } catch (e) { clearTimeout(t); finish({ available: false, reason: String(e && e.message || e).slice(0, 80) }); }
    });
  }

  /** 解析 ffmpeg -i 的时长/码率（从 stderr 抓 Duration）。无需 ffprobe。 */
  function probeMediaInfo(file, c) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => { if (!done) { done = true; resolve(r); } };
      const t = setTimeout(() => finish({ ok: false, reason: 'timeout' }), 8000);
      const args = ['-i', file];
      try {
        // ffmpeg -i 会立即退出（无输出文件），我们只从 stderr 解析元信息
        const cp = execFile(ffmpegBin(c), args, { timeout: 8000, maxBuffer: 256 * 1024 }, () => {});
        let out = '';
        if (cp.stderr) cp.stderr.on('data', (d) => { out += d.toString(); });
        if (cp.stdout) cp.stdout.on('data', (d) => { out += d.toString(); });
        cp.on('close', () => {
          clearTimeout(t);
          const durM = /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/.exec(out);
          let duration = null;
          if (durM) {
            duration = (+durM[1]) * 3600 + (+durM[2]) * 60 + (+durM[3]) + (+('0.' + durM[4]));
          }
          const hasVideo = /Stream.*Video:/.test(out);
          const hasAudio = /Stream.*Audio:/.test(out);
          finish({ ok: true, duration, hasVideo, hasAudio, raw: out.slice(0, 400) });
        });
        cp.on('error', () => { clearTimeout(t); finish({ ok: false, reason: 'spawn-failed' }); });
      } catch (e) { clearTimeout(t); finish({ ok: false, reason: String(e && e.message || e).slice(0, 80) }); }
    });
  }

  // ============ 端点调用（VL / 摘要，OpenAI 兼容 chat/completions）============
  function hostOf(u) { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } }
  function isLoopback(host) { return host === '127.0.0.1' || host === 'localhost' || host === '::1'; }
  function hostAllowed(host, allowHosts) {
    if (!host || !allowHosts || !allowHosts.length) return false;
    const h = String(host).toLowerCase();
    for (const a of allowHosts) {
      const p = String(a).toLowerCase().trim();
      if (!p) continue;
      if (p === h) return true;
      if (p.startsWith('*.') && h.endsWith(p.slice(1))) return true;
    }
    return false;
  }

  /** 校验端点：本地端点必须回环；云端端点必须显式 + 白名单 + isSafeUrl。 */
  function classifyEndpoint(endpoint, allowHosts) {
    if (!endpoint || typeof endpoint !== 'string' || !endpoint.trim()) return { kind: 'none' };
    let u;
    try { u = new URL(endpoint.trim()); } catch (e) { return { kind: 'invalid' }; }
    const host = u.hostname.toLowerCase();
    if (isLoopback(host)) return { kind: 'local', url: endpoint.trim() };
    // 非回环 = 云端：必须白名单 + isSafeUrl
    if (!hostAllowed(host, allowHosts || [])) return { kind: 'cloud-blocked', reason: 'host-not-allowed' };
    if (urlSafety && typeof urlSafety.isSafeUrl === 'function' && !urlSafety.isSafeUrl(endpoint.trim())) {
      return { kind: 'cloud-blocked', reason: 'unsafe-url' };
    }
    return { kind: 'cloud', url: endpoint.trim() };
  }

  /**
   * 调用 OpenAI 兼容 chat/completions。
   * @param {string} endpoint 完整 completions URL
   * @param {string} model
   * @param {Array} messages
   * @param {object} o {apiKey, timeoutMs, signal, maxTokens}
   */
  async function callChatCompletions(endpoint, model, messages, o) {
    o = o || {};
    const body = JSON.stringify({ model: model || '', messages, temperature: o.temperature != null ? o.temperature : 0.2, max_tokens: o.maxTokens || 1500 });
    const headers = { 'Content-Type': 'application/json' };
    if (o.apiKey) headers['Authorization'] = 'Bearer ' + o.apiKey;
    const r = await safeFetch(endpoint, {
      method: 'POST',
      headers,
      body,
      timeoutMs: o.timeoutMs || 60000,
      signal: o.signal,
    });
    if (!r || !r.ok) throw new Error('VL/LLM 调用失败 http=' + (r && r.status));
    let j;
    try { j = typeof r.body === 'string' ? JSON.parse(r.body) : JSON.parse(Buffer.from(r.body).toString('utf-8')); }
    catch (e) { throw new Error('VL/LLM 返回非 JSON'); }
    const txt = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
    if (!txt) throw new Error('VL/LLM 返回空内容');
    return txt;
  }

  // ============ 能力自检（供桌面端如实展示）============
  async function probeCapabilities() {
    const c = cfg();
    const ff = await probeFFmpeg(c);
    const vlLocal = classifyEndpoint(c.vl && c.vl.localEndpoint, c.vl && c.vl.allowHosts);
    const vlCloud = classifyEndpoint(c.vl && c.vl.cloudEndpoint, c.vl && c.vl.allowHosts);
    let vl = 'notInstalled';
    if (vlLocal.kind === 'local') vl = 'ready';
    else if (vlLocal.kind === 'invalid' || vlLocal.kind === 'cloud-blocked') vl = 'misconfigured';
    else if (vlCloud.kind === 'cloud') vl = 'ready'; // 云端可选
    else vl = 'notInstalled';

    const ocrEngine = (c.ocr && c.ocr.engine) || 'auto';
    let ocr = 'disabled';
    if (c.ocr && c.ocr.enabled !== false) {
      if (ocrEngine === 'paddle' && Array.isArray(c.ocr.paddleCmd) && c.ocr.paddleCmd.length) ocr = 'ready';
      else if (vl === 'ready') ocr = 'ready'; // VL 可做 OCR
      else if (classifyEndpoint(c.ocr && c.ocr.cloudEndpoint, c.ocr && c.ocr.allowHosts).kind === 'cloud') ocr = 'ready';
      else ocr = 'notInstalled';
    }
    const asr = (c.asr && c.asr.enabled === false) ? 'disabled'
      : (c.asr && c.asr.provider === 'local' && Array.isArray(c.asr.localCmd) && c.asr.localCmd.length) ? 'ready'
      : (c.asr && classifyEndpoint(c.asr && c.asr.cloudEndpoint, c.asr && c.asr.allowHosts).kind === 'cloud') ? 'ready'
      : 'notInstalled';
    const summary = classifyEndpoint(c.summary && c.summary.localEndpoint, c.summary && c.summary.allowHosts).kind === 'local' ? 'ready'
      : classifyEndpoint(c.summary && c.summary.cloudEndpoint, c.summary && c.summary.allowHosts).kind === 'cloud' ? 'ready'
      : 'notInstalled';

    return {
      enabled: c.enabled !== false,
      defaultMode: c.defaultMode || 'local',
      ffmpeg: { available: ff.available, version: ff.version || null, reason: ff.reason || null, note: ff.available ? '' : '未找到 ffmpeg：本机视频解码不可用（请安装 ffmpeg 并配置 multimodal.ffmpeg.binPath，或放到 napcat/native/ffmpeg/ffmpeg.exe）' },
      vision: vl,
      ocr,
      asr,
      summary,
      localFirst: true,
      autoDownloadModels: false,
      limits: c.limits,
    };
  }

  // ============ 本地视觉分析（VL）============
  async function analyzeFramesWithVL(frames, question, c, o) {
    // frames: [{path, timeSec}] -> 取 base64 发给 VL
    const ep = pickVLEndpoint(c);
    if (!ep) return { ok: false, reason: 'no-vl-endpoint' };
    const parts = [{ type: 'text', text: String(question || '请按时间顺序如实描述这些视频帧的内容，包含可见文字、主体、场景变化；看不清就说看不清。') }];
    for (const f of frames.slice(0, c.limits.maxFrames)) {
      try {
        const b64 = fs.readFileSync(f.path).toString('base64');
        parts.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } });
      } catch (e) {}
    }
    const messages = [{ role: 'system', content: '你是视频帧分析助手，只描述真实看到的内容，禁止编造。' }, { role: 'user', content: parts }];
    const txt = await callChatCompletions(ep.url, ep.model, messages, { apiKey: ep.apiKey, timeoutMs: num(c.limits.taskTimeoutMs, DEFAULTS.limits.taskTimeoutMs, 1000), signal: o && o.signal });
    return { ok: true, text: txt, endpointKind: ep.kind, model: ep.model };
  }

  function pickVLEndpoint(c) {
    const vl = c.vl || {};
    const local = classifyEndpoint(vl.localEndpoint, vl.allowHosts);
    const mode = (c.defaultMode || 'local');
    if (mode === 'cloud') {
      const cloud = classifyEndpoint(vl.cloudEndpoint, vl.allowHosts);
      if (cloud.kind === 'cloud') return { url: cloud.url, model: vl.cloudModel, kind: 'cloud', apiKey: resolveKey(vl.apiKeyRef) };
    }
    if (local.kind === 'local') return { url: local.url, model: vl.localModel, kind: 'local', apiKey: resolveKey(vl.apiKeyRef) };
    // hybrid / local 失败回退云端
    const cloud = classifyEndpoint(vl.cloudEndpoint, vl.allowHosts);
    if (cloud.kind === 'cloud') return { url: cloud.url, model: vl.cloudModel, kind: 'cloud', apiKey: resolveKey(vl.apiKeyRef) };
    return null;
  }
  function resolveKey(ref) {
    if (!ref) return '';
    // 仅返回引用名对应的值需经凭证服务；此处安全返回空，避免在本模块读密钥。
    // 真实取密钥由桥注入 getSecret(ref)。
    return (typeof deps.getSecret === 'function') ? (deps.getSecret(ref) || '') : '';
  }

  // ============ OCR ============
  async function extractText(imagePath, c, o) {
    c = c || cfg();
    if (!c.ocr || c.ocr.enabled === false) return { ok: false, reason: 'disabled' };
    const engine = c.ocr.engine || 'auto';
    // ① VL 做 OCR（若 VL 可用且 engine=auto/paddle 都不满足）
    if (engine !== 'paddle') {
      const ep = pickVLEndpoint(c);
      if (ep) {
        try {
          const b64 = fs.readFileSync(imagePath).toString('base64');
          const messages = [{ role: 'system', content: '你是 OCR 助手，只输出图中所有文字，按出现顺序，不要解释。' },
            { role: 'user', content: [{ type: 'text', text: '请识别这张图里的全部文字。' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } }] }];
          const txt = await callChatCompletions(ep.url, ep.model, messages, { apiKey: ep.apiKey, timeoutMs: 30000, signal: o && o.signal });
          return { ok: true, text: txt, engine: 'vl', endpointKind: ep.kind };
        } catch (e) { /* 落 paddle/cloud */ }
      }
    }
    // ② PaddleOCR 本地命令（execFile 数组参数，{file} 替换）
    if (engine === 'paddle' || engine === 'auto') {
      const cmd = Array.isArray(c.ocr.paddleCmd) ? c.ocr.paddleCmd : [];
      if (cmd.length) {
        const args = cmd.slice(1).map((a) => String(a).replace(/\{file\}/g, imagePath));
        const txt = await runExec(cmd[0], args, { timeoutMs: 30000, maxBuffer: 2 * 1024 * 1024 });
        if (txt != null) return { ok: true, text: txt.slice(0, 4000), engine: 'paddle' };
      }
    }
    // ③ 云端 OCR（可选）
    const cloud = classifyEndpoint(c.ocr.cloudEndpoint, c.ocr.allowHosts);
    if (cloud.kind === 'cloud') {
      try {
        const r = await safeFetch(cloud.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: 'data:image/jpeg;base64,' + fs.readFileSync(imagePath).toString('base64') }) });
        const txt = r && r.text ? String(r.text) : '';
        if (txt) return { ok: true, text: txt.slice(0, 4000), engine: 'cloud' };
      } catch (e) {}
    }
    return { ok: false, reason: 'ocr-unavailable' };
  }

  // ============ ASR（复用 voice_asr 思路，本地优先）============
  async function transcribeAudio(audioPath, c, o) {
    c = c || cfg();
    if (!c.asr || c.asr.enabled === false) return { ok: false, reason: 'disabled' };
    const provider = c.asr.provider || 'local';
    if (provider === 'local') {
      const cmd = Array.isArray(c.asr.localCmd) ? c.asr.localCmd : [];
      if (!cmd.length) return { ok: false, reason: 'local-not-configured' };
      const args = cmd.slice(1).map((a) => String(a).replace(/\{file\}/g, audioPath));
      const txt = await runExec(cmd[0], args, { timeoutMs: num(c.limits.taskTimeoutMs, DEFAULTS.limits.taskTimeoutMs, 1000), maxBuffer: 4 * 1024 * 1024 });
      if (txt != null) return { ok: true, text: txt.slice(0, 4000), provider: 'local' };
      return { ok: false, reason: 'local-failed' };
    }
    // 云端 ASR（可选）
    const cloud = classifyEndpoint(c.asr.cloudEndpoint, c.asr.allowHosts);
    if (cloud.kind === 'cloud') {
      try {
        const r = await safeFetch(cloud.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ audio: 'data:audio/wav;base64,' + fs.readFileSync(audioPath).toString('base64') }) });
        const txt = r && r.text ? String(r.text) : '';
        if (txt) return { ok: true, text: txt.slice(0, 4000), provider: 'cloud' };
      } catch (e) {}
      return { ok: false, reason: 'cloud-failed' };
    }
    return { ok: false, reason: 'unsupported-provider' };
  }

  /** execFile 数组参数封装（绝不拼 shell）。返回 stdout 文本或 null。 */
  function runExec(bin, args, o) {
    o = o || {};
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => { if (!done) { done = true; resolve(r); } };
      const t = setTimeout(() => finish(null), o.timeoutMs || 30000);
      try {
        execFile(String(bin), args || [], { timeout: o.timeoutMs || 30000, maxBuffer: o.maxBuffer || 1024 * 1024 },
          (err, stdout) => {
            clearTimeout(t);
            if (err) return finish(null);
            const txt = String(stdout || '').trim();
            finish(txt || null);
          });
      } catch (e) { clearTimeout(t); finish(null); }
    });
  }

  // ============ 视频帧提取（关键帧/场景变化/等间隔）============
  async function extractFrames(file, info, c, taskDir) {
    const maxFrames = num(c.limits && c.limits.maxFrames, DEFAULTS.limits.maxFrames, 1);
    const dur = info.duration && info.duration > 0 ? info.duration : 10;
    // 等间隔抽帧 + 场景变化兜底：先用 fps=1/step 抽，step 保证不超过 maxFrames
    const step = Math.max(1, Math.ceil(dur / maxFrames));
    const outPat = path.join(taskDir, 'frame_%03d.jpg');
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const t = setTimeout(finish, 60000);
      try {
        const cp = execFile(ffmpegBin(c), ['-y', '-i', file, '-vf', `fps=1/${step}`, '-frames:v', String(maxFrames), outPat],
          { timeout: 60000, maxBuffer: 1024 * 1024 }, (err) => { clearTimeout(t); finish(); });
        cp.on('error', () => { clearTimeout(t); finish(); });
      } catch (e) { clearTimeout(t); finish(); }
    });
    // 收集生成的帧
    let frames = [];
    try {
      const files = fs.readdirSync(taskDir).filter((f) => /^frame_\d+\.jpg$/.test(f)).sort();
      const stepSec = step;
      frames = files.map((f, i) => ({ path: path.join(taskDir, f), timeSec: Math.round(i * stepSec * 10) / 10 }));
    } catch (e) {}
    return frames;
  }

  async function extractAudio(file, c, taskDir) {
    const out = path.join(taskDir, 'audio.wav');
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const t = setTimeout(finish, 60000);
      try {
        const cp = execFile(ffmpegBin(c), ['-y', '-i', file, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', out],
          { timeout: 60000, maxBuffer: 1024 * 1024 }, (err) => { clearTimeout(t); finish(); });
        cp.on('error', () => { clearTimeout(t); finish(); });
      } catch (e) { clearTimeout(t); finish(); }
    });
    return fs.existsSync(out) ? out : null;
  }

  // ============ 视频理解主流程 ============
  async function analyzeVideo(seg, opts) {
    opts = opts || {};
    const c = cfg();
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    const signal = opts.signal || null;

    const ff = await probeFFmpeg(c);
    if (!ff.available) {
      return { ok: false, reason: 'ffmpeg-unavailable', note: ff.reason || '本机未安装 ffmpeg，视频解码不可用', capability: 'ffmpeg' };
    }

    const fileRes = await resolveVideoFile(seg, c);
    if (!fileRes) return { ok: false, reason: 'no-video-file', note: '拿不到视频文件（本地路径/下载/不在允许目录内）' };

    const info = await probeMediaInfo(fileRes.path, c);
    if (info.ok && info.duration && info.duration > num(c.limits.maxDurationSec, DEFAULTS.limits.maxDurationSec, 1)) {
      return { ok: false, reason: 'too-long', note: '视频时长 ' + Math.round(info.duration) + 's 超过上限 ' + c.limits.maxDurationSec + 's' };
    }

    // 隔离临时目录（每任务）
    const taskDir = path.join(MEDIA_TMP, 'job_' + now() + '_' + Math.random().toString(36).slice(2, 8));
    fs.mkdirSync(taskDir, { recursive: true });
    const cleanup = () => { try { fs.rmSync(taskDir, { recursive: true, force: true }); } catch (e) {} };

    try {
      onProgress({ stage: 'extract-frames', at: now() });
      const frames = await extractFrames(fileRes.path, info, c, taskDir);
      const timeline = [];
      // 逐帧：VL 描述 + OCR
      for (let i = 0; i < frames.length; i++) {
        if (signal && signal.aborted) return { ok: false, reason: 'cancelled' };
        const f = frames[i];
        let caption = null, ocr = null;
        const vl = await analyzeFramesWithVL([f], null, c, { signal });
        if (vl.ok) caption = vl.text;
        if (c.ocr && c.ocr.enabled !== false) {
          const o = await extractText(f.path, c, { signal });
          if (o.ok) ocr = o.text;
        }
        timeline.push({ t: f.timeSec, type: 'frame', caption, ocr });
      }
      onProgress({ stage: 'extract-audio', at: now(), frames: frames.length });

      // 音轨 + ASR
      let transcript = null;
      if (info.ok && info.hasAudio) {
        const audio = await extractAudio(fileRes.path, c, taskDir);
        if (audio) {
          const asr = await transcribeAudio(audio, c, { signal });
          if (asr.ok) transcript = asr.text;
        }
      }
      if (transcript) timeline.push({ t: null, type: 'audio', text: transcript });

      onProgress({ stage: 'summarize', at: now() });
      const summary = await summarizeTimeline(timeline, c, { signal });

      cleanup();
      return {
        ok: true,
        source: fileRes.from,
        duration: info.ok ? info.duration : null,
        frameCount: frames.length,
        hasAudio: !!(info.ok && info.hasAudio),
        transcript,
        timeline,
        summary: summary.ok ? summary.text : null,
        summaryNote: summary.ok ? null : (summary.reason || '摘要不可用'),
        mode: c.defaultMode,
      };
    } catch (e) {
      cleanup();
      return { ok: false, reason: 'pipeline-error', error: String(e && e.message || e).slice(0, 200) };
    }
  }

  // ============ 摘要 ============
  async function summarizeTimeline(timeline, c, o) {
    c = c || cfg();
    const text = timelineToText(timeline);
    const ep = pickSummaryEndpoint(c);
    if (!ep) return { ok: false, reason: 'no-summary-endpoint' };
    const messages = [
      { role: 'system', content: '你是视频内容总结助手。根据时间轴（含画面描述、OCR 文字、语音转写）给出简洁摘要与要点，禁止编造未出现的内容。' },
      { role: 'user', content: '请总结以下视频时间轴：\n' + text },
    ];
    try {
      const txt = await callChatCompletions(ep.url, ep.model, messages, { apiKey: ep.apiKey, timeoutMs: num(c.limits.taskTimeoutMs, DEFAULTS.limits.taskTimeoutMs, 1000), signal: o && o.signal });
      return { ok: true, text: txt };
    } catch (e) { return { ok: false, reason: String(e && e.message || e).slice(0, 120) }; }
  }

  function pickSummaryEndpoint(c) {
    const s = c.summary || {};
    const mode = c.defaultMode || 'local';
    if (mode === 'cloud') {
      const cloud = classifyEndpoint(s.cloudEndpoint, s.allowHosts);
      if (cloud.kind === 'cloud') return { url: cloud.url, model: s.cloudModel, kind: 'cloud', apiKey: resolveKey(s.apiKeyRef) };
    }
    const local = classifyEndpoint(s.localEndpoint, s.allowHosts);
    if (local.kind === 'local') return { url: local.url, model: '', kind: 'local', apiKey: resolveKey(s.apiKeyRef) };
    const cloud = classifyEndpoint(s.cloudEndpoint, s.allowHosts);
    if (cloud.kind === 'cloud') return { url: cloud.url, model: s.cloudModel, kind: 'cloud', apiKey: resolveKey(s.apiKeyRef) };
    return null;
  }

  function timelineToText(timeline) {
    return (timeline || []).map((e) => {
      const head = e.t != null ? `[${e.t}s]` : '[音轨]';
      if (e.type === 'audio') return head + ' 语音: ' + (e.text || '');
      return head + ' 画面: ' + (e.caption || '') + (e.ocr ? (' | 文字: ' + e.ocr) : '');
    }).join('\n');
  }

  // ============ 追问 ============
  async function answerMediaQuestion(context, question, opts) {
    opts = opts || {};
    const c = cfg();
    const ep = pickVLEndpoint(c);
    if (!ep) return { ok: false, reason: 'no-vl-endpoint' };
    const timelineText = (context && context.timeline) ? timelineToText(context.timeline) : '';
    const summary = (context && context.summary) || '';
    const messages = [
      { role: 'system', content: '你基于已分析视频的时间轴与摘要回答问题，只依据给定信息，禁止编造。' },
      { role: 'user', content: '视频摘要：\n' + summary + '\n\n时间轴：\n' + timelineText + '\n\n问题：' + String(question || '') },
    ];
    try {
      const txt = await callChatCompletions(ep.url, ep.model, messages, { apiKey: ep.apiKey, timeoutMs: num(c.limits.taskTimeoutMs, DEFAULTS.limits.taskTimeoutMs, 1000), signal: opts.signal });
      return { ok: true, answer: txt };
    } catch (e) { return { ok: false, reason: String(e && e.message || e).slice(0, 120) }; }
  }

  // ============ 图片理解（统一接口，不破坏既有图片链路）============
  async function analyzeImage(seg, opts) {
    opts = opts || {};
    const c = cfg();
    const dataUrl = await resolveImageAsBase64(seg, c);
    if (!dataUrl) return { ok: false, reason: 'no-image' };
    const ep = pickVLEndpoint(c);
    if (!ep) return { ok: false, reason: 'no-vl-endpoint' };
    const messages = [
      { role: 'system', content: '你是图片分析助手，只描述真实看到的内容，禁止编造。' },
      { role: 'user', content: [{ type: 'text', text: String(opts.question || '请描述这张图片的内容。') }, { type: 'image_url', image_url: { url: dataUrl } }] },
    ];
    try {
      const txt = await callChatCompletions(ep.url, ep.model, messages, { apiKey: ep.apiKey, timeoutMs: 30000, signal: opts.signal });
      let ocr = null;
      if (opts.ocr !== false && c.ocr && c.ocr.enabled !== false) {
        // 从 dataUrl 还原临时文件做 OCR
        const tmp = path.join(MEDIA_TMP, 'img_' + now() + '_' + Math.random().toString(36).slice(2, 8) + '.jpg');
        fs.mkdirSync(MEDIA_TMP, { recursive: true });
        fs.writeFileSync(tmp, Buffer.from(dataUrl.split(',')[1], 'base64'));
        const o = await extractText(tmp, c, { signal: opts.signal });
        if (o.ok) ocr = o.text;
        try { fs.unlinkSync(tmp); } catch (e) {}
      }
      return { ok: true, caption: txt, ocr, mode: c.defaultMode };
    } catch (e) { return { ok: false, reason: String(e && e.message || e).slice(0, 120) }; }
  }

  // ============ 入队（消息处理函数调用）============
  /**
   * 收到真实视频段时调用：入队一个视频理解任务（可被任务中心取消/监控）。
   * @param {object} seg OneBot video 段
   * @param {object} ctx { ev, chatId, groupId, userId, sendReply(text) }
   */
  async function handleIncomingVideo(seg, ctx) {
    ctx = ctx || {};
    const c = cfg();
    if (c.enabled === false) return { ok: false, reason: 'disabled' };
    if (!taskManager) {
      // 未接入任务中心：直接同步分析（仍受资源约束）
      const r = await analyzeVideo(seg, { onProgress: ctx.onProgress });
      if (r.ok && ctx.sendReply) ctx.sendReply(formatVideoReply(r));
      return { ok: r.ok, direct: true, result: r };
    }
    const task = taskManager.create({
      type: 'media.video',
      title: '视频理解 @' + mask(String((ctx.ev && ctx.ev.group_id) || (ctx.ev && ctx.ev.user_id) || '私聊')),
      ownerId: String((ctx.ev && ctx.ev.user_id) || ''),
      priority: 1,
      payload: {
        segRef: { type: 'video', data: (seg && seg.data) || {} },
        chatId: ctx.chatId || null,
        groupId: (ctx.ev && ctx.ev.group_id) || null,
        userId: (ctx.ev && ctx.ev.user_id) || null,
      },
      steps: [{ kind: 'media.video', payload: {} }],
    });
    return { ok: !!task.ok, taskId: task.id, enqueued: true };
  }

  function mask(id) { const s = String(id || ''); return s.length <= 4 ? s : s.slice(0, 2) + '***' + s.slice(-2); }

  function formatVideoReply(r) {
    if (!r.ok) return '视频理解暂不可用：' + (r.note || r.reason || '未知原因');
    let out = '【视频理解】';
    if (r.summary) out += '\n摘要：' + r.summary;
    if (r.transcript) out += '\n语音：' + r.transcript.slice(0, 500);
    out += '\n（共 ' + (r.frameCount || 0) + ' 帧分析，时长 ' + (r.duration != null ? Math.round(r.duration) + 's' : '?') + '，模式=' + (r.mode || 'local') + '）';
    return out.slice(0, 1800);
  }

  // 提供给任务中心 executor 的入口：step 执行分析
  async function executeVideoStep(step, task, tctx) {
    const seg = { type: 'video', data: (task && task.payload && task.payload.segRef && task.payload.segRef.data) || {} };
    const r = await analyzeVideo(seg, { signal: tctx && tctx.signal, onProgress: (p) => { if (task && task.history) task.history.push({ at: now(), ev: 'progress', stage: p.stage }); } });
    // 把结果挂在任务上，由任务中心的 onEvent 在"终态"时一次性回送（避免每次重试都打扰用户）
    if (task) task.mediaResult = r;
    if (!r.ok) return { ok: false, error: r.reason || 'analyze-failed' };
    return { ok: true, output: { summary: r.summary, frameCount: r.frameCount, duration: r.duration } };
  }

  return {
    cfg,
    probeCapabilities,
    analyzeVideo, analyzeImage,
    extractText, transcribeAudio,
    summarizeTimeline, summarizeMedia: summarizeTimeline,
    answerMediaQuestion,
    handleIncomingVideo, executeVideoStep,
    // 测试/诊断导出
    _safeMediaPath: safeMediaPath,
    _classifyEndpoint: classifyEndpoint,
    _probeFFmpeg: probeFFmpeg,
    _resolveVideoFile: resolveVideoFile,
    _isUnderAllowedRoot: isUnderAllowedRoot,
    _timelineToText: timelineToText,
    DEFAULTS,
  };
}

module.exports = { createMediaUnderstanding, DEFAULTS, MEDIA_EXT, IMAGE_EXT };
