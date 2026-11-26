// 应用版本号与复用的 HTTP 响应头常量

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Access-Token, X-Wx-Admin-Token',
};

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
};

const HTML_HEADERS = { 'Content-Type': 'text/html;charset=UTF-8' };
const TEXT_HEADERS = { 'Content-Type': 'text/plain;charset=UTF-8' };

// 应用版本号（/help 显示；发版时同步 package.json 与 README.md 的版本号，
// CI 会用 npm run check 校验三处一致，防止文档与代码再次脱节）
// 7.44.0：自我进化效果回测加深——回测结论从 4 档扩展为「档位 + 幅度」
//   （当前窗口率 − 基线率，百分点，1 位小数，与 verdict 同一口径：关键词
//   提案看近 miss 率，步数提案看暂停率，只改 ctxBudget 的看暂停+截断率；
//   待观察不给幅度，旧提案无幅度字段写「幅度未记录」）；状态「最近回测」
//   一节每条写标题 + 结论 + 幅度 + 回测日期；幅度只用于展示与通知，
//   自动回滚仍只看 worse 一档，不改变任何自动行为。
// 7.43.0：自我进化提案过期提醒——pending 超过 21 天未处理时周期通知里
//   提醒管理员一次（仍 30 天过期，提醒不改状态、不延过期）；提醒标记
//   存在提案自身的 expiryRemindedAt 上，随 proposals.json 一起存，
//   零新增 R2 key；手动 /evolve run 回复里同样提醒，不另发通知。
// 7.42.0：自我进化影响分校准——score 改为「证据分 × 趋势因子」
//   （窗口按日期对半分：近 7 天是前 3 天 vs 后 4 天；因子
//   1 + 0.2×(后段−前段)/总量，夹在 [0.8, 1.2]，证据强度仍是主因子）；
//   分段数据由 summarizeEvolveDays 随汇总一起算好（evidenceTrend，
//   只用日聚合里已有的数据，不新增 R2 读）；分数构成说明存在提案的
//   scoreDetail 里，list 与详情展示；旧提案无 scoreDetail，按旧分处理。
// 7.41.0：自我进化按会话 A/B（按提案灰度）——应用提案时可指定灰度比例
//   （/evolve approve <id> 50），同一提案在部分会话生效、其余会话走原配置；
//   overlay 按会话逐提案折叠（buildEvolveOverlay 增加可选 chatId 参数），
//   分组用 djb2 + murmur finalizer 哈希（提案 id 拌进输入，同一会话对同一
//   提案永远同一组，不同提案分组独立）；指标在同一份日聚合里按提案分组
//   计数（byProposal，生效组 vs 未生效组），状态里直接对比暂停率。
// 7.40.0：自我进化周报失败补发——周一发送失败时在 state.json 记下
//   失败状态（周键 / 7 天窗口起止 / 失败时间戳 / 失败次数），第二天
//   （周二）的定时周期重试一次，复用失败那次存下的窗口
//   （buildEvolveWeeklyReport(env, weeklyFailAt)，提案计数另有窗口上界）；
//   成功后写去重标记并清掉失败记录，失败两次后不再重试，等下周一正常发；
//   跨到下周一不再补发旧周报，手动 /evolve run 不触发补发。
// 7.39.0：自我进化批量审批 dry-run 预览——「可应用判定」抽成
//   assessEvolveProposalForApply（复核否决 → 校验 → 模拟 → 冲突计算，
//   只读），预览（previewLowRiskEvolveProposals）与真正应用共用同一条
//   判定；预览只算不改（不改状态、不写 R2、不记审计），真正应用时逐条
//   重新评估，预览结论只作参考。单条与批量应用共用 markEvolveProposalApplied
//   写状态，关卡一字不差。
// 7.38.0：自我进化诊断建议升级去重缺口收口——规则循环的 R1c 预检
//   （同一词已有待审批/已应用/已批准的强词提案时不再重复提升级）抽成
//   hasExistingStrongKeywordProposal，与诊断分支共用同一口径：LLM 诊断
//   建议的强关键词改动在生成关联提案前也过这道检查，有已有强词就丢弃
//   （记一条跳过原因，不阻塞周期内其它提案）；弱词提案本身不拦（弱词升
//   强词是升级不是重复），只有已有强词才拦。规则循环本身不动，诊断建议
//   的其它行为（校验、模拟、origin='llm'、永不自动应用）也不动。
// 7.37.0：自我进化工具限流优先级根治——agentLimits 在返回里带一个
//   explicit，逐项标明哪几项是环境变量显式配的（环境变量存在且解析出
//   >0 的数才算显式；写错/写 0/写负数/没写都不算）；evolveLimits 只对
//   未显式配置的项叠加 overlay，已应用的限流提案对显式配过的项不再生效，
//   提案本身仍保持 applied，/evolve 状态单列一行写清哪一项被压住；
//   模拟传 env 时全压住判 fail（周期不生成、应用拒绝）、部分压住判 pass
//   但写清被压住的项；「显式配置优先」从此对人格预算与全局工具限流都成立。
// 7.36.0：自我进化逐次耗时上报——loop.js 在每次真实执行工具调用后就把
//   单次耗时（ms）记进进化指标（evolveOut.stats.toolCalls[i].samples），
//   日聚合里的每工具耗时样本从此是逐次实测，v7.27.0 的 p50/p95 变成真
//   分位数；无 samples 的旧事件回退到轮内平均展开，聚合字段照旧保留。
// 7.35.0：自我进化长期趋势（收尾轮）——/evolve 状态加「上周对比」
//   （本 7 天 vs 上 7 天暂停率，窗口各需 ≥10 轮才下结论；原称「30 天对比」，
//   窗口实际是 14 天数据，v7.45.0 正名）与「最近回测」
//   一节（7 天内有回测结论的已应用提案，最多 5 条）；LLM 诊断建议的
//   关键词改动命中已应用弱词表时打上 upgradeFrom: 'weak' 标记，走弱词
//   升级的展示与冲突豁免口径；收尾复核：修掉 src/evolve/ 注释与 README
//   里发现的不一致（周期实际在 UTC 每天 0 点左右跑、L2 自动应用关键词、
//   工具限流提案会覆盖环境变量显式值——后者记进 ANALYSIS.md 留白）。
// 7.34.0：自我进化批量审批与审计——/evolve approve-low 一次应用全部
//   低风险 pending 普通提案，逐条过校验与模拟、LLM 复核否决的跳过；
//   review 类与 KB 草稿不在批量范围内，高风险不动，有冲突仍可应用但
//   汇总里标注提醒；提案文件顶层多一个 audit 数组（最近 200 条），
//   审批/否决/回滚/自动应用/自动回滚都记一条，只记操作元数据。
// 7.33.0：自我进化失败聚类（R12）——日聚合多一个人格+工具交叉计数
//   byPersonaTool（人格 → 工具 → {calls, fails}，只记数字）；同一组合
//   失败 ≥5 次且失败率 ≥30% 时提一条 review 提案（change: null），标题与
//   rationale 写清人格/工具/失败/调用/失败率，趋势按日期对半分（近 7 天
//   前 3 天 vs 后 4 天）给前段/后段失败次数对比；review 提案多一个 scope
//   字段（'人格:工具'），去重与 id 据此区分同一规则的不同组合；老数据
//   无交叉字段时不提聚类提案、不报错。
// 7.32.0：弱词升级（R1c）——已应用弱词在本窗口近 miss 又 ≥5 次时，
//   提一条弱词升强词的提案（upgradeFrom: 'weak'，复用强词模拟）；
//   原弱词提案保持 applied，overlay 折叠时强词覆盖弱词；已有强词
//   提案时不再重复提升级；升级与源弱词提案不算冲突。
// 7.31.0：KB 缺失主题自动草稿——缺失 ≥3 次的主题周期里自动生成一条
//   draft 草稿（kind='kb-draft'，只存主题词与失败次数，30 天过期，
//   与普通提案存在同一份 proposals.json）；管理员 /evolve kb-draft <id>
//   确认后才调已有整理入库，草稿变 archived；草稿不进 overlay、
//   不参与冲突检测与去重计数，周报也不计入新增提案。
// 7.30.0：自我进化步数耗尽联动预算——某人格暂停率 ≥30% 且截断率 ≥20%
//   时提一条 ctxBudget +4000 的提案（R11，与步数 +1 的 R2 可同时提、
//   不同槽位不冲突）；基线同时快照截断数，回测用暂停+截断合计率复测；
//   沙盒模拟要求 ctxBudget 确实比现状更大（之前只认整数就放行）。
// 7.29.0：自我进化周期周报——每周一（UTC）的定时周期发一条 7 天摘要
//   （总量、暂停率及与上 7 天对比、本周新增/应用/回滚提案数、待审批最高分
//   提案），只在有内容时发，同一周只发一次（state.json 的 lastWeeklyWeek
//   去重，发送失败不写成功标记、记失败状态周二重试一次，v7.40.0）；周一当日变动附在同一条消息里，不发两条；
//   开关 EVO_WEEKLY=0 只关周报，EVO_NOTIFY=0 是总开关；saveEvolveState
//   改为合并写，周期写 lastCycleDay 时不再抹掉周报去重标记。
// 7.28.0：自我进化回滚学习——回滚记原因（rolledBackReason，管理员手写
//   短句限 100 字，自动回滚写「效果回测判 worse」触发依据）与回滚时间
//   （rolledBackAt）；同一改动被回滚后 30 天内不再重复提，按改动内容本身
//   （evolveChangeKey）去重，不看规则；否决仍是 14 天按规则+改动去重；
//   旧回滚记录无原因字段时读出来按缺失处理，去重回退到 decidedAt / createdAt。
// 7.27.0：自我进化工具耗时分位数——日聚合 byTool 每工具多一个有界样本
//   数组 samples（最近 50 次单次调用耗时，毫秒整数，只记数字不记参数与
//   结果；loop.js 上报的是每轮每工具的聚合，样本值取轮内平均 ms/calls
//   展开）；分位数用线性插值（type 7），p50/p95 无样本时为 null；R8 改为
//   p95 ≥ 当前单次超时 × 0.8（调用 ≥10 次）或超时率 ≥30% 任一成立都提
//   单次超时 +5 秒（上限 120000ms），同一工具同一周期只提一条；老数据
//   无 samples 字段时规则回退到只看超时率；合并多天窗口时样本仍有界。
// 7.26.0：自我进化提案冲突检测——只判「同槽位不同值」（同一人格同一
//   关键词不同 strength、同一人格 maxSteps/ctxBudget 各自改成不同值、
//   同一类 tool_limit 改成不同值、同一人格两条不同附言）；生成时与已有
//   pending/applied/approved 提案比，提案带 conflictsWith（无冲突为空
//   数组），/evolve list 与状态动态标出冲突（旧提案被后来者冲突时同样
//   看得到）；冲突只提示不阻塞，应用带冲突提案时返回 conflictWarning。
// 7.25.0：自我进化诊断与自主再往前走——LLM 诊断建议（EVO_LLM_DIAGNOSE=1，
//   review 类提案请模型给一个可执行的配置改动，过校验+模拟才成提案，仍需审批）、
//   弱关键词（近 miss 3~4 次先加弱词）、自主等级 L2（EVO_AUTO_APPLY=2，
//   模拟通过 + LLM 复核通过双门禁自动应用强关键词，弱关键词提案
//   风险为 low、不自动应用）、/evolve kb 一键建档、状态趋势线（近 7 天暂停率）。
// 7.24.0：自我进化闭环收尾——变差自动回滚（EVO_AUTO_ROLLBACK）、对照组对比告警、
//   KB 缺失主题采集（read_doc 失败记主题词）、工具超时规则、周期完成 Telegram 通知、
//   待审批按影响分排序。
// 7.23.0：自我进化完善——沙盒模拟（生成与应用前各跑一次路由模拟）、LLM 复核
//   （/evolve review 手动 + EVO_LLM_REVIEW=1 自动）、灰度 rollout 与对照组指标、
//   微信端 /evolve 管理、提案 30 天过期、已应用提案 7 天效果回测、
//   新增附言/收尾预留规则、EVO_FLUSH_THRESHOLD 可配。
// 7.22.0：自我进化——每轮只记结果数字（渠道/人格/路由/工具分项/暂停/截断/
//         纠正信号，不存原文），内存聚合攒够 10 轮才一次 CAS 落盘；每天
//         一次确定性规则诊断（路由近 miss/步数耗尽/工具失败/知识库读不到/
//         纠正率高），生成提案存 R2，默认只提议不自动改；管理员 /evolve
//         审批/回滚，overlay 由已应用提案折叠推导（关键词/预算/附言/
//         工具限流，克隆人格、不动注册表、不改代码、不碰铁律）；
//         GET /api/evolve/status 只读，Cron 每天只跑一次。
// 7.20.0：R2 提速 + 三层记忆能力升级——L1/L2/L3 合并为单对象 kb/mem3/<chatId>.json
//         （稳态冷读 3 次 GET → 1 次；每轮要点、溢出沉淀、L2 淘汰归档、命中计数
//         同一次 CAS 写入，原子且不丢）；写路径全部 etag 条件写，跨 isolate 冲突
//         重读重算不互相覆盖；旧三键 + 两代 L2 旧键一次性并行迁移（保留回滚）；
//         读失败不再拿空快照覆盖写；hits 搭每轮写入免费落盘（重启不清零）；
//         L1 检索升级分词打分（词序/插字查询不漏检）；L3 注入与 L2/L1 跨层去重。
// 7.19.0：回复关键路径减负——历史保存 / 断点清理从回复发送前的串行 await 改为
//         deferOrAwait（有 ctx 挂 waitUntil 后台跑，无 ctx 并行等待），TG / 微信
//         四条回复路径统一接入；微信诊断日志落盘按 30 秒合并（error/login 保持立即），
//         回复分片不再每片重读 context_token；/clear 三次 R2 清理并行。
// 7.18.0：网页端思考过程改为折叠胶囊——旧版把 reasoning 铺成 160px 常驻滚动框，
//         思考长的模型会让气泡里先出现一大段"自语"，正文被挤到下面；同时正文区还渲染
//         一句「正在深度思考…」占位，与新胶囊标题重复且落在工具轨迹下方。现在默认只留
//         一行「💭 正在深度思考…N 秒」（品牌色 + 呼吸点），点开才看原文，收尾定格为
//         「💭 深度思考 N 秒」，没思考就整块移除；进度条改插在正文之前。
// 7.17.0：网页端 🧭 徽标可展开——服务端把路由明细（结论、命中词、逐阶段分工、打分表）
//         随 agent_persona 事件一并下发，点开即网页版 /agent why；明细随消息落库，
//         切换会话/刷新后仍可展开；旧消息没有明细时回退成原来的静态胶囊。
// 7.16.0：网页端补齐「谁答的」——专家路由结果以 agent_persona 事件下发，
//         消息气泡顶部留一条可回溯的 🧭 摘要（角色 + 命中依据 / 接力链），
//         并随会话消息落 localStorage，切换会话与刷新后仍在；
//         README 核心特性行的角色枚举改为短名同源（此前是一份独立且已过期的 emoji 列表）。
// 7.15.1：跨端文案一致性——人格短名/工具数量改为从注册表派生，修掉 7→12 位扩容后
//         Telegram 帮助、微信菜单、网页按钮提示、README 表格里残留的旧枚举与旧数字；
//         README 人格表的 emoji/名称/步数/预算改为与注册表逐行校验；
//         删除 formatPersonaList 从未被读取的 opts 参数。
// 7.15.0：人格接力——一句话里的显式有序阶段（先…然后…/编号步骤）自动组成协作链，
//         首位角色主导、链上角色依次接力；工具白名单取并集、预算取最大值+2 步、
//         链式提示词不含用户原话（前缀缓存友好）、断点续做恢复整条链。
// 7.14.0：专家人格扩到 12 位（新增产品/代码审查/翻译/规划/体验设计），
//         并补「短追问承接」：当前句信号不足且明显是承接语气时，
//         确定性沿用最近一轮的专业角色（不读 R2、零额外往返）；
//         新增「明确审查意图」裁决，review+代码不再与编程调试同分回落。
// 7.13.1：Agent 热路径性能（路由词表模块级预编译 + 提问只转一次小写，路由 52µs→14µs；
//         explainRoute 与 routePersona 共享同一份打分不再打两遍；
//         每轮收尾的记忆写入改挂 ctx.waitUntil，TG/微信/Web 的最终回复不再串行等一次 R2 写入）。
// 7.13.0：专家人格层（7 个角色：研究/编程/写作/分析/运维/教学/通用，各自带工作方式、输出契约、
//         工具白名单与步数/上下文预算；关键词+结构特征确定性路由，零额外往返且可单测；
//         显式 /agent <id> 固定、/agent auto 自动、/agent list 查看，微信支持中文口令；
//         人格段按桶缓存保住上游前缀缓存，断点存档携带 personaId；工具首次失败附确定性替代路径）。
// 7.12.1：Agent 准确率专项（铁律新增关键数字双源交叉印证与来源冲突取舍规则、搜索关键词
//         语言/年份策略进提示词与工具描述、AGENT_TEMPERATURE 可选低温采样仅对 Agent 步骤生效、
//         收尾作答强制原样引用工具数字并说明来源分歧、搜索结果按归一化 URL 去重防伪多源）。
// 7.12.0：缺陷修复与工程化收尾（网页端知识库只读面板接线：新增 GET /api/kb/list + 侧栏入口 +
//         弹窗 DOM，此前 app-kb.js 是三处断链的死代码；朗读清洗收敛为单一来源 src/ui/speech.js，
//         tts-demo.html 改为生成产物；web_fetch 退出同轮记忆化；同名模型跨通道不再互相吞掉，
//         选择键与下拉显示名唯一化；SSRF / 微信 MD5+AES / 通道配置 / 前端分片约束补齐回归测试；
//         微信分段与口令解析抽到 src/wechat/text.js）。
// 7.10.0：三层记忆（L1 工作记忆自动记录会话要点、溢出沉淀；L2 长期记忆带权重/命中/衰减，
//         容量到顶按衰减分淘汰；L3 归档承接 L1 溢出与 L2 淘汰并可检索），新增 memory 工具，
//         remember 支持 kind/weight，/memory 改为三层视图，/clear 同步清理 L1）。
// 7.9.1：联网工具可用性修复（DDG 反爬挑战页不再被误报为「无结果」、新增 Brave/Bing 网页版与
//        Bing RSS 多后端回退、抓取失败新增阅读器与 Wayback 快照回退、正文提取修复跨标签清理
//        bug 并支持内联 JSON 与 GBK 编码、失败结果负缓存）。
// 7.9.0：Agent 输入边界与容错（外部历史清洗防 prompt 注入 / 非法序列 / 超量、
//        上游空响应自动重试一次、tool_call id 缺失自动补齐、分页工具感知输出预算、
//        批量抓取 + offset 明确拒绝、暂停/超时附已查到的信息摘要、
//        收尾请求超时贴合 deadline）。
// 7.8.0：Agent 运行期性能专项（提示词按变化频率重排、收束提示移出 system 保住上游前缀缓存、
//        工具 Schema 瘦身 9.5% 并复用缓存、单步工具输出按预算分摊、上游请求超时贴合 deadline、
//        记忆/知识库 R2 读取加兜底超时、Web 端流式正文批量下发、DSML 增量扫描、
//        AGENT_DEBUG_STATS 单行耗时统计）。
// 7.7.0：知识库存读性能（注册表并发重建、全库正文检索、L1 缓存按桶隔离与结果缓存、
//        offset 越界预检、列表限流、同步并发、记忆镜像并行写入）。
// 7.6.0：Agent 读取链路与预算升级（工具参数修复、截断可见、裁剪配对安全与硬预算、
//        断点起点修正、流式读取不阻塞、抓取失败语义统一）。
// 7.5.0：Agent 内核加固（工具并发闸门、预算感知超时、步数感知收束、双保险空转熔断、
//        历史轮次压缩）+ 工具箱新增 JSON/正则动作 + 全量回归测试。
const APP_VERSION = '7.45.0';
const PNG_HEADERS = {
  'Content-Type': 'image/png',
  'Cache-Control': 'public, max-age=86400',
  'Access-Control-Allow-Origin': '*',
};

const MANIFEST_HEADERS = {
  'Content-Type': 'application/manifest+json;charset=UTF-8',
  'Cache-Control': 'public, max-age=3600',
  'Access-Control-Allow-Origin': '*',
};

const SW_HEADERS = {
  'Content-Type': 'application/javascript;charset=UTF-8',
  'Service-Worker-Allowed': '/',
  'Cache-Control': 'no-cache',
};

const HEALTH_HEADERS = {
  'Content-Type': 'application/json;charset=UTF-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
};

export {
  CORS_HEADERS,
  SSE_HEADERS,
  HTML_HEADERS,
  TEXT_HEADERS,
  PNG_HEADERS,
  MANIFEST_HEADERS,
  SW_HEADERS,
  HEALTH_HEADERS,
  APP_VERSION,
};
