// Agent 稳定性增强：智能边界截断（自动闭合代码块）、调用签名、带历史步骤摘要压缩的上下文预算裁剪

// ==================== Agent 稳定性增强（v7.2.0 智能边界截断与步骤摘要） ====================
// 1) truncateToolResult：超长工具结果优先在段落/换行边界截断，并自动闭合未配对的 ``` 代码块围栏，
//    防止截断在半句话或半个代码块中间破坏上下文结构。
// 2) toolCallSignature：工具调用签名，用于"重复调用熔断"与"同轮记忆化去重"。
// 3) trimAgentMessages：上下文预算裁剪，被裁剪的旧轮次自动浓缩为轻量级【早期步骤摘要】。

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
  const rounds = [];
  let cur = -1;
  for (let i = start; i < arr.length; i++) {
    if (arr[i] && arr[i].role === 'assistant') { cur = rounds.length; rounds.push([i]); }
    else if (cur >= 0) rounds[cur].push(i);
  }
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
