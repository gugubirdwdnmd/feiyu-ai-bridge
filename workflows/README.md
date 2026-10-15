# workflows/ —— ComfyUI 工作流目录

本目录存放桥接层直接调用的 ComfyUI 工作流（API 格式 JSON，即 ComfyUI 界面里「Save (API Format)」保存出来的那种）。

## 已随仓库提供

| 文件 | 用途 | 触发方式 |
|---|---|---|
| `reactor_faceswap.json` | 人脸替换工作流（ReActorFaceSwap 节点） | 先发目标图、再发源脸图，说「换脸/替脸/换头/贴脸」 |
| `z_image_turbo_2img_fusion.json` | 双图融合（Z-Image-Turbo 重绘） | 同时发两张图，说「融合/合成/两人合影」 |

换脸工作流依赖 ComfyUI 自定义节点 [ComfyUI-ReActor](https://github.com/Gourieff/ComfyUI-ReActor) 及模型：
- `models/insightface/inswapper_128.onnx`
- `models/insightface/models/buffalo_l/`（det_10g / 2d106det / genderage / 1k3d68 / w600k_r50）
- `models/nsfw_detector/vit-base-nsfw-detector/`（不预置会导致所有图被丢弃）

## 需要你自备

`ai_config.json` 里 `image.workflow`（文生图）与 `image.img2imgWorkflow`（图生图）指向的
**你自己的 ComfyUI 工作流文件**，例如：

- `workflows/txt2img.json` —— 文生图主工作流（示例模板里指向的路径）
- `workflows/img2img.json` —— 图生图工作流（需含一个 `LoadImage` 节点作底图）

从 ComfyUI 界面保存：右上角菜单 → Save → 保存类型选 **API Format**，然后把文件放进本目录、
在 `ai_config.json` 里填相对路径即可。桥接层按节点类型自动改参（CLIPTextEncode 填 prompt、
EmptyLatentImage 改尺寸、KSampler 改种子/步数/CFG、LoadImage 填上传的图、SaveImage 改前缀），
不依赖固定节点 key，工作流在 ComfyUI 里改过也能适配。

> 提示：文生图/图生图工作流与你的模型（ checkpoint / UNET / GGUF ）绑定，属于本地资产，故不入库。
