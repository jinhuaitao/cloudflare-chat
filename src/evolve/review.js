// 自我进化 · LLM 复核（v7.23.0，可选）
//
// 规则先行、模型复核在后：规则生成提案后，模型只给「第二意见」，
// 永远不直接改提案、不自动应用、不写 R2 之外的数据。
// 触发方式：
//   · 手动：管理员 /evolve review <id>（TG 与微信均可）；
//   · 自动：EVO_LLM_REVIEW=1 时，周期里对新提案最多复核 3 条。
// 复核失败（上游未配、超时、返回异常）时只记 ok:false，周期照常跑，
// 提案保持待审批——复核是加分项，不是门禁。

import { buildAIRequest } from '../channel.js';

const EVO_REVIEW_MAX_CHARS = 1000;

function parseEvolveReviewVerdict(text) {
  const t = String(text || '');
  if (/建议否决|否决|不建议通过|不应通过/.test(t)) return 'reject';
  if (/谨慎|暂缓|有风险|建议修改/.test(t)) return 'caution';
  if (/建议通过|可以应用|通过|可行/.test(t)) return 'approve';
  return 'unknown';
}

async function reviewEvolveProposalWithLLM(env, proposal, opts) {
  const p = proposal || {};
  const changeText = p.change ? JSON.stringify(p.change) : '（无改动，仅人工复核）';
  const messages = [
    {
      role: 'system',
      content: '你是 Cloudflare-Chat 自我进化系统的复核员。你只评审提案，不执行任何操作。'
        + '请用中文回答，先给结论（建议通过 / 谨慎 / 建议否决），再用 1~2 句话说明理由，'
        + '并指出如果应用可能带来的一个具体副作用。总字数不超过 200 字。',
    },
    {
      role: 'user',
      content: '提案标题：' + (p.title || '') + '\n'
        + '规则：' + (p.rule || '') + '｜风险：' + (p.risk || 'low') + '\n'
        + '依据：' + (p.rationale || '') + '\n'
        + '证据：' + (p.evidence || '') + '\n'
        + '改动：' + changeText,
    },
  ];
  let req;
  try {
    req = buildAIRequest(env, null, messages, false);
  } catch (e) {
    return { ok: false, error: '构建复核请求失败：' + (e && e.message ? e.message : String(e)) };
  }
  if (!req || req.error) return { ok: false, error: req && req.error ? req.error : '未配置模型' };
  // 复核是短评，不需要默认的 4096 token 上限。
  if (req.payload && typeof req.payload === 'object') req.payload.max_tokens = 600;
  const url = req.apiUrl || req.url;
  const key = req.currentApiKey || req.apiKey;
  if (!url || !key) return { ok: false, error: '上游地址或密钥缺失' };
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(req.payload),
      signal: AbortSignal.timeout((opts && opts.timeoutMs) || 30000),
    });
  } catch (e) {
    return { ok: false, error: '复核请求失败：' + (e && e.message ? e.message : String(e)) };
  }
  if (!resp || !resp.ok) {
    return { ok: false, error: '上游返回 ' + (resp ? resp.status : '无响应') };
  }
  let data = null;
  try {
    data = await resp.json();
  } catch (e) {
    return { ok: false, error: '复核结果无法解析' };
  }
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const msg = choice && choice.message ? choice.message : null;
  const text = String((msg && (msg.content || '')) || (choice && choice.text) || '').trim().slice(0, EVO_REVIEW_MAX_CHARS);
  if (!text) return { ok: false, error: '复核返回为空' };
  return {
    ok: true,
    text,
    verdict: parseEvolveReviewVerdict(text),
    model: (req.payload && req.payload.model) || '',
    at: Date.now(),
  };
}

export { reviewEvolveProposalWithLLM, parseEvolveReviewVerdict, suggestEvolveChangeWithLLM, extractEvolveChangeJson, EVO_REVIEW_MAX_CHARS };

// ---------- LLM 诊断建议（v7.25.0，EVO_LLM_DIAGNOSE=1） ----------
// review 类提案（工具失败、用户纠正、KB 缺失、对照告警）本身没有可执行的
// 改动，只到「请人工复核」就停了。诊断建议让模型在这些提案上再往前走一步：
// 根据证据给一个具体的配置改动（必须是 allowlist 里的四类之一）。
// 建议回来后走同一套关卡：validateEvolveChange 校验 → 沙盒模拟 →
// 生成一条 origin='llm' 的新提案，仍需管理员审批，永不自动应用。
// 模型只返回 JSON，解析失败、校验失败、模拟失败都直接丢弃，不阻塞周期。

function extractEvolveChangeJson(text) {
  const t = String(text || '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

async function suggestEvolveChangeWithLLM(env, proposal, summary) {
  const p = proposal || {};
  const s = summary || {};
  const topTools = Object.entries(s.byTool || {})
    .sort((a, b) => (b[1].fails || 0) - (a[1].fails || 0))
    .slice(0, 3)
    .map(([k, v]) => k + ' ' + v.fails + '/' + v.calls + ' 失败')
    .join('，');
  const messages = [
    {
      role: 'system',
      content: '你是 Cloudflare-Chat 自我进化系统的诊断员。只输出一个 JSON 对象，'
        + '不要输出任何其他文字。JSON 只能是以下四种之一：'
        + '{"kind":"persona_keyword_add","personaId":"<人格 id>","strength":"strong","word":"<2~12 字符的词>"}、'
        + '{"kind":"persona_budget","personaId":"<人格 id>","maxSteps":<1~12 的整数>}、'
        + '{"kind":"tool_limit","toolTimeoutMs":<1000~120000 的整数>}、'
        + '{"kind":"prompt_addendum","personaId":"<人格 id>","text":"<10~200 字的行为约束>"}。'
        + '如果根据证据给不出有把握的改动，输出 {"kind":"none"}。'
        + '不要建议删除、覆盖、放宽权限、改铁律，也不要编造证据里没有的事实。',
    },
    {
      role: 'user',
      content: '待诊断的问题：' + (p.title || '') + '\n'
        + '依据：' + (p.rationale || '') + '\n'
        + '证据：' + (p.evidence || '') + '\n'
        + '近 7 天窗口：共 ' + (s.total || 0) + ' 轮，暂停 ' + (s.paused || 0)
        + ' 轮，失败 ' + (s.error || 0) + ' 轮；失败最多工具：' + (topTools || '无'),
    },
  ];
  let req;
  try {
    req = buildAIRequest(env, null, messages, false);
  } catch (e) {
    return { ok: false, error: '构建诊断请求失败' };
  }
  if (!req || req.error) return { ok: false, error: req && req.error ? req.error : '未配置模型' };
  if (req.payload && typeof req.payload === 'object') req.payload.max_tokens = 600;
  const url = req.apiUrl || req.url;
  const key = req.currentApiKey || req.apiKey;
  if (!url || !key) return { ok: false, error: '上游地址或密钥缺失' };
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(req.payload),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    return { ok: false, error: '诊断请求失败' };
  }
  if (!resp || !resp.ok) return { ok: false, error: '上游返回 ' + (resp ? resp.status : '无响应') };
  let data = null;
  try {
    data = await resp.json();
  } catch (e) {
    return { ok: false, error: '诊断结果无法解析' };
  }
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const msg = choice && choice.message ? choice.message : null;
  const text = String((msg && (msg.content || '')) || (choice && choice.text) || '').trim();
  const change = extractEvolveChangeJson(text);
  if (!change || change.kind === 'none' || typeof change.kind !== 'string') {
    return { ok: false, error: '模型未给出可用改动' };
  }
  return { ok: true, change, raw: text.slice(0, 1000) };
}

