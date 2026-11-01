// Agent 工具：DuckDuckGo 对冲并发搜索（支持 deep_read 一站式预读）与网页结构化正文抓取（支持批量多 URL、0ms 内存缓存翻页与 Jina 回退）

import { isBlockedFetchHost } from '../net/ssrf.js';
import { mapSetBounded, mapGetBounded } from '../utils.js';

// v7.2.0 性能与效率升级：
// 1) 搜索结果 L1 缓存（TTL 3 分钟，最多 100 条）；
// 2) 网页结构化正文 L1 缓存（TTL 5 分钟，最多 60 篇）+ 在途请求合并（in-flight deduplication）；
// 3) 对冲并发搜索（Hedged Search）：主搜索源超过 2.2s 未响应自动并发拉起备用源竞速，消除长尾超时；
// 4) 搜索自动深读（deep_read）：在 web_search 阶段自动并发预取前 2 条网页的核心正文摘要并预热缓存，
//    将原本「先搜索 → 等模型思考 → 再抓取」的 2 步串行流程压缩为 1 步完成；
// 5) 批量网页抓取：web_fetch 支持一次传入最多 3 个 URL（逗号或空格分隔）并发读取。
const webSearchCache = new Map();
const webSearchExp = new Map();
const WEB_SEARCH_TTL_MS = 3 * 60 * 1000;

const webPageCache = new Map();
const webPageExp = new Map();
const WEB_PAGE_TTL_MS = 5 * 60 * 1000;
const inflightFetches = new Map();

// 还原 DuckDuckGo 的跳转链接：html 端把真实地址藏在 uddg 参数里
function unwrapDdgHref(href) {
  let u = String(href || '');
  const uddg = u.match(/[?&]uddg=([^&]+)/);
  if (uddg) { try { u = decodeURIComponent(uddg[1]); } catch (e) {} }
  return u;
}

// DuckDuckGo HTML 结果解析
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

// 流式读取并设预算，到量即停 —— 不把超大响应体整段读进 isolate 内存
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

// 结构化 HTML → 轻量 Markdown 提取，保留页面标题、标题层级、代码块、链接、列表、表格与段落换行
function htmlToStructuredText(html) {
  let s = String(html || '');
  let pageTitle = '';
  const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s);
  if (tm && tm[1]) {
    pageTitle = tm[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  s = s.replace(/<(?:script|style|noscript|svg|canvas|iframe|footer|nav|head)[\s\S]*?<\/(?:script|style|noscript|svg|canvas|iframe|footer|nav|head)>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_, c) => '\n```\n' + c.replace(/<[^>]*>/g, '').trim() + '\n```\n');
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => '\n```\n' + c.replace(/<[^>]*>/g, '').trim() + '\n```\n');
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => '`' + c.replace(/<[^>]*>/g, '').trim() + '`');
  s = s.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, c) => '\n# ' + c.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() + '\n');
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, c) => '\n## ' + c.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() + '\n');
  s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, c) => '\n### ' + c.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() + '\n');
  s = s.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, c) => '\n#### ' + c.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() + '\n');
  s = s.replace(/<a[^>]*\bhref\s*=\s*["'](https?:\/\/[^"'\s>]{4,160})["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
    const label = inner.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!label || label.length > 80) return ' ' + label + ' ';
    return ` [${label}](${href}) `;
  });
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  s = s.replace(/<\/(?:tr|p|div|section|article|blockquote)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(?:td|th)>/gi, ' | ');
  s = s.replace(/<[^>]*>/g, ' ');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 10)); } catch (e) { return ''; } });
  s = s.replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (pageTitle && s && s.indexOf(pageTitle) === -1) {
    s = '# ' + pageTitle + '\n\n' + s;
  }
  return s;
}

// 免密钥 Jina Reader 回退：当直接抓取遭遇 403/429 反爬或 SPA 空壳页面时尝试提取正文
async function tryJinaFallback(targetUrl, signal) {
  try {
    const jinaUrl = 'https://r.jina.ai/' + targetUrl;
    const res = await fetch(jinaUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Cloudflare-Chat/7.2)',
        'X-Return-Format': 'markdown'
      },
      signal
    });
    if (!res.ok) {
      try { if (res.body) await res.body.cancel(); } catch (e) {}
      return '';
    }
    const text = await readBodyBudget(res, 200000);
    return String(text || '').trim();
  } catch (e) {
    return '';
  }
}

function sliceWebPageText(text, offset, pageSize) {
  const totalLen = text.length;
  if (offset >= totalLen) {
    return '偏移量 offset=' + offset + ' 已超出页面正文总长度（' + totalLen + ' 字符）';
  }
  const slice = text.slice(offset, offset + pageSize);
  const nextOffset = offset + slice.length;
  if (nextOffset < totalLen) {
    return slice + '\n\n> （当前显示第 ' + offset + ' ~ ' + nextOffset + ' 字符，网页正文共 ' + totalLen + ' 字符；如需继续阅读后续部分，请调用 web_fetch 并传 offset=' + nextOffset + '）';
  }
  return slice;
}

async function fetchAndParseWebPage(url, customTimeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), customTimeoutMs || 14000);
  try {
    let current = url;
    let res = null;
    for (let hop = 0; hop <= 5; hop++) {
      let fetchHost = '';
      try { fetchHost = new URL(current).hostname; } catch (e) { return { err: 'URL 非法，仅支持 http/https' }; }
      if (isBlockedFetchHost(fetchHost)) return { err: '该地址禁止抓取（内网 / 本机 / 云元数据地址）' };
      res = await fetch(current, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
        signal: ctrl.signal, redirect: 'manual'
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        try { if (res.body) await res.body.cancel(); } catch (e) {}
        if (!loc) return { err: '抓取失败：重定向缺少目标地址' };
        try { current = new URL(loc, current).href; } catch (e) { return { err: '抓取失败：重定向地址非法' }; }
        continue;
      }
      break;
    }
    if (res && res.status >= 300 && res.status < 400) return { err: '重定向次数过多（超过 5 跳），已停止抓取' };
    if (!res) return { err: '抓取失败' };

    let text = '';
    if (!res.ok) {
      try { if (res.body) await res.body.cancel(); } catch (e) {}
      text = await tryJinaFallback(current, ctrl.signal);
      if (!text) return { err: '抓取失败，HTTP ' + res.status };
    } else {
      const ct = res.headers.get('content-type') || '';
      if (/pdf|image|video|audio|octet-stream/i.test(ct)) {
        try { if (res.body) await res.body.cancel(); } catch (e) {}
        return { err: '不支持抓取该类型内容(' + ct + ')' };
      }
      let html;
      try { html = await readBodyBudget(res, 500000); }
      catch (e) { return { err: '抓取失败: ' + (e.name === 'AbortError' ? '超时' : e.message) }; }
      text = htmlToStructuredText(html);
      if (text.length < 80) {
        const fallbackText = await tryJinaFallback(current, ctrl.signal);
        if (fallbackText.length > text.length) text = fallbackText;
      }
    }

    if (!text) return { err: '页面无有效文本内容' };
    return { text };
  } catch (e) {
    return { err: '抓取失败: ' + (e.name === 'AbortError' ? '超时' : e.message) };
  } finally {
    clearTimeout(timer);
  }
}

// 内部带缓存与在途合并的单页获取辅助
async function getOrFetchPageText(url, timeoutMs) {
  const cachedText = mapGetBounded(webPageCache, url, webPageExp);
  if (typeof cachedText === 'string' && cachedText.length > 0) {
    return { text: cachedText, fromCache: true };
  }
  let pending = inflightFetches.get(url);
  if (!pending) {
    pending = fetchAndParseWebPage(url, timeoutMs).finally(() => {
      inflightFetches.delete(url);
    });
    inflightFetches.set(url, pending);
  }
  const res = await pending;
  if (res.text && res.text.length <= 250000) {
    mapSetBounded(webPageCache, url, res.text, 60, webPageExp, WEB_PAGE_TTL_MS);
  }
  return res;
}

// 单一 DuckDuckGo 端点查询尝试
async function fetchDdgEndpoint(endpoint, count, signal) {
  const res = await fetch(endpoint, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
    signal
  });
  if (!res.ok) {
    try { if (res.body) await res.body.cancel(); } catch (e) {}
    const err = new Error('HTTP ' + res.status);
    err.status = res.status;
    throw err;
  }
  const html = await readBodyBudget(res, 300000);
  let out = endpoint.indexOf('/lite/') !== -1 ? parseDuckDuckGoLite(html, count) : parseDuckDuckGo(html, count);
  if (!out.length && endpoint.indexOf('/lite/') === -1) out = parseDuckDuckGoLite(html, count);
  if (!out.length) {
    const emptyErr = new Error('EMPTY');
    emptyErr.status = 200;
    throw emptyErr;
  }
  return out;
}

async function toolWebSearch(query, count, deepRead) {
  if (query && typeof query === 'object') {
    const a = query;
    query = a.query;
    count = a.count;
    deepRead = a.deep_read;
  }
  query = String(query || '').trim();
  if (!query) return '搜索关键词为空';
  count = Math.min(Math.max(parseInt(count) || 5, 1), 8);
  const wantDeep = deepRead !== false; // 默认开启自动预读首条高价值正文摘要，一步到位免二次 tool call
  const cacheKey = query.toLowerCase() + '|' + count + '|' + (wantDeep ? '1' : '0');
  const cached = mapGetBounded(webSearchCache, cacheKey, webSearchExp);
  if (cached) return cached;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 11000);
  let hedgeTimer = null;
  try {
    const epHtml = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
    const epLite = 'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query);

    // v7.2.0 对冲并发请求（Hedged Request）：主源先行，若 2.0 秒未返回或报错则立即并发拉起 Lite 源竞速
    let out = [];
    let lastStatus = 0;
    try {
      const pPrimary = fetchDdgEndpoint(epHtml, count, ctrl.signal);
      const pHedge = new Promise((resolve, reject) => {
        hedgeTimer = setTimeout(() => {
          fetchDdgEndpoint(epLite, count, ctrl.signal).then(resolve, reject);
        }, 2000);
        pPrimary.catch(() => {
          if (hedgeTimer) { clearTimeout(hedgeTimer); hedgeTimer = null; }
          fetchDdgEndpoint(epLite, count, ctrl.signal).then(resolve, reject);
        });
      });
      out = await Promise.any([pPrimary, pHedge]);
    } catch (aggErr) {
      const errs = (aggErr && aggErr.errors) || [aggErr];
      for (const er of errs) {
        if (er && er.status) lastStatus = er.status;
        if (er && er.name === 'AbortError') return '搜索失败: 超时';
      }
    }

    if (!out.length && lastStatus && lastStatus !== 200) return '搜索请求失败，HTTP ' + lastStatus;
    if (!out.length) return '搜索「' + query + '」无结果';

    let text = '搜索「' + query + '」结果：\n';
    out.forEach((r, i) => {
      text += (i + 1) + '. ' + r.title + '\n   ' + r.url + (r.snip ? '\n   摘要：' + r.snip : '') + '\n';
    });

    // v7.2.0 一站式预读（Auto-Prefetch Top 2）：并发抓取前 2 条非屏蔽 URL 的正文前 1100 字并预热 L1 缓存
    if (wantDeep && out.length > 0) {
      const topTargets = out.slice(0, 2).filter(r => {
        try { return !isBlockedFetchHost(new URL(r.url).hostname); } catch (e) { return false; }
      });
      if (topTargets.length) {
        const previews = await Promise.all(topTargets.map(async (item, idx) => {
          try {
            const pRes = await getOrFetchPageText(item.url, 4200);
            if (pRes && pRes.text && pRes.text.length >= 60) {
              return `【结果 ${idx + 1} 正文速览（已缓存，如需阅读全文可对 ${item.url} 调用 web_fetch 并传 offset=1100）】\n`
                + pRes.text.slice(0, 1100) + (pRes.text.length > 1100 ? '…' : '');
            }
          } catch (e) {}
          return '';
        }));
        const validPreviews = previews.filter(Boolean);
        if (validPreviews.length) {
          text += '\n' + validPreviews.join('\n\n');
        }
      }
    }

    const finalRes = text.slice(0, 4000);
    mapSetBounded(webSearchCache, cacheKey, finalRes, 100, webSearchExp, WEB_SEARCH_TTL_MS);
    return finalRes;
  } catch (e) {
    return '搜索失败: ' + (e.name === 'AbortError' ? '超时' : e.message);
  } finally {
    clearTimeout(timer);
    if (hedgeTimer) clearTimeout(hedgeTimer);
  }
}

async function toolWebFetch(url, offset) {
  const rawInput = String(url || '').trim();
  if (!rawInput) return 'URL 非法，仅支持 http/https';
  offset = Math.max(0, parseInt(offset, 10) || 0);

  // v7.2.0：支持一次传入最多 3 个 URL（逗号或换行分隔）并发批量抓取，大幅减少对比阅读步数
  const urlList = rawInput.split(/[\r\n,，]+/).map(s => s.trim()).filter(Boolean);
  if (urlList.length > 1 && offset === 0) {
    const batch = urlList.slice(0, 3);
    const perUrlLimit = Math.floor(5400 / batch.length);
    const results = await Promise.all(batch.map(async (u, i) => {
      if (!/^https?:\/\//i.test(u)) return `【网页 ${i + 1}：${u}】URL 非法`;
      let host = '';
      try { host = new URL(u).hostname; } catch (e) { return `【网页 ${i + 1}：${u}】URL 非法`; }
      if (isBlockedFetchHost(host)) return `【网页 ${i + 1}：${u}】该地址禁止抓取`;
      const r = await getOrFetchPageText(u, 14000);
      if (r.err) return `【网页 ${i + 1}：${u}】${r.err}`;
      return `【网页 ${i + 1}：${u}（共 ${r.text.length} 字符）】\n` + r.text.slice(0, perUrlLimit) + (r.text.length > perUrlLimit ? '…' : '');
    }));
    return results.join('\n\n---\n\n');
  }

  const singleUrl = urlList[0];
  if (!/^https?:\/\//i.test(singleUrl)) return 'URL 非法，仅支持 http/https';
  const PAGE_SIZE = 6000;

  let fetchHost = '';
  try { fetchHost = new URL(singleUrl).hostname; } catch (e) { return 'URL 非法，仅支持 http/https'; }
  if (isBlockedFetchHost(fetchHost)) return '该地址禁止抓取（内网 / 本机 / 云元数据地址）';

  const res = await getOrFetchPageText(singleUrl, 16000);
  if (res.err) return res.err;
  return sliceWebPageText(res.text, offset, PAGE_SIZE);
}

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
  htmlToStructuredText,
  toolWebSearch,
  toolWebFetch,
};
