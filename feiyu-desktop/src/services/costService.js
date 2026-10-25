'use strict';
/**
 * costService.js —— AI 用量与成本管理（模块 I）。
 *
 * 定位：在既有 usageService（明细聚合）+ priceService（用户自填价格表）之上，
 * 补「预算 / 按模型成本拆解 / 估算免责声明」这三层，不改动数据采集口径。
 *
 * 铁律：
 *  1) 一切都是**估算**。输出里恒带 `estimate: true` 与 `disclaimer`，绝不冒充服务商账单。
 *  2) 缺价格时明确报 `unpriced`，**不猜价格、不给 0 元假象**。
 *  3) **不记录、不接触任何密钥**：本模块只吃 usage 数字，不读 secrets.json。
 *  4) 预算只是本地提醒阈值，不做任何限流/拦截（避免误伤真实业务）。
 */
const fs = require('fs');
const path = require('path');
const usageService = require('./usageService');

const BUDGET_FILE = 'feiyu_budget.json';
const SCHEMA_VERSION = 1;
const DISCLAIMER = '所有金额均为按你自填价格表推算的估算值，不是服务商账单；实际扣费以服务商为准。';

function budgetPath(userDataDir) { return path.join(userDataDir, BUDGET_FILE); }

function getBudget(userDataDir) {
  try {
    const o = JSON.parse(fs.readFileSync(budgetPath(userDataDir), 'utf-8'));
    if (!o || typeof o !== 'object') return null;
    return o;
  } catch (_) { return null; }
}

function validateBudget(b) {
  const errors = [];
  if (b == null) return { valid: true, errors };
  if (typeof b !== 'object' || Array.isArray(b)) return { valid: false, errors: ['预算必须是对象'] };
  if (b.monthly != null && (typeof b.monthly !== 'number' || !(b.monthly >= 0))) errors.push('monthly 必须是 >=0 的数字');
  if (b.daily != null && (typeof b.daily !== 'number' || !(b.daily >= 0))) errors.push('daily 必须是 >=0 的数字');
  if (b.currency != null && typeof b.currency !== 'string') errors.push('currency 必须是字符串');
  if (b.warnRatio != null && (typeof b.warnRatio !== 'number' || b.warnRatio <= 0 || b.warnRatio > 1)) errors.push('warnRatio 必须在 (0,1]');
  return { valid: errors.length === 0, errors };
}

function setBudget(userDataDir, b) {
  const v = validateBudget(b);
  if (!v.valid) return { ok: false, errors: v.errors };
  const p = budgetPath(userDataDir);
  const tmp = p + '.tmp.' + process.pid;
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(Object.assign({ version: SCHEMA_VERSION, updatedAt: new Date().toISOString() }, b || {}), null, 2), 'utf-8');
    fs.renameSync(tmp, p);
    return { ok: true, budget: getBudget(userDataDir) };
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    return { ok: false, error: e.message };
  }
}

/**
 * 判断某模型在价格表里是否有可用规则（含历史规则）。
 * 与 usageService.selectPriceRule 口径一致：无规则即 unpriced。
 */
function priceOf(model, price) {
  if (!price || !price.models || !model) return null;
  const m = price.models[model];
  if (!m) return null;
  return m;
}

/**
 * 构建成本报告（纯函数，便于单测）。
 * @param usage usageService.getUsage() 的返回值
 * @param price 价格表（可空）
 * @param opts { budget, range, now }
 */
function buildCostReport(usage, price, opts = {}) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const budget = opts.budget || null;
  const unit = (price && price.unit) || 'M';
  const currency = (price && price.currency) || 'CNY';
  const priced = !!price;

  const recent = Array.isArray(u.recentRequests) ? u.recentRequests : [];
  // 按模型拆解：只有被价格表覆盖的模型才给出金额
  const modelUsage = u.modelUsage && typeof u.modelUsage === 'object' ? u.modelUsage : {};
  const byModel = [];
  let totalCost = 0;
  let pricedModels = 0;
  const unpricedModels = [];

  for (const model of Object.keys(modelUsage)) {
    const mu = modelUsage[model] || {};
    const rule = priced ? priceOf(model, price) : null;
    const tokens = {
      prompt: Number(mu.prompt || mu.promptTokens || 0),
      completion: Number(mu.completion || mu.completionTokens || 0),
    };
    let cost = null;
    if (rule) {
      const factor = usageService.unitFactor(unit);
      cost = usageService.roundCost(((tokens.prompt / factor) * Number(rule.input || 0)) + ((tokens.completion / factor) * Number(rule.output || 0)));
      totalCost += cost;
      pricedModels++;
    } else if (priced) {
      unpricedModels.push(model);
    }
    byModel.push({
      model,
      promptTokens: tokens.prompt,
      completionTokens: tokens.completion,
      requests: Number(mu.requests || mu.count || 0),
      cost: cost,
      priced: !!rule,
      estimate: !!rule,
    });
  }
  byModel.sort((a, b) => (b.cost || 0) - (a.cost || 0) || b.promptTokens - a.promptTokens);

  // recentRequests 上补 _cost（与既有 UI 兼容）
  if (priced) {
    for (const r of recent) {
      if (r && r._cost == null) {
        const c = usageService.estimateCost(r, price);
        r._cost = c == null ? null : c;
      }
    }
  }

  // 预算状态（只提醒，不拦截）
  let budgetStatus = { configured: false, level: 'none', message: null, usedRatio: null, monthly: null, currency };
  if (budget && (typeof budget.monthly === 'number' || typeof budget.daily === 'number')) {
    const limit = typeof budget.monthly === 'number' ? budget.monthly : budget.daily;
    const scope = typeof budget.monthly === 'number' ? 'monthly' : 'daily';
    const ratio = limit > 0 ? totalCost / limit : null;
    const warnRatio = typeof budget.warnRatio === 'number' ? budget.warnRatio : 0.8;
    let level = 'ok';
    let message = null;
    if (ratio == null) { level = 'unknown'; message = '预算阈值为 0，无法计算占比'; }
    else if (ratio >= 1) { level = 'exceeded'; message = '估算费用已超过' + (scope === 'monthly' ? '月度' : '每日') + '预算（' + currency + ' ' + totalCost.toFixed(2) + ' / ' + limit + '）'; }
    else if (ratio >= warnRatio) { level = 'warn'; message = '估算费用已达预算的 ' + Math.round(ratio * 100) + '%（' + currency + ' ' + totalCost.toFixed(2) + ' / ' + limit + '）'; }
    else { message = '估算费用 ' + currency + ' ' + totalCost.toFixed(2) + '，占预算 ' + Math.round(ratio * 100) + '%'; }
    budgetStatus = { configured: true, level, message, usedRatio: ratio == null ? null : +ratio.toFixed(4), monthly: scope === 'monthly' ? limit : null, daily: scope === 'daily' ? limit : null, currency };
  }

  return {
    ok: true,
    estimate: true,
    disclaimer: DISCLAIMER,
    priced,
    reason: priced ? null : 'no_price_table',
    range: u.range || opts.range || null,
    source: u.source || 'none',
    currency,
    unit,
    priceVersion: (price && price.version) || null,
    totals: {
      totalTokens: Number(u.totalTokens || 0),
      promptTokens: Number(u.promptTokens || 0),
      completionTokens: Number(u.completionTokens || 0),
      reasoningTokens: Number(u.reasoningTokens || 0),
      requests: Number(u.successRequests || 0) + Number(u.failRequests || 0),
      cost: priced ? usageService.roundCost(totalCost) : null,
    },
    byModel,
    unpricedModels,
    coverage: {
      models: byModel.length,
      priced: pricedModels,
      unpriced: unpricedModels.length,
      complete: priced && unpricedModels.length === 0 && byModel.length > 0,
    },
    budget: budgetStatus,
    note: !priced
      ? '尚未配置价格表：只显示 token 用量，不显示金额（避免给出错误费用）'
      : (unpricedModels.length ? '以下模型没有价格规则，其费用未计入总额: ' + unpricedModels.join('、') : null),
  };
}

/** 便捷入口：直接从 botDir 读 usage 再生成报告。 */
async function report(botDir, userDataDir, range, opts = {}) {
  const usage = await usageService.getUsage(botDir, range, opts.usageDeps || {});
  const price = opts.price !== undefined ? opts.price : (() => {
    try { return JSON.parse(fs.readFileSync(path.join(userDataDir, 'price.json'), 'utf-8')); } catch (_) { return null; }
  })();
  const budget = opts.budget !== undefined ? opts.budget : getBudget(userDataDir);
  return buildCostReport(usage, price, { budget, range });
}

module.exports = {
  BUDGET_FILE, SCHEMA_VERSION, DISCLAIMER,
  budgetPath, getBudget, validateBudget, setBudget, priceOf, buildCostReport, report,
};
