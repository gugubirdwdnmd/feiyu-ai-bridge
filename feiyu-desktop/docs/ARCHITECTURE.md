# Feiyu Desktop 1.4 架构（ARCHITECTURE）

> 统一桌面扩展生态「Extension Hub」。本文档描述 1.4 新增模块的结构、数据流与边界，便于后续维护与审计。

---

## 1. 总览

```
┌─────────────────────────── 渲染进程 (renderer/) ───────────────────────────┐
│  导航「扩展中心」 → pageExtensionHub                                           │
│   SUBTABS: 扩展中心 / 扩展详情 / 扩展管理 / 权限中心 / 开发者工具              │
│  仅通过 window.feiyu.invoke(channel, args) 通信，无 fs / shell 直连            │
└───────────────┬───────────────────────────────────────────┬─────────────────┘
                │ ipcRenderer.invoke                        │ ipcRenderer.on (事件)
                ▼                                            ▼
┌─────────────────────────── 主进程 (src/ipc/handlers.js) ─────────────────────┐
│  22 个 EXT_* 通道 → 调用下方服务（带 validate 校验 + 用户数据作用域）         │
│  集成：日志/通知（userData）/ 诊断（扩展计数）/ 退出清理（mcpRuntime.stopAll）│
└───────────────┬──────────────────────────────────────────────────────────────┘
                ▼
┌─────────────────────────── 1.4 服务层 (src/services/) ────────────────────────┐
│  extensionManifest      统一清单：严格校验 / 路径归一 / 版本范围              │
│  extensionRegistry      注册表：发现旧配置(只读) / 索引 / 原子写 / 路径边界    │
│  dependencyResolver     依赖 / 兼容 / 冲突 / 环检测                          │
│  permissionService      权限目录 / 授权撤销 / 运行时校验 / 调用拦截日志        │
│  extensionTestService   静态检查 / Dry Run（绝不执行扩展脚本）                │
│  extensionLifecycle     安装/启用/禁用/升级/卸载/回滚（快照+原子+互斥+取消）   │
│  extensionMcpRuntime    MCP 受控运行（结构化启动 / shell拒绝 / 高危确认）      │
└──────────────────────────────────────────────────────────────────────────────┘
                │
                ▼ 复用既有服务（不重新实现）
   skillService / mcpService / workflowService / diagnosticService / logService
   安装目录固定在 userData/feiyu-extensions；业务配置写入 botDir（保持旧格式）
```

---

## 2. 数据边界

| 数据 | 位置 | 管理者 | 备注 |
| --- | --- | --- | --- |
| 扩展注册表 | `userData/feiyu-extension-registry.json` | Extension Hub | `origin=installed, owned=true` |
| 权限状态 | `userData/feiyu-extension-permissions.json` | Extension Hub | 运行时拦截记录 |
| 扩展文件 | `userData/feiyu-extensions/<dir>/` | Extension Hub | 仅删 own 文件 |
| 旧配置（技能/MCP/工作流） | `botDir/feiyu_*.json` | 各自 Service | 仅**只读发现**为 `discovered`，不迁移、不改写 |
| 通知 / 诊断 | `userData` | diagnosticService | 扩展事件落到此处 |

**原则**：userData 与 botDir 分离；安装/卸载只动 Extension Hub 拥有的文件；botDir 业务文件由既有 Service 写入，不破坏用户既有结构。

---

## 3. 安装流程（extensionLifecycle.install）

```
validateManifest ──▶ dependencyResolver.resolve（缺依赖/不兼容则中止）
   │
   ▼ 快照（registry + 相关 botDir 配置）
   ▼ 取消检查点 #1（提交前可无副作用取消）
   ▼ 大小上限检查（MAX_STAGED_BYTES=256MB）
   ▼ commit try {
        暂存目录写入（逐文件 SHA-256 校验，不匹配即抛 → 回滚）
        写 manifest.json + 原子 rename 各文件
        注册表 upsert
        注册到 botDir 业务配置（skill/mcp/workflow，经 legacyAdapters）
        安装后路径边界校验
        落盘注册表
      } catch → rollbackFromSnapshot（恢复 registry + botDir 配置 + 删扩展目录）
```

并发：`withLock` 以 Promise 链串行化所有写操作，避免半安装竞态。

---

## 4. 权限模型

- 目录（`PERMISSION_CATALOG`，8 项）每项带 `risk`。
- 授权：`grant(state, id, scope, source)`；撤销：`revoke(state, id, scope)`（scope 省略则撤全部）。
- 运行时：`checkRuntime` 在 MCP 启动等被调用，未授权即 `blocked`；每次调用 `recordCall` 入日志，`blockedCalls` 供 UI 展示。
- **诚实边界**：本机无 OS 沙箱，拦截为进程内强制校验（见 FEIYU_1.4_AUDIT §5、§11）。

---

## 5. MCP 受控运行

- stdio：`spawn(argv[0], argv.slice(1), { shell:false })`；拒绝 `cmd/powershell/bash/sh/zsh` 作为可执行文件；高危项需 `ackHighRisk`。
- 远程（sse/http/streamable-http/websocket）：不 spawn，仅健康检查探测，且要求 https + 非内网（SSRF/loopback 提示）。
- 权限门禁：stdio 需 `process.spawn` 授权；远程需 `network.outbound` 授权；未授权直接拦截。
- 退出清理：`app.on('before-quit')` → `mcpRuntime.stopAll()`（已加存在性守卫）。

---

## 6. IPC 通道清单（EXT_*）

索引/发现/详情/校验/解析：`EXT_INDEX EXT_DISCOVER EXT_DETAIL EXT_VALIDATE_MANIFEST EXT_RESOLVE`
生命周期：`EXT_INSTALL EXT_ENABLE EXT_DISABLE EXT_UPGRADE EXT_UNINSTALL EXT_ROLLBACK EXT_PLANNED_REMOVAL`
权限：`EXT_PERMISSIONS EXT_PERMISSION_GRANT EXT_PERMISSION_REVOKE EXT_PERMISSION_STATE`
测试：`EXT_TEST_STATIC EXT_TEST_DRYRUN`
MCP：`EXT_MCP_LIST EXT_MCP_START EXT_MCP_STOP EXT_MCP_HEALTH`

每个通道在 `handlers.js` 中均有对应 `ipcMain.handle`，并经 `validate(CHANNELS.X, args)` 做参数校验（非法参数不会触碰文件，见 handlersRegistration 测试）。

---

## 7. 渲染端 UI

- 导航入口：渲染 `index.html` 的「扩展中心」按钮。
- 聚合页：`SUBTABS.extensionHub` 五个二级页，沿用既有 `mountGroup` 渲染范式。
- 通信：所有动作经 `f.invoke(EXT_*, args)`；订阅事件用 `f.on`（返回取消订阅函数，切页时 `runCleanups` 清理，防内存泄漏）。
- 五个二级页职责：
  - **扩展中心**：列出全部扩展 + 粘贴清单安装（校验→解析→安装）。
  - **扩展详情**：按 id 查看清单/权限/依赖/兼容/历史版本。
  - **扩展管理**：启用/禁用/卸载/升级/回滚/计划移除预览。
  - **权限中心**：授权/撤销 + 运行时拦截与调用日志。
  - **开发者工具**：静态检查 / Dry Run / MCP 受控启停。

---

## 8. 测试与构建

- 单元/集成/安全：`test/extensionHub.test.js`（30）。
- IPC 冒烟：`test/handlersRegistration.test.js`（9，验证全通道注册 + 未配置目录优雅报错）。
- 全量：`npm test` → 646 通过。
- 构建：`bash build-win.sh`（关闭自动签名发现）→ `dist/*.exe`（未签名，预期）。
- 语法门禁：`npm run check`（`node --check` 覆盖全部 src/renderer/build 脚本）。
