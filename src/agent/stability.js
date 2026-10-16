// Agent 稳定性增强：结果截断、调用签名、带历史步骤摘要压缩的上下文预算裁剪

// ==================== Agent 稳定性增强（v6.6.5，v7.1.0 智能压缩升级） ====================
// 1) truncateToolResult：工具结果截断并明确标注，避免模型误以为拿到了完整数据。
// 2) toolCallSignature：工具调用签名，用于"重复调用熔断"。
// 3) trimAgentMessages：上下文预算裁剪。多步任务中工具结果（每条可达 4000 字）
//    会快速堆积，超预算时从最旧的"整轮"（1 条 assistant + 其 tool 消息）开始删，
//    成对删除保证 OpenAI 消息序列合法性（assistant tool_calls 后必须紧跟 tool 应答）。
//    v7.1.0 升级：被裁剪的旧轮次不再静默丢弃，而是浓缩为一条轻量级【已完成步骤摘要】
//    （仅占百余字符），防止模型在后续步骤中因"失忆"而重复调用第 1 步已经执行过的工具。

// 工具结果截断：超长时保留前 maxChars 并标注，避免模型误判为完整数据
function truncateToolResult(result, maxChars) {
  const s = String(result == null ? '' : result);
  maxChars = maxChars > 0 ? maxChars : 4000;
  if (s.length <= maxChars) return s;
  let cut = maxChars;
  const prev = s.charCodeAt(cut - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) cut -= 1;
  return s.slice(0, cut) + '\n…（结果过长，仅显示前 ' + cut + ' 字符）';
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

// 工具调用签名：name + 规范化后的参数，用于检测模型是否在原地打转
function toolCallSignature(tc) {
  const fn = (tc && tc.function) || {};
  let args = {};
  try { args = JSON.parse(fn.arguments || '{}'); } catch (e) { args = {}; }
  const keys = Object.keys(args).sort();
  const norm = {};
  for (const k of keys) norm[k] = args[k];
  return (fn.name || '') + '|' + JSON.stringify(norm);
}

// 将被裁剪掉的旧工具轮次浓缩为单行摘要，避免模型遗忘已执行的步骤
function summarizeDroppedRounds(arr, droppedRoundIndices) {
  const lines = [];
  for (const rIndices of droppedRoundIndices) {
    for (const idx of rIndices) {
      const m = arr[idx];
      if (!m) continue;
      if (m.role === 'tool') {
        const name = m.name || 'tool';
        const firstLine = String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 110);
        lines.push('- ' + name + ': ' + firstLine + (String(m.content || '').length > 110 ? '…' : ''));
      }
    }
  }
  if (!lines.length) return '';
  return '【早期步骤摘要（完整工具输出已折叠以节省上下文，请勿重复调用相同参数）】\n' + lines.slice(-8).join('\n');
}

// 按字符预算裁剪 Agent 循环消息；返回新数组（不修改原数组，便于测试与断点续存）
function trimAgentMessages(messages, loopStartIdx, budget) {
  budget = budget > 0 ? budget : 24000;
  const arr = Array.isArray(messages) ? messages : [];
  if (arr.length <= 1) return arr.slice();
  let start = Math.max(0, Math.min(loopStartIdx | 0, arr.length));
  const msgLen = (m) => {
    try { return JSON.stringify(m).length; } catch (e) { return 0; }
  };
  let total = 0;
  for (const m of arr) total += msgLen(m);
  if (total <= budget) return arr.slice();
  // 找出本轮循环内的"轮次"边界：每轮以 role=assistant 开头
  const rounds = [];
  let cur = -1;
  for (let i = start; i < arr.length; i++) {
    if (arr[i] && arr[i].role === 'assistant') { cur = rounds.length; rounds.push([i]); }
    else if (cur >= 0) rounds[cur].push(i);
  }
  // 至少保留最后一轮（当前正在进行的上下文），从最旧的轮次开始删
  const doomed = new Set();
  const droppedRounds = [];
  for (let r = 0; r < rounds.length - 1 && total > budget; r++) {
    droppedRounds.push(rounds[r]);
    for (const i of rounds[r]) { doomed.add(i); total -= msgLen(arr[i]); }
  }
  if (!doomed.size) return arr.slice();
  const digest = summarizeDroppedRounds(arr, droppedRounds);
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    if (i === start && digest && out.length > 0 && out[0].role === 'system') {
      // 把早期步骤摘要附加在 system prompt 末尾，既不破坏 user/assistant/tool 消息序列，又能让模型感知历史调用
      out[0] = { role: 'system', content: out[0].content + '\n\n' + digest };
    }
    if (!doomed.has(i)) out.push(arr[i]);
  }
  return out;
}

export {
  truncateToolResult,
  readErrorBody,
  toolCallSignature,
  trimAgentMessages,
};
