// 自我进化 · 提案校验与应用（v7.22.0；v7.26.0 加提案冲突检测）
//
// 安全边界——提案能改的只有「配置层」，永远改不了代码：
//   允许：人格关键词（+1 个词）、人格步数/上下文预算、全局工具限流、
//         人格提示词附言（≤200 字，纯文本）、人工复核类 review 提案。
//   禁止：任何代码、正则、URL、密钥、SSRF/权限/白名单放宽、
//         删除/覆盖记忆与知识库、改写铁律与真实性约束。
// 每条提案都是单原子 change；overlay 由「已应用提案」折叠推导，
// 回滚 = 把提案标为 rolled_back 后重新折叠，不留手改漂移。
// 校验是纯函数，可单测；应用前还会再校验一次（防 R2 里被手改的脏提案）。
//
// 冲突检测（v7.26.0）：只判「同槽位不同值」——同一改动槽位被两个
// 提案提了不同的值。槽位按改动类型拆到最小可共存维度：
//   关键词：personaId + 词（小写归一），值 = strength（strong/weak）；
//     同词同 strength 不冲突，同词不同 strength 才冲突；
//   预算：personaId + 字段（maxSteps / ctxBudget 各自一槽），
//     只改步数 vs 只改上下文预算可共存；
//   工具限流：字段名一槽（toolTimeoutMs / toolConcurrency / wrapReserveMs），
//     全局改动、无人格维度；
//   附言：personaId 一槽，值 = 附言文本全文；
//   review 类（change 为 null）没有槽位，永不冲突。
// 不同 kind、不同人格、不同字段、不同词之间都不冲突。冲突只是提示，
// 不阻塞审批/应用/否决；应用时若有未解决冲突，返回里附 conflictWarning。

import { evolveProposalCohort } from './metrics.js';

const PROMPT_BLOCKLIST = [
  'ignore', 'system', '忽略', '无视', '覆盖铁律', '绕过', '越权', '假装',
  '编造', '删除记忆', '删除文档', '泄露', '密钥', 'password', 'token',
];

// ---------- 回滚原因（v7.28.0，纯函数） ----------
//
// 回滚原因只记管理员手写的一小段文字（限 100 字，超长截断），
// 永不记聊天内容；自动回滚的原因写明触发依据（效果回测判 worse）。
// 旧提案文件里没有 rolledBackReason / rolledBackAt 字段时读出来是
// undefined，各处读取都按「缺失」处理，不报错（去重回退到 createdAt）。
const EVO_ROLLBACK_REASON_MAX = 100;

function normalizeRollbackReason(reason) {
  return String(reason || '').trim().slice(0, EVO_ROLLBACK_REASON_MAX);
}

// ---------- 审计记录（v7.34.0，纯函数） ----------
//
// 每次审批/否决/回滚操作（单条、批量、自动应用、自动回滚）都在提案文件
// 顶层 audit 数组里追加一条记录，只记操作元数据，永不记提问/回答原文：
//   { at, actor, action, id, result, reason? }
//   action：approve / reject / rollback / auto-apply / auto-rollback
//   result：ok / skipped / failed；reason 只在非 ok 时写（限 200 字）。
// 数组有界：只留最近 200 条，超了丢最旧的。老数据没有 audit 字段时
// 读作空数组，不报错。
const EVO_AUDIT_MAX = 200;
const EVO_AUDIT_REASON_MAX = 200;

function normalizeEvolveAudit(audit) {
  if (!Array.isArray(audit)) return [];
  return audit
    .filter(e => e && typeof e === 'object' && typeof e.id === 'string' && e.id)
    .map(e => {
      const entry = {
        at: Number(e.at) || 0,
        actor: String(e.actor || ''),
        action: String(e.action || ''),
        id: String(e.id),
        result: String(e.result || ''),
      };
      if (e.reason) entry.reason = String(e.reason).slice(0, EVO_AUDIT_REASON_MAX);
      return entry;
    })
    .slice(-EVO_AUDIT_MAX);
}

function newEvolveAuditEntry(input) {
  const o = input || {};
  const entry = {
    at: Number(o.at) || Date.now(),
    actor: String(o.actor || ''),
    action: String(o.action || ''),
    id: String(o.id || ''),
    result: String(o.result || 'ok'),
  };
  // reason 只在非 ok 时写（失败或跳过的原因，限 200 字）。
  if (entry.result !== 'ok' && o.reason) {
    entry.reason = String(o.reason).slice(0, EVO_AUDIT_REASON_MAX);
  }
  return entry;
}

// 追加一条审计并截到最近 200 条（返回新数组，不改原数组）。
function appendEvolveAudit(audit, entry) {
  const list = normalizeEvolveAudit(audit);
  list.push(newEvolveAuditEntry(entry));
  return list.slice(-EVO_AUDIT_MAX);
}

// 改动内容本身的去重键：只看 change，不看规则——同一改动被回滚后，
// 换个规则再提同一改动也算重复（v7.28.0 回滚去重口径）。
function evolveChangeKey(change) {
  return JSON.stringify(change || null);
}

function djb2Hex(s) {
  let h = 5381;
  const t = String(s || '');
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

// v7.33.0：scope 是 review 类提案的第三维身份——change 为 null 的提案
//   只靠「规则+改动」区分不开（R12 同一周期两个组合会算成同一条 id）。
//   有 scope 时把它追加进哈希输入；没 scope 时输入与原来一字不差，老提案
//   的 id 不变（已存提案的 id 是创建时算好写死的，函数本身不改旧值）。
function proposalIdFor(rule, change, scope) {
  const target = change && change.personaId
    ? change.personaId
    : (change && change.tool ? 'tool' : 'review');
  const extra = scope ? '|' + String(scope) : '';
  return 'evo-' + djb2Hex(rule + '|' + target + '|' + JSON.stringify(change || null) + extra).slice(0, 10);
}

function isPersonaId(id, personas) {
  const list = Array.isArray(personas) ? personas : [];
  return list.some(p => p && p.id === String(id));
}

function personaByIdFrom(list, id) {
  return (Array.isArray(list) ? list : []).find(p => p && p.id === String(id)) || null;
}

function validWord(word) {
  const w = String(word || '');
  if (w.length < 2 || w.length > 12) return '关键词长度需为 2~12 字符';
  if (!/^[A-Za-z0-9\u4e00-\u9fa5_+#.-]+$/.test(w)) return '关键词只能含中英文、数字与 _+#.-';
  if (/^(http|www\.|ftp)/i.test(w)) return '关键词不能是链接';
  return '';
}

// change 为 null 时表示 review 类提案（只诊断、不改配置）。
function validateEvolveChange(change, personas) {
  if (change === null || change === undefined) return { ok: true };
  if (!change || typeof change !== 'object' || Array.isArray(change)) {
    return { ok: false, error: '提案 change 必须是对象或 null' };
  }
  const kind = change.kind;
  if (kind === 'persona_keyword_add') {
    if (!isPersonaId(change.personaId, personas)) return { ok: false, error: '未知人格：' + change.personaId };
    if (String(change.personaId) === 'general') return { ok: false, error: '通用人格不加关键词' };
    if (change.strength !== 'strong' && change.strength !== 'weak') return { ok: false, error: 'strength 只能是 strong/weak' };
    const err = validWord(change.word);
    if (err) return { ok: false, error: err };
    const p = personaByIdFrom(personas, change.personaId);
    const lower = String(change.word).toLowerCase();
    const already = [...(p.strong || []), ...(p.weak || [])].some(w => String(w).toLowerCase() === lower);
    if (already) return { ok: false, error: '该词已在词表里' };
    return { ok: true };
  }
  if (kind === 'persona_budget') {
    if (!isPersonaId(change.personaId, personas)) return { ok: false, error: '未知人格：' + change.personaId };
    if (change.maxSteps !== undefined) {
      const v = Number(change.maxSteps);
      if (!Number.isInteger(v) || v < 1 || v > 12) return { ok: false, error: 'maxSteps 需为 1~12 的整数' };
    }
    if (change.ctxBudget !== undefined) {
      const v = Number(change.ctxBudget);
      if (!Number.isInteger(v) || v < 6000 || v > 40000) return { ok: false, error: 'ctxBudget 需为 6000~40000 的整数' };
    }
    if (change.maxSteps === undefined && change.ctxBudget === undefined) {
      return { ok: false, error: 'persona_budget 至少改一项' };
    }
    return { ok: true };
  }
  if (kind === 'tool_limit') {
    const bounds = { toolTimeoutMs: [1000, 120000], toolConcurrency: [1, 8], wrapReserveMs: [1500, 30000] };
    let any = false;
    for (const [k, [lo, hi]] of Object.entries(bounds)) {
      if (change[k] === undefined) continue;
      any = true;
      const v = Number(change[k]);
      if (!Number.isInteger(v) || v < lo || v > hi) return { ok: false, error: k + ' 需为 ' + lo + '~' + hi + ' 的整数' };
    }
    if (!any) return { ok: false, error: 'tool_limit 至少改一项' };
    return { ok: true };
  }
  if (kind === 'prompt_addendum') {
    if (!isPersonaId(change.personaId, personas)) return { ok: false, error: '未知人格：' + change.personaId };
    const text = String(change.text || '');
    if (text.length < 10 || text.length > 200) return { ok: false, error: '附言需为 10~200 字' };
    const low = text.toLowerCase();
    for (const bad of PROMPT_BLOCKLIST) {
      if (low.includes(bad.toLowerCase())) return { ok: false, error: '附言含禁用词：' + bad };
    }
    if (/https?:\/\//i.test(text)) return { ok: false, error: '附言不能含链接' };
    return { ok: true };
  }
  if (kind === 'review') {
    return { ok: false, error: 'review 提案的 change 应为 null，而不是 kind=review 的 change' };
  }
  return { ok: false, error: '未知提案类型：' + kind };
}

function emptyEvolveOverlay() {
  return {
    v: 1,
    personaKeywords: {},
    personaBudgets: {},
    promptAddenda: {},
    toolLimits: {},
  };
}

// ---------- 按提案灰度（v7.41.0，纯函数） ----------
//
// 提案可按会话灰度生效：应用时指定 rolloutPercent（1~100，默认 100 全量），
// 同一提案在部分会话生效、其余会话走原配置。灰度比例只在应用时定一次，
// 存在提案对象上（proposals.json 同一份文件，不新增 R2 key）；
// 缺字段的旧提案按 100 处理（向后兼容）。
// 归一读法：整数 1~100 原样返回，其余（缺失、非法、越界）一律按 100。
function normalizeRolloutPercent(percent) {
  const n = Number(percent);
  if (!Number.isInteger(n) || n < 1 || n > 100) return 100;
  return n;
}

// 本轮该会话落在哪几条灰度提案的生效组 / 未生效组（loop.js 每轮算一次，
// 记进观测事件的 proposalRollout，指标层按提案分组计数）。
// 只含灰度中的提案（rolloutPercent < 100）：全量提案在/不在没有区别，
// 不记；非 applied / 无 id 的提案不参与。globalIn=false（全局对照组）时
// 所有灰度提案都算未生效——对照组本来就不走任何 overlay。
// 返回 { in: [生效组提案 id], out: [未生效组提案 id] }。
function evolveProposalRolloutGroups(appliedProposals, chatId, globalIn) {
  const groups = { in: [], out: [] };
  const list = (Array.isArray(appliedProposals) ? appliedProposals : [])
    .filter(p => p && p.status === 'applied' && p.kind !== 'kb-draft' && p.change && p.id);
  for (const p of list) {
    const pct = normalizeRolloutPercent(p.rolloutPercent);
    if (pct >= 100) continue;
    const side = (globalIn && evolveProposalCohort(chatId, p.id, pct) === 'in') ? 'in' : 'out';
    groups[side].push(String(p.id));
  }
  return groups;
}

// 已应用提案（按 appliedAt 升序）折叠成 overlay；后应用的同目标覆盖先应用的。
// v7.31.0：KB 草稿（kind='kb-draft'）永不进 overlay——草稿没有 change、
// 也永远不会是 applied 状态；这里再显式排除 kind，多一道防线。
// v7.32.0 弱词升级：同一词既有弱词提案、又有后应用的强词提案时，
// 强词覆盖弱词——强词进 strong 的同时把 weak 里的同一词（大小写归一）
// 删掉；反过来弱词也不得把已在 strong 里的词再写回 weak。同一词在
// overlay 里永远只有一条生效记录，不会出现既弱又强。
// 原弱词提案的状态如何处理（决定，写在这里与文档里）：原弱词提案
// 保持 applied 不变，不改成 rolled_back——回滚历史只记「管理员/系统
// 主动回滚了某条提案」，升级不是回滚；把原提案改成 rolled_back 会
// 误导回滚历史（还会触发 30 天回滚去重，把升级本身也挡掉）。覆盖
// 只发生在 overlay 折叠这一层，提案状态不动。
// v7.41.0：第二参数 chatId 可选——传了就按提案分别判断该会话是否在
// 该提案的灰度内（rolloutPercent < 100 且分组为 out 的提案不进 overlay）；
// 不传（沙盒模拟、旧调用）时所有已应用提案都进 overlay，与原来一字不差。
// 灰度字段缺失的旧提案按 100 处理；无 id 的提案（模拟用的临时对象）
// 没法分组，按 100 处理。
function buildEvolveOverlay(appliedProposals, chatId) {
  const overlay = emptyEvolveOverlay();
  const list = (Array.isArray(appliedProposals) ? appliedProposals : [])
    .filter(p => p && p.status === 'applied' && p.kind !== 'kb-draft' && p.change)
    .sort((a, b) => (a.appliedAt || 0) - (b.appliedAt || 0));
  const inRollout = typeof chatId === 'string' && chatId.length > 0;
  for (const p of list) {
    if (inRollout) {
      const pct = normalizeRolloutPercent(p.rolloutPercent);
      if (pct < 100 && p.id && evolveProposalCohort(chatId, p.id, pct) === 'out') continue;
    }
    const c = p.change;
    if (!c || typeof c !== 'object') continue;
    if (c.kind === 'persona_keyword_add') {
      const slot = overlay.personaKeywords[c.personaId]
        || (overlay.personaKeywords[c.personaId] = { strong: [], weak: [] });
      const lower = String(c.word || '').toLowerCase();
      const inStrong = slot.strong.some(w => String(w).toLowerCase() === lower);
      const inWeak = slot.weak.some(w => String(w).toLowerCase() === lower);
      if (c.strength === 'strong') {
        // v7.32.0：强词覆盖弱词——同一词只留强词一条生效记录。
        if (inWeak) slot.weak = slot.weak.filter(w => String(w).toLowerCase() !== lower);
        if (!inStrong && slot.strong.length < 5) slot.strong.push(c.word);
      } else {
        // 弱词不覆盖强词：该词已是强词时，弱词条目直接丢弃。
        if (!inStrong && !inWeak && slot.weak.length < 5) slot.weak.push(c.word);
      }
    } else if (c.kind === 'persona_budget') {
      const slot = overlay.personaBudgets[c.personaId] || (overlay.personaBudgets[c.personaId] = {});
      if (c.maxSteps !== undefined) slot.maxSteps = c.maxSteps;
      if (c.ctxBudget !== undefined) slot.ctxBudget = c.ctxBudget;
    } else if (c.kind === 'tool_limit') {
      for (const k of ['toolTimeoutMs', 'toolConcurrency', 'wrapReserveMs']) {
        if (c[k] !== undefined) overlay.toolLimits[k] = c[k];
      }
    } else if (c.kind === 'prompt_addendum') {
      overlay.promptAddenda[c.personaId] = String(c.text || '').slice(0, 200);
    }
  }
  return overlay;
}

// v7.32.0：已应用的弱关键词表——R1c（弱词升级）的证据来源。
// 口径：status=applied 且 change 为弱关键词的提案；overlay 本身由
// 已应用提案折叠，所以「已应用提案里的弱词」与「overlay 生效中的
// 弱词」是同一来源，不用另读一份。pending 的弱词不算：还没生效，
// 攒信号要等它应用之后再说。
// 返回 'personaId:word小写' 的数组，供 analyzeEvolveDays 的
// opts.weakKeywords 用。
function appliedWeakKeywords(items) {
  const out = [];
  for (const p of Array.isArray(items) ? items : []) {
    if (!p || p.status !== 'applied' || !p.change || typeof p.change !== 'object') continue;
    if (p.change.kind !== 'persona_keyword_add' || p.change.strength !== 'weak') continue;
    if (!p.change.personaId || !p.change.word) continue;
    out.push(String(p.change.personaId) + ':' + String(p.change.word).toLowerCase());
  }
  return out;
}

// ---------- 影响分构成说明（v7.42.0，纯函数） ----------
//
// scoreDetail 是分数的构成说明，随提案一起存：
//   { evidence, first, second, trendFactor, trendNote? }
//   evidence：证据分（证据量）；first/second：该证据在窗口前段/
//   后段的次数（窗口按日期对半分，近 7 天是前 3 天 vs 后 4 天）；
//   trendFactor：趋势因子（0.8~1.2）；trendNote：分段不适用时的原因
//   （如 R10 灰度对照是窗口整体对比）。
// 旧提案（v7.42.0 之前生成）没有 scoreDetail：读到时按旧分处理，
// 不按当前窗口重算——提案只存了证据文本，没有存证据键，重算认不出
// 是哪条证据；排序直接用 score 本身，缺字段时按 0，不会出现 NaN。
// 归一读法：证据与因子必须是有限数，因子夹到 [0.8, 1.2]；
// first/second 只认有限数，否则记 null（趋势未知）；非法输入返回 null。
function normalizeEvolveScoreDetail(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const evidence = Number(detail.evidence);
  const factor = Number(detail.trendFactor);
  if (!Number.isFinite(evidence) || !Number.isFinite(factor)) return null;
  const first = Number(detail.first);
  const second = Number(detail.second);
  const out = {
    evidence,
    first: Number.isFinite(first) ? first : null,
    second: Number.isFinite(second) ? second : null,
    trendFactor: Math.min(1.2, Math.max(0.8, Math.round(factor * 100) / 100)),
  };
  if (typeof detail.trendNote === 'string' && detail.trendNote.trim()) {
    out.trendNote = detail.trendNote.trim().slice(0, 100);
  }
  return out;
}

// 一行可读的分数构成说明，供 list 与详情展示，管理员看得出为什么
// 排这个位置。旧提案（无 scoreDetail）写明是旧分，未含趋势加权。
function formatEvolveScoreDetail(p) {
  if (!p || typeof p !== 'object') return '';
  const score = Number(p.score) || 0;
  const d = normalizeEvolveScoreDetail(p.scoreDetail);
  if (!d) return '影响分：' + score + ' 分（旧分，v7.42.0 之前生成，未含趋势加权）';
  if (d.first === null || d.second === null) {
    const note = d.trendNote || '无分段数据，趋势未加权';
    return '影响分：' + score + ' 分（证据 ' + d.evidence + ' × 趋势 ' + d.trendFactor + '；' + note + '）';
  }
  return '影响分：' + score + ' 分（证据 ' + d.evidence + ' × 趋势 ' + d.trendFactor
    + '：前段 ' + d.first + ' 次 → 后段 ' + d.second + ' 次）';
}

function newEvolveProposal(draft, now) {
  const ts = now || Date.now();
  const id = draft.id || proposalIdFor(draft.rule || 'manual', draft.change || null, draft.scope);
  // v7.42.0：分数构成说明随提案一起存（非法时不存，读出来按旧分处理）。
  const scoreDetail = normalizeEvolveScoreDetail(draft.scoreDetail);
  return {
    id,
    rule: draft.rule || 'manual',
    kind: draft.change ? draft.change.kind : 'review',
    title: String(draft.title || '进化提案'),
    rationale: String(draft.rationale || ''),
    evidence: String(draft.evidence || ''),
    change: draft.change || null,
    // v7.32.0 弱词升级标记：只在 R1c 草稿上出现（upgradeFrom: 'weak'），
    // 存在提案对象上，不进 change——change 仍是普通的强词改动。
    // list 与状态据此展示「弱词升级」，去重据此认出这是升级而非新词。
    ...(draft.upgradeFrom === 'weak' ? { upgradeFrom: 'weak' } : {}),
    // v7.33.0 聚类口径：只在 R12 草稿上出现（scope: '人格:工具'），存在
    // 提案对象上，不进 change——change 仍是 null（review 类无改动）。
    // 去重（dedupeKey）与 id（proposalIdFor）据此区分同一规则的不同组合，
    // 否则同一周期两个组合会被当成同一条提案；下个周期去重也要靠它认出
    // 「同一组合已有待审批提案」，所以必须随提案一起存下来。
    ...(draft.scope ? { scope: String(draft.scope) } : {}),
    risk: draft.risk || 'low',
    // 影响分：规则按证据量打分（近 miss 次数、失败次数等），
    // 待审批列表按分排序，先看影响最大的。
    // v7.42.0：分数改为「证据分 × 趋势因子」（见 rules.js 的
    // calibratedScore），构成说明存在 scoreDetail 里；旧提案没有
    // 该字段，按旧分处理，排序不受影响。
    score: Number(draft.score) || 0,
    ...(scoreDetail ? { scoreDetail } : {}),
    // 冲突：与其它未解决提案（pending/applied/approved）同槽位不同值的
    // 提案 id 列表；无冲突时为空数组（始终以数组出现，保持一致）。
    // 生成时由 runEvolveCycle 填；展示/应用时动态重算，不依赖该字段。
    conflictsWith: Array.isArray(draft.conflictsWith) ? draft.conflictsWith.slice() : [],
    status: 'pending',
    createdAt: ts,
    appliedAt: 0,
    decidedBy: '',
    decidedAt: 0,
    // v7.28.0 回滚学习：回滚时记原因与回滚时间（手动回滚由管理员手写，
    // 自动回滚写触发依据）；旧记录没有这两个字段，读时按缺失处理。
    rolledBackReason: '',
    rolledBackAt: 0,
    // v7.43.0 过期提醒：提醒过一次的提案记提醒时间（0 = 没提醒过），
    // 随 proposals.json 一起存，不另起 R2 键；旧提案没有该字段按 0 处理。
    expiryRemindedAt: 0,
  };
}

// ---------- KB 缺失主题自动草稿（v7.31.0，纯函数） ----------
//
// 草稿与普通提案存在同一份 kb/evolve/proposals.json 里，用 kind 区分：
//   · 草稿是一条独立记录，没有 change（它不是配置改动），只有主题词与
//     失败次数——只记结果数字，永不存提问/回答原文；
//   · id 与提案 id 同一生成方式（djb2 哈希取前 10 位十六进制），
//     按主题稳定生成：同一主题每次算出来是同一个 id；
//   · status：draft（待确认）/ expired（30 天过期）/ archived（已建档）；
//   · 草稿本身不入库，只有管理员 /evolve kb-draft <id> 确认后才调
//     已有的 evolveKbDoc 整理建档。
// 普通提案的读取/折叠/去重逻辑必须忽略草稿：草稿不进 overlay、
// 不参与冲突检测、不参与去重计数（见下方各函数的显式排除）。
const EVO_KB_DRAFT_TTL_MS = 30 * 24 * 3600 * 1000;

function kbDraftIdFor(topic) {
  return 'evo-kb-' + djb2Hex('kb-draft|' + String(topic || '').trim()).slice(0, 10);
}

// 草稿证据：只写失败次数与窗口（近 7 天），不写提问内容。
function kbDraftEvidence(topic, fails) {
  return '近 7 天「' + String(topic || '').trim() + '」read_doc 失败 ' + (Number(fails) || 0) + ' 次（知识库里没有相关文档）';
}

function newKbDraft(input) {
  const o = input || {};
  const ts = o.now || Date.now();
  const topic = String(o.topic || '').trim();
  return {
    id: o.id || kbDraftIdFor(topic),
    kind: 'kb-draft',
    topic,
    status: 'draft',
    fails: Number(o.fails) || 0,
    evidence: kbDraftEvidence(topic, o.fails),
    createdAt: ts,
    expiresAt: ts + EVO_KB_DRAFT_TTL_MS,
    archivedAt: 0,
  };
}

// 草稿是否已过期：status 已是 expired 算过期；否则看 expiresAt
// （旧记录万一没有 expiresAt，回退到 createdAt + 30 天）。
function isKbDraftExpired(draft, now) {
  if (!draft || draft.kind !== 'kb-draft') return false;
  if (draft.status === 'expired') return true;
  const exp = draft.expiresAt || ((draft.createdAt || 0) + EVO_KB_DRAFT_TTL_MS);
  return (now || Date.now()) > exp;
}

// 未过期的 draft 状态草稿——只有这种草稿会挡住同一主题重复生成。
function isKbDraftLive(draft, now) {
  return !!draft && draft.kind === 'kb-draft' && draft.status === 'draft'
    && !isKbDraftExpired(draft, now);
}

// 往 items 里补一条主题草稿（就地改 items，返回处理结果）：
//   · 同一主题已有未过期草稿 → 不重复生成（skipped: true）；
//   · 同一主题有已过期草稿 → 原地复活（同一主题只留一条草稿记录，
//     id 稳定；状态回到 draft，创建时间与过期时间重算）；
//   · 同一主题有已建档草稿 → 新建一条，id 后缀避让（-2、-3……），
//     避免同一份文件里出现两个同 id 记录、确认时找错对象。
// 调用方负责在有新建/复活时保存 proposals.json。
function upsertKbDraft(items, topic, fails, now) {
  const list = Array.isArray(items) ? items : [];
  const t = String(topic || '').trim();
  const ts = now || Date.now();
  const live = list.find(p => isKbDraftLive(p, ts) && p.topic === t);
  if (live) return { created: null, draft: live, skipped: true, revived: false };
  const expired = list
    .filter(p => p && p.kind === 'kb-draft' && p.topic === t && p.status === 'expired')
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
  if (expired) {
    expired.status = 'draft';
    expired.fails = Number(fails) || 0;
    expired.evidence = kbDraftEvidence(t, fails);
    expired.createdAt = ts;
    expired.expiresAt = ts + EVO_KB_DRAFT_TTL_MS;
    expired.archivedAt = 0;
    return { created: expired, draft: expired, skipped: false, revived: true };
  }
  let id = kbDraftIdFor(t);
  if (list.some(p => p && p.id === id)) {
    let n = 2;
    while (list.some(p => p && p.id === id + '-' + n)) n++;
    id = id + '-' + n;
  }
  const draft = newKbDraft({ id, topic: t, fails, now: ts });
  list.push(draft);
  return { created: draft, draft, skipped: false, revived: false };
}

// ---------- 提案冲突检测（v7.26.0，纯函数） ----------

// 未解决的提案状态：只有这些状态的提案才参与冲突判定。
// rejected / rolled_back / expired 已尘埃落定，不再算冲突。
const EVO_CONFLICT_ACTIVE_STATUSES = ['pending', 'applied', 'approved'];

// 把一条 change 拆成「槽位 → 值」列表。review 类（null）无槽位。
function evolveChangeSlots(change) {
  if (!change || typeof change !== 'object' || Array.isArray(change)) return [];
  if (change.kind === 'persona_keyword_add') {
    return [{ slot: 'keyword:' + String(change.personaId) + ':' + String(change.word || '').toLowerCase(), value: change.strength }];
  }
  if (change.kind === 'persona_budget') {
    const slots = [];
    if (change.maxSteps !== undefined) slots.push({ slot: 'budget:' + String(change.personaId) + ':maxSteps', value: Number(change.maxSteps) });
    if (change.ctxBudget !== undefined) slots.push({ slot: 'budget:' + String(change.personaId) + ':ctxBudget', value: Number(change.ctxBudget) });
    return slots;
  }
  if (change.kind === 'tool_limit') {
    const slots = [];
    for (const k of ['toolTimeoutMs', 'toolConcurrency', 'wrapReserveMs']) {
      if (change[k] !== undefined) slots.push({ slot: 'tool:' + k, value: Number(change[k]) });
    }
    return slots;
  }
  if (change.kind === 'prompt_addendum') {
    return [{ slot: 'addendum:' + String(change.personaId), value: String(change.text || '') }];
  }
  return [];
}

// 两条 change 是否冲突：存在同一槽位且值不同。
function evolveChangesConflict(a, b) {
  const sa = evolveChangeSlots(a);
  if (!sa.length) return false;
  const sb = new Map(evolveChangeSlots(b).map(x => [x.slot, x.value]));
  return sa.some(x => sb.has(x.slot) && sb.get(x.slot) !== x.value);
}

// 找出与目标提案冲突的其它未解决提案 id。
// target 可以是提案对象（{ id, change }）或裸 change 对象；
// proposals 为提案列表。只比 pending/applied/approved，排除自身。
function findEvolveConflicts(target, proposals) {
  const isProposal = target && typeof target === 'object' && 'change' in target;
  // v7.31.0：KB 草稿不参与冲突检测——既不做目标，也不做比较方
  // （草稿本来就没有 change；这里是防手改脏数据的第二道防线）。
  if (isProposal && target.kind === 'kb-draft') return [];
  const change = isProposal ? target.change : target;
  const selfId = isProposal ? String(target.id || '') : '';
  if (!change) return [];
  const out = [];
  for (const p of Array.isArray(proposals) ? proposals : []) {
    if (!p || !p.id || String(p.id) === selfId) continue;
    // v7.31.0：KB 草稿没有 change，不参与冲突检测。
    if (p.kind === 'kb-draft') continue;
    if (!EVO_CONFLICT_ACTIVE_STATUSES.includes(p.status)) continue;
    // v7.32.0：弱词升级不是冲突，是同一词的接续——升级提案
    // （upgradeFrom: 'weak' 的强词）与它要升级的那条弱词提案之间
    // 不算冲突（双向都跳过），否则升级提案在 list/状态里会永远挂着
    // ⚠️，应用时也会收到一条「留哪一个」的提醒，而升级的答案本来
    // 就是确定的：强词覆盖弱词，原弱词提案保持 applied。
    // 注意：这里只豁免「带升级标记的强词 vs 同词弱词」这一对；没有
    // 升级标记的强词 vs 弱词仍是冲突（v7.26.0 的原口径，见
    // evolveChangesConflict 的单测），两条互不相干的提案不会被误豁免。
    if (change && p.change && change.kind === 'persona_keyword_add' && p.change.kind === 'persona_keyword_add'
      && String(change.personaId) === String(p.change.personaId)
      && String(change.word || '').toLowerCase() === String(p.change.word || '').toLowerCase()) {
      const targetIsUpgrade = isProposal && target.upgradeFrom === 'weak' && change.strength === 'strong';
      const otherIsUpgrade = p.upgradeFrom === 'weak' && p.change.strength === 'strong';
      if ((targetIsUpgrade && p.change.strength === 'weak') || (change.strength === 'weak' && otherIsUpgrade)) continue;
    }
    if (evolveChangesConflict(change, p.change)) out.push(String(p.id));
  }
  return out;
}

// 给一批提案就地标注 conflictsWith：未解决的按动态计算填，
// 已解决的（rejected/rolled_back/expired）清为空数组——
// 冲突只在「未解决」之间存在，尘埃落定的提案不再拖着旧冲突。
// 返回同一批提案（便于 runEvolveCycle 在保存前调用一次）。
function annotateEvolveConflicts(items) {
  const list = Array.isArray(items) ? items : [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    // v7.31.0：KB 草稿不参与冲突检测，不给它写 conflictsWith。
    if (p.kind === 'kb-draft') continue;
    p.conflictsWith = EVO_CONFLICT_ACTIVE_STATUSES.includes(p.status)
      ? findEvolveConflicts(p, list)
      : [];
  }
  return list;
}

function formatEvolveProposal(p) {
  if (!p) return '';
  const lines = [];
  lines.push('🧬 ' + p.id + ' [' + p.status + '] ' + p.title);
  // v7.32.0：弱词升级提案在详情里单列一行——标题里已有「弱词升级」，
  // 这里再写清升级关系与原弱词提案的去向（保持 applied，overlay 里
  // 强词覆盖弱词），管理员一眼能认出这不是一条新词提案。
  if (p.upgradeFrom === 'weak') {
    lines.push('弱词升级：该词已作为弱关键词应用，现升级为强关键词（原弱词提案保持 applied，overlay 里强词覆盖弱词）');
  }
  if (p.rationale) lines.push('原因：' + p.rationale);
  if (p.evidence) lines.push('证据：' + p.evidence);
  // v7.42.0：详情里写清分数构成——证据分 × 趋势因子，以及前段/后段
  // 次数；旧提案（无 scoreDetail）写明是旧分，未含趋势加权。
  lines.push(formatEvolveScoreDetail(p));
  if (p.change) lines.push('改动：' + JSON.stringify(p.change));
  else lines.push('改动：无（人工复核）');
  lines.push('风险：' + (p.risk || 'low') + '｜规则：' + (p.rule || 'manual'));
  // v7.41.0：灰度中的已应用提案在详情里写清生效范围。
  if (p.status === 'applied' && normalizeRolloutPercent(p.rolloutPercent) < 100) {
    lines.push('灰度：仅对 ' + normalizeRolloutPercent(p.rolloutPercent) + '% 会话生效（其余会话走原配置，状态里可对比两组暂停率）');
  }
  if (p.status === 'rolled_back') {
    lines.push('回滚原因：' + (p.rolledBackReason || '未记录'));
  }
  if (Array.isArray(p.conflictsWith) && p.conflictsWith.length) {
    lines.push('⚠️ 冲突：与 ' + p.conflictsWith.join('、') + ' 同槽位不同值，请先确认再审批');
  }
  return lines.join('\n');
}

export {
  PROMPT_BLOCKLIST,
  EVO_ROLLBACK_REASON_MAX,
  normalizeRollbackReason,
  EVO_AUDIT_MAX,
  EVO_AUDIT_REASON_MAX,
  normalizeEvolveAudit,
  newEvolveAuditEntry,
  appendEvolveAudit,
  evolveChangeKey,
  proposalIdFor,
  EVO_KB_DRAFT_TTL_MS,
  kbDraftIdFor,
  kbDraftEvidence,
  newKbDraft,
  isKbDraftExpired,
  isKbDraftLive,
  upsertKbDraft,
  validateEvolveChange,
  emptyEvolveOverlay,
  buildEvolveOverlay,
  normalizeRolloutPercent,
  evolveProposalRolloutGroups,
  appliedWeakKeywords,
  newEvolveProposal,
  normalizeEvolveScoreDetail,
  formatEvolveScoreDetail,
  formatEvolveProposal,
  EVO_CONFLICT_ACTIVE_STATUSES,
  evolveChangeSlots,
  evolveChangesConflict,
  findEvolveConflicts,
  annotateEvolveConflicts,
};
