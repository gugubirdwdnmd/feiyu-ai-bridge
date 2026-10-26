'use strict';
/**
 * comfyService.js —— ComfyUI 生图扩展（桌面端）。
 *
 * 职责：
 *  1. 检测本机 ComfyUI 是否存在、是否在跑（/system_stats）、用的是哪套工作流。
 *  2. **前置校验**：生图链路依赖「大模型」——
 *     - 机器人侧的 LLM Provider（用于把中文需求转成画面描述 / 文生图提示词翻译）；
 *     - ComfyUI 侧的文本编码器模型（Qwen3-4B-Q5_K_M.gguf，即工作流里的 CLIPLoaderGGUF）。
 *     两者缺一都会让「画图」变成空转，故在界面上明确列出未满足的前置条件。
 *  3. **自动下载**：ComfyUI 官方 Windows 便携版（GitHub Releases 的 .7z）+ 缺失的模型文件
 *     （HuggingFace / hf-mirror 镜像）。下载走流式 + 进度回调 + 大小上限 + 磁盘空间预检。
 *  4. 工作流管理：列出 botDir/workflows 下的 API 格式工作流，校验是否含必要节点。
 *
 * 安全边界：
 *  - 下载地址全部来自「内置白名单 + GitHub API 实时解析」，不接受 UI 传入任意 URL。
 *  - 只允许写 ComfyUI 的 models / workflows 目录与下载缓存目录。
 *  - 不触碰真实机器人配置；「应用到机器人」由 providerApplyService 同类机制完成（写入 ai_config.json）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_PORT = 8188;
const DEFAULT_ENDPOINT = 'http://127.0.0.1:' + DEFAULT_PORT;

// —— 内置下载白名单（不允许 UI 传入任意地址）——
// ComfyUI 官方发布页（GitHub Releases，含 Windows 便携版 .7z）
const COMFY_REPO = 'comfyanonymous/ComfyUI';
const COMFY_RELEASE_API = 'https://api.github.com/repos/' + COMFY_REPO + '/releases/latest';
// 便携版资源名（按显卡架构选择）
const COMFY_ASSETS = {
  nvidia: 'ComfyUI_windows_portable_nvidia.7z',
  amd: 'ComfyUI_windows_portable_amd.7z',
  intel: 'ComfyUI_windows_portable_intel.7z',
  nvidia_arm64: 'ComfyUI_windows_portable_nvidia_arm64.7z',
  nvidia_cu126: 'ComfyUI_windows_portable_nvidia_cu126.7z',
};

// —— 模型清单（工作流 z_image_turbo 所需）——
// 每个模型声明：放在 ComfyUI 的哪个子目录、文件名、候选下载源、期望字节数。
// 源用 HF 仓库路径表示，实际 URL 由 hfBase 拼出（huggingface.co 在部分网络不可达时回落 hf-mirror.com）。
// 仓库、文件名与 bytes 均已对上游仓库实测（content-length 与官方发布一致），
// 且文件名与工作流里的 loader 节点名严格对应 —— 改名会导致 ComfyUI 加载不到。
const MODEL_CATALOG = [
  {
    key: 'unet',
    label: 'Z-Image-Turbo 扩散模型 (GGUF)',
    dir: 'diffusion_models',
    file: 'z_image_turbo-Q5_K_M.gguf',
    repo: 'jayn7/Z-Image-Turbo-GGUF',
    hfPath: 'z_image_turbo-Q5_K_M.gguf',
    approxMB: 5266,
    bytes: 5522742336,
    required: true,
    note: '工作流中的 UnetLoaderGGUF 节点使用（文件名必须完全一致）',
  },
  {
    key: 'text_encoder',
    label: 'Qwen3-4B 文本编码器 (GGUF)',
    dir: 'text_encoders',
    file: 'Qwen3-4B-Q5_K_M.gguf',
    repo: 'Qwen/Qwen3-4B-GGUF',
    hfPath: 'Qwen3-4B-Q5_K_M.gguf',
    approxMB: 2755,
    bytes: 2889513184,
    required: true,
    note: '大模型前置项：工作流里的 CLIPLoaderGGUF；缺它则无法把文字编码成图像条件',
  },
  {
    key: 'vae',
    label: 'AE 潜空间解码器',
    dir: 'vae',
    file: 'ae.safetensors',
    repo: 'Comfy-Org/Z-Image-Turbo',
    hfPath: 'split_files/vae/ae.safetensors',
    approxMB: 319,
    bytes: 335304388,
    required: true,
    note: '工作流中的 VAELoader 节点使用',
  },
];

const HF_BASES = [
  'https://huggingface.co',
  'https://hf-mirror.com',
];

const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024 * 1024; // 单文件上限 8GB
const MIN_FREE_BYTES = 3 * 1024 * 1024 * 1024;     // 下载前要求至少 3GB 空闲

function nowISO() { return new Date().toISOString(); }

/** 判断路径是否是 ComfyUI 安装根（含 main.py 或 ComfyUI/main.py）。 */
function looksLikeComfyDir(p) {
  try {
    if (!p || !fs.existsSync(p)) return false;
    if (fs.existsSync(path.join(p, 'main.py'))) return true;
    if (fs.existsSync(path.join(p, 'ComfyUI', 'main.py'))) return true;
  } catch (_) {}
  return false;
}

/** 解析 ComfyUI 根目录（兼容「根目录直接是 ComfyUI」与「根目录里有 ComfyUI 子目录」两种布局）。 */
function resolveComfyRoot(dir) {
  if (!dir) return null;
  try {
    if (fs.existsSync(path.join(dir, 'main.py'))) return dir;
    const sub = path.join(dir, 'ComfyUI');
    if (fs.existsSync(path.join(sub, 'main.py'))) return sub;
  } catch (_) {}
  return null;
}

/** 常见安装位置候选（不硬编码具体盘符根，按用户目录与 D 盘常见名兜底）。 */
function candidateComfyDirs() {
  const out = [];
  const home = os.homedir();
  if (home) {
    out.push(path.join(home, 'ComfyUI'));
    out.push(path.join(home, 'ComfyUI_windows_portable'));
  }
  for (const letter of ['C', 'D', 'E']) {
    out.push(letter + ':\\ComfyUI');
    out.push(letter + ':\\ComfyUI_windows_portable');
  }
  return out;
}

/** 探测本机 ComfyUI：返回 {found, root, port, endpoint, candidates}。 */
function detect(options = {}) {
  const candidates = candidateComfyDirs();
  const explicit = options.dir || options.comfyDir || '';
  if (explicit) candidates.unshift(explicit);
  let found = null;
  let probed = [];
  for (const c of candidates) {
    try {
      probed.push(c);
      if (looksLikeComfyDir(c)) { found = resolveComfyRoot(c) || c; break; }
    } catch (_) {}
  }
  return {
    found: !!found,
    root: found,
    endpoint: options.endpoint || DEFAULT_ENDPOINT,
    port: options.port || DEFAULT_PORT,
    candidates: probed,
  };
}

/** 连通性测试：GET /system_stats。返回 {ok, running, version, device, error}。 */
async function testConnection(endpoint, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  const base = String(endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  if (!fetchFn) return { ok: false, running: false, error: '当前环境不支持 fetch' };
  try {
    const r = await fetchFn(base + '/system_stats', {
      signal: deps.AbortSignal && deps.AbortSignal.timeout ? deps.AbortSignal.timeout(4000) : undefined,
    });
    if (!r.ok) return { ok: false, running: false, error: 'HTTP ' + r.status };
    const j = await r.json().catch(() => null);
    const sys = (j && j.system) || {};
    const dev = (j && j.devices && j.devices[0]) || {};
    return {
      ok: true,
      running: true,
      version: sys.comfyui_version || null,
      python: sys.python_version ? String(sys.python_version).split(' ')[0] : null,
      os: sys.os || null,
      device: dev.name || null,
      vramMB: dev.vram_total ? Math.round(dev.vram_total / 1048576) : null,
    };
  } catch (e) {
    return { ok: false, running: false, error: String((e && e.message) || e).slice(0, 120) };
  }
}

/** 列出 botDir/workflows 下的工作流（含基本校验）。 */
function listWorkflows(botDir) {
  const dir = path.join(botDir, 'workflows');
  const out = [];
  let exists = false;
  try {
    if (!fs.existsSync(dir)) return { ok: true, dir, exists: false, workflows: [] };
    exists = true;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.json$/i.test(f)) continue;
      const full = path.join(dir, f);
      let wf = null, err = null;
      try { wf = JSON.parse(fs.readFileSync(full, 'utf-8')); } catch (e) { err = e.message; }
      const classes = wf && typeof wf === 'object'
        ? Object.values(wf).filter((n) => n && n.class_type).map((n) => n.class_type)
        : [];
      out.push({
        file: f,
        path: full,
        parseError: err,
        nodes: classes.length,
        hasCLIP: classes.some((c) => /CLIPText/i.test(c)),
        hasSampler: classes.some((c) => /KSampler/i.test(c)),
        hasSave: classes.some((c) => /SaveImage/i.test(c)),
        hasLoadImage: classes.some((c) => /LoadImage/i.test(c)),
        hasUnet: classes.some((c) => /UnetLoader|CheckpointLoader/i.test(c)),
        sizeKB: (() => { try { return Math.round(fs.statSync(full).size / 1024); } catch (_) { return 0; } })(),
      });
    }
  } catch (e) {
    return { ok: false, dir, error: e.message, workflows: [] };
  }
  return { ok: true, dir, exists, workflows: out };
}

/** 取某个模型的期望字节数；opts.expectedBytes 可覆盖（测试用）。 */
function expectedBytes(m, opts) {
  const ov = opts && opts.expectedBytes;
  if (ov && typeof ov === 'object' && Number.isFinite(ov[m.key])) return Number(ov[m.key]);
  return m.bytes || m.approxMB * 1048576;
}

/** 检查 ComfyUI 侧模型是否齐备。 */
function checkModels(comfyRoot, opts) {
  const root = comfyRoot ? resolveComfyRoot(comfyRoot) || comfyRoot : null;
  const items = MODEL_CATALOG.map((m) => {
    const target = root ? path.join(root, 'models', m.dir, m.file) : null;
    let present = false, size = 0;
    try {
      if (target && fs.existsSync(target)) { present = true; size = fs.statSync(target).size; }
    } catch (_) {}
    // 体积明显小于标称值 → 多半是上次下载被中断留下的半截文件，
    // ComfyUI 加载时会静默失败或报看不懂的错，这里提前标出来。
    const expected = expectedBytes(m, opts);
    const suspicious = present && size > 0 && size < expected * 0.9;
    return {
      key: m.key, label: m.label, dir: m.dir, file: m.file,
      repo: m.repo, hfPath: m.hfPath, approxMB: m.approxMB, bytes: m.bytes,
      required: m.required, note: m.note,
      present, size, target, suspicious,
    };
  });
  return {
    ok: true,
    root,
    models: items,
    missing: items.filter((m) => m.required && !m.present).map((m) => m.key),
    suspicious: items.filter((m) => m.suspicious).map((m) => m.key),
    ready: items.every((m) => !m.required || m.present),
  };
}

/**
 * 大模型前置条件检查。
 * 机器人侧 LLM（用于提示词翻译/扩写）+ ComfyUI 侧文本编码器，缺一不可。
 */
function checkPrerequisites(comfyRoot, llmStatus) {
  const models = checkModels(comfyRoot);
  const textEncoder = models.models.find((m) => m.key === 'text_encoder');
  const items = [
    {
      key: 'llm_provider',
      label: '机器人侧大模型（LLM Provider）',
      ok: !!(llmStatus && llmStatus.ok),
      detail: llmStatus && llmStatus.ok
        ? (llmStatus.detail || '已接入')
        : '未接入大模型 —— 画图前的提示词翻译/扩写无法进行，请先在「API 与模型」页接入',
      required: true,
    },
    {
      key: 'comfy_running',
      label: 'ComfyUI 服务运行中',
      ok: !!(llmStatus && llmStatus.comfyRunning),
      detail: llmStatus && llmStatus.comfyRunning
        ? '已连接 ' + (llmStatus.comfyEndpoint || DEFAULT_ENDPOINT)
        : '未运行 —— 请先启动 ComfyUI（本机 127.0.0.1:' + DEFAULT_PORT + '）',
      required: true,
    },
    {
      key: 'text_encoder',
      label: 'ComfyUI 文本编码器（Qwen3-4B GGUF）',
      ok: !!(textEncoder && textEncoder.present),
      detail: (textEncoder && textEncoder.present)
        ? '已就位 ' + textEncoder.file
        : '缺失 —— 需下载后放入 models/text_encoders/',
      required: true,
    },
    {
      key: 'unet',
      label: 'ComfyUI 扩散模型（Z-Image-Turbo GGUF）',
      ok: !!(models.models.find((m) => m.key === 'unet') || {}).present,
      detail: (models.models.find((m) => m.key === 'unet') || {}).present
        ? '已就位'
        : '缺失 —— 需下载后放入 models/diffusion_models/',
      required: true,
    },
  ];
  return {
    ok: items.every((i) => !i.required || i.ok),
    items,
    missing: items.filter((i) => i.required && !i.ok).map((i) => i.key),
    models,
  };
}

/** 解析 HF 下载候选 URL（huggingface.co 优先，失败可回落镜像）。 */
function modelUrls(m) {
  return HF_BASES.map((b) => b + '/' + m.repo + '/resolve/main/' + m.hfPath);
}

/**
 * 下载模型文件（流式 + 进度 + 上限 + 断点临时文件）。
 * 只允许下载 MODEL_CATALOG 中已登记的模型（UI 传 key，不传 URL）。
 */
async function downloadModel(comfyRoot, key, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  const onProgress = deps.onProgress || (() => {});
  const m = MODEL_CATALOG.find((x) => x.key === key);
  if (!m) return { ok: false, error: '未登记的模型：' + key };
  if (!fetchFn) return { ok: false, error: '当前环境不支持 fetch' };
  const root = resolveComfyRoot(comfyRoot);
  if (!root) return { ok: false, error: '未找到 ComfyUI 安装目录' };

  const destDir = path.join(root, 'models', m.dir);
  const dest = path.join(destDir, m.file);
  try { fs.mkdirSync(destDir, { recursive: true }); } catch (e) {
    return { ok: false, error: '无法创建目录: ' + e.message };
  }
  if (fs.existsSync(dest)) {
    let size = 0;
    try { size = fs.statSync(dest).size; } catch (_) {}
    const expected = expectedBytes(m, deps);
    // 已存在且体积正常 → 跳过；体积明显偏小 → 判定为半截文件，重新下载
    if (size >= expected * 0.9) {
      return { ok: true, skipped: true, path: dest, reason: '文件已存在' };
    }
    try { fs.unlinkSync(dest); } catch (_) {}
  }

  // 磁盘空间预检
  try {
    const free = freeSpace(destDir);
    if (free != null && free < MIN_FREE_BYTES) {
      return { ok: false, error: '磁盘空间不足：至少需要 ' + Math.ceil(MIN_FREE_BYTES / 1073741824) + 'GB 空闲' };
    }
  } catch (_) {}

  const tmp = dest + '.part';
  const urls = modelUrls(m);
  let lastErr = null;
  for (const url of urls) {
    try {
      onProgress({ phase: 'download', key, file: m.file, url, received: 0, total: m.approxMB * 1048576 });
      const r = await fetchFn(url, { redirect: 'follow' });
      if (!r.ok) { lastErr = 'HTTP ' + r.status; continue; }
      const total = Number(r.headers && r.headers.get && r.headers.get('content-length')) || 0;
      if (total && total > MAX_DOWNLOAD_BYTES) { lastErr = '文件超出大小上限'; continue; }
      const chunks = [];
      let received = 0;
      if (r.body && typeof r.body.getReader === 'function') {
        const reader = r.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          if (received > MAX_DOWNLOAD_BYTES) { lastErr = '下载超出大小上限'; try { await reader.cancel(); } catch (_) {} break; }
          chunks.push(Buffer.from(value));
          onProgress({ phase: 'download', key, file: m.file, url, received, total: total || m.approxMB * 1048576 });
        }
      } else {
        const buf = Buffer.from(await r.arrayBuffer());
        received = buf.length;
        if (received > MAX_DOWNLOAD_BYTES) { lastErr = '下载超出大小上限'; continue; }
        chunks.push(buf);
      }
      if (lastErr && received > MAX_DOWNLOAD_BYTES) break;
      if (!received) { lastErr = '响应为空'; continue; }
      // 完整性校验：服务端声明了 content-length 时，落地字节数必须一致，
      // 否则说明连接中断/被代理截断 —— 半截模型文件会被 ComfyUI 静默忽略或报错，
      // 必须在写盘前拦下（本地文件已存在同名小文件时同理）。
      if (total && received !== total) {
        lastErr = '下载不完整（' + received + '/' + total + ' 字节），可能是网络中断';
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
        continue;
      }
      fs.writeFileSync(tmp, Buffer.concat(chunks));
      fs.renameSync(tmp, dest);
      onProgress({ phase: 'done', key, file: m.file, received, total: received });
      return { ok: true, path: dest, bytes: received, source: url };
    } catch (e) {
      lastErr = String((e && e.message) || e).slice(0, 120);
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    }
  }
  return { ok: false, error: '下载失败: ' + (lastErr || '未知错误'), tried: urls };
}

/** 解析 ComfyUI 官方最新版本的 Windows 便携版资源。 */
async function resolveComfyRelease(variant = 'nvidia', deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  if (!fetchFn) return { ok: false, error: '当前环境不支持 fetch' };
  try {
    const r = await fetchFn(COMFY_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'feiyu-desktop' },
    });
    if (!r.ok) return { ok: false, error: 'GitHub API HTTP ' + r.status };
    const j = await r.json();
    const want = COMFY_ASSETS[variant] || COMFY_ASSETS.nvidia;
    const asset = (j.assets || []).find((a) => a.name === want);
    if (!asset) {
      return {
        ok: false,
        error: '该版本没有资源 ' + want,
        available: (j.assets || []).map((a) => a.name),
        tag: j.tag_name,
      };
    }
    return {
      ok: true,
      tag: j.tag_name,
      name: asset.name,
      size: asset.size,
      url: asset.browser_download_url,
      publishedAt: j.published_at,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 120) };
  }
}

/**
 * 下载并解压 ComfyUI Windows 便携版。
 * 解压用系统 bsdtar（Windows 10+ 自带 libarchive，支持 7z 读取）；
 * 不自带解压器，也不依赖 7-Zip 安装。
 */
async function installComfyUI(targetDir, variant = 'nvidia', deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  const onProgress = deps.onProgress || (() => {});
  const execFile = deps.execFile;
  if (!fetchFn) return { ok: false, error: '当前环境不支持 fetch' };
  if (!execFile) return { ok: false, error: '当前环境不支持执行外部命令' };

  const rel = await resolveComfyRelease(variant, deps);
  if (!rel.ok) return rel;
  if (rel.size && rel.size > MAX_DOWNLOAD_BYTES) return { ok: false, error: '安装包超出大小上限' };

  const dir = String(targetDir || '').trim();
  if (!dir) return { ok: false, error: '需要指定安装目录' };
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
    return { ok: false, error: '无法创建安装目录: ' + e.message };
  }
  const archive = path.join(dir, rel.name);
  if (!fs.existsSync(archive)) {
    onProgress({ phase: 'download', file: rel.name, received: 0, total: rel.size });
    try {
      const r = await fetchFn(rel.url, { redirect: 'follow' });
      if (!r.ok) return { ok: false, error: '下载 HTTP ' + r.status };
      const chunks = [];
      let received = 0;
      if (r.body && typeof r.body.getReader === 'function') {
        const reader = r.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          if (received > MAX_DOWNLOAD_BYTES) { try { await reader.cancel(); } catch (_) {} return { ok: false, error: '下载超出大小上限' }; }
          chunks.push(Buffer.from(value));
          onProgress({ phase: 'download', file: rel.name, received, total: rel.size });
        }
      } else {
        const buf = Buffer.from(await r.arrayBuffer());
        received = buf.length;
        chunks.push(buf);
      }
      fs.writeFileSync(archive, Buffer.concat(chunks));
    } catch (e) {
      return { ok: false, error: '下载失败: ' + String((e && e.message) || e).slice(0, 120) };
    }
  }

  onProgress({ phase: 'extract', file: rel.name });
  const extracted = await extractArchive(archive, dir, execFile);
  if (!extracted.ok) return extracted;

  const root = resolveComfyRoot(dir);
  return {
    ok: true,
    dir,
    root,
    archive,
    tag: rel.tag,
    size: rel.size,
    note: root ? '' : '已解压，但未在目录中找到 main.py（便携版通常解压出 ComfyUI_windows_portable 子目录）',
  };
}

/** 用系统 tar（bsdtar/libarchive）解压 7z。 */
function extractArchive(archive, destDir, execFile) {
  return new Promise((resolve) => {
    try {
      execFile('tar', ['-xf', archive, '-C', destDir], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            error: '解压失败: ' + String((stderr || err.message || '')).slice(0, 200),
            hint: '需要系统自带 tar（Windows 10+ 自带 bsdtar，支持 7z）；若被精简过请手动用 7-Zip 解压',
          });
          return;
        }
        resolve({ ok: true, extractedTo: destDir });
      });
    } catch (e) {
      resolve({ ok: false, error: '无法调用 tar: ' + e.message });
    }
  });
}

/** 取磁盘可用空间（字节）；取不到返回 null。 */
function freeSpace(dir) {
  try {
    // Node 18+ 有 fs.statfs（Windows 上部分版本可用）
    if (typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync(dir);
      return Number(st.bavail) * Number(st.bsize);
    }
  } catch (_) {}
  return null;
}

/**
 * 解析 ComfyUI 用的 Python 解释器路径。
 * Windows 便携版自带 python_embeded；找不到则回落 PATH 上的 python。
 * 纯函数（不依赖进程管理），便于单测。
 */
function resolvePython(root) {
  const r = resolveComfyRoot(root) || root;
  if (r) {
    const parent = path.dirname(r);
    const cands = [
      // Windows 便携版：python_embeded 通常在 ComfyUI 的同级目录
      path.join(parent, 'python_embeded', 'python.exe'),
      path.join(r, 'python_embeded', 'python.exe'),
      // 常见虚拟环境（git clone 用户 / 自建 venv）
      path.join(r, '.venv', 'Scripts', 'python.exe'),
      path.join(r, 'venv', 'Scripts', 'python.exe'),
      path.join(parent, '.venv', 'Scripts', 'python.exe'),
      path.join(parent, 'venv', 'Scripts', 'python.exe'),
    ];
    for (const c of cands) {
      try { if (fs.existsSync(c)) return c; } catch (_) {}
    }
  }
  return 'python';
}

/** 判断解释器是否便携版自带的 python_embeded（需要 -s / --windows-standalone-build）。 */
function isEmbeddedPython(py) {
  return /python_embeded/i.test(String(py || ''));
}

/**
 * 构造 ComfyUI 一键启动参数（供 processService.spawnDetached 使用）。
 * 纯函数：只算参数，不真正拉起进程。返回 {ok:true, spec} 或 {ok:false, error}。
 */
function launchSpec(root, opts = {}) {
  const r = resolveComfyRoot(root) || root;
  if (!r || !looksLikeComfyDir(r)) return { ok: false, error: '未找到 ComfyUI 安装目录（需含 main.py）' };
  const port = opts.port || DEFAULT_PORT;
  const py = resolvePython(r);
  const embedded = isEmbeddedPython(py);
  // 安装基目录：<ComfyUI_windows_portable>/ComfyUI 时基目录是父级；否则就是自身
  const base = path.basename(r).toLowerCase() === 'comfyui' ? path.dirname(r) : r;
  const dirOf = (name) => {
    // 优先安装基目录（与本机启动脚本一致），便携版再回落到 ComfyUI 子目录
    try { if (base !== r && fs.existsSync(path.join(base, name))) return path.join(base, name); } catch (_) {}
    try { if (fs.existsSync(path.join(r, name))) return path.join(r, name); } catch (_) {}
    try { if (fs.existsSync(path.join(base, name))) return path.join(base, name); } catch (_) {}
    return null;
  };
  // 不传 --listen：ComfyUI 默认只绑 127.0.0.1（与本机启动脚本一致，避免暴露到局域网）
  const args = [];
  if (embedded) args.push('-s');
  args.push('main.py', '--port', String(port), '--disable-auto-launch');
  if (embedded) args.push('--windows-standalone-build');
  const outDir = dirOf('output'); if (outDir) args.push('--output-directory', outDir);
  const inDir = dirOf('input'); if (inDir) args.push('--input-directory', inDir);
  const tmpDir = dirOf('temp'); if (tmpDir) args.push('--temp-directory', tmpDir);

  // 环境：屏蔽用户 PYTHONPATH；临时文件与模型缓存尽量落在安装盘（C 盘受限时必需）
  const env = { PYTHONPATH: '' };
  if (tmpDir) { env.TMP = tmpDir; env.TEMP = tmpDir; }
  const cache = path.join(base, 'cache');
  try {
    if (fs.existsSync(cache)) {
      env.HF_HOME = path.join(cache, 'huggingface');
      env.TORCH_HOME = path.join(cache, 'torch');
      env.TORCH_EXTENSIONS_DIR = path.join(cache, 'torch_extensions');
      env.CUDA_CACHE_PATH = path.join(cache, 'cuda');
    }
  } catch (_) {}
  return {
    ok: true,
    spec: {
      command: py,
      args,
      cwd: r,
      env,
    },
  };
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_ENDPOINT,
  COMFY_REPO,
  COMFY_ASSETS,
  MODEL_CATALOG,
  HF_BASES,
  MAX_DOWNLOAD_BYTES,
  MIN_FREE_BYTES,
  looksLikeComfyDir,
  resolveComfyRoot,
  candidateComfyDirs,
  detect,
  testConnection,
  listWorkflows,
  checkModels,
  checkPrerequisites,
  modelUrls,
  downloadModel,
  resolveComfyRelease,
  installComfyUI,
  extractArchive,
  freeSpace,
  resolvePython,
  launchSpec,
};
