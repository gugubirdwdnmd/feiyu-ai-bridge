'use strict';
// ================= V15.2 离线测试：群聊智能决策 + 群友轻量画像 =================
// 类别：全部 A 级（纯本地规则 + 临时目录），**不联网、不连真实 QQ、不调付费 API、
//       不触碰真实用户数据、不向日志打印完整聊天记录或画像内容**。
// 覆盖需求列出的 10 项：
//   1 明确提问能触发回复        2 普通闲聊不无条件触发
//   3 已回答的问题不重复回复    4 不同成员画像隔离
//   5 不同群的画像隔离          6 明确偏好可更新且不无限累积
//   7 敏感信息不被推断/记录     8 画像损坏/缺失/写入失败不影响原有记忆与聊天
//   9 关闭新配置时行为兼容     10 注入与存储均遵守上限

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v152-test-'));
process.env.FEIYU_DATA_DIR = TMP;
const _cleanupTmp = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} };
process.on('exit', _cleanupTmp);

const memoryStore = require('../memory/memory_store');
const groupProfile = require('../memory/group_profile');
const groupDecision = require('../agent/group_decision');
const intent = require('../agent/intent');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name) { if (cond) pass++; else { fail++; fails.push(name); console.log('  ✗ ' + name); } }
function eq(a, b, name) { ok(a === b, name + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function group(t) { console.log('\n[' + t + ']'); }

// 每个子测试用独立文件，互不污染
let seq = 0;
function freshStore() {
  const f = path.join(TMP, 'notes_' + (++seq) + '.json');
  memoryStore._setFile(f);
  memoryStore._setLegacyFile(null);   // 绝不读真实 notes.json
  memoryStore._reset();
  return f;
}
function withCfg(cfgObj, fn) {
  groupProfile.setConfig(() => cfgObj);
  try { return fn(); } finally { groupProfile.setConfig(null); groupProfile._resetSamples(); }
}
const ON = { groupProfile: { enabled: true, minIntervalMs: 0, maxPerUser: 5, maxLen: 60, injectLimit: 3, injectChars: 200, minSamples: 3 } };
const OFF = { groupProfile: { enabled: false } };

(async function main() {

  // ============================================================
  group('1. 群聊智能决策：明确提问触发 / 普通闲聊不触发 / 不重复回答');
  // ============================================================
  {
    const on = { enabled: true };

    // ① 明确提问 → 保留响应优先级（不被降级）
    eq(groupDecision.review({
      text: '请问怎么配置 groupDecision？', buffer: [],
      decision: { reply: false, needsJudge: true, reason: 'name-mention' }, isGroup: true, cfg: on,
    }).action, 'keep', '明确提问：保留响应优先级（keep）');
    ok(groupDecision.review({
      text: '请问怎么配置 groupDecision？', buffer: [],
      decision: { reply: false, needsJudge: true, reason: 'name-mention' }, isGroup: true, cfg: on,
    }).reason === 'explicit-question', '明确提问：标记为 explicit-question');

    // ② 直接 @ 机器人 → 高优先级，永不被智能决策降级
    eq(groupDecision.review({
      text: '@小助手 帮我看下这个', buffer: [],
      decision: { reply: true, needsJudge: false, reason: 'at', bypassCooldown: true }, isGroup: true, cfg: on,
    }).action, 'keep', '直接 @ 机器人：高优先级不被降级');
    eq(groupDecision.review({
      text: '随便说点什么', buffer: [],
      decision: { reply: true, needsJudge: false, reason: 'reply-to-bot' }, isGroup: true, cfg: on,
    }).action, 'keep', '回复机器人消息：高优先级不被降级');

    // ③ 明确要求继续 → 保留优先级
    eq(groupDecision.review({
      text: '继续', buffer: [], decision: { reply: false, needsJudge: true, reason: 'topic-followup' }, isGroup: true, cfg: on,
    }).action, 'keep', '明确要求继续：不被延后');

    // ④ 普通闲聊 → 不插话：本模块**只做降级/延后建议，绝不主动把 normal-chat
    //    提升为"要回复"**。对一条独立完整的闲聊句，既不改判也不插话。
    const casual = groupDecision.review({
      text: '今天天气真不错啊', buffer: [], decision: { reply: false, needsJudge: false, reason: 'normal-chat' }, isGroup: true, cfg: on,
    });
    eq(casual.action, 'keep', '普通闲聊（独立完整句）：不改判、不插话');
    eq(casual.changed, false, '普通闲聊：不改变既有判定结果');
    eq(casual.reason, 'fallthrough', '普通闲聊：交回既有判定（由 shouldReplyGroup 的 normal-chat 决定不回）');

    // ⑤ 已回答过 → 不重复回答
    const now = Date.now();
    const buffer = [
      { uid: 'u1', text: '请问怎么配置缓存', isBot: false, time: now - 5000 },
      { uid: 'bot', text: '请问怎么配置缓存？可以在配置文件里设置 maxItems 上限', isBot: true, time: now - 4000 },
    ];
    const dup = groupDecision.review({
      text: '请问怎么配置缓存？', buffer,
      decision: { reply: false, needsJudge: true, reason: 'name-mention' }, isGroup: true, cfg: on,
    });
    eq(dup.action, 'drop', '已回答过的相同问题：不重复回答（drop）');
    eq(dup.reason, 'already-answered', '重复回答判定理由为 already-answered');
    ok(dup.detail && dup.detail.answeredAt > 0, '重复判定带有 answeredAt 依据');

    // ⑥ 时间窗外的旧回答不算"刚答过"
    const oldBuffer = [{ uid: 'bot', text: '请问怎么配置缓存', isBot: true, time: now - 60 * 60 * 1000 }];
    const notDup = groupDecision.review({
      text: '请问怎么配置缓存？', buffer: oldBuffer,
      decision: { reply: false, needsJudge: true, reason: 'name-mention' }, isGroup: true, cfg: on,
    });
    ok(notDup.action !== 'drop', '超出 dedupWindowMs 的旧回答不算重复');

    // ⑦ 高优先级即使内容重复也不被 drop（@ 优先于去重）
    const atDup = groupDecision.review({
      text: '请问怎么配置缓存', buffer,
      decision: { reply: true, needsJudge: false, reason: 'reply-to-bot' }, isGroup: true, cfg: on,
    });
    eq(atDup.action, 'keep', '即使话题重复，回复机器人的消息也不被去重丢弃');

    // ⑧ 未成句 → 建议等待聚合，而不是抢答
    eq(groupDecision.review({
      text: '那个我想问一下然后', buffer: [], decision: { reply: false, needsJudge: true, reason: 'topic-followup' }, isGroup: true, cfg: on,
    }).action, 'defer', '未成句：建议等待后续消息（defer）');
    eq(groupDecision.review({
      text: '嗯', buffer: [], decision: { reply: false, needsJudge: true, reason: 'topic-followup' }, isGroup: true, cfg: on,
    }).action, 'defer', '极短消息：建议等待（defer）');

    // ⑨ 零模型调用保证：本模块不引用任何网络/模型能力
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'group_decision.js'), 'utf-8');
    ok(!/require\(['"](https?|node-fetch|axios|ai_bridge)/.test(src), 'group_decision 不引入任何网络/模型依赖（0 额外模型调用）');
  }

  // ============================================================
  group('2. 复用既有机制：智能决策不破坏意图识别与私聊');
  // ============================================================
  {
    // 私聊完全不参与群聊智能决策
    eq(groupDecision.review({
      text: '那个我想问一下然后', buffer: [], decision: { reply: false, needsJudge: false, reason: 'x' }, isGroup: false, cfg: { enabled: true },
    }).action, 'keep', '私聊不受群聊智能决策影响');

    // 既有 intent 识别仍正常工作（未被本轮改动影响）
    const it1 = intent.detectIntent('帮我搜一下最近的新闻', {});
    ok(it1.suggestedTools.some((t) => t.tool === 'web_search'), '既有 web_search 意图识别未被破坏');
    const it2 = intent.detectIntent('画一张猫', {});
    ok(it2.suggestedTools.some((t) => t.tool === 'generate_image'), '既有生图意图识别未被破坏');
    const it3 = intent.detectIntent('你好', {});
    ok(it3.primary === 'chat', '既有闲聊意图识别未被破坏');
  }

  // ============================================================
  group('3. 画像：默认关闭 / 明确自述可记录 / 已回答与更新合并');
  // ============================================================
  {
    freshStore();
    // ① 默认关闭 → 不写任何画像
    withCfg(OFF, () => {
      const r = groupProfile.observe({ groupId: 'g1', userId: 'u1', text: '我叫小明，以后叫我小明就好' });
      eq(r.ok, false, '默认关闭：observe 被拒绝');
      eq(r.skipped, 'disabled', '默认关闭：理由为 disabled');
    });
    ok(groupProfile.listRaw('g1', 'u1').length === 0, '默认关闭：不产生任何画像条目');

    // ② 明确自述 → 记录，标为 stated（用户确实说过）
    withCfg(ON, () => {
      const r = groupProfile.observe({ groupId: 'g1', userId: 'u1', text: '我叫小明，以后叫我小明就好' });
      ok(r.ok, '启用后：observe 正常执行');
      const items = groupProfile.listRaw('g1', 'u1');
      ok(items.length >= 1, '明确自述：产生画像条目');
      ok(items.every((x) => String(x.source).indexOf('profile:stated') === 0), '明确自述：标记为 stated（事实）');
      ok(items.every((x) => x.confidence >= 0.75), '明确自述：置信度高（>=0.75）');
    });

    // ③ 相同/相近内容重复出现 → 合并更新，不无限累积
    withCfg(ON, () => {
      for (let i = 0; i < 5; i++) {
        groupProfile.observe({ groupId: 'g1', userId: 'u1', text: '我喜欢用 TypeScript 写东西' });
      }
      const items = groupProfile.listRaw('g1', 'u1');
      const tsLike = items.filter((x) => x.content.indexOf('TypeScript') >= 0);
      ok(tsLike.length <= 1, '重复的相同偏好被合并为 1 条（不无限累积），实际 ' + tsLike.length + ' 条');
    });

    // ④ 明确偏好可以更新（旧偏好被合并刷新，而不是不断新增）
    withCfg(ON, () => {
      groupProfile.observe({ groupId: 'g1', userId: 'u2', text: '我喜欢喝咖啡' });
      groupProfile.observe({ groupId: 'g1', userId: 'u2', text: '我喜欢喝咖啡' });
      const items = groupProfile.listRaw('g1', 'u2');
      const coffee = items.filter((x) => x.content.indexOf('咖啡') >= 0);
      ok(coffee.length <= 1, '同一偏好多次提及仍只有 1 条（合并而非累积）');
      // 首次写入 hits=0，第二次合并后 hits=1 —— 即"被提及 2 次"应体现为 hits>=1
      ok(coffee.length === 1 && (coffee[0].hits || 0) >= 1,
        '合并后 hits 递增（体现被重复提及），实际 hits=' + (coffee[0] && coffee[0].hits));
      // 反复提及也不应增长条目数
      for (let i = 0; i < 5; i++) groupProfile.observe({ groupId: 'g1', userId: 'u2', text: '我喜欢喝咖啡' });
      const after = groupProfile.listRaw('g1', 'u2').filter((x) => x.content.indexOf('咖啡') >= 0);
      eq(after.length, 1, '反复提及后条目数仍为 1（不无限累积）');
    });
  }

  // ============================================================
  group('4. 画像隔离：不同成员 / 不同群绝不混用');
  // ============================================================
  {
    freshStore();
    withCfg(ON, () => {
      groupProfile.observe({ groupId: 'gA', userId: 'u1', text: '我叫阿甲' });
      groupProfile.observe({ groupId: 'gA', userId: 'u2', text: '我叫阿乙' });
      groupProfile.observe({ groupId: 'gB', userId: 'u1', text: '我叫阿丙' });

      // ④ 不同成员隔离
      const u1 = groupProfile.listRaw('gA', 'u1').map((x) => x.content).join('|');
      const u2 = groupProfile.listRaw('gA', 'u2').map((x) => x.content).join('|');
      ok(u1.indexOf('阿甲') >= 0, '成员 u1 能看到自己的画像');
      ok(u1.indexOf('阿乙') < 0, '成员 u1 看不到 u2 的画像（成员隔离）');
      ok(u2.indexOf('阿乙') >= 0 && u2.indexOf('阿甲') < 0, '成员 u2 只看到自己的画像（成员隔离）');

      // ⑤ 不同群隔离（同一 QQ 号在不同群的画像不得混用）
      const inA = groupProfile.listRaw('gA', 'u1').map((x) => x.content).join('|');
      const inB = groupProfile.listRaw('gB', 'u1').map((x) => x.content).join('|');
      ok(inA.indexOf('阿丙') < 0, '群 gA 看不到同一个人在 gB 的画像（群隔离）');
      ok(inB.indexOf('阿丙') >= 0, '群 gB 能看到自己在 gB 的画像');
      ok(inB.indexOf('阿甲') < 0, '群 gB 看不到该成员在 gA 的画像（群隔离）');

      // 注入同样遵守隔离
      const injB = groupProfile.injectText({ groupId: 'gB', userId: 'u1', text: '' });
      ok(injB.indexOf('阿丙') >= 0 && injB.indexOf('阿甲') < 0, '注入内容遵守群隔离（不注入他群画像）');
    });

    // 缺少隔离键 → 拒绝处理（绝不做无来源的画像）
    freshStore();
    withCfg(ON, () => {
      eq(groupProfile.observe({ userId: 'u1', text: '我叫无群' }).skipped, 'no-isolation-key', '缺群号：拒绝记录');
      eq(groupProfile.observe({ groupId: 'g1', text: '我叫无用户' }).skipped, 'no-isolation-key', '缺用户号：拒绝记录');
    });
  }

  // ============================================================
  group('5. 敏感信息：不被推断、不被记录、推测低置信');
  // ============================================================
  {
    // ⑦ 敏感属性一律不入画像（即使成员自己说了）
    const sensitiveSamples = [
      '我今年35岁了', '我是男的', '我结婚三年了', '我有高血压',
      '我信佛', '我支持某个党', '我月薪三万', '我住在某某小区',
      '我的身份证号是110101199001011234',
    ];
    for (const s of sensitiveSamples) {
      eq(groupProfile.extract(s).stated.length, 0, '敏感属性不记录：' + s.slice(0, 12));
    }
    ok(groupProfile.looksSensitiveAttr('我今年35岁'), '敏感属性识别器命中年龄');
    ok(groupProfile.looksSensitiveAttr('我住在某某小区'), '敏感属性识别器命中住址');

    // 单条消息不足以给成员贴标签：推测类需多样本
    freshStore();
    withCfg(ON, () => {
      // 反复用网络用语，但只到 minSamples-1 次 → 不应产生画像
      for (let i = 0; i < ON.groupProfile.minSamples - 1; i++) {
        groupProfile.observe({ groupId: 'g1', userId: 'u1', text: '哈哈哈哈哈' });
      }
      eq(groupProfile.listRaw('g1', 'u1').length, 0, '推测类样本不足时不贴标签（不凭单条消息定性）');

      // 达到 minSamples → 允许记录，但置信度必须低且标为 inferred
      for (let i = 0; i < ON.groupProfile.minSamples; i++) {
        groupProfile.observe({ groupId: 'g1', userId: 'u1', text: '哈哈哈哈哈' });
      }
      const items = groupProfile.listRaw('g1', 'u1');
      ok(items.length >= 1, '推测类达到样本门槛后可记录');
      ok(items.every((x) => String(x.source).indexOf('profile:inferred') === 0), '推测类标记为 inferred');
      // 置信度必须远低于 stated（0.8），确保"推测"不会被当成事实。
      // 注意 memory_store 在合并相似条目时会小幅累加 confidence（每次 +0.05），
      // 所以这里断言"明显低于 stated 档"而非绝对值，避免过度约束既有记忆行为。
      ok(items.every((x) => x.confidence < 0.6), '推测类置信度明显低于事实类（不当事实用），实际 ' + items.map((x) => x.confidence).join(','));

      // 注入时必须显式标注「（推测）」
      const inj = groupProfile.injectText({ groupId: 'g1', userId: 'u1', text: '' });
      if (inj) ok(inj.indexOf('（推测）') >= 0, '注入内容把推测项标注为「（推测）」');
      if (inj) ok(inj.indexOf('不可当成事实') >= 0, '注入内容声明推测不可当成事实');
    });

    // 凭据类内容不入画像
    freshStore();
    withCfg(ON, () => {
      groupProfile.observe({ groupId: 'g1', userId: 'u1', text: '我的密码是 hunter2' });
      ok(!groupProfile.listRaw('g1', 'u1').some((x) => x.content.indexOf('hunter2') >= 0), '凭据类内容不入画像');
    });
  }

  // ============================================================
  group('6. 画像存储与注入上限 / 查看清除 / 不默认公开');
  // ============================================================
  {
    freshStore();
    const capped = { groupProfile: { enabled: true, minIntervalMs: 0, maxPerUser: 3, maxLen: 20, injectLimit: 2, injectChars: 60, minSamples: 3 } };
    withCfg(capped, () => {
      // 塞入大量不同偏好，验证单人上限
      const facts = [
        '我喜欢用 TypeScript', '我最近在做一个小程序', '我讨厌加班', '我习惯早起',
        '我在学 Rust', '我平时喜欢听爵士', '我不吃香菜', '我在写一个博客',
        '我常用 Linux', '我周末爱爬山',
      ];
      for (const f of facts) groupProfile.observe({ groupId: 'g1', userId: 'u1', text: f });
      const items = groupProfile.listRaw('g1', 'u1');
      ok(items.length <= capped.groupProfile.maxPerUser,
        '单人画像条目数不超过上限（实际 ' + items.length + ' <= ' + capped.groupProfile.maxPerUser + '）');
      ok(items.every((x) => x.content.length <= capped.groupProfile.maxLen), '单条画像长度不超过上限');

      // 注入遵守条数与字数双上限
      const inj = groupProfile.injectText({ groupId: 'g1', userId: 'u1', text: '' });
      const lines = inj ? inj.split('\n').filter((l) => l.indexOf('- ') === 0) : [];
      ok(lines.length <= capped.groupProfile.injectLimit,
        '注入条数不超过上限（实际 ' + lines.length + ' <= ' + capped.groupProfile.injectLimit + '）');
      const bodyLen = inj ? inj.split('\n').filter((l) => l.indexOf('- ') === 0).join('').length : 0;
      ok(bodyLen <= capped.groupProfile.injectChars + 40,
        '注入总字数不超过上限（实际 ' + bodyLen + '）');
    });

    // 更新频率限制：minIntervalMs 内不重复落盘
    freshStore();
    withCfg({ groupProfile: { enabled: true, minIntervalMs: 600000, maxPerUser: 20 } }, () => {
      groupProfile.observe({ groupId: 'g1', userId: 'u1', text: '我喜欢写代码' });
      const first = groupProfile.listRaw('g1', 'u1').length;
      groupProfile.observe({ groupId: 'g1', userId: 'u1', text: '我喜欢下棋' });
      const second = groupProfile.listRaw('g1', 'u1').length;
      eq(second, first, '更新频率限制：最小间隔内不新增条目（控制成本）');
    });

    // 默认不公开：非管理员不能查看他人画像
    freshStore();
    withCfg(ON, () => {
      groupProfile.observe({ groupId: 'g1', userId: 'u1', text: '我叫阿甲' });
      eq(groupProfile.view({ groupId: 'g1', userId: 'u1', actor: { userId: 'u2', isAdmin: false } }).error, 'forbidden',
        '默认不公开：普通成员不能查看他人画像');
      eq(groupProfile.view({ groupId: 'g1', userId: 'u1', actor: { userId: 'u1', isAdmin: false } }).ok, true,
        '可以查看自己的画像');
      eq(groupProfile.clearProfile({ groupId: 'g1', userId: 'u1', actor: { userId: 'u2', isAdmin: false } }).error, 'forbidden',
        '普通成员不能清除他人画像');
    });

    // 清除与重建（复用既有命令风格）
    freshStore();
    withCfg(ON, () => {
      groupProfile.observe({ groupId: 'g1', userId: 'u1', text: '我叫阿甲' });
      ok(groupProfile.listRaw('g1', 'u1').length >= 1, '清除前：画像存在');
      const c = groupProfile.clearProfile({ groupId: 'g1', userId: 'u1', actor: { userId: 'u1', isAdmin: false } });
      ok(c.ok && c.removed >= 1, '清除：本人可清除自己的画像');
      eq(groupProfile.listRaw('g1', 'u1').length, 0, '清除后：画像为空');

      const rb = groupProfile.rebuild({
        groupId: 'g1', userId: 'u1', actor: { userId: 'u1', isAdmin: false },
        texts: ['我叫阿甲', '我喜欢用 TypeScript', '我今年35岁'],
      });
      ok(rb.ok, '重建：正常执行');
      const after = groupProfile.listRaw('g1', 'u1');
      ok(after.some((x) => x.content.indexOf('阿甲') >= 0), '重建：恢复了自述类画像');
      ok(!after.some((x) => x.content.indexOf('35') >= 0), '重建：敏感属性仍被拒收');
    });
  }

  // ============================================================
  group('7. 容错：画像损坏/缺失/写入失败不影响原有记忆与聊天');
  // ============================================================
  {
    // ① 文件缺失 → 正常从空开始
    freshStore();
    withCfg(ON, () => {
      const r = groupProfile.observe({ groupId: 'g1', userId: 'u1', text: '我叫阿甲' });
      ok(r.ok, '画像文件缺失：可正常从空开始，不报错');
    });

    // ② 画像文件损坏 → 既有 memory_store 的保护逻辑生效，不破坏普通聊天
    const f = freshStore();
    memoryStore.add({ scope: 'user', userId: 'u9', content: '一条普通记忆', source: 'manual', confidence: 0.8 });
    memoryStore.flush();
    fs.writeFileSync(f, '{ 损坏的 JSON ', 'utf-8');
    memoryStore._reset();
    withCfg(ON, () => {
      let threw = null;
      try {
        for (let i = 0; i < 3; i++) {
          groupProfile.observe({ groupId: 'g1', userId: 'u1', text: '我叫阿甲' });
          groupProfile.injectText({ groupId: 'g1', userId: 'u1', text: '' });
        }
      } catch (e) { threw = e; }
      ok(threw === null, '画像文件损坏：observe/inject 不抛异常（聊天不受影响）');
    });

    // ③ 写入失败（磁盘不可写）→ 画像失败但不影响记忆读取
    const f2 = freshStore();
    withCfg(ON, () => {
      groupProfile.observe({ groupId: 'g1', userId: 'u1', text: '我叫阿甲' });
      const before = groupProfile.listRaw('g1', 'u1').length;
      const realWrite = fs.writeFileSync;
      fs.writeFileSync = function () { const e = new Error('模拟磁盘只读'); e.code = 'EROFS'; throw e; };
      let threw = null;
      try {
        groupProfile.observe({ groupId: 'g1', userId: 'u1', text: '我喜欢下棋' });
        groupProfile.injectText({ groupId: 'g1', userId: 'u1', text: '' });
      } catch (e) { threw = e; }
      fs.writeFileSync = realWrite;
      ok(threw === null, '写入失败：画像模块不抛异常（不阻断聊天）');
      const after = groupProfile.listRaw('g1', 'u1').length;
      ok(after >= before, '写入失败：原有记忆条目未被清空');
    });
    ok(f2.length > 0, '写入失败测试使用的文件路径有效');

    // ④ 原有普通记忆功能不受影响（画像是扩展，不是替代）
    freshStore();
    withCfg(ON, () => {
      const r = memoryStore.add({ scope: 'user', userId: 'u1', content: '用户手动记录的事实', source: 'manual', confidence: 0.9 });
      ok(r.ok, '画像启用时：普通记忆写入仍正常');
      groupProfile.observe({ groupId: 'g1', userId: 'u1', text: '我叫阿甲' });
      const all = memoryStore.list({ groupId: 'g1', userId: 'u1', allowAll: false }, 100);
      ok(all.some((x) => x.content === '用户手动记录的事实'), '画像与普通记忆共存（未互相覆盖）');
      ok(all.some((x) => String(x.source).indexOf('profile') === 0), '画像条目与普通记忆同库共存（复用同一存储）');
    });
  }

  // ============================================================
  group('8. 关闭新配置时：原有行为完全兼容');
  // ============================================================
  {
    freshStore();
    withCfg(OFF, () => {
      groupProfile.observe({ groupId: 'g1', userId: 'u1', text: '我叫阿甲' });
      eq(groupProfile.listRaw('g1', 'u1').length, 0, '画像关闭：不记录任何内容');
      eq(groupProfile.injectText({ groupId: 'g1', userId: 'u1', text: '' }), '', '画像关闭：注入为空（不增加 token）');
      eq(groupProfile.view({ groupId: 'g1', userId: 'u1', actor: { userId: 'u1' } }).error, 'disabled', '画像关闭：查看命令返回已关闭');
    });
    // 决策关闭 → 完全不改判定
    const off = { enabled: false };
    for (const [txt, dec] of [
      ['请问怎么配置？', { reply: false, needsJudge: true, reason: 'name-mention' }],
      ['那个我想问一下然后', { reply: false, needsJudge: true, reason: 'topic-followup' }],
      ['今天天气不错', { reply: false, needsJudge: false, reason: 'normal-chat' }],
      ['随便', { reply: true, needsJudge: false, reason: 'at' }],
    ]) {
      const r = groupDecision.review({ text: txt, buffer: [], decision: dec, isGroup: true, cfg: off });
      ok(r.changed === false && r.action === 'keep', '决策关闭：' + dec.reason + ' 判定完全不变');
    }
  }

  // ============================================================
  group('9. 隐私与成本：日志不含私密内容、零新增依赖');
  // ============================================================
  {
    const profSrc = fs.readFileSync(path.join(__dirname, '..', 'memory', 'group_profile.js'), 'utf-8');
    // 不打印完整聊天记录 / 画像内容到 console
    ok(!/console\.(log|error|warn)\s*\(/.test(profSrc), 'group_profile 不使用 console 输出（不打印画像/聊天内容）');
    // 零新增第三方依赖
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
    const deps = Object.keys(pkg.dependencies || {}).length + Object.keys(pkg.devDependencies || {}).length;
    eq(deps, 0, '未新增任何 npm 依赖（仍为零依赖项目）');
    const reNew = /^const .*require\('([^']+)'\)/gm;
    const mods = new Set();
    let m;
    while ((m = reNew.exec(profSrc)) !== null) if (!m[1].startsWith('.')) mods.add(m[1]);
    // 只允许 Node 内置模块（path 等），不得有任何第三方库
    const BUILTIN = new Set(['path', 'fs', 'crypto', 'os', 'util']);
    const external = [...mods].filter((x) => !BUILTIN.has(x));
    eq(external.length, 0, 'group_profile 只依赖 Node 内置模块与本地模块，无第三方库（实际：' + [...mods].join(',') + '）');
  }

  // ============================================================
  group('10. 配置模板一致性与默认关闭');
  // ============================================================
  {
    const cfgPath = path.join(__dirname, '..', 'ai_config.example.json');
    let cfg = null, parseOk = false;
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); parseOk = true; } catch (e) {}
    ok(parseOk, 'ai_config.example.json 是合法 JSON');
    if (cfg) {
      // 顶层键（不得嵌套）
      ok(cfg.groupProfile && typeof cfg.groupProfile === 'object', 'groupProfile 是顶层键');
      ok(cfg.groupDecision && typeof cfg.groupDecision === 'object', 'groupDecision 是顶层键');
      // 新功能默认关闭
      eq(cfg.groupProfile.enabled, false, 'groupProfile 默认关闭（须显式启用）');
      eq(cfg.groupDecision.enabled, false, 'groupDecision 默认关闭（须显式启用）');
      eq(cfg.groupProfile.shareToGroup, false, '默认不向群内公开成员画像');
      // 字段与代码默认值一致
      const gpDefaults = groupProfile.DEFAULTS;
      for (const k of ['maxPerUser', 'maxLen', 'injectLimit', 'injectChars', 'minSamples', 'ttlDays']) {
        eq(cfg.groupProfile[k], gpDefaults[k], 'groupProfile.' + k + ' 与代码默认值一致');
      }
      const gdDefaults = groupDecision.DEFAULTS;
      for (const k of ['dedupWindow', 'dedupWindowMs', 'minTopicLen', 'deferMinChars']) {
        eq(cfg.groupDecision[k], gdDefaults[k], 'groupDecision.' + k + ' 与代码默认值一致');
      }
      // 不含真实个人信息
      ok(Array.isArray(cfg.admin.qq) && cfg.admin.qq.length === 0, 'admin.qq 仍为空（模板不含真实 QQ 号）');
      const raw = fs.readFileSync(cfgPath, 'utf-8');
      ok(!/"(apiKey|token|password|secret)"\s*:\s*"[^"]{8,}"/i.test(raw), '模板不含任何硬编码密钥');
    }
  }

  console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
  if (fail) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exit(1); }
})();
