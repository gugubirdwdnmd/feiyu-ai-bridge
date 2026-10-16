'use strict';
// ================= 肥鱼升级：总装层 =================
// 把任务管理 / 浏览器 / 通知 / TTS / QQ空间 / 成本控制 装配成一个 Feiyu 实例。
// 设计：仅做"接线"，不假设具体执行细节；所有对外发送、模型调用由外部 deps 注入（默认安全关闭）。
// 单例：initFeiyu(config, deps) 初始化，getFeiyu() 取实例。tools/feiyu.js 注册工具时用 getFeiyu。

const path = require('path');
const fs = require('fs');
const { TaskManager } = require('./task_manager');
const { BrowserAdapter } = require('./browser_adapter');
const { Notifier } = require('./notifier');
const { TTS } = require('./tts');
const { QZoneAdapter } = require('./qzone_adapter');
const { CostControl } = require('./cost_control');

let _instance = null;

function _dir(name) {
  const base = process.env.FEIYU_DATA_DIR || path.join(process.cwd(), 'workspace', 'feiyu');
  try { fs.mkdirSync(base, { recursive: true }); } catch (e) {}
  return path.join(base, name);
}

function buildDefaultExecutor(browser, cost) {
  // 安全默认执行器：仅对 browse/fetch 类任务做"打开白名单页并保存"，不调模型、不碰系统。
  // 需要真正规划执行的任务，应由外部注入 deps.runTask（经 Agent/模型），此处不假设。
  return async (step, task) => {
    const kind = (step && step.kind) || task.type || 'generic';
    if (kind === 'browse' || kind === 'fetch') {
      const url = step.payload && step.payload.url;
      if (!url) return { ok: false, error: '缺少 url' };
      const r = await browser.open(url);
      if (!r.ok) return { ok: false, error: r.error };
      const save = browser.saveResult('browse_' + (task.id || 'x') + '.txt', r.text);
      return { ok: save.ok, output: { title: r.title, saved: save.ok, len: (r.text || '').length } };
    }
    // 其它类型不假装执行，交给配置的执行器（deps.runTask）；未配置则仅登记
    return { ok: true, output: { note: '未配置执行器，仅完成生命周期登记' } };
  };
}

function initFeiyu(config, deps) {
  config = config || {};
  deps = deps || {};
  const adminList = (config.admin && config.admin.qq) || deps.adminList || [];

  const taskCfg = Object.assign({ storeFile: _dir('tasks.json') }, config.taskManager || {});
  // V15 修正（要求⑥）：无 deps.runTask 时【不】使用默认执行器假装成功，
  // 而是传入 null 执行器，让任务进入"仅生命周期登记"模式（executed:false），
  // 任务状态不再被解释为实际工作完成。
  const hasRealExecutor = typeof deps.runTask === 'function';
  const executor = hasRealExecutor ? deps.runTask : null;

  const notifier = new Notifier({
    storeFile: _dir('notifications.json'),
    send: typeof deps.sendToMaster === 'function' ? (async (target, text) => deps.sendToMaster(text, { target })) : null,
    config: Object.assign({ targets: Array.isArray(adminList) ? adminList : [] }, config.notifier || {}),
  });

  const taskManager = new TaskManager({ storeFile: taskCfg.storeFile, executor, config: taskCfg });
  taskManager.init();

  // 任务事件 → 主动汇报给主人（仅当通知启用且任务有 owner）
  // V15 修正（要求⑥）：明确区分"任务执行成功（executed）"与"仅生命周期登记成功（未执行）"
  taskManager.onEvent = (ev, task) => {
    if (!notifier.cfg.enabled) return;
    if (!(ev === 'completed' || ev === 'failed' || ev === 'created' || ev === 'cancelled')) return;
    if (ev === 'completed') {
      if (!task.executed) {
        // 仅生命周期登记成功：未真正执行任何工作，不得称为"完成"
        const text = `[任务已登记·未执行] ${task.title}（${task.id.slice(0, 8)}）仅完成生命周期登记，当前未配置执行器，不会真正执行任何工作。`;
        notifier.enqueue(null, 'task_registered', text, {});
        return;
      }
      const text = `[任务完成] ${task.title}（${task.id.slice(0, 8)}）`;
      notifier.enqueue(null, 'task_completed', text, {});
      return;
    }
    const label = { failed: '失败', created: '已创建', cancelled: '已取消' }[ev] || ev;
    const text = `[任务${label}] ${task.title}（${task.id.slice(0, 8)}）` + (task.error ? '：' + task.error.slice(0, 100) : '');
    notifier.enqueue(null, 'task_' + ev, text, { urgent: ev === 'failed' });
  };

  const browser = new BrowserAdapter(config.browser);
  const tts = new TTS(config.tts);
  const qzone = new QZoneAdapter(config.qzone);
  const cost = new CostControl(config.budget);

  _instance = {
    config, deps, adminList,
    taskManager, notifier, browser, tts, qzone, cost,
    // 每分钟心跳：调度任务 + 冲刷通知
    async tick() {
      let due = 0;
      try { due = taskManager.tick(); } catch (e) {}
      let flush = { sent: 0, failed: 0, deferred: 0 };
      try { flush = await notifier.flush(); } catch (e) {}
      return { due, flush };
    },
    stats() {
      return {
        tasks: taskManager.stats(),
        notifications: { queue: notifier.queue().length, enabled: notifier.cfg.enabled },
        browser: { enabled: browser.enabled, provider: browser.provider },
        tts: { enabled: tts.enabled, provider: tts.provider },
        qzone: { enabled: qzone.enabled, realEnabled: qzone.realEnabled },
        cost: cost.report(),
      };
    },
  };
  return _instance;
}

function getFeiyu() { return _instance; }

module.exports = { initFeiyu, getFeiyu, buildDefaultExecutor };
