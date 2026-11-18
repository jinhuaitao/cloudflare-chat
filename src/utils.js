// 通用工具：有界内存缓存（支持 LRU 顺序与可选 TTL）、逗号分隔解析、定长口令比较

// v6.8.1 有界内存缓存：isolate 常驻时 Map 只增不减会缓慢泄漏。
// v6.9.5 增强：
//  1) 写入时先 delete 再 set，使 Map 保持最近活跃（LRU）顺序；
//  2) 支持可选 TTL（通过附加时间戳 Map 校验过期），缓解多 isolate 下 L1 缓存永不过期导致的脏读。
const MEM_CACHE_MAX = 2000;
const DEFAULT_CACHE_TTL_MS = 60 * 1000; // 默认 L1 缓存 60 秒过期回源 R2

function mapSetBounded(map, key, value, max, expMap, ttlMs) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (expMap) {
    const ttl = ttlMs > 0 ? ttlMs : DEFAULT_CACHE_TTL_MS;
    expMap.set(key, Date.now() + ttl);
  }
  const limit = max > 0 ? max : MEM_CACHE_MAX;
  for (const k of map.keys()) {
    if (map.size <= limit) break;
    if (k === key) continue;
    map.delete(k);
    if (expMap) expMap.delete(k);
  }
}

function mapGetBounded(map, key, expMap) {
  if (!map.has(key)) return undefined;
  if (expMap) {
    const exp = expMap.get(key);
    if (typeof exp === 'number' && Date.now() > exp) {
      map.delete(key);
      expMap.delete(key);
      return undefined;
    }
  }
  return map.get(key);
}

// 单飞（single-flight）：同一个 key 的并发加载只真正执行一次，其余调用者共享同一个 promise。
// 用在三层记忆的读路径上：一轮对话里 loop.js 与工具层可能同时要同一份记忆，
// 旧版会各读一次 R2（同一 isolate 内完全重复的往返）。
// 约定：fn 必须返回「只读快照」，调用方各自 clone 后再改，避免共享可变对象。
const singleFlightBuckets = new Map();

function singleFlight(namespace, key, fn, max) {
  let map = singleFlightBuckets.get(namespace);
  if (!map) {
    map = new Map();
    singleFlightBuckets.set(namespace, map);
  }
  const hit = map.get(key);
  if (hit) return hit;
  const wrapped = (async () => fn())().finally(() => {
    if (map.get(key) === wrapped) map.delete(key);
  });
  const limit = max > 0 ? max : 256;
  if (map.size >= limit) map.clear();
  map.set(key, wrapped);
  return wrapped;
}

function parseCommaSeparated(str) {
  if (!str) return [];
  return str.split(',').map(s => s.trim()).filter(Boolean);
}

// v7.5.0 并发闸门：按固定并发上限执行异步任务，结果顺序与输入严格一致。
// Agent 单步里模型可能一次吐出 6~8 个 tool_calls，直接 Promise.all 会同时打出
// 同样多的外部请求（R2 / 搜索 / 抓取），既容易触发对端限流，也会在 Workers
// 单 isolate 里抢占 CPU 预算。用闸门把并发压到可配置上限，整体耗时几乎不变。
async function mapLimit(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const n = list.length;
  const out = new Array(n);
  if (!n) return out;
  let max = parseInt(limit, 10);
  if (!(max > 0)) max = 4;
  if (max > n) max = n;
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= n) return;
      out[i] = await fn(list[i], i);
    }
  };
  const workers = [];
  for (let k = 0; k < max; k++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

// v6.9.5 加固：定长比较，消除长度不一致时提前返回导致的口令长度侧信道泄露
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] || 0) ^ (bb[i] || 0);
  }
  return diff === 0;
}

// 从各类文生图接口的响应里提取图片地址。
// 兼容：OpenAI images/generations（data[].url / b64_json）、Gemini inlineData、
// 通义万相 output.results、以及把图片塞进 choices[].message.content 的中转网关。
// 之前两处调用点只认 data[0].url / b64_json / choices[0].message.content 三种结构，
// 其它返回形态一律落到「图片生成失败或未返回格式」，这里统一收敛。
const IMG_URL_KEYS = ['url', 'image_url', 'img_url', 'imageUrl', 'imgUrl', 'link', 'src', 'fileUri', 'file_url', 'download_url'];
// 这些字段的语义就是 base64，值直接按 base64 处理，不依赖长度启发式。
const IMG_B64_STRICT_KEYS = ['b64_json', 'b64', 'base64'];
// 这些字段既可能是 base64 也可能是 URL / 容器，按内容判定。
const IMG_B64_LOOSE_KEYS = ['image', 'img', 'data', 'content'];
const IMG_CONTAINER_KEYS = ['data', 'images', 'image', 'img', 'output', 'result', 'results', 'candidates', 'message', 'delta', 'content', 'parts', 'choices', 'inlineData', 'fileData', 'raw'];

function wrapBase64(s, mime) {
  const v = String(s).trim().replace(/\s+/g, '');
  if (!v || !/^[A-Za-z0-9+/=]+$/.test(v)) return null;
  // mime 可能是 'image/jpeg' 这样的完整类型，也可能是 'jpeg' 简写，避免重复前缀
  let mt = String(mime || '').trim();
  if (!mt) mt = 'image/png';
  else if (!mt.startsWith('image/')) mt = 'image/' + mt;
  return `data:${mt};base64,${v}`;
}

function looksLikeImageUrl(s, mime) {
  if (typeof s !== 'string') return null;
  const v = s.trim();
  if (/^(https?:\/\/|data:image\/|gs:\/\/)/i.test(v)) return v;
  // content 里嵌的 markdown 图片
  const m = /!\[[^\]]*\]\(([^)\s]+)\)/.exec(v);
  if (m && /^(https?:\/\/|data:image\/)/i.test(m[1])) return m[1];
  // 长裸 base64（无明确字段语义时的兜底判定）
  if (v.length > 128 && /^[A-Za-z0-9+/=\r\n]+$/.test(v)) return wrapBase64(v, mime);
  return null;
}

function findImageUrl(j) {
  const walk = (node, depth) => {
    if (depth > 6 || node == null) return null;
    if (typeof node === 'string') return looksLikeImageUrl(node);
    if (Array.isArray(node)) {
      for (const it of node) {
        const r = walk(it, depth + 1);
        if (r) return r;
      }
      return null;
    }
    if (typeof node !== 'object') return null;
    const ctype = String(node.content_type || node.contentType || '');
    const mime = node.mimeType || node.mime_type || (ctype.startsWith('image/') ? ctype : '');
    // URL 类字段：按内容判定
    for (const k of IMG_URL_KEYS) {
      if (node[k] == null) continue;
      const r = looksLikeImageUrl(node[k], mime);
      if (r) return r;
      if (typeof node[k] === 'object') {
        const rr = walk(node[k], depth + 1);
        if (rr) return rr;
      }
    }
    // 明确的 base64 字段（b64_json / b64 / base64）：直接按语义包装
    for (const k of IMG_B64_STRICT_KEYS) {
      if (typeof node[k] === 'string' && node[k].trim()) {
        const r = wrapBase64(node[k], mime);
        if (r) return r;
      }
    }
    // 宽松字段：先按内容判定，是对象则递归
    for (const k of IMG_B64_LOOSE_KEYS) {
      if (node[k] == null) continue;
      // 有 mimeType/content_type 佐证时（如 Gemini inlineData），data/image 就是 base64，
      // 直接按语义包装，不依赖长度启发式。
      if (mime && (k === 'data' || k === 'image' || k === 'img') && typeof node[k] === 'string') {
        const r = wrapBase64(node[k], mime);
        if (r) return r;
      }
      const r = looksLikeImageUrl(node[k], mime);
      if (r) return r;
      if (typeof node[k] === 'object') {
        const rr = walk(node[k], depth + 1);
        if (rr) return rr;
      }
    }
    // 容器字段：递归下钻
    for (const k of IMG_CONTAINER_KEYS) {
      if (node[k] == null) continue;
      const rr = walk(node[k], depth + 1);
      if (rr) return rr;
    }
    return null;
  };
  return walk(j, 0);
}

// 返回可直接塞进前端 Markdown 渲染的字符串：图片链接，或 choices 里的文本内容。
function extractImageMarkdown(j) {
  const u = findImageUrl(j);
  if (u) return `![生成结果](${u})`;
  const ch = j && j.choices && j.choices[0];
  const m = ch && (ch.message || ch.delta);
  if (m && typeof m.content === 'string' && m.content) return m.content;
  return null;
}

// 收尾写入延后：历史保存 / 断点清理这类「必须完成、但不挡用户看回复」的持久化操作，
// 旧版在回复发送前逐个 await，每条消息都在关键路径上多等一两个 R2 往返。
// 有 Workers 执行上下文时挂 waitUntil（响应发出后平台保证跑完），
// 没有（测试 / 直接调用）就并行等待，语义与旧版一致。
// 注意：任务在调用前已启动（Promise 已创建），这里只决定"等不等、挂在哪"。
async function deferOrAwait(ctx, tasks) {
  const list = (Array.isArray(tasks) ? tasks : [tasks]).map(t => Promise.resolve(t));
  if (!list.length) return;
  const all = Promise.all(list).catch(() => {});
  if (ctx && typeof ctx.waitUntil === 'function') {
    try { ctx.waitUntil(all); return; } catch (e) {}
  }
  await all;
}

export {
  MEM_CACHE_MAX,
  DEFAULT_CACHE_TTL_MS,
  mapSetBounded,
  mapGetBounded,
  singleFlight,
  mapLimit,
  parseCommaSeparated,
  safeEqual,
  findImageUrl,
  extractImageMarkdown,
  deferOrAwait,
};
