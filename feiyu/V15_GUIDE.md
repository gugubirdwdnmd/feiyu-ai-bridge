# 肥鱼 V15：行动型 AI 助手 — 配置 / 运行 / 回滚 / 安全边界

> 适用版本：提交 `6bb6ffc` 起的 V15 修复（本目录 `feiyu/*`、`tools/feiyu.js`；经 `e2be70d`、`e40bd12` 等修正）。本次追加：通知目标模块内强制白名单、通知重试确定性测试、浏览器请求级 SSRF 拦截逻辑（真实浏览路径为 UNVERIFIED）。
> 设计原则：**默认全关、fail-closed、不联网、不连真实 QQ、不调付费 API、不破坏记忆格式与普通聊天。**
> 所有对外动作（执行任务、浏览器、通知、TTS、QQ空间）默认仅管理员可触发，且真实能力默认关闭。

---

## 1. 配置（写入 `D:\NapCat\ai_config.json` 的【顶层键】）

注意：**这些是顶层键**，不要写成嵌套的 `"feiyu"` 段。代码读取的就是 `config.taskManager` / `config.browser` / `config.notifier` / `config.tts` / `config.qzone`。

### 1.1 最小可用（推荐：仅登记，不真执行）

```jsonc
{
  "admin": { "qq": ["你的管理员QQ"] },   // 必须：决定谁能管任务/发布
  "taskManager": { "enabled": true },     // 任务生命周期（创建/调度/暂停/取消）可用
  "browser":     { "enabled": false },    // 浏览器默认关
  "notifier":    { "enabled": false },    // 主动通知默认关
  "tts":         { "enabled": false },    // 语音默认关（mock 也不开）
  "qzone":       { "enabled": false }     // QQ空间默认关
}
```

> 没有注入真实执行器（`deps.runTask`）时，任务只完成「生命周期登记」（`executed=false`），**不会假称已执行任何工作**。

### 1.2 开浏览器（仅 mock，白名单 + SSRF 双重防护）

```jsonc
"browser": {
  "enabled": true,
  "provider": "mock",            // 默认 mock；真实 Playwright 需 allowRealBrowse=true + 注入 playwright
  "allow": ["*.example.com"],    // 也接受 allowDomains 别名；白名单是必要不充分条件
  "timeoutMs": 30000
}
```

> 即便在白名单内，URL 仍须通过 `url_safety.isSafeUrl`：拒绝内网/环回/链路本地/云元数据/带凭据 URL。
> 真实 Playwright 浏览默认关闭；开启后每个请求（含重定向、子资源）都做 DNS 解析后 IP 分类校验以阻断重绑定，但 Playwright 不支持对任意主机做 IP 固定，故属尽力而为。

### 1.3 开主动通知（去重/频率/静默/失败重试）

```jsonc
"notifier": {
  "enabled": true,
  "quietHours": { "start": "23:00", "end": "08:00" },   // 也接受 quietStart/quietEnd 别名
  "rateLimitPerTarget": 10,                              // 也接受 maxPerTargetPerHour 别名（每目标/分钟）
  "rateWindowMs": 60000,
  "dedupWindowMs": 300000,
  "maxRetries": 3,
  "retryBaseMs": 30000,
  "maxQueue": 500,
  "sentRetentionMs": 86400000,        // sent 记录保留 24h
  "deadRetentionMs": 604800000        // 失败(dead)记录保留 7 天后清理
}
```

> `targets` 默认取 `admin.qq`；队列有容量上限（默认 500，超出丢弃最旧 pending）；`flush` 有防重入锁，重试受 `nextRetryAt` 控制（未到时间不重试）。
> 目标限制（重要）：收件人由【通知模块内部】强制白名单（仅 `admin.qq` / 授权名单），调用方传入任意 `target` 会被拒绝（`target-not-allowed` / `target-invalid`），不依赖上层 admin 检查；`sendToMaster` 也仅向配置主人发送（纵深防御）。缺配置时拒绝发送。

### 1.4 TTS 与 QQ空间（真实能力默认关闭）

```jsonc
"tts":  { "enabled": true, "provider": "mock", "maxBytes": 1048576, "maxDurationMs": 30000, "format": "mp3", "outDir": "workspace/feiyu/tts" },
"qzone":{ "enabled": true, "realEnabled": false, "maxPerDay": 3 }
```

> - **TTS**：`provider=mock` 仅生成占位音频（MP3 帧头 + 静音体），**不是真实中文朗读**，仅供格式/体积校验；真实语音需另行授权并配置 local/cloud 引擎。工具描述已明确「mock 非真实语音」，不会误导。
> - **QQ空间**：当前无任何合规开放发布接口，本适配器只做预览/模拟发布；`realEnabled` 默认 `false`，即使设为 `true` 且无合规渠道也直接拒绝真实发布。

---

## 2. 启动与每分钟心跳

- 普通聊天/记忆/生图/戳一戳等原有功能**完全不受影响**（V15 模块独立、默认关闭）。
- 肥鱼模块由 `tools/feiyu.js` 在工具注册时 `initFeiyu()` 装配；任务调度与通知冲刷需由宿主每分钟调用一次心跳：
  ```js
  const feiyu = require('./feiyu').getFeiyu();
  setInterval(() => feiyu && feiyu.tick(), 60 * 1000); // tick() 内部：taskManager.tick() + notifier.flush()
  ```
- 任务事件（完成/失败/创建/取消）在通知启用时私聊通知 `admin.qq`；**未真正执行的「已登记」任务会单独标注「仅生命周期登记，未执行」**，与「执行成功」区分。

---

## 3. 回滚

所有 V15 改动均为新增/原地修改，未删除任何旧能力。回滚任选其一：

1. **配置回滚（最快、零代码）**：把 `ai_config.json` 里的 `taskManager/browser/notifier/tts/qzone` 五个顶层键删掉或设 `"enabled": false`，重启服务即恢复为纯聊天模式（原有记忆/聊天配置不动）。
2. **文件回滚**：本次修改前已对每个文件做 SHA-256 备份，见 `D:\NapCat\backups\feiyu_v15_fixes_*/SHA256.txt`。逐文件用备份覆盖即可，或 `git` 在镜像仓库 `D:\NapCat_publish` 回退到 `6bb6ffc`。
3. **全局禁用肥鱼工具**：在 `tools/feiyu.js` 的 `register()` 中不调用 `initFeiyu()` 即可（不影响其它工具）。

---

## 4. 安全边界 / 明确未授权或不可完成项

- **真实浏览器操作**：默认关闭；开启真实 Playwright 后仅做尽力而为的 SSRF/重绑定防护，不保证绝对安全 —— 不应对任意主机做 IP 固定。
- **真实浏览器【未验证 UNVERIFIED】**：本仓库为「零第三方依赖」，未安装 playwright/puppeteer，真实浏览路径未经端到端验证；其请求级 SSRF / 重定向 / DNS 重绑定拦截逻辑有确定性单测覆盖（mock 浏览器 + 注入 DNS，不联网），但未做真实浏览器 e2e，请勿据此宣称端到端验证。
- **通知目标限制（模块内部强制）**：收件人仅限配置的主人 QQ / 授权名单；调用方传入任意 `target` 在通知模块内被拒绝（`target-not-allowed` / `target-invalid`），不依赖上层 admin 检查；`sendToMaster` 也仅向配置主人发送（纵深防御）；缺配置时拒绝发送。
- **真实语音（TTS）**：mock 仅为占位音频，**绝不宣称真实中文语音**；真实引擎需另行授权。
- **真实 QQ空间发布**：无合规开放接口，代码层拒绝真实发布（即便 `realEnabled=true`）。
- **任务真实执行**：无 `deps.runTask` 时任务只登记不执行（`executed=false`），通知明确区分「已登记」与「已完成」。
- **取消语义（V15.1 增强）**：`cancel()` 在运行中仅「**请求**」中断并**如实说明**——无法立即中断的底层操作（已发起的网络请求/子进程）可能仍执行完毕，系统不保证瞬时中止。V15.1 起：执行上下文提供**真实 `AbortSignal`**（`ctx.signal`/`ctx.abort()`），执行器可将其透传给 `fetch`/`http.request`/`spawn` 从而真正中断；任务字段 `cancelRequested`/`executionStopped` 如实区分「已请求取消」与「已确认停止」，执行器真正退出时补记 `stop-confirmed`，**忽略信号的长任务不会被显示为已停止**。
- **超时语义**：超时不再无脑重试，标记 `timedOut` 并视为失败；同样发出中断信号（`ctx.abort('timeout')`），但**不**标记为用户取消（两种语义不混淆）；若执行器忽略信号，`executionStopped=false` 且错误信息如实提示「底层可能仍在运行」，其结果不会被采纳。
- **任务数据保护（V15.1）**：JSON 损坏/未知格式时保留 `.corrupt-*` 原文件副本；**若该备份写入失败则进入隔离模式**，`save()` 抛 `EQUARANTINE` 拒绝覆盖原文件（绝不静默清空或覆盖唯一的原始数据），需人工处理后显式 `discardQuarantine()`。临时文件写入失败与 `rename` 原子替换失败均抛错、清理残留 tmp 并保持原文件不变。
- **外部输入**：参数/网页输入/模型输出均经 `permissions.validateTaskParams`/`sanitizeText` 校验；高危工具名（shell/文件写/键鼠等）被黑名单拒绝；普通成员或网页输入无法越权操作系统。

---

## 5. 测试

离线、不联网、不连真实 QQ、不调付费 API。临时数据落在系统临时目录并在退出时清理。

```bash
# 单跑肥鱼套件
node tests/feiyu_upgrade.test.js

# 本地离线总入口（仅含 D:\NapCat 本地存在的离线用例）
node tests/run-all.js

# 镜像仓库离线总入口（含 feiyu_upgrade.test.js）
node ../NapCat_publish/tests/run-all.js --quick
```

覆盖：JsonStore 损坏/未知格式区分、容量轮转；**任务数据保护（损坏备份失败→隔离拒写、临时写入失败、原子替换失败，原文件均不被覆盖/清空）**；成本控制；权限/越权；任务生命周期/重试/超时/并发/幂等/过期/重启恢复；可取消上下文（运行中取消、暂停恢复）；**取消与超时诚实性（真实 AbortSignal、响应信号被真正中断、忽略信号不谎报已停止、stop-confirmed、超时与取消语义区分）**；通知去重/频率/静默/失败重试/`nextRetryAt`（重试用注入时钟确定性推进，不靠真实等待）/失败记录保留；**通知目标限制（授权通过 / 未授权 target-not-allowed / 非法格式 target-invalid / 缺配置拒绝 / 空白名单拒绝 / allowedTargets 不可被 `enqueue(null)` 绕过 / `setTargets` 撤销后旧目标立即失效 / 工具层 notify_send 越权拒绝）**；浏览器白名单 + SSRF（私网/环回/元数据/凭据拒绝）；**浏览器请求级 SSRF 拦截逻辑（公网放行、私网/云元数据/DNS 重绑定拦截，确定性、不访问真实外网）**；TTS 失败/体积/时长；QQ空间 mock/去重/默认禁真实；工具注册与仅管理员调用；无执行器任务状态区分；**配置模板一致性（JSON 合法、顶层键、默认全关、真实浏览/Qzone 真实能力默认关、字段与代码默认值一致、无硬编码密钥）**；V15 测试是否被默认入口执行。
