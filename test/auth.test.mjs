// 鉴权与限流回归测试（node --test）
//
// 这两个模块都很薄（auth 25 行、rate-limit 37 行），但都在安全边界上：
// auth 决定"谁能调 /api/chat"，rate-limit 决定"能被刷多快"。
// 薄不等于可以没有测试 —— 恰恰因为薄，任何一处改动都可能是全量行为变化。
//
// 全部离线，不碰网络。

import test from 'node:test';
import assert from 'node:assert/strict';

import { denyUnauthorized } from '../src/auth.js';
import { hitRateLimit } from '../src/rate-limit.js';
import { safeEqual } from '../src/utils.js';

const req = (headers) => new Request('https://x.test/api/chat', { headers: headers || {} });

// ==================== safeEqual ====================

test('safeEqual：相同字符串为真，长度不同为假', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual('', 'a'), false);
});

test('safeEqual：逐字符差异都能识别（含首字符与末字符）', () => {
  assert.equal(safeEqual('xbc', 'abc'), false);
  assert.equal(safeEqual('abx', 'abc'), false);
  assert.equal(safeEqual('abc', 'abd'), false);
});

test('safeEqual：非字符串输入直接判假，不抛错', () => {
  assert.equal(safeEqual(null, 'a'), false);
  assert.equal(safeEqual('a', undefined), false);
  assert.equal(safeEqual(123, '123'), false);
  assert.equal(safeEqual(null, null), false);
});

test('safeEqual：多字节字符按字节比较（中文口令）', () => {
  assert.equal(safeEqual('口令一二三', '口令一二三'), true);
  assert.equal(safeEqual('口令一二三', '口令一二四'), false);
});

// ==================== denyUnauthorized ====================

test('denyUnauthorized：未配置口令时放行（返回 null）', () => {
  assert.equal(denyUnauthorized({}, req()), null);
  assert.equal(denyUnauthorized({ ACCESS_PASSWORD: '' }, req()), null);
});

test('denyUnauthorized：口令正确时放行', () => {
  const env = { ACCESS_PASSWORD: 'secret-123' };
  assert.equal(denyUnauthorized(env, req({ 'X-Access-Token': 'secret-123' })), null);
});

test('denyUnauthorized：口令错误或缺头时返回 401 且带 CORS 头', async () => {
  const env = { ACCESS_PASSWORD: 'secret-123' };

  const missing = denyUnauthorized(env, req());
  assert.ok(missing, '缺少口令头应拒绝');
  assert.equal(missing.status, 401);
  assert.ok(missing.headers.get('Access-Control-Allow-Origin'), '401 也要带 CORS，否则前端读不到错误');
  const body = await missing.json();
  assert.equal(body.code, 'UNAUTHORIZED');

  const wrong = denyUnauthorized(env, req({ 'X-Access-Token': 'nope' }));
  assert.equal(wrong.status, 401);
});

test('denyUnauthorized：口令不做前后缀匹配（防止弱校验）', () => {
  const env = { ACCESS_PASSWORD: 'secret-123' };
  assert.equal(denyUnauthorized(env, req({ 'X-Access-Token': 'secret' })).status, 401);
  assert.equal(denyUnauthorized(env, req({ 'X-Access-Token': 'secret-1234' })).status, 401);
});

// ==================== hitRateLimit ====================
// 注意：rateLimitMap 是模块级 Map，同一进程内跨用例共享。
// 每个用例用不同 IP，避免互相污染。

test('hitRateLimit：未达阈值放行，达到阈值后拦截', () => {
  const env = { RATE_LIMIT_PER_MIN: '3' };
  const ip = '203.0.113.1';
  assert.equal(hitRateLimit(req({ 'CF-Connecting-IP': ip }), env), false);
  assert.equal(hitRateLimit(req({ 'CF-Connecting-IP': ip }), env), false);
  assert.equal(hitRateLimit(req({ 'CF-Connecting-IP': ip }), env), false);
  assert.equal(hitRateLimit(req({ 'CF-Connecting-IP': ip }), env), true, '第 4 次应被拦');
});

test('hitRateLimit：不同 IP 各自独立计数', () => {
  const env = { RATE_LIMIT_PER_MIN: '1' };
  assert.equal(hitRateLimit(req({ 'CF-Connecting-IP': '203.0.113.2' }), env), false);
  assert.equal(hitRateLimit(req({ 'CF-Connecting-IP': '203.0.113.2' }), env), true);
  // 换一个 IP 不应受影响
  assert.equal(hitRateLimit(req({ 'CF-Connecting-IP': '203.0.113.3' }), env), false);
});

test('hitRateLimit：RATE_LIMIT_PER_MIN=0 时完全关闭', () => {
  const env = { RATE_LIMIT_PER_MIN: '0' };
  const ip = '203.0.113.4';
  for (let i = 0; i < 50; i++) {
    assert.equal(hitRateLimit(req({ 'CF-Connecting-IP': ip }), env), false);
  }
});

test('hitRateLimit：未配置时默认 60/分钟（第 61 次才拦）', () => {
  const env = {};
  const ip = '203.0.113.5';
  for (let i = 0; i < 60; i++) {
    assert.equal(hitRateLimit(req({ 'CF-Connecting-IP': ip }), env), false, '第 ' + (i + 1) + ' 次');
  }
  assert.equal(hitRateLimit(req({ 'CF-Connecting-IP': ip }), env), true);
});

test('hitRateLimit：缺少 CF-Connecting-IP 时回退到 X-Forwarded-For 首段', () => {
  const env = { RATE_LIMIT_PER_MIN: '1' };
  const h = { 'X-Forwarded-For': '198.51.100.7, 10.0.0.1' };
  assert.equal(hitRateLimit(req(h), env), false);
  assert.equal(hitRateLimit(req(h), env), true, '同一首段 IP 应共享计数');
});

test('hitRateLimit：两个来源头都没有时归入 unknown 桶，不会崩', () => {
  const env = { RATE_LIMIT_PER_MIN: '1' };
  assert.equal(hitRateLimit(req(), env), false);
  assert.equal(hitRateLimit(req(), env), true);
});

test('hitRateLimit：非法配置值退回默认 60，而不是关闭限流', () => {
  const env = { RATE_LIMIT_PER_MIN: 'abc' };
  const ip = '203.0.113.6';
  let blocked = false;
  for (let i = 0; i < 61; i++) {
    if (hitRateLimit(req({ 'CF-Connecting-IP': ip }), env)) { blocked = true; break; }
  }
  assert.equal(blocked, true, '非法值不该变成"永不限流"');
});
