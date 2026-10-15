// Telegram Webhook：命令、模型选择、Agent 对话与回复发送（_worker.js 原第 2053-2443 行）

import { APP_VERSION } from '../constants.js';
import { mapSetBounded, mapGetBounded, parseCommaSeparated, safeEqual } from '../utils.js';
import { storeGet, storePut, storePutChecked } from '../store/r2.js';
import { getChannelConfig, buildAIRequest } from '../channel.js';
import { tgTrimHistory, tgGetHistory, tgSaveHistory, tgClearHistory } from '../tg-history.js';
import { agentGetMemories, agentForgetMemory } from '../agent/memory.js';
import { agentGetMode, agentSetMode } from '../agent/mode.js';
import { agentLoadResumeState, agentClearResumeState, tgAgentResumeKey } from '../agent/resume.js';
import { tgAgentChat, tgAgentResume } from '../agent/loop.js';
import { readErrorBody } from '../agent/stability.js';
import { toolListDocs } from '../kb/doc-tools.js';

// 全局内存缓存（L1 缓存，带 60s TTL）
const tgUserModels = new Map();
const tgUserModelsExp = new Map();
// update_id 去重缓存（L1 内存）：
// key 为 Telegram update_id，value 为首次见到时间戳；去重窗口 10 分钟。
const seenUpdateIds = new Map();
// v6.8.1：TG_WEBHOOK_SECRET 缺失告警，每个 isolate 只打一次
let warnedNoWebhookSecret = false;

// ================= update_id 去重（v6.8.9：L1 内存 + L2 R2 滚动窗口） =================
const TG_DEDUP_KEY = 'tg_updates_dedup';
const TG_DEDUP_WINDOW_MS = 10 * 60 * 1000;
const TG_DEDUP_MAX = 200;
async function loadDedupWindow(env) {
  try {
    const raw = await storeGet(env, TG_DEDUP_KEY);
    if (raw) { const p = JSON.parse(raw); if (Array.isArray(p)) return p; }
  } catch (e) {}
  return [];
}
// 返回 true 表示该 update 已在窗口内（重复投递），应直接忽略
async function markUpdateSeen(env, uid) {
  if (uid === undefined || uid === null) return false;
  const now = Date.now();
  if (seenUpdateIds.has(uid)) return true;
  const win = await loadDedupWindow(env);
  const fresh = win.filter(e => e && e.id !== undefined && e.id !== null && now - (e.ts || 0) < TG_DEDUP_WINDOW_MS);
  if (fresh.some(e => e.id === uid)) {
    seenUpdateIds.set(uid, now);
    return true;
  }
  fresh.push({ id: uid, ts: now });
  if (fresh.length > TG_DEDUP_MAX) fresh.splice(0, fresh.length - TG_DEDUP_MAX);
  try { await storePutChecked(env, TG_DEDUP_KEY, JSON.stringify(fresh)); } catch (e) {}
  seenUpdateIds.set(uid, now);
  // 顺手清理内存里的过期条目，防止 Map 无限增长
  for (const [k, t] of seenUpdateIds) { if (now - t > TG_DEDUP_WINDOW_MS) seenUpdateIds.delete(k); }
  return false;
}
// v6.8.7：处理异常时释放去重标记 —— Telegram 因超时重发该 update 时还能重试
async function releaseUpdateForRetry(env, uid) {
  if (uid === undefined || uid === null) return;
  seenUpdateIds.delete(uid);
  try {
    const win = await loadDedupWindow(env);
    const fresh = win.filter(e => !(e && e.id === uid));
    if (fresh.length !== win.length) await storePutChecked(env, TG_DEDUP_KEY, JSON.stringify(fresh));
  } catch (e) {}
}

// 命令解析（v6.8.6）：兼容群组里的 /cmd@botname 写法与命令后带参数。
// 返回 { cmd, rest }，非命令文本返回 null。
function parseCommand(t) {
  const m = /^(\/[a-zA-Z]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(String(t || '').trim());
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), rest: (m[2] || '').trim() };
}

// v6.9.5：长消息按 3980 字符切分，若切分点位于未闭合的 ``` 代码块内，
// 自动在当前分片末尾补 ``` 并在下一分片开头重开代码块，避免 Telegram Markdown 报 400 降级为纯文本。
function splitTelegramMarkdown(text, maxLength = 3980) {
  const chunks = [];
  let remaining = String(text || '');
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let sliceLength = maxLength;
    const lastNewline = remaining.lastIndexOf('\n', maxLength);
    if (lastNewline > 3000) {
      sliceLength = lastNewline;
    }
    let chunk = remaining.slice(0, sliceLength);
    remaining = remaining.slice(sliceLength);
    const fences = chunk.match(/```[^\n]*/g);
    if (fences && fences.length % 2 === 1) {
      const lastFence = fences[fences.length - 1];
      const lang = lastFence.slice(3).trim();
      chunk += '\n```';
      remaining = '```' + (lang ? lang : '') + '\n' + remaining.replace(/^\n/, '');
    }
    chunks.push(chunk);
  }
  return chunks;
}

export async function handleTgWebhook(request, env) {
  // Webhook 来源校验：配置 TG_WEBHOOK_SECRET 后，只接受携带正确
  // X-Telegram-Bot-Api-Secret-Token 请求头的调用（setWebhook 时传入 secret_token）。
  if (env.TG_WEBHOOK_SECRET) {
    const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
    if (!safeEqual(got, env.TG_WEBHOOK_SECRET)) {
      return new Response('Forbidden', { status: 403 });
    }
  } else if (env.TG_BOT_TOKEN && !warnedNoWebhookSecret) {
    warnedNoWebhookSecret = true;
    console.log('⚠️ [cloudflare-chat] 未配置 TG_WEBHOOK_SECRET，/tg-webhook 处于开放状态；强烈建议配置 secret_token 并用 setWebhook 重新绑定，同时可配 TG_ALLOWED_CHAT_IDS 白名单只允许自己的聊天。');
  }

  try {
    const update = await request.json();
    if (!env.TG_BOT_TOKEN) return new Response('OK', { status: 200 });

    let tgApiTimeoutMs = parseInt(env.TG_API_TIMEOUT_MS || '15000', 10);
    if (!(tgApiTimeoutMs > 0)) tgApiTimeoutMs = 15000;
    const tgApi = (method, body) => fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(tgApiTimeoutMs)
    });

    async function processTelegramUpdate(env, update, tgApi) {
      let pendingCleanup = null;
      try {
        const { models: modelObjList } = getChannelConfig(env);
        if (modelObjList.length === 0) return;

        const allowedChatIds = parseCommaSeparated(env.TG_ALLOWED_CHAT_IDS);
        const isChatAllowed = (cid) => !allowedChatIds.length || allowedChatIds.indexOf(String(cid)) !== -1;

        if (update.callback_query) {
          const cb = update.callback_query;
          const chatId = cb.message && cb.message.chat ? cb.message.chat.id : undefined;
          if (chatId === undefined || !isChatAllowed(chatId)) {
            try { await tgApi('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {}); } catch (e) {}
            return;
          }
          const data = cb.data;

          if (data.startsWith('M:')) {
            const index = parseInt(data.substring(2), 10);
            if (modelObjList[index]) {
              const selected = modelObjList[index];
              mapSetBounded(tgUserModels, chatId, selected.id, undefined, tgUserModelsExp);
              await storePut(env, `tg_user_${chatId}`, selected.id);

              // v6.9.5：清理模型显示名中的反引号，防止破坏 Markdown 代码段导致 400 静默失败
              const safeModelName = String(selected.name || selected.id).replace(/`/g, "'");
              await tgApi('sendMessage', {
                chat_id: chatId,
                text: `✅ **已切换模型为:** \n\`${safeModelName}\``,
                parse_mode: "Markdown"
              }).catch(() => {});
            }
          }

          await tgApi('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
          return;
        }

        if (update.message && update.message.text) {
          const chatId = update.message.chat.id;
          if (!isChatAllowed(chatId)) return; // 不在白名单：静默忽略
          const userText = update.message.text;

          const cmd = parseCommand(userText);
          if (cmd && (cmd.cmd === '/start' || cmd.cmd === '/model')) {
            const inline_keyboard = modelObjList.map((model, index) => {
              return [{ text: model.name, callback_data: `M:${index}` }];
            });

            await tgApi('sendMessage', {
              chat_id: chatId,
              text: "⚙️ **请选择对话要使用的 AI 模型:**\n\n_支持多轮对话（最近 " + (parseInt(env.TG_HISTORY_ROUNDS || '10', 10) || 10) + " 轮），发送 /clear 可清空上下文。_\n\n🤖 **Agent 模式**（默认开启）：我会自主规划、调用工具（🔍 联网搜索、📄 网页读取、🧮 精确计算、🌤 天气、🕐 时间），并用 🧠 长期记住你告诉我的事、用 💾📚 存取知识库文档。发送 /agent 可切换为普通对话模式，/help 查看全部命令。",
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard }
            });
            return;
          }

          if (cmd && (cmd.cmd === '/clear' || cmd.cmd === '/new')) {
            await tgClearHistory(env, chatId);
            await agentClearResumeState(env, chatId);
            await tgApi('sendMessage', { chat_id: chatId, text: "🧹 上下文已清空，可以开始新的话题了。" });
            return;
          }

          if (cmd && cmd.cmd === '/help') {
            await tgApi('sendMessage', {
              chat_id: chatId,
              text: "🤖 命令列表：\n\n"
                + "/start、/model —— 选择对话模型\n"
                + "/agent —— 切换 Agent / 普通对话模式\n"
                + "/clear —— 清空当前对话上下文\n"
                + "/memory —— 查看长期记忆\n"
                + "/forget 关键词 —— 删除包含关键词的记忆\n"
                + "/kb —— 知识库总览（文档列表 + 记忆统计）\n"
                + "任务太长被暂停时，发送「继续」可接着做\n\n"
                + "Agent 模式下我会自主规划、调用工具（🔍 搜索、📄 网页、🧮 计算、🌤 天气、🕐 时间），长期记住你告诉我的事，还能用 💾 保存、📚 查阅知识库文档（比如：把这篇文章存成知识库文档；问知识库里的问题我会优先查文档）。"
                + "\n\n📌 当前版本 v" + APP_VERSION + "（R2 持久化 · 长期记忆无上限）"
            });
            return;
          }

          if (cmd && cmd.cmd === '/memory') {
            const mems = await agentGetMemories(env, chatId);
            if (!mems.length) {
              await tgApi('sendMessage', { chat_id: chatId, text: "🧠 暂无长期记忆。\n\n对我说「记住xxx」即可保存，比如：记住，我养了一只猫叫汤圆" });
            } else {
              let text = '🧠 长期记忆（共' + mems.length + '条）：\n';
              mems.forEach((mm, i) => { text += (i + 1) + '. ' + mm.fact + '\n'; });
              text += '\n用 /forget 关键词 删除记忆。';
              for (let s = 0; s < text.length; s += 4000) {
                await tgApi('sendMessage', { chat_id: chatId, text: text.slice(s, s + 4000) });
              }
            }
            return;
          }

          if (cmd && cmd.cmd === '/kb') {
            const mems = await agentGetMemories(env, chatId);
            let text = '📚 知识库总览\n\n';
            text += '🧠 长期记忆：共' + mems.length + '条（/memory 查看，/forget 关键词 删除）\n\n';
            text += await toolListDocs(env);
            text += '\n\n💾 保存文档：对我说"把…存成知识库文档"；🗑️ 删文档：说"删除知识库文档《标题》"';
            for (let s = 0; s < text.length; s += 4000) {
              await tgApi('sendMessage', { chat_id: chatId, text: text.slice(s, s + 4000) });
            }
            return;
          }

          if (cmd && cmd.cmd === '/forget') {
            const kw = cmd.rest;
            if (!kw) {
              await tgApi('sendMessage', { chat_id: chatId, text: "用法：/forget 关键词\n例如：/forget 猫 —— 删除所有包含「猫」的记忆" });
            } else {
              const rr = await agentForgetMemory(env, chatId, kw);
              await tgApi('sendMessage', {
                chat_id: chatId,
                text: rr.persistError ? '⚠️ ' + rr.persistError : (rr.removed > 0 ? '🗑 已删除 ' + rr.removed + ' 条包含「' + kw + '」的记忆。' : '没有找到包含「' + kw + '」的记忆。')
              });
            }
            return;
          }

          if (cmd && cmd.cmd === '/agent') {
            const cur = await agentGetMode(env, chatId);
            await agentSetMode(env, chatId, !cur);
            await tgApi('sendMessage', {
              chat_id: chatId,
              text: !cur
                ? "🤖 **Agent 模式已开启**\n\n我会自主规划、调用工具（🔍 联网搜索、📄 网页读取、🧮 精确计算、🌤 天气、🕐 时间），长期记住你告诉我的重要信息，还能用 💾 保存、📚 查阅知识库文档。"
                : "💬 **已切换为普通对话模式**\n\n单轮问答，不调用工具、不使用长期记忆。如需 Agent 能力再发送 /agent 切回。",
              parse_mode: "Markdown"
            });
            return;
          }

          let targetModelId = mapGetBounded(tgUserModels, chatId, env && env.R2 ? tgUserModelsExp : null);
          if (!targetModelId) {
            targetModelId = await storeGet(env, `tg_user_${chatId}`);
            if (targetModelId) mapSetBounded(tgUserModels, chatId, targetModelId, undefined, tgUserModelsExp);
          }

          const useAgent = await agentGetMode(env, chatId);
          // v6.9.5：先检查是否为「继续」断点续做；若是续做，不把"继续"当作新问题塞入对话历史
          const wantResume = useAgent && userText.trim() === '继续';
          let resumeState = null;
          if (wantResume) resumeState = await agentLoadResumeState(env, chatId);
          if (useAgent && !resumeState) await agentClearResumeState(env, chatId);

          const baseHistory = await tgGetHistory(env, chatId);
          let history = baseHistory.slice();
          if (!resumeState) {
            history.push({ role: "user", content: userText });
            history = tgTrimHistory(history, env);
          }

          const sendActionPromise = tgApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
          const pendingMsgPromise = tgApi('sendMessage', {
            chat_id: chatId,
            text: "⏳ _正在思考并生成内容，请稍候..._",
            parse_mode: "Markdown"
          }).then(async res => {
            if (res.ok) {
              const data = await res.json();
              return data.result?.message_id;
            }
            return null;
          }).catch(() => null);

          const [, pendingMsgId] = await Promise.all([sendActionPromise, pendingMsgPromise]);
          pendingCleanup = async (err) => {
            if (pendingMsgId) tgApi('deleteMessage', { chat_id: chatId, message_id: pendingMsgId }).catch(() => {});
            tgApi('sendMessage', { chat_id: chatId, text: '⚠️ 处理消息时出错：' + (err && err.message ? err.message : String(err)) }).catch(() => {});
          };

          // ===== Agent 主流程：自主规划 → 工具调用 → 汇总作答 =====
          let replyText = null;
          let agentErr = null;

          let webhookBudgetMs = parseInt(env.TG_WEBHOOK_BUDGET_MS || '55000', 10);
          if (!(webhookBudgetMs >= 10000)) webhookBudgetMs = 55000;
          if (webhookBudgetMs > 240000) webhookBudgetMs = 240000;
          const agentOpts = { maxRuntimeMs: webhookBudgetMs, resumeKey: tgAgentResumeKey(chatId), origUserText: userText };

          if (useAgent) {
            let lastProgressEdit = 0;
            const onProgress = async (text, force) => {
              if (!pendingMsgId) return;
              const now = Date.now();
              if (!force && now - lastProgressEdit < 1500) return;
              lastProgressEdit = now;
              try {
                await tgApi('editMessageText', { chat_id: chatId, message_id: pendingMsgId, text: String(text).slice(0, 4000) });
              } catch (e) {}
            };
            const runAgentTurn = (allowTools) => {
              if (resumeState) {
                return tgAgentResume(env, tgApi, chatId, {
                  targetModelId: resumeState.targetModelId || targetModelId,
                  allowTools: allowTools,
                  messages: resumeState.messages,
                  loopStartIdx: resumeState.loopStartIdx,
                  origUserText: resumeState.origUserText || ''
                }, onProgress, agentOpts);
              }
              return tgAgentChat(env, tgApi, chatId, targetModelId, history, allowTools, onProgress, agentOpts);
            };
            let r;
            try {
              r = await runAgentTurn(true);
              if (r.fallback) r = await runAgentTurn(false);
            } catch (e) {
              r = { error: '⚠️ Agent 执行出错：' + (e && e.message ? e.message : String(e)) };
            }
            if (r.error) {
              agentErr = r.error;
            } else {
              replyText = r.text;
              // v6.9.5：仅在任务彻底完成（!r.paused）时将问答成对记入历史，
              // 避免多段「继续」与半截暂停提示语污染 tg_hist_<chatId> 上下文。
              if (!r.paused) {
                if (!r.isImage && replyText) {
                  let finalHist = history;
                  if (resumeState) {
                    finalHist = baseHistory.slice();
                    if (resumeState.origUserText) {
                      finalHist.push({ role: "user", content: resumeState.origUserText });
                    }
                  }
                  finalHist.push({ role: "assistant", content: replyText });
                  finalHist = tgTrimHistory(finalHist, env);
                  await tgSaveHistory(env, chatId, finalHist);
                }
                await agentClearResumeState(env, chatId);
              }
            }
          } else {
            // 普通模式：单次问答（与旧版行为一致，不调用工具）
            const aiConfig = buildAIRequest(env, targetModelId, history, false);
            if (aiConfig.error) {
              if (pendingMsgId) {
                tgApi('deleteMessage', { chat_id: chatId, message_id: pendingMsgId }).catch(() => {});
              }
              await tgApi('sendMessage', { chat_id: chatId, text: '⚠️ ' + aiConfig.error });
              return;
            }
            const { apiUrl, currentApiKey, payload } = aiConfig;
            let aiResponse = null;
            for (let tgAttempt = 1; tgAttempt <= 2; tgAttempt++) {
              try {
                aiResponse = await fetch(apiUrl, {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${currentApiKey}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify(payload),
                  signal: AbortSignal.timeout(60000)
                });
                break;
              } catch (e) {
                aiResponse = null;
                if (tgAttempt >= 2) { agentErr = '上游接口请求失败，请稍后再试。'; break; }
                await new Promise(function (r) { setTimeout(r, 1500); });
              }
            }
            if (!agentErr) {
              if (aiResponse && aiResponse.ok) {
                const aiData = await aiResponse.json();
                if (aiData.choices && aiData.choices[0]?.message) {
                  replyText = aiData.choices[0].message.content;
                } else if (aiData.data && aiData.data[0]?.url) {
                  replyText = `[🖼️ 点击查看生成的图片](${aiData.data[0].url})`;
                } else {
                  replyText = "AI 没有返回有效内容。";
                }
                if (aiData.choices && aiData.choices[0]?.message && replyText) {
                  history.push({ role: "assistant", content: replyText });
                  history = tgTrimHistory(history, env);
                  await tgSaveHistory(env, chatId, history);
                }
              } else {
                let diag = '';
                if (aiResponse) {
                  try {
                    diag = '（HTTP ' + aiResponse.status + (aiResponse.statusText ? ' ' + aiResponse.statusText : '')
                      + '：' + await readErrorBody(aiResponse, 300) + '）';
                  } catch (e) {}
                }
                agentErr = "⚠️ AI 接口请求失败，请稍后再试。" + diag;
              }
            }
          }

          if (pendingMsgId) {
            await tgApi('deleteMessage', { chat_id: chatId, message_id: pendingMsgId }).catch(() => {});
          }

          if (agentErr) {
            await tgApi('sendMessage', { chat_id: chatId, text: agentErr });
            return;
          }

          if (replyText) {
            const sendReplyChunk = async (text, useMarkdown) => {
              for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                  const r = await tgApi('sendMessage', useMarkdown
                    ? { chat_id: chatId, text, parse_mode: "Markdown" }
                    : { chat_id: chatId, text });
                  if (r.ok || attempt === 2) return r;
                } catch (e) {
                  if (attempt === 2) return { ok: false };
                }
                await new Promise(function (rr) { setTimeout(rr, 800); });
              }
              return { ok: false };
            };
            const chunks = splitTelegramMarkdown(replyText, 3980);
            for (const chunk of chunks) {
              const tgRes = await sendReplyChunk(chunk, true);
              if (!tgRes.ok) {
                await sendReplyChunk(chunk, false);
              }
            }
          }
        }
      } catch (err) {
        console.log("后台处理异常:", err);
        if (pendingCleanup) { try { await pendingCleanup(err); } catch (e) {} }
        throw err;
      }
    }

    const uid = update && update.update_id;
    if (uid !== undefined && uid !== null && await markUpdateSeen(env, uid)) {
      return new Response('OK', { status: 200 });
    }

    try {
      await processTelegramUpdate(env, update, tgApi);
    } catch (err) {
      await releaseUpdateForRetry(env, uid);
      console.log("处理 Telegram 更新异常:", err);
    }

    return new Response('OK', { status: 200 });
  } catch (error) {
    return new Response('Error', { status: 500 });
  }
}

// 供单元测试使用（纯函数与去重窗口逻辑）
export {
  parseCommand,
  splitTelegramMarkdown,
  markUpdateSeen,
  releaseUpdateForRetry,
};
