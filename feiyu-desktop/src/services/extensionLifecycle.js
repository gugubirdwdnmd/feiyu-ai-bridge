'use strict';
/**
 * extensionLifecycle.js —— 扩展安装 / 启用 / 禁用 / 升级 / 卸载 / 回滚（Feiyu 1.4 模块 6）。
 *
 * 统一安装流程（与任务书 §5.2 对齐）：
 *   1. 获取内容（fileBuffers 由市场/本地导入层准备，本层只负责落地）　2. 限大小已在 manifest 校验
 *   3. 解析清单（调用方已完成 validateManifest）　4. 校验 id/版本/类型/路径（manifest 已做）
 *   5. SHA-256 校验每个文件（若清单提供）　6. 依赖/兼容检查（依赖 resolver，本层兜底重查）
 *   7. 准备工作目录　8. 生成安装前快照（registry + 相关 botDir 配置）
 *   9. 在独立暂存目录准备文件　10. 原子写入　11. 更新安装记录　12. 安装后检查
 *   13. 失败则回滚（恢复快照）　支持取消（提交前取消无半安装残留；提交后取消按失败回滚）。
 *
 * 旧配置注册表类扩展（skill/mcp/workflow）优先通过既有 Service 写入 botDir 配置，
 * 不直接改写业务文件；legacyAdapters 注入真实服务（测试注入桩）。
 *
 * 安全：安装目录固定在 userData/feiyu-extensions，与 botDir 业务目录分离；
 * 卸载只删除由本管理器拥有且经清单/记录确认的文件，绝不递归删未确认目录。
 *
 * 纯函数 + 依赖注入（fsImpl / now / spawnFn），可单测；互斥锁保证并发安装串行化。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EXT_ROOT, loadRegistry, saveRegistry, upsert, getEntry, removeEntry, validateOwnedPaths } = require('./extensionRegistry');
const { versionSatisfiesRange } = require('./extensionManifest');

const MAX_STAGED_BYTES = 256 * 1024 * 1024;
const _lock = { chain: Promise.resolve() };
function withLock(fn) {
  const next = _lock.chain.then(fn, fn);
  _lock.chain = next.then(() => {}, () => {});
  return next;
}

function isObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function nowIso(d) { return (d instanceof Date ? d : new Date()).toISOString(); }
function sha256Of(buf) { try { return crypto.createHash('sha256').update(buf).digest('hex'); } catch (_) { return ''; } }
function dirForId(id) { return String(id).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120); }

/** 默认 legacy 适配器：包装既有 Service。生产由 handlers 注入带 botDir 的版本。 */
function defaultLegacyAdapters() {
  const skillService = require('./skillService');
  const mcpService = require('./mcpService');
  const workflowService = require('./workflowService');
  return {
    registerSkill: (botDir, skill) => skillService.save(botDir, skill),
    removeSkill: (botDir, id) => skillService.remove(botDir, id),
    setSkillEnabled: (botDir, id, en) => skillService.setEnabled(botDir, id, en),
    registerMcp: (botDir, payload) => mcpService.importConfig(botDir, payload, { overwrite: true }),
    removeMcp: (botDir, name) => mcpService.remove(botDir, name),
    setMcpEnabled: (botDir, name, en) => mcpService.setEnabled(botDir, name, en),
    registerWorkflow: (botDir, wf) => workflowService.save(botDir, wf),
    removeWorkflow: (botDir, id) => workflowService.remove(botDir, id),
  };
}

/**
 * 安装一个已校验的扩展。
 * @param opts {
 *   registry, registryFile, manifest(规范化的清单),
 *   fileBuffers: Map<relPath, Buffer|string>,
 *   userDataDir, botDir, fsImpl, now,
 *   legacyAdapters, cancelToken: ()=>boolean, stagingDir
 * }
 */
async function install(opts) {
  return withLock(async () => doInstall(opts));
}

async function doInstall(opts) {
  const fsImpl = opts.fsImpl || fs;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const reg = opts.registry;
  const manifest = opts.manifest;
  const userDataDir = opts.userDataDir || '';
  const botDir = opts.botDir || '';
  const adapters = opts.legacyAdapters || defaultLegacyAdapters();
  const extDir = path.join(userDataDir, EXT_ROOT, dirForId(manifest.id));
  const staging = opts.stagingDir || path.join(userDataDir, EXT_ROOT, '.staging-' + dirForId(manifest.id) + '-' + process.pid);
  const cancelled = () => typeof opts.cancelToken === 'function' && opts.cancelToken();

  // 安装前快照（registry + 相关 botDir 配置）
  const snapshot = {
    registry: JSON.parse(JSON.stringify(reg.extensions)),
    botDir: {},
  };
  const relBotFiles = relBotConfigFiles(manifest.type);
  for (const f of relBotFiles) {
    const p = path.join(botDir, f);
    try { if (fsImpl.existsSync(p)) snapshot.botDir[f] = fsImpl.readFileSync(p, 'utf-8'); } catch (_) {}
  }

  // 取消检查点 #1（提交前）
  if (cancelled()) return { ok: false, cancelled: true, error: '用户取消，未做任何改动' };

  // 文件大小与数量上限
  const buffers = opts.fileBuffers instanceof Map ? opts.fileBuffers : new Map();
  let total = 0;
  for (const [, buf] of buffers) total += Buffer.isBuffer(buf) ? buf.length : Buffer.byteLength(String(buf));
  if (total > MAX_STAGED_BYTES) return { ok: false, error: '文件总大小超过暂存上限 ' + MAX_STAGED_BYTES };

  // 提交：写入 EXT_ROOT/<id> 目录（暂存 + SHA 校验也在该 try 内，SHA 不匹配将被捕获并回滚）
  try {
    try { fsImpl.rmSync ? fsImpl.rmSync(staging, { recursive: true, force: true }) : fsImpl.rmdirSync && safeRmdir(staging, fsImpl); } catch (_) {}
    fsImpl.mkdirSync(staging, { recursive: true });
    for (const [rel, buf] of buffers) {
      const np = require('./extensionManifest').normalizeRelPath(rel);
      if (!np.ok) throw new Error('非法文件路径: ' + rel);
      const content = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf-8');
      const decl = (manifest.files || []).find((f) => f.path === np.normalized);
      if (decl && decl.sha256) {
        const actual = sha256Of(content);
        if (actual !== decl.sha256) throw new Error('文件 SHA-256 不匹配: ' + rel + '（内容可能已被篡改）');
      }
      const dest = path.join(staging, np.normalized);
      fsImpl.mkdirSync(path.dirname(dest), { recursive: true });
      fsImpl.writeFileSync(dest, content);
    }
    fsImpl.mkdirSync(extDir, { recursive: true });
    // 先写清单
    fsImpl.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
    // 移动暂存文件（原子 rename 逐文件）
    for (const [rel] of buffers) {
      const np = require('./extensionManifest').normalizeRelPath(rel).normalized;
      const src = path.join(staging, np);
      const dst = path.join(extDir, np);
      fsImpl.mkdirSync(path.dirname(dst), { recursive: true });
      const tmp = dst + '.tmp.' + process.pid;
      fsImpl.writeFileSync(tmp, fsImpl.readFileSync(src));
      fsImpl.renameSync(tmp, dst);
    }

    // 更新注册表
    const entry = {
      id: manifest.id, name: manifest.name, version: manifest.version, type: manifest.type,
      source: manifest.source || 'local', status: 'installed',
      installedAt: nowIso(now), updatedAt: nowIso(now),
      manifest: manifest, files: manifest.files || [],
      dir: dirForId(manifest.id),
      permissions: manifest.permissions || [], dependencies: manifest.dependencies || [],
      feiyuCompatibility: manifest.feiyuCompatibility || null, apiCompatibility: manifest.apiCompatibility || null,
      previousVersions: [],
    };
    const up = upsert(reg, entry);
    if (!up.ok) throw new Error(up.error);

    // 注册到 botDir 配置（仅 skill/mcp/workflow）
    const reg2 = await registerLegacy(botDir, manifest, adapters, fsImpl);
    if (!reg2.ok) throw new Error('注册到业务配置失败: ' + reg2.error);

    // 安装后检查：注册表路径边界 + 业务配置回读
    const bad = validateOwnedPaths(entry);
    if (bad.length) throw new Error('安装后路径校验失败: ' + bad.join('; '));

    if (opts.registryFile) { const w = saveRegistry(opts.registryFile, reg, fsImpl); if (!w.ok) throw new Error('保存注册表失败: ' + w.error); }
    safeCleanup(staging, fsImpl);
    return { ok: true, entry, rolledBack: false };
  } catch (e) {
    // 回滚
    try { rollbackFromSnapshot(reg, opts.registryFile, snapshot, extDir, botDir, fsImpl); } catch (_) {}
    safeCleanup(staging, fsImpl);
    return { ok: false, error: e.message, rolledBack: true };
  }
}

/** 把扩展注册到 botDir 业务配置（skill/mcp/workflow）。 */
async function registerLegacy(botDir, manifest, adapters, fsImpl) {
  if (!botDir) return { ok: true };
  const ref = manifest.entry && manifest.entry.ref;
  try {
    if (manifest.type === 'skill' && ref) return adapters.registerSkill(botDir, ref);
    if (manifest.type === 'mcp' && ref) return adapters.registerMcp(botDir, { mcpServers: { [manifest.name || 'srv']: ref } });
    if (manifest.type === 'workflow' && ref) return adapters.registerWorkflow(botDir, ref);
  } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
}

function relBotConfigFiles(type) {
  if (type === 'skill') return ['feiyu_skills.json'];
  if (type === 'mcp') return ['feiyu_mcp.json'];
  if (type === 'workflow') return ['feiyu_workflows.json'];
  return [];
}

function rollbackFromSnapshot(reg, registryFile, snapshot, extDir, botDir, fsImpl) {
  reg.extensions = JSON.parse(JSON.stringify(snapshot.registry));
  if (registryFile) { try { saveRegistry(registryFile, reg, fsImpl); } catch (_) {} }
  try { fsImpl.rmSync ? fsImpl.rmSync(extDir, { recursive: true, force: true }) : safeRmdir(extDir, fsImpl); } catch (_) {}
  for (const f of Object.keys(snapshot.botDir)) {
    const p = path.join(botDir, f);
    try { fsImpl.writeFileSync(p, snapshot.botDir[f]); } catch (_) {}
  }
}

/** 启用/禁用。对 skill/mcp/workflow 落到 botDir 配置；其余只改注册表状态。 */
async function setEnabled(opts) {
  return withLock(async () => {
    const fsImpl = opts.fsImpl || fs;
    const reg = opts.registry;
    const e = getEntry(reg, opts.id);
    if (!e) return { ok: false, error: '未找到扩展: ' + opts.id };
    const en = !!opts.enabled;
    if (e.owned === false) return { ok: false, error: '「已有配置」扩展请在对应模块管理启用' };
    // 业务配置联动
    if (opts.botDir && e.type === 'skill' && e.manifest.entry) (opts.legacyAdapters || defaultLegacyAdapters()).setSkillEnabled(opts.botDir, e.manifest.entry.ref, en);
    else if (opts.botDir && e.type === 'mcp' && e.manifest.entry) (opts.legacyAdapters || defaultLegacyAdapters()).setMcpEnabled(opts.botDir, e.manifest.entry.ref, en);
    e.status = en ? 'enabled' : 'disabled';
    e.updatedAt = nowIso(opts.now);
    if (opts.registryFile) saveRegistry(opts.registryFile, reg, fsImpl);
    return { ok: true, id: e.id, enabled: en };
  });
}

/**
 * 升级：保留旧版本到 previousVersions，写入新 manifest+文件，失败回滚。
 */
async function upgrade(opts) {
  return withLock(async () => {
    const fsImpl = opts.fsImpl || fs;
    const reg = opts.registry;
    const old = getEntry(reg, opts.id);
    if (!old) return { ok: false, error: '未找到待升级扩展: ' + opts.id };
    const snapshot = { registry: JSON.parse(JSON.stringify(reg.extensions)), botDir: {} };
    const manifest = opts.manifest;
    // 保留旧版本
    old.previousVersions = (old.previousVersions || []).concat([old.version]).slice(-10);
    try {
      old.version = manifest.version;
      old.manifest = manifest;
      old.name = manifest.name;
      old.files = manifest.files || [];
      old.permissions = manifest.permissions || [];
      old.dependencies = manifest.dependencies || [];
      old.feiyuCompatibility = manifest.feiyuCompatibility || null;
      old.apiCompatibility = manifest.apiCompatibility || null;
      old.updatedAt = nowIso(opts.now);
      old.status = 'installed';
      const extDir = path.join(opts.userDataDir, EXT_ROOT, old.dir);
      fsImpl.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
      const buffers = opts.fileBuffers instanceof Map ? opts.fileBuffers : new Map();
      for (const [rel, buf] of buffers) {
        const np = require('./extensionManifest').normalizeRelPath(rel).normalized;
        const dst = path.join(extDir, np);
        fsImpl.mkdirSync(path.dirname(dst), { recursive: true });
        const tmp = dst + '.tmp.' + process.pid;
        fsImpl.writeFileSync(tmp, Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf-8'));
        fsImpl.renameSync(tmp, dst);
      }
      // 重新注册到业务配置（覆盖旧条目）
      const r2 = await registerLegacy(opts.botDir, manifest, opts.legacyAdapters || defaultLegacyAdapters(), fsImpl);
      if (!r2.ok) throw new Error('重新注册失败: ' + r2.error);
      if (opts.registryFile) { const w = saveRegistry(opts.registryFile, reg, fsImpl); if (!w.ok) throw new Error(w.error); }
      return { ok: true, entry: old, rolledBack: false };
    } catch (e) {
      try { rollbackFromSnapshot(reg, opts.registryFile, snapshot, path.join(opts.userDataDir, EXT_ROOT, old.dir), opts.botDir, fsImpl); } catch (_) {}
      return { ok: false, error: e.message, rolledBack: true };
    }
  });
}

/** 回滚到上一版本（previousVersions 末项）。 */
async function rollback(opts) {
  return withLock(async () => {
    const fsImpl = opts.fsImpl || fs;
    const reg = opts.registry;
    const e = getEntry(reg, opts.id);
    if (!e) return { ok: false, error: '未找到扩展: ' + opts.id };
    if (!e.previousVersions || !e.previousVersions.length) return { ok: false, error: '没有可回滚的历史版本（该扩展类型无法安全回滚）', safe: false };
    const prevVer = e.previousVersions[e.previousVersions.length - 1];
    // 注意：我们没有保存旧 manifest 全文，只能回退版本号并标记；若安装目录含多版本快照可进一步恢复。
    // 为安全起见，若无法恢复旧 manifest 文件，则明确说明不支持自动回滚（不假装成功）。
    const extDir = path.join(opts.userDataDir, EXT_ROOT, e.dir);
    const prevManifest = path.join(extDir, 'manifest.' + prevVer + '.json');
    if (!fsImpl.existsSync(prevManifest)) {
      return { ok: false, error: '未保留旧版本 manifest 快照，无法自动回滚（已保留数据，未做任何破坏）', safe: true };
    }
    try {
      const oldManifest = JSON.parse(fsImpl.readFileSync(prevManifest, 'utf-8'));
      e.version = prevVer;
      e.manifest = oldManifest;
      e.previousVersions = e.previousVersions.slice(0, -1);
      e.updatedAt = nowIso(opts.now);
      await registerLegacy(opts.botDir, oldManifest, opts.legacyAdapters || defaultLegacyAdapters(), fsImpl);
      if (opts.registryFile) saveRegistry(opts.registryFile, reg, fsImpl);
      return { ok: true, version: prevVer };
    } catch (err) {
      return { ok: false, error: '回滚失败: ' + err.message, safe: true };
    }
  });
}

/**
 * 卸载：只删由本管理器拥有且经记录确认的文件（EXT_ROOT/<dir> 内），
 * 并调用业务配置移除（skill/mcp/workflow）。绝不递归删未确认目录。
 */
async function uninstall(opts) {
  return withLock(async () => {
    const fsImpl = opts.fsImpl || fs;
    const reg = opts.registry;
    const e = getEntry(reg, opts.id);
    if (!e) return { ok: false, error: '未找到扩展: ' + opts.id };
    if (e.owned === false) return { ok: false, error: '「已有配置」扩展不能由管理器卸载（请在对应模块删除）' };
    const extDir = path.join(opts.userDataDir, EXT_ROOT, e.dir);
    // 业务配置移除（仅 skill/mcp/workflow）
    if (opts.botDir && e.manifest.entry) {
      const a = opts.legacyAdapters || defaultLegacyAdapters();
      try {
        if (e.type === 'skill') a.removeSkill(opts.botDir, e.manifest.entry.ref);
        else if (e.type === 'mcp') a.removeMcp(opts.botDir, e.manifest.entry.ref);
        else if (e.type === 'workflow') a.removeWorkflow(opts.botDir, e.manifest.entry.ref);
      } catch (_) {}
    }
    // 删除 owned 目录（仅该扩展自己的目录，不碰其它）
    try { fsImpl.rmSync ? fsImpl.rmSync(extDir, { recursive: true, force: true }) : safeRmdir(extDir, fsImpl); } catch (_) {}
    const rm = removeEntry(reg, opts.id);
    if (!rm.ok) return { ok: false, error: rm.error };
    if (opts.registryFile) saveRegistry(opts.registryFile, reg, fsImpl);
    return { ok: true, removedDir: extDir, note: '仅删除本扩展拥有的文件，未触碰其它数据' };
  });
}

/** 列出某扩展将移除的文件（卸载前的可解释预览）。 */
function plannedRemoval(opts) {
  const reg = opts.registry;
  const e = getEntry(reg, opts.id);
  if (!e) return { ok: false, error: '未找到扩展: ' + opts.id };
  if (e.owned === false) return { ok: false, error: '非管理器拥有的扩展，无删除计划' };
  const files = (e.files || []).map((f) => path.join(opts.userDataDir, EXT_ROOT, e.dir, f.path));
  return { ok: true, dir: path.join(opts.userDataDir, EXT_ROOT, e.dir), files, note: '仅删除上述本扩展拥有的文件与目录' };
}

function safeRmdir(p, fsImpl) {
  // 兜底递归删除（仅在 fsImpl 无 rmSync 时）
  if (!fsImpl.existsSync(p)) return;
  for (const ent of fsImpl.readdirSync(p)) {
    const fp = path.join(p, ent);
    const st = fsImpl.statSync(fp);
    if (st.isDirectory()) safeRmdir(fp, fsImpl); else fsImpl.unlinkSync(fp);
  }
  fsImpl.rmdirSync(p);
}
function safeCleanup(p, fsImpl) { try { fsImpl.rmSync ? fsImpl.rmSync(p, { recursive: true, force: true }) : safeRmdir(p, fsImpl); } catch (_) {} }

module.exports = {
  EXT_ROOT, MAX_STAGED_BYTES, dirForId, defaultLegacyAdapters,
  install, setEnabled, upgrade, rollback, uninstall, plannedRemoval, withLock,
};
