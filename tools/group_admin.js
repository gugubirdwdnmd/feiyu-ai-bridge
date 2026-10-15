'use strict';
// ================= 阶段2：群管模块（独立、默认关闭、仅只读查询）=================
// 设计原则：
//   ① 完全独立，不依赖 ai_bridge 内部（不 require 主文件）；通过工厂注入 callOneBot / getCFG / isAdmin。
//   ② 默认 enabled=false：未显式开启时，一切查询返回「未启用」，绝不调用接口。
//   ③ 权限闸门：仅可信管理员（isAdmin 判定）可调用；普通成员越权直接拒绝（fail-closed）。
//   ④ 脱敏：返回仅保留字段白名单，绝不返回完整成员名单或无关 QQ 号。
//   ⑤ 严格状态校验：群号/参数非法 → 拒绝；接口报错/超时/异常 → 视为失败，绝不当作成功。
//   ⑥ 本阶段【无任何写操作】：不实现也不调用踢人/禁言/解禁/改名片/全员禁言/设管理员。

const MODULE_DEFAULTS = {
  enabled: false,
  apiBase: 'http://127.0.0.1:3000',
  timeoutMs: 8000,
  protectedRoles: ['owner', 'admin'],
  groupFields: ['group_name', 'member_count', 'max_member_count', 'owner_id'],
  memberFields: ['role', 'nickname', 'card', 'title', 'join_time', 'level'],
};

// 内置 OneBot 调用（与 ai_bridge 的 napcatCall 行为一致：action 走 URL 路径，参数平铺 body）
function builtinCallOneBot(apiBase, timeoutMs) {
  return async function callOneBot(action, payload) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`${apiBase}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
        signal: ctrl.signal,
      });
      return await r.json();
    } catch (e) {
      return { __error: String((e && e.message) || e) };
    } finally {
      clearTimeout(timer);
    }
  };
}

// 群号：正整数且落在合理范围
function validGroupId(g) {
  const n = Number(g);
  return Number.isInteger(n) && n > 0 && n < 1e15;
}
function validUserId(u) {
  const n = Number(u);
  return Number.isInteger(n) && n > 0 && n < 1e15;
}

// OneBot 返回是否成功：必须显式 ok + retcode 0 + 有 data；报错/异常一律不算成功
function obOk(r) {
  return !!(r && typeof r === 'object' && !r.__error && r.status === 'ok' && r.retcode === 0 && r.data != null);
}

// 脱敏单成员：只保留白名单字段 + 被查询者自身 user_id（单条，非名单）
function redactMember(m, fields) {
  if (!m || typeof m !== 'object') return null;
  const out = {};
  for (const k of fields) if (k in m) out[k] = m[k];
  if ('user_id' in m) out.user_id = m.user_id;
  return out;
}

function makeError(message, extra) {
  const o = { ok: false, message };
  if (extra) Object.assign(o, extra);
  return o;
}

function createGroupAdmin(deps) {
  deps = deps || {};
  const getCFG = typeof deps.getCFG === 'function' ? deps.getCFG : () => ({});
  const isAdminFn = typeof deps.isAdmin === 'function' ? deps.isAdmin : () => false;
  const callOneBot = typeof deps.callOneBot === 'function'
    ? deps.callOneBot
    : builtinCallOneBot(MODULE_DEFAULTS.apiBase, MODULE_DEFAULTS.timeoutMs);

  function cfg() {
    const c = getCFG() || {};
    return Object.assign({}, MODULE_DEFAULTS, c.groupAdmin || {});
  }
  function isEnabled() { return cfg().enabled === true; }

  // 权限闸门：普通成员越权即拒绝（fail-closed）
  function assertAdmin(userId) {
    if (!isAdminFn(userId)) {
      return makeError('仅管理员可执行群管查询', { rejected: true, reason: 'forbidden' });
    }
    return null;
  }

  // 管理员身份查询：机器人在该群是否为群主/管理员
  async function queryBotAdminStatus(groupId, selfId, userId) {
    const deny = assertAdmin(userId); if (deny) return deny;
    if (!isEnabled()) return makeError('群管功能未启用', { reason: 'disabled' });
    if (!validGroupId(groupId)) return makeError('群号无效', { rejected: true, reason: 'bad-group' });
    if (!validUserId(selfId)) return makeError('机器人 QQ 无效', { rejected: true, reason: 'bad-self' });
    try {
      const r = await callOneBot('get_group_member_info', { group_id: Number(groupId), user_id: Number(selfId) });
      if (!obOk(r)) return makeError('查询失败：' + ((r && (r.message || r.wording)) || '接口无返回'), { reason: 'api-error' });
      const d = r.data;
      return {
        ok: true,
        group_id: Number(groupId),
        self_id: Number(selfId),
        role: d.role,
        is_group_admin: d.role === 'admin' || d.role === 'owner',
        nickname: d.nickname,
      };
    } catch (e) {
      return makeError('接口调用异常：' + (e && e.message), { reason: 'api-exception' });
    }
  }

  // 单成员角色查询（脱敏）
  async function queryMember(groupId, targetId, userId) {
    const deny = assertAdmin(userId); if (deny) return deny;
    if (!isEnabled()) return makeError('群管功能未启用', { reason: 'disabled' });
    if (!validGroupId(groupId)) return makeError('群号无效', { rejected: true, reason: 'bad-group' });
    if (!validUserId(targetId)) return makeError('目标 QQ 无效', { rejected: true, reason: 'bad-user' });
    try {
      const r = await callOneBot('get_group_member_info', { group_id: Number(groupId), user_id: Number(targetId) });
      if (!obOk(r)) return makeError('查询失败：' + ((r && (r.message || r.wording)) || '接口无返回'), { reason: 'api-error' });
      const m = redactMember(r.data, cfg().memberFields);
      m.group_id = Number(groupId);
      return { ok: true, member: m };
    } catch (e) {
      return makeError('接口调用异常：' + (e && e.message), { reason: 'api-exception' });
    }
  }

  // 群资料查询（不含完整成员名单）
  async function queryGroupProfile(groupId, userId) {
    const deny = assertAdmin(userId); if (deny) return deny;
    if (!isEnabled()) return makeError('群管功能未启用', { reason: 'disabled' });
    if (!validGroupId(groupId)) return makeError('群号无效', { rejected: true, reason: 'bad-group' });
    try {
      const r = await callOneBot('get_group_info', { group_id: Number(groupId) });
      if (!obOk(r)) return makeError('查询失败：' + ((r && (r.message || r.wording)) || '接口无返回'), { reason: 'api-error' });
      const d = r.data;
      const out = { ok: true, group_id: Number(groupId) };
      for (const k of cfg().groupFields) if (k in d) out[k] = d[k];
      return out;
    } catch (e) {
      return makeError('接口调用异常：' + (e && e.message), { reason: 'api-exception' });
    }
  }

  function status() {
    const c = cfg();
    return { enabled: c.enabled === true, apiBase: c.apiBase, protectedRoles: c.protectedRoles, note: '阶段2：仅只读查询，禁用一切写操作' };
  }

  return {
    isEnabled, status,
    queryBotAdminStatus, queryMember, queryGroupProfile,
    // 测试/内部辅助
    _validGroupId: validGroupId, _validUserId: validUserId, _obOk: obOk, _redactMember: redactMember,
  };
}

// ================= 命令解析与执行（供 handleAiCommand 委托，便于单测）=================
// 解析「/ai group ...」命令：仅语法解析，不做权限/接口调用。
function parseGroupCommand(text) {
  const parts = String(text || '').trim().split(/\s+/).filter(Boolean);
  if ((parts[0] || '').toLowerCase() !== '/ai') return { ok: false, reason: 'not-ai' };
  if ((parts[1] || '').toLowerCase() !== 'group') return { ok: false, reason: 'not-group' };
  const sub = (parts[2] || '').toLowerCase();
  const rest = parts.slice(3);
  if (sub === 'help' || sub === '') return { ok: true, sub: 'help', args: [] };
  if (sub === 'status') {
    if (rest.length < 1) return { ok: false, reason: 'bad-args', need: '<群号>' };
    return { ok: true, sub: 'status', args: { groupId: rest[0] } };
  }
  if (sub === 'member') {
    if (rest.length < 2) return { ok: false, reason: 'bad-args', need: '<群号> <QQ号>' };
    return { ok: true, sub: 'member', args: { groupId: rest[0], targetId: rest[1] } };
  }
  if (sub === 'me') {
    if (rest.length < 1) return { ok: false, reason: 'bad-args', need: '<群号>' };
    return { ok: true, sub: 'me', args: { groupId: rest[0] } };
  }
  return { ok: false, reason: 'unknown-sub', sub };
}

function groupHelp() {
  return [
    '【群管查询（只读）】需管理员私聊 /ai 触发，默认未启用。',
    '/ai group status <群号>      查群资料：名称 / 人数 / 上限 / 群主',
    '/ai group member <群号> <QQ> 查单成员：角色 / 昵称 / 名片 / 头衔',
    '/ai group me <群号>          查机器人自身在该群的管理员身份',
    '/ai group help               显示本帮助',
    '说明：不返回完整成员名单；写操作（踢人/禁言/改名片/设管理员）未开放。',
  ].join('\n');
}

function formatResult(title, r, fmt) {
  if (!r.ok) {
    return `【${title}】失败：${r.message || '未知错误'}` + (r.reason ? `（${r.reason}）` : '');
  }
  try {
    return `【${title}】\n` + fmt(r);
  } catch (e) {
    return `【${title}】结果格式化失败：${e.message}`;
  }
}

// 执行「/ai group ...」命令：解析 → 委托模块只读查询 → 格式化脱敏结果。
// 权限（isAdmin）/启用（enabled）/参数/接口状态 全部在模块内校验，这里只做路由与格式化。
async function runGroupCommand(ga, text, ctx) {
  ctx = ctx || {};
  const p = parseGroupCommand(text);
  if (!p.ok) {
    if (p.reason === 'bad-args') return `参数不足：需要 ${p.need}。\n输入 /ai group help 查看用法。`;
    if (p.reason === 'unknown-sub') return `未知群管子命令「${p.sub || ''}」。\n输入 /ai group help 查看用法。`;
    return groupHelp();
  }
  if (p.sub === 'help') return groupHelp();
  const userId = ctx.userId;
  const selfId = ctx.selfId;
  if (p.sub === 'status') {
    const r = await ga.queryGroupProfile(p.args.groupId, userId);
    return formatResult('群资料', r, (d) =>
      `群号=${d.group_id}\n群名=${d.group_name || '-'}\n人数=${d.member_count ?? '-'}/${d.max_member_count ?? '-'}\n群主QQ=${d.owner_id ?? '-'}`);
  }
  if (p.sub === 'member') {
    const r = await ga.queryMember(p.args.groupId, p.args.targetId, userId);
    return formatResult('成员', r, (d) => {
      const m = d.member;
      return `群号=${m.group_id ?? d.group_id ?? '-'}\nQQ=${m.user_id}\n角色=${m.role ?? '-'}\n昵称=${m.nickname || '-'}\n名片=${m.card || '-'}\n头衔=${m.title || '-'}`;
    });
  }
  if (p.sub === 'me') {
    const r = await ga.queryBotAdminStatus(p.args.groupId, selfId, userId);
    return formatResult('机器人身份', r, (d) =>
      `群号=${d.group_id}\n机器人QQ=${d.self_id}\n角色=${d.role ?? '-'}\n是否该群管理员=${d.is_group_admin ? '是' : '否'}\n昵称=${d.nickname || '-'}`);
  }
  return groupHelp();
}

module.exports = { createGroupAdmin, MODULE_DEFAULTS, parseGroupCommand, runGroupCommand, groupHelp };
