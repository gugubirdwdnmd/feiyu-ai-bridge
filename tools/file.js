'use strict';
// ================= V14-B：File Tool（复用现有 workspace 沙盒）=================
// 不重新实现路径检查：继续用 ai_bridge 的 workspacePath() / safeFileName()。
// 这里只额外做「入参形状」校验（拒绝绝对路径、盘符、..、反斜杠），
// 真正的越界判定仍由 workspacePath() 负责。
//
// 【权限说明】file_read 定为 LIMITED（不是 SAFE）：
//   虽然它只读、且被关在 D:\NapCat\workspace 里，
//   但文件内容会被注入模型上下文，属于「可被文件间接影响模型行为」的入口
//   （文件里若写着"忽略以上指令"就是提示注入）。因此按 LIMITED 对待，保持保守。
//
// V14-B 明确【不实现】任何删除类工具：file_delete / delete_file / remove_file 都不存在。

const router = require('../agent/tool_router');
const R = require('./result');

// V14-A 的 FORBIDDEN_TOOLS 已包含 delete_file / remove_file，这里再兜一层
const NEVER_NAMES = ['file_delete', 'delete_file', 'remove_file', 'rm_file'];

// 即使有人绕过，也绝不覆盖这些项目文件（它们本来也不在 workspace 里，双保险）
const PROTECTED = new Set([
  'ai_bridge.js', 'ai_config.json', 'ai_prompt.txt', 'napcat.mjs',
  'secrets.json', 'package.json', 'index.js', 'config.json',
]);

// 入参形状校验：只接受「纯文件名」，不接受任何目录语义
function checkName(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n) return { ok: false, error: '文件名为空' };
  if (n.length > 80) return { ok: false, error: '文件名过长' };
  if (/[\\/]/.test(n)) return { ok: false, error: '★只接受纯文件名，不接受路径分隔符（子目录暂不支持）' };
  if (n.indexOf('..') >= 0) return { ok: false, error: '★拒绝 .. 路径穿越' };
  if (/^[a-zA-Z]:/.test(n)) return { ok: false, error: '★拒绝盘符绝对路径' };
  if (/^(windows|system32|program files)/i.test(n)) return { ok: false, error: '★拒绝系统目录名' };
  if (PROTECTED.has(n.toLowerCase())) return { ok: false, error: '★拒绝覆盖项目关键文件' };
  return { ok: true, name: n };
}

function register(deps) {
  const out = [];

  // ---------------- file_list（SAFE）----------------
  if (typeof deps.listFiles === 'function') {
    const r = router.registerTool({
      name: 'file_list',
      description: '列出工作区（D:\\NapCat\\workspace）里已有的文件。只能列工作区，不接受任何路径参数。',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      permission: router.PERMISSION.SAFE,
      timeout: 5000,
      tokenCost: 0,
      riskLevel: 'low',
      handler: async () => {
        const t0 = R.nowMs();
        let list = [];
        try { list = deps.listFiles() || []; } catch (e) { list = []; }
        const ms = R.nowMs() - t0;
        return R.okResult('file_list', { files: list }, '工作区共 ' + list.length + ' 个文件', {
          durationMs: ms, itemCount: list.length,
        });
      },
    });
    if (r.ok) out.push('file_list');
  }

  // ---------------- file_read（LIMITED，理由见文件头）----------------
  if (typeof deps.readFile === 'function') {
    const r = router.registerTool({
      name: 'file_read',
      description:
        '读取工作区里某个文本文件的内容（txt/md/csv/json/html/xml/log 等）。只接受纯文件名，不支持子目录，不接受绝对路径。',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', minLength: 1, maxLength: 80 } },
        required: ['path'],
        additionalProperties: false,
      },
      permission: router.PERMISSION.LIMITED,
      timeout: 8000,
      tokenCost: 1,
      riskLevel: 'low',
      safety: (args) => checkName(args.path),
      handler: async (args) => {
        const t0 = R.nowMs();
        const res = deps.readFile(args.path);
        const ms = R.nowMs() - t0;
        if (!res || res.ok !== true) {
          return R.failResult('file_read', (res && res.error) || '读取失败', false, { durationMs: ms });
        }
        return R.okResult(
          'file_read',
          { name: res.name || args.path, text: res.text, size: res.size, truncated: !!res.truncated },
          String(res.text || '').slice(0, 220),
          { durationMs: ms, itemCount: 1 }
        );
      },
    });
    if (r.ok) out.push('file_read');
  }

  // ---------------- file_write（LIMITED）----------------
  if (typeof deps.writeFile === 'function') {
    const r = router.registerTool({
      name: 'file_write',
      description:
        '在工作区里新建一个文本文件（txt/md/csv/json/html 等）。只接受纯文件名；二进制扩展名会被拒绝；有大小上限。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 80 },
          content: { type: 'string', minLength: 1 },
        },
        required: ['name', 'content'],
        additionalProperties: false,
      },
      permission: router.PERMISSION.LIMITED,
      timeout: 8000,
      tokenCost: 1,
      riskLevel: 'low',
      safety: (args) => {
        const c = checkName(args.name);
        if (!c.ok) return c;
        if (typeof deps.isWritableName === 'function' && !deps.isWritableName(c.name)) {
          return { ok: false, error: '★扩展名不允许写入（二进制/表格类文件请用 create_table 工具）' };
        }
        return { ok: true };
      },
      handler: async (args) => {
        const t0 = R.nowMs();
        const buf = Buffer.from(String(args.content), 'utf-8');
        const res = deps.writeFile(args.name, buf);
        const ms = R.nowMs() - t0;
        if (!res || res.ok !== true) {
          return R.failResult('file_write', (res && res.msg) || '写入失败', false, { durationMs: ms });
        }
        return R.okResult('file_write', { name: res.name, size: res.size }, '已写入 ' + res.name, {
          durationMs: ms, itemCount: 1,
        });
      },
    });
    if (r.ok) out.push('file_write');
  }

  return out;
}

module.exports = { register, checkName, PROTECTED, NEVER_NAMES };
