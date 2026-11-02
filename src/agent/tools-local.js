// Agent 工具：科学计算器（支持多表达式批量计算）、时间与日期推算、天气（内置高频城市零延迟坐标表 + 多城市并发查询）、
// 实时汇率/加密币价（支持多币种批量换算）、维基百科、GitHub 检索、arXiv 论文检索、HackerNews 热榜、DNS/IP 诊断、开发者全能工具箱

import { mapSetBounded, mapGetBounded } from '../utils.js';
import { isBlockedFetchHost } from '../net/ssrf.js';

// 外部免密钥 API 结果 L1 缓存（TTL 3 分钟，最多 150 条），加速同轮/跨轮重复查询
const localApiCache = new Map();
const localApiExp = new Map();
const LOCAL_API_TTL_MS = 3 * 60 * 1000;

// 城市地理编码长效缓存（TTL 24 小时）+ 内置高频城市零延迟坐标表（省去 50% 的 Geocoding HTTP 往返）
const geoCoordCache = new Map();
const PRESET_CITY_COORDS = {
  '北京': { name: '北京', country: '中国', latitude: 39.9042, longitude: 116.4074 },
  'beijing': { name: '北京', country: '中国', latitude: 39.9042, longitude: 116.4074 },
  '上海': { name: '上海', country: '中国', latitude: 31.2304, longitude: 121.4737 },
  'shanghai': { name: '上海', country: '中国', latitude: 31.2304, longitude: 121.4737 },
  '广州': { name: '广州', country: '中国', latitude: 23.1291, longitude: 113.2644 },
  'guangzhou': { name: '广州', country: '中国', latitude: 23.1291, longitude: 113.2644 },
  '深圳': { name: '深圳', country: '中国', latitude: 22.5431, longitude: 114.0579 },
  'shenzhen': { name: '深圳', country: '中国', latitude: 22.5431, longitude: 114.0579 },
  '杭州': { name: '杭州', country: '中国', latitude: 30.2741, longitude: 120.1551 },
  'hangzhou': { name: '杭州', country: '中国', latitude: 30.2741, longitude: 120.1551 },
  '成都': { name: '成都', country: '中国', latitude: 30.5728, longitude: 104.0668 },
  'chengdu': { name: '成都', country: '中国', latitude: 30.5728, longitude: 104.0668 },
  '武汉': { name: '武汉', country: '中国', latitude: 30.5928, longitude: 114.3055 },
  '西安': { name: '西安', country: '中国', latitude: 34.3416, longitude: 108.9398 },
  '南京': { name: '南京', country: '中国', latitude: 32.0603, longitude: 118.7969 },
  '重庆': { name: '重庆', country: '中国', latitude: 29.5630, longitude: 106.5516 },
  '天津': { name: '天津', country: '中国', latitude: 39.0842, longitude: 117.2010 },
  '苏州': { name: '苏州', country: '中国', latitude: 31.2990, longitude: 120.5853 },
  '香港': { name: '香港', country: '中国', latitude: 22.3193, longitude: 114.1694 },
  'hongkong': { name: '香港', country: '中国', latitude: 22.3193, longitude: 114.1694 },
  '台北': { name: '台北', country: '中国', latitude: 25.0330, longitude: 121.5654 },
  'taipei': { name: '台北', country: '中国', latitude: 25.0330, longitude: 121.5654 },
  '东京': { name: '东京', country: '日本', latitude: 35.6762, longitude: 139.6503 },
  'tokyo': { name: 'Tokyo', country: 'Japan', latitude: 35.6762, longitude: 139.6503 },
  '大阪': { name: '大阪', country: '日本', latitude: 34.6937, longitude: 135.5023 },
  'osaka': { name: 'Osaka', country: 'Japan', latitude: 34.6937, longitude: 135.5023 },
  '首尔': { name: '首尔', country: '韩国', latitude: 37.5665, longitude: 126.9780 },
  'seoul': { name: 'Seoul', country: 'South Korea', latitude: 37.5665, longitude: 126.9780 },
  '新加坡': { name: '新加坡', country: '新加坡', latitude: 1.3521, longitude: 103.8198 },
  'singapore': { name: 'Singapore', country: 'Singapore', latitude: 1.3521, longitude: 103.8198 },
  '纽约': { name: '纽约', country: '美国', latitude: 40.7128, longitude: -74.0060 },
  'newyork': { name: 'New York', country: 'USA', latitude: 40.7128, longitude: -74.0060 },
  '伦敦': { name: '伦敦', country: '英国', latitude: 51.5074, longitude: -0.1278 },
  'london': { name: 'London', country: 'UK', latitude: 51.5074, longitude: -0.1278 },
  '旧金山': { name: '旧金山', country: '美国', latitude: 37.7749, longitude: -122.4194 },
  '巴黎': { name: '巴黎', country: '法国', latitude: 48.8566, longitude: 2.3522 },
  '悉尼': { name: '悉尼', country: '澳大利亚', latitude: -33.8688, longitude: 151.2093 },
};

function getCachedApi(key) {
  return mapGetBounded(localApiCache, key, localApiExp);
}
function setCachedApi(key, val, ttlMs) {
  mapSetBounded(localApiCache, key, val, 150, localApiExp, ttlMs || LOCAL_API_TTL_MS);
}

// 单条数学表达式求值辅助
function evalSingleExpr(rawExpr) {
  const s = String(rawExpr || '')
    .replace(/\s+/g, '')
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/，/g, ',')
    .replace(/π/g, 'pi');
  if (!s) throw new Error('表达式为空');
  if (s.length > 500) throw new Error('表达式过长（上限 500 字符）');
  if (/[^0-9a-zA-Z_+\-*/%^(),.]/.test(s)) throw new Error('表达式含非法字符');

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
  const CONSTS = { pi: Math.PI, e: Math.E };

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
        i++;
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
  if (!isFinite(v)) throw new Error('计算结果非法（可能除零或结果溢出）');
  const av = Math.abs(v);
  return (av >= 1e-6 && av < 1e15) ? Math.round(v * 1e10) / 1e10 : v;
}

// 安全科学计算器：支持单表达式及用分号 ; 分隔的多表达式批量计算
function toolCalculate(expr) {
  try {
    const raw = String(expr || '').trim();
    if (!raw) return '表达式为空';
    const parts = raw.split(/[;；\r\n]+/).map(x => x.trim()).filter(Boolean);
    if (!parts.length) return '表达式为空';
    if (parts.length === 1) {
      return '计算结果：' + String(evalSingleExpr(parts[0]));
    }
    const results = parts.slice(0, 10).map(p => {
      try { return `${p} = ${evalSingleExpr(p)}`; }
      catch (e) { return `${p} → 计算失败 (${e.message})`; }
    });
    return '批量计算结果：\n' + results.join('\n');
  } catch (e) {
    if (/非法字符|为空|过长/.test(e.message)) return e.message;
    if (/计算结果非法/.test(e.message)) return e.message;
    return '计算失败: ' + e.message;
  }
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

// 增强版时间与日期推算：支持当前时间、两日期间隔天数（target_date）、日期加减天数（add_days）与 Unix 时间戳
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

// ==================== 天气卡片（v7.9.1 固定排版） ====================
// 目标：天气类回答有统一、好看的固定版式，三个端（Web / Telegram / 微信）都能正常显示。
// 因此只用「纯文本 + emoji + 分隔线」，不用 Markdown 表格与 `**`（微信端会原样显示符号），
// 也不用空格对齐（各端字体宽度不同，对不齐反而更乱）。
const WMO_META = {
  0: { day: '☀️', night: '🌙', text: '晴' },
  1: { day: '🌤️', night: '🌙', text: '大致晴' },
  2: { day: '⛅', night: '☁️', text: '多云' },
  3: { day: '☁️', night: '☁️', text: '阴' },
  45: { day: '🌫️', night: '🌫️', text: '雾' },
  48: { day: '🌫️', night: '🌫️', text: '雾凇' },
  51: { day: '🌦️', night: '🌦️', text: '毛毛雨' },
  53: { day: '🌦️', night: '🌦️', text: '毛毛雨' },
  55: { day: '🌧️', night: '🌧️', text: '小雨' },
  56: { day: '🌧️', night: '🌧️', text: '冻毛毛雨' },
  57: { day: '🌧️', night: '🌧️', text: '强冻毛毛雨' },
  61: { day: '🌦️', night: '🌦️', text: '小雨' },
  63: { day: '🌧️', night: '🌧️', text: '中雨' },
  65: { day: '🌧️', night: '🌧️', text: '大雨' },
  66: { day: '🌧️', night: '🌧️', text: '冻雨' },
  67: { day: '🌧️', night: '🌧️', text: '强冻雨' },
  71: { day: '🌨️', night: '🌨️', text: '小雪' },
  73: { day: '🌨️', night: '🌨️', text: '中雪' },
  75: { day: '❄️', night: '❄️', text: '大雪' },
  77: { day: '🌨️', night: '🌨️', text: '雪粒' },
  80: { day: '🌦️', night: '🌦️', text: '小阵雨' },
  81: { day: '🌧️', night: '🌧️', text: '阵雨' },
  82: { day: '⛈️', night: '⛈️', text: '强阵雨' },
  85: { day: '🌨️', night: '🌨️', text: '小阵雪' },
  86: { day: '🌨️', night: '🌨️', text: '大阵雪' },
  95: { day: '⛈️', night: '⛈️', text: '雷阵雨' },
  96: { day: '⛈️', night: '⛈️', text: '雷阵雨伴冰雹' },
  99: { day: '⛈️', night: '⛈️', text: '强雷暴伴冰雹' },
};

const WIND_DIR_NAMES = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEATHER_RULE = '━━━━━━━━━━━━━━';
// 降雪类天气码：降水图标与出行提示要换成雪的口径（「带伞」在雪天不通）
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);

function isSnowCode(code) {
  return SNOW_CODES.has(code);
}

function weatherIcon(code, isDay) {
  const m = WMO_META[code];
  if (!m) return '🌡️';
  return isDay === 0 ? m.night : m.day;
}

function weatherText(code) {
  const m = WMO_META[code];
  return m ? m.text : '未知天气';
}

function windDirName(deg) {
  if (typeof deg !== 'number' || !isFinite(deg)) return '';
  const idx = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return WIND_DIR_NAMES[idx] + '风';
}

// 日期标签：今天 / 明天 / 后天 + MM/DD + 星期
function dayLabel(dateStr, idx) {
  const s = String(dateStr || '');
  const prefix = idx === 0 ? '今天' : (idx === 1 ? '明天' : (idx === 2 ? '后天' : ''));
  let md = s.slice(5).replace('-', '/');
  let wd = '';
  const t = Date.parse(s + 'T00:00:00Z');
  if (isFinite(t)) wd = WEEKDAY_NAMES[new Date(t).getUTCDay()] || '';
  return [prefix, md, wd].filter(Boolean).join(' ');
}

// 依据当前与当日预报生成 1~2 条生活提示，避免空泛
function weatherTips(cur, daily) {
  const tips = [];
  const hi = daily.temperature_2m_max ? daily.temperature_2m_max[0] : undefined;
  const lo = daily.temperature_2m_min ? daily.temperature_2m_min[0] : undefined;
  const pop = daily.precipitation_probability_max ? daily.precipitation_probability_max[0] : undefined;
  const uv = daily.uv_index_max ? daily.uv_index_max[0] : undefined;
  const now = cur.temperature_2m;
  const snow = isSnowCode(cur.weather_code) ||
    isSnowCode(daily.weather_code ? daily.weather_code[0] : undefined);

  if (typeof pop === 'number' && pop >= 50) {
    tips.push('降水概率 ' + Math.round(pop) + '%，' + (snow ? '出门注意保暖防滑' : '出门记得带伞'));
  }
  if (typeof hi === 'number' && typeof lo === 'number' && hi - lo >= 8) {
    tips.push('昼夜温差 ' + Math.round(hi - lo) + '°，早晚添件外套');
  }
  if (typeof uv === 'number' && uv >= 6) tips.push('紫外线较强（UV ' + Math.round(uv) + '），注意防晒');
  if (typeof now === 'number') {
    if (now >= 32) tips.push('高温天气，注意补水防暑');
    else if (now <= 0) tips.push('气温偏低，注意保暖防滑');
  }
  if (!tips.length) tips.push('天气平稳，出行无碍');
  return tips.slice(0, 2);
}

// 生成固定版式的天气卡片
function buildWeatherCard(loc, w) {
  const c = (w && w.current) || {};
  const d = (w && w.daily) || {};
  const isDay = typeof c.is_day === 'number' ? c.is_day : 1;
  const place = String(loc.name || '') + (loc.country ? ' · ' + loc.country : '');
  const lines = [];

  lines.push(weatherIcon(c.weather_code, isDay) + ' ' + place);
  const upd = String(c.time || '').replace('T', ' ').slice(0, 16);
  if (upd) lines.push('🕐 ' + upd + ' 更新');
  lines.push(WEATHER_RULE);

  // 当前实况：三个字段都缺时整行省略，避免出现「现在 未知天气」这种怪句子
  const nowBits = [];
  if (typeof c.temperature_2m === 'number') nowBits.push(Math.round(c.temperature_2m) + '°C');
  if (c.weather_code !== undefined && c.weather_code !== null) nowBits.push(weatherText(c.weather_code));
  if (typeof c.apparent_temperature === 'number') nowBits.push('体感 ' + Math.round(c.apparent_temperature) + '°C');
  if (nowBits.length) lines.push('🌡️ 现在 ' + nowBits.join('　'));

  const detail = [];
  if (typeof c.relative_humidity_2m === 'number') detail.push('💧 湿度 ' + Math.round(c.relative_humidity_2m) + '%');
  if (typeof c.wind_speed_10m === 'number') {
    const wd = windDirName(c.wind_direction_10m);
    detail.push('🌬️ ' + (wd ? wd + ' ' : '风速 ') + Math.round(c.wind_speed_10m) + ' km/h');
  }
  if (typeof c.precipitation === 'number' && c.precipitation > 0) {
    detail.push((isSnowCode(c.weather_code) ? '❄️ 降水 ' : '🌧️ 降水 ') + c.precipitation + ' mm');
  }
  if (detail.length) lines.push(detail.join('　'));

  // 紫外线 + 日出日落：合在一行，信息密度高又不挤
  const astro = [];
  const uvToday = d.uv_index_max ? d.uv_index_max[0] : undefined;
  if (typeof uvToday === 'number') {
    const lvl = uvToday < 3 ? '弱' : (uvToday < 6 ? '中等' : (uvToday < 8 ? '强' : (uvToday < 11 ? '很强' : '极强')));
    astro.push('☀️ 紫外线 ' + Math.round(uvToday) + '（' + lvl + '）');
  }
  if (Array.isArray(d.sunrise) && d.sunrise[0]) astro.push('🌅 日出 ' + String(d.sunrise[0]).slice(11, 16));
  if (Array.isArray(d.sunset) && d.sunset[0]) astro.push('🌇 日落 ' + String(d.sunset[0]).slice(11, 16));
  if (astro.length) lines.push(astro.join('　'));

  // 未来三天
  if (Array.isArray(d.time) && d.time.length) {
    lines.push('');
    lines.push('📅 未来三天');
    d.time.slice(0, 3).forEach((dt, i) => {
      const code = d.weather_code ? d.weather_code[i] : undefined;
      const lo = d.temperature_2m_min ? d.temperature_2m_min[i] : undefined;
      const hi = d.temperature_2m_max ? d.temperature_2m_max[i] : undefined;
      const pop = d.precipitation_probability_max ? d.precipitation_probability_max[i] : undefined;
      let row = weatherIcon(code, 1) + ' ' + dayLabel(dt, i) + '　' + weatherText(code);
      if (typeof lo === 'number' && typeof hi === 'number') {
        row += '　' + Math.round(lo) + '° ~ ' + Math.round(hi) + '°';
      }
      if (typeof pop === 'number') row += '　降水 ' + Math.round(pop) + '%';
      lines.push(row);
    });
  }

  const tips = weatherTips(c, d);
  if (tips.length) {
    lines.push('');
    lines.push('💡 ' + tips.join('；'));
  }
  return lines.join('\n');
}

async function querySingleCityWeather(city) {
  city = String(city || '').trim();
  if (!city) return '城市名为空';
  const cacheKey = 'weather:' + city.toLowerCase();
  const cached = getCachedApi(cacheKey);
  if (cached) return cached;
  try {
    const normKey = city.toLowerCase().replace(/\s+/g, '');
    let loc = PRESET_CITY_COORDS[city] || PRESET_CITY_COORDS[normKey] || geoCoordCache.get(normKey);
    if (!loc) {
      const g = await fetchJson('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(city) + '&count=1&language=zh&format=json');
      if (!g.results || !g.results.length) return '找不到城市：' + city;
      loc = g.results[0];
      mapSetBounded(geoCoordCache, normKey, loc, 300);
    }
    const w = await fetchJson('https://api.open-meteo.com/v1/forecast?latitude=' + loc.latitude + '&longitude=' + loc.longitude +
      '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,is_day,precipitation' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max,uv_index_max' +
      '&timezone=auto&forecast_days=3');
    const t = buildWeatherCard(loc, w);
    setCachedApi(cacheKey, t, 5 * 60 * 1000);
    return t;
  } catch (e) { return '天气查询失败: ' + e.message; }
}

// 支持单城市或逗号分隔的多城市并发查询（如 "北京, 上海, 东京"）
async function toolGetWeather(city) {
  const raw = String(city || '').trim();
  if (!raw) return '城市名为空';
  const cities = raw.split(/[,，、;；]+/).map(s => s.trim()).filter(Boolean);
  if (cities.length <= 1) return await querySingleCityWeather(cities[0] || raw);
  const resList = await Promise.all(cities.slice(0, 5).map(c => querySingleCityWeather(c)));
  return resList.join('\n\n');
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

async function querySingleExchangeRate(fromCode, toCode, amount) {
  const from = normCurrencyCode(fromCode || 'USD');
  const to = normCurrencyCode(toCode || 'CNY');
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
        { 'Accept': 'application/json', 'User-Agent': 'Cloudflare-Chat/7.2' }
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

// 支持单币种或逗号分隔多币种并发查询（如 from="USD, JPY, BTC", to="CNY"）
async function toolExchangeRate(args) {
  args = args || {};
  const rawFrom = String(args.from || 'USD').trim();
  const to = args.to || 'CNY';
  const amount = isFinite(parseFloat(args.amount)) && parseFloat(args.amount) > 0 ? parseFloat(args.amount) : 1;
  const fromList = rawFrom.split(/[,，、;；]+/).map(s => s.trim()).filter(Boolean);
  if (fromList.length <= 1) return await querySingleExchangeRate(fromList[0] || rawFrom, to, amount);
  const resList = await Promise.all(fromList.slice(0, 6).map(f => querySingleExchangeRate(f, to, amount)));
  return resList.join('\n\n');
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
    'User-Agent': 'Cloudflare-Chat/7.2 (https://workers.cloudflare.com)',
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

// ==================== 新增免密钥工具 1：GitHub 开源仓库与 Release 检索 ====================
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
    'User-Agent': 'Cloudflare-Chat/7.2'
  };
  try {
    if (isRepoSlug) {
      const [repo, rel, readme] = await Promise.all([
        fetchJson(`https://api.github.com/repos/${query}`, 10000, headers),
        fetchJson(`https://api.github.com/repos/${query}/releases/latest`, 6000, headers).catch(() => null),
        fetchJson(`https://api.github.com/repos/${query}/readme`, 6000, headers).catch(() => null)
      ]);
      let out = `【GitHub 仓库：${repo.full_name}】\n`
        + `链接：${repo.html_url}\n`
        + `简介：${repo.description || '无'}\n`
        + `数据：⭐ ${repo.stargazers_count} Stars | 🍴 ${repo.forks_count} Forks | 🐛 ${repo.open_issues_count} Open Issues\n`
        + `语言：${repo.language || '未知'} | 协议：${(repo.license && repo.license.spdx_id) || '未声明'} | 最近推送：${(repo.pushed_at || '').slice(0, 10)}`;
      if (Array.isArray(repo.topics) && repo.topics.length) {
        out += `\n标签：${repo.topics.slice(0, 10).join(', ')}`;
      }
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

// ==================== 新增免密钥工具 2：arXiv 学术论文检索 ====================
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
    const xml = await fetchText(url, 12000, { 'User-Agent': 'Cloudflare-Chat/7.2' });
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

// ==================== 新增免密钥工具 3：Hacker News 科技热榜与实时讨论检索 ====================
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
    const data = await fetchJson(apiUrl, 10000, { 'User-Agent': 'Cloudflare-Chat/7.2' });
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

// ==================== 新增免密钥工具 4：DNS 权威解析 (DoH) 与 IP 归属地/ASN 诊断 ====================
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
      const info = await fetchJson(`https://ipwho.is/${encodeURIComponent(target)}`, 10000, { 'User-Agent': 'Cloudflare-Chat/7.2' });
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

// ==================== 新增免密钥工具 5：全能确定性工具箱（单位换算 / 哈希摘要 / 编解码 / 文本统计 / UUID / JSON / 正则） ====================
const UNIT_TABLE = {
  mm: { cat: 'len', k: 0.001 }, cm: { cat: 'len', k: 0.01 }, m: { cat: 'len', k: 1 }, km: { cat: 'len', k: 1000 },
  in: { cat: 'len', k: 0.0254 }, inch: { cat: 'len', k: 0.0254 }, ft: { cat: 'len', k: 0.3048 }, foot: { cat: 'len', k: 0.3048 },
  yd: { cat: 'len', k: 0.9144 }, mi: { cat: 'len', k: 1609.344 }, mile: { cat: 'len', k: 1609.344 }, nmi: { cat: 'len', k: 1852 },
  mg: { cat: 'wt', k: 0.001 }, g: { cat: 'wt', k: 1 }, kg: { cat: 'wt', k: 1000 }, t: { cat: 'wt', k: 1e6 },
  oz: { cat: 'wt', k: 28.349523125 }, lb: { cat: 'wt', k: 453.59237 }, jin: { cat: 'wt', k: 500 }, '斤': { cat: 'wt', k: 500 }, '两': { cat: 'wt', k: 50 },
  cm2: { cat: 'area', k: 0.0001 }, m2: { cat: 'area', k: 1 }, sqm: { cat: 'area', k: 1 }, km2: { cat: 'area', k: 1e6 },
  ha: { cat: 'area', k: 10000 }, acre: { cat: 'area', k: 4046.8564224 }, sqft: { cat: 'area', k: 0.09290304 },
  mu: { cat: 'area', k: 666.6666667 }, '亩': { cat: 'area', k: 666.6666667 }, '坪': { cat: 'area', k: 3.305785 },
  ml: { cat: 'vol', k: 0.001 }, l: { cat: 'vol', k: 1 }, m3: { cat: 'vol', k: 1000 },
  gal: { cat: 'vol', k: 3.785411784 }, floz: { cat: 'vol', k: 0.0295735296 }, cup: { cat: 'vol', k: 0.2365882365 },
  'm/s': { cat: 'spd', k: 1 }, 'km/h': { cat: 'spd', k: 1 / 3.6 }, kph: { cat: 'spd', k: 1 / 3.6 },
  mph: { cat: 'spd', k: 0.44704 }, kn: { cat: 'spd', k: 1852 / 3600 }, knot: { cat: 'spd', k: 1852 / 3600 },
  b: { cat: 'data', k: 1 }, kb: { cat: 'data', k: 1e3 }, mb: { cat: 'data', k: 1e6 }, gb: { cat: 'data', k: 1e9 }, tb: { cat: 'data', k: 1e12 },
  kib: { cat: 'data', k: 1024 }, mib: { cat: 'data', k: 1048576 }, gib: { cat: 'data', k: 1073741824 }, tib: { cat: 'data', k: 1099511627776 },
};

function convertUnits(val, fromRaw, toRaw) {
  const f = String(fromRaw || '').trim().toLowerCase();
  const t = String(toRaw || '').trim().toLowerCase();
  if (!isFinite(val)) return '单位换算失败: 数值非法';
  const normTemp = (u) => ({ c: 'c', '°c': 'c', celsius: 'c', '摄氏度': 'c', f: 'f', '°f': 'f', fahrenheit: 'f', '华氏度': 'f', k: 'k', kelvin: 'k', '开尔文': 'k' }[u] || '');
  const tf = normTemp(f), tt = normTemp(t);
  if (tf && tt) {
    let cVal = tf === 'c' ? val : (tf === 'f' ? (val - 32) * 5 / 9 : val - 273.15);
    let outVal = tt === 'c' ? cVal : (tt === 'f' ? cVal * 9 / 5 + 32 : cVal + 273.15);
    return `单位换算结果：${val} ${fromRaw} = ${Number(outVal.toFixed(4))} ${toRaw}`;
  }
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

// JSON 路径取值：支持 a.b[0].c / a.b.0.c 两种写法
function jsonQueryPath(root, path) {
  const raw = String(path || '').trim();
  if (!raw || raw === '.' || raw === '$') return root;
  const segs = raw
    .replace(/^\$\.?/, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map(s => s.trim())
    .filter(Boolean);
  let cur = root;
  const walked = [];
  for (const seg of segs) {
    walked.push(seg);
    if (cur === null || cur === undefined) {
      return { error: '路径 ' + walked.join('.') + ' 处已无值（' + seg + ' 之前为 ' + String(cur) + '）' };
    }
    if (Array.isArray(cur)) {
      const idx = parseInt(seg, 10);
      if (!(idx >= 0) || idx >= cur.length) return { error: '数组下标越界：' + walked.join('.') };
      cur = cur[idx];
    } else if (typeof cur === 'object') {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) {
        return { error: '键不存在：' + walked.join('.') + '（当前可用键：' + Object.keys(cur).slice(0, 20).join(', ') + '）' };
      }
      cur = cur[seg];
    } else {
      return { error: '无法继续下钻：' + walked.join('.') + '（' + seg + ' 的父级是 ' + typeof cur + '）' };
    }
  }
  return { value: cur };
}

function safeJsonStringify(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch (e) {
    return String(v);
  }
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
      // v7.5.0 新增：JSON 格式化与校验（开发排查高频需求，纯确定性、零网络）
      case 'json_format': {
        if (!input.trim()) return '内容为空';
        let parsed;
        try { parsed = JSON.parse(input); }
        catch (e) { return 'JSON 解析失败: ' + e.message; }
        const pretty = safeJsonStringify(parsed);
        const kind = Array.isArray(parsed) ? '数组（' + parsed.length + ' 项）' : (parsed && typeof parsed === 'object' ? '对象（' + Object.keys(parsed).length + ' 个键）' : typeof parsed);
        const body = pretty.length > 6000 ? pretty.slice(0, 6000) + '\n…（格式化结果过长，已截断）' : pretty;
        return 'JSON 合法（' + kind + '），格式化结果：\n```json\n' + body + '\n```';
      }
      case 'json_query': {
        if (!input.trim()) return '内容为空';
        let parsed;
        try { parsed = JSON.parse(input); }
        catch (e) { return 'JSON 解析失败: ' + e.message; }
        const path = String(args.path || '').trim();
        if (!path) return '请提供 path（如 data.items[0].name）';
        const r = jsonQueryPath(parsed, path);
        if (r.error) return 'JSON 取值失败: ' + r.error;
        const v = r.value;
        if (v === null) return '路径 ' + path + ' 的值为 null';
        if (typeof v === 'object') {
          const s = safeJsonStringify(v);
          return '路径 ' + path + ' 的值：\n```json\n' + (s.length > 6000 ? s.slice(0, 6000) + '\n…（已截断）' : s) + '\n```';
        }
        return '路径 ' + path + ' 的值：' + String(v) + '（类型：' + typeof v + '）';
      }
      case 'regex_test': {
        const pattern = String(args.pattern || '').trim();
        if (!pattern) return '请提供 pattern（正则表达式）';
        if (pattern.length > 500) return '正则过长（上限 500 字符）';
        const flags = String(args.flags || '').replace(/[^gimsuy]/g, '');
        let re;
        try { re = new RegExp(pattern, flags); }
        catch (e) { return '正则编译失败: ' + e.message; }
        const src = input;
        const matches = [];
        if (flags.indexOf('g') !== -1) {
          let m;
          let guard = 0;
          while ((m = re.exec(src)) && guard < 50) {
            matches.push(m);
            if (m[0] === '') re.lastIndex++;
            guard++;
          }
        } else {
          const m = re.exec(src);
          if (m) matches.push(m);
        }
        if (!matches.length) return '未匹配到任何内容（正则：/' + pattern + '/' + flags + '）';
        const lines = matches.slice(0, 20).map((m, i) => {
          let line = (i + 1) + '. 命中「' + String(m[0]).slice(0, 200) + '」@' + m.index;
          const groups = m.slice(1);
          if (groups.length) {
            line += '\n   分组：' + groups.map((g, gi) => '#' + (gi + 1) + '=' + (g === undefined ? '(未参与)' : String(g).slice(0, 80))).join(' | ');
          }
          return line;
        });
        return '匹配到 ' + matches.length + ' 处（正则：/' + pattern + '/' + flags + '）：\n' + lines.join('\n');
      }
      default:
        return '工具执行失败: 未知的 toolkit action（支持 unit_convert / hash / base64_encode / base64_decode / url_encode / url_decode / uuid / text_stats / json_format / json_query / regex_test）';
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
  jsonQueryPath,
  convertUnits,
  buildWeatherCard,
  weatherIcon,
  weatherText,
  windDirName,
  dayLabel,
  weatherTips,
  isSnowCode,
};
