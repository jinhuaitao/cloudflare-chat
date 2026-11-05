// 知识库文档注册表：kb/docs/registry.json 的读写与自愈重建（_worker.js 原第 786-904 行）

import { KB_PREFIX } from '../store/kb.js';
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
// 注册表版本号：每次成功写入 +1，供正文检索缓存判断结果是否过期
let kbRegVersion = 0;
function kbRegistryVersion() { return kbRegVersion; }

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
  try {
    let cursor;
    do {
      const listed = await env.R2.list({ prefix: KB_DOCS_PREFIX, limit: 1000, cursor: cursor });
      for (const o of (listed.objects || [])) {
        if (o.key !== KB_REGISTRY_KEY) objs.push(o);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  } catch (e) {}
  return objs;
}
// 从现有文件重建注册表（读每篇前 4096 字节的 frontmatter），并写回。
// v7.7.0：并发读取（上限 8），文档多时重建耗时从 N × RTT 降到约 N/8 × RTT。
async function kbRebuildRegistry(env) {
  if (!env.R2) return [];
  const objs = await kbListDocObjects(env);
  const reg = await mapLimit(objs, 8, async (o) => {
    let fm = {};
    try {
      // v6.8.4：frontmatter 含长标题/长 source 时 1200 字节可能截断，放大到 4096
      if (o.size > 0) {
        const r = await env.R2.get(o.key, { range: { offset: 0, length: 4096 } });
        if (r) fm = kbParseFrontmatter(await r.text());
      }
    } catch (e) {}
    return {
      file: String(o.key).slice(KB_DOCS_PREFIX.length),
      title: fm.title || kbDocTitleOf(o.key),
      source: fm.source || '',
      tags: kbParseTags(fm.tags),
      size: o.size || 0,
      updated_at: fm.saved_at || (o.uploaded ? new Date(o.uploaded).toISOString() : '')
    };
  });
  await kbSaveRegistry(env, reg);
  return reg.slice();
}
async function kbGetRegistry(env) {
  if (!env || !env.R2) return [];
  const now = Date.now();
  if (cachedRegistry && cachedRegistryBucket === env.R2 && now < cachedRegistryExp) {
    return cachedRegistry.slice();
  }
  try {
    const obj = await env.R2.get(KB_REGISTRY_KEY);
    if (obj) {
      const p = JSON.parse(await obj.text());
      if (Array.isArray(p)) {
        cachedRegistry = p.slice();
        cachedRegistryBucket = env.R2;
        cachedRegistryExp = Date.now() + KB_REG_CACHE_TTL_MS;
        return p.slice();
      }
    }
  } catch (e) {}
  // 缺失或损坏 → 自动重建（自愈）
  return await kbRebuildRegistry(env);
}
// v6.8.4：返回布尔值——注册表写入失败必须让调用方知道，
// 否则会出现"文档已保存但列表/读取找不到"的幽灵成功。
async function kbSaveRegistry(env, reg) {
  if (!env || !env.R2) return false;
  try {
    const list = Array.isArray(reg) ? reg.slice() : [];
    await env.R2.put(KB_REGISTRY_KEY, JSON.stringify(list));
    cachedRegistry = list;
    cachedRegistryBucket = env.R2;
    cachedRegistryExp = Date.now() + KB_REG_CACHE_TTL_MS;
    kbRegVersion += 1;
    return true;
  } catch (e) {
    cachedRegistry = null;
    cachedRegistryExp = 0;
    return false;
  }
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
  kbGetRegistry,
  kbSaveRegistry,
  kbFindRegEntry,
  kbRegistryVersion,
  kbFmtSize,
  kbFmtDate,
};
