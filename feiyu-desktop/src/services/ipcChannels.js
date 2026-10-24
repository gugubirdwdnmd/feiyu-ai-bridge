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
};

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
    default:
      return { ok: false, error: '未知通道: ' + channel };
  }
}

module.exports = { CHANNELS, ALLOWED_RANGE, ALLOWED_SECRET_KEYS, validate, isObject, isString };
