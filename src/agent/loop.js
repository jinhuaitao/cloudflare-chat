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

function tgAgentDeadline(env, opts) {
  let timeoutMs = agentLimits(env).timeoutMs;
  // webhook 场景传入 maxRuntimeMs：HTTP 响应必须在 Telegram 因超时重发 update
  // 之前返回（约 60 秒），取两者较小值，避免整体预算形同虚设
  if (opts && opts.maxRuntimeMs > 0 && opts.maxRuntimeMs < timeoutMs) timeoutMs = opts.maxRuntimeMs;
  return Date.now() + timeoutMs;
}

async function tgAgentChat(env, tgApi, chatId, targetModelId, history, allowTools, onProgress, opts) {
  const query = history.length ? String(history[history.length - 1].content || '') : '';
  const memories = await agentGetMemories(env, chatId);
  // Web 端（opts.kbFirst）查询优先知识库：把文档注册表注入系统提示词，
  // 让模型开局就看到全部标题并按"知识库优先"作答，不依赖它自觉先调 list_docs。
  // 注册表读取失败不阻断对话，按"无知识库"处理。
  let kbDocs = null;
  if (opts && opts.kbFirst) {
    try { kbDocs = await kbGetRegistry(env); } catch (e) { kbDocs = null; }
  }
  // v6.9.3：Web 端（opts.kbReadOnly）对知识库只读——写入类工具
  // （remember / save_doc / delete_doc）不注入，提示词同步改为只读规则，
  // 并穿透到执行层硬拦截幻觉出的写入调用。
  const kbReadOnly = !!(opts && opts.kbReadOnly);
  const systemPrompt = buildAgentSystemPrompt(memories, query, kbDocs, kbReadOnly);
  const tools = allowTools ? getAgentTools(kbReadOnly) : null;
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const m of history) messages.push({ role: m.role, content: m.content });

  const deadline = tgAgentDeadline(env, opts);
  return await tgAgentRunLoop(env, tgApi, chatId, targetModelId, messages, tools, allowTools, onProgress, deadline,
    (opts && opts.resumeKey) || null, false, undefined,
    (opts && opts.onDelta) || null, (opts && opts.onReset) || null, kbReadOnly);
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
    (opts && opts.onDelta) || null, (opts && opts.onReset) || null, false);
}
async function tgAgentRunLoop(env, tgApi, chatId, targetModelId, messages, tools, allowTools, onProgress, deadline, resumeKey, isResume, baseLoopStartIdx, onDelta, onReset, kbReadOnly) {
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
  // v6.8.2 作用域修复：loopStartIdx 与 ctxBudget 必须在函数作用域声明、
  // 且位于 pauseForResume 之前。之前误放在 try 块内，而 pauseForResume
  // 与步数用尽分支都在 try 块之外引用它们，导致 ReferenceError: loopStartIdx is not defined。
  // 本轮循环在 messages 中的起始下标：上下文裁剪只动这之后的消息，
  // system 与历史对话永不裁剪。「继续」时传入首次运行的下标，老轮次也可被裁剪，
  // 防止多段续做让上下文无限增长。
  const loopStartIdx = (typeof baseLoopStartIdx === 'number' && baseLoopStartIdx >= 0)
    ? Math.min(baseLoopStartIdx, messages.length)
    : messages.length;
  // 上下文预算（字符数，env AGENT_CONTEXT_BUDGET 可配，默认 24000）
  let ctxBudget = parseInt(env.AGENT_CONTEXT_BUDGET || '24000', 10);
  if (!(ctxBudget > 0)) ctxBudget = 24000;
  // 超时暂停：保存循环状态，用户发「继续」即恢复。无 R2 时退化为直接终结。
  // v6.8.1：保存前先按上下文预算裁剪本轮老轮次（trim 只删 loopStartIdx 之后的消息，
  // 该下标本身不受影响，可原样存档），否则多段「继续」会让存档与发送量无限增长。
  const pauseForResume = async () => {
    const t = stripDSMLBlocks(lastAssistantText());
    let saved = false;
    if (resumeKey) {
      saved = await agentSaveResumeState(env, chatId, {
        v: 1, savedAt: Date.now(), chatId, targetModelId, allowTools,
        messages: trimAgentMessages(messages, loopStartIdx, ctxBudget),
        loopStartIdx: loopStartIdx
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
      // 单步超时取 3 分钟与整体剩余预算的较小值：避免整体 deadline 已过，
      // 还被一次上游调用拖住几分钟（webhook 必须在 Telegram 重发前返回）
      const remainMs = Math.max(0, deadline - Date.now());
      resp = await fetch(cfg.apiUrl, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cfg.currentApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg.payload),
        signal: AbortSignal.timeout(Math.max(15000, Math.min(180000, remainMs)))
      });
    } catch (e) {
      // 中断分类：AbortSignal.timeout() 抛的是 TimeoutError（不是 AbortError），
      // 两种都可能是"上游 hung 住"或"我们自己的整体预算耗尽"。用 deadline 区分：
      // 预算耗尽 -> 暂停并保存进度（可「继续」）；否则 -> 上游超时提示。
      const nm = e && e.name ? String(e.name) : '';
      const msg = String((e && e.message) || '');
      const aborted = nm === 'AbortError' || nm === 'TimeoutError' || /abort/i.test(msg);
      if (aborted && Date.now() >= deadline - 2000) return await pauseForResume();
      if (aborted) return { error: '上游响应超时，请重试或换个问法' };
      return { error: '网络错误：' + (msg || String(e)) };
    }

    if (!resp.ok) {
      // v6.8.7：错误体预算读取（2KB），超大错误页不再整段读入
      const t = await readErrorBody(resp, 2048);
      // 降级判定：通道不支持 tools 时的报错五花八门（Invalid parameter: functions、
      // unsupported parameter、400 Bad Request…），只认 "tool" 关键词会漏判，
      // 用户就会拿到一个红色 API 报错而不是自动降级。首步拿到 4xx 一律先降级成
      // 普通对话重试一次 —— 带工具的请求代价远高于多跑一次无工具的请求。
      if (allowTools && step === 0 &&
          ((resp.status >= 400 && resp.status < 500) || /tool|function|unsupported/i.test(t))) {
        return { fallback: true };
      }
      return { error: 'API 报错 (' + resp.status + ')：' + String(t).slice(0, 500) };
    }

    // 读取上游：流式时正文边到边推给客户端，非流式时整段返回；
    // 两种形态统一还原成 { content, reasoning, toolCalls, forwarded, imageUrl }
    let msg;
    try {
      msg = await readUpstreamMessage(resp, onDelta);
    } catch (e) {
      // 中断分类与上面 fetch 一致：预算耗尽 -> 暂停并保存进度；否则 -> 上游 / 网络错误
      const nm = e && e.name ? String(e.name) : '';
      const emsg = String((e && e.message) || '');
      const aborted = nm === 'AbortError' || nm === 'TimeoutError' || /abort/i.test(emsg);
      if (aborted) {
        // 流式过程中可能已经推了半截正文出去，先撤回再收尾
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
    // （DeepSeek V3.2/V4 系模型 + 裸透传通道的组合会产生这种输出）
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
    // 推理模型（DeepSeek R1 等）多轮工具调用要求回传 reasoning_content，
    // 否则后续轮次会丢失推理上下文；不返回该字段的模型无影响
    const reasoning = msg.reasoning || '';
    if (reasoning) assistantMsg.reasoning_content = reasoning;
    messages.push(assistantMsg);

    // 兜底：任何返回给用户的文本都不允许携带 DSML markup
    if (!toolCalls.length) {
      const clean = stripDSMLBlocks(assistantText).trim();
      if (!clean) {
        // 没有可展示的正文（可能刚把 DSML 标记推了出去）→ 先撤回再给兜底提示
        await rollbackStreamed(msg.forwarded);
        const text = assistantText.indexOf('DSML') !== -1
          ? '（工具调用格式解析失败，已隐藏原始标记，请换个问法重试或切换模型）'
          : (reasoning ? '（模型思考后没有给出文字答复，请换个问法重试）' : '（模型返回了空内容，请换个问法重试）');
        return { text: text, usedTools: step > 0 };
      }
      // 正文已经在流式过程中推给客户端、且清洗后与推出去的完全一致 → 不必重发
      if (msg.forwarded && clean === assistantText.trim()) {
        return { text: clean, usedTools: step > 0, streamed: true };
      }
      // 其余情况（上游没流式 / 清洗改动了文本）→ 撤回已推内容，由调用方补发干净文本
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

    // 这一步是工具调用：流式过程中若已把模型的"开场白"推给了用户，必须撤回 ——
    // 否则它会和后续的最终答案首尾拼在一起，读起来是错的。
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
      if (!fn.name) return { tc, result: '工具调用缺少名称，已跳过' };
      const result = await execAgentTool(fn.name, args, env, chatId, kbReadOnly);
      return { tc, result: truncateToolResult(result, 4000) };
    }));
    for (const tr of toolResults) {
      const fn = (tr.tc && tr.tc.function) || {};
      messages.push({
        role: 'tool',
        tool_call_id: tr.tc.id,
        name: fn.name || 'unknown',
        content: tr.result
      });
    }
  }
  } finally {
    clearInterval(heartbeat);
  }
  // 步数用尽：同样保存进度，允许「继续」（保存前先裁剪，见 pauseForResume 注释）
  const t = stripDSMLBlocks(lastAssistantText());
  if (resumeKey) {
    const saved = await agentSaveResumeState(env, chatId, {
      v: 1, savedAt: Date.now(), chatId, targetModelId, allowTools,
      messages: trimAgentMessages(messages, loopStartIdx, ctxBudget),
      loopStartIdx: loopStartIdx
    });
    if (saved) {
      return { text: '⏸️ 推理步数已用尽，进度已保存，发送「继续」让我接着做。' + (t ? '\n\n已产出：\n' + t : ''), usedTools: true, paused: true };
    }
  }
  return { text: t || '（思考步数已用尽，请换个问法重试）', usedTools: true };
}

export {
  tgAgentDeadline,
  tgAgentChat,
  tgAgentResume,
  tgAgentRunLoop,
};
