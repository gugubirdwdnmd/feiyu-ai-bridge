'use strict';
/**
 * backupService.test.js —— 模块 G（备份 / 恢复 / 升级保护）单测。
 * 全部在临时目录内进行，绝不触碰真实机器人目录。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bk = require('../src/services/backupService');

function makeBot(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-bak-'));
  for (const [name, content] of Object.entries(files || { 'ai_config.json': '{"a":1}' })) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('createBackup: 默认不包含密钥文件', () => {
  const dir = makeBot({ 'ai_config.json': '{"a":1}', 'secrets.json': '{"apiKey":"SECRET"}' });
  try {
    const r = bk.createBackup(dir, { label: 't1' });
    assert.strictEqual(r.ok, true);
    const man = bk.readManifest(dir, r.id).manifest;
    assert.strictEqual(man.includeSecret, false);
    assert.deepStrictEqual(man.files.map((f) => f.name), ['ai_config.json']);
    assert.deepStrictEqual(man.excluded, bk.SECRET_FILES);
    // 备份目录里确实没有密钥文件
    assert.strictEqual(fs.existsSync(path.join(dir, bk.BACKUP_ROOT, r.id, 'secrets.json')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('createBackup: includeSecret=true 时才备份密钥并标记', () => {
  const dir = makeBot({ 'ai_config.json': '{}', 'secrets.json': '{"apiKey":"SECRET"}' });
  try {
    const r = bk.createBackup(dir, { includeSecret: true });
    const man = bk.readManifest(dir, r.id).manifest;
    assert.strictEqual(man.includeSecret, true);
    assert.ok(man.files.some((f) => f.name === 'secrets.json'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('listBackups: 列出自建备份并带文件数', () => {
  const dir = makeBot();
  try {
    bk.createBackup(dir, { now: new Date('2026-01-01T00:00:01Z') });
    bk.createBackup(dir, { now: new Date('2026-01-02T00:00:01Z') });
    const r = bk.listBackups(dir);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.backups.length, 2);
    assert.ok(r.backups[0].fileCount >= 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('diffBackup: 区分 changed / same / added', () => {
  const dir = makeBot({ 'ai_config.json': '{"a":1}', 'ai_prompt.txt': 'old' });
  try {
    const r = bk.createBackup(dir, { now: new Date('2026-02-01T00:00:00Z') });
    fs.writeFileSync(path.join(dir, 'ai_config.json'), '{"a":2}');
    const d = bk.diffBackup(dir, r.id);
    assert.strictEqual(d.ok, true);
    const byName = Object.fromEntries(d.files.map((f) => [f.name, f.status]));
    assert.strictEqual(byName['ai_config.json'], 'changed');
    assert.strictEqual(byName['ai_prompt.txt'], 'same');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('diffBackup: 备份含密钥时给出警告', () => {
  const dir = makeBot({ 'ai_config.json': '{}', 'secrets.json': '{"k":"v"}' });
  try {
    const r = bk.createBackup(dir, { includeSecret: true });
    const d = bk.diffBackup(dir, r.id);
    assert.ok(d.warnings.some((w) => w.includes('密钥')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('restoreBackup: 恢复被修改的文件，并生成 pre-restore 快照', () => {
  const dir = makeBot({ 'ai_config.json': '{"a":1}' });
  try {
    const r = bk.createBackup(dir, { now: new Date('2026-03-01T00:00:00Z') });
    fs.writeFileSync(path.join(dir, 'ai_config.json'), '{"a":999}');
    const res = bk.restoreBackup(dir, r.id, { now: new Date('2026-03-02T00:00:00Z') });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'ai_config.json'), 'utf-8')).a, 1);
    assert.ok(res.preRestoreId, '应生成恢复前快照');
    // 快照里保存的是恢复前的 999
    const snap = JSON.parse(fs.readFileSync(path.join(dir, bk.BACKUP_ROOT, res.preRestoreId, 'ai_config.json'), 'utf-8'));
    assert.strictEqual(snap.a, 999);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('restoreBackup: 已一致时 noop（除非 force）', () => {
  const dir = makeBot({ 'ai_config.json': '{"a":1}' });
  try {
    const r = bk.createBackup(dir, { now: new Date('2026-04-01T00:00:00Z') });
    const res = bk.restoreBackup(dir, r.id);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.noop, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('restoreBackup: includeSecret=false 时跳过备份中的密钥文件', () => {
  const dir = makeBot({ 'ai_config.json': '{"a":1}', 'secrets.json': '{"apiKey":"BACKED"}' });
  try {
    const r = bk.createBackup(dir, { includeSecret: true, now: new Date('2026-05-01T00:00:00Z') });
    fs.writeFileSync(path.join(dir, 'ai_config.json'), '{"a":5}');
    fs.writeFileSync(path.join(dir, 'secrets.json'), '{"apiKey":"CURRENT"}');
    const res = bk.restoreBackup(dir, r.id, { includeSecret: false });
    assert.strictEqual(res.ok, true);
    assert.ok(res.skipped.some((s) => s.name === 'secrets.json' && s.reason === 'secret_excluded'));
    // 密钥保持当前值，未被备份里的旧值覆盖
    assert.ok(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf-8').includes('CURRENT'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('isValidId / resolveBackupDir: 拒绝路径穿越', () => {
  assert.strictEqual(bk.isValidId('bak-20260101-000000-000'), true);
  assert.strictEqual(bk.isValidId('../evil'), false);
  assert.strictEqual(bk.isValidId('bak-../../x'), false);
  const dir = makeBot();
  try {
    assert.strictEqual(bk.resolveBackupDir(dir, '../escape'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('deleteBackup: 只删备份，不动 bot 目录本体', () => {
  const dir = makeBot({ 'ai_config.json': '{"a":1}' });
  try {
    const r = bk.createBackup(dir);
    assert.strictEqual(bk.deleteBackup(dir, r.id).ok, true);
    assert.strictEqual(fs.existsSync(path.join(dir, 'ai_config.json')), true);
    assert.strictEqual(bk.listBackups(dir).backups.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('createBackup: 没有可备份文件时给出提示而不是失败', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feiyu-bak-empty-'));
  try {
    const r = bk.createBackup(dir);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.fileCount, 0);
    assert.ok(r.note);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
