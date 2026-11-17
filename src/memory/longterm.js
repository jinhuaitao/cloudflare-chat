// L2 长期记忆：跨会话的用户事实、偏好、身份与长期任务。
//
// 相对旧版 src/agent/memory.js 的升级点（旧版行为全部保留，向后兼容）：
// 1) 每条记忆多了 kind（事实/偏好/身份/任务）、weight（1~5 权重）、hits（被召回次数）、
//    lastUsed（最近一次被用到的时间）——旧版只有 fact + ts，所有记忆权重一样，
//    既没法区分"用户叫张三"和"用户提过一次喜欢吃辣"，也没法按重要度淘汰；
// 2) 容量到顶（LT_MAX_ITEMS）时按衰减分淘汰最弱的那批，并且**淘汰的推进 L3 归档**，
//    不再像旧版那样只能一路膨胀到撑爆提示词；
// 3) md 镜像照旧：每条记忆一个 Markdown 文件，供在 R2 控制台直接翻阅。
//
// v7.20.0 存储升级：与 L1/L3 合并为 kb/mem3/<chatId>.json 单对象（store.js 统一 CAS）。
//   · 旧键（kb/mem3/long/、kb/agent_mem_、根目录 agent_mem_）由 store.js 一次性迁移，保留回滚；
//   · 淘汰归档并入同一次 CAS 写入（原子）；
//   · 命中计数（ltTouch）仍只改内存，但会搭每轮 L1 写入免费落盘——
//     旧版 hits 永不落盘，重启即清零，衰减淘汰其实反映不了真实使用频率。

import { storePutChecked } from '../store/r2.js';
import { memSnapshot, memMutate, memTouchCached } from './store.js';
import { kbMemDir, kbNewMemFile, kbMemMarkdown, kbBackfillMd, kbDeleteKeys } from '../store/kb.js';
import {
  memNorm, memSubjectKey, memDecayScore, memTokens,
  clampNum, clipText, memLimits, LT_MAX_ITEMS, MEM_KINDS, MEM_KIND_LABEL
} from './layers.js';
import { applyArchiveRecords } from './archive.js';

function normalizeEntry(m) {
  if (!(m && typeof m.fact === 'string' && m.fact)) return null;
  const fact = clipText(m.fact.trim(), 200);
  if (!fact) return null;
  return {
    fact,
    ts: Number(m.ts) || 0,
    file: typeof m.file === 'string' ? m.file : '',
    kind: MEM_KINDS.indexOf(m.kind) !== -1 ? m.kind : 'fact',
    weight: clampNum(m.weight, 1, 5, 3),
    hits: Math.max(0, Math.min(9999, Number(m.hits) || 0)),
    lastUsed: Number(m.lastUsed) || 0
  };
}

function cloneEntry(m) {
  return {
    fact: m.fact, ts: m.ts, file: m.file, kind: m.kind,
    weight: m.weight, hits: m.hits, lastUsed: m.lastUsed
  };
}

function cloneList(arr) { return arr.map(cloneEntry); }

// 归一化 + 完全重复合并（保留较新的那条），并收集需要清理的孤儿 md。
// 纯函数：ltGet 投影与清理 mutator 共用，CAS 冲突重跑时行为一致。
function dedupeEntries(raw, chatId) {
  const clean = [];
  const seen = new Map();
  const orphanMd = [];
  const list = Array.isArray(raw) ? raw : [];
  for (const item of list) {
    const m = normalizeEntry(item);
    if (!m) continue;
    const n = memNorm(m.fact);
    const prevIdx = seen.get(n);
    if (prevIdx === undefined) {
      seen.set(n, clean.length);
      clean.push(m);
    } else {
      const prev = clean[prevIdx];
      if (m.ts > prev.ts) {
        clean[prevIdx] = m;
        if (prev.file && prev.file !== m.file) orphanMd.push(kbMemDir(chatId) + prev.file);
      } else if (m.file && m.file !== prev.file) {
        orphanMd.push(kbMemDir(chatId) + m.file);
      }
    }
  }
  return { arr: clean, orphanMd, changed: clean.length !== list.length };
}

// 读：统一快照的 L2 投影。顺带做两件只发生在旧数据上的事：
// 完全重复合并（写回清理后的索引）与 md 镜像回补（缺 file 的老条目补建）。
// 两者合并成一次 CAS 写入；稳态数据（无重复、全有 file）零额外开销。
export async function ltGet(env, chatId) {
  const snap = await memSnapshot(env, chatId);
  const { arr, changed } = dedupeEntries(snap.long, chatId);

  let backfilled = false;
  try { backfilled = await kbBackfillMd(env, chatId, arr); } catch (e) {}

  if (changed || backfilled) {
    const fileByFact = new Map();
    if (backfilled) for (const m of arr) if (m.file) fileByFact.set(memNorm(m.fact), m.file);
    let cleanupOrphans = [];
    const res = await memMutate(env, chatId, draft => {
      const d = dedupeEntries(draft.long, chatId);
      cleanupOrphans = d.orphanMd;
      if (backfilled) {
        for (const m of d.arr) {
          if (!m.file) {
            const f = fileByFact.get(memNorm(m.fact));
            if (f) m.file = f;
          }
        }
      }
      draft.long = d.arr;
    });
    // 索引写成功才删孤儿 md：写失败时保持原样，下次加载会重试
    if (res.ok && cleanupOrphans.length) await kbDeleteKeys(env, cleanupOrphans);
  }
  return cloneList(arr);
}

// 超容量时按衰减分淘汰，返回 { kept, dropped }
function evictOverflow(arr, maxItems) {
  const cap = maxItems > 0 ? maxItems : LT_MAX_ITEMS;
  if (arr.length <= cap) return { kept: arr, dropped: [] };
  const now = Date.now();
  const ranked = arr.slice().sort((a, b) => memDecayScore(a, now) - memDecayScore(b, now));
  const dropSet = new Set(ranked.slice(0, arr.length - cap));
  const kept = [];
  const dropped = [];
  for (const m of arr) (dropSet.has(m) ? dropped : kept).push(m);
  return { kept, dropped };
}

export async function ltSave(env, chatId, fact, opts) {
  const o = opts || {};
  const text = clipText(String(fact == null ? '' : fact).trim(), 200);
  if (!text) return '内容为空，未保存';
  const kind = MEM_KINDS.indexOf(o.kind) !== -1 ? o.kind : 'fact';
  const weight = Math.round(clampNum(o.weight, 1, 5, 3));
  const norm = memNorm(text);
  const subject = memSubjectKey(text);

  // mutator 闭包变量：CAS 冲突重跑时以最后一轮为准
  let isDup = false;
  let dupHits = 0;
  let replaced = false;
  let oldFact = '';
  let entry = null;
  let dropped = [];
  let nextLen = 0;
  let replacedFiles = [];

  const res = await memMutate(env, chatId, draft => {
    const arr = draft.long.map(normalizeEntry).filter(Boolean);
    isDup = false; replaced = false; oldFact = ''; dropped = []; replacedFiles = [];

    // 完全重复：不新增条目，只提升命中次数（说明这件事被反复提起，重要性在上升）
    const dupIdx = arr.findIndex(m => memNorm(m.fact) === norm);
    if (dupIdx !== -1) {
      isDup = true;
      arr[dupIdx].hits = (Number(arr[dupIdx].hits) || 0) + 1;
      arr[dupIdx].lastUsed = Date.now();
      if (o.weight != null) arr[dupIdx].weight = weight;
      dupHits = arr[dupIdx].hits;
      draft.long = arr;
      nextLen = arr.length;
      return;
    }

    // 同主题覆盖：改口即更新（"我的手机号是 A" → "…是 B"）
    if (subject) {
      let oldTs = 0;
      for (let i = arr.length - 1; i >= 0; i--) {
        if (memSubjectKey(arr[i].fact) === subject) {
          if ((arr[i].ts || 0) >= oldTs) { oldTs = arr[i].ts || 0; oldFact = arr[i].fact; }
          if (arr[i].file) replacedFiles.push(kbMemDir(chatId) + arr[i].file);
          arr.splice(i, 1);
        }
      }
    }
    replaced = !!oldFact;

    entry = { fact: text, ts: Date.now(), file: kbNewMemFile(), kind, weight, hits: 0, lastUsed: 0 };
    arr.push(entry);

    // 容量控制：淘汰最弱的，与索引同一次写入推进 L3 归档（原子，不丢）
    const ev = evictOverflow(arr, memLimits(env).l2);
    dropped = ev.dropped;
    draft.long = ev.kept;
    nextLen = ev.kept.length;
    if (dropped.length) {
      draft.archive.items = applyArchiveRecords(draft.archive.items, dropped.map(m => ({
        type: 'memory',
        text: clipText('[' + (MEM_KIND_LABEL[m.kind] || '事实') + '] ' + m.fact, 200),
        ts: m.ts
      })), memLimits(env).l3);
    }
  });

  const replNote = replaced ? '（本条自动覆盖了旧记忆《' + oldFact + '》）' : '';
  if (isDup) {
    return '已记住过，无需重复保存（已把命中次数提到 ' + dupHits + ' 次）：' + text;
  }
  // 未绑定 R2：只留内存，必须如实告知
  if (!env || !env.R2) {
    return '已暂存于内存（R2 未绑定，Worker 重启后会丢失；按 README 第二步绑定 R2 后可永久记住）'
      + replNote + '：' + text;
  }
  if (!res.ok) {
    return '记忆写入 R2 失败，已暂存于内存' + replNote + '；请检查 R2 绑定与权限后重试：' + text;
  }

  // md 镜像在索引落盘后写（索引是唯一可信源，镜像只是可读副本）
  const okMd = await storePutChecked(env, kbMemDir(chatId) + entry.file,
    kbMemMarkdown(chatId, text, entry.ts, { kind, weight }));
  if (!okMd) {
    return '记忆写入 R2 失败，已暂存于内存' + replNote + '；请检查 R2 绑定与权限后重试：' + text;
  }
  // 索引落盘成功后才清理被覆盖条目的 md 镜像
  if (replacedFiles.length) await kbDeleteKeys(env, replacedFiles);

  const kindNote = kind !== 'fact' ? '（' + (MEM_KIND_LABEL[kind] || kind) + '·权重' + weight + '）' : '';
  const evictNote = dropped.length ? '；容量已满，' + dropped.length + ' 条最弱记忆已归档到 L3（可用 memory search 找回）' : '';
  if (replaced) return '已自动更新记忆：旧《' + oldFact + '》→ 新《' + text + '》' + kindNote + '（共' + nextLen + '条' + evictNote + '）';
  return '已记住' + kindNote + '：' + text + '（共' + nextLen + '条' + evictNote + '）';
}

export async function ltForget(env, chatId, keyword) {
  const kw = String(keyword == null ? '' : keyword).trim();
  if (!kw) return { removed: 0 };
  let removed = 0;
  let files = [];
  const res = await memMutate(env, chatId, draft => {
    const arr = draft.long.map(normalizeEntry).filter(Boolean);
    const kept = arr.filter(m => String(m.fact || '').indexOf(kw) < 0);
    removed = arr.length - kept.length;
    if (!removed) return false;
    files = [];
    const keptSet = new Set(kept);
    for (const m of arr) {
      if (!keptSet.has(m) && m && m.file) files.push(kbMemDir(chatId) + m.file);
    }
    draft.long = kept;
  });
  if (!removed) return { removed: 0 };
  if (env && env.R2 && !res.ok) {
    return { removed: 0, persistError: '记忆索引写入 R2 失败，未删除任何记忆；请检查 R2 绑定与权限后重试' };
  }
  if (files.length) await kbDeleteKeys(env, files);
  return { removed };
}

// 命中计数：被提示词注入/被检索命中时调用。只改内存缓存，不单独落盘——
// 每轮都写一次 R2 的代价远高于这点统计价值。v7.20.0 合并单对象后，
// 这些计数会搭下一次真实写入（机器人端每轮的 L1 要点）免费落盘，
// 重启不再清零，衰减淘汰终于能反映真实使用频率。
export async function ltTouch(env, chatId, facts) {
  const list = Array.isArray(facts) ? facts : [];
  if (!list.length) return;
  const set = new Set(list.map(f => memNorm(f)));
  const now = Date.now();
  memTouchCached(env, chatId, snap => {
    for (const m of snap.long) {
      if (set.has(memNorm(m.fact))) {
        m.hits = Math.min(9999, (Number(m.hits) || 0) + 1);
        m.lastUsed = now;
      }
    }
  });
}

// 按相关性打分（供 memory search 与提示词排序共用）
// opts.includeAll=true 时，与提问无关的记忆也会按衰减分排在后面一起返回——
// 提示词需要"用户画像"的完整性（高权重偏好即使与本次提问无关也该被模型看到），
// 而检索只需要命中项。两种用途共用同一套打分，避免排序口径分裂。
export function rankLongterm(arr, query, limit, opts) {
  const list = Array.isArray(arr) ? arr : [];
  const includeAll = !!(opts && opts.includeAll);
  const hl = (opts && opts.halflifeDays) > 0 ? opts.halflifeDays : undefined;
  const qTokens = [...new Set(memTokens(query))];
  const now = Date.now();
  if (!qTokens.length) {
    return list.slice().sort((a, b) => memDecayScore(b, now, hl) - memDecayScore(a, now, hl))
      .slice(0, limit > 0 ? limit : list.length);
  }
  const scored = [];
  for (const m of list) {
    const fSet = new Set(memTokens(m.fact));
    let rel = 0;
    for (const t of qTokens) {
      if (fSet.has(t)) rel += t.length >= 2 ? 2 : 1;
    }
    if (!rel && !includeAll) continue;
    scored.push({ m, rel, score: memDecayScore(m, now, hl) });
  }
  scored.sort((a, b) => (b.rel - a.rel) || (b.score - a.score));
  return scored.slice(0, limit > 0 ? limit : scored.length).map(s => s.m);
}

export async function ltSearch(env, chatId, query, limit) {
  const arr = await ltGet(env, chatId);
  const hits = rankLongterm(arr, query, limit > 0 ? limit : 8, { halflifeDays: memLimits(env).halflifeDays });
  await ltTouch(env, chatId, hits.map(m => m.fact));
  return hits;
}

export { LT_MAX_ITEMS, MEM_KIND_LABEL };