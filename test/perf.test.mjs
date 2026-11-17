// v7.8.0 性能回归测试：固定开销体积、提示词前缀稳定性、工具输出预算分摊、
// 流式增量批量化、DSML 跨分片拦截。
// 这些不是功能正确性，而是"每步都发生"的开销 —— 一旦回退，用户体感就是变慢、变贵。

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAgentTools } from '../src/agent/tools.js';
import { buildAgentSystemPrompt } from '../src/agent/prompt.js';
import { toolResultCap } from '../src/agent/limits.js';
import { readUpstreamMessage } from '../src/agent/upstream.js';
import { tgAgentChat, tgAgentRunLoop } from '../src/agent/loop.js';
import { personaById } from '../src/agent/personas.js';
import { toolWebFetch } from '../src/agent/tools-web.js';
import { handleWebAgent } from '../src/web-agent.js';

const ENV = {
  API_URL_1: 'https://mock.local/v1/chat/completions',
  API_KEY_1: 'k1',
  MODEL_1: 'mock-model:Mock',
  AGENT_MAX_STEPS: '6',
};

function sseResp(events) {
  const body = events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const noopTgApi = async () => ({ ok: true, json: async () => ({}) });

function gate() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// 只排空有限的 Promise/流读取链，不推进时钟，也不依赖机器的墙钟速度。
async function flushMicrotasks() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

const CLOCK_START = 1800000000000;
function freezeTimers(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: CLOCK_START });
  return {
    set: t.mock.method(globalThis, 'setTimeout'),
    clear: t.mock.method(globalThis, 'clearTimeout'),
  };
}

function assertTimersCleared(timers) {
  const cleared = new Set(timers.clear.mock.calls.map(c => c.arguments[0]));
  for (const call of timers.set.mock.calls) {
    assert.ok(cleared.has(call.result), '完成/取消后必须清理每个超时 timer');
  }
}

for (const persona of ['writer', 'auto']) {
  test('显式 persona=' + persona + ' 不读取悬挂的人格存档', async (t) => {
    freezeTimers(t);
    const personaRead = gate();
    const reads = [];
    const chatId = 'perf-explicit-persona-' + persona;
    const personaKey = 'agent_persona_' + chatId;
    const env = {
      ...ENV,
      R2: {
        async get(key) { reads.push(key); return key === personaKey ? personaRead.promise : null; },
        async list() { return { objects: [], truncated: false }; },
      },
    };
    const upstream = t.mock.method(globalThis, 'fetch', async () =>
      sseResp([{ choices: [{ delta: { content: '完成。' } }] }]));
    let result;
    const pending = tgAgentChat(env, noopTgApi, chatId, 'mock-model',
      [{ role: 'user', content: '服务器 502 怎么排查' }], true, null,
      { persona, workingMemory: false }).then(r => { result = r; });
    try {
      await flushMicrotasks();
      assert.equal(reads.includes(personaKey), false, '显式人格不应访问 agent_persona 键');
      assert.equal(upstream.mock.callCount(), 1, '不释放存档 gate、不推进时钟也应请求上游');
      assert.equal(result?.personaId, persona === 'auto' ? 'ops' : 'writer');
      assert.equal(result.text, '完成。');
      assert.equal(Date.now(), CLOCK_START);
    } finally {
      personaRead.resolve(null);
      await pending;
    }
  });
}

for (const persona of [undefined, '', null, false, 0]) {
  test('未指定或 falsy persona=' + String(persona) + ' 保留存档偏好', async (t) => {
    freezeTimers(t);
    const reads = [];
    const chatId = 'perf-saved-persona-' + String(persona);
    const personaKey = 'agent_persona_' + chatId;
    const env = {
      ...ENV,
      R2: {
        async get(key) {
          reads.push(key);
          return key === personaKey ? { text: async () => 'writer' } : null;
        },
        async list() { return { objects: [], truncated: false }; },
      },
    };
    t.mock.method(globalThis, 'fetch', async () =>
      sseResp([{ choices: [{ delta: { content: '按存档作答。' } }] }]));
    const opts = { workingMemory: false };
    if (persona !== undefined) opts.persona = persona;
    const result = await tgAgentChat(env, noopTgApi, chatId, 'mock-model',
      [{ role: 'user', content: '服务器 502 怎么排查' }], true, null, opts);
    assert.equal(reads.filter(k => k === personaKey).length, 1);
    assert.equal(result.personaId, 'writer', '存档偏好必须优先于当前提问的自动路由');
  });
}

function toolEvent(index, name, args) {
  return { choices: [{ delta: { tool_calls: [{
    index, id: 'budget-' + index, type: 'function',
    function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
  }] } }] };
}

const PAGE_BODY = 'A complete page with enough useful content to avoid the fallback chain. '.repeat(3);

test('工具队列按执行时刻缩短超时并跳过过期调用，保留各类短路', async (t) => {
  const timers = freezeTimers(t);
  const first = gate();
  const second = gate();
  const urls = ['first', 'second', 'skipped'].map(s => 'https://budget.example.com/' + s);
  const pageCalls = [];
  const upstreamCalls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url) === ENV.API_URL_1) {
      upstreamCalls.push(JSON.parse(init.body));
      if (upstreamCalls.length === 1) return sseResp([
        toolEvent(0, 'calculate', { expression: '7*7' }),
        toolEvent(1, 'web_fetch', { url: urls[0] }),
        toolEvent(2, 'web_fetch', { url: urls[1] }),
        toolEvent(3, 'web_fetch', { url: urls[2] }),
        toolEvent(4, 'calculate', { expression: '7*7' }),
        toolEvent(5, 'net_lookup', { target: 'example.com' }),
        toolEvent(6, 'web_fetch', '{"url":invalid}'),
      ]);
      return sseResp([{ choices: [{ delta: { content: '已有结果。' } }] }]);
    }
    pageCalls.push(String(url));
    if (url === urls[0]) await first.promise;
    if (url === urls[1]) await second.promise;
    return new Response(PAGE_BODY, { headers: { 'content-type': 'text/html' } });
  });
  const env = { ...ENV, AGENT_MAX_STEPS: '1', AGENT_TOOL_CONCURRENCY: '1', AGENT_WRAP_RESERVE_MS: '1500' };
  const persona = personaById('coder');
  const pending = tgAgentRunLoop(env, noopTgApi, 'perf-tool-queue', 'mock-model',
    [{ role: 'system', content: 'sys' }, { role: 'user', content: '读取网页' }],
    getAgentTools(false, { persona }), true, null, CLOCK_START + 20000,
    null, false, undefined, null, null, false, '读取网页', false, persona);
  try {
    await flushMicrotasks();
    assert.deepEqual(pageCalls, [urls[0]], '并发闸门必须先阻塞后续工具');
    t.mock.timers.setTime(CLOCK_START + 11000);
    first.resolve();
    await flushMicrotasks();
    assert.deepEqual(pageCalls, urls.slice(0, 2));
    // calculate 和第一篇网页上限 18500；第二篇入队等待了 11000，只剩 7500。
    // 8800 是 web_fetch 自身的直连 timer，不是循环层的执行上限。
    assert.deepEqual(timers.set.mock.calls.map(c => c.arguments[1]), [18500, 8800, 18500, 8800, 7500]);
    t.mock.timers.setTime(CLOCK_START + 18001); // 剩余 1999ms，第三个真实工具必须跳过
    second.resolve();
    const result = await pending;
    assert.equal(result.text, '已有结果。');
    assert.deepEqual(pageCalls, urls.slice(0, 2), '过期的排队工具不得发起请求');
    const results = upstreamCalls[1].messages.filter(m => m.role === 'tool');
    assert.deepEqual(results.map(m => m.tool_call_id), Array.from({ length: 7 }, (_, i) => 'budget-' + i));
    assert.match(results[3].content, /剩余时间不足/);
    assert.match(results[4].content, /已执行过完全相同的调用/);
    assert.match(results[5].content, /不适用于当前专家角色/);
    assert.match(results[6].content, /参数解析失败/);
    assert.equal(timers.set.mock.callCount(), 5, '短路分支不得启动执行 timer');
    assertTimersCleared(timers);
  } finally {
    first.resolve();
    second.resolve();
    await pending;
  }
});

function archiveResponse(target) {
  return Response.json({ archived_snapshots: { closest: {
    available: true,
    url: 'https://web.archive.org/web/20250101000000/' + target,
    timestamp: '20250101000000',
  } } });
}

for (const stage of ['available', 'snapshot']) {
  test('Jina 完整正文立即返回并取消挂起的 Wayback ' + stage, async (t) => {
    const timers = freezeTimers(t);
    const jina = gate();
    const archive = gate();
    const target = 'https://fallback.example.com/fast-jina-' + stage;
    const body = '有效实时正文内容'.repeat(10); // 恰好 80 字符，验证 >=80 边界
    const waybackSignals = [];
    let archiveStarted = false;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      if (url === target) return new Response('blocked', { status: 403 });
      if (String(url).startsWith('https://r.jina.ai/')) {
        await jina.promise;
        return new Response('Markdown Content:\n' + body);
      }
      waybackSignals.push(init.signal);
      const isAvailable = String(url).startsWith('https://archive.org/wayback/available');
      if ((stage === 'available') === isAvailable) {
        archiveStarted = true;
        init.signal.addEventListener('abort', () => archive.reject(init.signal.reason), { once: true });
        await archive.promise;
      }
      return isAvailable ? archiveResponse(target) : new Response(PAGE_BODY);
    });
    let result;
    const pending = toolWebFetch(target).then(r => { result = r; });
    try {
      await flushMicrotasks();
      assert.equal(archiveStarted, true, 'Jina 未完成时 Wayback 应已并发启动');
      jina.resolve();
      await flushMicrotasks();
      assert.equal(result, body, '不能等待快照 gate 或任意超时 timer 才返回正文');
      assert.equal(waybackSignals.length, stage === 'available' ? 1 : 2);
      assert.ok(waybackSignals.every(s => s === waybackSignals[0] && s.aborted));
      assert.equal(Date.now(), CLOCK_START);
      assert.equal(timers.set.mock.callCount(), 3);
      assertTimersCleared(timers);
    } finally {
      jina.resolve();
      archive.resolve();
      await pending;
    }
  });
}

const shortJina = 's'.repeat(79);
const jinaCases = [
  ['short', () => new Response('Title: ' + 'metadata'.repeat(20) + '\n\nMarkdown Content:\n' + shortJina), shortJina],
  ['empty', () => new Response('Title: ' + 'metadata'.repeat(20) + '\n\nMarkdown Content:\n  '), ''],
  ['error-page', () => new Response('Warning: Target URL returned error 403\n\nMarkdown Content:\n' + PAGE_BODY), ''],
  ['http-failure', () => new Response(PAGE_BODY, { status: 503 }), ''],
  ['network-failure', () => { throw new Error('reader unavailable'); }, ''],
];
for (const [label, response, fallback] of jinaCases) {
  for (const hasSnapshot of [true, false]) {
    test('Jina ' + label + ' 等待 Wayback，快照' + (hasSnapshot ? '优先' : '不可用才回落'), async (t) => {
      const timers = freezeTimers(t);
      const archive = gate();
      const target = 'https://fallback.example.com/' + label + '-' + hasSnapshot;
      let waybackSignal;
      let jinaRead = false;
      t.mock.method(globalThis, 'fetch', async (url, init) => {
        if (url === target) return new Response('blocked', { status: 403 });
        if (String(url).startsWith('https://r.jina.ai/')) { jinaRead = true; return response(); }
        if (String(url).startsWith('https://archive.org/wayback/available')) {
          waybackSignal = init.signal;
          await archive.promise;
          return hasSnapshot ? archiveResponse(target) : Response.json({ archived_snapshots: {} });
        }
        return new Response('<p>' + PAGE_BODY + '</p>');
      });
      let result;
      const pending = toolWebFetch(target).then(r => { result = r; });
      try {
        await flushMicrotasks();
        assert.equal(jinaRead, true);
        assert.ok(waybackSignal);
        assert.equal(result, undefined, '短/空/错误 Jina 不能提前当完整正文返回');
        assert.equal(waybackSignal.aborted, false, 'Jina 不足时必须继续等待快照');
        archive.resolve();
        await pending;
        if (hasSnapshot) {
          assert.match(result, /网页快照 20250101000000/);
          assert.ok(result.includes(PAGE_BODY.trim()), '应返回历史快照而不是短 Jina');
        } else if (fallback) {
          assert.equal(result, fallback, '快照不可用时才使用短 Jina');
        } else {
          assert.match(result, /^抓取失败/);
          assert.equal(result.includes(PAGE_BODY), false, 'Jina HTTP/200 错误页不能作为正文回落');
        }
        assertTimersCleared(timers);
      } finally {
        archive.resolve();
        await pending;
      }
    });
  }
}

// 每步都要重发的固定开销：工具定义 + 系统提示
// v7.10.0：断言从「总量 < 6000」改为「单工具平均 < 340 字符」。
// 总量是快照，加一个工具就得改数字；单工具均值才是真正要守的纪律——
// 它能在新增工具时立刻发现"描述写太啰嗦"，又不会因为工具数量合理增长而误报。
test('工具定义体积受控（每步重发的固定成本）', () => {
  const tools = getAgentTools(false, { hasKbDocs: true });
  const size = JSON.stringify(tools).length;
  const perTool = Math.round(size / tools.length);
  assert.ok(perTool < 340, '工具定义平均 ' + perTool + ' 字符/个（总量 ' + size + '），单步固定开销过高');
  assert.equal(tools.length, 19, '工具数量变化时请同步复核体积预算');
});

test('工具定义按权限组合缓存复用，不再每轮重建', () => {
  const a = getAgentTools(false, { hasKbDocs: true });
  const b = getAgentTools(false, { hasKbDocs: true });
  assert.equal(a, b, '同一权限组合应返回同一份定义（也是上游前缀缓存的前提）');
  assert.notEqual(a, getAgentTools(true, { hasKbDocs: true }));
  assert.equal(getAgentTools(false, { hasKbDocs: false }).length, 17);
});

// 系统提示按「稳定前缀 + 动态尾部」排列，多轮对话才能命中上游前缀缓存
test('系统提示的稳定前缀不受记忆/知识库/时间影响', () => {
  const a = buildAgentSystemPrompt([{ fact: '用户喜欢手冲咖啡', ts: 1 }], '咖啡', [{ title: 'A' }], false);
  const b = buildAgentSystemPrompt([{ fact: '用户住在杭州', ts: 2 }], '杭州', [{ title: 'B' }], false);

  const firstDynamic = (s) => {
    const marks = ['【知识库文档列表】', '【关于用户的长期记忆】', '【当前时间】']
      .map(m => s.indexOf(m))
      .filter(i => i >= 0);
    return marks.length ? Math.min(...marks) : s.length;
  };
  const headA = a.slice(0, firstDynamic(a));
  const headB = b.slice(0, firstDynamic(b));
  assert.equal(headA, headB, '稳定前缀被动态内容污染，前缀缓存会失效');
  assert.ok(headA.length > 900, '稳定前缀太短（' + headA.length + ' 字符），缓存收益有限');
});

test('当前时间放在提示词末尾，不在开头', () => {
  const p = buildAgentSystemPrompt([], '现在几点', [], false);
  const idx = p.indexOf('【当前时间】');
  assert.ok(idx > 0);
  assert.ok(idx > p.length - 160, '时间应位于提示词尾部，放在开头会让每一分钟都整段缓存失效');
});

// 单步工具输出分摊：一步吐很多工具时不能把上下文一次顶满
test('工具结果预算按工具数分摊', () => {
  // 默认 24000 预算：1~4 个工具时仍是完整的 4000 字符
  assert.equal(toolResultCap(24000, 1), 4000);
  assert.equal(toolResultCap(24000, 4), 4000);
  // 8 个工具时按剩余预算均分，避免 8×4000 直接击穿预算
  assert.equal(toolResultCap(24000, 8), 2000);
  // 小预算场景有下限，不会把结果截成没有信息量的碎片
  assert.ok(toolResultCap(6000, 8) >= 800);
  // 工具总输出 + 固定开销应能装进预算
  const cap = toolResultCap(24000, 8);
  assert.ok(cap * 8 + 8000 <= 24000);
});

// 流式增量批量化：逐 token 一个 SSE 事件会让浏览器解析上千个包
test('Web 端流式正文按批下发，内容不丢不重', async () => {
  const original = globalThis.fetch;
  const tokens = Array.from({ length: 300 }, (_, i) => String.fromCharCode(0x4e00 + (i % 200)));
  const body = tokens.map(t => 'data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n').join('')
    + 'data: [DONE]\n\n';
  globalThis.fetch = async () => new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  try {
    const res = await handleWebAgent(ENV, {
      model: 'mock-model',
      session_id: 'perf1',
      messages: [{ role: 'user', content: '说点什么' }],
    });
    const text = await res.text();
    const events = text.split('\n\n').filter(l => l.startsWith('data: ') && l.trim() !== 'data: [DONE]');
    const contentEvents = events
      .map(l => { try { return JSON.parse(l.slice(6)); } catch (e) { return null; } })
      .filter(o => o && o.choices && o.choices[0].delta && typeof o.choices[0].delta.content === 'string');

    assert.ok(contentEvents.length < 20, '正文分了 ' + contentEvents.length + ' 个事件下发，批量合并失效');
    const joined = contentEvents.map(o => o.choices[0].delta.content).join('');
    assert.equal(joined, tokens.join(''), '批量下发后正文出现丢失或重复');
  } finally {
    globalThis.fetch = original;
  }
});

// 增量扫描窗口不能漏掉被切在两个分片之间的 DSML 标记
test('DSML 标记跨分片时仍能拦截，不再向前端透传', async () => {
  const enc = new TextEncoder();
  const chunks = [
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '先说明一下<|DS' } }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ delta: { content: 'ML|>调用工具<|/DSML|>' } }] }) + '\n\n',
    'data: [DONE]\n\n',
  ];
  const stream = new ReadableStream({
    start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); }
  });
  const deltas = [];
  const msg = await readUpstreamMessage(
    new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    async (t) => { deltas.push(t); }
  );
  assert.ok(msg.content.includes('<|DSML|>'));
  // 标记被切开时，标记出现前的正文已经外发（这是必然的），关键是标记一旦成形就立刻停止外发
  assert.deepEqual(deltas, ['先说明一下<|DS'], '标记出现后的正文必须立即停止外发');
});

test('普通正文不会因为增量扫描窗口被误判为工具调用', async () => {
  const enc = new TextEncoder();
  const plain = '这是一段完全正常的回答，里面提到了 DSML 这个词但并不是标记。';
  const chunks = [];
  for (let i = 0; i < plain.length; i += 7) {
    chunks.push('data: ' + JSON.stringify({ choices: [{ delta: { content: plain.slice(i, i + 7) } }] }) + '\n\n');
  }
  chunks.push('data: [DONE]\n\n');
  const stream = new ReadableStream({
    start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); }
  });
  const msg = await readUpstreamMessage(new Response(stream, { status: 200 }), null);
  assert.equal(msg.content, plain);
  assert.equal(msg.forwarded, true, '普通正文必须正常透传');
});

// 思维链回灌是上下文膨胀的隐形大头：推理模型一步几千字，逐轮累积直接击穿预算
test('思维链默认不回灌上下文，AGENT_KEEP_REASONING=1 才回灌', async () => {
  const original = globalThis.fetch;
  const runOnce = async (env) => {
    let i = 0;
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push(JSON.parse(init.body));
      i += 1;
      if (i === 1) {
        return sseResp([
          { choices: [{ delta: { reasoning_content: '先想想这道题该怎么算……' } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'calculate', arguments: '{"expression":"1+1"}' } }] } }] },
        ]);
      }
      return sseResp([{ choices: [{ delta: { content: '等于 2。' } }] }]);
    };
    await tgAgentChat(env, noopTgApi, 'perf2', 'mock-model',
      [{ role: 'user', content: '1+1' }], true, null, { maxRuntimeMs: 30000 });
    return calls;
  };
  try {
    const off = await runOnce({ ...ENV });
    const assistantOff = off[1].messages.find(m => m.role === 'assistant');
    assert.equal(assistantOff.reasoning_content, undefined, '默认不该把思维链塞回上下文');

    const on = await runOnce({ ...ENV, AGENT_KEEP_REASONING: '1' });
    const assistantOn = on[1].messages.find(m => m.role === 'assistant');
    assert.equal(assistantOn.reasoning_content, '先想想这道题该怎么算……');
  } finally {
    globalThis.fetch = original;
  }
});

// 收尾持久化（历史保存 / 断点清理）不该挡在用户看回复的关键路径上：
// 有 ctx 时挂 waitUntil 立即返回，没有时也要并行等（不再逐个串行 await）。
test('deferOrAwait：有 ctx 挂 waitUntil 立即返回，任务仍跑完', async () => {
  const { deferOrAwait } = await import('../src/utils.js');
  const a = gate();
  const b = gate();
  const order = [];
  const held = [];
  const ctx = { waitUntil: (p) => held.push(p) };
  let returned = false;
  let finished = false;
  const pending = deferOrAwait(ctx, [a.promise.then(() => order.push('a')), b.promise.then(() => order.push('b'))])
    .then(() => { returned = true; });
  try {
    await flushMicrotasks();
    assert.equal(returned, true, '后台任务尚未完成时调用方就应继续');
    assert.equal(held.length, 1, '必须真的挂进 waitUntil');
    held[0].then(() => { finished = true; });
    b.resolve();
    await flushMicrotasks();
    assert.deepEqual(order, ['b']);
    assert.equal(finished, false, 'waitUntil 必须等待所有后台任务');
    a.resolve();
    await held[0];
    assert.deepEqual(order, ['b', 'a']);
  } finally {
    a.resolve();
    b.resolve();
    await pending;
    await Promise.all(held);
  }
});

test('deferOrAwait：无 ctx 时等待所有任务，允许逆序完成', async () => {
  const { deferOrAwait } = await import('../src/utils.js');
  const a = gate();
  const b = gate();
  let returned = false;
  const pending = deferOrAwait(null, [a.promise, b.promise]).then(() => { returned = true; });
  try {
    await flushMicrotasks();
    assert.equal(returned, false);
    b.resolve();
    await flushMicrotasks();
    assert.equal(returned, false, '不能只等一个任务就提前返回');
    a.resolve();
    await pending;
    assert.equal(returned, true);
  } finally {
    a.resolve();
    b.resolve();
    await pending;
  }
});

test('收尾写入延后已接到 TG / 微信双端的四条回复路径', async () => {
  const fs = await import('node:fs');
  const tg = fs.readFileSync(new URL('../src/telegram/handler.js', import.meta.url), 'utf8');
  const wx = fs.readFileSync(new URL('../src/wechat/handler.js', import.meta.url), 'utf8');
  for (const [name, src] of [['telegram', tg], ['wechat', wx]]) {
    // Agent 路径：保存历史 + 清断点一起延后
    assert.ok(src.includes('deferred.push(tgSaveHistory('), name + '：Agent 路径未延后历史保存');
    assert.ok(src.includes('deferred.push(agentClearResumeState('), name + '：Agent 路径未延后断点清理');
    assert.ok(src.includes('await deferOrAwait(ctx, deferred)'), name + '：Agent 路径未走 deferOrAwait');
    // 普通对话路径：保存历史同样延后
    assert.ok(src.includes('await deferOrAwait(ctx, tgSaveHistory('), name + '：普通路径未延后历史保存');
    // 旧的串行写法不允许再出现（在这两个收尾块里）
    assert.equal(src.includes('await tgSaveHistory('), false, name + '：仍存在关键路径上的串行历史保存');
    // /clear 三次清理并行（语义要等待，但不必串行）
    assert.ok(/\/clear[\s\S]{0,600}Promise\.all\(\[/.test(src), name + '：/clear 未并行化');
  }
  // 微信专属：诊断日志落盘必须按时间合并，否则每条回复都多一次 R2 写
  assert.ok(wx.includes('WX_DIAG_PERSIST_MIN_MS'), 'wechat：诊断落盘未做时间合并');
  assert.ok(wx.includes('WX_DIAG_ALWAYS_PERSIST_KINDS'), 'wechat：error/login 应保持立即落盘');
  // 回复分片复用 context_token，不再每片读一次 R2
  assert.ok(wx.includes('replyCtxToken === null'), 'wechat：回复分片未复用 context_token');
});
