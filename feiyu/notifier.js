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
    this._now = (typeof opts.clock === 'function') ? opts.clock : nowMs;  // 可注入时钟，便于确定性测试（不靠真实等待掩盖时序）
    this.cfg = Object.assign({
      enabled: false,            // 默认关闭
      rateLimitPerTarget: 10,   // 每目标每分钟上限
      rateWindowMs: 60000,
      quietHours: null,         // {start:'22:00', end:'08:00'} 本地时间（end<start 表示跨午夜）
      dedupWindowMs: 5 * 60 * 1000,
      maxRetries: 3,
      retryBaseMs: 30000,
      maxQueue: 500,            // 待发队列容量上限（超出则丢弃最旧 pending，防止无限膨胀）
      sentRetentionMs: 24 * 3600 * 1000,  // sent 记录保留时长
      deadRetentionMs: 7 * 24 * 3600 * 1000, // 失败(dead)记录有限期保留后清理
      targets: [],
    }, opts.config || {});
    // 兼容别名：quietStart/quietEnd → quietHours；maxPerTargetPerHour → rateLimitPerTarget
    const c = opts.config || {};
    if (!this.cfg.quietHours && (c.quietStart || c.quietEnd)) this.cfg.quietHours = { start: c.quietStart, end: c.quietEnd };
    if (!this.cfg.rateLimitPerTarget && c.maxPerTargetPerHour) this.cfg.rateLimitPerTarget = Number(c.maxPerTargetPerHour);
    // 授权收件人白名单（要求④，模块内部强制，不依赖上层调用者是否管理员）：
    // 仅允许向明确配置的主人 QQ / 授权名单发送；其余 target 一律在模块内拒绝。
    const configuredTargets = (c.allowedTargets && Array.isArray(c.allowedTargets)) ? c.allowedTargets
      : (Array.isArray(this.cfg.targets) ? this.cfg.targets : []);
    this.cfg.allowedTargets = configuredTargets.map(String);
    this._rate = new Map();     // target -> [timestamp]
    this._flushing = false;     // 防重入锁：避免并发/重叠调用重复处理同一条
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

  /** 授权收件人白名单（模块内部强制）。默认 = cfg.targets（即配置的主人 QQ / 授权名单）。 */
  _allowedTargets() {
    const base = Array.isArray(this.cfg.allowedTargets) ? this.cfg.allowedTargets : (this.cfg.targets || []);
    return base.map(String);
  }

  /**
   * 入队一条通知。
   * @param {string|null} target 目标 QQ（空则使用 cfg.targets）
   *   目标限制（要求④）：传入的 target 必须是配置白名单（主人 QQ / 授权名单）内的合法 QQ 号，
   *   否则在模块内部直接拒绝（target-invalid / target-not-allowed），不依赖上层调用者是否管理员。
   * @param {string} kind 类型（task_start/task_done/task_fail/summary...）
   * @param {string} text 内容
   * @param {{urgent?:boolean}} [o]
   */
  enqueue(target, kind, text, o) {
    o = o || {};
    if (!this.cfg.enabled) return { ok: false, reason: 'disabled' };
    // —— 目标限制（模块内部强制，纵深防御；不依赖上层 admin 检查）——
    let tgs;
    if (target != null && target !== '') {
      const tg = String(target).trim();
      // 基本格式：5~15 位纯数字 QQ 号（拒绝任意字符串注入）
      if (!/^\d{5,15}$/.test(tg)) return { ok: false, reason: 'target-invalid' };
      if (this._allowedTargets().indexOf(tg) < 0) return { ok: false, reason: 'target-not-allowed' };
      tgs = [tg];
    } else {
      // 未指定 target：仅向配置的主人列表发送，且必须再与授权白名单求交集
      // （V15.1：此前直接用 cfg.targets，若 allowedTargets 配置得更窄则会被绕过）
      const allow = this._allowedTargets();
      tgs = (this.cfg.targets || []).map(String).filter((x) => allow.indexOf(x) >= 0);
    }
    if (!tgs.length) return { ok: false, reason: 'no-target' };
    const now = this._now();
    const results = [];
    for (const tg of tgs) {
      const key = this._dedupKey(kind, text);
      const recent = this.store.filter((n) => n.key === key && (now - (n.lastSentAt || 0)) < this.cfg.dedupWindowMs && n.status === 'sent');
      if (recent.length) { results.push({ target: tg, skipped: 'dedup' }); continue; }
      // 容量限制：超出 maxQueue 则丢弃最旧 pending
      this._enforceCapacity();
      const item = {
        id: (crypto.randomUUID ? crypto.randomUUID() : 'n_' + now + '_' + Math.random().toString(36).slice(2)),
        target: tg, kind: String(kind || 'info'), text: String(text || '').slice(0, 4000),
        key, status: 'pending', createdAt: now, lastSentAt: null, retries: 0,
        nextRetryAt: null, quietDefer: (this._inQuiet(now) && !o.urgent),
      };
      this.store.set(item);
      results.push({ target: tg, id: item.id });
    }
    this._persist();
    return { ok: true, results };
  }

  /** 发送待发队列（由每分钟循环调用）。返回 {sent,failed,deferred,skipped}。
   *  V15 修正（要求④）：
   *   - 防重入：并发/重叠调用时仅第一个真正处理，其余立即返回（避免重复处理同一条）；
   *   - 重试时间窗：pending 但 nextRetryAt 在未来时跳过本轮（deferred），不提前重试；
   *   - 队列容量：enqueue 时限制总量；
   *   - 失败记录有限期保留（deadRetentionMs）后清理，而非立即消失。 */
  async flush() {
    if (!this.send) return { sent: 0, failed: 0, deferred: 0, skipped: 0 };
    if (this._flushing) return { sent: 0, failed: 0, deferred: 0, skipped: 0, note: 'already-flushing' };
    this._flushing = true;
    const now = this._now();
    let sent = 0, failed = 0, deferred = 0, skipped = 0;
    try {
      for (const n of this.store.list()) {
        if (n.status !== 'pending') continue;
        // 重试时间窗未到：跳过本轮
        if (n.nextRetryAt && n.nextRetryAt > now) { deferred++; continue; }
        if (n.quietDefer && this._inQuiet(now)) { deferred++; continue; }
        if (!this._rateOk(n.target, now)) { deferred++; continue; }
        try {
          await this.send(n.target, n.text);
          n.status = 'sent'; n.lastSentAt = now; n.sentAt = now; sent++;
        } catch (e) {
          n.retries = (n.retries || 0) + 1;
          if (n.retries >= this.cfg.maxRetries) {
            n.status = 'dead'; n.deadAt = now; n.error = String((e && e.message) || e).slice(0, 200); failed++;
          } else {
            n.nextRetryAt = now + this.cfg.retryBaseMs * n.retries;
          }
        }
      }
      this._persist();
      this._cleanup(now);
      return { sent, failed, deferred, skipped };
    } finally {
      this._flushing = false;
    }
  }

  /** 超出容量时丢弃最旧 pending（保留最近优先）。 */
  _enforceCapacity() {
    const max = Number(this.cfg.maxQueue) || 500;
    const pending = this.store.list().filter((n) => n.status === 'pending')
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    while (pending.length >= max) {
      const old = pending.shift();
      this.store.remove(old.id);
    }
  }

  _cleanup(now) {
    now = now || this._now();
    const sentRet = Number(this.cfg.sentRetentionMs) || 24 * 3600 * 1000;
    const deadRet = Number(this.cfg.deadRetentionMs) || 7 * 24 * 3600 * 1000;
    for (const n of this.store.list()) {
      if (n.status === 'sent' && (now - (n.sentAt || n.lastSentAt || 0) > sentRet)) this.store.remove(n.id);
      else if (n.status === 'dead' && (now - (n.deadAt || n.lastSentAt || 0) > deadRet)) this.store.remove(n.id);
    }
  }
  _persist() { if (this.store.file && this.store.file !== 'memory://notify') { try { this.store.save(); } catch (e) {} } }
  queue() { return this.store.list(); }
  /**
   * 运行时更新收件人名单。
   * V15.1 修正：必须同步刷新授权白名单 allowedTargets，否则
   *   - 新增的目标仍被拒（白名单陈旧），且
   *   - 已撤销的目标仍可继续入队（陈旧授权，属安全问题）。
   */
  setTargets(arr) {
    const list = Array.isArray(arr) ? arr.map(String) : [];
    this.cfg.targets = list;
    this.cfg.allowedTargets = list.slice();
    return this.cfg.allowedTargets;
  }
  setEnabled(on) { this.cfg.enabled = !!on; }
}

module.exports = { Notifier };
