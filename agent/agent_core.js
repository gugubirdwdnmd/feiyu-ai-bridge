'use strict';
// ================= V14-A：Agent Core（调度层，不重新实现任何已有能力）=================
// 流程（对应需求第二条）：
//   [L0 预筛 / Judge 已在 ai_bridge 里做过，结果通过 input.decision 传进来]
//     ↓
//   INTENT_DETECT（本地规则，0 Token）
//     ↓
//   无需工具 → 直接交回原有回答链路（handled=false，不产生任何额外 Token）
//   需要工具 → PLANNING → TOOL_EXECUTION → OBSERVE → （最多 maxSteps 次）
//     ↓
//   SYNTHESIS：把工具结果拼成事实上下文，交回原有 askDeepSeek 生成最终答案
//
// 硬限制：maxSteps=5 / maxToolCalls=5 / maxRetries=1，任何情况下不会无限循环。

const stateMod = require('./state');
const intentMod = require('./intent');
const router = require('./tool_router');

const DEFAULTS = {
  maxSteps: 5,
  maxToolCalls: 5,
  maxRetries: 1,
  enabled: true,
  maxObservationChars: 700,   // 单个工具结果注入上下文的最大字符
  maxContextChars: 3000,      // 工具上下文总长上限
};

// ================= V14-C.1：同一轮 Agent Run 内的工具互斥 =================
// 背景：「B站搜索一下GTA6视频」会同时触发 bilibili_search 和 web_search（因为含「搜索」二字）。
// 规则：某个工具**成功执行**后，本轮禁止再执行它的互斥工具。
//      · 只依据 ctx.run 里已有的 observations 判断 —— **没有全局/跨轮状态**，一次 run 结束即失效；
//      · 单向：bilibili_search 成功后屏蔽 web_search；反过来普通 web_search 不屏蔽任何工具。
const TOOL_MUTEX = {
  bilibili_search: ['web_search'],
};

// 取本轮已成功执行的工具，展开成「被屏蔽工具 -> 屏蔽来源」映射
function suppressedTools(run) {
  const out = new Map();                       // blockedTool -> causeTool
  const obs = (run && run.observations) || [];
  for (const o of obs) {
    if (!o || !o.ok) continue;
    const list = TOOL_MUTEX[o.tool] || [];
    for (const x of list) if (!out.has(x)) out.set(x, o.tool);
  }
  return out;
}

function isSuppressed(run, toolName) {
  return suppressedTools(run).has(String(toolName || ''));
}

// 默认规划器（规则式）：按 intent.suggestedTools 顺序，每个工具最多执行一次
function defaultPlanner() {
  return {
    async decide(ctx) {
      const run = ctx.run;
      const list = (ctx.intent && ctx.intent.suggestedTools) || [];
      const blocked = suppressedTools(run);
      for (const t of list) {
        if (!router.hasTool(t.tool)) continue;                 // 未注册/未启用 → 跳过
        if (run.executedTools.indexOf(t.tool) >= 0) continue;  // 同一工具不重复执行
        // V14-C.1：本轮已有成功工具把它屏蔽掉了（如 B站搜索成功后不再走 web_search）
        if (blocked.has(t.tool)) {
          if (run.trace) run.trace.push({
            state: 'PLANNING',
            note: 'mutex-skip:' + t.tool + '（本轮 ' + blocked.get(t.tool) + ' 已成功执行）',
            at: Date.now(),
          });
          continue;
        }
        return { tool: t.tool, args: t.args || {}, why: t.why || '' };
      }
      return { finish: true, reason: 'no-available-tool' };
    },
    shouldStop() {
      return false;
    },
  };
}

function stringifyResult(v, maxChars) {
  let s;
  if (v == null) s = '';
  else if (typeof v === 'string') s = v;
  else { try { s = JSON.stringify(v); } catch (e) { s = String(v); } }
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (s.length > maxChars) s = s.slice(0, maxChars) + '…';
  return s;
}

function createAgentCore(deps) {
  const d = deps || {};
  const cfg = Object.assign({}, DEFAULTS, d.config || {});
  const log = typeof d.log === 'function' ? d.log : function () {};
  const planner = d.planner || defaultPlanner();
  // 自定义规划器存在时，不能靠 intent 判断「有没有活干」，必须进循环问规划器
  const customPlanner = !!d.planner;

  async function execOne(act, run, input) {
    let attempt = 0;
    let res = null;
    while (attempt <= cfg.maxRetries) {
      res = await router.execute(act.tool, act.args, {
        run, input,
        sessionId: input.sessionId,
        groupId: input.groupId,
        userId: input.userId,
        isGroup: input.isGroup,
        // 安全整改：透传管理员身份，工具可在执行层做权限校验（fail-closed）。
        // 原样透传不转布尔：调用方没给就是 undefined，工具侧按「非 true 即非管理员」处理
        isAdmin: input.isAdmin,
      });
      if (res.ok) break;
      if (attempt >= cfg.maxRetries) break;
      // 只重试「有可能成功」的失败：超时 / handler 异常 / 安全检查通过但执行出错
      const retryable = res.reason === 'timeout' || res.reason === 'handler-error';
      if (!retryable) break;
      attempt++;
      run.retries++;
      log('[Agent] 工具重试 ' + act.tool + ' 第 ' + attempt + ' 次（reason=' + res.reason + '）');
    }
    return res;
  }

  async function run(input) {
    input = input || {};
    const run = stateMod.newRun({
      chatId: input.chatId || '',
      groupId: input.groupId || '',
      userId: input.userId || '',
      isGroup: !!input.isGroup,
    });
    run.to(stateMod.STATES.RECEIVED);

    if (!cfg.enabled) {
      run.finish('agent-disabled');
      return { handled: false, run, intent: null, context: '', reason: 'agent-disabled' };
    }

    // —— INTENT_DETECT（本地规则，0 Token）——
    run.to(stateMod.STATES.INTENT_DETECT);
    const intent = intentMod.detectIntent(input.text || '', input.signals || {});
    run.intents = intent.intents.slice();
    run.primaryIntent = intent.primary;
    run.trace.push({ state: 'INTENT_DETECT', note: intent.primary + '/' + intent.intents.join(','), at: Date.now() });

    // 过滤出真正可执行的工具
    const usable = intent.suggestedTools.filter((t) => router.hasTool(t.tool));

    // —— 无需工具：直接交回原有链路，不多花一个 Token ——
    // （只有「默认规则规划器」才能这样提前结束；自定义规划器必须进循环才问得到）
    if (!usable.length && !customPlanner) {
      run.to(stateMod.STATES.SYNTHESIS, 'no-tool');
      run.to(stateMod.STATES.ANSWER, 'delegate');
      run.finish('no-tool-needed:' + intent.primary);
      log('[Agent] ' + run.id + ' 意图=' + intent.primary + ' 无需工具 → 走原有链路（0 额外调用）');
      return { handled: false, run, intent, context: '', reason: 'no-tool-needed' };
    }

    // —— 需要工具：一步一步执行（执行 → 观察 → 再决定）——
    let stopReason = '';
    const executedSigs = new Set();   // tool|args 签名，防止「同一个调用被反复执行 → 死循环」
    while (run.steps < cfg.maxSteps && run.toolCalls < cfg.maxToolCalls) {
      run.to(stateMod.STATES.PLANNING, 'step' + (run.steps + 1));

      let act;
      try {
        act = await planner.decide({ run, intent, input });
      } catch (e) {
        run.error('planner-error: ' + e.message);
        run.to(stateMod.STATES.ABORT, 'planner-error');
        stopReason = 'planner-error';
        break;
      }
      if (!act || act.finish) { stopReason = (act && act.reason) || 'planner-finish'; break; }

      // 完全相同的「工具 + 参数」已经执行过 → 立即停止（硬性防循环，不依赖规划器自觉）
      const sig = String(act.tool) + '|' + JSON.stringify(act.args || {});
      if (executedSigs.has(sig)) { stopReason = 'duplicate-tool'; break; }
      executedSigs.add(sig);

      // V14-C.1：本轮互斥（例：bilibili_search 已成功 → 不再执行 web_search）
      //          这里做最后一道硬闸，即使规划器没有自觉跳过也不会重复调用。
      if (isSuppressed(run, act.tool)) {
        run.trace.push({ state: 'PLANNING', note: 'mutex-blocked:' + act.tool, at: Date.now() });
        stopReason = 'mutex-blocked';
        break;
      }

      run.steps++;
      run.to(stateMod.STATES.TOOL_EXECUTION, act.tool);
      run.toolCalls++;
      const res = await execOne(act, run, input);
      run.to(stateMod.STATES.OBSERVE, act.tool + (res.ok ? ':ok' : ':fail'));

      const summary = res.ok
        ? stringifyResult(res.result, cfg.maxObservationChars)
        : ('失败：' + (res.error || res.reason));
      run.observations.push({
        tool: act.tool, ok: !!res.ok, summary, ms: res.ms,
        reason: res.reason, raw: res.ok ? res.result : null,
      });
      run.executedTools.push(act.tool);
      log('[Agent] ' + run.id + ' 步骤' + run.steps + ' 工具=' + act.tool +
          ' ' + (res.ok ? '成功' : '失败(' + res.reason + ')') + ' ' + res.ms + 'ms');

      // 达到足够信息就停（最少必要工具调用）
      let stop = false;
      try { if (planner.shouldStop) stop = !!planner.shouldStop({ run, intent, input, last: res }); } catch (e) { stop = false; }
      if (stop) { stopReason = 'sufficient'; break; }
      if (run.steps >= cfg.maxSteps) stopReason = 'max-steps';
      else if (run.toolCalls >= cfg.maxToolCalls) stopReason = 'max-tool-calls';
    }
    if (!stopReason) stopReason = 'done';

    // V14-C.1：互斥跳过留痕（便于日志核对「B站搜索没再触发 web_search」）
    const skips = run.trace.filter((x) => x && String(x.note || '').indexOf('mutex-') === 0);
    if (skips.length) log('[Agent] ' + run.id + ' 互斥跳过：' + skips.map((s) => s.note).join(' | '));

    // —— SYNTHESIS：拼装工具事实（不生成答案，答案仍由原 askDeepSeek 产出）——
    run.to(stateMod.STATES.SYNTHESIS, 'build-context');
    const lines = [];
    let total = 0;
    run.observations.forEach((o, i) => {
      const head = `【工具 ${i + 1}】${o.tool}（${o.ok ? '成功' : '失败'}）`;
      const body = o.summary || '';
      const seg = head + '\n' + body;
      if (total + seg.length > cfg.maxContextChars) return;
      lines.push(seg);
      total += seg.length;
    });

    let context = '';
    if (lines.length) {
      context =
        '【Agent 工具结果】以下是由授权工具真实取得的信息，请严格基于它回答；' +
        '工具失败或没有结果时必须如实说明，禁止编造。\n' +
        lines.join('\n\n');
    }

    const anyOK = run.observations.some((o) => o.ok);
    run.to(stateMod.STATES.ANSWER, 'delegate');
    run.finish(stopReason + (anyOK ? '' : ':all-failed'));
    log('[Agent] ' + run.id + ' 结束 意图=' + intent.primary +
        ' 步骤=' + run.steps + ' 工具=' + run.toolCalls + ' 成功=' + run.observations.filter((o) => o.ok).length +
        ' 耗时=' + run.durationMs + 'ms 原因=' + stopReason);

    return {
      handled: true,
      run,
      intent,
      context,
      reason: stopReason,
      ok: anyOK,
    };
  }

  return {
    run,
    config: cfg,
    planner,
    router,
    setEnabled(on) { cfg.enabled = !!on; },
    isEnabled() { return !!cfg.enabled; },
  };
}

module.exports = { createAgentCore, defaultPlanner, DEFAULTS, stringifyResult, TOOL_MUTEX, suppressedTools, isSuppressed };
