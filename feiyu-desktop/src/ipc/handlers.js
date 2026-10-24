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
const secretService = require('../services/secretService');
const usageService = require('../services/usageService');
const logService = require('../services/logService');
const importExportService = require('../services/importExportService');
const providerService = require('../services/providerService');
const priceService = require('../services/priceService');
const { redactText } = require('../services/redact');
const { dialog } = require('electron');

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

  ipcMain.handle(CHANNELS.SECRET_READ, () => {
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录', data: null, exists: false };
    const r = secretService.read(d);
    return { ok: !r.error, data: r.data, exists: r.exists, error: r.error };
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

  ipcMain.handle(CHANNELS.USAGE_GET, async (e, args) => {
    const v = validate(CHANNELS.USAGE_GET, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const range = (args && args.range) || 'today';
    const status = await pm.getStatus();
    const livePort = status.bridge.running ? status.bridge.port : null;
    const usage = await usageService.getUsage(d, range, { livePort });
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
  ipcMain.handle(CHANNELS.PROVIDER_APPLY, (e, args) => {
    const v = validate(CHANNELS.PROVIDER_APPLY, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const patch = providerService.applyPatch(d, args.id);
    if (!patch.ok) return { ok: false, error: patch.error };
    const c = configService.applyConfig(d, patch.config);
    if (!c.ok) return { ok: false, error: (c.errors || []).join('；') || '写入配置失败' };
    const s = secretService.write(d, patch.secret);
    if (!s.ok) return { ok: false, error: s.error || '写入密钥失败' };
    return { ok: true, id: args.id, note: '已写入 ai_config.json + secrets.json，需重启 AI 桥后生效' };
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
