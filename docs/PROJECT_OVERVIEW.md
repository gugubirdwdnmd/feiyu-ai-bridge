# 项目总览（当前状态快照）

> 生成时间：2026-10-24 ｜ 对应版本：桥接层 **V15.5+**，桌面控制中心 **v1.1.0**
> 隐私说明：本文档不写入任何真实 QQ 号、群号、API Key、本机用户名。`ai_bridge.log` 含明文，勿外发。
> 专项文档见 `docs/` 与 `feiyu-desktop/docs/`。

---

## 一、这是什么

一个跑在本机的 **QQ 群聊 / 私聊 AI 自动回复机器人**，附带一个**图形化管理桌面端**。

QQ 客户端的消息通过 NapCat 转成 OneBot11 协议事件推给本地桥接程序，桥接程序决定"要不要回、用什么模型、带多少上下文、调不调工具"，再调大模型 API 生成回复并回发到 QQ。

特征：**零第三方依赖**（只用它自带的 Node 22，无 npm 包、无 undici），全部自己实现；**配置驱动**（`ai_config.json`）；**本地预筛优先**（能不发 API 就不发，省 token）。

**两个组成部分**：

| 组成 | 位置 | 说明 |
|---|---|---|
| 桥接层 | 仓库根（`ai_bridge.js` 等） | 跑在 NapCat 旁边的无头服务，零第三方依赖 |
| 桌面控制中心 | [`feiyu-desktop/`](../feiyu-desktop/README.md) | Electron 图形化管理端（**唯一有 npm 依赖的子工程**） |

桌面端**不重写**桥接层业务逻辑，只做「读/写它的真实配置文件 + 启停进程 + 展示真实用量 + 外观自定义」。

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
| `feiyu/` | V15 行动型助手（**默认全关**，详见 `feiyu/V15_GUIDE.md`） |
| `skills.js` | 技能扩展：提示词注入 + 工具挂载 + 关键词触发（工具处理器有白名单） |
| `usage_report.js` | 用量明细聚合与白名单输出（供桌面端与 `/api/usage` 使用） |
| `tests/` | 22 个离线测试文件（`--quick` 模式）+ live 用例 |
| `build/build-exe.js` | SEA 打包脚本（单文件 exe） |
| `build/check-syntax.js` | 仓库级语法检查（遍历全部 .js） |
| `backup/` | 每次改动前的备份 |
| `docs/` | 方案与总览文档 |
| `feiyu-desktop/` | 桌面控制中心（Electron 独立子工程，见其 README） |

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
- **桥接层**：22 个离线测试文件（`node tests/run-all.js --quick`），全部为纯本地（注入假 DNS、本地只绑 127.0.0.1 的服务），不发真实请求。
- **桌面端**：384 条单元测试（`cd feiyu-desktop && node --test`），纯 Node、**不依赖 Electron 运行时**。
- **语法检查**：`npm run check` 遍历仓库全部 .js（根侧 83 个 + 桌面端 39 个），只做编译检查、不执行代码。
- **CI**：`.github/workflows/ci.yml` 在每次 push / PR 上跑桥接层离线测试、仓库级语法检查、桌面端单测与打包前检查。

---

## 五、当前明确的边界（还没做的）

- **不会**主动接话：只有被 @、被回复、被提名字、话题追问这 4 种情况才可能回，其余一律沉默。
- **没有**群成员列表接口，昵称→QQ 反查不可靠。
- 群友画像（V15.2）**默认关闭**，且只记录用户**明确自述**的内容；年龄、性别、婚恋、健康、宗教、政治、收入、住址、证件等敏感属性一律拒收。
- 语音识别 / 表情包联网检索 / 第三方短视频解析 / TTS 真实引擎**均未在本仓库环境真实验证**（零第三方依赖，未内置对应引擎），相关模块默认关闭且文档中已明确标注。
- 桌面控制中心**未做代码签名**，首次运行可能出现 SmartScreen 提示。

---

## 六、桌面控制中心（feiyu-desktop）

独立的 Electron 子工程，**不重写桥接层逻辑**，只做「读/写真实配置 + 启停进程 + 展示真实用量 + 外观自定义」。

| 页面 | 能力 |
|---|---|
| 总览 / 机器人运行 | 进程状态、启停 AI 桥与 NapCat、端口与日志 |
| API 与模型 | 多 Provider 注册表、凭据 DPAPI 加密、测试连接、差异预览 + 备份回滚 |
| 用量明细 | 时间/Provider/模型/状态筛选、耗时、CSV 导出、费用估算 |
| 人格设置 | 人格模板库（CRUD/复制/重命名/差异预览/回滚） |
| 技能扩展 | 技能库 CRUD，保存即生效 |
| ComfyUI 生图 | 检测/连通性/工作流/模型自动下载/大模型前置条件 |
| **主题工坊（v1.1.0）** | 6 套配色预设 + 自定义调色盘、4 种背景动画、圆角/毛玻璃、主题 JSON 导入导出 |
| 日志 / 导入导出 | 日志尾读与搜索（脱敏）；配置打包与恢复 |

安全边界：`contextIsolation: true` / `nodeIntegration: false`；渲染进程只经 `preload.js` 的固定通道列表调用 IPC，逐通道参数校验；密钥只回传掩码；主题只存 userData，与机器人目录完全分离。

详见 [`feiyu-desktop/README.md`](../feiyu-desktop/README.md) 与 [`feiyu-desktop/docs/USER_GUIDE.md`](../feiyu-desktop/docs/USER_GUIDE.md)。

---

## 七、进行中 / 规划中（均有独立方案文档，未经批准不动代码）

| 事项 | 状态 | 文档 |
|---|---|---|
| 安全阶段三 B3：网页入口接入 safeFetch + 限定公网测试 | 待批准 | `docs/s3_security_plan.md` |
| 群聊定时提醒系统 | 方案已定稿（v3），**排在 B3 验收之后**，R0-R5 分批 | `docs/reminder_design.md` |
| 自主进化（自主接话 / 群画像 / 成员画像 / Skill 蒸馏） | 阶段 0 审查完成、阶段 1 计划已提交，**等批准** | `docs/autonomous_evolution_plan.md` |

三条硬性纪律：**不与 B3 混批、不与提醒功能混批、任何回归失败先定位原因不得改旧测试让结果变绿**。

---

## 八、日常运维

- 启动：先 `启动NapCat.bat`（3000），再 `启动AI回复.bat`（3001）。改配置/改提示词后需重启桥接才生效。
- 图形化管理：安装并运行桌面控制中心（见 `feiyu-desktop/README.md`），可配置 Provider、管理人格与技能、查看真实用量、自定义主题。
- 备份：每次改动前整目录/单文件备份到 `backup/`，并记录 SHA256。
- 日志：`ai_bridge.log`（含明文，勿外发）、`memory/usage/*.jsonl`（按天用量）。
- 测试：`npm test`（桥接层离线用例）、`npm run check`（全仓语法检查）、`cd feiyu-desktop && npm test`（桌面端单测）。
