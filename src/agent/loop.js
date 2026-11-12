// Telegram / 微信 / Web 三端共用 Agent 主循环：自主规划 → 工具调用 → 汇总作答
//
// v7.8.0 性能专项：
// 1) 前缀缓存友好：整轮内 system 提示保持字节级不变。旧版把「本轮进度」拼进 system[0]，
//    只要剩下 ≤2 步就改写整段前缀，上游的前缀缓存（DeepSeek/OpenAI/Moonshot 自动开启）
//    当场失效，那两步等于重新 prefill 全部上下文。现在改为在消息末尾追加一条 user 提示，
//    前缀恒定，只有尾部增量变化 —— 这是本轮最大的延迟与成本收益；
// 2) 单步工具输出按预算分摊：一次吐 4 个工具、每个 4000 字符，一步就把 24000 字符预算塞满，
//    下一步必然触发全量压缩（前缀失效 + 早期信息被折叠），等于白跑一步。
//    现在单工具上限 = min(4000, 上下文预算 / 本步工具数)，把预算摊到整轮；
// 3) 上游请求超时贴合 deadline：旧版下限写死 15 秒，剩余预算只剩 5 秒时仍会等 15 秒，
//    直接把收尾时间吃光。现在按剩余预算收紧，最少留 3 秒；
// 4) 记忆 / 知识库的 R2 读取加超时兜底：R2 抖动不再拖住首字；
// 5) AGENT_DEBUG_STATS=1 时输出单行耗时统计（步数/工具数/上下文规模），便于量化调优。
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
import { agentLimits, describeToolCall, toolResultCap } from './limits.js';
import { agentSaveResumeState } from './resume.js';
import { readUpstreamMessage } from './upstream.js';
import { getAgentTools, execAgentTool, isToolFailureResult, failureRecoveryHint } from './tools.js';
import { memoryLoad, memoryRecordTurn } from '../memory/index.js';
import { buildAgentSystemPrompt } from './prompt.js';
import { kbGetRegistry } from '../kb/registry.js';
import { mapLimit } from '../utils.js';
import { sanitizeHistory, lastUserText } from './history.js';
import { agentGetPersona } from './mode.js';
import { resolvePersona, personaById, personaAllowsTool, formatPersonaBadge, formatRouteHit, DEFAULT_PERSONA_ID } from './personas.js';

const WRITE_TOOLS_SET = new Set(['remember', 'forget_memory', 'save_doc', 'delete_doc']);

// 不参与「同轮记忆化」的只读工具。
// web_fetch 读的是外部实时状态：同一步里让模型再取一次同一个 URL，语义上就应该重新取
// （页面可能刚更新、上一次可能取到截断内容）。它本身在 tools-web.js 里有 3 分钟页面缓存 +
// inflight 合并，重复请求的代价接近于零，所以在循环层再拦一次只会有害无益。
const NO_MEMO_TOOLS = new Set(['web_fetch']);


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
    content: '【系统提示】工具调用阶段已结束，不能再调用任何工具。请仅根据上面已经拿到的工具结果，直接给出最终答案：先给结论，再说明依据；没查到的部分明确说"未查到"，不要编造，也不要再输出调用计划或工具名。数字、日期、价格、版本号必须原样引用工具结果，不要凭记忆改写或换算；不同来源的数据不一致时，如实说明分歧并给出更权威或更新的一方。'
  }]);
  // 传空数组而非 null：收尾作答不携带 tools（避免模型继续调用），
  // 但能让 buildAIRequest 识别这是 Agent 步骤，同样享受 AGENT_TEMPERATURE 低温采样
  const cfg = buildAIRequest(env, targetModelId, sendMessages, true, []);
  if (cfg.error) return null;
  let resp;
  try {
    const remainMs = Math.max(0, deadline - Date.now());
    resp = await fetch(cfg.apiUrl, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + cfg.currentApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg.payload),
      // v7.9.0：与主循环一致，贴合 deadline。旧版下限 8 秒，剩余 3 秒时仍会等 8 秒，
      // 用户拿到的是"超时"而不是已经整理好的部分答案
      signal: AbortSignal.timeout(Math.max(3000, Math.min(60000, remainMs - 300)))
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

// 剩余步数 ≤2 时生成一条收束提示。
// v7.8.0：不再改写 system 消息，而是作为末尾的 user 消息追加 —— 前缀保持稳定，
// 上游前缀缓存才不会因为一句提示就整段失效。
function buildStepHint(step, maxSteps) {
  const remainAfter = maxSteps - step - 1;
  if (!(remainAfter <= 2)) return '';
  let tail;
  if (remainAfter <= 0) {
    tail = '这是本轮最后一步：只做最关键的一次调用（或直接作答），拿到结果必须立刻给出最终答案。';
  } else if (remainAfter === 1) {
    tail = '之后只剩 1 次工具机会：只补最关键的缺口，拿到结果立刻作答。';
  } else {
    tail = '之后只剩 2 次工具机会：请优先补齐最关键的缺口，不要发散；信息已够就直接给出最终答案。';
  }
  return '【本轮进度】已进入第 ' + (step + 1) + '/' + maxSteps + ' 步。' + tail;
}

// R2 读取兜底：记忆与知识库注册表都走对象存储，抖动时不该让用户干等首字
function withTimeout(promise, ms, fallback) {
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([Promise.resolve(promise).catch(() => fallback), guard])
    .finally(() => { if (timer) clearTimeout(timer); });
}

async function tgAgentChat(env, tgApi, chatId, targetModelId, history, allowTools, onProgress, opts) {
  // v7.9.0：外部历史先清洗再进上下文。
  // Web 端的 messages 完全由浏览器提供，旧版原样拼进去 —— 客户端可以塞一条 role=system
  // 直接改写 Agent 规则（prompt 注入），也可以塞非法 role 或把 assistant 放最前导致上游 400。
  const safeHistory = sanitizeHistory(history);
  if (!safeHistory.length) {
    return { error: '没有可用的提问内容：消息列表为空或缺少 user 消息。请先输入你的问题。' };
  }
  const query = lastUserText(safeHistory);
  const kbReadOnly = !!(opts && opts.kbReadOnly);
  // 并发加载三层记忆、知识库文档注册表与人格选择（各带兜底超时：R2 抖动不该拖住首字）。
  // v7.10.0：原来是"一次读长期记忆 + 一次读注册表"，现在 L1/L2/L3 三层在 memoryLoad
  // 内部并行读取，外层仍然只占一个等待位——多读两层不等于多等两轮。
  // v7.13.0：人格也走同一个等待位，命中 L1 缓存时零成本，冷缓存时与另外两读重叠。
  const r2BudgetMs = Math.max(500, Math.min(3000, (opts && opts.r2BudgetMs) || 1500));
  const [memoryBundle, kbDocs, savedPersona] = await Promise.all([
    withTimeout(memoryLoad(env, chatId, query, { readOnly: kbReadOnly }), r2BudgetMs, null),
    withTimeout(kbGetRegistry(env), r2BudgetMs, null),
    withTimeout(agentGetPersona(env, chatId), r2BudgetMs, 'auto')
  ]);
  const hasKbDocs = Array.isArray(kbDocs) ? kbDocs.length > 0 : undefined;
  // 显式指定（Web 请求体 / 本次调用参数）优先，其次是用户固定的人格，最后按提问自动路由
  const route = resolvePersona((opts && opts.persona) || savedPersona, query);
  const persona = route.persona;
  // 路由「为什么」：自动选中非通用角色时，首步进度里带一句「命中：xx、xx」，让用户看得见依据
  const routeWhy = formatRouteHit(route, 3);
  const systemPrompt = buildAgentSystemPrompt(
    memoryBundle ? memoryBundle.longterm : [], query, kbDocs, kbReadOnly, memoryBundle, persona
  );
  const tools = allowTools ? getAgentTools(kbReadOnly, { hasKbDocs, persona }) : null;
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const m of safeHistory) messages.push(m);

  const deadline = tgAgentDeadline(env, opts);
  const origUserText = (opts && opts.origUserText) !== undefined ? opts.origUserText : query;
  const result = await tgAgentRunLoop(env, tgApi, chatId, targetModelId, messages, tools, allowTools, onProgress, deadline,
    (opts && opts.resumeKey) || null, false, undefined,
    (opts && opts.onDelta) || null, (opts && opts.onReset) || null, kbReadOnly, origUserText,
    hasKbDocs, persona, routeWhy);
  // 回传本次实际使用的人格与路由依据：调用方可据此展示徽标与解释（Web 端也可选用）
  if (result && typeof result === 'object') {
    result.personaId = persona.id;
    result.personaRoute = { source: route.source, reason: route.reason, matched: route.matched.slice(0, 5) };
  }
  await recordWorkingMemory(env, chatId, origUserText, result, opts);
  return result;
}

// 回合结束写 L1 工作记忆。
// 放在主循环出口而不是三个 handler 里：TG / 微信 / Web 走的是同一条链路，
// 在这里加一次就全覆盖，也不会因为某个 handler 忘了调用而出现"某些端没有会话记忆"。
// 只读端（Web）默认不写：L1 虽然按会话隔离，但让公开网页往 R2 写数据没有收益，
// 需要时用 WEB_WORKING_MEMORY=1 打开。
async function recordWorkingMemory(env, chatId, userText, result, opts) {
  if (!result || result.error || result.paused || result.fallback) return;
  // 生图结果是一段 Markdown 图片链接，记成"要点"只会污染摘要
  if (result.isImage) return;
  const text = String(result.text || '').trim();
  if (!text) return;
  if (opts && opts.kbReadOnly && opts.workingMemory !== true) return;
  if (opts && opts.workingMemory === false) return;
  try {
    // 900ms 上限：一次 wmGet（通常命中内存缓存）+ 一次 R2 put，正常 50ms 内完成。
    // 超时就让写入在后台继续，绝不为了记一条要点把用户的首字/尾字拖慢。
    await withTimeout(memoryRecordTurn(env, chatId, userText || '', text), 900, null);
  } catch (e) {}
}

// 「继续」入口：messages 里已包含 system + 历史，直接接着跑（仅 Telegram / 微信）
async function tgAgentResume(env, tgApi, chatId, saved, onProgress, opts) {
  const allowTools = !!saved.allowTools;
  const kbReadOnly = !!saved.kbReadOnly;
  // 人格跟着存档走：恢复后不能因为自动路由换了个角色，导致工具集与提示词口径不一致。
  // 旧存档没有 personaId，回落通用人格（与旧版行为一致）。
  const persona = personaById(saved.personaId);
  const tools = allowTools ? getAgentTools(kbReadOnly, { hasKbDocs: saved.hasKbDocs, persona }) : null;
  const deadline = tgAgentDeadline(env, opts);
  const baseLoopStartIdx = (typeof saved.loopStartIdx === 'number' && saved.loopStartIdx >= 0) ? saved.loopStartIdx : undefined;
  const result = await tgAgentRunLoop(env, tgApi, chatId, saved.targetModelId, saved.messages, tools, allowTools, onProgress, deadline,
    (opts && opts.resumeKey) || null, true, baseLoopStartIdx,
    (opts && opts.onDelta) || null, (opts && opts.onReset) || null, kbReadOnly, saved.origUserText || '',
    saved.hasKbDocs, persona, '');
  await recordWorkingMemory(env, chatId, saved.origUserText || '', result, opts);
  return result;
}

async function tgAgentRunLoop(env, tgApi, chatId, targetModelId, messages, tools, allowTools, onProgress, deadline, resumeKey, isResume, baseLoopStartIdx, onDelta, onReset, kbReadOnly, origUserText, hasKbDocs, persona, routeWhy) {
  // 不原地修改调用方数组：断点存档的 messages 被 push 后就被污染了，
  // 同一份存档再跑一次（如 fallback 重试）会带着上一轮的 assistant/tool 消息，序列直接错乱
  messages = Array.isArray(messages) ? messages.slice() : [];
  persona = persona || personaById(DEFAULT_PERSONA_ID);
  const limits = agentLimits(env, persona);
  const maxSteps = limits.maxSteps;
  const ctxBudget = limits.ctxBudget;
  const useUpstreamStream = env.AGENT_STREAM_UPSTREAM !== '0';
  const keepReasoning = env.AGENT_KEEP_REASONING === '1';
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
    // 倒序扫描即可，旧版 [...messages].reverse() 每次都要复制整个数组
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === 'assistant' && m.content) return m.content;
    }
    return '';
  };
  // 关掉思维链回灌时，顺手清掉断点存档 / 外部历史里残留的 reasoning_content，
  // 否则恢复一次就白带几千字上下文
  if (!keepReasoning) {
    for (const m of messages) {
      if (m && m.reasoning_content) delete m.reasoning_content;
    }
  }
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
      // 人格跟着存档：恢复后工具集与提示词口径必须与暂停前一致
      personaId: persona.id,
      messages: trimmed.messages,
      loopStartIdx: trimmed.loopStartIdx,
      origUserText: origUserText || ''
    });
  };

  // v7.9.0：暂停 / 超时时，如果模型还没来及写总结，用户就只看到一句"任务较长"，
  // 前面辛苦查到的信息全丢了。这里把最后几条工具结果压成摘要附上。
  const toolDigest = (maxLines) => {
    const limit = maxLines > 0 ? maxLines : 4;
    const lines = [];
    for (let i = messages.length - 1; i >= 0 && lines.length < limit; i--) {
      const m = messages[i];
      if (!m || m.role !== 'tool') continue;
      const one = String(m.content || '').replace(/\s+/g, ' ').trim();
      if (!one) continue;
      lines.unshift('· ' + (m.name || 'tool') + '：' + (one.length > 90 ? one.slice(0, 90) + '…' : one));
    }
    return lines.length ? '已查到的信息：\n' + lines.join('\n') : '';
  };

  const pauseForResume = async () => {
    const t = stripDSMLBlocks(lastAssistantText());
    const digest = t ? '' : toolDigest(4);
    const saved = await persistState();
    if (saved) {
      return {
        text: '⏸️ 任务较长，已暂停并保存进度，发送「继续」让我接着做。'
          + (t ? '\n\n已产出：\n' + t : (digest ? '\n\n' + digest : '')),
        usedTools: true, paused: true
      };
    }
    return {
      text: '（本次任务超时，已停止）' + (t ? '\n\n' + t : (digest ? '\n\n' + digest : '')),
      usedTools: true
    };
  };

  const heartbeat = setInterval(() => {
    try { tgApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}); } catch (e) {}
  }, 20000);
  // 性能埋点：只在 AGENT_DEBUG_STATS=1 时输出，方便用 wrangler tail 量化每一步的真实开销
  const debugStats = env.AGENT_DEBUG_STATS === '1';
  const stats = { steps: 0, tools: 0, fails: 0, ctxChars: 0, ctxMsgs: 0 };
  const toolsChars = debugStats && tools ? JSON.stringify(tools).length : 0;
  const emitStats = () => {
    if (!debugStats) return;
    try {
      console.log('[agent-stats] ' + JSON.stringify({
        model: targetModelId, persona: persona.id,
        steps: stats.steps, tools: stats.tools, fails: stats.fails,
        ctxChars: stats.ctxChars, ctxMsgs: stats.ctxMsgs, toolsChars: toolsChars,
        ms: Date.now() - loopStartedAt, maxSteps: maxSteps, ctxBudget: ctxBudget
      }));
    } catch (e) {}
  };
  try {
  const callSigHistory = [];
  const sigCount = new Map();   // sig -> 本轮累计出现次数
  const turnToolMemo = new Map(); // sig -> { step, preview } 同轮只读工具记忆化去重
  const hintedTools = new Set(); // 本轮已给过失败建议的工具（每个工具只提示一次，避免污染上下文）
  let toolFailStreak = 0;
  let failStreakNotified = false;

  for (let step = 0; step < maxSteps; step++) {
    const nowMs = Date.now();
    // 硬线：连收尾都来不及；软线：后续步骤要给 wrapUp 留出时间（第一步不受软线限制）
    if (nowMs > deadline - 1500 || (step > 0 && nowMs > deadline - wrapReserveMs)) {
      return await pauseForResume();
    }
    const elapsedSec = Math.max(1, Math.round((Date.now() - loopStartedAt) / 1000));
    const who = persona.id === DEFAULT_PERSONA_ID ? '🤖 Agent' : formatPersonaBadge(persona);
    // 首步把路由依据亮出来（如「· 命中：502、排查」），后续步骤保持简短
    const whyPart = (step === 0 && !isResume && routeWhy) ? ' · ' + routeWhy : '';
    const stepLabel = who + ' 思考中' + (isResume ? '（继续）' : '')
      + '（第 ' + (step + 1) + '/' + maxSteps + ' 步' + whyPart + ' · ' + elapsedSec + 's）…';
    fireProgress(stepLabel, false);
    try { tgApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}); } catch (e) {}

    const sendMessages = trimAgentMessages(messages, loopStartIdx, ctxBudget);
    const stepHint = buildStepHint(step, maxSteps);
    if (stepHint) sendMessages.push({ role: 'user', content: stepHint });
    stats.steps = step + 1;
    if (debugStats) {
      let cc = 0;
      for (const m of sendMessages) cc += typeof m.content === 'string' ? m.content.length : 256;
      stats.ctxChars = cc;
      stats.ctxMsgs = sendMessages.length;
    }
    const cfg = buildAIRequest(env, targetModelId, sendMessages, useUpstreamStream, tools);
    if (cfg.error) return { error: cfg.error };

    const keyPool = Array.isArray(cfg.channelKeys) && cfg.channelKeys.length > 0 ? cfg.channelKeys : [cfg.currentApiKey];
    // v7.9.0：上游偶发返回空响应（流式场景尤其常见，SSE 只发了一个 [DONE]）。
    // 旧版直接判定"AI 没有返回有效内容"把整轮判死，用户只能重新提问。
    // 现在只要还有充裕时间就原地重试一次，不消耗推理步数。
    let msg = null;
    let emptyRounds = 0;
    while (true) {
      let resp = null;
      let lastFetchErr = null;
      const maxAttempts = (Date.now() < deadline - 12000) ? 2 : 1;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const activeKey = attempt === 0
          ? cfg.currentApiKey
          : keyPool[(keyPool.indexOf(cfg.currentApiKey) + attempt) % keyPool.length];
        try {
          const remainMs = Math.max(0, deadline - Date.now());
          // 贴合 deadline：旧版下限写死 15 秒，剩余预算只有 5 秒时仍会等满 15 秒，
          // 收尾时间被吃光，用户只能看到"超时且无结果"
          const fetchTimeoutMs = Math.max(3000, Math.min(180000, remainMs - 300));
          resp = await fetch(cfg.apiUrl, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + activeKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(cfg.payload),
            signal: AbortSignal.timeout(fetchTimeoutMs)
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
          const emsg = String((e && e.message) || '');
          const aborted = nm === 'AbortError' || nm === 'TimeoutError' || /abort/i.test(emsg);
          if (aborted) break;
          if (attempt + 1 < maxAttempts && Date.now() < deadline - 10000) {
            await new Promise(r => setTimeout(r, 800));
            continue;
          }
        }
      }

      if (lastFetchErr) {
        const nm = lastFetchErr && lastFetchErr.name ? String(lastFetchErr.name) : '';
        const emsg = String((lastFetchErr && lastFetchErr.message) || '');
        const aborted = nm === 'AbortError' || nm === 'TimeoutError' || /abort/i.test(emsg);
        if (aborted && Date.now() >= deadline - 2000) return await pauseForResume();
        if (aborted) return { error: '上游响应超时，请重试或换个问法' };
        return { error: '网络错误：' + (emsg || String(lastFetchErr)) };
      }

      if (!resp.ok) {
        const t = await readErrorBody(resp, 2048);
        if (allowTools && step === 0 &&
            ((resp.status >= 400 && resp.status < 500 && resp.status !== 401 && resp.status !== 429) || /tool|function|unsupported|vision|image/i.test(t))) {
          return { fallback: true };
        }
        return { error: 'API 报错 (' + resp.status + ')：' + String(t).slice(0, 500) };
      }

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
      if (msg.content || msg.toolCalls.length || msg.reasoning) break;

      // 空响应：给上游一次重来的机会（抖动很常见，没必要让用户重发问题）
      emptyRounds += 1;
      if (emptyRounds >= 2 || Date.now() > deadline - 20000) break;
      fireProgress(stepLabel + '\n（上游返回空响应，正在重试…）', true);
      await new Promise(r => setTimeout(r, 350));
    }

    if (!msg.content && !msg.toolCalls.length && !msg.reasoning) {
      return {
        error: emptyRounds > 1
          ? 'AI 连续两次没有返回有效内容。请换个问法，或用 /model 切换模型后重试。'
          : 'AI 没有返回有效内容，请重试。'
      };
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

    // 调用签名只算一次：熔断用的排序串与工具执行时的去重键共用，
    // 旧版每步把同一批 tool_calls 解析并 stringify 两遍
    const callSigs = toolCalls.map(toolCallSignature);
    const stepSig = callSigs.slice().sort().join(';;');
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

    // 给 tool_calls 补上稳定 id：个别上游（以及被截断的流式分片）会漏掉 id，
    // 此时 tool 消息的 tool_call_id 就是 undefined，严格校验的上游会直接 400。
    // 注意这里只补 id，不动 arguments —— 原始串要留给执行阶段判断"参数是否损坏"，
    // 提前规范化会把损坏信息抹掉，工具就会拿着 {} 白跑一次。
    if (toolCalls.length) {
      toolCalls = toolCalls.map((tc, i) => {
        const fn = (tc && tc.function) || {};
        return {
          id: (tc && tc.id) ? String(tc.id) : ('call_s' + step + '_' + i),
          type: 'function',
          function: { name: fn.name || '', arguments: fn.arguments }
        };
      });
    }
    const assistantMsg = { role: 'assistant', content: assistantText };
    if (toolCalls.length) {
      // 回灌给上游的 assistant.tool_calls 必须是合法 JSON：原始串可能被 max_tokens
      // 截断，严格校验的上游会直接 400。统一换成修复后的参数（修不好就是 {}），
      // 真正的失败原因由随后的 tool 消息告诉模型。
      assistantMsg.tool_calls = toolCalls.map((tc) => {
        const fn = tc.function || {};
        const parsed = parseToolArguments(fn.arguments);
        return { id: tc.id, type: 'function', function: { name: fn.name, arguments: JSON.stringify(parsed.args || {}) } };
      });
    }
    // v7.8.0：思维链默认不回灌上下文。
    // 推理模型一步可能产出几千字 reasoning，逐轮累积后既挤爆上下文预算（触发全量压缩、
    // 前缀缓存失效），也违背主流上游的约定（DeepSeek 明确不建议把 reasoning_content 作为输入）。
    // 少数确实要求回传思维链的上游可用 AGENT_KEEP_REASONING=1 打开。
    const reasoning = msg.reasoning || '';
    if (reasoning && keepReasoning) assistantMsg.reasoning_content = reasoning;
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
    // 单步工具输出按预算分摊，避免一步顶满上下文导致下一步被迫全量压缩
    const perToolCap = toolResultCap(ctxBudget, toolCalls.length);

    const toolResults = await mapLimit(toolCalls, limits.toolConcurrency, async (tc, tcIdx) => {
      const fn = (tc && tc.function) || {};
      if (!fn.name) return { tc, result: '工具调用缺少名称，已跳过', failed: true, ms: 0 };
      // 白名单是双向的：既决定 schema 发什么，也拦住模型凭记忆硬编出来的越界调用。
      // 否则写作角色仍可能调用 net_lookup 之类不在上下文里的工具，白烧一次外部请求。
      if (!personaAllowsTool(persona, fn.name)) {
        return {
          tc,
          result: '工具 ' + fn.name + ' 不适用于当前专家角色（' + persona.emoji + ' ' + persona.name + '）。'
            + '请改用当前可用工具，或直接基于已有信息作答。',
          failed: true,
          ms: 0
        };
      }
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
      const sig = callSigs[tcIdx];
      const isReadOnlyTool = !WRITE_TOOLS_SET.has(fn.name);
      const isMemoizable = isReadOnlyTool && !NO_MEMO_TOOLS.has(fn.name);
      // 同轮记忆化短路：本轮前面步骤已经成功调用过一模一样的只读工具，0ms 返回提示，不再重复请求或撑大上下文
      if (isMemoizable && turnToolMemo.has(sig)) {
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
      const result = await execAgentTool(fn.name, args, env, chatId, kbReadOnly,
        { timeoutMs: toolTimeoutCap, maxChars: Math.max(600, perToolCap - 160) });
      const ms = Math.max(1, Date.now() - t0);
      const failed = isToolFailureResult(result);
      let truncated = truncateToolResult(result, perToolCap);
      // 同一个工具本轮第一次失败时附一条确定性替代路径：模型看到「搜索失败」往往换个词原地再撞，
      // 给一句「改用 wiki/github 直查」能把一次失败变成一次转向。只加一次，不撑上下文。
      if (failed && !hintedTools.has(fn.name)) {
        const hint = failureRecoveryHint(fn.name);
        if (hint) {
          hintedTools.add(fn.name);
          truncated = truncated + '\n\n' + hint;
        }
      }
      if (isMemoizable && !failed) {
        turnToolMemo.set(sig, {
          step: step + 1,
          preview: String(truncated).replace(/\s+/g, ' ').slice(0, 160)
        });
      }
      return { tc, result: truncated, failed, ms };
    });

    let stepFailed = 0;
    stats.tools += toolResults.length;
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
    stats.fails += stepFailed;
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
    emitStats();
  }

  const wrapUp = await agentWrapUp(env, targetModelId, messages, loopStartIdx, ctxBudget, deadline, onDelta, wrapReserveMs);
  if (wrapUp && wrapUp.text) return { text: wrapUp.text, usedTools: true, streamed: !!wrapUp.streamed };
  const t = stripDSMLBlocks(lastAssistantText());
  const tail = t ? '\n\n已产出：\n' + t : (toolDigest(4) ? '\n\n' + toolDigest(4) : '');
  if (await persistState()) {
    return { text: '⏸️ 推理步数已用尽，进度已保存，发送「继续」让我接着做。' + tail, usedTools: true, paused: true };
  }
  return { text: (t || '（思考步数已用尽，请换个问法重试）') + (t ? '' : tail), usedTools: true };
}

export {
  isToolResultFailure,
  extractMsgPlainText,
  tgAgentDeadline,
  tgAgentChat,
  tgAgentResume,
  tgAgentRunLoop,
};
