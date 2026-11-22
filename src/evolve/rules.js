// 自我进化 · 规则层（v7.22.0）
import { toolLatencyStats } from './metrics.js';
// 确定性规则优先于 LLM：先有可复现、可单测的诊断，再谈模型复核。
// 规则只读聚合窗口（默认近 7 天），输出的是「提案草稿」，不是直接改动：
//   · 草稿要过 validateEvolveChange 校验、去重（同规则+同目标 14 天内
//     已有 pending/applied 提案就不再重复提）、管理员审批三道关；
//   · 只有 risk=low 的 persona_budget（步数 +1）才允许在
//     EVO_AUTO_APPLY=1 时自动应用；EVO_AUTO_APPLY=2 时再自动应用
//     「沙盒模拟通过 + LLM 复核建议通过」双门禁的强关键词提案
//     （v7.25.0 自主等级 L2，需同时开 EVO_LLM_REVIEW=1；
//     LLM 诊断出的提案、附言、工具限流一律只提议）。
// 阈值都留了余量：样本不足时宁可不提，也不要拿 3 轮对话就「进化」一次。

// 灰度对照比较：进化组与对照组的暂停率。样本不足（任一组 <30 轮）
// 时不下结论——30 轮以下 10 个百分点的差距很可能是噪声。
function compareEvolveGroups(summary) {
  const g = (summary && summary.byGroup) || {};
  const ev = g.evolve || { total: 0, paused: 0 };
  const ct = g.control || { total: 0, paused: 0 };
  const evRate = ev.total > 0 ? ev.paused / ev.total : 0;
  const ctRate = ct.total > 0 ? ct.paused / ct.total : 0;
  const diff = evRate - ctRate;
  let verdict = 'inconclusive';
  if (ev.total >= 30 && ct.total >= 30) {
    if (diff >= 0.10) verdict = 'evolve-worse';
    else if (diff <= -0.10) verdict = 'evolve-better';
    else verdict = 'similar';
  }
  return { evolve: { total: ev.total, paused: ev.paused, rate: evRate }, control: { total: ct.total, paused: ct.paused, rate: ctRate }, diff, verdict };
}

function personaByIdFrom(list, id) {
  return (Array.isArray(list) ? list : []).find(p => p && p.id === String(id)) || null;
}

function wordKnown(persona, word) {
  const lower = String(word || '').toLowerCase();
  return [...(persona.strong || []), ...(persona.weak || [])]
    .some(w => String(w).toLowerCase() === lower);
}

// v7.32.0 弱词升级（R1c）的弱词表：已应用的弱关键词。
// 由 runEvolveCycle 从已应用提案里取（见 proposals.js 的
// appliedWeakKeywords），即 overlay 生效中的弱词——overlay 本身由
// 已应用提案折叠，所以「已应用提案里的弱词」与「overlay 生效中的
// 弱词」是同一来源，不用另读一份。pending 的弱词不算：还没生效，
// 攒信号要等它应用之后再说。
// 接受三种写法（生产传字符串数组，单测怎么写都行）：
//   ['coder:zig'] / [{ personaId, word }] / { coder: ['zig'] }
// 返回 'personaId:word小写' 的集合。
function weakKeywordSet(opts) {
  const set = new Set();
  const w = (opts && (opts.weakKeywords || opts.appliedWeakKeywords)) || null;
  if (Array.isArray(w)) {
    for (const x of w) {
      if (typeof x === 'string') {
        const i = x.indexOf(':');
        if (i > 0 && x.slice(i + 1)) set.add(x.slice(0, i) + ':' + x.slice(i + 1).toLowerCase());
      } else if (x && typeof x === 'object' && x.personaId && x.word) {
        set.add(String(x.personaId) + ':' + String(x.word).toLowerCase());
      }
    }
  } else if (w && typeof w === 'object') {
    for (const [pid, words] of Object.entries(w)) {
      for (const word of Array.isArray(words) ? words : [words]) {
        if (word) set.add(String(pid) + ':' + String(word).toLowerCase());
      }
    }
  }
  return set;
}

// ---------- v7.42.0 影响分校准 ----------
//
// 旧口径（v7.24.0 起）：score = 证据量，只看总量——三周前攒下的弱信号
// （近 miss 5 次后就再没出现）会一直排在昨天刚冒出来的强信号前面。
// 新口径：score = 证据分 × 趋势因子，趋势只做加权/微调，不做颠覆性重排。
//   · 趋势因子 = 1 + 0.2 × (后段 − 前段) / 总量，夹在 [0.8, 1.2]：
//     证据全在后段（刚出现）→ 1.2；全在前段（已陈旧）→ 0.8；
//     均匀分布 → 1.0；
//   · 证据强度仍是主因子：因子最多 ±20%，1 次证据全在昨天（1.2 分）
//     也超不过 2 次证据全在前段（1.6 分）；
//   · 纯函数：给定同一份日聚合（同一窗口）算出同一分，可复现；
//     分数保留 1 位小数（四舍五入到 0.1），排序仍按分从大到小；
//   · 分段口径与 v7.33.0 的 personaToolTrend 一致：窗口按日期对半分
//     （近 7 天是前 3 天 vs 后 4 天），分段数据由 summarizeEvolveDays
//     随汇总一起算好（summary.evidenceTrend，见 metrics.js 的
//     evidenceTrend），只用日聚合里已有的数据，不新增 R2 读、不新增
//     字段采集；
//   · 分段不可用时（窗口 <2 天、summary 是手工拼的、该规则的证据
//     不是按日计的量如 R10 灰度对照）因子取 1，scoreDetail 的
//     first/second 记 null，不硬编趋势——旧分行为不变。
// scoreDetail 是分数的构成说明，随提案一起存（见 proposals.js 的
// newEvolveProposal），list 与详情里展示，管理员看得出为什么排这个位置。
function trendFactor(first, second) {
  if (!Number.isFinite(first) || !Number.isFinite(second)) return 1;
  const total = first + second;
  if (total <= 0) return 1;
  return Math.min(1.2, Math.max(0.8, 1 + 0.2 * (second - first) / total));
}

function calibratedScore(evidence, first, second, trendNote) {
  const ev = Number(evidence) || 0;
  const factor = trendFactor(first, second);
  return {
    score: Math.round(ev * factor * 10) / 10,
    scoreDetail: {
      evidence: ev,
      first: Number.isFinite(first) ? first : null,
      second: Number.isFinite(second) ? second : null,
      trendFactor: Math.round(factor * 100) / 100,
      ...(trendNote ? { trendNote: String(trendNote).slice(0, 100) } : {}),
    },
  };
}

// 从 summary.evidenceTrend 里取某条证据的前段/后段计数。
// kind 是 evidenceTrend 里的一类（nearMiss / pausedByPersona /
// truncatedByPersona / toolFails / toolTimeouts / kbMiss），key 是证据键；
// correction / paused 这两类是单个数对，key 传 null。
// 分段不可用时返回 { first: null, second: null }。
function trendPair(summary, kind, key) {
  const t = (summary && summary.evidenceTrend) || null;
  if (!t || !t.firstDays || !t.secondDays) return { first: null, second: null };
  if (key === null || key === undefined) {
    const pair = t[kind];
    if (!pair || typeof pair !== 'object') return { first: null, second: null };
    return { first: Number(pair.first) || 0, second: Number(pair.second) || 0 };
  }
  const map = t[kind] || {};
  const e = map[String(key)];
  if (!e || typeof e !== 'object') return { first: 0, second: 0 };
  return { first: Number(e.first) || 0, second: Number(e.second) || 0 };
}

// summary: summarizeEvolveDays() 的窗口聚合；personas: PERSONAS 注册表
function analyzeEvolveDays(summary, personas, opts) {
  const o = opts || {};
  const drafts = [];
  const s = summary || {};
  const total = s.total || 0;
  if (total < 10) return drafts;
  // v7.32.0：已应用弱词的集合（'personaId:word小写'）。R1/R1b 跳过
  // 这些词——它们已有弱词在生效，再提强词/弱词是 R1c 的事。
  const weakSet = weakKeywordSet(o);
  const isWeakWord = (personaId, word) => weakSet.has(String(personaId) + ':' + String(word || '').toLowerCase());

  // R1 路由近 miss：某人格 + 某词反复出现（≥5 次），且该词不在词表里。
  // 含义是「用户反复用这个词问这类问题，但路由总差一点分」。
  const nearMiss = s.nearMiss || {};
  const nearList = Object.entries(nearMiss)
    .map(([key, count]) => {
      const idx = key.indexOf(':');
      return { personaId: key.slice(0, idx), word: key.slice(idx + 1), count };
    })
    .filter(x => x.personaId && x.word && x.count >= 5)
    .sort((a, b) => b.count - a.count);
  for (const item of nearList.slice(0, 3)) {
    const p = personaByIdFrom(personas, item.personaId);
    if (!p || p.id === 'general') continue;
    if (wordKnown(p, item.word)) continue;
    // v7.32.0：该词已有弱词在生效时不走普通强词——升级走 R1c，
    // 提案上带 upgradeFrom: 'weak' 标记，两者不要各提一条。
    if (isWeakWord(item.personaId, item.word)) continue;
    const tr = trendPair(s, 'nearMiss', item.personaId + ':' + item.word);
    drafts.push({
      rule: 'route-near-miss',
      title: '给「' + p.name + '」加关键词「' + item.word + '」',
      rationale: '近 7 天「' + item.word + '」问 ' + p.name + ' 相关问题 ' + item.count
        + ' 次，路由都差一点分而回落通用；加为强关键词后同类提问可直接命中。',
      evidence: 'nearMiss ' + item.personaId + ':' + item.word + ' = ' + item.count + '，窗口共 ' + total + ' 轮',
      change: { kind: 'persona_keyword_add', personaId: p.id, strength: 'strong', word: item.word },
      risk: 'medium',
      ...calibratedScore(item.count, tr.first, tr.second),
    });
  }

  // R1b 弱关键词：某人格 + 某词出现 3~4 次（够不上强词的 5 次门槛），
  // 先加为弱词攒信号。弱词只 +1 分，不会单独翻转路由，所以风险 low，
  // 且模拟验证的是「加分且不抢路由」而不是翻转。
  const weakList = Object.entries(nearMiss)
    .map(([key, count]) => {
      const idx = key.indexOf(':');
      return { personaId: key.slice(0, idx), word: key.slice(idx + 1), count };
    })
    .filter(x => x.personaId && x.word && x.count >= 3 && x.count < 5)
    .sort((a, b) => b.count - a.count);
  for (const item of weakList.slice(0, 3)) {
    const p = personaByIdFrom(personas, item.personaId);
    if (!p || p.id === 'general') continue;
    if (wordKnown(p, item.word)) continue;
    // v7.32.0：该词已有弱词在生效，3~4 次不再重复提弱词——
    // 要动它得等窗口内近 miss 攒到 ≥5 次，走 R1c 升级。
    if (isWeakWord(item.personaId, item.word)) continue;
    const tr = trendPair(s, 'nearMiss', item.personaId + ':' + item.word);
    drafts.push({
      rule: 'route-near-miss-weak',
      title: '给「' + p.name + '」加弱关键词「' + item.word + '」',
      rationale: '近 7 天「' + item.word + '」问 ' + p.name + ' 相关问题 ' + item.count
        + ' 次，够不上强词门槛（5 次），先加为弱词攒信号；长问题里弱词叠加后可越线。',
      evidence: 'nearMiss ' + item.personaId + ':' + item.word + ' = ' + item.count + '，窗口共 ' + total + ' 轮',
      change: { kind: 'persona_keyword_add', personaId: p.id, strength: 'weak', word: item.word },
      risk: 'low',
      ...calibratedScore(item.count, tr.first, tr.second),
    });
  }

  // R1c 弱词升级（v7.32.0）：某人格的某弱关键词（已应用提案里的 weak
  // 词，即 overlay 生效中的弱词）在本窗口内近 miss 又达到 ≥5 次——
  // 弱词只 +1 分仍不够翻转，但累计证据够了，提一条把该词从弱升强的
  // 提案。证据口径是窗口内的新增计数（不是累计总数）：「又出现 ≥5 次」
  // 指当前窗口内该词的近 miss 次数 ≥5。
  // 改动与普通强词提案完全相同（strength: 'strong'），区别只在提案
  // 对象上多一个 upgradeFrom: 'weak' 标记——list 与状态里据此展示
  // 「弱词升级」，去重时据此认出这是升级而非新词。模拟复用现有强词
  // 模拟（须从通用翻到目标人格且不误伤），模拟失败不生成（周期里与
  // 其它草稿同一关卡）；应用前再模拟一次（applyEvolveProposal 已有）。
  // 与 R1/R1b 各管各的词：R1 只提从未加过弱词的词，R1c 只提已应用
  // 弱词的词，同一词同一周期不会两边各提一条。
  const upgradeList = nearList.filter(x => isWeakWord(x.personaId, x.word));
  for (const item of upgradeList.slice(0, 3)) {
    const p = personaByIdFrom(personas, item.personaId);
    if (!p || p.id === 'general') continue;
    if (wordKnown(p, item.word)) continue;
    const tr = trendPair(s, 'nearMiss', item.personaId + ':' + item.word);
    drafts.push({
      rule: 'route-near-miss-upgrade',
      title: '弱词升级：给「' + p.name + '」的弱关键词「' + item.word + '」升级为强关键词',
      rationale: '近 7 天「' + item.word + '」问 ' + p.name + ' 相关问题 ' + item.count
        + ' 次（本窗口新增近 miss ' + item.count + ' 次），该词已作为弱关键词应用并仍在生效；'
        + '弱词只 +1 分仍不够翻转，累计证据已够，升级为强关键词后同类提问可直接命中。',
      evidence: 'nearMiss ' + item.personaId + ':' + item.word + ' = ' + item.count + '，窗口共 ' + total + ' 轮；该词已应用弱词提案（弱词升级）',
      change: { kind: 'persona_keyword_add', personaId: p.id, strength: 'strong', word: item.word },
      upgradeFrom: 'weak',
      risk: 'medium',
      ...calibratedScore(item.count, tr.first, tr.second),
    });
  }

  // R2 某人格频繁步数耗尽：暂停率 ≥30% 且样本 ≥8，步数未到上限时 +1 步。
  for (const [personaId, obp] of Object.entries(s.outcomesByPersona || {})) {
    if (!obp || (obp.total || 0) < 8) continue;
    if ((obp.paused || 0) / obp.total < 0.3) continue;
    const p = personaByIdFrom(personas, personaId);
    if (!p) continue;
    const cur = Number(p.maxSteps) || 6;
    if (cur >= 12) continue;
    const tr = trendPair(s, 'pausedByPersona', personaId);
    drafts.push({
      rule: 'persona-paused',
      title: '「' + p.name + '」步数 ' + cur + ' → ' + (cur + 1),
      rationale: '近 7 天该人格 ' + obp.total + ' 轮里 ' + obp.paused
        + ' 轮步数耗尽被暂停（' + Math.round((obp.paused / obp.total) * 100) + '%），加 1 步可少打断一次。',
      evidence: 'paused ' + personaId + ' = ' + obp.paused + '/' + obp.total,
      change: { kind: 'persona_budget', personaId: p.id, maxSteps: cur + 1 },
      risk: 'low',
      ...calibratedScore(obp.paused, tr.first, tr.second),
    });
  }

  // R11 步数耗尽联动预算（v7.30.0）：某人格暂停率高（≥30%）且截断率
  // 也高（≥20%）时，光加 1 步不够——截断说明单轮塞进来的内容已经超过
  // 上下文预算，多跑一轮也只会照样截断；把 ctxBudget +4000（上限 40000，
  // 与 validateEvolveChange 的夹取一致）才是对症的手段。
  // 与 R2 可同时提：maxSteps 与 ctxBudget 是不同槽位（v7.26.0 冲突检测
  // 已确认不同槽位不冲突），两者互补、不互相阻塞；rationale 里写清
  // 暂停率与截断率两个数字。风险 medium：改预算比改步数影响面大
  // （上下文越长，单轮成本越高），所以只提议、永不自动应用
  // （自动应用只限 risk=low 的步数提案）。
  for (const [personaId, obp] of Object.entries(s.outcomesByPersona || {})) {
    if (!obp || (obp.total || 0) < 8) continue;
    const pausedRate = (obp.paused || 0) / obp.total;
    const truncRate = (obp.truncated || 0) / obp.total;
    if (pausedRate < 0.3 || truncRate < 0.2) continue;
    const p = personaByIdFrom(personas, personaId);
    if (!p) continue;
    const cur = Number(p.ctxBudget) || 24000;
    const next = Math.min(40000, cur + 4000);
    if (next <= cur) continue;
    // v7.42.0：R11 的证据是暂停数 + 截断数，趋势按两者前段/后段
    // 之和算；任一分段不可用时因子取 1。
    const tp = trendPair(s, 'pausedByPersona', personaId);
    const tt = trendPair(s, 'truncatedByPersona', personaId);
    const tr = (tp.first === null || tt.first === null)
      ? { first: null, second: null }
      : { first: tp.first + tt.first, second: tp.second + tt.second };
    drafts.push({
      rule: 'persona-paused-truncated',
      title: '「' + p.name + '」上下文预算 ' + cur + ' → ' + next,
      rationale: '近 7 天该人格 ' + obp.total + ' 轮里 ' + obp.paused
        + ' 轮步数耗尽被暂停（' + Math.round(pausedRate * 100) + '%），'
        + (obp.truncated || 0) + ' 轮上下文被截断（' + Math.round(truncRate * 100)
        + '%）。只加步数不够：截断说明单轮内容已超预算，多跑一轮照样截断；'
        + '上下文预算 +4000 才是对症的手段。',
      evidence: 'paused ' + personaId + ' = ' + obp.paused + '/' + obp.total
        + '，truncated ' + personaId + ' = ' + (obp.truncated || 0) + '/' + obp.total,
      change: { kind: 'persona_budget', personaId: p.id, ctxBudget: next },
      risk: 'medium',
      ...calibratedScore((obp.paused || 0) + (obp.truncated || 0), tr.first, tr.second),
    });
  }

  // R3 工具失败率：某工具失败率 ≥30% 且调用 ≥10 次，只诊断、不自动改。
  for (const [name, slot] of Object.entries(s.byTool || {})) {
    if (!slot || (slot.calls || 0) < 10) continue;
    if ((slot.fails || 0) / slot.calls < 0.3) continue;
    const tr = trendPair(s, 'toolFails', name);
    drafts.push({
      rule: 'tool-failure',
      title: '工具 ' + name + ' 失败率偏高，请人工复核',
      rationale: '近 7 天 ' + name + ' 调用 ' + slot.calls + ' 次、失败 ' + slot.fails
        + ' 次（' + Math.round((slot.fails / slot.calls) * 100) + '%）。失败多半是上游或关键词问题，'
        + '不要自动调参；请先看最近的失败原文再决定是换后端、换关键词还是降级提示。',
      evidence: 'tool ' + name + ' fails ' + slot.fails + '/' + slot.calls,
      change: null,
      risk: 'low',
      ...calibratedScore(slot.fails, tr.first, tr.second),
    });
  }

  // R12 人格+工具失败聚类（v7.33.0）：窗口内按「人格 + 工具」组合统计失败。
  //   同一组合失败 ≥5 次且失败率 ≥30% 时，提一条 review 提案（change: null，
  //   只诊断、不改配置）。与 R3 可同时存在：R3 看工具全局失败率，R12 看
  //   某一人格调某工具的失败——同一工具两条都触发时各提一条，rationale 里
  //   写清各自口径，避免管理员误以为重复。
  //   趋势：窗口按日期对半分（前 floor(n/2) 天 vs 后 ceil(n/2) 天，近 7 天
  //   就是前 3 天 vs 后 4 天），给出两段的失败次数对比；窗口只有 1 天或
  //   缺少分段数据时如实写「无法对比」，不硬编趋势。
  //   老数据兼容：日聚合没有 byPersonaTool 字段时按空对象读，不报错、也不
  //   提聚类提案（无交叉数据则回退，不误报）。同一周期最多提 3 条，按失败
  //   次数降序取最严重的组合；注册表里没有的人格不提（标题要用人格名）。
  const trend = s.personaToolTrend || null;
  const clusterList = [];
  for (const [personaId, tools] of Object.entries(s.byPersonaTool || {})) {
    if (!tools || typeof tools !== 'object') continue;
    for (const [name, slot] of Object.entries(tools)) {
      if (!slot || typeof slot !== 'object') continue;
      const calls = slot.calls || 0;
      const fails = slot.fails || 0;
      if (fails < 5 || calls <= 0 || fails / calls < 0.3) continue;
      const p = personaByIdFrom(personas, personaId);
      if (!p) continue;
      clusterList.push({ personaId, name: p.name, tool: name, calls, fails, rate: fails / calls });
    }
  }
  clusterList.sort((a, b) => b.fails - a.fails || b.rate - a.rate);
  for (const item of clusterList.slice(0, 3)) {
    const key = item.personaId + ':' + item.tool;
    const pct = Math.round(item.rate * 100);
    const t = trend && trend.fails ? trend.fails[key] : null;
    // v7.42.0：R12 的趋势因子复用已有的 personaToolTrend 分段
    // （前段/后段失败次数）；窗口 <2 天（firstDays 为 0）时不加权。
    const tr = (trend && trend.firstDays > 0 && t)
      ? { first: t.first || 0, second: t.second || 0 }
      : { first: null, second: null };
    let trendText;
    let trendEvidence;
    if (!trend) {
      trendText = '趋势未知（窗口缺少分段数据，无法按日期对半对比）';
      trendEvidence = '趋势未知';
    } else if (trend.firstDays === 0) {
      trendText = '窗口仅 ' + trend.secondDays + ' 天，无法按日期对半分段对比趋势';
      trendEvidence = '趋势无法分段（窗口仅 ' + trend.secondDays + ' 天）';
    } else {
      const firstFails = t ? t.first : 0;
      const secondFails = t ? t.second : 0;
      const direction = secondFails > firstFails ? '正在变差' : secondFails < firstFails ? '正在好转' : '持平';
      trendText = '趋势（窗口按日期对半分：前 ' + trend.firstDays + ' 天 vs 后 ' + trend.secondDays
        + ' 天）：前段失败 ' + firstFails + ' 次 → 后段失败 ' + secondFails + ' 次，' + direction;
      trendEvidence = '前段 ' + firstFails + ' 次 → 后段 ' + secondFails + ' 次（前 '
        + trend.firstDays + ' 天 vs 后 ' + trend.secondDays + ' 天）';
    }
    drafts.push({
      rule: 'persona-tool-failure',
      title: '「' + item.name + '」调用 ' + item.tool + ' 失败 ' + item.fails + ' 次（' + pct + '%），请人工复核',
      rationale: '近 7 天「' + item.name + '」调用 ' + item.tool + ' ' + item.calls + ' 次、失败 '
        + item.fails + ' 次（' + pct + '%）。' + trendText + '。口径是「人格+工具」组合'
        + '（该人格调该工具的失败），不是该工具的全局失败率——全局口径见 R3 工具失败提案，'
        + '两条是不同诊断角度，不是重复。失败集中在某一人格身上时，先看该人格的提示词与'
        + '工具用法，再决定是换后端还是改提示；只诊断，不自动改配置。',
      evidence: 'personaTool ' + key + ' fails ' + item.fails + '/' + item.calls + '；' + trendEvidence,
      change: null,
      risk: 'low',
      ...calibratedScore(item.fails, tr.first, tr.second),
      // v7.33.0：review 提案的 change 是 null，去重与 id 不能只靠规则+改动——
      // 否则同一周期两个组合会算成同一条提案（见 proposals.js 的 scope 口径）。
      scope: key,
    });
  }

  // R4 知识库读不到：read_doc 失败 ≥5 次且失败率 ≥50%，只诊断。
  const readDoc = (s.byTool || {}).read_doc;
  if (readDoc && (readDoc.fails || 0) >= 5 && readDoc.calls > 0 && readDoc.fails / readDoc.calls >= 0.5) {
    const tr = trendPair(s, 'toolFails', 'read_doc');
    drafts.push({
      rule: 'kb-miss',
      title: '知识库 read_doc 大量读不到，请人工复核',
      rationale: '近 7 天 read_doc 失败 ' + readDoc.fails + '/' + readDoc.calls
        + ' 次：可能是标题/标签对不上，也可能是该补一篇文档。请用 /kb 核对列表，别急着改代码。',
      evidence: 'read_doc fails ' + readDoc.fails + '/' + readDoc.calls,
      change: null,
      risk: 'low',
      ...calibratedScore(readDoc.fails, tr.first, tr.second),
    });
  }

  // R6 搜索总失败：web_search 失败率 ≥30% 且调用 ≥10，给研究员加一句附言。
  // 附言是确定的行为约束（换关键词再试），不是让模型自由发挥；仍需人工审批。
  const search = (s.byTool || {}).web_search;
  if (search && (search.calls || 0) >= 10 && search.calls > 0 && (search.fails || 0) / search.calls >= 0.3) {
    const p = personaByIdFrom(personas, 'research');
    if (p) {
      const tr = trendPair(s, 'toolFails', 'web_search');
      drafts.push({
        rule: 'tool-addendum',
        title: '给「研究员」加一句搜索失败后的换词约束',
        rationale: '近 7 天 web_search 失败 ' + search.fails + '/' + search.calls
          + ' 次。模型看到「搜索失败」往往换个词原地再撞同一查询；附言要求先换关键词再试一次。',
        evidence: 'web_search fails ' + search.fails + '/' + search.calls,
        change: { kind: 'prompt_addendum', personaId: 'research', text: '搜索失败时先换关键词再试一次，不要用同一查询重复搜索。' },
        risk: 'medium',
        ...calibratedScore(search.fails, tr.first, tr.second),
      });
    }
  }

  // R7 暂停太多：整体暂停率 ≥25% 且样本 ≥20，给收尾多留 4 秒。
  // 收尾预留（wrapReserveMs）默认 8000ms；暂停多半是「工具跑满了、收尾没时间」，
  // 多留一点能让更多轮带着已查到的信息收尾，而不是直接暂停。
  if (total >= 20 && (s.paused || 0) / total >= 0.25) {
    const cur = Number(o.wrapReserveMs) || 8000;
    const next = Math.min(30000, cur + 4000);
    if (next > cur) {
      const tr = trendPair(s, 'paused', null);
      drafts.push({
        rule: 'wrap-reserve',
        title: '收尾预留 ' + cur + 'ms → ' + next + 'ms',
        rationale: '近 7 天 ' + total + ' 轮里 ' + s.paused + ' 轮被暂停（'
          + Math.round(((s.paused || 0) / total) * 100) + '%），收尾时间偏紧；多留 4 秒可少打断一次。',
        evidence: 'paused ' + s.paused + '/' + total,
        change: { kind: 'tool_limit', wrapReserveMs: next },
        risk: 'low',
        ...calibratedScore(s.paused || 0, tr.first, tr.second),
      });
    }
  }

  // R5 用户纠正率高：纠正信号 ≥15% 且样本 ≥20，只诊断。
  const correction = (s.signals || {}).correction || 0;
  if (total >= 20 && correction / total >= 0.15) {
    const tr = trendPair(s, 'correction', null);
    drafts.push({
      rule: 'user-correction',
      title: '用户纠正率偏高（' + Math.round((correction / total) * 100) + '%），请人工复核',
      rationale: '近 7 天 ' + total + ' 轮里用户明确纠正 ' + correction
        + ' 次。可能是路由错、人格提示词误导或记忆冲突，先看具体是哪几轮再定改法。',
      evidence: 'correction ' + correction + '/' + total,
      change: null,
      risk: 'low',
      ...calibratedScore(correction, tr.first, tr.second),
    });
  }

  // R8 工具总超时（v7.27.0 改用耗时分位数；v7.36.0 起样本是 loop.js
  //   逐次上报的单次实测耗时，p95 是真分位数，不再是轮内平均展开）：
  //   某工具调用 ≥10 次时，任一条件成立就提一条单次超时 +5 秒的提案（同一工具同一周期只提
  //   一条；仍只取最靠前的一个工具，与旧行为一致）：
  //   · p95 触发：p95 ≥ 当前单次超时 × 0.8——95% 的调用都快于 p95，
  //     p95 顶到超时线的八成说明慢调用已成常态，再不放宽就要成批
  //     被预算掐断；只看超时次数会漏掉「还没超时、但每次都踩着线跑」
  //     的工具，也会把「偶发几次超时」误报成常态问题；
  //   · 超时率兜底：超时 ≥30% 仍触发——老数据没有样本字段时 p95 为
  //     null，规则回退到只看超时率；有样本时两个条件任一成立都可提。
  //   p95 的值只在 rationale/evidence 里写给管理员看，不进 change。
  const curTimeout = Number(o.toolTimeoutMs) || 30000;
  const timeoutCandidates = Object.entries(s.byTool || {})
    .map(([name, v]) => {
      const calls = v.calls || 0;
      const timeoutRate = calls > 0 ? (v.timeouts || 0) / calls : 0;
      const stats = toolLatencyStats(v);
      const p95Hit = calls >= 10 && stats.p95 !== null && stats.p95 >= curTimeout * 0.8;
      const timeoutHit = calls >= 10 && timeoutRate >= 0.3;
      return { name, v, stats, timeoutRate, p95Hit, timeoutHit, hit: p95Hit || timeoutHit };
    })
    .filter(c => c.hit)
    .sort((a, b) => (b.v.timeouts || 0) - (a.v.timeouts || 0) || (b.stats.p95 || 0) - (a.stats.p95 || 0));
  if (timeoutCandidates.length) {
    const top = timeoutCandidates[0];
    const next = Math.min(120000, curTimeout + 5000);
    if (next > curTimeout) {
      const triggers = [];
      if (top.p95Hit) triggers.push('p95 为 ' + Math.round(top.stats.p95) + 'ms，已达当前单次超时 '
        + curTimeout + 'ms 的 80%（阈值 ' + Math.round(curTimeout * 0.8) + 'ms）');
      if (top.timeoutHit) triggers.push('超时 ' + top.v.timeouts + ' 次（'
        + Math.round(top.timeoutRate * 100) + '%）');
      const tr = trendPair(s, 'toolTimeouts', top.name);
      drafts.push({
        rule: 'tool-timeout',
        title: '工具 ' + top.name + ' 总超时，单次超时 ' + curTimeout + 'ms → ' + next + 'ms',
        rationale: '近 7 天 ' + top.name + ' 调用 ' + top.v.calls + ' 次，'
          + triggers.join('；') + '。多给 5 秒能让慢工具跑完，而不是被预算掐断。',
        evidence: top.name + ' timeouts ' + top.v.timeouts + '/' + top.v.calls
          + (top.stats.p95 !== null ? '，p95 ' + Math.round(top.stats.p95) + 'ms' : '，p95 未知（老数据无样本）'),
        change: { kind: 'tool_limit', toolTimeoutMs: next },
        risk: 'low',
        ...calibratedScore(top.v.timeouts, tr.first, tr.second),
      });
    }
  }

  // R9 KB 缺失主题：同一主题 read_doc 失败 ≥3 次，列出缺失清单。
  // 只诊断、不自动建文档——自动建文档容易把错误内容写进库，清单先给人看，
  // 人确认主题真实存在、值得入库后再手动建。
  // v7.31.0：主题列表抽成 kbMissingTopics()——周期里除 review 提案外，
  // 还要按同一份名单给每个主题生成一条自动草稿（见 index.js）。
  const kbTopics = kbMissingTopics(s);
  if (kbTopics.length) {
    const listText = kbTopics.map(({ topic: t, fails: c }) => '「' + t + '」' + c + ' 次').join('、');
    // v7.42.0：R9 的证据是各主题失败次数之和，趋势按各主题前段/后段
    // 之和算；窗口 <2 天时不加权。
    const kbTrend = (s.evidenceTrend && s.evidenceTrend.firstDays > 0)
      ? kbTopics.reduce((acc, { topic }) => {
          const e = (s.evidenceTrend.kbMiss || {})[topic];
          if (e) { acc.first += e.first || 0; acc.second += e.second || 0; }
          return acc;
        }, { first: 0, second: 0 })
      : { first: null, second: null };
    drafts.push({
      rule: 'kb-missing-topics',
      title: '知识库缺失主题：' + kbTopics.map(({ topic: t }) => t).slice(0, 3).join('、'),
      rationale: '近 7 天用户反复要读、但知识库里没有的主题：' + listText
        + '。建议确认后手动建文档入库，自动建文档容易写错内容，所以只提清单。',
      evidence: 'kbMissTopics ' + listText,
      change: null,
      risk: 'low',
      ...calibratedScore(kbTopics.reduce((a, { fails: c }) => a + c, 0), kbTrend.first, kbTrend.second),
    });
  }

  // R10 灰度对照告警：进化组暂停率比对照组高 ≥10 个百分点（两组各 ≥30 轮）。
  // 说明 overlay 可能在拖后腿——先告警，是否回滚由人决定（或开 EVO_AUTO_ROLLBACK）。
  const cmp = compareEvolveGroups(s);
  if (cmp.verdict === 'evolve-worse') {
    // v7.42.0：R10 的证据是两组暂停率之差（窗口整体对比），不是按日
    // 累计的证据量，没有按日分段可算——趋势因子取 1，scoreDetail 里
    // 写清原因，不硬编。
    drafts.push({
      rule: 'group-alarm',
      title: '灰度对照告警：进化组暂停率高于对照组 ' + Math.round(cmp.diff * 100) + ' 个百分点',
      rationale: '近 7 天进化组 ' + cmp.evolve.total + ' 轮、暂停率 ' + (cmp.evolve.rate * 100).toFixed(1)
        + '%；对照组 ' + cmp.control.total + ' 轮、暂停率 ' + (cmp.control.rate * 100).toFixed(1)
        + '%。overlay 可能在拖后腿，请检查已应用提案，或调低 EVO_ROLLOUT_PERCENT。',
      evidence: 'evolve ' + cmp.evolve.paused + '/' + cmp.evolve.total + ' vs control ' + cmp.control.paused + '/' + cmp.control.total,
      change: null,
      risk: 'low',
      ...calibratedScore(Math.round(cmp.diff * 100), null, null, '灰度对照是窗口整体对比，无按日分段的证据量'),
    });
  }

  return drafts;
}

// R9 的主题名单（v7.31.0 抽出共用）：近 7 天窗口里 read_doc 失败 ≥3 次
// 的主题，按失败次数降序、最多 5 个。只含主题词与失败次数，不含提问内容。
function kbMissingTopics(summary) {
  const s = summary || {};
  return Object.entries(s.kbMissTopics || {})
    .filter(([, c]) => c >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([topic, fails]) => ({ topic, fails }));
}

export { analyzeEvolveDays, compareEvolveGroups, kbMissingTopics, weakKeywordSet, trendFactor, calibratedScore };
