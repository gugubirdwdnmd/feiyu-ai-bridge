'use strict';
// ================= 阶段2 测试：群管模块（仅只读查询，零网络，全 mock）=================
// 类别：全部为【A 单元 / 模拟】—— callOneBot 一律注入 mock，绝不真实请求 OneBot。

const { createGroupAdmin } = require('../tools/group_admin');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name) { if (cond) pass++; else { fail++; fails.push(name); console.log('  ✗ ' + name); } }
function eq(a, b, name) { ok(a === b, name + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function group(t) { console.log('\n[' + t + ']'); }

// ——— mock callOneBot 构造器（绝不真实联网）———
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

function ga(over) { return createGroupAdmin(over || {}); }
function enabled(getCFG) { return Object.assign({ isAdmin: adminYes }, getCFG ? { getCFG } : { getCFG: () => ({ groupAdmin: { enabled: true } }) }); }

(async function main() {

  group('T1 默认关闭：enabled=false 时一切查询返回未启用');
  {
    const g = ga({ callOneBot: mockCallOneBot('ok-group'), isAdmin: adminYes });
    eq(g.isEnabled(), false, 'isEnabled 默认 false');
    const r1 = await g.queryGroupProfile(10000, 1430831772);
    eq(r1.ok, false, '未启用时 groupProfile.ok=false');
    ok(r1.reason === 'disabled', 'reason=disabled');
    const r2 = await g.queryMember(10000, 999, 1430831772);
    eq(r2.ok, false, '未启用时 member.ok=false');
    const r3 = await g.queryBotAdminStatus(10000, 1430831772, 1430831772);
    eq(r3.ok, false, '未启用时 botAdmin.ok=false');
  }

  group('T2 普通成员越权：isAdmin=false 时全部拒绝（forbidden）');
  {
    const g = ga(enabled(() => ({ groupAdmin: { enabled: true } })));
    g.isAdmin = undefined; // 用 deps.isAdmin=adminNo
    const g2 = ga({ callOneBot: mockCallOneBot('ok-group'), isAdmin: adminNo, getCFG: () => ({ groupAdmin: { enabled: true } }) });
    const r1 = await g2.queryGroupProfile(10000, 999999);
    eq(r1.ok, false, '越权 groupProfile.ok=false');
    ok(r1.rejected === true && r1.reason === 'forbidden', 'rejected+forbidden');
    const r2 = await g2.queryMember(10000, 999, 999999);
    eq(r2.ok, false, '越权 member.ok=false');
    const r3 = await g2.queryBotAdminStatus(10000, 1430831772, 999999);
    eq(r3.ok, false, '越权 botAdmin.ok=false');
  }

  group('T3 无效群号 / 无效目标：参数校验拒绝（不调用接口）');
  {
    const calls = { n: 0 };
    const spy = async (a, p) => { calls.n++; return mockCallOneBot('ok-group')(a, p); };
    const g = ga({ callOneBot: spy, isAdmin: adminYes, getCFG: () => ({ groupAdmin: { enabled: true } }) });
    for (const bad of [0, -1, 'abc', 1e20, null, undefined, '']) {
      const r = await g.queryGroupProfile(bad, 1430831772);
      eq(r.ok, false, 'bad group_id=' + JSON.stringify(bad) + ' 拒绝');
      ok(r.reason === 'bad-group', 'bad-group reason');
    }
    const r2 = await g.queryMember(10000, 'notqq', 1430831772);
    eq(r2.ok, false, 'invalid target 拒绝');
    ok(r2.reason === 'bad-user', 'bad-user reason');
    eq(calls.n, 0, '无效参数时未发起任何接口调用');
  }

  group('T4 接口失败（failed 状态）：不当作成功');
  {
    const g = ga({ callOneBot: mockCallOneBot('failed'), isAdmin: adminYes, getCFG: () => ({ groupAdmin: { enabled: true } }) });
    const r1 = await g.queryGroupProfile(10000, 1430831772);
    eq(r1.ok, false, 'failed 状态 groupProfile.ok=false');
    const r2 = await g.queryBotAdminStatus(10000, 1430831772, 1430831772);
    eq(r2.ok, false, 'failed 状态 botAdmin.ok=false');
  }

  group('T5 接口异常（transport error）：被捕获为失败，不当作成功');
  {
    const g = ga({ callOneBot: mockCallOneBot('transport'), isAdmin: adminYes, getCFG: () => ({ groupAdmin: { enabled: true } }) });
    const r1 = await g.queryGroupProfile(10000, 1430831772);
    eq(r1.ok, false, 'transport groupProfile.ok=false');
    ok(r1.reason === 'api-error' || r1.reason === 'api-exception', 'transport 归类为接口失败');
  }

  group('T6 机器人不是管理员：正确返回 is_group_admin=false（非报错、非误判）');
  {
    const g = ga({ callOneBot: mockCallOneBot('ok-member'), isAdmin: adminYes, getCFG: () => ({ groupAdmin: { enabled: true } }) });
    const r = await g.queryBotAdminStatus(10000, 1430831772, 1430831772);
    eq(r.ok, true, '查询成功');
    eq(r.role, 'admin', 'role=admin');
    eq(r.is_group_admin, true, 'admin 视为群管');
    const mockMember = async () => ({ status: 'ok', retcode: 0, data: { user_id: 1430831772, role: 'member', nickname: 'bot' } });
    const g2 = ga({ callOneBot: mockMember, isAdmin: adminYes, getCFG: () => ({ groupAdmin: { enabled: true } }) });
    const r2 = await g2.queryBotAdminStatus(10000, 1430831772, 1430831772);
    eq(r2.ok, true, '普通成员角色查询成功');
    eq(r2.is_group_admin, false, 'member 的 is_group_admin=false');
  }

  group('T7 成功路径 + 脱敏：仅返回白名单字段，无 secret/无关字段');
  {
    const g = ga({ callOneBot: mockCallOneBot('ok-group'), isAdmin: adminYes, getCFG: () => ({ groupAdmin: { enabled: true } }) });
    const r = await g.queryGroupProfile(10000, 1430831772);
    eq(r.ok, true, 'groupProfile.ok=true');
    eq(r.group_name, '测试群', '返回群名');
    eq(r.member_count, 50, '返回人数');
    ok(!('secret_field' in r), 'secret_field 被脱敏剔除');
    ok(!Array.isArray(r.member_list), '群资料不含成员名单');

    const g2 = ga({ callOneBot: mockCallOneBot('ok-member'), isAdmin: adminYes, getCFG: () => ({ groupAdmin: { enabled: true } }) });
    const r2 = await g2.queryMember(10000, 999, 1430831772);
    eq(r2.ok, true, 'member.ok=true');
    eq(r2.member.user_id, 999, '返回被查询者自身 user_id');
    eq(r2.member.role, 'admin', '返回角色');
    ok(!('secret_field' in r2.member), 'member secret_field 剔除');
    ok(!Array.isArray(r2.member), '返回单条而非名单');
  }

  group('T8 配置从 getCFG 生效 + status()');
  {
    const g = ga({ callOneBot: mockCallOneBot('ok-group'), isAdmin: adminYes, getCFG: () => ({ groupAdmin: { enabled: true, apiBase: 'http://127.0.0.1:9999' } }) });
    eq(g.isEnabled(), true, 'enabled 由 getCFG 覆盖为 true');
    const s = g.status();
    eq(s.enabled, true, 'status.enabled=true');
    eq(s.apiBase, 'http://127.0.0.1:9999', 'status.apiBase 取配置');
  }

  console.log(`\n>> 群管阶段2 测试：通过 ${pass}，失败 ${fail}`);
  if (fail) { console.log('>> 失败项：' + fails.join('；')); }
  process.exit(fail ? 1 : 0);
})();
