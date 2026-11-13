// v7.8.0 性能回归测试：固定开销体积、提示词前缀稳定性、工具输出预算分摊、
// 流式增量批量化、DSML 跨分片拦截。
// 这些不是功能正确性，而是"每步都发生"的开销 —— 一旦回退，用户体感就是变慢、变贵。

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAgentTools } from '../src/agent/tools.js';
import { buildAgentSystemPrompt } from '../src/agent/prompt.js';
import { toolResultCap } from '../src/agent/limits.js';
import { readUpstreamMessage } from '../src/agent/upstream.js';
import { tgAgentChat } from '../src/agent/loop.js';
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
  const order = [];
  const task = (name, ms) => new Promise(res => setTimeout(() => { order.push(name); res(); }, ms));
  const held = [];
  const ctx = { waitUntil: (p) => held.push(p) };
  const t0 = Date.now();
  await deferOrAwait(ctx, [task('a', 40), task('b', 40)]);
  assert.ok(Date.now() - t0 < 25, '挂了 waitUntil 后不应原地等待任务完成');
  assert.equal(held.length, 1, '必须真的挂进 waitUntil');
  await held[0];
  assert.deepEqual(order.sort(), ['a', 'b'], '后台任务必须全部跑完');
});

test('deferOrAwait：无 ctx 时并行等待（总时长取 max 而非 sum）', async () => {
  const { deferOrAwait } = await import('../src/utils.js');
  const task = (ms) => new Promise(res => setTimeout(res, ms));
  const t0 = Date.now();
  await deferOrAwait(null, [task(40), task(40)]);
  const cost = Date.now() - t0;
  assert.ok(cost < 70, '两个 40ms 任务串行要 80ms+，并行应明显小于（实测 ' + cost + 'ms）');
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
