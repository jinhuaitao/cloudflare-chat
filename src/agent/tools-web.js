// Agent 工具：多后端免密钥搜索（DuckDuckGo + Bing RSS 兜底）与网页正文抓取（直连 → 阅读器 → 网页快照 三级回退）
//
// v7.9.1 修复（搜索「无任何收录结果」与「页面无有效文本内容」两类误报）：
//  1) 搜索源被反爬时不再谎称「无结果」：DuckDuckGo 的 html/lite 端点现在会返回 HTTP 202 +
//     anomaly 挑战页，旧版把挑战页当成「解析不到结果」直接回「搜索「x」无结果」，
//     模型据此判定「无任何收录结果」并停止作答。现在识别挑战页 → 触发 3 分钟冷却 →
//     自动切到 Bing RSS 后端，两个后端都被拦截时才明确报「被反爬拦截」；
//  2) 新增 Bing RSS 后端（`format=rss` 是给聚合器用的正规出口，数据中心 IP 可用），
//     与 DDG 结果同构（title/url/snippet），count 由本地切片保证；
//  3) 抓取失败不再只有 Jina 一条退路：Jina 对浏览器 UA 直接 403（旧版正是用
//     'Mozilla/5.0 (compatible; …)' 之外的浏览器 UA 打过去时被拒），现在改用阅读器专用 UA +
//     Accept: text/plain，并新增 Wayback 网页快照回退；三级链路各自独立超时，
//     不再共用「已被直连抓取耗光」的 AbortSignal（旧版 Jina 经常一发起就被 abort，
//     于是 403 页面白等 16 秒后只得到一句「抓取失败」）；
//  4) 正文提取重写：旧版用 `<(script|style|…|head)[\s\S]*?<\/(script|style|…|head)>` 一条正则
//     跨标签清理，遇到 `<head><style>…</style>` 时会在 `</style>` 处提前收尾，把 `<head>` 之后
//     的正文一起吃掉；现在逐标签剥离，并新增 meta description / __NEXT_DATA__ / ld+json
//     等内联 JSON 兜底，SPA 空壳页面也能给出内容；
//  5) 按响应头 / `<meta charset>` 探测编码（GBK/GB2312 站点不再整篇乱码）；
//  6) 失败结果做 60 秒负缓存：模型同一轮里对同一 URL 反复重试时立即返回同一结论，不再每次空等十几秒。

import { isBlockedFetchHost } from '../net/ssrf.js';
import { mapSetBounded, mapGetBounded } from '../utils.js';

const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
// 阅读器（r.jina.ai）会拒绝浏览器 UA（直接 403），必须用带用途标识的 UA
const UA_READER = 'Mozilla/5.0 (compatible; Cloudflare-Chat/7.9.1; +https://github.com/jinhuaitao/cloudflare-chat)';

const SEARCH_BUDGET_MS = 11000;
const SEARCH_TTL_MS = 3 * 60 * 1000;
const PAGE_TTL_MS = 5 * 60 * 1000;
const PAGE_FAIL_TTL_MS = 60 * 1000;
const DDG_COOLDOWN_MS = 3 * 60 * 1000;

const webSearchCache = new Map();
const webSearchExp = new Map();

const webPageCache = new Map();
const webPageExp = new Map();
const inflightFetches = new Map();
// 失败结果短时缓存：避免模型对同一个被墙/被拒的 URL 反复重试，每次都空等十几秒
const pageFailCache = new Map();
const pageFailExp = new Map();

// DDG 触发挑战后的冷却截止时间（isolate 内共享），冷却期内直接走 Bing，避免继续撞反爬
let ddgCooldownUntil = 0;

// ==================== 通用小工具 ====================

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!(n >= min)) return dflt;
  return n > max ? max : n;
}

function decodeXmlEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch (e) { return ''; } })
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 10)); } catch (e) { return ''; } })
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'").replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&');
}

// 去标签 + 还原实体；先剥标签再还原，避免 &lt;b&gt; 这类被还原成标签后残留
function stripTags(s) {
  return decodeXmlEntities(String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' '))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ==================== 搜索：结果解析 ====================

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

// Bing RSS 结果解析（`format=rss` 出口返回标准 RSS 2.0）
function parseBingRss(xml, count) {
  const out = [];
  const seen = new Set();
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(String(xml || ''))) && out.length < count) {
    const body = m[1];
    const tm = /<title>([\s\S]*?)<\/title>/i.exec(body);
    const lm = /<link>([\s\S]*?)<\/link>/i.exec(body);
    const dm = /<description>([\s\S]*?)<\/description>/i.exec(body);
    const title = stripTags(tm ? tm[1] : '');
    const url = decodeXmlEntities(lm ? lm[1] : '').trim();
    const snip = stripTags(dm ? dm[1] : '');
    if (!title || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: title.slice(0, 200), url, snip: snip.slice(0, 200) });
  }
  return out;
}

// 识别 DuckDuckGo 的反爬挑战页：HTTP 202/403/429，或正文出现 anomaly 弹窗
function isDdgChallenge(status, body) {
  if (status === 202 || status === 403 || status === 429) return true;
  const s = String(body || '');
  const head = s.length > 60000 ? s.slice(0, 60000) : s;
  return /anomaly-modal|challenge-form|anomaly\.js|bots use DuckDuckGo/i.test(head);
}

// Bing 网页版的部分结果链接是 `bing.com/ck/a?...&u=a1<base64url>` 的跳转壳，
// 直接回灌给模型会让它去抓 bing.com 自身。这里解出真实地址；解不出来就丢弃该条。
function unwrapBingHref(href) {
  const raw = decodeXmlEntities(String(href || '')).trim();
  if (!/bing\.com\/ck\/a/i.test(raw)) return raw;
  const m = /[?&]u=([^&]+)/.exec(raw);
  if (!m) return '';
  let v = m[1];
  try { v = decodeURIComponent(v); } catch (e) {}
  if (v.slice(0, 2) === 'a1') v = v.slice(2);
  v = v.replace(/-/g, '+').replace(/_/g, '/');
  const pad = v.length % 4;
  if (pad) v += '='.repeat(4 - pad);
  let dec = '';
  try { dec = atob(v); } catch (e) { return ''; }
  if (dec.slice(0, 2) === '//') dec = 'https:' + dec;
  if (!/^https?:\/\//i.test(dec)) return '';
  return dec;
}

// Bing 网页版结果解析（`b_algo` 块）。RSS 出口虽然最不容易被拦，但结果质量很差
// （实测英文技术词会被降级成一堆品牌首页），所以优先解析网页版。
function parseBingHtml(html, count) {
  const out = [];
  const seen = new Set();
  const s = String(html || '');
  const blockRe = /<li class="b_algo"[\s\S]*?(?=<li class="b_algo"|<li class="b_ans"|<\/ol>|$)/g;
  let bm;
  while ((bm = blockRe.exec(s)) && out.length < count) {
    const body = bm[0];
    const am = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(body);
    if (!am) continue;
    const url = unwrapBingHref(am[1]);
    const title = stripTags(am[2]);
    if (!title || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
    const pm = /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(body)
      || /<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/.exec(body);
    seen.add(url);
    out.push({ title: title.slice(0, 200), url, snip: pm ? stripTags(pm[1]).slice(0, 200) : '' });
  }
  return out;
}

// Brave 网页版结果解析（`div.snippet[data-type=web]` 块）
function parseBraveSearch(html, count) {
  const out = [];
  const seen = new Set();
  const parts = String(html || '').split(/<div class="snippet [^"]*"[^>]*data-pos="/).slice(1);
  for (const part of parts) {
    if (out.length >= count) break;
    if (part.slice(0, 600).indexOf('data-type="web"') === -1) continue;
    const hm = /<a[^>]+href="(https?:\/\/[^"]+)"/.exec(part);
    if (!hm) continue;
    const url = decodeXmlEntities(hm[1]);
    if (seen.has(url)) continue;
    const tm = /<div class="title[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(part);
    const title = stripTags(tm ? tm[1] : '');
    if (!title) continue;
    const sm = /<div class="content[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(part);
    let snip = stripTags(sm ? sm[1] : '');
    snip = snip.replace(/^\d+\s+\w+\s+ago\s*-\s*/, '');
    seen.add(url);
    out.push({ title: title.slice(0, 200), url, snip: snip.slice(0, 200) });
  }
  return out;
}

// 识别 Bing / Brave 的反爬页（两者都会返回 200 + 挑战页）
function isSearchChallengePage(html) {
  return /captcha|unusual traffic|verify you are (?:a )?human|Just a moment|Enable JavaScript and cookies/i.test(String(html || '').slice(0, 20000));
}

// ==================== 抓取：编码与读取 ====================

function detectCharset(bytes, contentType) {
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(String(contentType || ''));
  if (m) return m[1].toLowerCase();
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, Math.min(bytes.length, 2048)));
  const mm = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)
    || /<meta[^>]+content\s*=\s*["'][^"']*charset=([\w-]+)/i.exec(head);
  return mm ? mm[1].toLowerCase() : '';
}

// 按探测到的编码解码整段响应体（GBK / GB2312 站点此前会整篇乱码）
function decodeBodyBytes(bytes, contentType) {
  const cs = detectCharset(bytes, contentType);
  if (cs && cs !== 'utf-8' && cs !== 'utf8') {
    try { return new TextDecoder(cs, { fatal: false }).decode(bytes); } catch (e) {}
  }
  try { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); } catch (e) {}
  return '';
}

// 流式读取并设预算，到量即停 —— 不把超大响应体整段读进 isolate 内存。
// 与旧版的区别：先按字节累积再统一解码，才能正确处理非 UTF-8 页面。
async function readBodyText(res, maxChars, contentType) {
  const limitChars = maxChars > 0 ? maxChars : 200000;
  if (!res || !res.body) return '';
  const byteCap = Math.min(4 * 1024 * 1024, limitChars * 3 + 8192);
  const chunks = [];
  let total = 0;
  let reader = null;
  try {
    reader = res.body.getReader();
    while (total < byteCap) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) { chunks.push(value); total += value.length; }
    }
  } catch (e) {
    // 读流中途断开时保留已读到的部分，比整段丢弃更有用
    if (!chunks.length) throw e;
  } finally {
    try { if (reader) await reader.cancel(); } catch (e) {}
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  const text = decodeBodyBytes(merged, contentType);
  return text.length > limitChars ? text.slice(0, limitChars) : text;
}

// ==================== 抓取：正文提取 ====================

function extractPageTitle(html) {
  const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  if (!tm || !tm[1]) return '';
  return decodeXmlEntities(tm[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 160);
}

function extractMetaDescription(html) {
  const s = String(html || '');
  const m = /<meta[^>]+name\s*=\s*["'](?:description|og:description|twitter:description)["'][^>]*content\s*=\s*["']([^"']{16,800})["']/i.exec(s)
    || /<meta[^>]+content\s*=\s*["']([^"']{16,800})["'][^>]*name\s*=\s*["'](?:description|og:description)["']/i.exec(s)
    || /<meta[^>]+property\s*=\s*["']og:description["'][^>]*content\s*=\s*["']([^"']{16,800})["']/i.exec(s);
  return m ? decodeXmlEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

// 内联 JSON 兜底：__NEXT_DATA__ / ld+json / __NUXT__ / __INITIAL_STATE__ 里通常躺着
// SPA 首屏的全部文案。抽取「像自然语言的字符串」，供空壳页面使用。
const EMBED_PAYLOAD_RES = [
  /<script[^>]+id\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/gi,
  /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  /(?:window\.__NUXT__|window\.__INITIAL_STATE__|window\.__PRELOADED_STATE__|__APOLLO_STATE__)\s*=\s*(\{[\s\S]{40,200000}?\})\s*[;<]/gi,
];

function extractEmbeddedContent(html) {
  const s = String(html || '');
  if (!s) return '';
  const out = [];
  const seen = new Set();
  for (const re of EMBED_PAYLOAD_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) && out.length < 300) {
      const payload = m[1] || '';
      if (payload.length < 40) continue;
      const strRe = /"((?:[^"\\]|\\.){20,600})"/g;
      let sm;
      while ((sm = strRe.exec(payload))) {
        let v = sm[1];
        try { v = JSON.parse('"' + v + '"'); } catch (e) {}
        v = String(v).replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
        if (v.length < 20 || seen.has(v)) continue;
        if (/^https?:\/\//i.test(v)) continue;
        if (!/[\s\u4e00-\u9fff]/.test(v)) continue;   // 必须像自然语言，排除标识符 / 类名
        if (/^[\w.\-/]+$/.test(v)) continue;
        seen.add(v);
        out.push(v);
      }
    }
  }
  const text = out.join('\n');
  return text.length > 4000 ? text.slice(0, 4000) : text;
}

// 结构化 HTML → 轻量 Markdown 提取，保留页面标题、标题层级、代码块、链接、列表、表格与段落换行
function htmlToStructuredText(html) {
  let s = String(html || '');
  const pageTitle = extractPageTitle(s);
  const description = extractMetaDescription(s);

  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // 逐标签剥离。旧版用一条 `<(?:script|style|…|head)[\s\S]*?<\/(?:script|style|…|head)>`
  // 跨标签清理：闭标签是 6 选 1，遇到 `<head><style>…</style>` 会在 `</style>` 处提前收尾，
  // 其后的 `<meta>`/`<link>` 残留尚可，但若页面把正文放在被误判的区间里就会整段丢失。
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<canvas[\s\S]*?<\/canvas>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<title[\s\S]*?<\/title>/gi, ' ')
    .replace(/<meta[^>]*>/gi, ' ')
    .replace(/<link[^>]*>/gi, ' ');
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

  // 空壳页面：正文几乎没有，但 meta description 常有干货，补上避免只剩一个标题
  if (s.length < 200 && description && s.indexOf(description) === -1) {
    s = (s ? s + '\n\n' : '') + description;
  }
  if (pageTitle && s && s.indexOf(pageTitle) === -1) {
    s = '# ' + pageTitle + '\n\n' + s;
  }
  return s;
}

// ==================== 抓取：三级回退 ====================

function stripReaderPreamble(text) {
  const t = String(text || '').trim();
  const marker = 'Markdown Content:';
  const idx = t.indexOf(marker);
  if (idx !== -1 && idx < 500) return t.slice(idx + marker.length).trim();
  // 兼容没有正文标记的短响应：逐行剥掉阅读器的元信息头
  return t.replace(/^(?:Title|URL Source|Published Time|Warning):[^\n]*\n+/i, '').trim();
}

// 阅读器抓不到目标页时仍会返回 200 + 一段错误说明（"Target URL returned error 403"）。
// 这类响应必须判失败，否则会被当成正文回灌给模型，变成「抓到了但内容是报错」。
function isReaderError(text) {
  return /Target URL returned error \d{3}/i.test(String(text || '').slice(0, 800));
}

// 回退一：Jina Reader（免密钥）。注意 UA 必须是「阅读器」标识，浏览器 UA 会被判滥用直接 403。
async function tryJinaFallback(targetUrl, budgetMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1500, Math.min(9000, budgetMs)));
  try {
    const res = await fetch('https://r.jina.ai/' + targetUrl, {
      headers: { 'User-Agent': UA_READER, 'Accept': 'text/plain' },
      signal: ctrl.signal
    });
    if (!res.ok) {
      try { if (res.body) await res.body.cancel(); } catch (e) {}
      return '';
    }
    const text = await readBodyText(res, 200000, res.headers.get('content-type') || 'text/plain');
    if (isReaderError(text)) return '';
    return stripReaderPreamble(text);
  } catch (e) {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// 回退二：Wayback Machine 网页快照。对反爬站点（403/429/JS 墙）常能拿到历史版本。
async function tryWaybackFallback(targetUrl, budgetMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1500, Math.min(9000, budgetMs)));
  try {
    const api = 'https://archive.org/wayback/available?url=' + encodeURIComponent(targetUrl);
    const r1 = await fetch(api, {
      headers: { 'User-Agent': UA_READER, Accept: 'application/json' },
      signal: ctrl.signal
    });
    if (!r1.ok) {
      try { if (r1.body) await r1.body.cancel(); } catch (e) {}
      return '';
    }
    const raw = await readBodyText(r1, 20000, 'application/json');
    let snap = null;
    try { snap = (JSON.parse(raw) || {}).archived_snapshots; } catch (e) { return ''; }
    const closest = snap && snap.closest;
    if (!closest || !closest.available || !closest.url) return '';
    // id_ 后缀取「原始内容」，避免把 Wayback 的工具条一起抓进来
    const snapUrl = String(closest.url).replace(/\/web\/(\d+)\//, '/web/$1id_/');
    const r2 = await fetch(snapUrl, {
      headers: { 'User-Agent': UA_BROWSER, Accept: 'text/html,application/xhtml+xml' },
      signal: ctrl.signal,
      redirect: 'follow'
    });
    if (!r2.ok) {
      try { if (r2.body) await r2.body.cancel(); } catch (e) {}
      return '';
    }
    const html = await readBodyText(r2, 500000, r2.headers.get('content-type') || 'text/html');
    const text = htmlToStructuredText(html);
    // 阈值放低到 40：快照本身就是「有总比没有好」的兜底，短页面也应返回
    if (text.length < 40) return '';
    return '（以下内容来自网页快照 ' + (closest.timestamp || '') + '，可能不是最新版本）\n\n' + text;
  } catch (e) {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// 回退链：Jina 与 Wayback 并发（串行时最坏要等两条链路各自超时，
// 403 站点上实测能拖到 10 秒以上）。两者都有结果时优先用 Jina：它是实时正文，
// Wayback 只是历史快照。
async function fallbackExtract(targetUrl, budgetMs) {
  if (budgetMs < 1500) return '';
  const [jina, wayback] = await Promise.all([
    tryJinaFallback(targetUrl, budgetMs - 600),
    tryWaybackFallback(targetUrl, budgetMs - 300),
  ]);
  if (jina && jina.length >= 80) return jina;
  if (wayback) return wayback;
  return jina || '';
}

function sliceWebPageText(text, offset, pageSize) {
  const totalLen = text.length;
  if (offset >= totalLen) {
    // 判为失败：越界的 offset 按成功返回会被同轮记忆化，模型再翻也拿不到内容
    return '抓取失败：偏移量 offset=' + offset + ' 已超出页面正文总长度（' + totalLen + ' 字符），请改用更小的 offset。';
  }
  const slice = text.slice(offset, offset + pageSize);
  const nextOffset = offset + slice.length;
  if (nextOffset < totalLen) {
    return slice + '\n\n> （当前显示第 ' + offset + ' ~ ' + nextOffset + ' 字符，网页正文共 ' + totalLen + ' 字符；如需继续阅读后续部分，请调用 web_fetch 并传 offset=' + nextOffset + '）';
  }
  return slice;
}

async function fetchAndParseWebPage(url, customTimeoutMs) {
  const budget = Math.max(4000, parseInt(customTimeoutMs, 10) || 16000);
  const startedAt = Date.now();
  const remain = () => budget - (Date.now() - startedAt);
  // 直连只花掉约一半预算，剩下的留给回退链 —— 旧版把 16 秒全给直连，
  // 回退请求一发起就撞上已 abort 的 signal，等于没有回退。
  const directBudget = Math.min(9000, Math.max(2500, Math.round(budget * 0.55)));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), directBudget);
  try {
    let current = url;
    let res = null;
    for (let hop = 0; hop <= 5; hop++) {
      let fetchHost = '';
      try { fetchHost = new URL(current).hostname; } catch (e) { return { err: 'URL 非法，仅支持 http/https' }; }
      if (isBlockedFetchHost(fetchHost)) return { err: '该地址禁止抓取（内网 / 本机 / 云元数据地址）' };
      res = await fetch(current, {
        headers: {
          'User-Agent': UA_BROWSER,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        },
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
    if (res && res.status >= 300 && res.status < 400) return { err: '抓取失败：重定向次数过多（超过 5 跳），已停止抓取' };
    if (!res) return { err: '抓取失败' };

    let text = '';
    if (!res.ok) {
      try { if (res.body) await res.body.cancel(); } catch (e) {}
      const fb = await fallbackExtract(current, remain());
      if (fb) return { text: fb };
      const hint = res.status === 403 || res.status === 401
        ? '（站点拒绝非浏览器访问，已尝试阅读器与网页快照，均不可用；可改抓该站的其他页面或换来源）'
        : '（已尝试阅读器与网页快照，均不可用）';
      return { err: '抓取失败：HTTP ' + res.status + hint };
    }

    const ct = res.headers.get('content-type') || '';
    if (/pdf|image|video|audio|octet-stream|zip|font/i.test(ct)) {
      try { if (res.body) await res.body.cancel(); } catch (e) {}
      return { err: '不支持抓取该类型内容(' + ct + ')' };
    }
    let html;
    try { html = await readBodyText(res, 500000, ct); }
    catch (e) { return { err: '抓取失败: ' + (e.name === 'AbortError' ? '超时' : e.message) }; }
    text = htmlToStructuredText(html);

    // SPA 空壳：可见文本极少，先试内联 JSON 里的首屏文案
    if (text.length < 200) {
      const embedded = extractEmbeddedContent(html);
      if (embedded.length > text.length) text = embedded;
    }
    // 仍然太少 → 上回退链
    if (text.length < 80) {
      const fb = await fallbackExtract(current, remain());
      if (fb.length > text.length) text = fb;
    }

    if (!text || !text.trim()) {
      return { err: '抓取失败：页面无有效文本内容（该页要么是纯 JS 渲染的单页应用，要么对抓取做了限制；已尝试内联数据、阅读器与网页快照，可改抓该站的 API、文档页或其他来源）' };
    }
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
  const cachedFail = mapGetBounded(pageFailCache, url, pageFailExp);
  if (typeof cachedFail === 'string' && cachedFail) {
    return { err: cachedFail, fromFailCache: true };
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
    mapSetBounded(webPageCache, url, res.text, 60, webPageExp, PAGE_TTL_MS);
  } else if (res.err) {
    mapSetBounded(pageFailCache, url, res.err, 60, pageFailExp, PAGE_FAIL_TTL_MS);
  }
  return res;
}

// ==================== 搜索：后端实现 ====================

// 带独立超时的抓取 + 读取（超时覆盖到正文读完为止，不只是首字节）
async function fetchTextBudget(url, headers, maxChars, budgetMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(800, budgetMs));
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
    const ct = res.headers.get('content-type') || '';
    if (!res.ok) {
      try { if (res.body) await res.body.cancel(); } catch (e) {}
      const err = new Error('HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }
    const text = await readBodyText(res, maxChars, ct);
    return { text, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

// DuckDuckGo：html 主源 + lite 对冲（1.5 秒未返回即并发拉起）
async function searchDuckDuckGo(query, count, budgetMs) {
  const startedAt = Date.now();
  const epHtml = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  const epLite = 'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query);
  const headers = { 'User-Agent': UA_BROWSER, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' };

  const attempt = async (endpoint) => {
    const remain = budgetMs - (Date.now() - startedAt);
    if (remain < 700) throw new Error('超时');
    const { text, status } = await fetchTextBudget(endpoint, headers, 300000, remain);
    if (isDdgChallenge(status, text)) {
      const e = new Error('DDG_CHALLENGE');
      e.blocked = true;
      e.status = status;
      throw e;
    }
    let list = endpoint.indexOf('/lite/') !== -1 ? parseDuckDuckGoLite(text, count) : parseDuckDuckGo(text, count);
    if (!list.length && endpoint.indexOf('/lite/') === -1) list = parseDuckDuckGoLite(text, count);
    if (!list.length) {
      const e = new Error('EMPTY');
      e.status = status;
      throw e;
    }
    return list;
  };

  let liteStarted = false;
  let hedgeTimer = null;
  const startLite = () => {
    if (liteStarted) return null;
    liteStarted = true;
    return attempt(epLite);
  };
  const primary = attempt(epHtml);
  const hedged = new Promise((resolve, reject) => {
    hedgeTimer = setTimeout(() => {
      const p = startLite();
      if (p) p.then(resolve, reject); else reject(new Error('EMPTY'));
    }, 1500);
    primary.catch(() => {
      if (hedgeTimer) { clearTimeout(hedgeTimer); hedgeTimer = null; }
      const p = startLite();
      if (p) p.then(resolve, reject); else reject(new Error('EMPTY'));
    });
  });
  hedged.catch(() => {});
  try {
    const list = await Promise.any([primary, hedged]);
    return { results: list, blocked: false };
  } catch (agg) {
    const errs = (agg && agg.errors) || [agg];
    const blocked = errs.some(e => e && e.blocked);
    const status = (errs.find(e => e && e.status) || {}).status || 0;
    return { results: [], blocked, status };
  } finally {
    if (hedgeTimer) clearTimeout(hedgeTimer);
  }
}

// Bing RSS：`format=rss` 是给阅读器用的正规出口，数据中心 IP 也能拿到结果。
// 市场按查询语言选择：中文查询走 zh-CN，纯英文/代码类查询走 en-US ——
// 否则英文技术词会被中文市场的中文站点挤满（实测「durable objects」只返回中文官网首页）。
async function searchBing(query, count, budgetMs) {
  const market = /[\u4e00-\u9fff]/.test(query) ? 'mkt=zh-CN&setlang=zh-Hans' : 'mkt=en-US&setlang=en';
  const url = 'https://www.bing.com/search?format=rss&count=' + clampInt(count, 1, 10, 5)
    + '&' + market + '&q=' + encodeURIComponent(query);
  const { text } = await fetchTextBudget(url, {
    'User-Agent': UA_BROWSER,
    'Accept': 'application/rss+xml,application/xml;q=0.9,text/xml;q=0.8,*/*;q=0.5',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  }, 400000, budgetMs);
  const list = parseBingRss(text, count);
  if (!list.length && !/<rss[\s>]/i.test(text)) {
    // 返回的不是 RSS（多半是反爬/跳转页），与「真的没有结果」区分开
    const e = new Error('BING_NOT_RSS');
    e.blocked = true;
    throw e;
  }
  return list;
}

// Bing 网页版：解析 b_algo 块，结果质量明显好于 RSS 出口
async function searchBingHtml(query, count, budgetMs) {
  const market = /[\u4e00-\u9fff]/.test(query) ? 'mkt=zh-CN&setlang=zh-Hans' : 'mkt=en-US&setlang=en';
  const url = 'https://www.bing.com/search?' + market + '&q=' + encodeURIComponent(query);
  const { text } = await fetchTextBudget(url, {
    'User-Agent': UA_BROWSER,
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': /[\u4e00-\u9fff]/.test(query) ? 'zh-CN,zh;q=0.9,en;q=0.8' : 'en-US,en;q=0.9,zh;q=0.6'
  }, 400000, budgetMs);
  const list = parseBingHtml(text, count);
  if (!list.length) {
    const e = new Error('EMPTY');
    e.blocked = isSearchChallengePage(text) || text.indexOf('b_results') === -1;
    throw e;
  }
  return list;
}

// Brave 网页版：无 Key、结果质量最好，但对数据中心 IP 偶有拦截，故与 Bing 并发竞速
async function searchBrave(query, count, budgetMs) {
  const url = 'https://search.brave.com/search?q=' + encodeURIComponent(query);
  const { text } = await fetchTextBudget(url, {
    'User-Agent': UA_BROWSER,
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': /[\u4e00-\u9fff]/.test(query) ? 'zh-CN,zh;q=0.9,en;q=0.8' : 'en-US,en;q=0.9,zh;q=0.6'
  }, 400000, budgetMs);
  const list = parseBraveSearch(text, count);
  if (!list.length) {
    const e = new Error('EMPTY');
    e.blocked = isSearchChallengePage(text);
    throw e;
  }
  return list;
}

// 可选：Brave 官方搜索 API（配置 BRAVE_API_KEY 后启用）。
// 免密钥的网页版搜索在不同出口 IP 上质量差异极大（数据中心 IP 常被降级），
// 需要稳定结果时填一个免费额度的 Key 即可，不填仍走零密钥链路。
async function searchBraveApi(query, count, apiKey, budgetMs) {
  const url = 'https://api.search.brave.com/res/v1/web/search?count=' + clampInt(count, 1, 10, 5)
    + '&q=' + encodeURIComponent(query);
  const { text } = await fetchTextBudget(url, {
    'Accept': 'application/json',
    'X-Subscription-Token': apiKey,
    'User-Agent': UA_READER
  }, 400000, budgetMs);
  let json = null;
  try { json = JSON.parse(text); } catch (e) { return []; }
  const items = (json && json.web && json.web.results) || [];
  const out = [];
  const seen = new Set();
  for (const it of items) {
    if (out.length >= count) break;
    const url2 = String(it.url || '');
    const title = stripTags(it.title || '');
    if (!title || !/^https?:\/\//i.test(url2) || seen.has(url2)) continue;
    seen.add(url2);
    out.push({ title: title.slice(0, 200), url: url2, snip: stripTags(it.description || '').slice(0, 200) });
  }
  return out;
}

// v7.12.1 准确率：URL 归一化去重 —— 剥掉 utm_* / spm 等跟踪参数、统一 host 大小写与尾斜杠，
// 使 `example.com/a?utm_source=x` 与 `example.com/a/` 被识别为同一页面。
function normalizeSearchUrl(u) {
  try {
    const url = new URL(String(u));
    url.hash = '';
    const drop = [];
    for (const k of url.searchParams.keys()) {
      if (/^(utm_|spm|from|ref|ref_src|fbclid|gclid|igshid)/i.test(k)) drop.push(k);
    }
    for (const k of drop) url.searchParams.delete(k);
    let s = url.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch (e) {
    return String(u || '').replace(/\/+$/, '');
  }
}

function dedupeSearchResults(list) {
  const seen = new Set();
  const out = [];
  for (const r of list) {
    if (!r || !r.url) continue;
    const key = normalizeSearchUrl(r.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

async function toolWebSearch(query, count, deepRead, env) {
  if (query && typeof query === 'object') {
    const a = query;
    query = a.query;
    count = a.count;
    deepRead = a.deep_read;
  }
  query = String(query || '').trim();
  if (!query) return '搜索关键词为空';
  count = clampInt(count, 1, 8, 5);
  const wantDeep = deepRead !== false; // 默认开启自动预读首条高价值正文摘要，一步到位免二次 tool call
  const cacheKey = query.toLowerCase() + '|' + count + '|' + (wantDeep ? '1' : '0');
  const cached = mapGetBounded(webSearchCache, cacheKey, webSearchExp);
  if (cached) return cached;

  const startedAt = Date.now();
  const deadline = startedAt + SEARCH_BUDGET_MS;
  const remain = () => deadline - Date.now();
  let out = [];
  let blocked = false;
  const blockedNames = [];

  const noteBlocked = (name) => { blocked = true; if (blockedNames.indexOf(name) === -1) blockedNames.push(name); };

  try {
    // ① 配了 BRAVE_API_KEY 就先用官方 API（结果最稳）
    const braveKey = env && env.BRAVE_API_KEY ? String(env.BRAVE_API_KEY).trim() : '';
    if (braveKey) {
      try {
        const list = await searchBraveApi(query, count, braveKey, Math.min(5000, remain() - 2000));
        if (list.length) out = list;
      } catch (e) {}
    }

    // ② DuckDuckGo（冷却期内跳过，避免持续撞反爬）
    if (!out.length && Date.now() >= ddgCooldownUntil) {
      const r = await searchDuckDuckGo(query, count, Math.min(3800, Math.max(1200, remain() - 2600)));
      if (r.results.length) out = r.results;
      else if (r.blocked) {
        noteBlocked('DuckDuckGo');
        ddgCooldownUntil = Date.now() + DDG_COOLDOWN_MS;
      }
    }

    // ③ Brave 网页版优先：无 Key、结果最贴近查询意图（Bing 中文站对英文技术词经常
    //    降级成品牌首页，实测「python asyncio 事件循环」只返回 python.org 首页）。
    //    因此这里串行按质量排序，而不是并发竞速 —— 竞速会让「快但烂」的 Bing 抢先。
    if (!out.length && remain() > 2200) {
      try {
        const list = await searchBrave(query, count, Math.min(4500, remain() - 1600));
        if (list.length) out = list;
      } catch (e) {
        if (e && e.blocked) noteBlocked('Brave');
      }
    }

    // ④ Bing 网页版（b_algo）
    if (!out.length && remain() > 1600) {
      try {
        const list = await searchBingHtml(query, count, Math.min(4000, remain() - 900));
        if (list.length) out = list;
      } catch (e) {
        if (e && e.blocked) noteBlocked('Bing');
      }
    }

    // ⑤ Bing RSS 最后兜底：最不容易被拦，但结果质量一般，只在前面全挂时用
    if (!out.length && remain() > 1400) {
      try {
        const list = await searchBing(query, count, Math.min(4000, remain() - 600));
        if (list.length) out = list;
      } catch (e) {
        if (e && e.blocked) noteBlocked('Bing RSS');
      }
    }

    if (!out.length) {
      if (blocked) {
        return '搜索失败：搜索源被反爬拦截（' + blockedNames.join(' / ') + '），已自动切换备用源仍无结果。'
          + '请勿反复重试同一关键词；可改用 web_fetch 直接抓取已知网址，或换更具体的站点内查询。';
      }
      return '搜索「' + query + '」无结果（可换更通用的关键词重试，或直接用 web_fetch 抓取已知网址）';
    }

    // v7.12.1 准确率：结果去重（按 URL 归一化：去跟踪参数、统一大小写与尾斜杠）。
    // 搜索源偶发把同一页面以多个带参 URL 重复返回，模型会误以为"多来源都在说"从而省略交叉验证；
    // 去重后剩下的才是真正的独立来源。解析函数内部已有精确去重，这里兜住跨形态的重复。
    out = dedupeSearchResults(out);

    let text = '搜索「' + query + '」结果：\n';
    out.forEach((r, i) => {
      text += (i + 1) + '. ' + r.title + '\n   ' + r.url + (r.snip ? '\n   摘要：' + r.snip : '') + '\n';
    });

    // 一站式预读（Auto-Prefetch Top 2）：并发抓取前 2 条非屏蔽 URL 的正文前 1100 字并预热 L1 缓存
    // 预读预算先扣掉搜索已花掉的时间，整次调用仍控制在预算内
    const previewRemainMs = remain() - 400;
    if (wantDeep && out.length > 0 && previewRemainMs >= 1200) {
      const previewTimeout = Math.min(4200, previewRemainMs);
      const topTargets = out.slice(0, 2).filter(r => {
        try { return !isBlockedFetchHost(new URL(r.url).hostname); } catch (e) { return false; }
      });
      if (topTargets.length) {
        const previews = await Promise.all(topTargets.map(async (item, idx) => {
          try {
            const pRes = await getOrFetchPageText(item.url, previewTimeout);
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
    mapSetBounded(webSearchCache, cacheKey, finalRes, 100, webSearchExp, SEARCH_TTL_MS);
    return finalRes;
  } catch (e) {
    return '搜索失败: ' + (e.name === 'AbortError' ? '超时' : e.message);
  }
}

async function toolWebFetch(url, offset, maxChars) {
  const rawInput = String(url || '').trim();
  if (!rawInput) return 'URL 非法，仅支持 http/https';
  offset = Math.max(0, parseInt(offset, 10) || 0);
  // 单次切片长度由调用方预算决定，尾部提示的 nextOffset 才和实际内容对得上
  const pageCap = Math.max(600, Math.min(6000, (maxChars > 0 ? maxChars : 6000)));

  // 支持一次传入最多 3 个 URL（逗号或换行分隔）并发批量抓取，大幅减少对比阅读步数
  const urlList = rawInput.split(/[\r\n,，]+/).map(s => s.trim()).filter(Boolean);
  if (urlList.length > 1 && offset === 0) {
    const batch = urlList.slice(0, 3);
    const perUrlLimit = Math.max(400, Math.floor(Math.min(pageCap, 5400) / batch.length));
    const results = await Promise.all(batch.map(async (u, i) => {
      // 每条失败都以「抓取失败：」开头 —— 全部失败时聚合结果才能被 isToolFailureResult 识别
      const label = '网页 ' + (i + 1) + '（' + u + '）';
      if (!/^https?:\/\//i.test(u)) return '抓取失败：' + label + ' URL 非法，仅支持 http/https';
      let host = '';
      try { host = new URL(u).hostname; } catch (e) { return '抓取失败：' + label + ' URL 非法，仅支持 http/https'; }
      if (isBlockedFetchHost(host)) return '抓取失败：' + label + ' 该地址禁止抓取（内网 / 本机 / 云元数据地址）';
      const r = await getOrFetchPageText(u, 14000);
      if (r.err) return '抓取失败：' + label + ' ' + r.err;
      return '【' + label + '，共 ' + r.text.length + ' 字符】\n' + r.text.slice(0, perUrlLimit) + (r.text.length > perUrlLimit ? '…' : '');
    }));
    return results.join('\n\n---\n\n');
  }

  // 批量 + offset 是有歧义的组合：静默只抓第一个 URL 会让模型以为翻了 3 篇的页
  if (urlList.length > 1 && offset > 0) {
    return '抓取失败：批量抓取（' + urlList.length + ' 个 URL）不支持 offset 翻页，请一次只传 1 个 URL 再传 offset。本次未抓取。';
  }

  const singleUrl = urlList[0];
  if (!/^https?:\/\//i.test(singleUrl)) return 'URL 非法，仅支持 http/https';
  const PAGE_SIZE = pageCap;

  let fetchHost = '';
  try { fetchHost = new URL(singleUrl).hostname; } catch (e) { return 'URL 非法，仅支持 http/https'; }
  if (isBlockedFetchHost(fetchHost)) return '该地址禁止抓取（内网 / 本机 / 云元数据地址）';

  const res = await getOrFetchPageText(singleUrl, 16000);
  if (res.err) return res.err;
  return sliceWebPageText(res.text, offset, PAGE_SIZE);
}

export {
  parseDuckDuckGo,
  parseDuckDuckGoLite,
  parseBingRss,
  parseBingHtml,
  unwrapBingHref,
  parseBraveSearch,
  isDdgChallenge,
  isSearchChallengePage,
  htmlToStructuredText,
  extractEmbeddedContent,
  extractMetaDescription,
  decodeBodyBytes,
  detectCharset,
  stripReaderPreamble,
  isReaderError,
  normalizeSearchUrl,
  dedupeSearchResults,
  toolWebSearch,
  toolWebFetch,
};
