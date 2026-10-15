'use strict';
// ================= V14-C.1 测试套件：B站意图优先 + 同轮工具互斥 =================
// 目标：
//   ① B站专属意图 > 普通 Web 搜索意图（「B站搜索一下GTA6视频」只出 bilibili_search）；
//   ② 同一轮 Agent Run 内，bilibili_search 成功后再也不执行 web_search（不建全局状态）；
//   ③ 不误伤普通 Web 搜索，也不因为单独出现「视频」就强行调 B站。
// 说明：B站 Tool 在单元测试里用「同形状桩」替换，避免测试打真实接口（真实 API 单独跑）。

const router = require('../agent/tool_router');
const intentMod = require('../agent/intent');
const coreMod = require('../agent/agent_core');
const stateMod = require('../agent/state');
const tools = require('../tools');
const R = require('../tools/result');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name) { if (cond) pass++; else { fail++; fails.push(name); console.log('  ✗ ' + name); } }
function eq(a, b, name) { ok(a === b, name + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function group(t) { console.log('\n[' + t + ']'); }

const hasTool = (x, n) => x.suggestedTools.some((t) => t.tool === n);
const countTool = (x, n) => x.suggestedTools.filter((t) => t.tool === n).length;

// —— 依赖桩（形状与 ai_bridge 注入的一致）——
function makeDeps(over) {
  return Object.assign({
    getCurrentTime: () => '2026-10-08 19:00 星期四',
    webSearch: async (q) => '搜索「' + q + '」的结果：\n1. 标题一\n   https://a.com',
    fetchUrl: async () => '网页正文',
    isSafeUrl: () => true,
    getNotes: () => [],
    getShortTerm: () => [],
    rememberNote: () => '记住了',
    readFile: () => ({ ok: false, error: '无' }),
    writeFile: () => ({ ok: true, name: 'a.txt', size: 3 }),
    listFiles: () => [{ name: 'a.txt', size: 6 }],
    isWritableName: () => true,
    getForwardMsg: null,
    getPendingRecord: null,
    visionAnalyze: async () => ({ ok: true, text: 'ok', imageCount: 1, imageOK: 1, imageFail: 0 }),
    analyzeVideo: async () => ({ ok: true, data: { width: 1920, height: 1080, duration: 8, firstFrameAvailable: true } }),
    bilibiliEnabled: false,     // 关闭真实 B站注册，改用下面的同形状桩
  }, over || {});
}

// 与 tools/bilibili.js 完全同形状的桩（不做真实网络请求）
const biliCalls = [];
function registerBiliStub(forceFail) {
  biliCalls.length = 0;
  return router.registerTool({
    name: 'bilibili_search',
    description: 'B站搜索桩',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1, maxLength: 60 } },
      required: ['query'],
      additionalProperties: false,
    },
    permission: router.PERMISSION.SAFE,
    timeout: 5000,
    tokenCost: 1,
    riskLevel: 'low',
    handler: async (args) => {
      biliCalls.push(args.query);
      const ms = 3;
      if (forceFail) return R.failResult('bilibili_search', 'B站请求失败（桩）', true, { durationMs: ms });
      const items = [{
        title: 'GTA6 最新预告', bvid: 'BV1mRHy6fEaC', author: '某UP',
        url: 'https://www.bilibili.com/video/BV1mRHy6fEaC',
        description: '简介', duration: '3:20', pubdate: null, play: 12345,
      }];
      return R.okResult('bilibili_search', { query: args.query, items, note: '仅搜索结果' },
        'B站搜索「' + args.query + '」共 1 条', { durationMs: ms, itemCount: items.length });
    },
  });
}

(async () => {
  // ============================================================
  group('意图优先级：B站 → bilibili_search（且 web_search=0）');

  const BILI_CASES = [
    'B站搜索一下GTA6视频',
    '帮我找B站GTA6',
    '找几个B站视频',
    'B站有没有这个',
    '搜索B站Minecraft',
    '去B站搜一下',
    'B站有没有GTA6相关视频',
    '帮我在B站找一下 黑神话 的实况',
  ];
  for (const c of BILI_CASES) {
    const x = intentMod.detectIntent(c, {});
    ok(hasTool(x, 'bilibili_search'), '「' + c + '」→ bilibili_search');
    eq(countTool(x, 'web_search'), 0, '★「' + c + '」不再同时触发 web_search');
    eq(x.primary, 'bilibili_search', '  primary=bilibili_search');
  }

  let x = intentMod.detectIntent('BV1mRHy6fEaC', {});
  ok(hasTool(x, 'bilibili_search'), '直接给 BV 号 → bilibili_search');
  eq(countTool(x, 'web_search'), 0, '★BV 号也不触发 web_search');

  x = intentMod.detectIntent('B站搜索一下GTA6视频', {});
  eq(x.suggestedTools.length, 1, '★「B站搜索一下GTA6视频」只建议 1 个工具');
  eq(x.suggestedTools[0].tool, 'bilibili_search', '  这 1 个工具就是 bilibili_search');
  eq(x.suggestedTools[0].args.query, 'GTA6', '★B站 query 已去掉「B站/搜索/视频」噪音 → GTA6');

  x = intentMod.detectIntent('找几个B站Minecraft视频', {});
  eq(x.suggestedTools[0].args.query, 'Minecraft', '★query = Minecraft（去掉 找几个/B站/视频）');

  // ============================================================
  group('不误伤：普通 Web 搜索仍然是 web_search');

  const WEB_CASES = ['搜索一下GTA6最新新闻', '搜索DeepSeek最新消息', '查一下今天的新闻', '帮我查一下今天有什么新闻'];
  for (const c of WEB_CASES) {
    const y = intentMod.detectIntent(c, {});
    ok(hasTool(y, 'web_search'), '「' + c + '」→ web_search');
    eq(countTool(y, 'bilibili_search'), 0, '★「' + c + '」不触发 bilibili_search');
  }

  x = intentMod.detectIntent('搜索一下GTA6最新新闻', {});
  eq(x.suggestedTools.length, 1, '★普通搜索仍然只建议 1 个工具（web_search）');
  eq(x.primary, 'web_search', '  primary=web_search');

  // ============================================================
  group('边界：不因为「视频/B站」字样就强行调 B站');

  x = intentMod.detectIntent('B站', {});
  eq(countTool(x, 'bilibili_search'), 0, '★只说「B站」→ 不调 B站工具');
  eq(x.needsTools, false, '  needsTools=false');

  x = intentMod.detectIntent('视频', {});
  eq(countTool(x, 'bilibili_search'), 0, '★只说「视频」→ 不调 B站工具');

  x = intentMod.detectIntent('B站视频', {});
  eq(countTool(x, 'bilibili_search'), 0, '★「B站视频」没有搜/找意图 → 不调 B站工具');

  x = intentMod.detectIntent('搜索视频', {});
  ok(hasTool(x, 'web_search'), '★「搜索视频」（没点名 B站）→ web_search');
  eq(countTool(x, 'bilibili_search'), 0, '  ★不强行变成 bilibili_search');

  x = intentMod.detectIntent('找视频', {});
  eq(countTool(x, 'bilibili_search'), 0, '★「找视频」→ 不调 B站工具');

  x = intentMod.detectIntent('我挺喜欢那个UP主的', {});
  eq(countTool(x, 'bilibili_search'), 0, '★只是提到 UP 主 → 不调 B站工具（V14-C 回归）');

  // ============================================================
  group('同轮互斥（纯 run 级，无全局状态）');

  eq(JSON.stringify(coreMod.TOOL_MUTEX.bilibili_search), JSON.stringify(['web_search']),
    '★互斥表：bilibili_search → web_search');
  eq(coreMod.TOOL_MUTEX.web_search, undefined, '★单向：web_search 不屏蔽任何工具');

  const runFresh = stateMod.newRun({});
  eq(coreMod.isSuppressed(runFresh, 'web_search'), false, '新 run：web_search 未被屏蔽');

  const runBili = stateMod.newRun({});
  runBili.observations.push({ tool: 'bilibili_search', ok: true, summary: 'ok', ms: 3 });
  eq(coreMod.isSuppressed(runBili, 'web_search'), true, '★B站搜索成功后：web_search 被屏蔽');
  eq(coreMod.isSuppressed(runBili, 'bilibili_search'), false, '  自己不屏蔽自己');

  const runFailed = stateMod.newRun({});
  runFailed.observations.push({ tool: 'bilibili_search', ok: false, summary: '失败', ms: 3 });
  eq(coreMod.isSuppressed(runFailed, 'web_search'), false, '★B站搜索失败 → 不屏蔽（只在成功时生效）');

  const runWeb = stateMod.newRun({});
  runWeb.observations.push({ tool: 'web_search', ok: true, summary: 'ok', ms: 3 });
  eq(coreMod.isSuppressed(runWeb, 'bilibili_search'), false, '★普通 web_search 不屏蔽其他工具');

  const runOther = stateMod.newRun({});
  runOther.observations.push({ tool: 'get_current_time', ok: true, summary: 'ok', ms: 1 });
  eq(coreMod.isSuppressed(runOther, 'web_search'), false, '★无关工具不产生屏蔽');

  // 规划器层面：B站成功后只剩 web_search → 直接 finish
  router.reset();
  tools.registerAll(makeDeps());   // 规划器要靠 Registry 判断工具可用性，先注册
  const planner = coreMod.defaultPlanner();
  const fakeIntent = { suggestedTools: [{ tool: 'web_search', args: { query: 'GTA6' }, why: '' }] };
  let d1 = await planner.decide({ run: runBili, intent: fakeIntent, input: {} });
  ok(d1 && d1.finish === true, '★规划器：B站已成功 → 不再返回 web_search');
  let d2 = await planner.decide({ run: runFresh, intent: fakeIntent, input: {} });
  eq(d2 && d2.tool, 'web_search', '★规划器：全新 run → web_search 正常放行（无全局状态残留）');

  // ============================================================
  group('Agent Core 端到端：B站搜索只跑 bilibili_search');

  router.reset();
  tools.registerAll(makeDeps());
  ok(registerBiliStub(false).ok, '注册 B站桩（与真实工具同形状）');
  ok(router.hasTool('bilibili_search') && router.hasTool('web_search'), 'bilibili_search + web_search 均已注册');

  const core = coreMod.createAgentCore({ log: () => {}, config: { maxSteps: 5, maxToolCalls: 5, maxRetries: 1 } });

  let out = await core.run({ text: 'B站搜索一下GTA6视频', signals: {} });
  eq(out.handled, true, '「B站搜索一下GTA6视频」走 Agent');
  eq(out.run.observations.filter((o) => o.tool === 'bilibili_search').length, 1, '★bilibili_search = 1');
  eq(out.run.observations.filter((o) => o.tool === 'web_search').length, 0, '★web_search = 0');
  eq(out.run.toolCalls, 1, '★整轮只调用 1 次工具（不再多花一次搜索）');
  eq(biliCalls.length, 1, '  B站桩只被调了 1 次');
  eq(biliCalls[0], 'GTA6', '  B站 query = GTA6');

  out = await core.run({ text: '搜索GTA6最新新闻', signals: {} });
  eq(out.run.observations.filter((o) => o.tool === 'web_search').length, 1, '★普通搜索 → web_search = 1');
  eq(out.run.observations.filter((o) => o.tool === 'bilibili_search').length, 0, '  且 bilibili_search = 0');

  out = await core.run({ text: '你好', signals: {} });
  eq(out.handled, false, '★「你好」仍然 0 工具调用（V14-A 回归）');

  // ============================================================
  group('硬闸：即使规划器想再跑 web_search 也被本轮互斥拦下');

  router.reset();
  tools.registerAll(makeDeps());
  registerBiliStub(false);
  const coreGate = coreMod.createAgentCore({
    log: () => {},
    config: { maxSteps: 5, maxToolCalls: 5, maxRetries: 1 },
    // 故意「不听话」的规划器：B站跑完还要再跑一次 web_search
    planner: {
      async decide(ctx) {
        if (ctx.run.executedTools.indexOf('bilibili_search') < 0) {
          return { tool: 'bilibili_search', args: { query: 'GTA6' }, why: 'test' };
        }
        return { tool: 'web_search', args: { query: 'GTA6' }, why: 'test' };
      },
      shouldStop() { return false; },
    },
  });
  out = await coreGate.run({ text: 'B站搜索一下GTA6视频', signals: {} });
  eq(out.run.toolCalls, 1, '★只执行了 1 次工具（web_search 被硬闸拦下）');
  eq(out.run.observations.filter((o) => o.tool === 'web_search').length, 0, '★web_search = 0');
  eq(out.reason, 'mutex-blocked', '  reason = mutex-blocked');

  // 反过来：web_search 之后不该被拦
  router.reset();
  tools.registerAll(makeDeps());
  registerBiliStub(false);
  const coreRev = coreMod.createAgentCore({
    log: () => {},
    config: { maxSteps: 5, maxToolCalls: 5, maxRetries: 1 },
    planner: {
      async decide(ctx) {
        if (ctx.run.executedTools.indexOf('web_search') < 0) {
          return { tool: 'web_search', args: { query: 'GTA6' }, why: 'test' };
        }
        return { tool: 'bilibili_search', args: { query: 'GTA6' }, why: 'test' };
      },
      shouldStop() { return false; },
    },
  });
  out = await coreRev.run({ text: '搜索一下GTA6', signals: {} });
  eq(out.run.toolCalls, 2, '★web_search 不屏蔽其他工具（互斥是单向的）');

  // ============================================================
  group('回归：Token / 上限 / 安全边界未被破坏');

  eq(core.config.maxSteps, 5, 'maxSteps 仍为 5');
  eq(core.config.maxToolCalls, 5, 'maxToolCalls 仍为 5');
  eq(core.config.maxRetries, 1, 'maxRetries 仍为 1');

  const pm = tools.permissionMap();
  eq(pm.SENSITIVE.length, 0, '★SENSITIVE 仍然为空');
  ok(pm.SAFE.indexOf('web_search') >= 0, 'web_search 仍是 SAFE');

  let r = await router.execute('execute_shell', { cmd: 'dir' }, {});
  ok(!r.ok && r.reason === 'forbidden-tool', '★execute_shell 仍被拒绝');
  r = await router.execute('bilibili_search', { query: '' }, {});
  ok(!r.ok, '★B站空 query 仍被 Schema 拒（桩保持同形状校验）');

  // ============================================================
  console.log('\n' + '='.repeat(52));
  console.log(`V14-C.1 测试：通过 ${pass}，失败 ${fail}`);
  if (fail) { console.log('失败项：'); fails.forEach((f) => console.log('  - ' + f)); }
  console.log('='.repeat(52));
  process.exit(fail ? 1 : 0);
})();
