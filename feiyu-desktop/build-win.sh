#!/bin/bash
set -e
# 关闭代码签名自动发现：本机无证书，Electron 打包走未签名路径（预期行为）
export CSC_IDENTITY_AUTO_DISCOVERY=false
cd "$(dirname "$0")"
echo "=== start build $(date) ==="
npx electron-builder --win
echo "=== build done $(date) ==="
ls -la dist
