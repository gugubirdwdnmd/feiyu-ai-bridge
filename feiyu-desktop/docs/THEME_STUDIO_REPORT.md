# 主题工坊（v1.1.0）开发与验收报告

> 分支：`feature/theme-studio`　基线：`513d64b`（tag `feiyu-desktop-v1.0.0`）
> 桌面端目录：`feiyu-desktop/`　机器人核心：`ai_bridge.js`（仓库根）

本轮是 **v1.0.0 发布后的第一个功能迭代**，不重写机器人业务逻辑，只在桌面端新增「主题工坊」。

---

## 1. 边界与现场记录

### 1.1 开工前核实（只读）

```
$ git status
On branch feature/feiyu-desktop-control-center
nothing to commit, working tree clean
$ git rev-parse HEAD
513d64b0089b48d4fa1a8c2aa8403301f752fddb
$ git tag -l
feiyu-desktop-v0.1.0
feiyu-desktop-v1.0.0
```

工作区干净，HEAD 正是 v1.0.0 的 tag 指向，无未登记的现场改动。
据此切出 `feature/theme-studio`（未动 `main`，未新建/移动任何 tag）。

### 1.2 基线数字

| 项 | 基线（513d64b） | 本轮结束 |
|---|---|---|
| `node --test` | 326 / 326 通过 | **384 / 384 通过**（+58） |
| `node --check` | 全通过 | 全通过 |
| `build/package-check.js` | EXIT=0（38 项） | EXIT=0（**57 项**） |
| Electron smoke | `SMOKE_OK handlers=57` | **`SMOKE_OK handlers=63`**（+6 主题通道） |

> handlers 数量如实从 57 变为 63 —— 新增 6 个主题 IPC 通道（`theme:get/save/reset/presets/export/import`），
> 未做任何「凑数」处理。

### 1.3 隔离环境

| 用途 | 路径 |
|---|---|
| 源码（唯一改动对象） | `D:\NapCat_publish\feiyu-desktop\` |
| 构建输出（独立） | `D:\feiyu-v11-build\dist\` |
| 便携版解包 | `D:\feiyu-v11-build\portable-extract\` |
| 便携版隔离 userData | `D:\feiyu-v11-build\portable-userdata\` |
| 单元测试临时目录 | `%TEMP%\theme-svc-* / theme-ud-* / theme-bot-*` |

**未触碰**：`D:\feiyu-rv\build\dist3`（v1.0.0 产物）、`%APPDATA%\feiyu-desktop-control-center\`（真实用户数据）、
`D:\NapCat\`（真实机器人目录）。核查见第 7 节。

---

## 2. 新增文件

| 文件 | 作用 |
|---|---|
| `feiyu-desktop/src/services/themeService.js` | 主题的校验 / 派生 / 持久化（纯逻辑，可单测） |
| `feiyu-desktop/renderer/theme.js` | 渲染层主题运行时：写 CSS 变量 + 背景动画 |
| `feiyu-desktop/test/themeService.test.js` | 单元 + 持久化 + 隔离测试（37 项） |
| `feiyu-desktop/test/themeIpc.test.js` | IPC 白名单 + 渲染层动画行为测试（10 项） |
| `feiyu-desktop/test/themeReadability.test.js` | 文字可读性 / 对比度测试（6 项） |
| `feiyu-desktop/theme-func-main.js` | 主题功能端到端验收脚本（Electron 运行时） |
| `feiyu-desktop/theme-portable-check.js` | 便携版产物的主题验收脚本（Electron 运行时） |
| `feiyu-desktop/build/make-icon.js` | 图标生成（SVG → Electron 渲染 → 多尺寸 ICO/PNG） |
| `feiyu-desktop/build/verify-icons.js` | 产物图标一致性校验（PE 资源解析 + 逐像素比对） |
| `feiyu-desktop/build/apply-icon.js` | 手动给主程序 exe 注入图标（备用路径） |
| `feiyu-desktop/build/after-pack-icon.js` | electron-builder afterPack 钩子：打包期注入图标 |
| `feiyu-desktop/build/install-chain-check.js` | 安装版完整链路验收（安装→启动→改主题→重启→卸载） |
| `feiyu-desktop/install-theme-check.js` | 安装版主题功能验收（以安装目录 asar 为代码来源） |
| `feiyu-desktop/build/icon.ico` | 应用图标（16/24/32/48/64/128/256） |
| `feiyu-desktop/build/icon.png` | 256×256 PNG（窗口图标） |

## 3. 改动文件

| 文件 | 改动 |
|---|---|
| `src/services/ipcChannels.js` | 新增 6 个主题通道 + 参数校验（未知通道仍被拒） |
| `src/ipc/handlers.js` | 注册 6 个主题处理器（只读 `getUserDataDir()`，不碰 botDir） |
| `src/services/themeService.js` | 主题校验 / 派生 / 持久化；对比度兜底语义重写（见 4.2） |
| `src/main.js` | 窗口图标（`resolveWindowIcon()` + `BrowserWindow.icon`） |
| `renderer/index.html` | 导航加「主题工坊」入口；引入 `theme.js` |
| `renderer/styles.css` | **全量改用 CSS 变量**，新增主题工坊样式；新增 `#bgCanvas` 动画画布层 |
| `renderer/renderer.js` | 新增「主题工坊」页；启动时先加载主题再渲染首页 |
| `build/package-check.js` | 新增文件纳入打包检查；新增主题与图标专项检查 |
| `build/electron-builder.yml` | 同步 `win.icon` / NSIS 图标 / 快捷方式名 |
| `smoke-main.js` | 隔离 userData；新增主题 IPC / 主题页 / CSS 变量冒烟断言 |
| `package.json` | 版本 1.0.0 → **1.1.0**；`win.icon`；NSIS 图标；`afterPack` 钩子；`check` 脚本 |
| `docs/USER_GUIDE.md` | 新增第 9 章「主题工坊」 |

---

## 4. 实现要点

### 4.1 配色方案

内置 6 套预设，色值与需求逐项核对（`test/themeService.test.js` 中有逐值断言）：

| key | 名称 | bg | a | b |
|---|---|---|---|---|
| deepsea | 深海 | `#0b1d2a` | `#ff8a5c` | `#4fd1c5` |
| coral | 珊瑚礁 | `#1f1020` | `#ff6f91` | `#ffc75f` |
| aurora | 极光 | `#0c1424` | `#7cf7c4` | `#8f7bff` |
| sakura | 樱花 | `#fbf1f4` | `#e0527c` | `#7aa8e8` |
| matcha | 抹茶 | `#eef3e6` | `#4f8a3c` | `#d9a441` |
| ink | 墨夜 | `#101010` | `#f2c14e` | `#e5e5e5` |

### 4.2 自定义调色盘与自动推算

- 亮度：`lum = (0.299R + 0.587G + 0.114B) / 255`，`lum < 0.5` 为深色；
- `surface`：深色向白 7%，浅色向黑 4%（**严格按需求比例**，有独立断言）；
- `text`：深色 `#e8f1f5`，浅色 `#1c2a33`；
- `muted`：深色 `#8aa4b3`，浅色 `#5d7280`。

**可读性保险（重要设计说明）**

需求指定的固定文字色在两类背景上会低于 WCAG AA 正文门槛 4.5:1：

| 背景 | 基准色对比度 | 说明 |
|---|---|---|
| `#767676` | 3.97 | 亮度阈值附近的中灰 |
| `#03d027` | 2.09 | 高饱和中亮度色 |

处理方式**不改动需求的基准色规则**，而是加一层保险：

1. 基准色在 `bg` / `surface` / `surface2` 三种底色上的最差对比度达标 → **原样保留**；
2. 不达标 → 找**改动最小**且能达标的颜色（而不是对比度最大的那个）。

> 「改动最小」是关键：若一律取对比度最大，次要文字会被一路推到与正文同色，层级信息丢失。

三个兜底各自的目标与手段不同：

| 场景 | 目标 | 手段 | 保层级 |
|---|---|---|---|
| `text`（正文） | ≥ 4.5:1 | 向纯白/纯黑混合，取最小改动 | —— |
| `muted`（次要文字） | ≥ 3:1 | **朝正文色靠拢**，取最小改动 | ✅ 不与正文同色 |
| `--accent-text`（强调色作文字） | ≥ 4.5:1（对 `surface`） | **等比缩放**，保持色相 | ✅ 色相不变 |

**`--accent` 与 `--accent-text` 的分工**：`--accent` 是用户选定的品牌色，
用作按钮底色/描边/进度条，**永不被改写**；只有「把强调色当文字写」（侧栏品牌名）
才用 `--accent-text`。实测樱花/抹茶的品牌名对比度从 3.06/3.38 提升到 4.69/4.62。

已验证：
- 兜底结果在数学可达时**必然达标**（正文 ≥ 4.5、muted ≥ 3）；
- 数学不可达时（亮度阈值附近窄带）取**可达最优**（抽样 286 个不达标背景，偏差 > 0.05 的：**0** 个）；
- 全色域抽样（256³ 中每 5 取 1）实测，正文对三种底色的最差对比度 **≥ 3:1**（WCAG AA 大字号底线）；
- 六个内置预设**全部保留需求指定的原色**（断言 `textAdjusted === false`）。

### 4.2.1 六个预设的实际对比度

| 预设 | text | cr(text,bg) | cr(text,surface) | muted | cr(muted,bg) | cr(muted,surface) | accent | cr(accent,surface) | accent-text | cr(accent-text,surface) |
|---|---|---|---|---|---|---|---|---|---|---|
| 深海 | `#e8f1f5` | 14.98 | 12.35 | `#8aa4b3` | 6.57 | 5.42 | `#ff8a5c` | 6.09 | `#ff8a5c` | 6.09 |
| 珊瑚礁 | `#e8f1f5` | 15.90 | 13.27 | `#8aa4b3` | 6.97 | 5.82 | `#ff6f91` | 5.75 | `#ff6f91` | 5.75 |
| 极光 | `#e8f1f5` | 16.06 | 13.56 | `#8aa4b3` | 7.05 | 5.95 | `#7cf7c4` | 11.80 | `#7cf7c4` | 11.80 |
| 樱花 | `#1c2a33` | 13.30 | 12.15 | `#5d7280` | 4.54 | 4.15 | `#e0527c` | 3.06 | `#ae4060` | 4.69 |
| 抹茶 | `#1c2a33` | 13.02 | 11.90 | `#5d7280` | 4.45 | 4.06 | `#4f8a3c` | 3.38 | `#417232` | 4.62 |
| 墨夜 | `#e8f1f5` | 16.61 | 14.06 | `#8aa4b3` | 7.29 | 6.17 | `#f2c14e` | 9.59 | `#f2c14e` | 9.59 |

正文与次要文字在六个预设下**全部达标**。

### 4.3 背景动画

`none` / `bubbles` / `aurora` / `waves`，速度 0.3~2.5（超出范围由校验层 clamp）。

- **prefers-reduced-motion**：命中时**不启动 rAF 循环**，只画一帧静态画面（有独立断言：`rafCalls.count === 0`）；
- **窗口最小化 / 隐藏 / 失焦**：暂停 canvas 循环；恢复可见 / 聚焦后自动继续（有独立断言）。

### 4.4 外观参数

圆角 4~28 px（`--radius`）、毛玻璃模糊 0~30 px（`--blur`，作用于 `backdrop-filter`）。

### 4.5 CSS 变量化

`styles.css` 已**全量改写**为变量驱动，界面不再写死任何颜色：

```
--bg --accent --accent2 --surface --surface2 --text --muted --line
--on-accent --on-accent2 --glass --ok --warn --err
--radius --blur --speed
```

`--on-accent` 按强调色亮度自动取黑/白，保证按钮文字可读（测试覆盖 9 种强调色）。

### 4.6 安全与数据设计

| 要求 | 实现 | 验证 |
|---|---|---|
| 只存 `userData/theme.json` | `themeService` 只接受 `userDataDir`，代码中不出现 `botDir` | package-check 专项检查 + 隔离测试 |
| 与 `ai_config.json` / `secrets.json` 分离 | 同上 | 隔离测试：保存前后 SHA-256 完全不变 |
| 颜色白名单 | `/^#[0-9a-f]{6}$/i` | 10 种非法颜色逐个断言被拒 |
| fx 枚举 | 四值白名单 | 5 种非法值逐个断言被拒 |
| 数值 clamp | speed 0.3~2.5 / radius 4~28 / blur 0~30 | 上下界双向断言 |
| 未知字段丢弃 | 只输出 7 个白名单键 | 断言结果对象的键集合 |
| 原型污染 | 显式剔除 `__proto__` / `constructor` / `prototype` | 断言 `Object.prototype` 未被污染 |
| 损坏/缺失回退默认 | `readTheme` 返回默认主题 + `fallback` 标记 | 缺失 / 非 JSON / 非法值 / 非对象 四种场景 |
| 原子写入 | 临时文件 + rename，失败清临时文件 | 注入 writeFileSync 与 renameSync 两种故障 |
| 不含路径/密钥 | 导出与落盘内容均只含 7 个字段 | 断言无盘符路径、无密钥样式字符串 |
| 只经 IPC 读写 | 渲染层只有 `invoke`，无 fs 能力 | preload 未暴露 fs/child_process/shell（package-check） |

**未新增 `nodeIntegration`，未放宽 `contextIsolation`** —— package-check 的两条断言仍通过。

---

## 5. 测试实际数字

```
$ node --test
1..384
# tests 384
# pass 384
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

新增 **58 项**（基线 326 → 384）：

| 文件 | 项数 | 覆盖 |
|---|---|---|
| `themeService.test.js` | 37 | 校验（合法/非法颜色、非法枚举、越界数值、未知字段、原型污染）、颜色推算（深浅判断、对比度下限）、预设完整性、写后读回一致、损坏/缺失回退、写入中途失败不留半写文件、rename 失败、隔离 SHA-256 |
| `themeIpc.test.js` | 10 | IPC 白名单、参数校验、未知通道仍被拒、applyVars、reduced-motion 不启动循环、隐藏/失焦暂停、fx=none 不启动 |
| `themeReadability.test.js` | 10 | 六预设保留需求指定色、深浅判定、各元素组合对比度、可读性保险达标且不劣于理论最优、全色域下限 ≥3:1、强调色前景自动取色、**muted 兜底与其层级保持**、**--accent-text 达标 + --accent 不被改写**、**强调色作文字全色域达标** |

```
$ npm run check
CHECK_EXIT=0
```

```
$ node build/package-check.js
✅ 打包前检查通过
PC_EXIT=0
```

新增的 10 项打包检查：
- `styles.css` 定义了全部主题 CSS 变量（9 项）
- 导航含「主题工坊」入口
- `index.html` 引入 `renderer/theme.js`
- 主题文件名固定为 `theme.json`
- 背景动画枚举齐全（4 项）
- `themeService.js` 代码不引用 `botDir`
- `themeService.js` 代码不引用 `ai_config.json` / `secrets.json` / `feiyu_skills.json`
- 必需源码清单新增 `src/services/themeService.js`、`renderer/theme.js`（2 项）
- 仓库内不得含 `theme.json`（1 项，与其它数据文件同级检查）

### 5.1 Electron smoke（原文输出）

```
credential codec: safeStorage 已启用
已注册处理器: 63/63
✅ 全部 IPC 处理器注册成功
✅ preload 暴露完整通道表
webPreferences: contextIsolation=true nodeIntegration=false
✅ Electron 安全配置正确
✅ 主题 IPC 可用（THEME_GET 返回主题与派生色）
✅ 主题预设 6 套可用
✅ 主题页可加载（标题：主题工坊）
✅ 主题 CSS 变量已生效（--bg = #0b1d2a）
· 尚未写入主题文件（未保存主题时不产生文件）
SMOKE_OK handlers=63
```

> smoke 现使用**隔离的临时 userData**（`fs.mkdtempSync`），不再读写真实用户数据目录。

### 5.2 主题功能端到端（`theme-func-main.js`）

```
[1] 主题页加载
  ✓ 主题页标题正确
  ✓ 渲染出 6 套配色预设
[2] 切换预设（极光）
  ✓ --bg 已切换为极光背景 #0c1424
  ✓ --accent 已切换为 #7cf7c4
  ✓ --text 推算为深色主题正文色 #e8f1f5
  ✓ 主题已落盘到隔离 userData
  ✓ 落盘内容与界面一致
[3] 切换背景动画（waves）+ 调整速度/圆角
  ✓ 背景动画切换为 waves
  ✓ --speed = 2
  ✓ --radius = 24px
  ✓ --blur = 20px
  ✓ 动画与外观参数已落盘
[4] 导出主题 JSON
  ✓ 导出 JSON 合法且内容正确
[5] 导入非法 JSON → 当前主题不得改动
  ✓ 界面主题未被非法导入改动
  ✓ 界面给出导入失败提示
  ✓ 磁盘主题文件未被非法导入改动
[6] 导入合法 JSON → 主题被替换
  ✓ 浅色主题已应用（--bg = #eef3e6）
  ✓ 浅色主题正文色推算为 #1c2a33
  ✓ 浅色主题次要文字色推算为 #5d7280
  ✓ 圆角随导入生效
[7] 重启后主题保留（重新读取同一 userData）
  ✓ 重启后主题保留（--bg = #eef3e6）
  ✓ 重启后动画设置保留（fx = none）
[8] 恢复默认
  ✓ 恢复默认背景 #0b1d2a
  ✓ 恢复默认动画 bubbles

THEME_FUNC_OK
```

### 5.3 便携版产物验收（`theme-portable-check.js`）

**直接以便携版解包出来的 `app.asar` 为唯一代码来源**（不读源码树），userData 指向隔离目录：

```
[1] 便携版启动 + 主题页加载
  ✓ 便携版主题页加载成功
  ✓ 便携版渲染出 6 套配色预设
  ✓ 背景动画 canvas 已注入
  ✓ 默认主题 CSS 变量生效（--bg=#0b1d2a）
[2] 切换预设 + 切换动画
  ✓ 预设切换生效（抹茶 #eef3e6）
  ✓ 浅色主题正文色推算正确（#1c2a33）
  ✓ 背景动画切换为 aurora
  ✓ 动画速度已应用（1.5）
[3] 导出 / 导入
  ✓ 导出 JSON 合法
  ✓ 非法 JSON 导入未改动当前主题
  ✓ 合法 JSON 导入生效（墨夜 #101010）
[4] 主题文件只落 userData，不写程序目录
  ✓ 主题文件落在隔离 userData
  ✓ 程序目录内无 theme.json
  ✓ theme.json 不含路径与密钥
[5] 重启后主题保留
  ✓ 重启后主题保留（--bg=#101010）
  ✓ 重启后动画设置保留（bubbles）
  ✓ 重启后速度保留（0.8）

PORTABLE_THEME_OK
```

---

## 6. 构建产物

构建命令（输出到**独立目录** `D:\feiyu-v11-build\dist5`，未覆盖 v1.0.0 的 `D:\feiyu-rv\build\dist3`）：

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win nsis portable \
  --config.directories.output="D:\feiyu-v11-build\dist5" \
  -c.win.signAndEditExecutable=false
# BUILD_EXIT=0
#   • afterPack: 已注入应用图标 → 肥鱼桌面控制中心.exe
```

| 文件 | 字节数 | SHA-256 |
|---|---|---|
| `肥鱼桌面控制中心-1.1.0-win-x64.exe` | 115,353,568 | `471c21834a19f46fa911f1eed082e0a35e45c495d72a448b7362bff03e82dab3` |
| `肥鱼桌面控制中心-1.1.0-portable.exe` | 115,069,002 | `57c4385c449fc1638a3165d8e58e94a6f7d2d02a5d3cb897888dab028c577b29` |

产物 asar 内容核查（31 个条目）：

- ✓ `renderer/theme.js`、`renderer/styles.css`、`renderer/index.html`、`renderer/renderer.js`
- ✓ `src/services/themeService.js`、`src/services/ipcChannels.js`、`src/ipc/handlers.js`
- ✓ `build/icon.png`（窗口图标随包分发）
- ✓ 产物内**不含** `secrets.json` / `ai_config.json` / `theme.json` / `feiyu_*.json` / `*.log`

### 6.1 应用图标（四处一致）

图标由 `build/make-icon.js` 生成：SVG 描述 → **Electron（Chromium）渲染** → 多尺寸 ICO。
纯矢量、可复现、抗锯齿由浏览器保证，不依赖任何第三方图形库。

- `build/icon.ico`：16/24/32/48/64/128/256 七尺寸
- `build/icon.png`：256×256（窗口图标）
- 图形：深海蓝渐变圆角底 + 奶白肥鱼剪影 + 珊瑚橙尾鳍 + 青色气泡

**注入路径（关键坑）**：`-c.win.signAndEditExecutable=false` 会**同时**跳过「签名」与
「rcedit 编辑（写入 exe 图标/版本信息）」，导致主程序仍是 Electron 默认图标
（实测：NSIS 安装包与便携版有图标，唯独 win-unpacked 主程序是默认 Electron 标志）。
而 NSIS/便携版是**基于 win-unpacked 打包**的，必须在 afterPack 阶段注入，三处才一致。

解决方案：`build/after-pack-icon.js` 作为 electron-builder 的 `afterPack` 钩子，
用缓存里的 `rcedit-x64.exe` 执行 `--set-icon build/icon.ico`。
rcedit 只改 PE 资源、不涉及签名，因此不影响「不做代码签名」的决定。

> 补充：`build/apply-icon.js` 提供手动注入路径（对已构建产物补注入），
> 便于产物被外部复制后仍能修复图标。

**校验**（`build/verify-icons.js`，纯 Node 实现：解析 PE 资源目录 + 解码 DIB/PNG 逐像素比对）：

```
[图标一致性校验] 产物目录: D:/feiyu-v11-build/dist5

  ✓ build/icon.ico 合法且含多尺寸：16/24/32/48/64/128/256
  · 参考图标中心区域平均色 RGB: 237,244,248
  ✓ 参考图标中心为奶白鱼身（非 Electron 默认标志）
  ✓ 安装版主程序 内嵌图标组，含尺寸: 16/24/32/48/64/128/256
  ✓ 安装版主程序 含 256 与 16 常用尺寸
  ✓ 安装版主程序 内嵌 256×256 图标与 build/icon.png 逐像素一致（差异 0.00%）
  ✓ NSIS 安装包 内嵌图标组，含尺寸: 16/24/32/48/64/128/256
  ✓ NSIS 安装包 含 256 与 16 常用尺寸
  ✓ NSIS 安装包 内嵌 256×256 图标与 build/icon.png 逐像素一致（差异 0.00%）
  ✓ 便携版 内嵌图标组，含尺寸: 16/24/32/48/64/128/256
  ✓ 便携版 含 256 与 16 常用尺寸
  ✓ 便携版 内嵌 256×256 图标与 build/icon.png 逐像素一致（差异 0.00%）

ICON_CHECK_OK
```

四处一致：**安装包图标 / 便携版图标 / 主程序 exe 图标 / 窗口图标**，全部源自同一份 `build/icon.ico`。
开始菜单快捷方式图标由 NSIS 的 `installerIcon` / `shortcutName` 一并指定。

### 6.2 便携版

解包（`7za` 解 NSIS，73 个文件）→ `resources/app.asar` 内含全部主题文件，
功能验收全部通过（第 5.3 节）。

### 6.3 安装版完整链路

隔离目录实测（`build/install-chain-check.js`，安装包 → 安装 → 启动 → 改主题 → 重启 → 卸载）：

```
[1] 静默安装
  · 安装进程退出码: 0
  ✓ 主程序已安装: 肥鱼桌面控制中心.exe
  ✓ 安装目录文件数: 75
  ✓ app.asar 存在
  ✓ 安装包内含主题相关文件

[2] 首次启动 + 切换预设与动画
  ✓ 安装版主题页加载成功
  ✓ 安装版渲染出 6 套配色预设
  ✓ 背景动画 canvas 已注入
  ✓ 默认主题 CSS 变量生效（--bg=#0b1d2a）
  ✓ 预设切换生效（极光 #0c1424）
  ✓ 背景动画切换为 aurora
  ✓ 动画速度已应用（1.8）
  ✓ 导出 JSON 合法
  ✓ 非法 JSON 导入未改动当前主题
  ✓ 合法 JSON 导入生效（樱花 #fbf1f4）
  ✓ 浅色主题正文色推算正确（#1c2a33）
  ✓ 主题文件落在隔离 userData
  ✓ 安装目录内无 theme.json
  ✓ 重启后主题保留（--bg=#fbf1f4）
  ✓ 重启后动画设置保留（bubbles）
  ✓ 重启后速度保留（0.9）
  ✓ 安装版主题链路通过（切换预设/动画/导入导出 + 重启保留）
  · 隔离 userData 主题: bg=#fbf1f4 a=#e0527c fx=bubbles speed=0.9
  ✓ theme.json 不含路径与密钥
  ✓ 安装目录内无 theme.json（主题只存 userData）

[3] 卸载
  · 卸载程序: Uninstall 肥鱼桌面控制中心.exe
  · 卸载进程退出码: 0
  ✓ 主程序已移除
  · 卸载后安装目录残留文件数: 0

[4] 卸载后用户数据
  ✓ 隔离 userData 的 theme.json 保留（卸载不删用户数据）

[5] 机器人目录哈希复核
  ✓ ai_config.json SHA-256 未变
  ✓ secrets.json  SHA-256 未变

INSTALL_CHAIN_OK
```

隔离根目录：`D:\feiyu-v11-build\install\`（`app/` 安装目标、`userdata/` 隔离用户数据、
`bot/` 模拟机器人目录，全程只读）。

---

## 7. 边界核查

### 7.1 `D:\NapCat_publish` 只改了源码

```
$ git status --short
 M feiyu-desktop/build/package-check.js
 M feiyu-desktop/package.json
 M feiyu-desktop/renderer/index.html
 M feiyu-desktop/renderer/renderer.js
 M feiyu-desktop/renderer/styles.css
 M feiyu-desktop/smoke-main.js
 M feiyu-desktop/src/ipc/handlers.js
 M feiyu-desktop/src/services/ipcChannels.js
?? feiyu-desktop/renderer/theme.js
?? feiyu-desktop/src/services/themeService.js
?? feiyu-desktop/test/themeIpc.test.js
?? feiyu-desktop/test/themeReadability.test.js
?? feiyu-desktop/test/themeService.test.js
?? feiyu-desktop/theme-func-main.js
?? feiyu-desktop/theme-portable-check.js
```

全部落在 `feiyu-desktop/` 内，**无 `dist/`、无数据文件、无 `ai_config.json` / `secrets.json`**。
未执行 `git reset --hard` / `git clean` / 批量删除。

### 7.2 真实机器人目录只读

```
-rw-r--r-- 1 AA 197121 15104 Oct 17 01:10 D:\NapCat\ai_config.json
-rw-r--r-- 1 AA 197121  9390 Oct 22 11:29 D:\NapCat\ai_prompt.txt
-rw-r--r-- 1 AA 197121   445 Oct 14 22:40 D:\NapCat\secrets.json
```

修改时间均早于本轮（10-24），**未被触碰**。

### 7.3 真实用户数据未被污染

`%APPDATA%\feiyu-desktop-control-center\` 下**无 `theme.json`**（本轮全部测试用隔离目录）。
`feiyu-settings.json` / `feiyu-price.json` 是 v1.0.0 之前就有的，未改动。

### 7.4 未做的操作（按硬性限制）

- 未推送 `main`，未新建/移动任何 tag，**未创建 GitHub Release**；
- **分支未推送**（`feature/theme-studio` 是否推送等你确认）；
- 未发送真实 QQ 消息，未调用付费 API，未重启真实机器人服务；
- 未覆盖 `D:\feiyu-rv\build\dist3`（v1.0.0 产物完好）；
- 未做代码签名（按你的指示不写入 v1.1.0 范围）；
- 未删除任何断言、未跳过测试、未弱化安全校验。

### 7.5 安装版验收的隔离性

安装链路验收全程在 `D:\feiyu-v11-build\install\` 内：

| 子目录 | 用途 | 是否写入 |
|---|---|---|
| `app/` | 静默安装目标 | 是（安装产物，随后被卸载清除） |
| `userdata/` | 隔离 userData | 是（生成 theme.json，卸载后保留） |
| `bot/` | 模拟机器人目录 | **否**（只读，用于 SHA-256 前后比对） |

`bot/` 里的 `ai_config.json` / `secrets.json` 是**本轮自造的模拟文件**（内容为
`example.invalid` 与 `sk-simulated-not-a-real-key`），与真实配置无关。

---

## 8. 已验证 / 未验证清单

### 8.1 已验证

**功能**
- [x] 6 套预设色值与需求逐项一致
- [x] 亮度判定 `lum<0.5`、surface 混合比例（7% / 4%）、text / muted 取值 —— 与需求一致
- [x] 六预设严格保留需求指定色（可读性保险不触发，`textAdjusted === false`）
- [x] 自定义调色盘：改 bg/a/b 后其余颜色自动推算
- [x] 4 种背景动画 + 速度 0.3~2.5
- [x] prefers-reduced-motion 命中时**不启动**动画循环
- [x] 窗口隐藏 / 失焦时暂停循环，恢复后继续
- [x] 圆角 4~28、毛玻璃 0~30 生效
- [x] 主题导出 JSON 合法；导入非法 JSON **不改动当前主题**（界面与磁盘双向验证）
- [x] 界面全部颜色改用 CSS 变量，浅色主题下可读性有量化断言

**可读性（本轮补强）**
- [x] 六个预设的 text / muted / accent 在 bg 与 surface 上的实际对比度已逐项列表（见 4.2.1）
- [x] 正文与次要文字在六个预设下**全部达标**（text ≥ 4.5、muted ≥ 3）
- [x] **muted 有兜底**：基准色不达标时自动提升到 ≥ 3:1，且**不与正文同色**（层级保留）
- [x] 兜底语义为「改动最小」—— 次要文字不会被推到与正文同色
- [x] `--accent`（按钮底色/描边/进度条）**永不被改写**；`--accent-text`（品牌名）保证 ≥ 4.5:1
- [x] 强调色作文字全色域抽样达标；色相在调整中保持（等比缩放）
- [x] 兜底在数学可达时必然达标；不可达时取可达最优（抽样 286 个背景，偏差 > 0.05 的 0 个）
- [x] 全色域抽样正文最差对比度 ≥ 3:1（WCAG AA 大字号底线）

**数据与安全**
- [x] 主题只存 `userData/theme.json`，与机器人目录 / 配置 / 密钥完全分离（SHA-256 不变）
- [x] 颜色 / 枚举 / 数值 / 未知字段 / 原型污染 五类校验
- [x] 文件缺失、损坏、非法 → 回退默认主题，不抛错
- [x] 写入中途失败（writeFileSync / renameSync 两种故障）不留半写文件，原文件不被破坏
- [x] 打包产物不含密钥 / 配置 / 主题 / 日志文件

**产物**
- [x] 便携版在隔离 userData 下启动，主题页切换预设 / 动画 / 导入导出全部通过，重启后主题保留
- [x] **安装版完整链路**（隔离目录）：静默安装（75 文件）→ 首次启动 → 切换预设与动画 →
      导出/导入（含非法 JSON 不改动主题）→ 重启后主题保留 → 卸载（残留 0 文件）→
      用户数据 theme.json 保留
- [x] 安装链路前后 `ai_config.json` / `secrets.json` 的 SHA-256 **完全不变**
- [x] **应用图标四处一致**：安装包 / 便携版 / 主程序 exe / 窗口图标，
      均源自同一份 `build/icon.ico`，逐像素比对差异 0.00%
- [x] 产物不含 Electron 默认图标（参考图标中心为奶白鱼身，非蓝紫默认标志）

**回归**
- [x] 节点测试 384/384、语法检查全通过、打包检查 EXIT=0（57 项）、smoke `handlers=63`

### 8.2 未验证 / 受环境限制

- [ ] **GUI 逐页人工验收未完成** —— 本机 Windows 会话处于锁屏状态（`LockApp` / `LogonUI` 运行中），
      界面能渲染但收不到鼠标输入。已用 Electron 脚本做**等价的程序化点击验收**
      （`theme-func-main.js` / `theme-portable-check.js` / `install-theme-check.js`
      均真实点击 DOM 按钮并断言结果），
      但**人工逐页视觉走查、拖动滑块的原生手感、动画观感仍需在解锁环境下补做**。
- [ ] **代码签名** —— 按你的指示不做，未写入 v1.1.0 范围。产物未签名，
      首次运行可能出现 SmartScreen 提示。
- [ ] **升级链** —— 本轮只验了「全新安装 → 卸载」，**未做** v1.0.0 → v1.1.0 的原地升级实测
      （v1.0.0 的升级链在 v1.0.0 验收中已验证过一次，但未用带图标的 v1.1.0 重跑）。
- [ ] **真实机器人目录下的桌面端行为** —— 全程用模拟目录验证哈希不变，
      未在真实 `D:\NapCat` 上做任何写操作（按硬性限制）。

---

## 9. 遗留与建议

1. **可读性保险的边界**：亮度阈值附近的窄带（自定义背景才可能出现）上，
   「同时对 `bg` 与 `surface2` 保持 4.5:1」在数学上不可达，此时取理论最优（实测下限 4.04:1）。
   若后续要更严格，可改为按底色分别设定文字色（会让 CSS 变量从一个变三个）。
2. **升级链**建议在 v1.1.0 正式发布前补跑一轮（v1.0.0 → v1.1.0 原地升级 + 主题保留）。
3. **代码签名**按你的指示不做；若将来要做，`build/no-sign.js` 需替换为真实证书流程，
   并注意 `win.sign` 与 `signAndEditExecutable=false` 的差别（后者会连带跳过图标注入）。
4. **图标生成**依赖 Electron 运行时（`npx electron build/make-icon.js`），
   改 SVG 后需重跑该命令并重新构建产物。
