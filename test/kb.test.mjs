// 知识库存读回归测试：假 R2 内存桶，验证注册表自愈重建、全库正文检索、
// offset 越界预检、列表限流与元数据（chars / 字节 size）。
// 不联网、不依赖 Cloudflare 运行时。

import test from 'node:test';
import assert from 'node:assert/strict';

import { kbGetRegistry, kbFindRegEntry } from '../src/kb/registry.js';
import { toolSaveDoc, toolReadDoc, toolListDocs, toolDeleteDoc } from '../src/kb/doc-tools.js';

function makeR2(initial = {}) {
  const data = new Map(Object.entries(initial));
  const stats = { get: 0, put: 0, delete: 0, list: 0 };
  const bytes = (s) => new TextEncoder().encode(String(s)).byteLength;
  return {
    stats,
    data,
    async get(key) {
      stats.get += 1;
      if (!data.has(key)) return null;
      const text = String(data.get(key));
      return { key: key, size: bytes(text), text: async () => text };
    },
    async put(key, value) { stats.put += 1; data.set(key, String(value)); },
    async delete(key) {
      stats.delete += 1;
      if (Array.isArray(key)) key.forEach(k => data.delete(k));
      else data.delete(key);
    },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      stats.list += 1;
      const keys = [...data.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      return {
        objects: page.map(k => ({ key: k, size: bytes(data.get(k)) })),
        truncated: start + limit < keys.length,
        cursor: start + limit < keys.length ? String(start + limit) : undefined,
      };
    },
  };
}

function docBody(title, content, extra) {
  return '---\ntitle: "' + title + '"\nsaved_at: 2026-01-01T00:00:00.000Z'
    + (extra ? '\n' + extra : '') + '\n---\n\n' + content;
}

test('kbGetRegistry 注册表缺失时自动重建并识别 frontmatter', async () => {
  const r2 = makeR2({
    'kb/docs/甲.md': docBody('甲文档', '内容甲', 'source: https://a.example'),
    'kb/docs/乙.md': docBody('乙文档', '内容乙'),
  });
  const reg = await kbGetRegistry({ R2: r2 });
  assert.equal(reg.length, 2);
  const a = reg.find(e => e.file === '甲.md');
  const b = reg.find(e => e.file === '乙.md');
  assert.equal(a.title, '甲文档');
  assert.equal(a.source, 'https://a.example');
  assert.equal(a.updated_at, '2026-01-01T00:00:00.000Z');
  assert.equal(b.title, '乙文档');
  assert.ok(r2.data.has('kb/docs/registry.json'), '重建结果必须写回注册表');
});

test('kbFindRegEntry 优先级：精确 > 包含 > slug 归一化 > 文件名', () => {
  const exact = [{ file: 'abc.md', title: 'abc' }, { file: 'abcd.md', title: 'abcd' }];
  assert.equal(kbFindRegEntry(exact, 'abc').file, 'abc.md');

  const slug = [{ file: '甲骨文云ARM.md', title: '甲骨文云ARM' }];
  assert.equal(kbFindRegEntry(slug, '甲骨文云 ARM').file, '甲骨文云ARM.md');

  const byFile = [{ file: 'notes-on-arm.md', title: '笔记' }];
  assert.equal(kbFindRegEntry(byFile, 'notes-on').file, 'notes-on-arm.md');

  assert.equal(kbFindRegEntry(exact, ''), null);
});

test('read_doc 正文检索覆盖全库（不再只查前 30 篇）', async () => {
  const r2 = makeR2();
  const entries = [];
  for (let i = 1; i <= 35; i++) {
    const title = '文档' + i;
    const content = i === 35 ? '这里藏着独有的锚点词 星轨引擎 用于校验全库检索' : '普通内容 ' + i;
    r2.data.set('kb/docs/' + title + '.md', docBody(title, content));
    entries.push({
      file: title + '.md',
      title: title,
      source: '',
      size: 200,
      updated_at: '2026-01-01T00:00:0' + (i % 10) + '.000Z',
    });
  }
  r2.data.set('kb/docs/registry.json', JSON.stringify(entries));

  const out = await toolReadDoc({ R2: r2 }, { query: '星轨引擎' });
  assert.ok(out.includes('【命中 1'), out.slice(0, 300));
  assert.ok(out.includes('文档35'), '应命中第 35 篇（旧版只查前 30 篇会漏）');
  assert.ok(out.includes('星轨引擎'));
});

test('read_doc 用注册表 chars 预检 offset 越界，不白读整篇文档', async () => {
  const r2 = makeR2();
  r2.data.set('kb/docs/长文.md', docBody('长文', '正'.repeat(5000)));
  r2.data.set('kb/docs/registry.json', JSON.stringify([{
    file: '长文.md', title: '长文', source: '', size: 15000, chars: 100,
    updated_at: '2026-01-01T00:00:00.000Z',
  }]));

  const out = await toolReadDoc({ R2: r2 }, { query: '长文', offset: 500 });
  assert.ok(out.startsWith('文档读取失败'), out);
  assert.ok(out.includes('100 字符'));
  assert.equal(r2.stats.get, 1, '只应读取 registry.json，不应读取正文');
});

test('list_docs 按更新时间倒序且最多列 60 篇', async () => {
  const r2 = makeR2();
  const entries = [];
  for (let i = 1; i <= 70; i++) {
    entries.push({
      file: 'd' + i + '.md',
      title: '文档' + i,
      source: '',
      size: 1200,
      updated_at: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString(),
    });
  }
  r2.data.set('kb/docs/registry.json', JSON.stringify(entries));

  const out = await toolListDocs({ R2: r2 });
  assert.ok(out.includes('共70篇'), out.slice(0, 120));
  assert.ok(out.includes('最近 60 篇'));
  const numbered = out.split('\n').filter(l => /^\d+\. /.test(l));
  assert.equal(numbered.length, 60);
  assert.ok(numbered[0].includes('文档70'), '最新的文档应排在最前');
});

test('save_doc 记录 chars 与字节 size，并穿透缓存支持立即读取', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };
  const content = '你好世界'.repeat(10);
  const save = await toolSaveDoc(env, 'chat1', { title: '存读性能', content });
  assert.ok(save.startsWith('已保存为知识库文档'), save);

  const body = r2.data.get('kb/docs/存读性能.md');
  const reg = JSON.parse(r2.data.get('kb/docs/registry.json'));
  assert.equal(reg.length, 1);
  assert.equal(reg[0].chars, body.length);
  assert.ok(reg[0].size > reg[0].chars, '中文文档字节数应大于字符数');

  const getsBefore = r2.stats.get;
  const read = await toolReadDoc(env, { query: '存读性能' });
  assert.ok(read.includes('【知识库文档《存读性能》】'));
  assert.ok(read.includes('你好世界'));
  assert.equal(r2.stats.get, getsBefore, '刚保存的文档应直接命中 L1 缓存');
});

test('delete_doc 同步失效缓存与注册表', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };
  await toolSaveDoc(env, 'c1', { title: '待删文档', content: '内容' });
  const out = await toolDeleteDoc(env, { query: '待删文档' });
  assert.ok(out.includes('已删除知识库文档《待删文档》'), out);
  assert.equal(r2.data.has('kb/docs/待删文档.md'), false);
  assert.deepEqual(JSON.parse(r2.data.get('kb/docs/registry.json')), []);

  const read = await toolReadDoc(env, { query: '待删文档' });
  assert.ok(read.includes('知识库文档为空'), read);
});
