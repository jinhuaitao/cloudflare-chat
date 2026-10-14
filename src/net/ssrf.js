// SSRF 防护：拦截内网 / 本机 / 云元数据地址（_worker.js 原第 532-587 行）

// ==================== SSRF 防护（v6.8.1） ====================
// web_fetch 的目标 URL 来自模型输出（可被用户 prompt 间接操控），必须拦截
// 内网 / 本机 / 云元数据地址，防止 Worker 被当成代理去探测内网或借出口 IP 攻击第三方。
// Workers 拿不到底层 DNS，做两层拦截：
//  1) 字面量私网 IP —— WHATWG URL 解析会自动把十进制/十六进制/八进制写法归一化为
//     点分十进制（如 http://2130706433/ → 127.0.0.1、http://0x7f.0.0.1/ → 127.0.0.1），
//     因此只需判断归一化后的 hostname；
//  2) 危险主机名（localhost、各类云元数据服务域名）。
// 残余风险：DNS 重绑定（域名先解析到公网、TTL 过期后指向内网）。Workers 无法在建连时
// 做二次校验，如需彻底封堵请在前置 WAF / 出站代理层限制。
function isBlockedFetchHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return true;
  // —— 危险主机名 ——
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === 'metadata.google.internal' || h.endsWith('.metadata.google.internal')) return true;
  if (h === 'instance-data' || h === 'instance-data.compute.internal') return true;
  if (h === 'metadata.azure.internal' || h === 'metadata') return true;
  if (h === '169.254.169.254.nip.io' || h.endsWith('.169.254.169.254.nip.io')) return true;
  // —— IPv4 私网段 ——
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const b = [+v4[1], +v4[2], +v4[3], +v4[4]];
    if (b.some(n => n > 255)) return true; // 越界收尾，宁可拦截
    if (b[0] === 10) return true;                          // 10.0.0.0/8
    if (b[0] === 127) return true;                         // 127.0.0.0/8 回环
    if (b[0] === 169 && b[1] === 254) return true;          // 169.254.0.0/16（含云元数据）
    if (b[0] === 172 && b[1] >= 16 && b[1] <= 31) return true; // 172.16.0.0/12
    if (b[0] === 192 && b[1] === 168) return true;          // 192.168.0.0/16
    if (b[0] === 0) return true;                           // 0.0.0.0/8
    if (b[0] === 100 && b[1] >= 64 && b[1] <= 127) return true; // 100.64.0.0/10
    if (b[0] === 192 && b[1] === 0 && b[2] === 2) return true;   // TEST-NET-1
    if (b[0] === 198 && b[1] === 51 && b[2] === 100) return true; // TEST-NET-2
    if (b[0] === 203 && b[1] === 0 && b[2] === 113) return true;  // TEST-NET-3
    return false;
  }
  // —— IPv6（hostname 可能带方括号） ——
  const h6 = h.replace(/^\[|\]$/g, '');
  if (h6.indexOf(':') !== -1) {
    // 内嵌点分十进制的 IPv4 映射地址，如 ::ffff:127.0.0.1 → 按 IPv4 再判一次
    const tail = h6.slice(h6.lastIndexOf(':') + 1);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) return isBlockedFetchHost(tail);
    const flat = h6.replace(/:/g, '');
    if (flat === '1') return true;            // ::1 回环
    if (/^fe[89ab]/.test(flat)) return true;  // fe80::/10 链路本地
    if (/^(fc|fd)/.test(flat)) return true;   // fc00::/7 唯一本地
    if (flat.startsWith('ffff') && flat.length >= 12) { // ::ffff:a.b.c.d 纯十六进制形式
      const hex = flat.slice(-8);
      const b = [];
      for (let k = 0; k < 8; k += 2) b.push(parseInt(hex.slice(k, k + 2), 16));
      return isBlockedFetchHost(b.join('.'));
    }
    return false;
  }
  return false;
}

export {
  isBlockedFetchHost,
};
