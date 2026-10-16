'use strict';

/**
 * 画像容量治理专项回归测试（V15.2 第二阶段修复）
 *
 * 针对 memory/group_profile.js 中两个真实缺陷的反回归：
 *   缺陷一：writeProfile() 在判断「能否合并」之前就调用 enforcePerUser()，
 *           导致「重复陈述同一件事」也会先腾位删掉一条（往往是另一条画像），
 *           更新变成「新增一条 + 误删一条」。
 *   缺陷二：maxTotalBytes 只在「当前数据已经超限」时才治理，
 *           不考虑本次写入后的预计总量 → 写入后仍可能超预算，且失败时会被当成成功。
 *
 * 全部离线：不联网、不连真实 QQ、不读真实记忆文件（临时目录）、不发真实消息。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const groupProfile = require(path.join(ROOT, 'memory/group_profile'));
const memoryStore = require(path.join(ROOT, 'memory/memory_store'));

let pass = 0, fail = 0;
function ok(c, msg) { if (c) { pass++; } else { fail++; console.log('  ✗ ' + msg); } }
function eq(got, want, msg) { ok(got === want, msg + '（实际=' + JSON.stringify(got) + ' 期望=' + JSON.stringify(want) + '）'); }
function group(n) { console.log('\n[' + n + ']'); }

// —— 临时记忆库（每次全新，绝不碰真实 notes_v2.json）——
let TMP = null;
function freshStore() {
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} }
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v157-'));
  memoryStore._setFile(path.join(TMP, 'notes_v2.json'));
  memoryStore._setLegacyFile(null);
  memoryStore._reset();
}
const withCfg = (c, fn) => {
  groupProfile.setConfig(() => c);
  try { return fn(); } finally { groupProfile.setConfig(() => ({})); }
};

// —— 生成「彼此不相似」的画像文本 ——
// 每条 16 字 → byteLen = 16 + 120 = 136（容量用例按此计算预算）。
// 前缀 'k' 保证不会被误判成手机号/身份证等敏感编号。
function mk(i) {
  return 'k' + crypto.createHash('md5').update('v157-seed-' + i).digest('hex').slice(0, 11) + '画像条目';
}
// 容量计量：优先用模块导出的实现；若导出缺失（修复前的版本）则用同一公式的本地实现，
// 这样本文件在修复前后都能跑完，便于做反向验证（旧实现应当在这里失败）。
const byteLen = (it) => (typeof groupProfile.byteLen === 'function'
  ? groupProfile.byteLen(it)
  : String((it && it.content) || '').length + 120);
const bytesNow = () => (typeof groupProfile.currentBytes === 'function'
  ? groupProfile.currentBytes()
  : groupProfile.allProfiles().reduce((n, x) => n + String(x.content || '').length + 120, 0));
const profileCount = () => groupProfile.allProfiles().length;

const CFG_CAP = { groupProfile: { enabled: true, minIntervalMs: 0, maxLen: 60, maxPerUser: 100, minSamples: 3, ttlDays: 90, maxTotalBytes: 4096 } };
const CFG_CAP2 = { groupProfile: { enabled: true, minIntervalMs: 0, maxLen: 60, maxPerUser: 2, minSamples: 3, ttlDays: 90, maxTotalBytes: 262144 } };

// ==================================================================
// 0. 先校验测试夹具本身：所有文本彼此不相似，否则"新增"会被当成"合并"，断言就失去意义
// ==================================================================
group('0. 夹具自检');
{
  let maxSim = 0;
  for (let i = 0; i < 40; i++) {
    for (let j = i + 1; j < 40; j++) maxSim = Math.max(maxSim, memoryStore.similarity(mk(i), mk(j)));
  }
  ok(maxSim < 0.8, '0. 40 条文本两两相似度必须 < 0.8（实际最大 ' + maxSim.toFixed(3) + '），否则无法区分新增/合并');
  eq(mk(7), mk(7), '0. 同一编号文本稳定一致（可复现）');
  eq(mk(7).length, 16, '0. 单条文本长度固定，便于计算预算');
}

// ==================================================================
// 1. 满员时「更新」不误删其它条目（缺陷一）
// ==================================================================
group('1. 满员更新不误删其它条目');
freshStore();
withCfg(CFG_CAP2, () => {
  const c = groupProfile.cfg();
  eq(c.maxPerUser, 2, '1. 夹具：单人上限为 2');
  groupProfile.writeProfile('g1', 'u1', mk(0), 'stated', 0.8, '偏好', c);
  groupProfile.writeProfile('g1', 'u1', mk(1), 'stated', 0.8, '偏好', c);
  groupProfile.writeProfile('g1', 'u1', mk(2), 'stated', 0.8, '偏好', c);
  const before = groupProfile.listRaw('g1', 'u1');
  eq(before.length, 2, '1. 满员后仍保持 2 条（新增时腾位生效）');

  // 取当前较旧的一条，重复陈述它的内容 → 必须走「更新」，不能腾位、不能换 id
  const target = before[1];
  const other = before[0];
  const r = groupProfile.writeProfile('g1', 'u1', target.content, 'stated', 0.8, '偏好', c);
  eq(r.ok, true, '1. 重复陈述同一条画像 → 写入成功');
  eq(r.merged, true, '1. 识别为合并更新（不是新增）');

  const after = groupProfile.listRaw('g1', 'u1');
  eq(after.length, 2, '1. 更新不新增条目（总数仍为 2）');
  ok(after.some((x) => x.id === target.id), '1. 被更新的条目 id 未变（没有被"删掉再新建"）');
  ok(after.some((x) => x.id === other.id), '1. 同群本人的另一条画像未被误删');
  const t2 = after.find((x) => x.id === target.id) || null;
  const o2 = after.find((x) => x.id === other.id) || null;
  ok(!!t2, '1. 被更新的条目仍在库中（按 id 可找到）');
  ok(!!o2, '1. 另一条画像仍在库中（按 id 可找到）');
  if (t2) {
    eq(t2.content, target.content, '1. 被更新条目内容保持原样');
    ok((t2.hits || 0) === (target.hits || 0) + 1, '1. 合并后命中次数 +1（实际 ' + t2.hits + '）');
    ok((t2.updatedAt || 0) >= (target.updatedAt || 0), '1. 更新时间被刷新');
  }
  if (o2) eq(o2.content, other.content, '1. 另一条画像内容保持原样');
});

// ==================================================================
// 2. upsertRaw 按 id 替换：更新不增加条目总数（缺陷一的存储层基础）
// ==================================================================
group('2. upsertRaw 按 id 替换 / 更新不增加总数');
freshStore();
{
  // 2.1 存储层：同一 id 写两次 → 仍然只有一条，内容为后写的值
  const base = {
    id: 'p_fixed_1', scope: 'user', groupId: 'g1', userId: 'u1',
    source: 'profile:stated:偏好', confidence: 0.8, hits: 0,
    createdAt: Date.now(), updatedAt: Date.now(), expireAt: Date.now() + 86400000,
  };
  memoryStore.upsertRaw(Object.assign({}, base, { content: '第一版画像内容' }));
  memoryStore.upsertRaw(Object.assign({}, base, { content: '第二版画像内容', hits: 3 }));
  const all = memoryStore.list({ groupId: null, userId: null, allowAll: true }, 5000)
    .filter((x) => x.id === 'p_fixed_1');
  eq(all.length, 1, '2.1 同一 id 写入两次后仍只有一条（不是追加成两份）');
  eq(all[0] && all[0].content, '第二版画像内容', '2.1 后写的值覆盖先写的值');

  // 2.2 画像层：同一内容写三次 → 全库画像始终 1 条，hits 递增
  freshStore();
  withCfg(CFG_CAP2, () => {
    const c = groupProfile.cfg();
    const r1 = groupProfile.writeProfile('g1', 'u2', mk(10), 'stated', 0.8, '偏好', c);
    const r2 = groupProfile.writeProfile('g1', 'u2', mk(10), 'stated', 0.8, '偏好', c);
    const r3 = groupProfile.writeProfile('g1', 'u2', mk(10), 'stated', 0.8, '偏好', c);
    eq(r1.merged, false, '2.2 首次写入是新增');
    eq(r2.merged, true, '2.2 第二次是合并更新');
    eq(r3.merged, true, '2.2 第三次仍是合并更新');
    eq(profileCount(), 1, '2.2 三次写入后全库仍只有 1 条画像');
  const it = (groupProfile.listRaw('g1', 'u2') || [])[0];
  ok(!!it, '2.2 画像确实存在（避免空转断言）');
  if (it) eq(it.hits, 2, '2.2 命中次数累计为 2（实际 ' + it.hits + '）');
  });
}

// ==================================================================
// 3. 容量「尚未超限、但新增后会超限」时，写入结果仍符合容量规则（缺陷二）
// ==================================================================
group('3. 预计总量治理：未超限但新增后会超限');
freshStore();
withCfg(CFG_CAP, () => {
  const c = groupProfile.cfg();
  const MAX = c.maxTotalBytes;
  eq(MAX, 4096, '3. 夹具：总字节上限 4096');
  const unit = byteLen({ content: mk(0) });
  eq(unit, 136, '3. 夹具：单条占用 136 字节');

  // 3.1 先写到"刚好还没超限"：30 条 = 4080 ≤ 4096
  let allOk = true;
  for (let i = 0; i < 30; i++) {
    const r = groupProfile.writeProfile('g1', 'uA', mk(i), 'stated', 0.8, '偏好', c);
    if (!r.ok) allOk = false;
    ok(bytesNow() <= MAX, '3.1 写入第 ' + (i + 1) + ' 条后总量未超限（实际 ' + bytesNow() + '）');
  }
  eq(allOk, true, '3.1 未超预算时全部写入成功');
  eq(bytesNow(), 4080, '3.1 当前 4080 字节，尚未超限（4080 ≤ 4096）');
  eq(profileCount(), 30, '3.1 共 30 条');

  // 3.2 再写一条：当前没超，但 4080 + 136 = 4216 > 4096 —— 必须按预计总量治理后写入
  const r = groupProfile.writeProfile('g1', 'uA', mk(30), 'stated', 0.8, '偏好', c);
  ok(bytesNow() <= MAX, '3.2 新增后总量仍不超限（实际 ' + bytesNow() + ' ≤ ' + MAX + '）');
  if (r.ok) {
    ok(groupProfile.listRaw('g1', 'uA').some((x) => x.content === mk(30)),
      '3.2 返回成功时，新条目确实在库里（不允许"报成功却没写"）');
  } else {
    eq(r.error, 'over-budget', '3.2 拒绝写入时必须给出 over-budget，而不是其它错误');
  }
  ok(profileCount() <= 30, '3.2 总量治理确实淘汰了旧条目（条数未无限增长，实际 ' + profileCount() + '）');

  // 3.3 连续写入过程中，"返回成功"与"未超限"必须始终同时成立
  let violation = 0;
  for (let i = 100; i < 140; i++) {
    const rr = groupProfile.writeProfile('g1', 'uA', mk(i), 'stated', 0.8, '偏好', c);
    if (rr.ok && bytesNow() > MAX) violation++;
  }
  eq(violation, 0, '3.3 任何一次"成功"都不会留下超限状态（误报成功次数 ' + violation + '）');
  ok(bytesNow() <= MAX, '3.3 连续写入 40 条后总量仍在上限内（实际 ' + bytesNow() + '）');
});

// ==================================================================
// 4. 容量已满时「更新旧条目」：被更新条目受保护，不因容量治理被删掉
// ==================================================================
group('4. 容量治理不淘汰正在被更新的条目');
freshStore();
withCfg(CFG_CAP, () => {
  const c = groupProfile.cfg();
  for (let i = 0; i < 30; i++) groupProfile.writeProfile('g1', 'uB', mk(i), 'stated', 0.8, '偏好', c);
  eq(bytesNow(), 4080, '4. 夹具：已用 4080 字节（接近上限 4096）');

  const target = groupProfile.listRaw('g1', 'uB').find((x) => x.content === mk(5));
  ok(!!target, '4. 夹具：目标条目存在（避免空转断言）');
  const r = groupProfile.writeProfile('g1', 'uB', mk(5), 'stated', 0.8, '偏好', c);
  eq(r.ok, true, '4. 容量紧张时更新既有条目仍成功');
  eq(r.merged, true, '4. 走的是合并更新');
  eq(profileCount(), 30, '4. 更新后条数不变（被更新条目未被自己触发的治理删掉）');
  const after = groupProfile.listRaw('g1', 'uB').find((x) => x.id === target.id) || null;
  ok(!!after, '4. 被更新的条目仍在库中');
  if (after) ok((after.hits || 0) === (target.hits || 0) + 1, '4. 命中次数 +1');
  ok(bytesNow() <= c.maxTotalBytes, '4. 总量仍在上限内（实际 ' + bytesNow() + '）');
});

// ==================================================================
// 5. 单条就超过总预算 → 拒绝写入，且不破坏既有数据
// ==================================================================
group('5. 单条超限 → 明确拒绝');
freshStore();
withCfg({ groupProfile: { enabled: true, minIntervalMs: 0, maxLen: 6000, maxPerUser: 100, minSamples: 3, ttlDays: 90, maxTotalBytes: 4096 } }, () => {
  const c = groupProfile.cfg();
  groupProfile.writeProfile('g1', 'uC', mk(0), 'stated', 0.8, '偏好', c);
  eq(profileCount(), 1, '5. 夹具：先有 1 条');
  const big = 'x'.repeat(5000);
  const need = byteLen({ content: big });
  ok(need > c.maxTotalBytes, '5. 夹具：单条 5120 字节 > 上限 4096');
  const r = groupProfile.writeProfile('g1', 'uC', big, 'stated', 0.8, '偏好', c);
  eq(r.ok, false, '5. 单条超预算时拒绝写入（不能误报成功）');
  eq(r.error, 'over-budget', '5. 错误码为 over-budget');
  eq(r.reason, 'single-item', '5. 原因标明 single-item（淘汰解决不了）');
  const left = groupProfile.listRaw('g1', 'uC') || [];
  ok(left.length === 1, '5. 既有条目未被破坏');
  if (left[0]) eq(left[0].content, mk(0), '5. 既有条目内容不变');
});

// ==================================================================
// 6. 淘汰失败 → 拒绝写入，不留下超限状态（模拟 remove 全部失败）
// ==================================================================
group('6. 淘汰失败 → 不误报成功');
freshStore();
withCfg(CFG_CAP, () => {
  const c = groupProfile.cfg();
  for (let i = 0; i < 30; i++) groupProfile.writeProfile('g1', 'uD', mk(i), 'stated', 0.8, '偏好', c);
  const beforeBytes = bytesNow();
  const beforeCount = profileCount();
  eq(beforeBytes, 4080, '6. 夹具：已用 4080 字节');

  const origRemove = memoryStore.remove;
  memoryStore.remove = () => ({ ok: false, error: 'forbidden' });   // 模拟删除被拒绝
  let r = null;
  try {
    r = groupProfile.writeProfile('g1', 'uD', mk(30), 'stated', 0.8, '偏好', c);
  } finally {
    memoryStore.remove = origRemove;
  }
  eq(r.ok, false, '6. 腾不出空间时拒绝写入（不误报成功）');
  eq(r.error, 'over-budget', '6. 错误码为 over-budget');
  eq(r.reason, 'evict-failed', '6. 原因标明 evict-failed（实际 ' + r.reason + '）');
  eq(bytesNow(), beforeBytes, '6. 淘汰失败后数据量未被改动');
  eq(profileCount(), beforeCount, '6. 淘汰失败后条数不变');
  ok(!groupProfile.listRaw('g1', 'uD').some((x) => x.content === mk(30)), '6. 新条目确实没有被写入');
});

// ==================================================================
// 7. 写入失败 → 如实返回失败
// ==================================================================
group('7. 写入失败 → 如实返回失败');
freshStore();
withCfg(CFG_CAP, () => {
  const c = groupProfile.cfg();
  const origUpsert = memoryStore.upsertRaw;
  memoryStore.upsertRaw = () => ({ ok: false, error: 'write-failed' });
  let r = null;
  try {
    r = groupProfile.writeProfile('g1', 'uE', mk(0), 'stated', 0.8, '偏好', c);
  } finally {
    memoryStore.upsertRaw = origUpsert;
  }
  eq(r.ok, false, '7. 存储写入失败时返回失败');
  eq(r.error, 'write-failed', '7. 错误码如实透传');
  eq(profileCount(), 0, '7. 失败时不留下半成品条目');
});

// ==================================================================
// 8. 容量治理只淘汰画像，绝不删普通长期记忆
// ==================================================================
group('8. 容量治理不碰普通长期记忆');
freshStore();
withCfg(CFG_CAP, () => {
  const c = groupProfile.cfg();
  const note = memoryStore.add({
    scope: 'user', groupId: 'g1', userId: 'uN',
    content: '普通长期记忆：项目验收材料下周五前必须提交完毕',
    source: 'note', confidence: 0.8, ttlDays: 180,
  });
  eq(note.ok, true, '8. 夹具：普通长期记忆写入成功');

  for (let i = 0; i < 40; i++) groupProfile.writeProfile('g1', 'uP', mk(i), 'stated', 0.8, '偏好', c);

  const notes = memoryStore.list({ groupId: null, userId: null, allowAll: true }, 5000)
    .filter((x) => String(x.source || '') === 'note');
  eq(notes.length >= 1, true, '8. 大量画像淘汰后，普通长期记忆仍然存在');
  ok(bytesNow() <= c.maxTotalBytes, '8. 画像总量受上限约束（实际 ' + bytesNow() + '）');
  const all = memoryStore.list({ groupId: null, userId: null, allowAll: true }, 5000);
  ok(all.some((x) => x.id === note.item.id), '8. 被保护的普通记忆 id 未变');
  ok(groupProfile.allProfiles().every((x) => String(x.source || '').indexOf('profile:') === 0),
    '8. 画像集合里没有混入普通记忆');
});

// ==================================================================
// 9. 治理函数本身的契约（返回结构 + 不越权淘汰）
// ==================================================================
group('9. enforceTotalBytes 契约');
freshStore();
withCfg(CFG_CAP, () => {
  const c = groupProfile.cfg();
  // 契约：返回结构化结果（ok/removed/reason），调用方据此拒绝写入
  ok(typeof groupProfile.enforceTotalBytes === 'function', '9. enforceTotalBytes 已导出');
  ok(typeof groupProfile.byteLen === 'function', '9. byteLen 已导出（容量计量口径统一）');
  ok(typeof groupProfile.currentBytes === 'function', '9. currentBytes 已导出（容量计量口径统一）');

  for (let i = 0; i < 5; i++) groupProfile.writeProfile('g1', 'uF', mk(i), 'stated', 0.8, '偏好', c);
  const ev = groupProfile.enforceTotalBytes(c, { reserveBytes: 0 });
  ok(typeof ev === 'object' && ev !== null, '9. 治理结果必须是结构化对象（不能只是个数字）');
  eq(ev.ok, true, '9. 未超限时治理成功');
  eq(ev.removed, 0, '9. 未超限时一条都不淘汰');

  const ev2 = groupProfile.enforceTotalBytes(c, { reserveBytes: c.maxTotalBytes + 1 });
  eq(ev2.ok, false, '9. 预留超过总预算 → 直接判失败');
  eq(ev2.reason, 'single-item', '9. 失败原因 single-item');

  // 预留后预算变小 → 会淘汰到"放得下"为止
  const before = profileCount();
  const ev3 = groupProfile.enforceTotalBytes(c, { reserveBytes: c.maxTotalBytes - 100 });
  eq(ev3.ok, true, '9. 预留后仍能腾出空间（实际淘汰 ' + ev3.removed + ' 条）');
  ok(profileCount() < before, '9. 确实淘汰了条目（避免空转断言）');
  ok(bytesNow() + (c.maxTotalBytes - 100) <= c.maxTotalBytes, '9. 淘汰后剩余空间足够容纳预留量');
});

if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} }
console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
process.exit(fail ? 1 : 0);
