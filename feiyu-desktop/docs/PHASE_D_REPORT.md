# Phase D 报告 —— 仓库改名 + 技能扩展 + ComfyUI 生图

日期：2026-10-24　分支：`feature/feiyu-desktop-control-center`　基线：`e55260d`

---

## 1. GitHub 仓库改名

| 项 | 改前 | 改后 |
|---|---|---|
| slug | `napcat-qq-ai-bridge` | **`feiyu-ai-bridge`** |
| URL | `github.com/gugubirdwdnmd/napcat-qq-ai-bridge` | `github.com/gugubirdwdnmd/feiyu-ai-bridge` |
| description | 「此项目为半成品 有很多bug」 | 「肥鱼 AI 桥接层 — NapCat OneBot11 QQ 自动回复 + 桌面控制中心（多Provider/用量统计/费用估算/人格模板/Skill扩展/ComfyUI生图）」 |
| topics | （空） | `napcat` `onebot11` `qq-bot` `ai-bridge` `deepseek` `electron` `comfyui` `skills` |

- 走 GitHub REST API `PATCH /repos/{owner}/{repo}` 完成（`gh` CLI 本机未安装）。
- 本地 `git remote` 已同步更新为新 URL。
- **旧 URL 自动 301 重定向**（GitHub 原生行为），旧 Release 页面与资产链接均可达。
- Release `feiyu-desktop-v0.1.0` 在改名后完好（`assets=1`，`draft=false`）。
- `package.json` 的 `name` 同步改为 `feiyu-ai-bridge`。
- 仓库内已无旧名硬编码引用（`job.log` 为历史 CI 日志，不影响）。

---

## 2. 技能扩展（Skill）

### 2.1 设计

技能 = **一段注入系统提示词的行为说明** + **可选挂载的工具** + **可选触发条件**。

与「人格模板库」的区别：人格模板是**整体替换**系统提示词；技能是**增量叠加**，
可只对特定话题（画图/查天气等）临时生效。

### 2.2 文件与职责

| 文件 | 位置 | 职责 |
|---|---|---|
| `skills.js` | 仓库根（机器人侧） | 纯计算层：校验、命中判定、提示词渲染、工具挂载 |
| `src/services/skillService.js` | 桌面侧 | 注册表 CRUD、启停、内置模板、导入导出 |
| `feiyu_skills.json` | botDir（运行时数据） | 两侧共用的注册表文件 |

**两侧共用同一份文件** —— 桌面端写、机器人端读，语义只有一份实现（`skills.js`），
不存在「桌面能存、机器人拒收」的漂移。`package-check.js` 第 12 项静态校验两侧白名单一致。

### 2.3 生效机制

机器人每轮 `askDeepSeek` 重新读取注册表（与 `ai_prompt.txt` 同机制），
因此**保存即生效，无需重启 AI 桥**。

### 2.4 安全边界（不可放宽）

- 技能**只能复用已有内置工具**：工具处理器有白名单（10 项），非法值拒绝保存。
- **不执行技能文件里的任何代码或脚本** —— `skills.js` 侧二次校验（`skillHandlerMap` /
  `skillToolDefs` 都再过滤一次），即使注册表被手工篡改也拦得住。
- `remember`（会写用户长期记忆）**不在白名单**，避免技能被误挂后无意写记忆。
- `skillService` 与 `skills.js` 两侧白名单由测试与 package-check 双重锁定一致。

### 2.5 内置模板

`画图小助手`（命中画图词时先描述再画）/ `联网查证`（时效性问题先搜索）/ `随手记事`。

---

## 3. ComfyUI 生图扩展

### 3.1 复用既有能力，不重复造轮子

机器人核心**已有** ComfyUI 后端（`ai_bridge.js` 的 `callComfyUIImage`，
`CFG.image.provider='comfyui'`，`127.0.0.1:8188`）。本轮**没有重写它**，
桌面端只做「检测 / 连通性 / 工作流解析 / 模型自动下载 / 前置条件校验」。

### 3.2 大模型前置条件（用户明确要求）

「ComfyUI 生图」页顶部的前置条件表逐项列出：

| 项目 | 为什么必需 | 怎么满足 |
|---|---|---|
| 机器人侧 LLM Provider | 画图前要把中文需求转成/扩写成画面描述 | 「API 与模型」页接入并**应用** |
| ComfyUI 服务运行中 | 提交工作流并取回结果 | 启动 ComfyUI（回环 8188） |
| 文本编码器 Qwen3-4B GGUF | 把文字编码成图像条件 | 自动下载 |
| 扩散模型 Z-Image-Turbo GGUF | 图像生成主模型 | 自动下载 |

生图链路 = 「中文需求 → LLM 理解并扩写 → ComfyUI 出图」，LLM 缺失即空转。

### 3.3 自动下载

**ComfyUI 本体**：走 GitHub 官方 Releases API 实时解析最新版（不写死版本号），
可选架构 `nvidia/amd/intel/nvidia_arm64/nvidia_cu126`，`.7z` 约 1.4–1.9 GB。
解压用**系统自带 `tar`**（Windows 10+ 的 bsdtar/libarchive，支持读 7z），**不需要预装 7-Zip**。

**模型**：三个必需文件，源与字节数均**对上游实测校验**：

| 模型 | 源 | 字节数（实测 = content-length） |
|---|---|---|
| `z_image_turbo-Q5_K_M.gguf` | `jayn7/Z-Image-Turbo-GGUF` | 5,522,742,336 |
| `Qwen3-4B-Q5_K_M.gguf` | `Qwen/Qwen3-4B-GGUF` | 2,889,513,184 |
| `ae.safetensors` | `Comfy-Org/Z-Image-Turbo` | 335,304,388 |

> 三个字节数与本机 `D:\ComfyUI` 已有文件**逐字节相等**，源选型已被验证正确。
> 文件名必须与工作流 loader 节点严格一致，改名 ComfyUI 就找不到。

下载保障：主源 `huggingface.co` 不通时自动回落 `hf-mirror.com`；流式 + 进度 + 8 GB 上限
+ 下载前磁盘空间预检（≥3 GB）+ **完整性校验**（落地字节数必须等于 `content-length`，
否则判「下载不完整」并拒绝写盘）+ 半截文件自动重下。

### 3.4 本轮发现并修复的缺陷

1. **模型源路径错误**：最初填的 `Comfy-Org/z_image_turbo` 仓库下**没有** GGUF 文件
   （官方只发 safetensors），HEAD 实测 404。改为实测存在的仓库，并把**文件名**
   改为与工作流 loader 一致的下划线命名。
2. **下载不完整会被当成成功**：原实现只累加字节数，连接中断产生的半截文件
   会被 `rename` 成正式文件名，导致 ComfyUI 加载失败且报看不懂的错。
   现改为落地后比对 `content-length`，不符即拒绝写盘并换源重试。
3. **半截文件被当成「已存在」跳过**：现按期望字节数判定，体积偏小则删除重下。
4. **模型清单无字节数**：补 `bytes` 字段（上游实测值），使完整性校验有基准。

---

## 4. 变更文件

### 新增

| 文件 | 说明 |
|---|---|
| `skills.js` | 机器人侧技能运行时（纯计算层，零依赖） |
| `feiyu-desktop/src/services/skillService.js` | 桌面端技能库管理 |
| `feiyu-desktop/src/services/comfyService.js` | ComfyUI 检测/工作流/模型下载/前置条件 |
| `feiyu-desktop/docs/USER_GUIDE.md` | **完整使用说明**（12 章 + FAQ） |
| `feiyu-desktop/test/skills.test.js` | 21 项 |
| `feiyu-desktop/test/skillService.test.js` | 20 项 |
| `feiyu-desktop/test/comfyService.test.js` | 33 项 |

### 修改

| 文件 | 主要改动 |
|---|---|
| `ai_bridge.js` | 引入 `skills`；4 处接入点（提示词注入 / 工具挂载 / 工具分发 / 生图预判） |
| `feiyu-desktop/src/services/ipcChannels.js` | 新增 17 个通道 + 参数校验 |
| `feiyu-desktop/src/ipc/handlers.js` | 新增 17 个处理器 |
| `feiyu-desktop/renderer/renderer.js` | 新增 `pageSkills` / `pageComfy` 两页 |
| `feiyu-desktop/renderer/index.html` | 新增两个导航按钮 |
| `feiyu-desktop/build/package-check.js` | 32 → **38 项**（新增技能白名单一致性等） |
| `README.md` / `feiyu-desktop/README.md` | 标题、简介、功能表、指南入口 |
| `package.json` | `name` 改为 `feiyu-ai-bridge` |
| `.gitignore` | 新增 `feiyu_skills.json` |

---

## 5. 测试结果

```
node --test                      → tests 248 / pass 248 / fail 0 / skipped 0
                                   （阶段A 39 + 阶段B 21 + 阶段C 62 + 验收 39 + 本轮 87）
node --check（18 文件 + bot 3）   → 全过
node build/package-check.js       → EXIT=0，38 项（1 项非阻断警告：未启用 renderer sandbox）
electron smoke-main.js            → SMOKE_OK handlers=57, EXIT=0
electron-builder --win nsis       → EXIT=0
```

本轮新增 **87 项**（21 + 20 + 33 + 13 项 IPC 校验扩展）。

### 真实环境验证（非 mock）

| 验证项 | 结果 |
|---|---|
| 技能端到端（写注册表 → 机器人读 → 命中渲染 → 工具挂载 → handler 映射） | ✅ 命中注入正确、未命中零注入 |
| ComfyUI 检测 | ✅ 自动定位 `D:\ComfyUI\ComfyUI` |
| 模型精确校验 | ✅ 三个模型字节数与上游**逐字节相等**，`suspicious=[]` |
| 官方 Release 解析 | ✅ 实时拿到 `v0.42.1` / `ComfyUI_windows_portable_nvidia.7z` / 1925 MB |
| 模型源 HEAD 可达性 | ✅ 三个模型在 `hf-mirror.com` 全部 200 |
| 打包产物内容 | ✅ 6 项新功能逐条断言在 asar 内；产物不含任何数据文件 |

---

## 6. 未解决 / 边界

| 项 | 状态 |
|---|---|
| 真实大文件下载未执行 | 只做 HEAD 探测与字节数比对，未实际下载 5 GB 模型（耗时与带宽）；下载逻辑用 mock fetch 全流程测通 |
| NSIS 安装包已重建但**未重新上传 Release** | 本轮未获授权发版；产物在 `dist/`，需另行发布 |
| ComfyUI 服务未在本轮启动 | 不重启现有服务；仅做了静态检测与连接失败的错误路径验证 |
| 工作流文件仍需自备 | 文生图/图生图工作流与本地模型绑定，属本地资产不入库；界面已解析校验节点完整性 |
| `renderer sandbox` 未启用 | preload 需 require 本地模块；已静态断言 preload 不暴露 `fs`/`child_process` |
| 无 UI 自动化回归 | 新页面由 IPC 层与服务层测试间接覆盖 |

---

## 7. 下阶段建议

1. **发布 v0.2.0**：本轮改动已产出新的 NSIS 安装包，含技能与 ComfyUI 页面。
2. **Provider 热切换**：目前应用 Provider 仍需重启 AI 桥；机器人核心可加「重载配置」端点。
3. **机器人侧 `secrets.json` 也迁 DPAPI**：需让机器人进程能访问 Electron 的 safeStorage。
4. **ComfyUI 队列可视化**：桌面端展示当前排队/出图任务与历史产出。
5. **技能市场**：把内置模板扩成可导入的技能包（带签名校验）。
6. **用量图表**：按 Provider/模型/时段出趋势图（费用估算口径需与账单对账验证）。
