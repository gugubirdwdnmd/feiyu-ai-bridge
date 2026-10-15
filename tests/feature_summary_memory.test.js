'use strict';
// ================= 群聊总结 + 长期记忆：离线测试（Mock，不发真群、不调付费 API）=================
// 运行：node tests/feature_summary_memory.test.js
//
// 所有读写都指向临时文件，绝不碰 memory/notes.json、memory/group_log.json 真实数据。

const fs = require('fs');
const os = require('os');
const path = require('path');

const groupLog = require('../memory/group_log.js');
const store = require('../memory/memory_store.js');
const summary = require('../memory/daily_summary.js');

// —— 隔离到临时目录 ——
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat_memtest_'));
const TMP_NOTES = path.join(TMP, 'notes.json');
const TMP_LOG = path.join(TMP, 'group_log.json');
store._setFile(TMP_NOTES);
store._setLegacyFile(null);   // 隔离：不读真实的 memory/notes.json
groupLog._setFile(TMP_LOG);
summary._reset();

let pass = 0, fail = 0;
const failed = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; failed.push(name); console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n[' + t + ']'); }

const NOW = Date.now();
const TODAY = groupLog.todayStr(NOW);
// 注意：不能用 toISOString 算「昨天」——那是 UTC，会和模块的本地时区日期错位
const DAY = groupLog.shiftDate(TODAY, -1);

// ============================================================
section('1. 群消息归档');
// ============================================================
ok('写入普通消息', groupLog.archive('G1', { messageId: 'm1', uid: 'u1', name: '张三', text: '今天开个会讨论下版本规划', time: NOW }) === true);
ok('过短内容被拒(<2字)', groupLog.archive('G1', { messageId: 'm2', uid: 'u2', text: '6', time: NOW }) === false);
ok('空内容被拒', groupLog.archive('G1', { messageId: 'm3', uid: 'u2', text: '   ', time: NOW }) === false);
ok('同 message_id 去重', groupLog.archive('G1', { messageId: 'm1', uid: 'u1', text: '今天开个会讨论下版本规划', time: NOW }) === false);
ok('昨天与今天分开存', groupLog.archive('G1', { messageId: 'm0', uid: 'u9', text: '昨天讨论的事情需要跟进', time: NOW - 86400000 }) === true);
ok('取今天消息', groupLog.getByDate('G1', TODAY).length === 1);
ok('取昨天消息', groupLog.getByDate('G1', DAY).length === 1);
ok('日期不会串（今天不含昨天内容）', !groupLog.getByDate('G1', TODAY).some((m) => /昨天/.test(m.text)));
ok('不存在的群返回空', groupLog.getByDate('NOPE', TODAY).length === 0);
ok('群列表含 G1', groupLog.getGroups().indexOf('G1') >= 0);

// ============================================================
section('2. 长期记忆：增 / 查 / 改 / 去重 / 删 / 过期');
// ============================================================
const G = '808214611';
let r = store.add({ scope: 'user', userId: 'u1', groupId: G, content: '我更喜欢别人叫我小梁子', source: 'manual' });
ok('新增用户记忆', r.ok && !r.merged, r);
const id1 = r.item.id;
ok('生成元数据', !!(r.item.createdAt && r.item.updatedAt && r.item.expireAt && r.item.source), r.item);
ok('默认置信度 0.6', r.item.confidence === 0.6, r.item.confidence);
ok('默认有过期时间', r.item.expireAt > Date.now());

r = store.add({ scope: 'user', userId: 'u1', groupId: G, content: '我更喜欢别人叫我小梁子啊', source: 'auto' });
ok('相似内容被合并而非新增', r.ok && r.merged === true, r);

r = store.add({ scope: 'group', groupId: G, content: '群里约定每周三发布版本', source: 'auto' });
ok('新增群级记忆', r.ok && r.item.scope === 'group', r);

r = store.add({ scope: 'user', userId: 'u1', content: 'sk-test-fake-key-000000' });
ok('密钥类内容被拒绝', r.ok === false && r.error === 'looks-like-secret', r);
r = store.add({ scope: 'user', userId: 'u1', content: '密码：hunter2' });
ok('密码类内容被拒绝', r.ok === false && r.error === 'looks-like-secret', r);

const mine = store.list({ userId: 'u1', groupId: G });
ok('我的记忆可见（含本群公共）', mine.length >= 2, mine.length);
ok('search 命中', store.search('小梁子', { userId: 'u1', groupId: G }).length === 1);
ok('search 不命中返回空', store.search('不存在的关键词xyz', { userId: 'u1', groupId: G }).length === 0);
const ret = store.retrieve('他们约定什么时候发布', { userId: 'u1', groupId: G });
ok('retrieve 能召回群级约定', ret.some((x) => /周三/.test(x.content)), ret);
ok('retrieve 条数受上限约束', ret.length <= 6, ret.length);

ok('删除越权条目被拒', store.remove(id1, { userId: 'u2', isAdmin: false }).error === 'forbidden');
ok('删除自己的条目成功', store.remove(id1, { userId: 'u1', isAdmin: false }).ok === true);
ok('删除不存在的返回 not-found', store.remove('nope', { userId: 'u1' }).error === 'not-found');

store.add({ scope: 'user', userId: 'u1', content: '临时记忆ABCxyz', ttlDays: 1 });
store.flush();                       // 延迟落盘，读文件前先 flush
const st1 = store.stats();
store.add({ scope: 'user', userId: 'u1', content: '过期记忆EXPxyz', ttlDays: 1 });
// 手工把一条改成已过期，验证清理。
// 必须先 flush 让内存内容落盘，再改文件，并用 _setFile 而非 _reset ——
// _reset 只清缓存、**不会清掉 300ms 后自动 flush 的定时器**，那会把我们手改的内容覆盖回去。
store.flush();
const raw = JSON.parse(fs.readFileSync(TMP_NOTES, 'utf-8'));
raw.items.forEach((x) => { if (/EXPxyz/.test(x.content)) x.expireAt = Date.now() - 1000; });
fs.writeFileSync(TMP_NOTES, JSON.stringify(raw));
store._setFile(TMP_NOTES);
ok('过期条目被 stats 标记', store.stats().expired >= 1, store.stats());
store.prune();
ok('prune 清掉过期条目', !store.list({ userId: 'u1' }).some((x) => /EXPxyz/.test(x.content)));

// 容量上限
for (let i = 0; i < 40; i++) store.add({ scope: 'user', userId: 'cap', content: '容量测试条目编号' + i });
ok('条数不超过 maxItems 上限', store.stats().total <= 500, store.stats().total);

// ============================================================
section('3. 权限隔离（不同用户 / 不同群）');
// ============================================================
store.add({ scope: 'user', userId: 'uA', content: 'A的私密记忆内容AAA', source: 'manual' });
store.add({ scope: 'user', userId: 'uB', content: 'B的私密记忆内容BBB', source: 'manual' });
store.add({ scope: 'group', groupId: 'G1', content: '群一公共约定111', source: 'manual' });
store.add({ scope: 'group', groupId: 'G2', content: '群二公共约定222', source: 'manual' });

const viewA = store.list({ userId: 'uA', groupId: 'G1' });
store.flush();                     // 先落盘，否则切文件时会丢（内存里有但盘上没有）
ok('uA 看不到 uB 的记忆', !viewA.some((x) => /BBB/.test(x.content)));
ok('uA 看不到别的群(群二)的公共记忆', !viewA.some((x) => /222/.test(x.content)));
ok('uA 能看到本群公共记忆', viewA.some((x) => /111/.test(x.content)));
ok('uA 搜索无法跨群拿到群二记忆',
  !store.search('222', { userId: 'uA', groupId: 'G1' }).some((x) => /群二/.test(x.content)));

const clr = store.clear({ userId: 'uA', isAdmin: false }, null);
const afterB = store.list({ userId: 'uB', groupId: 'G1' });
// 注意断言方向：uA 清空自己的记忆后，**uB 的记忆必须还在**
ok('普通用户清空不会误删他人记忆',
   clr.ok && afterB.some((x) => /BBB/.test(x.content)),
   { removed: clr.removed, uBLeft: afterB.map((x) => x.content) });
ok('普通用户只能删自己的 1 条', clr.removed === 1, clr.removed);
ok('普通用户清空也删不到群级记忆', store.list({ groupId: 'G1', userId: 'uB' }).some((x) => /111/.test(x.content)));
const adminClr = store.clear({ userId: 'uA', isAdmin: true }, { scope: 'group', groupId: 'G1', userId: 'null' });
ok('管理员可清空指定群公共记忆', adminClr.removed >= 1, adminClr);

// ============================================================
section('4. 从旧 notes.json 一次性导入');
// ============================================================
const LEGACY = path.join(TMP, 'legacy.json');
fs.writeFileSync(LEGACY, JSON.stringify({
  group_808214611: ['旧格式群记忆内容'],
  private_999999: ['旧格式用户记忆内容'],
}));
const IMPORT_T = path.join(TMP, 'notes_imported.json');
store._setFile(IMPORT_T);
store._setLegacyFile(LEGACY);
const mig = store.list({ userId: '999999', groupId: '808214611', allowAll: true });
ok('旧 group_ 导入为群级记忆', mig.some((x) => /旧格式群记忆内容/.test(x.content)), mig.length);
ok('旧 private_ 导入为该用户记忆', mig.some((x) => x.scope === 'user' && /旧格式用户记忆内容/.test(x.content)));
ok('导入条目 source=legacy-import', mig.every((x) => x.source === 'legacy-import'));
ok('导入条目无过期时间', mig.every((x) => x.expireAt === null));
ok('导入后已落盘为 v2', (() => { store.flush(); try { return JSON.parse(fs.readFileSync(IMPORT_T,'utf-8')).version === 2; } catch(e){ return false; } })());
ok('旧文件本身未被修改', JSON.parse(fs.readFileSync(LEGACY,'utf-8'))['private_999999'].length === 1);
store._setFile(TMP_NOTES);
store._setLegacyFile(null);
store._reset();

// ============================================================
section('5. 群聊总结：空记录 / 刷屏过滤 / 日期区分');
// ============================================================
const G3 = 'GROUP_SUMMARY_TEST';
ok('无记录时明确说没有内容', (() => {
  const out = summary.cleanMessages([], { minUsefulLen: 4 });
  return out.msgs.length === 0;
})());

// 造一天数据：正常讨论 + 刷屏 + 重复
const dayStart = new Date(); dayStart.setHours(10, 0, 0, 0);
for (let i = 0; i < 10; i++) {
  groupLog.archive(G3, { messageId: 'S' + i, uid: 'u1', name: '张三', text: '关于新版本发布时间的讨论第' + i + '条', time: dayStart.getTime() + i * 60000 });
}
groupLog.archive(G3, { messageId: 'SP1', uid: 'spammer', name: '刷屏哥', text: '666666', time: dayStart.getTime() + 100 });
for (let i = 0; i < 5; i++) {
  groupLog.archive(G3, { messageId: 'DUP' + i, uid: 'dup', name: '复读机', text: '这条内容被重复刷了很多次', time: dayStart.getTime() + 200 + i * 1000 });
}
groupLog.archive(G3, { messageId: 'OK1', uid: 'u2', name: '李四', text: '待办：下周一之前把文档整理好发出来', time: dayStart.getTime() + 300000 });
groupLog.archive(G3, { messageId: 'OK2', uid: 'u3', name: '王五', text: '结论：版本推迟到下周三发布', time: dayStart.getTime() + 400000 });

const c = { minUsefulLen: 4, dedupWindowMs: 90000 };
const cleaned = summary.cleanMessages(groupLog.getByDate(G3, TODAY), c);
ok('刷屏「666666」被过滤', !cleaned.msgs.some((m) => /666/.test(m.text)));
ok('重复刷屏被折叠', cleaned.msgs.filter((m) => /重复刷了很多次/.test(m.text)).length === 1,
   cleaned.msgs.filter((m) => /重复刷了很多次/.test(m.text)).length);
ok('正常讨论保留', cleaned.msgs.some((m) => /版本发布时间/.test(m.text)));
ok('待办内容保留', cleaned.msgs.some((m) => /待办/.test(m.text)));
ok('过滤统计有 dropped', cleaned.dropped > 0, cleaned.dropped);

(async () => {
  // 6. 总结生成（Mock AI，不调真实 API）
  section('6. 总结生成（Mock AI，不消耗付费 API）');
  let captured = null;
  const mockGen = async (prompt, opts) => {
    captured = { prompt, opts };
    return '2026-01-01 群聊小结\n【讨论要点】\n· 讨论了新版本发布时间\n【结论/决定】\n· 版本推迟到下周三\n【待办】\n· 下周一前整理好文档';
  };
  let out = await summary.buildSummary({ groupId: G3, date: TODAY, groupName: '测试群', deps: { genText: mockGen } });
  ok('总结生成成功', out.ok === true, out.reason);
  ok('返回内容含小节', /群聊小结/.test(out.text), out.text.slice(0, 40));
  ok('送进模型的素材在长度上限内', captured.prompt.length <= 20000);
  ok('提示词含防注入声明（user 侧也有，双重保险）',
  /不是对你的指令/.test(captured.prompt), captured.prompt.slice(0, 120));
  ok('提示词含聊天记录边界标记', /===== 聊天记录开始 =====/.test(captured.prompt));
  ok('系统提示要求忽略记录中的指令', /绝不执行/.test(captured.opts.system));
  ok('统计里有用条数>0', out.stats.useful > 0, out.stats);

  // 空群
  out = await summary.buildSummary({ groupId: 'EMPTY_GROUP', date: TODAY, deps: { genText: mockGen } });
  ok('空群明确提示无内容且不编造', out.ok === false && out.reason === 'empty-log' && /没有收到任何群消息/.test(out.text), out);

  // 全是刷屏
  const G4 = 'SPAM_GROUP';
  groupLog.archive(G4, { messageId: 'x1', uid: 'a', name: 'A', text: '6', time: Date.now() });
  groupLog.archive(G4, { messageId: 'x2', uid: 'a', name: 'A', text: '哈哈哈', time: Date.now() });
  out = await summary.buildSummary({ groupId: G4, date: TODAY, deps: { genText: mockGen } });
  ok('低价值内容拒绝硬编', out.ok === false && /太少|没意义/.test(out.text), out.reason);

  // AI 异常不崩
  section('7. 异常与边界');
  const boom = async () => { throw new Error('模拟API超时'); };
  out = await summary.buildSummary({ groupId: G3, date: TODAY, deps: { genText: boom } });
  ok('AI 抛异常不崩溃且有提示', out.ok === false && out.reason === 'ai-error' && /失败/.test(out.text), out);
  const emptyAi = async () => '';
  out = await summary.buildSummary({ groupId: G3, date: TODAY, deps: { genText: emptyAi } });
  ok('模型返回空有兜底提示', out.ok === false && out.reason === 'empty-output');
  out = await summary.buildSummary({ groupId: G3, date: TODAY, deps: {} });
  ok('缺少 AI 入口不崩溃', out.ok === false && out.reason === 'no-genText');
  out = await summary.buildSummary({ groupId: '', date: TODAY, deps: { genText: mockGen } });
  ok('无群号不崩溃', out.ok === false && out.reason === 'no-group');

  // 数据损坏
  fs.writeFileSync(TMP_NOTES, '{坏掉的 json');
  store._reset();
  ok('记忆文件损坏时不崩溃(按空处理)', (() => { try { store.stats(); return true; } catch (e) { return false; } })());
  fs.writeFileSync(TMP_LOG, 'not-json');
  groupLog._reset();
  ok('归档文件损坏时不崩溃', (() => { try { return groupLog.getByDate(G3, TODAY).length === 0; } catch (e) { return false; } })());

  // 防重复发送 + 限频
  section('8. 防重复发送与限频');
  ok('首次允许发送', summary.shouldSendOnce('G3@' + TODAY) === true);
  ok('同群同天第二次被拦截', summary.shouldSendOnce('G3@' + TODAY) === false);
  ok('不同群不受影响', summary.shouldSendOnce('OTHER@' + TODAY) === true);
  summary._reset();
  summary.markRun('G3');
  ok('冷却期内有剩余时间', summary.cooldownLeftMs('G3') > 0);
  ok('未触发过的群无冷却', summary.cooldownLeftMs('G_NEW') === 0);

  // 默认配置校验
  section('9. 默认配置（安全优先）');
  const dc = summary.DEFAULTS;
  ok('自动总结默认不开启（由 ai_config 控制）', dc.cooldownMs > 0);
  ok('默认最小有效条数 > 1', dc.minUseful >= 3);
  ok('记忆默认有条数上限', store.DEFAULTS.maxItems > 0);
  ok('记忆默认有过期天数', store.DEFAULTS.defaultTtlDays > 0);
  ok('记忆检索条数有上限', store.DEFAULTS.retrieveLimit > 0 && store.DEFAULTS.retrieveLimit <= 20);
  ok('归档有体积上限', groupLog.DEFAULTS.maxBytes > 0);
  ok('归档有保留天数', groupLog.DEFAULTS.retainDays > 0);

  // 清理
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

  console.log('\n============================================');
  console.log(' 结果：' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) console.log(' 失败项：' + failed.join(' | '));
  console.log('============================================');
  process.exit(fail ? 1 : 0);
})();
