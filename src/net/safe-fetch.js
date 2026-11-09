// 对外抓取的统一入口：手动跟随重定向，逐跳校验目标主机。
//
// 为什么不用 `redirect: 'follow'`：跟随后的落地点由对端决定。
// 一个公网 URL 返回 `302 Location: http://169.254.169.254/latest/meta-data/`
// 就能绕过入口处对初始 host 的校验 —— 而调用方往往只校验了用户输入的那一次。
//
// 放在 net/ 而不是 agent/tools-web.js：抓取是基础设施，不是 Agent 工具的实现细节。
// 微信通道下载生成图片也要用它（图片来源是上游 API 响应，同样不可信）。
import { isBlockedFetchHost } from './ssrf.js';

const SAFE_FETCH_MAX_HOPS = 5;
const BLOCKED_HOST_MSG = '该地址禁止抓取（内网 / 本机 / 云元数据地址）';

async function safeFetch(url, init, maxHops) {
  const hops = Number.isFinite(maxHops) ? maxHops : SAFE_FETCH_MAX_HOPS;
  const baseOpts = Object.assign({}, init || {});
  let current = String(url || '');

  for (let hop = 0; hop <= hops; hop++) {
    let host = '';
    try { host = new URL(current).hostname; } catch (e) { throw new Error('URL 非法，仅支持 http/https'); }
    if (isBlockedFetchHost(host)) throw new Error(BLOCKED_HOST_MSG);

    const res = await fetch(current, Object.assign({}, baseOpts, { redirect: 'manual' }));

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      try { if (res.body) await res.body.cancel(); } catch (e) {}
      if (!loc) throw new Error('抓取失败：重定向缺少目标地址');
      let next = '';
      try { next = new URL(loc, current).href; } catch (e) { throw new Error('抓取失败：重定向地址非法'); }
      current = next;
      continue;
    }

    // 兜底复核：若运行时或中间层仍然做了跟随，res.url 会是落地点，再查一次
    if (res.url && res.url !== current) {
      let finalHost = '';
      try { finalHost = new URL(res.url).hostname; } catch (e) {}
      if (finalHost && isBlockedFetchHost(finalHost)) {
        try { if (res.body) await res.body.cancel(); } catch (e) {}
        throw new Error(BLOCKED_HOST_MSG);
      }
    }
    return { res, finalUrl: current };
  }

  throw new Error('抓取失败：重定向次数过多（超过 ' + hops + ' 跳），已停止抓取');
}

export { safeFetch, BLOCKED_HOST_MSG, SAFE_FETCH_MAX_HOPS };
