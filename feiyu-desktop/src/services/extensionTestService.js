'use strict';
/**
 * extensionTestService.js —— 扩展静态检查与 Dry Run（Feiyu 1.4 模块 5）。
 *
 * 安全铁律：**绝不执行扩展自带的任何脚本/命令**来做静态检查。
 *  - 静态检查：只解析清单、路径、声明字段与权限；对 mcp 类复用 mcpService.reviewServer 做静态安全审查。
 *  - Dry Run：对 workflow 类复用 workflowService.runWorkflow(dryRun=true)（默认只演练，
 *    不真正启动服务/发通知/等待）；对 skill 类复用 skillService.validateSkill；对 mcp 类复用 mcpService.parseConfig。
 *
 * 静态检查与执行测试严格分离。来源/完整性/签名/测试结果分别呈现，绝不互相背书。
 */
const { validateManifest, normalizeRelPath, DENY_FIELDS } = require('./extensionManifest');
const skillService = require('./skillService');
const mcpService = require('./mcpService');
const workflowService = require('./workflowService');

function isObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

/**
 * 静态检查（不触碰任何文件执行）。
 * @param manifest 规范化清单
 * @returns { pass, fail, skip, items:[{name, status:'pass'|'fail'|'skip'|'warn', detail}] }
 */
function staticCheck(manifest) {
  const items = [];
  const push = (name, status, detail) => items.push({ name, status, detail: detail || '' });

  // 1) 清单合法性
  const v = validateManifest(manifest);
  if (v.ok) push('manifest.valid', 'pass', '清单结构合法');
  else items.push({ name: 'manifest.valid', status: 'fail', detail: '校验失败: ' + v.errors.join('；') });

  // 2) 危险字段
  if (manifest && isObject(manifest)) {
    const deny = Object.keys(manifest).filter((k) => DENY_FIELDS.has(k));
    if (deny.length) push('no_dangerous_fields', 'fail', '含危险字段: ' + deny.join(','));
    else push('no_dangerous_fields', 'pass', '无可执行脚本/钩子字段');
  }

  // 3) 文件路径边界
  let pathBad = 0;
  for (const f of (manifest.files || [])) {
    const np = normalizeRelPath(f.path);
    if (!np.ok) { pathBad++; push('path.safe.' + f.path, 'fail', np.error); }
  }
  if (!pathBad) push('paths.contained', 'pass', (manifest.files || []).length + ' 个文件路径均在目录根内');

  // 4) 权限声明合法性
  const unknownPerm = (manifest.permissions || []).filter((p) => typeof p === 'string' ? !KNOWN_PERMS.has(p) : !KNOWN_PERMS.has(p.id));
  if (unknownPerm.length) push('permissions.known', 'warn', '含未知权限声明: ' + unknownPerm.map((p) => (typeof p === 'string' ? p : p.id)).join(','));
  else push('permissions.known', 'pass', '权限声明均在已知目录内');

  // 5) mcp 类：静态安全审查（复用 mcpService.reviewServer）
  if (manifest.type === 'mcp' && manifest.entry && manifest.entry.ref) {
    try {
      const srv = buildServerFromEntry(manifest.entry.ref);
      const r = mcpService.reviewServer(srv);
      push('mcp.review', r.risk === 'high' ? 'warn' : 'pass', '风险等级 ' + r.risk + '；发现 ' + r.findings.length + ' 项');
      for (const f of r.findings) push('mcp.finding.' + f.code, f.level === 'high' ? 'warn' : 'pass', f.message);
    } catch (e) { push('mcp.review', 'skip', '无法审查: ' + e.message); }
  }

  const fail = items.filter((i) => i.status === 'fail').length;
  const skip = items.filter((i) => i.status === 'skip').length;
  const warn = items.filter((i) => i.status === 'warn').length;
  const pass = items.filter((i) => i.status === 'pass').length;
  return { pass, fail, skip, warn, items };
}

/** 把 entry.ref（mcp 服务定义）转成 mcpService.reviewServer 需要的形状。 */
function buildServerFromEntry(ref) {
  if (isObject(ref)) {
    return {
      transport: ref.transport, command: ref.command || (Array.isArray(ref.argv) ? ref.argv[0] : null),
      argv: Array.isArray(ref.argv) ? ref.argv : (typeof ref.command === 'string' ? ref.command.split(/\s+/) : []),
      url: ref.url || null, env: isObject(ref.env) ? ref.env : {},
    };
  }
  return {};
}

/**
 * Dry Run：按类型做模拟执行。
 * @param manifest 规范化清单
 * @param ctx { botDir, fsImpl, adapters:{getWorkflow,getMcp,getSkill} }
 * @returns { ok, dryRun, trace?, items:[{name,status,detail}] }
 */
async function dryRun(manifest, ctx = {}) {
  const fsImpl = ctx.fsImpl || require('fs');
  const botDir = ctx.botDir || '';
  const items = [];
  const push = (name, status, detail) => items.push({ name, status, detail: detail || '' });

  if (manifest.type === 'workflow') {
    const id = manifest.entry && manifest.entry.ref;
    const wf = ctx.adapters && ctx.adapters.getWorkflow ? ctx.adapters.getWorkflow(botDir, id) : (botDir ? readWorkflow(botDir, id, fsImpl) : null);
    if (!wf) { push('workflow.load', 'fail', '找不到工作流 ' + id); return { ok: false, items }; }
    const r = await workflowService.runWorkflow(wf, { dryRun: true, listServices: () => ['noop'] });
    if (r.ok) push('workflow.dryrun', 'pass', '演练通过，轨迹 ' + (r.trace || []).length + ' 步');
    else push('workflow.dryrun', 'fail', (r.error || '演练失败'));
    return { ok: r.ok, dryRun: true, items };
  }

  if (manifest.type === 'skill') {
    const id = manifest.entry && manifest.entry.ref;
    const skill = ctx.adapters && ctx.adapters.getSkill ? ctx.adapters.getSkill(botDir, id) : (botDir ? readSkill(botDir, id, fsImpl) : null);
    if (!skill) { push('skill.load', 'fail', '找不到技能 ' + id); return { ok: false, items }; }
    const rv = skillService.validateSkill(skill);
    if (rv.valid) push('skill.validate', 'pass', '技能校验通过'); else push('skill.validate', 'fail', rv.errors.join('；'));
    return { ok: rv.valid, items };
  }

  if (manifest.type === 'mcp') {
    const ref = manifest.entry && manifest.entry.ref;
    const parsed = mcpService.parseConfig({ mcpServers: { [manifest.name || 'srv']: ref } });
    if (parsed.ok) push('mcp.parse', 'pass', '配置可解析，' + parsed.servers.length + ' 个服务器');
    else push('mcp.parse', 'fail', parsed.errors.join('；'));
    return { ok: parsed.ok, items };
  }

  push('dryrun.skipped', 'skip', '该类型（' + manifest.type + '）暂不支持 Dry Run');
  return { ok: true, items };
}

function readWorkflow(botDir, id, fsImpl) {
  try { const r = workflowService.get(botDir, id, { fsImpl }); return r.ok ? r.workflow : null; } catch (_) { return null; }
}
function readSkill(botDir, id, fsImpl) {
  try { const data = skillService.load(botDir, { fsImpl }); return data.skills.find((s) => s.id === id) || null; } catch (_) { return null; }
}

const KNOWN_PERMS = new Set([
  'ext.meta.read', 'file.read.scoped', 'config.write.scoped', 'network.outbound',
  'process.spawn', 'feiyu.service.call', 'message.send', 'data.modify.business',
]);

module.exports = { staticCheck, dryRun, buildServerFromEntry };
