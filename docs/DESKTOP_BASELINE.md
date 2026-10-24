# Feiyu Desktop Control Center — 改造基线报告（阶段 1）

> 只读检查结论，基于 `feature/feiyu-v15.2-group-memory` (HEAD `5798b52`) 真实源码。
> 改造分支：`feature/feiyu-desktop-control-center`（从当前 HEAD 拉出，不碰 main、不碰现有 bot 代码）。

## 0. 仓库与运行事实

- 语言/运行时：零第三方依赖的 Node.js 项目，`engines.node >= 22`（本机 v22.22.2）。入口 `ai_bridge.js`。
- 启动：`node ai_bridge.js`（AI 桥，HTTP `127.0.0.1:3001`）；NapCat 外部服务 `node index.js -q <qq>`（HTTP `127.0.0.1:3000`）。机器人核心与 NapCat 是**两个独立进程**。
- 配置：`ai_config.json`（删除则全走 `DEFAULT_CONFIG` 默认值），密钥 `secrets.json`（或环境变量 `DEEPSEEK_API_KEY` / `NAPCAT_ONEBOT_TOKEN`）。两者均被 `.gitignore` 排除。
- **启动自检**：`ai_bridge.js` 发现无 API Key 会 `process.exit(1)`，监听根本不启动。→ 桌面端启动前必须保证 `secrets.json`/环境变量就绪。
- 现有打包：`build/build-exe.js` 用 Node 22 SEA 把 `ai_bridge.js` 打成单文件 `dist/qq-ai-bot.exe`（需联网拉 esbuild/postject）。

## 1. 可直接复用的现有能力（不重写）

- **配置深合并**：`mergeConfig(base, over)` + `loadConfig()`（ai_bridge.js:532-577）已处理「用户只写部分字段」「新增配置段不静默丢弃」「读坏回落默认不崩」。桌面端配置读写应复用同一套语义（可搬运该函数，避免自己实现导致行为不一致）。
- **真实用量数据源（已有）**：
  - 逐条明细：`memory/usage/YYYY-MM-DD.jsonl`（每行：`time/kind/model/prompt_tokens/completion_tokens/reasoning_tokens/cache_hit_tokens/cache_miss_tokens/total_tokens/chatId/chatRecordId`，**不含聊天内容、不含 Key**）。
  - 聚合日账：`memory/stats.json`（promptTokens/completionTokens/cacheHitTokens/modelUsage/groups 等）。
  - HTTP 接口：`GET /api/usage?range=today|yesterday|7d|month|all` 返回聚合+最近 50 条明细+聊天记录分析；`GET /` 返回 `{"status":"alive"}`（健康检查）。
  - → 「用量明细」页**不需要新建采集器**，直接读 JSONL / 调 `/api/usage` 即可。
- **人格/系统提示词**：`ai_prompt.txt` 为纯文本 system prompt，`buildSystemPrompt()` 经 `loadPrompt()` 注入；保存即生效（不重启）。`ai_config.json` 顶层 `personality` 段（name/humor/proactive/defaultResponseLength/groups）为结构化人格字段。
- **运行时状态（内存）**：`RUNTIME_PAUSED`/`RUNTIME_MOOD`/`AI_MODE`（chat|enhanced|economy|normal），`/ai reload` 可热重载配置。
- **安全过滤**：`sanitizeOutput()`/`LEAK_RULES`（ai_bridge.js）已是「命中只脱敏片段」模式——桌面端日志脱敏应复用同类规则，不要重新发明。

## 2. 需要新增接口 / 适配层

- **Desktop Service 层**（新增）：配置服务、用量查询服务、日志查询服务、进程管理服务、导入导出服务。全部以「读机器人目录下的真实文件 / 调其 HTTP 接口」方式集成，不修改 bot 核心。
- **进程管理适配层**（新增）：桌面端要 spawn/stop `ai_bridge.js` 与 `index.js`，需 `spawn({detached})`+`child.unref()` 常驻、优雅关闭（SIGTERM→有界等待→SIGKILL）、按 PID 精确结束、启动前查重（端口/进程已占用则拒绝重复启动）。**不可**用 `taskkill` 模糊匹配 `node.exe`（会误杀 WorkBuddy 等）。
- **目录解析适配层**（新增）：机器人目录不能硬编码 D 盘。默认相对 app 解析，提供首启动向导让用户选择 bot 目录，存于用户数据目录（`app.getPath('userData')`）。
- **密钥桥接**（新增）：桌面端用 Electron `safeStorage` 保管 Key，启动机器人时再把 Key 写入 bot 目录 `secrets.json`（或注入环境变量），退出清理不落明文到导出包。
- **配置 Schema 包装**（新增）：导出/导入需 `schemaVersion` + 软件版本；现有 `ai_config.json` 无版本字段，需在外层包装（保留原 `ai_config.json` 结构不被破坏）。

## 3. 已存在、不可重复开发的功能

- 用量统计与明细（见 1）——不要另建一套采集。
- 配置读取/合并/热重载（见 1）。
- 人格 system prompt 注入（见 1）。
- 安全脱敏规则（见 1）。
- 单文件 exe 打包思路（`build-exe.js`）——桌面版改用 electron-builder，但「同目录带可写配置/密钥运行」的思路一致。
- 现有 `dashboard/index.html` 用量看板（只读 HTTP 页面）——可参考其字段与口径，但它是只读、不能控制；桌面版要补齐启停/配置/导入导出。

## 4. 目前没有数据来源、必须新增采集/机制的功能

- **费用估算**：配置与用量记录里**均无价格表**。`stats.json` 只有 token 数，无金额。→ 需新增「价格配置」（按模型/输入/输出/缓存分别计价，记录价格版本），费用按 usage 计算；无法计算显示「未计价」而非 0。
- **单请求耗时 / HTTP 状态码 / 错误类别**：JSONL 明细**不含**耗时与错误分类（仅 `stats.errors` 聚合计数）。→ 如需「请求耗时」「失败状态」逐条展示，需在 bot 端 `recordUsage` 增加字段（属 bot 改动，需单独评估与确认），或用「未采集」占位。MVP 先用现有字段，缺字段显「未知/未采集」。
- **群聊设置**：`ai_config.json` 的 `group` 段已有 allow/mode/replyProbability/cooldown 等，但桌面端「群聊设置」页要做「按群覆盖」需要 `group.groups` 或 `personality.groups` 已有结构支撑——需确认 bot 是否真的按群读取这些覆盖（避免 UI 写了不生效）。MVP 先暴露全局 group 段。
- **记忆管理**：`memory/memory_store.js` + `group_profile.js` 是程序内部存储，桌面端「记忆管理」若要做增删查改需新增只读查询 + 受控写接口（避免直接编辑内部 JSON 破坏隔离键）。
- **工具与功能开关**：`feiyu/` 下 taskManager/browser/notifier/tts/qzone 等均为「顶层键、默认关、mock 仅占位」，真实能力未验证（UNVERIFIED）。桌面端开关这些不应假装已可用。

## 5. 桌面化安全 / 兼容性风险

- **密钥泄露面**：现有 `secrets.json` 明文存盘（已被 gitignore）。桌面端若导出配置或打诊断包，必须脱敏/排除 Key；绝不把 Key 进 URL、渲染进程日志、错误弹窗。
- **进程隔离**：Renderer 必须 `contextIsolation:true` + `nodeIntegration:false`；Preload 只暴露固定、经参数校验与来源检查的 IPC 通道；禁止 UI 传入任意命令行字符串执行。
- **误杀风险**：停止机器人必须按精确 PID（从端口 LISTENING 拥有者反查），禁止 `taskkill /IM node.exe`（会杀 WorkBuddy 自身 node）。
- **外部 NapCat 依赖**：打包不能把「NapCat 未包含」宣传成全套独立运行。桌面端必须区分「本软件已启动」与「NapCat 已就绪」，分别检测端口 3000/3001 并给出未安装/未启动/连接失败原因。
- **便携 vs 安装**：便携版用程序旁 `data/` 目录并检测写入权限；安装版用 `userData`；升级不得清空用户数据；不得把运行时配置与仓库示例配置混为一谈。
- **原生模块 / 中文路径 / 空格**：electron-builder 需处理 asar 内外路径、中文用户名目录、`%LOCALAPPDATA%` 空格；`__dirname` 在打包后与开发期不同，目录解析一律走 `app.getAppPath()` / `app.getPath()`。
- **杀软误报**：SEA/electron 打包的 node 二进制常触发误报，需在发布说明给出白名单/签名说明。

## 6. 阶段 A（MVP）范围裁定

可运行、可验证、不破坏现有功能地交付：

1. Electron 主窗口 + 左侧导航 + 总览/运行/API与模型/人格/日志 五个页面（用量/导入导出/诊断做最小可用或占位并显「未采集」）。
2. 配置读写（复用 `mergeConfig` 语义）接真实 `ai_config.json`；人格编辑接真实 `ai_prompt.txt`。
3. 进程管理：启动/停止/重启 NapCat+AI桥，端口检测，精确 PID 结束，启动前查重，无 Key 时显「未配置」。
4. 日志查看 + 脱敏（复用 `LEAK_RULES` 同类口径）。
5. 用量页读真实 JSONL + `/api/usage`（bot 运行时）；无数据时显「暂无数据/未采集」。
6. 最小打包脚本（electron + electron-builder 配置）+ 可复现测试（mock Provider / 临时目录 / 模拟进程）。

多 Provider 完整抽象、费用估算、按群覆盖、记忆增删改、安装/便携双包发布 → 阶段 B/C。
