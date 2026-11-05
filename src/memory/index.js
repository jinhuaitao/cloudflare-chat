// 三层记忆统一编排：加载、提示词渲染、统一检索、统计、写入。
//
// 这一层只做"编排"，不碰存储细节：
//   · 加载：并行读 L1/L2/L3，任何一层失败都退化成空，绝不拖垮整轮对话；
//   · 渲染：三层各有预算（L1 1600 / L2 3000 / L3 900 字符），互不挤占，
//            L2 按「相关性优先、衰减分次序」挑选，避免 240 条记忆把上下文撑爆；
//   · 检索：memory 工具的统一入口，一次问三层，回答里标明每条来自哪一层；
//   · 写入：回合结束后写 L1（只有机器人端），remember 写 L2，溢出/淘汰自动进 L3。

import { wmGet, wmRecordTurn, wmPin, wmUnpin, wmClear, wmDigestLines } from './working.js';
import { ltGet, ltSave, ltForget, ltTouch, ltSearch, rankLongterm, MEM_KIND_LABEL } from './longterm.js';
import { arGet, arSearch, rankArchive, arPush, arClear } from './archive.js';
import { clipText, memDecayScore, memLimits, memBudgets, MEM_PROMPT_BUDGET } from './layers.js';

// 三层各自的注入预算（字符）。默认加起来 5500，占 AGENT_CONTEXT_BUDGET(24000) 的 23%，
// 与工具输出预算互不冲突；真到极限时 trimAgentMessages 还会再兜一层。
// 可用 MEM_PROMPT_BUDGET 调整总量，仍按 16:30:9 分配。
export const MEM_BUDGET = memBudgets(MEM_PROMPT_BUDGET);

// "在回忆"的语义信号：命中这些词但词面没匹配上时，用最近归档兜底
const RECALL_INTENT = /(之前|上次|以前|那次|曾经|还记得|记得|刚才说|之前说)/;

// ---------- 加载 ----------
export async function memoryLoad(env, chatId, query, opts) {
  const o = opts || {};
  // Web 只读端不读 L2/L3：它的 chatId 是 web_<sid>，本来就查不到别人的记忆，
  // 少两次 R2 往返还能让首字更快。L1 仍然读（会话内脉络对网页端同样有用）。
  const skipDeep = !!o.readOnly;
  const [working, longterm, archive] = await Promise.all([
    wmGet(env, chatId).catch(() => ({ items: [], pins: [] })),
    skipDeep ? Promise.resolve([]) : ltGet(env, chatId).catch(() => []),
    skipDeep ? Promise.resolve({ items: [] }) : arGet(env, chatId).catch(() => ({ items: [] }))
  ]);
  const wm = working || { items: [], pins: [] };
  const lt = Array.isArray(longterm) ? longterm : [];
  const ar = archive || { items: [] };
  const budgets = memBudgets(memLimits(env).promptBudget);

  // 命中计数只更新内存缓存（不落盘），让"常被用到的事实"在后续淘汰中更抗跌
  if (lt.length) {
    try {
      const picked = pickLongterm(lt, query, budgets.L2);
      await ltTouch(env, chatId, picked.map(m => m.fact));
    } catch (e) {}
  }

  return {
    working: wm,
    longterm: lt,
    archive: ar,
    budgets: budgets,
    query: String(query || ''),
    stats: {
      l1Items: Array.isArray(wm.items) ? wm.items.length : 0,
      l1Pins: Array.isArray(wm.pins) ? wm.pins.length : 0,
      l2: lt.length,
      l3: Array.isArray(ar.items) ? ar.items.length : 0
    }
  };
}

// L2 挑选：相关性优先，同相关性看衰减分；按预算截断。
// includeAll 让"与本次提问无关但权重高"的记忆也能进来（用户画像的完整性），
// 只是排在命中项之后——旧版全量注入的行为在这里被保留下来。
export function pickLongterm(arr, query, budget) {
  const list = Array.isArray(arr) ? arr : [];
  if (!list.length) return [];
  const ranked = rankLongterm(list, query, list.length, { includeAll: true });
  const out = [];
  let left = budget > 0 ? budget : MEM_BUDGET.L2;
  for (const m of ranked) {
    const f = String(m.fact || '');
    if (!f) continue;
    if (f.length > left) continue;
    out.push(m);
    left -= f.length;
  }
  return out;
}

// ---------- 提示词渲染 ----------
export function memoryPromptBlock(bundle, query) {
  if (!bundle) return '';
  const q = query != null ? query : (bundle.query || '');
  const budget = bundle.budgets || MEM_BUDGET;
  const blocks = [];

  // L1
  const wm = bundle.working || { items: [], pins: [] };
  const dg = wmDigestLines(wm, budget.L1);
  if (dg.text) {
    blocks.push('【三层记忆 · L1 工作记忆（本会话，短时；共' + dg.items + '个话题'
      + (dg.pins ? '、' + dg.pins + '条固定' : '') + '）】\n' + dg.text);
  }

  // L2
  const lt = Array.isArray(bundle.longterm) ? bundle.longterm : [];
  if (lt.length) {
    const picked = pickLongterm(lt, q, budget.L2);
    if (picked.length) {
      const lines = picked.map(m => {
        const label = m.kind && m.kind !== 'fact' ? '[' + (MEM_KIND_LABEL[m.kind] || m.kind) + '·权重' + (m.weight || 3) + '] ' : '';
        return '- ' + label + m.fact;
      });
      blocks.push('【三层记忆 · L2 用户长期记忆（持久，共' + lt.length + '条'
        + (picked.length < lt.length ? '，按相关性与强度注入' + picked.length + '条' : '') + '）】\n'
        + lines.join('\n'));
    }
  }

  // L3
  const arItems = bundle.archive && Array.isArray(bundle.archive.items) ? bundle.archive.items : [];
  if (arItems.length) {
    let hits = rankArchive(arItems, q, 3);
    // 用户明确在"回忆"（之前/上次/还记得…）却没命中关键词时，给最近 2 条归档兜底——
    // 归档的价值就在"想不起来叫什么、但记得有这么回事"，纯词面匹配在这里太严。
    if (!hits.length && RECALL_INTENT.test(String(q || ''))) {
      hits = arItems.slice(-2).reverse();
    }
    if (hits.length) {
      const lines = hits.map(h => '- ' + h.text + (h.ts ? '（' + fmtDay(h.ts) + '）' : ''));
      blocks.push('【三层记忆 · L3 历史归档（自动沉淀，共' + arItems.length + '条，命中' + hits.length + '条）】\n'
        + lines.join('\n'));
    }
  }

  if (!blocks.length) return '';
  return blocks.join('\n\n') + '\n\n'
    + '记忆用法：L1 是本会话的即时脉络，L2 是用户长期事实与偏好，L3 是被淘汰/沉淀的历史。'
    + '冲突时按「L1（本会话最新）> L2 > L3」取值，并在回答里说明"与之前记录不同，已按你最新说法"。'
    + '记忆只用于个性化，不要主动罗列；用户问"你记得我什么"时才逐条说明。\n\n';
}

function fmtDay(ts) {
  try {
    const d = new Date(ts);
    const m = d.getMonth() + 1;
    const day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  } catch (e) { return ''; }
}

// ---------- 统一检索（memory 工具） ----------
export async function memorySearchText(env, chatId, query) {
  const q = String(query == null ? '' : query).trim();
  if (!q) return '记忆检索失败：请给出要检索的关键词（query）';
  const [wm, lt, ar] = await Promise.all([
    wmGet(env, chatId).catch(() => ({ items: [], pins: [] })),
    ltGet(env, chatId).catch(() => []),
    arGet(env, chatId).catch(() => ({ items: [] }))
  ]);

  const qLower = q.toLowerCase();
  const out = [];

  // L1：要点与固定项做子串匹配（L1 只有 12 条，不值得上分词）
  const l1 = [];
  for (const it of (wm.items || [])) {
    if ((it.t + ' ' + (it.g || '')).toLowerCase().indexOf(qLower) !== -1) {
      l1.push('- 问：' + it.t + (it.g ? '｜答：' + it.g : ''));
    }
  }
  for (const p of (wm.pins || [])) {
    if (String(p.text || '').toLowerCase().indexOf(qLower) !== -1) l1.push('- （固定）' + p.text);
  }
  if (l1.length) out.push('▸ L1 工作记忆（本会话）：\n' + l1.slice(0, 5).join('\n'));

  // L2：分词相关性
  const l2 = await ltSearch(env, chatId, q, 6).catch(() => []);
  if (l2.length) {
    out.push('▸ L2 长期记忆：\n' + l2.map(m => {
      const label = m.kind && m.kind !== 'fact' ? '[' + (MEM_KIND_LABEL[m.kind] || m.kind) + '] ' : '';
      return '- ' + label + m.fact;
    }).join('\n'));
  }

  // L3：归档命中
  const l3 = rankArchive((ar && ar.items) || [], q, 4);
  if (l3.length) {
    out.push('▸ L3 历史归档：\n' + l3.map(h => '- ' + h.text + (h.ts ? '（' + fmtDay(h.ts) + '）' : '')).join('\n'));
  }

  if (!out.length) {
    return '记忆检索：三层都没有找到与「' + q + '」相关的内容。'
      + '（L1 有 ' + ((wm.items || []).length) + ' 个话题，L2 有 ' + (Array.isArray(lt) ? lt.length : 0)
      + ' 条，L3 有 ' + ((ar && ar.items) || []).length + ' 条）';
  }
  return '🧠 三层记忆检索「' + q + '」\n\n' + out.join('\n\n')
    + '\n\n（以上来自记忆，不是实时信息；需要最新数据仍要联网查询。）';
}

// ---------- 统计与报告 ----------
export async function memoryStats(env, chatId) {
  const [wm, lt, ar] = await Promise.all([
    wmGet(env, chatId).catch(() => ({ items: [], pins: [] })),
    ltGet(env, chatId).catch(() => []),
    arGet(env, chatId).catch(() => ({ items: [] }))
  ]);
  return {
    l1Items: (wm.items || []).length,
    l1Pins: (wm.pins || []).length,
    l2: Array.isArray(lt) ? lt.length : 0,
    l3: (ar.items || []).length,
    working: wm,
    longterm: Array.isArray(lt) ? lt : [],
    archive: ar
  };
}

export async function memoryStatsText(env, chatId) {
  const s = await memoryStats(env, chatId);
  return '🧠 三层记忆统计：L1 工作记忆 ' + s.l1Items + ' 个话题 / ' + s.l1Pins + ' 条固定；'
    + 'L2 长期记忆 ' + s.l2 + ' 条；L3 归档 ' + s.l3 + ' 条。';
}

// /memory 与 /kb 共用的可读报告
export async function memoryReport(env, chatId, opts) {
  const o = opts || {};
  const s = await memoryStats(env, chatId);
  const maxPerLayer = o.maxPerLayer > 0 ? o.maxPerLayer : 30;
  const parts = [];

  // L1
  let l1 = '▸ L1 工作记忆（本会话，短时）\n';
  const items = s.working.items || [];
  const pins = s.working.pins || [];
  if (!items.length && !pins.length) {
    l1 += '  （还没有会话要点，聊几轮后会自动生成）\n';
  } else {
    l1 += '  话题 ' + items.length + ' 个' + (pins.length ? '、固定 ' + pins.length + ' 条' : '') + '\n';
    const recent = items.slice(-5);
    for (let i = recent.length - 1; i >= 0; i--) {
      const it = recent[i];
      l1 += '  · ' + clipText(it.t, 60) + (it.g ? ' → ' + clipText(it.g, 60) : '') + '\n';
    }
    for (const p of pins.slice(-3)) l1 += '  📌 ' + clipText(p.text, 80) + '\n';
  }
  parts.push(l1);

  // L2
  let l2 = '▸ L2 长期记忆（持久）\n';
  const lt = s.longterm || [];
  if (!lt.length) {
    l2 += '  （空）对我说「记住…」即可保存，比如：记住，我养了一只猫叫汤圆\n';
  } else {
    l2 += '  共 ' + lt.length + ' 条（按强度排序，显示前 ' + Math.min(lt.length, maxPerLayer) + ' 条）\n';
    const hl = memLimits(env).halflifeDays;
    const ranked = lt.slice().sort((a, b) => memDecayScore(b, Date.now(), hl) - memDecayScore(a, Date.now(), hl));
    ranked.slice(0, maxPerLayer).forEach((m, i) => {
      const label = m.kind && m.kind !== 'fact' ? '[' + (MEM_KIND_LABEL[m.kind] || m.kind) + '·' + (m.weight || 3) + '] ' : '';
      l2 += '  ' + (i + 1) + '. ' + label + m.fact + '\n';
    });
  }
  parts.push(l2);

  // L3
  let l3 = '▸ L3 归档（自动沉淀，可检索）\n';
  const ar = (s.archive && s.archive.items) || [];
  if (!ar.length) {
    l3 += '  （空）会话要点溢出或长期记忆被淘汰时会自动沉淀到这里\n';
  } else {
    l3 += '  共 ' + ar.length + ' 条（最新 ' + Math.min(ar.length, 5) + ' 条）\n';
    for (const it of ar.slice(-5).reverse()) {
      l3 += '  · ' + clipText(it.text, 80) + '\n';
    }
  }
  parts.push(l3);

  return '🧠 三层记忆\n\n' + parts.join('\n')
    + '\n💡 用 /forget 关键词 删除长期记忆；/clear 清空本会话上下文（含 L1）；'
    + '需要精确检索时说「查一下你记得的关于…的事」。';
}

// ---------- 写入 ----------
export async function memoryRecordTurn(env, chatId, userText, assistantText) {
  return await wmRecordTurn(env, chatId, userText, assistantText);
}

export async function memoryPin(env, chatId, text) {
  return await wmPin(env, chatId, text);
}

export async function memoryUnpin(env, chatId, keyword) {
  return await wmUnpin(env, chatId, keyword);
}

// /clear：只清 L1（本会话脉络），L2 长期事实与 L3 归档保留——
// 用户说"清空上下文"通常是想换个话题，而不是想把"我叫什么"也一起忘掉。
export async function memoryClearSession(env, chatId) {
  await wmClear(env, chatId);
}

export {
  wmGet, ltGet, arGet, ltSave, ltForget, ltSearch, arSearch, arPush, arClear,
  rankLongterm, rankArchive, MEM_KIND_LABEL
};
