// Cloudflare-Chat Worker 入口：只做路由分发，业务逻辑在 ./src/ 各模块中。

import { CORS_HEADERS, TEXT_HEADERS, HTML_HEADERS, SSE_HEADERS, PNG_HEADERS,
  MANIFEST_HEADERS, SW_HEADERS, HEALTH_HEADERS, APP_VERSION } from './src/constants.js';
import { denyUnauthorized } from './src/auth.js';
import { hitRateLimit } from './src/rate-limit.js';
import { getChannelConfig, buildAIRequest } from './src/channel.js';
import { readErrorBody } from './src/agent/stability.js';
import { handleWebAgent } from './src/web-agent.js';
import { handleTgWebhook } from './src/telegram/handler.js';
import { handleWxWebhook, handleWxApi, handleWxScheduled, maybeWakeWxDaemon } from './src/wechat/handler.js';
import { ICON_B64, getIconBytes } from './src/pwa/icons.js';
import { MANIFEST_JSON } from './src/pwa/manifest.js';
import { SW_JS } from './src/pwa/service-worker.js';
import { getPwaVersion } from './src/pwa/version.js';
import { HTML_CONTENT } from './src/ui/index.js';
import { kbGetRegistry, kbTakeRepairCount } from './src/kb/registry.js';

// 逗号分隔可多个）后，Access-Control-Allow-Origin 只回显名单内的 Origin，
// 名单外的跨站请求拿不到 CORS 头 —— 别的网站即使拿到了泄露的访问令牌，
// 也无法从浏览器直接调用 /api/chat。未配置时保持 *，与旧部署完全兼容。
// 在 fetch 顶层统一改写，覆盖包括 web-agent / auth 等所有子模块的响应。
async function routeRequest(request, env, ctx) {
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
    if (url.pathname !== '/wx-webhook') {
      maybeWakeWxDaemon(request, env, ctx);
    }

    if (url.pathname.startsWith('/api/wx/')) {
      return await handleWxApi(request, env, url, ctx);
    }

    // 知识库只读清单：供网页端「📚 知识库」面板核对文档是否真的入库。
    // 只返回标题/大小/时间/标签等元数据，不返回正文，也不提供任何写入能力 ——
    // 网页端仍然是只读的，保存与删除只在 Telegram / 微信 ClawBot 端开放。
    // verify:true 会顺便把索引与实际文件核对一遍，所以「正文在、列表没有」的
    // 历史遗留条目在这里就会被自动修好并如实回报补回了几篇。
    if (request.method === 'GET' && url.pathname === '/api/kb/list') {
      const denied = denyUnauthorized(env, request);
      if (denied) return denied;
      try {
        const reg = await kbGetRegistry(env, { verify: true });
        const repaired = kbTakeRepairCount();
        const docs = reg.slice().sort((a, b) => {
          const ta = Date.parse((a && a.updated_at) || '') || 0;
          const tb = Date.parse((b && b.updated_at) || '') || 0;
          return tb - ta;
        }).slice(0, 200).map(e => ({
          title: (e && (e.title || e.file)) || '(未命名)',
          file: (e && e.file) || '',
          size: (e && e.size) || 0,
          chars: (e && typeof e.chars === 'number') ? e.chars : 0,
          tags: (e && Array.isArray(e.tags)) ? e.tags : [],
          source: (e && e.source) || '',
          updated_at: (e && e.updated_at) || ''
        }));
        return new Response(JSON.stringify({
          ok: true,
          r2Bound: !!env.R2,
          count: reg.length,
          repaired: repaired,
          docs: docs
        }), { headers: CORS_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }), {
          status: 500, headers: CORS_HEADERS
        });
      }
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
        let body;
        try {
          body = await request.json();
        } catch (e) {
          return new Response(JSON.stringify({ error: "无效的请求格式" }), { status: 400, headers: CORS_HEADERS });
        }

        // v7.9.0：messages 缺失时不要直接把 undefined 传下去 —— buildAIRequest 内部会读
        // messagesArray.length，抛 TypeError 后被顶层 catch 变成含义不明的 500
        const safeMessages = Array.isArray(body.messages) ? body.messages : [];
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

        const upstreamResponse = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${currentApiKey}`, 
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload)
        });

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
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: CORS_HEADERS });
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
        optionsHtml += `<option value="${escHtml(item.id)}" ${i === 0 ? 'selected' : ''}>${escHtml(displayName)}</option>`;
      }

      if (models.length === 0) {
        optionsHtml = '<option value="" disabled selected>未配置模型，请检查环境变量</option>';
      }

      const html = HTML_CONTENT.replaceAll('{{MODEL_OPTIONS}}', optionsHtml).replaceAll('{{APP_VERSION}}', APP_VERSION);
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
    const res = await routeRequest(request, env, ctx);
    if (!env || !env.CORS_ORIGIN) return res;
    if (!res.headers.has('Access-Control-Allow-Origin')) return res;
    const allowed = String(env.CORS_ORIGIN).split(',').map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin');
    const h = new Headers(res.headers);
    if (origin && allowed.includes(origin)) {
      h.set('Access-Control-Allow-Origin', origin);
      h.set('Vary', 'Origin');
    } else {
      h.delete('Access-Control-Allow-Origin');
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  },

  // Cloudflare Cron Triggers：后台自动长轮询微信 ClawBot (iLink) 新消息并回复
  async scheduled(event, env, ctx) {
    await handleWxScheduled(event, env, ctx);
  },
};
