'use strict';
/**
 * handlers.js —— Main 进程 IPC 处理器注册。
 * 每个通道先经 ipcChannels.validate 做参数校验，再调用对应 Service。
 * 所有文件路径来自「用户设置里的 botDir」，不硬编码；无 botDir 时拒绝涉及文件的操作。
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const os = require('os');
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
const skillService = require('../services/skillService');
const comfyService = require('../services/comfyService');
const themeService = require('../services/themeService');
const botDirResolver = require('../services/botDirResolver');
// —— 全量升级新增模块（A–J）——
const napcatLoginService = require('../services/napcatLoginService');
const serviceRegistry = require('../services/serviceRegistry');
const envDetector = require('../services/envDetector');
const mcpService = require('../services/mcpService');
const skillTreeService = require('../services/skillTreeService');
const marketService = require('../services/marketService');
const backupService = require('../services/backupService');
const workflowService = require('../services/workflowService');
const costService = require('../services/costService');
const diagnosticService = require('../services/diagnosticService');
const { redactText } = require('../services/redact');
const { dialog, app } = require('electron');
const { createTerminalManager } = require('../services/terminalService');
const { createLogTailer } = require('../services/logTailService');

/** 生成不可逆的展示用掩码：仅暴露首尾少量字符，绝不回传完整密钥。 */
function maskSecret(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 8) return '*'.repeat(s.length);
  return s.slice(0, 3) + '*'.repeat(Math.max(4, s.length - 6)) + s.slice(-3);
}

function registerHandlers({ ipcMain, getUserDataDir, getAppVersion, pm, send }) {
  const emit = (channel, payload) => { try { if (typeof send === 'function') send(channel, payload); } catch (_) {} };

  // 模块 K：终端与实时日志流（输出经 emit 推回渲染进程；未连窗口时 send 为空，自动跳过）
  const terminal = createTerminalManager({ emit });
  const logTail = createLogTailer({ emit });

  const settingsFile = path.join(getUserDataDir(), 'feiyu-settings.json');
  const priceFile = path.join(getUserDataDir(), 'price.json');

  const getSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf-8')); } catch (_) { return {}; } };
  const setSettings = (s) => { try { fs.mkdirSync(getUserDataDir(), { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2)); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } };
  const getPrice = () => priceService.getPrice(getUserDataDir());
  const setPrice = (t) => priceService.setPrice(getUserDataDir(), t);
  const botDir = () => getSettings().botDir || '';
  const needBotDir = () => { const d = botDir(); return d && fs.existsSync(d) ? d : null; };
  /** 解析 NapCat 目录：设置里的 napcatDir 优先；否则在 botDir / 常见位置找含 index.js(+node.exe) 的目录。 */
  const resolveNapcatDir = () => {
    const s = getSettings();
    const cands = [s.napcatDir, s.botDir, 'D:\\NapCat', 'C:\\NapCat', path.join(os.homedir(), 'NapCat'), path.join(os.homedir(), 'napcat')].filter(Boolean);
    for (const c of cands) {
      try { if (fs.existsSync(path.join(c, 'index.js')) && fs.existsSync(path.join(c, 'node.exe'))) return c; } catch (_) {}
    }
    for (const c of cands) {
      try { if (fs.existsSync(path.join(c, 'index.js'))) return c; } catch (_) {}
    }
    return '';
  };

  ipcMain.handle(CHANNELS.APP_VERSION, () => ({ version: getAppVersion() }));
  ipcMain.handle(CHANNELS.SETTINGS_GET, () => ({ settings: getSettings() }));

  // 机器人目录定位状态：打包版定位不到 botDir 时给出明确原因（而非静默空目录）
  ipcMain.handle(CHANNELS.BOTDIR_STATUS, () => {
    const s = getSettings();
    const configured = s.botDir || '';
    let exists = false, hasCore = false, isCheckout = false;
    try {
      exists = !!configured && fs.existsSync(configured);
      hasCore = exists && fs.existsSync(path.join(configured, 'ai_bridge.js'));
      isCheckout = exists && botDirResolver.isSourceCheckout(configured);
    } catch (_) {}
    if (!configured) {
      return {
        ok: true, configured: false, exists: false, hasCore: false, isCheckout: false,
        message: '未配置机器人目录，请点击「选择机器人目录」指定（含 ai_bridge.js 的目录）',
      };
    }
    if (!exists) {
      return {
        ok: true, configured: true, exists: false, hasCore: false, isCheckout: false,
        message: '配置的机器人目录已不存在，请重新选择',
      };
    }
    if (!hasCore) {
      return {
        ok: true, configured: true, exists: true, hasCore: false, isCheckout,
        message: '机器人目录中未找到 ai_bridge.js，机器人功能可能不可用',
      };
    }
    if (isCheckout) {
      // 发布副本：机器人会读写其配置与数据，需明确提示用户确认
      return {
        ok: true, configured: true, exists: true, hasCore: true, isCheckout: true,
        message: '当前机器人目录是源码检出（发布副本）。机器人会读写其中的配置、记忆与日志，请确认这是你要的工作目录。',
      };
    }
    return { ok: true, configured: true, exists: true, hasCore: true, isCheckout: false, message: '机器人目录正常' };
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
  // 导入他人机器人：检测目录结构与入口文件，给出兼容性判断
  ipcMain.handle(CHANNELS.BOT_INSPECT, (e, args) => {
    const v = validate(CHANNELS.BOT_INSPECT, args); if (!v.ok) return { ok: false, error: v.error };
    const dir = String(args.dir || '');
    const res = { ok: true, dir, exists: false, entries: [], kind: 'unknown', compatible: false, suggestedEntry: null, napcatEntry: null, notes: [], isNapcatDir: false, hasNode: false };
    try {
      res.exists = fs.existsSync(dir);
      if (!res.exists) { res.notes.push('目录不存在'); return res; }
      const has = (n) => { try { return fs.existsSync(path.join(dir, n)); } catch (_) { return false; } };
      res.hasNode = has('node.exe') || has('node');
      res.isNapcatDir = has('index.js') && (res.hasNode || has('napcat'));
      const entries = ['ai_bridge.js', 'index.js', 'app.js', 'main.js', 'bot.js', 'start.js'];
      res.entries = entries.filter(has);
      if (has('ai_bridge.js')) { res.kind = 'feiyu+ai'; res.compatible = true; res.suggestedEntry = 'ai_bridge.js'; res.napcatEntry = has('index.js') ? 'index.js' : null; }
      else if (has('index.js')) { res.kind = 'node-bot'; res.compatible = true; res.suggestedEntry = 'index.js'; res.napcatEntry = 'index.js'; }
      else if (has('koishi.yml') || has('koishi.config.js')) { res.kind = 'koishi'; res.compatible = true; res.suggestedEntry = res.entries[0] || null; res.notes.push('检测到 Koishi 项目'); }
      else if (has('package.json')) { res.kind = 'node-project'; res.compatible = true; res.suggestedEntry = res.entries[0] || null; res.notes.push('检测到 Node 项目（package.json）'); }
      else { res.notes.push('未找到常见入口文件（ai_bridge.js / index.js / app.js / main.js）'); }
      if (has('package.json')) {
        try { const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')); if (pkg && pkg.name) res.packageName = String(pkg.name); } catch (_) {}
      }
      if (!res.suggestedEntry && res.entries.length) res.suggestedEntry = res.entries[0];
    } catch (err) { return { ok: false, error: err.message }; }
    return res;
  });

  ipcMain.handle(CHANNELS.PROC_START, async (e, args) => {
    const v = validate(CHANNELS.PROC_START, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录（请先在「机器人运行」选择机器人目录）' };
    const settings = getSettings();
    const napcat = (args && args.napcat) || settings.napcat || null;
    const onlyNapcat = !!(args && args.only === 'napcat');

    // —— 只启动 NapCat（QQ 登录）：不依赖 AI 桥 / API Key，最适合新手 ——
    if (onlyNapcat) {
      if (!napcat || !napcat.account) return { ok: false, error: '请先填写 QQ 号（NapCat 登录需要）' };
      const napcatDir = resolveNapcatDir();
      if (!napcatDir) return { ok: false, error: '未找到 NapCat 目录（需含 index.js 与 node.exe，例如 D:\\NapCat）。请在「机器人运行」页点「选择 NapCat 目录…」指定。' };
      if (napcatDir !== settings.napcatDir) { try { setSettings(Object.assign({}, settings, { napcatDir })); } catch (_) {} }
      const owner = await pm.findPortOwner(pm.PORTS.napcat);
      if (owner) return { ok: true, alreadyRunning: true, pid: owner, onlyNapcat: true, napcatDir, note: 'NapCat 已在运行（端口 3000）' };
      const rn = await pm.startBotVerified(d, { napcat, settings, napcatDir, onlyNapcat: true, timeoutMs: 20000 });
      return {
        ok: rn.ok, started: rn.started, pids: rn.pids, failed: rn.failed, onlyNapcat: true, napcatDir,
        note: rn.ok ? 'NapCat 已启动并监听端口 3000（正在登录 QQ，稍候在实例里看状态）' : 'NapCat 启动失败，见 failed 的真实原因',
      };
    }

    const pre = await pm.preCheck();
    if (pre.alreadyRunning && !(args && args.force)) return { ok: false, alreadyRunning: true, status: pre.status, error: '机器人已在运行，避免重复启动' };
    const napcatDir = (napcat && napcat.account) ? resolveNapcatDir() : undefined;
    const r = await pm.startBotVerified(d, { napcat, settings, napcatDir });
    return {
      ok: r.ok,
      started: r.started, pids: r.pids, failed: r.failed,
      note: (secretService.hasUsableKey(d) ? '' : '未检测到 API Key，AI 桥可能启动后即退出（请先配置密钥）；')
        + (r.ok ? '已确认 AI 桥/NapCat 端口监听' : '部分服务启动失败，见 failed'),
    };
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

  // ================= 技能扩展 =================
  // 技能存 botDir/feiyu_skills.json，机器人每轮重读 → 保存即生效，无需重启。
  ipcMain.handle(CHANNELS.SKILL_LIST, () => {
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    return Object.assign({ ok: true }, skillService.list(d));
  });
  ipcMain.handle(CHANNELS.SKILL_SAVE, (e, args) => {
    const v = validate(CHANNELS.SKILL_SAVE, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const r = skillService.save(d, args.skill);
    if (!r.ok) return { ok: false, error: (r.errors || []).join('；') || '保存失败', errors: r.errors || [] };
    return { ok: true, id: r.id, skill: r.skill, note: '已保存，机器人下一轮对话即生效（无需重启）' };
  });
  ipcMain.handle(CHANNELS.SKILL_DELETE, (e, args) => {
    const v = validate(CHANNELS.SKILL_DELETE, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const r = skillService.remove(d, args.id);
    return r.ok ? { ok: true, note: '已删除，即时生效' } : { ok: false, error: r.error };
  });
  ipcMain.handle(CHANNELS.SKILL_COPY, (e, args) => {
    const v = validate(CHANNELS.SKILL_COPY, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const r = skillService.copy(d, args.id);
    return r.ok ? { ok: true, id: r.id, skill: r.skill } : { ok: false, error: r.error };
  });
  ipcMain.handle(CHANNELS.SKILL_SET_ENABLED, (e, args) => {
    const v = validate(CHANNELS.SKILL_SET_ENABLED, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const r = skillService.setEnabled(d, args.id, args.enabled);
    return r.ok ? { ok: true, id: r.id, enabled: r.enabled, note: '已更新，即时生效' } : { ok: false, error: r.error };
  });
  ipcMain.handle(CHANNELS.SKILL_TEMPLATES, () => ({ ok: true, templates: skillService.builtinTemplates() }));
  ipcMain.handle(CHANNELS.SKILL_IMPORT_TEMPLATE, (e, args) => {
    const v = validate(CHANNELS.SKILL_IMPORT_TEMPLATE, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const r = skillService.importTemplate(d, args.key);
    if (!r.ok) return { ok: false, error: r.error || (r.errors || []).join('；') };
    return { ok: true, id: r.id, skill: r.skill };
  });
  ipcMain.handle(CHANNELS.SKILL_EXPORT, () => {
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    return Object.assign({ ok: true }, skillService.exportAll(d));
  });
  ipcMain.handle(CHANNELS.SKILL_IMPORT, (e, args) => {
    const v = validate(CHANNELS.SKILL_IMPORT, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const r = skillService.importAll(d, args.payload);
    return r.ok ? { ok: true, added: r.added, skipped: r.skipped, note: '导入成功，即时生效' } : { ok: false, error: r.error };
  });

  // ================= ComfyUI 生图扩展 =================
  ipcMain.handle(CHANNELS.COMFY_DETECT, (e, args) => {
    const v = validate(CHANNELS.COMFY_DETECT, args); if (!v.ok) return { ok: false, error: v.error };
    const d = comfyService.detect({ dir: args && args.dir, endpoint: args && args.endpoint });
    return { ok: true, detect: d };
  });
  ipcMain.handle(CHANNELS.COMFY_STATUS, async (e, args) => {
    const v = validate(CHANNELS.COMFY_STATUS, args); if (!v.ok) return { ok: false, error: v.error };
    const d = comfyService.detect({ dir: args && args.dir, endpoint: args && args.endpoint });
    const conn = await comfyService.testConnection(d.endpoint);
    return { ok: true, detect: d, connection: conn };
  });
  ipcMain.handle(CHANNELS.COMFY_WORKFLOWS, (e, args) => {
    const v = validate(CHANNELS.COMFY_WORKFLOWS, args); if (!v.ok) return { ok: false, error: v.error };
    const b = needBotDir(); if (!b) return { ok: false, error: '未配置机器人目录' };
    return Object.assign({ ok: true }, comfyService.listWorkflows(b));
  });
  ipcMain.handle(CHANNELS.COMFY_PREREQ, async (e, args) => {
    const v = validate(CHANNELS.COMFY_PREREQ, args); if (!v.ok) return { ok: false, error: v.error };
    const b = needBotDir(); if (!b) return { ok: false, error: '未配置机器人目录' };
    const d = comfyService.detect({ dir: args && args.dir, endpoint: args && args.endpoint });
    // 机器人侧 LLM 是否已接入（多 Provider 里有可用且已应用的那一个）
    let llmOk = false, llmDetail = '未配置机器人目录';
    try {
      const pl = providerService.list(b, configService.readRaw(b).data);
      const applied = (pl.providers || []).find((p) => p.id === pl.appliedId);
      llmOk = !!(applied && applied.complete);
      llmDetail = llmOk ? ('已应用：' + applied.name + ' / ' + (applied.model || '')) : '尚未接入可用的大模型';
    } catch (e) { llmDetail = '读取 Provider 失败: ' + e.message; }
    const conn = await comfyService.testConnection(d.endpoint);
    const prereq = comfyService.checkPrerequisites(d.root, {
      ok: llmOk, detail: llmDetail, comfyRunning: conn.ok, comfyEndpoint: d.endpoint,
    });
    return { ok: true, prereq, detect: d, connection: conn };
  });
  ipcMain.handle(CHANNELS.COMFY_DOWNLOAD_MODEL, async (e, args) => {
    const v = validate(CHANNELS.COMFY_DOWNLOAD_MODEL, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const det = comfyService.detect({ dir: args.dir });
    const root = args.dir ? (comfyService.resolveComfyRoot(args.dir) || args.dir) : det.root;
    if (!root) return { ok: false, error: '未找到 ComfyUI 安装目录，请先在「安装 ComfyUI」或指定目录' };
    const r = await comfyService.downloadModel(root, args.key);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, path: r.path, bytes: r.bytes || 0, skipped: !!r.skipped, note: r.skipped ? '文件已存在，跳过下载' : '下载完成' };
  });
  ipcMain.handle(CHANNELS.COMFY_RELEASE, async (e, args) => {
    const v = validate(CHANNELS.COMFY_RELEASE, args); if (!v.ok) return { ok: false, error: v.error };
    const variant = (args && args.variant) || 'nvidia';
    const r = await comfyService.resolveComfyRelease(variant);
    return r.ok ? { ok: true, release: r } : { ok: false, error: r.error };
  });
  ipcMain.handle(CHANNELS.COMFY_INSTALL, async (e, args) => {
    const v = validate(CHANNELS.COMFY_INSTALL, args); if (!v.ok) return { ok: false, error: v.error };
    const variant = args.variant || 'nvidia';
    const r = await comfyService.installComfyUI(args.dir, variant);
    if (!r.ok) return { ok: false, error: redactText(r.error || '安装失败'), hint: r.hint || null };
    return { ok: true, install: r, note: '已安装到 ' + r.dir + '，请用其中的 run_nvidia_gpu.bat 启动' };
  });
  ipcMain.handle(CHANNELS.COMFY_PICKDIR, async () => {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'], title: '选择 ComfyUI 安装目录' });
      if (canceled || !filePaths || !filePaths.length) return { ok: true, dir: null };
      const d = filePaths[0];
      const root = comfyService.resolveComfyRoot(d);
      return { ok: true, dir: d, root: root, valid: !!root };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle(CHANNELS.COMFY_START, async (e, args) => {
    const v = validate(CHANNELS.COMFY_START, args); if (!v.ok) return { ok: false, error: v.error };
    // 关键修复：优先用参数目录，其次用已保存的 comfyDir（否则重启后找不到自定义安装路径）
    const cfg = getSettings();
    const det = comfyService.detect({ dir: (args && args.dir) || cfg.comfyDir, endpoint: args && args.endpoint });
    if (!det.found) return { ok: false, error: '本机未检测到 ComfyUI，请在「ComfyUI 生图」页选择安装目录（需含 main.py）' };
    // 已在运行则给出提示，不重复拉起
    const conn = await comfyService.testConnection(det.endpoint);
    if (conn.ok && conn.running) return { ok: true, alreadyRunning: true, pid: null, endpoint: det.endpoint };
    const spec = comfyService.launchSpec(det.root, { port: det.port });
    if (!spec.ok) return { ok: false, error: spec.error };
    const r = await pm.launchAndVerify(spec.spec, {
      checkUp: async () => { const c = await comfyService.testConnection(det.endpoint); return !!(c && c.ok && c.running); },
      timeoutMs: 45000,
    });
    // 进程仍存活但尚未监听：属「正在启动」（ComfyUI 首次加载模型较慢），不算失败
    if (r.ok && r.starting) return { ok: true, starting: true, pid: r.pid, port: det.port, endpoint: det.endpoint, note: 'ComfyUI 正在启动（首次加载较慢），稍后监控里端口 ' + det.port + ' 起来即成功' };
    if (!r.ok) return { ok: false, error: 'ComfyUI 启动失败：' + (r.error || ''), detail: r.stderrTail || null };
    return { ok: true, pid: r.pid, verified: true, port: det.port, endpoint: det.endpoint, note: '已确认监听 ' + det.endpoint };
  });
  ipcMain.handle(CHANNELS.COMFY_STOP, async (e, args) => {
    const v = validate(CHANNELS.COMFY_STOP, args); if (!v.ok) return { ok: false, error: v.error };
    const port = (args && args.port) || comfyService.DEFAULT_PORT;
    const owner = await pm.findPortOwner(port);
    if (!owner || !owner.pid) return { ok: true, stopped: false, reason: 'not_running' };
    await pm.stopByPids([owner.pid], { timeoutMs: 5000 });
    return { ok: true, stopped: true, pid: owner.pid };
  });

  // ================= 主题工坊 =================
  // 主题只存 userData/theme.json：与 ai_config.json / secrets.json / 机器人目录完全分离。
  // 读：缺失/损坏/校验失败一律回退默认主题；写：临时文件 + 原子重命名。
  const themeDir = () => getUserDataDir();
  ipcMain.handle(CHANNELS.THEME_GET, () => {
    const r = themeService.readTheme(themeDir());
    return {
      ok: true,
      theme: r.theme,
      derived: r.derived,
      fallback: r.fallback,
      error: r.error,
      presets: themeService.listPresets(),
    };
  });
  ipcMain.handle(CHANNELS.THEME_SAVE, (e, args) => {
    const v = validate(CHANNELS.THEME_SAVE, args); if (!v.ok) return { ok: false, error: v.error };
    const r = themeService.saveTheme(themeDir(), args.theme);
    if (!r.ok) return { ok: false, error: r.error, errors: r.errors || [] };
    return { ok: true, theme: r.theme, derived: r.derived, warnings: r.warnings || [] };
  });
  ipcMain.handle(CHANNELS.THEME_RESET, () => {
    const r = themeService.resetTheme(themeDir());
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, theme: r.theme, derived: r.derived };
  });
  ipcMain.handle(CHANNELS.THEME_PRESETS, () => ({ ok: true, presets: themeService.listPresets() }));
  ipcMain.handle(CHANNELS.THEME_EXPORT, () => {
    const r = themeService.exportTheme(themeDir());
    return { ok: true, json: r.json, theme: r.theme, derived: r.derived };
  });
  ipcMain.handle(CHANNELS.THEME_IMPORT, (e, args) => {
    const v = validate(CHANNELS.THEME_IMPORT, args); if (!v.ok) return { ok: false, error: v.error };
    const r = themeService.importTheme(themeDir(), args.json);
    // 非法 JSON / 校验失败 → 不改动当前主题
    if (!r.ok) return { ok: false, error: r.error, errors: r.errors || [], applied: false };
    return { ok: true, applied: true, theme: r.theme, derived: r.derived, warnings: r.warnings || [] };
  });

  // ==================================================================
  // 以下为「全量功能升级」新增的 A–J 模块处理器
  // 统一约定：先 validate → 再 needBotDir（涉及机器人目录时）→ 调用 service。
  // ==================================================================

  // -------- 通用小工具 --------
  const pushNote = (n) => { try { return diagnosticService.pushNotification(getUserDataDir(), n); } catch (_) { return { ok: false }; } };

  /** 固定参数执行外部命令（只读探测用；超时 5s，不拼接 shell）。 */
  const runFixedCommand = (cmd, argv) => new Promise((resolve) => {
    try {
      cp.execFile(cmd, argv, { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, error: err.message, stdout: String(stdout || ''), stderr: String(stderr || '') });
        resolve({ ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });

  /** 读取 JSON（仅 GET，超时保护）。 */
  const fetchJson = async (url, timeoutMs = 8000) => {
    if (typeof globalThis.fetch !== 'function') return { ok: false, error: '当前环境不支持 fetch' };
    try {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      const res = await globalThis.fetch(url, { method: 'GET', signal: ctrl ? ctrl.signal : undefined });
      if (timer) clearTimeout(timer);
      if (!res || !res.ok) return { ok: false, error: 'HTTP ' + (res ? res.status : '无响应') };
      const text = await res.text();
      try { return { ok: true, data: JSON.parse(text) }; } catch (_) { return { ok: false, error: '返回内容不是 JSON' }; }
    } catch (e) {
      return { ok: false, error: e && e.name === 'AbortError' ? '请求超时' : (e && e.message) || '请求失败' };
    }
  };

  // ==================== A. NapCat 实例与 QQ 登录中心 ====================
  // 登录会话只存内存（进程退出即失效）；二维码内容绝不写日志/通知/诊断包。
  const qrSessions = new Map();

  ipcMain.handle(CHANNELS.NAPCAT_QR_PLAN, () => {
    const s = getSettings();
    return napcatLoginService.qrLoginPlan({ endpoint: (s.napcat && s.napcat.qrEndpoint) || '' });
  });

  ipcMain.handle(CHANNELS.NAPCAT_QR_START, async (e, args) => {
    const v = validate(CHANNELS.NAPCAT_QR_START, args); if (!v.ok) return { ok: false, error: v.error };
    const settings = getSettings();
    const endpoint = (args && args.endpoint) || (settings.napcat && settings.napcat.qrEndpoint) || '';
    const session = napcatLoginService.createSession({ instanceId: (args && args.instanceId) || 'default' });
    session.endpoint = endpoint || null;

    // 1) 允许调用方直接给已取得的载荷（例如用户从 NapCat 控制台复制）
    if (args && args.qrPayload != null) {
      napcatLoginService.applyQr(session, args.qrPayload);
      qrSessions.set(session.id, session);
      return { ok: true, session: napcatLoginService.publicSession(session, { withQr: true }) };
    }
    // 2) 配置了接口 → 主动取一次二维码（用户显式点击触发）
    if (endpoint) {
      const r = await fetchJson(endpoint);
      if (!r.ok) {
        session.state = 'failed';
        session.message = '获取二维码失败：' + r.error;
        qrSessions.set(session.id, session);
        return { ok: false, error: session.message, session: napcatLoginService.publicSession(session) };
      }
      napcatLoginService.applyQr(session, r.data);
      qrSessions.set(session.id, session);
      return { ok: true, session: napcatLoginService.publicSession(session, { withQr: true }) };
    }
    // 3) 都没配 → 明确告知，不伪造二维码
    session.state = 'needs_endpoint';
    session.message = '尚未配置 NapCat 二维码接口地址。可填入接口地址后重试，或直接把接口返回的 JSON 作为 qrPayload 传入。';
    qrSessions.set(session.id, session);
    return { ok: true, needsEndpoint: true, session: napcatLoginService.publicSession(session) };
  });

  ipcMain.handle(CHANNELS.NAPCAT_QR_POLL, async (e, args) => {
    const v = validate(CHANNELS.NAPCAT_QR_POLL, args); if (!v.ok) return { ok: false, error: v.error };
    const session = qrSessions.get(args.sessionId);
    if (!session) return { ok: false, error: '登录会话不存在或已失效，请重新获取二维码' };
    let payload = args.payload || null;
    if (!payload && session.endpoint) {
      const r = await fetchJson(session.endpoint);
      if (!r.ok) return { ok: false, error: '轮询失败：' + r.error, session: napcatLoginService.publicSession(session) };
      payload = r.data;
    }
    if (!payload) return { ok: false, error: '缺少轮询载荷（payload），且会话未绑定接口地址' };
    napcatLoginService.applyPoll(session, payload);
    if (session.state === 'ok') {
      // 登录成功：更新实例最近登录时间（不记录任何凭据）
      const d = needBotDir();
      if (d) napcatLoginService.markLoggedIn(d, session.instanceId);
      pushNote({ title: 'QQ 登录成功', message: '实例 ' + session.instanceId + ' 已完成扫码登录', level: 'success', source: 'napcat' });
      qrSessions.delete(session.id);
    }
    if (session.state === 'expired' || session.state === 'failed') qrSessions.delete(session.id);
    return { ok: true, session: napcatLoginService.publicSession(session, { withQr: session.state === 'pending' || session.state === 'scanned' }) };
  });

  ipcMain.handle(CHANNELS.NAPCAT_INSTANCE_LIST, () => {
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录', instances: [] };
    return napcatLoginService.listInstances(d);
  });
  ipcMain.handle(CHANNELS.NAPCAT_INSTANCE_SAVE, (e, args) => {
    const v = validate(CHANNELS.NAPCAT_INSTANCE_SAVE, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const r = napcatLoginService.saveInstance(d, args.instance);
    if (!r.ok) return { ok: false, error: (r.errors || []).join('；') || '保存失败', errors: r.errors || [] };
    return { ok: true, instance: r.instance, created: r.created, note: '已保存实例（不含密码；密码 MD5 仅在启动时经环境变量注入）' };
  });
  ipcMain.handle(CHANNELS.NAPCAT_INSTANCE_DELETE, (e, args) => {
    const v = validate(CHANNELS.NAPCAT_INSTANCE_DELETE, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const r = napcatLoginService.removeInstance(d, args.id);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  });

  // ==================== B. 统一服务编排与一键启动 ====================
  const registry = () => serviceRegistry.createRegistry({ botDir: needBotDir() || '' });

  ipcMain.handle(CHANNELS.SERVICE_LIST, () => {
    const d = needBotDir();
    const reg = serviceRegistry.createRegistry({ botDir: d || '' });
    return {
      ok: true,
      botDirConfigured: !!d,
      services: reg.allServices(),
      presets: reg.presets(),
      builtin: serviceRegistry.BUILTIN_SERVICES,
      ports: { bridge: 3001, napcat: 3000, comfyui: 8188 },
    };
  });
  ipcMain.handle(CHANNELS.SERVICE_SAVE, (e, args) => {
    const v = validate(CHANNELS.SERVICE_SAVE, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const r = registry().addService(args.service);
    if (!r.ok) return { ok: false, error: (r.errors || [r.error]).filter(Boolean).join('；'), errors: r.errors || [] };
    return { ok: true, id: r.id };
  });
  ipcMain.handle(CHANNELS.SERVICE_DELETE, (e, args) => {
    const v = validate(CHANNELS.SERVICE_DELETE, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const r = registry().removeService(args.id);
    return r.ok ? { ok: true } : { ok: false, error: (r.errors || [r.error]).filter(Boolean).join('；') };
  });
  ipcMain.handle(CHANNELS.SERVICE_PRESETS, () => ({ ok: true, presets: registry().presets() }));
  ipcMain.handle(CHANNELS.SERVICE_PRESET_SAVE, (e, args) => {
    const v = validate(CHANNELS.SERVICE_PRESET_SAVE, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const r = registry().addPreset(args.preset);
    return r.ok ? { ok: true, presets: registry().presets() } : { ok: false, error: r.error };
  });
  ipcMain.handle(CHANNELS.SERVICE_PRESET_DELETE, (e, args) => {
    const v = validate(CHANNELS.SERVICE_PRESET_DELETE, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const r = registry().removePreset(args.id);
    return r.ok ? { ok: true, presets: registry().presets() } : { ok: false, error: r.error };
  });
  ipcMain.handle(CHANNELS.SERVICE_PLAN, async (e, args) => {
    const v = validate(CHANNELS.SERVICE_PLAN, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const plan = registry().planPreset(args.presetId);
    if (!plan.ok) return { ok: false, error: plan.error };
    // 叠加真实端口占用情况（只读）
    const live = {};
    for (const s of plan.services) {
      if (s.port) live[s.id] = await pm.findPortOwner(s.port);
    }
    return { ok: true, plan, liveOwners: live, blocked: plan.hasCycle || plan.portConflicts.length > 0 };
  });
  ipcMain.handle(CHANNELS.SERVICE_START_PRESET, async (e, args) => {
    const v = validate(CHANNELS.SERVICE_START_PRESET, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const plan = registry().planPreset(args.presetId);
    if (!plan.ok) return { ok: false, error: plan.error };
    if (plan.hasCycle) return { ok: false, error: '存在依赖环，已阻止启动: ' + (plan.cycle || []).join(' → '), plan };
    if (plan.portConflicts.length && !args.force) {
      return { ok: false, error: '预设内存在端口冲突，已阻止启动（确认后可强制）', plan, portConflicts: plan.portConflicts };
    }
    const settings = getSettings();
    const started = [];
    const skipped = [];
    const failed = [];
    for (const id of plan.order) {
      const svc = plan.services.find((s) => s.id === id);
      if (!svc) continue;
      // 已占用端口 → 跳过，不重复拉起
      if (svc.port) {
        const owner = await pm.findPortOwner(svc.port);
        if (owner) { skipped.push({ id, pid: owner, reason: 'already_running', port: svc.port }); continue; }
      }
      const napcatOpts = (svc.type === 'napcat' && settings.napcat)
        ? { account: settings.napcat.account, passwordMd5: settings.napcat.passwordMd5 }
        : {};
      const desc = serviceRegistry.describeStart(svc, napcatOpts);
      if (!desc.ok) { failed.push({ id, error: desc.error }); continue; }
      const verifyPort = svc.type === 'bridge' ? pm.PORTS.bridge
        : svc.type === 'napcat' ? pm.PORTS.napcat
        : svc.type === 'comfyui' ? (svc.port || comfyService.DEFAULT_PORT)
        : null;
      const spec = (svc.type === 'bridge' || svc.type === 'napcat')
        ? { command: pm.resolveNodeBin(d, settings), args: desc.command, cwd: d, env: desc.env }
        : svc.type === 'comfyui'
          ? { command: settings.pythonBin || 'python', args: desc.command, cwd: settings.comfyDir || d, env: {} }
          : { command: desc.command[0], args: desc.command.slice(1), cwd: svc.cwd || d, env: {} };
      const r = await pm.launchAndVerify(spec, { port: verifyPort, timeoutMs: 15000 });
      if (r.ok) started.push({ id, pid: r.pid }); else failed.push({ id, error: r.error });
    }
    if (failed.length) pushNote({ title: '部分服务启动失败', message: failed.map((f) => f.id + ': ' + f.error).join('；'), level: 'warn', source: 'services' });
    return { ok: true, started, skipped, failed, order: plan.order, warnings: plan.warnings };
  });

  // ==================== C. ComfyUI 环境检测（只读） ====================
  ipcMain.handle(CHANNELS.ENV_DETECT, async (e, args) => {
    const v = validate(CHANNELS.ENV_DETECT, args); if (!v.ok) return { ok: false, error: v.error };
    const settings = getSettings();
    const dir = (args && args.dir) || settings.comfyDir || '';
    const env = await envDetector.detectEnvironment({ dir, runCommand: runFixedCommand });
    return { ok: true, env };
  });

  // ==================== D. MCP 外部导入与权限中心 ====================
  ipcMain.handle(CHANNELS.MCP_LIST, () => {
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录', servers: [] };
    return mcpService.list(d);
  });
  ipcMain.handle(CHANNELS.MCP_PARSE, (e, args) => {
    const v = validate(CHANNELS.MCP_PARSE, args); if (!v.ok) return { ok: false, error: v.error };
    return mcpService.parseConfig(args.payload);
  });
  ipcMain.handle(CHANNELS.MCP_IMPORT, (e, args) => {
    const v = validate(CHANNELS.MCP_IMPORT, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    return mcpService.importConfig(d, args.payload, { overwrite: !!args.overwrite });
  });
  ipcMain.handle(CHANNELS.MCP_SET_ENABLED, (e, args) => {
    const v = validate(CHANNELS.MCP_SET_ENABLED, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    return mcpService.setEnabled(d, args.name, args.enabled);
  });
  ipcMain.handle(CHANNELS.MCP_DELETE, (e, args) => {
    const v = validate(CHANNELS.MCP_DELETE, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    return mcpService.remove(d, args.name);
  });
  ipcMain.handle(CHANNELS.MCP_EXPORT, () => {
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    return mcpService.exportAll(d);
  });

  // ==================== E. 技能树与分类扩展 ====================
  ipcMain.handle(CHANNELS.SKILL_TREE, () => {
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const list = skillService.list(d);
    return skillTreeService.buildTree(list.skills, { botDir: d });
  });
  ipcMain.handle(CHANNELS.SKILL_CATEGORY_LIST, () => {
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录', categories: skillTreeService.BUILTIN_CATEGORIES };
    return { ok: true, categories: skillTreeService.allCategories(d) };
  });
  ipcMain.handle(CHANNELS.SKILL_CATEGORY_ADD, (e, args) => {
    const v = validate(CHANNELS.SKILL_CATEGORY_ADD, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const r = skillTreeService.addCategory(d, args.category);
    if (!r.ok) return { ok: false, error: (r.errors || [r.error]).filter(Boolean).join('；') };
    return { ok: true, id: r.id, categories: skillTreeService.allCategories(d) };
  });
  ipcMain.handle(CHANNELS.SKILL_CATEGORY_DELETE, (e, args) => {
    const v = validate(CHANNELS.SKILL_CATEGORY_DELETE, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const r = skillTreeService.removeCategory(d, args.id);
    if (!r.ok) return { ok: false, error: (r.errors || [r.error]).filter(Boolean).join('；') };
    return { ok: true, note: r.note, categories: skillTreeService.allCategories(d) };
  });

  // ==================== F. 市场接入（华为云 / 通用 / 本地） ====================
  ipcMain.handle(CHANNELS.MARKET_SOURCES, () => marketService.listSources());
  ipcMain.handle(CHANNELS.MARKET_PARSE, (e, args) => {
    const v = validate(CHANNELS.MARKET_PARSE, args); if (!v.ok) return { ok: false, error: v.error };
    return marketService.parseCatalog(args.payload);
  });
  ipcMain.handle(CHANNELS.MARKET_FETCH, async (e, args) => {
    const v = validate(CHANNELS.MARKET_FETCH, args); if (!v.ok) return { ok: false, error: v.error };
    // 令牌仅在本次请求内使用，不落盘、不写日志
    const r = await marketService.fetchCatalog(args.sourceId, args.endpoint, { token: args.token || '', timeoutMs: 15000 });
    if (!r.ok) return { ok: false, error: redactText(r.error), needsAuth: !!r.needsAuth };
    return { ok: true, items: r.items, warnings: r.warnings, errors: r.errors, meta: r.meta, tokenUsed: !!args.token };
  });
  ipcMain.handle(CHANNELS.MARKET_PLAN, (e, args) => {
    const v = validate(CHANNELS.MARKET_PLAN, args); if (!v.ok) return { ok: false, error: v.error };
    return { ok: true, plan: marketService.planImport(args.item, { hasToken: !!args.hasToken }) };
  });

  // ==================== G. 配置备份 / 恢复 / 升级保护 ====================
  ipcMain.handle(CHANNELS.BACKUP_LIST, () => {
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录', backups: [] };
    return backupService.listBackups(d);
  });
  ipcMain.handle(CHANNELS.BACKUP_CREATE, (e, args) => {
    const v = validate(CHANNELS.BACKUP_CREATE, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const r = backupService.createBackup(d, {
      includeSecret: !!(args && args.includeSecret),
      label: (args && args.label) || '',
      appVersion: getAppVersion(),
    });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, id: r.id, fileCount: r.fileCount, skipped: r.skipped, includeSecret: r.includeSecret, note: r.note };
  });
  ipcMain.handle(CHANNELS.BACKUP_DIFF, (e, args) => {
    const v = validate(CHANNELS.BACKUP_DIFF, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    return backupService.diffBackup(d, args.id);
  });
  ipcMain.handle(CHANNELS.BACKUP_RESTORE, (e, args) => {
    const v = validate(CHANNELS.BACKUP_RESTORE, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const r = backupService.restoreBackup(d, args.id, {
      includeSecret: !!(args && args.includeSecret),
      force: !!(args && args.force),
      appVersion: getAppVersion(),
    });
    if (r.ok && !r.noop) pushNote({ title: '配置已从备份恢复', message: '备份 ' + args.id + '，恢复 ' + (r.restored || []).length + ' 个文件', level: 'success', source: 'backup' });
    if (!r.ok) pushNote({ title: '配置恢复失败', message: redactText(r.error || '未知错误'), level: 'error', source: 'backup' });
    return r;
  });
  ipcMain.handle(CHANNELS.BACKUP_DELETE, (e, args) => {
    const v = validate(CHANNELS.BACKUP_DELETE, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    return backupService.deleteBackup(d, args.id);
  });

  // ==================== H. 可视化自动化工作流 ====================
  ipcMain.handle(CHANNELS.WORKFLOW_LIST, () => {
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录', workflows: [] };
    return workflowService.list(d);
  });
  ipcMain.handle(CHANNELS.WORKFLOW_GET, (e, args) => {
    const v = validate(CHANNELS.WORKFLOW_GET, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    return workflowService.get(d, args.id);
  });
  ipcMain.handle(CHANNELS.WORKFLOW_SAVE, (e, args) => {
    const v = validate(CHANNELS.WORKFLOW_SAVE, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const r = workflowService.save(d, args.workflow);
    if (!r.ok) return { ok: false, error: (r.errors || [r.error]).filter(Boolean).join('；'), errors: r.errors || [] };
    return { ok: true, id: r.id, created: r.created, warnings: r.warnings };
  });
  ipcMain.handle(CHANNELS.WORKFLOW_DELETE, (e, args) => {
    const v = validate(CHANNELS.WORKFLOW_DELETE, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const r = workflowService.remove(d, args.id);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  });
  ipcMain.handle(CHANNELS.WORKFLOW_RUN, async (e, args) => {
    const v = validate(CHANNELS.WORKFLOW_RUN, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const g = workflowService.get(d, args.id);
    if (!g.ok) return { ok: false, error: g.error };
    const reg = registry();
    const result = await workflowService.runWorkflow(g.workflow, {
      dryRun: args.dryRun !== false,
      vars: args.vars || {},
      listServices: () => reg.allServices().map((s) => s.id),
      onNotify: (n) => pushNote({ title: n.title, message: n.message, level: 'info', source: 'workflow:' + n.workflowId }),
      // 安全策略：工作流内**不**直接拉起服务（避免误启动真实机器人）；
      // 如需启动服务请到「服务编排」页显式操作。
      onServiceCall: () => ({ ok: true, detail: '已按安全策略跳过（请在「服务编排」页显式启动）' }),
    });
    if (!result.ok) pushNote({ title: '工作流执行失败', message: redactText(result.error || ''), level: 'error', source: 'workflow' });
    return { ok: result.ok, run: result };
  });

  // ==================== I. 用量与成本管理 ====================
  ipcMain.handle(CHANNELS.COST_REPORT, async (e, args) => {
    const v = validate(CHANNELS.COST_REPORT, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录' };
    const range = (args && args.range) || 'today';
    const status = await pm.getStatus();
    const livePort = status.bridge.running ? status.bridge.port : null;
    const usage = await usageService.getUsage(d, range, {
      livePort,
      deps: livePort ? { headers: usageAuthHeaders(d) } : undefined,
    });
    const report = costService.buildCostReport(usage, getPrice(), { budget: costService.getBudget(getUserDataDir()), range });
    return { ok: true, report };
  });
  ipcMain.handle(CHANNELS.COST_BUDGET_GET, () => ({ ok: true, budget: costService.getBudget(getUserDataDir()) }));
  ipcMain.handle(CHANNELS.COST_BUDGET_SET, (e, args) => {
    const v = validate(CHANNELS.COST_BUDGET_SET, args); if (!v.ok) return { ok: false, error: v.error };
    const r = costService.setBudget(getUserDataDir(), args.budget);
    if (!r.ok) return { ok: false, error: (r.errors || [r.error]).filter(Boolean).join('；') };
    return { ok: true, budget: r.budget };
  });

  // ==================== J. 日志 / 诊断 / 通知中心 ====================
  const collectDiag = async () => {
    const d = needBotDir();
    const settings = getSettings();
    const status = await pm.getStatus();
    const services = [
      { id: 'bridge', port: status.bridge.port, running: status.bridge.running },
      { id: 'napcat', port: status.napcat.port, running: status.napcat.running },
    ];
    let providerCount = 0;
    let skillsCount = 0;
    let mcpCount = 0;
    let workflowCount = 0;
    let isCheckout = false;
    if (d) {
      try { providerCount = providerService.list(d, configService.readRaw(d).data).providers.length; } catch (_) {}
      try { skillsCount = skillService.list(d).skills.length; } catch (_) {}
      try { mcpCount = mcpService.list(d).servers.length; } catch (_) {}
      try { workflowCount = workflowService.list(d).workflows.length; } catch (_) {}
      try { isCheckout = botDirResolver.isSourceCheckout(d); } catch (_) {}
    }
    return diagnosticService.collectDiagnostics({
      appVersion: getAppVersion(),
      electronVersion: (process.versions && process.versions.electron) || '',
      nodeVersion: (process.versions && process.versions.node) || '',
      platform: process.platform,
      arch: process.arch,
      locale: process.env.LANG || process.env.LANGUAGE || '',
      userDataDir: getUserDataDir(),
      botDir: d || '',
      isCheckout,
      settings,
      services,
      providerCount,
      skillsCount,
      mcpCount,
      workflowCount,
      logs: (() => { try { return logService.readTail(d, 50).lines.map((l) => ({ level: 'info', message: l })); } catch (_) { return []; } })(),
    });
  };

  ipcMain.handle(CHANNELS.DIAG_COLLECT, async () => {
    const diag = await collectDiag();
    return { ok: true, diagnostics: diag };
  });
  ipcMain.handle(CHANNELS.DIAG_EXPORT, async () => {
    const diag = await collectDiag();
    const json = diagnosticService.buildBundle(diag);
    return { ok: true, json, bytes: Buffer.byteLength(json, 'utf8'), note: '已脱敏：不含密钥、令牌、完整路径或配置内容' };
  });
  ipcMain.handle(CHANNELS.NOTIFY_LIST, (e, args) => {
    const v = validate(CHANNELS.NOTIFY_LIST, args); if (!v.ok) return { ok: false, error: v.error };
    return diagnosticService.listNotifications(getUserDataDir(), {
      level: (args && args.level) || null,
      unreadOnly: !!(args && args.unreadOnly),
      limit: (args && args.limit) || 50,
    });
  });
  ipcMain.handle(CHANNELS.NOTIFY_MARK_READ, (e, args) => {
    const v = validate(CHANNELS.NOTIFY_MARK_READ, args); if (!v.ok) return { ok: false, error: v.error };
    return diagnosticService.markRead(getUserDataDir(), args.id);
  });
  ipcMain.handle(CHANNELS.NOTIFY_CLEAR, () => diagnosticService.clearNotifications(getUserDataDir()));

  // ==================== K. 终端 / 实时状态监控 / 实时日志流 ====================
  const HELP_TEXT = [
    '肥鱼本地终端 —— 命令在本机执行，软件会如实执行你输入的每一条指令。',
    '内置命令（其余按系统 Shell 执行）：',
    '  help              显示本帮助',
    '  version           显示软件版本',
    '  status            查看 AI 桥 / NapCat / ComfyUI 实时状态',
    '  start [bot|comfy] 启动机器人（默认）或 ComfyUI',
    '  stop  [bot|comfy] 停止机器人（默认）或 ComfyUI',
    '  restart [bot]     重启机器人',
    '  clear             清屏',
    '示例：dir / ls / npm -v / python -V / start comfy',
  ].join('\r\n') + '\r\n';

  /** 控制命令分发：命中返回 true（不再交给 Shell）。输出经 emit 推回终端。 */
  async function runControlCommand(line, sessionId) {
    const t = String(line || '').trim();
    const lc = t.toLowerCase();
    const out = (stream, text) => emit('TERMINAL_OUTPUT', { sessionId, stream, text });
    if (lc === 'help' || lc === '?') { out('system', HELP_TEXT); return true; }
    if (lc === 'clear') { emit('TERMINAL_CLEAR', { sessionId }); return true; }
    if (lc === 'version') { out('system', '肥鱼桌面控制中心 v' + getAppVersion() + '\r\n'); return true; }
    if (lc === 'status') {
      const status = await pm.getStatus();
      const det = comfyService.detect({});
      const conn = await comfyService.testConnection(det.endpoint);
      const fmtS = (s) => (s.running ? ('运行中 (PID ' + s.pid + ')') : '已停止');
      out('system', [
        'AI 桥(Bridge): ' + fmtS(status.bridge) + '  端口 ' + status.bridge.port,
        'NapCat:        ' + fmtS(status.napcat) + '  端口 ' + status.napcat.port,
        'ComfyUI:       ' + ((conn.ok && conn.running) ? ('运行中 ' + det.endpoint) : (det.found ? '已停止' : '未检测到')),
        '机器人目录:     ' + (botDir() || '（未配置）'),
      ].join('\r\n') + '\r\n');
      return true;
    }
    const m = lc.match(/^(start|stop|restart)(?:\s+(bot|comfy))?$/);
    if (m) {
      const op = m[1];          // start | stop | restart
      const target = m[2] || 'bot';
      if (target === 'comfy') return await runComfyCtrl(op, sessionId, out);
      return await runBotCtrl(op, sessionId, out);
    }
    return false;
  }

  async function runBotCtrl(op, sessionId, out) {
    const d = needBotDir();
    if (!d) { out('system', '未配置机器人目录，无法启动/停止机器人。请先在「机器人运行」选择目录。\r\n'); return true; }
    if (op === 'stop' || op === 'restart') {
      const s = await pm.getStatus();
      const pids = [s.bridge.pid, s.napcat.pid].filter(Boolean);
      if (!pids.length) out('system', '机器人未在运行。\r\n');
      else {
        out('system', '正在停止机器人 (PID ' + pids.join(', ') + ')…\r\n');
        const r = await pm.stopByPids(pids, { timeoutMs: 5000 });
        out('system', r.ok ? '已停止。\r\n' : '停止失败: ' + (r.error || '未知') + '\r\n');
      }
      if (op === 'stop') return true;
    }
    // start / restart
    const pre = await pm.preCheck();
    if (pre.alreadyRunning && op !== 'restart') { out('system', '机器人已在运行，无需重复启动。\r\n'); return true; }
    const settings = getSettings();
    const napcat = settings.napcat || null;
    out('system', '正在启动机器人（已剥离电子壳环境变量，避免干扰子进程）…\r\n');
    const r = await pm.startBotVerified(d, { napcat, settings });
    if (r.ok) {
      out('system', '已确认启动：AI 桥' + (r.started.bridge && r.started.bridge.pid ? ' (PID ' + r.started.bridge.pid + ')' : '')
        + (r.started.napcat && r.started.napcat.pid ? '，NapCat (PID ' + r.started.napcat.pid + ')' : '') + '，端口已监听。\r\n');
    } else {
      const detail = (r.failed || []).map((f) => f.id + '：' + f.error).join('\r\n  ');
      out('system', '启动失败：\r\n  ' + (detail || '未知原因') + '\r\n');
    }
    return true;
  }

  async function runComfyCtrl(op, sessionId, out) {
    const det = comfyService.detect({ dir: getSettings().comfyDir });
    if (!det.found) { out('system', '本机未检测到 ComfyUI，请先在「ComfyUI 生图」安装或指定目录。\r\n'); return true; }
    if (op === 'stop') {
      const owner = await pm.findPortOwner(det.port);
      if (!owner || !owner.pid) { out('system', 'ComfyUI 未在运行。\r\n'); return true; }
      out('system', '正在停止 ComfyUI (PID ' + owner.pid + ')…\r\n');
      await pm.stopByPids([owner.pid], { timeoutMs: 5000 });
      out('system', '已停止。\r\n');
      return true;
    }
    // start / restart
    if (op === 'restart') {
      const owner = await pm.findPortOwner(det.port);
      if (owner && owner.pid) await pm.stopByPids([owner.pid], { timeoutMs: 5000 });
    } else {
      const conn = await comfyService.testConnection(det.endpoint);
      if (conn.ok && conn.running) { out('system', 'ComfyUI 已在运行 (' + det.endpoint + ')。\r\n'); return true; }
    }
    const spec = comfyService.launchSpec(det.root, { port: det.port });
    if (!spec.ok) { out('system', '启动失败: ' + spec.error + '\r\n'); return true; }
    out('system', '正在启动 ComfyUI（稍候校验端口 ' + det.port + '）…\r\n');
    const r = await pm.launchAndVerify(spec.spec, {
      checkUp: async () => { const c = await comfyService.testConnection(det.endpoint); return !!(c && c.ok && c.running); },
      timeoutMs: 45000,
    });
    if (r.ok && r.starting) out('system', 'ComfyUI 正在启动 (PID ' + r.pid + ')，首次加载较慢，稍候用 status 确认端口。\r\n');
    else out('system', r.ok ? ('已确认启动 (PID ' + r.pid + ')，端口 ' + det.port + ' 已监听。\r\n') : ('启动失败: ' + (r.error || '') + '\r\n'));
    return true;
  }

  ipcMain.handle(CHANNELS.TERMINAL_OPEN, (e, args) => {
    const v = validate(CHANNELS.TERMINAL_OPEN, args); if (!v.ok) return { ok: false, error: v.error };
    // 工作目录：优先用户配置的机器人目录，否则本应用 userData（绝不在开发机硬编码路径）
    const cwd = (args && args.cwd) || botDir() || getUserDataDir();
    return terminal.open({ cwd });
  });
  ipcMain.handle(CHANNELS.TERMINAL_INPUT, async (e, args) => {
    const v = validate(CHANNELS.TERMINAL_INPUT, args); if (!v.ok) return { ok: false, error: v.error };
    const line = (args && args.line || '').replace(/\r?\n$/, '');
    const sessionId = args.sessionId;
    if (!line.trim()) return { ok: true, handled: false };
    if (await runControlCommand(line, sessionId)) return { ok: true, handled: true };
    const r = terminal.write(sessionId, line + '\n');
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, handled: false };
  });
  ipcMain.handle(CHANNELS.TERMINAL_CLOSE, (e, args) => {
    const v = validate(CHANNELS.TERMINAL_CLOSE, args); if (!v.ok) return { ok: false, error: v.error };
    return terminal.close(args.sessionId);
  });

  // —— 系统性能：本软件（Electron 全进程）+ 机器人进程 的合并占用 ——
  let _botSample = { t: 0, map: {} };
  function sampleBotPerf(pids) {
    return new Promise((resolve) => {
      try {
        const cmd = 'Get-Process -Id ' + pids.join(',') + ' -ErrorAction SilentlyContinue | Select-Object Id,CPU,WorkingSet64 | ConvertTo-Json -Compress';
        cp.execFile('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 4000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
          if (err) return resolve({ memMB: 0, cpuPercent: 0 });
          let arr = [];
          try { const j = JSON.parse(String(stdout || 'null')); arr = Array.isArray(j) ? j : (j ? [j] : []); } catch (_) {}
          let memBytes = 0; const map = {};
          for (const p of arr) { if (!p || p.Id == null) continue; map[p.Id] = Number(p.CPU) || 0; memBytes += Number(p.WorkingSet64) || 0; }
          const now = Date.now();
          const dt = (now - _botSample.t) / 1000;
          let cpuPercent = 0;
          if (_botSample.t && dt > 0.5) {
            let deltaSec = 0;
            for (const id of Object.keys(map)) if (_botSample.map[id] != null) deltaSec += Math.max(0, map[id] - _botSample.map[id]);
            const cores = Math.max(1, os.cpus().length);
            cpuPercent = (deltaSec / (dt * cores)) * 100;
          }
          _botSample = { t: now, map };
          resolve({ memMB: memBytes / 1048576, cpuPercent });
        });
      } catch (_) { resolve({ memMB: 0, cpuPercent: 0 }); }
    });
  }
  async function collectPerf(status) {
    let appMem = 0, appCpu = 0, appCount = 0;
    try {
      const metrics = (app && app.getAppMetrics) ? app.getAppMetrics() : [];
      for (const m of metrics) {
        appMem += ((m.memory && m.memory.workingSetSize) || 0) / 1024; // KB -> MB
        appCpu += (m.cpu && m.cpu.percentCPUUsage) || 0;
        appCount++;
      }
    } catch (_) {}
    const det = comfyService.detect({ dir: getSettings().comfyDir });
    const comfyPid = await pm.findPortOwner(det.port);
    const pids = [status.bridge && status.bridge.pid, status.napcat && status.napcat.pid, comfyPid].filter(Boolean);
    let bot = { memMB: 0, cpuPercent: 0 };
    if (pids.length) bot = await sampleBotPerf(pids);
    return {
      app: { cpuPercent: Math.round(appCpu), memMB: Math.round(appMem), processes: appCount },
      bot: { cpuPercent: Math.round(bot.cpuPercent), memMB: Math.round(bot.memMB), processes: pids.length },
      total: { cpuPercent: Math.round(appCpu + bot.cpuPercent), memMB: Math.round(appMem + bot.memMB) },
    };
  }

  ipcMain.handle(CHANNELS.MONITOR_STATUS, async () => {
    const status = await pm.getStatus();
    const det = comfyService.detect({ dir: getSettings().comfyDir });
    const conn = await comfyService.testConnection(det.endpoint);
    let perf = null;
    try { perf = await collectPerf(status); } catch (_) { perf = null; }
    return {
      ok: true,
      monitor: {
        bridge: { running: status.bridge.running, pid: status.bridge.pid, port: status.bridge.port },
        napcat: { running: status.napcat.running, pid: status.napcat.pid, port: status.napcat.port },
        comfy: { running: !!(conn.ok && conn.running), endpoint: det.endpoint, port: det.port, found: det.found, version: conn.version || null },
        botDirConfigured: !!botDir(),
        time: Date.now(),
      },
      perf,
    };
  });

  ipcMain.handle(CHANNELS.LOG_STREAM_START, (e, args) => {
    const v = validate(CHANNELS.LOG_STREAM_START, args); if (!v.ok) return { ok: false, error: v.error };
    const d = needBotDir(); if (!d) return { ok: false, error: '未配置机器人目录', lines: [] };
    const r = logTail.start(d, { lines: (args && args.lines) || 200, interval: 1000 });
    return { ok: true, lines: r.recent, path: r.path, exists: r.exists };
  });
  ipcMain.handle(CHANNELS.LOG_STREAM_STOP, () => { logTail.stop(); return { ok: true }; });
}

module.exports = { registerHandlers };
