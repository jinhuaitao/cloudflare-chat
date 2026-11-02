// Agent 主循环端到端测试：mock 上游 SSE，验证「并行工具调用 → 执行 → 汇总作答」全链路，
// 以及空转熔断、超预算跳过、断点续做状态保存等 v7.5.0 行为与 v7.6.0 的参数修复、
// 截断提示、续做起点修正。
// 不联网、不依赖 Cloudflare 运行时。

import test from 'node:test';
import assert from 'node:assert/strict';

import { tgAgentChat, tgAgentResume, tgAgentRunLoop, tgAgentDeadline } from '../src/agent/loop.js';

const ENV = {
  API_URL_1: 'https://mock.local/v1/chat/completions',
  API_KEY_1: 'k1',
  MODEL_1: 'mock-model:Mock',
  AGENT_MAX_STEPS: '6',
};

function sse(events) {
  const body = events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function delta(content) {
  return { choices: [{ delta: { content } }] };
}

function toolDelta(index, id, name, args) {
  return {
    choices: [{
      delta: {
        tool_calls: [{ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
      }
    }]
  };
}

// 依次消费预设的响应；用完后重复最后一个
function mockFetch(script) {
  const calls = [];
  let i = 0;
  const fn = async (url, init) => {
    const payload = JSON.parse(init.body);
    calls.push(payload);
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    return step(payload, i);
  };
  fn.calls = calls;
  return fn;
}

const noopTgApi = async () => ({ ok: true, json: async () => ({}) });

test('并行工具调用后汇总作答', async () => {
  const original = globalThis.fetch;
  const f = mockFetch([
    // 第 1 步：一次吐出两个独立工具调用
    () => sse([
      toolDelta(0, 'c1', 'calculate', { expression: '2^10' }),
      toolDelta(1, 'c2', 'get_time', {}),
    ]),
    // 第 2 步：直接作答
    () => sse([delta('10 的平方是 1024。')]),
  ]);
  globalThis.fetch = f;
  try {
    const deltas = [];
    const r = await tgAgentChat(ENV, noopTgApi, 'chat1', 'mock-model',
      [{ role: 'user', content: '2 的 10 次方是多少' }], true, null,
      { onDelta: async (t) => { deltas.push(t); }, maxRuntimeMs: 30000 });

    assert.equal(r.error, undefined);
    assert.ok(r.text.includes('1024'), '最终回答应包含计算结果');
    assert.equal(r.usedTools, true);
    // 第 2 次请求里必须能看到两个工具结果，说明并行调用都真的执行了
    const second = f.calls[1].messages;
    const toolMsgs = second.filter(m => m.role === 'tool');
    assert.equal(toolMsgs.length, 2);
    assert.ok(toolMsgs.some(m => m.content.includes('1024')), 'calculate 结果应回灌给模型');
    assert.ok(toolMsgs.some(m => m.content.includes('当前时间')), 'get_time 结果应回灌给模型');
    // 工具定义随请求下发
    assert.ok(Array.isArray(f.calls[0].tools) && f.calls[0].tools.length > 10);
    assert.ok(deltas.join('').includes('1024'), '正文应流式透传');
  } finally {
    globalThis.fetch = original;
  }
});

test('连续相同调用触发熔断并走收尾作答', async () => {
  const original = globalThis.fetch;
  const f = mockFetch([
    () => sse([toolDelta(0, 'c1', 'calculate', { expression: '1+1' })]),
    () => sse([toolDelta(0, 'c2', 'calculate', { expression: '1+1' })]),
    () => sse([delta('根据计算结果，答案是 2。')]), // 收尾请求
  ]);
  globalThis.fetch = f;
  try {
    const r = await tgAgentChat(ENV, noopTgApi, 'chat2', 'mock-model',
      [{ role: 'user', content: '算一下 1+1' }], true, null, { maxRuntimeMs: 30000 });
    assert.ok(r.text.includes('2'));
    // 收尾请求不应再带 tools，避免模型继续调用
    const wrapPayload = f.calls[f.calls.length - 1];
    assert.equal(wrapPayload.tools, undefined, '收尾请求必须移除 tools');
    assert.ok(wrapPayload.messages[wrapPayload.messages.length - 1].content.includes('工具调用阶段已结束'));
  } finally {
    globalThis.fetch = original;
  }
});

test('A→B→A→B 式绕圈由累计签名计数熔断', async () => {
  const original = globalThis.fetch;
  let n = 0;
  const f = mockFetch([
    () => { n++; return sse([toolDelta(0, 'a' + n, 'calculate', { expression: '1+1' })]); },
    () => { n++; return sse([toolDelta(0, 'b' + n, 'calculate', { expression: '2+2' })]); },
    () => { n++; return sse([toolDelta(0, 'c' + n, 'calculate', { expression: '1+1' })]); },
    () => { n++; return sse([toolDelta(0, 'd' + n, 'calculate', { expression: '2+2' })]); },
    () => sse([toolDelta(0, 'e' + n, 'calculate', { expression: '1+1' })]), // 第 5 次：A 累计 3 次
    () => sse([delta('综合以上结果。')]),
  ]);
  globalThis.fetch = f;
  try {
    const r = await tgAgentChat(ENV, noopTgApi, 'chat3', 'mock-model',
      [{ role: 'user', content: '来回算' }], true, null, { maxRuntimeMs: 30000 });
    assert.ok(r.text.includes('综合以上结果'));
    // 必须在 6 步上限内提前收束（第 5 步检测到 A 累计 3 次即熔断）
    assert.ok(f.calls.length <= 6, '实际请求次数 ' + f.calls.length);
  } finally {
    globalThis.fetch = original;
  }
});

test('预算耗尽时不发起新工具调用，直接收尾并保存断点', async () => {
  const original = globalThis.fetch;
  let fetchCount = 0;
  const env = { ...ENV, AGENT_WRAP_RESERVE_MS: '8000' };
  globalThis.fetch = async () => {
    fetchCount += 1;
    return sse([toolDelta(0, 'c' + fetchCount, 'calculate', { expression: '3*3' })]);
  };
  try {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '算 3*3' },
    ];
    // 手动构造一个已经过期的 deadline，模拟长任务尾声
    const deadline = Date.now() - 1000;
    const r = await tgAgentRunLoop(env, noopTgApi, 'chat4', 'mock-model', messages,
      [{ type: 'function', function: { name: 'calculate', parameters: {} } }], true, null,
      deadline, null, false, undefined, null, null, false, '算 3*3', undefined);
    assert.equal(typeof r.text, 'string');
    assert.ok(r.text.length > 0);
    assert.equal(fetchCount, 0, '已过期时不应再请求上游');
  } finally {
    globalThis.fetch = original;
  }
});

test('单轮预算很小时第一步仍会正常执行（收尾预留按比例封顶）', async () => {
  const original = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return fetchCount === 1
      ? sse([toolDelta(0, 'c1', 'calculate', { expression: '6*7' })])
      : sse([delta('答案是 42。')]);
  };
  try {
    const r = await tgAgentChat(ENV, noopTgApi, 'chat6', 'mock-model',
      [{ role: 'user', content: '6*7' }], true, null, { maxRuntimeMs: 10000 });
    assert.ok(r.text.includes('42'));
    assert.equal(fetchCount, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('上游 4xx 在首步触发无工具降级', async () => {
  const original = globalThis.fetch;
  const f = async () => new Response('{"error":"tools not supported"}', { status: 400 });
  globalThis.fetch = f;
  try {
    const r = await tgAgentChat(ENV, noopTgApi, 'chat5', 'mock-model',
      [{ role: 'user', content: '你好' }], true, null, { maxRuntimeMs: 20000 });
    assert.equal(r.fallback, true);
  } finally {
    globalThis.fetch = original;
  }
});

test('tgAgentDeadline 尊重更小的单轮预算', () => {
  const d1 = tgAgentDeadline({ AGENT_TIMEOUT_MS: '240000' }, { maxRuntimeMs: 55000 });
  const d2 = tgAgentDeadline({ AGENT_TIMEOUT_MS: '240000' }, null);
  assert.ok(d1 < d2);
});

test('临近步数上限时以尾部提示收束，且系统提示保持字节稳定', async () => {
  const original = globalThis.fetch;
  const f = mockFetch([
    () => sse([toolDelta(0, 'c1', 'calculate', { expression: '1+1' })]),
    () => sse([toolDelta(0, 'c2', 'calculate', { expression: '2+2' })]),
    () => sse([delta('完成。')]),
  ]);
  globalThis.fetch = f;
  try {
    const env = { ...ENV, AGENT_MAX_STEPS: '4' };
    const r = await tgAgentChat(env, noopTgApi, 'chat7', 'mock-model',
      [{ role: 'user', content: '算两次' }], true, null, { maxRuntimeMs: 30000 });
    assert.ok(r.text.includes('完成'));

    // 前缀缓存前提：整轮每一步的 system 内容必须完全一致
    const sysAll = f.calls.map(c => c.messages[0].content);
    assert.equal(new Set(sysAll).size, 1, 'system 提示在步与步之间被改写了，前缀缓存会全部失效');
    assert.equal(sysAll[0].includes('【本轮进度】'), false, '进度提示不该写进 system');

    // 收束提示改为追加在消息末尾，且不污染原始 messages（下一步不会累积）
    const lastOf = (call) => call.messages[call.messages.length - 1];
    assert.equal(lastOf(f.calls[0]).content.includes('【本轮进度】'), false, '第一步不该有收束提示');
    const tail1 = lastOf(f.calls[1]);
    assert.equal(tail1.role, 'user');
    assert.ok(tail1.content.includes('【本轮进度】'), '第二步应追加收束提示');
    assert.ok(tail1.content.includes('之后只剩 2 次工具机会'));
    for (const call of f.calls) {
      const n = call.messages.filter(m => typeof m.content === 'string' && m.content.includes('【本轮进度】')).length;
      assert.ok(n <= 1, '提示被累积了：出现 ' + n + ' 次');
    }
  } finally {
    globalThis.fetch = original;
  }
});

test('参数无法修复时不执行工具，并回灌合法 JSON 与失败原因', async () => {
  const original = globalThis.fetch;
  const badCall = {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0, id: 'bad1', type: 'function',
          function: { name: 'calculate', arguments: '{"expression":1+1}' }
        }]
      }
    }]
  };
  const f = mockFetch([
    () => sse([badCall]),
    () => sse([delta('参数不合法，请重试。')]),
  ]);
  globalThis.fetch = f;
  try {
    const r = await tgAgentChat(ENV, noopTgApi, 'chat8', 'mock-model',
      [{ role: 'user', content: '算 1+1' }], true, null, { maxRuntimeMs: 30000 });
    assert.ok(r.text.includes('参数不合法'));

    const second = f.calls[1].messages;
    const toolMsg = second.find(m => m.role === 'tool');
    assert.ok(toolMsg && toolMsg.content.includes('参数解析失败'), '失败原因必须回灌给模型');
    assert.equal(toolMsg.content.includes('计算结果'), false, '非法参数不应真的执行工具');
    // 回灌的 assistant.tool_calls 必须是合法 JSON，严格校验的上游才不会 400
    const asst = second.find(m => m.role === 'assistant' && Array.isArray(m.tool_calls));
    assert.deepEqual(JSON.parse(asst.tool_calls[0].function.arguments), {});
  } finally {
    globalThis.fetch = original;
  }
});

test('finish_reason=length 时补「继续」提示并流式透传', async () => {
  const original = globalThis.fetch;
  const f = mockFetch([
    () => sse([{ choices: [{ delta: { content: '这是一段被截断的回答' }, finish_reason: 'length' }] }]),
  ]);
  globalThis.fetch = f;
  try {
    const deltas = [];
    const r = await tgAgentChat(ENV, noopTgApi, 'chat9', 'mock-model',
      [{ role: 'user', content: '写一篇长文' }], true, null,
      { maxRuntimeMs: 30000, onDelta: async (t) => { deltas.push(t); } });
    assert.equal(r.streamed, true);
    assert.ok(r.text.includes('继续'), r.text);
    assert.ok(deltas.join('').includes('这是一段被截断的回答'));
    assert.ok(deltas.join('').includes('继续'), '截断提示必须增量补发给前端');
  } finally {
    globalThis.fetch = original;
  }
});

test('断点存档保存裁剪后的本轮起点，恢复后从工具轮次继续', async () => {
  const original = globalThis.fetch;
  const store = new Map();
  const env = {
    ...ENV,
    AGENT_MAX_STEPS: '1',
    R2: {
      async put(key, value) { store.set(key, String(value)); },
      async get(key) {
        return store.has(key) ? { text: async () => store.get(key) } : null;
      },
      async delete(key) { store.delete(key); },
      async list() { return { objects: [] }; },
    },
  };
  let n = 0;
  globalThis.fetch = async () => {
    n += 1;
    if (n === 1) return sse([toolDelta(0, 'c1', 'calculate', { expression: '7*6' })]);
    return new Response('wrap-up unavailable', { status: 503 });
  };
  try {
    const r = await tgAgentChat(env, noopTgApi, 'chat10', 'mock-model',
      [{ role: 'user', content: '算 7*6' }], true, null,
      { maxRuntimeMs: 30000, resumeKey: 'resume_chat10' });
    assert.equal(r.paused, true);

    const saved = JSON.parse(store.get('tg_agent_chat10'));
    assert.equal(saved.loopStartIdx, 2, '本轮起点必须指向第一条 assistant 轮次');
    assert.equal(saved.messages[saved.loopStartIdx].role, 'assistant');
    assert.equal(saved.messages[saved.loopStartIdx].tool_calls[0].id, 'c1');
    assert.equal(saved.messages[saved.loopStartIdx + 1].role, 'tool');
    assert.equal(saved.messages[saved.loopStartIdx - 1].role, 'user');

    // 用存档恢复：模型能直接看到此前的工具结果并作答
    globalThis.fetch = async () => sse([delta('答案是 42。')]);
    const rr = await tgAgentResume(env, noopTgApi, 'chat10', saved, null, { maxRuntimeMs: 30000 });
    assert.ok(rr.text.includes('42'), rr.text);
  } finally {
    globalThis.fetch = original;
  }
});
