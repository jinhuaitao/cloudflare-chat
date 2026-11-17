// 知识库文档注册表：kb/docs/registry.json 的读写与自愈重建（_worker.js 原第 786-904 行）

import { KB_PREFIX } from '../store/kb.js';
import { storeGetMeta, storeGetRange, storeList, storePutChecked, storePutCas } from '../store/r2.js';
import { mapLimit } from '../utils.js';

// ==================== 知识库文档（v6.8.0 重构，v6.9.5 缓存加速）：注册表方案 ====================
// kb/docs/registry.json 是文档的唯一注册表：[{file, title, source, size, updated_at}]。
// save / list / read / delete 全部走注册表：去重与列表都是 O(1)，不再逐篇扫描 frontmatter。
// 注册表缺失或损坏时自动扫描 kb/docs/ 重建（自愈）；registry.json 本身永不计入文档。
// 文件名仍为 kb/docs/<标题>.md（标题清洗，中文保留）。
// v6.9.5：增加 30 秒短期内存缓存（绑定当前 env.R2 实例），写操作穿透更新缓存，
// 避免 Web 端每轮对话及同轮多次工具调用反复读取 R2。
const KB_DOCS_PREFIX = KB_PREFIX + 'docs/';
const KB_REGISTRY_KEY = KB_DOCS_PREFIX + 'registry.json';
const KB_REG_CACHE_TTL_MS = 30 * 1000;

let cachedRegistry = null;
let cachedRegistryBucket = null;
let cachedRegistryExp = 0;
// 注册表当前版本在 R2 里的 etag：条件写（CAS）的前提，写路径用它判断"读到之后有没有人改过"
let cachedRegistryEtag = '';
// 成功写入或回源发现内容 / etag 改变时递增，供正文检索缓存判断结果是否过期。
let kbRegVersion = 0;
function kbRegistryVersion() { return kbRegVersion; }

// 核对成功才记住 30 秒；失败不记忆。同桶并发核对共享一次 list / 重建。
const kbVerification = new WeakMap();
function verificationFor(env) {
  let state = kbVerification.get(env.R2);
  if (!state) {
    state = { exp: 0, inflight: null, revision: 0 };
    kbVerification.set(env.R2, state);
  }
  return state;
}
function kbExpireRegistryVerification(env) {
  if (!env || !env.R2) return;
  const state = verificationFor(env);
  state.exp = 0;
  state.revision += 1;
}

// 文件名由标题清洗得到（去掉 / \ : * ? " < > | # 与控制字符，中文保留；
// 空格直接去掉——避免"甲骨文云 ARM"与"甲骨文云ARM"生成两个文件），超长截断；
// 标题被洗空时用时间戳兜底。
function kbDocSlug(title) {
  let s = String(title || '').trim()
    .replace(/[\/\\:*?"<>|#\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, '')
    .slice(0, 80);
  if (!s) s = 'doc_' + Date.now().toString(36);
  return s;
}
// 原文链接归一化：去首尾空格、去末尾斜杠、转小写
function kbNormSource(u) { return String(u || '').trim().replace(/\/+$/, '').toLowerCase(); }
function kbDocTitleOf(key) {
  let t = String(key || '').slice(KB_DOCS_PREFIX.length);
  if (t.endsWith('.md')) t = t.slice(0, -3);
  return t;
}
// 解析 save_doc 生成的 frontmatter 头（---\nkey: value\n---）
function kbParseFrontmatter(head) {
  const out = {};
  const m = String(head || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    let v = line.slice(i + 1).trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

// v7.11.0：tags 在 frontmatter 里是 "a, b, c" 一行，读出来要还原成数组，
// 否则检索时只能整串匹配，等于没有标签能力。
function kbParseTags(v) {
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean).slice(0, 8);
  return String(v == null ? '' : v)
    .split(/[,，、]/)
    .map(x => x.replace(/^#/, '').trim())
    .filter(Boolean)
    .slice(0, 8);
}

function kbFmtTags(tags) {
  const list = kbParseTags(tags);
  return list.length ? '｜标签：' + list.join('、') : '';
}
// 列出 kb/docs/ 下全部文档对象（分页取全量；自动排除 registry.json）
async function kbListDocObjects(env) {
  const objs = [];
  if (!env.R2) return objs;
  let cursor;
  do {
    const listed = await storeList(env, { prefix: KB_DOCS_PREFIX, limit: 1000, cursor: cursor });
    // 任一页失败都必须丢弃部分列表，不能把它当作空库或完整快照重建。
    if (!listed || listed.failed || !Array.isArray(listed.objects)
      || (listed.truncated && (!listed.cursor || listed.cursor === cursor))) {
      throw new Error('知识库文档列表读取失败');
    }
    for (const o of listed.objects) {
      if (o.key !== KB_REGISTRY_KEY) objs.push(o);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return objs;
}
// 从现有文件重建注册表（读每篇前 4096 字节的 frontmatter），并写回。
// v7.7.0：并发读取（上限 8），文档多时重建耗时从 N × RTT 降到约 N/8 × RTT。
// v7.11.1：支持传入已列好的对象列表，避免校验时重复 list（Class A 操作）；
//          并从 frontmatter 还原 fp / version，让重建后的索引仍能去重与显示版本。
async function kbRebuildRegistry(env, objs) {
  if (!env.R2) return [];
  const state = verificationFor(env);
  const revision = state.revision;
  const list = Array.isArray(objs) ? objs : await kbListDocObjects(env);
  const reg = await mapLimit(list, 8, async (o) => {
    let fm = {};
    try {
      // v6.8.4：frontmatter 含长标题/长 source 时 1200 字节可能截断，放大到 4096
      // v7.20.0：走 storeGetRange —— 只取头 4KB，且享受统一的重试与指标统计
      if (o.size > 0) {
        const head = await storeGetRange(env, o.key, 0, 4096);
        if (head) fm = kbParseFrontmatter(head);
      }
    } catch (e) {}
    const ver = parseInt(fm.version, 10);
    const entry = {
      file: String(o.key).slice(KB_DOCS_PREFIX.length),
      title: fm.title || kbDocTitleOf(o.key),
      source: fm.source || '',
      tags: kbParseTags(fm.tags),
      size: o.size || 0,
      updated_at: fm.saved_at || (o.uploaded ? new Date(o.uploaded).toISOString() : '')
    };
    if (fm.fp) entry.fp = fm.fp;
    if (ver > 0) entry.version = ver;
    return entry;
  });
  const ok = await kbSaveRegistry(env, reg, { verified: true });
  if (ok && state.revision === revision) state.exp = Date.now() + KB_REG_CACHE_TTL_MS;
  return reg.slice();
}

// 索引与真实文件对不上时，以 kb/docs/ 下的实际文件为准重建。
//
// 为什么必须有这一步：注册表是「整表读-改-写」，而 R2 没有事务，Workers 又会多实例并发。
// 两个实例各自用 30 秒内的旧缓存保存文档，后写的那个会把先写的条目整段覆盖掉 ——
// 结果就是「文档正文好好躺在 R2 里，但列表和检索都找不到它」，
// 而且因为 registry.json 本身存在且格式合法，旧逻辑永远不会触发自愈，问题就永久留在库里。
// 这里把「文件」当唯一真相、注册表当可重建索引，索引落后就补回来。
//
// lastRepair 记录「被补回索引」的文档数，供列表工具如实告诉用户索引被修过，
// 而不是让用户以为文档凭空消失。
let lastRepair = 0;
function kbTakeRepairCount() {
  const n = lastRepair;
  lastRepair = 0;
  return n;
}

async function kbVerifyRegistry(env, reg, verify = true) {
  const safe = Array.isArray(reg) ? reg : [];
  if (!env || !env.R2) return { reg: safe, repaired: 0 };
  const state = verificationFor(env);
  if (state.inflight) return state.inflight;
  if (verify === 'auto' && Date.now() < state.exp) return { reg: safe, repaired: 0 };
  const revision = state.revision;
  const pending = (async () => {
    let objs;
    try { objs = await kbListDocObjects(env); } catch (e) {
      // list 失败时宁可用旧索引，也不能把好索引重建没了。
      return { reg: safe, repaired: 0, failed: true };
    }
    const files = new Set(objs.map(o => String(o.key).slice(KB_DOCS_PREFIX.length)));
    const regFiles = new Set(safe.map(e => e && e.file).filter(Boolean));
    // null 表示索引缺失 / 损坏：即便真实文件为空也应生成合法索引。
    let drift = !Array.isArray(reg) || files.size !== regFiles.size;
    if (!drift) { for (const f of files) { if (!regFiles.has(f)) { drift = true; break; } } }
    if (!drift) {
      if (state.revision === revision) state.exp = Date.now() + KB_REG_CACHE_TTL_MS;
      return { reg: safe, repaired: 0 };
    }

    let repaired = 0;
    for (const f of files) if (!regFiles.has(f)) repaired += 1;
    const rebuilt = await kbRebuildRegistry(env, objs);
    // list 期间发生本地写删时，不能让较旧的核对重新延长有效期。
    if (state.revision !== revision) state.exp = 0;
    if (Array.isArray(reg) && repaired > 0) lastRepair += repaired;
    return { reg: rebuilt, repaired: repaired };
  })();
  state.inflight = pending;
  try { return await pending; } finally {
    if (state.inflight === pending) state.inflight = null;
  }
}

// opts.fresh：跳过 30 秒内存缓存，直接读 R2。写路径必须用（否则会覆盖别的实例刚写入的条目）。
// opts.verify：true 强制核对；'auto' 仅在最近 30 秒未成功核对时核对，不一致就重建。
// 空注册表默认走 auto，既能发现外部新增，也不必每次读取都 list。
//
// v7.20.0：读路径带出 etag，写路径改「条件写」——
// 旧版为了防丢更新，每次 save 都要 verify（= 一次 R2 list + 漂移时读全部文档头），
// 那是保存延迟里最贵的一段。现在用 etag 做 CAS：读到 → 改 → 带着 etag 写，
// 有人抢先改过就写不进去，调用方重读重算。互斥效果相同，成本从 list 降到 0。
async function kbGetRegistryEx(env, opts) {
  if (!env || !env.R2) return { reg: [], etag: '' };
  const o = opts || {};
  const now = Date.now();
  if (!o.fresh && cachedRegistry && cachedRegistryBucket === env.R2 && now < cachedRegistryExp) {
    const hit = cachedRegistry.slice();
    if (o.verify || !hit.length) {
      const r = await kbVerifyRegistry(env, hit, o.verify === true ? true : 'auto');
      return { reg: r.reg.slice(), etag: cachedRegistryBucket === env.R2 ? cachedRegistryEtag : '', failed: r.failed };
    }
    return { reg: hit, etag: cachedRegistryEtag };
  }
  try {
    const obj = await storeGetMeta(env, KB_REGISTRY_KEY);
    // 读失败 ≠ 索引不存在：有上一份缓存就先顶着用，绝不因为一次抖动就去重建索引
    if (obj.failed) {
      if (cachedRegistry && cachedRegistryBucket === env.R2) {
        return { reg: cachedRegistry.slice(), etag: cachedRegistryEtag, failed: true };
      }
      return { reg: [], etag: '', failed: true };
    } else if (obj.text) {
      const p = JSON.parse(obj.text);
      if (Array.isArray(p)) {
        if (cachedRegistryBucket !== env.R2 || !cachedRegistry
          || cachedRegistryEtag !== (obj.etag || '')
          || JSON.stringify(cachedRegistry) !== JSON.stringify(p)) {
          kbRegVersion += 1;
          if (cachedRegistryBucket === env.R2 && cachedRegistry) kbExpireRegistryVerification(env);
        }
        cachedRegistry = p.slice();
        cachedRegistryBucket = env.R2;
        cachedRegistryExp = Date.now() + KB_REG_CACHE_TTL_MS;
        cachedRegistryEtag = obj.etag || '';
        if (o.verify || !p.length) {
          const r = await kbVerifyRegistry(env, p.slice(), o.verify === true ? true : 'auto');
          return { reg: r.reg.slice(), etag: cachedRegistryBucket === env.R2 ? cachedRegistryEtag : '', failed: r.failed };
        }
        return { reg: p.slice(), etag: cachedRegistryEtag };
      }
    }
  } catch (e) {}
  // 缺失或损坏 → 自动重建（自愈）；失败时保留上一份缓存，不写空索引。
  const r = await kbVerifyRegistry(env, null);
  const sameBucket = cachedRegistryBucket === env.R2;
  return {
    reg: r.failed && sameBucket && cachedRegistry ? cachedRegistry.slice() : r.reg.slice(),
    etag: sameBucket ? cachedRegistryEtag : '',
    failed: r.failed,
  };
}

async function kbGetRegistry(env, opts) {
  const r = await kbGetRegistryEx(env, opts);
  return r.reg;
}
// v6.8.4：返回布尔值——注册表写入失败必须让调用方知道，
// 否则会出现"文档已保存但列表/读取找不到"的幽灵成功。
// opts.expectEtag：条件写。给了 etag 就只在 R2 里的对象仍是这一版时写入，
// 预条件失败返回 false（调用方重读重算），绝不静默覆盖别人刚写的条目。
async function kbSaveRegistry(env, reg, opts) {
  if (!env || !env.R2) return false;
  const o = opts || {};
  // verified 仅供按完整文件列表重建使用；普通写（包括失败）使自动核对过期。
  if (!o.verified) kbExpireRegistryVerification(env);
  try {
    const list = Array.isArray(reg) ? reg.slice() : [];
    const body = JSON.stringify(list);
    if (o.expectEtag) {
      const res = await storePutCas(env, KB_REGISTRY_KEY, body, o.expectEtag);
      if (!res.ok) {
        // 冲突：缓存已不可信，清掉让下次读回源
        cachedRegistry = null;
        cachedRegistryExp = 0;
        cachedRegistryEtag = '';
        return false;
      }
      cachedRegistry = list;
      cachedRegistryBucket = env.R2;
      cachedRegistryExp = Date.now() + KB_REG_CACHE_TTL_MS;
      cachedRegistryEtag = res.etag || '';
      kbRegVersion += 1;
      return true;
    }
    const ok = await storePutChecked(env, KB_REGISTRY_KEY, body);
    if (!ok) {
      cachedRegistry = null;
      cachedRegistryExp = 0;
      cachedRegistryEtag = '';
      return false;
    }
    cachedRegistry = list;
    cachedRegistryBucket = env.R2;
    cachedRegistryExp = Date.now() + KB_REG_CACHE_TTL_MS;
    // 普通写的 etag 未知，清空避免拿旧 etag 去做条件写
    cachedRegistryEtag = '';
    kbRegVersion += 1;
    return true;
  } catch (e) {
    cachedRegistry = null;
    cachedRegistryExp = 0;
    cachedRegistryEtag = '';
    return false;
  }
}

// 注册表「读-改-条件写」的通用封装：mutate 拿到最新列表的副本，返回新列表（或 null 表示放弃）。
// 冲突（别的实例抢先写入）时自动重读重算，最多 3 轮——跨 isolate 也不会互相覆盖条目。
async function kbMutateRegistry(env, mutate, opts) {
  if (!env || !env.R2) return { ok: false, reg: [] };
  const tries = (opts && opts.tries > 0) ? opts.tries : 3;
  let seed = opts && opts.seedReg ? opts.seedReg : null;
  let etag = opts && opts.seedEtag ? opts.seedEtag : '';
  for (let i = 0; i < tries; i++) {
    if (!seed) {
      const cur = await kbGetRegistryEx(env, { fresh: true });
      if (cur.failed) return { ok: false, reg: cur.reg };
      seed = cur.reg;
      etag = cur.etag;
    }
    const next = await mutate(seed.slice());
    if (!Array.isArray(next)) return { ok: false, reg: seed, skipped: true };
    if (await kbSaveRegistry(env, next, { expectEtag: etag })) return { ok: true, reg: next };
    seed = null;
    etag = '';
  }
  return { ok: false, reg: [] };
}
// 注册表内模糊查找：标题精确相等 > 标题包含 > 标签命中 > slug 归一化 > 文件名包含
// v7.11.0：新增标签命中，让「读一下 Kubernetes 相关的文档」这类按标签检索的需求能落地。
function kbFindRegEntry(reg, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q || !Array.isArray(reg) || !reg.length) return null;
  let exact = null;
  let contains = null;
  let tagHit = null;
  let fileHit = null;
  for (const e of reg) {
    if (!e) continue;
    const title = String(e.title || '').toLowerCase();
    if (!exact && title === q) exact = e;
    if (!contains && title.indexOf(q) !== -1) contains = e;
    if (!tagHit && Array.isArray(e.tags) && e.tags.length) {
      for (const t of e.tags) {
        const tl = String(t || '').toLowerCase();
        if (!tl) continue;
        if (tl === q || tl.indexOf(q) !== -1 || q.indexOf(tl) !== -1) { tagHit = e; break; }
      }
    }
    if (!fileHit && String(e.file || '').toLowerCase().indexOf(q) !== -1) fileHit = e;
    if (exact) break;
  }
  if (exact || contains) return exact || contains;
  if (tagHit) return tagHit;
  // v6.8.4：查询也做 slug 归一化（去空格/特殊字符），"甲骨文云 ARM" 能命中 "甲骨文云ARM"
  let qSlug = '';
  try { qSlug = kbDocSlug(query).toLowerCase(); } catch (e) {}
  if (qSlug) {
    for (const e of reg) {
      if (!e) continue;
      try {
        if (kbDocSlug(e.title || e.file).toLowerCase().indexOf(qSlug) !== -1) return e;
      } catch (ee) {}
    }
  }
  return fileHit;
}
function kbFmtSize(b) {
  b = b || 0;
  return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
}
function kbFmtDate(d) {
  try { const s = new Date(d).toISOString().slice(0, 10); return s === '1970-01-01' ? '' : s; } catch (e) { return ''; }
}

export {
  KB_DOCS_PREFIX,
  KB_REGISTRY_KEY,
  kbDocSlug,
  kbNormSource,
  kbDocTitleOf,
  kbParseFrontmatter,
  kbParseTags,
  kbFmtTags,
  kbListDocObjects,
  kbRebuildRegistry,
  kbVerifyRegistry,
  kbExpireRegistryVerification,
  kbTakeRepairCount,
  kbGetRegistry,
  kbGetRegistryEx,
  kbSaveRegistry,
  kbMutateRegistry,
  kbFindRegEntry,
  kbRegistryVersion,
  kbFmtSize,
  kbFmtDate,
};
