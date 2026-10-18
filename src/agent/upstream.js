// 上游流式读取：把 SSE 还原成与非流式相同的 message 形状（v7.1.0 增强：流式实时拦截 DSML 工具调用标记）

// ==================== 上游流式读取（Agent 真流式） ====================
// 把上游的 SSE 流还原成与「非流式」完全相同的 message 形状：
//   { content, reasoning, toolCalls, forwarded, imageUrl }
// 这样 Agent 循环里的 tool_calls 判定、DSML 兜底、熔断、工具执行等逻辑一行都不用改，
// 变的只是"怎么拿到 msg"。同时把正文 / 推理增量实时回调出去，实现逐字输出。
//
// v7.1.0 性能优化与闪烁消除：
// 当使用 DeepSeek 等输出 <｜DSML｜tool_calls> 文本标记的通道时，一旦检测到流中出现 DSML 起始标签，
// 立即将 sawToolCalls 置为 true 并停止向前端透传后续 XML 原始字符，消除网页端看到整段 XML 刷屏再被撤回的闪烁。
async function readUpstreamMessage(resp, onDelta) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let raw = '';          // 完整原文，供非 SSE 兜底解析
  let buffer = '';       // 行缓冲
  let content = '';
  let reasoning = '';
  let forwarded = false;
  const toolMap = new Map(); // 按 index 合并流式 tool_calls 分片
  let sawSSE = false;
  let sawToolCalls = false;  // 一旦出现工具调用（含 DSML 标记），这一步的后续正文不再外发

  const emit = async (text, kind) => {
    if (!text || typeof onDelta !== 'function') return;
    try { await onDelta(text, kind); } catch (e) {}
    if (kind === 'content') forwarded = true;
  };

  // 返回 true 表示遇到 [DONE]，可以停止读取
  const consumeLine = async (line) => {
    line = line.trim();
    if (!line || line.charAt(0) === ':') return false;
    if (line.indexOf('data:') !== 0) return false;
    sawSSE = true;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return true;
    let ev = null;
    try { ev = JSON.parse(payload); } catch (e) { return false; }
    if (ev && ev.error) {
      const err = new Error(ev.error.message || JSON.stringify(ev.error));
      err.name = 'UpstreamSSEError';
      throw err;
    }
    const choice = ev && ev.choices && ev.choices[0];
    if (!choice) return false;
    const d = choice.delta || choice.message || {};
    const rc = d.reasoning_content || d.reasoning || '';
    if (rc) { reasoning += rc; await emit(rc, 'reasoning'); }
    if (Array.isArray(d.tool_calls) && d.tool_calls.length) {
      sawToolCalls = true;
      for (const tc of d.tool_calls) {
        const idx = typeof tc.index === 'number' ? tc.index : toolMap.size;
        let slot = toolMap.get(idx);
        if (!slot) {
          slot = { id: '', type: 'function', function: { name: '', arguments: '' } };
          toolMap.set(idx, slot);
        }
        if (tc.id) slot.id = tc.id;
        if (tc.type) slot.type = tc.type;
        const fn = tc.function || {};
        if (fn.name && !slot.function.name) slot.function.name = fn.name;
        if (fn.arguments) slot.function.arguments += fn.arguments;
      }
    }
    if (d.content) {
      content += d.content;
      // v7.1.0：一旦流式正文中开始出现 <｜DSML｜ 标记，立即阻断后续内容向前端透传
      if (!sawToolCalls && content.indexOf('DSML') !== -1 && /<\s*[|｜]\s*DSML/i.test(content)) {
        sawToolCalls = true;
      }
      if (!sawToolCalls) await emit(d.content, 'content');
    }
    return false;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    raw += chunk;
    if (raw.length > 4000000) { try { await reader.cancel(); } catch (e) {} break; }
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    let stop = false;
    for (const line of lines) {
      if (await consumeLine(line)) { stop = true; break; }
    }
    if (stop) { try { await reader.cancel(); } catch (e) {} break; }
  }
  if (buffer.trim()) {
    try { await consumeLine(buffer); } catch (e) { if (e && e.name === 'UpstreamSSEError') throw e; }
  }

  if (!sawSSE) {
    try {
      const j = JSON.parse(raw);
      if (j && j.data && j.data[0] && (j.data[0].url || j.data[0].b64_json)) {
        return { imageUrl: j.data[0].url || ('data:image/png;base64,' + j.data[0].b64_json), content: '', reasoning: '', toolCalls: [], forwarded: false };
      }
      const ch = j && j.choices && j.choices[0];
      const m = ch && (ch.message || ch.delta);
      if (m) {
        return {
          content: m.content || '',
          reasoning: m.reasoning_content || m.reasoning || '',
          toolCalls: m.tool_calls || [],
          forwarded: false
        };
      }
    } catch (e) {}
  }

  const toolCalls = Array.from(toolMap.keys()).sort((a, b) => a - b).map(k => toolMap.get(k));
  return { content, reasoning, toolCalls, forwarded };
}

export {
  readUpstreamMessage,
};
