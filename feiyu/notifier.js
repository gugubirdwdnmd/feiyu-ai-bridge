'use strict';
// ================= 主动通知（阶段 D·文字） =================
// 只向配置指定主人 QQ 发送；队列持久化、可重启恢复；去重、频率限制、静默时段、失败重试队列。
// 不依赖真实 QQ 发送：发送动作由外部注入的 send(target, text) 完成，便于离线测试（注入 mock sender）。

const crypto = require('crypto');
const { JsonStore, nowMs } = require('./task_store');

function _hmNum(d) { return d.getHours() * 60 + d.getMinutes(); }
function _toNum(hm) { const m = /^(\d{1,2}):(\d{2})$/.exec(hm || ''); if (!m) return null; return Number(m[1]) * 60 + Number(m[2]); }

class Notifier {
  /**
   * @param {object} opts { storeFile, send:(target,text)=>Promise, config }
   */
  constructor(opts) {
    opts = opts || {};
    this.store = new JsonStore(opts.storeFile || 'memory://notify', { maxItems: 200 });
    this.send = typeof opts.send === 'function' ? opts.send : null;
    this.cfg = Object.assign({
      enabled: false,            // 默认关闭
      rateLimitPerTarget: 10,   // 每目标每分钟上限
      rateWindowMs: 60000,
      quietHours: null,         // {start:'22:00', end:'08:00'} 本地时间（end<start 表示跨午夜）
      dedupWindowMs: 5 * 60 * 1000,
      maxRetries: 3,
      retryBaseMs: 30000,
      targets: [],
    }, opts.config || {});
    this._rate = new Map();     // target -> [timestamp]
  }

  _dedupKey(kind, text) {
    return crypto.createHash('sha1').update(String(kind) + '|' + String(text)).digest('hex').slice(0, 16);
  }
  _inQuiet(now) {
    const q = this.cfg.quietHours; if (!q || !q.start || !q.end) return false;
    const cur = _hmNum(new Date(now)); const s = _toNum(q.start); const e = _toNum(q.end);
    if (s == null || e == null || s === e) return false;
    if (s < e) return cur >= s && cur <= e;
    return cur >= s || cur <= e; // 跨午夜
  }
  _rateOk(target, now) {
    const arr = (this._rate.get(target) || []).filter((t) => now - t <= this.cfg.rateWindowMs);
    this._rate.set(target, arr);
    if (arr.length >= this.cfg.rateLimitPerTarget) return false;
    arr.push(now); return true;
  }

  /**
   * 入队一条通知。
   * @param {string|string[]} target 目标 QQ（空则使用 cfg.targets）
   * @param {string} kind 类型（task_start/task_done/task_fail/summary...）
   * @param {string} text 内容
   * @param {{urgent?:boolean}} [o]
   */
  enqueue(target, kind, text, o) {
    o = o || {};
    if (!this.cfg.enabled) return { ok: false, reason: 'disabled' };
    const tgs = target ? [String(target)] : (this.cfg.targets || []);
    if (!tgs.length) return { ok: false, reason: 'no-target' };
    const now = nowMs();
    const results = [];
    for (const tg of tgs) {
      const key = this._dedupKey(kind, text);
      const recent = this.store.filter((n) => n.key === key && (now - (n.lastSentAt || 0)) < this.cfg.dedupWindowMs && n.status === 'sent');
      if (recent.length) { results.push({ target: tg, skipped: 'dedup' }); continue; }
      const item = {
        id: (crypto.randomUUID ? crypto.randomUUID() : 'n_' + now + '_' + Math.random().toString(36).slice(2)),
        target: tg, kind: String(kind || 'info'), text: String(text || '').slice(0, 4000),
        key, status: 'pending', createdAt: now, lastSentAt: null, retries: 0,
        quietDefer: (this._inQuiet(now) && !o.urgent),
      };
      this.store.set(item);
      results.push({ target: tg, id: item.id });
    }
    this._persist();
    return { ok: true, results };
  }

  /** 发送待发队列（由每分钟循环调用）。返回 {sent,failed,deferred}。 */
  async flush() {
    if (!this.send) return { sent: 0, failed: 0, deferred: 0 };
    const now = nowMs();
    let sent = 0, failed = 0, deferred = 0;
    for (const n of this.store.list()) {
      if (n.status !== 'pending') continue;
      if (n.quietDefer && this._inQuiet(now)) { deferred++; continue; }
      if (!this._rateOk(n.target, now)) { deferred++; continue; }
      try {
        await this.send(n.target, n.text);
        n.status = 'sent'; n.lastSentAt = now; n.sentAt = now; sent++;
      } catch (e) {
        n.retries = (n.retries || 0) + 1;
        if (n.retries >= this.cfg.maxRetries) { n.status = 'dead'; n.error = String((e && e.message) || e).slice(0, 200); failed++; }
        else n.nextRetryAt = now + this.cfg.retryBaseMs * n.retries;
      }
    }
    this._persist();
    this._cleanup();
    return { sent, failed, deferred };
  }

  _cleanup() {
    const now = nowMs();
    for (const n of this.store.list()) {
      if (n.status === 'sent' && (now - (n.sentAt || 0) > 24 * 3600 * 1000)) this.store.remove(n.id);
      else if (n.status === 'dead') this.store.remove(n.id);
    }
  }
  _persist() { if (this.store.file && this.store.file !== 'memory://notify') { try { this.store.save(); } catch (e) {} } }
  queue() { return this.store.list(); }
  setTargets(arr) { this.cfg.targets = Array.isArray(arr) ? arr : []; }
  setEnabled(on) { this.cfg.enabled = !!on; }
}

module.exports = { Notifier };
