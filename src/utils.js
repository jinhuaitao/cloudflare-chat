// 通用工具：有界内存缓存写入、逗号分隔解析、定长口令比较（_worker.js 原第 4-17,115-129 行）

// v6.8.1 有界内存缓存：isolate 常驻时 Map 只增不减会缓慢泄漏。
// 超过上限时淘汰最早插入的条目（Map 保持插入序）；淘汰只是丢 L1，
// 下次自动回退读 R2，行为安全。
const MEM_CACHE_MAX = 2000;
function mapSetBounded(map, key, value, max) {
  map.set(key, value);
  const limit = max > 0 ? max : MEM_CACHE_MAX;
  // 在 Map 迭代中删除是安全的；跳过刚写入的 key，避免误删本次写入
  for (const k of map.keys()) {
    if (map.size <= limit) break;
    if (k === key) continue;
    map.delete(k);
  }
}
function parseCommaSeparated(str) {
  if (!str) return [];
  return str.split(',').map(s => s.trim()).filter(Boolean);
}

// 定长比较，避免通过响应耗时逐字节猜解口令
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export {
  MEM_CACHE_MAX,
  mapSetBounded,
  parseCommaSeparated,
  safeEqual,
};
