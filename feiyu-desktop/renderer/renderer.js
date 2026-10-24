'use strict';
/* renderer.js —— 肥鱼桌面控制中心 UI 逻辑。仅通过 window.feiyu.invoke 与 Main 通信。 */
const f = window.feiyu;
const C = f.channels;
const $ = (s, r = document) => r.querySelector(s);
const content = $('#content');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => (n == null ? 0 : n).toLocaleString('zh-CN');
const invoke = (ch, args) => f.invoke(ch, args);

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
  $('#botDirLabel').textContent = d ? '机器人目录:\n' + d : '未配置机器人目录（设置里选择）';
}

function render(page) {
  refreshBotDirLabel();
  const map = { overview: pageOverview, run: pageRun, api: pageApi, usage: pageUsage, personality: pagePersonality, logs: pageLogs, importexport: pageImportExport, about: pageAbout };
  (map[page] || pageOverview)();
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
      <div class="card"><div class="k">今日请求</div><div class="v">${fmt(u.requests ?? u.totalTokens != null ? (u.answerRequests || 0) + (u.judgeRequests || 0) : 0)}</div></div>
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
      <h3>NapCat 快速登录（可选）</h3>
      <label>QQ 号</label><input id="ncAcc" value="${esc(set.napcat && set.napcat.account || '')}" placeholder="如 1430831772" />
      <label>密码 MD5</label><input id="ncMd5" value="${esc(set.napcat && set.napcat.passwordMd5 || '')}" placeholder="NAPCAT_QUICK_PASSWORD_MD5" />
      <div class="hint">留空则只启动 AI 桥（需外部 NapCat 已就绪）。</div>
    </div>
    <div class="section"><h3>启动输出 / 日志</h3><div class="log" id="runlog"></div></div>`;
  const log = await invoke(C.LOG_TAIL, { lines: 20 });
  $('#runlog').textContent = (log.lines && log.lines.length) ? log.lines.join('\n') : '（暂无日志）';

  $('#startBtn').onclick = async () => {
    const napcat = { account: $('#ncAcc').value.trim(), passwordMd5: $('#ncMd5').value.trim() };
    if (!napcat.account) napcat.account = (set.napcat && set.napcat.account) || '';
    const r = await invoke(C.PROC_START, { napcat: napcat.account ? napcat : null });
    $('#runMsg').innerHTML = r.ok ? '<span class="ok">已发起启动，PID=' + (r.pids || []).join(',') + (r.note ? '；' + esc(r.note) : '') + '</span>' : '<span class="err">' + esc(r.error || '启动失败') + '</span>';
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
      const napcat = { account: $('#ncAcc').value.trim() };
      await invoke(C.PROC_START, { napcat: napcat.account ? napcat : null, force: true });
      pageRun();
    }, 1200);
  };
  $('#pickBtn').onclick = async () => { const d = await pickBotDir(); if (d) pageRun(); };
}

/* ---------- API 与模型 ---------- */
async function pageApi() {
  content.innerHTML = '<h2>API 与模型</h2><div id="ap"></div>';
  const box = $('#ap');
  const cfg = await invoke(C.CONFIG_READ);
  const sec = await invoke(C.SECRET_HAS_KEY);
  const api = (cfg.config && cfg.config.api) || {};
  box.innerHTML = `
    <div class="section">
      <h3>Provider 配置（OpenAI 兼容协议）</h3>
      <label>Base URL</label><input id="baseUrl" value="${esc(api.baseUrl || 'https://api.deepseek.com/v1/chat/completions')}" />
      <label>主模型</label><input id="model" value="${esc(api.model || '')}" placeholder="deepseek-chat" />
      <label>推理模型</label><input id="rModel" value="${esc(api.reasoningModel || '')}" placeholder="deepseek-reasoner" />
      <label>超时(ms)</label><input id="timeout" type="number" value="${esc(api.timeoutMs != null ? api.timeoutMs : 90000)}" />
      <label>重试次数</label><input id="retries" type="number" value="${esc(api.maxRetries != null ? api.maxRetries : 2)}" />
      <div class="row"><button class="btn" id="saveApi">保存 API 配置</button></div>
      <div class="hint" id="apiMsg"></div>
    </div>
    <div class="section">
      <h3>密钥（secret，不进导出包/日志）</h3>
      <div class="hint">当前状态：${sec.hasKey ? '<span class="ok">已配置 API Key</span>' : '<span class="err">未配置，AI 桥将无法启动</span>'}</div>
      <label>API Key</label><input id="apiKey" type="password" placeholder="sk-..." />
      <label>OneBot Token</label><input id="onebot" type="password" placeholder="NapCat token" />
      <label>生图 API Key</label><input id="imgKey" type="password" placeholder="可选" />
      <div class="row"><button class="btn sec" id="saveSec">保存密钥</button></div>
      <div class="hint" id="secMsg"></div>
    </div>`;
  $('#saveApi').onclick = async () => {
    const partial = { api: { baseUrl: $('#baseUrl').value.trim(), model: $('#model').value.trim(), reasoningModel: $('#rModel').value.trim(), timeoutMs: Number($('#timeout').value), maxRetries: Number($('#retries').value) } };
    const r = await invoke(C.CONFIG_APPLY, { partial });
    $('#apiMsg').innerHTML = r.ok ? '<span class="ok">已保存（需重启 AI 桥生效）</span>' : '<span class="err">' + esc((r.errors || []).join('；') || r.error) + '</span>';
  };
  $('#saveSec').onclick = async () => {
    const data = { apiKey: $('#apiKey').value, onebotToken: $('#onebot').value, imageApiKey: $('#imgKey').value };
    const r = await invoke(C.SECRET_WRITE, { data });
    $('#secMsg').innerHTML = r.ok ? '<span class="ok">密钥已保存（仅本机，已收紧权限）</span>' : '<span class="err">' + esc(r.error) + '</span>';
  };
}

/* ---------- 用量明细 ---------- */
async function pageUsage() {
  content.innerHTML = '<h2>用量明细</h2><div class="row" id="urange">' +
    ['today', 'yesterday', '7d', 'month', 'all'].map((r) => `<button class="btn sec" data-r="${r}">${r === 'today' ? '今日' : r === 'yesterday' ? '昨日' : r === '7d' ? '近7天' : r === 'month' ? '本月' : '全部'}</button>`).join('') +
    '</div><div id="us"></div>';
  const load = async (range) => {
    const box = $('#us'); box.innerHTML = '<div class="hint">加载中…</div>';
    const r = await invoke(C.USAGE_GET, { range });
    const u = r.usage || {};
    const cost = u.cost || {};
    const reqs = u.recentRequests || [];
    box.innerHTML = `
      <div class="grid">
        <div class="card"><div class="k">总 Token</div><div class="v">${fmt(u.totalTokens)}</div></div>
        <div class="card"><div class="k">输入 / 输出</div><div class="v" style="font-size:15px">${fmt(u.promptTokens)} / ${fmt(u.completionTokens)}</div></div>
        <div class="card"><div class="k">推理 Token</div><div class="v">${fmt(u.reasoningTokens)}</div></div>
        <div class="card"><div class="k">缓存命中</div><div class="v">${fmt(u.cacheHitTokens)}</div></div>
        <div class="card"><div class="k">估算费用</div><div class="v" style="font-size:15px">${cost.priced ? '¥' + (cost.totalCost ?? 0) + (cost.priceVersion ? ' <small>' + esc(cost.priceVersion) + '</small>' : '') : '未计价'}</div></div>
        <div class="card"><div class="k">数据源</div><div class="v" style="font-size:14px">${esc(u.source || '—')}</div></div>
      </div>
      <div class="section"><h3>最近请求明细（最多 50）</h3>
        <table><thead><tr><th>时间</th><th>类型</th><th>模型</th><th class="num">输入</th><th class="num">输出</th><th class="num">推理</th><th class="num">缓存命中</th><th class="num">合计</th><th class="num">费用</th></tr></thead>
        <tbody>${reqs.length ? reqs.map((x) => `<tr><td class="muted">${esc((x.time || '').replace('T', ' ').slice(5, 16))}</td><td><span class="pill">${esc(x.kind)}</span></td><td class="muted">${esc(x.model)}</td><td class="num">${fmt(x.prompt_tokens)}</td><td class="num">${fmt(x.completion_tokens)}</td><td class="num">${fmt(x.reasoning_tokens)}</td><td class="num">${fmt(x.cache_hit_tokens)}</td><td class="num"><b>${fmt(x.total_tokens)}</b></td><td class="num">${x._cost && x._cost.priced ? '¥' + x._cost.cost : '—'}</td></tr>`).join('') : '<tr><td colspan="9" class="muted">该范围暂无数据</td></tr>'}</tbody></table>
        <div class="hint">${u.source === 'files' ? '数据来自 memory/usage/*.jsonl（不含聊天内容与 Key）。' : '数据来自运行中的机器人 /api/usage。'}${cost.priced ? '' : ' 未配置价格表 → 费用显示「未计价」。'}</div>
      </div>`;
  };
  document.querySelectorAll('#urange button').forEach((b) => b.onclick = () => load(b.dataset.r));
  load('today');
}

/* ---------- 人格设置 ---------- */
async function pagePersonality() {
  content.innerHTML = '<h2>人格设置</h2><div id="ps"></div>';
  const box = $('#ps');
  box.innerHTML = '<div class="hint">加载中…</div>';
  const r = await invoke(C.PERSONALITY_READ);
  box.innerHTML = `
    <div class="section">
      <label>系统提示词 / 人格（保存即时生效，不重启）</label>
      <textarea id="prompt">${esc(r.content || '')}</textarea>
      <div class="row"><button class="btn" id="saveP">保存人格</button><span class="hint">修改会真正写入 ai_prompt.txt，影响机器人实际行为。</span></div>
      <div class="hint" id="pMsg"></div>
    </div>`;
  $('#saveP').onclick = async () => {
    const rr = await invoke(C.PERSONALITY_WRITE, { content: $('#prompt').value });
    $('#pMsg').innerHTML = rr.ok ? '<span class="ok">已保存（即时生效）</span>' : '<span class="err">' + esc(rr.error) + '</span>';
  };
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

render('overview');
