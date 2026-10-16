// 测试总入口：顺序跑全部测试文件，汇总结果。
//   node tests/run-all.js            # 全部
//   node tests/run-all.js --quick    # 只跑离线用例（不等 ComfyUI）
// live 用例（_test_comfyui_image / _test_gen_tool / _test_img2img / _test_fusion /
//           _test_faceswap / _test_faceswap_wiring）在本机没有 ComfyUI 时会自行 SKIP。
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const OFFLINE = [
  'agent_a.test.js',
  'agent_b.test.js',
  'agent_c.test.js',
  'agent_c1.test.js',
  'agent_c2.test.js',
  'agent_c3.test.js',
  's3_url.test.js',
  's3_net.test.js',
  'security_hardening.test.js',
  'group_admin.test.js',
  'group_admin_cmd.test.js',
  'feature_command_integration.test.js',
  'feature_summary_memory.test.js',
  'feiyu_upgrade.test.js',
  'v152_group_intel.test.js',   // V15.2 群聊智能决策 + 群友轻量画像（纯离线）
  'v153_poke.test.js',          // V15.3 群友戳一戳（纯离线，不发真实戳一戳）
  'v154_rich_features.test.js', // V15.4 语音识别/风格优化/表情包检索/生图确认（纯离线，联网检索用注入 mock）
  'v155_video_deepthink.test.js', // V15.5 短视频识别 + 深度思考判定（纯离线，不抓第三方页面）
  'v156_phase1_acceptance.test.js', // 第一阶段验收：群聊决策 + 群友画像 + 检索与成本（对应任务书 30 项）
  '_test_gen_intent.js',
  '_test_img_memory.js',
];
const LIVE = [
  '_test_comfyui_image.js',
  '_test_gen_tool.js',
  '_test_img2img.js',
  '_test_fusion.js',
  '_test_faceswap.js',
  '_test_faceswap_wiring.js',
];

const quick = process.argv.includes('--quick');
const files = quick ? OFFLINE : OFFLINE.concat(LIVE);

let passFiles = 0, failFiles = 0;
const failed = [];

for (const f of files) {
  const p = path.join(__dirname, f);
  console.log('\n\x1b[36m▶ ' + f + '\x1b[0m');
  const r = spawnSync(process.execPath, [p], { stdio: 'inherit', timeout: 300000 });
  if (r.status === 0) { passFiles++; }
  else { failFiles++; failed.push(f); }
}

console.log('\n========== 汇总 ==========');
console.log('文件：' + passFiles + ' 通过 / ' + failFiles + ' 失败（共 ' + files.length + '）' + (quick ? ' [--quick 仅离线]' : ''));
if (failed.length) { console.log('失败文件：' + failed.join(', ')); process.exit(1); }
process.exit(0);
