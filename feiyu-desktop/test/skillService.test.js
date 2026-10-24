'use strict';
/**
 * skillService.test.js —— 桌面端技能库管理测试。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const skillService = require('../src/services/skillService');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skill-svc-'));
}

test('list: 空目录返回空技能列表', () => {
  const d = tmpDir();
  const r = skillService.list(d);
  assert.strictEqual(r.skills.length, 0);
  assert.strictEqual(r.enabledCount, 0);
  assert.strictEqual(r.invalidCount, 0);
  assert.ok(r.allowedHandlers.includes('generate_image'));
  fs.rmSync(d, { recursive: true, force: true });
});

test('save: 新建技能成功并落盘', () => {
  const d = tmpDir();
  const r = skillService.save(d, { name: '甲', description: '说明', prompt: 'p' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.id);
  const reread = skillService.list(d);
  assert.strictEqual(reread.skills.length, 1);
  assert.strictEqual(reread.skills[0].name, '甲');
  assert.strictEqual(reread.enabledCount, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('save: 非法 handler 被拒（技能不能执行自定义代码）', () => {
  const d = tmpDir();
  const r = skillService.save(d, { name: 'x', tools: [{ name: 'evil', handler: 'exec_shell' }] });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('允许清单')));
  assert.strictEqual(skillService.list(d).skills.length, 0, '非法技能不应写入');
  fs.rmSync(d, { recursive: true, force: true });
});

test('save: 更新时未传的字段保留原值', () => {
  const d = tmpDir();
  const a = skillService.save(d, { name: '甲', description: '原描述', prompt: '原提示' });
  const b = skillService.save(d, { id: a.id, name: '甲改名' });
  assert.strictEqual(b.ok, true);
  const s = skillService.list(d).skills[0];
  assert.strictEqual(s.name, '甲改名');
  assert.strictEqual(s.description, '原描述', '未传字段应保留');
  assert.strictEqual(s.prompt, '原提示');
  fs.rmSync(d, { recursive: true, force: true });
});

test('save: keyword 模式缺关键词被拒', () => {
  const d = tmpDir();
  const r = skillService.save(d, { name: 'x', trigger: { mode: 'keyword', keywords: [] } });
  assert.strictEqual(r.ok, false);
  fs.rmSync(d, { recursive: true, force: true });
});

test('remove: 删除技能', () => {
  const d = tmpDir();
  const a = skillService.save(d, { name: '甲' });
  const r = skillService.remove(d, a.id);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(skillService.list(d).skills.length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('remove: 删除不存在的技能返回错误', () => {
  const d = tmpDir();
  const r = skillService.remove(d, 'nope');
  assert.strictEqual(r.ok, false);
  fs.rmSync(d, { recursive: true, force: true });
});

test('copy: 复制技能并生成新 id', () => {
  const d = tmpDir();
  const a = skillService.save(d, { name: '甲', prompt: 'p' });
  const r = skillService.copy(d, a.id);
  assert.strictEqual(r.ok, true);
  assert.notStrictEqual(r.id, a.id);
  assert.ok(r.skill.name.includes('副本'));
  assert.strictEqual(skillService.list(d).skills.length, 2);
  fs.rmSync(d, { recursive: true, force: true });
});

test('setEnabled: 启用/停用切换', () => {
  const d = tmpDir();
  const a = skillService.save(d, { name: '甲' });
  assert.strictEqual(skillService.setEnabled(d, a.id, false).enabled, false);
  assert.strictEqual(skillService.list(d).enabledCount, 0);
  assert.strictEqual(skillService.setEnabled(d, a.id, true).enabled, true);
  assert.strictEqual(skillService.list(d).enabledCount, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('builtinTemplates: 内置模板均通过本校验', () => {
  for (const t of skillService.builtinTemplates()) {
    const v = skillService.validateSkill(Object.assign({ id: 'x_' + t.key }, t.skill));
    assert.strictEqual(v.valid, true, t.key + ': ' + v.errors.join('；'));
  }
});

test('importTemplate: 导入内置模板成功', () => {
  const d = tmpDir();
  const r = skillService.importTemplate(d, 'draw_helper');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(skillService.list(d).skills.length, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('importTemplate: 同名不重复导入（幂等）', () => {
  const d = tmpDir();
  assert.strictEqual(skillService.importTemplate(d, 'draw_helper').ok, true);
  const second = skillService.importTemplate(d, 'draw_helper');
  assert.strictEqual(second.ok, false);
  assert.strictEqual(skillService.list(d).skills.length, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('importTemplate: 未知模板 key 返回错误', () => {
  const d = tmpDir();
  const r = skillService.importTemplate(d, 'not_exist');
  assert.strictEqual(r.ok, false);
  fs.rmSync(d, { recursive: true, force: true });
});

test('exportAll / importAll: 往返一致，id 冲突重新分配', () => {
  const d = tmpDir();
  skillService.save(d, { name: '甲', prompt: 'p' });
  const exp = skillService.exportAll(d);
  assert.strictEqual(exp.ok, true);
  assert.strictEqual(exp.skills.length, 1);

  const d2 = tmpDir();
  const imp = skillService.importAll(d2, exp);
  assert.strictEqual(imp.ok, true);
  assert.strictEqual(imp.added, 1);
  assert.strictEqual(skillService.list(d2).skills.length, 1);

  // 再次导入到同一目录：id 冲突应重新分配而非覆盖
  const imp2 = skillService.importAll(d2, exp);
  assert.strictEqual(imp2.ok, true);
  assert.strictEqual(skillService.list(d2).skills.length, 2, 'id 冲突应新增而非覆盖');
  fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(d2, { recursive: true, force: true });
});

test('importAll: 无效技能被跳过', () => {
  const d = tmpDir();
  const r = skillService.importAll(d, { skills: [{ id: 'ok', name: '好的' }, { id: 'bad', name: '', tools: [{ name: 'x', handler: 'evil_cmd' }] }] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.added, 1);
  assert.strictEqual(r.skipped, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('restoreFromBackup: 回滚恢复注册表', () => {
  const d = tmpDir();
  const a = skillService.save(d, { name: '原技能' });
  const backup = path.join(d, 'backup.json');
  fs.writeFileSync(backup, fs.readFileSync(skillService.skillsPath(d), 'utf-8'));
  skillService.save(d, { name: '新增技能' });
  assert.strictEqual(skillService.list(d).skills.length, 2);
  const r = skillService.restoreFromBackup(d, backup);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(skillService.list(d).skills.length, 1);
  assert.strictEqual(skillService.list(d).skills[0].id, a.id);
  fs.rmSync(d, { recursive: true, force: true });
});

test('restoreFromBackup: 备份文件损坏时返回错误且不破坏现有数据', () => {
  const d = tmpDir();
  skillService.save(d, { name: '甲' });
  const bad = path.join(d, 'bad.json');
  fs.writeFileSync(bad, '{ broken');
  const r = skillService.restoreFromBackup(d, bad);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(skillService.list(d).skills.length, 1, '现有数据不应被破坏');
  fs.rmSync(d, { recursive: true, force: true });
});

test('list: 手工写入的无效技能被标出 invalid', () => {
  const d = tmpDir();
  fs.writeFileSync(skillService.skillsPath(d), JSON.stringify({
    version: 1,
    skills: [{ id: 'bad', name: '坏的', tools: [{ name: 'x', handler: 'evil_cmd' }] }],
  }));
  const r = skillService.list(d);
  assert.strictEqual(r.invalidCount, 1);
  assert.strictEqual(r.skills[0].valid, false);
  assert.ok(r.skills[0].errors.length > 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('save: 超过数量上限被拒', () => {
  const d = tmpDir();
  for (let i = 0; i < skillService.MAX_SKILLS; i++) {
    assert.strictEqual(skillService.save(d, { name: '技能' + i }).ok, true);
  }
  const over = skillService.save(d, { name: '超了' });
  assert.strictEqual(over.ok, false);
  fs.rmSync(d, { recursive: true, force: true });
});

test('桌面侧 ALLOWED_HANDLERS 与机器人侧一致', () => {
  const botSkills = require('../../skills');
  const bot = Array.from(botSkills.ALLOWED_HANDLERS).sort();
  const desk = skillService.ALLOWED_HANDLERS.slice().sort();
  assert.deepStrictEqual(desk, bot, '两侧白名单必须一致，否则桌面能存的技能机器人会拒收');
});
