// L3 归档记忆：L1 溢出的会话要点 + L2 淘汰的长期事实，统一沉淀到这里并可检索。
//
// 设计取舍：
// 1) 不复用 kb/docs 注册表。文档是用户主动保存的"资产"，归档是系统自动产生的
//    "沉淀"——混在一起会让 list_docs 越用越脏，用户找不到自己存的东西。
// 2) 每个 chatId 一个 JSON 文件，上限 400 条。归档本身允许丢最旧的，
//    它存在的意义是"比彻底消失好"，不是"永久全量"。
// 3) 与 L1/L2 一样带 60 秒内存缓存，写入穿透更新。

import { mapSetBounded, mapGetBounded } from '../utils.js';
import { storeGet, storePutChecked, storeDelete } from '../store/r2.js';
import { arKey, AR_MAX_ITEMS, AR_TEXT_MAX, clipText, memTokens, memNorm, memLimits } from './layers.js';

const arCache = new Map();
const arExp = new Map();
const AR_CACHE_TTL_MS = 60 * 1000;
const AR_CACHE_MAX = 500;

function emptyArchive(chatId) {
  return { v: 1, chatId: String(chatId == null ? '' : chatId), items: [] };
}

function normalizeRecord(x) {
  if (!x || typeof x !== 'object') return null;
  const text = clipText(String(x.text == null ? '' : x.text).replace(/\s+/g, ' ').trim(), AR_TEXT_MAX);
  if (!text) return null;
  return {
    type: x.type === 'memory' ? 'memory' : 'session',
    text,
    ts: Number(x.ts) || 0
  };
}

function normalizeArchive(raw, chatId, maxItems) {
  const out = emptyArchive(chatId);
  const cap = maxItems > 0 ? maxItems : AR_MAX_ITEMS;
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : []);
  for (const x of list) {
    const r = normalizeRecord(x);
    if (r) out.items.push(r);
  }
  if (out.items.length > cap) out.items = out.items.slice(out.items.length - cap);
  return out;
}

function cloneArchive(a) {
  return { v: a.v, chatId: a.chatId, items: a.items.map(x => ({ type: x.type, text: x.text, ts: x.ts })) };
}

async function arPut(env, chatId, obj) {
  mapSetBounded(arCache, chatId, cloneArchive(obj), AR_CACHE_MAX, arExp, AR_CACHE_TTL_MS);
  if (!env || !env.R2) return false;
  return await storePutChecked(env, arKey(chatId), JSON.stringify(obj));
}

export async function arGet(env, chatId) {
  const cached = mapGetBounded(arCache, chatId, env && env.R2 ? arExp : null);
  if (cached) return cloneArchive(cached);
  let obj = emptyArchive(chatId);
  if (env && env.R2) {
    const raw = await storeGet(env, arKey(chatId));
    if (raw) {
      try { obj = normalizeArchive(JSON.parse(raw), chatId, memLimits(env).l3); } catch (e) { obj = emptyArchive(chatId); }
    }
  }
  mapSetBounded(arCache, chatId, cloneArchive(obj), AR_CACHE_MAX, arExp, AR_CACHE_TTL_MS);
  return cloneArchive(obj);
}

// 追加归档。相同内容只保留最新一条（会话反复聊同一件事时不会堆 20 份）。
export async function arPush(env, chatId, records) {
  const list = Array.isArray(records) ? records : [];
  const recs = list.map(normalizeRecord).filter(Boolean);
  if (!recs.length) return { added: 0, total: 0 };
  const ar = await arGet(env, chatId);
  for (const r of recs) {
    const n = memNorm(r.text);
    const idx = ar.items.findIndex(x => memNorm(x.text) === n);
    if (idx !== -1) ar.items.splice(idx, 1);
    ar.items.push(r);
  }
  const cap = memLimits(env).l3;
  if (ar.items.length > cap) ar.items = ar.items.slice(ar.items.length - cap);
  const ok = await arPut(env, chatId, ar);
  return { added: recs.length, total: ar.items.length, persisted: ok };
}

// 归档检索：2-gram 词面命中数打分，只返回最相关的几条（归档只做"想起来"的钩子，
// 不做全文精读，真正的精读交给 read_doc / memory search 的结果引导）。
export function rankArchive(items, query, limit) {
  const qTokens = [...new Set(memTokens(query))].filter(t => t.length >= 2);
  if (!qTokens.length || !Array.isArray(items) || !items.length) return [];
  const scored = [];
  for (const it of items) {
    const lower = String(it.text || '').toLowerCase();
    let score = 0;
    let hitLong = 0;
    for (const t of qTokens) {
      if (lower.indexOf(t) !== -1) { score += t.length; hitLong += 1; }
    }
    if (!hitLong) continue;
    // 越新越靠前，但只作为同分时的次序，不压过命中强度
    scored.push({ it, score, ts: it.ts || 0 });
  }
  scored.sort((a, b) => (b.score - a.score) || (b.ts - a.ts));
  return scored.slice(0, limit > 0 ? limit : 3).map(s => s.it);
}

export async function arSearch(env, chatId, query, limit) {
  const ar = await arGet(env, chatId);
  return rankArchive(ar.items, query, limit);
}

export async function arClear(env, chatId) {
  arCache.delete(chatId);
  arExp.delete(chatId);
  if (env && env.R2) {
    try { await storeDelete(env, arKey(chatId)); } catch (e) {}
  }
}

export { AR_MAX_ITEMS };
