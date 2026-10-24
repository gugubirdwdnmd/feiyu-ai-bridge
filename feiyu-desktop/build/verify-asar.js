// 校验已安装产物（升级后 / 便携版）的 app.asar 是否含本轮全部修复
const asar = require('@electron/asar');
const p = process.argv[2];
if (!p) { console.error('用法: node verify-asar.js <app.asar 路径>'); process.exit(2); }

let list;
try { list = asar.listPackage(p); } catch (e) { console.error('❌ 无法读取 asar: ' + e.message); process.exit(1); }
console.log('asar: ' + p);
console.log('条目数: ' + list.length);

const get = (f) => { try { return asar.extractFile(p, f).toString(); } catch (e) { return null; } };

const checks = [
  ['src\\services\\botDirResolver.js', ['isSourceCheckout', 'siblingCandidates', 'discovered_sibling'], 'P1 botDir 修复(副本识别+兄弟目录扫描)'],
  ['src\\services\\redact.js', ['[\\\\/]', '本地路径'], '路径脱敏(含正斜杠)'],
  ['src\\ipc\\handlers.js', ['isCheckout', 'BOTDIR_STATUS', 'SKILL_SAVE', 'COMFY_INSTALL'], 'IPC 结构化状态 + 新通道'],
  ['src\\main.js', ['未写入设置'], '不再自动把发现目录落盘'],
  ['src\\services\\skillService.js', ['ALLOWED_HANDLERS', 'builtinTemplates'], '技能服务'],
  ['src\\services\\comfyService.js', ['MODEL_CATALOG', 'installComfyUI', 'checkPrerequisites'], 'ComfyUI 服务'],
  ['renderer\\renderer.js', ['pageSkills', 'pageComfy', 'isCheckout'], '渲染层两个新页面'],
  ['renderer\\index.html', ['data-page="skills"', 'data-page="comfy"'], '导航入口'],
];

let bad = 0;
for (const [f, needles, label] of checks) {
  const s = get(f);
  if (!s) { console.log('❌ ' + label + ' —— 文件缺失: ' + f); bad++; continue; }
  const miss = needles.filter((n) => !s.includes(n));
  if (miss.length) { console.log('❌ ' + label + ' —— 缺少: ' + miss.join(', ')); bad++; }
  else console.log('✅ ' + label);
}

// 硬编码检查：只看**代码行**（排除注释），确保 NapCat_publish 不再出现在逻辑里
{
  const s = get('src\\services\\botDirResolver.js') || '';
  const codeLines = s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  const hit = codeLines.some((l) => l.includes('NapCat_publish'));
  if (hit) { console.log('❌ botDirResolver 代码中仍含硬编码 NapCat_publish'); bad++; }
  else console.log('✅ botDirResolver 代码中无硬编码 NapCat_publish');
}

// 产物不得含用户数据/密钥/日志
const dataRe = /(^|[\\/])(secrets\.json|ai_config\.json|feiyu_provider_secrets\.json|feiyu_providers\.json|feiyu_personalities\.json|feiyu_skills\.json)$/i;
const dataFiles = list.filter((f) => dataRe.test(f));
const logFiles = list.filter((f) => /\.log$/i.test(f));
if (dataFiles.length) { console.log('❌ 含数据文件: ' + dataFiles.join(', ')); bad++; }
else console.log('✅ 不含密钥/配置/用户数据文件');
if (logFiles.length) { console.log('❌ 含日志文件: ' + logFiles.join(', ')); bad++; }
else console.log('✅ 不含日志文件');

console.log('');
console.log(bad ? 'ASAR_FAIL(' + bad + ')' : 'ASAR_OK');
process.exit(bad ? 1 : 0);
