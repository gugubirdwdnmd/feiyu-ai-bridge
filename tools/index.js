'use strict';
// ================= V14-B：Tool 统一注册入口 =================
// 所有 Tool 都在这里注册进 Agent 的 Tool Registry。
// 依赖全部由 ai_bridge 注入：缺哪个依赖，对应 Tool 就不注册（绝不硬崩）。

const router = require('../agent/tool_router');
const R = require('./result');
const web = require('./web');
const memory = require('./memory');
const file = require('./file');
const chatRecord = require('./chat_record');
const image = require('./image');       // V14-C
const video = require('./video');       // V14-C
const bilibili = require('./bilibili'); // V14-C
const genimg = require('./genimg');    // 生图 / 表情包（generate_image、send_sticker）
const feiyu = require('./feiyu');      // 肥鱼：行动型助手（任务/浏览器/通知/TTS/空间）

function registerAll(deps) {
  deps = deps || {};
  const names = [];

  // —— 基础：当前时间（V14-A 已有，保留）——
  if (typeof deps.getCurrentTime === 'function') {
    const r = router.registerTool({
      name: 'get_current_time',
      description: '获取当前准确的日期和时间。不确定今天几号、现在几点时使用。',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      permission: router.PERMISSION.SAFE,
      timeout: 3000,
      tokenCost: 0,
      riskLevel: 'low',
      handler: async () => {
        const t0 = R.nowMs();
        const s = deps.getCurrentTime();
        return R.okResult('get_current_time', { time: s }, String(s).slice(0, 200), {
          durationMs: R.nowMs() - t0, itemCount: 1,
        });
      },
    });
    if (r.ok) names.push('get_current_time');
  }

  try { names.push(...web.register(deps)); } catch (e) { /* 单个模块失败不影响其它 */ }
  try { names.push(...memory.register(deps)); } catch (e) {}
  try { names.push(...file.register(deps)); } catch (e) {}
  try { names.push(...chatRecord.register(deps)); } catch (e) {}
  try { names.push(...image.register(deps)); } catch (e) {}      // V14-C
  try { names.push(...video.register(deps)); } catch (e) {}      // V14-C
  try { names.push(...bilibili.register(deps)); } catch (e) {}   // V14-C
  try { names.push(...genimg.register(deps)); } catch (e) {}     // 生图 / 表情包
  try { names.push(...feiyu.register(deps)); } catch (e) {}      // 肥鱼：行动型助手（任务/浏览器/通知/TTS/空间）

  return names;
}

// 当前权限分布（供自检 / 测试用）
function permissionMap() {
  const map = { SAFE: [], LIMITED: [], SENSITIVE: [] };
  for (const t of router.listTools({ enabledOnly: false })) {
    (map[t.permission] || map.SAFE).push(t.name);
  }
  return map;
}

module.exports = { registerAll, permissionMap, web, memory, file, chatRecord, image, video, bilibili, genimg, feiyu };
