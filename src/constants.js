// 应用版本号与复用的 HTTP 响应头常量

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Access-Token',
};

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
};

const HTML_HEADERS = { 'Content-Type': 'text/html;charset=UTF-8' };
const TEXT_HEADERS = { 'Content-Type': 'text/plain;charset=UTF-8' };

// 应用版本号（/help 显示；发版时同步 package.json）
// 7.1.0：Agent 性能加速与 18 项零密钥工具全功能版。
//  - 性能升级：
//    1) 网页抓取 L1 内存缓存（5min TTL）+ 在途请求合并（in-flight dedup），长网页 offset 翻页续读实现 0ms 延迟；
//    2) 知识库文档正文 L1 内存缓存（120s TTL）+ 词频饱和度（BM25-like）与标题加权相关性检索；
//    3) 消除 kbBackfillMd 在记忆条目已含 file 字段时的冗余 R2.list（Class A 操作），并改为并发加载记忆与注册表；
//    4) 上游模型请求支持 429/502/503/504 自动退避重试与多 Key Round-Robin 故障切换；
//    5) 上游流式实时拦截 <｜DSML｜ 工具标记，消除网页端 XML 闪烁；
//    6) 上下文预算裁剪（trimAgentMessages）自动生成【早期步骤摘要】，防止多步任务丢失早期工具调用记忆而重复调用。
//  - 新增 5 项零密钥工具（总计 18 项）：
//    github_lookup（GitHub 仓库/Release/README 检索）、arxiv_search（arXiv 学术论文检索）、
//    hn_top（Hacker News 实时热榜与技术讨论）、net_lookup（Cloudflare DoH DNS 解析 & IP 归属/ASN 诊断）、
//    toolkit（全能单位换算/SHA哈希/Base64/URL编解码/UUID/字数与Token精确统计）。
//  - 多模态增强：Telegram 图片识图支持直接联动 Agent 工具链。
const APP_VERSION = '7.1.0';
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
