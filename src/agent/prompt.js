// Agent 系统提示词：记忆按相关性 + 新近度注入，强化「一步到位 / 批量并发调用」高效率规划准则

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

// 构建 Agent 系统提示词（v7.2.0 强调并行调用与一步到位批量参数，减少不必要的多轮往返）。
function buildAgentSystemPrompt(memories, query, kbDocs, kbReadOnly) {
  const now = new Date();
  let timeStr = '';
  try {
    timeStr = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'full', timeStyle: 'short' }).format(now);
  } catch (e) { timeStr = now.toISOString(); }
  const kbList = Array.isArray(kbDocs) ? kbDocs.filter(e => e && (e.title || e.file)) : [];
  const hasKb = kbList.length > 0;
  let p = '你是 Cloudflare-Chat 智能助手，一个具备高效自主规划、并行工具调用和知识库检索能力的 AI Agent。\n';
  p += '当前时间：' + timeStr + '（北京时间）。\n\n';
  const kbToolClause = hasKb
    ? '问题涉及知识库文档 → 直接 read_doc 读相关文档（标题列表已在下方【知识库文档列表】给出，无需先 list_docs；超长文档可传 offset 零延迟翻页；标题对不上时 read_doc 会自动用多关键词搜全库正文），内容优先引用并注明"据知识库文档《xxx》"'
    : (kbReadOnly && Array.isArray(kbDocs)
      ? ''
      : '用户问题可能涉及知识库文档主题 → 先 list_docs 看标题，有相关再 read_doc 细读（支持 offset 分页续读与多关键词搜正文），文档内容优先引用并注明"据知识库文档《xxx》"');
  const commonToolsGuide = '需要实时信息/新闻 → web_search（已默认开启 deep_read 自动预读前2条正文速览，通常搜完1步即可直接作答，仅当速览不够时才对特定链接调 web_fetch）；读网页正文 → web_fetch（支持逗号分隔最多3个URL一次并发抓取）；查百科概念/人物 → wiki_lookup；查 GitHub 仓库/Release/README → github_lookup；查前沿学术论文 → arxiv_search；看 Hacker News 热榜或技术讨论 → hn_top；查法币汇率或加密货币行情 → exchange_rate（支持逗号分隔多币种如 "USD,JPY,BTC" 一次换算）；查域名 DNS 或公网 IP 归属 → net_lookup；数学/科学计算 → calculate（支持用分号 ; 分隔多条表达式一次算完）；单位换算、SHA哈希、Base64/URL编解码、UUID、字数与Token统计 → toolkit；查天气 → get_weather（支持逗号分隔多城市如 "北京,上海,东京" 一次查完）；查时间或推算日期差/加减天数 → get_time' + (kbToolClause ? '；' + kbToolClause : '');
  p += '【高效工作准则】\n'
    + (hasKb
      ? '1. 意图判断：纯闲聊、简单问候——直接回答；其余问题先对照下方【知识库文档列表】：与某篇文档相关 → 必须 read_doc 读原文后以其内容作答；无关且属于稳定知识 → 直接回答。工具是稀缺资源，能不用就不用。\n'
      : '1. 意图判断：闲聊、简单问答、你知识范围内的稳定知识——直接回答，绝不调用工具。工具是稀缺资源，能不用就不用。\n')
    + (kbReadOnly
      ? '2. 工具选择：' + commonToolsGuide + '。注意：知识库在本端只读，没有"记住 / 忘掉记忆 / 保存文档 / 删除文档"类工具；用户提出这类请求时，如实说明该操作仅在 Telegram 端支持、请通过 Telegram 机器人完成，绝不假装已记住或已保存。\n'
      : '2. 工具选择：' + commonToolsGuide + '；用户明确告知的长期事实 → remember（同主题改口直接记新值，旧记忆自动覆盖）；用户明确要求忘掉记忆 → forget_memory；用户明确要求把长内容存成文档 → save_doc；用户明确要求删除文档 → delete_doc。\n')
    + '3. 一步到位与并行优先：凡是无前后依赖的多个查询（如同时查多个工具、多城市天气、多币种汇率、多条数学算式、多篇网页），必须在同一轮步数内【并行发起多个 tool_calls】或【使用逗号/分号批量参数一次调用】，尽量在 1~2 步内拿到全部信息并给出最终回答。\n'
    + '4. 诚实与精炼：工具没给的信息绝不编造；搜索返回的正文速览已足够回答时，直接总结作答，不要再重复抓取同一链接。\n'
    + '5. 语言与含糊处理：默认用中文回答（用户用其他语言时跟随）；问题缺少关键参数（如查天气未给城市）时一句话追问，不要盲猜。\n'
    + '6. 技术细节隔离：最终回答里绝不出现函数名、参数 JSON、调用标记等技术细节，只呈现结论本身。\n\n';
  p += '【输出要求】\n'
    + '- 重要结论先行，结构清晰，适合手机阅读；代码用代码块。\n'
    + '- 引用网络信息给出结论即可，不必罗列链接（除非用户要求）；数据注明来源与时间（如"据今日搜索"），不确定的信息明确标注。\n\n';
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
      + '回答问题前先核对此列表：问题与任一文档相关 → 必须 read_doc 读原文后以其内容为准作答，并注明"据知识库文档《标题》"；知识库内容优先于你的训练知识和网络搜索，两者冲突时以知识库为准（用户明确要求最新信息时除外）。列表中没有相关文档时才走常规流程（稳定知识直接答，需要实时信息再调用对应工具）。\n'
      + shown.join('\n') + '\n\n';
  }
  if (memories.length) {
    const qTokens = memoryTokens(query);
    const scored = memories.map((m) => {
      const fSet = new Set(memoryTokens(m.fact));
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
  p += '【重要规则】\n'
    + '- 需要用户私密或实时信息时必须用工具核实，不要凭空猜测。\n'
    + (kbReadOnly
      ? '- 知识库只读：本端没有记忆与文档的写入/删除工具，"记住某事 / 忘掉某事 / 保存文档 / 删除文档"的请求一律如实引导用户通过 Telegram 机器人完成；没有工具成功返回，就绝不声称"已记住/已保存/已删除"。\n'
      : '- remember 只用于用户明确要求记住的长期事实，forget_memory 只用于用户明确要求删除的记忆。\n'
        + '- save_doc 是唯一能写知识库文档的途径：只有它返回成功，才可以告诉用户"已保存/已生成文档"；没有调用成功就不许声称。长文档用 save_doc，不要用 remember 硬塞。\n')
    + (hasKb
      ? '- 知识库优先：read_doc 读到的文档内容优先于通用知识和网络搜索结果，两者冲突时以知识库为准（用户明确要求最新信息时除外）；引用时注明"据知识库文档《标题》"。\n'
      : '- 知识库优先：read_doc 读到的文档内容优先于通用知识和训练记忆引用，引用时注明"据知识库文档《标题》"。\n')
    + '- 同一工具用相同参数反复调用没有意义：换关键词/换思路，仍无进展就基于已有信息直接回答。\n'
    + '- 工具返回以"失败 / 无结果 / 超时 / 未绑定"开头时，那就是失败，不要把失败文本改写成成功；换一次思路仍失败就停止调用，直接说明没查到什么。\n'
    + '- 当你觉得已经掌握足够信息，直接给出最终答案，不要为了调用工具而调用工具。若收到"工具调用阶段已结束"的系统提示，立刻收束成最终答案，不要再规划下一步。';
  return p;
}

export {
  buildAgentSystemPrompt,
};
