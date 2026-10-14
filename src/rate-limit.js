// 按 IP 滑动窗口限流（isolate 级内存，轻量防刷）（_worker.js 原第 147-164 行）

// ======= 按 IP 滑动窗口限流（isolate 级内存，轻量防刷） =======
// 环境变量 RATE_LIMIT_PER_MIN：每 IP 每分钟允许的 /api/chat 请求数，默认 60；设为 0 关闭。
const rateLimitMap = new Map();
function hitRateLimit(request, env) {
  const perMin = parseInt(env.RATE_LIMIT_PER_MIN || '60', 10);
  if (!(perMin > 0)) return false;
  const ip = request.headers.get('CF-Connecting-IP')
    || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim()
    || 'unknown';
  const now = Date.now();
  let arr = rateLimitMap.get(ip) || [];
  arr = arr.filter(t => now - t < 60000);
  if (arr.length >= perMin) return true;
  arr.push(now);
  rateLimitMap.set(ip, arr);
  if (rateLimitMap.size > 5000) {
    // v6.8.9：不再整体 clear() —— 那会瞬间清空所有限流记录，等于限流整体失效，
    // 换个 isolate 触发一次就能白名单刷请求。改为按最近命中时间淘汰最旧的一半。
    // arr 已按 60 秒窗口过滤，末尾元素即该 IP 的最近命中时间。
    const entries = [...rateLimitMap.entries()]
      .sort((a, b) => ((b[1][b[1].length - 1] || 0) - (a[1][a[1].length - 1] || 0)));
    rateLimitMap.clear();
    const keep = Math.floor(5000 / 2);
    for (let i = 0; i < keep && i < entries.length; i++) rateLimitMap.set(entries[i][0], entries[i][1]);
  }
  return false;
}

export {
  hitRateLimit,
};
