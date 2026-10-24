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
| `node --test` | 326 / 326 通过 | **380 / 380 通过**（+54） |
| `node --check` | 全通过 | 全通过 |
| `build/package-check.js` | EXIT=0（38 项） | EXIT=0（**48 项**） |
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

## 3. 改动文件

| 文件 | 改动 |
|---|---|
| `src/services/ipcChannels.js` | 新增 6 个主题通道 + 参数校验（未知通道仍被拒） |
| `src/ipc/handlers.js` | 注册 6 个主题处理器（只读 `getUserDataDir()`，不碰 botDir） |
| `renderer/index.html` | 导航加「主题工坊」入口；引入 `theme.js` |
| `renderer/styles.css` | **全量改用 CSS 变量**，新增主题工坊样式；新增 `#bgCanvas` 动画画布层 |
| `renderer/renderer.js` | 新增「主题工坊」页；启动时先加载主题再渲染首页 |
| `build/package-check.js` | 新增文件纳入打包检查；新增 7 项主题专项检查 |
| `smoke-main.js` | 隔离 userData；新增主题 IPC / 主题页 / CSS 变量冒烟断言 |
| `package.json` | 版本 1.0.0 → **1.1.0**；`check` 脚本纳入两个新文件 |
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
2. 不达标 → 在「朝纯白混合」与「朝纯黑混合」的候选里，挑**最差对比度最大**的那一个。

已验证该保险的结果**不劣于暴力搜索得到的理论最优值**（抽样 286 个不达标背景，偏差 > 0.05 的：**0** 个）。
六个内置预设**全部保留需求指定的原色**（有独立断言：`textAdjusted === false`）。

全色域抽样（256³ 中每 5 取 1）实测，正文对三种底色的最差对比度 **≥ 3:1**（WCAG AA 大字号底线）。

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
1..380
# tests 380
# pass 380
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

新增 **54 项**（基线 326 → 380）：

| 文件 | 项数 | 覆盖 |
|---|---|---|
| `themeService.test.js` | 37 | 校验（合法/非法颜色、非法枚举、越界数值、未知字段、原型污染）、颜色推算（深浅判断、对比度下限）、预设完整性、写后读回一致、损坏/缺失回退、写入中途失败不留半写文件、rename 失败、隔离 SHA-256 |
| `themeIpc.test.js` | 10 | IPC 白名单、参数校验、未知通道仍被拒、applyVars、reduced-motion 不启动循环、隐藏/失焦暂停、fx=none 不启动 |
| `themeReadability.test.js` | 6 | 六预设保留需求指定色、深浅判定、各元素组合对比度、可读性保险不劣于理论最优、全色域下限 ≥3:1、强调色前景自动取色 |

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

构建命令（输出到**独立目录**，未覆盖 v1.0.0 的 `D:\feiyu-rv\build\dist3`）：

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win nsis portable \
  --config.directories.output="D:\feiyu-v11-build\dist" \
  -c.win.signAndEditExecutable=false
# BUILD_EXIT=0
```

| 文件 | 字节数 | SHA-256 |
|---|---|---|
| `肥鱼桌面控制中心-1.1.0-win-x64.exe` | 115,216,161 | `78f36c2d9c57d7b3eef5046b3591e7ff058439799211287f617c96a43339de8a` |
| `肥鱼桌面控制中心-1.1.0-portable.exe` | 114,988,292 | `cbc4620e0b97c65120c0016dbb2485e0c73316cc545a701a3f9d4d63ad8e4a44` |

产物 asar 内容核查（30 个条目）：

- ✓ `renderer/theme.js`、`renderer/styles.css`、`renderer/index.html`、`renderer/renderer.js`
- ✓ `src/services/themeService.js`、`src/services/ipcChannels.js`、`src/ipc/handlers.js`
- ✓ 产物内**不含** `secrets.json` / `ai_config.json` / `theme.json` / `feiyu_*.json` / `*.log`

便携版解包（`7za` 解 NSIS，73 个文件）→ `resources/app.asar` 内含全部主题文件，
`肥鱼桌面控制中心.exe` 可启动，功能验收全部通过（第 5.3 节）。

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
- 未发送真实 QQ 消息，未调用付费 API，未重启真实机器人服务；
- 未覆盖 `D:\feiyu-rv\build\dist3`（v1.0.0 产物完好）；
- 未删除任何断言、未跳过测试、未弱化安全校验。

---

## 8. 已验证 / 未验证清单

### 8.1 已验证

- [x] 6 套预设色值与需求逐项一致
- [x] 亮度判定 `lum<0.5`、surface 混合比例（7% / 4%）、text / muted 取值 —— 与需求一致
- [x] 六预设严格保留需求指定色（可读性保险不触发）
- [x] 自定义调色盘：改 bg/a/b 后其余颜色自动推算
- [x] 4 种背景动画 + 速度 0.3~2.5
- [x] prefers-reduced-motion 命中时**不启动**动画循环
- [x] 窗口隐藏 / 失焦时暂停循环，恢复后继续
- [x] 圆角 4~28、毛玻璃 0~30 生效
- [x] 主题导出 JSON 合法；导入非法 JSON **不改动当前主题**（界面与磁盘双向验证）
- [x] 界面全部颜色改用 CSS 变量，浅色主题下可读性有量化断言
- [x] 主题只存 `userData/theme.json`，与机器人目录 / 配置 / 密钥完全分离（SHA-256 不变）
- [x] 颜色 / 枚举 / 数值 / 未知字段 / 原型污染 五类校验
- [x] 文件缺失、损坏、非法 → 回退默认主题，不抛错
- [x] 写入中途失败（writeFileSync / renameSync 两种故障）不留半写文件，原文件不被破坏
- [x] 打包产物不含密钥 / 配置 / 主题 / 日志文件
- [x] 便携版在隔离 userData 下启动，主题页切换预设 / 动画 / 导入导出全部通过，重启后主题保留
- [x] 节点测试 380/380、语法检查全通过、打包检查 EXIT=0、smoke `handlers=63`

### 8.2 未验证 / 受环境限制

- [ ] **GUI 逐页人工验收未完成** —— 本机 Windows 会话处于锁屏状态（`LockApp` / `LogonUI` 运行中），
      界面能渲染但收不到鼠标输入。已用 Electron 脚本做**等价的程序化点击验收**
      （`theme-func-main.js` / `theme-portable-check.js` 均真实点击 DOM 按钮并断言结果），
      但**人工逐页视觉走查、拖动滑块的原生手感、动画观感仍需在解锁环境下补做**。
- [ ] **代码签名** —— 本轮产物未签名（`signAndEditExecutable=false`），首次运行可能出现 SmartScreen 提示。
- [ ] **应用图标** —— 仍为 Electron 默认图标（构建日志：`default Electron icon is used`）。
- [ ] **Windows 真实安装版的主题行为** —— 本轮只验了便携版产物；安装版走同一套 `theme.json` 路径，
      但未做「安装 → 运行 → 升级 → 卸载后主题保留」的完整链路实测。

---

## 9. 遗留与建议

1. **可读性保险的边界**：亮度阈值附近的窄带（自定义背景才可能出现）上，
   「同时对 `bg` 与 `surface2` 保持 4.5:1」在数学上不可达，此时取理论最优（实测下限 4.04:1）。
   若后续要更严格，可改为按底色分别设定文字色（会让 CSS 变量从一个变三个）。
2. **安装版链路**建议在 v1.1.0 正式发布前补做，与 v1.0.0 的升级/卸载验收合并跑一轮。
3. **图标与签名**是 v1.0.0 就遗留的待办，本轮未处理。
