// Agent 稳定性增强：智能边界截断（自动闭合代码块）、工具参数 JSON 修复、调用签名、上下文预算裁剪
//
// v7.6.0：
// 1) 工具参数修复（parseToolArguments）：被 max_tokens 截断的参数（缺结尾引号 / 括号、
//    末尾半截键、误包 ```json 围栏）先做确定性补齐，修不好就明确报失败，不再拿空参数执行；
// 2) 裁剪对 tool_calls 配对安全：压缩历史时整组保留/整组丢弃，绝不留下孤儿 tool 消息，
//    也不会留下没有 tool 回包的 assistant.tool_calls（严格校验的上游会直接 400）；
// 3) 保护最后一条用户消息：预算再紧也只压缩历史与工具输出，不把用户的问题本身压没；
// 4) 三轮裁剪：本轮旧轮次 → 历史轮次 → 对最长消息硬压缩，保证真正送上游的请求不超预算
//    （旧版最后一步吐出的多个大工具结果无处可丢，请求必然超标）；
// 5) trimAgentMessagesEx 返回裁剪后的本轮起点，断点续做保存的位置不再错位；
// 6) 消息长度按对象缓存，避免每一步重复 JSON.stringify 全量消息。

// 消息长度缓存：loop 内的消息对象创建后不再修改，可以安全地按对象缓存。
// 每一步都重新 stringify 全量消息是 O(步数 × 上下文长度) 的纯浪费。
const msgLenCache = new WeakMap();

function messageLength(m) {
  if (!m || typeof m !== 'object') return 0;
  const hit = msgLenCache.get(m);
  if (typeof hit === 'number') return hit;
  let n = 0;
  try { n = JSON.stringify(m).length; } catch (e) { n = 0; }
  msgLenCache.set(m, n);
  return n;
}

function truncateToolResult(result, maxChars) {
  const s = String(result == null ? '' : result);
  maxChars = maxChars > 0 ? maxChars : 4000;
  if (s.length <= maxChars) return s;
  let cut = maxChars;
  // 优先在最后 240 字符窗口内的换行符处整齐截断，避免切断半行数据或 URL
  const lastNl = s.lastIndexOf('\n', cut);
  if (lastNl >= maxChars - 240 && lastNl > 0) {
    cut = lastNl;
  } else {
    const prev = s.charCodeAt(cut - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) cut -= 1;
  }
  let sliced = s.slice(0, cut);
  // 若截断处有未闭合的 ``` 代码块，自动补齐闭合围栏
  const fences = sliced.match(/```/g);
  if (fences && fences.length % 2 === 1) {
    sliced += '\n```';
  }
  return sliced + '\n…（结果过长，仅显示前 ' + cut + ' 字符）';
}

// 上游错误响应体带预算读取
async function readErrorBody(resp, maxChars) {
  maxChars = maxChars > 0 ? maxChars : 2048;
  try {
    if (!resp.body) return (await resp.text()).slice(0, maxChars);
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let out = '';
    while (out.length < maxChars) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    try { await reader.cancel(); } catch (e) {}
    return out.slice(0, maxChars);
  } catch (e) { return ''; }
}

// ==================== 工具参数 JSON 修复 ====================
// 模型输出被 max_tokens 截断时，参数 JSON 常以 "缺少结尾引号 / 括号 / 末尾半截键" 结束。
// 旧版直接 JSON.parse 失败后退化成 {}，工具拿着空参数白跑一次并计一次失败；
// 这里做确定性补齐（只补结构，不猜语义），修不好就明确报失败让模型重出。
const ARG_TEXT_MAX = 20000;

function stripJsonFence(s) {
  return String(s || '')
    .replace(/^\s*```(?:json|JSON)?\s*/, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

// 扫描一遍算出未闭合的引号与括号，生成候选修复文本
function repairCandidates(s) {
  let inStr = false;
  let escaped = false;
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') {
      if (stack[stack.length - 1] === c) stack.pop();
    }
  }
  const closers = stack.slice().reverse().join('');
  const out = [];
  // a) 直接补引号 + 括号（值被截断的常见形态）
  if (inStr) out.push(s + (escaped ? '\\"' : '"') + closers);
  else out.push(s + closers);
  // b) 末尾是半截键（"key": 之后没有值）→ 丢掉这一段再补括号
  const noHalfKey = s.replace(/,\s*"[^"]*"\s*:\s*$/, '').replace(/,\s*"[^"]*$/, '').replace(/[,:]\s*$/, '');
  if (noHalfKey !== s) out.push(noHalfKey + closers);
  return out;
}

// 解析工具参数：成功返回 { args }，失败返回 { error }（error 已可直接回灌给模型）
function parseToolArguments(raw) {
  if (raw === undefined || raw === null || raw === '') return { args: {} };
  if (typeof raw === 'object') return { args: raw };
  const text = stripJsonFence(raw);
  if (!text) return { args: {} };
  if (text.length > ARG_TEXT_MAX) return { error: '参数过长（超过 ' + ARG_TEXT_MAX + ' 字符）' };
  try {
    const first = JSON.parse(text);
    return { args: first && typeof first === 'object' && !Array.isArray(first) ? first : {} };
  } catch (e) {}
  for (const cand of repairCandidates(text)) {
    try {
      const v = JSON.parse(cand);
      if (v && typeof v === 'object' && !Array.isArray(v)) return { args: v, repaired: true };
    } catch (e) {}
  }
  return { error: 'JSON 不完整或格式错误' };
}

// 工具调用签名：name + 规范化后的参数，用于检测模型是否在原地打转。
// 参数走修复解析，被截断的同一调用与补全后的调用视为同一次，熔断才抓得住。
function toolCallSignature(tc) {
  const fn = (tc && tc.function) || {};
  const parsed = parseToolArguments(fn.arguments);
  const args = parsed.args || {};
  const keys = Object.keys(args).sort();
  const norm = {};
  for (const k of keys) norm[k] = args[k];
  return (fn.name || '') + '|' + JSON.stringify(norm);
}

function oneLine(s, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

// 消息正文取纯文本：历史里可能是多模态数组（[{type:'text'},…]），
// 直接 String() 会得到 "[object Object]"，摘要就废了
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(p => p && p.type === 'text' && typeof p.text === 'string')
      .map(p => p.text)
      .join(' ');
  }
  return String(content == null ? '' : content);
}

// 将被裁剪掉的工具轮次浓缩为单行摘要，避免模型遗忘已执行的步骤
function summarizeDroppedRounds(arr, droppedRoundIndices) {
  const lines = [];
  for (const rIndices of droppedRoundIndices) {
    for (const idx of rIndices) {
      const m = arr[idx];
      if (!m) continue;
      if (m.role === 'tool') {
        const name = m.name || 'tool';
        lines.push('- ' + name + ': ' + oneLine(contentText(m.content), 110));
      }
    }
  }
  if (!lines.length) return '';
  return '【早期步骤摘要（完整工具输出已折叠以节省上下文，请勿重复调用相同参数）】\n' + lines.slice(-8).join('\n');
}

// 将被压缩掉的历史对话浓缩成摘要
function summarizeDroppedHistory(arr, indices) {
  const lines = [];
  for (const idx of indices) {
    const m = arr[idx];
    if (!m) continue;
    if (m.role === 'user') lines.push('用户：' + oneLine(contentText(m.content), 120));
    else if (m.role === 'assistant') lines.push('助手：' + oneLine(contentText(m.content), 120));
  }
  if (!lines.length) return '';
  return '【更早的历史对话摘要（原文已压缩以节省上下文）】\n' + lines.join('\n');
}

// 把 [from,to) 的历史切成「不可拆分的组」：带 tool_calls 的 assistant 必须和它的
// tool 回包同生共死。分开丢弃会产出非法消息序列。
function buildToolSafeGroups(arr, indices) {
  const groups = [];
  let g = null;
  for (const i of indices) {
    const m = arr[i];
    const isTool = m && m.role === 'tool';
    if (isTool && g && g.assistant) {
      g.items.push(i);
      continue;
    }
    const hasCalls = m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
    g = { assistant: hasCalls, items: [i] };
    groups.push(g);
  }
  return groups.map(x => x.items);
}

// 从后往前保留 keep 条历史消息（按组整体保留，不拆散工具轮次），返回可压缩的下标
function indicesToCompress(groups, keep) {
  const out = [];
  let kept = 0;
  for (let i = groups.length - 1; i >= 0; i--) {
    const items = groups[i];
    if (kept >= keep) out.push(...items);
    else kept += items.length;
  }
  return out;
}

// 防孤儿：tool 消息前面必须有带该 id 的 assistant.tool_calls
function sanitizeToolPairs(arr) {
  const seen = new Set();
  const out = [];
  for (const m of arr) {
    if (!m) continue;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) if (tc && tc.id) seen.add(tc.id);
      out.push(m);
      continue;
    }
    if (m.role === 'tool' && !seen.has(m.tool_call_id)) continue;
    out.push(m);
  }
  return out;
}

// 按字符预算裁剪 Agent 循环消息；返回新数组（不修改原数组，便于测试与断点续存）
// loopStartIdx：本轮起点（该位置之前的都是历史对话，之后的是本轮 ReAct 轨迹）
function trimAgentMessagesEx(messages, loopStartIdx, budget) {
  budget = budget > 0 ? budget : 24000;
  const arr = Array.isArray(messages) ? messages : [];
  const startRaw = Math.max(0, Math.min(loopStartIdx | 0, arr.length));
  if (arr.length <= 1) return { messages: arr.slice(), loopStartIdx: startRaw, hardTrimmed: false };

  let total = 0;
  for (const m of arr) total += messageLength(m);
  if (total <= budget) return { messages: arr.slice(), loopStartIdx: startRaw, hardTrimmed: false };

  const dropped = new Set();
  const digests = [];

  // 最后一条用户消息是本轮的问题，无论如何都要保留
  let lastUserIdx = -1;
  for (let i = arr.length - 1; i > 0; i--) {
    if (arr[i] && arr[i].role === 'user') { lastUserIdx = i; break; }
  }
  const protectedIdx = lastUserIdx >= 0 && lastUserIdx < startRaw ? lastUserIdx : -1;

  // ---------- 阶段 1：丢弃本轮已完成的工具轮次（保留最后 1 轮） ----------
  const rounds = [];
  let cur = -1;
  for (let i = startRaw; i < arr.length; i++) {
    if (arr[i] && arr[i].role === 'assistant') { cur = rounds.length; rounds.push([i]); }
    else if (cur >= 0) rounds[cur].push(i);
  }
  const droppedRounds = [];
  for (let r = 0; r < rounds.length - 1 && total > budget; r++) {
    droppedRounds.push(rounds[r]);
    for (const i of rounds[r]) { dropped.add(i); total -= messageLength(arr[i]); }
  }
  if (droppedRounds.length) {
    const d = summarizeDroppedRounds(arr, droppedRounds);
    if (d) digests.push(d);
  }

  // ---------- 阶段 2：压缩更早的历史轮次 ----------
  // 先尝试保留最近 4 条、再 2 条、最后全部压缩；每一步都按「工具轮次整组」处理，
  // 并始终跳过最后一条用户消息。
  const compressedSet = new Set();
  if (total > budget && startRaw > 1) {
    const histIdx = [];
    for (let i = 1; i < startRaw; i++) {
      if (!dropped.has(i) && i !== protectedIdx) histIdx.push(i);
    }
    const groups = buildToolSafeGroups(arr, histIdx);
    for (const keep of [4, 2, 0]) {
      if (total <= budget) break;
      for (const i of indicesToCompress(groups, keep)) {
        if (dropped.has(i)) continue;
        dropped.add(i);
        compressedSet.add(i);
        total -= messageLength(arr[i]);
      }
    }
  }
  if (compressedSet.size) {
    const d = summarizeDroppedHistory(arr, [...compressedSet].sort((a, b) => a - b));
    if (d) digests.push(d);
  }

  // ---------- 组装 ----------
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    if (!dropped.has(i)) out.push(arr[i]);
  }
  if (!out.length) return { messages: arr.slice(), loopStartIdx: startRaw, hardTrimmed: false };

  if (digests.length && out[0] && out[0].role === 'system') {
    const merged = String(out[0].content || '') + '\n\n' + digests.join('\n\n');
    total += merged.length - String(out[0].content || '').length;
    out[0] = { role: 'system', content: merged };
  }

  // 历史被压缩后，system 之后的第一条必须仍是 user 消息，
  // 否则上游（严格校验 OpenAI 消息序列）会直接 400。
  if (compressedSet.size > 0) {
    while (out.length > 1 && out[1].role !== 'user') out.splice(1, 1);
  }

  // ---------- 阶段 3：硬预算压缩 ----------
  // 走到这里仍超预算，说明本轮最后一步的工具输出本身就很大（8 个调用 × 4000 字符）。
  // 逐级压缩最长的正文，绝不丢弃消息本身，保证序列合法且请求真的不超预算。
  let hardTrimmed = false;
  // 组装后最后一轮用户提问的位置（阶段 3 的硬压缩同样不能动它）
  let protectedOut = -1;
  for (let i = out.length - 1; i > 0; i--) {
    if (out[i] && out[i].role === 'user') { protectedOut = i; break; }
  }
  const shape = (m, content) => ({ ...m, content: content });
  const shrinkPass = (roles, maxChars) => {
    if (total <= budget) return;
    const cands = [];
    for (let i = 1; i < out.length; i++) {
      const m = out[i];
      if (!m || roles.indexOf(m.role) === -1) continue;
      if (typeof m.content !== 'string' || m.content.length <= maxChars) continue;
      cands.push(i);
    }
    cands.sort((a, b) => out[b].content.length - out[a].content.length);
    for (const i of cands) {
      if (total <= budget) break;
      const before = out[i];
      const next = shape(before, before.content.slice(0, maxChars) + '\n…（已压缩以节省上下文）');
      out[i] = next;
      total += messageLength(next) - messageLength(before);
      hardTrimmed = true;
    }
  };
  const keepTail = (i) => i === protectedOut;
  // 用户消息是问题本身，只能「从尾部保留」且优先压缩别人的内容
  shrinkPass(['tool'], 1500);
  shrinkPass(['tool'], 700);
  shrinkPass(['assistant'], 1200);
  shrinkPass(['assistant'], 400);
  if (total > budget) {
    // 最后的兜底：从最长的一条开始按缺口裁剪（每条至少保留 160 字符）
    const cands = [];
    for (let i = 1; i < out.length; i++) {
      const m = out[i];
      if (!m || typeof m.content !== 'string' || m.role === 'system') continue;
      if (keepTail(i)) continue;
      if (m.content.length > 160) cands.push(i);
    }
    cands.sort((a, b) => out[b].content.length - out[a].content.length);
    for (const i of cands) {
      if (total <= budget) break;
      const before = out[i];
      const over = total - budget;
      const keepLen = Math.max(160, before.content.length - over - 24);
      if (keepLen >= before.content.length) continue;
      const next = shape(before, before.content.slice(0, keepLen) + '\n…（已压缩）');
      out[i] = next;
      total += messageLength(next) - messageLength(before);
      hardTrimmed = true;
    }
  }

  const safeOut = sanitizeToolPairs(out);

  // 裁剪后的本轮起点 = 原 [0, startRaw) 中存活的条数
  let newStart = 0;
  for (let i = 0; i < startRaw; i++) if (!dropped.has(i)) newStart++;
  if (newStart > safeOut.length) newStart = safeOut.length;

  return { messages: safeOut, loopStartIdx: newStart, hardTrimmed };
}

function trimAgentMessages(messages, loopStartIdx, budget) {
  return trimAgentMessagesEx(messages, loopStartIdx, budget).messages;
}

export {
  truncateToolResult,
  readErrorBody,
  parseToolArguments,
  toolCallSignature,
  trimAgentMessages,
  trimAgentMessagesEx,
};
