// Agent 模式开关（默认开启）与专家人格选择（v7.13.0）

import { mapSetBounded, mapGetBounded } from '../utils.js';
import { storeGet, storePut } from '../store/r2.js';
import { normalizePersonaId } from './personas.js';

const tgAgentModeCache = new Map();
const tgAgentModeExp = new Map();

// 获取 Agent 模式开关（默认开启）
async function agentGetMode(env, chatId) {
  const cached = mapGetBounded(tgAgentModeCache, chatId, env && env.R2 ? tgAgentModeExp : null);
  if (typeof cached === 'boolean') return cached;
  let on = true; // 默认开启 Agent 模式
  const v = await storeGet(env, 'agent_mode_' + chatId);
  on = v !== '0';
  mapSetBounded(tgAgentModeCache, chatId, on, undefined, tgAgentModeExp);
  return on;
}

async function agentSetMode(env, chatId, on) {
  mapSetBounded(tgAgentModeCache, chatId, !!on, undefined, tgAgentModeExp);
  await storePut(env, 'agent_mode_' + chatId, on ? '1' : '0');
}

// ==================== 专家人格 ====================
// 存的是 'auto' 或人格 id。'auto' 表示每轮按提问自动路由；
// 显式指定一次就固定，直到用户发 /agent auto 恢复自动。
const tgPersonaCache = new Map();
const tgPersonaExp = new Map();
const PERSONA_KEY_PREFIX = 'agent_persona_';

async function agentGetPersona(env, chatId) {
  const cached = mapGetBounded(tgPersonaCache, chatId, env && env.R2 ? tgPersonaExp : null);
  if (typeof cached === 'string') return cached;
  const raw = await storeGet(env, PERSONA_KEY_PREFIX + chatId);
  // 存档里可能是旧版 id 或手改的脏值：不认识就回落 auto，绝不把脏值带进提示词
  const id = normalizePersonaId(raw) || 'auto';
  mapSetBounded(tgPersonaCache, chatId, id, undefined, tgPersonaExp);
  return id;
}

async function agentSetPersona(env, chatId, id) {
  const raw = String(id || '').trim().toLowerCase();
  const value = (!raw || raw === 'auto' || raw === '自动') ? 'auto' : (normalizePersonaId(raw) || 'auto');
  mapSetBounded(tgPersonaCache, chatId, value, undefined, tgPersonaExp);
  await storePut(env, PERSONA_KEY_PREFIX + chatId, value);
  return value;
}

export {
  agentGetMode,
  agentSetMode,
  agentGetPersona,
  agentSetPersona,
};
