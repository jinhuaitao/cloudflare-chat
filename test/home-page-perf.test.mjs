import test from 'node:test';
import assert from 'node:assert/strict';

import { HTML_CONTENT } from '../src/ui/index.js';
import { getHomePageHtml } from '../src/home-page.js';

function expectedHtml(options, version) {
  return HTML_CONTENT
    .replaceAll('{{MODEL_OPTIONS}}', options)
    .replaceAll('{{APP_VERSION}}', version);
}

test('首页缓存热命中复用同一 HTML 字符串且输出与原模板替换完全一致', () => {
  const options = '<option value="perf-cache-a">性能测试模型</option>';
  const version = 'home-cache-test-a';
  const first = getHomePageHtml(options, version);
  const second = getHomePageHtml(options, version);

  assert.equal(first, expectedHtml(options, version));
  assert.strictEqual(second, first, '相同配置应复用渲染结果而非重新扫描整页模板');
  assert.ok(!first.includes('{{MODEL_OPTIONS}}'));
  assert.ok(!first.includes('{{APP_VERSION}}'));
});

test('首页模型选项变化时重新生成页面，不返回旧模型配置', () => {
  const version = 'home-cache-test-b';
  const optionsA = '<option value="perf-cache-b1">模型甲</option>';
  const optionsB = '<option value="perf-cache-b2">模型乙</option>';
  const pageA = getHomePageHtml(optionsA, version);
  const pageB = getHomePageHtml(optionsB, version);

  assert.notStrictEqual(pageB, pageA);
  assert.equal(pageB, expectedHtml(optionsB, version));
  assert.ok(pageB.includes('perf-cache-b2'));
  assert.ok(!pageB.includes('perf-cache-b1'));
});

test('首页应用版本变化时重新生成页面', () => {
  const options = '<option value="perf-cache-c">版本测试模型</option>';
  const pageA = getHomePageHtml(options, 'home-cache-test-c1');
  const pageB = getHomePageHtml(options, 'home-cache-test-c2');

  assert.notStrictEqual(pageB, pageA);
  assert.equal(pageB, expectedHtml(options, 'home-cache-test-c2'));
  assert.ok(pageB.includes('vhome-cache-test-c2'));
});

test('首页 CDN 脚本非阻塞且按序 defer，Markdown 配置先于 DOMContentLoaded 初始化', () => {
  const page = expectedHtml('<option value="x">x</option>', 'defer-test');
  const marked = page.indexOf('<script defer src="https://cdn.jsdelivr.net/npm/marked@4.3.0/marked.min.js"></script>');
  const purifier = page.indexOf('<script defer src="https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js"></script>');
  const highlight = page.indexOf('<script defer src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js"></script>');
  assert.ok(marked >= 0 && purifier > marked && highlight > purifier, '依赖必须 defer 且保持 marked → DOMPurify → highlight.js 顺序');
  assert.ok(page.includes('document.addEventListener(\'DOMContentLoaded\', configureMarkdown, { once: true })'));
  assert.ok(page.includes('document.addEventListener(\'DOMContentLoaded\', startApp, { once: true })'));
  assert.ok(page.indexOf('configureMarkdown, { once: true }') < page.indexOf('startApp, { once: true }'),
    'Markdown renderer 初始化监听必须先于应用 init');
});

test('流式渲染增量追加文本，结束后仍执行唯一的完整 Markdown 渲染', () => {
  const page = expectedHtml('<option value="x">x</option>', 'stream-test');
  assert.ok(page.includes('streamTextNode.appendData(aiContent.slice(streamRenderedLength))'));
  assert.ok(page.includes('streamTextNode = document.createTextNode(\'\')'));
  assert.ok(page.includes('tBox.innerHTML = safeHtml(aiContent);'), '结束时仍应做一次完整且安全的 Markdown 渲染');
  assert.ok(page.includes('tBox.style.whiteSpace = \'pre-wrap\''), '纯文本流式阶段应保留换行');
});
