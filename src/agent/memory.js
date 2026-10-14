// Agent 长期记忆（JSON 索引为唯一可信源 + md 只读镜像）（_worker.js 原第 703-704,707-784 行）

import { mapSetBounded } from '../utils.js';
import { storeGet, storePutChecked, storeDelete } from '../store/r2.js';
import { agentMemKey, agentMemKeyLegacy, kbMemDir, kbNewMemFile, kbMemMarkdown,
  kbBackfillMd, kbDeleteKeys } from '../store/kb.js';

// ==================== Telegram Agent：长期记忆 + 开关 ====================
const tgAgentMemCache = new Map();
async function agentGetMemories(env, chatId) {
  if (tgAgentMemCache.has(chatId)) return tgAgentMemCache.get(chatId);
  let arr = [];
  // v6.6.6 起知识库搬入 kb/ 文件夹：先读新 key；若为空再尝试旧 key，
  // 读到旧数据立即搬迁（写新 key + 删旧 key），老部署升级不丢记忆。
  let raw = await storeGet(env, agentMemKey(chatId));
  if (!raw) {
    const legacy = await storeGet(env, agentMemKeyLegacy(chatId));
    if (legacy) {
      raw = legacy;
      // v6.8.4：先确认新 key 写成功再删旧 key——之前静默写入失败后仍删旧 key 会丢数据
      const okMig = await storePutChecked(env, agentMemKey(chatId), legacy);
      if (okMig) await storeDelete(env, agentMemKeyLegacy(chatId));
    }
  }
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) {
        // v6.8.6 索引校验：过滤脏条目（非对象 / fact 缺失或非字符串），
        // 防止手改或历史 bug 留下的坏数据把 Agent 记忆整体搞挂
        const clean = p.filter(m => m && typeof m.fact === 'string' && m.fact);
        if (clean.length !== p.length) {
          try { await storePutChecked(env, agentMemKey(chatId), JSON.stringify(clean)); } catch (e) {}
        }
        arr = clean;
      }
    } catch (e) {}
  }
  // v6.6.7：回补 md 镜像 —— 老条目自动分配文件名并建 md；控制台误删的 md 也会按索引重建
  try {
    if (await kbBackfillMd(env, chatId, arr)) {
      // v6.8.4：回补索引写入改用 checked；失败不影响本次内存读取，下次加载/保存会重试
      await storePutChecked(env, agentMemKey(chatId), JSON.stringify(arr));
    }
  } catch (e) {}
  mapSetBounded(tgAgentMemCache, chatId, arr);
  return arr;
}

async function agentSaveMemory(env, chatId, fact) {
  const arr = await agentGetMemories(env, chatId);
  fact = String(fact || '').trim().slice(0, 200);
  if (!fact) return '内容为空，未保存';
  if (arr.some(m => m.fact === fact)) return '已记住过，无需重复保存';
  // v6.6.7：条目带 file 字段；先写 md 镜像再写索引（索引是唯一可信源）
  const m = { fact: fact, ts: Date.now(), file: kbNewMemFile() };
  arr.push(m);
  // v6.4.1 起彻底不限条数：R2 单对象可达 5TB，且每次 prompt 只按预算注入，
  // 条数增长不影响 token 成本；remember 需用户明确要求才会触发，无失控风险。
  mapSetBounded(tgAgentMemCache, chatId, arr);
  // v6.8.3：未绑定 R2 时只留内存，必须如实告知——之前会谎称"已记住"，重启就丢
  if (!env.R2) {
    return '已暂存于内存（R2 未绑定，Worker 重启后会丢失；按 README 第二步绑定 R2 后可永久记住）：' + fact;
  }
  const okMd = await storePutChecked(env, kbMemDir(chatId) + m.file, kbMemMarkdown(chatId, fact, m.ts));
  const okIdx = await storePutChecked(env, agentMemKey(chatId), JSON.stringify(arr));
  if (!okMd || !okIdx) return '记忆写入 R2 失败，已暂存于内存；请检查 R2 绑定与权限后重试：' + fact;
  return '已记住：' + fact + '（共' + arr.length + '条）';
}

async function agentForgetMemory(env, chatId, keyword) {
  keyword = String(keyword || '').trim();
  if (!keyword) return { removed: 0 };
  const arr = await agentGetMemories(env, chatId);
  const kept = arr.filter(m => String(m.fact || '').indexOf(keyword) < 0);
  const removed = arr.length - kept.length;
  if (removed > 0) {
    // v6.6.7：同步删除被删条目的 md 镜像
    const keptSet = new Set(kept);
    const files = [];
    for (const m of arr) {
      if (!keptSet.has(m) && m && m.file) files.push(kbMemDir(chatId) + m.file);
    }
    // v6.8.4：索引写入失败时不更新缓存并如实报错，否则"删了但重启又复活"
    if (!env.R2) {
      mapSetBounded(tgAgentMemCache, chatId, kept);
      if (files.length) await kbDeleteKeys(env, files);
      return { removed: removed };
    }
    const okIdx = await storePutChecked(env, agentMemKey(chatId), JSON.stringify(kept));
    if (!okIdx) {
      return { removed: 0, persistError: '记忆索引写入 R2 失败，未删除任何记忆；请检查 R2 绑定与权限后重试' };
    }
    mapSetBounded(tgAgentMemCache, chatId, kept);
    if (files.length) await kbDeleteKeys(env, files);
  }
  return { removed: removed };
}

export {
  tgAgentMemCache,
  agentGetMemories,
  agentSaveMemory,
  agentForgetMemory,
};
