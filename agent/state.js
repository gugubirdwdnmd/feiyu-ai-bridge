'use strict';
// ================= V14-A：Agent 状态机 =================
// 明确状态，避免 Agent 逻辑退化成一堆互相调用的 if/else。
// 状态迁移非法时只记录不抛错（Agent 永远不能把机器人搞崩）。

const STATES = {
  IDLE: 'IDLE',
  RECEIVED: 'RECEIVED',
  FILTERING: 'FILTERING',
  INTENT_DETECT: 'INTENT_DETECT',
  PLANNING: 'PLANNING',
  TOOL_EXECUTION: 'TOOL_EXECUTION',
  OBSERVE: 'OBSERVE',
  SYNTHESIS: 'SYNTHESIS',
  ANSWER: 'ANSWER',
  MEMORY_UPDATE: 'MEMORY_UPDATE',
  DONE: 'DONE',
  ERROR: 'ERROR',
  RECOVER: 'RECOVER',
  ABORT: 'ABORT',
};

// 合法迁移表（超出即非法，记录到 trace 但不阻断）
const TRANSITIONS = {
  IDLE: ['RECEIVED'],
  RECEIVED: ['FILTERING', 'INTENT_DETECT', 'ABORT'],
  FILTERING: ['INTENT_DETECT', 'ABORT'],
  INTENT_DETECT: ['PLANNING', 'SYNTHESIS', 'ABORT', 'ERROR'],
  PLANNING: ['TOOL_EXECUTION', 'SYNTHESIS', 'ABORT', 'ERROR'],
  TOOL_EXECUTION: ['OBSERVE', 'ERROR', 'RECOVER'],
  OBSERVE: ['PLANNING', 'SYNTHESIS', 'ABORT', 'ERROR'],
  RECOVER: ['PLANNING', 'SYNTHESIS', 'ABORT'],
  SYNTHESIS: ['ANSWER', 'ERROR'],
  ANSWER: ['MEMORY_UPDATE', 'DONE'],
  MEMORY_UPDATE: ['DONE'],
  DONE: [],
  ERROR: ['RECOVER', 'ABORT'],
  ABORT: ['DONE'],
};

const TERMINAL = new Set(['DONE', 'ABORT']);

function canTransition(from, to) {
  const allow = TRANSITIONS[from];
  if (!allow) return false;
  return allow.indexOf(to) >= 0;
}

function isTerminal(s) {
  return TERMINAL.has(s);
}

let runSeq = 0;

// 创建一次 Agent 运行的上下文（不保存聊天正文，只保存必要元信息）
function newRun(meta) {
  const run = {
    id: 'ar_' + Date.now().toString(36) + '_' + (++runSeq).toString(36),
    state: STATES.IDLE,
    prevState: null,
    steps: 0,
    toolCalls: 0,
    retries: 0,
    startedAt: Date.now(),
    endedAt: 0,
    durationMs: 0,
    stopReason: '',
    illegalTransitions: [],
    trace: [],          // { state, note, at }
    intents: [],
    primaryIntent: '',
    observations: [],   // { tool, ok, summary, ms }
    executedTools: [],
    errors: [],
    token: { prompt: 0, completion: 0, total: 0, byKind: {} },
    meta: meta || {},
  };

  run.to = function (next, note) {
    const from = run.state;
    if (!canTransition(from, next)) {
      run.illegalTransitions.push(from + '->' + next);
    }
    run.prevState = from;
    run.state = next;
    run.trace.push({ state: next, note: note || '', at: Date.now() });
    return run.state;
  };

  run.error = function (msg) {
    run.errors.push(String(msg || '').slice(0, 200));
    run.to(STATES.ERROR, String(msg || '').slice(0, 80));
    return run;
  };

  run.addToken = function (usage, kind) {
    if (!usage) return;
    const pt = Number(usage.prompt_tokens) || 0;
    const ct = Number(usage.completion_tokens) || 0;
    const tt = Number(usage.total_tokens) || (pt + ct);
    run.token.prompt += pt;
    run.token.completion += ct;
    run.token.total += tt;
    const k = kind || 'unknown';
    if (!run.token.byKind[k]) run.token.byKind[k] = { calls: 0, tokens: 0 };
    run.token.byKind[k].calls++;
    run.token.byKind[k].tokens += tt;
  };

  run.finish = function (stopReason) {
    if (!isTerminal(run.state)) run.to(STATES.DONE, 'finish');
    run.stopReason = stopReason || '';
    run.endedAt = Date.now();
    run.durationMs = run.endedAt - run.startedAt;
    return run;
  };

  // 对外可安全序列化的摘要（不含任何聊天正文）
  run.summary = function () {
    return {
      id: run.id,
      state: run.state,
      steps: run.steps,
      toolCalls: run.toolCalls,
      retries: run.retries,
      durationMs: run.durationMs || (Date.now() - run.startedAt),
      stopReason: run.stopReason,
      intents: run.intents.slice(),
      primaryIntent: run.primaryIntent,
      tools: run.observations.map((o) => ({ tool: o.tool, ok: !!o.ok, ms: o.ms })),
      errors: run.errors.slice(0, 3),
      illegalTransitions: run.illegalTransitions.slice(),
      token: { prompt: run.token.prompt, completion: run.token.completion, total: run.token.total, byKind: run.token.byKind },
    };
  };

  return run;
}

module.exports = { STATES, TRANSITIONS, TERMINAL, canTransition, isTerminal, newRun };
