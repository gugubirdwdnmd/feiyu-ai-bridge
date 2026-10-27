'use strict';
/* extensionHub.test.js —— Feiyu 1.4 Extension Hub 单元/集成/安全测试。 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const manifest = require('../src/services/extensionManifest');
const registry = require('../src/services/extensionRegistry');
const dep = require('../src/services/dependencyResolver');
const perm = require('../src/services/permissionService');
const testSvc = require('../src/services/extensionTestService');
const lifecycle = require('../src/services/extensionLifecycle');
const mcpRuntime = require('../src/services/extensionMcpRuntime');
const market = require('../src/services/marketService');
const { redactText } = require('../src/services/redact');
const crypto = require('crypto');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* ---------- 内存文件系统（覆盖 lifecycle/registry/permission 用到的 API） ---------- */
function MemFs() {
  const tree = new Map(); // 绝对路径 -> {dir:bool, content:Buffer|string}
  const norm = (p) => path.resolve('/', String(p).replace(/\\/g, '/')).replace(/\\/g, '/');
  function put(p, node) { tree.set(norm(p), node); }
  function get(p) { return tree.get(norm(p)); }
  return {
    _tree: tree,
    existsSync(p) { const n = get(p); return !!n; },
    readFileSync(p, enc) { const n = get(p); if (!n) throw new Error('ENOENT ' + p); return enc ? n.content.toString(enc) : n.content; },
    writeFileSync(p, c) { const n = norm(p); const parent = n.slice(0, n.lastIndexOf('/')); if (parent) this.mkdirSync(parent, { recursive: true }); put(p, { dir: false, content: Buffer.isBuffer(c) ? c : Buffer.from(String(c)) }); },
    mkdirSync(p, o) { const n = norm(p); if (o && o.recursive) { const parts = n.split('/').filter(Boolean); let acc = ''; for (const pt of parts) { acc += '/' + pt; if (!tree.has(acc)) tree.set(acc, { dir: true }); } return; } tree.set(n, { dir: true }); },
    renameSync(a, b) { const n = get(a); if (!n) throw new Error('ENOENT ' + a); tree.set(norm(b), n); tree.delete(norm(a)); },
    unlinkSync(p) { tree.delete(norm(p)); },
    readdirSync(p) { const base = norm(p); const out = []; for (const k of tree.keys()) { if (k.startsWith(base + '/')) { const rest = k.slice(base.length + 1); const seg = rest.split('/')[0]; if (seg && !out.includes(seg)) out.push(seg); } } return out; },
    statSync(p) { const n = get(p); if (!n) throw new Error('ENOENT ' + p); return { isDirectory: () => n.dir, size: n.dir ? 0 : n.content.length }; },
    rmSync(p, o) { const base = norm(p); for (const k of Array.from(tree.keys())) if (k === base || (o && o.recursive && k.startsWith(base + '/'))) tree.delete(k); },
  };
}

/* ---------- 清单校验 ---------- */
test('manifest: 合法清单通过', () => {
  const r = manifest.validateManifest({
    schemaVersion: 1, id: 'ext:demo', name: 'Demo', version: '1.0.0', type: 'skill',
    permissions: [{ id: 'ext.meta.read', purpose: '查看' }],
    files: [{ path: 'main.js', size: 10, sha256: 'a'.repeat(64) }],
  });
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.strictEqual(r.manifest.id, 'ext:demo');
});

test('manifest: 危险字段（scripts）被拒绝', () => {
  const r = manifest.validateManifest({ schemaVersion: 1, id: 'ext:x', name: 'X', version: '1.0.0', type: 'skill', scripts: { postinstall: 'rm -rf /' } });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('scripts')));
});

test('manifest: 路径穿越/绝对路径被拒绝', () => {
  assert.strictEqual(manifest.normalizeRelPath('../etc/passwd').ok, false);
  assert.strictEqual(manifest.normalizeRelPath('/abs/x').ok, false);
  assert.strictEqual(manifest.normalizeRelPath('a/../../b').ok, false);
  assert.ok(manifest.normalizeRelPath('sub/file.js').ok);
});

test('manifest: 未知版本 schemaVersion 被拒', () => {
  const r = manifest.validateManifest({ schemaVersion: 2, id: 'ext:x', name: 'X', version: '1.0.0', type: 'skill' });
  assert.strictEqual(r.ok, false);
});

test('manifest: 版本范围解析', () => {
  assert.ok(manifest.versionSatisfiesRange('1.2.3', '^1.0.0'));
  assert.ok(!manifest.versionSatisfiesRange('2.0.0', '^1.0.0'));
  assert.ok(manifest.versionSatisfiesRange('1.5.0', '>=1.0.0 <2.0.0'));
  assert.ok(!manifest.versionSatisfiesRange('3.0.0', '>=1.0.0 <2.0.0'));
});

test('manifest: 未知字段仅警告并剥离', () => {
  const r = manifest.validateManifest({ schemaVersion: 1, id: 'ext:x', name: 'X', version: '1.0.0', type: 'skill', foo: 1 });
  assert.ok(r.ok);
  assert.ok(r.warnings.some((w) => w.includes('foo')));
  assert.strictEqual(r.manifest.foo, undefined);
});

/* ---------- 依赖 / 兼容 / 冲突 ---------- */
test('dep: 缺失依赖', () => {
  const r = dep.resolve({ id: 'ext:a', version: '1.0.0', type: 'skill', dependencies: [{ id: 'ext:missing', version: '^1.0.0' }] }, [], {});
  assert.strictEqual(r.ok, false);
  assert.ok(r.missing.length === 1);
});

test('dep: 版本范围不满足', () => {
  const idx = [{ id: 'ext:b', version: '1.0.0', type: 'skill', dependencies: [] }];
  const r = dep.resolve({ id: 'ext:a', version: '1.0.0', type: 'skill', dependencies: [{ id: 'ext:b', version: '^2.0.0' }] }, idx, {});
  assert.strictEqual(r.ok, false);
});

test('dep: id 冲突', () => {
  const idx = [{ id: 'ext:a', version: '1.0.0', type: 'skill', dependencies: [] }];
  const r = dep.resolve({ id: 'ext:a', version: '2.0.0', type: 'skill', dependencies: [] }, idx, {});
  assert.strictEqual(r.ok, false);
  assert.ok(r.conflicts.length > 0);
});

test('dep: 依赖环检测', () => {
  const idx = [
    { id: 'ext:a', version: '1.0.0', type: 'skill', dependencies: [{ id: 'ext:b', version: '*' }] },
    { id: 'ext:b', version: '1.0.0', type: 'skill', dependencies: [{ id: 'ext:a', version: '*' }] },
  ];
  const r = dep.resolve({ id: 'ext:c', version: '1.0.0', type: 'skill', dependencies: [{ id: 'ext:a', version: '*' }] }, idx, {});
  assert.strictEqual(r.ok, false);
  assert.ok(r.conflicts.some((c) => c.code === 'dependency_cycle'));
});

test('dep: Feiyu 版本不兼容', () => {
  const r = dep.resolve({ id: 'ext:a', version: '1.0.0', type: 'skill', feiyuCompatibility: { min: '2.0.0' } }, [], { expectedAppVersion: '1.4.0' });
  assert.strictEqual(r.ok, false);
});

/* ---------- 权限 ---------- */
test('perm: 授权 / 运行时校验 / 拦截记录', () => {
  let st = perm.defaultState();
  assert.strictEqual(perm.isGranted(st, 'process.spawn'), false);
  const g = perm.grant(st, 'process.spawn', '*', 'user');
  st = g.state;
  assert.ok(perm.isGranted(st, 'process.spawn'));
  const chk = perm.checkRuntime(st, 'process.spawn', null);
  assert.ok(chk.allowed);
  // 未授权权限拦截并记入日志
  const blocked = perm.checkRuntime(st, 'message.send', null);
  assert.strictEqual(blocked.allowed, false);
  st = perm.recordCall(st, 'message.send', null, false, 'intercepted');
  assert.ok(perm.blockedCalls(st).length > 0);
});

test('perm: 撤销后不再授权', () => {
  let st = perm.grant(perm.defaultState(), 'network.outbound', '*', 'user').state;
  assert.ok(perm.isGranted(st, 'network.outbound'));
  st = perm.revoke(st, 'network.outbound', null).state;
  assert.strictEqual(perm.isGranted(st, 'network.outbound'), false);
});

test('perm: 未知权限拒绝', () => {
  assert.strictEqual(perm.knownPermission('evil.rce'), false);
  const g = perm.grant(perm.defaultState(), 'evil.rce', '*', 'user');
  assert.strictEqual(g.ok, false);
});

/* ---------- 注册表发现 + 索引 ---------- */
test('registry: 从旧配置发现技能/MCP/工作流（不改写文件）', () => {
  const mfs = new MemFs();
  const botDir = '/bot';
  mfs.writeFileSync(path.join(botDir, 'feiyu_skills.json'), JSON.stringify({ version: 1, skills: [{ id: 's1', name: '技能1', enabled: true, valid: true }] }));
  mfs.writeFileSync(path.join(botDir, 'feiyu_mcp.json'), JSON.stringify({ version: 1, servers: [{ name: 'm1', enabled: false, risk: 'low' }] }));
  mfs.writeFileSync(path.join(botDir, 'feiyu_workflows.json'), JSON.stringify({ version: 1, workflows: [{ id: 'w1', name: '流1' }] }));
  const disc = registry.discover(botDir, mfs);
  assert.strictEqual(disc.length, 3);
  assert.ok(disc.every((d) => d.owned === false && d.origin === 'discovered'));
  // 未写入任何注册表文件
  assert.strictEqual(mfs.existsSync(path.join(botDir, 'feiyu-extension-registry.json')), false);
});

test('registry: buildIndex 合并 installed + discovered', () => {
  const reg = registry.defaultRegistry();
  reg.extensions.push({ id: 'ext:a', version: '1.0.0', type: 'skill', dependencies: [], owned: true });
  const idx = registry.buildIndex(reg, [{ id: 'legacy:skill:s1', version: '1.0.0', type: 'skill' }]);
  assert.strictEqual(idx.length, 2);
  assert.ok(idx.find((x) => x.id === 'ext:a'));
});

test('registry: 损坏数据回落默认', () => {
  const mfs = new MemFs();
  mfs.writeFileSync('/u/feiyu-extension-registry.json', '{bad json');
  const reg = registry.loadRegistry('/u/feiyu-extension-registry.json', mfs);
  assert.deepStrictEqual(reg.extensions, []);
});

/* ---------- 生命周期：安装 / 卸载 / 升级 / 回滚 ---------- */
function fakeAdapters() {
  const store = { skill: {}, mcp: {}, workflow: {} };
  return {
    store,
    registerSkill: (bd, s) => { store.skill[s.id] = s; return { ok: true }; },
    removeSkill: (bd, id) => { delete store.skill[id]; return { ok: true }; },
    setSkillEnabled: (bd, id, en) => { if (store.skill[id]) store.skill[id].enabled = en; return { ok: true }; },
    registerMcp: (bd, p) => { store.mcp[Object.keys(p.mcpServers)[0]] = p; return { ok: true }; },
    removeMcp: (bd, n) => { delete store.mcp[n]; return { ok: true }; },
    setMcpEnabled: (bd, n, en) => { if (store.mcp[n]) store.mcp[n].enabled = en; return { ok: true }; },
    registerWorkflow: (bd, w) => { store.workflow[w.id] = w; return { ok: true }; },
    removeWorkflow: (bd, id) => { delete store.workflow[id]; return { ok: true }; },
  };
}

test('lifecycle: 安装成功并落注册表 + 业务配置', async () => {
  const mfs = new MemFs();
  const reg = registry.defaultRegistry();
  const ad = fakeAdapters();
  const buffers = new Map([['main.js', 'console.log(1)']]);
  const manifestObj = { schemaVersion: 1, id: 'ext:demo', name: 'Demo', version: '1.0.0', type: 'skill',
    entry: { ref: { id: 's_demo', name: 'Demo', trigger: { mode: 'always' }, prompt: 'x', tools: [] } },
    files: [{ path: 'main.js', size: 14, sha256: sha('console.log(1)') }] };
  const r = await lifecycle.install({ registry: reg, registryFile: '/u/feiyu-extension-registry.json', manifest: manifestObj, fileBuffers: buffers, userDataDir: '/u', botDir: '/bot', fsImpl: mfs, legacyAdapters: ad });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(mfs.existsSync('/u/feiyu-extensions/ext_demo/main.js'));
  assert.ok(mfs.existsSync('/u/feiyu-extensions/ext_demo/manifest.json'));
  assert.ok(reg.extensions.find((e) => e.id === 'ext:demo'));
  assert.ok(ad.store.skill['s_demo'], '应注册到业务配置');
});

test('lifecycle: SHA-256 不匹配 → 失败并回滚（无半安装）', async () => {
  const mfs = new MemFs();
  const reg = registry.defaultRegistry();
  const ad = fakeAdapters();
  const manifestObj = { schemaVersion: 1, id: 'ext:bad', name: 'Bad', version: '1.0.0', type: 'skill',
    entry: { ref: { id: 's_bad', name: 'Bad', trigger: { mode: 'always' }, prompt: 'x', tools: [] } },
    files: [{ path: 'main.js', size: 3, sha256: 'f'.repeat(64) }] };
  const r = await lifecycle.install({ registry: reg, registryFile: '/u/feiyu-extension-registry.json', manifest: manifestObj, fileBuffers: new Map([['main.js', 'abc']]), userDataDir: '/u', botDir: '/bot', fsImpl: mfs, legacyAdapters: ad });
  assert.strictEqual(r.ok, false);
  assert.ok(r.rolledBack);
  assert.strictEqual(mfs.existsSync('/u/feiyu-extensions/ext_bad/main.js'), false, '不应残留文件');
  assert.strictEqual(reg.extensions.find((e) => e.id === 'ext:bad'), undefined);
});

test('lifecycle: 取消在提交前无副作用', async () => {
  let cancelled = true;
  const mfs = new MemFs();
  const reg = registry.defaultRegistry();
  const ad = fakeAdapters();
  const manifestObj = { schemaVersion: 1, id: 'ext:cancel', name: 'C', version: '1.0.0', type: 'skill',
    entry: { ref: { id: 's_c', name: 'C', trigger: { mode: 'always' }, prompt: 'x', tools: [] } },
    files: [{ path: 'm.js', size: 1, sha256: 'a'.repeat(64) }] };
  const r = await lifecycle.install({ registry: reg, registryFile: '/u/feiyu-extension-registry.json', manifest: manifestObj, fileBuffers: new Map([['m.js', 'x']]), userDataDir: '/u', botDir: '/bot', fsImpl: mfs, legacyAdapters: ad, cancelToken: () => cancelled });
  assert.strictEqual(r.ok, false);
  assert.ok(r.cancelled, JSON.stringify(r));
  assert.strictEqual(reg.extensions.length, 0);
});

test('lifecycle: 卸载只删本扩展文件，不碰其它', async () => {
  const mfs = new MemFs();
  const reg = registry.defaultRegistry();
  const ad = fakeAdapters();
  const manifestObj = { schemaVersion: 1, id: 'ext:del', name: 'D', version: '1.0.0', type: 'skill',
    entry: { ref: { id: 's_d', name: 'D', trigger: { mode: 'always' }, prompt: 'x', tools: [] } },
    files: [{ path: 'm.js', size: 1, sha256: sha('x') }] };
  await lifecycle.install({ registry: reg, registryFile: '/u/feiyu-extension-registry.json', manifest: manifestObj, fileBuffers: new Map([['m.js', 'x']]), userDataDir: '/u', botDir: '/bot', fsImpl: mfs, legacyAdapters: ad });
  // 另一个无关扩展
  const other = { schemaVersion: 1, id: 'ext:other', name: 'O', version: '1.0.0', type: 'skill',
    entry: { ref: { id: 's_o', name: 'O', trigger: { mode: 'always' }, prompt: 'x', tools: [] } }, files: [{ path: 'o.js', size: 1, sha256: sha('x') }] };
  await lifecycle.install({ registry: reg, registryFile: '/u/feiyu-extension-registry.json', manifest: other, fileBuffers: new Map([['o.js', 'x']]), userDataDir: '/u', botDir: '/bot', fsImpl: mfs, legacyAdapters: ad });
  const u = await lifecycle.uninstall({ registry: reg, registryFile: '/u/feiyu-extension-registry.json', id: 'ext:del', userDataDir: '/u', botDir: '/bot', fsImpl: mfs, legacyAdapters: ad });
  assert.ok(u.ok, JSON.stringify(u));
  assert.strictEqual(mfs.existsSync('/u/feiyu-extensions/ext_del/m.js'), false);
  assert.ok(mfs.existsSync('/u/feiyu-extensions/ext_other/o.js'), '其它扩展文件应保留');
});

test('lifecycle: 升级失败回滚', async () => {
  const mfs = new MemFs();
  const reg = registry.defaultRegistry();
  const ad = fakeAdapters();
  const v1 = { schemaVersion: 1, id: 'ext:up', name: 'U', version: '1.0.0', type: 'skill',
    entry: { ref: { id: 's_u', name: 'U', trigger: { mode: 'always' }, prompt: 'x', tools: [] } }, files: [{ path: 'm.js', size: 1, sha256: sha('x') }] };
  await lifecycle.install({ registry: reg, registryFile: '/u/feiyu-extension-registry.json', manifest: v1, fileBuffers: new Map([['m.js', 'x']]), userDataDir: '/u', botDir: '/bot', fsImpl: mfs, legacyAdapters: ad });
  // 升级时强制业务配置注册失败
  const badAd = Object.assign({}, ad, { registerWorkflow: () => ({ ok: false, error: 'boom' }), registerSkill: () => ({ ok: false, error: 'boom' }) });
  const v2 = { schemaVersion: 1, id: 'ext:up', name: 'U', version: '2.0.0', type: 'skill',
    entry: { ref: { id: 's_u', name: 'U', trigger: { mode: 'always' }, prompt: 'x', tools: [] } }, files: [{ path: 'm.js', size: 1, sha256: sha('x') }] };
  const r = await lifecycle.upgrade({ registry: reg, registryFile: '/u/feiyu-extension-registry.json', id: 'ext:up', manifest: v2, fileBuffers: new Map([['m.js', 'y']]), userDataDir: '/u', botDir: '/bot', fsImpl: mfs, legacyAdapters: badAd });
  assert.strictEqual(r.ok, false);
  assert.ok(r.rolledBack);
  assert.strictEqual(reg.extensions.find((e) => e.id === 'ext:up').version, '1.0.0', '应回滚到 1.0.0');
});

/* ---------- 测试服务 ---------- */
test('testSvc: 静态检查标记危险字段与路径越界', () => {
  const r = testSvc.staticCheck({ schemaVersion: 1, id: 'ext:x', name: 'X', version: '1.0.0', type: 'skill', scripts: { x: 1 }, files: [{ path: '../escape' }] });
  assert.ok(r.items.some((i) => i.status === 'fail'));
});

test('testSvc: workflow Dry Run 通过', async () => {
  const mfs = new MemFs();
  const botDir = '/bot';
  mfs.writeFileSync(path.join(botDir, 'feiyu_workflows.json'), JSON.stringify({ version: 1, workflows: [{
    id: 'w1', name: 'W', nodes: [{ id: 'n1', type: 'start' }, { id: 'n2', type: 'log', params: { message: 'hi' } }, { id: 'n3', type: 'end' }],
    edges: [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }] }] }));
  const r = await testSvc.dryRun({ schemaVersion: 1, id: 'ext:w', name: 'W', version: '1.0.0', type: 'workflow', entry: { ref: 'w1' } }, { botDir, fsImpl: mfs });
  assert.ok(r.ok, JSON.stringify(r));
});

/* ---------- MCP 受控运行 ---------- */
function fakeSpawn(pid) {
  return (cmd, args, opts) => ({
    pid: pid || 9999,
    stdout: { on: () => {} },
    stderr: { on: (ev, cb) => { if (ev === 'data') cb(Buffer.from('ready')); } },
    on: (ev, cb) => { if (ev === 'exit') setTimeout(() => cb(0), 5); },
    kill: () => {},
  });
}

test('mcpRuntime: stdio 启动需授权，未授权拦截', async () => {
  const rt = mcpRuntime.createMcpRuntime({ spawnImpl: fakeSpawn(111), permissionService: perm });
  const st = perm.defaultState();
  const r = await rt.start('srv', { transport: 'stdio', argv: ['node', '-e', 'x'] }, { permissionState: st });
  assert.strictEqual(r.ok, false);
  assert.ok(r.blocked);
});

test('mcpRuntime: 授权后 stdio 启动成功并可见', async () => {
  const rt = mcpRuntime.createMcpRuntime({ spawnImpl: fakeSpawn(222), permissionService: perm });
  let st = perm.grant(perm.defaultState(), 'process.spawn', '*', 'user').state;
  const r = await rt.start('srv2', { transport: 'stdio', argv: ['node', '-e', 'x'] }, { permissionState: st });
  assert.ok(r.ok, JSON.stringify(r));
  const h = rt.health('srv2');
  assert.ok(h.running);
  rt.stop('srv2');
  assert.strictEqual(rt.status('srv2').running, false);
});

test('mcpRuntime: 拒绝 shell 解释器作为可执行文件', async () => {
  const rt = mcpRuntime.createMcpRuntime({ spawnImpl: fakeSpawn(333), permissionService: perm });
  let st = perm.grant(perm.defaultState(), 'process.spawn', '*', 'user').state;
  const r = await rt.start('sh', { transport: 'stdio', argv: ['powershell.exe', '-c', 'x'] }, { permissionState: st });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.supported, false);
});

test('mcpRuntime: 远程服务健康检查（fake fetch）', async () => {
  const fetchImpl = async () => ({ status: 200, ok: true });
  const rt = mcpRuntime.createMcpRuntime({ fetchImpl, permissionService: perm });
  let st = perm.grant(perm.defaultState(), 'network.outbound', '*', 'user').state;
  const r = await rt.start('remote', { transport: 'sse', url: 'https://example.com/mcp' }, { permissionState: st });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(r.remote);
});

/* ---------- 市场 / 脱敏（复用既有服务，验证未退化） ---------- */
test('market: 下载大小上限生效', async () => {
  const big = Buffer.alloc(market.MAX_DOWNLOAD_BYTES + 10);
  const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => big.buffer });
  const item = { downloadUrl: 'https://x.com/a', sha256: null, integrity: 'unverified', requiresAuth: false, paid: false };
  const r = await market.fetchItem(item, { fetchFn: fetchImpl, maxBytes: market.MAX_DOWNLOAD_BYTES });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('大小'));
});

test('redact: 敏感信息不泄露', () => {
  const out = redactText('token=sk-1234567890abcdef token 仍在日志');
  assert.ok(!out.includes('sk-1234567890abcdef'));
});
