// 知识库检索内核（三）：对外检索接口
//  - kbSearch：分块级混合检索（IDF 词权重 + 覆盖率 + 标题加成 + 原文短语加分），返回带偏移的原文片段
//  - kbPreRetrieve：回答前自动检索并生成注入提示词的上下文块（省掉一次工具往返）
//  - kbStats：知识库规模统计（文档 / 分块 / 字符 / 索引时间）

import { kbConfig } from './config.js';
import { kbQueryTokens } from './chunk.js';
import { kbGetRegistry } from './registry.js';
import { kbGetIndex, kbScoreChunks, kbReadChunk, kbComputeStats } from './index.js';

// 片段清洗：压掉连续空行，保证提示词里不出现大段空白浪费预算
function kbCleanSnippet(text, maxChars) {
  let s = String(text || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (maxChars > 0 && s.length > maxChars) {
    let cut = maxChars;
    const nl = s.lastIndexOf('\n', cut);
    if (nl > maxChars - 200) cut = nl;
    s = s.slice(0, cut).trim() + '…';
  }
  return s;
}

function kbRelScore(score, maxScore) {
  if (!(maxScore > 0)) return 0;
  const r = score / maxScore;
  return Math.round(Math.max(0, Math.min(1, r)) * 100) / 100;
}

// 分块检索主入口
async function kbSearch(env, query, opts) {
  const t0 = Date.now();
  const o = opts || {};
  const cfg = kbConfig(env);
  const topK = Math.max(1, Math.min(20, parseInt(o.topK, 10) || cfg.topK));
  const perDoc = Math.max(1, Math.min(5, parseInt(o.perDoc, 10) || 2));
  const result = (extra) => Object.assign({ hits: [], mode: 'empty', tookMs: Date.now() - t0, stats: null }, extra);

  if (!env || !env.R2) return result({ mode: 'no-r2' });
  const q = String(query || '').trim();
  if (!q) return result({ mode: 'no-query' });

  let reg = [];
  try { reg = await kbGetRegistry(env); } catch (e) { reg = []; }
  if (!reg.length) return result({ mode: 'empty-kb' });

  const tokens = kbQueryTokens(q).slice(0, 32);
  if (!tokens.length) return result({ mode: 'no-token' });

  let idx = null;
  try { idx = await kbGetIndex(env, reg.map(e => e.file)); } catch (e) { idx = null; }
  if (!idx || !idx.stats || !idx.stats.chunks) return result({ mode: 'empty-index', stats: idx ? idx.stats : null });

  const docFilter = String(o.doc || '').trim().toLowerCase();
  let candidates = kbScoreChunks(idx, tokens, Math.min(80, topK * 10));
  if (docFilter) {
    candidates = candidates.filter(c => String(c.title || '').toLowerCase().indexOf(docFilter) !== -1);
  }
  if (!candidates.length) return result({ mode: 'no-hit', stats: idx.stats });

  // 第二阶段：只读取最有希望的一批块的原文，用「完整短语是否出现」再校正一次排序。
  // 这样既保证语义相关，又优先把真正原句命中的片段排到最前。
  const readLimit = Math.min(24, Math.max(topK * 3, 6));
  const qLower = q.toLowerCase();
  const detailed = await Promise.all(candidates.slice(0, readLimit).map(async (c) => {
    const text = await kbReadChunk(env, c.file, c.offset, c.length);
    if (!text || !text.trim()) return null;
    const phrase = qLower.length >= 2 && text.toLowerCase().indexOf(qLower) !== -1;
    return Object.assign({}, c, { text, phrase, score: c.score + (phrase ? 8 : 0) });
  }));

  const sorted = detailed.filter(Boolean).sort((a, b) => b.score - a.score);
  const hits = [];
  const usedPerDoc = new Map();
  for (const h of sorted) {
    const used = usedPerDoc.get(h.file) || 0;
    if (used >= perDoc) continue;
    usedPerDoc.set(h.file, used + 1);
    hits.push(h);
    if (hits.length >= topK) break;
  }
  if (!hits.length) return result({ mode: 'no-hit', stats: idx.stats });

  const maxScore = hits[0].score || 1;
  const floor = Math.max(0.6, maxScore * 0.18);
  const kept = hits.filter(h => h.score >= floor);
  for (const h of kept) {
    h.rel = kbRelScore(h.score, maxScore);
    h.snippet = kbCleanSnippet(h.text, 900);
    delete h.text;
  }
  return {
    hits: kept,
    mode: 'index',
    tookMs: Date.now() - t0,
    stats: idx.stats,
    query: q,
    tokens: tokens.length,
  };
}

// 工具输出格式：带文档标题、字符偏移与相关度，模型可直接据此引用并翻页精读
function kbFormatHits(res, opts) {
  const o = opts || {};
  const hits = (res && res.hits) || [];
  if (!hits.length) return '';
  const head = '【知识库检索命中 ' + hits.length + ' 条'
    + (res.stats && res.stats.docs ? '，全库 ' + res.stats.docs + ' 篇 / ' + res.stats.chunks + ' 块' : '')
    + '】';
  const blocks = hits.map((h, i) => {
    const where = '第 ' + h.offset + '~' + (h.offset + h.length) + ' 字符 / 全文 ' + (h.docLen || 0) + ' 字符';
    return (i + 1) + '. 《' + h.title + '》（相关度 ' + Math.round((h.rel || 0) * 100) + '%，' + where + '）\n'
      + h.snippet;
  });
  const tail = o.hint === false ? '' : '\n\n> 需要完整上下文时用 read_doc 传文档标题与 offset=' + (hits[0].offset > 200 ? hits[0].offset - 200 : 0) + ' 续读；引用时注明"据知识库文档《标题》"。';
  return head + '\n\n' + blocks.join('\n\n---\n\n') + tail;
}

// 预检索：把最相关的 3~4 段原文直接塞进系统提示词，让模型第一步就有据可依
async function kbPreRetrieve(env, query, opts) {
  const cfg = kbConfig(env);
  if (!cfg.preRetrieve) return '';
  const o = opts || {};
  const q = String(query || '').trim();
  if (q.length < 2) return '';
  let res;
  try {
    res = await kbSearch(env, q, { topK: Math.min(4, o.topK || 4), perDoc: 1 });
  } catch (e) {
    return '';
  }
  if (!res || !res.hits || !res.hits.length) return '';
  // 预检索宁缺勿滥：只有「原句命中」或「查询词覆盖率足够高」的片段才注入提示词，
  // 否则一段弱相关的内容会污染上下文、把模型带偏。
  const strong = res.hits.filter(h => h.phrase || (h.coverage || 0) >= 0.34);
  if (!strong.length) return '';
  const budget = cfg.preRetrieveChars;
  const parts = [];
  let used = 0;
  for (const h of strong) {
    const body = kbCleanSnippet(h.snippet, 760);
    const head = '《' + h.title + '》（相关度 ' + Math.round((h.rel || 0) * 100) + '%，offset=' + h.offset + '）\n';
    const block = head + body;
    if (used + block.length > budget) break;
    parts.push(block);
    used += block.length;
  }
  if (!parts.length) return '';
  return '【知识库自动检索结果】（提问与知识库内容相关，系统已自动在知识库中定位到以下原文片段，'
    + '按相关度排序；回答时优先依据这些内容，并注明"据知识库文档《标题》"）\n\n'
    + parts.join('\n\n---\n\n')
    + '\n\n（若片段不足以回答，可再用 kb_search 换关键词检索，或 read_doc 传标题与 offset 精读全文；'
    + '知识库内容与训练知识冲突时以知识库为准，用户明确要求最新信息时除外。）\n\n';
}

async function kbStats(env) {
  const cfg = kbConfig(env);
  let reg = [];
  try { reg = await kbGetRegistry(env); } catch (e) { reg = []; }
  let idx = null;
  try { idx = await kbGetIndex(env, reg.map(e => e.file)); } catch (e) { idx = null; }
  const stats = idx && idx.stats ? idx.stats : kbComputeStats({});
  return {
    docs: stats.docs || reg.length,
    chunks: stats.chunks || 0,
    chars: stats.chars || 0,
    newest: stats.newest || 0,
    builtAt: idx ? idx.builtAt : 0,
    indexed: !!(idx && idx.stats && idx.stats.chunks),
    r2: !!(env && env.R2),
    chunkSize: cfg.chunkSize,
    topK: cfg.topK,
    preRetrieve: cfg.preRetrieve,
  };
}

export {
  kbSearch,
  kbFormatHits,
  kbPreRetrieve,
  kbStats,
  kbCleanSnippet,
};
