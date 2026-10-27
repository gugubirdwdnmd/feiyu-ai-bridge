# Feiyu Desktop 1.4 验收（ACCEPTANCE）

> 验收以**实际代码与测试结果**为准。任务书各阶段（A–M）对应项均给出证据（测试编号 / 构建产物 / 文件）。

---

## 1. 构建产物（build-win.sh，未签名，本机无证书属预期）

| 文件 | 大小 | SHA-256 |
| --- | --- | --- |
| `dist/肥鱼桌面控制中心-1.4.0-win-x64.exe` | 115,448,839 B | `25383F617E9A3F6DF79D2F898A03BF5F688A593EEA5B37F8093B23545AA3F19B` |
| `dist/肥鱼桌面控制中心-1.4.0-portable.exe` | 115,164,270 B | `5859E894B7F1C64CFDACFD0A09CA7F477236843D22B086A2AE27C91E3E62FE20` |

构建来源：仓库 `feature/full-upgrade`，`package.json` 版本 `1.4.0`，`electron-builder 25.1.8` / `electron 45.0.0`。

---

## 2. 验收清单

### A. 只读审计与测试基线
- [x] 仓库状态、分支、HEAD 已确认；既有服务调用链已通读。
- [x] 任务书点名文件确实存在且被真实调用（`handlers.js` 接线 22 个 EXT 通道）。
- [x] 测试基线建立：`test/extensionHub.test.js` 30 项 + `handlersRegistration.test.js` 9 项。

### B. 统一清单 / 状态模型 / 旧格式兼容
- [x] 严格清单校验（schemaVersion / 危险字段拒绝 / 路径穿越拒绝 / 未知字段警告剥离）— test 2,3,4,6。
- [x] 旧数据只读发现、不迁移、不改写 — test 15。

### C. 统一注册表与适配器
- [x] 注册表原子写、损坏回落、discover+index 合并 — test 16,17；legacyAdapters 包装 skill/mcp/workflow Service。

### D. 安装 / 更新 / 卸载 / 回滚
- [x] 安装成功落注册表 + 业务配置 — test 18。
- [x] SHA 不匹配回滚、无半安装 — test 19。
- [x] 取消无副作用 — test 20。
- [x] 卸载只删 own 文件 — test 21。
- [x] 升级失败回滚 — test 22。

### E. 依赖 / 兼容 / 冲突
- [x] 缺失 / 版本不满足 / id 冲突 / 依赖环 / Feiyu 不兼容 — test 7–11。

### F. 权限声明 / 授权 / 撤销 / 运行时拦截
- [x] 授权→放行、撤销→拦截、未知权限拒绝 — test 12–14。
- [x] 运行时拦截记录（blockedCalls）在权限中心 UI 展示。
- [x] 诚实声明无 OS 沙箱（UI 文案 + 审计文档）。

### G. MCP 受控运行与生命周期
- [x] stdio 需授权、未授权拦截 — test 25。
- [x] 授权后启动可见 — test 26。
- [x] 拒绝 shell 解释器 — test 27。
- [x] 远程健康检查（fake fetch）— test 28。
- [x] 退出清理 `mcpRuntime.stopAll()`（守卫后）— handlersRegistration 通过。

### H. 测试服务（静态 / Dry Run）
- [x] 静态检查标记危险字段与路径越界 — test 23。
- [x] workflow Dry Run 通过（已修 `await`）— test 24。

### I. UI（扩展中心 / 详情 / 管理 / 权限 / 开发者）
- [x] 渲染端「扩展中心」导航 + 5 个二级页全部按钮连到真实 EXT 逻辑（代码审查 + 全通道注册测试 test 173）。
- [x] 渲染进程无直接 fs/shell（仅 `f.invoke`）— handlersRegistration 未配置目录优雅报错 test 174。

### J. 日志 / 通知 / 诊断 / 备份接入
- [x] 扩展操作统一写 userData 通知中心（install/uninstall/upgrade/rollback/enable/disable/permission/mcp 均 `extNote`）。
- [x] 诊断采集包含扩展计数（`extCount/extEnabled`）。
- [x] 退出清理 MCP 进程。
- [x] 备份边界：扩展注册表位于 userData（与 botDir 分离），由 Extension Hub 生命周期自管（见 ARCHITECTURE §2）。

### K. 单元 / 集成 / 安全 / 回归测试
- [x] 1.4 专属 30 项；IPC 冒烟 9 项；全量 `npm test` **646/646 通过**。
- [x] 安全测试不伪造覆盖：SHA 校验、路径边界、权限拦截、shell 拒绝均有真实失败用例。

### L. 构建与启动冒烟
- [x] `bash build-win.sh` 成功产出 1.4.0 安装包（§1）。
- [x] IPC 启动冒烟 `handlersRegistration.test.js` 9/9（registerHandlers 在桩 Electron 下跑通，覆盖全通道注册 + 未配置目录优雅返回）。
- [ ] 完整 GUI 渲染冒烟：需带显示环境人工验证（与 Phase A 一致，交付前 GUI 验证由用户在本地执行；本报告不声称尚未执行的 GUI 测试已通过）。

### M. Git / 版本 / 产物复核与交付文档
- [x] 版本已 bump 至 `1.4.0`（`package.json`）。
- [x] 产物 SHA-256 见 §1。
- [x] 交付文档：`FEIYU_1.4_AUDIT.md`、`ARCHITECTURE.md`、`ACCEPTANCE.md`（本文件）。
- [x] **未提交、未推送**：用户已决定在下一个大版本 2.0.0 时推送，故标记为 unpublished（见最终交付报告）。

---

## 3. 完成标准核对

| 标准 | 状态 |
| --- | --- |
| 所有任务书点名文件存在且被真实调用 | ✅ |
| 不重新实现既有功能，仅补齐缺失测试/集成 | ✅ |
| 渲染端无直接 fs/shell，路径归一 + 穿越检查 | ✅ |
| 安装原子、可取消、卸载只删 own 文件、失败回滚 | ✅ |
| 权限运行时强制 + 诚实声明无 OS 沙箱 | ✅ |
| MCP 结构化启动、shell 拒绝、高危确认、SSRF 提示 | ✅ |
| 全量测试通过 + 构建产物可复现 | ✅ |
| 不伪造成功（测试含真实失败用例） | ✅ |
| 不推送（用户决定 2.0.0） | ✅ 标记为 unpublished |

---

## 4. 修复记录（本次交付内修正的真实缺陷）

1. 版本范围按空格分割缺失 → 改 `/[\s,]+/`（test 5）。
2. 安装 SHA 校验在 commit try 外 → 移入内（test 19）。
3. workflow Dry Run 漏 `await` → 补（test 24）。
4. shell 解释器被高危门禁误放行 → 提到最前（test 27）。
5. 市场大小上限测试参数名 `fetchImpl`→`fetchFn`（test 29）。
6. `app.on('before-quit')` 桩环境抛错 → 加存在性守卫（handlersRegistration 9/9）。
