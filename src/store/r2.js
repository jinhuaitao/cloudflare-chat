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

const r2Stats = { get: 0, getShared: 0, getMiss: 0, put: 0, list: 0, del: 0, retry: 0, fail: 0, conflict: 0 };

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

const inflightBuckets = new WeakMap();

function shareInflight(env, key, fn) {
  let inflight = inflightBuckets.get(env.R2);
  if (!inflight) {
    inflight = new Map();
    inflightBuckets.set(env.R2, inflight);
  }
  const hit = inflight.get(key);
  if (hit) {
    r2Stats.getShared += 1;
    return hit;
  }
  const wrapped = Promise.resolve().then(fn).finally(() => {
    if (inflight.get(key) === wrapped) inflight.delete(key);
  });
  if (inflight.size >= R2_INFLIGHT_MAX) inflight.clear();
  inflight.set(key, wrapped);
  return wrapped;
}

function invalidateReads(env, keys) {
  const inflight = inflightBuckets.get(env.R2);
  if (!inflight) return;
  const prefixes = (Array.isArray(keys) ? keys : [keys]).map(key => JSON.stringify(key) + '|');
  for (const key of inflight.keys()) {
    if (prefixes.some(prefix => key.startsWith(prefix))) inflight.delete(key);
  }
}

async function rawGetMeta(env, key, range) {
  try {
    return await withRetry(async () => {
      r2Stats.get += 1;
      const obj = await env.R2.get(key, range ? { range } : undefined);
      if (!obj) {
        r2Stats.getMiss += 1;
        return { text: null, etag: '', size: 0, failed: false };
      }
      const text = obj.body === null ? null : await obj.text();
      return { text, etag: String(obj.etag || ''), size: Number(obj.size) || 0, failed: false };
    });
  } catch (e) {
    return { text: null, etag: '', size: 0, failed: true };
  }
}

async function storeGetMeta(env, key, opts) {
  if (!env || !env.R2) return { text: null, etag: '', size: 0, failed: false };
  const range = (opts && opts.range) || null;
  const shareKey = JSON.stringify(key) + '|' + JSON.stringify(range);
  const load = () => rawGetMeta(env, key, range);
  const meta = opts && opts.share === false ? await load() : await shareInflight(env, shareKey, load);
  return { ...meta };
}

async function storeGet(env, key, opts) {
  return (await storeGetMeta(env, key, opts)).text;
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
    await withRetry(() => {
      r2Stats.put += 1;
      return env.R2.put(key, String(value), opts);
    });
    invalidateReads(env, key);
  } catch (e) {}
}

// v6.8.3：带成功返回的 R2 写入。storePut 静默吞错，只用于"尽力而为"的场景；
// 知识库/记忆写入必须诚实——没存上就要让 Agent 知道，而不是谎称成功。
async function storePutChecked(env, key, value, opts) {
  if (!env || !env.R2) return false;
  try {
    await withRetry(() => {
      r2Stats.put += 1;
      return env.R2.put(key, String(value), opts);
    });
    invalidateReads(env, key);
    return true;
  } catch (e) {
    return false;
  }
}

// 空 etag 表示仅在对象不存在时创建；条件写失败绝不能退回覆盖写。
async function storePutCas(env, key, value, expectEtag, opts) {
  if (!env || !env.R2) return { ok: false, conflict: false, cas: false, etag: '' };
  const body = String(value);
  const onlyIf = expectEtag ? { etagMatches: expectEtag } : { etagDoesNotMatch: '*' };
  try {
    const res = await withRetry(() => {
      r2Stats.put += 1;
      return env.R2.put(key, body, { ...opts, onlyIf });
    });
    invalidateReads(env, key);
    if (res === null) {
      r2Stats.conflict += 1;
      return { ok: false, conflict: true, cas: true, etag: '' };
    }
    return { ok: true, conflict: false, cas: true, etag: String((res && res.etag) || '') };
  } catch (e) {
    invalidateReads(env, key);
    return { ok: false, conflict: false, cas: true, etag: '' };
  }
}

async function storeDelete(env, key) {
  if (!env || !env.R2) return false;
  try {
    await withRetry(() => {
      r2Stats.del += 1;
      return env.R2.delete(key);
    });
    invalidateReads(env, key);
    return true;
  } catch (e) {
    return false;
  }
}

// list 也带重试：注册表核对/镜像清理都靠它，抖动时不该把「列不出来」当成「没有文件」
async function storeList(env, opts) {
  if (!env || !env.R2) return { objects: [], truncated: false };
  try {
    return await withRetry(() => {
      r2Stats.list += 1;
      return env.R2.list(opts || {});
    });
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
    + ' put=' + s.put + ' list=' + s.list + ' del=' + s.del
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
