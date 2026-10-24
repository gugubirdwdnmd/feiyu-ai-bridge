# 肥鱼桌面控制中心 — 阶段 A（MVP）交付报告

- 分支：`feature/feiyu-desktop-control-center`（基于 `feature/feiyu-v15.2-group-memory` HEAD `5798b52`）
- 日期：2026-10-24
- 范围：Electron 桌面 MVP，复用现有 NapCat+OneBot QQ AI 机器人核心，不重写其业务逻辑。

## 1. 实际新增/修改的文件

全在 `feiyu-desktop/`（仓库根 `D:/NapCat_publish/feiyu-desktop`），未触碰机器人现有文件、真实配置、密钥或运行中的服务。

源码：
- `src/main.js` — Electron 主进程：窗口生命周期、`botDir` 解析（不硬编码 D 盘）、IPC 注册。`contextIsolation:true, nodeIntegration:false`。
- `src/preload.js` — 唯一桥：仅暴露受控 `invoke(channel,args)` 与通道常量，不泄漏 Node/fs/进程能力。
- `src/ipc/handlers.js` — 22 个 IPC 处理器，均先经 `ipcChannels.validate` 校验再调服务；含 `dialog:pickDir` 目录选择。
- `src/services/redact.js` — 共享脱敏（密钥/路径/端口/内部组件/栈/提示词），口径同 `ai_bridge.js` 的 `LEAK_RULES`。
- `src/services/configService.js` — `ai_config.json` 读取/深合并/校验/原子写（复用 `mergeConfig` 语义）。
- `src/services/personalityService.js` — `ai_prompt.txt` 读写（保存即时生效）。
- `src/services/secretService.js` — `secrets.json` 读写，POSIX chmod 600。
- `src/services/usageService.js` — 用量查询：优先实时 `/api/usage`，回退 `memory/usage/*.jsonl` + `stats.json`；费用仅在有价格表时估算。
- `src/services/logService.js` — 日志尾部/搜索，GBK 安全读 + 脱敏。
- `src/services/processService.js` — 进程启停：精确 PID 停止（绝不 `taskkill /IM node.exe`）、启动去重、优雅关闭、DI 可测。
- `src/services/importExportService.js` — 配置导出/校验/差异预览/导入（默认不含密钥，失败闭合）。
- `src/services/ipcChannels.js` — 固定通道名 + 每通道参数校验。
- `renderer/index.html` `renderer/renderer.js` `renderer/styles.css` — 8 个页面 UI（总览/运行/API与模型/用量/人格/日志/导入导出/关于）+ 机器人目录选择。

构建/配置/测试：
- `package.json`、`build/electron-builder.yml`、`build/package-check.js`、`build/no-sign.js`、`test/*.test.js`（6 个）、`.gitignore`、`docs/DESKTOP_BASELINE.md`（基线报告，阶段 A 前置）。

## 2. 主要设计决策

- **复用而非重写**：桌面端只读写机器人真实配置文件（`ai_config.json`/`ai_prompt.txt`/`secrets.json`）与实时接口（`/api/usage`、`netstat` 端口探活），不复制机器人核心或 `DEFAULT_CONFIG`。
- **真实数据、零伪造**：用量来自 `memory/usage/*.jsonl` 与运行中的 `/api/usage`；无价格表时费用显示「未计价」，绝不冒充账单。
- **安全边界**：
  - Renderer 经 preload 仅能调用固定 IPC 通道；Main 端逐通道校验参数 + 来源。
  - 密钥不进导出包、不进日志、不在错误对话框暴露；仅 `window` 内 password 输入框可见，落地为磁盘明文文件（POSIX 收紧 600，Windows 依赖目录隔离 + `.gitignore`）。
  - 停止进程按端口 LISTENING 拥有者反查精确 PID，避免误杀 WorkBuddy 等。
  - `botDir` 由用户设置决定，不硬编码。
- **目录解析**：dev 下 `appPath/..` 探测到真实机器人目录；打包后用户通过「选择目录」指定现有机器人目录（桌面不自带机器人核心，符合「复用现有核心」）。
- **可测性**：所有服务支持依赖注入（mock spawn/execFile/sleep/platform），单测不依赖 Electron/真实进程/真实机器人。

## 3. 新增功能（MVP）

- 桌面 GUI：总览（状态卡 + 今日用量）、机器人启停/重启（含 NapCat 快速登录）、Provider/模型配置、密钥管理、人格编辑（即时生效）、用量明细（含费用估算开关）、日志查看/搜索、配置导入导出（含差异预览/自动备份）、关于。
- 机器人目录选择（系统目录对话框，仅回传路径字符串）。
- 进程管理：查重、精确 PID 停止、优雅关闭。
- 导入导出：schemaVersion 版本化、默认排除密钥、未知顶层键拒绝、失败时闭合不写盘、应用前自动备份。
- 打包前合规检查脚本（`package-check.js`）。

## 4. 测试命令与实际退出码

- 语法检查：`node --check` 遍历全部 19 个 `.js`（src/test/build）→ 全部 OK，退出 0。
- 单元测试：`node --test`（等价 `npm test`）→ `# tests 39 / pass 39 / fail 0`，退出 0。
  - 修复了 3 个初始失败：redact 测试用键过短（`sk-abc`→`sk-abc123def456`）；`validateImport` 将 config 字段错误由 warning 提升为 error（破坏性覆盖必须闭合）；`diffPreview` 断言改对（`configDiff.api.to.model`）。
- 打包前检查：`node build/package-check.js` → 全部 ✓，退出 0。
- 主进程冒烟：`electron smoke-main.js` → 输出 `SMOKE_OK handlers=22`（22 个 IPC 注册无异常），退出 0（临时文件已删除）。
- 真实启动：`electron .` 在无显示的 headless 环境下仍成功创建窗口并存活 20s（仅 GPU/网络服务子系统报环境噪声，无应用层错误），证明桌面应用能启动。

## 5. 未通过的测试

无。39/39 通过。

## 6. 仍未实现的功能（Phase B / C）

- **Phase B**：用量采集聚合的「成本估算价格表」UI（目前价格表经 userData `price.json` 手动放置，无录入界面）；多 Provider 抽象；导入导出完整备份/回滚；人格模板库；用量图表。
- **Phase C**：诊断/安全加固（`sandbox` 当前为 `false`，preload 需加载本地模块；计划内联通道常量后开启 `sandbox:true`）；安装版/便携版自动化兼容测试；README；自动更新（可选）。
- **已知约束**：真实费用依赖用户提供价格表；导入为整体覆盖（非合并），用户应先导出完整配置或仅做全量恢复。

## 7. 打包结果

- electron-builder 配置合法（解析 `package.json` build + `electron-builder.yml` 无错）。
- **应用打包成功**：产出 `dist/win-unpacked/肥鱼桌面控制中心.exe`（约 249 MB，完整 Windows x64 Electron 可执行 + resources）。
- **安装版/便携版封装受阻（环境限制，非代码缺陷）**：electron-builder 在 Windows 上对可执行文件做代码签名，需下载 `winCodeSign` 工具；其归档内含 macOS `.dylib` 符号链接，本沙箱无创建符号链接权限（`SeCreateSymbolicLinkPrivilege`/Developer Mode），7-Zip 解压失败 → nsis 安装包与 portable 单文件未能生成。
  - 在开启 Developer Mode 或以管理员运行的普通 Windows 开发机上，`npm run dist` 会正常产出 `肥鱼桌面控制中心-<ver>-win-x64.exe`（nsis 安装版）与 `肥鱼桌面控制中心-<ver>-portable.exe`（便携版）。
  - `build/no-sign.js` 已提供：需本地验证未签名构建时可用 `electron-builder --win --x64 --config.win.sign=build/no-sign.js`（正式发布仍应由 CI 提供真实证书，勿提交到 `electron-builder.yml`）。
- Electron 版本说明：声明 `electron: ^45.0.0`；本构建环境的 Electron 二进制镜像固定返回 v24.22.0，故本地 `node_modules/electron/dist` 实为 v24。应用代码仅用稳定 API（contextIsolation/contextBridge/dialog），v24 与 v45 均可运行；在正常联网环境 `npm install` 会得到 v45。

## 8. 配置与数据迁移风险

- **不破坏现有功能**：桌面端只读/写与机器人相同的真实文件；机器人仍在原目录运行，桌面仅探活端口、读日志/用量，不在未授权时启停。
- **密钥**：桌面写 `secrets.json` 与机器人同一文件，语义一致；导出默认不含密钥，私密迁移需显式勾选并单独保管。
- **配置兼容**：导入用 `validateImport` 拒绝未知顶层键与类型错误；config 字段级错误阻断整体覆盖（与 `applyConfig` 口径一致），防止写入会让机器人启动即退出的坏值。
- **目录**：`botDir` 默认指向探测到的现有机器人目录；若误配，UI 会提示「未找到 ai_bridge.js」，不静默失败。
- **迁移到打包版**：打包后的应用目录不含机器人核心（符合「复用现有核心」），首次使用需在「关于/运行」页指定现有机器人目录（指向 `D:/NapCat_publish` 或同等位置）。
- **git 边界**：本提交仅新增 `feiyu-desktop/`，未重置/清理/覆盖已有改动，未合并 main、未推送。
