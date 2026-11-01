// Telegram / 微信 / Web 三端共用 Agent 主循环：自主规划 → 工具调用 → 汇总作答
//
// v7.6.0 性能与可靠性升级：
// 1) 工具参数先修复再执行：被 max_tokens 截断的 JSON 由 parseToolArguments 确定性补齐；
//    修不好直接回灌"参数解析失败"并跳过执行，不再拿空参数白跑一次；
// 2) 截断可见：上游 finish_reason=length 时在最终答案后补一句"回复继续可接着写"，
//    流式场景用增量补发，网页端也能看到；
// 3) 断点续做保存裁剪后的本轮起点，恢复后不会把历史工具轮次误当成本轮轨迹；
// 4) 上下文裁剪新增硬预算压缩，保证真正送上游的请求不超预算（详见 stability.js）。
//
// v7.5.0 内核加固（在 v7.2.0 性能优化基础上的可靠性升级）：
// 1) 并发闸门：单步内模型可能一次吐 6~8 个 tool_calls，旧版 Promise.all 会同时打出同样多
//    的外部请求；现在按 AGENT_TOOL_CONCURRENCY（默认 4）限流，结果顺序不变；
// 2) 预算感知的工具超时：单工具超时 = min(AGENT_TOOL_TIMEOUT_MS, 本轮剩余 - 收尾预留)，
//    剩余不足时直接跳过并如实告知，把最后的时间留给收尾作答，避免"任务超时且零结果"；
// 3) 步数感知：剩余步数 ≤2 时向系统提示注入收束指令，显著降低"最后一步还在查资料"；
// 4) 空转熔断双保险：连续 2 步同签名（原有）+ 单轮内同签名累计 3 次（新增，抓 A→B→A→B）；
// 5) 失败提示去重：工具连续全失败只提醒一次，不再每步重复污染上下文；
// 6) 断点续做保留只读权限位：恢复后不会突然多出写入工具；
// 7) 进度文案带步数与耗时，长任务可感知。

import { buildAIRequest } from '../channel.js';
import { parseDSMLToolCalls, stripDSMLBlocks } from './dsml.js';
import { truncateToolResult, readErrorBody, parseToolArguments, toolCallSignature,
  trimAgentMessages, trimAgentMessagesEx } from './stability.js';
import { agentLimits, describeToolCall } from './limits.js';
import { agentSaveResumeState } from './resume.js';
import { readUpstreamMessage } from './upstream.js';
import { getAgentTools, execAgentTool, isToolFailureResult } from './tools.js';
import { agentGetMemories } from './memory.js';
import { buildAgentSystemPrompt } from './prompt.js';
import { kbGetRegistry } from '../kb/registry.js';
import { mapLimit } from '../utils.js';

const WRITE_TOOLS_SET = new Set(['remember', 'forget_memory', 'save_doc', 'delete_doc']);

const TRUNC_NOTE = '\n\n> ⚠️ 输出达到模型单次长度上限被截断，回复「继续」可以让我接着写完。';

// 兼容旧导出名：失败判定已收敛到 tools.js（前缀表 + 兜底正则），此处仅做转发
const isToolResultFailure = isToolFailureResult;

// 最终答案收尾：流式已把正文逐字推完时，截断提示要用增量补发，否则网页端只看得到半截
async function finalizeAnswer(text, finishReason, streamed, onDelta) {
  const t = String(text || '').trim();
  if (finishReason !== 'length') return { text: t, streamed: !!streamed };
  if (streamed && typeof onDelta === 'function') {
    try { await onDelta(TRUNC_NOTE, 'content'); } catch (e) {}
  }
  return { text: t + TRUNC_NOTE, streamed: !!streamed };
}

// 收尾作答：不再提供 tools，强制模型把已有结果收成最终答案。
async function agentWrapUp(env, targetModelId, messages, loopStartIdx, ctxBudget, deadline, onDelta, reserveMs) {
  const reserve = reserveMs > 0 ? reserveMs : 8000;
  if (Date.now() > deadline - reserve * 0.5) return null;
  const sendMessages = trimAgentMessages(messages, loopStartIdx, ctxBudget).concat([{
    role: 'user',
    content: '【系统提示】工具调用阶段已结束，不能再调用任何工具。请仅根据上面已经拿到的工具结果，直接给出最终答案：先给结论，再说明依据；没查到的部分明确说"未查到"，不要编造，也不要再输出调用计划或工具名。'
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
  if (msg.forwarded && clean === String(msg.content || '').trim()) {
    return await finalizeAnswer(clean, msg.finishReason, true, onDelta);
  }
  return await finalizeAnswer(clean, msg.finishReason, false, onDelta);
}

function tgAgentDeadline(env, opts) {
  const limits = agentLimits(env);
  let timeoutMs = limits.timeoutMs;
  if (opts && opts.maxRuntimeMs > 0 && opts.maxRuntimeMs < timeoutMs) timeoutMs = opts.maxRuntimeMs;
  return Date.now() + timeoutMs;
}

// 提取消息的纯文本部分（兼容多模态数组 [{type:'text', text:'...'}, {type:'image_url',...}]）
function extractMsgPlainText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(p => p && p.type === 'text' && typeof p.text === 'string')
      .map(p => p.text)
      .join('\n');
  }
  return String(content || '');
}

// 剩余步数 ≤2 时把收束指令并入本轮 system 提示（不改动原始 messages，
// 也不插在 tool 消息后面，避免个别上游对消息序列校验过严）
function withStepBudgetHint(sendMessages, step, maxSteps) {
  if (!Array.isArray(sendMessages) || !sendMessages.length) return sendMessages;
  const remainAfter = maxSteps - step - 1;
  if (!(remainAfter <= 2)) return sendMessages;
  if (sendMessages[0].role !== 'system') return sendMessages;
  let tail;
  if (remainAfter <= 0) {
    tail = '这是本轮最后一步：只做最关键的一次调用（或直接作答），拿到结果必须立刻给出最终答案。';
  } else if (remainAfter === 1) {
    tail = '之后只剩 1 次工具机会：只补最关键的缺口，拿到结果立刻作答。';
  } else {
    tail = '之后只剩 2 次工具机会：请优先补齐最关键的缺口，不要发散；信息已够就直接给出最终答案。';
  }
  const out = sendMessages.slice();
  out[0] = {
    role: 'system',
    content: String(sendMessages[0].content || '')
      + '\n\n【本轮进度】已进入第 ' + (step + 1) + '/' + maxSteps + ' 步。' + tail
  };
  return out;
}

async function tgAgentChat(env, tgApi, chatId, targetModelId, history, allowTools, onProgress, opts) {
  const query = history.length ? extractMsgPlainText(history[history.length - 1].content) : '';
  const kbReadOnly = !!(opts && opts.kbReadOnly);
  // 并发加载长期记忆与知识库文档注册表
  const [memories, kbDocs] = await Promise.all([
    kbReadOnly ? Promise.resolve([]) : agentGetMemories(env, chatId),
    kbGetRegistry(env).catch(() => null)
  ]);
  const hasKbDocs = Array.isArray(kbDocs) ? kbDocs.length > 0 : undefined;
  const systemPrompt = buildAgentSystemPrompt(memories, query, kbDocs, kbReadOnly);
  const tools = allowTools ? getAgentTools(kbReadOnly, { hasKbDocs }) : null;
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const m of history) messages.push({ role: m.role, content: m.content });

  const deadline = tgAgentDeadline(env, opts);
  const origUserText = (opts && opts.origUserText) !== undefined ? opts.origUserText : query;
  return await tgAgentRunLoop(env, tgApi, chatId, targetModelId, messages, tools, allowTools, onProgress, deadline,
    (opts && opts.resumeKey) || null, false, undefined,
    (opts && opts.onDelta) || null, (opts && opts.onReset) || null, kbReadOnly, origUserText,
    hasKbDocs);
}

// 「继续」入口：messages 里已包含 system + 历史，直接接着跑（仅 Telegram / 微信）
async function tgAgentResume(env, tgApi, chatId, saved, onProgress, opts) {
  const allowTools = !!saved.allowTools;
  const kbReadOnly = !!saved.kbReadOnly;
  const tools = allowTools ? getAgentTools(kbReadOnly, { hasKbDocs: saved.hasKbDocs }) : null;
  const deadline = tgAgentDeadline(env, opts);
  const baseLoopStartIdx = (typeof saved.loopStartIdx === 'number' && saved.loopStartIdx >= 0) ? saved.loopStartIdx : undefined;
  return await tgAgentRunLoop(env, tgApi, chatId, saved.targetModelId, saved.messages, tools, allowTools, onProgress, deadline,
    (opts && opts.resumeKey) || null, true, baseLoopStartIdx,
    (opts && opts.onDelta) || null, (opts && opts.onReset) || null, kbReadOnly, saved.origUserText || '',
    saved.hasKbDocs);
}

async function tgAgentRunLoop(env, tgApi, chatId, targetModelId, messages, tools, allowTools, onProgress, deadline, resumeKey, isResume, baseLoopStartIdx, onDelta, onReset, kbReadOnly, origUserText, hasKbDocs) {
  const limits = agentLimits(env);
  const maxSteps = limits.maxSteps;
  const ctxBudget = limits.ctxBudget;
  const useUpstreamStream = env.AGENT_STREAM_UPSTREAM !== '0';
  const loopStartedAt = Date.now();
  // 收尾预留不能吃掉整个预算：单轮预算很小时（如用户把 TG_WEBHOOK_BUDGET_MS 调到 10 秒）
  // 固定预留 8 秒会导致第一步就被判定超时。按总预算的 30% 封顶，且至少保留 1.5 秒硬线。
  const totalBudgetMs = Math.max(0, deadline - loopStartedAt);
  const wrapReserveMs = Math.max(1500, Math.min(limits.wrapReserveMs, Math.floor(totalBudgetMs * 0.3)));

  const rollbackStreamed = async (forwarded) => {
    if (!forwarded || typeof onReset !== 'function') return;
    try { await onReset(); } catch (e) {}
  };
  // 非阻塞触发进度回调，避免 Telegram editMessageText 网络往返阻塞大模型请求与工具执行
  const fireProgress = (text, force) => {
    if (typeof onProgress !== 'function') return;
    try { Promise.resolve(onProgress(text, force)).catch(() => {}); } catch (e) {}
  };
  const lastAssistantText = () => {
    const f = [...messages].reverse().find(m => m.role === 'assistant' && m.content);
    return f ? f.content : '';
  };
  const loopStartIdx = (typeof baseLoopStartIdx === 'number' && baseLoopStartIdx >= 0)
    ? Math.min(baseLoopStartIdx, messages.length)
    : messages.length;

  const persistState = async () => {
    if (!resumeKey) return false;
    // 用裁剪后的数组 + 修正后的本轮起点存档：旧版存的是未裁剪数组的起点，
    // 恢复后起点会错位，把历史工具轮次误当成本轮轨迹（还会让裁剪产生孤儿 tool 消息）
    const trimmed = trimAgentMessagesEx(messages, loopStartIdx, ctxBudget);
    return await agentSaveResumeState(env, chatId, {
      v: 2, savedAt: Date.now(), chatId, targetModelId, allowTools,
      kbReadOnly: !!kbReadOnly,
      hasKbDocs: hasKbDocs,
      messages: trimmed.messages,
      loopStartIdx: trimmed.loopStartIdx,
      origUserText: origUserText || ''
    });
  };

  const pauseForResume = async () => {
    const t = stripDSMLBlocks(lastAssistantText());
    const saved = await persistState();
    if (saved) {
      return { text: '⏸️ 任务较长，已暂停并保存进度，发送「继续」让我接着做。' + (t ? '\n\n已产出：\n' + t : ''), usedTools: true, paused: true };
    }
    return { text: '（本次任务超时，已停止）' + (t ? '\n\n' + t : ''), usedTools: true };
  };

  const heartbeat = setInterval(() => {
    try { tgApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}); } catch (e) {}
  }, 20000);
  try {
  const callSigHistory = [];
  const sigCount = new Map();   // sig -> 本轮累计出现次数
  const turnToolMemo = new Map(); // sig -> { step, preview } 同轮只读工具记忆化去重
  let toolFailStreak = 0;
  let failStreakNotified = false;

  for (let step = 0; step < maxSteps; step++) {
    const nowMs = Date.now();
    // 硬线：连收尾都来不及；软线：后续步骤要给 wrapUp 留出时间（第一步不受软线限制）
    if (nowMs > deadline - 1500 || (step > 0 && nowMs > deadline - wrapReserveMs)) {
      return await pauseForResume();
    }
    const elapsedSec = Math.max(1, Math.round((Date.now() - loopStartedAt) / 1000));
    const stepLabel = '🤖 Agent 思考中' + (isResume ? '（继续）' : '')
      + '（第 ' + (step + 1) + '/' + maxSteps + ' 步 · ' + elapsedSec + 's）…';
    fireProgress(stepLabel, false);
    try { tgApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}); } catch (e) {}

    const sendMessages = withStepBudgetHint(
      trimAgentMessages(messages, loopStartIdx, ctxBudget), step, maxSteps);
    const cfg = buildAIRequest(env, targetModelId, sendMessages, useUpstreamStream, tools);
    if (cfg.error) return { error: cfg.error };

    const keyPool = Array.isArray(cfg.channelKeys) && cfg.channelKeys.length > 0 ? cfg.channelKeys : [cfg.currentApiKey];
    let resp = null;
    let lastFetchErr = null;
    const maxAttempts = (Date.now() < deadline - 12000) ? 2 : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const activeKey = attempt === 0
        ? cfg.currentApiKey
        : keyPool[(keyPool.indexOf(cfg.currentApiKey) + attempt) % keyPool.length];
      try {
        const remainMs = Math.max(0, deadline - Date.now());
        resp = await fetch(cfg.apiUrl, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + activeKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(cfg.payload),
          signal: AbortSignal.timeout(Math.max(15000, Math.min(180000, remainMs)))
        });
        lastFetchErr = null;
        if (resp.ok) break;
        const isTransient = resp.status === 429 || resp.status === 502 || resp.status === 503 || resp.status === 504;
        if (isTransient && attempt + 1 < maxAttempts && Date.now() < deadline - 10000) {
          try { if (resp.body) await resp.body.cancel(); } catch (e) {}
          await new Promise(r => setTimeout(r, 900 * (attempt + 1)));
          continue;
        }
        break;
      } catch (e) {
        lastFetchErr = e;
        const nm = e && e.name ? String(e.name) : '';
        const msg = String((e && e.message) || '');
        const aborted = nm === 'AbortError' || nm === 'TimeoutError' || /abort/i.test(msg);
        if (aborted) break;
        if (attempt + 1 < maxAttempts && Date.now() < deadline - 10000) {
          await new Promise(r => setTimeout(r, 800));
          continue;
        }
      }
    }

    if (lastFetchErr) {
      const nm = lastFetchErr && lastFetchErr.name ? String(lastFetchErr.name) : '';
      const msg = String((lastFetchErr && lastFetchErr.message) || '');
      const aborted = nm === 'AbortError' || nm === 'TimeoutError' || /abort/i.test(msg);
      if (aborted && Date.now() >= deadline - 2000) return await pauseForResume();
      if (aborted) return { error: '上游响应超时，请重试或换个问法' };
      return { error: '网络错误：' + (msg || String(lastFetchErr)) };
    }

    if (!resp.ok) {
      const t = await readErrorBody(resp, 2048);
      if (allowTools && step === 0 &&
          ((resp.status >= 400 && resp.status < 500 && resp.status !== 401 && resp.status !== 429) || /tool|function|unsupported|vision|image/i.test(t))) {
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

    if (msg.imageUrl) {
      return { text: '[🖼️ 点击查看生成的图片](' + msg.imageUrl + ')', usedTools: false, isImage: true };
    }
    if (!msg.content && !msg.toolCalls.length && !msg.reasoning) {
      return { error: 'AI 没有返回有效内容' };
    }

    let toolCalls = msg.toolCalls || [];
    let assistantText = msg.content || '';
    if (!toolCalls.length && assistantText.indexOf('DSML') !== -1) {
      const dsmlCalls = parseDSMLToolCalls(assistantText);
      if (dsmlCalls.length) {
        toolCalls = dsmlCalls;
        assistantText = stripDSMLBlocks(assistantText);
      }
    }

    const stepSig = toolCalls.map(toolCallSignature).sort().join(';;');
    callSigHistory.push(stepSig);
    if (toolCalls.length) sigCount.set(stepSig, (sigCount.get(stepSig) || 0) + 1);

    // 空转熔断：连续 2 步完全相同的调用组合（原有）+ 本轮累计 3 次（新增，抓 A→B→A→B 式绕圈）
    const consecutiveDup = callSigHistory.length >= 2
      && callSigHistory[callSigHistory.length - 1] === stepSig
      && callSigHistory[callSigHistory.length - 2] === stepSig;
    const accumulatedDup = toolCalls.length > 0 && (sigCount.get(stepSig) || 0) >= 3;
    if (consecutiveDup || accumulatedDup) {
      await rollbackStreamed(msg.forwarded);
      const wrapEarly = await agentWrapUp(env, targetModelId, messages, loopStartIdx, ctxBudget, deadline, onDelta, wrapReserveMs);
      if (wrapEarly && wrapEarly.text) return { text: wrapEarly.text, usedTools: true, streamed: !!wrapEarly.streamed };
      const prefix = stripDSMLBlocks(assistantText).trim();
      return { text: (prefix ? prefix + '\n\n' : '') + '（检测到重复调用同一工具，已停止以避免空转；请换个问法或补充信息后重试）', usedTools: true };
    }

    const assistantMsg = { role: 'assistant', content: assistantText };
    if (toolCalls.length) {
      // 回灌给上游的 assistant.tool_calls 必须是合法 JSON：原始串可能被 max_tokens
      // 截断，严格校验的上游会直接 400。统一换成修复后的参数（修不好就是 {}），
      // 真正的失败原因由随后的 tool 消息告诉模型。
      assistantMsg.tool_calls = toolCalls.map((tc) => {
        const fn = (tc && tc.function) || {};
        const parsed = parseToolArguments(fn.arguments);
        return { ...tc, function: { ...fn, arguments: JSON.stringify(parsed.args || {}) } };
      });
    }
    const reasoning = msg.reasoning || '';
    if (reasoning) assistantMsg.reasoning_content = reasoning;
    messages.push(assistantMsg);

    if (!toolCalls.length) {
      const clean = stripDSMLBlocks(assistantText).trim();
      if (!clean) {
        await rollbackStreamed(msg.forwarded);
        const text = assistantText.indexOf('DSML') !== -1
          ? '（工具调用格式解析失败，已隐藏原始标记，请换个问法重试或切换模型）'
          : (msg.finishReason === 'length'
            ? '（模型输出达到单次长度上限，未产出正文；请把问题拆小后重试，或调大 MAX_TOKENS）'
            : (reasoning ? '（模型思考后没有给出文字答复，请换个问法重试）' : '（模型返回了空内容，请换个问法重试）'));
        return { text: text, usedTools: step > 0 };
      }
      if (msg.forwarded && clean === assistantText.trim()) {
        const fin = await finalizeAnswer(clean, msg.finishReason, true, onDelta);
        return { text: fin.text, usedTools: step > 0, streamed: true };
      }
      await rollbackStreamed(msg.forwarded);
      const fin2 = await finalizeAnswer(clean, msg.finishReason, false, onDelta);
      return { text: fin2.text, usedTools: step > 0 };
    }

    await rollbackStreamed(msg.forwarded);

    const descs = toolCalls.map(tc => {
      const fn = (tc && tc.function) || {};
      const parsed = parseToolArguments(fn.arguments);
      return describeToolCall(fn.name || 'unknown', parsed.args || {});
    });
    fireProgress(stepLabel + '\n' + descs.join('\n'), true);

    // 预算感知：把本轮剩余时间折进单工具超时，最后时刻不再为一个工具空等
    const remainBeforeTools = deadline - Date.now();
    const toolTimeoutCap = Math.max(800, Math.min(limits.toolTimeoutMs, remainBeforeTools - 1500));

    const toolResults = await mapLimit(toolCalls, limits.toolConcurrency, async (tc) => {
      const fn = (tc && tc.function) || {};
      if (!fn.name) return { tc, result: '工具调用缺少名称，已跳过', failed: true, ms: 0 };
      // 参数先修复再执行：被截断的 JSON 修不好时直接判失败并告诉模型怎么改，
      // 避免拿 {} 去跑一次必然失败的工具，白烧一步与一份上下文
      const parsed = parseToolArguments(fn.arguments);
      if (parsed.error) {
        return {
          tc,
          result: '工具调用参数解析失败：' + parsed.error + '。本次调用已跳过，请补齐被截断的引号/括号后重新输出完整 JSON 参数再试。',
          failed: true,
          ms: 0
        };
      }
      const args = parsed.args || {};
      const sig = toolCallSignature(tc);
      const isReadOnlyTool = !WRITE_TOOLS_SET.has(fn.name);
      // 同轮记忆化短路：本轮前面步骤已经成功调用过一模一样的只读工具，0ms 返回提示，不再重复请求或撑大上下文
      if (isReadOnlyTool && turnToolMemo.has(sig)) {
        const prev = turnToolMemo.get(sig);
        return {
          tc,
          result: `【本轮第 ${prev.step} 步已执行过完全相同的调用，结果摘要：${prev.preview} —— 请直接依据前文结果作答或换其它参数】`,
          failed: false,
          ms: 0
        };
      }
      if (remainBeforeTools < 2000) {
        return { tc, result: '剩余时间不足，已跳过本次工具调用；请直接基于已有信息作答', failed: true, ms: 0 };
      }
      const t0 = Date.now();
      const result = await execAgentTool(fn.name, args, env, chatId, kbReadOnly, { timeoutMs: toolTimeoutCap });
      const ms = Math.max(1, Date.now() - t0);
      const failed = isToolFailureResult(result);
      const truncated = truncateToolResult(result, 4000);
      if (isReadOnlyTool && !failed) {
        turnToolMemo.set(sig, {
          step: step + 1,
          preview: String(truncated).replace(/\s+/g, ' ').slice(0, 160)
        });
      }
      return { tc, result: truncated, failed, ms };
    });

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
    else { toolFailStreak = 0; failStreakNotified = false; }

    // 连续两轮全失败才提醒，且整轮只提醒一次（旧版每步都插一条，白烧上下文）
    if (toolFailStreak >= 2 && !failStreakNotified) {
      failStreakNotified = true;
      const failedNames = toolResults
        .filter(tr => tr.failed)
        .map(tr => (tr.tc && tr.tc.function && tr.tc.function.name) || 'tool')
        .filter((v, i, a) => a.indexOf(v) === i)
        .join('、');
      messages.push({
        role: 'user',
        content: '【系统提示】最近两轮工具调用全部失败（' + failedNames + '）。请换关键词、换工具或换思路；若已无法取得更多信息，请基于已有结果直接给出最终答案，并明确说明哪些信息没查到。不要再用相同参数重复调用。'
      });
    }
  }
  } finally {
    clearInterval(heartbeat);
  }

  const wrapUp = await agentWrapUp(env, targetModelId, messages, loopStartIdx, ctxBudget, deadline, onDelta, wrapReserveMs);
  if (wrapUp && wrapUp.text) return { text: wrapUp.text, usedTools: true, streamed: !!wrapUp.streamed };
  const t = stripDSMLBlocks(lastAssistantText());
  if (await persistState()) {
    return { text: '⏸️ 推理步数已用尽，进度已保存，发送「继续」让我接着做。' + (t ? '\n\n已产出：\n' + t : ''), usedTools: true, paused: true };
  }
  return { text: t || '（思考步数已用尽，请换个问法重试）', usedTools: true };
}

export {
  isToolResultFailure,
  extractMsgPlainText,
  tgAgentDeadline,
  tgAgentChat,
  tgAgentResume,
  tgAgentRunLoop,
};
