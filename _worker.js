// 全局内存缓存（L1 缓存）
const tgUserModels = new Map();

// 配置全局缓存单例
let cachedConfig = null;
let cachedEnvRef = null;

// 复用 HTTP 响应头结构，减少对象频繁创建
const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
};

const HTML_HEADERS = { 'Content-Type': 'text/html;charset=UTF-8' };
const TEXT_HEADERS = { 'Content-Type': 'text/plain;charset=UTF-8' };

// 辅助函数：高效解析逗号分隔符
function parseCommaSeparated(str) {
  if (!str) return [];
  return str.split(',').map(s => s.trim()).filter(Boolean);
}

// ======= 统一解析通道配置（带内存缓存） =======
function getChannelConfig(env) {
  if (cachedConfig && cachedEnvRef === env) {
    return cachedConfig;
  }

  const models = [];
  const modelMap = new Map();

  const addModels = (modelStr, url, keys) => {
    if (!modelStr) return;
    const arr = modelStr.split(',');
    for (let i = 0; i < arr.length; i++) {
      const raw = arr[i].trim();
      if (!raw) continue;
      
      const colonIdx = raw.lastIndexOf(':');
      const id = colonIdx > 0 ? raw.substring(0, colonIdx).trim() : raw;
      const name = colonIdx > 0 ? raw.substring(colonIdx + 1).trim() : raw;

      if (!modelMap.has(id)) {
        models.push({ id, name, original: raw });
        modelMap.set(id, { url, keys });
      }
    }
  };

  if (env.API_CONFIG) {
    try {
      const channels = JSON.parse(env.API_CONFIG);
      channels.forEach(ch => {
        const url = ch.url;
        const keys = Array.isArray(ch.keys) ? ch.keys : parseCommaSeparated(ch.keys);
        const modelStr = Array.isArray(ch.models) ? ch.models.join(',') : ch.models;
        if (url && modelStr) addModels(modelStr, url, keys);
      });
      if (models.length > 0) {
        cachedConfig = { models, modelMap };
        cachedEnvRef = env;
        return cachedConfig;
      }
    } catch (e) {
      console.log("API_CONFIG 解析失败:", e);
    }
  }

  let hasIndexed = false;
  for (let i = 1; i <= 20; i++) {
    const url = env[`API_URL_${i}`];
    const modelStr = env[`MODEL_${i}`];
    if (url && modelStr) {
      hasIndexed = true;
      const keys = parseCommaSeparated(env[`API_KEY_${i}`]);
      addModels(modelStr, url, keys);
    }
  }
  if (hasIndexed && models.length > 0) {
    cachedConfig = { models, modelMap };
    cachedEnvRef = env;
    return cachedConfig;
  }

  const fallbackUrl = env.API_URL || "";
  const fallbackKeys = parseCommaSeparated(env.API_KEY);
  const fallbackModelStr = env.MODEL || "meta/llama3-70b-instruct:Llama 3 70B,deepseek-ai/DeepSeek-R1:深度思考 R1";
  
  addModels(fallbackModelStr, fallbackUrl, fallbackKeys);

  cachedConfig = { models, modelMap };
  cachedEnvRef = env;
  return cachedConfig;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 微信认证路由
    if (request.method === 'GET' && url.pathname === '/a9a015a0f6e7c9ca09f4cdce4479deb3.txt') {
      return new Response('b7aa7e3069358c2c18f7908a7d5815788bafd020', { headers: TEXT_HEADERS });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method === 'POST' && url.pathname === '/api/chat') {
      try {
        let body;
        try {
          body = await request.json();
        } catch (e) {
          return new Response(JSON.stringify({ error: "无效的请求格式" }), { status: 400, headers: CORS_HEADERS });
        }

        const { models, modelMap } = getChannelConfig(env);
        let selectedModel = body.model || (models.length > 0 ? models[0].id : "");

        if (!modelMap.has(selectedModel)) {
          selectedModel = models.length > 0 ? models[0].id : "";
        }

        const channel = modelMap.get(selectedModel);

        if (!channel || !channel.url) {
          return new Response(JSON.stringify({ error: "该模型对应的 API_URL 未配置或异常" }), { status: 500, headers: CORS_HEADERS });
        }

        const currentApiKey = channel.keys.length > 0 ? channel.keys[Math.floor(Math.random() * channel.keys.length)] : "";
        const apiUrl = channel.url;
        const isImageAPI = apiUrl.includes('images/generations') || selectedModel.toLowerCase().includes('image');

        const payload = isImageAPI ? {
          model: selectedModel,
          prompt: body.messages[body.messages.length - 1].content,
          n: 1
        } : {
          model: selectedModel,
          messages: body.messages,
          stream: true,
          max_tokens: 4096, 
        };

        const nvidiaResponse = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${currentApiKey}`, 
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        if (!nvidiaResponse.ok) {
          const errText = await nvidiaResponse.text();
          return new Response(JSON.stringify({ error: `API 报错 (${nvidiaResponse.status}): ${errText}` }), {
            status: nvidiaResponse.status,
            headers: CORS_HEADERS,
          });
        }

        if (!isImageAPI) {
          return new Response(nvidiaResponse.body, { headers: SSE_HEADERS });
        } else {
          const responseData = await nvidiaResponse.json();
          let imageUrlOrText = "图片生成失败或未返回格式";
          
          if (responseData.data && responseData.data[0]?.url) {
            imageUrlOrText = `![生成结果](${responseData.data[0].url})`;
          } else if (responseData.choices && responseData.choices[0]?.message) {
            imageUrlOrText = responseData.choices[0].message.content;
          }

          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              const fakeChunk = JSON.stringify({ choices: [{ delta: { content: imageUrlOrText + "\n\n" } }] });
              controller.enqueue(encoder.encode(`data: ${fakeChunk}\n\n`));
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            }
          });

          return new Response(stream, { headers: SSE_HEADERS });
        }
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: CORS_HEADERS });
      }
    }

    if (request.method === 'GET' && url.pathname === '/') {
      const { models } = getChannelConfig(env);
      
      let optionsHtml = '';
      for (let i = 0; i < models.length; i++) {
        const item = models[i];
        let displayName = item.name;
        if (!item.original.includes(':')) {
          displayName = item.id.length > 24 ? item.id.substring(0, 22) + '...' : item.id;
        }
        optionsHtml += `<option value="${item.id}" ${i === 0 ? 'selected' : ''}>${displayName}</option>`;
      }

      const html = HTML_CONTENT.replaceAll('{{MODEL_OPTIONS}}', optionsHtml);
      return new Response(html, { headers: HTML_HEADERS });
    }

    // Telegram Bot Webhook
    if (request.method === 'POST' && url.pathname === '/tg-webhook') {
      try {
        const update = await request.json();
        if (!env.TG_BOT_TOKEN) return new Response('OK', { status: 200 });

        const tgApi = (method, body) => fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        ctx.waitUntil((async () => {
          try {
            const { models: modelObjList, modelMap } = getChannelConfig(env);
            if (modelObjList.length === 0) return;

            if (update.callback_query) {
              const cb = update.callback_query;
              const chatId = cb.message.chat.id;
              const data = cb.data;

              if (data.startsWith('M:')) {
                const index = parseInt(data.substring(2), 10);
                if (modelObjList[index]) {
                  const selected = modelObjList[index];
                  tgUserModels.set(chatId, selected.id);
                  if (env.KV) {
                    ctx.waitUntil(env.KV.put(`tg_user_${chatId}`, selected.id).catch(() => {}));
                  }
                  
                  tgApi('sendMessage', {
                    chat_id: chatId,
                    text: `✅ **已切换模型为:** \n\`${selected.name}\``,
                    parse_mode: "Markdown"
                  }).catch(() => {});
                }
              }

              tgApi('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
              return;
            }

            if (update.message && update.message.text) {
              const chatId = update.message.chat.id;
              const userText = update.message.text;

              if (userText.startsWith('/start') || userText.startsWith('/model')) {
                const inline_keyboard = modelObjList.map((model, index) => {
                  return [{ text: model.name, callback_data: `M:${index}` }];
                });

                await tgApi('sendMessage', {
                  chat_id: chatId,
                  text: "⚙️ **请选择对话要使用的 AI 模型:**",
                  parse_mode: "Markdown",
                  reply_markup: { inline_keyboard }
                });
                return;
              }

              let targetModelId = tgUserModels.get(chatId);
              if (!targetModelId && env.KV) {
                try { targetModelId = await env.KV.get(`tg_user_${chatId}`); } catch(e){}
              }
              if (!targetModelId || !modelMap.has(targetModelId)) {
                targetModelId = modelObjList[0].id;
              }

              const channel = modelMap.get(targetModelId) || modelMap.values().next().value;
              const currentApiKey = channel && channel.keys.length > 0 ? channel.keys[Math.floor(Math.random() * channel.keys.length)] : "";
              const apiUrl = channel ? channel.url : "";

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

              if (!apiUrl) {
                if (pendingMsgId) {
                  tgApi('deleteMessage', { chat_id: chatId, message_id: pendingMsgId }).catch(() => {});
                }
                await tgApi('sendMessage', { chat_id: chatId, text: "⚠️ 此模型的 API 接口未配置。" });
                return;
              }

              const isImageAPI = apiUrl.includes('images/generations') || targetModelId.toLowerCase().includes('image');
              
              const payload = isImageAPI ? {
                model: targetModelId,
                prompt: userText,
                n: 1
              } : {
                model: targetModelId,
                messages: [{ role: "user", content: userText }],
                stream: false, 
                max_tokens: 4096
              };

              const aiResponse = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${currentApiKey}`, 
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
              });

              if (pendingMsgId) {
                ctx.waitUntil(tgApi('deleteMessage', { chat_id: chatId, message_id: pendingMsgId }).catch(() => {}));
              }

              if (aiResponse.ok) {
                const aiData = await aiResponse.json();
                let replyText = "AI 没有返回有效内容。";
                
                if (aiData.choices && aiData.choices[0]?.message) {
                  replyText = aiData.choices[0].message.content;
                } else if (aiData.data && aiData.data[0]?.url) {
                  replyText = `[🖼️ 点击查看生成的图片](${aiData.data[0].url})`;
                }

                const maxLength = 4000; 
                for (let i = 0; i < replyText.length; i += maxLength) {
                  const chunk = replyText.slice(i, i + maxLength);
                  
                  const tgRes = await tgApi('sendMessage', {
                    chat_id: chatId,
                    text: chunk,
                    parse_mode: "Markdown"
                  });

                  if (!tgRes.ok) {
                    await tgApi('sendMessage', { chat_id: chatId, text: chunk });
                  }
                }
              } else {
                 await tgApi('sendMessage', { chat_id: chatId, text: "⚠️ AI 接口请求失败，请稍后再试。" });
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

// ================= UI 代码 =================
const HTML_CONTENT = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>AI Assistant Pro</title>
  
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/marked@4.3.0/marked.min.js"></script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/atom-one-dark.min.css">
  <script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js"></script>

  <style>
    :root {
      --bg-base: #f8fafc;
      --glass-bg: rgba(255, 255, 255, 0.75);
      --glass-border: rgba(255, 255, 255, 0.8);
      --glass-shadow: 0 10px 40px -10px rgba(0, 0, 0, 0.08), 0 0 20px rgba(255, 255, 255, 0.5) inset;
      --text-main: #0f172a;
      --text-secondary: #475569;
      --brand-color: #3b82f6;
      --brand-gradient: linear-gradient(135deg, #3b82f6, #6366f1);
      --user-msg: var(--brand-gradient);
      --user-text: #ffffff;
      --input-bg: rgba(255, 255, 255, 0.95);
      --hover-bg: rgba(15, 23, 42, 0.04);
      --aurora-1: #e0e7ff;
      --aurora-2: #dbeafe;
      --aurora-3: #f3e8ff;
      --border-radius: 20px;
    }

    [data-theme="dark"] {
      --bg-base: #0f172a;
      --glass-bg: rgba(30, 41, 59, 0.7);
      --glass-border: rgba(255, 255, 255, 0.05);
      --glass-shadow: 0 10px 40px -10px rgba(0, 0, 0, 0.5), 0 0 20px rgba(255, 255, 255, 0.02) inset;
      --text-main: #f1f5f9;
      --text-secondary: #94a3b8;
      --brand-color: #60a5fa; 
      --brand-gradient: linear-gradient(135deg, #3b82f6, #4f46e5);
      --user-msg: var(--brand-gradient);
      --user-text: #ffffff;
      --input-bg: rgba(30, 41, 59, 0.95);
      --hover-bg: rgba(255, 255, 255, 0.08);
      --aurora-1: #1e1b4b;
      --aurora-2: #0f172a;
      --aurora-3: #312e81;
    }

    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--text-secondary); border-radius: 10px; opacity: 0.2; }
    ::-webkit-scrollbar-thumb:hover { background: var(--brand-color); }
    
    /* 严格限制视口宽度，防止整页左右晃动 */
    body, html {
      margin: 0; padding: 0; height: 100vh; height: 100dvh; 
      width: 100%; max-width: 100vw; overflow: hidden;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: var(--text-main); background-color: var(--bg-base); transition: background-color 0.5s ease;
    }

    @keyframes float1 { 0%, 100% { transform: translate(0, 0) scale(1); } 50% { transform: translate(30px, -30px) scale(1.05); } }
    @keyframes float2 { 0%, 100% { transform: translate(0, 0) scale(1); } 50% { transform: translate(-30px, 20px) scale(1.1); } }
    @keyframes float3 { 0%, 100% { transform: translate(0, 0) scale(1); } 50% { transform: translate(20px, 40px) scale(0.95); } }

    .aurora-bg {
      position: fixed; top: 0; left: 0; width: 100%; height: 100vh; z-index: -1; pointer-events: none;
      filter: blur(80px); opacity: 0.8; transition: opacity 0.8s ease; overflow: hidden;
    }
    .aurora-blob { position: absolute; border-radius: 50%; opacity: 0.6; mix-blend-mode: multiply; }
    [data-theme="dark"] .aurora-blob { mix-blend-mode: screen; opacity: 0.4; }
    .blob-1 { top: -10%; left: -10%; width: 50vw; height: 50vw; background: var(--aurora-1); animation: float1 15s infinite ease-in-out; }
    .blob-2 { top: 40%; right: -20%; width: 60vw; height: 60vw; background: var(--aurora-2); animation: float2 18s infinite ease-in-out; }
    .blob-3 { bottom: -20%; left: 20%; width: 50vw; height: 50vw; background: var(--aurora-3); animation: float3 20s infinite ease-in-out; }

    /* 防溢出外层容器 */
    .app-container { display: flex; height: 100%; width: 100%; max-width: 100vw; position: relative; overflow: hidden; }

    .sidebar {
      width: 280px; display: flex; flex-direction: column; z-index: 100;
      background: var(--glass-bg); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
      border-right: 1px solid var(--glass-border); transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), background 0.4s;
    }
    .sidebar-header { padding: 24px 20px 16px; }
    .new-chat-btn {
      width: 100%; padding: 14px; border-radius: 14px; border: 1px solid var(--glass-border);
      background: rgba(255,255,255,0.1); color: var(--text-main); font-weight: 600; font-size: 15px;
      display: flex; align-items: center; justify-content: center; gap: 8px;
      cursor: pointer; transition: all 0.2s ease; box-shadow: 0 2px 8px rgba(0,0,0,0.02);
    }
    .new-chat-btn:hover { background: var(--hover-bg); transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
    
    .session-list { flex: 1; overflow-y: auto; padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; }
    .session-item {
      padding: 14px 16px; border-radius: 12px; cursor: pointer; display: flex; justify-content: space-between; 
      align-items: center; font-size: 14px; color: var(--text-secondary); transition: all 0.2s ease;
      font-weight: 500; border: 1px solid transparent;
    }
    .session-item:hover { background: var(--hover-bg); color: var(--text-main); }
    .session-item.active { 
      background: var(--bg-base); color: var(--brand-color); font-weight: 600; 
      border-color: var(--glass-border); box-shadow: 0 2px 10px rgba(0,0,0,0.03);
    }
    .session-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
    .delete-btn { background: none; border: none; color: inherit; padding: 6px; cursor: pointer; opacity: 0; transition: all 0.2s; border-radius: 8px; }
    .session-item:hover .delete-btn { opacity: 0.5; }
    .delete-btn:hover { opacity: 1 !important; color: #ef4444; background: rgba(239, 68, 68, 0.1); }
    
    .sidebar-footer { padding: 16px 20px; border-top: 1px solid var(--glass-border); display: flex; align-items: center; justify-content: space-between; }
    .theme-toggle { 
      background: none; border: none; color: var(--text-secondary); cursor: pointer; 
      display: flex; align-items: center; padding: 10px; border-radius: 10px; transition: all 0.2s; 
    }
    .theme-toggle:hover { background: var(--hover-bg); color: var(--brand-color); transform: scale(1.05); }

    .sidebar-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 99; backdrop-filter: blur(4px); opacity: 0; transition: opacity 0.3s; }

    /* 聊天主区域严格防溢出 */
    .chat-area { 
      flex: 1; display: flex; flex-direction: column; position: relative; 
      height: 100%; width: 100%; max-width: 100vw; overflow: hidden; 
    }
    
    .header { height: 70px; display: flex; align-items: center; padding: 0 24px; border-bottom: 1px solid var(--glass-border); background: var(--glass-bg); backdrop-filter: blur(20px); z-index: 10; }
    .header-inner { max-width: 880px; margin: 0 auto; width: 100%; display: flex; align-items: center; }
    .header-title { font-size: 16px; font-weight: 600; letter-spacing: 0.5px; display: flex; align-items: center; gap: 10px; color: var(--text-main); }
    
    .status-dot { width: 10px; height: 10px; border-radius: 50%; background: #10b981; box-shadow: 0 0 8px rgba(16, 185, 129, 0.4); transition: all 0.3s; }
    @keyframes breathing { 
      0% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.4); background: #3b82f6; } 
      70% { box-shadow: 0 0 0 10px rgba(59, 130, 246, 0); background: #60a5fa; } 
      100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0); background: #3b82f6; } 
    }
    .status-dot.generating { animation: breathing 1.5s infinite; }

    .menu-toggle { background: none; border: none; color: var(--text-main); cursor: pointer; padding: 10px; margin-right: 12px; border-radius: 10px; display: none; transition: background 0.2s; }
    .menu-toggle:hover { background: var(--hover-bg); }
    
    .messages-container { 
      flex: 1; overflow-y: auto; overflow-x: hidden; /* 强制拦截水平滚动 */
      padding: 32px 20px; scroll-behavior: smooth;
      contain: layout style; will-change: scroll-position;
      width: 100%;
    }
    .messages { max-width: 880px; width: 100%; margin: 0 auto; display: flex; flex-direction: column; gap: 36px; }
    
    .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 65vh; opacity: 0.9; }
    .empty-state svg { color: var(--brand-color); width: 56px; height: 56px; margin-bottom: 24px; filter: drop-shadow(0 8px 16px rgba(59,130,246,0.2)); }
    .empty-state h2 { margin: 0; font-size: 24px; font-weight: 600; color: var(--text-main); letter-spacing: -0.5px; }
    
    .message-row { display: flex; width: 100%; max-width: 100%; animation: slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards; contain: content; }
    @keyframes slideUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
    
    .message-row.user { justify-content: flex-end; }
    
    /* 强制处理超长文本断行 */
    .message-bubble { 
      line-height: 1.7; 
      word-wrap: break-word; word-break: break-word; overflow-wrap: break-word; 
      font-size: 16px; max-width: 100%; 
    }
    
    .message-row.user .message-bubble { 
      background: var(--user-msg); color: var(--user-text); max-width: 80%;
      padding: 14px 22px; 
      border-radius: 24px 24px 6px 24px; 
      white-space: pre-wrap; 
      box-shadow: 0 8px 24px -6px rgba(59, 130, 246, 0.25);
      font-weight: 400;
    }
    .message-row.ai .message-bubble { background: transparent; border: none; box-shadow: none; width: 100%; max-width: 100%; padding: 0; }
    .error-msg .message-bubble { color: #ef4444; }

    /* Markdown 内宽元素防溢出处理 */
    .markdown-body { font-size: 16px; line-height: 1.75; color: var(--text-main); font-family: inherit; word-break: break-word; max-width: 100%; }
    .markdown-body p { margin-top: 0; margin-bottom: 1.2em; }
    .markdown-body p:last-child { margin-bottom: 0; }
    .markdown-body a { color: var(--brand-color); text-decoration: none; font-weight: 500; word-break: break-all; }
    .markdown-body a:hover { text-decoration: underline; }
    .markdown-body strong { font-weight: 600; color: var(--text-main); }
    
    .markdown-body blockquote {
      margin: 16px 0; padding: 16px 20px; color: var(--text-secondary);
      border-left: 4px solid var(--brand-color); background: var(--hover-bg); border-radius: 0 12px 12px 0;
      font-style: italic; max-width: 100%; overflow-x: hidden;
    }
    .markdown-body ul, .markdown-body ol { margin-top: 0; margin-bottom: 1.2em; padding-left: 24px; }
    .markdown-body li { margin-bottom: 0.4em; }
    
    .markdown-body img, .markdown-body video { max-width: 100%; height: auto; border-radius: 8px; margin-top: 10px; }

    /* 表格支持内部水平滑动，防止撑开页面 */
    .markdown-body table { 
      display: block; overflow-x: auto; white-space: nowrap; 
      width: 100%; max-width: 100%; border-collapse: collapse; margin-bottom: 1.5em; 
      font-size: 15px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.03); 
      border: 1px solid var(--glass-border); 
    }
    .markdown-body th, .markdown-body td { border: 1px solid var(--glass-border); padding: 12px 16px; }
    .markdown-body th { background: var(--hover-bg); font-weight: 600; text-align: left; }

    .markdown-body code {
      background: var(--hover-bg); padding: 3px 6px; border-radius: 6px;
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      font-size: 0.85em; color: var(--brand-color); font-weight: 500; word-break: break-all;
    }
    
    /* 代码块自适应宽度并内部滑动 */
    .code-wrapper { background: #0f172a; border-radius: 14px; overflow: hidden; margin: 20px 0; box-shadow: 0 10px 30px rgba(0,0,0,0.15); border: 1px solid rgba(255,255,255,0.1); max-width: 100%; }
    .code-header {
      display: flex; justify-content: space-between; align-items: center; padding: 10px 16px;
      background: rgba(255,255,255,0.05); color: #94a3b8; font-size: 13px; font-family: monospace; border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .copy-btn {
      background: transparent; border: none; color: #94a3b8; cursor: pointer; display: flex; align-items: center; gap: 6px;
      font-size: 12px; transition: all 0.2s; padding: 6px 10px; border-radius: 6px; font-weight: 500;
    }
    .copy-btn:hover { color: #ffffff; background: rgba(255,255,255,0.1); }
    .code-wrapper pre { background: transparent !important; margin: 0 !important; padding: 20px; overflow-x: auto; border-radius: 0; box-shadow: none; max-width: 100%; }
    .code-wrapper pre code { background: transparent; padding: 0; color: #e2e8f0; font-size: 14px; line-height: 1.6; font-family: 'SFMono-Regular', Consolas, monospace; word-break: normal; }

    .reasoning-box {
      font-size: 14px; color: var(--text-secondary); background: rgba(128,128,128,0.05);
      padding: 12px 16px; border-radius: 12px; border-left: 3px solid var(--brand-color);
      margin-bottom: 16px; white-space: pre-wrap; line-height: 1.6; max-height: 150px; overflow-y: auto;
      overflow-x: hidden; word-break: break-word; max-width: 100%;
    }
    .reasoning-box::-webkit-scrollbar { width: 4px; }
    .reasoning-box::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.3); border-radius: 4px; }

    .typing-indicator { display: inline-flex; gap: 6px; align-items: center; padding: 4px 2px; height: 24px; }
    .typing-dot { width: 6px; height: 6px; background: var(--brand-color); border-radius: 50%; animation: typing 1.4s infinite ease-in-out both; }
    .typing-dot:nth-child(1) { animation-delay: -0.32s; }
    .typing-dot:nth-child(2) { animation-delay: -0.16s; }
    @keyframes typing { 0%, 80%, 100% { transform: scale(0); opacity: 0.4; } 40% { transform: scale(1); opacity: 1; } }

    /* 输入框容器 */
    .input-wrapper { padding: 0 24px 32px; max-width: 900px; width: 100%; margin: 0 auto; position: relative; z-index: 10; box-sizing: border-box; }
    .input-box { 
      background: var(--input-bg); backdrop-filter: blur(24px); border: 1px solid var(--glass-border);
      border-radius: 24px; padding: 14px 18px; display: flex; flex-direction: column; gap: 8px; 
      box-shadow: 0 12px 40px rgba(0,0,0,0.06), 0 2px 10px rgba(0,0,0,0.02); transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); 
      width: 100%;
    }
    .input-box:focus-within { 
      border-color: var(--brand-color); 
      box-shadow: 0 12px 40px rgba(59, 130, 246, 0.12), 0 0 0 3px rgba(59, 130, 246, 0.1); 
      transform: translateY(-2px); 
    }
    
    .input-top { display: flex; align-items: flex-end; gap: 12px; }
    textarea { 
      flex: 1; background: transparent; border: none; color: var(--text-main); font-size: 16px; 
      line-height: 24px; max-height: 200px; min-height: 24px; resize: none; outline: none; 
      font-family: inherit; padding: 8px 0 8px 8px; font-weight: 400; width: 100%;
    }
    textarea::placeholder { color: var(--text-secondary); opacity: 0.6; }
    
    .send-btn { 
      width: 40px; height: 40px; border-radius: 20px; border: none; background: var(--hover-bg); 
      color: var(--text-secondary); display: flex; align-items: center; justify-content: center; 
      cursor: not-allowed; transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); flex-shrink: 0; margin-bottom: 2px; 
    }
    .send-btn.active { 
      background: var(--brand-gradient); color: #ffffff; cursor: pointer; 
      box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
    }
    .send-btn.active:hover { transform: scale(1.08); box-shadow: 0 6px 16px rgba(59, 130, 246, 0.4); }
    
    .input-bottom { display: flex; justify-content: space-between; align-items: center; height: 28px; padding-top: 4px; width: 100%; }
    
    .model-selector-container { 
      display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 12px; 
      cursor: pointer; transition: all 0.2s; position: relative; overflow: hidden;
      background: var(--hover-bg); border: 1px solid transparent; max-width: 100%;
    }
    .model-selector-container:hover { background: rgba(128,128,128,0.1); border-color: var(--glass-border); }
    .model-select { 
      position: absolute; top: 0; left: 0; width: 100%; height: 100%; opacity: 0; 
      cursor: pointer; border: none; outline: none; -webkit-appearance: none; appearance: none;
    }
    /* 限制长模型名称截断，防撑开 */
    .model-display-text { font-size: 13px; font-weight: 600; color: var(--text-secondary); pointer-events: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px; }
    
    .disclaimer { text-align: center; font-size: 12px; color: var(--text-secondary); opacity: 0.7; margin-top: 16px; font-weight: 500; }

    /* ========== 设置弹窗 CSS ========== */
    .settings-modal-overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000;
      backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
      display: none; align-items: center; justify-content: center;
      opacity: 0; transition: opacity 0.3s ease;
    }
    .settings-modal-overlay.active { display: flex; opacity: 1; }
    .settings-box {
      background: var(--glass-bg); border: 1px solid var(--glass-border);
      box-shadow: var(--glass-shadow), 0 20px 40px rgba(0,0,0,0.1); padding: 30px; border-radius: 24px;
      width: 360px; max-width: 90%; transform: scale(0.95) translateY(10px); transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .settings-modal-overlay.active .settings-box { transform: scale(1) translateY(0); }
    .settings-select {
      width: 100%; padding: 12px 16px; border-radius: 12px; border: 1px solid var(--glass-border);
      background: var(--input-bg); color: var(--text-main); font-size: 15px; outline: none;
      font-weight: 500; transition: all 0.2s; appearance: none;
      background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e");
      background-repeat: no-repeat; background-position: right 1rem center; background-size: 1em;
    }
    .settings-select:focus { border-color: var(--brand-color); box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1); }
    .settings-btn {
      background: var(--brand-gradient); color: #fff; border: none; padding: 10px 24px;
      border-radius: 12px; cursor: pointer; font-size: 15px; font-weight: 600; transition: all 0.2s;
      box-shadow: 0 4px 12px rgba(59, 130, 246, 0.2);
    }
    .settings-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(59, 130, 246, 0.3); }

    @media (min-width: 769px) {
      .app-container { padding: 24px; gap: 24px; align-items: center; justify-content: center; }
      .sidebar { position: relative; transform: translateX(0); border-radius: var(--border-radius); height: 100%; box-shadow: var(--glass-shadow); flex-shrink: 0; }
      .chat-area { border-radius: var(--border-radius); height: 100%; background: var(--glass-bg); backdrop-filter: blur(24px); border: 1px solid var(--glass-border); box-shadow: var(--glass-shadow); }
      .delete-btn { display: block; }
    }

    /* 移动端专属强制限制 */
    @media (max-width: 768px) {
      :root {
        --bg-base: #ffffff;
        --glass-bg: #ffffff;
        --glass-border: #e5e5e5;
        --glass-shadow: none;
        --input-bg: #f8fafc;
      }
      [data-theme="dark"] {
        --bg-base: #0f172a;
        --glass-bg: #0f172a;
        --glass-border: #334155;
        --input-bg: #1e293b;
      }

      body, html { background-color: var(--bg-base); }
      .app-container { display: flex; flex-direction: column; padding: 0; background: var(--bg-base); width: 100%; height: 100%; overflow: hidden; }
      .aurora-bg { display: none; }
      
      .sidebar { border-radius: 0; box-shadow: none; position: absolute; top: 0; left: 0; height: 100%; z-index: 100; border-right: 1px solid var(--glass-border); width: 280px; max-width: 85vw; transform: translateX(-100%); transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
      .sidebar.open { transform: translateX(0); }
      .new-chat-btn { background: var(--input-bg); }
      .session-item.active { background: var(--hover-bg); }
      .delete-btn { display: block; opacity: 1; color: var(--text-secondary); background: none; }
      
      .sidebar-overlay { backdrop-filter: none; -webkit-backdrop-filter: none; }
      .sidebar-overlay.active { display: block; opacity: 1; }
      
      .chat-area { background: transparent; border: none; box-shadow: none; border-radius: 0; width: 100%; overflow: hidden; }
      .header { border-bottom: 1px solid transparent; height: 60px; padding: 0 16px; justify-content: flex-start; }
      .header-title { display: none; }
      .menu-toggle { display: flex; }
      
      .messages-container { padding: 0; width: 100%; overflow-x: hidden; }
      .messages { padding: 24px 16px; gap: 32px; max-width: 100vw; width: 100%; overflow-x: hidden; box-sizing: border-box; }
      .message-row.user .message-bubble { border-radius: 22px 22px 4px 22px; max-width: 92%; }
      
      .input-wrapper { padding: 8px 16px 12px 16px; padding-bottom: max(16px, env(safe-area-inset-bottom)); width: 100%; max-width: 100vw; background: var(--bg-base); box-sizing: border-box; }
      .input-box { border: 1px solid var(--glass-border); box-shadow: 0 -4px 20px rgba(0,0,0,0.03); border-radius: 24px; padding: 12px 16px 16px 16px; gap: 12px; width: 100%; box-sizing: border-box; }
      .input-box:focus-within { transform: none; }
      
      .send-btn.active:hover { transform: none; }
      .input-bottom { min-height: 28px; }
      .disclaimer { margin-top: 12px; }
    }
  </style>
</head>
<body>

<div class="aurora-bg">
  <div class="aurora-blob blob-1"></div>
  <div class="aurora-blob blob-2"></div>
  <div class="aurora-blob blob-3"></div>
</div>
<div class="sidebar-overlay" id="sidebarOverlay"></div>

<!-- 设置弹窗 -->
<div class="settings-modal-overlay" id="settingsModal">
  <div class="settings-box">
    <h3 style="margin-top:0; font-size:20px; font-weight: 600; letter-spacing: -0.5px;">系统偏好设置</h3>
    <div style="margin-top: 20px;">
      <label style="font-size: 14px; font-weight: 500; color: var(--text-secondary); display: block; margin-bottom: 10px;">新对话默认模型</label>
      <select id="defaultModelSetting" class="settings-select">
        {{MODEL_OPTIONS}}
      </select>
    </div>
    <div style="margin-top: 32px; text-align: right;">
      <button id="closeSettingsBtn" class="settings-btn">保存并关闭</button>
    </div>
  </div>
</div>

<div class="app-container">
  <div class="sidebar" id="sidebar">
    <div class="sidebar-header">
      <button class="new-chat-btn" id="newChatBtn">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        发起新对话
      </button>
    </div>
    <div class="session-list" id="sessionList"></div>
    <div class="sidebar-footer">
      <div style="display: flex; gap: 10px;">
        <button class="theme-toggle" id="settingsToggle" title="系统设置">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
        </button>
        <button class="theme-toggle" id="themeToggle" title="切换主题">
          <svg id="themeIcon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
        </button>
      </div>
      <div style="font-size: 13px; color: var(--text-secondary); font-weight: 600;">Pro v5.0</div>
    </div>
  </div>

  <div class="chat-area">
    <div class="header">
      <div class="header-inner">
        <button class="menu-toggle" id="menuToggle">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
        </button>
        <div class="header-title">
          <div class="status-dot" id="statusDot"></div>
          <span id="headerTitle">AI 核心处理中枢</span>
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
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
          </button>
        </div>
        
        <div class="input-bottom">
          <div class="model-selector-container">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--brand-color)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
            <span class="model-display-text" id="modelDisplayText">加载中...</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity:0.6; pointer-events:none;"><polyline points="6 9 12 15 18 9"></polyline></svg>
            <select class="model-select" id="modelSelect">
              {{MODEL_OPTIONS}}
            </select>
          </div>
        </div>
      </div>
      <div class="disclaimer">AI 生成的内容可能不准确，请核实重要信息。</div>
    </div>
  </div>
</div>

<script>
  let isCurrentlyStreaming = false;

  const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
  const ESCAPE_REG = /[&<>]/g;
  const escapeHtml = str => str.replace(ESCAPE_REG, m => ESCAPE_MAP[m]);

  const renderer = new marked.Renderer();
  renderer.code = function(code, language) {
    const displayLang = language || 'text';
    const escapedCode = escapeHtml(code);
    
    let highlightedCode = escapedCode;
    if (!isCurrentlyStreaming && language && hljs.getLanguage(language)) {
      try {
        highlightedCode = hljs.highlight(code, { language }).value;
      } catch (e) {}
    } else if (!isCurrentlyStreaming) {
      try {
        highlightedCode = hljs.highlightAuto(code).value;
      } catch (e) {}
    }
    
    return \`
      <div class="code-wrapper">
        <div class="code-header">
          <span>\${displayLang}</span>
          <button class="copy-btn" data-code="\${encodeURIComponent(code)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            <span>复制代码</span>
          </button>
        </div>
        <pre><code class="hljs \${language || ''}">\${highlightedCode}</code></pre>
      </div>
    \`;
  };

  marked.setOptions({ breaks: true, renderer: renderer });

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
    this.style.height = Math.min(this.scrollHeight, 200) + 'px';
    sendBtn.classList.toggle('active', this.value.trim().length > 0);
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
      const selectedText = modelSelect.options[modelSelect.selectedIndex]?.text || 'AI 核心处理中枢';
      headerTitle.innerText = selectedText;
      if (modelDisplayText) modelDisplayText.innerText = selectedText;
    }
  }

  function createNewSession() {
    const newId = 'session_' + Date.now();
    const savedDefaultModel = localStorage.getItem('default_model');
    const fallbackModel = modelSelect.options.length > 0 ? modelSelect.options[0].value : "";
    const targetModel = savedDefaultModel || fallbackModel;

    sessions.unshift({ id: newId, title: '新对话', messages: [], model: targetModel });
    saveSessions();
    switchSession(newId);
    renderSessionList();
    if(window.innerWidth <= 768) sidebar.classList.remove('open');
  }

  function switchSession(id) {
    currentSessionId = id;
    const currentSession = sessions.find(s => s.id === id);
    if (currentSession && currentSession.model) {
      const exists = Array.from(modelSelect.options).some(opt => opt.value === currentSession.model);
      if (exists) {
        modelSelect.value = currentSession.model;
      } else {
        modelSelect.selectedIndex = 0;
        currentSession.model = modelSelect.value;
        saveSessions();
      }
    } else if (modelSelect.options.length > 0) {
      modelSelect.selectedIndex = 0;
    }
    updateHeaderDisplay();
    renderMessages();
    renderSessionList();
    if(window.innerWidth <= 768) { sidebar.classList.remove('open'); sidebarOverlay.classList.remove('active'); userInput.blur(); }
  }

  function onModelChange() {
    const currentSession = sessions.find(s => s.id === currentSessionId);
    if(currentSession) {
      currentSession.model = modelSelect.value;
      saveSessions();
    }
    updateHeaderDisplay();
  }
  modelSelect.addEventListener('change', onModelChange);
  modelSelect.addEventListener('input', onModelChange);

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
    sessionListDiv.replaceChildren();
    const fragment = document.createDocumentFragment();

    sessions.forEach(session => {
      const item = document.createElement('div');
      item.className = \`session-item \${session.id === currentSessionId ? 'active' : ''}\`;
      item.onclick = () => switchSession(session.id);
      
      const titleSpan = document.createElement('span'); 
      titleSpan.className = 'session-title'; 
      titleSpan.innerText = session.title;
      
      const delBtn = document.createElement('button'); 
      delBtn.className = 'delete-btn'; 
      delBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4h4v2"></path></svg>';
      delBtn.onclick = (e) => deleteSession(e, session.id);
      
      item.appendChild(titleSpan); 
      item.appendChild(delBtn); 
      fragment.appendChild(item);
    });

    sessionListDiv.appendChild(fragment);
  }

  function renderMessages() {
    messagesDiv.replaceChildren();
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
        isCurrentlyStreaming = false;
        bubble.innerHTML = '<div class="message-text markdown-body">' + marked.parse(content) + '</div>';
        bubble.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
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
    isCurrentlyStreaming = true;

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

      let isRenderPending = false;
      let lastRenderTime = 0;
      const cursorHtml = '<span style="display:inline-block; width:6px; height:18px; background:var(--brand-color); animation:typing 1s infinite; vertical-align:middle; margin-left:4px; border-radius:2px;"></span>';

      function scheduleUpdateUI(force = false) {
        const now = Date.now();
        if (!force && now - lastRenderTime < 60) return;
        if (isRenderPending) return;
        isRenderPending = true;
        
        requestAnimationFrame(() => {
          isRenderPending = false;
          lastRenderTime = Date.now();

          if (!isCurrentlyStreaming && !force) return;

          if (reasoningContent && rBox) {
            if (rBox.style.display === 'none') rBox.style.display = 'block';
            rBox.textContent = reasoningContent;
            rBox.scrollTop = rBox.scrollHeight;
          }

          if (aiContent || !reasoningContent) {
            tBox.innerHTML = marked.parse(aiContent) + (isCurrentlyStreaming ? cursorHtml : '');
          } else if (reasoningContent && !aiContent) {
            tBox.innerHTML = '<div style="color: var(--brand-color); font-size: 14px; font-weight: 500;">正在深度思考... ▍</div>';
          }

          const distanceToBottom = scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight;
          if (distanceToBottom < 120) {
            scrollArea.scrollTop = scrollArea.scrollHeight;
          }
        });
      }

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
                if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
                if (delta.content !== undefined && delta.content !== null) aiContent += delta.content; 
                scheduleUpdateUI();
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

      isCurrentlyStreaming = false;

      if (!reasoningContent && rBox) rBox.remove();
      
      tBox.innerHTML = marked.parse(aiContent);
      tBox.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
      scrollArea.scrollTop = scrollArea.scrollHeight;
      
      currentSession.messages.push({ role: 'assistant', content: aiContent }); 
      saveSessions();
      
    } catch (error) {
      isCurrentlyStreaming = false;
      if (aiContent || reasoningContent) {
        tBox.innerHTML = marked.parse(aiContent) + \`<br><br><span style="color: #ef4444; font-size: 13px; font-weight: 500;">(⚠️ 网络连接中断，已保留当前生成的内容。错误: \${error.message})</span>\`;
        tBox.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
        currentSession.messages.push({ role: 'assistant', content: aiContent });
        if (rBox && reasoningContent) rBox.remove(); 
      } else {
        bubble.querySelector('.message-text').innerText = '通信断开: ' + error.message; 
        bubble.parentElement.classList.add('error-msg');
        currentSession.messages.pop(); 
      }
      saveSessions();
    } finally {
      isCurrentlyStreaming = false;
      sendBtn.disabled = false; 
      statusDot.classList.remove('generating'); 
      if (userInput.value.trim().length > 0) sendBtn.classList.add('active'); 
      userInput.focus();
    }
  }

  // ========== 设置面板交互逻辑 ==========
  const settingsModal = document.getElementById('settingsModal');
  const settingsToggle = document.getElementById('settingsToggle');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');
  const defaultModelSetting = document.getElementById('defaultModelSetting');

  if (defaultModelSetting) {
    defaultModelSetting.value = localStorage.getItem('default_model') || (modelSelect.options.length > 0 ? modelSelect.options[0].value : "");
  }

  settingsToggle.addEventListener('click', () => {
    settingsModal.style.display = 'flex';
    setTimeout(() => settingsModal.classList.add('active'), 10); 
  });

  closeSettingsBtn.addEventListener('click', () => {
    settingsModal.classList.remove('active');
    if (defaultModelSetting.value) {
      localStorage.setItem('default_model', defaultModelSetting.value);
    }
    setTimeout(() => settingsModal.style.display = 'none', 300);
  });

  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettingsBtn.click();
  });

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
