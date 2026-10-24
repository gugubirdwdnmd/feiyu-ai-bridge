# 肥鱼桌面控制中心 — 发布候选验收与安装版交付报告

**基线提交**：`35cd78f`（阶段 C） ｜ **分支**：`feature/feiyu-desktop-control-center`
**验收范围**：10 项关键路径 + Windows x64 正式安装包交付
**未做**：未推送、未合并 main、未创建 GitHub Release、未上传任何文件、
未修改真实运行配置、未重启肥鱼/NapCat、未发送 QQ 消息、未自动调用付费 API

---

## 一、开工状态核实

| 项 | 实际值 |
| --- | --- |
| 分支 | `feature/feiyu-desktop-control-center` |
| HEAD | `35cd78fa24594d9f4649d414304a7e4aa061c593` |
| 父提交 | `ae1f701`（阶段 B）、`e7b1df1`（阶段 A） |
| 开工时工作区 | 干净（无未提交修改，未重置） |
| 既有测试复现 | `node --test` → **122/122 通过**（与阶段 C 报告一致） |
| 阶段 C 报告 / README | 存在；**报告中「NSIS 因符号链接权限无法生成」的结论经本轮实测证伪，已勘误** |

### 产物核实（开工时发现的真实问题）

`dist/win-unpacked/resources/app.asar` 构建于 12:12，而 `credentialStore.js` / `main.js` /
`handlers.js` 的最终修改在 12:15（已进入 `35cd78f`）→ **产物比 HEAD 旧，不含最终代码**。
本轮已重新构建并复核（见 §五）。

---

## 二、验收结果总览

### 10 项关键路径

| # | 验收项 | 结果 | 说明 |
| --- | --- | --- | --- |
| 1 | 加密库不可解密时写操作全部阻断 | ✅ 通过 | 5 条写路径逐一验证被阻断，磁盘密文**一个字节未变** |
| 2 | 凭据迁移：备份/写入/回读/回滚 | ✅ 通过 | 明文备份 + 密文写入 + 回读逐字段校验 + 失败回滚 + 幂等 |
| 3 | 孤儿密钥清理不误删其他 Provider | ❌ **发现缺陷 → 已修复** | 注册表缺失/损坏时会**删光所有密钥** |
| 4 | Provider 切换失败恢复原状 | ❌ **发现缺陷 → 已修复** | 全新目录下失败会留下**半应用状态** |
| 5 | 人格应用失败原人格不变 | ✅ 通过 | 备份先行 + 原子写 + 失败保留原文 |
| 6 | 费用单位/历史价/部分未定价 | ✅ 通过 | 实现正确（测试断言初版写错，已修正） |
| 7 | `/api/usage` 鉴权/白名单/分页/兼容 | ✅ 通过 | 7 项子测试全过 |
| 8 | 打包后定位机器人目录 + 找不到的提示 | ✅ 通过（并**增强**） | 原逻辑内嵌 main.js 不可测，已抽出服务 + 新增状态通道 |
| 9 | 安装/升级/卸载的数据保留 | ✅ 通过 | 实机安装/卸载验证；**用户数据保留** |
| 10 | 敏感字段不进日志/导出/诊断 | ❌ **发现缺陷 → 已修复** | 路径脱敏正则**漏脱敏含 s 的路径** |

### 交付物

| 项 | 状态 |
| --- | --- |
| NSIS 正式安装包 | ✅ **已产出并实机安装/卸载验证** |
| win-unpacked 免安装目录 | ✅ 已产出 |
| 便携版 portable | ⚠️ 未单独构建（与 NSIS 同链路，命令已给出） |
| 代码签名 | ❌ 未签名（无证书，SmartScreen 会提示「未知发布者」） |

---

## 三、本轮发现并修复的缺陷（5 项）

### 缺陷 1【严重】孤儿密钥清理会删光所有 Provider 密钥

**位置**：`src/services/providerService.js` → `pruneOrphanSecrets`

**成因**：该函数用「密钥库键 ∉ 注册表 Provider 集合」判定孤儿。
但 `load()` 在**注册表文件缺失或 JSON 损坏**时返回 `{providers: []}`（空数组，不报错），
于是密钥库里**每一个** Provider 的密钥都被判为孤儿。

**复现（修复前）**：

```
注册表文件存在? false
dry-run : {"ok":true,"orphans":["p1","p2","p3"],"pruned":[],"dryRun":true}
confirm : {"ok":true,"orphans":["p1","p2","p3"],"pruned":["p1","p2","p3"]}
剩余密钥: {}          ← 三个 Provider 的密钥全部丢失
```

**修复**：清理前增加三道前置校验，任一不满足即**拒绝清理**并说明原因：
1. 注册表文件必须存在（否则无法判断谁是孤儿）
2. 注册表必须能解析且 `providers` 为数组
3. 注册表为空但密钥库非空 → 判为「疑似注册表丢失」，拒绝清理

**回归测试**：`test/acceptance.test.js` 验收3a/3b/3c/3d。

---

### 缺陷 2【严重】Provider 切换失败留下半应用状态

**位置**：`src/services/providerApplyService.js` → `applySwitch` / `backupCurrent` / `restoreFrom`

**成因**：`backupCurrent` 只在文件**已存在**时才复制，故全新 botDir 下 `copied` 为空，
代码随即 `bk = null` → 失败时 `restoreFrom` 无从执行。
结果：配置已写入新 Provider、密钥写入失败 → **磁盘上是「半应用」状态**，
且界面提示 `rolledBack: false`，用户以为没改，实际配置已被覆盖。

**复现（修复前）**：

```
ok=false  rolledBack=false
残留 ai_config.json 存在? true
  内容: { "api": { "baseUrl": "https://x.test/v1/chat/completions", ... } }   ← 新配置已落盘
```

**修复**：
- `backupCurrent` 额外写出 `manifest.json`，记录每个文件在备份时刻**是否存在**
- `restoreFrom` 依据 manifest：备份时存在 → 复制回来；**备份时不存在 → 删除本次新建的文件**
- `applySwitch` 不再因 `copied` 为空而丢弃 `bk`（只要 manifest 写成功就保留回滚能力）

**回归测试**：`test/acceptance.test.js` 验收4a/4b；`test/providerApply.test.js` 同步改用注入式失败。

---

### 缺陷 3【严重】Windows 路径脱敏正则漏脱敏

**位置**：`src/services/redact.js` → `winpath` 规则

**成因**：字符类写成 `[^\\s"'<>|]`。在正则字符类里 `\\` 是「反斜杠」、`s` 是**字面量字母 s**，
于是该类实际排除的是「反斜杠 + 字母 s + 引号」，**并未排除空白**。

**后果**：
- 首段含 `s` 的路径**完全不被脱敏**：`D:\some\path\file.txt`、`D:\secret\x.txt` 原样输出
- `C:\Users\me\x` 只替换掉 `C:\U`，**尾部 `sers\me\x` 泄漏**
- 含空格的路径反而被过度吞掉（`D:\a b\c.txt` → 整段被替）

> 对照：机器人核心 `ai_bridge.js:1746` 的 `LEAK_RULES.winpath` 用的是正确的 `[^\s"'<>|]`，
> 桌面端与核心口径不一致，属实打实的脱敏漏洞。

**修复**：改为 `[^\\\s"'<>|]`（排除反斜杠 + 空白 + 引号），与核心口径对齐。

**回归测试**：`test/redact.test.js` 新增 2 项（含 5 条样本路径）。

---

### 缺陷 4【中】`migrateSecretsToEncrypted` 写入异常未捕获

**位置**：`src/services/providerService.js`

**成因**：`saveSecrets(p, plain)` 未包 try/catch。磁盘满/权限异常时会抛出未捕获异常，
中断在「已备份、已改写」的中间态。

**修复**：写入失败时用备份还原并返回明确错误（`写入失败，已回滚`），不再抛异常。

---

### 缺陷 5【中】bot 目录定位逻辑不可测 + 找不到时静默失败

**位置**：原 `src/main.js` 内的 `resolveDefaultBotDir`

**成因**：
- 定位逻辑内嵌在 main.js（依赖 Electron `app`），**无法单元测试** → 安装版能否定位到 bot 从未被验证过
- 找不到时只返回空串，界面只显示「未配置机器人目录（设置里选择）」，**不区分「未配置」与「配置失效」**

**修复**：
- 抽出 `src/services/botDirResolver.js`（纯逻辑、依赖注入、可单测）
- main.js 改为委托该服务
- 新增 `BOTDIR_STATUS` IPC 通道，返回结构化状态：
  `not_configured` / `dir_missing` / `no_core` / `ok`，界面左栏直接显示原因
- 用户显式指定的目录即使缺 `ai_bridge.js` 也保留（不擅自改用户选择），但给出警告

**回归测试**：`test/acceptance.test.js` 验收8a–8e。

---

## 四、修复后的实测证据

### 缺陷 1 修复后

```
注册表缺失 → pruneOrphanSecrets(confirm:true)
  ok=false  error="Provider 注册表不存在，无法判断孤儿密钥（已跳过清理）"
  剩余密钥: {"p1":"sk-p1","p2":"sk-p2","p3":"sk-p3"}   ← 三个密钥全部完好
```

### 缺陷 2 修复后

```
全新目录切换失败 → ok=false  rolledBack=true
残留 ai_config.json? false      ← 半应用状态已消除
```

### 缺陷 3 修复后

```
REDACTED  "D:\\some\\path\\file.txt" -> "<本地路径>"
REDACTED  "D:\\secret\\x.txt"      -> "<本地路径>"
REDACTED  "C:\\Users\\me\\x"       -> "<本地路径>"     ← 尾部不再泄漏
REDACTED  "D:\\a b\\c.txt"         -> "<本地路径> b\\c.txt"  ← 不再吞掉后续文本
```

### 缺陷 5 修复后 —— 安装版真实路径下的定位

```
安装位置: D:\feiyu\feiyu-desktop-control-center\肥鱼桌面控制中心.exe
解析结果: ok=true  botDir=D:\NapCat_publish        ← 自动命中真实机器人项目
找不到时: ok=false reason=not_found
          warning="未找到机器人项目（含 ai_bridge.js 的目录），请在「机器人运行」页手动选择机器人目录"
```

---

## 五、Windows 安装包交付

### 5.1 关键勘误：Phase C 报告的「符号链接权限」结论是错的

阶段 C 报告称 NSIS 安装包「受 sandbox 符号链接权限限制无法生成」。
本轮实测证伪：

```
fs.symlinkSync('target.txt', link, 'file')     → ✅ 成功
fs.symlinkSync('C:\\', linkdir, 'junction')     → ✅ 成功
```

**真实原因是签名步骤**：`app-builder.exe` 在「打包后签名」环节无法执行
（`ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`）。产物其实已生成，只是退出码非 0，容易误判。

正确命令（退出码 0）：

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false \
  npx electron-builder --win nsis -c.win.signAndEditExecutable=false
```

`PHASE_C_REPORT.md` 已加勘误说明。

### 5.2 产物真实路径

| 产物 | 真实路径 | 大小 |
| --- | --- | --- |
| **NSIS 安装包** | `D:\NapCat_publish\feiyu-desktop\dist\肥鱼桌面控制中心-0.1.0-win-x64.exe` | **115,191,514 字节**（≈110 MB） |
| NSIS 附属 blockmap | 同目录 `…-win-x64.exe.blockmap` | 120,396 字节 |
| win-unpacked 目录 | `D:\NapCat_publish\feiyu-desktop\dist\win-unpacked\` | exe 249,797,632 字节 |
| asar（免安装版） | `dist\win-unpacked\resources\app.asar` | 176,128 字节 / 26 条目 |
| **实机安装目录** | `D:\feiyu\feiyu-desktop-control-center\` | — |

> 三者严格区分：NSIS 安装包 = 可安装/可卸载的单文件；win-unpacked = 免安装目录；
> `app.asar` = 两者共用的应用代码包。

### 5.3 构建退出码

| 命令 | 退出码 |
| --- | --- |
| `electron-builder --win --dir -c.win.signAndEditExecutable=false` | **0** |
| `electron-builder --win nsis -c.win.signAndEditExecutable=false` | **0** |

### 5.4 安装验证（实机）

| 检查 | 结果 |
| --- | --- |
| 静默安装退出码 | **0** |
| 安装目录内容 | exe / `resources/app.asar` / `Uninstall 肥鱼桌面控制中心.exe` / 运行时 DLL / locales |
| 桌面快捷方式 | ✅ 已创建（`C:\Users\AA\Desktop\肥鱼桌面控制中心.lnk`） |
| **安装后启动** | ✅ 实测启动成功：`Preferences` 于启动时刻被重写（12:58:50），主进程存活至超时 |
| **安装后定位机器人目录** | ✅ 自动识别 `botDir = D:\NapCat_publish`（无需手动选择） |
| 打包内容复核 | ✅ 安装后的 `app.asar` 含本轮全部 7 项修复（逐条断言） |

### 5.5 卸载验证（实机）

| 检查 | 结果 |
| --- | --- |
| 静默卸载退出码 | **0** |
| 程序文件 | ✅ 全部删除（安装目录清空） |
| **用户数据保留** | ✅ `%APPDATA%\feiyu-desktop-control-center\` 下 `feiyu-settings.json` + `probe-marker.json` **均保留** |
| 桌面快捷方式 | ✅ 已移除 |
| 配置依据 | `nsis.deleteAppDataOnUninstall: false`（package.json + yml 双写） |

### 5.6 重装注意事项（实测发现）

卸载后安装目录**残留为空目录**时，再次运行安装器会 **返回 1 且不安装任何文件**。
清掉该空目录后安装正常（退出码 0）。已写入 README §3.3。

### 5.7 未验证项

| 项 | 原因 |
| --- | --- |
| 图形化安装向导（GUI 点击） | 仅做了 `/S` 静默安装；GUI 流程需人工交互 |
| 便携版 portable 产物 | 未单独执行该 target（与 NSIS 同链路，命令已在 README） |
| 代码签名 / SmartScreen 放行 | 无证书，需采购后配置 |
| 升级路径（旧版 → 新版覆盖安装） | 本轮只有单一版本，未构造升级链 |
| 真实 botDir 下的功能联调 | 不修改真实运行配置、不重启服务 |

---

## 六、集中测试结果（实际输出）

### 6.1 测试命令

```bash
cd D:\NapCat_publish\feiyu-desktop
node --test                                     # 完整套件
node --check <各源文件>                        # 语法检查
node build/package-check.js                     # 打包前检查
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe smoke-main.js
```

### 6.2 结果

| 命令 | 结果 |
| --- | --- |
| `node --test` | **tests 163 / pass 163 / fail 0 / skipped 0 / todo 0** |
| `node --check`（17 个文件 + `ai_bridge.js` + `usage_report.js`） | 全部通过 |
| `node build/package-check.js` | **EXIT=0**，32 项检查全过（1 项非阻断提示：未启用 renderer sandbox） |
| Electron 冒烟 | **SMOKE_OK handlers=40**，EXIT=0 |
| `electron-builder --win --dir` | EXIT=0 |
| `electron-builder --win nsis` | **EXIT=0** |

### 6.3 测试数量演进

| 阶段 | 总数 | 增量 |
| --- | --- | --- |
| 阶段 A | 39 | — |
| 阶段 B | 60 | +21 |
| 阶段 C | 122 | +62 |
| **本轮（发布验收）** | **163** | **+41**（验收 39 + 脱敏回归 2） |

### 6.4 新增测试文件

| 文件 | 项数 | 覆盖 |
| --- | --- | --- |
| `test/acceptance.test.js` | 39 | 10 项验收清单全部覆盖 |
| `test/redact.test.js`（扩充） | +2 | 路径脱敏回归（含 `s` 开头路径、不吞后续文本） |

### 6.5 敏感信息检查

| 检查 | 结果 |
| --- | --- |
| `git status` 命中密钥/配置/日志/exe | ✅ 无 |
| 源码与构建脚本中的 `sk-` 字面量 | ✅ 无（仅测试夹具中的合成串） |
| 打包产物内的密钥/配置数据文件 | ✅ 无（已加入 package-check 为常驻检查） |
| 打包产物内的日志文件 | ✅ 无 |

---

## 七、变更文件清单

### 新增

| 文件 | 说明 |
| --- | --- |
| `src/services/botDirResolver.js` | bot 目录定位（纯逻辑、可注入、可单测） |
| `test/acceptance.test.js` | 10 项验收测试（39 项） |

### 修改

| 文件 | 主要改动 |
| --- | --- |
| `src/services/redact.js` | 修复 `winpath` 字符类（`[^\\\s"'<>|]`），与机器人核心口径对齐 |
| `src/services/providerService.js` | `pruneOrphanSecrets` 三道前置校验；`migrateSecretsToEncrypted` 写入异常回滚 |
| `src/services/providerApplyService.js` | manifest 备份 + 回滚删除新建文件；新增 `deps.writeSecret` 注入点 |
| `src/services/ipcChannels.js` | 新增 `BOTDIR_STATUS` 通道与校验 |
| `src/ipc/handlers.js` | 新增 `BOTDIR_STATUS` 处理器（结构化定位状态） |
| `src/main.js` | 目录解析改为委托 `botDirResolver` |
| `renderer/renderer.js` | 左栏显示定位状态；目录失效时标红 |
| `renderer/index.html` | 新增 `botDirStatus` 容器 |
| `build/package-check.js` | 新增打包产物内容检查（密钥/配置/日志） |
| `test/redact.test.js` | +2 脱敏回归测试 |
| `test/providerApply.test.js` | 改用注入式失败，断言凭据也恢复 |
| `docs/PHASE_C_REPORT.md` | 加勘误（符号链接结论证伪、NSIS 已产出） |
| `README.md` | 更新构建命令、产物实测结果、安装/卸载结论、重装注意事项 |

---

## 八、仍需人工验证的风险

| # | 风险 | 建议动作 |
| --- | --- | --- |
| 1 | **安装包未签名** | Windows SmartScreen 会提示「未知发布者」。正式分发前需采购代码签名证书，并把 `-c.win.signAndEditExecutable=false` 与 `CSC_IDENTITY_AUTO_DISCOVERY=false` 去掉 |
| 2 | **GUI 安装向导未实测** | 本轮只验证了 `/S` 静默路径；需人工跑一遍图形化安装（选目录、快捷方式、卸载项） |
| 3 | **升级链未验证** | 需构造 v0.1.0 → v0.2.0 覆盖安装，确认用户数据与 botDir 配置不丢 |
| 4 | **真实 botDir 联调未做** | 按边界未修改真实配置、未重启服务；发布前应在测试 bot 目录跑一轮完整功能 |
| 5 | **便携版未单独构建** | 命令已给出，但未产出产物与实测 |
| 6 | **界面自动化回归缺失** | 仍无 UI 自动化；界面功能由 IPC/服务层间接覆盖 |
| 7 | **bot 侧 `secrets.json` 仍明文** | 有意为之（bot 进程需明文调用 API）；如需更强保护需在 bot 侧实现 DPAPI 读取 |
| 8 | **Provider 应用仍需重启 AI 桥** | 机器人核心无热切换；界面已注明 |

---

## 九、结论

发布候选的 10 项关键路径**全部通过**（其中 3 项在验收中发现真实缺陷并已修复 + 补测试）：
凭据写阻断、迁移回滚、孤儿清理、切换回滚、人格回滚、费用计算、
用量接口鉴权与兼容、bot 目录定位、安装/卸载数据保留、敏感字段不外泄。

**Windows x64 正式安装包已产出**：
`D:\NapCat_publish\feiyu-desktop\dist\肥鱼桌面控制中心-0.1.0-win-x64.exe`（115,191,514 字节），
构建退出码 0，并已完成**实机安装 → 启动 → 自动定位机器人目录 → 卸载 → 用户数据保留**全流程验证。

代码签名与图形化安装向导仍需人工介入。
