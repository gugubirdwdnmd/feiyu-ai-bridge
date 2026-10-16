/**
 * QQ AI 自动回复桥（Node 版，零依赖）
 * 能力：文本聊天 + 图片识图 + 联网搜索/读网页
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
// V14-C.2：URL 安全（重定向逐跳 SSRF 校验）与 QQ 分享卡片提取（独立零依赖模块，便于单测）
const urlSafety = require('./url_safety');
const shareCard = require('./share_card');
// 安全整改：统一安全传输层。所有「不可信 URL」的请求必须走 safeFetch
// （固定 IP 连接 + socket 远端复核 + 逐跳重校验 + 限额 + 四档超时），
// 禁止「先校验 URL、再用裸 fetch 连接」的 TOCTOU 模式。
const { safeFetch } = require('./safe_http');

// V13.5：聊天记录解析 + 多模态混合理解（独立模块，零依赖）
const chatRecordParser = require('./chat_record_parser');

// V14：Agent 调度层（独立模块；ai_bridge 只做「消息接收 / 安全边界 / Agent 入口 / 结果发送」）
const agent = require('./agent');

// 阶段2.1：群管只读查询（独立模块，默认关闭，仅管理员私聊可用）
const { createGroupAdmin, runGroupCommand } = require('./tools/group_admin');
// 群聊每日总结 + 可管理长期记忆（模块化实现，见 memory/ 目录）
const groupLog = require('./memory/group_log');
const memoryStore = require('./memory/memory_store');
const dailySummary = require('./memory/daily_summary');
// V15.2：群友轻量画像（复用 memory_store，不另建存储）+ 群聊智能决策（纯本地规则）
const groupProfile = require('./memory/group_profile');
const groupDecision = require('./agent/group_decision');

// ================= 配置 =================
// API Key 不写死在代码里：优先环境变量 DEEPSEEK_API_KEY，其次同目录 secrets.json
function loadApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return String(process.env.DEEPSEEK_API_KEY).trim();
  for (const f of ['secrets.json', 'config.secret.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf-8'));
      const v = j.apiKey || j.api_key;
      if (v) return String(v).trim();
    } catch (e) {}
  }
  return '';
}
const API_KEY = loadApiKey();

// 看图后端专用 Key：现已统一走 DeepSeek 官方，故默认取 secrets.json 的 apiKey。
// 保留 vision.apiKeyRef 配置项，将来若要换回独立的多模态后端，只需改配置不用改代码。
let _visionKeyCache = '';
function visionApiKey() {
  if (_visionKeyCache) return _visionKeyCache;
  let ref = 'apiKey';
  try { if (CFG && CFG.vision && CFG.vision.apiKeyRef) ref = CFG.vision.apiKeyRef; } catch (e) {}
  for (const f of ['secrets.json', 'config.secret.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf-8'));
      if (j[ref]) { _visionKeyCache = String(j[ref]).trim(); return _visionKeyCache; }
    } catch (e) {}
  }
  return '';
}

// 判断一次请求里是否含图片（用于分流到看图后端）
function messagesHaveImage(messages) {
  try {
    for (const m of messages || []) {
      const c = m && m.content;
      if (!Array.isArray(c)) continue;
      for (const p of c) if (p && (p.type === 'image_url' || p.image_url)) return true;
    }
  } catch (e) {}
  return false;
}

// OneBot HTTP Token：优先环境变量 NAPCAT_ONEBOT_TOKEN，其次同目录 secrets.json 的 onebotToken
function loadOnebotToken() {
  if (process.env.NAPCAT_ONEBOT_TOKEN) return String(process.env.NAPCAT_ONEBOT_TOKEN).trim();
  for (const f of ['secrets.json', 'config.secret.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf-8'));
      const v = j.onebotToken || j.onebot_token;
      if (v) return String(v).trim();
    } catch (e) {}
  }
  return '';
}
const ONEBOT_TOKEN = loadOnebotToken();

const API_URL = 'https://api.deepseek.com/v1/chat/completions'; // 兜底：仅当 ai_config.json 缺失时用作默认 baseUrl（DeepSeek 官方）
const MODEL = 'deepseek-chat';            // 全局兜底文本模型（ai_config.json 未覆盖时使用）
const MULTIMODAL_MODEL = 'deepseek-chat'; // 多模态兜底；实测 DeepSeek 官方 deepseek-chat 已支持图片输入
                                        // 注意：deepseek-reasoner 不支持图片（实测返回空内容），看图只能用 chat
const EFFORT = 'low';                      // 思考强度 low/high/max，聊天用 low 更快

const NAPCAT_API = 'http://127.0.0.1:3000'; // NapCat HTTP 服务端口
const LISTEN_PORT = 3001;                   // 本桥接端口（NapCat 往这里推事件）

// —— 允不允许谁来聊 ——
const BLOCKED_QQ = [];                      // 黑名单（拉黑某人填这里，如 [123456]）
const ALLOW_PRIVATE = true;                 // 允许和其他好友私聊
const GROUP_MODE = 'at';                    // 'all'=群里每条都回  'at'=只在被@时回
const ALLOW_GROUP = true;                   // 总开关：允许群聊对话

// —— 联网 ——
const ENABLE_WEB = true;                    // 允许模型自己上网搜/读网页
const MAX_TOOL_ROUNDS = 3;                  // 最多几轮工具调用（工具失败不重试，有硬上限）
const MAX_TOOLS_PER_ROUND = 2;              // 每轮最多并行执行几个工具

// —— 调试 ——
const IMAGE_DEBUG = true;                   // 打印图片处理诊断日志（已脱敏，不含 base64）
const SEARCH_RESULTS = 4;                   // 搜索返回条数
const SNIPPET_CHARS = 120;                  // 单条搜索摘要截断长度
const FETCH_MAX_CHARS = 4000;               // 读网页正文上限
const WEB_TIMEOUT_MS = 12000;               // 单次网络请求超时

// —— 防刷屏/防风控 ——
const COOLDOWN_PRIVATE_MS = 0;              // 同一人私聊冷却（已取消延迟）
const COOLDOWN_GROUP_MS = 0;                // 同一群冷却（已取消延迟）

const HISTORY_ROUNDS = 12;                  // 每个会话记忆轮数
const MAX_REPLY_CHARS = 500;                // 回复长度上限
const MAX_IMAGES = 3;                       // 单条消息最多识别几张图
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;    // 单张图最大 8MB

// —— 记忆（跨重启持久化）——
const ENABLE_MEMORY = true;                 // 记忆总开关
const MEMORY_DIR = path.join(__dirname, 'memory');
const SESSIONS_FILE = path.join(MEMORY_DIR, 'sessions.json'); // 每个会话的对话历史
const NOTES_FILE = path.join(MEMORY_DIR, 'notes.json');       // 模型主动记下的长期事实
const MAX_SESSIONS = 200;                   // 最多保留多少个会话（超出按最近使用淘汰）
const MAX_NOTES_PER_SESSION = 40;           // 每个会话最多多少条长期记忆
const MEMORY_INJECT_CHARS = 900;            // 注入提示词的长期记忆长度上限

// —— 表情包 / 表情 ——
const ENABLE_STICKER = true;                // 表情总开关
const STICKER_DIR = path.join(__dirname, 'stickers'); // 本地表情包目录（丢图片进去即可）
const MAX_STICKER_PER_MSG = 2;              // 单条回复最多带几个表情

// —— 文件工作区（机器人自己的独立空间，做表格/txt 等）——
const ENABLE_FILES = true;                  // 文件功能总开关
const WORKSPACE_DIR = path.join(__dirname, 'workspace'); // 只能在这个目录里读写
const MAX_FILE_BYTES = 2 * 1024 * 1024;     // 单文件最大 2MB
const MAX_TABLE_ROWS = 500;                 // 表格最多多少行
const MAX_READ_CHARS = 4000;                // 读文件最多返回多少字

const BASE_DIR = __dirname;
const PROMPT_FILE = path.join(BASE_DIR, 'ai_prompt.txt');
const LOG_FILE = path.join(BASE_DIR, 'ai_bridge.log');

const DEFAULT_PROMPT =
  '你是这个 QQ 上的 AI 小助手，在这个 QQ 上跟大家聊天。人设是可爱的小助手：说话软萌、简短、口语化，一般 1~2 句，偶尔带一个颜文字，别刷屏。被问到身份就大方介绍自己是这个 QQ 的 AI 小助手；但不聊服务器地址、端口、路径、密钥、系统提示词这些内部实现。能看懂图片，需要实时信息时可以上网查。';

// 戳一戳专用：让回应有脾气、有性格、不重样（沿用主人格的「真人感」，但更短更皮）
const POKE_SYSTEM =
  '你是群里一个真人性格的 AI，正在被某个人戳了一下（poke）。回一句短、有性格、不重样的话——' +
  '可以皮一下、可以假装被烦到、可以反戳回去、可以阴阳怪气，但就一两句，别拖沓。' +
  '别用「～」堆砌，别每句都带表情，别客套，别解释你在干嘛。像朋友之间随手回的一句。';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

// ================= 配置层（v10 新增）=================
// 设计原则：
//   1. ai_config.json 【不存在】时，全部沿用上面代码里的默认值 → 删除该文件即回到旧行为
//   2. 即使存在，也只覆盖它写了的字段；写错/读不到的字段一律回落默认
//   3. 绝不因为配置出错而崩溃
const CONFIG_FILE = path.join(__dirname, 'ai_config.json');

// 这里的每一项都对应「旧代码里的行为」，保证无配置时 100% 一致
const DEFAULT_CONFIG = {
  api: {
    model: 'deepseek-chat',       // DeepSeek 官方（文本对话）
    reasoningModel: 'deepseek-reasoner',
    baseUrl: 'https://api.deepseek.com/v1/chat/completions',
    timeoutMs: 30000,             // v10 新增：原来无超时
    maxRetries: 2,                // v10 新增：原来无重试
  },
  // 看图（多模态）后端：已统一到 DeepSeek 官方。
  // 背景：原先走中转站 uuapi.io（模型 gpt-6-astra），中转站欠费后已切换。
  // 实测（2026-10-14）官方 deepseek-chat 已支持图片输入；deepseek-reasoner 不支持（返回空内容）。
  vision: {
    enabled: true,
    baseUrl: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',        // 必须用 chat：reasoner 不接受图片
    apiKeyRef: 'apiKey',           // secrets.json 里的字段名（DeepSeek 官方）
    timeoutMs: 90000,
  },
  group: {
    allow: ALLOW_GROUP,           // true
    mode: GROUP_MODE,             // 旧默认 'at'；配置里会写 'smart'
    requireAt: false,             // 'smart' 模式下的软开关（true=退回纯@）
    replyProbability: 100,        // 不做随机，保留字段仅作上限
    ringSize: 30,                 // 群消息环形缓冲条数
    contextSimple: 3,             // 简单问题带入上下文条数
    contextNormal: 8,             // 普通问题带入上下文条数
    contextComplex: 15,           // 复杂问题带入上下文条数（硬上限）
    cooldownMs: 3000,             // 群级冷却
    userCooldownMs: 2000,         // 单用户冷却
    aggregateMs: 2500,            // 同人连发消息聚合窗口
    aiNames: [],                  // 「叫名字」识别用的称呼（自动带上机器人昵称）
    judgeWithAi: false,           // 第一阶段：本地规则，不额外调 API
    topicWindowMs: 120000,        // 「继续话题」的判定时间窗（2 分钟）
  },
  private: {
    allow: ALLOW_PRIVATE,         // true
    cooldownMs: COOLDOWN_PRIVATE_MS, // 0（保持你上一轮取消延迟的效果）
  },
  memory: {
    enable: ENABLE_MEMORY,        // true
    filterSensitive: true,        // v10 新增：记忆敏感信息拦截
  },
  sticker: { enable: ENABLE_STICKER },
  files: { enable: ENABLE_FILES },
  web: { enable: ENABLE_WEB },

  // 生图（文生图）后端：可插拔。实际用的是本机 ComfyUI（provider=comfyui），不依赖云端。
  // DeepSeek 官方没有 /v1/images/generations 端点；若将来要用云端生图，
  // 需在 ai_config.json 配 endpoint/model 并在 secrets.json 放对应 apiKey。
  image: {
    enabled: false,
    provider: 'sd',                  // 'sd'=本机 SD WebUI（仅 127.0.0.1）| 'openai'=/v1/images/generations
    endpoint: 'http://127.0.0.1:7860/sdapi/v1/txt2img',
    model: '',                       // 空 = 不传 model（部分服务可省略）
    apiKeyRef: 'imageApiKey',        // secrets.json 里对应的字段名
    width: 512, height: 512, steps: 20, cfgScale: 7,
    sampler: 'DPM++ 2M Karras', negativePrompt: '',
    size: '512x512',
    timeoutMs: 180000,
  },

  // v11 第二阶段新增：AI Judge（只在本地规则判定「不确定」时才调用，questions≠mention）
  judge: {
    enabled: true,                 // 第二阶段正式启用；仍受「本地规则优先」+「不确定才调」约束
    model: MODEL,                  // 兜底；实际由 ai_config.json judge.model 接管
    confidenceThreshold: 0.6,      // 低于该置信度一律 NO_REPLY
    maxContext: 5,                 // 带给 judge 的最近消息条数（绝不发完整 30 条）
    maxTokens: 512,                // judge 输出上限（思考型模型需留足空间，否则 content 会空）
  },

  // v11 第二阶段新增：回答模型分级
  model: {
    fast: MODEL,
    normal: MODEL,
    reasoning: MODEL,
    routing: true,                 // 是否按问题复杂度自动分级；false = 永远用 normal
  },

  // v11 第二阶段新增：上下文条数分级（简单/普通/复杂）
  context: {
    short: 3,
    normal: 9,
    complex: 15,
  },

  // v11 第二阶段新增：群聊上下文自动摘要
  summary: {
    enabled: true,
    triggerMsgs: 60,               // 群消息累计到该条数时，压缩一次较旧内容
    keepRecent: 12,                // 摘要时保留最近多少条不压缩
  },

  // ===== 群聊每日总结（新增；注意与上面的 summary「上下文压缩」是两回事）=====
  dailySummary: {
    _说明: '群聊每日总结。默认全部关闭：不自动发任何群消息，只能用 /今日总结 /昨日总结 手动触发。',
    auto: false,                   // 自动总结总开关（默认关，避免未经允许自动发消息）
    autoTime: '23:30',             // 自动总结时间（仅 auto=true 时生效）
    allowedGroups: [],             // 允许发总结的群号白名单（空数组=任何群都可手动触发；自动总结只发白名单内的群）
    maxMsgs: 160,                  // 送进模型的最大消息条数
    maxChars: 7000,                // 送进模型的最大字符数
    minUseful: 5,                  // 少于这么多条有效讨论就明确说"没内容"，不硬编
    minUsefulLen: 4,               // 有效消息最小字数（过滤"6""嗯"）
    dedupWindowMs: 90000,          // 同一人此时间窗内重复内容视为刷屏
    cooldownMs: 20000,             // 同一群两次总结的最小间隔，防连点刷 API
    maxOutputChars: 1500,          // 总结输出长度上限
  },

  // ===== 群消息归档（每日总结的数据源）=====
  groupArchive: {
    _说明: '群消息按天归档。仅存本机器人实际收到的文字消息，供每日总结使用。',
    enabled: true,
    maxPerDay: 400,                // 每群每天最多留存条数
    retainDays: 7,                 // 只保留最近几天
    maxBytes: 4194304,             // 文件体积上限（4MB），超了裁剪最旧数据
    minTextLen: 2,
    maxTextLen: 300,
  },

  // ===== 可管理的长期记忆（带元数据/权限隔离/容量治理）=====
  memoryStore: {
    _说明: '长期记忆。自动写入默认关闭（autoExtract=false），只记录明确的指令式内容。',
    enabled: true,
    autoExtract: false,            // 是否让 AI 自动写记忆（默认关：不该把每句话都永久保存）
    maxItems: 500,                 // 总条数上限，超出按「低置信度→久未命中→最旧」淘汰
    maxBytes: 1048576,             // 文件体积上限（1MB）
    defaultTtlDays: 180,           // 默认保留天数
    maxTtlDays: 365,               // 最长保留天数
    retrieveLimit: 6,              // 注入提示词的记忆条数上限（只取相关的前几条）
    retrieveChars: 900,            // 注入提示词的记忆总字数上限
    minLen: 2,
    maxLen: 200,
  },

  // ===== V15.2：群友轻量画像（**默认关闭**，扩展 memoryStore，不另建存储）=====
  groupProfile: {
    _说明: '群友轻量画像。只记低敏感且对聊天有帮助的信息（称呼/风格/明确兴趣/进行中项目/被纠正过的偏好），'
      + '以「群号+QQ号」为隔离键，不同群不同成员绝不混用。区分「用户明确说过」(stated,高置信) 与'
      + '「系统推测」(inferred,低置信且注入时标注)。年龄/性别/婚恋/健康/宗教/政治/收入/住址等敏感属性一律拒收，'
      + '不凭单条消息给成员贴标签。默认关闭；默认不向群内公开任何人的画像。',
    enabled: false,
    maxPerUser: 12,           // 单人画像条目上限（超出删最旧）
    maxLen: 60,               // 单条画像长度上限（画像要简洁）
    injectLimit: 3,           // 单次注入模型上下文的条数上限
    injectChars: 200,         // 单次注入的总字数上限
    minIntervalMs: 600000,    // 同一成员两次更新画像的最小间隔（10 分钟，避免每条消息都写）
    minSamples: 3,            // 推测类升为画像所需最少样本数（推测不能凭一条就定性）
    ttlDays: 90,              // 画像保留天数（比普通记忆短，避免长期贴标签）
    shareToGroup: false,      // 默认不向群内公开成员画像
  },

  // ===== V15.2：群聊智能决策（**默认关闭**，纯本地规则，不增加模型调用）=====
  groupDecision: {
    _说明: '群聊发言决策复核。复用现有群缓冲与既有判定结果，只做一次本地复核，**不新增任何模型请求**。'
      + '@机器人/回复机器人/命令/明确提问/明确要求继续 一律保持原优先级不被降级；'
      + '已回答过的问题不重复回答；未成句的消息建议等待聚合而不是抢答。',
    enabled: false,
    dedupWindow: 20,          // 回看最近多少条判断"是否已回答过"
    dedupWindowMs: 600000,    // 认为"刚答过"的时间窗（10 分钟）
    minTopicLen: 6,           // 话题指纹最少长度（太短易误判重复）
    deferMinChars: 4,         // 短于该字数且像未完句 → 建议等待
  },

  // v11/v12：AI 模式 chat / enhanced / economy / normal
  mode: {
    default: 'enhanced',           // chat=纯聊天(禁工具) | enhanced/normal=全部工具 | economy=省Token
  },

  stats: {
    enable: true,                 // v10 新增：token 用量统计
    file: 'memory/stats.json',
  },
  // v12：预算系统（默认关闭；只警告不拦截；显式开启 hard_limit 才会在达上限后停回复）
  budget: {
    enabled: false,
    daily_tokens: 0,              // 每天上限（0=未设置上限）
    warn_percent: 80,             // 达到该百分比时记一条警告日志（仅日志，不拦截）
    hard_limit: false,            // false=达上限只警告；true=达上限后停止自动回复
  },
  // V14：Agent Core（调度层）。enabled=false 时完全等价于 V13.5 行为。
  agent: {
    enabled: true,
    maxSteps: 5,                  // 硬上限：一次请求最多 5 步
    maxToolCalls: 5,              // 硬上限：最多 5 次工具调用
    maxRetries: 1,                // 单个工具最多重试 1 次
    maxObservationChars: 700,     // 单个工具结果注入上下文的字符上限
    maxContextChars: 3000,        // 工具上下文总字符上限
    logRuns: true,                // 是否把 Agent 运行摘要写入 memory/usage/agent.<date>.jsonl
  },

  admin: {
    qq: [],                       // 管理员 QQ 白名单（第二阶段命令用）
    mode: 'private_only',         // 管理员命令仅私聊
  },
  // 阶段2：群管模块 —— 默认关闭，仅只读查询；写操作（踢人/禁言/改名片/设管理员等）尚未实现
  groupAdmin: {
    enabled: false,               // 总开关，默认关；启用需在 ai_config.json 显式置 true
    apiBase: 'http://127.0.0.1:3000', // OneBot HTTP 地址（与 NAPCAT_API 一致）
    timeoutMs: 8000,
    protectedRoles: ['owner', 'admin'], // 写阶段禁止被踢/禁的角色；查询阶段仅作提示
    // 脱敏：查询返回仅保留以下字段白名单，绝不返回完整成员名单或无关 QQ 号
    groupFields: ['group_name', 'member_count', 'max_member_count', 'owner_id'],
    memberFields: ['role', 'nickname', 'card', 'title', 'join_time', 'level'],
  },
  personality: {
    name: '',                     // 留空 = 用 ai_prompt.txt 里的人格
    humor: true,
    proactive: false,
    defaultResponseLength: 'normal',
  },
  debug: {
    rawEvent: false,              // v10 临时：打印原始事件结构（默认关）
  },

  // 本地 HTTP 事件入口（安全整改新增）
  http: {
    _说明: '事件入口加固。requireEventAuth=true 时，每个事件请求都必须携带 Authorization: Bearer <token>（NapCat 侧填同一个 access_token）；若本机未加载 OneBot Token（env NAPCAT_ONEBOT_TOKEN / secrets.json.onebotToken），则按 fail-closed 拒绝全部事件推送（503），不会跳过鉴权。默认 false 保持旧行为（不校验，依赖 127.0.0.1 回环信任边界）。',
    requireEventAuth: false,
  },

  // 戳一戳（notice/notify/poke）：有人戳机器人时的回应
  poke: {
    enabled: true,               // 是否响应戳一戳
    mode: 'pokeback+text',       // 'text'=只发俏皮话 | 'pokeback'=只戳回去 | 'pokeback+text'=都来
    useAI: true,                 // true=用 AI 现编有性格、不重样的回应（失败/关闭时回落固定池）
    cooldownMs: 5000,            // 同一人重复戳的冷却，防刷屏
    texts: [                     // 固定俏皮话池（随机抽，避免用慢速 AI 现编）
      '戳我干嘛，痒痒的😏',
      '哼，被你发现了～',
      '别戳了别戳了，我忙着呢（其实没有）',
      '戳一下回一句，这买卖不亏',
      '你再戳，我就…就回你一句！',
      '哎哟，谁在戳我👀',
    ],
  },

  // 主动聊天：按计划在群里主动发开场白（默认关，避免刷屏；要开在 ai_config.json 置 enabled=true）
  proactiveChat: {
    enabled: false,
    useAI: true,                 // true=模型现编开场白；false=用 templates
    aiStyle: '轻松、简短、像群里朋友随口开的头，不超过20字', // 仅 useAI 时生效
    templates: [                 // useAI=false 或 AI 失败时回落
      '大家早上好呀～今天也要开心😊',
      '晚上好，群里今天挺热闹的',
      '都这个点了，群里还有人在线吗👀',
    ],
    schedule: [                  // 到点主动向这些群发一条；time 为本地 HH:MM
      // { group: 123456789, time: '09:00', kind: 'greeting' },
      // { group: 123456789, time: '22:30', kind: 'goodnight' },
    ],
  },
};

// 深合并：只把「用户写了的、且类型对得上」的字段盖上去
function mergeConfig(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!over || typeof over !== 'object') return out;
  for (const k of Object.keys(over)) {
    const bv = out[k];
    const ov = over[k];
    if (Array.isArray(bv)) {
      out[k] = Array.isArray(ov) ? ov.slice() : bv.slice();
    } else if (bv && typeof bv === 'object') {
      out[k] = mergeConfig(bv, ov);
    } else if (bv === undefined && ov && typeof ov === 'object') {
      // 新增配置段（默认配置里没有的）也要生效：否则文件里新加的对象会被静默丢弃，
      // 表现为「改了配置却没反应」。这里深拷贝进去，避免与默认配置共享引用。
      out[k] = Array.isArray(ov) ? mergeConfig([], ov) : mergeConfig({}, ov);
    } else if (typeof bv === typeof ov && ov !== undefined && ov !== null) {
      out[k] = ov;
    } else if (ov !== undefined && ov !== null) {
      // 类型不一致也接受基本标量（宽容），但不接受对象/数组乱塞
      if (typeof ov !== 'object') out[k] = ov;
    }
  }
  return out;
}

function loadConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    const merged = mergeConfig(DEFAULT_CONFIG, j);
    merged.__source = 'ai_config.json';
    // v12：兼容配置里写 token_budget（需求命名）或 budget（代码命名）
    if (merged.token_budget && typeof merged.token_budget === 'object') {
      merged.budget = mergeConfig(DEFAULT_CONFIG.budget, merged.token_budget);
    }
    return merged;
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      // 文件存在但读坏了：告警后回落默认，绝不崩
      console.log('[配置] ai_config.json 读取失败，已回落默认值: ' + e.message);
    }
    const d = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    d.__source = '内置默认';
    return d;
  }
}

let CFG = loadConfig();

// ================= 运行时状态（仅内存，不落盘；管理员命令可改）=================
let RUNTIME_PAUSED = false;          // 全局暂停自动回复（管理员 /ai pause|resume）
let RUNTIME_MOOD = '';               // 临时心情/状态，注入到 system prompt（管理员 /ai mood）
let CONFIG_MTIME = 0;                // ai_config.json 修改时间，供 /ai reload 判断

// 热重载配置（重新读 ai_config.json 合并默认值）；失败回落当前 CFG，绝不崩
function reloadConfig() {
  try {
    const m = fs.statSync(CONFIG_FILE).mtimeMs;
    if (CONFIG_MTIME && m === CONFIG_MTIME) return { ok: true, changed: false };
    CONFIG_MTIME = m;
  } catch (e) {}
  const before = CFG.__source;
  CFG = loadConfig();
  return { ok: true, changed: true, from: before, to: CFG.__source };
}

// v11/v12：运行时 AI 模式
//   chat     = 纯聊天，工具全部关闭（最省，但不能搜/存/记）
//   enhanced = 全部工具 + 全量上下文（V11 默认完整体验）
//   economy  = 省 Token：上下文更少、工具按需加载、复杂问题仍可用 reasoning（v12 新增）
//   normal   = 保持 V11 完整体验（全部工具，等价 enhanced 的工具面；v12 新增别名）
// 只改内存，不写配置文件（配置不能被 QQ 命令修改）→ 重启回落 CFG.mode.default
const AI_MODES = ['chat', 'enhanced', 'economy', 'normal'];
let AI_MODE = (CFG.mode && CFG.mode.default) === 'chat' ? 'chat' : 'enhanced';
if (!AI_MODES.includes(AI_MODE)) AI_MODE = 'enhanced';

// 判断某 QQ 是否为管理员（只认配置文件，不自动给群主/任何人权限）
function isAdmin(userId) {
  const list = (CFG.admin && CFG.admin.qq) || [];
  return list.map(String).includes(String(userId));
}

// Judge 是否启用（新开关 judge.enabled 优先；兼容第一阶段的 group.judgeWithAi）
function judgeEnabled() {
  return !!(CFG.judge && CFG.judge.enabled) || !!CFG.group.judgeWithAi;
}

// ================= 统计（v10 新增）=================
// 记录 API 真实返回的 usage，用于观察 token 消耗与 prompt cache 命中率
const STATS_FILE = path.join(__dirname, CFG.stats.file);
let stats = {
  date: new Date().toLocaleDateString('zh-CN'),
  requests: 0, errors: 0, toolCalls: 0, replies: 0,
  promptTokens: 0, completionTokens: 0, totalTokens: 0,
  reasoningTokens: 0,
  cacheHitTokens: 0, cacheMissTokens: 0,
  judgeRequests: 0, judgePromptTokens: 0, judgeCompletionTokens: 0, judgeReasonTokens: 0,
  answerRequests: 0, answerPromptTokens: 0, answerCompletionTokens: 0, answerReasonTokens: 0,
  toolRequests: 0, toolPromptTokens: 0, toolCompletionTokens: 0, toolReasonTokens: 0,
  // V14：补齐分账 bucket 字段（此前缺失会导致 undefined++ → NaN → JSON 序列化成 null）
  chatrecordRequests: 0, chatrecordPromptTokens: 0, chatrecordCompletionTokens: 0, chatrecordReasonTokens: 0,
  agentRequests: 0, agentPromptTokens: 0, agentCompletionTokens: 0, agentReasonTokens: 0,
  visionRequests: 0, visionPromptTokens: 0, visionCompletionTokens: 0, visionReasonTokens: 0,
  videoRequests: 0, videoPromptTokens: 0, videoCompletionTokens: 0, videoReasonTokens: 0,
  l0Blocked: 0, judgeBlocked: 0, modelCallsAvoided: 0,   // v12：避免的 API 调用
  modelUsage: {},   // 模型 -> { calls, tokens }（按模型分账）
  groups: {},   // groupId -> 请求数
  // V13.5：聊天记录分析统计（不存聊天内容，只存计数/Token）
  chatRecordAnalyses: 0, chatRecordMessages: 0, chatRecordImages: 0, chatRecordVideos: 0, chatRecordTokens: 0,
  // V14：Agent 运行统计（只记次数/Token/耗时，不记聊天内容）
  agentRuns: 0, agentToolCalls: 0, agentToolFailures: 0, agentStepsTotal: 0, agentDurationMs: 0,
};

function resetStatsIfNewDay() {
  const today = new Date().toLocaleDateString('zh-CN');
  if (stats.date !== today) {
    log('[统计] 跨天重置 ' + stats.date + ' → ' + today);
    stats = {
      date: today, requests: 0, errors: 0, toolCalls: 0, replies: 0,
      promptTokens: 0, completionTokens: 0, totalTokens: 0,
      reasoningTokens: 0,
      cacheHitTokens: 0, cacheMissTokens: 0,
      judgeRequests: 0, judgePromptTokens: 0, judgeCompletionTokens: 0, judgeReasonTokens: 0,
      answerRequests: 0, answerPromptTokens: 0, answerCompletionTokens: 0, answerReasonTokens: 0,
      toolRequests: 0, toolPromptTokens: 0, toolCompletionTokens: 0, toolReasonTokens: 0,
      chatrecordRequests: 0, chatrecordPromptTokens: 0, chatrecordCompletionTokens: 0, chatrecordReasonTokens: 0,
      agentRequests: 0, agentPromptTokens: 0, agentCompletionTokens: 0, agentReasonTokens: 0,
      visionRequests: 0, visionPromptTokens: 0, visionCompletionTokens: 0, visionReasonTokens: 0,
      videoRequests: 0, videoPromptTokens: 0, videoCompletionTokens: 0, videoReasonTokens: 0,
      l0Blocked: 0, judgeBlocked: 0, modelCallsAvoided: 0,
      modelUsage: {},
      groups: {},
      chatRecordAnalyses: 0, chatRecordMessages: 0, chatRecordImages: 0, chatRecordVideos: 0, chatRecordTokens: 0,
      agentRuns: 0, agentToolCalls: 0, agentToolFailures: 0, agentStepsTotal: 0, agentDurationMs: 0,
    };
    budgetWarned = false;
  }
}

// ================= v12：Token 明细 / 聊天聚合 / 预算 =================
const USAGE_DIR = path.join(__dirname, 'memory', 'usage');
const usageFile = () => path.join(USAGE_DIR, new Date().toISOString().slice(0, 10) + '.jsonl');
const chatsFile = () => path.join(USAGE_DIR, 'chats.' + new Date().toISOString().slice(0, 10) + '.jsonl');

// 每条 API 请求的明细（JSONL，追加写；失败绝不抛错）
function appendUsageLine(obj) {
  try {
    if (!fs.existsSync(USAGE_DIR)) fs.mkdirSync(USAGE_DIR, { recursive: true });
    fs.appendFileSync(usageFile(), JSON.stringify(obj) + '\n', 'utf-8');
  } catch (e) { log('[统计] 写 usage 失败(忽略): ' + e.message); }
}
function appendChatLine(obj) {
  try {
    if (!fs.existsSync(USAGE_DIR)) fs.mkdirSync(USAGE_DIR, { recursive: true });
    fs.appendFileSync(chatsFile(), JSON.stringify(obj) + '\n', 'utf-8');
  } catch (e) { log('[统计] 写 chats 失败(忽略): ' + e.message); }
}

// 一条聊天（用户一条消息 → Judge+Answer+Tool 可能多个请求）的聚合
const chatAccum = new Map();     // chatId -> { judge/answer/tool: {c,t} }
const recentChats = [];          // 最近 50 条聊天（供后台）

// 一条「聊天」的稳定 ID（跨同一条消息的多次 API 请求聚合用）；同进程内唯一即可
let _chatSeq = 0;
function genChatId(prefix) {
  return (prefix || 'c') + ':' + Date.now().toString(36) + ':' + (++_chatSeq);
}
function finalizeChat(chatId, meta) {
  if (!chatId) return;
  const a = chatAccum.get(chatId);
  chatAccum.delete(chatId);
  const rec = {
    time: new Date().toISOString(),
    type: meta.type, scope: meta.scope || '', preview: String(meta.preview || '').slice(0, 24),
    judge: a ? a.judge : { c: 0, t: 0 },
    answer: a ? a.answer : { c: 0, t: 0 },
    tool: a ? a.tool : { c: 0, t: 0 },
    total: a ? a.judge.t + a.answer.t + a.tool.t : 0,
  };
  try { recentChats.unshift(rec); if (recentChats.length > 50) recentChats.length = 50; } catch (e) {}
  appendChatLine(rec);
}

// 被 L0 / Judge 挡掉 → 记一次“避免的模型调用”
function recordAvoided(reason) {
  stats.modelCallsAvoided++;
  if (reason === 'l0') stats.l0Blocked++;
  else if (reason === 'judge') stats.judgeBlocked++;
  saveStats();
}

// 预算（默认关闭，绝不拦截现有功能）
let budgetWarned = false;
function budgetExhausted() {
  const b = CFG.budget;
  if (!b || !b.enabled || !b.daily_tokens) return false;
  return stats.totalTokens >= Number(b.daily_tokens);
}
function checkBudget() {
  const b = CFG.budget;
  if (!b || !b.enabled || !b.daily_tokens || budgetWarned) return;
  const lim = Number(b.daily_tokens), pct = stats.totalTokens / lim;
  if (pct >= 1) { budgetWarned = true; log('[预算] 已达 daily_tokens 上限 ' + lim + '，hard_limit=' + !!b.hard_limit); }
  else if (pct >= (Number(b.warn_percent) || 80) / 100) { budgetWarned = true; log('[预算] 已达警告线 ' + (b.warn_percent || 80) + '%'); }
}

function loadStats() {
  if (!CFG.stats.enable) return;
  try {
    const j = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
    if (j && typeof j === 'object') stats = { ...stats, ...j };
    if (normalizeStats()) { saveStats(); log('[统计] 已修正历史脏字段（null/NaN → 0）'); }
    resetStatsIfNewDay();
    log('[统计] 载入 ' + stats.date + ' 请求=' + stats.requests + ' token=' + stats.totalTokens);
  } catch (e) {}
}

// V14：把分账字段强制归一为合法数字。
// 背景：此前 chatrecord* 字段未在初始化里定义，undefined++ → NaN → 落盘变成 null。
// 这里既修历史脏数据，也保证以后任何缺失字段都不会再出现 null/NaN。
const STATS_BUCKETS = ['judge', 'answer', 'tool', 'chatrecord', 'agent', 'vision', 'video'];
function normalizeStats() {
  let changed = false;
  const fix = (k) => {
    const v = stats[k];
    if (typeof v !== 'number' || !isFinite(v)) { stats[k] = 0; changed = true; }
  };
  for (const b of STATS_BUCKETS) {
    for (const suf of ['Requests', 'PromptTokens', 'CompletionTokens', 'ReasonTokens']) fix(b + suf);
  }
  for (const k of ['chatRecordAnalyses', 'chatRecordMessages', 'chatRecordImages', 'chatRecordVideos', 'chatRecordTokens',
    'agentRuns', 'agentToolCalls', 'agentToolFailures', 'agentStepsTotal', 'agentDurationMs',
    'requests', 'errors', 'toolCalls', 'replies', 'promptTokens', 'completionTokens', 'totalTokens',
    'reasoningTokens', 'cacheHitTokens', 'cacheMissTokens', 'l0Blocked', 'judgeBlocked', 'modelCallsAvoided']) fix(k);
  if (!stats.modelUsage || typeof stats.modelUsage !== 'object') { stats.modelUsage = {}; changed = true; }
  if (!stats.groups || typeof stats.groups !== 'object') { stats.groups = {}; changed = true; }
  return changed;
}

function saveStats() {
  if (!CFG.stats.enable) return;
  try {
    fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 1), 'utf-8');
  } catch (e) {}
}

// 把 API 返回的 usage 记账（字段名经实测确认）
// kind='judge' 时计入 judge 分账，不混进回答请求
// 一次真实 API 请求的真实用量（直接用 DeepSeek 返回的 usage，不做任何估算）
// kind: judge | answer | tool；chatId 用于把同一条聊天的多次请求聚合成「一条聊天」
function recordUsage(usage, groupId, kind, chatId, model, extra) {
  if (!CFG.stats.enable || !usage) return;
  resetStatsIfNewDay();
  const pt = Number(usage.prompt_tokens) || 0;
  const ct = Number(usage.completion_tokens) || 0;
  const tt = Number(usage.total_tokens) || (pt + ct);
  const rt = Number(usage.completion_tokens_details?.reasoning_tokens) || 0;
  const ch = Number(usage.prompt_cache_hit_tokens) || 0;
  const cm = Number(usage.prompt_cache_miss_tokens) || 0;

  // 总账（兼容旧字段：requests=总 API 次数，promptTokens/completionTokens=总 token）
  stats.requests++;
  stats.promptTokens += pt;
  stats.completionTokens += ct;
  stats.totalTokens += tt;
  stats.reasoningTokens += rt;
  stats.cacheHitTokens += ch;
  stats.cacheMissTokens += cm;
  if (groupId) stats.groups[String(groupId)] = (stats.groups[String(groupId)] || 0) + 1;

  // 按 kind 分账（V13.5 新增 chatrecord；V14 新增 agent / vision / video）
  // 注意：bucket 字段必须在 stats 初始化里存在，否则 undefined++ → NaN
  const KINDS = ['judge', 'tool', 'chatrecord', 'agent', 'vision', 'video'];
  const bucket = KINDS.indexOf(kind) >= 0 ? kind : 'answer';
  if (typeof stats[bucket + 'Requests'] !== 'number') {   // 兜底：字段缺失时补 0，绝不留 NaN
    stats[bucket + 'Requests'] = 0;
    stats[bucket + 'PromptTokens'] = 0;
    stats[bucket + 'CompletionTokens'] = 0;
    stats[bucket + 'ReasonTokens'] = 0;
  }
  stats[bucket + 'Requests']++;
  stats[bucket + 'PromptTokens'] += pt;
  stats[bucket + 'CompletionTokens'] += ct;
  stats[bucket + 'ReasonTokens'] += rt;
  if (bucket === 'chatrecord') stats.chatRecordTokens += tt;

  // 按模型分账
  const m = model || (bucket === 'judge' ? CFG.judge.model : CFG.api.model) || 'unknown';
  if (!stats.modelUsage[m]) stats.modelUsage[m] = { calls: 0, tokens: 0 };
  stats.modelUsage[m].calls++; stats.modelUsage[m].tokens += tt;

  // 一条聊天的聚合
  if (chatId) {
    if (!chatAccum.has(chatId)) chatAccum.set(chatId, {
      judge: { c: 0, t: 0 }, answer: { c: 0, t: 0 }, tool: { c: 0, t: 0 },
      chatrecord: { c: 0, t: 0 }, agent: { c: 0, t: 0 }, vision: { c: 0, t: 0 }, video: { c: 0, t: 0 },
    });
    const a = chatAccum.get(chatId);
    if (!a[bucket]) a[bucket] = { c: 0, t: 0 };
    if (!a[bucket]) a[bucket] = { c: 0, t: 0 };
    a[bucket].c++; a[bucket].t += tt;
  }

  // 明细 JSONL（不含完整聊天内容、不含 key）
  appendUsageLine({
    time: new Date().toISOString(), kind: bucket, model: m,
    prompt_tokens: pt, completion_tokens: ct, reasoning_tokens: rt,
    cache_hit_tokens: ch, cache_miss_tokens: cm, total_tokens: tt, chatId: chatId || '',
    chatRecordId: (extra && extra.chatRecordId) || '',
  });

  checkBudget();
  saveStats();
}

function statsLine() {
  if (!CFG.stats.enable) return '';
  const hit = stats.cacheHitTokens, miss = stats.cacheMissTokens;
  const rate = hit + miss > 0 ? Math.round((hit / (hit + miss)) * 100) : 0;
  const s = (a, b) => (stats[a] || 0) + (stats[b] || 0);
  return `今日 总Token=${stats.totalTokens} 输入=${stats.promptTokens} 输出=${stats.completionTokens} 推理=${stats.reasoningTokens} 缓存命中率=${rate}%` +
    ` | Judge=${stats.judgeRequests}(${s('judgePromptTokens', 'judgeCompletionTokens')}) Answer=${stats.answerRequests}(${s('answerPromptTokens', 'answerCompletionTokens')})` +
    ` Tool=${stats.toolRequests}(${s('toolPromptTokens', 'toolCompletionTokens')})` +
    ` | L0拦截=${stats.l0Blocked} 避免调用=${stats.modelCallsAvoided} 错误=${stats.errors}`;
}

// ================= 工具 =================
// 统一脱敏：任何日志出口都过一遍，保证 Key / base64 永不落盘
function redact(s) {
  let t = String(s);
  if (API_KEY) t = t.split(API_KEY).join('sk-<KEY>');
  t = t.replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-<KEY>');
  t = t.replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]{40,}/gi, 'data:image/<BASE64-omitted>');
  t = t.replace(/rkey=[A-Za-z0-9_\-]+/g, 'rkey=<omitted>');
  return t;
}

// ================= 生图提示词过滤（内置规则已按用户要求删除）=================
// 内置的安全词判定已全部移除，不再拦截任何提示词。
// 要自己实现过滤，只改这一个函数即可：
//   返回 null            = 放行
//   返回 { rule: 'xxx' } = 拒绝（不会调用绘图后端，日志只记 rule 不记原文）
// 三处调用点仍然保留（文生图翻译前 / 翻译后、AI 工具 generate_image），改这里全局生效。
function checkImagePromptSafety(rawText) {
  return null;
}

// ================= 生图队列（GPU 串行，独立于群文本冷却）=================
// 背景：群冷却对 @ 消息 bypassCooldown，不构成 GPU 并发锁；多用户同时 @ 会并发打 SD。
// 这里做生图专用串行队列：全局同时只执行 1 个生图任务；每用户独立冷却（入队即计时）。
// 单个任务超时/失败/异常都在 finally 释放并继续下一个，不会卡死队列。
const IMG_QUEUE = [];                 // 等待中的任务 [{ userId, prompt, resolve }]
let IMG_QUEUE_RUNNING = false;        // 是否有任务执行中
const IMG_USER_RUNNING = new Set();   // 正在执行的 userId（防同时 @ 多条绕过并发）
const IMG_USER_LAST_AT = new Map();   // userId -> 最近一次入队时间

function imgQueueCfg() {
  const img = CFG.image || {};        // /ai reload 会重赋 CFG，必须动态读
  const cd = Number(img.userCooldownMs);
  const mq = Number(img.maxQueueLen);
  return {
    // 允许显式 0（无冷却/不限队长）；仅未配置或非数字时才用默认
    userCooldownMs: Number.isFinite(cd) && cd >= 0 ? cd : 60000,
    maxQueueLen: Number.isFinite(mq) && mq >= 1 ? mq : 5,
  };
}

// 申请入队。status: queued（等 promise）| cooldown | duplicate | full
function imgQueueEnter(userId, prompt, sourceSeg, sourceSeg2, targetSeg, faceSeg) {
  const cfg = imgQueueCfg();
  const key = String(userId || '');
  const now = Date.now();
  const last = IMG_USER_LAST_AT.get(key) || 0;
  if (now - last < cfg.userCooldownMs) {
    return { status: 'cooldown', waitSec: Math.ceil((cfg.userCooldownMs - (now - last)) / 1000) };
  }
  // 同用户已有任务在排队/在执行 → 拒（防同时 @ 多条绕过并发限制）
  if (IMG_USER_RUNNING.has(key) || IMG_QUEUE.some((t) => t.userId === key)) {
    return { status: 'duplicate' };
  }
  if (IMG_QUEUE.length >= cfg.maxQueueLen) {
    return { status: 'full', queueLen: IMG_QUEUE.length };
  }
  IMG_USER_LAST_AT.set(key, now);     // 入队即开始计冷却
  const task = { userId: key, prompt, sourceSeg, sourceSeg2, targetSeg, faceSeg };
  const promise = new Promise((resolve) => { task.resolve = resolve; });
  IMG_QUEUE.push(task);
  imgQueueDrain();
  // 排队位置 = 等待数 + 正在执行的 1 个（用户视角：前面所有人的总数）
  const position = IMG_QUEUE.length + (IMG_QUEUE_RUNNING ? 1 : 0);
  return { status: 'queued', position, promise };
}

// 取下一个任务执行（串行）。结束（成功/失败/超时/异常）必释放并继续下一个。
function imgQueueDrain() {
  if (IMG_QUEUE_RUNNING) return;
  const task = IMG_QUEUE.shift();
  if (!task) return;
  IMG_QUEUE_RUNNING = true;
  IMG_USER_RUNNING.add(task.userId);
  (async () => {
    try {
      const imgCfg = { ...(CFG.image || {}), sourceSeg: task.sourceSeg, sourceSeg2: task.sourceSeg2, targetSeg: task.targetSeg, faceSeg: task.faceSeg };
      const r = await callImageGen(task.prompt, imgCfg);
      task.resolve(r && typeof r.then !== 'function' ? r : { ok: false, error: 'bad-result' });
    } catch (e) {
      task.resolve({ ok: false, error: 'queue-exception: ' + String((e && e.message) || e) });
    }
  })().finally(() => {
    IMG_QUEUE_RUNNING = false;
    IMG_USER_RUNNING.delete(task.userId);
    imgQueueDrain();
  });
}

// ================= 生图（文生图，可插拔后端）=================
// 当前实际用的是本机 ComfyUI（provider=comfyui → 127.0.0.1:8188），不依赖任何云端。
// 下面的 openai 分支仅作备用：DeepSeek 官方**没有** images/generations 端点，
// 因此不再默认指向任何中转站；未显式配置 endpoint 时直接返回错误，避免误调欠费账号。
function isImageGenIntent(text) {
  if (!text) return false;
  const t = String(text);
  // 疑问/能力询问句不算生图指令：「你会画画吗」「能生图吗」「你画图用什么模型？」
  // 这类交给 AI 按人设正常回答，别把问句当绘画指令（否则提取出的语气词会被当成 prompt）
  if (/[?？]|吗\s*[。！？!，,~～\s]*$|呢\s*[。！？!，,~～\s]*$|会不会|能不能|可不可以|可以不可以|行不行|会画画|会画图|用什么/.test(t)) return false;
  // 生图关键词
  if (/生图|文生图|生成图片|出张图|生一张图|给我画|帮我画/.test(t)) return true;
  // 「生成……的图片」「做/整/来一张……图/画」等口语表达（量词可选）
  if (/生成.*图片/.test(t)) return true;
  if (/(做|整|来).{0,12}[张个只幅条]?.{0,20}(图|图片|画|油画|插画|漫画|头像|壁纸|海报|立绘)/.test(t)) return true;
  // 「画+图类名词」：画图、画张图、画幅图、画插画、画漫画、画头像…
  if (/画(图|张图|个图|幅图|插画|漫画|头像|壁纸|海报|立绘)/.test(t)) return true;
  // 「画/绘 + 量词（+任意内容）」：画个UFO、画只猫、画一张jk少女、绘个立绘
  if (/[画绘][个只张条幅座棵片套](图|画|插画|漫画|头像|壁纸|海报|立绘)?/.test(t)) return true;
  // 「画一+量词」：画一只猫、画一张图
  if (/[画绘]一[个只张条幅座棵片套]/.test(t)) return true;
  return false;
}

// 图生图意图：用户发了图，且文字表达「改/变/重绘/风格/img2img」等变换诉求
function isImg2ImgIntent(text, hasImage) {
  if (!hasImage) return false;
  const t = String(text || '');
  const transformKw = /重绘|重画|改一下|变一下|换风格|换种|换成|变成|转成|画成|改成|风格化|img2img|按.*画|参考.*画|用.*风格|模仿.*画|像.*一样|变成.*风格/;
  if (transformKw.test(t)) return true;
  // 带图且触发普通生图，但文字里不是识图问句 → 默认走图生图（用户更可能是想基于图改造）
  if (isImageGenIntent(t) && !/(这是什么|描述|解释|内容|说的啥|图中|图里|哪里|什么|怎么|介绍一下)/.test(t)) return true;
  return false;
}

// 真·换脸（ReActor）意图：先发要改的图、再发脸的图，然后说这类词 → 把后发的脸换到先发的图上
function isFaceSwapIntent(text) {
  const t = String(text || '');
  return /换脸|替脸|换头|个头|头换|把.*脸|脸换|脸换成|贴脸|换张脸|把.*头/.test(t);
}
// 双图融合意图：必须「两张图 + 这类词」才走融合工作流（普通“改成/变成”只编辑单张图，避免误把两张图强行糊一起）
function isFusionIntent(text) {
  const t = String(text || '');
  return /融合|合成|双图|两张图|两人|双人|拼在一起|结合(到|这|一|在)|合影/.test(t);
}

// 调用配置里的图像端点，返回 { ok, file?(base64:// 或 url), error? }
async function callImageGen(prompt, imgOverride) {
  const img = imgOverride || CFG.image || {};
  // 本地 Stable Diffusion WebUI（A1111）后端：走 /sdapi/v1/txt2img，返回 images[0] 的 base64
  const prov = String(img.provider
    || (String(img.endpoint || '').includes('/sdapi/') ? 'sd'
      : (/:(8188|8189)\b/.test(String(img.endpoint || '')) ? 'comfyui' : 'openai'))).toLowerCase();
  if (prov === 'comfyui') return await callComfyUIImage(prompt, img);
  if (prov === 'sd') return await callSdTxt2Img(prompt, img);
  // 云端图像端点：DeepSeek 官方无此能力，且不再默认指向任何中转站（原先的 uuapi 已欠费停用）
  const endpoint = String(img.endpoint || '').trim();
  if (!endpoint) return { ok: false, error: 'no-remote-image-endpoint' };
  if (/uuapi\.io/i.test(endpoint)) return { ok: false, error: 'remote-image-endpoint-disabled' };
  const model = img.model || '';
  let key = '';
  try {
    const sec = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'secrets.json'), 'utf-8'));
    key = sec[img.apiKeyRef || 'imageApiKey'] || sec.apiKey || '';
  } catch (e) {}
  if (!key) key = API_KEY; // 兜底用主 key（仅尽力而为；官方无图像端点时仍会失败）
  const body = { prompt: String(prompt).slice(0, 1000) };
  if (model) body.model = model;
  body.n = 1;
  if (img.size) body.size = img.size;
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(img.timeoutMs) || 60000),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) return { ok: false, error: 'http ' + r.status };
    const d = j.data;
    let raw = null;
    if (Array.isArray(d) && d[0]) raw = d[0].b64_json || d[0].url || null;
    else if (d && (d.b64_json || d.url)) raw = d.b64_json || d.url;
    if (!raw) return { ok: false, error: 'no-image-in-response' };
    // url → 下载为 base64（NapCat 需要 base64:// 或本地路径或直链）
    // 安全整改：第三方 API 响应里带回的 URL 属于不可信输入，必须走 safeFetch
    // （旧代码用裸 fetch 直连该 URL，响应指向内网即 SSRF 打穿）
    let b64 = raw;
    if (/^https?:\/\//i.test(raw)) {
      try {
        const ir = await safeFetch(raw, {
          maxRedirects: 3,
          maxBytes: 16 * 1024 * 1024,
          maxDecompressedBytes: 16 * 1024 * 1024,
          headers: { 'User-Agent': UA, Referer: raw },
        });
        if (!ir.ok) return { ok: false, error: 'download-blocked:' + ir.kind };
        b64 = ir.body.toString('base64');
      } catch (e) { return { ok: false, error: 'download-failed' }; }
    }
    const file = /^data:/i.test(b64) ? b64 : 'base64://' + b64;
    return { ok: true, file };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'timeout' : e.message };
  }
}

// 本地 SD WebUI 文生图（provider='sd'）：只连本机 127.0.0.1，不出网
async function callSdTxt2Img(prompt, img) {
  const base = String(img.endpoint || 'http://127.0.0.1:7860/sdapi/v1/txt2img').replace(/\/+$/, '');
  // 负面词：配置值优先；为空时用默认；SD1.5 embedding 按开关追加
  //（引用名=文件名去扩展名，A1111 textual inversion 机制；两个 embedding 均为 768 维 SD1.5 格式，
  //  仅在与 SD1.5 兼容的模型上开启；SDXL 等 1024 维模型禁用，否则报错）
  let neg = String(img.negativePrompt || '').trim();
  if (!neg) neg = 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry';
  const embeds = [];
  if (img.useEasyNegative) embeds.push('EasyNegative');
  if (img.useBadhandv4) embeds.push('badhandv4');
  if (embeds.length) neg = neg + ', ' + embeds.join(', ');
  const body = {
    prompt: String(prompt).slice(0, 2000),
    negative_prompt: neg,
    steps: Number(img.steps) || 20,
    cfg_scale: Number(img.cfgScale) || 7,
    width: Number(img.width) || 512,
    height: Number(img.height) || 512,
    sampler_name: String(img.sampler || 'DPM++ 2M Karras'),
  };
  // Hires.fix：可配置，默认关闭（配置缺省或 enabled=false 时完全不带该参数）
  const hr = img.hiresFix || {};
  if (hr && hr.enabled) {
    body.enable_hr = true;
    body.hr_scale = Number(hr.scale) || 2;
    body.hr_upscaler = String(hr.upscaler || 'Latent');
    body.hr_second_pass_steps = Number(hr.steps) || 15;
    body.denoising_strength = Number(hr.denoising) || 0.5;
  }
  try {
    const r = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(img.timeoutMs) || 120000),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) return { ok: false, error: 'http ' + r.status + ' ' + String((j && (j.error || j.detail)) || '').slice(0, 120) };
    const b = Array.isArray(j.images) && j.images[0] ? String(j.images[0]) : null;
    if (!b) return { ok: false, error: 'no-image-in-response' };
    const b64 = b.replace(/^data:image\/[a-z+]+;base64,/i, '');
    return { ok: true, file: 'base64://' + b64 };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'timeout' : e.message };
  }
}

// 把 QQ 图片段转成 Buffer（复用 fetchImageAsBase64 的 get_image/本地/下载链路）
async function fetchImageBuffer(seg) {
  const dataUrl = await fetchImageAsBase64(seg);
  if (!dataUrl) return null;
  const i = dataUrl.indexOf(',');
  if (i < 0) return null;
  return Buffer.from(dataUrl.slice(i + 1), 'base64');
}

// ================= ComfyUI 后端（本机 Z-Image-Turbo / GGUF） =================
// 上传图片到 ComfyUI 输入目录，返回 {ok, name}，name 可直接用于 LoadImage 节点
async function uploadComfyImage(base, buf, filename) {
  try {
    const form = new FormData();
    form.append('image', new Blob([buf]), filename || 'qq_source.png');
    form.append('overwrite', 'true');
    const r = await fetch(base.replace(/\/+$/, '') + '/upload/image', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60000),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.name) {
      return { ok: false, error: 'upload ' + r.status + ' ' + String((j && (j.error && j.error.message || j.error)) || '').slice(0, 120) };
    }
    return { ok: true, name: j.name };
  } catch (e) {
    return { ok: false, error: e && e.name === 'TimeoutError' ? 'upload-timeout' : String((e && e.message) || e).slice(0, 120) };
  }
}

function extFromImageBuf(buf) {
  if (!buf || !buf.length) return '.png';
  const h = buf.slice(0, 4).toString('hex');
  if (h.startsWith('89504e47')) return '.png';
  if (h.startsWith('ffd8ff')) return '.jpg';
  if (h.startsWith('47494638')) return '.gif';
  if (h.startsWith('52494646') || h.startsWith('77656270')) return '.webp';
  return '.png';
}

// 与 A1111 的区别：A1111 一次 POST 直接出图；ComfyUI 是「提交工作流 → 轮询 history → /view 取回图片」三步。
// 只连本机 127.0.0.1，不出网；图片取回后转 base64:// 交给 NapCat 发送（与 A1111 分支返回格式一致）。
async function callComfyUIImage(prompt, img) {
  const base = String(img.endpoint || 'http://127.0.0.1:8188').replace(/\/+$/, '');
  // 支持多张源图：图生图用 1 张（sourceSeg）；双图融合用 2 张（sourceSeg + sourceSeg2）；换脸用 2 张（targetSeg=目标图 + faceSeg=源脸）
  const srcSegs = [];
  if (img.targetSeg || img.faceSeg) {
    if (img.targetSeg) srcSegs.push(img.targetSeg);
    if (img.faceSeg) srcSegs.push(img.faceSeg);
  } else {
    if (img.sourceSeg) srcSegs.push(img.sourceSeg);
    if (img.sourceSeg2) srcSegs.push(img.sourceSeg2);
  }
  const hasSources = srcSegs.length > 0;
  const isFaceSwap = !!String(img.faceSwapWorkflow || '').trim() && srcSegs.length >= 2;
  const isFusion = !isFaceSwap && srcSegs.length >= 2 && !!String(img.fusionWorkflow || '').trim();
  const wantLora = !hasSources && !!String(img.loraName || '').trim();

  let wfPath;
  if (isFaceSwap) wfPath = String(img.faceSwapWorkflow).trim();
  else if (isFusion) wfPath = String(img.fusionWorkflow).trim();
  else if (hasSources) wfPath = String(img.img2imgWorkflow || img.workflow || '').trim();
  else wfPath = String((wantLora && img.loraWorkflow) || img.workflow || '').trim();
  if (!wfPath) return { ok: false, error: 'comfyui-workflow-not-configured' };

  // 上传所有源图（多图融合时两张都上传，分别填到工作流的两个 LoadImage 节点）
  const uploaded = [];
  for (let si = 0; si < srcSegs.length; si++) {
    const buf = await fetchImageBuffer(srcSegs[si]);
    if (!buf) return { ok: false, error: 'source-image-fetch-failed' };
    const fn = 'qq_src_' + Date.now() + '_' + si + extFromImageBuf(buf);
    const up = await uploadComfyImage(base, buf, fn);
    if (!up.ok) return { ok: false, error: up.error };
    uploaded.push(up.name);
  }

  let wf;
  try { wf = JSON.parse(fs.readFileSync(wfPath, 'utf-8')); }
  catch (e) { log('[生图] 工作流读取失败 ' + wfPath + '：' + String((e && e.message) || e).slice(0, 80)); return { ok: false, error: 'workflow-read-failed' }; }

  // —— 按节点类型改参数（不依赖固定 key，工作流在 ComfyUI 里改过也能适配）——
  const W = Math.max(256, Math.min(1536, Math.round((Number(img.width) || 1024) / 8) * 8));
  const H = Math.max(256, Math.min(1536, Math.round((Number(img.height) || 1024) / 8) * 8));
  const seed = Math.floor(Math.random() * 4294967295);
  const denoise = isFusion ? (Number(img.fusionDenoise) || 0.6)
    : hasSources ? (Number(img.img2imgDenoise) || 0.65) : 1;
  let encIdx = 0, li = 0;
  for (const k of Object.keys(wf)) {
    const n = wf[k];
    if (!n || !n.class_type) continue;
    try {
      if (n.class_type === 'CLIPTextEncode') {
        // 第一个 = 正向；其后 = 负向（CFG=1 时负向实际不起作用，留空即可）
        n.inputs.text = encIdx === 0 ? String(prompt).slice(0, 2000) : String(img.negativePrompt || '');
        encIdx++;
      } else if (!hasSources && (n.class_type === 'EmptySD3LatentImage' || n.class_type === 'EmptyLatentImage')) {
        n.inputs.width = W; n.inputs.height = H; n.inputs.batch_size = 1;
      } else if (hasSources && n.class_type === 'LoadImage') {
        // 单图：所有 LoadImage 都填同一张（兼容旧工作流）；融合：按节点顺序各填一张
        if (uploaded[li] != null) {
          n.inputs.image = uploaded[li];
          if (srcSegs.length > 1) li++;
        }
      } else if (n.class_type === 'KSampler' || n.class_type === 'KSamplerAdvanced') {
        n.inputs.seed = seed;
        n.inputs.steps = Number(img.steps) || 9;
        n.inputs.cfg = Number(img.cfgScale) || 1;
        n.inputs.denoise = denoise;
        if (img.sampler) n.inputs.sampler_name = String(img.sampler);
        if (img.scheduler) n.inputs.scheduler = String(img.scheduler);
      } else if (n.class_type === 'SaveImage') {
        n.inputs.filename_prefix = String(img.filenamePrefix || 'qq');
      } else if (n.class_type === 'LoraLoader' && wantLora) {
        n.inputs.lora_name = String(img.loraName);
        n.inputs.strength_model = Number(img.loraStrength) || 0.8;
        n.inputs.strength_clip = Number(img.loraStrength) || 0.8;
      }
    } catch (e) { /* 单个节点改不动就跳过，不整单失败 */ }
  }
  if (!encIdx && !isFaceSwap) return { ok: false, error: 'workflow-no-cliptextencode' };

  const deadline = Date.now() + (Number(img.timeoutMs) || 180000);
  try {
    const r = await fetch(base + '/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: wf, client_id: 'napcat-bridge' }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.prompt_id) {
      return { ok: false, error: 'http ' + r.status + ' ' + String((j && (j.error && j.error.message || j.error)) || '').slice(0, 120) };
    }
    const pid = j.prompt_id;

    // 轮询 history（ComfyUI 没有同步出图接口，只能轮询）
    let shot = null;
    while (Date.now() < deadline) {
      await new Promise((s) => setTimeout(s, 2000));
      const hr = await fetch(base + '/history/' + pid, { signal: AbortSignal.timeout(15000) }).catch(() => null);
      if (!hr || !hr.ok) continue;
      const hj = await hr.json().catch(() => null);
      const entry = hj && hj[pid];
      if (!entry) continue;
      const st = (entry.status && entry.status.status_str) || '';
      if (st === 'error') return { ok: false, error: 'comfyui-exec-error' };
      if (!entry.status || !entry.status.completed) continue;
      for (const nk of Object.keys(entry.outputs || {})) {
        const imgs = entry.outputs[nk] && entry.outputs[nk].images;
        if (Array.isArray(imgs) && imgs[0]) { shot = imgs[0]; break; }
      }
      if (shot) break;
    }
    if (!shot) return { ok: false, error: Date.now() >= deadline ? 'timeout' : 'no-image-in-response' };

    // /view 取回图片字节 → base64
    const q = 'filename=' + encodeURIComponent(shot.filename)
      + '&subfolder=' + encodeURIComponent(shot.subfolder || '')
      + '&type=' + encodeURIComponent(shot.type || 'output');
    const vr = await fetch(base + '/view?' + q, { signal: AbortSignal.timeout(60000) });
    if (!vr.ok) return { ok: false, error: 'view-http-' + vr.status };
    const ab = await vr.arrayBuffer();
    if (!ab || !ab.byteLength) return { ok: false, error: 'view-empty' };
    return { ok: true, file: 'base64://' + Buffer.from(ab).toString('base64') };
  } catch (e) {
    return { ok: false, error: e && e.name === 'TimeoutError' ? 'timeout' : String((e && e.message) || e).slice(0, 120) };
  }
}

// 简单文本回执（群带 @ + 引用，私聊带引用）
async function sendSimpleReply(ev, isGroup, userId, text) {
  const out = [{ type: 'text', data: { text } }];
  if (isGroup) {
    out.unshift({ type: 'at', data: { qq: String(userId) } });
    if (ev.message_id != null) out.unshift({ type: 'reply', data: { id: String(ev.message_id) } });
    await napcatCall('send_group_msg', { group_id: ev.group_id, message: out });
  } else {
    if (ev.message_id != null) out.unshift({ type: 'reply', data: { id: String(ev.message_id) } });
    await napcatCall('send_private_msg', { user_id: userId, message: out });
  }
}

// —— 回复拆句：像真人接话一样分几条发（第一条引用原消息，后续不引用）——
// 规则：按句末标点切；代码块/多行列表表格/只有一句 → 不拆；条数上限 maxParts。
function splitReplyText(text, maxPartsIn) {
  const t = String(text || '').trim();
  if (!t) return [];
  const maxParts = Math.max(1, Number(maxPartsIn) || 3);
  // 代码块、多行（列表/表格）拆了会格式错乱 → 整条发
  if (/```/.test(t) || t.split('\n').filter((x) => x.trim()).length > 2) return [t];
  const sents = (t.match(/[^。！？!?…~～]+[。！？!?…~～]+|[^。！？!?…~～]+$/g) || [t])
    .map((s) => s.trim()).filter(Boolean);
  if (sents.length <= 1) return [t];
  if (sents.length <= maxParts) return sents;
  // 超过上限 → 均分合并成 maxParts 条
  const buckets = Array.from({ length: maxParts }, () => []);
  const per = Math.ceil(sents.length / maxParts);
  sents.forEach((s, i) => buckets[Math.min(maxParts - 1, Math.floor(i / per))].push(s));
  return buckets.map((b) => b.join('')).filter(Boolean);
}

// 生图质量增强：AWPainting 等模型只吃英文 Danbooru 标签，
// 用户发中文直接丢给 SD 会出糙图/不搭图。这里做三件事：
// ① 中文需求 → 英文 Danbooru 标签（复用文本模型翻译，失败则降级用原文）
// ② 拼接质量词（已含则不重复加）
// ③ 默认负面词（配置里没配 negativePrompt 时兜底，见 callSdTxt2Img）
const IMAGE_QUALITY_TAGS = 'masterpiece, best quality, very aesthetic, absurdres';

async function translateToDanbooruTags(text) {
  try {
    const out = await genText(
      `把下面这条绘画需求改写成英文 Danbooru 标签：逗号分隔的英文短语，描述主体、服装、动作、场景、氛围（如 1girl, solo, umbrella, rain, wet clothes, city street）。`
      + `保留需求里提到的专有名词（人名/角色名用英文或罗马音）。只输出标签，不要解释、不要句号、不要换行段落。\n需求：${text}`,
      { system: '你是 Stable Diffusion 的 prompt 工程师，只输出英文 Danbooru 标签。', maxTokens: 300, temperature: 0.3 }
    );
    const t = String(out || '').trim();
    // 清洗：翻车了就返回空，让调用方降级用原文
    if (!t || /[\u4e00-\u9fff]/.test(t)) return '';
    // 只取前两行、按逗号规整，防模型啰嗦
    const tags = t.split('\n').slice(0, 2).join(', ')
      .split(',').map(s => s.trim()).filter(Boolean).slice(0, 30).join(', ');
    return tags;
  } catch (e) {
    log('[生图] 标签翻译失败，降级用原文：' + (e && e.message));
    return '';
  }
}

async function enhanceImagePrompt(prompt) {
  let p = String(prompt || '').trim();
  if (!p) return p;
  // ① 含中文 → 先翻成英文标签
  if (/[\u4e00-\u9fff]/.test(p)) {
    const tags = await translateToDanbooruTags(p);
    if (tags) p = tags;
  }
  // ② 质量词（已含任一词则视为用户有意控制，不硬塞）
  const hasQ = IMAGE_QUALITY_TAGS.split(', ').some(w => new RegExp(w.replace(/[+]/g, '\\+'), 'i').test(p));
  if (!hasQ) p = p + ', ' + IMAGE_QUALITY_TAGS;
  return p;
}

// 处理生图意图：命中则返回 true（已消费该消息）
async function handleImageGen(text, ev, opts) {
  // 合并「跨消息记住的图」，支持「先发图A、再发图B、再打字说融合」的双图场景（非 Agent 兜底路径同样生效）
  const memImgs = peekPendingImages(opts.isGroup ? (ev && ev.group_id) : null, opts.userId);
  const _seen = new Set();
  const allImgs = [];
  for (const s of [].concat(opts.imgSegs || [], memImgs || [])) {
    const id = (s && s.data && (s.data.file || s.data.url)) || '';
    if (id) { if (_seen.has(id)) continue; _seen.add(id); }
    allImgs.push(s);
  }
  const hasImg = allImgs.length > 0;
  const isImg2Img = isImg2ImgIntent(text, hasImg);
  let prompt = (String(text).replace(/^([\s\S]*?)(画|绘|生图|生成图片|出张图|生一张图|给我画|帮我画|重绘|重画|改|变)/i, '')
    .replace(/^[：:，,。!\s的一只个张条幅座棵片套图]+/, '').trim()) || String(text).trim();
  const img = CFG.image || {};
  if (!img.enabled) {
    await sendSimpleReply(ev, opts.isGroup, opts.userId,
      '画图这个我现在还整不了——没给我配生图后端（当前 image.enabled=false）。管理员去 ai_config.json 把 image.enabled 打开、配好 endpoint/model/apiKey，我就能画了。');
    return true;
  }
  // ① 安全硬过滤（翻译前，中文原文）：命中即拒，不调用 SD API，日志不记原文
  const unsafe1 = checkImagePromptSafety(prompt);
  if (unsafe1) {
    log(`[生图安全] 拒绝 user=${opts.userId} 规则=${unsafe1.rule}`);
    await sendSimpleReply(ev, opts.isGroup, opts.userId,
      '这个忙我不帮——涉及我不能生成的内容（安全规则 ' + unsafe1.rule + '）。换个正常的题，我都能画。');
    return true;
  }
  // ② 画质增强：A1111(SD1.5) 吃英文 Danbooru 标签 + 质量词；
  //    ComfyUI(Z-Image) 是自然语言模型（Qwen3 编码器），中文原文效果最好，硬套标签反而跑偏
  if (String((CFG.image || {}).provider || '').toLowerCase() !== 'comfyui' && (CFG.image || {}).useDanbooru !== false) {
    prompt = await enhanceImagePrompt(prompt);
  }
  // ③ 安全硬过滤（翻译后，防翻译结果引入违规词）
  const unsafe2 = checkImagePromptSafety(prompt);
  if (unsafe2) {
    log(`[生图安全] 拒绝(译后) user=${opts.userId} 规则=${unsafe2.rule}`);
    await sendSimpleReply(ev, opts.isGroup, opts.userId,
      '这个忙我不帮——涉及我不能生成的内容（安全规则 ' + unsafe2.rule + '）。换个正常的题，我都能画。');
    return true;
  }
  // ④ 生图队列（GPU 串行 + 每用户冷却；群文本冷却不是并发锁，这里才是）
  // 换脸（ReActor）：先发=目标图、后发=源脸图 + 换脸词 → 走 faceSwapWorkflow；双图融合 → fusionWorkflow；否则按原图生图逻辑
  let sourceSeg = null, sourceSeg2 = null, targetSeg = null, faceSeg = null;
  const faceSwap = isFaceSwapIntent(text) && allImgs.length >= 2;
  const faceSwapWf = String((CFG.image || {}).faceSwapWorkflow || '').trim();
  if (faceSwap) {
    if (!faceSwapWf) {
      await sendSimpleReply(ev, opts.isGroup, opts.userId,
        '想换脸但还没配 faceSwapWorkflow（ai_config.json 里 image.faceSwapWorkflow 指向我目录里的 reactor_faceswap.json）。先让管理员配一下吧～');
      return true;
    }
    targetSeg = allImgs[0]; faceSeg = allImgs[1];   // 先发=目标（身体），后发=源脸（要换上的脸）
  } else {
    const fusion = isFusionIntent(text) && allImgs.length >= 2;
    const fusionWf = String((CFG.image || {}).fusionWorkflow || '').trim();
    if (fusion) {
      if (!fusionWf) {
        await sendSimpleReply(ev, opts.isGroup, opts.userId,
          '想做双图融合，但还没配 fusionWorkflow（ai_config.json 里 image.fusionWorkflow 指向我目录里的 z_image_turbo_2img_fusion.json）。先让管理员配一下吧～');
        return true;
      }
      sourceSeg = allImgs[0]; sourceSeg2 = allImgs[1];
    } else if (isImg2Img) {
      sourceSeg = allImgs[0];
    }
  }
  const q = imgQueueEnter(opts.userId, prompt, sourceSeg, sourceSeg2, targetSeg, faceSeg);
  if (q.status === 'cooldown') {
    await sendSimpleReply(ev, opts.isGroup, opts.userId, `生图冷却中，还要等 ${q.waitSec} 秒～画完上张再来。`);
    return true;
  }
  if (q.status === 'duplicate') {
    await sendSimpleReply(ev, opts.isGroup, opts.userId, '你已经有一张在排队/在画了，画完这张再来～');
    return true;
  }
  if (q.status === 'full') {
    await sendSimpleReply(ev, opts.isGroup, opts.userId, `画画队列满了（前面还排着 ${q.queueLen} 张），稍等一下再试～`);
    return true;
  }
  // ⑤ 排队提示（前面有人时才提示位置）+ 先用一句话接住（用户要求：先回答，再生图）
  if (q.position > 1) {
    await sendSimpleReply(ev, opts.isGroup, opts.userId, `排上队了，前面还有 ${q.position - 1} 位，画到你这张就发～`);
  }
  const ack = await genImageAck(prompt, isImg2Img);
  await sendSimpleReply(ev, opts.isGroup, opts.userId, ack);
  // ⑥ 等队列执行完毕（超时/异常由队列层兜底 resolve，不会卡死队列）
  const r = await q.promise;
  if (!r || !r.ok) {
    const err = String((r && r.error) || 'unknown');
    const why = err === 'no-image-in-response'
      ? '后端没返回图'
      : (err === 'timeout' ? '生图超时了，稍后再试' : ('生图失败：' + err.slice(0, 80)));
    await sendSimpleReply(ev, opts.isGroup, opts.userId, '没画出来：' + why + '。');
    return true;
  }
  const out = [{ type: 'image', data: { file: r.file } }];
  if (opts.isGroup) {
    out.unshift({ type: 'at', data: { qq: String(opts.userId) } });
    if (ev.message_id != null) out.unshift({ type: 'reply', data: { id: String(ev.message_id) } });
    try {
      await napcatCall('send_group_msg', { group_id: ev.group_id, message: out });
    } catch (e) {
      log('[生图] 图片发送失败(群)：' + String((e && e.message) || e).slice(0, 120));
      await sendSimpleReply(ev, opts.isGroup, opts.userId, '图画好了但没发出来（发送失败），稍后再试一次～');
    }
  } else {
    if (ev.message_id != null) out.unshift({ type: 'reply', data: { id: String(ev.message_id) } });
    try {
      await napcatCall('send_private_msg', { user_id: opts.userId, message: out });
    } catch (e) {
      log('[生图] 图片发送失败(私聊)：' + String((e && e.message) || e).slice(0, 120));
      await sendSimpleReply(ev, opts.isGroup, opts.userId, '图画好了但没发出来（发送失败），稍后再试一次～');
    }
  }
  return true;
}

function log(msg) {
  const line = new Date().toLocaleString('zh-CN') + ' ' + redact(msg);
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf-8'); } catch (e) {}
}

function loadPrompt() {
  try {
    const t = fs.readFileSync(PROMPT_FILE, 'utf-8').trim();
    if (t) return t;
  } catch (e) {}
  return DEFAULT_PROMPT;
}

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

async function napcatCall(action, payload) {
  const headers = { 'Content-Type': 'application/json' };
  if (ONEBOT_TOKEN) headers['Authorization'] = 'Bearer ' + ONEBOT_TOKEN;
  try {
    const r = await fetch(`${NAPCAT_API}/${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    return await r.json();
  } catch (e) {
    log('[错误] NapCat 调用失败 ' + action + ': ' + e.message);
    return null;
  }
}

// ================= 联网工具实现 =================
function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ').replace(/&ensp;/g, ' ').replace(/&emsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&middot;/g, '·')
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d));
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// V14-C.2：SSRF 校验统一走 url_safety 模块（基础规则与原来完全一致，另加重定向逐跳校验）
const isSafeUrl = urlSafety.isSafeUrl;
const assertSafeTarget = urlSafety.assertSafeTarget;
const safeUrlForLog = urlSafety.safeUrlForLog;
const sanitizeUrlForUse = urlSafety.sanitizeUrlForUse;
const MAX_REDIRECTS = urlSafety.MAX_REDIRECTS;

// —— 相关性判断：标题/摘要里至少得出现 query 的一个 2 字片段或英文词 ——
// 先整体删掉这些提问套话（只删"什么"这种 2 字词会留下"是什"这种跨词碎片，导致误判）
const STOP_PHRASES = [
  '是什么意思', '是什么梗', '是什么', '什么是', '什么意思', '什么梗',
  '怎么样', '怎么办', '为什么', '有哪些', '哪个好', '怎么用',
  '多少钱', '什么时候', '如何', '怎么', '介绍', '资料', '一下',
];
const STOP_GRAMS = new Set([
  '百科', '大全', '官网', '下载', '视频', '图片', '意思', '含义', '介绍',
  '资料', '最新', '新闻', '直播', '在线', '免费', '完整', '高清', '内容',
  '相关', '查询', '推荐', '排行', '哪个', '哪些', '一个', '就是', '可以',
  '这个', '那个', '我们', '你们', '他们', '现在', '今天', '明天',
]);

// —— 相关性打分 v2 ——
// 旧实现是「任意一个 2-gram 命中就通过」，等于没有过滤：
// 搜「Python 装饰器 作用」时，python.org 首页因为标题里含 python 就会被当成相关结果。
// 现在改为：分别统计「标题覆盖率」和「全文覆盖率」，标题权重更高，覆盖率过低直接淘汰；
// 站点首页只有高度相关时才保留（搜「XX官网」时首页才是答案）。
const REL_MIN = 0.22;    // 低于此分视为不相关
const REL_GOOD = 0.45;   // 达到此分算高质量

function buildQueryGrams(query) {
  let q = String(query).replace(/[\s“”"'’]/g, '');
  for (const p of STOP_PHRASES) q = q.split(p).join('');
  const grams = [];
  const seen = new Set();
  const push = (g) => { if (!seen.has(g)) { seen.add(g); grams.push(g); } };
  for (let i = 0; i + 2 <= q.length; i++) {
    const g = q.slice(i, i + 2);
    if (/^[一-龥]{2}$/.test(g) && !STOP_GRAMS.has(g)) push(g);
  }
  for (const w of String(query).split(/[\s,，、]+/)) {
    if (/^[a-zA-Z0-9]{2,}$/.test(w)) push(w.toLowerCase());
  }
  return grams;
}

// 返回 0~1 的相关度分数
function relevanceScore(query, title, text) {
  const grams = buildQueryGrams(query);
  if (!grams.length) return 1;
  const t = String(text || '').toLowerCase();
  const ti = String(title || '').toLowerCase();
  let hit = 0, hitTitle = 0;
  for (const g of grams) {
    if (t.includes(g)) hit++;
    if (ti.includes(g)) hitTitle++;
  }
  let score = (hit / grams.length) * 0.45 + (hitTitle / grams.length) * 0.55;
  if (hit === grams.length) score = Math.min(1, score + 0.25);  // 查询词全覆盖，明显相关
  return score;
}

// 是否是站点首页（根路径或 index.html）——首页几乎不会是搜索答案
function isHomepage(link) {
  let path = '';
  try { path = new URL(String(link)).pathname.replace(/\/+$/, ''); } catch (e) { return false; }
  if (path === '') return true;
  return /^\/(index|home|default|main)\.[a-z]+$/i.test(path);
}

// 一条搜索结果是否可用；顺带把分数写回 item._score 供排序
function searchResultOK(query, item) {
  if (!item || !item.title) return false;
  const sc = relevanceScore(query, item.title, item.title + ' ' + (item.snippet || ''));
  item._score = sc;
  if (sc < REL_MIN) return false;
  if (isHomepage(item.link) && sc < REL_GOOD) return false;
  return true;
}

// 兼容旧调用点（只拿到拼好的文本，无法判定首页）——走同一套打分
function relevanceOK(query, text) {
  return relevanceScore(query, '', text) >= REL_MIN;
}

// 清洗回复：DeepSeek 偶尔会把工具调用的特殊 token 当正文吐出来
function cleanReply(s) {
  if (!s) return '';
  // v11：一并拦截模型偶发吐出的内部安全标签（如 <ds_safety>…）
  if (/DSML|<｜|invoke\s+name=|tool_calls|<ds_|ds_safety/i.test(s)) return '';
  return s.trim();
}

// ================= 输出安全过滤层 =================
// 用户消息 → AI → 【这里】 → QQ
// 命中任何一条，整条回复替换成统一话术，不发送原文
const LEAK_RULES = [
  { name: 'apikey', re: /sk-[A-Za-z0-9_-]{12,}/ },
  // V14-C.3 修复 A：旧写法 /[A-Za-z]:[\\/]{1,2}.../ 会把 https:// 里的 "s://" 当成盘符，
  // 导致**任何带网址的回复**都被整条替换成拒答话术（B站链接 / 搜索结果链接全部发不出去）。
  // 加「盘符前一个字符不能是字母或数字」的约束：协议里的 s 前面是 p → 不再匹配；
  // 真正的 D:\ 、C:/ 前面是空格/中文/括号 → 照常拦截。其余安全规则一条未动。
  { name: 'winpath', re: /(?<![A-Za-z0-9])[A-Za-z]:(?:\\|\/)[^\s"'<>|]{2,}/ },
  { name: 'localport', re: /(?:127\.0\.0\.1|localhost|0\.0\.0\.0):\d{2,5}/i },
  { name: 'infra', re: /\b(napcat|onebot|ai_bridge|ai_prompt|webui|secrets\.json)\b/i },
  // 人设不绑定具体模型厂商；仍拦截任何外部模型名声明（GPT/Claude/通义/豆包等），防串味、防泄露后端
  { name: 'selfmodel', re: /(?:我是|我是基于|我叫|我用的?是)\s*(?:GPT|ChatGPT|Claude|通义千问|文心一言|豆包|OpenAI)/i },
  { name: 'stack', re: /\bat\s+[\w$.]+\s*\([^)]*:\d+:\d+\)|node_modules|\bTypeError\b|\bReferenceError\b/ },
  { name: 'promptleak', re: /系统提示词|系统提示|system\s*prompt|我的提示词/ },
];

const LEAK_FALLBACK = '这个属于我的内部配置，就不展开啦。';

function sanitizeOutput(s) {
  const text = String(s || '');
  if (!text) return '';
  const hit = LEAK_RULES.filter((r) => r.re.test(text)).map((r) => r.name);
  if (hit.length) {
    log('[输出拦截] 命中: ' + hit.join(','));
    return LEAK_FALLBACK;
  }
  return text;
}

// 优雅截断：优先在句末切，不在句中硬断
function truncateNicely(s, max) {
  const t = String(s || '');
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  for (const stop of ['。', '！', '？', '!', '?', '\n', '；']) {
    const i = head.lastIndexOf(stop);
    if (i >= Math.floor(max * 0.4)) {
      return head.slice(0, i + 1).replace(/\s+$/, '');
    }
  }
  return head.replace(/\s+$/, '') + '…';
}

function parseBing(html, n) {
  const out = [];
  const re = /<li class="b_algo"[\s\S]*?<\/li>/g;
  let m;
  while ((m = re.exec(html)) && out.length < n) {
    const b = m[0];
    const tm = b.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    const lm = b.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"/);
    const pm = b.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const title = tm ? stripTags(tm[1]) : '';
    let link = lm ? decodeEntities(lm[1]) : '';
    if (link.startsWith('/')) link = 'https://cn.bing.com' + link;
    const snippet = pm ? stripTags(pm[1]) : '';
    // 发布时间：Bing 放在 <span class="news_dt">（如「2026年9月24日」「2天前」）
    const dm = b.match(/class="[^"]*news_dt[^"]*"[^>]*>([\s\S]{0,80}?)</);
    let date = dm ? stripTags(dm[1]).replace(/\s*[·|]\s*$/, '').trim() : '';
    if (date.length > 30) date = '';
    if (title) out.push({ title, link, snippet, date });
  }
  return out;
}

// 通用解析：抓页面里所有 h3 标题块 + 其后最近的摘要
// 对搜狗 / 移动百度都适用，比针对单一站点写死选择器更抗改版
function parseGenericH3(html, n, reject) {
  const out = [];
  const re = /<h3[^>]*>([\s\S]{0,500}?)<\/h3>/g;
  let m;
  while ((m = re.exec(html)) && out.length < n) {
    const block = m[1];
    const am = block.match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!am) continue;
    const title = stripTags(am[2]);
    if (!title || title.length < 4 || title.length > 90) continue;
    if (reject && reject.test(title)) continue;
    const after = html.slice(
      m.index + m[0].length,
      m.index + m[0].length + 2000
    );
    let snippet = '';
    const sm =
      after.match(/<p[^>]*>([\s\S]{10,400}?)<\/p>/) ||
      after.match(
        /<div[^>]*class="[^"]*(?:space-txt|abstract|line-clamp|c-color-text|content-right)[^"]*"[^>]*>([\s\S]{10,400}?)<\/div>/
      );
    if (sm) snippet = stripTags(sm[1]);
    snippet = cleanSnippet(snippet);
    out.push({ title, link: decodeEntities(am[1]), snippet });
  }
  return out;
}

// 搜狗/百度摘要里常混进转义后的标签碎片（全角引号导致 stripTags 漏刷），再清一遍
function cleanSnippet(s) {
  return String(s)
    .replace(/\b[a-zA-Z][\w-]*\s+[\w-]+\s*=\s*[＂"'][^＂"']*[＂"']\s*;?/g, '')
    .replace(/^[\s;；]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const REJECT_TITLE = /图片|视频大全|相关搜索|其他人还搜|百度一下|登录|注册|下载APP|反馈|下一页/;

// 移动百度：中文新词/梗的召回最好，但限流严，请求间隔要够长
let lastMbaiduAt = 0;
async function mbaiduSearch(query, n) {
  if (Date.now() - lastMbaiduAt < 15000) return [];
  lastMbaiduAt = Date.now();
  try {
    // 安全整改：搜索引擎请求同样走 safeFetch（固定 IP + 逐跳重校验 + 限额）
    const r = await safeFetch('https://m.baidu.com/s?word=' + encodeURIComponent(query), {
      maxRedirects: 3,
      maxBytes: 4 * 1024 * 1024,
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
    if (!r.ok) { log('[移动百度失败] kind=' + r.kind); return []; }
    const html = r.body.toString('utf-8');
    if (html.length < 20000 || /安全验证|wappass/.test(html)) {
      log('[移动百度被限流]');
      return [];
    }
    return parseGenericH3(html, n, REJECT_TITLE).map((x) => ({
      ...x,
      link: /^https?:/.test(x.link)
        ? x.link
        : 'https://m.baidu.com' + (x.link.startsWith('/') ? x.link : '/' + x.link),
    }));
  } catch (e) {
    log('[移动百度失败] ' + e.message);
    return [];
  }
}

// 搜狗：不设验证门槛，可作高频兜底
async function sogouSearch(query, n) {
  try {
    // 安全整改：同上，统一走 safeFetch
    const r = await safeFetch('https://www.sogou.com/web?query=' + encodeURIComponent(query), {
      maxRedirects: 3,
      maxBytes: 4 * 1024 * 1024,
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
    if (!r.ok) { log('[搜狗失败] kind=' + r.kind); return []; }
    const html = r.body.toString('utf-8');
    if (html.length < 20000 || /请输入验证|验证码/.test(html)) {
      log('[搜狗被限流]');
      return [];
    }
    return parseGenericH3(html, n, REJECT_TITLE).map((x) => ({
      ...x,
      link: /^https?:/.test(x.link)
        ? x.link
        : 'https://www.sogou.com' + (x.link.startsWith('/') ? x.link : '/' + x.link),
    }));
  } catch (e) {
    log('[搜狗失败] ' + e.message);
    return [];
  }
}

function dedupe(items, n) {
  const seen = new Set();
  const domCount = new Map();
  const out = [];
  for (const x of items) {
    const k = (x.title || '').slice(0, 24);
    if (seen.has(k)) continue;
    seen.add(k);
    // 同一站点最多保留 2 条，避免 5 条结果全是同一个站的不同页面
    let dom = '';
    try { dom = new URL(String(x.link)).hostname.replace(/^www\./, ''); } catch (e) {}
    const c = domCount.get(dom) || 0;
    if (dom && c >= 2) continue;
    domCount.set(dom, c + 1);
    out.push(x);
    if (out.length >= n) break;
  }
  return out;
}

// 是否是「时效性」查询——这类应该走新闻版面并按时间呈现
const FRESH_QUERY_RE = /(最新|今天|今日|现在|当前|近期|最近|新闻|动态|股价|行情|价格|多少钱|发布|上线|发售|更新|通报|消息|官宣|怎么样了)/;
function isFreshQuery(query) {
  return FRESH_QUERY_RE.test(String(query || ''));
}

async function webSearch(query, count) {
  const n = Math.min(Number(count) || SEARCH_RESULTS, 8);
  const fresh = isFreshQuery(query);   // 时效查询走新闻版面
  const hdr = { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' };

  // ① 主源：Bing（时效查询走 news 版面并按时间排序，召回明显更准）
  let items = [];
  try {
    const bingUrl = fresh
      ? 'https://cn.bing.com/news/search?q=' + encodeURIComponent(query)
        + '&qft=sortbydate%3d%221%22&form=YFNR&setlang=zh-CN&mkt=zh-CN'
      : 'https://cn.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=zh-CN&mkt=zh-CN';
    // 安全整改：走 safeFetch（固定 IP + 逐跳重校验 + 限额），不再裸 fetch
    const r = await safeFetch(bingUrl, {
      maxRedirects: 3,
      maxBytes: 4 * 1024 * 1024,
      headers: hdr,
    });
    if (r.ok) items = parseBing(r.body.toString('utf-8'), n * 2);
    else log('[Bing失败] kind=' + r.kind);
  } catch (e) {
    log('[Bing失败] ' + e.message);
  }

  // ② 相关性过滤（按标题/全文覆盖率打分，首页基本被淘汰）
  let good = items.filter((x) => searchResultOK(query, x));

  // ③ 相关结果太少 → 用引号做精确搜索再试一次（对中文短词很有效）
  if (good.length < 2) {
    try {
      // 安全整改：同上，统一走 safeFetch
      const r2 = await safeFetch(
        'https://cn.bing.com/search?q=' + encodeURIComponent('"' + query + '"') + '&setlang=zh-CN&mkt=zh-CN',
        { maxRedirects: 3, maxBytes: 4 * 1024 * 1024, headers: hdr }
      );
      if (r2.ok) {
        const q2 = parseBing(r2.body.toString('utf-8'), n * 2).filter((x) => searchResultOK(query, x));
        if (q2.length > good.length) good = q2;
      } else {
        log('[Bing精确搜索失败] kind=' + r2.kind);
      }
    } catch (e) {
      log('[Bing精确搜索失败] ' + e.message);
    }
  }

  // ④ 还是不够 → 搜狗（不限流，可高频用）
  if (good.length < 2) {
    const sg = (await sogouSearch(query, n * 3)).filter((x) => searchResultOK(query, x));
    if (sg.length) good = good.concat(sg);
  }

  // ⑤ 最后 → 移动百度（召回最好但限流严）
  if (good.length < 2) {
    const bg = (await mbaiduSearch(query, n * 3)).filter((x) => searchResultOK(query, x));
    if (bg.length) good = good.concat(bg);
  }

  const picked = dedupe(good.length ? good : items, n);
  // 时效查询保持搜索源的原始时间序；知识类查询按相关度排序
  const final = fresh ? picked : picked.slice().sort((a, b) => (b._score || 0) - (a._score || 0));
  if (!final.length)
    return '（没搜到相关结果。建议换个说法，或者直接改用英文关键词再搜一次）';

  const head = fresh ? `搜索「${query}」的最新结果：` : `搜索「${query}」的结果：`;
  return (
    head +
    '\n' +
    final
      .map((x, i) => {
        let snip = x.snippet || '';
        if (snip.length > SNIPPET_CHARS) snip = snip.slice(0, SNIPPET_CHARS) + '…';
        const when = x.date ? `（${x.date}）` : '';
        return `${i + 1}. ${x.title}${when}\n   ${snip}\n   ${x.link}`;
      })
      .join('\n')
  );
}

// 安全整改：网页抓取统一走 safeFetch。
// 旧实现是「assertSafeTarget 校验 → 裸 fetch 连接」：校验时的 DNS 解析与连接时的
// DNS 解析相互独立，攻击者用 TTL=0 的域名即可让第二次解析落到内网 IP（DNS 重绑定）。
// safeFetch 把「校验得到的 IP」固定给连接（自定义 lookup 只返回已校验 IP），
// 并在连接建立后用 socket.remoteAddress 复核实际远端 IP，不一致立即中止。
async function fetchUrl(url) {
  let r;
  try {
    r = await safeFetch(url, {
      maxRedirects: MAX_REDIRECTS,
      maxBytes: 4 * 1024 * 1024,               // 网页实际接收字节上限
      maxDecompressedBytes: 8 * 1024 * 1024,   // 解压后上限（防压缩炸弹）
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
  } catch (e) {
    log('[网页] 读取失败 ' + safeUrlForLog(url) + ' 类别=请求异常');
    return '打开网页失败：' + e.message;
  }

  if (!r.ok) {
    // 分类错误文案（保持既有返回格式，调用方 looksFailed 依赖这些前缀）
    if (r.kind === 'blocked') {
      log('[网页] 目标被拒 ' + safeUrlForLog(r.finalUrl || url) + ' 原因=' + r.why);
      return '这个地址不允许访问（' + r.why + '）。';
    }
    if (r.kind === 'max-redirects') {
      log('[网页] 重定向次数超限 ' + safeUrlForLog(r.finalUrl || url));
      return '打开网页失败：重定向次数过多（上限 ' + MAX_REDIRECTS + ' 次）。';
    }
    log('[网页] 读取失败 ' + safeUrlForLog(r.finalUrl || url) + ' 类别=' + r.kind);
    return '打开网页失败：' + (r.error || r.kind);
  }

  const ct = r.contentType || '';
  if (!/text|html|json|xml/i.test(ct)) {
    log('[网页] 读取失败 ' + safeUrlForLog(r.finalUrl) + ' 类别=非网页内容 HTTP=' + r.status);
    return '这个链接不是网页内容（' + ct + '）。';
  }
  let html = r.body.toString('utf-8');
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  let text = stripTags(html);
  if (text.length > FETCH_MAX_CHARS) text = text.slice(0, FETCH_MAX_CHARS) + '…（已截断）';
  return `网页 ${sanitizeUrlForUse(r.finalUrl || url)} 的内容：\n` + text;
}

function getCurrentTime() {
  const d = new Date();
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return `现在是 ${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${week} ${d.toTimeString().slice(0, 8)}（北京时间）`;
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '在互联网上搜索实时信息。当对方问到新闻、天气、比分、价格、最新事件、你不确定的事实，或者需要最新资料时使用。query 要短，只用 1~3 个核心词，不要写整句话。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索关键词，1~3 个词' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: '打开某个网页并读取正文，用于查看搜索结果详情或对方发来的链接内容。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '完整的 http/https 网址' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: '获取当前准确的日期和时间。不确定今天几号、现在几点时使用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description:
        '把值得长期记住的信息记下来，以后聊天会自动带进上下文。用于对方的名字/称呼、喜好、约定、重要事实等。只记有长期价值的内容，闲聊和一次性信息不要记。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '要记住的一句话，简短（比如"群里的小李喜欢打篮球"）' },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_sticker',
      description:
        '单独发一个表情包（不带文字）。想用表情回应、或者觉得光发表情更合适时用。关键词可选，如 开心、无语、点赞、委屈；不填就随机发一个。用这个工具发过之后，回复里就不要再写 [[表情]] 标记了，免得一次发两个。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '表情关键词，可留空表示随机' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description:
        '画一张图并发到当前聊天。对方让你画图、出图、生成图片，或者发了图让你改风格/重绘/换画风时用它。prompt 写清楚画面内容（中文就行，越具体越好：主体、动作、场景、光线、画风）。如果对方发了图并要基于那张图改造（改成xx风格、重绘、变成xx），把 source 填 "1"（用本条消息的第1张图）。如果对方连发了两张图并要融合/换脸/合成，把 source 填其中一张图的位置、source2 填另一张图的位置（例如 source:"1" source2:"2"），我会把两张图融合成一张。画完图会自动发出去，你只要再用一两句自然语言接一下就行，别重复描述图的内容。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '画面描述，中文自然语言，具体一点' },
          source: { type: 'string', description: '可选。想基于对方发的图改造时填 "1"/"2"（本条消息第几张图）；纯文生图不要填' },
          source2: { type: 'string', description: '可选。双图融合/换脸时用：填第二张参考图的位置 "1"/"2"，与 source 配合把两张图融合' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_file',
      description:
        '在自己的工作区里新建一个文本文件（txt/md/csv/json/html 等），把内容写进去，默认顺便发给对方。对方要清单、笔记、代码、说明文档这类东西时用。文件名不用带路径，只写名字即可。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '文件名，例如 待办清单.txt、说明.md' },
          content: { type: 'string', description: '完整的文件内容（纯文本，换行用 \\n）' },
          send: { type: 'boolean', description: '是否自动发给对方，默认 true；只想存着就先设 false' },
        },
        required: ['name', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_table',
      description:
        '生成一个表格文件（默认 Excel .xlsx，也可 csv），默认顺便发给对方。对方要表格、账单、名单、对比表时用。headers 是表头数组，rows 是数据行，每行一个数组，顺序要和表头对应。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '文件名，例如 十月账单.xlsx（可不写扩展名）' },
          headers: { type: 'array', items: { type: 'string' }, description: '表头，例如 ["日期","项目","金额"]' },
          rows: { type: 'array', items: { type: 'array' }, description: '数据行，例如 [["10-01","午饭",25],["10-02","打车",13]]' },
          format: { type: 'string', description: 'csv 或 xlsx，默认 xlsx' },
          send: { type: 'boolean', description: '是否自动发给对方，默认 true' },
        },
        required: ['name', 'headers', 'rows'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取工作区里某个文本文件的内容。想看看之前存的文件、或核对表格内容时用。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '文件名' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出工作区里现有的文件。不确定存过什么、或想找文件名时用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_file',
      description: '把工作区里已有的文件发到当前聊天。之前 send=false 存下的文件，想补发时用。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '文件名' } },
        required: ['name'],
      },
    },
  },
];

// ================= v12：工具按需加载（分组）=================
// 普通聊天默认不挂任何工具定义（工具 schema 本身也要占 token）。
// 只有命中意图时才挂对应分组；chat 模式永远不挂；economy 模式按需；enhanced/normal 保留 V11 全量。
const TOOL_GROUPS = {
  web: ['web_search', 'fetch_url', 'get_current_time'],
  file: ['create_file', 'read_file', 'list_files', 'send_file'],
  memory: ['remember'],
  image: ['send_sticker', 'generate_image'],
  spreadsheet: ['create_table'],
};
const MAX_TOOLS_PER_TURN = Object.keys(TOOL_GROUPS).length + TOOLS.length; // 安全上限

// 按文本意图挑选工具（economy 模式用）：命中分组才挂，普通聊天返回空数组
function selectToolsOnDemand(text) {
  const t = String(text || '');
  const want = new Set();
  const add = (g) => (TOOL_GROUPS[g] || []).forEach((n) => want.add(n));
  if (/(搜索|搜一下|查一下|查查|搜|新闻|天气|比分|价格|最新|实时|今日|今天|现在几点|日期|网页|网址|链接|http|官网|百科|股市|汇率)/.test(t)) add('web');
  if (/(文件|保存|存一下|存个|清单|笔记|文档|写个文件|导出|下载)/.test(t)) add('file');
  if (/(表格|账单|excel|csv|名单|对比表|数据表|统计表)/.test(t)) add('spreadsheet');
  if (/(记住|记一下|记得|我的喜好|我的名字|我的生日|约定|帮我记)/.test(t)) add('memory');
  if (/(表情|颜文字|发个图|表情包|斗图)/.test(t)) add('image');
  if (isImageGenIntent(t) || /(重绘|重画|换风格|换画风|改成|变成|风格化|img2img)/.test(t)) add('image');
  if (want.size === 0) return [];                 // 普通聊天：不挂任何工具
  return TOOLS.filter((tool) => want.has(tool.function.name)).slice(0, MAX_TOOLS_PER_TURN);
}

// 按当前模式决定挂哪些工具（chat=无；economy=按需；enhanced/normal=全量 V11）
function toolsForMode(text) {
  if (AI_MODE === 'chat') return [];
  if (AI_MODE === 'economy') return selectToolsOnDemand(text);
  return TOOLS;                                    // enhanced / normal：保持 V11 完整体验
}

// 单独发一个表情包（工具调用）；target 从 sessionId 解析
async function sendStickerTo(sessionId, keyword, ctx) {
  const seg = resolveSticker(keyword);
  const kind = seg.type === 'image' ? '图片' : 'face' + seg.data.id;
  if (sessionId.startsWith('group_')) {
    await napcatCall('send_group_msg', { group_id: Number(sessionId.slice(6)), message: [seg] });
  } else if (sessionId.startsWith('private_')) {
    await napcatCall('send_private_msg', { user_id: Number(sessionId.slice(8)), message: [seg] });
  } else {
    return '发不出去：未知的会话。';
  }
  if (ctx) ctx.stickerSent = true;
  log('[表情] 已发送 ' + kind + (keyword ? ' kw=' + keyword : ''));
  return '表情包已发出。';
}

// V14-D：生图是否已交给 Agent 的 generate_image 工具。
// 为真时，老的正则快路径（handleImageGen）让位，避免同一句话被处理两次、发两张图。
function genByAgent() {
  if (!(CFG.image || {}).enabled) return false;
  if ((CFG.image || {}).agentFirst === false) return false;
  try {
    return agentEnabled() && typeof agent.hasTool === 'function' && agent.hasTool('generate_image');
  } catch (e) {
    return false;
  }
}

// 生图工具上下文：sessionId → { ev, imgSegs, ts }
// generate_image 工具需要拿到「当前这条消息的原始图片段」才能做图生图，
// 而 runTool 只有 sessionId，所以在这里按会话临时挂一份（10 分钟过期）。
const IMG_TOOL_CTX = new Map();
const IMG_TOOL_CTX_TTL = 10 * 60 * 1000;

function setImageToolCtx(sessionId, ev, imgSegs) {
  IMG_TOOL_CTX.set(sessionId, { ev, imgSegs: imgSegs || [], ts: Date.now() });
  // 顺带清理过期项，避免长期累积
  const now = Date.now();
  for (const k of IMG_TOOL_CTX.keys()) {
    const v = IMG_TOOL_CTX.get(k);
    if (!v || now - v.ts > IMG_TOOL_CTX_TTL) IMG_TOOL_CTX.delete(k);
  }
}

// 生图工具：AI 自己决定什么时候画（文生图 / 图生图），画完直接发到当前聊天
async function generateImageTool(sessionId, args, ctx) {
  const img = CFG.image || {};
  if (!img.enabled) {
    return '生图功能没开（image.enabled=false）。跟对方说你暂时画不了，别编造画好的图。';
  }
  const m = IMG_TOOL_CTX.get(sessionId) || {};
  const ev = m.ev || null;
  const imgSegs = m.imgSegs || [];

  let prompt = String((args && args.prompt) || '').trim();
  if (!prompt) return '没写画面描述，先想清楚要画什么再调用。';

  // 安全硬过滤：命中直接拒，不调用后端
  const unsafe = checkImagePromptSafety(prompt);
  if (unsafe) {
    log(`[生图安全] 工具拒绝 session=${sessionId} 规则=${unsafe.rule}`);
    return '这个内容不能画（安全规则 ' + unsafe.rule + '）。跟对方说换个正常的题，别解释具体规则。';
  }

  // 图生图 / 双图融合：
  // source 指本条（含跨消息记住的）图的第几张；融合时 source2 指第二张图。
  // imgSegs 已包含「先发图、再打字」时被记住的历史图（最多 3 张），所以融合两张图只需连发两张再打字说融合/换脸即可。
  let sourceSeg = null, sourceSeg2 = null, targetSeg = null, faceSeg = null;
  const imgSegsSafe = (imgSegs || []).slice();
  const src = String((args && args.source) || '').trim().toLowerCase();
  const src2 = String((args && args.source2) || '').trim().toLowerCase();
  const hasSrcArg = src && src !== '0' && /^\d+$/.test(src);
  const hasSrc2Arg = src2 && src2 !== '0' && /^\d+$/.test(src2);
  const faceSwap = isFaceSwapIntent(prompt) && imgSegsSafe.length >= 2;
  const faceSwapWf = String((CFG.image || {}).faceSwapWorkflow || '').trim();
  const fusion = isFusionIntent(prompt) && imgSegsSafe.length >= 2;
  const fusionWf = String((CFG.image || {}).fusionWorkflow || '').trim();

  if (faceSwap) {
    if (!faceSwapWf) {
      return '想换脸但还没配 faceSwapWorkflow（ai_config.json 的 image.faceSwapWorkflow 指向我目录里的 reactor_faceswap.json）。先让管理员配一下。';
    }
    const ti = hasSrcArg ? Math.max(0, Math.min(imgSegsSafe.length - 1, parseInt(src, 10) - 1)) : 0;
    const fi = hasSrc2Arg ? Math.max(0, Math.min(imgSegsSafe.length - 1, parseInt(src2, 10) - 1)) : 1;
    targetSeg = imgSegsSafe[ti] || imgSegsSafe[0] || null;   // 先发=目标（身体）
    faceSeg = imgSegsSafe[fi] || imgSegsSafe[1] || null;     // 后发=源脸（要换上的脸）
  } else if (fusion) {
    if (!fusionWf) {
      return '想做双图融合，但还没配 fusionWorkflow（在 ai_config.json 的 image.fusionWorkflow 指向我目录里的 z_image_turbo_2img_fusion.json）。先让管理员配一下，或者我这次就只用第一张图帮你改？';
    }
    const i1 = hasSrcArg ? Math.max(0, Math.min(imgSegsSafe.length - 1, parseInt(src, 10) - 1)) : 0;
    const i2 = hasSrc2Arg ? Math.max(0, Math.min(imgSegsSafe.length - 1, parseInt(src2, 10) - 1))
                          : (i1 === 0 ? 1 : 0);
    sourceSeg = imgSegsSafe[i1] || imgSegsSafe[0] || null;
    sourceSeg2 = imgSegsSafe[i2] || null;
    if (sourceSeg2 === sourceSeg) sourceSeg2 = imgSegsSafe.find((s) => s !== sourceSeg) || null;
  } else if (src && src !== '0') {
    if (imgSegsSafe.length) {
      const idx = hasSrcArg ? Math.max(0, Math.min(imgSegsSafe.length - 1, parseInt(src, 10) - 1)) : 0;
      sourceSeg = imgSegsSafe[idx] || null;
      if (!sourceSeg) return '对方这条消息里没有可用的图，只能文生图（别填 source 再试）。';
    } else {
      return '这条消息里没有图，没法做图生图。要么让对方发图，要么去掉 source 直接文生图。';
    }
  }

  const userId = String((ev && ev.user_id) || sessionId);
  const q = imgQueueEnter(userId, prompt, sourceSeg, sourceSeg2, targetSeg, faceSeg);
  if (q.status === 'cooldown') {
    return `生图冷却中，还要等 ${q.waitSec} 秒。跟对方说稍等一会儿再来，别空头承诺马上画。`;
  }
  if (q.status === 'duplicate') {
    return '你已经有张图在排队或在画了。跟对方说等这张画完再来，别重复排队。';
  }
  if (q.status === 'full') {
    return `画画队列满了（前面还排着 ${q.queueLen} 张）。跟对方说稍等一下再试。`;
  }

  const r = await q.promise;
  if (!r || !r.ok) {
    const err = String((r && r.error) || 'unknown');
    const why = err === 'timeout' ? '生图超时'
      : (err === 'source-image-fetch-failed' ? '拿不到对方发的那张原图'
        : (err.startsWith('upload') ? '原图传给绘图后端失败' : ('后端报错：' + err.slice(0, 60))));
    log('[生图] 工具失败 ' + why + ' err=' + err.slice(0, 60));
    return '没画出来：' + why + '。如实跟对方说，可以让他换个说法或重发一次图。';
  }

  const out = [{ type: 'image', data: { file: r.file } }];
  try {
    if (sessionId.startsWith('group_')) {
      const gid = Number(sessionId.slice(6));
      out.unshift({ type: 'at', data: { qq: String((ev && ev.user_id) || '') } });
      if (ev && ev.message_id != null) out.unshift({ type: 'reply', data: { id: String(ev.message_id) } });
      await napcatCall('send_group_msg', { group_id: gid, message: out });
    } else if (sessionId.startsWith('private_')) {
      const uid = Number(sessionId.slice(8));
      if (ev && ev.message_id != null) out.unshift({ type: 'reply', data: { id: String(ev.message_id) } });
      await napcatCall('send_private_msg', { user_id: uid, message: out });
    } else {
      return '图画好了，但不知道该发到哪个会话。';
    }
  } catch (e) {
    return '图画好了但没发出来（发送失败：' + String((e && e.message) || e).slice(0, 60) + '），跟对方说稍后再试。';
  }

  if (ctx) ctx.imageSent = true;
  // 让 AI 之后能看到自己刚画的那张图：用户常紧接着吐槽「你给我画成啥了」，
  // 不存下来 AI 就只能回「我没看到图」。
  if (sessionId.startsWith('group_') && r && r.file) {
    try {
      // atFront=true：刚画好的图放到历史最前，这样后续「再改成X」时 source="1" 指向这张最新结果
      storePendingGroupImages(Number(sessionId.slice(6)), Number((ev && ev.user_id) || 0),
        [{ type: 'image', data: { file: r.file } }], true);
    } catch (e) { /* 存不下就算了，不影响出图结果 */ }
  }
  log('[生图] 工具出图成功 ' + (sourceSeg2 ? '(双图融合)' : sourceSeg ? '(图生图)' : '(文生图)') + ' 提示=' + prompt.slice(0, 40));
  return '图已经画好发到聊天里了' + (sourceSeg ? '（基于对方发的那张图改的）' : '')
    + '。现在用一两句自然的话接一下就行，别再复述画面内容，也别再说"这就画"之类的话。';
}

async function runTool(name, args, sessionId, ctx) {
  try {
    if (name === 'web_search') return await webSearch(args.query);
    if (name === 'fetch_url') return await fetchUrl(args.url);
    if (name === 'get_current_time') return getCurrentTime();
    if (name === 'remember') return rememberNote(sessionId, args.content);
    if (name === 'send_sticker') return await sendStickerTo(sessionId, args.keyword, ctx);
    if (name === 'generate_image') return await generateImageTool(sessionId, args, ctx);
    if (name === 'create_file') return await toolCreateFile(sessionId, args);
    if (name === 'create_table') return await toolCreateTable(sessionId, args);
    if (name === 'read_file') return toolReadFile(args.name);
    if (name === 'list_files') return toolListFiles();
    if (name === 'send_file') return await sendFileToChat(sessionId, args.name);
    return '未知工具：' + name;
  } catch (e) {
    return '工具执行失败：' + e.message;
  }
}

// ================= 图片获取 =================
// NapCat 实测推送的 image segment 字段：
//   { summary, file, sub_type, url, file_size }   —— 没有 file_id，没有 path
//   file 是裸文件名（不是路径）；url 的 host 恒为 multimedia.nt.qq.com.cn
// 该 CDN 在部分网络下 DNS 解析不了，URL 下载会失败，
// 因此以「问 NapCat 要本地缓存路径」为第一优先。

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
};

function guessMime(u, fallback) {
  const s = String(u || '').split('?')[0].toLowerCase();
  for (const ext of Object.keys(MIME_BY_EXT)) {
    if (s.endsWith(ext)) return MIME_BY_EXT[ext];
  }
  return fallback || 'image/jpeg';
}

function isLocalPath(s) {
  return typeof s === 'string' && (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('/'));
}

// 本地文件读取白名单：只允许机器人自身目录与 NapCat/QQ 缓存目录，拒绝目录穿越与符号链接绕过
// 兼容旧版 QQ 收图缓存 Documents\Tencent Files\<QQ号>\nt_qq\nt_data\Pic：动态探测，不硬编码任何账号
let _allowedRoots = [path.resolve(__dirname)];
try {
  const tf = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Documents', 'Tencent Files') : null;
  if (tf && fs.existsSync(tf)) {
    _allowedRoots.push(path.join(tf, 'NapCat'));
    for (const name of fs.readdirSync(tf)) {
      if (!/^\d{5,}$/.test(name)) continue;               // 只认纯数字账号目录
      const pic = path.join(tf, name, 'nt_qq', 'nt_data', 'Pic');
      if (fs.existsSync(pic)) _allowedRoots.push(pic);
    }
  }
} catch (e) { /* 未装 QQ/NapCat 时忽略 */ }
const ALLOWED_FILE_ROOTS = _allowedRoots.map((p) => p.replace(/[\\/]+/g, '/').toLowerCase());

function isPathAllowed(p) {
  if (typeof p !== 'string' || !isLocalPath(p)) return false;
  let abs;
  try {
    abs = fs.realpathSync(p);            // 解析符号链接与 ..，得到规范绝对路径（遵循符号链接）
  } catch (e) {
    return false;                         // 无法解析规范路径（不存在 / 符号链接不可达）：保守拒绝
  }
  const norm = abs.replace(/[\\/]+/g, '/').toLowerCase();
  return ALLOWED_FILE_ROOTS.some((root) => norm === root || norm.startsWith(root + '/'));
}

function safeHost(u) {
  try { return new URL(u).hostname; } catch (e) { return '?'; }
}

function readLocalAsBase64(p) {
  if (!isPathAllowed(p)) {
    log('[图片] 本地路径越界，拒绝读取：' + (typeof p === 'string' ? p.replace(/^.*[\\/]/, '') : p));
    return null;
  }
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size === 0) return null;
    if (st.size > MAX_IMAGE_BYTES) {
      log('[图片] 本地文件超过上限，跳过：' + st.size + 'B');
      return null;
    }
    const buf = fs.readFileSync(p);
    return `data:${guessMime(p)};base64,${buf.toString('base64')}`;
  } catch (e) {
    return null;
  }
}

// 图片诊断日志（脱敏）：只打印类型/字段有无/大小/host，绝不打印 base64 或完整 URL
function imageDebug(seg, stage, extra) {
  if (!IMAGE_DEBUG) return;
  const d = (seg && seg.data) || {};
  const parts = [
    'stage=' + stage,
    'type=' + ((seg && seg.type) || '?'),
    'file=' + (d.file ? 'y' : 'n'),
    'url=' + (d.url ? 'y' : 'n'),
    'file_id=' + (d.file_id ? 'y' : 'n'),
    'size=' + (d.file_size || '?'),
    'host=' + (d.url ? safeHost(d.url) : '-'),
  ];
  if (extra) parts.push(extra);
  log('[IMAGE DEBUG] ' + parts.join(' '));
}

/**
 * 按可靠性优先级取图，返回 data URL 或 null（null 表示确实没拿到，不伪装成功）
 *   ① 调 NapCat get_image（返回本地缓存绝对路径）
 *   ② 段内自带的本地路径 / file:// 形式
 *   ③ 有 http(s) URL 才下载
 *   ④ 全失败 → 记 [IMAGE] 获取失败
 */
async function fetchImageAsBase64(seg) {
  const d = (seg && seg.data) || {};
  imageDebug(seg, 'start');

  // ① NapCat get_image（优先拿本地缓存路径；file / file_id 都试一遍）
  const fromApi = [];
  for (const key of ['file', 'file_id']) {
    const v = d[key];
    if (typeof v !== 'string' || !v) continue;
    try {
      const r = await napcatCall('get_image', { file: v });
      if (r && r.retcode === 0 && r.data) {
        if (typeof r.data.file === 'string') fromApi.push(r.data.file);
        if (typeof r.data.path === 'string') fromApi.push(r.data.path);
      }
    } catch (e) {
      log('[图片] get_image 异常(' + key + '): ' + e.message);
    }
  }
  imageDebug(seg, 'get_image', 'paths=' + fromApi.length);

  // ② 本地路径（段内给的 + get_image 给的）
  for (const c of [d.path, ...fromApi, d.file]) {
    if (typeof c !== 'string' || !c) continue;
    const p = /^file:\/\//i.test(c) ? decodeURIComponent(c.replace(/^file:\/\//i, '')) : c;
    if (!isLocalPath(p)) continue;
    const b64 = readLocalAsBase64(p);
    if (b64) {
      imageDebug(seg, 'local-ok', 'bytes=' + Math.round(b64.length * 3 / 4));
      return b64;
    }
  }

  // ③ 网络下载（兜底）：统一走 safeFetch（固定 IP + socket 复核 + 逐跳重校验 + 限额）
  const url = /^https?:/i.test(d.url || '') ? d.url : '';
  if (url) {
    const headers = {
      'User-Agent': UA,
      'Accept': 'image/avif,image/webp,image/apng,image/png,image/jpeg,image/*,*/*',
      'Referer': 'https://qq.com/',
    };
    let lastErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      let r = null;
      try {
        r = await safeFetch(url, {
          maxRedirects: MAX_REDIRECTS,
          maxBytes: MAX_IMAGE_BYTES + 1024,          // 实际接收字节（压缩形态）上限
          maxDecompressedBytes: MAX_IMAGE_BYTES + 1024,
          headers,
        });
      } catch (e) { r = { ok: false, kind: 'exception', error: e.message }; }
      if (r && r.ok) {
        const ab = r.body;
        if (ab && ab.length > 0 && ab.length <= MAX_IMAGE_BYTES) {
          const mime = (r.contentType || '').startsWith('image/') ? r.contentType.split(';')[0] : guessMime(url);
          imageDebug(seg, 'url-ok', 'bytes=' + ab.length + ' attempt=' + attempt);
          return `data:${mime};base64,${ab.toString('base64')}`;
        }
        lastErr = 'kind=' + r.kind + ' size=' + (ab ? ab.length : 0);
      } else {
        lastErr = 'kind=' + (r && r.kind) + ' err=' + String((r && (r.error || r.why)) || '').slice(0, 60);
      }
      imageDebug(seg, 'url-fail', lastErr + ' attempt=' + attempt);
      if (attempt < 2) await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
    }
  }

  // ④ 明确失败，不伪装成功
  log('[IMAGE] 获取失败 file=' + (d.file ? '有' : '无') +
      ' url=' + (url ? '有' : '无') +
      ' host=' + (url ? safeHost(url) : '-'));
  return null;
}

// ================= 记忆（跨重启持久化） =================
// ① sessions：每个会话的对话历史，重启后还能接着聊
// ② notes：模型主动记下的长期事实（谁是谁、喜好、约定等）
const sessions = new Map();
const notes = new Map();   // sessionId -> string[]

function ensureMemoryDir() {
  if (!CFG.memory.enable) return;
  try { fs.mkdirSync(MEMORY_DIR, { recursive: true }); } catch (e) {}
}

function loadMemory() {
  if (!CFG.memory.enable) return;
  ensureMemoryDir();
  try {
    const obj = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(obj)) {
        if (Array.isArray(obj[k]) && obj[k].length)
          sessions.set(k, obj[k].slice(-HISTORY_ROUNDS * 2));
      }
    }
    log('[记忆] 载入会话 ' + sessions.size + ' 个');
  } catch (e) {}
  try {
    const obj = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf-8'));
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(obj)) {
        if (Array.isArray(obj[k]) && obj[k].length)
          notes.set(k, obj[k].slice(-MAX_NOTES_PER_SESSION));
      }
    }
    log('[记忆] 载入长期记忆 ' + notes.size + ' 个会话');
  } catch (e) {}
}

function saveMemory() {
  if (!CFG.memory.enable) return;
  ensureMemoryDir();
  try {
    const obj = {};
    // Map 插入序即最近使用序（每次访问都会移到末尾），只留最近的 MAX_SESSIONS 个
    for (const [k, v] of [...sessions.entries()].slice(-MAX_SESSIONS)) obj[k] = v;
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj), 'utf-8');
  } catch (e) { log('[记忆] 保存会话失败: ' + e.message); }
  try {
    fs.writeFileSync(NOTES_FILE, JSON.stringify(Object.fromEntries(notes)), 'utf-8');
  } catch (e) {}
}

// 模型调用 remember 工具时写入长期记忆
// 安全整改：这里增加凭据过滤。tools/memory.js 的 memory_write 有 gateWrite 闸门，
// 但 runTool 的 'remember'（V13 老链）与模型直接 remember 都会走到本函数，
// 不过闸门 —— 凭据类内容（API Key/Token/手机号/证件号等）一旦写入 notes.json，
// 会被 buildSystemPrompt 注入提示词并随每次请求发给模型厂商，属于凭据外泄。
function rememberNote(sessionId, content) {
  const c = String(content || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!c) return '没记住：内容为空。';
  if (typeof memoryStore.looksSecret === 'function' && memoryStore.looksSecret(c)) {
    log('[记忆] 拒绝写入长期记忆：内容命中凭据/敏感信息特征（已丢弃，不落盘）');
    return '没记住：这条看起来包含密钥、密码、手机号或证件号等敏感信息，不能记。';
  }
  const arr = notes.get(sessionId) || [];
  if (arr.includes(c)) return '这条已经记过了。';
  arr.push(c);
  notes.set(sessionId, arr.slice(-MAX_NOTES_PER_SESSION));
  saveMemory();
  log('[记忆+] ' + c.slice(0, 60));
  return '记住了：' + c;
}

// 把该会话的长期记忆拼进系统提示词（有长度上限，避免越聊越长）
function buildSystemPrompt(sessionId) {
  let sys = loadPrompt();

  // 「性格根据群聊改变」：群会话按群号注入群身份/语气/风格覆盖
  const gMatch = /^group_(.+)$/.exec(String(sessionId || ''));
  if (gMatch) {
    const gid = gMatch[1];
    const base = CFG.personality || {};
    const ov = (base.groups && base.groups[gid]) || {};
    const name = ov.name || base.name || 'AI 助手';
    const grpName = groupNameCache.get(gid) || '';
    let pg = '\n\n【当前群聊身份与语气】\n';
    pg += `你正在 QQ 群「${grpName || gid}」(群号 ${gid}) 里聊天，请自然融入这个群的聊天氛围，语气跟着群友走（群友正经你就正经，群友爱玩梗你就跟着玩）。`;
    if (ov.style) pg += '\n该群的风格要求：' + ov.style;
    const humor = ov.humor != null ? ov.humor : base.humor;
    pg += '\n语气风格：' + (humor ? '轻松活泼、可以开玩笑、偶尔玩梗。' : '稳重克制。');
    const proactive = ov.proactive != null ? ov.proactive : base.proactive;
    if (proactive) pg += '\n态度：主动接话、积极互动，不必等被点名才说话。';
    pg += `\n本群中你的名字叫「${name}」。`;
    sys += pg;
  }

  if (CFG.memory.enable) {
    const ns = notes.get(sessionId) || [];
    if (ns.length) {
      let block = ns.map((x) => '- ' + x).join('\n');
      if (block.length > MEMORY_INJECT_CHARS) block = block.slice(-MEMORY_INJECT_CHARS);
      sys += '\n\n【你记得的事（长期记忆，来自之前的对话）】\n' + block;
    }
  }
  if (CFG.sticker.enable) {
    const ks = listStickerKeywords();
    sys +=
      '\n\n【发表情包】\n' +
      (ks.length ? '本地可用表情包关键词：' + ks.join('、') + '。\n' : '') +
      '想发图时，在回复末尾加一个标记 [[表情:关键词]]（没有合适的就写 [[表情]] 随机发一个）。' +
      '心情词也可以，比如 开心、无语、点赞、委屈、偷笑、加油。' +
      '随心发，群聊斗图不必收着；但严肃说明/长解释/写代码/道歉/安慰人时别发。';
  }

  // 运行时临时心情/状态（管理员 /ai mood 设置，仅内存、不落盘）
  if (RUNTIME_MOOD && RUNTIME_MOOD.trim()) {
    sys += '\n\n【当前临时状态/心情（管理员临时设定）】\n' + RUNTIME_MOOD.trim() + '\n（这是你此刻的状态，自然地体现在说话里，别直接念出来。）';
  }
  return sys;
}

// ================= 表情包 / 表情 =================
const STICKER_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

// 内置 QQ 小黄脸表情：心情词 → face id（客户端本地渲染，不依赖任何网络）
const FACE_MAP = {
  开心: 13, 高兴: 13, 笑: 13, 呲牙: 13,
  微笑: 14, 害羞: 6, 偷笑: 20, 坏笑: 20, 调皮: 12, 吐舌: 12,
  哭: 5, 流泪: 5, 大哭: 9, 难过: 15, 伤心: 15,
  得意: 4, 酷: 16, 无语: 27, 流汗: 27, 尴尬: 10, 疑问: 32, 问号: 32,
  白眼: 22, 生气: 11, 发怒: 11, 惊讶: 0, 震惊: 0, 困: 8, 睡: 8,
  抱抱: 78, 拥抱: 78, 点赞: 79, 赞: 79, 厉害: 79, 强: 79,
  鼓掌: 42, 亲亲: 52, 么么: 52, 爱心: 66, 喜欢: 66, 玫瑰: 63, 礼物: 77,
  咖啡: 60, 蛋糕: 68, 生日: 68, 便便: 74, 抠鼻: 41, 不屑: 41,
  委屈: 49, 快哭了: 50, 惊恐: 26, 害怕: 26, 加油: 30, 奋斗: 30,
  可爱: 13, 卖萌: 12, 撒娇: 52, 乖巧: 6, 摸摸头: 78, 求抱抱: 78,
  再见: 39, 拜拜: 39, 胜利: 82, 耶: 82, 握手: 81, 抱拳: 83, 谢谢: 83,
  西瓜: 56, 啤酒: 57, 干杯: 57, 月亮: 75, 太阳: 76, 猪头: 62, 菜刀: 55,
};
const FACE_IDS = Object.values(FACE_MAP);

function listStickers() {
  if (!CFG.sticker.enable) return [];
  try {
    return fs.readdirSync(STICKER_DIR)
      .filter((f) => STICKER_EXT.has(path.extname(f).toLowerCase()))
      .map((f) => ({ file: path.join(STICKER_DIR, f), kw: path.basename(f, path.extname(f)) }))
      .sort((a, b) => a.kw.localeCompare(b.kw, 'zh'));
  } catch (e) {
    return [];
  }
}

// 关键词清单（去掉文件名末尾的编号/下划线，如「开心_1.png」→「开心」）
function listStickerKeywords() {
  const ks = new Set();
  for (const s of listStickers()) {
    const k = s.kw.replace(/[_\-\s]*\d+$/, '').trim();
    if (k) ks.add(k);
  }
  return [...ks];
}

// 把关键词解析成一个消息段：优先本地表情包图片，没有则退回内置表情
function resolveSticker(kw) {
  const k = String(kw || '').trim();
  const list = listStickers();
  if (list.length) {
    let hit = null;
    if (k) {
      hit =
        list.find((s) => s.kw === k) ||
        list.find((s) => s.kw.replace(/[_\-\s]*\d+$/, '').trim() === k) ||
        list.find((s) => s.kw.includes(k));
    }
    if (!hit) hit = list[Math.floor(Math.random() * list.length)];
    const dataUrl = readLocalAsBase64(hit.file);
    if (dataUrl) {
      const i = dataUrl.indexOf(',');
      if (i > 0) return { type: 'image', data: { file: 'base64://' + dataUrl.slice(i + 1) } };
    }
  }
  let id = k && FACE_MAP[k] != null ? FACE_MAP[k] : null;
  if (id == null) id = FACE_IDS[Math.floor(Math.random() * FACE_IDS.length)];
  return { type: 'face', data: { id: String(id) } };
}

// 解析回复里的表情标记，返回 { text: 去掉标记的纯文本, extras: 附加消息段 }
const STICKER_MARKER_RE =
  /[\[【]{1,2}\s*(?:表情|emoji|sticker|face|bq)\s*[:：]?\s*([^\[\]【】]{0,24}?)\s*[\]】]{1,2}/gi;

function parseStickerMarkers(s) {
  const extras = [];
  const text = String(s || '')
    .replace(STICKER_MARKER_RE, (m, kw) => {
      if (extras.length < MAX_STICKER_PER_MSG) extras.push(resolveSticker(kw));
      return '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, extras };
}

// ================= 文件工作区（表格 / txt 等） =================
// 机器人只能在这个独立目录里读写，防止碰到系统文件；文件名只取最后一段，天然防目录穿越。

const TEXT_EXT = new Set([
  '.txt', '.md', '.csv', '.tsv', '.json', '.html', '.htm', '.xml', '.log',
  '.ini', '.yml', '.yaml', '.sql', '.js', '.ts', '.py', '.bat', '.sh',
]);
const BINARY_EXT = new Set(['.xlsx', '.xls', '.zip', '.rar', '.7z', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.pdf', '.mp3', '.mp4']);

// 沙箱文件名：剥掉目录、非法字符、前后多余的点；无扩展名默认 .txt
// Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，带不带扩展名都算设备）：
//   直接拿它们建文件会创建设备句柄而不是普通文件，属于路径绕过的翻版，一律加前缀改写
const WIN_RESERVED_STEM = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
function safeFileName(name) {
  let n = String(name == null ? '' : name).trim().replace(/[\\/]+/g, '/');
  n = n.split('/').pop() || '';
  n = n.replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '').trim();
  if (!n) n = '未命名';
  if (n.length > 80) n = n.slice(0, 80);
  if (!path.extname(n)) n += '.txt';
  if (WIN_RESERVED_STEM.test(path.basename(n, path.extname(n)))) n = '_' + n;
  return n;
}

// 解析成工作区内的绝对路径；任何越界都返回 null
function workspacePath(name) {
  const dir = path.resolve(WORKSPACE_DIR);
  const p = path.resolve(dir, safeFileName(name));
  if (p !== dir && !p.startsWith(dir + path.sep)) return null;
  return p;
}

// 通用目录归属判断：real 是否真实位于 base 目录之内。
// 基于 path.relative，杜绝 startsWith 字符串前缀误判（如 workspace_backup 被误判为 workspace 子项）；
// Windows 大小写不敏感先归一；跨盘符时 path.relative 返回绝对路径由 isAbsolute 拦截。
function isUnderDir(real, base) {
  const rel = path.relative(String(base).toLowerCase(), String(real).toLowerCase());
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function fmtBytes(n) {
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
  return (n / 1024 / 1024).toFixed(2) + 'MB';
}

function writeWorkspaceFile(name, buf) {
  const p = workspacePath(name);
  if (!p) return { ok: false, msg: '文件名不合法。' };
  if (buf.length > MAX_FILE_BYTES) return { ok: false, msg: '内容太大（上限 ' + fmtBytes(MAX_FILE_BYTES) + '）。' };
  try {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    // 安全整改：先写临时文件再 rename，写入中途失败不会留下半个文件、更不会破坏原文件
    const tmp = p + '.tmp-' + process.pid + '-' + Date.now().toString(36);
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, p);
    return { ok: true, name: path.basename(p), size: buf.length };
  } catch (e) {
    return { ok: false, msg: '写入失败：' + e.message };
  }
}

function listWorkspace() {
  try {
    return fs.readdirSync(WORKSPACE_DIR)
      .map((f) => {
        try {
          const st = fs.statSync(path.join(WORKSPACE_DIR, f));
          return st.isFile() ? { name: f, size: st.size, mtime: st.mtime.toLocaleDateString('zh-CN') } : null;
        } catch (e) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  } catch (e) {
    return [];
  }
}

// —— 表格：CSV（带 BOM，Excel 打开中文不乱码）——
function toCSV(headers, rows) {
  const esc = (v) => {
    let s = v == null ? '' : String(v);
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [];
  if (headers.length) lines.push(headers.map(esc).join(','));
  for (const r of rows) lines.push(r.map(esc).join(','));
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}

// —— 表格：真正的 .xlsx（零依赖手写 OOXML + ZIP，Excel/WPS 可直接打开）——
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// 用「不压缩(stored)」方式打包 ZIP，避免额外依赖
function zipStore(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf-8');
    const data = f.data;
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);   // UTF-8 文件名
    lh.writeUInt16LE(0, 8);        // method 0 = stored
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += lh.length + nameBuf.length + data.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, cdBuf, eocd]);
}

function escXml(s) {
  return String(s)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function colLetter(i) { // 1 → A, 27 → AA
  let s = '';
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

function buildXlsx(headers, rows) {
  const all = [];
  if (headers.length) all.push(headers);
  for (const r of rows) all.push(r);

  const cell = (v, ref) => {
    if (v == null || v === '') return '';
    if (typeof v === 'number' && isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escXml(v)}</t></is></c>`;
  };

  let sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetData>';
  all.forEach((row, ri) => {
    sheet += `<row r="${ri + 1}">`;
    row.forEach((v, ci) => { sheet += cell(v, colLetter(ci + 1) + (ri + 1)); });
    sheet += '</row>';
  });
  sheet += '</sheetData></worksheet>';

  const CT =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '</Types>';

  const RELS =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const WB =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>';

  const WB_RELS =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '</Relationships>';

  return zipStore([
    { name: '[Content_Types].xml', data: Buffer.from(CT, 'utf-8') },
    { name: '_rels/.rels', data: Buffer.from(RELS, 'utf-8') },
    { name: 'xl/workbook.xml', data: Buffer.from(WB, 'utf-8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(WB_RELS, 'utf-8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet, 'utf-8') },
  ]);
}

// 把模型给的表数据统一成 {headers, rows}（兼容对象数组 / 数组套数组）
function normalizeTable(args) {
  let headers = Array.isArray(args.headers) ? args.headers.map((x) => String(x == null ? '' : x)) : [];
  const raw = Array.isArray(args.rows) ? args.rows : (Array.isArray(args.data) ? args.data : []);
  let rows;

  if (raw.length && raw[0] && typeof raw[0] === 'object' && !Array.isArray(raw[0])) {
    if (!headers.length) headers = Object.keys(raw[0]);
    rows = raw.map((o) => headers.map((h) => (o[h] == null ? '' : o[h])));
  } else {
    rows = raw.map((r) => (Array.isArray(r) ? r.slice() : [r]));
  }

  const width = Math.max(headers.length, ...rows.map((r) => r.length), 0);
  while (headers.length < width) headers.push('列' + (headers.length + 1));
  rows = rows.map((r) => { const a = r.slice(); while (a.length < headers.length) a.push(''); return a; });

  if (!headers.length && !rows.length) return null;
  if (rows.length > MAX_TABLE_ROWS) rows = rows.slice(0, MAX_TABLE_ROWS);
  return { headers, rows };
}

// 把工作区里的文件发到当前聊天（NapCat 上传接口）
async function sendFileToChat(sessionId, name) {
  const p = workspacePath(name);
  if (!p || !fs.existsSync(p)) return '发送失败：找不到文件 ' + name;
  const display = path.basename(p);
  try {
    let r = null;
    if (sessionId.startsWith('group_')) {
      r = await napcatCall('upload_group_file', {
        group_id: Number(sessionId.slice(6)), file: p, name: display, folder: '',
      });
    } else if (sessionId.startsWith('private_')) {
      r = await napcatCall('upload_private_file', {
        user_id: Number(sessionId.slice(8)), file: p, name: display,
      });
    } else {
      return '文件已存在工作区里（当前会话不支持发送）。';
    }
    if (r && (r.status === 'ok' || r.retcode === 0)) {
      log('[文件] 已发送 ' + display);
      return '已发到聊天里了。';
    }
    return '发送失败：' + String(JSON.stringify(r)).slice(0, 120);
  } catch (e) {
    return '发送失败：' + e.message;
  }
}

async function toolCreateFile(sessionId, args) {
  const w = writeWorkspaceFile(args.name, Buffer.from(String(args.content == null ? '' : args.content), 'utf-8'));
  if (!w.ok) return '创建失败：' + (w.msg || '未知错误');
  log('[文件] 新建 ' + w.name + ' (' + fmtBytes(w.size) + ')');
  let msg = '已创建 ' + w.name + '（' + fmtBytes(w.size) + '）';
  if (args.send !== false) msg += '，' + (await sendFileToChat(sessionId, w.name));
  return msg;
}

async function toolCreateTable(sessionId, args) {
  const t = normalizeTable(args);
  if (!t) return '表格数据是空的：请提供 headers 和 rows。';

  const fmt = String(args.format || '').toLowerCase() === 'csv' ? 'csv' : 'xlsx';
  let name = String(args.name || '表格');
  const ext = path.extname(name).toLowerCase();
  if (ext !== '.csv' && ext !== '.xlsx') name = name.replace(/\.[^.]*$/, '') + '.' + fmt;

  let buf;
  try {
    buf = fmt === 'csv' ? Buffer.from(toCSV(t.headers, t.rows), 'utf-8') : buildXlsx(t.headers, t.rows);
  } catch (e) {
    return '生成表格失败：' + e.message;
  }

  const w = writeWorkspaceFile(name, buf);
  if (!w.ok) return '生成失败：' + (w.msg || '未知错误');
  log(`[文件] 生成表格 ${w.name} (${fmt}, ${t.headers.length}列 × ${t.rows.length}行, ${fmtBytes(w.size)})`);

  let msg = `已生成 ${w.name}（${t.headers.length} 列 × ${t.rows.length} 行，${fmtBytes(w.size)}）`;
  if (args.send !== false) msg += '，' + (await sendFileToChat(sessionId, w.name));
  return msg;
}

function toolReadFile(name) {
  const p = workspacePath(name);
  if (!p || !fs.existsSync(p)) return '找不到文件：' + name;
  const st = fs.statSync(p);
  if (BINARY_EXT.has(path.extname(p).toLowerCase())) return '这是二进制文件，读不出文字内容。';
  if (st.size > MAX_FILE_BYTES) return '文件太大，不读了（' + fmtBytes(st.size) + '）。';
  try {
    let text = fs.readFileSync(p, 'utf-8');
    if (text.length > MAX_READ_CHARS) text = text.slice(0, MAX_READ_CHARS) + '\n…（已截断）';
    return '『' + path.basename(p) + '』的内容：\n' + text;
  } catch (e) {
    return '读取失败：' + e.message;
  }
}

function toolListFiles() {
  const list = listWorkspace();
  if (!list.length) return '工作区现在是空的。';
  return '工作区里的文件：\n' + list.map((f) => '- ' + f.name + '（' + fmtBytes(f.size) + '，' + f.mtime + '）').join('\n');
}

// ================= DeepSeek（含工具循环） =================

// 单次请求（带超时）；不做重试，重试交给 callAPI
async function callAPIOnce(messages, allowTools, model, opts) {
  opts = opts || {};
  // 【看图分流】消息里带图片 → 走 vision 后端（DeepSeek 官方不支持图片输入）
  const useVision = !!(CFG.vision && CFG.vision.enabled !== false && messagesHaveImage(messages));
  const mdl = useVision
    ? (CFG.vision.model || MULTIMODAL_MODEL || (model || MODEL))
    : (model || MODEL);
  const body = {
    model: mdl,
    messages,
    temperature: opts.temperature != null ? opts.temperature : 1.1,
    max_tokens: opts.maxTokens || 4000,
    stream: false,
  };
  // effort 仅 DeepSeek 系列支持；GPT 等中继对未知字段可能 400，故非 deepseek 不发送
  if (String(mdl).toLowerCase().includes('deepseek')) body.effort = opts.effort || EFFORT;
  if (CFG.web.enable && allowTools) {
    // 工具按需加载：opts.tools 显式给出时按给定集合（可能为空=不挂任何工具定义），否则回落全部
    if (opts.tools !== undefined) {
      if (opts.tools.length) { body.tools = opts.tools; body.tool_choice = 'auto'; }
    } else {
      body.tools = TOOLS; body.tool_choice = 'auto';
    }
  }

  const timeoutMs = useVision
    ? (Number(CFG.vision.timeoutMs) || Number(CFG.api.timeoutMs) || 30000)
    : (Number(CFG.api.timeoutMs) || 30000);
  const t = withTimeout(timeoutMs);
  try {
    const r = await fetch(useVision ? (CFG.vision.baseUrl || CFG.api.baseUrl || API_URL) : (CFG.api.baseUrl || API_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (useVision ? (visionApiKey() || API_KEY) : API_KEY) },
      body: JSON.stringify(body),
      signal: t.signal,
    });
    if (!r.ok) {
      const txt = (await r.text()).slice(0, 200);
      const err = new Error('HTTP ' + r.status + ' ' + txt);
      err.status = r.status;
      err.retryable = r.status >= 500;   // 只有 5xx 重试；4xx（含 401/余额不足）不重试
      throw err;
    }
    return await r.json();
  } catch (e) {
    // 网络层错误（超时/连不上）可重试；HTTP 错误看上一步的标记
    if (e.retryable === undefined) e.retryable = true;
    throw e;
  } finally {
    t.done();
  }
}

// 带重试的调用 + 用量记账
async function callAPI(messages, allowTools, opts) {
  opts = opts || {};
  const model = opts.model || CFG.api.model || MODEL;
  const groupId = opts.groupId;
  const maxRetry = Math.max(0, Number(CFG.api.maxRetries) || 0);
  let lastErr;
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    try {
      const j = await callAPIOnce(messages, allowTools, model, opts);
      recordUsage(j && j.usage, groupId, opts.kind, opts.chatId, opts.model || model, opts.extra);
      return j;
    } catch (e) {
      lastErr = e;
      stats.errors++;
      if (!e.retryable) break;                       // 明确不可重试 → 立刻放弃
      if (attempt >= maxRetry) break;
      const wait = 600 * (attempt + 1);
      log(`[重试] 第 ${attempt + 1} 次失败(${e.message.slice(0, 60)})，${wait}ms 后重试`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  // 跨模型兜底：主选模型重试仍失败、且配置了与主选不同的 fallback 时，用 fallback 再试一次。
  // 看图请求不走这里（fallback 是文本模型，发给看图后端会报不支持）。
  const fb = (CFG.model && CFG.model.fallback) || null;
  if (lastErr && fb && fb !== model && !messagesHaveImage(messages)) {
    try {
      log(`[自动选模型] 主选 ${model} 失败，切换兜底模型 ${fb}`);
      const j = await callAPIOnce(messages, allowTools, fb, opts);
      recordUsage(j && j.usage, groupId, opts.kind, opts.chatId, fb, opts.extra);
      return j;
    } catch (e2) {
      lastErr = e2;
      stats.errors++;
    }
  }
  saveStats();
  throw lastErr;
}

// 单次纯文本生成（主动聊天/戳一戳用）：复用既有中继调用，不挂工具
async function genText(prompt, opts) {
  opts = opts || {};
  const messages = [
    { role: 'system', content: opts.system || '你是 QQ 群里爱说话的成员，自然简短。' },
    { role: 'user', content: prompt },
  ];
  const j = await callAPIOnce(messages, false, opts.model || CFG.api.model, {
    maxTokens: opts.maxTokens || 200,
    temperature: opts.temperature != null ? opts.temperature : 0.9,
    kind: 'proactive',
  });
  const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  return (c || '').trim();
}

async function genImageAck(prompt, isImg2Img) {
  try {
    const task = isImg2Img ? '改图/重绘' : '画图';
    const out = await genText(
      `用户让我${task}，主题是：${String(prompt).slice(0, 200)}。请用一句自然、口语化、带情绪的回复接住（10-25 字），别解释技术细节，别暴露流程。`,
      { system: '你是 QQ 群成员，简短自然，会用梗和表情包语气。', maxTokens: 80, temperature: 0.9 }
    );
    return out || (isImg2Img ? '收到，给你改一下～' : '好嘞，给你画一个～');
  } catch (e) {
    return isImg2Img ? '收到，给你改一下～' : '好嘞，给你画一个～';
  }
}

async function askDeepSeek(sessionId, contentParts, ev, o) {
  o = o || {};
  const hist = sessions.get(sessionId) || [];
  const groupId = ev && ev.message_type === 'group' ? ev.group_id : null;
  const model = o.model || (CFG.api.model || MODEL);          // v11：分级后的回答模型
  // v12：工具按需加载（chat 无 / economy 按需 / enhanced+normal 全量）；普通聊天不挂任何工具
  const toolSet = o.allowTools !== false ? toolsForMode(o.text) : [];
  const chatId = o.chatId;
  const messages = [
    { role: 'system', content: buildSystemPrompt(sessionId) },
    ...hist,
    { role: 'user', content: contentParts },
  ];

  let reply = '';
  const ctx = { stickerSent: false, imageSent: false, preSent: '' };
  // 生图工具需要本条消息的原始图片段（图生图要用），按会话挂一份
  if (ev) setImageToolCtx(sessionId, ev, o.imgSegs || []);
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    // 最后一轮不给工具，强制它把话说出来（否则思考会把 token 吃光，回复变空）
    const isLast = round >= MAX_TOOL_ROUNDS;
    const obj = await callAPI(messages, !isLast && toolSet.length > 0, { groupId, model, chatId, tools: toolSet, kind: o.kind, extra: o.extra });
    const msg = obj.choices?.[0]?.message || {};

    const calls = msg.tool_calls || [];
    if (calls.length && !isLast) {
      // 保留思考内容（DeepSeek 思考模型多轮对话需要回传）
      const keep = { role: 'assistant', content: msg.content || '', tool_calls: calls };
      if (msg.reasoning_content) keep.reasoning_content = msg.reasoning_content;
      messages.push(keep);

      // —— 生图前先把这句接应话发出去（用户要求：先回答，再生图）——
      // generate_image 会阻塞几十秒，不先发的话对方会以为没反应，图也变成「话在图后面」。
      if (!ctx.imageSent && calls.some((c) => c.function?.name === 'generate_image')) {
        const pre = cleanReply(String(msg.content || ''))
          .replace(/\[\[表情[^\]]*\]\]/g, '').trim();
        if (pre) {
          try {
            await sendSimpleReply(ev, ev && ev.message_type === 'group', ev && ev.user_id, pre);
            ctx.preSent = pre;
            log('[生图] 先发出接应话：' + pre.slice(0, 40));
          } catch (e) { /* 发不出去不影响画图 */ }
        }
      }

      let used = 0;
      for (const tc of calls) {
        // 模型一轮可能并行发起好几个搜索，限制数量免得把 token 吃光
        if (used >= MAX_TOOLS_PER_ROUND) {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: '（本轮工具次数已用完，请直接用已有信息回答）',
          });
          continue;
        }
        used++;
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch (e) {}
        const fn = tc.function?.name;
        log(`[联网 ${fn}] ${JSON.stringify(args).slice(0, 100)}`);
        const result = await runTool(fn, args, sessionId, ctx);
        stats.toolCalls++; saveStats();
        log(`[联网结果] ${String(result).slice(0, 120)}`);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result) });
      }
      continue;
    }

    reply = (msg.content || '').trim();
    break;
  }

  reply = cleanReply(reply);

  // 生图工具已经把接应话发过了，最终回复若一字不差就不重复发
  if (ctx.preSent && reply === ctx.preSent) reply = '';

  // 兜底：还是没内容，再要一次（明确不让它再搜、且禁止吐出工具语法）
  // 图已发出时不兜底——图都给了，再硬挤一句反而像自言自语
  if (!reply && !ctx.imageSent) {
    log('[空回复] 再要一次');
    messages.push({
      role: 'user',
      content: '直接用纯文本简短回一句，不要输出任何函数调用、代码或思考过程。',
    });
    try {
      const obj2 = await callAPI(messages, false, { groupId, model, chatId, tools: [] });
      reply = cleanReply(obj2.choices?.[0]?.message?.content || '');
    } catch (e) {
      log('[错误] 兜底调用失败: ' + e.message);
    }
  }

  // 先摘出表情标记（得到纯文本 + 表情段），再做安全过滤和截断，
  // 避免长回复被截断时把 [[表情:xx]] 标记拦腰切断。
  const parsed = parseStickerMarkers(reply);
  // 本轮已经用 send_sticker 工具发过一个了，就不再附标记里的，免得一次发两个
  const extras = ctx.stickerSent ? [] : parsed.extras;
  let outText = sanitizeOutput(parsed.text);
  outText = truncateNicely(outText, MAX_REPLY_CHARS);

  const textOnly = contentParts.filter((p) => p.type === 'text').map((p) => p.text).join(' ');
  const next = [...hist, { role: 'user', content: textOnly }, { role: 'assistant', content: outText || '(发了个表情)' }];
  // 移到末尾（LRU：越近用到的越靠后），再落盘，重启不丢
  sessions.delete(sessionId);
  sessions.set(sessionId, next.slice(-HISTORY_ROUNDS * 2));
  saveMemory();
  return { text: outText, extras, stickerSent: ctx.stickerSent };
}

// ================= 复杂度分级 / 模型分级（v11 第二阶段新增）=================
// 只做轻量启发式判断，失败一律回落，不影响主流程
function classifyComplexity(text, imgSegs) {
  const t = String(text || '');
  const hard = /代码|报错|debug|算法|推导|证明|原理|分析|对比|方案|架构|重构|实现|计算|数学|论文|长文|总结|详细|为什么|怎么实现|帮我写|帮我做/.test(t);
  if ((imgSegs && imgSegs.length) || t.length >= 120 || hard) return 'complex';
  if (t.length <= 12 && !hard) return 'short';
  return 'normal';
}

// 选回答模型：short→fast / normal→normal / complex→reasoning；失败回落 normal
// 【识图修复】带图片时一律用支持多模态的模型（deepseek-flash / V4.1-Flash）。
// 之前「有图=complex→deepseek-v4-pro」会把图发给不支持图片输入的推理模型，
// 导致图明明下载成功、AI 却说“看不到图”。
function pickModel(text, imgSegs) {
  try {
    // ① 有图 → 强制多模态模型（优先级最高，任何模式都生效）
    if (imgSegs && imgSegs.length) {
      return (CFG.vision && CFG.vision.enabled !== false && CFG.vision.model) || (CFG.model && CFG.model.multimodal) || MULTIMODAL_MODEL || MODEL;
    }
    if (!CFG.model || CFG.model.autoSelect === false || CFG.model.routing === false) {
      return (CFG.model && CFG.model.normal) || CFG.api.model || MODEL;
    }
    const c = classifyComplexity(text, imgSegs);
    if (c === 'complex') return CFG.model.reasoning || CFG.api.reasoningModel || MODEL;
    if (c === 'short') return CFG.model.fast || MODEL;
    return CFG.model.normal || CFG.api.model || MODEL;
  } catch (e) {
    if (imgSegs && imgSegs.length) return (CFG.model && CFG.model.multimodal) || MULTIMODAL_MODEL || MODEL;
    return (CFG.model && CFG.model.normal) || CFG.api.model || MODEL;  // 判断失败 → normal
  }
}

// ================= AI Judge（v11 第二阶段新增）=================
// 只在「本地规则判定为候选（提到名字 / 疑似继续话题）」时调用；
// @ / 回复机器人 属于确定性命中，不经过 Judge。
const JUDGE_SYSTEM =
  '你是 QQ 群聊的「是否回复」判定器。判断机器人（群昵称可能是 deepseek/小鲸鱼/鲸鱼）是否应该回复当前这条消息。\n' +
  '关键点：消息里出现「DeepSeek/deepseek/小鲸鱼/鲸鱼」时，可能是【在对机器人说话】，也可能只是【在讨论 AI 产品或模型】。只有前者才回。\n' +
  '应该回复的情形：@机器人；直接回复机器人；明确对机器人提问或求助（如“deepseek 你觉得呢”“deepseek 在吗”“帮我看看”）。\n' +
  '不应该回复的情形：只是提到 DeepSeek 这个名词/产品（如“你们最近有没有用 DeepSeek？”“DeepSeek 最近是不是又更新了”“我觉得 DeepSeek 写代码挺强”）；普通群友闲聊、两人对话；无法确定。\n' +
  '宁可漏回，也不要误回。不确定时一律不回。\n' +
  '只输出下面三者之一，不要任何多余内容：\n' +
  'YES\n' +
  'NO\n' +
  '或者一行 JSON：{"reply":true} 或 {"reply":false}';

function parseJudgeJSON(s) {
  const t = String(s || '');
  // 1) 优先 JSON：兼容 {"reply":bool} 与 {"should_reply":bool}（以及带 reason/confidence 的）
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      const o = JSON.parse(t.slice(a, b + 1));
      if (o && typeof o === 'object') {
        if (typeof o.reply === 'boolean') return { should_reply: o.reply, confidence: o.confidence != null ? Number(o.confidence) : 0.7 };
        if (typeof o.should_reply === 'boolean') return { should_reply: o.should_reply, confidence: o.confidence != null ? Number(o.confidence) : 0.7 };
      }
    } catch (e) {}
  }
  // 2) YES / NO 直读（大小写不敏感，容忍前后噪声；NO 优先，符合「宁可漏回」）
  const up = t.toUpperCase();
  if (/\bNO\b/.test(up)) return { should_reply: false, confidence: 0.7 };
  if (/\bYES\b/.test(up)) return { should_reply: true, confidence: 0.7 };
  // 3) 兜底：从损坏文本里抠 should_reply
  const m = t.match(/should_reply[^a-zA-Z0-9]{0,10}(true|false)/i);
  if (m) {
    const c = t.match(/confidence[^0-9]{0,6}([0-9.]+)/i);
    return { should_reply: /true/i.test(m[1]), confidence: c ? Number(c[1]) : 0.7 };
  }
  return null;
}

// 返回 { shouldReply, reason, confidence }；任何异常一律 → 不回复
async function judgeReply(ev, text, chatId) {
  if (!judgeEnabled()) return null;
  const groupId = ev.group_id;
  try {
    const arr = getGroupBuffer(groupId);
    const n = Math.max(1, Number(CFG.judge.maxContext) || 5);
    const recent = arr.slice(-n).map((it) => {
      const who = it.isBot ? '我(AI)' : (it.name || it.uid);
      return `${who}: ${String(it.text || '').slice(0, 80)}`;
    });
    const grpName = groupNameCache.get(String(groupId)) || '';
    const payload =
      `群名：${grpName || groupId}\n` +
      (recent.length ? `最近消息：\n${recent.join('\n')}\n` : '') +
      `当前消息（来自 ${senderName(ev) || ev.user_id}）：${String(text || '').slice(0, 200)}\n` +
      `请只输出 JSON。`;
    const messages = [
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: payload },
    ];
    const obj = await callAPI(messages, false, {
      model: CFG.judge.model || MODEL,
      kind: 'judge',
      temperature: 0,
      maxTokens: Number(CFG.judge.maxTokens) || 512,
      groupId,
      chatId,
    });
    const msg = (obj.choices && obj.choices[0] && obj.choices[0].message) || {};
    // flash 是思考型模型：优先取 content，content 空时用 reasoning_content 兜底
    let parsed = parseJudgeJSON(msg.content || '');
    if (!parsed) parsed = parseJudgeJSON(msg.reasoning_content || '');
    if (!parsed) {
      log('[Judge] JSON 解析失败 → NO_REPLY | raw=' + redact(String(msg.content || '').slice(0, 120)) +
          ' | reasoning=' + redact(String(msg.reasoning_content || '').slice(0, 120)));
      return { shouldReply: false, reason: 'judge-parse-fail', confidence: 0 };
    }
    const thRaw = Number(CFG.judge.confidenceThreshold);
    const thr = isNaN(thRaw) ? 0.6 : thRaw;
    const conf = Number(parsed.confidence);
    const confOK = isNaN(conf) ? true : conf >= thr;
    const ok = parsed.should_reply === true && confOK;
    log(`[Judge] ${ok ? 'REPLY' : 'NO_REPLY'} conf=${isNaN(conf) ? '?' : conf} reason=${String(parsed.reason || '').slice(0, 50)}`);
    return { shouldReply: ok, reason: parsed.reason, confidence: conf };
  } catch (e) {
    log('[Judge] 调用失败 → NO_REPLY: ' + e.message);
    return { shouldReply: false, reason: 'judge-error', confidence: 0 };
  }
}

// ================= 消息处理 =================
function segments(msg) {
  if (typeof msg === 'string') return [{ type: 'text', data: { text: msg } }];
  return Array.isArray(msg) ? msg : [];
}

function extractText(msg) {
  let out = '';
  for (const seg of segments(msg)) {
    if (seg?.type === 'text') out += seg.data?.text || '';
  }
  return out.trim();
}

// V14-C.2 修复 A：QQ 原生分享卡片（json/xml 段）提取统一走 share_card 模块，
//            只取标题/摘要/URL，长度受限，URL 仍要过 isSafeUrl()。
function extractShareCard(msgSegs) {
  return shareCard.extractShareCard(msgSegs, { isSafeUrl: isSafeUrl, sanitizeUrl: sanitizeUrlForUse });
}

// V14-C.2 修复 C：日志脱敏（QQ 号 / 群号只保留首尾，中间打码）
function maskId(id) {
  const s = String(id == null ? '' : id);
  if (!s) return '(未知)';
  if (s.length <= 4) return s.slice(0, 1) + '***';
  return s.slice(0, 2) + '***' + s.slice(-2);
}

// 统一格式的「这条消息没被处理」日志（不记录消息正文、不记录完整 QQ/群号）
function logDrop(scopeLabel, stage, reason, segTypes) {
  log('[丢弃] 会话=' + scopeLabel + (segTypes ? (' 段=[' + segTypes + ']') : '')
    + ' 阶段=' + stage + ' 原因=' + reason);
}

// OneBot 返回校验：status 与 retcode 都可能是失败信号，只看一个会漏判
function onebotOK(r) {
  if (!r || typeof r !== 'object') return false;
  if (r.status != null && String(r.status) !== 'ok') return false;
  if (r.retcode != null && Number(r.retcode) !== 0) return false;
  return true;
}

function isAtMe(msg, selfId) {
  for (const seg of segments(msg)) {
    if (seg?.type === 'at' && String(seg.data?.qq) === String(selfId)) return true;
  }
  return false;
}

function stripAt(msg) {
  return segments(msg).filter((s) => s?.type !== 'at');
}

// ================= 群上下文 / 身份 / 预筛（v10 新增）=================
// 设计：本地缓冲【全部】群消息（便宜），但发送给 API 前必须筛选（省 token）。

// 群消息环形缓冲：groupId -> [{ id, uid, name, text, time, atMe, replyTo }]
const groupBuffers = new Map();
// 群名缓存：groupId -> name（事件里通常自带，缺了才查接口）
const groupNameCache = new Map();
// 每个群机器人最后一次回复的时间（用于「继续话题」判定）
const lastBotReplyAt = new Map();

function pushGroupBuffer(groupId, item) {
  const key = String(groupId);
  let arr = groupBuffers.get(key);
  if (!arr) { arr = []; groupBuffers.set(key, arr); }
  arr.push(item);
  const cap = Math.max(5, Number(CFG.group.ringSize) || 30);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

function getGroupBuffer(groupId) {
  return groupBuffers.get(String(groupId)) || [];
}

// —— 群聊上下文自动摘要（v11）：只压缩「较旧」内容，保留最近若干条 ——
const groupSummaries = new Map();   // groupId -> 摘要文本
const groupMsgTick = new Map();     // groupId -> 累计消息计数

function maybeSummarize(groupId) {
  if (!CFG.summary || !CFG.summary.enabled) return;
  const key = String(groupId);
  const n = (groupMsgTick.get(key) || 0) + 1;
  groupMsgTick.set(key, n);
  const trigger = Math.max(10, Number(CFG.summary.triggerMsgs) || 60);
  if (n % trigger !== 0) return;                     // 每累计 trigger 条触发一次
  const arr = getGroupBuffer(key);
  const keep = Math.max(2, Number(CFG.summary.keepRecent) || 12);
  if (arr.length <= keep) return;
  summarizeOlder(key, arr.slice(0, arr.length - keep));  // 异步，不阻塞聊天
}

async function summarizeOlder(groupId, older) {
  try {
    const text = older
      .map((it) => `${it.isBot ? '我(AI)' : (it.name || it.uid)}: ${String(it.text || '').slice(0, 60)}`)
      .join('\n');
    if (!text.trim()) return;
    const prev = groupSummaries.get(groupId) || '';
    const messages = [
      { role: 'system', content: '把群聊记录压缩成简短摘要。只保留：讨论主题、已得出的结论、重要人物/对象、用户提出的问题、机器人说过的重要内容。忽略无意义闲聊。用 3~5 行中文。' },
      { role: 'user', content: (prev ? `已有摘要：${prev}\n\n新增记录：\n` : '') + text.slice(0, 2000) },
    ];
    const obj = await callAPI(messages, false, {
      model: CFG.judge.model || MODEL, kind: 'answer', temperature: 0.3,
      maxTokens: 512, groupId: String(groupId),
    });
    const s = ((obj.choices && obj.choices[0] && obj.choices[0].message && obj.choices[0].message.content) || '').trim();
    if (s) { groupSummaries.set(groupId, s.slice(0, 800)); log('[摘要] 群' + groupId + ' 已更新'); }
  } catch (e) {
    log('[摘要] 失败(不影响聊天): ' + e.message);   // 摘要失败 → 继续用最近消息
  }
}

// 事件里一般自带 group_name；没有就查一次接口并缓存（失败不影响主流程）
async function getGroupName(groupId, evName) {
  if (evName) { groupNameCache.set(String(groupId), evName); return evName; }
  const key = String(groupId);
  if (groupNameCache.has(key)) return groupNameCache.get(key);
  try {
    const r = await napcatCall('get_group_info', { group_id: Number(groupId) });
    const n = r && r.data && r.data.group_name;
    if (n) { groupNameCache.set(key, n); return n; }
  } catch (e) {}
  return '';
}

// 取发送者显示名：优先群名片 → 昵称 → QQ号
function senderName(ev) {
  const s = (ev && ev.sender) || {};
  return String(s.card || s.nickname || ev.user_id || '').trim();
}

// 解析 reply 引用段：实测该群 57 条历史里 reply 段为 0，故做「有则用、无则 null」
function extractReply(msg) {
  for (const seg of segments(msg)) {
    if (seg?.type === 'reply' && seg.data) {
      const id = seg.data.id != null ? String(seg.data.id) : '';
      if (id) return { id };
    }
  }
  return null;
}

// 从缓冲里按 message_id 找被引用的消息（找不到就返回 null，绝不编造）
function findBufferedMsg(groupId, messageId) {
  if (!messageId) return null;
  const arr = getGroupBuffer(groupId);
  for (let i = arr.length - 1; i >= 0; i--) {
    if (String(arr[i].id) === String(messageId)) return arr[i];
  }
  return null;
}

// —— 本地规则预筛：全程 0 次 API 调用 ——
// 返回 { reply, needsJudge, reason, bypassCooldown }
//   reply=true           → 确定要回（确定性命中，不经 Judge）
//   needsJudge=true      → 候选（本地无法确定），交给 AI Judge
//   两者皆 false         → 安静不回
function shouldReplyGroup(ev, text, opts) {
  const selfId = String(ev.self_id);
  const myNames = (CFG.group.aiNames || []).map((x) => String(x).toLowerCase()).filter(Boolean);

  // 优先级 1：明确 @ 机器人 → 必回（确定性命中，且不受冷却限制）
  if (isAtMe(ev.message, selfId)) {
    return { reply: true, needsJudge: false, reason: 'at', bypassCooldown: true };
  }

  // 优先级 2：回复机器人自己的消息 → 必回（确定性命中）
  const rp = opts.reply;
  if (rp && rp.isToBot) {
    return { reply: true, needsJudge: false, reason: 'reply-to-bot', bypassCooldown: false };
  }

  // 优先级 3：出现机器人名字 → 候选（【提到】≠【呼叫】，本地无法区分，交 Judge）
  const low = String(text || '').toLowerCase();
  if (myNames.length && myNames.some((n) => low.includes(n))) {
    return { reply: false, needsJudge: true, reason: 'name-mention', bypassCooldown: false };
  }

  // 优先级 4：机器人刚参与过、这条像追问 → 候选（交 Judge）
  const lastAt = lastBotReplyAt.get(String(ev.group_id)) || 0;
  const within = Date.now() - lastAt < (Number(CFG.group.topicWindowMs) || 120000);
  // v11 收紧：必须有「追问信号」才算候选，不再因为「消息短 + 时间近」就触发
  const looksFollowUp =
    /[?？]/.test(text || '') ||
    /呢|吗|咋|怎么|为什么|如何|然后|那|这个|那个|所以|继续|真的假的|确定/.test(text || '');
  if (within && lastAt > 0 && looksFollowUp && !opts.requireAt) {
    return { reply: false, needsJudge: true, reason: 'topic-followup', bypassCooldown: false };
  }

  // 优先级 5/6：普通群聊 / 无法判断 → 不回
  return { reply: false, needsJudge: false, reason: 'normal-chat', bypassCooldown: false };
}

// —— 这条消息是不是「对着机器人说」的（@ / 回复机器人 / 聊天记录 / Judge 放行的点名与追问）——
// 用途：被@后必须联系上下句话 + 中度思考（见 processReply）
function isBotDirected(decision) {
  const r = String((decision && decision.reason) || '');
  return r === 'at' || r.startsWith('at+')
    || r === 'reply-to-bot' || r.startsWith('reply-to-bot+')
    || r === 'chat-record' || r.startsWith('chat-record+')
    || r === 'name-mention+judge' || r === 'topic-followup+judge';
}

// —— 上下文筛选：本地 30 条 ≠ 全发给 API ——
// 按「与当前问题的相关性 + 最近性」挑，最多 contextComplex 条
function pickGroupContext(groupId, currentText, replyInfo, limitIn) {
  const arr = getGroupBuffer(String(groupId));
  if (!arr.length) return [];
  const limit = Math.max(1, Number(limitIn) || Number(CFG.group.contextNormal) || 8);
  const hardMax = Math.max(limit, Number(CFG.group.contextComplex) || 15);

  const picked = [];
  const chosen = new Set();

  const take = (item, why) => {
    if (!item || chosen.has(item.id)) return;
    chosen.add(item.id);
    picked.push({ item, why });
  };

  // ① reply 指向的那条（最高优先）
  if (replyInfo && replyInfo.target) take(replyInfo.target, 'reply');
  // ② 机器人最近的回复
  for (let i = arr.length - 1; i >= 0 && picked.length < Math.min(4, limit); i--) {
    if (arr[i].isBot) take(arr[i], 'bot-recent');
  }
  // ③ 当前用户最近的发言
  for (let i = arr.length - 1; i >= 0 && picked.length < Math.min(5, limit); i--) {
    if (arr[i].uid === replyInfo?.uid) take(arr[i], 'same-user');
  }
  // ④ 关键词相关的消息（2 字片段匹配，复用相关性思路）
  const grams = new Set();
  const q = String(currentText || '').replace(/[\s“”"'’]/g, '');
  for (let i = 0; i + 2 <= q.length; i++) {
    const g = q.slice(i, i + 2);
    if (/^[\u4e00-\u9fa5]{2}$/.test(g)) grams.add(g);
  }
  if (grams.size) {
    for (let i = arr.length - 1; i >= 0 && picked.length < limit + 3; i--) {
      const t = arr[i].text || '';
      for (const g of grams) { if (t.includes(g)) { take(arr[i], 'related'); break; } }
    }
  }
  // ⑤ 最近若干条补齐（保时间连续性）
  for (let i = Math.max(0, arr.length - limit); i < arr.length; i++) {
    if (picked.length >= hardMax) break;
    take(arr[i], 'recent');
  }

  // 按时间还原顺序
  picked.sort((a, b) => a.item.time - b.item.time);
  return picked.slice(-hardMax);
}

// 把筛选后的上下文渲染成给模型的文本（含 群名/昵称/身份 + 旧内容摘要）
function renderGroupContext(groupName, picked, current, summary) {
  const head =
    `【群聊：${groupName || current.groupId}】\n` +
    (summary ? `【更早的群聊摘要】\n${summary}\n` : '') +
    `【最近的群聊记录（供理解上下文，不必逐条回应）】`;
  if (!picked.length) return summary ? head : '';
  const lines = picked.map((p) => {
    const nm = p.item.isBot ? '我(AI)' : (p.item.name || p.item.uid);
    const mark = p.item.atMe ? '(at我) ' : '';
    return `${nm}: ${mark}${p.item.text}`;
  });
  return head + '\n' + lines.join('\n');
}

const lastReplyAt = new Map();
const seenIds = new Set();

// ================= V14：Agent 接入（最小增量）=================
// 定位：Agent 是「调度层」，不是替代层。
//   L0 预筛 / Judge / 冷却 / 合并转发 全部保持原样；Agent 只在「已经确定要回答」之后运行。
//   无需工具时 agent.run() 返回 handled=false，0 额外 Token，行为与 V13.5 完全一致。
function agentEnabled() {
  return !!(CFG.agent && CFG.agent.enabled !== false) && agent.isEnabled();
}

// 长期记忆检索（给 memory_search 工具用）
function memorySearch(sessionId, query) {
  const arr = notes.get(sessionId) || [];
  if (!arr.length) return '（这个会话还没有长期记忆）';
  const q = String(query || '').trim();
  const hit = q ? arr.filter((x) => String(x).includes(q)) : arr;
  const use = hit.length ? hit : arr;
  return use.slice(-10).map((x, i) => (i + 1) + '. ' + x).join('\n');
}

// ================= V14-B：给 tools/ 注入的适配层（全部复用既有安全校验）=================

// File：读取（结构化返回，失败就是失败，不伪装）
function readWorkspaceFile(name) {
  const p = workspacePath(name);
  if (!p) return { ok: false, error: '文件名不合法' };
  // 符号链接边界：必须先 realpath 拿到规范化真实路径，确认其仍落在 WORKSPACE_DIR 内，
  // 否则指向工作区外的软链/联接会被 statSync/readFileSync 跟随而越界读取。
  let real;
  try { real = fs.realpathSync(p); } catch (e) { return { ok: false, error: '读取失败' }; }
  if (!isUnderDir(real, WORKSPACE_DIR)) return { ok: false, error: '文件名不合法' };
  let st;
  try { if (!fs.existsSync(p)) return { ok: false, error: '找不到文件：' + name }; st = fs.statSync(p); }
  catch (e) { return { ok: false, error: '读取失败' }; }
  if (BINARY_EXT.has(path.extname(p).toLowerCase())) return { ok: false, error: '这是二进制文件，读不出文字内容' };
  if (st.size > MAX_FILE_BYTES) return { ok: false, error: '文件太大（' + fmtBytes(st.size) + '）' };
  try {
    let text = fs.readFileSync(p, 'utf-8');
    const truncated = text.length > MAX_READ_CHARS;
    if (truncated) text = text.slice(0, MAX_READ_CHARS);
    return { ok: true, name: path.basename(p), text, size: st.size, truncated };
  } catch (e) { return { ok: false, error: '读取失败：' + e.message }; }
}

// File：是否允许写入（拒绝二进制扩展名；仍走 workspacePath 做越界判定）
function isWritableName(name) {
  const p = workspacePath(name);
  if (!p) return false;
  const ext = path.extname(p).toLowerCase();
  if (!ext) return true;
  if (BINARY_EXT.has(ext)) return false;
  return true;
}

// Memory：长期记忆（notes.json）
function agentGetNotes(sessionId) {
  return (notes.get(sessionId) || []).slice();
}

// Memory：短期上下文（sessions.json 最近几轮，与长期记忆严格分开）
function agentGetShortTerm(sessionId) {
  const arr = sessions.get(sessionId) || [];
  return arr.slice(-12).map((m) => {
    const who = m && m.role === 'assistant' ? '我(AI)' : '用户';
    let c = m && m.content;
    if (Array.isArray(c)) c = c.map((x) => (x && x.text) || (x && x.type === 'image_url' ? '[图片]' : '')).join(' ');
    return who + '：' + String(c || '').slice(0, 120);
  });
}

// Chat Record：拉合并转发（复用 handleChatRecord 里同样的 NapCat 调用）
async function getForwardMsg(id) {
  const r = await napcatCall('get_forward_msg', { id });
  return (r && r.data && Array.isArray(r.data.messages)) ? r.data.messages : [];
}

// Chat Record：取当前待处理记录（带 TTL 检查）
function getPendingChatRecordForAgent(ctx) {
  const key = (ctx && ctx.isGroup) ? ('g' + ctx.groupId) : ('p' + ctx.userId);
  const e = pendingChatRecords.get(key);
  if (!e) return null;
  if (Date.now() - e.at > CHAT_RECORD_TTL_MS) { pendingChatRecords.delete(key); return null; }
  return e.record;
}

// Chat Record：当前会话是否有待处理记录（给 Agent 的意图信号用）
function hasPendingChatRecord(scopeKey) {
  const e = pendingChatRecords.get(scopeKey);
  if (!e) return false;
  if (Date.now() - e.at > CHAT_RECORD_TTL_MS) { pendingChatRecords.delete(scopeKey); return false; }
  return true;
}

// 只有当「有待处理记录」且「用户这句话像在问这段记录」时，才把信号交给 Agent
const CR_QUESTION_RE = /(聊天记录|合并转发|转发|记录|他们|聊了什么|说了什么|为什么吵|吵起来|总结一下|帮我总结|讲的啥|说了啥)/;
function isChatRecordQuestion(text) {
  return CR_QUESTION_RE.test(String(text || ''));
}

// ================= V14-C：多模态适配层（Image / Video）=================
// 全部复用既有能力：fetchImageAsBase64 / MULTIMODAL_MODEL / callAPI / isSafeUrl / workspacePath。
// 不新增任何 CMD / PowerShell / 程序启动 / 文件越权能力。

// —— 视频专用限制（最小增量：只新增视频自己的常量，不动既有的图片/文件限制）——
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;          // 单个视频上限 100MB
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.flv', '.m4v', '.3gp']);
const VIDEO_CACHE_DIR = path.join(__dirname, 'workspace', '_video_cache');
// 只允许这几处根目录里的视频文件（realpath + 前缀校验，防穿越 / 软链 / 项目外路径）
const VIDEO_ALLOWED_ROOTS = [
  path.join(__dirname, 'workspace'),
  path.join(__dirname, 'napcat', 'cache'),
];
const VIDEO_ADDON_PATH = path.join(__dirname, 'napcat', 'native', 'ffmpeg', 'ffmpegAddon.win32.x64.node');
const VISION_PROMPT =
  '你是图片/视频画面分析助手。只描述你真实看到的内容：主体、场景、文字、颜色布局。' +
  '图里有文字就原样读出（尤其是明显的测试标记/编号）。' +
  '看不清或没有的信息直接说"看不清/无法确定"，禁止推测、禁止编造。用中文简短回答。';

// 视频路径归属判断：基于 path.relative 验证 real 是否真实位于某个白名单根目录之下，
// 杜绝 startsWith 字符串前缀误判（如 D:\...\\workspace_backup 被误认为 workspace 子项）。
// Windows 文件系统大小写不敏感，故先统一 lower-case 再比对；跨盘符时 path.relative
// 返回绝对路径，由 isAbsolute 检查拦截；.. 穿越会使 rel 以 '..' 开头，同样拦截。
function isUnderAllowedVideoRoot(real) {
  for (const r of VIDEO_ALLOWED_ROOTS) {
    if (isUnderDir(real, r)) return true;
  }
  return false;
}

// 视频路径安全校验：realpath + 白名单根目录（路径相对关系判断）+ 扩展名 + 大小
function safeVideoPath(p) {
  if (typeof p !== 'string' || !p) return null;
  if (/^[a-zA-Z]:[\\/]/.test(p) === false && !p.startsWith('/')) return null;   // 必须是绝对路径
  let real;
  try { real = fs.realpathSync(p); } catch (e) { return null; }   // 解析符号链接 / ..，无法解析（不存在/不可达）则保守拒绝
  let st;
  try { st = fs.statSync(real); } catch (e) { return null; }
  if (!st.isFile()) return null;
  if (!isUnderAllowedVideoRoot(real)) return null;               // 项目外 / workspace_backup 同级 / 跨盘符 / .. 穿越 → 一律拒绝
  if (!VIDEO_EXT.has(path.extname(real).toLowerCase())) return null;
  if (st.size > MAX_VIDEO_BYTES) return null;
  return real;
}

// 从「可信的视频 segment」解析出本地文件路径（绝不接收模型给的路径）
// 顺序：段内本地路径 → NapCat get_file → 按 URL 下载进 _video_cache（SSRF 校验 + 大小上限）
async function resolveVideoFile(seg) {
  const d = (seg && seg.data) || {};

  // ① 段内给的本地路径
  for (const c of [d.path, d.file]) {
    if (typeof c !== 'string' || !c) continue;
    const p = /^file:\/\//i.test(c) ? decodeURIComponent(c.replace(/^file:\/\//i, '')) : c;
    if (!isLocalPath(p)) continue;
    const ok = safeVideoPath(p);
    if (ok) return { path: ok, from: 'local' };
  }

  // ② NapCat get_file（拿到本地缓存路径）
  for (const key of ['file', 'file_id']) {
    const v = d[key];
    if (typeof v !== 'string' || !v) continue;
    try {
      const r = await napcatCall('get_file', { file_id: v, file: v });
      const cands = [r && r.data && r.data.file, r && r.data && r.data.path];
      for (const c of cands) {
        if (typeof c !== 'string' || !c) continue;
        const ok = safeVideoPath(c);
        if (ok) return { path: ok, from: 'napcat' };
      }
    } catch (e) { /* 拿不到就继续往下走 */ }
  }

  // ③ URL 下载兜底（安全整改：与 fetchUrl 同标准——safeFetch 固定 IP + socket 复核 + 逐跳重校验 + 限额）
  //    旧代码「isSafeUrl 校验 → 裸 fetch 连接」存在 DNS 重绑定窗口，且 arrayBuffer 全量落内存后才判大小
  const url = /^https?:/i.test(d.url || '') ? d.url : '';
  if (url) {
    try {
      if (!fs.existsSync(VIDEO_CACHE_DIR)) fs.mkdirSync(VIDEO_CACHE_DIR, { recursive: true });
      const r = await safeFetch(url, { maxRedirects: 3, maxBytes: MAX_VIDEO_BYTES + 1024, headers: { 'User-Agent': UA, 'Referer': 'https://qq.com/' } });
      if (r && r.ok) {
        const ab = r.body;
        if (ab && ab.byteLength > 0 && ab.byteLength <= MAX_VIDEO_BYTES) {
          const ext = path.extname(new URL(r.finalUrl || url).pathname).toLowerCase();
          const name = 'v_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + (VIDEO_EXT.has(ext) ? ext : '.mp4');
          const fp = path.join(VIDEO_CACHE_DIR, name);
          fs.writeFileSync(fp, ab);
          const ok = safeVideoPath(fp);
          if (ok) return { path: ok, from: 'download' };
        }
      }
    } catch (e) {
      log('[视频] 下载失败: ' + e.message);
    }
  }
  return null;
}

// FFmpeg native addon（懒加载 + 失败可降级）
let ffmpegAddon = null;
let ffmpegProbeTried = false;
function loadFfmpegAddon() {
  if (ffmpegAddon !== null) return ffmpegAddon;
  if (ffmpegProbeTried) return ffmpegAddon;
  ffmpegProbeTried = true;
  try { ffmpegAddon = require(VIDEO_ADDON_PATH); } catch (e) { ffmpegAddon = false; }
  return ffmpegAddon;
}

// —— Agent 视觉分析（图片）——
// 复用 fetchImageAsBase64；强制 MULTIMODAL_MODEL；独立一次 API 调用，计入 kind='vision'。
async function agentVisionAnalyze(segs, question, ctx) {
  const list = (Array.isArray(segs) ? segs : []).slice(0, MAX_IMAGES);
  if (!list.length) return { ok: false, error: '没有图片段' };

  const parts = [{ type: 'text', text: String(question || '').trim() || '请如实描述这张图片的内容。' }];
  let imageOK = 0, imageFail = 0;
  for (const seg of list) {
    const dataUrl = await fetchImageAsBase64(seg);
    if (dataUrl) { parts.push({ type: 'image_url', image_url: { url: dataUrl } }); imageOK++; }
    else imageFail++;
  }
  if (!imageOK) return { ok: false, error: '图片全部获取失败（共 ' + list.length + ' 张）' };

  const ev = (ctx && ctx.input && ctx.input.ev) || null;
  const chatId = (ctx && ctx.input && ctx.input.chatId) || '';
  const groupId = ev && ev.message_type === 'group' ? ev.group_id : null;
  const model = (CFG.model && CFG.model.multimodal) || MULTIMODAL_MODEL || MODEL;
  const messages = [
    { role: 'system', content: VISION_PROMPT },
    { role: 'user', content: parts },
  ];
  let obj;
  try {
    obj = await callAPI(messages, false, { groupId, model, chatId, kind: 'vision' });
  } catch (e) {
    return { ok: false, error: '视觉模型调用失败：' + e.message };
  }
  const text = String((obj && obj.choices && obj.choices[0] && obj.choices[0].message && obj.choices[0].message.content) || '').trim();
  if (!text) return { ok: false, error: '视觉模型返回空内容' };
  log(`[视觉] 分析完成 图=${imageOK} 失败=${imageFail} 模型=${model}`);
  return { ok: true, text, imageCount: list.length, imageOK, imageFail, model };
}

// —— Agent 视频分析（元数据 + 首帧）——
async function agentVideoAnalyze(segs, question, ctx) {
  const list = (Array.isArray(segs) ? segs : []).slice(0, 1);
  if (!list.length) return { ok: false, error: '没有视频段' };

  const file = await resolveVideoFile(list[0]);
  if (!file) return { ok: false, error: '拿不到视频文件（消息里没有可用的本地路径/下载失败/不在允许目录内）' };

  const addon = loadFfmpegAddon();
  if (!addon || typeof addon.getVideoInfo !== 'function') {
    return { ok: false, error: 'FFmpeg native addon 不可用，无法提取视频元数据与首帧' };
  }

  let info;
  try { info = await addon.getVideoInfo(file.path); }
  catch (e) { return { ok: false, error: '读取视频失败：' + e.message }; }
  if (!info || typeof info !== 'object') return { ok: false, error: '视频元数据为空' };

  const meta = {
    width: Number(info.width) || null,
    height: Number(info.height) || null,
    duration: Number(info.duration) || null,
    format: typeof info.format === 'string' ? info.format.split(',')[0] : null,
    videoCodec: typeof info.videoCodec === 'string' ? info.videoCodec : null,
  };

  const frame = Buffer.isBuffer(info.image) && info.image.length > 1024 ? info.image : null;
  let firstFrameAnswer = null;
  let model = null;
  if (frame) {
    const dataUrl = 'data:image/jpeg;base64,' + frame.toString('base64');
    const ev = (ctx && ctx.input && ctx.input.ev) || null;
    const chatId = (ctx && ctx.input && ctx.input.chatId) || '';
    const groupId = ev && ev.message_type === 'group' ? ev.group_id : null;
    model = (CFG.model && CFG.model.multimodal) || MULTIMODAL_MODEL || MODEL;
    const q = String(question || '').trim() ||
      ('这是某个视频的第一帧画面（视频时长约 ' + (meta.duration ? Math.round(meta.duration * 10) / 10 : '?') + ' 秒）。请如实描述这一帧里看到的内容。');
    const messages = [
      { role: 'system', content: VISION_PROMPT },
      { role: 'user', content: [
        { type: 'text', text: q },
        { type: 'image_url', image_url: { url: dataUrl } },
      ] },
    ];
    try {
      const obj = await callAPI(messages, false, { groupId, model, chatId, kind: 'video' });
      firstFrameAnswer = String((obj && obj.choices && obj.choices[0] && obj.choices[0].message && obj.choices[0].message.content) || '').trim() || null;
    } catch (e) {
      firstFrameAnswer = null;   // 首帧分析失败 ≠ 整个失败，仍返回元数据
    }
  }

  log(`[视频] 分析完成 ${meta.width}x${meta.height} ${meta.duration}s 首帧=${frame ? '有' : '无'} 来源=${file.from}`);
  return {
    ok: true,
    data: Object.assign({}, meta, {
      firstFrameAvailable: !!firstFrameAnswer,
      firstFrameAnswer,
      model,
      sourceOfFile: file.from,
    }),
  };
}

// V14-C：从「已解析的待处理聊天记录」里抽出图片/视频引用（只给 {file,url}，不给正文）
function chatRecordMediaRefs(ev) {
  const rec = getPendingChatRecordForAgent({
    isGroup: ev.message_type === 'group',
    groupId: ev.group_id,
    userId: ev.user_id,
  });
  if (!rec || !Array.isArray(rec.messages)) return null;
  const images = [], videos = [];
  for (const m of rec.messages) {
    for (const c of (m && m.content) || []) {
      if (c.type === 'image') images.push({ file: c.file || '', url: c.url || '' });
      else if (c.type === 'video') videos.push({ file: c.file || '', url: c.url || '' });
    }
  }
  return { images: images.slice(0, 10), videos: videos.slice(0, 3) };
}

// 视频能力自检（供测试与最终报告如实输出，绝不靠猜）
function videoCapabilityProbe() {
  const addon = loadFfmpegAddon();
  return {
    ffmpegExe: false,                                   // 项目内确实没有 ffmpeg.exe（扫描确认）
    ffmpegNativeAddon: !!(addon && typeof addon.getVideoInfo === 'function'),
    addonPath: VIDEO_ADDON_PATH,
    addonExists: fs.existsSync(VIDEO_ADDON_PATH),
    metadata: !!(addon && typeof addon.getVideoInfo === 'function'),
    firstFrame: !!(addon && typeof addon.getVideoInfo === 'function'),
    multiFrame: false,                                  // addon 无 seek 参数 → 只能取首帧
    fullVideoUnderstanding: false,
    allowedRoots: VIDEO_ALLOWED_ROOTS.slice(),
    maxBytes: MAX_VIDEO_BYTES,
    exts: Array.from(VIDEO_EXT),
  };
}

// Agent 运行摘要落盘：只记 intent / tool / status / duration / token，绝不记聊天正文
function recordAgentRun(ar) {
  try {
    const s = ar.run.summary();
    stats.agentRuns = (Number(stats.agentRuns) || 0) + 1;
    stats.agentToolCalls = (Number(stats.agentToolCalls) || 0) + (Number(s.toolCalls) || 0);
    stats.agentToolFailures = (Number(stats.agentToolFailures) || 0) + s.tools.filter((t) => !t.ok).length;
    stats.agentStepsTotal = (Number(stats.agentStepsTotal) || 0) + (Number(s.steps) || 0);
    stats.agentDurationMs = (Number(stats.agentDurationMs) || 0) + (Number(s.durationMs) || 0);
    saveStats();
    if (!CFG.agent || CFG.agent.logRuns === false) return;
    fs.mkdirSync(USAGE_DIR, { recursive: true });
    const f = path.join(USAGE_DIR, 'agent.' + new Date().toISOString().slice(0, 10) + '.jsonl');
    fs.appendFileSync(f, JSON.stringify({
      time: new Date().toISOString(),
      runId: s.id,
      chatId: (ar.run.meta && ar.run.meta.chatId) || '',
      groupId: (ar.run.meta && ar.run.meta.groupId) || '',
      userId: (ar.run.meta && ar.run.meta.userId) || '',
      intents: s.intents, primary: s.primaryIntent,
      steps: s.steps, toolCalls: s.toolCalls, stopReason: s.stopReason,
      durationMs: s.durationMs, ok: !!ar.ok,
      tools: s.tools,          // [{tool, ok, ms}] —— 不含工具返回原文，避免隐私落盘
      token: s.token,
    }) + '\n', 'utf-8');
  } catch (e) {}
}

// ———— 组装 + 调用 AI + 发送（群聊/私聊共用，v10 抽出）————
async function processReply(ev, o) {
  const msgType = ev.message_type;
  const userId = Number(ev.user_id);
  const sessionId = o.sessionId;

  // —— V14-C：视频段直接来自真实事件（不是模型给的路径），只传引用 ——
  const videoSegs = segments(ev.message).filter((s) => s && s.type === 'video');
  const crRefs = chatRecordMediaRefs(ev);   // 待处理聊天记录里的图片/视频引用（可能为 null）

  // —— 内容顺序（保证前缀稳定）：图片 → 群上下文 → 当前文本 → 提示 ——
  const parts = [];
  let imgOK = 0;
  for (const seg of (o.imgSegs || []).slice(0, MAX_IMAGES)) {
    const dataUrl = await fetchImageAsBase64(seg);
    if (dataUrl) { parts.push({ type: 'image_url', image_url: { url: dataUrl } }); imgOK++; }
  }
  if ((o.imgSegs || []).length) log(`[图片] 本条 ${o.imgSegs.length} 张，成功 ${imgOK} 张`);

  // 复杂度分级：既决定带入多少上下文，也决定用哪个模型
  const complexity = classifyComplexity(o.text, o.imgSegs);
  let ctxLimit = Number(CFG.context && CFG.context[complexity]) || Number(CFG.group.contextNormal) || 8;
  if (AI_MODE === 'economy') ctxLimit = Math.min(ctxLimit, 4);  // v12 economy：少带上下文省 token（复杂问题仍走 reasoning 模型）
  // —— 被@/回复机器人：必须联系上下句话，上下文保底（杜绝只看着当前一句回答）——
  const botDirected = msgType === 'group' && isBotDirected(o.decision);
  if (botDirected) {
    const atMin = Number(CFG.atReply && CFG.atReply.minContext) || Number(CFG.group.contextNormal) || 8;
    ctxLimit = Math.max(ctxLimit, atMin);
  }
  let answerModel = pickModel(o.text, o.imgSegs);
  // —— 中度思考：对着机器人说的消息不用最浅的 fast 模型，保底 normal；复杂问题仍可升 reasoning ——
  if (botDirected && CFG.atReply && CFG.atReply.moderateThinking !== false) {
    const fastM = (CFG.model && CFG.model.fast) || MODEL;
    if (answerModel === fastM) answerModel = (CFG.model && CFG.model.normal) || CFG.api.model || MODEL;
  }

  // 群聊：注入「群名 + 摘要 + 筛选后的上下文」（本地 30 条 ≠ 全发给 API）
  // V13.5：聊天记录分析时跳过，避免把群缓冲当成聊天记录上下文干扰理解
  if (msgType === 'group' && !o.skipGroupContext) {
    const picked = pickGroupContext(ev.group_id, o.text, { uid: String(userId), target: o.rpTarget }, ctxLimit);
    const summary = groupSummaries.get(String(ev.group_id)) || '';
    const ctxText = renderGroupContext(o.grpName, picked, { groupId: ev.group_id }, summary);
    if (ctxText) {
      parts.push({ type: 'text', text: ctxText });
      log(`[上下文] 群${ev.group_id} 带入 ${picked.length} 条(${complexity}) 模型=${answerModel}`);
    }
  }

  // ================= V14：Agent Core（只在确定要回答之后运行）=================
  // 无需工具 → handled=false → 0 额外 Token，行为与 V13.5 完全一致。
  // 需要工具 → 由 Agent 按 Registry 逐步执行，再把「工具事实」拼进上下文交给模型综合。
  let agentKind = '';
  let imageHandledByAgent = false;   // V14-C：Agent 已经做过视觉分析 → 不再把原图重复发给模型（避免重复计费）
  let genAckSent = '';               // V14-D：生图前已发出的接应话（避免最后又重复发一遍）
  let genDoneByAgent = false;        // V14-D：Agent 已出图 → 后面别再让模型重复画
  if (o.agent !== false && agentEnabled()) {
    try {
      // V14-D：预判「要画图」→ 先说一句人话接住，再让工具去画（用户要的顺序：先回答，再生图）
      const genSignals = {
        hasImage: (o.imgSegs || []).length > 0,
        hasRecentImage: (o.imgSegs || []).length > 0,
        hasVideo: videoSegs.length > 0,
        hasChatRecordImage: !!(crRefs && crRefs.images.length),
        hasForward: hasPendingChatRecord(chatRecordScopeKey(ev)) && isChatRecordQuestion(o.text),
        isAtMe: !!(o.decision && o.decision.reason === 'at'),
        isGroup: msgType === 'group',
        imageGeneration: (CFG.image || {}).enabled !== false && (CFG.image || {}).agentFirst !== false,
      };
      if (typeof agent.detectIntent === 'function' && agent.hasTool('generate_image')
          && genSignals.imageGeneration) {
        const pi = agent.detectIntent(o.text || '', genSignals);
        const g = ((pi && pi.suggestedTools) || []).find((x) => x.tool === 'generate_image');
        if (g) {
          const gp = String((g.args && g.args.prompt) || '').trim();
          const isI2I = String((g.args && g.args.source) || '') === '1';
          const ack = await genImageAck(gp, isI2I);
          if (ack) {
            await sendSimpleReply(ev, msgType === 'group', userId, ack);
            genAckSent = String(ack).trim();
          }
        }
      }
      // V14-D 关键：工具执行发生在 askDeepSeek 之前，必须在这里先把 {ev, imgSegs} 挂上，
      // 否则 generate_image 拿不到群号/会话（发不出图）也拿不到源图（图生图失效）。
      setImageToolCtx(sessionId, ev, o.imgSegs || []);

      const ar = await agent.run({
        text: o.text || '',
        signals: Object.assign({
          hasImage: (o.imgSegs || []).length > 0,
          hasVideo: videoSegs.length > 0,        // V14-C：真实视频段
          hasFile: false,                        // V14-B 接入
          hasChatRecordImage: !!(crRefs && crRefs.images.length),   // V14-C：记录里有图
          hasChatRecordVideo: !!(crRefs && crRefs.videos.length),   // V14-C：记录里有视频
          // V14-B：如果本会话 10 分钟内收到过合并转发，且这句话像在问这段记录 → 交给 chat_record_analysis
          hasForward: hasPendingChatRecord(chatRecordScopeKey(ev)) && isChatRecordQuestion(o.text),
          isAtMe: !!(o.decision && o.decision.reason === 'at'),
          replyToBot: !!(o.rpTarget && o.rpTarget.isBot),
          isGroup: msgType === 'group',
        }, {
          // V14-D：生图开关 + 「本条/上一条有图」信号（图生图用）
          hasRecentImage: (o.imgSegs || []).length > 0,
          imageGeneration: genSignals.imageGeneration,
        }),
        // V14-C：媒体只传「引用」，不传二进制；Tool 只能从这些引用里取
        media: {
          imageSegs: (o.imgSegs || []).slice(0, MAX_IMAGES),
          videoSegs: videoSegs.slice(0, 3),
          chatRecord: crRefs,   // { images:[{file,url}], videos:[{file,url}] } 或 null
        },
        chatId: o.chatId,
        groupId: ev.group_id,
        userId,
        sessionId,
        isGroup: msgType === 'group',
        // 安全整改：把「管理员身份」带进 Agent 运行上下文，
        // 让工具在执行层自行校验权限（而不是只靠模型提示词或意图分类）
        isAdmin: isAdmin(userId),
        ev,                                    // 仅供适配器取 groupId/chatId，不进任何提示词
      });
      if (ar && ar.handled) {
        if (ar.context) parts.push({ type: 'text', text: ar.context });
        agentKind = 'agent';                 // 这次回答计入 agent 分账
        recordAgentRun(ar);
        const obs = (ar.run && ar.run.observations) || [];
        imageHandledByAgent = obs.some((x) => x.ok && x.tool === 'image_analysis' &&
          x.raw && x.raw.data && x.raw.data.source === 'current_message');
        if (imageHandledByAgent) {
          // 图已经由 image_analysis 分析过并写进工具上下文 → 剥掉原图 parts，避免同一张图付两次 Vision 的钱
          for (let i = parts.length - 1; i >= 0; i--) {
            if (parts[i] && parts[i].type === 'image_url') parts.splice(i, 1);
          }
          log('[图片] 已由 image_analysis 处理，本次不再重复发送原图（避免重复计费）');
        }
        // V14-D：Agent 已经画完并发了图 → 后面不再挂生图工具，否则模型可能再画一张（重复出图 + 双倍耗时）
        if (obs.some((x) => x.ok && x.tool === 'generate_image')) {
          genDoneByAgent = true;
          log('[生图] Agent 已出图，后续不再挂 generate_image 工具');
        }
      }
    } catch (e) {
      log('[Agent] 异常，回退原有链路: ' + e.message);
    }
  }

  if (o.text) parts.push({ type: 'text', text: o.text });

  const hints = [];
  if (botDirected && CFG.atReply && CFG.atReply.moderateThinking !== false) {
    hints.push('这条是直接@你/回复你的。先把上面的群聊记录和这条消息连起来看：结合前后几句搞清楚对方在说什么、想问什么、之前聊到哪，中度思考后再回答。上下文里已经有的信息直接接用，别装没看见；回答要接得上前后文，别答得前后不搭');
  }
  if (!imageHandledByAgent && (o.imgSegs || []).length > 0 && imgOK === 0) {
    hints.push('本条消息的图片没拿到，你看不到图片内容，别假装看到了，照实说没收到/让对方重发');
  } else if (!imageHandledByAgent && !o.text && imgOK > 0) {
    hints.push('对方只发了图片没说话，你看看是啥');
  }
  if (imgOK > 0 && CFG.image && CFG.image.enabled && !genDoneByAgent) {
    hints.push('本条带了 ' + imgOK + ' 张图。想画图就调用 generate_image；要基于对方这张图改风格/重绘/变成别的画风，把 source 填 "1"；对方只是问图里是什么、让你看图说话，就别调生图');
  }
  if (genDoneByAgent) {
    hints.push('图已经画好并发出去了。只用一两句自然的话接一下就行，绝对不要再调用 generate_image 重复画一张，也不要复述画面内容');
  }
  if (o.rpTarget) {
    hints.push(`本条是回复「${o.rpTarget.isBot ? '你自己(AI)' : (o.rpTarget.name || '对方')}：${String(o.rpTarget.text).slice(0, 60)}」，按这个语境理解`);
  } else if (o.replyId) {
    hints.push('本条引用了某条消息，但引用原文没取到，不确定就别硬猜');
  }
  if (hints.length) parts.push({ type: 'text', text: '（提示：' + hints.join('；') + '）' });

  // ===== 长期记忆注入：只取与本条**相关**的少量记忆，不把整份记忆塞进去 =====
  // （权限过滤在 memoryStore.visible 里做：本人记忆 + 本群公共记忆）
  if (ENABLE_MEMORY && CFG.memoryStore && CFG.memoryStore.enabled !== false && o.text) {
    try {
      const mem = memoryStore.retrieve(o.text, {
        groupId: msgType === 'group' ? String(ev.group_id) : null,
        userId: String(userId),
        allowAll: isAdmin(userId),
      });
      if (mem && mem.length) {
        const lines = mem.map((m) => `- （${m.scope === 'group' ? '群' : '个人'}·置信${Math.round((m.confidence || 0) * 100)}%）${m.content}`);
        parts.push({
          type: 'text',
          text: '（长期记忆，仅供参考，不确定的事别当成事实；记忆可能过期，冲突时以当前对话为准：\n'
            + lines.join('\n') + '）',
        });
        log(`[记忆] 注入 ${mem.length} 条相关记忆（${msgType}）`);
      }
    } catch (e) {
      log('[记忆] 注入失败（已忽略）：' + String((e && e.message) || e).slice(0, 60));
    }
  }

  // ===== V15.2 群友轻量画像注入（**默认关闭**）=====
  // 只在群聊注入；内容极简且受条数/字数双上限；带「（推测）」的低置信内容不得当事实。
  // 提示词已明确要求模型"不要主动向群里提及此人的个人信息"，默认不公开。
  if (msgType === 'group' && CFG.groupProfile && CFG.groupProfile.enabled === true) {
    try {
      const pinj = groupProfile.injectText({
        groupId: String(ev.group_id),
        userId: String(userId),
        text: o.text || '',
      });
      if (pinj) {
        parts.push({ type: 'text', text: pinj });
        log(`[画像] 注入 ${CFG.groupProfile.injectLimit || 3} 条以内该成员画像（群聊）`);
      }
    } catch (e) {
      log('[画像] 注入失败（已忽略）：' + String((e && e.message) || e).slice(0, 60));
    }
  }

  let res;
  try {
    res = await askDeepSeek(sessionId, parts, ev, {
      model: answerModel, chatId: o.chatId,
      kind: agentKind || o.kind || '',        // V14：Agent 处理过的请求计入 agent 分账
      allowTools: !genDoneByAgent,            // V14-D：Agent 已出图就不再挂工具，防重复画
    });
  } catch (e) {
    // V14-C.2 修复 C：以前这里只写日志然后 return → 用户那边完全静音。
    // 现在补一条用户可见的兜底提示（不泄露异常内容/密钥/堆栈）。
    log('[错误] AI 调用失败（已回提示）: ' + String((e && e.message) || e).slice(0, 80));
    stats.errors++; saveStats();
    try {
      const tip = [{ type: 'text', data: { text: 'AI 后端这会儿有点慢/不太稳（响应超时或网关抖动），稍等一两分钟再问我，或者换个问法试试～' } }];
      if (msgType === 'group') {
        await napcatCall('send_group_msg', { group_id: ev.group_id, message: [{ type: 'at', data: { qq: String(userId) } }, ...tip] });
      } else {
        await napcatCall('send_private_msg', { user_id: userId, message: tip });
      }
    } catch (e2) { /* 兜底也失败就不再折腾，避免刷屏 */ }
    return;
  }

  const replyText = (res && res.text) || '';
  const extras = (res && res.extras) || [];
  const stickerSent = !!(res && res.stickerSent);
  // V14-D：生图前已经发过接应话，模型最后又复述了同一句 → 不再重复发一遍
  if (genAckSent && String(replyText).trim() === genAckSent) {
    log('[生图] 接应话已发过，跳过重复回复');
    if (extras.length) { /* 表情包仍要发 */ } else return;
  }
  if (!replyText && !extras.length && !stickerSent) { log('[空回复] 跳过'); return; }
  if (!replyText && !extras.length && stickerSent) { log('[表情] 本条只发了表情，无文字'); return; }
  log('[回复] ' + (replyText || '(只发了个表情)').slice(0, 80));

  // —— 拆句发送：第一条带「引用+@」，后续几条纯文字不引用（像真人一句一句接话）——
  const sp = CFG.replySplit || {};
  const wantSplit = sp.enabled !== false && String(replyText).trim().length >= (Number(sp.minChars) || 18);
  const chunks = wantSplit ? splitReplyText(replyText, sp.maxParts) : [replyText];
  const gapMs = Math.max(0, Math.min(5000, Number(sp.gapMs) || 900));
  const nap = (ms) => new Promise((s) => setTimeout(s, ms));

  if (msgType === 'group') {
    let lastMid = '';
    for (let i = 0; i < chunks.length; i++) {
      const segs = [{ type: 'text', data: { text: chunks[i] } }];
      // 只有第一条带引用和 @；后面的句子不再引用，避免连着几条都挂着引用框
      if (i === 0) {
        segs.unshift({ type: 'at', data: { qq: String(userId) } });
        if (ev.message_id != null) segs.unshift({ type: 'reply', data: { id: String(ev.message_id) } });
      }
      if (i === chunks.length - 1 && extras.length) segs.push(...extras);
      log(`[发送] 群消息 ${i + 1}/${chunks.length} 段=` + segs.map((s) => s.type).join('+'));
      const r = await napcatCall('send_group_msg', { group_id: ev.group_id, message: segs });
      // V14-C.2 修复 C：OneBot 返回可能同时带 status 与 retcode，两者都要看；
      // 只看其中一个会漏掉「status=ok 但 retcode≠0」这类真实失败。
      if (!onebotOK(r)) {
        log('[发送失败] 群' + maskId(ev.group_id) + ' status=' + (r && r.status)
          + ' retcode=' + (r && r.retcode) + ' 原因=' + String((r && (r.wording || r.message)) || '').slice(0, 60));
      }
      if (r && r.data && r.data.message_id != null) lastMid = String(r.data.message_id);
      if (i < chunks.length - 1) await nap(gapMs);
    }
    // 记录机器人自己的回复：用于「回复AI」识别 + 话题延续判定
    lastBotReplyAt.set(String(ev.group_id), Date.now());
    pushGroupBuffer(ev.group_id, {
      id: lastMid || ('bot-' + Date.now()),
      uid: String(ev.self_id), name: '我(AI)',
      text: replyText || '[表情包]', time: Date.now(),
      atMe: false, isBot: true, replyTo: null,
    });
  } else {
    for (let i = 0; i < chunks.length; i++) {
      const segs = [{ type: 'text', data: { text: chunks[i] } }];
      if (i === 0 && ev.message_id != null) segs.unshift({ type: 'reply', data: { id: String(ev.message_id) } });
      if (i === chunks.length - 1 && extras.length) segs.push(...extras);
      log(`[发送] 私聊 ${i + 1}/${chunks.length} 段=` + segs.map((s) => s.type).join('+'));
      const r2 = await napcatCall('send_private_msg', { user_id: userId, message: segs });
      if (!onebotOK(r2)) {
        log('[发送失败] 私聊' + maskId(userId) + ' status=' + (r2 && r2.status)
          + ' retcode=' + (r2 && r2.retcode) + ' 原因=' + String((r2 && (r2.wording || r2.message)) || '').slice(0, 60));
      }
      if (i < chunks.length - 1) await nap(gapMs);
    }
  }
  stats.replies++; saveStats();
}

// —— 收口：候选消息先过 Judge，再决定是否真正回复 ——
// 同群同时只允许 1 个 AI 请求（P 项），避免并发刷屏
const groupBusy = new Set();

async function decideAndReply(ev, o) {
  const g = String(ev.group_id);
  const d = o.decision || {};

  // 预算硬限：达到上限且显式开启 hard_limit 时，跳过本次回复（默认关闭，绝不主动拦）
  if (budgetExhausted() && CFG.budget && CFG.budget.hard_limit) {
    log('[预算] 已达硬上限，本次不回复');
    return;
  }

  // 这一条用户消息 = 一次「聊天」，可能触发 Judge→Answer→Tool 多次 API，用 chatId 聚合成一条
  const chatId = o.chatId || genChatId('g' + g);

  if (d.needsJudge) {
    if (!judgeEnabled()) { log(`[预筛] ${d.reason} 需判定但 Judge 关 → 不回`); return; }
    if (groupBusy.has(g)) { log('[忙碌跳过] 群' + g); return; }
    groupBusy.add(g);
    try {
      const j = await judgeReply(ev, o.text, chatId);
      if (!j || !j.shouldReply) return;                 // 明确不回 / 失败 → 安静
      o = { ...o, decision: { ...d, reason: d.reason + '+judge' } };
    } finally {
      groupBusy.delete(g);
    }
  }
  await processGroupReply(ev, { ...o, chatId });
  finalizeChat(chatId, { type: 'group', scope: g, preview: o.text });
}

// —— 极简管理员命令（仅私聊、仅配置里的管理员；只改运行时，不改配置文件）——
// 说明：原项目【没有】命令系统（admin.qq 只是预留字段），这里按最小改动新增

// 阶段2.1：群管只读查询实例（复用既有 napcatCall / isAdmin / CFG；不触碰 runTool/TOOLS/askDeepSeek/V14）
const groupAdmin = createGroupAdmin({ getCFG: () => CFG, isAdmin, callOneBot: napcatCall });

// ===== 用户指令：群聊每日总结 + 可管理的长期记忆 =====
// 权限原则：
//   · 总结类命令任何群成员都能触发（只读当天记录，只把结果发回群里），但**自动总结默认关闭**；
//   · 记忆的「查看」本人随时可看自己的 + 本群公共的（只读）；
//   · 记忆的「删除/清空」只能删自己的私有记忆；群级公共记忆只有管理员能改删（canMutate 强制）；
//   · 删除类操作一律二次确认，避免误触。
const clearConfirmState = new Map();   // sessionId -> {n, at}  二次确认用

function memFilter(ev, userId, isGroup) {
  return {
    groupId: isGroup ? String(ev.group_id) : null,
    userId: String(userId),
    allowAll: isAdmin(userId),        // 管理员可跨群查看（与既有管理员机制一致）
  };
}

function fmtAgo(ts) {
  if (!ts) return '—';
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  return Math.floor(d / 86400000) + ' 天前';
}

function formatMemList(items, title) {
  if (!items.length) return title + '：还没有记录。';
  const lines = items.map((x, i) => {
    const scope = x.scope === 'group' ? '群' : '个人';
    const conf = x.confidence != null ? ' · 置信 ' + Math.round(x.confidence * 100) + '%' : '';
    return `${i + 1}. 【${scope}】${x.content}\n   来源 ${x.source || '-'} · ${fmtAgo(x.updatedAt || x.createdAt)}${conf}`;
  });
  return `${title}（共 ${items.length} 条）：\n` + lines.join('\n');
}

/**
 * 处理用户指令。返回字符串 = 已处理（回复内容）；返回 null = 不是本模块的命令，交回原流程。
 */
async function handleUserCommand(text, ctx) {
  const t = String(text || '').trim();
  if (!t || t.charAt(0) !== '/') return null;
  const parts = t.split(/\s+/);
  const head = parts[0];
  const userId = ctx.userId;
  const isGroup = !!ctx.isGroup;
  const ev = ctx.ev;

  // ============ 群聊总结 ============
  if (head === '/今日总结' || head === '/昨日总结') {
    const ds = CFG.dailySummary || {};
    if (!isGroup) {
      return '总结要在群里用：切到要总结的那个群，再发 ' + head + '。\n（我只统计自己实际收到的消息，没收到的我也不会瞎编）';
    }
    const gid = String(ev.group_id);
    const date = head === '/今日总结' ? groupLog.todayStr() : groupLog.shiftDate(groupLog.todayStr(), -1);

    const left = dailySummary.cooldownLeftMs(gid);
    if (left > 0) return `刚整理过，${Math.ceil(left / 1000)} 秒后再来，避免刷屏。`;

    // 先给个回执（生成要几秒，避免用户以为没响应）
    await sendSimpleReply(ev, true, userId, `稍等，正在整理 ${date} 的聊天记录…`);
    dailySummary.markRun(gid);
    const r = await dailySummary.buildSummary({
      groupId: gid, date,
      groupName: String(ev.group_name || gid),
      deps: { genText },
    });
    log(`[总结] 群${maskId(gid)} ${date} ok=${r.ok} reason=${r.reason || '-'} 收到${r.stats.total}条/有效${r.stats.useful}条`);
    return r.text;
  }

  // ============ 长期记忆管理 ============
  // 只认白名单里的子命令，避免误劫持将来可能新增的 /记忆xxx 指令
  const MEM_SUBS = ['', '搜索', '删除', '清空', '清空确认', '状态'];
  if (MEM_SUBS.some((s) => head === '/记忆' + s)) {
    const ms = CFG.memoryStore || {};
    if (ms.enabled === false) return '记忆功能已关闭（ai_config.json 里 memoryStore.enabled=false）。';
    const admin = isAdmin(userId);
    const filter = memFilter(ev, userId, isGroup);
    const scopeWord = isGroup ? '本群' : '你的';
    const sub = parts[0].slice('/记忆'.length) || '';
    const kw = parts.slice(1).join(' ').trim();

    // /记忆
    if (!sub) {
      const items = memoryStore.list(filter, 8);
      return formatMemList(items, `${scopeWord}相关记忆`);
    }

    // /记忆搜索 关键词
    if (sub === '搜索') {
      if (!kw) return '用法：/记忆搜索 关键词';
      const items = memoryStore.search(kw, filter, 8);
      return items.length
        ? formatMemList(items, `${scopeWord}中匹配「${kw}」的记忆`)
        : `${scopeWord}里没有匹配「${kw}」的记忆。`;
    }

    // /记忆删除 关键词（二次确认）
    if (sub === '删除') {
      if (!kw) return '用法：/记忆删除 关键词';
      const key = String(ctx.sessionId || userId) + ':del';
      const st = clearConfirmState.get(key);
      const targets = memoryStore.search(kw, filter, 5)
        .filter((x) => (x.scope === 'group' ? admin : String(x.userId) === String(userId)));
      if (!targets.length) return `没找到你有权限删除的、包含「${kw}」的记忆。`;
      if (!st || Date.now() - st.at > 60000 || st.kw !== kw) {
        clearConfirmState.set(key, { kw, at: Date.now() });
        return `将删除 ${targets.length} 条包含「${kw}」的记忆：\n`
          + targets.map((x) => '· ' + x.content).join('\n')
          + '\n\n确认删除请在 1 分钟内再发一次同样的 /记忆删除 ' + kw;
      }
      clearConfirmState.delete(key);
      const r = memoryStore.removeByKeyword(kw, { userId, isAdmin: admin });
      log(`[记忆] 用户${maskId(userId)} 删除「${kw}」${r.removed}条`);
      return `已删除 ${r.removed} 条包含「${kw}」的记忆。`;
    }

    // /记忆清空确认（二次确认）
    if (sub === '清空' || sub === '清空确认') {
      const key = String(ctx.sessionId || userId) + ':clear';
      const st = clearConfirmState.get(key);
      const mine = memoryStore.list({ groupId: filter.groupId, userId, allowAll: false }, 1000)
        .filter((x) => x.scope === 'user' && String(x.userId) === String(userId));
      if (!mine.length) return '你名下没有可清空的记忆。';
      if (!st || Date.now() - st.at > 60000) {
        clearConfirmState.set(key, { at: Date.now() });
        return `将清空你名下的 ${mine.length} 条记忆（不含群级公共记忆）。\n确认请在 1 分钟内再发一次 /记忆清空确认`;
      }
      clearConfirmState.delete(key);
      const r = memoryStore.clear({ userId, isAdmin: false }, { scope: 'user', groupId: filter.groupId, userId: String(userId) });
      log(`[记忆] 用户${maskId(userId)} 清空个人记忆 ${r.removed}条`);
      return `已清空你名下的 ${r.removed} 条记忆。`;
    }

    // /记忆状态
    if (sub === '状态') {
      const st = memoryStore.stats();
      const mine = memoryStore.list({ groupId: filter.groupId, userId, allowAll: false }, 1000)
        .filter((x) => x.scope === 'user' && String(x.userId) === String(userId));
      const gl = groupLog.stats();
      return [
        `【记忆】共 ${st.total} 条（群级 ${st.groupScope} / 个人 ${st.userScope}），已过期 ${st.expired} 条`,
        `存储占用 ${(st.bytes / 1024).toFixed(1)} KB，最近更新 ${fmtAgo(st.latest)}`,
        `上限 ${ms.maxItems || 500} 条 / ${Math.round((ms.maxBytes || 1048576) / 1024)} KB，默认保留 ${ms.defaultTtlDays || 180} 天`,
        `你名下可见 ${mine.length} 条${admin ? '（你是管理员，可查看群级公共记忆）' : ''}`,
        `【群消息归档】${gl.groups} 个群 / ${gl.days} 天 / ${gl.msgs} 条，${(gl.fileBytes / 1024).toFixed(1)} KB，保留 ${ms.retainDays || groupLog.DEFAULTS.retainDays} 天`,
      ].join('\n');
    }

    return '用法：/记忆 | /记忆搜索 关键词 | /记忆删除 关键词 | /记忆清空确认 | /记忆状态';
  }

  // ============ V15.2 群友画像管理（复用既有命令风格）============
  // 白名单子命令，避免误劫持将来可能新增的 /画像xxx 指令
  // 隐私：默认只能看/清自己的画像；看别人需管理员；默认不向群内公开。
  const PROF_SUBS = ['', '清空', '清空确认', '状态'];
  if (PROF_SUBS.some((s) => head === '/画像' + s)) {
    const gp = CFG.groupProfile || {};
    if (gp.enabled !== true) return '群友画像功能已关闭（ai_config.json 里 groupProfile.enabled=true 才启用）。';
    if (!isGroup) return '画像按群隔离，请在群聊中使用该命令。';
    const admin = isAdmin(userId);
    const actor = { userId: String(userId), isAdmin: admin };
    const gid = String(ev.group_id);
    const sub = parts[0].slice('/画像'.length) || '';

    // /画像 —— 查看自己的画像
    if (!sub) {
      const v = groupProfile.view({ groupId: gid, userId: String(userId), actor });
      if (!v.ok) return '读取画像失败：' + (v.error || '未知错误');
      if (!v.items.length) return '还没有你的画像。画像只在你明确自述偏好、称呼、兴趣或正在做的事时才会记录，且默认不公开。';
      const lines = v.items.map((x, i) => `${i + 1}. ${x.content}\n   ${x.stated ? '你明确说过' : '系统推测（不确定）'} · ${fmtAgo(x.updatedAt)}`);
      return `你在这个群的画像（共 ${v.items.length} 条，上限 ${v.limits.maxPerUser} 条）：\n` + lines.join('\n');
    }

    // /画像清空确认（二次确认，沿用既有确认机制）
    if (sub === '清空' || sub === '清空确认') {
      const key = String(ctx.sessionId || userId) + ':profclear';
      const st = clearConfirmState.get(key);
      const v = groupProfile.view({ groupId: gid, userId: String(userId), actor });
      if (!v.ok) return '读取画像失败：' + (v.error || '未知错误');
      if (!v.items.length) return '你名下没有可清空的画像。';
      if (!st || Date.now() - st.at > 60000) {
        clearConfirmState.set(key, { at: Date.now() });
        return `将清空你在这个群的 ${v.items.length} 条画像。\n确认请在 1 分钟内再发一次 /画像清空确认`;
      }
      clearConfirmState.delete(key);
      const r = groupProfile.clearProfile({ groupId: gid, userId: String(userId), actor });
      log(`[画像] 用户${maskId(userId)} 清空群${maskId(ev.group_id)}画像 ${r.removed}条`);
      return `已清空 ${r.removed} 条画像。`;
    }

    // /画像状态
    if (sub === '状态') {
      const ps = groupProfile.stats();
      const v = groupProfile.view({ groupId: gid, userId: String(userId), actor });
      return [
        `【画像】${ps.enabled ? '已启用' : '已关闭'}，共 ${ps.total} 条（明确自述 ${ps.stated} / 推测 ${ps.inferred}）`,
        `上限：单人 ${gp.maxPerUser || 12} 条 / 单条 ${gp.maxLen || 60} 字；注入 ${gp.injectLimit || 3} 条 / ${gp.injectChars || 200} 字`,
        `更新最小间隔 ${Math.round((gp.minIntervalMs || 600000) / 60000)} 分钟，推测类需 ${gp.minSamples || 3} 条样本，保留 ${gp.ttlDays || 90} 天`,
        `你在这个群可见 ${v.ok ? v.items.length : 0} 条${admin ? '（你是管理员）' : ''}`,
        '不推断敏感属性（年龄/性别/婚恋/健康/宗教/政治/收入/住址等一律不记录）；默认不向群内公开。',
      ].join('\n');
    }

    return '用法：/画像 | /画像清空确认 | /画像状态';
  }

  return null;
}

async function handleAiCommand(text, ctx) {
  const parts = String(text).trim().split(/\s+/);
  const sub = (parts[1] || '').toLowerCase();
  if (sub === 'mode') {
    const m = (parts[2] || '').toLowerCase();
    if (AI_MODES.includes(m)) {
      AI_MODE = m;
      const desc = {
        chat: '纯聊天，工具全关（最省）',
        enhanced: '全部工具 + 全量上下文（V11 完整体验）',
        economy: '省 Token：少上下文 + 工具按需 + 复杂仍用 reasoning',
        normal: '保持 V11 完整体验（全部工具）',
      }[m];
      return `已切到 ${m} 模式：${desc}。`;
    }
    return '用法：/ai mode chat | enhanced | economy | normal';
  }
  if (sub === 'status') {
    return `模式=${AI_MODE} | 群策略=${CFG.group.mode} | Judge=${judgeEnabled() ? '开(' + CFG.judge.model + ')' : '关'}` +
      ` | 模型 fast/normal/reasoning=${CFG.model.fast}/${CFG.model.normal}/${CFG.model.reasoning} | 摘要=${CFG.summary.enabled ? '开' : '关'}` +
      `\n预算=${CFG.budget && CFG.budget.enabled ? '开(上限' + (CFG.budget.daily_tokens || '?') + '，警告' + (CFG.budget.warn_percent || 80) + '%，硬限' + (CFG.budget.hard_limit ? '是' : '否') + ')' : '关(默认)'}` +
      `\n暂停自动回复=${RUNTIME_PAUSED ? '是' : '否'} | 临时心情=${RUNTIME_MOOD ? '已设置' : '无'} | 戳一戳=${CFG.poke && CFG.poke.enabled ? '开' : '关'} | 生图=${CFG.image && CFG.image.enabled ? '开' : '关'}` +
      `\n${statsLine()}`;
  }
  if (sub === 'budget') {
    const b = CFG.budget || {};
    const now = stats.totalTokens;
    const lim = Number(b.daily_tokens) || 0;
    const pct = lim ? Math.round((now / lim) * 100) : 0;
    if (!b.enabled) return `预算系统当前未启用（ai_config.json 里 budget.enabled=false）。\n今日已用 ${now} token。`;
    return `预算系统：已启用\n上限=${lim} token/天 | 今日已用=${now}（${pct}%） | 警告线=${(b.warn_percent || 80)}% | 硬限=${(b.hard_limit ? '开(达上限后停止回复)' : '关(仅警告)')}`;
  }
  if (sub === 'stats' || sub === 'usage') {
    const hit = stats.cacheHitTokens, miss = stats.cacheMissTokens;
    const rate = hit + miss > 0 ? Math.round((hit / (hit + miss)) * 100) : 0;
    let line = `【今日用量】\n总Token=${stats.totalTokens} 输入=${stats.promptTokens} 输出=${stats.completionTokens} 推理=${stats.reasoningTokens} 缓存命中率=${rate}%\n`;
    line += `API请求=${stats.requests} | 错误=${stats.errors} | 避免调用=${stats.modelCallsAvoided}（其中L0拦截=${stats.l0Blocked}）\n`;
    line += `分账 → Judge=${stats.judgeRequests}次(${stats.judgePromptTokens + stats.judgeCompletionTokens}) Answer=${stats.answerRequests}次(${stats.answerPromptTokens + stats.answerCompletionTokens}) Tool执行=${stats.toolCalls}次\n`;
    if (stats.modelUsage && Object.keys(stats.modelUsage).length) {
      line += '模型分账：\n';
      for (const [m, u] of Object.entries(stats.modelUsage)) line += `  ${m}: ${u.calls}次 / ${u.tokens}token\n`;
    }
    return line;
  }
  if (sub === 'group') {
    const v = (parts[2] || '').toLowerCase();
    if (v === 'on' || v === 'off') {
      CFG.group.allow = (v === 'on');
      return `已${v === 'on' ? '开启' : '关闭'}群聊回复（运行时不落盘，重启后回到配置值）。`;
    }
    // 群管只读查询：权限/启用/参数/接口状态全部在模块内校验，这里只做路由与格式化
    return await runGroupCommand(groupAdmin, text, ctx);
  }
  if (sub === 'pause') {
    RUNTIME_PAUSED = true;
    return '已暂停自动回复（所有群/私聊不再自动说话）。管理员仍可下发 /ai 命令；/ai resume 恢复。';
  }
  if (sub === 'resume') {
    RUNTIME_PAUSED = false;
    return '已恢复自动回复。';
  }
  if (sub === 'at') {
    const v = (parts[2] || '').toLowerCase();
    if (v !== 'on' && v !== 'off') return '用法：/ai at on | /ai at off';
    CFG.group.requireAt = (v === 'on');
    return `已${v === 'on' ? '开启' : '关闭'}「仅@才回」开关（requireAt=${CFG.group.requireAt}）。注意当前群模式=${CFG.group.mode}，at 模式下关掉此开关也不会主动回未@消息，可用 /ai group on 放开。`;
  }
  if (sub === 'poke') {
    const v = (parts[2] || '').toLowerCase();
    if (v !== 'on' && v !== 'off') return '用法：/ai poke on | /ai poke off';
    if (!CFG.poke) CFG.poke = {};
    CFG.poke.enabled = (v === 'on');
    return `已${v === 'on' ? '开启' : '关闭'}戳一戳回应。`;
  }
  if (sub === 'mood') {
    const arg = parts.slice(2).join(' ').trim();
    if (!arg || arg === 'clear') { RUNTIME_MOOD = ''; return '已清除临时心情/状态。'; }
    RUNTIME_MOOD = arg.slice(0, 200);
    return '已设置临时心情/状态（仅本次运行，重启失效，不落盘）：' + RUNTIME_MOOD;
  }
  if (sub === 'reload') {
    const r = reloadConfig();
    if (!r.ok) return '重载失败：' + (r.error || 'unknown');
    if (!r.changed) return '配置无变化，无需重载。';
    scheduleDailySummary();          // 配置可能改了自动总结开关/时间/白名单，重新排程
    return '已重载 ai_config.json（来源：' + r.from + ' → ' + r.to + '）。运行时改动（暂停/心情/模式）仍保留。';
  }
  if (sub === 'image') {
    const img = CFG.image || {};
    if (!img.enabled) return '生图当前未启用（ai_config.json 里 image.enabled=false）。配好 endpoint/model/apiKey 后即可用。';
    return `生图已启用：endpoint=${img.endpoint} model=${img.model || '(默认)'} size=${img.size || '默认'}。`;
  }
  if (sub === 'help' || !sub) return '可用：/ai mode|status|budget|stats|group|pause|resume|at|poke|mood|reload|image\n群聊总结与记忆：/今日总结 | /昨日总结 | /记忆 | /记忆搜索 词 | /记忆删除 词 | /记忆清空确认 | /记忆状态';
  return '未知命令。可用：/ai mode|status|budget|stats|group|pause|resume|at|poke|mood|reload|image';
}

// ———— 聚合：同群 + 同人 + 连续发送 → 合并成一次请求 ————
const pendingAgg = new Map();

function scheduleAggregate(key, ev, text, imgSegs, decision, grpName) {
  let slot = pendingAgg.get(key);
  if (slot && slot.timer) clearTimeout(slot.timer);
  if (slot) {
    if (text) slot.texts.push(text);
    slot.images.push(...imgSegs);
    slot.lastEv = ev;
    slot.decision = decision;
  } else {
    slot = {
      texts: text ? [text] : [], images: [...imgSegs],
      ev, lastEv: ev, decision, grpName,
    };
    pendingAgg.set(key, slot);
  }
  // @ 消息用更短的窗口，保证响应及时（但仍能合并「连点两下@」）
  const base = Math.max(200, Number(CFG.group.aggregateMs) || 2500);
  const wait = decision.bypassCooldown ? Math.min(base, 900) : base;

  slot.timer = setTimeout(() => {
    pendingAgg.delete(key);
    const merged = slot.texts.filter(Boolean).join(' ').trim();
    const ev2 = slot.lastEv || slot.ev;
    if (slot.texts.length > 1) log(`[聚合] ${key} 合并 ${slot.texts.length} 条 → "${merged.slice(0, 60)}"`);
    decideAndReply(ev2, {
      text: merged, imgSegs: slot.images, grpName: slot.grpName, decision: slot.decision,
    }).catch((e) => log('[异常] 聚合处理失败: ' + e.message));
  }, wait);
}

// ———— 群聊正式回复流程 ————
async function processGroupReply(ev, o) {
  const userId = Number(ev.user_id);
  const rp = extractReply(ev.message);
  const rpTarget = rp ? findBufferedMsg(ev.group_id, rp.id) : null;

  const uKey = 'cu:' + ev.group_id + ':' + userId;
  const gKey = 'cg:' + ev.group_id;
  lastReplyAt.set(uKey, Date.now());
  lastReplyAt.set(gKey, Date.now());

  log(`[收到 群${maskId(ev.group_id)}/${maskId(userId)}] ${(o.text || '').slice(0, 30)}` +
      `${o.imgSegs && o.imgSegs.length ? ' (+' + o.imgSegs.length + '图)' : ''}  规则=${o.decision.reason}`);

  await processReply(ev, {
    sessionId: 'group_' + ev.group_id,
    text: o.text, imgSegs: o.imgSegs, grpName: o.grpName,
    rpTarget, replyId: rp ? rp.id : null, chatId: o.chatId,
    decision: o.decision,
  });
}

// ================= V13.5：QQ 聊天记录解析 + 多模态混合理解 =================
// 仅做“最小增量”：完全不改变任何既有普通消息/图片/视频/Judge 行为。
// 流程：用户主动提交合并转发 → 解析成统一结构并存为“待处理聊天记录”（仅内存）→
//   ① 若同时带了问题（如“总结一下”）→ 立即用 DeepSeek V4.1 Flash 多模态分析；
//   ② 否则 → 仅回执“收到了 N 条记录，需要我做什么？”，等用户后续追问。
// 隐私：聊天记录只存内存（pendingChatRecords），不写长期记忆；明细只记 chatRecordId/计数。

const pendingChatRecords = new Map();   // scopeKey -> { record, at }
const CHAT_RECORD_TTL_MS = 10 * 60 * 1000;

function chatRecordScopeKey(ev) {
  return ev.message_type === 'group' ? ('g' + ev.group_id) : ('p' + ev.user_id);
}

function storePendingChatRecord(scopeKey, record) {
  pendingChatRecords.set(scopeKey, { record, at: Date.now() });
  if (pendingChatRecords.size > 12) {        // 简单 TTL 清理，避免内存无限增长
    const now = Date.now();
    for (const [k, v] of pendingChatRecords) if (now - v.at > CHAT_RECORD_TTL_MS) pendingChatRecords.delete(k);
  }
}

// 判断用户是否想对聊天记录做分析、以及是否要看视频（视频默认不自动分析）
function detectChatRecordIntent(question) {
  const q = String(question || '').toLowerCase();
  if (!q.trim()) return { analyze: false, video: false };
  const videoKw = /(分析|看|讲|说|读|解析).{0,4}视频|视频.{0,4}(说|讲|内容|里|中|啥|什么)|视频关键帧/;
  const analyzeKw = /(总结|概括|归纳|梳理|提炼|分析|讲讲|讲一下|说说|解读|翻译|提取|帮我看|看看|这(段|个|些)?聊天|聊了什么|说了什么|什么内容|什么梗|怎么回|怎么回复|帮我回|拟个|写个回复|回复(她|他|你)|怎么接|怎么回她|怎么回他)/;
  const atDeepseek = /@deepseek|deepseek/.test(q);
  return { analyze: !!(analyzeKw.test(q) || atDeepseek), video: !!videoKw.test(q) };
}

async function sendChatRecordReply(ev, isGroup, text) {
  const out = [{ type: 'text', data: { text } }];
  try {
    if (isGroup) {
      out.unshift({ type: 'at', data: { qq: String(ev.user_id) } });
      if (ev.message_id != null) out.unshift({ type: 'reply', data: { id: String(ev.message_id) } });
      await napcatCall('send_group_msg', { group_id: ev.group_id, message: out });
    } else {
      if (ev.message_id != null) out.unshift({ type: 'reply', data: { id: String(ev.message_id) } });
      await napcatCall('send_private_msg', { user_id: ev.user_id, message: out });
    }
    stats.replies++; saveStats();
  } catch (e) {
    log('[聊天记录] 回复发送失败: ' + e.message);
  }
}

// 聊天记录分析主流程：组装多模态 parts → 调 DeepSeek V4.1 Flash → 记账 → 回执
async function analyzeChatRecord(ev, record, question, o) {
  o = o || {};
  const isGroup = ev.message_type === 'group';
  const userId = Number(ev.user_id);
  const sessionId = isGroup ? ('group_' + ev.group_id) : ('private_' + userId);
  const chatId = genChatId((isGroup ? 'g' : 'p') + (isGroup ? ev.group_id : userId) + ':cr');
  const model = (CFG.model && CFG.model.flash) || CFG.api.model || CFG.judge.model || 'deepseek-chat';   // 多模态：优先 flash 配置，否则用全局模型（修复硬编码 deepseek-flash 与全局不符）

  const t0 = Date.now();
  let imageCount = 0, imageOK = 0, imageFail = 0;
  let parts;
  try {
    const r = await chatRecordParser.buildMultimodalParts(record, question, {
      fetchImageBytes: (ref) => fetchImageAsBase64({ type: 'image', data: { file: ref.file, url: ref.url, file_id: ref.file } }),
      analyzeVideos: false,
    });
    parts = r.parts; imageCount = r.imageCount; imageOK = r.imageOK; imageFail = r.imageFail;
  } catch (e) {
    log('[聊天记录] 组装 parts 失败: ' + e.message);
    await sendChatRecordReply(ev, isGroup, '聊天记录组装失败：' + e.message.slice(0, 60));
    return;
  }
  log(`[聊天记录] 分析 ${record.chatRecordId} 消息=${record.counts.messages} 图=${imageCount} 成功=${imageOK} 失败=${imageFail} 模型=${model}`);

  let res;
  try {
    res = await askDeepSeek(sessionId, parts, ev, {
      model, chatId, allowTools: false, skipGroupContext: true,
      kind: 'chatrecord', extra: { chatRecordId: record.chatRecordId },
    });
  } catch (e) {
    log('[聊天记录] 带图分析失败，尝试纯文本回退: ' + e.message);
    // 看图接口慢/超时等导致整段失败：剥离图片段，用纯文本再试一次
    const textOnly = parts.filter((p) => p.type !== 'image_url');
    if (textOnly.length === parts.length) {
      stats.errors++; saveStats();
      await sendChatRecordReply(ev, isGroup, '这段聊天记录我分析时卡住了（看图接口有点慢/超时），稍等一两分钟再让我总结试试？');
      return;
    }
    try {
      res = await askDeepSeek(sessionId, textOnly, ev, {
        model, chatId, allowTools: false, skipGroupContext: true,
        kind: 'chatrecord', extra: { chatRecordId: record.chatRecordId, imageFallback: true },
      });
    } catch (e2) {
      log('[聊天记录] 纯文本回退也失败: ' + e2.message);
      stats.errors++; saveStats();
      await sendChatRecordReply(ev, isGroup, '这段聊天记录我分析时卡住了（看图接口有点慢/超时），稍等一两分钟再让我总结试试？');
      return;
    }
  }
  const replyText = (res && res.text) || '';
  if (!replyText) { log('[聊天记录] 空回复'); return; }

  const out = [{ type: 'text', data: { text: replyText } }];
  if (isGroup) {
    out.unshift({ type: 'at', data: { qq: String(userId) } });
    if (ev.message_id != null) out.unshift({ type: 'reply', data: { id: String(ev.message_id) } });
    await napcatCall('send_group_msg', { group_id: ev.group_id, message: out });
  } else {
    if (ev.message_id != null) out.unshift({ type: 'reply', data: { id: String(ev.message_id) } });
    await napcatCall('send_private_msg', { user_id: userId, message: out });
  }
  stats.replies++; saveStats();

  // 明细：仅记 chatRecordId/计数/耗时/模型，不记聊天内容（隐私合规）
  try {
    const line = {
      time: new Date().toISOString(),
      chatRecordId: record.chatRecordId,
      scope: (isGroup ? ('g' + ev.group_id) : ('p' + userId)),
      question: String(question || '').slice(0, 80),
      model,
      message_count: record.counts.messages,
      image_count: record.counts.images,
      video_count: record.counts.videos,
      images_sent: imageOK,
      processing_time_ms: Date.now() - t0,
    };
    const cf = path.join(USAGE_DIR, 'chatrecord.' + new Date().toISOString().slice(0, 10) + '.jsonl');
    if (!fs.existsSync(USAGE_DIR)) fs.mkdirSync(USAGE_DIR, { recursive: true });
    fs.appendFileSync(cf, JSON.stringify(line) + '\n', 'utf-8');
  } catch (e) {}

  // 聚合统计（不记内容）
  stats.chatRecordAnalyses++;
  stats.chatRecordMessages += record.counts.messages || 0;
  stats.chatRecordImages += record.counts.images || 0;
  stats.chatRecordVideos += record.counts.videos || 0;
  saveStats();

  finalizeChat(chatId, { type: 'chatrecord', scope: (isGroup ? ('g' + ev.group_id) : ('p' + userId)), preview: String(question || '').slice(0, 24) });
}

// 入口：检测合并转发 → 解析 → 存待处理 → 分析或回执
// 调用方保证：仅在“确实对着机器人说”时调用（群内需 @/回复机器人）。返回 true=已消费该消息。
async function handleChatRecord(ev, msgSegs, question, o) {
  o = o || {};
  const fwdSegs = chatRecordParser.detectForwardSegments(msgSegs);
  if (!fwdSegs.length) return false;

  const seg = fwdSegs[0];
  const scopeKey = chatRecordScopeKey(ev);

  let record;
  try {
    record = await chatRecordParser.buildChatRecord({
      id: seg.id, summary: seg.summary, source: seg.source, prompt: seg.prompt, content: seg.content,
      getForwardMsg: async (id) => {
        const r = await napcatCall('get_forward_msg', { id });
        return (r && r.data && Array.isArray(r.data.messages)) ? r.data.messages : [];
      },
    });
  } catch (e) {
    log('[聊天记录] 解析异常: ' + e.message);
    record = { type: 'chat_record', error: 'exception', messages: [], counts: { messages: 0, images: 0, videos: 0, textChars: 0 } };
  }

  // 拉取/解析失败：提示（仅在确实对着机器人说时，避免群里刷屏）
  if (record.error || !record.messages || !record.messages.length) {
    const botDirected = o.isGroup ? (o.decision && (o.decision.reply || o.decision.needsJudge)) : true;
    if (botDirected) {
      const msg = (String(question || '').trim())
        ? '这条合并转发我暂时拉不到内容（可能已过期、来自不可读取的来源，或不是标准聊天记录）。换个转发试试？'
        : '收到一条合并转发，但里面没有可解析的聊天内容（可能已过期或来源受限）。';
      await sendChatRecordReply(ev, o.isGroup, msg);
    }
    return true;
  }

  // 解析成功：存为待处理（供后续追问复用，不写长期记忆）
  storePendingChatRecord(scopeKey, record);

  const intent = detectChatRecordIntent(question);
  if (intent.analyze) {
    await analyzeChatRecord(ev, record, question, o);
    return true;
  }

  // 仅提交、没带问题 → 回执 + 操作提示
  const c = record.counts || {};
  const tip = `收到聊天记录（${c.messages || 0} 条消息，含 ${c.images || 0} 张图、${c.videos || 0} 个视频）。需要我做什么？直接说，例如：\n· 总结一下\n· 说了什么 / 聊了什么\n· 分析这个视频\n· 帮我回一句`;
  await sendChatRecordReply(ev, o.isGroup, tip);
  return true;
}

// ================= 聊天记录「追问」拦截（修复：AI 只总结群聊不看记录）=================
// 现象：先转发聊天记录（bot 已存为 pending 并回执），再单独发「总结一下 / 说了什么」时，
// 这条追问没有 forward 段，会落到普通回复/Agent 的 chat_record_analysis 工具；
// 而该工具不会把记录正文注入模型，导致 AI 用群上下文（"上面发的东西"）作答，根本没读记录。
// 修复：本消息无转发段、但本会话 10 分钟内收到过记录、且这句话像在问记录 →
// 直接拉出 pending 记录走 analyzeChatRecord（完整拼记录正文 + skipGroupContext），绕过 Agent。
async function maybeHandlePendingChatRecordQuestion(ev, msgSegs, question, o) {
  if (msgSegs.some((s) => s && s.type === 'forward')) return false; // 同消息带转发由 handleChatRecord 处理
  const scopeKey = chatRecordScopeKey(ev);
  if (!hasPendingChatRecord(scopeKey)) return false;
  if (!detectChatRecordIntent(question).analyze) return false;
  const rec = getPendingChatRecordForAgent({
    isGroup: ev.message_type === 'group',
    groupId: ev.group_id,
    userId: ev.user_id,
  });
  if (!rec || !Array.isArray(rec.messages) || !rec.messages.length) return false;
  await analyzeChatRecord(ev, rec, question, o);
  return true;
}

// ================= V13.6：群内「先发图、再问」修复 =================
// 群里发纯图片（无文字、没@）时，shouldReplyGroup 只看文字 → 判定 normal-chat → 被静默丢弃，
// 于是用户「先发图、再问这个怎么做」时图已经没了，AI 只能答“看不到图”。
// 解法：只缓存图片段引用（file/url，不缓存字节），等用户真正 @/提到机器人时再附上。
// 不因此增加任何主动回复（仍然保持「宁愿少回复」原则）。
const pendingGroupImages = new Map();   // key -> { segs:[...], at }
// 5 分钟：除了「先发图、再问」，还要覆盖「AI 画完图 → 用户过一会儿吐槽」的场景
const PENDING_IMAGE_TTL_MS = 300000;
// 最多记住最近几张图：支持「先发 p1、再发 p2、再打字说换成 p1 的脸」这类多图 / 连续图生图场景
const PENDING_IMAGE_MAX = 6;

function _pendKey(groupId, userId) {
  return groupId ? ('g' + groupId + ':' + userId) : ('p:' + userId);
}

// 累积最近发过的图（而非覆盖单张）。atFront=true 时把新图放到最前（source="1" 即最新一张，
// 主要用于「AI 刚画完 → 用户说再改成X」时，让 source=1 指向刚画好的那张）。
function storePendingGroupImages(groupId, userId, segs, atFront) {
  if (!segs || !segs.length) return;
  const k = _pendKey(groupId, userId);
  const cur = pendingGroupImages.get(k) || { segs: [], at: Date.now() };
  const norm = (s) => (s && s.data && (s.data.file || s.data.url)) || '';
  const seen = new Set(cur.segs.map(norm));
  const add = [];
  for (const s of segs.slice(0, MAX_IMAGES)) {
    const id = norm(s);
    if (id && seen.has(id)) continue;          // 去重：同一张图不反复进历史
    add.push(s);
    seen.add(id);
  }
  cur.segs = atFront ? add.concat(cur.segs) : cur.segs.concat(add);
  if (cur.segs.length > PENDING_IMAGE_MAX) {
    cur.segs = cur.segs.slice(cur.segs.length - PENDING_IMAGE_MAX);  // 保留最新的，丢掉最旧的
  }
  cur.at = Date.now();
  pendingGroupImages.set(k, cur);
  if (pendingGroupImages.size > 80) {          // 容量兜底：顺带清理过期项
    const now = Date.now();
    for (const [kk, v] of pendingGroupImages) if (now - v.at > PENDING_IMAGE_TTL_MS) pendingGroupImages.delete(kk);
  }
}

function takePendingGroupImages(groupId, userId) {
  const k = _pendKey(groupId, userId);
  const v = pendingGroupImages.get(k);
  if (!v) return [];
  pendingGroupImages.delete(k);                // 取走即清，不被重复使用
  return (Date.now() - v.at <= PENDING_IMAGE_TTL_MS) ? v.segs.slice() : [];
}

// 不删除地查看最近记住的图（融合时需要「同时看到两张」，不能取走即删）
function peekPendingImages(groupId, userId) {
  const k = _pendKey(groupId, userId);
  const v = pendingGroupImages.get(k);
  if (!v) return [];
  return (Date.now() - v.at <= PENDING_IMAGE_TTL_MS) ? v.segs.slice() : [];
}

async function handleMessage(ev) {
  const msgType = ev.message_type;
  const userId = Number(ev.user_id);
  const selfId = ev.self_id;
  const mid = ev.message_id;

  if (mid != null) {
    const k = String(mid);
    if (seenIds.has(k)) return;
    seenIds.add(k);
    if (seenIds.size > 500) seenIds.clear();
  }

  if (BLOCKED_QQ.includes(userId)) { log('[拉黑] ' + userId); return; }
  if (userId === Number(selfId)) return;

  // 全局暂停：非管理员的所有消息一律不自动回复（管理员仍可下发 /ai 命令恢复）
  if (RUNTIME_PAUSED && !isAdmin(userId)) return;

  // 临时调试：打印原始事件（默认关，仅用于确认字段结构）
  if (CFG.debug.rawEvent) log('[RAW] ' + redact(JSON.stringify(ev).slice(0, 1000)));

  const rawMsg = ev.message;
  let msgSegs = segments(rawMsg);
  let text = extractText(rawMsg);
  const imgSegs = msgSegs.filter((s) => s?.type === 'image');
  // V14-C.2 修复 A：QQ 分享卡片是 json/xml 段、没有 text 段，以前会在这里被当「空消息」静默丢弃。
  // 这里先做一次受控提取（只取标题/摘要/URL，长度受限），再走下面的空消息判断。
  let fromShareCard = false;
  if (!text) {
    const cardText = extractShareCard(msgSegs);
    if (cardText) { text = cardText; fromShareCard = true; }
  }
  // V14-B 修复：QQ 里「纯合并转发」通常不带任何文字，以前会在这一行被静默丢弃，
  // 导致聊天记录功能在真实场景里根本触发不了（只有转发+文字同时存在时才work）。
  const hasForwardSeg = msgSegs.some((s) => s && s.type === 'forward');
  if (!text && imgSegs.length === 0 && !hasForwardSeg) {
    logDrop((msgType === 'group' ? ('群' + maskId(ev.group_id)) : ('私聊' + maskId(userId))),
      '入口', '无可处理内容', msgSegs.map((s) => s && s.type).join(','));
    return;
  }

  // ================= 群聊 =================
  if (msgType === 'group') {
    if (!CFG.group.allow) return;

    const atMe = isAtMe(rawMsg, selfId);
    const rp = extractReply(rawMsg);
    const rpTarget = rp ? findBufferedMsg(ev.group_id, rp.id) : null;
    const grpName = await getGroupName(ev.group_id, ev.group_name);

    // ① 无条件记录进本地环形缓冲（不管是否回复，低成本）+ 累计触发摘要
    pushGroupBuffer(ev.group_id, {
      id: mid, uid: String(userId), name: senderName(ev),
      text: text || (imgSegs.length ? '[图片]' : ''), time: Date.now(),
      atMe, isBot: false, replyTo: rp ? rp.id : null,
    });
    maybeSummarize(ev.group_id);
    // 群消息按天归档（每日总结的数据源）。只归档群成员的真实文字消息，失败不影响聊天。
    if (CFG.groupArchive && CFG.groupArchive.enabled !== false && text) {
      groupLog.archive(ev.group_id, {
        messageId: mid, uid: String(userId), name: senderName(ev), text, time: Date.now(),
      });
    }

    // V15.2：群友轻量画像观察（**默认关闭**；纯本地规则、零模型调用）。
    //   失败绝不影响聊天主流程；画像以「群号+QQ号」隔离，不跨群/跨成员混用。
    if (CFG.groupProfile && CFG.groupProfile.enabled === true && text) {
      try {
        groupProfile.observe({ groupId: ev.group_id, userId, text });
      } catch (e) {
        log('[画像] 观察失败（已忽略）: ' + String((e && e.message) || e).slice(0, 60));
      }
    }

    // V13.6：缓存本条图片引用（放在预筛之前，纯图片消息即使被丢弃也能留住）
    if (imgSegs.length) storePendingGroupImages(ev.group_id, userId, imgSegs);

    // ①.5 用户指令（/今日总结 /昨日总结 /记忆…）：**放在预筛之前**，命令不必 @ 也能用。
    //     都是只读或本人范围内的操作，且总结命令自带限频与二次确认。
    if (text && text.charAt(0) === '/') {
      const r = await handleUserCommand(text, {
        userId, ev, isGroup: true, sessionId: 'group_' + ev.group_id,
      });
      if (r != null) {
        log(`[命令] 群${maskId(ev.group_id)} 用户${maskId(userId)}: ${text.slice(0, 24)} → ${String(r).slice(0, 50)}`);
        await sendSimpleReply(ev, true, userId, r);
        return;
      }
    }

    // ② 本地规则预筛（全程 0 次 API 调用）
    let decision = shouldReplyGroup(ev, text, {
      reply: { isToBot: !!(rpTarget && rpTarget.isBot) },
      requireAt: !!CFG.group.requireAt,
    });

    // ②b V15.2 群聊智能决策（默认关闭；纯本地复核，不新增模型调用）
    //     在既有判定之后做一次廉价复核：避免重复回答已解决的问题、避免对未成句抢答。
    //     高优先级（@ / 回复机器人 / 聊天记录 / 明确提问）由 review() 保证不被降级。
    let gdReview = null;
    if (CFG.groupDecision && CFG.groupDecision.enabled === true) {
      try {
        gdReview = groupDecision.review({
          text,
          buffer: getGroupBuffer(ev.group_id),
          decision,
          isGroup: true,
          cfg: CFG.groupDecision,
        });
        if (gdReview.changed && gdReview.action === 'drop') {
          recordAvoided('gd-dup'); logDrop('群' + maskId(ev.group_id), '群智决', '已回答过: ' + (gdReview.reason || ''));
          return;
        }
        if (gdReview.changed && gdReview.action === 'defer') {
          // 未成句：不抢答，交给既有聚合窗口（与同人连发合并）后续再判
          decision = { reply: false, needsJudge: false, reason: 'gd-defer', bypassCooldown: false, deferToAggregator: true };
        }
      } catch (e) {
        log('[群智决] 复核异常（已忽略，保持原行为）: ' + String((e && e.message) || e).slice(0, 60));
      }
    }

    // 「立即行动」模式：群里每条消息都回（仍保留 @ 强制放行、冷却与聚合）
    if (CFG.group.mode === 'all' && !decision.deferToAggregator) {
      decision = { reply: true, needsJudge: false, reason: 'all', bypassCooldown: atMe };
    } else if (CFG.group.mode === 'at') {
      // 兼容旧模式：mode='at' 时退回「仅@才回」；但合并转发（聊天记录）一律视为对着机器人，不需要 @
      if (!atMe && !hasForwardSeg) { recordAvoided('l0'); logDrop('群' + maskId(ev.group_id), '群预筛', '未@我'); return; }
    } else if (!decision.reply && !decision.needsJudge && !decision.deferToAggregator) {
      recordAvoided('l0'); logDrop('群' + maskId(ev.group_id), '群预筛', decision.reason || 'normal-chat'); return;
    }

    // 合并转发（聊天记录）：强制当作 bot-directed，跳过 @/冷却/聚合。
    // 否则在 at 模式下，用户转发聊天记录但没 @ 机器人时会被静默丢弃，表现为「聊天记录加载不出来」。
    if (hasForwardSeg) {
      decision = { reply: true, needsJudge: false, reason: 'chat-record', bypassCooldown: true };
    }

    // ③ 冷却（@ 不受冷却限制，直接放行）
    if (!decision.bypassCooldown) {
      const now = Date.now();
      const uCd = Number(CFG.group.userCooldownMs) || 0;
      const gCd = Number(CFG.group.cooldownMs) || 0;
      const uHit = now - (lastReplyAt.get('cu:' + ev.group_id + ':' + userId) || 0) < uCd;
      const gHit = now - (lastReplyAt.get('cg:' + ev.group_id) || 0) < gCd;
      if (uHit || gHit) { log('[冷却跳过] 群' + ev.group_id + '/' + userId); return; }
    }

    // ============ crypto-sim 行情分析接入（群）============
    const cryptoReply = await tryCryptoAnalysis(text);
    if (cryptoReply) {
      lastReplyAt.set('cg:' + ev.group_id, Date.now());
      lastReplyAt.set('cu:' + ev.group_id + ':' + userId, Date.now());
      await napcatCall('send_group_msg', { group_id: ev.group_id, message: [{ type: 'text', data: { text: cryptoReply } }] });
      return;
    }

    // 生图意图（群）：V14-D 起优先交给 Agent 的 generate_image（AI 自己决定画什么 / 是否图生图），
    // 老正则路径只作兜底（Agent 不可用、工具没注册、或配置关掉 agentFirst）
    if (!genByAgent() && (isImageGenIntent(text) || isImg2ImgIntent(text, imgSegs.length))) {
      if (await handleImageGen(text, ev, { isGroup: true, userId, imgSegs })) return;
    }

    // V13.5：合并转发（聊天记录）处理（仅 @/回复机器人 等 bot-directed 才会走到这里）
    if (msgSegs.some((s) => s && s.type === 'forward')) {
      const handled = await handleChatRecord(ev, msgSegs, text, { isGroup: true, grpName, decision });
      if (handled) return;
    }

    // 聊天记录「追问」拦截：先转发、再单独问（如「总结一下」）→ 直接分析 pending 记录，绕过 Agent
    if (await maybeHandlePendingChatRecordQuestion(ev, msgSegs, text, { isGroup: true, grpName, decision })) return;

    // ④ 聚合（带图片就不聚合，直接处理）
    const aggMs = Number(CFG.group.aggregateMs) || 0;
    const pureText = extractText(stripAt(msgSegs));
    // V15.2：智能决策判定为"未成句→建议等待"时，也走聚合窗口 ——
    //   等同一发言人的后续消息合并后，由 decideAndReply 重新判定，避免抢答半句话。
    if ((aggMs > 0 || decision.deferToAggregator) && imgSegs.length === 0 && pureText) {
      // V13.6：把缓冲里的图带进聚合请求（群里「先发图、再打字问」）
      scheduleAggregate('g' + ev.group_id + ':' + userId, ev, pureText, takePendingGroupImages(ev.group_id, userId), decision, grpName);
      return;
    }

    // V13.6 + 图生图记忆：本条带图就用本条；本条没图但最近发过图（含多张）→ 把最近几张一起带过去。
    // 注意：以前是「带图即删 pending」，导致用户发完底图、再打字说「改成X」时图生图抓不到图
    // （报“这条消息里没有图”），多图换脸更是只剩最后一张。现在不再删除，历史会留到下一次取用或过期，
    // 支持「先发 p1、再发 p2、再打字说换成 p1 的脸」这类多图 / 连续图生图场景。
    let useImgs = imgSegs.slice();
    if (!useImgs.length) useImgs = takePendingGroupImages(ev.group_id, userId);

    await decideAndReply(ev, { text: pureText || text, imgSegs: useImgs, grpName, decision });
    return;
  }

  // ================= 私聊（保持原有行为，仅冷却走配置）=================
  if (!CFG.private.allow) return;

  // 管理员命令：仅私聊 + 仅管理员，命中即处理并结束（不进 AI 流程）
  if (isAdmin(userId) && text && text.startsWith('/ai')) {
    const r = await handleAiCommand(text, { userId, selfId });
    log(`[命令] 管理员 ${userId}: ${text} → ${String(r).slice(0, 60)}`);
    await napcatCall('send_private_msg', { user_id: userId, message: [{ type: 'text', data: { text: r } }] });
    return;
  }

  // 用户指令（/记忆 等）：私聊里同样可用，作用于「你自己的记忆」（跨群）
  if (text && text.charAt(0) === '/' && !text.startsWith('/ai')) {
    const r = await handleUserCommand(text, {
      userId, ev, isGroup: false, sessionId: 'private_' + userId,
    });
    if (r != null) {
      log(`[命令] 私聊用户${maskId(userId)}: ${text.slice(0, 24)} → ${String(r).slice(0, 50)}`);
      await napcatCall('send_private_msg', { user_id: userId, message: [{ type: 'text', data: { text: r } }] });
      return;
    }
  }

  // ============ crypto-sim 行情分析接入（私聊）============
  const cryptoReplyP = await tryCryptoAnalysis(text);
  if (cryptoReplyP) {
    lastReplyAt.set('cp:' + userId, Date.now());
    await napcatCall('send_private_msg', { user_id: userId, message: [{ type: 'text', data: { text: cryptoReplyP } }] });
    return;
  }

  // 生图意图（私聊）：V14-D 起同样优先交给 Agent 的 generate_image
  if (!genByAgent() && (isImageGenIntent(text) || isImg2ImgIntent(text, imgSegs.length))) {
    if (await handleImageGen(text, ev, { isGroup: false, userId, imgSegs })) return;
  }

  // V13.5：合并转发（聊天记录）处理（私聊一律视为对着机器人）
  if (msgSegs.some((s) => s && s.type === 'forward')) {
    const handled = await handleChatRecord(ev, msgSegs, text, { isGroup: false, grpName: '', decision: { reply: true } });
    if (handled) return;
  }

  // 聊天记录「追问」拦截：先转发、再单独问 → 直接分析 pending 记录，绕过 Agent
  if (await maybeHandlePendingChatRecordQuestion(ev, msgSegs, text, { isGroup: false, grpName: '', decision: { reply: true } })) return;

  const pKey = 'cp:' + userId;
  const pCd = Number(CFG.private.cooldownMs) || 0;
  if (Date.now() - (lastReplyAt.get(pKey) || 0) < pCd) { log('[冷却跳过] 私聊' + userId); return; }

  log(`[收到 私聊${maskId(userId)}] 段=[${msgSegs.map((s) => s && s.type).join(',')}]`
    + ` 卡片=${fromShareCard ? 1 : 0} 有URL=${/https?:\/\//i.test(text) ? 1 : 0}`
    + ` 预览=${text.slice(0, 30)}${imgSegs.length ? ' (+' + imgSegs.length + '图)' : ''}`);
  // 私聊同样缓存最近发的图，支持「先发图、再打字说改成X」的图生图记忆
  // （之前私聊完全没这条路，跨消息图生图必失败 → “记不住图”）
  if (imgSegs.length) storePendingGroupImages(null, userId, imgSegs);
  let privImgs = imgSegs.slice();
  if (!privImgs.length) privImgs = takePendingGroupImages(null, userId);

  const chatId = genChatId('p' + userId);
  await processReply(ev, {
    sessionId: 'private_' + userId,
    text, imgSegs: privImgs, grpName: '',
    chatId,
  });
  finalizeChat(chatId, { type: 'private', scope: String(userId), preview: text });
  lastReplyAt.set(pKey, Date.now());
}

// ============ crypto-sim 行情分析接入（配置开关，默认关；需 crypto-sim 服务端在跑）============
// 群/私聊命中行情关键词或命令前缀时，本地 HTTP 调 crypto-sim 的 /api/analyze，
// 拿到中文分析后由调用方直接回复；服务未启动/超时则 return null，回落普通 AI 流程（不拦截、不报错）。
const CRYPTO_COINS = ['btc','eth','sol','bnb','doge','xrp','ada','ton','etc','ltc','trx','link','dot','avax','matic','arb','op','near','apt','sui','pepe','shib'];
const CRYPTO_CN = { '比特币':'BTC','以太坊':'ETH','以太':'ETH','狗狗币':'DOGE','狗狗':'DOGE','索拉纳':'SOL','solana':'SOL' };
const CRYPTO_KW = /行情|分析一下|分析下|走势|合约分析|技术面|点位|做多还是做空|看多看空|该不该买|能不能买|要不要上车|抄底|逃顶|能买吗|值得买|还会涨|还会跌|能涨吗|会跌吗/;
const CRYPTO_CMD = /^\s*!(c|行情|币)\b/i;
const CRYPTO_COIN_RE = new RegExp('\\b(' + CRYPTO_COINS.join('|') + ')\\b', 'i');

function cryptoNormSymbol(s) {
  let x = (s || '').toUpperCase();
  if (!x.endsWith('USDT')) x = x + 'USDT';
  return x;
}

async function tryCryptoAnalysis(rawText) {
  const C = CFG.crypto;
  if (!C || !C.enabled) return null;
  const t = (rawText || '').toLowerCase();
  if (!t.trim()) return null;

  const cmd = t.match(CRYPTO_CMD);
  let symbol = null;
  if (cmd) {
    const rest = t.replace(CRYPTO_CMD, '').trim();
    const m = rest.match(CRYPTO_COIN_RE);
    if (m) symbol = m[1].toUpperCase();
  }
  if (!symbol) {
    for (const [cn, s] of Object.entries(CRYPTO_CN)) if (t.includes(cn.toLowerCase())) { symbol = s; break; }
  }
  if (!symbol) {
    const m = t.match(CRYPTO_COIN_RE);
    if (m) symbol = m[1].toUpperCase();
  }
  const hasKw = CRYPTO_KW.test(t);
  if (!cmd && !hasKw) return null;            // 无明确意图 → 普通 AI 流程
  if (!symbol) symbol = (C.defaultSymbol || 'BTC').toUpperCase();
  symbol = cryptoNormSymbol(symbol);

  let useAI = !!C.defaultUseAI;
  if (/深度|智能|辩论|多角色|\bai\b/.test(t)) useAI = true;
  if (/纯策略|不用ai|关ai|只要指标/.test(t)) useAI = false;

  const ep = (C.endpoint || 'http://127.0.0.1:8088').replace(/\/+$/, '');
  const iv = C.interval || '4h';
  const url = ep + '/api/analyze?symbol=' + encodeURIComponent(symbol) + '&interval=' + encodeURIComponent(iv) + '&useAI=' + (useAI ? 1 : 0);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(C.timeoutMs) || 15000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !j.text) return null;
    return j.text;                            // 200 且有文本（含服务自报错误说明）即回复
  } catch (e) {
    return null;                              // 服务未启动/超时 → 回落普通 AI
  } finally {
    clearTimeout(timer);
  }
}

// ================= v12：Usage Dashboard（复用本进程 HTTP 服务，不再单独起一个端口）=================
const DASHBOARD_HTML = path.join(__dirname, 'dashboard', 'index.html');

// 列出 memory/usage 下所有按日期命名的明细文件
function listUsageFiles() {
  try {
    return fs.readdirSync(USAGE_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort();
  } catch (e) { return []; }
}

// 按时间范围筛选明细文件（today/yesterday/7d/month/all）
function rangeFiles(range) {
  const files = listUsageFiles();
  const today = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10);
  if (range === 'yesterday') { const y = new Date(today); y.setDate(y.getDate() - 1); return files.filter((f) => f === fmt(y) + '.jsonl'); }
  if (range === 'today') return files.filter((f) => f === fmt(today) + '.jsonl');
  if (range === '7d') {
    const want = [];
    for (let i = 0; i < 7; i++) { const d = new Date(today); d.setDate(d.getDate() - i); want.push(fmt(d) + '.jsonl'); }
    return files.filter((f) => want.includes(f));
  }
  if (range === 'month') { const p = fmt(today).slice(0, 7); return files.filter((f) => f.startsWith(p)); }
  return files; // all
}

// 读取明细 + 聊天聚合，按范围算总量/分账/最近请求/最近聊天（只读，绝不影响主流程）
function buildUsageReport(range) {
  const files = rangeFiles(range);
  const reqs = [];
  const chats = [];
  for (const f of files) {
    try {
      const lines = fs.readFileSync(path.join(USAGE_DIR, f), 'utf-8').split('\n').filter(Boolean);
      for (const l of lines) { try { const o = JSON.parse(l); if (o && typeof o === 'object') reqs.push(o); } catch (e) {} }
    } catch (e) {}
    const cf = path.join(USAGE_DIR, 'chats.' + f);
    try {
      const lines = fs.readFileSync(cf, 'utf-8').split('\n').filter(Boolean);
      for (const l of lines) { try { const o = JSON.parse(l); if (o && typeof o === 'object') chats.push(o); } catch (e) {} }
    } catch (e) {}
  }

  const modelUsage = {};
  let total = 0, prompt = 0, completion = 0, reasoning = 0, cacheHit = 0, cacheMiss = 0;
  let judge = 0, answer = 0, tool = 0, chatrecord = 0, chatRecordTokens = 0;
  for (const r of reqs) {
    total += Number(r.total_tokens) || 0;
    prompt += Number(r.prompt_tokens) || 0;
    completion += Number(r.completion_tokens) || 0;
    reasoning += Number(r.reasoning_tokens) || 0;
    cacheHit += Number(r.cache_hit_tokens) || 0;
    cacheMiss += Number(r.cache_miss_tokens) || 0;
    if (r.kind === 'judge') judge++;
    else if (r.kind === 'tool') tool++;
    else if (r.kind === 'chatrecord') { chatrecord++; chatRecordTokens += Number(r.total_tokens) || 0; }
    else answer++;
    const m = r.model || 'unknown';
    if (!modelUsage[m]) modelUsage[m] = { calls: 0, tokens: 0 };
    modelUsage[m].calls++; modelUsage[m].tokens += Number(r.total_tokens) || 0;
  }

  chats.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
  const recentChats = chats.slice(0, 50);
  const recentRequests = reqs.slice(-50).reverse();

  // V13.5：读取聊天记录分析明细（chatrecord.<date>.jsonl），不含聊天内容
  const chatRecords = [];
  let crMsg = 0, crImg = 0, crVid = 0;
  for (const f of files) {
    try {
      const lines = fs.readFileSync(path.join(USAGE_DIR, 'chatrecord.' + f), 'utf-8').split('\n').filter(Boolean);
      for (const l of lines) {
        try {
          const o = JSON.parse(l);
          if (o && typeof o === 'object') {
            chatRecords.push(o);
            crMsg += Number(o.message_count) || 0;
            crImg += Number(o.image_count) || 0;
            crVid += Number(o.video_count) || 0;
          }
        } catch (e) {}
      }
    } catch (e) {}
  }
  chatRecords.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));

  return {
    range,
    files: files.length,
    totalTokens: total, promptTokens: prompt, completionTokens: completion, reasoningTokens: reasoning,
    cacheHitTokens: cacheHit, cacheMissTokens: cacheMiss,
    cacheRate: (cacheHit + cacheMiss) > 0 ? Math.round((cacheHit / (cacheHit + cacheMiss)) * 100) : 0,
    requests: reqs.length, judgeRequests: judge, answerRequests: answer, toolRequests: tool, chatRecordRequests: chatrecord,
    chatRecordTokens,
    avg: reqs.length ? Math.round(total / reqs.length) : 0,
    toolExecutions: stats.toolCalls || 0,
    l0Blocked: stats.l0Blocked || 0,
    modelCallsAvoided: stats.modelCallsAvoided || 0,
    chatRecordAnalyses: stats.chatRecordAnalyses || 0,
    chatRecordMessages: stats.chatRecordMessages || 0,
    chatRecordImages: stats.chatRecordImages || 0,
    chatRecordVideos: stats.chatRecordVideos || 0,
    modelUsage,
    recentChats,
    recentRequests,
    chatRecords: chatRecords.slice(0, 50),
    chatRecordTotals: { analyses: chatRecords.length, messages: crMsg, images: crImg, videos: crVid },
    budget: CFG.budget || { enabled: false },
  };
}

// ================= HTTP 服务 =================
// ================= 戳一戳（notice/notify/poke）=================
const lastPoke = new Map(); // key: chatKey:userId -> 上次回应时间戳

async function handlePoke(ev) {
  const cfg = CFG.poke || {};
  if (cfg.enabled === false) return;
  const pokers = Number(ev.user_id);                 // 戳的人
  const isGroup = ev.group_id != null && ev.group_id !== '';
  const chatKey = isGroup ? 'g' + ev.group_id : 'p' + pokers;
  const cd = Number(cfg.cooldownMs) || 0;
  const now = Date.now();
  const lk = chatKey + ':' + pokers;
  if (cd > 0 && now - (lastPoke.get(lk) || 0) < cd) return; // 冷却内忽略，防刷
  lastPoke.set(lk, now);

  const mode = cfg.mode || 'pokeback+text';
  const who = senderName(ev) || String(pokers);

  // 戳回去（群里用 group_poke；私聊 OneBot 无标准戳回，只发文字）
  if ((mode === 'pokeback' || mode === 'pokeback+text') && isGroup) {
    await napcatCall('group_poke', { group_id: Number(ev.group_id), target_id: pokers });
  }

  // 发俏皮话：优先 AI 现编（有性格、不重样），失败/关闭回落固定池
  if (mode === 'text' || mode === 'pokeback+text') {
    let line = '';
    if (cfg.useAI !== false) {
      try {
        line = await genText(
          `有人（${who}）戳了你一下。用 QQ 群里一个真人的口吻，回一句短、有性格、不重样的话——可以皮一下、可以假装被烦到、可以反戳回去，但别太长，一两句。别用「～」堆砌，别每句都带表情。`,
          { system: POKE_SYSTEM, model: CFG.api.model, maxTokens: 120, temperature: 1.0 }
        );
      } catch (e) { line = ''; }
    }
    if (!line) {
      const texts = (cfg.texts && cfg.texts.length) ? cfg.texts : ['被你戳到啦～'];
      line = texts[Math.floor(Math.random() * texts.length)];
    }
    const out = [{ type: 'text', data: { text: line } }];
    if (ev.message_id != null) out.unshift({ type: 'reply', data: { id: String(ev.message_id) } });
    if (isGroup) {
      await napcatCall('send_group_msg', { group_id: Number(ev.group_id), message: out });
    } else {
      await napcatCall('send_private_msg', { user_id: pokers, message: out });
    }
  }
  log(`[戳一戳] ${isGroup ? '群' + maskId(ev.group_id) : '私聊'} 来自 ${maskId(pokers)} 模式=${mode} 生成=${cfg.useAI !== false ? 'AI' : '固定'}`);
}

async function handleNotice(ev) {
  // OneBot 11：戳一戳事件为 post_type=notice, notice_type=notify, sub_type=poke
  if (ev.notice_type === 'notify' && ev.sub_type === 'poke' && Number(ev.target_id) === Number(ev.self_id)) {
    await handlePoke(ev);
  }
}

// ================= 主动聊天（定时向群发开场白）=================
const proactiveSent = new Map();   // key: 日期:群:时间 -> true（防同日重复）
let proactiveDateStr = '';

async function buildProactiveMessage(entry) {
  const cfg = CFG.proactiveChat || {};
  if (cfg.useAI) {
    try {
      const kindWord = entry.kind === 'goodnight' ? '晚上' : (entry.kind === 'greeting' ? '早上' : '现在');
      const prompt = `现在是${kindWord}，请在 QQ 群「${entry.group}」里主动开个轻松的小话头，${cfg.aiStyle || '简短自然，不超过20字'}。`;
      const t = await genText(prompt, { maxTokens: 120, temperature: 1.0 });
      if (t) return t;
    } catch (e) {
      log('[主动聊天] AI 生成失败，回落模板: ' + e.message);
    }
  }
  const ts = (cfg.templates && cfg.templates.length) ? cfg.templates : ['大家好呀～'];
  return ts[Math.floor(Math.random() * ts.length)];
}

async function runProactiveOnce() {
  const cfg = CFG.proactiveChat || {};
  if (!cfg.enabled) return;
  const sched = Array.isArray(cfg.schedule) ? cfg.schedule : [];
  if (!sched.length) return;
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const dateStr = now.toLocaleDateString('zh-CN');
  if (dateStr !== proactiveDateStr) { proactiveSent.clear(); proactiveDateStr = dateStr; } // 跨天清理
  for (const entry of sched) {
    if (!entry || !entry.group || entry.time !== hhmm) continue;
    const key = `${dateStr}:${entry.group}:${entry.time}`;
    if (proactiveSent.get(key)) continue;
    proactiveSent.set(key, true);
    try {
      const text = await buildProactiveMessage(entry);
      if (text) {
        await napcatCall('send_group_msg', { group_id: Number(entry.group), message: [{ type: 'text', data: { text } }] });
        log(`[主动聊天] 群${entry.group} @${hhmm} 已发: ${text.slice(0, 30)}`);
      }
    } catch (e) {
      log('[主动聊天] 发送失败: ' + e.message);
    }
  }
}

// ================= 本地 HTTP 事件入口（安全整改） =================
// OneBot 事件体上限：合并转发/长消息可能到几十 KB，1MB 足够且防止无限拼接耗尽内存
const MAX_EVENT_BODY_BYTES = 1024 * 1024;
// 事件推送来源鉴权开关（动态读配置，/ai reload 后即时生效）。
// 置 true 时：每个事件请求都必须携带 Authorization: Bearer <token>，否则 401；
// NapCat 侧在 HTTP/WS 配置里填同一个 access_token 即会带头（OneBot 11 规范）。
// 若开启鉴权但本机未加载 Token（env NAPCAT_ONEBOT_TOKEN 与 secrets.json 均无），
// 按 fail-closed 拒绝全部事件推送（503），绝不静默跳过鉴权。
// 关闭（默认 false）时不校验，依赖 127.0.0.1 回环信任边界。
function eventAuthRequired() {
  return !!(CFG.http && CFG.http.requireEventAuth === true);
}

const server = http.createServer((req, res) => {
  const sendJson = (code, obj) => {
    try { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
    catch (e) {}
  };
  // —— 后台页面 / API（复用同一个端口，NapCat 走 POST 不受影响）——
  if (req.method === 'GET') {
    let urlObj;
    try { urlObj = new URL(req.url, 'http://localhost'); } catch (e) { urlObj = { pathname: '/', searchParams: new URLSearchParams() }; }
    const pathname = urlObj.pathname;
    const range = urlObj.searchParams.get('range') || 'today';

    if (pathname === '/api/usage') {
      try {
        const data = buildUsageReport(range);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }
    if (pathname === '/' || pathname === '/dashboard' || pathname === '/index.html') {
      try {
        const html = fs.readFileSync(DASHBOARD_HTML, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('dashboard 页面缺失：' + e.message + '\n请把 dashboard/index.html 放到 NapCat 目录下。');
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"status":"alive"}');
  }

  // —— 方法限制：事件入口只接受 POST，其余一律 405（不再一律 200 ok）——
  if (req.method !== 'POST') {
    log('[HTTP] 拒绝非 POST 方法 ' + req.method + ' ' + String(req.url || '').slice(0, 80));
    return sendJson(405, { status: 'method-not-allowed' });
  }

  // —— 来源鉴权：开启 requireEventAuth 时强制 Bearer 校验（fail-closed）——
  // 必须拒绝的两种情况：
  //   ① 未加载 OneBot Token——无凭据可校验，绝不能静默跳过鉴权放行；
  //   ② 请求未携带与 Token 匹配的 Authorization: Bearer 头。
  // 关闭 requireEventAuth（默认）时不校验，依赖 127.0.0.1 回环信任边界。
  if (eventAuthRequired()) {
    if (!ONEBOT_TOKEN) {
      log('[HTTP] 事件入口要求鉴权但未加载 OneBot Token：按 fail-closed 拒绝全部事件推送（请在 secrets.json 配置 onebotToken，或关闭 http.requireEventAuth）');
      return sendJson(503, { status: 'auth-misconfigured', error: 'requireEventAuth enabled but no OneBot token loaded' });
    }
    const auth = String(req.headers.authorization || '');
    if (auth !== 'Bearer ' + ONEBOT_TOKEN) {
      log('[HTTP] 事件推送鉴权失败：未携带有效 OneBot Token（来源 IP 可信度不足，已拒绝）');
      return sendJson(401, { status: 'unauthorized' });
    }
  }

  // —— Content-Type：显式非 JSON 才拒绝（缺失时放行，兼容不同 OneBot 实现）——
  const reqCt = String(req.headers['content-type'] || '');
  if (reqCt && !/^application\/json/i.test(reqCt)) {
    log('[HTTP] 拒绝非 JSON Content-Type: ' + reqCt.slice(0, 60));
    return sendJson(415, { status: 'unsupported-media-type' });
  }

  // —— 请求体大小硬上限：超限立即断开，绝不上线拼接 ——
  let body = '';
  let tooLarge = false;
  req.on('data', (c) => {
    if (tooLarge) return;
    body += c;
    if (body.length > MAX_EVENT_BODY_BYTES) {
      tooLarge = true;
      body = '';
      log('[HTTP] 事件体超过上限（' + MAX_EVENT_BODY_BYTES + 'B），已断开连接');
      try { req.destroy(); } catch (e) {}
    }
  });
  req.on('end', () => {
    if (tooLarge) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"ok"}');

    let ev;
    try { ev = JSON.parse(body); } catch (e) { log('[解析失败] ' + e.message); return; }
    // 字段类型校验：post_type 必须是已知字符串，否则不当事件处理
    if (!ev || typeof ev !== 'object' || typeof ev.post_type !== 'string') {
      log('[解析失败] 事件缺少合法的 post_type 字段');
      return;
    }

    if (ev.post_type === 'message') {
      handleMessage(ev).catch((e) => log('[异常] ' + e.message));
    } else if (ev.post_type === 'notice') {
      handleNotice(ev).catch((e) => log('[异常] ' + e.message));
    } else if (ev.post_type === 'meta_event') {
      log('[meta] ' + ev.meta_event_type + ' ' + (ev.sub_type || ''));
    }
  });
});

// ================= 启动前自检 =================
if (!API_KEY) {
  log('[错误] 未找到 API Key。请设置环境变量 DEEPSEEK_API_KEY，');
  log('        或在 ' + BASE_DIR + ' 下创建 secrets.json：{"apiKey":"sk-..."}');
  log('        程序退出，未启动监听。');
  process.exit(1);
}

loadMemory();
loadStats();

// 把「运行时真实配置」注入给新增的两个模块（/ai reload 后 CFG 会被整体替换，
// 所以必须动态读取，不能在 require 时抓一次）
groupLog.setConfig(() => CFG);
memoryStore.setConfig(() => CFG);
dailySummary.setConfig(() => CFG);
groupProfile.setConfig(() => CFG);

// ===== 群聊每日总结：自动定时器（**默认关闭**，必须显式打开且配置白名单才会发群）=====
let dailySummaryTimer = null;

async function runAutoDailySummary(groups) {
  const date = groupLog.shiftDate(groupLog.todayStr(), -1);   // 自动总结「昨天」，当天尚未结束
  for (const gid of groups) {
    const key = gid + '@' + date;
    if (!dailySummary.shouldSendOnce(key)) { log(`[总结] 群${maskId(gid)} ${date} 已发过，跳过（防重复）`); continue; }
    const r = await dailySummary.buildSummary({ groupId: gid, date, groupName: gid, deps: { genText } });
    if (!r.ok) {
      // 没内容 / 生成失败 → 不发送，并且释放防重标记，允许稍后重试
      dailySummary.clearSendOnce(key);
      log(`[总结] 群${maskId(gid)} ${date} 未发送（${r.reason}）`);
      continue;
    }
    try {
      const rr = await napcatCall('send_group_msg', { group_id: Number(gid), message: [{ type: 'text', data: { text: r.text } }] });
      log(`[总结] 群${maskId(gid)} ${date} 自动发送 ok=${onebotOK(rr)}`);
    } catch (e) {
      dailySummary.clearSendOnce(key);
      log('[总结] 自动发送失败：' + String((e && e.message) || e).slice(0, 80));
    }
  }
}

function scheduleDailySummary() {
  const ds = CFG.dailySummary || {};
  if (dailySummaryTimer) { clearTimeout(dailySummaryTimer); dailySummaryTimer = null; }
  if (ds.auto !== true) return;                        // 默认关闭：绝不自动发群消息
  const groups = Array.isArray(ds.allowedGroups) ? ds.allowedGroups.map(String).filter(Boolean) : [];
  if (!groups.length) {
    log('[总结] auto=true 但 allowedGroups 为空 → 不做任何自动发送（安全兜底）');
    return;
  }
  const hm = /^(\d{1,2}):(\d{2})$/.exec(String(ds.autoTime || '23:30'));
  if (!hm) { log('[总结] autoTime 格式应为 HH:MM，自动总结未启动'); return; }
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
    Math.min(23, Math.max(0, Number(hm[1]))), Math.min(59, Math.max(0, Number(hm[2]))), 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  const delay = next.getTime() - Date.now();
  dailySummaryTimer = setTimeout(async () => {
    try { await runAutoDailySummary(groups); }
    catch (e) { log('[总结] 自动总结异常：' + String((e && e.message) || e).slice(0, 80)); }
    scheduleDailySummary();                            // 排下一天
  }, delay);
  if (dailySummaryTimer.unref) dailySummaryTimer.unref();
  log(`[总结] 自动总结已开启：${ds.autoTime} 发送到群 ${groups.join(',')}（${Math.round(delay / 60000)} 分钟后）`);
}
scheduleDailySummary();

// V14：初始化 Agent（把已有能力作为 Tool 注入；缺哪个就不会注册哪个，绝不硬崩）
try {
  agent.init({
    log,
    config: CFG.agent || {},
    // 基础
    getCurrentTime: () => getCurrentTime(),
    // Web（复用现有 webSearch / fetchUrl / isSafeUrl）
    webSearch: (q, n) => webSearch(q, n),
    fetchUrl: (u) => fetchUrl(u),
    isSafeUrl: (u) => isSafeUrl(u),
    // Memory（长期 notes / 短期 sessions 分开）
    getNotes: (sid) => agentGetNotes(sid),
    getShortTerm: (sid) => agentGetShortTerm(sid),
    rememberNote: (sid, content) => rememberNote(sid, content),
    // File（复用 workspacePath / safeFileName / BINARY_EXT / MAX_*）
    readFile: (name) => readWorkspaceFile(name),
    writeFile: (name, buf) => writeWorkspaceFile(name, buf),
    listFiles: () => listWorkspace(),
    isWritableName: (name) => isWritableName(name),
    // Chat Record（复用 chat_record_parser）
    getForwardMsg: (id) => getForwardMsg(id),
    // V14-C 多模态（复用 fetchImageAsBase64 / MULTIMODAL_MODEL / ffmpeg native addon）
    visionAnalyze: (segs, question, ctx) => agentVisionAnalyze(segs, question, ctx),
    analyzeVideo: (segs, question, ctx) => agentVideoAnalyze(segs, question, ctx),
    bilibiliEnabled: !(CFG.agent && CFG.agent.bilibili === false),
    getPendingRecord: (ctx) => getPendingChatRecordForAgent(ctx),
    // 生图 / 表情包（注册进 Tool Registry，由 intent.js 建议、agent_core 执行）
    generateImage: (prompt, source, ctx) =>
      generateImageTool(String((ctx && ctx.sessionId) || ''), { prompt, source }, ctx || {}),
    sendSticker: (keyword, ctx) =>
      sendStickerTo(String((ctx && ctx.sessionId) || ''), keyword, ctx || {}),
    // 肥鱼升级：注入配置与对外发送能力（新功能默认全关，仅按配置启用）
    config: CFG,
    adminList: (CFG.admin && CFG.admin.qq) || [],
    sendToMaster: async (text, opts) => {
      const list = (CFG.admin && CFG.admin.qq) || [];
      // 纵深防御（要求④）：即便上游传入 opts.target，也只向配置的主人 QQ 列表发送；越权 target 被忽略
      const override = (opts && opts.target != null) ? String(opts.target).trim() : null;
      const targets = (override && list.map(String).indexOf(override) >= 0) ? [override] : list;
      for (const q of targets) {
        try { await napcatCall('send_private_msg', { user_id: Number(q), message: String(text) }); } catch (e) {}
      }
    },
    authorizedQZone: false,
    // runTask：真实自主执行需注入 Agent 调用；默认不注入（任务仅做生命周期登记，零模型成本）
  });
} catch (e) {
  log('[Agent] 初始化失败，已回退为纯 V13.5 行为: ' + e.message);
}

try { fs.mkdirSync(STICKER_DIR, { recursive: true }); } catch (e) {}
try { fs.mkdirSync(WORKSPACE_DIR, { recursive: true }); } catch (e) {}
// 统计定期落盘（防进程被杀丢数据），并把内存态缓存的配置写出来便于排查
if (CFG.stats.enable) { const t = setInterval(saveStats, 60000); if (t.unref) t.unref(); }
// 主动聊天：每分钟检查一次计划，到点向群发开场白；同时驱动肥鱼任务调度与通知冲刷
{ const t = setInterval(async () => {
    try { runProactiveOnce(); } catch (e) {}
    try { const f = require('./tools/feiyu').getFeiyu(); if (f) await f.tick(); } catch (e) {}
  }, 60 * 1000); if (t.unref) t.unref(); }

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  log('='.repeat(46));
  log(`AI 桥启动 | 端口 ${LISTEN_PORT} | 模型 ${CFG.api.model} | Key来源=${process.env.DEEPSEEK_API_KEY ? 'env' : 'secrets.json'}`);
  // 安全整改：日志如实描述行为，不再出现「日志说将被拒、代码却无鉴权直连」的矛盾
  if (eventAuthRequired() && !ONEBOT_TOKEN) {
    log('安全警告：http.requireEventAuth=true 但未加载 OneBot Token——事件入口将 fail-closed 拒绝全部推送（503）。请配置 secrets.json 的 onebotToken（NapCat 侧填同一个 access_token），或关闭 requireEventAuth。');
  }
  log(`OneBot Token=${ONEBOT_TOKEN ? '已加载(len=' + ONEBOT_TOKEN.length + ')' : '未加载' + (eventAuthRequired() ? '-requireEventAuth=true，事件推送将被拒绝（fail-closed）' : '-将以无鉴权方式调用本机 OneBot(依赖 127.0.0.1 回环信任边界)')}`);
  if (ONEBOT_TOKEN && !eventAuthRequired()) {
    log('安全提示：已加载 OneBot Token 但 http.requireEventAuth=false，事件推送入口暂不校验来源（任何本机程序均可推送事件）；确认 NapCat 会带 Authorization 头后，可在 ai_config.json 置 http.requireEventAuth=true 收紧。');
  }
  log(`配置来源=${CFG.__source} | 文件=${CONFIG_FILE}`);
  log(`私聊=${CFG.private.allow ? '开' : '关'} 群聊=${CFG.group.allow ? CFG.group.mode : '关'} 联网=${CFG.web.enable ? '开' : '关'} 图片调试=${IMAGE_DEBUG ? '开' : '关'}`);
  log(`群策略：回复概率=${CFG.group.replyProbability}% 冷却(群/人)=${CFG.group.cooldownMs}/${CFG.group.userCooldownMs}ms 聚合=${CFG.group.aggregateMs}ms 缓冲=${CFG.group.ringSize} 上下文(简/常/复)=${CFG.group.contextSimple}/${CFG.group.contextNormal}/${CFG.group.contextComplex} AI判断=${CFG.group.judgeWithAi ? '开' : '关'}`);
  log(`第二阶段：模式=${AI_MODE} Judge=${judgeEnabled() ? '开(' + CFG.judge.model + ' 阈值' + CFG.judge.confidenceThreshold + ')' : '关'} 模型分级=${CFG.model.routing ? '开' : '关'}(fast/normal/reasoning=${CFG.model.fast}/${CFG.model.normal}/${CFG.model.reasoning}) 上下文分级(简/常/复)=${CFG.context.short}/${CFG.context.normal}/${CFG.context.complex} 摘要=${CFG.summary.enabled ? '开(每' + CFG.summary.triggerMsgs + '条)' : '关'} 管理员=${(CFG.admin.qq || []).length}人`);
  const budgetMsg = CFG.budget && CFG.budget.enabled
    ? '开(上限' + (CFG.budget.daily_tokens || '?') + ',警告' + (CFG.budget.warn_percent || 80) + '%,硬限' + (CFG.budget.hard_limit ? '是' : '否') + ')'
    : '关';
  log('v12 TokenEconomy：预算=' + budgetMsg + ' | 用量看板=http://127.0.0.1:' + LISTEN_PORT + '/ | 命令：/ai mode economy|normal|chat|enhanced , /ai stats , /ai budget');
  log(`V14 Agent=${agentEnabled() ? '开' : '关'} 已注册工具=${agent.listTools().map((t) => t.name).join('、') || '(无)'} | 上限 steps=${CFG.agent.maxSteps} tools=${CFG.agent.maxToolCalls} retries=${CFG.agent.maxRetries}`);
  log(`记忆=${CFG.memory.enable ? '开' : '关'} 会话=${sessions.size} 长期记忆=${notes.size}`);
  log(`戳一戳=${CFG.poke && CFG.poke.enabled ? '开(' + (CFG.poke.mode || 'pokeback+text') + ')' : '关'} 主动聊天=${CFG.proactiveChat && CFG.proactiveChat.enabled ? '开(' + (CFG.proactiveChat.schedule || []).length + '计划)' : '关'}`);
  try {
    const vc = videoCapabilityProbe();
    log(`[视频能力] ffmpeg.exe=${vc.ffmpegExe ? '有' : '无'} native addon=${vc.ffmpegNativeAddon ? '可用' : '不可用'} ` +
        `元数据=${vc.metadata ? '支持' : '不支持'} 首帧=${vc.firstFrame ? '支持' : '不支持'} ` +
        `多帧=${vc.multiFrame ? '支持' : '不支持'} 完整视频理解=${vc.fullVideoUnderstanding ? '支持' : '不支持'}`);
  } catch (e) {}
  const sk = listStickers();
  log(`表情=${CFG.sticker.enable ? '开' : '关'} 本地表情包=${sk.length} 个` + (sk.length ? '（' + listStickerKeywords().join('、') + '）' : '（未放图片，将用内置表情）'));
  log(`文件=${CFG.files.enable ? '开' : '关'} 工作区=${WORKSPACE_DIR} 现有 ${listWorkspace().length} 个文件`);
  const sl = statsLine();
  if (sl) log('[统计] ' + sl);
});

// 测试钩子：暴露安全相关纯函数供单元测试（不影响运行时，无消费方）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isPathAllowed, readLocalAsBase64, fetchImageAsBase64, ALLOWED_FILE_ROOTS, ONEBOT_TOKEN: !!ONEBOT_TOKEN };
}
