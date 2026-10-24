# 肥鱼桌面控制中心 V1.0 —— 最终发布验收报告

日期：2026-10-24　分支：`feature/feiyu-desktop-control-center`　基线：`dde513f`　本次提交：见文末

---

## 1. 当前状态

| 项 | 值 |
|---|---|
| Git 根目录 | `D:\NapCat_publish` |
| 分支 | `feature/feiyu-desktop-control-center` |
| 本轮起始 HEAD | `dde513f`（阶段 D） |
| 本轮结束 HEAD | `4a1f9c2`（见 §11） |
| 远端分支 | 已推送至 `origin/feiyu-ai-bridge` |
| **远端 main** | **未动**（`8226b9b`，与本轮开始时一致） |
| 版本号 | `0.1.0` → **`1.0.0`** |

---

## 2. `D:\NapCat_publish` 保护检查结论

### 2.1 两个目录的性质（已查明）

| 目录 | 性质 | 证据 |
|---|---|---|
| `D:\NapCat` | **真实运行目录**，非 Git 仓库 | 无 `.git`；含 `ai_bridge.js`(311KB) / `ai_config.json`(15KB) / `secrets.json`(445B) / `ai_prompt.txt`(9.4KB) |
| `D:\NapCat_publish` | **发布副本 / Git 镜像仓库** | 有 `.git`；含 `ai_bridge.js` / `feiyu-desktop/` 源码树 / `workflows/` / `memory/`（源码） |

**发布副本内不存在真实凭据与运行数据**：`secrets.json`、`ai_config.json`、`feiyu-settings.json`、
`feiyu_providers.json`、`feiyu_skills.json` 均**不存在**。`memory/` 与 `workflows/` 里是源码文件，不是运行数据。

### 2.2 为什么安装包会定位到发布副本（根因）

`botDirResolver.js` 的候选路径里**硬编码了 `NapCat_publish`**，且发布副本含 `ai_bridge.js`，
因此被 `isBotDir()` 判定为有效机器人目录：

```
安装版候选（修复前）:
  D:\feiyu\feiyu-desktop-control-center\resources\app.asar\bot
  ...
  D:\feiyu\NapCat_publish          ← 硬编码
  D:\NapCat_publish                ← 硬编码  ★ 实际命中这里（发布副本，不是工作目录）
  C:\Users\AA\NapCat_publish       ← 硬编码
```

同时便携版因候选全是硬编码路径而**定位失败**（`ok=false`）。

### 2.3 现场保留与影响范围

- 未执行 `git reset --hard` / `git clean` / 批量删除；未改动任何真实配置、记忆、日志、凭据。
- **真实机器人目录 `D:\NapCat` 全程只读**：本轮结束时 `ai_config.json`(10-17 01:10)、
  `secrets.json`(10-14 22:40)、`ai_prompt.txt`(10-22 11:29) 的修改时间均早于本轮（10-24），
  **未被本轮触碰**。
- **构建输出未写入发布副本**：本轮全部构建使用 `-c.directories.output=D:\feiyu-rv\build\dist*`，
  发布副本内的 `feiyu-desktop/dist/` 时间戳保持在本轮之前（13:57）。
- 本轮对发布副本的改动**仅限源码**（`git status` 已逐条核对，无敏感文件、无 `dist/`）。

### 2.4 隔离测试环境

```
D:\feiyu-rv\build\        构建输出（dist / dist2 / dist3）
D:\feiyu-rv\install\      安装/升级/卸载测试目标（app1 / app2 / app3 / app4 / upgrade / final）
D:\feiyu-rv\userdata\     模拟用户数据
D:\feiyu-rv\portable-*    便携版解包验证
```

---

## 3. 本轮发现并修复的缺陷

### P1-1【严重】botDir 硬编码发布副本，无法区分工作目录与副本

- **复现证据**（修复前）：
  ```
  安装版解析结果: ok=true botDir=D:\NapCat_publish   ← 错误（应为 D:\NapCat）
  便携版解析结果: ok=false botDir=(空)               ← 反而失败
  ```
- **影响**：桌面端自动把机器人工作目录指向**源码发布副本**。一旦用户在界面上做「应用 Provider」
  /「写人格」/「应用技能」，就会**在发布副本里生成 `ai_config.json` / `feiyu_providers.json` /
  `feiyu_skills.json` / `secrets.json`**，污染 Git 工作树，且用户不易察觉。
- **修复**：
  1. 删除候选路径里全部硬编码目录名（`NapCat_publish` 等），候选**全部由 appPath/execPath/home 推导**；
  2. 新增 `isSourceCheckout()`：含 `.git` 或 `feiyu-desktop/` 的目录判为**发布副本**，
     自动发现时**跳过**，用户显式指定时**仍允许**但打 `isCheckout` 标记并提示；
  3. 新增 `siblingCandidates()`：从 exe 目录向上最多 3 级扫描**兄弟目录**（通用做法，不依赖具体盘符）；
  4. `main.js` **不再把自动发现结果写入设置**（原先首启动即锁定可能错误的目录）；
  5. `BOTDIR_STATUS` 返回结构化状态（含 `isCheckout`），界面用**警告色**提示。
- **修复后实测**：
  ```
  安装版解析: ok=true botDir=D:\NapCat source=discovered_sibling isCheckout=false  ✅
  便携版解析: ok=true botDir=<真实工作目录>                                          ✅
  ```
- **回归测试**：`test/botDirResolver.test.js`(15) + `test/botDirFunctional.test.js`(15)，
  含「源码字面量检查」防止硬编码回流。

### P1-2【中】回滚会用递归删除处理非普通文件

- **复现**：`providerApplyService.restoreFrom` 在「本次新建的文件」路径上使用
  `fs.rmSync(dst, { recursive: true })`。当目标路径是**目录**时（异常状态），
  会递归删除整个目录树。
- **修复**：改为 `lstatSync` 判型 —— 只对**普通文件**用 `unlinkSync` 删除；
  目录/其它类型**跳过并如实报告** `skipped-not-a-regular-file`，不做递归删除。

### P2-1【中】迁移函数对「密文无法解密」给出误导性提示

- **原行为**：密钥库已是密文但解不开时，迁移返回 `already_encrypted`，
  用户看不出「为什么改不动」。
- **修复**：新增 `not_decryptable` 分支，明确说明「通常��换了 Windows 账户或机器，DPAPI 密钥不同，
  请从 `backups/` 恢复明文备份后重试」，且**绝不重写原文件**。

### P2-2【低】路径脱敏不覆盖正斜杠路径

- **原行为**：`winpath` 规则只匹配反斜杠路径，`D:/NapCat/secrets.json` 不会被脱敏；
  机器人核心 `LEAK_RULES.winpath` 同时接受两种分隔符，两端口径不一致。
- **修复**：改为 `[\\/]` 同时匹配，并排除两种分隔符本身；补 8 条回归测试。

### P2-3【低】`acceptance.test.js` 的 8a 用例断言的是缺陷本身

- 原断言硬编码期望定位到 `NapCat_publish`。
- **修复**：改为断言「定位到实际工作目录且不含硬编码目录名」——**没有删断言，是把断言改成正确契约**。

### 新增工具（无缺陷，但补齐能力）

- `build/installTestHelper.js` + `build/install-preflight.js`：卸载残留目录的**只读预检 / 受控清理** CLI。
- `build/verify-asar.js`：产物 asar 内容与「是否含密钥/数据/日志」的一次性校验器。

---

## 4. 各阶段验收结果

### 阶段 B — 升级链（**已验证**）

用**真实已发布产物** v0.1.0（从 GitHub Release 下载，115,191,514 字节，PE/NSIS 校验通过）
升级到本轮构建的 1.0.0：

| 步骤 | 结果 |
|---|---|
| ① 安装旧版 v0.1.0 | `EXIT=0`，74 文件 |
| ② 写入模拟用户数据 | 10 个文件（含 `feiyu-settings.json` / `feiyu_providers.json` / `feiyu-price.json` / 2 个标记文件），全部为**虚构内容** |
| ③ 安装新版 1.0.0 升级 | `EXIT=0`，74 文件，新 exe 就位 |
| ④ **用户数据保留** | **10/10 文件 SHA-256 逐个完全一致**（含 `feiyu-settings.json` `D23754C3…`、`feiyu_providers.json` `F886ACE0…`） |
| ⑤ 新版可启动 | `Preferences` 于运行期间被重写（14:38:35）→ 真实启动 |
| ⑥ IPC handlers 注册 | `build/verify-asar.js` 对已安装 asar 逐条断言通过；源码侧 `smoke-main.js` `SMOKE_OK handlers=57` |
| ⑦ **不覆盖真实机器人配置/凭据** | `D:\NapCat` 三个配置文件的修改时间均早于本轮，未被触碰 |
| ⑧ 失败恢复 | 切换失败 → 配置与凭据均回滚（原状）已由 `securityAudit.test.js` G-4 覆盖 |

**升级链未覆盖**：安装过程中断（断电/杀进程）后的恢复、跨版本降级安装。

### 阶段 C — GUI 安装向导（**部分验证 / 环境阻塞**）

**已验证（运行时实测）**：用 GUI 方式（非静默）启动安装器，NSIS 向导窗口真实打开并渲染：

- 窗口标题：`肥鱼桌面控制中心 安装`
- 控件齐全且文案正确：
  - 单选 `为使用这台电脑的任何人安装 (所有用户)` / `仅为我安装 (AA)` → 证实 `oneClick=false`（有向导）+ `perMachine=false`（per-user 选项存在）
  - 按钮 `下一步(N) >` / `取消(C)` / 最小化 / 关闭
- 关闭向导后确认**未产生任何安装**（默认位置不存在），无副作用。

**环境阻塞（未验证，不得冒充通过）**：本机会话处于**锁屏**状态
（`LockApp.exe` + `LogonUI.exe` 运行中，焦点窗口为「Windows 默认锁屏界面」）。
安装器窗口渲染在锁屏**之后**，鼠标输入被锁屏拦截 —— 实测点击「下一步」页面未推进。

因此以下项标记为 **未验证 / 环境阻塞**：
- 逐页点击流程（下一步 → 目录选择页 → 安装 → 完成页）
- 目录选择页的默认路径与「浏览」按钮
- 「取消」按钮的实际行为
- 安装失败时的回滚提示页

**人工验收步骤**（解锁后 2 分钟可完成）：
1. 双击 `肥鱼桌面控制中心-1.0.0-win-x64.exe`；
2. 选「仅为我安装 (AA)」→「下一步」；
3. 在目录页确认默认路径 `%LOCALAPPDATA%\Programs\feiyu-desktop-control-center`，可改；
4. 「安装」→ 完成后确认桌面快捷方式与「开始」菜单项；
5. 「卸载」→ 确认**用户数据保留**（`%APPDATA%\feiyu-desktop-control-center` 仍在）。

### 阶段 D — 便携版（**已验证**）

| 项 | 结果 |
|---|---|
| 产物存在 | ✅ `肥鱼桌面控制中心-1.0.0-portable.exe`，114,978,748 字节 |
| 格式 | ✅ MZ + PE 签名 + NSIS 标记 |
| 架构 | ✅ **内含应用 exe 为 x86-64**（`Machine=0x8664`，249,797,632 字节）；外层 NSIS stub 为 0x14c 属正常（NSIS stub 恒为 32 位） |
| 独立目录可启动 | ✅ 运行 45s 无错误；`Preferences` 于 14:43:39 被重写 → 真实启动 |
| app.asar 含本轮修复 | ✅ 10 项逐条断言通过（`ASAR_OK`） |
| 能正确定位机器人目录 | ✅ 便携版与 bot 同级 → `botDir=<同级工作目录>` `source=discovered_sibling`；与 bot 同盘根 → 同样命中 |
| 用户数据 / 程序目录边界清晰 | ✅ 程序目录内**无** `feiyu-settings` / `feiyu_providers` / `feiyu-price`；用户数据统一在 `%APPDATA%\feiyu-desktop-control-center` |
| 不依赖开发机绝对路径 | ✅ 产物内无硬编码路径（`verify-asar.js` 断言 + botDir 字面量检查） |
| 不会默认写入发布副本 | ✅ 便携版解包于 `%TEMP%`，其兄弟目录扫描**跳过**发布副本（有 `.git`） |

### 阶段 E — 真实 botDir 功能联调（**已验证，仅只读**）

覆盖任务书要求的四类场景，全部用临时模拟目录 + **真实目录只读检查**：

| 场景 | 结果 |
|---|---|
| ① 用户指定正常工作目录 | ✅ `ok=true` `source=settings` |
| ② 自动发现显示实际绝对路径 | ✅ 返回绝对路径且指向真实工作目录 |
| ③ 路径不存在 → 可理解的失败原因 | ✅ `reason=settings_dir_missing`，文案含「重新选择」 |
| ④ 权限不足 / 结构异常不静默误判 | ✅ 不可读 → `not_found` fail-closed；缺 `ai_bridge.js` → `ok=true` 但**带警告** |
| ⑤ 区分工作目录与发布副本 | ✅ 自动发现跳过副本；仅副本存在时 fail-closed；显式指定副本时标记 `isCheckout` |
| ⑥ **不硬编码 `D:\NapCat_publish`** | ✅ 源码字面量检查（排除注释）通过；候选无裸盘符根 |
| ⑦ 找不到时不自动创建/覆盖/清理 | ✅ 探测前后目录列表逐项比对，完全一致 |
| ⑧ BOTDIR_STATUS 与 UI 一致 | ✅ 返回 `configured/exists/hasCore/isCheckout/message`，界面同源渲染（警告色） |
| ⑨ 探测不泄漏敏感信息 | ✅ 返回结构无 key/token/secret 字段名；warning 无密钥样式字符串 |

真实目录只读检查：`D:\NapCat` → `isSourceCheckout=false`、`isBotDir=true`；
`D:\NapCat_publish` → `isSourceCheckout=true`（正确判为副本）。

### 阶段 F — 重装残留目录（**已验证**）

- **残留现象已复现**：NSIS 卸载后安装目录**保留为空目录**（0 条目）——NSIS 无法删除自身所在目录，属标准行为。
- **重装实测**：在残留空目录上重装 → `EXIT=0`、74 文件、exe 完整（连续 5 轮，含「卸载后立刻重装」与「运行中卸载」变体，**均成功**）。
  **本轮未能复现历史上的 `EXIT=1`**，不将其写成「已修复」。
- **防护措施已实现并测通**（`build/installTestHelper.js` + `install-preflight.js`）：
  - 只在**确认目录确实为空**时才允许清理；
  - **绝不递归删除**含数据的目录（非空 → 拒绝并列出条目）；
  - **绝不**处理受保护目录（`NapCat` / `NapCat_publish` / `feiyu` / 安装目录自身 / 文件系统根）；
  - 不可读 → **fail-closed**，不调用任何删除；
  - 删除用 `rmdirSync`（非递归），清理后**可重复执行**；
  - `PROTECTED_NAMES` + `isProtectedDir` 钩子可扩展。
- **回归测试**：`test/installTestHelper.test.js`（14 项，覆盖空目录 / 非空 / 权限不足 / 路径异常 / 受保护 / 可重复执行）。

---

## 5. 自动化测试、打包检查与 Smoke Test 实际输出

```
$ node --test
# tests 326
# pass 326
# fail 0
# skipped 0

$ node --check（src/main.js, preload.js, ipc/handlers.js, src/services/*.js,
                renderer/renderer.js, build/*.js, smoke-main.js,
                ../ai_bridge.js, ../skills.js, ../usage_report.js）
全部通过（0 错误）

$ node build/package-check.js
✅ 打包前检查通过          EXIT=0   （38 项，1 项非阻断警告：未启用 renderer sandbox）

$ electron smoke-main.js
credential codec: safeStorage 已启用
已注册处理器: 57/57
✅ 全部 IPC 处理器注册成功
✅ preload 暴露完整通道表
webPreferences: contextIsolation=true nodeIntegration=false
✅ Electron 安全配置正确
SMOKE_OK handlers=57       EXIT=0

$ npx electron-builder --win nsis portable \
    -c.win.signAndEditExecutable=false \
    -c.directories.output=D:\feiyu-rv\build\dist3
EXIT=0
```

### 测试数量变化

| 阶段 | 项数 |
|---|---|
| 本轮开始（`dde513f`） | 248 |
| 本轮新增 | **+78** |
| 本轮结束 | **326** |

新增文件：
`test/botDirResolver.test.js`(15)、`test/botDirFunctional.test.js`(15)、
`test/installTestHelper.test.js`(14)、`test/securityAudit.test.js`(26)、
`test/redact.test.js`(+8)、`test/acceptance.test.js`(8a 改为正确契约)。

---

## 6. 最终产物

| 产物 | 绝对路径 | 大小 | SHA-256 | 版本 | 架构 | 构建时间 |
|---|---|---|---|---|---|---|
| **NSIS 安装包** | `D:\feiyu-rv\build\dist3\肥鱼桌面控制中心-1.0.0-win-x64.exe` | 115,206,614 字节 | `c00b34d0505cad63d94431178b4091144f2856179a5bf25b8025da0b7ac42285` | 1.0.0 | x86-64 | 2026-10-24 15:26:27 |
| **便携版** | `D:\feiyu-rv\build\dist3\肥鱼桌面控制中心-1.0.0-portable.exe` | 114,978,748 字节 | `75cca749a04e0d86ada99665c37b972507beb35d8c8854c635bd18ba2f704396` | 1.0.0 | x86-64（内含应用） | 2026-10-24 15:26:30 |
| 免安装目录 | `D:\feiyu-rv\build\dist3\win-unpacked\` | app.asar 246,600 字节 | — | 1.0.0 | x86-64 | 2026-10-24 15:26 |
| 增量元数据 | `…-win-x64.exe.blockmap` | 120,357 字节 | — | — | — | — |

**产物内 app.asar 内容校验（`node build/verify-asar.js`）——对 win-unpacked / 已安装副本 / 便携版解包产物三处均为 `ASAR_OK`：**

```
✅ P1 botDir 修复(副本识别+兄弟目录扫描)
✅ 路径脱敏(含正斜杠)
✅ IPC 结构化状态 + 新通道
✅ 不再自动把发现目录落盘
✅ 技能服务 / ✅ ComfyUI 服务 / ✅ 渲染层两个新页面 / ✅ 导航入口
✅ botDirResolver 代码中无硬编码 NapCat_publish
✅ 不含密钥/配置/用户数据文件   ✅ 不含日志文件
```

**最终安装→卸载实测**（`D:\feiyu-rv\install\final`）：
安装 `EXIT=0` / 74 文件 / exe 与卸载器就位 / 版本读出 `1.0.0` / 架构 `0x8664`；
卸载 `EXIT=0` / 安装目录剩 0 条目 / **11 个用户数据文件 SHA-256 全部不变**。

---

## 7. 用户数据与凭据保护边界

| 边界 | 状态 |
|---|---|
| 安装 / 升级 / 卸载不删用户数据 | ✅ 实测 11 个文件哈希不变 |
| 用户数据与程序目录分离 | ✅ `%APPDATA%\feiyu-desktop-control-center` vs 安装目录 |
| `nsis.deleteAppDataOnUninstall=false` | ✅ 配置已设 + package-check 校验 |
| 桌面端密钥不进普通导出 | ✅ `buildExport` 默认无 `secret` 段 |
| IPC 不回传明文密钥 | ✅ `SECRET_READ` 只返掩码 + 存在性；`SECRET_WRITE` 字段白名单 |
| 密钥可迁到系统凭据存储 | ✅ `safeStorage`(DPAPI)；迁移带备份/校验/回滚，幂等 |
| 密钥不可解密时写操作全阻断 | ✅ 4 条写路径逐一阻断，磁盘密文**一字节未变** |
| 孤儿密钥清理 fail-closed | ✅ 注册表缺失/损坏/为空且密钥非空 → 一律拒绝 |
| 技能不能执行任意代码 | ✅ handler 白名单 10 项；`remember` 刻意排除 |
| 下载源白名单 | ✅ 仅 GitHub 官方 Releases 与已登记 HF 仓库；8GB 上限 + 完整性校验 |
| 打包产物不含真实配置/密钥/日志/开发机私有文件 | ✅ `ASAR_OK` + package-check 第 11 项 |
| 不硬编码发布副本 | ✅ 源码字面量检查 + 运行时实测定位到 `D:\NapCat` |

---

## 8. 未验证事项与环境限制

| # | 项 | 分类 | 原因 / 需要的人工动作 |
|---|---|---|---|
| 1 | GUI 向导逐页点击（目录选择页 / 安装页 / 完成页 / 取消流程） | **环境阻塞** | 会话锁屏（`LockApp.exe`+`LogonUI.exe`），输入被锁屏拦截。解锁后按 §4 阶段 C 的 5 步人工清单验收 |
| 2 | 安装过程被强制中断（断电/杀进程）后的恢复 | 未验证 | 需人为制造中断，风险与收益不匹配 |
| 3 | 跨版本降级安装（1.0.0 → 0.1.0） | 未验证 | 官方不支持降级 |
| 4 | 代码签名 / SmartScreen 提示 | 未配置 | 需证书（OV/EV），当前安装包**未签名**，用户会看到「未知发布者」 |
| 5 | 应用图标 | 未配置 | electron-builder 用默认 Electron 图标（构建日志已提示 `default Electron icon is used`） |
| 6 | 真实 `botDir` **功能**联调（改配置/启停服务/发消息） | 按要求未做 | 任务书限定只验证路径发现与界面状态；真实机器人未重启、未发 QQ 消息、未调付费 API |
| 7 | 真实凭据迁移（DPAPI 落盘） | 按要求未做 | 任务书禁止执行真实凭据迁移；全流程用临时目录 + 假 codec 测通 |
| 8 | `renderer sandbox` 未启用 | 已知限制 | preload 需 require 本地模块；已静态断言 preload 不暴露 `fs`/`child_process`/`shell` |
| 9 | 5GB 级 ComfyUI 模型实际下载 | 未验证 | 只做 HEAD 探测 + 字节数比对；下载逻辑用 mock 全流程测通 |
| 10 | UI 自动化回归（界面层） | 未覆盖 | 无 UI 测试框架；界面功能由 IPC 层与服务层测试间接覆盖 |
| 11 | 历史 `EXIT=1` 重装失败 | **未能复现** | 连续 5 轮重装（含残留空目录、立即重装、运行中卸载）全部 `EXIT=0`。已提供预检/受控清理 CLI 作为防护 |

---

## 9. 交付清单

**已交付并实测通过**
- ✅ NSIS 安装包 x64（115,206,614 字节，SHA-256 `c00b34d0…`）
- ✅ 便携版 x64（114,978,748 字节，SHA-256 `75cca749…`）
- ✅ 免安装目录 `win-unpacked/`
- ✅ 真实旧版 → 新版升级链（用户数据 10/10 哈希一致）
- ✅ 安装 / 启动 / 卸载全流程（用户数据 11/11 哈希不变）
- ✅ 便携版解包启动 + asar 内容校验 + botDir 定位
- ✅ P1 修复：botDir 不再指向发布副本，能区分工作目录/副本
- ✅ 阶段 G 安全回归 26 项 + botDir 功能 15 项 + 残留目录 14 项 + botDir 回归 15 项
- ✅ 自动化测试 **326/326**、package-check 38 项、Smoke 57 handlers
- ✅ 使用说明 `docs/USER_GUIDE.md`（12 章）、本报告

**明确未交付 / 需人工**
- ⛔ GUI 向导逐页点击验收（会话锁屏阻塞，见 §8-1）
- ⛔ 代码签名与应用图标
- ⛔ GitHub Release 发布（本轮明确不发布）、未推送 main

---

## 10. 最终发布判断

### **有限条件可交付（Conditional Release）**

**理由**：本轮修掉 1 个 P1 严重缺陷（botDir 硬编码发布副本，具备污染 Git 工作树的实质风险）
并完成升级链 / 便携版 / 安装卸载 / 安全回归的全链路实测；
但 **GUI 安装向导的逐页交互验收因会话锁屏无法完成**，且安装包**未签名**。

### P0 / P1 问题状态

| 级别 | 数量 | 说明 |
|---|---|---|
| **P0（阻断发布）** | **0** | 无数据丢失、无凭据泄漏、无越权、无发布副本污染风险残留 |
| **P1（严重）** | **0（已修）** | 本轮发现 1 个 P1（botDir 硬编码发布副本）→ 已修复 + 30 项回归测试 + 运行时实测验证；另有 1 个 P1 级回滚缺陷 → 已修 |
| **P2** | 3 个已修 | 回滚递归删除、迁移误导提示、正斜杠路径脱敏 |
| **遗留 P3/建议** | 3 项 | 图标、签名、UI 自动化回归 |

### 放行条件（建议）

1. 解锁桌面会话后按 §4 阶段 C 的 5 步完成 GUI 向导人工验收（预计 2 分钟）；
2. 面向外部用户发布前配置**代码签名**（消除 SmartScreen「未知发布者」）；
3. 补一个应用图标（当前是默认 Electron 图标）。

三项均为**发布后体验/流程项**，不影响数据安全与功能正确性。

---

## 11. 变更文件清单

```
新增：
  feiyu-desktop/build/installTestHelper.js         卸载残留目录的判定/受控清理（纯逻辑）
  feiyu-desktop/build/install-preflight.js         重装前预检 CLI
  feiyu-desktop/build/verify-asar.js               产物 asar 内容校验器
  feiyu-desktop/test/botDirResolver.test.js        P1 回归（15）
  feiyu-desktop/test/botDirFunctional.test.js      阶段 E 功能联调（15）
  feiyu-desktop/test/installTestHelper.test.js     阶段 F 回归（14）
  feiyu-desktop/test/securityAudit.test.js         阶段 G 安全回归（26）

修改：
  feiyu-desktop/src/services/botDirResolver.js     P1 核心修复（去硬编码 + 副本识别 + 兄弟目录扫描）
  feiyu-desktop/src/main.js                        不再自动落盘 botDir
  feiyu-desktop/src/ipc/handlers.js                BOTDIR_STATUS 结构化 + isCheckout
  feiyu-desktop/renderer/renderer.js               警告色展示
  feiyu-desktop/renderer/styles.css                .warn 样式
  feiyu-desktop/src/services/redact.js             正斜杠路径脱敏
  feiyu-desktop/src/services/providerApplyService.js 回滚只删普通文件
  feiyu-desktop/src/services/providerService.js    迁移 not_decryptable 分支
  feiyu-desktop/package.json                       version 0.1.0 → 1.0.0
  feiyu-desktop/test/acceptance.test.js            8a 断言改为正确契约
  feiyu-desktop/test/redact.test.js                +8 条脱敏回归
```

**未改动**：`ai_bridge.js`（机器人核心本轮零改动）、`D:\NapCat` 真实运行目录（全程只读）、
`main` 分支、未发布任何 Release。
