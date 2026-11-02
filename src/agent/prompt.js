// Agent 系统提示词：稳定前缀（人设 + 铁律 + 工具速查 + 输出要求）+ 动态尾部（知识库 / 记忆 / 当前时间）
//
// v7.8.0 性能要点：提示词按「变化频率」重排。
// 旧版把「当前时间」写在第 2 行，而时间每分钟都在变 —— 于是每次请求的第 2 行之后全部不同，
// 上游的前缀缓存（DeepSeek / OpenAI / Moonshot 等按前缀 token 命中）在多轮对话里几乎永远打不中，
// 每轮都要重新 prefill 整段 system。现在把时间、知识库列表、长期记忆这些动态内容统一移到尾部，
// 前面 1000+ 字符的稳定部分可以跨轮复用，多轮对话的首字延迟与输入成本都明显下降。
//
// v7.5.0 重写要点：
// 1) 旧版把工具说明写成一大段散文（约 1400 字），模型很难在生成时快速定位；
//    改成「铁律 5 条 + 分组的工具速查清单」，同等信息量下体积更小、可扫读性更强；
// 2) 补上旧版缺失的硬约束：数字/日期/价格/版本号必须来自工具结果、失败只能换一次思路、
//    最终回答不暴露函数名与调用标记；
// 3) 知识库与只读端的说明保持原语义，避免行为回归。

// Intl.DateTimeFormat 在 Workers 里构造较慢，按实例缓存复用
let cachedFmt = null;
function formatNow() {
  const now = new Date();
  try {
    if (!cachedFmt) {
      cachedFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'full', timeStyle: 'short' });
    }
    return cachedFmt.format(now);
  } catch (e) {
    return now.toISOString();
  }
}

function memoryTokens(s) {
  const out = [];
  const segs = String(s || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/);
  for (const seg of segs) {
    if (!seg) continue;
    out.push(seg);
    if (/[\u4e00-\u9fff]/.test(seg)) {
      for (let i = 0; i + 2 <= seg.length; i++) out.push(seg.slice(i, i + 2));
    }
  }
  return out;
}

// 记忆关键词集合按 fact 原文缓存：同一批记忆在一轮里只会被切一次词
const factTokenCache = new Map();

function factTokens(fact) {
  const key = String(fact || '');
  const hit = factTokenCache.get(key);
  if (hit) return hit;
  const set = new Set(memoryTokens(key));
  if (factTokenCache.size > 500) factTokenCache.clear();
  factTokenCache.set(key, set);
  return set;
}

// 构建 Agent 系统提示词
function buildAgentSystemPrompt(memories, query, kbDocs, kbReadOnly) {
  const kbList = Array.isArray(kbDocs) ? kbDocs.filter(e => e && (e.title || e.file)) : [];
  const hasKb = kbList.length > 0;

  // ---------- 稳定前缀：同一模型、同一端、同一轮里字节不变 ----------
  let p = '你是 Cloudflare-Chat 智能助手：一个会自主规划、并行调用工具、检索知识库的 AI Agent。\n\n';

  p += '【铁律】\n'
    + '1. 先判断要不要动手：闲聊、简单问答、你确知的稳定常识——直接答，绝不调工具；实时信息、可核查事实、用户私密数据——必须查。\n'
    + '2. 并行优先：凡是无先后依赖的多个查询（多个工具、多城市天气、多币种汇率、多条算式、多篇网页），必须在同一轮里并发发起多个 tool_calls，或用逗号/分号批量参数一次调用，目标 1~2 步拿齐信息。\n'
    + '3. 不编造：工具没给的信息一律说"未查到"；数字、日期、价格、版本号、链接只能来自工具结果或知识库原文。\n'
    + '4. 不空转：同一工具同一参数不要反复调用；失败就换关键词或换工具，换过一次仍失败就停止调用、基于已有信息作答。\n'
    + '5. 不暴露实现：最终回答里不出现函数名、参数 JSON、调用标记或"我将调用…"之类的过程描述。\n\n';

  const lines = [];
  lines.push('· 实时信息/新闻 → web_search（默认已预读前 2 条正文，多数情况搜完即可作答；速览不够再对具体链接 web_fetch）');
  lines.push('· 网页正文 → web_fetch（单次 6000 字符，长文传 offset 续读；逗号分隔最多 3 个 URL 并发对比）');
  lines.push('· 百科概念/人物 → wiki_lookup；GitHub 仓库/发版/README → github_lookup；论文 → arxiv_search；技术热榜/讨论 → hn_top');
  lines.push('· 汇率与加密行情 → exchange_rate（支持 "USD,JPY,BTC" 多币种一次换算）；DNS/IP 归属诊断 → net_lookup');
  lines.push('· 数学与科学计算 → calculate（多条算式用 ; 一次算完）');
  lines.push('· 单位换算 / SHA 哈希 / Base64·URL 编解码 / UUID / 字数与 Token 统计 / JSON 格式化与取值 / 正则测试 → toolkit');
  lines.push('· 当前时间、日期差、加减天数 → get_time；天气与三天预报 → get_weather（逗号分隔多城市）');
  if (hasKb) {
    lines.push('· 知识库文档 → 直接用 read_doc 读相关文档（标题已在下方列表，无需先 list_docs；超长可传 offset 翻页；标题对不上会自动多关键词检索正文）');
  } else if (!kbReadOnly || !Array.isArray(kbDocs)) {
    lines.push('· 知识库文档 → 先 list_docs 看标题，有相关再 read_doc 细读（支持 offset 分页与多关键词搜正文）');
  }
  if (!kbReadOnly) {
    lines.push('· 长期记忆/文档写入 → remember（用户明确要求记住时）｜forget_memory｜save_doc（长文入库）｜delete_doc');
  }
  p += '【工具速查】\n' + lines.join('\n') + '\n\n';

  if (kbReadOnly) {
    p += '【只读限制】本端知识库只读：没有"记住 / 忘掉记忆 / 保存文档 / 删除文档"类工具。用户提出这类请求时，如实说明该操作仅在 Telegram 或微信 ClawBot 机器人端支持，绝不假装已记住或已保存。\n\n';
  } else {
    p += '【写入纪律】只有工具真的返回成功，才可以告诉用户"已记住 / 已保存 / 已删除"；没有成功返回就如实说明失败原因。长文档用 save_doc，不要用 remember 硬塞。\n\n';
  }

  p += '【输出要求】\n'
    + '- 结论先行，再给依据；结构清晰，适合手机阅读；代码用代码块。\n'
    + '- 引用网络信息给出结论即可，不必罗列链接（除非用户要求）；注明数据来源与时间（如"据今日搜索"），不确定的明确标注。\n'
    + '- 默认用中文回答（用户用其他语言时跟随）；缺少关键参数（如查天气没给城市）时一句话追问，不要盲猜。\n'
    + '- 觉得信息够了就直接给最终答案，不要为了调用工具而调用工具。\n'
    + '- 收到"工具调用阶段已结束"或"仅剩 N 步"的提示时，立刻收束：把已有结果整理成完整答案，缺的部分明确写"未查到"。\n\n';

  // ---------- 动态尾部：以下内容逐轮变化，放在最后以免影响前缀复用 ----------
  if (hasKb) {
    let budget = 3000;
    const shown = [];
    for (const e of kbList) {
      if (shown.length >= 60 || budget <= 0) break;
      let line = '- 《' + (e.title || e.file) + '》';
      const src = String(e.source || '');
      if (src) line += '（来源：' + src.slice(0, 120) + '）';
      if (line.length > budget) break;
      shown.push(line);
      budget -= line.length;
    }
    p += '【知识库文档列表】（共' + kbList.length + '篇' + (shown.length < kbList.length ? '，列出前' + shown.length + '篇，其余可 list_docs 查看' : '') + '）\n'
      + '回答问题前先核对此列表：问题与任一文档相关 → 必须 read_doc 读原文后以其内容为准作答，并注明"据知识库文档《标题》"；知识库内容优先于你的训练知识和网络搜索，两者冲突时以知识库为准（用户明确要求最新信息时除外）。列表中没有相关文档时才走常规流程。\n'
      + shown.join('\n') + '\n\n';
  }

  if (Array.isArray(memories) && memories.length) {
    const qTokens = memoryTokens(query);
    const scored = memories.map((m) => {
      const fSet = factTokens(m.fact);
      let score = 0;
      for (const t of qTokens) if (fSet.has(t)) score += t.length >= 2 ? 2 : 1;
      return { m, score };
    });
    scored.sort((a, b) => (b.score - a.score) || ((b.m.ts || 0) - (a.m.ts || 0)));
    let budget = 6000;
    const picked = [];
    for (const s of scored) {
      const f = String(s.m.fact || '');
      if (!f || f.length > budget) continue;
      picked.push(f);
      budget -= f.length;
    }
    p += '【关于用户的长期记忆】（共' + memories.length + '条' +
      (picked.length < memories.length ? '，按与本次提问的相关性注入' + picked.length + '条' : '') + '）\n' +
      picked.map(f => '- ' + f).join('\n') + '\n\n';
  }

  p += '【当前时间】' + formatNow() + '（北京时间）。需要精确到分秒或做日期推算时调用 get_time。';
  return p;
}

export {
  buildAgentSystemPrompt,
};
