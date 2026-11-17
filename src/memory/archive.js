// L3 归档记忆：L1 溢出的会话要点 + L2 淘汰的长期事实，统一沉淀到这里并可检索。
//
// 设计取舍：
// 1) 不复用 kb/docs 注册表。文档是用户主动保存的"资产"，归档是系统自动产生的
//    "沉淀"——混在一起会让 list_docs 越用越脏，用户找不到自己存的东西。
// 2) 上限 400 条。归档本身允许丢最旧的，它存在的意义是"比彻底消失好"，不是"永久全量"。
// 3) v7.20.0 起与 L1/L2 同存于 kb/mem3/<chatId>.json 单对象（store.js 统一 CAS 读写）：
//    L1 溢出 / L2 淘汰的沉淀并入同一次写入，不再有「主写成功、归档写失败」的丢沉淀窗口。

import { memSnapshot, memMutate } from './store.js';
import { AR_MAX_ITEMS, AR_TEXT_MAX, clipText, memTokens, memNorm, memLimits } from './layers.js';

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
  const out = { v: 1, chatId: String(chatId == null ? '' : chatId), items: [] };
  const cap = maxItems > 0 ? maxItems : AR_MAX_ITEMS;
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : []);
  for (const x of list) {
    const r = normalizeRecord(x);
    if (r) out.items.push(r);
  }
  if (out.items.length > cap) out.items = out.items.slice(out.items.length - cap);
  return out;
}

// 纯函数：把新记录并入归档（相同内容只保留最新一条），供 arPush 与
// L1 溢出 / L2 淘汰的 mutator 共用——三处沉淀行为永远一致。
export function applyArchiveRecords(items, records, cap) {
  const out = Array.isArray(items) ? items.slice() : [];
  const recs = (Array.isArray(records) ? records : []).map(normalizeRecord).filter(Boolean);
  for (const r of recs) {
    const n = memNorm(r.text);
    const idx = out.findIndex(x => memNorm(x.text) === n);
    if (idx !== -1) out.splice(idx, 1);
    out.push(r);
  }
  const limit = cap > 0 ? cap : AR_MAX_ITEMS;
  return out.length > limit ? out.slice(out.length - limit) : out;
}

export async function arGet(env, chatId) {
  const snap = await memSnapshot(env, chatId);
  return normalizeArchive(snap.archive, chatId, memLimits(env).l3);
}

// 追加归档。相同内容只保留最新一条（会话反复聊同一件事时不会堆 20 份）。
export async function arPush(env, chatId, records) {
  const recs = (Array.isArray(records) ? records : []).map(normalizeRecord).filter(Boolean);
  if (!recs.length) return { added: 0, total: 0 };
  let total = 0;
  const res = await memMutate(env, chatId, draft => {
    draft.archive.items = applyArchiveRecords(draft.archive.items, recs, memLimits(env).l3);
    total = draft.archive.items.length;
  });
  const persisted = !!(env && env.R2) && res.ok && (res.persisted || res.unchanged);
  return { added: recs.length, total, persisted };
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

export { AR_MAX_ITEMS };