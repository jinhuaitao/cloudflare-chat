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
const APP_VERSION = '7.15.0';
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
