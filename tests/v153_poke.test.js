'use strict';
// ================= V15.3 离线测试：群友戳一戳 =================
// 类别：纯本地规则（mock NapCat 调用），**不联网、不连真实 QQ、不发真实戳一戳**。
// 覆盖：默认关闭、主动戳的各类边界与限频、群友被戳反应、与既有 poke 的边界不重叠、
//       冷却/限频/内存清理、默认不新增模型调用。

const pokeSocial = require('../feiyu/poke_social');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name) { if (cond) pass++; else { fail++; fails.push(name); console.log('  ✗ ' + name); } }
function eq(a, b, name) { ok(a === b, name + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function group(t) { console.log('\n[' + t + ']'); }

function withCfg(c, fn) {
  pokeSocial.setConfig(() => c);
  pokeSocial._reset();
  try { return fn(); } finally { pokeSocial.setConfig(null); pokeSocial._reset(); }
}

const ON = {
  pokeOthers: {
    enabled: true, adminOnly: true, cooldownMs: 60000, maxPerHour: 3, maxPerDay: 5,
    react: {
      enabled: true, mode: 'poke+text', cooldownMs: 30000,
      reactMinIntervalGroupMs: 180000, maxReactPerHour: 4, useAI: false, texts: ['别戳了', '再戳收费啊'],
    },
  },
};
const OFF = { pokeOthers: { enabled: false, react: { enabled: false, mode: 'off' } } };
const atSeg = (qq) => [{ type: 'at', data: { qq: String(qq) } }];

(async function main() {

  group('1. 默认关闭：不响应、不主动戳');
  {
    withCfg(OFF, () => {
      eq(pokeSocial.decidePokeOther({ groupId: 'g1', actorId: '100', targetId: '20000', selfId: '999', isAdmin: true, segs: atSeg(20000) }).reason, 'disabled',
        '主动戳默认关闭');
      eq(pokeSocial.decideReactToOtherPoke({ groupId: 'g1', actorId: '100', targetId: '20000', selfId: '999' }).reason, 'disabled',
        '群友被戳反应默认关闭');
    });
    // 未配置任何 pokeOthers 时也应为关闭（默认安全）
    withCfg({}, () => {
      eq(pokeSocial.decidePokeOther({ groupId: 'g1', actorId: '100', targetId: '20000', selfId: '999', isAdmin: true, segs: atSeg(20000) }).reason, 'disabled',
        '未配置 pokeOthers 时默认关闭（不会误动作）');
    });
  }

  group('2. 主动戳群友：正常路径与必须@的要求');
  {
    withCfg(ON, () => {
      const r = pokeSocial.decidePokeOther({
        groupId: 'g1', actorId: '100', targetId: '20000', selfId: '999', isAdmin: true, segs: atSeg(20000), now: 1000000,
      });
      eq(r.ok, true, '管理员明确@某人 → 允许戳');
      eq(r.action, 'poke', '动作是 poke');
    });
    withCfg(ON, () => {
      // 未@任何人：拒绝（不猜昵称/不猜纯数字，避免戳错人）
      eq(pokeSocial.decidePokeOther({ groupId: 'g1', actorId: '100', targetId: '', selfId: '999', isAdmin: true, segs: [{ type: 'text', data: { text: '戳你' } }], now: 1000000 }).reason, 'need-at',
        '未明确@某人 → 拒绝（不猜昵称，防戳错人）');
      // 有@但与传入 target 不一致 → 拒绝
      eq(pokeSocial.decidePokeOther({ groupId: 'g1', actorId: '100', targetId: '20000', selfId: '999', isAdmin: true, segs: atSeg(30000), now: 1000000 }).reason, 'target-mismatch',
        '@的人与目标不一致 → 拒绝');
    });
    withCfg(ON, () => {
      eq(pokeSocial.pickAtTarget([{ type: 'text', data: { text: 'hi' } }, { type: 'at', data: { qq: '20000' } }]), '20000',
        '能从混合段里正确提取 @ 目标');
      eq(pokeSocial.pickAtTarget([{ type: 'text', data: { text: 'hi' } }]), null, '没有@段时返回 null');
    });
  }

  group('3. 主动戳的权限与安全边界');
  {
    withCfg(ON, () => {
      eq(pokeSocial.decidePokeOther({ groupId: 'g1', actorId: '100', targetId: '20000', selfId: '999', isAdmin: false, segs: atSeg(20000), now: 1000000 }).reason, 'admin-only',
        '非管理员 → 拒绝（防滥用）');
    });
    withCfg(ON, () => {
      eq(pokeSocial.decidePokeOther({ groupId: 'g1', actorId: '100', targetId: '999', selfId: '999', isAdmin: true, segs: atSeg(999), now: 1000000 }).reason, 'self',
        '戳机器人自己 → 拒绝');
      eq(pokeSocial.decidePokeOther({ groupId: 'g1', actorId: '100', targetId: '100', selfId: '999', isAdmin: true, segs: atSeg(100), now: 1000000 }).reason, 'self-poke',
        '戳发起者自己 → 拒绝');
      eq(pokeSocial.decidePokeOther({ groupId: 'g1', actorId: '100', targetId: '30000', selfId: '999', isAdmin: true, isTargetAdmin: true, segs: atSeg(30000), now: 1000000 }).reason, 'target-is-admin',
        '戳管理员 → 拒绝（不骚扰主人）');
    });
    withCfg(ON, () => {
      eq(pokeSocial.decidePokeOther({ groupId: null, actorId: '100', targetId: '20000', selfId: '999', isAdmin: true, segs: atSeg(20000), now: 1000000 }).reason, 'group-only',
        '非群聊（私聊）→ 拒绝');
    });
    // 放开 adminOnly 后普通成员可用（配置项生效）
    const openCfg = JSON.parse(JSON.stringify(ON));
    openCfg.pokeOthers.adminOnly = false;
    withCfg(openCfg, () => {
      eq(pokeSocial.decidePokeOther({ groupId: 'g1', actorId: '100', targetId: '20000', selfId: '999', isAdmin: false, segs: atSeg(20000), now: 1000000 }).ok, true,
        'adminOnly=false 时普通成员可用（按配置）');
    });
  }

  group('4. 限频：冷却 / 每小时 / 每日');
  {
    withCfg(ON, () => {
      const T = 1000000;
      const first = pokeSocial.decidePokeOther({ groupId: 'g1', actorId: '100', targetId: '20000', selfId: '999', isAdmin: true, segs: atSeg(20000), now: T });
      eq(first.ok, true, '首次允许');
      pokeSocial.commitPoke(first, T);
      // 冷却内再戳同一对 → 拒绝
      eq(pokeSocial.decidePokeOther({ groupId: 'g1', actorId: '100', targetId: '20000', selfId: '999', isAdmin: true, segs: atSeg(20000), now: T + 1000 }).reason, 'cooldown',
        '冷却期内重复戳 → 拒绝');
      // 冷却过后允许
      eq(pokeSocial.decidePokeOther({ groupId: 'g1', actorId: '100', targetId: '20000', selfId: '999', isAdmin: true, segs: atSeg(20000), now: T + 61000 }).ok, true,
        '冷却期过后 → 允许');
      // 换目标不受同一冷却影响
      eq(pokeSocial.decidePokeOther({ groupId: 'g1', actorId: '100', targetId: '20001', selfId: '999', isAdmin: true, segs: atSeg(20001), now: T + 1000 }).ok, true,
        '换一个人戳 → 不受上一对冷却影响');
    });
    withCfg(ON, () => {
      // 每小时上限（maxPerHour=3）
      const T = 2000000;
      let hourBlocked = false;
      for (let i = 0; i < 6; i++) {
        const r = pokeSocial.decidePokeOther({ groupId: 'g1', actorId: '100', targetId: '2000' + i, selfId: '999', isAdmin: true, segs: atSeg('2000' + i), now: T });
        if (r.ok) pokeSocial.commitPoke(r, T); else if (r.reason === 'rate-hour') { hourBlocked = true; break; }
      }
      ok(hourBlocked, '每小时上限生效（超出后拒绝）');
    });
    withCfg(ON, () => {
      // 每日上限（maxPerDay=5）：用**不同发起者**绕过每小时上限，验证全局日限
      const T = Date.parse('2026-03-05T10:00:00Z');
      let dayBlocked = false, okCount = 0;
      for (let a = 0; a < 10 && !dayBlocked; a++) {
        for (let i = 0; i < 3; i++) {
          const now2 = T + a * 1000 + i * 1000;      // 同一小时内
          const r = pokeSocial.decidePokeOther({
            groupId: 'g1', actorId: '90' + a, targetId: '2000' + i,
            selfId: '999', isAdmin: true, segs: atSeg('2000' + i), now: now2,
          });
          if (r.ok) { pokeSocial.commitPoke(r, now2); okCount++; }
          else if (r.reason === 'rate-day') { dayBlocked = true; break; }
        }
      }
      ok(dayBlocked, '每日上限生效（多发起者累计后被拒，已成功 ' + okCount + ' 次）');
      ok(okCount <= 5, '成功次数不超过每日上限（实际 ' + okCount + '）');
    });
  }

  group('5. 对群友被戳的反应');
  {
    withCfg(ON, () => {
      const r = pokeSocial.decideReactToOtherPoke({ groupId: 'g1', actorId: '100', targetId: '20000', selfId: '999', now: 3000000 });
      eq(r.ok, true, '群友戳群友 → 允许反应');
      ok(r.action === 'poke+text' || r.action === 'poke', '动作为回戳/接话，实际 ' + r.action);
    });
    withCfg(ON, () => {
      // 被戳的是机器人自己 → 让位给既有 handlePoke，本模块不重复处理
      eq(pokeSocial.decideReactToOtherPoke({ groupId: 'g1', actorId: '100', targetId: '999', selfId: '999', now: 3000000 }).reason, 'is-self',
        '被戳者是机器人 → 让位既有逻辑（不重复回）');
    });
    withCfg(ON, () => {
      // 冷却
      const T = 4000000;
      const r1 = pokeSocial.decideReactToOtherPoke({ groupId: 'g1', actorId: '100', targetId: '20000', selfId: '999', now: T });
      pokeSocial.commitReact(r1, T);
      eq(pokeSocial.decideReactToOtherPoke({ groupId: 'g1', actorId: '100', targetId: '20000', selfId: '999', now: T + 1000 }).reason, 'cooldown',
        '同一对冷却期内不重复反应');
    });
    withCfg(ON, () => {
      // 群太密 → 降级为只回戳不说话，避免刷屏
      const T = 5000000;
      const r1 = pokeSocial.decideReactToOtherPoke({ groupId: 'g1', actorId: '100', targetId: '20000', selfId: '999', now: T });
      pokeSocial.commitReact(r1, T);   // 记下"刚刚说过话"
      const r2 = pokeSocial.decideReactToOtherPoke({ groupId: 'g1', actorId: '200', targetId: '20001', selfId: '999', now: T + 1000 });
      ok(r2.ok, '群内密集戳一戳：仍允许回戳');
      eq(r2.speaks, false, '群内过密时不插话（只回戳，防刷屏）');
    });
    withCfg(ON, () => {
      // 每小时上限
      const T = 6000000;
      let blocked = false;
      for (let i = 0; i < 10; i++) {
        const r = pokeSocial.decideReactToOtherPoke({ groupId: 'g1', actorId: '10' + i, targetId: '2000' + i, selfId: '999', now: T + i * 40000 });
        if (r.ok) pokeSocial.commitReact(r, T + i * 40000);
        else if (r.reason === 'rate-hour') { blocked = true; break; }
      }
      ok(blocked, '每群每小时反应次数上限生效');
    });
    // mode=off 显式关闭
    withCfg({ pokeOthers: { enabled: true, react: { enabled: true, mode: 'off' } } }, () => {
      eq(pokeSocial.decideReactToOtherPoke({ groupId: 'g1', actorId: '100', targetId: '20000', selfId: '999', now: 1000000 }).reason, 'mode-off',
        'mode=off → 不反应');
    });
    // 非群聊不反应
    withCfg(ON, () => {
      eq(pokeSocial.decideReactToOtherPoke({ groupId: null, actorId: '100', targetId: '20000', selfId: '999', now: 1000000 }).reason, 'group-only',
        '非群聊事件 → 不反应');
    });
  }

  group('6. 文案与成本：不默认调模型、不空池');
  {
    withCfg(ON, () => {
      const c = pokeSocial.cfg();
      eq(c.useAI, false, '默认不启用 AI 现编（零额外模型调用）');
      const t = pokeSocial.pickText(c);
      ok(t && t.length > 0, '能从固定池取到接话文案');
    });
    // 空池时回落默认池，不返回空
    withCfg({ pokeOthers: { enabled: true, react: { enabled: true, mode: 'text', texts: [] } } }, () => {
      const c = pokeSocial.cfg();
      const t = pokeSocial.pickText(c);
      ok(t && t.length > 0, 'texts 为空时回落默认池（不会说出空话）');
    });
  }

  group('7. 内存计数可清理（长期运行不膨胀）');
  {
    withCfg(ON, () => {
      const T = Date.parse('2026-03-05T10:00:00Z');
      for (let i = 0; i < 5; i++) {
        const r = pokeSocial.decidePokeOther({ groupId: 'g1', actorId: '100', targetId: '2000' + i, selfId: '999', isAdmin: true, segs: atSeg('2000' + i), now: T });
        if (r.ok) pokeSocial.commitPoke(r, T);
      }
      ok(pokeSocial.stats().counters > 0, '计数已记录');
      // 推进到第二天并清理 → 旧计数消失
      pokeSocial.sweep(T + 86400000);
      eq(pokeSocial.stats().counters, 0, '跨天清理后旧计数归零（不无限增长）');
      eq(pokeSocial.stats().pokeLog, 0, '跨天清理后戳一戳记录归零');
    });
  }

  group('8. 与既有 poke 功能边界不重叠');
  {
    withCfg(ON, () => {
      // 既有 handlePoke 只处理 target===self；本模块必须对该场景明确让位
      eq(pokeSocial.decideReactToOtherPoke({ groupId: 'g1', actorId: '100', targetId: '999', selfId: '999', now: 1000000 }).ok, false,
        '机器人自己被戳 → 本模块不处理（避免与既有 poke 重复回）');
      // 本模块只处理"群友被戳"
      eq(pokeSocial.decideReactToOtherPoke({ groupId: 'g1', actorId: '100', targetId: '20000', selfId: '999', now: 1000000 }).ok, true,
        '群友被戳 → 本模块处理');
    });
    // 不含任何网络/外部依赖
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'feiyu', 'poke_social.js'), 'utf-8');
    ok(!/require\(['"](https?|axios|node-fetch|ai_bridge)/.test(src), 'poke_social 不引入任何网络/模型依赖');
    ok(!/console\.(log|error|warn)\s*\(/.test(src), 'poke_social 不使用 console（不刷屏、不泄露）');
  }

  console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
  if (fail) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exit(1); }
})();
