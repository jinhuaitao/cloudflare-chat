// 应用版本号与复用的 HTTP 响应头常量（_worker.js 原第 22-43,54-77 行）

// 复用 HTTP 响应头结构
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
// 6.9.5：全面性能、可靠性与安全优化。
//  - 前端：流式期间切换/新建/删除会话自动中断保护；/healthz 改为离线按需轮询；消除收尾重复代码高亮；
//  - 后端：修复 L1 缓存可变数组引用污染并加入 TTL；Web 只读端跳过无效 R2 记忆读取；知识库注册表增加短期缓存；
//  - Telegram：「继续」续做不污染历史上下文；长消息分片自动闭合跨片代码块；
//  - 安全：定长口令比对防长度泄露；限流淘汰 O(N) 优化；SSRF 补充保留网段拦截。
const APP_VERSION = '6.9.5';
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

// SW 必须挂在根路径，并显式声明 scope；no-cache 保证新版本能及时下发
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
