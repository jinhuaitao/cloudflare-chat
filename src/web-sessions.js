// Web 端对话 R2 同步：GET / PUT / DELETE /api/sessions
//
// 背景：Web 会话原本只存浏览器 localStorage（src/ui/app-state.js 的 cfchat_sessions），
// 同一浏览器关掉重开能继续，但换设备 / 换浏览器 / 清缓存就全丢。这个模块把整份
// 会话列表同步到 R2，让同一口令下的多台设备能接续同一批对话。
//
// 安全模型（刻意保守）：
// 1) 只在配置了 ACCESS_PASSWORD 时启用。没配口令 = 公开部署，谁都能读写这个接口，
//    等于把所有访客的对话混进一个桶，所以 GET 返回 enabled:false、写入直接 403；
//    前端拿到 enabled:false 就安静地只用 localStorage，行为与从前一致。
//    设 WEB_SESSION_SYNC=0 可显式关掉（即使配了口令）。
// 2) 配了口令后与 /api/chat 同一套校验（denyUnauthorized，X-Access-Token）。
// 3) 存储键由口令派生：web_sessions/shared_<SHA-256(ACCESS_PASSWORD)>.json。
//    这是刻意的——每台设备各自生成随机 ID 的话，每台设备都会写到不同的对象，
//    永远看不到彼此的对话，「换设备继续」根本不成立。用口令哈希做键后，
//    知道同一口令的所有设备天然共享同一份对象；R2 里只存哈希，不存明文口令。
//    代价：同步域 = 知道口令的人，没有按人隔离（改口令 = 换一份新的同步对象，
//    旧对象留在 R2 里，需要时手动删）。
//
// 存储与并发：
// - 单对象 web_sessions/shared_<hash>.json，信封 {v, updatedAt, sessions, deleted}。
// - PUT 带 baseEtag 时走 CAS（storePutCas）：与 R2 里的 etag 对不上就 409，
//   把服务端现值一并返回，前端合并后重推，两个设备同时写不会互相覆盖。
// - PUT 不带 baseEtag 时做服务端合并（mergeSyncSessions）后落盘，作为兜底。
// - 删除靠墓碑（deleted: [{id, at}]）：没有墓碑的话，A 设备删掉的会话会被
//   B 设备下一次合并「复活」。墓碑比会话的 updatedAt 新才生效，删后又继续聊的
//   会话（updatedAt 更新）不会被误删。
// - 上限与前端对齐：50 个会话 / 每会话 200 条 / 单条正文 5 万字符 / 整包 400 万字符。

import { CORS_HEADERS } from './constants.js';
import { denyUnauthorized } from './auth.js';
import { storeGetMeta, storePutChecked, storePutCas, storeDelete } from './store/r2.js';

const WEB_SESSIONS_PREFIX = 'web_sessions/';
const MAX_SYNC_SESSIONS = 50;
const MAX_SYNC_MSGS = 200;
const MAX_SYNC_CONTENT_CHARS = 50000;
const MAX_SYNC_PAYLOAD_CHARS = 4000000;
const MAX_SYNC_DELETED = 200;
const SYNC_ROLES = new Set(['user', 'assistant', 'system']);

function isValidSessionId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id);
}

// 由口令派生存储键：SHA-256 哈希的十六进制。Workers 与 Node 都有 WebCrypto；
// 极端环境下 subtle 不可用时退化为双种子 djb2 拼出的 32 位十六进制串
// （只影响键的碰撞强度，不影响鉴权本身——鉴权仍靠 denyUnauthorized 比对口令）。
async function webSessionsKeyForToken(token) {
  const raw = String(token || '');
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    return WEB_SESSIONS_PREFIX + 'shared_' + hex + '.json';
  } catch (e) {
    let h1 = 5381;
    let h2 = 52711;
    for (let i = 0; i < raw.length; i++) {
      h1 = ((h1 * 33) ^ raw.charCodeAt(i)) >>> 0;
      h2 = ((h2 * 31) ^ raw.charCodeAt(i)) >>> 0;
    }
    const hex = (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(4);
    return WEB_SESSIONS_PREFIX + 'shared_' + hex + '.json';
  }
}

function clipStr(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function sanitizeSyncMessage(m) {
  if (!m || typeof m !== 'object') return null;
  if (!SYNC_ROLES.has(m.role)) return null;
  if (typeof m.content !== 'string') return null;
  const out = { role: m.role, content: m.content.slice(0, MAX_SYNC_CONTENT_CHARS) };
  if (Number.isFinite(m.t) && m.t > 0) out.t = Math.floor(m.t);
  if (typeof m.personaTrace === 'string' && m.personaTrace) out.personaTrace = m.personaTrace.slice(0, 500);
  if (m.personaDetail && typeof m.personaDetail === 'object' && !Array.isArray(m.personaDetail)) {
    try {
      if (JSON.stringify(m.personaDetail).length <= 8000) out.personaDetail = m.personaDetail;
    } catch (e) {}
  }
  return out;
}

function sanitizeSyncSessions(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const s of input) {
    if (out.length >= MAX_SYNC_SESSIONS) break;
    if (!s || typeof s !== 'object' || !isValidSessionId(s.id) || seen.has(s.id)) continue;
    seen.add(s.id);
    const messages = [];
    if (Array.isArray(s.messages)) {
      for (const m of s.messages) {
        const clean = sanitizeSyncMessage(m);
        if (clean) messages.push(clean);
      }
    }
    out.push({
      id: s.id,
      title: clipStr(s.title, 200) || '新对话',
      model: clipStr(s.model, 200),
      updatedAt: Number.isFinite(s.updatedAt) && s.updatedAt > 0 ? Math.floor(s.updatedAt) : 0,
      messages: messages.slice(-MAX_SYNC_MSGS),
    });
  }
  return out;
}

function sanitizeSyncDeleted(input) {
  if (!Array.isArray(input)) return [];
  const byId = new Map();
  for (const d of input) {
    if (!d || typeof d !== 'object' || !isValidSessionId(d.id)) continue;
    const at = Number.isFinite(d.at) && d.at > 0 ? Math.floor(d.at) : 0;
    if (!at) continue;
    if (!byId.has(d.id) || byId.get(d.id) < at) byId.set(d.id, at);
  }
  return [...byId.entries()]
    .map(([id, at]) => ({ id, at }))
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_SYNC_DELETED);
}

// 合并两份会话列表 + 墓碑：同 id 取 updatedAt 更新的一份（同分取消息更多的一份，
// 再同分取 remote，因为调用方会把「本机」放在 local 参数位、冲突时以本机为准需反着传）。
// 实际约定：mergeSyncSessions(local, remote, deleted) —— 同分同长时取 local。
function mergeSyncSessions(localInput, remoteInput, deletedInput) {
  const local = sanitizeSyncSessions(localInput);
  const remote = sanitizeSyncSessions(remoteInput);
  const deleted = sanitizeSyncDeleted(deletedInput);
  const tomb = new Map(deleted.map(d => [d.id, d.at]));
  const byId = new Map();
  const consider = (s, isLocal) => {
    const prev = byId.get(s.id);
    if (!prev) { byId.set(s.id, s); return; }
    const newer = s.updatedAt !== prev.updatedAt ? s.updatedAt > prev.updatedAt
      : s.messages.length !== prev.messages.length ? s.messages.length > prev.messages.length
      : isLocal;
    if (newer) byId.set(s.id, s);
  };
  for (const s of remote) consider(s, false);
  for (const s of local) consider(s, true);
  const merged = [...byId.values()].filter(s => {
    const at = tomb.get(s.id);
    return !(at && at >= s.updatedAt);
  });
  merged.sort((a, b) => b.updatedAt - a.updatedAt);
  return merged.slice(0, MAX_SYNC_SESSIONS);
}

function parseSyncEnvelope(text) {
  if (!text) return { sessions: [], deleted: [], updatedAt: 0 };
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object') return { sessions: [], deleted: [], updatedAt: 0 };
    return {
      sessions: sanitizeSyncSessions(obj.sessions),
      deleted: sanitizeSyncDeleted(obj.deleted),
      updatedAt: Number.isFinite(obj.updatedAt) ? obj.updatedAt : 0,
    };
  } catch (e) {
    return { sessions: [], deleted: [], updatedAt: 0 };
  }
}

function syncJson(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({}, CORS_HEADERS, { 'Cache-Control': 'no-store' }),
  });
}

// 同步是否可用：配了口令、没被显式关掉。R2 未绑定单独判断（部署问题，不是策略问题）。
function syncDisabledReason(env) {
  if (!env || env.WEB_SESSION_SYNC === '0') return 'SYNC_DISABLED';
  if (!env.ACCESS_PASSWORD) return 'NO_ACCESS_PASSWORD';
  return '';
}

async function handleWebSessions(request, env, url) {
  const method = request.method;

  const reason = syncDisabledReason(env);
  if (reason) {
    if (method === 'GET') return syncJson({ ok: true, enabled: false, code: reason, sessions: [], deleted: [], updatedAt: 0, etag: '' });
    return syncJson({ ok: false, enabled: false, code: reason, error: 'Web 对话同步未启用：需要先配置 ACCESS_PASSWORD' }, 403);
  }
  const denied = denyUnauthorized(env, request);
  if (denied) return denied;
  if (!env.R2) {
    if (method === 'GET') return syncJson({ ok: true, enabled: false, r2Bound: false, sessions: [], deleted: [], updatedAt: 0, etag: '' });
    return syncJson({ ok: false, enabled: false, code: 'R2_NOT_BOUND', error: '服务端未绑定 R2，无法同步' }, 503);
  }

  const key = await webSessionsKeyForToken(env.ACCESS_PASSWORD);

  if (method === 'GET' || method === 'DELETE') {
    if (method === 'DELETE') {
      const okDel = await storeDelete(env, key);
      return syncJson({ ok: okDel, enabled: true });
    }
    const meta = await storeGetMeta(env, key);
    if (meta.failed) return syncJson({ ok: false, code: 'R2_READ_FAILED', error: '读取同步数据失败，请稍后再试' }, 502);
    const data = parseSyncEnvelope(meta.text);
    return syncJson({ ok: true, enabled: true, sessions: data.sessions, deleted: data.deleted, updatedAt: data.updatedAt, etag: meta.etag || '' });
  }

  if (method === 'PUT') {
    let raw;
    try {
      raw = await request.text();
    } catch (e) {
      return syncJson({ ok: false, code: 'BAD_BODY', error: '请求体读取失败' }, 400);
    }
    if (raw.length > MAX_SYNC_PAYLOAD_CHARS) {
      return syncJson({ ok: false, code: 'PAYLOAD_TOO_LARGE', error: '同步数据超过上限' }, 413);
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch (e) {
      return syncJson({ ok: false, code: 'BAD_JSON', error: '请求体不是合法 JSON' }, 400);
    }
    const sessions = sanitizeSyncSessions(body.sessions);
    const deleted = sanitizeSyncDeleted(body.deleted);
    const envelope = JSON.stringify({ v: 1, updatedAt: Date.now(), sessions, deleted });

    if (body && Object.prototype.hasOwnProperty.call(body, 'baseEtag')) {
      const baseEtag = String(body.baseEtag || '');
      const meta = await storeGetMeta(env, key);
      if (meta.failed) return syncJson({ ok: false, code: 'R2_READ_FAILED', error: '读取同步数据失败，请稍后再试' }, 502);
      if ((meta.etag || '') !== baseEtag) {
        const current = parseSyncEnvelope(meta.text);
        return syncJson({ ok: false, code: 'SYNC_CONFLICT', sessions: current.sessions, deleted: current.deleted, updatedAt: current.updatedAt, etag: meta.etag || '' }, 409);
      }
      const res = await storePutCas(env, key, envelope, baseEtag);
      if (!res.ok) {
        if (res.conflict) {
          const now = await storeGetMeta(env, key);
          const current = parseSyncEnvelope(now.text);
          return syncJson({ ok: false, code: 'SYNC_CONFLICT', sessions: current.sessions, deleted: current.deleted, updatedAt: current.updatedAt, etag: now.etag || '' }, 409);
        }
        return syncJson({ ok: false, code: 'R2_WRITE_FAILED', error: '写入同步数据失败' }, 502);
      }
      return syncJson({ ok: true, enabled: true, updatedAt: Date.now(), etag: res.etag || '' });
    }

    // 无 baseEtag：服务端合并兜底，避免旧客户端整表覆盖掉别的设备的新会话。
    const meta = await storeGetMeta(env, key);
    if (meta.failed) return syncJson({ ok: false, code: 'R2_READ_FAILED', error: '读取同步数据失败，请稍后再试' }, 502);
    const current = parseSyncEnvelope(meta.text);
    const mergedDeleted = sanitizeSyncDeleted([...deleted, ...current.deleted]);
    const merged = mergeSyncSessions(sessions, current.sessions, mergedDeleted);
    const mergedEnvelope = JSON.stringify({ v: 1, updatedAt: Date.now(), sessions: merged, deleted: mergedDeleted });
    const okPut = await storePutChecked(env, key, mergedEnvelope);
    if (!okPut) return syncJson({ ok: false, code: 'R2_WRITE_FAILED', error: '写入同步数据失败' }, 502);
    const after = await storeGetMeta(env, key);
    return syncJson({ ok: true, enabled: true, merged: true, sessions: merged, deleted: mergedDeleted, updatedAt: Date.now(), etag: after.etag || '' });
  }

  return syncJson({ ok: false, code: 'METHOD_NOT_ALLOWED', error: '不支持的方法' }, 405);
}

export {
  handleWebSessions,
  webSessionsKeyForToken,
  sanitizeSyncSessions,
  sanitizeSyncDeleted,
  mergeSyncSessions,
  parseSyncEnvelope,
  MAX_SYNC_PAYLOAD_CHARS,
};
