// 知识库检索内核（二）：kb/docs/_index.json 分块索引
//
// 设计要点：
//  1) 索引 = 每篇文档的块列表 [offset, length, 词向量]，词向量是"词:词频"紧凑编码，
//     每 700 字约 200~400 字节，几百篇文档也只有几十 KB，单次 R2 读取即可全量载入；
//  2) 检索时先用词向量打分定位到「块」，再按需 range 读取命中块的原文（R2 支持字节区间读取），
//     因此永远不需要为了搜索把整库正文读进内存；
//  3) 索引缺失 / 版本不符 / 文档集合变化（控制台手动增删）→ 自动全量重建（自愈）；
//  4) 单篇保存或删除 → 增量更新该篇并重算 df，避免每次写文档都全库重建。

import { storePutChecked } from '../store/r2.js';
import { KB_DOCS_PREFIX, KB_INDEX_KEY, kbGetRegistry } from './registry.js';
import { kbChunkDocument, kbParseTermVector } from './chunk.js';
import { kbConfig } from './config.js';

const KB_INDEX_VERSION = 2;
const KB_INDEX_TTL_MS = 30 * 1000;
const KB_INDEX_READ_BATCH = 4;

let kbIndexCache = null;
let kbIndexCacheBucket = null;
let kbIndexCacheExp = 0;

function kbIndexInvalidate() {
  kbIndexCache = null;
  kbIndexCacheBucket = null;
  kbIndexCacheExp = 0;
}

function kbIndexRemember(env, idx) {
  kbIndexCache = idx;
  kbIndexCacheBucket = env && env.R2 ? env.R2 : null;
  kbIndexCacheExp = Date.now() + KB_INDEX_TTL_MS;
}

function kbBuildDf(docs) {
  const df = Object.create(null);
  for (const file in docs) {
    const d = docs[file];
    if (!d || !Array.isArray(d.c)) continue;
    for (const c of d.c) {
      const seen = new Set();
      for (const pair of kbParseTermVector(c[2])) {
        const t = pair[0];
        if (seen.has(t)) continue;
        seen.add(t);
        df[t] = (df[t] || 0) + 1;
      }
    }
  }
  return df;
}

function kbComputeStats(docs) {
  let chunks = 0;
  let chars = 0;
  let newest = 0;
  for (const file in docs) {
    const d = docs[file];
    if (!d) continue;
    chunks += Array.isArray(d.c) ? d.c.length : 0;
    chars += d.n || 0;
    if (d.u && d.u > newest) newest = d.u;
  }
  return { docs: Object.keys(docs).length, chunks, chars, newest };
}

// 读取单篇文档正文并切成索引块（供全量重建与增量更新共用）
async function kbIndexDocFromR2(env, file, title, cfg) {
  try {
    const obj = await env.R2.get(KB_DOCS_PREFIX + file);
    if (!obj) return null;
    const text = await obj.text();
    return { t: title || file, n: text.length, u: Date.now(), c: kbChunkDocument(text, cfg.chunkSize, cfg.chunkOverlap, cfg.maxTerms) };
  } catch (e) {
    return null;
  }
}

async function kbBuildIndex(env) {
  const cfg = kbConfig(env);
  const empty = { v: KB_INDEX_VERSION, builtAt: Date.now(), size: cfg.chunkSize, docs: {}, df: Object.create(null), stats: { docs: 0, chunks: 0, chars: 0, newest: 0 } };
  if (!env || !env.R2) return empty;
  let reg = [];
  try { reg = await kbGetRegistry(env); } catch (e) { reg = []; }
  const list = reg.slice(0, cfg.maxIndexDocs);
  const docs = Object.create(null);
  for (let i = 0; i < list.length; i += KB_INDEX_READ_BATCH) {
    const batch = list.slice(i, i + KB_INDEX_READ_BATCH);
    const built = await Promise.all(batch.map(async (e) => {
      const doc = await kbIndexDocFromR2(env, e.file, e.title, cfg);
      return doc ? [e.file, doc] : null;
    }));
    for (const pair of built) if (pair) docs[pair[0]] = pair[1];
  }
  const idx = {
    v: KB_INDEX_VERSION,
    builtAt: Date.now(),
    size: cfg.chunkSize,
    docs,
    df: kbBuildDf(docs),
    stats: kbComputeStats(docs),
  };
  await storePutChecked(env, KB_INDEX_KEY, JSON.stringify(idx));
  kbIndexRemember(env, idx);
  return idx;
}

function kbIndexMatchesFiles(idx, files) {
  if (!idx || !idx.docs || !Array.isArray(files)) return false;
  const keys = Object.keys(idx.docs);
  if (keys.length !== files.length) return false;
  const set = new Set(files);
  for (const k of keys) if (!set.has(k)) return false;
  return true;
}

// 取索引：命中 L1 缓存直接返回；文件集合与注册表不一致（控制台手动增删）→ 重建。
async function kbGetIndex(env, expectedFiles) {
  if (!env || !env.R2) return null;
  const fresh = kbIndexCache && kbIndexCacheBucket === env.R2 && Date.now() < kbIndexCacheExp;
  if (fresh && (!expectedFiles || kbIndexMatchesFiles(kbIndexCache, expectedFiles))) {
    return kbIndexCache;
  }
  if (!fresh) {
    try {
      const obj = await env.R2.get(KB_INDEX_KEY);
      if (obj) {
        const parsed = JSON.parse(await obj.text());
        if (parsed && parsed.v === KB_INDEX_VERSION && parsed.docs && parsed.df) {
          if (!expectedFiles || kbIndexMatchesFiles(parsed, expectedFiles)) {
            kbIndexRemember(env, parsed);
            return parsed;
          }
        }
      }
    } catch (e) {}
  }
  return await kbBuildIndex(env);
}

// 增量写入/更新单篇（保存文档后调用）
async function kbUpdateDocIndex(env, file, title, fullText) {
  if (!env || !env.R2) return false;
  const cfg = kbConfig(env);
  let idx;
  try { idx = await kbGetIndex(env); } catch (e) { idx = null; }
  if (!idx) return false;
  const docs = Object.assign(Object.create(null), idx.docs);
  docs[file] = {
    t: title || file,
    n: String(fullText || '').length,
    u: Date.now(),
    c: kbChunkDocument(String(fullText || ''), cfg.chunkSize, cfg.chunkOverlap, cfg.maxTerms),
  };
  const next = {
    v: KB_INDEX_VERSION,
    builtAt: Date.now(),
    size: cfg.chunkSize,
    docs,
    df: kbBuildDf(docs),
    stats: kbComputeStats(docs),
  };
  const ok = await storePutChecked(env, KB_INDEX_KEY, JSON.stringify(next));
  if (ok) kbIndexRemember(env, next); else kbIndexInvalidate();
  return ok;
}

// 增量删除单篇（删除文档后调用）
async function kbRemoveDocIndex(env, file) {
  if (!env || !env.R2) return false;
  let idx;
  try { idx = await kbGetIndex(env); } catch (e) { idx = null; }
  if (!idx || !idx.docs || !idx.docs[file]) return true;
  const docs = Object.assign(Object.create(null), idx.docs);
  delete docs[file];
  const next = {
    v: KB_INDEX_VERSION,
    builtAt: Date.now(),
    size: (idx && idx.size) || kbConfig(env).chunkSize,
    docs,
    df: kbBuildDf(docs),
    stats: kbComputeStats(docs),
  };
  const ok = await storePutChecked(env, KB_INDEX_KEY, JSON.stringify(next));
  if (ok) kbIndexRemember(env, next); else kbIndexInvalidate();
  return ok;
}

async function kbRebuildIndex(env) {
  kbIndexInvalidate();
  return await kbBuildIndex(env);
}

// 读取命中块的原文（R2 区间读取，只取需要的那几百字）
async function kbReadChunk(env, file, offset, length) {
  if (!env || !env.R2) return '';
  try {
    const obj = await env.R2.get(KB_DOCS_PREFIX + file, { range: { offset, length } });
    if (!obj) return '';
    return await obj.text();
  } catch (e) {
    return '';
  }
}

// 块级打分：IDF 加权的词命中 + 覆盖率修正 + 标题加成。
// 只用索引里的词向量，不读正文，因此整库打分是纯内存操作。
function kbScoreChunks(idx, qTokens, limit) {
  const out = [];
  if (!idx || !idx.docs || !qTokens || !qTokens.length) return out;
  const df = idx.df || {};
  const totalChunks = Math.max(1, (idx.stats && idx.stats.chunks) || 1);
  const weights = new Map();
  for (const t of qTokens) {
    if (weights.has(t)) continue;
    const d = df[t] || 0;
    const idf = Math.log(1 + (totalChunks - d + 0.5) / (d + 0.5));
    const lenWeight = t.length >= 2 ? Math.min(2.4, 0.7 + t.length * 0.25) : 0.4;
    weights.set(t, idf * lenWeight);
  }
  const qList = Array.from(weights.keys());
  for (const file in idx.docs) {
    const doc = idx.docs[file];
    if (!doc || !Array.isArray(doc.c)) continue;
    const titleLower = String(doc.t || '').toLowerCase();
    let titleMatched = 0;
    for (const t of qList) {
      if (t.length >= 2 && titleLower.indexOf(t) !== -1) titleMatched++;
    }
    // 标题命中做成「乘法加成」而非「加法加成」：加法会让标题里恰好含查询词的文档
    // 无条件压过正文真正详细讲这件事的文档；乘法最多放大 1.5 倍，只作排序微调。
    const titleBoost = titleMatched ? 1 + 0.5 * (titleMatched / qList.length) : 1;
    for (const chunk of doc.c) {
      const terms = kbParseTermVector(chunk[2]);
      let score = 0;
      let matched = 0;
      for (const pair of terms) {
        const w = weights.get(pair[0]);
        if (w === undefined) continue;
        matched++;
        score += w * (1 + Math.log(pair[1]));
      }
      if (!matched) continue;
      const coverage = matched / qList.length;
      // 只命中一个短词且覆盖率极低 → 视为噪声，避免"的""是"类碎片召回
      if (coverage < 0.2 && matched < 2) continue;
      out.push({
        file,
        title: doc.t || file,
        offset: chunk[0],
        length: chunk[1],
        docLen: doc.n || 0,
        coverage,
        score: score * (0.6 + 0.4 * coverage) * titleBoost,
      });
    }
  }
  out.sort((a, b) => (b.score - a.score) || (a.offset - b.offset));
  return limit > 0 ? out.slice(0, limit) : out;
}

export {
  KB_INDEX_VERSION,
  kbIndexInvalidate,
  kbGetIndex,
  kbBuildIndex,
  kbRebuildIndex,
  kbUpdateDocIndex,
  kbRemoveDocIndex,
  kbScoreChunks,
  kbReadChunk,
  kbComputeStats,
};
