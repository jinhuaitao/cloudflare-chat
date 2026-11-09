// Telegram 通道纯函数回归测试（node --test）
//
// 为什么单独一个文件：`parseCommand` / `inspectGroupTrigger` / `splitTelegramMarkdown`
// 这三个函数决定了「一条消息到底会不会被响应、响应什么、怎么切」，
// 但此前完全没有测试 —— 和上一轮补 wechat 时的情况一模一样。
// 它们都是纯函数（不碰网络、不碰 R2），改错一个正则的表现是
// 「群里 @ 了机器人却没反应」或「长回复被切成乱码」，在没有真实 TG 环境时只能靠这里发现。
//
// 全部离线。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCommand,
  inspectGroupTrigger,
  splitTelegramMarkdown,
} from '../src/telegram/handler.js';

const BOT = { id: 123456, username: 'my_bot' };

// ==================== parseCommand ====================

test('parseCommand：裸命令与带参命令', () => {
  assert.deepEqual(parseCommand('/help', 'my_bot'), { cmd: '/help', rest: '', forOtherBot: false });
  assert.deepEqual(parseCommand('/model 2', 'my_bot'), { cmd: '/model', rest: '2', forOtherBot: false });
  assert.deepEqual(parseCommand('  /draw  一只猫  ', 'my_bot'),
    { cmd: '/draw', rest: '一只猫', forOtherBot: false });
});

test('parseCommand：@自己 视为本机命令，@别人 标记 forOtherBot', () => {
  assert.deepEqual(parseCommand('/help@my_bot', 'my_bot'), { cmd: '/help', rest: '', forOtherBot: false });
  assert.equal(parseCommand('/help@other_bot', 'my_bot').forOtherBot, true);
});

test('parseCommand：命令名统一小写', () => {
  assert.equal(parseCommand('/HELP', 'my_bot').cmd, '/help');
  assert.equal(parseCommand('/Model 3', 'my_bot').cmd, '/model');
});

test('parseCommand：未知 bot 身份时不判定 forOtherBot', () => {
  // 私聊场景不传 botUsername，任何 @ 后缀都不该被当成"发给别人"
  assert.equal(parseCommand('/help@whatever', null).forOtherBot, false);
  assert.equal(parseCommand('/help@whatever', '').forOtherBot, false);
});

test('parseCommand：普通文本与空串返回 null', () => {
  assert.equal(parseCommand('你好', 'my_bot'), null);
  assert.equal(parseCommand('', 'my_bot'), null);
  assert.equal(parseCommand('   ', 'my_bot'), null);
  assert.equal(parseCommand(null, 'my_bot'), null);
});

test('parseCommand：单个斜杠或含空格的非命令不误判', () => {
  assert.equal(parseCommand('/', 'my_bot'), null);
  assert.equal(parseCommand('/ help', 'my_bot'), null);
  assert.equal(parseCommand('1/2 是一半', 'my_bot'), null);
});

// ==================== inspectGroupTrigger ====================

test('inspectGroupTrigger：私聊一律响应，且不改写文本', () => {
  const r = inspectGroupTrigger({ chat: { type: 'private' }, text: '你好' }, BOT, false);
  assert.equal(r.shouldHandle, true);
  assert.equal(r.isGroup, false);
  assert.equal(r.cleanedText, '你好');
});

test('inspectGroupTrigger：群组未 @ 不响应', () => {
  const r = inspectGroupTrigger({ chat: { type: 'group' }, text: '大家好' }, BOT, false);
  assert.equal(r.shouldHandle, false);
  assert.equal(r.isGroup, true);
});

test('inspectGroupTrigger：@机器人 响应并剥离 @', () => {
  const r = inspectGroupTrigger({ chat: { type: 'group' }, text: '@my_bot 你好' }, BOT, false);
  assert.equal(r.shouldHandle, true);
  assert.equal(r.mentioned, true);
  assert.equal(r.cleanedText, '你好');
});

test('inspectGroupTrigger：@机器人 后直接跟中文标点时，标点一并削掉', () => {
  // 旧实现只删 @my_bot，会留下「，帮我查天气」——模型能懂，但观感很差
  for (const [input, expected] of [
    ['@my_bot，帮我查天气', '帮我查天气'],
    ['@my_bot。再查一下汇率', '再查一下汇率'],
    ['@my_bot：总结这段', '总结这段'],
    ['@my_bot！继续', '继续'],
  ]) {
    const r = inspectGroupTrigger({ chat: { type: 'group' }, text: input }, BOT, false);
    assert.equal(r.cleanedText, expected, input);
  }
});

test('inspectGroupTrigger：@机器人 后跟空格/换行时正常剥离', () => {
  assert.equal(
    inspectGroupTrigger({ chat: { type: 'group' }, text: '@my_bot\n总结一下' }, BOT, false).cleanedText,
    '总结一下'
  );
  assert.equal(
    inspectGroupTrigger({ chat: { type: 'group' }, text: '@my_bot   多空格' }, BOT, false).cleanedText,
    '多空格'
  );
});

test('inspectGroupTrigger：@其他用户不响应', () => {
  const r = inspectGroupTrigger({ chat: { type: 'group' }, text: '@someone_else 你好' }, BOT, false);
  assert.equal(r.shouldHandle, false);
});

test('inspectGroupTrigger：发给别的机器人的命令不响应', () => {
  const r = inspectGroupTrigger({ chat: { type: 'group' }, text: '/help@other_bot' }, BOT, false);
  assert.equal(r.shouldHandle, false);
});

test('inspectGroupTrigger：发给自己的命令直接响应，不做 @ 剥离', () => {
  const r = inspectGroupTrigger({ chat: { type: 'group' }, text: '/help@my_bot' }, BOT, false);
  assert.equal(r.shouldHandle, true);
  assert.equal(r.cleanedText, '/help@my_bot', '命令原文应完整保留');
});

test('inspectGroupTrigger：回复机器人消息时响应', () => {
  const r = inspectGroupTrigger({
    chat: { type: 'group' },
    text: '继续',
    reply_to_message: { from: { id: BOT.id, username: BOT.username } },
  }, BOT, false);
  assert.equal(r.shouldHandle, true);
  assert.equal(r.repliedToBot, true);
  assert.equal(r.cleanedText, '继续');
});

test('inspectGroupTrigger：回复别人的消息不响应', () => {
  const r = inspectGroupTrigger({
    chat: { type: 'group' },
    text: '继续',
    reply_to_message: { from: { id: 999, username: 'someone' } },
  }, BOT, false);
  assert.equal(r.shouldHandle, false);
});

test('inspectGroupTrigger：replyAllInGroup 打开后任何群消息都响应', () => {
  const r = inspectGroupTrigger({ chat: { type: 'group' }, text: '随便说说' }, BOT, true);
  assert.equal(r.shouldHandle, true);
  assert.equal(r.cleanedText, '随便说说');
});

test('inspectGroupTrigger：text_mention 实体（无用户名的用户）也能触发', () => {
  const r = inspectGroupTrigger({
    chat: { type: 'group' },
    text: '小王 你好',
    entities: [{ type: 'text_mention', user: { id: BOT.id } }],
  }, BOT, false);
  assert.equal(r.shouldHandle, true);
  assert.equal(r.mentioned, true);
});

test('inspectGroupTrigger：supergroup 与 group 同等对待', () => {
  const r = inspectGroupTrigger({ chat: { type: 'supergroup' }, text: '@my_bot hi' }, BOT, false);
  assert.equal(r.isGroup, true);
  assert.equal(r.shouldHandle, true);
});

test('inspectGroupTrigger：只有图片没有文字时用 caption 判定', () => {
  const r = inspectGroupTrigger({
    chat: { type: 'group' },
    caption: '@my_bot 这是什么',
    photo: [{ file_id: 'x' }],
  }, BOT, false);
  assert.equal(r.shouldHandle, true);
  assert.equal(r.cleanedText, '这是什么');
});

test('inspectGroupTrigger：空消息不崩', () => {
  const r = inspectGroupTrigger({ chat: { type: 'group' } }, BOT, false);
  assert.equal(r.shouldHandle, false);
  assert.equal(r.cleanedText, '');
});

// ==================== splitTelegramMarkdown ====================

test('splitTelegramMarkdown：短文本原样返回单段', () => {
  assert.deepEqual(splitTelegramMarkdown('短消息'), ['短消息']);
  assert.deepEqual(splitTelegramMarkdown(''), []);
});

test('splitTelegramMarkdown：恰好等于上限时不切', () => {
  const s = 'a'.repeat(100);
  assert.deepEqual(splitTelegramMarkdown(s, 100), [s]);
});

test('splitTelegramMarkdown：优先在换行处切，且每段不超限', () => {
  const line = 'x'.repeat(60);
  const text = [line, line, line, line, line].join('\n');
  const chunks = splitTelegramMarkdown(text, 200);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.length <= 200, '段长=' + c.length);
  // 拼接后内容不丢（换行可能被切走，按字符集比较）
  assert.equal(chunks.join('').replace(/\n/g, ''), text.replace(/\n/g, ''));
});

test('splitTelegramMarkdown：换行位置太靠前时改为硬切（不产生超短首段）', () => {
  // 第 10 个字符处有换行，阈值是 maxLength 的 75%，不该在那么早的位置切
  const text = '0123456789\n' + 'y'.repeat(500);
  const chunks = splitTelegramMarkdown(text, 200);
  assert.ok(chunks[0].length > 150, '首段长度=' + chunks[0].length);
  assert.ok(chunks[0].length <= 200);
});

test('splitTelegramMarkdown：阈值随 maxLength 缩放，不是写死的绝对值', () => {
  // 换行落在 maxLength 的 80% 处（> 75%），应当按换行切
  const head = 'z'.repeat(160);
  const text = head + '\n' + 'w'.repeat(300);
  const chunks = splitTelegramMarkdown(text, 200);
  assert.equal(chunks[0], head, '应在换行处切开');

  // 同样比例、更小的 maxLength 也应按换行切（旧实现写死 3000，这里会退化成硬切）
  const head2 = 'q'.repeat(40);
  const text2 = head2 + '\n' + 'r'.repeat(300);
  const chunks2 = splitTelegramMarkdown(text2, 50);
  assert.equal(chunks2[0], head2, '小 maxLength 下也应按换行切');
});

test('splitTelegramMarkdown：跨分片的代码围栏自动闭合与续开', () => {
  const text = 'A'.repeat(300) + '\n```js\n' + 'const a = 1;\n'.repeat(40) + '```\n' + 'B'.repeat(200);
  const chunks = splitTelegramMarkdown(text, 400);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    const fences = (c.match(/```/g) || []).length;
    assert.equal(fences % 2, 0, '每段围栏必须成对：' + JSON.stringify(c.slice(0, 40)));
  }
  // 被切开的代码块在下一段应重新带上语言标记
  const hasLangRestore = chunks.slice(1).some(c => c.indexOf('```js') === 0);
  assert.ok(hasLangRestore, '下一段应续开带语言标记的围栏');
});

test('splitTelegramMarkdown：无围栏的纯文本不会被加上围栏', () => {
  const text = 'a'.repeat(500);
  const chunks = splitTelegramMarkdown(text, 200);
  for (const c of chunks) assert.equal(c.indexOf('```'), -1);
});

test('splitTelegramMarkdown：多段时总长度不显著膨胀（只在围栏处加少量字符）', () => {
  const text = 'a'.repeat(1000);
  const chunks = splitTelegramMarkdown(text, 200);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  assert.equal(total, 1000, '无围栏时不应插入任何额外字符');
});
