// v6.6.5 Agent 完善测试：truncateToolResult / toolCallSignature / trimAgentMessages
// + 系统提示词关键语句回归 + DSML 回归（复用 test-dsml.js 的提取逻辑）
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '_worker.js'), 'utf8');
function extract(startMark, endMark) {
  const si = src.indexOf(startMark), ei = src.indexOf(endMark);
  if (si === -1 || ei === -1 || ei <= si) { console.error('FAIL: 定位失败: ' + startMark.slice(0, 40)); process.exit(1); }
  return src.slice(si, ei);
}
eval(extract('// 工具结果截断：超长时保留前 maxChars 并标注，避免模型误判为完整数据',
              '// ==================== Telegram Agent：主循环 ===================='));
eval(extract('// 从文本中提取 DSML 工具调用，转成 OpenAI 标准 tool_calls 数组；找不到返回 []。',
              '// ==================== Agent 稳定性增强（v6.6.5） ===================='));

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '\n    实际: ' + a + '\n    期望: ' + e); }
}
function ok(name, cond) { eq(name, !!cond, true); }

console.log('== 1. truncateToolResult ==');
eq('短文本原样返回', truncateToolResult('abc', 4000), 'abc');
const long = 'x'.repeat(5000);
const tr = truncateToolResult(long, 4000);
ok('超长被截断', tr.length < 5000);
ok('截断带标注', tr.indexOf('结果过长') !== -1 && tr.indexOf('4000') !== -1);
ok('标注后仍以原文开头', tr.indexOf('xxxx') === 0);
eq('边界相等不截断', truncateToolResult('y'.repeat(4000), 4000), 'y'.repeat(4000));
eq('null 安全', truncateToolResult(null, 4000), '');

console.log('== 2. toolCallSignature ==');
const tcA = { id: 'a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"上海"}' } };
const tcB = { id: 'b', type: 'function', function: { name: 'get_weather', arguments: '{"city":"上海"}' } };
const tcC = { id: 'c', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } };
eq('相同调用签名一致', toolCallSignature(tcA), toolCallSignature(tcB));
ok('不同参数签名不同', toolCallSignature(tcA) !== toolCallSignature(tcC));
eq('参数顺序不影响签名',
  toolCallSignature({ function: { name: 'f', arguments: '{"a":1,"b":2}' } }),
  toolCallSignature({ function: { name: 'f', arguments: '{"b":2,"a":1}' } }));
eq('坏 JSON 不崩', typeof toolCallSignature({ function: { name: 'f', arguments: '{oops' } }), 'string');

console.log('== 3. trimAgentMessages ==');
const sys = { role: 'system', content: 'sys' };
const u1 = { role: 'user', content: '你好' };
const mkRound = (i, big) => ([
  { role: 'assistant', content: '', tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'web_search', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'c' + i, content: big ? 'R'.repeat(12000) : '结果' + i },
]);
const msgs = [sys, u1, ...mkRound(0, true), ...mkRound(1, true), ...mkRound(2, false)];
const loopStart = 2;
// 不修改原数组
const before = JSON.stringify(msgs);
const trimmed = trimAgentMessages(msgs, loopStart, 24000);
eq('不修改原数组', JSON.stringify(msgs), before);
ok('超预算时被裁剪', trimmed.length < msgs.length);
eq('system 永不删除', trimmed[0], sys);
eq('历史 user 永不删除', trimmed[1], u1);
ok('最后一轮保留', trimmed[trimmed.length - 1].content === '结果2');
// 合法性：每条 assistant tool_calls 后都紧跟它的 tool 消息（无孤儿）
let legal = true;
for (let i = 0; i < trimmed.length; i++) {
  const m = trimmed[i];
  if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
    const ids = m.tool_calls.map(t => t.id);
    const followers = [];
    let j = i + 1;
    while (j < trimmed.length && trimmed[j].role === 'tool') { followers.push(trimmed[j].tool_call_id); j++; }
    for (const id of ids) if (followers.indexOf(id) === -1) legal = false;
  }
}
ok('裁剪后消息序列仍合法（无孤儿 tool_calls）', legal);
// 预算充足时原样返回
const small = [sys, u1, ...mkRound(0, false)];
eq('预算充足不裁剪', trimAgentMessages(small, 2, 24000).length, small.length);
// 极端：loopStartIdx 越界不崩
eq('越界下标安全', Array.isArray(trimAgentMessages(small, 9999, 10)), true);

console.log('== 4. 系统提示词回归 ==');
const need = ['绝不调用工具', '用一句话追问', '不要猜测调用工具', '接下来 1-2 步',
  '绝不出现函数名', '注明来源与时间', '反复调用没有意义'];
for (const s of need) ok('提示词包含「' + s + '」', src.indexOf(s) !== -1);

console.log('== 5. DSML 回归 ==');
const FW = '｜';
const shot = '查天气<' + FW + 'DSML' + FW + 'tool_calls><' + FW + 'DSML' + FW + 'invoke name="get_weather">' +
  '<' + FW + 'DSML' + FW + 'parameter name="city" string="true">上海</' + FW + 'DSML' + FW + 'parameter>' +
  '</' + FW + 'DSML' + FW + 'invoke></' + FW + 'DSML' + FW + 'tool_calls>';
eq('DSML 解析回归', parseDSMLToolCalls(shot).length, 1);

console.log('== 6. 循环接入点回归 ==');
ok('循环使用裁剪后的消息', src.indexOf('trimAgentMessages(messages, loopStartIdx, ctxBudget)') !== -1);
ok('reasoning_content 回传', src.indexOf("msg.reasoning_content || msg.reasoning") !== -1);
ok('重复调用熔断', src.indexOf('callSigHistory') !== -1 && src.indexOf('已停止以避免空转') !== -1);
ok('截断标注接入', src.indexOf('truncateToolResult(result, 4000)') !== -1);
ok('AGENT_CONTEXT_BUDGET 环境变量', src.indexOf('AGENT_CONTEXT_BUDGET') !== -1);

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
