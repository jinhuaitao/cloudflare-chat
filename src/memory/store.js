// 三层记忆的统一存储层（v7.20.0）。
//
// 为什么合并成单对象 kb/mem3/<chatId>.json：
//   旧版 L1/L2/L3 各存一个 JSON，一轮冷启动要 3 次 GET（新用户还要串行探 2 个 L2 旧键），
//   而三层几乎总是被一起读（memoryLoad / memorySearchText / memoryStats）。
//   合并后稳态冷读只有 1 次 GET；每轮 L1 写入顺带把溢出沉淀、L2 淘汰归档、
//   命中计数（ltTouch）一起落盘——旧版这些是各自独立的 PUT，既有额外操作数，
//   也有「L1 写成功但归档写失败」的丢沉淀窗口。
//
// 并发安全：整对象读-改-写必须防跨 isolate 互相覆盖，所以写路径全部走
//   CAS（etag 条件写）：冲突就重读重算，最多 3 轮（与 kb/registry.js 同一套思路）。
//   mutator 必须是可重跑的纯逻辑（只依赖入参 draft 与闭包里的用户输入），
//   冲突重试时会在新快照上重新执行。
//
// 迁移：统一键缺失时一次性并行探测 5 个旧键（work/long/archive + 两代 L2 旧键），
//   读到就合并写入统一键；旧键保留不删（回滚副本）。探测结果按 chatId 记住，
//   没有历史数据的会话之后冷读只打 1 次 GET。
//
// 读失败 ≠ 没有数据：storeGetMeta 报 failed 时不缓存、不探旧键、更不允许
//   拿空快照去覆盖写（memMutate 会先重试回源，仍失败则如实返回 ok:false）。

import { mapSetBounded, mapGetBounded, singleFlight } from '../utils.js';
import { storeGet, storeGetMeta, storePutCas } from '../store/r2.js';
import { agentMemKey, agentMemKeyLegacy } from '../store/kb.js';
import { memKey, wmKey, ltKey, arKey, memSafeId, memCacheTtl } from './layers.js';

const memCache = new Map();
const memExp = new Map();
const MEM_CACHE_MAX = 500;
// 「这个 chatId 已确认没有旧键」：避免每次冷加载都白探 5 个旧键
const noLegacy = new Set();
const NO_LEGACY_MAX = 500;
const CAS_ROUNDS = 3;

function emptySnap() {
  return { work: { updatedAt: 0, items: [], pins: [] }, long: [], archive: { items: [] } };
}

// 结构归一化：只保证形状合法（字段级裁剪/去重由各层投影负责），
// 解析失败一律当空，绝不让一条坏数据拖垮整轮对话。
function normalizeSnap(obj) {
  const snap = emptySnap();
  if (!obj || typeof obj !== 'object') return snap;
  const w = obj.work;
  if (w && typeof w === 'object') {
    snap.work.updatedAt = Number(w.updatedAt) || 0;
    snap.work.items = Array.isArray(w.items) ? w.items.filter(x => x && typeof x === 'object') : [];
    snap.work.pins = Array.isArray(w.pins) ? w.pins.filter(x => x && typeof x === 'object') : [];
  }
  snap.long = Array.isArray(obj.long)
    ? obj.long.filter(m => m && typeof m === 'object' && typeof m.fact === 'string' && m.fact)
    : [];
  const a = obj.archive;
  if (a && typeof a === 'object' && Array.isArray(a.items)) {
    snap.archive.items = a.items.filter(x => x && typeof x === 'object');
  } else if (Array.isArray(a)) {
    snap.archive.items = a.filter(x => x && typeof x === 'object');
  }
  return snap;
}

function parseSnap(raw) {
  try { return normalizeSnap(JSON.parse(raw)); } catch (e) { return emptySnap(); }
}

function cloneSnap(s) {
  return {
    work: {
      updatedAt: s.work.updatedAt,
      items: s.work.items.map(x => ({ t: x.t, g: x.g, ts: x.ts })),
      pins: s.work.pins.map(x => ({ text: x.text, ts: x.ts }))
    },
    long: s.long.map(m => ({
      fact: m.fact, ts: m.ts, file: m.file, kind: m.kind,
      weight: m.weight, hits: m.hits, lastUsed: m.lastUsed
    })),
    archive: { items: s.archive.items.map(x => ({ type: x.type, text: x.text, ts: x.ts })) }
  };
}

function serialize(chatId, snap) {
  return JSON.stringify({ v: 2, chatId: memSafeId(chatId), work: snap.work, long: snap.long, archive: snap.archive });
}

function cacheEntry(env, chatId, entry) {
  mapSetBounded(memCache, chatId, entry, MEM_CACHE_MAX, memExp, memCacheTtl(env));
  return entry;
}

// 旧键迁移：5 个旧键并行探测（一次性），读到任何数据就合并写统一键。
// 旧键保留不删——体积很小，留作回滚副本（与旧版 L2 迁移同一保守策略）。
async function migrateLegacy(env, chatId) {
  const [wRaw, lRaw, aRaw, kbRaw, rootRaw] = await Promise.all([
    storeGet(env, wmKey(chatId)),
    storeGet(env, ltKey(chatId)),
    storeGet(env, arKey(chatId)),
    storeGet(env, agentMemKey(chatId)),
    storeGet(env, agentMemKeyLegacy(chatId))
  ]);
  const lFound = lRaw || kbRaw || rootRaw;
  if (!wRaw && !lFound && !aRaw) return null;

  const obj = { work: null, long: null, archive: null };
  if (wRaw) { try { obj.work = JSON.parse(wRaw); } catch (e) {} }
  if (lFound) { try { obj.long = JSON.parse(lFound); } catch (e) {} }
  if (aRaw) { try { obj.archive = JSON.parse(aRaw); } catch (e) {} }
  const snap = normalizeSnap(obj);
  const json = serialize(chatId, snap);
  const res = await storePutCas(env, memKey(chatId), json, '');
  // 写失败也交出内存快照：persistedJson 留空，下次写入会重试落盘
  return { snap, etag: res.etag || '', persistedJson: res.ok ? json : '', failed: false };
}

async function memLoad(env, chatId) {
  const cached = mapGetBounded(memCache, chatId, env && env.R2 ? memExp : null);
  if (cached) return cached;

  let entry = { snap: emptySnap(), etag: '', persistedJson: '', failed: false };
  if (env && env.R2) {
    const meta = await storeGetMeta(env, memKey(chatId));
    if (meta.failed) {
      // 读失败：不缓存、不探旧键，下次调用重试回源
      return { snap: emptySnap(), etag: '', persistedJson: '', failed: true };
    }
    if (meta.text) {
      const snap = parseSnap(meta.text);
      entry = { snap, etag: meta.etag, persistedJson: serialize(chatId, snap), failed: false };
    } else if (!noLegacy.has(chatId)) {
      const mig = await migrateLegacy(env, chatId);
      if (mig) {
        entry = mig;
      } else {
        if (noLegacy.size >= NO_LEGACY_MAX) noLegacy.clear();
        noLegacy.add(chatId);
      }
    }
  }
  return cacheEntry(env, chatId, entry);
}

function loadShared(env, chatId) {
  return singleFlight('mem3', chatId, () => memLoad(env, chatId), MEM_CACHE_MAX);
}

// 对外读：返回深拷贝，调用方就地修改不会污染共享快照
export async function memSnapshot(env, chatId) {
  const entry = await loadShared(env, chatId);
  return cloneSnap(entry.snap);
}

// 对外写：CAS 读-改-写。mutator(draft) 就地修改 draft；返回 false 表示放弃本次写入。
// 返回 { ok, persisted, unchanged, snap }：
//   ok        操作成功（含「内容没变跳过写入」与纯内存模式）
//   persisted 真的 PUT 进了 R2
//   unchanged 内容与上次落盘完全一致，省掉一次 A 类操作
// 写失败时内存缓存仍更新（本 isolate 后续轮次看得到最新数据），
// 但 persistedJson 不动——下次相同写入会重试落盘，不会假装已经存上。
export async function memMutate(env, chatId, mutator) {
  let entry = await loadShared(env, chatId);
  for (let round = 0; round < CAS_ROUNDS; round++) {
    if (entry.failed) {
      // 读失败后绝不允许拿空快照覆盖写：先重试回源
      const meta = env && env.R2 ? await storeGetMeta(env, memKey(chatId)) : null;
      if (!meta || meta.failed) {
        return { ok: false, persisted: false, unchanged: false, snap: cloneSnap(entry.snap) };
      }
      const snap = meta.text ? parseSnap(meta.text) : emptySnap();
      entry = { snap, etag: meta.etag, persistedJson: meta.text ? serialize(chatId, snap) : '', failed: false };
    }

    const draft = cloneSnap(entry.snap);
    if (mutator(draft) === false) {
      return { ok: true, persisted: false, unchanged: true, snap: cloneSnap(entry.snap) };
    }
    const json = serialize(chatId, draft);
    if (json === entry.persistedJson) {
      cacheEntry(env, chatId, entry);
      return { ok: true, persisted: false, unchanged: true, snap: draft };
    }

    if (!env || !env.R2) {
      cacheEntry(env, chatId, { snap: draft, etag: '', persistedJson: '', failed: false });
      return { ok: true, persisted: false, unchanged: false, snap: draft };
    }

    const res = await storePutCas(env, memKey(chatId), json, entry.etag);
    if (res.ok) {
      cacheEntry(env, chatId, { snap: draft, etag: res.etag || entry.etag, persistedJson: json, failed: false });
      return { ok: true, persisted: true, unchanged: false, snap: draft };
    }
    if (res.conflict) {
      // 别的实例先改了：重读最新快照，在新基线上重跑 mutator
      const meta = await storeGetMeta(env, memKey(chatId));
      if (meta.failed) {
        return { ok: false, persisted: false, unchanged: false, snap: cloneSnap(entry.snap) };
      }
      const snap = meta.text ? parseSnap(meta.text) : emptySnap();
      entry = { snap, etag: meta.etag, persistedJson: meta.text ? serialize(chatId, snap) : '', failed: false };
      continue;
    }
    cacheEntry(env, chatId, { snap: draft, etag: entry.etag, persistedJson: entry.persistedJson, failed: false });
    return { ok: false, persisted: false, unchanged: false, snap: draft };
  }
  return { ok: false, persisted: false, unchanged: false, conflict: true, snap: cloneSnap(entry.snap) };
}

// 只改内存缓存、不落盘的高频小改动（L2 命中计数）。
// 合并单对象后这些改动会搭下一次真实写入（每轮 L1）免费落盘。
export function memTouchCached(env, chatId, apply) {
  const entry = mapGetBounded(memCache, chatId, env && env.R2 ? memExp : null);
  if (!entry || entry.failed) return false;
  apply(entry.snap);
  cacheEntry(env, chatId, entry);
  return true;
}