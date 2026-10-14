// Agent 工具：DuckDuckGo 搜索与网页正文抓取（_worker.js 原第 487-530,589-621 行）

import { isBlockedFetchHost } from '../net/ssrf.js';

// 还原 DuckDuckGo 的跳转链接：html 端把真实地址藏在 uddg 参数里
function unwrapDdgHref(href) {
  let u = String(href || '');
  const uddg = u.match(/[?&]uddg=([^&]+)/);
  if (uddg) { try { u = decodeURIComponent(uddg[1]); } catch (e) {} }
  return u;
}

// DuckDuckGo HTML 结果解析（抽出以便测试）
// v6.8.6：按 result 块解析，标题与摘要取自同一块。旧版把「全局第 i 个 snippet」
// 配给「第 i 个结果」，只要某条结果缺 snippet（或页面结构稍有出入），
// 后面所有结果的摘要就整体错位一位。
// v6.9.4：html.duckduckgo.com 改版后 class 不再稳定（result__a 可能消失），
// 主解析无结果时回退到 web-result / result-link 结构，避免搜索整体失效。
function parseDuckDuckGo(html, count) {
  const out = [];
  const seen = new Set();
  const clean = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const push = (title, href, snip) => {
    const url = unwrapDdgHref(href);
    if (!title || !url || !url.startsWith('http') || seen.has(url)) return;
    seen.add(url);
    out.push({ title, url, snip: snip ? snip.slice(0, 200) : '' });
  };
  const blockRe = /<div[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*\bresult\b[^"]*"|<\/body>|$)/g;
  let bm;
  while ((bm = blockRe.exec(html)) && out.length < count) {
    const body = bm[1];
    const am = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(body);
    if (!am) continue;
    const sm = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(body)
      || /<[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td|span)>/.exec(body);
    push(clean(am[2]), am[1], sm ? clean(sm[1]) : '');
  }
  if (out.length) return out;
  // 回退：新版结果块用 web-result，链接 class 为 result-link，摘要在 result-snippet
  // 只认结果容器 class。不能用裸的 \bresult\b：摘要 class="result-snippet"
  // 里也有 result，会被提前截断，摘要永远配对不上。
  const altRe = /<(?:div|article|li)[^>]*class="[^"]*\b(?:web-result|results_links|result--(?:url|snippet)?)\b[^"]*"[^>]*>([\s\S]*?)(?=<(?:div|article|li)[^>]*class="[^"]*\b(?:web-result|results_links)\b|<\/body>|$)/g;
  let am2;
  while ((am2 = altRe.exec(html)) && out.length < count) {
    const body = am2[1];
    const link = /<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(body)
      || /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(body);
    if (!link) continue;
    const sn = /<[^>]*class="[^"]*(?:result-snippet|result__snippet)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|td|span|a|p)>/.exec(body);
    push(clean(link[2]), link[1], sn ? clean(sn[1]) : '');
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
    // v6.9.4：html 端偶发 202 / 验证页，lite 端结构更稳，作为第二来源。
    // 两个都试，谁先解析出结果用谁；都没有才报无结果。
    const endpoints = [
      'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query),
      'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query)
    ];
    let out = [];
    let lastStatus = 0;
    for (const endpoint of endpoints) {
      if (ctrl.signal.aborted) break;
      let res;
      try {
        res = await fetch(endpoint, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
          signal: ctrl.signal
        });
      } catch (e) {
        if (e && e.name === 'AbortError') return '搜索失败: 超时';
        continue;
      }
      lastStatus = res.status;
      if (!res.ok) { try { if (res.body) await res.body.cancel(); } catch (e) {} continue; }
      let html = '';
      try { html = await readBodyBudget(res, 300000); }
      catch (e) { continue; }
      out = endpoint.indexOf('/lite/') !== -1 ? parseDuckDuckGoLite(html, count) : parseDuckDuckGo(html, count);
      if (!out.length && endpoint.indexOf('/lite/') === -1) out = parseDuckDuckGoLite(html, count);
      if (out.length) break;
    }
    if (!out.length && lastStatus && lastStatus !== 200) return '搜索请求失败，HTTP ' + lastStatus;
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

// lite.duckduckgo.com 是表格布局：结果链接 class="result-link"，
// 下一行 class="result-snippet" 是摘要。没有 result 块可切，按行配对。
function parseDuckDuckGoLite(html, count) {
  const out = [];
  const seen = new Set();
  const clean = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const linkRe = /<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = linkRe.exec(html)) && out.length < count) {
    const url = unwrapDdgHref(m[1]);
    const title = clean(m[2]);
    if (!title || !url || !url.startsWith('http') || seen.has(url)) continue;
    seen.add(url);
    const after = html.slice(m.index, m.index + 1200);
    const sn = /<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/.exec(after);
    out.push({ title, url, snip: sn ? clean(sn[1]).slice(0, 200) : '' });
  }
  return out;
}

export {
  parseDuckDuckGo,
  parseDuckDuckGoLite,
  toolWebSearch,
  toolWebFetch,
};
