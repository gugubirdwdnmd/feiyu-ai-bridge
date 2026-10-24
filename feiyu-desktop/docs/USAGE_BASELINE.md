# 用量数据基线（Phase B 任务 1）

追踪现有 API 请求链，形成字段映射表。结论先行：

- 现有用量明细只记录**成功**请求；**失败 / 超时 / 重试**从不写入 `memory/usage/*.jsonl`（只有 `stats.errors` 计数器累加）。
- 现有明细**没有** `provider`、`durationMs`（请求耗时）、`status`（成功/失败）、`errorCategory`（错误类别）字段。
- 现有核心为**单 Provider**（DeepSeek）架构：`CFG.api.baseUrl` / `CFG.api.model` / `API_KEY` 均为单值，无多 Provider 抽象。

## 请求调用链（ai_bridge.js）

```
callAPI(messages, allowTools, opts)            // 带重试 + 模型兜底
  └─ for attempt 0..maxRetries:
       callAPIOnce(messages, allowTools, model, opts)   // 单次 fetch
         ├─ baseUrl = useVision ? CFG.vision.baseUrl : CFG.api.baseUrl (兜底 API_URL)
         ├─ 超时 = withTimeout(CFG.api.timeoutMs || 30000)
         ├─ 非 2xx → throw Error，e.retryable = (status>=500)   // 仅 5xx 重试，4xx 不重试
         └─ 网络错 → e.retryable = true
       recordUsage(j.usage, ...)                // 仅成功时调用
  └─ 兜底：CFG.model.fallback 存在且与主选不同 → 再调一次 callAPIOnce + recordUsage
  └─ 全部失败 → stats.errors++ 后 throw
recordUsage(usage, groupId, kind, chatId, model, extra)  // 写 memory/usage/YYYY-MM-DD.jsonl + 更新 stats
```

- `recordUsage` 守卫：`if (!CFG.stats.enable || !usage) return;` —— 即 **usage 缺失的成功响应也不记录**（待 Phase B 修正为记录 status=success 但 token 为 null）。
- 重试不会被计为多次成功：`recordUsage` 仅在 `callAPIOnce` 返回后调用；重试的失败分支只 `stats.errors++`，不写明细。

## 字段映射表

| 指标 | 当前数据源 | 可靠性 | 状态 |
|---|---|---|---|
| time（时间戳） | `new Date().toISOString()` 记录时 | 高（ISO8601） | 已有 |
| kind（judge/answer/tool/chatrecord/agent/vision/video） | `opts.kind` → bucket | 高 | 已有 |
| model（模型名） | `opts.model \|\| CFG.api.model \|\| 'unknown'` | 中（兜底 'unknown'） | 已有 |
| prompt_tokens（输入） | API `usage.prompt_tokens` | 高（仅响应含时） | 已有 |
| completion_tokens（输出） | `usage.completion_tokens` | 高 | 已有 |
| reasoning_tokens（推理） | `usage.completion_tokens_details.reasoning_tokens`（DeepSeek 专属） | 中（非推理模型为 0） | 已有 |
| cache_hit_tokens | `usage.prompt_cache_hit_tokens` | 中（仅 provider 返回时） | 已有 |
| cache_miss_tokens | `usage.prompt_cache_miss_tokens` | 中 | 已有 |
| total_tokens | `usage.total_tokens \|\| prompt+completion` | 高 | 已有 |
| chatId / chatRecordId | `opts` | 高 | 已有 |
| **provider（Provider 标识）** | — | — | **缺失**（单 Provider 假设） |
| **durationMs（请求耗时）** | — | — | **缺失** |
| **status（success/error）** | — | — | **缺失**（明细仅成功） |
| **errorCategory（http_server/http_client/timeout/network）** | — | — | **缺失**（失败从不入明细） |
| **priceVersion（价格规则版本）** | — | — | **缺失**（价格表在桌面侧 userData，bot 不感知；按 provider+model+time 在估算时套用，不回写明细） |

## 约束（来自任务书）

- 禁止把字符数当 token 数；禁止用模拟数字冒充实际用量。
- 历史数据缺失不伪造补齐：旧行无 `status`/`provider`/`durationMs` → 视为 `success`/`unknown`/忽略。
- 失败记录不能让原本成功的请求失败：`recordUsageFailure` 全程 try/catch，且不改 `stats` 语义。
- 兼容旧配置与已有数据格式：新字段为附加字段，旧行读取时按上述兜底。
- 不能把历史记录全部重解释为当前价格账单：估算在桌面侧按记录时间套用历史价格规则，bot 明细不含价格。
