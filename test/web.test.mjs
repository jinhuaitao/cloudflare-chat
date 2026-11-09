// 网页抓取与联网搜索回归测试（node --test）
// 覆盖：DuckDuckGo 反爬识别、多后端搜索回退、失败文案语义、正文提取（含旧版跨标签清理 bug）、
// 内联 JSON 兜底、编码探测、三级抓取回退与失败负缓存。全部离线（fetch 由测试桩替代）。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  safeFetch,
  parseBingRss,
  parseBingHtml,
  unwrapBingHref,
  parseBraveSearch,
  isDdgChallenge,
  htmlToStructuredText,
  extractEmbeddedContent,
  decodeBodyBytes,
  stripReaderPreamble,
  toolWebSearch,
  toolWebFetch,
} from '../src/agent/tools-web.js';
import { isToolFailureResult } from '../src/agent/tools.js';

// ==================== 测试桩 ====================

function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    return handler(String(url), init || {});
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => { globalThis.fetch = real; })
    .then((r) => ({ result: r, calls }));
}

const DDG_CHALLENGE_HTML = '<!DOCTYPE html><html><body><div class="anomaly-modal__mask">'
  + 'Unfortunately, bots use DuckDuckGo too. Please complete the following challenge</div></body></html>';

const BRAVE_HTML = '<div class="snippet svelte-jmfu5f" data-pos="0" data-type="web">'
  + '<div class="result-body"><a href="https://developers.cloudflare.com/durable-objects/" target="_self">'
  + '<div class="url-wrapper"><cite class="snippet-url">developers.cloudflare.com</cite></div>'
  + '<div class="title search-snippet-title">Durable Objects · Cloudflare docs</div></a>'
  + '<div class="generic-snippet"><div class="content desktop-default-regular">'
  + '<span class="t-secondary">2 weeks ago -</span> Durable Objects provide a single point of coordination.</div></div></div></div>'
  + '<div class="snippet svelte-jmfu5f" data-pos="1" data-type="web">'
  + '<div class="result-body"><a href="https://blog.example.com/do-guide">'
  + '<div class="title search-snippet-title">A practical guide to Durable Objects</div></a>'
  + '<div class="generic-snippet"><div class="content">Stateful serverless at the edge.</div></div></div></div>';

const BING_HTML = '<ol id="b_results">'
  + '<li class="b_algo"><h2><a href="https://example.org/a">Example A</a></h2>'
  + '<div class="b_caption"><p class="b_lineclamp2">Snippet A &amp; more</p></div></li>'
  + '<li class="b_algo"><h2><a href="https://example.org/b">Example B</a></h2>'
  + '<div class="b_caption"><p class="b_lineclamp2">Snippet B</p></div></li>'
  + '</ol>';

const BING_RSS = '<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel>'
  + '<item><title>RSS One</title><link>https://rss.example.com/1</link>'
  + '<description>First &lt;b&gt;hit&lt;/b&gt; &amp; detail</description></item>'
  + '<item><title><![CDATA[RSS Two]]></title><link>https://rss.example.com/2</link>'
  + '<description>Second hit</description></item>'
  + '</channel></rss>';

// ==================== 结果解析 ====================

test('parseBingRss 还原实体 / CDATA，并遵守条数上限', () => {
  const all = parseBingRss(BING_RSS, 10);
  assert.equal(all.length, 2);
  assert.equal(all[0].title, 'RSS One');
  assert.equal(all[0].url, 'https://rss.example.com/1');
  assert.equal(all[0].snip, 'First hit & detail');
  assert.equal(all[1].title, 'RSS Two');
  assert.equal(parseBingRss(BING_RSS, 1).length, 1);
  assert.equal(parseBingRss('not xml', 5).length, 0);
});

test('parseBingHtml 提取 b_algo 块的标题 / 链接 / 摘要', () => {
  const list = parseBingHtml(BING_HTML, 5);
  assert.equal(list.length, 2);
  assert.equal(list[0].title, 'Example A');
  assert.equal(list[0].url, 'https://example.org/a');
  assert.equal(list[0].snip, 'Snippet A & more');
});

test('parseBingHtml 解开 bing.com/ck/a 跳转壳，拿不到真实地址就丢弃', () => {
  const ck = 'https://www.bing.com/ck/a?!&&p=abc&amp;u=a1aHR0cHM6Ly9leGFtcGxlLm9yZy9yZWFsLXRhcmdldA&amp;ntb=1';
  assert.equal(unwrapBingHref(ck), 'https://example.org/real-target');
  assert.equal(unwrapBingHref('https://plain.example.com/x'), 'https://plain.example.com/x');
  assert.equal(unwrapBingHref('https://www.bing.com/ck/a?!&&p=abc'), '');

  const html = '<ol id="b_results"><li class="b_algo"><h2><a href="' + ck + '">真实目标</a></h2>'
    + '<div class="b_caption"><p class="b_lineclamp2">摘要</p></div></li>'
    + '<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&&p=bad">坏链接</a></h2></li></ol>';
  const list = parseBingHtml(html, 5);
  assert.equal(list.length, 1);
  assert.equal(list[0].url, 'https://example.org/real-target');
});

test('parseBraveSearch 提取 snippet 块并去掉时间前缀', () => {
  const list = parseBraveSearch(BRAVE_HTML, 5);
  assert.equal(list.length, 2);
  assert.equal(list[0].url, 'https://developers.cloudflare.com/durable-objects/');
  assert.equal(list[0].title, 'Durable Objects · Cloudflare docs');
  assert.equal(list[0].snip.indexOf('2 weeks ago'), -1);
  assert.ok(list[0].snip.indexOf('single point of coordination') !== -1);
});

test('isDdgChallenge 识别 202 / 403 与 anomaly 挑战页', () => {
  assert.equal(isDdgChallenge(202, ''), true);
  assert.equal(isDdgChallenge(403, ''), true);
  assert.equal(isDdgChallenge(200, DDG_CHALLENGE_HTML), true);
  assert.equal(isDdgChallenge(200, '<div class="result">ok</div>'), false);
});

// ==================== 正文提取 ====================

test('htmlToStructuredText 不再让 head/style 吞掉正文（旧版跨标签正则 bug）', () => {
  const html = '<html><head><title>T</title><style>.a{color:red}</style>'
    + '<link rel="stylesheet" href="/a.css"><meta name="x" content="y"></head>'
    + '<body><h1>标题</h1><p>这是正文第一段。</p><p>这是正文第二段，长度足够。</p></body></html>';
  const text = htmlToStructuredText(html);
  assert.ok(text.indexOf('这是正文第一段') !== -1, '正文不能丢：' + text);
  assert.ok(text.indexOf('color:red') === -1);
  assert.ok(text.indexOf('标题') !== -1);
});

test('htmlToStructuredText 保留标题层级与代码块，剥离脚本', () => {
  const html = '<html><head><title>Doc</title></head><body>'
    + '<h2>安装</h2><p>执行下面命令：</p>'
    + '<pre><code>npm i foo</code></pre>'
    + '<script>var x = 1;</script></body></html>';
  const text = htmlToStructuredText(html);
  assert.ok(text.indexOf('## 安装') !== -1, text);
  assert.ok(text.indexOf('npm i foo') !== -1);
  assert.ok(text.indexOf('var x') === -1);
});

test('htmlToStructuredText 在正文过少时补 meta description', () => {
  const html = '<html><head><title>App</title>'
    + '<meta name="description" content="一个用来演示空壳页面兜底的描述文本，长度足够二十字。">'
    + '</head><body><div id="root"></div></body></html>';
  const text = htmlToStructuredText(html);
  assert.ok(text.indexOf('空壳页面兜底') !== -1, text);
});

test('extractEmbeddedContent 从 __NEXT_DATA__ 抽出自然语言文案', () => {
  const html = '<html><body><script id="__NEXT_DATA__" type="application/json">'
    + JSON.stringify({ props: { pageProps: { title: 'Edge Rendering 完全指南与实战示例', body: '这段文案藏在首屏 JSON 里，用来兜底空壳页面。' } } })
    + '</script></body></html>';
  const text = extractEmbeddedContent(html);
  assert.ok(text.indexOf('Edge Rendering 完全指南') !== -1, text);
  assert.ok(text.indexOf('兜底空壳页面') !== -1, text);
});

test('decodeBodyBytes 按 charset 解码 GBK 页面', () => {
  // 「中文」的 GBK 字节
  const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
  assert.equal(decodeBodyBytes(gbk, 'text/html; charset=gbk'), '中文');
  // 无响应头 charset 时按 <meta charset> 探测
  const meta = new Uint8Array([
    ...Buffer.from('<html><head><meta charset="gbk"></head><body>'),
    0xd6, 0xd0, 0xce, 0xc4,
    ...Buffer.from('</body></html>'),
  ]);
  const text = decodeBodyBytes(meta, 'text/html');
  assert.ok(text.indexOf('中文') !== -1, text);
});

test('stripReaderPreamble 去掉 Jina 的头部元信息', () => {
  const raw = 'Title: 示例\n\nURL Source: https://example.com\n\nMarkdown Content:\n# 正文\n内容';
  assert.equal(stripReaderPreamble(raw), '# 正文\n内容');
});

// ==================== 搜索：多后端回退 ====================

test('搜索：DuckDuckGo 返回 202 挑战页时切到可用后端，而不是报「无结果」', async () => {
  const { result } = await withFetch((url) => {
    if (url.indexOf('duckduckgo.com') !== -1) return new Response(DDG_CHALLENGE_HTML, { status: 202 });
    if (url.indexOf('search.brave.com') !== -1) return new Response(BRAVE_HTML, { status: 200 });
    return new Response('', { status: 404 });
  }, () => toolWebSearch('unique ddg blocked query', 3, false));

  assert.ok(result.indexOf('无结果') === -1, '不能把反爬说成无结果：' + result.slice(0, 120));
  assert.ok(result.indexOf('durable-objects') !== -1, result.slice(0, 200));
  assert.ok(result.indexOf('developers.cloudflare.com') !== -1);
});

test('搜索：DDG 挑战后进入冷却，后续请求不再打 DDG', async () => {
  const handler = (url) => {
    if (url.indexOf('duckduckgo.com') !== -1) return new Response(DDG_CHALLENGE_HTML, { status: 202 });
    if (url.indexOf('search.brave.com') !== -1) return new Response(BRAVE_HTML, { status: 200 });
    return new Response('', { status: 404 });
  };
  // 先热身一次，确保模块级冷却已生效（前面的用例可能已经触发）
  await withFetch(handler, () => toolWebSearch('unique cooldown warmup', 2, false));
  const { result, calls } = await withFetch(handler, () => toolWebSearch('unique cooldown query', 2, false));

  assert.equal(calls.some(u => u.indexOf('duckduckgo.com') !== -1), false, '冷却期内不应再请求 DDG');
  assert.ok(result.indexOf('durable-objects') !== -1, result.slice(0, 160));
});

test('搜索：全部后端被拦时给出可执行的失败文案（可被失败判定识别）', async () => {
  const { result } = await withFetch((url) => {
    if (url.indexOf('duckduckgo.com') !== -1) return new Response(DDG_CHALLENGE_HTML, { status: 202 });
    if (url.indexOf('search.brave.com') !== -1) return new Response('unusual traffic', { status: 429 });
    if (url.indexOf('bing.com') !== -1) return new Response('<html>captcha</html>', { status: 200 });
    return new Response('', { status: 404 });
  }, () => toolWebSearch('unique all blocked query', 3, false));

  assert.ok(result.indexOf('搜索失败') === 0, result);
  assert.equal(isToolFailureResult(result), true, '失败文案必须被 isToolFailureResult 识别');
  assert.ok(result.indexOf('web_fetch') !== -1, '应给出替代动作');
});

test('搜索：后端确实没有结果时保留「无结果」语义', async () => {
  const { result } = await withFetch((url) => {
    if (url.indexOf('duckduckgo.com') !== -1) return new Response('<div class="result"></div>', { status: 200 });
    if (url.indexOf('search.brave.com') !== -1) return new Response('<html><div id="results"></div></html>', { status: 200 });
    if (url.indexOf('bing.com') !== -1) return new Response('<ol id="b_results"></ol>', { status: 200 });
    return new Response('', { status: 404 });
  }, () => toolWebSearch('unique genuinely empty query', 3, false));

  assert.ok(result.indexOf('无结果') !== -1, result);
  assert.equal(isToolFailureResult(result), true);
});

// ==================== 抓取：三级回退 ====================

test('抓取：403 时用阅读器拿到正文，而不是直接失败', async () => {
  const target = 'https://blocked.example.com/only-reader';
  const { result } = await withFetch((url) => {
    if (url === target) return new Response('forbidden', { status: 403 });
    if (url.indexOf('r.jina.ai') !== -1) {
      return new Response('Title: X\n\nURL Source: ' + target + '\n\nMarkdown Content:\n# 阅读器正文\n'
        + '这是阅读器回退拿到的正文内容，长度足够通过阈值判断。', { status: 200 });
    }
    if (url.indexOf('archive.org/wayback/available') !== -1) {
      return new Response('{"archived_snapshots":{}}', { status: 200 });
    }
    return new Response('', { status: 404 });
  }, () => toolWebFetch(target, 0, 4000));

  assert.ok(result.indexOf('阅读器正文') !== -1, result);
  assert.equal(isToolFailureResult(result), false);
});

test('抓取：SPA 空壳页面用内联 JSON 兜底', async () => {
  const target = 'https://spa.example.com/app';
  const html = '<html><head><title>SPA</title></head><body><div id="root"></div>'
    + '<script id="__NEXT_DATA__" type="application/json">'
    + JSON.stringify({ pageProps: { text: '首屏文案在 JSON 里，服务端渲染时被抽出来当作兜底内容使用。' } })
    + '</script></body></html>';
  const { result } = await withFetch((url) => {
    if (url === target) return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response('', { status: 404 });
  }, () => toolWebFetch(target, 0, 4000));

  assert.ok(result.indexOf('首屏文案在 JSON 里') !== -1, result);
});

test('抓取：直连与阅读器都拿不到时用网页快照，并标注来源', async () => {
  const target = 'https://archived.example.com/page';
  const snapshot = '<html><body><article><h1>快照标题</h1><p>'
    + '这是 Wayback 快照里的正文内容，用来验证第三条回退链路是否生效，长度超过阈值。'
    + '</p></article></body></html>';
  const { result } = await withFetch((url) => {
    if (url === target) return new Response('forbidden', { status: 403 });
    if (url.indexOf('r.jina.ai') !== -1) return new Response('forbidden', { status: 403 });
    if (url.indexOf('archive.org/wayback/available') !== -1) {
      return new Response(JSON.stringify({
        archived_snapshots: { closest: { available: true, url: 'http://web.archive.org/web/20250101000000/https://archived.example.com/page', timestamp: '20250101000000' } }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.indexOf('web.archive.org') !== -1) return new Response(snapshot, { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response('', { status: 404 });
  }, () => toolWebFetch(target, 0, 4000));

  assert.ok(result.indexOf('快照标题') !== -1, result);
  assert.ok(result.indexOf('网页快照') !== -1, result);
});

test('抓取：彻底失败时说明原因与已尝试的手段，且命中失败负缓存', async () => {
  const target = 'https://dead.example.com/x';
  let hits = 0;
  const { result } = await withFetch((url) => {
    hits += 1;
    if (url === target) return new Response('forbidden', { status: 403 });
    if (url.indexOf('r.jina.ai') !== -1) return new Response('forbidden', { status: 403 });
    if (url.indexOf('archive.org/wayback/available') !== -1) return new Response('{"archived_snapshots":{}}', { status: 200 });
    return new Response('', { status: 404 });
  }, async () => {
    const first = await toolWebFetch(target, 0, 4000);
    const afterFirst = hits;
    const second = await toolWebFetch(target, 0, 4000);
    return { first, second, afterFirst, afterSecond: hits };
  });

  assert.ok(result.first.indexOf('抓取失败') === 0, result.first);
  assert.ok(result.first.indexOf('403') !== -1);
  assert.equal(result.second, result.first, '负缓存应返回同一结论');
  assert.equal(result.afterSecond, result.afterFirst, '负缓存命中后不应再发请求');
});

test('抓取：批量 URL 全部失败时聚合结果可被判定为失败', async () => {
  const { result } = await withFetch((url) => {
    if (url.indexOf('r.jina.ai') !== -1) return new Response('forbidden', { status: 403 });
    if (url.indexOf('archive.org/wayback/available') !== -1) return new Response('{"archived_snapshots":{}}', { status: 200 });
    return new Response('forbidden', { status: 403 });
  }, () => toolWebFetch('https://dead1.example.com/a, https://dead2.example.com/b', 0, 3000));

  assert.ok(result.indexOf('抓取失败') === 0, result.slice(0, 120));
  assert.equal(isToolFailureResult(result), true);
});

// ==================== 重定向逐跳校验（SSRF 防护） ====================
// 背景：早期实现只校验用户输入的初始 host，随后用 redirect:'follow' 让运行时自己跟，
// 于是一个公网 URL 返回 302 到 169.254.169.254 就能绕过全部防护。
// 现在统一走 safeFetch：手动跟、每跳都查、落地再复核。

test('safeFetch：正常 200 直接返回，且不额外发请求', async () => {
  const { result, calls } = await withFetch(
    () => new Response('hello', { status: 200, headers: { 'content-type': 'text/html' } }),
    () => safeFetch('https://ok.example.com/a', {})
  );
  assert.equal(result.res.status, 200);
  assert.equal(result.finalUrl, 'https://ok.example.com/a');
  assert.equal(calls.length, 1);
});

test('safeFetch：公网 302 到内网地址时拒绝跟随', async () => {
  const { result, calls } = await withFetch((url) => {
    if (url === 'https://evil.example.com/r') {
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
    }
    return new Response('leaked', { status: 200 });
  }, async () => {
    try {
      await safeFetch('https://evil.example.com/r', {});
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  assert.equal(result.ok, false, '不应成功');
  assert.ok(result.message.indexOf('禁止抓取') !== -1, result.message);
  // 关键：内网地址一次都不该被请求
  assert.equal(calls.filter((u) => u.indexOf('169.254.169.254') !== -1).length, 0);
});

test('safeFetch：公网 → 公网 302 正常跟随，落地 URL 为最终地址', async () => {
  const { result, calls } = await withFetch((url) => {
    if (url === 'https://a.example.com/1') {
      return new Response(null, { status: 301, headers: { location: 'https://b.example.com/2' } });
    }
    if (url === 'https://b.example.com/2') {
      return new Response(null, { status: 307, headers: { location: '/3' } });
    }
    return new Response('done', { status: 200 });
  }, () => safeFetch('https://a.example.com/1', {}));

  assert.equal(result.res.status, 200);
  assert.equal(result.finalUrl, 'https://b.example.com/3');
  assert.equal(calls.length, 3);
});

test('safeFetch：相对 Location 按当前地址解析，逐跳仍然校验', async () => {
  const { result } = await withFetch((url) => {
    if (url === 'https://a.example.com/x') {
      return new Response(null, { status: 302, headers: { location: '/y' } });
    }
    if (url === 'https://a.example.com/y') {
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8080/admin' } });
    }
    return new Response('should not reach', { status: 200 });
  }, async () => {
    try { await safeFetch('https://a.example.com/x', {}); return 'ok'; }
    catch (e) { return e.message; }
  });

  assert.ok(String(result).indexOf('禁止抓取') !== -1, String(result));
});

test('safeFetch：重定向超过上限时停止，不无限跟', async () => {
  const { result, calls } = await withFetch(
    (url) => new Response(null, { status: 302, headers: { location: url + '?n=1' } }),
    async () => {
      try { await safeFetch('https://loop.example.com/a', {}, 3); return 'ok'; }
      catch (e) { return e.message; }
    }
  );

  assert.ok(String(result).indexOf('重定向次数过多') !== -1, String(result));
  // 初始 + 3 跳 = 最多 4 次请求
  assert.ok(calls.length <= 4, '请求次数=' + calls.length);
});

test('safeFetch：缺少 Location 的 3xx 报错而不是当成成功', async () => {
  const { result } = await withFetch(
    () => new Response('', { status: 302 }),
    async () => {
      try { await safeFetch('https://a.example.com/n', {}); return 'ok'; }
      catch (e) { return e.message; }
    }
  );
  assert.ok(String(result).indexOf('缺少目标地址') !== -1, String(result));
});

test('toolWebFetch：跟随重定向后落到内网时整条抓取判失败', async () => {
  const { result, calls } = await withFetch((url) => {
    if (url === 'https://short.example.com/r') {
      return new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/secret' } });
    }
    if (url.indexOf('r.jina.ai') !== -1) return new Response('forbidden', { status: 403 });
    if (url.indexOf('archive.org/wayback/available') !== -1) return new Response('{"archived_snapshots":{}}', { status: 200 });
    return new Response('leaked', { status: 200 });
  }, () => toolWebFetch('https://short.example.com/r', 0, 3000));

  assert.ok(result.indexOf('禁止抓取') !== -1, result.slice(0, 160));
  assert.equal(calls.filter((u) => u.indexOf('10.0.0.5') !== -1).length, 0);
});
