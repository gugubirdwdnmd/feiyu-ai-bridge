'use strict';
/**
 * ipcChannels.js —— 固定 IPC 通道名 + 参数校验助手。
 * Renderer 只能通过这里列出的固定通道与 Main 通信；Main 端对每个调用做参数校验与来源检查。
 */
const CHANNELS = {
  APP_VERSION: 'app:version',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  // 机器人目录定位状态（打包后能否定位到 botDir / 未找到时的原因）
  BOTDIR_STATUS: 'botdir:status',
  BOT_INSPECT: 'bot:inspect',
  CONFIG_READ: 'config:read',
  CONFIG_APPLY: 'config:apply',
  PERSONALITY_READ: 'personality:read',
  PERSONALITY_WRITE: 'personality:write',
  // 人格模板库（与运行配置分离：模板存 feiyu_personalities.json，应用才写 ai_prompt.txt）
  PERSONALITY_TEMPLATE_LIST: 'personality:template:list',
  PERSONALITY_TEMPLATE_SAVE: 'personality:template:save',
  PERSONALITY_TEMPLATE_DELETE: 'personality:template:delete',
  PERSONALITY_TEMPLATE_COPY: 'personality:template:copy',
  PERSONALITY_TEMPLATE_RENAME: 'personality:template:rename',
  PERSONALITY_TEMPLATE_SET_ACTIVE: 'personality:template:setActive',
  PERSONALITY_TEMPLATE_APPLY: 'personality:template:apply',
  PERSONALITY_TEMPLATE_DIFF: 'personality:template:diff',
  SECRET_READ: 'secret:read',
  SECRET_HAS_KEY: 'secret:hasKey',
  SECRET_WRITE: 'secret:write',
  // 凭据安全（桌面侧多 Provider 密钥的 safeStorage 加密状态与迁移）
  CREDENTIAL_STATUS: 'credential:status',
  CREDENTIAL_MIGRATE: 'credential:migrate',
  USAGE_GET: 'usage:get',
  LOG_TAIL: 'log:tail',
  LOG_SEARCH: 'log:search',
  PROC_STATUS: 'proc:status',
  PROC_START: 'proc:start',
  PROC_STOP: 'proc:stop',
  IMPORT_BUILD: 'import:build',
  IMPORT_VALIDATE: 'import:validate',
  IMPORT_APPLY: 'import:apply',
  PRICE_GET: 'price:get',
  PRICE_SET: 'price:set',
  DIALOG_PICKDIR: 'dialog:pickDir',
  // 多 Provider 管理（桌面侧注册表；复用现有单 Provider 请求系统）
  PROVIDER_LIST: 'provider:list',
  PROVIDER_SAVE: 'provider:save',
  PROVIDER_DELETE: 'provider:delete',
  PROVIDER_SET_DEFAULT: 'provider:setDefault',
  PROVIDER_TEST: 'provider:test',
  PROVIDER_APPLY: 'provider:apply',
  PROVIDER_PREVIEW: 'provider:preview',
  // 技能扩展（与机器人侧 skills.js 共用 feiyu_skills.json；保存即生效，无需重启）
  SKILL_LIST: 'skill:list',
  SKILL_SAVE: 'skill:save',
  SKILL_DELETE: 'skill:delete',
  SKILL_COPY: 'skill:copy',
  SKILL_SET_ENABLED: 'skill:setEnabled',
  SKILL_TEMPLATES: 'skill:templates',
  SKILL_IMPORT_TEMPLATE: 'skill:importTemplate',
  SKILL_EXPORT: 'skill:export',
  SKILL_IMPORT: 'skill:import',
  // ComfyUI 生图扩展（检测/连通性/工作流/模型/自动下载/前置条件）
  COMFY_DETECT: 'comfy:detect',
  COMFY_STATUS: 'comfy:status',
  COMFY_WORKFLOWS: 'comfy:workflows',
  COMFY_PREREQ: 'comfy:prereq',
  COMFY_DOWNLOAD_MODEL: 'comfy:downloadModel',
  COMFY_RELEASE: 'comfy:release',
  COMFY_INSTALL: 'comfy:install',
  COMFY_PICKDIR: 'comfy:pickDir',
  COMFY_START: 'comfy:start',
  COMFY_STOP: 'comfy:stop',
  // 主题工坊（主题只存 userData/theme.json，与机器人目录完全分离）
  THEME_GET: 'theme:get',
  THEME_SAVE: 'theme:save',
  THEME_RESET: 'theme:reset',
  THEME_PRESETS: 'theme:presets',
  THEME_EXPORT: 'theme:export',
  THEME_IMPORT: 'theme:import',

  // ===== 模块 A：NapCat 实例与 QQ 登录中心 =====
  NAPCAT_QR_PLAN: 'napcat:qr:plan',
  NAPCAT_QR_START: 'napcat:qr:start',
  NAPCAT_QR_POLL: 'napcat:qr:poll',
  NAPCAT_INSTANCE_LIST: 'napcat:instance:list',
  NAPCAT_INSTANCE_SAVE: 'napcat:instance:save',
  NAPCAT_INSTANCE_DELETE: 'napcat:instance:delete',

  // ===== 模块 B：统一服务编排与一键启动 =====
  SERVICE_LIST: 'service:list',
  SERVICE_SAVE: 'service:save',
  SERVICE_DELETE: 'service:delete',
  SERVICE_PRESETS: 'service:presets',
  SERVICE_PLAN: 'service:plan',
  SERVICE_START_PRESET: 'service:startPreset',
  SERVICE_PRESET_SAVE: 'service:preset:save',
  SERVICE_PRESET_DELETE: 'service:preset:delete',

  // ===== 模块 C：ComfyUI 环境检测（只读） =====
  ENV_DETECT: 'env:detect',

  // ===== 模块 D：MCP 外部导入与权限中心 =====
  MCP_LIST: 'mcp:list',
  MCP_PARSE: 'mcp:parse',
  MCP_IMPORT: 'mcp:import',
  MCP_SET_ENABLED: 'mcp:setEnabled',
  MCP_DELETE: 'mcp:delete',
  MCP_EXPORT: 'mcp:export',

  // ===== 模块 E：技能树与分类扩展 =====
  SKILL_TREE: 'skill:tree',
  SKILL_CATEGORY_LIST: 'skill:category:list',
  SKILL_CATEGORY_ADD: 'skill:category:add',
  SKILL_CATEGORY_DELETE: 'skill:category:delete',

  // ===== 模块 F：市场接入（华为云 / 通用 / 本地） =====
  MARKET_SOURCES: 'market:sources',
  MARKET_PARSE: 'market:parse',
  MARKET_FETCH: 'market:fetch',
  MARKET_PLAN: 'market:plan',

  // ===== 模块 G：配置备份 / 恢复 / 升级保护 =====
  BACKUP_LIST: 'backup:list',
  BACKUP_CREATE: 'backup:create',
  BACKUP_DIFF: 'backup:diff',
  BACKUP_RESTORE: 'backup:restore',
  BACKUP_DELETE: 'backup:delete',

  // ===== 模块 H：可视化自动化工作流 =====
  WORKFLOW_LIST: 'workflow:list',
  WORKFLOW_GET: 'workflow:get',
  WORKFLOW_SAVE: 'workflow:save',
  WORKFLOW_DELETE: 'workflow:delete',
  WORKFLOW_RUN: 'workflow:run',

  // ===== 模块 I：用量与成本管理 =====
  COST_REPORT: 'cost:report',
  COST_BUDGET_GET: 'cost:budget:get',
  COST_BUDGET_SET: 'cost:budget:set',

  // ===== 模块 J：日志 / 诊断 / 通知中心 =====
  DIAG_COLLECT: 'diag:collect',
  DIAG_EXPORT: 'diag:export',
  NOTIFY_LIST: 'notify:list',
  NOTIFY_MARK_READ: 'notify:markRead',
  NOTIFY_CLEAR: 'notify:clear',

  // ===== 模块 K：终端 / 实时状态监控 / 实时日志流 =====
  // 终端：渲染进程只发「打开 / 输入 / 关闭」三类受控指令，真正的 Shell 在 Main 进程执行，
  // 输出经事件推回（绝不把 shell 能力泄漏给渲染进程）。
  TERMINAL_OPEN: 'terminal:open',
  TERMINAL_INPUT: 'terminal:input',
  TERMINAL_CLOSE: 'terminal:close',
  // 以下为主 → 渲染事件（渲染进程只订阅，不反向调用）
  TERMINAL_OUTPUT: 'terminal:output',
  TERMINAL_EXIT: 'terminal:exit',
  TERMINAL_CLEAR: 'terminal:clear',
  // 实时状态监控（请求/响应）
  MONITOR_STATUS: 'monitor:status',
  // 实时日志流（请求开启/关闭，新行经事件推送）
  LOG_STREAM_START: 'logstream:start',
  LOG_STREAM_STOP: 'logstream:stop',
  LOG_STREAM_LINE: 'logstream:line',
  // QQ 接入后端统一管理（NapCat / SnowLuma）
  QQ_BACKEND_LIST: 'qqbackend:list',
  QQ_BACKEND_SET: 'qqbackend:set',
  QQ_BACKEND_STATUS: 'qqbackend:status',
  QQ_BACKEND_START: 'qqbackend:start',
  QQ_BACKEND_STOP: 'qqbackend:stop',
  QQ_BACKEND_RESTART: 'qqbackend:restart',
  QQ_BACKEND_HEALTH: 'qqbackend:health',
  QQ_BACKEND_LOGS: 'qqbackend:logs',
  SNOWLUMA_DETECT: 'snowluma:detect',
};

/**
 * 纯事件通道（主 → 渲染，单向推送）：渲染进程只订阅、不反向 invoke，
 * 因此没有对应 handler，也不应在 validate 里被当作「未知通道」拒绝。
 */
const EVENT_CHANNELS = [
  CHANNELS.TERMINAL_OUTPUT,
  CHANNELS.TERMINAL_EXIT,
  CHANNELS.TERMINAL_CLEAR,
  CHANNELS.LOG_STREAM_LINE,
];
function isEventChannel(channel) { return EVENT_CHANNELS.includes(channel); }

const ALLOWED_RANGE = ['today', 'yesterday', '7d', 'month', 'all'];

/**
 * secrets.json 允许写入的字段白名单。
 * 机器人核心只认这几个键；渲染进程不得借 SECRET_WRITE 写入任意字段。
 * 读方向（SECRET_READ）不返回明文，只返回掩码与存在性。
 */
const ALLOWED_SECRET_KEYS = ['apiKey', 'api_key', 'onebotToken', 'imageApiKey'];

function isObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }
function isString(v) { return typeof v === 'string'; }
function inSet(v, set) { return set.includes(v); }

/** 通用校验：返回 {ok, error}。失败时不执行任何操作。 */
function validate(channel, args) {
  if (isEventChannel(channel)) return { ok: true }; // 单向推送通道，渲染进程从不 invoke
  switch (channel) {
    case CHANNELS.CONFIG_APPLY:
      if (!isObject(args) || !isObject(args.partial)) return { ok: false, error: '需要 {partial: object}' };
      return { ok: true };
    case CHANNELS.PERSONALITY_WRITE:
      if (!isObject(args) || !isString(args.content)) return { ok: false, error: '需要 {content: string}' };
      return { ok: true };
    case CHANNELS.SECRET_WRITE:
      if (!isObject(args) || !isObject(args.data)) return { ok: false, error: '需要 {data: object}' };
      {
        const keys = Object.keys(args.data);
        const illegal = keys.filter((k) => !ALLOWED_SECRET_KEYS.includes(k));
        if (illegal.length) return { ok: false, error: '不允许写入的字段: ' + illegal.join(', ') + '（仅允许 ' + ALLOWED_SECRET_KEYS.join('/') + '）' };
      }
      return { ok: true };
    case CHANNELS.USAGE_GET:
      if (args && args.range != null && !inSet(args.range, ALLOWED_RANGE)) return { ok: false, error: 'range 必须是 ' + ALLOWED_RANGE.join('/') };
      return { ok: true };
    case CHANNELS.LOG_TAIL:
      if (args && args.lines != null && (!Number.isInteger(args.lines) || args.lines < 1 || args.lines > 5000)) return { ok: false, error: 'lines 必须 1-5000' };
      return { ok: true };
    case CHANNELS.LOG_SEARCH:
      if (args && args.keyword != null && !isString(args.keyword)) return { ok: false, error: 'keyword 必须是 string' };
      return { ok: true };
    case CHANNELS.BOT_INSPECT:
      if (!isObject(args) || typeof args.dir !== 'string') return { ok: false, error: '需要 {dir: string}' };
      return { ok: true };
    case CHANNELS.PROC_START:
      if (args && args.napcat != null) {
        if (!isObject(args.napcat) || typeof args.napcat.account !== 'string') return { ok: false, error: 'napcat.account 必须是 string' };
      }
      return { ok: true };
    case CHANNELS.PROC_STOP:
      if (args && args.pids != null) {
        if (!Array.isArray(args.pids) || !args.pids.every((x) => Number.isInteger(x))) return { ok: false, error: 'pids 必须是数字数组' };
      }
      return { ok: true };
    case CHANNELS.IMPORT_APPLY:
      if (!isObject(args) || !isObject(args.incoming)) return { ok: false, error: '需要 {incoming: object}' };
      return { ok: true };
    case CHANNELS.IMPORT_VALIDATE:
      if (!isObject(args) || !isObject(args.obj)) return { ok: false, error: '需要 {obj: object}' };
      return { ok: true };
    case CHANNELS.CONFIG_READ:
    case CHANNELS.PERSONALITY_READ:
    case CHANNELS.SECRET_READ:
    case CHANNELS.SECRET_HAS_KEY:
    case CHANNELS.IMPORT_BUILD:
    case CHANNELS.PROC_STATUS:
    case CHANNELS.SETTINGS_GET:
    case CHANNELS.APP_VERSION:
    case CHANNELS.BOTDIR_STATUS:
    case CHANNELS.CREDENTIAL_STATUS:
    case CHANNELS.CREDENTIAL_MIGRATE:
    case CHANNELS.PERSONALITY_TEMPLATE_LIST:
      return { ok: true };
    case CHANNELS.PERSONALITY_TEMPLATE_SAVE:
      if (!isObject(args) || !isObject(args.template)) return { ok: false, error: '需要 {template: object}' };
      if (args.template.id != null && typeof args.template.id !== 'string') return { ok: false, error: 'template.id 必须是 string' };
      return { ok: true };
    case CHANNELS.PERSONALITY_TEMPLATE_DELETE:
    case CHANNELS.PERSONALITY_TEMPLATE_COPY:
    case CHANNELS.PERSONALITY_TEMPLATE_SET_ACTIVE:
    case CHANNELS.PERSONALITY_TEMPLATE_APPLY:
      if (!isObject(args) || typeof args.id !== 'string') return { ok: false, error: '需要 {id: string}' };
      return { ok: true };
    case CHANNELS.PERSONALITY_TEMPLATE_RENAME:
      if (!isObject(args) || typeof args.id !== 'string' || typeof args.name !== 'string') return { ok: false, error: '需要 {id: string, name: string}' };
      return { ok: true };
    case CHANNELS.PERSONALITY_TEMPLATE_DIFF:
      if (!isObject(args) || typeof args.id !== 'string') return { ok: false, error: '需要 {id: string}' };
      if (args.target != null && typeof args.target !== 'string') return { ok: false, error: 'target 必须是 string' };
      return { ok: true };
    case CHANNELS.SETTINGS_SET:
      if (!isObject(args)) return { ok: false, error: '需要 object' };
      return { ok: true };
    case CHANNELS.DIALOG_PICKDIR:
      return { ok: true };
    case CHANNELS.PRICE_GET:
    case CHANNELS.PRICE_SET:
      if (channel === CHANNELS.PRICE_SET && (!isObject(args) || !isObject(args.table))) return { ok: false, error: '需要 {table: object}' };
      return { ok: true };
    case CHANNELS.PROVIDER_LIST:
    case CHANNELS.PROVIDER_DELETE:
    case CHANNELS.PROVIDER_SET_DEFAULT:
    case CHANNELS.PROVIDER_APPLY:
    case CHANNELS.PROVIDER_PREVIEW:
      if (args != null && (!isObject(args) || typeof args.id !== 'string')) return { ok: false, error: '需要 {id: string}' };
      return { ok: true };
    case CHANNELS.PROVIDER_SAVE:
      if (!isObject(args) || !isObject(args.provider)) return { ok: false, error: '需要 {provider: object}' };
      return { ok: true };
    case CHANNELS.PROVIDER_TEST:
      if (!isObject(args) || (typeof args.id !== 'string' && !isObject(args.provider))) return { ok: false, error: '需要 {id} 或 {provider}' };
      return { ok: true };
    // —— 技能扩展 ——
    case CHANNELS.SKILL_LIST:
    case CHANNELS.SKILL_TEMPLATES:
    case CHANNELS.SKILL_EXPORT:
      return { ok: true };
    case CHANNELS.SKILL_SAVE:
      if (!isObject(args) || !isObject(args.skill)) return { ok: false, error: '需要 {skill: object}' };
      if (args.skill.id != null && typeof args.skill.id !== 'string') return { ok: false, error: 'skill.id 必须是 string' };
      return { ok: true };
    case CHANNELS.SKILL_DELETE:
    case CHANNELS.SKILL_COPY:
      if (!isObject(args) || typeof args.id !== 'string') return { ok: false, error: '需要 {id: string}' };
      return { ok: true };
    case CHANNELS.SKILL_SET_ENABLED:
      if (!isObject(args) || typeof args.id !== 'string' || typeof args.enabled !== 'boolean') {
        return { ok: false, error: '需要 {id: string, enabled: boolean}' };
      }
      return { ok: true };
    case CHANNELS.SKILL_IMPORT_TEMPLATE:
      if (!isObject(args) || typeof args.key !== 'string') return { ok: false, error: '需要 {key: string}' };
      return { ok: true };
    case CHANNELS.SKILL_IMPORT:
      if (!isObject(args) || !isObject(args.payload)) return { ok: false, error: '需要 {payload: object}' };
      return { ok: true };
    // —— ComfyUI 扩展 ——
    case CHANNELS.COMFY_DETECT:
    case CHANNELS.COMFY_STATUS:
    case CHANNELS.COMFY_WORKFLOWS:
    case CHANNELS.COMFY_PICKDIR:
      return { ok: true };
    case CHANNELS.COMFY_RELEASE:
      if (args != null && args.variant != null && !['nvidia', 'amd', 'intel', 'nvidia_arm64', 'nvidia_cu126'].includes(args.variant)) {
        return { ok: false, error: 'variant 必须是 nvidia/amd/intel/nvidia_arm64/nvidia_cu126' };
      }
      return { ok: true };
    case CHANNELS.COMFY_PREREQ:
      if (args != null && args.dir != null && typeof args.dir !== 'string') return { ok: false, error: 'dir 必须是 string' };
      if (args != null && args.endpoint != null && typeof args.endpoint !== 'string') return { ok: false, error: 'endpoint 必须是 string' };
      return { ok: true };
    case CHANNELS.COMFY_DOWNLOAD_MODEL:
      if (!isObject(args) || typeof args.key !== 'string') return { ok: false, error: '需要 {key: string}' };
      if (args.dir != null && typeof args.dir !== 'string') return { ok: false, error: 'dir 必须是 string' };
      return { ok: true };
    case CHANNELS.COMFY_INSTALL:
      if (!isObject(args) || typeof args.dir !== 'string' || !args.dir.trim()) return { ok: false, error: '需要 {dir: string}' };
      if (args.variant != null && !['nvidia', 'amd', 'intel', 'nvidia_arm64', 'nvidia_cu126'].includes(args.variant)) {
        return { ok: false, error: 'variant 必须是 nvidia/amd/intel/nvidia_arm64/nvidia_cu126' };
      }
      return { ok: true };
    case CHANNELS.COMFY_START:
      if (args != null && args.dir != null && typeof args.dir !== 'string') return { ok: false, error: 'dir 必须是 string' };
      return { ok: true };
    case CHANNELS.COMFY_STOP:
      if (args != null && args.port != null && (!Number.isInteger(args.port) || args.port <= 0 || args.port > 65535)) {
        return { ok: false, error: 'port 必须是 1–65535 的整数' };
      }
      return { ok: true };
    // —— 主题工坊 ——
    case CHANNELS.THEME_GET:
    case CHANNELS.THEME_RESET:
    case CHANNELS.THEME_PRESETS:
    case CHANNELS.THEME_EXPORT:
      return { ok: true };
    case CHANNELS.THEME_SAVE:
      if (!isObject(args) || !isObject(args.theme)) return { ok: false, error: '需要 {theme: object}' };
      return { ok: true };
    case CHANNELS.THEME_IMPORT:
      if (args == null || (typeof args.json !== 'string' && !isObject(args.json))) {
        return { ok: false, error: '需要 {json: string}' };
      }
      return { ok: true };

    // —————————— 模块 A：登录中心 ——————————
    case CHANNELS.NAPCAT_QR_PLAN:
    case CHANNELS.NAPCAT_INSTANCE_LIST:
      return { ok: true };
    case CHANNELS.NAPCAT_QR_START:
      if (args != null && args.instanceId != null && !isString(args.instanceId)) return { ok: false, error: 'instanceId 必须是 string' };
      if (args != null && args.endpoint != null && !isString(args.endpoint)) return { ok: false, error: 'endpoint 必须是 string' };
      return { ok: true };
    case CHANNELS.NAPCAT_QR_POLL:
      if (!isObject(args) || !isString(args.sessionId)) return { ok: false, error: '需要 {sessionId: string}' };
      if (args.payload != null && !isObject(args.payload)) return { ok: false, error: 'payload 必须是 object' };
      return { ok: true };
    case CHANNELS.NAPCAT_INSTANCE_SAVE:
      if (!isObject(args) || !isObject(args.instance)) return { ok: false, error: '需要 {instance: object}' };
      return { ok: true };
    case CHANNELS.NAPCAT_INSTANCE_DELETE:
      if (!isObject(args) || !isString(args.id)) return { ok: false, error: '需要 {id: string}' };
      return { ok: true };

    // —————————— 模块 B：服务编排 ——————————
    case CHANNELS.SERVICE_LIST:
    case CHANNELS.SERVICE_PRESETS:
      return { ok: true };
    case CHANNELS.SERVICE_SAVE:
      if (!isObject(args) || !isObject(args.service)) return { ok: false, error: '需要 {service: object}' };
      return { ok: true };
    case CHANNELS.SERVICE_DELETE:
    case CHANNELS.SERVICE_PRESET_DELETE:
      if (!isObject(args) || !isString(args.id)) return { ok: false, error: '需要 {id: string}' };
      return { ok: true };
    case CHANNELS.SERVICE_PLAN:
    case CHANNELS.SERVICE_START_PRESET:
      if (!isObject(args) || !isString(args.presetId)) return { ok: false, error: '需要 {presetId: string}' };
      if (args.force != null && typeof args.force !== 'boolean') return { ok: false, error: 'force 必须是 boolean' };
      return { ok: true };
    case CHANNELS.SERVICE_PRESET_SAVE:
      if (!isObject(args) || !isObject(args.preset)) return { ok: false, error: '需要 {preset: object}' };
      return { ok: true };

    // —————————— 模块 C：环境检测 ——————————
    case CHANNELS.ENV_DETECT:
      if (args != null && args.dir != null && !isString(args.dir)) return { ok: false, error: 'dir 必须是 string' };
      return { ok: true };

    // —————————— 模块 D：MCP ——————————
    case CHANNELS.MCP_LIST:
    case CHANNELS.MCP_EXPORT:
      return { ok: true };
    case CHANNELS.MCP_PARSE:
    case CHANNELS.MCP_IMPORT:
      if (!isObject(args)) return { ok: false, error: '需要 {payload}' };
      if (typeof args.payload !== 'string' && !isObject(args.payload)) return { ok: false, error: 'payload 必须是对象或 JSON 字符串' };
      if (channel === CHANNELS.MCP_IMPORT && args.overwrite != null && typeof args.overwrite !== 'boolean') return { ok: false, error: 'overwrite 必须是 boolean' };
      return { ok: true };
    case CHANNELS.MCP_SET_ENABLED:
      if (!isObject(args) || !isString(args.name) || typeof args.enabled !== 'boolean') return { ok: false, error: '需要 {name: string, enabled: boolean}' };
      return { ok: true };
    case CHANNELS.MCP_DELETE:
      if (!isObject(args) || !isString(args.name)) return { ok: false, error: '需要 {name: string}' };
      return { ok: true };

    // —————————— 模块 E：技能树 ——————————
    case CHANNELS.SKILL_TREE:
    case CHANNELS.SKILL_CATEGORY_LIST:
      return { ok: true };
    case CHANNELS.SKILL_CATEGORY_ADD:
      if (!isObject(args) || !isObject(args.category)) return { ok: false, error: '需要 {category: object}' };
      return { ok: true };
    case CHANNELS.SKILL_CATEGORY_DELETE:
      if (!isObject(args) || !isString(args.id)) return { ok: false, error: '需要 {id: string}' };
      return { ok: true };

    // —————————— 模块 F：市场 ——————————
    case CHANNELS.MARKET_SOURCES:
      return { ok: true };
    case CHANNELS.MARKET_PARSE:
      if (!isObject(args)) return { ok: false, error: '需要 {payload}' };
      if (typeof args.payload !== 'string' && !isObject(args.payload)) return { ok: false, error: 'payload 必须是对象或 JSON 字符串' };
      return { ok: true };
    case CHANNELS.MARKET_FETCH:
      if (!isObject(args) || !isString(args.sourceId) || !isString(args.endpoint)) return { ok: false, error: '需要 {sourceId: string, endpoint: string}' };
      if (args.token != null && !isString(args.token)) return { ok: false, error: 'token 必须是 string' };
      return { ok: true };
    case CHANNELS.MARKET_PLAN:
      if (!isObject(args) || !isObject(args.item)) return { ok: false, error: '需要 {item: object}' };
      if (args.hasToken != null && typeof args.hasToken !== 'boolean') return { ok: false, error: 'hasToken 必须是 boolean' };
      return { ok: true };

    // —————————— 模块 G：备份恢复 ——————————
    case CHANNELS.BACKUP_LIST:
      return { ok: true };
    case CHANNELS.BACKUP_CREATE:
      if (args != null && args.includeSecret != null && typeof args.includeSecret !== 'boolean') return { ok: false, error: 'includeSecret 必须是 boolean' };
      if (args != null && args.label != null && !isString(args.label)) return { ok: false, error: 'label 必须是 string' };
      return { ok: true };
    case CHANNELS.BACKUP_DIFF:
    case CHANNELS.BACKUP_DELETE:
      if (!isObject(args) || !isString(args.id)) return { ok: false, error: '需要 {id: string}' };
      return { ok: true };
    case CHANNELS.BACKUP_RESTORE:
      if (!isObject(args) || !isString(args.id)) return { ok: false, error: '需要 {id: string}' };
      if (args.includeSecret != null && typeof args.includeSecret !== 'boolean') return { ok: false, error: 'includeSecret 必须是 boolean' };
      if (args.force != null && typeof args.force !== 'boolean') return { ok: false, error: 'force 必须是 boolean' };
      return { ok: true };

    // —————————— 模块 H：工作流 ——————————
    case CHANNELS.WORKFLOW_LIST:
      return { ok: true };
    case CHANNELS.WORKFLOW_GET:
    case CHANNELS.WORKFLOW_DELETE:
      if (!isObject(args) || !isString(args.id)) return { ok: false, error: '需要 {id: string}' };
      return { ok: true };
    case CHANNELS.WORKFLOW_SAVE:
      if (!isObject(args) || !isObject(args.workflow)) return { ok: false, error: '需要 {workflow: object}' };
      return { ok: true };
    case CHANNELS.WORKFLOW_RUN:
      if (!isObject(args) || !isString(args.id)) return { ok: false, error: '需要 {id: string}' };
      if (args.dryRun != null && typeof args.dryRun !== 'boolean') return { ok: false, error: 'dryRun 必须是 boolean' };
      if (args.vars != null && !isObject(args.vars)) return { ok: false, error: 'vars 必须是 object' };
      return { ok: true };

    // —————————— 模块 I：成本 ——————————
    case CHANNELS.COST_BUDGET_GET:
      return { ok: true };
    case CHANNELS.COST_REPORT:
      if (args && args.range != null && !inSet(args.range, ALLOWED_RANGE)) return { ok: false, error: 'range 必须是 ' + ALLOWED_RANGE.join('/') };
      return { ok: true };
    case CHANNELS.COST_BUDGET_SET:
      if (!isObject(args) || !isObject(args.budget)) return { ok: false, error: '需要 {budget: object}' };
      return { ok: true };

    // —————————— 模块 J：诊断与通知 ——————————
    case CHANNELS.DIAG_COLLECT:
    case CHANNELS.DIAG_EXPORT:
    case CHANNELS.NOTIFY_CLEAR:
      return { ok: true };
    case CHANNELS.NOTIFY_LIST:
      if (args != null && args.level != null && !isString(args.level)) return { ok: false, error: 'level 必须是 string' };
      if (args != null && args.unreadOnly != null && typeof args.unreadOnly !== 'boolean') return { ok: false, error: 'unreadOnly 必须是 boolean' };
      if (args != null && args.limit != null && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 200)) return { ok: false, error: 'limit 必须 1-200' };
      return { ok: true };
    case CHANNELS.NOTIFY_MARK_READ:
      if (!isObject(args) || !isString(args.id)) return { ok: false, error: '需要 {id: string}' };
      return { ok: true };

    // —————————— 模块 K：终端 / 监控 / 日志流 ——————————
    case CHANNELS.TERMINAL_OPEN:
      if (args != null && args.cwd != null && !isString(args.cwd)) return { ok: false, error: 'cwd 必须是 string' };
      return { ok: true };
    case CHANNELS.TERMINAL_INPUT:
      if (!isObject(args) || !isString(args.sessionId)) return { ok: false, error: '需要 {sessionId: string}' };
      if (typeof args.line !== 'string') return { ok: false, error: 'line 必须是 string' };
      if (args.line.length > 8000) return { ok: false, error: '单条命令过长（≤8000 字符）' };
      return { ok: true };
    case CHANNELS.TERMINAL_CLOSE:
      if (!isObject(args) || !isString(args.sessionId)) return { ok: false, error: '需要 {sessionId: string}' };
      return { ok: true };
    case CHANNELS.MONITOR_STATUS:
      return { ok: true };
    case CHANNELS.LOG_STREAM_START:
      if (args != null && args.lines != null && (!Number.isInteger(args.lines) || args.lines < 1 || args.lines > 5000)) return { ok: false, error: 'lines 必须 1-5000' };
      return { ok: true };
    case CHANNELS.LOG_STREAM_STOP:
      return { ok: true };

    // —— QQ 接入后端（NapCat / SnowLuma）——
    case CHANNELS.QQ_BACKEND_LIST:
      return { ok: true };
    case CHANNELS.QQ_BACKEND_SET:
      if (!isObject(args)) return { ok: false, error: '需要 object' };
      // default 必须是已知后端；config 只能是对象（子字段由服务层白名单化）
      if (args.default != null && !['napcat', 'snowluma'].includes(args.default)) return { ok: false, error: 'default 必须是 napcat|snowluma' };
      if (args.napcat != null && !isObject(args.napcat)) return { ok: false, error: 'napcat 必须是 object' };
      if (args.snowluma != null && !isObject(args.snowluma)) return { ok: false, error: 'snowluma 必须是 object' };
      return { ok: true };
    case CHANNELS.QQ_BACKEND_STATUS:
    case CHANNELS.QQ_BACKEND_START:
    case CHANNELS.QQ_BACKEND_STOP:
    case CHANNELS.QQ_BACKEND_RESTART:
    case CHANNELS.QQ_BACKEND_HEALTH:
      if (!isObject(args) || !['napcat', 'snowluma'].includes(args.id)) return { ok: false, error: '需要 {id: napcat|snowluma}' };
      return { ok: true };
    case CHANNELS.QQ_BACKEND_LOGS:
      if (!isObject(args) || !['napcat', 'snowluma'].includes(args.id)) return { ok: false, error: '需要 {id: napcat|snowluma}' };
      if (args.lines != null && (!Number.isInteger(args.lines) || args.lines < 1 || args.lines > 2000)) return { ok: false, error: 'lines 必须 1-2000' };
      return { ok: true };
    case CHANNELS.SNOWLUMA_DETECT:
      if (args != null && args.dir != null && !isString(args.dir)) return { ok: false, error: 'dir 必须是 string' };
      return { ok: true };

    default:
      return { ok: false, error: '未知通道: ' + channel };
  }
}

module.exports = { CHANNELS, ALLOWED_RANGE, ALLOWED_SECRET_KEYS, validate, isObject, isString, EVENT_CHANNELS, isEventChannel };
