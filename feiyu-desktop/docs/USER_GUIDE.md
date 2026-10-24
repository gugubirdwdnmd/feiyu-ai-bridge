# 肥鱼桌面控制中心 · 使用说明

> 仓库：[gugubirdwdnmd/feiyu-ai-bridge](https://github.com/gugubirdwdnmd/feiyu-ai-bridge)
> 桌面端目录：`feiyu-desktop/`　机器人核心：`ai_bridge.js`（仓库根）

本说明覆盖桌面控制中心的**全部功能**，含**技能扩展**与**ComfyUI 生图**的完整接入步骤。

---

## 目录

1. [五分钟上手](#1-五分钟上手)
2. [功能总览](#2-功能总览)
3. [机器人目录（botDir）](#3-机器人目录botdir)
4. [API 与模型（多 Provider）](#4-api-与模型多-provider)
5. [用量明细与费用估算](#5-用量明细与费用估算)
6. [人格设置（人格模板库）](#6-人格设置人格模板库)
7. [技能扩展](#7-技能扩展)
8. [ComfyUI 生图](#8-comfyui-生图)
9. [日志与诊断](#9-日志与诊断)
10. [配置导入导出](#10-配置导入导出)
11. [安全边界](#11-安全边界)
12. [常见问题排查](#12-常见问题排查)

---

## 1. 五分钟上手

### 1.1 安装

从 [Releases](https://github.com/gugubirdwdnmd/feiyu-ai-bridge/releases) 下载 `feiyu-desktop-control-center-x.y.z-win-x64.exe`，
双击安装（NSIS 安装包，可自选目录）。安装后：

- 程序本体：`%LOCALAPPDATA%\Programs\feiyu-desktop-control-center\`
- 用户数据：`%APPDATA%\feiyu-desktop-control-center\`（**与安装目录分离，卸载不会删除**）

> 安装包未做代码签名，Windows SmartScreen 会提示「未知发布者」，
> 点「更多信息 → 仍要运行」即可。

### 1.2 首次配置（4 步）

| 步骤 | 页面 | 操作 |
|---|---|---|
| ① | 左下角「机器人目录」 | 点击选择机器人项目根目录（**含 `ai_bridge.js` 的那一层**） |
| ② | **API 与模型** | 填 Base URL / 模型 / API Key → 「测试连接」→ 绿字「应用」 |
| ③ | **ComfyUI 生图** | 看「前置条件」表，按提示补齐（详见 [§8](#8-comfyui-生图)） |
| ④ | 机器人运行 | 点「启动 AI 桥」 |

配置顺序很重要：**必须先接入大模型（②），ComfyUI 生图才能工作（③）**。

---

## 2. 功能总览

| 页面 | 能力 | 生效方式 |
|---|---|---|
| 总览 | 进程状态、今日请求数（成功/失败）、关键入口 | 实时 |
| 机器人运行 | 启停 AI 桥 / NapCat、端口与 PID | 即时 |
| API 与模型 | 多 Provider 注册表、连接测试、凭据加密迁移 | 应用后需重启 AI 桥 |
| 用量明细 | 时间/Provider/模型/状态筛选、耗时、CSV 导出、价格估算 | 实时 |
| 人格设置 | 人格模板库（CRUD/复制/差异/备份回滚） | **保存即生效**（每请求重读 `ai_prompt.txt`） |
| **技能扩展** | 技能库（CRUD/启停/内置模板/导入导出） | **保存即生效**（每轮重读 `feiyu_skills.json`） |
| **ComfyUI 生图** | 检测/连通性/工作流/模型自动下载/前置条件 | 需重启 AI 桥（改 `ai_config.json`） |
| 日志与诊断 | 日志尾读、关键字搜索 | 实时 |
| 配置导入导出 | 打包/恢复配置（默认不含密钥） | 手动应用 |

---

## 3. 机器人目录（botDir）

桌面端**不重写机器人业务逻辑**，只读写机器人项目的真实配置文件。
因此必须先指定 botDir，否则所有文件相关操作都会被拒绝。

**botDir 就是包含 `ai_bridge.js` 的那一层目录**，例如：

```
D:\NapCat\            ← 选这一层
├── ai_bridge.js      ← 判定依据
├── ai_config.json
├── ai_prompt.txt
├── secrets.json
├── workflows/
└── memory/
```

找不到时界面会显示**明确原因**（未配置 / 目录已失效 / 缺 `ai_bridge.js`），
不会静默失败。

---

## 4. API 与模型（多 Provider）

### 4.1 添加 Provider

「API 与模型」页 → 「新增 Provider」：

| 字段 | 说明 |
|---|---|
| 名称 | 界面显示名 |
| Base URL | OpenAI 兼容端点，如 `https://api.deepseek.com/v1/chat/completions` |
| 模型 | 模型名，如 `deepseek-chat` |
| API Key | **留空表示保留原密钥**（编辑时不会清空） |

「测试连接」会做**协议级验证**：

1. 先拉 `/models` 列表（能连通）；
2. 再真实发一条 `max_tokens=1` 的 chat completion，校验返回里有 `choices[0].message.content`。

**只有第 2 步成功才标记「协议 OK」** —— 只可达但协议不对的端点会被识别出来。
测试会真实调用付费 API，因此必须由你主动点击，并有二次确认。

### 4.2 切换 Provider

「应用」= 把该 Provider 写回机器人原有的**单 Provider 槽位**
（`ai_config.json` 的 `api` 段 + `secrets.json` 的 `apiKey`），
复用机器人既有的请求系统，**不维护第二套请求实现**。

- 应用前自动备份，写后回读校验，**失败自动回滚**；
- 切换前有**差异预览**（密钥只比较不显示）；
- 写入的是持久化配置 → **需要重启 AI 桥才生效**（界面已注明）。

### 4.3 密钥安全

桌面侧多 Provider 密钥单独存 `feiyu_provider_secrets.json`（**不在** `feiyu_providers.json` 里）。
「API 与模型」页底部可查看凭据状态并**一键迁移到系统凭据存储**（Electron `safeStorage` / Windows DPAPI）：

- 迁移流程 = 备份 → 加密写入 → 回读校验 → 失败回滚，**幂等**，**不删原明文备份**；
- 迁移后的备份落在 `backups/`（已被 `.gitignore` 排除）；
- 加密库若无法解密，所有写操作会被**阻断**（防止误清空其它 Provider 的密钥）。

> 机器人的 `secrets.json` **保持明文**——机器人进程独立运行且需明文调用 API。
> 这是有意为之，不是疏漏。

---

## 5. 用量明细与费用估算

### 5.1 数据来源

**优先读本地 JSONL**（`memory/usage/*.jsonl`，实时追加、字段最全）；
本地没有对应日期文件时才回退机器人 `GET /api/usage`；都没有则显示空状态。

明细字段：`time / kind / model / provider / durationMs / status / errorCategory / prompt_tokens / completion_tokens / cache_hit_tokens / total_tokens`。

- 失败、超时、重试**也入明细**（`status='error'`，带 `errorCategory`）；
- **重试不会被计成多次成功**；
- 字段缺失记为「未知」，界面显示 `—`，**不冒充 0**。

### 5.2 费用估算

「价格表」可按模型配置**输入 / 输出 / 缓存**单价，单位支持 `1 / K / M / B`。

- 历史价格按**记录时间**套用当时生效的版本；
- 无适用价格显示「**未定价**」，**不显示「免费」**；
- 所有费用都标注「**估算值，非服务商实际账单**」；
- 内部按全精度求和后一次性舍入，避免逐条四舍五入造成系统性偏差。

---

## 6. 人格设置（人格模板库）

模板存 `feiyu_personalities.json`，与运行中的 `ai_prompt.txt` **分离**。

- 「保存模板」只改模板库，**不动运行中的人格**；
- 「应用到机器人」才写 `ai_prompt.txt`（先备份，失败保留原文件）；
- 界面显示**当前模板与实际生效人格是否一致**；
- 机器人每请求重读 `ai_prompt.txt` → **应用后下一条消息即生效，无需重启**。

---

## 7. 技能扩展

### 7.1 技能是什么

一个技能 = **一段注入系统提示词的行为说明** + **可选挂载的工具** + **可选触发条件**。

与「人格模板」的区别：人格模板是**整体替换**系统提示词；技能是**增量叠加**，
可以只针对特定话题（如「画图」「查天气」）临时生效。

### 7.2 快速上手

1. 打开「技能扩展」页；
2. 在「内置模板」区点「导入『画图小助手』」等；
3. 或用下方表单新建；
4. 保存后**立即生效**（机器人每轮重读 `feiyu_skills.json`）。

### 7.3 触发方式

| 模式 | 行为 | 典型用途 |
|---|---|---|
| 始终生效 | 每轮都注入 | 全局风格约束 |
| 命中关键词 | 文本含关键词才注入 | 「画图」「天气」等场景 |

关键词匹配**不区分大小写**。未命中时该技能**不注入任何内容、也不挂任何工具**。

### 7.4 挂载工具

技能可让模型在特定场景下多出一个工具入口，例如：

| 技能里的工具名 | 实际执行 | 效果 |
|---|---|---|
| `draw_picture` | 内置 `generate_image` | 触发 ComfyUI 生图 |
| `search_web` | 内置 `web_search` | 触发联网搜索 |

**安全边界（不可放宽）**：技能**只能复用机器人已有的内置工具**，
不能执行任意代码或脚本。工具处理器有白名单校验，非法值会被拒绝保存。
（`remember` 这类会写用户记忆的工具**不在白名单里**，避免技能被误挂后无意写记忆。）

### 7.5 内置模板

| 模板 | 说明 |
|---|---|
| 画图小助手 | 命中「画/画图/生图/出图」时，让机器人先描述画面再画 |
| 联网查证 | 命中「最新/今天/天气/新闻/价格」时，先搜索再回答并给出来源 |
| 随手记事 | 始终生效，识别值得长期记住的信息 |

### 7.6 导入导出

「导出全部技能」生成 `feiyu-skills.json`（**不含任何密钥**）；
「导入」按 id 合并，id 冲突自动重新分配，不覆盖同名技能。

---

## 8. ComfyUI 生图

### 8.1 前置条件（**必须先接入大模型**）

「ComfyUI 生图」页顶部的**前置条件表**会逐项列出是否满足：

| 项目 | 为什么必需 | 怎么满足 |
|---|---|---|
| **机器人侧大模型（LLM Provider）** | 画图前要把中文需求转成/扩写成画面描述 | 「API 与模型」页接入并**应用**一个可用 Provider |
| **ComfyUI 服务运行中** | 生图要提交工作流并取回结果 | 启动 ComfyUI（本机 `127.0.0.1:8188`） |
| **ComfyUI 文本编码器**（Qwen3-4B GGUF） | 把文字编码成图像条件，缺它出不了图 | 「模型」区点「下载」 |
| **ComfyUI 扩散模型**（Z-Image-Turbo GGUF） | 图像生成主模型 | 「模型」区点「下载」 |

> **为什么必须先接入大模型**：生图链路是
> 「用户中文需求 → LLM 理解并扩写成画面描述 → ComfyUI 依描述出图」。
> LLM 这一环缺失时，桥接层拿不到合适的画面描述，画图会空转。

### 8.2 自动下载 ComfyUI

「ComfyUI 生图」页 → 「自动下载安装 ComfyUI」：

- 走 **GitHub 官方 Releases**，实时解析最新版（不写死版本号）；
- 可选显卡架构：`nvidia` / `amd` / `intel` / `nvidia_arm64` / `nvidia_cu126`；
- 安装包为 `.7z`（约 1.4–1.9 GB），用**系统自带 `tar`**（Windows 10+ 的 bsdtar/libarchive，支持读 7z）解压，**不需要预装 7-Zip**；
- 解压后用包里的 `run_nvidia_gpu.bat`（或对应架构的脚本）启动。

> 若系统被精简掉自带 `tar`，会明确报错并提示手动用 7-Zip 解压到同目录。

### 8.3 自动下载模型

「模型」区列出工作流需要的三个文件，缺失的会显示「下载」按钮：

| 模型 | 目标位置 | 体积 | 来源 |
|---|---|---|---|
| Z-Image-Turbo 扩散模型 (GGUF) | `models/diffusion_models/z_image_turbo-Q5_K_M.gguf` | ≈5.1 GB | `jayn7/Z-Image-Turbo-GGUF` |
| Qwen3-4B 文本编码器 (GGUF) | `models/text_encoders/Qwen3-4B-Q5_K_M.gguf` | ≈2.7 GB | `Qwen/Qwen3-4B-GGUF` |
| AE 潜空间解码器 | `models/vae/ae.safetensors` ≈312 MB | `Comfy-Org/Z-Image-Turbo` |

**文件名必须与工作流里的 loader 节点完全一致**，改了名 ComfyUI 就找不到。

下载保障：

- 主源 `huggingface.co` 不可达时**自动回落 `hf-mirror.com` 镜像**；
- 流式下载 + 进度显示 + 单文件 8 GB 上限 + 下载前磁盘空间预检（需 ≥3 GB 空闲）；
- **完整性校验**：落地字节数必须与 `content-length` 一致，否则判定「下载不完整」并**拒绝写盘**；
- 已存在但**体积明显偏小**的文件会被识别为上次中断留下的半截文件，**自动重下**而不是跳过。

### 8.4 工作流

工作流放在机器人目录的 `workflows/` 下（**API 格式** JSON，即 ComfyUI 里
「Save → 保存类型选 API Format」保存出来的那种）。

界面会解析每个工作流并标注是否含必要节点：

| 节点 | 用途 |
|---|---|
| `CLIPTextEncode` | 文字编码（必需） |
| `KSampler` | 采样（必需） |
| `SaveImage` | 保存图片 |
| `UnetLoaderGGUF` / `CheckpointLoader` | 载入模型 |
| `LoadImage` | 图生图载入底图 |

**文生图 / 图生图工作流需要自备**（与你的模型绑定，属本地资产，不入库）。
配好后填进 `ai_config.json`：

```jsonc
{
  "image": {
    "enabled": true,
    "provider": "comfyui",                       // 走本机 ComfyUI
    "endpoint": "http://127.0.0.1:8188",         // 仅回环，不出网
    "workflow": "D:\\NapCat\\workflows\\txt2img.json",
    "img2imgWorkflow": "D:\\NapCat\\workflows\\img2img.json",
    "width": 1024, "height": 1024,
    "steps": 9, "cfgScale": 1,                   // Z-Image-Turbo 官方参数
    "sampler": "euler", "scheduler": "simple",
    "timeoutMs": 240000
  }
}
```

改 `ai_config.json` 后**需重启 AI 桥**。

> **安全**：ComfyUI 只连 `127.0.0.1:8188`，不出网；
> 启动脚本**不带 `--listen`**，不会绑定 `0.0.0.0` 被外网访问。

### 8.5 触发方式

在 QQ 里直接说「帮我画一只猫」；或先发一张图再说「改成水彩风格」走图生图。
机器人会先用 LLM 描述画面，再调 ComfyUI 出图，并把图发回聊天。

---

## 9. 日志与诊断

- 「刷新尾部」：看最近 300 行日志；
- 「搜索关键字」：按关键字过滤。

日志写入前会做**脱敏**（密钥、绝对路径、端口、内部模块名）。

---

## 10. 配置导入导出

「配置导入导出」页可打包当前配置并恢复：

- 默认导出**不含 `secrets.json` 里的密钥**；
- 需要含密钥时会明确提示，且不会出现在普通导出里；
- 恢复前会校验格式，**不会静默覆盖**。

---

## 11. 安全边界

| 边界 | 说明 |
|---|---|
| 密钥不进普通导出 | `buildExport` 默认不含 secret 段 |
| 渲染进程拿不到明文密钥 | `SECRET_READ` 只返回掩码与存在性；`SECRET_WRITE` 有字段白名单 |
| 密钥加密可迁移 | `safeStorage`（DPAPI），迁移带备份/校验/回滚 |
| 技能不能执行任意代码 | 工具处理器白名单，非法值拒绝保存 |
| 下载源白名单 | 只下 GitHub 官方 Releases 与已登记的 HF 仓库；不接受任意 URL |
| 下载有上限 | 单文件 8 GB 上限 + 磁盘空间预检 + 完整性校验 |
| ComfyUI 只走回环 | `127.0.0.1:8188`，启动不带 `--listen` |
| Electron 隔离 | `contextIsolation: true`、`nodeIntegration: false`、preload 不暴露 `fs`/`child_process` |
| 日志脱敏 | 密钥、绝对路径、端口、内部模块名 |
| 不动真实业务数据 | 不删记忆/日志，不擅自重启服务，不发真实 QQ 消息 |

---

## 12. 常见问题排查

**Q：技能保存了但机器人没反应？**
A：① 确认机器人目录就是含 `ai_bridge.js` 的那层；② 看技能是否「已启用」；
③ 触发方式是「关键词」时，输入里要真的出现那个词；④ 机器人运行模式若是 `chat`，
工具不会挂载（技能提示词仍会注入）。

**Q：画图没反应 / 提示 `comfyui-workflow-not-configured`？**
A：① 前置条件表里四项是否全绿；② `ai_config.json` 的 `image.workflow` 是否指向
真实存在的 API 格式工作流；③ 改完配置**重启 AI 桥**；④ ComfyUI 是否在
`127.0.0.1:8188` 运行。

**Q：下载模型一直失败？**
A：① 若是「下载不完整」，多半是网络中断，重试即可（不会留下半截文件）；
② 若报 403/超时，说明 `huggingface.co` 不通 —— 程序会自动切 `hf-mirror.com`，
可手动在浏览器打开镜像地址确认可达；③ 确认磁盘剩余 ≥3 GB。

**Q：ComfyUI 解压失败？**
A：需要系统自带 `tar`（Windows 10+ 自带 bsdtar，支持读 7z）。
若被精简，请用 7-Zip 手动解压到同一目录。

**Q：提示「密钥已加密但当前无法解密」？**
A：写入被**主动阻断**（防止误清空其它 Provider 的密钥）。
从 `backups/` 找回明文备份，或在同机器同用户下重开程序（DPAPI 绑定用户账户）。

**Q：桌面端改了 Provider，机器人没换模型？**
A：应用 Provider 写的是持久化配置，**需要重启 AI 桥**。

**Q：用量明细是空的？**
A：优先读本地 `memory/usage/*.jsonl`；换算范围试试「7d / month / all」。
若机器人从未调用过大模型，本来就没有记录。

---

## 附：相关文档

| 文档 | 内容 |
|---|---|
| [`README.md`](README.md) | 桌面端总览、打包、数据位置 |
| [`docs/PHASE_A_REPORT.md`](docs/PHASE_A_REPORT.md) | 阶段 A（桌面 MVP）报告 |
| [`docs/PHASE_B_REPORT.md`](docs/PHASE_B_REPORT.md) | 阶段 B（用量/多 Provider/费用）报告 |
| [`docs/PHASE_C_REPORT.md`](docs/PHASE_C_REPORT.md) | 阶段 C（人格库/明细接口/凭据加固）报告 |
| [`docs/RELEASE_ACCEPTANCE_REPORT.md`](docs/RELEASE_ACCEPTANCE_REPORT.md) | 发布候选验收报告 |
| [`docs/USAGE_BASELINE.md`](docs/USAGE_BASELINE.md) | 用量字段基线与映射表 |
| 仓库根 `workflows/README.md` | 工作流目录说明 |
