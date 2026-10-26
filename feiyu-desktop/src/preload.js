'use strict';
/**
 * preload.js —— 唯一暴露给渲染进程的桥。
 * 只暴露受控的 invoke(channel, args)，不泄漏任何 Node / fs / 进程能力。
 */
const { contextBridge, ipcRenderer } = require('electron');
const { CHANNELS } = require('./services/ipcChannels');

contextBridge.exposeInMainWorld('feiyu', {
  invoke: (channel, args) => ipcRenderer.invoke(channel, args),
  channels: CHANNELS,
  // 订阅主进程推送的事件（终端输出 / 日志流 / 退出等），返回取消订阅函数。
  on: (channel, cb) => {
    const listener = (_event, ...args) => cb(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  off: (channel, cb) => ipcRenderer.removeListener(channel, cb),
});
