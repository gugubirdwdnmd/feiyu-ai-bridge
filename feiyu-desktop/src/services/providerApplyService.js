'use strict';
/**
 * providerApplyService.js —— Provider 切换（应用）的差异预览、备份与回滚。
 *
 * 背景：桌面维护多 Provider 注册表，但机器人核心只有「单 Provider」槽位
 * （ai_config.json.api + secrets.json.apiKey）。所谓"切换"就是覆盖这个槽位，
 * 因此属于破坏性写入，必须做到：可预览、可备份、失败可回滚。
 *
 * 关键点：
 *  - 差异预览只暴露非敏感字段（baseUrl / model / reasoningModel / 超时 / 重试），
 *    密钥只比较「有没有 / 是否相同」，绝不回显明文。
 *  - 备份目录落在 botDir/backups/（已被 .gitignore 排除），含 ai_config.json 与 secrets.json。
 *  - 回滚：写入后回读校验（配置字段一致 + 密钥可读），不一致则用备份还原并报错。
 *  - 不重启机器人、不发送任何请求（应用只写文件）。
 */
const fs = require('fs');
const path = require('path');
const configService = require('./configService');
const secretService = require('./secretService');
const providerService = require('./providerService');

function backupDir(botDir, id) {
  return path.join(botDir, 'backups', 'feiyu-provider-switch-' + Date.now() + (id ? '-' + String(id).slice(0, 8) : ''));
}

/** 备份当前运行配置（ai_config.json + secrets.json）。返回 {dir, copied}。 */
function backupCurrent(botDir, id) {
  const dir = backupDir(botDir, id);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const copied = [];
  for (const f of ['ai_config.json', 'secrets.json']) {
    const src = path.join(botDir, f);
    if (fs.existsSync(src)) {
      try { fs.copyFileSync(src, path.join(dir, f)); copied.push(f); } catch (_) {}
    }
  }
  return { dir, copied };
}

/** 用备份还原（回滚）。 */
function restoreFrom(botDir, dir) {
  const restored = [];
  for (const f of ['ai_config.json', 'secrets.json']) {
    const src = path.join(dir, f);
    if (!fs.existsSync(src)) continue;
    try {
      const data = fs.readFileSync(src);
      const dst = path.join(botDir, f);
      const tmp = dst + '.tmp.' + process.pid;
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, dst);
      restored.push(f);
    } catch (_) {}
  }
  return { restored };
}

/**
 * 预览切换差异（不写任何文件）。
 * 返回 {ok, provider, diff:{key:{from,to}}, secretChanged, note}
 */
function previewSwitch(botDir, id) {
  const patch = providerService.applyPatch(botDir, id);
  if (!patch.ok) return { ok: false, error: patch.error };
  const curCfg = configService.readRaw(botDir).data || {};
  const curApi = curCfg.api || {};
  const nextApi = patch.config.api || {};
  const diff = {};
  const keys = new Set([...Object.keys(curApi), ...Object.keys(nextApi)]);
  for (const k of keys) {
    const a = curApi[k] === undefined ? null : curApi[k];
    const b = nextApi[k] === undefined ? null : nextApi[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) diff[k] = { from: a, to: b };
  }
  let secretChanged = false;
  try {
    const sec = secretService.read(botDir);
    const cur = sec.data && sec.data.apiKey != null ? String(sec.data.apiKey) : '';
    secretChanged = cur !== String(patch.secret.apiKey || '');
  } catch (_) {}
  return {
    ok: true,
    id,
    provider: patch.provider,
    diff,
    secretChanged,
    note: '应用将覆盖 ai_config.json 的 api 段与 secrets.json 的 apiKey；需重启 AI 桥后生效。',
  };
}

/**
 * 执行切换：备份 → 写配置 → 写密钥 → 回读校验 → 失败回滚。
 * 不重启任何进程。
 */
function applySwitch(botDir, id, { backup = true } = {}) {
  const patch = providerService.applyPatch(botDir, id);
  if (!patch.ok) return { ok: false, error: patch.error };

  let bk = null;
  if (backup) {
    bk = backupCurrent(botDir, id);
    if (!bk.copied.length) bk = null; // 无可备份内容（例如首次配置），不阻断
  }

  const c = configService.applyConfig(botDir, patch.config);
  if (!c.ok) {
    const rb = bk ? restoreFrom(botDir, bk.dir) : null;
    return { ok: false, error: (c.errors || []).join('；') || '写入配置失败', rolledBack: !!rb, backupDir: bk ? bk.dir : null };
  }
  const s = secretService.write(botDir, patch.secret);
  if (!s.ok) {
    const rb = bk ? restoreFrom(botDir, bk.dir) : null;
    return { ok: false, error: s.error || '写入密钥失败', rolledBack: !!rb, backupDir: bk ? bk.dir : null };
  }

  // 回读校验：配置字段一致 + 密钥确实写入
  const after = configService.readRaw(botDir).data || {};
  const afterApi = after.api || {};
  let consistent = true;
  for (const k of Object.keys(patch.config.api || {})) {
    if (JSON.stringify(afterApi[k]) !== JSON.stringify(patch.config.api[k])) { consistent = false; break; }
  }
  if (consistent) {
    try {
      const sec = secretService.read(botDir);
      const k = sec.data && sec.data.apiKey != null ? String(sec.data.apiKey) : '';
      if (k !== String(patch.secret.apiKey || '')) consistent = false;
    } catch (_) { consistent = false; }
  }
  if (!consistent) {
    const rb = bk ? restoreFrom(botDir, bk.dir) : null;
    return { ok: false, error: '写入后回读校验不一致，已回滚到原配置', rolledBack: !!rb, backupDir: bk ? bk.dir : null };
  }

  return {
    ok: true,
    id,
    provider: patch.provider,
    backupDir: bk ? bk.dir : null,
    note: '已写入 ai_config.json + secrets.json，需重启 AI 桥后生效',
  };
}

module.exports = { previewSwitch, applySwitch, backupCurrent, restoreFrom, backupDir };
