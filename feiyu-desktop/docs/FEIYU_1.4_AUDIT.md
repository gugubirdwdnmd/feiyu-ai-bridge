# Feiyu Desktop 1.4 安全与代码审计（FEIYU_1.4_AUDIT）

> 版本：1.4.0（Extension Hub —— 统一桌面扩展生态）
> 审计范围：Phase 1 只读基线 + 1.4 新增模块（7 个服务 + IPC 通道 + 渲染端 UI + 测试）
> 审计原则：**以实际代码与测试结果为准**，不靠计划文档代替交付；**不重新实现既有功能**，只补齐缺失的测试/集成。

---

## 0. 结论

- 仓库状态：分支 `feature/full-upgrade`，工作区为 1.4.0 全量实现，未提交、未推送（用户已决定在下一个大版本 2.0.0 时再推送）。
- 测试：全量 `npm test` **646 / 646 通过**；其中 1.4 专属 `test/extensionHub.test.js` **30 / 30 通过**；IPC 注册冒烟 `test/handlersRegistration.test.js` **9 / 9 通过**。
- 构建：`bash build-win.sh` 成功产出 `肥鱼桌面控制中心-1.4.0-win-x64.exe` 与 `…-portable.exe`（未签名，本机无证书，属预期）。
- 安全关键项（SHA 校验、路径边界、权限运行时拦截、MCP 结构化启动、shell 解释器拒绝）均有对应单元测试覆盖并通过。

---

## 1. Phase 1 只读基线（执行顺序 A）

| 检查项 | 结果 |
| --- | --- |
| 仓库/分支/HEAD 干净度 | 已确认（实现前 `feature/full-upgrade`，干净工作区） |
| 既有服务调用链 | 已通读 `skillService / mcpService / workflowService / configService / ipcChannels / handlers / main / preload / renderer` |
| 任务书点名文件确实存在且被真实调用 | `extensionManifest / extensionRegistry / dependencyResolver / permissionService / extensionTestService / extensionLifecycle / extensionMcpRuntime` 全部新增并由 `handlers.js` 真实接线 |
| 可复用既有模式 | 原子写（tmp+rename）、依赖注入（fsImpl/now/spawnImpl）、校验白名单、`registerHandlers`、`render/mountGroup/SUBTABS` UI 范式——1.4 全部沿用，未另起炉灶 |

---

## 2. 统一扩展清单（extensionManifest）

| 要求 | 实现 | 测试证据 |
| --- | --- | --- |
| `schemaVersion` 严格校验 | `validateManifest` 仅接受 `schemaVersion === 1`，未知版本拒绝 | test 4 |
| 危险字段拒绝 | `DENY_FIELDS`（scripts/postinstall/preinstall/install/hooks 等）整体拒绝，不剥离后执行 | test 2 |
| 字段白名单 + 未知字段仅警告剥离 | `ALLOWED_FIELDS` 之外仅 warning 并剥离，不影响安装 | test 6 |
| 路径穿越 / 绝对路径拒绝 | `normalizeRelPath` 拒绝 `../`、`/abs`、`a/../../b` | test 3 |
| 长度/深度/数量/大小上限 | 清单与文件声明层面约束（size 上限 + 安装层 `MAX_STAGED_BYTES=256MB`） | test 18/29 |
| 版本范围解析 | `versionSatisfiesRange` 支持 `^ ~ >= <= > < =` 与逗号/空格 AND（**已修正**：原仅按逗号分割，现按 `/[\s,]+/`） | test 5 |
| 旧数据兼容 | 不强制迁移 `feiyu_skills.json / feiyu_mcp.json / feiyu_workflows.json`，只**只读发现**为 `origin=discovered, owned=false`，绝不改写用户文件 | test 15 |

---

## 3. 统一注册表（extensionRegistry）

- `loadRegistry/saveRegistry`：写入走 `tmp + rename` 原子写，损坏数据回落默认（test 17）。
- `discover(botDir, fsImpl)`：读三类旧配置，技能校验用纯函数 `skillService.validateSkill`，**只读到内存，不落盘**（test 15）。
- `buildIndex`：合并 installed + discovered，installed 优先（test 16）。
- `validateOwnedPaths`：安装后再次校验所有 owned 文件路径不出扩展根目录（防穿越）。

---

## 4. 依赖 / 兼容 / 冲突（dependencyResolver）

`resolve(manifest, index, {expectedAppVersion})` 返回 `{ok, errors, warnings, missing, conflicts, incompatible}`，覆盖：

- 缺失依赖、版本范围不满足、id 冲突、依赖环（`detectCycle`）、Feiyu 版本不兼容（test 7–11）。
- 安装前置在 `handlers.EXT_INSTALL / EXT_UPGRADE` 中强制 `resolve` 通过，未通过直接返回错误，**不落盘**。

---

## 5. 权限模型（permissionService）

- `PERMISSION_CATALOG`：8 项已知权限（ext.meta.read / file.read.scoped / config.write.scoped / network.outbound / process.spawn / feiyu.service.call / message.send / data.modify.business），每项带 `risk`。
- **运行时强制**（不是只弹 UI）：
  - `checkRuntime` 在 MCP 启动等环节被调用；未授权返回 `blocked:true`，调用被拦截。
  - `recordCall` 记录每次调用（放行/拦截）；`blockedCalls` 供权限中心展示拦截历史。
  - 测试覆盖：授权→放行、撤销→拦截、未知权限拒绝（test 12–14）。
- **诚实声明无 OS 沙箱**：权限拦截是进程内强制校验，本机没有系统级沙箱。这一点在权限中心 UI 文案与本文档中明确写出，不假装“操作系统级隔离”。

---

## 6. 安装 / 更新 / 卸载 / 回滚（extensionLifecycle）

- 流程：快照 → 暂存（含 **SHA-256 逐文件校验，已修正放进 commit try 内**，不匹配即回滚）→ 原子写 → 注册表更新 → 业务配置联动（skill/mcp/workflow）→ 安装后路径校验 → 落盘。
- 并发互斥：`withLock` Promise 链串行化安装/升级/卸载/回滚。
- 取消：`cancelToken` 在提交前返回无副作用（test 20）。
- 回滚：失败恢复快照，无半安装残留（test 19）。
- 卸载：**只删本扩展 own 的文件**（`EXT_ROOT/<dir>`），绝不递归删未确认目录；不碰其它扩展（test 21）。
- 升级失败回滚到上一版本（test 22）。
- `plannedRemoval` 提供“将删哪些文件”的可解释预览，不真正删除（test 相关）。

---

## 7. 测试服务（extensionTestService）

- `staticCheck`：只解析清单/路径/字段/权限 + 复用 `mcpService.reviewServer` 做静态审查，**绝不执行扩展自带脚本**（test 23）。
- `dryRun`：
  - workflow → `workflowService.runWorkflow(dryRun=true)`（默认只演练，不启动服务/发通知）。
  - skill → `skillService.validateSkill`；mcp → `mcpService.parseConfig`。
  - **已修正**：workflow 分支原先漏写 `await`（async `runWorkflow` 返回 Promise 被当成同步结果，导致误报失败）；现补 `await` 后通过（test 24）。

---

## 8. MCP 受控运行（extensionMcpRuntime）

- 结构化启动：`spawn(argv[0], argv.slice(1), { shell:false })`，**绝不拼接 shell**（test 25–26）。
- **shell 解释器拒绝**：`SHELL_BIN`（cmd/powershell/bash/sh/zsh）作为可执行文件直接拒绝（**已修正**：原高风险门禁先于该检查，shell 会被误放行；现提到最前**，test 27）。
- stdio 需 `process.spawn` 已授权；远程需 `network.outbound` 已授权；未授权直接拦截（test 25）。
- 高危项需用户在权限中心显式 `ackHighRisk` 确认后才能启动。
- 远程传输只做健康检查探测，不长期持有进程（test 28）。
- 退出清理：`app.on('before-quit')` 调 `mcpRuntime.stopAll()`（**已加 `app.on` 存在性守卫**，见 §10）。

---

## 9. UI（渲染端，扩展中心）

- `renderer/index.html` 新增导航「扩展中心」；`renderer/renderer.js` 新增 `pageExtensionHub` + 5 个二级页（扩展中心 / 扩展详情 / 扩展管理 / 权限中心 / 开发者工具），沿用既有 `SUBTABS/mountGroup` 范式。
- 渲染进程**只通过 `window.feiyu.invoke` 与主进程通信**，无直接 `fs`/`shell`（test 173 全通道注册 + 未配置目录优雅报错）。
- 所有按钮均连到真实 `EXT_*` 逻辑：安装/启用/禁用/卸载/升级/回滚/计划移除/权限授权撤销/静态检查/Dry Run/MCP 启停。
- 权限中心展示运行时拦截记录与近期调用日志，诚实呈现“无 OS 沙箱”。

---

## 10. 集成与修复记录（本次审计发现并修正的真实问题）

| # | 现象 | 根因 | 修复 | 验证 |
| --- | --- | --- | --- | --- |
| 1 | 版本范围 `3.0.0` 被 `>=1.0.0 <2.0.0` 误判满足 | `versionSatisfiesRange` 仅按逗号分割范围 | 改为按 `/[\s,]+/` 分割 | test 5 |
| 2 | 安装 SHA 不匹配时抛未捕获异常、无回滚 | SHA 校验在 commit `try` 之外 | 移入 commit `try` 内，失败即回滚 | test 19 |
| 3 | workflow Dry Run 误报失败 | `dryRun` 漏 `await` async `runWorkflow` | 补 `await` | test 24 |
| 4 | shell 解释器被高危门禁误放行 | `SHELL_BIN` 检查晚于高风险门禁 | 提前到最前 | test 27 |
| 5 | 市场大小上限未触发 / 回退真实网络 | 测试传 `fetchImpl`，源码参数为 `fetchFn` | 测试改为 `fetchFn` | test 29 |
| 6 | IPC 注册冒烟 8 项失败 | `app.on('before-quit')` 在无 `app.on` 的桩环境抛错 | 加 `app && typeof app.on === 'function'` 守卫 | handlersRegistration 9/9 |

> 说明：#1–#4 为源码真实缺陷（已修）；#5 为测试桩参数名错误（已修，源码 `fetchFn` 正确）；#6 为守卫缺失（已修）。

---

## 11. 已知边界（诚实声明）

- **无 OS 级沙箱**：权限拦截依赖进程内强制校验；扩展脚本/命令的最终隔离靠“结构化启动 + 不拼接 shell + 拒绝 shell 解释器 + 高风险的显式确认”，而非操作系统沙箱。
- **二进制扩展文件**：当前渲染端“粘贴安装”仅支持 UTF-8 文本文件内联；二进制扩展走市场下载通道（由主进程 `fetch` 取字节），不在渲染端直接读盘。
- **扩展注册表位于 userData**：与 botDir 业务目录分离，由 Extension Hub 自身生命周期（安装/卸载/回滚）管理；botDir 备份不触碰 userData（符合“不覆盖用户数据”原则）。
- **未签名构建**：本机构建未配置证书，安装包未签名（用户环境预期行为），SHA-256 见 ACCEPTANCE.md。

---

## 12. 交付物

- 源码：7 个新增服务 + `ipcChannels` 22 个 `EXT_*` 通道 + `handlers.js` 全量接线 + 渲染端扩展中心 UI。
- 测试：`test/extensionHub.test.js`（30）、`test/handlersRegistration.test.js`（9），全量 646 通过。
- 构建：`dist/肥鱼桌面控制中心-1.4.0-win-x64.exe`、`.portable.exe`（SHA-256 见 ACCEPTANCE.md）。
- 文档：`FEIYU_1.4_AUDIT.md`（本文件）、`ARCHITECTURE.md`、`ACCEPTANCE.md`。
- Git：未提交、未推送，状态见最终交付报告（用户决定在 2.0.0 推送）。
