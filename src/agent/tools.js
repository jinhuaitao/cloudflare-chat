// Agent 工具定义与分发（v7.8.0：Schema 瘦身 + 定义复用缓存 + 统一失败判定）
//
// v7.8.0 性能：
// 1) 工具定义是「每一步都要重发的固定开销」。旧版 18 个工具的 JSON 有 6361 字符，
//    其中大量是重复表述（如 toolkit 的能力清单在 description 与 action 里各写一遍）。
//    精简后降到 ~4300 字符，单步省下约 2000 字符 ≈ 1300 token；5 步的对话能省 6000+ token，
//    同时缩短 prefill 时间、降低首字延迟；
// 2) 定义只构建一次并按（只读端 / 是否有知识库文档）缓存复用，避免每轮对话重建 18 个对象，
//    也让发往上游的 tools JSON 字节级稳定 —— 这是命中上游「前缀缓存」的前提；
//    返回的数组是共享只读结构，调用方不得修改。

import { toolWebSearch, toolWebFetch } from './tools-web.js';
import {
  toolCalculate, toolGetTime, toolGetWeather, toolExchangeRate, toolWikiLookup,
  toolGithubLookup, toolArxivSearch, toolHnTop, toolNetLookup, toolToolkit
} from './tools-local.js';
import { agentSaveMemory, agentForgetMemory } from './memory.js';
import { toolSaveDoc, toolListDocs, toolReadDoc, toolDeleteDoc } from '../kb/doc-tools.js';
import { memorySearchText, memoryStatsText, memoryPin, memoryUnpin } from '../memory/index.js';

// ==================== 工具失败判定（唯一入口） ====================
// v7.5.0：旧版把这个巨型正则内联在 loop.js 里，两个问题：
//  1) 新增工具时极易漏加前缀，失败被当成成功 → 模型拿着"失败"文本继续编；
//  2) 只认前缀，形如 "请给出…" / "文档读取失败" 这类同样代表失败的文案被判成成功。
// 现在集中在这里，前缀表 + 兜底正则，供循环熔断与同轮去重共用。
const TOOL_FAILURE_PREFIXES = [
  '搜索失败', '搜索请求失败', '抓取失败', 'URL 非法', '该地址禁止抓取', '不支持抓取',
  '计算失败', '计算结果非法', '表达式为空', '表达式含非法字符',
  '时区无效', '日期格式无效',
  '天气查询失败', '找不到城市', '城市名为空',
  '汇率查询失败',
  '维基百科查询失败', '维基百科未找到', '维基百科查询关键词为空',
  'GitHub 查询失败', 'GitHub 未找到',
  'arXiv 查询失败', 'arXiv 未找到',
  'Hacker News 查询失败',
  '网络诊断失败', '网络诊断拒绝', 'IP 归属查询失败',
  '单位换算失败', '关键词为空', '标题为空', '内容为空',
  '工具执行失败', '未知工具', 'R2 未绑定', '知识库文档写入', '记忆写入',
  '工具调用参数解析失败',
  '文档读取失败', '删除失败', '请给出要读取的文档标题', '请给出要删除的文档标题',
  '未找到标题或正文包含', '未找到标题包含',
  'JSON 解析失败', 'JSON 取值失败', '正则编译失败', '正则过长',
  '请提供 pattern', '请提供 path',
  '记忆检索失败', '记忆写入失败',
];

function isToolFailureResult(result) {
  const s = String(result == null ? '' : result).trim();
  if (!s) return true;
  for (const p of TOOL_FAILURE_PREFIXES) {
    if (s.indexOf(p) === 0) return true;
  }
  // 搜索类工具用「搜索「xxx」无结果」表达失败
  if (/^搜索「[^」]*」无结果/.test(s)) return true;
  // 形如 "工具 web_fetch 执行超时（30 秒），已跳过"
  if (/^工具\s+\S+\s+执行超时/.test(s)) return true;
  return false;
}

// ==================== Agent 工具定义 ====================
// 描述遵循「一句话说清何时用 + 参数名自解释」：模型选工具靠的是名字与首句，
// 参数范围的精确表述留在参数 description 里，不在函数描述里重复。
const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '联网搜索实时信息，自动预读前2条正文；稳定常识勿搜。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          count: { type: 'integer', description: '条数 1-8，默认 5' },
          deep_read: { type: 'boolean', description: '是否预读前2条正文摘要，默认 true' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: '抓取网页正文，单次6000字符，长文传 offset 翻页；逗号分隔最多3个URL并发。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'http(s) URL，逗号分隔最多3个' },
          offset: { type: 'integer', description: '起始字符偏移，默认 0' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'wiki_lookup',
      description: '中英维基百科词条摘要，查概念/人物/历史背景优先用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '词条名或关键词' },
          lang: { type: 'string', description: 'zh 或 en' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_lookup',
      description: 'GitHub 仓库详情（传 owner/repo，一次并发取 Star/Release/README）或按关键词搜项目。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'owner/repo 或搜索关键词' },
          mode: { type: 'string', description: 'repo 或 search' },
          sort: { type: 'string', description: 'stars 或 updated' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'arxiv_search',
      description: '检索 arXiv 论文，返回标题/作者/日期/摘要/PDF 链接。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '英文检索词或论文标题' },
          count: { type: 'integer', description: '1-6，默认 4' },
          sort: { type: 'string', description: 'relevance 或 date' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'hn_top',
      description: 'Hacker News 首页科技热榜（不传 query）或按关键词搜高赞讨论。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '可选关键词，留空取热榜' },
          count: { type: 'integer', description: '1-10，默认 6' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'exchange_rate',
      description: '法币汇率换算与加密行情（BTC/ETH/SOL 等），from 可逗号分隔多币种一次换算。',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '源货币代码，逗号分隔多个如 USD,JPY,BTC' },
          to: { type: 'string', description: '目标货币，默认 CNY' },
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
      description: 'DNS 解析（A/AAAA/CNAME/MX/TXT/NS）或公网 IP 归属与 ASN 查询。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '域名或公网 IP' },
          type: { type: 'string', description: '记录类型，或 IP' }
        },
        required: ['target']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: '精确计算器：四则、^、%、pi、e，支持 sqrt/cbrt/abs/round/floor/ceil/sin/cos/tan/ln/log/exp/pow/min/max/sum/avg；多条用 ; 分隔一次算完。',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: '数学表达式，多条用 ; 分隔' }
        },
        required: ['expression']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'toolkit',
      description: '确定性工具箱：单位换算、哈希、Base64/URL 编解码、UUID、文本统计、JSON 格式化与取值、正则测试。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'unit_convert | hash | base64_encode | base64_decode | url_encode | url_decode | uuid | text_stats | json_format | json_query | regex_test'
          },
          input: { type: 'string', description: '输入文本（json_* 传 JSON，regex_test 传被匹配文本）' },
          value: { type: 'number', description: '数值（unit_convert 数值或 uuid 个数）' },
          from_unit: { type: 'string', description: '源单位，如 km/lb/f/mpg/gib/亩/斤' },
          to_unit: { type: 'string', description: '目标单位，如 mi/kg/c/l100km/gb/m2' },
          algorithm: { type: 'string', description: 'SHA-256(默认)/SHA-384/SHA-512/SHA-1' },
          path: { type: 'string', description: 'json_query 路径，如 data.items[0].name' },
          pattern: { type: 'string', description: 'regex_test 正则表达式' },
          flags: { type: 'string', description: 'regex_test 修饰符，如 gi' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_time',
      description: '当前时间（含 Unix 时间戳）与日期推算：两日期差（target_date）或加减天数（add_days）。',
      parameters: {
        type: 'object',
        properties: {
          timezone: { type: 'string', description: 'IANA 时区，默认 Asia/Shanghai' },
          base_date: { type: 'string', description: '基准日期 YYYY-MM-DD' },
          target_date: { type: 'string', description: '目标日期 YYYY-MM-DD' },
          add_days: { type: 'integer', description: '加减天数（正负整数）' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '城市当前天气与未来三天预报，逗号分隔可多城市并发。',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '城市名，逗号分隔多个' }
        },
        required: ['city']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description: '保存用户长期事实（仅明确要求记住时；同主题自动覆盖旧值）。',
      parameters: {
        type: 'object',
        properties: {
          fact: { type: 'string', description: '一句话事实' },
          kind: { type: 'string', description: 'fact/pref/id/task，默认 fact' },
          weight: { type: 'integer', description: '重要度 1-5，默认 3' }
        },
        required: ['fact']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory',
      description: '三层记忆：search 跨层检索｜stats 各层条数｜pin 固定本会话约束。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'search(默认)|stats|pin' },
          query: { type: 'string', description: '检索词（search）' },
          text: { type: 'string', description: '固定内容（pin）' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'forget_memory',
      description: '按关键词删除长期记忆（仅明确要求忘掉时）。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '记忆关键词' }
        },
        required: ['keyword']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_doc',
      description: '长文保存为知识库文档；mode 控制新建/覆盖/追加，tags 便于检索。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '文档标题' },
          content: { type: 'string', description: 'Markdown 正文' },
          source: { type: 'string', description: '原文链接' },
          mode: { type: 'string', description: 'auto(默认)/create/overwrite/append/prepend' },
          tags: { type: 'string', description: '逗号分隔标签，最多 8 个' }
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
      description: '按标题或关键词读知识库文档，单次8000字，offset 翻页；标题未命中自动全库检索。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '文档标题或多关键词' },
          offset: { type: 'integer', description: '字符偏移，默认 0' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_doc',
      description: '删除知识库文档（仅明确要求删除时）。',
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

const WRITE_TOOL_NAMES = ['remember', 'forget_memory', 'save_doc', 'delete_doc'];
const KB_READ_TOOL_NAMES = ['list_docs', 'read_doc'];

// 按「权限位 + 知识库是否为空」缓存过滤结果：Agent 一轮里每步都会用到它，
// 反复重建 18 个对象纯属浪费；共享同一份也让发往上游的 tools 字节完全一致。
const toolsCache = new Map();

function getAgentTools(kbReadOnly, opts) {
  const hasKbDocs = opts && typeof opts.hasKbDocs === 'boolean' ? (opts.hasKbDocs ? 'y' : 'n') : 'u';
  const cacheKey = (kbReadOnly ? 'ro' : 'rw') + '|' + hasKbDocs;
  const hit = toolsCache.get(cacheKey);
  if (hit) return hit;

  let filtered = TOOL_DEFS;
  if (kbReadOnly) {
    filtered = filtered.filter(t => WRITE_TOOL_NAMES.indexOf(t.function.name) === -1);
  }
  if (hasKbDocs === 'n') {
    filtered = filtered.filter(t => KB_READ_TOOL_NAMES.indexOf(t.function.name) === -1);
  }
  toolsCache.set(cacheKey, filtered);
  return filtered;
}

async function execAgentTool(name, args, env, chatId, kbReadOnly, opts) {
  args = args || {};
  opts = opts || {};
  if (kbReadOnly && WRITE_TOOL_NAMES.indexOf(name) !== -1) {
    return '工具 ' + name + ' 在本端不可用：知识库为只读，写入与删除（记忆 / 文档保存与删除）仅 Telegram 或微信 ClawBot 机器人端支持。请如实告知用户，并引导其通过 Telegram 或微信 ClawBot 机器人完成该操作；不要声称已完成。';
  }
  // v7.5.0：超时取「工具上限」与「本轮剩余预算」的较小值。
  // 旧版固定 30 秒，任务快到期时仍会为一个工具再等 30 秒，导致 wrapUp 完全没时间收尾，
  // 用户只能拿到「任务超时」而看不到任何结果。
  let toolTimeoutMs = parseInt(opts.timeoutMs, 10);
  if (!(toolTimeoutMs > 0)) {
    toolTimeoutMs = parseInt(env.AGENT_TOOL_TIMEOUT_MS || '30000', 10);
    if (!(toolTimeoutMs > 0)) toolTimeoutMs = 30000;
  }
  if (toolTimeoutMs < 800) toolTimeoutMs = 800;
  // v7.9.0：分页类工具（read_doc / web_fetch）需要知道自己这次能输出多少字符，
  // 否则它按 8000 切片、循环再按预算截到 4000，尾部给出的 nextOffset 就对不上实际内容
  const maxChars = parseInt(opts.maxChars, 10) > 0 ? parseInt(opts.maxChars, 10) : 0;
  let timer;
  try {
    const run = (async () => {
      switch (name) {
        case 'web_search': return await toolWebSearch(args.query, args.count, args.deep_read, env);
        case 'web_fetch': return await toolWebFetch(args.url, args.offset, maxChars);
        case 'wiki_lookup': return await toolWikiLookup(args.query, args.lang);
        case 'github_lookup': return await toolGithubLookup(args);
        case 'arxiv_search': return await toolArxivSearch(args);
        case 'hn_top': return await toolHnTop(args);
        case 'exchange_rate': return await toolExchangeRate(args);
        case 'net_lookup': return await toolNetLookup(args);
        // 兼容模型把 expression 写成 expr / query 的情况，避免因参数名不一致直接判失败
        case 'calculate': return toolCalculate(args.expression || args.expr || args.query);
        case 'toolkit': return await toolToolkit(args);
        case 'get_time': return toolGetTime(args.timezone, args);
        case 'get_weather': return await toolGetWeather(args.city);
        case 'remember': return await agentSaveMemory(env, chatId, args.fact, { kind: args.kind, weight: args.weight });
        case 'memory': {
          const action = String(args.action || 'search').toLowerCase();
          if (action === 'pin') {
            // pin 写的是 L1（本会话），Web 只读端不允许——但 search / stats 仍然可用
            if (kbReadOnly) {
              return '本端为只读模式，不能固定会话记忆（pin）；检索（search）与统计（stats）仍可使用。请如实告知用户该操作需在 Telegram 或微信 ClawBot 机器人端完成。';
            }
            const text = String(args.text || args.query || '').trim();
            if (!text) return '记忆写入失败：pin 需要给出 text（要固定的内容）';
            const r = await memoryPin(env, chatId, text);
            if (!r.ok) return '记忆写入失败：' + (r.reason || '未知原因');
            if (r.duplicate) return '本会话已经固定过这条内容，无需重复固定（共 ' + r.count + ' 条）。';
            const persistNote = r.persisted ? '' : '（R2 未绑定或写入失败，仅在当前实例内有效）';
            return '已固定到本会话工作记忆（L1，共 ' + r.count + ' 条）' + persistNote + '：' + text;
          }
          if (action === 'stats') return await memoryStatsText(env, chatId);
          return await memorySearchText(env, chatId, args.query);
        }
        case 'forget_memory': {
          const kw = String(args.keyword || '').trim();
          if (!kw) return '关键词为空，未删除任何记忆';
          const rr = await agentForgetMemory(env, chatId, kw);
          if (rr.persistError) return rr.persistError;
          // v7.10.0：L2 删完顺手清 L1 里同关键词的固定项，避免"忘掉 X"之后提示词里还挂着 X
          let unpinned = 0;
          try {
            const un = await memoryUnpin(env, chatId, kw);
            unpinned = un.removed || 0;
          } catch (e) {}
          const pinNote = unpinned ? '，并解除 ' + unpinned + ' 条本会话固定项' : '';
          return rr.removed > 0
            ? '已删除 ' + rr.removed + ' 条包含「' + kw + '」的长期记忆' + pinNote
            : (unpinned ? '长期记忆中没有匹配项，但已解除 ' + unpinned + ' 条本会话固定项' : '未找到包含「' + kw + '」的长期记忆');
        }
        case 'save_doc': return await toolSaveDoc(env, chatId, args);
        case 'list_docs': return await toolListDocs(env);
        case 'read_doc': return await toolReadDoc(env, args, maxChars);
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
  TOOL_FAILURE_PREFIXES,
  isToolFailureResult,
  getAgentTools,
  execAgentTool,
};
