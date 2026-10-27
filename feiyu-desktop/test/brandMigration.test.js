const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const pkg = JSON.parse(read('package.json'));

const BRAND = '玄枢 XUANSHU';
const OLD_BRAND = '肥鱼桌面控制中心';

test('品牌显示名已更新为「玄枢 XUANSHU」', () => {
  assert.strictEqual(pkg.build.productName, BRAND, 'package.json productName 应为玄枢 XUANSHU');
  assert.strictEqual(pkg.build.nsis.shortcutName, BRAND, 'nsis shortcutName 应为玄枢 XUANSHU');
});

test('窗口标题与页面标题已更新', () => {
  assert.ok(read('src/main.js').includes(`title: '${BRAND}'`), 'main.js 窗口标题应为玄枢 XUANSHU');
  const html = read('renderer/index.html');
  assert.ok(html.includes(`<title>${BRAND}</title>`), 'index.html <title> 应为玄枢 XUANSHU');
  assert.ok(html.includes(BRAND), 'index.html 品牌区应含玄枢 XUANSHU');
});

test('构建产物名已更新（electron-builder 与构建脚本）', () => {
  const yml = read('build/electron-builder.yml');
  assert.ok(yml.includes(`productName: ${BRAND}`), 'electron-builder productName');
  assert.ok(yml.includes(`shortcutName: ${BRAND}`), 'electron-builder shortcutName');
  assert.ok(yml.includes(`artifactName: ${BRAND}-`), 'portable artifactName');
  assert.ok(read('build/after-pack-icon.js').includes(`${BRAND}.exe`), 'after-pack-icon exe 名');
  assert.ok(read('build/apply-icon.js').includes(`${BRAND}.exe`), 'apply-icon exe 名');
  assert.ok(read('build/install-chain-check.js').includes(`${BRAND}.exe`), 'install-chain-check exe 名');
  assert.ok(read('build/verify-icons.js').includes(`${BRAND}.exe`), 'verify-icons exe 名');
});

test('兼容性标识必须保留（用户数据/配置/凭据不因改名丢失）', () => {
  assert.strictEqual(pkg.name, 'feiyu-desktop-control-center', 'npm name 决定 userData 目录，必须保留');
  assert.strictEqual(pkg.build.appId, 'com.feiyu.desktop', 'appId 决定 NSIS GUID，必须保留');
  assert.strictEqual(pkg.version, '1.4.0', '版本号保留（1.4 成果）');
  assert.ok(read('renderer/theme.js').includes('window.FeiyuTheme'), 'window.FeiyuTheme 全局名保留');
  assert.ok(read('src/ipc/handlers.js').includes('feiyu-settings.json'), 'feiyu_*.json 数据文件名保留');
  assert.ok(
    read('README.md').includes('%APPDATA%/feiyu-desktop-control-center'),
    'README 中用户数据目录引用保留'
  );
});

test('README 显示名已更新且无旧名残留', () => {
  const readme = read('README.md');
  assert.ok(readme.includes(BRAND), 'README 应含玄枢 XUANSHU');
  assert.ok(!readme.includes(OLD_BRAND), 'README 不应残留旧显示名');
});

test('渲染端无旧显示名残留', () => {
  for (const f of ['renderer/index.html', 'renderer/renderer.js', 'renderer/styles.css', 'src/main.js']) {
    assert.ok(!read(f).includes(OLD_BRAND), `${f} 不应残留旧显示名`);
  }
});
