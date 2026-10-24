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

/**
 * 备份当前运行配置（ai_config.json + secrets.json）。
 *
 * 返回 {dir, copied, manifest}：
 *  - copied：本轮实际复制出的文件
 *  - manifest：记录每个文件在备份时刻**是否存在**。
 *    验收发现：全新 botDir（原本没有这两个文件）时 copied 为空 → 回滚无内容可还原，
 *    会留下「配置已写入但密钥写入失败」的半应用状态。
 *    manifest 记录「原本不存在」，回滚时据此删除本次新建的文件，恢复到应用前状态。
 */
function backupCurrent(botDir, id) {
  const dir = backupDir(botDir, id);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const copied = [];
  const manifest = {};
  for (const f of ['ai_config.json', 'secrets.json']) {
    const src = path.join(botDir, f);
    const existed = fs.existsSync(src) && fs.statSync(src).isFile();
    manifest[f] = existed;
    if (existed) {
      try { fs.copyFileSync(src, path.join(dir, f)); copied.push(f); } catch (_) { manifest[f] = 'copy_failed'; }
    }
  }
  // 写出 manifest，供 restoreFrom 判定「原本不存在 → 回滚时删除」
  try { fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8'); } catch (_) {}
  return { dir, copied, manifest };
}

/**
 * 用备份还原（回滚）。
 * 依据 manifest：备份时存在 → 复制回来；备份时不存在 → 删除本次新建的文件。
 */
function restoreFrom(botDir, dir) {
  const restored = [];
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8')); } catch (_) {}
  for (const f of ['ai_config.json', 'secrets.json']) {
    const src = path.join(dir, f);
    const dst = path.join(botDir, f);
    const existedBefore = manifest ? manifest[f] === true : null;
    if (!fs.existsSync(src)) {
      // 备份时不存在该文件（且备份本身成功）→ 回滚 = 删除本次新建的
      if (existedBefore === false) {
        // 安全：只删「本次新建的普通文件」；若是目录/其它类型则跳过并如实报告，
        // 绝不用递归删除把用户数据卷进去。
        try {
          const st = fs.lstatSync(dst);
          if (st.isFile()) {
            fs.unlinkSync(dst);
            restored.push(f + '(removed)');
          } else {
            restored.push(f + '(skipped-not-a-regular-file)');
          }
        } catch (_) { /* 已被移除或读不到 */ }
      }
      continue;
    }
    try {
      const data = fs.readFileSync(src);
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
function applySwitch(botDir, id, { backup = true, deps = {} } = {}) {
  const patch = providerService.applyPatch(botDir, id);
  if (!patch.ok) return { ok: false, error: patch.error };

  let bk = null;
  if (backup) {
    bk = backupCurrent(botDir, id);
    // 注意：即使 copied 为空（全新 botDir，原本没有配置文件）也**必须保留 bk**——
    // 其 manifest 记录了「原本不存在」，回滚时据此删除本次新建的文件，
    // 否则会留下「配置已写入、密钥写入失败」的半应用状态。
    if (!fs.existsSync(path.join(bk.dir, 'manifest.json'))) bk = null; // 备份本身失败，不做回滚
  }

  const c = configService.applyConfig(botDir, patch.config);
  if (!c.ok) {
    const rb = bk ? restoreFrom(botDir, bk.dir) : null;
    return { ok: false, error: (c.errors || []).join('；') || '写入配置失败', rolledBack: !!rb, backupDir: bk ? bk.dir : null };
  }
  const s = (deps.writeSecret || secretService.write)(botDir, patch.secret);
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
