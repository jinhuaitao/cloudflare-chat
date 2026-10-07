// v6.6.4 DSML 兼容测试：从 _worker.js 提取 parseDSMLToolCalls / stripDSMLBlocks 后断言
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '_worker.js'), 'utf8');
const startMark = '// 从文本中提取 DSML 工具调用，转成 OpenAI 标准 tool_calls 数组；找不到返回 []。';
const endMark = '// ==================== Telegram Agent：主循环 ====================';
const si = src.indexOf(startMark);
const ei = src.indexOf(endMark);
if (si === -1 || ei === -1 || ei <= si) { console.error('FAIL: 无法在 _worker.js 中定位 DSML 函数'); process.exit(1); }
const fnSrc = src.slice(si, ei);
eval(fnSrc); // 定义 parseDSMLToolCalls / stripDSMLBlocks

const FW = '｜'; // U+FF5C 全角竖线（DeepSeek 官方 DSML 标记用这个）
let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '\n    实际: ' + a + '\n    期望: ' + e); }
}

console.log('== 1. 截图原案：全角 DSML 天气调用 ==');
const shot =
  '让我查询一下上海的详细天气数据。\n' +
  '<' + FW + 'DSML' + FW + 'tool_calls>\n' +
  '<' + FW + 'DSML' + FW + 'invoke name="get_weather">\n' +
  '<' + FW + 'DSML' + FW + 'parameter name="city" string="true">上海</' + FW + 'DSML' + FW + 'parameter>\n' +
  '</' + FW + 'DSML' + FW + 'invoke>\n' +
  '</' + FW + 'DSML' + FW + 'tool_calls>';
const c1 = parseDSMLToolCalls(shot);
eq('解析出 1 个调用', c1.length, 1);
eq('工具名', c1[0] && c1[0].function.name, 'get_weather');
eq('参数', c1[0] && JSON.parse(c1[0].function.arguments), { city: '上海' });
eq('type 字段', c1[0] && c1[0].type, 'function');
eq('id 前缀', !!(c1[0] && /^call_dsml_/.test(c1[0].id)), true);
eq('剥离后只剩正文', stripDSMLBlocks(shot).trim(), '让我查询一下上海的详细天气数据。');

console.log('== 2. 半角竖线 + 标签内空格（截图渲染形态） ==');
const ascii =
  'xxx< | DSML | tool_calls>\n< | DSML | invoke name="get_time">\n' +
  '< | DSML | parameter name="timezone" string="true">Asia/Shanghai</ | DSML | parameter>\n' +
  '</ | DSML | invoke>\n</ | DSML | tool_calls>yyy';
const c2 = parseDSMLToolCalls(ascii);
eq('解析出 1 个调用', c2.length, 1);
eq('工具名', c2[0] && c2[0].function.name, 'get_time');
eq('参数', c2[0] && JSON.parse(c2[0].function.arguments), { timezone: 'Asia/Shanghai' });
eq('剥离干净', stripDSMLBlocks(ascii), 'xxxyyy');

console.log('== 3. 外层标签变体 function_calls / calls ==');
for (const outer of ['function_calls', 'calls']) {
  const t = '<' + FW + 'DSML' + FW + outer + '><' + FW + 'DSML' + FW + 'invoke name="calculate">' +
    '<' + FW + 'DSML' + FW + 'parameter name="expression" string="true">1+1</' + FW + 'DSML' + FW + 'parameter>' +
    '</' + FW + 'DSML' + FW + 'invoke></' + FW + 'DSML' + FW + outer + '>';
  const c = parseDSMLToolCalls(t);
  eq(outer + ' 解析', c.length === 1 && c[0].function.name, 'calculate');
  eq(outer + ' 剥离', stripDSMLBlocks('a' + t + 'b'), 'ab');
}

console.log('== 4. string="false" 按 JSON 解析（数字/布尔/对象） ==');
const j = '<' + FW + 'DSML' + FW + 'tool_calls><' + FW + 'DSML' + FW + 'invoke name="calculate">' +
  '<' + FW + 'DSML' + FW + 'parameter name="a" string="false">5</' + FW + 'DSML' + FW + 'parameter>' +
  '<' + FW + 'DSML' + FW + 'parameter name="b" string="false">true</' + FW + 'DSML' + FW + 'parameter>' +
  '<' + FW + 'DSML' + FW + 'parameter name="c">默认字符串</' + FW + 'DSML' + FW + 'parameter>' +
  '</' + FW + 'DSML' + FW + 'invoke></' + FW + 'DSML' + FW + 'tool_calls>';
const c4 = parseDSMLToolCalls(j);
eq('数字/布尔/默认字符串', c4[0] && JSON.parse(c4[0].function.arguments), { a: 5, b: true, c: '默认字符串' });

console.log('== 5. 同块多 invoke + 多块 ==');
const multi =
  '<' + FW + 'DSML' + FW + 'tool_calls>' +
  '<' + FW + 'DSML' + FW + 'invoke name="get_weather"><' + FW + 'DSML' + FW + 'parameter name="city" string="true">北京</' + FW + 'DSML' + FW + 'parameter></' + FW + 'DSML' + FW + 'invoke>' +
  '<' + FW + 'DSML' + FW + 'invoke name="get_weather"><' + FW + 'DSML' + FW + 'parameter name="city" string="true">上海</' + FW + 'DSML' + FW + 'parameter></' + FW + 'DSML' + FW + 'invoke>' +
  '</' + FW + 'DSML' + FW + 'tool_calls>';
const c5 = parseDSMLToolCalls(multi + '中间文字' + multi);
eq('两个块共 4 个调用', c5.length, 4);
eq('调用 id 唯一', new Set(c5.map(x => x.id)).size, 4);
eq('多块剥离', stripDSMLBlocks('前' + multi + '中间文字' + multi + '后'), '前中间文字后');

console.log('== 6. 异常输入不崩 ==');
eq('无 DSML 返回 []', parseDSMLToolCalls('今天天气不错'), []);
eq('无 DSML 剥离原文返回', stripDSMLBlocks('今天天气不错'), '今天天气不错');
const noName = '<' + FW + 'DSML' + FW + 'tool_calls><' + FW + 'DSML' + FW + 'invoke><' + FW + 'DSML' + FW + 'parameter name="x" string="true">1</' + FW + 'DSML' + FW + 'parameter></' + FW + 'DSML' + FW + 'invoke></' + FW + 'DSML' + FW + 'tool_calls>';
eq('无名 invoke 被跳过', parseDSMLToolCalls(noName).length, 0);
const unclosed = '正文<' + FW + 'DSML' + FW + 'tool_calls><' + FW + 'DSML' + FW + 'invoke name="get_time"><' + FW + 'DSML' + FW + 'parameter name="timezone" string="true">UTC</' + FW + 'DSML' + FW + 'parameter></' + FW + 'DSML' + FW + 'invoke>';
const c6 = parseDSMLToolCalls(unclosed);
eq('未闭合块仍能解析', c6.length === 1 && c6[0].function.name, 'get_time');
eq('未闭合块剥离', stripDSMLBlocks(unclosed), '正文');
eq('空字符串', parseDSMLToolCalls('').length, 0);

console.log('== 7. end▁of▁sentence 结束符剥离 ==');
const eos = '答案是42<' + FW + 'end▁of▁sentence' + FW + '>';
eq('结束符被剥离', stripDSMLBlocks(eos), '答案是42');

console.log('== 8. 剥离幂等 ==');
const once = stripDSMLBlocks(shot);
eq('二次剥离结果一致', stripDSMLBlocks(once), once);

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
