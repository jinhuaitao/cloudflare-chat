// Telegram Webhook：命令、模型选择、Agent 对话与回复发送（_worker.js 原第 2053-2443 行）

import { APP_VERSION } from '../constants.js';
import { mapSetBounded, parseCommaSeparated, safeEqual } from '../utils.js';
import { storeGet, storePut } from '../store/r2.js';
import { getChannelConfig, buildAIRequest } from '../channel.js';
import { tgTrimHistory, tgGetHistory, tgSaveHistory, tgClearHistory } from '../tg-history.js';
import { agentGetMemories, agentForgetMemory } from '../agent/memory.js';
import { agentGetMode, agentSetMode } from '../agent/mode.js';
import { agentLoadResumeState, agentClearResumeState, tgAgentResumeKey } from '../agent/resume.js';
import { tgAgentChat, tgAgentResume } from '../agent/loop.js';
import { toolListDocs } from '../kb/doc-tools.js';

// 全局内存缓存（L1 缓存）
const tgUserModels = new Map();
// update_id 去重缓存（v6.6.3 起改用内存，不再写 R2）：
// key 为 Telegram update_id，value 为首次见到时间戳；
// 去重窗口 10 分钟，每次 webhook 顺手清理过期条目，Map 不会无限增长。
const seenUpdateIds = new Map();
// v6.8.1：TG_WEBHOOK_SECRET 缺失告警，每个 isolate 只打一次
let warnedNoWebhookSecret = false;

export async function handleTgWebhook(request, env) {
  // Webhook 来源校验：配置 TG_WEBHOOK_SECRET 后，只接受携带正确
  // X-Telegram-Bot-Api-Secret-Token 请求头的调用（setWebhook 时传入 secret_token）。
  // 未配置时保持开放（兼容旧部署），但强烈建议配置。
  if (env.TG_WEBHOOK_SECRET) {
    const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
    if (!safeEqual(got, env.TG_WEBHOOK_SECRET)) {
      return new Response('Forbidden', { status: 403 });
    }
  } else if (env.TG_BOT_TOKEN && !warnedNoWebhookSecret) {
    // v6.8.1：未配置 TG_WEBHOOK_SECRET 时 /tg-webhook 完全开放，任何人可伪造 update
    // 烧你的 API 配额、污染知识库；这里打一次日志提醒（wrangler tail 可见）
    warnedNoWebhookSecret = true;
    console.log('⚠️ [cloudflare-chat] 未配置 TG_WEBHOOK_SECRET，/tg-webhook 处于开放状态；强烈建议配置 secret_token 并用 setWebhook 重新绑定，同时可配 TG_ALLOWED_CHAT_IDS 白名单只允许自己的聊天。');
  }

  try {
    const update = await request.json();
    if (!env.TG_BOT_TOKEN) return new Response('OK', { status: 200 });

    // Telegram Bot API 单次调用超时（默认 15 秒，可用 TG_API_TIMEOUT_MS 调整）：
    // 之前是裸 fetch 无超时，api.telegram.org 偶发 hung 住会让进度消息永远停在"思考中"
    let tgApiTimeoutMs = parseInt(env.TG_API_TIMEOUT_MS || '15000', 10);
    if (!(tgApiTimeoutMs > 0)) tgApiTimeoutMs = 15000;
    const tgApi = (method, body) => fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(tgApiTimeoutMs)
    });

    // v6.4.3 根因修复：之前收到 webhook 立刻返回 OK、把全部工作丢进 ctx.waitUntil ——
    // 但 HTTP 响应结束后 waitUntil 最多再延续约 30 秒，超过 30 秒的 Agent 任务会被
    // 静默掐断（pending 消息永远卡在"📄 正在读取网页…"，且无任何错误）。
    // 现在改为在请求上下文内等待处理完成再返回 OK。
    async function processTelegramUpdate(env, update, tgApi) {
      try {
        const { models: modelObjList } = getChannelConfig(env);
        if (modelObjList.length === 0) return;

        // v6.8.1 聊天白名单（可选）：配置 TG_ALLOWED_CHAT_IDS（逗号分隔的数字 ID）后，
        // 只响应名单内的聊天，其他一律静默忽略（仍返回 OK，避免 Telegram 反复重发）。
        // 不配置则保持原有开放行为。个人自用强烈建议配置，只填自己的 chat id。
        const allowedChatIds = parseCommaSeparated(env.TG_ALLOWED_CHAT_IDS);
        const isChatAllowed = (cid) => !allowedChatIds.length || allowedChatIds.indexOf(String(cid)) !== -1;

        if (update.callback_query) {
          const cb = update.callback_query;
          // inline 模式的回调没有 message，直接回包消掉 loading 状态后忽略
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
              mapSetBounded(tgUserModels, chatId, selected.id);
              await storePut(env, `tg_user_${chatId}`, selected.id);

              await tgApi('sendMessage', {
                chat_id: chatId,
                text: `✅ **已切换模型为:** \n\`${selected.name}\``,
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

          // v6.8.1：精确匹配命令，避免 /startfoo 之类被误判；
          // 兼容群组里的 /start@botname 写法
          const isCmd = (t, cmd) => t === cmd || t.startsWith(cmd + ' ') || t.startsWith(cmd + '@');
          if (isCmd(userText, '/start') || isCmd(userText, '/model')) {
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

          if (userText === '/clear' || userText === '/new') {
            await tgClearHistory(env, chatId);
            await agentClearResumeState(env, chatId);
            await tgApi('sendMessage', { chat_id: chatId, text: "🧹 上下文已清空，可以开始新的话题了。" });
            return;
          }

          if (userText === '/help') {
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

          if (userText === '/memory') {
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

          if (userText === '/kb') {
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

          if (userText.startsWith('/forget')) {
            const kw = userText.slice(7).trim();
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

          if (userText === '/agent') {
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

          let targetModelId = tgUserModels.get(chatId);
          if (!targetModelId) {
            targetModelId = await storeGet(env, `tg_user_${chatId}`);
          }

          // 多轮对话：取出历史，拼上本轮用户消息（超限自动裁剪）
          let history = await tgGetHistory(env, chatId);
          history.push({ role: "user", content: userText });
          history = tgTrimHistory(history, env);

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

          // ===== Agent 主流程：自主规划 → 工具调用 → 汇总作答 =====
          const useAgent = await agentGetMode(env, chatId);
          let replyText = null;
          let agentErr = null;

          // webhook 单轮预算：Telegram 约 60 秒无响应会重发 update，
          // 55 秒内必须返回（可用 TG_WEBHOOK_BUDGET_MS 调整，10 秒 ~ 240 秒）。
          // 超预算的任务会暂停并保存进度，用户发「继续」即接着做。
          let webhookBudgetMs = parseInt(env.TG_WEBHOOK_BUDGET_MS || '55000', 10);
          if (!(webhookBudgetMs >= 10000)) webhookBudgetMs = 55000;
          if (webhookBudgetMs > 240000) webhookBudgetMs = 240000;
          const agentOpts = { maxRuntimeMs: webhookBudgetMs, resumeKey: tgAgentResumeKey(chatId) };

          if (useAgent) {
            // Agent 模式：ReAct 多步推理 + 工具调用（进度实时编辑到 pending 消息上）
            let lastProgressEdit = 0;
            const onProgress = async (text, force) => {
              if (!pendingMsgId) return;
              const now = Date.now();
              if (!force && now - lastProgressEdit < 1500) return; // Telegram 编辑限流，节流；工具进度用 force 突破
              lastProgressEdit = now;
              try {
                // 纯文本，不加 parse_mode，避免搜索词里的 Markdown 特殊字符导致编辑失败
                await tgApi('editMessageText', { chat_id: chatId, message_id: pendingMsgId, text: String(text).slice(0, 4000) });
              } catch (e) {}
            };
            // 「继续」：恢复上次暂停的任务；新问题则清掉旧暂停状态
            const wantResume = /^继续/.test(userText.trim());
            let resumeState = null;
            if (wantResume) resumeState = await agentLoadResumeState(env, chatId);
            if (!resumeState) await agentClearResumeState(env, chatId);
            const runAgentTurn = (allowTools) => {
              if (resumeState) {
                return tgAgentResume(env, tgApi, chatId, {
                  targetModelId: resumeState.targetModelId || targetModelId,
                  allowTools: allowTools,
                  messages: resumeState.messages
                }, onProgress, agentOpts);
              }
              return tgAgentChat(env, tgApi, chatId, targetModelId, history, allowTools, onProgress, agentOpts);
            };
            let r;
            try {
              r = await runAgentTurn(true);
              if (r.fallback) r = await runAgentTurn(false);
            } catch (e) {
              // 兜底：Agent 内部任何未预期异常都转为可见错误，绝不让用户面对卡死的"思考中"
              r = { error: '⚠️ Agent 执行出错：' + (e && e.message ? e.message : String(e)) };
            }
            if (r.error) {
              agentErr = r.error;
            } else {
              replyText = r.text;
              // 文本问答记入历史；图片生成不记（省空间）
              if (!r.isImage && replyText) {
                history.push({ role: "assistant", content: replyText });
                history = tgTrimHistory(history, env);
                await tgSaveHistory(env, chatId, history);
              }
              // 正常完成（非暂停）后清理断点；暂停时新状态已在内部保存
              if (!r.paused) await agentClearResumeState(env, chatId);
            }
          } else {
            // 普通模式：单次问答（与旧版行为一致，不调用工具）
            const aiConfig = buildAIRequest(env, targetModelId, history, false);
            if (aiConfig.error) {
              if (pendingMsgId) {
                tgApi('deleteMessage', { chat_id: chatId, message_id: pendingMsgId }).catch(() => {});
              }
              await tgApi('sendMessage', { chat_id: chatId, text: "⚠️ 此模型的 API 接口未配置或异常。" });
              return;
            }
            const { apiUrl, currentApiKey, payload } = aiConfig;
            // 上游偶发中断时重试一次（深度思考时间越长越容易撞上）
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
                  signal: AbortSignal.timeout(60000) // 普通对话上游单次调用上限 60 秒
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
                agentErr = "⚠️ AI 接口请求失败，请稍后再试。";
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
            // 最终回复发送：带一次重试。tgApi 有 15 秒超时，一次偶发 hung 不该直接丢掉用户回复
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
            const maxLength = 4000;
            let startIndex = 0;
            while (startIndex < replyText.length) {
              let sliceLength = maxLength;
              if (startIndex + maxLength < replyText.length) {
                const lastNewline = replyText.lastIndexOf('\n', startIndex + maxLength);
                if (lastNewline > startIndex + 3000) {
                   sliceLength = lastNewline - startIndex;
                }
              }

              const chunk = replyText.slice(startIndex, startIndex + sliceLength);
              startIndex += sliceLength;

              const tgRes = await sendReplyChunk(chunk, true);

              if (!tgRes.ok) {
                await sendReplyChunk(chunk, false);
              }
            }
          }
        }
      } catch (err) {
        console.log("后台处理异常:", err);
      }
    }

    // update_id 去重（v6.6.3 起改用内存，不再写 R2，避免 tg_update_* 无上限堆积）：
    // 同一 update 10 分钟内只处理一次。处理改为在请求内等待完成，
    // 响应变慢时 Telegram 可能重发 update，去重可避免重复执行 Agent / 重复发送回复。
    try {
      const uid = update && update.update_id;
      if (uid !== undefined && uid !== null) {
        const now = Date.now();
        // 顺手清理过期条目（>10 分钟），防止 Map 无限增长
        for (const [k, t] of seenUpdateIds) {
          if (now - t > 600000) seenUpdateIds.delete(k);
        }
        if (seenUpdateIds.has(uid)) return new Response('OK', { status: 200 });
        seenUpdateIds.set(uid, now);
      }
    } catch (e) {}

    try {
      await processTelegramUpdate(env, update, tgApi);
    } catch (err) {
      console.log("处理 Telegram 更新异常:", err);
    }

    return new Response('OK', { status: 200 });
  } catch (error) {
    return new Response('Error', { status: 500 });
  }
}
