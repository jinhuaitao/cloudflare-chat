// 专家人格（v7.13.0）回归测试
// 覆盖：注册表完整性、确定性路由、显式/别名/非法回落、工具白名单、提示词注入与稳定前缀、
// 角色预算、失败降级提示、微信口令、以及主循环里的人格解析与断点存档。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PERSONAS, PERSONA_IDS, DEFAULT_PERSONA_ID,
  normalizePersonaId, getPersona, personaById, listPersonas,
  routePersona, resolvePersona, personaAllowsTool, personaPromptBlock,
  formatPersonaList, formatPersonaBadge,
} from '../src/agent/personas.js';
import { getAgentTools, failureRecoveryHint } from '../src/agent/tools.js';
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

// ==================== 工具白名单 ====================
test('人格白名单裁剪工具集，通用人格保持全量', () => {
  const writer = getAgentTools(false, { hasKbDocs: true, persona: personaById('writer') }).map(t => t.function.name);
  const ops = getAgentTools(false, { hasKbDocs: true, persona: personaById('ops') }).map(t => t.function.name);
  const general = getAgentTools(false, { hasKbDocs: true }).map(t => t.function.name);

  assert.equal(general.length, 19, '通用人格工具数不能变');
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
  const t = formatPersonaList('coder', { auto: false });
  for (const p of PERSONAS) assert.ok(t.includes('（' + p.id + '）'), '缺少 ' + p.id);
  assert.ok(t.includes('✅ 🧑‍💻 编程工程师'));
  assert.ok(t.includes('已固定'));
  const auto = formatPersonaList('auto', { auto: true });
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
    await res.text();
    assert.equal(captured.length, 1);
    const sys = captured[0].messages[0].content;
    assert.ok(sys.includes('【当前专家角色】🛠️ 运维排障'), '网页端应按提问自动选运维');
    assert.equal(sys.includes('✍️ 写作编辑'), false, '网页端不应被请求体固定成写作人格');
  } finally {
    globalThis.fetch = original;
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
