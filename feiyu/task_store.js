'use strict';
// ================= 通用 JSON 持久化存储 =================
// 设计：内存 Map 索引 + 原子落盘（临时文件写后 rename，避免半截文件）。
// 容量上限与轮转：超过 maxItems 时丢弃最旧条目（按 storedAt）。
// 不依赖任何第三方库，仅用 Node 内置 fs/path。

const fs = require('fs');
const path = require('path');

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
  }

  load() {
    if (this._loaded) return this.map;
    try {
      const raw = fs.readFileSync(this.file, 'utf-8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const it of arr) if (it && it.id) this.map.set(String(it.id), it);
      }
    } catch (e) {
      // 文件不存在或已损坏：从空开始（不抛，保证安全启动）
    }
    this._loaded = true;
    return this.map;
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

  /** 原子落盘：先写 .tmp 再 rename。返回写入条目数。 */
  save() {
    this.load();
    const arr = this.list();
    const t = nowMs();
    for (const it of arr) if (!it.storedAt) it.storedAt = t;
    const dir = path.dirname(this.file);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr));
    fs.renameSync(tmp, this.file); // 同文件系统下原子替换
    return arr.length;
  }
}

module.exports = { JsonStore, nowMs };
