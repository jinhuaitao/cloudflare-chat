// Agent 系统提示词：记忆按相关性 + 新近度注入（_worker.js 原第 1051-1114 行）

// 记忆分词：英文按词、中文按 2-gram，用于相关性打分
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

// 构建 Agent 系统提示词（记忆按【相关性 + 新近度】排序注入，而非只取最新）
function buildAgentSystemPrompt(memories, query) {
  const now = new Date();
  let timeStr = '';
  try {
    timeStr = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'full', timeStyle: 'short' }).format(now);
  } catch (e) { timeStr = now.toISOString(); }
  let p = '你是 Cloudflare-Chat 智能助手，一个具备自主规划、工具调用和长期记忆能力的 AI Agent。\n';
  p += '当前时间：' + timeStr + '（北京时间）。\n\n';
  p += '【工作方式】\n'
    + '1. 意图判断：闲聊、简单问答、你知识范围内的稳定知识——直接回答，绝不调用工具。工具是稀缺资源，能不用就不用。\n'
    + '2. 工具选择：需要最新/实时信息（新闻、价格、赛事等）→ web_search，可换多个关键词搜索；想深入了解某条结果 → web_fetch 读原文；任何精确计算 → calculate（不要心算）；天气 → get_weather；时间 → get_time；用户明确告知的长期事实（偏好、生日、项目、城市等）→ remember；用户明确要求把长内容存成文档 → save_doc（同名覆盖即更新；同一网址只保存一次，勿换标题重复保存）；用户明确要求删除文档 → delete_doc；用户问题可能涉及知识库文档主题 → 先 list_docs 看标题，有相关再 read_doc 细读（标题想不起来时 read_doc 会自动搜正文），文档内容优先引用并注明"据知识库文档《xxx》"。\n'
    + '3. 多步规划：允许先搜索再抓取、先计算再汇总，一次可并行调用多个工具；但每次只规划接下来 1-2 步，拿到结果再决定下一步，不要一次规划过长链条。\n'
    + '4. 诚实：工具没给的信息绝不编造；搜索无结果就直说。\n'
    + '5. 语言：默认用中文回答（用户用其他语言时跟随用户语言）。\n'
    + '6. 含糊处理：问题缺少关键信息且工具无法补足时（如查天气没说城市），用一句话追问，不要猜测调用工具。\n'
    + '7. 技术细节隔离：最终回答里绝不出现函数名、参数 JSON、调用标记等技术细节，只呈现结论本身。\n\n';
  p += '【输出要求】\n'
    + '- 重要结论先行，结构清晰，适合手机阅读；代码用代码块。\n'
    + '- 引用网络信息给出结论即可，不必罗列链接（除非用户要求）；数据注明来源与时间（如"据今日搜索"），不确定的信息明确标注。\n\n';
  if (memories.length) {
    const qTokens = memoryTokens(query);
    const scored = memories.map((m) => {
      const fSet = new Set(memoryTokens(m.fact)); // Set 查找 O(1)，记忆量大也不慢
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
    + '- remember 只用于用户明确要求记住的长期事实，不要把临时对话内容存进去。\n'
    + '- save_doc 是唯一能写知识库文档的途径：只有它返回成功，才可以告诉用户"已保存/已生成文档"；没有调用成功就不许声称。长文档用 save_doc，不要用 remember 硬塞。\n'
    + '- 知识库优先：read_doc 读到的文档内容优先于通用知识和训练记忆引用，引用时注明"据知识库文档《标题》"。\n'
    + '- 同一工具用相同参数反复调用没有意义：换关键词/换思路，仍无进展就基于已有信息直接回答。\n'
    + '- 当你觉得已经掌握足够信息，直接给出最终答案，不要为了调用工具而调用工具。';
  return p;
}

export {
  buildAgentSystemPrompt,
};
