// 兼容层：三层记忆落地后，原「单层长期记忆」的入口保留为薄封装。
//
// 历史调用点（telegram/handler.js、wechat/handler.js、agent/tools.js、agent/loop.js）
// 全部按旧名字 import，这里转成 L2（kb/mem3/long/<chatId>.json）的实现，
// 对外行为与旧版一致：同样的返回值文案、同样的 R2 失败如实上报。
// 真正的实现见 ../memory/longterm.js。

import { ltSave, ltForget } from '../memory/longterm.js';
import { memNorm, memSubjectKey } from '../memory/layers.js';

// 旧版缓存句柄。三层记忆内部已各自维护缓存，这里只为兼容旧引用保留一个空壳，
// 不要再用它读写任何东西。
const tgAgentMemCache = new Map();

// 读入口已统一走 memory/index.js 的 memoryLoad（只读端会跳过 L2/L3），
// 这里不再导出 agentGetMemories 别名 —— 它没有任何调用方，留着只会让人以为还有第二条读路径。
export const agentSaveMemory = ltSave;
export const agentForgetMemory = ltForget;

export {
  tgAgentMemCache,
  memNorm,
  memSubjectKey,
};
