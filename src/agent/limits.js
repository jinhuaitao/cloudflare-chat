// Agent 运行上限与工具进度的可读文案
//
// v7.5.0：把散落在循环里的 parseInt 全部收敛到这里，一次解析、统一夹取范围。
// 之前 ctxBudget / toolTimeout / 并发数各自在 loop.js 里手写默认值，改一处忘一处，
// 环境变量写错（负数、超大值）也没有兜底。现在所有 Agent 预算只有一个入口。

// ==================== Telegram Agent：主循环限制与工具描述 ====================
function agentLimits(env) {
  env = env || {};

  let maxSteps = parseInt(env.AGENT_MAX_STEPS || '6', 10);
  if (!(maxSteps > 0)) maxSteps = 6;
  if (maxSteps > 12) maxSteps = 12;

  let timeoutMs = parseInt(env.AGENT_TIMEOUT_MS || '240000', 10);
  if (!(timeoutMs > 0)) timeoutMs = 240000;
  if (timeoutMs > 600000) timeoutMs = 600000;

  // 单个工具单次执行上限（毫秒）：真正生效值还会被「本轮剩余预算」进一步压缩
  let toolTimeoutMs = parseInt(env.AGENT_TOOL_TIMEOUT_MS || '30000', 10);
  if (!(toolTimeoutMs > 0)) toolTimeoutMs = 30000;
  if (toolTimeoutMs < 1000) toolTimeoutMs = 1000;
  if (toolTimeoutMs > 120000) toolTimeoutMs = 120000;

  // 单步内并行执行工具的最大并发数：防止模型一次吐 8 个调用时同时打出 8 个外部请求
  let toolConcurrency = parseInt(env.AGENT_TOOL_CONCURRENCY || '4', 10);
  if (!(toolConcurrency > 0)) toolConcurrency = 4;
  if (toolConcurrency > 8) toolConcurrency = 8;

  // 单轮上下文字符预算：超出后自动折叠早期工具输出并压缩更早的历史轮次
  let ctxBudget = parseInt(env.AGENT_CONTEXT_BUDGET || '24000', 10);
  if (!(ctxBudget > 0)) ctxBudget = 24000;
  if (ctxBudget < 6000) ctxBudget = 6000;
  if (ctxBudget > 200000) ctxBudget = 200000;

  // 收尾预留：剩余预算低于这个值时不再发起新工具调用，直接汇总作答
  let wrapReserveMs = parseInt(env.AGENT_WRAP_RESERVE_MS || '8000', 10);
  if (!(wrapReserveMs > 0)) wrapReserveMs = 8000;
  if (wrapReserveMs > 30000) wrapReserveMs = 30000;

  return { maxSteps, timeoutMs, toolTimeoutMs, toolConcurrency, ctxBudget, wrapReserveMs };
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
    case 'forget_memory': return '🗑️ 正在清理记忆：' + (args.keyword || '');
    case 'save_doc': return '💾 正在保存文档：' + (args.title || '');
    case 'list_docs': return '📚 正在查看知识库文档…';
    case 'read_doc': return '📖 正在读取文档：' + (args.query || '') + offNote;
    case 'delete_doc': return '🗑️ 正在删除文档：' + (args.query || '');
    default: return '⚙️ 正在调用：' + name;
  }
}

export {
  agentLimits,
  describeToolCall,
};
