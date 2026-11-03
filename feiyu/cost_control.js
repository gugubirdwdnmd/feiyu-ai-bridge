'use strict';
// ================= 成本控制（分域统计 + 每日预算） =================
// 原则（对应需求 G）：简单调度/状态检查/文本清理用本地代码；仅在规划/判断/总结时调模型。
// 单价未知时只记 token 与调用次数并标注 pricePending，绝不虚构费用。

const DOMAINS = ['agent', 'browser', 'vision', 'voice', 'other'];

class CostControl {
  /** @param {object} [cfg] 来自 CFG.budget */
  constructor(cfg) {
    cfg = cfg || {};
    this.enabled = cfg.enabled !== false;          // 默认开启统计，但无上限时等于不限制
    this.dailyTokens = Number(cfg.daily_tokens) || 0; // 0 = 不限
    this.warnPercent = Number(cfg.warn_percent) || 80;
    this.hardLimit = !!cfg.hard_limit;
    this.maxCallsPerDomain = Number(cfg.max_calls_per_domain) || 0;
    this.pricePending = true; // 价格未配置，不估算金额
    /** @type {Record<string,{calls:number,tokens:number}>} */
    this.perDomain = {};
    for (const d of DOMAINS) this.perDomain[d] = { calls: 0, tokens: 0 };
    this.dayStr = this._dayStr();
    this.todayTokens = 0;
  }

  _dayStr() { return new Date().toLocaleDateString('zh-CN'); }

  _rollover() {
    const d = this._dayStr();
    if (d !== this.dayStr) {
      this.dayStr = d;
      this.todayTokens = 0;
      for (const k of DOMAINS) { this.perDomain[k].calls = 0; this.perDomain[k].tokens = 0; }
    }
  }

  /** 记录一次调用。info: {tokens, calls} */
  record(domain, info) {
    this._rollover();
    const key = DOMAINS.indexOf(domain) >= 0 ? domain : 'other';
    const d = this.perDomain[key];
    const tokens = Number((info && info.tokens) || 0);
    const calls = Number((info && info.calls) || 1);
    d.calls += calls;
    d.tokens += tokens;
    this.todayTokens += tokens;
    return { domain: key, calls: d.calls, tokens: d.tokens };
  }

  usage(domain) { return Object.assign({}, this.perDomain[domain] || this.perDomain.other); }

  /**
   * 是否允许再发起一次「非必要」模型调用。
   * @returns {{ok:boolean, reason:string, used?:number, limit?:number, warn?:boolean, domain?:string}}
   */
  allowed(domain, estTokens) {
    if (!this.enabled) return { ok: true, reason: 'disabled' };
    this._rollover();
    const used = this.todayTokens + (Number(estTokens) || 0);
    if (this.dailyTokens > 0) {
      const pct = used / this.dailyTokens;
      if (this.hardLimit && pct >= 1) return { ok: false, reason: 'daily-hard-limit', used, limit: this.dailyTokens };
      if (pct >= this.warnPercent / 100) return { ok: true, reason: 'warn', used, limit: this.dailyTokens, warn: true };
    }
    const d = this.perDomain[domain] || this.perDomain.other;
    if (this.maxCallsPerDomain > 0 && d.calls >= this.maxCallsPerDomain) {
      return { ok: false, reason: 'domain-call-limit', domain };
    }
    return { ok: true, reason: 'ok', used: this.todayTokens, limit: this.dailyTokens };
  }

  /** 预算触顶时给主人发本地可生成的告警（不调模型）。 */
  budgetAlert() {
    return `⚠️ 今日模型用量已达每日预算的 ${this.warnPercent}%（${(this.todayTokens || 0).toLocaleString()} tokens${this.dailyTokens ? ' / ' + this.dailyTokens.toLocaleString() : ''}，单价未配置仅统计次数）。非必要调用已暂停，必要任务仍可进行。`;
  }

  report() {
    this._rollover();
    return {
      enabled: this.enabled,
      dailyTokens: this.dailyTokens,
      todayTokens: this.todayTokens,
      warnPercent: this.warnPercent,
      hardLimit: this.hardLimit,
      maxCallsPerDomain: this.maxCallsPerDomain,
      perDomain: JSON.parse(JSON.stringify(this.perDomain)),
      pricePending: this.pricePending,
    };
  }
}

module.exports = { CostControl, DOMAINS };
