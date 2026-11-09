// 按 IP 滑动窗口限流（isolate 级内存，轻量防刷）（_worker.js 原第 147-164 行）

// ======= 按 IP 滑动窗口限流（isolate 级内存，轻量防刷） =======
// 环境变量 RATE_LIMIT_PER_MIN：每 IP 每分钟允许的 /api/chat 请求数，默认 60；设为 0 关闭。
const rateLimitMap = new Map();
function hitRateLimit(request, env) {
  const raw = env && env.RATE_LIMIT_PER_MIN;
  // 语义要分清「没配」「配错」「显式关闭」三种：
  //   没配 / 配错 → 用默认 60（fail-safe：配置写错不该等于把限流关掉）
  //   显式 0 或负数 → 主动关闭
  // 旧写法 `parseInt(...) || '60'` 对 'abc' 会得到 NaN，随后 `!(NaN > 0)` 为真，
  // 于是限流被静默关闭 —— 一个拼写错误就把防护整段失效，这是最不该出现的失败方向。
  let perMin;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    perMin = 60;
  } else {
    perMin = parseInt(String(raw), 10);
    if (!Number.isFinite(perMin)) perMin = 60;
  }
  if (perMin <= 0) return false;
  const ip = request.headers.get('CF-Connecting-IP')
    || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim()
    || 'unknown';
  const now = Date.now();
  let arr = rateLimitMap.get(ip) || [];
  arr = arr.filter(t => now - t < 60000);
  if (arr.length >= perMin) return true;
  arr.push(now);
  // v6.9.5：先 delete 再 set，利用 Map 原生插入序维护最近活跃（LRU）顺序，
  // 满额淘汰时直接从 Map 头部顺序删除最旧的一半，复杂度从 O(N log N) 降为 O(N)。
  if (rateLimitMap.has(ip)) rateLimitMap.delete(ip);
  rateLimitMap.set(ip, arr);
  if (rateLimitMap.size > 5000) {
    const dropTarget = Math.floor(rateLimitMap.size / 2);
    let dropped = 0;
    for (const k of rateLimitMap.keys()) {
      if (dropped >= dropTarget) break;
      if (k === ip) continue;
      rateLimitMap.delete(k);
      dropped++;
    }
  }
  return false;
}

export {
  hitRateLimit,
};
