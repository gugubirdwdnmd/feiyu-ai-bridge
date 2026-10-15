'use strict';
// ================= V14：Agent 模块公共入口 =================
// ai_bridge.js 里只需要：
//   const agent = require('./agent');
//   agent.init({ log, config: CFG.agent, getCurrentTime, rememberNote, webSearch, fetchUrl, memorySearch });
//   const r = await agent.run({ text, signals, chatId, groupId, userId, sessionId, isGroup });
//   // r.handled=false → 走原有链路；r.handled=true → 把 r.context 拼进提示词
//
// V14-A 只注册「基础且零风险」的工具用于打通主循环；
// V14-B 会再注册 file / chat_record，V14-C 注册 image / video / bilibili。

const stateMod = require('./state');
const intentMod = require('./intent');
const router = require('./tool_router');
const coreMod = require('./agent_core');
const tools = require('../tools');

let AGENT = null;

// —— 工具注册（V14-B 起统一交给 tools/ 各模块；依赖由 ai_bridge 注入）——
// 缺哪个依赖就不注册哪个工具，绝不硬崩。
function registerBaseTools(deps) {
  try {
    return tools.registerAll(deps);
  } catch (e) {
    return [];
  }
}

function init(deps) {
  deps = deps || {};
  const log = typeof deps.log === 'function' ? deps.log : function () {};
  const registered = registerBaseTools(deps);
  AGENT = coreMod.createAgentCore({ log, config: deps.config });
  log('[Agent] V14-A 已初始化，注册工具：' + (registered.join('、') || '(无)'));
  return AGENT;
}

function get() { return AGENT; }

async function run(input) {
  if (!AGENT) return null;
  return AGENT.run(input);
}

function isEnabled() {
  return !!(AGENT && AGENT.isEnabled());
}

module.exports = Object.assign(
  {},
  stateMod,
  intentMod,
  router,
  {
    init, get, run, isEnabled,
    registerBaseTools,
    createAgentCore: coreMod.createAgentCore,
    defaultPlanner: coreMod.defaultPlanner,
    STATES: stateMod.STATES,
  }
);
