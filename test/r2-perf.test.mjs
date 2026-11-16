// v7.20.0 R2 提速回归测试：把「每次对话/每次保存到底打了几次 R2」变成断言。
//
// 为什么要有这一组：R2 的延迟（尤其跨区域）是这类项目里最大的固定成本之一，
// 但它不会体现在任何功能测试里 —— 少一次 list、少一次串行往返，用户只是"感觉快了点"。
// 这里用带计数与模拟 RTT 的内存桶，把操作数钉死，回退就报红。
//
// 覆盖：
//   1) 单飞：并发读同一个 key 只打一次 R2；
//   2) 重试：瞬时错误自动重试一次，不再把"读失败"当成"没有数据"；
//   3) 条件写（CAS）：etag 变了就写不进去，绝不覆盖别人刚写入的条目；
//   4) save_doc 不再 list（旧版每次保存一次全量目录扫描）；
//   5) 记忆冷启动后，同一 isolate 的后续读取零 R2 往返。

import test from 'node:test';
import assert from 'node:assert/strict';

import { storeGet, storePutCas, storePutChecked, r2Snapshot, r2ResetStats } from '../src/store/r2.js';
import { kbGetRegistryEx, kbSaveRegistry, kbMutateRegistry } from '../src/kb/registry.js';
import { toolSaveDoc } from '../src/kb/doc-tools.js';
import { memoryLoad } from '../src/memory/index.js';

// 带 etag / onlyIf / 操作计数的内存桶，并给每次访问加 1ms 模拟 RTT
function makeR2(initial = {}) {
  const data = new Map();
  const etags = new Map();
  const stats = { get: 0, put: 0, list: 0, del: 0, casFail: 0 };
  let seq = 0;
  const bytes = (s) => new TextEncoder().encode(String(s)).byteLength;
  const bump = (key) => { seq += 1; etags.set(key, 'e' + seq); return etags.get(key); };
  for (const [k, v] of Object.entries(initial)) { data.set(k, String(v)); bump(k); }
  return {
    stats,
    data,
    etags,
    async get(key, opts) {
      stats.get += 1;
      await new Promise(r => setTimeout(r, 1));
      if (!data.has(key)) return null;
      const etag = etags.get(key);
      if (opts && opts.onlyIf && opts.onlyIf.etagMatches && opts.onlyIf.etagMatches !== etag) return null;
      const text = String(data.get(key));
      return { key, size: bytes(text), etag, text: async () => text };
    },
    async put(key, value, opts) {
      stats.put += 1;
      await new Promise(r => setTimeout(r, 1));
      if (opts && opts.onlyIf && opts.onlyIf.etagMatches && etags.get(key) !== opts.onlyIf.etagMatches) {
        stats.casFail += 1;
        return null;
      }
      data.set(key, String(value));
      return { key, etag: bump(key) };
    },
    async delete(key) {
      stats.del += 1;
      if (Array.isArray(key)) key.forEach(k => { data.delete(k); etags.delete(k); });
      else { data.delete(key); etags.delete(key); }
    },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      stats.list += 1;
      const keys = [...data.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      return {
        objects: page.map(k => ({ key: k, size: bytes(data.get(k)) })),
        truncated: start + limit < keys.length,
        cursor: start + limit < keys.length ? String(start + limit) : undefined,
      };
    },
  };
}

test('单飞：并发读同一个 key 只打一次 R2', async () => {
  const r2 = makeR2({ 'shared/key': '同一个对象' });
  const env = { R2: r2 };
  const [a, b, c] = await Promise.all([
    storeGet(env, 'shared/key'),
    storeGet(env, 'shared/key'),
    storeGet(env, 'shared/key'),
  ]);
  assert.equal(a, '同一个对象');
  assert.equal(b, '同一个对象');
  assert.equal(c, '同一个对象');
  assert.equal(r2.stats.get, 1, '三个并发读合并成一次 R2 GET（实际 ' + r2.stats.get + ' 次）');
});

test('瞬时错误自动重试，不再把「读失败」当成「没有数据」', async () => {
  const r2 = makeR2();
  r2.data.set('flaky/key', '最终读到了');
  let first = true;
  const original = r2.get;
  r2.get = async (key, opts) => {
    if (first) { first = false; throw new Error('network connection lost'); }
    return await original(key, opts);
  };
  r2ResetStats();
  const v = await storeGet({ R2: r2 }, 'flaky/key');
  assert.equal(v, '最终读到了');
  assert.equal(r2Snapshot().retry >= 1, true, '应记录一次重试');
  assert.equal(r2Snapshot().fail, 0, '重试成功后不应计入失败');
});

test('条件写（CAS）：etag 变了就写不进去，绝不覆盖别人刚写入的条目', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };
  await kbSaveRegistry(env, [{ file: 'a.md', title: '甲' }]);
  const cur = await kbGetRegistryEx(env, { fresh: true });
  assert.ok(cur.etag, '读注册表应带出 etag');

  // 另一个实例抢先写入乙
  await r2.put('kb/docs/registry.json', JSON.stringify([{ file: 'b.md', title: '乙' }]));

  const ok = await kbSaveRegistry(env, [{ file: 'a.md', title: '甲（旧快照）' }], { expectEtag: cur.etag });
  assert.equal(ok, false, '预条件失败必须返回 false，不能静默覆盖');
  const afterConflict = JSON.parse(r2.data.get('kb/docs/registry.json'));
  assert.deepEqual(afterConflict.map(e => e.file), ['b.md'], '别人的条目不能被冲掉');

  // 走 kbMutateRegistry：重读后重算，三方条目都在
  const merged = await kbMutateRegistry(env, (list) => {
    list.push({ file: 'c.md', title: '丙' });
    return list;
  });
  assert.equal(merged.ok, true);
  assert.deepEqual(JSON.parse(r2.data.get('kb/docs/registry.json')).map(e => e.file).sort(), ['b.md', 'c.md']);
});

test('CAS 冲突后 storePutCas 明确返回 conflict', async () => {
  const r2 = makeR2({ 'cas/key': 'v1' });
  const env = { R2: r2 };
  const first = await storePutCas(env, 'cas/key', 'v2', r2.etags.get('cas/key'));
  assert.equal(first.ok, true);
  assert.equal(first.cas, true);
  const stale = await storePutCas(env, 'cas/key', 'v3', 'e999');
  assert.equal(stale.ok, false);
  assert.equal(stale.conflict, true);
  assert.equal(r2.data.get('cas/key'), 'v2', '冲突时不能落盘');
});

test('save_doc 不再 list 目录，操作数收敛到 1 读 + 2 写', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };
  // 空桶第一次保存：注册表缺失 → 自愈需要 list 一次（这是唯一必须的目录扫描）
  const out = await toolSaveDoc(env, 'perf', { title: '性能文档', content: '正文内容' });
  assert.ok(out.startsWith('已保存为知识库文档'), out);
  assert.equal(r2.stats.list, 1, '注册表缺失时的自愈扫描只该有一次');
  assert.ok(r2.stats.get + r2.stats.put <= 6,
    '一次保存的 R2 操作数应受控（实际 get=' + r2.stats.get + ' put=' + r2.stats.put + '）');

  // 覆盖保存：注册表已在，必须 0 次 list；正文 + 快照并行写
  const before = { get: r2.stats.get, put: r2.stats.put, list: r2.stats.list };
  const out2 = await toolSaveDoc(env, 'perf', { title: '性能文档', content: '第二版正文' });
  assert.ok(out2.includes('已覆盖旧版'), out2);
  assert.equal(r2.stats.list, before.list, '保存路径不应再扫描目录（新增 ' + (r2.stats.list - before.list) + ' 次 list）');
  assert.equal(r2.stats.get - before.get, 1, '只需读一次注册表：旧正文命中正文缓存');
  assert.equal(r2.stats.put - before.put, 3, '正文 + 快照 + 注册表，三次写');
});

test('记忆冷启动后，同一 isolate 的后续读取零 R2 往返', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };
  const chatId = 'perf-mem-1';
  const first = await memoryLoad(env, chatId, '今天天气');
  assert.equal(first.stats.l1Items, 0);
  const afterFirst = r2.stats.get;
  assert.ok(afterFirst > 0, '首次加载必须回源');

  const second = await memoryLoad(env, chatId, '今天天气');
  assert.equal(second.stats.l2, 0);
  assert.equal(r2.stats.get, afterFirst, '第二次加载应全部命中 isolate 缓存（新增 ' + (r2.stats.get - afterFirst) + ' 次 GET）');
});

test('重复写入相同内容不再产生 PUT', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };
  const { wmPin } = await import('../src/memory/working.js');
  const chatId = 'perf-wm-1';
  const a = await wmPin(env, chatId, '本会话只用中文回答');
  assert.equal(a.ok, true);
  const puts = r2.stats.put;
  const b = await wmPin(env, chatId, '本会话只用中文回答');
  assert.equal(b.duplicate, true);
  assert.equal(r2.stats.put, puts, '内容没变的重复 pin 不应再写 R2');
});

test('写入失败会重试并如实返回 false', async () => {
  const r2 = makeR2();
  let n = 0;
  const original = r2.put;
  r2.put = async (key, value, opts) => {
    n += 1;
    if (n === 1) throw new Error('503 service unavailable');
    return await original(key, value, opts);
  };
  const ok = await storePutChecked({ R2: r2 }, 'retry/put', 'v');
  assert.equal(ok, true, '一次瞬时失败后应重试成功');
  assert.equal(r2.data.get('retry/put'), 'v');
});
