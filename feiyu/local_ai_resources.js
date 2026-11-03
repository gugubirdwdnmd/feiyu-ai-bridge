'use strict';

/**
 * local_ai_resources.js —— 本地 AI 资源管理器（多模态理解的"算力调度"底座）。
 *
 * 设计原则（与项目安全/降级基调一致）：
 *   1. 默认本地优先：本模块只负责"探测 + 预算 + 并发"，**不自动下载/拉起任何大模型**。
 *      真实模型由用户自行安装的本地推理服务（如 Qwen2.5-VL / faster-whisper / PaddleOCR
 *      的 OpenAI 兼容端点）提供；本模块只记录它们的"声明显存占用"并做准入控制。
 *   2. 不默认并发加载多模型：默认 maxConcurrent=1，且同一时刻只允许声明不超过 vramBudgetMB
 *      的显存占用；超出则拒绝加载（真实降级），绝不偷偷多开拖垮机器。
 *   3. 探测失败一律降级：nvidia-smi 不存在/超时 → 标记 gpu.available=false，回退到 CPU/RAM 信息，
 *      不抛错、不假装有 GPU。
 *   4. 所有外部命令经 execFile 数组参数（不经 shell），杜绝参数注入；nvidia-smi 仅用只读查询参数。
 *
 * 该模块被 media_understanding.js 持有，并在桌面端多模态 UI 的"资源监控"里展示。
 */

const os = require('os');
const { execFile } = require('child_process');

// 默认显存预算（MB）。默认 0 表示"未配置本地 GPU 模型预算"——
// 此时只允许 GPU 模型在用户显式登记预算后才可加载，避免无脑占满。
const DEFAULTS = {
  vramBudgetMB: 0,            // 0 = 未配置；>0 后才有准入意义
  maxConcurrent: 1,           // 默认不并发多模型
  nvidiaSmiTimeoutMs: 2500,
  // 显存余量低于该比例时进入降级（建议切云端/降分辨率）
  lowVramRatio: 0.15,
  // 监测采样间隔（桌面端轮询用，不在此模块内驱动）
};

function num(v, d, min) {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return min != null ? Math.max(min, n) : n;
}

function mb(bytes) { return Math.round(Number(bytes) / (1024 * 1024)); }

/**
 * @param {object} [opts]
 *   - execFileImpl(fn)    测试可注入
 *   - osImpl(obj)         测试可注入 {totalmem,freemem,cpus,platform,arch}
 *   - nowImpl(fn)
 */
function createLocalAIResourceManager(opts) {
  opts = opts || {};
  const execFileImpl = typeof opts.execFileImpl === 'function' ? opts.execFileImpl : execFile;
  const osImpl = opts.osImpl || os;
  const now = typeof opts.nowImpl === 'function' ? opts.nowImpl : () => Date.now();

  const cfg = Object.assign({}, DEFAULTS, opts.config || {});
  // 已加载模型：id -> { id, kind, estimatedVRAMMB, endpoint, loadedAt }
  const loaded = new Map();
  let activeSlots = 0;

  // ---------- 探测 ----------
  function probeGPU() {
    return new Promise((resolve) => {
      // 仅 Windows/Linux 上 nvidia-smi 有意义；其余平台直接降级
      const platform = String(osImpl.platform && osImpl.platform() || '').toLowerCase();
      if (platform === 'darwin') {
        // Apple Silicon 走 Metal；这里不假装能读显存，如实标记
        return resolve({ available: false, reason: 'apple-silicon-no-nvidia-smi', memUsedMB: 0, memTotalMB: 0, memFreeMB: 0, name: 'Apple GPU', nvidiaSmiAvailable: false });
      }
      let done = false;
      const finish = (r) => { if (!done) { done = true; resolve(r); } };
      const t = setTimeout(() => finish({ available: false, reason: 'timeout', memUsedMB: 0, memTotalMB: 0, memFreeMB: 0, name: null, nvidiaSmiAvailable: false }), cfg.nvidiaSmiTimeoutMs);
      try {
        execFileImpl('nvidia-smi', ['--query-gpu=name,memory.used,memory.total', '--format=csv,noheader,nounits'],
          { timeout: cfg.nvidiaSmiTimeoutMs, maxBuffer: 64 * 1024 },
          (err, stdout) => {
            clearTimeout(t);
            if (err) return finish({ available: false, reason: String(err.message || err).slice(0, 80), memUsedMB: 0, memTotalMB: 0, memFreeMB: 0, name: null, nvidiaSmiAvailable: false });
            const line = String(stdout || '').trim().split('\n')[0] || '';
            const parts = line.split(',').map((s) => s.trim());
            if (parts.length < 3) return finish({ available: false, reason: 'unexpected-output', memUsedMB: 0, memTotalMB: 0, memFreeMB: 0, name: null, nvidiaSmiAvailable: true });
            const name = parts[0];
            const used = num(parts[1], 0, 0);
            const total = num(parts[2], 0, 0);
            finish({
              available: total > 0,
              name,
              memUsedMB: used,
              memTotalMB: total,
              memFreeMB: Math.max(0, total - used),
              nvidiaSmiAvailable: true,
            });
          });
      } catch (e) {
        clearTimeout(t);
        finish({ available: false, reason: String(e && e.message || e).slice(0, 80), memUsedMB: 0, memTotalMB: 0, memFreeMB: 0, name: null, nvidiaSmiAvailable: false });
      }
    });
  }

  function probeHost() {
    const totalMem = osImpl.totalmem ? osImpl.totalmem() : 0;
    const freeMem = osImpl.freemem ? osImpl.freemem() : 0;
    const cpus = (osImpl.cpus ? osImpl.cpus() : []) || [];
    const model = cpus.length ? (cpus[0].model || 'unknown') : 'unknown';
    return {
      platform: String(osImpl.platform ? osImpl.platform() : ''),
      arch: String(osImpl.arch ? osImpl.arch() : ''),
      cpu: { cores: cpus.length, model },
      ram: { totalMB: mb(totalMem), freeMB: mb(freeMem), usedMB: mb(Math.max(0, totalMem - freeMem)) },
    };
  }

  /** 完整资源快照（GPU 探测为异步，需 await）。 */
  async function snapshot() {
    const gpu = await probeGPU();
    const host = probeHost();
    let degraded = false;
    let degradedReason = '';
    if (gpu.available && gpu.memTotalMB > 0) {
      const freeRatio = gpu.memFreeMB / gpu.memTotalMB;
      if (freeRatio < cfg.lowVramRatio) { degraded = true; degradedReason = 'low-vram'; }
    }
    // 已登记模型占用的显存
    let reservedVRAMMB = 0;
    for (const m of loaded.values()) reservedVRAMMB += num(m.estimatedVRAMMB, 0, 0);
    return {
      timestamp: now(),
      gpu,
      cpu: host.cpu,
      ram: host.ram,
      platform: host.platform,
      arch: host.arch,
      models: Array.from(loaded.values()).map((m) => ({ id: m.id, kind: m.kind, estimatedVRAMMB: m.estimatedVRAMMB, endpoint: m.endpoint, loadedAt: m.loadedAt })),
      reservedVRAMMB,
      budget: { vramBudgetMB: cfg.vramBudgetMB, maxConcurrent: cfg.maxConcurrent },
      activeSlots,
      degraded,
      degradedReason,
    };
  }

  // ---------- 模型准入（加载/卸载）----------
  /**
   * 登记并"加载"一个本地模型（语义层：仅做预算准入与并发记账，不真正拉起进程）。
   * @returns {{ok:boolean, reason?:string, model?:object}}
   *   reason: 'budget-exceeded' | 'concurrency-exceeded' | 'already-loaded' | 'no-budget'
   */
  function claim(model) {
    model = model || {};
    const id = String(model.id || model.endpoint || '').trim();
    if (!id) return { ok: false, reason: 'missing-id' };
    if (loaded.has(id)) return { ok: false, reason: 'already-loaded', model: loaded.get(id) };

    const est = num(model.estimatedVRAMMB, 0, 0);
    // 预算准入：未配置预算(=0)时，仅允许 0 显存占用的模型（CPU 模型）登记；
    // 配置了预算则累计不得超过。
    if (cfg.vramBudgetMB > 0) {
      let reserved = 0;
      for (const m of loaded.values()) reserved += num(m.estimatedVRAMMB, 0, 0);
      if (reserved + est > cfg.vramBudgetMB) {
        return { ok: false, reason: 'budget-exceeded', reservedVRAMMB: reserved, budgetMB: cfg.vramBudgetMB };
      }
    } else if (est > 0) {
      return { ok: false, reason: 'no-budget', note: '请先在多模态设置里配置显存预算(vramBudgetMB)后再加载 GPU 模型' };
    }
    if (activeSlots >= cfg.maxConcurrent) {
      return { ok: false, reason: 'concurrency-exceeded', activeSlots, maxConcurrent: cfg.maxConcurrent };
    }
    const rec = {
      id,
      kind: String(model.kind || 'unknown'),
      estimatedVRAMMB: est,
      endpoint: String(model.endpoint || ''),
      loadedAt: now(),
    };
    loaded.set(id, rec);
    activeSlots++;
    return { ok: true, model: rec };
  }

  /** 卸载一个模型（释放预算/并发槽）。 */
  function release(id) {
    const k = String(id || '').trim();
    if (!loaded.has(k)) return { ok: false, reason: 'not-loaded' };
    loaded.delete(k);
    activeSlots = Math.max(0, activeSlots - 1);
    return { ok: true };
  }

  function getModel(id) { return loaded.get(String(id || '').trim()) || null; }

  // ---------- 并发槽 ----------
  /** 获取一个并发执行槽（用于限制同时进行的媒体任务）。 */
  function acquireSlot() {
    if (activeSlots >= cfg.maxConcurrent) return false;
    activeSlots++;
    return true;
  }
  function releaseSlot() { activeSlots = Math.max(0, activeSlots - 1); }

  // ---------- 配置 ----------
  function setConfig(c) {
    if (!c || typeof c !== 'object') return cfg;
    if (c.vramBudgetMB != null) cfg.vramBudgetMB = num(c.vramBudgetMB, 0, 0);
    if (c.maxConcurrent != null) cfg.maxConcurrent = Math.max(1, Math.floor(num(c.maxConcurrent, 1, 1)));
    if (c.lowVramRatio != null) cfg.lowVramRatio = Math.min(0.9, Math.max(0.01, num(c.lowVramRatio, 0.15, 0.01)));
    return cfg;
  }

  /** 默认策略说明（如实呈现给用户/测试）。 */
  function policy() {
    return {
      vramBudgetMB: cfg.vramBudgetMB,
      maxConcurrent: cfg.maxConcurrent,
      loadsMultipleModelsByDefault: false,
      autoDownloadsModels: false,
      lowVramRatio: cfg.lowVramRatio,
    };
  }

  return {
    snapshot, probeGPU, probeHost,
    claim, release, getModel,
    acquireSlot, releaseSlot,
    setConfig, policy,
    _loaded: loaded, // 仅测试用
  };
}

module.exports = { createLocalAIResourceManager, DEFAULTS };
