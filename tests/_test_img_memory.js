'use strict';
// 验证「图生图记不住图」修复：跨消息图片记忆（累积最近几张图）+
// 私聊图片记忆 + 「替换/换脸/融合」触发图生图（不再退化成文生图）。
// 纯本地，不发任何真实 QQ 消息、不调生图后端。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'ai_bridge.js'), 'utf-8');
const fakeHttp = { createServer: () => ({ listen: () => {} }) };
const sandbox = {
  // 沙箱里 ai_bridge.js 的 require 相对它自己的目录（ROOT）解析，不是相对本测试文件
  require: (n) => (n === 'http' ? fakeHttp : require(n.startsWith('.') ? require.resolve(n, { paths: [ROOT] }) : n)),
  console, process, fs, path,
  __dirname: ROOT, __filename: path.join(ROOT, 'ai_bridge.js'),
  URL, URLSearchParams, Buffer, AbortController, AbortSignal, fetch, Blob, FormData,
  setTimeout, clearTimeout, setInterval, clearInterval,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
if (!process.env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = 'sk-offline-test-dummy'; // 沙箱加载 ai_bridge 需要非空 Key，否则启动即退出
vm.runInContext(SRC + '\n;globalThis.__T={storePendingGroupImages,takePendingGroupImages,isImg2ImgIntent,isImageGenIntent};', sandbox, { filename: 'ai_bridge.js' });
const T = sandbox.__T;
const { detectIntent } = require('../agent/intent');

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name); console.log('  ✗ ' + name + (extra != null ? '  -> ' + JSON.stringify(extra) : '')); }
}
const seg = (id) => ({ type: 'image', data: { file: id + '.png' } });

console.log('\n========== 图生图跨消息记忆 ==========\n');

// 1) 累积而非覆盖：先发 p1、再发 p2，取用时两图都在
T.storePendingGroupImages(111, 9, [seg('p1')]);
T.storePendingGroupImages(111, 9, [seg('p2')]);
let got = T.takePendingGroupImages(111, 9);
ok('多图累积 (p1+p2 都在)', got.length === 2 && got[0].data.file === 'p1.png' && got[1].data.file === 'p2.png', got.map(s => s.data.file));

// 2) 取走即清：再取一次应为空
ok('取走即清', T.takePendingGroupImages(111, 9).length === 0);

// 3) 私聊也有记忆（groupId 传 null）
T.storePendingGroupImages(null, 9, [seg('priv1')]);
ok('私聊图片记忆', T.takePendingGroupImages(null, 9).length === 1);

// 4) 生成图置顶：刚画好的图放到最前，后续 source="1" 指向它
T.storePendingGroupImages(111, 9, [seg('p1'), seg('p2')]);
T.storePendingGroupImages(111, 9, [seg('gen')], true);
got = T.takePendingGroupImages(111, 9);
ok('生成图置顶 (source=1 即最新结果)', got.length === 3 && got[0].data.file === 'gen.png', got.map(s => s.data.file));

// 5) 去重：同一张图反复发只留一份
T.storePendingGroupImages(111, 9, [seg('a')]);
T.storePendingGroupImages(111, 9, [seg('a')]);
ok('同图去重', T.takePendingGroupImages(111, 9).length === 1);

// 6) 上限保护：连发 10 张只留最近 6 张
for (let i = 1; i <= 10; i++) T.storePendingGroupImages(111, 9, [seg('m' + i)]);
ok('最多保留 6 张', T.takePendingGroupImages(111, 9).length === 6);

// 7) 模拟群聊真实流程：发 p1 → 发 p2 → 用户打字「把 p1 的脸换成 p2 的脸」
//    对应 ai_bridge 行 4673(store) + 4754-4755(useImgs=takePending)
T.storePendingGroupImages(111, 9, [seg('p1')]);
T.storePendingGroupImages(111, 9, [seg('p2')]);
let useImgs = T.takePendingGroupImages(111, 9);   // 跟进消息无图 → 取历史
const sig = { hasImage: useImgs.length > 0, hasRecentImage: useImgs.length > 0, isGroup: true, imageGeneration: true };
const pi = detectIntent('把 p1 原图里的人物脸换成 p2 照片里这位男士的脸', sig);
const gen = (pi.suggestedTools || []).find(x => x.tool === 'generate_image');
ok('跟进「换成脸」→ 建议图生图', !!gen, pi.suggestedTools);
ok('图生图 source 指向已有图(source="1")', gen && String(gen.args.source) === '1', gen && gen.args);
ok('图生图带上 p1 作为底图', useImgs.length === 2, useImgs.map(s => s.data.file));

// 8) 「替换/换脸/融合」现在能触发图生图（修复前只会退化成文生图）
const r1 = detectIntent('帮我把这张图替换成水彩风格', { hasImage: true, hasRecentImage: true, imageGeneration: true });
const r2 = detectIntent('用这张照片换脸成我', { hasImage: true, hasRecentImage: true, imageGeneration: true });
const r3 = detectIntent('把两人融合成一张', { hasImage: true, hasRecentImage: true, imageGeneration: true });
ok('「替换」触发图生图', !!(r1.suggestedTools || []).find(x => x.tool === 'generate_image' && x.args.source === '1'), r1.suggestedTools);
ok('「换脸」触发图生图', !!(r2.suggestedTools || []).find(x => x.tool === 'generate_image'), r2.suggestedTools);
ok('「融合」触发图生图', !!(r3.suggestedTools || []).find(x => x.tool === 'generate_image'), r3.suggestedTools);

// 9) 纯文生图仍不带 source（不会误判成图生图）
const t1 = detectIntent('给我画一只猫', { hasImage: false, hasRecentImage: false, imageGeneration: true });
const tg = (t1.suggestedTools || []).find(x => x.tool === 'generate_image');
ok('纯文生图不填 source', !tg || !tg.args.source, tg && tg.args);

console.log('\n========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
if (fail) console.log('失败项：' + fails.join(' | '));
process.exit(fail ? 1 : 0);
