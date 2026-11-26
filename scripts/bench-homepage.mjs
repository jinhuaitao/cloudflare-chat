#!/usr/bin/env node
// 首页 HTML 生成基准：比较原先每次扫描整份模板与 isolate 缓存热命中。
// 用法：node scripts/bench-homepage.mjs；可用 BENCH_ROUNDS=5000 调整每轮次数。

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { APP_VERSION } from '../src/constants.js';
import { HTML_CONTENT } from '../src/ui/index.js';
import { getHomePageHtml } from '../src/home-page.js';

const options = '<option value="bench-model-a" selected>测试模型 A</option>'
  + '<option value="bench-model-b">测试模型 B</option>';
const rounds = Math.max(1, Number(process.env.BENCH_ROUNDS) || 3000);
const passes = 5;
const renderUncached = () => HTML_CONTENT
  .replaceAll('{{MODEL_OPTIONS}}', options)
  .replaceAll('{{APP_VERSION}}', APP_VERSION);

assert.equal(getHomePageHtml(options, APP_VERSION), renderUncached(), '缓存输出必须与原始渲染完全一致');
for (let i = 0; i < 100; i++) {
  renderUncached();
  getHomePageHtml(options, APP_VERSION);
}

const uncachedMs = [];
const cachedMs = [];
let checksum = 0;
for (let pass = 0; pass < passes; pass++) {
  const startUncached = performance.now();
  for (let i = 0; i < rounds; i++) checksum += renderUncached().length;
  uncachedMs.push(performance.now() - startUncached);

  const startCached = performance.now();
  for (let i = 0; i < rounds; i++) checksum += getHomePageHtml(options, APP_VERSION).length;
  cachedMs.push(performance.now() - startCached);
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const oldMedian = median(uncachedMs);
const newMedian = median(cachedMs);
console.log(JSON.stringify({
  templateChars: HTML_CONTENT.length,
  roundsPerPass: rounds,
  passes,
  uncachedMs: uncachedMs.map(n => +n.toFixed(2)),
  cachedMs: cachedMs.map(n => +n.toFixed(2)),
  medianSpeedup: +(oldMedian / Math.max(newMedian, 0.001)).toFixed(1),
  checksum,
}, null, 2));
