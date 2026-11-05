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
// 3) 自动过期：7 天没有活动视为会话结束，读出来直接当空处理（R2 里的对象仍在，
//    由 kb/mem3/ 目录的人工清理或生命周期规则处理，代码不做后台删除，避免额外写操作）。

import { mapSetBounded, mapGetBounded } from '../utils.js';
import { storeGet, storePutChecked, storeDelete } from '../store/r2.js';
import {
  wmKey, WM_MAX_ITEMS, WM_PIN_MAX, WM_TTL_MS, memLimits,
  extractTopic, extractGist, jaccard, clipText
} from './layers.js';
import { arPush } from './archive.js';

const wmCache = new Map();
const wmExp = new Map();
const WM_CACHE_TTL_MS = 60 * 1000;
const WM_CACHE_MAX = 500;

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

function cloneWm(w) {
  return {
    v: w.v, chatId: w.chatId, updatedAt: w.updatedAt,
    items: w.items.map(x => ({ t: x.t, g: x.g, ts: x.ts })),
    pins: w.pins.map(x => ({ text: x.text, ts: x.ts }))
  };
}

async function wmPut(env, chatId, obj) {
  // 先更新内存缓存：即使 R2 写失败，本 isolate 内的后续轮次也能看到最新脉络
  mapSetBounded(wmCache, chatId, cloneWm(obj), WM_CACHE_MAX, wmExp, WM_CACHE_TTL_MS);
  if (!env || !env.R2) return false;
  return await storePutChecked(env, wmKey(chatId), JSON.stringify(obj));
}

export async function wmGet(env, chatId) {
  const cached = mapGetBounded(wmCache, chatId, env && env.R2 ? wmExp : null);
  if (cached) return cloneWm(cached);
  let obj = emptyWm(chatId);
  if (env && env.R2) {
    const raw = await storeGet(env, wmKey(chatId));
    if (raw) {
      try { obj = normalizeWm(JSON.parse(raw), chatId, memLimits(env).l1); } catch (e) { obj = emptyWm(chatId); }
    }
  }
  mapSetBounded(wmCache, chatId, cloneWm(obj), WM_CACHE_MAX, wmExp, WM_CACHE_TTL_MS);
  return cloneWm(obj);
}

// 记录一轮问答。返回 { added, merged, spilled, persisted }，供调用方判断是否真的写进去了。
export async function wmRecordTurn(env, chatId, userText, assistantText) {
  const topic = extractTopic(userText);
  if (!topic) return { added: false, merged: false, spilled: 0, persisted: false };
  const gist = extractGist(assistantText);
  const ts = Date.now();
  const wm = await wmGet(env, chatId);

  // 同话题合并：从后往前找，命中就替换并挪到末尾（最新话题永远在最后）
  let merged = false;
  for (let i = wm.items.length - 1; i >= 0; i--) {
    if (jaccard(wm.items[i].t, topic) >= 0.6) {
      wm.items.splice(i, 1);
      merged = true;
      break;
    }
  }
  wm.items.push({ t: topic, g: gist, ts });

  // 溢出沉淀：最旧的几条推进 L3，绝不静默丢弃
  const cap = memLimits(env).l1;
  const spilled = [];
  while (wm.items.length > cap) spilled.push(wm.items.shift());
  wm.updatedAt = ts;

  const persisted = await wmPut(env, chatId, wm);

  if (spilled.length) {
    await arPush(env, chatId, spilled.map(x => ({
      type: 'session',
      text: clipText(x.t + (x.g ? ' → ' + x.g : ''), 200),
      ts: x.ts
    })));
  }
  return { added: true, merged, spilled: spilled.length, persisted };
}

// 固定本会话的约束/事实（"这次都用英文回答""本次只讨论 A 方案"）。
// 与 L2 的区别：L2 是跨会话的长期事实，L1 pins 只在本会话有效，/clear 时一起清掉。
export async function wmPin(env, chatId, text) {
  const t = clipText(String(text == null ? '' : text).replace(/\s+/g, ' ').trim(), 160);
  if (!t) return { ok: false, reason: '内容为空' };
  const wm = await wmGet(env, chatId);
  if (wm.pins.some(p => p.text === t)) {
    return { ok: true, duplicate: true, count: wm.pins.length };
  }
  wm.pins.push({ text: t, ts: Date.now() });
  let evicted = 0;
  while (wm.pins.length > WM_PIN_MAX) { wm.pins.shift(); evicted += 1; }
  wm.updatedAt = Date.now();
  const ok = await wmPut(env, chatId, wm);
  return { ok, count: wm.pins.length, evicted, persisted: ok };
}

export async function wmUnpin(env, chatId, keyword) {
  const kw = String(keyword == null ? '' : keyword).trim();
  if (!kw) return { removed: 0 };
  const wm = await wmGet(env, chatId);
  const kept = wm.pins.filter(p => p.text.indexOf(kw) === -1);
  const removed = wm.pins.length - kept.length;
  if (!removed) return { removed: 0 };
  wm.pins = kept;
  wm.updatedAt = Date.now();
  const ok = await wmPut(env, chatId, wm);
  return { removed, persisted: ok };
}

export async function wmClear(env, chatId) {
  wmCache.delete(chatId);
  wmExp.delete(chatId);
  if (env && env.R2) {
    try { await storeDelete(env, wmKey(chatId)); } catch (e) {}
  }
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
