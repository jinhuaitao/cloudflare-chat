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

// 应用版本号（/help 显示；发版时同步 package.json）
// 7.14.0：安全与一致性加固（Durable Object 跨实例协调锁、微信消息确认后推进游标、
//         管理鉴权隔离与凭证 AES-GCM 加密、知识库/记忆先归档后淘汰、Web 输入限量清洗、
//         工具取消与写操作确定语义、DSML 跨分片防泄露、CSP nonce 与 CDN SRI）。
// 7.13.0：第二轮复审后的边界修复（微信打字心跳定时器在异常/早退路径上不再泄漏；
//         所有对外抓取统一走 safeFetch，手动逐跳跟随重定向并每跳校验 SSRF，
//         不再依赖 redirect:'follow' 的落地点；PDF 文本流提取改用无损单字节映射，
//         修掉 TextDecoder('latin1') 实际是 windows-1252 导致的解压失败；
//         知识库修复计数改为随调用返回，不再用模块级全局量跨请求串号；
//         RATE_LIMIT_PER_MIN 配成非法值时退回默认 60 而不是静默关闭限流；
//         Telegram 群组 @ 后接中文标点不再残留在正文；长消息切分阈值随 maxLength 缩放；
//         微信关键持久化写入失败改为可计数并通过 /api/wx/status 暴露）。
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
const APP_VERSION = '7.14.0';
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
