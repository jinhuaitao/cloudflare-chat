// Agent 工具：知识库文档的保存 / 列表 / 读取（支持分页 offset） / 多关键词分词检索 / 删除
// v7.1.0 性能优化：新增文档正文 L1 内存缓存（支持长文档 0ms 翻页与多轮全文检索加速）+ 标题/词频加权相关性算法
// v7.7.0 存读性能：
// 1) L1 缓存按 R2 桶隔离（WeakMap），多桶 / 测试环境不再串档；
// 2) 检索复用小写正文缓存（同一篇文档只 toLowerCase 一次），并用「长词是否出现」提前排除整篇；
// 3) 正文检索覆盖全库（旧版只查前 30 篇，后排文档永远搜不到），带 4 秒时间预算与结果缓存；
// 4) read_doc 用注册表 chars 预检 offset 越界，非法翻页不再白读整篇文档；
// 5) 注册表新增 chars（字符数）与准确的 size（字节数），列表按更新时间限流展示。

import { mapSetBounded, mapGetBounded, mapLimit } from '../utils.js';
import { storePutChecked } from '../store/r2.js';
import { kbSafeChatId } from '../store/kb.js';
import { KB_DOCS_PREFIX, kbDocSlug, kbNormSource, kbDocTitleOf, kbGetRegistry,
  kbSaveRegistry, kbFindRegEntry, kbRegistryVersion, kbFmtSize, kbFmtDate,
  kbTakeRepairCount } from './registry.js';

// v7.1.0：知识库文档正文 L1 内存缓存（每桶最多 48 篇，TTL 120 秒），写入或删除时自动失效/更新
const KB_DOC_CACHE_MAX = 48;
const KB_DOC_CACHE_TTL_MS = 120 * 1000;
const KB_DOC_CACHE_TEXT_MAX = 150000;
const KB_SEARCH_CACHE_MAX = 40;
const KB_SEARCH_CACHE_TTL_MS = 60 * 1000;
const KB_SEARCH_BUDGET_MS = 4000;
const KB_SEARCH_CONCURRENCY = 6;

const kbDocCaches = new WeakMap();

function docCacheFor(env) {
  const bucket = env && env.R2;
  if (!bucket || (typeof bucket !== 'object' && typeof bucket !== 'function')) return null;
  let c = kbDocCaches.get(bucket);
  if (!c) {
    c = { docs: new Map(), docsExp: new Map(), search: new Map(), searchExp: new Map() };
    kbDocCaches.set(bucket, c);
  }
  return c;
}

function kbCacheDoc(env, key, text) {
  const c = docCacheFor(env);
  if (!c || text.length > KB_DOC_CACHE_TEXT_MAX) return;
  mapSetBounded(c.docs, key, { text: text, lower: null }, KB_DOC_CACHE_MAX, c.docsExp, KB_DOC_CACHE_TTL_MS);
}

function kbDropDocCache(env, key) {
  const c = docCacheFor(env);
  if (!c) return;
  c.docs.delete(key);
  c.docsExp.delete(key);
}

async function kbReadDocTextCached(env, key) {
  if (!env || !env.R2) return null;
  const c = docCacheFor(env);
  const hit = c ? mapGetBounded(c.docs, key, c.docsExp) : undefined;
  if (hit && typeof hit.text === 'string') return hit.text;
  try {
    const obj = await env.R2.get(key);
    if (!obj) return null;
    const text = await obj.text();
    kbCacheDoc(env, key, text);
    return text;
  } catch (e) {
    return null;
  }
}

// 检索用：返回 { text, lower }，小写正文有缓存就复用，避免每次检索整篇 toLowerCase
async function kbReadDocForSearch(env, key) {
  const c = docCacheFor(env);
  const hit = c ? mapGetBounded(c.docs, key, c.docsExp) : undefined;
  if (hit && typeof hit.text === 'string') {
    if (typeof hit.lower !== 'string') hit.lower = hit.text.toLowerCase();
    return hit;
  }
  const text = await kbReadDocTextCached(env, key);
  if (text === null) return null;
  const again = c ? mapGetBounded(c.docs, key, c.docsExp) : undefined;
  if (again && typeof again.text === 'string') {
    if (typeof again.lower !== 'string') again.lower = again.text.toLowerCase();
    return again;
  }
  return { text: text, lower: text.toLowerCase() };
}

// 分词辅助：英文/数字按词、中文按单字 + 2-gram，用于正文多关键词相关性检索
function docSearchTokens(s) {
  const out = [];
  const segs = String(s || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/);
  for (const seg of segs) {
    if (!seg) continue;
    out.push(seg);
    if (/[\u4e00-\u9fff]/.test(seg)) {
      for (let i = 0; i + 2 <= seg.length; i++) out.push(seg.slice(i, i + 2));
      if (seg.length >= 2) {
        for (let i = 0; i < seg.length; i++) out.push(seg[i]);
      }
    }
  }
  return [...new Set(out)];
}

// ==================== 保存：模式、校验、版本快照、并发串行化（v7.11.0） ====================
// 旧版 save_doc 只有一条路：同名标题静默覆盖，超过 10 万字符直接截断，没有任何回滚余地。
// 这一版补上四件事：
//   1) 写入模式（auto/create/overwrite/append/prepend）——「补充一条」不必整篇重存；
//   2) 覆盖前自动做版本快照（kb/versions/<slug>/，保留 3 份），误覆盖可从控制台捞回；
//   3) 内容指纹去重——同一篇资料换个标题重复入库会被挡住；
//   4) 保存动作串行化——注册表是「读-改-写」，并发保存会互相覆盖丢条目。
const KB_SAVE_MAX_CHARS = 200000;
const KB_VERSION_DIR = 'kb/versions/';
const KB_VERSION_KEEP = 3;
const SAVE_MODES = ['auto', 'create', 'overwrite', 'append', 'prepend'];

function normalizeSaveMode(m) {
  const s = String(m || '').toLowerCase().trim();
  return SAVE_MODES.indexOf(s) !== -1 ? s : 'auto';
}

function normalizeTags(v) {
  const raw = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[,，、]/);
  const out = [];
  for (const x of raw) {
    const t = String(x).replace(/^#/, '').replace(/[\r\n]+/g, ' ').trim().slice(0, 20);
    if (!t || out.indexOf(t) !== -1) continue;
    out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

// 去掉 frontmatter，只留正文（追加/前置时需要拼接旧正文）
function stripFrontmatter(text) {
  return String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

// 内容指纹：长度 + 前 4000 字的 djb2。够用来挡「同一篇换标题重复入库」，
// 又不需要把整篇文档再哈希一遍（大文档的 CPU 在 Workers 上是真金白银）。
function contentFingerprint(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  let h = 5381;
  const n = Math.min(t.length, 4000);
  for (let i = 0; i < n; i++) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0;
  return t.length.toString(36) + '-' + h.toString(36);
}

// 错误页识别：只对短内容生效。长文档里引用一句 "404 Not Found" 是正常的，
// 但整篇不到 1200 字、开头就是 404/403/人机校验，那基本就是抓取失败的残渣。
const ERROR_PAGE_HINTS = [
  /^\s*404\s+not\s+found/i,
  /^\s*403\s+forbidden/i,
  /^\s*500\s+internal\s+server\s+error/i,
  /just\s+a\s+moment\.\.\./i,
  /enable\s+javascript\s+and\s+cookies/i,
  /<title>\s*(404|403|500|access denied)/i,
];
function looksLikeErrorPage(s) {
  const t = String(s || '').trim();
  if (!t || t.length > 1200) return '';
  for (const re of ERROR_PAGE_HINTS) if (re.test(t)) return '错误页/人机校验页';
  return '';
}

// 注册表读改写串行化：Workers 单 isolate 内用一条 promise 链排队。
// 跨 isolate 无法加锁（R2 没有事务），但至少同一实例里同时保存多篇不会互相覆盖。
let saveChain = Promise.resolve();
function withSaveLock(fn) {
  const next = saveChain.catch(() => {}).then(fn);
  saveChain = next.catch(() => {});
  return next;
}

// 覆盖前把旧正文存档到 kb/versions/<slug>/<ts>.md，只保留最近 KB_VERSION_KEEP 份
async function snapshotVersion(env, file, body) {
  if (!env || !env.R2 || !body) return '';
  const slug = String(file || '').replace(/\.md$/i, '') || 'doc';
  const dir = KB_VERSION_DIR + slug + '/';
  const key = dir + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5) + '.md';
  const ok = await storePutChecked(env, key, body);
  if (!ok) return '';
  try {
    const listed = await env.R2.list({ prefix: dir, limit: 100 });
    const keys = (listed.objects || []).map(o => o.key).sort();
    if (keys.length > KB_VERSION_KEEP) {
      const drop = keys.slice(0, keys.length - KB_VERSION_KEEP);
      if (drop.length) await env.R2.delete(drop);
    }
  } catch (e) {}
  return key;
}

// 写完注册表立刻回读校验：条目到底在不在？
//
// 为什么需要这一步：注册表是「整表读-改-写」，R2 没有事务，Workers 又会多实例并发。
// 两个实例几乎同时保存时，后写的那个会把先写的条目整段覆盖掉 —— 正文好好躺在 kb/docs/ 下，
// 列表和检索里却没有它。而 save_doc 早已返回「已保存为知识库文档」，用户于是看到
// 「提示保存成功、知识库里什么都没有」。旧版把修复推迟到下一次 /kb（verify），
// 保存的那一刻仍然是谎报成功。
//
// 这里做两遍：第一遍直接读 R2 上的注册表；不在就以文件为准重建一次再确认。
// 只有确认条目真的在索引里，才允许对外说「已保存」。
async function confirmSavedEntry(env, file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let reg = null;
    try {
      // attempt 0：只读最新注册表，多花 1 次 Class B；
      // attempt 1：带上 verify，按 kb/docs/ 下的真实文件重建索引（这是最后一道保险）
      reg = await kbGetRegistry(env, { fresh: true, verify: attempt > 0, quiet: true });
    } catch (e) {
      reg = null;
    }
    if (Array.isArray(reg) && reg.some(e => e && e.file === file)) return true;
  }
  return false;
}

async function toolSaveDoc(env, chatId, args) {
  return await withSaveLock(() => doSaveDoc(env, chatId, args || {}));
}

async function doSaveDoc(env, chatId, args) {
  const title = String(args.title || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
  const cleanSource = String(args.source || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
  let content = String(args.content || '');
  if (!title) return '标题为空，未保存';
  if (!content.trim()) return '内容为空，未保存';
  if (!env.R2) return 'R2 未绑定，知识库文档无法保存。请先按 README 第二步绑定 R2 存储桶后再试；本次内容未保存。';

  const mode = normalizeSaveMode(args.mode);
  const tags = normalizeTags(args.tags);

  const badKind = looksLikeErrorPage(content);
  if (badKind) {
    return '知识库文档写入已拒绝：内容看起来是「' + badKind + '」，不是有效资料。请确认原文可读（或换用 web_fetch 重试）后再保存；本次未写入。';
  }

  let truncated = false;
  if (content.length > KB_SAVE_MAX_CHARS) {
    content = content.slice(0, KB_SAVE_MAX_CHARS);
    truncated = true;
  }

  const file = kbDocSlug(title) + '.md';
  const key = KB_DOCS_PREFIX + file;
  // v7.11.1：写路径必须读「最新 + 已核对」的注册表。
  // 注册表是整表读-改-写，用本实例 30 秒内的旧缓存去写，会把别的实例刚保存的条目整段覆盖掉，
  // 那些文档正文还在 R2 里、却从此在列表和检索里消失（就是「提示已保存但知识库没有」）。
  // quiet：写路径自己会回报修复情况，不再计入全局「补回 N 篇」。
  const reg = await kbGetRegistry(env, { fresh: true, verify: true, quiet: true });
  const prevEntry = reg.find(e => e.file === file);
  const existed = !!prevEntry;

  // 来源去重：同一个 URL 换了标题，不该存第二份
  const normSrc = kbNormSource(args.source);
  if (normSrc && !existed) {
    const dup = reg.find(e => kbNormSource(e.source) === normSrc);
    if (dup && dup.file !== file) {
      return '该链接已保存为知识库文档《' + (dup.title || dup.file) + '》，未重复保存。如需更新内容，请用标题"' + (dup.title || dup.file) + '"重新保存以覆盖，或先用 delete_doc 删除旧文档。';
    }
  }

  // 内容指纹去重：同一篇资料换了标题
  const fp = contentFingerprint(content);
  if (!existed) {
    const fpDup = reg.find(e => e.file !== file && e.fp && e.fp === fp);
    if (fpDup) {
      return '相同内容已保存为《' + (fpDup.title || fpDup.file) + '》，未重复保存（内容指纹一致）。如需另存一份，请在标题上做区分，或先删除旧文档。';
    }
  }

  if (existed && mode === 'create') {
    return '同名文档《' + (prevEntry.title || file) + '》已存在（' + kbFmtSize(prevEntry.size) + '）。如需更新请改用 mode=overwrite 覆盖、mode=append 追加或 mode=prepend 前置整理，或换一个标题。';
  }

  let finalContent = content;
  let action = existed ? '已覆盖旧版' : '新建';
  let versionKey = '';

  if (existed && mode !== 'create') {
    const oldFull = await kbReadDocTextCached(env, key);
    if (oldFull != null) {
      // snapshot:false 供「先落盘原文、再前置整理大纲」这类两步写入使用，
      // 避免同一次入库占掉两个版本槽位
      if (args.snapshot !== false) versionKey = await snapshotVersion(env, file, oldFull);
      const oldBody = stripFrontmatter(oldFull).trim();
      if (mode === 'append') {
        finalContent = oldBody + '\n\n' + content;
        action = '已追加';
      } else if (mode === 'prepend') {
        finalContent = content + '\n\n---\n\n' + oldBody;
        action = '已前置整理大纲';
      }
    }
  }

  const nowIso = new Date().toISOString();
  const nextVersion = (Number(prevEntry && prevEntry.version) || 0) + 1;
  // v7.11.1：fp / version 也写进 frontmatter。注册表丢了可以按文件重建，
  // 但重建时只能读到 frontmatter —— 不写进去，重建后就再也挡不住重复入库了。
  const head = '---\ntitle: "' + title.replace(/"/g, '') + '"\nsaved_at: ' + nowIso
    + '\nchat_id: "' + kbSafeChatId(chatId) + '"'
    + (cleanSource ? '\nsource: ' + cleanSource : '')
    + (tags.length ? '\ntags: ' + tags.join(', ') : '')
    + '\nfp: ' + fp
    + '\nversion: ' + nextVersion
    + '\n---\n\n';
  const body = head + finalContent;
  const okDoc = await storePutChecked(env, key, body);
  if (!okDoc) return '知识库文档写入 R2 失败（' + key + '），请检查 R2 绑定与权限后重试；本次内容未保存。';
  // 穿透更新 L1 正文缓存
  kbCacheDoc(env, key, body);
  const entry = {
    file: file,
    title: title,
    source: cleanSource,
    tags: tags,
    // size 统一为字节数；chars 供 read_doc 在不下载正文的情况下判断 offset 是否越界
    size: new TextEncoder().encode(body).byteLength,
    chars: body.length,
    fp: fp,
    version: nextVersion,
    updated_at: nowIso
  };
  const idx = reg.findIndex(e => e.file === file);
  if (idx >= 0) reg[idx] = entry; else reg.push(entry);
  const okReg = await kbSaveRegistry(env, reg);
  if (!okReg) return '文档正文已写入 R2（' + key + '），但注册表更新失败，文档可能暂不出现在列表中；请稍后重新保存一次以修复注册表，本次内容未丢失。';
  // v7.11.2：注册表写成功 ≠ 条目还在。并发保存时别的实例可能刚把整表覆盖掉，
  // 这里必须回读确认，否则又会回到「提示已保存、知识库里没有」的老问题。
  const confirmed = await confirmSavedEntry(env, file);
  if (!confirmed) {
    return '文档正文已写入 R2（' + key + '），但索引校验未通过：该文档暂时无法在列表与检索中查到。'
      + '内容本身没有丢失，请在 Telegram 或微信端发送 /kb（会按文件重建索引）后再确认；'
      + '回答用户时必须如实说明「已写入但索引异常」，不要声称保存完全成功。';
  }

  const parts = [finalContent.length + ' 字符', action];
  if (tags.length) parts.push('标签：' + tags.join('、'));
  if (truncated) parts.push('内容超长，仅保存前 ' + KB_SAVE_MAX_CHARS + ' 字符');
  if (versionKey) parts.push('旧版已存档 ' + versionKey);
  let tail = '';
  if (existed && prevEntry && prevEntry.title !== title) {
    tail = '（注意：新标题清洗后与旧文档《' + prevEntry.title + '》同名，旧内容已被覆盖）';
  }
  return '已保存为知识库文档：《' + title + '》（' + parts.join('，') + '）' + tail;
}

async function toolListDocs(env, opts) {
  if (!env.R2) return 'R2 未绑定，无法读取知识库文档';
  // /kb 这类用户主动查看的入口传 verify:true —— 顺便把索引和实际文件核对一遍，
  // 免得「文档明明存进去了却不在列表里」。Agent 每轮的 list_docs 走缓存，不额外花 R2 操作。
  const reg = await kbGetRegistry(env, { verify: !!(opts && opts.verify) });
  const repaired = kbTakeRepairCount();
  const repairNote = repaired > 0
    ? '\n\n🔧 索引与实际文件不一致，已按文件自动修复，补回 ' + repaired + ' 篇此前未列出的文档。'
    : '';
  if (!reg.length) return '知识库文档为空（kb/docs/ 下暂无文档，可用 save_doc 保存）' + repairNote;
  // v7.7.0：按更新时间倒序 + 最多列 60 篇。旧版全量列出，几百篇时会撑爆工具结果与上下文
  const MAX_SHOWN = 60;
  const ordered = reg.slice().sort((a, b) => {
    const ta = Date.parse(a.updated_at || '') || 0;
    const tb = Date.parse(b.updated_at || '') || 0;
    return tb - ta;
  });
  const shown = ordered.slice(0, MAX_SHOWN);
  const more = shown.length < reg.length
    ? '，按更新时间显示最近 ' + shown.length + ' 篇，其余请用 read_doc 按关键词检索'
    : '';
  return '知识库文档（共' + reg.length + '篇' + more + '）：\n' +
    shown.map((e, i) => {
      const tagNote = (Array.isArray(e.tags) && e.tags.length) ? '，标签：' + e.tags.join('、') : '';
      return (i + 1) + '. ' + (e.title || e.file) + '（' + kbFmtSize(e.size) + '，' + kbFmtDate(e.updated_at) + tagNote + '）';
    }).join('\n') + repairNote;
}

async function toolReadDoc(env, args, maxChars) {
  args = args || {};
  const query = String(args.query || '').trim();
  if (!query) return '请给出要读取的文档标题关键词';
  if (!env.R2) return 'R2 未绑定，无法读取知识库文档';
  let reg = await kbGetRegistry(env);
  if (!reg.length) return '知识库文档为空（kb/docs/ 下暂无文档）';
  const offset = Math.max(0, parseInt(args.offset, 10) || 0);
  // v7.9.0：切片长度由调用方预算决定。
  // 旧版固定返回 8000 字符，随后被 Agent 循环按预算截断成 4000 ——
  // 但尾部的"请传 offset=8000"是按 8000 算的，模型照着翻页就会跳过中间 4000 字。
  // 现在由工具自己按预算切片，nextOffset 始终与实际返回的内容对齐。
  const MAX = Math.max(600, Math.min(8000, (maxChars > 0 ? maxChars : 8000)));
  let hit = kbFindRegEntry(reg, query);
  if (!hit) {
    // v7.11.1：索引可能落后于实际文件（别的实例刚写入、旧版本遗留）。
    // 未命中时先核对一次索引再判「没有」，避免文档明明在库里却回「未找到」。
    // quiet：修复计数留给列表类入口去回报，读文档这里自己会说明结果。
    reg = await kbGetRegistry(env, { verify: true, quiet: true });
    hit = kbFindRegEntry(reg, query);
  }
  if (hit) {
    // 注册表带字符数时先判越界：不用为了一个非法 offset 把整篇文档读进内存
    if (typeof hit.chars === 'number' && hit.chars >= 0 && offset >= hit.chars) {
      return '文档读取失败：偏移量 offset=' + offset + ' 已超出文档总长度（' + hit.chars + ' 字符），请改用更小的 offset；或传 offset=0 从头读。';
    }
    const fullText = await kbReadDocTextCached(env, KB_DOCS_PREFIX + hit.file);
    if (fullText === null) return '文档读取失败：' + (hit.title || hit.file);
    const totalLen = fullText.length;
    if (offset >= totalLen) {
      return '文档读取失败：偏移量 offset=' + offset + ' 已超出文档总长度（' + totalLen + ' 字符），请改用更小的 offset；或传 offset=0 从头读。';
    }
    const slice = fullText.slice(offset, offset + MAX);
    const nextOffset = offset + slice.length;
    let note = '';
    if (nextOffset < totalLen) {
      note = '\n\n> （当前显示第 ' + offset + ' ~ ' + nextOffset + ' 字符，全文共 ' + totalLen + ' 字符；如需继续阅读后续内容，请调用 read_doc 并传 offset=' + nextOffset + '）';
    } else if (offset > 0) {
      note = '\n\n> （当前显示第 ' + offset + ' ~ ' + totalLen + ' 字符，已读到文档末尾）';
    }
    const tagNote = (Array.isArray(hit.tags) && hit.tags.length) ? '｜标签：' + hit.tags.join('、') : '';
    return '【知识库文档《' + (hit.title || hit.file) + '》' + tagNote + '】\n' + slice + note;
  }
  // 标题无命中 → 全文多关键词相关性检索（v7.7.0 覆盖全库，按更新时间优先，带时间预算）
  const ordered = reg.slice().sort((a, b) => {
    const ta = Date.parse(a.updated_at || '') || 0;
    const tb = Date.parse(b.updated_at || '') || 0;
    return tb - ta;
  });
  const res = await kbSearchDocBodyEx(env, ordered, query);
  if (res.snippet) return res.snippet;
  if (res.skipped > 0) {
    return '未在已检索的 ' + res.scanned + ' 篇文档中找到包含"' + query + '"的内容（知识库共 ' + res.total
      + ' 篇，本次因时间预算跳过 ' + res.skipped + ' 篇）。请换更精确的关键词，或先用 list_docs 查看标题后按标题读取。'
      + '\n\n现有文档（按更新时间）：\n' + ordered.slice(0, 60).map(e => '- ' + (e.title || e.file)).join('\n');
  }
  return '未找到标题或正文包含"' + query + '"的文档。现有文档：\n' +
    ordered.slice(0, 60).map(e => '- ' + (e.title || e.file)).join('\n');
}

// v7.1.0 全文多关键词相关性检索（带 L1 缓存与词频/标题饱和度加权）：
// v7.7.0：并发（6）覆盖全库、复用的小写正文缓存、长词全局预检提前排除、4 秒时间预算、结果缓存。
async function kbSearchDocBodyEx(env, entries, query) {
  const qLower = String(query || '').trim().toLowerCase();
  const tokens = docSearchTokens(query);
  const list = Array.isArray(entries) ? entries : [];
  const total = list.length;
  if (!qLower && !tokens.length) return { snippet: null, scanned: 0, skipped: 0, total };

  const cache = docCacheFor(env);
  const cacheKey = kbRegistryVersion() + '|' + qLower;
  if (cache) {
    const memo = mapGetBounded(cache.search, cacheKey, cache.searchExp);
    if (typeof memo === 'string') return { snippet: memo || null, scanned: total, skipped: 0, total, cached: true };
  }

  const longTokens = tokens.filter(t => t.length >= 2);
  const hasLongTokenInQuery = longTokens.length > 0;
  const deadline = Date.now() + KB_SEARCH_BUDGET_MS;
  let scanned = 0;
  let skipped = 0;

  const hits = await mapLimit(list, KB_SEARCH_CONCURRENCY, async (entry) => {
    if (Date.now() > deadline) { skipped += 1; return null; }
    scanned += 1;
    const k = typeof entry === 'string' ? entry : (KB_DOCS_PREFIX + entry.file);
    const docTitle = (entry && entry.title) ? entry.title : kbDocTitleOf(k);
    const titleLower = String(docTitle || '').toLowerCase();
    try {
      const doc = await kbReadDocForSearch(env, k);
      if (!doc) return null;
      const lower = doc.lower;

      // 长词一个都没出现 → 整篇不可能命中窗口打分，直接跳过（避免逐窗口扫描大文档）
      if (hasLongTokenInQuery) {
        let any = false;
        for (const tk of longTokens) {
          if (lower.indexOf(tk) !== -1) { any = true; break; }
        }
        if (!any) return null;
      }

      // 标题相关性加成
      let titleBonus = 0;
      for (const tk of tokens) {
        if (tk.length >= 2 && titleLower.indexOf(tk) !== -1) titleBonus += tk.length * 4;
      }

      // 1) 优先检查完整 query 精确子串
      const exactIdx = qLower ? lower.indexOf(qLower) : -1;
      if (exactIdx !== -1) {
        return { title: docTitle, text: doc.text, bestOffset: exactIdx, score: 1000 + tokens.length * 10 + titleBonus };
      }

      // 2) 分词多关键词打分：按 800 字步长滑动窗口找最密集命中区（引入词频饱和加权）
      if (!tokens.length) return null;
      const WIN = 1200;
      const STEP = 800;
      let bestScore = 0;
      let bestPos = -1;
      for (let pos = 0; pos < lower.length; pos += STEP) {
        const winText = lower.slice(pos, pos + WIN);
        let score = titleBonus;
        let matchedLongTokens = 0;
        for (const tk of tokens) {
          let idx = winText.indexOf(tk);
          if (idx !== -1) {
            // 统计窗口内出现次数（上限 4 次，实现 BM25 风格的词频饱和）
            let occ = 1;
            let nextFrom = idx + tk.length;
            while (occ < 4) {
              const nxt = winText.indexOf(tk, nextFrom);
              if (nxt === -1) break;
              occ++;
              nextFrom = nxt + tk.length;
            }
            const tfWeight = 1 + (occ - 1) * 0.3;
            if (tk.length >= 2) {
              score += tk.length * 3 * tfWeight;
              matchedLongTokens++;
            } else {
              score += 1;
            }
          }
        }
        if (hasLongTokenInQuery && matchedLongTokens === 0) continue;
        if (score > bestScore) {
          bestScore = score;
          bestPos = pos;
        }
      }
      if (bestScore > 0 && bestPos >= 0) {
        let anchor = bestPos;
        const winSlice = lower.slice(bestPos, bestPos + WIN);
        for (const tk of tokens) {
          if (tk.length >= 2) {
            const rel = winSlice.indexOf(tk);
            if (rel !== -1) { anchor = bestPos + rel; break; }
          }
        }
        return { title: docTitle, text: doc.text, bestOffset: anchor, score: bestScore };
      }
      return null;
    } catch (e) { return null; }
  });

  const candidates = hits.filter(Boolean);
  let snippet = null;
  if (candidates.length) {
    candidates.sort((a, b) => b.score - a.score);
    const top = candidates.slice(0, 3);
    const blocks = top.map((h, idx) => {
      const start = Math.max(0, h.bestOffset - 450);
      const end = Math.min(h.text.length, h.bestOffset + 650);
      let frag = h.text.slice(start, end);
      if (start > 0) frag = '…' + frag;
      if (end < h.text.length) frag = frag + '…';
      return '【命中 ' + (idx + 1) + '：知识库文档《' + h.title + '》（offset=' + start + '，全文 ' + h.text.length + ' 字符）】\n' + frag;
    });
    snippet = blocks.join('\n\n---\n\n') +
      '\n\n> （以上为正文相关性最高的片段；如需阅读某篇完整上下文，请用 read_doc 传入完整文档标题及对应 offset）';
  }
  // 只在完整扫描（无跳过）时缓存「有/无结果」，避免把时间预算造成的漏检固化为答非所问
  if (cache && skipped === 0) {
    mapSetBounded(cache.search, cacheKey, snippet || '', KB_SEARCH_CACHE_MAX, cache.searchExp, KB_SEARCH_CACHE_TTL_MS);
  }
  return { snippet: snippet, scanned: scanned, skipped: skipped, total };
}

async function kbSearchDocBody(env, entries, query) {
  const r = await kbSearchDocBodyEx(env, entries, query);
  return r.snippet;
}

async function toolDeleteDoc(env, args) {
  args = args || {};
  const query = String(args.query || '').trim();
  if (!query) return '请给出要删除的文档标题关键词';
  if (!env.R2) return 'R2 未绑定，无法删除知识库文档';
  const reg = await kbGetRegistry(env, { fresh: true, verify: true, quiet: true });
  if (!reg.length) return '知识库文档为空，无需删除';
  const hit = kbFindRegEntry(reg, query);
  if (!hit) {
    // v7.9.0：与 list_docs 一致，最多列 60 篇。旧版全量列出，几百篇时直接撑爆工具结果
    const shown = reg.slice(0, 60);
    const more = shown.length < reg.length ? '（共 ' + reg.length + ' 篇，仅列前 60 篇）' : '';
    return '未找到标题包含"' + query + '"的文档' + more + '。现有文档：\n' +
      shown.map(e => '- ' + (e.title || e.file)).join('\n');
  }
  const key = KB_DOCS_PREFIX + hit.file;
  try { await env.R2.delete(key); } catch (e) { return '删除失败：' + (hit.title || hit.file); }
  kbDropDocCache(env, key);
  const okReg = await kbSaveRegistry(env, reg.filter(e => e !== hit));
  if (!okReg) return '文档文件已删除，但注册表更新失败，列表可能仍显示旧条目；下次读取会自动重建注册表。《' + (hit.title || hit.file) + '》';
  return '已删除知识库文档《' + (hit.title || hit.file) + '》';
}

export {
  docSearchTokens,
  kbReadDocTextCached,
  toolSaveDoc,
  toolListDocs,
  toolReadDoc,
  kbSearchDocBody,
  kbSearchDocBodyEx,
  toolDeleteDoc,
};
