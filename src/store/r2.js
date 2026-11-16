// 持久化层：R2 读写删。
//
// v7.20.0「R2 提速」：把所有 R2 流量收敛到这一层统一处理，业务模块不再各自
// 关心重试、并发合并与条件写。四件事：
//   1) 瞬时错误重试 —— R2 偶发 5xx / 网络抖动时，旧版是静默吞错返回 null，
//      上层把「读失败」当成「没有数据」：记忆被当成空、注册表被当成缺失并重建。
//      现在按 50ms / 150ms 退避重试一次，仍失败才交出 null（并把失败计入指标）。
//   2) 单飞（single-flight）—— 同一 isolate 内并发的同一个 key 只打一次 R2。
//      一轮对话里 loop.js 与工具层可能同时读注册表 / 记忆，旧版是各读一次。
//   3) 条件写（CAS）—— put 支持 onlyIf.etagMatches，让「整表读-改-写」的注册表
//      在不加锁的前提下避免互相覆盖（详见 kb/registry.js）。
//   4) 指标 —— AGENT_DEBUG_STATS=1 时能打印读/写/命中/重试次数，调优不靠猜。
//
// v6.3.1 起彻底移除 KV，只用 R2：无日写入上限（免费版每月 100 万次 A 类操作）、
// 单对象可达 5TB、读写强一致。未绑定 R2 时退化为纯内存
// （isolate 重启丢失；Telegram 机器人需要持久化，请务必绑定 R2）。

// 瞬时错误的重试间隔（毫秒）。两次足够覆盖绝大多数抖动，再多只是把用户等待拉长。
const R2_RETRY_DELAYS_MS = [50, 150];
// 单飞表上限：isolate 内存有限，超过就整体清空（在飞请求各自仍会正常返回）
const R2_INFLIGHT_MAX = 512;

const r2Stats = { get: 0, getShared: 0, getMiss: 0, put: 0, del: 0, retry: 0, fail: 0, conflict: 0 };

function isTransientError(err) {
  const m = String((err && (err.message || err)) || '').toLowerCase();
  if (!m) return false;
  return /network|connect|socket|timeout|timed out|temporar|try again|rate limit|429|500|502|503|504|internal error/.test(m);
}

// 统一重试：只对瞬时错误重试，参数错误 / 权限错误立刻上抛，不浪费时间
async function withRetry(fn) {
  let lastErr;
  for (let i = 0; i <= R2_RETRY_DELAYS_MS.length; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === R2_RETRY_DELAYS_MS.length || !isTransientError(e)) break;
      r2Stats.retry += 1;
      await new Promise(r => setTimeout(r, R2_RETRY_DELAYS_MS[i]));
    }
  }
  r2Stats.fail += 1;
  throw lastErr;
}

// 单飞：并发读同一个 key 复用同一个 promise。注意返回值必须是不可变的字符串，
// 上层拿到后各自解析，不会互相污染。
const inflight = new Map();
function shareInflight(key, fn) {
  const hit = inflight.get(key);
  if (hit) {
    r2Stats.getShared += 1;
    return hit;
  }
  const wrapped = (async () => fn())().finally(() => {
    if (inflight.get(key) === wrapped) inflight.delete(key);
  });
  if (inflight.size >= R2_INFLIGHT_MAX) inflight.clear();
  inflight.set(key, wrapped);
  return wrapped;
}

async function rawGet(env, key, range) {
  r2Stats.get += 1;
  const obj = await withRetry(() => env.R2.get(key, range ? { range } : undefined));
  // 条件读（onlyIf 不满足）与对象不存在都会走到这里：body 为 null 表示没有内容
  if (!obj || obj.body === null) {
    r2Stats.getMiss += 1;
    return null;
  }
  return await obj.text();
}

async function storeGet(env, key, opts) {
  if (!env || !env.R2) return null;
  const o = opts || {};
  const range = o.range || null;
  // 不同 range 不能共用同一次请求
  const shareKey = range ? key + '|' + (range.offset || 0) + ':' + (range.length || '') : key;
  const load = () => rawGet(env, key, range).catch(() => null);
  return o.share === false ? await load() : await shareInflight(shareKey, load);
}

// 带元数据的读：etag 供条件写（CAS）使用，size 供调用方做预算判断。
// failed=true 表示「读失败」而不是「对象不存在」—— 这两件事对调用方含义完全不同
// （读失败不该被当成空数据，否则会触发无谓的全量重建甚至覆盖写）。
async function storeGetMeta(env, key) {
  if (!env || !env.R2) return { text: null, etag: '', size: 0, failed: false };
  try {
    r2Stats.get += 1;
    const obj = await withRetry(() => env.R2.get(key));
    if (!obj) {
      r2Stats.getMiss += 1;
      return { text: null, etag: '', size: 0, failed: false };
    }
    const text = obj.body === null ? null : await obj.text();
    return { text, etag: String(obj.etag || ''), size: Number(obj.size) || 0, failed: false };
  } catch (e) {
    return { text: null, etag: '', size: 0, failed: true };
  }
}

// 字节范围读：只取需要的一段，避免为了看 200 字把 20 万字的文档整篇拉下来
async function storeGetRange(env, key, offset, length) {
  const off = Math.max(0, parseInt(offset, 10) || 0);
  const len = Math.max(1, parseInt(length, 10) || 1);
  return await storeGet(env, key, { range: { offset: off, length: len }, share: false });
}

async function storePut(env, key, value, opts) {
  if (!env || !env.R2) return;
  try {
    r2Stats.put += 1;
    await withRetry(() => env.R2.put(key, String(value), opts));
  } catch (e) {}
}

// v6.8.3：带成功返回的 R2 写入。storePut 静默吞错，只用于"尽力而为"的场景；
// 知识库/记忆写入必须诚实——没存上就要让 Agent 知道，而不是谎称成功。
async function storePutChecked(env, key, value, opts) {
  if (!env || !env.R2) return false;
  try {
    r2Stats.put += 1;
    await withRetry(() => env.R2.put(key, String(value), opts));
    return true;
  } catch (e) {
    return false;
  }
}

// 条件写（compare-and-set）：只有 R2 里的对象 etag 仍是 expectEtag 时才写入。
// 返回 { ok, conflict, cas }：
//   · ok=true            写入成功（cas=true 表示真的走了条件写）
//   · ok=false, conflict 预条件失败：别人先改了，调用方应重读后重算
//   · ok=false, cas=false 运行时不支持条件写时已退化为普通写（不会丢数据，只是失去互斥）
async function storePutCas(env, key, value, expectEtag, opts) {
  if (!env || !env.R2) return { ok: false, conflict: false, cas: false };
  const body = String(value);
  if (!expectEtag) {
    const ok = await storePutChecked(env, key, body, opts);
    return { ok, conflict: false, cas: false };
  }
  r2Stats.put += 1;
  try {
    const res = await env.R2.put(key, body, Object.assign({}, opts, { onlyIf: { etagMatches: expectEtag } }));
    // 真实 R2 在预条件失败时返回 null；内存桶（测试）返回 undefined 视为成功
    if (res === null) {
      r2Stats.conflict += 1;
      return { ok: false, conflict: true, cas: true };
    }
    return { ok: true, conflict: false, cas: true };
  } catch (e) {
    // onlyIf 不被支持（老运行时 / 参数非法）→ 退化成普通写，绝不让优化变成丢数据
    const ok = await storePutChecked(env, key, body, opts);
    return { ok, conflict: false, cas: false };
  }
}

async function storeDelete(env, key) {
  if (!env || !env.R2) return false;
  try {
    r2Stats.del += 1;
    await withRetry(() => env.R2.delete(key));
    return true;
  } catch (e) {
    return false;
  }
}

// list 也带重试：注册表核对/镜像清理都靠它，抖动时不该把「列不出来」当成「没有文件」
async function storeList(env, opts) {
  if (!env || !env.R2) return { objects: [], truncated: false };
  try {
    return await withRetry(() => env.R2.list(opts || {}));
  } catch (e) {
    return { objects: [], truncated: false, failed: true };
  }
}

// 指标：AGENT_DEBUG_STATS=1 时由调用方打印，平时零成本
function r2Snapshot() {
  return Object.assign({}, r2Stats);
}

function r2ResetStats() {
  for (const k of Object.keys(r2Stats)) r2Stats[k] = 0;
}

function r2StatsLine() {
  const s = r2Stats;
  return 'R2 get=' + s.get + '（单飞复用 ' + s.getShared + '，空 ' + s.getMiss + '）'
    + ' put=' + s.put + ' del=' + s.del
    + ' 重试=' + s.retry + ' 失败=' + s.fail + ' 条件写冲突=' + s.conflict;
}

export {
  storeGet,
  storeGetMeta,
  storeGetRange,
  storePut,
  storePutChecked,
  storePutCas,
  storeDelete,
  storeList,
  r2Snapshot,
  r2ResetStats,
  r2StatsLine,
};
