// Agent 工具：知识库文档的保存 / 列表 / 读取（支持分页 offset） / 多关键词分词检索 / 删除
// v7.1.0 性能优化：新增文档正文 L1 内存缓存（支持长文档 0ms 翻页与多轮全文检索加速）+ 标题/词频加权相关性算法

import { mapSetBounded, mapGetBounded } from '../utils.js';
import { storePutChecked } from '../store/r2.js';
import { kbSafeChatId } from '../store/kb.js';
import { KB_DOCS_PREFIX, kbDocSlug, kbNormSource, kbDocTitleOf, kbGetRegistry,
  kbSaveRegistry, kbFindRegEntry, kbFmtSize, kbFmtDate } from './registry.js';

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
  return '知识库文档（共' + reg.length + '篇）：\n' +
    reg.map((e, i) => (i + 1) + '. ' + (e.title || e.file) + '（' + kbFmtSize(e.size) + '，' + kbFmtDate(e.updated_at) + '）').join('\n');
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
  // 标题无命中 → 全文多关键词相关性检索（最多查 30 篇，返回 Top 3 命中片段）
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
  if (!okReg) return '文档文件已删除，但注册表更新失败，列表可能仍显示旧条目；下次读取会自动重建注册表。《' + (hit.title || hit.file) + '》';
  return '已删除知识库文档《' + (hit.title || hit.file) + '》';
}

export {
  docSearchTokens,
  toolSaveDoc,
  toolListDocs,
  toolReadDoc,
  kbSearchDocBody,
  toolDeleteDoc,
};
