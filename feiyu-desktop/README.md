# 肥鱼桌面控制中心（feiyu-desktop）

基于现有 NapCat + OneBot QQ AI 机器人核心（`ai_bridge.js`）的**图形化管理桌面端**。
不重写机器人业务逻辑，只做「读/写它的真实配置文件 + 启停进程 + 展示真实用量」。

---

## 1. 功能概览

| 页面 | 能力 |
| --- | --- |
| 总览 | 机器人进程状态、今日请求数（成功/失败）、关键入口 |
| 机器人运行 | 启停 AI 桥 / NapCat、查看进程与端口 |
| API 与模型 | 多 Provider 注册表（增删改查/默认/测试/应用）、凭据安全状态与加密迁移 |
| 人格设置 | 人格模板库（CRUD/复制/重命名/差异预览/备份回滚）+ 应用到机器人 |
| 用量明细 | 时间范围 + Provider/模型/状态筛选、耗时、CSV 导出、费用估算与价格表 |
| 日志 | ai_bridge.log 尾部/搜索（展示前脱敏） |
| 导入导出 | 配置导入导出（默认不含密钥）、差异预览、应用前备份 |

---

## 2. 目录与运行方式

```
feiyu-desktop/
├── src/
│   ├── main.js              # Electron 主进程：窗口、bot 目录解析、safeStorage 注入
│   ├── preload.js           # 唯一渲染桥：仅暴露 invoke(channel, args)
│   ├── ipc/handlers.js      # 全部 IPC 处理器（先 validate 再调 Service）
│   └── services/            # 无 Electron 依赖的纯服务（可单测）
├── renderer/                # 原生 JS 前端（无框架）
├── test/                    # node:test 单测（纯 Node，不依赖 Electron）
├── build/                   # electron-builder 配置与打包前检查脚本
└── docs/                    # 阶段报告与字段映射
```

### 2.1 开发模式

```bash
cd feiyu-desktop
npm ci          # 首次或 lockfile 变更后；npm install 亦可
npm start       # 启动 Electron
npm test        # node --test
npm run package-check   # 打包前静态检查
```

### 2.2 机器人目录（botDir）解析

桌面端通过 `botDir` 定位机器人项目根（需含 `ai_bridge.js`）。解析顺序：

1. 用户设置中保存的 `botDir`（「机器人运行」页可手动选择）
2. 打包内自带 `bot/`
3. 开发期仓库根（`feiyu-desktop/..`）
4. **便携/安装版**：exe 同级及上溯两级的 `bot/`、`NapCat_publish/`（不硬编码盘符）
5. 用户主目录下的 `NapCat_publish/`、`bot/`

若均未命中，界面提示手动选择目录（不会自动写入任何真实路径）。

---

## 3. 打包（Windows x64）

### 3.1 产物类型区别

| 产物 | 形态 | 说明 |
| --- | --- | --- |
| `dist/win-unpacked/` | **免安装目录** | 直接运行 `肥鱼桌面控制中心.exe`。本仓库已验证可生成。 |
| `dist/肥鱼桌面控制中心-0.1.0-win-x64.exe` | **NSIS 安装包** | 标准安装程序，可选安装目录。**沙箱环境因符号链接权限无法生成**，需在普通 Windows 开发机执行。 |
| `dist/肥鱼桌面控制中心-0.1.0-portable.exe` | **便携版单文件** | 同 NSIS 限制。 |

> `win-unpacked` 与 NSIS 安装版是**两种不同产物**，不能互相替代：
> 前者是解压即用的目录，后者是自解压安装程序（写注册表/开始菜单/卸载项）。

### 3.2 在普通 Windows 开发机上生成 NSIS 安装包

前置条件：Node ≥ 22、可访问 npm registry。

```bash
cd feiyu-desktop
npm ci
npm run package-check          # 静态合规检查（版本/lockfile/安全配置/无密钥）
npx electron-builder --win nsis portable
```

产物位于 `dist/`：

- `肥鱼桌面控制中心-0.1.0-win-x64.exe`（NSIS 安装包）
- `肥鱼桌面控制中心-0.1.0-portable.exe`（便携版）

> 若只想验证「能打出来」，先执行 `npx electron-builder --win --dir`，
> 只生成 `dist/win-unpacked/`，不触发 NSIS 打包链路。

### 3.3 沙箱环境的已知限制

当前开发沙箱缺少创建符号链接的权限，electron-builder 在生成 NSIS/portable 时
需要解压 `winCodeSign`/`nsis` 资源（内部含符号链接），会失败。
**不要重复执行同一失败命令**；请在普通 Windows 开发机按 3.2 执行。

---

## 4. 数据位置与升级/卸载

| 数据 | 位置 | 升级/卸载 |
| --- | --- | --- |
| 桌面设置（botDir 指向） | `%APPDATA%/肥鱼桌面控制中心/feiyu-settings.json` | 保留（`deleteAppDataOnUninstall: false`） |
| 价格表 | `%APPDATA%/肥鱼桌面控制中心/price.json` | 保留 |
| 桌面 Provider 注册表 | `<botDir>/feiyu_providers.json` | 保留（不含明文密钥） |
| 桌面 Provider 密钥 | `<botDir>/feiyu_provider_secrets.json` | 可迁移为系统凭据加密 |
| 机器人配置/人格/密钥 | `<botDir>/ai_config.json`、`ai_prompt.txt`、`secrets.json` | 保留 |
| 机器人记忆/日志/用量 | `<botDir>/memory/`、`ai_bridge.log` | 保留 |

**用户数据与安装目录完全分离**：程序文件在安装目录，配置与价格在 userData，
机器人数据始终在 botDir。卸载程序不会删除 botDir 或 userData。

---

## 5. 安全边界（务必阅读）

- 渲染进程只能通过 `preload.js` 的 `invoke(channel, args)` 调用**固定列表**的 IPC 通道；
  每个通道在 Main 端先做参数校验（`src/services/ipcChannels.js`）。
- `contextIsolation: true` / `nodeIntegration: false`；preload 不暴露 `fs`/`child_process`/`shell`。
- `SECRET_READ` **不回传明文密钥**，只回传掩码；写入需走 `SECRET_WRITE`（字段白名单）或 Provider 保存。
- 桌面 Provider 密钥在 Windows 上可用 `safeStorage`（DPAPI）加密；
  迁移会先备份明文到 `<botDir>/backups/`（已 gitignore），加密写入后回读校验，失败自动回滚。
- 机器人自身的 `secrets.json` **保持明文**——bot 进程独立运行且需要明文调用 API，不在加密范围。
- 日志、导出、错误信息统一经 `src/services/redact.js` 脱敏（Key / 本地路径 / 内部组件名）。
- 「测试连接」会向 Provider **真实发送**一条 `max_tokens=1` 的请求（可能产生极少量费用），
  仅由用户在界面上显式点击触发，不会自动调用。
- 用量页的费用是**估算值**，非服务商实际账单；无价格表时显示「未定价」。

---

## 6. 数据来源说明

用量明细优先读取机器人本地真实记录 `<botDir>/memory/usage/YYYY-MM-DD.jsonl`
（含 `provider` / `status` / `durationMs` / `errorCategory` 等完整字段）；
本地无文件时才回退运行中机器人的 `GET /api/usage`（仅旧聚合结构）。
两者都不可用时显示空状态并标注来源为「无数据」，**不做任何模拟数字**。

详见 `docs/USAGE_BASELINE.md`（字段映射）与 `docs/PHASE_C_REPORT.md`。
