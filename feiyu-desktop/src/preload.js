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
});
