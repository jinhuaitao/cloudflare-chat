// 微信 ClawBot 通道回归测试：零依赖 MD5 / AES-128-ECB、Markdown→微信排版、
// 文本分段与中英双语口令解析。
//
// 为什么单独一个文件：这几段是整个通道里"纯逻辑"的部分（不碰网络、不碰 R2），
// 之前完全没有测试 —— 而 MD5 与 AES 是手写的密码学实现，改错一行不会报错，
// 只会在真机上表现为"发图失败"或"文件解密乱码"。这里用 node:crypto 做交叉验证。

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  md5Hex,
  parseIlinkAesKey,
  encryptAes128Ecb,
  decryptAes128Ecb,
  formatWechatText,
  decodeTextSmart,
} from '../src/wechat/ilink.js';
import { splitWechatText, parseWxCommand,
  getWxCredentials, saveWxCredentials, clearWxCredentials,
  getWxCursor, saveWxCursor, getWxContextToken, saveWxContextToken } from '../src/wechat/handler.js';

const enc = new TextEncoder();

function hexOf(u8) {
  return Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ==================== MD5 ====================

test('md5Hex 标准测试向量', () => {
  assert.equal(md5Hex(enc.encode('')), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(md5Hex(enc.encode('abc')), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(md5Hex(enc.encode('message digest')), 'f96b697d7cb7938d525a2f31aaf161d0');
  assert.equal(md5Hex(enc.encode('The quick brown fox jumps over the lazy dog')),
    '9e107d9d372bb6826bd81d3542a419d6');
});

test('md5Hex 与 node:crypto 交叉验证（含单块 / 多块 / 整块边界）', () => {
  // 55/56/64/65 是 MD5 分组填充的关键边界：56 起要多补一个分组
  for (const len of [0, 1, 55, 56, 57, 63, 64, 65, 127, 128, 200, 1000]) {
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = (i * 37 + 11) & 0xff;
    const mine = md5Hex(bytes);
    const ref = crypto.createHash('md5').update(Buffer.from(bytes)).digest('hex');
    assert.equal(mine, ref, '长度 ' + len + ' 不一致');
  }
});

test('md5Hex 容忍普通数组与空输入', () => {
  assert.equal(md5Hex([0x61, 0x62, 0x63]), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(md5Hex(null), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(md5Hex(undefined), 'd41d8cd98f00b204e9800998ecf8427e');
});

// ==================== AES-128-ECB ====================

const KEY = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

test('encryptAes128Ecb 与 node:crypto aes-128-ecb + PKCS#7 完全一致', () => {
  for (const len of [0, 1, 15, 16, 17, 31, 32, 100, 1024]) {
    const plain = new Uint8Array(len);
    for (let i = 0; i < len; i++) plain[i] = (i * 91 + 7) & 0xff;
    const mine = encryptAes128Ecb(plain, KEY);

    const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(KEY), null);
    const ref = Buffer.concat([cipher.update(Buffer.from(plain)), cipher.final()]);

    assert.equal(hexOf(mine), ref.toString('hex'), '长度 ' + len + ' 密文不一致');
  }
});

test('encryptAes128Ecb 满块时补整块 PKCS#7', () => {
  const plain = new Uint8Array(16).fill(0x41);
  const out = encryptAes128Ecb(plain, KEY);
  assert.equal(out.length, 32); // 16 字节明文 → 16 字节填充 → 32 字节密文
  // 解密后必须还原，且尾部 16 个 0x10 被去掉
  return decryptAes128Ecb(out, KEY).then(back => {
    assert.equal(back.length, 16);
    assert.equal(hexOf(back), hexOf(plain));
  });
});

test('decryptAes128Ecb 还原任意长度明文', async () => {
  for (const len of [0, 1, 16, 17, 500]) {
    const plain = new Uint8Array(len);
    for (let i = 0; i < len; i++) plain[i] = (i * 13 + 3) & 0xff;
    const back = await decryptAes128Ecb(encryptAes128Ecb(plain, KEY), KEY);
    assert.ok(back, '长度 ' + len + ' 解密返回 null');
    assert.equal(hexOf(back), hexOf(plain), '长度 ' + len + ' 解密结果不一致');
  }
});

test('decryptAes128Ecb 拒绝非法密文长度', async () => {
  assert.equal(await decryptAes128Ecb(new Uint8Array(0), KEY), null);
  assert.equal(await decryptAes128Ecb(new Uint8Array(15), KEY), null);
  assert.equal(await decryptAes128Ecb(new Uint8Array(17), KEY), null);
});

test('parseIlinkAesKey 支持 hex 与 base64 两种下发形式', () => {
  const hexKey = '000102030405060708090a0b0c0d0e0f';
  assert.equal(hexOf(parseIlinkAesKey(hexKey)), hexKey);

  // base64(16 字节原始密钥)
  const b64raw = Buffer.from(KEY).toString('base64');
  assert.equal(hexOf(parseIlinkAesKey(b64raw)), hexKey);

  // base64(32 位 hex 字符串)
  const b64hex = Buffer.from(hexKey).toString('base64');
  assert.equal(hexOf(parseIlinkAesKey(b64hex)), hexKey);

  assert.equal(parseIlinkAesKey(''), null);
  assert.equal(parseIlinkAesKey('too-short'), null);
  assert.equal(parseIlinkAesKey('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'), null);
});

// ==================== Markdown → 微信排版 ====================

test('formatWechatText 标题降级为符号前缀', () => {
  assert.equal(formatWechatText('## 标题'), '▎标题');
  assert.equal(formatWechatText('# 一级'), '▎一级');
  assert.equal(formatWechatText('### 三级标题'), '▪ 三级标题');
  assert.equal(formatWechatText('###### 六级'), '▪ 六级');
});

test('formatWechatText 去掉加粗标记、行内代码改书名号', () => {
  assert.equal(formatWechatText('**粗体**'), '粗体');
  assert.equal(formatWechatText('__粗2__'), '粗2');
  assert.equal(formatWechatText('`code`'), '「code」');
});

test('formatWechatText 代码块保留原文并加边框', () => {
  const out = formatWechatText('```js\nconst a = 1;\n```');
  assert.equal(out, '╭─ [js] ─────\nconst a = 1;\n╰──────────');
  // 无语言标记时用「代码」
  assert.match(formatWechatText('```\nx\n```'), /^╭─ \[代码\] ─────\nx\n╰──────────$/);
  // 代码块内的 ** 与 ` 不被二次处理
  const inner = formatWechatText('```\n**not bold** `x`\n```');
  assert.match(inner, /\*\*not bold\*\* `x`/);
});

test('formatWechatText 链接与图片改写', () => {
  assert.equal(formatWechatText('[链接文字](https://example.com)'), '链接文字 (https://example.com)');
  assert.equal(formatWechatText('![图片说明](https://example.com/a.png)'),
    '🖼️ 图片说明: https://example.com/a.png');
  assert.equal(formatWechatText('![](https://example.com/a.png)'),
    '🖼️ 图片: https://example.com/a.png');
  // 非 http(s) 链接原样保留，避免把相对路径改坏
  assert.equal(formatWechatText('[x](./a.md)'), '[x](./a.md)');
});

test('formatWechatText 列表、引用、分隔线与空行压缩', () => {
  assert.equal(formatWechatText('- 项目一\n- 项目二'), '• 项目一\n• 项目二');
  assert.equal(formatWechatText('* 星号项'), '• 星号项');
  assert.equal(formatWechatText('> 引用'), '｜引用');
  assert.equal(formatWechatText('---'), '────────────');
  assert.equal(formatWechatText('段落一\n\n\n\n段落二'), '段落一\n\n段落二');
  assert.equal(formatWechatText(''), '');
  assert.equal(formatWechatText(null), '');
});

test('formatWechatText 处理 CRLF 与前后空白', () => {
  assert.equal(formatWechatText('  ## 标题\r\n\r\n正文  '), '▎标题\n\n正文');
});

// ==================== 文本分段 ====================

test('splitWechatText 短文本不分段', () => {
  assert.deepEqual(splitWechatText('你好'), ['你好']);
  assert.deepEqual(splitWechatText(''), ['']);
  assert.deepEqual(splitWechatText(null), ['']);
});

test('splitWechatText 换行位置足够靠后时按换行切分', () => {
  // 换行落在 maxLength 的 70% 之后 → 在换行处切，避免切出很短的下一段
  const text = 'A'.repeat(80) + '\n' + 'B'.repeat(60);
  const chunks = splitWechatText(text, 100, 5);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], 'A'.repeat(80));
  assert.equal(chunks[1], 'B'.repeat(60));
});

test('splitWechatText 换行位置太靠前时按长度硬切', () => {
  // 换行在 60% 处（60 < 100*0.7）→ 不按换行切，否则第一段只剩 60 字
  const text = 'A'.repeat(60) + '\n' + 'B'.repeat(60);
  const chunks = splitWechatText(text, 100, 5);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 100);
  assert.equal(chunks[0], 'A'.repeat(60) + '\n' + 'B'.repeat(39));
  assert.equal(chunks[1], 'B'.repeat(21));
});

test('splitWechatText 超过上限的段数时截断并注明', () => {
  const text = ('X'.repeat(90) + '\n').repeat(10);
  const chunks = splitWechatText(text, 100, 3);
  assert.equal(chunks.length, 3);
  assert.match(chunks[chunks.length - 1], /内容过长，已截断显示/);
});

test('splitWechatText 超长单段硬切', () => {
  const chunks = splitWechatText('Z'.repeat(1000), 100, 5);
  assert.equal(chunks.length, 5);
  // 末段仍是硬切后的内容（不超过 2 倍上限 + 提示语）
  assert.ok(chunks[4].length <= 200 + 20);
});

// ==================== 微信口令解析 ====================

test('parseWxCommand 解析斜杠命令与参数', () => {
  assert.deepEqual(parseWxCommand('/help'), { cmd: '/help', rest: '' });
  assert.deepEqual(parseWxCommand('/HELP'), { cmd: '/help', rest: '' });
  assert.deepEqual(parseWxCommand('/readdoc 我的标题'), { cmd: '/readdoc', rest: '我的标题' });
  assert.deepEqual(parseWxCommand('  /model  gpt-4o  '), { cmd: '/model', rest: 'gpt-4o' });
});

test('parseWxCommand 处理命令别名', () => {
  assert.deepEqual(parseWxCommand('/menu'), { cmd: '/help', rest: '' });
  for (const alias of ['/img', '/image', '/paint']) {
    assert.deepEqual(parseWxCommand(alias + ' 一只猫'), { cmd: '/draw', rest: '一只猫' }, alias);
  }
});

test('parseWxCommand 中文口令映射到同一批命令', () => {
  for (const w of ['菜单', '帮助', '指令', '功能', '命令', '使用说明']) {
    assert.deepEqual(parseWxCommand(w), { cmd: '/help', rest: '' }, w);
  }
  for (const w of ['模型', '模型列表', '切换模型', '换模型', '查看模型']) {
    assert.deepEqual(parseWxCommand(w), { cmd: '/model', rest: '' }, w);
  }
  for (const w of ['清空', '清空上下文', '新对话', '重置', '重置对话']) {
    assert.deepEqual(parseWxCommand(w), { cmd: '/clear', rest: '' }, w);
  }
  assert.deepEqual(parseWxCommand('知识库'), { cmd: '/kb', rest: '' });
  assert.deepEqual(parseWxCommand('状态'), { cmd: '/status', rest: '' });
});

test('parseWxCommand 带参中文口令', () => {
  assert.deepEqual(parseWxCommand('切换模型 qwen-max'), { cmd: '/model', rest: 'qwen-max' });
  assert.deepEqual(parseWxCommand('忘掉 我的生日'), { cmd: '/forget', rest: '我的生日' });
  assert.deepEqual(parseWxCommand('整理知识库 部署手册'), { cmd: '/savekb', rest: '部署手册' });
  assert.deepEqual(parseWxCommand('保存到知识库：会议纪要'), { cmd: '/savekb', rest: '会议纪要' });
  assert.deepEqual(parseWxCommand('读取文档 部署手册'), { cmd: '/readdoc', rest: '部署手册' });
  assert.deepEqual(parseWxCommand('删除文档 部署手册'), { cmd: '/deldoc', rest: '部署手册' });
  assert.deepEqual(parseWxCommand('画 一只太空猫'), { cmd: '/draw', rest: '一只太空猫' });
  assert.deepEqual(parseWxCommand('生图:赛博朋克城市'), { cmd: '/draw', rest: '赛博朋克城市' });
});

test('parseWxCommand 普通对话返回 null（交给 Agent）', () => {
  assert.equal(parseWxCommand('你好'), null);
  assert.equal(parseWxCommand('帮我总结一下这篇文章'), null);
  assert.equal(parseWxCommand(''), null);
  assert.equal(parseWxCommand(null), null);
  // 只是"看起来像"口令但没有参数，不应当被当成画图命令
  assert.equal(parseWxCommand('画'), null);
});

// ==================== 文本编码探测 ====================

test('decodeTextSmart 处理 BOM 与普通 UTF-8', () => {
  assert.equal(decodeTextSmart(new Uint8Array(0)), '');
  assert.equal(decodeTextSmart(enc.encode('你好 world')), '你好 world');
  assert.equal(decodeTextSmart(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])), 'a');
  assert.equal(decodeTextSmart(new Uint8Array([0xff, 0xfe, 0x61, 0x00])), 'a');
  assert.equal(decodeTextSmart(new Uint8Array([0xfe, 0xff, 0x00, 0x61])), 'a');
});

test('decodeTextSmart 遇到非法 UTF-8 不抛错', () => {
  // 0xff 在 UTF-8 里是非法起始字节；无论回退到 GB18030 还是 UTF-8 都不能抛
  const out = decodeTextSmart(new Uint8Array([0xff, 0xfe, 0x41]));
  assert.equal(typeof out, 'string');
});

// ==================== 凭证 / 游标 / Context Token 持久化 ====================
// 这几条是通道的命门：bot_token 丢了就要重新扫码，游标丢了会重复处理历史消息。
// 用内存 R2 桩验证读写往返与清理行为，不联网。

function fakeR2(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(key) {
      if (!store.has(key)) return null;
      return { text: async () => store.get(key) };
    },
    async put(key, value) { store.set(key, String(value)); },
    async delete(key) { store.delete(key); },
    async list(opts = {}) {
      const prefix = (opts && opts.prefix) || '';
      return { objects: [...store.keys()].filter(k => k.startsWith(prefix)).map(k => ({ key: k })), truncated: false };
    },
  };
}

test('WX_BOT_TOKEN 环境变量优先于 R2 凭证', async () => {
  const env = {
    WX_BOT_TOKEN: 'bot123:secret',
    WX_BOT_ID: 'bot123',
    R2: fakeR2({ wx_clawbot_creds: JSON.stringify({ bot_token: 'from-r2', ilink_bot_id: 'r2bot' }) }),
  };
  const creds = await getWxCredentials(env, true);
  assert.equal(creds.bot_token, 'bot123:secret');
  assert.equal(creds.ilink_bot_id, 'bot123');
  assert.equal(creds.source, 'env');
  // 未配置时用默认网关
  assert.equal(creds.baseurl, 'https://ilinkai.weixin.qq.com');
});

test('凭证写入 R2 后能原样读回', async () => {
  const env = { R2: fakeR2() };
  const ok = await saveWxCredentials(env, {
    bot_token: 'tok-abc',
    ilink_bot_id: 'bot-1',
    ilink_user_id: 'user-1',
    baseurl: 'https://gw.example.com',
    cdn_url: 'https://cdn.example.com/c2c',
  });
  assert.equal(ok, true);

  const raw = JSON.parse(env.R2.store.get('wx_clawbot_creds'));
  assert.equal(raw.bot_token, 'tok-abc');
  assert.equal(raw.ilink_user_id, 'user-1');
  assert.equal(raw.expired, false);
  assert.ok(raw.updated_at, '应当写入更新时间');

  // 绕过 30 秒内存缓存重新读
  const back = await getWxCredentials(env, true);
  assert.equal(back.bot_token, 'tok-abc');
  assert.equal(back.baseurl, 'https://gw.example.com');
  assert.equal(back.source, 'r2');
});

test('未绑定 R2 且没有环境变量时返回 null', async () => {
  const creds = await getWxCredentials({}, true);
  assert.equal(creds, null);
});

test('clearWxCredentials 同时清掉凭证与游标', async () => {
  const r2 = fakeR2({
    wx_clawbot_creds: JSON.stringify({ bot_token: 'tok', ilink_bot_id: 'bot-9' }),
    'wx_cursor_bot-9': 'cursor-1',
  });
  const env = { R2: r2 };
  await getWxCredentials(env, true);
  await clearWxCredentials(env);

  assert.equal(r2.store.has('wx_clawbot_creds'), false);
  assert.equal(r2.store.has('wx_cursor_bot-9'), false);
  assert.equal(await getWxCredentials(env, true), null);
});

test('游标读写往返，未初始化时返回空串', async () => {
  const env = { R2: fakeR2() };
  assert.equal(await getWxCursor(env, 'bot-x'), '');
  await saveWxCursor(env, 'bot-x', 'cursor-abc');
  assert.equal(env.R2.store.get('wx_cursor_bot-x'), 'cursor-abc');
});

test('Context Token 按用户隔离存取', async () => {
  const env = { R2: fakeR2() };
  await saveWxContextToken(env, 'user-a', 'ctx-a');
  await saveWxContextToken(env, 'user-b', 'ctx-b');
  assert.equal(await getWxContextToken(env, 'user-a'), 'ctx-a');
  assert.equal(await getWxContextToken(env, 'user-b'), 'ctx-b');
  assert.equal(await getWxContextToken(env, 'user-c'), '');
});
