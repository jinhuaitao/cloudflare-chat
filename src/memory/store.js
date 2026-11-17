import { mapSetBounded, mapGetBounded } from '../utils.js';
import { storeGetMeta, storePutCas } from '../store/r2.js';
import { agentMemKey, agentMemKeyLegacy } from '../store/kb.js';
import { memKey, wmKey, ltKey, arKey, memSafeId, memCacheTtl } from './layers.js';

const bucketStates = new WeakMap();
const memoryOnlyBucket = {};
const MEM_CACHE_MAX = 500;
const CAS_ROUNDS = 3;

function stateFor(env) {
  const bucket = (env && env.R2) || memoryOnlyBucket;
  let state = bucketStates.get(bucket);
  if (!state) {
    state = { cache: new Map(), expires: new Map(), noLegacy: new Set(), loads: new Map(), writes: new Map() };
    bucketStates.set(bucket, state);
  }
  return state;
}

function emptySnap() {
  return { work: { updatedAt: 0, items: [], pins: [] }, long: [], archive: { items: [] } };
}

function normalizeSnap(obj) {
  const snap = emptySnap();
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
  return JSON.stringify({ v: 2, chatId, work: snap.work, long: snap.long, archive: snap.archive });
}

function failedEntry() {
  return { snap: emptySnap(), etag: '', persistedJson: '', failed: true };
}

function entryFromMeta(meta, chatId) {
  if (meta.failed) return failedEntry();
  if (meta.text === null) return { snap: emptySnap(), etag: '', persistedJson: '', failed: false };
  try {
    const obj = JSON.parse(meta.text);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj.v !== 2) return failedEntry();
    const snap = normalizeSnap(obj);
    return { snap, etag: meta.etag, persistedJson: serialize(chatId, snap), failed: false };
  } catch (e) {
    return failedEntry();
  }
}

function cacheEntry(env, chatId, entry) {
  const state = stateFor(env);
  state.loads.delete(chatId);
  mapSetBounded(state.cache, chatId, entry, MEM_CACHE_MAX, state.expires, memCacheTtl(env));
  return entry;
}

async function migrateLegacy(env, chatId) {
  const metas = await Promise.all([
    wmKey(chatId), ltKey(chatId), arKey(chatId), agentMemKey(chatId), agentMemKeyLegacy(chatId)
  ].map(key => storeGetMeta(env, key)));
  if (metas.some(meta => meta.failed)) return failedEntry();
  const [wRaw, lRaw, aRaw, kbRaw, rootRaw] = metas.map(meta => meta.text);
  const lFound = lRaw ?? kbRaw ?? rootRaw;
  if (wRaw === null && lFound === null && aRaw === null) return null;
  let snap;
  try {
    const work = wRaw === null ? null : JSON.parse(wRaw);
    const long = lFound === null ? null : JSON.parse(lFound);
    const archive = aRaw === null ? null : JSON.parse(aRaw);
    if ((wRaw !== null && (!work || typeof work !== 'object' || Array.isArray(work)))
      || (lFound !== null && !Array.isArray(long))
      || (aRaw !== null && (!archive || typeof archive !== 'object'))) return failedEntry();
    snap = normalizeSnap({ work, long, archive });
  } catch (e) {
    return failedEntry();
  }
  const json = serialize(chatId, snap);
  const res = await storePutCas(env, memKey(chatId), json, '');
  if (res.conflict) return entryFromMeta(await storeGetMeta(env, memKey(chatId)), chatId);
  if (!res.ok) return { snap, etag: '', persistedJson: '', failed: true };
  return { snap, etag: res.etag, persistedJson: json, failed: false };
}

async function memLoad(env, chatId) {
  const state = stateFor(env);
  let entry = { snap: emptySnap(), etag: '', persistedJson: '', failed: false };
  if (env && env.R2) {
    const meta = await storeGetMeta(env, memKey(chatId));
    entry = entryFromMeta(meta, chatId);
    if (entry.failed) return entry;
    if (meta.text === null && !state.noLegacy.has(chatId)) {
      const migrated = await migrateLegacy(env, chatId);
      if (migrated) {
        entry = migrated;
        if (entry.failed) return entry;
      } else {
        if (state.noLegacy.size >= MEM_CACHE_MAX) state.noLegacy.clear();
        state.noLegacy.add(chatId);
      }
    }
  }
  return entry;
}

function loadShared(env, chatId) {
  const state = stateFor(env);
  const cached = mapGetBounded(state.cache, chatId, env && env.R2 ? state.expires : null);
  if (cached) return Promise.resolve(cached);
  const hit = state.loads.get(chatId);
  if (hit) return hit;
  const load = Promise.resolve().then(() => memLoad(env, chatId)).then(entry => {
    // 写入已发布新快照时，较早启动的读取不得回填旧值。
    if (state.loads.get(chatId) !== load) return state.cache.get(chatId) || entry;
    return entry.failed ? entry : cacheEntry(env, chatId, entry);
  }).finally(() => {
    if (state.loads.get(chatId) === load) state.loads.delete(chatId);
  });
  if (state.loads.size >= MEM_CACHE_MAX) state.loads.clear();
  state.loads.set(chatId, load);
  return load;
}

export async function memSnapshot(env, chatId) {
  const entry = await loadShared(env, memSafeId(chatId));
  return cloneSnap(entry.snap);
}

async function mutateNow(env, chatId, mutator) {
  let entry = await loadShared(env, chatId);
  for (let round = 0; round < CAS_ROUNDS; round++) {
    if (entry.failed) return { ok: false, persisted: false, unchanged: false, snap: cloneSnap(entry.snap) };
    const draft = cloneSnap(entry.snap);
    if (mutator(draft) === false) {
      return { ok: true, persisted: false, unchanged: true, snap: cloneSnap(entry.snap) };
    }
    const json = serialize(chatId, draft);
    if (json === entry.persistedJson) {
      return { ok: true, persisted: false, unchanged: true, snap: draft };
    }
    if (!env || !env.R2) {
      cacheEntry(env, chatId, { snap: draft, etag: '', persistedJson: '', failed: false });
      return { ok: true, persisted: false, unchanged: false, snap: draft };
    }

    // PUT 在飞时的命中增量不能被提交前的快照冲掉，留给下一次真实写入。
    const touches = [];
    entry.pendingTouches = touches;
    const res = await storePutCas(env, memKey(chatId), json, entry.etag);
    delete entry.pendingTouches;
    if (res.ok) {
      for (const apply of touches) apply(draft);
      cacheEntry(env, chatId, { snap: draft, etag: res.etag, persistedJson: json, failed: false });
      return { ok: true, persisted: true, unchanged: false, snap: draft };
    }
    if (!res.conflict) return { ok: false, persisted: false, unchanged: false, snap: cloneSnap(entry.snap) };
    entry = entryFromMeta(await storeGetMeta(env, memKey(chatId)), chatId);
    if (!entry.failed) {
      for (const apply of touches) apply(entry.snap);
      cacheEntry(env, chatId, entry);
    } else {
      const state = stateFor(env);
      state.cache.delete(chatId);
      state.expires.delete(chatId);
    }
  }
  return { ok: false, persisted: false, unchanged: false, conflict: true, snap: cloneSnap(entry.snap) };
}

export function memMutate(env, chatId, mutator) {
  const id = memSafeId(chatId);
  const state = stateFor(env);
  const previous = state.writes.get(id) || Promise.resolve();
  const result = previous.then(() => mutateNow(env, id, mutator));
  const settled = result.then(() => {}, () => {});
  state.writes.set(id, settled);
  settled.then(() => {
    if (state.writes.get(id) === settled) state.writes.delete(id);
  });
  return result;
}

export function memTouchCached(env, chatId, apply) {
  const id = memSafeId(chatId);
  const state = stateFor(env);
  const entry = mapGetBounded(state.cache, id, env && env.R2 ? state.expires : null);
  if (!entry || entry.failed) return false;
  apply(entry.snap);
  if (entry.pendingTouches) entry.pendingTouches.push(apply);
  cacheEntry(env, id, entry);
  return true;
}
