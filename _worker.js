// 全局内存缓存（L1 缓存）
const tgUserModels = new Map();

// 优化：不再校验 env 的引用，因为 Worker 生命周期内环境变量是恒定的
let cachedConfig = null; 

// 复用 HTTP 响应头结构
const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Access-Token',
};

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
};

const HTML_HEADERS = { 'Content-Type': 'text/html;charset=UTF-8' };
const TEXT_HEADERS = { 'Content-Type': 'text/plain;charset=UTF-8' };

// ================= PWA =================
// 图标以 base64 内嵌，运行时解码；不引入任何静态资源文件，
// 保证「单文件 Worker / 无额外构建产物」的部署方式不被破坏。
const ICON_B64 = {
  '/icon-192.png': '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',
  '/icon-512.png': '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',
  '/icon-maskable-512.png': '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',
};

const PNG_HEADERS = {
  'Content-Type': 'image/png',
  'Cache-Control': 'public, max-age=86400',
  'Access-Control-Allow-Origin': '*',
};

const MANIFEST_HEADERS = {
  'Content-Type': 'application/manifest+json;charset=UTF-8',
  'Cache-Control': 'public, max-age=3600',
  'Access-Control-Allow-Origin': '*',
};

// SW 必须挂在根路径，并显式声明 scope；no-cache 保证新版本能及时下发
const SW_HEADERS = {
  'Content-Type': 'application/javascript;charset=UTF-8',
  'Service-Worker-Allowed': '/',
  'Cache-Control': 'no-cache',
};

const HEALTH_HEADERS = {
  'Content-Type': 'application/json;charset=UTF-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
};

// 解码结果缓存，同一 isolate 内只解一次
const iconBytesCache = new Map();

function b64ToBytes(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function getIconBytes(pathname) {
  if (iconBytesCache.has(pathname)) return iconBytesCache.get(pathname);
  const b64 = ICON_B64[pathname];
  if (!b64) return null;
  const bytes = b64ToBytes(b64);
  iconBytesCache.set(pathname, bytes);
  return bytes;
}

// PWA 缓存版本号 = 前端页面 + SW 源码的内容哈希。
// 好处：只要改了页面或 SW，版本号自动变化 → 浏览器触发更新 → activate 清掉旧缓存。
// 因为它是纯函数（只依赖源码文本），isolate 重启后依然稳定，不会导致 SW 反复更新。
let cachedPwaVersion = null;
function getPwaVersion() {
  if (cachedPwaVersion) return cachedPwaVersion;
  const s = HTML_CONTENT + SW_JS;
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  }
  cachedPwaVersion = (h >>> 0).toString(36);
  return cachedPwaVersion;
}


function parseCommaSeparated(str) {
  if (!str) return [];
  return str.split(',').map(s => s.trim()).filter(Boolean);
}

// 定长比较，避免通过响应耗时逐字节猜解口令
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

// /api/chat 访问口令校验
// 未配置 ACCESS_PASSWORD 时返回 null（直接放行，行为与从前一致）；
// 配置后要求请求头 X-Access-Token 与之一致，否则返回 401。
function denyUnauthorized(env, request) {
  const required = env.ACCESS_PASSWORD;
  if (!required) return null;

  const provided = request.headers.get('X-Access-Token') || '';
  if (safeEqual(provided, required)) return null;

  return new Response(JSON.stringify({
    error: "访问口令错误或未提供",
    code: "UNAUTHORIZED",
  }), { status: 401, headers: CORS_HEADERS });
}

// ======= 按 IP 滑动窗口限流（isolate 级内存，轻量防刷） =======
// 环境变量 RATE_LIMIT_PER_MIN：每 IP 每分钟允许的 /api/chat 请求数，默认 60；设为 0 关闭。
const rateLimitMap = new Map();
function hitRateLimit(request, env) {
  const perMin = parseInt(env.RATE_LIMIT_PER_MIN || '60', 10);
  if (!(perMin > 0)) return false;
  const ip = request.headers.get('CF-Connecting-IP')
    || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim()
    || 'unknown';
  const now = Date.now();
  let arr = rateLimitMap.get(ip) || [];
  arr = arr.filter(t => now - t < 60000);
  if (arr.length >= perMin) return true;
  arr.push(now);
  rateLimitMap.set(ip, arr);
  if (rateLimitMap.size > 5000) rateLimitMap.clear(); // 防止 Map 无限增长
  return false;
}

// ======= Telegram 多轮对话历史（内存 L1 + R2 L2） =======
const tgHistories = new Map();
function tgHistoryKey(chatId) { return 'tg_hist_' + chatId; }
function tgTrimHistory(history, env) {
  let maxRounds = parseInt(env.TG_HISTORY_ROUNDS || '10', 10);
  if (!(maxRounds > 0)) maxRounds = 10;
  if (maxRounds > 30) maxRounds = 30;
  const maxMsgs = maxRounds * 2;
  while (history.length > maxMsgs) history.shift();
  // 字符预算：超长历史从最旧开始丢弃，保证单次请求可控
  const budget = 12000;
  let total = 0;
  for (let i = 0; i < history.length; i++) total += String(history[i].content || '').length;
  while (history.length > 2 && total > budget) {
    const dropped = history.shift();
    total -= String(dropped.content || '').length;
  }
  return history;
}
// ==================== 持久化层：R2 ====================
// v6.3.1 起彻底移除 KV，只用 R2：无日写入上限（免费版每月 100 万次 A 类操作）、
// 单对象可达 5TB、读写强一致。未绑定 R2 时退化为纯内存
// （isolate 重启丢失；Telegram 机器人需要持久化，请务必绑定 R2）。
async function storeGet(env, key) {
  if (!env.R2) return null;
  try {
    const obj = await env.R2.get(key);
    if (obj) return await obj.text();
  } catch (e) {}
  return null;
}

async function storePut(env, key, value) {
  if (!env.R2) return;
  try { await env.R2.put(key, String(value)); } catch (e) {}
}

async function storeDelete(env, key) {
  if (!env.R2) return;
  try { await env.R2.delete(key); } catch (e) {}
}

async function tgGetHistory(env, chatId) {
  if (tgHistories.has(chatId)) return tgHistories.get(chatId);
  const raw = await storeGet(env, tgHistoryKey(chatId));
  if (raw) {
    try {
      const h = JSON.parse(raw);
      if (Array.isArray(h)) { tgHistories.set(chatId, h); return h; }
    } catch (e) {}
  }
  return [];
}
async function tgSaveHistory(env, chatId, history) {
  tgHistories.set(chatId, history);
  await storePut(env, tgHistoryKey(chatId), JSON.stringify(history));
}
async function tgClearHistory(env, chatId) {
  tgHistories.delete(chatId);
  await storeDelete(env, tgHistoryKey(chatId));
}

// ==================== Telegram Agent：工具定义 ====================
// 全部工具零密钥、零成本：DuckDuckGo（搜索）、任意网页抓取、自研计算器、
// Open-Meteo（天气）、Intl（时间）、R2（长期记忆）。
function getAgentTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: '联网搜索最新信息。当问题涉及实时新闻、时事、价格、股价等时效性内容，或超出你知识范围时使用。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
            count: { type: 'integer', description: '返回条数，1-8，默认5' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: '抓取指定网页的正文纯文本，用于总结文章、阅读文档页面。返回清理后的文本（截断）。',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: '完整的 http(s) URL' } },
          required: ['url']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'calculate',
        description: '精确数学计算，支持加减乘除、乘方(^)、取余(%)、括号。复杂计算不要心算，一律用此工具。',
        parameters: {
          type: 'object',
          properties: { expression: { type: 'string', description: '如 (3+5)*2^3/4' } },
          required: ['expression']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_time',
        description: '获取当前时间，可指定 IANA 时区。',
        parameters: {
          type: 'object',
          properties: { timezone: { type: 'string', description: '如 Asia/Shanghai，默认 Asia/Shanghai' } }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: '查询指定城市当前天气与今明两天预报。',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string', description: '城市名，如"北京"、"Tokyo"' } },
          required: ['city']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'remember',
        description: '把关于用户的重要长期信息存入记忆（如偏好、生日、项目名、常用城市）。存入后以后所有对话都会记得。',
        parameters: {
          type: 'object',
          properties: { fact: { type: 'string', description: '一句话事实' } },
          required: ['fact']
        }
      }
    }
  ];
}

async function execAgentTool(name, args, env, chatId) {
  try {
    switch (name) {
      case 'web_search': return await toolWebSearch(args.query, args.count);
      case 'web_fetch': return await toolWebFetch(args.url);
      case 'calculate': return toolCalculate(args.expression);
      case 'get_time': return toolGetTime(args.timezone);
      case 'get_weather': return await toolGetWeather(args.city);
      case 'remember': return await agentSaveMemory(env, chatId, args.fact);
      default: return '未知工具: ' + name;
    }
  } catch (e) {
    return '工具执行失败: ' + (e && e.message ? e.message : String(e));
  }
}

async function toolWebSearch(query, count) {
  query = String(query || '').trim();
  if (!query) return '搜索关键词为空';
  count = Math.min(Math.max(parseInt(count) || 5, 1), 8);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
      signal: ctrl.signal
    });
    if (!res.ok) return '搜索请求失败，HTTP ' + res.status;
    const html = await res.text();
    const out = [];
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && out.length < count) {
      let href = m[1];
      const uddg = href.match(/[?&]uddg=([^&]+)/);
      try { if (uddg) href = decodeURIComponent(uddg[1]); } catch (e) {}
      const title = m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      if (title && href && href.startsWith('http')) out.push({ title, url: href });
    }
    if (!out.length) return '搜索「' + query + '」无结果';
    let text = '搜索「' + query + '」结果：\n';
    out.forEach((r, i) => { text += (i + 1) + '. ' + r.title + '\n   ' + r.url + '\n'; });
    return text.slice(0, 3000);
  } catch (e) {
    return '搜索失败: ' + (e.name === 'AbortError' ? '超时' : e.message);
  } finally { clearTimeout(timer); }
}

async function toolWebFetch(url) {
  url = String(url || '').trim();
  if (!/^https?:\/\//i.test(url)) return 'URL 非法，仅支持 http/https';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
      signal: ctrl.signal, redirect: 'follow'
    });
    if (!res.ok) return '抓取失败，HTTP ' + res.status;
    const ct = res.headers.get('content-type') || '';
    if (/pdf|image|video|audio|octet-stream/i.test(ct)) return '不支持抓取该类型内容(' + ct + ')';
    let html = await res.text();
    if (html.length > 500000) html = html.slice(0, 500000);
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ').trim();
    if (!text) return '页面无有效文本内容';
    return text.slice(0, 6000);
  } catch (e) {
    return '抓取失败: ' + (e.name === 'AbortError' ? '超时' : e.message);
  } finally { clearTimeout(timer); }
}

// 安全计算器：递归下降解析，绝不使用 eval
function toolCalculate(expr) {
  try {
    const s = String(expr || '').replace(/\s+/g, '').replace(/×/g, '*').replace(/÷/g, '/');
    if (!s) return '表达式为空';
    if (/[^0-9+\-*/%^().]/.test(s)) return '表达式含非法字符';
    let i = 0;
    function parseExpr() {
      let v = parseTerm();
      while (i < s.length && (s[i] === '+' || s[i] === '-')) {
        const op = s[i++]; const r = parseTerm();
        v = op === '+' ? v + r : v - r;
      }
      return v;
    }
    function parseTerm() {
      let v = parseFactor();
      while (i < s.length && (s[i] === '*' || s[i] === '/' || s[i] === '%')) {
        const op = s[i++]; const r = parseFactor();
        v = op === '*' ? v * r : op === '/' ? v / r : v % r;
      }
      return v;
    }
    function parseFactor() {
      // 一元正负号优先级低于乘方：-3^2 = -(3^2) = -9
      if (s[i] === '-') { i++; return -parseFactor(); }
      if (s[i] === '+') { i++; return parseFactor(); }
      let v = parsePrimary();
      if (i < s.length && s[i] === '^') { i++; v = Math.pow(v, parseFactor()); }
      return v;
    }
    function parsePrimary() {
      if (s[i] === '(') { i++; const v = parseExpr(); if (s[i] !== ')') throw new Error('括号不匹配'); i++; return v; }
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      if (j === i) throw new Error('意外的字符: ' + s[i]);
      const n = parseFloat(s.slice(i, j)); i = j;
      if (!isFinite(n)) throw new Error('数字非法');
      return n;
    }
    const v = parseExpr();
    if (i !== s.length) throw new Error('表达式未完全解析');
    if (!isFinite(v)) return '计算结果非法（可能除零）';
    return '计算结果：' + String(Math.round(v * 1e10) / 1e10);
  } catch (e) { return '计算失败: ' + e.message; }
}

function toolGetTime(timezone) {
  const tz = String(timezone || 'Asia/Shanghai').trim() || 'Asia/Shanghai';
  try {
    const fmt = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'long'
    });
    return '当前时间（' + tz + '）：' + fmt.format(new Date());
  } catch (e) { return '时区无效: ' + tz; }
}

async function toolGetWeather(city) {
  city = String(city || '').trim();
  if (!city) return '城市名为空';
  try {
    const g = await (await fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(city) + '&count=1&language=zh&format=json')).json();
    if (!g.results || !g.results.length) return '找不到城市：' + city;
    const loc = g.results[0];
    const w = await (await fetch('https://api.open-meteo.com/v1/forecast?latitude=' + loc.latitude + '&longitude=' + loc.longitude +
      '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m' +
      '&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&forecast_days=2')).json();
    const wm = { 0: '晴', 1: '大致晴', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇', 51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨', 71: '小雪', 73: '中雪', 75: '大雪', 80: '阵雨', 81: '阵雨', 82: '暴雨', 95: '雷阵雨' };
    const c = w.current, d = w.daily;
    let t = loc.name + '（' + (loc.country || '') + '）当前：' + (wm[c.weather_code] || '未知') +
      '，' + c.temperature_2m + '°C，体感' + c.apparent_temperature + '°C，湿度' + c.relative_humidity_2m + '%，风速' + c.wind_speed_10m + 'km/h\n';
    t += '今明两天：' + d.time.map((dt, i) => dt.slice(5) + ' ' + (wm[d.weather_code[i]] || '') + ' ' + d.temperature_2m_min[i] + '~' + d.temperature_2m_max[i] + '°C').join('；');
    return t;
  } catch (e) { return '天气查询失败: ' + e.message; }
}

// ==================== Telegram Agent：长期记忆 + 开关 ====================
const tgAgentMemCache = new Map();
const tgAgentModeCache = new Map();

async function agentGetMemories(env, chatId) {
  if (tgAgentMemCache.has(chatId)) return tgAgentMemCache.get(chatId);
  let arr = [];
  const raw = await storeGet(env, 'agent_mem_' + chatId);
  if (raw) {
    try { const p = JSON.parse(raw); if (Array.isArray(p)) arr = p; } catch (e) {}
  }
  tgAgentMemCache.set(chatId, arr);
  return arr;
}

async function agentSaveMemory(env, chatId, fact) {
  const arr = await agentGetMemories(env, chatId);
  fact = String(fact || '').trim().slice(0, 200);
  if (!fact) return '内容为空，未保存';
  if (arr.some(m => m.fact === fact)) return '已记住过，无需重复保存';
  arr.push({ fact, ts: Date.now() });
  // R2 存储近乎无限，不再限制记忆条数；仅保留极宽松的单对象保护
  while (arr.length > 2000) arr.shift();
  tgAgentMemCache.set(chatId, arr);
  await storePut(env, 'agent_mem_' + chatId, JSON.stringify(arr));
  return '已记住：' + fact + '（共' + arr.length + '条）';
}

async function agentGetMode(env, chatId) {
  if (tgAgentModeCache.has(chatId)) return tgAgentModeCache.get(chatId);
  let on = true; // 默认开启 Agent 模式
  const v = await storeGet(env, 'agent_mode_' + chatId);
  on = v !== '0';
  tgAgentModeCache.set(chatId, on);
  return on;
}

async function agentSetMode(env, chatId, on) {
  tgAgentModeCache.set(chatId, on);
  await storePut(env, 'agent_mode_' + chatId, on ? '1' : '0');
}

function buildAgentSystemPrompt(memories) {
  const now = new Date();
  let timeStr = '';
  try {
    timeStr = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'full', timeStyle: 'short' }).format(now);
  } catch (e) { timeStr = now.toISOString(); }
  let p = '你是 Cloudflare-Chat 智能助手，一个具备自主规划、工具调用和长期记忆能力的 AI Agent。\n';
  p += '当前时间：' + timeStr + '（北京时间）。\n';
  if (memories.length) {
    // 存储无上限，但每次注入按字符预算取最新的，避免 prompt 过长烧 token
    let budget = 6000;
    const picked = [];
    for (let i = memories.length - 1; i >= 0; i--) {
      const f = String(memories[i].fact || '');
      if (!f || f.length > budget) continue;
      picked.unshift(f);
      budget -= f.length;
    }
    p += '【关于用户的长期记忆】（共' + memories.length + '条' +
      (picked.length < memories.length ? '，本次注入最近' + picked.length + '条' : '') + '）\n' +
      picked.map(f => '- ' + f).join('\n') + '\n';
  }
  p += '【工作方式】\n'
    + '1. 先理解用户意图：简单问题直接回答，不要为了用工具而用工具。\n'
    + '2. 需要最新信息（新闻、价格、动态）时用 web_search；需要读具体网页时用 web_fetch；精确计算用 calculate；查天气用 get_weather；查时间用 get_time。\n'
    + '3. 可以多步规划：先搜索再抓取、先计算再汇总。工具结果返回后综合作答，绝不编造工具没给的信息。\n'
    + '4. 用户明确告知的长期信息（偏好、生日、项目、常用城市等）用 remember 记住。\n'
    + '5. 用中文回答，适合手机阅读：重要结论先行，简洁清晰。\n';
  return p;
}

// ==================== Telegram Agent：主循环 ====================
// ReAct 风格：LLM 决策 → 执行工具 → 结果回填 → 最多 MAX_STEPS 步。
// 通道/模型不支持 tools 参数时返回 { fallback: true }，由调用方降级为普通对话。
async function tgAgentChat(env, tgApi, chatId, targetModelId, history, allowTools) {
  const memories = await agentGetMemories(env, chatId);
  const systemPrompt = buildAgentSystemPrompt(memories);
  const tools = allowTools ? getAgentTools() : null;
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const m of history) messages.push({ role: m.role, content: m.content });

  const MAX_STEPS = 6;
  for (let step = 0; step < MAX_STEPS; step++) {
    // 长推理时保持 typing 状态不消失
    try { tgApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}); } catch (e) {}

    const cfg = buildAIRequest(env, targetModelId, messages, false, tools);
    if (cfg.error) return { error: cfg.error };

    let resp;
    try {
      resp = await fetch(cfg.apiUrl, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cfg.currentApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg.payload)
      });
    } catch (e) { return { error: '网络错误：' + e.message }; }

    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      if (allowTools && /tool/i.test(t) && step === 0) return { fallback: true };
      return { error: 'API 报错 (' + resp.status + ')：' + String(t).slice(0, 500) };
    }

    const data = await resp.json().catch(() => null);
    // 图片生成通道：直接返回图片链接（不走工具循环）
    if (data && data.data && data.data[0] && data.data[0].url) {
      return { text: '[🖼️ 点击查看生成的图片](' + data.data[0].url + ')', usedTools: false, isImage: true };
    }
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) return { error: 'AI 没有返回有效内容' };

    const toolCalls = msg.tool_calls || [];
    const assistantMsg = { role: 'assistant', content: msg.content || '' };
    if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
    messages.push(assistantMsg);

    if (!toolCalls.length) return { text: msg.content || '', usedTools: step > 0 };

    for (const tc of toolCalls) {
      let args = {};
      try { args = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch (e) {}
      const result = await execAgentTool(tc.function.name, args, env, chatId);
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.function.name,
        content: String(result).slice(0, 4000)
      });
    }
  }
  const last = [...messages].reverse().find(m => m.role === 'assistant' && m.content);
  return { text: (last && last.content) || '（思考步数已用尽，请换个问法重试）', usedTools: true };
}

// ======= 统一解析通道配置（带内存缓存） =======
function getChannelConfig(env) {
  if (cachedConfig) {
    return cachedConfig;
  }

  const models = [];
  const modelMap = new Map();

  const addModels = (modelStr, url, keys) => {
    if (!modelStr) return;
    const arr = modelStr.split(',');
    for (let i = 0; i < arr.length; i++) {
      const raw = arr[i].trim();
      if (!raw) continue;
      
      // 用第一个冒号切分：模型 ID 本身不含冒号，显示名里允许出现冒号
      const colonIdx = raw.indexOf(':');
      const id = colonIdx > 0 ? raw.substring(0, colonIdx).trim() : raw;
      const name = colonIdx > 0 ? raw.substring(colonIdx + 1).trim() : raw;

      if (!modelMap.has(id)) {
        models.push({ id, name, original: raw });
        modelMap.set(id, { url, keys });
      }
    }
  };

  if (env.API_CONFIG) {
    try {
      const channels = JSON.parse(env.API_CONFIG);
      channels.forEach(ch => {
        const url = ch.url;
        const keys = Array.isArray(ch.keys) ? ch.keys : parseCommaSeparated(ch.keys);
        const modelStr = Array.isArray(ch.models) ? ch.models.join(',') : ch.models;
        if (url && modelStr) addModels(modelStr, url, keys);
      });
      if (models.length > 0) {
        cachedConfig = { models, modelMap };
        return cachedConfig;
      }
    } catch (e) {
      console.log("API_CONFIG 解析失败:", e);
    }
  }

  let hasIndexed = false;
  for (let i = 1; i <= 20; i++) {
    const url = env[`API_URL_${i}`];
    const modelStr = env[`MODEL_${i}`];
    if (url && modelStr) {
      hasIndexed = true;
      const keys = parseCommaSeparated(env[`API_KEY_${i}`]);
      addModels(modelStr, url, keys);
    }
  }
  if (hasIndexed && models.length > 0) {
    cachedConfig = { models, modelMap };
    return cachedConfig;
  }

  // 兜底：只使用环境变量中显式配置的模型，不再内置任何默认模型
  const fallbackUrl = env.API_URL || "";
  const fallbackKeys = parseCommaSeparated(env.API_KEY);
  const fallbackModelStr = env.MODEL || "";

  if (fallbackUrl && fallbackModelStr) {
    addModels(fallbackModelStr, fallbackUrl, fallbackKeys);
  }

  cachedConfig = { models, modelMap };
  return cachedConfig;
}

// 提取共用的 AI 请求构建逻辑 (DRY原则)
// tools: 可选，OpenAI 兼容的 tools 数组（Agent 模式用）；图片通道自动忽略
function buildAIRequest(env, requestedModel, messagesArray, isStream, tools) {
  const { models, modelMap } = getChannelConfig(env);

  if (models.length === 0) {
    return { error: "未配置任何可用模型。请在 Worker 的环境变量中设置 API_URL_1 / API_KEY_1 / MODEL_1（或 API_URL / API_KEY / MODEL），保存后重新部署一次。" };
  }

  let selectedModel = requestedModel || models[0].id;

  if (!modelMap.has(selectedModel)) {
    selectedModel = models[0].id;
  }

  const channel = modelMap.get(selectedModel);
  if (!channel || !channel.url) return { error: `模型 ${selectedModel} 对应的 API_URL 未配置或异常` };

  const currentApiKey = channel.keys.length > 0 ? channel.keys[Math.floor(Math.random() * channel.keys.length)] : "";
  const apiUrl = channel.url;
  // 图片模型只认 images/generations 接口地址，不再按模型名猜测，避免误伤
  const isImageAPI = apiUrl.includes('images/generations');

  // max_tokens 可配：环境变量 MAX_TOKENS，默认 4096，上限 32000
  let maxTokens = parseInt(env.MAX_TOKENS || '4096', 10);
  if (!(maxTokens > 0)) maxTokens = 4096;
  if (maxTokens > 32000) maxTokens = 32000;

  const payload = isImageAPI ? {
    model: selectedModel,
    prompt: messagesArray[messagesArray.length - 1].content,
    n: 1
  } : {
    model: selectedModel,
    messages: messagesArray,
    stream: isStream,
    max_tokens: maxTokens,
  };
  if (tools && tools.length && !isImageAPI) payload.tools = tools;

  return { apiUrl, currentApiKey, payload, isImageAPI };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 域名所有权验证文件（某第三方平台验证用，路径与内容固定；若不再需要可删除本段）
    if (request.method === 'GET' && url.pathname === '/a9a015a0f6e7c9ca09f4cdce4479deb3.txt') {
      return new Response('b7aa7e3069358c2c18f7908a7d5815788bafd020', { headers: TEXT_HEADERS });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // ================= PWA 路由 =================
    if (request.method === 'GET' && url.pathname === '/manifest.webmanifest') {
      return new Response(MANIFEST_JSON, { headers: MANIFEST_HEADERS });
    }

    if (request.method === 'GET' && url.pathname === '/sw.js') {
      return new Response(SW_JS.replaceAll('{{PWA_VERSION}}', getPwaVersion()), { headers: SW_HEADERS });
    }

    if (request.method === 'GET' && ICON_B64[url.pathname]) {
      const bytes = getIconBytes(url.pathname);
      if (bytes) return new Response(bytes, { headers: PNG_HEADERS });
    }

    // 健康探针：供前端与 Service Worker 判断服务端是否可达。
    // ⚠️ SW 中必须显式放行该路径且绝不缓存，否则探针会被缓存应答 →
    //    永远「探测成功」→ 自动重连逻辑形同虚设。
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return new Response(JSON.stringify({ ok: true, t: Date.now() }), { headers: HEALTH_HEADERS });
    }

    if (request.method === 'POST' && url.pathname === '/api/chat') {
      const denied = denyUnauthorized(env, request);
      if (denied) return denied;

      if (hitRateLimit(request, env)) {
        return new Response(JSON.stringify({ error: "请求过于频繁，请稍后再试", code: "RATE_LIMITED" }), {
          status: 429, headers: CORS_HEADERS,
        });
      }

      try {
        let body;
        try {
          body = await request.json();
        } catch (e) {
          return new Response(JSON.stringify({ error: "无效的请求格式" }), { status: 400, headers: CORS_HEADERS });
        }

        const aiConfig = buildAIRequest(env, body.model, body.messages, true);
        if (aiConfig.error) {
          return new Response(JSON.stringify({ error: aiConfig.error }), { status: 500, headers: CORS_HEADERS });
        }

        const { apiUrl, currentApiKey, payload, isImageAPI } = aiConfig;

        const upstreamResponse = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${currentApiKey}`, 
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload)
        });

        if (!upstreamResponse.ok) {
          const errText = await upstreamResponse.text();
          return new Response(JSON.stringify({ error: `API 报错 (${upstreamResponse.status}):${errText}` }), {
            status: upstreamResponse.status,
            headers: CORS_HEADERS,
          });
        }

        if (!isImageAPI) {
          return new Response(upstreamResponse.body, { headers: SSE_HEADERS });
        } else {
          const responseData = await upstreamResponse.json();
          let imageUrlOrText = "图片生成失败或未返回格式";
          
          if (responseData.data && responseData.data[0]?.url) {
            imageUrlOrText = `![生成结果](${responseData.data[0].url})`;
          } else if (responseData.choices && responseData.choices[0]?.message) {
            imageUrlOrText = responseData.choices[0].message.content;
          }

          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              const fakeChunk = JSON.stringify({ choices: [{ delta: { content: imageUrlOrText + "\n\n" } }] });
              controller.enqueue(encoder.encode(`data: ${fakeChunk}\n\n`));
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            }
          });

          return new Response(stream, { headers: SSE_HEADERS });
        }
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: CORS_HEADERS });
      }
    }

    if (request.method === 'GET' && url.pathname === '/') {
      const { models } = getChannelConfig(env);

      const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

      let optionsHtml = '';
      for (let i = 0; i < models.length; i++) {
        const item = models[i];
        let displayName = item.name;
        if (!item.original.includes(':')) {
          displayName = item.id.length > 24 ? item.id.substring(0, 22) + '...' : item.id;
        }
        optionsHtml += `<option value="${escHtml(item.id)}" ${i === 0 ? 'selected' : ''}>${escHtml(displayName)}</option>`;
      }

      if (models.length === 0) {
        optionsHtml = '<option value="" disabled selected>未配置模型，请检查环境变量</option>';
      }

      const html = HTML_CONTENT.replaceAll('{{MODEL_OPTIONS}}', optionsHtml);
      return new Response(html, { headers: HTML_HEADERS });
    }

    if (request.method === 'POST' && url.pathname === '/tg-webhook') {
      // Webhook 来源校验：配置 TG_WEBHOOK_SECRET 后，只接受携带正确
      // X-Telegram-Bot-Api-Secret-Token 请求头的调用（setWebhook 时传入 secret_token）。
      // 未配置时保持开放（兼容旧部署），但强烈建议配置。
      if (env.TG_WEBHOOK_SECRET) {
        const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
        if (!safeEqual(got, env.TG_WEBHOOK_SECRET)) {
          return new Response('Forbidden', { status: 403 });
        }
      }

      try {
        const update = await request.json();
        if (!env.TG_BOT_TOKEN) return new Response('OK', { status: 200 });

        const tgApi = (method, body) => fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        ctx.waitUntil((async () => {
          try {
            const { models: modelObjList } = getChannelConfig(env);
            if (modelObjList.length === 0) return;

            if (update.callback_query) {
              const cb = update.callback_query;
              const chatId = cb.message.chat.id;
              const data = cb.data;

              if (data.startsWith('M:')) {
                const index = parseInt(data.substring(2), 10);
                if (modelObjList[index]) {
                  const selected = modelObjList[index];
                  tgUserModels.set(chatId, selected.id);
                  ctx.waitUntil(storePut(env, `tg_user_${chatId}`, selected.id));
                  
                  tgApi('sendMessage', {
                    chat_id: chatId,
                    text: `✅ **已切换模型为:** \n\`${selected.name}\``,
                    parse_mode: "Markdown"
                  }).catch(() => {});
                }
              }

              tgApi('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
              return;
            }

            if (update.message && update.message.text) {
              const chatId = update.message.chat.id;
              const userText = update.message.text;

              if (userText.startsWith('/start') || userText.startsWith('/model')) {
                const inline_keyboard = modelObjList.map((model, index) => {
                  return [{ text: model.name, callback_data: `M:${index}` }];
                });

                await tgApi('sendMessage', {
                  chat_id: chatId,
                  text: "⚙️ **请选择对话要使用的 AI 模型:**\n\n_支持多轮对话（最近 " + (parseInt(env.TG_HISTORY_ROUNDS || '10', 10) || 10) + " 轮），发送 /clear 可清空上下文。_\n\n🤖 **Agent 模式**（默认开启）：我会自主规划、调用工具（🔍 联网搜索、📄 网页读取、🧮 精确计算、🌤 天气、🕐 时间），并用 🧠 长期记住你告诉我的事。发送 /agent 可切换为普通对话模式。",
                  parse_mode: "Markdown",
                  reply_markup: { inline_keyboard }
                });
                return;
              }

              if (userText === '/clear' || userText === '/new') {
                await tgClearHistory(env, chatId);
                await tgApi('sendMessage', { chat_id: chatId, text: "🧹 上下文已清空，可以开始新的话题了。" });
                return;
              }

              if (userText === '/agent') {
                const cur = await agentGetMode(env, chatId);
                await agentSetMode(env, chatId, !cur);
                await tgApi('sendMessage', {
                  chat_id: chatId,
                  text: !cur
                    ? "🤖 **Agent 模式已开启**\n\n我会自主规划、调用工具（🔍 联网搜索、📄 网页读取、🧮 精确计算、🌤 天气、🕐 时间），并长期记住你告诉我的重要信息。"
                    : "💬 **已切换为普通对话模式**\n\n单轮问答，不调用工具、不使用长期记忆。如需 Agent 能力再发送 /agent 切回。",
                  parse_mode: "Markdown"
                });
                return;
              }

              let targetModelId = tgUserModels.get(chatId);
              if (!targetModelId) {
                targetModelId = await storeGet(env, `tg_user_${chatId}`);
              }

              // 多轮对话：取出历史，拼上本轮用户消息（超限自动裁剪）
              let history = await tgGetHistory(env, chatId);
              history.push({ role: "user", content: userText });
              history = tgTrimHistory(history, env);

              const sendActionPromise = tgApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
              const pendingMsgPromise = tgApi('sendMessage', {
                chat_id: chatId,
                text: "⏳ _正在思考并生成内容，请稍候..._",
                parse_mode: "Markdown"
              }).then(async res => {
                if (res.ok) {
                  const data = await res.json();
                  return data.result?.message_id;
                }
                return null;
              }).catch(() => null);

              const [, pendingMsgId] = await Promise.all([sendActionPromise, pendingMsgPromise]);

              // ===== Agent 主流程：自主规划 → 工具调用 → 汇总作答 =====
              const useAgent = await agentGetMode(env, chatId);
              let replyText = null;
              let agentErr = null;

              if (useAgent) {
                let r = await tgAgentChat(env, tgApi, chatId, targetModelId, history, true);
                if (r.fallback) r = await tgAgentChat(env, tgApi, chatId, targetModelId, history, false);
                if (r.error) {
                  agentErr = r.error;
                } else {
                  replyText = r.text;
                  // 文本问答记入历史；图片生成不记（省空间）
                  if (!r.isImage && replyText) {
                    history.push({ role: "assistant", content: replyText });
                    history = tgTrimHistory(history, env);
                    await tgSaveHistory(env, chatId, history);
                  }
                }
              } else {
                // 普通模式：单次问答（与旧版行为一致，不调用工具）
                const aiConfig = buildAIRequest(env, targetModelId, history, false);
                if (aiConfig.error) {
                  if (pendingMsgId) {
                    tgApi('deleteMessage', { chat_id: chatId, message_id: pendingMsgId }).catch(() => {});
                  }
                  await tgApi('sendMessage', { chat_id: chatId, text: "⚠️ 此模型的 API 接口未配置或异常。" });
                  return;
                }
                const { apiUrl, currentApiKey, payload } = aiConfig;
                // 上游偶发中断时重试一次（深度思考时间越长越容易撞上）
                let aiResponse = null;
                for (let tgAttempt = 1; tgAttempt <= 2; tgAttempt++) {
                  try {
                    aiResponse = await fetch(apiUrl, {
                      method: 'POST',
                      headers: {
                        'Authorization': `Bearer ${currentApiKey}`,
                        'Content-Type': 'application/json',
                      },
                      body: JSON.stringify(payload)
                    });
                    break;
                  } catch (e) {
                    aiResponse = null;
                    if (tgAttempt >= 2) { agentErr = '上游接口请求失败，请稍后再试。'; break; }
                    await new Promise(function (r) { setTimeout(r, 1500); });
                  }
                }
                if (!agentErr) {
                  if (aiResponse && aiResponse.ok) {
                    const aiData = await aiResponse.json();
                    if (aiData.choices && aiData.choices[0]?.message) {
                      replyText = aiData.choices[0].message.content;
                    } else if (aiData.data && aiData.data[0]?.url) {
                      replyText = `[🖼️ 点击查看生成的图片](${aiData.data[0].url})`;
                    } else {
                      replyText = "AI 没有返回有效内容。";
                    }
                    if (aiData.choices && aiData.choices[0]?.message && replyText) {
                      history.push({ role: "assistant", content: replyText });
                      history = tgTrimHistory(history, env);
                      await tgSaveHistory(env, chatId, history);
                    }
                  } else {
                    agentErr = "⚠️ AI 接口请求失败，请稍后再试。";
                  }
                }
              }

              if (pendingMsgId) {
                ctx.waitUntil(tgApi('deleteMessage', { chat_id: chatId, message_id: pendingMsgId }).catch(() => {}));
              }

              if (agentErr) {
                await tgApi('sendMessage', { chat_id: chatId, text: agentErr });
                return;
              }

              if (replyText) {
                const maxLength = 4000;
                let startIndex = 0;
                while (startIndex < replyText.length) {
                  let sliceLength = maxLength;
                  if (startIndex + maxLength < replyText.length) {
                    const lastNewline = replyText.lastIndexOf('\n', startIndex + maxLength);
                    if (lastNewline > startIndex + 3000) {
                       sliceLength = lastNewline - startIndex;
                    }
                  }

                  const chunk = replyText.slice(startIndex, startIndex + sliceLength);
                  startIndex += sliceLength;

                  const tgRes = await tgApi('sendMessage', {
                    chat_id: chatId,
                    text: chunk,
                    parse_mode: "Markdown"
                  });

                  if (!tgRes.ok) {
                    await tgApi('sendMessage', { chat_id: chatId, text: chunk });
                  }
                }
              }
            }
          } catch (err) {
            console.log("后台处理异常:", err);
          }
        })());

        return new Response('OK', { status: 200 });
      } catch (error) {
        return new Response('Error', { status: 500 });
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};

// ================= PWA：Web App Manifest =================
const MANIFEST_JSON = JSON.stringify({
  name: 'Cloudflare-Chat',
  short_name: 'CF-Chat',
  description: '基于 Cloudflare Workers 的多通道 AI 对话前端',
  lang: 'zh-CN',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'any',
  background_color: '#f8fafc',
  theme_color: '#3b82f6',
  categories: ['productivity', 'utilities'],
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
  shortcuts: [
    { name: '发起新对话', short_name: '新对话', url: '/?new=1' },
  ],
});

// ================= PWA：Service Worker 源码 =================
// ⚠️ 本段位于外层模板字符串内部，只有【一层】转义，但仍需遵守：
//    1) 不得出现反引号（会截断外层模板字符串）—— 一律用单引号 + 字符串拼接；
//    2) 不得出现 ${（会被当成插值）—— 用 + 拼接；
//    3) 不得出现反斜杠 —— 避免二次转义歧义。
// 因此下面的 OFFLINE_HTML 用数组 join 构造，且不含任何内联脚本。
const SW_JS = `/* Cloudflare-Chat Service Worker —— 由 _worker.js 内嵌生成，请勿单独维护此文件 */
const VERSION = '{{PWA_VERSION}}';
const CACHE = 'cloudflare-chat-' + VERSION;
const SHELL = '/';

const PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png'
];

const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/marked@4.3.0/marked.min.js',
  'https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js',
  'https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/atom-one-dark.min.css',
  'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap'
];

const CDN_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

const OFFLINE_HTML = [
  '<!DOCTYPE html>',
  '<html lang="zh-CN"><head><meta charset="UTF-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<meta http-equiv="refresh" content="5">',
  '<title>离线中 - Cloudflare-Chat</title>',
  '<style>',
  'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;',
  'background:#f8fafc;color:#0f172a;',
  'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}',
  '.box{text-align:center;padding:40px 32px;max-width:360px}',
  '.dot{width:56px;height:56px;margin:0 auto 20px;border-radius:50%;',
  'background:linear-gradient(135deg,#3b82f6,#6366f1);',
  'display:flex;align-items:center;justify-content:center;color:#fff;font-size:26px;font-weight:700}',
  'h1{font-size:18px;margin:0 0 10px}',
  'p{font-size:13px;color:#475569;line-height:1.7;margin:0}',
  '</style></head><body><div class="box">',
  '<div class="dot">!</div>',
  '<h1>当前处于离线状态</h1>',
  '<p>页面资源已缓存，但网络暂不可用。<br>本页每 5 秒自动重试一次，恢复后会自动刷新。</p>',
  '</div></body></html>'
].join('');

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    const cache = await caches.open(CACHE);
    // 应用外壳：任一失败不影响整体安装
    await Promise.all(PRECACHE.map(async function (u) {
      try { await cache.add(new Request(u, { cache: 'reload' })); } catch (e) {}
    }));
    // 第三方资源：离线时页面仍要能渲染 Markdown 与代码高亮
    await Promise.all(CDN_ASSETS.map(async function (u) {
      try {
        const res = await fetch(u, { mode: 'cors', credentials: 'omit' });
        if (res && (res.ok || res.type === 'opaque')) await cache.put(u, res);
      } catch (e) {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys.map(function (k) {
      if (k !== CACHE && k.indexOf('cloudflare-chat-') === 0) return caches.delete(k);
      return Promise.resolve(false);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // 健康探针：显式放行且绝不缓存。
  // 若在此处 respondWith 并缓存，探针会永远「成功」，自动重连将完全失效。
  if (url.pathname === '/healthz') return;

  // 实时接口：直连网络，不缓存
  if (url.pathname.indexOf('/api/') === 0) return;
  if (url.pathname === '/tg-webhook') return;

  // 页面导航：network-first，断网时回退到缓存的页面外壳
  if (req.mode === 'navigate') {
    event.respondWith((async function () {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) cache.put(SHELL, fresh.clone());
        return fresh;
      } catch (e) {
        const cached = await cache.match(SHELL);
        if (cached) return cached;
        return new Response(OFFLINE_HTML, {
          headers: { 'Content-Type': 'text/html;charset=UTF-8' }
        });
      }
    })());
    return;
  }

  // 同源静态资源（图标 / manifest）：cache-first
  if (url.origin === self.location.origin) {
    event.respondWith((async function () {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      } catch (e) {
        return Response.error();
      }
    })());
    return;
  }

  // 第三方 CDN：stale-while-revalidate
  if (CDN_HOSTS.indexOf(url.hostname) >= 0) {
    event.respondWith((async function () {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      const network = fetch(req).then(function (res) {
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      }).catch(function () { return null; });
      if (cached) return cached;
      const res = await network;
      return res || Response.error();
    })());
  }
});
`;

// ================= UI 代码 =================
// 彻底清除了前端代码中所有可能被转义破坏的反引号，确保100%部署通过
const HTML_CONTENT = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>Cloudflare-Chat</title>

  <!-- ===== PWA ===== -->
  <link rel="manifest" href="/manifest.webmanifest">
  <meta name="theme-color" content="#f8fafc" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#0f172a" media="(prefers-color-scheme: dark)">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="Cloudflare-Chat">
  <meta name="application-name" content="Cloudflare-Chat">
  <link rel="icon" type="image/png" href="/icon-192.png">
  <link rel="apple-touch-icon" href="/icon-192.png">
  
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/marked@4.3.0/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js"></script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/atom-one-dark.min.css">
  <script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js"></script>

  <style>
    :root {
      --bg-base: #f8fafc;
      --glass-bg: rgba(255, 255, 255, 0.75);
      --glass-border: rgba(255, 255, 255, 0.8);
      --glass-shadow: 0 10px 40px -10px rgba(0, 0, 0, 0.08), 0 0 20px rgba(255, 255, 255, 0.5) inset;
      --text-main: #0f172a;
      --text-secondary: #475569;
      --brand-color: #3b82f6;
      --brand-gradient: linear-gradient(135deg, #3b82f6, #6366f1);
      --user-msg: var(--brand-gradient);
      --user-text: #ffffff;
      --input-bg: rgba(255, 255, 255, 0.95);
      --hover-bg: rgba(15, 23, 42, 0.04);
      --aurora-1: #e0e7ff;
      --aurora-2: #dbeafe;
      --aurora-3: #f3e8ff;
      --border-radius: 20px;
    }

    [data-theme="dark"] {
      --bg-base: #0f172a;
      --glass-bg: rgba(30, 41, 59, 0.7);
      --glass-border: rgba(255, 255, 255, 0.05);
      --glass-shadow: 0 10px 40px -10px rgba(0, 0, 0, 0.5), 0 0 20px rgba(255, 255, 255, 0.02) inset;
      --text-main: #f1f5f9;
      --text-secondary: #94a3b8;
      --brand-color: #60a5fa; 
      --brand-gradient: linear-gradient(135deg, #3b82f6, #4f46e5);
      --user-msg: var(--brand-gradient);
      --user-text: #ffffff;
      --input-bg: rgba(30, 41, 59, 0.95);
      --hover-bg: rgba(255, 255, 255, 0.08);
      --aurora-1: #1e1b4b;
      --aurora-2: #0f172a;
      --aurora-3: #312e81;
    }

    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--text-secondary); border-radius: 10px; opacity: 0.2; }
    ::-webkit-scrollbar-thumb:hover { background: var(--brand-color); }
    
    body, html {
      margin: 0; padding: 0; height: 100vh; height: 100dvh; 
      width: 100%; max-width: 100vw; overflow: hidden;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: var(--text-main); background-color: var(--bg-base); transition: background-color 0.5s ease;
    }

    @keyframes float1 { 0%, 100% { transform: translate(0, 0) scale(1); } 50% { transform: translate(30px, -30px) scale(1.05); } }
    @keyframes float2 { 0%, 100% { transform: translate(0, 0) scale(1); } 50% { transform: translate(-30px, 20px) scale(1.1); } }
    @keyframes float3 { 0%, 100% { transform: translate(0, 0) scale(1); } 50% { transform: translate(20px, 40px) scale(0.95); } }

    .aurora-bg {
      position: fixed; top: 0; left: 0; width: 100%; height: 100vh; z-index: -1; pointer-events: none;
      filter: blur(80px); opacity: 0.8; transition: opacity 0.8s ease; overflow: hidden;
    }
    .aurora-blob { position: absolute; border-radius: 50%; opacity: 0.6; mix-blend-mode: multiply; }
    [data-theme="dark"] .aurora-blob { mix-blend-mode: screen; opacity: 0.4; }
    .blob-1 { top: -10%; left: -10%; width: 50vw; height: 50vw; background: var(--aurora-1); animation: float1 15s infinite ease-in-out; }
    .blob-2 { top: 40%; right: -20%; width: 60vw; height: 60vw; background: var(--aurora-2); animation: float2 18s infinite ease-in-out; }
    .blob-3 { bottom: -20%; left: 20%; width: 50vw; height: 50vw; background: var(--aurora-3); animation: float3 20s infinite ease-in-out; }

    .app-container { display: flex; height: 100%; width: 100%; max-width: 100vw; position: relative; overflow: hidden; }

    .sidebar {
      width: 280px; display: flex; flex-direction: column; z-index: 100;
      background: var(--glass-bg); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
      border-right: 1px solid var(--glass-border); transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), background 0.4s;
    }
    .sidebar-header { padding: 24px 20px 16px; }
    .new-chat-btn {
      width: 100%; padding: 14px; border-radius: 14px; border: 1px solid var(--glass-border);
      background: rgba(255,255,255,0.1); color: var(--text-main); font-weight: 600; font-size: 15px;
      display: flex; align-items: center; justify-content: center; gap: 8px;
      cursor: pointer; transition: all 0.2s ease; box-shadow: 0 2px 8px rgba(0,0,0,0.02);
    }
    .new-chat-btn:hover { background: var(--hover-bg); transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
    
    .session-list { flex: 1; overflow-y: auto; padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; }
    .session-item {
      padding: 14px 16px; border-radius: 12px; cursor: pointer; display: flex; justify-content: space-between; 
      align-items: center; font-size: 14px; color: var(--text-secondary); transition: all 0.2s ease;
      font-weight: 500; border: 1px solid transparent;
    }
    .session-item:hover { background: var(--hover-bg); color: var(--text-main); }
    .session-item.active { 
      background: var(--bg-base); color: var(--brand-color); font-weight: 600; 
      border-color: var(--glass-border); box-shadow: 0 2px 10px rgba(0,0,0,0.03);
    }
    .session-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
    .delete-btn { background: none; border: none; color: inherit; padding: 6px; cursor: pointer; opacity: 0; transition: all 0.2s; border-radius: 8px; }
    .session-item:hover .delete-btn { opacity: 0.5; }
    .delete-btn:hover { opacity: 1 !important; color: #ef4444; background: rgba(239, 68, 68, 0.1); }
    
    .sidebar-footer { padding: 16px 20px; border-top: 1px solid var(--glass-border); display: flex; align-items: center; justify-content: space-between; }
    .theme-toggle { 
      background: none; border: none; color: var(--text-secondary); cursor: pointer; 
      display: flex; align-items: center; padding: 8px; border-radius: 10px; transition: all 0.2s; 
    }
    .theme-toggle:hover { background: var(--hover-bg); color: var(--brand-color); transform: scale(1.05); }
    .theme-toggle.active { color: var(--brand-color); background: var(--hover-bg); }
    .theme-toggle[hidden] { display: none; }

    /* ===== PWA：离线提示条 ===== */
    .offline-banner {
      position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
      display: flex; align-items: center; justify-content: center; gap: 10px;
      padding: 10px 16px; font-size: 13px; font-weight: 600; letter-spacing: .2px;
      color: #ffffff; background: linear-gradient(90deg, #f59e0b, #ef4444);
      box-shadow: 0 4px 18px rgba(239, 68, 68, 0.28);
      transform: translateY(-105%); transition: transform .32s cubic-bezier(.4,0,.2,1);
      pointer-events: none;
    }
    .offline-banner.show { transform: translateY(0); }
    .offline-banner .spin { animation: offlineSpin 1s linear infinite; flex-shrink: 0; }
    @keyframes offlineSpin { to { transform: rotate(360deg); } }

    .sidebar-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 99; backdrop-filter: blur(4px); opacity: 0; transition: opacity 0.3s; }

    .chat-area { 
      flex: 1; display: flex; flex-direction: column; position: relative; 
      height: 100%; width: 100%; max-width: 100vw; overflow: hidden; 
    }
    
    .header { height: 70px; display: flex; align-items: center; padding: 0 24px; border-bottom: 1px solid var(--glass-border); background: var(--glass-bg); backdrop-filter: blur(20px); z-index: 10; }
    .header-inner { max-width: 880px; margin: 0 auto; width: 100%; display: flex; align-items: center; }
    .header-title { font-size: 16px; font-weight: 600; letter-spacing: 0.5px; display: flex; align-items: center; gap: 10px; color: var(--text-main); }
    
    .status-dot { width: 10px; height: 10px; border-radius: 50%; background: #10b981; box-shadow: 0 0 8px rgba(16, 185, 129, 0.4); transition: all 0.3s; }
    @keyframes breathing { 
      0% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.4); background: #3b82f6; } 
      70% { box-shadow: 0 0 0 10px rgba(59, 130, 246, 0); background: #60a5fa; } 
      100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0); background: #3b82f6; } 
    }
    .status-dot.generating { animation: breathing 1.5s infinite; }

    .menu-toggle { background: none; border: none; color: var(--text-main); cursor: pointer; padding: 10px; margin-right: 12px; border-radius: 10px; display: none; transition: background 0.2s; }
    .menu-toggle:hover { background: var(--hover-bg); }
    
    .messages-container { 
      flex: 1; overflow-y: auto; overflow-x: hidden;
      padding: 32px 20px; scroll-behavior: smooth;
      contain: layout style; will-change: scroll-position;
      width: 100%;
    }
    .messages { max-width: 880px; width: 100%; margin: 0 auto; display: flex; flex-direction: column; gap: 36px; }
    
    .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 65vh; opacity: 0.9; }
    .empty-state svg { color: var(--brand-color); width: 56px; height: 56px; margin-bottom: 24px; filter: drop-shadow(0 8px 16px rgba(59,130,246,0.2)); }
    .empty-state h2 { margin: 0; font-size: 24px; font-weight: 600; color: var(--text-main); letter-spacing: -0.5px; }
    
    .message-row { display: flex; width: 100%; max-width: 100%; animation: slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards; contain: content; }
    @keyframes slideUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
    
    .message-row.user { justify-content: flex-end; }
    
    .message-bubble { 
      line-height: 1.7; 
      word-wrap: break-word; word-break: break-word; overflow-wrap: break-word; 
      font-size: 16px; max-width: 100%; 
    }
    
    .message-row.user .message-bubble { 
      background: var(--user-msg); color: var(--user-text); max-width: 80%;
      padding: 14px 22px; 
      border-radius: 24px 24px 6px 24px; 
      white-space: pre-wrap; 
      box-shadow: 0 8px 24px -6px rgba(59, 130, 246, 0.25);
      font-weight: 400;
    }
    .message-row.ai .message-bubble { background: transparent; border: none; box-shadow: none; width: 100%; max-width: 100%; padding: 0; }
    .error-msg .message-bubble { color: #ef4444; }

    .markdown-body { font-size: 16px; line-height: 1.75; color: var(--text-main); font-family: inherit; word-break: break-word; max-width: 100%; }
    .markdown-body p { margin-top: 0; margin-bottom: 1.2em; }
    .markdown-body p:last-child { margin-bottom: 0; }
    .markdown-body a { color: var(--brand-color); text-decoration: none; font-weight: 500; word-break: break-all; }
    .markdown-body a:hover { text-decoration: underline; }
    .markdown-body strong { font-weight: 600; color: var(--text-main); }
    
    .markdown-body blockquote {
      margin: 16px 0; padding: 16px 20px; color: var(--text-secondary);
      border-left: 4px solid var(--brand-color); background: var(--hover-bg); border-radius: 0 12px 12px 0;
      font-style: italic; max-width: 100%; overflow-x: hidden;
    }
    .markdown-body ul, .markdown-body ol { margin-top: 0; margin-bottom: 1.2em; padding-left: 24px; }
    .markdown-body li { margin-bottom: 0.4em; }
    
    .markdown-body img, .markdown-body video { max-width: 100%; height: auto; border-radius: 8px; margin-top: 10px; }

    .markdown-body table { 
      display: block; overflow-x: auto; white-space: nowrap; 
      width: 100%; max-width: 100%; border-collapse: collapse; margin-bottom: 1.5em; 
      font-size: 15px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.03); 
      border: 1px solid var(--glass-border); 
    }
    .markdown-body th, .markdown-body td { border: 1px solid var(--glass-border); padding: 12px 16px; }
    .markdown-body th { background: var(--hover-bg); font-weight: 600; text-align: left; }

    .markdown-body code {
      background: var(--hover-bg); padding: 3px 6px; border-radius: 6px;
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      font-size: 0.85em; color: var(--brand-color); font-weight: 500; word-break: break-all;
    }
    
    .code-wrapper { background: #0f172a; border-radius: 14px; overflow: hidden; margin: 20px 0; box-shadow: 0 10px 30px rgba(0,0,0,0.15); border: 1px solid rgba(255,255,255,0.1); max-width: 100%; }
    .code-header {
      display: flex; justify-content: space-between; align-items: center; padding: 10px 16px;
      background: rgba(255,255,255,0.05); color: #94a3b8; font-size: 13px; font-family: monospace; border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .copy-btn {
      background: transparent; border: none; color: #94a3b8; cursor: pointer; display: flex; align-items: center; gap: 6px;
      font-size: 12px; transition: all 0.2s; padding: 6px 10px; border-radius: 6px; font-weight: 500;
    }
    .copy-btn:hover { color: #ffffff; background: rgba(255,255,255,0.1); }

    /* ===== 消息朗读按钮 ===== */
    .msg-actions { display: flex; gap: 8px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
    .speak-btn {
      background: transparent; border: 1px solid var(--glass-border); color: var(--text-secondary);
      cursor: pointer; display: inline-flex; align-items: center; gap: 6px; font-size: 12px;
      padding: 6px 12px; border-radius: 10px; transition: all 0.2s ease; font-weight: 500;
      font-family: inherit; line-height: 1;
    }
    .speak-btn:hover { color: var(--brand-color); border-color: var(--brand-color); background: var(--hover-bg); }
    .speak-btn.speaking { color: var(--brand-color); border-color: var(--brand-color); background: var(--hover-bg); }
    .speak-btn.speaking svg { animation: speakPulse 1s infinite ease-in-out; }
    .speak-btn svg { flex-shrink: 0; }
    @keyframes speakPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
    .tts-warn { font-size: 12px; color: #ef4444; margin-top: 8px; }
    .retry-notice { font-size: 12px; color: var(--text-secondary); margin-top: 10px; padding: 8px 12px; background: var(--hover-bg); border-radius: 10px; animation: speakPulse 1.6s infinite ease-in-out; }
    .code-wrapper pre { background: transparent !important; margin: 0 !important; padding: 20px; overflow-x: auto; border-radius: 0; box-shadow: none; max-width: 100%; }
    .code-wrapper pre code { background: transparent; padding: 0; color: #e2e8f0; font-size: 14px; line-height: 1.6; font-family: 'SFMono-Regular', Consolas, monospace; word-break: normal; }

    .reasoning-box {
      font-size: 14px; color: var(--text-secondary); background: rgba(128,128,128,0.05);
      padding: 12px 16px; border-radius: 12px; border-left: 3px solid var(--brand-color);
      margin-bottom: 16px; white-space: pre-wrap; line-height: 1.6; max-height: 150px; overflow-y: auto;
      overflow-x: hidden; word-break: break-word; max-width: 100%;
    }
    .reasoning-box::-webkit-scrollbar { width: 4px; }
    .reasoning-box::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.3); border-radius: 4px; }

    .typing-indicator { display: inline-flex; gap: 6px; align-items: center; padding: 4px 2px; height: 24px; }
    .typing-dot { width: 6px; height: 6px; background: var(--brand-color); border-radius: 50%; animation: typing 1.4s infinite ease-in-out both; }
    .typing-dot:nth-child(1) { animation-delay: -0.32s; }
    .typing-dot:nth-child(2) { animation-delay: -0.16s; }
    @keyframes typing { 0%, 80%, 100% { transform: scale(0); opacity: 0.4; } 40% { transform: scale(1); opacity: 1; } }

    .input-wrapper { padding: 0 24px 32px; max-width: 900px; width: 100%; margin: 0 auto; position: relative; z-index: 10; box-sizing: border-box; }
    .input-box { 
      background: var(--input-bg); backdrop-filter: blur(24px); border: 1px solid var(--glass-border);
      border-radius: 24px; padding: 14px 18px; display: flex; flex-direction: column; gap: 8px; 
      box-shadow: 0 12px 40px rgba(0,0,0,0.06), 0 2px 10px rgba(0,0,0,0.02); transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); 
      width: 100%;
    }
    .input-box:focus-within { 
      border-color: var(--brand-color); 
      box-shadow: 0 12px 40px rgba(59, 130, 246, 0.12), 0 0 0 3px rgba(59, 130, 246, 0.1); 
      transform: translateY(-2px); 
    }
    
    .input-top { display: flex; align-items: flex-end; gap: 12px; }
    textarea { 
      flex: 1; background: transparent; border: none; color: var(--text-main); font-size: 16px; 
      line-height: 24px; max-height: 200px; min-height: 24px; resize: none; outline: none; 
      font-family: inherit; padding: 8px 0 8px 8px; font-weight: 400; width: 100%;
    }
    textarea::placeholder { color: var(--text-secondary); opacity: 0.6; }
    
    .send-btn { 
      width: 40px; height: 40px; border-radius: 20px; border: none; background: var(--hover-bg); 
      color: var(--text-secondary); display: flex; align-items: center; justify-content: center; 
      cursor: not-allowed; transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); flex-shrink: 0; margin-bottom: 2px; 
    }
    .send-btn.active { 
      background: var(--brand-gradient); color: #ffffff; cursor: pointer; 
      box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
    }
    .send-btn.active:hover { transform: scale(1.08); box-shadow: 0 6px 16px rgba(59, 130, 246, 0.4); }

    .send-btn.stop-mode { 
      background: rgba(239, 68, 68, 0.1); 
      color: #ef4444; 
      cursor: pointer; 
      box-shadow: none;
    }
    .send-btn.stop-mode:hover { 
      background: rgba(239, 68, 68, 0.2); 
      transform: scale(1.08); 
    }
    .send-btn.stop-mode svg {
      fill: #ef4444;
      stroke: #ef4444;
    }
    
    .input-bottom { display: flex; justify-content: space-between; align-items: center; height: 28px; padding-top: 4px; width: 100%; }
    
    .model-selector-container { 
      display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 12px; 
      cursor: pointer; transition: all 0.2s; position: relative; overflow: hidden;
      background: var(--hover-bg); border: 1px solid transparent; max-width: 100%;
    }
    .model-selector-container:hover { background: rgba(128,128,128,0.1); border-color: var(--glass-border); }
    .model-select { 
      position: absolute; top: 0; left: 0; width: 100%; height: 100%; opacity: 0; 
      cursor: pointer; border: none; outline: none; -webkit-appearance: none; appearance: none;
    }
    .model-display-text { font-size: 13px; font-weight: 600; color: var(--text-secondary); pointer-events: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px; }
    
    .disclaimer { text-align: center; font-size: 12px; color: var(--text-secondary); opacity: 0.7; margin-top: 16px; font-weight: 500; }

    .settings-modal-overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000;
      backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
      display: none; align-items: center; justify-content: center;
      opacity: 0; transition: opacity 0.3s ease;
    }
    .settings-modal-overlay.active { display: flex; opacity: 1; }
    .settings-box {
      background: var(--glass-bg); border: 1px solid var(--glass-border);
      box-shadow: var(--glass-shadow), 0 20px 40px rgba(0,0,0,0.1); padding: 30px; border-radius: 24px;
      width: 360px; max-width: 90%; transform: scale(0.95) translateY(10px); transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .settings-modal-overlay.active .settings-box { transform: scale(1) translateY(0); }
    .settings-select {
      width: 100%; padding: 12px 16px; border-radius: 12px; border: 1px solid var(--glass-border);
      background: var(--input-bg); color: var(--text-main); font-size: 15px; outline: none;
      font-weight: 500; transition: all 0.2s; appearance: none;
      background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e");
      background-repeat: no-repeat; background-position: right 1rem center; background-size: 1em;
    }
    .settings-select:focus { border-color: var(--brand-color); box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1); }
    .settings-input {
      width: 100%; padding: 12px 16px; border-radius: 12px; border: 1px solid var(--glass-border);
      background: var(--input-bg); color: var(--text-main); font-size: 15px; outline: none;
      font-weight: 500; transition: all 0.2s; box-sizing: border-box; font-family: inherit;
    }
    .settings-input:focus { border-color: var(--brand-color); box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1); }
    .settings-hint { font-size: 12px; color: var(--text-secondary); opacity: 0.75; margin-top: 8px; line-height: 1.5; }
    .settings-btn {
      background: var(--brand-gradient); color: #fff; border: none; padding: 10px 24px;
      border-radius: 12px; cursor: pointer; font-size: 15px; font-weight: 600; transition: all 0.2s;
      box-shadow: 0 4px 12px rgba(59, 130, 246, 0.2);
    }
    .settings-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(59, 130, 246, 0.3); }

    @media (min-width: 769px) {
      .app-container { padding: 24px; gap: 24px; align-items: center; justify-content: center; }
      .sidebar { position: relative; transform: translateX(0); border-radius: var(--border-radius); height: 100%; box-shadow: var(--glass-shadow); flex-shrink: 0; }
      .chat-area { border-radius: var(--border-radius); height: 100%; background: var(--glass-bg); backdrop-filter: blur(24px); border: 1px solid var(--glass-border); box-shadow: var(--glass-shadow); }
      .delete-btn { display: block; }
    }

    @media (max-width: 768px) {
      :root {
        --bg-base: #ffffff;
        --glass-bg: #ffffff;
        --glass-border: #e5e5e5;
        --glass-shadow: none;
        --input-bg: #f8fafc;
      }
      [data-theme="dark"] {
        --bg-base: #0f172a;
        --glass-bg: #0f172a;
        --glass-border: #334155;
        --input-bg: #1e293b;
      }

      body, html { background-color: var(--bg-base); }
      .app-container { display: flex; flex-direction: column; padding: 0; background: var(--bg-base); width: 100%; height: 100%; overflow: hidden; }
      .aurora-bg { display: none; }
      
      .sidebar { border-radius: 0; box-shadow: none; position: absolute; top: 0; left: 0; height: 100%; z-index: 100; border-right: 1px solid var(--glass-border); width: 280px; max-width: 85vw; transform: translateX(-100%); transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
      .sidebar.open { transform: translateX(0); }
      .new-chat-btn { background: var(--input-bg); }
      .session-item.active { background: var(--hover-bg); }
      .delete-btn { display: block; opacity: 1; color: var(--text-secondary); background: none; }
      
      .sidebar-overlay { backdrop-filter: none; -webkit-backdrop-filter: none; }
      .sidebar-overlay.active { display: block; opacity: 1; }
      
      .chat-area { background: transparent; border: none; box-shadow: none; border-radius: 0; width: 100%; overflow: hidden; }
      .header { border-bottom: 1px solid transparent; height: 60px; padding: 0 16px; justify-content: flex-start; }
      .header-title { display: none; }
      .menu-toggle { display: flex; }
      
      .messages-container { padding: 0; width: 100%; overflow-x: hidden; }
      .messages { padding: 24px 16px; gap: 32px; max-width: 100vw; width: 100%; overflow-x: hidden; box-sizing: border-box; }
      .message-row.user .message-bubble { border-radius: 22px 22px 4px 22px; max-width: 92%; }
      
      .input-wrapper { padding: 8px 16px 12px 16px; padding-bottom: max(16px, env(safe-area-inset-bottom)); width: 100%; max-width: 100vw; background: var(--bg-base); box-sizing: border-box; }
      .input-box { border: 1px solid var(--glass-border); box-shadow: 0 -4px 20px rgba(0,0,0,0.03); border-radius: 24px; padding: 12px 16px 16px 16px; gap: 12px; width: 100%; box-sizing: border-box; }
      .input-box:focus-within { transform: none; }
      
      .send-btn.active:hover { transform: none; }
      .input-bottom { min-height: 28px; }
      .disclaimer { margin-top: 12px; }
    }
  </style>
</head>
<body>

<div class="offline-banner" id="offlineBanner" role="status" aria-live="polite">
  <svg class="spin" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
  <span id="offlineText">网络已断开，正在尝试重连…</span>
</div>

<div class="aurora-bg">
  <div class="aurora-blob blob-1"></div>
  <div class="aurora-blob blob-2"></div>
  <div class="aurora-blob blob-3"></div>
</div>
<div class="sidebar-overlay" id="sidebarOverlay"></div>

<div class="settings-modal-overlay" id="settingsModal">
  <div class="settings-box">
    <h3 style="margin-top:0; font-size:20px; font-weight: 600; letter-spacing: -0.5px;">系统偏好设置</h3>
    <div style="margin-top: 20px;">
      <label style="font-size: 14px; font-weight: 500; color: var(--text-secondary); display: block; margin-bottom: 10px;">新对话默认模型</label>
      <select id="defaultModelSetting" class="settings-select">
        {{MODEL_OPTIONS}}
      </select>
    </div>
    <div style="margin-top: 20px;">
      <label style="font-size: 14px; font-weight: 500; color: var(--text-secondary); display: block; margin-bottom: 10px;">访问口令</label>
      <input type="password" id="accessTokenSetting" class="settings-input" placeholder="留空则不发送校验头" autocomplete="off">
      <div class="settings-hint">仅当服务端配置了 ACCESS_PASSWORD 时才需要填写，需与之一致。口令只保存在本机浏览器，不会上传。</div>
    </div>
    <div style="margin-top: 32px; text-align: right;">
      <button id="closeSettingsBtn" class="settings-btn">保存并关闭</button>
    </div>
  </div>
</div>

<div class="app-container">
  <div class="sidebar" id="sidebar">
    <div class="sidebar-header">
      <button class="new-chat-btn" id="newChatBtn">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        发起新对话
      </button>
    </div>
    <div class="session-list" id="sessionList"></div>
    <div class="sidebar-footer">
      <div style="display: flex; gap: 6px; flex-shrink: 0;">
        <button class="theme-toggle" id="settingsToggle" title="系统设置">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
        </button>
        <button class="theme-toggle" id="ttsToggle" title="自动朗读回复">
          <svg id="ttsIcon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>
        </button>
        <button class="theme-toggle" id="installBtn" title="安装到桌面 / 主屏幕" hidden>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
        </button>
        <button class="theme-toggle" id="themeToggle" title="切换主题">
          <svg id="themeIcon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
        </button>
      </div>
      <div style="font-size: 12px; color: var(--text-secondary); font-weight: 600; white-space: nowrap; flex-shrink: 0;">Pro v6.0</div>
    </div>
  </div>

  <div class="chat-area">
    <div class="header">
      <div class="header-inner">
        <button class="menu-toggle" id="menuToggle">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
        </button>
        <div class="header-title">
          <div class="status-dot" id="statusDot"></div>
          <span id="headerTitle">AI 核心处理中枢</span>
        </div>
      </div>
    </div>
    
    <div class="messages-container" id="scrollArea">
      <div class="messages" id="messages"></div>
      <div class="empty-state" id="emptyState">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
        <h2>今天我能为你提供什么帮助？</h2>
      </div>
    </div>

    <div class="input-wrapper">
      <div class="input-box">
        <div class="input-top">
          <textarea id="userInput" placeholder="输入指令或开始对话..." rows="1"></textarea>
          <button class="send-btn" id="sendBtn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
          </button>
        </div>
        
        <div class="input-bottom">
          <div class="model-selector-container">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--brand-color)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
            <span class="model-display-text" id="modelDisplayText">加载中...</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity:0.6; pointer-events:none;"><polyline points="6 9 12 15 18 9"></polyline></svg>
            <select class="model-select" id="modelSelect">
              {{MODEL_OPTIONS}}
            </select>
          </div>
        </div>
      </div>
      <div class="disclaimer">AI 生成的内容可能不准确，请核实重要信息。</div>
    </div>
  </div>
</div>

<script>
  let isCurrentlyStreaming = false;
  let currentAbortController = null; 

  const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
  const ESCAPE_REG = /[&<>]/g;
  const escapeHtml = str => str.replace(ESCAPE_REG, m => ESCAPE_MAP[m]);

  // AI 输出统一走 safeHtml：先 Markdown 渲染，再做 XSS 清洗。
  // DOMPurify 经 CDN 加载；若加载失败则降级为"解析后取纯文本"，保证永远安全。
  // 注意：本段在外层模板字符串内，不写反斜杠、反引号，避免两层转义破坏代码。
  function safeHtml(mdText) {
    var raw = '';
    try { raw = marked.parse(mdText || ''); } catch (e) { raw = ''; }
    try {
      if (window.DOMPurify && window.DOMPurify.sanitize) return window.DOMPurify.sanitize(raw);
    } catch (e) {}
    var tmp = document.createElement('div');
    tmp.innerHTML = raw;
    return tmp.textContent || '';
  }

  const renderer = new marked.Renderer();
  renderer.code = function(code, language) {
    const displayLang = language || 'text';
    const escapedCode = escapeHtml(code);
    
    let highlightedCode = escapedCode;
    if (!isCurrentlyStreaming && language && hljs.getLanguage(language)) {
      try {
        highlightedCode = hljs.highlight(code, { language }).value;
      } catch (e) {}
    } else if (!isCurrentlyStreaming) {
      try {
        highlightedCode = hljs.highlightAuto(code).value;
      } catch (e) {}
    }
    
    // 使用纯字符串拼接，消灭反引号
    return '<div class="code-wrapper">' +
             '<div class="code-header">' +
               '<span>' + displayLang + '</span>' +
               '<button class="copy-btn" data-code="' + encodeURIComponent(code) + '">' +
                 '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>' +
                 '<span>复制代码</span>' +
               '</button>' +
             '</div>' +
             '<pre><code class="hljs ' + (language || '') + '">' + highlightedCode + '</code></pre>' +
           '</div>';
  };

  marked.setOptions({ breaks: true, renderer: renderer });

  document.addEventListener('click', function(e) {
    const copyBtn = e.target.closest('.copy-btn');
    if (!copyBtn) return;
    const code = decodeURIComponent(copyBtn.getAttribute('data-code'));
    navigator.clipboard.writeText(code).then(() => {
      const span = copyBtn.querySelector('span');
      const originalText = span.innerText;
      span.innerText = '已复制';
      setTimeout(() => { span.innerText = originalText; }, 2000);
    });
  });

  // ===== 语音朗读（Web Speech API，浏览器原生，无需任何 API Key）=====
  const TTS_AUTO_KEY = 'tts_auto';
  let autoSpeak = localStorage.getItem(TTS_AUTO_KEY) === '1';
  let activeSpeakBtn = null;

  const SPEAK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>';

  function updateTtsToggleUI() {
    const btn = document.getElementById('ttsToggle');
    if (btn) {
      btn.classList.toggle('active', autoSpeak);
      btn.title = autoSpeak ? '自动朗读：已开启（点击关闭）' : '自动朗读：已关闭（点击开启）';
    }
  }

  // 把 Markdown / 代码块清理成适合朗读的纯文本
  // ⚠️ 本段位于外层模板字符串内部，存在「两层转义」：
  //    模板字符串吃掉一层反斜杠，浏览器解析 JS 字符串字面量再吃掉一层。
  //    因此这里【完全不写反斜杠】，一律用字符码拼接，避免正则被破坏。
  function cleanForSpeech(text) {
    if (!text) return '';
    const BT = String.fromCharCode(96);  // 反引号
    const BS = String.fromCharCode(92);  // 反斜杠
    const NL = String.fromCharCode(10);  // 换行
    const TAB = String.fromCharCode(9);
    // 用 @ 占位，展开成反斜杠；这样源码里不出现任何反斜杠
    const rx = function (p) { return p.split('@').join(BS); };

    const rules = [
      [BT + BT + BT + rx('[@s@S]*?') + BT + BT + BT, 'g', ' （代码块已省略） '],
      [BT + '([^' + BT + ']*)' + BT, 'g', '$1'],
      [rx('!@[[^@]]*@]@([^)]*@)'), 'g', ' （图片） '],
      [rx('@[([^@]]*)@]@([^)]*@)'), 'g', '$1'],
      [rx('^@s{0,3}#{1,6}@s*'), 'gm', ''],
      [rx('^@s{0,3}>@s?'), 'gm', ''],
      [rx('(@*@*|__)(.*?)@1'), 'g', '$2'],
      [rx('(@*|_)(.*?)@1'), 'g', '$2'],
      [rx('^@s*[-*+]@s+'), 'gm', ''],
      [rx('^@s*@d+@.@s+'), 'gm', ''],
      [rx('@|'), 'g', ' '],
      ['^[-=]{3,}$', 'gm', ' '],
      [rx('^[@s:-]*[-:][@s:-]*$'), 'gm', ''],
      ['[ ' + TAB + ']{2,}', 'g', ' '],
      [rx('@n{3,}'), 'g', NL + NL]
    ];

    let out = String(text);
    for (let i = 0; i < rules.length; i++) {
      try {
        out = out.replace(new RegExp(rules[i][0], rules[i][1]), rules[i][2]);
      } catch (e) { /* 单条规则异常不影响其余 */ }
    }
    return out.trim();
  }

  // 是否包含中日韩字符（用于选择朗读语言）
  function containsCJK(text) {
    const re = new RegExp('[' + String.fromCharCode(0x4e00) + '-' + String.fromCharCode(0x9fff) + ']');
    return re.test(text);
  }

  function getBubbleText(bubble) {
    const box = bubble.querySelector('.message-text') || bubble;
    return (box.innerText || box.textContent || '').trim();
  }

  function stopSpeaking() {
    if (window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
    if (activeSpeakBtn) {
      activeSpeakBtn.classList.remove('speaking');
      const span = activeSpeakBtn.querySelector('span');
      if (span) span.textContent = '朗读';
      activeSpeakBtn = null;
    }
  }

  function toggleSpeak(btn, bubble) {
    if (btn.classList.contains('speaking')) { stopSpeaking(); return; }

    if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
      alert('当前浏览器不支持语音朗读，请使用 Chrome / Edge / Safari 较新版本。');
      return;
    }

    stopSpeaking();

    const text = cleanForSpeech(getBubbleText(bubble));
    if (!text) return;

    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = containsCJK(text) ? 'zh-CN' : 'en-US';
    utter.rate = 1;
    utter.pitch = 1;

    const reset = () => {
      if (activeSpeakBtn === btn) {
        btn.classList.remove('speaking');
        const span = btn.querySelector('span');
        if (span) span.textContent = '朗读';
        activeSpeakBtn = null;
      }
    };
    utter.onend = reset;
    utter.onerror = reset;

    activeSpeakBtn = btn;
    btn.classList.add('speaking');
    const span = btn.querySelector('span');
    if (span) span.textContent = '停止';

    window.speechSynthesis.speak(utter);
  }

  // 给每条 AI 消息挂上「朗读」按钮（幂等，可重复调用）
  function ensureSpeakButton(bubble) {
    if (!bubble || bubble.querySelector('.msg-actions')) return;
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    const btn = document.createElement('button');
    btn.className = 'speak-btn';
    btn.type = 'button';
    btn.title = '朗读这条回复';
    btn.innerHTML = SPEAK_ICON + '<span>朗读</span>';
    btn.addEventListener('click', () => toggleSpeak(btn, bubble));
    actions.appendChild(btn);
    bubble.appendChild(actions);
  }

  // 会话本地存储：v6.1 起改用 cfchat_sessions；旧 key（nvidia_ai_sessions）的数据自动迁移
  const STORAGE_KEY = 'cfchat_sessions';
  const LEGACY_STORAGE_KEY = 'nvidia_ai_sessions';
  const MAX_SEND_MSGS = 60;   // 每次请求最多带最近 60 条消息，避免超长会话撑爆请求体
  const MAX_STORE_MSGS = 200; // 每个会话本地最多保留 200 条，超限从最旧开始丢弃
  function loadSessions() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
      if (raw) { var arr = JSON.parse(raw); if (Array.isArray(arr)) return arr; }
    } catch (e) {}
    return [];
  }
  let sessions = loadSessions();
  try {
    if (!localStorage.getItem(STORAGE_KEY) && localStorage.getItem(LEGACY_STORAGE_KEY)) {
      localStorage.setItem(STORAGE_KEY, localStorage.getItem(LEGACY_STORAGE_KEY));
    }
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch (e) {}
  let currentSessionId = null;

  // /api/chat 访问口令：存在本机浏览器，随请求以 X-Access-Token 头发出
  const ACCESS_TOKEN_KEY = 'access_token';
  let accessToken = localStorage.getItem(ACCESS_TOKEN_KEY) || '';

  const messagesDiv = document.getElementById('messages');
  const emptyState = document.getElementById('emptyState');
  const scrollArea = document.getElementById('scrollArea');
  const userInput = document.getElementById('userInput');
  const sendBtn = document.getElementById('sendBtn');
  const sessionListDiv = document.getElementById('sessionList');
  const modelSelect = document.getElementById('modelSelect');
  const headerTitle = document.getElementById('headerTitle');
  const modelDisplayText = document.getElementById('modelDisplayText');
  const statusDot = document.getElementById('statusDot');
  
  const sidebar = document.getElementById('sidebar');
  const menuToggle = document.getElementById('menuToggle');
  const sidebarOverlay = document.getElementById('sidebarOverlay');
  
  const themeToggle = document.getElementById('themeToggle');
  const themeIcon = document.getElementById('themeIcon');
  let currentTheme = localStorage.getItem('theme') || 'light';
  applyTheme(currentTheme);

  themeToggle.addEventListener('click', () => {
    currentTheme = currentTheme === 'light' ? 'dark' : 'light';
    localStorage.setItem('theme', currentTheme);
    applyTheme(currentTheme);
  });

  function applyTheme(theme) {
    if (theme === 'dark') {
      document.body.setAttribute('data-theme', 'dark');
      themeIcon.innerHTML = '<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>';
    } else {
      document.body.removeAttribute('data-theme');
      themeIcon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';
    }
  }

  userInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 200) + 'px';
    sendBtn.classList.toggle('active', this.value.trim().length > 0);
  });

  function init() {
    updateHeaderDisplay();
    if (sessions.length === 0) createNewSession();
    else switchSession(sessions[0].id);
    renderSessionList();
  }

  function saveSessions() {
    try {
      for (var i = 0; i < sessions.length; i++) {
        var msgs = sessions[i].messages;
        if (msgs && msgs.length > MAX_STORE_MSGS) {
          sessions[i].messages = msgs.slice(msgs.length - MAX_STORE_MSGS);
        }
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
    } catch (e) {}
  }

  menuToggle.addEventListener('click', () => { sidebar.classList.toggle('open'); sidebarOverlay.classList.toggle('active'); });
  sidebarOverlay.addEventListener('click', () => { sidebar.classList.remove('open'); sidebarOverlay.classList.remove('active'); });

  function updateHeaderDisplay() {
    if (modelSelect) {
      const selectedText = modelSelect.options[modelSelect.selectedIndex]?.text || 'AI 核心处理中枢';
      headerTitle.innerText = selectedText;
      if (modelDisplayText) modelDisplayText.innerText = selectedText;
    }
  }

  function createNewSession() {
    const newId = 'session_' + Date.now();
    const savedDefaultModel = localStorage.getItem('default_model');
    const fallbackModel = modelSelect.options.length > 0 ? modelSelect.options[0].value : "";
    const targetModel = savedDefaultModel || fallbackModel;

    sessions.unshift({ id: newId, title: '新对话', messages: [], model: targetModel });
    saveSessions();
    switchSession(newId);
    renderSessionList();
    if(window.innerWidth <= 768) sidebar.classList.remove('open');
  }

  function switchSession(id) {
    stopSpeaking();
    currentSessionId = id;
    const currentSession = sessions.find(s => s.id === id);
    if (currentSession && currentSession.model) {
      const exists = Array.from(modelSelect.options).some(opt => opt.value === currentSession.model);
      if (exists) {
        modelSelect.value = currentSession.model;
      } else {
        modelSelect.selectedIndex = 0;
        currentSession.model = modelSelect.value;
        saveSessions();
      }
    } else if (modelSelect.options.length > 0) {
      modelSelect.selectedIndex = 0;
    }
    updateHeaderDisplay();
    renderMessages();
    renderSessionList();
    if(window.innerWidth <= 768) { sidebar.classList.remove('open'); sidebarOverlay.classList.remove('active'); userInput.blur(); }
  }

  function onModelChange() {
    const currentSession = sessions.find(s => s.id === currentSessionId);
    if(currentSession) {
      currentSession.model = modelSelect.value;
      saveSessions();
    }
    updateHeaderDisplay();
  }
  modelSelect.addEventListener('change', onModelChange);
  modelSelect.addEventListener('input', onModelChange);

  function deleteSession(e, id) {
    e.stopPropagation(); 
    if (!confirm('确认删除此记录吗？')) return;
    sessions = sessions.filter(s => s.id !== id); 
    saveSessions();
    if (sessions.length === 0) createNewSession();
    else if (currentSessionId === id) switchSession(sessions[0].id);
    else renderSessionList();
  }

  function renderSessionList() {
    sessionListDiv.replaceChildren();
    const fragment = document.createDocumentFragment();

    sessions.forEach(session => {
      const item = document.createElement('div');
      item.className = 'session-item ' + (session.id === currentSessionId ? 'active' : '');
      item.onclick = () => switchSession(session.id);
      
      const titleSpan = document.createElement('span'); 
      titleSpan.className = 'session-title'; 
      titleSpan.innerText = session.title;
      
      const delBtn = document.createElement('button'); 
      delBtn.className = 'delete-btn'; 
      delBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4h4v2"></path></svg>';
      delBtn.onclick = (e) => deleteSession(e, session.id);
      
      item.appendChild(titleSpan); 
      item.appendChild(delBtn); 
      fragment.appendChild(item);
    });

    sessionListDiv.appendChild(fragment);
  }

  function renderMessages() {
    messagesDiv.replaceChildren();
    const currentSession = sessions.find(s => s.id === currentSessionId);
    if (!currentSession) return;
    
    if (currentSession.messages.length === 0) {
      emptyState.style.display = 'flex';
    } else { 
      emptyState.style.display = 'none'; 
      currentSession.messages.forEach(msg => {
        const uiRole = msg.role === 'assistant' ? 'ai' : msg.role;
        appendMessageDOM(uiRole, msg.content, null, false);
      }); 
    }
  }

  function appendMessageDOM(role, content, msgId = null, isError = false) {
    let row = msgId ? document.getElementById('row_' + msgId) : null;
    let bubble = msgId ? document.getElementById(msgId) : null;
    
    if (!row) {
      row = document.createElement('div'); 
      row.className = 'message-row ' + role;
      if (msgId) row.id = 'row_' + msgId; 
      if (isError) row.classList.add('error-msg');
      
      bubble = document.createElement('div'); 
      bubble.className = 'message-bubble'; 
      if (msgId) bubble.id = msgId;
      
      row.appendChild(bubble); 
      messagesDiv.appendChild(row);
    }
    
    if (role === 'ai') {
      if (msgId) {
        bubble.innerHTML = content;
      } else {
        isCurrentlyStreaming = false;
        bubble.innerHTML = '<div class="message-text markdown-body">' + safeHtml(content) + '</div>';
        bubble.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
      }
      ensureSpeakButton(bubble);
    } else {
      bubble.innerText = content; 
    }
    
    scrollArea.scrollTop = scrollArea.scrollHeight; 
    
    const rBox = bubble.querySelector('.reasoning-box');
    if (rBox) { rBox.scrollTop = rBox.scrollHeight; }

    return bubble;
  }

  async function sendMessage() {
    const text = userInput.value.trim(); 
    if (!text && !isCurrentlyStreaming) return;
    
    const currentSession = sessions.find(s => s.id === currentSessionId);
    if (currentSession.messages.length === 0) {
      currentSession.title = text.length > 14 ? text.substring(0, 14) + '...' : text;
      renderSessionList();
    }
    
    stopSpeaking();
    emptyState.style.display = 'none'; 
    userInput.value = ''; 
    userInput.style.height = 'auto';
    statusDot.classList.add('generating'); 
    
    appendMessageDOM('user', text);
    currentSession.messages.push({ role: 'user', content: text });
    saveSessions();

    const aiMsgId = 'ai_' + Date.now();
    // 字符串拼接替换模板字符串
    appendMessageDOM('ai', 
      '<div class="reasoning-box" style="display:none;"></div>' +
      '<div class="message-text markdown-body">' +
        '<div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>' +
      '</div>', aiMsgId);
    
    const bubble = document.getElementById(aiMsgId);
    isCurrentlyStreaming = true;
    
    currentAbortController = new AbortController();
    sendBtn.classList.remove('active');
    sendBtn.classList.add('stop-mode');
    sendBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="2" ry="2"></rect></svg>';

    try {
      const reqHeaders = { 'Content-Type': 'application/json' };
      if (accessToken) reqHeaders['X-Access-Token'] = accessToken;

      let aiContent = '';
      let reasoningContent = '';
      let gotDone = false; // 是否收到 SSE 正常结束标记 data: [DONE]

      const rBox = bubble.querySelector('.reasoning-box');
      const tBox = bubble.querySelector('.message-text');

      let isRenderPending = false;
      let lastRenderTime = 0;
      const cursorHtml = '<span style="display:inline-block; width:6px; height:18px; background:var(--brand-color); animation:typing 1s infinite; vertical-align:middle; margin-left:4px; border-radius:2px;"></span>';

      function scheduleUpdateUI(force = false) {
        const now = Date.now();
        if (!force && now - lastRenderTime < 60) return;
        if (isRenderPending) return;
        isRenderPending = true;

        requestAnimationFrame(() => {
          isRenderPending = false;
          lastRenderTime = Date.now();

          if (!isCurrentlyStreaming && !force) return;

          if (reasoningContent && rBox) {
            if (rBox.style.display === 'none') rBox.style.display = 'block';
            rBox.textContent = reasoningContent;
            rBox.scrollTop = rBox.scrollHeight;
          }

          if (aiContent || !reasoningContent) {
            tBox.innerHTML = safeHtml(aiContent) + (isCurrentlyStreaming ? cursorHtml : '');
          } else if (reasoningContent && !aiContent) {
            tBox.innerHTML = '<div style="color: var(--brand-color); font-size: 14px; font-weight: 500;">正在深度思考... ▍</div>';
          }

          const distanceToBottom = scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight;
          if (distanceToBottom < 120) {
            scrollArea.scrollTop = scrollArea.scrollHeight;
          }
        });
      }

      // 自动重试提示条（只在断流重试时短暂出现）
      let retryNoticeEl = null;
      function setRetryNotice(text) {
        if (!text) {
          if (retryNoticeEl && retryNoticeEl.parentNode) retryNoticeEl.parentNode.removeChild(retryNoticeEl);
          retryNoticeEl = null;
          return;
        }
        if (!retryNoticeEl) {
          retryNoticeEl = document.createElement('div');
          retryNoticeEl.className = 'retry-notice';
          bubble.appendChild(retryNoticeEl);
        }
        retryNoticeEl.textContent = text;
      }

      // 重试前清空本轮残留，重新完整生成一次（避免新旧内容拼接错乱）
      function resetStreamUI() {
        aiContent = '';
        reasoningContent = '';
        gotDone = false;
        if (rBox) { rBox.style.display = 'none'; rBox.textContent = ''; }
        tBox.innerHTML = '';
      }

      // 单次流式请求。收到 [DONE] 返回 true；网络/鉴权等错误直接 throw。
      // 注意：流被"静默掐断"（done=true 但无 [DONE]）不会抛错，由外层按 gotDone 判定。
      async function runOnce() {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: reqHeaders,
          body: JSON.stringify({
            messages: currentSession.messages.slice(-MAX_SEND_MSGS),
            model: modelSelect.value
          }),
          signal: currentAbortController.signal
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: '网络或服务接口错误' }));
          if (response.status === 401) {
            openSettings();
            const authErr = new Error('访问口令错误或未填写');
            authErr.name = 'AuthError';
            throw authErr;
          }
          throw new Error(errorData.error || '请求失败');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          let lines = buffer.split('\\n');
          buffer = lines.pop();

          for (let line of lines) {
            line = line.trim();
            if (!line.startsWith('data:')) continue;
            // 结束标记：兼容 data:[DONE]（无空格）写法
            if (line.slice(5).trim() === '[DONE]') { gotDone = true; continue; }
            try {
              const data = JSON.parse(line.slice(5).trim());
              if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

              if (data.choices && data.choices[0].delta) {
                const delta = data.choices[0].delta;
                if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
                if (delta.content !== undefined && delta.content !== null) aiContent += delta.content;
                scheduleUpdateUI();
              }
            } catch (e) {}
          }
        }

        if (!gotDone && buffer.trim() && buffer.trim().startsWith('data:') && !buffer.includes('[DONE]')) {
          try {
            const data = JSON.parse(buffer.slice(5).trim());
            if (data.choices && data.choices[0].delta) {
              const delta = data.choices[0].delta;
              if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
              if (delta.content) aiContent += delta.content;
            }
          } catch(e) {}
        }
      }

      // 主循环：深度思考时间越长越容易撞上边缘掐流/网络抖动，
      // 未收到 [DONE] 即视为异常中断，指数退避后自动重试。
      const MAX_AUTO_RETRY = 3;
      let attempt = 0;
      let streamError = null;
      while (true) {
        attempt++;
        streamError = null;
        try {
          await runOnce();
        } catch (e) {
          // 用户手动中止、口令问题：不重试，直接走统一错误处理
          if (e.name === 'AbortError' || e.name === 'AuthError') { setRetryNotice(null); throw e; }
          streamError = e;
        }
        if (gotDone) break;
        if (!streamError) streamError = new Error('连接意外中断（未收到结束标记）');
        if (attempt > MAX_AUTO_RETRY) break;
        resetStreamUI();
        setRetryNotice('连接意外中断，正在自动重试（第 ' + attempt + ' 次）…');
        await new Promise(function (resolve) { setTimeout(resolve, 1200 * attempt); });
      }
      setRetryNotice(null);
      if (!gotDone) throw streamError;

      isCurrentlyStreaming = false;
      if (!reasoningContent && rBox) rBox.remove();
      
      tBox.innerHTML = safeHtml(aiContent);
      tBox.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
      scrollArea.scrollTop = scrollArea.scrollHeight;

      // 自动朗读（若已在左下角开启）
      if (autoSpeak && aiContent && aiContent.trim()) {
        const sb = bubble.querySelector('.speak-btn');
        if (sb) toggleSpeak(sb, bubble);
      }
      
      currentSession.messages.push({ role: 'assistant', content: aiContent }); 
      saveSessions();
      
    } catch (error) {
      isCurrentlyStreaming = false;
      const tBox = bubble.querySelector('.message-text');
      
      if (error.name === 'AbortError') {
        const interruptNote = '<br><br><span style="color: var(--text-secondary); font-size: 13px; font-weight: 500;">(🛑 生成已手动中止)</span>';
        tBox.innerHTML = safeHtml(aiContent || '已中止') + interruptNote;
        if (aiContent) currentSession.messages.push({ role: 'assistant', content: aiContent });
      } else if (error.name === 'AuthError') {
        tBox.innerHTML = '<span style="color: var(--brand-color); font-size: 15px; font-weight: 600;">需要访问口令</span>' +
          '<div style="color: var(--text-secondary); font-size: 13px; margin-top: 8px; line-height: 1.6;">请在左下角「设置」中填写与服务端 ACCESS_PASSWORD 一致的口令，保存后重新发送。</div>';
        bubble.parentElement.classList.add('error-msg');
        currentSession.messages.pop();
        userInput.value = text;
        userInput.dispatchEvent(new Event('input'));
      } else {
        if (aiContent || reasoningContent) {
          // 字符串拼接替换模板字符串，彻底规避 CF 编辑器转义 Bug
          tBox.innerHTML = safeHtml(aiContent) + '<br><br><span style="color: #ef4444; font-size: 13px; font-weight: 500;">(⚠️ 网络连接中断，已保留当前生成的内容。错误: ' + error.message + ')</span>';
          currentSession.messages.push({ role: 'assistant', content: aiContent });
          if (rBox && reasoningContent) rBox.remove(); 
        } else {
          tBox.innerText = '通信断开: ' + error.message; 
          bubble.parentElement.classList.add('error-msg');
          currentSession.messages.pop(); 
        }
      }
      tBox.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
      saveSessions();
    } finally {
      isCurrentlyStreaming = false;
      currentAbortController = null;
      statusDot.classList.remove('generating'); 
      
      sendBtn.classList.remove('stop-mode');
      sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';
      
      if (userInput.value.trim().length > 0) sendBtn.classList.add('active'); 
      userInput.focus();
    }
  }

  sendBtn.addEventListener('click', () => {
    if (isCurrentlyStreaming && currentAbortController) {
      currentAbortController.abort(); 
    } else {
      sendMessage();
    }
  });

  userInput.addEventListener('keydown', (e) => { 
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault(); 
      if (sendBtn.classList.contains('active') && !isCurrentlyStreaming) { 
        sendMessage(); 
      }
    } 
  });
  
  const settingsModal = document.getElementById('settingsModal');
  const settingsToggle = document.getElementById('settingsToggle');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');
  const defaultModelSetting = document.getElementById('defaultModelSetting');
  const accessTokenSetting = document.getElementById('accessTokenSetting');

  if (defaultModelSetting) {
    defaultModelSetting.value = localStorage.getItem('default_model') || (modelSelect.options.length > 0 ? modelSelect.options[0].value : "");
  }
  if (accessTokenSetting) {
    accessTokenSetting.value = accessToken;
  }

  function openSettings() {
    settingsModal.style.display = 'flex';
    setTimeout(() => settingsModal.classList.add('active'), 10);
  }

  settingsToggle.addEventListener('click', openSettings);

  closeSettingsBtn.addEventListener('click', () => {
    settingsModal.classList.remove('active');
    if (defaultModelSetting.value) {
      localStorage.setItem('default_model', defaultModelSetting.value);
    }
    if (accessTokenSetting) {
      accessToken = accessTokenSetting.value.trim();
      if (accessToken) localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
      else localStorage.removeItem(ACCESS_TOKEN_KEY);
    }
    setTimeout(() => settingsModal.style.display = 'none', 300);
  });

  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettingsBtn.click();
  });

  document.getElementById('newChatBtn').addEventListener('click', createNewSession);

  // 左下角「自动朗读」开关
  const ttsToggleBtn = document.getElementById('ttsToggle');
  if (ttsToggleBtn) {
    ttsToggleBtn.addEventListener('click', () => {
      autoSpeak = !autoSpeak;
      localStorage.setItem(TTS_AUTO_KEY, autoSpeak ? '1' : '0');
      if (!autoSpeak) stopSpeaking();
      updateTtsToggleUI();
    });
  }
  updateTtsToggleUI();

  // 页面关闭 / 切换标签页时停止朗读
  window.addEventListener('beforeunload', stopSpeaking);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopSpeaking(); });

  // ================= PWA =================

  // 1) 注册 Service Worker（挂在根路径，scope 覆盖整站）
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  // 2) 离线检测 + 自动重连
  //    不依赖 navigator.onLine —— 它只反映网卡状态，判断不了「服务端是否可达」。
  //    改为轮询 /healthz；该路径在 Service Worker 中被显式放行且绝不缓存，
  //    否则探针会被缓存应答，永远「探测成功」，自动重连形同虚设。
  const offlineBanner = document.getElementById('offlineBanner');
  const offlineText = document.getElementById('offlineText');
  let offlineState = false;

  function setOffline(on, reason) {
    if (on === offlineState) return;
    offlineState = on;
    if (offlineBanner) offlineBanner.classList.toggle('show', on);
    if (on && offlineText && reason) offlineText.textContent = reason;
  }

  async function checkHealth() {
    try {
      const res = await fetch('/healthz', { cache: 'no-store' });
      if (!res.ok) throw new Error('unhealthy');
      if (offlineState) {
        setOffline(false);
        // 刚恢复：重绘当前会话，清掉离线期间残留的错误气泡
        if (!isCurrentlyStreaming) renderMessages();
      }
    } catch (e) {
      setOffline(true, '网络已断开，正在尝试重连…');
    }
  }

  window.addEventListener('online', checkHealth);
  window.addEventListener('offline', () => setOffline(true, '网络已断开，正在尝试重连…'));
  setInterval(checkHealth, 8000);
  checkHealth();

  // 3) 安装到桌面 / 主屏幕
  let deferredInstallPrompt = null;
  const installBtn = document.getElementById('installBtn');

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (installBtn) installBtn.hidden = false;
  });

  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      try { await deferredInstallPrompt.userChoice; } catch (e) {}
      deferredInstallPrompt = null;
      installBtn.hidden = true;
    });
  }

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    if (installBtn) installBtn.hidden = true;
  });

  // 已经以独立窗口方式运行时不再显示安装按钮
  if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) {
    if (installBtn) installBtn.hidden = true;
  }

  init();

  // 4) 支持 manifest 快捷方式 /?new=1 —— 直接开一个新会话
  try {
    if (new URLSearchParams(location.search).get('new') === '1' && sessions.length > 0) {
      createNewSession();
    }
  } catch (e) {}

</script>
</body>
</html>`;
