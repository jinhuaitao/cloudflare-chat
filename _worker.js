// Cloudflare-Chat Worker 入口：只做路由分发，业务逻辑在 ./src/ 各模块中。

import { CORS_HEADERS, TEXT_HEADERS, HTML_HEADERS, SSE_HEADERS, PNG_HEADERS,
  MANIFEST_HEADERS, SW_HEADERS, HEALTH_HEADERS, APP_VERSION } from './src/constants.js';
import { denyUnauthorized } from './src/auth.js';
import { hitRateLimit } from './src/rate-limit.js';
import { getChannelConfig, buildAIRequest } from './src/channel.js';
import { readErrorBody } from './src/agent/stability.js';
import { handleWebAgent } from './src/web-agent.js';
import { handleKbList } from './src/kb/api.js';
import { handleTgWebhook } from './src/telegram/handler.js';
import { handleWxWebhook, handleWxApi, handleWxScheduled, maybeWakeWxDaemon } from './src/wechat/handler.js';
import { ICON_B64, getIconBytes } from './src/pwa/icons.js';
import { MANIFEST_JSON } from './src/pwa/manifest.js';
import { SW_JS } from './src/pwa/service-worker.js';
import { getPwaVersion } from './src/pwa/version.js';
import { HTML_CONTENT } from './src/ui/index.js';
import { sanitizeHistory } from './src/agent/history.js';

export { Coordination } from './src/coordination.js';

const CHAT_BODY_MAX_BYTES = 1000000;

async function readChatJson(request) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > CHAT_BODY_MAX_BYTES) {
    const error = new Error('请求体超过 1 MB 上限，请缩短历史或图片后重试');
    error.status = 413;
    throw error;
  }
  if (!request.body) throw new Error('无效的请求格式');
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > CHAT_BODY_MAX_BYTES) {
      try { await reader.cancel(); } catch (_) {}
      const error = new Error('请求体超过 1 MB 上限，请缩短历史或图片后重试');
      error.status = 413;
      throw error;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid body');
    return body;
  } catch (_) {
    const error = new Error('无效的请求格式');
    error.status = 400;
    throw error;
  }
}

function makeScriptNonce() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// 逗号分隔可多个）后，Access-Control-Allow-Origin 只回显名单内的 Origin，
// 名单外的跨站请求拿不到 CORS 头 —— 别的网站即使拿到了泄露的访问令牌，
// 也无法从浏览器直接调用 /api/chat。未配置时保持 *，与旧部署完全兼容。
// 在 fetch 顶层统一改写，覆盖包括 web-agent / auth 等所有子模块的响应。
async function routeRequest(request, env, ctx, scriptNonce = makeScriptNonce()) {
  // 顶层兜底：任何路由内未捕获的异常都以 JSON 500 返回，
  // 而不是让 Worker 直接崩成 Cloudflare 的 1101 错误页（前端无从显示原因）
  try {
    const url = new URL(request.url);

    // 可选域名所有权验证文件：支持通过环境变量 VERIFY_FILE_PATH / VERIFY_FILE_CONTENT 配置
    if (request.method === 'GET' && env && env.VERIFY_FILE_PATH && url.pathname === env.VERIFY_FILE_PATH) {
      return new Response(String(env.VERIFY_FILE_CONTENT || ''), { headers: TEXT_HEADERS });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // ================= PWA 路由 =================
    if (request.method === 'GET' && url.pathname === '/manifest.webmanifest') {
      return new Response(MANIFEST_JSON, { headers: MANIFEST_HEADERS });
    }

    if (request.method === 'GET' && url.pathname === '/sw.js') {
      return new Response(SW_JS.replaceAll('{{PWA_VERSION}}', getPwaVersion()), { headers: SW_HEADERS });
    }

    if (request.method === 'GET' && ICON_B64[url.pathname]) {
      const bytes = getIconBytes(url.pathname);
      if (bytes) return new Response(bytes, { headers: PNG_HEADERS });
    }

    // 健康探针：供前端与 Service Worker 判断服务端是否可达。
    // ⚠️ SW 中必须显式放行该路径且绝不缓存，否则探针会被缓存应答 →
    //    永远「探测成功」→ 自动重连逻辑形同虚设。
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return new Response(JSON.stringify({ ok: true, t: Date.now() }), { headers: HEALTH_HEADERS });
    }

    // 微信 ClawBot (iLink) Web 管理与扫码绑定接口（内部由 checkWxAdminAuth 强制校验 WX_ADMIN_SECRET 或 ACCESS_PASSWORD）
    // 微信守护进程唤醒：只在「用户真的在用」的入口触发（首页 / 微信管理接口 / 对话）。
    // 此前挂在所有路由之前，导致冷启动时请求一个静态图标或 /sw.js 也会打一次 R2
    // 去查轮询锁 —— 功能上无害，但把首页首屏和无关联的后台逻辑耦合在了一起。
    if (url.pathname === '/' || url.pathname === '/api/chat' || url.pathname.startsWith('/api/wx/')) {
      maybeWakeWxDaemon(request, env, ctx);
    }

    if (url.pathname.startsWith('/api/wx/')) {
      return await handleWxApi(request, env, url, ctx);
    }

    // 网页端「📚 知识库」只读清单（面板 UI 在 src/ui/app-kb.js）。
    // 只读：写入入口仍只在 Telegram / 微信 ClawBot，这里不提供任何写操作。
    // 与 /api/chat 共用同一套按 IP 限流：verify:true 每次要打一次 R2 list，
    // 不设限被刷起来是真实成本。
    if (request.method === 'GET' && url.pathname === '/api/kb/list') {
      if (hitRateLimit(request, env)) {
        return new Response(JSON.stringify({ ok: false, error: '请求过于频繁，请稍后再试', code: 'RATE_LIMITED' }), {
          status: 429, headers: CORS_HEADERS,
        });
      }
      return await handleKbList(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/chat') {
      const denied = denyUnauthorized(env, request);
      if (denied) return denied;

      if (hitRateLimit(request, env)) {
        return new Response(JSON.stringify({ error: "请求过于频繁，请稍后再试", code: "RATE_LIMITED" }), {
          status: 429, headers: CORS_HEADERS,
        });
      }

      try {
        const body = await readChatJson(request);
        const safeMessages = sanitizeHistory(body.messages);
        if (!safeMessages.length || safeMessages[safeMessages.length - 1].role !== 'user') {
          return new Response(JSON.stringify({ error: '消息历史为空或缺少最后的用户消息' }), { status: 400, headers: CORS_HEADERS });
        }
        body.messages = safeMessages;
        const aiConfig = buildAIRequest(env, body.model, safeMessages, body.agent !== true);
        if (aiConfig.error) {
          return new Response(JSON.stringify({ error: aiConfig.error }), { status: 500, headers: CORS_HEADERS });
        }

        const { apiUrl, currentApiKey, payload, isImageAPI } = aiConfig;

        // v6.6.0: Web 端 Agent 模式 —— 复用 Telegram 同一套 ReAct 循环 + 工具链，
        // 进度通过 SSE 事件推送。Web 端对知识库只读（kbReadOnly: true），优先检索知识库文档。
        if (body.agent === true && !isImageAPI) {
          return await handleWebAgent(env, body);
        }

        const keyPool = [currentApiKey, ...(aiConfig.channelKeys || [])]
          .filter((key, index, list) => list.indexOf(key) === index);
        let upstreamResponse = null;
        let upstreamError = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            upstreamResponse = await fetch(apiUrl, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${keyPool[attempt % keyPool.length]}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(60000),
            });
            upstreamError = null;
            if (upstreamResponse.ok || ![429, 502, 503, 504].includes(upstreamResponse.status) || attempt === 1) break;
            try { await upstreamResponse.body?.cancel(); } catch (_) {}
            upstreamResponse = null;
          } catch (error) {
            upstreamResponse = null;
            upstreamError = error;
          }
        }
        if (!upstreamResponse) {
          return new Response(JSON.stringify({
            error: '上游接口请求失败，已自动重试：' + (upstreamError?.message || '请稍后再试'),
          }), { status: 502, headers: CORS_HEADERS });
        }

        if (!upstreamResponse.ok) {
          // v6.8.7：错误正文限长读取 —— 上游偶发返回超大 HTML 错误页时不再整段读入
          const errText = await readErrorBody(upstreamResponse, 2048);
          return new Response(JSON.stringify({ error: `API 报错 (${upstreamResponse.status}):${errText}` }), {
            status: upstreamResponse.status,
            headers: CORS_HEADERS,
          });
        }

        if (!isImageAPI) {
          return new Response(upstreamResponse.body, { headers: SSE_HEADERS });
        } else {
          const responseData = await upstreamResponse.json();
          let imageUrlOrText = "图片生成失败或未返回格式";
          
          if (responseData.data && responseData.data[0]?.url) {
            imageUrlOrText = `![生成结果](${responseData.data[0].url})`;
          } else if (responseData.data && responseData.data[0]?.b64_json) {
            imageUrlOrText = `![生成结果](data:image/png;base64,${responseData.data[0].b64_json})`;
          } else if (responseData.choices && responseData.choices[0]?.message) {
            imageUrlOrText = responseData.choices[0]?.message.content;
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
        const status = Number.isInteger(error.status) ? error.status : 500;
        return new Response(JSON.stringify({ error: error.message }), { status, headers: CORS_HEADERS });
      }
    }

    if (request.method === 'GET' && url.pathname === '/') {
      const { models } = getChannelConfig(env);

      const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

      let optionsHtml = '';
      for (let i = 0; i < models.length; i++) {
        const item = models[i];
        let displayName = item.name;
        if (!item.original.includes(':')) {
          displayName = item.id.length > 24 ? item.id.substring(0, 22) + '...' : item.id;
        }
        // 同名模型来自不同通道时补主机名 —— 否则下拉框里会出现两个完全一样的选项
        if (item.channelHint) displayName += ' · ' + item.channelHint;
        optionsHtml += `<option value="${escHtml(item.key)}" ${i === 0 ? 'selected' : ''}>${escHtml(displayName)}</option>`;
      }

      if (models.length === 0) {
        optionsHtml = '<option value="" disabled selected>未配置模型，请检查环境变量</option>';
      }

      const html = HTML_CONTENT
        .replaceAll('{{MODEL_OPTIONS}}', optionsHtml)
        .replaceAll('{{APP_VERSION}}', APP_VERSION)
        .replace('<script>', `<script nonce="${scriptNonce}">`);
      return new Response(html, { headers: HTML_HEADERS });
    }

    // Telegram Bot Webhook：命令、Agent 对话与回复发送都在该模块内处理
    if (request.method === 'POST' && url.pathname === '/tg-webhook') {
      return await handleTgWebhook(request, env);
    }

    // 微信 ClawBot (iLink) Webhook：支持第三方 iLink 网关推送消息
    if ((request.method === 'POST' || request.method === 'GET') && url.pathname === '/wx-webhook') {
      return await handleWxWebhook(request, env, url, ctx);
    }

    return new Response('Not Found', { status: 404 });
  } catch (error) {
    return new Response(JSON.stringify({ error: error && error.message ? error.message : String(error) }), { status: 500, headers: CORS_HEADERS });
  }
}

export default {
  async fetch(request, env, ctx) {
    const scriptNonce = makeScriptNonce();
    const res = await routeRequest(request, env, ctx, scriptNonce);
    const h = new Headers(res.headers);
    if (env && env.CORS_ORIGIN && h.has('Access-Control-Allow-Origin')) {
      const allowed = String(env.CORS_ORIGIN).split(',').map(s => s.trim()).filter(Boolean);
      const origin = request.headers.get('Origin');
      if (origin && allowed.includes(origin)) {
        h.set('Access-Control-Allow-Origin', origin);
        h.set('Vary', 'Origin');
      } else {
        h.delete('Access-Control-Allow-Origin');
      }
    }
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('X-Frame-Options', 'DENY');
    h.set('Referrer-Policy', 'no-referrer');
    h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    if (new URL(request.url).protocol === 'https:') {
      h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    if ((h.get('Content-Type') || '').startsWith('text/html')) {
      h.set('Content-Security-Policy', [
        "default-src 'self'",
        `script-src 'self' 'nonce-${scriptNonce}' https://cdn.jsdelivr.net`,
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data: https:",
        "connect-src 'self'",
        "worker-src 'self'",
        "manifest-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '));
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  },

  // Cloudflare Cron Triggers：后台自动长轮询微信 ClawBot (iLink) 新消息并回复
  async scheduled(event, env, ctx) {
    await handleWxScheduled(event, env, ctx);
  },
};
