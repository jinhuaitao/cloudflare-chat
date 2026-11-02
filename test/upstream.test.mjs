// 上游流式读取回归测试：SSE 还原、增量回调顺序、finish_reason、错误事件、非 SSE 兜底。

import test from 'node:test';
import assert from 'node:assert/strict';

import { readUpstreamMessage } from '../src/agent/upstream.js';

function sse(events) {
  const body = events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

test('readUpstreamMessage 按序增量回调并捕获 finish_reason', async () => {
  const resp = sse([
    { choices: [{ delta: { content: '你' } }] },
    { choices: [{ delta: { content: '好' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]);
  const deltas = [];
  const msg = await readUpstreamMessage(resp, async (t, kind) => { deltas.push([t, kind]); });
  assert.equal(msg.content, '你好');
  assert.equal(msg.finishReason, 'stop');
  assert.equal(msg.forwarded, true);
  assert.deepEqual(deltas, [['你', 'content'], ['好', 'content']]);
});

test('readUpstreamMessage 保留 finish_reason=length', async () => {
  const msg = await readUpstreamMessage(sse([
    { choices: [{ delta: { content: '半截回答' }, finish_reason: 'length' }] },
  ]), null);
  assert.equal(msg.content, '半截回答');
  assert.equal(msg.finishReason, 'length');
});

test('readUpstreamMessage 合并分片 tool_calls', async () => {
  const msg = await readUpstreamMessage(sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'web_fetch', arguments: '{"url":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"https://x"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]), null);
  assert.equal(msg.toolCalls.length, 1);
  assert.equal(msg.toolCalls[0].id, 'c1');
  assert.equal(msg.toolCalls[0].function.name, 'web_fetch');
  assert.equal(msg.toolCalls[0].function.arguments, '{"url":"https://x"}');
  assert.equal(msg.finishReason, 'tool_calls');
});

test('readUpstreamMessage 把上游 error 事件转成 UpstreamSSEError', async () => {
  await assert.rejects(
    () => readUpstreamMessage(sse([{ error: { message: 'quota exceeded' } }]), null),
    e => e.name === 'UpstreamSSEError' && /quota exceeded/.test(e.message)
  );
});

test('readUpstreamMessage 兼容非 SSE 的普通 JSON 响应', async () => {
  const body = JSON.stringify({
    choices: [{ message: { content: 'ok', reasoning_content: '想了下' }, finish_reason: 'length' }],
  });
  const msg = await readUpstreamMessage(new Response(body, { status: 200 }), null);
  assert.equal(msg.content, 'ok');
  assert.equal(msg.reasoning, '想了下');
  assert.equal(msg.finishReason, 'length');
  assert.equal(msg.forwarded, false);
});
