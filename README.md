# QQ 群聊 AI 桥接层（qq-ai-bot）

一个**零第三方依赖**的 QQ 群聊 / 私聊 AI 自动回复**桥接层**，可打包为**单文件 exe**。

消息经由 [NapCat](https://github.com/NapNeko/NapCatQQ)（OneBot11）推送到本桥接层，桥接层决定"要不要回、用什么模型、带多少上下文、调不调工具"，再调用大模型生成回复，最后通过 NapCat 发回 QQ。

```
QQ 服务器
   │
QQ 客户端（NapCat 注入，3000 端口，OneBot11 HTTP）
   │  事件上报 / 反向调用
   ▼
本桥接层 ai_bridge.js（3001 端口）  ← 你看到的就是这一层
   │
   ├─ 本地预筛（不花钱）
   ├─ AI 判定（可选，阈值 0.6，不确定就沉默）
   ├─ 上下文组装 + 记忆注入
   ├─ 工具调用（联网 / 读文件 / 记忆 / 建表 / Agent 多步 / 生图）
   └─ 输出安全过滤（抹掉密钥、路径、端口、内部模块名）
   │
   ▼
大模型 API（默认 DeepSeek）  +  本机 ComfyUI（生图，可选）
```

**本仓库只包含自研的桥接层代码，不包含任何 QQ 客户端文件、NapCat 发行包或第三方二进制。**

---

## 功能清单

### 已实现

| 功能 | 说明 |
|---|---|
| 群聊 / 私聊回复 | 本地预筛先过，拿不准才调判定器；置信度阈值 0.6，低于阈值保持沉默 |
| 四种运行模式 | `at`（仅被 @）/ `smart`（智能预筛，推荐）/ `all`（每条都回）/ 运行时可切换，无需重启 |
| 上下文管理 | 30 条环形缓冲，按问题复杂度分级取用（3 / 8 / 15 条），每 60 条自动压缩为摘要 |
| 记忆 | 短期会话记忆 + 长期记忆（模型可主动调用 `memory_write` 记录明确事实） |
| 多模态 | 图片理解、视频抽帧、表情包处理（依赖模型侧多模态能力） |
| 图片记忆 | 跨消息累积记住最近 6 张图（5 分钟 TTL、去重、私聊同样生效），支持「先发图、再打字」 |
| 链接与卡片解析 | B 站视频信息、QQ 分享卡片 |
| 聊天记录分析 | 合并转发消息的解析与归纳 |
| 多图工作流 | 连发两张图可触发本地 ComfyUI 图像工作流（合成 / 处理，见 `workflows/`） |
| 工具调用 | 14 个内置工具：联网搜索、网页抓取、读时间、记笔记、发文件、建表格、生图等 |
| Agent 多步 | 最多 5 步的多步任务执行 |
| 用量看板与分账 | 单文件 HTML 看板；按 `answer` / `judge` / `vision` / `agent` 分类统计 token |
| 输出安全过滤 | 自动抹除 API Key、本机绝对路径、端口号、内部模块名、"我是 GPT"类身份误称 |
| 入网安全 | `url_safety.js`：IPv4/IPv6 全特殊段识别、拒绝 userinfo、DNS 解析后分类、防 DNS 重绑 |
| 任务与主动汇报（V15，默认全关） | `feiyu/`：任务调度（可取消/超时）、主动通知、预算控制。**所有新功能默认关闭**，未配置执行器时任务仅登记不执行 |
| 群聊智能决策（V15.2，默认关） | 复用既有群缓冲与判定结果做一次**本地**复核：已回答过的问题不重复回答、未成句的消息等后续而不是抢答。**不新增任何模型调用** |
| 群友轻量画像（V15.2，默认关） | 扩展既有记忆体系（非第二套存储）：按「群号+QQ号」隔离记住称呼/风格/明确兴趣/进行中项目；区分「用户明确说过」与「系统推测」，敏感属性一律不记录，默认不公开 |
| 测试 | 16 个测试文件、上千条断言；离线用例零网络依赖，live 用例（本机 ComfyUI）在无后端时自动跳过 |

---

## 环境要求

- **Node.js v22.x**（用到全局 `fetch` 与现代 `dns` API）
- 一个可用的 **NapCat**（OneBot11）实例，HTTP 服务监听 `127.0.0.1:3000`
- 一个大模型 API Key（默认适配 DeepSeek）
- （可选）本机 **ComfyUI**：用于 AI 生图与图像工作流处理

**零第三方依赖** —— 不需要 `npm install`，只用 Node 内置模块（`fs` / `path` / `http` / `https` / `dns` / `crypto` / `zlib`）。

---

## 快速开始

### 方式一：exe 直接运行（推荐，无需装 Node）

到 [Releases](../../releases) 下载 `qq-ai-bot.exe`，把 `ai_config.json`、`secrets.json` 放到 exe 同目录，双击运行即可（AI 桥监听 3001 端口，等 NapCat 把消息推进来）。

> 注：exe 只含 AI 桥本身。QQ 协议端（NapCat 框架）、本地表情包 `stickers/`、视频元数据能力（依赖 NapCat 自带 ffmpeg addon）不在 exe 内，完整玩法请用方式二源码运行，或把这些目录一并放到 exe 同目录。

### 方式二：源码运行

```bash
git clone <你的仓库地址>
cd qq-ai-bot
node ai_bridge.js
```

### 配置（两种方式都需要）

1. **API Key**（二选一，推荐环境变量）：

```bash
# Windows PowerShell
$env:DEEPSEEK_API_KEY = "sk-你的密钥"
# Linux / macOS
export DEEPSEEK_API_KEY="sk-你的密钥"
```

或在 exe / 源码同目录创建 `secrets.json`（**已被 .gitignore 排除，切勿提交**），模板见 `secrets.example.json`。

2. **复制配置模板**：`cp ai_config.example.json ai_config.json`，然后按需修改：

| 字段 | 说明 |
|---|---|
| `group.mode` | `smart` 智能预筛（推荐）/ `at` 仅被 @ / `all` 每条都回 |
| `judge.confidenceThreshold` | 判定阈值，默认 0.6，越低越爱说话 |
| `admin.qq` | **管理员 QQ 号数组**，改成你自己的 |
| `budget.enabled` / `daily_tokens` | 每日 token 预算，默认关闭 |
| `agent.enabled` | 多步 Agent 开关 |
| `image.*` | 生图后端（本机 ComfyUI），工作流配置见 `workflows/README.md` |
| `taskManager` / `browser` / `notifier` / `tts` / `qzone` | **V15 功能，默认全部 `false`**；均为**顶层键**（不是嵌套在 `feiyu` 下）。详见 `feiyu/V15_GUIDE.md` |
| `groupDecision` | **V15.2 群聊智能决策，默认 `false`**。纯本地规则复核，**不增加模型调用** |
| `groupProfile` | **V15.2 群友轻量画像，默认 `false`**。按「群号+QQ号」隔离，敏感属性不记录，默认不公开 |

删掉 `ai_config.json` 则全部走内置默认值。

> **V15 说明**：这 5 个顶层键控制任务调度、浏览器自动化、主动通知、语音、QQ 空间。
> 模板里它们**默认全关**，真实浏览器（`allowRealBrowse`）、真实通知、真实 QQ 空间发布
> （`realEnabled`）也**默认关闭**。启用前请先读 `feiyu/V15_GUIDE.md` 了解各模块的
> 未验证项与安全边界。

> **V15.2 说明**：`groupDecision` 与 `groupProfile` 也**默认关闭**，需显式设为 `true`。
> 画像只在你**明确自述**（"我叫…"、"我喜欢…"、"以后叫我…"）或多次重复表现出稳定风格时才记录；
> 推测类内容注入时会标注「（推测）」且置信度低，不会当作事实。管理命令：`/画像`、`/画像状态`、`/画像清空确认`。

3. **NapCat 侧**：新增一个 OneBot11 HTTP 服务端，监听 `127.0.0.1:3000`，消息格式设为 `array`，上报地址指向本桥接层的 `3001` 端口；Token 填到 `secrets.json` 的 `onebotToken`。

启动成功会在日志输出监听端口、当前模型与密钥来源。用量看板：`http://127.0.0.1:3001/`。

---

## 打包成 exe

```bash
node build/build-exe.js
```

产物在 `dist/qq-ai-bot.exe`（约 80MB，内嵌 Node v22 运行时）。原理是 Node 22 官方的
**Single Executable Application（SEA）**：把 `ai_bridge.js` 及其本地模块打进 node 二进制，
运行时仍在 exe 同目录读写 `ai_config.json` / `secrets.json` / `memory/` / `workspace/`。
要求本机有 Node v22（用于生成 blob）与网络（首次会临时拉取 `postject`）。

Windows 上也可用 `npm run build:exe`。

---

## 测试

```bash
npm test          # 跑全部（live 用例无 ComfyUI 时自动跳过）
node tests/run-all.js
```

离线用例（意图识别、记忆、安全、解析）**零网络依赖、不产生 API 费用**；
live 用例（真实出图 / 图像工作流）需要本机 ComfyUI，未运行时会打印 SKIP 而不是失败。

---

## 目录结构

```
.
├─ ai_bridge.js            主程序：事件接收、预筛、上下文、工具调度、发送
├─ ai_prompt.txt           人设提示词（修改它即可调整说话风格）
├─ ai_config.example.json  配置模板（真实配置 ai_config.json 不入库）
├─ secrets.example.json    密钥模板（真实 secrets.json 不入库）
├─ agent/                  多步 Agent 子系统（agent_core / intent / state / tool_router / group_decision）
├─ tools/                  工具层：web / bilibili / image / video / file / memory / result / chat_record / feiyu
├─ feiyu/                  V15 行动型助手（**默认全关**，详见 feiyu/V15_GUIDE.md）
│                          task_manager / task_store / notifier / browser_adapter /
│                          tts / qzone_adapter / cost_control / permissions
├─ memory/                 记忆模块（group_log / memory_store / daily_summary / **group_profile**）
├─ chat_record_parser/     合并转发与聊天记录解析
├─ workflows/              ComfyUI 图像工作流（含说明）
├─ dashboard/index.html    用量看板（单文件）
├─ stickers/               本地表情包目录（图片丢进去即可，需自备）
├─ tests/                  测试（*.test.js 离线 + _test_*.js live）
├─ build/build-exe.js      SEA 打包脚本
└─ docs/                   设计文档
```

---

## 安全边界（请务必阅读）

1. **密钥**：只从环境变量或 `secrets.json` 读取，源码无兜底密钥；输出过滤会抹除回复中可能出现的密钥串。
2. **入网**：`url_safety.js` 拒绝内网 / 回环 / 链路本地 / CGNAT / 保留段 IP，拒绝带 userinfo 的 URL，并在解析后固定 IP 以防 DNS 重绑。
3. **文件读取白名单**：只允许机器人自身目录与 NapCat 图片缓存目录，拒绝目录穿越。
4. **管理员命令**：仅私聊管理员可用（默认 `private_only`），不会被群消息触发。
5. **输出过滤**：抹除本机绝对路径、端口号、内部模块名、身份误称。
6. **安全下载传输层**：`safe_http.js` 已接入网页抓取 / 图片下载 / 网页搜索 / 云端图 URL / 视频 URL 兜底下载等生产入口（统一走 `safeFetch`：固定已校验 IP + socket 远端 IP 复核 + 逐跳重定向重校验 + 压缩前/后双字节上限 + 四档超时），消除「先校验 DNS 再裸连接」的 DNS 重绑定窗口。防护行为由 `tests/s3_net.test.js`（110 条断言，本地 127.0.0.1 受控服务）真实验证。
7. **主动通知收件人（V15）**：`feiyu/notifier.js` 在 `enqueue()` **模块内部**强制校验接收人必须属于配置的授权名单（主人 QQ / `admin.qq`），传入名单外目标一律拒绝（`target-not-allowed`），非法格式拒绝（`target-invalid`），**未配置合法接收人时拒绝发送**（`no-target`）。不依赖上层工具层的管理员检查，也不静默改投其他目标；运行时 `setTargets()` 会同步刷新名单，已撤销的目标立即失效。
8. **真实浏览器【未验证 UNVERIFIED】**：`feiyu/browser_adapter.js` **默认关闭真实浏览**（`allowRealBrowse=false`，`provider=mock`）。开启需同时显式开启开关**并**由宿主注入兼容的 Playwright 实例，缺实例即 fail-safe 拒绝。仓库为「零第三方依赖」、未安装任何浏览器库，**真实浏览路径未经端到端验证**——其请求级 SSRF / 重定向 / DNS 重绑定拦截逻辑仅有确定性单测覆盖（mock 浏览器 + 注入 DNS，不联网）。请勿据此宣称端到端验证；且 Playwright 不支持对任意主机做 IP 固定，防护属尽力而为。
9. **任务取消与超时（V15）**：任务上下文提供真实 `AbortSignal`，执行器可透传给 `fetch`/`http`/`spawn` 真正中断。系统**如实区分「已请求取消」与「已确认停止」**：忽略信号的长任务不会被显示为已停止（`executionStopped=false`），系统不保证瞬时中止。无执行器时任务仅登记（`executed=false`），不假称已执行。
10. **任务数据保护（V15）**：JSON 损坏/未知格式时保留 `.corrupt-*` 原文件副本；**若备份写入失败则进入隔离模式**，`save()` 抛 `EQUARANTINE` 拒绝覆盖原文件，绝不静默清空或覆盖唯一的原始数据（需人工处理后显式解除）。临时写入失败与原子替换失败均抛错、清理残留并保持原文件不变。
11. **QQ 空间发布**：无合规开放接口，代码层拒绝真实发布（即便 `realEnabled=true`）。
12. **群友画像（V15.2）**：默认关闭。画像是**既有长期记忆的扩展**（同一份存储、同一套治理），不是第二套记忆。隔离键为「群号+QQ号」，**不同群、不同成员的画像绝不混用**。严格区分「用户明确说过」（高置信）与「系统推测」（低置信，注入时标注「（推测）」，不会当作事实）。**年龄、性别、婚恋、健康、宗教、政治、收入、住址、证件等敏感属性一律拒收**（即使本人自述也不记录），且推测类需多条样本才成立，避免凭单条消息给成员贴标签。默认**不向群内公开**任何人的画像，非管理员也无法查看他人画像。

---

## 常见问题

**Q：一定要用 DeepSeek 吗？**
A：默认适配 DeepSeek，但 API 调用集中在少数几处，换其他兼容 OpenAI 格式的服务改动不大。

**Q：为什么它不回我？**
A：检查三处：`group.mode` 是否为 `at`；是否被本地预筛拦掉（看日志"群预筛"）；判定置信度是否低于阈值。

**Q：图像工作流没反应？**
A：确认本机 ComfyUI 已在运行、对应工作流文件与自定义节点就位（见 `workflows/README.md`），并且按该文档的图片顺序与触发词操作。

**Q：会不会很费钱？**
A：本地预筛不花钱；只有进入判定和生成才调用模型。建议开启 `budget.enabled` 设置每日上限。

**Q：有语音功能吗？**
A：**没有内置的真实语音能力**。本项目不含任何语音识别（STT）能力。V15 起提供了 TTS 接口层（`feiyu/tts.js`），但默认 `provider=mock` 只产出**占位音频**（MP3 帧头 + 静音体，仅供格式/体积校验），**不是真实中文朗读**；真实引擎需自行接入 `local`/`cloud` provider 并另行授权。

---

## 免责声明

- 本项目为**个人学习与研究用途**的桥接层实现，不包含、不分发任何 QQ 客户端文件或第三方框架二进制。
- 使用第三方 QQ 协议实现可能违反相关平台的用户协议，**请自行评估并遵守所在地区的法律法规与平台规则，风险由使用者自行承担**。
- 本项目不对使用者的账号安全、封禁风险或任何损失负责。

## 许可证

本项目采用 [MIT](./LICENSE) 许可证。
