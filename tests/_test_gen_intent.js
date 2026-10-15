// 验证 V14-D 生图意图：是否给出 generate_image 建议、是否图生图、不该画的别画
const intent = require('../agent/intent');

const CASES = [
  // [文本, signals, 期望 suggest?, 期望 source?]
  ['生成被摸头疾旋鼬的图片', {}, true, ''],
  ['画只猫', {}, true, ''],
  ['帮我画一张头像', {}, true, ''],
  ['来张赛博朋克壁纸', {}, true, ''],
  ['整一个油画', {}, true, ''],
  ['给我画个赛博朋克城市的插画', {}, true, ''],
  ['生成图片', {}, true, ''],
  // 图生图：有图 + 改造词
  ['把这张图改成油画风格', { hasImage: true }, true, '1'],
  ['这张图重绘一下', { hasImage: true }, true, '1'],
  ['按这个风格再来一张', { hasImage: true }, true, '1'],
  ['换成水墨风', { hasImage: true }, true, '1'],
  ['拿这张图变成赛博朋克', { hasImage: true }, true, '1'],
  // 有图但只是要画别的 → 文生图，不该带 source
  ['画只猫', { hasImage: true }, true, ''],
  ['来张壁纸', { hasImage: true }, true, ''],
  // 不该画
  ['你会画画吗', {}, false, ''],
  ['你给我跌画成啥了', {}, false, ''],
  ['这画的是啥', { hasImage: true }, false, ''],
  ['今天天气真好啊', {}, false, ''],
  ['这张图里是什么东西', { hasImage: true }, false, ''],
  ['图片呢', {}, false, ''],
  ['帮我看看这个文件', {}, false, ''],
  // 关掉开关
  ['画只猫', { imageGeneration: false }, false, ''],
];

let pass = 0, fail = 0;
for (const [text, signals, want, wantSrc] of CASES) {
  const r = intent.detectIntent(text, Object.assign({ hasImage: false }, signals));
  const g = (r.suggestedTools || []).find((x) => x.tool === 'generate_image');
  const got = !!g;
  const gotSrc = g ? String((g.args && g.args.source) || '') : '';
  const okSrc = !want || gotSrc === wantSrc;
  if (got === want && okSrc) {
    pass++;
    console.log('  OK   [' + text + ']' + (got ? ' → ' + (gotSrc ? 'img2img' : 'txt2img') + ' prompt="' + g.args.prompt + '"' : ' → 不画'));
  } else {
    fail++;
    console.log('  FAIL [' + text + '] got=' + got + '/' + gotSrc + ' want=' + want + '/' + wantSrc);
  }
}

// 生图时不应同时建议 image_analysis（「把这张图改成油画」不需要先识别一遍）
const r = intent.detectIntent('把这张图改成油画风格', { hasImage: true });
const hasAnalysis = (r.suggestedTools || []).some((x) => x.tool === 'image_analysis');
if (!hasAnalysis) { pass++; console.log('  OK   生图时不重复做识图'); }
else { fail++; console.log('  FAIL 生图时仍建议了 image_analysis'); }

// primary 应为 image_generation
const r2 = intent.detectIntent('画只猫', {});
if (r2.primary === 'image_generation') { pass++; console.log('  OK   primary=image_generation'); }
else { fail++; console.log('  FAIL primary=' + r2.primary); }

console.log('\n========== intent: ' + pass + ' 通过 / ' + fail + ' 失败 ==========');
process.exit(fail ? 1 : 0);
