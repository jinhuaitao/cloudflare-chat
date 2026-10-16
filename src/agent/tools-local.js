// Agent 工具：科学计算器、时间与日期推算、天气、实时汇率/加密币价、维基百科、GitHub 检索、arXiv 论文检索、HackerNews 热榜、DNS/IP 诊断、开发者全能工具箱

import { mapSetBounded, mapGetBounded } from '../utils.js';
import { isBlockedFetchHost } from '../net/ssrf.js';

// v7.1.0：外部免密钥 API 结果 L1 缓存（TTL 3 分钟，最多 120 条），加速同轮/跨轮重复查询
const localApiCache = new Map();
const localApiExp = new Map();
const LOCAL_API_TTL_MS = 3 * 60 * 1000;

function getCachedApi(key) {
  return mapGetBounded(localApiCache, key, localApiExp);
}
function setCachedApi(key, val, ttlMs) {
  mapSetBounded(localApiCache, key, val, 120, localApiExp, ttlMs || LOCAL_API_TTL_MS);
}

// 安全科学计算器：递归下降解析，支持四则运算、乘方、括号、科学常量（pi/e）与常用数学函数，绝不使用 eval
function toolCalculate(expr) {
  try {
    const s = String(expr || '')
      .replace(/\s+/g, '')
      .replace(/×/g, '*')
      .replace(/÷/g, '/')
      .replace(/（/g, '(')
      .replace(/）/g, ')')
      .replace(/，/g, ',')
      .replace(/π/g, 'pi');
    if (!s) return '表达式为空';
    if (s.length > 500) return '表达式过长（上限 500 字符）';
    if (/[^0-9a-zA-Z_+\-*/%^(),.]/.test(s)) return '表达式含非法字符';

    const FUNCS = {
      sqrt: (a) => Math.sqrt(a[0]),
      cbrt: (a) => Math.cbrt(a[0]),
      abs: (a) => Math.abs(a[0]),
      round: (a) => a.length > 1 ? Number(a[0].toFixed(Math.max(0, Math.min(10, a[1] | 0)))) : Math.round(a[0]),
      floor: (a) => Math.floor(a[0]),
      ceil: (a) => Math.ceil(a[0]),
      sin: (a) => Math.sin(a[0]),
      cos: (a) => Math.cos(a[0]),
      tan: (a) => Math.tan(a[0]),
      asin: (a) => Math.asin(a[0]),
      acos: (a) => Math.acos(a[0]),
      atan: (a) => Math.atan(a[0]),
      ln: (a) => Math.log(a[0]),
      log: (a) => a.length > 1 ? Math.log(a[0]) / Math.log(a[1]) : Math.log10(a[0]),
      log10: (a) => Math.log10(a[0]),
      log2: (a) => Math.log2(a[0]),
      exp: (a) => Math.exp(a[0]),
      pow: (a) => Math.pow(a[0], a[1]),
      min: (a) => Math.min(...a),
      max: (a) => Math.max(...a),
      sum: (a) => a.reduce((acc, x) => acc + x, 0),
      avg: (a) => a.reduce((acc, x) => acc + x, 0) / a.length,
    };
    const CONSTS = {
      pi: Math.PI,
      e: Math.E,
    };

    let i = 0;
    let depth = 0;
    const MAX_DEPTH = 64;
    function enter() {
      depth += 1;
      if (depth > MAX_DEPTH) throw new Error('表达式嵌套过深');
    }
    function leave() { depth -= 1; }
    function parseExpr() {
      enter();
      try { return parseExprBody(); }
      finally { leave(); }
    }
    function parseExprBody() {
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
      if (s[i] === '-') { i++; return -parseFactor(); }
      if (s[i] === '+') { i++; return parseFactor(); }
      let v = parsePrimary();
      if (i < s.length && s[i] === '^') { i++; v = Math.pow(v, parseFactor()); }
      return v;
    }
    function parsePrimary() {
      if (s[i] === '(') {
        i++;
        const v = parseExpr();
        if (s[i] !== ')') throw new Error('括号不匹配');
        i++;
        return v;
      }
      if (/[a-zA-Z_]/.test(s[i])) {
        let j = i;
        while (j < s.length && /[a-zA-Z0-9_]/.test(s[j])) j++;
        const ident = s.slice(i, j).toLowerCase();
        i = j;
        if (s[i] === '(') {
          const fn = FUNCS[ident];
          if (!fn) throw new Error('不支持的函数: ' + ident);
          i++; // skip '('
          const args = [];
          if (s[i] !== ')') {
            args.push(parseExpr());
            while (i < s.length && s[i] === ',') {
              i++;
              args.push(parseExpr());
            }
          }
          if (s[i] !== ')') throw new Error('函数括号不匹配: ' + ident);
          i++;
          if (!args.length) throw new Error('函数缺少参数: ' + ident);
          return fn(args);
        }
        if (Object.prototype.hasOwnProperty.call(CONSTS, ident)) {
          return CONSTS[ident];
        }
        throw new Error('未知常量或标识符: ' + ident);
      }
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      if (j === i) throw new Error('意外的字符: ' + s[i]);
      const numStr = s.slice(i, j);
      if (!/^(\d+\.?\d*|\.\d+)$/.test(numStr)) throw new Error('数字格式非法: ' + numStr);
      const n = parseFloat(numStr);
      i = j;
      if (i < s.length && (s[i] === 'e' || s[i] === 'E') && /[0-9+\-]/.test(s[i + 1] || '')) {
        let k = i + 1;
        if (s[k] === '+' || s[k] === '-') k++;
        const expStart = k;
        while (k < s.length && /[0-9]/.test(s[k])) k++;
        if (k > expStart) {
          const sciVal = parseFloat(numStr + s.slice(i, k));
          i = k;
          if (!isFinite(sciVal)) throw new Error('数字非法');
          return sciVal;
        }
      }
      if (!isFinite(n)) throw new Error('数字非法');
      return n;
    }
    const v = parseExpr();
    if (i !== s.length) throw new Error('表达式未完全解析');
    if (!isFinite(v)) return '计算结果非法（可能除零或结果溢出）';
    const av = Math.abs(v);
    const out = (av >= 1e-6 && av < 1e15) ? Math.round(v * 1e10) / 1e10 : v;
    return '计算结果：' + String(out);
  } catch (e) { return '计算失败: ' + e.message; }
}

// 解析 YYYY-MM-DD 为 UTC 零点毫秒数
function parseIsoDateUtc(str) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(str || '').trim());
  if (!m) return null;
  const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, mo - 1, d);
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return ms;
}

// 增强版时间与日期推算：支持当前时间、两日期间隔天数（target_date）、日期加减天数（add_days）与 Unix 时间戳互转
function toolGetTime(timezone, opts) {
  if (timezone && typeof timezone === 'object') {
    opts = timezone;
    timezone = opts.timezone;
  }
  opts = opts || {};
  const tz = String(timezone || 'Asia/Shanghai').trim() || 'Asia/Shanghai';
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'long'
    });
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now);
    const y = parts.find(p => p.type === 'year')?.value;
    const mo = parts.find(p => p.type === 'month')?.value;
    const da = parts.find(p => p.type === 'day')?.value;
    const todayIso = `${y}-${mo}-${da}`;

    let out = '当前时间（' + tz + '）：' + fmt.format(now) + '（Unix 秒级时间戳：' + Math.floor(now.getTime() / 1000) + '）';
    const baseIso = String(opts.base_date || todayIso).trim();
    const baseMs = parseIsoDateUtc(baseIso);

    if (opts.target_date) {
      const targetIso = String(opts.target_date).trim();
      const targetMs = parseIsoDateUtc(targetIso);
      if (baseMs === null || targetMs === null) {
        out += '\n日期格式无效（请使用 YYYY-MM-DD 格式，如 2026-12-31）';
      } else {
        const diffDays = Math.round((targetMs - baseMs) / 86400000);
        const absDays = Math.abs(diffDays);
        const weeks = Math.floor(absDays / 7);
        const remDays = absDays % 7;
        const wkNote = weeks > 0 ? `（即 ${weeks} 周${remDays > 0 ? '零 ' + remDays + ' 天' : ''}）` : '';
        const targetWk = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', weekday: 'long' }).format(new Date(targetMs));
        out += `\n日期差推算：从 ${baseIso} 到 ${targetIso}（${targetWk}）共相差 ${diffDays} 天${wkNote}`;
      }
    }

    if (opts.add_days !== undefined && opts.add_days !== null && opts.add_days !== '') {
      const delta = parseInt(opts.add_days, 10);
      if (!isNaN(delta) && baseMs !== null) {
        const resMs = baseMs + delta * 86400000;
        const resDate = new Date(resMs);
        const resIso = resDate.toISOString().slice(0, 10);
        const resWk = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', weekday: 'long' }).format(resDate);
        out += `\n日期加减推算：${baseIso} ${delta >= 0 ? '加上 ' + delta : '减去 ' + Math.abs(delta)} 天后为 ${resIso}（${resWk}）`;
      }
    }

    return out;
  } catch (e) { return '时区无效: ' + tz; }
}

async function fetchJson(url, timeoutMs, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: headers || {} });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function fetchText(url, timeoutMs, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: headers || {} });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally { clearTimeout(timer); }
}

async function toolGetWeather(city) {
  city = String(city || '').trim();
  if (!city) return '城市名为空';
  const cacheKey = 'weather:' + city.toLowerCase();
  const cached = getCachedApi(cacheKey);
  if (cached) return cached;
  try {
    const g = await fetchJson('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(city) + '&count=1&language=zh&format=json');
    if (!g.results || !g.results.length) return '找不到城市：' + city;
    const loc = g.results[0];
    const w = await fetchJson('https://api.open-meteo.com/v1/forecast?latitude=' + loc.latitude + '&longitude=' + loc.longitude +
      '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m' +
      '&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&forecast_days=3');
    const wm = { 0: '晴', 1: '大致晴', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇', 51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨', 71: '小雪', 73: '中雪', 75: '大雪', 80: '阵雨', 81: '阵雨', 82: '暴雨', 95: '雷阵雨' };
    const c = w.current, d = w.daily;
    let t = loc.name + '（' + (loc.country || '') + '）当前：' + (wm[c.weather_code] || '未知') +
      '，' + c.temperature_2m + '°C，体感' + c.apparent_temperature + '°C，湿度' + c.relative_humidity_2m + '%，风速' + c.wind_speed_10m + 'km/h\n';
    t += '未来三天预报：' + d.time.map((dt, i) => dt.slice(5) + ' ' + (wm[d.weather_code[i]] || '') + ' ' + d.temperature_2m_min[i] + '~' + d.temperature_2m_max[i] + '°C').join('；');
    setCachedApi(cacheKey, t, 5 * 60 * 1000);
    return t;
  } catch (e) { return '天气查询失败: ' + e.message; }
}

// 实时法币汇率换算 & 主流加密货币实时行情
const CRYPTO_ID_MAP = {
  BTC: 'bitcoin', BITCOIN: 'bitcoin',
  ETH: 'ethereum', ETHEREUM: 'ethereum',
  SOL: 'solana', SOLANA: 'solana',
  BNB: 'binancecoin',
  DOGE: 'dogecoin', DOGECOIN: 'dogecoin',
  XRP: 'ripple',
  ADA: 'cardano',
  TON: 'the-open-network',
  SUI: 'sui',
  TRX: 'tron',
  DOT: 'polkadot',
  AVAX: 'avalanche-2',
  LINK: 'chainlink',
  LTC: 'litecoin',
};

const CURRENCY_ALIASES = {
  '人民币': 'CNY', 'RMB': 'CNY', 'CNH': 'CNY', '元': 'CNY',
  '美元': 'USD', '美金': 'USD', '刀': 'USD',
  '日元': 'JPY', '日币': 'JPY',
  '欧元': 'EUR',
  '英镑': 'GBP',
  '港币': 'HKD', '港元': 'HKD',
  '新台币': 'TWD', '台币': 'TWD',
  '韩元': 'KRW',
  '新币': 'SGD', '新加坡元': 'SGD',
  '澳元': 'AUD', '加元': 'CAD', '瑞士法郎': 'CHF',
};

function normCurrencyCode(c) {
  const raw = String(c || '').trim();
  if (!raw) return '';
  const up = raw.toUpperCase();
  return CURRENCY_ALIASES[raw] || CURRENCY_ALIASES[up] || up;
}

async function toolExchangeRate(args) {
  args = args || {};
  const from = normCurrencyCode(args.from || 'USD');
  const to = normCurrencyCode(args.to || 'CNY');
  const amount = isFinite(parseFloat(args.amount)) && parseFloat(args.amount) > 0 ? parseFloat(args.amount) : 1;
  if (!from || !to) return '汇率查询失败: 请提供源货币与目标货币代码（如 USD、CNY、JPY、BTC）';

  const cacheKey = `fx:${from}:${to}:${amount}`;
  const cached = getCachedApi(cacheKey);
  if (cached) return cached;

  try {
    const cryptoId = CRYPTO_ID_MAP[from] || CRYPTO_ID_MAP[to];
    if (cryptoId) {
      const isFromCrypto = !!CRYPTO_ID_MAP[from];
      const fiat = (isFromCrypto ? to : from).toLowerCase();
      const cg = await fetchJson(
        `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(cryptoId)}&vs_currencies=${encodeURIComponent(fiat)},usd,cny&include_24hr_change=true`,
        10000,
        { 'Accept': 'application/json', 'User-Agent': 'Cloudflare-Chat/7.1' }
      );
      const item = cg && cg[cryptoId];
      if (!item) return '汇率查询失败: 未找到加密货币 ' + (isFromCrypto ? from : to) + ' 的实时行情';
      const rate = item[fiat];
      const chg = typeof item[fiat + '_24h_change'] === 'number'
        ? item[fiat + '_24h_change'].toFixed(2) + '%'
        : (typeof item.usd_24h_change === 'number' ? item.usd_24h_change.toFixed(2) + '%' : '未知');
      if (typeof rate === 'number' && rate > 0) {
        const converted = isFromCrypto ? (amount * rate) : (amount / rate);
        const resText = `实时加密行情（CoinGecko）：\n1 ${isFromCrypto ? from : to} = ${rate} ${(isFromCrypto ? to : from)}（USD: $${item.usd || '-'} / CNY: ¥${item.cny || '-'}，24h 涨跌：${chg}）\n换算结果：${amount} ${from} ≈ ${Number(converted.toFixed(6))} ${to}`;
        setCachedApi(cacheKey, resText, 90 * 1000);
        return resText;
      }
    }

    let rate = null;
    let dateStr = '';
    try {
      const er = await fetchJson(`https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`, 10000);
      if (er && er.rates && typeof er.rates[to] === 'number') {
        rate = er.rates[to];
        dateStr = er.time_last_update_utc ? er.time_last_update_utc.slice(0, 16) : '';
      }
    } catch (e) {}

    if (rate === null) {
      const fk = await fetchJson(`https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(from)}&symbols=${encodeURIComponent(to)}`, 10000);
      if (fk && fk.rates && typeof fk.rates[to] === 'number') {
        rate = fk.rates[to];
        dateStr = fk.date || '';
      }
    }

    if (rate === null) return `汇率查询失败: 暂不支持 ${from} → ${to} 的直接汇率换算`;
    const converted = Math.round(amount * rate * 10000) / 10000;
    const out = `实时汇率${dateStr ? '（更新：' + dateStr + '）' : ''}：\n1 ${from} = ${rate} ${to}\n换算结果：${amount} ${from} = ${converted} ${to}`;
    setCachedApi(cacheKey, out);
    return out;
  } catch (e) {
    return '汇率查询失败: ' + e.message;
  }
}

// 维基百科权威词条检索（自动识别中英文，支持搜索 + 摘要提取）
async function toolWikiLookup(query, lang) {
  query = String(query || '').trim();
  if (!query) return '维基百科查询关键词为空';
  const hasCjk = /[\u4e00-\u9fff]/.test(query);
  const wikiLang = (lang === 'en' || lang === 'zh') ? lang : (hasCjk ? 'zh' : 'en');
  const cacheKey = `wiki:${wikiLang}:${query.toLowerCase()}`;
  const cached = getCachedApi(cacheKey);
  if (cached) return cached;

  const host = `https://${wikiLang}.wikipedia.org`;
  const headers = {
    'User-Agent': 'Cloudflare-Chat/7.1 (https://workers.cloudflare.com)',
    'Accept-Language': wikiLang === 'zh' ? 'zh-CN,zh;q=0.9' : 'en-US,en;q=0.9'
  };
  try {
    const searchUrl = `${host}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=3&utf8=1&format=json`;
    const sr = await fetchJson(searchUrl, 10000, headers);
    const hits = (sr && sr.query && sr.query.search) || [];
    if (!hits.length) {
      if (wikiLang === 'zh' && !lang) return await toolWikiLookup(query, 'en');
      return `维基百科未找到「${query}」相关词条`;
    }
    const topTitle = hits[0].title;
    const sumUrl = `${host}/api/rest_v1/page/summary/${encodeURIComponent(topTitle)}`;
    let extract = '';
    let pageUrl = `${host}/wiki/${encodeURIComponent(topTitle)}`;
    try {
      const sum = await fetchJson(sumUrl, 10000, headers);
      if (sum && sum.extract) extract = sum.extract;
      if (sum && sum.content_urls && sum.content_urls.desktop && sum.content_urls.desktop.page) {
        pageUrl = sum.content_urls.desktop.page;
      }
    } catch (e) {}
    if (!extract) {
      extract = String(hits[0].snippet || '').replace(/<[^>]*>/g, '');
    }
    let out = `【维基百科 (${wikiLang})：《${topTitle}》】\n链接：${pageUrl}\n摘要：${extract.slice(0, 2500)}`;
    if (hits.length > 1) {
      out += '\n\n相关词条：\n' + hits.slice(1).map(h => `- 《${h.title}》：${String(h.snippet || '').replace(/<[^>]*>/g, '').slice(0, 120)}`).join('\n');
    }
    setCachedApi(cacheKey, out);
    return out;
  } catch (e) {
    return '维基百科查询失败: ' + e.message;
  }
}

// ==================== v7.1.0 新增免密钥工具 1：GitHub 开源仓库与 Release 检索 ====================
async function toolGithubLookup(args) {
  args = args || {};
  const query = String(args.query || '').trim();
  if (!query) return 'GitHub 查询失败: 关键词或仓库名不能为空';
  const mode = String(args.mode || '').toLowerCase();
  const isRepoSlug = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(query) && mode !== 'search';
  const cacheKey = `gh:${isRepoSlug ? 'repo' : 'search'}:${query.toLowerCase()}`;
  const cached = getCachedApi(cacheKey);
  if (cached) return cached;

  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'Cloudflare-Chat/7.1'
  };
  try {
    if (isRepoSlug) {
      const repo = await fetchJson(`https://api.github.com/repos/${query}`, 10000, headers);
      let out = `【GitHub 仓库：${repo.full_name}】\n`
        + `链接：${repo.html_url}\n`
        + `简介：${repo.description || '无'}\n`
        + `数据：⭐ ${repo.stargazers_count} Stars | 🍴 ${repo.forks_count} Forks | 🐛 ${repo.open_issues_count} Open Issues\n`
        + `语言：${repo.language || '未知'} | 协议：${(repo.license && repo.license.spdx_id) || '未声明'} | 最近推送：${(repo.pushed_at || '').slice(0, 10)}`;
      if (Array.isArray(repo.topics) && repo.topics.length) {
        out += `\n标签：${repo.topics.slice(0, 10).join(', ')}`;
      }
      // 并发尝试读取最新 Release 与 README 前 1500 字
      const [rel, readme] = await Promise.all([
        fetchJson(`https://api.github.com/repos/${query}/releases/latest`, 6000, headers).catch(() => null),
        fetchJson(`https://api.github.com/repos/${query}/readme`, 6000, headers).catch(() => null)
      ]);
      if (rel && rel.tag_name) {
        out += `\n最新发版：${rel.tag_name}（${(rel.published_at || '').slice(0, 10)}）${rel.name ? ' - ' + rel.name : ''}`;
        if (rel.body) out += `\n发版说明摘要：${String(rel.body).replace(/\s+/g, ' ').slice(0, 350)}`;
      }
      if (readme && readme.content && readme.encoding === 'base64') {
        try {
          const bin = atob(String(readme.content).replace(/\s+/g, ''));
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const md = new TextDecoder('utf-8').decode(bytes).replace(/<[^>]*>/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
          if (md) out += `\n\nREADME 摘要：\n${md.slice(0, 1400)}`;
        } catch (e) {}
      }
      setCachedApi(cacheKey, out);
      return out;
    }

    const sort = args.sort === 'updated' ? 'updated' : 'stars';
    const sr = await fetchJson(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=${sort}&order=desc&per_page=5`,
      10000,
      headers
    );
    const items = (sr && sr.items) || [];
    if (!items.length) return `GitHub 未找到与「${query}」相关的开源仓库`;
    let out = `GitHub 搜索「${query}」热门仓库（共找到 ${sr.total_count || items.length} 个）：\n`;
    items.forEach((r, idx) => {
      out += `${idx + 1}. **${r.full_name}** (⭐ ${r.stargazers_count} | ${r.language || '未知'} | 更新: ${(r.pushed_at || '').slice(0, 10)})\n`
        + `   链接：${r.html_url}\n`
        + `   简介：${(r.description || '无简介').slice(0, 180)}\n`;
    });
    setCachedApi(cacheKey, out);
    return out;
  } catch (e) {
    return 'GitHub 查询失败: ' + e.message;
  }
}

// ==================== v7.1.0 新增免密钥工具 2：arXiv 学术论文检索 ====================
async function toolArxivSearch(args) {
  args = args || {};
  const query = String(args.query || '').trim();
  if (!query) return 'arXiv 查询失败: 检索关键词不能为空';
  const maxResults = Math.min(Math.max(parseInt(args.count, 10) || 4, 1), 6);
  const sortBy = args.sort === 'date' ? 'submittedDate' : 'relevance';
  const cacheKey = `arxiv:${sortBy}:${maxResults}:${query.toLowerCase()}`;
  const cached = getCachedApi(cacheKey);
  if (cached) return cached;

  try {
    const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${maxResults}&sortBy=${sortBy}&sortOrder=descending`;
    const xml = await fetchText(url, 12000, { 'User-Agent': 'Cloudflare-Chat/7.1' });
    const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
    const entries = [];
    let m;
    const cleanXml = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    while ((m = entryRe.exec(xml))) {
      const b = m[1];
      const titleM = /<title>([\s\S]*?)<\/title>/.exec(b);
      const sumM = /<summary>([\s\S]*?)<\/summary>/.exec(b);
      const pubM = /<published>([\s\S]*?)<\/published>/.exec(b);
      const idM = /<id>([\s\S]*?)<\/id>/.exec(b);
      const authors = [];
      const authRe = /<author>\s*<name>([\s\S]*?)<\/name>/g;
      let am;
      while ((am = authRe.exec(b)) && authors.length < 5) authors.push(cleanXml(am[1]));
      if (titleM) {
        const absUrl = idM ? cleanXml(idM[1]) : '';
        const pdfUrl = absUrl ? absUrl.replace('/abs/', '/pdf/') : '';
        entries.push({
          title: cleanXml(titleM[1]),
          authors: authors.join(', '),
          published: pubM ? cleanXml(pubM[1]).slice(0, 10) : '',
          summary: sumM ? cleanXml(sumM[1]).slice(0, 420) : '',
          url: absUrl,
          pdf: pdfUrl
        });
      }
    }
    if (!entries.length) return `arXiv 未找到与「${query}」相关的学术论文`;
    let out = `arXiv 学术论文检索「${query}」结果：\n`;
    entries.forEach((e, i) => {
      out += `${i + 1}. 《${e.title}》（${e.published}）\n`
        + `   作者：${e.authors || '未知'}\n`
        + `   链接：${e.url}${e.pdf ? ' | PDF: ' + e.pdf : ''}\n`
        + `   摘要：${e.summary}${e.summary.length >= 420 ? '…' : ''}\n`;
    });
    setCachedApi(cacheKey, out);
    return out;
  } catch (e) {
    return 'arXiv 查询失败: ' + e.message;
  }
}

// ==================== v7.1.0 新增免密钥工具 3：Hacker News 科技热榜与实时讨论检索 ====================
async function toolHnTop(args) {
  args = args || {};
  const query = String(args.query || '').trim();
  const count = Math.min(Math.max(parseInt(args.count, 10) || 6, 1), 10);
  const cacheKey = `hn:${count}:${query.toLowerCase() || '__front__'}`;
  const cached = getCachedApi(cacheKey);
  if (cached) return cached;

  try {
    const apiUrl = query
      ? `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${count}`
      : `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${count}`;
    const data = await fetchJson(apiUrl, 10000, { 'User-Agent': 'Cloudflare-Chat/7.1' });
    const hits = (data && data.hits) || [];
    if (!hits.length) return query ? `Hacker News 未找到「${query}」相关讨论` : 'Hacker News 首页热榜暂时为空';
    let out = query ? `Hacker News 关于「${query}」的热门讨论：\n` : 'Hacker News 当前首页科技热榜：\n';
    hits.forEach((h, i) => {
      const hnUrl = `https://news.ycombinator.com/item?id=${h.objectID}`;
      out += `${i + 1}. ${h.title || '无标题'} (👍 ${h.points || 0} | 💬 ${h.num_comments || 0} 评论 | ${(h.created_at || '').slice(0, 10)})\n`
        + `   原文：${h.url || hnUrl}\n`
        + `   讨论：${hnUrl}\n`;
    });
    setCachedApi(cacheKey, out);
    return out;
  } catch (e) {
    return 'Hacker News 查询失败: ' + e.message;
  }
}

// ==================== v7.1.0 新增免密钥工具 4：DNS 权威解析 (DoH) 与 IP 归属地/ASN 诊断 ====================
async function toolNetLookup(args) {
  args = args || {};
  const target = String(args.target || '').trim();
  if (!target) return '网络诊断失败: 请提供要查询的域名或公网 IP 地址';
  const recordType = String(args.type || 'A').toUpperCase().trim();
  const isIp = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(target) || (target.indexOf(':') !== -1 && /^[0-9a-fA-F:]+$/.test(target));

  if (isBlockedFetchHost(target)) {
    return '网络诊断拒绝: 目标为内网、回环或保留地址（' + target + '）';
  }

  const cacheKey = `net:${isIp ? 'ip' : recordType}:${target.toLowerCase()}`;
  const cached = getCachedApi(cacheKey);
  if (cached) return cached;

  try {
    if (isIp || recordType === 'IP' || recordType === 'GEO') {
      const info = await fetchJson(`https://ipwho.is/${encodeURIComponent(target)}`, 10000, { 'User-Agent': 'Cloudflare-Chat/7.1' });
      if (!info || info.success === false) {
        return `IP 归属查询失败: ${info && info.message ? info.message : '无法解析该地址'}`;
      }
      const conn = info.connection || {};
      const tz = info.timezone || {};
      const out = `【IP / 网络归属诊断：${info.ip || target}】\n`
        + `地区：${info.country || ''} ${info.region || ''} ${info.city || ''} (${info.country_code || ''})\n`
        + `运营商 / 组织：${conn.isp || '-'} / ${conn.org || '-'}\n`
        + `ASN：${conn.asn ? 'AS' + conn.asn : '-'} ${conn.domain ? '(' + conn.domain + ')' : ''}\n`
        + `坐标与时区：${info.latitude ?? '-'}, ${info.longitude ?? '-'} | ${tz.id || '-'}`;
      setCachedApi(cacheKey, out);
      return out;
    }

    const allowedTypes = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'CAA'];
    const qType = allowedTypes.indexOf(recordType) !== -1 ? recordType : 'A';
    const dns = await fetchJson(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(target)}&type=${qType}`,
      8000,
      { 'Accept': 'application/dns-json' }
    );
    const ans = (dns && dns.Answer) || [];
    if (!ans.length) {
      return `DNS 查询（${target} [${qType}]）：无记录返回（Status=${dns ? dns.Status : 'unknown'}）`;
    }
    const out = `【Cloudflare DoH DNS 解析：${target} (${qType})】\n`
      + ans.map(a => `- ${a.name} [TTL ${a.TTL}s] → ${a.data}`).join('\n');
    setCachedApi(cacheKey, out);
    return out;
  } catch (e) {
    return '网络诊断失败: ' + e.message;
  }
}

// ==================== v7.1.0 新增免密钥工具 5：全能确定性工具箱（单位换算 / 哈希摘要 / 编解码 / 文本统计 / UUID） ====================
const UNIT_TABLE = {
  // 长度（基准：米 m）
  mm: { cat: 'len', k: 0.001 }, cm: { cat: 'len', k: 0.01 }, m: { cat: 'len', k: 1 }, km: { cat: 'len', k: 1000 },
  in: { cat: 'len', k: 0.0254 }, inch: { cat: 'len', k: 0.0254 }, ft: { cat: 'len', k: 0.3048 }, foot: { cat: 'len', k: 0.3048 },
  yd: { cat: 'len', k: 0.9144 }, mi: { cat: 'len', k: 1609.344 }, mile: { cat: 'len', k: 1609.344 }, nmi: { cat: 'len', k: 1852 },
  // 重量（基准：克 g）
  mg: { cat: 'wt', k: 0.001 }, g: { cat: 'wt', k: 1 }, kg: { cat: 'wt', k: 1000 }, t: { cat: 'wt', k: 1e6 },
  oz: { cat: 'wt', k: 28.349523125 }, lb: { cat: 'wt', k: 453.59237 }, jin: { cat: 'wt', k: 500 }, '斤': { cat: 'wt', k: 500 }, '两': { cat: 'wt', k: 50 },
  // 面积（基准：平方米 m2）
  cm2: { cat: 'area', k: 0.0001 }, m2: { cat: 'area', k: 1 }, sqm: { cat: 'area', k: 1 }, km2: { cat: 'area', k: 1e6 },
  ha: { cat: 'area', k: 10000 }, acre: { cat: 'area', k: 4046.8564224 }, sqft: { cat: 'area', k: 0.09290304 },
  mu: { cat: 'area', k: 666.6666667 }, '亩': { cat: 'area', k: 666.6666667 }, '坪': { cat: 'area', k: 3.305785 },
  // 体积（基准：升 l）
  ml: { cat: 'vol', k: 0.001 }, l: { cat: 'vol', k: 1 }, m3: { cat: 'vol', k: 1000 },
  gal: { cat: 'vol', k: 3.785411784 }, floz: { cat: 'vol', k: 0.0295735296 }, cup: { cat: 'vol', k: 0.2365882365 },
  // 速度（基准：m/s）
  'm/s': { cat: 'spd', k: 1 }, 'km/h': { cat: 'spd', k: 1 / 3.6 }, kph: { cat: 'spd', k: 1 / 3.6 },
  mph: { cat: 'spd', k: 0.44704 }, kn: { cat: 'spd', k: 1852 / 3600 }, knot: { cat: 'spd', k: 1852 / 3600 },
  // 数据存储（基准：Byte）
  b: { cat: 'data', k: 1 }, kb: { cat: 'data', k: 1e3 }, mb: { cat: 'data', k: 1e6 }, gb: { cat: 'data', k: 1e9 }, tb: { cat: 'data', k: 1e12 },
  kib: { cat: 'data', k: 1024 }, mib: { cat: 'data', k: 1048576 }, gib: { cat: 'data', k: 1073741824 }, tib: { cat: 'data', k: 1099511627776 },
};

function convertUnits(val, fromRaw, toRaw) {
  const f = String(fromRaw || '').trim().toLowerCase();
  const t = String(toRaw || '').trim().toLowerCase();
  if (!isFinite(val)) return '单位换算失败: 数值非法';
  // 温度换算（C / F / K）
  const normTemp = (u) => ({ c: 'c', '°c': 'c', celsius: 'c', '摄氏度': 'c', f: 'f', '°f': 'f', fahrenheit: 'f', '华氏度': 'f', k: 'k', kelvin: 'k', '开尔文': 'k' }[u] || '');
  const tf = normTemp(f), tt = normTemp(t);
  if (tf && tt) {
    let cVal = tf === 'c' ? val : (tf === 'f' ? (val - 32) * 5 / 9 : val - 273.15);
    let outVal = tt === 'c' ? cVal : (tt === 'f' ? cVal * 9 / 5 + 32 : cVal + 273.15);
    return `单位换算结果：${val} ${fromRaw} = ${Number(outVal.toFixed(4))} ${toRaw}`;
  }
  // 油耗换算（MPG <-> L/100km）
  const isMpg = (u) => u === 'mpg';
  const isL100 = (u) => u === 'l/100km' || u === 'l100km';
  if ((isMpg(f) && isL100(t)) || (isL100(f) && isMpg(t))) {
    if (val <= 0) return '单位换算失败: 油耗数值必须大于 0';
    const outVal = 235.214583 / val;
    return `油耗换算结果：${val} ${fromRaw} = ${Number(outVal.toFixed(3))} ${toRaw}`;
  }
  const uf = UNIT_TABLE[f], ut = UNIT_TABLE[t];
  if (!uf || !ut) return `单位换算失败: 不支持的单位（${fromRaw} → ${toRaw}）`;
  if (uf.cat !== ut.cat) return `单位换算失败: 不同量纲无法直接换算（${fromRaw} 与 ${toRaw}）`;
  const res = (val * uf.k) / ut.k;
  const formatted = Math.abs(res) >= 1e-4 && Math.abs(res) < 1e12 ? Number(res.toFixed(6)) : res;
  return `单位换算结果：${val} ${fromRaw} = ${formatted} ${toRaw}`;
}

async function toolToolkit(args) {
  args = args || {};
  const action = String(args.action || '').trim().toLowerCase();
  const input = String(args.input !== undefined ? args.input : '');
  try {
    switch (action) {
      case 'unit_convert':
        return convertUnits(parseFloat(args.value !== undefined ? args.value : input), args.from_unit, args.to_unit);
      case 'hash': {
        const algoRaw = String(args.algorithm || 'SHA-256').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const algoMap = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA384: 'SHA-384', SHA512: 'SHA-512' };
        const algo = algoMap[algoRaw] || 'SHA-256';
        const data = new TextEncoder().encode(input);
        const buf = await crypto.subtle.digest(algo, data);
        const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
        return `${algo} 摘要结果：${hex}`;
      }
      case 'base64_encode': {
        const bytes = new TextEncoder().encode(input);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return 'Base64 编码结果：' + btoa(bin);
      }
      case 'base64_decode': {
        const bin = atob(input.trim());
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return 'Base64 解码结果：' + new TextDecoder('utf-8').decode(bytes);
      }
      case 'url_encode':
        return 'URL 编码结果：' + encodeURIComponent(input);
      case 'url_decode':
        return 'URL 解码结果：' + decodeURIComponent(input);
      case 'uuid': {
        const count = Math.min(Math.max(parseInt(args.value, 10) || 1, 1), 10);
        const list = [];
        for (let i = 0; i < count; i++) list.push(crypto.randomUUID());
        return '生成的 UUID v4：\n' + list.join('\n');
      }
      case 'text_stats': {
        const chars = Array.from(input).length;
        const noSpace = Array.from(input.replace(/\s+/g, '')).length;
        const cjk = (input.match(/[\u4e00-\u9fff]/g) || []).length;
        const enWords = (input.replace(/[\u4e00-\u9fff]/g, ' ').trim().match(/[a-zA-Z0-9_-]+/g) || []).length;
        const lines = input ? input.split(/\r?\n/).length : 0;
        const utf8Bytes = new TextEncoder().encode(input).byteLength;
        const estTokens = Math.ceil(cjk * 1.3 + enWords * 1.3 + (chars - cjk - enWords) * 0.4);
        return `【文本精确统计】\n总字符数（含空白）：${chars} | 不含空白：${noSpace}\n中文字数：${cjk} | 英文/数字词数：${enWords}\n行数：${lines} | UTF-8 字节数：${utf8Bytes} Bytes\n预估 Token 数：约 ${estTokens} tokens`;
      }
      default:
        return '工具执行失败: 未知的 toolkit action（支持 unit_convert / hash / base64_encode / base64_decode / url_encode / url_decode / uuid / text_stats）';
    }
  } catch (e) {
    return '工具执行失败: ' + e.message;
  }
}

export {
  toolCalculate,
  toolGetTime,
  toolGetWeather,
  toolExchangeRate,
  toolWikiLookup,
  toolGithubLookup,
  toolArxivSearch,
  toolHnTop,
  toolNetLookup,
  toolToolkit,
};
