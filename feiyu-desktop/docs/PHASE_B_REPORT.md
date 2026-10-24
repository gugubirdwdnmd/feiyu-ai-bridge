# 肥鱼桌面控制中心 — Phase B 报告

> 真实用量统计 / 多 Provider 配置 / 费用估算
> 分支：`feature/feiyu-desktop-control-center`（基于 `e7b1df1` 阶段 A）
> 日期：2025-10-24

## 0. 执行原则回执

任务书要求的"红线"已全部遵守：

- 未重写 Phase A、未破坏已有界面 / 连接 / 启动流程（沿用 `npm run dev` 与 Electron 主进程，`npm install` 后无需变更）。
- 未覆盖真实运行配置（`ai_config.json` / `secrets.json`）：机器人改动仅为**附加字段**，不改动既有请求语义与模型兜底逻辑；桌面"切换 Provider"由用户主动触发 `APPLY` 并写入原单 Provider 槽，本次未执行任何 `APPLY`。
- 未删除记忆 / 日志、未重启服务、未发送真实 QQ 消息。
- 未自动调用付费 API、未上传安装包、未建 GitHub Release、未合并 `main`、未推送。
- 测试全部走 Mock Provider / 临时目录 / 独立数据（`providerService.test.js` 用注入 `deps.fetch`，不发起真实网络请求）。
- 涉及真实密钥或付费 API 的动作（如 `testConnection` 真实 POST 一条 `max_tokens=1` 请求、`APPLY` 写配置）必须由用户主动触发，前端均带 `confirm` 提示潜在费用。

---

## 1. 实际修改 / 新增的文件

### 1.1 机器人核心（`ai_bridge.js`，任务 2）
| 位置 | 改动 |
|---|---|
| `providerFromBaseUrl(url)`（新） | 由请求实际 `baseUrl` 推导 Provider 标识：deepseek / openai / anthropic / moonshot / qwen / zhipu / doubao / 自定义域（host）/ unknown |
| `classifyError(e)`（新） | 错误归类：`timeout`（AbortError/timeout）、`http_server`（status≥500）、`http_client`（<500）、`network`（其余） |
| `lastCallMeta`（新） | 记录最近一次 `callAPIOnce` 的 `{provider, durationMs, ok}`，成功 / 非 2xx / 网络 catch 三处均更新 |
| `callAPIOnce`（改） | 记录 `reqUrl`/`reqProvider`/`t0`，三处异常分支写 `lastCallMeta`；请求语义与重试规则未变（仅 5xx 重试） |
| `recordUsage`（改） | 去掉 `!usage` 守卫（改 `if (!CFG.stats.enable) return;`）；附加 `status`/`provider`/`durationMs`/`errorCategory`；token 字段缺失记 `null`（聚合用 `sPt=pt||0` 兜底）；JSONL 明细全字段写出 |
| `recordUsageFailure`（新） | 失败 / 超时 / 重试耗尽时写一条 `status:'error'`、token 全 `null` 的明细；全程 `try/catch`，不触碰 `stats`，不影响主流程 |
| `callAPI`（改） | 成功路径传 `Object.assign({}, opts.extra, {status:'success', provider, durationMs})`；最终失败调 `recordUsageFailure(..., classifyError(lastErr))` |

### 1.2 桌面服务层
| 文件 | 任务 | 说明 |
|---|---|---|
| `src/services/providerService.js`（新） | 3 | 多 Provider 注册表（增删改查、默认、密钥分离、协议级连接测试、从现有配置迁移、复用单 Provider 槽 `applyPatch`） |
| `src/services/priceService.js`（新） | 4 | 价格表读写与校验（`getPrice`/`setPrice`/`validatePrice`/`examplePrice`/单位 `1/K/M/B`），存 `userData/price.json` |
| `src/services/usageService.js`（重写） | 4 | `aggregate`（含 success/fail、provider 分桶、耗时、错误类别）、`estimateCost`/`estimateCostForSet`（历史价）、`toCSV`（RFC4180）、`getUsage`（**优先本地 JSONL**） |
| `src/services/ipcChannels.js`（改） | 3 | 新增 `PROVIDER_LIST/SAVE/DELETE/SET_DEFAULT/TEST/APPLY` 及参数校验 |
| `src/ipc/handlers.js`（改） | 3/4 | 接入 `providerService` 与 `priceService`；`USAGE_GET` 逐条 `estimateCost` + 汇总；`PROVIDER_TEST`/`APPLY` 脱敏；`PRICE_SET` 校验 |

### 1.3 渲染层
| 文件 | 说明 |
|---|---|
| `renderer/renderer.js`（改） | `pageApi` 重写：Provider 表格（名称 / 模型 / Base URL / 密钥 / 默认 / 当前 / 操作）+ 新增编辑表单 + 密钥输入（留空保留）；`pageUsage` 重写：范围 + 筛选（Provider/模型/状态）+ CSV 导出 + 价格编辑器（版本 / 币种 / 单位 / 按模型输入输出缓存单价 / 加载示例） |
| `renderer/styles.css`（改） | `.pill.ok/.err`、`.btn.sm`、`.scroll`、`code` 等用量页样式 |

### 1.4 测试
| 文件 | 说明 |
|---|---|
| `test/providerService.test.js`（新） | save 不完整 / 密钥分离 / validate / delete / setDefault / migrate 幂等 / applyPatch 写原槽 / testConnection 协议验证 / 错误脱敏 |
| `test/priceService.test.js`（新） | validatePrice 正反向 / get-set 往返 / examplePrice |
| `test/usageService.test.js`（扩展） | aggregate 成功失败 / provider / 耗时；文件源 status 统计 + 缺失 token 保留 null；不同模型价 / 历史价 / `estimateCostForSet` / `toCSV` 转义 |
| `test/ipcChannels.test.js`（扩展） | `PROVIDER_*` 校验 |

### 1.5 文档与配置
| 文件 | 说明 |
|---|---|
| `docs/USAGE_BASELINE.md`（新） | 任务 1：请求链 + 字段映射表 + 约束 |
| `.gitignore`（改） | 追加 `feiyu_provider_secrets.json`（密钥文件排除入库） |

---

## 2. 用量字段与数据源映射（任务 1 + 任务 2）

### 2.1 明细 JSONL 字段（`memory/usage/YYYY-MM-DD.jsonl` 每条一行）

| 字段 | 来源 | 可靠性 | 旧数据兜底 |
|---|---|---|---|
| `time` | `new Date().toISOString()` 记录时 | 高（ISO8601） | — |
| `kind` | `opts.kind` → bucket（judge/tool/chatrecord/agent/vision/video/answer） | 高 | — |
| `model` | `opts.model \|\| CFG.api.model \|\| 'unknown'` | 中（兜底 unknown） | — |
| `prompt_tokens` | API `usage.prompt_tokens` | 高（仅响应含时） | 缺失 → `null` |
| `completion_tokens` | `usage.completion_tokens` | 高 | 缺失 → `null` |
| `reasoning_tokens` | `usage.completion_tokens_details.reasoning_tokens`（DeepSeek 专属） | 中 | 缺失 → `0` |
| `cache_hit_tokens` | `usage.prompt_cache_hit_tokens` | 中 | 缺失 → `null` |
| `cache_miss_tokens` | `usage.prompt_cache_miss_tokens` | 中 | 缺失 → `null` |
| `total_tokens` | `usage.total_tokens \|\| prompt+completion` | 高 | 缺失 → `null` |
| `chatId` / `chatRecordId` | `opts` | 高 | — |
| `provider`（**新**） | `providerFromBaseUrl(reqUrl)` | 高（由真实 URL 推导） | 旧行 → `unknown` |
| `durationMs`（**新**） | `Date.now()-t0`（单次 fetch） | 高 | 旧行 → `null` |
| `status`（**新**） | 成功 `'success'` / 失败 `'error'` | 高 | 旧行无此字段 → `success` |
| `errorCategory`（**新**） | `classifyError(e)` | 中（错误类） | 旧行 → `null` |
| `priceVersion` | **不在明细中** | — | 价格由桌面按 `time` 套历史规则估算，不回写明细 |

约束落实：
- 禁止字符数当 token；缺失字段记 `null`（前端显示"—"），不冒充 0；聚合求和用 `sPt=pt||0` 兜底保证数学正确。
- 失败明细不污染成功计数（`recordUsageFailure` 不碰 `stats`）。
- 重试不会被计为多次成功（仅 `callAPIOnce` 返回后写一条明细）。
- 向后兼容：旧行无 `status`/`provider`/`durationMs` 按 `success`/`unknown`/忽略读取。

### 2.2 数据源优先级（`getUsage`）

1. **本地 JSONL 文件（首选）**：实时追加、含全部新字段（`status`/`provider`/`durationMs`/`errorCategory`），数据最全最准。`rangeFiles(range)` 计算需要的日期文件，存在才读。
2. **机器人实时 `/api/usage`（回退）**：仅当本地无文件且传入 `livePort` 时尝试。注意：bot 现有该端点**仍只返回旧聚合**（无新明细字段），故作为兼容回退，结果标记 `source:'live'`。
3. **`source:'none'`**：两者皆无，返回全 0 空结构（前端显示"暂无数据"而非"0 用量"）。

> `DETAIL_CAP = 2000`：明细上限，防止极端历史占内存。

---

## 3. 多 Provider 的真实接入方式（任务 3）

### 3.1 设计核心：复用单 Provider 槽，不建第二套请求系统

桌面维护一个 Provider 注册表 `feiyu_providers.json`（**不含明文密钥**），"切换 Provider" = 把选中 Provider 的 `baseUrl/model/key` 通过 `applyPatch` 写回现有的 `ai_config.json(api)` + `secrets.json(apiKey)` 槽位，由机器人下次请求读取（需重启 AI 桥生效）。机器人核心的 `callAPI/callAPIOnce` 完全沿用原单 Provider 语义，不感知"多个 Provider"。

### 3.2 密钥分离与安全

| 文件 | 内容 | 权限 / 入库 |
|---|---|---|
| `feiyu_providers.json` | id / name / baseUrl / model / reasoningModel / timeoutMs / maxRetries / `hasKey` 布尔 | 正常权限，纳入 git |
| `feiyu_provider_secrets.json` | `{ [id]: 明文密钥 }` | `.gitignore` 排除；`chmod 600`（非 win32） |

- 密钥不进注册表明文、不进导入导出、不在错误 / 日志泄漏（`redactText` 兜底脱敏，见 `PROVIDER_TEST`）。
- `save` 更新时 `merged = Object.assign({}, existing, input)`，只传 `key` 不会清空 `baseUrl/model`；密钥仅在 `input.key != null` 时写入，空串 `''` 表示删除该密钥。
- `list` 输出剔除 `secret` 字段，仅暴露 `hasKey`。

### 3.3 兼容迁移

`migrateFromConfig(p, config, secrets)`：当注册表不存在时，用现有 `ai_config.json.api` + `secrets.json.apiKey` 生成一个默认 Provider 并设为默认；已存在则跳过（幂等，不覆盖用户后续改动）。`PROVIDER_LIST` 处理器先调迁移再列出。

### 3.4 协议级连接测试（非仅可达）

`testConnection(provider, deps)`（纯函数 + 注入 `deps.fetch/AbortSignal`，不自发网络请求）：
1. `GET {baseUrl}/models` → 期望 `{data:[...]}`（可选；失败不影响第 2 步）；
2. `POST` 一条 `max_tokens=1` 的最小 chat completion → 仅当 `choices[0].message.content` 为字符串才标记 `protocolOk`。

返回 `{ ok:protocolOk, reachable, protocolOk, modelList, error, costWarning:true }`。**警告**：第 2 步会真正发请求并产生极少量费用，必须由用户主动触发（前端 `confirm` 提示）。

### 3.5 注册表 / 配置 / 密钥三者关系

```
feiyu_providers.json ──(id 关联)──┐
                                   ├─→ applyPatch(id) ──→ ai_config.json(api) + secrets.json(apiKey)
feiyu_provider_secrets.json ───────┘                              ↑ 复用机器人原单 Provider 槽
```

---

## 4. 费用估算（任务 4）

- 价格表存 `userData/price.json`：`{ version, currency, unit('1'/'K'/'M'/'B'), models: { [model]: { input, output, cacheHit, history:[{effectiveFrom, input, output, version}] } } }`。
- `estimateCost(record, price)`：按记录 `time` 用 `selectPriceRule` 套用生效版本（历史价）；缓存命中按 `cacheHit` 单价，未命中 = `输入 - 命中`；`unitFactor` 换算计量单位。
- **区分"估算"与"实际账单"**：无价格表 / 未知模型 → `priced:false`（前端显示"未定价"而非"免费"/"0"）；汇总带 `note:'估算值，非服务商实际账单'`。
- `toCSV` 导出明细（RFC4180：逗号 / 引号 / 换行加引号，引号转义为双引号）。
- 用量页支持：请求总数、成功 / 失败、输入 / 输出 / 缓存 token、按时间 + Provider + 模型 + 状态筛选、平均 / 最大耗时、空数据与未知用量状态、数据来源说明（`source` 标记）。

---

## 5. 新增测试与实际结果（任务 5）

执行命令：`node --test`（桌面 `feiyu-desktop/` 目录）

```
# tests 60
# pass  60
# fail   0
```

- 阶段 A 既有：39 项（未削弱，全绿）。
- 阶段 B 新增：21 项
  - `providerService.test.js`：11 项 —— save 新建 / 更新保留原字段、密钥分离删除、validateProvider 正反例、delete 清默认、setDefault、migrateFromConfig 幂等、applyPatch 写原槽、testConnection 协议验证（可达但非兼容 / 兼容成功 / 错误脱敏）。
  - `priceService.test.js`：3 项 —— validatePrice 正反向、get-set 往返、examplePrice 结构。
  - `usageService.test.js`：5 项 —— aggregate 成功失败 / provider 分桶 / 耗时统计、文件源 status 统计 + 缺失 token 保留 null、不同模型价、历史价、estimateCostForSet、toCSV 转义。
  - `ipcChannels.test.js`：2 项 —— `PROVIDER_*` 六个通道参数校验。

其他验证（Phase A 回归不削弱）：
- `node --check`：桌面 14 个 JS + `ai_bridge.js` 全部语法通过。
- `node build/package-check.js`：退出 0（全部 ✓）。
- Electron 主进程冒烟：注册全部 28 个 IPC 处理器，exit 0。

测试覆盖场景（≥14 项核心）：增 Provider / 改 Provider（仅改密钥保留其余）/ 删 Provider / 设默认 / 从现有配置迁移 / 应用补丁写原槽 / 协议级测试（3 种）/ 错误脱敏 / 价格校验 / 历史价估算 / 缺失 token 不冒充 / CSV 转义 / 数据源回退 / 旧行兼容。

---

## 6. 未解决的问题 / 已知限制

1. **机器人实时 `/api/usage` 端点未扩展**：bot 现有该端点仍只返回旧聚合（无 `status`/`provider`/`durationMs`/`errorCategory`）。因此桌面侧 `getUsage` 改为**优先读本地 JSONL** 以获取完整新字段；实时接口仅作兼容回退。若后续需要"未启动桌面也能查实时明细"，需扩展 bot 端点（本轮按任务书"不破坏已有流程"原则未改其返回结构）。
2. **切换 Provider 需重启 AI 桥才生效**：`applyPatch` 写的是持久化配置，机器人运行时读取的是内存 `CFG`，故 APPLY 后不会热切换，需重启。前端已注明 `note:'需重启 AI 桥生效'`。
3. **安装版打包受沙箱符号链接限制**：与阶段 A 一致，仅 `win-unpacked` 可出；安装版 / 便携版需在开启符号链接权限的环境打包（不在本次范围）。
4. **价格表为手动维护**：不联网抓取服务商价目，用户按实际价目表填写；示例为 DeepSeek 公开价模板（`examplePrice`）。
5. **`cache_mitTokens` 命名**：bot 侧字段为 `prompt_cache_miss_tokens`（部分 provider 不返回），缺失记 `null`，估算时以 `输入 - 命中` 兜底。

---

## 7. 下一阶段建议（不在本轮）

- **Phase C 候选**：
  - 人格模板库（独立模块，不依赖本阶段请求/统计改动）。
  - 自动更新（需安全签名与发布流程，不在桌面侧直接做）。
  - 用量可视化图表（当前为表格 + 卡片；可在 `usageService` 聚合结果之上叠加 Chart）。
  - bot `/api/usage` 端点扩展为返回新明细字段（消除实时回退的数据差）。
  - Provider 热切换（机器人监听配置变更或暴露 reload 通道，免去手动重启）。
- **安全加固**：密钥文件 win32 下无 `chmod 600`，建议后续接入系统凭据存储（Windows Credential Manager / macOS Keychain）替代明文文件。

---

## 8. 交付物小结

- 真实用量：成功 / 失败 / 超时 / 重试均计入明细，新增 `provider`/`durationMs`/`status`/`errorCategory`，缺失 `null` 不伪造。
- 多 Provider：注册表 + 密钥分离 + 协议级测试 + 复用单 Provider 槽切换，零第二套请求系统。
- 费用估算：用户可配单价 / 单位 / 历史价，明确区分"估算"与"账单"，未定价显示"未定价"。
- 测试 60/60 全绿，Phase A 回归不削弱。
- 未推送、未发布、未触碰真实运行配置。
