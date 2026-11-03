# D:\NapCat 项目总览（当前状态快照）

> 生成时间：2026-10-10 17:30 ｜ 对应版本：V14（含 V14-C.1~C.3 + 安全阶段三 B1/B2）
> 隐私说明：本文档不写入任何真实 QQ 号、群号、API Key、本机用户名。`ai_bridge.log` 含明文，勿外发。
> 历史沿革见 `项目日志.md`（停在 v9~v12，本文件为最新快照）；专项方案见 `docs/` 下三份文档。

---

## 一、这是什么

一个跑在本机的 **QQ 群聊 / 私聊 AI 自动回复机器人**。
QQ 客户端的消息通过 NapCat 转成 OneBot11 协议事件推给本地桥接程序，桥接程序决定"要不要回、用什么模型、带多少上下文、调不调工具"，再调 DeepSeek API 生成回复并回发到 QQ。

特征：**零第三方依赖**（只用它自带的 Node 22，无 npm 包、无 undici），全部自己实现；**配置驱动**（`ai_config.json`）；**本地预筛优先**（能不发 API 就不发，省 token）。

---

## 二、架构

```
QQ 客户端
   │
NapCat（一体包，自带 Node 22 + QQ 运行库）
   │  OneBot11
   ├─ 127.0.0.1:3000   本桥调它发消息（send_group_msg / send_private_msg / upload_*）
   └─ 127.0.0.1:3001   NapCat 把事件推给本桥 + 用量看板也挂在这
   │
ai_bridge.js  （约 3600 行，160 KB，项目主文件）
   ├─ 事件入口 / 去重 / 冷却 / 消息聚合
   ├─ L0 本地预筛（0 次 API 调用决定要不要回）
   ├─ Judge 二次判定（不确定时才问模型）
   ├─ 上下文系统：群缓冲 + 分级 + 自动摘要
   ├─ 多模态：图片 / 视频 / 表情
   ├─ 分享卡片解析（B 站、小黑盒等）
   ├─ 聊天记录（合并转发）解析与分析
   ├─ 工具层 Function Calling（10 个工具）
   ├─ Agent 多步子系统（agent/）
   ├─ 记忆引擎（短期 sessions + 长期 notes）
   ├─ 输出安全过滤（LEAK_RULES）
   ├─ 统计与用量看板
   └─ 网络防护（url_safety.js + safe_http.js）
```

**模型**：`deepseek-flash`（DeepSeek-V4.1-Flash，主力，支持图片）、`deepseek-v4-pro`（推理/复杂问题）。
**Key**：从 `secrets.json` 或环境变量 `DEEPSEEK_API_KEY` 读，不硬编码。

---

## 三、文件地图

| 文件 / 目录 | 作用 |
|---|---|
| `ai_bridge.js` | 主程序，全部逻辑入口 |
| `ai_config.json` | 唯一配置文件（2.2 KB），删掉则全走内置默认值 |
| `ai_prompt.txt` | 人设与说话方式（5.6 KB），**风格唯一控制点** |
| `secrets.json` | API Key |
| `url_safety.js` | SSRF 防护：IP 分类内核（IPv4 全特殊段 + IPv6 展开/映射/NAT64/6to4）、userinfo 拒绝 |
| `safe_http.js` | 安全 HTTP 客户端：固定 IP 防 DNS 重绑、逐跳重定向校验、四档超时、流式大小限额 |
| `share_card.js` | 分享卡片 → 可读文本（B站、小黑盒等） |
| `chat_record_parser/` | 合并转发消息的解析、归一化、媒体处理 |
| `agent/` | 多步 Agent 子系统（core / intent / state / tool_router） |
| `tools/` | 工具实现：web / memory / file / image / video / bilibili / chat_record / result |
| `memory/` | 会话 sessions.json、长期 notes.json、按天用量 usage/*.jsonl |
| `workspace/` | 文件沙箱，AI 生成的 xlsx/csv/txt 落这里 |
| `stickers/` | 本地表情图 |
| `dashboard/index.html` | 用量看板（127.0.0.1:3001/） |
| `tests/` | 8 个测试文件，944+ 断言 |
| `backup/` | 每次改动前的备份 |
| `docs/` | 三份方案文档（安全、提醒、自主进化） |

---

## 四、已实现的功能

### 1. 群聊智能回复（核心）
- **L0 本地预筛**：关键词/规则先过一遍，明确不相关的不花 token（今天拦掉 73 条）。
- **Judge 二次判定**：本地拿不准才问模型，置信度阈值 0.6，不确定就沉默。
- **触发方式**：@ 我、回复我、提到名字、话题追问——共 4 条规则（`shouldReplyGroup`）。
- **四种模式**：`chat`（克制）/ `enhanced`（活跃，当前默认）/ `economy`（省）/ `normal`，运行时用 `/ai mode` 切，不用重启。
- **防刷**：群冷却 3s、按人冷却 2s、消息聚合 2.5s（连续几条合成一次）。

### 2. 上下文与记忆
- 群消息 30 条环形缓冲，**不全发**；按复杂度分级取 3 / 9 / 15 条。
- 每累计 60 条自动把较旧内容压成 3~5 行摘要（内存态，重启丢失）。
- 短期记忆 `sessions.json`（跨重启）、长期记忆 `notes.json`（模型主动调 `remember` 写入，最多每会话若干条）。

### 3. 多模态
- 图片理解（本地缓存优先）、视频抽帧、本地表情包发送、B 站链接解析。

### 4. 分享卡片与聊天记录
- 群里发的 B站/小黑盒卡片自动转成"标题+摘要+链接"文本再交给模型。
- 合并转发（聊天记录）可解析并回答"他们聊了什么/总结一下"。

### 5. 工具能力（Function Calling，10 个）
`web_search` / `fetch_url` / `get_current_time` / `remember` / `send_sticker` / `create_file` / `create_table` / `read_file` / `list_files` / `send_file`

### 6. Agent 多步子系统
`agent/` 下 5 个文件，最多 5 步、最多 5 次工具调用，用于需要多步查询/处理的任务，全程有日志（`memory/usage/agent.*.jsonl`）。

### 7. 可观测性与成本控制
- 用量看板：127.0.0.1:3001/，真实 token（取 API 返回的 usage，不估算）。
- 分账：answer / judge / tool / vision / video / agent / chatrecord 分开统计。
- 预算系统（`budget`，默认关闭）。
- 管理员私聊命令：`/ai mode|status|budget|stats`。
- 今日实测：101 次请求、59.3 万 token、76 条回复。

### 8. 安全
- **输出过滤**：把 API Key、Windows 路径、本地端口、内部模块名、身份误称（"我是 GPT/Claude"）、堆栈、提示词泄露等从回复里抹掉。
- **入网防护**：`url_safety.js` 拦截内网/回环/链路本地/CGNAT/保留段/IPv6 各类映射；`safe_http.js` 在 TLS 层固定 IP、重定向逐跳复检、连接/响应头/读取/总时长四档超时、大小限额（含解压后）。
- **权限**：管理员命令仅私聊，且只在配置白名单内生效。

### 9. 测试
8 个测试文件，944+ 断言，全绿：
`agent_a` 181 / `agent_b` 175 / `agent_c` 143 / `agent_c1` 80 / `agent_c2` 85 / `agent_c3` 79 / `s3_url` 201 / `s3_net`。
全部为纯本地（注入假 DNS、本地只绑 127.0.0.1 的服务），不发真实请求。

---

## 五、当前明确的边界（还没做的）

- **不会**自动记录每个群友的性格习惯，也**没有**按天/周/月的定期总结。长期记忆只有模型主动 `remember` 的少量自然语言条目，且不按人分档。
- **不会**主动接话：只有被 @、被回复、被提名字、话题追问这 4 种情况才可能回，其余一律沉默。
- **没有**群成员列表接口，昵称→QQ 反查不可靠。

---

## 六、进行中 / 规划中（均有独立方案文档，未经批准不动代码）

| 事项 | 状态 | 文档 |
|---|---|---|
| 安全阶段三 B3：网页入口接入 safeFetch + 限定公网测试 | 待批准 | `docs/s3_security_plan.md` |
| 群聊定时提醒系统 | 方案已定稿（v3），**排在 B3 验收之后**，R0-R5 分批 | `docs/reminder_design.md` |
| 自主进化（自主接话 / 群画像 / 成员画像 / Skill 蒸馏） | 阶段 0 审查完成、阶段 1 计划已提交，**等批准** | `docs/autonomous_evolution_plan.md` |

三条硬性纪律：**不与 B3 混批、不与提醒功能混批、任何回归失败先定位原因不得改旧测试让结果变绿**。

---

## 七、日常运维

- 启动：先 `启动NapCat.bat`（3000），再 `启动AI回复.bat`（3001）。改配置/改提示词后需重启桥接才生效。
- 备份：每次改动前整目录/单文件备份到 `backup/`，并记录 SHA256。
- 日志：`ai_bridge.log`（含明文，勿外发）、`memory/usage/*.jsonl`（按天用量）。
