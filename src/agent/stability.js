// Agent 稳定性增强：智能边界截断（自动闭合代码块）、调用签名、两阶段上下文预算裁剪
//
// v7.5.0 关键修复：旧版 trimAgentMessages 只从 loopStartIdx（本轮起点）往后丢轮次，
// 历史部分（system 之后、本轮之前的多轮对话）永远不参与裁剪。Telegram / 微信的
// 历史被 tgTrimHistory 限制在 12000 字符以内，但一旦 system prompt（含知识库列表、
// 记忆）+ 本轮工具输出本身就很长，总预算必然被击穿，而裁剪函数什么也做不了 ——
// 表现为长会话里上游 400（context length）或模型开始遗忘本轮刚查到的内容。
// 现在改为两阶段：先丢本轮已完成的工具轮次，仍超预算再压缩更早的历史轮次
// （保留最近 2 轮原文），两段压缩结果都并入 system 提示，模型不会"失忆"。

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

// 按字符预算裁剪 Agent 循环消息；返回新数组（不修改原数组，便于测试与断点续存）
// loopStartIdx：本轮起点（该位置之前的都是历史对话，之后的是本轮 ReAct 轨迹）
function trimAgentMessages(messages, loopStartIdx, budget) {
  budget = budget > 0 ? budget : 24000;
  const arr = Array.isArray(messages) ? messages : [];
  if (arr.length <= 1) return arr.slice();
  const start = Math.max(0, Math.min(loopStartIdx | 0, arr.length));
  const msgLen = (m) => {
    try { return JSON.stringify(m).length; } catch (e) { return 0; }
  };
  let total = 0;
  for (const m of arr) total += msgLen(m);
  if (total <= budget) return arr.slice();

  const dropped = new Set();
  const digests = [];

  // ---------- 阶段 1：丢弃本轮已完成的工具轮次（保留最后 1 轮） ----------
  const rounds = [];
  let cur = -1;
  for (let i = start; i < arr.length; i++) {
    if (arr[i] && arr[i].role === 'assistant') { cur = rounds.length; rounds.push([i]); }
    else if (cur >= 0) rounds[cur].push(i);
  }
  const droppedRounds = [];
  for (let r = 0; r < rounds.length - 1 && total > budget; r++) {
    droppedRounds.push(rounds[r]);
    for (const i of rounds[r]) { dropped.add(i); total -= msgLen(arr[i]); }
  }
  if (droppedRounds.length) {
    const d = summarizeDroppedRounds(arr, droppedRounds);
    if (d) digests.push(d);
  }

  // ---------- 阶段 2：压缩更早的历史轮次 ----------
  // 先尝试保留最近 2 轮原文；仍超预算就继续压到只留摘要（逐步收紧，尽量少丢信息）
  const compressedIdx = [];
  if (total > budget && start > 1) {
    for (const keep of [4, 2, 0]) {
      if (total <= budget) break;
      const histIdx = [];
      for (let i = 1; i < start; i++) if (!dropped.has(i)) histIdx.push(i);
      const compressible = histIdx.slice(0, Math.max(0, histIdx.length - keep));
      if (!compressible.length) continue;
      for (const i of compressible) {
        dropped.add(i);
        total -= msgLen(arr[i]);
        compressedIdx.push(i);
      }
    }
  }
  const compressedHistory = compressedIdx.length;
  if (compressedHistory) {
    const d = summarizeDroppedHistory(arr, compressedIdx);
    if (d) digests.push(d);
  }

  // ---------- 组装 ----------
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    if (!dropped.has(i)) out.push(arr[i]);
  }
  if (!out.length) return arr.slice();

  if (digests.length && out[0] && out[0].role === 'system') {
    out[0] = { role: 'system', content: String(out[0].content || '') + '\n\n' + digests.join('\n\n') };
  }

  // 防御：历史被压缩后，system 之后的第一条必须仍是 user 消息，
  // 否则上游（严格校验 OpenAI 消息序列）会直接 400。
  if (compressedHistory > 0) {
    while (out.length > 1 && out[1].role !== 'user') out.splice(1, 1);
  }
  return out;
}

export {
  truncateToolResult,
  readErrorBody,
  toolCallSignature,
  trimAgentMessages,
};
