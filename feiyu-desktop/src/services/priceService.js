'use strict';
/**
 * priceService.js —— 价格表（费用估算规则）的读写与校验。
 * 价格表只存在于桌面侧 userData（price.json），机器人明细不含价格；
 * 估算时按记录 time 套用历史价格规则。绝不代表服务商实际账单。
 */
const fs = require('fs');
const path = require('path');

const ALLOWED_UNITS = ['1', 'K', 'M', 'B'];

function pricePath(userDataDir) { return path.join(userDataDir, 'price.json'); }

function getPrice(userDataDir) {
  try { const o = JSON.parse(fs.readFileSync(pricePath(userDataDir), 'utf-8')); if (o && typeof o === 'object') return o; } catch (_) {}
  return null;
}
function setPrice(userDataDir, table) {
  const fp = pricePath(userDataDir);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = fp + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(table, null, 2), 'utf-8');
  fs.renameSync(tmp, fp);
  return { ok: true };
}

/** 校验价格表结构；返回 {valid, errors[]}。 */
function validatePrice(table) {
  const errors = [];
  if (!table || typeof table !== 'object') return { valid: false, errors: ['价格表必须是对象'] };
  if (table.unit != null && !ALLOWED_UNITS.includes(table.unit)) errors.push('unit 必须是 1/K/M/B');
  if (table.currency != null && typeof table.currency !== 'string') errors.push('currency 必须是字符串');
  if (table.version != null && typeof table.version !== 'string') errors.push('version 必须是字符串');
  const models = table.models;
  if (!models || typeof models !== 'object') { errors.push('models 必须是对象'); return { valid: false, errors }; }
  for (const k of Object.keys(models)) {
    const m = models[k];
    if (!m || typeof m !== 'object') { errors.push(`models.${k} 必须是对象`); continue; }
    if (typeof m.input !== 'number' || m.input < 0) errors.push(`models.${k}.input 必须是 >=0 的数字`);
    if (typeof m.output !== 'number' || m.output < 0) errors.push(`models.${k}.output 必须是 >=0 的数字`);
    if (m.cacheHit != null && (typeof m.cacheHit !== 'number' || m.cacheHit < 0)) errors.push(`models.${k}.cacheHit 必须是 >=0 的数字`);
    if (Array.isArray(m.history)) {
      for (const h of m.history) {
        if (!h || typeof h !== 'object') { errors.push(`models.${k}.history 项无效`); continue; }
        if (typeof h.effectiveFrom !== 'string' || Number.isNaN(Date.parse(h.effectiveFrom))) errors.push(`models.${k}.history 项 effectiveFrom 必须是合法日期`);
        if (typeof h.input !== 'number' || h.input < 0) errors.push(`models.${k}.history 项 input 必须是 >=0`);
        if (typeof h.output !== 'number' || h.output < 0) errors.push(`models.${k}.history 项 output 必须是 >=0`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

/** 生成一个可编辑的示例价格表（DeepSeek 公开价，仅作模板；用户应按实际价目表修改）。 */
function examplePrice() {
  return {
    version: new Date().toISOString().slice(0, 10),
    currency: 'CNY',
    unit: 'M',
    models: {
      'deepseek-chat': { input: 1.0, output: 2.0, cacheHit: 0.1 },
      'deepseek-reasoner': { input: 4.0, output: 16.0, cacheHit: 1.0 },
    },
  };
}

module.exports = { pricePath, getPrice, setPrice, validatePrice, examplePrice, ALLOWED_UNITS };
