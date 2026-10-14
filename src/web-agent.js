// Web 端 Agent：与 Telegram 共用循环，进度与正文走 SSE（_worker.js 原第 1823-1897 行）

import { SSE_HEADERS } from './constants.js';
import { tgAgentChat, tgAgentResume } from './agent/loop.js';

// ==================== Web 端 Agent（v6.6.0） ====================
// 与 Telegram 共用 tgAgentChat（含 9 个零密钥工具 + 长期记忆），
// 记忆命名空间为 web_<sessionId>，与 Telegram 完全隔离。
// 进度通过 SSE 自定义事件推送：{"agent_progress": "..."} / {"agent_error": "..."}，
// 正文走标准 OpenAI delta 事件，最后 data: [DONE] 结束。
async function handleWebAgent(env, body) {
  const sid = String(body.session_id || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'default';
  const webChatId = 'web_' + sid;
  const history = Array.isArray(body.messages) ? body.messages : [];
  const targetModelId = body.model;
  const encoder = new TextEncoder();
  // Web 无 Telegram 上下文：typing 心跳直接 no-op
  const noOpTgApi = () => Promise.resolve({ ok: true });

  // Web 单轮预算：浏览器是长连接，不需要 Telegram 那套 55 秒妥协，但沿用
  // AGENT_TIMEOUT_MS 的 240 秒默认值会让用户对着"思考中"干等 4 分钟。
  // 90 秒足以覆盖绝大多数问题，超时立刻给明确结论。可用 WEB_AGENT_TIMEOUT_MS 覆盖。
  let webBudgetMs = parseInt(env.WEB_AGENT_TIMEOUT_MS || '90000', 10);
  if (!(webBudgetMs >= 10000)) webBudgetMs = 90000;
  if (webBudgetMs > 240000) webBudgetMs = 240000;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => {
        try { controller.enqueue(encoder.encode('data: ' + JSON.stringify(obj) + '\n\n')); } catch (e) {}
      };
      const done = () => {
        try { controller.enqueue(encoder.encode('data: [DONE]\n\n')); } catch (e) {}
        try { controller.close(); } catch (e) {}
      };
      // 保活心跳：Agent 单步等上游可能长达一两分钟，期间零字节的连接会被浏览器 /
      // 中间层判为空闲并掐断；掐断后前端拿不到 [DONE]，就会落到"连接意外中断"。
      // 每 15 秒发一个以 ':' 开头的 SSE 注释行 —— 按 SSE 规范客户端会忽略，
      // 前端也只解析 'data:' 开头的行，因此不会污染正文。
      const ka = setInterval(() => {
        try { controller.enqueue(encoder.encode(': keep-alive ' + Date.now() + '\n\n')); } catch (e) {}
      }, 15000);
      // 真流式接线：上游的正文 / 推理增量直接以标准 OpenAI delta 事件转发出去，
      // 前端本来就在按这个格式解析，所以逐字渲染零改动即可生效。
      // agent_reset 用于撤回被判定为"工具调用开场白"或 DSML 标记的中间文本。
      const webOpts = {
        maxRuntimeMs: webBudgetMs,
        onDelta: async (text, kind) => {
          if (kind === 'reasoning') send({ choices: [{ delta: { reasoning_content: text } }] });
          else send({ choices: [{ delta: { content: text } }] });
        },
        onReset: async () => { send({ agent_reset: true }); }
      };
      try {
        const onProgress = async (text) => { send({ agent_progress: String(text).slice(0, 500) }); };
        let r = await tgAgentChat(env, noOpTgApi, webChatId, targetModelId, history, true, onProgress, webOpts);
        if (r.fallback) r = await tgAgentChat(env, noOpTgApi, webChatId, targetModelId, history, false, onProgress, webOpts);
        if (r.error) {
          send({ agent_error: r.error });
        } else if (r.streamed) {
          // 正文已经在流式过程中逐字推完了，这里什么都不用补，直接收尾
        } else if (r.text) {
          const t = r.text;
          for (let i = 0; i < t.length; i += 2000) {
            send({ choices: [{ delta: { content: t.slice(i, i + 2000) } }] });
          }
        } else {
          send({ agent_error: 'AI 没有返回有效内容' });
        }
      } catch (e) {
        send({ agent_error: '⚠️ Agent 执行出错：' + (e && e.message ? e.message : String(e)) });
      } finally {
        clearInterval(ka);
      }
      done();
    }
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

export {
  handleWebAgent,
};
