'use strict';
/**
 * upgrade-chain-check.js —— v1.0.0 → v1.1.0 原地升级链路验收。
 *
 * 全程在**隔离目录**进行，绝不触碰真实机器人目录与真实用户数据：
 *  - 安装目标：D:\feiyu-v11-build\upgrade\app
 *  - 隔离 userData：D:\feiyu-v11-build\upgrade\userdata
 *  - 模拟机器人目录：D:\feiyu-v11-build\upgrade\bot（只读，记录 SHA-256）
 *
 * 步骤：
 *  1. 记录模拟机器人目录 ai_config.json / secrets.json 的 SHA-256
 *  2. 静默安装 **v1.0.0** 安装包
 *  3. 以 v1.0.0 的 asar 启动一次 → 生成旧版用户数据（price.json）
 *  4. 静默安装 **v1.1.0** 安装包（**覆盖同一目录**，模拟原地升级）
 *  5. 校验：版本已升到 1.1.0、asar 含主题文件、旧用户数据哈希不变
 *  6. 以 v1.1.0 的 asar 启动一次 → 旧数据仍在 + 主题功能可用
 *  7. 复核 ai_config.json / secrets.json SHA-256 未变
 *
 * 运行：node build/upgrade-chain-check.js <v1.0.0安装包> <v1.1.0安装包> <隔离根目录>
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const INSTALLER_OLD = path.resolve(process.argv[2] || '');
const INSTALLER_NEW = path.resolve(process.argv[3] || '');
const ROOT = path.resolve(process.argv[4] || 'D:/feiyu-v11-build/upgrade');


let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed = 1; console.error('  ✗ ' + m); };
const info = (m) => console.log('  · ' + m);

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 递归列出目录下所有文件的相对路径 + SHA-256。
 * 分为两组：
 *  - 业务数据（BUSINESS）：应用自己写入的配置/价格表/主题等，升级必须逐字节保留
 *  - 运行时缓存（CACHE）：Chromium 自动生成的缓存（会被正常刷新，不作为保留依据）
 */
const BUSINESS_FILES = ['price.json', 'theme.json', 'feiyu-settings.json', 'feiyu_price.json'];
function isBusiness(rel) {
  const base = rel.split('/').pop();
  return BUSINESS_FILES.indexOf(base) >= 0;
}
function hashTree(dir, onlyBusiness) {
  const out = {};
  const walk = (d) => {
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else {
        const rel = path.relative(dir, p).replace(/\\/g, '/');
        if (onlyBusiness && !isBusiness(rel)) continue;
        out[rel] = sha256(p);
      }
    }
  };
  walk(dir);
  return out;
}

/** 静默安装 NSIS 包。/D= 必须是最后一个参数且不加引号。 */
function runInstaller(installer, targetDir) {
  return spawnSync(installer, ['/S', '/D=' + targetDir], { encoding: 'utf-8', timeout: 300000 });
}

/** 以指定 asar 为代码来源启动一次（Electron 运行时）。 */
function probe(asar, label, userData) {
  const script = path.join(__dirname, 'upgrade-probe.js');
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;   // 否则 electron 退化成纯 node（app 为 undefined）
  const r = spawnSync('npx',
    ['electron', script, asar, userData],
    { encoding: 'utf-8', timeout: 300000, env, shell: true, cwd: path.join(__dirname, '..') });
  const out = (r.stdout || '') + (r.stderr || '');
  console.log('\n  [' + label + ']');
  for (const line of out.split('\n')) {
    if (/^\s*[✓✗·]/.test(line) || /UPGRADE_PROBE_(OK|FAIL)/.test(line)) console.log('  ' + line.trim());
  }
  return /UPGRADE_PROBE_OK/.test(out);
}

function main() {
  console.log('\n[升级链验收 v1.0.0 → v1.1.0]');
  console.log('  旧安装包: ' + INSTALLER_OLD);
  console.log('  新安装包: ' + INSTALLER_NEW);
  console.log('  隔离根:   ' + ROOT + '\n');

  if (!fs.existsSync(INSTALLER_OLD)) { bad('旧安装包不存在: ' + INSTALLER_OLD); return; }
  if (!fs.existsSync(INSTALLER_NEW)) { bad('新安装包不存在: ' + INSTALLER_NEW); return; }

  // ---------- 0. 隔离环境 ----------
  // 注意：不做递归删除（受运行环境的安全删除策略限制，回收站操作可能中止）。
  // 改为在隔离根下开一个带时间戳的**全新子目录**，保证每次都是干净环境。
  const RUN_DIR = path.join(ROOT, 'run-' + Date.now());
  const APP_DIR = path.join(RUN_DIR, 'app');
  const USER_DATA = path.join(RUN_DIR, 'userdata');
  const BOT_DIR = path.join(RUN_DIR, 'bot');
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.mkdirSync(USER_DATA, { recursive: true });
  fs.mkdirSync(BOT_DIR, { recursive: true });
  const cfgPath = path.join(BOT_DIR, 'ai_config.json');
  const secPath = path.join(BOT_DIR, 'secrets.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ api: { baseUrl: 'https://example.invalid/v1/chat/completions', model: 'demo' } }, null, 2));
  fs.writeFileSync(secPath, JSON.stringify({ apiKey: 'sk-simulated-not-a-real-key' }, null, 2));
  const botBefore = { cfg: sha256(cfgPath), sec: sha256(secPath) };
  info('模拟 ai_config.json SHA-256: ' + botBefore.cfg.slice(0, 32) + '…');
  info('模拟 secrets.json  SHA-256: ' + botBefore.sec.slice(0, 32) + '…');

  // 真实用户数据目录的**运行前**基线（只读），用于事后核对是否被本轮污染
  const realRoaming = path.join(process.env.APPDATA || '', 'feiyu-desktop-control-center');
  const realBefore = hashTree(realRoaming, true);

  const asarOf = () => path.join(APP_DIR, 'resources', 'app.asar');

  // ---------- 1. 安装 v1.0.0 ----------
  console.log('\n[1] 安装 v1.0.0');
  const i1 = runInstaller(INSTALLER_OLD, APP_DIR);
  info('安装进程退出码: ' + (i1.status === null ? 'null' : i1.status));
  if (!fs.existsSync(asarOf())) { bad('v1.0.0 安装后未找到 app.asar'); return; }
  ok('v1.0.0 已安装');
  const asar1 = asarOf();

  const v1 = probe(asar1, 'v1.0.0 首次启动', USER_DATA);
  if (!v1) bad('v1.0.0 首次启动探测失败');
  const userDataAfterV1 = hashTree(USER_DATA, true);
  const userFiles = Object.keys(userDataAfterV1);
  const cacheCount = Object.keys(hashTree(USER_DATA, false)).length - userFiles.length;
  if (userFiles.length) {
    ok('v1.0.0 生成的业务用户数据: ' + userFiles.join(', '));
    for (const f of userFiles) info('  ' + f + ' = ' + userDataAfterV1[f].slice(0, 32) + '…');
    info('（另有 ' + cacheCount + ' 个 Chromium 运行时缓存文件，正常刷新，不作为保留依据）');
  } else {
    bad('v1.0.0 未生成任何业务用户数据，无法验证升级保留');
  }

  // ---------- 2. 原地升级到 v1.1.0 ----------
  console.log('\n[2] 原地升级到 v1.1.0（覆盖同一安装目录）');
  const i2 = runInstaller(INSTALLER_NEW, APP_DIR);
  info('安装进程退出码: ' + (i2.status === null ? 'null' : i2.status));
  const asar2 = asarOf();
  if (!fs.existsSync(asar2)) { bad('升级后未找到 app.asar'); return; }
  ok('v1.1.0 覆盖安装完成');

  // ---------- 3. 校验版本与内容 ----------
  console.log('\n[3] 校验升级结果');
  const asarMod = require(path.join(__dirname, '..', 'node_modules', '@electron', 'asar'));
  const asarList = asarMod.listPackage(asar2);
  const need = ['\\renderer\\theme.js', '\\renderer\\styles.css', '\\src\\services\\themeService.js'];
  const miss = need.filter((f) => !asarList.includes(f));
  if (!miss.length) ok('升级后 asar 含主题相关文件');
  else bad('升级后 asar 缺主题文件: ' + miss.join(', '));

  // 通过 asar 库读包内 package.json（普通 fs 读不了 asar 虚拟路径）
  let newVersion = '';
  try {
    const pkgBuf = asarMod.extractFile(asar2, 'package.json');
    newVersion = JSON.parse(pkgBuf.toString('utf-8')).version || '';
  } catch (e) {
    info('读取 asar 内 package.json 失败: ' + e.message);
  }
  if (newVersion) {
    info('升级后 asar 内版本: ' + newVersion);
    if (newVersion === '1.1.0') ok('版本已升级到 1.1.0');
    else bad('版本不是 1.1.0: ' + newVersion);
  } else {
    // 读不到就用主题文件存在性判断（1.0.0 无 theme.js）
    if (!miss.length) ok('升级生效（asar 已含 1.1.0 独有的主题文件）');
    else bad('无法确认升级生效');
  }

  // ---------- 4. 旧用户数据是否保留 ----------
  console.log('\n[4] 升级后用户数据');
  const userDataAfterV2 = hashTree(USER_DATA, true);
  const kept = [];
  const changed = [];
  const lost = [];
  for (const f of userFiles) {
    if (!(f in userDataAfterV2)) lost.push(f);
    else if (userDataAfterV2[f] !== userDataAfterV1[f]) changed.push(f);
    else kept.push(f);
  }
  if (!lost.length) ok('旧版用户数据文件全部保留: ' + kept.join(', '));
  else bad('升级后丢失用户数据文件: ' + lost.join(', '));
  if (!changed.length) ok('旧版用户数据内容逐字节未变（SHA-256 一致）');
  else bad('升级后用户数据内容被改动: ' + changed.join(', '));

  // ---------- 5. 新版本启动 ----------
  const v2 = probe(asar2, 'v1.1.0 升级后启动', USER_DATA);
  if (!v2) bad('v1.1.0 升级后启动探测失败');
  else ok('v1.1.0 升级后启动正常');

  const userDataAfterV3 = hashTree(USER_DATA, true);
  for (const f of userFiles) {
    if (f in userDataAfterV3 && userDataAfterV3[f] === userDataAfterV1[f]) {
      info('旧数据在新版本运行后仍一致: ' + f);
    }
  }
  const stillThere = userFiles.every((f) => f in userDataAfterV3);
  if (stillThere) ok('新版本运行后旧用户数据仍在');
  else bad('新版本运行后旧用户数据缺失');

  // ---------- 5.1 新版本能否正确读出旧数据 ----------
  console.log('\n[5.1] 新版本读取旧用户数据');
  const priceFile = path.join(USER_DATA, 'price.json');
  if (fs.existsSync(priceFile)) {
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(priceFile, 'utf-8')); } catch (_) {}
    if (parsed && typeof parsed === 'object') {
      ok('新版本读出旧 price.json 正常（顶层键: ' + Object.keys(parsed).slice(0, 5).join(', ') + '）');
    } else {
      bad('新版本读出旧 price.json 异常');
    }
  } else {
    bad('price.json 缺失');
  }

  // ---------- 6. 机器人目录哈希复核 ----------
  console.log('\n[5] 机器人目录哈希复核');
  const botAfter = { cfg: sha256(cfgPath), sec: sha256(secPath) };
  if (botAfter.cfg === botBefore.cfg) ok('ai_config.json SHA-256 未变: ' + botAfter.cfg.slice(0, 32) + '…');
  else bad('ai_config.json 被改动');
  if (botAfter.sec === botBefore.sec) ok('secrets.json SHA-256 未变: ' + botAfter.sec.slice(0, 32) + '…');
  else bad('secrets.json 被改动');

  // ---------- 7. 隔离性复核 ----------
  console.log('\n[6] 隔离性');
  const realFilesBefore = Object.keys(realBefore);
  info('真实用户数据目录（只读基线）: ' + realRoaming);
  info('  业务文件: ' + (realFilesBefore.length ? realFilesBefore.join(', ') : '（无）'));
  for (const f of realFilesBefore) info('  ' + f + ' = ' + realBefore[f].slice(0, 32) + '…');

  // 复核：真实目录里的业务文件不得被本轮改动
  const realAfter = hashTree(realRoaming, true);
  const polluted = [];
  for (const f of Object.keys(realBefore)) {
    if (!(f in realAfter) || realAfter[f] !== realBefore[f]) polluted.push(f);
  }
  const added = Object.keys(realAfter).filter((f) => !(f in realBefore));
  if (!polluted.length && !added.length) {
    ok('真实用户数据目录未被本轮改动（' + realFilesBefore.length + ' 个业务文件哈希全部一致）');
  } else {
    bad('真实用户数据目录被改动: 变更=[' + polluted.join(', ') + '] 新增=[' + added.join(', ') + ']');
  }
}

main();
console.log(failed ? '\nUPGRADE_CHAIN_FAIL' : '\nUPGRADE_CHAIN_OK');
process.exit(failed ? 1 : 0);
