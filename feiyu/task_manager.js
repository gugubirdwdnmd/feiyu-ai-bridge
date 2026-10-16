'use strict';
// ================= 任务管理核心（阶段 B） =================
// 独立模块，不把逻辑堆进 ai_bridge.js。状态机：pending/running/paused/completed/failed/cancelled。
// 特性：持久化（重启安全恢复）、唯一 ID、幂等（idempotencyKey 防重复触发）、
//       单任务超时、有限重试、并发上限、步骤上限、全局暂停/停止新任务、
//       定时(每日HH:MM)/一次性(ISO或HH:MM)/间隔(每N分钟)调度、过期与重复触发处理。
// 实际"干活"由外部注入的 executor(step, task, ctx) 完成——本模块只管生命周期与调度，
// 不假设具体怎么执行，便于离线测试与成本控制（由 executor 内部决定是否调模型）。
//
// V15 修正（要求③⑥）：
//  - 引入可取消执行上下文 ctx（isCancelled/isPauseRequested/cancel/pause/timedOut），
//    每步 await 之后及时检查，防止已取消/已暂停任务继续推进；
//  - 取消/暂停 API 在任务运行时仅"请求"中断，并如实说明：无法立即中断的底层操作可能仍会执行完毕；
//  - 超时不再无脑重试，标记 timedOut 并视为失败（避免反复超时消耗资源）；
//  - executed 字段区分"任务执行成功"（executed:true）与"仅生命周期登记成功"（executed:false，无执行器时）。

const crypto = require('crypto');
const { JsonStore, nowMs } = require('./task_store');

const STATES = ['pending', 'running', 'paused', 'completed', 'failed', 'cancelled'];
const DEFAULTS = {
  maxConcurrent: 3,
  maxRetries: 2,
  maxSteps: 10,
  taskTimeoutMs: 5 * 60 * 1000,
  runWindowMs: 60 * 1000,     // 同 idempotencyKey 最小重触发间隔
  stepGapMs: 200,             // 步骤间最小间隔（避免瞬发轰炸）
};

function uid() {
  try { return crypto.randomUUID(); } catch (e) { return 't_' + nowMs() + '_' + Math.random().toString(36).slice(2, 10); }
}

function pad2(n) { return String(n).padStart(2, '0'); }
function hhmm(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }

class TaskManager {
  /**
   * @param {object} opts
   * @param {string} opts.storeFile 持久化文件
   * @param {Function} opts.executor (step, task, ctx) => Promise<{ok:boolean, output?:any, error?:string}>
   * @param {Function} [opts.onEvent] (event, task) => void  状态变化回调（用于通知主人）
   * @param {object} [opts.config] 调度/并发配置
   */
  constructor(opts) {
    opts = opts || {};
    this.store = new JsonStore(opts.storeFile || 'memory://tasks', { maxItems: opts.config && opts.config.maxTasks || 500 });
    this.executor = typeof opts.executor === 'function' ? opts.executor : null;
    this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
    this.cfg = Object.assign({}, DEFAULTS, opts.config || {});
    this.globalPaused = false;
    this.stopNew = false;
    this._active = 0;          // 当前 running 数
    this._seq = 0;
    this._loading = false;
    /** @type {Map<string, object>} 运行中的任务 id -> 可取消上下文（不持久化） */
    this._ctxs = new Map();
  }

  // ---------- 持久化 / 启动恢复 ----------
  init() {
    const arr = this.store.list();
    // 重启恢复：running/paused 重新入队；过期一次性任务标记失败
    const now = nowMs();
    for (const t of arr) {
      if (t.status === 'running' || t.status === 'paused') {
        // 运行中进程被杀 → 视为可恢复；paused 保持暂停
        if (t.status === 'running') t.status = 'pending';
        if (t.expireAt && t.expireAt < now) { t.status = 'failed'; t.error = '过期未完成'; }
        this.store.set(t);
      }
    }
    return this;
  }

  _emit(ev, t) { if (this.onEvent) { try { this.onEvent(ev, t); } catch (e) {} } }

  _persist(t) { if (this.store.file && this.store.file !== 'memory://tasks') { try { this.store.save(); } catch (e) {} } }

  // ---------- 创建 ----------
  create(input) {
    input = input || {};
    const now = nowMs();
    // 幂等：同 idempotencyKey 已有活动任务则直接返回 existing
    if (input.idempotencyKey) {
      const ex = this.store.filter((t) => t.idempotencyKey === input.idempotencyKey &&
        (t.status === 'pending' || t.status === 'running' || t.status === 'paused'));
      if (ex.length) { const e = ex[0]; return { ok: true, id: e.id, task: e, duplicate: true }; }
    }
    const steps = Array.isArray(input.steps) && input.steps.length
      ? input.steps.slice(0, this.cfg.maxSteps)
      : [{ kind: input.type || 'generic', payload: input.payload || {} }];
    const task = {
      id: uid(),
      idempotencyKey: input.idempotencyKey || null,
      title: String(input.title || '未命名任务').slice(0, 200),
      type: input.type || 'generic',
      status: 'pending',
      steps,
      stepIndex: 0,
      totalSteps: steps.length,
      completedSteps: 0,
      executed: false,       // V15：区分"已实际执行"与"仅生命周期登记"
      result: null,
      error: null,
      retries: 0,
      maxRetries: input.maxRetries != null ? Math.min(Number(input.maxRetries), this.cfg.maxRetries) : this.cfg.maxRetries,
      schedule: this._normalizeSchedule(input),
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      lastRunAt: null,
      nextRunAt: this._nextRunAt(input, now),
      expireAt: input.expireAt || null,
      ownerId: input.ownerId != null ? String(input.ownerId) : null,
      priority: Number(input.priority) || 0,
      history: [],
    };
    this.store.set(task);
    this._persist(task);
    this._emit('created', task);
    return { ok: true, id: task.id, task, duplicate: false };
  }

  _normalizeSchedule(input) {
    if (typeof input.cron === 'string' && /^(\d{1,2}:\d{2})$/.test(input.cron)) return { kind: 'daily', time: input.cron };
    if (typeof input.runAt === 'string') {
      const m = /^(\d{1,2}:\d{2})$/.test(input.runAt);
      if (m) return { kind: 'once-daily', time: input.runAt };
      const t = Date.parse(input.runAt);
      if (!isNaN(t)) return { kind: 'once', at: t };
    }
    if (typeof input.intervalMin === 'number' && input.intervalMin > 0) return { kind: 'interval', everyMs: input.intervalMin * 60000 };
    return null; // 立即执行（无调度）
  }

  _nextRunAt(input, now) {
    const s = this._normalizeSchedule(input);
    if (!s) return null;
    if (s.kind === 'once') return s.at;
    if (s.kind === 'daily' || s.kind === 'once-daily') {
      const [h, m] = s.time.split(':').map(Number);
      const d = new Date(now);
      d.setHours(h, m, 0, 0);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
    if (s.kind === 'interval') return now + s.everyMs;
    return null;
  }

  // ---------- 查询 ----------
  get(id) { return this.store.get(id); }
  list(filter) {
    let arr = this.store.list();
    if (filter && filter.status) arr = arr.filter((t) => t.status === filter.status);
    if (filter && filter.ownerId != null) arr = arr.filter((t) => String(t.ownerId) === String(filter.ownerId));
    return arr.sort((a, b) => (b.priority - a.priority) || (b.createdAt - b.createdAt));
  }
  stats() {
    const s = { pending: 0, running: 0, paused: 0, completed: 0, failed: 0, cancelled: 0, total: 0 };
    for (const t of this.store.list()) { if (s[t.status] != null) s[t.status]++; s.total++; }
    s.active = this._active;
    return s;
  }

  // ---------- 可取消执行上下文 ----------
  _makeCtx(t) {
    const ctx = {
      taskId: t.id,
      startAt: nowMs(),
      cancelled: false,
      pauseRequested: false,
      timedOut: false,
      // 供执行器轮询：是否已取消 / 是否已请求暂停
      isCancelled() { return ctx.cancelled; },
      isPauseRequested() { return ctx.pauseRequested; },
      // 由 cancel()/pause()/超时 设置
      cancel() { ctx.cancelled = true; },
      pause() { ctx.pauseRequested = true; },
    };
    return ctx;
  }

  // ---------- 控制 ----------
  pause(id) {
    const t = this.store.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.status !== 'running' && t.status !== 'pending') return { ok: false, error: '当前状态不可暂停: ' + t.status };
    const wasRunning = t.status === 'running';
    t.status = 'paused';
    t.updatedAt = nowMs();
    const ctx = this._ctxs.get(id);
    if (ctx) ctx.pause(); // 信号运行中执行器尽快于步骤边界暂停
    this.store.set(t); this._persist(t);
    this._emit('paused', t);
    return {
      ok: true, task: t,
      note: wasRunning
        ? '已请求暂停。若底层执行当前正在运行中，将尽快于步骤边界暂停；无法立即中断的底层操作可能仍会执行到该步结束。'
        : '已暂停（任务尚未开始执行）。',
    };
  }
  resume(id) {
    const t = this.store.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.status !== 'paused') return { ok: false, error: '当前状态不可恢复: ' + t.status };
    t.status = 'pending';
    t.updatedAt = nowMs();
    this.store.set(t); this._persist(t);
    this._emit('resumed', t);
    return { ok: true, task: t };
  }
  cancel(id) {
    const t = this.store.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.status === 'completed' || t.status === 'cancelled') return { ok: false, error: '已终态，无需取消' };
    const wasRunning = t.status === 'running';
    t.status = 'cancelled';
    t.finishedAt = nowMs();
    t.updatedAt = nowMs();
    t.history.push({ at: nowMs(), ev: 'cancelled' });
    const ctx = this._ctxs.get(id);
    if (ctx) ctx.cancel(); // 信号运行中执行器尽快于步骤边界停止
    this.store.set(t); this._persist(t);
    this._emit('cancelled', t);
    return {
      ok: true, task: t,
      note: wasRunning
        ? '已请求取消。若底层执行当前正在运行中，将尽快于步骤边界停止；无法立即中断的底层操作（如已发起的网络请求、子进程）可能仍会执行完毕，本系统不保证瞬时中止。'
        : '已取消（任务尚未开始执行）。',
    };
  }
  setGlobalPause(on) { this.globalPaused = !!on; return { ok: true, globalPaused: this.globalPaused }; }
  setStopNew(on) { this.stopNew = !!on; return { ok: true, stopNew: this.stopNew }; }

  // ---------- 调度心跳（由每分钟循环调用）----------
  tick(now) {
    now = now || nowMs();
    const due = [];
    for (const t of this.store.list()) {
      if (t.status !== 'pending') continue;
      // 过期处理
      if (t.expireAt && t.expireAt < now && (!t.schedule || t.schedule.kind === 'once' || t.schedule.kind === 'once-daily')) {
        t.status = 'failed'; t.error = '任务过期未触发'; t.finishedAt = now; this.store.set(t); this._emit('expired', t); continue;
      }
      const nr = t.nextRunAt;
      if (nr == null) { due.push(t); continue; }       // 立即执行
      if (nr <= now) {
        // 重复触发防护：与上次运行间隔太短则跳过本轮（防止休眠后补发风暴）
        if (t.lastRunAt && (now - t.lastRunAt) < (this.cfg.runWindowMs)) continue;
        due.push(t);
      }
    }
    // 按优先级排序后启动，受并发上限约束
    due.sort((a, b) => (b.priority - a.priority) || (a.createdAt - b.createdAt));
    for (const t of due) {
      if (this.globalPaused || this.stopNew) break;
      if (this._active >= this.cfg.maxConcurrent) break;
      this._start(t, now);
    }
    this._persist({ storedAt: now });
    return due.length;
  }

  // ---------- 执行 ----------
  _start(t, now) {
    if (this.globalPaused || this.stopNew) return false;
    if (this._active >= this.cfg.maxConcurrent) return false;
    if (this._ctxs.has(t.id)) return false; // 已在运行，避免重复启动
    t.status = 'running';
    t.startedAt = t.startedAt || now;
    t.lastRunAt = now;
    t.updatedAt = now;
    const ctx = this._makeCtx(t);
    this._ctxs.set(t.id, ctx);
    this._active++;
    this.store.set(t); this._persist(t);
    this._emit('started', t);
    this._runSteps(t, ctx).then(
      () => { this._active = Math.max(0, this._active - 1); this._ctxs.delete(t.id); },
      () => { this._active = Math.max(0, this._active - 1); this._ctxs.delete(t.id); }
    );
    return true;
  }

  async _runSteps(t, ctx) {
    const now = nowMs();
    if (!this.executor) {
      // 未配置执行器：标记完成但附说明（不挂起、不假称成功执行了工作）
      t.status = 'completed';
      t.executed = false;
      t.result = { ok: true, executed: false, note: '无执行器，仅完成生命周期登记' };
      t.finishedAt = nowMs();
      t.updatedAt = nowMs();
      t.history.push({ at: now, ev: 'no-executor' });
      this.store.set(t); this._persist(t);
      this._emit('completed', t);
      return;
    }
    try {
      for (let i = t.stepIndex; i < t.steps.length; i++) {
        if (ctx.isCancelled()) { if (t.status !== 'cancelled') this._finalizeCancelled(t); return; }
        if (ctx.isPauseRequested()) { if (t.status !== 'paused') this._finalizePaused(t); return; }
        if (i >= this.cfg.maxSteps) { t.error = '超过步骤上限'; break; }
        const step = t.steps[i];
        const r = await this._withTimeout(this.executor(step, t, ctx), this.cfg.taskTimeoutMs, ctx);
        // 步骤边界再次检查：已被取消/暂停则停止推进
        if (ctx.isCancelled()) { if (t.status !== 'cancelled') this._finalizeCancelled(t); return; }
        if (ctx.isPauseRequested()) { if (t.status !== 'paused') this._finalizePaused(t); return; }
        t.stepIndex = i + 1;
        t.completedSteps = i + 1;
        t.history.push({ at: nowMs(), step: i, ok: !!(r && r.ok), out: (r && r.ok) ? undefined : (r && r.error) });
        if (!r || !r.ok) {
          // 超时：不再无脑重试，标记 timedOut 并视为失败
          if (r && r.timedOut) {
            t.status = 'failed';
            t.executed = true;
            t.timedOut = true;
            t.error = (r && r.error) || '步骤执行超时';
            t.finishedAt = nowMs();
            t.updatedAt = nowMs();
            this.store.set(t); this._persist(t);
            this._emit('failed', t);
            return;
          }
          if (t.retries < t.maxRetries) {
            t.retries++;
            i--; // 重试当前步
            t.history.push({ at: nowMs(), ev: 'retry', n: t.retries });
            continue;
          }
          t.status = 'failed';
          t.executed = true;
          t.error = (r && r.error) || '步骤执行失败';
          t.finishedAt = nowMs();
          t.updatedAt = nowMs();
          this.store.set(t); this._persist(t);
          this._emit('failed', t);
          return;
        }
        if (this.cfg.stepGapMs) await new Promise((s) => setTimeout(s, this.cfg.stepGapMs));
      }
      if (ctx.isCancelled()) { if (t.status !== 'cancelled') this._finalizeCancelled(t); return; }
      if (ctx.isPauseRequested()) { if (t.status !== 'paused') this._finalizePaused(t); return; }
      if (t.status === 'running') {
        t.status = 'completed';
        t.executed = true;
        t.result = { ok: true, executed: true, steps: t.completedSteps };
        t.finishedAt = nowMs();
        t.updatedAt = nowMs();
        this.store.set(t); this._persist(t);
        this._emit('completed', t);
      }
      // 调度：有 next 的任务重排下一触发时间
      this._reschedule(t);
    } catch (e) {
      t.status = 'failed';
      t.executed = true;
      t.error = String((e && e.message) || e).slice(0, 300);
      t.finishedAt = nowMs();
      t.updatedAt = nowMs();
      this.store.set(t); this._persist(t);
      this._emit('failed', t);
    }
  }

  _finalizeCancelled(t) {
    t.status = 'cancelled';
    t.updatedAt = nowMs();
    if (!t.finishedAt) t.finishedAt = nowMs();
    t.history.push({ at: nowMs(), ev: 'cancelled-mid' });
    this.store.set(t); this._persist(t);
    this._emit('cancelled', t);
  }

  _finalizePaused(t) {
    t.status = 'paused';
    t.updatedAt = nowMs();
    t.history.push({ at: nowMs(), ev: 'paused-mid' });
    this.store.set(t); this._persist(t);
    this._emit('paused', t);
  }

  _reschedule(t) {
    if (!t.schedule || t.schedule.kind === 'once' || t.schedule.kind === 'once-daily') {
      // 一次性任务执行完即终态
      return;
    }
    const now = nowMs();
    if (t.schedule.kind === 'daily') {
      const [h, m] = t.schedule.time.split(':').map(Number);
      const d = new Date(now); d.setHours(h, m, 0, 0);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      t.nextRunAt = d.getTime();
    } else if (t.schedule.kind === 'interval') {
      t.nextRunAt = now + t.schedule.everyMs;
    }
    if (t.status === 'completed' || t.status === 'failed') {
      // 周期性任务：完成本轮后重新入队为 pending（保持循环）
      t.status = 'pending';
      t.stepIndex = 0;
      t.retries = 0;
    }
    t.updatedAt = now;
    this.store.set(t); this._persist(t);
  }

  _withTimeout(p, ms, ctx) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return; done = true;
        if (ctx) { ctx.timedOut = true; } // 仅标记超时；不调用 cancel()，否则会与"取消"语义混淆
        resolve({ ok: false, error: '步骤超时(' + ms + 'ms)', timedOut: true });
      }, ms);
      Promise.resolve(p).then(
        (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v || { ok: true }); },
        (e) => { if (done) return; done = true; clearTimeout(timer); resolve({ ok: false, error: String((e && e.message) || e).slice(0, 300) }); }
      );
    });
  }

  // 仅测试/诊断用：清空全部任务
  _resetAll() { this.store.map.clear(); }
}

module.exports = { TaskManager, STATES, DEFAULTS, uid };
