'use strict';
/**
 * envDetector.js —— ComfyUI 运行环境检测中心（模块 C）。
 *
 * 铁律：**只读检测，绝不伪造数值**。
 *  - 每一项检测结果统一为 { value, status:'detected'|'unknown'|'missing', source, error }。
 *  - 探测失败一律 status='unknown' + error 原因，绝不填一个「看起来合理」的默认数值。
 *  - 只做只读动作：读目录结构、读文件大小；外部命令仅限固定参数的版本查询
 *    （nvidia-smi --query-gpu / python --version），不拼接任何用户输入。
 *
 * 依赖注入：runCommand / fs / statfs 均可替换，便于离线单测（默认返回 unknown）。
 */
const fs = require('fs');
const path = require('path');

/** 构造一项检测结果。 */
function item(value, status, source, error) {
  return { value: value == null ? null : value, status, source: source || null, error: error || null };
}
function unknown(source, error) { return item(null, 'unknown', source, error || '无法检测'); }
function detected(value, source) { return item(value, 'detected', source, null); }
function missing(source, error) { return item(null, 'missing', source, error || '未找到'); }

/** ComfyUI 目录结构（相对 root）。 */
const COMFY_MARKERS = {
  main: ['main.py'],
  entryBats: ['run_nvidia_gpu.bat', 'run_cpu.bat', 'run_amd_gpu.bat'],
  dirs: ['models', 'custom_nodes', 'input', 'output'],
  configs: ['extra_model_paths.yaml', 'extra_model_paths.yaml.example'],
};

/**
 * 检测一个目录是否是 ComfyUI 根（含 main.py 且含 models/ 或 custom_nodes/）。
 * 只读；不创建任何目录。
 */
function detectComfyRoot(dir, fsImpl = fs) {
  if (!dir) return missing('dir', '未指定目录');
  let st = null;
  try { st = fsImpl.statSync(dir); } catch (_) { return missing('dir', '目录不存在: 无法访问'); }
  if (!st.isDirectory()) return missing('dir', '不是一个目录');
  const hasMain = COMFY_MARKERS.main.some((f) => { try { return fsImpl.existsSync(path.join(dir, f)); } catch (_) { return false; } });
  if (!hasMain) return missing('structure', '目录中没有 main.py，可能不是 ComfyUI 根目录');
  const hasModels = COMFY_MARKERS.dirs.some((d) => { try { return fsImpl.existsSync(path.join(dir, d)); } catch (_) { return false; } });
  return detected({ root: dir, hasMain: true, hasModels, looksLikeComfyUI: true }, 'structure');
}

/** 扫描模型目录（只统计文件数量与体积，不读取模型内容）。 */
function scanModels(root, fsImpl = fs) {
  if (!root) return missing('models', '缺少 ComfyUI 根目录');
  const base = path.join(root, 'models');
  let entries = [];
  try { entries = fsImpl.readdirSync(base, { withFileTypes: true }); } catch (_) { return missing('models', '未找到 models 目录'); }
  const groups = [];
  let totalFiles = 0;
  let totalBytes = 0;
  for (const e of entries) {
    if (!e.isDirectory || !e.isDirectory()) continue;
    const sub = path.join(base, e.name);
    let files = [];
    try { files = fsImpl.readdirSync(sub, { withFileTypes: true }); } catch (_) { continue; }
    let bytes = 0;
    let count = 0;
    for (const f of files) {
      if (!f.isFile || !f.isFile()) continue;
      count++;
      try { bytes += fsImpl.statSync(path.join(sub, f.name)).size; } catch (_) { /* 单文件读取失败忽略 */ }
    }
    totalFiles += count;
    totalBytes += bytes;
    if (count) groups.push({ name: e.name, files: count, bytes });
  }
  if (!groups.length) return detected({ groups: [], totalFiles: 0, totalBytes: 0, empty: true }, 'models');
  return detected({ groups: groups.sort((a, b) => b.bytes - a.bytes), totalFiles, totalBytes, empty: false }, 'models');
}

/** 磁盘可用空间（fs.statfs 可用时；否则 unknown，绝不编造）。 */
function detectDiskSpace(dir, opts = {}) {
  // 显式传 statfs:null 表示「强制视为不支持」，便于测试与环境降级；
  // 未传时才回退到 fs.statfs。
  const statfs = ('statfs' in opts) ? opts.statfs : (fs.statfs ? fs.statfs.bind(fs) : null);
  if (!statfs) return unknown('statfs', '当前 Node/平台不支持 statfs，无法给出准确剩余空间');
  const target = dir || process.cwd();
  return new Promise((resolve) => {
    try {
      statfs(target, (err, st) => {
        if (err || !st) return resolve(unknown('statfs', '读取失败: ' + ((err && err.message) || '未知')));
        const bsize = Number(st.bsize || st.bsize === 0 ? st.bsize : 0) || 0;
        const blocks = Number(st.blocks) || 0;
        const bfree = Number(st.bfree) || 0;
        if (!bsize || !blocks) return resolve(unknown('statfs', 'statfs 返回的数据不可用'));
        const totalBytes = bsize * blocks;
        const freeBytes = bsize * bfree;
        resolve(detected({ totalBytes, freeBytes, totalGB: +(totalBytes / 1024 ** 3).toFixed(1), freeGB: +(freeBytes / 1024 ** 3).toFixed(1) }, 'statfs'));
      });
    } catch (e) { resolve(unknown('statfs', e.message)); }
  });
}

/**
 * 运行固定参数的外部命令取版本信息。
 * runCommand 签名：(cmd, args) => Promise<{ok, stdout, stderr, error}>；默认不执行（返回 unknown）。
 */
async function runFixed(runCommand, cmd, args, source) {
  if (typeof runCommand !== 'function') return unknown(source, '未启用外部命令探测');
  try {
    const r = await runCommand(cmd, args);
    if (!r || !r.ok) return unknown(source, (r && r.error) || '命令执行失败');
    return detected(String(r.stdout || '').trim(), source);
  } catch (e) { return unknown(source, e.message); }
}

/** GPU：nvidia-smi 固定查询；失败即 unknown。 */
async function detectGpu(opts = {}) {
  const r = await runFixed(opts.runCommand, 'nvidia-smi',
    ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], 'nvidia-smi');
  if (r.status !== 'detected') {
    return {
      available: r,
      gpus: unknown('nvidia-smi', r.error),
      note: '未检测到 NVIDIA GPU 或未安装驱动；这不代表不能运行 ComfyUI（CPU 亦可，但很慢）',
    };
  }
  const lines = String(r.value).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const gpus = [];
  for (const line of lines) {
    const parts = line.split(',').map((x) => x.trim());
    if (!parts[0]) continue;
    gpus.push({
      name: parts[0],
      vramTotalMB: parts[1] && /^\d+$/.test(parts[1]) ? Number(parts[1]) : null,
      driver: parts[2] || null,
    });
  }
  if (!gpus.length) return { available: detected(true, 'nvidia-smi'), gpus: unknown('nvidia-smi', '命令成功但没有返回任何 GPU 行'), note: null };
  return { available: detected(true, 'nvidia-smi'), gpus: detected(gpus, 'nvidia-smi'), note: null };
}

/** Python 版本：python 与 python3 都试，取第一个成功的。 */
async function detectPython(opts = {}) {
  const a = await runFixed(opts.runCommand, 'python', ['--version'], 'python');
  if (a.status === 'detected') return a;
  const b = await runFixed(opts.runCommand, 'python3', ['--version'], 'python3');
  return b.status === 'detected' ? b : unknown('python', 'python / python3 均不可用: ' + (a.error || '') + (b.error ? '；' + b.error : ''));
}

/**
 * 汇总环境检测。
 * @param opts { dir, runCommand, fsImpl, statfs, now }
 */
async function detectEnvironment(opts = {}) {
  const fsImpl = opts.fsImpl || fs;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const dir = opts.dir || '';
  const rootRes = dir ? detectComfyRoot(dir, fsImpl) : missing('dir', '未指定 ComfyUI 目录');
  const root = rootRes.status === 'detected' ? rootRes.value.root : '';

  const [gpu, python, disk] = await Promise.all([
    detectGpu(opts),
    detectPython(opts),
    detectDiskSpace(root || dir || undefined, opts),
  ]);

  const models = root ? scanModels(root, fsImpl) : missing('models', '缺少 ComfyUI 根目录');
  const entryBats = root ? COMFY_MARKERS.entryBats.filter((f) => { try { return fsImpl.existsSync(path.join(root, f)); } catch (_) { return false; } }) : [];

  const checks = [];
  checks.push({ id: 'comfy_root', label: 'ComfyUI 目录', status: rootRes.status, detail: rootRes.status === 'detected' ? '已找到 main.py' : rootRes.error });
  checks.push({ id: 'gpu', label: 'NVIDIA GPU', status: gpu.gpus.status === 'detected' ? 'detected' : 'unknown', detail: gpu.gpus.status === 'detected' ? (gpu.gpus.value.length + ' 块') : gpu.gpus.error });
  checks.push({ id: 'python', label: 'Python', status: python.status, detail: python.status === 'detected' ? python.value : python.error });
  checks.push({ id: 'disk', label: '磁盘剩余空间', status: disk.status, detail: disk.status === 'detected' ? (disk.value.freeGB + ' GB 可用 / ' + disk.value.totalGB + ' GB') : disk.error });
  checks.push({ id: 'models', label: '模型文件', status: models.status, detail: models.status === 'detected' ? (models.value.totalFiles + ' 个文件 / ' + (models.value.totalBytes / 1024 ** 3).toFixed(2) + ' GB') : models.error });
  checks.push({ id: 'entry', label: '启动脚本', status: entryBats.length ? 'detected' : 'missing', detail: entryBats.length ? entryBats.join('、') : '未找到 run_*.bat（可手动用 python main.py 启动）' });

  const blocking = checks.filter((c) => c.id === 'comfy_root' && c.status !== 'detected').length > 0;
  return {
    ok: true,
    generatedAt: now.toISOString(),
    dir: dir || null,
    root: root || null,
    checks,
    detail: { gpu, python, disk, models, entryBats },
    ready: !blocking,
    note: '所有 unknown 表示「未能检测」，不代表「不存在」；本页不做任何安装或修改。',
  };
}

module.exports = {
  COMFY_MARKERS,
  item, unknown, detected, missing,
  detectComfyRoot, scanModels, detectDiskSpace, detectGpu, detectPython, detectEnvironment,
};
