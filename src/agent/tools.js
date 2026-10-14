// Agent 工具定义与分发（_worker.js 原第 323-485 行）

import { toolWebSearch, toolWebFetch } from './tools-web.js';
import { toolCalculate, toolGetTime, toolGetWeather } from './tools-local.js';
import { agentSaveMemory } from './memory.js';
import { toolSaveDoc, toolListDocs, toolReadDoc, toolDeleteDoc } from '../kb/doc-tools.js';

// ==================== Telegram Agent：工具定义 ====================
// 全部工具零密钥、零成本：DuckDuckGo（搜索）、任意网页抓取、自研计算器、
// Open-Meteo（天气）、Intl（时间）、R2（长期记忆）、R2（知识库文档存取）。
function getAgentTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: '联网搜索最新信息。仅在需要时效性内容（实时新闻、价格、股价、赛事结果等）或问题超出你知识范围时使用；稳定的常识性知识不要搜，直接回答。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
            count: { type: 'integer', description: '返回条数，1-8，默认5' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: '抓取指定网页的正文纯文本，用于总结文章、阅读文档页面（返回清理后的文本，可能截断）。只对搜索结果中或用户明确给出的 URL 使用，不要猜测/编造 URL。',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: '完整的 http(s) URL' } },
          required: ['url']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'calculate',
        description: '精确数学计算，支持加减乘除、乘方(^)、取余(%)、括号。任何需要数字运算的场景（哪怕看起来简单）都用它，不要心算。',
        parameters: {
          type: 'object',
          properties: { expression: { type: 'string', description: '如 (3+5)*2^3/4' } },
          required: ['expression']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_time',
        description: '获取当前时间，可指定 IANA 时区。用户问"现在几点/今天周几/日期"之类时使用，不要凭记忆回答时间。',
        parameters: {
          type: 'object',
          properties: { timezone: { type: 'string', description: '如 Asia/Shanghai，默认 Asia/Shanghai' } }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: '查询指定城市当前天气与今明两天预报。city 必须给明确城市名（如"北京"、"Tokyo"）；用户没说城市时先追问，不要猜。',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string', description: '城市名，如"北京"、"Tokyo"' } },
          required: ['city']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'remember',
        description: '把关于用户的重要长期信息存入记忆（如偏好、生日、项目名、常用城市），存入后以后所有对话都会记得。仅在用户明确要求记住（"记住…"）时调用，不要把临时对话内容存进去。',
        parameters: {
          type: 'object',
          properties: { fact: { type: 'string', description: '一句话事实' } },
          required: ['fact']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'save_doc',
        description: '把长篇内容保存为知识库文档，真实写入 R2 的 kb/docs/ 文件夹（文件名取自标题）。仅在用户明确要求保存文档（"保存成文档/存到知识库/生成知识库文件"）时调用；简短的个人信息用 remember，不要用它；不要主动为普通回答生成文档。只有本工具返回成功，才可以告诉用户"已保存/已生成"；失败或没调用时绝不声称已保存。',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '文档标题，用作文件名，如"甲骨文云ARM放货知识库"' },
            content: { type: 'string', description: 'Markdown 格式的正文' },
            source: { type: 'string', description: '可选：原文链接，会记入文件头' }
          },
          required: ['title', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_docs',
        description: '列出知识库文档（R2 kb/docs/ 下所有文档的标题）。用户问题可能涉及之前保存的文档主题时，先调用它确认有没有相关文档；有则用 read_doc 细读。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_doc',
        description: '按标题关键词读取一篇知识库文档的全文（超 8000 字截断并标注）。query 给标题或关键词，模糊匹配；标题想不起来时会自动改搜正文并返回关键词附近片段；找不到时会返回现有标题列表。读到相关内容后优先引用，并注明"据知识库文档《xxx》"。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '文档标题或关键词，如"甲骨文ARM"' } },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'delete_doc',
        description: '删除一篇知识库文档（R2 kb/docs/）。仅在用户明确要求删除文档时调用；query 给标题或关键词模糊匹配，找不到会返回现有标题列表。删除不可逆，调用前确保用户意图明确。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '文档标题或关键词' } },
          required: ['query']
        }
      }
    }
  ];
}

async function execAgentTool(name, args, env, chatId) {
  // 兜底超时：单个工具最长执行时间，防止 abort 信号无法中断 hung 住的请求体
  // （如永不结束的流式响应）。可通过 AGENT_TOOL_TIMEOUT_MS 调整，默认 30 秒。
  let toolTimeoutMs = parseInt(env.AGENT_TOOL_TIMEOUT_MS || '30000', 10);
  if (!(toolTimeoutMs > 0)) toolTimeoutMs = 30000;
  let timer;
  try {
    const run = (async () => {
      switch (name) {
        case 'web_search': return await toolWebSearch(args.query, args.count);
        case 'web_fetch': return await toolWebFetch(args.url);
        case 'calculate': return toolCalculate(args.expression);
        case 'get_time': return toolGetTime(args.timezone);
        case 'get_weather': return await toolGetWeather(args.city);
        case 'remember': return await agentSaveMemory(env, chatId, args.fact);
        case 'save_doc': return await toolSaveDoc(env, chatId, args);
        case 'list_docs': return await toolListDocs(env);
        case 'read_doc': return await toolReadDoc(env, args);
        case 'delete_doc': return await toolDeleteDoc(env, args);
        default: return '未知工具: ' + name;
      }
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('__TOOL_TIMEOUT__')), toolTimeoutMs);
    });
    return await Promise.race([run, timeout]);
  } catch (e) {
    if (e && e.message === '__TOOL_TIMEOUT__') return '工具 ' + name + ' 执行超时（' + Math.round(toolTimeoutMs / 1000) + ' 秒），已跳过';
    return '工具执行失败: ' + (e && e.message ? e.message : String(e));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export {
  getAgentTools,
  execAgentTool,
};
