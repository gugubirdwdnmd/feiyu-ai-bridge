'use strict';
/* personalityTemplateService.test.js —— 人格模板库：CRUD / 复制 / 重命名 / 设当前 /
 * 一致性状态 / 应用（备份+原子写+失败保留）/ 行级 diff。全部用临时目录，不碰真实配置。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const svc = require('../src/services/personalityTemplateService');

function tmpBot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-pt-'));
  fs.writeFileSync(path.join(d, 'ai_prompt.txt'), '默认人格内容', 'utf-8');
  return d;
}

test('save 新建模板并设为当前', () => {
  const d = tmpBot();
  const r = svc.save(d, { name: '毒舌', content: '你很毒舌' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.id);
  const st = svc.status(d);
  assert.strictEqual(st.templates.length, 1);
  assert.strictEqual(st.activeId, r.id);
  assert.strictEqual(st.consistency, 'diverged'); // active 内容 != 当前 ai_prompt.txt
});

test('edit 更新模板保留 id', () => {
  const d = tmpBot();
  const r = svc.save(d, { name: 'A', content: 'x' });
  const r2 = svc.save(d, { id: r.id, name: 'A2', content: 'y' });
  assert.strictEqual(r2.id, r.id);
  assert.strictEqual(svc.load(d).templates[0].name, 'A2');
  assert.strictEqual(svc.load(d).templates[0].content, 'y');
});

test('save 校验：缺 name / content 非字符串', () => {
  const d = tmpBot();
  assert.strictEqual(svc.save(d, { name: '' }).ok, false);
  assert.strictEqual(svc.save(d, { name: 'x', content: 123 }).ok, false);
});

test('copy 复制为新模板', () => {
  const d = tmpBot();
  const r = svc.save(d, { name: 'A', content: 'orig' });
  const c = svc.copy(d, r.id);
  assert.strictEqual(c.ok, true);
  assert.notStrictEqual(c.id, r.id);
  assert.strictEqual(svc.load(d).templates.length, 2);
  assert.strictEqual(svc.load(d).templates[1].content, 'orig');
});

test('rename 修改名称', () => {
  const d = tmpBot();
  const r = svc.save(d, { name: 'A', content: 'x' });
  const c = svc.rename(d, r.id, '新名');
  assert.strictEqual(c.ok, true);
  assert.strictEqual(svc.load(d).templates[0].name, '新名');
});

test('setActive 设置当前模板', () => {
  const d = tmpBot();
  const a = svc.save(d, { name: 'A', content: 'x' });
  const b = svc.save(d, { name: 'B', content: 'y' });
  const r = svc.setActive(d, b.id);
  assert.strictEqual(r.activeId, b.id);
  assert.strictEqual(svc.status(d).activeId, b.id);
});

test('consistency: active 内容===当前生效人格 → match', () => {
  const d = tmpBot();
  const r = svc.save(d, { name: 'A', content: '一致内容' });
  svc.setActive(d, r.id);
  // 把当前生效人格写成与 active 相同
  fs.writeFileSync(path.join(d, 'ai_prompt.txt'), '一致内容', 'utf-8');
  assert.strictEqual(svc.status(d).consistency, 'match');
});

test('consistency: 无模板 → none', () => {
  const d = tmpBot();
  assert.strictEqual(svc.status(d).consistency, 'none');
});

test('apply 备份 ai_prompt.txt 并写入（即时生效），且一致性变 match', () => {
  const d = tmpBot();
  const r = svc.save(d, { name: 'A', content: '应用后的人格' });
  const before = fs.readFileSync(path.join(d, 'ai_prompt.txt'), 'utf-8');
  assert.strictEqual(before, '默认人格内容');
  const ap = svc.apply(d, r.id);
  assert.strictEqual(ap.ok, true);
  assert.ok(ap.backupDir);
  assert.strictEqual(fs.readFileSync(path.join(d, 'ai_prompt.txt'), 'utf-8'), '应用后的人格');
  assert.strictEqual(svc.status(d).consistency, 'match');
  // 备份确实存在且内容为旧值
  const bk = fs.readFileSync(path.join(ap.backupDir, 'ai_prompt.txt'), 'utf-8');
  assert.strictEqual(bk, before);
});

test('apply 失败：原 ai_prompt.txt 保留，返回错误', () => {
  const d = tmpBot();
  const r = svc.save(d, { name: 'A', content: '坏内容' });
  const ap = svc.apply(d, r.id, { writePrompt: () => ({ ok: false, error: '磁盘满' }) });
  assert.strictEqual(ap.ok, false);
  assert.match(ap.error, /原配置已保留/);
  assert.strictEqual(fs.readFileSync(path.join(d, 'ai_prompt.txt'), 'utf-8'), '默认人格内容');
});

test('diff 返回行级差异', () => {
  const d = tmpBot();
  const r = svc.save(d, { name: 'A', content: '行1\n行2\n行3' });
  const df = svc.diff(d, r.id, { target: '行1\n行2改\n行3' });
  assert.strictEqual(df.ok, true);
  const types = df.lines.map((l) => l.type);
  assert.ok(types.includes('-') || types.includes('+')); // 有改动行
  assert.ok(df.lines.some((l) => l.type === ' ' && l.text === '行1')); // 未改动行保留
});

test('remove 删除模板且清理当前标记', () => {
  const d = tmpBot();
  const a = svc.save(d, { name: 'A', content: 'x' });
  const b = svc.save(d, { name: 'B', content: 'y' });
  svc.setActive(d, a.id);
  const r = svc.remove(d, a.id);
  assert.strictEqual(r.ok, true);
  const st = svc.status(d);
  assert.strictEqual(st.templates.length, 1);
  assert.strictEqual(st.activeId, b.id); // 当前标记转移至剩余模板
});

test('remove 不存在 → 失败', () => {
  const d = tmpBot();
  assert.strictEqual(svc.remove(d, 'nope').ok, false);
});
