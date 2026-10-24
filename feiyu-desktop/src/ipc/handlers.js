'use strict';
/**
 * handlers.js —— Main 进程 IPC 处理器注册。
 * 每个通道先经 ipcChannels.validate 做参数校验，再调用对应 Service。
 * 所有文件路径来自「用户设置里的 botDir」，不硬编码；无 botDir 时拒绝涉及文件的操作。
 */
const fs = require('fs');
const path = require('path');
const { CHANNELS, validate } = require('../services/ipcChannels');
const configService = require('../services/configService');
const personalityService = require('../services/personalityService');
const personalityTemplateService = require('../services/personalityTemplateService');
const secretService = require('../services/secretService');
const usageService = require('../services/usageService');
const logService = require('../services/logService');
const importExportService = require('../services/importExportService');
const providerService = require('../services/providerService');
const providerApplyService = require('../services/providerApplyService');
const priceService = require('../services/priceService');
const credentialStore = require('../services/credentialStore');
const { redactText } = require('../services/redact');
const { dialog } = require('electron');

/** 生成不可逆的展示用掩码：仅暴露首尾少量字符，绝不回传完整密钥。 */
function maskSecret(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 8) return '*'.repeat(s.length);
  return s.slice(0, 3) + '*'.repeat(Math.max(4, s.length - 6)) + s.slice(-3);
}

function registerHandlers({ ipcMain, getUserDataDir, getAppVersion, pm }) {
  const settingsFile = path.join(getUserDataDir(), 'feiyu-settings.json');
  const priceFile = path.join(getUserDataDir(), 'price.json');

  const getSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf-8')); } catch (_) { return {}; } };
  const setSettings = (s) => { try { fs.mkdirSync(getUserDataDir(), { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2)); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } };
  const getPrice = () => priceService.getPrice(getUserDataDir());
  const setPrice = (t) => priceService.setPrice(getUserDataDir(), t);
  const botDir = () => getSettings().botDir || '';
  const needBotDir = () => { const d = botDir(); return d && fs.existsSync(d) ? d : null; };

  ipcMain.handle(CHANNELS.APP_VERSION, () => ({ version: getAppVersion() }));
  ipcMain.handle(CHANNELS.SETTINGS_GET, () => ({ settings: getSettings() }));

  // 机器人目录定位状态：打包版定位不到 botDir 时给出明确原因（而非静默空目录）
  ipcMain.handle(CHANNELS.BOTDIR_STATUS, () => {
    const s = getSettings();
    const configured = s.botDir || '';
    let exists = false, hasCore = false;
    try {
      exists = !!configured && fs.existsSync(configured);
      hasCore = exists && fs.existsSync(path.join(configured, 'ai_bridge.js'));
    } catch (_) {}
    if (!configured) {
      return { ok: true, configured: false, exists: false, hasCore: false, message: '未配置机器人目录，请点击「选择机器人目录」指定（含 ai_bridge.js 的目录）' };
    }
    if (!exists) {
      return { ok: true, configured: true, exists: false, hasCore: false, message: '配置的机器人目录已不存在，请重新选择' };
    }
    if (!hasCore) {
      return { ok: true, configured: true, exists: true, hasCore: false, message: '机器人目录中未找到 ai_bridge.js，机器人功能可能不可用' };
    }
    return { ok: true, configured: true, exists: true, hasCore: true, message: '机器人目录正常' };
  });
  ipcMain.handle(CHANNELS.SETTINGS_SET, (e, args) => {
    const v = validate(CHANNELS.SETTINGS_SET, args); if (!v.ok) return { ok: false, error: v.error };
    const next = Object.assign({}, getSettings(), args);
    const r = setSettings(next);
    return { ok: r.ok, error: r.error, settings: next };
  });

  ipcMain.handle(CHANNELS.CONFIG_READ, () => {
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录', config: null };
    const r = configService.readRaw(d);
    return { ok: !r.error, config: r.data, exists: r.exists, error: r.error };
  });
  ipcMain.handle(CHANNELS.CONFIG_APPLY, (e, args) => {
    const v = validate(CHANNELS.CONFIG_APPLY, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    return configService.applyConfig(d, args.partial || {});
  });

  ipcMain.handle(CHANNELS.PERSONALITY_READ, () => {
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录', content: '' };
    const r = personalityService.read(d);
    return { ok: !r.error, content: r.content, exists: r.exists, error: r.error };
  });
  ipcMain.handle(CHANNELS.PERSONALITY_WRITE, (e, args) => {
    const v = validate(CHANNELS.PERSONALITY_WRITE, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    return personalityService.write(d, args.content);
  });

  // ---------- 人格模板库（与运行配置分离） ----------
  // 模板存 feiyu_personalities.json；只有「应用」才写 ai_prompt.txt，且先备份、失败保留原文件。
  ipcMain.handle(CHANNELS.PERSONALITY_TEMPLATE_LIST, () => {
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    return { ok: true, ...personalityTemplateService.status(d) };
  });
  ipcMain.handle(CHANNELS.PERSONALITY_TEMPLATE_SAVE, (e, args) => {
    const v = validate(CHANNELS.PERSONALITY_TEMPLATE_SAVE, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    return personalityTemplateService.save(d, args.template);
  });
  ipcMain.handle(CHANNELS.PERSONALITY_TEMPLATE_DELETE, (e, args) => {
    const v = validate(CHANNELS.PERSONALITY_TEMPLATE_DELETE, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    return personalityTemplateService.remove(d, args.id);
  });
  ipcMain.handle(CHANNELS.PERSONALITY_TEMPLATE_COPY, (e, args) => {
    const v = validate(CHANNELS.PERSONALITY_TEMPLATE_COPY, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    return personalityTemplateService.copy(d, args.id);
  });
  ipcMain.handle(CHANNELS.PERSONALITY_TEMPLATE_RENAME, (e, args) => {
    const v = validate(CHANNELS.PERSONALITY_TEMPLATE_RENAME, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    return personalityTemplateService.rename(d, args.id, args.name);
  });
  ipcMain.handle(CHANNELS.PERSONALITY_TEMPLATE_SET_ACTIVE, (e, args) => {
    const v = validate(CHANNELS.PERSONALITY_TEMPLATE_SET_ACTIVE, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    return personalityTemplateService.setActive(d, args.id);
  });
  ipcMain.handle(CHANNELS.PERSONALITY_TEMPLATE_APPLY, (e, args) => {
    const v = validate(CHANNELS.PERSONALITY_TEMPLATE_APPLY, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    // 用户显式「应用」：备份 ai_prompt.txt → 原子写入 → 失败保留原文件（不重启服务，loadPrompt 每次请求重读即时生效）
    const r = personalityTemplateService.apply(d, args.id);
    if (r.ok) r.note = (r.note || '') + '（应用前已备份于 ' + (r.backupDir || '—') + '）';
    return r;
  });
  ipcMain.handle(CHANNELS.PERSONALITY_TEMPLATE_DIFF, (e, args) => {
    const v = validate(CHANNELS.PERSONALITY_TEMPLATE_DIFF, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    return personalityTemplateService.diff(d, args.id, args.target != null ? { target: args.target } : {});
  });

  ipcMain.handle(CHANNELS.SECRET_READ, () => {
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录', data: null, exists: false };
    const r = secretService.read(d);
    // 安全加固：渲染进程不需要明文密钥，只回传「字段是否存在 + 掩码」。
    // 实际写入用 SECRET_WRITE / PROVIDER_SAVE 完成。
    const masked = {};
    if (r.data && typeof r.data === 'object') {
      for (const k of Object.keys(r.data)) {
        const v = r.data[k];
        masked[k] = (typeof v === 'string' && v.length > 0) ? maskSecret(v) : '';
      }
    }
    return { ok: !r.error, data: masked, masked: true, exists: r.exists, error: r.error };
  });
  ipcMain.handle(CHANNELS.SECRET_HAS_KEY, () => {
    const d = needBotDir(); if (!d) return { hasKey: false };
    return { hasKey: secretService.hasUsableKey(d) };
  });
  ipcMain.handle(CHANNELS.SECRET_WRITE, (e, args) => {
    const v = validate(CHANNELS.SECRET_WRITE, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    return secretService.write(d, args.data);
  });

  // 用量接口鉴权头：仅在 live 端口可用时，把本机 OneBot Token 作为 Bearer 头透传（bot 端 http.requireEventAuth=true 时需要）
  const usageAuthHeaders = (d) => {
    const sec = (secretService.read(d).data) || {};
    const tok = sec.onebotToken || sec.onebot_token;
    return tok ? { Authorization: 'Bearer ' + tok } : {};
  };

  ipcMain.handle(CHANNELS.USAGE_GET, async (e, args) => {
    const v = validate(CHANNELS.USAGE_GET, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const range = (args && args.range) || 'today';
    const status = await pm.getStatus();
    const livePort = status.bridge.running ? status.bridge.port : null;
    const usage = await usageService.getUsage(d, range, {
      livePort,
      deps: livePort ? { headers: usageAuthHeaders(d), filters: (args && args.filters) || undefined } : undefined,
    });
    // 费用估算（仅当存在价格表；估算值，非服务商实际账单）
    const price = getPrice();
    if (price && Array.isArray(usage.recentRequests)) {
      for (const r of usage.recentRequests) r._cost = usageService.estimateCost(r, price);
      usage.cost = usageService.estimateCostForSet(usage.recentRequests, price);
    } else {
      usage.cost = { priced: false, totalCost: null, currency: 'CNY', unit: 'M', priceVersion: null, reason: 'no_price_table' };
    }
    return { ok: true, usage };
  });

  ipcMain.handle(CHANNELS.LOG_TAIL, (e, args) => {
    const v = validate(CHANNELS.LOG_TAIL, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录', lines: [] };
    const lines = (args && args.lines) || 200;
    return logService.readTail(d, lines);
  });
  ipcMain.handle(CHANNELS.LOG_SEARCH, (e, args) => {
    const v = validate(CHANNELS.LOG_SEARCH, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录', lines: [] };
    return logService.search(d, args ? args.keyword : '', { max: (args && args.max) || 200 });
  });

  ipcMain.handle(CHANNELS.PROC_STATUS, async () => ({ ok: true, status: await pm.getStatus() }));
  ipcMain.handle(CHANNELS.PROC_START, async (e, args) => {
    const v = validate(CHANNELS.PROC_START, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const pre = await pm.preCheck();
    if (pre.alreadyRunning && !(args && args.force)) return { ok: false, alreadyRunning: true, status: pre.status, error: '机器人已在运行，避免重复启动' };
    const settings = getSettings();
    const napcat = (args && args.napcat) || settings.napcat || null;
    const r = pm.startBot(d, { napcat, settings });
    return { ok: true, started: r.started, pids: r.pids, note: secretService.hasUsableKey(d) ? '' : '未检测到 API Key，AI 桥可能启动后即退出（请先配置密钥）' };
  });
  ipcMain.handle(CHANNELS.PROC_STOP, async (e, args) => {
    const v = validate(CHANNELS.PROC_STOP, args); if (!v.ok) return { ok: false, error: v.error };
    let pids = (args && args.pids) || null;
    if (!pids) { const s = await pm.getStatus(); pids = [s.bridge.pid, s.napcat.pid].filter(Boolean); }
    if (!pids.length) return { ok: true, stopped: true, nothing: true };
    const r = await pm.stopByPids(pids, { timeoutMs: (args && args.timeoutMs) || 5000 });
    return { ok: true, ...r, pids };
  });

  ipcMain.handle(CHANNELS.IMPORT_BUILD, (e, args) => {
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    return { ok: true, export: importExportService.buildExport(d, getAppVersion(), { includeSecret: !!(args && args.includeSecret) }) };
  });
  ipcMain.handle(CHANNELS.IMPORT_VALIDATE, (e, args) => {
    const v = validate(CHANNELS.IMPORT_VALIDATE, args); if (!v.ok) return { ok: false, error: v.error };
    return { ok: true, ...importExportService.validateImport(args.obj) };
  });
  ipcMain.handle(CHANNELS.IMPORT_APPLY, (e, args) => {
    const v = validate(CHANNELS.IMPORT_APPLY, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const includeSecret = !!(args && args.includeSecret);
    const backup = args && args.backup !== false;
    return importExportService.applyImport(d, args.incoming, { backup, includeSecret });
  });

  // ---------- 多 Provider 管理 ----------
  // 复用现有单 Provider 请求系统：注册表只存配置，所谓「切换」= 把选中 Provider 写回
  // ai_config.json(api) + secrets.json(apiKey)，由机器人下次请求时生效（需重启 AI 桥）。
  ipcMain.handle(CHANNELS.PROVIDER_LIST, (e, args) => {
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    // 兼容迁移：尚不存在注册表时，用现有单 Provider 配置生成默认 Provider
    const migrated = providerService.migrateFromConfig(d, configService.readRaw(d).data, secretService.read(d).data);
    const cfg = configService.readRaw(d).data;
    const list = providerService.list(d, cfg);
    return { ok: true, providers: list.providers, default: list.default, appliedId: list.appliedId, migrated: migrated.migrated || false };
  });
  ipcMain.handle(CHANNELS.PROVIDER_SAVE, (e, args) => {
    const v = validate(CHANNELS.PROVIDER_SAVE, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    return providerService.save(d, args.provider);
  });
  ipcMain.handle(CHANNELS.PROVIDER_DELETE, (e, args) => {
    const v = validate(CHANNELS.PROVIDER_DELETE, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    return providerService.remove(d, args.id);
  });
  ipcMain.handle(CHANNELS.PROVIDER_SET_DEFAULT, (e, args) => {
    const v = validate(CHANNELS.PROVIDER_SET_DEFAULT, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    return providerService.setDefault(d, args.id);
  });
  ipcMain.handle(CHANNELS.PROVIDER_TEST, async (e, args) => {
    const v = validate(CHANNELS.PROVIDER_TEST, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    // 取待测 Provider：已有则取其存储的密钥；否则用传入的草稿（不落盘）
    let provider, apiKey = '';
    if (args.id) {
      const list = providerService.list(d);
      provider = list.providers.find((x) => x.id === args.id);
      if (!provider) return { ok: false, error: '未找到该 Provider' };
      const sec = providerService.loadSecrets(d);
      apiKey = sec[args.id] != null ? String(sec[args.id]) : '';
    } else {
      provider = args.provider;
    }
    if (!provider || !provider.baseUrl || !provider.model) return { ok: false, error: 'Provider 缺少 baseUrl/model' };
    // 注意：此调用会向 Provider 真实发一条最小 chat completion（可能产生极少量费用），
    // 仅由用户在前端显式点击触发；本函数不做任何自动/隐式请求。
    const res = await providerService.testConnection(provider, {
      fetch: globalThis.fetch, apiKey, timeoutMs: provider.timeoutMs, AbortSignal: globalThis.AbortSignal,
    });
    // 双重保险：返回前再脱敏（密钥只出现在请求头，不应进入响应，但防御性处理）
    if (res.error) res.error = redactText(res.error);
    return { ok: true, result: res };
  });
  ipcMain.handle(CHANNELS.PROVIDER_PREVIEW, (e, args) => {
    const v = validate(CHANNELS.PROVIDER_PREVIEW, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    return providerApplyService.previewSwitch(d, args.id);
  });
  ipcMain.handle(CHANNELS.PROVIDER_APPLY, (e, args) => {
    const v = validate(CHANNELS.PROVIDER_APPLY, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    // 切换 Provider = 覆盖机器人单 Provider 槽位，属破坏性写入：
    // 先备份 ai_config.json + secrets.json，写后回读校验，失败自动回滚。
    const r = providerApplyService.applySwitch(d, args.id, { backup: true });
    if (!r.ok) return { ok: false, error: r.error, rolledBack: !!r.rolledBack, backupDir: r.backupDir || null };
    return { ok: true, id: args.id, note: r.note, backupDir: r.backupDir || null };
  });

  // ---- 凭据安全：桌面侧多 Provider 密钥的加密状态与迁移 ----
  ipcMain.handle(CHANNELS.CREDENTIAL_STATUS, async () => {
    const d = needBotDir();
    const sys = await credentialStore.availableAsync();
    if (!d) return { ok: true, systemEncryption: sys, encrypted: false, hasFile: false, note: '未配置机器人目录' };
    const sr = providerService.readSecrets(d);
    return {
      ok: true,
      systemEncryption: sys,
      encrypted: sr.encrypted,
      hasFile: fs.existsSync(providerService.secretsPath(d)),
      decryptable: sr.ok,
      error: sr.ok ? null : sr.error,
      note: sr.encrypted
        ? (sr.ok ? '桌面 Provider 密钥已使用系统凭据加密存储' : '密钥已加密但当前无法解密：' + sr.error)
        : (sys ? '当前为明文存储，可执行迁移到系统凭据存储' : '系统凭据不可用（当前环境无 safeStorage 支持），保持明文存储'),
    };
  });
  ipcMain.handle(CHANNELS.CREDENTIAL_MIGRATE, () => {
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const r = providerService.migrateSecretsToEncrypted(d);
    if (!r.migrated) {
      return { ok: false, error: r.error || ('未迁移: ' + (r.reason || '未知原因')), reason: r.reason || null, backupDir: r.backupDir || null };
    }
    return { ok: true, migrated: true, verified: !!r.verified, backupDir: r.backupDir || null, reason: r.reason || null };
  });

  ipcMain.handle(CHANNELS.PRICE_GET, () => ({ ok: true, price: getPrice() }));
  ipcMain.handle(CHANNELS.PRICE_SET, (e, args) => {
    const v = validate(CHANNELS.PRICE_SET, args); if (!v.ok) return { ok: false, error: v.error };
    const pv = priceService.validatePrice(args.table);
    if (!pv.valid) return { ok: false, error: pv.errors.join('；') };
    const r = setPrice(args.table);
    return { ok: r.ok, error: r.error, price: getPrice() };
  });

  // 选择机器人目录：仅返回用户所选路径字符串（不执行任何文件操作、不暴露 fs）。
  ipcMain.handle(CHANNELS.DIALOG_PICKDIR, async () => {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'], title: '选择机器人目录（含 ai_bridge.js）' });
      if (canceled || !filePaths || !filePaths.length) return { ok: true, dir: null };
      const d = filePaths[0];
      // 轻量校验：目录里应有 ai_bridge.js，否则提示但仍允许（用户可自行调整）
      const ok = fs.existsSync(path.join(d, 'ai_bridge.js'));
      return { ok: true, dir: d, botCorePresent: ok };
    } catch (e) { return { ok: false, error: e.message }; }
  });
}

module.exports = { registerHandlers };
