// 专家人格（Persona）注册表 + 确定性路由（v7.13.0）
//
// 为什么要有这一层：
// 同一个通用提示词要同时满足"写文案"和"排查 502"，结果只能写成一份四平八稳的说明书 ——
// 模型知道所有工具，但不知道当前该按哪套工作流做。人格层把「工作方式 + 输出契约 + 工具白名单
// + 预算」拆成可切换的配置：
//   1) 提示词只注入当前角色的一段（200~400 字），比重写整份 system 便宜得多；
//   2) 工具白名单顺手省掉每步重发的 schema（写文案不需要 DNS 诊断与汇率）；
//   3) 调研类给更多步数与上下文，写作类给更少 —— 预算跟着任务形态走。
//
// 关键约束：路由必须是确定性的纯函数。
// 用 LLM 做意图识别要多一次往返（首字延迟 +1~3 秒）且结果不可回归测试；
// 这里用「关键词权重 + 结构特征」打分，命中不足就老实回落到通用人格。
// 宁可漏判（退回通用，行为与旧版一致），也不要误判（把写作任务塞进运维工作流）。

const MIN_SCORE = 3;

// ASCII 关键词按词边界匹配，避免 api 命中 rapid、git 命中 digital
const WORD_RE_CACHE = new Map();
function wordMatcher(word) {
  const w = String(word || '').toLowerCase();
  if (!w) return null;
  let re = WORD_RE_CACHE.get(w);
  if (re !== undefined) return re;
  // 纯 ASCII 且由字母数字与常见符号组成时按词边界匹配，中文直接 includes
  if (/^[a-z0-9+#._-]+$/.test(w)) {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp('(^|[^a-z0-9])' + esc + '([^a-z0-9]|$)', 'i');
  } else {
    re = null;
  }
  WORD_RE_CACHE.set(w, re);
  return re;
}

// 词表在模块加载时预编译一次：每条消息路由时要过 ~150 个词，
// 旧版每个词都重复 String().toLowerCase() + Map 查找，纯属浪费
function compileWords(list) {
  const out = [];
  for (const raw of list || []) {
    const w = String(raw || '').toLowerCase();
    if (!w) continue;
    out.push({ w, re: wordMatcher(w) });
  }
  return out;
}

// ==================== 人格定义 ====================
// tools: null 表示不限制（通用人格保持与旧版完全一致的工具集）
// maxSteps / ctxBudget: 仅在环境变量未显式设置时生效，显式配置永远优先
const PERSONAS = [
  {
    id: 'general',
    name: '通用助手',
    emoji: '🤖',
    tagline: '日常问答与多工具协同',
    useWhen: '闲聊、常识、跨领域问题，或没有明显专业倾向时',
    tools: null,
    maxSteps: 6,
    ctxBudget: 24000,
    strong: [],
    weak: [],
    prompt: '',
  },
  {
    id: 'research',
    name: '研究员',
    emoji: '🔬',
    tagline: '多源交叉验证的深度调研',
    useWhen: '查最新动态、做调研对比、核实事实、看论文与财报',
    tools: ['web_search', 'web_fetch', 'wiki_lookup', 'github_lookup', 'arxiv_search', 'hn_top',
      'exchange_rate', 'memory', 'list_docs', 'read_doc', 'remember', 'save_doc', 'calculate', 'get_time', 'toolkit'],
    maxSteps: 8,
    ctxBudget: 32000,
    strong: ['调研', '综述', '竞品', '财报', '白皮书', '文献', '论文', '最新', '政策', '新闻', '行情',
      '市场', '趋势', '对比', '核实', '事实核查', '资料', '引用', '来源', 'survey'],
    weak: ['查一下', '查查', '搜一下', '搜索', '查找', '多少钱', '价格', '报道', '数据', '信息', 'report'],
    patterns: [{ re: /https?:\/\//i, score: 1, why: 'URL' }],
    prompt: '【当前专家角色】🔬 研究员（research）\n'
      + '目标：把一个模糊问题变成可核查的结论，而不是一堆搜到的原文。\n'
      + '工作方式：\n'
      + '1. 先拆问题：结论依赖哪几个事实，每个事实去哪个源查（官方/一手 > 二手聚合 > 论坛）。\n'
      + '2. 检索面要宽：同一关键结论尽量两个独立来源印证；技术资料优先用英文关键词。\n'
      + '3. 严格区分「已核实事实 / 合理推断 / 尚无定论」，三者不要混在一起写。\n'
      + '输出契约：结论先行（3~5 句），再给关键证据与数字（标时间与来源类型），最后列「仍不确定的点」。'
      + '不要罗列链接，除非用户要求。',
  },
  {
    id: 'coder',
    name: '编程工程师',
    emoji: '🧑‍💻',
    tagline: '能跑、能改、能定位根因',
    useWhen: '写代码、读代码、报错排查、选型与重构',
    tools: ['web_search', 'web_fetch', 'github_lookup', 'memory', 'list_docs', 'read_doc',
      'remember', 'save_doc', 'calculate', 'toolkit', 'get_time'],
    maxSteps: 7,
    ctxBudget: 28000,
    strong: ['代码', '报错', '编译', '函数', '重构', '单元测试', '脚本', '正则', '算法', '数据库',
      '接口', '并发', '内存泄漏', 'python', 'javascript', 'typescript', 'node', 'golang', 'rust',
      'java', 'kotlin', 'swift', 'php', 'sql', 'react', 'vue', 'css', 'html', 'npm', 'git', 'bug',
      'mysql', 'redis', 'mongodb', 'spring', 'django', 'flask', 'fastapi'],
    weak: ['编程', '开发', '实现', '调试', '性能', '优化', '依赖', '框架', '版本', '库', '类型'],
    patterns: [
      { re: /```/, score: 3, why: '代码块' },
      { re: /\b(Traceback|SyntaxError|TypeError|ReferenceError|npm ERR!|segmentation fault)\b/i, score: 3, why: '异常栈' },
    ],
    prompt: '【当前专家角色】🧑‍💻 编程工程师（coder）\n'
      + '目标：给出能直接跑、能直接改的代码，而不是泛泛而谈。\n'
      + '工作方式：\n'
      + '1. 先确认运行环境与版本（语言/框架/依赖）；信息不足时按当前主流稳定版假设，并在回答里明说假设。\n'
      + '2. 涉及具体库、API、版本号、参数名时先查文档或 GitHub，不凭记忆下结论。\n'
      + '3. 排错先定位再修：讲清根因、影响面、最小修复，再给完整片段或 diff。\n'
      + '输出契约：先给结论/修复方案，再给完整可运行代码（含必要 import 与文件路径），'
      + '最后列边界情况与验证方式（怎么跑、预期输出）。涉及删数据、改权限、动生产时必须显式警告。',
  },
  {
    id: 'writer',
    name: '写作编辑',
    emoji: '✍️',
    tagline: '有信息量、有语气、不像 AI',
    useWhen: '写文案、改稿、润色、邮件周报、演讲稿',
    tools: ['web_search', 'web_fetch', 'wiki_lookup', 'memory', 'list_docs', 'read_doc',
      'remember', 'save_doc', 'toolkit', 'get_time'],
    maxSteps: 5,
    ctxBudget: 20000,
    strong: ['文案', '润色', '改写', '重写', '公众号', '小红书', '知乎', '演讲稿', '周报', '软文',
      '种草', '宣传', '广告', '剧本', '小说', '诗歌', '标题', '开头', '结尾', '邮件'],
    weak: ['写', '撰写', '文章', '段落', '语气', '风格', '排版', '字数', '措辞', '精简'],
    prompt: '【当前专家角色】✍️ 写作编辑（writer）\n'
      + '目标：写出有具体信息、有语气、有节奏的文本，而不是模板化套话。\n'
      + '工作方式：\n'
      + '1. 动笔前先定「读者是谁、希望他做什么、用什么语气」，用一句话说明设定。\n'
      + '2. 事实、数据、专有名词不确定就查；宁可留空也不编。\n'
      + '3. 去 AI 味：少用「首先/其次/总之」「在当今社会」「随着…的发展」，少堆排比与空洞形容词；'
      + '多用具体名词、动词和数字。\n'
      + '输出契约：先给可直接使用的正文，再给 2~3 条可选调整方向（更长/更短/更口语）。'
      + '除非用户要求，不要解释创作思路。',
  },
  {
    id: 'analyst',
    name: '数据分析师',
    emoji: '📊',
    tagline: '口径清楚、每一步可复算',
    useWhen: '看报表、算指标、做对比、拆解增长与成本',
    tools: ['calculate', 'toolkit', 'web_search', 'web_fetch', 'exchange_rate', 'get_time',
      'memory', 'list_docs', 'read_doc', 'remember', 'save_doc'],
    maxSteps: 6,
    ctxBudget: 26000,
    strong: ['数据分析', '统计', '报表', '指标', '同比', '环比', '转化率', '复购', '客单价', '毛利',
      '汇总', '透视', '表格', 'excel', 'csv', 'roi', 'gmv', '留存', '漏斗'],
    weak: ['分析', '数据', '计算', '百分比', '增长', '成本', '利润', '排名', '占比', '均值'],
    patterns: [{ re: /(^|\n)\s*\|[^\n]*\|[^\n]*\|/, score: 2, why: '表格' }],
    prompt: '【当前专家角色】📊 数据分析师（analyst）\n'
      + '目标：把数字讲清楚，并且每一步都能复算。\n'
      + '工作方式：\n'
      + '1. 先对齐口径：分子分母、时间范围、单位、是否含税/含运费；口径不明就先声明假设。\n'
      + '2. 计算一律用 calculate 或 toolkit，不心算、不估；多步计算把算式留在回答里。\n'
      + '3. 区分相关与因果：没有对照就写「相关，不足以证明因果」。\n'
      + '输出契约：结论（1~3 条，带数字）→ 关键计算过程 → 数据局限与不确定性。'
      + '表格优先于长段落；数字标单位并统一小数位。',
  },
  {
    id: 'ops',
    name: '运维排障',
    emoji: '🛠️',
    tagline: '分层定位，修复可回滚',
    useWhen: '服务器/网络/证书/容器故障、部署与性能异常',
    tools: ['net_lookup', 'web_search', 'web_fetch', 'github_lookup', 'calculate', 'get_time',
      'memory', 'list_docs', 'read_doc', 'remember', 'save_doc', 'toolkit'],
    maxSteps: 8,
    ctxBudget: 26000,
    strong: ['服务器', '502', '504', '503', 'nginx', '部署', '端口', '防火墙', '证书', '磁盘',
      '日志', '排查', '重启', 'systemd', 'k8s', 'kubernetes', 'docker', 'ssh', '负载', '宕机',
      'oom', 'swap', 'cdn', 'tls', 'ssl'],
    weak: ['报错', '超时', '失败', '内存', 'cpu', '网络', '配置', '容器', '进程', '监控', '告警'],
    prompt: '【当前专家角色】🛠️ 运维排障（ops）\n'
      + '目标：用最短路径把故障定位到具体组件，并给出可回滚的修复。\n'
      + '工作方式：\n'
      + '1. 先分层：DNS → 网络/证书 → 反向代理 → 应用 → 依赖（DB/缓存/磁盘）。\n'
      + '2. 每条判断都要有验证命令与预期输出，不要凭现象直接下结论。\n'
      + '3. 优先只读诊断命令；涉及重启、删文件、改配置、动生产数据时，先说明影响与回滚方式。\n'
      + '输出契约：最可能原因（按概率排序，注明依据）→ 逐步验证命令（可直接复制）→ 修复步骤 → '
      + '回滚方案与后续观察项。命令用代码块，并注明在哪台节点执行。',
  },
  {
    id: 'tutor',
    name: '学习教练',
    emoji: '🎓',
    tagline: '讲人话，讲到真的懂',
    useWhen: '解释概念、入门学习、考前答疑、辨析易混点',
    tools: ['wiki_lookup', 'web_search', 'web_fetch', 'arxiv_search', 'calculate', 'toolkit',
      'memory', 'list_docs', 'read_doc', 'remember', 'save_doc', 'get_time'],
    maxSteps: 6,
    ctxBudget: 22000,
    strong: ['讲解', '解释', '教我', '入门', '通俗', '举个例子', '原理', '是什么', '为什么', '区别',
      '怎么理解', '怎么推导', '自测', '复习', '概念', '定义'],
    weak: ['学习', '理解', '举例', '含义', '作用', '历史', '基础', '进阶'],
    prompt: '【当前专家角色】🎓 学习教练（tutor）\n'
      + '目标：让用户真正理解，而不是复述定义。\n'
      + '工作方式：\n'
      + '1. 先判断用户水平（从提问方式推断），再决定从哪一层切入。\n'
      + '2. 按「一句话直觉 → 具体例子 → 正式定义 → 常见误区」的顺序讲。\n'
      + '3. 用类比，但标明类比在哪里不成立。\n'
      + '输出契约：先用 2~3 句给直觉答案；再分点展开（每点不超过 4 行）；'
      + '最后给 1~2 个自测问题并附答案。除非用户要求，不要一次性倾泻全部细节。',
  },
];

const DEFAULT_PERSONA_ID = 'general';
const PERSONA_IDS = PERSONAS.map(p => p.id);
const PERSONA_MAP = new Map(PERSONAS.map(p => [p.id, p]));

// 词表预编译挂到人格定义上（下划线前缀，外部不应读取）
for (const p of PERSONAS) {
  p._strong = compileWords(p.strong);
  p._weak = compileWords(p.weak);
}

// 硬技术名词：出现时认为提问对象是具体技术栈，而非通识概念
const HARD_TECH_WORDS = new Set(['python', 'javascript', 'typescript', 'node', 'golang', 'rust',
  'java', 'kotlin', 'swift', 'php', 'sql', 'react', 'vue', 'css', 'html', 'npm', 'git',
  'mysql', 'redis', 'mongodb', 'spring', 'django', 'flask', 'fastapi']);

// 兼容常见别名，降低用户记错 id 的成本
const ALIASES = {
  'default': 'general', 'normal': 'general', 'chat': 'general', '通用': 'general', '助手': 'general',
  'research': 'research', '研究': 'research', '调研': 'research', '研究员': 'research',
  'coder': 'coder', 'code': 'coder', 'dev': 'coder', '编程': 'coder', '代码': 'coder', '程序员': 'coder',
  'writer': 'writer', 'write': 'writer', '写作': 'writer', '文案': 'writer', '编辑': 'writer',
  'analyst': 'analyst', 'data': 'analyst', '分析': 'analyst', '数据分析': 'analyst', '数据': 'analyst',
  'ops': 'ops', 'devops': 'ops', '运维': 'ops', '排障': 'ops', 'sre': 'ops',
  'tutor': 'tutor', 'teacher': 'tutor', '教学': 'tutor', '老师': 'tutor', '学习': 'tutor', '讲解': 'tutor',
};

function normalizePersonaId(id) {
  const key = String(id || '').trim().toLowerCase();
  if (!key) return '';
  if (PERSONA_MAP.has(key)) return key;
  return ALIASES[key] || '';
}

function getPersona(id) {
  const key = normalizePersonaId(id);
  return key ? PERSONA_MAP.get(key) : null;
}

function personaById(id) {
  return getPersona(id) || PERSONA_MAP.get(DEFAULT_PERSONA_ID);
}

function listPersonas() {
  return PERSONAS.slice();
}

// 打分（t 必须已转小写）：强信号 3 分 / 弱信号 1 分 / 结构特征按权重加
function scorePersonaLower(persona, t) {
  if (!t) return { score: 0, matched: [] };
  let score = 0;
  const matched = [];
  const strong = persona._strong || compileWords(persona.strong);
  const weak = persona._weak || compileWords(persona.weak);
  for (const cw of strong) {
    if (cw.re ? cw.re.test(t) : t.indexOf(cw.w) !== -1) { score += 3; matched.push(cw.w); }
  }
  for (const cw of weak) {
    if (cw.re ? cw.re.test(t) : t.indexOf(cw.w) !== -1) { score += 1; matched.push(cw.w); }
  }
  for (const p of persona.patterns || []) {
    if (p && p.re && p.re.test(t)) { score += p.score || 0; matched.push(p.why || 'pattern'); }
  }
  return { score, matched };
}

// 对外打分入口（测试与调试用）：内部转小写后走共享实现
function scorePersona(persona, text) {
  return scorePersonaLower(persona, String(text || '').toLowerCase());
}

// 全部非通用人格一次性打分并降序排列；提问只转一次小写（旧版每个角色转一次）
function rankPersonas(text) {
  const t = String(text || '').toLowerCase();
  return PERSONAS
    .filter(p => p.id !== DEFAULT_PERSONA_ID)
    .map(p => ({ persona: p, ...scorePersonaLower(p, t) }))
    .sort((a, b) => b.score - a.score);
}

// 从已排序的打分明细出裁决：命中不足或前两名同分（意图不明确）时回落通用人格
function decideRoute(ranked) {
  const top = ranked[0];
  const second = ranked[1];
  if (!top || top.score < MIN_SCORE) {
    return { persona: PERSONA_MAP.get(DEFAULT_PERSONA_ID), source: 'auto', score: top ? top.score : 0, matched: [], reason: 'low' };
  }
  if (second && second.score === top.score) {
    return { persona: PERSONA_MAP.get(DEFAULT_PERSONA_ID), source: 'auto', score: top.score, matched: [], reason: 'ambiguous' };
  }
  // 「XX 的原理是什么」这类问法容易被教学词吃满，但主语是具体语言/框架/中间件时，
  // 用户要的是工程级解释（版本、源码、坑），不是入门课。此时让 coder 压过 tutor。
  if (top.persona.id === 'tutor') {
    const coder = ranked.find(r => r.persona.id === 'coder');
    if (coder && coder.score >= 3 && coder.matched.some(w => HARD_TECH_WORDS.has(w))) {
      return { persona: coder.persona, source: 'auto', score: coder.score, matched: coder.matched, reason: 'tech' };
    }
  }
  return { persona: top.persona, source: 'auto', score: top.score, matched: top.matched, reason: 'matched' };
}

// 自动路由：命中不足或前两名同分（意图不明确）时回落通用人格
function routePersona(text) {
  return decideRoute(rankPersonas(text));
}

// 统一入口：显式指定（manual）优先，'auto'/空值走路由
function resolvePersona(explicitId, text) {
  const raw = String(explicitId || '').trim().toLowerCase();
  if (raw && raw !== 'auto' && raw !== '自动') {
    const p = getPersona(raw);
    if (p) return { persona: p, source: 'manual', score: 0, matched: [], reason: 'manual' };
  }
  return routePersona(text);
}

// ==================== 路由复盘（/agent why） ====================
// 路由器是确定性的：同一句话任何时候重算结果都一样，所以「为什么这么选」
// 不需要存状态——把最后一句话重新打一遍分就能完整复盘，调词表时也能直接验证。

// 完整打分明细：每个角色得分 + 命中词，外加最终裁决与阈值。
// 与 routePersona 共享同一份打分（旧版打两遍，纯浪费）
function explainRoute(text) {
  const ranked = rankPersonas(text);
  return { ranked, decision: decideRoute(ranked), minScore: MIN_SCORE };
}

const ROUTE_REASON_TEXT = {
  matched: '得分最高且领先第二名',
  tech: '教学词得分最高，但主语是具体技术栈，按工程视角优先',
  low: '最高分不足阈值，意图不明确，回落通用助手',
  ambiguous: '前两名同分，意图不明确，回落通用助手',
  manual: '已手动固定，未走自动路由',
};

// 给「命中：a、b」这类一行说明用；自动路由且选了非通用角色时才有内容
function formatRouteHit(route, maxWords) {
  if (!route || route.source !== 'auto') return '';
  if (!route.persona || route.persona.id === DEFAULT_PERSONA_ID) return '';
  const words = (route.matched || []).slice(0, maxWords || 3);
  if (!words.length) return '';
  return '命中：' + words.join('、');
}

// 完整复盘文本（Telegram / 微信共用，纯文本不依赖 Markdown）
// fixedId：当前固定的人格（'auto' 或 id）；text：要复盘的那句话
function formatRouteWhy(text, fixedId) {
  const q = String(text || '').trim();
  if (!q) return '🧭 还没有可复盘的内容。先随便问点什么，再发 /agent why；也可以直接 /agent why 任意文本 单独复盘一句话。';
  const { ranked, decision, minScore } = explainRoute(q);
  const lines = ['🧭 路由复盘', '问题：' + (q.length > 60 ? q.slice(0, 60) + '…' : q), ''];
  const shown = ranked.filter(r => r.score > 0);
  if (shown.length) {
    for (const r of shown) {
      const words = r.matched.length ? '（' + r.matched.slice(0, 5).join('、') + '）' : '';
      lines.push(r.persona.emoji + ' ' + r.persona.name + '：' + r.score + ' 分' + words);
    }
  } else {
    lines.push('（没有任何角色命中关键词）');
  }
  lines.push('');
  const reasonText = ROUTE_REASON_TEXT[decision.reason] || decision.reason;
  lines.push('结论：' + decision.persona.emoji + ' ' + decision.persona.name + ' —— ' + reasonText + '（阈值 ' + minScore + ' 分）');
  const fixed = fixedId && String(fixedId) !== 'auto' ? personaById(fixedId) : null;
  if (fixed && fixed.id !== DEFAULT_PERSONA_ID) {
    lines.push('注意：你已固定 ' + fixed.emoji + ' ' + fixed.name + '（/agent ' + fixed.id + '），实际对话用它而不是上面的自动结果；发 /agent auto 恢复自动。');
  }
  return lines.join('\n');
}

function personaAllowsTool(persona, name) {
  if (!persona || !Array.isArray(persona.tools)) return true;
  return persona.tools.indexOf(String(name || '')) !== -1;
}

// 注入稳定前缀的角色段；通用人格没有额外段落（保持与旧版提示词字节一致）
function personaPromptBlock(persona) {
  if (!persona || !persona.prompt) return '';
  const note = '（本角色只影响侧重点与输出形态，不覆盖上面的铁律与真实性要求）';
  return persona.prompt + '\n' + note + '\n\n';
}

// 命令回执与帮助文案共用，纯字符串、无副作用
function formatPersonaList(currentId, opts) {
  const isAuto = !currentId || String(currentId) === 'auto';
  const cur = isAuto ? null : personaById(currentId);
  const lines = ['🧭 专家人格（共 ' + PERSONAS.length + ' 个）', ''];
  for (const p of PERSONAS) {
    const mark = (!isAuto && cur && p.id === cur.id) ? '✅ ' : '　 ';
    lines.push(mark + p.emoji + ' ' + p.name + '（' + p.id + '）— ' + p.tagline);
  }
  lines.push('');
  lines.push('当前：' + (isAuto
    ? '🤖 由问题自动选择（按提问匹配，拿不准时用通用助手）'
    : cur.emoji + ' ' + cur.name + '（已固定）'));
  lines.push('切换：/agent <id>｜跟随问题自动选择：/agent auto');
  if (isAuto) lines.push('提示：显式指定一次后就会固定，发送 /agent auto 可恢复自动。');
  return lines.join('\n');
}

function formatPersonaBadge(persona) {
  const p = persona || PERSONA_MAP.get(DEFAULT_PERSONA_ID);
  return p.emoji + ' ' + p.name;
}

export {
  PERSONAS,
  PERSONA_IDS,
  DEFAULT_PERSONA_ID,
  MIN_SCORE,
  normalizePersonaId,
  getPersona,
  personaById,
  listPersonas,
  scorePersona,
  routePersona,
  resolvePersona,
  explainRoute,
  formatRouteHit,
  formatRouteWhy,
  personaAllowsTool,
  personaPromptBlock,
  formatPersonaList,
  formatPersonaBadge,
};
