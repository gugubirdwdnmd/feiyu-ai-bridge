'use strict';
/**
 * comfyService.test.js —— ComfyUI 生图扩展测试。
 * 全部用 mock fetch / 临时目录，不触网、不下载真实大文件。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const comfy = require('../src/services/comfyService');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-test-'));
}

/** 造一个假的 ComfyUI 安装目录（含 main.py）。 */
function fakeComfy(withModels = {}) {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'main.py'), '# fake\n');
  fs.mkdirSync(path.join(d, 'models'), { recursive: true });
  for (const [rel, size] of Object.entries(withModels)) {
    const p = path.join(d, 'models', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(size, 1));
  }
  return d;
}

/** mock fetch：返回可读流。 */
function mockFetch(handlers) {
  return async (url) => {
    const h = handlers[String(url)] || handlers.default;
    if (!h) return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
    return h;
  };
}

test('looksLikeComfyDir: 认得 main.py 与 ComfyUI/main.py 两种布局', () => {
  const d1 = tmpDir();
  fs.writeFileSync(path.join(d1, 'main.py'), '');
  assert.strictEqual(comfy.looksLikeComfyDir(d1), true);

  const d2 = tmpDir();
  fs.mkdirSync(path.join(d2, 'ComfyUI'));
  fs.writeFileSync(path.join(d2, 'ComfyUI', 'main.py'), '');
  assert.strictEqual(comfy.looksLikeComfyDir(d2), true);

  const d3 = tmpDir();
  assert.strictEqual(comfy.looksLikeComfyDir(d3), false);
  assert.strictEqual(comfy.looksLikeComfyDir(null), false);
  [d1, d2, d3].forEach((x) => fs.rmSync(x, { recursive: true, force: true }));
});

test('resolveComfyRoot: 归一到含 main.py 的目录', () => {
  const d = tmpDir();
  fs.mkdirSync(path.join(d, 'ComfyUI'));
  fs.writeFileSync(path.join(d, 'ComfyUI', 'main.py'), '');
  assert.strictEqual(comfy.resolveComfyRoot(d), path.join(d, 'ComfyUI'));
  fs.rmSync(d, { recursive: true, force: true });
});

test('detect: 显式指定目录时能识别', () => {
  const d = fakeComfy();
  const r = comfy.detect({ dir: d });
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.root, d);
  assert.strictEqual(r.endpoint, 'http://127.0.0.1:8188');
  fs.rmSync(d, { recursive: true, force: true });
});

test('detect: 找不到时 found=false 且不抛错', () => {
  const r = comfy.detect({ dir: path.join(os.tmpdir(), 'definitely-not-here-' + Date.now()) });
  // 注意：本机可能真的装了 ComfyUI（如 D:\ComfyUI），因此只断言「不抛错 + 结构完整」
  assert.strictEqual(typeof r.found, 'boolean');
  if (!r.found) {
    assert.strictEqual(r.root, null);
  } else {
    assert.ok(r.root);
  }
  assert.ok(Array.isArray(r.candidates));
});

test('testConnection: 成功时解析版本与设备', async () => {
  const fetchFn = mockFetch({
    default: {
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({
        system: { comfyui_version: '0.3.57', python_version: '3.12.0 (main)', os: 'nt' },
        devices: [{ name: 'NVIDIA GeForce RTX 4090', vram_total: 25757220864 }],
      }),
    },
  });
  const r = await comfy.testConnection('http://127.0.0.1:8188', { fetch: fetchFn });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.running, true);
  assert.strictEqual(r.version, '0.3.57');
  assert.strictEqual(r.python, '3.12.0');
  assert.strictEqual(r.vramMB, 24564);
});

test('testConnection: 服务未启动时返回 ok=false 且不抛错', async () => {
  const fetchFn = async () => { throw new Error('ECONNREFUSED'); };
  const r = await comfy.testConnection('http://127.0.0.1:8188', { fetch: fetchFn });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.running, false);
  assert.ok(r.error);
});

test('testConnection: HTTP 非 2xx 返回错误', async () => {
  const fetchFn = mockFetch({ default: { ok: false, status: 502, headers: { get: () => null }, json: async () => ({}) } });
  const r = await comfy.testConnection('http://127.0.0.1:8188', { fetch: fetchFn });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('502'));
});

test('listWorkflows: 解析工作流并识别必要节点', () => {
  const d = tmpDir();
  fs.mkdirSync(path.join(d, 'workflows'));
  fs.writeFileSync(path.join(d, 'workflows', 'ok.json'), JSON.stringify({
    '1': { class_type: 'CLIPTextEncode', inputs: {} },
    '2': { class_type: 'KSampler', inputs: {} },
    '3': { class_type: 'SaveImage', inputs: {} },
    '4': { class_type: 'UnetLoaderGGUF', inputs: {} },
  }));
  fs.writeFileSync(path.join(d, 'workflows', 'bad.json'), '{ broken');
  const r = comfy.listWorkflows(d);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.workflows.length, 2);
  const ok = r.workflows.find((w) => w.file === 'ok.json');
  assert.strictEqual(ok.hasCLIP, true);
  assert.strictEqual(ok.hasSampler, true);
  assert.strictEqual(ok.hasSave, true);
  assert.strictEqual(ok.hasUnet, true);
  assert.strictEqual(ok.parseError, null);
  const bad = r.workflows.find((w) => w.file === 'bad.json');
  assert.ok(bad.parseError);
  fs.rmSync(d, { recursive: true, force: true });
});

test('listWorkflows: 没有 workflows 目录时返回 exists=false', () => {
  const d = tmpDir();
  const r = comfy.listWorkflows(d);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.exists, false);
  assert.deepStrictEqual(r.workflows, []);
  fs.rmSync(d, { recursive: true, force: true });
});

test('checkModels: 检出缺失模型', () => {
  const d = fakeComfy();
  const r = comfy.checkModels(d);
  assert.strictEqual(r.ready, false);
  assert.ok(r.missing.includes('unet'));
  assert.ok(r.missing.includes('text_encoder'));
  assert.ok(r.missing.includes('vae'));
  fs.rmSync(d, { recursive: true, force: true });
});

test('checkModels: 模型齐全时 ready=true', () => {
  const d = fakeComfy({
    'diffusion_models/z_image_turbo-Q5_K_M.gguf': 100,
    'text_encoders/Qwen3-4B-Q5_K_M.gguf': 100,
    'vae/ae.safetensors': 100,
  });
  const r = comfy.checkModels(d);
  assert.strictEqual(r.ready, true);
  assert.deepStrictEqual(r.missing, []);
  fs.rmSync(d, { recursive: true, force: true });
});

test('checkPrerequisites: 大模型未接入时 ok=false 且 missing 明确', () => {
  const d = fakeComfy();
  const r = comfy.checkPrerequisites(d, { ok: false, detail: '未接入', comfyRunning: false });
  assert.strictEqual(r.ok, false);
  assert.ok(r.missing.includes('llm_provider'));
  assert.ok(r.missing.includes('comfy_running'));
  assert.ok(r.missing.includes('text_encoder'));
  // 明细必须说清「先接入大模型」
  const llm = r.items.find((i) => i.key === 'llm_provider');
  assert.ok(llm.detail.includes('接入'), '应提示接入大模型');
  fs.rmSync(d, { recursive: true, force: true });
});

test('checkPrerequisites: 一切就绪时 ok=true', () => {
  const d = fakeComfy({
    'diffusion_models/z_image_turbo-Q5_K_M.gguf': 100,
    'text_encoders/Qwen3-4B-Q5_K_M.gguf': 100,
    'vae/ae.safetensors': 100,
  });
  const r = comfy.checkPrerequisites(d, { ok: true, detail: '已接入', comfyRunning: true });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.missing, []);
  fs.rmSync(d, { recursive: true, force: true });
});

test('modelUrls: 只用内置白名单主机，且主源与镜像都在', () => {
  const m = comfy.MODEL_CATALOG.find((x) => x.key === 'unet');
  const urls = comfy.modelUrls(m);
  assert.strictEqual(urls.length, comfy.HF_BASES.length);
  for (const u of urls) {
    assert.ok(u.startsWith('https://'), '必须 https');
    assert.ok(u.includes(m.repo), '必须指向登记的仓库');
    assert.ok(u.includes(m.hfPath));
  }
});

test('downloadModel: 拒绝未登记的模型 key', async () => {
  const d = fakeComfy();
  const r = await comfy.downloadModel(d, 'evil_model', { fetch: mockFetch({}) });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('未登记'));
  fs.rmSync(d, { recursive: true, force: true });
});

test('downloadModel: 文件已存在且体积正常时跳过下载', async () => {
  const d = fakeComfy({ 'vae/ae.safetensors': 1000 });
  let called = false;
  const fetchFn = async () => { called = true; throw new Error('不应被调用'); };
  // 期望体积覆盖为 1000 字节 → 现有文件视为完整
  const r = await comfy.downloadModel(d, 'vae', { fetch: fetchFn, expectedBytes: { vae: 1000 } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(called, false, '已存在时不得发起下载');
  fs.rmSync(d, { recursive: true, force: true });
});

test('downloadModel: 下载成功写入目标路径', async () => {
  const d = fakeComfy();
  const payload = Buffer.alloc(64, 7);
  const fetchFn = mockFetch({
    default: {
      ok: true, status: 200,
      headers: { get: (h) => (h === 'content-length' ? String(payload.length) : null) },
      body: null,
      arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
    },
  });
  const r = await comfy.downloadModel(d, 'vae', { fetch: fetchFn });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.bytes, 64);
  assert.ok(fs.existsSync(r.path));
  assert.ok(r.path.includes(path.join('models', 'vae')));
  // 不留 .part 残留
  assert.deepStrictEqual(fs.readdirSync(path.join(d, 'models', 'vae')).filter((f) => f.includes('.part')), []);
  fs.rmSync(d, { recursive: true, force: true });
});

test('downloadModel: 主源失败时回落到镜像', async () => {
  const d = fakeComfy();
  const payload = Buffer.alloc(32, 3);
  let firstUrl = null;
  const fetchFn = async (url) => {
    if (!firstUrl) { firstUrl = url; return { ok: false, status: 403, headers: { get: () => null }, json: async () => ({}) }; }
    return {
      ok: true, status: 200,
      headers: { get: (h) => (h === 'content-length' ? String(payload.length) : null) },
      body: null,
      arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
    };
  };
  const r = await comfy.downloadModel(d, 'vae', { fetch: fetchFn });
  assert.strictEqual(r.ok, true);
  assert.ok(r.source.includes('hf-mirror.com') || r.source !== firstUrl, '应换源重试');
  fs.rmSync(d, { recursive: true, force: true });
});

test('downloadModel: 全部源失败时返回错误且不留半成品', async () => {
  const d = fakeComfy();
  const fetchFn = async () => ({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) });
  const r = await comfy.downloadModel(d, 'vae', { fetch: fetchFn });
  assert.strictEqual(r.ok, false);
  const dir = path.join(d, 'models', 'vae');
  if (fs.existsSync(dir)) {
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.includes('.part')), []);
  }
  fs.rmSync(d, { recursive: true, force: true });
});

test('downloadModel: 未找到 ComfyUI 目录时拒绝下载', async () => {
  const r = await comfy.downloadModel(null, 'vae', { fetch: mockFetch({}) });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('ComfyUI'));
});

test('resolveComfyRelease: 从 GitHub API 解析官方便携版', async () => {
  const fetchFn = mockFetch({
    default: {
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({
        tag_name: 'v0.3.57',
        published_at: '2026-01-01T00:00:00Z',
        assets: [
          { name: 'ComfyUI_windows_portable_nvidia.7z', size: 1900000000, browser_download_url: 'https://github.com/x/y.7z' },
          { name: 'ComfyUI_windows_portable_amd.7z', size: 1500000000, browser_download_url: 'https://github.com/x/a.7z' },
        ],
      }),
    },
  });
  const r = await comfy.resolveComfyRelease('nvidia', { fetch: fetchFn });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tag, 'v0.3.57');
  assert.strictEqual(r.name, 'ComfyUI_windows_portable_nvidia.7z');
  assert.ok(r.url.includes('github.com'));
});

test('resolveComfyRelease: 目标资源不存在时列出可用资源', async () => {
  const fetchFn = mockFetch({
    default: {
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({ tag_name: 'v1', assets: [{ name: 'other.zip', size: 1, browser_download_url: 'u' }] }),
    },
  });
  const r = await comfy.resolveComfyRelease('nvidia', { fetch: fetchFn });
  assert.strictEqual(r.ok, false);
  assert.ok(Array.isArray(r.available));
  assert.ok(r.available.includes('other.zip'));
});

test('resolveComfyRelease: API 报错时返回错误不抛异常', async () => {
  const fetchFn = mockFetch({ default: { ok: false, status: 403, headers: { get: () => null }, json: async () => ({}) } });
  const r = await comfy.resolveComfyRelease('nvidia', { fetch: fetchFn });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('403'));
});

test('installComfyUI: 未指定目录时拒绝', async () => {
  const r = await comfy.installComfyUI('', 'nvidia', { fetch: mockFetch({}) });
  assert.strictEqual(r.ok, false);
});

test('installComfyUI: 解压成功返回 root', async () => {
  const d = tmpDir();
  // 按 URL 分别响应：GitHub API 返回 release 元数据，资源地址返回二进制
  const fetchFn = async (url) => {
    if (String(url).includes('api.github.com')) {
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        json: async () => ({
          tag_name: 'v0.3.57',
          published_at: '2026-01-01T00:00:00Z',
          assets: [{ name: 'ComfyUI_windows_portable_nvidia.7z', size: 1024, browser_download_url: 'https://example.test/dl.7z' }],
        }),
      };
    }
    return {
      ok: true, status: 200,
      headers: { get: (h) => (h === 'content-length' ? '10' : null) },
      body: null,
      arrayBuffer: async () => new ArrayBuffer(10),
    };
  };
  // mock execFile：假装解压成功，并在目标目录造出 ComfyUI/main.py
  const execFile = (cmd, args, opts, cb) => {
    fs.mkdirSync(path.join(d, 'ComfyUI'), { recursive: true });
    fs.writeFileSync(path.join(d, 'ComfyUI', 'main.py'), '');
    cb(null, '', '');
  };
  const r = await comfy.installComfyUI(d, 'nvidia', { fetch: fetchFn, execFile });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.ok(r.root);
  assert.ok(r.root.endsWith('ComfyUI'));
  fs.rmSync(d, { recursive: true, force: true });
});

test('extractArchive: tar 失败时返回错误并给出手动解压提示', async () => {
  const r = await comfy.extractArchive('x.7z', 'C:\\dest', (cmd, args, opts, cb) => {
    cb(new Error('boom'), '', 'tar: cannot extract');
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.hint);
});

test('freeSpace: 取不到时返回 null 而非抛错', () => {
  const v = comfy.freeSpace(path.join(os.tmpdir(), 'nonexistent-' + Date.now()));
  assert.ok(v === null || typeof v === 'number');
});

test('MODEL_CATALOG: 全部条目字段完整且 hfPath 在登记仓库下', () => {
  for (const m of comfy.MODEL_CATALOG) {
    assert.ok(m.key, m.label);
    assert.ok(m.repo.includes('/'), m.key + ' 仓库名不合法');
    assert.ok(m.hfPath, m.key + ' 缺少 hfPath');
    assert.ok(m.dir, m.key + ' 缺少目标目录');
    assert.ok(m.approxMB > 0);
  }
});
test('downloadModel: 响应字节数与 content-length 不符时判为不完整并拒绝落盘', async () => {
  const d = fakeComfy();
  // 声明 1000 字节，实际只给 100 字节（模拟连接中断）
  const fetchFn = mockFetch({
    default: {
      ok: true, status: 200,
      headers: { get: (h) => (h === 'content-length' ? '1000' : null) },
      body: null,
      arrayBuffer: async () => new ArrayBuffer(100),
    },
  });
  const r = await comfy.downloadModel(d, 'vae', { fetch: fetchFn });
  assert.strictEqual(r.ok, false, '不完整下载必须失败');
  assert.ok(r.error.includes('不完整'), r.error);
  const dest = path.join(d, 'models', 'vae', 'ae.safetensors');
  assert.strictEqual(fs.existsSync(dest), false, '半截文件不得落盘');
  fs.rmSync(d, { recursive: true, force: true });
});

test('downloadModel: 已存在的半截文件会被重新下载而非跳过', async () => {
  const d = fakeComfy({ 'vae/ae.safetensors': 10 });  // 远小于标称 319MB
  let called = false;
  const payload = Buffer.alloc(64, 9);
  const fetchFn = async () => {
    called = true;
    return {
      ok: true, status: 200,
      headers: { get: (h) => (h === 'content-length' ? String(payload.length) : null) },
      body: null,
      arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
    };
  };
  const r = await comfy.downloadModel(d, 'vae', { fetch: fetchFn });
  assert.strictEqual(called, true, '半截文件应触发重新下载');
  assert.strictEqual(r.ok, true);
  fs.rmSync(d, { recursive: true, force: true });
});

test('checkModels: 体积正常（按期望字节数）的模型不标 suspicious', () => {
  const d = fakeComfy({
    'diffusion_models/z_image_turbo-Q5_K_M.gguf': 5000,
    'text_encoders/Qwen3-4B-Q5_K_M.gguf': 2000,
    'vae/ae.safetensors': 300,
  });
  // 用小的期望值覆盖，避免在测试里造 GB 级文件
  const r = comfy.checkModels(d, { expectedBytes: { unet: 5000, text_encoder: 2000, vae: 300 } });
  assert.deepStrictEqual(r.suspicious, []);
  assert.strictEqual(r.ready, true);
  fs.rmSync(d, { recursive: true, force: true });
});

test('checkModels: 体积明显偏小的模型被标为 suspicious', () => {
  const d = fakeComfy({ 'vae/ae.safetensors': 10 });
  const r = comfy.checkModels(d, { expectedBytes: { vae: 300 } });
  assert.ok(r.suspicious.includes('vae'), '应识别出可疑的半截文件');
  const vae = r.models.find((m) => m.key === 'vae');
  assert.strictEqual(vae.suspicious, true);
  fs.rmSync(d, { recursive: true, force: true });
});

test('MODEL_CATALOG: 每个模型都带实测字节数', () => {
  for (const m of comfy.MODEL_CATALOG) {
    assert.ok(Number.isFinite(m.bytes) && m.bytes > 0, m.key + ' 缺少 bytes');
  }
});
