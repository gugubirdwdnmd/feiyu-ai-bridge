'use strict';
// ================= 群消息按天归档（供「群聊每日总结」使用）=================
// 为什么需要它：现有的群消息环形缓冲（groupBuffers）是**纯内存、仅 30 条、进程重启即丢**，
// 无法支撑「总结今天/昨天的群聊」。这里按 群ID → 日期 → 消息数组 做持久化。
//
// 设计约束（对应需求）：
//   · 只存本机器人**实际收到的**群消息，不做任何补全或推测；
//   · 硬上限：每群每天 maxPerDay 条、只保留 retainDays 天、文件超 maxBytes 自动裁剪最旧数据；
//   · 去重：同一 message_id 只留一条（NapCat 事件可能重复投递）；
//   · 原子写：先写 .tmp 再 rename，避免进程崩溃导致文件损坏；
//   · 数据损坏不抛异常：读失败时用空结构顶上，让机器人能继续聊天。

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, 'group_log.json');
let FILE = DEFAULT_FILE;      // 测试可用 _setFile 重定向到临时文件

const DEFAULTS = {
  maxPerDay: 400,          // 每群每天最多留存条数
  retainDays: 7,           // 只保留最近几天
  maxBytes: 4 * 1024 * 1024, // 文件体积上限，超了裁剪最旧数据
  minTextLen: 2,           // 少于这么多字的直接不存（过滤「6」「嗯」）
  maxTextLen: 300,         // 单条消息最长存储
};

let cache = null;          // 内存缓存，避免每次读盘
let dirty = false;
let flushTimer = null;

function cfg() {
  const c = (module.exports.getCFG && module.exports.getCFG()) || {};
  const s = (c.groupArchive || {});
  return {
    maxPerDay: Math.max(20, Number(s.maxPerDay) || DEFAULTS.maxPerDay),
    retainDays: Math.max(1, Number(s.retainDays) || DEFAULTS.retainDays),
    maxBytes: Math.max(256 * 1024, Number(s.maxBytes) || DEFAULTS.maxBytes),
    minTextLen: Math.max(1, Number(s.minTextLen) || DEFAULTS.minTextLen),
    maxTextLen: Math.max(20, Number(s.maxTextLen) || DEFAULTS.maxTextLen),
  };
}

function todayStr(ts) {
  const d = ts == null ? new Date() : new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function shiftDate(dateStr, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + days);
  return todayStr(d.getTime());
}

// —— 读盘（损坏不抛异常）——
function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(FILE, 'utf-8');
    const obj = JSON.parse(raw);
    cache = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch (e) {
    cache = {};
  }
  if (!cache.__meta) cache.__meta = { createdAt: Date.now(), version: 1 };
  return cache;
}

// —— 延迟落盘：合并 200ms 内的多次写入，避免每条消息都同步写盘 ——
function markDirty() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, 200);
  if (flushTimer.unref) flushTimer.unref();
}

function flush() {
  if (!cache || !dirty) return true;
  const c = cfg();
  prune(c);
  try {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache), 'utf-8');
    fs.renameSync(tmp, FILE);       // 原子替换
    dirty = false;
    return true;
  } catch (e) {
    return false;                    // 落盘失败不抛，机器人继续跑
  }
}

// —— 清理：过期天数 + 每群每天条数 + 总体积 ——
function prune(c) {
  const cc = c || cfg();
  const all = load();
  const today = todayStr();
  const oldestKeep = shiftDate(today, -(cc.retainDays - 1));

  for (const gid of Object.keys(all)) {
    if (gid === '__meta') continue;
    const byDate = all[gid];
    if (!byDate || typeof byDate !== 'object') { delete all[gid]; continue; }
    for (const date of Object.keys(byDate)) {
      if (date < oldestKeep) { delete byDate[date]; continue; }
      const arr = byDate[date];
      if (!Array.isArray(arr)) { delete byDate[date]; continue; }
      if (arr.length > cc.maxPerDay) byDate[date] = arr.slice(-cc.maxPerDay);
    }
    if (!Object.keys(byDate).length) delete all[gid];
  }

  // 体积兜底：还超就按日期从旧到新整天删
  try {
    let size = JSON.stringify(all).length;
    if (size > cc.maxBytes) {
      for (const gid of Object.keys(all)) {
        if (gid === '__meta') continue;
        const dates = Object.keys(all[gid]).sort();
        for (const date of dates) {
          if (size <= cc.maxBytes) break;
          const before = JSON.stringify(all).length;
          delete all[gid][date];
          size -= (before - JSON.stringify(all).length);
        }
      }
    }
  } catch (e) { /* 体积估算失败就算了，不影响主流程 */ }

  all.__meta = all.__meta || {};
  all.__meta.prunedAt = Date.now();
  return all;
}

// —— 写入一条群消息 ——
// item: { messageId, uid, name, text, time }
function archive(groupId, item) {
  try {
    if (!groupId || !item || !item.text) return false;
    const c = cfg();
    const text = String(item.text).replace(/\s+/g, ' ').trim();
    if (text.length < c.minTextLen || text.length > c.maxTextLen * 4) return false;
    const all = load();
    const gid = String(groupId);
    const date = todayStr(item.time);
    if (!all[gid]) all[gid] = {};
    if (!Array.isArray(all[gid][date])) all[gid][date] = [];
    const arr = all[gid][date];

    // 同一 message_id 去重
    if (item.messageId != null) {
      const mid = String(item.messageId);
      for (let i = arr.length - 1; i >= 0 && i >= arr.length - 40; i--) {
        if (arr[i] && String(arr[i].mid) === mid) return false;
      }
    }
    arr.push({
      mid: item.messageId == null ? '' : String(item.messageId),
      uid: String(item.uid || ''),
      name: String(item.name || '').slice(0, 24),
      text: text.slice(0, c.maxTextLen),
      t: Number(item.time) || Date.now(),
    });
    if (arr.length > c.maxPerDay) all[gid][date] = arr.slice(-c.maxPerDay);
    markDirty();
    return true;
  } catch (e) {
    return false;                     // 任何异常都不许影响聊天主流程
  }
}

// —— 取某群某天的消息（按时间升序）——
function getByDate(groupId, dateStr) {
  const all = load();
  const byDate = all[String(groupId)];
  if (!byDate) return [];
  const arr = byDate[dateStr];
  return Array.isArray(arr) ? arr.slice() : [];
}

// —— 该群有记录的日期（降序）——
function getDates(groupId) {
  const all = load();
  const byDate = all[String(groupId)];
  if (!byDate) return [];
  return Object.keys(byDate).sort().reverse();
}

// —— 有消息的群列表 ——
function getGroups() {
  const all = load();
  return Object.keys(all).filter((k) => k !== '__meta' && all[k] && Object.keys(all[k]).length);
}

// —— 统计 ——
function stats() {
  const all = load();
  let groups = 0, days = 0, msgs = 0, bytes = 0;
  try { bytes = JSON.stringify(all).length; } catch (e) { bytes = 0; }
  for (const gid of Object.keys(all)) {
    if (gid === '__meta') continue;
    groups++;
    const dates = Object.keys(all[gid]);
    days += dates.length;
    for (const d of dates) if (Array.isArray(all[gid][d])) msgs += all[gid][d].length;
  }
  let fileBytes = 0;
  try { fileBytes = fs.statSync(FILE).size; } catch (e) { fileBytes = 0; }
  return { groups, days, msgs, bytes, fileBytes, path: FILE };
}

module.exports = {
  FILE, DEFAULTS, archive, getByDate, getDates, getGroups, stats,
  prune, flush, todayStr, shiftDate,
  setConfig: (fn) => { module.exports.getCFG = fn; },
  _setFile: (p) => { FILE = p; cache = null; dirty = false; if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; } },
  _reset: () => { cache = null; dirty = false; },
};
