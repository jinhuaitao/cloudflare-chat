// Agent 工具：DuckDuckGo 搜索与网页正文抓取（_worker.js 原第 487-530,589-621 行）

import { isBlockedFetchHost } from '../net/ssrf.js';

// DuckDuckGo HTML 结果解析（抽出以便测试）
function parseDuckDuckGo(html, count) {
  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  // 摘要与标题在页面中按相同顺序出现，按序配对
  const snips = [];
  const reSnip = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let sm;
  while ((sm = reSnip.exec(html)) && snips.length < count) {
    snips.push(sm[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200));
  }
  let m;
  while ((m = re.exec(html)) && out.length < count) {
    let href = m[1];
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    try { if (uddg) href = decodeURIComponent(uddg[1]); } catch (e) {}
    const title = m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (title && href && href.startsWith('http')) out.push({ title, url: href, snip: snips[out.length] || '' });
  }
  return out;
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
  // v6.8.1 SSRF 防护：先解析 hostname 再放行
  let fetchHost = '';
  try { fetchHost = new URL(url).hostname; } catch (e) { return 'URL 非法，仅支持 http/https'; }
  if (isBlockedFetchHost(fetchHost)) return '该地址禁止抓取（内网 / 本机 / 云元数据地址）';
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

export {
  parseDuckDuckGo,
  toolWebSearch,
  toolWebFetch,
};
