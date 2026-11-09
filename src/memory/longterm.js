// L2 长期记忆：跨会话的用户事实、偏好、身份与长期任务。
//
// 相对旧版 src/agent/memory.js 的升级点（旧版行为全部保留，向后兼容）：
// 1) 每条记忆多了 kind（事实/偏好/身份/任务）、weight（1~5 权重）、hits（被召回次数）、
//    lastUsed（最近一次被用到的时间）——旧版只有 fact + ts，所有记忆权重一样，
//    既没法区分"用户叫张三"和"用户提过一次喜欢吃辣"，也没法按重要度淘汰；
// 2) 容量到顶（LT_MAX_ITEMS）时按衰减分淘汰最弱的那批，并且**淘汰的推进 L3 归档**，
//    不再像旧版那样只能一路膨胀到撑爆提示词；
// 3) 存储迁到 kb/mem3/long/<chatId>.json。旧键 kb/agent_mem_<chatId> 与更早的根目录键
//    agent_mem_<chatId> 仍会自动读取并迁移，迁移后旧键保留（体积很小，留作回滚副本）。
// 4) md 镜像照旧：每条记忆一个 Markdown 文件，供在 R2 控制台直接翻阅。

import { mapSetBounded, mapGetBounded } from '../utils.js';
import { withCoordinationLock } from '../coordination.js';
import { storeGet, storePutChecked } from '../store/r2.js';
import { agentMemKey, agentMemKeyLegacy, kbMemDir, kbNewMemFile, kbMemMarkdown,
  kbBackfillMd, kbDeleteKeys } from '../store/kb.js';
import {
  ltKey, memNorm, memSubjectKey, memDecayScore, memTokens,
  clampNum, clipText, memLimits, memSafeId, LT_MAX_ITEMS, MEM_KINDS, MEM_KIND_LABEL
} from './layers.js';
import { arPush } from './archive.js';

const ltCache = new Map();
const ltExp = new Map();
const LT_CACHE_TTL_MS = 60 * 1000;
const LT_CACHE_MAX = 500;

// 与存储键使用同一份有界 chatId 归一化，避免任意长/特殊字符进入 DO 锁名。
function ltLockName(chatId) {
  return 'memory:l2:' + (memSafeId(chatId) || 'default');
}

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

// 读索引：新键 → kb/agent_mem_ → 根目录 agent_mem_（逐级回退，读到就迁移）
export async function ltGet(env, chatId, opts) {
  // 持锁写路径必须重新读取持久化索引；其他 isolate 可能在上一轮读缓存后更新过它。
  const fresh = !!(opts && opts.fresh && env && env.R2);
  const cached = fresh ? null : mapGetBounded(ltCache, chatId, env && env.R2 ? ltExp : null);
  if (Array.isArray(cached)) return cloneList(cached);

  let arr = [];
  let raw = null;
  let migratedFrom = '';

  if (env && env.R2) {
    raw = await storeGet(env, ltKey(chatId));
    if (!raw) {
      const legacy = await storeGet(env, agentMemKey(chatId));
      if (legacy) { raw = legacy; migratedFrom = 'kb'; }
    }
    if (!raw) {
      const oldest = await storeGet(env, agentMemKeyLegacy(chatId));
      if (oldest) { raw = oldest; migratedFrom = 'root'; }
    }
  }

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // 归一化 + 完全重复合并（保留较新的那条），并收集需要清理的孤儿 md
        const clean = [];
        const seen = new Map();
        const orphanMd = [];
        for (const item of parsed) {
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
        arr = clean;
        if (clean.length !== parsed.length) {
          // 索引写成功才删孤儿 md：写失败时保持原样，下次加载会重试
          try {
            if (await storePutChecked(env, ltKey(chatId), JSON.stringify(clean))) {
              if (orphanMd.length) await kbDeleteKeys(env, orphanMd);
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
  }

  // 迁移：读到了旧键就写一份到新键（旧键保留，出问题可直接回滚）
  if (migratedFrom && env && env.R2) {
    await storePutChecked(env, ltKey(chatId), JSON.stringify(arr));
  }

  // 回补 md 镜像：给缺 file 字段的老条目分配文件名并补建
  try {
    if (await kbBackfillMd(env, chatId, arr)) {
      await storePutChecked(env, ltKey(chatId), JSON.stringify(arr));
    }
  } catch (e) {}

  mapSetBounded(ltCache, chatId, cloneList(arr), LT_CACHE_MAX, ltExp, LT_CACHE_TTL_MS);
  return arr;
}

// 只写索引（用于命中计数这类高频小改动，不重写 md 镜像）
async function ltPutIndex(env, chatId, arr) {
  mapSetBounded(ltCache, chatId, cloneList(arr), LT_CACHE_MAX, ltExp, LT_CACHE_TTL_MS);
  if (!env || !env.R2) return false;
  return await storePutChecked(env, ltKey(chatId), JSON.stringify(arr));
}

// 超容量时按衰减分淘汰，返回 { kept, dropped }
function evictOverflow(arr, maxItems, halflifeDays) {
  const cap = maxItems > 0 ? maxItems : LT_MAX_ITEMS;
  if (arr.length <= cap) return { kept: arr, dropped: [] };
  const now = Date.now();
  const ranked = arr.slice().sort((a, b) =>
    memDecayScore(a, now, halflifeDays) - memDecayScore(b, now, halflifeDays));
  const dropSet = new Set(ranked.slice(0, arr.length - cap));
  const kept = [];
  const dropped = [];
  for (const m of arr) (dropSet.has(m) ? dropped : kept).push(m);
  return { kept, dropped };
}

export async function ltSave(env, chatId, fact, opts) {
  return await withCoordinationLock(env, ltLockName(chatId), () => doLtSave(env, chatId, fact, opts || {}));
}

async function doLtSave(env, chatId, fact, o) {
  const text = clipText(String(fact == null ? '' : fact).trim(), 200);
  if (!text) return '内容为空，未保存';
  const kind = MEM_KINDS.indexOf(o.kind) !== -1 ? o.kind : 'fact';
  const weight = Math.round(clampNum(o.weight, 1, 5, 3));

  const arr = await ltGet(env, chatId, { fresh: true });
  const norm = memNorm(text);

  // 完全重复：不新增条目，只提升命中次数（说明这件事被反复提起，重要性在上升）
  const dupIdx = arr.findIndex(m => memNorm(m.fact) === norm);
  if (dupIdx !== -1) {
    arr[dupIdx].hits = (Number(arr[dupIdx].hits) || 0) + 1;
    arr[dupIdx].lastUsed = Date.now();
    if (o.weight != null) arr[dupIdx].weight = weight;
    await ltPutIndex(env, chatId, arr);
    return '已记住过，无需重复保存（已把命中次数提到 ' + arr[dupIdx].hits + ' 次）：' + text;
  }

  // 同主题覆盖：改口即更新（"我的手机号是 A" → "…是 B"）
  const key = memSubjectKey(text);
  const replacedFiles = [];
  let oldFact = '';
  let oldTs = 0;
  if (key) {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (memSubjectKey(arr[i].fact) === key) {
        if ((arr[i].ts || 0) >= oldTs) { oldTs = arr[i].ts || 0; oldFact = arr[i].fact; }
        if (arr[i].file) replacedFiles.push(kbMemDir(chatId) + arr[i].file);
        arr.splice(i, 1);
      }
    }
  }
  const replaced = !!oldFact;

  const entry = {
    fact: text,
    ts: Date.now(),
    file: kbNewMemFile(),
    kind,
    weight,
    hits: 0,
    lastUsed: 0
  };
  arr.push(entry);

  // 容量控制：淘汰排序与检索共用环境配置的半衰期。
  const limits = memLimits(env);
  const { kept, dropped } = evictOverflow(arr, limits.l2, limits.halflifeDays);
  const next = kept;
  const replNote = replaced ? '（本条自动覆盖了旧记忆《' + oldFact + '》）' : '';

  // 先归档 dropped，再提交新索引或内存淘汰。归档失败时原索引、原缓存和 md
  // 镜像全部保持不动，调用方可以安全重试，不会先丢掉长期记忆正文。
  if (dropped.length) {
    let archived;
    try {
      archived = await arPush(env, chatId, dropped.map(m => ({
        type: 'memory',
        text: clipText('[' + (MEM_KIND_LABEL[m.kind] || '事实') + '] ' + m.fact, 200),
        ts: m.ts
      })));
    } catch (e) {
      archived = { added: 0, persisted: false, error: e && e.message };
    }
    const archiveOk = archived && archived.added === dropped.length && (!env || !env.R2 || archived.persisted === true);
    if (!archiveOk) {
      return 'L2 淘汰归档失败，未更新长期记忆索引，也未淘汰任何记忆' + replNote
        + '；请检查 R2 绑定与权限后重试：' + text;
    }
  }

  // 未绑定 R2：归档与索引都只留内存，必须如实告知。
  if (!env || !env.R2) {
    mapSetBounded(ltCache, chatId, cloneList(next), LT_CACHE_MAX, ltExp, LT_CACHE_TTL_MS);
    return '已暂存于内存（R2 未绑定，Worker 重启后会丢失；按 README 第二步绑定 R2 后可永久记住）'
      + replNote + '：' + text;
  }

  // md 镜像与 JSON 索引互不依赖，并行写入省掉一次往返。
  const [okMd, okIdx] = await Promise.all([
    storePutChecked(env, kbMemDir(chatId) + entry.file, kbMemMarkdown(chatId, text, entry.ts, { kind, weight })),
    storePutChecked(env, ltKey(chatId), JSON.stringify(next))
  ]);
  mapSetBounded(ltCache, chatId, cloneList(next), LT_CACHE_MAX, ltExp, LT_CACHE_TTL_MS);

  if (!okMd || !okIdx) {
    return '记忆写入 R2 失败，已暂存于内存' + replNote + '；请检查 R2 绑定与权限后重试：' + text;
  }
  // 索引落盘成功后才清理被覆盖条目的 md 镜像。
  if (replacedFiles.length) await kbDeleteKeys(env, replacedFiles);

  const kindNote = kind !== 'fact' ? '（' + (MEM_KIND_LABEL[kind] || kind) + '·权重' + weight + '）' : '';
  const evictNote = dropped.length ? '；容量已满，' + dropped.length + ' 条最弱记忆已归档到 L3（可用 memory search 找回）' : '';
  if (replaced) return '已自动更新记忆：旧《' + oldFact + '》→ 新《' + text + '》' + kindNote + '（共' + next.length + '条' + evictNote + '）';
  return '已记住' + kindNote + '：' + text + '（共' + next.length + '条' + evictNote + '）';
}

export async function ltForget(env, chatId, keyword) {
  return await withCoordinationLock(env, ltLockName(chatId), () => doLtForget(env, chatId, keyword));
}

async function doLtForget(env, chatId, keyword) {
  const kw = String(keyword == null ? '' : keyword).trim();
  if (!kw) return { removed: 0 };
  const arr = await ltGet(env, chatId, { fresh: true });
  const kept = arr.filter(m => String(m.fact || '').indexOf(kw) < 0);
  const removed = arr.length - kept.length;
  if (!removed) return { removed: 0 };

  const keptSet = new Set(kept);
  const files = [];
  for (const m of arr) {
    if (!keptSet.has(m) && m && m.file) files.push(kbMemDir(chatId) + m.file);
  }

  if (!env || !env.R2) {
    mapSetBounded(ltCache, chatId, cloneList(kept), LT_CACHE_MAX, ltExp, LT_CACHE_TTL_MS);
    if (files.length) await kbDeleteKeys(env, files);
    return { removed };
  }
  const okIdx = await storePutChecked(env, ltKey(chatId), JSON.stringify(kept));
  if (!okIdx) {
    return { removed: 0, persistError: '记忆索引写入 R2 失败，未删除任何记忆；请检查 R2 绑定与权限后重试' };
  }
  mapSetBounded(ltCache, chatId, cloneList(kept), LT_CACHE_MAX, ltExp, LT_CACHE_TTL_MS);
  if (files.length) await kbDeleteKeys(env, files);
  return { removed };
}

// 命中计数：被提示词注入/被检索命中时调用。只改内存缓存，不落盘——
// 每轮都写一次 R2 的代价远高于这点统计价值；真正落盘发生在下次 remember / forget。
export async function ltTouch(env, chatId, facts) {
  const list = Array.isArray(facts) ? facts : [];
  if (!list.length) return;
  const cached = mapGetBounded(ltCache, chatId, env && env.R2 ? ltExp : null);
  if (!Array.isArray(cached)) return;
  const set = new Set(list.map(f => memNorm(f)));
  const now = Date.now();
  let changed = false;
  for (const m of cached) {
    if (set.has(memNorm(m.fact))) {
      m.hits = Math.min(9999, (Number(m.hits) || 0) + 1);
      m.lastUsed = now;
      changed = true;
    }
  }
  if (changed) mapSetBounded(ltCache, chatId, cached, LT_CACHE_MAX, ltExp, LT_CACHE_TTL_MS);
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
