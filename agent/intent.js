'use strict';
// ================= V14-A：意图识别（纯本地规则，0 Token）=================
// 设计原则：
//   ① 绝不因为进入 Agent 而额外制造一次模型调用 —— 意图判断必须是本地规则；
//   ② 「普通聊天 / 观点类问题」不触发任何工具（最少必要工具调用）；
//   ③ 只有明确需要外部能力时才给出 suggestedTools；
//   ④ suggestedTools 只是「建议」，真正能不能执行由 Tool Registry 决定
//      （未注册 / enabled=false 的工具会被自动忽略，不会报错）。

const INTENTS = [
  'chat',
  'question',
  'knowledge',
  'current_information',
  'image_analysis',
  'video_analysis',
  'file_analysis',
  'web_search',
  'bilibili_search',
  'url_read',
  'chat_record_analysis',
  'memory_query',
  'memory_write',
  'calculation',
  'multi_step_task',
  'image_generation',
];

// 优先级：越靠前越优先作为 primary
const PRIMARY_ORDER = [
  'chat_record_analysis',
  'image_generation',
  'image_analysis',
  'video_analysis',
  'file_analysis',
  'bilibili_search',
  'web_search',
  'url_read',
  'current_information',
  'memory_write',
  'memory_query',
  'calculation',
  'question',
  'knowledge',
  'chat',
];

// —— 生图（V14-D）：让 AI 自己决定画不画，不再靠外层正则硬匹配 ——
//   两档匹配，兼顾召回与误触：
//   ① 强动词（画/绘/生成）允许隔字：「生成被摸头疾旋鼬的图片」「画一个女孩在樱花树下」都算；
//   ② 弱动词（做/整/来/搞/出）必须紧贴量词+图类词：「来张壁纸」「做一张图」算，
//      避免「过来看看这张图」「做一下这张图的分析」被误判成要画图（答非所问）。
//   「把这张图改成X风格」这类改造词在有图时算图生图（见 GEN_EDIT_RE）。
const GEN_NOUN = '(图|图片|插画|漫画|头像|壁纸|海报|立绘|油画|水墨|水彩|赛博|风景|人物|场景)';
const GEN_STRONG_RE = new RegExp('(画|绘|生成).{0,24}' + GEN_NOUN);
const GEN_WEAK_RE = new RegExp('(做|整|来|搞|出)\\s*[一无两三四五六七八九十\\d]?\\s*[个只张条幅座棵片套]?\\s*' + GEN_NOUN);
const GEN_RE = new RegExp(GEN_STRONG_RE.source + '|' + GEN_WEAK_RE.source);
const GEN_VERB_RE = /(画|绘|生成|做|整|来|搞)[一无]?[个只张条幅座棵片套]/;
// 图生图信号：改造 / 重绘 / 按这个风格 / 替换 / 换脸 / 融合
const GEN_EDIT_RE = /(改(成|为|一下|一)?|变成|换成|换为|替换|替成|重绘|重画|改画|换脸|融合|合成|风格化|图生图|以图生图|img2img|按(这|这个)|照(这|这个)|拿(这|这张)|用(这|这张)|(这|这种|这个)风格|同款|这样子的)/i;
// 排除：询问能力、抱怨画得烂、问怎么画 —— 这些不是「现在给我画一张」
const GEN_DENY_RE = /(吗\s*[?？]?$|呢\s*[?？]?$|怎么画|怎么才能|为什么|能不能画|会不会画|可以画吗|画不了|画不出|没收到|画成啥|画成什么|画的是啥|这画的是|你画的是|跌画|画错了|重新画一下刚才|你会画)/;

// 从整句里抠出「要画什么」：去掉 @、称呼、生图动词、量词、语气词
function extractImagePrompt(text) {
  let q = String(text || '').trim();
  q = q.replace(/@[^\s]{1,20}/g, ' ');
  q = q.replace(/\[[^\]]{0,30}\]/g, ' ');                     // [图片]/[表情] 等段占位
  q = q.replace(/^(那个|那个谁|喂|哎|诶|嘿)?\s*/, '');
  q = q.replace(/^(帮我|请|麻烦|能不能|可以|想|麻烦你|给我|给我来|来|我要)/, '');
  // 去掉生图动词 + 量词（画一张 / 画个 / 生成一张）；「来张壁纸」先被上面的「来」吃掉，
  // 会留下句首量词，这里再补一刀
  q = q.replace(/^(画|绘|生成|做|整|搞|出)[一无两三四五六七八九十\d]?[个只张条幅座棵片套]?/, '');
  q = q.replace(/^(个|只|张|条|幅|座|棵|片|套)\s*/, '');
  q = q.replace(/^(图片|图|画)\s*/, '');
  q = q.replace(/^(的)/, '');
  q = q.replace(/\s*(呗|吧|哈|呀|哦|嘛|咯)\s*$/, '');
  q = q.replace(/[。.!！]+$/, '');
  q = q.replace(/\s{2,}/g, ' ').trim();
  // 只在抠空时才退回原句。注意别设长度下限：单字主体（「猫」「狗」）是合法且常见的。
  if (!q) q = String(text || '').replace(/@[^\s]{1,20}/g, ' ').replace(/\[[^\]]{0,30}\]/g, ' ').trim();
  return q.slice(0, 300);
}

// 图生图：在通用清洗之上，再剥掉「把这张图改成 / 按这个风格 / 重绘一下」这类改造指令，
// 只留下「要变成什么样」（如「油画风格」）。抠空就退回通用结果，绝不返回空。
function extractEditPrompt(text) {
  const base = extractImagePrompt(text);
  let q = base;
  q = q.replace(/^(把|将)?\s*(这|这张|这个)?\s*(张)?\s*(图|图片|照片)?\s*(改画|改成|改为|变换|变成|换成|换为|重绘|重画|做成|弄成|画成|画为|风格化)\s*(成|为|一下|一)?/, '');
  q = q.replace(/^(按|照|拿|用)\s*(这|这个|这张)?\s*(图|图片|风格|样子|种)?\s*(风格|样子)?\s*(来|再|做|画|生成)?\s*(一)?\s*(下|张|个)?/, '');
  q = q.replace(/^(帮我|麻烦|请)?\s*(改|重画|重绘|换个)\s*(成|为|一下|一)?/, '');
  // 再剥一层残留：指令词被部分吃掉后可能剩下「图变成X」「风格再来一张」
  q = q.replace(/^(图|图片|照片)\s*/, '');
  q = q.replace(/^(变成|改成|换成|画成|做成|弄成|改为|换为|重绘|重画)\s*/, '');
  q = q.replace(/^(的|风格|样子)\s*/, '');
  q = q.replace(/\s*(一下|的样子|这样子的)\s*$/, '');
  q = q.replace(/[。.!！]+$/, '').trim();
  return q || base;
}

// —— 实时信息：时间词 + 主题词 同时命中才算（避免「GTA6怎么样」被误判成要搜）——
const TIME_WORDS = /(最新|最近|今日|今天|现在|刚刚|目前|实时|今年|这周|本周|本月|近况|新动向|有什么新)/;
const TOPIC_WORDS = /(新闻|消息|动态|进展|更新|发布|上线|发售|价格|多少钱|汇率|股价|天气|比分|排名|版本|补丁|官宣|爆料)/;
// 显式要求搜
const EXPLICIT_SEARCH = /(搜一下|搜索|搜搜|查一下|查查|帮我查|查查看|上网查|百度|谷歌|google|bing|查一查|查个)/;
// 纯时间查询（不需要联网，直接取本机时间）
const TIME_QUERY_RE = /(现在几点|几点了|几点钟|今天几号|几号了|今天星期几|星期几|今天日期|现在日期|现在时间|今天是什么日子|农历)/;
// B站
const BILI_RE = /(b站|bilibili|哔哩哔哩|BV[0-9A-Za-z]{8,12}|av\d{5,}|UP主|up主)/i;
// B站：只是提到"B站/UP主"不算，还得有「搜/找/查」或明确的 BV/av 号
const BILI_ID_RE = /(BV[0-9A-Za-z]{8,12}|av\d{5,})/i;
const BILI_SEARCH_RE = /(搜一下|搜索|搜搜|搜个|找一下|找找|帮我找|找几个|有没有|查一下|查查|看看.*视频|推荐)/;
// 文件相关（V14-B：没有具体文件名时先列目录）
const FILE_KEYWORD_RE = /(文件|文档|表格|记事本|看看我存|存过什么|读一下|打开.*文件)/;
// 视频（只在「用户要看视频内容」时才触发，避免每条带视频的消息都分析）
const VIDEO_RE = /(分析|看|讲|说|读|解析|看下|看一下).{0,6}视频|视频.{0,6}(说|讲|内容|里|中|啥|什么|讲了)|视频关键帧|这个视频|视频是(啥|什么)/;
// 图片（V14-C：只在「确实要分析这张图」时才走 image_analysis；
//       普通带图消息继续走 V13 已有的单次多模态链路，更省 Token，也不重复计费）
const IMAGE_RE = /(这(张|个)?图|图片(里|中|上)|图(里|上|中)|识别(一下|下)?|看看(这|这张)?图|看图|分析(一下)?(这|这张)?图|图(上|里)(写的|写的啥|写什么|是什么)|写(的)?(啥|什么)|念一下|读一下|啥图|什么图)/;
// 记忆
const MEM_WRITE_RE = /(记住|记一下|记着|以后叫我|以后就叫我|帮我记|别忘了|我叫.{1,6}就好)/;
const MEM_QUERY_RE = /(你记得|还记得|我叫什么|我之前说过|上次我说|我跟你说过|记得我说过)/;
// 计算
const CALC_RE = /(等于多少|算一下|计算|几加几|[\d]+\s*[\+\-\*\/×÷]\s*[\d]+)/;
// 纯算术表达式
const PURE_MATH = /^[\d\s\+\-\*\/\(\)\.％%＋－×÷＝=]+$/;
// 聊天/寒暄
const GREETING_RE = /^\s*(你好|您好|hi|hello|哈喽|嗨|在吗|在么|早|早上好|中午好|晚上好|下午好|嗨呀|hey)\s*[!！。.~\s]*$/i;
// 提问信号
const QUESTION_RE = /[?？]|吗|呢|怎么|为什么|如何|什么|谁|哪|几|能否|可以吗|是不是|有没有/;

function hasRe(t, re) {
  return re.test(String(t || ''));
}

// 从整句里抽出搜索关键词：去掉称呼/套话/标点，限长
function extractQuery(text) {
  let q = String(text || '').trim();
  q = q.replace(/@[^\s]{1,20}/g, ' ');                       // 去掉 @
  q = q.replace(/^(帮我|请|麻烦|能不能|可以|想|麻烦你)/, '');
  q = q.replace(/(搜一下|搜索|搜搜|查一下|查查|帮我查|查查看|上网查|百度一下|百度|谷歌)/g, ' ');
  q = q.replace(/(的)?(最新|最近|今日|今天|现在|有什么|怎么样|如何|消息|新闻|情况)/g, ' ');
  q = q.replace(/[?？。.!！，,、\s]+/g, ' ').trim();
  q = q.replace(/\s{2,}/g, ' ');
  if (!q) q = String(text || '').slice(0, 30);
  return q.slice(0, 40);
}

// V14-C.1：B站搜索关键词清洗 —— 去掉平台词（B站/视频）和套话，别把噪音当关键词
const BILI_NOISE_RE = /(b站|bilibili|哔哩哔哩)/gi;
const BILI_VERB_RE = /(搜一下|搜索|搜搜|搜个|找一下|找找|帮我找|找几个|查一下|查查|有没有|推荐|相关|一下|几个)/g;
function extractBiliQuery(text) {
  let q = extractQuery(text);
  q = q.replace(BILI_NOISE_RE, ' ').replace(BILI_VERB_RE, ' ').replace(/\s*视频\s*/g, ' ');
  q = q.replace(/^\s*(帮我|请|麻烦)?\s*(找|搜|查)?\s*/, ' ');     // 句首残留的「找/搜/查」
  q = q.replace(/[?？。.!！，,、\s]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!q) {
    // 清洗过度（比如整句只有「B站」）→ 退回只去掉平台词的原始 query，绝不返回空
    q = extractQuery(text).replace(BILI_NOISE_RE, ' ')
      .replace(/[?？。.!！，,、\s]+/g, ' ').trim();
  }
  if (!q) q = String(text || '').slice(0, 30);
  return q.slice(0, 40);
}

// V14-C.2 修复 B：URL / 分享卡片确定性触发 fetch_url
//  · 分享卡片前缀由 ai_bridge 的 extractShareCard() 生成，形如「[分享卡片] 小黑盒｜标题」
//  · 只对「纯链接」或「分享卡片」启用确定性路径，普通聊天里顺带提的网址不触发（避免过度调用）
const SHARE_CARD_PREFIX = '[分享卡片]';
const URL_RE = /https?:\/\/[^\s\u4e00-\u9fff"'<>）)】\]]+/i;
const URL_RE_G = /https?:\/\/[^\s\u4e00-\u9fff"'<>）)】\]]+/gi;
const MAX_URLS_PER_MSG = 2;        // 单条消息最多认 2 个 URL，不允许无限抓取

function extractUrls(text) {
  const t = String(text || '');
  const out = [];
  const re = new RegExp(URL_RE.source, 'gi');
  let m;
  while ((m = re.exec(t)) !== null) {
    let u = String(m[0]).replace(/[。，、；;！!？?）)\]】"'']+$/g, '');   // 去掉粘在末尾的中文标点
    if (u && out.indexOf(u) < 0) out.push(u);
    if (out.length >= MAX_URLS_PER_MSG) break;
  }
  return out;
}

/**
 * 识别意图
 * @param {string} text 用户文本
 * @param {object} signals { hasImage, hasVideo, hasFile, hasForward, isAtMe, replyToBot, isGroup }
 * @returns {object} { intents, primary, needsTools, suggestedTools, confidence, reason }
 */
function detectIntent(text, signals) {
  const t = String(text || '');
  const s = signals || {};
  const intents = [];
  const suggested = [];
  const push = (i) => { if (intents.indexOf(i) < 0) intents.push(i); };
  const tool = (name, args, why) => suggested.push({ tool: name, args: args || {}, why: why || '' });

  // —— V14-C.2：分享卡片 / 纯链接的素材（供 ⑤⑦⑦b 使用）——
  const isCard = t.indexOf(SHARE_CARD_PREFIX) === 0;
  const urls = extractUrls(t);
  // 去掉 URL 后还剩多少「话」：几乎没剩 = 用户只是丢了个链接过来
  const restLen = t.replace(URL_RE_G, ' ').replace(/[\s?？。.!！，,、]/g, '').trim().length;

  // ① 聊天记录 / 合并转发
  if (s.hasForward) {
    push('chat_record_analysis');
    tool('chat_record_analysis', { question: t }, 'forward');
  }

  // ①b 生图（V14-D）：命中 → 建议 generate_image，由工具自己出图并发到聊天
  //     这是「AI 自己决定画不画」的入口，取代外层正则硬匹配。
  let genHit = false;
  if (s.imageGeneration !== false && !hasRe(t, GEN_DENY_RE)) {
    const hasAnyImage = !!(s.hasImage || s.hasRecentImage);
    const editHit = hasAnyImage && hasRe(t, GEN_EDIT_RE);
    if (hasRe(t, GEN_RE) || hasRe(t, GEN_VERB_RE) || editHit) {
      genHit = true;
      push('image_generation');
      tool('generate_image', {
        prompt: editHit ? extractEditPrompt(t) : extractImagePrompt(t),
        // 只有明确要「改这张图」时才带 source，避免「画只猫」被误当成图生图
        source: editHit ? '1' : '',
      }, editHit ? 'img2img' : 'txt2img');
    }
  }

  // ② 图片（V14-C：image_analysis 工具）
  //    · 聊天记录里的图：现有链路拿不到，必须走工具；
  //    · 当前消息的图：只有「确实在问这张图」时才走工具，
  //      否则交回 V13 已有的单次多模态链路（更省 Token，且不重复计费）。
  //    · V14-D：已经要生图了就不再同时做识图（「把这张图改成油画」不需要先识别一遍）
  if (s.hasForward && s.hasChatRecordImage) {
    push('image_analysis');
    tool('image_analysis', { question: t, source: 'chat_record' }, 'chat-record-image');
  } else if (!genHit && s.hasImage && (hasRe(t, IMAGE_RE) || hasRe(t, QUESTION_RE))) {
    push('image_analysis');
    tool('image_analysis', { question: t, source: 'current_message' }, 'image-segment+analyze-intent');
  } else if (s.hasImage) {
    push('image_analysis');                     // 登记意图，但**不**建议工具 → 走原有链路
  }

  // ③ 视频（必须用户明确要看内容；视频可能在当前消息里，也可能在刚解析的聊天记录里）
  const videoInRecord = !s.hasVideo && !!s.hasChatRecordVideo;
  if ((s.hasVideo || videoInRecord) && hasRe(t, VIDEO_RE)) {
    push('video_analysis');
    tool('video_analysis', {
      question: t,
      source: s.hasVideo ? 'current_message' : 'chat_record',
    }, s.hasVideo ? 'video-segment' : 'record-video');
  }

  // ④ 文件（V14-B：先列目录找到文件；若用户点名了具体文件名就直接读）
  const FILE_NAME_RE = /([\w\u4e00-\u9fa5\-]{1,40}\.(?:txt|md|csv|json|html|htm|xml|log|ini|yml|yaml|sql))/i;
  const fileNamed = t.match(FILE_NAME_RE);
  if (s.hasFile || hasRe(t, FILE_KEYWORD_RE)) {
    push('file_analysis');
    if (fileNamed) tool('file_read', { path: fileNamed[1] }, 'file-name-in-text');
    else tool('file_list', {}, 'file-keyword');
  }

  // ⑤ B站（必须带「搜/找」意图或 BV/av 号；只是提到"B站/UP主"不算）
  //    V14-C.1：B站专属意图**优先于**普通 Web 搜索 —— 命中后本轮不再建议 web_search，
  //    否则「B站搜索一下GTA6视频」会因为「搜索」二字同时触发 bilibili_search + web_search。
  //    V14-C.2：分享卡片只是「转发过来的内容」，不是搜索请求 —— 卡片里就算出现"推荐/看看视频"
  //    也不该被当成搜索指令（B站卡片的 desc 很容易撞上 BILI_SEARCH_RE）。
  let biliHit = false;
  if (!isCard && (BILI_ID_RE.test(t) || (hasRe(t, BILI_RE) && hasRe(t, BILI_SEARCH_RE)))) {
    biliHit = true;
    push('bilibili_search');
    tool('bilibili_search', { query: extractBiliQuery(t) }, 'bili-keyword');
  }

  // ⑥ 纯时间查询（本机时间即可，不联网）
  if (hasRe(t, TIME_QUERY_RE)) {
    push('current_information');
    tool('get_current_time', {}, 'time-query');
  }

  // ⑦ Web / 实时信息
  const explicit = hasRe(t, EXPLICIT_SEARCH);
  const realtime = hasRe(t, TIME_WORDS) && hasRe(t, TOPIC_WORDS);
  // V14-C.1：B站已命中 → 屏蔽普通网页搜索（同一次意图判定里只保留 bilibili_search）
  // V14-C.2：分享卡片同理 —— 它是「内容」不是「搜索请求」
  if (!biliHit && !isCard && (explicit || realtime)) {
    push('current_information');
    push('web_search');
    tool('web_search', { query: extractQuery(t) }, explicit ? 'explicit' : 'realtime');
  }

  // ⑦b V14-C.2：URL / 分享卡片 → 确定性 fetch_url
  //     触发条件刻意收紧：必须「有 URL」且（是分享卡片 或 去掉链接后几乎没别的话）。
  //     普通聊天里顺带提到的网址不在此列，避免每条带链接的消息都去抓一次。
  //     工具用现成的 fetch_url，不新建抓取工具；能不能执行仍由 Tool Router 决定。
  if (!biliHit && urls.length && (isCard || restLen <= 4)) {
    push('url_read');
    tool('fetch_url', { url: urls[0] }, isCard ? 'share-card' : 'bare-url');
  }

  // ⑦ 记忆写 / 读
  if (hasRe(t, MEM_WRITE_RE)) {
    push('memory_write');
    tool('memory_write', { content: t }, 'memory-write');
  }
  if (hasRe(t, MEM_QUERY_RE)) {
    push('memory_query');
    tool('memory_search', { query: extractQuery(t) }, 'memory-query');
  }

  // ⑧ 计算
  if (hasRe(t, CALC_RE) || PURE_MATH.test(t.trim())) {
    push('calculation');
  }

  // ⑨ 提问 / 知识 / 闲聊
  if (hasRe(t, QUESTION_RE)) push('question');
  if (GREETING_RE.test(t)) push('chat');
  if (!intents.length) push('chat');

  // ⑩ 多步骤：建议工具 ≥2，或出现「先…再/然后…」且有工具
  const seq = /先.{0,24}(再|然后|接着|之后)|然后|接着|之后再|顺便|并且|还有/;
  const usable = suggested.length;
  if (usable >= 2 || (usable >= 1 && seq.test(t))) push('multi_step_task');

  // primary
  let primary = 'chat';
  for (const p of PRIMARY_ORDER) {
    if (intents.indexOf(p) >= 0) { primary = p; break; }
  }

  // confidence：命中越明确越高
  let confidence = 0.5;
  if (s.hasForward) confidence = 0.95;
  else if (s.hasImage) confidence = 0.9;
  else if (explicit) confidence = 0.9;
  else if (realtime) confidence = 0.8;
  else if (hasRe(t, BILI_RE)) confidence = 0.85;
  else if (isCard || (urls.length && restLen <= 4)) confidence = 0.9;
  else if (hasRe(t, MEM_WRITE_RE) || hasRe(t, MEM_QUERY_RE)) confidence = 0.85;
  else if (GREETING_RE.test(t)) confidence = 0.95;
  else if (intents.indexOf('question') >= 0) confidence = 0.7;

  return {
    intents,
    primary,
    needsTools: suggested.length > 0,
    suggestedTools: suggested,
    confidence,
    reason: 'rule-based',
    text: t,
  };
}

module.exports = { INTENTS, PRIMARY_ORDER, detectIntent, extractQuery, extractBiliQuery, extractUrls, SHARE_CARD_PREFIX, MAX_URLS_PER_MSG };
