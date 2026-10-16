'use strict';

/**
 * V15.5 离线测试：短视频识别 + 深度思考判定
 *
 * 全部离线：不联网、不抓第三方页面、不连真实 QQ、不调用付费 API。
 * 解析接口只测「拒绝路径」与注入式 mock，不产生任何真实网络请求。
 */

const fs = require('fs');
const path = require('path');

const deepThink = require('../agent/deep_think');
const shortVideo = require('../feiyu/short_video');

let pass = 0, fail = 0;
function ok(c, msg) { if (c) { pass++; } else { fail++; console.log('  ✗ ' + msg); } }
function eq(got, want, msg) { ok(got === want, msg + '（实际=' + JSON.stringify(got) + ' 期望=' + JSON.stringify(want) + '）'); }
function group(n) { console.log('\n[' + n + ']'); }

// ============================================================
group('1. 深度思考：默认开启与各类信号');
deepThink.setConfig(() => ({}));
eq(deepThink.cfg().enabled, true, '默认开启（用户明确要求长思考优先）');

const deepCases = [
  ['为什么这个会报错', true, '推理型（为什么）'],
  ['帮我做个方案', true, '规划型（方案）'],
  ['帮我规划下学习路线', true, '规划型（规划）'],
  ['这段代码的bug在哪', true, '代码/调试型'],
  ['A和B哪个更好', true, '对比权衡型'],
  ['这个概率怎么算', true, '计算型'],
  ['详细总结一下', true, '长文型'],
  ['我要不要换工作', true, '权衡型（要不要）'],
];
for (const [t, want, label] of deepCases) {
  eq(deepThink.judge(t).deep, want, label + ' → 需要深度思考');
}

const shallowCases = [
  ['你好', false, '打招呼'],
  ['嗯', false, '过短'],
  ['今天天气不错呀哈哈', false, '闲聊'],
  ['收到', false, '简单确认'],
];
for (const [t, want, label] of shallowCases) {
  eq(deepThink.judge(t).deep, want, label + ' → 不需要深度思考');
}

// ============================================================
group('2. 深度思考：安全让位与可配置');
deepThink.setConfig(() => ({}));
eq(deepThink.judge('为什么报错', { hasImage: true }).deep, false, '有图时让位给多模态模型（reasoner 不支持图片）');
eq(deepThink.judge('为什么报错', { hasImage: true }).reason, 'has-image', '让位原因码');
eq(deepThink.judge('').reason, 'too-short', '空消息不触发');

// 显式要求不受长度限制
eq(deepThink.judge('深度思考：1+1').deep, true, '显式要求「深度思考」即使句子短也触发');

// 关闭后完全不触发
deepThink.setConfig(() => ({ deepThink: { enabled: false } }));
eq(deepThink.judge('为什么这个会报错').deep, false, '关闭后不触发');
eq(deepThink.judge('为什么这个会报错').reason, 'disabled', '关闭原因码');

// 单独关掉某类信号
deepThink.setConfig(() => ({ deepThink: { enabled: true, code: false } }));
eq(deepThink.judge('这段代码的bug在哪').deep, false, '关掉 code 信号后不再因代码触发');
deepThink.setConfig(() => ({ deepThink: { enabled: true, code: false } }));
eq(deepThink.judge('为什么这个会报错').deep, true, '关掉 code 不影响其它信号');

// 确定性
deepThink.setConfig(() => ({}));
eq(deepThink.judge('为什么这个会报错').reason, deepThink.judge('为什么这个会报错').reason, '确定性：同输入同结果');

// ============================================================
group('3. 短视频识别：平台识别');
shortVideo.setConfig(() => ({}));
const svCases = [
  ['https://v.douyin.com/abc/ 看看这个', '抖音'],
  ['https://www.iesdouyin.com/share/video/123', '抖音'],
  ['https://www.kuaishou.com/s/xxx', '快手'],
  ['https://b23.tv/BV1xx411c7mD', 'B站'],
  ['https://www.bilibili.com/video/BV1xx411c7mD', 'B站'],
  ['https://xiaohongshu.com/explore/xxx', '小红书'],
  ['https://www.ixigua.com/123', '西瓜视频'],
];
for (const [t, want] of svCases) {
  const d = shortVideo.detect(t);
  ok(d && d.platform === want, '识别 ' + want + '（实际=' + (d ? d.platform : '未识别') + '）');
}
eq(shortVideo.detect('https://www.baidu.com 百度一下'), null, '普通网页不算短视频');
eq(shortVideo.detect('今天天气不错'), null, '无链接不识别');
eq(shortVideo.detect(''), null, '空文本不识别');

// 关闭后不识别
shortVideo.setConfig(() => ({ shortVideo: { enabled: false } }));
eq(shortVideo.detect('https://v.douyin.com/abc/'), null, '关闭后不识别');
shortVideo.setConfig(() => ({}));

// ============================================================
group('4. 短视频：如实说明，不编造内容');
const d = shortVideo.detect('https://v.douyin.com/abc/');
const hint = shortVideo.hint(d);
ok(hint.indexOf('抖音') >= 0, '说明里点明平台');
ok(hint.indexOf('看不到视频画面内容') >= 0, '如实说明看不到内容');
ok(hint.indexOf('不要编造') >= 0, '明确要求模型不要编造');
ok(hint.indexOf('发到群里') >= 0 || hint.indexOf('截图') >= 0, '给出可行的替代办法');
eq(shortVideo.hint(null), '', '未识别时不注入提示');

// ============================================================
(async () => {
  group('5. 短视频解析：默认关闭与安全边界');
  shortVideo.setConfig(() => ({}));
  let r = await shortVideo.tryParse({ platform: '抖音', url: 'https://v.douyin.com/a/' });
  eq(r.ok, false, '默认不解析（不抓第三方页面）');
  eq(r.reason, 'no-endpoint', '未配置端点');

  shortVideo.setConfig(() => ({ shortVideo: { parser: { enabled: true, endpoint: 'https://api.example.com/p?u={url}', allowHosts: ['evil.com'] } } }));
  r = await shortVideo.tryParse({ platform: '抖音', url: 'https://v.douyin.com/a/' });
  eq(r.reason, 'host-not-allowed', '端点不在域名白名单 → 拒绝');

  shortVideo.setConfig(() => ({ shortVideo: { parser: { enabled: true, endpoint: 'http://169.254.169.254/p', allowHosts: ['169.254.169.254'] } } }));
  r = await shortVideo.tryParse({ platform: '抖音', url: 'https://v.douyin.com/a/' });
  eq(r.reason, 'unsafe-url', '云元数据地址即使写进白名单也被 SSRF 校验拦下');

  shortVideo.setConfig(() => ({ shortVideo: { parser: { enabled: true, endpoint: 'http://127.0.0.1:8080/p', allowHosts: ['127.0.0.1'] } } }));
  r = await shortVideo.tryParse({ platform: '抖音', url: 'https://v.douyin.com/a/' });
  eq(r.reason, 'unsafe-url', '回环地址被拦下');

  // 注入 mock 验证"配好了能用"（不产生真实请求）
  shortVideo.setConfig(() => ({ shortVideo: { parser: { enabled: true, endpoint: 'https://api.example.com/p?u={url}', allowHosts: ['api.example.com'] } } }));
  r = await shortVideo.tryParse({ platform: '抖音', url: 'https://v.douyin.com/a/' }, { fetch: async () => ({ text: '标题：测试' }) });
  eq(r.ok, true, '白名单内 + 注入 mock → 可解析');
  ok(String(r.text).indexOf('标题') >= 0, '返回解析文本');
  shortVideo.setConfig(() => ({}));

  // ============================================================
  group('6. 配置示例与零依赖');
  const cfgPath = path.join(__dirname, '..', 'ai_config.example.json');
  let cfgObj = null;
  try { cfgObj = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) {}
  ok(cfgObj != null, 'ai_config.example.json 是合法 JSON');
  if (cfgObj) {
    ok(Object.prototype.hasOwnProperty.call(cfgObj, 'deepThink'), '含顶层键 deepThink');
    ok(Object.prototype.hasOwnProperty.call(cfgObj, 'shortVideo'), '含顶层键 shortVideo');
    ok(cfgObj.deepThink && cfgObj.deepThink.enabled === true, 'deepThink 默认开');
    ok(cfgObj.shortVideo && cfgObj.shortVideo.enabled === true, 'shortVideo 识别默认开');
    ok(cfgObj.shortVideo && cfgObj.shortVideo.parser && cfgObj.shortVideo.parser.enabled === false, '解析器默认关');
    for (const k of ['voice', 'style', 'meme', 'imageConfirm', 'groupProfile', 'pokeOthers']) {
      ok(Object.prototype.hasOwnProperty.call(cfgObj, k), '既有键保留：' + k);
    }
  }

  const builtins = new Set(['fs', 'path', 'crypto', 'os', 'url', 'child_process', 'http', 'https', 'net', 'dns', 'util', 'events', 'stream', 'zlib']);
  for (const f of ['../agent/deep_think.js', '../feiyu/short_video.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const re = /require\(['"]([^'"]+)['"]\)/g;
    const ext = [];
    let m;
    while ((m = re.exec(src)) !== null) {
      if (!m[1].startsWith('.') && !m[1].startsWith('/') && !builtins.has(m[1])) ext.push(m[1]);
    }
    eq(ext.length, 0, path.basename(f) + ' 无外部依赖');
    eq(/\bconsole\.(log|info|warn|error)\b/.test(src), false, path.basename(f) + ' 无 console 输出');
  }

  console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
  process.exit(fail ? 1 : 0);
})();
