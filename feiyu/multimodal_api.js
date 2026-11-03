'use strict';

/**
 * multimodal_api.js —— 多模态管理 API 的纯处理逻辑（与 http 收发解耦，便于单测）。
 *
 * 端点（全部仅 127.0.0.1 回环，由 ai_bridge 的 http server 绑定保证）：
 *   GET  /api/multimodal/capabilities  能力自检（ffmpeg/vision/ocr/asr/summary 状态）
 *   GET  /api/multimodal/status        能力 + 资源快照(GPU/显存/CPU/内存) + 任务统计 + 当前配置
 *   GET  /api/multimodal/tasks         视频任务列表
 *   POST /api/multimodal/analyze       body:{mediaRef:{type:'video',data}, ev?, chatId?} 入队分析
 *   POST /api/multimodal/config        body: 局部 multimodal 配置（热更新，仅内存；持久化由桌面端写 ai_config.json）
 *   POST /api/multimodal/task/:id/cancel  取消某个任务
 *
 * 返回统一结构 { status:number, json:object }，由桥负责转发到 res。
 */

function sanitizeConfig(cfg) {
  cfg = cfg || {};
  // 仅剔除真正的密钥字段；apiKeyRef（只是引用名）可展示
  const out = JSON.parse(JSON.stringify(cfg, (k, v) => (k === 'apiKey' && typeof v === 'string' ? '[redacted]' : v)));
  return out;
}

/**
 * @param {object} deps
 *   - mediaSvc: createMediaUnderstanding 实例
 *   - resourceManager: createLocalAIResourceManager 实例
 *   - taskManager: feiyu/task_manager 的 TaskManager 实例（可为 null）
 *   - getCFG(): () => CFG
 *   - applyConfig(partial): 热更新配置（仅内存）
 *   - log(line)
 */
function createMultimodalApi(deps) {
  deps = deps || {};
  const mediaSvc = deps.mediaSvc || null;
  const resourceManager = deps.resourceManager || null;
  const taskManager = deps.taskManager || null;
  const getCFG = typeof deps.getCFG === 'function' ? deps.getCFG : () => ({});
  const applyConfig = typeof deps.applyConfig === 'function' ? deps.applyConfig : null;
  const log = typeof deps.log === 'function' ? deps.log : () => {};

  function notReady() { return { status: 503, json: { ok: false, error: 'multimodal-not-ready' } }; }

  async function handleGet(pathname, query) {
    if (!mediaSvc) return notReady();
    if (pathname === '/api/multimodal/capabilities') {
      try {
        const cap = await mediaSvc.probeCapabilities();
        return { status: 200, json: { ok: true, capabilities: cap } };
      } catch (e) { return { status: 500, json: { ok: false, error: String(e && e.message || e).slice(0, 160) } }; }
    }
    if (pathname === '/api/multimodal/status') {
      try {
        const [cap, snap, stats] = await Promise.all([
          mediaSvc.probeCapabilities(),
          resourceManager ? resourceManager.snapshot() : Promise.resolve(null),
          Promise.resolve(taskManager ? taskManager.stats() : null),
        ]);
        return { status: 200, json: { ok: true, capabilities: cap, resources: snap, tasks: stats, config: sanitizeConfig(getCFG().multimodal || {}) } };
      } catch (e) { return { status: 500, json: { ok: false, error: String(e && e.message || e).slice(0, 160) } }; }
    }
    if (pathname === '/api/multimodal/tasks') {
      const list = taskManager ? taskManager.list() : [];
      return { status: 200, json: { ok: true, tasks: list.slice(0, 50) } };
    }
    return { status: 404, json: { ok: false, error: 'not-found' } };
  }

  async function handlePost(pathname, body) {
    body = body || {};
    if (!mediaSvc) return notReady();

    if (pathname === '/api/multimodal/analyze') {
      const seg = (body.mediaRef && body.mediaRef.type === 'video') ? body.mediaRef
        : (body.seg && body.seg.type === 'video' ? body.seg : null);
      if (!seg) return { status: 400, json: { ok: false, error: 'missing-video-seg' } };
      try {
        const r = await mediaSvc.handleIncomingVideo(seg, {
          ev: body.ev || {},
          chatId: body.chatId || (body.ev && body.ev.message_type === 'group' ? 'group:' + body.ev.group_id : 'private:' + (body.ev && body.ev.user_id)),
          groupId: (body.ev && body.ev.group_id) || null,
          userId: (body.ev && body.ev.user_id) || null,
          sendReply: () => {},
        });
        return { status: 200, json: { ok: !!r.ok, taskId: r.taskId || null, enqueued: !!r.enqueued, reason: r.ok ? null : (r.reason || 'enqueue-failed') } };
      } catch (e) { return { status: 500, json: { ok: false, error: String(e && e.message || e).slice(0, 160) } }; }
    }

    if (pathname === '/api/multimodal/config') {
      if (!applyConfig) return { status: 501, json: { ok: false, error: 'config-not-supported' } };
      const res = applyConfig(body || {});
      return { status: 200, json: { ok: true, applied: !!res, config: sanitizeConfig(getCFG().multimodal || {}) } };
    }

    const m = /^\/api\/multimodal\/task\/([^/]+)\/cancel$/.exec(pathname);
    if (m) {
      if (!taskManager) return { status: 503, json: { ok: false, error: 'task-manager-not-ready' } };
      const r = taskManager.cancel(decodeURIComponent(m[1]));
      return { status: 200, json: Object.assign({ ok: !!r.ok }, r) };
    }

    return { status: 404, json: { ok: false, error: 'not-found' } };
  }

  return { handleGet, handlePost, sanitizeConfig };
}

module.exports = { createMultimodalApi, sanitizeConfig };
