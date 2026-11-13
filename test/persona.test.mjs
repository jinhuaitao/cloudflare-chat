// 专家人格（v7.13.0）回归测试
// 覆盖：注册表完整性、确定性路由、显式/别名/非法回落、工具白名单、提示词注入与稳定前缀、
// 角色预算、失败降级提示、微信口令、以及主循环里的人格解析与断点存档。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PERSONAS, PERSONA_IDS, DEFAULT_PERSONA_ID,
  normalizePersonaId, getPersona, personaById, listPersonas,
  routePersona, resolvePersona, explainRoute, formatRouteHit, formatRouteWhy,
  formatPersonaTrace,
  personaAllowsTool, personaPromptBlock,
  formatPersonaList, formatPersonaBadge,
} from '../src/agent/personas.js';
import { resetChannelConfigCache } from '../src/channel.js';
import { getAgentTools, failureRecoveryHint, AGENT_TOOL_COUNT } from '../src/agent/tools.js';
import { agentLimits } from '../src/agent/limits.js';
import { buildAgentSystemPrompt } from '../src/agent/prompt.js';
import { parseWxCommand } from '../src/wechat/text.js';
import { tgAgentChat, tgAgentResume } from '../src/agent/loop.js';
import { handleWebAgent } from '../src/web-agent.js';

// ==================== 注册表完整性 ====================
test('人格 id 唯一，元信息与输出契约齐备', () => {
  assert.equal(new Set(PERSONA_IDS).size, PERSONA_IDS.length, 'id 不能重复');
  assert.equal(PERSONA_IDS.includes(DEFAULT_PERSONA_ID), true);
  for (const p of PERSONAS) {
    assert.ok(p.name && p.emoji && p.tagline && p.useWhen, p.id + ' 缺少展示字段');
    assert.ok(Array.isArray(p.tools) || p.tools === null, p.id + ' tools 必须是数组或 null');
    assert.ok(p.maxSteps >= 1 && p.maxSteps <= 12, p.id + ' 步数越界');
    assert.ok(p.ctxBudget >= 6000 && p.ctxBudget <= 200000, p.id + ' 上下文预算越界');
  }
  // 除通用人格外，每个角色都要有工作方式与输出契约
  for (const p of PERSONAS) {
    if (p.id === DEFAULT_PERSONA_ID) {
      assert.equal(p.prompt, '', '通用人格不应额外注入，保持与旧版提示词一致');
    } else {
      assert.ok(p.prompt.includes('工作方式'), p.id + ' 缺少工作方式');
      assert.ok(p.prompt.includes('输出契约'), p.id + ' 缺少输出契约');
    }
  }
});

test('人格白名单里的工具名全部真实存在', () => {
  const known = new Set(getAgentTools(false, { hasKbDocs: true }).map(t => t.function.name));
  for (const p of PERSONAS) {
    if (!Array.isArray(p.tools)) continue;
    for (const name of p.tools) {
      assert.ok(known.has(name), p.id + ' 引用了不存在的工具 ' + name);
    }
  }
});

test('listPersonas 返回副本，外部修改不影响注册表', () => {
  const arr = listPersonas();
  arr.pop();
  assert.equal(listPersonas().length, PERSONAS.length);
});

// ==================== 路由 ====================
test('按提问自动路由到对应专家', () => {
  const cases = [
    ['帮我写一个 Python 脚本读取 CSV 并画图', 'coder'],
    ['服务器 502 怎么排查', 'ops'],
    ['写一篇小红书文案，卖咖啡', 'writer'],
    ['帮我分析一下这份销售数据，算一下同比和转化率', 'analyst'],
    ['解释一下量子纠缠', 'tutor'],
    ['调研一下 2026 年国内 AI 编程工具市场，对比三家竞品', 'research'],
    ['帮我看看这段代码的报错：TypeError: x is not a function', 'coder'],
    ['帮我写封邮件给客户，语气正式一点', 'writer'],
  ];
  for (const [text, want] of cases) {
    const r = routePersona(text);
    assert.equal(r.persona.id, want, text + ' 应路由到 ' + want + '，实际 ' + r.persona.id + '（' + r.reason + '）');
  }
});

test('无关或信息不足的提问回落通用人格', () => {
  for (const text of ['', '   ', '你好', '今天天气怎么样', '继续', '1+1 等于几']) {
    const r = routePersona(text);
    assert.equal(r.persona.id, DEFAULT_PERSONA_ID, '「' + text + '」应回落通用');
    assert.equal(r.reason, 'low');
  }
});

test('两个角色同分时判定为意图不明，回落通用', () => {
  // writer 命中「文案」(3)，ops 命中「502」(3)，没有第三方信号 → 不冒险
  const r = routePersona('文案里提到 502');
  assert.equal(r.persona.id, DEFAULT_PERSONA_ID);
  assert.equal(r.reason, 'ambiguous');
});

test('具体技术栈的「原理/是什么」交给编程角色，而不是入门教学', () => {
  for (const text of ['Vue 3 的响应式原理是什么', 'MySQL 索引原理是什么']) {
    const r = routePersona(text);
    assert.equal(r.persona.id, 'coder', text + ' 实际 ' + r.persona.id);
    assert.equal(r.reason, 'tech');
  }
});

test('显式指定优先，且支持中英文别名', () => {
  assert.equal(resolvePersona('coder', '今天天气怎么样').persona.id, 'coder');
  assert.equal(resolvePersona('程序员', '随便聊聊').persona.id, 'coder');
  assert.equal(resolvePersona('写作', '服务器 502').persona.id, 'writer');
  assert.equal(resolvePersona('数据分析', '你好').persona.id, 'analyst');
  assert.equal(resolvePersona('ops', '写一篇文案').source, 'manual');
});

test('auto / 空值 / 非法 id 都不会锁死人', () => {
  assert.equal(resolvePersona('auto', '服务器 502').persona.id, 'ops');
  assert.equal(resolvePersona('', '服务器 502').persona.id, 'ops');
  assert.equal(resolvePersona('不存在的专家', '你好').persona.id, DEFAULT_PERSONA_ID);
  assert.equal(normalizePersonaId('CODER'), 'coder');
  assert.equal(normalizePersonaId('  '), '');
  assert.equal(getPersona('whatever'), null);
  assert.equal(personaById('whatever').id, DEFAULT_PERSONA_ID);
});

// ==================== v7.14.0 新角色与上下文连续 ====================
test('12 位人格注册完整，新角色支持中英文别名', () => {
  assert.equal(PERSONAS.length, 12);
  const aliases = [
    ['产品', 'product'], ['pm', 'product'],
    ['代码审查', 'reviewer'], ['review', 'reviewer'],
    ['翻译', 'translator'], ['translate', 'translator'],
    ['规划', 'planner'], ['plan', 'planner'],
    ['设计', 'designer'], ['design', 'designer'],
  ];
  for (const [alias, want] of aliases) assert.equal(normalizePersonaId(alias), want, alias);
  for (const id of ['product', 'reviewer', 'translator', 'planner', 'designer']) {
    const p = personaById(id);
    assert.ok(p.prompt.includes('工作方式') && p.prompt.includes('输出契约'), id + ' 提示词不完整');
    assert.ok(p.tools.length > 0 && p.maxSteps > 0 && p.ctxBudget > 0, id + ' 缺少运行配置');
  }
});

test('新增五类专业提问路由到对应专家', () => {
  const cases = [
    ['写一份小程序 PRD，包含用户故事和验收标准', 'product'],
    ['帮我审查这段代码有没有 SQL 注入风险', 'reviewer'],
    ['把这段产品说明翻译成英文，保留术语', 'translator'],
    ['制定一个两周的上线计划，列出里程碑和依赖', 'planner'],
    ['设计一个移动端登录页面，包含加载和错误状态', 'designer'],
    ['review 这段代码的并发安全和边界条件', 'reviewer'],
    ['做一份竞品分析，列出功能差异和优先级', 'product'],
  ];
  for (const [text, want] of cases) {
    const r = routePersona(text);
    assert.equal(r.persona.id, want, text + ' 实际为 ' + r.persona.id + ' / ' + r.reason);
  }
});

test('短追问在信号不足时承接上一轮专家，无需额外存储', () => {
  const history = [
    { role: 'user', content: '帮我写一个 Python 脚本读取 CSV' },
    { role: 'assistant', content: '可以，先看文件编码。' },
    { role: 'user', content: '再优化一下' },
  ];
  for (const q of ['再优化一下', '继续', '这个怎么改', '详细一点']) {
    const h = history.slice(0, 2).concat([{ role: 'user', content: q }]);
    const r = resolvePersona('auto', q, h);
    assert.equal(r.persona.id, 'coder', q + ' 应承接编程角色');
    assert.equal(r.reason, 'followup');
  }
  assert.ok(formatRouteHit(resolvePersona('auto', '继续', history)).includes('承接'));
});

test('新主题与无关追问不会被旧人格劫持', () => {
  const previous = [
    { role: 'user', content: '帮我写一个 Python 脚本读取 CSV' },
    { role: 'assistant', content: '可以。' },
  ];
  for (const [q, want] of [
    ['为什么天空是蓝色的', 'tutor'],
    ['今天天气怎么样', 'general'],
    ['服务器 502 怎么排查', 'ops'],
    ['再见', 'general'],
  ]) {
    const r = resolvePersona('auto', q, previous.concat([{ role: 'user', content: q }]));
    assert.equal(r.persona.id, want, q + ' 实际为 ' + r.persona.id + ' / ' + r.reason);
    assert.notEqual(r.reason, 'followup', q + ' 不应被当成旧话题承接');
  }
});

test('/agent why 能复盘承接原因，且手动指定不受历史影响', () => {
  const history = [
    { role: 'user', content: '设计一个移动端登录页面' },
    { role: 'assistant', content: '先确定主流程。' },
    { role: 'user', content: '再补充错误状态' },
  ];
  const why = formatRouteWhy('再补充错误状态', 'auto', history);
  assert.ok(why.includes('🎨 体验设计师'));
  assert.ok(why.includes('承接上一轮专业话题'));
  assert.equal(resolvePersona('writer', '继续', history).persona.id, 'writer');
  assert.equal(resolvePersona('writer', '继续', history).reason, 'manual');
});

test('非通用人格统一带交付自检，通用人格保持原样', () => {
  for (const p of PERSONAS) {
    const block = personaPromptBlock(p);
    if (p.id === DEFAULT_PERSONA_ID) assert.equal(block, '');
    else assert.ok(block.includes('交付自检'), p.id + ' 缺少交付自检');
  }
});

// ==================== 工具白名单 ====================
test('人格白名单裁剪工具集，通用人格保持全量', () => {
  const writer = getAgentTools(false, { hasKbDocs: true, persona: personaById('writer') }).map(t => t.function.name);
  const ops = getAgentTools(false, { hasKbDocs: true, persona: personaById('ops') }).map(t => t.function.name);
  const general = getAgentTools(false, { hasKbDocs: true }).map(t => t.function.name);

  assert.equal(general.length, AGENT_TOOL_COUNT, '通用人格必须拿到全量工具');
  assert.ok(writer.includes('save_doc'));
  assert.equal(writer.includes('net_lookup'), false, '写作角色不该带 DNS 诊断');
  assert.equal(writer.includes('get_weather'), false);
  assert.ok(ops.includes('net_lookup'));
  assert.equal(ops.includes('arxiv_search'), false);
});

test('人格裁剪与只读端叠加：写工具仍然被拿掉', () => {
  const ro = getAgentTools(true, { hasKbDocs: true, persona: personaById('coder') }).map(t => t.function.name);
  assert.equal(ro.includes('save_doc'), false);
  assert.equal(ro.includes('remember'), false);
  assert.ok(ro.includes('read_doc'));
});

test('同一人格组合复用同一份定义（前缀缓存前提）', () => {
  const a = getAgentTools(false, { hasKbDocs: true, persona: personaById('research') });
  const b = getAgentTools(false, { hasKbDocs: true, persona: personaById('research') });
  const c = getAgentTools(false, { hasKbDocs: true, persona: personaById('coder') });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('personaAllowsTool 对 null 白名单不设限', () => {
  assert.equal(personaAllowsTool(personaById('general'), 'anything'), true);
  assert.equal(personaAllowsTool(personaById('writer'), 'web_search'), true);
  assert.equal(personaAllowsTool(personaById('writer'), 'net_lookup'), false);
  assert.equal(personaAllowsTool(null, 'x'), true);
});

// ==================== 提示词 ====================
test('人格段注入在铁律之后、工具速查之前', () => {
  const p = buildAgentSystemPrompt([], '写代码', null, false, null, personaById('coder'));
  const iRules = p.indexOf('【铁律】');
  const iRole = p.indexOf('【当前专家角色】');
  const iTools = p.indexOf('【工具速查】');
  assert.ok(iRules >= 0 && iRole > iRules && iTools > iRole, '角色段位置不对：' + [iRules, iRole, iTools]);
  assert.ok(p.includes('【当前专家角色】🧑‍💻 编程工程师'));
  assert.ok(p.includes('不覆盖上面的铁律'), '必须声明角色不覆盖硬约束');
});

test('通用人格不注入角色段，与旧版提示词保持一致', () => {
  const p = buildAgentSystemPrompt([], '你好', null, false, null, personaById('general'));
  assert.equal(p.includes('【当前专家角色】'), false);
  assert.equal(p, buildAgentSystemPrompt([], '你好', null, false));
});

test('同一人格的稳定前缀跨轮逐字节一致，不同人格互不相同', async () => {
  const a = buildAgentSystemPrompt([{ fact: '用户喜欢咖啡', ts: 1 }], '咖啡', [{ title: 'A' }], false, null, personaById('research'));
  const b = buildAgentSystemPrompt([{ fact: '用户住在杭州', ts: 2 }], '杭州', [{ title: 'B' }], false, null, personaById('research'));
  const c = buildAgentSystemPrompt([{ fact: '用户喜欢咖啡', ts: 1 }], '咖啡', [{ title: 'A' }], false, null, personaById('writer'));

  const head = (s) => {
    const marks = ['【知识库文档列表】', '【关于用户的长期记忆】', '【当前时间】']
      .map(m => s.indexOf(m)).filter(i => i >= 0);
    return s.slice(0, marks.length ? Math.min(...marks) : s.length);
  };
  assert.equal(head(a), head(b), '同一人格的稳定前缀被动态内容污染');
  assert.notEqual(head(a), head(c), '不同人格应有不同的前缀桶');
  assert.ok(head(a).length > 900);
});

test('只读限制与写入纪律不因人格而丢失', () => {
  const ro = buildAgentSystemPrompt([], '写一篇文案', [], true, null, personaById('writer'));
  const rw = buildAgentSystemPrompt([], '写一篇文案', [], false, null, personaById('writer'));
  assert.ok(ro.includes('【只读限制】'));
  assert.ok(rw.includes('【写入纪律】'));
});

test('personaPromptBlock 对空人格返回空串', () => {
  assert.equal(personaPromptBlock(null), '');
  assert.equal(personaPromptBlock(personaById('general')), '');
  assert.ok(personaPromptBlock(personaById('ops')).startsWith('【当前专家角色】'));
});

// ==================== 预算 ====================
test('人格提供默认预算，环境变量优先', () => {
  assert.equal(agentLimits({}, personaById('research')).maxSteps, 8);
  assert.equal(agentLimits({}, personaById('writer')).maxSteps, 5);
  assert.equal(agentLimits({}, personaById('research')).ctxBudget, 32000);
  assert.equal(agentLimits({ AGENT_MAX_STEPS: '4' }, personaById('research')).maxSteps, 4);
  assert.equal(agentLimits({ AGENT_CONTEXT_BUDGET: '12000' }, personaById('research')).ctxBudget, 12000);
  // 非法值不能把人格默认值也带坏
  assert.equal(agentLimits({ AGENT_MAX_STEPS: '-1', AGENT_CONTEXT_BUDGET: '0' }, personaById('tutor')).maxSteps, 6);
  assert.equal(agentLimits({ AGENT_MAX_STEPS: '99' }, personaById('writer')).maxSteps, 12);
});

// ==================== 失败降级提示 ====================
test('常见工具失败会给出确定性替代路径', () => {
  assert.ok(failureRecoveryHint('web_search').includes('wiki_lookup'));
  assert.ok(failureRecoveryHint('web_fetch').includes('web_search'));
  assert.ok(failureRecoveryHint('net_lookup').includes('私网'));
  assert.equal(failureRecoveryHint('unknown_tool'), '');
  assert.equal(failureRecoveryHint(''), '');
});

// ==================== 微信口令 ====================
test('微信中文口令能进入人格命令', () => {
  assert.deepEqual(parseWxCommand('专家'), { cmd: '/agent', rest: 'list' });
  assert.deepEqual(parseWxCommand('专家列表'), { cmd: '/agent', rest: 'list' });
  assert.deepEqual(parseWxCommand('切换专家 编程'), { cmd: '/agent', rest: '编程' });
  assert.deepEqual(parseWxCommand('切换专家：数据分析'), { cmd: '/agent', rest: '数据分析' });
  assert.deepEqual(parseWxCommand('自动选择专家'), { cmd: '/agent', rest: 'auto' });
  assert.deepEqual(parseWxCommand('/agent coder'), { cmd: '/agent', rest: 'coder' });
  // 老口令不被新规则吃掉
  assert.deepEqual(parseWxCommand('模式'), { cmd: '/agent', rest: '' });
  assert.equal(parseWxCommand('专家你好'), null);
});

test('人格列表文案包含全部角色与当前标记', () => {
  const t = formatPersonaList('coder');
  for (const p of PERSONAS) assert.ok(t.includes('（' + p.id + '）'), '缺少 ' + p.id);
  assert.ok(t.includes('✅ 🧑‍💻 编程工程师'));
  assert.ok(t.includes('已固定'));
  const auto = formatPersonaList('auto');
  assert.ok(auto.includes('由问题自动选择'));
  assert.equal(formatPersonaBadge(personaById('ops')), '🛠️ 运维排障');
});

// ==================== 主循环集成 ====================
function sse(events) {
  const body = events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
const noopTgApi = () => Promise.resolve({ ok: true });
const ENV = {
  API_URL_1: 'https://mock.local/v1/chat/completions',
  API_KEY_1: 'k1',
  MODEL_1: 'mock-model:Mock',
  AGENT_MAX_STEPS: '3',
};

function toolDelta(index, id, name, args) {
  return {
    choices: [{
      delta: {
        tool_calls: [{ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
      }
    }]
  };
}

test('模型硬编出白名单外的工具会被拦截，不会真的发起外部请求', async () => {
  const original = globalThis.fetch;
  const captured = [];
  let n = 0;
  globalThis.fetch = async (url, init) => {
    captured.push(JSON.parse(init.body));
    n += 1;
    if (n === 1) return sse([toolDelta(0, 'c1', 'net_lookup', { target: 'example.com' })]);
    return sse([{ choices: [{ delta: { content: '那就不查了。' } }] }]);
  };
  try {
    await tgAgentChat(ENV, noopTgApi, 'p_chat5', 'mock-model',
      [{ role: 'user', content: '写一篇文案' }], true, null, { maxRuntimeMs: 30000, persona: 'writer' });
    // 只应有两次上游调用：第一次吐出越界工具，第二次拿到「不可用」说明后作答
    assert.equal(captured.length, 2);
    const second = captured[1];
    const toolMsg = second.messages.find(m => m.role === 'tool' && String(m.content).includes('不适用于当前专家角色'));
    assert.ok(toolMsg, '越界工具应被拦截并回灌说明');
  } finally {
    globalThis.fetch = original;
  }
});

test('tgAgentChat 自动识别运维提问，并把角色与白名单带进上游请求', async () => {
  const original = globalThis.fetch;
  const captured = [];
  globalThis.fetch = async (url, init) => {
    captured.push(JSON.parse(init.body));
    return sse([{ choices: [{ delta: { content: '先看 nginx 错误日志。' } }] }]);
  };
  try {
    const r = await tgAgentChat(ENV, noopTgApi, 'p_chat1', 'mock-model',
      [{ role: 'user', content: '服务器 502 怎么排查' }], true, null, { maxRuntimeMs: 30000 });
    assert.equal(r.personaId, 'ops');
    const req = captured[0];
    assert.ok(req.messages[0].content.includes('【当前专家角色】🛠️ 运维排障'));
    const names = (req.tools || []).map(t => t.function.name);
    assert.ok(names.includes('net_lookup'));
    assert.equal(names.includes('arxiv_search'), false, '白名单未生效');
  } finally {
    globalThis.fetch = original;
  }
});

test('tgAgentChat 支持显式人格，且无关提问保持通用提示词', async () => {
  const original = globalThis.fetch;
  const captured = [];
  globalThis.fetch = async (url, init) => {
    captured.push(JSON.parse(init.body));
    return sse([{ choices: [{ delta: { content: '好。' } }] }]);
  };
  try {
    const r1 = await tgAgentChat(ENV, noopTgApi, 'p_chat2', 'mock-model',
      [{ role: 'user', content: '随便聊聊' }], true, null, { maxRuntimeMs: 30000, persona: 'writer' });
    assert.equal(r1.personaId, 'writer');
    assert.ok(captured[0].messages[0].content.includes('【当前专家角色】✍️ 写作编辑'));

    const r2 = await tgAgentChat(ENV, noopTgApi, 'p_chat3', 'mock-model',
      [{ role: 'user', content: '你好呀' }], true, null, { maxRuntimeMs: 30000 });
    assert.equal(r2.personaId, DEFAULT_PERSONA_ID);
    assert.equal(captured[1].messages[0].content.includes('【当前专家角色】'), false);
    // 空知识库时 list_docs / read_doc 会被裁掉，19 - 2 = 17
    assert.equal((captured[1].tools || []).length, 17);
  } finally {
    globalThis.fetch = original;
  }
});

test('网页端固定自动选择：忽略请求体 persona，按提问路由', async () => {
  const original = globalThis.fetch;
  const captured = [];
  globalThis.fetch = async (url, init) => {
    captured.push(JSON.parse(init.body));
    return sse([{ choices: [{ delta: { content: '先看 nginx 错误日志。' } }] }]);
  };
  try {
    const res = await handleWebAgent(ENV, {
      model: 'mock-model',
      session_id: 'persona1',
      // 网页端不提供人格选择器：即使外部传了 writer，也必须按提问自动走运维
      persona: 'writer',
      messages: [{ role: 'user', content: '服务器 502 怎么排查' }],
    });
    const sseBody = await res.text();
    assert.equal(captured.length, 1);
    const sys = captured[0].messages[0].content;
    assert.ok(sys.includes('【当前专家角色】🛠️ 运维排障'), '网页端应按提问自动选运维');
    assert.equal(sys.includes('✍️ 写作编辑'), false, '网页端不应被请求体固定成写作人格');
    // 网页端没有 /agent status，这条事件是用户事后唯一能看见「谁答的」的地方
    assert.ok(sseBody.includes('"agent_persona"'), '缺少人格摘要事件');
    assert.ok(sseBody.includes('🧭 🛠️ 运维排障'), '人格摘要事件里应带角色名：' + sseBody.slice(0, 400));
  } finally {
    globalThis.fetch = original;
  }
});

// ==================== 路由复盘（/agent why） ====================
test('explainRoute 打分明细降序，且裁决与 routePersona 一致', () => {
  const text = '服务器 502 怎么排查';
  const { ranked, decision, minScore } = explainRoute(text);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].score >= ranked[i].score, '打分明细必须降序');
  }
  const direct = routePersona(text);
  assert.equal(decision.persona.id, direct.persona.id);
  assert.equal(decision.reason, direct.reason);
  assert.equal(minScore, 3);
  const ops = ranked.find(r => r.persona.id === 'ops');
  assert.ok(ops.score >= 3 && ops.matched.length > 0, '运维应得分并列出命中词');
});

test('formatRouteHit 只在自动选中非通用角色时给命中词', () => {
  assert.equal(formatRouteHit(resolvePersona('auto', '服务器 502 怎么排查'), 3).startsWith('命中：'), true);
  assert.equal(formatRouteHit(resolvePersona('auto', '你好'), 3), '', '回落通用时没有命中词');
  assert.equal(formatRouteHit(resolvePersona('coder', '今天天气'), 3), '', '手动固定时没有命中词');
});

test('formatPersonaTrace 给出可留存的「本轮由谁处理」摘要', () => {
  // 自动命中：角色 + 命中词，正文流完后仍能看出是谁答的
  const auto = formatPersonaTrace(resolvePersona('auto', '服务器 502 怎么排查'));
  assert.ok(auto.startsWith('🧭 🛠️ 运维排障'), '实际：' + auto);
  assert.ok(auto.includes('命中：'));

  // 回落通用时不打扰
  assert.equal(formatPersonaTrace(resolvePersona('auto', '你好')), '');

  // 手动固定要标明
  assert.equal(formatPersonaTrace(resolvePersona('writer', '随便聊聊')), '🧭 ✍️ 写作编辑（已固定）');

  // 接力链按顺序列出全部角色
  const chain = formatPersonaTrace(resolvePersona('auto', '先写一份小程序 PRD，然后制定一个两周的上线计划'));
  assert.ok(chain.startsWith('🧭 接力：'), '实际：' + chain);
  assert.ok(chain.includes('→'));

  // 入参缺失不抛错
  assert.equal(formatPersonaTrace(null), '');
  assert.equal(formatPersonaTrace({}), '');
});

test('formatRouteWhy 输出完整复盘：得分、命中词、结论与固定提示', () => {
  const why = formatRouteWhy('服务器 502 怎么排查', 'auto');
  assert.ok(why.includes('路由复盘') && why.includes('🛠️ 运维排障'));
  assert.ok(why.includes('结论：🛠️ 运维排障'));
  assert.ok(why.includes('阈值 3 分'));
  const pinned = formatRouteWhy('服务器 502 怎么排查', 'writer');
  assert.ok(pinned.includes('你已固定 ✍️ 写作编辑'), '固定人格时要提示实际用的是固定角色');
  const empty = formatRouteWhy('', 'auto');
  assert.ok(empty.includes('还没有可复盘的内容'));
  const lowWhy = formatRouteWhy('随便聊聊', 'auto');
  assert.ok(lowWhy.includes('通用助手'), '低分回落要说清去向');
});

test('微信口令映射到 /agent why', () => {
  assert.deepEqual(parseWxCommand('为什么选这个专家'), { cmd: '/agent', rest: 'why' });
  assert.deepEqual(parseWxCommand('路由复盘'), { cmd: '/agent', rest: 'why' });
  assert.deepEqual(parseWxCommand('复盘一下 服务器 502'), { cmd: '/agent', rest: 'why 服务器 502' });
});

// ==================== 网页端输入收口 ====================
test('网页端忽略 body.model 固定默认通道，WEB_AGENT_ALLOW_MODEL=1 时放开白名单', async () => {
  const original = globalThis.fetch;
  const captured = [];
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), body: JSON.parse(init.body) });
    return sse([{ choices: [{ delta: { content: '好。' } }] }]);
  };
  const ENV2 = {
    API_URL_1: 'https://a.local/v1/chat/completions', API_KEY_1: 'k1', MODEL_1: 'model-a:默认',
    API_URL_2: 'https://b.local/v1/chat/completions', API_KEY_2: 'k2', MODEL_2: 'model-b:备选',
  };
  try {
    resetChannelConfigCache();
    const r1 = await handleWebAgent(ENV2, {
      model: 'model-b', session_id: 'lock1',
      messages: [{ role: 'user', content: '你好' }],
    });
    await r1.text();
    assert.equal(captured[0].body.model, 'model-a', '默认应锁到第一个已配置通道');
    assert.ok(captured[0].url.includes('a.local'));

    resetChannelConfigCache();
    const r2 = await handleWebAgent({ ...ENV2, WEB_AGENT_ALLOW_MODEL: '1' }, {
      model: 'model-b', session_id: 'lock2',
      messages: [{ role: 'user', content: '你好' }],
    });
    await r2.text();
    assert.equal(captured[1].body.model, 'model-b', '放开后应 honored 白名单内的合法选择');
    assert.ok(captured[1].url.includes('b.local'));

    resetChannelConfigCache();
    const r3 = await handleWebAgent({ ...ENV2, WEB_AGENT_ALLOW_MODEL: '1' }, {
      model: 'not-configured', session_id: 'lock3',
      messages: [{ role: 'user', content: '你好' }],
    });
    await r3.text();
    assert.equal(captured[2].body.model, 'model-a', '非法模型仍兜底默认通道');
  } finally {
    globalThis.fetch = original;
    resetChannelConfigCache();
  }
});

test('主循环首步进度带路由命中词，结果回传路由依据', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => sse([{ choices: [{ delta: { content: '先看 nginx 错误日志。' } }] }]);
  const progress = [];
  try {
    resetChannelConfigCache();
    const r = await tgAgentChat(ENV, noopTgApi, 'p_chat6', 'mock-model',
      [{ role: 'user', content: '服务器 502 怎么排查' }], true,
      async (text) => { progress.push(String(text)); },
      { maxRuntimeMs: 30000 });
    assert.equal(r.personaId, 'ops');
    assert.ok(r.personaRoute && r.personaRoute.reason === 'matched');
    assert.ok(r.personaRoute.matched.length > 0);
    const first = progress.find(t => t.includes('第 1/'));
    assert.ok(first && first.includes('命中：'), '首步进度应带命中词，实际：' + first);
    // 第二步起不再重复命中词（保持进度条简短）
    const later = progress.filter(t => t.includes('第 2/'));
    for (const t of later) assert.equal(t.includes('命中：'), false);
  } finally {
    globalThis.fetch = original;
    resetChannelConfigCache();
  }
});

// ==================== v7.13.1 性能 ====================
test('拿到 ctx 时记忆写入挂 waitUntil，不在返回前串行等待', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => sse([{ choices: [{ delta: { content: '好的。' } }] }]);
  try {
    resetChannelConfigCache();
    const waited = [];
    const ctx = { waitUntil(p) { waited.push(p); } };
    const r = await tgAgentChat(ENV, noopTgApi, 'p_chat7', 'mock-model',
      [{ role: 'user', content: '你好' }], true, null,
      { maxRuntimeMs: 30000, ctx, workingMemory: true });
    assert.ok(r.text.includes('好的'));
    assert.equal(waited.length, 1, '记忆写入应被托管给运行时（waitUntil），而不是阻塞返回');
    await waited[0]; // 收尾，避免悬挂 promise
    // 不传 ctx 时保持串行语义（老调用方与单测依赖这个行为）
    const r2 = await tgAgentChat(ENV, noopTgApi, 'p_chat8', 'mock-model',
      [{ role: 'user', content: '你好' }], true, null, { maxRuntimeMs: 30000, workingMemory: true });
    assert.ok(r2.text.includes('好的'));
  } finally {
    globalThis.fetch = original;
    resetChannelConfigCache();
  }
});

test('路由打分性能护栏：预编译词表 + 单次小写，1000 次路由应远在 300ms 内', () => {
  const q = '帮我用 Python 写一个脚本读取 CSV 文件并画出折线图，服务器上跑 '.repeat(3);
  routePersona(q); // 预热
  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) routePersona(q);
  const ms = performance.now() - t0;
  assert.ok(ms < 300, '1000 次路由耗时 ' + ms.toFixed(0) + 'ms，超出性能护栏（预编译词表可能失效）');
  // explainRoute 与 routePersona 共享打分，不应再出现 2 倍开销
  const t1 = performance.now();
  for (let i = 0; i < 1000; i++) explainRoute(q);
  const ms2 = performance.now() - t1;
  assert.ok(ms2 < 600, '1000 次 explainRoute 耗时 ' + ms2.toFixed(0) + 'ms，超出性能护栏（疑似重复打分）');
});

test('主循环对短追问沿用上一轮人格与工具白名单', async () => {
  const original = globalThis.fetch;
  const captured = [];
  globalThis.fetch = async (url, init) => {
    captured.push(JSON.parse(init.body));
    return sse([{ choices: [{ delta: { content: '已补充缓存与超时。' } }] }]);
  };
  const progress = [];
  try {
    resetChannelConfigCache();
    const history = [
      { role: 'user', content: '帮我写一个 Python 脚本读取 CSV' },
      { role: 'assistant', content: '先给你一个基础版本。' },
      { role: 'user', content: '再优化一下' },
    ];
    const r = await tgAgentChat(ENV, noopTgApi, 'p_chat_followup', 'mock-model', history, true,
      async (text) => { progress.push(String(text)); }, { maxRuntimeMs: 30000 });
    assert.equal(r.personaId, 'coder');
    assert.equal(r.personaRoute.reason, 'followup');
    assert.ok(captured[0].messages[0].content.includes('【当前专家角色】🧑‍💻 编程工程师'));
    const names = (captured[0].tools || []).map(t => t.function.name);
    assert.ok(names.includes('github_lookup'));
    assert.equal(names.includes('net_lookup'), false);
    assert.ok(progress.some(t => t.includes('承接：上一轮编程工程师')));
  } finally {
    globalThis.fetch = original;
    resetChannelConfigCache();
  }
});

test('断点续做沿用存档里的人格与工具白名单', async () => {
  const original = globalThis.fetch;
  const captured = [];
  globalThis.fetch = async (url, init) => {
    captured.push(JSON.parse(init.body));
    return sse([{ choices: [{ delta: { content: '接着写。' } }] }]);
  };
  try {
    const saved = {
      targetModelId: 'mock-model',
      allowTools: true,
      kbReadOnly: false,
      hasKbDocs: true,
      personaId: 'coder',
      loopStartIdx: 2,
      origUserText: '帮我写个脚本',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '帮我写个脚本' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'calculate', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', name: 'calculate', content: '42' },
      ],
    };
    const r = await tgAgentResume(ENV, noopTgApi, 'p_chat4', saved, null, { maxRuntimeMs: 30000 });
    assert.ok(r.text.includes('接着写'));
    const names = (captured[0].tools || []).map(t => t.function.name);
    assert.ok(names.includes('github_lookup'));
    assert.equal(names.includes('net_lookup'), false, '恢复后不该多出其他角色的工具');
  } finally {
    globalThis.fetch = original;
  }
});

// ==================== 人格接力（v7.15.0） ====================
test('多阶段有序任务自动组成接力链', () => {
  const r = resolvePersona('auto', '先写一份小程序 PRD，然后制定一个两周的上线计划');
  assert.equal(r.reason, 'chain');
  assert.deepEqual(r.chain.map(p => p.id), ['product', 'planner']);
  assert.equal(r.persona.id, 'product', '链上第一个角色主导本轮');

  const r2 = resolvePersona('auto', '先规划微服务架构，然后给出部署方案和回滚预案');
  assert.equal(r2.reason, 'chain');
  assert.deepEqual(r2.chain.map(p => p.id), ['planner', 'ops']);

  const r3 = resolvePersona('auto', '第一步：调研竞品；第二步：写分析报告');
  assert.equal(r3.reason, 'chain');
  assert.equal(r3.chain.length >= 2, true);
});

test('单意图与普通短句不会误触发接力', () => {
  assert.notEqual(resolvePersona('auto', '帮我写一个 Python 脚本读取 CSV 并画图').reason, 'chain');
  assert.notEqual(resolvePersona('auto', '今天天气怎么样').reason, 'chain');
  assert.notEqual(resolvePersona('auto', '再优化一下').reason, 'chain');
  // 首段无强信号（锚点不足）→ 不成链
  assert.notEqual(resolvePersona('auto', '先查下明天天气，然后提醒我带伞').reason, 'chain');
  // 两段同角色去重后只剩一个 → 不成链
  assert.notEqual(resolvePersona('auto', '先写代码，然后再优化一下代码').reason, 'chain');
});

test('接力链的工具白名单取链上角色并集', () => {
  const chain = [personaById('research'), personaById('writer')];
  const names = getAgentTools(false, { hasKbDocs: true, persona: chain[0], chain }).map(t => t.function.name);
  // research 独有
  assert.ok(names.includes('arxiv_search'));
  // writer 独有
  assert.ok(names.includes('web_search'));
  // 只读端再叠加：写入工具仍然被剥掉
  const ro = getAgentTools(true, { hasKbDocs: true, persona: chain[0], chain }).map(t => t.function.name);
  assert.equal(ro.includes('remember'), false);
  assert.equal(ro.includes('save_doc'), false);
});

test('接力链注入提示词且只含角色不含用户原话', () => {
  const chain = [personaById('product'), personaById('planner')];
  const p = buildAgentSystemPrompt([], '先写 PRD 然后排期', null, false, null, chain[0], chain);
  assert.ok(p.includes('【人格接力】'));
  assert.ok(p.includes('产品经理') && p.includes('项目规划师'));
  assert.equal(p.includes('先写 PRD 然后排期'), false, '接力段不应携带用户原话（前缀缓存友好）');
  // 无链时与旧版一致
  const single = buildAgentSystemPrompt([], '写 PRD', null, false, null, personaById('product'));
  assert.equal(single.includes('【人格接力】'), false);
});

test('接力链预算取链上最大值且步数 +2', () => {
  const chain = [personaById('research'), personaById('writer')]; // 8/32K 与 5/20K
  const l = agentLimits({}, chain[0], chain);
  assert.equal(l.maxSteps, 10);
  assert.equal(l.ctxBudget, 32000);
  // 环境变量显式配置永远优先
  const l2 = agentLimits({ AGENT_MAX_STEPS: '5' }, chain[0], chain);
  assert.equal(l2.maxSteps, 5);
});

test('接力路由复盘展示逐阶段分工', () => {
  const why = formatRouteWhy('先写一份小程序 PRD，然后制定一个两周的上线计划', 'auto');
  assert.ok(why.includes('多阶段任务'));
  assert.ok(why.includes('产品经理') && why.includes('项目规划师'));
  const hit = formatRouteHit(resolvePersona('auto', '先写一份小程序 PRD，然后制定一个两周的上线计划'), 3);
  assert.ok(hit.startsWith('接力：'));
});

test('断点续做恢复存档里的接力链与并集工具', async () => {
  const original = globalThis.fetch;
  const captured = [];
  globalThis.fetch = async (url, init) => {
    captured.push(JSON.parse(init.body));
    return sse([{ choices: [{ delta: { content: '继续接力。' } }] }]);
  };
  try {
    const saved = {
      targetModelId: 'mock-model',
      allowTools: true,
      kbReadOnly: false,
      hasKbDocs: true,
      personaId: 'product',
      chainIds: ['product', 'planner'],
      loopStartIdx: 2,
      origUserText: '先写 PRD 然后排期',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '先写 PRD 然后排期' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_docs', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', name: 'list_docs', content: '（空）' },
      ],
    };
    const r = await tgAgentResume(ENV, noopTgApi, 'p_chat_chain', saved, null, { maxRuntimeMs: 30000 });
    assert.ok(r.text.includes('继续接力'));
    const names = (captured[0].tools || []).map(t => t.function.name);
    // product 与 planner 的并集：两边都有的 read_doc 在；product 独有的 remember 在
    assert.ok(names.includes('read_doc'));
    assert.ok(names.includes('remember'));
  } finally {
    globalThis.fetch = original;
  }
});
