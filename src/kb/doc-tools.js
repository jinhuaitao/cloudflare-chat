// Agent 工具：知识库文档的保存 / 列表 / 读取（支持分页 offset） / 多关键词分词检索 / 删除
// v7.1.0 性能优化：新增文档正文 L1 内存缓存（支持长文档 0ms 翻页与多轮全文检索加速）+ 标题/词频加权相关性算法
// v7.7.0 存读性能：
// 1) L1 缓存按 R2 桶隔离（WeakMap），多桶 / 测试环境不再串档；
// 2) 检索复用小写正文缓存（同一篇文档只 toLowerCase 一次），并用「长词是否出现」提前排除整篇；
// 3) 正文检索覆盖全库（旧版只查前 30 篇，后排文档永远搜不到），带 4 秒时间预算与结果缓存；
// 4) read_doc 用注册表 chars 预检 offset 越界，非法翻页不再白读整篇文档；
// 5) 注册表新增 chars（字符数）与准确的 size（字节数），列表按更新时间限流展示。

import { mapSetBounded, mapGetBounded, mapLimit } from '../utils.js';
import { storePutChecked } from '../store/r2.js';
import { kbSafeChatId } from '../store/kb.js';
import { KB_DOCS_PREFIX, kbDocSlug, kbNormSource, kbDocTitleOf, kbGetRegistry,
  kbSaveRegistry, kbFindRegEntry, kbRegistryVersion, kbFmtSize, kbFmtDate } from './registry.js';

// v7.1.0：知识库文档正文 L1 内存缓存（每桶最多 48 篇，TTL 120 秒），写入或删除时自动失效/更新
const KB_DOC_CACHE_MAX = 48;
const KB_DOC_CACHE_TTL_MS = 120 * 1000;
const KB_DOC_CACHE_TEXT_MAX = 150000;
const KB_SEARCH_CACHE_MAX = 40;
const KB_SEARCH_CACHE_TTL_MS = 60 * 1000;
const KB_SEARCH_BUDGET_MS = 4000;
const KB_SEARCH_CONCURRENCY = 6;

const kbDocCaches = new WeakMap();

function docCacheFor(env) {
  const bucket = env && env.R2;
  if (!bucket || (typeof bucket !== 'object' && typeof bucket !== 'function')) return null;
  let c = kbDocCaches.get(bucket);
  if (!c) {
    c = { docs: new Map(), docsExp: new Map(), search: new Map(), searchExp: new Map() };
    kbDocCaches.set(bucket, c);
  }
  return c;
}

function kbCacheDoc(env, key, text) {
  const c = docCacheFor(env);
  if (!c || text.length > KB_DOC_CACHE_TEXT_MAX) return;
  mapSetBounded(c.docs, key, { text: text, lower: null }, KB_DOC_CACHE_MAX, c.docsExp, KB_DOC_CACHE_TTL_MS);
}

function kbDropDocCache(env, key) {
  const c = docCacheFor(env);
  if (!c) return;
  c.docs.delete(key);
  c.docsExp.delete(key);
}

async function kbReadDocTextCached(env, key) {
  if (!env || !env.R2) return null;
  const c = docCacheFor(env);
  const hit = c ? mapGetBounded(c.docs, key, c.docsExp) : undefined;
  if (hit && typeof hit.text === 'string') return hit.text;
  try {
    const obj = await env.R2.get(key);
    if (!obj) return null;
    const text = await obj.text();
    kbCacheDoc(env, key, text);
    return text;
  } catch (e) {
    return null;
  }
}

// 检索用：返回 { text, lower }，小写正文有缓存就复用，避免每次检索整篇 toLowerCase
async function kbReadDocForSearch(env, key) {
  const c = docCacheFor(env);
  const hit = c ? mapGetBounded(c.docs, key, c.docsExp) : undefined;
  if (hit && typeof hit.text === 'string') {
    if (typeof hit.lower !== 'string') hit.lower = hit.text.toLowerCase();
    return hit;
  }
  const text = await kbReadDocTextCached(env, key);
  if (text === null) return null;
  const again = c ? mapGetBounded(c.docs, key, c.docsExp) : undefined;
  if (again && typeof again.text === 'string') {
    if (typeof again.lower !== 'string') again.lower = again.text.toLowerCase();
    return again;
  }
  return { text: text, lower: text.toLowerCase() };
}

// 分词辅助：英文/数字按词、中文按单字 + 2-gram，用于正文多关键词相关性检索
function docSearchTokens(s) {
  const out = [];
  const segs = String(s || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/);
  for (const seg of segs) {
    if (!seg) continue;
    out.push(seg);
    if (/[\u4e00-\u9fff]/.test(seg)) {
      for (let i = 0; i + 2 <= seg.length; i++) out.push(seg.slice(i, i + 2));
      if (seg.length >= 2) {
        for (let i = 0; i < seg.length; i++) out.push(seg[i]);
      }
    }
  }
  return [...new Set(out)];
}

async function toolSaveDoc(env, chatId, args) {
  args = args || {};
  const title = String(args.title || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
  const cleanSource = String(args.source || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
  let content = String(args.content || '');
  if (!title) return '标题为空，未保存';
  if (!content.trim()) return '内容为空，未保存';
  if (!env.R2) return 'R2 未绑定，知识库文档无法保存。请先按 README 第二步绑定 R2 存储桶后再试；本次内容未保存。';
  if (content.length > 100000) content = content.slice(0, 100000) + '\n\n> （内容过长，仅保存前 10 万字符）';
  const file = kbDocSlug(title) + '.md';
  const key = KB_DOCS_PREFIX + file;
  const reg = await kbGetRegistry(env);
  const normSrc = kbNormSource(args.source);
  if (normSrc) {
    const dup = reg.find(e => kbNormSource(e.source) === normSrc);
    if (dup && dup.file !== file) {
      return '该链接已保存为知识库文档《' + (dup.title || dup.file) + '》，未重复保存。如需更新内容，请用标题"' + (dup.title || dup.file) + '"（或清洗后同名标题）重新保存以覆盖，或先用 delete_doc 删除旧文档。';
    }
  }
  const prevEntry = reg.find(e => e.file === file);
  const existed = !!prevEntry;
  const nowIso = new Date().toISOString();
  const head = '---\ntitle: "' + title.replace(/"/g, '') + '"\nsaved_at: ' + nowIso
    + '\nchat_id: "' + kbSafeChatId(chatId) + '"'
    + (cleanSource ? '\nsource: ' + cleanSource : '')
    + '\n---\n\n';
  const body = head + content;
  const okDoc = await storePutChecked(env, key, body);
  if (!okDoc) return '知识库文档写入 R2 失败（' + key + '），请检查 R2 绑定与权限后重试；本次内容未保存。';
  // 穿透更新 L1 正文缓存
  kbCacheDoc(env, key, body);
  const entry = {
    file: file,
    title: title,
    source: cleanSource,
    // size 统一为字节数（旧版写的是字符数，与重建出来的条目单位不一致）；
    // chars 供 read_doc 在不下载正文的情况下判断 offset 是否越界
    size: new TextEncoder().encode(body).byteLength,
    chars: body.length,
    updated_at: nowIso
  };
  const idx = reg.findIndex(e => e.file === file);
  if (idx >= 0) reg[idx] = entry; else reg.push(entry);
  const okReg = await kbSaveRegistry(env, reg);
  if (!okReg) return '文档正文已写入 R2（' + key + '），但注册表更新失败，文档可能暂不出现在列表中；请稍后重新保存一次以修复注册表，本次内容未丢失。';
  let verNote = existed ? '，已覆盖旧版本' : '，新建';
  if (existed && prevEntry && prevEntry.title !== title) {
    verNote += '（注意：新标题清洗后与旧文档《' + prevEntry.title + '》同名，旧内容已被覆盖）';
  }
  return '已保存为知识库文档：' + key + '（' + content.length + ' 字符' + verNote + '）';
}

async function toolListDocs(env) {
  if (!env.R2) return 'R2 未绑定，无法读取知识库文档';
  const reg = await kbGetRegistry(env);
  if (!reg.length) return '知识库文档为空（kb/docs/ 下暂无文档，可用 save_doc 保存）';
  // v7.7.0：按更新时间倒序 + 最多列 60 篇。旧版全量列出，几百篇时会撑爆工具结果与上下文
  const MAX_SHOWN = 60;
  const ordered = reg.slice().sort((a, b) => {
    const ta = Date.parse(a.updated_at || '') || 0;
    const tb = Date.parse(b.updated_at || '') || 0;
    return tb - ta;
  });
  const shown = ordered.slice(0, MAX_SHOWN);
  const more = shown.length < reg.length
    ? '，按更新时间显示最近 ' + shown.length + ' 篇，其余请用 read_doc 按关键词检索'
    : '';
  return '知识库文档（共' + reg.length + '篇' + more + '）：\n' +
    shown.map((e, i) => (i + 1) + '. ' + (e.title || e.file) + '（' + kbFmtSize(e.size) + '，' + kbFmtDate(e.updated_at) + '）').join('\n');
}

async function toolReadDoc(env, args, maxChars) {
  args = args || {};
  const query = String(args.query || '').trim();
  if (!query) return '请给出要读取的文档标题关键词';
  if (!env.R2) return 'R2 未绑定，无法读取知识库文档';
  const reg = await kbGetRegistry(env);
  if (!reg.length) return '知识库文档为空（kb/docs/ 下暂无文档）';
  const offset = Math.max(0, parseInt(args.offset, 10) || 0);
  // v7.9.0：切片长度由调用方预算决定。
  // 旧版固定返回 8000 字符，随后被 Agent 循环按预算截断成 4000 ——
  // 但尾部的"请传 offset=8000"是按 8000 算的，模型照着翻页就会跳过中间 4000 字。
  // 现在由工具自己按预算切片，nextOffset 始终与实际返回的内容对齐。
  const MAX = Math.max(600, Math.min(8000, (maxChars > 0 ? maxChars : 8000)));
  const hit = kbFindRegEntry(reg, query);
  if (hit) {
    // 注册表带字符数时先判越界：不用为了一个非法 offset 把整篇文档读进内存
    if (typeof hit.chars === 'number' && hit.chars >= 0 && offset >= hit.chars) {
      return '文档读取失败：偏移量 offset=' + offset + ' 已超出文档总长度（' + hit.chars + ' 字符），请改用更小的 offset；或传 offset=0 从头读。';
    }
    const fullText = await kbReadDocTextCached(env, KB_DOCS_PREFIX + hit.file);
    if (fullText === null) return '文档读取失败：' + (hit.title || hit.file);
    const totalLen = fullText.length;
    if (offset >= totalLen) {
      return '文档读取失败：偏移量 offset=' + offset + ' 已超出文档总长度（' + totalLen + ' 字符），请改用更小的 offset；或传 offset=0 从头读。';
    }
    const slice = fullText.slice(offset, offset + MAX);
    const nextOffset = offset + slice.length;
    let note = '';
    if (nextOffset < totalLen) {
      note = '\n\n> （当前显示第 ' + offset + ' ~ ' + nextOffset + ' 字符，全文共 ' + totalLen + ' 字符；如需继续阅读后续内容，请调用 read_doc 并传 offset=' + nextOffset + '）';
    } else if (offset > 0) {
      note = '\n\n> （当前显示第 ' + offset + ' ~ ' + totalLen + ' 字符，已读到文档末尾）';
    }
    return '【知识库文档《' + (hit.title || hit.file) + '》】\n' + slice + note;
  }
  // 标题无命中 → 全文多关键词相关性检索（v7.7.0 覆盖全库，按更新时间优先，带时间预算）
  const ordered = reg.slice().sort((a, b) => {
    const ta = Date.parse(a.updated_at || '') || 0;
    const tb = Date.parse(b.updated_at || '') || 0;
    return tb - ta;
  });
  const res = await kbSearchDocBodyEx(env, ordered, query);
  if (res.snippet) return res.snippet;
  if (res.skipped > 0) {
    return '未在已检索的 ' + res.scanned + ' 篇文档中找到包含"' + query + '"的内容（知识库共 ' + res.total
      + ' 篇，本次因时间预算跳过 ' + res.skipped + ' 篇）。请换更精确的关键词，或先用 list_docs 查看标题后按标题读取。'
      + '\n\n现有文档（按更新时间）：\n' + ordered.slice(0, 60).map(e => '- ' + (e.title || e.file)).join('\n');
  }
  return '未找到标题或正文包含"' + query + '"的文档。现有文档：\n' +
    ordered.slice(0, 60).map(e => '- ' + (e.title || e.file)).join('\n');
}

// v7.1.0 全文多关键词相关性检索（带 L1 缓存与词频/标题饱和度加权）：
// v7.7.0：并发（6）覆盖全库、复用的小写正文缓存、长词全局预检提前排除、4 秒时间预算、结果缓存。
async function kbSearchDocBodyEx(env, entries, query) {
  const qLower = String(query || '').trim().toLowerCase();
  const tokens = docSearchTokens(query);
  const list = Array.isArray(entries) ? entries : [];
  const total = list.length;
  if (!qLower && !tokens.length) return { snippet: null, scanned: 0, skipped: 0, total };

  const cache = docCacheFor(env);
  const cacheKey = kbRegistryVersion() + '|' + qLower;
  if (cache) {
    const memo = mapGetBounded(cache.search, cacheKey, cache.searchExp);
    if (typeof memo === 'string') return { snippet: memo || null, scanned: total, skipped: 0, total, cached: true };
  }

  const longTokens = tokens.filter(t => t.length >= 2);
  const hasLongTokenInQuery = longTokens.length > 0;
  const deadline = Date.now() + KB_SEARCH_BUDGET_MS;
  let scanned = 0;
  let skipped = 0;

  const hits = await mapLimit(list, KB_SEARCH_CONCURRENCY, async (entry) => {
    if (Date.now() > deadline) { skipped += 1; return null; }
    scanned += 1;
    const k = typeof entry === 'string' ? entry : (KB_DOCS_PREFIX + entry.file);
    const docTitle = (entry && entry.title) ? entry.title : kbDocTitleOf(k);
    const titleLower = String(docTitle || '').toLowerCase();
    try {
      const doc = await kbReadDocForSearch(env, k);
      if (!doc) return null;
      const lower = doc.lower;

      // 长词一个都没出现 → 整篇不可能命中窗口打分，直接跳过（避免逐窗口扫描大文档）
      if (hasLongTokenInQuery) {
        let any = false;
        for (const tk of longTokens) {
          if (lower.indexOf(tk) !== -1) { any = true; break; }
        }
        if (!any) return null;
      }

      // 标题相关性加成
      let titleBonus = 0;
      for (const tk of tokens) {
        if (tk.length >= 2 && titleLower.indexOf(tk) !== -1) titleBonus += tk.length * 4;
      }

      // 1) 优先检查完整 query 精确子串
      const exactIdx = qLower ? lower.indexOf(qLower) : -1;
      if (exactIdx !== -1) {
        return { title: docTitle, text: doc.text, bestOffset: exactIdx, score: 1000 + tokens.length * 10 + titleBonus };
      }

      // 2) 分词多关键词打分：按 800 字步长滑动窗口找最密集命中区（引入词频饱和加权）
      if (!tokens.length) return null;
      const WIN = 1200;
      const STEP = 800;
      let bestScore = 0;
      let bestPos = -1;
      for (let pos = 0; pos < lower.length; pos += STEP) {
        const winText = lower.slice(pos, pos + WIN);
        let score = titleBonus;
        let matchedLongTokens = 0;
        for (const tk of tokens) {
          let idx = winText.indexOf(tk);
          if (idx !== -1) {
            // 统计窗口内出现次数（上限 4 次，实现 BM25 风格的词频饱和）
            let occ = 1;
            let nextFrom = idx + tk.length;
            while (occ < 4) {
              const nxt = winText.indexOf(tk, nextFrom);
              if (nxt === -1) break;
              occ++;
              nextFrom = nxt + tk.length;
            }
            const tfWeight = 1 + (occ - 1) * 0.3;
            if (tk.length >= 2) {
              score += tk.length * 3 * tfWeight;
              matchedLongTokens++;
            } else {
              score += 1;
            }
          }
        }
        if (hasLongTokenInQuery && matchedLongTokens === 0) continue;
        if (score > bestScore) {
          bestScore = score;
          bestPos = pos;
        }
      }
      if (bestScore > 0 && bestPos >= 0) {
        let anchor = bestPos;
        const winSlice = lower.slice(bestPos, bestPos + WIN);
        for (const tk of tokens) {
          if (tk.length >= 2) {
            const rel = winSlice.indexOf(tk);
            if (rel !== -1) { anchor = bestPos + rel; break; }
          }
        }
        return { title: docTitle, text: doc.text, bestOffset: anchor, score: bestScore };
      }
      return null;
    } catch (e) { return null; }
  });

  const candidates = hits.filter(Boolean);
  let snippet = null;
  if (candidates.length) {
    candidates.sort((a, b) => b.score - a.score);
    const top = candidates.slice(0, 3);
    const blocks = top.map((h, idx) => {
      const start = Math.max(0, h.bestOffset - 450);
      const end = Math.min(h.text.length, h.bestOffset + 650);
      let frag = h.text.slice(start, end);
      if (start > 0) frag = '…' + frag;
      if (end < h.text.length) frag = frag + '…';
      return '【命中 ' + (idx + 1) + '：知识库文档《' + h.title + '》（offset=' + start + '，全文 ' + h.text.length + ' 字符）】\n' + frag;
    });
    snippet = blocks.join('\n\n---\n\n') +
      '\n\n> （以上为正文相关性最高的片段；如需阅读某篇完整上下文，请用 read_doc 传入完整文档标题及对应 offset）';
  }
  // 只在完整扫描（无跳过）时缓存「有/无结果」，避免把时间预算造成的漏检固化为答非所问
  if (cache && skipped === 0) {
    mapSetBounded(cache.search, cacheKey, snippet || '', KB_SEARCH_CACHE_MAX, cache.searchExp, KB_SEARCH_CACHE_TTL_MS);
  }
  return { snippet: snippet, scanned: scanned, skipped: skipped, total };
}

async function kbSearchDocBody(env, entries, query) {
  const r = await kbSearchDocBodyEx(env, entries, query);
  return r.snippet;
}

async function toolDeleteDoc(env, args) {
  args = args || {};
  const query = String(args.query || '').trim();
  if (!query) return '请给出要删除的文档标题关键词';
  if (!env.R2) return 'R2 未绑定，无法删除知识库文档';
  const reg = await kbGetRegistry(env);
  if (!reg.length) return '知识库文档为空，无需删除';
  const hit = kbFindRegEntry(reg, query);
  if (!hit) {
    // v7.9.0：与 list_docs 一致，最多列 60 篇。旧版全量列出，几百篇时直接撑爆工具结果
    const shown = reg.slice(0, 60);
    const more = shown.length < reg.length ? '（共 ' + reg.length + ' 篇，仅列前 60 篇）' : '';
    return '未找到标题包含"' + query + '"的文档' + more + '。现有文档：\n' +
      shown.map(e => '- ' + (e.title || e.file)).join('\n');
  }
  const key = KB_DOCS_PREFIX + hit.file;
  try { await env.R2.delete(key); } catch (e) { return '删除失败：' + (hit.title || hit.file); }
  kbDropDocCache(env, key);
  const okReg = await kbSaveRegistry(env, reg.filter(e => e !== hit));
  if (!okReg) return '文档文件已删除，但注册表更新失败，列表可能仍显示旧条目；下次读取会自动重建注册表。《' + (hit.title || hit.file) + '》';
  return '已删除知识库文档《' + (hit.title || hit.file) + '》';
}

export {
  docSearchTokens,
  kbReadDocTextCached,
  toolSaveDoc,
  toolListDocs,
  toolReadDoc,
  kbSearchDocBody,
  kbSearchDocBodyEx,
  toolDeleteDoc,
};
