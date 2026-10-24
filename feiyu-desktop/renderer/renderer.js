'use strict';
/* renderer.js —— 肥鱼桌面控制中心 UI 逻辑。仅通过 window.feiyu.invoke 与 Main 通信。 */
const f = window.feiyu;
const C = f.channels;
const $ = (s, r = document) => r.querySelector(s);
const content = $('#content');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => (n == null ? 0 : n).toLocaleString('zh-CN');
const invoke = (ch, args) => f.invoke(ch, args);

let editPid = null;                              // 正在编辑的 Provider id
let usageFilter = { provider: '', model: '', status: '' };
let usageCurrent = null;                         // 当前用量数据（筛选用）
let usagePrice = null;                           // 当前价格表

function shortUrl(u) { if (!u) return '—'; try { const x = new URL(u); return x.host + x.pathname; } catch (_) { return u; } }
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
  refreshBotDirLabel();
  const map = { overview: pageOverview, run: pageRun, api: pageApi, usage: pageUsage, personality: pagePersonality, skills: pageSkills, comfy: pageComfy, logs: pageLogs, importexport: pageImportExport, about: pageAbout };
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
      <h3 id="pFormTitle">新增 Provider</h3>
      <label>名称</label><input id="pName" placeholder="如 DeepSeek / 我的中转" />
      <label>Base URL（OpenAI 兼容 /chat/completions）</label><input id="pBase" placeholder="https://api.deepseek.com/v1/chat/completions" />
      <label>主模型</label><input id="pModel" placeholder="deepseek-chat" />
      <label>推理模型（可选）</label><input id="pRModel" placeholder="deepseek-reasoner" />
      <label>超时(ms)</label><input id="pTimeout" type="number" value="30000" />
      <label>重试次数</label><input id="pRetry" type="number" value="2" />
      <label>API Key（仅存本机密钥文件，不进注册表明文）</label><input id="pKey" type="password" placeholder="sk-..." />
      <div class="row"><button class="btn" id="pSave">保存 Provider</button><button class="btn sec" id="pCancel" style="display:none">取消编辑</button></div>
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
  $('#pSave').onclick = async () => {
    const provider = {
      name: $('#pName').value.trim(), baseUrl: $('#pBase').value.trim(), model: $('#pModel').value.trim(),
      reasoningModel: $('#pRModel').value.trim(), timeoutMs: Number($('#pTimeout').value), maxRetries: Number($('#pRetry').value),
    };
    const key = $('#pKey').value;
    if (key) provider.key = key;
    if (editPid) provider.id = editPid;
    const r = await invoke(C.PROVIDER_SAVE, { provider });
    $('#pMsg').innerHTML = r.ok ? '<span class="ok">已保存' + (r.complete ? '' : '（配置不完整：请补全 baseUrl/model/密钥）') + '</span>' : '<span class="err">' + esc((r.errors || []).join('；') || r.error) + '</span>';
    if (r.ok) { editPid = null; pageApi(); }
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
async function pageComfy() {
  content.innerHTML = '<h2>ComfyUI 生图</h2><div id="cf"></div>';
  const box = $('#cf');
  box.innerHTML = '<div class="hint">加载中…</div>';

  const load = async () => {
    const st = await invoke(C.COMFY_STATUS);
    const pr = await invoke(C.COMFY_PREREQ);
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

render('overview');
