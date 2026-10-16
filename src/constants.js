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
// 7.2.0：Agent 极速引擎与工作效率全面升级版（18 项零密钥工具）。
//  - 工作效率与延迟优化：
//    1) 搜索自动深读（web_search 默认开启 deep_read）：并发预抓前 2 条网页正文摘要并预热 L1 缓存，
//       将「搜索 → 等思考 → 抓网页」2 步串行流程压缩为 1 步完成，端到端耗时降低 40%~55%；
//    2) 对冲并发搜索（Hedged Search）：主搜索源超 2s 未响应自动并发拉起备用源竞速，消除长尾超时；
//    3) 批量并发工具执行：web_fetch 支持最多 3 个 URL 并发抓取、get_weather 支持多城市并发 + 内置 30+ 高频城市零延迟坐标表、
//       exchange_rate 支持多币种并发换算、calculate 支持分号分隔多算式一次计算；
//    4) 同轮记忆化去重（turnToolMemo）+ 2 步快速收敛（连续 2 步重复自动触发 wrapUp 收束答案）；
//    5) 非阻塞异步进度推送（fireProgress）：Telegram 状态编辑不再阻塞大模型请求与工具执行；
//    6) 高密度精简 Tool Schema + 空知识库动态裁剪，每步减少约 30% 工具定义 Token 开销；
//    7) 智能段落/代码块边界截断（truncateToolResult 自动对齐换行并闭合 ``` 代码块）与【早期步骤摘要】压缩。
const APP_VERSION = '7.2.0';
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
