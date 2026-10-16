'use strict';
// ================= 安全浏览器操作适配器（阶段 C） =================
// 受限操作接口：打开允许网站、获取标题/正文、提取信息、在限定测试环境填表、保存结果。
// 默认 provider='mock'（不依赖 Playwright，零第三方依赖）。
// 安全规则：仅允许白名单域名；不提交密码/Cookie/Key/私人资料；不允许执行任意脚本；
//          超时+停止机制；不绕过验证码/登录/反自动化；测试结束不留后台进程。
//
// V15 修正（要求⑤）：域名白名单【不是】完整的 SSRF 防护！
//   - _check 在白名单之外，额外调用 url_safety.isSafeUrl 拒绝内网/环回/链路本地/云元数据/带凭据 URL；
//   - Playwright 真实浏览默认关闭，必须显式 allowRealBrowse 才启用；且每个请求（含重定向、子资源）
//     都经 url_safety.resolveTarget 做「DNS 解析后 IP 分类」校验，阻断 DNS 重绑定；
//   - 无法保证绝对安全（Playwright 不支持对任意主机做 IP 固定）时，保持 Playwright 关闭、只留 mock。

const fs = require('fs');
const path = require('path');
const dns = require('dns');
const { isAllowlistedDomain } = require('./permissions');
const { isSafeUrl, resolveTarget } = require('../url_safety');

class BrowserAdapter {
  /**
   * @param {object} opts { enabled, provider, allow:[], timeoutMs, workDir, allowRealBrowse, playwright? }
   */
  constructor(opts) {
    opts = opts || {};
    this.enabled = !!opts.enabled;
    // Playwright 真实浏览需显式 opt-in：allowRealBrowse=true 且传入 playwright 实例。
    // 否则一律回退 mock（即便注入了 playwright，也不会启用真实浏览）。
    this.allowRealBrowse = !!opts.allowRealBrowse;
    this.provider = (this.allowRealBrowse && opts.provider === 'playwright' && opts.playwright) ? 'playwright' : 'mock';
    this.allow = Array.isArray(opts.allow) ? opts.allow : (Array.isArray(opts.allowDomains) ? opts.allowDomains : []);
    this.timeoutMs = Number(opts.timeoutMs) || 30000;
    this.workDir = opts.workDir || 'workspace';
    this._pw = opts.playwright || null;   // 可选注入的 playwright 实例
    this._pages = new Map();               // mock：url -> {title,text}
    this._localDir = null;
    this._forms = {};
    // DNS 解析注入点（仅真实浏览路径使用；mock 不联网）
    this._dnsLookup = (host, opts2) => new Promise((res, rej) => dns.lookup(host, { all: true }, (e, a) => (e ? rej(e) : res(a))));
  }

  setPlaywright(pw, allowRealBrowse) {
    this._pw = pw;
    if (pw && this.allowRealBrowse) this.provider = 'playwright';
    if (allowRealBrowse === true) this.allowRealBrowse = true;
    if (this.allowRealBrowse && this._pw) this.provider = 'playwright';
    else this.provider = 'mock';
  }
  setLocalDir(d) { this._localDir = d; }

  // 白名单是【必要不充分】条件：额外叠加 SSRF 校验（内网/环回/链路本地/云元数据/凭据 URL 一律拒绝）。
  _check(url) {
    if (!this.enabled) return { ok: false, error: '浏览器自动化未启用（默认关闭）' };
    if (!/^https?:\/\//i.test(url || '')) return { ok: false, error: '仅支持 http(s) 网址' };
    if (!isAllowlistedDomain(url, this.allow)) return { ok: false, error: '域名不在白名单: ' + (() => { try { return new URL(url).hostname; } catch (e) { return url; } })() };
    if (!isSafeUrl(url)) return { ok: false, error: 'SSRF 防护拦截：目标为内网/环回/链路本地/云元数据或带凭据 URL（白名单不等于安全）' };
    return { ok: true };
  }

  /** 注册 mock 页面内容（离线测试用，不联网）。 */
  registerMock(url, content) { this._pages.set(String(url), content); return true; }

  /** 打开页面，返回 {ok,title,text,url}。mock 提供器从注册的页面或本地测试文件读取。 */
  async open(url, opts) {
    const c = this._check(url);
    if (!c.ok) return c;
    opts = opts || {};
    if (this.provider === 'playwright' && this._pw) {
      return this._openPlaywright(url);
    }
    const mock = this._pages.get(String(url)) || this._mockFromLocal(url);
    if (!mock) return { ok: false, error: 'mock 提供器无该 URL 的测试内容（离线测试需先 registerMock）' };
    return { ok: true, title: (mock.title || 'mock'), text: (mock.text || ''), url };
  }

  /**
   * 真实浏览（Playwright）。每个请求（含重定向、子资源）都经 resolveTarget 做
   * 「DNS 解析后 IP 分类」校验，阻断内网/环回/链路本地/云元数据与 DNS 重绑定。
   * 注意：本实现对每个请求重新解析校验，属尽力而为；Playwright 不支持对任意主机做
   * IP 固定，故真实浏览默认关闭，仅当操作者明确接受残留风险时才开启。
   */
  async _openPlaywright(url) {
    let browser;
    try {
      browser = await this._pw.chromium.launch({ args: ['--no-sandbox'] });
      const page = await browser.newPage();
      let blocked = null;
      await page.setRequestInterception(true);
      page.on('request', async (req) => {
        const u = req.url();
        if (blocked) { try { await req.abort(); } catch (_) {} return; }
        if (!/^https?:/i.test(u)) { try { await req.continue(); } catch (_) {} return; }
        try {
          const r = await resolveTarget(u, { lookup: this._dnsLookup });
          if (!r.ok) { blocked = u + ' => ' + r.why; try { await req.abort(); } catch (_) {} return; }
        } catch (e) { /* 解析异常按保守拒绝：阻断该请求 */ blocked = u + ' => 解析异常'; try { await req.abort(); } catch (_) {} return; }
        try { await req.continue(); } catch (_) {}
      });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
      if (blocked) { await browser.close(); return { ok: false, error: '导航被 SSRF 防护拦截: ' + blocked }; }
      const title = await page.title();
      const text = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 20000) : ''));
      await browser.close();
      return { ok: true, title, text, url };
    } catch (e) {
      if (browser) { try { await browser.close(); } catch (_) {} }
      return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
    }
  }

  _mockFromLocal(url) {
    if (!this._localDir) return null;
    let base;
    try { base = path.basename(new URL(url).pathname) || 'index.html'; } catch (e) { return null; }
    const f = path.join(this._localDir, base);
    try {
      const txt = fs.readFileSync(f, 'utf-8');
      return { text: txt, title: 'local:' + base };
    } catch (e) { return null; }
  }

  /** 在限定测试环境填表：拒绝密码/令牌/密钥类字段，默认不提交（仅记录填写动作）。 */
  async fillForm(url, fields, opts) {
    const c = this._check(url);
    if (!c.ok) return c;
    opts = opts || {};
    const safe = {};
    for (const k of Object.keys(fields || {})) {
      const v = String(fields[k]);
      if (/(password|passwd|pwd|token|secret|cookie|api[_-]?key|access[_-]?token)/i.test(k)) {
        return { ok: false, error: '禁止填写密码/令牌/密钥类字段: ' + k };
      }
      safe[k] = v.slice(0, 2000);
    }
    this._forms[String(url)] = safe;
    return { ok: true, url, filled: Object.keys(safe), submitted: false, note: '未提交（安全策略：默认不提交表单）' };
  }

  /** 保存结果到工作区（限工作区内路径，越界由调用方 safeWorkspacePath 保证）。 */
  saveResult(name, content) {
    if (!name || /[\\/]/.test(String(name))) return { ok: false, error: '非法文件名' };
    try {
      const fp = path.join(this.workDir, name);
      fs.mkdirSync(this.workDir, { recursive: true });
      fs.writeFileSync(fp, String(content || ''));
      return { ok: true, path: fp };
    } catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 200) }; }
  }

  /** 停止并清理（不留后台进程）。 */
  async stop() { this._pages.clear(); this._forms = {}; return true; }
}

module.exports = { BrowserAdapter };
