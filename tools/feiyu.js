'use strict';
// ================= 肥鱼升级：新增工具注册（阶段 B/C/D/E/F 接入） =================
// 统一通过现有 tool_router 注册；每个工具默认按配置门控、仅管理员可调用。
// 高危动作（建任务/浏览器/发布/语音）一律 adminOnly，普通群成员或网页输入无法越权。

const router = require('../agent/tool_router');
const R = require('./result');
const { isAdmin } = require('../feiyu/permissions');
const { getFeiyu, initFeiyu } = require('../feiyu/index');

// 仅管理员可调用（普通群成员 / 外部网页输入会被拒）
function adminOnly(ctx, adminList) {
  const uid = ctx && (ctx.userId || (ctx.sessionId && ctx.sessionId.slice(8)));
  if (!isAdmin(uid, adminList)) return { ok: false, error: '仅管理员可操作' };
  return { ok: true };
}

function register(deps) {
  deps = deps || {};
  const config = deps.config || {};
  const adminList = (config.admin && config.admin.qq) || deps.adminList || [];
  if (!config.feiyu && !config.taskManager && !config.browser && !config.notifier && !config.tts && !config.qzone) {
    // 没有任何肥鱼配置段：仍允许通过 deps 注入的 config 初始化（默认全关），但不注册任何工具
  }
  initFeiyu(config, deps);
  const F = getFeiyu();
  const out = [];
  if (!F) return out;

  // ---------- 任务管理 ----------
  if (config.taskManager && config.taskManager.enabled) {
    router.registerTool({
      name: 'task_create',
      description: '创建一个可调度/可追踪的任务（由主人下达）。支持一次性、每日定时、间隔触发。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200, description: '任务标题' },
          type: { type: 'string', maxLength: 32, description: '任务类型：generic/browse/fetch/custom' },
          payload: { type: 'object', description: '任务参数（如 {url:...}）' },
          cron: { type: 'string', maxLength: 64, description: '每日定时 HH:MM' },
          runAt: { type: 'string', maxLength: 32, description: '一次性触发：ISO 时间或 HH:MM' },
          intervalMin: { type: 'number', minimum: 1, maximum: 100000 },
          idempotencyKey: { type: 'string', maxLength: 128, description: '幂等键，防重复触发' },
          priority: { type: 'number', minimum: 0, maximum: 100 },
        },
        required: ['title'],
        additionalProperties: false,
      },
      permission: router.PERMISSION.LIMITED,
      timeout: 10000, tokenCost: 0, riskLevel: 'medium',
      safety: (a, ctx) => adminOnly(ctx, adminList),
      handler: async (a, ctx) => {
        const r = F.taskManager.create({
          title: a.title, type: a.type, payload: a.payload, cron: a.cron, runAt: a.runAt,
          intervalMin: a.intervalMin, idempotencyKey: a.idempotencyKey, priority: a.priority,
          ownerId: ctx && (ctx.userId || (ctx.sessionId && ctx.sessionId.slice(8))),
        });
        return R.okResult('task_create', r, '任务已创建: ' + (r.task && r.task.id), { id: r.id, duplicate: r.duplicate });
      },
    }); out.push('task_create');

    for (const [name, verb, fn] of [['task_pause', '暂停', (id) => F.taskManager.pause(id)],
      ['task_resume', '恢复', (id) => F.taskManager.resume(id)],
      ['task_cancel', '取消', (id) => F.taskManager.cancel(id)]]) {
      router.registerTool({
        name,
        description: `对指定任务执行${verb}（仅管理员）。`,
        inputSchema: { type: 'object', properties: { id: { type: 'string', minLength: 8, maxLength: 64 } }, required: ['id'], additionalProperties: false },
        permission: router.PERMISSION.LIMITED, timeout: 10000, tokenCost: 0, riskLevel: 'medium',
        safety: (a, ctx) => adminOnly(ctx, adminList),
        handler: async (a) => { const r = fn(a.id); return r.ok ? R.okResult(name, r, `任务${verb}成功`, { id: a.id }) : R.failResult(name, r.error, false, { id: a.id }); },
      }); out.push(name);
    }

    router.registerTool({
      name: 'task_query',
      description: '查询任务：给定 id 查单个，或按状态/全部列出（仅管理员）。',
      inputSchema: { type: 'object', properties: { id: { type: 'string', maxLength: 64 }, status: { type: 'string', maxLength: 16 } }, required: [], additionalProperties: false },
      permission: router.PERMISSION.LIMITED, timeout: 10000, tokenCost: 0, riskLevel: 'low',
      safety: (a, ctx) => adminOnly(ctx, adminList),
      handler: async (a) => {
        if (a.id) { const t = F.taskManager.get(a.id); return R.okResult('task_query', t, t ? ('状态: ' + t.status) : '未找到', { found: !!t }); }
        const list = F.taskManager.list(a.status ? { status: a.status } : undefined).slice(0, 50);
        return R.okResult('task_query', { count: list.length, tasks: list.map((t) => ({ id: t.id.slice(0, 8), title: t.title, status: t.status })) }, '共 ' + list.length + ' 个任务', { count: list.length });
      },
    }); out.push('task_query');
  }

  // ---------- 浏览器操作 ----------
  if (config.browser && config.browser.enabled) {
    router.registerTool({
      name: 'browser_open',
      description: '在白名单内打开网页并提取正文/标题（仅浏览器自动化开启且管理员调用）。默认不提交表单、不填密码。',
      inputSchema: { type: 'object', properties: { url: { type: 'string', minLength: 8, maxLength: 500 } }, required: ['url'], additionalProperties: false },
      permission: router.PERMISSION.LIMITED, timeout: 35000, tokenCost: 0, riskLevel: 'medium',
      safety: (a, ctx) => { const adm = adminOnly(ctx, adminList); if (!adm.ok) return adm; if (!/^https?:\/\//i.test(a.url)) return { ok: false, error: '仅支持 http(s)' }; return { ok: true }; },
      handler: async (a) => { const r = await F.browser.open(a.url); return r.ok ? R.okResult('browser_open', { title: r.title, text: (r.text || '').slice(0, 2000), url: r.url }, '已打开: ' + r.title, { len: (r.text || '').length }) : R.failResult('browser_open', r.error, false, {}); },
    }); out.push('browser_open');
  }

  // ---------- 主动通知 ----------
  if (config.notifier && config.notifier.enabled) {
    router.registerTool({
      name: 'notify_send',
      description: '向指定主人发送一条主动通知（仅管理员）。受去重/频率/静默时段约束。',
      inputSchema: { type: 'object', properties: { target: { type: 'string', maxLength: 24 }, kind: { type: 'string', maxLength: 24 }, text: { type: 'string', minLength: 1, maxLength: 4000 } }, required: ['text'], additionalProperties: false },
      permission: router.PERMISSION.LIMITED, timeout: 10000, tokenCost: 0, riskLevel: 'medium',
      safety: (a, ctx) => adminOnly(ctx, adminList),
      handler: async (a) => { const r = F.notifier.enqueue(a.target || null, a.kind || 'info', a.text); return r.ok ? R.okResult('notify_send', r, '已入队通知', { results: r.results }) : R.failResult('notify_send', r.reason, false, {}); },
    }); out.push('notify_send');
  }

  // ---------- TTS 语音 ----------
  if (config.tts && config.tts.enabled) {
    router.registerTool({
      name: 'tts_say',
      description: '将文字合成为语音（仅管理员）。生成音频文件并返回语音消息段，由桥接负责发送。不硬编码任何密钥。',
      inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['text'], additionalProperties: false },
      permission: router.PERMISSION.LIMITED, timeout: 30000, tokenCost: 0, riskLevel: 'medium',
      safety: (a, ctx) => adminOnly(ctx, adminList),
      handler: async (a) => {
        const r = await F.tts.generate(a.text, { save: true });
        if (!r.ok) return R.failResult('tts_say', r.error, false, {});
        const seg = F.tts.buildAudioMessage(r);
        return R.okResult('tts_say', { filePath: r.filePath, bytes: r.bytes, durationMs: r.durationMs, seg }, '语音已生成: ' + r.bytes + 'B', { seg });
      },
    }); out.push('tts_say');
  }

  // ---------- QQ空间发布 ----------
  if (config.qzone && config.qzone.enabled) {
    router.registerTool({
      name: 'qzone_publish',
      description: '发布 QQ空间动态（仅管理员，默认模拟发布）。真实发布需单独授权，且当前无合规开放接口，未授权不会真正发布。',
      inputSchema: { type: 'object', properties: { content: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['content'], additionalProperties: false },
      permission: router.PERMISSION.LIMITED, timeout: 10000, tokenCost: 0, riskLevel: 'high',
      safety: (a, ctx) => adminOnly(ctx, adminList),
      handler: async (a) => { const r = await F.qzone.publish(a.content, { authorized: !!deps.authorizedQZone }); return r.ok ? R.okResult('qzone_publish', r, r.simulated ? '已模拟发布（未真实发送）' : '已发布', { hash: r.hash }) : R.failResult('qzone_publish', r.error || r.reason, false, {}); },
    }); out.push('qzone_publish');
  }

  return out;
}

module.exports = { register, getFeiyu };
