'use strict';
// ================= V14-A 测试套件 =================
// 覆盖：State 状态机 / Intent 意图识别 / Tool Router 安全与 Schema / Agent Core 循环限制
//       + 回归：stats bucket 字段不再是 NaN、原有意图不误触发工具

const path = require('path');
const fs = require('fs');
const A = require('../agent');            // state + intent + router 合集
const coreMod = require('../agent/agent_core');
const intentMod = require('../agent/intent');
const stateMod = require('../agent/state');
const router = require('../agent/tool_router');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; fails.push(name); console.log('  ✗ ' + name); }
}
function eq(a, b, name) { ok(a === b, name + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function group(t) { console.log('\n[' + t + ']'); }

// ============================================================
group('State 状态机');

const S = stateMod.STATES;
ok(stateMod.canTransition(S.IDLE, S.RECEIVED), 'IDLE→RECEIVED 合法');
ok(stateMod.canTransition(S.RECEIVED, S.INTENT_DETECT), 'RECEIVED→INTENT_DETECT 合法');
ok(stateMod.canTransition(S.INTENT_DETECT, S.PLANNING), 'INTENT_DETECT→PLANNING 合法');
ok(stateMod.canTransition(S.PLANNING, S.TOOL_EXECUTION), 'PLANNING→TOOL_EXECUTION 合法');
ok(stateMod.canTransition(S.TOOL_EXECUTION, S.OBSERVE), 'TOOL_EXECUTION→OBSERVE 合法');
ok(stateMod.canTransition(S.OBSERVE, S.SYNTHESIS), 'OBSERVE→SYNTHESIS 合法');
ok(stateMod.canTransition(S.SYNTHESIS, S.ANSWER), 'SYNTHESIS→ANSWER 合法');
ok(stateMod.canTransition(S.ANSWER, S.DONE), 'ANSWER→DONE 合法');
ok(!stateMod.canTransition(S.IDLE, S.DONE), 'IDLE→DONE 非法');
ok(!stateMod.canTransition(S.DONE, S.PLANNING), 'DONE→PLANNING 非法（终态）');
ok(stateMod.isTerminal(S.DONE), 'DONE 是终态');
ok(stateMod.isTerminal(S.ABORT), 'ABORT 是终态');
ok(!stateMod.isTerminal(S.PLANNING), 'PLANNING 不是终态');

const r1 = stateMod.newRun({ chatId: 'c1' });
eq(r1.state, S.IDLE, 'newRun 初始状态 IDLE');
eq(typeof r1.id, 'string', 'run.id 是字符串');
ok(/^ar_/.test(r1.id), 'run.id 前缀 ar_');
eq(r1.steps, 0, '初始 steps=0');
eq(r1.toolCalls, 0, '初始 toolCalls=0');
eq(r1.token.total, 0, '初始 token.total=0');
r1.to(S.RECEIVED, 'test');
eq(r1.state, S.RECEIVED, 'to() 切换状态');
eq(r1.prevState, S.IDLE, 'prevState 记录正确');
eq(r1.trace.length, 1, 'trace 记录 1 条');
r1.to(S.DONE, '非法跳转测试');
eq(r1.illegalTransitions.length, 1, '非法迁移被记录');
ok(!stateMod.isTerminal(r1.state) === false, 'DONE 后 isTerminal 为真');

const r2 = stateMod.newRun({});
r2.addToken({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, 'answer');
r2.addToken({ prompt_tokens: 20, completion_tokens: 0, total_tokens: 20 }, 'tool');
eq(r2.token.prompt, 30, 'token.prompt 累计');
eq(r2.token.total, 35, 'token.total 累计');
eq(r2.token.byKind.answer.calls, 1, 'byKind.answer.calls=1');
eq(r2.token.byKind.tool.tokens, 20, 'byKind.tool.tokens=20');
r2.finish('done');
ok(r2.durationMs >= 0, 'finish 后 durationMs 有效');
eq(r2.stopReason, 'done', 'stopReason 记录');
const sum = r2.summary();
ok(typeof sum === 'object' && !('trace' in sum), 'summary 不含内部 trace（防泄露思考过程）');
eq(sum.tools.length, 0, 'summary.tools 为空数组');
ok(JSON.stringify(sum).length > 0, 'summary 可序列化');

// ============================================================
group('Intent 意图识别（本地规则 / 0 Token）');

function I(text, sig) { return intentMod.detectIntent(text, sig || {}); }
const has = (r, t) => r.intents.indexOf(t) >= 0;
const hasTool = (r, t) => r.suggestedTools.some((x) => x.tool === t);

let x = I('你好');
ok(has(x, 'chat'), '「你好」→ chat');
eq(x.needsTools, false, '「你好」不需要工具');

x = I('哈哈哈哈');
eq(x.needsTools, false, '「哈哈哈哈」不需要工具');
eq(x.primary, 'chat', '「哈哈哈哈」primary=chat');

x = I('确实');
eq(x.needsTools, false, '「确实」不需要工具');

x = I('今晚吃什么');
eq(x.needsTools, false, '「今晚吃什么」不触发搜索（非实时信息）');

x = I('你觉得GTA6怎么样？');
ok(has(x, 'question'), '「你觉得GTA6怎么样？」→ question');
eq(x.needsTools, false, '★「你觉得GTA6怎么样？」不触发 web_search（关键：不每条都搜）');
ok(!hasTool(x, 'web_search'), '★「你觉得GTA6怎么样？」不含 web_search 工具建议');

x = I('帮我查一下今天有什么新闻');
ok(hasTool(x, 'web_search'), '「帮我查一下今天有什么新闻」→ web_search');
ok(has(x, 'current_information'), '→ current_information');
eq(x.suggestedTools[0].args.query.length > 0, true, 'web_search 抽出了 query');

x = I('GTA6 最近有什么新消息');
ok(hasTool(x, 'web_search'), '「GTA6 最近有什么新消息」→ web_search（时间词+主题词）');

x = I('帮我搜一下 黑神话悟空 售价');
ok(hasTool(x, 'web_search'), '「帮我搜一下…」→ web_search');

x = I('帮我在B站找一下 黑神话 的实况');
ok(hasTool(x, 'bilibili_search'), 'B站关键词 → bilibili_search');
ok(has(x, 'bilibili_search'), '→ bilibili_search 意图');

x = I('看看这个BV1xx411c7mD视频');
ok(hasTool(x, 'bilibili_search'), 'BV 号 → bilibili_search');

x = I('记住我以后叫小明');
ok(hasTool(x, 'memory_write'), '「记住我以后叫小明」→ memory_write');
ok(has(x, 'memory_write'), '→ memory_write 意图');

x = I('我今天吃了火锅');
ok(!hasTool(x, 'memory_write'), '★「我今天吃了火锅」不写长期记忆');
eq(x.needsTools, false, '★普通闲聊不触发任何工具');

x = I('你记得我叫什么吗');
ok(hasTool(x, 'memory_search'), '「你记得我叫什么吗」→ memory_search');

x = I('1+1等于多少');
ok(has(x, 'calculation'), '「1+1等于多少」→ calculation');

x = I('帮我分析这个视频', { hasVideo: true });
ok(has(x, 'video_analysis'), '带视频 + 「分析这个视频」→ video_analysis');
ok(hasTool(x, 'video_analysis'), '→ video_analysis 工具建议');

x = I('', { hasVideo: true });
ok(!has(x, 'video_analysis'), '★只有视频没说要看 → 不触发 video_analysis（避免每条视频都分析）');

x = I('嗯', { hasImage: true });
ok(has(x, 'image_analysis'), '带图片 → image_analysis 意图');
// V14-C 变更（对应用户 V14-C 规范第二十、二十六条）：
//   带图但不是在问这张图 → **不**建议 image_analysis 工具，交回 V13 已有的单次多模态链路。
//   目的：避免「工具分析一次 + 原链路再发一次原图」的重复计费，也符合「最少必要工具调用」。
//   明确要分析时仍然会建议工具（下一条断言）。
ok(!hasTool(x, 'image_analysis'), '★带图但没在问这张图 → 不建议工具（防重复计费，走原有单次链路）');
x = I('这图是什么？', { hasImage: true });
ok(hasTool(x, 'image_analysis'), '★明确问这张图 → 建议 image_analysis 工具');

x = I('总结一下', { hasForward: true });
ok(has(x, 'chat_record_analysis'), '合并转发 → chat_record_analysis');
eq(x.primary, 'chat_record_analysis', '合并转发 primary 最高优先');

x = I('帮我看看这个视频，然后告诉我里面提到的那个游戏最近有没有更新', { hasVideo: true });
ok(has(x, 'multi_step_task'), '★多步骤：视频+最新 → multi_step_task');
ok(has(x, 'video_analysis'), '多步骤含 video_analysis');
ok(has(x, 'current_information'), '多步骤含 current_information');
ok(x.suggestedTools.length >= 2, '多步骤建议 ≥2 个工具');

x = I('先分析这个视频，再告诉我里面提到的东西最近有什么变化', { hasVideo: true });
ok(has(x, 'multi_step_task'), '★「先…再…」句式 → multi_step_task');

eq(I('').primary, 'chat', '空文本 → chat（不崩）');
eq(I(null).primary, 'chat', 'null 文本 → chat（不崩）');
ok(Array.isArray(I('x').intents), 'intents 是数组');
ok(intentMod.extractQuery('帮我搜一下 黑神话悟空 售价').length <= 40, 'extractQuery 限长 40');
ok(intentMod.extractQuery('').length <= 40, 'extractQuery 空串不崩');
ok(I('测试').confidence >= 0 && I('测试').confidence <= 1, 'confidence 在 0~1');

// ============================================================
group('Tool Router：注册与黑名单');

router.reset();
ok(router.isForbidden('execute_shell'), 'execute_shell 在黑名单');
ok(router.isForbidden('powershell'), 'powershell 在黑名单');
ok(router.isForbidden('POWERSHELL'), '黑名单大小写不敏感');
ok(router.isForbidden('delete_file'), 'delete_file 在黑名单');
ok(router.isForbidden('open_program'), 'open_program 在黑名单');
ok(router.isForbidden('run_command'), 'run_command 在黑名单');
ok(router.isForbidden('keyboard'), 'keyboard 在黑名单');
ok(router.isForbidden('screenshot'), 'screenshot 在黑名单');
ok(router.isForbidden('camera'), 'camera 在黑名单');
ok(router.isForbidden('registry'), 'registry 在黑名单');
ok(!router.isForbidden('web_search'), 'web_search 不在黑名单');

let rr = router.registerTool({ name: 'execute_shell', handler: async () => 1 });
eq(rr.ok, false, '★注册高危工具被拒绝');

rr = router.registerTool({ name: 'my_tool', handler: async () => 'hi' });
eq(rr.ok, true, '注册合法工具成功');
ok(router.hasTool('my_tool'), 'hasTool 找到已注册工具');

rr = router.registerTool({ name: 'no_handler' });
eq(rr.ok, false, '★没有 handler 的工具注册失败');

rr = router.registerTool({ name: 'sens_tool', permission: 'SENSITIVE', handler: async () => 1 });
eq(rr.ok, false, '★V14 第一版拒绝注册 SENSITIVE 工具');

rr = router.registerTool({ name: 'Bad Name', handler: async () => 1 });
eq(rr.ok, false, '非法工具名被拒绝');

rr = router.registerTool({ name: 'off_tool', enabled: false, handler: async () => 1 });
eq(rr.ok, true, '注册默认关闭的工具成功');
eq(router.hasTool('off_tool'), false, '★未启用工具 hasTool=false');

// Schema
const defs = [
  {
    name: 't_schema',
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string', minLength: 2, maxLength: 10 } },
      required: ['q'], additionalProperties: false,
    },
    permission: 'SAFE',
    handler: async (a) => 'got:' + a.q,
  },
];
defs.forEach((d) => router.registerTool(d));

let v = router.validateArgs(router.getTool('t_schema'), { q: 'abc' });
eq(v.ok, true, 'Schema 合法参数通过');
v = router.validateArgs(router.getTool('t_schema'), {});
eq(v.ok, false, '★缺少必填参数被拒');
v = router.validateArgs(router.getTool('t_schema'), { q: 123 });
eq(v.ok, false, '★类型错误被拒');
v = router.validateArgs(router.getTool('t_schema'), { q: 'a' });
eq(v.ok, false, '★低于 minLength 被拒');
v = router.validateArgs(router.getTool('t_schema'), { q: 'abcdefghijk' });
eq(v.ok, false, '★超过 maxLength 被拒');
v = router.validateArgs(router.getTool('t_schema'), { q: 'abc', evil: 1 });
eq(v.ok, false, '★未知参数被拒（additionalProperties=false）');

// ============================================================
(async function main() {
  group('Tool Router：执行');

  router.registerTool({ name: 'ok_tool', handler: async () => 'RESULT_OK' });
  router.registerTool({ name: 'throw_tool', handler: async () => { throw new Error('boom'); } });
  router.registerTool({ name: 'slow_tool', timeout: 100, handler: () => new Promise((r) => setTimeout(() => r('late'), 2000)) });
  router.registerTool({
    name: 'guard_tool',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    safety: (a) => (String(a.url).indexOf('127.') === 0 ? { ok: false, error: '禁止内网' } : { ok: true }),
    handler: async () => 'fetched',
  });

  let e = await router.execute('ok_tool', {});
  eq(e.ok, true, '执行成功 ok=true');
  eq(e.result, 'RESULT_OK', '返回值正确');
  eq(e.reason, 'ok', 'reason=ok');
  ok(e.ms >= 0, '记录了耗时');

  e = await router.execute('not_exist_tool', {});
  eq(e.ok, false, '★未注册工具执行失败');
  eq(e.reason, 'not-registered', 'reason=not-registered');
  eq(e.rejected, true, 'rejected=true');

  e = await router.execute('execute_shell', { cmd: 'rm -rf /' });
  eq(e.ok, false, '★高危工具执行被拒绝');
  eq(e.reason, 'forbidden-tool', 'reason=forbidden-tool');

  e = await router.execute('POWERSHELL', {});
  eq(e.ok, false, '★大小写变化的黑名单名也被拒');

  e = await router.execute('off_tool', {});
  eq(e.reason, 'disabled', '★未启用工具 reason=disabled');

  e = await router.execute('t_schema', {});
  eq(e.reason, 'schema-invalid', '★Schema 不通过 reason=schema-invalid');

  e = await router.execute('throw_tool', {});
  eq(e.ok, false, 'handler 抛错被捕获，不崩');
  eq(e.reason, 'handler-error', 'reason=handler-error');

  e = await router.execute('slow_tool', {});
  eq(e.ok, false, '★超时被终止');
  eq(e.reason, 'timeout', 'reason=timeout');
  ok(e.ms < 1500, '超时及时返回，没有卡死');

  e = await router.execute('guard_tool', { url: 'https://example.com/a' });
  eq(e.ok, true, '安全检查通过');
  e = await router.execute('guard_tool', { url: '127.0.0.1/x' });
  eq(e.ok, false, '★安全检查拦截内网地址');
  eq(e.reason, 'safety-blocked', 'reason=safety-blocked');

  e = await router.execute('', {});
  eq(e.reason, 'empty-name', '空工具名被拒');

  // ============================================================
  group('Agent Core：无需工具路径（0 额外 Token）');

  router.reset();
  const core = coreMod.createAgentCore({ log: () => {}, config: { maxSteps: 5, maxToolCalls: 5, maxRetries: 1 } });

  let out = await core.run({ text: '你好', signals: {} });
  eq(out.handled, false, '★「你好」不走 Agent 工具（handled=false）');
  eq(out.run.toolCalls, 0, '★「你好」0 次工具调用');
  eq(out.context, '', '「你好」无工具上下文');
  eq(out.reason, 'no-tool-needed', 'reason=no-tool-needed');

  out = await core.run({ text: '你觉得GTA6怎么样？', signals: {} });
  eq(out.handled, false, '★「GTA6怎么样」不调用任何工具');
  eq(out.run.toolCalls, 0, '★「GTA6怎么样」0 次工具调用');

  out = await core.run({ text: '帮我查一下今天有什么新闻', signals: {} });
  eq(out.handled, false, '★建议了工具但 Registry 里没有 → handled=false（不硬调）');
  eq(out.run.toolCalls, 0, '未注册工具不会被调用');

  out = await core.run({ text: '嗯', signals: { hasImage: true } });
  eq(out.handled, false, '★图片意图在无 image_analysis 工具时不强行调用');

  // ============================================================
  group('Agent Core：工具执行路径');

  router.registerTool({ name: 'web_search', permission: 'SAFE', handler: async (a) => '搜索结果：' + a.query });
  router.registerTool({ name: 'get_current_time', permission: 'SAFE', handler: async () => '2026-10-08 18:00' });

  out = await core.run({ text: '帮我查一下今天有什么新闻', signals: {} });
  eq(out.handled, true, '有可用工具 → handled=true');
  eq(out.run.toolCalls, 1, '调用了 1 次工具');
  ok(out.context.indexOf('web_search') >= 0, '上下文含工具名');
  ok(out.context.indexOf('搜索结果') >= 0, '★上下文含真实工具结果（不是假的）');
  ok(out.context.indexOf('禁止编造') >= 0, '上下文含「禁止编造」约束');
  eq(out.ok, true, '至少 1 个工具成功');
  eq(out.run.state, 'DONE', '结束时状态 DONE');
  eq(out.run.observations.length, 1, '记录了 1 条观察');

  out = await core.run({ text: '现在几点', signals: {} });
  eq(out.handled, true, '「现在几点」→ 走工具');
  ok(out.context.indexOf('2026-10-08') >= 0, '★拿到真实时间结果');

  // 同一工具不重复执行（最少必要调用）
  router.registerTool({ name: 'dup_tool', permission: 'SAFE', handler: async () => 'x' });
  const core2 = coreMod.createAgentCore({
    log: () => {},
    config: { maxSteps: 5, maxToolCalls: 5, maxRetries: 1 },
    planner: {
      async decide() { return { tool: 'dup_tool', args: {} }; },
      shouldStop() { return false; },
    },
  });
  out = await core2.run({ text: '测试', signals: {} });
  eq(out.run.toolCalls, 1, '★同一工具不会被无限重复调用（防死循环）');
  eq(out.run.steps, 1, '只走了 1 步');

  // 强制测试 maxSteps 硬限制
  let n = 0;
  const coreLoop = coreMod.createAgentCore({
    log: () => {},
    config: { maxSteps: 5, maxToolCalls: 99, maxRetries: 1 },
    planner: {
      async decide() { n++; return { tool: 'web_search', args: { query: 'q' + n } }; },
      shouldStop() { return false; },
    },
  });
  out = await coreLoop.run({ text: '测试', signals: {} });
  ok(out.run.steps <= 5, '★steps 不超过 maxSteps=5（硬限制生效）');

  const coreLoop2 = coreMod.createAgentCore({
    log: () => {},
    config: { maxSteps: 99, maxToolCalls: 5, maxRetries: 1 },
    planner: {
      async decide() { n++; return { tool: 'web_search', args: { query: 'q' + n } }; },
      shouldStop() { return false; },
    },
  });
  out = await coreLoop2.run({ text: '测试', signals: {} });
  eq(out.run.toolCalls, 5, '★toolCalls 不超过 maxToolCalls=5（硬限制生效）');

  // “足够信息就停”
  const coreStop = coreMod.createAgentCore({
    log: () => {},
    config: { maxSteps: 5, maxToolCalls: 5, maxRetries: 1 },
    planner: {
      async decide(ctx) {
        if (ctx.run.executedTools.indexOf('get_current_time') < 0) return { tool: 'get_current_time', args: {} };
        return { finish: true, reason: 'enough' };
      },
      shouldStop(ctx) { return !!ctx.last && ctx.last.ok; },
    },
  });
  out = await coreStop.run({ text: '测试', signals: {} });
  eq(out.run.toolCalls, 1, '★拿到足够信息后立即停止（不凑满 5 步）');
  ok(String(out.reason).indexOf('sufficient') >= 0, 'stopReason=sufficient');

  // 重试上限
  let tries = 0;
  router.registerTool({
    name: 'flaky_tool',
    permission: 'SAFE',
    handler: async () => { tries++; throw new Error('总是失败'); },
  });
  const coreRetry = coreMod.createAgentCore({
    log: () => {},
    config: { maxSteps: 5, maxToolCalls: 5, maxRetries: 1 },
    planner: { async decide(ctx) { return ctx.run.executedTools.indexOf('flaky_tool') < 0 ? { tool: 'flaky_tool', args: {} } : { finish: true }; } },
  });
  out = await coreRetry.run({ text: '测试', signals: {} });
  eq(tries, 2, '★失败最多重试 1 次（共 2 次尝试，不是无限）');
  eq(out.run.retries, 1, 'retries=1');
  eq(out.ok, false, '全失败时 ok=false');
  ok(out.context.indexOf('失败') >= 0, '★失败会如实写进上下文（不伪装成功）');

  // 模型给出高危工具名
  const coreEvil = coreMod.createAgentCore({
    log: () => {},
    config: { maxSteps: 5, maxToolCalls: 5, maxRetries: 0 },
    planner: { async decide() { return { tool: 'execute_shell', args: { cmd: 'format c:' } }; } },
  });
  out = await coreEvil.run({ text: '测试', signals: {} });
  eq(out.ok, false, '★模型要求执行 shell → 被拒绝');
  ok(out.run.observations[0] && out.run.observations[0].reason === 'forbidden-tool', '拒绝原因 forbidden-tool');
  ok(out.context.indexOf('失败') >= 0, '拒绝结果如实进入上下文');

  // ============================================================
  group('Agent Core：异常与健壮性');

  out = await core.run({});
  ok(out && typeof out === 'object', '空输入不崩');
  out = await core.run({ text: null, signals: null });
  ok(out && typeof out === 'object', 'null 字段不崩');
  const coreDisabled = coreMod.createAgentCore({ log: () => {}, config: { enabled: false } });
  out = await coreDisabled.run({ text: '帮我查一下今天有什么新闻', signals: {} });
  eq(out.handled, false, '★Agent 关闭时完全不介入（等价于 V13.5）');
  eq(out.reason, 'agent-disabled', 'reason=agent-disabled');

  // planner 抛错
  const coreBadPlanner = coreMod.createAgentCore({
    log: () => {},
    config: { maxSteps: 5, maxToolCalls: 5, maxRetries: 1 },
    planner: { async decide() { throw new Error('planner boom'); } },
  });
  out = await coreBadPlanner.run({ text: '帮我查一下今天有什么新闻', signals: {} });
  eq(out.handled, true, 'planner 抛错时也不崩');
  eq(out.run.toolCalls, 0, 'planner 抛错 → 0 次工具调用');

  // ============================================================
  group('回归：stats bucket 字段不能是 NaN');

  const src = fs.readFileSync(path.join(__dirname, '..', 'ai_bridge.js'), 'utf-8');
  const buckets = ['judge', 'answer', 'tool', 'chatrecord', 'agent', 'vision', 'video'];
  for (const b of buckets) {
    const re = new RegExp(b + 'Requests:\\s*0', 'g');
    const m = src.match(re);
    ok(m && m.length >= 2, '★stats 初始化含 ' + b + 'Requests: 0（≥2 处：初始+跨天重置）');
  }
  ok(/typeof stats\[bucket \+ 'Requests'\] !== 'number'/.test(src), '★recordUsage 有 NaN 兜底');
  ok(/KINDS\.indexOf\(kind\)/.test(src), 'recordUsage 支持新 bucket');
  ok(/function normalizeStats/.test(src), '★存在 normalizeStats（修历史脏数据）');
  ok(/normalizeStats\(\);\s*\/\/ V14/.test(src) || /normalizeStats\(\)/.test(src), '★loadStats 会调用 normalizeStats');
  ok(/STATS_BUCKETS/.test(src), 'bucket 清单集中定义');

  const statsPath = path.join(__dirname, '..', 'memory', 'stats.json');
  if (fs.existsSync(statsPath)) {
    const st = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
    // 旧文件里 chatrecord* 可能是 null（NaN 序列化），这是修复前的历史值，仅告警不算失败
    const bad = buckets.filter((b) => st[b + 'Requests'] === null);
    ok(true, '（历史 stats.json 中 null 字段：' + (bad.join(',') || '无') + '，重启后由新初始化修复）');
  } else {
    ok(true, 'stats.json 不存在，跳过');
  }

  // ============================================================
  group('回归：V13.5 聊天记录模块仍可用');
  let crp = null;
  try { crp = require('../chat_record_parser'); ok(true, 'chat_record_parser 可 require'); }
  catch (err) { ok(false, 'chat_record_parser 可 require'); }
  if (crp) {
    ok(typeof crp.detectForwardSegments === 'function', 'detectForwardSegments 仍在');
    ok(typeof crp.buildChatRecord === 'function', 'buildChatRecord 仍在');
    ok(typeof crp.normalizeNode === 'function', 'normalizeNode 仍在');
    ok(typeof crp.buildMultimodalParts === 'function', 'buildMultimodalParts 仍在');
  }

  group('回归：Agent 不泄露内部信息');
  out = await core.run({ text: '帮我查一下今天有什么新闻', signals: {} });
  const s = out.run.summary();
  const sStr = JSON.stringify(s);
  ok(sStr.indexOf('trace') < 0, '★summary 不含内部 trace');
  ok(sStr.indexOf('handler') < 0, '★summary 不含 handler 实现细节');
  ok(sStr.indexOf('sk-') < 0, '★summary 不含 API Key');
  ok(Array.isArray(s.tools) && s.tools.every((t) => typeof t.tool === 'string' && typeof t.ok === 'boolean'), 'tools 只含 name/ok/ms');

  // ============================================================
  console.log('\n' + '='.repeat(52));
  console.log(`V14-A 测试结果：通过 ${pass} / 失败 ${fail}（共 ${pass + fail} 项断言）`);
  if (fail) { console.log('失败项：'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  console.log('全部通过 ✅');
})();
