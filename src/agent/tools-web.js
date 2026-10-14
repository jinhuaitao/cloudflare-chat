// Agent 工具：DuckDuckGo 搜索与网页正文抓取（_worker.js 原第 487-530,589-621 行）

import { isBlockedFetchHost } from '../net/ssrf.js';

// DuckDuckGo HTML 结果解析（抽出以便测试）
// v6.8.6：按 result 块解析，标题与摘要取自同一块。旧版把「全局第 i 个 snippet」
// 配给「第 i 个结果」，只要某条结果缺 snippet（或页面结构稍有出入），
// 后面所有结果的摘要就整体错位一位。
function parseDuckDuckGo(html, count) {
  const out = [];
  const clean = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const blockRe = /<div[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*\bresult\b[^"]*"|<\/body>|$)/g;
  let bm;
  while ((bm = blockRe.exec(html)) && out.length < count) {
    const body = bm[1];
    const am = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(body);
    if (!am) continue;
    let href = am[1];
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) { try { href = decodeURIComponent(uddg[1]); } catch (e) {} }
    const title = clean(am[2]);
    const sm = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(body);
    const snip = sm ? clean(sm[1]).slice(0, 200) : '';
    if (title && href && href.startsWith('http')) out.push({ title, url: href, snip });
  }
  return out;
}

// v6.8.6：流式读取并设预算，到量即停 —— 不把超大响应体整段读进 isolate 内存
// （128MB 上限下大页面可能直接 OOM）
async function readBodyBudget(res, maxChars) {
  let out = '';
  try {
    const reader = res.body.getReader();
    const dec = new TextDecoder('utf-8');
    while (out.length < maxChars) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    try { await reader.cancel(); } catch (e) {}
  } catch (e) {
    if (!out) throw e;
  }
  return out.length > maxChars ? out.slice(0, maxChars) : out;
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
    let html;
    try { html = await readBodyBudget(res, 300000); }
    catch (e) { return '搜索失败: ' + (e.name === 'AbortError' ? '超时' : e.message); }
    const out = parseDuckDuckGo(html, count);
    if (!out.length) return '搜索「' + query + '」无结果';
    let text = '搜索「' + query + '」结果：\n';
    out.forEach((r, i) => { text += (i + 1) + '. ' + r.title + '\n   ' + r.url + (r.snip ? '\n   摘要：' + r.snip : '') + '\n'; });
    return text.slice(0, 4000);
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
    // v6.8.6：手动跟随重定向并逐跳校验目标主机。redirect:'follow' 等于只校验首跳，
    // 30x 跳到内网 / 云元数据地址时拦不住；最多跟 5 跳，超出直接放弃
    let current = url;
    let res = null;
    for (let hop = 0; hop <= 5; hop++) {
      let fetchHost = '';
      try { fetchHost = new URL(current).hostname; } catch (e) { return 'URL 非法，仅支持 http/https'; }
      if (isBlockedFetchHost(fetchHost)) return '该地址禁止抓取（内网 / 本机 / 云元数据地址）';
      res = await fetch(current, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
        signal: ctrl.signal, redirect: 'manual'
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        try { if (res.body) await res.body.cancel(); } catch (e) {}
        if (!loc) return '抓取失败：重定向缺少目标地址';
        try { current = new URL(loc, current).href; } catch (e) { return '抓取失败：重定向地址非法'; }
        continue;
      }
      break;
    }
    if (res && res.status >= 300 && res.status < 400) return '重定向次数过多（超过 5 跳），已停止抓取';
    if (!res) return '抓取失败';
    if (!res.ok) return '抓取失败，HTTP ' + res.status;
    const ct = res.headers.get('content-type') || '';
    if (/pdf|image|video|audio|octet-stream/i.test(ct)) return '不支持抓取该类型内容(' + ct + ')';
    let html;
    try { html = await readBodyBudget(res, 500000); }
    catch (e) { return '抓取失败: ' + (e.name === 'AbortError' ? '超时' : e.message); }
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

export {
  parseDuckDuckGo,
  toolWebSearch,
  toolWebFetch,
};
