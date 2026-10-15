// Telegram Agent 主循环：自主规划 → 工具调用 → 汇总作答（_worker.js 原第 1311-1344,1468-1704 行）

import { buildAIRequest } from '../channel.js';
import { parseDSMLToolCalls, stripDSMLBlocks } from './dsml.js';
import { truncateToolResult, readErrorBody, toolCallSignature, trimAgentMessages } from './stability.js';
import { agentLimits, describeToolCall } from './limits.js';
import { agentSaveResumeState } from './resume.js';
import { readUpstreamMessage } from './upstream.js';
import { getAgentTools, execAgentTool } from './tools.js';
import { agentGetMemories } from './memory.js';
import { buildAgentSystemPrompt } from './prompt.js';
import { kbGetRegistry } from '../kb/registry.js';

// 工具结果是否算失败。只认工具层自己的固定前缀，避免正文里偶然出现
// "失败"二字（如新闻标题）被误判，导致正常结果也被当成空转。
function isToolResultFailure(result) {
  const s = String(result == null ? '' : result);
  return /^(搜索失败|搜索请求失败|搜索「[^」]*」无结果|抓取失败|URL 非法|该地址禁止抓取|不支持抓取|计算失败|计算结果非法|时区无效|天气查询失败|找不到城市|工具执行失败|工具 [^ ]+ 执行超时|未知工具|R2 未绑定|知识库文档写入|记忆写入|内容为空|标题为空|城市名为空|表达式为空|表达式含非法字符)/.test(s);
}

// 步数用尽后的无工具收尾：不再提供 tools，强制模型把已有结果收成最终答案。
// 剩余预算不足 8 秒或上游报错时返回 null，由调用方走原来的暂停 / 已产出兜底。
async function agentWrapUp(env, targetModelId, messages, loopStartIdx, ctxBudget, deadline, onDelta) {
  if (Date.now() > deadline - 8000) return null;
  const sendMessages = trimAgentMessages(messages, loopStartIdx, ctxBudget).concat([{
    role: 'user',
    content: '【系统提示】可用的推理步数已用尽，不能再调用任何工具。请仅根据上面已经拿到的工具结果，直接给出最终答案：先给结论，再说明依据；没查到的部分明确说"未查到"，不要编造，也不要再输出调用计划或工具名。'
  }]);
  const cfg = buildAIRequest(env, targetModelId, sendMessages, true, null);
  if (cfg.error) return null;
  let resp;
  try {
    const remainMs = Math.max(0, deadline - Date.now());
    resp = await fetch(cfg.apiUrl, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + cfg.currentApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg.payload),
      signal: AbortSignal.timeout(Math.max(8000, Math.min(60000, remainMs)))
    });
  } catch (e) { return null; }
  if (!resp.ok) { try { await resp.body.cancel(); } catch (e) {} return null; }
  let msg;
  try { msg = await readUpstreamMessage(resp, onDelta); }
  catch (e) { return null; }
  const clean = stripDSMLBlocks(msg.content || '').trim();
  if (!clean) return null;
  if (msg.forwarded && clean === String(msg.content || '').trim()) return { text: clean, streamed: true };
  return { text: clean, streamed: false };
}

function tgAgentDeadline(env, opts) {
  let timeoutMs = agentLimits(env).timeoutMs;
  // webhook 场景传入 maxRuntimeMs：HTTP 响应必须在 Telegram 因超时重发 update
  // 之前返回（约 60 秒），取两者较小值，避免整体预算形同虚设
  if (opts && opts.maxRuntimeMs > 0 && opts.maxRuntimeMs < timeoutMs) timeoutMs = opts.maxRuntimeMs;
  return Date.now() + timeoutMs;
}

async function tgAgentChat(env, tgApi, chatId, targetModelId, history, allowTools, onProgress, opts) {
  const query = history.length ? String(history[history.length - 1].content || '') : '';
  // v6.9.3：Web 端（opts.kbReadOnly）对知识库只读——写入类工具
  // （remember / save_doc / delete_doc）不注入，提示词同步改为只读规则，
  // 并穿透到执行层硬拦截幻觉出的写入调用。
  // v6.9.5：只读端不产生长期记忆，直接跳过 agentGetMemories，省去每次新 Web 会话 2 次无效 R2 GET。
  const kbReadOnly = !!(opts && opts.kbReadOnly);
  const memories = kbReadOnly ? [] : await agentGetMemories(env, chatId);
  // Web 端（opts.kbFirst）查询优先知识库：把文档注册表注入系统提示词，
  // 让模型开局就看到全部标题并按"知识库优先"作答，不依赖它自觉先调 list_docs。
  let kbDocs = null;
  if (opts && opts.kbFirst) {
    try { kbDocs = await kbGetRegistry(env); } catch (e) { kbDocs = null; }
  }
  const systemPrompt = buildAgentSystemPrompt(memories, query, kbDocs, kbReadOnly);
  const tools = allowTools ? getAgentTools(kbReadOnly) : null;
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const m of history) messages.push({ role: m.role, content: m.content });

  const deadline = tgAgentDeadline(env, opts);
  const origUserText = (opts && opts.origUserText) !== undefined ? opts.origUserText : query;
  return await tgAgentRunLoop(env, tgApi, chatId, targetModelId, messages, tools, allowTools, onProgress, deadline,
    (opts && opts.resumeKey) || null, false, undefined,
    (opts && opts.onDelta) || null, (opts && opts.onReset) || null, kbReadOnly, origUserText);
}

// 「继续」入口：messages 里已包含 system + 历史，直接接着跑（仅 Telegram）
async function tgAgentResume(env, tgApi, chatId, saved, onProgress, opts) {
  const allowTools = !!saved.allowTools;
  const tools = allowTools ? getAgentTools() : null;
  const deadline = tgAgentDeadline(env, opts);
  // v6.8.1：把首次运行时的 loopStartIdx 带回来，裁剪才能触及之前各段的老轮次，
  // 否则多段「继续」会让上下文无限增长；老版本存档无此字段则回退为旧行为
  const baseLoopStartIdx = (typeof saved.loopStartIdx === 'number' && saved.loopStartIdx >= 0) ? saved.loopStartIdx : undefined;
  return await tgAgentRunLoop(env, tgApi, chatId, saved.targetModelId, saved.messages, tools, allowTools, onProgress, deadline,
    (opts && opts.resumeKey) || null, true, baseLoopStartIdx,
    (opts && opts.onDelta) || null, (opts && opts.onReset) || null, false, saved.origUserText || '');
}

async function tgAgentRunLoop(env, tgApi, chatId, targetModelId, messages, tools, allowTools, onProgress, deadline, resumeKey, isResume, baseLoopStartIdx, onDelta, onReset, kbReadOnly, origUserText) {
  const maxSteps = agentLimits(env).maxSteps;
  // 真流式开关：默认开启，向上游请求 stream: true 并边读边转发正文增量。
  // 若某条通道不支持「流式 + tools」的组合，设 AGENT_STREAM_UPSTREAM=0 退回整段等待。
  const useUpstreamStream = env.AGENT_STREAM_UPSTREAM !== '0';
  // 撤回已推给客户端的正文（仅当本轮确实推过内容时才发事件）
  const rollbackStreamed = async (forwarded) => {
    if (!forwarded || typeof onReset !== 'function') return;
    try { await onReset(); } catch (e) {}
  };
  const lastAssistantText = () => {
    const f = [...messages].reverse().find(m => m.role === 'assistant' && m.content);
    return f ? f.content : '';
  };
  // 本轮循环在 messages 中的起始下标：上下文裁剪只动这之后的消息，
  // system 与历史对话永不裁剪。「继续」时传入首次运行的下标，老轮次也可被裁剪。
  const loopStartIdx = (typeof baseLoopStartIdx === 'number' && baseLoopStartIdx >= 0)
    ? Math.min(baseLoopStartIdx, messages.length)
    : messages.length;
  // 上下文预算（字符数，env AGENT_CONTEXT_BUDGET 可配，默认 24000）
  let ctxBudget = parseInt(env.AGENT_CONTEXT_BUDGET || '24000', 10);
  if (!(ctxBudget > 0)) ctxBudget = 24000;
  // 超时暂停：保存循环状态，用户发「继续」即恢复。无 R2 时退化为直接终结。
  const pauseForResume = async () => {
    const t = stripDSMLBlocks(lastAssistantText());
    let saved = false;
    if (resumeKey) {
      saved = await agentSaveResumeState(env, chatId, {
        v: 1, savedAt: Date.now(), chatId, targetModelId, allowTools,
        messages: trimAgentMessages(messages, loopStartIdx, ctxBudget),
        loopStartIdx: loopStartIdx,
        origUserText: origUserText || ''
      });
    }
    if (saved) {
      return { text: '⏸️ 任务较长，已暂停并保存进度，发送「继续」让我接着做。' + (t ? '\n\n已产出：\n' + t : ''), usedTools: true, paused: true };
    }
    return { text: '（本次任务超时，已停止）' + (t ? '\n\n' + t : ''), usedTools: true };
  };

  // typing 心跳：长推理 / 长工具调用期间每 20 秒刷新一次"正在输入"，
  // 任何 return / throw 分支都会在 finally 里清理定时器
  const heartbeat = setInterval(() => {
    try { tgApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}); } catch (e) {}
  }, 20000);
  try {
  // 重复调用熔断：记录每步工具调用签名，连续 3 步完全相同即判定模型原地打转
  const callSigHistory = [];
  // v6.9.4：工具失败计数。同一工具连续失败时注入纠偏提示，避免模型用同样参数空转
  let toolFailStreak = 0;
  for (let step = 0; step < maxSteps; step++) {
    if (Date.now() > deadline) return await pauseForResume();
    const stepLabel = '🤖 Agent 思考中' + (isResume ? '（继续）' : '') + '（第 ' + (step + 1) + ' 步）…';
    // 每步开始先报进度：LLM 长思考时用户也能看到活着
    if (typeof onProgress === 'function') {
      try { await onProgress(stepLabel); } catch (e) {}
    }
    // 长推理时保持 typing 状态不消失
    try { tgApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}); } catch (e) {}

    // 超预算时裁剪本轮循环产生的旧 tool 轮次（成对删除，保证消息序列合法）
    const sendMessages = trimAgentMessages(messages, loopStartIdx, ctxBudget);
    // 真流式：请求 stream: true，正文 / 推理增量边到边推给客户端（AGENT_STREAM_UPSTREAM=0 可关）
    const cfg = buildAIRequest(env, targetModelId, sendMessages, useUpstreamStream, tools);
    if (cfg.error) return { error: cfg.error };

    let resp;
    try {
      const remainMs = Math.max(0, deadline - Date.now());
      resp = await fetch(cfg.apiUrl, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cfg.currentApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg.payload),
        signal: AbortSignal.timeout(Math.max(15000, Math.min(180000, remainMs)))
      });
    } catch (e) {
      const nm = e && e.name ? String(e.name) : '';
      const msg = String((e && e.message) || '');
      const aborted = nm === 'AbortError' || nm === 'TimeoutError' || /abort/i.test(msg);
      if (aborted && Date.now() >= deadline - 2000) return await pauseForResume();
      if (aborted) return { error: '上游响应超时，请重试或换个问法' };
      return { error: '网络错误：' + (msg || String(e)) };
    }

    if (!resp.ok) {
      const t = await readErrorBody(resp, 2048);
      if (allowTools && step === 0 &&
          ((resp.status >= 400 && resp.status < 500) || /tool|function|unsupported/i.test(t))) {
        return { fallback: true };
      }
      return { error: 'API 报错 (' + resp.status + ')：' + String(t).slice(0, 500) };
    }

    let msg;
    try {
      msg = await readUpstreamMessage(resp, onDelta);
    } catch (e) {
      const nm = e && e.name ? String(e.name) : '';
      const emsg = String((e && e.message) || '');
      const aborted = nm === 'AbortError' || nm === 'TimeoutError' || /abort/i.test(emsg);
      if (aborted) {
        await rollbackStreamed(true);
        if (Date.now() >= deadline - 2000) return await pauseForResume();
        return { error: '上游响应超时，请重试或换个问法' };
      }
      if (nm === 'UpstreamSSEError') return { error: '上游返回错误：' + emsg };
      return { error: '网络错误：' + (emsg || String(e)) };
    }

    // 图片生成通道：直接返回图片链接（不走工具循环）
    if (msg.imageUrl) {
      return { text: '[🖼️ 点击查看生成的图片](' + msg.imageUrl + ')', usedTools: false, isImage: true };
    }
    if (!msg.content && !msg.toolCalls.length && !msg.reasoning) {
      return { error: 'AI 没有返回有效内容' };
    }

    // 原生 tool_calls 为空时，尝试从 content 解析 DSML 文本格式工具调用
    let toolCalls = msg.toolCalls || [];
    let assistantText = msg.content || '';
    if (!toolCalls.length && assistantText.indexOf('DSML') !== -1) {
      const dsmlCalls = parseDSMLToolCalls(assistantText);
      if (dsmlCalls.length) {
        toolCalls = dsmlCalls;
        assistantText = stripDSMLBlocks(assistantText);
      }
    }
    const assistantMsg = { role: 'assistant', content: assistantText };
    if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
    const reasoning = msg.reasoning || '';
    if (reasoning) assistantMsg.reasoning_content = reasoning;
    messages.push(assistantMsg);

    // 兜底：任何返回给用户的文本都不允许携带 DSML markup
    if (!toolCalls.length) {
      const clean = stripDSMLBlocks(assistantText).trim();
      if (!clean) {
        await rollbackStreamed(msg.forwarded);
        const text = assistantText.indexOf('DSML') !== -1
          ? '（工具调用格式解析失败，已隐藏原始标记，请换个问法重试或切换模型）'
          : (reasoning ? '（模型思考后没有给出文字答复，请换个问法重试）' : '（模型返回了空内容，请换个问法重试）');
        return { text: text, usedTools: step > 0 };
      }
      if (msg.forwarded && clean === assistantText.trim()) {
        return { text: clean, usedTools: step > 0, streamed: true };
      }
      await rollbackStreamed(msg.forwarded);
      return { text: clean, usedTools: step > 0 };
    }

    // 重复调用熔断：连续 3 步工具调用完全相同 → 判定原地打转，直接收尾
    const stepSig = toolCalls.map(toolCallSignature).sort().join(';;');
    callSigHistory.push(stepSig);
    if (callSigHistory.length >= 3 &&
        callSigHistory[callSigHistory.length - 1] === stepSig &&
        callSigHistory[callSigHistory.length - 2] === stepSig &&
        callSigHistory[callSigHistory.length - 3] === stepSig) {
      await rollbackStreamed(msg.forwarded);
      const prefix = stripDSMLBlocks(assistantText).trim();
      return { text: (prefix ? prefix + '\n\n' : '') + '（检测到重复调用同一工具，已停止以避免空转；请换个问法或补充信息后重试）', usedTools: true };
    }

    await rollbackStreamed(msg.forwarded);

    // 进度提示：让用户看到 Agent 在干什么（force 突破节流）
    if (typeof onProgress === 'function') {
      try {
        const descs = toolCalls.map(tc => {
          const fn = (tc && tc.function) || {};
          let a = {};
          try { a = JSON.parse(fn.arguments || '{}'); } catch (e) {}
          return describeToolCall(fn.name || 'unknown', a);
        });
        await onProgress(stepLabel + '\n' + descs.join('\n'), true);
      } catch (e) {}
    }

    // 同一步的多个工具调用并行执行（顺序写回，保证消息顺序）
    const toolResults = await Promise.all(toolCalls.map(async (tc) => {
      const fn = (tc && tc.function) || {};
      let args = {};
      try { args = JSON.parse(fn.arguments || '{}'); } catch (e) {}
      if (!fn.name) return { tc, result: '工具调用缺少名称，已跳过', failed: true };
      const result = await execAgentTool(fn.name, args, env, chatId, kbReadOnly);
      return { tc, result: truncateToolResult(result, 4000), failed: isToolResultFailure(result) };
    }));
    let stepFailed = 0;
    for (const tr of toolResults) {
      const fn = (tr.tc && tr.tc.function) || {};
      messages.push({
        role: 'tool',
        tool_call_id: tr.tc.id,
        name: fn.name || 'unknown',
        content: tr.result
      });
      if (tr.failed) stepFailed += 1;
    }
    if (toolResults.length && stepFailed === toolResults.length) toolFailStreak += 1;
    else toolFailStreak = 0;
    if (toolFailStreak >= 2) {
      messages.push({
        role: 'user',
        content: '【系统提示】最近的工具调用连续失败。请换关键词、换工具或换思路；若已无法取得更多信息，请基于已有结果直接给出最终答案，并明确说明哪些信息没查到。不要再用相同参数重复调用。'
      });
    }
  }
  } finally {
    clearInterval(heartbeat);
  }
  // 步数用尽：先做一次无工具收尾，让模型基于已有工具结果给出最终答案。
  const wrapUp = await agentWrapUp(env, targetModelId, messages, loopStartIdx, ctxBudget, deadline, onDelta);
  if (wrapUp && wrapUp.text) return { text: wrapUp.text, usedTools: true, streamed: !!wrapUp.streamed };
  const t = stripDSMLBlocks(lastAssistantText());
  if (resumeKey) {
    const saved = await agentSaveResumeState(env, chatId, {
      v: 1, savedAt: Date.now(), chatId, targetModelId, allowTools,
      messages: trimAgentMessages(messages, loopStartIdx, ctxBudget),
      loopStartIdx: loopStartIdx,
      origUserText: origUserText || ''
    });
    if (saved) {
      return { text: '⏸️ 推理步数已用尽，进度已保存，发送「继续」让我接着做。' + (t ? '\n\n已产出：\n' + t : ''), usedTools: true, paused: true };
    }
  }
  return { text: t || '（思考步数已用尽，请换个问法重试）', usedTools: true };
}

export {
  isToolResultFailure,
  tgAgentDeadline,
  tgAgentChat,
  tgAgentResume,
  tgAgentRunLoop,
};
