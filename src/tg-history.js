// Telegram 多轮对话历史（内存 L1 + R2 L2）（_worker.js 原第 166-167,174-190,303-321 行）

import { mapSetBounded } from './utils.js';
import { storeGet, storePut, storeDelete } from './store/r2.js';

// ======= Telegram 多轮对话历史（内存 L1 + R2 L2） =======
const tgHistories = new Map();
function tgHistoryKey(chatId) { return 'tg_hist_' + chatId; }
function tgTrimHistory(history, env) {
  let maxRounds = parseInt(env.TG_HISTORY_ROUNDS || '10', 10);
  if (!(maxRounds > 0)) maxRounds = 10;
  if (maxRounds > 30) maxRounds = 30;
  const maxMsgs = maxRounds * 2;
  while (history.length > maxMsgs) history.shift();
  // 字符预算：超长历史从最旧开始丢弃，保证单次请求可控
  const budget = 12000;
  let total = 0;
  for (let i = 0; i < history.length; i++) total += String(history[i].content || '').length;
  while (history.length > 2 && total > budget) {
    const dropped = history.shift();
    total -= String(dropped.content || '').length;
  }
  return history;
}
async function tgGetHistory(env, chatId) {
  if (tgHistories.has(chatId)) return tgHistories.get(chatId);
  const raw = await storeGet(env, tgHistoryKey(chatId));
  if (raw) {
    try {
      const h = JSON.parse(raw);
      if (Array.isArray(h)) { mapSetBounded(tgHistories, chatId, h); return h; }
    } catch (e) {}
  }
  return [];
}
async function tgSaveHistory(env, chatId, history) {
  mapSetBounded(tgHistories, chatId, history);
  await storePut(env, tgHistoryKey(chatId), JSON.stringify(history));
}
async function tgClearHistory(env, chatId) {
  tgHistories.delete(chatId);
  await storeDelete(env, tgHistoryKey(chatId));
}

export {
  tgHistoryKey,
  tgTrimHistory,
  tgGetHistory,
  tgSaveHistory,
  tgClearHistory,
};
