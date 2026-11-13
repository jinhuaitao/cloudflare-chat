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
  {
    id: 'product',
    name: '产品经理',
    emoji: '📋',
    tagline: '把想法落成可验收的需求',
    useWhen: '写 PRD、拆需求、设计用户故事、定优先级与验收标准',
    tools: ['web_search', 'web_fetch', 'github_lookup', 'calculate', 'toolkit', 'get_time',
      'memory', 'list_docs', 'read_doc', 'remember', 'save_doc'],
    maxSteps: 7,
    ctxBudget: 28000,
    strong: ['prd', '产品需求', '需求文档', '用户故事', '验收标准', '产品方案', '功能清单',
      '用户旅程', 'mvp', 'roadmap', '产品分析', '竞品分析'],
    weak: ['需求', '产品', '用户', '场景', '优先级', '迭代', '功能', '原型', '分析'],
    prompt: '【当前专家角色】📋 产品经理（product）\n'
      + '目标：把模糊想法落成能讨论、能排期、能验收的产品方案。\n'
      + '工作方式：\n'
      + '1. 先写清目标用户、核心场景、要解决的问题与不做什么；信息不足时只追问最关键的一项。\n'
      + '2. 需求按「用户价值 → 功能流程 → 边界与异常 → 验收标准」展开，优先级说明依据，不只贴 P0/P1 标签。\n'
      + '3. 涉及市场、竞品或行业事实时先查证；区分用户假设、已验证事实与待验证项。\n'
      + '输出契约：先给一句话产品定义，再给结构化需求/方案；功能点必须配可测试的验收条件，'
      + '最后列风险、依赖与下一步。不要写成只有口号的愿景文档。',
  },
  {
    id: 'reviewer',
    name: '代码审查员',
    emoji: '🧐',
    tagline: '先找会出事的地方，再谈风格',
    useWhen: '审查代码、找缺陷与安全风险、评估可读性和测试覆盖',
    tools: ['web_search', 'web_fetch', 'github_lookup', 'calculate', 'toolkit', 'get_time',
      'memory', 'list_docs', 'read_doc', 'remember', 'save_doc'],
    maxSteps: 7,
    ctxBudget: 30000,
    strong: ['代码审查', '审查代码', 'code review', 'review', '评审', '审查', '安全审计', '安全审查',
      '漏洞', '越权', '注入', 'xss', 'csrf', '反序列化', '依赖漏洞'],
    weak: ['代码', '安全', '风险', '规范', '可读性', '复杂度', '重复代码', '边界条件', '测试覆盖'],
    patterns: [{ re: /```/, score: 1, why: '待审代码块' }],
    prompt: '【当前专家角色】🧐 代码审查员（reviewer）\n'
      + '目标：找出会导致错误、数据损坏、安全暴露或维护失控的问题，而不是逐行挑格式。\n'
      + '工作方式：\n'
      + '1. 先理解输入、输出、信任边界与异常路径，再按严重度审查：正确性/安全 > 并发与资源 > 可维护性 > 风格。\n'
      + '2. 每个问题必须引用具体位置，说明触发条件、影响与最小修复；没有依据的猜测标为「需验证」。\n'
      + '3. 安全修复优先采用成熟库与默认拒绝策略，不自行发明密码学或鉴权协议。\n'
      + '输出契约：先列按严重度排序的问题清单（位置/影响/修复），再给关键修复片段，最后列缺失测试。'
      + '未发现问题也要明确说明审查范围与残余风险，绝不保证「完全安全」。',
  },
  {
    id: 'translator',
    name: '翻译与本地化',
    emoji: '🌏',
    tagline: '准确保意，术语与语气一致',
    useWhen: '多语言互译、术语统一、本地化与译文校对',
    tools: ['web_search', 'web_fetch', 'wiki_lookup', 'toolkit', 'get_time',
      'memory', 'list_docs', 'read_doc', 'remember', 'save_doc'],
    maxSteps: 5,
    ctxBudget: 24000,
    strong: ['翻译', '英译中', '中译英', '译成', '译文', '本地化', '术语表', '双语', '对照翻译',
      'translate', 'translation', 'localization', '日文', '法文', '德文'],
    weak: ['英文', '中文', '语言', '术语', '语感', '直译', '意译', '校对'],
    prompt: '【当前专家角色】🌏 翻译与本地化（translator）\n'
      + '目标：准确保留原意、信息与语气，让译文符合目标语言的表达习惯。\n'
      + '工作方式：\n'
      + '1. 先确认源语言、目标语言、读者与用途；目标语言缺失且无法推断时，只追问这一项。\n'
      + '2. 人名、品牌、法律/医学/技术术语不确定就查；保留代码、占位符、标记与数字格式，不漏译、不擅自增删事实。\n'
      + '3. 原文含糊或有歧义时给自然译法并注明歧义；不为了流畅编造原文没有的信息。\n'
      + '输出契约：默认只给可直接使用的译文；用户要求时再加对照表、术语说明或备选译法。'
      + '长文保持原有段落层级，校对场景列出关键修改及理由。',
  },
  {
    id: 'planner',
    name: '项目规划师',
    emoji: '🗓️',
    tagline: '目标拆成步骤，步骤带验收',
    useWhen: '制定计划、拆解任务、排期、识别依赖与项目风险',
    tools: ['web_search', 'web_fetch', 'calculate', 'toolkit', 'get_time',
      'memory', 'list_docs', 'read_doc', 'remember', 'save_doc'],
    maxSteps: 6,
    ctxBudget: 26000,
    strong: ['项目计划', '实施计划', '学习计划', '任务拆解', '排期', '里程碑', '路线图', '甘特图',
      '风险管理', '待办清单', '行动计划', '规划'],
    weak: ['计划', '目标', '步骤', '安排', '进度', '优先级', '资源', '依赖', '验收', '拆解'],
    prompt: '【当前专家角色】🗓️ 项目规划师（planner）\n'
      + '目标：把目标拆成可执行、可追踪、可验收的行动计划。\n'
      + '工作方式：\n'
      + '1. 先明确目标、截止时间、可用资源与硬约束；缺少关键信息时给出带假设的草案，不假装信息齐全。\n'
      + '2. 任务按依赖关系排序，每项写清交付物、负责人占位、预估工作量与完成定义；日期推算用工具。\n'
      + '3. 标出关键路径、并行机会、缓冲与风险预案，避免把所有任务都列成同一优先级。\n'
      + '输出契约：目标与成功标准 → 阶段/任务表（含依赖与验收）→ 风险及应对 → 今天可开始的第一步。'
      + '用户没给团队规模时不虚构人力与精确工期。',
  },
  {
    id: 'designer',
    name: '体验设计师',
    emoji: '🎨',
    tagline: '从场景到界面与可用性细节',
    useWhen: '设计页面、交互流程、设计系统、配色与可用性评审',
    tools: ['web_search', 'web_fetch', 'wiki_lookup', 'toolkit', 'get_time',
      'memory', 'list_docs', 'read_doc', 'remember', 'save_doc'],
    maxSteps: 6,
    ctxBudget: 24000,
    strong: ['ui', 'ux', '交互设计', '视觉设计', '设计系统', '设计稿', '原型图', '页面布局',
      '用户体验', '可用性', '无障碍', '配色方案', '字体系统', '界面设计', '设计一个', '设计一版',
      '设计一套', '设计一下', '页面设计', '登录页', '登录页面', '移动端界面', '设计界面', '设计页面'],
    weak: ['设计', '页面', '组件', '图标', '界面', '交互', '配色', '排版', '海报', '风格'],
    prompt: '【当前专家角色】🎨 体验设计师（designer）\n'
      + '目标：给出能落地的界面与交互方案，而不是「简约高级」这类空泛形容词。\n'
      + '工作方式：\n'
      + '1. 先定用户、核心任务与使用环境，再确定信息层级和主流程；移动端/桌面端不明确时声明假设。\n'
      + '2. 输出布局结构、关键组件、默认/加载/空/错误状态、交互反馈与无障碍要求，颜色给出具体色值。\n'
      + '3. 参考现有产品或设计规范时先查证；不声称已生成图片或设计稿文件，除非工具确实返回成功。\n'
      + '输出契约：设计目标 → 页面/流程结构 → 组件与状态清单 → 视觉规范（色值/字号/间距）→ 可用性检查。'
      + '需要实现时给结构与样式建议，不把纯设计讨论硬转成代码。',
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

// 明确的审查动词：与「写/修代码」同分时优先交给审查员；审查分较低时仍按编程调试处理
const REVIEW_INTENT_WORDS = new Set(['代码审查', '审查代码', 'code review', 'review', '评审', '审查', '安全审计', '安全审查']);

// 兼容常见别名，降低用户记错 id 的成本
const ALIASES = {
  'default': 'general', 'normal': 'general', 'chat': 'general', '通用': 'general', '助手': 'general',
  'research': 'research', '研究': 'research', '调研': 'research', '研究员': 'research',
  'coder': 'coder', 'code': 'coder', 'dev': 'coder', '编程': 'coder', '代码': 'coder', '程序员': 'coder',
  'writer': 'writer', 'write': 'writer', '写作': 'writer', '文案': 'writer', '编辑': 'writer',
  'analyst': 'analyst', 'data': 'analyst', '分析': 'analyst', '数据分析': 'analyst', '数据': 'analyst',
  'ops': 'ops', 'devops': 'ops', '运维': 'ops', '排障': 'ops', 'sre': 'ops',
  'tutor': 'tutor', 'teacher': 'tutor', '教学': 'tutor', '老师': 'tutor', '学习': 'tutor', '讲解': 'tutor',
  'product': 'product', 'pm': 'product', '产品': 'product', '产品经理': 'product', '需求': 'product',
  'reviewer': 'reviewer', 'review': 'reviewer', '审查': 'reviewer', '代码审查': 'reviewer', '代码审查员': 'reviewer',
  'translator': 'translator', 'translate': 'translator', '翻译': 'translator', '翻译官': 'translator', '本地化': 'translator',
  'planner': 'planner', 'plan': 'planner', '规划': 'planner', '计划': 'planner', '项目规划': 'planner', '项目规划师': 'planner',
  'designer': 'designer', 'design': 'designer', '设计': 'designer', '设计师': 'designer', '体验设计': 'designer',
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
  // 「XX 的原理是什么」这类问法容易被教学词吃满，但主语是具体语言/框架/中间件时，
  // 用户要的是工程级解释（版本、源码、坑），不是入门课。此时让 coder 压过 tutor。
  if (top.persona.id === 'tutor') {
    const coder = ranked.find(r => r.persona.id === 'coder');
    if (coder && coder.score >= 3 && coder.matched.some(w => HARD_TECH_WORDS.has(w))) {
      return { persona: coder.persona, source: 'auto', score: coder.score, matched: coder.matched, reason: 'tech' };
    }
  }
  // 明确写了 review/审查，且审查员得分不低于编程调试时，优先按代码审查处理。
  // 这条裁决在同分回落之前，否则「review 这段代码」会被误判成意图不明。
  if (top.persona.id === 'coder') {
    const reviewer = ranked.find(r => r.persona.id === 'reviewer');
    if (reviewer && reviewer.score >= top.score && reviewer.matched.some(w => REVIEW_INTENT_WORDS.has(w))) {
      return { persona: reviewer.persona, source: 'auto', score: reviewer.score, matched: reviewer.matched, reason: 'review' };
    }
  }
  if (second && second.score === top.score) {
    return { persona: PERSONA_MAP.get(DEFAULT_PERSONA_ID), source: 'auto', score: top.score, matched: [], reason: 'ambiguous' };
  }
  return { persona: top.persona, source: 'auto', score: top.score, matched: top.matched, reason: 'matched' };
}

// 自动路由：命中不足或前两名同分（意图不明确）时回落通用人格
function routePersona(text) {
  return decideRoute(rankPersonas(text));
}

// 短追问识别：只有明显的承接语气或指代词才允许沿用上一轮角色。
// 不能把「为什么天空是蓝色的」这种完整新问题当成上一轮的延续。
const FOLLOW_UP_EXACT_RE = /^(继续|接着|然后|还有吗|为什么|为什么呢|为何|怎么|怎么办|可以吗|行不行|好吗|对|对的|好的|好|continue|go on|ok|okay|yes)$/i;
const FOLLOW_UP_PREFIXES = ['继续', '接着', '再来', '再详细', '再简单', '再优化', '再改', '再写', '再看', '再分析',
  '再帮我', '再补充', '补充', '顺便', '基于', '按照', '沿着', '改一下', '优化一下', '展开', '举个例子', '详细一点', '简单一点',
  'continue', 'go on', 'what about', 'how about', 'and then', 'then '];
const FOLLOW_UP_PRONOUN_RE = /(这个|这段|这份|上面|上述|刚才|前述|该方案|这段代码|它|它们)/;

function isFollowUpText(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t || t.length > 120 || t === '再见') return false;
  return FOLLOW_UP_EXACT_RE.test(t)
    || FOLLOW_UP_PREFIXES.some(p => t.startsWith(p))
    || FOLLOW_UP_PRONOUN_RE.test(t);
}

function userMessageText(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
  }
  return '';
}

// 从最近三条更早的用户提问中找专业上下文；不读 R2、不存额外状态
function routeFromHistory(history) {
  if (!Array.isArray(history)) return null;
  let skippedCurrent = false;
  let checked = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m || m.role !== 'user') continue;
    if (!skippedCurrent) { skippedCurrent = true; continue; }
    const previous = userMessageText(m).trim();
    if (!previous) continue;
    checked += 1;
    const r = routePersona(previous);
    if (r.persona.id !== DEFAULT_PERSONA_ID && (r.reason === 'matched' || r.reason === 'tech')) return r;
    if (checked >= 3) break;
  }
  return null;
}

// ==================== 人格接力（多阶段协作链） ====================
// 一句话里出现显式的有序阶段（先…然后…再… / 编号步骤）时，把每个阶段分别路由，
// 组成一条接力链：第一个角色主导本轮执行，其余角色按顺序接力。
// 全程确定性：不用 LLM 做规划，不增加任何额外往返，断点续做与复盘都能完整还原。
const CHAIN_MAX_PERSONAS = 3;
const CHAIN_MAX_SEGMENTS = 4;
const CHAIN_MIN_TEXT_LEN = 12;   // 太短不可能有两个实质阶段
const CHAIN_MAX_TEXT_LEN = 400;  // 超长文本里的连接词多半是行文而非编排
const CHAIN_MIN_SEG_LEN = 4;     // 阶段短于 4 字没有路由价值
// 显式顺序连接词：只认这些，避免把普通句子的顿号/逗号误当阶段切分
const CHAIN_ORDER_WORDS = /然后|接着|随后|之后|再然后|紧接着|顺便|而且|最后/;
const CHAIN_NUMBERED_RE = /(?:^|[\n;；])\s*(?:第[一二三四五六]步|\d{1,2}\s*[.、)）])/;
const CHAIN_LEAD_PREFIX_RE = /^(?:先|首先)\s*/;

// 把一句话切成有序阶段；看不出多阶段时返回 null（保守，宁可漏判）
function splitChainSegments(text) {
  const t = String(text || '').trim();
  if (t.length < CHAIN_MIN_TEXT_LEN || t.length > CHAIN_MAX_TEXT_LEN) return null;
  let raw = null;
  if (CHAIN_NUMBERED_RE.test(t)) {
    raw = t.split(/(?:^|[\n;；])\s*(?:第[一二三四五六]步|\d{1,2}\s*[.、)）])\s*/);
  } else {
    const startsOrdered = CHAIN_LEAD_PREFIX_RE.test(t);
    if (!CHAIN_ORDER_WORDS.test(t) && !(startsOrdered && /再/.test(t))) return null;
    raw = t.split(startsOrdered
      ? /(?:然后|接着|随后|之后|再然后|紧接着|顺便|而且|最后|，?\s*再)/
      : /(?:然后|接着|随后|之后|再然后|紧接着|顺便|而且|最后)/);
  }
  const segs = (raw || [])
    .map(s => String(s || '').replace(CHAIN_LEAD_PREFIX_RE, '').replace(/^[,，、：:；;\s]+|[,，。．.；;！!？?\s]+$/g, '').trim())
    .filter(s => s.length >= CHAIN_MIN_SEG_LEN);
  return segs.length >= 2 ? segs.slice(0, CHAIN_MAX_SEGMENTS) : null;
}

// 接力路由：每个阶段单独打分，收集去重后的非通用角色（保持出现顺序）。
// 首段必须是强信号锚点（≥ MIN_SCORE），否则整句按单意图处理；
// 后续阶段放宽到「任意领域信号」（≥1 分）——上下文已被首段锚定，
// 「然后排个期」这类短句天然只有弱词，但在接力语境下指向是明确的。
// 返回 null 表示这不是多阶段任务，走常规单人格路由。
function routeChain(text) {
  const segs = splitChainSegments(text);
  if (!segs) return null;
  const rankedList = segs.map(seg => rankPersonas(seg));
  const first = rankedList[0][0];
  if (!first || first.score < MIN_SCORE) return null;
  const general = PERSONA_MAP.get(DEFAULT_PERSONA_ID);
  const chain = [first.persona];
  const detail = [{ segment: segs[0], persona: first.persona, score: first.score, matched: first.matched }];
  for (let i = 1; i < segs.length; i++) {
    const top = rankedList[i][0];
    const best = top && top.score > 0 ? top : null;
    if (!best) {
      detail.push({ segment: segs[i], persona: general, score: 0, matched: [] });
      continue;
    }
    detail.push({ segment: segs[i], persona: best.persona, score: best.score, matched: best.matched });
    if (!chain.some(p => p.id === best.persona.id)) chain.push(best.persona);
  }
  if (chain.length < 2) return null;
  return {
    chain: chain.slice(0, CHAIN_MAX_PERSONAS),
    segments: segs,
    detail,
  };
}

// 统一入口：显式指定（manual）优先，'auto'/空值走路由。
// history 可选：当前问题信号不足且明显是短追问时，承接最近的专业角色。
// 路由顺序：手动固定 > 多阶段接力 > 当前句单人格 > 短追问承接。
function resolvePersona(explicitId, text, history) {
  const raw = String(explicitId || '').trim().toLowerCase();
  if (raw && raw !== 'auto' && raw !== '自动') {
    const p = getPersona(raw);
    if (p) return { persona: p, source: 'manual', score: 0, matched: [], reason: 'manual' };
  }
  const chained = routeChain(text);
  if (chained) {
    return {
      persona: chained.chain[0],
      source: 'auto',
      reason: 'chain',
      score: chained.detail.reduce((a, d) => a + d.score, 0),
      matched: [...new Set(chained.detail.flatMap(d => d.matched))].slice(0, 8),
      chain: chained.chain,
      segments: chained.segments,
      chainDetail: chained.detail,
    };
  }
  const direct = routePersona(text);
  if ((direct.reason === 'low' || direct.reason === 'ambiguous') && isFollowUpText(text)) {
    const previous = routeFromHistory(history);
    if (previous) {
      return {
        persona: previous.persona,
        source: 'auto',
        score: previous.score,
        matched: previous.matched,
        reason: 'followup',
        continuedFrom: previous.persona.id,
      };
    }
  }
  return direct;
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
  review: '命中明确审查意图，且审查得分不低于编程调试',
  chain: '一句话里包含多个有序阶段，按阶段接力多位专家',
  low: '最高分不足阈值，意图不明确，回落通用助手',
  ambiguous: '前两名同分，意图不明确，回落通用助手',
  followup: '当前是短追问且本身信号不足，承接上一轮专业话题',
  manual: '已手动固定，未走自动路由',
};

// 给「命中：a、b」这类一行说明用；自动路由且选了非通用角色时才有内容
function formatRouteHit(route, maxWords) {
  if (!route || route.source !== 'auto') return '';
  if (!route.persona || route.persona.id === DEFAULT_PERSONA_ID) return '';
  if (route.reason === 'chain') return '接力：' + (route.chain || []).map(p => p.name).join(' → ');
  if (route.reason === 'followup') return '承接：上一轮' + route.persona.name;
  const words = (route.matched || []).slice(0, maxWords || 3);
  if (!words.length) return '';
  return '命中：' + words.join('、');
}

// 完整复盘文本（Telegram / 微信共用，纯文本不依赖 Markdown）
// fixedId：当前固定的人格（'auto' 或 id）；text：要复盘的那句话
// history 可选：复盘真实对话时传入，才能还原「承接上一轮」的决策
function formatRouteWhy(text, fixedId, history) {
  const q = String(text || '').trim();
  if (!q) return '🧭 还没有可复盘的内容。先随便问点什么，再发 /agent why；也可以直接 /agent why 任意文本 单独复盘一句话。';
  const { ranked, minScore } = explainRoute(q);
  const decision = resolvePersona('auto', q, Array.isArray(history) && history.length ? history : null);
  const lines = ['🧭 路由复盘', '问题：' + (q.length > 60 ? q.slice(0, 60) + '…' : q), ''];
  if (decision.reason === 'chain' && Array.isArray(decision.chainDetail)) {
    lines.push('🔀 检测到多阶段任务，按顺序接力：');
    for (let i = 0; i < decision.chainDetail.length; i++) {
      const d = decision.chainDetail[i];
      const seg = d.segment.length > 24 ? d.segment.slice(0, 24) + '…' : d.segment;
      lines.push('  ' + (i + 1) + '. 「' + seg + '」→ ' + d.persona.emoji + ' ' + d.persona.name + '（' + d.score + ' 分）');
    }
    lines.push('');
    lines.push('结论：' + decision.chain.map(p => p.emoji + ' ' + p.name).join(' → ')
      + '，由 ' + decision.chain[0].name + ' 主导本轮 —— ' + (ROUTE_REASON_TEXT.chain || 'chain'));
  } else {
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
  }
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
  const checklist = '交付自检：直接回应本题；关键事实与数字有依据；假设、限制和不确定项已声明；权限边界未被突破。';
  return persona.prompt + '\n' + note + '\n' + checklist + '\n\n';
}

// 接力链提示段：只包含链上角色与其侧重（tagline），不含用户原话，
// 保证稳定前缀只随「人格组合」变化而不随具体问题变化（上游前缀缓存友好）。
function chainPromptBlock(chain) {
  if (!Array.isArray(chain) || chain.length < 2) return '';
  const steps = chain.map((p, i) => (i + 1) + '. ' + p.emoji + ' ' + p.name + '：' + p.tagline);
  return '【人格接力】本轮任务包含多个有序阶段，按以下顺序切换角色执行：\n'
    + steps.join('\n') + '\n'
    + '要求：先完整交付前一阶段再进入下一阶段；每个阶段的产出用「—— 阶段 N：标题」小标题分隔；'
    + '前一阶段的产出是后一阶段的输入，结论要互相衔接。\n'
    + '（接力只影响各阶段的分工与侧重，不覆盖上面的铁律与真实性要求）\n\n';
}

// 进度条/徽标用的链式标签：🧩产品经理 → 📅项目规划师
function formatChainBadge(chain) {
  if (!Array.isArray(chain) || chain.length < 2) return '';
  return chain.map(p => p.emoji + ' ' + p.name).join(' → ');
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
  splitChainSegments,
  routeChain,
  formatRouteHit,
  formatRouteWhy,
  personaAllowsTool,
  personaPromptBlock,
  chainPromptBlock,
  formatChainBadge,
  formatPersonaList,
  formatPersonaBadge,
};
