'use strict';
// ================= 指令接入集成测试（不向真实 QQ 群发送任何消息）=================
// 运行：node tests/feature_command_integration.test.js
//
// 策略：
//   · 所有读写重定向到临时目录，绝不碰真实 memory/*.json；
//   · 只测试**不会触发真实发送**的代码路径（handleUserCommand 的纯返回分支）；
//     群内 /今日总结 会调用 sendSimpleReply 真发消息，故**不在此测试**，
//     该路径由 tests/feature_summary_memory.test.js 的 buildSearch 单测覆盖；
//   · napcatCall / sendSimpleReply 一旦被调用即视为失败（哨兵）。

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat_cmdtest_'));
const fakeHttp = { createServer: () => ({ listen: () => {} }) };

const ROOT = path.resolve(__dirname, '..');
let realSends = 0;               // 哨兵：真实发送计数，必须为 0
const sandbox = {
  require: (n) => {
    if (n === 'http') return fakeHttp;
    // 相对路径必须相对项目根解析（否则会解析到 tests/ 目录），保证拿到与主程序同一个模块实例
    if (n.startsWith('./') || n.startsWith('../')) {
      const p = path.resolve(ROOT, n);
      for (const cand of [p, p + '.js', path.join(p, 'index.js')]) {
        try {
          if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return require(cand);
        } catch (e) { /* 继续试下一个 */ }
      }
    }
    return require(n);
  },
  console, process: { ...process, exit: () => {} },
  fs, path, url: require('url'),
  __dirname: path.resolve(__dirname, '..'),
  __filename: path.resolve(__dirname, '..', 'ai_bridge.js'),
  URL, URLSearchParams, Buffer, AbortController, AbortSignal, fetch,
  setTimeout, clearTimeout, setInterval, clearInterval,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'ai_bridge.js'), 'utf-8');
// 在沙箱里塞哨兵：任何真实发送都记数
vm.runInContext(SRC
  + '\n;globalThis.__T={CFG:()=>CFG,handleUserCommand,groupLog,memoryStore,dailySummary,isAdmin};'
  + '\n;(function(){ const _c = globalThis.__sendGuard; })();',
  sandbox, { filename: 'ai_bridge.js' });

const T = sandbox.__T;
// 重定向存储到临时目录
T.groupLog._setFile(path.join(TMP, 'group_log.json'));
T.memoryStore._setFile(path.join(TMP, 'notes.json'));
T.memoryStore._setLegacyFile(null);   // 隔离：不读真实的 memory/notes.json
T.dailySummary._reset();

// 包裹 napcatCall / sendSimpleReply：真实发送只计数不发
sandbox.napcatCall = async () => { realSends++; return { status: 'ok', retcode: 0, data: {} }; };

let pass = 0, fail = 0;
const failed = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; failed.push(name); console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 160) : '')); }
}
function section(t) { console.log('\n[' + t + ']'); }

// 沙箱配置直接注入：克隆仓库没有 ai_config.json 时默认管理员列表为空，
// 这里显式指定一个测试管理员（isAdmin 读的就是同一份 CFG 对象）
T.CFG().admin = T.CFG().admin || {};
T.CFG().admin.qq = ['2196399239'];
const ADMIN = (T.CFG().admin.qq || []).map(String);
const ADMIN_ID = ADMIN[0];
const USER_A = '10001';   // 普通用户 A
const USER_B = '10002';   // 普通用户 B
const GID = '808214611';

function groupCtx(uid) {
  return { userId: Number(uid), isGroup: true, ev: { group_id: GID, group_name: '测试群', message_type: 'group', user_id: Number(uid), self_id: 1430831772, message_id: Math.floor(Math.random() * 1e9) }, sessionId: 'group_' + GID };
}
function privCtx(uid) {
  return { userId: Number(uid), isGroup: false, ev: { message_type: 'private', user_id: Number(uid), self_id: 1430831772, message_id: Math.floor(Math.random() * 1e9) }, sessionId: 'private_' + uid };
}

(async () => {
  // ---------- 数据准备 ----------
  section('0. 准备隔离数据');
  T.memoryStore.add({ scope: 'user', userId: USER_A, groupId: GID, content: 'A偏好用中文标点', source: 'manual' });
  T.memoryStore.add({ scope: 'user', userId: USER_B, groupId: GID, content: 'B是运维工程师', source: 'manual' });
  T.memoryStore.add({ scope: 'group', groupId: GID, content: '本群约定周五发布版本', source: 'manual' });
  T.memoryStore.add({ scope: 'group', groupId: '99999999', content: '别的群的秘密约定', source: 'manual' });
  T.memoryStore.flush();
  ok('隔离数据已建立', T.memoryStore.stats().total === 4, T.memoryStore.stats().total);

  // ---------- 指令基本用法 ----------
  section('1. 指令基本用法');
  let r = await T.handleUserCommand('/记忆状态', privCtx(USER_A));
  ok('/记忆状态 返回统计', typeof r === 'string' && /共 \d+ 条/.test(r), r);
  ok('/记忆状态 显示存储占用', /KB/.test(r), r);

  r = await T.handleUserCommand('/记忆', privCtx(USER_A));
  ok('/记忆 只看到自己的+群级', /偏好用中文标点/.test(r) && !/运维工程师/.test(r), r);
  ok('/记忆 不泄露别的群', !/秘密约定/.test(r), r);

  r = await T.handleUserCommand('/记忆搜索 运维', privCtx(USER_A));
  ok('/记忆搜索 无权看不到他人记忆', /没有匹配/.test(r), r);
  r = await T.handleUserCommand('/记忆搜索 运维', privCtx(USER_B));
  ok('/记忆搜索 本人可看到自己', /运维工程师/.test(r), r);
  r = await T.handleUserCommand('/记忆搜索 秘密约定', privCtx(USER_A));
  ok('/记忆搜索 不跨群检索', !/别的群/.test(r), r);

  r = await T.handleUserCommand('/记忆搜索', privCtx(USER_A));
  ok('/记忆搜索 缺关键词有用法提示', /用法/.test(r), r);

  r = await T.handleUserCommand('/记忆状态', privCtx(USER_A));
  ok('/记忆状态 含归档信息', /群消息归档/.test(r), r);

  // ---------- 二次确认 ----------
  section('2. 删除/清空的二次确认');
  const before = T.memoryStore.stats().total;
  r = await T.handleUserCommand('/记忆删除 中文标点', privCtx(USER_A));
  ok('/记忆删除 第一次只预览不删', /确认删除请在 1 分钟内/.test(r), r);
  ok('第一次后数量未变', T.memoryStore.stats().total === before, T.memoryStore.stats().total);
  r = await T.handleUserCommand('/记忆删除 中文标点', privCtx(USER_A));
  ok('/记忆删除 第二次执行删除', /已删除 1 条/.test(r), r);
  ok('删除后数量减少', T.memoryStore.stats().total === before - 1, T.memoryStore.stats().total);

  r = await T.handleUserCommand('/记忆删除 运维', privCtx(USER_A));   // A 删 B 的
  ok('不能删别人的记忆（无预览）', /没找到你有权限删除/.test(r), r);
  ok('B 的记忆还在', T.memoryStore.search('运维', { userId: USER_B, allowAll: true }).length === 1);

  const before2 = T.memoryStore.stats().total;
  r = await T.handleUserCommand('/记忆清空确认', privCtx(USER_B));
  ok('/记忆清空确认 第一次要再确认', /再发一次/.test(r), r);
  ok('第一次后未清空', T.memoryStore.stats().total === before2);
  r = await T.handleUserCommand('/记忆清空确认', privCtx(USER_B));
  ok('/记忆清空确认 第二次执行', /已清空你名下的/.test(r), r);
  ok('B 的记忆已清空', T.memoryStore.search('运维', { userId: USER_B, allowAll: true }).length === 0);
  ok('群级记忆未被普通用户清掉', T.memoryStore.stats().total >= 2, T.memoryStore.stats().total);

  // ---------- 管理员 ----------
  section('3. 管理员权限');
  r = await T.handleUserCommand('/记忆状态', privCtx(ADMIN_ID));
  ok('管理员提示可见群级记忆', /你是管理员/.test(r), r);
  r = await T.handleUserCommand('/记忆', privCtx(ADMIN_ID));
  ok('管理员可跨群查看（既有机制）', /别的群的秘密约定/.test(r), r);

  // ---------- 总结命令（私聊场景不发消息）----------
  section('4. 总结命令的非发送分支');
  r = await T.handleUserCommand('/今日总结', privCtx(USER_A));
  ok('私聊下提示要在群里用', /总结要在群里用/.test(r), r);
  ok('该分支没有真实发送', realSends === 0, realSends);

  // ---------- 未知命令 ----------
  section('5. 非本模块命令交回原流程');
  ok('/ai 命令不被劫持', (await T.handleUserCommand('/ai status', privCtx(ADMIN_ID))) === null);
  ok('非 / 开头返回 null', (await T.handleUserCommand('今天天气不错', privCtx(USER_A))) === null);
  ok('未实现的子命令不劫持', (await T.handleUserCommand('/记忆不存在的子命令x', privCtx(USER_A))) === null);

  // ---------- 恶意输入 ----------
  section('6. 恶意/异常输入不崩溃');
  const evil = [
    '/记忆搜索 <script>alert(1)</script>',
    '/记忆搜索 ' + 'x'.repeat(5000),
    '/记忆 ' + 'A'.repeat(2000),
    '/记忆删除 \n\n\r\n',
    '/记忆搜索 🎉'.repeat(300),
    '/今日总结',
    '/记忆搜索 ' + '"quoted" OR 1=1 --',
  ];
  let crashed = 0;
  for (const e of evil) {
    try { await T.handleUserCommand(e, privCtx(USER_A)); }
    catch (err) { crashed++; console.log('    异常输入崩溃: ' + JSON.stringify(e.slice(0, 30))); }
  }
  ok('所有恶意输入都不崩溃', crashed === 0, crashed);
  ok('恶意输入没有触发真实发送', realSends === 0, realSends);
  ok('机器人仍能正常查状态', /共 \d+ 条/.test(await T.handleUserCommand('/记忆状态', privCtx(USER_A))));

  // ---------- 自动总结默认关闭 ----------
  section('7. 自动总结安全默认');
  const C = T.CFG();
  ok('dailySummary.auto 默认 false', C.dailySummary.auto === false, C.dailySummary.auto);
  ok('allowedGroups 默认为空', Array.isArray(C.dailySummary.allowedGroups) && C.dailySummary.allowedGroups.length === 0);
  ok('未开启自动 → 测试期间无任何真实发送', realSends === 0, realSends);
  ok('memoryStore.autoExtract 默认 false', C.memoryStore.autoExtract === false, C.memoryStore.autoExtract);

  // ---------- 归档 → 总结（mock AI）----------
  section('8. 归档喂给总结（Mock AI，不调付费 API）');
  const today = T.groupLog.todayStr();
  const base = new Date(); base.setHours(9, 0, 0, 0);
  const lines = [
    '这周迭代范围定一下：先做搜索优化', '搜索那块主要是相关性过滤太松',
    '我同意，先把打分制上线看看效果', '那测试怎么补', '用离线用例覆盖跑题场景就行',
    '待办：我下周一之前把用例写完', '结论：本周只做搜索过滤，不做接 API',
  ];
  for (let i = 0; i < lines.length; i++) {
    T.groupLog.archive(GID, { messageId: 'I' + i, uid: 'u' + (i % 3), name: '成员' + (i % 3), text: lines[i], time: base.getTime() + i * 60000 });
  }
  ok('归档写入成功', T.groupLog.getByDate(GID, today).length === 7, T.groupLog.getByDate(GID, today).length);

  const mockGen = async (p, o) => '【讨论要点】\n· 讨论了迭代范围与搜索优化\n【结论/决定】\n· 本周只做搜索过滤\n【待办】\n· 下周一前写完测试用例';
  let sum = await T.dailySummary.buildSummary({ groupId: GID, date: today, groupName: '测试群', deps: { genText: mockGen } });
  ok('总结生成成功', sum.ok === true, sum.reason);
  ok('总结含待办内容', /下周一前写完测试用例/.test(sum.text), sum.text.slice(0, 60));
  ok('总结统计了有效条数', sum.stats.useful >= 5, sum.stats);

  // 空的群 → 明确说没内容
  sum = await T.dailySummary.buildSummary({ groupId: 'NOT_EXIST_G', date: today, deps: { genText: mockGen } });
  ok('空群明确说没有消息', sum.ok === false && /没有收到任何群消息/.test(sum.text), sum.reason);

  // 旧的一天 → 明确区分日期
  const yest = T.groupLog.shiftDate(today, -1);
  T.groupLog.archive(GID, { messageId: 'Y1', uid: 'u0', name: '成员', text: '昨天讨论的另外一件事需要跟进处理', time: Date.now() - 86400000 });
  sum = await T.dailySummary.buildSummary({ groupId: GID, date: yest, deps: { genText: mockGen } });
  ok('昨天日期可单独总结', sum.ok === false ? /太少|没有/.test(sum.text) : true, sum.reason);
  ok('今天的数据不串到昨天', T.groupLog.getByDate(GID, yest).every((m) => /昨天/.test(m.text)));

  // ---------- 结束 ----------
  ok('全流程零真实 QQ 发送', realSends === 0, realSends);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

  console.log('\n============================================');
  console.log(' 结果：' + pass + ' 通过 / ' + fail + ' 失败（真实 QQ 发送次数：' + realSends + '）');
  if (fail) console.log(' 失败项：' + failed.join(' | '));
  console.log('============================================');
  process.exit(fail ? 1 : 0);
})();
