// 自我进化 · 编排层（v7.23.0）
//
// 一轮的完整闭环：
//   观测 recordEvolveRound()（每轮，内存聚合，零 R2）
//     → 攒够 10 轮挂 waitUntil 落盘（flushEvolveBuffer，CAS）
//     → 每天一次 runEvolveCycle()（UTC 每天 0 点左右：每分钟 Cron 里
//       当天第一次触发时跑，runEvolveScheduled 按 UTC 日期去重；
//       也可 /evolve run 手动跑）：
//       读近 7 天聚合 → 规则诊断 → 校验 → 去重 → 写提案
//     → 每周一的定时周期顺带发一条 7 天周报（v7.29.0，有内容才发，
//       同一周只发一次，与当日变动合并成同一条消息）。
//     → 管理员 /evolve approve（或 EVO_AUTO_APPLY=1 时仅 low 风险自动应用）
//     → /evolve approve-low 一次应用全部低风险待审批提案（v7.34.0，
//       逐条过校验与模拟、LLM 复核否决的跳过；review 类与草稿不在范围内）
//     → overlay 下一轮生效 → 再观测（否决 14 天内不再重复提；
//       回滚的同一改动 30 天内不再重复提，按改动内容本身去重）
//     → v7.41.0 按提案灰度：/evolve approve <id> 50 可指定灰度比例，
//       该提案只在部分会话生效（同一会话永远同一组，不同提案分组独立），
//       指标按提案分组计数（生效组 vs 未生效组），状态里直接对比暂停率；
//       不指定默认全量，自动应用与批量审批默认全量，不自动灰度。
//     → /evolve rollback [原因] 随时回滚（原因限 100 字，只记管理员手写短句）。
//     → KB 缺失主题自动草稿（v7.31.0）：缺失 ≥3 次的主题周期里自动生成
//       一条 draft 草稿（只存主题词与失败次数，30 天过期）；管理员
//       /evolve kb-draft <id> 确认后才调已有整理入库，草稿变 archived。
//     → 弱词升级（v7.32.0，R1c）：已应用弱词在本窗口近 miss 又 ≥5 次
//       时提一条弱词升强词的提案（upgradeFrom: 'weak'，复用强词模拟）；
//       原弱词提案保持 applied 不变，overlay 折叠时强词覆盖弱词。
//
// 默认是「只提议，不自动改」：EVO_ENABLED=0 可整关；
// EVO_AUTO_APPLY=1 只自动应用 risk=low 的 persona_budget 提案；
// EVO_AUTO_APPLY=2 再自动应用「沙盒模拟通过 + LLM 复核建议通过」
// 双门禁的强关键词提案（v7.25.0 自主等级 L2，需同时开 EVO_LLM_REVIEW=1；
// 弱关键词提案风险为 low，不自动应用）；
// 诊断建议出的提案、附言、工具限流一律要人工批。

import { PERSONAS } from '../agent/personas.js';
import { agentLimits } from '../agent/limits.js';
import {
  createEvolveBuffer,
  recordEvolveEvent,
  summarizeEvolveDays,
  evolveDayKey,
} from './metrics.js';
import { analyzeEvolveDays, compareEvolveGroups, kbMissingTopics } from './rules.js';
import { simulateEvolveProposal } from './simulate.js';
import { reviewEvolveProposalWithLLM, suggestEvolveChangeWithLLM } from './review.js';
import { autoOrganizeAndSaveKbDoc } from '../kb/organize.js';
import { evolveRolloutPercent } from './overlay.js';
import {
  validateEvolveChange,
  newEvolveProposal,
  proposalIdFor,
  findEvolveConflicts,
  annotateEvolveConflicts,
  normalizeRollbackReason,
  normalizeEvolveAudit,
  newEvolveAuditEntry,
  appendEvolveAudit,
  evolveChangeKey,
  normalizeRolloutPercent,
  appliedWeakKeywords,
  EVO_KB_DRAFT_TTL_MS,
  isKbDraftExpired,
  isKbDraftLive,
  upsertKbDraft,
  formatEvolveScoreDetail,
} from './proposals.js';
import {
  loadEvolveProposals,
  saveEvolveProposals,
  loadEvolveDay,
  loadEvolveState,
  saveEvolveState,
  flushEvolveBuffer,
  loadEvolveConfig,
  invalidateEvolveConfig,
} from './store.js';

const evolveBuffer = createEvolveBuffer();
const EVO_DEDUPE_DAYS_MS = 14 * 24 * 3600 * 1000;
// v7.28.0 回滚学习：同一改动被回滚后 30 天内不再重复提（按改动内容
// 本身去重，不按规则）；否决的提案仍是 14 天窗口，不变。
const EVO_ROLLBACK_DEDUPE_DAYS_MS = 30 * 24 * 3600 * 1000;
const EVO_EXPIRE_DAYS_MS = 30 * 24 * 3600 * 1000;
// v7.43.0 过期提醒：pending 超过 21 天未处理时提醒管理员一次（仍 30 天
// 过期，提醒不改状态、不延过期）；提醒标记写在提案自身的
// expiryRemindedAt 上，随 proposals.json 一起存。
const EVO_EXPIRE_REMIND_DAYS_MS = 21 * 24 * 3600 * 1000;
const EVO_EFFECT_DAYS_MS = 7 * 24 * 3600 * 1000;
const EVO_LLM_REVIEW_PER_CYCLE = 3;

// 落盘阈值可配：EVO_FLUSH_THRESHOLD（1~100，默认 10）。
// 调低 = 指标更实时但 R2 写更多；isolate 回收会丢少量未落盘计数，
// 对精确性要求高的部署可设为 2~3。
function evolveFlushThreshold(env) {
  const v = parseInt(env && env.EVO_FLUSH_THRESHOLD, 10);
  if (!Number.isInteger(v)) return 10;
  return Math.max(1, Math.min(100, v));
}

function evolveEnabled(env) {
  return !env || env.EVO_ENABLED !== '0';
}

function evolveAutoApply(env) {
  return evolveAutoApplyLevel(env) >= 1;
}

// 自主等级：0 = 只提议；1 = 自动应用低风险步数提案；2 = 再自动应用
// 经「沙盒模拟通过 + LLM 复核建议通过」双门禁的关键词提案。
// 2 级仍需 EVO_LLM_REVIEW=1（没有复核结论就谈不上双门禁），
// 且自动回滚（EVO_AUTO_ROLLBACK）是它的安全网。
function evolveAutoApplyLevel(env) {
  const v = String((env && env.EVO_AUTO_APPLY) || '').trim();
  if (v === '2') return 2;
  if (v === '1') return 1;
  return 0;
}

// 变差自动回滚：EVO_AUTO_ROLLBACK=1 时，效果回测判为 worse 的已应用提案
// 在本周期直接回滚。默认关闭——回滚是破坏性动作（配置会变），
// 没开开关时只在状态与通知里告警，等人决定。
function evolveAutoRollback(env) {
  return !!env && env.EVO_AUTO_ROLLBACK === '1';
}

// ---------- 周期周报（v7.29.0，失败补发 v7.40.0） ----------
//
// 每周一（UTC）的定时周期给管理员发一条 7 天摘要。只在有内容时发，
// 同一周只发一次，去重标记记在 kb/evolve/state.json 的
// lastWeeklyWeek / lastWeeklyAt 里——发送失败或无内容时不写标记。
// v7.40.0：发送失败时记下失败状态（weeklyFailWeek / weeklyFailWeekStart /
// weeklyFailWeekEnd / weeklyFailAt / weeklyFailAttempts，同一份 state 文件，
// 不新增 R2 key），第二天（周二）的定时周期重试一次，复用失败那次存下的
// 窗口；成功后写去重标记并清掉失败记录，失败两次后不再重试，等下周一
// 正常发。开关：EVO_NOTIFY=0 是总开关（复用每日通知的通道），
// EVO_WEEKLY=0 只关周报，默认开。
function evolveWeeklyEnabled(env) {
  return !env || env.EVO_WEEKLY !== '0';
}

// UTC 周一才发周报（与 runEvolveScheduled 按 UTC 日期去重的口径一致）。
function isWeeklyEvolveDay(ts) {
  return new Date(ts || Date.now()).getUTCDay() === 1;
}

// 本周的 Monday 00:00 UTC 时间戳（周一 UTC 0 点跑周期时，本周才刚开始，
// 所以提案计数不按「本周一 00:00 起」算——见 buildEvolveWeeklyReport）。
function evolveWeekStartTs(ts) {
  const d = new Date(ts || Date.now());
  const dow = (d.getUTCDay() + 6) % 7; // 周一=0 … 周日=6
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
}

// 周去重键：本周一的日期（YYYY-MM-DD）。同一周内两次跑周期
// （如手动重跑）键相同，只发一次；下周一键变了，可再发。
function evolveWeekKey(ts) {
  return evolveDayKey(new Date(evolveWeekStartTs(ts)));
}

// v7.40.0：周报失败记录的归一读法（state.json 里与去重标记同一份文件）。
//   weeklyFailWeek        失败那一周的周键（如 '2026-11-16'）
//   weeklyFailWeekStart / weeklyFailWeekEnd   失败那次算出的 7 天窗口起止
//   weeklyFailAt          失败那次的周期时间戳（决定窗口的那个周一）
//   weeklyFailAttempts    失败次数：1 = 周一失败过一次（可补发一次），
//                         2 = 补发也失败（不再重试，等下周一正常发）
// 老 state 没有这些字段时读作无失败记录，不报错；attempts 缺省按 1 算。
function normalizeWeeklyFailure(state) {
  if (!state || typeof state !== 'object') return null;
  const weekKey = typeof state.weeklyFailWeek === 'string' ? state.weeklyFailWeek : '';
  const failAt = Number(state.weeklyFailAt) || 0;
  if (!weekKey || !failAt) return null;
  return {
    weekKey,
    weekStart: typeof state.weeklyFailWeekStart === 'string' ? state.weeklyFailWeekStart : '',
    weekEnd: typeof state.weeklyFailWeekEnd === 'string' ? state.weeklyFailWeekEnd : '',
    failAt,
    attempts: Number(state.weeklyFailAttempts) || 1,
  };
}

// 组装周报文本（不发，只算）。窗口与周期一致：最近 7 天
// （ts 往前 7 天，含当天）；提案计数也按同一窗口算——
// 周一 UTC 0 点跑周期时「本周」才开始，按自然周算
// 新增/应用/回滚几乎永远是 0，摘要就没意义了。
// 返回 { ok, hasContent, weekKey, weekStart, weekEnd, text, stats }；
// hasContent 为 false 时 text 为空串，调用方不发。
async function buildEvolveWeeklyReport(env, now) {
  const ts = now || Date.now();
  const windowStartTs = ts - 7 * 24 * 3600 * 1000;
  const weekStart = evolveDayKey(new Date(ts - 6 * 24 * 3600 * 1000));
  const weekEnd = evolveDayKey(new Date(ts));
  // v7.40.0：窗口上界——周报窗口是 7 个整天 [weekStart, weekEnd]，
  // 提案时间只认窗口内（下界仍用 windowStartTs，与原来一字不差，
  // 不改周一行为）。补发时用失败那次的窗口重算，若不设上界，
  // 补发当天新建/应用/回滚的提案会混进旧周的计数里。
  const windowEndTs = Date.UTC(
    Number(weekEnd.slice(0, 4)), Number(weekEnd.slice(5, 7)) - 1, Number(weekEnd.slice(8, 10)),
  ) + 24 * 3600 * 1000;
  const inWeeklyWindow = (t) => (t || 0) >= windowStartTs && (t || 0) < windowEndTs;
  const days = await loadRecentDays(env, ts, 14);
  const curKeys = new Set();
  const prevKeys = new Set();
  for (let i = 0; i < 7; i++) {
    curKeys.add(evolveDayKey(new Date(ts - i * 24 * 3600 * 1000)));
    prevKeys.add(evolveDayKey(new Date(ts - (7 + i) * 24 * 3600 * 1000)));
  }
  const cur = summarizeEvolveDays(days.filter(d => d && curKeys.has(d.date)));
  const prev = summarizeEvolveDays(days.filter(d => d && prevKeys.has(d.date)));
  let items = [];
  try {
    const doc = await loadEvolveProposals(env);
    items = Array.isArray(doc.items) ? doc.items : [];
  } catch (e) {
    items = [];
  }
  // v7.31.0：KB 草稿（kind='kb-draft'）不是提案，不计入周报的
  // 新增/应用/回滚数，也不参与待审批最高分。
  const created = items.filter(p => p && p.kind !== 'kb-draft' && inWeeklyWindow(p.createdAt));
  const applied = items.filter(p => p && p.kind !== 'kb-draft' && p.status === 'applied' && inWeeklyWindow(p.appliedAt));
  const rolledBack = items.filter(p => p && p.kind !== 'kb-draft' && p.status === 'rolled_back'
    && inWeeklyWindow(p.rolledBackAt || p.decidedAt || 0));
  const pending = items.filter(p => p && p.status === 'pending')
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  const top = pending[0] || null;
  // 只在有内容时发：7 天总量为 0 且本周无提案变动时不发。
  const hasContent = (cur.total || 0) > 0 || created.length > 0
    || applied.length > 0 || rolledBack.length > 0;
  const stats = {
    total: cur.total || 0,
    paused: cur.paused || 0,
    prevTotal: prev.total || 0,
    prevPaused: prev.paused || 0,
    created: created.length,
    applied: applied.length,
    rolledBack: rolledBack.length,
    topPending: top ? { id: top.id, title: top.title, score: top.score || 0 } : null,
  };
  if (!hasContent) {
    return { ok: true, hasContent, weekKey: evolveWeekKey(ts), weekStart, weekEnd, text: '', stats };
  }
  const lines = [];
  lines.push('🧬 自我进化周报（' + weekStart + ' ~ ' + weekEnd + '）');
  let totalLine = '近 7 天：共 ' + stats.total + ' 轮，暂停 ' + stats.paused + ' 轮';
  if (stats.total > 0) {
    const rate = Math.round((stats.paused / stats.total) * 100);
    totalLine += '，暂停率 ' + rate + '%';
    // 与上 7 天的简单对比：上周有数据才写，没数据不写。
    if (stats.prevTotal > 0) {
      const prevRate = Math.round((stats.prevPaused / stats.prevTotal) * 100);
      const diff = rate - prevRate;
      totalLine += '（上周 ' + prevRate + '%，'
        + (diff > 0 ? '↑' + diff + ' 个百分点' : diff < 0 ? '↓' + (-diff) + ' 个百分点' : '与上周持平')
        + '）';
    }
  }
  lines.push(totalLine);
  lines.push('本周提案：新增 ' + stats.created + ' 条，已应用 ' + stats.applied + ' 条，回滚 ' + stats.rolledBack + ' 条');
  lines.push('待审批最高分：' + (top ? top.title + '（' + (top.score || 0) + ' 分）' : '无'));
  lines.push('在 Telegram 发 /evolve list 查看并审批。');
  return { ok: true, hasContent, weekKey: evolveWeekKey(ts), weekStart, weekEnd, text: lines.join('\n'), stats };
}

// 周期完成通知管理员：只在定时周期里用（手动 /evolve run 已当面回复）。
// 只有「有新提案 / 有回滚 / 有变差 / 有快过期提醒」时才发，避免每天一条打扰。
// 发失败（未配 TG 凭证、网络问题）只记失败，不影响周期本身。
async function notifyEvolveAdmin(env, text) {
  const token = String((env && env.TG_BOT_TOKEN) || '').trim();
  const admin = String((env && env.EVO_ADMIN_CHAT_ID) || '').trim();
  if (!token || !admin) return false;
  if (env && env.EVO_NOTIFY === '0') return false;
  try {
    const resp = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: admin, text: String(text || '').slice(0, 4000) }),
      signal: AbortSignal.timeout(10000),
    });
    return !!resp && resp.ok;
  } catch (e) {
    return false;
  }
}

function isEvolveAdmin(env, chatId) {
  const admin = String((env && env.EVO_ADMIN_CHAT_ID) || '').trim();
  if (!admin) return false;
  return String(chatId) === admin;
}

// 每轮结束调用：只改内存，不打 R2、不拖回复。
// event 由 loop.js 组装（含 channel/persona/route/工具 breakdown）。
async function recordEvolveRound(env, event, ctx) {
  if (!evolveEnabled(env)) return;
  if (!event || typeof event !== 'object') return;
  try {
    recordEvolveEvent(evolveBuffer, event);
  } catch (e) {
    return;
  }
  if (evolveBuffer.events < evolveFlushThreshold(env)) return;
  const task = (async () => {
    try {
      await flushEvolveBuffer(env, evolveBuffer);
    } catch (e) {}
  })();
  if (ctx && typeof ctx.waitUntil === 'function') {
    try { ctx.waitUntil(task); } catch (e) {}
  } else {
    // 没有 ctx（如单测 / 某些 webhook 路径）：不阻塞回复，交给 Cron 落盘。
    // buffer 还在内存里，下一轮或 Cron 触发时会再试。
    task.catch(() => {});
  }
}

async function loadRecentDays(env, now, days) {
  const list = [];
  const n = days > 0 ? days : 7;
  for (let i = 0; i < n; i++) {
    const d = new Date((now || Date.now()) - i * 24 * 3600 * 1000);
    const key = evolveDayKey(d);
    try {
      const day = await loadEvolveDay(env, key);
      if (day) list.push(day);
    } catch (e) {}
  }
  return list;
}

function dedupeKey(draft) {
  // v7.33.0：review 类提案的 change 是 null，去重键要带上 scope（R12 的
  // '人格:工具'），否则同一规则的不同组合在同一个键上撞车；没有 scope
  // 的提案键与原来一字不差，老去重行为不变。
  return (draft.rule || 'manual') + '|' + (draft.scope ? String(draft.scope) + '|' : '')
    + JSON.stringify(draft.change || null);
}

// v7.38.0：已有强词提案检查——规则循环的 R1c 预检与诊断分支共用同一口径，
// 不要各写一套：两处认「已有」的方式必须一字不差，否则同一词会在一条路
// 上被拦、在另一条路上漏网。
// 去重范围（写死在这里，两处共用）：
//   · 「已有」= 同一人格、同一词（大小写归一）、同一强词改动，且提案状态为
//     pending / applied / approved 任一——未解决的提案都算；rejected /
//     rolled_back / expired 的不算（否决与回滚有自己的 14/30 天去重窗口，
//     不由这道检查负责）；
//   · 弱词提案本身不算：弱词升强词是升级不是重复，已有弱词提案时诊断建议
//     升强词不应被误杀；只有已有强词才拦；
//   · 已应用的强词提案即 overlay 生效中的强词（overlay 由已应用提案折叠），
//     所以这一查同时覆盖了「已应用的强词 overlay」，不用另读一份。
// 非强词改动（弱词、预算、附言、限流）直接返回 false，不拦。
function hasExistingStrongKeywordProposal(items, change) {
  if (!change || change.kind !== 'persona_keyword_add' || change.strength !== 'strong') return false;
  if (!change.personaId || !change.word) return false;
  const word = String(change.word).toLowerCase();
  return (Array.isArray(items) ? items : []).some(p => p && p.kind !== 'kb-draft'
    && (p.status === 'pending' || p.status === 'applied' || p.status === 'approved')
    && p.change && p.change.kind === 'persona_keyword_add' && p.change.strength === 'strong'
    && String(p.change.personaId) === String(change.personaId)
    && String(p.change.word || '').toLowerCase() === word);
}

// LLM 诊断建议的标题：按改动类型写一句人能看懂的话。
function titleForEvolveChange(change) {
  const c = change || {};
  if (c.kind === 'persona_keyword_add') {
    const p = PERSONAS.find(x => x && x.id === c.personaId);
    return '给「' + (p ? p.name : c.personaId) + '」加' + (c.strength === 'weak' ? '弱' : '强') + '关键词「' + c.word + '」';
  }
  if (c.kind === 'persona_budget') {
    const p = PERSONAS.find(x => x && x.id === c.personaId);
    const name = p ? p.name : c.personaId;
    const parts = [];
    if (c.maxSteps !== undefined) parts.push('步数改为 ' + c.maxSteps);
    // v7.30.0：只改 ctxBudget 的提案（R11）以前标题会写成「步数改为
    // undefined」——LLM 诊断建议也可能产出这种改动，标题按实际改的字段写。
    if (c.ctxBudget !== undefined) parts.push('上下文预算改为 ' + c.ctxBudget);
    return '「' + name + '」' + parts.join('、');
  }
  if (c.kind === 'tool_limit') {
    if (c.toolTimeoutMs !== undefined) return '单次工具超时改为 ' + c.toolTimeoutMs + 'ms';
    if (c.wrapReserveMs !== undefined) return '收尾预留改为 ' + c.wrapReserveMs + 'ms';
    return '调整工具限流';
  }
  if (c.kind === 'prompt_addendum') {
    const p = PERSONAS.find(x => x && x.id === c.personaId);
    return '给「' + (p ? p.name : c.personaId) + '」加一句附言';
  }
  return '调整配置';
}

// 应用时快照基线：同一窗口的同一指标，7 天后再拿同一口径复测，
// 才能回答「这条提案到底有没有让事情变好」，而不是凭感觉。
function evolveBaselineFor(proposal, summary) {
  const s = summary || {};
  const base = { total: s.total || 0 };
  const c = proposal && proposal.change ? proposal.change : null;
  if (!c) return base;
  if (c.kind === 'persona_keyword_add') {
    base.nearMiss = (s.nearMiss || {})[c.personaId + ':' + c.word] || 0;
  } else if (c.kind === 'persona_budget') {
    const o = (s.outcomesByPersona || {})[c.personaId] || {};
    base.personaTotal = o.total || 0;
    base.paused = o.paused || 0;
    // v7.30.0：基线同时快照截断数——R11 的提案是冲着「暂停+截断」双高
    // 去的，回测要拿同一口径复测；只改步数的提案（R2）用不上这个字段，
    // 多记一个数字不影响它。
    base.truncated = o.truncated || 0;
  }
  return base;
}

// 效果回测的幅度：当前窗口率 − 基线率（百分点，保留 1 位小数），与 verdict
// 同一口径——关键词提案看近 miss 率，步数提案看暂停率，只改 ctxBudget
// 的提案看暂停+截断率。幅度只在样本足够、 verdict 已定时才有；
// unknown（样本不足/无可比指标）不给幅度、不编数字。
function evolveEffectVerdict(before, now, evidence, label) {
  // 基线率为 0 时比值阈值失效：0→0 不是变好（无变化），0→正值也不是变差
  // （分母为 0，任何正值都 ≥ 0×1.3）——没有可比基线，判待观察、不编幅度。
  // 规则生成的提案基线恒 >0（近 miss ≥5、暂停率 ≥30%），只在 LLM 诊断建议
  // 或手动应用的提案上才可能撞上 0 基线；之前 0→0 会误判「变好了」。
  if (!(before > 0)) {
    if (!(now > 0)) return { effect: 'unchanged', evidence, deltaPp: 0, deltaLabel: label };
    return { effect: 'unknown', evidence: evidence + '（基线率为 0，无法判断）', deltaPp: null, deltaLabel: label };
  }
  const delta = Math.round((now - before) * 1000) / 10;
  const effect = now <= before * 0.7 ? 'improved' : now >= before * 1.3 ? 'worse' : 'unchanged';
  return { effect, evidence, deltaPp: delta === 0 ? 0 : delta, deltaLabel: label };
}

// 幅度文案：暂停率 −12.5pp。deltaPp 不是有限数字（旧提案无该字段、
// 或待观察）时返回 ''，调用方不写幅度、不出现 NaN。
function formatEffectDelta(deltaPp, deltaLabel) {
  if (typeof deltaPp !== 'number' || !Number.isFinite(deltaPp)) return '';
  const sign = deltaPp > 0 ? '+' : deltaPp < 0 ? '−' : '';
  return (deltaLabel || '暂停率') + ' ' + sign + Math.abs(deltaPp).toFixed(1) + 'pp';
}

// 已知结论的幅度后缀：有幅度写幅度，旧提案无幅度字段写「幅度未记录」；
// 待观察不写幅度。
function effectDeltaSuffix(p) {
  if (!p || !p.effect || p.effect === 'unknown') return '';
  const d = formatEffectDelta(p.effectDeltaPp, p.effectDeltaLabel);
  return d ? '（' + d + '）' : '（幅度未记录）';
}

// 效果回测：基线 vs 当前 7 天窗口，同一指标、同一口径。
function evolveEffectFor(proposal, baseline, current) {
  const b = baseline || {};
  const s = current || {};
  const c = proposal && proposal.change ? proposal.change : null;
  if (!c || (s.total || 0) < 10 || (b.total || 0) < 10) {
    return { effect: 'unknown', evidence: '样本不足（基线 ' + (b.total || 0) + ' 轮，当前 ' + (s.total || 0) + ' 轮）' };
  }
  if (c.kind === 'persona_keyword_add') {
    const before = (b.nearMiss || 0) / b.total;
    const nowCount = (s.nearMiss || {})[c.personaId + ':' + c.word] || 0;
    const now = nowCount / s.total;
    const ev = '近 miss 率 ' + (before * 100).toFixed(1) + '% → ' + (now * 100).toFixed(1) + '%（' + nowCount + '/' + s.total + ' 轮）';
    return evolveEffectVerdict(before, now, ev, '近 miss 率');
  }
  if (c.kind === 'persona_budget') {
    if (!(b.personaTotal > 0)) return { effect: 'unknown', evidence: '基线中该人格无样本' };
    const o = (s.outcomesByPersona || {})[c.personaId] || {};
    if (!(o.total > 0)) return { effect: 'unknown', evidence: '当前窗口该人格无样本' };
    // v7.30.0：只改 ctxBudget 的提案（R11）是冲着「暂停+截断」双高去的，
    // 回测用同一口径——暂停+截断的合计率（基线与当前都按
    // (paused+truncated)/total 算，阈值与其它回测一致：≤70% 算变好，
    // ≥130% 算变差）。只改步数的提案（R2）仍只看暂停率：步数管的是
    // 「跑不完」，截断不在它的药效范围内，拿截断数去判它不公平。
    // v7.30.0 之前的旧基线没有 truncated 字段（读出来是 undefined）：
    // 这时回退到只看暂停率，不拿缺失的截断数当 0 算——否则当前窗口的
    // 截断会被全算成变差，旧提案会被误判。
    const ctxOnly = c.ctxBudget !== undefined && c.maxSteps === undefined;
    if (ctxOnly && typeof b.truncated === 'number') {
      const before = ((b.paused || 0) + (b.truncated || 0)) / b.personaTotal;
      const now = ((o.paused || 0) + (o.truncated || 0)) / o.total;
      const ev = '该人格暂停+截断率 ' + (before * 100).toFixed(1) + '% → ' + (now * 100).toFixed(1)
        + '%（暂停 ' + (o.paused || 0) + '/' + o.total + '，截断 ' + (o.truncated || 0) + '/' + o.total + '）';
      return evolveEffectVerdict(before, now, ev, '暂停+截断率');
    }
    const before = (b.paused || 0) / b.personaTotal;
    const now = (o.paused || 0) / o.total;
    const ev = '该人格暂停率 ' + (before * 100).toFixed(1) + '% → ' + (now * 100).toFixed(1) + '%（' + o.paused + '/' + o.total + ' 轮）';
    return evolveEffectVerdict(before, now, ev, '暂停率');
  }
  return { effect: 'unknown', evidence: '该类提案无可比指标' };
}

// 每天一次的进化周期：诊断 → 提案 →（可选）低风险自动应用。
async function runEvolveCycle(env, opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  if (!evolveEnabled(env)) return { ok: false, reason: 'disabled' };
  try {
    await flushEvolveBuffer(env, evolveBuffer);
  } catch (e) {}
  const days = await loadRecentDays(env, now, 7);
  const summary = summarizeEvolveDays(days);
  const wrapReserveMs = parseInt(env && env.AGENT_WRAP_RESERVE_MS, 10);
  const toolTimeoutMs = parseInt(env && env.AGENT_TOOL_TIMEOUT_MS, 10);
  const doc = await loadEvolveProposals(env);
  const items = Array.isArray(doc.items) ? doc.items.slice() : [];
  // v7.32.0：R1c 弱词升级的证据来源——已应用提案里的 weak 关键词
  // （即 overlay 生效中的弱词，同一来源；见 appliedWeakKeywords）。
  // 先读提案、再跑规则，顺序不能反。
  const drafts = analyzeEvolveDays(summary, PERSONAS, {
    wrapReserveMs: Number.isInteger(wrapReserveMs) ? wrapReserveMs : 8000,
    toolTimeoutMs: Number.isInteger(toolTimeoutMs) ? toolTimeoutMs : 30000,
    weakKeywords: appliedWeakKeywords(items),
  });
  const seen = new Set();
  // v7.28.0：回滚去重单独一本账——按改动内容本身（不看规则），30 天窗口。
  // 否决仍按原口径（规则+改动）14 天，不变。
  const rolledBackChanges = new Set();
  for (const p of items) {
    if (!p) continue;
    if (p.status === 'pending' || p.status === 'applied' || p.status === 'approved') {
      seen.add(dedupeKey(p));
      seen.add(p.id);
    } else if (p.status === 'rejected') {
      // 被否决的同规则提案 14 天内不再重复提
      if (now - (p.createdAt || 0) < EVO_DEDUPE_DAYS_MS) seen.add(dedupeKey(p));
    } else if (p.status === 'rolled_back') {
      // 被回滚的同一改动 30 天内不再重复提；窗口从回滚时间起算，
      // 旧记录没有 rolledBackAt 时回退到 decidedAt / createdAt。
      const rbAt = p.rolledBackAt || p.decidedAt || p.createdAt || 0;
      if (p.change && now - rbAt < EVO_ROLLBACK_DEDUPE_DAYS_MS) {
        rolledBackChanges.add(evolveChangeKey(p.change));
      }
    }
  }
  const created = [];
  const skipped = [];
  for (const draft of drafts) {
    const check = validateEvolveChange(draft.change, PERSONAS);
    if (!check.ok) {
      skipped.push({ draft: draft.title, reason: check.error });
      continue;
    }
    // v7.23.0：生成前先沙盒模拟，模拟失败（路由没变化、或误伤了别的人格）
    // 的提案不生成，只记一条跳过原因。
    // v7.37.0：模拟传 env——限流改动被环境变量显式配置全压住时模拟判 fail，
    // 周期不生成这种「生成了也永远不生效」的提案（部分压住的仍生成，模拟
    // 结论里写清哪几项被压住）。
    const sim = simulateEvolveProposal(draft, PERSONAS, env);
    if (sim.verdict === 'fail') {
      skipped.push({ draft: draft.title, reason: '模拟未通过：' + sim.detail });
      continue;
    }
    const id = proposalIdFor(draft.rule, draft.change, draft.scope);
    if (seen.has(id) || seen.has(dedupeKey(draft))) {
      skipped.push({ draft: draft.title, reason: '14 天内已有同类提案' });
      continue;
    }
    // v7.32.0 弱词升级去重：同一词已有待审批/已应用/已批准的强词提案
    // 时不再重复提升级。不能只靠上面的 seen——seen 按「规则+改动」
    // 比对，而普通强词提案的规则是 route-near-miss、升级是
    // route-near-miss-upgrade，规则不同、改动相同，seen 认不出是
    // 同一词；这里按改动本身（人格+词+强词）再比一次。已应用的弱词
    // 提案本身不挡升级（它是升级的对象，不是升级的结果）。
    // v7.38.0：这道检查抽成 hasExistingStrongKeywordProposal，与诊断
    // 分支共用同一口径（见该函数上的去重范围注释）；这里只改调用，
    // 行为不变。
    if (draft.upgradeFrom === 'weak' && draft.change) {
      const dupStrong = hasExistingStrongKeywordProposal(items, draft.change);
      if (dupStrong) {
        skipped.push({ draft: draft.title, reason: '该词已有待审批/已应用的强词提案，不再重复提升级' });
        continue;
      }
    }
    if (draft.change && rolledBackChanges.has(evolveChangeKey(draft.change))) {
      skipped.push({ draft: draft.title, reason: '同一改动 30 天内被回滚过，不再重复提' });
      continue;
    }
    const proposal = newEvolveProposal({ ...draft, id }, now);
    proposal.simulation = sim;
    items.push(proposal);
    created.push(proposal);
    seen.add(id);
    seen.add(dedupeKey(draft));
  }
  // 提案过期：pending 超过 30 天没人理，自动过期，不再占待审批列表。
  // v7.31.0：KB 草稿同口径过期——draft 状态且过了 expiresAt（30 天）
  // 的草稿在这里标为 expired；过期后下个周期可再生成（见下方的
  // upsertKbDraft，原地复活）。先过期、再生成，同一周期里过期的
  // 草稿不会挡住新草稿。
  const expired = [];
  for (const p of items) {
    if (p && p.status === 'pending' && now - (p.createdAt || 0) > EVO_EXPIRE_DAYS_MS) {
      p.status = 'expired';
      expired.push(p);
    } else if (p && p.kind === 'kb-draft' && p.status === 'draft' && isKbDraftExpired(p, now)) {
      p.status = 'expired';
      expired.push(p);
    }
  }
  // v7.43.0 提案过期提醒：pending 超过 21 天未处理、且没提醒过的提案，
  // 本周期提醒管理员一次（仍 30 天过期，提醒不改状态、不延过期）。
  // 提醒标记写在提案自身的 expiryRemindedAt 上，随本轮保存一起落盘；
  // 已提醒过的提案不再重复列入。提醒算在过期之后，所以刚过 30 天的
  // 提案直接过期、不再提醒；21~30 天之间的才提醒。提醒本身不发通知，
  // 只进 res.expiryReminders，由周期通知 / 手动 run 回复统一带出去。
  const expiryReminders = [];
  for (const p of items) {
    if (!p || p.status !== 'pending' || p.expiryRemindedAt) continue;
    const ageMs = now - (p.createdAt || 0);
    if (ageMs <= EVO_EXPIRE_REMIND_DAYS_MS || ageMs > EVO_EXPIRE_DAYS_MS) continue;
    const waitedDays = Math.floor(ageMs / (24 * 3600 * 1000));
    p.expiryRemindedAt = now;
    expiryReminders.push({ id: p.id, title: p.title, waitedDays, daysLeft: Math.max(0, 30 - waitedDays) });
  }
  // v7.31.0 KB 缺失主题自动草稿：对 R9 命中的每个主题（失败 ≥3 次），
  // 除现有的缺失清单 review 提案外，再生成一条草稿记录（status draft，
  // 存在同一份 proposals.json 里，不入库）。同一主题已有未过期草稿时
  // 不重复生成；草稿过期后可再生成。草稿只存主题词与失败次数，不存
  // 提问内容；确认建档要管理员 /evolve kb-draft <id> 才触发。
  const kbDrafts = [];
  for (const { topic, fails } of kbMissingTopics(summary)) {
    const res = upsertKbDraft(items, topic, fails, now);
    if (res.created) kbDrafts.push(res.created);
  }
  // 效果回测：已应用满 7 天且还没结论的提案，拿基线 vs 当前窗口复测一次。
  // 判 worse 的提案：开 EVO_AUTO_ROLLBACK=1 时本周期直接回滚；没开时
  // 只记进 worse 列表，等管理员在状态/通知里看到再决定。
  // v7.34.0 审计：自动应用与自动回滚各记一条（auto-apply / auto-rollback），
  // 随本轮保存一起落盘——自动操作没有管理员当面点，更要留痕。
  const auditEntries = [];
  const effects = [];
  const rolledBack = [];
  const worse = [];
  for (const p of items) {
    if (!p || p.status !== 'applied' || p.effect || !p.appliedAt) continue;
    if (now - p.appliedAt < EVO_EFFECT_DAYS_MS) continue;
    const res = evolveEffectFor(p, p.baseline, summary);
    p.effect = res.effect;
    p.effectEvidence = res.evidence;
    p.effectAt = now;
    // v7.44.0：回测幅度随结论一起存（百分点，1 位小数）；样本不足判
    // 待观察时无幅度，存 null 不编数字。自动回滚仍只看 effect 4 档。
    p.effectDeltaPp = typeof res.deltaPp === 'number' ? res.deltaPp : null;
    p.effectDeltaLabel = res.deltaLabel || null;
    effects.push({ id: p.id, effect: res.effect, evidence: res.evidence, deltaPp: p.effectDeltaPp, deltaLabel: p.effectDeltaLabel });
    if (res.effect === 'worse') {
      p.effectWorseCount = (p.effectWorseCount || 0) + 1;
      worse.push({ id: p.id, title: p.title, evidence: res.evidence, deltaPp: p.effectDeltaPp, deltaLabel: p.effectDeltaLabel });
      if (evolveAutoRollback(env)) {
        p.status = 'rolled_back';
        p.decidedBy = 'auto-rollback';
        p.decidedAt = now;
        p.rolledBackAt = now;
        // v7.28.0：自动回滚记录触发依据（效果回测判 worse + 证据数字）。
        p.rolledBackReason = normalizeRollbackReason('自动回滚：效果回测判 worse（' + res.evidence + '）');
        rolledBack.push({ id: p.id, title: p.title, evidence: res.evidence, reason: p.rolledBackReason });
        auditEntries.push(newEvolveAuditEntry({ at: now, actor: 'auto-rollback', action: 'auto-rollback', id: p.id, result: 'ok' }));
      }
    }
  }
  // 可选 LLM 复核：只对本次新提案、最多 3 条；失败不阻塞周期。
  const reviewed = [];
  if (env && env.EVO_LLM_REVIEW === '1') {
    for (const p of created.slice(0, EVO_LLM_REVIEW_PER_CYCLE)) {
      try {
        const res = await reviewEvolveProposalWithLLM(env, p);
        if (res.ok) {
          p.llmReview = { at: res.at, text: res.text, verdict: res.verdict, model: res.model };
          reviewed.push({ id: p.id, verdict: res.verdict });
        }
      } catch (e) {}
    }
  }
  // LLM 诊断建议（EVO_LLM_DIAGNOSE=1）：review 类提案本身没有可执行的改动，
  // 请模型根据证据给一个具体的配置改动；回来后走同一套关卡——
  // 校验 → 沙盒模拟 → 生成一条 origin='llm' 的新提案，仍需人工审批，永不自动应用。
  const diagnosed = [];
  if (env && env.EVO_LLM_DIAGNOSE === '1') {
    // v7.35.0：诊断建议的关键词改动也要认弱词表——LLM 不知道哪个词
    // 已是弱词（v7.32.0 的 R1/R1c 分工只管规则那条路）。校验/模拟
    // 之前先查已应用弱词表（与 R1c 同一来源 appliedWeakKeywords），
    // 命中已应用弱词的强词改动打上 upgradeFrom: 'weak' 标记，走弱词
    // 升级的展示与冲突豁免口径（list 里单列「弱词升级」，与源弱词
    // 提案不判冲突）；不命中的不打标记，仍是普通诊断建议。
    const weakKeywords = appliedWeakKeywords(items);
    const reviewProposals = created.filter(p => !p.change);
    for (const p of reviewProposals.slice(0, 2)) {
      try {
        const res = await suggestEvolveChangeWithLLM(env, p, summary);
        if (!res.ok) continue;
        let upgradeFrom = null;
        if (res.change && res.change.kind === 'persona_keyword_add' && res.change.strength === 'strong'
          && res.change.personaId && res.change.word
          && weakKeywords.includes(String(res.change.personaId) + ':' + String(res.change.word).toLowerCase())) {
          upgradeFrom = 'weak';
        }
        const check = validateEvolveChange(res.change, PERSONAS);
        if (!check.ok) continue;
        const sim = simulateEvolveProposal({ change: res.change }, PERSONAS, env);
        if (sim.verdict === 'fail') continue;
        // 本周期已生成的规则提案里已有完全相同的改动时不再重复建
        // （比如工具失败的 review 提案，规则 R6 本来就会提同一条附言）。
        if (created.some(x => JSON.stringify(x.change) === JSON.stringify(res.change))) continue;
        const draft = {
          rule: p.rule + '-llm',
          kind: res.change.kind,
          title: '模型建议：' + titleForEvolveChange(res.change),
          rationale: '由 review 提案「' + p.title + '」诊断而来，模型根据证据给出改动；'
            + '已过校验与沙盒模拟，仍需人工审批。'
            + (upgradeFrom === 'weak' ? '该词已作为弱关键词应用，本建议是弱词升级为强词。' : ''),
          evidence: p.evidence || '',
          change: res.change,
          // v7.35.0：命中已应用弱词时打上升级标记（见上方弱词表检查）。
          ...(upgradeFrom === 'weak' ? { upgradeFrom: 'weak' } : {}),
          risk: 'medium',
          score: p.score || 0,
          // v7.42.0：诊断建议继承源 review 提案的分数构成说明——
          // 证据与趋势都来自同一份 review 证据，不重新算。
          ...(p.scoreDetail ? { scoreDetail: p.scoreDetail } : {}),
        };
        const id = proposalIdFor(draft.rule, draft.change);
        if (seen.has(id) || seen.has(dedupeKey(draft))) continue;
        // v7.38.0：诊断分支补 R1c 的那道强词去重——与规则循环的
        // dupStrong 预检同一口径（见 hasExistingStrongKeywordProposal）。
        // 只在规则循环里有这道检查时，诊断建议会绕过它：review 提案
        // 触发诊断、模型又建议同一词时，list 里会出现两条同词强词提案
        // （有标记那条与已有强词提案同槽位同值、不判冲突，得人眼认出
        // 是重复）。弱词提案本身不拦（只有已有强词才拦），所以「只有
        // 弱词提案时诊断建议升强词」不受影响。丢弃只记一条跳过原因，
        // 不阻塞周期内其它提案；其它行为不变（校验、模拟、
        // origin='llm'、永不自动应用）。
        if (hasExistingStrongKeywordProposal(items, res.change)) {
          skipped.push({ draft: draft.title, reason: '该词已有待审批/已应用的强词提案，诊断建议不再重复提' });
          continue;
        }
        if (rolledBackChanges.has(evolveChangeKey(draft.change))) continue;
        const np = newEvolveProposal({ ...draft, id }, now);
        np.simulation = sim;
        np.origin = 'llm';
        np.linkedTo = p.id;
        items.push(np);
        created.push(np);
        diagnosed.push(np);
        seen.add(id);
        seen.add(dedupeKey(draft));
      } catch (e) {}
    }
  }
  // 低风险自动应用：仅 persona_budget + risk=low，且显式开了开关，
  // 且沙盒模拟已通过、LLM 复核没有建议否决。
  const applied = [];
  const autoLevel = evolveAutoApplyLevel(env);
  if (autoLevel >= 1) {
    for (const p of created) {
      const llmReject = p.llmReview && p.llmReview.verdict === 'reject';
      if (llmReject) continue;
      if (p.risk === 'low' && p.change && p.change.kind === 'persona_budget') {
        p.status = 'applied';
        p.appliedAt = now;
        p.decidedBy = 'auto';
        p.rolloutPercent = 100;
        p.baseline = evolveBaselineFor(p, summary);
        applied.push(p);
        auditEntries.push(newEvolveAuditEntry({ at: now, actor: 'auto', action: 'auto-apply', id: p.id, result: 'ok' }));
      } else if (autoLevel >= 2 && p.change && p.change.kind === 'persona_keyword_add'
        && p.risk === 'medium' && p.origin !== 'llm'
        && p.simulation && p.simulation.verdict === 'pass'
        && p.llmReview && p.llmReview.verdict === 'approve') {
        // L2 双门禁：沙盒模拟通过 + LLM 复核建议通过，缺一不可。
        p.status = 'applied';
        p.appliedAt = now;
        p.decidedBy = 'auto-l2';
        p.rolloutPercent = 100;
        p.baseline = evolveBaselineFor(p, summary);
        applied.push(p);
        auditEntries.push(newEvolveAuditEntry({ at: now, actor: 'auto-l2', action: 'auto-apply', id: p.id, result: 'ok' }));
      }
    }
  }
  // v7.26.0：提案冲突检测——生成时与已有 pending/applied/approved
  // 提案比同槽位不同值。新提案的 conflictsWith 在这里填；旧提案
  // 不必单独回写（list/状态/应用时动态重算，两边都能看到对方），
  // 但本轮保存时顺带把整批的 conflictsWith 刷新一次，已解决的
  // （否决/回滚/过期）提案会清掉旧冲突，不留 stale。
  annotateEvolveConflicts(items);
  if (created.length || expired.length || effects.length || reviewed.length || rolledBack.length || diagnosed.length || kbDrafts.length || auditEntries.length || expiryReminders.length) {
    const audit = auditEntries.reduce((acc, e) => appendEvolveAudit(acc, e), normalizeEvolveAudit(doc.audit));
    await saveEvolveProposals(env, { v: 1, items, audit });
    invalidateEvolveConfig();
  }
  try {
    await saveEvolveState(env, { lastCycleAt: now, lastCycleDay: evolveDayKey(new Date(now)) });
  } catch (e) {}
  return {
    ok: true,
    windowTotal: summary.total,
    created,
    applied,
    skipped,
    expired,
    expiryReminders,
    kbDrafts,
    effects,
    rolledBack,
    worse,
    reviewed,
    diagnosed,
    summary: {
      total: summary.total,
      paused: summary.paused,
      error: summary.error,
      truncated: summary.truncated,
      correction: (summary.signals || {}).correction || 0,
    },
  };
}

// ---------- 审计展示（v7.34.0） ----------
//
// 审计只记操作元数据（时间 + 动作 + 提案 id + 结果，非 ok 时附原因），
// 永不记提问/回答原文。状态与列表里各展示最近 5 条；无审计时不展示该节。
const EVO_AUDIT_ACTION_TEXT = {
  approve: '批准',
  reject: '否决',
  rollback: '回滚',
  'auto-apply': '自动应用',
  'auto-rollback': '自动回滚',
};
const EVO_AUDIT_RESULT_TEXT = { ok: '成功', skipped: '跳过', failed: '失败' };

function formatEvolveAuditLine(e) {
  const at = e && e.at ? new Date(e.at).toISOString().slice(5, 16).replace('T', ' ') : '—';
  const action = (e && EVO_AUDIT_ACTION_TEXT[e.action]) || (e && e.action) || '—';
  const result = (e && EVO_AUDIT_RESULT_TEXT[e.result]) || (e && e.result) || '—';
  let line = '· ' + at + ' ' + action + ' ' + ((e && e.id) || '') + ' ' + result;
  if (e && e.result !== 'ok' && e.reason) line += '（' + e.reason + '）';
  return line;
}

// 最近 5 条审计的行（新→旧）；无审计时返回空数组，调用方不展示该节。
function evolveAuditLines(audit) {
  const list = normalizeEvolveAudit(audit);
  if (!list.length) return [];
  const lines = ['最近审计：'];
  for (const e of list.slice(-5).reverse()) lines.push(formatEvolveAuditLine(e));
  return lines;
}

// 「现在能不能应用」的一条判定（只读，不改提案状态、不写 R2）：
// LLM 复核否决检查（只在批量时查，见 opts.checkLlmReview）→ 校验
// → 沙盒模拟 → 冲突计算。批量审批的预览与真正应用共用这条判定，
// 单条审批也共用其中的校验 + 模拟 + 冲突（不查复核——管理员当面点
// 的那条以人的判断为准）。返回 { ok, error?, sim?, conflicts? }；
// ok 时 sim 是本次模拟结论、conflicts 是未解决冲突方的 id。
// 预览结论只作参考：真正应用时逐条重新跑这条判定，预览与应用之间
// 词表或提案一变，结果就可能不同。
function assessEvolveProposalForApply(items, p, env, opts) {
  if (opts && opts.checkLlmReview && p.llmReview && p.llmReview.verdict === 'reject') {
    return { ok: false, error: 'LLM 复核建议否决' + (p.llmReview.text ? '：' + p.llmReview.text : '') };
  }
  const check = validateEvolveChange(p.change, PERSONAS);
  if (!check.ok) return { ok: false, error: '提案校验失败：' + check.error };
  // v7.23.0：应用前再模拟一次——关键词可能已被别的提案改掉词表，
  // 生成时的模拟结论不能直接沿用。
  const sim = simulateEvolveProposal(p, PERSONAS, env);
  if (sim.verdict === 'fail') return { ok: false, error: '模拟未通过，拒绝应用：' + sim.detail };
  // v7.26.0：冲突只提示、不阻塞。应用时动态重算未解决冲突——
  // 只看存储的 conflictsWith 会漏掉「后来的提案」或留着已否决
  // 提案的 stale 冲突；有冲突就在返回里附 conflictWarning。
  const conflicts = findEvolveConflicts(p, items);
  return { ok: true, sim, conflicts };
}

// 把一条已通过评估的提案写成已应用（纯内存步）：记模拟结论与冲突、
// 快照基线、改状态。单条与批量共用；调用方保证 assess.ok。
// v7.41.0：rolloutPercent 可选——单条审批由管理员指定（默认 100 全量），
// 自动应用与批量审批不传，默认全量；缺字段的旧提案同样按 100 处理。
function markEvolveProposalApplied(items, p, actor, summary, assess, rolloutPercent) {
  p.simulation = assess.sim;
  p.conflictsWith = assess.conflicts;
  const conflictWarning = assess.conflicts.length
    ? '⚠️ 冲突提醒：该提案与 ' + assess.conflicts.join('、') + ' 存在冲突（同一改动槽位被提了不同值），'
      + '已按你的审批应用；请复核冲突提案，决定留哪一个、否决哪一个。'
    : '';
  if (summary) p.baseline = evolveBaselineFor(p, summary);
  p.rolloutPercent = normalizeRolloutPercent(rolloutPercent);
  p.status = 'applied';
  p.appliedAt = Date.now();
  p.decidedBy = String(actor || 'admin');
  p.effect = null;
  p.effectEvidence = '';
  p.effectDeltaPp = null;
  p.effectDeltaLabel = '';
  return { ok: true, proposal: p, conflicts: assess.conflicts, ...(conflictWarning ? { conflictWarning } : {}) };
}

// 单条应用的核心关卡（纯内存步，不读写 R2）：校验 → 模拟 → 冲突提醒
// → 基线快照 → 改状态。单条 applyEvolveProposal 与批量
// applyLowRiskEvolveProposals 共用，关卡一字不差；区别只在外层：
// 单条失败记 failed、批量失败记 skipped，批量还多一道 LLM 复核否决
// 检查（单条审批不查这道——管理员当面点的那条以人的判断为准；
// 批量是闭眼全应用，被复核否决的必须先拦下）。
// 调用方保证 p 已是 pending 且 change 非空；失败时 p 不动。
// v7.41.0：env 可选，传了才判「显式配置优先」——限流改动被环境变量
// 显式配置全压住时模拟判 fail，应用被拒绝（而不是应用一条永远不生效
// 的提案）；部分压住的仍可应用，未被压住的那部分照常生效，被压住的
// 项在 /evolve 状态里单列一行。已应用的提案之后才被环境变量压住时，
// 状态不变，叠加时跳过该项（见 overlay.js），不用重新审批。
// rolloutPercent 可选（1~100，默认 100 全量）：单条审批由管理员指定，
// 自动应用与批量审批默认全量，不自动灰度；非法值直接拒绝应用。
function applyOneEvolveProposal(items, p, actor, summary, env, rolloutPercent) {
  if (rolloutPercent !== undefined && rolloutPercent !== null
    && (!Number.isInteger(Number(rolloutPercent)) || Number(rolloutPercent) < 1 || Number(rolloutPercent) > 100)) {
    return { ok: false, error: '灰度比例需为 1~100 的整数' };
  }
  const assess = assessEvolveProposalForApply(items, p, env);
  if (!assess.ok) return { ok: false, error: assess.error };
  return markEvolveProposalApplied(items, p, actor, summary, assess, rolloutPercent);
}

async function applyEvolveProposal(env, id, actor, rolloutPercent) {
  const doc = await loadEvolveProposals(env);
  const items = Array.isArray(doc.items) ? doc.items : [];
  const audit = normalizeEvolveAudit(doc.audit);
  const p = items.find(x => x && x.id === String(id));
  if (!p) return { ok: false, error: '找不到提案：' + id };
  // v7.31.0：KB 草稿不是提案，不能 approve / apply；确认建档走 kb-draft。
  if (p.kind === 'kb-draft') return { ok: false, error: '该记录是 KB 草稿，不是提案；确认建档请用 /evolve kb-draft ' + id };
  if (p.status === 'applied') return { ok: false, error: '该提案已应用' };
  if (p.status === 'rejected' || p.status === 'rolled_back') {
    return { ok: false, error: '该提案已否决/回滚，不能直接应用' };
  }
  if (!p.change) return { ok: false, error: 'review 类提案没有可应用的改动，请人工处理后关闭' };
  let summary = null;
  try {
    const days = await loadRecentDays(env, Date.now(), 7);
    summary = summarizeEvolveDays(days);
  } catch (e) {}
  const res = applyOneEvolveProposal(items, p, actor, summary, env, rolloutPercent);
  // v7.34.0 审计：应用成功记 approve/ok；校验或模拟失败记
  // approve/failed（带原因）。找不到/状态不对/草稿/review 类是
  // 「没走到审批这一步」，不记审计。
  const entry = res.ok
    ? newEvolveAuditEntry({ actor, action: 'approve', id: p.id, result: 'ok' })
    : newEvolveAuditEntry({ actor, action: 'approve', id: p.id, result: 'failed', reason: res.error });
  const saved = await saveEvolveProposals(env, { v: 1, items, audit: appendEvolveAudit(audit, entry) });
  if (saved) invalidateEvolveConfig();
  if (!res.ok) return { ok: false, error: res.error };
  if (!saved) return { ok: false, error: '保存失败', proposal: p };
  return { ok: true, proposal: p, ...(res.conflictWarning ? { conflictWarning: res.conflictWarning } : {}) };
}

// 批量应用低风险提案（v7.34.0，/evolve approve-low）：一次应用全部
// risk=low 且 pending 的普通提案。逐条走与单条审批完全相同的关卡
// （校验 → 沙盒模拟），外加一道 LLM 复核否决检查（llmReview.verdict
// 为 reject 的跳过）。review 类（change 为 null）与 KB 草稿不在批量
// 范围内，不凑数、不记跳过；高风险提案不动。有冲突的提案仍可应用，
// 汇总里对它标注冲突提醒（不阻塞）。
// 每条的结果（应用成功 / 跳过及原因）都在返回里汇总；每条操作各记
// 一条审计（approve/ok 或 approve/skipped，带原因）。整批只保存一次。
async function applyLowRiskEvolveProposals(env, actor) {
  const doc = await loadEvolveProposals(env);
  const items = Array.isArray(doc.items) ? doc.items : [];
  let audit = normalizeEvolveAudit(doc.audit);
  const targets = items.filter(p => p && p.status === 'pending'
    && (p.risk || 'low') === 'low' && p.kind !== 'kb-draft' && p.change);
  if (!targets.length) return { ok: true, applied: [], skipped: [], total: 0 };
  let summary = null;
  try {
    const days = await loadRecentDays(env, Date.now(), 7);
    summary = summarizeEvolveDays(days);
  } catch (e) {}
  const applied = [];
  const skipped = [];
  for (const p of targets) {
    // v7.39.0：判定与预览共用 assessEvolveProposalForApply——真正应用时
    // 逐条重新评估，预览结论不直接沿用；通过评估的再由
    // markEvolveProposalApplied 写成已应用。
    const assess = assessEvolveProposalForApply(items, p, env, { checkLlmReview: true });
    if (!assess.ok) {
      skipped.push({ id: p.id, title: p.title, reason: assess.error });
      audit = appendEvolveAudit(audit, newEvolveAuditEntry({ actor, action: 'approve', id: p.id, result: 'skipped', reason: assess.error }));
      continue;
    }
    const res = markEvolveProposalApplied(items, p, actor, summary, assess);
    applied.push({ id: p.id, title: p.title, conflicts: res.conflicts || [] });
    audit = appendEvolveAudit(audit, newEvolveAuditEntry({ actor, action: 'approve', id: p.id, result: 'ok' }));
  }
  const saved = await saveEvolveProposals(env, { v: 1, items, audit });
  if (saved) invalidateEvolveConfig();
  if (!saved) return { ok: false, error: '保存失败', applied: [], skipped: [], total: targets.length };
  return { ok: true, applied, skipped, total: targets.length };
}

// 批量审批 dry-run 预览（v7.39.0，/evolve approve-low preview）：
// 只算不改——列出会被应用的低风险 pending 提案（每条带 id、标题、
// 模拟结论、复核结论）与会被跳过的提案及跳过原因。判定与真正应用
// 共用 assessEvolveProposalForApply（复核否决 → 校验 → 模拟，
// 冲突只提示不阻塞）；但预览不改提案状态、不写 R2、不记审计，
// 真正应用时仍逐条重新评估——预览与应用之间词表或提案一变，
// 结果就可能不同，预览结论只作参考，不作承诺。
async function previewLowRiskEvolveProposals(env) {
  const doc = await loadEvolveProposals(env);
  const items = Array.isArray(doc.items) ? doc.items : [];
  const targets = items.filter(p => p && p.status === 'pending'
    && (p.risk || 'low') === 'low' && p.kind !== 'kb-draft' && p.change);
  if (!targets.length) return { ok: true, appliable: [], skipped: [], total: 0 };
  const appliable = [];
  const skipped = [];
  for (const p of targets) {
    const assess = assessEvolveProposalForApply(items, p, env, { checkLlmReview: true });
    if (assess.ok) {
      appliable.push({
        id: p.id,
        title: p.title,
        sim: { verdict: assess.sim.verdict, detail: assess.sim.detail || '' },
        review: (p.llmReview && p.llmReview.verdict) || null,
        conflicts: assess.conflicts || [],
      });
    } else {
      skipped.push({ id: p.id, title: p.title, reason: assess.error });
    }
  }
  return { ok: true, appliable, skipped, total: targets.length };
}

async function decideEvolveProposal(env, id, status, actor, reason) {
  const doc = await loadEvolveProposals(env);
  const items = Array.isArray(doc.items) ? doc.items : [];
  const audit = normalizeEvolveAudit(doc.audit);
  const p = items.find(x => x && x.id === String(id));
  if (!p) return { ok: false, error: '找不到提案：' + id };
  // v7.31.0：KB 草稿不是提案，不能 reject / rollback。
  if (p.kind === 'kb-draft') return { ok: false, error: '该记录是 KB 草稿，不是提案；确认建档请用 /evolve kb-draft ' + id };
  if (status === 'rejected') {
    if (p.status === 'applied') return { ok: false, error: '已应用的提案请用 rollback 回滚，而不是 reject' };
    p.status = 'rejected';
  } else if (status === 'rolled_back') {
    if (p.status !== 'applied') return { ok: false, error: '只有已应用的提案可以回滚' };
    p.status = 'rolled_back';
    // v7.28.0 回滚学习：记回滚原因（管理员手写短句，限 100 字）与回滚时间；
    // 原因可空，未写时记为空串，展示为「未记录」。
    p.rolledBackReason = normalizeRollbackReason(reason);
    p.rolledBackAt = Date.now();
  } else {
    return { ok: false, error: '未知决定：' + status };
  }
  p.decidedBy = String(actor || 'admin');
  p.decidedAt = Date.now();
  // v7.34.0 审计：否决记 reject/ok，回滚记 rollback/ok。
  const action = status === 'rejected' ? 'reject' : 'rollback';
  const entry = newEvolveAuditEntry({ actor, action, id: p.id, result: 'ok' });
  const ok = await saveEvolveProposals(env, { v: 1, items, audit: appendEvolveAudit(audit, entry) });
  if (ok) invalidateEvolveConfig();
  return { ok, proposal: p };
}

// ---------- 长期趋势（v7.35.0，纯函数） ----------
//
// 两周对比（原称「30 天对比」，窗口实际是本 7 天 vs 上 7 天、共 14 天
// 数据，v7.45.0 正名）：本 7 天 vs 上 7 天的暂停率。数据来自已有的日聚合
// （状态里本来就要读近 7 天，这里一次读近 14 天、不新增 R2 key）；
// 两个窗口各需 ≥10 轮才下结论，样本不足写「样本不足」不下结论
// （10 轮以下的百分点很可能是噪声）。变化用百分点表示。
// days 是 loadRecentDays 读出的日聚合列表（缺失的天不在里面），
// now 是状态生成时间。返回 { ok, curTotal, curPaused, curRate,
// prevTotal, prevPaused, prevRate, diff }；样本不足时 ok 为 false，
// 只带两个窗口的轮数，调用方据此写「样本不足」。
function evolveTwoWeekCompare(days, now) {
  const ts = now || Date.now();
  const curKeys = new Set();
  const prevKeys = new Set();
  for (let i = 0; i < 7; i++) {
    curKeys.add(evolveDayKey(new Date(ts - i * 24 * 3600 * 1000)));
    prevKeys.add(evolveDayKey(new Date(ts - (7 + i) * 24 * 3600 * 1000)));
  }
  const sumWindow = (keys) => {
    let total = 0;
    let paused = 0;
    for (const d of Array.isArray(days) ? days : []) {
      if (!d || !keys.has(d.date)) continue;
      total += d.total || 0;
      paused += d.paused || 0;
    }
    return { total, paused };
  };
  const cur = sumWindow(curKeys);
  const prev = sumWindow(prevKeys);
  if (cur.total < 10 || prev.total < 10) {
    return { ok: false, curTotal: cur.total, prevTotal: prev.total };
  }
  const curRate = Math.round((cur.paused / cur.total) * 100);
  const prevRate = Math.round((prev.paused / prev.total) * 100);
  return {
    ok: true,
    curTotal: cur.total, curPaused: cur.paused, curRate,
    prevTotal: prev.total, prevPaused: prev.paused, prevRate,
    diff: curRate - prevRate,
  };
}

const EVO_EFFECT_TEXT = { improved: '变好了', unchanged: '无变化', worse: '变差了', unknown: '待观察' };

// 最近 7 天内有回测结论的已应用提案（最多 5 条，按回测时间倒序）。
// 只读提案上的 effect / effectAt 字段展示，不重新计算——回测结论
// 是周期里算好写死的，这里只负责「同步进状态趋势线」；无结论时
// 返回空数组，调用方不展示该节。已回滚的不算：回滚后它不再是
// 「已应用提案」，想看它去 list 末尾的已回滚一节。
function evolveRecentEffects(proposals, now) {
  const ts = now || Date.now();
  return (Array.isArray(proposals) ? proposals : [])
    .filter(p => p && p.status === 'applied' && p.effect && (p.effectAt || 0) > 0
      && ts - p.effectAt < EVO_EFFECT_DAYS_MS)
    .sort((a, b) => (b.effectAt || 0) - (a.effectAt || 0))
    .slice(0, 5)
    .map(p => ({
      id: p.id,
      title: p.title,
      effect: p.effect,
      effectText: EVO_EFFECT_TEXT[p.effect] || p.effect,
      effectDeltaPp: p.effectDeltaPp,
      effectDeltaLabel: p.effectDeltaLabel,
      effectAt: p.effectAt,
      effectDate: new Date(p.effectAt).toISOString().slice(0, 10),
    }));
}

async function evolveStatusText(env) {
  const now = Date.now();
  const days = await loadRecentDays(env, now, 14);
  // 周期与趋势的窗口仍是近 7 天；多读的 7 天只给上周对比用。
  const curKeys = new Set();
  for (let i = 0; i < 7; i++) curKeys.add(evolveDayKey(new Date(now - i * 24 * 3600 * 1000)));
  const recentDays = days.filter(d => d && curKeys.has(d.date));
  const summary = summarizeEvolveDays(recentDays);
  const config = await loadEvolveConfig(env);
  const proposals = Array.isArray(config.proposals) ? config.proposals : [];
  const pending = proposals.filter(p => p.status === 'pending');
  const applied = proposals.filter(p => p.status === 'applied');
  const state = await loadEvolveState(env).catch(() => ({ lastCycleAt: 0 }));
  const lines = [];
  lines.push('🧬 自我进化状态（近 7 天）');
  lines.push('');
  lines.push('观测：共 ' + summary.total + ' 轮，暂停 ' + summary.paused + ' 轮，失败 ' + summary.error
    + ' 轮，截断 ' + summary.truncated + ' 轮，用户纠正 ' + ((summary.signals || {}).correction || 0) + ' 次');
  // 灰度对照：evolve 组 vs control 组的暂停率，overlay 有没有用看这里。
  const groups = summary.byGroup || {};
  const eg = groups.evolve || { total: 0, paused: 0 };
  const cg = groups.control || { total: 0, paused: 0 };
  const pct = evolveRolloutPercent(env);
  const rate = g => (g.total > 0 ? Math.round((g.paused / g.total) * 100) + '%' : '—');
  lines.push('灰度 ' + pct + '%：进化组 ' + eg.total + ' 轮（暂停 ' + rate(eg) + '）｜对照组 '
    + cg.total + ' 轮（暂停 ' + rate(cg) + '）');
  // v7.41.0 按提案 A/B：灰度中的已应用提案各有一组生效组 vs 未生效组
  // 对比（同一份日聚合的 byProposal，不新增 R2 key）。无灰度提案、
  // 或灰度提案尚无样本时不展示该节；样本为 0 的那组暂停率显示为 —。
  const grayedApplied = applied.filter(p => normalizeRolloutPercent(p.rolloutPercent) < 100);
  if (grayedApplied.length) {
    lines.push('按提案灰度对比（生效组 vs 未生效组，近 7 天）：');
    for (const p of grayedApplied) {
      const slot = (summary.byProposal || {})[p.id]
        || { in: { total: 0, paused: 0 }, out: { total: 0, paused: 0 } };
      const gin = slot.in || { total: 0, paused: 0 };
      const gout = slot.out || { total: 0, paused: 0 };
      lines.push('· ' + p.id + ' ' + p.title + '（灰度 ' + normalizeRolloutPercent(p.rolloutPercent) + '%）：生效组 '
        + gin.total + ' 轮（暂停 ' + rate(gin) + '）｜未生效组 ' + gout.total + ' 轮（暂停 ' + rate(gout) + '）');
    }
  }
  // 暂停率趋势（近 7 天，老→新）：只看总量会漏掉「最近两天突然变差」。
  const trend = recentDays.slice().reverse().map(d => {
    const date = String(d.date || '').slice(5);
    return date + ' ' + ((d.total || 0) > 0 ? Math.round(((d.paused || 0) / d.total) * 100) + '%' : '—');
  }).join('｜');
  if (trend) lines.push('暂停率趋势：' + trend);
  const cmp = compareEvolveGroups(summary);
  if (cmp.verdict === 'evolve-worse') {
    lines.push('⚠️ 对照告警：进化组暂停率高于对照组 ' + Math.round(cmp.diff * 100)
      + ' 个百分点，overlay 可能在拖后腿（见 /evolve list 里的灰度告警提案）');
  } else if (cmp.verdict === 'evolve-better') {
    lines.push('对照结论：进化组暂停率低于对照组 ' + Math.round(-cmp.diff * 100) + ' 个百分点');
  }
  // v7.35.0 长期趋势：本 7 天 vs 上 7 天的暂停率对比（两个窗口各需
  // ≥10 轮才下结论）。7 天趋势线只看「最近有没有变差」，这一行看
  // 「这一周比上一周整体好还是差」。
  const cmp30 = evolveTwoWeekCompare(days, now);
  if (cmp30.ok) {
    lines.push('上周对比：本 7 天 ' + cmp30.curRate + '%（暂停 ' + cmp30.curPaused + '/' + cmp30.curTotal
      + '）vs 上 7 天 ' + cmp30.prevRate + '%（暂停 ' + cmp30.prevPaused + '/' + cmp30.prevTotal + '），'
      + (cmp30.diff > 0 ? '↑' + cmp30.diff + ' 个百分点'
        : cmp30.diff < 0 ? '↓' + (-cmp30.diff) + ' 个百分点' : '与上周持平'));
  } else {
    lines.push('上周对比：样本不足（本 7 天 ' + cmp30.curTotal + ' 轮，上 7 天 ' + cmp30.prevTotal
      + ' 轮，窗口各需 ≥10 轮）');
  }
  // v7.35.0：回测结论同步进状态趋势线——最近 7 天内有回测结论的
  // 已应用提案（最多 5 条），标题 + 结论 + 回测日期；无结论时不展示该节。
  // v7.44.0：结论后面附幅度（当前窗口率 − 基线率，百分点）；待观察
  // 不写幅度，旧提案无幅度字段写「幅度未记录」，不出现 NaN。
  const recentEffects = evolveRecentEffects(proposals, now);
  if (recentEffects.length) {
    lines.push('最近回测（7 天内）：');
    for (const e of recentEffects) {
      const d = formatEffectDelta(e.effectDeltaPp, e.effectDeltaLabel);
      const detail = e.effect === 'unknown' ? e.effectDate
        : d ? d + '，' + e.effectDate : '幅度未记录，' + e.effectDate;
      lines.push('· ' + e.id + ' ' + e.title + '——效果：' + e.effectText + '（' + detail + '）');
    }
  }
  const topTools = Object.entries(summary.byTool || {})
    .sort((a, b) => (b[1].fails || 0) - (a[1].fails || 0))
    .slice(0, 3)
    .filter(([, v]) => (v.fails || 0) > 0)
    .map(([k, v]) => k + ' ' + v.fails + '/' + v.calls + ' 失败');
  if (topTools.length) lines.push('失败最多工具：' + topTools.join('，'));
  lines.push('上次进化周期：' + (state.lastCycleAt ? new Date(state.lastCycleAt).toISOString().slice(0, 19).replace('T', ' ') + ' UTC' : '尚未运行'));
  lines.push('待审批提案：' + pending.length + ' 条｜已应用：' + applied.length + ' 条');
  // v7.28.0：最近 30 天内回滚过的提案，带原因露一面——同一改动 30 天内
  // 不再重复提，管理员能在这里看到「上次为什么回滚」。
  const rolledBack = proposals.filter(p => p.status === 'rolled_back'
    && now - (p.rolledBackAt || p.decidedAt || p.createdAt || 0) < EVO_ROLLBACK_DEDUPE_DAYS_MS)
    .sort((a, b) => ((b.rolledBackAt || b.createdAt || 0) - (a.rolledBackAt || a.createdAt || 0)));
  if (rolledBack.length) {
    const latest = rolledBack[0];
    lines.push('已回滚 ' + rolledBack.length + ' 条（30 天内同一改动不再重复提），最近：'
      + latest.title + '——原因：' + (latest.rolledBackReason || '未记录'));
  }
  // v7.31.0：未过期的 KB 草稿单独一节——草稿不计入待审批数，
  // 只有管理员 /evolve kb-draft <id> 确认后才建档。
  const kbDrafts = proposals.filter(p => isKbDraftLive(p, now))
    .sort((a, b) => (b.fails || 0) - (a.fails || 0));
  if (kbDrafts.length) {
    lines.push('KB 草稿 ' + kbDrafts.length + ' 条（30 天内有效，确认后才建档，不计入待审批）：');
    for (const d of kbDrafts.slice(0, 5)) {
      lines.push('· ' + d.id + ' 「' + d.topic + '」失败 ' + (d.fails || 0) + ' 次 —— 确认建档：/evolve kb-draft ' + d.id);
    }
  }
  // v7.26.0：冲突提示——动态重算，旧提案被后来的提案冲突时这里也能看到。
  const conflictedPending = pending.filter(p => findEvolveConflicts(p, proposals).length > 0);
  if (conflictedPending.length) {
    lines.push('⚠️ 提案冲突：' + conflictedPending.length + ' 条待审批提案与其它提案同槽位不同值（见 /evolve list），请先确认再审批');
  }
  lines.push('');
  if (pending.length) {
    lines.push('待审批（按影响分排序）：');
    const sorted = pending.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
    for (const p of sorted.slice(0, 5)) {
      // v7.42.0：状态总览的待审批一节也带上分数（与 list 同一口径）。
      lines.push('· ' + p.id + ' ' + p.title + '（风险 ' + (p.risk || 'low') + '，' + (p.score || 0) + ' 分）');
    }
    lines.push('审批：/evolve approve <id> ｜ 否决：/evolve reject <id>');
  } else {
    lines.push('暂无待审批提案。每天 UTC 0 点左右自动跑一次诊断，也可发 /evolve run 手动跑。');
  }
  if (applied.length) {
    lines.push('');
    lines.push('已应用（可回滚）：');
    for (const p of applied.slice(0, 5)) {
      const effect = p.effect ? '｜效果：' + ({ improved: '变好了', unchanged: '无变化', worse: '变差了', unknown: '待观察' }[p.effect] || p.effect) + effectDeltaSuffix(p) : '';
      const gray = normalizeRolloutPercent(p.rolloutPercent) < 100
        ? '｜灰度 ' + normalizeRolloutPercent(p.rolloutPercent) + '%' : '';
      lines.push('· ' + p.id + ' ' + p.title + effect + gray + ' —— /evolve rollback ' + p.id);
    }
  }
  // v7.37.0：被环境变量显式配置压住的已应用限流提案——提案本身仍是
  // applied（不悄悄改状态），只是该项叠加时跳过、实际用环境变量的值；
  // 环境变量改掉或删掉后提案自动重新生效，不用重新审批。动态算（不存
  // 标记）：env 变了，同一条提案的压住状态跟着变，不会留 stale 标记。
  // 没配环境变量、或已应用的限流提案没有被压住的项时，不展示该节。
  const explicitLimits = (agentLimits(env).explicit) || {};
  const overriddenApplied = applied
    .filter(p => p && p.change && p.change.kind === 'tool_limit')
    .map(p => ({
      id: p.id,
      title: p.title,
      keys: ['toolTimeoutMs', 'toolConcurrency', 'wrapReserveMs']
        .filter(k => p.change[k] !== undefined && explicitLimits[k]),
    }))
    .filter(o => o.keys.length > 0);
  if (overriddenApplied.length) {
    lines.push('⚠️ 环境变量显式配置压住了 ' + overriddenApplied.length + ' 条已应用限流提案（提案保持 applied，改环境变量后自动生效）：');
    for (const o of overriddenApplied) {
      lines.push('· ' + o.id + ' ' + o.title + '——' + o.keys.join('、') + '仍用环境变量值');
    }
  }
  // v7.34.0：最近 5 条审计（无审计时不展示该节）。
  const auditLines = evolveAuditLines(config.audit);
  if (auditLines.length) {
    lines.push('');
    lines.push(...auditLines);
  }
  lines.push('');
  lines.push('说明：默认只提议、不自动改配置；自动应用需设 EVO_AUTO_APPLY=1（只限低风险步数提案），=2 时再自动应用双门禁的强关键词提案。');
  return lines.join('\n');
}

// 共享命令处理（Telegram /evolve 与微信「进化状态」等口令共用）：
//   status（默认）/ list / run / approve <id> / reject <id> / rollback <id> / review <id>
//   / kb-draft <id>（v7.31.0，确认 KB 草稿并建档）
// 管理员门禁不在这里做：Telegram 由 isEvolveAdmin 校验，微信由
// 通道本身的 owner 锁校验（只有绑定的机主能发消息）。
// opts（可选）：{ history, modelId, chatId }——kb-draft 建档需要最近
// 对话记录，由各通道在调用时传入；不传时确认建档会报「没有可整理的
// 对话内容」，不建空文档。
// 返回的纯文本由各通道直接回复。
async function handleEvolveCommand(env, args, actor, opts) {
  const a = Array.isArray(args) ? args.filter(x => String(x || '').trim()) : [];
  const alias = { '状态': 'status', '列表': 'list', '运行': 'run', '应用': 'approve', '应用低风险提案': 'approve-low', '否决': 'reject', '回滚': 'rollback', '复核': 'review', '确认草稿': 'kb-draft' };
  const sub = alias[String(a[0] || 'status')] || String(a[0] || 'status').toLowerCase();
  const id = a[1] ? String(a[1]).trim() : '';
  if (sub === 'status') return evolveStatusText(env);
  if (sub === 'list') {
    const config = await loadEvolveConfig(env);
    const proposals = Array.isArray(config.proposals) ? config.proposals : [];
    const pending = proposals.filter(p => p.status === 'pending')
      .sort((a, b) => (b.score || 0) - (a.score || 0));
    // v7.28.0：已回滚提案附在列表末尾，带回滚原因——只展示已回滚的，
    // 不必为所有状态展示原因。
    const rolledBack = proposals.filter(p => p.status === 'rolled_back')
      .sort((a, b) => ((b.rolledBackAt || b.decidedAt || b.createdAt || 0)
        - (a.rolledBackAt || a.decidedAt || a.createdAt || 0)))
      .slice(0, 5);
    // v7.31.0：未过期的 KB 草稿单独一节，与待审批提案分开；
    // 草稿不计入待审批数（pending 只按 status 算，草稿 status 是 draft）。
    const kbDrafts = proposals.filter(p => isKbDraftLive(p, Date.now()))
      .sort((a, b) => (b.fails || 0) - (a.fails || 0));
    // v7.34.0：最近 5 条审计（无审计时不展示该节；只有审计、没有提案时也展示）。
    const auditLines = evolveAuditLines(config.audit);
    if (!pending.length && !rolledBack.length && !kbDrafts.length && !auditLines.length) return '暂无待审批提案。';
    const lines = [];
    if (kbDrafts.length) {
      lines.push('📝 KB 草稿（' + kbDrafts.length + ' 条，30 天内有效，确认后才从最近对话建档）：', '');
      for (const d of kbDrafts) {
        lines.push('· ' + d.id + ' 「' + d.topic + '」失败 ' + (d.fails || 0) + ' 次');
        lines.push('  ' + (d.evidence || ''));
        lines.push('  确认建档：/evolve kb-draft ' + d.id);
        lines.push('');
      }
    }
    if (pending.length) {
      lines.push('🧬 待审批提案（' + pending.length + ' 条，按影响分排序）：', '');
      for (const p of pending) {
        lines.push('· ' + p.id);
        lines.push('  ' + p.title);
        // v7.32.0：升级提案在 list 里单列一行「弱词升级」，管理员
        // 不用点进详情也能认出这不是一条新词提案。
        if (p.upgradeFrom === 'weak') lines.push('  类型：弱词升级（弱词 → 强词；原弱词提案保持 applied）');
        lines.push('  依据：' + (p.rationale || ''));
        // v7.42.0：list 里写清每条提案的分数构成——证据分 × 趋势因子，
        // 以及前段/后段次数；旧提案写明是旧分。管理员不用点进详情
        // 也能看出为什么排这个位置。
        lines.push('  ' + formatEvolveScoreDetail(p));
        lines.push('  风险：' + (p.risk || 'low') + '｜规则：' + (p.rule || ''));
        // v7.26.0：冲突提示动态计算——不依赖提案上存的 conflictsWith，
        // 所以先存的旧提案被后来的提案冲突时，这里同样能标出来。
        const conflicts = findEvolveConflicts(p, proposals);
        if (conflicts.length) {
          lines.push('  ⚠️ 冲突：与 ' + conflicts.join('、') + ' 同槽位不同值，请先确认再审批');
        }
        if (p.simulation && p.simulation.verdict) lines.push('  模拟：' + p.simulation.verdict + '（' + (p.simulation.detail || '') + '）');
        if (p.llmReview) lines.push('  LLM 复核：' + (p.llmReview.verdict || '') + '——' + p.llmReview.text);
        lines.push('  审批：/evolve approve ' + p.id + ' ｜ 否决：/evolve reject ' + p.id);
        lines.push('');
      }
    }
    if (rolledBack.length) {
      lines.push('已回滚（30 天内同一改动不再重复提）：');
      for (const p of rolledBack) {
        lines.push('· ' + p.id + ' ' + p.title + ' —— 回滚原因：' + (p.rolledBackReason || '未记录'));
      }
    }
    if (auditLines.length) {
      lines.push('');
      lines.push(...auditLines);
    }
    return lines.join('\n').trim();
  }
  if (sub === 'run') {
    const res = await runEvolveCycle(env, {});
    if (!res.ok) return '进化周期未运行：' + (res.reason || '未知原因');
    const lines = ['🧬 进化周期完成（近 7 天 ' + res.windowTotal + ' 轮）：'];
    lines.push('新提案 ' + res.created.length + ' 条，自动应用 ' + (res.applied || []).length + ' 条'
      + '，过期 ' + (res.expired || []).length + ' 条，效果回测 ' + (res.effects || []).length + ' 条'
      + '，新建 KB 草稿 ' + (res.kbDrafts || []).length + ' 条'
      + '，过期提醒 ' + (res.expiryReminders || []).length + ' 条');
    for (const p of res.created) lines.push('· ' + p.id + ' ' + p.title + (Array.isArray(p.conflictsWith) && p.conflictsWith.length ? '（⚠️ 与 ' + p.conflictsWith.join('、') + ' 冲突）' : ''));
    // v7.43.0：手动 run 也提醒——提醒本身就是给管理员看的，当面回复里
    // 直接列出，不另发通知；通知行为与定时周期一致（run 本来就不调
    // notifyEvolveAdmin，只回当面这一份）。
    for (const r of (res.expiryReminders || [])) lines.push('· ⏰ 即将过期：' + r.title + '（' + r.id + '，已等待 ' + r.waitedDays + ' 天'
      + (r.daysLeft > 0 ? '，还剩 ' + r.daysLeft + ' 天过期' : '，今天过期') + '）');
    for (const d of (res.kbDrafts || [])) lines.push('· 📝 KB 草稿：' + d.id + ' 「' + d.topic + '」失败 ' + (d.fails || 0) + ' 次（确认建档：/evolve kb-draft ' + d.id + '）');
    for (const x of (res.effects || [])) {
      const d = formatEffectDelta(x.deltaPp, x.deltaLabel);
      lines.push('· ' + x.id + ' 效果：' + x.effect + '（' + x.evidence + (d ? '，' + d : '') + '）');
    }
    if (res.skipped.length) lines.push('跳过 ' + res.skipped.length + ' 条：' + res.skipped.map(x => x.draft + '——' + x.reason).join('；'));
    return lines.join('\n');
  }
  if (sub === 'approve' || sub === 'apply') {
    if (!id) return '用法：/evolve approve <提案 id> [灰度%]';
    // v7.41.0 按提案灰度：/evolve approve <id> 50 表示该提案先对 50%
    // 会话生效；不指定默认 100 全量。非法比例直接拒绝，不静默夹取。
    const pctArg = a[2] ? String(a[2]).trim() : '';
    let pct;
    if (pctArg) {
      const n = Number(pctArg);
      if (!Number.isInteger(n) || n < 1 || n > 100) {
        return '灰度比例需为 1~100 的整数，例如 /evolve approve ' + id + ' 50';
      }
      pct = n;
    }
    const res = await applyEvolveProposal(env, id, actor, pct);
    if (!res.ok) return '应用失败：' + res.error;
    const grayNote = res.proposal.rolloutPercent < 100
      ? '\n灰度 ' + res.proposal.rolloutPercent + '%：约该比例的会话先生效，其余会话仍走原配置；'
        + '同一会话对该提案永远同一组，状态里可对比两组暂停率。'
      : '';
    return '✅ 已应用：' + res.proposal.title + grayNote
      + '\n下一轮对话起生效；随时可用 /evolve rollback ' + res.proposal.id + ' 回滚。'
      + (res.conflictWarning ? '\n' + res.conflictWarning : '');
  }
  // v7.34.0 批量审批：一次应用全部低风险待审批提案，逐条过校验与模拟，
  // LLM 复核否决的跳过；review 类与草稿不在范围内，高风险提案不动。
  // v7.39.0 dry-run 预览：/evolve approve-low preview 只算不改，列出可应用
  // 与跳过的提案及原因，确认后发 /evolve approve-low 才真正应用。
  if (sub === 'approve-low') {
    if (String(a[1] || '').toLowerCase() === 'preview') {
      const pv = await previewLowRiskEvolveProposals(env);
      if (!pv.total) return '没有待审批的低风险提案。';
      const lines = ['🔍 批量审批预览（只读，未应用任何提案）：可应用 ' + pv.appliable.length + ' 条，跳过 ' + pv.skipped.length + ' 条'];
      for (const a of pv.appliable) {
        lines.push('· 可应用：' + a.id + ' ' + a.title);
        lines.push('  模拟：' + a.sim.verdict + '（' + (a.sim.detail || '') + '）｜复核：' + (a.review || '无复核记录'));
        if (a.conflicts && a.conflicts.length) lines.push('  ⚠️ 冲突：与 ' + a.conflicts.join('、') + ' 同槽位不同值，应用后请复核冲突提案');
      }
      for (const s of pv.skipped) {
        lines.push('· 跳过：' + s.id + ' ' + s.title + '（' + s.reason + '）');
      }
      lines.push('⚠️ 预览结论只作参考，不作承诺：确认前若词表或提案有变，真正应用时仍会逐条重新过校验/模拟/复核否决检查，结果可能与预览不同。');
      lines.push('确认应用请发：/evolve approve-low');
      return lines.join('\n');
    }
    const res = await applyLowRiskEvolveProposals(env, actor);
    if (!res.ok) return '批量应用失败：' + res.error;
    if (!res.total) return '没有待审批的低风险提案。';
    const lines = ['🧬 批量应用低风险提案：已应用 ' + res.applied.length + ' 条，跳过 ' + res.skipped.length + ' 条'];
    for (const a of res.applied) {
      lines.push('· 已应用：' + a.id + ' ' + a.title
        + (a.conflicts && a.conflicts.length ? '（⚠️ 与 ' + a.conflicts.join('、') + ' 冲突，已应用，请复核冲突提案）' : ''));
    }
    for (const s of res.skipped) {
      lines.push('· 跳过：' + s.id + ' ' + s.title + '（' + s.reason + '）');
    }
    lines.push('每条操作已记入审计（见 /evolve 状态里的「最近审计」）。');
    return lines.join('\n');
  }
  if (sub === 'reject') {
    if (!id) return '用法：/evolve reject <提案 id>';
    const res = await decideEvolveProposal(env, id, 'rejected', actor);
    if (!res.ok) return '否决失败：' + res.error;
    return '已否决：' + res.proposal.title + '（14 天内不再重复提同类提案）';
  }
  if (sub === 'rollback') {
    if (!id) return '用法：/evolve rollback <提案 id> [原因]';
    // id 后面跟的词都是回滚原因（可空），只记管理员手写的一小段文字。
    const reason = a.slice(2).join(' ');
    const res = await decideEvolveProposal(env, id, 'rolled_back', actor, reason);
    if (!res.ok) return '回滚失败：' + res.error;
    return '已回滚：' + res.proposal.title + '（下一轮对话起恢复原配置；30 天内同一改动不再重复提）'
      + (res.proposal.rolledBackReason ? '\n回滚原因：' + res.proposal.rolledBackReason : '');
  }
  if (sub === 'kb-draft') {
    if (!id) return '用法：/evolve kb-draft <草稿 id>\n（草稿见 /evolve list，从最近 12 轮对话整理成文档入库）';
    const res = await confirmKbDraft(env, id, opts);
    if (!res.ok) return '确认建档失败：' + res.error;
    return '📚 已为「' + res.draft.topic + '」建档：《' + (res.kb.title || res.draft.topic) + '》\n'
      + '────────────\n' + (res.kb.organizedSummary || '（无摘要）') + '\n────────────\n✅ ' + (res.kb.saveResult || '');
  }
  if (sub !== 'status' && sub !== 'list' && sub !== 'run' && sub !== 'approve' && sub !== 'apply'
    && sub !== 'approve-low' && sub !== 'reject' && sub !== 'rollback' && sub !== 'review' && sub !== 'kb-draft') {
    return '🧬 /evolve 用法：\n/evolve —— 状态总览\n/evolve list —— 待审批提案（末尾附已回滚提案与回滚原因）\n/evolve run —— 手动跑一次进化周期\n/evolve approve <id> [灰度%] —— 应用提案（灰度% 可选，1~100，如 50 表示先对 50% 会话生效，不指定默认全量；灰度仍需审批，只是生效范围）\n/evolve approve-low —— 一次应用全部低风险待审批提案（逐条过校验与模拟，LLM 复核否决的跳过；review 类与草稿、高风险提案不在范围内）\n/evolve approve-low preview —— 先预览再决定（只读：列出可应用与跳过的提案及原因，不改状态、不记审计；确认后发 /evolve approve-low 才真正应用，应用时逐条重新检查）\n/evolve reject <id> —— 否决提案\n/evolve rollback <id> [原因] —— 回滚已应用提案，原因可空（限 100 字）\n/evolve review <id> —— 请模型复核一条提案（第二意见）\n/evolve kb <主题> —— 从最近对话整理建档（仅 Telegram，需要对话记录）\n/evolve kb-draft <id> —— 确认 KB 草稿并从最近对话建档（草稿见 /evolve list）';
  }
  if (sub === 'review') {
    if (!id) return '用法：/evolve review <提案 id>';
    const doc = await loadEvolveProposals(env);
    const items = Array.isArray(doc.items) ? doc.items : [];
    const p = items.find(x => x && x.id === id);
    if (!p) return '找不到提案：' + id;
    const res = await reviewEvolveProposalWithLLM(env, p);
    if (!res.ok) return 'LLM 复核失败：' + res.error + '（提案保持待审批，可稍后重试）';
    p.llmReview = { at: res.at, text: res.text, verdict: res.verdict, model: res.model };
    await saveEvolveProposals(env, { v: 1, items, audit: doc.audit });
    return '🧬 LLM 复核：' + p.title + '\n结论：' + res.verdict + '\n' + res.text;
  }
  return evolveStatusText(env);
}

// KB 缺失主题一键建档（/evolve kb <主题>，仅 Telegram）：
// 把最近 12 轮对话交给已有的自动整理入库（autoOrganizeAndSaveKbDoc），
// 按主题建档。内容来自真实对话、经模型整理，仍走入库的去重与指纹关卡；
// 建档本身不等同于「提案已解决」，缺失清单提案仍由管理员自行关闭。
async function evolveKbDoc(env, chatId, modelId, topic, history) {
  const t = String(topic || '').trim();
  if (t.length < 2 || t.length > 30) return { ok: false, error: '主题需为 2~30 字' };
  const hist = Array.isArray(history) ? history : [];
  if (!hist.length) return { ok: false, error: '当前会话还没有可整理的对话内容，先聊几句再建档' };
  const recentTurns = hist.slice(-12)
    .map(m => (m.role === 'assistant' ? 'AI' : '用户') + '：' + (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n\n');
  try {
    const res = await autoOrganizeAndSaveKbDoc(env, chatId, modelId, t, recentTurns, 'evolve_kb_missing');
    return res;
  } catch (e) {
    return { ok: false, error: '建档失败：' + (e && e.message ? e.message : String(e)) };
  }
}

// KB 草稿确认建档（/evolve kb-draft <id>，v7.31.0，Telegram 与微信共用）：
// 草稿本身不入库，只有管理员确认后才调已有的 evolveKbDoc 整理建档。
// 找不到 / 已过期 / 已建档时报错；当前会话没有可整理的对话内容时
// 报错、不建空文档（草稿保持 draft）；建档失败时草稿同样保持 draft。
// 建档成功后草稿状态改为 archived，并记 archivedAt。
// opts：{ history, modelId, chatId }，由各通道在调用 handleEvolveCommand
// 时传入（Telegram 取 tgGetHistory，微信按 /savekb 的取法拿 history）。
async function confirmKbDraft(env, id, opts) {
  const o = opts || {};
  const doc = await loadEvolveProposals(env);
  const items = Array.isArray(doc.items) ? doc.items : [];
  const d = items.find(x => x && x.kind === 'kb-draft' && x.id === String(id));
  if (!d) return { ok: false, error: '找不到草稿：' + id };
  if (d.status === 'archived') return { ok: false, error: '该草稿已建档，无需重复确认' };
  if (d.status === 'expired' || isKbDraftExpired(d, Date.now())) {
    // 直接点过期的草稿：顺手标为 expired，免得它一直占着 draft 状态。
    if (d.status === 'draft') {
      d.status = 'expired';
      await saveEvolveProposals(env, { v: 1, items, audit: doc.audit });
    }
    return { ok: false, error: '该草稿已过期（30 天有效期），请等下个进化周期重新生成' };
  }
  if (d.status !== 'draft') return { ok: false, error: '该草稿当前状态为 ' + d.status + '，无法建档' };
  const hist = Array.isArray(o.history) ? o.history : [];
  if (!hist.length) return { ok: false, error: '当前会话还没有可整理的对话内容，先聊几句再建档' };
  const res = await evolveKbDoc(env, o.chatId, o.modelId, d.topic, hist);
  if (!res.ok) return { ok: false, error: res.error || res.saveResult || '建档失败' };
  d.status = 'archived';
  d.archivedAt = Date.now();
  await saveEvolveProposals(env, { v: 1, items, audit: doc.audit });
  return { ok: true, draft: d, kb: res };
}

// Cron 入口：每天只跑一次（按 UTC 日期去重），其余分钟直接跳过。
// 用 state 文件做认领：先 CAS 写 lastCycleDay，写赢的 isolate 才跑，
// 写输/写失败的直接跳过——绝不因为进化周期拖住微信轮询。
// 每日通知的变动条目：新提案 / 回滚 / 变差 / 快过期提醒。
// 定时周期的每日通知与周报附「当日变动」共用同一份，避免两处各写一套
// 慢慢走样（v7.43.0 的提醒行也走这里）。提醒行写清 id、标题、已等待
// 天数与还剩几天过期，管理员不用点开 list 也能直接审批。
function appendEvolveDailyChangeLines(lines, res) {
  for (const p of (res.created || [])) lines.push('· 新提案：' + p.title);
  for (const p of (res.rolledBack || [])) lines.push('· 已自动回滚（效果变差）：' + p.title);
  for (const p of (res.worse || [])) {
    if (!(res.rolledBack || []).some(r => r.id === p.id)) {
      const d = formatEffectDelta(p.deltaPp, p.deltaLabel);
      lines.push('· 效果变差，请复核：' + p.title + '（' + p.evidence + (d ? '，' + d : '') + '）');
    }
  }
  for (const r of (res.expiryReminders || [])) {
    lines.push('· 即将过期：' + r.title + '（' + r.id + '，已等待 ' + r.waitedDays + ' 天'
      + (r.daysLeft > 0 ? '，还剩 ' + r.daysLeft + ' 天过期' : '，今天过期') + '）');
  }
}

async function runEvolveScheduled(env, ctx, now) {
  if (!evolveEnabled(env)) return { ok: false, reason: 'disabled' };
  const ts = now || Date.now();
  const today = evolveDayKey(new Date(ts));
  try {
    const state = await loadEvolveState(env);
    if (state && state.lastCycleDay === today) return { ok: false, reason: 'already-done-today' };
    const claimed = await saveEvolveState(env, { lastCycleAt: ts, lastCycleDay: today });
    if (!claimed) return { ok: false, reason: 'claim-failed' };
  } catch (e) {
    return { ok: false, reason: 'state-error' };
  }
  const task = (async () => {
    const res = await runEvolveCycle(env, { now: ts }).catch(() => null);
    try {
      // 每日通知的条件：有新提案 / 有回滚 / 有变差 / 有快过期提醒。
      // v7.43.0：只有快过期提醒时也发一次（提醒本身就是给管理员看的）；
      // 什么都没有时不发，不打扰。
      const hasDaily = !!(res && res.ok
        && ((res.created || []).length || (res.rolledBack || []).length || (res.worse || []).length
          || (res.expiryReminders || []).length));
      const dailyLines = [];
      if (hasDaily) {
        dailyLines.push('🧬 自我进化周期完成（近 7 天 ' + res.windowTotal + ' 轮）：');
        appendEvolveDailyChangeLines(dailyLines, res);
        dailyLines.push('在 Telegram 发 /evolve list 查看并审批。');
      }
      // v7.29.0 周期周报：周一才算，EVO_WEEKLY=0 只关周报。
      // 周一当天若每日通知与周报都满足，把当日变动附在同一条周报里
      // 只发一次，不发两条；周报已在本周发过时，每日通知仍单独发。
      // v7.40.0 失败补发：周一发送失败（无 TG 凭证、EVO_NOTIFY=0、网络失败）
      // 时记下失败状态（窗口起止一起存），第二天（周二）的定时周期重试
      // 一次——复用失败那次存下的窗口（weeklyFailAt），不用补发当天的
      // 窗口重算；成功后写去重标记并清掉失败记录，失败两次后不再重试。
      // 跨到下周一时失败记录的 weekKey 与新一周不同，不再补发旧周报，
      // 按新一周的正常流程走。手动 /evolve run 不走 runEvolveScheduled，
      // 不触发补发。发送失败本身不影响周期（上面已跑完）与微信轮询。
      let weekly = null;
      let weeklyIsRetry = false;
      if (isWeeklyEvolveDay(ts) && evolveWeeklyEnabled(env)) {
        try {
          weekly = await buildEvolveWeeklyReport(env, ts);
        } catch (e) {
          weekly = null;
        }
      } else if (evolveWeeklyEnabled(env)) {
        // 非周一：本周一的周报若发送失败过且只失败过一次，今天重试一次。
        try {
          const state = await loadEvolveState(env);
          const fail = normalizeWeeklyFailure(state);
          if (fail && fail.weekKey === evolveWeekKey(ts) && fail.attempts < 2) {
            const retry = await buildEvolveWeeklyReport(env, fail.failAt);
            if (retry && retry.hasContent) {
              weekly = retry;
              weeklyIsRetry = true;
            } else {
              // 失败那次有内容、补发时已无内容（如数据被清理）：没什么可发，
              // 清掉失败记录，免得之后每天都来重算一次。
              weekly = null;
              try {
                await saveEvolveState(env, {
                  weeklyFailWeek: null, weeklyFailWeekStart: null, weeklyFailWeekEnd: null,
                  weeklyFailAt: 0, weeklyFailAttempts: 0,
                });
              } catch (e) {}
            }
          }
        } catch (e) {
          weekly = null;
        }
      }
      if (weekly && weekly.hasContent) {
        let alreadySent = false;
        try {
          const state = await loadEvolveState(env);
          alreadySent = !!(state && state.lastWeeklyWeek === weekly.weekKey);
        } catch (e) {
          alreadySent = false;
        }
        if (!alreadySent) {
          const lines = [weekly.text];
          if (hasDaily) {
            // 每日通知的标题行与周报标题重复，只附当日变动的条目。
            lines.push('', '当日变动：');
            appendEvolveDailyChangeLines(lines, res);
          }
          const sent = await notifyEvolveAdmin(env, lines.join('\n'));
          if (sent) {
            try {
              // 成功后写去重标记，同一周不再重复发；同时清掉失败记录。
              await saveEvolveState(env, {
                lastWeeklyWeek: weekly.weekKey, lastWeeklyAt: ts,
                weeklyFailWeek: null, weeklyFailWeekStart: null, weeklyFailWeekEnd: null,
                weeklyFailAt: 0, weeklyFailAttempts: 0,
              });
            } catch (e) {}
          } else if (weeklyIsRetry) {
            // 补发也失败：失败两次，不再重试，等下周一正常发。
            try {
              await saveEvolveState(env, { weeklyFailAttempts: 2 });
            } catch (e) {}
          } else {
            // 周一发送失败：记下失败状态（窗口起止一起存），第二天重试一次；
            // 仍不写成功去重标记。
            try {
              await saveEvolveState(env, {
                weeklyFailWeek: weekly.weekKey,
                weeklyFailWeekStart: weekly.weekStart,
                weeklyFailWeekEnd: weekly.weekEnd,
                weeklyFailAt: ts,
                weeklyFailAttempts: 1,
              });
            } catch (e) {}
          }
        } else if (hasDaily) {
          await notifyEvolveAdmin(env, dailyLines.join('\n'));
        }
      } else if (hasDaily) {
        await notifyEvolveAdmin(env, dailyLines.join('\n'));
      }
    } catch (e) {}
    return res;
  })();
  if (ctx && typeof ctx.waitUntil === 'function') {
    try { ctx.waitUntil(task); } catch (e) {}
    return { ok: true, reason: 'scheduled' };
  }
  await task;
  return { ok: true, reason: 'done' };
}

// 仅供单测：清掉模块级 buffer，避免跨用例串味
// （生产上 buffer 属于当前 isolate，周期开始时 flush 进 R2 是对的；
// 单测里多个用例共享同一模块，前一个用例录进 buffer 的事件会被
// 下一个用例的周期 flush 进它的 R2，污染窗口——纠正率 3/20=15% 刚好
// 够门槛，多 1 轮就变成 3/21=14.3% 不够了。）
function __resetEvolveBuffer() {
  if (evolveBuffer && evolveBuffer.days) evolveBuffer.days.clear();
  if (evolveBuffer) evolveBuffer.events = 0;
}

export {
  __resetEvolveBuffer,
  evolveBuffer,
  evolveEnabled,
  evolveAutoApply,
  evolveAutoApplyLevel,
  evolveAutoRollback,
  evolveWeeklyEnabled,
  normalizeWeeklyFailure,
  isWeeklyEvolveDay,
  evolveWeekKey,
  evolveWeekStartTs,
  buildEvolveWeeklyReport,
  notifyEvolveAdmin,
  evolveKbDoc,
  confirmKbDraft,
  isEvolveAdmin,
  evolveFlushThreshold,
  recordEvolveRound,
  runEvolveCycle,
  applyEvolveProposal,
  applyLowRiskEvolveProposals,
  previewLowRiskEvolveProposals,
  assessEvolveProposalForApply,
  decideEvolveProposal,
  evolveStatusText,
  handleEvolveCommand,
  runEvolveScheduled,
  loadRecentDays,
  evolveBaselineFor,
  evolveEffectFor,
  formatEffectDelta,
  evolveTwoWeekCompare,
  evolveRecentEffects,
};
