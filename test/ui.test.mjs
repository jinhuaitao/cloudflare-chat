// 前端分片与演示页回归测试。
//
// 前端是「零构建」的：src/ui/*.js 每个文件导出一个模板字符串分片，index.js 按顺序拼成整页。
// 这个方案很轻，但有两个静默失效点，出错时不会报错、只会让页面白屏或行为跑偏：
//   1) 分片内的反斜杠会被模板字符串吃掉一层 —— 写一个 `\n` 就变成真换行，写 `\s` 就丢了；
//   2) 分片里的反引号会提前闭合模板字符串，整个模块直接语法错误。
// 所以这里把两条约束钉成断言：反斜杠必须成对出现、每个分片恰好两个反引号（定界符）。
//
// 另外两个断言针对本次修复的具体缺陷：
//   - tts-demo.html 必须与 src/ui/speech.js 的当前源码一致（否则演示页与线上行为分叉）；
//   - 组装后的页面必须真的含有 app-kb.js 需要的 DOM 节点（否则又是"孤儿文件"）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HTML_CONTENT } from '../src/ui/index.js';
import { cleanForSpeech, containsCJK } from '../src/ui/speech.js';
import { renderTtsDemo, TEMPLATE_PATH, OUTPUT_PATH } from '../scripts/build-tts-demo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI_DIR = path.join(ROOT, 'src', 'ui');
// 分片文件：index.js 是拼接器、speech.js 是普通模块，都不参与模板字符串约束
const FRAGMENTS = fs.readdirSync(UI_DIR)
  .filter(f => f.endsWith('.js') && f !== 'index.js' && f !== 'speech.js')
  .sort();

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

// ==================== 朗读文本清洗（行为契约） ====================

test('cleanForSpeech 摘掉标题 / 加粗 / 行内代码标记', () => {
  assert.equal(cleanForSpeech('## 标题'), '标题');
  assert.equal(cleanForSpeech('**粗** __粗2__ `code`'), '粗 粗2 code');
  assert.equal(cleanForSpeech('### 三级\n#### 四级'), '三级\n四级');
});

test('cleanForSpeech 代码块整段省略，图片只留提示，链接只念标题', () => {
  assert.equal(cleanForSpeech('```js\nconst a=1;\n```'), '（代码块已省略）');
  assert.equal(cleanForSpeech('![图](https://a/b.png)'), '（图片）');
  assert.equal(cleanForSpeech('[链接](https://a/b)'), '链接');
  // 代码块内的 ** 与 ` 不能被二次处理
  assert.equal(cleanForSpeech('```\n**not bold** `x`\n```'), '（代码块已省略）');
});

test('cleanForSpeech 去掉列表 / 引用 / 分隔线 / 表格符号', () => {
  assert.equal(cleanForSpeech('- 一\n- 二'), '一\n二');
  assert.equal(cleanForSpeech('1. 一\n2. 二'), '一\n二');
  assert.equal(cleanForSpeech('> 引用'), '引用');
  assert.equal(cleanForSpeech('---'), '');
  assert.equal(cleanForSpeech('a|b'), 'a b');
});

test('cleanForSpeech 压缩空行与首尾空白', () => {
  assert.equal(cleanForSpeech('段落一\n\n\n\n段落二'), '段落一\n\n段落二');
  assert.equal(cleanForSpeech('  前后空白  '), '前后空白');
  assert.equal(cleanForSpeech(''), '');
  assert.equal(cleanForSpeech(null), '');
  assert.equal(cleanForSpeech(undefined), '');
});

test('containsCJK 判定朗读语言', () => {
  assert.equal(containsCJK('中文'), true);
  assert.equal(containsCJK('中文 mixed English'), true);
  assert.equal(containsCJK('english only'), false);
  assert.equal(containsCJK(''), false);
  assert.equal(containsCJK(null), false);
});

// ==================== 演示页与单一来源 ====================

test('tts-demo.html 与 src/ui/speech.js 当前源码一致（防止两份实现分叉）', () => {
  const template = read(TEMPLATE_PATH);
  const expected = renderTtsDemo(template);
  const actual = read(OUTPUT_PATH);
  assert.equal(actual, expected,
    'tts-demo.html 已过期：执行 npm run build:tts-demo 重新生成');
});

test('tts-demo.html 只注入一份实现，且脚本可解析', () => {
  const html = read(OUTPUT_PATH);
  assert.equal((html.match(/function cleanForSpeech/g) || []).length, 1);
  assert.equal((html.match(/function containsCJK/g) || []).length, 1);
  assert.equal((html.match(/<script>/g) || []).length, 1);
  const inline = html.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(inline), '演示页脚本存在语法错误');
});

// ==================== 分片约束（模板字符串两层转义） ====================

test('每个 UI 分片恰好两个反引号（只作模板字符串定界符）', () => {
  for (const f of FRAGMENTS) {
    const src = read(path.join(UI_DIR, f));
    const ticks = (src.match(/`/g) || []).length;
    assert.equal(ticks, 2, f + ' 的反引号数量为 ' + ticks + '，会提前闭合模板字符串');
  }
});

test('每个 UI 分片里的反斜杠必须成对出现', () => {
  for (const f of FRAGMENTS) {
    const src = read(path.join(UI_DIR, f));
    const runs = src.match(/\\+/g) || [];
    const odd = runs.filter(r => r.length % 2 === 1);
    assert.equal(odd.length, 0,
      f + ' 存在奇数长度的反斜杠串（会被模板字符串吃掉一层）：' + odd.join(' '));
  }
});

// ==================== 组装产物 ====================

test('组装后的页面保留两个模板占位符', () => {
  assert.ok(HTML_CONTENT.includes('{{MODEL_OPTIONS}}'), '缺少模型下拉占位符');
  assert.ok(HTML_CONTENT.includes('{{APP_VERSION}}'), '缺少版本号占位符');
});

test('组装后的页面只有一个内联脚本块且可解析', () => {
  const inlineBlocks = HTML_CONTENT.match(/<script>/g) || [];
  assert.equal(inlineBlocks.length, 1);
  const inline = HTML_CONTENT.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(inline), '页面内联脚本存在语法错误');
});

test('脚本里 getElementById 的每个 id 都能在 HTML 里找到', () => {
  // 这是「孤儿文件」类缺陷的通用拦截器：app-kb.js 曾经找 #kbModal/#kbListBox，
  // 而 body.js 里根本没有这些节点 —— 脚本不报错、功能静默失效，只有人工点开才会发现。
  const inline = HTML_CONTENT.match(/<script>([\s\S]*)<\/script>/)[1];
  const ids = new Set();
  const re = /getElementById\(\s*'([^']+)'\s*\)/g;
  let m;
  while ((m = re.exec(inline)) !== null) ids.add(m[1]);
  assert.ok(ids.size > 10, '应当解析出多个 id，实际 ' + ids.size);

  const missing = [...ids].filter(id => !HTML_CONTENT.includes('id="' + id + '"'));
  assert.deepEqual(missing, [], '这些 id 在 HTML 里不存在：' + missing.join(', '));
});

test('Agent 专家徽标在样式、事件解析与历史重绘三处都已接线', () => {
  // 三处少任何一处，功能都会静默失效：没样式 → 裸文字挤在气泡里；
  // 没解析 → 服务端发了也不显示；没重绘 → 切会话回来徽标消失。
  const inline = HTML_CONTENT.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.ok(HTML_CONTENT.includes('.agent-persona {'), '缺少 .agent-persona 样式');
  assert.ok(inline.includes('agent_persona'), '未解析服务端下发的 agent_persona 事件');
  assert.ok(inline.includes('personaTrace'), '历史消息重绘未还原 personaTrace');
});

test('专家徽标可折叠详情在样式、构建、事件与持久化四处都已接线', () => {
  // 少任何一环都会「点得开但没内容」或「切会话回来点开是空的」：
  // 没样式 → 详情撑破气泡；没解析 detail → 只有一行摘要；没落库 → 重绘后明细丢失。
  const inline = HTML_CONTENT.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.ok(HTML_CONTENT.includes('.agent-persona-body'), '缺少详情面板样式');
  assert.ok(HTML_CONTENT.includes('.ap-rank-row'), '缺少打分行样式');
  assert.ok(inline.includes('function createPersonaCard'), '缺少统一的徽标构建函数');
  assert.ok(inline.includes('aria-expanded'), '折叠按钮缺少 aria-expanded');
  assert.ok(inline.includes('setAttribute(\'aria-expanded\''), '点击时应切换 aria-expanded');
  assert.ok(inline.includes('body.hidden'), '详情默认应收起');
  // 明细字段都要用到：结论、命中词、阶段、打分表、承接来源、固定提示
  for (const field of ['reasonText', 'matched', 'stages', 'ranked', 'continuedFrom', 'source === \'manual\'']) {
    assert.ok(inline.includes(field), '详情面板未消费字段：' + field);
  }
  // 流式路径与历史重绘必须共用同一构建函数，否则两处形态会分叉
  assert.ok(inline.includes('adata.agent_persona.trace, adata.agent_persona && adata.agent_persona.detail'),
    '流式接收未把 detail 传给徽标');
  assert.ok(inline.includes('msg.personaTrace, msg.personaDetail'), '历史重绘未传 personaDetail');
  // 明细要落库，否则切会话/刷新后胶囊还在、点开为空
  assert.ok(inline.includes('personaDetail: agentPersonaDetail'), '明细未写入消息对象');
  assert.ok(inline.includes('agentPersonaDetail = null'), '重置时未清理明细状态');
});

test('app-kb.js 需要的 DOM 节点与接口都已接线', () => {
  // 这三个 id 曾经在 body.js 里全都不存在，导致 app-kb.js 变成死代码
  for (const id of ['kbModal', 'kbModalToggle', 'kbCloseBtn', 'kbRefreshBtn', 'kbListBox']) {
    assert.ok(HTML_CONTENT.includes('id="' + id + '"'), '缺少 DOM 节点 #' + id);
  }
  // 且面板脚本必须真的被拼进页面
  assert.ok(HTML_CONTENT.includes('/api/kb/list'), '知识库面板脚本未被拼入页面');
  assert.ok(HTML_CONTENT.includes('kbLoadList'), '知识库面板脚本未被拼入页面');
});
