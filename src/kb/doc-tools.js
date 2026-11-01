// Agent 工具：知识库文档的保存 / 列表 / 读取（支持分页 offset） / 多关键词分词检索 / 删除
// v7.1.0 性能优化：新增文档正文 L1 内存缓存（支持长文档 0ms 翻页与多轮全文检索加速）+ 标题/词频加权相关性算法
// v7.5.0 知识库 3.0：写入/删除同步维护分块索引，read_doc 优先走 kb_search 的块级定位，
//        并新增 kb_search（分块检索）与 kb_ingest（网页正文入库）两个工具。

import { mapSetBounded, mapGetBounded } from '../utils.js';
import { storePutChecked } from '../store/r2.js';
import { kbSafeChatId } from '../store/kb.js';
import { KB_DOCS_PREFIX, kbDocSlug, kbNormSource, kbDocTitleOf, kbGetRegistry,
  kbSaveRegistry, kbFindRegEntry, kbFmtSize, kbFmtDate } from './registry.js';
import { kbUpdateDocIndex, kbRemoveDocIndex } from './index.js';
import { kbSearch, kbFormatHits, kbStats } from './search.js';
import { kbConfig } from './config.js';
import { isBlockedFetchHost } from '../net/ssrf.js';
import { getOrFetchPageText } from '../agent/tools-web.js';

// v7.1.0：知识库文档正文 L1 内存缓存（最多缓存 80 篇，TTL 120 秒），写入或删除时自动失效/更新
const kbDocTextCache = new Map();
const kbDocTextExp = new Map();
const KB_DOC_CACHE_MAX = 80;
const KB_DOC_CACHE_TTL_MS = 120 * 1000;

async function kbReadDocTextCached(env, key) {
  if (!env || !env.R2) return null;
  const cached = mapGetBounded(kbDocTextCache, key, kbDocTextExp);
  if (typeof cached === 'string') return cached;
  try {
    const obj = await env.R2.get(key);
    if (!obj) return null;
    const text = await obj.text();
    if (text.length <= 150000) {
      mapSetBounded(kbDocTextCache, key, text, KB_DOC_CACHE_MAX, kbDocTextExp, KB_DOC_CACHE_TTL_MS);
    }
    return text;
  } catch (e) {
    return null;
  }
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
  const maxDocChars = kbConfig(env).maxDocChars;
  if (content.length > maxDocChars) content = content.slice(0, maxDocChars) + '\n\n> （内容过长，仅保存前 ' + Math.round(maxDocChars / 10000) + ' 万字符）';
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
  const head = '---\ntitle: "' + title.replace(/"/g, '') + '"\nsaved_at: ' + new Date().toISOString()
    + '\nchat_id: "' + kbSafeChatId(chatId) + '"'
    + (cleanSource ? '\nsource: ' + cleanSource : '')
    + '\n---\n\n';
  const body = head + content;
  const okDoc = await storePutChecked(env, key, body);
  if (!okDoc) return '知识库文档写入 R2 失败（' + key + '），请检查 R2 绑定与权限后重试；本次内容未保存。';
  // 穿透更新 L1 正文缓存
  mapSetBounded(kbDocTextCache, key, body, KB_DOC_CACHE_MAX, kbDocTextExp, KB_DOC_CACHE_TTL_MS);
  const entry = {
    file: file,
    title: title,
    source: cleanSource,
    size: body.length,
    updated_at: new Date().toISOString()
  };
  const idx = reg.findIndex(e => e.file === file);
  if (idx >= 0) reg[idx] = entry; else reg.push(entry);
  const okReg = await kbSaveRegistry(env, reg);
  if (!okReg) return '文档正文已写入 R2（' + key + '），但注册表更新失败，文档可能暂不出现在列表中；请稍后重新保存一次以修复注册表，本次内容未丢失。';
  // v7.5.0：同步维护分块索引。失败不影响文档本身——检索层发现索引与文档集合不一致会自动全量重建。
  let indexNote = '';
  try {
    const okIdx = await kbUpdateDocIndex(env, file, title, body);
    if (!okIdx) indexNote = '，索引稍后自动重建';
  } catch (e) { indexNote = '，索引稍后自动重建'; }
  let verNote = existed ? '，已覆盖旧版本' : '，新建';
  if (existed && prevEntry && prevEntry.title !== title) {
    verNote += '（注意：新标题清洗后与旧文档《' + prevEntry.title + '》同名，旧内容已被覆盖）';
  }
  return '已保存为知识库文档：' + key + '（' + content.length + ' 字符' + verNote + indexNote + '）';
}

async function toolListDocs(env) {
  if (!env.R2) return 'R2 未绑定，无法读取知识库文档';
  const reg = await kbGetRegistry(env);
  if (!reg.length) return '知识库文档为空（kb/docs/ 下暂无文档，可用 save_doc 保存）';
  let st = null;
  try { st = await kbStats(env); } catch (e) { st = null; }
  const scale = st
    ? '（共' + reg.length + '篇 / ' + st.chunks + ' 个检索块 / 约 ' + Math.max(1, Math.round(st.chars / 1000)) + ' 千字）'
    : '（共' + reg.length + '篇）';
  const shown = reg.slice(0, 60);
  const lines = shown.map((e, i) => (i + 1) + '. ' + (e.title || e.file) + '（' + kbFmtSize(e.size) + '，' + kbFmtDate(e.updated_at) + '）');
  return '知识库文档' + scale + '：\n' + lines.join('\n')
    + (reg.length > shown.length ? '\n…（其余 ' + (reg.length - shown.length) + ' 篇未列出）' : '')
    + '\n\n提示：找具体内容请直接用 kb_search 检索（返回相关原文片段与偏移），比逐篇 read_doc 更快。';
}

async function toolReadDoc(env, args) {
  args = args || {};
  const query = String(args.query || '').trim();
  if (!query) return '请给出要读取的文档标题关键词';
  if (!env.R2) return 'R2 未绑定，无法读取知识库文档';
  const reg = await kbGetRegistry(env);
  if (!reg.length) return '知识库文档为空（kb/docs/ 下暂无文档）';
  const offset = Math.max(0, parseInt(args.offset, 10) || 0);
  const MAX = 8000;
  const hit = kbFindRegEntry(reg, query);
  if (hit) {
    const fullText = await kbReadDocTextCached(env, KB_DOCS_PREFIX + hit.file);
    if (fullText === null) return '文档读取失败：' + (hit.title || hit.file);
    const totalLen = fullText.length;
    if (offset >= totalLen) {
      return '【知识库文档《' + (hit.title || hit.file) + '》】偏移量 offset=' + offset + ' 已超出文档总长度（' + totalLen + ' 字符）。';
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
  // 标题无命中 → 走分块索引检索（v7.5.0）：直接定位到最相关的原文片段与偏移
  let indexed = null;
  try { indexed = await kbSearch(env, query, { topK: 3, perDoc: 1 }); } catch (e) { indexed = null; }
  if (indexed && indexed.hits && indexed.hits.length) {
    return '未找到标题为「' + query + '」的文档，但在正文中检索到相关内容：\n\n' + kbFormatHits(indexed);
  }
  // 索引不可用（尚未建立 / 全库过大被跳过）→ 退回旧的全库正文扫描兜底
  const snippet = await kbSearchDocBody(env, reg.slice(0, 30), query);
  if (snippet) return snippet;
  return '未找到标题或正文包含"' + query + '"的文档。现有文档：\n' +
    reg.map(e => '- ' + (e.title || e.file)).join('\n');
}

// v7.1.0 全文多关键词相关性检索（带 L1 缓存与词频/标题饱和度加权）：
async function kbSearchDocBody(env, entries, query) {
  const qLower = String(query || '').trim().toLowerCase();
  const tokens = docSearchTokens(query);
  if (!qLower && !tokens.length) return null;

  const BATCH = 6;
  const candidates = [];

  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const batchHits = await Promise.all(batch.map(async (entry) => {
      const k = typeof entry === 'string' ? entry : (KB_DOCS_PREFIX + entry.file);
      const docTitle = (entry && entry.title) ? entry.title : kbDocTitleOf(k);
      const titleLower = String(docTitle || '').toLowerCase();
      try {
        const text = await kbReadDocTextCached(env, k);
        if (!text) return null;
        const lower = text.toLowerCase();

        // 标题相关性加成
        let titleBonus = 0;
        for (const tk of tokens) {
          if (tk.length >= 2 && titleLower.indexOf(tk) !== -1) titleBonus += tk.length * 4;
        }

        // 1) 优先检查完整 query 精确子串
        const exactIdx = qLower ? lower.indexOf(qLower) : -1;
        if (exactIdx !== -1) {
          return { title: docTitle, text, bestOffset: exactIdx, score: 1000 + tokens.length * 10 + titleBonus };
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
          const hasLongTokenInQuery = tokens.some(t => t.length >= 2);
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
          return { title: docTitle, text, bestOffset: anchor, score: bestScore };
        }
        return null;
      } catch (e) { return null; }
    }));
    for (const h of batchHits) {
      if (h) candidates.push(h);
    }
  }

  if (!candidates.length) return null;
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
  return blocks.join('\n\n---\n\n') +
    '\n\n> （以上为正文相关性最高的片段；如需阅读某篇完整上下文，请用 read_doc 传入完整文档标题及对应 offset）';
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
    return '未找到标题包含"' + query + '"的文档。现有文档：\n' +
      reg.map(e => '- ' + (e.title || e.file)).join('\n');
  }
  const key = KB_DOCS_PREFIX + hit.file;
  try { await env.R2.delete(key); } catch (e) { return '删除失败：' + (hit.title || hit.file); }
  kbDocTextCache.delete(key);
  kbDocTextExp.delete(key);
  const okReg = await kbSaveRegistry(env, reg.filter(e => e !== hit));
  // v7.5.0：同步摘除该篇的分块索引，避免删完还能被检索命中
  try { await kbRemoveDocIndex(env, hit.file); } catch (e) {}
  if (!okReg) return '文档文件已删除，但注册表更新失败，列表可能仍显示旧条目；下次读取会自动重建注册表。《' + (hit.title || hit.file) + '》';
  return '已删除知识库文档《' + (hit.title || hit.file) + '》';
}

// v7.5.0 新增：分块检索工具 —— 知识库的"搜索引擎"入口
async function toolKbSearch(env, args) {
  args = args || {};
  const query = String(args.query || '').trim();
  if (!query) return '关键词为空，未检索知识库';
  if (!env.R2) return 'R2 未绑定，无法检索知识库';
  const topK = Math.max(1, Math.min(10, parseInt(args.top_k, 10) || 6));
  const res = await kbSearch(env, query, { topK, doc: args.doc });
  if (!res.hits || !res.hits.length) {
    const st = res.stats;
    return '知识库中没有检索到与「' + query + '」相关的内容'
      + (st && st.docs ? '（全库 ' + st.docs + ' 篇 / ' + st.chunks + ' 块）' : '')
      + '。可换更具体的关键词，或先用 list_docs 查看现有文档标题。';
  }
  return kbFormatHits(res);
}

// v7.5.0 新增：网页正文入库 —— 抓取 URL 正文并保存为知识库文档（自动去重 + 自动建索引）
async function toolKbIngest(env, chatId, args) {
  args = args || {};
  const url = String(args.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return 'URL 非法，仅支持 http/https';
  if (!env.R2) return 'R2 未绑定，无法写入知识库';
  let host = '';
  try { host = new URL(url).hostname; } catch (e) { return 'URL 非法，仅支持 http/https'; }
  if (isBlockedFetchHost(host)) return '该地址禁止抓取（内网 / 本机 / 云元数据地址）';
  const page = await getOrFetchPageText(url, 20000);
  if (!page || page.err) return '网页抓取失败：' + ((page && page.err) || '未知错误');
  const text = String(page.text || '').trim();
  if (text.length < 60) return '该网页没有可提取的正文内容，未入库';
  const title = String(args.title || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80) || (host + ' 网页摘录');
  const maxChars = kbConfig(env).maxDocChars;
  return await toolSaveDoc(env, chatId, { title, content: text.slice(0, maxChars), source: url });
}

export {
  docSearchTokens,
  toolSaveDoc,
  toolListDocs,
  toolReadDoc,
  kbSearchDocBody,
  toolDeleteDoc,
  toolKbSearch,
  toolKbIngest,
};
