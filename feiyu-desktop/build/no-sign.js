'use strict';
/**
 * no-sign.js —— 本地/未签名构建用的空签名器。
 * 仅在「本机验证打包」时通过 CLI 覆盖使用：electron-builder --config.sign=build/no-sign.js
 * 正式发布应在 CI 提供真实代码签名证书（CSC_LINK），不要提交到 electron-builder.yml。
 * @param {{path:string}} configuration 待签名文件路径
 */
module.exports = async function sign(configuration) {
  // 故意不执行任何签名：产出未签名 exe/安装包，供本地验证。
  return;
};
