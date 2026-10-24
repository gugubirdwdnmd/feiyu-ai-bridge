# 肥鱼桌面控制中心 — Phase C 报告

**分支**：`feature/feiyu-desktop-control-center` ｜ **基线**：`ae1f701`（Phase B）
**范围**：人格模板库 / 机器人用量明细接口 / 凭据安全加固 / Provider 与费用可靠性 / Windows 发布准备

> 本报告中的所有测试数字均来自实际执行输出，未做任何估算或美化。

---

## 一、开工前的核查结果（以实际代码为准）

| 核查项 | 实际结果 |
| --- | --- |
| 分支 / HEAD | `feature/feiyu-desktop-control-center` / `ae1f701`，工作区干净 |
| 阶段 A 报告 | 存在且与代码一致 |
| 阶段 B 报告 | 存在且与代码一致 |
| 用量基线文档 | 存在，`docs/USAGE_BASELINE.md` 描述的调用链与实现相符 |
| 既有测试真实结果 | `node --test` → **60/60 通过**（报告声称 60/60，与实际一致） |
| 机器人 `/api/usage` | 确认仍只返回旧聚合结构（`buildUsageReport` 直读 JSONL 后手工聚合），无明细、无筛选、无鉴权 |
| 人格机制 | `ai_prompt.txt` + `CFG.personality`；`loadPrompt()` 每次请求重新读取 → **应用即时生效，无需重启** |
| Electron 版本 | 声明 `^45.0.0`，实际安装 `45.0.0` → 一致（无版本漂移） |
| `package-lock.json` | 存在但被仓库根 `.gitignore` 全局排除 → **`npm ci` 无法从仓库复现**（本轮已修） |

---

## 二、批次 A：人格模板库

### 实现

新增 `src/services/personalityTemplateService.js`（207 行，纯 Node 可测）：

| 能力 | 说明 |
| --- | --- |
| 存储隔离 | 模板存 `<botDir>/feiyu_personalities.json`，**与运行中的 `ai_prompt.txt` 完全分离** |
| CRUD | `save`（新建/编辑）、`remove`、`copy`（副本）、`rename`（重命名） |
| 切换 | `setActive` 设定当前模板 |
| 差异预览 | `diff` + 纯函数 `lineDiff`（LCS 行级 diff），可与当前生效人格或任意目标文本比较 |
| **保存 vs 应用** | `save` 只写模板库；`apply` 才写 `ai_prompt.txt` —— 两条路径在 API 层就分开 |
| 备份 | `apply` 前自动备份 `ai_prompt.txt` → `<botDir>/backups/feiyu-prompt-<ts>/`（gitignore 已排除） |
| 失败保留原配置 | 写入走「临时文件 + rename」原子模式；失败时原文件保持不变并返回明确错误 |
| 一致性状态 | `status()` 返回 `consistency`：`match` / `diverged` / `none`（对比 active 模板内容 vs 实际 `ai_prompt.txt`） |
| 兼容性 | 复用现有 `personalityService` 的 `ai_prompt.txt` 读写路径，不改机器人提示词构建逻辑 |

**生效方式**：机器人 `loadPrompt()` 每次请求重读 `ai_prompt.txt` → **应用后下一条消息即生效，无需重启**。
本轮**未重启**任何服务（也未实现热切换，因为不需要）。

### IPC 与界面

新增 7 个通道：`personality:template:list/save/delete/copy/rename/setActive/apply/diff`，
每个通道在 `ipcChannels.validate` 中有独立参数校验（`id`/`name`/`template`/`target` 类型检查）。

界面重写「人格设置」页，明确分区：
- **模板库**（列表 + 新建/编辑/复制/重命名/删除/设为当前）
- **当前实际生效的人格**（只读展示 + 一致性徽标「与当前模板一致 / 已偏离」）
- **差异预览**（行级 diff，+/-/空格 着色）
- **应用到机器人**（独立按钮，带确认；返回备份目录路径）

### 测试（13 项）

`test/personalityTemplateService.test.js`：模板 CRUD、复制/重命名、切换、备份生成、
应用失败保留原配置、一致性判定（match/diverged）、diff 行级正确性、保存不触碰 `ai_prompt.txt`。

---

## 三、批次 B：机器人用量明细接口

### 机器人侧

新增 **`usage_report.js`**（仓库根，139 行，纯计算层，无 I/O / 无网络 / 无全局副作用）：

- `computeUsageReport(reqs, opts)` — 筛选 + 聚合 + 明细投影
- `projectDetail(r)` — **白名单投影**（`DETAIL_FIELDS` 15 个字段），即使 JSONL 混入未知字段也会被剔除
- `usageEndpointAllowed(headers, {requireAuth, token})` — 鉴权决策纯函数
- `clampLimit` — 默认 200 条、硬上限 2000 条

`ai_bridge.js` 的 `buildUsageReport` 改为委托该模块，`/api/usage` 端点改造：

| 要求 | 实现 |
| --- | --- |
| 保留旧字段与语义 | `totalTokens`/`requests`/`modelUsage`/`recentRequests`/`chatRecords`/`budget` 等**全部保留**，未传筛选时与旧行为等价 |
| 向后兼容的新明细 | 新增 `detail` 数组（白名单投影），旧 `recentRequests` 保留为「最近 50 条未筛选」 |
| 筛选 | `provider` / `model` / `status` / `limit` —— **只实现后端数据确实支持的字段**；历史行无 `status` 按 `success` 兜底 |
| 敏感字段过滤 | 明细不含 API Key、提示词、聊天正文（白名单硬约束 + 测试断言 `d.apiKey === undefined`） |
| 数量/体积上限 | `detail` 受 `limit` 约束（≤2000） |
| 权限 | 启用 `http.requireEventAuth` 时 `/api/usage` 同样要求 `Authorization: Bearer <token>`；**要求鉴权但本机无 token → fail-closed 拒绝**；默认关闭以保持旧客户端兼容（依赖回环信任边界） |
| 不暴露日志下载 | 未新增任何日志文件下载接口 |
| 缺失字段语义 | `status` 缺失 → `success`；token 缺失 → `null`；错误类别缺失 → `unknown` |
| 不重复存储 | **未为扩展字段重复存储任何请求内容** —— `detail` 是对既有 JSONL 的投影，不是新副本 |

### 桌面侧

- `usageService.fetchLive` 透传 `Authorization` 头 + 筛选参数，并把 `detail` 映射为 `recentRequests`
- `USAGE_GET` handler 从 `secrets.json` 读 `onebotToken` 并作为 Bearer 传给机器人（仅当事件鉴权开启时）
- **数据源优先级不变**：本地 JSONL（字段最全）→ 实时 `/api/usage`（兼容回退）→ 空状态

### 测试（11 项）

`test/usageReport.test.js`：白名单投影（`apiKey`/`fullPrompt` 不出现在 detail）、
筛选正确性（provider/model/status）、limit 封顶、鉴权决策（放行/拒绝/fail-closed）、
旧字段与旧客户端语义保持、缺失字段兜底。

---

## 四、批次 C：凭据安全加固

### 现状核查结果

| 核查项 | 结论 | 处理 |
| --- | --- | --- |
| `feiyu_providers.json` 含明文密钥 | ❌ 不含（只存 `hasKey` 布尔） | 保持 |
| `feiyu_provider_secrets.json` 权限 | ⚠️ POSIX `chmod 600`；**Windows 上 chmod 不提供等效保护** | 新增 safeStorage 加密路径 |
| `.gitignore` 覆盖 | ✅ 已覆盖密钥文件；⚠️ **未覆盖 `feiyu_providers.json` / `feiyu_personalities.json`** | 已补 |
| 日志/错误/导出泄漏 | ✅ 统一经 `redact.js` 脱敏 | 保持 + 新增断言 |
| IPC 越权读凭据 | ❌ **`SECRET_READ` 原样回传明文 `secrets.json` 给渲染进程** | **已修**：改为掩码返回 |
| IPC 越权写凭据 | ⚠️ `SECRET_WRITE` 未限制字段 | **已修**：字段白名单 |
| 自定义 Base URL 内网滥用 | ⚠️ 无任何标记 | **已修**：非阻断标记 `localNetwork` |
| 凭据文件原子写入 | ✅ 已是 tmp+rename | 保持 |
| 迁移/删除丢凭据 | ⚠️ 删除 Provider 已同步删密钥；无孤儿清理能力 | 新增 `pruneOrphanSecrets` |
| **加密库不可解密时误写** | ❌ 风险：读不到就当空 → 写回会清空其它 Provider 的密钥 | **已修**：`assertWritable` 阻断写入 |

### 核心实现

**`src/services/credentialStore.js`（新增）**
- 基于 Electron `safeStorage`（Windows = DPAPI / CryptProtectData，与当前用户会话绑定）
- `electron` **惰性加载** → 纯 Node 环境下 `require` 不失败，`available()` 返回 false（明文回退）
- `availableAsync()` 优先用新版 `isAsyncEncryptionAvailable`（同步版已废弃），避免运行期告警
- `makeProviderCodecAsync()` → `{ encrypt, decrypt }`，base64 封装

**`providerService` 加密支持**
- `setCodec(codec)` 注入；注入后 `saveSecrets` 自动写 `{"__encrypted":true,"v":1,"data":{...}}`
- `readSecrets(p)` 返回 `{ok, data, encrypted, error}`；**加密库不可解密时 `ok:false`**
- `assertWritable(p)` — `save`/`remove`/`applyPatch`/`migrateFromConfig`/`pruneOrphanSecrets` **全部先检查**，
  不可解密时拒绝写入并给出明确原因（保护其它 Provider 的密钥不被清空）
- `migrateSecretsToEncrypted(p)` — **备份 → 加密写入 → 回读逐字段校验 → 失败自动回滚**；
  幂等（已加密则跳过）；**不删除原明文备份**（备份在 `backups/`，已 gitignore）

**IPC 加固**
- `SECRET_READ` → 只回传掩码（`sk-***`，首尾各 3 字符）+ `masked:true`，**不回传明文**
- `SECRET_WRITE` → 字段白名单 `['apiKey','api_key','onebotToken','imageApiKey']`，非法字段直接拒绝
- 新增 `CREDENTIAL_STATUS` / `CREDENTIAL_MIGRATE` 两个通道
- `providerService.list()` 新增 `encrypted` / `decryptError` 字段

**迁移安全性**
- 迁移是**用户显式触发**（API 页面「迁移到系统凭据存储」按钮 + 二次确认），**启动时不自动改写用户数据**
- 启动时只注入 codec，使**后续写入**自动加密
- 全流程在临时目录 + 假 codec 下测试，**未触及任何真实密钥文件**

**边界明确说明**：机器人自身的 `secrets.json` **保持明文** —— bot 进程独立运行、无 safeStorage、
且需要明文调用 API。该文件**不在**加密范围内，README 与界面均已注明。

### 测试（8 项）

`test/credentialSecurity.test.js`：codec 加解密往返、磁盘不含明文、旧明文文件仍可读（向后兼容）、
迁移（备份内容 + 回读校验 + 幂等）、加密库不可解密时拒绝写入且磁盘未被破坏、
孤儿密钥 dry-run/确认删除、删除 Provider 不留孤儿、SECRET_WRITE 白名单、内网 URL 标记。

---

## 五、批次 D：Provider 与费用计算可靠性

### 修复的真实缺陷

**1. 费用精度：逐条四舍五入造成系统性偏差（已修）**

原实现 `estimateCost` 单条就 `Math.round(cost * 1e6) / 1e6`，`estimateCostForSet` 再把已舍入的值累加。
记录越多，偏差越大（1000 条记录可累积 ~1e-6 量级）。

现改为：
- 单条返回**全精度浮点**，不提前舍入
- 汇总时对全精度值累加，**只在最终总额一次性舍入**（`roundCost`，6 位小数）
- 测试用 1000 条记录对比新旧路径，确认偏差消除

**2. 时区边界：UTC 格式化 vs 本地日期推算错位（已修）**

原 `fmtDate` 用 `toISOString().slice(0,10)`（**UTC**），而 `rangeFiles` 用 `new Date()` 的
**本地**日期推算区间。在 UTC+8 下，凌晨 8 点前的「今日」会算成昨天 → 少算一整天的数据。

现改为按本地 `getFullYear/getMonth/getDate` 格式化，与机器人写文件的日期口径一致。
测试断言「今日文件 == 本地日期」「昨日文件 == 本地昨日」「本月只含 1 号到今天」。

**3. 部分定价被误读为完整费用（已修）**

`estimateCostForSet` 新增 `unpricedModels` 与 `partial` 标记：未定价模型不计入总额，
并显式列出，避免「部分定价 = 全量费用」的误读。`priced:false` 的模型仍显示「未定价」。

### Provider 切换可靠性（新增 `providerApplyService.js`）

原 `PROVIDER_APPLY` 是「写配置 → 写密钥」，**无备份、无预览、失败不回滚**。

现改为 `providerApplyService`：
- `previewSwitch(id)` — 差异预览（只含 baseUrl/model/reasoningModel/timeoutMs/maxRetries，
  **密钥只比较「是否更换」，绝不回显明文**），且**不写任何文件**
- `applySwitch(id)` — **备份 → 写配置 → 写密钥 → 回读校验（配置字段逐项 + 密钥一致）→ 失败自动回滚**
  备份目录 `<botDir>/backups/feiyu-provider-switch-<ts>-<id>/`
- 界面：点「应用」先弹出差异预览表，确认后才写入

### 其他复核项

| 项 | 结论 |
| --- | --- |
| Provider 增删改/默认/迁移 | 通过（`migrateFromConfig` 幂等；从旧 `ai_config.json` 迁移） |
| 价格单位 1/K/M/B | 通过（`unitFactor`） |
| 输入/输出/缓存独立定价 | 通过（`cacheMiss = prompt - cacheHit`，各自单价） |
| 历史价按记录时间 | 通过（`selectPriceRule` 按 `effectiveFrom` 升序取最后生效版；早于全部历史回落当前价） |
| 未知价显示「未定价」 | 通过（`priced:false` + `reason:'unknown_model'`） |
| CSV RFC4180 | 通过（逗号/引号/换行/中文/空值全部覆盖；`null` 输出空串而非 0） |
| 失败/重试/重复统计语义 | 通过（`status==='error'` 计失败；旧行无 status 计成功；重试在 bot 侧只记一条失败明细，不重复计成功） |

### 测试（19 项）

`test/pricing.test.js`（14 项）+ `test/providerApply.test.js`（5 项）：
单位换算、三类 token 独立定价、单条不提前舍入、汇总无系统性偏差、未知价不计总额、
历史价四种情形、CSV RFC4180 特殊字符、缺失字段空串、失败/成功分离计数、
本地时区日期范围四种断言、`getUsage` 文件源/空源、差异预览不写文件、
切换成功+备份、缺密钥拒绝、写入失败回滚、重复应用幂等。

---

## 六、批次 E：Windows 发布准备

### 核查与修复

| 检查项 | 修复前 | 修复后 |
| --- | --- | --- |
| Electron 版本声明 vs 实际 | `^45.0.0` vs `45.0.0` ✅ | 一致，且 `package-check` 会自动校验 |
| `npm ci` 可复现 | ❌ `package-lock.json` 被全局 gitignore | `.gitignore` 增加 `!feiyu-desktop/package-lock.json` 例外，lockfile 入库 |
| 打包后定位机器人项目 | ❌ 安装版 `app.getAppPath()` 指向 `app.asar` 内部，**找不到 bot** | `resolveDefaultBotDir` 增加 exe 相对候选（`exeDir/bot`、`exeDir/../NapCat_publish` 等）与用户主目录兜底，**不硬编码任何盘符** |
| 依赖开发机固定路径 | ✅ 无硬编码 | `package-check` 增加扫描断言（`[A-Za-z]:[\\/]NapCat_publish`） |
| 用户数据与安装目录分离 | ✅ `%APPDATA%/肥鱼桌面控制中心/` | 保持，并在 README 列表化 |
| 升级/卸载保留配置/记忆/日志 | ⚠️ NSIS 默认行为随版本变化 | 显式 `deleteAppDataOnUninstall: false`（package.json + yml 双写） |
| 运行时随应用打包 | ✅ Electron 运行时由 electron-builder 打包 | 保持 |
| win-unpacked vs NSIS 区分 | ⚠️ 未文档化 | README 明确区分三种产物及各自用途 |
| 构建脚本与 README | ❌ 无 README | 新增 `feiyu-desktop/README.md`（功能表、运行方式、bot 目录解析、打包步骤、产物区别、数据位置表、安全边界、数据来源） |

### 打包前检查（`build/package-check.js` 强化）

从 4 项扩展到 20 项：Node 版本、13 个关键源文件、4 类机密文件排除、依赖安装、
**Electron 版本匹配**、lockfile 存在、contextIsolation/nodeIntegration、preload 高危能力扫描、
硬编码路径扫描、打包清单覆盖、nsis 卸载策略。

### 实际构建产物

```
D:\NapCat_publish\feiyu-desktop\dist\win-unpacked\肥鱼桌面控制中心.exe   (249,797,632 字节)
D:\NapCat_publish\feiyu-desktop\dist\win-unpacked\resources\app.asar    (165,030 字节)
```

`app.asar` 内已确认包含全部 Phase C 新增服务（`credentialStore.js`、`providerApplyService.js`、
`personalityTemplateService.js` 等）。

**构建命令与结果**：
- `npx electron-builder --win --dir` → 打包成功，但**签名步骤失败**（app-builder 无法执行，sandbox 限制），
  产物仍已生成（asar 从 75KB 增至 165KB）
- `CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win --dir -c.win.signAndEditExecutable=false`
  → **EXIT=0**，干净通过

**NSIS 安装版 / 便携版**：受 sandbox 符号链接权限限制**无法在本环境生成**。
按任务书要求**未重复执行同一失败操作**，改为在 README 中给出普通 Windows 开发机的可复现步骤。

> ⚠️ **勘误（发布验收轮次修正）**：上述「符号链接权限」结论**不正确**。
> 复测证明本环境**可以创建符号链接与目录联接**（`fs.symlinkSync` 均成功），
> NSIS 安装包实际构建成功（EXIT=0）。此前失败的真正原因是
> **签名步骤**（`app-builder.exe` 在签名环节无法执行），而非符号链接。
> 正确的构建命令为：
> ```
> CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win nsis -c.win.signAndEditExecutable=false
> ```
> 详见 `docs/RELEASE_ACCEPTANCE_REPORT.md`。

---

## 七、集中测试结果（实际输出）

### 测试命令与结果

| 命令 | 结果 |
| --- | --- |
| `node --test`（feiyu-desktop） | **tests 122 / pass 122 / fail 0 / skipped 0 / todo 0** |
| `node --check`（14 个桌面文件 + smoke-main.js） | 全部通过 |
| `node --check ../ai_bridge.js ../usage_report.js` | 通过 |
| `node build/package-check.js` | EXIT=0，20 项检查全过（1 项非阻断提示） |
| `electron smoke-main.js` | **SMOKE_OK handlers=39**，EXIT=0 |
| `npx electron-builder --win --dir`（禁签名） | **EXIT=0** |

### 测试数量演进

| 阶段 | 测试数 | 说明 |
| --- | --- | --- |
| Phase A 基线 | 39 | 阶段 A 原有 |
| Phase B 结束 | 60 | +21 |
| **Phase C 结束** | **122** | **+62**（批次 A 13 + 批次 B 11 + 批次 C 8 + 批次 D 19 + 批次 E 11） |

### 阶段 A/B 回归

**122 项全部通过 = Phase A（39）+ Phase B（21）无削弱**。
新增测试文件：

| 文件 | 项数 | 覆盖 |
| --- | --- | --- |
| `test/personalityTemplateService.test.js` | 13 | 模板 CRUD/切换/备份/回滚/一致性/生效路径 |
| `test/usageReport.test.js` | 11 | 用量接口权限、兼容性、白名单投影、筛选 |
| `test/credentialSecurity.test.js` | 8 | 密钥脱敏、存储、迁移、无泄漏、无孤儿 |
| `test/pricing.test.js` | 14 | 价格单位、历史价、精度、CSV RFC4180、时区、统计语义 |
| `test/providerApply.test.js` | 5 | 配置应用、备份、回滚 |
| `test/release.test.js` | 11 | IPC 权限、Electron 安全配置、打包配置与产物 |

### Electron 冒烟（真实 Electron 运行时）

```
credential codec: safeStorage 已启用
已注册处理器: 39/39
✅ 全部 IPC 处理器注册成功
✅ preload 暴露完整通道表
webPreferences: contextIsolation=true nodeIntegration=false
✅ Electron 安全配置正确
SMOKE_OK handlers=39
```

> 注意：本沙箱的 shell 预设了 `ELECTRON_RUN_AS_NODE=1`，直接 `npx electron` 会以 Node 模式运行
> 并报 `Cannot read properties of undefined (reading 'whenReady')`。
> 正确方式：`env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe smoke-main.js`。

### 敏感文件与凭据泄漏检查

| 检查 | 结果 |
| --- | --- |
| `git status` 命中 `secrets.json`/`ai_config.json`/`memory/`/`.exe`/凭据文件 | ✅ 无 |
| 源码内明文密钥字面量 | ✅ 无（仅测试夹具 `sk-SECRET…`/`sk-LEAK…`/`sk-SHOULD-NOT-LEAK` 等合成串） |
| 打包清单内机密文件 | ✅ `secrets.json`/`ai_config.json`/`feiyu_provider_secrets.json`/`feiyu_providers.json` 均不在 `feiyu-desktop/` 内 |
| 渲染进程能否读明文密钥 | ✅ 已封堵（`SECRET_READ` 掩码 + `SECRET_WRITE` 白名单） |
| detail 明细是否含 Key/提示词/正文 | ✅ 白名单投影，测试断言 `apiKey === undefined` |

### 本轮修复的自身缺陷（测试暴露）

1. `ipcChannels` 的 `SECRET_WRITE` 白名单判断写反（用了 `every` 而非「传入键是否都在白名单内」）→ 改为非法键检测
2. 凭据测试中手工构造加密文件时误用 `cur.data`（实际结构为 `{__encrypted,data}`）→ 修正测试构造
3. `CREDENTIAL_STATUS` / `CREDENTIAL_MIGRATE` 两个新通道未登记进 `validate`（被 release 测试捕获）→ 已补
4. `usageReport` 测试对「时间最新」记录的选择假设有误 → 修正断言
5. Electron 冒烟脚本的重复注册判定逻辑写反（抛错才是「已注册」）→ 修正

---

## 八、变更文件清单

### 机器人核心（仓库根）

| 文件 | 变更 |
| --- | --- |
| `usage_report.js` | **新增**（139 行）—— 纯计算层：白名单投影、筛选、聚合、鉴权决策 |
| `ai_bridge.js` | `buildUsageReport` 委托 `usage_report.js`；`/api/usage` 增加鉴权 + 筛选 + `detail` |

### 桌面端新增

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| `src/services/personalityTemplateService.js` | 207 | 人格模板库 |
| `src/services/credentialStore.js` | 88 | safeStorage 封装（惰性加载 electron） |
| `src/services/providerApplyService.js` | 144 | 切换预览 / 备份 / 回滚 |
| `README.md` | — | 功能、运行、打包、产物区分、数据位置、安全边界 |
| `smoke-main.js` | — | Electron 冒烟脚本（39 通道） |
| `test/personalityTemplateService.test.js` | 133 | 13 项 |
| `test/usageReport.test.js` | 100 | 11 项 |
| `test/credentialSecurity.test.js` | 159 | 8 项 |
| `test/pricing.test.js` | 215 | 14 项 |
| `test/providerApply.test.js` | 106 | 5 项 |
| `test/release.test.js` | 105 | 11 项 |

### 桌面端修改

| 文件 | 主要变更 |
| --- | --- |
| `src/main.js` | bot 目录解析增加 exe 相对候选（修复安装版定位）；safeStorage 异步注入 |
| `src/ipc/handlers.js` | 新增 10 个通道处理器；`SECRET_READ` 掩码化；`PROVIDER_APPLY` 改走 `providerApplyService` |
| `src/services/ipcChannels.js` | 新增 10 个通道 + 逐通道校验；`SECRET_WRITE` 字段白名单 |
| `src/services/providerService.js` | codec 注入、`readSecrets`/`assertWritable`、迁移、`pruneOrphanSecrets`、`isPrivateUrl` |
| `src/services/usageService.js` | 费用精度策略、本地时区日期、部分定价标记、`roundCost` |
| `renderer/renderer.js` | 人格模板库 UI、凭据安全面板、Provider 差异预览 |
| `build/package-check.js` | 4 项 → 20 项检查 |
| `build/electron-builder.yml` + `package.json` | `deleteAppDataOnUninstall: false` |
| `package-lock.json` | **入库**（`npm ci` 可复现） |

### 仓库根

| 文件 | 变更 |
| --- | --- |
| `.gitignore` | 新增 `feiyu_providers.json`、`feiyu_personalities.json` 排除；`!feiyu-desktop/package-lock.json` 例外 |

---

## 九、已验证 / 未验证的功能边界

### 已验证（有实际执行证据）

- Phase A（39）+ Phase B（21）全部回归通过，共 **122/122**
- 39 个 IPC 通道在真实 Electron 运行时全部注册成功
- Electron 安全配置实测 `contextIsolation=true` / `nodeIntegration=false`
- `app.asar` 内容清单确认包含全部 Phase C 新服务
- `package-check` 20 项检查通过
- win-unpacked 产物实际生成且构建退出码 0
- 凭据迁移全流程（临时目录 + 假 codec）实测通过，含备份与回滚校验
- Provider 切换的差异预览 / 备份 / 回滚实测通过
- 费用精度与时区缺陷有针对性回归测试

### 未验证（明确边界）

| 项 | 原因 |
| --- | --- |
| NSIS 安装包 / 便携版产物 | ~~沙箱缺符号链接权限~~ **（勘误）实为签名步骤失败；用 `-c.win.signAndEditExecutable=false` 已成功产出 NSIS 安装包** | 已解决，见发布验收报告 |
| 真实 `safeStorage` 加密落盘 | 冒烟确认 safeStorage **可用**且 codec 注入成功，但未对真实密钥文件执行迁移（不触及真实凭据） |
| 真实 Provider 的 `/api/usage` 联调 | 需机器人运行中且会访问真实服务；本轮未重启任何服务 |
| Windows 真实安装/升级/卸载流程 | 无干净 Windows 环境；`deleteAppDataOnUninstall=false` 为配置层保证 |
| 界面像素级回归 | 无自动化 UI 测试（无框架依赖）；功能路径由 IPC 层与服务层测试覆盖 |

---

## 十、当前可运行方式

```bash
cd D:\NapCat_publish\feiyu-desktop
npm ci                 # lockfile 已入库，可复现
npm start              # 开发模式启动 Electron
npm test               # 122 项测试
npm run package-check  # 打包前静态检查
```

免安装产物：`dist\win-unpacked\肥鱼桌面控制中心.exe`（已实际生成）

---

## 十一、尚未解决的问题及阻塞原因

| # | 问题 | 阻塞原因 | 影响 |
| --- | --- | --- | --- |
| 1 | NSIS 安装包 / 便携版未生成 | ~~沙箱无符号链接权限~~ **（勘误）真实原因是签名步骤；已用 `-c.win.signAndEditExecutable=false` 成功生成 NSIS 安装包并完成安装/卸载实测** | 已解决 |
| 2 | 机器人 `secrets.json` 仍为明文 | bot 进程无 safeStorage，需明文调用 API | 有意为之，界面与 README 已注明；缓解手段是文件权限 + 目录隔离 |
| 3 | Provider 应用后需重启 AI 桥才生效 | 机器人核心按单 Provider 启动时读取配置，无热切换 | 已在界面与返回 note 注明；下阶段可做热切换 |
| 4 | `renderer sandbox` 未启用 | `sandbox:false`（preload 需 require 本地模块） | 影响有限：preload 只暴露 `invoke`，已静态断言无高危能力 |
| 5 | 人格模板库 / Provider 注册表存于 `<botDir>` | 机器人项目目录是既有约定 | 若 botDir 不可写则模板无法保存（错误明确返回） |
| 6 | 未做界面自动化回归 | 无 UI 测试框架依赖 | 界面功能靠 IPC/服务层测试间接覆盖 |
| 7 | 桌面端无法自动发现任意路径的机器人项目 | 无注册表/协议约定 | 提供候选路径 + 手动选择；不硬编码盘符 |

---

## 十二、下一阶段建议（Phase D 候选）

1. **Provider 热切换**：机器人核心增加运行期 Provider 槽位（内存态），桌面切换后无需重启（当前是持久化配置 + 重启）
2. **用量图表与趋势**：把 `/api/usage` 的 `detail` 做成日/小时趋势图（Phase C 任务书已明确排除复杂图表，故未做）
3. **界面自动化回归**：引入轻量方案（Playwright/Electron E2E）覆盖 8 个页面主流程
4. **凭据深度加固**：把 bot 的 `secrets.json` 也迁到 DPAPI（在 bot 侧实现 DPAPI 读取，或用独立凭据代理进程）
5. **配置版本化与回滚中心**：把 `backups/` 做成可视化的历史列表 + 一键回滚（当前仅有目录级备份，无索引 UI）
6. **打包签名**：准备代码签名证书，把 `signAndEditExecutable=false` 恢复为正式签名流程
7. **日志与用量归档**：按月滚动归档 `memory/usage/*.jsonl`，避免历史文件无限增长
