'use strict';
// ================= TTS 语音生成适配器（阶段 D·语音） =================
// 与 OneBot 发送解耦：本模块只负责「生成音频」，发送由调用方（notify/bot）用 napcatCall 完成。
// provider: mock（默认，零依赖、不调任何付费 API，仅产出占位音频用于格式/体积校验与离线测试）
//           local（注入本地引擎，如系统 SAPI / edge-tts，需另行安装，默认不启用）
//           cloud（注入云端生成函数，密钥由外部配置注入，绝不硬编码）
// 限制：格式、时长、体积上限。无法确定真实客户端兼容性时标记待实测，不伪称成功。

const fs = require('fs');
const crypto = require('crypto');

class TTS {
  constructor(opts) {
    opts = opts || {};
    this.enabled = !!opts.enabled;
    this.provider = opts.provider || 'mock';
    this.maxBytes = Number(opts.maxBytes) || 2 * 1024 * 1024;
    this.maxDurationMs = Number(opts.maxDurationMs) || 30000;
    this.format = String(opts.format || 'mp3').toLowerCase();
    this.outDir = opts.outDir || 'workspace/tts';
    this.cloud = typeof opts.cloud === 'function' ? opts.cloud : null;
    this.localFn = typeof opts.localGenerate === 'function' ? opts.localGenerate : null;
  }

  /** 估算中文朗读时长（≈4.5 字/秒），用于预算与上限判定。 */
  _estimateDurationMs(text) {
    return Math.round((String(text || '').length / 4.5) * 1000);
  }

  /** 构造 OneBot 语音消息段（record）。发送与生成解耦，调用方决定是否发送。 */
  buildAudioMessage(audio) {
    if (!audio || !audio.filePath) return { type: 'text', data: { text: '[语音生成失败]' } };
    return { type: 'record', data: { file: audio.filePath } };
  }

  /**
   * 生成语音。
   * @returns {Promise<{ok:boolean, format?, bytes?, durationMs?, filePath?:string, error?:string, note?:string}>}
   */
  async generate(text, opts) {
    opts = opts || {};
    if (!this.enabled) return { ok: false, error: 'TTS 未启用（默认关闭，需手动启用）' };
    const t = String(text || '').trim();
    if (!t) return { ok: false, error: '文本为空' };
    const dur = this._estimateDurationMs(t);
    if (dur > this.maxDurationMs) return { ok: false, error: '超出最大时长(' + this.maxDurationMs + 'ms)', durationMs: dur };

    let audio;
    try {
      if (this.provider === 'mock') audio = this._mockGen(t, dur);
      else if (this.provider === 'local' && this.localFn) audio = await this.localFn(t);
      else if (this.provider === 'cloud' && this.cloud) audio = await this.cloud(t);
      else return { ok: false, error: 'TTS provider 不可用或未配置: ' + this.provider + '（待配置）' };
    } catch (e) {
      return { ok: false, error: '生成异常: ' + String((e && e.message) || e).slice(0, 200) };
    }
    if (!audio || !audio.buffer) return { ok: false, error: '生成失败：无音频数据' };
    if (audio.buffer.length > this.maxBytes) return { ok: false, error: '音频超过最大体积(' + this.maxBytes + 'B)' };
    if (audio.buffer.length === 0) return { ok: false, error: '音频为空' };

    let filePath = null;
    if (opts.save && this.outDir) {
      try {
        fs.mkdirSync(this.outDir, { recursive: true });
        filePath = this.outDir + '/tts_' + crypto.randomBytes(6).toString('hex') + '.' + this.format;
        fs.writeFileSync(filePath, audio.buffer);
      } catch (e) { filePath = null; }
    }
    return { ok: true, format: this.format, bytes: audio.buffer.length, durationMs: dur, filePath };
  }

  /** 占位音频（MP3 帧头 + 静音体），不调任何付费 API，仅供格式/体积校验与离线测试。 */
  _mockGen(text, dur) {
    const header = Buffer.from([0xFF, 0xFB, 0x90, 0x00]);
    const size = Math.min(2048, Math.max(32, Math.floor(dur / 30)));
    return { buffer: Buffer.concat([header, Buffer.alloc(size)]) };
  }
}

module.exports = { TTS };
