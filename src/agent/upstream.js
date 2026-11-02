// 上游流式读取：把 SSE 还原成与非流式相同的 message 形状
// （v7.1.0 流式实时拦截 DSML 工具调用标记；v7.6.0 读取链路降耗）

// ==================== 上游流式读取（Agent 真流式） ====================
// 把上游的 SSE 流还原成与「非流式」完全相同的 message 形状：
//   { content, reasoning, toolCalls, forwarded, imageUrl, finishReason }
// 这样 Agent 循环里的 tool_calls 判定、DSML 兜底、熔断、工具执行等逻辑一行都不用改，
// 变的只是"怎么拿到 msg"。同时把正文 / 推理增量实时回调出去，实现逐字输出。
//
// v7.6.0：
// 1) 只有确认不是 SSE 时才缓存原文（旧版对每个流式响应都留一份最多 4MB 的 raw，
//    纯属内存与拷贝浪费），非 SSE 兜底解析不受影响；
// 2) onDelta 改为串行排队、不阻塞读取：旧版每个 token 都 await 一次前端回调，
//    前端稍慢就会拖慢上游读取；顺序仍然严格保持，收尾时统一等待队列排空；
// 3) 捕获 finish_reason：length 说明输出被 max_tokens 截断，交给循环补「继续」提示。
async function readUpstreamMessage(resp, onDelta) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let raw = '';          // 仅在确认非 SSE 时累积，供 JSON 兜底解析
  let buffer = '';       // 行缓冲
  let content = '';
  let reasoning = '';
  let forwarded = false;
  let finishReason = '';
  const toolMap = new Map(); // 按 index 合并流式 tool_calls 分片
  let sawSSE = false;
  let sawToolCalls = false;  // 一旦出现工具调用（含 DSML 标记），这一步的后续正文不再外发
  let dsmlScanFrom = 0;      // DSML 标记的增量扫描位置（旧版每个分片都重扫全文，长回复是 O(n²)）
  let emitChain = Promise.resolve();

  const emit = (text, kind) => {
    if (!text) return;
    if (kind === 'content') forwarded = true;
    if (typeof onDelta !== 'function') return;
    emitChain = emitChain.then(() => onDelta(text, kind)).catch(() => {});
  };

  // 返回 true 表示遇到 [DONE]，可以停止读取
  const consumeLine = (line) => {
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
    if (choice.finish_reason) finishReason = String(choice.finish_reason);
    const d = choice.delta || choice.message || {};
    const rc = d.reasoning_content || d.reasoning || '';
    if (rc) { reasoning += rc; emit(rc, 'reasoning'); }
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
      // 一旦流式正文中开始出现 <｜DSML｜ 标记，立即阻断后续内容向前端透传。
      // 只扫「新增片段 + 20 字符重叠窗口」：标记可能被切在两个分片之间，
      // 但窗口足够覆盖，无需每次重扫整段累积正文。
      if (!sawToolCalls) {
        const from = dsmlScanFrom > 20 ? dsmlScanFrom - 20 : 0;
        if (/<\s*[|｜]\s*DSML/i.test(content.slice(from))) sawToolCalls = true;
        dsmlScanFrom = content.length;
      }
      if (!sawToolCalls) emit(d.content, 'content');
    }
    return false;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    let stop = false;
    for (const line of lines) {
      if (consumeLine(line)) { stop = true; break; }
    }
    if (!sawSSE) {
      raw += chunk;
      if (raw.length > 4000000) { try { await reader.cancel(); } catch (e) {} break; }
    }
    if (stop) { try { await reader.cancel(); } catch (e) {} break; }
  }
  if (buffer.trim()) {
    try { consumeLine(buffer); } catch (e) { if (e && e.name === 'UpstreamSSEError') throw e; }
  }
  try { await emitChain; } catch (e) {}

  if (!sawSSE) {
    try {
      const j = JSON.parse(raw);
      if (j && j.data && j.data[0] && (j.data[0].url || j.data[0].b64_json)) {
        return { imageUrl: j.data[0].url || ('data:image/png;base64,' + j.data[0].b64_json), content: '', reasoning: '', toolCalls: [], forwarded: false, finishReason: '' };
      }
      const ch = j && j.choices && j.choices[0];
      const m = ch && (ch.message || ch.delta);
      if (m) {
        return {
          content: m.content || '',
          reasoning: m.reasoning_content || m.reasoning || '',
          toolCalls: m.tool_calls || [],
          forwarded: false,
          finishReason: (ch && ch.finish_reason) || ''
        };
      }
    } catch (e) {}
  }

  const toolCalls = Array.from(toolMap.keys()).sort((a, b) => a - b).map(k => toolMap.get(k));
  return { content, reasoning, toolCalls, forwarded, finishReason };
}

export {
  readUpstreamMessage,
};
