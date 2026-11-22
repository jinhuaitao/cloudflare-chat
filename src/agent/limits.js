// Agent 运行上限与工具进度的可读文案
//
// v7.5.0：把散落在循环里的 parseInt 全部收敛到这里，一次解析、统一夹取范围。
// 之前 ctxBudget / toolTimeout / 并发数各自在 loop.js 里手写默认值，改一处忘一处，
// 环境变量写错（负数、超大值）也没有兜底。现在所有 Agent 预算只有一个入口。

// ==================== Telegram Agent：主循环限制与工具描述 ====================
// persona 可选：只提供「默认预算」，显式配置的环境变量永远优先。
// 调研类要多跑几步多读几篇，写作类给多了只会增加发散风险，预算跟着任务形态走。
// chain 可选：人格接力时预算取链上角色的最大值，步数额外 +2——
// 阶段切换本身要消耗一步，不能让第二阶段刚开始就撞上限。
//
// v7.37.0：返回里多一个 explicit，逐项标明该值是不是管理员显式配的——
// 「显式」= 环境变量存在且解析出一个 >0 的数（之后再夹取不影响判定：
// 写了 1ms 也是显式配过，只是被夹到下限 1000ms；写错/写 0/写负数/没写
// 都不算显式，走人格或默认值）。evolveLimits 靠它判断 overlay 该不该
// 叠加：显式配过的项，已应用的限流提案也不再覆盖——「显式配置优先」
// 从此对人格预算与全局工具限流都成立（之前只对前者成立，见 overlay.js）。
function agentLimits(env, persona, chain) {
  env = env || {};
  const chainList = Array.isArray(chain) && chain.length > 1 ? chain : null;
  const explicit = {
    maxSteps: false,
    timeoutMs: false,
    toolTimeoutMs: false,
    toolConcurrency: false,
    ctxBudget: false,
    wrapReserveMs: false,
  };
  const envInt = (key) => parseInt(env[key], 10);

  let maxSteps = envInt('AGENT_MAX_STEPS');
  if (maxSteps > 0) {
    explicit.maxSteps = true;
  } else {
    if (chainList) {
      maxSteps = 0;
      for (const p of chainList) {
        const v = parseInt(p && p.maxSteps, 10);
        if (v > maxSteps) maxSteps = v;
      }
      if (maxSteps > 0) maxSteps += 2;
    } else {
      maxSteps = parseInt(persona && persona.maxSteps, 10);
    }
    if (!(maxSteps > 0)) maxSteps = 6;
  }
  if (maxSteps > 12) maxSteps = 12;

  let timeoutMs = envInt('AGENT_TIMEOUT_MS');
  if (timeoutMs > 0) {
    explicit.timeoutMs = true;
  } else {
    timeoutMs = 240000;
  }
  if (timeoutMs > 600000) timeoutMs = 600000;

  // 单个工具单次执行上限（毫秒）：真正生效值还会被「本轮剩余预算」进一步压缩
  let toolTimeoutMs = envInt('AGENT_TOOL_TIMEOUT_MS');
  if (toolTimeoutMs > 0) {
    explicit.toolTimeoutMs = true;
  } else {
    toolTimeoutMs = 30000;
  }
  if (toolTimeoutMs < 1000) toolTimeoutMs = 1000;
  if (toolTimeoutMs > 120000) toolTimeoutMs = 120000;

  // 单步内并行执行工具的最大并发数：防止模型一次吐 8 个调用时同时打出 8 个外部请求
  let toolConcurrency = envInt('AGENT_TOOL_CONCURRENCY');
  if (toolConcurrency > 0) {
    explicit.toolConcurrency = true;
  } else {
    toolConcurrency = 4;
  }
  if (toolConcurrency > 8) toolConcurrency = 8;

  // 单轮上下文字符预算：超出后自动折叠早期工具输出并压缩更早的历史轮次
  let ctxBudget = envInt('AGENT_CONTEXT_BUDGET');
  if (ctxBudget > 0) {
    explicit.ctxBudget = true;
  } else {
    if (chainList) {
      ctxBudget = 0;
      for (const p of chainList) {
        const v = parseInt(p && p.ctxBudget, 10);
        if (v > ctxBudget) ctxBudget = v;
      }
    } else {
      ctxBudget = parseInt(persona && persona.ctxBudget, 10);
    }
    if (!(ctxBudget > 0)) ctxBudget = 24000;
  }
  if (ctxBudget < 6000) ctxBudget = 6000;
  if (ctxBudget > 200000) ctxBudget = 200000;

  // 收尾预留：剩余预算低于这个值时不再发起新工具调用，直接汇总作答
  let wrapReserveMs = envInt('AGENT_WRAP_RESERVE_MS');
  if (wrapReserveMs > 0) {
    explicit.wrapReserveMs = true;
  } else {
    wrapReserveMs = 8000;
  }
  if (wrapReserveMs > 30000) wrapReserveMs = 30000;

  return { maxSteps, timeoutMs, toolTimeoutMs, toolConcurrency, ctxBudget, wrapReserveMs, explicit };
}

// 工具调用的人类可读描述，用于进度提示与 Web 端工具调用轨迹胶囊
function describeToolCall(name, args) {
  args = args || {};
  const offNote = args.offset > 0 ? '（续读 offset=' + args.offset + '）' : '';
  switch (name) {
    case 'web_search': return '🔍 正在搜索：' + (args.query || '');
    case 'web_fetch': return '📄 正在读取网页' + offNote + '…';
    case 'wiki_lookup': return '🌐 正在查阅维基百科：' + (args.query || '');
    case 'github_lookup': return '🐙 正在检索 GitHub：' + (args.query || '');
    case 'arxiv_search': return '📑 正在检索 arXiv 论文：' + (args.query || '');
    case 'hn_top': return '📰 正在获取 Hacker News：' + (args.query || '首页热榜');
    case 'exchange_rate': return '💱 正在查询汇率/行情：' + (args.from || '') + (args.to ? ' → ' + args.to : '');
    case 'net_lookup': return '🛰️ 正在诊断网络/DNS：' + (args.target || '');
    case 'calculate': return '🧮 正在计算：' + (args.expr || args.expression || '');
    case 'toolkit': return '🧰 正在执行工具箱 (' + (args.action || 'tool') + ')…';
    case 'get_weather': return '🌤 正在查询天气：' + (args.city || '');
    case 'get_time': return '🕐 正在获取时间/推算日期…';
    case 'remember': return '🧠 正在记住…';
    case 'memory': {
      const a = String(args.action || 'search').toLowerCase();
      if (a === 'pin') return '📌 正在固定本会话约束…';
      if (a === 'stats') return '📊 正在统计三层记忆…';
      return '🔎 正在检索三层记忆：' + (args.query || '');
    }
    case 'forget_memory': return '🗑️ 正在清理记忆：' + (args.keyword || '');
    case 'save_doc': return '💾 正在保存文档：' + (args.title || '');
    case 'list_docs': return '📚 正在查看知识库文档…';
    case 'read_doc': return '📖 正在读取文档：' + (args.query || '') + offNote;
    case 'delete_doc': return '🗑️ 正在删除文档：' + (args.query || '');
    default: return '⚙️ 正在调用：' + name;
  }
}

// 单步工具输出的字符上限分摊（v7.8.0）
// 模型一步可能吐出 6~8 个 tool_calls，若每个都按 4000 字符回灌，一步就把上下文顶满，
// 下一步必然触发全量压缩：前缀缓存失效 + 早期结果被折叠成摘要，等于白跑一步。
// 这里先扣掉 system 提示与历史对话的固定开销，再把剩余预算按工具数均分。
function toolResultCap(ctxBudget, toolCount) {
  const budget = Math.max(1600, (ctxBudget > 0 ? ctxBudget : 24000) - 8000);
  const n = Math.max(1, toolCount | 0);
  return Math.max(800, Math.min(4000, Math.floor(budget / n)));
}

export {
  agentLimits,
  describeToolCall,
  toolResultCap,
};
