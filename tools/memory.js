'use strict';
// ================= V14-B：Memory Tool =================
// 两类记忆严格分开：
//   长期记忆 = notes.json（模型主动 remember 记下的）
//   短期上下文 = sessions.json（当前会话最近几轮对话）
// 不要把两者混在一起返回。
//
// memory_write 比 memory_search 严格得多：
//   只有「用户明确要求记住」才允许写；普通闲聊一律 REJECT；
//   任何试图改写系统规则 / 权限 / 配置的记忆一律 REJECT。

const router = require('../agent/tool_router');
const R = require('./result');

// 明确的记忆请求信号
const EXPLICIT_RE =
  /(记住|记一下|记着|帮我记|别忘了|以后叫我|以后就叫我|以后.*?叫我|我叫.{1,10}(就好|就行|就可以)|我的名字是|叫我|记牢)/;

// 涉及系统规则 / 权限 / 配置的记忆：永远拒绝
const DANGER_RE =
  /(CMD|cmd|PowerShell|powershell|shell|bash|执行(命令|指令)|运行(程序|命令)|打开(文件|程序|文件夹)|删除(文件|目录)|格式化|注册表|registry|sudo|管理员权限|最高权限)/i;
const SYSTEM_RULE_RE =
  /(系统提示|system\s*prompt|提示词|prompt|规则|策略|policy|权限|permission|配置|config|API\s*Key|apikey|sk-|密钥|忽略(之前|上面|所有)(的)?(规则|指令|设定)|你现在是|从现在起你是|解除.{0,4}(限制|约束)|绕过.{0,4}(限制|规则)|越狱|jailbreak)/i;

// 明显的一次性闲聊（即使带了"记"字也很可能是口误，保守起见单独列出来做二次校验）
const CHITCHAT_RE = /(今天(吃|喝|去|玩|看|买)|刚才|现在在|我在(打|玩|看|吃))/;

/**
 * 写入闸门。返回 { ok, reason }
 */
function gateWrite(content, userText) {
  const c = String(content == null ? '' : content);
  const u = String(userText == null ? '' : userText);
  const both = u + ' ' + c;

  if (!c.trim()) return { ok: false, reason: '内容为空' };
  if (DANGER_RE.test(both)) return { ok: false, reason: '★涉及系统/命令/权限，拒绝写入长期记忆' };
  if (SYSTEM_RULE_RE.test(both)) return { ok: false, reason: '★涉及系统规则/提示词/权限/密钥，拒绝写入长期记忆' };
  if (!EXPLICIT_RE.test(both)) return { ok: false, reason: '★用户没有明确要求记住，拒绝写入（普通闲聊不进长期记忆）' };
  // 明确要求 + 但内容是纯闲聊 → 仍然拒绝（例如"记住我今天吃了火锅"）
  if (!EXPLICIT_RE.test(u) && CHITCHAT_RE.test(c)) {
    return { ok: false, reason: '★内容是一次性闲聊，拒绝写入' };
  }
  return { ok: true, reason: 'explicit-request' };
}

function register(deps) {
  const out = [];

  // ---------------- memory_search（SAFE）----------------
  if (typeof deps.getNotes === 'function') {
    const r = router.registerTool({
      name: 'memory_search',
      description:
        '在记忆里查找与当前会话相关的信息。返回时严格区分「长期记忆（notes）」和「短期上下文（最近对话）」，不要混为一谈。',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', minLength: 1, maxLength: 100 } },
        required: ['query'],
        additionalProperties: false,
      },
      permission: router.PERMISSION.SAFE,
      timeout: 5000,
      tokenCost: 0,
      riskLevel: 'low',
      handler: async (args, ctx) => {
        const t0 = R.nowMs();
        const sid = ctx.sessionId || '';
        const q = String(args.query || '').trim();
        let longTerm = [];
        try { longTerm = deps.getNotes(sid) || []; } catch (e) { longTerm = []; }
        const hitLong = q
          ? longTerm.filter((x) => String(x).indexOf(q) >= 0)
          : longTerm.slice();

        let shortTerm = [];
        if (typeof deps.getShortTerm === 'function') {
          try { shortTerm = deps.getShortTerm(sid) || []; } catch (e) { shortTerm = []; }
        }
        const hitShort = q
          ? shortTerm.filter((x) => String(x).indexOf(q) >= 0)
          : shortTerm.slice(-6);

        const ms = R.nowMs() - t0;
        const itemCount = hitLong.length + hitShort.length;
        const summary =
          '长期记忆命中 ' + hitLong.length + ' 条；短期上下文命中 ' + hitShort.length + ' 条';
        return R.okResult(
          'memory_search',
          {
            query: q,
            longTerm: hitLong.slice(-20),     // notes.json：长期记忆
            shortTerm: hitShort.slice(-10),   // sessions.json：短期上下文
            longTermTotal: longTerm.length,
            shortTermTotal: shortTerm.length,
          },
          summary,
          { durationMs: ms, itemCount }
        );
      },
    });
    if (r.ok) out.push('memory_search');
  }

  // ---------------- memory_write（LIMITED，严格）----------------
  if (typeof deps.rememberNote === 'function') {
    const r = router.registerTool({
      name: 'memory_write',
      description:
        '把值得长期记住的信息写进长期记忆。只在对方「明确要求记住」时使用（名字/称呼/喜好/约定/长期事实）。普通闲聊一律不要调用。',
      inputSchema: {
        type: 'object',
        properties: { content: { type: 'string', minLength: 2, maxLength: 200 } },
        required: ['content'],
        additionalProperties: false,
      },
      permission: router.PERMISSION.LIMITED,
      timeout: 5000,
      tokenCost: 0,
      riskLevel: 'low',
      safety: (args, ctx) => {
        const userText = (ctx && ctx.input && ctx.input.text) || '';
        const g = gateWrite(args.content, userText);
        return g.ok ? { ok: true } : { ok: false, error: g.reason };
      },
      handler: async (args, ctx) => {
        const t0 = R.nowMs();
        const sid = ctx.sessionId || '';
        const res = deps.rememberNote(sid, args.content);
        const s = String(res == null ? '' : res);
        const ms = R.nowMs() - t0;
        if (/^(没记住|这条已经记过了)/.test(s)) {
          return R.failResult('memory_write', s, false, { durationMs: ms });
        }
        return R.okResult('memory_write', { content: args.content, reply: s }, s.slice(0, 200), {
          durationMs: ms, itemCount: 1,
        });
      },
    });
    if (r.ok) out.push('memory_write');
  }

  return out;
}

module.exports = { register, gateWrite, EXPLICIT_RE, DANGER_RE, SYSTEM_RULE_RE, CHITCHAT_RE };
