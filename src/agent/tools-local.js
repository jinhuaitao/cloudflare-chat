// Agent 工具：安全计算器、时间、天气（_worker.js 原第 623-701 行）

// 安全计算器：递归下降解析，绝不使用 eval
function toolCalculate(expr) {
  try {
    const s = String(expr || '').replace(/\s+/g, '').replace(/×/g, '*').replace(/÷/g, '/');
    if (!s) return '表达式为空';
    if (s.length > 500) return '表达式过长（上限 500 字符）';
    if (/[^0-9+\-*/%^().]/.test(s)) return '表达式含非法字符';
    let i = 0;
    // v6.9.4：递归深度上限。括号可以合法嵌套，但没有上限时超深表达式会打满调用栈，
    // 把整个 Agent 步打成未捕获异常，而不是一条可读的计算失败。
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
      // v6.8.1：校验数字格式，防止 "5..3" 被 parseFloat 静默截断成 5
      const numStr = s.slice(i, j);
      if (!/^(\d+\.?\d*|\.\d+)$/.test(numStr)) throw new Error('数字格式非法: ' + numStr);
      const n = parseFloat(numStr); i = j;
      if (!isFinite(n)) throw new Error('数字非法');
      return n;
    }
    const v = parseExpr();
    if (i !== s.length) throw new Error('表达式未完全解析');
    if (!isFinite(v)) return '计算结果非法（可能除零或结果溢出）';
    // v6.8.6：只对常规量级做 1e10 舍入。旧版无差别舍入会把 1e-12 舍成 0、
    // 把 1e308 级结果乘 1e10 后溢出成 Infinity 显示出来
    const av = Math.abs(v);
    const out = (av >= 1e-6 && av < 1e15) ? Math.round(v * 1e10) / 1e10 : v;
    return '计算结果：' + String(out);
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

// v6.8.6：外部 JSON 请求统一带独立超时。之前天气两次 fetch 都是裸调用，
// 只能靠工具层 30 秒 race 兜底，而 race 并不会真正取消挂住的连接
async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function toolGetWeather(city) {
  city = String(city || '').trim();
  if (!city) return '城市名为空';
  try {
    const g = await fetchJson('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(city) + '&count=1&language=zh&format=json');
    if (!g.results || !g.results.length) return '找不到城市：' + city;
    const loc = g.results[0];
    const w = await fetchJson('https://api.open-meteo.com/v1/forecast?latitude=' + loc.latitude + '&longitude=' + loc.longitude +
      '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m' +
      '&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&forecast_days=2');
    const wm = { 0: '晴', 1: '大致晴', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇', 51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨', 71: '小雪', 73: '中雪', 75: '大雪', 80: '阵雨', 81: '阵雨', 82: '暴雨', 95: '雷阵雨' };
    const c = w.current, d = w.daily;
    let t = loc.name + '（' + (loc.country || '') + '）当前：' + (wm[c.weather_code] || '未知') +
      '，' + c.temperature_2m + '°C，体感' + c.apparent_temperature + '°C，湿度' + c.relative_humidity_2m + '%，风速' + c.wind_speed_10m + 'km/h\n';
    t += '今明两天：' + d.time.map((dt, i) => dt.slice(5) + ' ' + (wm[d.weather_code[i]] || '') + ' ' + d.temperature_2m_min[i] + '~' + d.temperature_2m_max[i] + '°C').join('；');
    return t;
  } catch (e) { return '天气查询失败: ' + e.message; }
}

export {
  toolCalculate,
  toolGetTime,
  toolGetWeather,
};
