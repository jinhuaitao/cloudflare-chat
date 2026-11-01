// 知识库管理 API（/api/kb/*）：网页端知识库面板的后端
//
// 权限模型（与项目既有的"Web 只读、机器人可写"保持一致）：
//  · 读取（stats / list / doc / search）：需要 KB_ADMIN_SECRET / WX_ADMIN_SECRET / ACCESS_PASSWORD
//    中任一密钥；三者都未配置时开放读取（与 ACCESS_PASSWORD 未配置即免密聊天一致）。
//  · 写入（save / delete / reindex / fetch）：必须配置 KB_ADMIN_SECRET 或 WX_ADMIN_SECRET。
//    只配置 ACCESS_PASSWORD 时普通网页访客仍可读，但无法写入 —— 防止共享口令的访客污染全局知识库。

import { CORS_HEADERS } from '../constants.js';
import { safeEqual } from '../utils.js';
import { kbGetRegistry, KB_DOCS_PREFIX, kbFindRegEntry } from './registry.js';
import { kbSearch, kbStats } from './search.js';
import { kbRebuildIndex } from './index.js';
import { toolSaveDoc, toolDeleteDoc, toolKbIngest } from './doc-tools.js';
import { htmlToStructuredText } from '../agent/tools-web.js';
import { kbConfig } from './config.js';

const KB_API_PREFIX = '/api/kb/';
const KB_WEB_CHAT_ID = 'web_kb_admin';

function kbJson(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: CORS_HEADERS });
}

function kbAdminSecret(env) {
  const e = env || {};
  return String(e.KB_ADMIN_SECRET || e.WX_ADMIN_SECRET || '').trim();
}

function kbReadSecret(env) {
  return kbAdminSecret(env) || String((env || {}).ACCESS_PASSWORD || '').trim();
}

function kbAuthInputs(request, url) {
  const h = (request && request.headers) || null;
  const get = (k) => (h ? (h.get(k) || '') : '');
  const out = [
    get('X-Kb-Admin-Token'),
    get('X-Wx-Admin-Token'),
    get('X-Access-Token'),
    (get('Authorization') || '').replace(/^Bearer\s+/i, '').trim(),
    (url && url.searchParams && url.searchParams.get('key')) || '',
  ];
  return out.filter(Boolean);
}

function kbCheckAuth(env, request, url, needWrite) {
  const required = needWrite ? kbAdminSecret(env) : kbReadSecret(env);
  if (!required) {
    if (needWrite) {
      return {
        ok: false,
        locked: true,
        reason: '安全锁定：未配置 KB_ADMIN_SECRET（或 WX_ADMIN_SECRET），网页端知识库写入已关闭。'
          + '请在 Cloudflare 环境变量中设置 KB_ADMIN_SECRET 后重试；也可以直接通过 Telegram 或微信 ClawBot 机器人写入知识库。',
      };
    }
    return { ok: true, open: true };
  }
  for (const input of kbAuthInputs(request, url)) {
    if (safeEqual(input, required)) return { ok: true };
  }
  return { ok: false, reason: '管理员密钥不正确或未提供（请求头 X-Kb-Admin-Token）。' };
}

function kbFmtBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(b / 1024)) + ' KB';
}

async function kbReadBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : {};
  } catch (e) {
    return null;
  }
}

// 读取注册表并按更新时间倒序（列表接口与统计共用）
async function kbSortedRegistry(env) {
  let reg = [];
  try { reg = await kbGetRegistry(env); } catch (e) { reg = []; }
  return reg.slice().sort((a, b) => {
    const ta = Date.parse(a.updated_at || '') || 0;
    const tb = Date.parse(b.updated_at || '') || 0;
    return tb - ta;
  });
}

function kbDocPayload(entry) {
  return {
    file: entry.file,
    title: entry.title || entry.file,
    source: entry.source || '',
    size: entry.size || 0,
    sizeText: kbFmtBytes(entry.size || 0),
    updatedAt: entry.updated_at || '',
  };
}

async function handleKbStats(env, request, url) {
  const st = await kbStats(env);
  // canWrite 反映「本次请求是否具备写入权限」，而不是服务端是否配了密钥：
  // 配置了 KB_ADMIN_SECRET 但访客没带对的 token 时，面板应显示"未解锁"而不是"已解锁"。
  const writeAuth = kbCheckAuth(env, request, url, true);
  return kbJson({
    ok: true,
    ...st,
    charsText: Math.max(1, Math.round((st.chars || 0) / 1000)) + ' 千字',
    canWrite: !!writeAuth.ok,
    writeLocked: !!writeAuth.locked,
    readOpen: !kbReadSecret(env),
  });
}

async function handleKbList(env, url) {
  const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit'), 10) || 100));
  const offset = Math.max(0, parseInt(url.searchParams.get('offset'), 10) || 0);
  const reg = await kbSortedRegistry(env);
  const filtered = q
    ? reg.filter(e => String(e.title || '').toLowerCase().indexOf(q) !== -1
      || String(e.source || '').toLowerCase().indexOf(q) !== -1)
    : reg;
  const page = filtered.slice(offset, offset + limit).map(kbDocPayload);
  let st = null;
  try { st = await kbStats(env); } catch (e) { st = null; }
  return kbJson({ ok: true, total: filtered.length, offset, limit, docs: page, stats: st });
}

async function handleKbDoc(env, url) {
  const file = String(url.searchParams.get('file') || '').trim();
  const query = String(url.searchParams.get('q') || '').trim();
  if (!file && !query) return kbJson({ ok: false, error: '缺少 file 或 q 参数' }, 400);
  const reg = await kbGetRegistry(env);
  let entry = null;
  if (file) entry = reg.find(e => e.file === file) || null;
  if (!entry && query) entry = kbFindRegEntry(reg, query);
  if (!entry) return kbJson({ ok: false, error: '未找到该文档' }, 404);
  let text = '';
  try {
    const obj = await env.R2.get(KB_DOCS_PREFIX + entry.file);
    if (obj) text = await obj.text();
  } catch (e) {}
  const offset = Math.max(0, parseInt(url.searchParams.get('offset'), 10) || 0);
  const limit = Math.max(200, Math.min(40000, parseInt(url.searchParams.get('limit'), 10) || 12000));
  const total = text.length;
  return kbJson({
    ok: true,
    doc: kbDocPayload(entry),
    offset,
    limit,
    total,
    content: text.slice(offset, offset + limit),
    hasMore: offset + limit < total,
  });
}

async function handleKbSearch(env, body) {
  const query = String(body.query || '').trim();
  if (!query) return kbJson({ ok: false, error: '请输入检索关键词' }, 400);
  const res = await kbSearch(env, query, {
    topK: Math.max(1, Math.min(20, parseInt(body.top_k, 10) || 8)),
    doc: body.doc,
    perDoc: 2,
  });
  return kbJson({
    ok: true,
    query,
    mode: res.mode,
    tookMs: res.tookMs,
    stats: res.stats,
    hits: (res.hits || []).map(h => ({
      file: h.file,
      title: h.title,
      offset: h.offset,
      length: h.length,
      docLen: h.docLen,
      rel: h.rel,
      coverage: Math.round((h.coverage || 0) * 100) / 100,
      phrase: !!h.phrase,
      score: Math.round(h.score * 100) / 100,
      snippet: h.snippet,
    })),
  });
}

async function handleKbSave(env, body) {
  const title = String(body.title || '').trim();
  let content = String(body.content || '');
  const source = String(body.source || '').trim();
  const format = String(body.format || '').trim().toLowerCase();
  if (!title) return kbJson({ ok: false, error: '标题不能为空' }, 400);
  if (!content.trim()) return kbJson({ ok: false, error: '内容不能为空' }, 400);
  if (format === 'html' || /^\s*<(?:!doctype|html|body|div|p|article)[\s>]/i.test(content)) {
    content = htmlToStructuredText(content);
    if (!content.trim()) return kbJson({ ok: false, error: 'HTML 中没有可提取的正文' }, 400);
  }
  const maxChars = kbConfig(env).maxDocChars;
  if (content.length > maxChars) content = content.slice(0, maxChars);
  const msg = await toolSaveDoc(env, KB_WEB_CHAT_ID, { title, content, source });
  const failed = /^(标题为空|内容为空|R2 未绑定|知识库文档写入|该链接已保存)/.test(msg);
  return kbJson({ ok: !failed, message: msg, error: failed ? msg : undefined }, failed ? 400 : 200);
}

async function handleKbDelete(env, body) {
  const file = String(body.file || '').trim();
  const query = String(body.query || body.title || '').trim();
  if (!file && !query) return kbJson({ ok: false, error: '缺少 file 或 query 参数' }, 400);
  const reg = await kbGetRegistry(env);
  const entry = file ? reg.find(e => e.file === file) : kbFindRegEntry(reg, query);
  if (!entry) return kbJson({ ok: false, error: '未找到该文档' }, 404);
  const msg = await toolDeleteDoc(env, { query: entry.title || entry.file });
  const failed = /^(请给出|R2 未绑定|未找到|删除失败)/.test(msg);
  return kbJson({ ok: !failed, message: msg, error: failed ? msg : undefined }, failed ? 400 : 200);
}

async function handleKbReindex(env) {
  const idx = await kbRebuildIndex(env);
  const st = idx && idx.stats ? idx.stats : { docs: 0, chunks: 0, chars: 0 };
  return kbJson({
    ok: true,
    message: '索引已重建：' + st.docs + ' 篇 / ' + st.chunks + ' 块',
    stats: st,
  });
}

async function handleKbFetch(env, body) {
  const url = String(body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return kbJson({ ok: false, error: '请输入 http(s) 链接' }, 400);
  const msg = await toolKbIngest(env, KB_WEB_CHAT_ID, { url, title: body.title });
  const failed = /^(URL 非法|该地址禁止抓取|R2 未绑定|网页抓取失败|该网页没有可提取|标题为空|内容为空|知识库文档写入)/.test(msg);
  return kbJson({ ok: !failed, message: msg, error: failed ? msg : undefined }, failed ? 400 : 200);
}

async function handleKbApi(request, env, url) {
  const path = url.pathname.slice(KB_API_PREFIX.length - 1); // 保留前导 '/'
  const method = request.method;

  if (method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

  const isWrite = path === '/save' || path === '/delete' || path === '/reindex' || path === '/fetch';
  const auth = kbCheckAuth(env, request, url, isWrite);
  if (!auth.ok) return kbJson({ ok: false, error: auth.reason, locked: !!auth.locked }, auth.locked ? 403 : 401);

  if (!env.R2) {
    return kbJson({ ok: false, error: 'R2 未绑定，知识库不可用。请先在 wrangler.toml 或控制台绑定 R2 存储桶。' }, 503);
  }

  try {
    if (method === 'GET' && path === '/stats') return await handleKbStats(env, request, url);
    if (method === 'GET' && path === '/list') return await handleKbList(env, url);
    if (method === 'GET' && path === '/doc') return await handleKbDoc(env, url);

    if (method === 'POST' && path === '/search') {
      const body = await kbReadBody(request);
      if (!body) return kbJson({ ok: false, error: '请求体必须是 JSON' }, 400);
      return await handleKbSearch(env, body);
    }
    if (method === 'POST' && path === '/save') {
      const body = await kbReadBody(request);
      if (!body) return kbJson({ ok: false, error: '请求体必须是 JSON' }, 400);
      return await handleKbSave(env, body);
    }
    if (method === 'POST' && path === '/delete') {
      const body = await kbReadBody(request);
      if (!body) return kbJson({ ok: false, error: '请求体必须是 JSON' }, 400);
      return await handleKbDelete(env, body);
    }
    if (method === 'POST' && path === '/reindex') return await handleKbReindex(env);
    if (method === 'POST' && path === '/fetch') {
      const body = await kbReadBody(request);
      if (!body) return kbJson({ ok: false, error: '请求体必须是 JSON' }, 400);
      return await handleKbFetch(env, body);
    }

    return kbJson({ ok: false, error: 'Not Found' }, 404);
  } catch (e) {
    return kbJson({ ok: false, error: '知识库接口异常：' + (e && e.message ? e.message : String(e)) }, 500);
  }
}

export {
  KB_API_PREFIX,
  handleKbApi,
  kbAdminSecret,
  kbReadSecret,
  kbCheckAuth,
};
