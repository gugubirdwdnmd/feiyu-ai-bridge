'use strict';
/**
 * skills.test.js —— 机器人侧技能运行时（skills.js）单元测试。
 * 纯 Node，无 Electron 依赖；用临时目录做文件读写验证。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const skills = require('../../skills');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));
}

test('validateSkill: 合法技能通过', () => {
  const v = skills.validateSkill({
    id: 's1', name: '测试', enabled: true,
    trigger: { mode: 'keyword', keywords: ['画'] },
    prompt: '说明',
    tools: [{ name: 'draw', handler: 'generate_image', description: '画图' }],
  });
  assert.strictEqual(v.valid, true, JSON.stringify(v.errors));
  assert.strictEqual(v.errors.length, 0);
});

test('validateSkill: 缺少 id/name 报错', () => {
  const v = skills.validateSkill({});
  assert.strictEqual(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes('id')));
  assert.ok(v.errors.some((e) => e.includes('name')));
});

test('validateSkill: handler 不在白名单被拒（不允许技能执行自定义代码）', () => {
  const v = skills.validateSkill({
    id: 's1', name: 'x',
    tools: [{ name: 'evil', handler: 'exec_shell' }],
  });
  assert.strictEqual(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes('允许清单')));
});

test('validateSkill: 越界的 prompt 长度被拒', () => {
  const v = skills.validateSkill({ id: 's1', name: 'x', prompt: 'a'.repeat(5000) });
  assert.strictEqual(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes('上限')));
});

test('validateSkill: keyword 模式必须有关键词', () => {
  const v = skills.validateSkill({ id: 's1', name: 'x', trigger: { mode: 'keyword', keywords: [] } });
  assert.strictEqual(v.valid, false);
});

test('validateSkill: 非法 trigger.mode 被拒', () => {
  const v = skills.validateSkill({ id: 's1', name: 'x', trigger: { mode: 'whenever' } });
  assert.strictEqual(v.valid, false);
});

test('loadSkills: 文件不存在返回空列表且不抛错', () => {
  const d = tmpDir();
  const r = skills.loadSkills(d);
  assert.deepStrictEqual(r.skills, []);
  assert.strictEqual(r.exists, false);
  fs.rmSync(d, { recursive: true, force: true });
});

test('loadSkills: JSON 损坏时返回错误而不抛异常', () => {
  const d = tmpDir();
  fs.writeFileSync(skills.skillsPath(d), '{ broken json');
  const r = skills.loadSkills(d);
  assert.deepStrictEqual(r.skills, []);
  assert.ok(r.errors.length > 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('loadSkills: 无效技能被剔除且记录原因', () => {
  const d = tmpDir();
  fs.writeFileSync(skills.skillsPath(d), JSON.stringify({
    version: 1,
    skills: [
      { id: 'ok1', name: '好的' },
      { id: 'bad1', name: '坏的', tools: [{ name: 'x', handler: 'rm_rf' }] },
    ],
  }));
  const r = skills.loadSkills(d);
  assert.strictEqual(r.skills.length, 1);
  assert.strictEqual(r.skills[0].id, 'ok1');
  assert.ok(r.errors.some((e) => e.includes('bad1')));
  fs.rmSync(d, { recursive: true, force: true });
});

test('saveSkills + loadSkills: 往返一致', () => {
  const d = tmpDir();
  const w = skills.saveSkills(d, [{ id: 'a', name: '甲', enabled: true, prompt: 'p' }]);
  assert.strictEqual(w.ok, true);
  const r = skills.loadSkills(d);
  assert.strictEqual(r.skills.length, 1);
  assert.strictEqual(r.skills[0].name, '甲');
  fs.rmSync(d, { recursive: true, force: true });
});

test('matches: always 模式始终命中', () => {
  const s = skills.normalizeSkill({ id: 'a', name: '甲', trigger: { mode: 'always' } });
  assert.strictEqual(skills.matches(s, '随便什么'), true);
  assert.strictEqual(skills.matches(s, ''), true);
});

test('matches: keyword 模式只在命中关键词时生效（大小写不敏感）', () => {
  const s = skills.normalizeSkill({ id: 'a', name: '甲', trigger: { mode: 'keyword', keywords: ['画图', '生图'] } });
  assert.strictEqual(skills.matches(s, '帮我画图'), true);
  assert.strictEqual(skills.matches(s, '帮我生图'), true);
  assert.strictEqual(skills.matches(s, '画图一下'), true);
  assert.strictEqual(skills.matches(s, '今天天气不错'), false);
  assert.strictEqual(skills.matches(s, ''), false);
});

test('matches: 停用的技能不命中', () => {
  const s = skills.normalizeSkill({ id: 'a', name: '甲', enabled: false, trigger: { mode: 'always' } });
  assert.strictEqual(skills.matches(s, '任意'), false);
});

test('renderSkillPrompt: 命中时注入技能块，未命中返回空串', () => {
  const list = [skills.normalizeSkill({ id: 'a', name: '画图助手', trigger: { mode: 'keyword', keywords: ['画'] }, prompt: '先描述再画' })];
  const hit = skills.renderSkillPrompt(list, '帮我画一个');
  assert.ok(hit.includes('画图助手'));
  assert.ok(hit.includes('先描述再画'));
  const miss = skills.renderSkillPrompt(list, '聊聊天');
  assert.strictEqual(miss, '');
});

test('renderSkillPrompt: 无 prompt 的技能不产生注入块', () => {
  const list = [skills.normalizeSkill({ id: 'a', name: '空技能', trigger: { mode: 'always' }, prompt: '' })];
  assert.strictEqual(skills.renderSkillPrompt(list, '任意'), '');
});

test('skillToolDefs: 只输出命中技能的工具且为 function calling 形状', () => {
  const list = [skills.normalizeSkill({
    id: 'a', name: '画图', trigger: { mode: 'keyword', keywords: ['画'] },
    tools: [{ name: 'draw_pic', handler: 'generate_image', description: '画一张', parameters: { type: 'object', properties: {} } }],
  })];
  const defs = skills.skillToolDefs(list, '帮我画');
  assert.strictEqual(defs.length, 1);
  assert.strictEqual(defs[0].type, 'function');
  assert.strictEqual(defs[0].function.name, 'draw_pic');
  assert.strictEqual(defs[0].function.description, '画一张');
  assert.ok(defs[0].function.parameters);
  assert.deepStrictEqual(skills.skillToolDefs(list, '不相关'), []);
});

test('skillToolDefs: 未命中时不挂任何工具', () => {
  const list = [skills.normalizeSkill({
    id: 'a', name: 'x', trigger: { mode: 'keyword', keywords: ['画'] },
    tools: [{ name: 'draw_pic', handler: 'generate_image' }],
  })];
  assert.strictEqual(skills.skillToolDefs(list, '无关内容').length, 0);
});

test('skillHandlerMap: 工具名映射到内置 handler', () => {
  const list = [skills.normalizeSkill({
    id: 'a', name: 'x', trigger: { mode: 'always' },
    tools: [{ name: 'my_draw', handler: 'generate_image' }],
  })];
  const m = skills.skillHandlerMap(list, '任意');
  assert.strictEqual(m.my_draw, 'generate_image');
});

test('skillHandlerMap: 白名单外的 handler 不进映射（双保险）', () => {
  // 绕过 validateSkill 直接构造，模拟注册表被手工篡改
  const list = [{ id: 'a', name: 'x', enabled: true, trigger: { mode: 'always', keywords: [] }, prompt: '', tools: [{ name: 'evil', handler: 'exec_shell' }] }];
  const m = skills.skillHandlerMap(list, '任意');
  assert.strictEqual(m.evil, undefined);
  assert.deepStrictEqual(skills.skillToolDefs(list, '任意'), []);
});

test('ALLOWED_HANDLERS 不包含会写用户记忆的 remember 工具', () => {
  assert.ok(!skills.ALLOWED_HANDLERS.has('remember'));
});

test('saveSkills: 原子写入，不留 .tmp 残留', () => {
  const d = tmpDir();
  skills.saveSkills(d, [{ id: 'a', name: '甲' }]);
  const leftovers = fs.readdirSync(d).filter((f) => f.includes('.tmp.'));
  assert.deepStrictEqual(leftovers, []);
  fs.rmSync(d, { recursive: true, force: true });
});
