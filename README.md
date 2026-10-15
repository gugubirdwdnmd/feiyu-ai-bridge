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
| 测试 | 18 个测试文件、上千条断言；离线用例零网络依赖，live 用例（本机 ComfyUI）在无后端时自动跳过 |

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

删掉 `ai_config.json` 则全部走内置默认值。

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
├─ agent/                  多步 Agent 子系统（agent_core / intent / state / tool_router）
├─ tools/                  工具层：web / bilibili / image / video / file / memory / result / chat_record
├─ chat_record_parser/     合并转发与聊天记录解析
├─ memory/                 记忆模块（运行时数据 json 不入库）
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
6. **已知未完成**：`safe_http.js` 尚未接入网页抓取入口，该入口的防护仍在进行中。

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
A：**没有**，本项目不含任何语音识别或语音合成能力。

---

## 免责声明

- 本项目为**个人学习与研究用途**的桥接层实现，不包含、不分发任何 QQ 客户端文件或第三方框架二进制。
- 使用第三方 QQ 协议实现可能违反相关平台的用户协议，**请自行评估并遵守所在地区的法律法规与平台规则，风险由使用者自行承担**。
- 本项目不对使用者的账号安全、封禁风险或任何损失负责。

## 许可证

本项目采用 [MIT](./LICENSE) 许可证。
