'use strict';
/**
 * install-chain-check.js —— 安装版完整链路验收（安装 → 启动 → 改主题 → 重启 → 卸载）。
 *
 * 全程在**隔离目录**进行，绝不触碰真实机器人目录与真实用户数据：
 *  - 安装目标：D:\feiyu-v11-build\install\app
 *  - 隔离 userData：D:\feiyu-v11-build\install\userdata
 *  - 模拟机器人目录：D:\feiyu-v11-build\install\bot（仅用于记录 ai_config.json /
 *    secrets.json 的 SHA-256 前后对比，**只读**）
 *
 * 步骤：
 *  1. 记录模拟机器人目录的 ai_config.json / secrets.json SHA-256
 *  2. 静默安装 NSIS 安装包到隔离目录
 *  3. 以隔离 userData 启动安装后的主程序（asar 为唯一代码来源）
 *  4. 切换预设 + 切换动画 + 导出/导入
 *  5. 再次启动（模拟重启）→ 主题保留
 *  6. 卸载 → 程序文件清除、用户数据保留
 *  7. 复核 ai_config.json / secrets.json SHA-256 未变
 *
 * 运行：node build/install-chain-check.js <安装包路径> <隔离根目录>
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const INSTALLER = path.resolve(process.argv[2] || '');
const ROOT = path.resolve(process.argv[3] || 'D:/feiyu-v11-build/install');

const APP_DIR = path.join(ROOT, 'app');
const USER_DATA = path.join(ROOT, 'userdata');
const BOT_DIR = path.join(ROOT, 'bot');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed = 1; console.error('  ✗ ' + m); };
const info = (m) => console.log('  · ' + m);

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 递归统计目录里的文件数（排除目录本身）。 */
function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else n++;
    }
  };
  walk(dir);
  return n;
}

/** 静默安装 NSIS 包。NSIS 的 /D= 必须是最后一个参数且不加引号。 */
function runInstaller(targetDir) {
  const r = spawnSync(INSTALLER, ['/S', '/D=' + targetDir], { encoding: 'utf-8', timeout: 300000 });
  return r;
}

/** 静默卸载。 */
function runUninstaller(targetDir) {
  const un = path.join(targetDir, 'Uninstall 肥鱼桌面控制中心.exe');
  if (!fs.existsSync(un)) {
    // 退回到目录内任意 Uninstall*.exe
    const items = fs.readdirSync(targetDir).filter((f) => /^uninstall/i.test(f));
    if (!items.length) return null;
    return path.join(targetDir, items[0]);
  }
  return un;
}

function main() {
  console.log('\n[安装版链路验收]');
  console.log('  安装包: ' + INSTALLER);
  console.log('  隔离根: ' + ROOT + '\n');

  if (!fs.existsSync(INSTALLER)) { bad('安装包不存在: ' + INSTALLER); return; }

  // ---------- 1. 准备隔离环境 + 记录机器人目录哈希 ----------
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.mkdirSync(BOT_DIR, { recursive: true });
  const cfgPath = path.join(BOT_DIR, 'ai_config.json');
  const secPath = path.join(BOT_DIR, 'secrets.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ api: { baseUrl: 'https://example.invalid/v1/chat/completions', model: 'demo' } }, null, 2));
  fs.writeFileSync(secPath, JSON.stringify({ apiKey: 'sk-simulated-not-a-real-key' }, null, 2));
  const before = { cfg: sha256(cfgPath), sec: sha256(secPath) };
  info('模拟机器人目录 ai_config.json SHA-256: ' + before.cfg.slice(0, 32) + '…');
  info('模拟机器人目录 secrets.json  SHA-256: ' + before.sec.slice(0, 32) + '…');

  // ---------- 2. 静默安装 ----------
  console.log('\n[1] 静默安装');
  const ins = runInstaller(APP_DIR);
  info('安装进程退出码: ' + (ins.status === null ? 'null' : ins.status));
  const exe = path.join(APP_DIR, '肥鱼桌面控制中心.exe');
  if (!fs.existsSync(exe)) { bad('安装后未找到主程序: ' + exe); return; }
  ok('主程序已安装: 肥鱼桌面控制中心.exe');
  const fileCount = countFiles(APP_DIR);
  ok('安装目录文件数: ' + fileCount);

  const asar = path.join(APP_DIR, 'resources', 'app.asar');
  if (!fs.existsSync(asar)) { bad('未找到 app.asar: ' + asar); return; }
  ok('app.asar 存在');
  const asarList = require(path.join(__dirname, '..', 'node_modules', '@electron', 'asar')).listPackage(asar);
  // asar 列表项形如 "\renderer\theme.js"（前导反斜杠）
  const needTheme = ['\\renderer\\theme.js', '\\renderer\\styles.css', '\\src\\services\\themeService.js'];
  const miss = needTheme.filter((f) => !asarList.includes(f));
  if (!miss.length) ok('安装包内含主题相关文件');
  else bad('安装包内缺主题文件: ' + miss.join(', ') + '（实际含: ' +
    asarList.filter((f) => /theme|styles/i.test(f)).join(', ') + '）');

  // ---------- 3. 启动 + 改主题（用安装目录里的 asar） ----------
  console.log('\n[2] 首次启动 + 切换预设与动画');
  const script = path.join(__dirname, '..', 'install-theme-check.js');
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;   // 否则 electron 会退化成纯 node（app 为 undefined）
  const run1 = spawnSync('npx',
    ['electron', script, asar, USER_DATA],
    { encoding: 'utf-8', timeout: 300000, env, shell: true, cwd: path.join(__dirname, '..') });
  const out1 = (run1.stdout || '') + (run1.stderr || '');
  for (const line of out1.split('\n')) {
    if (/^\s*[✓✗]/.test(line) || /INSTALL_THEME_(OK|FAIL)/.test(line)) console.log('  ' + line.trim());
  }
  if (/INSTALL_THEME_OK/.test(out1)) ok('安装版主题链路通过（切换预设/动画/导入导出 + 重启保留）');
  else bad('安装版主题链路失败');

  const themeFile = path.join(USER_DATA, 'theme.json');
  if (fs.existsSync(themeFile)) {
    const raw = fs.readFileSync(themeFile, 'utf-8');
    // 落盘格式为扁平结构（bg/a/b/fx/speed/radius/blur）
    const tj = JSON.parse(raw);
    info('隔离 userData 主题: bg=' + tj.bg + ' a=' + tj.a + ' fx=' + tj.fx + ' speed=' + tj.speed);
    if (!/[A-Za-z]:[\\/]/.test(raw) && !/apiKey|secret|token/i.test(raw)) {
      ok('theme.json 不含路径与密钥');
    } else bad('theme.json 含路径或密钥样式内容');
  } else {
    bad('隔离 userData 未生成 theme.json');
  }

  // 主题必须没有写进安装目录
  const stray = [];
  const scan = (d, depth) => {
    if (depth > 3) return;
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isFile() && it.name === 'theme.json') stray.push(p);
      else if (it.isDirectory()) scan(p, depth + 1);
    }
  };
  scan(APP_DIR, 0);
  if (!stray.length) ok('安装目录内无 theme.json（主题只存 userData）');
  else bad('安装目录内出现 theme.json: ' + stray.join(', '));

  // ---------- 4. 卸载 ----------
  console.log('\n[3] 卸载');
  const un = runUninstaller(APP_DIR);
  if (!un) { bad('未找到卸载程序'); }
  else {
    info('卸载程序: ' + path.basename(un));
    // NSIS 静默卸载用 /S
    const u = spawnSync(un, ['/S'], { encoding: 'utf-8', timeout: 300000 });
    info('卸载进程退出码: ' + (u.status === null ? 'null' : u.status));
    // 等待文件真正消失
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (!fs.existsSync(exe)) break;
      spawnSync('ping', ['-n', '2', '127.0.0.1'], { encoding: 'utf-8' });
    }
    if (!fs.existsSync(exe)) ok('主程序已移除');
    else bad('卸载后主程序仍存在: ' + exe);
    const left = countFiles(APP_DIR);
    info('卸载后安装目录残留文件数: ' + left);
  }

  // ---------- 5. 用户数据保留 ----------
  console.log('\n[4] 卸载后用户数据');
  if (fs.existsSync(themeFile)) ok('隔离 userData 的 theme.json 保留（卸载不删用户数据）');
  else bad('卸载后 theme.json 丢失');

  // ---------- 6. 机器人目录哈希复核 ----------
  console.log('\n[5] 机器人目录哈希复核');
  const after = { cfg: sha256(cfgPath), sec: sha256(secPath) };
  if (after.cfg === before.cfg) ok('ai_config.json SHA-256 未变: ' + after.cfg.slice(0, 32) + '…');
  else bad('ai_config.json 被改动');
  if (after.sec === before.sec) ok('secrets.json SHA-256 未变: ' + after.sec.slice(0, 32) + '…');
  else bad('secrets.json 被改动');
}

main();
console.log(failed ? '\nINSTALL_CHAIN_FAIL' : '\nINSTALL_CHAIN_OK');
process.exit(failed ? 1 : 0);
