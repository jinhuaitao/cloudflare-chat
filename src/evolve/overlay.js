// 自我进化 · 配置叠加层（v7.22.0）
//
// overlay 是「已应用提案」折叠出的纯配置，应用时：
//   · 人格：克隆后改，不动 PERSONAS 注册表（原注册表是共享只读结构，
//     改了它会污染所有 isolate 与单测）；
//   · 路由：克隆会把人格预编译的 _strong/_weak 一起带过来，只有真正
//     加了词时才清掉缓存、让 scorePersonaLower 按新词表重新编译
//     （见 clonePersona）；
//   · 预算：人格预算（maxSteps / ctxBudget）只在环境变量未显式设置时
//     生效——agentLimits 先读 AGENT_MAX_STEPS / AGENT_CONTEXT_BUDGET，
//     没配才读克隆后的人格值，所以进化赢不了管理员对步数/预算的手动配置；
//     全局工具限流（toolTimeoutMs / toolConcurrency / wrapReserveMs）
//     也一样（v7.37.0 根治）：agentLimits 在返回里带一个 explicit，
//     逐项标明哪几项是环境变量显式配的，evolveLimits 只对未显式配置的
//     项叠加 overlay——管理员显式设了 AGENT_TOOL_TIMEOUT_MS=20000，
//     已应用的单次超时 35000ms 提案就不再生效。提案本身仍保持 applied
//     状态（不悄悄改状态），只是在叠加时跳过该项；被压住的项列在返回的
//     overriddenByEnv 里，/evolve 状态也会单列一行（见 index.js）；
//     环境变量改掉或删掉后，提案自动重新生效，不用重新审批。
//   · 提示词附言：拼在人格 prompt 末尾，仍在 personaPromptBlock 的
//     「不覆盖铁律」声明之后，不改 system 前缀的稳定部分。

function clonePersona(p, overlay) {
  const persona = {
    ...p,
    strong: Array.isArray(p.strong) ? p.strong.slice() : [],
    weak: Array.isArray(p.weak) ? p.weak.slice() : [],
    prompt: String(p.prompt || ''),
  };
  if (!overlay || typeof overlay !== 'object') return persona;
  const kw = overlay.personaKeywords && overlay.personaKeywords[p.id];
  if (kw) {
    let added = false;
    for (const w of Array.isArray(kw.strong) ? kw.strong : []) {
      if (!persona.strong.some(x => String(x).toLowerCase() === String(w).toLowerCase())) {
        persona.strong.push(w);
        added = true;
      }
    }
    for (const w of Array.isArray(kw.weak) ? kw.weak : []) {
      if (!persona.weak.some(x => String(x).toLowerCase() === String(w).toLowerCase())) {
        persona.weak.push(w);
        added = true;
      }
    }
    // 人格在模块加载时预编译了 _strong/_weak（v7.13 性能优化）：
    // 克隆会把旧编译结果一起带过来，新词会被忽略。
    // 只有真正加了词时才清掉缓存，让打分按新词表重新编译；
    // 没加词的人格保留预编译结果，不付重复编译成本。
    if (added) {
      delete persona._strong;
      delete persona._weak;
    }
  }
  const budget = overlay.personaBudgets && overlay.personaBudgets[p.id];
  if (budget) {
    if (Number.isInteger(budget.maxSteps)) persona.maxSteps = budget.maxSteps;
    if (Number.isInteger(budget.ctxBudget)) persona.ctxBudget = budget.ctxBudget;
  }
  const addendum = overlay.promptAddenda && overlay.promptAddenda[p.id];
  if (addendum) {
    const text = String(addendum).trim();
    if (text && !persona.prompt.includes(text)) {
      persona.prompt = persona.prompt ? persona.prompt + '\n进化附言：' + text : '进化附言：' + text;
    }
  }
  return persona;
}

function evolvePersonas(personaList, overlay) {
  const list = Array.isArray(personaList) ? personaList : [];
  if (!overlay || typeof overlay !== 'object') return list.slice();
  return list.map(p => clonePersona(p, overlay));
}

function evolvePersona(persona, overlay) {
  if (!persona) return persona;
  return clonePersona(persona, overlay);
}

// 灰度比例：EVO_ROLLOUT_PERCENT，0~100，默认 100（全量）。
// 0 = 全部走对照组（只观测、不应用），100 = 全部走 overlay。
function evolveRolloutPercent(env) {
  const v = parseInt(env && env.EVO_ROLLOUT_PERCENT, 10);
  if (!Number.isInteger(v)) return 100;
  return Math.max(0, Math.min(100, v));
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

// overlay 里的工具限流只做「夹取后覆盖」，且只覆盖 agentLimits 已算出的值。
// v7.37.0：显式配置优先——limits.explicit 里标为 true 的项（agentLimits
// 读出来的环境变量显式配置），overlay 不再覆盖，跳过并记进返回的
// overriddenByEnv（空时不挂该字段）；没带 explicit 的旧式 limits 对象
// （手工构造的）按老行为全量覆盖，不报错。maxSteps / ctxBudget 也走
// 同一口径：虽然人格预算本来就靠 agentLimits 的 env-first 赢过进化，
// 但 overlay.toolLimits 里万一手写了这两项，显式配过同样不覆盖。
function evolveLimits(limits, overlay) {
  const out = { ...(limits || {}) };
  const tl = overlay && overlay.toolLimits;
  if (!tl || typeof tl !== 'object') return out;
  const explicit = (limits && limits.explicit) || {};
  const overridden = [];
  const apply = (key, lo, hi) => {
    if (tl[key] === undefined) return;
    if (explicit[key]) {
      overridden.push(key);
      return;
    }
    out[key] = clampInt(tl[key], lo, hi, out[key]);
  };
  apply('toolTimeoutMs', 1000, 120000);
  apply('toolConcurrency', 1, 8);
  apply('wrapReserveMs', 1500, 30000);
  apply('maxSteps', 1, 12);
  apply('ctxBudget', 6000, 200000);
  if (overridden.length) out.overriddenByEnv = overridden;
  return out;
}

export {
  clonePersona,
  evolvePersonas,
  evolvePersona,
  evolveLimits,
  evolveRolloutPercent,
};
