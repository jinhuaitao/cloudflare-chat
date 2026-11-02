// Web 端 Agent：与 Telegram 共用循环，进度与正文走 SSE（_worker.js 原第 1823-1897 行）

import { SSE_HEADERS } from './constants.js';
import { tgAgentChat } from './agent/loop.js';

// ==================== Web 端 Agent（v6.6.0，v6.9.3 只读权限分域） ====================
// 与 Telegram 共用 tgAgentChat（提供联网搜索、网页抓取、计算、天气、时间及知识库只读检索），
// Web 端对知识库只读（kbReadOnly: true），不暴露写入工具，也不再读取/产生 Web 会话记忆。
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
      // 保活心跳：每 15 秒发一个以 ':' 开头的 SSE 注释行
      const ka = setInterval(() => {
        try { controller.enqueue(encoder.encode(': keep-alive ' + Date.now() + '\n\n')); } catch (e) {}
      }, 15000);
      // v7.8.0：正文增量批量下发。
      // 旧版每个 token 都单独 enqueue 一个 SSE 事件，2000 字回答就是 2000 个包 + 2000 次
      // JSON.stringify / UTF-8 编码 / 浏览器解析，手机端会明显掉帧。
      // 现在按「160 字符 或 60ms」聚合，首字仍然立即发出，后续合批推送，前端观感不变但开销降一个量级。
      let bufContent = '';
      let bufReasoning = '';
      let lastFlushAt = 0;
      let sentAnyDelta = false;
      const flushDelta = (force) => {
        if (!bufContent && !bufReasoning) return;
        const now = Date.now();
        const size = bufContent.length + bufReasoning.length;
        if (!force && sentAnyDelta && size < 160 && now - lastFlushAt < 60) return;
        if (bufReasoning) { send({ choices: [{ delta: { reasoning_content: bufReasoning } }] }); bufReasoning = ''; }
        if (bufContent) { send({ choices: [{ delta: { content: bufContent } }] }); bufContent = ''; }
        lastFlushAt = now;
        sentAnyDelta = true;
      };
      const webOpts = {
        maxRuntimeMs: webBudgetMs,
        // v6.9.3：Web 端对知识库只读——写入（remember / save_doc / delete_doc）
        // 仅 Telegram / 微信端开放，Web 访客无法污染全局知识库
        kbReadOnly: true,
        onDelta: async (text, kind) => {
          if (kind === 'reasoning') bufReasoning += text;
          else bufContent += text;
          flushDelta(false);
        },
        onReset: async () => { bufContent = ''; bufReasoning = ''; send({ agent_reset: true }); }
      };
      try {
        const onProgress = async (text) => { send({ agent_progress: String(text).slice(0, 500) }); };
        let r = await tgAgentChat(env, noOpTgApi, webChatId, targetModelId, history, true, onProgress, webOpts);
        if (r.fallback) r = await tgAgentChat(env, noOpTgApi, webChatId, targetModelId, history, false, onProgress, webOpts);
        if (r.error) {
          send({ agent_error: r.error });
        } else if (r.paused && r.text) {
          // v7.5.0：网页端没有「继续」指令，把机器人端的断点续做提示换成网页端可执行的说法，
          // 否则用户会照着"发送「继续」"在输入框里发一句"继续"，却什么都不会发生。
          const t = String(r.text)
            .replace(/⏸️ 任务较长，已暂停并保存进度，发送「继续」让我接着做。/, '⏸️ 这一步比较费时，已到网页端单轮时间上限。以下是已经查到的部分：')
            .replace(/⏸️ 推理步数已用尽，进度已保存，发送「继续」让我接着做。/, '⏸️ 推理步数已用尽。以下是已经查到的部分：');
          for (let i = 0; i < t.length; i += 2000) {
            send({ choices: [{ delta: { content: t.slice(i, i + 2000) } }] });
          }
          send({ choices: [{ delta: { content: '\n\n> 网页端不支持断点续做，可以把问题拆小一些，或补充更具体的范围后重问。' } }] });
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
        // 把最后不足一批的残留推完，否则回答结尾会少几个字
        try { flushDelta(true); } catch (e) {}
      }
      done();
    }
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

export {
  handleWebAgent,
};
