// 共享工具：检测本机 ComfyUI 是否可达（live 类测试在没有 ComfyUI 时跳过而非失败）
'use strict';

const COMFY = process.env.COMFY_ENDPOINT || 'http://127.0.0.1:8188';

async function comfyReachable(timeoutMs) {
  try {
    const res = await fetch(COMFY + '/system_stats', { signal: AbortSignal.timeout(timeoutMs || 3000) });
    return res.ok;
  } catch (e) {
    return false;
  }
}

module.exports = { comfyReachable, COMFY };
