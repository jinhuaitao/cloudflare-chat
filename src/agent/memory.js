// 兼容层：三层记忆落地后，原「单层长期记忆」的入口保留为薄封装。
//
// 历史调用点（telegram/handler.js、wechat/handler.js、agent/tools.js、agent/loop.js）
// 全部按旧名字 import，这里转成 L2（kb/mem3/long/<chatId>.json）的实现，
// 对外行为与旧版一致：同样的返回值文案、同样的 R2 失败如实上报。
// 真正的实现见 ../memory/longterm.js。

import { ltGet, ltSave, ltForget } from '../memory/longterm.js';
import { memNorm, memSubjectKey } from '../memory/layers.js';

// 旧版缓存句柄。三层记忆内部已各自维护缓存，这里只为兼容旧引用保留一个空壳，
// 不要再用它读写任何东西。
const tgAgentMemCache = new Map();

export const agentGetMemories = ltGet;
export const agentSaveMemory = ltSave;
export const agentForgetMemory = ltForget;

export {
  tgAgentMemCache,
  memNorm,
  memSubjectKey,
};
