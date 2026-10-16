// Agent 工具定义与分发（v7.2.0 高效精简 Schema + 批量执行 + 动态按需裁剪）

import { toolWebSearch, toolWebFetch } from './tools-web.js';
import {
  toolCalculate, toolGetTime, toolGetWeather, toolExchangeRate, toolWikiLookup,
  toolGithubLookup, toolArxivSearch, toolHnTop, toolNetLookup, toolToolkit
} from './tools-local.js';
import { agentSaveMemory, agentForgetMemory } from './memory.js';
import { toolSaveDoc, toolListDocs, toolReadDoc, toolDeleteDoc } from '../kb/doc-tools.js';

// ==================== Agent 工具定义 ====================
// v7.2.0 性能优化：
// 1) 精简高信息密度 Schema 描述，减少每步约 30% 的工具定义 Token 消耗，显著降低模型首字延迟（TTFT）；
// 2) 支持批量参数（多 URL 抓取、多城市天气、多币种汇率、多表达式计算、搜索自带前 2 条网页正文预读 deep_read），
//    让原本需要 2~4 步循环的任务在 1 步内直接完成；
// 3) 支持传入 opts.hasKbDocs，当只读端确认知识库为空时可动态省略知识库读取工具。
function getAgentTools(kbReadOnly, opts) {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: '联网搜索实时信息（默认自动并发预读前2条结果正文速览，一步完成搜索+阅读）。稳定常识勿搜。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
            count: { type: 'integer', description: '条数 1-8，默认 5' },
            deep_read: { type: 'boolean', description: '可选：是否并发预读前2条网页正文摘要（默认 true）' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: '抓取网页结构化正文（单次最多6000字符；长文可传 offset 零延迟翻页；支持逗号分隔最多3个URL并发对比抓取）。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'http(s) URL（支持逗号分隔最多3个URL批量抓取）' },
            offset: { type: 'integer', description: '可选：起始字符偏移量（默认0），用于翻页续读' }
          },
          required: ['url']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'wiki_lookup',
        description: '查询中英维基百科（Wikipedia）权威词条定义与摘要。查概念、人物、历史背景时优先使用。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '词条名或关键词' },
            lang: { type: 'string', description: '可选：zh 或 en' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'github_lookup',
        description: '查询 GitHub 仓库详情（传 "owner/repo" 一次并发获取 Star、Release 与 README）或按关键词搜索热门开源项目。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'owner/repo 或搜索关键词' },
            mode: { type: 'string', description: '可选：repo 或 search' },
            sort: { type: 'string', description: '可选：stars 或 updated' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'arxiv_search',
        description: '检索 arXiv 学术论文（AI/CS/数学/物理），返回标题、作者、日期、摘要与 PDF 链接。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '英文检索词或论文标题' },
            count: { type: 'integer', description: '返回篇数 1-6，默认 4' },
            sort: { type: 'string', description: '可选：relevance 或 date' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'hn_top',
        description: '获取 Hacker News 实时首页科技热榜（不传 query）或按关键词搜索技术社区高赞讨论。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '可选：搜索关键词（留空返回首页热榜）' },
            count: { type: 'integer', description: '条数 1-10，默认 6' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'exchange_rate',
        description: '实时法币汇率换算与主流加密货币（BTC/ETH/SOL等）行情。支持逗号分隔多币种一次并发换算（如 from="USD,JPY,BTC"）。',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string', description: '源货币代码（支持逗号分隔多个，如 "USD,JPY,BTC"）' },
            to: { type: 'string', description: '目标货币代码，默认 CNY' },
            amount: { type: 'number', description: '金额，默认 1' }
          },
          required: ['from']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'net_lookup',
        description: '网络诊断：Cloudflare DoH 域名 DNS 解析（A/AAAA/CNAME/MX/TXT/NS）或公网 IP 归属地与 ASN 查询。',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: '域名或公网 IP' },
            type: { type: 'string', description: '可选：A/AAAA/CNAME/MX/TXT/NS 或 IP' }
          },
          required: ['target']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'calculate',
        description: '精确科学计算器（支持四则、^、%、pi、e 及 sqrt/cbrt/abs/round/floor/ceil/sin/cos/tan/ln/log/exp/pow/min/max/sum/avg；支持用分号 ; 分隔多条表达式一次批量计算）。',
        parameters: {
          type: 'object',
          properties: {
            expression: { type: 'string', description: '数学表达式（多条用 ; 分隔）' }
          },
          required: ['expression']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'toolkit',
        description: '确定性工具箱：unit_convert（长度/重量含斤两/温度C-F-K/面积含亩坪/体积/速度/存储容量/油耗MPG与L100km）| hash（SHA-256/512/1）| base64_encode/decode | url_encode/decode | uuid | text_stats（字数/字节/Token统计）。',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              description: 'unit_convert | hash | base64_encode | base64_decode | url_encode | url_decode | uuid | text_stats'
            },
            input: { type: 'string', description: '输入文本' },
            value: { type: 'number', description: '数值（unit_convert 数值或 uuid 个数）' },
            from_unit: { type: 'string', description: '源单位（如 km, lb, f, mpg, gib, 亩, 斤）' },
            to_unit: { type: 'string', description: '目标单位（如 mi, kg, c, l100km, gb, m2）' },
            algorithm: { type: 'string', description: '可选：SHA-256(默认)/SHA-384/SHA-512/SHA-1' }
          },
          required: ['action']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_time',
        description: '获取当前时间（含 Unix 时间戳）及精确日期推算：两日期相差天数/周数（target_date）或加减 N 天后的日期（add_days）。',
        parameters: {
          type: 'object',
          properties: {
            timezone: { type: 'string', description: 'IANA 时区，默认 Asia/Shanghai' },
            base_date: { type: 'string', description: '可选：基准日期 YYYY-MM-DD' },
            target_date: { type: 'string', description: '可选：目标日期 YYYY-MM-DD' },
            add_days: { type: 'integer', description: '可选：加减天数（正负整数）' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: '查询城市当前天气与未来三天预报（支持逗号分隔多城市一次并发查询，如 "北京,上海,Tokyo"）。',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: '城市名（支持逗号分隔多个城市）' }
          },
          required: ['city']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'remember',
        description: '保存关于用户的长期事实到 R2（仅用户明确要求记住时调用；同主题改口自动覆盖旧值）。',
        parameters: {
          type: 'object',
          properties: {
            fact: { type: 'string', description: '一句话事实' }
          },
          required: ['fact']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'forget_memory',
        description: '按关键词删除已保存的用户长期记忆（仅用户明确要求忘掉/删除时调用）。',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '要删除的记忆关键词' }
          },
          required: ['keyword']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'save_doc',
        description: '把长篇内容保存为 R2 知识库文档（仅用户明确要求保存成文档/存入知识库时调用）。',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '文档标题' },
            content: { type: 'string', description: 'Markdown 正文' },
            source: { type: 'string', description: '可选：原文链接' }
          },
          required: ['title', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_docs',
        description: '列出知识库所有文档标题。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_doc',
        description: '按标题或关键词读取知识库文档（单次8000字，支持 offset 零延迟翻页；标题未命中时自动多关键词检索全库正文）。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '文档标题或多关键词' },
            offset: { type: 'integer', description: '可选：字符偏移量（默认0）' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'delete_doc',
        description: '删除一篇知识库文档（仅用户明确要求删除文档时调用）。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '文档标题或关键词' }
          },
          required: ['query']
        }
      }
    }
  ];
  let filtered = tools;
  if (kbReadOnly) {
    const writes = ['remember', 'forget_memory', 'save_doc', 'delete_doc'];
    filtered = filtered.filter(t => writes.indexOf(t.function.name) === -1);
  }
  if (opts && opts.hasKbDocs === false) {
    filtered = filtered.filter(t => t.function.name !== 'list_docs' && t.function.name !== 'read_doc');
  }
  return filtered;
}

async function execAgentTool(name, args, env, chatId, kbReadOnly) {
  args = args || {};
  if (kbReadOnly && (name === 'remember' || name === 'forget_memory' || name === 'save_doc' || name === 'delete_doc')) {
    return '工具 ' + name + ' 在本端不可用：知识库为只读，写入与删除（记忆 / 文档保存与删除）仅 Telegram 端支持。请如实告知用户，并引导其通过 Telegram 机器人完成该操作；不要声称已完成。';
  }
  let toolTimeoutMs = parseInt(env.AGENT_TOOL_TIMEOUT_MS || '30000', 10);
  if (!(toolTimeoutMs > 0)) toolTimeoutMs = 30000;
  let timer;
  try {
    const run = (async () => {
      switch (name) {
        case 'web_search': return await toolWebSearch(args.query, args.count, args.deep_read);
        case 'web_fetch': return await toolWebFetch(args.url, args.offset);
        case 'wiki_lookup': return await toolWikiLookup(args.query, args.lang);
        case 'github_lookup': return await toolGithubLookup(args);
        case 'arxiv_search': return await toolArxivSearch(args);
        case 'hn_top': return await toolHnTop(args);
        case 'exchange_rate': return await toolExchangeRate(args);
        case 'net_lookup': return await toolNetLookup(args);
        case 'calculate': return toolCalculate(args.expression);
        case 'toolkit': return await toolToolkit(args);
        case 'get_time': return toolGetTime(args.timezone, args);
        case 'get_weather': return await toolGetWeather(args.city);
        case 'remember': return await agentSaveMemory(env, chatId, args.fact);
        case 'forget_memory': {
          const kw = String(args.keyword || '').trim();
          if (!kw) return '关键词为空，未删除任何记忆';
          const rr = await agentForgetMemory(env, chatId, kw);
          if (rr.persistError) return rr.persistError;
          return rr.removed > 0
            ? '已删除 ' + rr.removed + ' 条包含「' + kw + '」的长期记忆'
            : '未找到包含「' + kw + '」的长期记忆';
        }
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
