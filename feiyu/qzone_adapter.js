'use strict';
// ================= QQ空间发布适配器（阶段 E） =================
// 调查结论（无合规开放接口，故不实现真实发布）：
//   目前没有任何面向第三方的官方开放 API 可用于 QQ空间（说说/动态）发布。历史上可行的 web 端
//   shuo.shuo.qq.com / QZone 内部接口均依赖已登录的 Cookie/会话与反爬校验，按需求严禁通过破解、
//   窃取 Cookie 或未经授权的内部接口实现，也禁止修改 QQ 登录态。因此本适配器只提供：
//   内容生成/预览/去重/频率限制/发布模拟 与 真实发布开关；真实发布默认关闭，且未经明确授权绝不执行。

const crypto = require('crypto');

class QZoneAdapter {
  constructor(opts) {
    opts = opts || {};
    this.enabled = !!opts.enabled;          // 模拟发布总开关
    this.realEnabled = false;               // 真实发布：默认关闭，需单独授权开启
    this.maxPerDay = Number(opts.maxPerDay) || 3;
    this.minIntervalMs = Number(opts.minIntervalMs) || 6 * 3600 * 1000;
    this._last = [];                        // 发布时间戳（24h 窗口）
    this._store = [];                       // 内容哈希去重窗口（7 天）
  }

  setRealEnabled(on) { this.realEnabled = !!on; return { ok: true, realEnabled: this.realEnabled }; }

  _normalize(c) { return String(c || '').trim().slice(0, 2000); }
  _hash(c) { return crypto.createHash('sha1').update(c).digest('hex').slice(0, 16); }

  /** 预览（不直接发布），返回截断预览与内容哈希。 */
  preview(content) {
    const c = this._normalize(content);
    if (!c) return { ok: false, error: '内容为空' };
    return { ok: true, preview: c.slice(0, 200), length: c.length, hash: this._hash(c) };
  }

  _dedup(c) {
    const h = this._hash(c);
    const now = Date.now();
    this._store = this._store.filter((x) => now - x.at < 7 * 24 * 3600 * 1000);
    return this._store.some((x) => x.hash === h);
  }
  _rateOk() {
    const now = Date.now();
    this._last = this._last.filter((t) => now - t < 24 * 3600 * 1000);
    return this._last.length < this.maxPerDay;
  }

  /**
   * 发布。
   * @param {string} content
   * @param {{authorized?:boolean}} [o] 真实发布需显式授权
   */
  async publish(content, o) {
    o = o || {};
    const c = this._normalize(content);
    if (!this.enabled) return { ok: false, reason: 'disabled' };
    if (!c) return { ok: false, error: '内容为空' };
    if (!this._rateOk()) return { ok: false, error: '今日发布次数已达上限' };
    if (this._dedup(c)) return { ok: false, error: '内容重复（7 天内已发布）' };

    const pv = this.preview(c);
    if (!this.realEnabled || !o.authorized) {
      // 模拟发布（默认）：记录但不真正发送
      this._store.push({ hash: pv.hash, at: Date.now() });
      this._last.push(Date.now());
      return { ok: true, simulated: true, preview: pv.preview, hash: pv.hash, note: '未执行真实发布（真实开关关闭或未经授权）' };
    }
    // 真实发布：本适配器不实现（缺合规授权渠道），拒绝以防误操作
    return { ok: false, error: '真实 QQ空间发布未实现：缺少合规授权渠道，按需求禁止未授权发布' };
  }
}

module.exports = { QZoneAdapter };
