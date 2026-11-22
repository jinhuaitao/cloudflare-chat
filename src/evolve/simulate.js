// 自我进化 · 沙盒模拟（v7.23.0）
//
// 提案在「生成时」和「应用前」各模拟一次，全是纯函数：
// 零 R2、零 LLM、零副作用、零用户数据。
//   · 关键词：把改动先叠到一份克隆的人格表上，再用真实路由跑三句
//     测试句（词本身 / 词+怎么 / 请问+词）。应用后应从通用翻到目标
//     人格，且不能把别的专家人格顶掉——顶掉就是一次误伤，打回；
//   · 预算：改动必须确实比现状更大（提一个和现状一样的数没有意义）；
//   · 限流/附言：校验通过即算模拟通过（改动在允许范围内）；限流多一道
//     v7.37.0 的优先级判断——传了 env 时，被环境变量显式配置压住的项
//     实际不会生效：全压住判 fail，部分压住判 pass 但写清哪几项被压住；
//   · review 类：无需模拟。
// 模拟失败的提案不生成、不应用，只记一条跳过原因。

import { resolvePersona, rankPersonas } from '../agent/personas.js';
import { agentLimits } from '../agent/limits.js';
import { evolvePersonas } from './overlay.js';
import { validateEvolveChange, buildEvolveOverlay } from './proposals.js';

// v7.37.0：第三个参数 env 可选——传了才判「显式配置优先」：tool_limit
// 改动里被环境变量显式配过的项，实际不会生效，模拟不能再说「能生效」。
// 全部被压住 → fail（生成时不建、应用时拒绝）；只压住一部分 → pass，
// 但 detail 写清哪几项被压住、结果里附 overriddenByEnv。不传 env 时
// 行为与原来一字不差（老调用点与旧测试不受影响）。
function simulateEvolveProposal(proposalOrDraft, personas, env) {
  const change = (proposalOrDraft && proposalOrDraft.change) || null;
  if (!change) return { tested: 0, flipped: 0, unexpected: [], verdict: 'na', detail: '人工复核类提案无需模拟' };
  const list = Array.isArray(personas) ? personas : [];

  if (change.kind === 'persona_keyword_add') {
    const target = list.find(p => p && p.id === change.personaId);
    if (!target) return { tested: 0, flipped: 0, unexpected: [], verdict: 'fail', detail: '未知人格：' + change.personaId };
    // 弱关键词不追求「翻转」：弱词只给目标人格 +1 分，本来就翻不过 MIN_SCORE。
    // 它的价值是攒信号——长问题里弱词叠加后才能越线。模拟只验证两件事：
    //   1) 目标人格的分数确实涨了（词生效了）；
    //   2) 当前路由一字不动（没有误伤）。
    if (change.strength === 'weak') {
      const overlay = buildEvolveOverlay([{ status: 'applied', appliedAt: 1, change }]);
      const evolved = evolvePersonas(list, overlay);
      const queries = [String(change.word), String(change.word) + '怎么', '请问' + String(change.word)];
      let gained = 0;
      const unexpected = [];
      for (const q of queries) {
        const beforeRank = rankPersonas(q, list).find(r => r.persona.id === change.personaId);
        const afterRank = rankPersonas(q, evolved).find(r => r.persona.id === change.personaId);
        if ((afterRank ? afterRank.score : 0) > (beforeRank ? beforeRank.score : 0)) gained += 1;
        const before = resolvePersona('auto', q, [], list);
        const after = resolvePersona('auto', q, [], evolved);
        if (before.persona.id !== after.persona.id) unexpected.push(q + '：' + before.persona.id + ' → ' + after.persona.id);
      }
      if (unexpected.length) {
        return { tested: queries.length, flipped: 0, unexpected, verdict: 'fail', detail: '模拟发现误伤：' + unexpected.join('；') };
      }
      if (gained === 0) {
        return { tested: queries.length, flipped: 0, unexpected, verdict: 'fail', detail: '弱关键词未让目标人格加分' };
      }
      return { tested: queries.length, flipped: 0, unexpected, verdict: 'pass', detail: '弱词生效：' + gained + '/' + queries.length + ' 句目标人格加分，路由不变' };
    }
    const overlay = buildEvolveOverlay([{ status: 'applied', appliedAt: 1, change }]);
    const evolved = evolvePersonas(list, overlay);
    const queries = [String(change.word), String(change.word) + '怎么', '请问' + String(change.word)];
    let flipped = 0;
    const unexpected = [];
    for (const q of queries) {
      const before = resolvePersona('auto', q, [], list);
      const after = resolvePersona('auto', q, [], evolved);
      if (before.persona.id === 'general' && after.persona.id === change.personaId) flipped += 1;
      // 误伤：应用前是某位专家，应用后换了另一位专家（或掉回通用）
      if (before.persona.id !== 'general' && after.persona.id !== before.persona.id) {
        unexpected.push(q + '：' + before.persona.id + ' → ' + after.persona.id);
      }
      // 误伤：应用后跑到第三个人格那里
      if (after.persona.id !== 'general' && after.persona.id !== change.personaId
        && before.persona.id === 'general') {
        unexpected.push(q + '：通用 → ' + after.persona.id);
      }
    }
    if (unexpected.length) {
      return { tested: queries.length, flipped, unexpected, verdict: 'fail', detail: '模拟发现误伤：' + unexpected.join('；') };
    }
    if (flipped === 0) {
      return { tested: queries.length, flipped, unexpected, verdict: 'fail', detail: '模拟后路由没有变化，关键词未生效' };
    }
    return { tested: queries.length, flipped, unexpected, verdict: 'pass', detail: flipped + '/' + queries.length + ' 句测试从通用翻到' + target.name };
  }

  if (change.kind === 'persona_budget') {
    const cur = list.find(p => p && p.id === change.personaId);
    if (!cur) return { tested: 0, flipped: 0, unexpected: [], verdict: 'fail', detail: '未知人格' };
    const details = [];
    if (change.maxSteps !== undefined) {
      const curSteps = Number(cur.maxSteps) || 6;
      const next = Number(change.maxSteps);
      if (!(Number.isInteger(next) && next > curSteps && next <= 12)) {
        return { tested: 1, flipped: 0, unexpected: [], verdict: 'fail', detail: '步数改动未比现状更大' };
      }
      details.push('步数 ' + curSteps + ' → ' + next + '，可多跑一步');
    }
    if (change.ctxBudget !== undefined) {
      // v7.30.0：上下文预算也要确实比现状更大——提一个和现状一样的数
      // 没有意义；上限 40000 与 validateEvolveChange 的夹取一致。
      // 之前这里只认「是整数」就放行，等于没校验，R11 的 +4000 提案
      // 本应过这一关，没过的（等于/小于现状的）提案不应生成。
      const curCtx = Number(cur.ctxBudget) || 24000;
      const next = Number(change.ctxBudget);
      if (!(Number.isInteger(next) && next > curCtx && next <= 40000)) {
        return { tested: 1, flipped: 0, unexpected: [], verdict: 'fail', detail: '上下文预算改动未比现状更大' };
      }
      details.push('上下文预算 ' + curCtx + ' → ' + next);
    }
    if (!details.length) {
      return { tested: 1, flipped: 0, unexpected: [], verdict: 'fail', detail: '预算改动无效' };
    }
    return { tested: 1, flipped: 1, unexpected: [], verdict: 'pass', detail: details.join('，') };
  }

  if (change.kind === 'tool_limit' || change.kind === 'prompt_addendum') {
    const check = validateEvolveChange(change, list);
    if (!check.ok) {
      return { tested: 1, flipped: 0, unexpected: [], verdict: 'fail', detail: check.error };
    }
    // v7.37.0：tool_limit 才有「显式配置压住」这一说——附言没有对应的
    // 环境变量，不参与。validateEvolveChange 本身不接 env（纯范围校验），
    // 优先级只在这里判：它只看范围，模拟才看「实际能不能生效」。
    if (change.kind === 'tool_limit' && env && typeof env === 'object') {
      const explicit = (agentLimits(env).explicit) || {};
      const changed = ['toolTimeoutMs', 'toolConcurrency', 'wrapReserveMs']
        .filter(k => change[k] !== undefined);
      const overridden = changed.filter(k => explicit[k]);
      if (overridden.length) {
        if (overridden.length === changed.length) {
          return {
            tested: 1, flipped: 0, unexpected: [], verdict: 'fail',
            detail: '已被环境变量显式配置压住，实际不会生效：' + overridden.join('、'),
            overriddenByEnv: overridden,
          };
        }
        return {
          tested: 1, flipped: 1, unexpected: [], verdict: 'pass',
          detail: '校验通过，改动在允许范围内；注意 ' + overridden.join('、')
            + ' 已被环境变量显式配置压住，实际不生效',
          overriddenByEnv: overridden,
        };
      }
    }
    return { tested: 1, flipped: 1, unexpected: [], verdict: 'pass', detail: '校验通过，改动在允许范围内' };
  }

  return { tested: 0, flipped: 0, unexpected: [], verdict: 'fail', detail: '未知提案类型：' + change.kind };
}

export { simulateEvolveProposal };
