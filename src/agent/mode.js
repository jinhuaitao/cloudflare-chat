// Agent 模式开关（默认开启）（_worker.js 原第 705,1036-1049 行）

import { mapSetBounded } from '../utils.js';
import { storeGet, storePut } from '../store/r2.js';

const tgAgentModeCache = new Map();
// 获取 Agent 模式开关（默认开启）
async function agentGetMode(env, chatId) {
  if (tgAgentModeCache.has(chatId)) return tgAgentModeCache.get(chatId);
  let on = true; // 默认开启 Agent 模式
  const v = await storeGet(env, 'agent_mode_' + chatId);
  on = v !== '0';
  mapSetBounded(tgAgentModeCache, chatId, on);
  return on;
}

async function agentSetMode(env, chatId, on) {
  mapSetBounded(tgAgentModeCache, chatId, on);
  await storePut(env, 'agent_mode_' + chatId, on ? '1' : '0');
}

export {
  agentGetMode,
  agentSetMode,
};
