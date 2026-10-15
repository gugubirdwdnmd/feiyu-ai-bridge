'use strict';
// ============================================================================
// V14-C NapCat 环境专项测试
// ----------------------------------------------------------------------------
// 本文件【不在】默认测试链（npm test）中，只在完整环境下运行：
//     npm run test:napcat
//
// 迁移来源：tests/agent_c.test.js 原第 229–239 行「真实能力探测（不是猜的）」。
// 迁移说明：断言内容与检查逻辑逐字保留，未删除、未弱化、未伪造结果。
//
// 依赖：NapCat 发行包自带的 ffmpeg 原生模块
//     napcat/native/ffmpeg/ffmpegAddon.win32.x64.node
// 该二进制属第三方分发内容，不随本仓库发布。因此在不含 NapCat 的环境中，
// 本文件的 3 条断言会如实失败（加载失败即记为 false，不做任何掩饰）。
// ============================================================================

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name) { if (cond) pass++; else { fail++; fails.push(name); console.log('  ✗ ' + name); } }

// —— 真实能力探测（不是猜的）——
const addonPath = path.join(__dirname, '..', 'napcat', 'native', 'ffmpeg', 'ffmpegAddon.win32.x64.node');
ok(fs.existsSync(addonPath), '★napcat 自带 ffmpeg native addon 文件存在');
let addonOK = false, addonHasGetInfo = false;
try {
  const a = require(addonPath);
  addonOK = true;
  addonHasGetInfo = typeof a.getVideoInfo === 'function';
} catch (e) { /* 加载失败就如实记为 false */ }
ok(addonOK, '★ffmpeg native addon 可被加载（无需 ffmpeg.exe）');
ok(addonHasGetInfo, '★addon 提供 getVideoInfo（元数据 + 首帧）');

console.log('\n' + '='.repeat(52));
console.log(`V14-C NapCat 环境专项测试：通过 ${pass}，失败 ${fail}`);
if (fail) {
  console.log('失败项：');
  fails.forEach((f) => console.log('  - ' + f));
  console.log('说明：以上失败表示当前环境缺少 NapCat 发行包或其 ffmpeg 原生模块，');
  console.log('      这属于环境前置条件未满足，不是代码缺陷。请在装有 NapCat 的环境中重跑。');
}
console.log('='.repeat(52));
process.exit(fail ? 1 : 0);
