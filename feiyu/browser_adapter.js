'use strict';
// ================= 安全浏览器操作适配器（阶段 C） =================
// 受限操作接口：打开允许网站、获取标题/正文、提取信息、在限定测试环境填表、保存结果。
// 默认 provider='mock'（不依赖 Playwright，零第三方依赖）。
// 安全规则：仅允许白名单域名；不提交密码/Cookie/Key/私人资料；不允许执行任意脚本；
//          超时+停止机制；不绕过验证码/登录/反自动化；测试结束不留后台进程。

const fs = require('fs');
const path = require('path');
const { isAllowlistedDomain } = require('./permissions');

class BrowserAdapter {
  /**
   * @param {object} opts { enabled, provider, allow:[], timeoutMs, workDir, playwright? }
   */
  constructor(opts) {
    opts = opts || {};
    this.enabled = !!opts.enabled;
    this.provider = (opts.provider === 'playwright' && opts.playwright) ? 'playwright' : 'mock';
    this.allow = Array.isArray(opts.allow) ? opts.allow : [];
    this.timeoutMs = Number(opts.timeoutMs) || 30000;
    this.workDir = opts.workDir || 'workspace';
    this._pw = opts.playwright || null;   // 可选注入的 playwright 实例
    this._pages = new Map();               // mock：url -> {title,text}
    this._localDir = null;
    this._forms = {};
  }

  setPlaywright(pw) { this._pw = pw; if (pw && this.provider === 'mock') this.provider = 'playwright'; }
  setLocalDir(d) { this._localDir = d; }

  _check(url) {
    if (!this.enabled) return { ok: false, error: '浏览器自动化未启用（默认关闭）' };
    if (!/^https?:\/\//i.test(url || '')) return { ok: false, error: '仅支持 http(s) 网址' };
    if (!isAllowlistedDomain(url, this.allow)) return { ok: false, error: '域名不在白名单: ' + (() => { try { return new URL(url).hostname; } catch (e) { return url; } })() };
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
      try {
        const browser = await this._pw.chromium.launch({ args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
        const title = await page.title();
        const text = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 20000) : ''));
        await browser.close();
        return { ok: true, title, text, url };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
      }
    }
    const mock = this._pages.get(String(url)) || this._mockFromLocal(url);
    if (!mock) return { ok: false, error: 'mock 提供器无该 URL 的测试内容（离线测试需先 registerMock）' };
    return { ok: true, title: (mock.title || 'mock'), text: (mock.text || ''), url };
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
