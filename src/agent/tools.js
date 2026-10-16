// Agent 工具定义与分发（v7.1.0 全套无配置增强：共 18 个零密钥工具）

import { toolWebSearch, toolWebFetch } from './tools-web.js';
import {
  toolCalculate, toolGetTime, toolGetWeather, toolExchangeRate, toolWikiLookup,
  toolGithubLookup, toolArxivSearch, toolHnTop, toolNetLookup, toolToolkit
} from './tools-local.js';
import { agentSaveMemory, agentForgetMemory } from './memory.js';
import { toolSaveDoc, toolListDocs, toolReadDoc, toolDeleteDoc } from '../kb/doc-tools.js';

// ==================== Agent 工具定义 ====================
// 全部工具零密钥、零成本（共 18 项）：
//   - 通用信息与计算：web_search（DuckDuckGo）、web_fetch（结构化正文 + 内存缓存 0ms 分页 + Jina 回退）、
//     wiki_lookup（中英维基百科词条）、github_lookup（GitHub 仓库/Release/README 检索）、
//     arxiv_search（arXiv 学术论文检索）、hn_top（Hacker News 科技热榜与技术讨论）、
//     exchange_rate（实时法币汇率 + 主流加密币价）、net_lookup（Cloudflare DoH DNS 解析 & IP 归属诊断）、
//     calculate（科学计算器）、toolkit（全能单位换算/SHA哈希/Base64/URL编解码/UUID/字数与Token精确统计）、
//     get_time（当前时间 + 日期差/加减推算）、get_weather（Open-Meteo）
//   - 知识库读取（两端可用）：list_docs、read_doc（支持 L1 内存缓存 offset 分页与多关键词全文相关性检索）
//   - 知识库与长期记忆写入（仅 Telegram 端可用，Web 端 kbReadOnly 自动过滤并硬拦截）：
//     remember、forget_memory、save_doc、delete_doc
function getAgentTools(kbReadOnly) {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: '联网搜索最新信息。仅在需要时效性内容（实时新闻、近期事件、赛事结果等）或问题超出你知识范围时使用；稳定的常识性知识不要搜，直接回答。',
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
        description: '抓取指定网页的结构化正文（保留标题、链接、代码块、表格与列表，单次最多返回 6000 字符；长网页可传 offset 零延迟翻页续读）。只对搜索结果中或用户明确给出的 URL 使用，不要猜测/编造 URL。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '完整的 http(s) URL' },
            offset: { type: 'integer', description: '可选：起始字符偏移量（默认 0），用于长网页翻页续读' }
          },
          required: ['url']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'wiki_lookup',
        description: '查询维基百科（Wikipedia）权威词条摘要与相关条目，自动识别中英文。查人物、历史事件、科学概念、地理或专有名词的定义与背景时优先使用，比通用网页搜索更准确且无广告噪音。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '词条名称或搜索关键词，如"量子纠缠"、"Alan Turing"' },
            lang: { type: 'string', description: '可选：语言代码 zh 或 en，默认按关键词自动识别' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'github_lookup',
        description: '查询 GitHub 开源仓库、热门项目、最新 Release 版本或仓库 README 摘要。query 传入 "owner/repo"（如 "cloudflare/workers-sdk"）可直接获取仓库详情、Star 数、最新发版与 README；传入普通关键词则搜索热门开源项目。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '仓库全名（owner/repo）或搜索关键词' },
            mode: { type: 'string', description: '可选：repo（查指定仓库）或 search（搜仓库），默认自动识别' },
            sort: { type: 'string', description: '可选：搜索排序 stars（默认）或 updated' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'arxiv_search',
        description: '检索 arXiv 学术论文（涵盖 AI、计算机、数学、物理等），返回论文标题、作者、发表日期、摘要及 PDF 链接。查前沿学术论文或算法研究时优先使用。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '英文学术检索关键词或论文标题/作者，如 "attention is all you need" 或 "deepseek r1"' },
            count: { type: 'integer', description: '返回篇数，1-6，默认 4' },
            sort: { type: 'string', description: '可选：relevance（默认按相关性）或 date（按最新发表日期）' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'hn_top',
        description: '获取 Hacker News 实时科技热榜或按关键词搜索技术社区高赞讨论。不传 query 时返回当前首页热榜；传入 query 时检索相关技术讨论与评分。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '可选：搜索关键词（留空则获取 Hacker News 当前首页热榜）' },
            count: { type: 'integer', description: '返回条数，1-10，默认 6' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'exchange_rate',
        description: '查询实时法币汇率换算（支持 USD/CNY/JPY/EUR/HKD/TWD/GBP 等全球货币）及主流加密货币实时价格与 24h 涨跌（BTC/ETH/SOL/BNB/DOGE/XRP/TON/SUI 等）。查汇率或币价时优先用它，不要用 web_search。',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string', description: '源货币或加密币代码，如 USD、JPY、BTC、人民币' },
            to: { type: 'string', description: '目标货币代码，默认 CNY，如 CNY、USD' },
            amount: { type: 'number', description: '换算金额，默认 1' }
          },
          required: ['from']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'net_lookup',
        description: '网络诊断工具：支持通过 Cloudflare DoH 查询域名权威 DNS 记录（A/AAAA/CNAME/MX/TXT/NS），或查询公网 IP 地址的地理位置、运营商（ISP）与 ASN 归属信息。',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: '要查询的域名（如 example.com）或公网 IP 地址（如 1.1.1.1）' },
            type: { type: 'string', description: '可选：DNS 记录类型（A/AAAA/CNAME/MX/TXT/NS）或 IP，默认自动判断' }
          },
          required: ['target']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'calculate',
        description: '精确科学计算器，支持加减乘除、乘方(^)、取余(%)、括号、科学记数法、常量(pi, e)以及函数：sqrt, cbrt, abs, round(x,n), floor, ceil, sin, cos, tan, asin, acos, atan, ln, log(x,base), log10, log2, exp, pow(a,b), min, max, sum, avg。任何需要数字运算的场景都用它，不要心算。',
        parameters: {
          type: 'object',
          properties: {
            expression: { type: 'string', description: '数学表达式，如 (3280-1299)*1.13 或 round(sqrt(2)*pi, 4) 或 pow(1.05, 10)' }
          },
          required: ['expression']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'toolkit',
        description: '确定性实用工具箱，支持：1) unit_convert（长度/重量/温度C-F-K/面积含亩和坪/体积/速度/存储容量/油耗MPG与L/100km精确换算）；2) hash（计算文本的 SHA-256/SHA-512/SHA-1 哈希值）；3) base64_encode / base64_decode；4) url_encode / url_decode；5) uuid（生成标准 UUID v4）；6) text_stats（精确统计字数、中文字数、英文词数、UTF-8字节数与Token数）。遇到字数统计、编码哈希、单位换算时必须调用，切勿心算。',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              description: '操作类型：unit_convert | hash | base64_encode | base64_decode | url_encode | url_decode | uuid | text_stats'
            },
            input: { type: 'string', description: '输入文本（用于 hash / base64 / url / text_stats）' },
            value: { type: 'number', description: '数值（用于 unit_convert 换算金额/数值，或 uuid 生成个数）' },
            from_unit: { type: 'string', description: 'unit_convert 源单位（如 km, lb, f, mpg, gib, 亩, 斤）' },
            to_unit: { type: 'string', description: 'unit_convert 目标单位（如 mi, kg, c, l100km, gb, m2）' },
            algorithm: { type: 'string', description: '可选：hash 算法（SHA-256 / SHA-384 / SHA-512 / SHA-1），默认 SHA-256' }
          },
          required: ['action']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_time',
        description: '获取当前时间（可指定 IANA 时区，含 Unix 时间戳），并支持精确日期推算：计算两个日期之间相差多少天/周（target_date），或计算某日期加减 N 天后的具体日期与星期几（add_days）。遇到时间、日期差、倒计时推算时必须用它，不要心算日历。',
        parameters: {
          type: 'object',
          properties: {
            timezone: { type: 'string', description: 'IANA 时区，如 Asia/Shanghai、America/New_York，默认 Asia/Shanghai' },
            base_date: { type: 'string', description: '可选：基准日期 YYYY-MM-DD，默认取当前时区的今天' },
            target_date: { type: 'string', description: '可选：目标日期 YYYY-MM-DD，用于计算与基准日期相差的天数和周数' },
            add_days: { type: 'integer', description: '可选：在基准日期上加减的天数（正数向后推，负数向前推）' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: '查询指定城市当前天气与未来三天预报。city 必须给明确城市名（如"北京"、"Tokyo"）；用户没说城市时先追问，不要猜。',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: '城市名，如"北京"、"Tokyo"' }
          },
          required: ['city']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'remember',
        description: '把关于用户的重要长期信息存入记忆（如偏好、生日、项目名、常用城市），存入后以后所有对话都会记得。仅在用户明确要求记住（"记住…"）时调用，不要把临时对话内容存进去。同一主题（如"我的手机号是…"）改口后直接记住新值即可：旧值会被自动覆盖更新，无需先删除。',
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
        description: '按关键词删除已保存的用户长期记忆。仅在用户明确要求忘掉/删除某条记忆（如"忘掉我之前的住址"、"删掉关于猫的记忆"）时调用。',
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
        description: '按标题或关键词读取知识库文档（单次返回 8000 字，超长文档可传 offset 分页续读）。query 给标题或关键词；标题对不上时会自动用多关键词分词检索全库正文并返回最相关的 Top 3 片段及 offset。读到相关内容后优先引用，并注明"据知识库文档《xxx》"。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '文档标题或多关键词（支持空格分隔），如"甲骨文 ARM 放货"' },
            offset: { type: 'integer', description: '可选：读取起始字符偏移量（默认 0），用于长文档翻页或跳转到检索命中的 offset' }
          },
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
          properties: {
            query: { type: 'string', description: '文档标题或关键词' }
          },
          required: ['query']
        }
      }
    }
  ];
  if (kbReadOnly) {
    const writes = ['remember', 'forget_memory', 'save_doc', 'delete_doc'];
    return tools.filter(t => writes.indexOf(t.function.name) === -1);
  }
  return tools;
}

async function execAgentTool(name, args, env, chatId, kbReadOnly) {
  args = args || {};
  // 执行层硬校验：Web 端（kbReadOnly）即使模型幻觉出写入类工具调用，也绝不执行
  if (kbReadOnly && (name === 'remember' || name === 'forget_memory' || name === 'save_doc' || name === 'delete_doc')) {
    return '工具 ' + name + ' 在本端不可用：知识库为只读，写入与删除（记忆 / 文档保存与删除）仅 Telegram 端支持。请如实告知用户，并引导其通过 Telegram 机器人完成该操作；不要声称已完成。';
  }
  let toolTimeoutMs = parseInt(env.AGENT_TOOL_TIMEOUT_MS || '30000', 10);
  if (!(toolTimeoutMs > 0)) toolTimeoutMs = 30000;
  let timer;
  try {
    const run = (async () => {
      switch (name) {
        case 'web_search': return await toolWebSearch(args.query, args.count);
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
