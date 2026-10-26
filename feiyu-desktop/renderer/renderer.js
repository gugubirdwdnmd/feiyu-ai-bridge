'use strict';
/* renderer.js —— 肥鱼桌面控制中心 UI 逻辑。仅通过 window.feiyu.invoke 与 Main 通信。 */
const f = window.feiyu;
const C = f.channels;
const $ = (s, r = document) => r.querySelector(s);
const content = $('#content');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => (n == null ? 0 : n).toLocaleString('zh-CN');
const invoke = (ch, args) => f.invoke(ch, args);
/** 订阅主进程事件，返回取消订阅函数（用于离开页面时清理）。 */
const fOn = (ch, cb) => (typeof f.on === 'function' ? f.on(ch, cb) : () => {});

// 页面切换时统一清理上一页的定时器 / 事件订阅 / 终端会话，避免残留监听导致内存泄漏或错页渲染
const pageCleanups = [];
function addCleanup(fn) { if (typeof fn === 'function') pageCleanups.push(fn); }
function runCleanups() { while (pageCleanups.length) { const fn = pageCleanups.shift(); try { fn(); } catch (_) {} } }

let editPid = null;                              // 正在编辑的 Provider id
let usageFilter = { provider: '', model: '', status: '' };
let usageCurrent = null;                         // 当前用量数据（筛选用）
let usagePrice = null;                           // 当前价格表
let themeState = null;                           // 当前主题（{theme, derived, presets}）

function shortUrl(u) { if (!u) return '—'; try { const x = new URL(u); return x.host + x.pathname; } catch (_) { return u; } }

/* 内置 MD5（普通玩家只记得明文密码，这里在本地算出 MD5 再提交，明文绝不离开本机）。 */
function md5hex(s) {
  function add32(a, b) { return (a + b) & 0xffffffff; }
  function rol(n, c) { return (n << c) | (n >>> (32 - c)); }
  function cm(q, a, b, x, s, t) { a = add32(add32(a, q), add32(x, t)); return add32(rol(a, s), b); }
  function ff(a, b, c, d, x, s, t) { return cm((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cm((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cm(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cm(c ^ (b | ~d), a, b, x, s, t); }
  function toBytes(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
      else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    }
    return out;
  }
  const x = toBytes(s); const len = x.length;
  x.push(0x80); while (x.length % 64 !== 56) x.push(0);
  const bits = len * 8;
  x.push(bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff, 0, 0, 0, 0);
  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  for (let i = 0; i < x.length; i += 64) {
    const w = [];
    for (let j = 0; j < 16; j++) w[j] = (x[i + j * 4]) | (x[i + j * 4 + 1] << 8) | (x[i + j * 4 + 2] << 16) | (x[i + j * 4 + 3] << 24);
    let oa = a, ob = b, oc = c, od = d;
    a = ff(a, b, c, d, w[0], 7, 0xd76aa478); d = ff(d, a, b, c, w[1], 12, 0xe8c7b756); c = ff(c, d, a, b, w[2], 17, 0x242070db); b = ff(b, c, d, a, w[3], 22, 0xc1bdceee);
    a = ff(a, b, c, d, w[4], 7, 0xf57c0faf); d = ff(d, a, b, c, w[5], 12, 0x4787c62a); c = ff(c, d, a, b, w[6], 17, 0xa8304613); b = ff(b, c, d, a, w[7], 22, 0xfd469501);
    a = ff(a, b, c, d, w[8], 7, 0x698098d8); d = ff(d, a, b, c, w[9], 12, 0x8b44f7af); c = ff(c, d, a, b, w[10], 17, 0xffff5bb1); b = ff(b, c, d, a, w[11], 22, 0x895cd7be);
    a = ff(a, b, c, d, w[12], 7, 0x6b901122); d = ff(d, a, b, c, w[13], 12, 0xfd987193); c = ff(c, d, a, b, w[14], 17, 0xa679438e); b = ff(b, c, d, a, w[15], 22, 0x49b40821);
    a = gg(a, b, c, d, w[1], 5, 0xf61e2562); d = gg(d, a, b, c, w[6], 9, 0xc040b340); c = gg(c, d, a, b, w[11], 14, 0x265e5a51); b = gg(b, c, d, a, w[0], 20, 0xe9b6c7aa);
    a = gg(a, b, c, d, w[5], 5, 0xd62f105d); d = gg(d, a, b, c, w[10], 9, 0x02441453); c = gg(c, d, a, b, w[15], 14, 0xd8a1e681); b = gg(b, c, d, a, w[4], 20, 0xe7d3fbc8);
    a = gg(a, b, c, d, w[9], 5, 0x21e1cde6); d = gg(d, a, b, c, w[14], 9, 0xc33707d6); c = gg(c, d, a, b, w[3], 14, 0xf4d50d87); b = gg(b, c, d, a, w[8], 20, 0x455a14ed);
    a = gg(a, b, c, d, w[13], 5, 0xa9e3e905); d = gg(d, a, b, c, w[2], 9, 0xfcefa3f8); c = gg(c, d, a, b, w[7], 14, 0x676f02d9); b = gg(b, c, d, a, w[12], 20, 0x8d2a4c8a);
    a = hh(a, b, c, d, w[5], 4, 0xfffa3942); d = hh(d, a, b, c, w[8], 11, 0x8771f681); c = hh(c, d, a, b, w[11], 16, 0x6d9d6122); b = hh(b, c, d, a, w[14], 23, 0xfde5380c);
    a = hh(a, b, c, d, w[1], 4, 0xa4beea44); d = hh(d, a, b, c, w[4], 11, 0x4bdecfa9); c = hh(c, d, a, b, w[7], 16, 0xf6bb4b60); b = hh(b, c, d, a, w[10], 23, 0xbebfbc70);
    a = hh(a, b, c, d, w[13], 4, 0x289b7ec6); d = hh(d, a, b, c, w[0], 11, 0xeaa127fa); c = hh(c, d, a, b, w[3], 16, 0xd4ef3085); b = hh(b, c, d, a, w[6], 23, 0x04881d05);
    a = hh(a, b, c, d, w[9], 4, 0xd9d4d039); d = hh(d, a, b, c, w[12], 11, 0xe6db99e5); c = hh(c, d, a, b, w[15], 16, 0x1fa27cf8); b = hh(b, c, d, a, w[2], 23, 0xc4ac5665);
    a = ii(a, b, c, d, w[0], 6, 0xf4292244); d = ii(d, a, b, c, w[7], 10, 0x432aff97); c = ii(c, d, a, b, w[14], 15, 0xab9423a7); b = ii(b, c, d, a, w[5], 21, 0xfc93a039);
    a = ii(a, b, c, d, w[12], 6, 0x655b59c3); d = ii(d, a, b, c, w[3], 10, 0x8f0ccc92); c = ii(c, d, a, b, w[10], 15, 0xffeff47d); b = ii(b, c, d, a, w[1], 21, 0x85845dd1);
    a = ii(a, b, c, d, w[8], 6, 0x6fa87e4f); d = ii(d, a, b, c, w[15], 10, 0xfe2ce6e0); c = ii(c, d, a, b, w[6], 15, 0xa3014314); b = ii(b, c, d, a, w[13], 21, 0x4e0811a1);
    a = ii(a, b, c, d, w[4], 6, 0xf7537e82); d = ii(d, a, b, c, w[11], 10, 0xbd3af235); c = ii(c, d, a, b, w[2], 15, 0x2ad7d2bb); b = ii(b, c, d, a, w[9], 21, 0xeb86d391);
    a = add32(a, oa); b = add32(b, ob); c = add32(c, oc); d = add32(d, od);
  }
  const hex = (n) => (n & 0xff).toString(16).padStart(2, '0') + ((n >>> 8) & 0xff).toString(16).padStart(2, '0') + ((n >>> 16) & 0xff).toString(16).padStart(2, '0') + ((n >>> 24) & 0xff).toString(16).padStart(2, '0');
  return hex(a) + hex(b) + hex(c) + hex(d);
}

/* 常见大模型服务商预设：普通玩家选一个，只填 API Key 即可，Base URL/模型自动填好。 */
const PROVIDER_PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', base: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat', reasoning: 'deepseek-reasoner' },
  { id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', reasoning: 'gpt-4o' },
  { id: 'dashscope', name: '阿里云百炼', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus', reasoning: 'qwen-max' },
  { id: 'zhipu', name: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-plus', reasoning: '' },
  { id: 'moonshot', name: 'Moonshot Kimi', base: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k', reasoning: '' },
  { id: 'siliconflow', name: '硅基流动', base: 'https://api.siliconflow.cn/v1/chat/completions', model: 'deepseek-ai/DeepSeek-V3', reasoning: '' },
  { id: 'ollama', name: 'Ollama 本地', base: 'http://127.0.0.1:11434/v1/chat/completions', model: 'llama3.2', reasoning: '' },
  { id: 'custom', name: '自定义 / 其他', base: '', model: '', reasoning: '' },
];
function csvCell(v) { const s = v == null ? '' : String(v); if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'; return s; }
function downloadCSV(reqs) {
  const cols = ['time', 'status', 'kind', 'provider', 'model', 'prompt_tokens', 'completion_tokens', 'reasoning_tokens', 'cache_hit_tokens', 'cache_miss_tokens', 'total_tokens', 'durationMs', 'errorCategory'];
  const lines = [cols.map(csvCell).join(',')];
  for (const x of reqs) lines.push(cols.map((c) => csvCell(x[c])).join(','));
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'feiyu-usage.csv'; a.click();
}

/** 弹出系统目录选择框，写入设置（仅保存路径字符串，不读文件）。 */
async function pickBotDir() {
  const r = await invoke(C.DIALOG_PICKDIR);
  if (!r || !r.ok) { if (r && r.error) alert('选择目录失败：' + r.error); return; }
  if (!r.dir) return;
  if (r.botCorePresent === false && !confirm('该目录未找到 ai_bridge.js，确定作为机器人目录？')) return;
  const s = await invoke(C.SETTINGS_SET, { botDir: r.dir });
  await refreshBotDirLabel();
  return s.settings && s.settings.botDir;
}

function badge(on, text) { return `<span class="badge ${on ? 'on' : 'off'}">${esc(text)}</span>`; }
function statusBadge(s) {
  if (s && s.running) return badge(true, '运行中 PID=' + s.pid);
  return badge(false, '已停止');
}

/* ---------- 导航 ---------- */
document.querySelectorAll('#nav button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#nav button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    render(b.dataset.page);
  });
});
async function refreshBotDirLabel() {
  const r = await invoke(C.SETTINGS_GET);
  const d = (r.settings && r.settings.botDir) || '';
  const el = $('#botDirLabel');
  if (!el) return;
  if (d) {
    el.textContent = '机器人目录:\n' + d;
    el.classList.remove('err');
  } else {
    el.textContent = '未配置机器人目录（设置里选择）';
    el.classList.add('err');
  }
  // 定位状态：目录缺失 / 缺 ai_bridge.js / 指向发布副本时给出明确提示（验收项：不得静默失败）
  try {
    const st = await invoke(C.BOTDIR_STATUS);
    const el2 = $('#botDirStatus');
    if (el2 && st) {
      // 指向源码检出（发布副本）时用黄色警告色，而不是简单的 ok/err 二分
      const cls = st.isCheckout ? 'warn' : (st.hasCore ? 'ok' : 'err');
      el2.innerHTML = '<span class="' + cls + '">' + esc(st.message) + '</span>';
    }
  } catch (_) {}
}

function render(page) {
  runCleanups();
  refreshBotDirLabel();
  const map = { overview: pageOverview, run: pageRun, api: pageApi, usage: pageUsage, personality: pagePersonality, skills: pageSkills, comfy: pageComfy, theme: pageTheme, logs: pageLogs, importexport: pageImportExport, about: pageAbout,
    // 新增聚合页（模块 A–J）
    loginservices: pageLoginServices, extensions: pageExtensions, ops: pageOps,
    // 模块 K：终端 / 实时状态监控 / 实时日志流
    console: pageConsole };
  (map[page] || pageOverview)();
}

/* ---------- 主题工坊 ---------- */
const FX_LABEL = { none: '无动画', bubbles: '气泡上浮', aurora: '极光漂移', waves: '波浪条纹' };
const FX_ORDER = ['none', 'bubbles', 'aurora', 'waves'];

function themeCssVarsCss(cssVars) {
  return Object.keys(cssVars || {}).map((k) => k + ':' + cssVars[k]).join(';');
}

async function loadTheme() {
  const r = await invoke(C.THEME_GET);
  if (!r || !r.ok) return null;
  themeState = { theme: r.theme, derived: r.derived, presets: r.presets || [] };
  applyThemeToPage(r.theme, r.derived);
  return themeState;
}

/** 把主题写进 CSS 变量并驱动背景动画。 */
function applyThemeToPage(theme, derived) {
  try {
    if (window.FeiyuTheme) window.FeiyuTheme.apply(theme, derived);
    else {
      // 主题脚本不可用时退化为只写变量（保证界面仍可读）
      const root = document.documentElement;
      const vars = (derived && derived.cssVars) || {};
      for (const k of Object.keys(vars)) root.style.setProperty(k, String(vars[k]));
    }
  } catch (_) {}
}

async function pageTheme() {
  content.innerHTML = '<h2>主题工坊</h2><div id="th"></div>';
  const box = $('#th');
  box.innerHTML = '<div class="hint">加载中…</div>';

  const st = await loadTheme();
  if (!st) { box.innerHTML = '<div class="hint err">主题不可用</div>'; return; }
  const t = st.theme;
  const presets = st.presets || [];

  const presetCards = presets.map((p) => `
    <button class="preset" data-preset="${esc(p.key)}">
      <div class="sw"><i style="background:${esc(p.bg)}"></i><i style="background:${esc(p.a)}"></i><i style="background:${esc(p.b)}"></i></div>
      <div class="pn">${esc(p.name)}</div>
      <div class="pc">${esc(p.bg)} / ${esc(p.a)} / ${esc(p.b)}</div>
    </button>`).join('');

  box.innerHTML = `
    <div class="section">
      <h3>配色方案预设</h3>
      <div class="hint">点击任一预设即可应用该配色（背景 / 主强调色 / 辅助强调色），其余颜色自动推算。</div>
      <div class="preset-grid" id="presetGrid">${presetCards}</div>
      <div class="row" style="margin-top:12px">
        <button class="btn" id="thApply">应用主题</button>
        <button class="btn sec" id="thReset">恢复默认</button>
      </div>
      <div class="hint" id="thMsg"></div>
    </div>

    <div class="section">
      <h3>自定义调色盘</h3>
      <div class="hint">可修改背景色、主强调色、辅助强调色；面板色、正文色、次要文字色由背景亮度自动推算（深色背景用浅色文字，浅色背景用深色文字）。</div>
      <div class="color-row">
        <input type="color" id="cBg" value="${esc(t.bg)}" />
        <div><div class="cn">背景色</div><div class="hint">${esc(t.bg)}</div></div>
      </div>
      <div class="color-row">
        <input type="color" id="cA" value="${esc(t.a)}" />
        <div><div class="cn">主强调色</div><div class="hint">${esc(t.a)}</div></div>
      </div>
      <div class="color-row">
        <input type="color" id="cB" value="${esc(t.b)}" />
        <div><div class="cn">辅助强调色</div><div class="hint">${esc(t.b)}</div></div>
      </div>
    </div>

    <div class="section">
      <h3>背景动画</h3>
      <label>动画效果</label>
      <select id="thFx">
        ${FX_ORDER.map((k) => `<option value="${k}"${t.fx === k ? ' selected' : ''}>${esc(FX_LABEL[k])}</option>`).join('')}
      </select>
      <div class="range-row">
        <span class="cn">动画速度</span>
        <input type="range" id="thSpeed" min="0.3" max="2.5" step="0.1" value="${t.speed}" />
        <span class="rv" id="thSpeedV">${t.speed}</span>
      </div>
      <div class="row" style="margin-top:8px;align-items:center">
        <input type="checkbox" id="thParallax" ${t.mouseParallax === false ? '' : 'checked'} style="width:auto" />
        <span class="cn">背景随鼠标移动（丝滑视差）</span>
      </div>
      <div class="hint">命中系统「减少动态效果」偏好时动画自动停止；窗口最小化或隐藏时也会暂停绘制。</div>
    </div>

    <div class="section">
      <h3>状态监控动画</h3>
      <label>跳动效果</label>
      <select id="thMonFx">
        <option value="breathe"${t.monFx === 'breathe' ? ' selected' : ''}>柔和呼吸（推荐）</option>
        <option value="pulse"${t.monFx === 'pulse' ? ' selected' : ''}>声波扩散</option>
        <option value="flow"${t.monFx === 'flow' ? ' selected' : ''}>流光扫过</option>
        <option value="min"${t.monFx === 'min' ? ' selected' : ''}>极简（不闪）</option>
      </select>
      <div class="hint">用于「终端与监控」页的运行状态卡片；跳动太晃时选「极简」即可完全静止，只保留颜色区分。</div>
    </div>

    <div class="section">
      <h3>外观</h3>
      <div class="range-row">
        <span class="cn">圆角</span>
        <input type="range" id="thRadius" min="4" max="28" step="1" value="${t.radius}" />
        <span class="rv" id="thRadiusV">${t.radius}px</span>
      </div>
      <div class="range-row">
        <span class="cn">毛玻璃模糊</span>
        <input type="range" id="thBlur" min="0" max="30" step="1" value="${t.blur}" />
        <span class="rv" id="thBlurV">${t.blur}px</span>
      </div>
    </div>

    <div class="section">
      <h3>预览</h3>
      <div class="preview-box" id="thPreview">
        <div class="pv-bar"></div>
        <div class="pv-bar2"></div>
        <div class="pv-text">正文示例：机器人运行正常</div>
        <div class="pv-muted">次要文字示例：用量来自机器人真实记录</div>
      </div>
    </div>

    <div class="section">
      <h3>导出与导入</h3>
      <div class="hint">导出为主题 JSON 文本，可复制到别处保存；导入会先校验，非法 JSON 不会改动当前主题。</div>
      <div class="row">
        <button class="btn sec" id="thExport">复制主题 JSON</button>
        <button class="btn sec" id="thImport">粘贴并应用主题</button>
      </div>
      <label>主题 JSON</label>
      <textarea id="thJson" style="min-height:160px" placeholder="在此粘贴主题 JSON，然后点「粘贴并应用主题」"></textarea>
      <div class="hint" id="thJsonMsg"></div>
    </div>`;

  // 当前编辑中的草稿（未保存）
  let draft = Object.assign({}, t);
  let presetKey = null;

  function syncDraftInputs() {
    $('#cBg').value = draft.bg;
    $('#cA').value = draft.a;
    $('#cB').value = draft.b;
    $('#thFx').value = draft.fx;
    $('#thSpeed').value = draft.speed;
    $('#thSpeedV').textContent = String(draft.speed);
    $('#thRadius').value = draft.radius;
    $('#thRadiusV').textContent = draft.radius + 'px';
    $('#thBlur').value = draft.blur;
    $('#thBlurV').textContent = draft.blur + 'px';
    if ($('#thMonFx')) $('#thMonFx').value = draft.monFx || 'breathe';
    if ($('#thParallax')) $('#thParallax').checked = draft.mouseParallax !== false;
  }

  async function saveDraft(msg) {
    const r = await invoke(C.THEME_SAVE, { theme: draft });
    if (!r || !r.ok) {
      $('#thMsg').innerHTML = '<span class="err">' + esc((r && r.error) || '保存失败') + '</span>';
      return false;
    }
    draft = Object.assign({}, r.theme);
    themeState = { theme: r.theme, derived: r.derived, presets: themeState ? themeState.presets : [] };
    applyThemeToPage(r.theme, r.derived);
    $('#thMsg').innerHTML = '<span class="ok">' + esc(msg || '主题已应用') + '</span>';
    return true;
  }

  // 预设点击 → 立刻应用
  box.querySelectorAll('[data-preset]').forEach((b) => b.onclick = async () => {
    const key = b.dataset.preset;
    const p = presets.find((x) => x.key === key);
    if (!p) return;
    presetKey = key;
    draft = Object.assign({}, draft, { bg: p.bg, a: p.a, b: p.b });
    syncDraftInputs();
    const ok = await saveDraft('已应用配色方案：' + p.name);
    if (ok) {
      box.querySelectorAll('.preset').forEach((x) => x.classList.toggle('active', x.dataset.preset === key));
      pageTheme();
    }
  });

  $('#cBg').oninput = (e) => { draft.bg = e.target.value; };
  $('#cA').oninput = (e) => { draft.a = e.target.value; };
  $('#cB').oninput = (e) => { draft.b = e.target.value; };
  $('#thFx').onchange = (e) => { draft.fx = e.target.value; };
  $('#thSpeed').oninput = (e) => { draft.speed = Number(e.target.value); $('#thSpeedV').textContent = String(draft.speed); };
  $('#thRadius').oninput = (e) => { draft.radius = Number(e.target.value); $('#thRadiusV').textContent = draft.radius + 'px'; };
  $('#thBlur').oninput = (e) => { draft.blur = Number(e.target.value); $('#thBlurV').textContent = draft.blur + 'px'; };
  if ($('#thMonFx')) $('#thMonFx').onchange = (e) => { draft.monFx = e.target.value; };
  if ($('#thParallax')) $('#thParallax').onchange = (e) => { draft.mouseParallax = !!e.target.checked; };

  $('#thApply').onclick = async () => { await saveDraft('主题已应用'); };
  $('#thReset').onclick = async () => {
    const r = await invoke(C.THEME_RESET);
    if (!r || !r.ok) { $('#thMsg').innerHTML = '<span class="err">' + esc((r && r.error) || '恢复失败') + '</span>'; return; }
    $('#thMsg').innerHTML = '<span class="ok">已恢复默认主题</span>';
    pageTheme();
  };
  $('#thExport').onclick = async () => {
    const r = await invoke(C.THEME_EXPORT);
    if (!r || !r.ok) { $('#thJsonMsg').innerHTML = '<span class="err">导出失败</span>'; return; }
    $('#thJson').value = r.json;
    $('#thJsonMsg').innerHTML = '<span class="ok">已生成主题 JSON，可复制保存</span>';
  };
  $('#thImport').onclick = async () => {
    const json = $('#thJson').value.trim();
    if (!json) { $('#thJsonMsg').innerHTML = '<span class="err">请先粘贴主题 JSON</span>'; return; }
    const r = await invoke(C.THEME_IMPORT, { json });
    if (!r || !r.ok) {
      // 非法 JSON → 当前主题保持不变
      $('#thJsonMsg').innerHTML = '<span class="err">导入失败：' + esc((r && r.error) || '格式不合法') + '（当前主题未改动）</span>';
      return;
    }
    $('#thJsonMsg').innerHTML = '<span class="ok">导入成功，主题已应用</span>';
    pageTheme();
  };
}

/* ---------- 总览 ---------- */
async function pageOverview() {
  content.innerHTML = '<h2>总览</h2><div id="ov"></div>';
  const box = $('#ov');
  box.innerHTML = '<div class="hint">加载中…</div>';
  const [st, cfg, usage] = await Promise.all([invoke(C.PROC_STATUS), invoke(C.CONFIG_READ), invoke(C.USAGE_GET, { range: 'today' })]);
  const s = st.status;
  const api = (cfg.config && cfg.config.api) || {};
  const person = (cfg.config && cfg.config.personality) || {};
  const u = usage.usage || {};
  box.innerHTML = `
    <div class="grid">
      <div class="card"><div class="k">AI 桥（3001）</div><div class="v">${statusBadge(s.bridge)}</div></div>
      <div class="card"><div class="k">NapCat（3000）</div><div class="v">${statusBadge(s.napcat)}</div></div>
      <div class="card"><div class="k">Provider / 模型</div><div class="v" style="font-size:15px">${esc(api.model || '未配置')}</div></div>
      <div class="card"><div class="k">人格</div><div class="v" style="font-size:15px">${esc(person.name || '未配置')}</div></div>
    </div>
    <div class="grid">
      <div class="card"><div class="k">今日请求(成功/失败)</div><div class="v" style="font-size:15px">${fmt(u.successRequests || 0)} <span class="muted">/</span> <span class="err">${fmt(u.failRequests || 0)}</span></div></div>
      <div class="card"><div class="k">今日总 Token</div><div class="v">${fmt(u.totalTokens)}</div></div>
      <div class="card"><div class="k">输入 / 输出</div><div class="v" style="font-size:15px">${fmt(u.promptTokens)} / ${fmt(u.completionTokens)}</div></div>
      <div class="card"><div class="k">缓存命中率</div><div class="v" style="font-size:15px">${u.cacheHitTokens + u.cacheMissTokens > 0 ? Math.round(u.cacheHitTokens / (u.cacheHitTokens + u.cacheMissTokens) * 100) + '%' : '—'}</div></div>
      <div class="card"><div class="k">估算费用</div><div class="v" style="font-size:15px">${u.cost && u.cost.priced ? '¥' + (u.cost.totalCost ?? 0) : '未计价'}</div></div>
    </div>
    <div class="section"><h3>最近日志</h3><div class="log" id="ovlog"></div></div>`;
  const log = await invoke(C.LOG_TAIL, { lines: 12 });
  $('#ovlog').textContent = (log.lines && log.lines.length) ? log.lines.join('\n') : '（暂无日志 / 未配置目录）';
}

/* ---------- 运行控制 ---------- */
async function pageRun() {
  content.innerHTML = '<h2>机器人运行</h2><div id="run"></div>';
  const box = $('#run');
  box.innerHTML = '<div class="hint">加载中…</div>';
  const st = (await invoke(C.PROC_STATUS)).status;
  const set = (await invoke(C.SETTINGS_GET)).settings || {};
  const bd = (await invoke(C.BOTDIR_STATUS)) || {};
  const napInfo = bd.napcat || {};
  const botDir = set.botDir || '';
  box.innerHTML = `
    <div class="section botdir-banner">
      <div class="row">
        <div><b>机器人目录：</b>${esc(botDir || '未配置')}</div>
        <button class="btn sec" id="pickBtn">选择目录…</button>
        ${botDir ? '' : '<span class="err">未配置：请先选择含 ai_bridge.js 的目录</span>'}
      </div>
    </div>
    <div class="section">
      <div class="row"><div>AI 桥： ${statusBadge(st.bridge)}</div><div>NapCat： ${statusBadge(st.napcat)}</div></div>
      <div class="row">
        <button class="btn" id="startBtn">启动</button>
        <button class="btn danger" id="stopBtn">停止</button>
        <button class="btn sec" id="restartBtn">重启</button>
      </div>
      <div class="hint" id="runMsg"></div>
    </div>
    <div class="section">
      <h3>NapCat 快速登录（推荐）</h3>
      <div class="row" style="align-items:center;gap:8px">
        <label>NapCat 目录</label>
        <span class="hint" style="flex:1">${esc(set.napcatDir || '未设置（将自动探测 D:\\NapCat 等）')}</span>
        <button class="btn sec" id="pickNcDir">选择 NapCat 目录…</button>
      </div>
      <div class="hint">NapCat 目录是含 <code>index.js</code> 和 <code>node.exe</code> 的那个文件夹（例如 <code>D:\\NapCat</code>），不是机器人代码仓库。</div>
      <div class="hint">OneBot 令牌：${napInfo.tokenFound ? '<span class="ok">已找到（启动 AI 桥时自动注入）</span>' : '<span class="err">未找到——机器人会收得到消息但发不出去，请检查 NapCat 的 access_token</span>'}</div>
      <label>QQ 号</label><input id="ncAcc" value="${esc(set.napcat && set.napcat.account || '')}" placeholder="你的 QQ 号" />
      <label>QQ 密码</label><input id="ncPwd" type="password" placeholder="填 QQ 密码（自动转 MD5，不保存明文）" />
      <div class="row" style="margin-top:8px"><button class="btn" id="ncStart">只启动 NapCat（登录 QQ）</button></div>
      <div class="hint">只登录 QQ，不依赖 AI 桥 / API Key，最快。</div>
    </div>
    <div class="section">
      <h3>导入他人的 QQ 机器人（兼容多种结构）</h3>
      <div class="hint">选一个机器人目录，自动识别入口（ai_bridge.js / index.js / app.js / package.json / Koishi 等），兼容不同人的项目结构。</div>
      <div class="row"><button class="btn sec" id="impBot">选择并检测机器人目录…</button></div>
      <div id="impMsg"></div>
    </div>
    <div class="section"><h3>启动输出 / 日志</h3><div class="log" id="runlog"></div></div>`;
  const log = await invoke(C.LOG_TAIL, { lines: 20 });
  $('#runlog').textContent = (log.lines && log.lines.length) ? log.lines.join('\n') : '（暂无日志）';

  function readNapcat() {
    const acc = (($('#ncAcc') && $('#ncAcc').value) || '').trim() || (set.napcat && set.napcat.account) || '';
    const pwd = ($('#ncPwd') && $('#ncPwd').value) || '';
    const md5 = pwd ? md5hex(pwd) : ((set.napcat && set.napcat.passwordMd5) || '');
    return acc ? { account: acc, passwordMd5: md5 } : null;
  }
  $('#startBtn').onclick = async () => {
    const napcat = readNapcat();
    const r = await invoke(C.PROC_START, { napcat });
    if (r.ok && r.starting) $('#runMsg').innerHTML = '<span class="hint">正在启动（PID=' + (r.pids || []).join(',') + '），稍候看监控</span>';
    else if (r.ok) $('#runMsg').innerHTML = '<span class="ok">已确认启动，PID=' + (r.pids || []).join(',') + (r.note ? '；' + esc(r.note) : '') + '</span>';
    else {
      const d = (r.failed && r.failed.length) ? esc(r.failed.map((f) => f.id + ' ' + (f.error || '')).join('；')) : esc(r.error || '启动失败');
      $('#runMsg').innerHTML = '<span class="err">启动失败：' + d + '</span>';
    }
    setTimeout(pageRun, 1500);
  };
  $('#stopBtn').onclick = async () => {
    const r = await invoke(C.PROC_STOP, {});
    $('#runMsg').innerHTML = r.ok ? '<span class="ok">已停止' + (r.nothing ? '（本就未运行）' : (r.forced ? '（已强制）' : '')) + '</span>' : '<span class="err">' + esc(r.error) + '</span>';
    setTimeout(pageRun, 1500);
  };
  $('#restartBtn').onclick = async () => {
    await invoke(C.PROC_STOP, {});
    setTimeout(async () => {
      const napcat = readNapcat();
      await invoke(C.PROC_START, { napcat, force: true });
      pageRun();
    }, 1200);
  };
  const ncStart = $('#ncStart');
  if (ncStart) ncStart.onclick = async () => {
    const napcat = readNapcat();
    if (!napcat) { $('#runMsg').innerHTML = '<span class="err">请先填 QQ 号</span>'; return; }
    await invoke(C.SETTINGS_SET, { napcat });
    $('#runMsg').innerHTML = '<span class="hint">正在启动 NapCat 并校验端口 3000…</span>';
    const r = await invoke(C.PROC_START, { only: 'napcat', napcat });
    if (r.ok) $('#runMsg').innerHTML = '<span class="ok">' + esc(r.note || 'NapCat 已启动') + '</span>';
    else {
      const d = (r.failed && r.failed.length) ? esc(r.failed.map((f) => f.id + ' ' + (f.error || '')).join('；')) : esc(r.error || '启动失败');
      $('#runMsg').innerHTML = '<span class="err">NapCat 启动失败：' + d + '</span>';
    }
    setTimeout(pageRun, 1500);
  };

  const impBot = $('#impBot');
  if (impBot) impBot.onclick = async () => {
    const pick = await invoke(C.DIALOG_PICKDIR);
    if (!pick || !pick.ok || !pick.dir) return;
    const insp = await invoke(C.BOT_INSPECT, { dir: pick.dir });
    if (!insp || !insp.ok) { $('#impMsg').innerHTML = '<span class="err">' + esc((insp && insp.error) || '检测失败') + '</span>'; return; }
    if (!insp.compatible) { $('#impMsg').innerHTML = '<span class="warn">未能识别入口（' + esc((insp.notes || []).join('；')) + '）。仍可设为目录，但启动可能失败。</span>'; return; }
    const s = await invoke(C.SETTINGS_SET, { botDir: pick.dir, botEntry: insp.suggestedEntry || 'ai_bridge.js', napcatEntry: insp.napcatEntry || 'index.js' });
    $('#impMsg').innerHTML = s.ok ? '<span class="ok">已导入：类型 ' + esc(insp.kind) + '，入口 ' + esc(insp.suggestedEntry || '—') + '</span>' : '<span class="err">' + esc(s.error) + '</span>';
    if (s.ok) setTimeout(pageRun, 800);
  };

  const pickNcDir = $('#pickNcDir');
  if (pickNcDir) pickNcDir.onclick = async () => {
    const pick = await invoke(C.DIALOG_PICKDIR);
    if (!pick || !pick.ok || !pick.dir) return;
    const insp = await invoke(C.BOT_INSPECT, { dir: pick.dir });
    if (insp && insp.ok && !insp.entries.includes('index.js')) {
      $('#runMsg').innerHTML = '<span class="warn">该目录没有 index.js，可能不是 NapCat 目录（NapCat 目录应含 index.js 与 node.exe）。</span>';
    }
    const s = await invoke(C.SETTINGS_SET, { napcatDir: pick.dir });
    $('#runMsg').innerHTML = s.ok ? '<span class="ok">已设置 NapCat 目录：' + esc(pick.dir) + '</span>' : '<span class="err">' + esc(s.error) + '</span>';
    if (s.ok) setTimeout(pageRun, 700);
  };

  $('#pickBtn').onclick = async () => { const d = await pickBotDir(); if (d) pageRun(); };
}

/* ---------- API 与模型（含多 Provider 管理） ---------- */
async function pageApi() {
  content.innerHTML = '<h2>API 与模型</h2><div id="ap"></div>';
  const box = $('#ap');
  box.innerHTML = '<div class="hint">加载中…</div>';
  const cfg = await invoke(C.CONFIG_READ);
  const sec = await invoke(C.SECRET_HAS_KEY);
  const pl = await invoke(C.PROVIDER_LIST);
  const cred = await invoke(C.CREDENTIAL_STATUS).catch(() => null);
  const api = (cfg.config && cfg.config.api) || {};
  const providers = pl.providers || [];
  const appliedId = pl.appliedId, def = pl.default;

  box.innerHTML = `
    <div class="section">
      <h3>Provider 列表（多 Provider 管理）</h3>
      <div class="hint">桌面维护一个 Provider 注册表；「应用」把选中 Provider 写回现有 ai_config.json(api) + secrets.json(apiKey)，复用原单 Provider 请求系统（不建第二套）。切换后需重启 AI 桥生效。密钥不进注册表明文。</div>
      <div id="pList"></div>
      ${pl.migrated ? '<div class="ok">已从现有配置兼容迁移生成默认 Provider。</div>' : ''}
    </div>
    <div class="section">
      <h3 id="pFormTitle">接入大模型（三步）</h3>
      <div class="row" style="flex-wrap:wrap;gap:10px;align-items:flex-end">
        <label>① 选服务商</label>
        <select id="pPreset" style="min-width:200px">
          <option value="">自定义 / 其他…</option>
          ${PROVIDER_PRESETS.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
        </select>
      </div>
      <div class="hint">选好服务商后，下面的地址和模型会自动填好，你只把 API Key 粘进来就行。</div>
      <label>名称</label><input id="pName" placeholder="如 DeepSeek" />
      <label>Base URL（OpenAI 兼容 /chat/completions）</label><input id="pBase" placeholder="https://api.deepseek.com/v1/chat/completions" />
      <label>主模型</label><input id="pModel" placeholder="deepseek-chat" />
      <label>API Key（只存你本机，不进配置明文）</label><input id="pKey" type="password" placeholder="sk-..." />
      <details class="adv"><summary>高级选项（一般用不到）</summary>
        <label>推理模型（可选）</label><input id="pRModel" placeholder="deepseek-reasoner" />
        <label>超时(ms)</label><input id="pTimeout" type="number" value="30000" />
        <label>重试次数</label><input id="pRetry" type="number" value="2" />
      </details>
      <div class="row"><button class="btn" id="pSave">保存并应用</button><button class="btn sec" id="pCancel" style="display:none">取消编辑</button></div>
      <div class="hint" id="pMsg"></div>
    </div>
    <div class="section">
      <h3>当前应用的 API 配置（ai_config.json）</h3>
      <div class="hint">Base URL：<code>${esc(api.baseUrl || '—')}</code><br>主模型：<code>${esc(api.model || '—')}</code> ｜ 推理：<code>${esc(api.reasoningModel || '—')}</code></div>
      <div class="hint">密钥状态：${sec.hasKey ? '<span class="ok">已配置</span>' : '<span class="err">未配置</span>'}</div>
    </div>
    <div class="section">
      <h3>凭据安全</h3>
      <div class="hint">${cred ? esc(cred.note || '') : '凭据状态不可用'}</div>
      <div class="hint">系统凭据（safeStorage / DPAPI）：${cred && cred.systemEncryption ? '<span class="ok">可用</span>' : '<span class="err">不可用</span>'}
        ｜ 桌面 Provider 密钥：${cred && cred.encrypted ? '<span class="ok">已加密</span>' : '<span class="err">明文</span>'}</div>
      <div class="row"><button class="btn sec" id="credMigrate">迁移到系统凭据存储</button></div>
      <div class="hint">迁移会先把明文备份到 botDir/backups/（已 gitignore），加密写入后回读校验；校验失败自动回滚，不删除原备份。机器人自身的 secrets.json 保持明文（bot 进程需要明文调用 API），不在本次迁移范围。</div>
      <div class="hint" id="credMsg"></div>
    </div>`;

  const listEl = $('#pList');
  if (!providers.length) {
    listEl.innerHTML = '<div class="hint">暂无 Provider。可用上方表单新增，或在「机器人运行」选好目录后由现有配置自动迁移。</div>';
  } else {
    listEl.innerHTML = '<table><thead><tr><th>名称</th><th>模型</th><th>Base URL</th><th>密钥</th><th>默认</th><th>当前</th><th>操作</th></tr></thead><tbody>' +
      providers.map((p) => `<tr>
        <td>${esc(p.name)}</td>
        <td class="muted">${esc(p.model)}</td>
        <td class="muted">${esc(shortUrl(p.baseUrl))}</td>
        <td>${p.hasKey ? '<span class="ok">有</span>' : '<span class="err">无</span>'}</td>
        <td>${p.id === def ? '★' : ''}</td>
        <td>${p.id === appliedId ? '<span class="ok">已应用</span>' : ''}</td>
        <td class="row" style="gap:4px">
          <button class="btn sec sm" data-act="edit" data-id="${p.id}">编辑</button>
          <button class="btn sec sm" data-act="test" data-id="${p.id}">测试</button>
          <button class="btn sec sm" data-act="apply" data-id="${p.id}">应用</button>
          <button class="btn sec sm" data-act="default" data-id="${p.id}">默认</button>
          <button class="btn danger sm" data-act="del" data-id="${p.id}">删</button>
        </td>
      </tr>`).join('') + '</tbody></table>';
  }

  function fillForm(p) {
    if (!p) return;
    editPid = p.id;
    $('#pFormTitle').textContent = '编辑 Provider：' + p.name;
    $('#pName').value = p.name; $('#pBase').value = p.baseUrl; $('#pModel').value = p.model;
    $('#pRModel').value = p.reasoningModel || ''; $('#pTimeout').value = p.timeoutMs || 30000; $('#pRetry').value = p.maxRetries != null ? p.maxRetries : 2;
    $('#pKey').value = '';
    $('#pCancel').style.display = '';
    $('#pMsg').innerHTML = '<span class="hint">密钥留空则保留原值。</span>';
  }
  listEl.querySelectorAll('button[data-act]').forEach((b) => b.onclick = async () => {
    const act = b.dataset.act, id = b.dataset.id;
    if (act === 'edit') fillForm(providers.find((x) => x.id === id));
    else if (act === 'del') { if (!confirm('删除该 Provider？其密钥一并删除。')) return; const r = await invoke(C.PROVIDER_DELETE, { id }); $('#pMsg').innerHTML = r.ok ? '<span class="ok">已删除</span>' : '<span class="err">' + esc(r.error) + '</span>'; pageApi(); }
    else if (act === 'default') { const r = await invoke(C.PROVIDER_SET_DEFAULT, { id }); $('#pMsg').innerHTML = r.ok ? '<span class="ok">已设为默认</span>' : '<span class="err">' + esc(r.error) + '</span>'; pageApi(); }
    else if (act === 'apply') { await previewAndApply(id); }
    else if (act === 'test') await testProvider(id);
  });
  $('#pCancel').onclick = () => { editPid = null; pageApi(); };
  const presetSel = $('#pPreset');
  if (presetSel) presetSel.onchange = () => {
    const p = PROVIDER_PRESETS.find((x) => x.id === presetSel.value);
    if (!p) return;
    $('#pName').value = p.name; $('#pBase').value = p.base; $('#pModel').value = p.model; $('#pRModel').value = p.reasoning || '';
    if (!p.base) $('#pBase').focus();
  };
  $('#pSave').onclick = async () => {
    const provider = {
      name: $('#pName').value.trim(), baseUrl: $('#pBase').value.trim(), model: $('#pModel').value.trim(),
      reasoningModel: $('#pRModel').value.trim(), timeoutMs: Number($('#pTimeout').value), maxRetries: Number($('#pRetry').value),
    };
    const key = $('#pKey').value;
    if (!provider.name || !provider.baseUrl || !provider.model) {
      $('#pMsg').innerHTML = '<span class="err">请至少填好名称、Base URL、主模型（选服务商可自动填）</span>';
      return;
    }
    if (key) provider.key = key;
    if (editPid) provider.id = editPid;
    const r = await invoke(C.PROVIDER_SAVE, { provider });
    if (!r.ok) { $('#pMsg').innerHTML = '<span class="err">' + esc((r.errors || []).join('；') || r.error) + '</span>'; return; }
    // 普通玩家路径：保存后自动应用为当前使用的模型，少点一次
    const ap = await invoke(C.PROVIDER_APPLY, { id: r.id });
    $('#pMsg').innerHTML = (ap.ok ? '<span class="ok">已保存并设为当前模型' : '<span class="ok">已保存</span><br><span class="hint">应用失败，可在列表中手动「应用」：' + esc(ap.error || '')) + '</span>';
    editPid = null; pageApi();
  };
  const mig = $('#credMigrate');
  if (mig) mig.onclick = async () => {
    if (!confirm('把桌面 Provider 密钥迁移到系统凭据存储（safeStorage/DPAPI）？\n迁移前会自动备份明文到 botDir/backups/，校验失败自动回滚。')) return;
    $('#credMsg').innerHTML = '<span class="hint">迁移中…</span>';
    const r = await invoke(C.CREDENTIAL_MIGRATE);
    if (r.ok) $('#credMsg').innerHTML = '<span class="ok">迁移完成并已回读校验。备份：' + esc(r.backupDir || '—') + '</span>';
    else $('#credMsg').innerHTML = '<span class="err">' + esc(r.error || '迁移失败') + '</span>';
  };
}

/* 应用 Provider 前先展示差异预览，再确认写入（写入自动备份 + 失败回滚） */
async function previewAndApply(id) {
  const pv = await invoke(C.PROVIDER_PREVIEW, { id });
  if (!pv.ok) { $('#pMsg').innerHTML = '<span class="err">' + esc(pv.error) + '</span>'; return; }
  const diff = pv.diff || {};
  const rows = Object.keys(diff).map((k) => `<tr><td>${esc(k)}</td><td class="muted">${esc(diff[k].from === null ? '—' : String(diff[k].from))}</td><td>${esc(diff[k].to === null ? '—' : String(diff[k].to))}</td></tr>`).join('');
  const html = `<div class="section"><h3>应用前差异预览</h3>
    ${rows ? `<table><thead><tr><th>字段</th><th>当前</th><th>目标</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="hint">当前配置与该 Provider 一致（仅密钥可能不同）。</div>'}
    <div class="hint">密钥：${pv.secretChanged ? '将更换（不回显明文）' : '保持不变'}</div>
    <div class="hint">${esc(pv.note || '')}</div>
    <div class="row"><button class="btn" id="pvOk">确认应用</button><button class="btn sec" id="pvCancel">取消</button></div></div>`;
  const holder = document.createElement('div');
  holder.innerHTML = html;
  $('#pMsg').parentNode.insertBefore(holder, $('#pMsg'));
  const done = () => { holder.remove(); };
  $('#pvCancel').onclick = done;
  $('#pvOk').onclick = async () => {
    const r = await invoke(C.PROVIDER_APPLY, { id });
    done();
    if (r.ok) {
      $('#pMsg').innerHTML = '<span class="ok">' + esc(r.note) + (r.backupDir ? '（备份：' + esc(r.backupDir) + '）' : '') + '</span>';
    } else {
      $('#pMsg').innerHTML = '<span class="err">' + esc(r.error) + (r.rolledBack ? '（已回滚到原配置）' : '') + '</span>';
    }
    pageApi();
  };
}

async function testProvider(id) {
  if (!confirm('测试会向该 Provider 真实发送一条最小 chat completion（max_tokens=1），可能产生极少量费用。继续？')) return;
  $('#pMsg').innerHTML = '<span class="hint">测试中…</span>';
  const r = await invoke(C.PROVIDER_TEST, { id });
  if (!r.ok) { $('#pMsg').innerHTML = '<span class="err">' + esc(r.error) + '</span>'; return; }
  const res = r.result || {};
  let msg = '可达=' + (res.reachable ? '是' : '否') + ' ｜ 协议可用=' + (res.protocolOk ? '是' : '否');
  if (res.modelList && res.modelList.length) msg += ' ｜ 模型数=' + res.modelList.length;
  if (res.error) msg += ' ｜ 错误：' + esc(res.error);
  $('#pMsg').innerHTML = (res.protocolOk ? '<span class="ok">' : '<span class="err">') + esc(msg) + '</span>' + (res.protocolOk ? '' : '<br>该接口未返回 OpenAI 兼容结构（choices[0].message.content），不能标记为可用。');
}

/* ---------- 用量明细（筛选 / 状态 / 耗时 / CSV / 价格 / 空与未知状态） ---------- */
const rangeLabel = (r) => ({ today: '今日', yesterday: '昨日', '7d': '近7天', month: '本月', all: '全部' }[r] || r);
async function pageUsage() {
  content.innerHTML = '<h2>用量明细</h2><div class="row" id="urange">' +
    ['today', 'yesterday', '7d', 'month', 'all'].map((r) => `<button class="btn sec" data-r="${r}">${rangeLabel(r)}</button>`).join('') +
    '</div><div id="us"></div>';
  const load = async (range) => {
    const box = $('#us'); box.innerHTML = '<div class="hint">加载中…</div>';
    const [ru, rp] = await Promise.all([invoke(C.USAGE_GET, { range }), invoke(C.PRICE_GET)]);
    usageCurrent = ru.usage || {};
    usagePrice = rp.price || null;
    renderUsage(usageCurrent, usagePrice);
  };
  document.querySelectorAll('#urange button').forEach((b) => b.onclick = () => load(b.dataset.r));
  await load('today');
}

function renderUsage(u, price) {
  const box = $('#us');
  if (!box) return;
  const reqs = u.recentRequests || [];
  const cost = u.cost || {};
  const providers = [...new Set(reqs.map((x) => x.provider || 'unknown'))];
  const models = [...new Set(reqs.map((x) => x.model || 'unknown'))];
  const filtered = reqs.filter((x) =>
    (!usageFilter.provider || (x.provider || 'unknown') === usageFilter.provider) &&
    (!usageFilter.model || (x.model || 'unknown') === usageFilter.model) &&
    (!usageFilter.status || (x.status || 'success') === usageFilter.status));
  const empty = reqs.length === 0;
  const costLabel = cost.priced ? ('¥' + fmt(cost.totalCost) + (cost.priceVersion ? ' <small>' + esc(cost.priceVersion) + '</small>' : ''))
    : (cost.reason === 'unknown_model' ? '未定价' : '未计价');

  box.innerHTML = `
    <div class="row" style="flex-wrap:wrap;gap:8px;align-items:center">
      <label>Provider</label><select id="fProv"><option value="">全部</option>${providers.map((p) => `<option value="${esc(p)}" ${usageFilter.provider === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>
      <label>模型</label><select id="fModel"><option value="">全部</option>${models.map((m) => `<option value="${esc(m)}" ${usageFilter.model === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>
      <label>状态</label><select id="fStatus"><option value="">全部</option><option value="success" ${usageFilter.status === 'success' ? 'selected' : ''}>成功</option><option value="error" ${usageFilter.status === 'error' ? 'selected' : ''}>失败</option></select>
      <button class="btn sec" id="csvBtn">导出 CSV</button>
      <button class="btn sec" id="fReset">重置筛选</button>
    </div>
    <div class="grid">
      <div class="card"><div class="k">总 Token</div><div class="v">${fmt(u.totalTokens)}</div></div>
      <div class="card"><div class="k">输入 / 输出</div><div class="v" style="font-size:15px">${fmt(u.promptTokens)} / ${fmt(u.completionTokens)}</div></div>
      <div class="card"><div class="k">推理 Token</div><div class="v">${fmt(u.reasoningTokens)}</div></div>
      <div class="card"><div class="k">缓存命中 / 未命中</div><div class="v" style="font-size:15px">${fmt(u.cacheHitTokens)} / ${fmt(u.cacheMissTokens)}</div></div>
      <div class="card"><div class="k">成功 / 失败</div><div class="v" style="font-size:15px"><span class="ok">${fmt(u.successRequests)}</span> / <span class="err">${fmt(u.failRequests)}</span></div></div>
      <div class="card"><div class="k">平均耗时(ms)</div><div class="v">${u.durationMs && u.durationMs.avg != null ? fmt(u.durationMs.avg) : '—'}</div></div>
      <div class="card"><div class="k">估算费用（非账单）</div><div class="v" style="font-size:15px">${costLabel}</div></div>
      <div class="card"><div class="k">数据源</div><div class="v" style="font-size:14px">${esc(u.source || '—')}</div></div>
    </div>
    ${empty ? '<div class="hint">该范围暂无数据（空状态）。用量来自机器人真实记录，缺失不伪造补齐。</div>' : ''}
    ${!empty && !filtered.length ? '<div class="hint">当前筛选无匹配记录。</div>' : ''}
    <div class="section"><h3>请求明细（共 ${fmt(reqs.length)} 条，筛选后 ${fmt(filtered.length)}）</h3>
      <div class="scroll">
      <table><thead><tr><th>时间</th><th>状态</th><th>类型</th><th>Provider</th><th>模型</th><th class="num">输入</th><th class="num">输出</th><th class="num">推理</th><th class="num">缓存命中</th><th class="num">合计</th><th class="num">耗时</th><th>错误类别</th><th class="num">费用</th></tr></thead>
      <tbody>${filtered.length ? filtered.map(rowHtml).join('') : '<tr><td colspan="13" class="muted">无匹配记录</td></tr>'}</tbody></table>
      </div>
      <div class="hint">${u.source === 'files' ? '数据来自 memory/usage/*.jsonl（不含聊天内容与 Key）。' : '数据来自运行中的机器人 /api/usage。'}${cost.priced ? '' : ' 未配置价格表 → 费用显示「未计价/未定价」。'} 估算值非服务商实际账单；无账单接口时绝不声称显示实际账单。</div>
    </div>
    ${priceEditorHtml(price)}`;

  $('#fProv').onchange = (e) => { usageFilter.provider = e.target.value; renderUsage(u, price); };
  $('#fModel').onchange = (e) => { usageFilter.model = e.target.value; renderUsage(u, price); };
  $('#fStatus').onchange = (e) => { usageFilter.status = e.target.value; renderUsage(u, price); };
  $('#fReset').onclick = () => { usageFilter = { provider: '', model: '', status: '' }; renderUsage(u, price); };
  $('#csvBtn').onclick = () => downloadCSV(filtered);
  wirePriceEditor();
}

function rowHtml(x) {
  const st = x.status || 'success';
  const unk = (v) => (v == null ? '—' : fmt(v));
  return `<tr>
    <td class="muted">${esc((x.time || '').replace('T', ' ').slice(5, 16))}</td>
    <td><span class="pill ${st === 'error' ? 'err' : 'ok'}">${st === 'error' ? '失败' : '成功'}</span></td>
    <td><span class="pill">${esc(x.kind)}</span></td>
    <td class="muted">${esc(x.provider || 'unknown')}</td>
    <td class="muted">${esc(x.model)}</td>
    <td class="num">${unk(x.prompt_tokens)}</td>
    <td class="num">${unk(x.completion_tokens)}</td>
    <td class="num">${unk(x.reasoning_tokens)}</td>
    <td class="num">${unk(x.cache_hit_tokens)}</td>
    <td class="num"><b>${unk(x.total_tokens)}</b></td>
    <td class="num">${x.durationMs != null ? fmt(x.durationMs) : '—'}</td>
    <td class="muted">${esc(x.errorCategory || '')}</td>
    <td class="num">${x._cost && x._cost.priced ? '¥' + x._cost.cost : '—'}</td>
  </tr>`;
}

/* ---------- 价格表编辑器 ---------- */
function priceEditorHtml(price) {
  price = price || {};
  const models = price.models || {};
  const keys = Object.keys(models);
  return `<div class="section"><h3>费用估算价格表（估算值，非服务商实际账单）</h3>
    <div class="row" style="gap:8px;flex-wrap:wrap">
      <label>版本</label><input id="prVer" value="${esc(price.version || '')}" placeholder="如 2026-10-01" style="width:120px" />
      <label>币种</label><select id="prCur"><option value="CNY" ${price.currency !== 'USD' ? 'selected' : ''}>CNY</option><option value="USD" ${price.currency === 'USD' ? 'selected' : ''}>USD</option></select>
      <label>计价单位</label><select id="prUnit"><option value="M" ${(price.unit || 'M') === 'M' ? 'selected' : ''}>每百万</option><option value="K" ${price.unit === 'K' ? 'selected' : ''}>每千</option><option value="1" ${price.unit === '1' ? 'selected' : ''}>每个</option><option value="B" ${price.unit === 'B' ? 'selected' : ''}>每十亿</option></select>
    </div>
    <table id="prTbl"><thead><tr><th>模型</th><th>输入单价</th><th>输出单价</th><th>缓存命中单价</th><th></th></tr></thead><tbody>
      ${keys.length ? keys.map((m) => prRow(m, models[m])).join('') : '<tr><td colspan="5" class="muted">暂无模型价格（点「加载示例」或「添加模型」）</td></tr>'}
    </tbody></table>
    <div class="row"><button class="btn sec" id="prAdd">添加模型</button><button class="btn sec" id="prExample">加载示例</button><button class="btn" id="prSave">保存价格表</button></div>
    <div class="hint" id="prMsg"></div>
    <div class="hint">单价按所选计价单位与币种。模型未知或缺失价格 → 显示「未定价」，不显示为免费。缓存命中按 cacheHit 单价（通常低于输入）。历史价格变化：在模型下追加 history（effectiveFrom + input/output），估算时按记录时间套用对应版本。</div>
  </div>`;
}
function prRow(m, p) {
  return `<tr data-m="${esc(m)}"><td>${esc(m)}</td>
   <td><input class="prin" value="${p.input != null ? p.input : ''}" style="width:90px" /></td>
   <td><input class="prout" value="${p.output != null ? p.output : ''}" style="width:90px" /></td>
   <td><input class="prch" value="${p.cacheHit != null ? p.cacheHit : ''}" style="width:90px" /></td>
   <td><button class="btn danger sm prdel">删</button></td></tr>`;
}
function wirePriceEditor() {
  const tbl = () => $('#prTbl').querySelector('tbody');
  $('#prAdd').onclick = () => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input class="prm" placeholder="模型名" style="width:150px" /></td><td><input class="prin" style="width:90px" /></td><td><input class="prout" style="width:90px" /></td><td><input class="prch" style="width:90px" /></td><td><button class="btn danger sm prdel">删</button></td>`;
    tbl().appendChild(tr);
    tr.querySelector('.prdel').onclick = () => tr.remove();
  };
  $('#prExample').onclick = () => {
    const ex = { version: new Date().toISOString().slice(0, 10), currency: 'CNY', unit: 'M', models: { 'deepseek-chat': { input: 1.0, output: 2.0, cacheHit: 0.1 }, 'deepseek-reasoner': { input: 4.0, output: 16.0, cacheHit: 1.0 } } };
    const body = tbl(); body.innerHTML = Object.keys(ex.models).map((m) => prRow(m, ex.models[m])).join('');
    body.querySelectorAll('.prdel').forEach((b) => b.onclick = () => b.closest('tr').remove());
    $('#prVer').value = ex.version; $('#prCur').value = ex.currency; $('#prUnit').value = ex.unit;
  };
  document.querySelectorAll('.prdel').forEach((b) => b.onclick = () => b.closest('tr').remove());
  $('#prSave').onclick = async () => {
    const rows = [...document.querySelectorAll('#prTbl tbody tr')];
    const models = {};
    for (const tr of rows) {
      const m = (tr.dataset.m && tr.dataset.m !== 'undefined') ? tr.dataset.m : (tr.querySelector('.prm') ? tr.querySelector('.prm').value.trim() : '');
      if (!m) continue;
      const input = parseFloat(tr.querySelector('.prin').value);
      const output = parseFloat(tr.querySelector('.prout').value);
      const chv = tr.querySelector('.prch').value;
      if (isNaN(input) || isNaN(output)) { $('#prMsg').innerHTML = '<span class="err">' + esc(m) + ' 的单价必须是数字</span>'; return; }
      const o = { input, output };
      if (chv !== '' && !isNaN(parseFloat(chv))) o.cacheHit = parseFloat(chv);
      models[m] = o;
    }
    const table = { version: $('#prVer').value.trim(), currency: $('#prCur').value, unit: $('#prUnit').value, models };
    const r = await invoke(C.PRICE_SET, { table });
    $('#prMsg').innerHTML = r.ok ? '<span class="ok">价格表已保存</span>' : '<span class="err">' + esc(r.error) + '</span>';
  };
}

/* ---------- 人格设置（含模板库，模板与运行配置分离） ---------- */
async function pagePersonality() {
  content.innerHTML = '<h2>人格设置</h2><div id="ps"></div>';
  const box = $('#ps');
  box.innerHTML = '<div class="hint">加载中…</div>';
  const [pr, tl] = await Promise.all([invoke(C.PERSONALITY_READ), invoke(C.PERSONALITY_TEMPLATE_LIST)]);
  const templates = (tl.templates || []);
  const consistency = tl.consistency;
  const consistencyBadge = consistency === 'match'
    ? '<span class="badge on">与当前模板一致</span>'
    : consistency === 'diverged' ? '<span class="badge err">与当前模板不一致（已偏离）</span>'
    : '<span class="badge off">尚未选定模板</span>';

  box.innerHTML = `
    <div class="section">
      <h3>当前生效人格（ai_prompt.txt）</h3>
      <div class="hint">机器人每次请求重新读取该文件，保存即时生效，无需重启。${consistencyBadge} 当前模板：${esc(tl.activeName || '—')}</div>
      <label>系统提示词 / 人格</label>
      <textarea id="prompt">${esc(pr.content || '')}</textarea>
      <div class="row"><button class="btn" id="saveP">直接保存人格</button><span class="hint">直接写入 ai_prompt.txt，影响机器人实际行为。</span></div>
      <div class="hint" id="pMsg"></div>
    </div>
    <div class="section">
      <h3>人格模板库（与运行配置分离）</h3>
      <div class="hint">模板只存于 feiyu_personalities.json，编辑模板不会改动运行中的人格。「保存模板」仅入库；「应用」才会写入 ai_prompt.txt（先自动备份，失败保留原文件）。</div>
      <table id="tList"><thead><tr><th>名称</th><th>当前</th><th>长度</th><th>操作</th></tr></thead><tbody>
        ${templates.length ? templates.map((t) => `<tr>
          <td>${esc(t.name)}</td>
          <td>${t.isActive ? '★' : ''}</td>
          <td class="muted">${fmt(t.contentLen)}</td>
          <td class="row" style="gap:4px">
            <button class="btn sec sm" data-act="edit" data-id="${t.id}">编辑</button>
            <button class="btn sec sm" data-act="copy" data-id="${t.id}">复制</button>
            <button class="btn sec sm" data-act="rename" data-id="${t.id}">重命名</button>
            <button class="btn sec sm" data-act="active" data-id="${t.id}">设当前</button>
            <button class="btn sec sm" data-act="diff" data-id="${t.id}">预览差异</button>
            <button class="btn sec sm" data-act="apply" data-id="${t.id}">应用</button>
            <button class="btn danger sm" data-act="del" data-id="${t.id}">删</button>
          </td>
        </tr>`).join('') : '<tr><td colspan="4" class="muted">暂无模板。可在下方保存当前人格为模板，或编辑新建。</td></tr>'}
      </tbody></table>
    </div>
    <div class="section">
      <h3 id="tFormTitle">保存为新模板</h3>
      <div class="row"><label style="margin:0">名称</label><input id="tName" placeholder="如 毒舌肥鱼 / 温柔助手" style="max-width:260px" /></div>
      <label>模板内容（默认填入当前生效人格）</label>
      <textarea id="tContent">${esc(pr.content || '')}</textarea>
      <div class="row">
        <button class="btn" id="tSave">保存模板</button>
        <button class="btn sec" id="tSaveCurrent">把当前人格存为模板</button>
        <button class="btn sec" id="tCancel" style="display:none">取消编辑</button>
      </div>
      <div class="hint" id="tMsg"></div>
    </div>
    <div class="section" id="diffBox" style="display:none"><h3>差异预览（模板 vs 当前生效人格）</h3><div class="log" id="diffOut"></div></div>`;

  let editTid = null;
  $('#saveP').onclick = async () => {
    const rr = await invoke(C.PERSONALITY_WRITE, { content: $('#prompt').value });
    $('#pMsg').innerHTML = rr.ok ? '<span class="ok">已保存（即时生效）</span>' : '<span class="err">' + esc(rr.error) + '</span>';
    if (rr.ok) setTimeout(pagePersonality, 400);
  };
  $('#tSaveCurrent').onclick = async () => {
    const name = '模板 ' + new Date().toLocaleString('zh-CN');
    const r = await invoke(C.PERSONALITY_TEMPLATE_SAVE, { template: { name, content: $('#prompt').value } });
    $('#tMsg').innerHTML = r.ok ? '<span class="ok">已保存为模板：' + esc(name) + '</span>' : '<span class="err">' + esc((r.errors || []).join('；') || r.error) + '</span>';
    if (r.ok) pagePersonality();
  };
  $('#tSave').onclick = async () => {
    const name = $('#tName').value.trim();
    if (!name) { $('#tMsg').innerHTML = '<span class="err">请填写模板名称</span>'; return; }
    const tpl = { name, content: $('#tContent').value };
    if (editTid) tpl.id = editTid;
    const r = await invoke(C.PERSONALITY_TEMPLATE_SAVE, { template: tpl });
    $('#tMsg').innerHTML = r.ok ? '<span class="ok">已' + (editTid ? '更新' : '保存') + '模板</span>' : '<span class="err">' + esc((r.errors || []).join('；') || r.error) + '</span>';
    if (r.ok) { editTid = null; pagePersonality(); }
  };
  $('#tCancel').onclick = () => { editTid = null; pagePersonality(); };
  $('#tList').querySelectorAll('button[data-act]').forEach((b) => b.onclick = async () => {
    const act = b.dataset.act, id = b.dataset.id;
    if (act === 'edit') {
      const r = await invoke(C.PERSONALITY_TEMPLATE_LIST);
      const t = (r.templates || []).find((x) => x.id === id);
      if (!t) return;
      editTid = id; $('#tFormTitle').textContent = '编辑模板：' + t.name;
      $('#tName').value = t.name; $('#tContent').value = t.content; $('#tCancel').style.display = '';
      $('#tMsg').innerHTML = '<span class="hint">编辑只改模板库，不影响运行中的人格；点「保存模板」入库。</span>';
      return;
    }
    if (act === 'copy') { const r = await invoke(C.PERSONALITY_TEMPLATE_COPY, { id }); $('#tMsg').innerHTML = r.ok ? '<span class="ok">已复制</span>' : '<span class="err">' + esc(r.error) + '</span>'; if (r.ok) pagePersonality(); return; }
    if (act === 'rename') { const n = prompt('新名称'); if (!n) return; const r = await invoke(C.PERSONALITY_TEMPLATE_RENAME, { id, name: n }); $('#tMsg').innerHTML = r.ok ? '<span class="ok">已重命名</span>' : '<span class="err">' + esc(r.error) + '</span>'; if (r.ok) pagePersonality(); return; }
    if (act === 'active') { const r = await invoke(C.PERSONALITY_TEMPLATE_SET_ACTIVE, { id }); $('#tMsg').innerHTML = r.ok ? '<span class="ok">已设为当前模板</span>' : '<span class="err">' + esc(r.error) + '</span>'; if (r.ok) pagePersonality(); return; }
    if (act === 'del') { if (!confirm('删除该模板？')) return; const r = await invoke(C.PERSONALITY_TEMPLATE_DELETE, { id }); $('#tMsg').innerHTML = r.ok ? '<span class="ok">已删除</span>' : '<span class="err">' + esc(r.error) + '</span>'; if (r.ok) pagePersonality(); return; }
    if (act === 'apply') {
      if (!confirm('应用该模板到机器人？将先备份 ai_prompt.txt 再写入（即时生效，无需重启）。')) return;
      const r = await invoke(C.PERSONALITY_TEMPLATE_APPLY, { id });
      $('#tMsg').innerHTML = r.ok ? '<span class="ok">' + esc(r.note || '已应用') + '</span>' : '<span class="err">' + esc(r.error || '应用失败') + '</span>';
      if (r.ok) pagePersonality();
      return;
    }
    if (act === 'diff') {
      const r = await invoke(C.PERSONALITY_TEMPLATE_DIFF, { id });
      const db = $('#diffBox'); db.style.display = '';
      if (!r.ok) { $('#diffOut').textContent = r.error || '预览失败'; return; }
      const html = (r.lines || []).map((l) => {
        const cls = l.type === '-' ? 'err' : l.type === '+' ? 'ok' : 'muted';
        return `<span class="${cls}">${l.type === ' ' ? '  ' : l.type} ${esc(l.text)}</span>`;
      }).join('\n');
      $('#diffOut').innerHTML = html || '（内容完全相同）';
      return;
    }
  });
}

/* ---------- 技能扩展 ---------- */
let skillEditId = null;
async function pageSkills() {
  content.innerHTML = '<h2>技能扩展</h2><div id="sk"></div>';
  const box = $('#sk');
  box.innerHTML = '<div class="hint">加载中…</div>';

  const load = async () => {
    const r = await invoke(C.SKILL_LIST);
    if (!r || !r.ok) { box.innerHTML = '<div class="hint err">' + esc((r && r.error) || '未配置机器人目录') + '</div>'; return; }
    const skills = r.skills || [];
    const rows = skills.map((s) => `
      <tr>
        <td><b>${esc(s.name)}</b><div class="hint">${esc(s.description || '')}</div></td>
        <td>${esc((s.trigger && s.trigger.mode) === 'keyword' ? '关键词：' + (s.trigger.keywords || []).join('、') : '始终生效')}</td>
        <td>${(s.tools || []).length} 个工具</td>
        <td>${s.valid ? (s.enabled ? '<span class="pill ok">已启用</span>' : '<span class="pill">已停用</span>') : '<span class="pill err">无效</span>'}</td>
        <td class="row">
          <button class="btn sm" data-act="edit" data-id="${esc(s.id)}">编辑</button>
          <button class="btn sm" data-act="copy" data-id="${esc(s.id)}">复制</button>
          <button class="btn sm" data-act="toggle" data-id="${esc(s.id)}" data-en="${s.enabled ? '0' : '1'}">${s.enabled ? '停用' : '启用'}</button>
          <button class="btn sm" data-act="del" data-id="${esc(s.id)}">删除</button>
        </td>
      </tr>`).join('');
    const invalid = skills.filter((s) => !s.valid);
    box.innerHTML = `
      <div class="section">
        <div class="hint">技能 = 一段注入系统提示词的行为说明 + 可选挂载的工具。保存后机器人<b>下一轮对话立即生效</b>，无需重启 AI 桥。</div>
        <div class="hint">技能文件：<code>${esc(r.path || '')}</code> ｜ 已启用 ${r.enabledCount} 个${r.invalidCount ? ' ｜ <span class="err">' + r.invalidCount + ' 个无效</span>' : ''}</div>
      </div>
      ${invalid.length ? '<div class="section"><h3>无效技能</h3>' + invalid.map((s) => '<div class="hint err">' + esc(s.name) + '：' + esc((s.errors || []).join('；')) + '</div>').join('') + '</div>' : ''}
      <div class="section">
        <h3>内置模板</h3>
        <div class="row" id="tplRow"></div>
        <div class="hint">导入后可自由修改；同名技能不会重复导入。</div>
      </div>
      <div class="section">
        <h3>已安装技能</h3>
        <table class="tbl"><thead><tr><th>名称</th><th>触发</th><th>工具</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="hint">还没有技能，点上面「内置模板」导入一个，或用下方表单新建。</td></tr>'}</tbody></table>
      </div>
      <div class="section">
        <h3>${skillEditId ? '编辑技能' : '新建技能'}</h3>
        <div id="skForm"></div>
        <div class="hint" id="skMsg"></div>
      </div>`;

    // 内置模板
    const t = await invoke(C.SKILL_TEMPLATES);
    const tpls = (t && t.templates) || [];
    $('#tplRow').innerHTML = tpls.map((x) => `<button class="btn sec" data-tpl="${esc(x.key)}">导入「${esc(x.name)}」</button>`).join('')
      + '<button class="btn sec" id="skExport">导出全部技能</button>';

    // 表单
    const cur = skillEditId ? skills.find((s) => s.id === skillEditId) : null;
    const handlers = (r.allowedHandlers || []);
    $('#skForm').innerHTML = `
      <label>名称</label><input id="skName" value="${esc(cur ? cur.name : '')}" placeholder="例：画图小助手" />
      <label>说明</label><input id="skDesc" value="${esc(cur ? cur.description : '')}" placeholder="一句话说明这个技能做什么" />
      <label>触发方式</label>
      <select id="skMode">
        <option value="always"${cur && cur.trigger && cur.trigger.mode !== 'keyword' ? ' selected' : ''}>始终生效</option>
        <option value="keyword"${cur && cur.trigger && cur.trigger.mode === 'keyword' ? ' selected' : ''}>命中关键词时生效</option>
      </select>
      <label>关键词（逗号分隔，仅关键词模式需要）</label>
      <input id="skKw" value="${esc(cur && cur.trigger ? (cur.trigger.keywords || []).join(',') : '')}" placeholder="例：画,画图,生图" />
      <label>提示词（注入系统提示词）</label>
      <textarea id="skPrompt" placeholder="告诉模型这个技能开启后应该怎么表现">${esc(cur ? cur.prompt : '')}</textarea>
      <label>挂载工具（可选；只能选已有内置工具，技能不能执行自定义代码）</label>
      <div class="hint" id="skToolWrap"></div>
      <div class="row">
        <button class="btn" id="skSave">${cur ? '保存修改' : '创建技能'}</button>
        ${cur ? '<button class="btn sec" id="skCancel">取消编辑</button>' : ''}
      </div>`;

    const toolDefs = cur && cur.tools && cur.tools.length ? cur.tools : [];
    const toolRow = (tdef, i) => `
      <div class="row">
        <input class="tool-name" placeholder="工具名（给模型看）" value="${esc(tdef.name || '')}" data-i="${i}" />
        <select class="tool-handler" data-i="${i}">
          ${handlers.map((h) => `<option value="${esc(h)}"${tdef.handler === h ? ' selected' : ''}>${esc(h)}</option>`).join('')}
        </select>
        <input class="tool-desc" placeholder="工具说明" value="${esc(tdef.description || '')}" data-i="${i}" />
        <button class="btn sm" data-rmtool="${i}">移除</button>
      </div>`;
    const toolHtml = (toolDefs.length ? toolDefs : [{ name: '', handler: handlers[0] || 'generate_image', description: '' }]).map(toolRow).join('');
    $('#skToolWrap').innerHTML = toolHtml
      + '<div class="row"><button class="btn sec" id="skAddTool">添加工具</button></div>';
    $('#skToolWrap').dataset.count = String(Math.max(1, toolDefs.length));

    // 事件
    $('#skSave').onclick = async () => {
      const n = $('#skName').value.trim();
      if (!n) { $('#skMsg').innerHTML = '<span class="err">名称必填</span>'; return; }
      const mode = $('#skMode').value;
      const kw = $('#skKw').value.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      const toolEls = Array.from($('#skToolWrap').querySelectorAll('.tool-name'));
      const tools = [];
      for (const el of toolEls) {
        const i = el.dataset.i;
        const nm = el.value.trim();
        if (!nm) continue;
        const h = $('#skToolWrap').querySelector('.tool-handler[data-i="' + i + '"]').value;
        const ds = $('#skToolWrap').querySelector('.tool-desc[data-i="' + i + '"]').value;
        tools.push({ name: nm, handler: h, description: ds, parameters: { type: 'object', properties: {} } });
      }
      const payload = { name: n, description: $('#skDesc').value.trim(), trigger: { mode, keywords: mode === 'keyword' ? kw : [] }, prompt: $('#skPrompt').value, tools };
      if (skillEditId) payload.id = skillEditId;
      const r = await invoke(C.SKILL_SAVE, { skill: payload });
      if (r && r.ok) {
        $('#skMsg').innerHTML = '<span class="ok">' + esc(r.note || '已保存') + '</span>';
        skillEditId = null;
        await load();
      } else {
        $('#skMsg').innerHTML = '<span class="err">' + esc((r && r.error) || '保存失败') + '</span>';
      }
    };
    if ($('#skCancel')) $('#skCancel').onclick = () => { skillEditId = null; load(); };
    $('#skAddTool').onclick = () => {
      const wrap = $('#skToolWrap');
      const i = Number(wrap.dataset.count || '1');
      wrap.insertAdjacentHTML('beforeend', toolRow({ name: '', handler: handlers[0] || 'generate_image', description: '' }, i));
      wrap.dataset.count = String(i + 1);
    };
    wrapDel();
    function wrapDel() {
      $('#skToolWrap').querySelectorAll('[data-rmtool]').forEach((b) => {
        b.onclick = () => { b.parentElement.remove(); };
      });
    }
    $('#skExport').onclick = async () => {
      const r = await invoke(C.SKILL_EXPORT);
      if (!r || !r.ok) { alert('导出失败：' + ((r && r.error) || '')); return; }
      const blob = new Blob([JSON.stringify({ version: r.version, skills: r.skills }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'feiyu-skills.json'; a.click();
    };

    box.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.id, act = b.dataset.act;
        if (act === 'edit') { skillEditId = id; await load(); return; }
        if (act === 'del') {
          if (!confirm('删除该技能？删除后立即生效。')) return;
          const r = await invoke(C.SKILL_DELETE, { id });
          if (r && r.ok) await load(); else alert('删除失败：' + ((r && r.error) || ''));
          return;
        }
        if (act === 'copy') {
          const r = await invoke(C.SKILL_COPY, { id });
          if (r && r.ok) await load(); else alert('复制失败：' + ((r && r.error) || ''));
          return;
        }
        if (act === 'toggle') {
          const r = await invoke(C.SKILL_SET_ENABLED, { id, enabled: b.dataset.en === '1' });
          if (r && r.ok) await load(); else alert('操作失败：' + ((r && r.error) || ''));
        }
      };
    });
    box.querySelectorAll('[data-tpl]').forEach((b) => {
      b.onclick = async () => {
        const r = await invoke(C.SKILL_IMPORT_TEMPLATE, { key: b.dataset.tpl });
        if (r && r.ok) await load(); else alert('导入失败：' + ((r && r.error) || ''));
      };
    });
  };

  await load();
}

/* ---------- ComfyUI 生图 ---------- */
let comfyExplicitDir = null;                  // 用户在「选择安装目录」里指定的 ComfyUI 根
async function pageComfy() {
  content.innerHTML = '<h2>ComfyUI 生图</h2><div id="cf"></div>';
  const box = $('#cf');
  box.innerHTML = '<div class="hint">加载中…</div>';

  const load = async () => {
    const st = await invoke(C.COMFY_STATUS, { dir: comfyExplicitDir });
    const pr = await invoke(C.COMFY_PREREQ, { dir: comfyExplicitDir });
    const wf = await invoke(C.COMFY_WORKFLOWS);
    const det = (st && st.detect) || {};
    const conn = (st && st.connection) || {};
    const pre = (pr && pr.prereq) || {};
    const models = (pre.models && pre.models.models) || [];
    const workflows = (wf && wf.workflows) || [];

    const prItems = (pre.items || []).map((i) => `
      <tr><td>${esc(i.label)}${i.required ? ' <span class="hint">（必需）</span>' : ''}</td>
      <td>${i.ok ? '<span class="pill ok">已就绪</span>' : '<span class="pill err">未满足</span>'}</td>
      <td class="hint">${esc(i.detail || '')}</td></tr>`).join('');

    const mRows = models.map((m) => `
      <tr>
        <td>${esc(m.label)}<div class="hint">${esc(m.note || '')}</div></td>
        <td><code>models/${esc(m.dir)}/${esc(m.file)}</code></td>
        <td>${m.present ? '<span class="pill ok">已下载</span>' : '<span class="pill err">缺失</span>'}</td>
        <td>${m.present ? '—' : '<button class="btn sm" data-dl="' + esc(m.key) + '">下载（约 ' + Math.round(m.approxMB) + 'MB）</button>'}</td>
      </tr>`).join('');

    const wRows = workflows.map((w) => `
      <tr>
        <td><code>${esc(w.file)}</code></td>
        <td>${w.nodes} 节点</td>
        <td>${w.hasCLIP ? '✓' : '✗'} CLIP${w.hasSampler ? ' ✓采样' : ''}${w.hasUnet ? ' ✓模型' : ''}${w.hasSave ? ' ✓保存' : ''}</td>
        <td>${w.parseError ? '<span class="err">解析失败</span>' : (w.hasCLIP && w.hasSampler ? '<span class="pill ok">可用</span>' : '<span class="pill">缺节点</span>')}</td>
      </tr>`).join('');

    box.innerHTML = `
      <div class="section quick-login">
        <h3>🚀 ComfyUI 一键启动</h3>
        <div class="hint">当前状态：<b>${conn.running ? '运行中' + (conn.version ? ' v' + esc(conn.version) : '') : '未运行'}</b>${det.root ? ' ｜ 目录：<code>' + esc(det.root) + '</code>' : ' ｜ 本机未检测到安装（点「安装」可自动下载）'}</div>
        <div class="row" style="margin-top:8px">
          <button class="btn" id="cfStart">${conn.running ? '重新启动' : '一键启动'}</button>
          <button class="btn danger" id="cfStop" ${conn.running ? '' : 'disabled'}>停止</button>
          <button class="btn sec" id="cfPick2">选择安装目录</button>
        </div>
        <div class="hint" id="cfQuickMsg"></div>
      </div>
      <div class="section">
        <h3>前置条件</h3>
        <div class="hint">画图链路需要<b>先接入大模型</b>：机器人侧 LLM（提示词翻译/扩写）+ ComfyUI 侧文本编码器，缺一则画图会空转。</div>
        <table class="tbl"><thead><tr><th>项目</th><th>状态</th><th>说明</th></tr></thead><tbody>${prItems}</tbody></table>
        <div class="hint" id="cfMsg"></div>
      </div>

      <div class="section">
        <h3>ComfyUI 环境</h3>
        <table class="tbl"><tbody>
          <tr><td>安装目录</td><td>${det.root ? '<code>' + esc(det.root) + '</code>' : '<span class="err">未检测到</span>'}</td></tr>
          <tr><td>服务地址</td><td><code>${esc(det.endpoint || '')}</code></td></tr>
          <tr><td>连接状态</td><td>${conn.running ? '<span class="pill ok">运行中' + (conn.version ? ' v' + esc(conn.version) : '') + (conn.device ? ' / ' + esc(conn.device) : '') + '</span>' : '<span class="pill err">未运行</span> ' + esc(conn.error || '')}</td></tr>
          <tr><td>Python</td><td>${esc(conn.python || '—')}</td></tr>
        </tbody></table>
        <div class="row">
          <button class="btn sec" id="cfDetect">重新检测</button>
          <button class="btn sec" id="cfPick">指定安装目录</button>
          <button class="btn sec" id="cfRelease">查询官方安装包</button>
          <button class="btn sec" id="cfInstall">自动下载安装 ComfyUI</button>
        </div>
        <div class="hint">自动下载使用官方 Windows 便携版（GitHub Releases 的 .7z，约 1.4–1.9 GB），解压依赖系统自带 tar（Windows 10+ 自带 bsdtar，支持 7z）。</div>
      </div>

      <div class="section">
        <h3>模型（自动下载）</h3>
        <table class="tbl"><thead><tr><th>模型</th><th>目标位置</th><th>状态</th><th>操作</th></tr></thead><tbody>${mRows || '<tr><td colspan="4" class="hint">未检测到 ComfyUI 目录</td></tr>'}</tbody></table>
        <div class="hint">下载源：HuggingFace（不可达时自动回落 hf-mirror 镜像）。大文件下载较慢，请保持网络畅通。</div>
      </div>

      <div class="section">
        <h3>工作流（机器人目录 workflows/）</h3>
        <table class="tbl"><thead><tr><th>文件</th><th>规模</th><th>节点</th><th>状态</th></tr></thead><tbody>${wRows || '<tr><td colspan="4" class="hint">没有工作流文件。文生图/图生图需自备 API 格式工作流并填入 ai_config.json 的 image.workflow。</td></tr>'}</tbody></table>
      </div>`;

    $('#cfDetect').onclick = load;
    $('#cfStart').onclick = async () => {
      const qm = $('#cfQuickMsg'); qm.innerHTML = '<span class="hint">启动中…</span>';
      const r = await invoke(C.COMFY_START, { dir: comfyExplicitDir });
      if (r.ok) {
        if (r.alreadyRunning) qm.innerHTML = '<span class="ok">已经在运行</span>';
        else if (r.starting) qm.innerHTML = '<span class="hint">ComfyUI 正在启动（PID ' + (r.pid || '') + '，首次加载较慢，稍后监控里端口起来即成功）</span>';
        else qm.innerHTML = '<span class="ok">已确认启动（PID ' + (r.pid || '') + '，端口已监听）</span>';
      } else {
        qm.innerHTML = '<span class="err">' + esc(r.error + (r.detail ? '｜' + r.detail : '')) + '</span>';
      }
      setTimeout(load, 2500);
    };
    $('#cfStop').onclick = async () => {
      const qm = $('#cfQuickMsg'); qm.innerHTML = '<span class="hint">停止中…</span>';
      const r = await invoke(C.COMFY_STOP, {});
      qm.innerHTML = r.ok ? (r.stopped ? '<span class="ok">已停止</span>' : '<span class="hint">本就未运行</span>') : '<span class="err">' + esc(r.error) + '</span>';
      setTimeout(load, 1500);
    };
    $('#cfPick2').onclick = async () => {
      const r = await invoke(C.COMFY_PICKDIR);
      if (!r || !r.ok || !r.dir) return;
      comfyExplicitDir = r.root || r.dir;
      // 持久化到设置，重启后「一键启动」仍能找到该目录
      try { await invoke(C.SETTINGS_SET, { comfyDir: r.dir }); } catch (_) {}
      $('#cfQuickMsg').innerHTML = '<span class="ok">已选择并记住：' + esc(comfyExplicitDir) + '</span>';
      await load();
    };
    $('#cfPick').onclick = async () => {
      const r = await invoke(C.COMFY_PICKDIR);
      if (!r || !r.ok || !r.dir) return;
      if (!r.valid) { alert('该目录下未找到 main.py，可能不是 ComfyUI 安装目录。'); return; }
      $('#cfMsg').innerHTML = '<span class="ok">已选择：' + esc(r.dir) + '</span>';
    };
    $('#cfRelease').onclick = async () => {
      const r = await invoke(C.COMFY_RELEASE, { variant: 'nvidia' });
      if (!r || !r.ok) { $('#cfMsg').innerHTML = '<span class="err">' + esc((r && r.error) || '查询失败') + '</span>'; return; }
      const rel = r.release;
      $('#cfMsg').innerHTML = '<span class="ok">官方最新版 ' + esc(rel.tag) + '：' + esc(rel.name)
        + '（' + (rel.size / 1048576).toFixed(0) + ' MB）</span>';
    };
    $('#cfInstall').onclick = async () => {
      if (!confirm('将下载官方 Windows 便携版 ComfyUI（约 1.4–1.9 GB）并解压到你选择的目录。继续？')) return;
      const dir = prompt('解压到哪个目录？', 'D:\\ComfyUI_windows_portable');
      if (!dir) return;
      $('#cfMsg').innerHTML = '<span class="hint">下载中…（约 1.4–1.9 GB，请勿关闭窗口）</span>';
      const r = await invoke(C.COMFY_INSTALL, { dir: dir, variant: 'nvidia' });
      if (!r || !r.ok) {
        $('#cfMsg').innerHTML = '<span class="err">' + esc((r && r.error) || '安装失败') + '</span>';
        return;
      }
      $('#cfMsg').innerHTML = '<span class="ok">' + esc(r.note) + '</span>';
      await load();
    };
    box.querySelectorAll('[data-dl]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('开始下载该模型？文件较大，可能需要较长时间。')) return;
        b.disabled = true; b.textContent = '下载中…';
        const r = await invoke(C.COMFY_DOWNLOAD_MODEL, { key: b.dataset.dl, dir: det.root || undefined });
        if (!r || !r.ok) { $('#cfMsg').innerHTML = '<span class="err">' + esc((r && r.error) || '下载失败') + '</span>'; }
        else $('#cfMsg').innerHTML = '<span class="ok">' + esc(r.note) + '</span>';
        await load();
      };
    });
  };

  await load();
}

/* ---------- 日志与诊断 ---------- */
async function pageLogs() {
  content.innerHTML = '<h2>日志与诊断</h2><div class="row"><input id="kw" placeholder="搜索关键字" /><button class="btn sec" id="searchBtn">搜索</button><button class="btn sec" id="tailBtn">刷新尾部</button></div><div id="lg" class="log"></div>';
  const show = (lines) => { $('#lg').textContent = (lines && lines.length) ? lines.join('\n') : '（暂无日志 / 未配置目录）'; };
  const tail = async () => { const r = await invoke(C.LOG_TAIL, { lines: 300 }); show(r.lines); };
  $('#tailBtn').onclick = tail;
  $('#searchBtn').onclick = async () => { const r = await invoke(C.LOG_SEARCH, { keyword: $('#kw').value }); show(r.lines); };
  tail();
}

/* ---------- 配置导入导出 ---------- */
async function pageImportExport() {
  content.innerHTML = '<h2>配置导入导出</h2><div id="ie"></div>';
  const box = $('#ie');
  box.innerHTML = `
    <div class="section">
      <div class="row"><button class="btn" id="exportBtn">导出当前配置（不含密钥）</button><button class="btn sec" id="exportSecBtn">导出（含密钥，私密迁移用）</button></div>
      <div class="hint">导出包含 schemaVersion + 软件版本；默认排除 secrets.json。</div>
    </div>
    <div class="section">
      <h3>导入配置</h3>
      <input type="file" id="file" accept=".json" />
      <div class="row"><button class="btn sec" id="validateBtn">校验并预览差异</button></div>
      <div id="diffBox"></div>
      <div class="row"><label style="display:inline"><input type="checkbox" id="backupChk" checked style="width:auto;margin-right:6px" />应用前自动备份</label></div>
      <div class="row"><button class="btn" id="applyBtn" disabled>应用导入</button></div>
      <div class="hint" id="ieMsg"></div>
    </div>`;
  let pending = null;
  $('#exportBtn').onclick = () => doExport(false);
  $('#exportSecBtn').onclick = () => doExport(true);
  async function doExport(includeSecret) {
    const r = await invoke(C.IMPORT_BUILD, { includeSecret });
    if (!r.ok) { $('#ieMsg').innerHTML = '<span class="err">' + esc(r.error) + '</span>'; return; }
    const blob = new Blob([JSON.stringify(r.export, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'feiyu-config' + (includeSecret ? '-with-secret' : '') + '.json'; a.click();
    $('#ieMsg').innerHTML = '<span class="ok">已生成导出文件（下载中）</span>';
  }
  $('#validateBtn').onclick = async () => {
    const file = $('#file').files[0]; if (!file) { $('#ieMsg').innerHTML = '<span class="err">先选择文件</span>'; return; }
    const text = await file.text();
    let obj; try { obj = JSON.parse(text); } catch (e) { $('#ieMsg').innerHTML = '<span class="err">JSON 解析失败</span>'; return; }
    const v = await invoke(C.IMPORT_VALIDATE, { obj });
    if (!v.valid) { $('#diffBox').innerHTML = '<span class="err">校验失败：' + esc(v.errors.join('；')) + '</span>'; $('#applyBtn').disabled = true; return; }
    const d = await invoke(C.IMPORT_APPLY, { incoming: obj, dryRun: true }).catch(() => null);
    // 差异预览：复用 validate 的 warnings + 简单展示
    const diff = (obj.config && Object.keys(obj.config).length) ? Object.keys(obj.config).join(', ') : '（无）';
    $('#diffBox').innerHTML = `<div class="hint ok">校验通过。包含配置项：${esc(diff)}；人格：${obj.personality ? '有' : '无'}；密钥：${obj.secret ? '有（私密迁移）' : '无'}。${v.warnings.length ? '<br>警告：' + esc(v.warnings.join('；')) : ''}</div>`;
    pending = obj; $('#applyBtn').disabled = false;
  };
  $('#applyBtn').onclick = async () => {
    if (!pending) return;
    const r = await invoke(C.IMPORT_APPLY, { incoming: pending, backup: $('#backupChk').checked, includeSecret: !!pending.secret });
    $('#ieMsg').innerHTML = r.ok ? '<span class="ok">导入成功（已备份于 ' + esc(r.backupDir || '—') + '）</span>' : '<span class="err">' + esc((r.errors || []).join('；') || r.error) + '</span>';
    $('#applyBtn').disabled = true; pending = null;
  };
}

/* ---------- 关于 ---------- */
async function pageAbout() {
  const ver = await invoke(C.APP_VERSION);
  const set = (await invoke(C.SETTINGS_GET)).settings || {};
  content.innerHTML = `<h2>关于</h2>
    <div class="section">
      <div class="card" style="display:inline-block"><div class="k">版本</div><div class="v">${esc(ver.version)}</div></div>
      <h3>机器人目录</h3><div class="hint">${esc(set.botDir || '未配置（在「机器人运行」或设置中指定）')}</div>
      <div class="row"><button class="btn sec" id="pickBtn2">选择机器人目录…</button></div>
      <h3>说明</h3>
    <div class="hint">肥鱼桌面控制中心：基于现有 NapCat + OneBot QQ AI 机器人核心，增加图形化管理（配置 / 启动停止 / 人格 / 用量 / 日志 / 导入导出）。不重写机器人业务逻辑，只读/写其真实配置文件。</div>
    <div class="hint">用量数据来自机器人真实记录（memory/usage/*.jsonl 或运行中的 /api/usage），不做任何伪造。</div>
  </div>`;
  $('#pickBtn2').onclick = async () => { const d = await pickBotDir(); if (d) pageAbout(); };
}

/* ==================================================================================
 * 全量升级新增的聚合页（模块 A–J 的 UI 入口）
 * 设计原则：
 *  - 原有 11 个页面**一个不删**；新模块按主题聚合成 3 个页面，页内二级 Tab 切换，
 *    避免导航被十几个散页撑爆。
 *  - 仍然只通过 window.feiyu.invoke 的固定通道取数，不直接接触 fs / 网络 / 进程。
 *  - 任何「有风险」的动作（启动服务、恢复备份、真执行工作流）都需要用户在按钮上显式确认。
 * ================================================================================== */

const SUBTABS = {
  loginservices: { active: 'qr', tabs: [['qr', 'QQ 登录中心'], ['svc', '服务编排']] },
  extensions: { active: 'tree', tabs: [['tree', '技能树'], ['mcp', 'MCP 导入'], ['market', '市场接入']] },
  ops: { active: 'wf', tabs: [['wf', '自动化工作流'], ['bak', '备份与恢复'], ['cost', '成本与预算'], ['diag', '诊断与通知']] },
};

/** 渲染一个聚合页：顶部二级 Tab + 下方内容容器。 */
function mountGroup(key, renderers) {
  const g = SUBTABS[key];
  content.innerHTML = '<div class="subnav" id="subnav"></div><div id="subBody"></div>';
  const nav = $('#subnav');
  for (const [k, label] of g.tabs) {
    const b = document.createElement('button');
    b.className = 'btn sec' + (g.active === k ? ' active' : '');
    b.textContent = label;
    b.onclick = () => { g.active = k; mountGroup(key, renderers); };
    nav.appendChild(b);
  }
  const body = $('#subBody');
  const fn = renderers[g.active];
  if (fn) fn(body);
}

async function pageLoginServices() {
  content.innerHTML = '<h2>登录与服务</h2>';
  mountGroup('loginservices', { qr: subQrLogin, svc: subServices });
}

/* ---------------- A. QQ 登录中心（二维码 / 多实例） ---------------- */
let qrSessionId = null;
let qrImageSrc = null;

async function subQrLogin(body) {
  body.innerHTML = '<div class="hint">加载中…</div>';
  const [plan, inst, sset] = await Promise.all([invoke(C.NAPCAT_QR_PLAN), invoke(C.NAPCAT_INSTANCE_LIST), invoke(C.SETTINGS_GET)]);
  const set = (sset && sset.settings) || {};
  const p = (plan && plan.ok) ? plan : { steps: [], securityNotes: [], candidateEndpoints: [] };
  const list = (inst && inst.instances) || [];
  body.innerHTML = `
    <div class="section quick-login">
      <h3>🚀 一键快捷登录（推荐，不用扫码）</h3>
      <div class="hint">用你电脑上已经有的 QQ 号和密码，点一下就登录。密码只在你本机算成 MD5 再发给登录器，<b>绝不保存明文</b>。</div>
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <label>QQ 号</label><input id="qlAcc" value="${esc((set.napcat && set.napcat.account) || '')}" placeholder="你的 QQ 号" style="width:170px" />
        <label>QQ 密码</label><input id="qlPwd" type="password" placeholder="填 QQ 密码（不是 MD5）" style="width:260px" />
      </div>
      <div class="row" style="gap:6px">
        <label style="display:flex;align-items:center;gap:6px;font-weight:400"><input type="checkbox" id="qlPlain" checked /> 我填的是明文密码（自动转 MD5）</label>
      </div>
      <div class="row" style="margin-top:8px">
        <button class="btn" id="qlNap">只启动 NapCat（登录 QQ，推荐）</button>
        <button class="btn alt" id="qlGo">登录并启动完整机器人</button>
        <button class="btn sec" id="qlSave">只保存账号</button>
      </div>
      <div class="hint" id="qlMsg"></div>
    </div>
    <div class="section">
      <h3>二维码登录（备选）</h3>
      <div class="hint">${(p.steps || []).map((s, i) => (i + 1) + '. ' + esc(s)).join('<br>')}</div>
      <div class="row" style="margin-top:10px;flex-wrap:wrap;gap:8px">
        <label>NapCat 二维码接口地址</label>
        <input id="qrEp" value="http://127.0.0.1:3000/get_qrcode" placeholder="http://127.0.0.1:3000/get_qrcode" style="min-width:360px" />
        <button class="btn" id="qrGet">获取二维码</button>
      </div>
      <div class="hint">怎么填：就是「NapCat 的 HTTP 服务地址 + 二维码接口路径」。默认 <code>http://127.0.0.1:3000/get_qrcode</code> 适用于大多数 NapCat，其中 3000 是 NapCat 的端口；若你改过端口就换成对应端口。拿不准就直接点「获取二维码」用默认值试。</div>
      <div class="hint">候选路径（不同 NapCat 版本可能不同）：${esc((p.candidateEndpoints || []).join(' / '))}</div>
      <div id="qrBox" style="margin-top:12px"></div>
      <div class="hint" style="margin-top:8px">安全提示：${(p.securityNotes || []).map((s) => esc(s)).join('；')}</div>
    </div>
    <div class="section">
      <h3>实例列表（${list.length}）</h3>
      <div id="instList">${list.length ? list.map((x) => `
        <div class="card" style="display:inline-block;margin:6px 8px 0 0;min-width:220px">
          <div class="k">${esc(x.name)} ${x.mode === 'quick' ? '<span class="badge on">快速登录</span>' : '<span class="badge off">扫码</span>'}</div>
          <div class="v">${esc(x.account || '未填写账号')}</div>
          <div class="hint">id: ${esc(x.id)}｜端口: ${esc(x.port == null ? '默认' : x.port)}</div>
          <div class="hint">最近登录: ${esc(x.lastLoginAt || '—')}</div>
          <div class="row"><button class="btn sec" data-del="${esc(x.id)}">删除</button></div>
        </div>`).join('') : '<div class="hint">还没有实例。可在下方添加。</div>'}</div>
      <h3 style="margin-top:14px">新增 / 更新实例</h3>
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <label>ID</label><input id="iId" placeholder="如 main" style="width:110px" />
        <label>名称</label><input id="iName" placeholder="主号" style="width:120px" />
        <label>QQ 号</label><input id="iAcc" placeholder="你的 QQ 号（仅本机保存）" style="width:160px" />
        <label>方式</label><select id="iMode"><option value="qr">扫码登录</option><option value="quick">快速登录</option></select>
        <label>端口</label><input id="iPort" placeholder="3000" style="width:80px" />
        <button class="btn" id="iSave">保存实例</button>
      </div>
      <div class="hint">密码不会被本工具保存：快速登录的密码 MD5 只在启动时通过环境变量注入子进程。</div>
      <div id="iMsg"></div>
    </div>`;

  const box = $('#qrBox');
  const drawQr = (s) => {
    qrSessionId = s.id;
    qrImageSrc = s.qrImage || null;
    box.innerHTML = `
      <div class="card" style="display:inline-block">
        <div class="k">状态：${esc(s.state)}</div>
        <div class="v">${esc(s.message || '')}</div>
        ${s.qrImage ? `<div style="margin:10px 0"><img src="${esc(s.qrImage)}" alt="登录二维码" style="width:220px;height:220px;image-rendering:pixelated;background:#fff;padding:8px;border-radius:8px" /></div>` : ''}
        ${s.qrUrl ? `<div class="hint">二维码链接：${esc(s.qrUrl)}</div>` : ''}
        <div class="row"><button class="btn sec" id="qrPoll">刷新登录状态</button></div>
        <div class="hint">二维码等同一次性凭据，请勿截图外传；本工具不会把它写进日志或诊断包。</div>
      </div>`;
    const pb = $('#qrPoll');
    if (pb) pb.onclick = async () => {
      if (!qrSessionId) return;
      const r = await invoke(C.NAPCAT_QR_POLL, { sessionId: qrSessionId });
      if (r && r.session) drawQr(r.session); else if (r && r.error) box.innerHTML = '<div class="err">' + esc(r.error) + '</div>';
    };
  };

  $('#qrGet').onclick = async () => {
    const endpoint = $('#qrEp').value.trim();
    box.innerHTML = '<div class="hint">正在请求 NapCat 二维码接口…</div>';
    const r = await invoke(C.NAPCAT_QR_START, endpoint ? { endpoint } : {});
    if (r && r.session) {
      if (r.session.qrImage || r.session.qrUrl) drawQr(r.session);
      else box.innerHTML = '<div class="warn" style="padding:8px">' + esc(r.session.message || r.error || '未取得二维码') + '</div>';
    } else if (r && r.error) box.innerHTML = '<div class="err">' + esc(r.error) + '</div>';
  };

  $('#iSave').onclick = async () => {
    const instance = {
      id: $('#iId').value.trim(), name: $('#iName').value.trim(),
      account: $('#iAcc').value.trim(), mode: $('#iMode').value,
    };
    const port = parseInt($('#iPort').value, 10);
    if (!isNaN(port)) instance.port = port;
    const r = await invoke(C.NAPCAT_INSTANCE_SAVE, { instance });
    $('#iMsg').innerHTML = r.ok ? '<span class="ok">已保存</span>' : '<span class="err">' + esc(r.error) + '</span>';
    if (r.ok) setTimeout(() => subQrLogin(body), 400);
  };

  // —— 一键快捷登录（普通玩家主路径）——
  const qlGo = $('#qlGo'), qlNap = $('#qlNap'), qlSave = $('#qlSave'), qlMsg = $('#qlMsg');
  function qlResolve() {
    const acc = $('#qlAcc').value.trim();
    const pwd = $('#qlPwd').value;
    if (!acc) { qlMsg.innerHTML = '<span class="err">请填写 QQ 号</span>'; return null; }
    if (!pwd) { qlMsg.innerHTML = '<span class="err">请填写密码</span>'; return null; }
    const plain = $('#qlPlain').checked;
    const md5 = plain ? md5hex(pwd) : pwd.trim();
    if (!plain && !/^[0-9a-fA-F]{32}$/.test(md5)) { qlMsg.innerHTML = '<span class="err">未勾选「明文密码」时，这里必须是 32 位 MD5</span>'; return null; }
    return { account: acc, passwordMd5: md5.toLowerCase() };
  }
  if (qlGo) qlGo.onclick = async () => {
    const c = qlResolve(); if (!c) return;
    const sr = await invoke(C.SETTINGS_SET, { napcat: { account: c.account, passwordMd5: c.passwordMd5 } });
    if (!sr.ok) { qlMsg.innerHTML = '<span class="err">' + esc(sr.error) + '</span>'; return; }
    qlMsg.innerHTML = '<span class="hint">已保存账号，正在启动…</span>';
    const r = await invoke(C.PROC_START, { napcat: c });
    if (r.ok) {
      qlMsg.innerHTML = '<span class="ok">已确认登录启动（PID ' + (r.pids || []).join(',') + (r.note ? '；' + esc(r.note) : '') + '）</span>';
    } else {
      const detail = (r.failed && r.failed.length) ? '：' + esc(r.failed.map((f) => f.id + ' ' + (f.error || '')).join('；')) : (r.error ? '：' + esc(r.error) : '');
      qlMsg.innerHTML = '<span class="err">启动失败' + detail + '</span>';
    }
    setTimeout(() => subQrLogin(body), 1500);
  };
  if (qlNap) qlNap.onclick = async () => {
    const c = qlResolve(); if (!c) return;
    const sr = await invoke(C.SETTINGS_SET, { napcat: { account: c.account, passwordMd5: c.passwordMd5 } });
    if (!sr.ok) { qlMsg.innerHTML = '<span class="err">' + esc(sr.error) + '</span>'; return; }
    qlMsg.innerHTML = '<span class="hint">正在启动 NapCat 并校验端口 3000…</span>';
    const r = await invoke(C.PROC_START, { only: 'napcat', napcat: c });
    if (r.ok) {
      qlMsg.innerHTML = '<span class="ok">' + esc(r.note || 'NapCat 已启动') + '（PID ' + ((r.pids || [])[0] || r.pid || '') + '）</span>';
    } else {
      const detail = (r.failed && r.failed.length) ? '：' + esc(r.failed.map((f) => f.id + ' ' + (f.error || '')).join('；')) : (r.error ? '：' + esc(r.error) : '');
      qlMsg.innerHTML = '<span class="err">NapCat 启动失败' + detail + '（可改用下方扫码登录）</span>';
    }
    setTimeout(() => subQrLogin(body), 1500);
  };
  if (qlSave) qlSave.onclick = async () => {
    const c = qlResolve(); if (!c) return;
    const sr = await invoke(C.SETTINGS_SET, { napcat: { account: c.account, passwordMd5: c.passwordMd5 } });
    qlMsg.innerHTML = sr.ok ? '<span class="ok">已保存账号，下次可直接一键登录</span>' : '<span class="err">' + esc(sr.error) + '</span>';
  };

  document.querySelectorAll('#instList [data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('删除该实例记录？（不会影响正在运行的机器人）')) return;
    const r = await invoke(C.NAPCAT_INSTANCE_DELETE, { id: b.dataset.del });
    if (r.ok) subQrLogin(body); else alert('删除失败：' + r.error);
  });
}

/* ---------------- B. 服务编排与一键启动 ---------------- */
async function subServices(body) {
  body.innerHTML = '<div class="hint">加载中…</div>';
  const r = await invoke(C.SERVICE_LIST);
  const services = (r && r.services) || [];
  const presets = (r && r.presets) || [];
  body.innerHTML = `
    <div class="section">
      <h3>预设组合（一键启动）</h3>
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <select id="pvPreset">${presets.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>
        <button class="btn sec" id="pvPlan">生成计划</button>
        <button class="btn" id="pvStart">一键启动</button>
      </div>
      <div class="hint">启动前会先做「依赖环 / 端口冲突 / 已在运行」检查；任一不通过都不会盲启动。</div>
      <div id="pvOut" style="margin-top:10px"></div>
    </div>
    <div class="section">
      <h3>服务注册表（${services.length}）</h3>
      <table class="tbl"><thead><tr><th>id</th><th>名称</th><th>类型</th><th>端口</th><th>来源</th><th></th></tr></thead><tbody>
      ${services.map((s) => `<tr>
        <td>${esc(s.id)}</td><td>${esc(s.name)}</td><td>${esc(s.type || 'generic')}</td>
        <td>${esc(s.port == null ? '—' : s.port)}</td>
        <td>${s.builtin ? '<span class="badge on">内置</span>' : '<span class="badge off">自定义</span>'}</td>
        <td>${s.builtin ? '' : `<button class="btn sec" data-sdel="${esc(s.id)}">删除</button>`}</td>
      </tr>`).join('')}
      </tbody></table>
      <h3 style="margin-top:14px">新增自定义服务</h3>
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <input id="svId" placeholder="id（字母数字-_）" style="width:140px" />
        <input id="svName" placeholder="名称" style="width:130px" />
        <input id="svPort" placeholder="端口" style="width:80px" />
        <input id="svCmd" placeholder="可执行文件，如 python" style="width:170px" />
        <input id="svArgs" placeholder="参数，空格分隔，如 main.py --port 8188" style="min-width:260px" />
        <button class="btn" id="svSave">保存</button>
      </div>
      <div id="svMsg"></div>
    </div>`;

  $('#pvPlan').onclick = async () => {
    const presetId = $('#pvPreset').value;
    const out = $('#pvOut'); out.innerHTML = '<div class="hint">检查中…</div>';
    const p = await invoke(C.SERVICE_PLAN, { presetId });
    if (!p.ok) { out.innerHTML = '<div class="err">' + esc(p.error) + '</div>'; return; }
    const pl = p.plan;
    out.innerHTML = `
      <div class="card">
        <div class="k">启动顺序</div><div class="v">${esc((pl.order || []).join(' → ') || '—')}</div>
        <div class="hint">依赖环: ${pl.hasCycle ? '<span class="err">有（' + esc((pl.cycle || []).join(' → ')) + '）</span>' : '<span class="ok">无</span>'}
          ｜端口冲突: ${pl.portConflicts.length ? '<span class="err">' + esc(pl.portConflicts.map((x) => '端口' + x.port + '(' + x.services.join('/') + ')').join('、')) + '</span>' : '<span class="ok">无</span>'}</div>
        <div class="hint">当前占用: ${esc(Object.keys(p.liveOwners || {}).map((k) => k + (p.liveOwners[k] ? '(PID ' + p.liveOwners[k] + ')' : '(空闲)')).join('、') || '—')}</div>
        ${(pl.warnings || []).length ? '<div class="warn" style="margin-top:6px">' + pl.warnings.map((w) => esc(w)).join('<br>') + '</div>' : ''}
      </div>`;
  };

  $('#pvStart').onclick = async () => {
    const presetId = $('#pvPreset').value;
    if (!confirm('将启动该预设内的服务（已在运行或端口被占用的会自动跳过）。继续？')) return;
    const out = $('#pvOut'); out.innerHTML = '<div class="hint">启动中…</div>';
    const r = await invoke(C.SERVICE_START_PRESET, { presetId });
    if (!r.ok) { out.innerHTML = '<div class="err">' + esc(r.error) + '</div>'; return; }
    const anyFailed = (r.failed || []).length > 0;
    out.innerHTML = `<div class="card${anyFailed ? ' card-warn' : ''}">
      <div class="k">启动结果</div>
      <div class="v">已启动 ${r.started.length} 个｜跳过 ${r.skipped.length} 个｜失败 ${r.failed.length} 个</div>
      <div class="hint">${esc(r.started.map((x) => x.id + '(PID ' + x.pid + ')').join('、') || '—')}</div>
      ${r.skipped.length ? '<div class="hint">跳过：' + esc(r.skipped.map((x) => x.id + '：' + (x.reason === 'already_running' ? '端口已被占用' : x.reason)).join('、')) + '</div>' : ''}
      ${anyFailed ? '<div class="warn" style="margin-top:8px">⚠ 有 ' + r.failed.length + ' 个服务启动失败（进程已退出或端口未在时限内监听）：</div><div class="err">' + esc(r.failed.map((x) => x.id + '：' + x.error).join('；')) + '</div>' : ''}
    </div>`;
  };

  $('#svSave').onclick = async () => {
    const service = {
      id: $('#svId').value.trim(), name: $('#svName').value.trim(),
      type: 'generic', command: ($('#svArgs').value.trim() ? [$('#svCmd').value.trim()].concat($('#svArgs').value.trim().split(/\s+/)) : [$('#svCmd').value.trim()]),
    };
    const port = parseInt($('#svPort').value, 10);
    if (!isNaN(port)) service.port = port;
    const r = await invoke(C.SERVICE_SAVE, { service });
    $('#svMsg').innerHTML = r.ok ? '<span class="ok">已保存</span>' : '<span class="err">' + esc(r.error || (r.errors || []).join('；')) + '</span>';
    if (r.ok) setTimeout(() => subServices(body), 300);
  };
  document.querySelectorAll('[data-sdel]').forEach((b) => b.onclick = async () => {
    if (!confirm('删除自定义服务 ' + b.dataset.sdel + '？')) return;
    const r = await invoke(C.SERVICE_DELETE, { id: b.dataset.sdel });
    if (r.ok) subServices(body); else alert(r.error);
  });
}

async function pageExtensions() {
  content.innerHTML = '<h2>技能与扩展</h2>';
  mountGroup('extensions', { tree: subSkillTree, mcp: subMcp, market: subMarket });
}

/* ---------------- E. 技能树（分类 + 冲突） ---------------- */
async function subSkillTree(body) {
  body.innerHTML = '<div class="hint">加载中…</div>';
  const r = await invoke(C.SKILL_TREE);
  if (!r.ok) { body.innerHTML = '<div class="err">' + esc(r.error) + '</div>'; return; }
  const s = r.stats || {};
  body.innerHTML = `
    <div class="row" style="flex-wrap:wrap;gap:8px;margin-bottom:10px">
      <span class="badge on">技能 ${s.skills || 0}</span>
      <span class="badge on">启用 ${s.enabled || 0}</span>
      <span class="badge ${s.errors ? 'off' : 'on'}">错误 ${s.errors || 0}</span>
      <span class="badge ${s.warnings ? 'off' : 'on'}">警告 ${s.warnings || 0}</span>
      <span class="badge on">分类 ${s.categories || 0}（自定义 ${s.customCategories || 0}）</span>
    </div>
    ${(r.issues || []).length ? `<div class="section"><h3>冲突与依赖问题</h3>${r.issues.map((i) => `<div class="${i.level === 'error' ? 'err' : 'warn'}" style="padding:3px 0">[${esc(i.level)}] ${esc(i.message)}</div>`).join('')}</div>` : '<div class="ok" style="padding:6px 0">未发现冲突或依赖问题</div>'}
    <div class="section"><h3>技能树</h3>
      ${(r.tree || []).filter((c) => c.count > 0 || !c.parent).map((c) => `
        <div class="card" style="display:inline-block;vertical-align:top;margin:6px 8px 0 0;min-width:240px">
          <div class="k">${esc(c.name)} <small>${esc(c.id)}</small></div>
          <div class="hint">${esc(c.description || '')}</div>
          <div class="v">${c.count} 个技能</div>
          ${c.skills.length ? '<div class="hint">' + c.skills.map((x) => esc(x.name) + (x.enabled ? '' : '(停用)')).join('、') + '</div>' : ''}
          ${!c.builtin ? `<div class="row"><button class="btn sec" data-cdel="${esc(c.id)}">删除分类</button></div>` : ''}
        </div>`).join('')}
    </div>
    <div class="section"><h3>新增分类</h3>
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <input id="ctId" placeholder="id（小写字母数字-_）" style="width:180px" />
        <input id="ctName" placeholder="显示名称" style="width:140px" />
        <input id="ctDesc" placeholder="说明（可选）" style="min-width:240px" />
        <button class="btn" id="ctAdd">添加</button>
      </div><div id="ctMsg"></div>
      <div class="hint">分类只影响桌面端的组织方式，不改写机器人的 feiyu_skills.json。</div>
    </div>`;
  $('#ctAdd').onclick = async () => {
    const category = { id: $('#ctId').value.trim(), name: $('#ctName').value.trim(), description: $('#ctDesc').value.trim() };
    const x = await invoke(C.SKILL_CATEGORY_ADD, { category });
    $('#ctMsg').innerHTML = x.ok ? '<span class="ok">已添加</span>' : '<span class="err">' + esc(x.error) + '</span>';
    if (x.ok) setTimeout(() => subSkillTree(body), 300);
  };
  document.querySelectorAll('[data-cdel]').forEach((b) => b.onclick = async () => {
    if (!confirm('删除该分类？其下技能会落到「未分类」。')) return;
    const x = await invoke(C.SKILL_CATEGORY_DELETE, { id: b.dataset.cdel });
    if (x.ok) subSkillTree(body); else alert(x.error);
  });
}

/* ---------------- D. MCP 导入与权限中心 ---------------- */
async function subMcp(body) {
  body.innerHTML = '<div class="hint">加载中…</div>';
  const r = await invoke(C.MCP_LIST);
  const servers = (r && r.servers) || [];
  body.innerHTML = `
    <div class="section">
      <h3>导入 MCP 配置</h3>
      <div class="hint">粘贴标准 MCP 配置（<code>{"mcpServers":{...}}</code>）。导入只做「解析 + 安全审查 + 保存为禁用状态」，<b>绝不会执行</b>其中的命令。</div>
      <textarea id="mcpIn" rows="7" placeholder='{"mcpServers":{"example":{"command":"npx","args":["-y","some-mcp-server"]}}}' style="width:100%;font-family:monospace"></textarea>
      <div class="row" style="gap:8px;margin-top:8px">
        <button class="btn sec" id="mcpParse">解析并审查</button>
        <button class="btn" id="mcpImport">确认导入</button>
        <label style="margin-left:8px"><input type="checkbox" id="mcpOverwrite" /> 覆盖同名</label>
      </div>
      <div id="mcpPreview"></div>
    </div>
    <div class="section">
      <h3>已导入（${servers.length}）</h3>
      ${servers.length ? servers.map((s) => `
        <div class="card" style="margin-top:8px">
          <div class="k">${esc(s.name)} <span class="badge ${s.risk === 'high' ? 'off' : 'on'}">风险：${esc(s.risk)}</span> ${s.enabled ? '<span class="badge on">已登记启用</span>' : '<span class="badge off">禁用</span>'}</div>
          <div class="hint">传输: ${esc(s.transport)}｜命令: ${esc((s.argv || []).join(' ') || '—')}${s.url ? '｜地址: ' + esc(s.url) : ''}</div>
          ${(s.envKeys || []).length ? '<div class="hint">环境变量: ' + esc(s.envKeys.join('、')) + '（值已掩码）</div>' : ''}
          ${(s.findings || []).length ? '<div class="hint">' + s.findings.map((f) => '[' + esc(f.level) + '] ' + esc(f.message)).join('<br>') + '</div>' : ''}
          <div class="row">
            <button class="btn sec" data-mtoggle="${esc(s.name)}" data-on="${s.enabled ? '0' : '1'}">${s.enabled ? '禁用' : '启用'}</button>
            <button class="btn sec" data-mdel="${esc(s.name)}">删除</button>
          </div>
        </div>`).join('') : '<div class="hint">还没有导入任何 MCP 配置。</div>'}
      <div class="hint" style="margin-top:8px">「启用」只是登记状态；真正让机器人使用 MCP 需要机器人侧支持，本工具不代为实现。</div>
    </div>`;

  const readPayload = () => {
    const txt = $('#mcpIn').value.trim();
    if (!txt) return null;
    try { return JSON.parse(txt); } catch (e) { $('#mcpPreview').innerHTML = '<div class="err">JSON 语法错误：' + esc(e.message) + '</div>'; return null; }
  };

  $('#mcpParse').onclick = async () => {
    const payload = readPayload(); if (!payload) return;
    const p = await invoke(C.MCP_PARSE, { payload });
    const c = p.counts || {};
    $('#mcpPreview').innerHTML = `<div class="card">
      <div class="k">解析结果</div>
      <div class="v">共 ${c.total || 0} 个：高危 ${c.high || 0}｜中 ${c.medium || 0}｜低 ${c.low || 0}</div>
      ${(p.errors || []).length ? '<div class="err">' + p.errors.map(esc).join('<br>') + '</div>' : '<div class="ok">结构校验通过</div>'}
      ${(p.warnings || []).length ? '<div class="warn">' + p.warnings.map(esc).join('<br>') + '</div>' : ''}
      ${(p.servers || []).map((s) => `<div class="hint" style="margin-top:6px"><b>${esc(s.name)}</b>（${esc(s.risk)}）：${(s.findings || []).map((f) => esc(f.message)).join('；') || '无风险项'}<br>权限需求: ${(s.permissions || []).map((x) => esc(x.label)).join('、') || '—'}</div>`).join('')}
    </div>`;
  };

  $('#mcpImport').onclick = async () => {
    const payload = readPayload(); if (!payload) return;
    if (!confirm('导入后会以「禁用」状态保存，不会执行任何命令。继续？')) return;
    const p = await invoke(C.MCP_IMPORT, { payload, overwrite: $('#mcpOverwrite').checked });
    $('#mcpPreview').innerHTML = p.ok
      ? '<div class="ok">已保存：' + esc((p.added || []).join('、') || '—') + '。' + esc(p.note || '') + '</div>'
      : '<div class="err">' + esc((p.errors || [p.error]).filter(Boolean).join('；')) + '</div>';
    if (p.ok) setTimeout(() => subMcp(body), 500);
  };

  document.querySelectorAll('[data-mtoggle]').forEach((b) => b.onclick = async () => {
    const x = await invoke(C.MCP_SET_ENABLED, { name: b.dataset.mtoggle, enabled: b.dataset.on === '1' });
    if (x.ok) subMcp(body); else alert(x.error);
  });
  document.querySelectorAll('[data-mdel]').forEach((b) => b.onclick = async () => {
    if (!confirm('删除 MCP 配置 ' + b.dataset.mdel + '？')) return;
    const x = await invoke(C.MCP_DELETE, { name: b.dataset.mdel });
    if (x.ok) subMcp(body); else alert(x.error);
  });
}

/* ---------------- F. 市场接入 ---------------- */
async function subMarket(body) {
  body.innerHTML = '<div class="hint">加载中…</div>';
  const r = await invoke(C.MARKET_SOURCES);
  const sources = (r && r.sources) || [];
  body.innerHTML = `
    <div class="section">
      <h3>来源</h3>
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <select id="mkSrc">${sources.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select>
        <input id="mkEp" placeholder="目录 HTTPS 地址" style="min-width:300px" />
        <input id="mkTok" type="password" placeholder="访问令牌（仅本次使用，不保存）" style="min-width:200px" />
        <button class="btn" id="mkFetch">获取目录</button>
      </div>
      <div class="hint" id="mkSrcHint"></div>
      <div class="hint">也可直接粘贴 catalogue JSON：</div>
      <textarea id="mkJson" rows="5" placeholder='{"items":[{"id":"x","name":"示例","type":"skill","downloadUrl":"https://...","sha256":"..."}]}' style="width:100%;font-family:monospace"></textarea>
      <div class="row" style="margin-top:8px"><button class="btn sec" id="mkParse">解析粘贴内容</button></div>
      <div id="mkOut"></div>
    </div>
    <div class="hint">本工具不代你购买、不绕过鉴权；付费或需鉴权的条目会明确拒绝导入。</div>`;

  const paint = (items, warnings) => {
    const out = $('#mkOut');
    if (!items || !items.length) { out.innerHTML = '<div class="hint">没有条目</div>'; return; }
    out.innerHTML = `<div class="card"><div class="k">目录条目（${items.length}）</div>
      ${(warnings || []).length ? '<div class="warn">' + warnings.map(esc).join('<br>') + '</div>' : ''}
      <table class="tbl"><thead><tr><th>id</th><th>名称</th><th>类型</th><th>版本</th><th>完整性</th><th>鉴权/付费</th></tr></thead><tbody>
      ${items.map((i) => `<tr>
        <td>${esc(i.id)}</td><td>${esc(i.name)}</td><td>${esc(i.type)}</td><td>${esc(i.version || '—')}</td>
        <td>${i.integrity === 'declared' ? '<span class="badge on">已声明 sha256</span>' : '<span class="badge off">未提供</span>'}</td>
        <td>${i.requiresAuth ? '<span class="badge off">需鉴权</span>' : ''}${i.paid ? '<span class="badge off">付费</span>' : ''}${!i.requiresAuth && !i.paid ? '<span class="badge on">可导入</span>' : ''}</td>
      </tr>`).join('')}</tbody></table>
      <div class="hint">导入动作需要在「技能扩展」页逐项确认；此处只做展示与校验。</div></div>`;
  };

  $('#mkSrc').onchange = () => {
    const s = sources.find((x) => x.id === $('#mkSrc').value) || {};
    $('#mkSrcHint').textContent = (s.description || '') + (s.docHint ? ' ' + s.docHint : '');
  };
  $('#mkSrc').onchange();

  $('#mkFetch').onclick = async () => {
    const out = $('#mkOut'); out.innerHTML = '<div class="hint">请求中…</div>';
    const x = await invoke(C.MARKET_FETCH, { sourceId: $('#mkSrc').value, endpoint: $('#mkEp').value.trim(), token: $('#mkTok').value });
    if (!x.ok) { out.innerHTML = '<div class="err">' + esc(x.error) + '</div>'; return; }
    paint(x.items, x.warnings);
  };
  $('#mkParse').onclick = async () => {
    const txt = $('#mkJson').value.trim();
    if (!txt) return;
    let payload;
    try { payload = JSON.parse(txt); } catch (e) { $('#mkOut').innerHTML = '<div class="err">JSON 语法错误：' + esc(e.message) + '</div>'; return; }
    const x = await invoke(C.MARKET_PARSE, { payload });
    paint(x.items, (x.warnings || []).concat(x.errors || []));
  };
}

async function pageOps() {
  content.innerHTML = '<h2>自动化与运维</h2>';
  mountGroup('ops', { wf: subWorkflow, bak: subBackup, cost: subCost, diag: subDiag });
}

/* ---------------- H. 自动化工作流 ---------------- */
const WF_TEMPLATE = {
  id: 'demo-flow', name: '示例流程',
  nodes: [
    { id: 'start', type: 'start', title: '开始' },
    { id: 'set', type: 'setVar', title: '设置变量', params: { name: 'count', value: '3' } },
    { id: 'cond', type: 'if', title: '判断', params: { expr: 'count > 2' } },
    { id: 'msg', type: 'log', title: '记录', params: { message: '计数为 {{count}}' } },
    { id: 'end', type: 'end', title: '结束' },
  ],
  edges: [
    { from: 'start', to: 'set' }, { from: 'set', to: 'cond' },
    { from: 'cond', to: 'msg', when: true }, { from: 'msg', to: 'end' },
  ],
};

async function subWorkflow(body) {
  body.innerHTML = '<div class="hint">加载中…</div>';
  const r = await invoke(C.WORKFLOW_LIST);
  const list = (r && r.workflows) || [];
  body.innerHTML = `
    <div class="section">
      <h3>工作流（${list.length}）</h3>
      ${list.length ? `<table class="tbl"><thead><tr><th>id</th><th>名称</th><th>节点</th><th>连线</th><th>更新时间</th><th></th></tr></thead><tbody>
        ${list.map((w) => `<tr><td>${esc(w.id)}</td><td>${esc(w.name)}</td><td>${esc(w.nodeCount)}</td><td>${esc(w.edgeCount)}</td><td>${esc(w.updatedAt || '—')}</td>
        <td><button class="btn sec" data-wopen="${esc(w.id)}">打开</button> <button class="btn sec" data-wdel="${esc(w.id)}">删除</button></td></tr>`).join('')}
      </tbody></table>` : '<div class="hint">还没有工作流。可用下方模板快速创建一个。</div>'}
    </div>
    <div class="section">
      <h3>编辑器（JSON）</h3>
      <div class="hint">支持节点类型：start / log / setVar / if / delay / notify / serviceCall / end。条件只支持 <code>变量 op 值</code>（op 为 == != &gt; &gt;= &lt; &lt;= contains），不支持任意表达式。</div>
      <textarea id="wfJson" rows="16" style="width:100%;font-family:monospace"></textarea>
      <div class="row" style="gap:8px;margin-top:8px;flex-wrap:wrap">
        <button class="btn sec" id="wfTpl">载入模板</button>
        <button class="btn" id="wfSave">保存</button>
        <button class="btn sec" id="wfDry">演练（不产生副作用）</button>
        <button class="btn" id="wfRun">真正执行</button>
      </div>
      <div id="wfOut"></div>
    </div>`;

  $('#wfTpl').onclick = () => { $('#wfJson').value = JSON.stringify(WF_TEMPLATE, null, 2); };
  if (!list.length) $('#wfJson').value = JSON.stringify(WF_TEMPLATE, null, 2);

  const readWf = () => {
    try { return JSON.parse($('#wfJson').value); } catch (e) { $('#wfOut').innerHTML = '<div class="err">JSON 语法错误：' + esc(e.message) + '</div>'; return null; }
  };

  $('#wfSave').onclick = async () => {
    const wf = readWf(); if (!wf) return;
    const x = await invoke(C.WORKFLOW_SAVE, { workflow: wf });
    $('#wfOut').innerHTML = x.ok ? '<div class="ok">已保存' + (x.warnings && x.warnings.length ? '（提示：' + esc(x.warnings.join('；')) + '）' : '') + '</div>'
      : '<div class="err">' + esc(x.error) + '</div>';
    if (x.ok) setTimeout(() => subWorkflow(body), 400);
  };

  const run = async (dryRun) => {
    const wf = readWf(); if (!wf) return;
    const out = $('#wfOut');
    out.innerHTML = '<div class="hint">执行中…</div>';
    const x = await invoke(C.WORKFLOW_RUN, { id: wf.id, dryRun });
    if (!x.ok) { out.innerHTML = '<div class="err">' + esc((x.run && x.run.error) || x.error || '执行失败') + '</div>'; return; }
    const rr = x.run;
    out.innerHTML = `<div class="card">
      <div class="k">${dryRun ? '演练' : '执行'}结果：${rr.ok ? '成功' : '失败'}</div>
      <div class="v">${rr.steps} 步｜耗时 ${esc(rr.elapsedMs)}ms</div>
      <table class="tbl"><thead><tr><th>#</th><th>节点</th><th>类型</th><th>状态</th><th>说明</th></tr></thead><tbody>
      ${(rr.trace || []).map((t) => `<tr><td>${esc(t.step)}</td><td>${esc(t.nodeId)}</td><td>${esc(t.type)}</td><td>${esc(t.status)}</td><td>${esc(t.detail || '')}</td></tr>`).join('')}
      </tbody></table>
      ${rr.error ? '<div class="err">' + esc(rr.error) + '</div>' : ''}
    </div>`;
  };
  $('#wfDry').onclick = () => run(true);
  $('#wfRun').onclick = () => { if (confirm('真正执行该工作流？（delay 会真实等待，notify 会写入通知中心；服务启动类节点会被安全策略跳过）')) run(false); };

  document.querySelectorAll('[data-wopen]').forEach((b) => b.onclick = async () => {
    const x = await invoke(C.WORKFLOW_GET, { id: b.dataset.wopen });
    if (x.ok) $('#wfJson').value = JSON.stringify(x.workflow, null, 2);
    else alert(x.error);
  });
  document.querySelectorAll('[data-wdel]').forEach((b) => b.onclick = async () => {
    if (!confirm('删除工作流 ' + b.dataset.wdel + '？')) return;
    const x = await invoke(C.WORKFLOW_DELETE, { id: b.dataset.wdel });
    if (x.ok) subWorkflow(body); else alert(x.error);
  });
}

/* ---------------- G. 备份与恢复 ---------------- */
async function subBackup(body) {
  body.innerHTML = '<div class="hint">加载中…</div>';
  const r = await invoke(C.BACKUP_LIST);
  const backups = (r && r.backups) || [];
  body.innerHTML = `
    <div class="section">
      <h3>创建备份</h3>
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <input id="bkLabel" placeholder="备注（可选）" style="width:220px" />
        <label><input type="checkbox" id="bkSecret" /> 包含密钥文件</label>
        <button class="btn" id="bkNew">立即备份</button>
      </div>
      <div class="hint">默认<b>不</b>备份 secrets.json / feiyu_provider_secrets.json；勾选后会一并备份，请妥善保管备份目录。</div>
      <div id="bkMsg"></div>
    </div>
    <div class="section">
      <h3>已有备份（${backups.length}）</h3>
      ${backups.length ? backups.map((b) => `
        <div class="card" style="margin-top:8px">
          <div class="k">${esc(b.id)} ${b.includeSecret ? '<span class="badge off">含密钥</span>' : '<span class="badge on">不含密钥</span>'}</div>
          <div class="hint">${esc(b.createdAt || '')}｜文件 ${esc(b.fileCount)} 个｜${esc((b.bytes / 1024).toFixed(1))} KB ${b.label ? '｜' + esc(b.label) : ''}</div>
          <div class="row">
            <button class="btn sec" data-bdiff="${esc(b.id)}">差异预览</button>
            <button class="btn sec" data-brestore="${esc(b.id)}">恢复此备份</button>
            <button class="btn sec" data-bdel="${esc(b.id)}">删除</button>
          </div>
        </div>`).join('') : '<div class="hint">还没有备份。</div>'}
      <div id="bkOut" style="margin-top:10px"></div>
    </div>`;

  $('#bkNew').onclick = async () => {
    const x = await invoke(C.BACKUP_CREATE, { label: $('#bkLabel').value.trim(), includeSecret: $('#bkSecret').checked });
    $('#bkMsg').innerHTML = x.ok ? '<span class="ok">已备份（' + esc(x.fileCount) + ' 个文件）</span>' : '<span class="err">' + esc(x.error) + '</span>';
    if (x.ok) setTimeout(() => subBackup(body), 400);
  };

  document.querySelectorAll('[data-bdiff]').forEach((b) => b.onclick = async () => {
    const x = await invoke(C.BACKUP_DIFF, { id: b.dataset.bdiff });
    const out = $('#bkOut');
    if (!x.ok) { out.innerHTML = '<div class="err">' + esc(x.error) + '</div>'; return; }
    out.innerHTML = `<div class="card"><div class="k">差异预览：${esc(x.id)}</div>
      <div class="v">新增 ${esc(x.counts.added)}｜变更 ${esc(x.counts.changed)}｜一致 ${esc(x.counts.same)}｜仅当前有 ${esc(x.counts.removed)}</div>
      <table class="tbl"><thead><tr><th>文件</th><th>状态</th><th>当前字节</th><th>备份字节</th></tr></thead><tbody>
      ${x.files.map((f) => `<tr><td>${esc(f.name)}</td><td>${esc(f.status)}</td><td>${esc(f.bytesFrom == null ? '—' : f.bytesFrom)}</td><td>${esc(f.bytesTo == null ? '—' : f.bytesTo)}</td></tr>`).join('')}
      </tbody></table>
      ${(x.warnings || []).length ? '<div class="warn">' + x.warnings.map(esc).join('<br>') + '</div>' : ''}</div>`;
  });

  document.querySelectorAll('[data-brestore]').forEach((b) => b.onclick = async () => {
    if (!confirm('恢复会用备份内容覆盖当前配置（恢复前会自动再备份一次当前状态）。继续？')) return;
    const x = await invoke(C.BACKUP_RESTORE, { id: b.dataset.brestore });
    const out = $('#bkOut');
    out.innerHTML = x.ok
      ? `<div class="card"><div class="k">恢复完成</div><div class="v">已恢复 ${esc((x.restored || []).length)} 个文件</div>
         ${x.preRestoreId ? '<div class="hint">恢复前快照：' + esc(x.preRestoreId) + '</div>' : ''}
         ${(x.skipped || []).length ? '<div class="hint">跳过：' + esc(x.skipped.map((s) => s.name + '(' + s.reason + ')').join('、')) + '</div>' : ''}
         ${(x.warnings || []).length ? '<div class="warn">' + x.warnings.map(esc).join('<br>') + '</div>' : ''}</div>`
      : `<div class="err">恢复失败：${esc(x.error)}${x.rolledBack ? '（已回滚到恢复前状态）' : ''}</div>`;
  });
  document.querySelectorAll('[data-bdel]').forEach((b) => b.onclick = async () => {
    if (!confirm('删除备份 ' + b.dataset.bdel + '？此操作不可恢复。')) return;
    const x = await invoke(C.BACKUP_DELETE, { id: b.dataset.bdel });
    if (x.ok) subBackup(body); else alert(x.error);
  });
}

/* ---------------- I. 成本与预算 ---------------- */
async function subCost(body) {
  body.innerHTML = '<div class="hint">加载中…</div>';
  const [rep, bud] = await Promise.all([invoke(C.COST_REPORT, { range: 'month' }), invoke(C.COST_BUDGET_GET)]);
  const rp = (rep && rep.report) || {};
  const b = (bud && bud.budget) || {};
  const bs = rp.budget || {};
  body.innerHTML = `
    <div class="section">
      <h3>本月估算（${esc(rp.currency || 'CNY')}）</h3>
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <span class="badge on">请求 ${esc(rp.totals ? rp.totals.requests : 0)}</span>
        <span class="badge on">Token ${esc(rp.totals ? rp.totals.totalTokens : 0)}</span>
        <span class="badge ${rp.priced ? 'on' : 'off'}">估算费用 ${rp.priced ? esc(rp.totals.cost) : '未计价'}</span>
      </div>
      <div class="hint" style="margin-top:6px">${esc(rp.note || '')}</div>
      <div class="warn" style="margin-top:6px">${esc(rp.disclaimer || '')}</div>
      ${bs.configured ? `<div class="${bs.level === 'exceeded' ? 'err' : (bs.level === 'warn' ? 'warn' : 'ok')}" style="margin-top:8px">${esc(bs.message || '')}</div>` : ''}
      ${(rp.byModel || []).length ? `<table class="tbl" style="margin-top:10px"><thead><tr><th>模型</th><th>输入 Token</th><th>输出 Token</th><th>请求</th><th>估算费用</th></tr></thead><tbody>
        ${rp.byModel.map((m) => `<tr><td>${esc(m.model)}</td><td>${fmt(m.promptTokens)}</td><td>${fmt(m.completionTokens)}</td><td>${fmt(m.requests)}</td>
        <td>${m.priced ? esc(m.cost) : '<span class="warn">未定价</span>'}</td></tr>`).join('')}
      </tbody></table>` : '<div class="hint">本月没有可统计的模型用量。</div>'}
      ${(rp.unpricedModels || []).length ? '<div class="warn">以下模型未在价格表中，费用未计入：' + esc(rp.unpricedModels.join('、')) + '</div>' : ''}
    </div>
    <div class="section">
      <h3>预算提醒</h3>
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <label>月度预算</label><input id="bdMonth" value="${esc(b.monthly == null ? '' : b.monthly)}" style="width:110px" placeholder="如 50" />
        <label>预警比例</label><input id="bdRatio" value="${esc(b.warnRatio == null ? '0.8' : b.warnRatio)}" style="width:80px" />
        <button class="btn" id="bdSave">保存</button>
      </div>
      <div class="hint">预算只是本地提醒阈值，不会限流或拦截真实请求。</div>
      <div id="bdMsg"></div>
    </div>`;
  $('#bdSave').onclick = async () => {
    const budget = {};
    const m = parseFloat($('#bdMonth').value);
    const rt = parseFloat($('#bdRatio').value);
    if (!isNaN(m)) budget.monthly = m;
    if (!isNaN(rt)) budget.warnRatio = rt;
    const x = await invoke(C.COST_BUDGET_SET, { budget });
    $('#bdMsg').innerHTML = x.ok ? '<span class="ok">已保存</span>' : '<span class="err">' + esc(x.error) + '</span>';
    if (x.ok) setTimeout(() => subCost(body), 300);
  };
}

/* ---------------- J. 诊断与通知 ---------------- */
async function subDiag(body) {
  body.innerHTML = '<div class="hint">加载中…</div>';
  const [dg, nt] = await Promise.all([invoke(C.DIAG_COLLECT), invoke(C.NOTIFY_LIST, { limit: 30 })]);
  const d = (dg && dg.diagnostics) || {};
  const items = (nt && nt.items) || [];
  body.innerHTML = `
    <div class="section">
      <h3>环境诊断</h3>
      <div class="card">
        <div class="k">运行环境</div>
        <div class="hint">App ${esc(d.env ? d.env.appVersion : '')}｜Electron ${esc(d.env ? d.env.electronVersion : '')}｜Node ${esc(d.env ? d.env.nodeVersion : '')}</div>
        <div class="hint">平台 ${esc(d.env ? d.env.platform + '/' + d.env.arch : '')}｜CPU ${esc(d.env ? d.env.cpus : 0)} 核｜内存 ${esc(d.env ? d.env.freeMemMB : 0)}MB 可用 / ${esc(d.env ? d.env.totalMemMB : 0)}MB</div>
        <div class="hint">机器人目录：配置 ${d.paths && d.paths.botDirConfigured ? '是' : '否'}｜存在 ${d.paths && d.paths.botDirExists ? '是' : '否'}｜核心文件 ${d.paths && d.paths.botCorePresent ? '有' : '缺'}｜源码检出 ${d.paths && d.paths.isSourceCheckout ? '是' : '否'}</div>
        <div class="hint">密钥文件：bot ${d.secrets && d.secrets.botSecretsPresent ? '存在' : '不存在'}｜桌面 Provider ${d.secrets && d.secrets.providerSecretsPresent ? '存在' : '不存在'}（仅统计存在性）</div>
        <div class="hint">统计：Provider ${esc(d.counts ? d.counts.providers : 0)}｜技能 ${esc(d.counts ? d.counts.skills : 0)}｜MCP ${esc(d.counts ? d.counts.mcp : 0)}｜工作流 ${esc(d.counts ? d.counts.workflows : 0)}</div>
      </div>
      ${(d.timeline || []).length ? '<div style="margin-top:8px">' + d.timeline.map((t) => `<div class="${t.level === 'error' ? 'err' : (t.level === 'warn' ? 'warn' : 'hint')}">${esc(t.message)}</div>`).join('') + '</div>' : ''}
      <div class="row" style="margin-top:10px"><button class="btn" id="dgExport">导出脱敏诊断包</button></div>
      <div id="dgOut"></div>
    </div>
    <div class="section">
      <h3>通知（未读 ${esc(nt.unread || 0)} / 共 ${esc(nt.total || 0)}）</h3>
      <div class="row" style="gap:8px"><button class="btn sec" id="ntRead">全部标为已读</button><button class="btn sec" id="ntClear">清空</button></div>
      ${items.length ? items.map((n) => `<div class="card" style="margin-top:8px;opacity:${n.read ? '0.6' : '1'}">
        <div class="k"><span class="badge ${n.level === 'error' ? 'off' : 'on'}">${esc(n.level)}</span> ${esc(n.title)}</div>
        <div class="hint">${esc(n.message)}</div>
        <div class="hint">${esc(n.at)}｜来源 ${esc(n.source)}${n.read ? '' : '｜<b>未读</b>'}</div>
      </div>`).join('') : '<div class="hint">没有通知。</div>'}
    </div>`;

  $('#dgExport').onclick = async () => {
    const x = await invoke(C.DIAG_EXPORT);
    $('#dgOut').innerHTML = x.ok
      ? `<div class="ok">已生成脱敏诊断包（${esc(x.bytes)} 字节）。可直接复制下面内容上报。</div>
         <textarea rows="12" style="width:100%;font-family:monospace" readonly>${esc(x.json)}</textarea>`
      : '<div class="err">' + esc(x.error) + '</div>';
  };
  $('#ntRead').onclick = async () => { const x = await invoke(C.NOTIFY_MARK_READ, { id: 'all' }); if (x.ok) subDiag(body); };
  $('#ntClear').onclick = async () => { if (!confirm('清空所有通知？')) return; const x = await invoke(C.NOTIFY_CLEAR); if (x.ok) subDiag(body); };
}

/* ==================================================================================
 * 模块 K：终端 / 实时状态监控 / 实时日志流
 *  - 终端：经固定 IPC 通道发「打开/输入/关闭」，Shell 在 Main 执行，输出流式回推。
 *  - 监控：轮询 MONITOR_STATUS，卡片用加载/运行/停止三态动画。
 *  - 日志：LOG_STREAM_START 取最近行，新行经 LOG_STREAM_LINE 实时追加（带淡入动画）。
 * ================================================================================== */
async function pageConsole() {
  content.innerHTML = `
    <h2>终端与监控</h2>
    <div class="hint">本地终端：命令在本机「机器人目录」下执行，软件会如实执行你输入的每一条指令。内置命令：<code>help</code> <code>status</code> <code>start comfy</code> <code>stop comfy</code> <code>start bot</code> <code>stop bot</code> <code>clear</code> <code>version</code>；其余按系统 Shell 执行。</div>

    <div class="section">
      <h3>实时状态监控</h3>
      <div class="monitor-grid" id="monGrid">
        <div class="mon-card loading" data-svc="bridge"><span class="mon-dot"></span><div class="mon-name">AI 桥</div><div class="mon-state">加载中…</div><div class="mon-meta"></div></div>
        <div class="mon-card loading" data-svc="napcat"><span class="mon-dot"></span><div class="mon-name">NapCat</div><div class="mon-state">加载中…</div><div class="mon-meta"></div></div>
        <div class="mon-card loading" data-svc="comfy"><span class="mon-dot"></span><div class="mon-name">ComfyUI</div><div class="mon-state">加载中…</div><div class="mon-meta"></div></div>
      </div>

      <div class="perf-row" id="perfRow">
        <div class="perf-card"><div class="pk">本软件</div><div class="pv" id="pfApp">—</div></div>
        <div class="perf-card"><div class="pk">机器人</div><div class="pv" id="pfBot">—</div></div>
        <div class="perf-card total"><div class="pk">合计占用（本软件 + 机器人）</div><div class="pv" id="pfTotal">—</div></div>
      </div>

      <div class="tl-wrap">
        <div class="tl-title">运行时间轴（最近 5 分钟）</div>
        <div id="tlBody"></div>
      </div>
      <div class="hint" id="monUpd">就绪</div>
    </div>

    <div class="section">
      <h3>实时日志 <span class="live-badge" id="liveBadge">● LIVE</span></h3>
      <div class="row"><input id="logFilter" placeholder="过滤关键字（实时）" /><button class="btn sm sec" id="logPause">暂停</button><button class="btn sm sec" id="logClear">清屏</button></div>
      <div class="term-log" id="liveLog"></div>
    </div>

    <div class="section">
      <h3>终端 <span class="cmd-badge ready" id="cmdBadge">就绪</span></h3>
      <div class="term-out" id="termOut"></div>
      <div class="term-input-row">
        <span class="term-prompt" id="termPrompt">$</span>
        <input id="termInput" class="term-input" placeholder="输入命令后回车…（输入 help 查看内置命令）" autocomplete="off" spellcheck="false" />
      </div>
      <div class="hint">支持上下方向键调出历史命令；命令指示会在执行时变为「执行中…」动画。</div>
    </div>`;

  const out = $('#termOut');
  const input = $('#termInput');
  const cmdBadge = $('#cmdBadge');
  const liveLog = $('#liveLog');
  const liveBadge = $('#liveBadge');
  const logFilter = $('#logFilter');
  const monGrid = $('#monGrid');
  const monUpd = $('#monUpd');
  // 状态动画风格来自主题（breathe/pulse/flow/min），默认呼吸
  try {
    const mfx = (themeState && themeState.theme && themeState.theme.monFx) || 'breathe';
    monGrid.setAttribute('data-mon-fx', mfx);
  } catch (_) { monGrid.setAttribute('data-mon-fx', 'breathe'); }
  let logPaused = false;
  const history = [];
  let histIdx = -1;

  // ---------- 终端：本地输出辅助 ----------
  function printSys(text, cls) {
    const div = document.createElement('div');
    div.className = 'term-line ' + (cls || 'sys');
    div.textContent = text;
    out.appendChild(div);
    out.scrollTop = out.scrollHeight;
  }
  printSys('肥鱼本地终端已就绪。输入 help 查看内置命令，其余命令按本机 Shell 执行。', 'sys');

  // ---------- 实时状态监控 ----------
  function setCard(svc, state, stateText, meta) {
    const card = monGrid.querySelector('[data-svc="' + svc + '"]');
    if (!card) return;
    card.className = 'mon-card ' + state;
    card.querySelector('.mon-state').textContent = stateText;
    card.querySelector('.mon-meta').textContent = meta || '';
  }
  const hist = [];
  const startedAt = { bridge: 0, napcat: 0, comfy: 0 };
  const MAXH = 150;
  const svcName = { bridge: 'AI 桥', napcat: 'NapCat', comfy: 'ComfyUI' };
  function fmtDur(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + ss + 's';
  }
  function renderTimeline() {
    const tl = $('#tlBody'); if (!tl) return;
    tl.innerHTML = Object.keys(svcName).map((svc) => {
      const segs = hist.map((h) => '<i class="tl-seg ' + (h[svc] ? 'on' : 'off') + '"></i>').join('');
      return '<div class="tl-row"><span class="tl-name">' + svcName[svc] + '</span><span class="tl-track">' + (segs || '<i class="tl-seg off"></i>') + '</span></div>';
    }).join('');
  }
  async function refreshMonitor() {
    monGrid.classList.add('refreshing');
    try {
      const r = await invoke(C.MONITOR_STATUS);
      const m = r && r.monitor;
      if (!m) return;
      const map = { bridge: m.bridge, napcat: m.napcat, comfy: m.comfy };
      const now = m.time || Date.now();
      const snap = { t: now, bridge: !!(m.bridge && m.bridge.running), napcat: !!(m.napcat && m.napcat.running), comfy: !!(m.comfy && m.comfy.running) };
      hist.push(snap); if (hist.length > MAXH) hist.shift();
      for (const svc of ['bridge', 'napcat', 'comfy']) {
        const s = map[svc];
        if (!s) continue;
        const running = !!s.running;
        if (running) { if (!startedAt[svc]) startedAt[svc] = now; } else startedAt[svc] = 0;
        let meta = '';
        if (svc === 'comfy') meta = s.found ? ('端口 ' + s.port + (s.version ? ' · v' + s.version : '')) : '未检测到';
        else meta = '端口 ' + s.port + (running && s.pid ? ' · PID ' + s.pid : '');
        if (running && startedAt[svc]) meta += ' · 已运行 ' + fmtDur(now - startedAt[svc]);
        setCard(svc, running ? 'running' : 'stopped', running ? '运行中' : '已停止', meta);
      }
      renderTimeline();
      const pf = r.perf;
      if (pf) {
        const $a = $('#pfApp'), $b = $('#pfBot'), $t = $('#pfTotal');
        if ($a) $a.textContent = 'CPU ' + pf.app.cpuPercent + '% · 内存 ' + pf.app.memMB + ' MB';
        if ($b) $b.textContent = pf.bot.processes ? ('CPU ' + pf.bot.cpuPercent + '% · 内存 ' + pf.bot.memMB + ' MB（' + pf.bot.processes + ' 进程）') : '未运行';
        if ($t) $t.textContent = 'CPU ' + pf.total.cpuPercent + '% · 内存 ' + pf.total.memMB + ' MB';
      }
      monUpd.textContent = '更新于 ' + new Date(now).toLocaleTimeString('zh-CN');
    } catch (_) {
      monUpd.textContent = '状态获取失败';
    } finally {
      setTimeout(() => monGrid.classList.remove('refreshing'), 400);
    }
  }
  await refreshMonitor();
  const monTimer = setInterval(refreshMonitor, 2000);
  addCleanup(() => clearInterval(monTimer));

  // ---------- 实时日志流 ----------
  function appendLog(line) {
    if (logPaused) return;
    const kw = (logFilter.value || '').trim().toLowerCase();
    if (kw && !String(line).toLowerCase().includes(kw)) return;
    const div = document.createElement('div');
    div.className = 'log-line';
    div.textContent = line;
    liveLog.appendChild(div);
    while (liveLog.childElementCount > 2000) liveLog.removeChild(liveLog.firstChild);
    liveLog.scrollTop = liveLog.scrollHeight;
  }
  function printLogSys(text) {
    const div = document.createElement('div');
    div.className = 'log-line sys';
    div.textContent = text;
    liveLog.appendChild(div);
  }
  const offLine = fOn(C.LOG_STREAM_LINE, (p) => appendLog(p.line));
  addCleanup(offLine);
  $('#logPause').onclick = () => {
    logPaused = !logPaused;
    $('#logPause').textContent = logPaused ? '继续' : '暂停';
    liveBadge.classList.toggle('paused', logPaused);
    liveBadge.textContent = logPaused ? '⏸ 已暂停' : '● LIVE';
  };
  $('#logClear').onclick = () => { liveLog.innerHTML = ''; };
  try {
    const r = await invoke(C.LOG_STREAM_START, { lines: 200 });
    if (r && r.ok) {
      (r.lines || []).forEach((l) => appendLog(l));
      if (!r.exists) printLogSys('（未检测到 ai_bridge.log，配置机器人目录后将开始实时追踪）');
    } else if (r && r.error) {
      printLogSys('日志流未开启: ' + r.error);
    }
  } catch (_) {}
  addCleanup(() => { try { invoke(C.LOG_STREAM_STOP); } catch (_) {} });

  // ---------- 终端会话 ----------
  let sessionId = null;
  const offOut = fOn(C.TERMINAL_OUTPUT, (p) => {
    if (sessionId && p.sessionId !== sessionId) return;
    const text = String(p.text || '');
    const parts = text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      const div = document.createElement('div');
      div.className = 'term-line ' + (p.stream === 'stderr' ? 'err' : (p.stream === 'system' ? 'sys' : 'out'));
      div.textContent = parts[i].replace(/\r$/, '');
      out.appendChild(div);
    }
    while (out.childElementCount > 3000) out.removeChild(out.firstChild);
    out.scrollTop = out.scrollHeight;
  });
  const offExit = fOn(C.TERMINAL_EXIT, (p) => { if (!sessionId || p.sessionId === sessionId) setCmdBadge('ready'); });
  const offClear = fOn(C.TERMINAL_CLEAR, (p) => { if (!sessionId || p.sessionId === sessionId) out.innerHTML = ''; });
  addCleanup(() => { offOut(); offExit(); offClear(); });

  function setCmdBadge(state) {
    cmdBadge.className = 'cmd-badge ' + state;
    cmdBadge.textContent = state === 'running' ? '执行中…' : '就绪';
  }

  try {
    const r = await invoke(C.TERMINAL_OPEN);
    if (r && r.ok) {
      sessionId = r.sessionId;
      printSys('工作目录: ' + r.cwd, 'sys');
    } else {
      printSys('终端打开失败: ' + (r && r.error || '未知'), 'err');
    }
  } catch (_) {}

  async function sendLine() {
    const line = input.value;
    if (!sessionId) { printSys('终端未连接。', 'err'); return; }
    const echo = document.createElement('div');
    echo.className = 'term-line cmd';
    echo.innerHTML = '<span class="term-prompt-inline">$</span> ' + esc(line);
    out.appendChild(echo);
    out.scrollTop = out.scrollHeight;
    if (line.trim()) { history.push(line); if (history.length > 200) history.shift(); }
    histIdx = history.length;
    input.value = '';
    setCmdBadge('running');
    try {
      const r = await invoke(C.TERMINAL_INPUT, { sessionId, line });
      if (!r || !r.ok) printSys('错误: ' + (r && r.error || '未知'), 'err');
    } catch (e) {
      printSys('发送失败: ' + (e && e.message || e), 'err');
    }
    // 命令指示动画：1.5s 后回到就绪（Shell 为常驻会话，不靠退出判定）
    setTimeout(() => setCmdBadge('ready'), 1500);
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendLine(); }
    else if (e.key === 'ArrowUp') {
      if (history.length && histIdx > 0) { histIdx--; input.value = history[histIdx]; e.preventDefault(); }
    } else if (e.key === 'ArrowDown') {
      if (histIdx < history.length - 1) { histIdx++; input.value = history[histIdx]; }
      else { histIdx = history.length; input.value = ''; }
      e.preventDefault();
    }
  });

  addCleanup(() => { if (sessionId) { try { invoke(C.TERMINAL_CLOSE, { sessionId }); } catch (_) {} } });
  setTimeout(() => input.focus(), 0);
}

// 启动：先加载主题（写 CSS 变量 + 启动背景动画），再渲染首页。
// 主题加载失败也不能阻塞启动 —— 回退默认主题即可。
(async () => {
  try { await loadTheme(); } catch (_) {}
  render('overview');
})();
