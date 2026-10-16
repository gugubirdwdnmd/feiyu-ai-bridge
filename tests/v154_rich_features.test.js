'use strict';

/**
 * V15.4 离线测试：语音识别 / 发言风格优化 / 表情包联网检索 / 生图确认
 *
 * 全部离线：不联网、不连真实 QQ、不调用付费 API、不执行真实浏览器操作。
 * 联网检索用的是注入式 mock fetch，不产生任何真实网络请求。
 */

const fs = require('fs');
const path = require('path');

const voiceAsr = require('../feiyu/voice_asr');
const styleOpt = require('../feiyu/style_optimizer');
const memeSearch = require('../feiyu/meme_search');
const imageConfirm = require('../feiyu/image_confirm');

let pass = 0, fail = 0;
function ok(c, msg) { if (c) { pass++; } else { fail++; console.log('  ✗ ' + msg); } }
function eq(got, want, msg) { ok(got === want, msg + '（实际=' + JSON.stringify(got) + ' 期望=' + JSON.stringify(want) + '）'); }
function group(name, fn) { console.log('\n[' + name + ']'); fn(); }

const withCfg = (c, fn) => {
  voiceAsr.setConfig(() => c); styleOpt.setConfig(() => c);
  memeSearch.setConfig(() => c); imageConfirm.setConfig(() => c);
  try { return fn(); } finally {
    voiceAsr.setConfig(() => ({})); styleOpt.setConfig(() => ({}));
    memeSearch.setConfig(() => ({})); imageConfirm.setConfig(() => ({}));
  }
};

// ============================================================
group('1. 语音识别：默认关闭与安全边界', () => {
  const seg = { type: 'record', data: { file: 'a.amr' } };

  withCfg({}, async () => {});
  // 关闭：不改任何东西
  voiceAsr.setConfig(() => ({}));
  ok(voiceAsr.transcribe(seg) instanceof Promise, 'transcribe 返回 Promise');

  withCfg({ voice: { enabled: false } }, () => {
    eq(voiceAsr.cfg().enabled, false, '未配置时关闭');
  });

  voiceAsr.setConfig(() => ({ voice: { enabled: true, provider: 'local' } }));
  ok(true, 'local provider 已设置');
});

(async () => {
  // —— 异步用例 ——
  console.log('\n[2. 语音识别：行为与失败降级]');
  const seg = { type: 'record', data: { file: 'a.amr' } };

  voiceAsr.setConfig(() => ({}));
  let r = await voiceAsr.transcribe(seg);
  eq(r.ok, false, '关闭时不识别');
  eq(r.reason, 'disabled', '关闭原因码');

  voiceAsr.setConfig(() => ({ voice: { enabled: true } }));   // provider 默认 mock
  r = await voiceAsr.transcribe(seg);
  eq(r.ok, true, 'mock 模式可识别（占位）');
  eq(r.text, '[语音]', 'mock 返回占位文本');
  eq(r.provider, 'mock', 'provider=mock');

  r = await voiceAsr.transcribe({ type: 'record', data: { file: 'a.amr', duration: 9999 } });
  eq(r.reason, 'too-long', '超长语音拒绝（避免成本失控）');

  voiceAsr.setConfig(() => ({ voice: { enabled: true, provider: 'local' } }));
  r = await voiceAsr.transcribe(seg);
  eq(r.reason, 'local-not-configured', 'local 未配置命令 → 拒绝（不猜、不执行未知程序）');

  voiceAsr.setConfig(() => ({ voice: { enabled: true, provider: 'local', cmd: ['node', '-e', 'console.log("你好")'] } }));
  r = await voiceAsr.transcribe(seg);
  eq(r.ok, true, 'local 命令可用时返回转写');
  eq(r.text, '你好', 'local 转写内容正确');

  voiceAsr.setConfig(() => ({ voice: { enabled: true, provider: 'cloud', endpoint: 'https://asr.example.com/x', allowHosts: ['evil.com'] } }));
  r = await voiceAsr.transcribe(seg);
  eq(r.reason, 'cloud-host-not-allowed', 'cloud 端点不在白名单 → 拒绝');

  voiceAsr.setConfig(() => ({ voice: { enabled: true, provider: 'cloud', endpoint: 'http://169.254.169.254/x', allowHosts: ['169.254.169.254'] } }));
  r = await voiceAsr.transcribe(seg);
  eq(r.reason, 'cloud-unsafe-url', '云元数据地址即使放进白名单也被 SSRF 校验拦下');

  // 段识别与合并
  voiceAsr.setConfig(() => ({ voice: { enabled: true } }));
  ok(!voiceAsr.hasVoice([{ type: 'text', data: { text: 'hi' } }]), '纯文本无语音');
  ok(voiceAsr.hasVoice([{ type: 'text', data: { text: 'hi' } }, { type: 'record', data: {} }]), 'record 段被识别为语音');
  let m = voiceAsr.mergeIntoText('看看这个', { ok: true, text: '[语音]' });
  eq(m.text, '看看这个 [语音]', '转写并入原文');
  m = voiceAsr.mergeIntoText('看看这个', { ok: false, reason: 'disabled' });
  eq(m.changed, false, '识别失败 → 原文不变（不破坏聊天）');
  eq(m.text, '看看这个', '识别失败原文保持');

  // ============================================================
  console.log('\n[3. 发言风格：默认关闭与去人机感]');
  styleOpt.setConfig(() => ({}));
  const src = '好的，作为一个AI助手，我可以帮你解答。总之，首先打开设置，其次找到选项。希望对你有帮助！';
  let p = styleOpt.polish(src);
  eq(p.changed, false, '关闭时一字不改');
  eq(p.text, src, '关闭时原样返回');

  styleOpt.setConfig(() => ({ style: { enabled: true, emoji: { enabled: false } } }));
  p = styleOpt.polish(src);
  ok(p.text.indexOf('作为一个AI助手') < 0, '去掉「作为一个AI助手」自我介绍');
  ok(p.text.indexOf('总之') < 0, '去掉「总之」');
  ok(p.text.indexOf('希望对你有帮助') < 0, '去掉结尾客套');
  ok(p.text.indexOf('首先') < 0, '去掉「首先」');
  ok(p.text.indexOf('其次') < 0, '去掉「其次」');
  ok(p.text.indexOf('。，') < 0, '不留断头标点「。，」');

  p = styleOpt.polish('当然，没问题！如果你还有任何问题，请随时问我。');
  ok(p.text.indexOf('请随时问我') < 0, '去掉「请随时问我」');
  ok(p.text.indexOf('当然') < 0, '去掉开头「当然，」');

  // 「最后」不能被误删（有意义）
  p = styleOpt.polish('最后一步是点保存，别忘。');
  ok(p.text.indexOf('最后') >= 0, '有意义的「最后一步」不被删');

  // ============================================================
  console.log('\n[4. 发言风格：简化与上限]');
  styleOpt.setConfig(() => ({ style: { enabled: true, maxSentences: 2, maxChars: 0, emoji: { enabled: false } } }));
  p = styleOpt.polish('一。二。三。四。五。');
  eq(p.text, '一。二。', '超过 maxSentences 截断');

  styleOpt.setConfig(() => ({ style: { enabled: true, maxSentences: 0, maxChars: 20, emoji: { enabled: false } } }));
  p = styleOpt.polish('这是一段明显超过二十个字的很长的回答内容，需要被截断处理掉。');
  ok(p.text.length <= 20, '超过 maxChars 被截断（实际 ' + p.text.length + ' 字）');

  // 受保护内容不做简化
  styleOpt.setConfig(() => ({ style: { enabled: true, maxSentences: 1, maxChars: 10, emoji: { enabled: true } } }));
  const code = '```js\nconst a = 1;\nconst b = 2;\n```';
  p = styleOpt.polish(code);
  eq(p.text, code, '代码块不被简化/不被加 emoji');
  const link = '见 https://example.com/a/b/c 这里';
  p = styleOpt.polish(link);
  ok(p.text.indexOf('https://example.com/a/b/c') >= 0, '链接内容不受简化破坏');

  // 空兜底：只为客套话时不能发空白
  styleOpt.setConfig(() => ({ style: { enabled: true, emoji: { enabled: false } } }));
  p = styleOpt.polish('好的');
  eq(p.text, '好的', '整段被删空时回退原文（不发空白消息）');

  // ============================================================
  console.log('\n[5. 发言风格：emoji 与表情包建议]');
  styleOpt.setConfig(() => ({ style: { enabled: true, emoji: { enabled: false } } }));
  p = styleOpt.polish('哈哈哈太好笑了');
  eq(p.emoji.length, 0, 'emoji 关闭时不加 emoji');
  ok(p.text.indexOf('😄') < 0, '文本里没有 emoji');

  styleOpt.setConfig(() => ({
    style: { enabled: true, emoji: { enabled: true, max: 2, density: 1, pool: ['😄', '🙂'] } },
  }));
  p = styleOpt.polish('哈哈哈太好笑了');
  ok(p.emoji.length >= 1, '开启后命中情绪会带 emoji');
  ok(styleOpt.countEmoji(p.text) <= 2, 'emoji 数量不超过 max=2');
  eq(styleOpt.polish('哈哈哈太好笑了').text, styleOpt.polish('哈哈哈太好笑了').text, '确定性：同输入同输出');
  eq(styleOpt.polish('无语').text, styleOpt.polish('无语').text, '确定性（不同输入也稳定）');

  styleOpt.setConfig(() => ({
    style: { enabled: true, emoji: { enabled: true, max: 3, density: 1, pool: ['😄', '😅', '🙂'] }, sticker: { enabled: true, maxKeywords: 1 } },
  }));
  p = styleOpt.polish('哈哈哈这也太好笑了吧');
  ok(p.stickers.indexOf('开心') >= 0, '好笑 → 建议「开心」表情包');
  p = styleOpt.polish('无语，服了');
  ok(p.stickers.indexOf('无语') >= 0, '无语 → 建议「无语」表情包');

  styleOpt.setConfig(() => ({ style: { enabled: true, emoji: { enabled: true, density: 0 } } }));
  p = styleOpt.polish('哈哈哈太好笑了');
  eq(p.emoji.length, 0, 'density=0 时完全不带 emoji');

  // ============================================================
  console.log('\n[6. 表情包联网检索：默认关闭与安全]');
  memeSearch._reset();
  memeSearch.setConfig(() => ({}));
  r = await memeSearch.search('开心');
  eq(r.reason, 'disabled', '默认关闭');

  memeSearch.setConfig(() => ({ meme: { enabled: true } }));
  r = await memeSearch.search('开心');
  eq(r.reason, 'provider-none', '未配置 provider 时拒绝（不内置第三方站点）');

  memeSearch.setConfig(() => ({ meme: { enabled: true, provider: 'custom', endpoint: 'https://api.example.com/s?q={q}', allowHosts: ['other.com'] } }));
  r = await memeSearch.search('开心');
  eq(r.reason, 'host-not-allowed', '端点不在域名白名单 → 拒绝');

  memeSearch.setConfig(() => ({ meme: { enabled: true, provider: 'custom', endpoint: 'http://169.254.169.254/s', allowHosts: ['169.254.169.254'] } }));
  r = await memeSearch.search('开心');
  eq(r.reason, 'unsafe-url', '云元数据地址被 SSRF 校验拦下');

  // 注入 mock：成功，且过滤掉不安全的图片 URL
  memeSearch._reset();
  memeSearch.setConfig(() => ({ meme: { enabled: true, provider: 'custom', endpoint: 'https://api.example.com/s?q={q}', allowHosts: ['api.example.com'] } }));
  r = await memeSearch.search('开心', {
    now: 1000000,
    fetch: async () => ({
      text: JSON.stringify({
        data: [
          { url: 'https://cdn.example.com/a.gif', title: '好' },
          { url: 'http://169.254.169.254/latest', title: '元数据' },
          { url: 'https://127.0.0.1/local', title: '本地' },
          { url: 'https://192.168.1.5/x.png', title: '私网' },
        ],
      }),
    }),
  });
  eq(r.ok, true, '合法检索返回结果');
  eq(r.items.length, 1, '只保留安全 URL（私网/回环/云元数据被剔除）');
  eq(r.items[0].url, 'https://cdn.example.com/a.gif', '保留公网 https 图片');

  // 缓存
  memeSearch._reset();
  memeSearch.setConfig(() => ({ meme: { enabled: true, provider: 'custom', endpoint: 'https://api.example.com/s?q={q}', allowHosts: ['api.example.com'] } }));
  let fetchCount = 0;
  const mk = () => ({
    now: 1000000,
    fetch: async () => { fetchCount++; return { text: JSON.stringify({ data: [{ url: 'https://cdn.example.com/a.gif' }] }) }; },
  });
  await memeSearch.search('猫', mk());
  await memeSearch.search('猫', mk());
  eq(fetchCount, 1, '相同关键词命中缓存，不重复请求');

  // 限频
  memeSearch._reset();
  memeSearch.setConfig(() => ({ meme: { enabled: true, provider: 'custom', endpoint: 'https://api.example.com/s?q={q}', allowHosts: ['api.example.com'], maxPerHour: 2 } }));
  const f2 = async () => ({ text: JSON.stringify({ data: [{ url: 'https://cdn.example.com/a.gif' }] }) });
  eq((await memeSearch.search('a', { now: 1000000, fetch: f2 })).ok, true, '限频内第1次通过');
  eq((await memeSearch.search('b', { now: 1000000, fetch: f2 })).ok, true, '限频内第2次通过');
  eq((await memeSearch.search('c', { now: 1000000, fetch: f2 })).reason, 'rate-limited', '超过每小时上限被拒');

  // ============================================================
  console.log('\n[7. 生图确认：默认关闭与完整流程]');
  imageConfirm._reset();
  imageConfirm.setConfig(() => ({}));
  const key = imageConfirm.chatKeyOf({ isGroup: true, groupId: 'g1', userId: 'u1' });
  let rr = imageConfirm.request(key, { prompt: '一只猫', now: 1000000 });
  eq(rr.ok, false, '默认关闭时不登记确认');
  eq(rr.reason, 'disabled', '关闭原因码');

  imageConfirm.setConfig(() => ({ imageConfirm: { enabled: true } }));
  rr = imageConfirm.request(key, { prompt: '一只猫', now: 1000000 });
  eq(rr.ok, true, '开启后登记待确认');
  ok(rr.askText.indexOf('一只猫') >= 0, '确认语里复述了要画的内容');

  eq(imageConfirm.match(key, '画', 1000000), 'confirm', '「画」= 确认');
  eq(imageConfirm.match(key, '算了', 1000000), 'cancel', '「算了」= 取消');
  eq(imageConfirm.match(key, '今天天气不错啊', 1000000), null, '无关消息不误判');
  eq(imageConfirm.match(key, '算了不画了', 1000000), null, '整句不匹配时不猜（避免「不画了」里的「画」被误判）');

  const took = imageConfirm.take(key, 1000000);
  ok(took && took.prompt === '一只猫', '确认后取回原始 prompt');
  eq(imageConfirm.take(key, 1000000), null, '取走后清空（不会重复画两次）');
  eq(imageConfirm.match(key, '画', 1000000), null, '无待确认时不响应');

  // 取消
  imageConfirm.request(key, { prompt: '狗', now: 1000000 });
  eq(imageConfirm.cancel(key), true, '取消成功');
  eq(imageConfirm.peek(key, 1000000), null, '取消后无待确认');

  // ============================================================
  console.log('\n[8. 生图确认：隔离与过期]');
  imageConfirm._reset();
  imageConfirm.setConfig(() => ({ imageConfirm: { enabled: true, ttlMs: 60000 } }));
  const k1 = imageConfirm.chatKeyOf({ isGroup: true, groupId: 'g1', userId: 'u1' });
  const k1u2 = imageConfirm.chatKeyOf({ isGroup: true, groupId: 'g1', userId: 'u2' });
  const k2 = imageConfirm.chatKeyOf({ isGroup: true, groupId: 'g2', userId: 'u1' });
  const kp = imageConfirm.chatKeyOf({ isGroup: false, userId: 'u1' });
  ok(k1 !== k1u2, '同一群不同成员键不同');
  ok(k1 !== k2, '同一个人不同群键不同');
  ok(k1 !== kp, '群聊与私聊键不同');

  imageConfirm.request(k1, { prompt: '猫', now: 1000000 });
  eq(imageConfirm.peek(k1u2, 1000000), null, '别人的确认不会串到自己头上');
  eq(imageConfirm.peek(k2, 1000000), null, '别的群不会串');
  eq(imageConfirm.match(k1u2, '画', 1000000), null, '别人回「画」不会触发自己的生图');

  // 过期
  eq(imageConfirm.peek(k1, 1000000 + 60001), null, '超过 TTL 自动作废');
  eq(imageConfirm.size(), 0, '过期后被清理，内存不膨胀');

  // 只确认一种场景
  imageConfirm._reset();
  imageConfirm.setConfig(() => ({ imageConfirm: { enabled: true, requireForText2Img: false } }));
  eq(imageConfirm.request(k1, { prompt: '猫', kind: 'text2img', now: 1000000 }).reason, 'not-required', '关掉文生图确认时不拦');
  imageConfirm.setConfig(() => ({ imageConfirm: { enabled: true, requireForImg2Img: false } }));
  eq(imageConfirm.request(k1, { prompt: '猫', kind: 'img2img', now: 1000000 }).reason, 'not-required', '关掉图生图确认时不拦');
  imageConfirm._reset();

  // ============================================================
  console.log('\n[9. 配置示例与零依赖]');
  const cfgPath = path.join(__dirname, '..', 'ai_config.example.json');
  const cfgTxt = fs.readFileSync(cfgPath, 'utf8');
  let cfgObj = null;
  try { cfgObj = JSON.parse(cfgTxt); } catch (e) {}
  ok(cfgObj != null, 'ai_config.example.json 是合法 JSON');
  if (cfgObj) {
    for (const k of ['voice', 'style', 'meme', 'imageConfirm']) {
      ok(Object.prototype.hasOwnProperty.call(cfgObj, k), '含顶层键 ' + k);
      ok(cfgObj[k] && cfgObj[k].enabled === false, k + ' 默认关闭');
    }
    ok(Object.prototype.hasOwnProperty.call(cfgObj, 'sticker'), '既有 sticker 键保留');
    ok(Object.prototype.hasOwnProperty.call(cfgObj, 'poke'), '既有 poke 键保留');
    ok(Object.prototype.hasOwnProperty.call(cfgObj, 'pokeOthers'), '既有 pokeOthers 键保留');
    ok(Object.prototype.hasOwnProperty.call(cfgObj, 'groupProfile'), '既有 groupProfile 键保留');
  }

  const builtins = new Set(['fs', 'path', 'crypto', 'os', 'url', 'child_process', 'http', 'https', 'net', 'dns', 'util', 'events', 'stream', 'zlib']);
  for (const f of ['voice_asr.js', 'style_optimizer.js', 'meme_search.js', 'image_confirm.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'feiyu', f), 'utf8');
    const re = /require\(['"]([^'"]+)['"]\)/g;
    const ext = [];
    let m;
    while ((m = re.exec(src)) !== null) {
      if (!m[1].startsWith('.') && !m[1].startsWith('/') && !builtins.has(m[1])) ext.push(m[1]);
    }
    eq(ext.length, 0, f + ' 无外部依赖（实际=' + JSON.stringify(ext) + '）');
  }

  // 不打印敏感信息：模块内不应有 console 输出
  for (const f of ['voice_asr.js', 'style_optimizer.js', 'meme_search.js', 'image_confirm.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'feiyu', f), 'utf8');
    eq(/\bconsole\.(log|info|warn|error)\b/.test(src), false, f + ' 内无 console 输出');
  }

  console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
  process.exit(fail ? 1 : 0);
})();
