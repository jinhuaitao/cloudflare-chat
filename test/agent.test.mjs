// Agent 内核回归测试（node --test）
// 覆盖：并发闸门、上下文裁剪两阶段、失败判定、DSML 兼容、提示词、工具箱新动作、预算夹取。
// 这些模块都是纯函数/纯逻辑，不依赖 Cloudflare 运行时，可直接在 Node 里跑。

import test from 'node:test';
import assert from 'node:assert/strict';

import { mapLimit, mapSetBounded, mapGetBounded } from '../src/utils.js';
import {
  truncateToolResult,
  parseToolArguments,
  toolCallSignature,
  trimAgentMessages,
  trimAgentMessagesEx,
} from '../src/agent/stability.js';
import { agentLimits, describeToolCall } from '../src/agent/limits.js';
import { isToolFailureResult, getAgentTools } from '../src/agent/tools.js';
import { parseDSMLToolCalls, stripDSMLBlocks } from '../src/agent/dsml.js';
import { buildAgentSystemPrompt } from '../src/agent/prompt.js';
import { toolCalculate, toolToolkit, convertUnits, jsonQueryPath, toolGetTime } from '../src/agent/tools-local.js';

// ==================== 并发闸门 ====================
test('mapLimit 限制并发上限且保持结果顺序', async () => {
  let running = 0;
  let peak = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);
  const out = await mapLimit(items, 3, async (n) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise(r => setTimeout(r, 5));
    running -= 1;
    return n * 2;
  });
  assert.equal(peak <= 3, true, '并发峰值应不超过 3，实际 ' + peak);
  assert.deepEqual(out, items.map(n => n * 2));
});

test('mapLimit 处理空数组与非法 limit', async () => {
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
  const out = await mapLimit([1, 2], 0, async (n) => n + 1);
  assert.deepEqual(out, [2, 3]);
});

// ==================== 有界缓存 ====================
test('mapSetBounded 遵守容量上限并淘汰最旧', () => {
  const m = new Map();
  const exp = new Map();
  for (let i = 0; i < 5; i++) mapSetBounded(m, 'k' + i, i, 3, exp);
  assert.equal(m.size, 3);
  assert.equal(m.has('k0'), false);
  assert.equal(mapGetBounded(m, 'k4', exp), 4);
});

// ==================== 工具结果截断 ====================
test('truncateToolResult 自动闭合未配对的代码围栏', () => {
  const raw = '```js\n' + 'x'.repeat(5000);
  const out = truncateToolResult(raw, 100);
  const fences = out.match(/```/g) || [];
  assert.equal(fences.length % 2, 0, '围栏必须成对');
  assert.ok(out.includes('结果过长'));
});

test('truncateToolResult 未超长时原样返回', () => {
  assert.equal(truncateToolResult('short', 100), 'short');
});

// ==================== 工具参数修复 ====================
test('parseToolArguments 确定性修复被截断的参数 JSON', () => {
  const missingQuote = parseToolArguments('{"query":"北京天');
  assert.deepEqual(missingQuote.args, { query: '北京天' });
  assert.equal(missingQuote.repaired, true);

  assert.deepEqual(parseToolArguments('{"url":"https://example.com","offset":1').args,
    { url: 'https://example.com', offset: 1 });
  assert.deepEqual(parseToolArguments('{"city":"上海",').args, { city: '上海' });
  // 末尾半截键：丢掉没有值的键，保留前面完整的项
  assert.deepEqual(parseToolArguments('{"city":"上海","date":').args, { city: '上海' });
  // 误包 ```json 围栏
  assert.deepEqual(parseToolArguments('```json\n{"a":1}\n```').args, { a: 1 });

  assert.deepEqual(parseToolArguments('').args, {});
  assert.deepEqual(parseToolArguments(undefined).args, {});
  assert.deepEqual(parseToolArguments({ a: 1 }).args, { a: 1 });
});

test('parseToolArguments 修不好时返回可直接回灌的错误', () => {
  for (const bad of ['{"expression":1+1}', '完全不是 JSON', '{"a": tru']) {
    const r = parseToolArguments(bad);
    assert.equal(typeof r.error, 'string', '应判为失败：' + bad);
  }
  // 超长参数直接拒绝，不把几十 KB 的残片丢给 JSON.parse 与修复扫描
  assert.ok(parseToolArguments('{"a":"' + 'x'.repeat(20001) + '"}').error);
});

// ==================== 工具签名 ====================
test('toolCallSignature 忽略参数键顺序', () => {
  const a = { function: { name: 'web_fetch', arguments: '{"url":"u","offset":1}' } };
  const b = { function: { name: 'web_fetch', arguments: '{"offset":1,"url":"u"}' } };
  assert.equal(toolCallSignature(a), toolCallSignature(b));
  const c = { function: { name: 'web_fetch', arguments: '{"url":"u2","offset":1}' } };
  assert.notEqual(toolCallSignature(a), toolCallSignature(c));
});

test('toolCallSignature 把截断参数与补全参数视为同一次调用', () => {
  const truncated = { function: { name: 'web_fetch', arguments: '{"url":"u","offset":1' } };
  const full = { function: { name: 'web_fetch', arguments: '{"offset":1,"url":"u"}' } };
  assert.equal(toolCallSignature(truncated), toolCallSignature(full));
});

// ==================== 上下文预算：阶段 1（丢本轮旧轮次） ====================
test('trimAgentMessages 超预算时丢弃本轮较早的工具轮次并生成步骤摘要', () => {
  const messages = [
    { role: 'system', content: 'S'.repeat(400) },
    { role: 'user', content: 'U1' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'web_search', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'web_search', content: 'R'.repeat(400) },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c2', function: { name: 'web_fetch', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c2', name: 'web_fetch', content: 'T'.repeat(400) },
    { role: 'assistant', content: 'final' },
  ];
  const out = trimAgentMessages(messages, 2, 700);
  assert.equal(out[0].role, 'system');
  assert.ok(out[0].content.includes('早期步骤摘要'), '应生成工具步骤摘要');
  assert.ok(out.length < messages.length);
  // 原始数组不被修改
  assert.equal(messages.length, 7);
  // 被丢弃的 assistant(tool_calls) 与它的 tool 消息必须成对消失，不能留孤儿 tool
  const toolIds = out.filter(m => m.role === 'tool').map(m => m.tool_call_id);
  const callIds = out.flatMap(m => (m.tool_calls || []).map(tc => tc.id));
  for (const id of toolIds) assert.ok(callIds.includes(id), 'tool 消息 ' + id + ' 缺少对应的 tool_calls');
});

// ==================== 上下文预算：阶段 2（压缩历史） ====================
test('trimAgentMessages 在只裁本轮仍超预算时压缩更早的历史轮次', () => {
  const big = 'x'.repeat(300);
  const messages = [
    { role: 'system', content: big },
    { role: 'user', content: '旧问题一 ' + big },
    { role: 'assistant', content: '旧回答一 ' + big },
    { role: 'user', content: '旧问题二 ' + big },
    { role: 'assistant', content: '旧回答二 ' + big },
    { role: 'user', content: '旧问题三 ' + big },
    { role: 'assistant', content: '旧回答三 ' + big },
    { role: 'user', content: '本轮问题 ' + big },
  ];
  const out = trimAgentMessages(messages, 7, 1500);
  assert.equal(out[0].role, 'system');
  assert.ok(out[0].content.includes('更早的历史对话摘要'), '应压缩历史轮次');
  assert.equal(out[1].role, 'user', 'system 之后必须是 user 消息');
  assert.ok(out[out.length - 1].content.includes('本轮问题'), '本轮用户消息不能被裁掉');
  assert.equal(out.filter(m => m.role === 'system').length, 1, '只允许一条 system');
});

test('trimAgentMessages 未超预算时原样返回', () => {
  const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }];
  const out = trimAgentMessages(messages, 2, 24000);
  assert.deepEqual(out, messages);
});

test('trimAgentMessages 预算极紧时压缩全部历史，仍保持序列合法', () => {
  const big = 'y'.repeat(200);
  const messages = [
    { role: 'system', content: big },
    { role: 'user', content: 'u1 ' + big },
    { role: 'assistant', content: 'a1 ' + big },
    { role: 'user', content: 'u2 ' + big },
    { role: 'user', content: '本轮 ' + big },
  ];
  const out = trimAgentMessages(messages, 4, 300);
  assert.equal(out[0].role, 'system');
  assert.equal(out.length, 2);
  assert.equal(out[1].role, 'user');
  assert.ok(out[1].content.includes('本轮'));
});

test('trimAgentMessages 摘要兼容多模态历史，不出现 [object Object]', () => {
  const big = 'z'.repeat(200);
  const messages = [
    { role: 'system', content: big },
    { role: 'user', content: [{ type: 'text', text: '这张图里是什么 ' + big }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,xx' } }] },
    { role: 'assistant', content: '是一只猫 ' + big },
    { role: 'user', content: '再详细点 ' + big },
    { role: 'assistant', content: '好的 ' + big },
    { role: 'user', content: '本轮问题 ' + big },
  ];
  const out = trimAgentMessages(messages, 5, 500);
  assert.equal(out[0].role, 'system');
  assert.ok(out[0].content.includes('这张图里是什么'), '多模态文本应被提取');
  assert.equal(out[0].content.includes('[object Object]'), false);
});

// ==================== 上下文预算：v7.6.0 配对安全与硬预算 ====================
test('trimAgentMessages 压缩历史时不拆散工具轮次，且始终保留本轮问题', () => {
  const big = 'p'.repeat(400);
  const messages = [
    { role: 'system', content: 'S'.repeat(200) },
    { role: 'user', content: '旧问题 ' + big },
    { role: 'assistant', content: '', tool_calls: [{ id: 'h1', function: { name: 'web_search', arguments: '{"q":"x"}' } }] },
    { role: 'tool', tool_call_id: 'h1', name: 'web_search', content: '旧结果 ' + big },
    { role: 'assistant', content: '旧回答 ' + big },
    { role: 'user', content: '中间问题 ' + big },
    { role: 'assistant', content: '中间回答 ' + big },
    { role: 'user', content: '本轮问题' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'n1', function: { name: 'web_fetch', arguments: '{"url":"u"}' } }] },
    { role: 'tool', tool_call_id: 'n1', name: 'web_fetch', content: '新结果 ' + big },
  ];
  for (const budget of [300, 600, 900, 1200, 2000, 4000]) {
    const out = trimAgentMessages(messages, 7, budget);
    assert.ok(out.some(m => m.role === 'user' && String(m.content).includes('本轮问题')),
      '预算 ' + budget + ' 下本轮问题被裁掉');
    const callIds = new Set();
    for (const m of out) {
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) callIds.add(tc.id);
      }
    }
    for (const m of out) {
      if (m.role !== 'tool') continue;
      assert.ok(callIds.has(m.tool_call_id), '预算 ' + budget + ' 下出现孤儿 tool：' + m.tool_call_id);
    }
  }
});

test('trimAgentMessages 硬压缩让超大工具输出真正落回预算内', () => {
  const toolCalls = Array.from({ length: 8 }, (_, i) => ({
    id: 'c' + i,
    function: { name: 'web_fetch', arguments: '{"url":"u' + i + '"}' },
  }));
  const messages = [
    { role: 'system', content: 'S' },
    { role: 'user', content: '本轮问题' },
    { role: 'assistant', content: '', tool_calls: toolCalls },
    ...toolCalls.map(tc => ({ role: 'tool', tool_call_id: tc.id, name: 'web_fetch', content: 'R'.repeat(4000) })),
  ];
  const out = trimAgentMessages(messages, 2, 9000);
  const total = out.reduce((s, m) => s + JSON.stringify(m).length, 0);
  assert.equal(out.filter(m => m.role === 'tool').length, 8, '工具结果只能压缩，不能丢弃');
  assert.ok(total <= 9000, '实际总长 ' + total);
  assert.ok(out.some(m => m.role === 'tool' && m.content.includes('已压缩以节省上下文')));
});

test('trimAgentMessages 预算极紧时也不压缩最后一条用户消息', () => {
  const messages = [
    { role: 'system', content: 'S'.repeat(400) },
    { role: 'user', content: '旧问题' },
    { role: 'assistant', content: 'A'.repeat(400) },
    { role: 'user', content: '本轮问题' },
  ];
  const out = trimAgentMessages(messages, messages.length, 120);
  assert.equal(out[out.length - 1].role, 'user');
  assert.equal(out[out.length - 1].content, '本轮问题');
});

test('trimAgentMessagesEx 返回修正后的本轮起点，二次裁剪不产生孤儿 tool', () => {
  const big = 'q'.repeat(400);
  const messages = [
    { role: 'system', content: 'S' },
    { role: 'user', content: '旧问题 ' + big },
    { role: 'assistant', content: '', tool_calls: [{ id: 'h1', function: { name: 'web_search', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'h1', name: 'web_search', content: '旧结果 ' + big },
    { role: 'assistant', content: '旧回答 ' + big },
    { role: 'user', content: '本轮问题' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'n1', function: { name: 'web_fetch', arguments: '{"url":"u"}' } }] },
    { role: 'tool', tool_call_id: 'n1', name: 'web_fetch', content: '新结果 ' + big },
  ];
  const r = trimAgentMessagesEx(messages, 5, 500);
  assert.ok(r.loopStartIdx > 0);
  assert.equal(r.messages[r.loopStartIdx].role, 'user', '起点必须落在本轮第一条消息上');
  assert.ok(String(r.messages[r.loopStartIdx].content).includes('本轮问题'));
  assert.ok(r.hardTrimmed === true || r.messages.length < messages.length);

  const again = trimAgentMessagesEx(r.messages, r.loopStartIdx, 400);
  const callIds = new Set();
  for (const m of again.messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) callIds.add(tc.id);
    }
  }
  for (const m of again.messages) {
    if (m.role === 'tool') assert.ok(callIds.has(m.tool_call_id), '孤儿 tool：' + m.tool_call_id);
  }
});

// ==================== 失败判定 ====================
test('isToolFailureResult 正确区分失败与成功', () => {
  const failures = [
    '搜索失败: 超时',
    '搜索「量子计算」无结果',
    '抓取失败，HTTP 403',
    '该地址禁止抓取（内网 / 本机 / 云元数据地址）',
    '工具 web_fetch 执行超时（30 秒），已跳过',
    '未知工具: foo',
    'R2 未绑定，无法读取知识库文档',
    '请给出要读取的文档标题关键词',
    '单位换算失败: 不支持的单位（a → b）',
    'JSON 解析失败: Unexpected token',
    '',
  ];
  for (const s of failures) assert.equal(isToolFailureResult(s), true, '应判为失败：' + s);

  const ok = [
    '已记住：我养了一只猫（共1条）',
    '计算结果：42',
    '【维基百科 (zh)：《量子力学》】\n链接：…',
    '已删除知识库文档《旧笔记》',
  ];
  for (const s of ok) assert.equal(isToolFailureResult(s), false, '应判为成功：' + s);
});

test('isToolFailureResult 识别 v7.6.0 新增的失败文案', () => {
  const failures = [
    '工具调用参数解析失败：JSON 不完整或格式错误。本次调用已跳过，请补齐被截断的引号/括号后重新输出完整 JSON 参数再试。',
    '抓取失败：网页 1（https://example.com） 超时',
    '抓取失败：偏移量 offset=99999 已超出页面正文总长度（3210 字符），请改用更小的 offset。',
    '文档读取失败：偏移量 offset=99999 已超出文档总长度（3210 字符），请改用更小的 offset；或传 offset=0 从头读。',
  ];
  for (const s of failures) assert.equal(isToolFailureResult(s), true, '应判为失败：' + s);
});

// ==================== 预算夹取 ====================
test('agentLimits 夹取非法与越界的环境变量', () => {
  const a = agentLimits({});
  assert.equal(a.maxSteps, 6);
  assert.equal(a.toolConcurrency, 4);
  assert.equal(a.ctxBudget, 24000);

  const b = agentLimits({ AGENT_MAX_STEPS: '99', AGENT_TOOL_CONCURRENCY: '99', AGENT_CONTEXT_BUDGET: '1', AGENT_TOOL_TIMEOUT_MS: '1' });
  assert.equal(b.maxSteps, 12);
  assert.equal(b.toolConcurrency, 8);
  assert.equal(b.ctxBudget, 6000);
  assert.equal(b.toolTimeoutMs, 1000);

  const c = agentLimits({ AGENT_MAX_STEPS: '-3', AGENT_TOOL_CONCURRENCY: 'abc', AGENT_CONTEXT_BUDGET: '0' });
  assert.equal(c.maxSteps, 6);
  assert.equal(c.toolConcurrency, 4);
  assert.equal(c.ctxBudget, 24000);
});

test('describeToolCall 覆盖全部工具名', () => {
  const names = getAgentTools(false).map(t => t.function.name);
  for (const n of names) {
    const d = describeToolCall(n, {});
    assert.equal(typeof d, 'string');
    assert.ok(d.length > 0);
    assert.equal(d.indexOf('正在调用：' + n) === -1, true, n + ' 缺少专属进度文案');
  }
});

// ==================== 工具集动态裁剪 ====================
test('getAgentTools 按只读端与知识库状态裁剪', () => {
  const all = getAgentTools(false).map(t => t.function.name);
  const ro = getAgentTools(true).map(t => t.function.name);
  for (const w of ['remember', 'forget_memory', 'save_doc', 'delete_doc']) {
    assert.ok(all.includes(w), '写入端应包含 ' + w);
    assert.equal(ro.includes(w), false, '只读端不应包含 ' + w);
  }
  const emptyKb = getAgentTools(true, { hasKbDocs: false }).map(t => t.function.name);
  assert.equal(emptyKb.includes('list_docs'), false);
  assert.equal(emptyKb.includes('read_doc'), false);
});

// ==================== DSML 兼容 ====================
test('parseDSMLToolCalls 解析文本式工具调用', () => {
  const text = '我先查一下。\n<｜DSML｜tool_calls><｜DSML｜invoke name="get_weather">'
    + '<｜DSML｜parameter name="city" string="true">上海</｜DSML｜parameter>'
    + '</｜DSML｜invoke></｜DSML｜tool_calls>';
  const calls = parseDSMLToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'get_weather');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { city: '上海' });
  assert.equal(stripDSMLBlocks(text).trim(), '我先查一下。');
});

test('stripDSMLBlocks 无标记时幂等', () => {
  const t = '普通回答，没有工具标记。';
  assert.equal(stripDSMLBlocks(t), t);
});

// ==================== 系统提示词 ====================
test('buildAgentSystemPrompt 包含铁律、工具速查与时间', () => {
  const p = buildAgentSystemPrompt([], '北京天气', null, false);
  assert.ok(p.includes('【铁律】'));
  assert.ok(p.includes('【工具速查】'));
  assert.ok(p.includes('北京时间'));
  assert.ok(p.includes('web_search'));
  assert.ok(p.includes('不编造'));
});

// v7.12.1 准确率：提示词必须包含来源交叉验证与搜索关键词策略
test('buildAgentSystemPrompt 含交叉验证规则与搜索关键词策略', () => {
  const p = buildAgentSystemPrompt([], 'Python 3.13 有什么新特性', null, false);
  // 铁律 3：关键数字双源交叉印证
  assert.ok(p.includes('交叉印证'), '应要求关键数字与结论交叉印证');
  assert.ok(p.includes('来源冲突'), '应说明来源冲突时的取舍规则');
  // 搜索策略：技术类英文关键词、时效词带年份
  assert.ok(p.includes('英文'), '应指引技术类搜索用英文关键词');
  assert.ok(p.includes('年份'), '应指引时效性搜索带年份');
  // 输出要求：时效不确定要标注
  assert.ok(p.includes('时效未确认'), '时效无法确认时应要求标注');
});

test('buildAgentSystemPrompt 只读端声明写入限制', () => {
  const ro = buildAgentSystemPrompt([], '记住我喜欢咖啡', [], true);
  assert.ok(ro.includes('只读限制'));
  assert.equal(ro.includes('【写入纪律】'), false);

  const rw = buildAgentSystemPrompt([], '记住我喜欢咖啡', [], false);
  assert.ok(rw.includes('【写入纪律】'));
});

test('buildAgentSystemPrompt 注入知识库列表与相关记忆', () => {
  const docs = [{ title: '甲骨文云ARM', source: 'https://example.com/a' }, { title: '周报模板' }];
  const mems = [{ fact: '用户的猫叫汤圆', ts: 1 }, { fact: '用户在杭州工作', ts: 2 }];
  const p = buildAgentSystemPrompt(mems, '汤圆最近怎么样', docs, false);
  assert.ok(p.includes('【知识库文档列表】'));
  assert.ok(p.includes('《甲骨文云ARM》'));
  assert.ok(p.includes('据知识库文档'));
  assert.ok(p.includes('【关于用户的长期记忆】'));
  assert.ok(p.includes('汤圆'));
});

test('buildAgentSystemPrompt 记忆按相关性排序', () => {
  const mems = [
    { fact: '用户喜欢喝茶', ts: 2 },
    { fact: '用户的猫叫汤圆', ts: 1 },
  ];
  const p = buildAgentSystemPrompt(mems, '汤圆', [], false);
  const idxCat = p.indexOf('汤圆');
  const idxTea = p.indexOf('喝茶');
  assert.ok(idxCat !== -1 && idxTea !== -1);
  assert.ok(idxCat < idxTea, '更相关的记忆应排在前面');
});

// ==================== 计算与工具箱 ====================
test('toolCalculate 支持批量与运算符优先级', () => {
  assert.equal(toolCalculate('1+2*3'), '计算结果：7');
  assert.ok(toolCalculate('2^10; sqrt(16); 10%3').includes('1024'));
  assert.ok(toolCalculate('2^10; sqrt(16); 10%3').includes('4'));
  assert.equal(toolCalculate(''), '表达式为空');
  assert.ok(toolCalculate('1+').includes('计算失败'));
});

test('convertUnits 覆盖温度、油耗、中制单位', () => {
  assert.ok(convertUnits(100, 'c', 'f').includes('212'));
  assert.ok(convertUnits(1, 'kg', '斤').includes('2'));
  assert.ok(convertUnits(1, 'm2', '亩').includes('0.0015'));
  assert.ok(convertUnits(1, 'km', 'kg').includes('不同量纲'));
});

test('toolToolkit 新增 json 与 regex 动作', async () => {
  const fmt = await toolToolkit({ action: 'json_format', input: '{"b":1,"a":[2,3]}' });
  assert.ok(fmt.includes('JSON 合法'));
  assert.ok(fmt.includes('"a"'));

  const bad = await toolToolkit({ action: 'json_format', input: '{oops' });
  assert.ok(bad.startsWith('JSON 解析失败'));

  const q = await toolToolkit({ action: 'json_query', input: '{"data":{"items":[{"name":"x"}]}}', path: 'data.items[0].name' });
  assert.ok(q.includes('x'));

  const qBad = await toolToolkit({ action: 'json_query', input: '{"a":1}', path: 'a.b' });
  assert.ok(qBad.startsWith('JSON 取值失败'));

  const re = await toolToolkit({ action: 'regex_test', input: 'a1 b2 c3', pattern: '([a-z])(\\d)', flags: 'g' });
  assert.ok(re.includes('匹配到 3 处'));
  assert.ok(re.includes('分组'));

  const reBad = await toolToolkit({ action: 'regex_test', input: 'x', pattern: '(' });
  assert.ok(reBad.startsWith('正则编译失败'));
});

test('jsonQueryPath 处理数组下标与缺失键', () => {
  const root = { a: { b: [{ c: 7 }] } };
  assert.equal(jsonQueryPath(root, 'a.b[0].c').value, 7);
  assert.equal(jsonQueryPath(root, '$.a.b.0.c').value, 7);
  assert.ok(jsonQueryPath(root, 'a.zzz').error);
  assert.ok(jsonQueryPath(root, 'a.b[9].c').error);
});

test('toolGetTime 支持日期差与加减天数', () => {
  const out = toolGetTime('Asia/Shanghai', { base_date: '2026-01-01', target_date: '2026-01-31' });
  assert.ok(out.includes('30 天'));
  const out2 = toolGetTime('Asia/Shanghai', { base_date: '2026-01-31', add_days: 1 });
  assert.ok(out2.includes('2026-02-01'));
  const bad = toolGetTime('Asia/Shanghai', { base_date: '2026-13-01', target_date: '2026-12-01' });
  assert.ok(bad.includes('日期格式无效'));
});
