// 在全局作用域声明一个 Map，用于在 Worker 实例存活期间记录 TG 用户的模型选择
const tgUserModels = new Map();

// ======= 统一解析通道配置（支持多组 API_URL, API_KEY, MODEL 映射） =======
function getChannelConfig(env) {
  let models = [];
  let modelMap = new Map();

  const addModels = (modelStr, url, keys) => {
    const arr = (modelStr || "").split(',').map(m => m.trim()).filter(m => m);
    arr.forEach(m => {
      let id = m.trim(), name = m.trim();
      const colonIdx = m.lastIndexOf(':');
      if (colonIdx > 0) {
        id = m.substring(0, colonIdx).trim();
        name = m.substring(colonIdx + 1).trim();
      }
      if (!modelMap.has(id)) {
        models.push({ id, name, original: m });
        modelMap.set(id, { url, keys });
      }
    });
  };

  // 1. 优先尝试 JSON 配置: API_CONFIG
  if (env.API_CONFIG) {
    try {
      const channels = JSON.parse(env.API_CONFIG);
      channels.forEach(ch => {
        const url = ch.url;
        const keys = Array.isArray(ch.keys) ? ch.keys : (ch.keys || "").split(',').map(k => k.trim()).filter(k => k);
        const modelStr = Array.isArray(ch.models) ? ch.models.join(',') : ch.models;
        if (url && modelStr) addModels(modelStr, url, keys);
      });
      if (models.length > 0) return { models, modelMap };
    } catch (e) {
      console.log("API_CONFIG 解析失败:", e);
    }
  }

  // 2. 尝试多组变量映射: API_URL_1, API_KEY_1, MODEL_1 ...
  let hasIndexed = false;
  for (let i = 1; i <= 20; i++) {
    if (env[`API_URL_${i}`] && env[`MODEL_${i}`]) {
      hasIndexed = true;
      const url = env[`API_URL_${i}`];
      const keys = (env[`API_KEY_${i}`] || "").split(',').map(k => k.trim()).filter(k => k);
      const modelStr = env[`MODEL_${i}`];
      addModels(modelStr, url, keys);
    }
  }
  if (hasIndexed && models.length > 0) return { models, modelMap };

  // 3. 回退到旧版单一环境变量
  const fallbackUrl = env.API_URL || "";
  const fallbackKeys = (env.API_KEY || "").split(',').map(k => k.trim()).filter(k => k);
  const fallbackModelStr = env.MODEL || "meta/llama3-70b-instruct:Llama 3 70B,deepseek-ai/DeepSeek-R1:深度思考 R1,agnes-video-v20:Agnes 视频生成";
  
  addModels(fallbackModelStr, fallbackUrl, fallbackKeys);

  return { models, modelMap };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ==========================================
    // 微信站长认证专用路由
    // ==========================================
    if (request.method === 'GET' && url.pathname === '/a9a015a0f6e7c9ca09f4cdce4479deb3.txt') {
      return new Response('b7aa7e3069358c2c18f7908a7d5815788bafd020', {
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    // ==========================================
    // Web UI 聊天接口
    // ==========================================
    if (request.method === 'POST' && url.pathname === '/api/chat') {
      try {
        let body;
        try {
          body = await request.json();
        } catch (e) {
          return new Response(JSON.stringify({ error: "无效的请求格式" }), { status: 400, headers: corsHeaders() });
        }

        const { models, modelMap } = getChannelConfig(env);
        const selectedModel = body.model || (models.length > 0 ? models[0].id : "");
        const channel = modelMap.get(selectedModel) || modelMap.values().next().value;

        if (!channel || !channel.url) {
          return new Response(JSON.stringify({ error: "该模型对应的 API_URL 未配置或异常" }), { status: 500, headers: corsHeaders() });
        }

        const currentApiKey = channel.keys.length > 0 ? channel.keys[Math.floor(Math.random() * channel.keys.length)] : "";
        const apiUrl = channel.url;

        // 智能识别多媒体接口
        const selectedModelLower = selectedModel.toLowerCase();
        const isImageAPI = apiUrl.includes('images/generations') || selectedModelLower.includes('image') || selectedModelLower.includes('dall-e');
        const isVideoAPI = apiUrl.includes('/videos') || selectedModelLower.includes('video');
        const isMediaAPI = isImageAPI || isVideoAPI;

        let payload = {};
        if (isMediaAPI) {
          const lastMessage = body.messages[body.messages.length - 1].content;
          payload = { model: selectedModel, prompt: lastMessage };
          if (isImageAPI) payload.n = 1;
        } else {
          payload = {
            model: selectedModel,
            messages: body.messages,
            stream: true,
            max_tokens: 4096, 
          };
        }

        const fetchResponse = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${currentApiKey}`, 
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        if (!fetchResponse.ok) {
          const errText = await fetchResponse.text();
          return new Response(JSON.stringify({ error: `API 报错 (${fetchResponse.status}): ${errText}` }), {
            status: fetchResponse.status,
            headers: corsHeaders(),
          });
        }

        // 分流处理结果，加入异步轮询
        if (!isMediaAPI) {
          // 普通文本，直接透传 SSE 流
          return new Response(fetchResponse.body, {
            headers: {
              'Content-Type': 'text/event-stream',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            },
          });
        } else {
          const responseData = await fetchResponse.json();
          const encoder = new TextEncoder();
          
          const stream = new ReadableStream({
            async start(controller) {
              let mediaResultText = "媒体内容生成失败或未返回有效格式";
              let mediaUrl = null;

              if (responseData.data && responseData.data[0]?.url) {
                // 直接返回了 URL
                mediaUrl = responseData.data[0].url;
              } 
              else if (isVideoAPI && (responseData.video_id || responseData.task_id || (responseData.data && responseData.data.video_id))) {
                 // 异步返回了任务 ID (Agnes Video)
                 const videoId = responseData.video_id || responseData.task_id || responseData.data.video_id;
                 
                 const loadingMsg = `⏳ **视频渲染中...**\n\n云端已接收任务 (ID: \`${videoId}\`)，渲染通常需要 1~3 分钟，请耐心等待。\n\n`;
                 controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: loadingMsg } }] })}\n\n`));

                 const baseUrl = apiUrl.split('/v1')[0]; 
                 const pollUrl = `${baseUrl}/agnesapi?video_id=${videoId}`;
                 
                 let isFinished = false;
                 // 最多轮询 36 次 (约 3 分钟)
                 for (let i = 0; i < 36; i++) {
                    await new Promise(r => setTimeout(r, 5000));
                    try {
                       const pollRes = await fetch(pollUrl, { headers: { 'Authorization': `Bearer ${currentApiKey}` } });
                       if (pollRes.ok) {
                         const pollData = await pollRes.json();
                         if (pollData.status === 'success' || pollData.status === 'succeeded' || pollData.status === 'finished') {
                             mediaUrl = pollData.video_url || pollData.url || (pollData.data && pollData.data[0]?.url) || (pollData.data && pollData.data.video_url);
                             isFinished = true;
                             break;
                         } else if (pollData.status === 'failed' || pollData.status === 'error') {
                             mediaResultText = `⚠️ 视频生成失败 (上游状态返回: ${pollData.status})。`;
                             break;
                         }
                       }
                    } catch(e) {}
                 }
                 if (!isFinished && !mediaUrl) {
                    mediaResultText = `⚠️ 视频生成已达等待上限，仍在云端排队或处理中。任务 ID: \`${videoId}\``;
                 }
              }
              else if (responseData.choices && responseData.choices[0]?.message) {
                // 代理接口包装成了 Markdown
                mediaResultText = responseData.choices[0].message.content;
              }

              if (mediaUrl) {
                if (isVideoAPI) {
                  mediaResultText = `\n\n<video controls width="100%" style="border-radius: 8px; margin: 10px 0; background: #000;" src="${mediaUrl}"></video>\n\n[🔗 点击此处在浏览器中打开/下载视频](${mediaUrl})`;
                } else {
                  mediaResultText = `![生成结果](${mediaUrl})`;
                }
              }

              // 推送最终结果
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: mediaResultText } }] })}\n\n`));
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            }
          });

          return new Response(stream, {
            headers: { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
          });
        }
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders() });
      }
    }

    // ==========================================
    // 渲染 Web UI 页面
    // ==========================================
    if (request.method === 'GET' && url.pathname === '/') {
      const { models } = getChannelConfig(env);
      
      let optionsHtml = '';
      models.forEach((item, index) => {
        let displayName = item.name;
        if (!item.original.includes(':')) {
            displayName = item.id.length > 24 ? item.id.substring(0, 22) + '...' : item.id;
        }
        optionsHtml += `<option value="${item.id}" ${index === 0 ? 'selected' : ''}>${displayName}</option>`;
      });

      const html = HTML_CONTENT.replace('{{MODEL_OPTIONS}}', optionsHtml);

      return new Response(html, {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' },
      });
    }

    // ==========================================
    // Telegram Bot Webhook 路由 
    // ==========================================
    if (request.method === 'POST' && url.pathname === '/tg-webhook') {
      try {
        const update = await request.json();
        if (!env.TG_BOT_TOKEN) return new Response('OK', { status: 200 });

        ctx.waitUntil((async () => {
          try {
            const { models: modelObjList, modelMap } = getChannelConfig(env);
            if (modelObjList.length === 0) return;

            // 处理菜单按钮回调
            if (update.callback_query) {
              const cb = update.callback_query;
              const chatId = cb.message.chat.id;
              const data = cb.data;

              if (data.startsWith('M:')) {
                const index = parseInt(data.substring(2));
                if (modelObjList[index]) {
                  const selected = modelObjList[index];
                  tgUserModels.set(chatId, selected.id);
                  
                  await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      chat_id: chatId,
                      text: `✅ **已切换模型为:** \n\`${selected.name}\``,
                      parse_mode: "Markdown"
                    })
                  });
                }
              }

              await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/answerCallbackQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_query_id: cb.id })
              });
              return;
            }

            // 处理文本消息
            if (update.message && update.message.text) {
              const chatId = update.message.chat.id;
              const userText = update.message.text;

              if (userText.startsWith('/start') || userText.startsWith('/model')) {
                const inline_keyboard = modelObjList.map((model, index) => {
                  return [{ text: model.name, callback_data: `M:${index}` }];
                });

                await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    chat_id: chatId,
                    text: "⚙️ **请选择对话要使用的 AI 模型:**\n*(注意: 采用内存驻留，节点重启时默认恢复首个模型)*",
                    parse_mode: "Markdown",
                    reply_markup: { inline_keyboard }
                  })
                });
                return;
              }

              const targetModelId = tgUserModels.get(chatId) || modelObjList[0].id;
              const channel = modelMap.get(targetModelId) || modelMap.values().next().value;
              
              const currentApiKey = channel && channel.keys.length > 0 ? channel.keys[Math.floor(Math.random() * channel.keys.length)] : "";
              const apiUrl = channel ? channel.url : "";

              let pendingMsgId = null;
              try {
                await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendChatAction`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ chat_id: chatId, action: 'typing' })
                });

                const pendingRes = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    chat_id: chatId,
                    text: "⏳ _正在请求云端，请稍候..._",
                    parse_mode: "Markdown"
                  })
                });
                if (pendingRes.ok) {
                  const pendingData = await pendingRes.json();
                  pendingMsgId = pendingData.result.message_id; 
                }
              } catch(e) {}

              if (!apiUrl) {
                if (pendingMsgId) {
                  await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/deleteMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, message_id: pendingMsgId }) });
                }
                await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: "⚠️ 此模型的 API 接口未配置。" }) });
                return;
              }

              // TG 机器人多媒体判断与 Payload 适配
              const targetModelLower = targetModelId.toLowerCase();
              const isImageAPI = apiUrl.includes('images/generations') || targetModelLower.includes('image') || targetModelLower.includes('dall-e');
              const isVideoAPI = apiUrl.includes('/videos') || targetModelLower.includes('video');
              const isMediaAPI = isImageAPI || isVideoAPI;
              
              let payload = {};
              if (isMediaAPI) {
                payload = { model: targetModelId, prompt: userText };
                if (isImageAPI) payload.n = 1;
              } else {
                payload = {
                  model: targetModelId,
                  messages: [{ role: "user", content: userText }], 
                  stream: false, 
                  max_tokens: 4096
                };
              }

              const aiResponse = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${currentApiKey}`, 
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
              });

              if (pendingMsgId) {
                await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/deleteMessage`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ chat_id: chatId, message_id: pendingMsgId })
                });
              }

              if (aiResponse.ok) {
                const aiData = await aiResponse.json();
                let replyText = "AI 没有返回有效内容。";
                let mediaUrl = null;
                
                // TG 端支持异步视频轮询
                if (aiData.choices && aiData.choices[0]?.message) {
                  replyText = aiData.choices[0].message.content; 
                } else if (aiData.data && aiData.data[0]?.url) {
                  mediaUrl = aiData.data[0].url;
                } else if (isMediaAPI && (aiData.video_id || aiData.task_id || (aiData.data && aiData.data.video_id))) {
                  const videoId = aiData.video_id || aiData.task_id || aiData.data.video_id;
                  
                  await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: chatId, text: `⏳ 视频任务已提交 (ID: \`${videoId}\`)，云端正在渲染，通常需要 1~3 分钟，请耐心等待...`, parse_mode: "Markdown" })
                  });

                  const baseUrl = apiUrl.split('/v1')[0];
                  const pollUrl = `${baseUrl}/agnesapi?video_id=${videoId}`;
                  
                  let isFinished = false;
                  for (let i = 0; i < 36; i++) {
                     await new Promise(r => setTimeout(r, 5000));
                     try {
                        const pollRes = await fetch(pollUrl, { headers: { 'Authorization': `Bearer ${currentApiKey}` } });
                        if (pollRes.ok) {
                          const pollData = await pollRes.json();
                          if (pollData.status === 'success' || pollData.status === 'succeeded' || pollData.status === 'finished') {
                              mediaUrl = pollData.video_url || pollData.url || (pollData.data && pollData.data[0]?.url) || (pollData.data && pollData.data.video_url);
                              isFinished = true;
                              break;
                          } else if (pollData.status === 'failed' || pollData.status === 'error') {
                              replyText = `⚠️ 视频生成失败 (状态: ${pollData.status})`;
                              break;
                          }
                        }
                     } catch(e) {}
                  }
                  if (!isFinished && !mediaUrl) {
                     replyText = `⚠️ 视频生成超时，渲染仍在排队中。ID: \`${videoId}\``;
                  }
                }

                if (mediaUrl) {
                  replyText = isVideoAPI ? `[🎬 视频渲染完成，点击此处打开或下载](${mediaUrl})` : `[🖼️ 点击查看生成的图片](${mediaUrl})`;
                }

                const maxLength = 4000; 
                for (let i = 0; i < replyText.length; i += maxLength) {
                  const chunk = replyText.slice(i, i + maxLength);
                  
                  const tgRes = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: "Markdown" })
                  });
                  if (!tgRes.ok) {
                    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ chat_id: chatId, text: chunk })
                    });
                  }
                }
              } else {
                 const errText = await aiResponse.text();
                 await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: chatId, text: `⚠️ 接口报错 HTTP ${aiResponse.status}。\n\n**上游错误信息:**\n\`${errText.substring(0, 300)}\``, parse_mode: "Markdown" })
                  });
              }
            }
          } catch (err) {
            console.log("后台处理异常:", err);
          }
        })());

        return new Response('OK', { status: 200 });
      } catch (error) {
        return new Response('Error', { status: 500 });
      }
    }

    return new Response('Not Found', { status: 404 });
  }
};

function corsHeaders() {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
}

// ================= UI 代码 (未做任何改动) =================
const HTML_CONTENT = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>AI Assistant Pro</title>
  
  <script src="https://cdn.jsdelivr.net/npm/marked@4.3.0/marked.min.js"></script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/atom-one-dark.min.css">
  <script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js"></script>

  <style>
    :root {
      --bg-base: #f4f6f8;
      --glass-bg: rgba(255, 255, 255, 0.7);
      --glass-border: rgba(255, 255, 255, 0.6);
      --glass-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.05);
      
      --text-main: #1f1f1f;
      --text-secondary: #444746;
      --brand-color: #0b57d0; /* Gemini Blue */
      
      --user-msg: #f0f4f9; /* Gemini light gray */
      --user-text: #1f1f1f;
      
      --input-bg: rgba(255, 255, 255, 0.9);
      --hover-bg: rgba(0, 0, 0, 0.04);
      --aurora-1: #e0c3fc;
      --aurora-2: #8ec5fc;
      --aurora-3: #fbc2eb;
    }

    [data-theme="dark"] {
      --bg-base: #131314;
      --glass-bg: rgba(19, 19, 20, 0.65);
      --glass-border: rgba(255, 255, 255, 0.08);
      --glass-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
      
      --text-main: #e3e3e3;
      --text-secondary: #c4c7c5;
      --brand-color: #a8c7fa; 
      
      --user-msg: #1e1f20;
      --user-text: #e3e3e3;
      
      --input-bg: rgba(30, 31, 32, 0.9);
      --hover-bg: rgba(255, 255, 255, 0.06);
      --aurora-1: #310e68;
      --aurora-2: #0f2d59;
      --aurora-3: #4a192c;
    }

    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--text-secondary); border-radius: 10px; opacity: 0.3; }
    
    body, html {
      margin: 0; padding: 0; height: 100vh; height: 100dvh; overflow: hidden;
      font-family: "Google Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: var(--text-main); background-color: var(--bg-base); transition: background-color 0.4s ease;
    }

    .aurora-bg {
      position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: -1; pointer-events: none;
      background: 
        radial-gradient(circle at 15% 50%, var(--aurora-1) 0%, transparent 40%),
        radial-gradient(circle at 85% 30%, var(--aurora-2) 0%, transparent 45%),
        radial-gradient(circle at 50% 80%, var(--aurora-3) 0%, transparent 50%);
      filter: blur(60px); opacity: 0.7; transition: all 0.8s ease;
    }

    .app-container { display: flex; height: 100%; width: 100%; position: relative; }

    .sidebar {
      width: 260px; display: flex; flex-direction: column; z-index: 100;
      background: var(--glass-bg); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
      border-right: 1px solid var(--glass-border); transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), background 0.4s;
    }
    .sidebar-header { padding: 20px 16px 12px; }
    .new-chat-btn {
      width: 100%; padding: 12px; border-radius: 24px; border: none;
      background: rgba(128,128,128,0.1); color: var(--text-main); font-weight: 500;
      display: flex; align-items: center; justify-content: center; gap: 8px;
      cursor: pointer; transition: all 0.2s;
    }
    .new-chat-btn:hover { background: rgba(128,128,128,0.2); }
    
    .session-list { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 4px; }
    .session-item {
      padding: 12px 14px; border-radius: 10px; cursor: pointer; display: flex; justify-content: space-between; 
      align-items: center; font-size: 14px; color: var(--text-secondary); transition: all 0.2s;
    }
    .session-item:hover { background: var(--hover-bg); color: var(--text-main); }
    .session-item.active { background: rgba(128,128,128,0.15); color: var(--text-main); font-weight: 600; }
    .session-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
    .delete-btn { background: none; border: none; color: inherit; padding: 4px; cursor: pointer; opacity: 0; transition: opacity 0.2s; }
    .session-item:hover .delete-btn { opacity: 0.6; }
    .delete-btn:hover { opacity: 1 !important; color: #ef4444; }
    
    .sidebar-footer { padding: 16px; border-top: 1px solid var(--glass-border); display: flex; align-items: center; justify-content: space-between; }
    .theme-toggle { background: none; border: none; color: var(--text-secondary); cursor: pointer; display: flex; align-items: center; padding: 8px; border-radius: 8px; transition: background 0.2s; }
    .theme-toggle:hover { background: var(--hover-bg); color: var(--text-main); }

    .sidebar-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.3); z-index: 99; backdrop-filter: blur(2px); opacity: 0; transition: opacity 0.3s; }

    .chat-area { flex: 1; display: flex; flex-direction: column; position: relative; height: 100%; overflow: hidden; }
    
    .header { height: 64px; display: flex; align-items: center; padding: 0 20px; border-bottom: 1px solid var(--glass-border); background: rgba(255,255,255,0.05); }
    .header-inner { max-width: 840px; margin: 0 auto; width: 100%; display: flex; align-items: center; }
    .header-title { font-size: 16px; font-weight: 600; letter-spacing: 0.5px; display: flex; align-items: center; gap: 8px; }
    
    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #10b981; transition: all 0.3s; }
    @keyframes breathing { 
      0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.4); } 
      70% { box-shadow: 0 0 0 8px rgba(16, 185, 129, 0); } 
      100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); } 
    }
    .status-dot.generating { background: var(--brand-color); animation: breathing 1.5s infinite; }

    .menu-toggle { background: none; border: none; color: var(--text-main); cursor: pointer; padding: 8px; margin-right: 12px; border-radius: 8px; display: none; }
    
    .messages-container { flex: 1; overflow-y: auto; padding: 32px 20px; scroll-behavior: smooth; }
    .messages { max-width: 840px; margin: 0 auto; display: flex; flex-direction: column; gap: 32px; }
    
    .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 60vh; opacity: 0.8; }
    .empty-state svg { color: var(--text-secondary); width: 48px; height: 48px; margin-bottom: 20px; filter: drop-shadow(0 4px 6px rgba(0,0,0,0.05)); }
    .empty-state h2 { margin: 0; font-size: 22px; font-weight: 600; }
    
    .message-row { display: flex; width: 100%; animation: fadeIn 0.4s ease forwards; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    
    /* ========== Gemini 风格气泡调整 ========== */
    .message-row.user { justify-content: flex-end; }
    
    .message-bubble { 
      line-height: 1.6; word-wrap: break-word; font-size: 16px; 
    }
    
    .message-row.user .message-bubble { 
      background: var(--user-msg); 
      color: var(--user-text);
      max-width: 85%;
      padding: 12px 20px; 
      border-radius: 24px; 
      border-bottom-right-radius: 4px; 
      white-space: pre-wrap; 
    }
    
    /* AI 气泡去背，全宽平铺 */
    .message-row.ai .message-bubble { 
      background: transparent; 
      border: none; 
      box-shadow: none;
      width: 100%;
      max-width: 100%;
      padding: 0;
    }
    
    .error-msg .message-bubble { color: #ef4444; }

    /* ========== Markdown 内容样式 ========== */
    .markdown-body img { max-width: 100%; border-radius: 8px; margin-top: 10px; }
    
    .markdown-body {
      font-size: 16px;
      line-height: 1.7;
      color: var(--text-main);
    }
    .markdown-body p { margin-top: 0; margin-bottom: 1.2em; }
    .markdown-body p:last-child { margin-bottom: 0; }
    .markdown-body a { color: var(--brand-color); text-decoration: none; }
    .markdown-body a:hover { text-decoration: underline; }
    .markdown-body strong { font-weight: 600; }
    
    .markdown-body blockquote {
      margin: 12px 0; padding: 12px 16px;
      color: var(--text-secondary);
      border-left: 4px solid var(--brand-color);
      background: rgba(128,128,128,0.05);
      border-radius: 0 8px 8px 0;
    }
    
    .markdown-body ul, .markdown-body ol { margin-top: 0; margin-bottom: 1.2em; padding-left: 24px; }
    .markdown-body li { margin-bottom: 0.4em; }

    .markdown-body table { width: 100%; border-collapse: collapse; margin-bottom: 1.2em; font-size: 14px; }
    .markdown-body th, .markdown-body td { border: 1px solid rgba(128,128,128,0.2); padding: 10px 14px; }
    .markdown-body th { background: rgba(128,128,128,0.05); font-weight: 600; text-align: left; }

    .markdown-body code {
      background: rgba(128,128,128,0.1);
      padding: 2px 6px; border-radius: 6px;
      font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
      font-size: 0.9em;
      color: var(--text-main);
    }
    
    /* ========== Gemini 级代码块包裹 ========== */
    .code-wrapper {
      background: #1e1e1e; /* 纯深色代码底 */
      border-radius: 12px;
      overflow: hidden;
      margin: 16px 0;
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    }
    .code-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 16px;
      background: #2d2d2d;
      color: #b4b4b4;
      font-size: 12px;
      font-family: ui-monospace, monospace;
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .copy-btn {
      background: transparent; border: none; color: #b4b4b4;
      cursor: pointer; display: flex; align-items: center; gap: 6px;
      font-size: 12px; transition: color 0.2s; padding: 4px 8px; border-radius: 4px;
    }
    .copy-btn:hover { color: #ffffff; background: rgba(255,255,255,0.1); }
    .code-wrapper pre {
      background: transparent !important;
      margin: 0 !important;
      padding: 16px;
      overflow-x: auto;
      border-radius: 0;
      box-shadow: none;
    }
    .code-wrapper pre code {
      background: transparent;
      padding: 0;
      color: #e3e3e3;
      font-size: 14px;
      line-height: 1.5;
    }
    /* ==================================== */

    .reasoning-box {
      font-size: 14px;
      color: var(--text-secondary);
      background: rgba(128,128,128,0.05);
      padding: 12px 16px;
      border-radius: 12px;
      border-left: 3px solid var(--brand-color);
      margin-bottom: 16px;
      white-space: pre-wrap;
      line-height: 1.6;
      max-height: 150px;
      overflow-y: auto;
    }
    .reasoning-box::-webkit-scrollbar { width: 4px; }
    .reasoning-box::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.3); border-radius: 4px; }

    .typing-indicator { display: inline-flex; gap: 6px; align-items: center; padding: 4px 2px; height: 24px; }
    .typing-dot { width: 6px; height: 6px; background: var(--brand-color); border-radius: 50%; animation: typing 1.4s infinite ease-in-out both; }
    .typing-dot:nth-child(1) { animation-delay: -0.32s; }
    .typing-dot:nth-child(2) { animation-delay: -0.16s; }
    @keyframes typing { 0%, 80%, 100% { transform: scale(0); opacity: 0.5; } 40% { transform: scale(1); opacity: 1; } }

    .input-wrapper { padding: 0 20px 24px; max-width: 880px; margin: 0 auto; width: 100%; position: relative; }
    .input-box { 
      background: var(--input-bg); backdrop-filter: blur(20px); border: 1px solid var(--glass-border);
      border-radius: 28px; padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; 
      box-shadow: 0 12px 40px rgba(0,0,0,0.08); transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); 
    }
    .input-box:focus-within { border-color: rgba(11, 87, 208, 0.3); box-shadow: 0 12px 40px rgba(11, 87, 208, 0.1); transform: translateY(-2px); }
    [data-theme="dark"] .input-box:focus-within { border-color: rgba(168, 199, 250, 0.3); box-shadow: 0 12px 40px rgba(168, 199, 250, 0.05); }
    
    .input-top { display: flex; align-items: flex-end; gap: 12px; }
    textarea { flex: 1; background: transparent; border: none; color: var(--text-main); font-size: 16px; line-height: 24px; max-height: 200px; min-height: 24px; resize: none; outline: none; font-family: inherit; padding: 4px 0 4px 8px; }
    textarea::placeholder { color: var(--text-secondary); opacity: 0.7; }
    
    .send-btn { width: 36px; height: 36px; border-radius: 50%; border: none; background: rgba(128,128,128,0.1); color: var(--text-secondary); display: flex; align-items: center; justify-content: center; cursor: not-allowed; transition: all 0.3s; flex-shrink: 0; margin-bottom: 2px; }
    .send-btn.active { background: var(--text-main); color: var(--bg-base); cursor: pointer; }
    .send-btn.active:hover { transform: scale(1.05); }
    
    .input-bottom { display: flex; justify-content: space-between; align-items: center; height: 26px; padding-top: 4px; }
    
    .model-selector-container { 
      display: flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 12px; 
      cursor: pointer; transition: background 0.2s; position: relative; overflow: hidden;
    }
    .model-selector-container:hover { background: var(--hover-bg); }
    .model-select { 
      position: absolute; top: 0; left: 0; width: 100%; height: 100%; opacity: 0; 
      cursor: pointer; border: none; outline: none; -webkit-appearance: none; appearance: none;
    }
    .model-display-text { font-size: 12px; font-weight: 500; color: var(--text-secondary); pointer-events: none; }
    
    .disclaimer { text-align: center; font-size: 12px; color: var(--text-secondary); opacity: 0.6; margin-top: 16px; }

    @media (min-width: 769px) {
      .app-container { padding: 24px; gap: 24px; align-items: center; justify-content: center; }
      .sidebar { position: relative; transform: translateX(0); border-radius: 24px; height: 100%; box-shadow: var(--glass-shadow); flex-shrink: 0; }
      .chat-area { border-radius: 24px; height: 100%; background: var(--glass-bg); backdrop-filter: blur(20px); border: 1px solid var(--glass-border); box-shadow: var(--glass-shadow); }
      .delete-btn { display: block; }
    }

    @media (max-width: 768px) {
      :root {
        --bg-base: #ffffff;
        --glass-bg: #ffffff;
        --glass-border: #e5e5e5;
        --glass-shadow: none;
        --user-msg: #f0f4f9;
        --input-bg: #f0f4f9;
      }
      [data-theme="dark"] {
        --bg-base: #131314;
        --glass-bg: #131314;
        --glass-border: #333;
        --user-msg: #1e1f20;
        --input-bg: #1e1f20;
      }

      body, html { background-color: var(--bg-base); }
      .app-container { display: block; padding: 0; background: var(--bg-base); }
      .aurora-bg { display: none; }
      
      .sidebar { border-radius: 0; box-shadow: none; position: absolute; top: 0; left: 0; height: 100%; z-index: 100; border-right: 1px solid var(--glass-border); width: 280px; transform: translateX(-100%); transition: transform 0.3s ease; }
      .sidebar.open { transform: translateX(0); }
      .new-chat-btn { border: 1px solid var(--glass-border); justify-content: center; background: transparent; }
      .session-item.active { background: var(--hover-bg); }
      .delete-btn { display: block; opacity: 1; color: var(--text-secondary); background: none; }
      
      .sidebar-overlay { backdrop-filter: none; -webkit-backdrop-filter: none; }
      .sidebar-overlay.active { display: block; opacity: 1; }
      
      .chat-area { background: transparent; border: none; box-shadow: none; border-radius: 0; }
      .header { border-bottom: 1px solid transparent; height: 60px; padding: 0 16px; justify-content: flex-start; }
      .header-title { display: none; }
      .menu-toggle { display: flex; }
      
      .messages-container { padding: 0; }
      .messages { padding: 20px 16px; gap: 32px; max-width: 100%; }
      .message-row.user .message-bubble { border-radius: 20px; border-bottom-right-radius: 4px; }
      
      .input-wrapper { padding: 8px 16px 12px 16px; padding-bottom: max(16px, env(safe-area-inset-bottom)); max-width: 100%; }
      .input-box { border: none; box-shadow: none; border-radius: 24px; padding: 12px 16px 16px 16px; gap: 12px; }
      .input-box:focus-within { transform: none; border-color: transparent; }
      
      .send-btn.active:hover { transform: none; }
      .input-bottom { min-height: 28px; }
      .disclaimer { margin-top: 12px; }
    }
  </style>
</head>
<body>

<div class="aurora-bg"></div>
<div class="sidebar-overlay" id="sidebarOverlay"></div>

<div class="app-container">
  <div class="sidebar" id="sidebar">
    <div class="sidebar-header">
      <button class="new-chat-btn" id="newChatBtn">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        新对话
      </button>
    </div>
    <div class="session-list" id="sessionList"></div>
    <div class="sidebar-footer">
      <button class="theme-toggle" id="themeToggle" title="切换主题">
        <svg id="themeIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
      </button>
      <div style="font-size: 12px; color: var(--text-secondary); opacity: 0.6; font-weight: 500;">v4.0 Final Optimized</div>
    </div>
  </div>

  <div class="chat-area">
    <div class="header">
      <div class="header-inner">
        <button class="menu-toggle" id="menuToggle">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
        </button>
        <div class="header-title">
          <div class="status-dot" id="statusDot"></div>
          <span id="headerTitle">AI 中枢</span>
        </div>
      </div>
    </div>
    
    <div class="messages-container" id="scrollArea">
      <div class="messages" id="messages"></div>
      <div class="empty-state" id="emptyState">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
        <h2>今天我能为你提供什么帮助？</h2>
      </div>
    </div>

    <div class="input-wrapper">
      <div class="input-box">
        <div class="input-top">
          <textarea id="userInput" placeholder="输入指令或开始对话..." rows="1"></textarea>
          <button class="send-btn" id="sendBtn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>
          </button>
        </div>
        
        <div class="input-bottom">
          <div class="model-selector-container">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="pointer-events:none;"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
            <span class="model-display-text" id="modelDisplayText">加载中...</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity:0.6; pointer-events:none;"><polyline points="6 9 12 15 18 9"></polyline></svg>
            <select class="model-select" id="modelSelect">
              {{MODEL_OPTIONS}}
            </select>
          </div>
        </div>
      </div>
      <div class="disclaimer">AI 生成的内容可能不准确。请核实重要信息。</div>
    </div>
  </div>
</div>

<script>
  const renderer = new marked.Renderer();
  renderer.code = function(code, language) {
    const validLang = !!(language && hljs.getLanguage(language));
    const highlighted = validLang ? hljs.highlight(code, { language }).value : hljs.highlightAuto(code).value;
    const displayLang = language ? language : 'text';
    
    return \`
      <div class="code-wrapper">
        <div class="code-header">
          <span>\${displayLang}</span>
          <button class="copy-btn" data-code="\${encodeURIComponent(code)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            <span>复制代码</span>
          </button>
        </div>
        <pre><code class="hljs \${language}">\${highlighted}</code></pre>
      </div>
    \`;
  };

  marked.setOptions({
    breaks: true, 
    renderer: renderer
  });

  document.addEventListener('click', function(e) {
    const copyBtn = e.target.closest('.copy-btn');
    if (!copyBtn) return;
    
    const code = decodeURIComponent(copyBtn.getAttribute('data-code'));
    navigator.clipboard.writeText(code).then(() => {
      const span = copyBtn.querySelector('span');
      const originalText = span.innerText;
      span.innerText = '已复制';
      setTimeout(() => { span.innerText = originalText; }, 2000);
    });
  });

  const STORAGE_KEY = 'nvidia_ai_sessions';
  let sessions = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  let currentSessionId = null;

  const messagesDiv = document.getElementById('messages');
  const emptyState = document.getElementById('emptyState');
  const scrollArea = document.getElementById('scrollArea');
  const userInput = document.getElementById('userInput');
  const sendBtn = document.getElementById('sendBtn');
  const sessionListDiv = document.getElementById('sessionList');
  const modelSelect = document.getElementById('modelSelect');
  const headerTitle = document.getElementById('headerTitle');
  const modelDisplayText = document.getElementById('modelDisplayText');
  const statusDot = document.getElementById('statusDot');
  
  const sidebar = document.getElementById('sidebar');
  const menuToggle = document.getElementById('menuToggle');
  const sidebarOverlay = document.getElementById('sidebarOverlay');
  
  const themeToggle = document.getElementById('themeToggle');
  const themeIcon = document.getElementById('themeIcon');
  let currentTheme = localStorage.getItem('theme') || 'light';
  applyTheme(currentTheme);

  themeToggle.addEventListener('click', () => {
    currentTheme = currentTheme === 'light' ? 'dark' : 'light';
    localStorage.setItem('theme', currentTheme);
    applyTheme(currentTheme);
  });

  function applyTheme(theme) {
    if (theme === 'dark') {
      document.body.setAttribute('data-theme', 'dark');
      themeIcon.innerHTML = '<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>';
    } else {
      document.body.removeAttribute('data-theme');
      themeIcon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';
    }
  }

  userInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
    if(this.value.trim().length > 0) sendBtn.classList.add('active');
    else sendBtn.classList.remove('active');
  });

  function init() {
    updateHeaderDisplay();
    if (sessions.length === 0) createNewSession();
    else switchSession(sessions[0].id);
    renderSessionList();
  }

  function saveSessions() { localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions)); }

  menuToggle.addEventListener('click', () => { sidebar.classList.toggle('open'); sidebarOverlay.classList.toggle('active'); });
  sidebarOverlay.addEventListener('click', () => { sidebar.classList.remove('open'); sidebarOverlay.classList.remove('active'); });

  function updateHeaderDisplay() {
    if (modelSelect) {
      const selectedText = modelSelect.options[modelSelect.selectedIndex]?.text || 'AI 中枢';
      headerTitle.innerText = selectedText;
      if (modelDisplayText) modelDisplayText.innerText = selectedText;
    }
  }

  function createNewSession() {
    const newId = 'session_' + Date.now();
    sessions.unshift({ id: newId, title: '新对话', messages: [], model: modelSelect.value });
    saveSessions();
    switchSession(newId);
    renderSessionList();
    if(window.innerWidth <= 768) sidebar.classList.remove('open');
  }

  function switchSession(id) {
    currentSessionId = id;
    const currentSession = sessions.find(s => s.id === id);
    if (currentSession && currentSession.model) {
      modelSelect.value = currentSession.model;
    }
    updateHeaderDisplay();
    renderMessages();
    renderSessionList();
    if(window.innerWidth <= 768) { sidebar.classList.remove('open'); sidebarOverlay.classList.remove('active'); userInput.blur(); }
  }

  modelSelect.addEventListener('change', function() {
    const currentSession = sessions.find(s => s.id === currentSessionId);
    if(currentSession) {
      currentSession.model = this.value;
      saveSessions();
    }
    updateHeaderDisplay();
  });

  function deleteSession(e, id) {
    e.stopPropagation(); 
    if (!confirm('确认删除此记录吗？')) return;
    sessions = sessions.filter(s => s.id !== id); 
    saveSessions();
    if (sessions.length === 0) createNewSession();
    else if (currentSessionId === id) switchSession(sessions[0].id);
    else renderSessionList();
  }

  function renderSessionList() {
    sessionListDiv.innerHTML = '';
    sessions.forEach(session => {
      const item = document.createElement('div');
      item.className = \`session-item \${session.id === currentSessionId ? 'active' : ''}\`;
      item.onclick = () => switchSession(session.id);
      
      const titleSpan = document.createElement('span'); 
      titleSpan.className = 'session-title'; 
      titleSpan.innerText = session.title;
      
      const delBtn = document.createElement('button'); 
      delBtn.className = 'delete-btn'; 
      delBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4h4v2"></path></svg>';
      delBtn.onclick = (e) => deleteSession(e, session.id);
      
      item.appendChild(titleSpan); 
      item.appendChild(delBtn); 
      sessionListDiv.appendChild(item);
    });
  }

  function renderMessages() {
    messagesDiv.innerHTML = '';
    const currentSession = sessions.find(s => s.id === currentSessionId);
    if (!currentSession) return;
    
    if (currentSession.messages.length === 0) {
      emptyState.style.display = 'flex';
    } else { 
      emptyState.style.display = 'none'; 
      currentSession.messages.forEach(msg => {
        const uiRole = msg.role === 'assistant' ? 'ai' : msg.role;
        appendMessageDOM(uiRole, msg.content, null, false);
      }); 
    }
  }

  function appendMessageDOM(role, content, msgId = null, isError = false) {
    let row = msgId ? document.getElementById('row_' + msgId) : null;
    let bubble = msgId ? document.getElementById(msgId) : null;
    
    if (!row) {
      row = document.createElement('div'); 
      row.className = \`message-row \${role}\`;
      if (msgId) row.id = 'row_' + msgId; 
      if (isError) row.classList.add('error-msg');
      
      bubble = document.createElement('div'); 
      bubble.className = 'message-bubble'; 
      if (msgId) bubble.id = msgId;
      
      row.appendChild(bubble); 
      messagesDiv.appendChild(row);
    }
    
    if (role === 'ai') {
      if (msgId) {
        bubble.innerHTML = content;
      } else {
        bubble.innerHTML = '<div class="message-text markdown-body">' + marked.parse(content) + '</div>';
      }
    } else {
      bubble.innerText = content; 
    }
    
    scrollArea.scrollTop = scrollArea.scrollHeight; 
    
    const rBox = bubble.querySelector('.reasoning-box');
    if (rBox) { rBox.scrollTop = rBox.scrollHeight; }

    return bubble;
  }

  async function sendMessage() {
    const text = userInput.value.trim(); 
    if (!text) return;
    
    const currentSession = sessions.find(s => s.id === currentSessionId);
    if (currentSession.messages.length === 0) {
      currentSession.title = text.length > 14 ? text.substring(0, 14) + '...' : text;
      renderSessionList();
    }
    
    emptyState.style.display = 'none'; 
    userInput.value = ''; 
    userInput.style.height = 'auto';
    sendBtn.classList.remove('active'); 
    sendBtn.disabled = true;
    statusDot.classList.add('generating'); 
    
    appendMessageDOM('user', text);
    currentSession.messages.push({ role: 'user', content: text });
    saveSessions();

    const aiMsgId = 'ai_' + Date.now();
    appendMessageDOM('ai', \`
      <div class="reasoning-box" style="display:none;"></div>
      <div class="message-text markdown-body">
        <div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>
      </div>
    \`, aiMsgId);
    
    const bubble = document.getElementById(aiMsgId);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          messages: currentSession.messages,
          model: modelSelect.value 
        })
      });

      if (!response.ok) { 
        const errorData = await response.json().catch(() => ({ error: '网络或服务接口错误' })); 
        throw new Error(errorData.error || '请求失败'); 
      }
      
      const reader = response.body.getReader(); 
      const decoder = new TextDecoder('utf-8');
      
      let aiContent = ''; 
      let reasoningContent = ''; 
      let buffer = ''; 
      
      const rBox = bubble.querySelector('.reasoning-box');
      const tBox = bubble.querySelector('.message-text');
      
      while (true) {
        const { done, value } = await reader.read(); 
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        let lines = buffer.split('\\n');
        buffer = lines.pop(); 
        
        for (let line of lines) {
          line = line.trim();
          if (line.startsWith('data:') && line !== 'data: [DONE]') {
            try {
              const data = JSON.parse(line.slice(5).trim());
              
              if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

              if (data.choices && data.choices[0].delta) {
                const delta = data.choices[0].delta;
                
                if (delta.reasoning_content) {
                  reasoningContent += delta.reasoning_content;
                  if (rBox.style.display === 'none') rBox.style.display = 'block';
                  rBox.textContent = reasoningContent;
                  rBox.scrollTop = rBox.scrollHeight;
                }

                if (delta.content !== undefined && delta.content !== null) {
                  aiContent += delta.content; 
                }
                
                if (aiContent || !reasoningContent) {
                  tBox.innerHTML = marked.parse(aiContent) + '<span style="display:inline-block; width:6px; height:18px; background:var(--brand-color); animation:typing 1s infinite; vertical-align:middle; margin-left:4px; border-radius:2px;"></span>';
                } else if (reasoningContent && !aiContent) {
                  tBox.innerHTML = '<div style="color: var(--brand-color); font-size: 14px; font-weight: 500;">正在深度思考... ▍</div>';
                }

                scrollArea.scrollTop = scrollArea.scrollHeight;
              }
            } catch (e) {}
          }
        }
      }
      
      if (buffer.trim() && buffer.trim().startsWith('data:') && !buffer.includes('[DONE]')) {
        try {
          const data = JSON.parse(buffer.slice(5).trim());
          if (data.choices && data.choices[0].delta) {
            const delta = data.choices[0].delta;
            if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
            if (delta.content) aiContent += delta.content;
          }
        } catch(e) {}
      }

      if (!reasoningContent && rBox) rBox.remove();
      
      tBox.innerHTML = marked.parse(aiContent);
      scrollArea.scrollTop = scrollArea.scrollHeight;
      
      currentSession.messages.push({ role: 'assistant', content: aiContent }); 
      saveSessions();
      
    } catch (error) {
      if (aiContent || reasoningContent) {
        tBox.innerHTML = marked.parse(aiContent) + \`<br><br><span style="color: #ef4444; font-size: 13px; font-weight: 500;">(⚠️ 网络连接中断，已保留当前生成的内容。错误: \${error.message})</span>\`;
        currentSession.messages.push({ role: 'assistant', content: aiContent });
        if (rBox && reasoningContent) rBox.remove(); 
      } else {
        bubble.querySelector('.message-text').innerText = '通信断开: ' + error.message; 
        bubble.parentElement.classList.add('error-msg');
        currentSession.messages.pop(); 
      }
      saveSessions();
    } finally {
      sendBtn.disabled = false; 
      statusDot.classList.remove('generating'); 
      if (userInput.value.trim().length > 0) sendBtn.classList.add('active'); 
      userInput.focus();
    }
  }

  document.getElementById('newChatBtn').addEventListener('click', createNewSession);
  sendBtn.addEventListener('click', sendMessage);
  userInput.addEventListener('keydown', (e) => { 
    if (e.key === 'Enter' && !e.shiftKey && sendBtn.classList.contains('active')) { 
      e.preventDefault(); 
      sendMessage(); 
    } 
  });
  
  init();
</script>
</body>
</html>`;
