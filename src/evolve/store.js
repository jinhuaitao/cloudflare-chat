// 自我进化 · R2 持久化（v7.22.0）
//
// 存储布局（全部在 R2 kb/evolve/ 下，与记忆/知识库同桶、互不干扰）：
//   kb/evolve/proposals.json        提案列表（唯一真相；overlay 由它折叠推导）
//   kb/evolve/metrics/<YYYY-MM-DD>.json   当日聚合指标
//   kb/evolve/state.json            上次进化周期时间（防 Cron 每分钟重复跑）
//
// 写路径全部走 store.js 的 CAS（storePutCas）：
//   读失败绝不拿空对象覆盖；冲突重读重算最多 3 轮；
//   未绑定 R2 时返回失败而不是静默成功（调用方只记日志、不影响对话）。
// 读路径带 180 秒 isolate 缓存（与 agent/mode.js 同口径）：
//   提案刚被审批后，最坏 3 分钟内生效；换来每轮不额外打 R2。

import { storeGet, storeGetMeta, storePutCas } from '../store/r2.js';
import { newEvolveDay, evolveDayKey, addEvolveDayCounts } from './metrics.js';
import { buildEvolveOverlay, normalizeEvolveAudit } from './proposals.js';

const EVO_PROPOSALS_KEY = 'kb/evolve/proposals.json';
const EVO_STATE_KEY = 'kb/evolve/state.json';
const EVO_METRICS_PREFIX = 'kb/evolve/metrics/';
const EVO_CACHE_TTL_MS = 180 * 1000;

const evolveConfigCache = new Map();
const evolveConfigExp = new Map();

function evolveMetricsKey(date) {
  return EVO_METRICS_PREFIX + (date || evolveDayKey(new Date())) + '.json';
}

function parseJson(text, fallback) {
  if (!text) return fallback;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : fallback;
  } catch (e) {
    return fallback;
  }
}

// 读-改-CAS 写：最多 3 轮，冲突时重读重算；返回 { ok, value }。
async function casMutate(env, key, mutate, initial) {
  if (!env || !env.R2) return { ok: false, value: null };
  let etag = '';
  let current = initial;
  for (let attempt = 0; attempt < 3; attempt++) {
    const meta = await storeGetMeta(env, key);
    if (meta && meta.failed) return { ok: false, value: null };
    etag = (meta && meta.etag) || '';
    current = meta && meta.text ? parseJson(meta.text, initial) : initial;
    const next = mutate(current);
    if (next === null || next === undefined) return { ok: false, value: current };
    const res = await storePutCas(env, key, JSON.stringify(next), etag || null);
    if (res.ok) return { ok: true, value: next };
    if (!res.conflict) return { ok: false, value: current };
  }
  return { ok: false, value: current };
}

async function loadEvolveProposals(env) {
  if (!env || !env.R2) return { v: 1, items: [], audit: [] };
  const text = await storeGet(env, EVO_PROPOSALS_KEY);
  const doc = parseJson(text, null);
  // v7.34.0：老数据没有 audit 字段时读作空数组，不报错。
  if (doc && Array.isArray(doc.items)) return { ...doc, audit: normalizeEvolveAudit(doc.audit) };
  return { v: 1, items: [], audit: [] };
}

async function saveEvolveProposals(env, doc) {
  const clean = {
    v: 1,
    updatedAt: Date.now(),
    items: Array.isArray(doc && doc.items) ? doc.items.slice(-100) : [],
    audit: normalizeEvolveAudit(doc && doc.audit),
  };
  // v7.34.0：调用方没传 audit 时沿用 R2 里已有的审计，不丢记录——
  // 保存点多（周期/审批/否决/回滚/复核/草稿确认），任何一处漏传
  // 都不能把整本审计账抹掉；审计只能追加、永不由保存清空。
  const res = await casMutate(env, EVO_PROPOSALS_KEY, (current) => ({
    ...clean,
    audit: (doc && doc.audit !== undefined)
      ? clean.audit
      : normalizeEvolveAudit(current && current.audit),
  }), { v: 1, items: [] });
  if (res.ok) evolveConfigCache.clear();
  return res.ok;
}

async function loadEvolveDay(env, date) {
  if (!env || !env.R2) return null;
  const text = await storeGet(env, evolveMetricsKey(date));
  const day = parseJson(text, null);
  return day && typeof day.total === 'number' ? day : null;
}

async function saveEvolveDay(env, day) {
  if (!day || !day.date) return false;
  const res = await casMutate(env, evolveMetricsKey(day.date), () => day, newEvolveDay(day.date));
  return res.ok;
}

// 把 buffer 里攒的日聚合合并进 R2（每轮只在阈值到时调用，见 index.js）。
//
// 防重复计数：落盘是异步的，两个 flush 并发时会把同一批计数合并两次
// （冒烟实测：10 轮记成 20 轮）。所以先「快照 + 立即清空 buffer」再写 R2，
// 写失败的日期才放回 buffer 下次重试；进行中的 flush 直接跳过。
async function flushEvolveBuffer(env, buffer) {
  if (!env || !env.R2 || !buffer || !buffer.days || buffer.days.size === 0) {
    return { flushed: 0, failed: 0 };
  }
  if (buffer._flushing) return { flushed: 0, failed: 0, busy: true };
  buffer._flushing = true;
  const snapshot = [...buffer.days.entries()].map(([date, day]) => [date, JSON.parse(JSON.stringify(day))]);
  buffer.days.clear();
  buffer.events = 0;
  let flushed = 0;
  let failed = 0;
  try {
    for (const [date, localDay] of snapshot) {
    const res = await casMutate(env, evolveMetricsKey(date), (remote) => {
      const base = remote && typeof remote.total === 'number' ? remote : newEvolveDay(date);
      return addEvolveDayCounts(base, localDay);
    }, newEvolveDay(date));
    if (res.ok) {
      flushed += 1;
    } else {
      failed += 1;
      // 写失败不丢数：把快照合并回 buffer（期间可能已有新计数），下次再试。
      const existing = buffer.days.get(date);
      buffer.days.set(date, existing ? addEvolveDayCounts(existing, localDay) : localDay);
      buffer.events += localDay.total || 0;
    }
    }
  } finally {
    buffer._flushing = false;
  }
  if (flushed > 0) buffer.lastFlushAt = Date.now();
  return { flushed, failed };
}

async function loadEvolveState(env) {
  if (!env || !env.R2) return { v: 1, lastCycleAt: 0, lastCycleDay: '' };
  const text = await storeGet(env, EVO_STATE_KEY);
  const doc = parseJson(text, null);
  return doc && typeof doc === 'object' ? doc : { v: 1, lastCycleAt: 0, lastCycleDay: '' };
}

async function saveEvolveState(env, state) {
  // v7.29.0 周期周报：state 文件同时记 lastCycleDay（每天去重）与
  // lastWeeklyWeek / lastWeeklyAt（每周去重）。写 state 必须是「合并」
  // 而不是「替换」——周期每次写 lastCycleDay 时不能把上周的周报去重
  // 标记抹掉，否则同一周的周一会重复发周报。
  const res = await casMutate(env, EVO_STATE_KEY, (current) => ({ ...current, v: 1, ...state }), { v: 1, lastCycleAt: 0, lastCycleDay: '' });
  return res.ok;
}

// 每轮调用的唯一读口：提案 + 由其折叠的 overlay，180 秒缓存。
async function loadEvolveConfig(env) {
  const now = Date.now();
  const cached = evolveConfigCache.get('config');
  const exp = evolveConfigExp.get('config') || 0;
  if (cached && now < exp) return cached;
  let proposals = [];
  let audit = [];
  try {
    const doc = await loadEvolveProposals(env);
    proposals = Array.isArray(doc.items) ? doc.items : [];
    audit = normalizeEvolveAudit(doc.audit);
  } catch (e) {
    proposals = [];
    audit = [];
  }
  const applied = proposals.filter(p => p && p.status === 'applied');
  const config = { proposals, overlay: buildEvolveOverlay(applied), audit };
  evolveConfigCache.set('config', config);
  evolveConfigExp.set('config', now + EVO_CACHE_TTL_MS);
  return config;
}

function invalidateEvolveConfig() {
  evolveConfigCache.clear();
  evolveConfigExp.clear();
}

// 仅供单测：清掉模块级缓存，避免跨用例串味。
function __resetEvolveConfigCache() {
  evolveConfigCache.clear();
  evolveConfigExp.clear();
}

export {
  EVO_PROPOSALS_KEY,
  EVO_STATE_KEY,
  EVO_METRICS_PREFIX,
  evolveMetricsKey,
  loadEvolveProposals,
  saveEvolveProposals,
  loadEvolveDay,
  saveEvolveDay,
  flushEvolveBuffer,
  loadEvolveState,
  saveEvolveState,
  loadEvolveConfig,
  invalidateEvolveConfig,
  __resetEvolveConfigCache,
};
