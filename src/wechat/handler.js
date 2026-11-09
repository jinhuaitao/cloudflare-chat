// Cloudflare-Chat 微信 ClawBot（iLink Bot API / openclaw-weixin）全功能通道处理器：
// 支持：
// 1) 四重防盗绑安全机制：
//    - 强制管理鉴权：未配置 WX_ADMIN_SECRET 且未配置 ACCESS_PASSWORD 时严禁网页端扫码/解绑，杜绝公开网址被路人盗绑；
//    - 独立管理员密钥：支持配置专属 WX_ADMIN_SECRET（与普通访客的 ACCESS_PASSWORD 分离），未通过管理员鉴权时 /api/wx/status 隐藏一切敏感信息；
//    - 已绑定防覆盖锁：已处于有效连接状态时禁止直接生成新二维码覆盖，需管理员显式解锁/解绑；
//    - 号主自动校准与白名单：支持 WX_ALLOWED_USERS 白名单，未配置白名单时自动绑定并校准扫码微信号；
// 2) 三栖全天候消息接入：
//    - Cloudflare Cron Triggers（scheduled，每分钟满周期连续长轮询，无需开网页）；
//    - 网页全局自动守护长轮询（绑定后自动开启）与免开网页保活唤醒（GET/POST /wx-webhook?key=...）；
//    - 第三方 iLink 网关 Webhook 消息推送；
// 3) 完整支持扫码节点重定向（scaned_but_redirect / binded_redirect）与数字配对码（need_verifycode）；
// 4) 原生微信加密图片直发（getuploadurl + AES-128-ECB + CDN 上传 + image_item），支持文生图模型与「画 <描述>」快捷生图；
// 5) 微信专属 Markdown 智能排版清洗（formatWechatText），告别裸露的 ** 与 ### 符号；
// 6) 中英双语快捷口令（菜单/帮助、模型/模型 序号、智能体/模式、画 <描述>、清空、记忆、忘掉、知识库、状态）+ 网页端会话同步与实时收发诊断日志。

import { APP_VERSION, CORS_HEADERS } from '../constants.js';
import { mapSetBounded, mapGetBounded, mapLimit, parseCommaSeparated, safeEqual } from '../utils.js';
import { storeGet, storePut, storePutChecked, storeDelete } from '../store/r2.js';
import { getChannelConfig, resolveModelKey, buildAIRequest } from '../channel.js';
import { tgTrimHistory, tgGetHistory, tgSaveHistory, tgClearHistory } from '../tg-history.js';
import { agentForgetMemory } from '../agent/memory.js';
import { memoryReport, memoryClearSession, memoryStats } from '../memory/index.js';
import { agentGetMode, agentSetMode } from '../agent/mode.js';
import { agentLoadResumeState, agentClearResumeState, tgAgentResumeKey } from '../agent/resume.js';
import { tgAgentChat, tgAgentResume } from '../agent/loop.js';
import { readErrorBody } from '../agent/stability.js';
import { toolSaveDoc, toolListDocs, toolReadDoc, toolDeleteDoc, kbSearchDocBody,
  kbReadDocTextCached } from '../kb/doc-tools.js';
import { kbGetRegistry, KB_DOCS_PREFIX } from '../kb/registry.js';
import { autoOrganizeAndSaveKbDoc, deriveFileDocTitle } from '../kb/organize.js';
import {
  DEFAULT_ILINK_BASE_URL,
  DEFAULT_ILINK_CDN_URL,
  DEFAULT_ILINK_CHANNEL_VERSION,
  normalizeBaseUrl,
  ilinkGetQrCode,
  ilinkGetQrStatus,
  ilinkNotifyStart,
  ilinkNotifyStop,
  ilinkGetUpdates,
  ilinkGetConfig,
  ilinkSendTyping,
  ilinkSendMessage,
  formatWechatText,
  md5Hex,
  ilinkDownloadMediaBytes,
  ilinkUploadAndSendImage,
  SUPPORTED_KB_FILE_EXT_RE,
  extractWechatDocumentText,
  extractWechatMessageContent,
} from './ilink.js';
import { splitWechatText, parseWxCommand } from './text.js';

// ================= R2 键名与 L1 内存缓存 =================
const WX_CREDS_KEY = 'wx_clawbot_creds';
const WX_DEDUP_KEY = 'wx_updates_dedup';
const WX_POLL_LOCK_KEY = 'wx_poll_lock';
const WX_DIAG_KEY = 'wx_diag_state';
const WX_DEDUP_WINDOW_MS = 10 * 60 * 1000;
const WX_DEDUP_MAX = 200;

let cachedWxCreds = null;
let cachedWxCredsExp = 0;

const wxUserModels = new Map();
const wxUserModelsExp = new Map();

const wxContextTokens = new Map();
const wxContextTokensExp = new Map();

const wxTypingTickets = new Map();
const wxTypingTicketsExp = new Map();

const wxCursors = new Map();
const wxCursorsExp = new Map();

const wxQrRedirectNodes = new Map();
const seenWxMsgIds = new Map();
let activePollInIsolate = false;
let lastDaemonWakeCheckAt = 0;
let lastKnownPublicOrigin = '';

function isRealPublicOrigin(origin) {
  if (!origin || typeof origin !== 'string') return false;
  if (!/^https?:\/\//i.test(origin)) return false;
  if (/example\.com|localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(origin)) return false;
  return true;
}

function rememberPublicOrigin(urlOrOrigin) {
  try {
    const o = typeof urlOrOrigin === 'string' && urlOrOrigin.startsWith('http')
      ? new URL(urlOrOrigin).origin
      : (urlOrOrigin && urlOrOrigin.origin ? urlOrOrigin.origin : '');
    if (isRealPublicOrigin(o)) lastKnownPublicOrigin = o;
    return lastKnownPublicOrigin;
  } catch (e) {
    return lastKnownPublicOrigin;
  }
}

function computeWxRelayToken(botToken) {
  const t = String(botToken || '').trim();
  if (!t) return '';
  return md5Hex(new TextEncoder().encode('wx_self_relay_v1_' + t));
}

const wxDiagMem = {
  lastPollAt: 0,
  lastInboundAt: 0,
  lastReplyAt: 0,
  lastError: '',
  totalPolls: 0,
  totalProcessed: 0,
  events: [],
};

async function wxRecordDiag(env, kind, detail, userId = '', persist = false) {
  const now = Date.now();
  if (kind === 'poll') {
    wxDiagMem.lastPollAt = now;
    wxDiagMem.totalPolls += 1;
  } else if (kind === 'inbound') {
    wxDiagMem.lastInboundAt = now;
  } else if (kind === 'reply' || kind === 'image') {
    wxDiagMem.lastReplyAt = now;
    wxDiagMem.totalProcessed += 1;
  } else if (kind === 'error') {
    wxDiagMem.lastError = String(detail || '').slice(0, 240);
  }
  if (kind !== 'poll') {
    wxDiagMem.events.unshift({
      ts: now,
      kind,
      userId: String(userId || ''),
      detail: String(detail || '').slice(0, 220),
    });
    if (wxDiagMem.events.length > 20) wxDiagMem.events.length = 20;
  }
  if (persist && env && env.R2) {
    try {
      await storePut(env, WX_DIAG_KEY, JSON.stringify({
        lastPollAt: wxDiagMem.lastPollAt,
        lastInboundAt: wxDiagMem.lastInboundAt,
        lastReplyAt: wxDiagMem.lastReplyAt,
        lastError: wxDiagMem.lastError,
        totalPolls: wxDiagMem.totalPolls,
        totalProcessed: wxDiagMem.totalProcessed,
        events: wxDiagMem.events.slice(0, 12),
      }));
    } catch (e) {}
  }
}

async function getWxDiagSummary(env) {
  if (wxDiagMem.events.length === 0 && env && env.R2) {
    try {
      const raw = await storeGet(env, WX_DIAG_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (p && typeof p === 'object') {
          if (p.lastPollAt > wxDiagMem.lastPollAt) wxDiagMem.lastPollAt = p.lastPollAt;
          if (p.lastInboundAt > wxDiagMem.lastInboundAt) wxDiagMem.lastInboundAt = p.lastInboundAt;
          if (p.lastReplyAt > wxDiagMem.lastReplyAt) wxDiagMem.lastReplyAt = p.lastReplyAt;
          if (!wxDiagMem.lastError && p.lastError) wxDiagMem.lastError = p.lastError;
          if (p.totalPolls > wxDiagMem.totalPolls) wxDiagMem.totalPolls = p.totalPolls;
          if (p.totalProcessed > wxDiagMem.totalProcessed) wxDiagMem.totalProcessed = p.totalProcessed;
          if (Array.isArray(p.events) && p.events.length) wxDiagMem.events = p.events.slice(0, 20);
        }
      }
    } catch (e) {}
  }
  return {
    lastPollAt: wxDiagMem.lastPollAt,
    lastInboundAt: wxDiagMem.lastInboundAt,
    lastReplyAt: wxDiagMem.lastReplyAt,
    lastError: wxDiagMem.lastError,
    totalPolls: wxDiagMem.totalPolls,
    totalProcessed: wxDiagMem.totalProcessed,
    events: wxDiagMem.events.slice(0, 12),
  };
}

function wxSafeId(id) {
  return String(id == null ? '' : id).replace(/[^a-zA-Z0-9_@.-]/g, '_').slice(0, 96);
}

function wxSessionChatId(userId) {
  return 'wx_' + String(userId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 56);
}

function wxChannelVersion(env) {
  return String((env && env.WX_CHANNEL_VERSION) || DEFAULT_ILINK_CHANNEL_VERSION).trim() || DEFAULT_ILINK_CHANNEL_VERSION;
}

function uint8ToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToUint8(b64) {
  const s = String(b64 || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!s) return new Uint8Array(0);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ================= 0. 微信通道管理员鉴权（防路人盗绑核心防线） =================
function checkWxAdminAuth(env, request, url) {
  const adminSecret = String((env && env.WX_ADMIN_SECRET) || '').trim();
  const accessPwd = String((env && env.ACCESS_PASSWORD) || '').trim();
  const webhookSecret = String((env && env.WX_WEBHOOK_SECRET) || '').trim();
  const requiredSecret = adminSecret || accessPwd || webhookSecret;

  if (!requiredSecret) {
    return {
      authorized: false,
      noSecretConfigured: true,
      reason: '安全锁定：当前未配置 WX_ADMIN_SECRET 或 ACCESS_PASSWORD，为防止公开网址被他人恶意扫码绑定，已禁止网页端绑定操作。请在 Cloudflare 环境变量中设置 WX_ADMIN_SECRET（或使用 Telegram 机器人发送 /wxlogin 绑定）。',
    };
  }

  const providedAdmin = (request && request.headers && request.headers.get('X-Wx-Admin-Token')) || '';
  const providedAccess = (request && request.headers && request.headers.get('X-Access-Token')) || '';
  const providedWebhook = (request && request.headers && (request.headers.get('X-Wechat-Webhook-Secret') || request.headers.get('X-Webhook-Secret'))) || '';
  const authHeader = ((request && request.headers && request.headers.get('Authorization')) || '').replace(/^Bearer\s+/i, '').trim();
  const reqUrl = url || (request && request.url ? new URL(request.url) : null);
  const queryKey = (reqUrl && reqUrl.searchParams && reqUrl.searchParams.get('key')) || '';

  const candidates = [requiredSecret, adminSecret, accessPwd, webhookSecret].filter(Boolean);
  const inputs = [providedAdmin, providedAccess, providedWebhook, authHeader, queryKey].filter(Boolean);

  for (const inp of inputs) {
    for (const cand of candidates) {
      if (safeEqual(inp, cand)) {
        return { authorized: true, noSecretConfigured: false };
      }
    }
  }

  return {
    authorized: false,
    noSecretConfigured: false,
    reason: adminSecret
      ? '需要微信管理员密钥（WX_ADMIN_SECRET）才能执行此操作'
      : '需要访问口令（ACCESS_PASSWORD）才能执行此操作',
  };
}

// ================= 1. 微信 ClawBot 凭证存取 =================
async function getWxCredentials(env, forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && cachedWxCreds && now < cachedWxCredsExp) {
    return cachedWxCreds;
  }

  if (env && env.WX_BOT_TOKEN) {
    const token = String(env.WX_BOT_TOKEN).trim();
    const botIdFromToken = token.includes(':') ? token.split(':')[0] : 'env_bot';
    cachedWxCreds = {
      bot_token: token,
      ilink_bot_id: String(env.WX_BOT_ID || botIdFromToken).trim(),
      ilink_user_id: String(env.WX_USER_ID || '').trim(),
      baseurl: normalizeBaseUrl(env.WX_BASE_URL || DEFAULT_ILINK_BASE_URL),
      cdn_url: String(env.WX_CDN_BASE_URL || DEFAULT_ILINK_CDN_URL).trim(),
      expired: false,
      errmsg: '',
      updated_at: '',
      source: 'env',
    };
    cachedWxCredsExp = Date.now() + 30 * 1000;
    return cachedWxCreds;
  }

  if (env && env.R2) {
    try {
      const raw = await storeGet(env, WX_CREDS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.bot_token) {
          cachedWxCreds = {
            bot_token: String(parsed.bot_token).trim(),
            ilink_bot_id: String(parsed.ilink_bot_id || 'default_bot').trim(),
            ilink_user_id: String(parsed.ilink_user_id || '').trim(),
            baseurl: normalizeBaseUrl(parsed.baseurl || (env && env.WX_BASE_URL) || DEFAULT_ILINK_BASE_URL),
            cdn_url: String(parsed.cdn_url || (env && env.WX_CDN_BASE_URL) || DEFAULT_ILINK_CDN_URL).trim(),
            expired: !!parsed.expired,
            errmsg: parsed.errmsg || '',
            updated_at: parsed.updated_at || '',
            relay_origin: String(parsed.relay_origin || ''),
            source: 'r2',
          };
          cachedWxCredsExp = Date.now() + 30 * 1000;
          return cachedWxCreds;
        }
      }
    } catch (e) {}
  }

  return null;
}

async function saveWxCredentials(env, creds) {
  const clean = {
    bot_token: String(creds.bot_token || '').trim(),
    ilink_bot_id: String(creds.ilink_bot_id || 'default_bot').trim(),
    ilink_user_id: String(creds.ilink_user_id || '').trim(),
    baseurl: normalizeBaseUrl(creds.baseurl || (env && env.WX_BASE_URL) || DEFAULT_ILINK_BASE_URL),
    cdn_url: String(creds.cdn_url || (env && env.WX_CDN_BASE_URL) || DEFAULT_ILINK_CDN_URL).trim(),
    expired: !!creds.expired,
    errmsg: String(creds.errmsg || ''),
    updated_at: creds.updated_at || new Date().toISOString(),
    relay_origin: String(creds.relay_origin || lastKnownPublicOrigin || ''),
    source: 'r2',
  };
  cachedWxCreds = clean;
  cachedWxCredsExp = Date.now() + 30 * 1000;
  if (env && env.R2) {
    return await storePutChecked(env, WX_CREDS_KEY, JSON.stringify(clean));
  }
  return true;
}

async function markWxSessionExpired(env, creds, errmsg) {
  if (!creds) return;
  const msg = String(errmsg || '会话已过期 (ret=-14)，请重新扫码绑定');
  await wxRecordDiag(env, 'error', msg, creds.ilink_user_id, true);
  const updated = Object.assign({}, creds, {
    expired: true,
    errmsg: msg,
    updated_at: new Date().toISOString(),
  });
  cachedWxCreds = updated;
  cachedWxCredsExp = Date.now() + 30 * 1000;
  if (env && env.R2 && creds.source !== 'env') {
    await storePut(env, WX_CREDS_KEY, JSON.stringify(updated));
  }
  if (creds.ilink_bot_id) {
    wxCursors.delete(creds.ilink_bot_id);
    wxCursorsExp.delete(creds.ilink_bot_id);
    await storeDelete(env, 'wx_cursor_' + wxSafeId(creds.ilink_bot_id));
  }
}

async function clearWxCredentials(env) {
  const prev = await getWxCredentials(env);
  cachedWxCreds = null;
  cachedWxCredsExp = 0;
  if (prev && prev.ilink_bot_id) {
    wxCursors.delete(prev.ilink_bot_id);
    wxCursorsExp.delete(prev.ilink_bot_id);
    await storeDelete(env, 'wx_cursor_' + wxSafeId(prev.ilink_bot_id));
  }
  await storeDelete(env, WX_CREDS_KEY);
}

// ================= 2. 游标与 Context Token 持久化 =================
async function getWxCursor(env, botId) {
  const key = wxSafeId(botId || 'default_bot');
  const cached = mapGetBounded(wxCursors, key, env && env.R2 ? wxCursorsExp : null);
  if (typeof cached === 'string') return cached;
  const raw = await storeGet(env, 'wx_cursor_' + key);
  const val = typeof raw === 'string' ? raw : '';
  mapSetBounded(wxCursors, key, val, 100, wxCursorsExp, 60 * 1000);
  return val;
}

async function saveWxCursor(env, botId, buf) {
  if (buf === undefined || buf === null) return;
  const key = wxSafeId(botId || 'default_bot');
  const s = String(buf);
  const prev = mapGetBounded(wxCursors, key);
  mapSetBounded(wxCursors, key, s, 100, wxCursorsExp, 60 * 1000);
  if (s !== prev) {
    await storePut(env, 'wx_cursor_' + key, s);
  }
}

async function getWxContextToken(env, userId) {
  const key = wxSafeId(userId || 'default_user');
  const cached = mapGetBounded(wxContextTokens, key, env && env.R2 ? wxContextTokensExp : null);
  if (typeof cached === 'string' && cached) return cached;
  const raw = await storeGet(env, 'wx_ctx_' + key);
  if (raw) {
    mapSetBounded(wxContextTokens, key, raw, 500, wxContextTokensExp, 5 * 60 * 1000);
    return raw;
  }
  return '';
}

async function saveWxContextToken(env, userId, contextToken) {
  if (!userId || !contextToken) return;
  const key = wxSafeId(userId);
  const ct = String(contextToken).trim();
  if (!ct) return;
  const prev = mapGetBounded(wxContextTokens, key);
  mapSetBounded(wxContextTokens, key, ct, 500, wxContextTokensExp, 5 * 60 * 1000);
  if (ct !== prev) {
    await storePut(env, 'wx_ctx_' + key, ct);
    await storePut(env, 'wx_last_peer', JSON.stringify({
      user_id: String(userId),
      context_token: ct,
      ts: Date.now(),
    }));
  }
}

async function getWxLastPeer(env) {
  try {
    const raw = await storeGet(env, 'wx_last_peer');
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return null;
}

// ================= 3. 入站消息去重 =================
async function loadWxDedupWindow(env) {
  try {
    const raw = await storeGet(env, WX_DEDUP_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) return p;
    }
  } catch (e) {}
  return [];
}

async function markWxMsgSeen(env, msgKey) {
  if (!msgKey) return false;
  const now = Date.now();
  if (seenWxMsgIds.has(msgKey)) return true;
  const win = await loadWxDedupWindow(env);
  const fresh = win.filter(e => e && e.id && now - (e.ts || 0) < WX_DEDUP_WINDOW_MS);
  if (fresh.some(e => e.id === msgKey)) {
    seenWxMsgIds.set(msgKey, now);
    return true;
  }
  fresh.push({ id: msgKey, ts: now });
  if (fresh.length > WX_DEDUP_MAX) fresh.splice(0, fresh.length - WX_DEDUP_MAX);
  try { await storePutChecked(env, WX_DEDUP_KEY, JSON.stringify(fresh)); } catch (e) {}
  seenWxMsgIds.set(msgKey, now);
  for (const [k, t] of seenWxMsgIds) {
    if (now - t > WX_DEDUP_WINDOW_MS) seenWxMsgIds.delete(k);
  }
  return false;
}

async function releaseWxMsgForRetry(env, msgKey) {
  if (!msgKey) return;
  seenWxMsgIds.delete(msgKey);
  try {
    const win = await loadWxDedupWindow(env);
    const fresh = win.filter(e => !(e && e.id === msgKey));
    if (fresh.length !== win.length) await storePutChecked(env, WX_DEDUP_KEY, JSON.stringify(fresh));
  } catch (e) {}
}

// ================= 4. “对方正在输入…” 状态管理 =================
async function getOrFetchTypingTicket(env, creds, userId, contextToken) {
  const key = wxSafeId(userId);
  const cached = mapGetBounded(wxTypingTickets, key, wxTypingTicketsExp);
  if (typeof cached === 'string' && cached) return cached;
  try {
    const r = await ilinkGetConfig(creds.baseurl, creds.bot_token, userId, contextToken, wxChannelVersion(env), 8000);
    if (r && r.typing_ticket) {
      mapSetBounded(wxTypingTickets, key, r.typing_ticket, 500, wxTypingTicketsExp, 18 * 3600 * 1000);
      return r.typing_ticket;
    }
  } catch (e) {}
  return '';
}

async function sendWxTypingStatus(env, creds, userId, contextToken, status) {
  try {
    const ticket = await getOrFetchTypingTicket(env, creds, userId, contextToken);
    if (!ticket) return;
    await ilinkSendTyping(creds.baseurl, creds.bot_token, userId, ticket, status, wxChannelVersion(env), 6000);
  } catch (e) {}
}

// ================= 5. 微信文本分段与中英双语口令解析 =================
// 实现已抽到 ./text.js（纯函数、可单测），这里只负责在导出表里保持原有 API 不变。

async function sendWechatImageFromSource(env, creds, userId, contextToken, source) {
  const chanVer = wxChannelVersion(env);
  let imgBytes = null;

  if (source instanceof Uint8Array) {
    imgBytes = source;
  } else if (typeof source === 'string') {
    const s = source.trim();
    if (s.startsWith('data:image/')) {
      imgBytes = base64ToUint8(s);
    } else if (/^https?:\/\//i.test(s)) {
      const r = await fetch(s, { signal: AbortSignal.timeout(20000), redirect: 'follow' });
      if (!r.ok) throw new Error(`下载生成图片失败 (HTTP ${r.status})`);
      imgBytes = new Uint8Array(await r.arrayBuffer());
    } else if (s.length > 100 && !s.includes(' ')) {
      imgBytes = base64ToUint8(s);
    }
  }

  if (!imgBytes || !imgBytes.byteLength) {
    throw new Error('未能获取到有效图片字节数据');
  }

  const res = await ilinkUploadAndSendImage(
    creds.baseurl,
    creds.cdn_url,
    creds.bot_token,
    userId,
    contextToken,
    imgBytes,
    chanVer,
    25000
  );
  if (res && (res.ret === -14 || res.errcode === -14)) {
    await markWxSessionExpired(env, creds, res.errmsg);
    throw new Error('微信会话已过期 (ret=-14)');
  }
  if (res && res.ret !== undefined && res.ret !== 0) {
    throw new Error(`发送微信图片返回错误 (ret=${res.ret} ${res.errmsg || ''})`);
  }
  await wxRecordDiag(env, 'image', `向微信发送原图成功 (${Math.round(imgBytes.byteLength / 1024)} KB)`, userId, true);
  return res;
}

const SUPPORTED_DOC_EXT_RE = /\.(md|markdown|txt|csv|tsv|json|jsonl|log|py|js|mjs|ts|tsx|jsx|html|htm|css|xml|yaml|yml|toml|ini|conf|sh|bash|sql|go|rs|java|c|cpp|h)$/i;

// 读取全部知识库文档列表与正文（供网页端自动同步展示）
// v7.7.0：复用 Agent 的 L1 正文缓存，并按 6 路并发读取（旧版逐篇串行 get，30 篇要等 30 个往返）
async function loadAllKbDocsForSync(env) {
  if (!env || !env.R2) return [];
  try {
    const reg = await kbGetRegistry(env);
    if (!Array.isArray(reg) || !reg.length) return [];
    return await mapLimit(reg.slice(0, 30), 6, async (entry) => {
      const text = (await kbReadDocTextCached(env, KB_DOCS_PREFIX + entry.file)) || '';
      const cleanBody = text.replace(/^---[\s\S]*?---\s*/, '').trim();
      return {
        file: entry.file,
        title: entry.title || entry.file,
        size: entry.size || cleanBody.length,
        updatedAt: entry.updated_at || '',
        source: entry.source || '',
        content: cleanBody.slice(0, 25000),
      };
    });
  } catch (e) {
    return [];
  }
}

// ================= 6. 单条微信入站消息核心处理 =================
async function processWechatMessage(env, creds, rawMsg) {
  const parsed = extractWechatMessageContent(rawMsg);
  if (!parsed.isUserMsg || !parsed.fromUserId) return { skipped: true, reason: 'not_user_msg' };

  const userId = parsed.fromUserId;
  const allowedUsers = parseCommaSeparated(env.WX_ALLOWED_USERS);
  if (allowedUsers.length > 0) {
    if (allowedUsers.indexOf(userId) === -1) {
      await wxRecordDiag(env, 'error', `拦截非白名单微信号: ${userId}`, userId, false);
      return { skipped: true, reason: 'user_not_in_whitelist' };
    }
  } else if (creds) {
    if (!creds.ilink_user_id || !creds.ilink_user_id.includes('@im.wechat')) {
      creds.ilink_user_id = userId;
      if (creds.source !== 'env') {
        try { await saveWxCredentials(env, creds); } catch (e) {}
      }
    } else if (creds.ilink_user_id !== userId && String((env && env.WX_ALLOW_ANY_USER) || '') !== '1') {
      await wxRecordDiag(env, 'error', `拦截非绑定人微信号: ${userId} (已绑定: ${creds.ilink_user_id})`, userId, false);
      return { skipped: true, reason: 'not_bound_owner' };
    }
  }

  let contextToken = parsed.contextToken;
  if (contextToken) {
    await saveWxContextToken(env, userId, contextToken);
  } else {
    contextToken = await getWxContextToken(env, userId);
  }
  if (!contextToken) {
    await wxRecordDiag(env, 'error', '入站消息缺少 context_token', userId, false);
    return { skipped: true, reason: 'missing_context_token' };
  }

  const dedupKey = parsed.msgId
    ? `id:${parsed.msgId}`
    : `hash:${userId}:${contextToken.slice(-24)}:${(parsed.text || '').slice(0, 48)}`;
  if (await markWxMsgSeen(env, dedupKey)) {
    return { skipped: true, reason: 'duplicate' };
  }

  const chatId = wxSessionChatId(userId);
  const chanVer = wxChannelVersion(env);
  await wxRecordDiag(
    env,
    'inbound',
    parsed.text
      ? parsed.text.slice(0, 120)
      : (parsed.imageMedia ? '[收到微信图片]' : (parsed.fileMedia ? `[收到文件: ${parsed.fileMedia.fileName}]` : '[收到媒体消息]')),
    userId,
    false
  );

  const sendReply = async (replyText, skipFormat = false) => {
    const cleanText = skipFormat ? String(replyText || '').trim() : formatWechatText(replyText);
    const chunks = splitWechatText(cleanText, 3800, 5);
    for (const chunk of chunks) {
      if (!chunk) continue;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const latestCtxToken = (await getWxContextToken(env, userId)) || contextToken;
          const r = await ilinkSendMessage(creds.baseurl, creds.bot_token, userId, chunk, latestCtxToken, chanVer, 15000);
          if (r && (r.ret === -14 || r.errcode === -14)) {
            await markWxSessionExpired(env, creds, r.errmsg);
            return;
          }
          if (r && r.ret !== undefined && r.ret !== 0) {
            throw new Error(`iLink sendmessage ret=${r.ret} ${r.errmsg || ''}`.trim());
          }
          break;
        } catch (e) {
          if (attempt === 3) throw e;
          await new Promise(r => { const t = setTimeout(r, 600 * attempt); if (t && typeof t.unref === 'function') t.unref(); });
        }
      }
    }
    await wxRecordDiag(env, 'reply', cleanText.slice(0, 120), userId, true);
  };

  try {
    const { models: modelObjList } = getChannelConfig(env);
    if (modelObjList.length === 0) {
      await sendReply('⚠️ 尚未配置任何 AI 模型，请在环境变量中设置 API_URL_1 / API_KEY_1 / MODEL_1。', true);
      return { processed: true };
    }

    let userText = parsed.text || '';
    let historyUserText = userText;
    let multimodalContent = null;

    if (parsed.imageMedia) {
      try {
        await sendWxTypingStatus(env, creds, userId, contextToken, 1);
        let imgBytes = null;
        if (parsed.imageMedia.encryptQueryParam) {
          imgBytes = await ilinkDownloadMediaBytes(
            creds.cdn_url,
            parsed.imageMedia.encryptQueryParam,
            parsed.imageMedia.aesKey,
            3 * 1024 * 1024,
            15000
          );
        } else if (parsed.imageMedia.url) {
          const r = await fetch(parsed.imageMedia.url, { signal: AbortSignal.timeout(15000) });
          if (r.ok) imgBytes = new Uint8Array(await r.arrayBuffer());
        }
        if (imgBytes && imgBytes.byteLength > 0) {
          const dataUrl = 'data:image/jpeg;base64,' + uint8ToBase64(imgBytes);
          const promptForImg = userText || '请详细查看并分析这张图片的内容。';
          userText = promptForImg;
          historyUserText = '[微信图片] ' + promptForImg;
          multimodalContent = [
            { type: 'text', text: promptForImg },
            { type: 'image_url', image_url: { url: dataUrl } },
          ];
        } else if (!userText) {
          await sendReply('⚠️ 暂无法读取该微信图片内容，请附带文字描述或稍后重试。', true);
          return { processed: true };
        }
      } catch (e) {
        if (!userText) {
          await sendReply('⚠️ 读取微信图片失败：' + (e && e.message ? e.message : String(e)), true);
          return { processed: true };
        }
      }
    } else if (parsed.fileMedia) {
      const fm = parsed.fileMedia;
      if (!SUPPORTED_KB_FILE_EXT_RE.test(fm.fileName)) {
        await sendReply('⚠️ 暂不支持该文件格式（' + fm.fileName + '）。支持自动整理入库的格式：Word (.docx)、Excel (.xlsx)、PPT (.pptx)、PDF (.pdf)、Markdown (.md)、文本 (.txt)、表格 (.csv/.tsv)、JSON/YAML/HTML/XML 及各类代码文件。', true);
        return { processed: true };
      }
      try {
        await sendWxTypingStatus(env, creds, userId, contextToken, 1);
        const bytes = await ilinkDownloadMediaBytes(creds.cdn_url, fm.encryptQueryParam, fm.aesKey, 4 * 1024 * 1024, 20000);
        let docText = await extractWechatDocumentText(fm.fileName, bytes);
        if (!docText || !docText.trim()) {
          await sendWxTypingStatus(env, creds, userId, contextToken, 2);
          await sendReply(`⚠️ 文件《${fm.fileName}》未能解析出有效文本内容。`, true);
          return { processed: true };
        }
        if (docText.length > 90000) {
          docText = docText.slice(0, 90000) + '\n\n…（文件较长，已截取前 90000 字符）';
        }

        // 获取当前选中的模型
        let fModelId = mapGetBounded(wxUserModels, chatId, env && env.R2 ? wxUserModelsExp : null);
        if (!fModelId) fModelId = await storeGet(env, `tg_user_${chatId}`);
        const useModelId = resolveModelKey(modelObjList, fModelId) || modelObjList[0].key;

        const docTitle = deriveFileDocTitle(userText, fm.fileName);
        const orgRes = await autoOrganizeAndSaveKbDoc(
          env,
          chatId,
          useModelId,
          docTitle,
          docText,
          'wechat_file:' + fm.fileName,
          userText
        );
        await sendWxTypingStatus(env, creds, userId, contextToken, 2);

        const kbReply = `📚 文件《${fm.fileName}》整理完成\n`
          + `────────────\n`
          + `${orgRes.organizedSummary}\n`
          + `────────────\n`
          + `✅ 入库状态：${orgRes.saveResult}\n`
          + `🔄 已自动同步至微信、Telegram 与网页端「📚 知识库中心」，后续在任意端直接提问即可自动检索引用！`;

        // 将本次文件整理结果同步写入会话历史，方便后续直接追问及网页端同步查看
        const baseHist = await tgGetHistory(env, chatId);
        let nextHist = baseHist.slice();
        nextHist.push({ role: 'user', content: `【上传文件并自动整理入库：《${fm.fileName}》】\n` + docText.slice(0, 4000) });
        nextHist.push({ role: 'assistant', content: kbReply });
        nextHist = tgTrimHistory(nextHist, env);
        await tgSaveHistory(env, chatId, nextHist);

        await wxRecordDiag(env, 'reply', `自动整理文件入库《${docTitle}》(${docText.length}字)`, userId, true);
        await sendReply(kbReply);
        return { processed: true };
      } catch (e) {
        await sendWxTypingStatus(env, creds, userId, contextToken, 2);
        await sendReply('⚠️ 解析并整理微信上传文件失败：' + (e && e.message ? e.message : String(e)), true);
        return { processed: true };
      }
    } else if (!userText && parsed.unsupportedMediaType) {
      await sendReply(`⚠️ 收到${parsed.unsupportedMediaType}，当前通道支持文字、语音转文字、发图识图、画图生成及文本类文档（.md/.txt/.csv/.json/代码）。`, true);
      return { processed: true };
    }

    if (!userText) return { skipped: true, reason: 'empty_text' };

    let targetModelId = mapGetBounded(wxUserModels, chatId, env && env.R2 ? wxUserModelsExp : null);
    if (!targetModelId) {
      targetModelId = await storeGet(env, `tg_user_${chatId}`);
      if (targetModelId) mapSetBounded(wxUserModels, chatId, targetModelId, undefined, wxUserModelsExp);
    }
    const activeModelId = resolveModelKey(modelObjList, targetModelId) || modelObjList[0].key;
    const activeModelObj = modelObjList.find(m => m.key === activeModelId) || modelObjList[0];

    const cmd = !multimodalContent ? parseWxCommand(userText) : null;

    if (cmd && (cmd.cmd === '/start' || cmd.cmd === '/model')) {
      const arg = cmd.rest.trim();
      if (cmd.cmd === '/model' && arg) {
        let picked = null;
        const idx = parseInt(arg, 10);
        if (String(idx) === arg && idx >= 1 && idx <= modelObjList.length) {
          picked = modelObjList[idx - 1];
        } else {
          const q = arg.toLowerCase();
          picked = modelObjList.find(m => m.key.toLowerCase() === q || m.id.toLowerCase() === q || m.name.toLowerCase() === q)
            || modelObjList.find(m => m.key.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
        }
        if (!picked) {
          await sendReply(`⚠️ 未找到匹配的模型「${arg}」。\n请直接发送「模型」或「/model」查看可用模型列表与编号。`, true);
          return { processed: true };
        }
        mapSetBounded(wxUserModels, chatId, picked.key, undefined, wxUserModelsExp);
        await storePut(env, `tg_user_${chatId}`, picked.key);
        await sendReply(`✅ 已切换模型为：${picked.name} (${picked.id})`, true);
        return { processed: true };
      }

      const useAgentNow = await agentGetMode(env, chatId);
      const listLines = modelObjList.map((m, i) => {
        const mark = m.key === activeModelId ? ' ✅ [当前]' : '';
        // 同名模型来自不同通道时补主机名，否则列表里两行完全一样、用户无从区分
        const hint = m.channelHint ? ' @' + m.channelHint : '';
        return `${i + 1}. ${m.name} (${m.id})${hint}${mark}`;
      }).join('\n');

      await sendReply(
        `🟢 Cloudflare-Chat 微信 ClawBot 助手 (v${APP_VERSION})\n`
        + `────────────\n`
        + `🤖 当前模式：${useAgentNow ? 'Agent 智能体（19 项工具 + 三层记忆 + 知识库）' : '普通对话模式'}\n`
        + `🎯 可用模型列表：\n${listLines}\n\n`
        + `💡 微信快捷口令（无需敲斜杠，直接发中文即可）：\n`
        + `• 发「模型 序号」（如：模型 2）—— 切换模型\n`
        + `• 发「画 画面描述」—— AI 生图并直接发原图到微信\n`
        + `• 发「模式」—— 切换 Agent / 普通对话\n`
        + `• 发「清空」—— 开启新对话\n`
        + `• 发「菜单」—— 查看完整功能指南`,
        true
      );
      return { processed: true };
    }

    if (cmd && (cmd.cmd === '/clear' || cmd.cmd === '/new')) {
      await tgClearHistory(env, chatId);
      await agentClearResumeState(env, chatId);
      // v7.10.0：/clear 连 L1 工作记忆一起清（换话题语义），L2 长期事实与 L3 归档保留
      await memoryClearSession(env, chatId);
      await sendReply('🧹 当前微信会话上下文已清空（含本会话工作记忆），长期记忆与归档保留，可以开始新的话题了。', true);
      return { processed: true };
    }

    if (cmd && cmd.cmd === '/help') {
      const useAgentNow = await agentGetMode(env, chatId);
      await sendReply(
        `🤖 微信 ClawBot 完整功能与口令菜单\n`
        + `────────────\n`
        + `📌 当前模型：${activeModelObj.name}\n`
        + `📌 当前模式：${useAgentNow ? '🤖 Agent 智能体模式' : '💬 普通对话模式'}\n\n`
        + `▎一、中文快捷口令（也可带 / 斜杠）\n`
        + `• 「模型」或 /model —— 查看模型列表\n`
        + `• 「模型 2」或 /model 2 —— 切换到第 2 个模型\n`
        + `• 「画 宇航员猫咪」或 /draw —— 生成图片并直发微信原图\n`
        + `• 「模式」或 /agent —— 切换 Agent / 普通对话模式\n`
        + `• 「清空」或 /clear —— 清空对话上下文\n`
        + `• 「记忆」或 /memory —— 查看长期记忆（平时说「记住…」即可保存）\n`
        + `• 「忘掉 关键词」或 /forget —— 删除指定记忆\n`
        + `• 「知识库」或 /kb —— 查看知识库文档与三层记忆统计\n`
        + `• 「整理知识库 标题」或 /savekb 标题 —— 把刚聊的内容自动整理成结构化文档入库\n`
        + `• 「读取文档 标题」或 /readdoc 标题 —— 精读某篇文档全文\n`
        + `• 「删除文档 标题」或 /deldoc 标题 —— 删除某篇文档\n`
        + `• 「状态」或 /status —— 查看通道健康度与会话统计\n`
        + `• 「继续」—— 当长任务暂停时接着完成推理\n\n`
        + `▎二、多模态能力\n`
        + `• 🎙️ 发语音：自动语音转文字并回答\n`
        + `• 🖼️ 发图片：自动解密并进行 Vision 视觉分析\n`
        + `• 📄 发文件：Word/Excel/PPT/PDF/Markdown/文本/表格/代码均可，发送即【自动整理并入库】\n`
        + `   附言「把《标题》存进知识库」可自定义文档标题`,
        true
      );
      return { processed: true };
    }

    if (cmd && cmd.cmd === '/status') {
      const useAgentNow = await agentGetMode(env, chatId);
      const st = await memoryStats(env, chatId);
      const hist = await tgGetHistory(env, chatId);
      await sendReply(
        `📊 微信 ClawBot 运行状态\n`
        + `────────────\n`
        + `• 连接状态：🟢 在线正常\n`
        + `• 当前模型：${activeModelObj.name} (${activeModelObj.id})\n`
        + `• 对话模式：${useAgentNow ? '🤖 Agent 智能体模式' : '💬 普通对话模式'}\n`
        + `• 上下文轮数：${Math.floor(hist.length / 2)} 轮（${hist.length} 条消息）\n`
        + `• L1 工作记忆：${st.l1Items} 个话题 / ${st.l1Pins} 条固定\n`
        + `• L2 长期记忆：${st.l2} 条｜L3 归档：${st.l3} 条\n`
        + `• 持久化存储：${env && env.R2 ? '✅ R2 已绑定' : '⚠️ 内存模式'}\n`
        + `• 累计轮询/回复：${wxDiagMem.totalPolls} 次 / ${wxDiagMem.totalProcessed} 条`,
        true
      );
      return { processed: true };
    }

    if (cmd && cmd.cmd === '/memory') {
      const text = await memoryReport(env, chatId);
      for (let s = 0; s < text.length; s += 1800) {
        await sendReply(text.slice(s, s + 1800), true);
      }
      return { processed: true };
    }

    if (cmd && cmd.cmd === '/kb') {
      const st = await memoryStats(env, chatId);
      let text = '📚 知识库总览（三端实时自动同步）\n────────────\n';
      text += `🧠 三层记忆：L1 ${st.l1Items} 个话题 / ${st.l1Pins} 条固定｜L2 ${st.l2} 条｜L3 ${st.l3} 条（发「记忆」查看）\n\n`;
      text += await toolListDocs(env, { verify: true });
      text += '\n\n💡 快捷操作：\n• 直接在微信发送文件（.docx/.xlsx/.pptx/.pdf/.md/.txt/.csv/代码）即可【自动整理入库】\n• 发「整理知识库 标题」可将刚聊的内容自动整理入库\n• 发「读取文档 标题」查看内容 | 发「删除文档 标题」删除';
      await sendReply(text, true);
      return { processed: true };
    }

    if (cmd && cmd.cmd === '/readdoc') {
      const q = cmd.rest.trim();
      if (!q) {
        await sendReply('📖 用法：发送「读取文档 标题关键词」或「/readdoc 标题关键词」', true);
      } else {
        const content = await toolReadDoc(env, { query: q, offset: 0 });
        await sendReply(content);
      }
      return { processed: true };
    }

    if (cmd && cmd.cmd === '/deldoc') {
      const q = cmd.rest.trim();
      if (!q) {
        await sendReply('🗑️ 用法：发送「删除文档 标题关键词」或「/deldoc 标题关键词」', true);
      } else {
        const res = await toolDeleteDoc(env, { query: q });
        await sendReply('🗑️ ' + res, true);
      }
      return { processed: true };
    }

    if (cmd && cmd.cmd === '/savekb') {
      await sendWxTypingStatus(env, creds, userId, contextToken, 1);
      const hist = await tgGetHistory(env, chatId);
      if (!hist.length) {
        await sendWxTypingStatus(env, creds, userId, contextToken, 2);
        await sendReply('⚠️ 当前会话暂无上下文可整理。你可以直接发送文件给我自动整理入库，或先聊几句再发「整理知识库 标题」。', true);
        return { processed: true };
      }
      const recentTurns = hist.slice(-12).map(m => `${m.role === 'assistant' ? 'AI' : '用户'}：${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n\n');
      const customTitle = cmd.rest.trim() || ('对话知识整理_' + new Date().toISOString().slice(0, 10));
      const orgRes = await autoOrganizeAndSaveKbDoc(env, chatId, activeModelId, customTitle, recentTurns, 'wechat_chat_summary');
      await sendWxTypingStatus(env, creds, userId, contextToken, 2);
      await sendReply(
        `📚 知识库整理完成：《${orgRes.title}》\n`
        + `────────────\n`
        + `${orgRes.organizedSummary}\n`
        + `────────────\n`
        + `✅ ${orgRes.saveResult}`,
      );
      return { processed: true };
    }

    if (cmd && cmd.cmd === '/forget') {
      const kw = cmd.rest;
      if (!kw) {
        await sendReply('用法：发「忘掉 关键词」或「/forget 关键词」\n例如：忘掉 猫 —— 删除所有包含「猫」的记忆', true);
      } else {
        const rr = await agentForgetMemory(env, chatId, kw);
        await sendReply(rr.persistError ? '⚠️ ' + rr.persistError : (rr.removed > 0 ? `🗑 已删除 ${rr.removed} 条包含「${kw}」的记忆。` : `没有找到包含「${kw}」的记忆。`), true);
      }
      return { processed: true };
    }

    if (cmd && cmd.cmd === '/agent') {
      const cur = await agentGetMode(env, chatId);
      await agentSetMode(env, chatId, !cur);
      await sendReply(
        !cur
          ? '🤖 Agent 智能体模式已开启\n\n我会自主规划并调用 19 项工具（🔍 联网搜索、📄 网页抓取、🌐 维基百科、🐙 GitHub、📑 arXiv、📰 HN 热榜、💱 汇率/币价、🛰️ DNS、🧮 计算、🧰 工具箱、🌤 天气、🕐 时间），并支持 🧠 三层记忆（会话要点/长期事实/历史归档）与 📚 知识库文档读写。'
          : '💬 已切换为普通对话模式\n\n单轮直接问答，不调用工具、不使用长期记忆。如需切回请再发「模式」或 /agent。',
        true
      );
      return { processed: true };
    }

    if (cmd && cmd.cmd === '/draw') {
      const drawPrompt = cmd.rest.trim();
      if (!drawPrompt) {
        await sendReply('🎨 用法：发送「画 画面描述」或「/draw 画面描述」\n例如：画 一只穿宇航服在月球喝咖啡的橘猫，赛博朋克风格', true);
        return { processed: true };
      }
      await sendWxTypingStatus(env, creds, userId, contextToken, 1);

      let drawModelId = activeModelId;
      for (const m of modelObjList) {
        const probe = buildAIRequest(env, m.key, [{ role: 'user', content: drawPrompt }], false);
        if (probe && probe.isImageAPI) {
          drawModelId = m.key;
          break;
        }
      }

      const drawCfg = buildAIRequest(env, drawModelId, [{ role: 'user', content: drawPrompt }], false);
      if (drawCfg && drawCfg.isImageAPI) {
        try {
          const resp = await fetch(drawCfg.apiUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${drawCfg.currentApiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(drawCfg.payload),
            signal: AbortSignal.timeout(60000),
          });
          if (!resp.ok) {
            const errTxt = await readErrorBody(resp, 300);
            await sendWxTypingStatus(env, creds, userId, contextToken, 2);
            await sendReply(`⚠️ 图像生成接口报错 (HTTP ${resp.status})：${errTxt}`, true);
            return { processed: true };
          }
          const imgData = await resp.json();
          const item = (imgData && Array.isArray(imgData.data) && imgData.data[0])
            || (imgData && Array.isArray(imgData.images) && imgData.images[0])
            || null;
          const imgSource = item ? (item.b64_json ? ('data:image/png;base64,' + item.b64_json) : item.url) : '';
          await sendWxTypingStatus(env, creds, userId, contextToken, 2);
          if (!imgSource) {
            await sendReply('⚠️ 图像接口未返回有效图片数据。', true);
            return { processed: true };
          }
          try {
            await sendWechatImageFromSource(env, creds, userId, contextToken, imgSource);
          } catch (uploadErr) {
            if (/^https?:\/\//i.test(imgSource)) {
              await sendReply(`🎨 图片已生成（微信 CDN 原图投递降级，请点击链接查看）：\n${imgSource}`, true);
            } else {
              await sendReply('⚠️ 微信原图投递失败：' + (uploadErr && uploadErr.message ? uploadErr.message : String(uploadErr)), true);
            }
          }
          return { processed: true };
        } catch (e) {
          await sendWxTypingStatus(env, creds, userId, contextToken, 2);
          await sendReply('⚠️ 生图请求异常：' + (e && e.message ? e.message : String(e)), true);
          return { processed: true };
        }
      }
      userText = drawPrompt;
      historyUserText = '画 ' + drawPrompt;
    }

    // 异步非阻塞触发“对方正在输入…”并启动 5s 自动续期心跳，确保长推理/生图期间手机端提示不中断
    sendWxTypingStatus(env, creds, userId, contextToken, 1).catch(() => {});
    const typingHeartbeatTimer = setInterval(() => {
      sendWxTypingStatus(env, creds, userId, contextToken, 1).catch(() => {});
    }, 5000);
    if (typingHeartbeatTimer && typeof typingHeartbeatTimer.unref === 'function') {
      typingHeartbeatTimer.unref();
    }

    const modelProbe = buildAIRequest(env, activeModelId, [{ role: 'user', content: userText }], false);
    const isDirectImageModel = !!(modelProbe && modelProbe.isImageAPI);

    const useAgent = !isDirectImageModel && (await agentGetMode(env, chatId));
    const wantResume = useAgent && !multimodalContent && userText.trim() === '继续';
    let resumeState = null;
    if (wantResume) resumeState = await agentLoadResumeState(env, chatId);
    if (useAgent && !resumeState) await agentClearResumeState(env, chatId);

    const baseHistory = await tgGetHistory(env, chatId);
    let history = baseHistory.slice();
    if (!resumeState) {
      history.push({ role: 'user', content: multimodalContent || userText });
      history = tgTrimHistory(history, env);
    }

    let replyText = null;
    let directImageSource = null;
    let agentErr = null;

    let wxBudgetMs = parseInt(env.WX_WEBHOOK_BUDGET_MS || env.TG_WEBHOOK_BUDGET_MS || '55000', 10);
    if (!(wxBudgetMs >= 10000)) wxBudgetMs = 55000;
    if (wxBudgetMs > 240000) wxBudgetMs = 240000;

    let lastTypingSent = Date.now();
    const wxCompatApi = async (method) => {
      if (method === 'sendChatAction') {
        const now = Date.now();
        if (now - lastTypingSent >= 5000) {
          lastTypingSent = now;
          await sendWxTypingStatus(env, creds, userId, contextToken, 1);
        }
      }
      return { ok: true };
    };

    if (useAgent && !multimodalContent) {
      const onProgress = async () => {
        const now = Date.now();
        if (now - lastTypingSent >= 5500) {
          lastTypingSent = now;
          await sendWxTypingStatus(env, creds, userId, contextToken, 1);
        }
      };
      const agentOpts = {
        maxRuntimeMs: wxBudgetMs,
        resumeKey: tgAgentResumeKey(chatId),
        origUserText: historyUserText,
      };
      const runAgentTurn = (allowTools) => {
        if (resumeState) {
          return tgAgentResume(env, wxCompatApi, chatId, {
            targetModelId: resumeState.targetModelId || activeModelId,
            allowTools,
            messages: resumeState.messages,
            loopStartIdx: resumeState.loopStartIdx,
            origUserText: resumeState.origUserText || '',
            // v7.5.0：续做时恢复原轮的只读权限位与知识库可用性
            kbReadOnly: !!resumeState.kbReadOnly,
            hasKbDocs: resumeState.hasKbDocs,
          }, onProgress, agentOpts);
        }
        return tgAgentChat(env, wxCompatApi, chatId, activeModelId, history, allowTools, onProgress, agentOpts);
      };

      let r;
      try {
        r = await runAgentTurn(true);
        if (r.fallback) r = await runAgentTurn(false);
      } catch (e) {
        r = { error: '⚠️ Agent 执行出错：' + (e && e.message ? e.message : String(e)) };
      }

      if (r.error) {
        agentErr = r.error;
      } else {
        replyText = r.text;
        if (r.isImage && replyText) {
          const mUrl = /\((https?:\/\/[^\s)]+|data:image\/[^\s)]+)\)/.exec(replyText);
          if (mUrl) directImageSource = mUrl[1];
        }
        if (!r.paused) {
          if (!r.isImage && replyText) {
            let finalHist = baseHistory.slice();
            const qToSave = resumeState ? (resumeState.origUserText || '') : historyUserText;
            if (qToSave) finalHist.push({ role: 'user', content: qToSave });
            finalHist.push({ role: 'assistant', content: replyText });
            finalHist = tgTrimHistory(finalHist, env);
            await tgSaveHistory(env, chatId, finalHist);
          }
          await agentClearResumeState(env, chatId);
        }
      }
    } else {
      const aiConfig = buildAIRequest(env, activeModelId, history, false);
      if (aiConfig.error) {
        await sendWxTypingStatus(env, creds, userId, contextToken, 2);
        await sendReply('⚠️ ' + aiConfig.error, true);
        return { processed: true };
      }
      const { apiUrl, currentApiKey, payload } = aiConfig;
      let aiResponse = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          aiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${currentApiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(45000),
          });
          break;
        } catch (e) {
          aiResponse = null;
          if (attempt >= 2) {
            agentErr = '⚠️ 上游接口请求失败，请稍后再试。';
            break;
          }
          await new Promise(r => setTimeout(r, 1500));
        }
      }
      if (!agentErr) {
        if (aiResponse && aiResponse.ok) {
          const aiData = await aiResponse.json();
          const imgItem = (aiData && Array.isArray(aiData.data) && aiData.data[0])
            || (aiData && Array.isArray(aiData.images) && aiData.images[0])
            || null;
          if (aiData.choices && aiData.choices[0]?.message) {
            replyText = aiData.choices[0].message.content;
          } else if (imgItem && (imgItem.b64_json || imgItem.url)) {
            directImageSource = imgItem.b64_json ? ('data:image/png;base64,' + imgItem.b64_json) : imgItem.url;
            replyText = imgItem.url ? `🎨 生成的图片：\n${imgItem.url}` : '';
          } else {
            replyText = 'AI 没有返回有效内容。';
          }
          if (aiData.choices && aiData.choices[0]?.message && replyText) {
            let finalHist = baseHistory.slice();
            finalHist.push({ role: 'user', content: historyUserText });
            finalHist.push({ role: 'assistant', content: replyText });
            finalHist = tgTrimHistory(finalHist, env);
            await tgSaveHistory(env, chatId, finalHist);
          }
        } else {
          let diag = '';
          if (aiResponse) {
            try {
              diag = `（HTTP ${aiResponse.status}：${await readErrorBody(aiResponse, 300)}）`;
            } catch (e) {}
          }
          agentErr = (multimodalContent ? '⚠️ 当前模型可能不支持图片识别（请发「模型」切换多模态模型）。' : '⚠️ AI 接口请求失败，请稍后再试。') + diag;
        }
      }
    }

    clearInterval(typingHeartbeatTimer);
    sendWxTypingStatus(env, creds, userId, contextToken, 2).catch(() => {});

    if (agentErr) {
      await wxRecordDiag(env, 'error', agentErr, userId, true);
      await sendReply(agentErr, true);
      return { processed: true };
    }

    if (!directImageSource && replyText) {
      const mdImgMatch = /!\[[^\]]*\]\((https?:\/\/[^\s)]+|data:image\/[^\s)]+)\)/.exec(replyText);
      if (mdImgMatch) directImageSource = mdImgMatch[1];
    }

    if (directImageSource) {
      try {
        await sendWechatImageFromSource(env, creds, userId, contextToken, directImageSource);
        const textWithoutImg = String(replyText || '')
          .replace(/\[🖼️ 点击查看生成的图片\]\([^)]+\)/g, '')
          .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
          .replace(/^🎨 生成的图片：\s*https?:\/\/\S+$/gm, '')
          .trim();
        if (textWithoutImg) {
          await sendReply(textWithoutImg);
        }
        return { processed: true };
      } catch (imgErr) {
        if (replyText) {
          await sendReply(replyText);
        } else {
          await sendReply('⚠️ 微信图片发送失败：' + (imgErr && imgErr.message ? imgErr.message : String(imgErr)), true);
        }
        return { processed: true };
      }
    }

    if (replyText) {
      await sendReply(replyText);
    }
    return { processed: true };
  } catch (err) {
    try { if (typeof typingHeartbeatTimer !== 'undefined') clearInterval(typingHeartbeatTimer); } catch (e) {}
    await releaseWxMsgForRetry(env, dedupKey);
    sendWxTypingStatus(env, creds, userId, contextToken, 2).catch(() => {});
    await wxRecordDiag(env, 'error', err && err.message ? err.message : String(err), userId, true);
    throw err;
  }
}

// ================= 7. 长轮询引擎（18s 黄金窗口防 30s 强杀 + 周期性 notifyStart 在线保活 + 独立进程处理消息） =================
// 核心工程设计（彻底解决“65 秒延迟”与“一会就显示暂时无法连接 OpenClaw”）：
// 1) 为什么之前会出现“一会就暂时无法连接 OpenClaw”？
//    因为 Serverless 平台（Cloudflare waitUntil / EdgeOne / Node undici 默认 headersTimeout）对后台任务和无响应头请求
//    有严格的【30 秒】硬性超时限制（详见 openclaw Issue #67564）。若单次轮询设为 35s~40s 或总周期设为 48s~65s，
//    运行到第 30 秒时实例就会被平台强行杀死，导致永远走不到末尾的 `triggerNextSelfRelay` 交棒，接力链当场断裂！
//    一旦停止轮询满 30~60 秒，腾讯 iLink 服务端就会判定机器人离线，在手机微信顶部弹出“暂时无法连接 OpenClaw”。
// 2) 18 秒黄金接力窗口（WX_DEFAULT_LONGPOLL_MS = 18000，锁租约 22000）：
//    每棒固定只跑 1 轮 18 秒长轮询，在第 18 秒（距离 30 秒强杀线还有整整 12 秒充裕时间！）干净结束，
//    立即释放轮询锁并握手唤醒下一棒 `/wx-webhook?relay=1`；
// 3) 周期性 `ilinkNotifyStart` 在线心跳保活：
//    每 3 棒（约 50 秒）自动向腾讯 iLink 服务端发送一次非阻塞 `notifystart` 心跳，持续刷新在线状态；
// 4) 收消息与 AI 推理彻底解耦（支持独立 `/wx-webhook?process=1` 满血生命周期）：
//    一旦收到微信消息，0ms 释放轮询锁并唤醒下一棒继续监听新消息；若当前实例已运行超过 6 秒，
//    自动将消息投递给全新的 `/wx-webhook?process=1` 实例（拥有从 0 秒起算的完整生命周期）执行 AI 推理与回复！
const WX_LOCK_DEFAULT_TTL_MS = 22000;
const WX_MIN_FULL_POLL_MS = 8000;
const WX_DEFAULT_LONGPOLL_MS = 18000;
let lastNotifyStartAt = 0;

async function isPollLockHeld(env) {
  if (activePollInIsolate) return true;
  if (!env || !env.R2) return false;
  try {
    const now = Date.now();
    const raw = await storeGet(env, WX_POLL_LOCK_KEY);
    if (raw) {
      const lock = JSON.parse(raw);
      if (lock && lock.exp > now && lock.exp - now <= 26000) {
        return true;
      }
    }
  } catch (e) {}
  return false;
}

async function acquirePollLock(env, ttlMs, force) {
  if (activePollInIsolate && !force) return false;
  if (!env || !env.R2) {
    activePollInIsolate = true;
    return true;
  }
  try {
    const now = Date.now();
    if (!force) {
      const raw = await storeGet(env, WX_POLL_LOCK_KEY);
      if (raw) {
        const lock = JSON.parse(raw);
        if (lock && lock.exp > now && lock.exp - now <= 26000) {
          return false;
        }
      }
    }
    activePollInIsolate = true;
    const leaseMs = Math.min(Math.max(parseInt(ttlMs, 10) || WX_LOCK_DEFAULT_TTL_MS, 10000), 25000);
    await storePut(env, WX_POLL_LOCK_KEY, JSON.stringify({ exp: now + leaseMs, ts: now }));
  } catch (e) {
    activePollInIsolate = true;
  }
  return true;
}

async function renewPollLock(env, ttlMs) {
  if (!env || !env.R2) return;
  try {
    const now = Date.now();
    const leaseMs = Math.min(Math.max(parseInt(ttlMs, 10) || WX_LOCK_DEFAULT_TTL_MS, 10000), 25000);
    await storePut(env, WX_POLL_LOCK_KEY, JSON.stringify({ exp: now + leaseMs, ts: now }));
  } catch (e) {}
}

async function releasePollLock(env) {
  activePollInIsolate = false;
  if (env && env.R2) {
    try { await storeDelete(env, WX_POLL_LOCK_KEY); } catch (e) {}
  }
}

// 定期向腾讯 iLink 发送 notifystart 在线心跳（每 45 秒最多一次，非阻塞），防止微信顶部弹出“暂时无法连接 OpenClaw”
function maybeSendPeriodicNotifyStart(creds, chanVer, ctx) {
  try {
    const now = Date.now();
    if (now - lastNotifyStartAt < 45000) return;
    lastNotifyStartAt = now;
    const p = ilinkNotifyStart(creds.baseurl, creds.bot_token, chanVer, 5000).catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') {
      try { ctx.waitUntil(p); } catch (e) {}
    }
  } catch (e) {}
}

// 若当前轮询实例已消耗较多时间，优先将入站消息交由全新的 `/wx-webhook?process=1` HTTP 请求实例处理（满血 60~120s 预算），失败则原地处理
async function dispatchOrProcessMessages(env, creds, pendingMsgs, effOrigin, elapsedMs, ctx) {
  let processedCount = 0;
  if (!pendingMsgs || !pendingMsgs.length) return 0;

  if (elapsedMs >= 6000 && isRealPublicOrigin(effOrigin)) {
    try {
      const relayToken = computeWxRelayToken(creds.bot_token);
      const procUrl = `${effOrigin}/wx-webhook?process=1`;
      const procFetch = fetch(procUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Wx-Relay-Token': relayToken,
        },
        body: JSON.stringify({ action: 'process', msgs: pendingMsgs }),
        signal: AbortSignal.timeout(55000),
      });

      const earlyRes = await Promise.race([
        procFetch,
        new Promise(r => { const t = setTimeout(() => r('IN_FLIGHT'), 1200); if (t && typeof t.unref === 'function') t.unref(); }),
      ]);

      if (earlyRes === 'IN_FLIGHT') {
        const bgProc = procFetch.then(r => (r ? r.text().catch(() => '') : '')).catch(() => '');
        if (ctx && typeof ctx.waitUntil === 'function') {
          try { ctx.waitUntil(bgProc); } catch (e) {}
        }
        return pendingMsgs.length;
      }
      if (earlyRes && earlyRes.ok) {
        const data = await earlyRes.json().catch(() => ({}));
        return typeof data.processed === 'number' ? data.processed : pendingMsgs.length;
      }
    } catch (e) {
      // 回退到当前实例直接处理
    }
  }

  for (const m of pendingMsgs) {
    try {
      const r = await processWechatMessage(env, creds, m);
      if (r && r.processed) processedCount += 1;
    } catch (err) {
      console.log('处理微信 ClawBot 消息异常:', err);
    }
  }
  return processedCount;
}

async function runWechatPollCycle(env, opts) {
  opts = opts || {};
  const cycleStartAt = Date.now();
  const creds = await getWxCredentials(env);
  if (!creds || !creds.bot_token) {
    return { ok: false, reason: 'not_configured', message: '尚未绑定微信 ClawBot，请先扫码绑定或配置 WX_BOT_TOKEN' };
  }
  if (creds.expired) {
    return { ok: false, reason: 'session_expired', expired: true, message: creds.errmsg || '微信 ClawBot 会话已过期 (ret=-14)，请重新扫码绑定' };
  }

  const longPollTimeoutMs = Math.min(Math.max(parseInt(opts.longPollTimeoutMs || env.WX_LONGPOLL_TIMEOUT_MS || String(WX_DEFAULT_LONGPOLL_MS), 10) || WX_DEFAULT_LONGPOLL_MS, WX_MIN_FULL_POLL_MS), 22000);
  const maxRuntimeMs = Math.min(Math.max(parseInt(opts.maxRuntimeMs || env.WX_POLL_BUDGET_MS || String(longPollTimeoutMs + 3000), 10) || (longPollTimeoutMs + 3000), longPollTimeoutMs + 1500), 26000);
  const maxRounds = Math.min(Math.max(parseInt(opts.maxRounds || '1', 10) || 1, 1), 2);

  if (!(await acquirePollLock(env, longPollTimeoutMs + 4000, !!opts.force))) {
    const diagNow = await getWxDiagSummary(env);
    return {
      ok: true,
      locked: true,
      received: 0,
      processed: 0,
      lastPollAt: diagNow.lastPollAt,
      lastReplyAt: diagNow.lastReplyAt,
      totalProcessed: diagNow.totalProcessed,
      message: '后台长轮询实例正在运行中',
    };
  }

  const chanVer = wxChannelVersion(env);
  maybeSendPeriodicNotifyStart(creds, chanVer, opts.ctx);
  await wxRecordDiag(env, 'poll', '', creds.ilink_user_id, false);

  const deadline = Date.now() + maxRuntimeMs;
  let totalReceived = 0;
  let totalProcessed = 0;
  let cursor = await getWxCursor(env, creds.ilink_bot_id);
  let lockReleased = false;
  let relayTaskPromise = null;
  const effOrigin = isRealPublicOrigin(opts.origin)
    ? opts.origin
    : (isRealPublicOrigin(creds.relay_origin) ? creds.relay_origin : lastKnownPublicOrigin);
  const currentHop = parseInt(opts.relayHop, 10) || 0;

  const startUnlockAndRelay = async (shouldRelay) => {
    if (!lockReleased) {
      lockReleased = true;
      await releasePollLock(env);
    }
    if (shouldRelay && opts.autoRelay && !relayTaskPromise) {
      relayTaskPromise = triggerNextSelfRelay(env, effOrigin, currentHop, opts.ctx).catch(() => {});
      if (opts.ctx && typeof opts.ctx.waitUntil === 'function') {
        try { opts.ctx.waitUntil(relayTaskPromise); } catch (e) {}
      }
    }
  };

  try {
    const pendingMsgs = [];

    for (let round = 0; round < maxRounds; round++) {
      const remainMs = deadline - Date.now();
      if (round > 0 && remainMs < WX_MIN_FULL_POLL_MS) break;

      const pollTimeout = round === 0
        ? longPollTimeoutMs
        : Math.min(longPollTimeoutMs, Math.max(WX_MIN_FULL_POLL_MS, remainMs - 500));

      if (round > 0) {
        await renewPollLock(env, pollTimeout + 4000);
      }

      const resp = await ilinkGetUpdates(creds.baseurl, creds.bot_token, cursor, chanVer, pollTimeout);
      if (resp && (resp.ret === -14 || resp.errcode === -14)) {
        await markWxSessionExpired(env, creds, resp.errmsg);
        await startUnlockAndRelay(false);
        return {
          ok: false,
          reason: 'session_expired',
          expired: true,
          received: totalReceived,
          processed: totalProcessed,
          message: '微信 ClawBot 会话已过期 (ret=-14)，请重新扫码绑定',
        };
      }

      if (resp && typeof resp.get_updates_buf === 'string' && resp.get_updates_buf) {
        cursor = resp.get_updates_buf;
        await saveWxCursor(env, creds.ilink_bot_id, cursor);
      }

      const msgs = (resp && Array.isArray(resp.msgs)) ? resp.msgs : [];
      totalReceived += msgs.length;

      if (msgs.length > 0) {
        for (const rawM of msgs) {
          try {
            const p = extractWechatMessageContent(rawM);
            if (p && p.isUserMsg && p.fromUserId && p.contextToken) {
              await saveWxContextToken(env, p.fromUserId, p.contextToken);
            }
          } catch (e) {}
        }
        pendingMsgs.push(...msgs);
        break;
      }

      if (opts.singleShot) break;
    }

    // 18s 轮询阶段完成：立即释放锁并并发启动下一棒接力握手（此时距 30s 强杀线还有 12s 余量，100% 稳定交棒）
    await startUnlockAndRelay(true);

    if (pendingMsgs.length > 0) {
      const elapsedMs = Date.now() - cycleStartAt;
      totalProcessed += await dispatchOrProcessMessages(env, creds, pendingMsgs, effOrigin, elapsedMs, opts.ctx);
    }

    if (relayTaskPromise) {
      await relayTaskPromise;
    }

    return {
      ok: true,
      received: totalReceived,
      processed: totalProcessed,
      botId: creds.ilink_bot_id,
      userId: creds.ilink_user_id,
      lastPollAt: wxDiagMem.lastPollAt,
      lastReplyAt: wxDiagMem.lastReplyAt,
      totalProcessed: wxDiagMem.totalProcessed,
    };
  } catch (e) {
    await new Promise(r => { const t = setTimeout(r, 800); if (t && typeof t.unref === 'function') t.unref(); });
    await startUnlockAndRelay(true);
    if (relayTaskPromise) {
      await relayTaskPromise;
    }
    await wxRecordDiag(env, 'error', e && e.message ? e.message : String(e), creds.ilink_user_id, true);
    return {
      ok: false,
      error: e && e.message ? e.message : String(e),
      received: totalReceived,
      processed: totalProcessed,
    };
  } finally {
    if (!lockReleased) {
      await releasePollLock(env);
    }
  }
}

// 服务端全自动自接力常驻引擎（18s 周期流式握手 + 容器内自适应循环兜底）
async function triggerNextSelfRelay(env, origin, hop, ctx) {
  try {
    const creds = await getWxCredentials(env);
    if (!creds || !creds.bot_token || creds.expired) return;
    const effOrigin = isRealPublicOrigin(origin) ? origin : (isRealPublicOrigin(creds.relay_origin) ? creds.relay_origin : lastKnownPublicOrigin);
    const nextHop = ((parseInt(hop, 10) || 0) + 1) % 10000;

    let httpRelayDispatched = false;

    if (isRealPublicOrigin(effOrigin)) {
      const relayToken = computeWxRelayToken(creds.bot_token);
      const relayUrl = `${effOrigin}/wx-webhook?relay=1&hop=${nextHop}`;
      try {
        const fetchTask = fetch(relayUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Wx-Relay-Token': relayToken,
          },
          body: JSON.stringify({ action: 'poll', relay: true, hop: nextHop }),
          signal: AbortSignal.timeout(28000),
        });

        const res = await Promise.race([
          fetchTask,
          new Promise(r => { const t = setTimeout(() => r(null), 1200); if (t && typeof t.unref === 'function') t.unref(); }),
        ]);

        if (res && res.ok) {
          httpRelayDispatched = true;
          const drainStream = res.text().catch(() => '');
          if (ctx && typeof ctx.waitUntil === 'function') {
            try { ctx.waitUntil(drainStream); } catch (e) {}
          }
        } else if (res === null) {
          httpRelayDispatched = true;
          const bgFetch = fetchTask.then(r => (r ? r.text().catch(() => '') : '')).catch(() => '');
          if (ctx && typeof ctx.waitUntil === 'function') {
            try { ctx.waitUntil(bgFetch); } catch (e) {}
          }
        }
      } catch (e) {
        httpRelayDispatched = false;
      }
    }

    if (!httpRelayDispatched) {
      const fallbackTask = new Promise(resolve => {
        const t = setTimeout(resolve, 250);
        if (t && typeof t.unref === 'function') t.unref();
      }).then(async () => {
        if (await isPollLockHeld(env)) return;
        await runWechatPollCycle(env, {
          maxRuntimeMs: 22000,
          longPollTimeoutMs: WX_DEFAULT_LONGPOLL_MS,
          maxRounds: 1,
          singleShot: true,
          autoRelay: true,
          origin: effOrigin,
          relayHop: nextHop,
          ctx,
        });
      }).catch(() => {});

      if (ctx && typeof ctx.waitUntil === 'function') {
        try { ctx.waitUntil(fallbackTask); } catch (e) {}
      }
    }
  } catch (e) {}
}

function kickWxAutoDaemon(env, ctx, origin) {
  const effOrigin = rememberPublicOrigin(origin);
  const task = (async () => {
    if (await isPollLockHeld(env)) return;
    await runWechatPollCycle(env, {
      maxRuntimeMs: 22000,
      longPollTimeoutMs: WX_DEFAULT_LONGPOLL_MS,
      maxRounds: 1,
      singleShot: true,
      autoRelay: true,
      origin: effOrigin,
      relayHop: 1,
      ctx,
    });
  })().catch(() => {});
  if (ctx && typeof ctx.waitUntil === 'function') {
    try { ctx.waitUntil(task); } catch (e) {}
  }
  return task;
}

function maybeWakeWxDaemon(request, env, ctx) {
  try {
    const now = Date.now();
    if (activePollInIsolate) return;
    if (wxDiagMem.lastPollAt && now - wxDiagMem.lastPollAt < 18000) return;
    if (now - lastDaemonWakeCheckAt < 8000) return;
    lastDaemonWakeCheckAt = now;
    const origin = request && request.url ? rememberPublicOrigin(request.url) : lastKnownPublicOrigin;
    if (!isRealPublicOrigin(origin)) return;
    const task = (async () => {
      if (await isPollLockHeld(env)) return;
      const creds = await getWxCredentials(env);
      if (!creds || !creds.bot_token || creds.expired) return;
      await kickWxAutoDaemon(env, ctx, origin);
    })().catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') {
      try { ctx.waitUntil(task); } catch (e) {}
    }
  } catch (e) {}
}

// Cloudflare Cron Triggers 入口（每分钟触发：若自接力链健康运行则直接放行，若断链则立即拉起并开启新一轮 18s 自接力链）
async function handleWxScheduled(event, env, ctx) {
  const creds = await getWxCredentials(env);
  if (!creds || !creds.bot_token || creds.expired) return;
  const effOrigin = (creds && creds.relay_origin) || lastKnownPublicOrigin || '';
  const task = (async () => {
    if (await isPollLockHeld(env)) return;
    await runWechatPollCycle(env, {
      maxRuntimeMs: 22000,
      longPollTimeoutMs: WX_DEFAULT_LONGPOLL_MS,
      maxRounds: 1,
      singleShot: true,
      autoRelay: true,
      origin: effOrigin,
      relayHop: 0,
      ctx,
    });
  })().catch(() => {});
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(task);
  } else {
    await task;
  }
}

// ================= 8. Webhook 接收器与全天候免开网页保活端点（GET/POST /wx-webhook） =================
async function handleWxWebhook(request, env, url, ctx) {
  const reqUrl = url || new URL(request.url);
  const origin = rememberPublicOrigin(reqUrl.origin);
  const credsForRelay = await getWxCredentials(env);
  const relayHeader = (request && request.headers && request.headers.get('X-Wx-Relay-Token')) || '';
  const isValidRelay = !!(credsForRelay && credsForRelay.bot_token && relayHeader && safeEqual(relayHeader, computeWxRelayToken(credsForRelay.bot_token)));
  const auth = isValidRelay ? { authorized: true, noSecretConfigured: false } : checkWxAdminAuth(env, request, reqUrl);

  if (env.WX_WEBHOOK_SECRET) {
    const got = request.headers.get('X-Wechat-Webhook-Secret')
      || request.headers.get('X-Webhook-Secret')
      || (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim()
      || reqUrl.searchParams.get('key')
      || '';
    if (!safeEqual(got, env.WX_WEBHOOK_SECRET) && !auth.authorized) {
      return new Response('Forbidden', { status: 403 });
    }
  } else if (!auth.authorized) {
    return new Response(JSON.stringify({ ok: false, error: auth.reason }), { status: 401, headers: CORS_HEADERS });
  }

  if (request.method === 'GET') {
    const timeoutMs = parseInt(reqUrl.searchParams.get('timeout_ms') || '20000', 10) || 20000;
    const res = await runWechatPollCycle(env, {
      maxRuntimeMs: Math.min(Math.max(timeoutMs, 15000), 25000),
      longPollTimeoutMs: WX_DEFAULT_LONGPOLL_MS,
      maxRounds: 1,
      singleShot: true,
      autoRelay: true,
      origin,
      relayHop: 1,
      ctx,
    });
    return new Response(JSON.stringify(res), { status: 200, headers: CORS_HEADERS });
  }

  try {
    const rawText = (await request.text()).trim();
    const payload = rawText ? JSON.parse(rawText) : {};

    if (!payload || payload.action === 'poll' || (!payload.msgs && !payload.from_user_id && !payload.user_id && !payload.msg)) {
      const isRelay = !!(payload && payload.relay) || reqUrl.searchParams.get('relay') === '1';
      const hop = parseInt((payload && payload.hop) || reqUrl.searchParams.get('hop') || '1', 10) || 1;
      if (isRelay) {
        if (typeof TransformStream === 'function') {
          const { readable, writable } = new TransformStream();
          const writer = writable.getWriter();
          const enc = new TextEncoder();
          const streamTask = (async () => {
            let hbTimer = null;
            try {
              await writer.write(enc.encode(`{"ok":true,"relayed":true,"hop":${hop},"result":`));
              hbTimer = setInterval(() => {
                writer.write(enc.encode(' ')).catch(() => {});
              }, 6000);
              if (hbTimer && typeof hbTimer.unref === 'function') hbTimer.unref();

              const r = await runWechatPollCycle(env, {
                maxRuntimeMs: 22000,
                longPollTimeoutMs: WX_DEFAULT_LONGPOLL_MS,
                maxRounds: 1,
                singleShot: true,
                autoRelay: true,
                origin,
                relayHop: hop,
                ctx,
              });
              if (hbTimer) clearInterval(hbTimer);
              await writer.write(enc.encode(`${JSON.stringify(r || { ok: true })}}`));
            } catch (err) {
              if (hbTimer) clearInterval(hbTimer);
              try {
                await writer.write(enc.encode(`${JSON.stringify({ ok: false, error: String(err && err.message || err) })}}`));
              } catch (e) {}
            } finally {
              try { await writer.close(); } catch (e) {}
            }
          })();

          if (ctx && typeof ctx.waitUntil === 'function') {
            try { ctx.waitUntil(streamTask); } catch (e) {}
          }
          const streamHeaders = Object.assign({}, CORS_HEADERS, {
            'Cache-Control': 'no-store, no-transform',
            'X-Accel-Buffering': 'no',
          });
          return new Response(readable, { status: 200, headers: streamHeaders });
        }

        const relayCycleTask = runWechatPollCycle(env, {
          maxRuntimeMs: 22000,
          longPollTimeoutMs: WX_DEFAULT_LONGPOLL_MS,
          maxRounds: 1,
          singleShot: true,
          autoRelay: true,
          origin,
          relayHop: hop,
          ctx,
        });
        if (ctx && typeof ctx.waitUntil === 'function') {
          try { ctx.waitUntil(relayCycleTask); } catch (e) {}
        }
        const r = await relayCycleTask;
        return new Response(JSON.stringify({ ok: true, relayed: true, hop, result: r }), { status: 200, headers: CORS_HEADERS });
      }
      const timeoutMs = parseInt(payload.timeout_ms || reqUrl.searchParams.get('timeout_ms') || '20000', 10) || 20000;
      const res = await runWechatPollCycle(env, {
        maxRuntimeMs: Math.min(Math.max(timeoutMs, 15000), 25000),
        longPollTimeoutMs: WX_DEFAULT_LONGPOLL_MS,
        maxRounds: 1,
        singleShot: true,
        autoRelay: true,
        origin,
        relayHop: 1,
        ctx,
      });
      return new Response(JSON.stringify(res), { status: 200, headers: CORS_HEADERS });
    }

    const creds = await getWxCredentials(env);
    if (!creds || !creds.bot_token) {
      return new Response(JSON.stringify({ ok: false, error: 'WX_BOT_TOKEN or QR login not configured' }), {
        status: 200,
        headers: CORS_HEADERS,
      });
    }

    if (payload && typeof payload.get_updates_buf === 'string' && payload.get_updates_buf) {
      await saveWxCursor(env, creds.ilink_bot_id, payload.get_updates_buf);
    }

    const msgs = Array.isArray(payload && payload.msgs)
      ? payload.msgs
      : (payload && (payload.from_user_id || payload.user_id || payload.msg) ? [payload.msg || payload] : []);

    let processed = 0;
    for (const m of msgs) {
      try {
        const r = await processWechatMessage(env, creds, m);
        if (r && r.processed) processed += 1;
      } catch (e) {
        console.log('Webhook 处理微信消息异常:', e);
      }
    }

    return new Response(JSON.stringify({ ok: true, received: msgs.length, processed }), {
      status: 200,
      headers: CORS_HEADERS,
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }), {
      status: 400,
      headers: CORS_HEADERS,
    });
  }
}

// ================= 9. Web 管理端接口（/api/wx/*） =================
function maskToken(token) {
  const s = String(token || '');
  if (s.length <= 12) return s ? '***' : '';
  return s.slice(0, 6) + '…' + s.slice(-6);
}

async function handleWxApi(request, env, url, ctx) {
  const path = url.pathname;
  const origin = rememberPublicOrigin(url.origin);
  const chanVer = wxChannelVersion(env);
  const defaultBase = normalizeBaseUrl((env && env.WX_BASE_URL) || DEFAULT_ILINK_BASE_URL);
  const auth = checkWxAdminAuth(env, request, url);

  if (request.method === 'GET' && path === '/api/wx/status') {
    const creds = await getWxCredentials(env, true);
    const connected = !!(creds && creds.bot_token && !creds.expired);
    if (!auth.authorized) {
      return new Response(JSON.stringify({
        ok: true,
        adminAuthorized: false,
        noSecretConfigured: auth.noSecretConfigured,
        authReason: auth.reason,
        connected,
        expired: !!(creds && creds.expired),
        r2Bound: !!(env && env.R2),
        channelVersion: chanVer,
      }), { status: 200, headers: CORS_HEADERS });
    }
    const lastPeer = await getWxLastPeer(env);
    const cursor = creds ? await getWxCursor(env, creds.ilink_bot_id) : '';
    const effectiveUserId = (creds && creds.ilink_user_id) || (lastPeer && lastPeer.user_id) || '';
    const hasContextToken = effectiveUserId
      ? !!(await getWxContextToken(env, effectiveUserId)) || !!(lastPeer && lastPeer.context_token)
      : false;
    const diag = await getWxDiagSummary(env);
    return new Response(JSON.stringify({
      ok: true,
      adminAuthorized: true,
      noSecretConfigured: false,
      connected,
      expired: !!(creds && creds.expired),
      errmsg: (creds && creds.errmsg) || '',
      source: (creds && creds.source) || null,
      botId: (creds && creds.ilink_bot_id) || '',
      userId: effectiveUserId,
      hasContextToken,
      baseUrl: (creds && creds.baseurl) || defaultBase,
      maskedToken: creds ? maskToken(creds.bot_token) : '',
      hasCursor: !!cursor,
      updatedAt: (creds && creds.updated_at) || '',
      r2Bound: !!(env && env.R2),
      channelVersion: chanVer,
      diag,
    }), { status: 200, headers: CORS_HEADERS });
  }

  if (!auth.authorized) {
    return new Response(JSON.stringify({
      ok: false,
      code: auth.noSecretConfigured ? 'NO_SECRET_CONFIGURED' : 'WX_ADMIN_UNAUTHORIZED',
      error: auth.reason,
    }), { status: auth.noSecretConfigured ? 403 : 401, headers: CORS_HEADERS });
  }

  if (request.method === 'GET' && path === '/api/wx/history') {
    const creds = await getWxCredentials(env);
    const lastPeer = await getWxLastPeer(env);
    const userId = String(url.searchParams.get('user_id') || (creds && creds.ilink_user_id) || (lastPeer && lastPeer.user_id) || '').trim();
    if (!userId) {
      return new Response(JSON.stringify({
        ok: true,
        userId: '',
        messages: [],
        kbDocs: await loadAllKbDocsForSync(env),
        message: '尚未收到过微信端消息，请先在手机微信 ClawBot 中发送一条消息',
      }), { status: 200, headers: CORS_HEADERS });
    }
    const chatId = wxSessionChatId(userId);
    const [messages, modelId, agentMode, kbDocs] = await Promise.all([
      tgGetHistory(env, chatId),
      storeGet(env, `tg_user_${chatId}`),
      agentGetMode(env, chatId),
      loadAllKbDocsForSync(env),
    ]);
    return new Response(JSON.stringify({
      ok: true,
      userId,
      chatId,
      modelId: modelId || '',
      agentMode,
      messages: Array.isArray(messages) ? messages : [],
      kbDocs,
    }), { status: 200, headers: CORS_HEADERS });
  }

  if (request.method === 'POST' && path === '/api/wx/qrcode') {
    const existing = await getWxCredentials(env, true);
    if (existing && existing.source === 'env') {
      return new Response(JSON.stringify({
        ok: false,
        error: '当前已通过环境变量 WX_BOT_TOKEN 固定绑定，Web 端扫码已锁定，无法覆盖。',
      }), { status: 409, headers: CORS_HEADERS });
    }
    let body = {};
    try { body = await request.json(); } catch (e) { body = {}; }
    if (existing && existing.bot_token && !existing.expired && !body.force) {
      return new Response(JSON.stringify({
        ok: false,
        code: 'ALREADY_BOUND',
        error: '当前已绑定微信账号（' + (existing.ilink_user_id || existing.ilink_bot_id) + '）。为防误覆盖，请先点击「解绑」后再重新扫码。',
      }), { status: 409, headers: CORS_HEADERS });
    }
    try {
      const qrData = await ilinkGetQrCode(defaultBase, chanVer, 12000);
      if (!qrData || !qrData.qrcode) {
        return new Response(JSON.stringify({
          ok: false,
          error: '微信 iLink 未返回有效二维码：' + JSON.stringify(qrData || {}),
        }), { status: 502, headers: CORS_HEADERS });
      }
      wxQrRedirectNodes.set(qrData.qrcode, defaultBase);
      return new Response(JSON.stringify({
        ok: true,
        qrcode: qrData.qrcode,
        qrcode_img_content: qrData.qrcode_img_content || '',
        base_url: defaultBase,
        ret: qrData.ret ?? 0,
      }), { status: 200, headers: CORS_HEADERS });
    } catch (e) {
      return new Response(JSON.stringify({
        ok: false,
        error: e && e.message ? e.message : String(e),
      }), { status: 500, headers: CORS_HEADERS });
    }
  }

  if (request.method === 'GET' && path === '/api/wx/qrcode-status') {
    const qrcode = (url.searchParams.get('qrcode') || '').trim();
    const verifyCode = (url.searchParams.get('verify_code') || '').trim();
    const clientBase = (url.searchParams.get('base_url') || '').trim();
    if (!qrcode) {
      return new Response(JSON.stringify({ ok: false, error: '缺少 qrcode 参数' }), { status: 400, headers: CORS_HEADERS });
    }
    let targetBase = normalizeBaseUrl(clientBase || wxQrRedirectNodes.get(qrcode) || defaultBase);
    try {
      let st = await ilinkGetQrStatus(targetBase, qrcode, chanVer, 8000, verifyCode);
      let status = st.status || 'wait';

      if ((status === 'scaned_but_redirect' || status === 'binded_redirect' || st.redirect_baseurl) && st.redirect_baseurl) {
        targetBase = st.redirect_baseurl;
        wxQrRedirectNodes.set(qrcode, targetBase);
        const followUp = await ilinkGetQrStatus(targetBase, qrcode, chanVer, 5000, verifyCode);
        if (followUp && followUp.status) {
          st = followUp;
          status = followUp.status;
          if (followUp.redirect_baseurl) {
            targetBase = followUp.redirect_baseurl;
            wxQrRedirectNodes.set(qrcode, targetBase);
          }
        }
      }

      if (status === 'confirmed' && st.bot_token) {
        const allowedUsers = parseCommaSeparated(env.WX_ALLOWED_USERS);
        if (allowedUsers.length > 0 && st.ilink_user_id && allowedUsers.indexOf(st.ilink_user_id) === -1) {
          return new Response(JSON.stringify({
            ok: false,
            status: 'rejected',
            error: `扫码微信号 (${st.ilink_user_id}) 不在 WX_ALLOWED_USERS 白名单中，已拒绝绑定。`,
          }), { status: 403, headers: CORS_HEADERS });
        }

        const finalBaseUrl = normalizeBaseUrl(st.redirect_baseurl || st.baseurl || targetBase || defaultBase);
        const newCreds = {
          bot_token: st.bot_token,
          ilink_bot_id: st.ilink_bot_id || (st.bot_token.includes(':') ? st.bot_token.split(':')[0] : 'wx_bot'),
          ilink_user_id: st.ilink_user_id || '',
          baseurl: finalBaseUrl,
          cdn_url: String((env && env.WX_CDN_BASE_URL) || DEFAULT_ILINK_CDN_URL).trim(),
          expired: false,
          errmsg: '',
          updated_at: new Date().toISOString(),
        };
        const savedOk = await saveWxCredentials(env, newCreds);
        await saveWxCursor(env, newCreds.ilink_bot_id, '');
        newCreds.relay_origin = origin;
        await saveWxCredentials(env, newCreds);
        await ilinkNotifyStart(newCreds.baseurl, newCreds.bot_token, chanVer, 6000);
        await wxRecordDiag(env, 'login', `扫码绑定成功 (${newCreds.ilink_user_id || newCreds.ilink_bot_id})，后台自接力守护已启动`, newCreds.ilink_user_id, true);
        wxQrRedirectNodes.delete(qrcode);
        kickWxAutoDaemon(env, ctx, origin);
        return new Response(JSON.stringify({
          ok: true,
          status: 'confirmed',
          persisted: savedOk,
          r2Bound: !!(env && env.R2),
          botId: newCreds.ilink_bot_id,
          userId: newCreds.ilink_user_id,
          baseUrl: newCreds.baseurl,
          maskedToken: maskToken(newCreds.bot_token),
        }), { status: 200, headers: CORS_HEADERS });
      }
      return new Response(JSON.stringify({
        ok: true,
        status,
        base_url: targetBase,
        need_verifycode: status === 'need_verifycode' || !!st.need_verifycode,
        ret: st.ret ?? 0,
      }), { status: 200, headers: CORS_HEADERS });
    } catch (e) {
      return new Response(JSON.stringify({
        ok: false,
        error: e && e.message ? e.message : String(e),
      }), { status: 500, headers: CORS_HEADERS });
    }
  }

  if ((request.method === 'POST' || request.method === 'GET') && path === '/api/wx/poll') {
    let body = {};
    if (request.method === 'POST') {
      try { body = await request.json(); } catch (e) { body = {}; }
    }
    const reqTimeoutMs = parseInt(body.timeout_ms || url.searchParams.get('timeout_ms') || '18000', 10) || 18000;
    const singleShot = body.single_shot !== undefined
      ? !!body.single_shot
      : (url.searchParams.get('single_shot') !== '0');
    const force = !!(body.force || url.searchParams.get('force') === '1');
    const effectivePollMs = Math.min(Math.max(reqTimeoutMs, WX_MIN_FULL_POLL_MS), 22000);
    const result = await runWechatPollCycle(env, {
      maxRuntimeMs: Math.min(Math.max(effectivePollMs + 3000, 15000), 25000),
      longPollTimeoutMs: effectivePollMs,
      maxRounds: 1,
      singleShot: true,
      force,
      autoRelay: true,
      origin,
      relayHop: 1,
      ctx,
    });
    return new Response(JSON.stringify(result), { status: 200, headers: CORS_HEADERS });
  }

  if (request.method === 'POST' && path === '/api/wx/send') {
    let body = {};
    try { body = await request.json(); } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: '无效的 JSON 请求体' }), { status: 400, headers: CORS_HEADERS });
    }
    const text = String(body.text || '').trim();
    if (!text) {
      return new Response(JSON.stringify({ ok: false, error: '消息内容 text 不能为空' }), { status: 400, headers: CORS_HEADERS });
    }
    const creds = await getWxCredentials(env);
    if (!creds || !creds.bot_token) {
      return new Response(JSON.stringify({ ok: false, error: '微信 ClawBot 尚未绑定' }), { status: 400, headers: CORS_HEADERS });
    }
    const lastPeer = await getWxLastPeer(env);
    const toUserId = String(body.to_user_id || creds.ilink_user_id || (lastPeer && lastPeer.user_id) || '').trim();
    if (!toUserId) {
      return new Response(JSON.stringify({
        ok: false,
        error: '尚未获取到你的微信对话句柄：请先打开手机微信 -> 我 -> 设置 -> 插件 -> ClawBot，向机器人随便发一句话（如「你好」）以激活对话令牌！',
      }), { status: 400, headers: CORS_HEADERS });
    }
    const contextToken = String(
      body.context_token
      || (await getWxContextToken(env, toUserId))
      || (lastPeer && lastPeer.context_token)
      || ''
    ).trim();
    if (!contextToken) {
      return new Response(JSON.stringify({
        ok: false,
        error: '缺少微信会话 context_token（腾讯 iLink 协议规定必须先由手机微信端发起首条消息以签发路由令牌）。请先在手机微信向 ClawBot 发送任意消息！',
      }), { status: 400, headers: CORS_HEADERS });
    }
    try {
      const cleanText = formatWechatText(text);
      const r = await ilinkSendMessage(creds.baseurl, creds.bot_token, toUserId, cleanText, contextToken, chanVer, 15000);
      if (r && (r.ret === -14 || r.errcode === -14)) {
        await markWxSessionExpired(env, creds, r.errmsg);
        return new Response(JSON.stringify({ ok: false, expired: true, error: '会话已过期 (ret=-14)，请重新扫码绑定' }), {
          status: 401,
          headers: CORS_HEADERS,
        });
      }
      await wxRecordDiag(env, 'reply', `[网页端主动发送] ${cleanText.slice(0, 80)}`, toUserId, true);
      return new Response(JSON.stringify({ ok: true, to_user_id: toUserId, result: r }), { status: 200, headers: CORS_HEADERS });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }), {
        status: 500,
        headers: CORS_HEADERS,
      });
    }
  }

  if (request.method === 'POST' && path === '/api/wx/logout') {
    const creds = await getWxCredentials(env);
    if (creds && creds.source === 'env') {
      return new Response(JSON.stringify({
        ok: false,
        error: '当前通过环境变量 WX_BOT_TOKEN 绑定，请在控制台移除该变量以解绑。',
      }), { status: 409, headers: CORS_HEADERS });
    }
    if (creds && creds.bot_token) {
      await ilinkNotifyStop(creds.baseurl, creds.bot_token, chanVer, 5000);
    }
    await clearWxCredentials(env);
    await wxRecordDiag(env, 'login', '管理员主动解绑微信 ClawBot', '', true);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS_HEADERS });
  }

  return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404, headers: CORS_HEADERS });
}

export {
  wxSessionChatId,
  checkWxAdminAuth,
  getWxCredentials,
  saveWxCredentials,
  clearWxCredentials,
  getWxContextToken,
  saveWxContextToken,
  getWxCursor,
  saveWxCursor,
  splitWechatText,
  parseWxCommand,
  processWechatMessage,
  runWechatPollCycle,
  handleWxScheduled,
  kickWxAutoDaemon,
  maybeWakeWxDaemon,
  autoOrganizeAndSaveKbDoc,
  loadAllKbDocsForSync,
  handleWxWebhook,
  handleWxApi,
};
