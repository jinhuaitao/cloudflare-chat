#!/usr/bin/env node
// R2 路径基准：把「一轮对话 / 一次入库 / 一次翻页」的 R2 操作数与墙钟时间打出来。
//
// 为什么需要它：R2 的延迟是这类项目最大的固定成本，但它不出现在任何功能测试里。
// 单元测试只能断言"打了几次"，看不出"串行还是并行"——同样是 4 次操作，
// 并行是 1 个 RTT，串行是 4 个 RTT，差 3 倍。
//
// 用法：
//   node scripts/bench-r2.mjs                 # 默认按同区域 30ms RTT 估算
//   node scripts/bench-r2.mjs --rtt=120       # 跨区域（未选 apac 建桶时的典型值）
//   node scripts/bench-r2.mjs --json          # 输出 JSON，便于对比两次改动
//
// 说明：这里用内存桶 + 固定 sleep 模拟 R2，测的是**调用编排**（并行度、操作数），
// 不是 R2 真实吞吐。操作数一比一可信；时间只用于横向对比同一台机器上的两次运行。
// 冷读用 setup 桶的对象快照创建新桶，避免 setup 的写后读污染 L1 缓存；同时记录模拟字节数。

import { setTimeout as sleep } from 'node:timers/promises';

import { memoryLoad } from '../src/memory/index.js';
import { kbGetRegistry, kbSaveRegistry } from '../src/kb/registry.js';
import { toolSaveDoc, toolReadDoc, kbSearchDocBody } from '../src/kb/doc-tools.js';
import { agentGetPersona, agentGetMode } from '../src/agent/mode.js';
import { tgGetHistory, tgSaveHistory } from '../src/tg-history.js';
import { memoryRecordTurn } from '../src/memory/index.js';
import { r2ResetStats, r2Snapshot, storeGet } from '../src/store/r2.js';

const argRtt = process.argv.find(a => a.startsWith('--rtt='));
const RTT_MS = argRtt ? Math.max(0, Number(argRtt.split('=')[1]) || 0) : 30;
const AS_JSON = process.argv.includes('--json');

// 带 etag / onlyIf / range / 延迟模拟的内存桶
function makeBucket() {
  const data = new Map();
  const etags = new Map();
  const stats = { get: 0, put: 0, list: 0, del: 0, range: 0, bytesRead: 0 };
  let seq = 0;
  const enc = new TextEncoder();
  const bytesOf = (s) => enc.encode(String(s)).byteLength;
  const bump = (k) => { seq += 1; etags.set(k, 'e' + seq); return etags.get(k); };
  // R2「忙碌时长」：至少有一个请求在飞的时间并集。
  // 这是比墙钟更准的指标——预取把 R2 等待藏进网络往返时，墙钟不变但忙碌时长会掉下来。
  const busy = { inflight: 0, startedAt: 0, total: 0 };
  const tick = async () => {
    busy.inflight += 1;
    if (busy.inflight === 1) busy.startedAt = performance.now();
    try {
      if (RTT_MS > 0) await sleep(RTT_MS);
    } finally {
      busy.inflight -= 1;
      if (busy.inflight === 0) busy.total += performance.now() - busy.startedAt;
    }
  };

  return {
    stats,
    data,
    busy,
    async get(key, opts) {
      stats.get += 1;
      await tick();
      if (!data.has(key)) return null;
      const full = String(data.get(key));
      const etag = etags.get(key);
      if (opts && opts.onlyIf && opts.onlyIf.etagMatches && opts.onlyIf.etagMatches !== etag) return null;
      let text = full;
      let size = bytesOf(full);
      if (opts && opts.range) {
        stats.range += 1;
        const buf = enc.encode(full);
        const off = Math.max(0, opts.range.offset || 0);
        const len = opts.range.length == null ? buf.length - off : opts.range.length;
        const end = Math.min(buf.length, off + len);
        text = new TextDecoder().decode(buf.subarray(off, end));
        stats.bytesRead += Math.max(0, end - off);
        size = buf.length;
      } else {
        stats.bytesRead += bytesOf(full);
      }
      return { key, size, etag, text: async () => text, arrayBuffer: async () => enc.encode(text).buffer };
    },
    async put(key, value, opts) {
      stats.put += 1;
      await tick();
      if (opts && opts.onlyIf && opts.onlyIf.etagMatches && etags.get(key) !== opts.onlyIf.etagMatches) return null;
      data.set(key, String(value));
      return { key, etag: bump(key) };
    },
    async delete(key) {
      stats.del += 1;
      await tick();
      if (Array.isArray(key)) key.forEach(k => { data.delete(k); etags.delete(k); });
      else { data.delete(key); etags.delete(key); }
    },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      stats.list += 1;
      await tick();
      const keys = [...data.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      return {
        objects: page.map(k => ({ key: k, size: bytesOf(data.get(k)) })),
        truncated: start + limit < keys.length,
        cursor: start + limit < keys.length ? String(start + limit) : undefined,
      };
    },
  };
}

const results = [];

function cloneBucket(source) {
  const clone = makeBucket();
  for (const [key, value] of source.data) clone.data.set(key, value);
  return clone;
}
function resetBucketStats(bucket) {
  for (const key of Object.keys(bucket.stats)) bucket.stats[key] = 0;
}

// 一个场景 = 新桶 + 新 chatId（模块内缓存按 chatId / 桶隔离，避免互相污染）
// setup 阶段的耗时与操作数不计入结果：只量被测的那段路径。
async function scenario(name, setup, run, options) {
  const source = makeBucket();
  const setupEnv = { R2: source };
  if (setup) await setup(setupEnv, source);
  const r2 = options && options.coldClone ? cloneBucket(source) : source;
  const env = { R2: r2 };
  resetBucketStats(r2);
  r2ResetStats();
  r2.busy.total = 0;
  const t0 = performance.now();
  const extra = (await run(env, r2)) || {};
  const wall = performance.now() - t0;
  const busy = r2.busy.total;
  const s = r2Snapshot();
  results.push({
    name,
    ops: s.get + s.put + s.del,
    get: s.get,
    put: s.put,
    del: s.del,
    wall: Math.round(wall),
    busy: Math.round(busy),
    range: r2.stats.range,
    bytesRead: r2.stats.bytesRead,
    // R2 关键路径：忙碌时长 / 单次往返。1.0 = 完全并行，数字越大串行越严重
    rtts: RTT_MS > 0 ? +(busy / RTT_MS).toFixed(1) : null,
    note: extra.note || '',
  });
}

// 造一篇 20 万字文档（中文按 3 字节/字，约 600KB）
function bigDoc(chars) {
  const unit = '知识库性能测试段落，用于模拟长文档的翻页与检索行为。';
  let s = '';
  while (s.length < chars) s += unit;
  return s.slice(0, chars);
}

async function main() {
  const newChat = () => 'bench-' + Math.random().toString(36).slice(2, 8);

  // 1) 首次部署：桶里什么都没有，注册表要靠 list 自愈出来（一次性成本）
  await scenario('冷启动一轮（首次部署，注册表缺失）', null, async (env) => {
    const chatId = newChat();
    await Promise.all([
      memoryLoad(env, chatId, '你好'),
      kbGetRegistry(env),
      agentGetPersona(env, chatId),
    ]);
  });

  // 2) 稳态冷启动：注册表已存在，这是新 isolate 上的常态
  await scenario('冷启动一轮（稳态，注册表已存在）',
    (env) => kbGetRegistry(env),
    async (env) => {
      const chatId = newChat();
      await Promise.all([
        memoryLoad(env, chatId, '你好'),
        kbGetRegistry(env),
        agentGetPersona(env, chatId),
      ]);
    });

  // 3) 真实主链路：handler 第一批（模型 + 开关 + 历史）→ 两条 Telegram 网络往返
  //    → Agent 第二批（记忆 + 注册表 + 人格）。两个场景都含这两条网络往返，才可比。
  const telegramGap = () => (RTT_MS > 0 ? sleep(RTT_MS * 2) : Promise.resolve());

  await scenario('主链路（未预取：网络等完才读第二批）',
    (env) => kbGetRegistry(env),
    async (env) => {
      const chatId = newChat();
      await Promise.all([
        storeGet(env, 'tg_user_' + chatId),
        agentGetMode(env, chatId),
        tgGetHistory(env, chatId),
      ]);
      await telegramGap();
      await Promise.all([
        memoryLoad(env, chatId, '你好'),
        kbGetRegistry(env),
        agentGetPersona(env, chatId),
      ]);
    });

  // 3b) 同一条链路，但第二批在发占位消息之前就预取，被两条 Telegram 网络往返覆盖
  await scenario('主链路（预取：第二批被网络往返覆盖）',
    (env) => kbGetRegistry(env),
    async (env) => {
      const chatId = newChat();
      await Promise.all([
        storeGet(env, 'tg_user_' + chatId),
        agentGetMode(env, chatId),
        tgGetHistory(env, chatId),
      ]);
      const pre = Promise.all([
        memoryLoad(env, chatId, '你好'),
        kbGetRegistry(env),
        agentGetPersona(env, chatId),
      ]);
      await telegramGap();
      await pre;
    });

  // 4) 热轮次：同一 chatId 再来一轮，全部命中 isolate 缓存
  const warmChat = newChat();
  const warmRound = (env) => Promise.all([
    memoryLoad(env, warmChat, '你好'),
    kbGetRegistry(env),
    agentGetPersona(env, warmChat),
  ]);
  await scenario('热轮次（同 isolate 缓存命中）', warmRound, warmRound);

  // 5) 新建文档
  await scenario('保存文档（新建）', null, async (env) => {
    await toolSaveDoc(env, 'bench', { title: '基准文档', content: bigDoc(3000) });
  });

  // 6) 覆盖文档（含快照）
  await scenario('保存文档（覆盖+快照）',
    (env) => toolSaveDoc(env, 'bench', { title: '基准文档', content: bigDoc(3000) }),
    (env) => toolSaveDoc(env, 'bench', { title: '基准文档', content: bigDoc(3200) }));

  // 7) 大文档冷读 A/B：同一份 setup 文档克隆成独立新桶，避免保存时 L1 穿透缓存污染。
  const setupLongDoc = (env) => toolSaveDoc(env, 'bench', { title: '长文档', content: bigDoc(200000) });
  await scenario('大文档冷翻页（整篇回退，无 seek）', async (env, r2) => {
    await setupLongDoc(env);
    const reg = JSON.parse(r2.data.get('kb/docs/registry.json'));
    delete reg[0].seek;
    delete reg[0].bodyOffsetChars;
    delete reg[0].bodyOffsetBytes;
    r2.data.set('kb/docs/registry.json', JSON.stringify(reg));
  }, (env) => toolReadDoc(env, { query: '长文档', offset: 100000 }), { coldClone: true });
  await scenario('大文档冷翻页（UTF-8 检查点 Range）', setupLongDoc,
    (env) => toolReadDoc(env, { query: '长文档', offset: 100000 }), { coldClone: true });

  // 8) 全库检索
  let regForSearch = [];
  await scenario('全库正文检索（3 篇 × 2 万字）',
    async (env) => {
      for (let i = 0; i < 3; i++) {
        await toolSaveDoc(env, 'bench', { title: '检索文档' + i, content: bigDoc(20000) });
      }
      regForSearch = await kbGetRegistry(env, { fresh: true });
    },
    (env) => kbSearchDocBody(env, regForSearch, '性能测试段落'), { coldClone: true });

  // 9) 回合收尾写 L1
  const l1Chat = newChat();
  await scenario('回合收尾写 L1 工作记忆',
    (env) => memoryLoad(env, l1Chat, '你好'),
    (env) => memoryRecordTurn(env, l1Chat, '帮我写个排序算法', '好的，下面是快速排序的实现思路……'));

  print();
}

function print() {
  if (AS_JSON) {
    console.log(JSON.stringify({ rtt: RTT_MS, results }, null, 2));
    return;
  }
  const pad = (s, n) => String(s).padEnd(n);
  const lpad = (s, n) => String(s).padStart(n);
  console.log('');
  console.log('R2 路径基准（模拟 RTT = ' + RTT_MS + 'ms）');
  console.log('─'.repeat(108));
  console.log(pad('场景', 44) + lpad('操作', 5) + lpad('读', 4) + lpad('写', 4) + lpad('Range', 7)
    + lpad('读字节', 10) + lpad('R2忙碌', 8) + lpad('RTT', 6) + lpad('墙钟', 8));
  console.log('─'.repeat(108));
  for (const r of results) {
    console.log(pad(r.name, 44) + lpad(r.ops, 5) + lpad(r.get, 4) + lpad(r.put, 4) + lpad(r.range, 7)
      + lpad((r.bytesRead / 1024).toFixed(1) + 'KB', 10)
      + lpad(r.busy + 'ms', 8) + lpad(r.rtts == null ? '-' : r.rtts, 6) + lpad(r.wall + 'ms', 8));
  }
  console.log('─'.repeat(108));
  console.log('「RTT」= R2 忙碌时长 / 单次往返：1.0 表示完全并行（理想），越大说明串行越严重。');
  console.log('「R2忙碌」只统计"至少一个 R2 请求在飞"的时间，所以把等待藏进网络往返里的预取能被看出来。');
  console.log('');
}

main().catch((e) => { console.error(e); process.exit(1); });
