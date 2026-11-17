// L1 工作记忆：会话级的短期脉络。
//
// 解决的具体问题：Telegram / 微信的对话历史按 TG_HISTORY_ROUNDS（默认 10 轮）裁剪，
// 一旦用户聊到第 11 轮，第 1 轮说过的东西就从上下文里彻底消失了——用户问"刚才那个方案
// 的第三点是什么"，模型只能干瞪眼。L1 在每一轮结束时把「用户问了什么 + 结论是什么」
// 压成一条要点存起来，历史被裁剪后仍然能补回这条脉络。
//
// 三个关键行为：
// 1) 同话题合并：用 2-gram Jaccard 判断是不是同一件事，是就替换而不是追加，
//    否则连问五遍"北京天气"会占满 12 条槽位。
// 2) 溢出沉淀：超过 WM_MAX_ITEMS 时最旧的一条不是被丢弃，而是推进 L3 归档。
//    v7.20.0 起沉淀与本轮要点在同一次 CAS 写入里完成（原子，不会丢）。
// 3) 自动过期：7 天没有活动视为会话结束，读出来直接当空处理（R2 里的数据仍在，
//    下次写入时自然更新，代码不做后台删除，避免额外写操作）。
//
// 存储：v7.20.0 起三层共用 kb/mem3/<chatId>.json 单对象（store.js），
// /clear 只清 work 段，不再 DELETE 整个对象（L2/L3 必须保留）。

import { memSnapshot, memMutate } from './store.js';
import { applyArchiveRecords } from './archive.js';
import {
  WM_MAX_ITEMS, WM_PIN_MAX, WM_TTL_MS, memLimits,
  extractTopic, extractGist, jaccard, clipText
} from './layers.js';

function emptyWm(chatId) {
  return { v: 1, chatId: String(chatId == null ? '' : chatId), updatedAt: 0, items: [], pins: [] };
}

function normalizeItem(x) {
  if (!x || typeof x !== 'object') return null;
  const t = clipText(String(x.t == null ? '' : x.t).replace(/\s+/g, ' ').trim(), 80);
  if (!t) return null;
  return {
    t,
    g: clipText(String(x.g == null ? '' : x.g).replace(/\s+/g, ' ').trim(), 120),
    ts: Number(x.ts) || 0
  };
}

function normalizeWm(raw, chatId, maxItems) {
  const out = emptyWm(chatId);
  if (!raw || typeof raw !== 'object') return out;
  const cap = maxItems > 0 ? maxItems : WM_MAX_ITEMS;
  const items = Array.isArray(raw.items) ? raw.items : [];
  for (const x of items) {
    const it = normalizeItem(x);
    if (it) out.items.push(it);
  }
  if (out.items.length > cap) out.items = out.items.slice(out.items.length - cap);
  const pins = Array.isArray(raw.pins) ? raw.pins : [];
  for (const p of pins) {
    const text = clipText(String((p && p.text) || p || '').replace(/\s+/g, ' ').trim(), 160);
    if (text) out.pins.push({ text, ts: Number(p && p.ts) || 0 });
  }
  if (out.pins.length > WM_PIN_MAX) out.pins = out.pins.slice(out.pins.length - WM_PIN_MAX);
  out.updatedAt = Number(raw.updatedAt) || 0;
  // TTL：太久没动过的会话视为结束，不注入提示词
  if (out.updatedAt > 0 && Date.now() - out.updatedAt > WM_TTL_MS) return emptyWm(chatId);
  return out;
}

// 写回 draft 的 work 段（统一对象里不存 v/chatId，投影时再补）
function setWork(draft, wm) {
  draft.work = { updatedAt: wm.updatedAt, items: wm.items, pins: wm.pins };
}

function persistedOk(env, res) {
  return !!(env && env.R2) && res.ok && (res.persisted || res.unchanged);
}

export async function wmGet(env, chatId) {
  const snap = await memSnapshot(env, chatId);
  return normalizeWm(snap.work, chatId, memLimits(env).l1);
}

// 记录一轮问答。返回 { added, merged, spilled, persisted }，供调用方判断是否真的写进去了。
export async function wmRecordTurn(env, chatId, userText, assistantText) {
  const topic = extractTopic(userText);
  if (!topic) return { added: false, merged: false, spilled: 0, persisted: false };
  const gist = extractGist(assistantText);
  const ts = Date.now();
  let merged = false;
  let spilled = [];

  const res = await memMutate(env, chatId, draft => {
    // normalizeWm 顺带做 TTL 过期与容量裁剪；mutator 可重跑（CAS 冲突时在新快照上重算）
    const wm = normalizeWm(draft.work, chatId, memLimits(env).l1);
    merged = false;
    for (let i = wm.items.length - 1; i >= 0; i--) {
      if (jaccard(wm.items[i].t, topic) >= 0.6) {
        wm.items.splice(i, 1);
        merged = true;
        break;
      }
    }
    wm.items.push({ t: topic, g: gist, ts });

    // 溢出沉淀：最旧的几条推进 L3，与本轮要点同一次写入，绝不静默丢弃
    const cap = memLimits(env).l1;
    spilled = [];
    while (wm.items.length > cap) spilled.push(wm.items.shift());
    wm.updatedAt = ts;
    setWork(draft, wm);
    if (spilled.length) {
      draft.archive.items = applyArchiveRecords(draft.archive.items, spilled.map(x => ({
        type: 'session',
        text: clipText(x.t + (x.g ? ' → ' + x.g : ''), 200),
        ts: x.ts
      })), memLimits(env).l3);
    }
  });

  return { added: true, merged, spilled: spilled.length, persisted: persistedOk(env, res) };
}

// 固定本会话的约束/事实（"这次都用英文回答""本次只讨论 A 方案"）。
// 与 L2 的区别：L2 是跨会话的长期事实，L1 pins 只在本会话有效，/clear 时一起清掉。
export async function wmPin(env, chatId, text) {
  const t = clipText(String(text == null ? '' : text).replace(/\s+/g, ' ').trim(), 160);
  if (!t) return { ok: false, reason: '内容为空' };
  let duplicate = false;
  let count = 0;
  let evicted = 0;
  const res = await memMutate(env, chatId, draft => {
    const wm = normalizeWm(draft.work, chatId, memLimits(env).l1);
    if (wm.pins.some(p => p.text === t)) {
      duplicate = true;
      count = wm.pins.length;
      return false;
    }
    wm.pins.push({ text: t, ts: Date.now() });
    evicted = 0;
    while (wm.pins.length > WM_PIN_MAX) { wm.pins.shift(); evicted += 1; }
    wm.updatedAt = Date.now();
    count = wm.pins.length;
    setWork(draft, wm);
  });
  if (duplicate) return { ok: true, duplicate: true, count };
  const ok = persistedOk(env, res);
  return { ok, count, evicted, persisted: ok };
}

export async function wmUnpin(env, chatId, keyword) {
  const kw = String(keyword == null ? '' : keyword).trim();
  if (!kw) return { removed: 0 };
  let removed = 0;
  const res = await memMutate(env, chatId, draft => {
    const wm = normalizeWm(draft.work, chatId, memLimits(env).l1);
    const kept = wm.pins.filter(p => p.text.indexOf(kw) === -1);
    removed = wm.pins.length - kept.length;
    if (!removed) return false;
    wm.pins = kept;
    wm.updatedAt = Date.now();
    setWork(draft, wm);
  });
  if (!removed) return { removed: 0 };
  return { removed, persisted: persistedOk(env, res) };
}

// /clear：只清 work 段。统一对象里 L2/L3 与 work 同住，绝不能 DELETE 整个键。
export async function wmClear(env, chatId) {
  await memMutate(env, chatId, draft => {
    if (!draft.work.items.length && !draft.work.pins.length && !draft.work.updatedAt) return false;
    draft.work = { updatedAt: 0, items: [], pins: [] };
  });
}

// 生成提示词里用的 L1 文本块（不含标题，标题由 index.js 统一加）
export function wmDigestLines(wm, budget) {
  const items = (wm && Array.isArray(wm.items)) ? wm.items : [];
  const pins = (wm && Array.isArray(wm.pins)) ? wm.pins : [];
  let left = budget > 0 ? budget : 1600;
  const blocks = [];

  if (items.length) {
    const lines = [];
    // 新的在前：模型对"刚刚发生过什么"更敏感
    for (let i = items.length - 1; i >= 0 && lines.length < 8; i--) {
      const it = items[i];
      const line = '- 问：' + it.t + (it.g ? '｜答：' + it.g : '');
      if (line.length > left) break;
      lines.push(line);
      left -= line.length;
    }
    if (lines.length) blocks.push('本会话近期要点（新的在前）：\n' + lines.join('\n'));
  }

  if (pins.length) {
    const lines = [];
    for (const p of pins) {
      const line = '- ' + p.text;
      if (line.length > left) break;
      lines.push(line);
      left -= line.length;
    }
    if (lines.length) blocks.push('本会话已固定的约束/事实：\n' + lines.join('\n'));
  }

  return { text: blocks.join('\n'), items: items.length, pins: pins.length };
}