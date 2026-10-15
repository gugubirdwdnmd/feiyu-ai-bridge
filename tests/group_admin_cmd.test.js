'use strict';
// ================= 阶段2.1 测试：群管命令路由（只读，零网络，全 mock）=================
// 覆盖：命令解析、权限拒绝、接口失败、成功返回（脱敏）。绝不真实请求 OneBot。
// 真实运行实例的只读查询验收见下方「真实验收」（单独运行，不改配置）。

const { createGroupAdmin, parseGroupCommand, runGroupCommand } = require('../tools/group_admin');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name) { if (cond) pass++; else { fail++; fails.push(name); console.log('  ✗ ' + name); } }
function eq(a, b, name) { ok(a === b, name + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function group(t) { console.log('\n[' + t + ']'); }

// —— mock callOneBot（绝不真实联网）——
function mockCallOneBot(kind) {
  return async function (action, payload) {
    if (kind === 'transport') return { __error: 'ECONNREFUSED' };
    if (kind === 'failed') return { status: 'failed', retcode: 200, data: null, message: 'EventChecker Failed', wording: '' };
    if (kind === 'ok-group') return { status: 'ok', retcode: 0, data: { group_name: '测试群', member_count: 50, max_member_count: 200, owner_id: 12345, secret_field: 'x' } };
    if (kind === 'ok-member') return { status: 'ok', retcode: 0, data: { user_id: 999, role: 'admin', nickname: '张三', card: '', title: '', join_time: 1234567, level: 5, secret_field: 'x' } };
    return { status: 'failed', retcode: 200, data: null, message: 'unknown kind' };
  };
}

const adminYes = () => true;
const adminNo = () => false;
const en = () => ({ groupAdmin: { enabled: true } });
function ga(over) { return createGroupAdmin(Object.assign({ isAdmin: adminYes, getCFG: en }, over || {})); }

(async function main() {
  group('A 命令解析 parseGroupCommand');
  {
    let p = parseGroupCommand('/ai group status 123');
    eq(p.ok, true, 'status.ok'); eq(p.sub, 'status', 'status.sub'); eq(p.args.groupId, '123', 'status.groupId');
    p = parseGroupCommand('/ai group member 123 456');
    eq(p.ok, true, 'member.ok'); eq(p.sub, 'member', 'member.sub'); eq(p.args.groupId, '123', 'member.groupId'); eq(p.args.targetId, '456', 'member.targetId');
    p = parseGroupCommand('/ai group me 123');
    eq(p.ok, true, 'me.ok'); eq(p.sub, 'me', 'me.sub'); eq(p.args.groupId, '123', 'me.groupId');
    p = parseGroupCommand('/ai group help');
    eq(p.ok, true, 'help.ok'); eq(p.sub, 'help', 'help.sub');
    p = parseGroupCommand('/ai group');
    eq(p.ok, true, 'emptySub→help.ok'); eq(p.sub, 'help', 'emptySub→help.sub');
    p = parseGroupCommand('/ai group status');
    eq(p.ok, false, 'status缺参.ok=false'); eq(p.reason, 'bad-args', 'status缺参.reason'); eq(p.need, '<群号>', 'status缺参.need');
    p = parseGroupCommand('/ai group member 123');
    eq(p.ok, false, 'member缺参.ok=false'); eq(p.reason, 'bad-args', 'member缺参.reason'); eq(p.need, '<群号> <QQ号>', 'member缺参.need');
    p = parseGroupCommand('/ai group foo 123');
    eq(p.ok, false, '未知子命令.ok=false'); eq(p.reason, 'unknown-sub', '未知子命令.reason'); eq(p.sub, 'foo', '未知子命令.sub');
    p = parseGroupCommand('/ai mode chat');
    eq(p.ok, false, '非group.ok=false'); eq(p.reason, 'not-group', '非group.reason');
    p = parseGroupCommand('hello world');
    eq(p.ok, false, '非ai.ok=false'); eq(p.reason, 'not-ai', '非ai.reason');
  }

  group('B 权限拒绝：isAdmin=false 时命令被拒（fail-closed）');
  {
    const g = ga({ callOneBot: mockCallOneBot('ok-group'), isAdmin: adminNo });
    const ctx = { userId: 999999, selfId: 1430831772 };
    const r1 = await runGroupCommand(g, '/ai group status 10000', ctx);
    ok(/管理员/.test(r1), 'status拒绝含「管理员」: ' + r1.replace(/\n/g, ' '));
    const r2 = await runGroupCommand(g, '/ai group member 10000 999', ctx);
    ok(/管理员/.test(r2), 'member拒绝含「管理员」');
    const r3 = await runGroupCommand(g, '/ai group me 10000', ctx);
    ok(/管理员/.test(r3), 'me拒绝含「管理员」');
  }

  group('C 未启用：enabled=false 时命令被拒');
  {
    const g = ga({ callOneBot: mockCallOneBot('ok-group'), getCFG: () => ({ groupAdmin: { enabled: false } }) });
    const ctx = { userId: 1430831772, selfId: 1430831772 };
    const r = await runGroupCommand(g, '/ai group status 10000', ctx);
    ok(/未启用/.test(r), '未启用提示: ' + r.replace(/\n/g, ' '));
  }

  group('D 接口失败 / 传输异常：不当作成功');
  {
    const g1 = ga({ callOneBot: mockCallOneBot('failed') });
    const r1 = await runGroupCommand(g1, '/ai group status 10000', { userId: 1, selfId: 1430831772 });
    ok(/失败/.test(r1) && !/测试群/.test(r1), 'failed→失败且不含有效数据: ' + r1.replace(/\n/g, ' '));
    const g2 = ga({ callOneBot: mockCallOneBot('transport') });
    const r2 = await runGroupCommand(g2, '/ai group status 10000', { userId: 1, selfId: 1430831772 });
    ok(/失败/.test(r2), 'transport→失败: ' + r2.replace(/\n/g, ' '));
  }

  group('E 参数/语法错误：直接拒绝，不调用接口');
  {
    const calls = { n: 0 };
    const spy = async (a, p) => { calls.n++; return mockCallOneBot('ok-group')(a, p); };
    const g = ga({ callOneBot: spy });
    const ctx = { userId: 1, selfId: 1430831772 };
    const r1 = await runGroupCommand(g, '/ai group status', ctx);
    ok(/参数不足/.test(r1), '缺少群号→参数不足: ' + r1.replace(/\n/g, ' '));
    const r2 = await runGroupCommand(g, '/ai group foo 10000', ctx);
    ok(/未知群管子命令/.test(r2), '未知子命令→提示: ' + r2.replace(/\n/g, ' '));
    eq(calls.n, 0, '参数错误时未发起任何接口调用');
  }

  group('F 成功返回 + 脱敏：仅必要字段，无 secret/名单');
  {
    const g = ga({ callOneBot: mockCallOneBot('ok-group') });
    const r1 = await runGroupCommand(g, '/ai group status 10000', { userId: 1, selfId: 1430831772 });
    ok(/测试群/.test(r1) && /人数=50\/200/.test(r1), 'status成功含群名/人数: ' + r1.replace(/\n/g, ' '));
    ok(!/secret_field/.test(r1), 'status结果不含 secret_field');

    const g2 = ga({ callOneBot: mockCallOneBot('ok-member') });
    const r2 = await runGroupCommand(g2, '/ai group member 10000 999', { userId: 1, selfId: 1430831772 });
    ok(/QQ=999/.test(r2) && /角色=admin/.test(r2), 'member成功含QQ/角色: ' + r2.replace(/\n/g, ' '));
    ok(/群号=10000/.test(r2) && !/群号=undefined/.test(r2), 'member群号正确非undefined: ' + r2.replace(/\n/g, ' '));
    ok(!/secret_field/.test(r2), 'member结果不含 secret_field');
    ok(!/\[\]/.test(r2) && !/Array/.test(r2), 'member返回单条而非名单');

    const g3 = ga({ callOneBot: mockCallOneBot('ok-member') });
    const r3 = await runGroupCommand(g3, '/ai group me 10000', { userId: 1, selfId: 1430831772 });
    ok(/是否该群管理员=是/.test(r3), 'me管理员身份=是: ' + r3.replace(/\n/g, ' '));
  }

  group('G 帮助信息包含三条只读子命令');
  {
    const r = await runGroupCommand(ga({}), '/ai group help', { userId: 1, selfId: 1430831772 });
    ok(/status/.test(r) && /member/.test(r) && /me/.test(r), 'help含 status/member/me');
    ok(/未开放|写操作/.test(r), 'help声明写操作未开放');
  }

  console.log(`\n>> 群管命令路由测试：通过 ${pass}，失败 ${fail}`);
  if (fail) { console.log('>> 失败项：' + fails.join('；')); }
  process.exit(fail ? 1 : 0);
})();
