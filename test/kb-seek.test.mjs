import test from 'node:test';
import assert from 'node:assert/strict';

import { kbGetRegistry } from '../src/kb/registry.js';
import { toolSaveDoc, toolReadDoc } from '../src/kb/doc-tools.js';

function makeR2(initial = {}) {
  const data = new Map(Object.entries(initial));
  const stats = { get: 0, put: 0, list: 0, range: 0, bytesRead: 0 };
  const encoder = new TextEncoder();
  const bytes = value => encoder.encode(String(value)).byteLength;
  return {
    data,
    stats,
    async get(key, options) {
      stats.get += 1;
      if (!data.has(key)) return null;
      const full = String(data.get(key));
      const fullBytes = encoder.encode(full);
      let text = full;
      if (options && options.range) {
        stats.range += 1;
        const start = Math.max(0, options.range.offset || 0);
        const end = Math.min(fullBytes.length, start + (options.range.length || fullBytes.length));
        text = new TextDecoder().decode(fullBytes.slice(start, end));
        stats.bytesRead += end - start;
      } else {
        stats.bytesRead += fullBytes.length;
      }
      return { key, size: fullBytes.length, text: async () => text };
    },
    async put(key, value) { stats.put += 1; data.set(key, String(value)); },
    async delete(key) { data.delete(key); },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      stats.list += 1;
      const keys = [...data.keys()].filter(key => key.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      return {
        objects: page.map(key => ({ key, size: bytes(data.get(key)) })),
        truncated: start + limit < keys.length,
        cursor: start + limit < keys.length ? String(start + limit) : undefined,
      };
    },
  };
}

test('长文 seek 检查点可由 frontmatter 重建，冷读翻页只取当前页且保留 Unicode offset', async () => {
  const writer = makeR2();
  const content = ('A中🙂e\u0301\n').repeat(27000);
  const saved = await toolSaveDoc({ R2: writer }, 'seek-test', { title: '冷读索引', content });
  assert.match(saved, /已保存/);
  const body = writer.data.get('kb/docs/冷读索引.md');
  const head = body.slice(0, body.indexOf('\n\n') + 2);
  assert.ok(body.includes('\nseek: 0:0,'), '长文 frontmatter 应带稀疏检查点');

  // 新桶没有注册表与正文 L1，触发由 frontmatter 重建；该文件独立运行避免不同测试桶并发互扰。
  const cold = makeR2({ 'kb/docs/冷读索引.md': body });
  const rebuilt = await kbGetRegistry({ R2: cold });
  const entry = rebuilt.find(item => item.file === '冷读索引.md');
  assert.ok(entry, '应从磁盘文档重建对应索引条目');
  assert.ok(Array.isArray(entry.seek) && entry.seek.length > 10);
  assert.equal(entry.bodyOffsetChars, head.length);
  assert.equal(entry.bodyOffsetBytes, new TextEncoder().encode(head).byteLength);
  assert.equal(entry.chars, body.length);
  assert.equal(entry.seek.at(-1)[0], body.length - head.length);

  cold.stats.get = 0;
  cold.stats.range = 0;
  cold.stats.bytesRead = 0;
  // offset 落在 emoji 的第二个 UTF-16 code unit，检验既有 offset=String.slice 语义。
  const offset = head.length + 4098;
  const page = await toolReadDoc({ R2: cold }, { query: '冷读索引', offset });
  const expected = body.slice(offset, offset + 8000);
  assert.ok(page.includes(expected), '范围读取页内容须与原有 String.slice 完全一致');
  assert.equal(cold.stats.range, 1, '冷读应直接走一次 R2 Range，而不是整篇 GET');
  assert.ok(cold.stats.bytesRead < new TextEncoder().encode(body).byteLength / 4,
    '单页传输应显著小于整篇文档（至少减少 75%）');
});
