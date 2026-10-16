'use strict';
// ================= 通用 JSON 持久化存储 =================
// 设计：内存 Map 索引 + 原子落盘（临时文件写后 rename，避免半截文件）。
// 容量上限与轮转：超过 maxItems 时丢弃最旧条目（按 storedAt）。
// 错误区分：文件不存在（可安全从空开始）、JSON 损坏（SyntaxError）、未知格式（非数组）。
//   损坏或未知格式时【绝不静默当作空并覆盖原文件】，而是保留原文件副本（.corrupt-<ts>）后再从空启动。
// 不依赖任何第三方库，仅用 Node 内置 fs/path/crypto。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function nowMs() { return Date.now(); }

class JsonStore {
  /**
   * @param {string} file 持久化文件路径
   * @param {{maxItems?:number, maxBytes?:number}} [opts]
   */
  constructor(file, opts) {
    this.file = file;
    this.opts = Object.assign({ maxItems: 1000, maxBytes: 8 * 1024 * 1024 }, opts || {});
    /** @type {Map<string, any>} */
    this.map = new Map();
    this._loaded = false;
    // 加载诊断状态（供测试与运维排查，不影响正常流程）
    this._loadError = null;      // 'enoent' | 'corrupt' | 'format' | null
    this._lastError = null;      // 原始 Error 对象（若发生）
    this._corruptBackup = null;  // 损坏时保留的原文件副本路径
  }

  /**
   * 加载持久化数据。
   * - ENOENT：文件不存在，安全从空 Map 开始（无需报警）。
   * - SyntaxError（JSON.parse 失败）：视为损坏，保留原文件副本后从空开始。
   * - 非数组 / 顶层非对象：视为未知格式，保留原文件副本后从空开始。
   * 任何其它异常：保留原文件副本后从空开始，避免半截覆盖导致数据丢失。
   */
  load() {
    if (this._loaded) return this.map;
    try {
      const raw = fs.readFileSync(this.file, 'utf-8');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr) {
        // JSON 损坏：保留原文件，绝不当空覆盖
        this._preserveCorrupt(raw, 'corrupt');
        this._loadError = 'corrupt';
        this._lastError = parseErr;
        this._loaded = true;
        return this.map; // 从空开始，但原数据已备份
      }
      if (!Array.isArray(parsed)) {
        // 未知格式：保留原文件（可能是旧结构），不当作空覆盖
        this._preserveCorrupt(raw, 'format');
        this._loadError = 'format';
        this._lastError = new Error('JsonStore.load: 顶层应为数组，实际为 ' + (parsed === null ? 'null' : typeof parsed));
        this._loaded = true;
        return this.map;
      }
      for (const it of parsed) if (it && it.id) this.map.set(String(it.id), it);
      this._loadError = null;
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        // 文件不存在：安全从空开始，这不是错误
        this._loadError = 'enoent';
      } else {
        // 其它读取错误（权限等）：保留原文件副本（若可读）后从空开始
        try {
          const raw = fs.readFileSync(this.file, 'utf-8');
          this._preserveCorrupt(raw, 'format');
        } catch (_) {}
        this._loadError = 'format';
        this._lastError = e;
      }
    }
    this._loaded = true;
    return this.map;
  }

  /**
   * 将损坏/未知格式的原数据保留为副本，避免静默丢失。
   * 副本命名：<file>.corrupt-<ISO时间戳>-<随机hex>
   * 若副本写入失败（磁盘满等），记录到 _lastError 但不影响从空启动。
   */
  _preserveCorrupt(raw, kind) {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const rand = crypto.randomBytes(4).toString('hex');
      const backup = this.file + '.corrupt-' + ts + '-' + rand;
      fs.writeFileSync(backup, raw);
      this._corruptBackup = backup;
      this._corruptKind = kind;
    } catch (e) {
      this._lastError = e;
      // 副本失败也不抛，从空启动优先
    }
  }

  get(id) { this.load(); return this.map.get(String(id)) || null; }
  list() { this.load(); return Array.from(this.map.values()); }
  filter(fn) { this.load(); return this.list().filter(fn); }

  set(item) {
    if (!item || !item.id) throw new Error('JsonStore.set: item 必须有 id');
    this.load();
    this.map.set(String(item.id), item);
    this._maybeRotate();
    return item;
  }
  upsert(item) { return this.set(item); }
  remove(id) { this.load(); return this.map.delete(String(id)); }

  _maybeRotate() {
    const max = Number(this.opts.maxItems) || 1000;
    if (this.map.size > max) {
      const entries = Array.from(this.map.entries());
      entries.sort((a, b) => (a[1].storedAt || 0) - (b[1].storedAt || 0));
      const drop = this.map.size - max;
      for (let i = 0; i < drop; i++) this.map.delete(entries[i][0]);
    }
  }

  /**
   * 原子落盘：先写带 pid+随机 的临时文件，再 rename 原子替换。
   * - 临时文件命名包含进程 pid 与随机串，避免并发/重入时的冲突与残留。
   * - 写临时文件失败：清理 tmp 并向上抛（调用方感知写入失败，不残留半截文件）。
   * - rename 失败：清理 tmp，保留原文件不变，向上抛。
   * 返回写入条目数。
   */
  save() {
    this.load();
    const arr = this.list();
    const t = nowMs();
    for (const it of arr) if (!it.storedAt) it.storedAt = t;
    const dir = path.dirname(this.file);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    const rand = crypto.randomBytes(6).toString('hex');
    const tmp = this.file + '.tmp-' + process.pid + '-' + rand;
    try {
      fs.writeFileSync(tmp, JSON.stringify(arr));
      fs.renameSync(tmp, this.file); // 同文件系统下原子替换
    } catch (e) {
      // 失败恢复：尽力清理可能的残留临时文件，保留原文件
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
      this._lastError = e;
      throw e;
    }
    return arr.length;
  }

  // ---------- 诊断接口 ----------
  /** 最近一次加载是否为损坏/未知格式导致的空启动 */
  isCorrupt() { return this._loadError === 'corrupt' || this._loadError === 'format'; }
  /** 返回加载错误类型：'enoent' | 'corrupt' | 'format' | null */
  loadError() { return this._loadError; }
  /** 若加载时保留了原文件副本，返回其路径，否则 null */
  corruptBackup() { return this._corruptBackup || null; }
  /** 最近一次原始错误对象（若有） */
  lastError() { return this._lastError; }
}

module.exports = { JsonStore, nowMs };
