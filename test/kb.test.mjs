// 知识库存读回归测试：假 R2 内存桶，验证注册表自愈重建、全库正文检索、
// offset 越界预检、列表限流与元数据（chars / 字节 size）。
// 不联网、不依赖 Cloudflare 运行时。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  kbGetRegistry, kbGetRegistryWithMeta, kbFindRegEntry, kbParseTags, kbFmtTags,
  kbListDocObjects, kbRebuildRegistry, kbVerifyRegistry,
} from '../src/kb/registry.js';
import { toolSaveDoc, toolReadDoc, toolListDocs, toolDeleteDoc } from '../src/kb/doc-tools.js';
import { extractTagLine, cleanDocTitle, deriveFileDocTitle, autoOrganizeAndSaveKbDoc } from '../src/kb/organize.js';

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

function expectedFingerprint(content) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  let hash = 5381;
  for (let i = 0; i < Math.min(text.length, 4000); i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return text.length.toString(36) + '-' + hash.toString(36);
}

function storedBody(full) {
  return String(full || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
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

test('R2 list 异常显式抛出，校验失败时保留旧 registry', async () => {
  const oldReg = [{ file: '甲.md', title: '旧索引', source: '', size: 10 }];
  const r2 = makeR2({ 'kb/docs/registry.json': JSON.stringify(oldReg) });
  r2.list = async () => { throw new Error('list unavailable'); };

  await assert.rejects(kbListDocObjects({ R2: r2 }), /list unavailable/);
  const got = await kbVerifyRegistry({ R2: r2 }, oldReg);
  assert.deepEqual(got, { reg: oldReg, repaired: 0 });
  assert.equal(r2.data.get('kb/docs/registry.json'), JSON.stringify(oldReg), '列表失败不能改写索引');
});

test('重建途中正文读取失败会中止，不用部分结果覆盖现有索引', async () => {
  const oldReg = [{ file: '旧.md', title: '旧索引', source: '', size: 10 }];
  const oldRaw = JSON.stringify(oldReg);
  const r2 = makeR2({
    'kb/docs/registry.json': oldRaw,
    'kb/docs/新.md': docBody('新文档', '新正文'),
  });
  r2.get = async (key) => {
    if (key === 'kb/docs/新.md') throw new Error('document read unavailable');
    const text = r2.data.get(key);
    return text == null ? null : { text: async () => String(text) };
  };

  await assert.rejects(kbVerifyRegistry({ R2: r2 }, oldReg), /document read unavailable/);
  assert.equal(r2.data.get('kb/docs/registry.json'), oldRaw, '失败重建不得覆盖旧索引');
});

test('正常空桶可以显式重建为空注册表', async () => {
  const r2 = makeR2();
  const rebuilt = await kbRebuildRegistry({ R2: r2 }, []);
  assert.deepEqual(rebuilt, []);
  assert.deepEqual(JSON.parse(r2.data.get('kb/docs/registry.json')), []);
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

// ==================== v7.11.0：写入模式 / 版本快照 / 指纹去重 / 标签 ====================

test('kbParseTags 与 kbFmtTags：混排分隔符、去 # 前缀、上限 8 个', () => {
  assert.deepEqual(kbParseTags('R2, 部署、#成本，缓存'), ['R2', '部署', '成本', '缓存']);
  assert.deepEqual(kbParseTags(''), []);
  assert.deepEqual(kbParseTags(null), []);
  assert.deepEqual(kbParseTags([' 甲 ', '', '乙']), ['甲', '乙']);
  assert.equal(kbParseTags(Array.from({ length: 12 }, (_, i) => 'k' + i)).length, 8);
  assert.equal(kbFmtTags([]), '');
  assert.equal(kbFmtTags('a,b'), '｜标签：a、b');
});

test('save_doc mode=create 遇到同名文档时拒绝覆盖并给出替代方案', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };
  await toolSaveDoc(env, 'c1', { title: '部署笔记', content: '第一版内容' });
  const out = await toolSaveDoc(env, 'c1', { title: '部署笔记', content: '第二版内容', mode: 'create' });
  assert.ok(out.includes('已存在'), out);
  assert.ok(out.includes('mode=overwrite'), out);
  const body = r2.data.get('kb/docs/部署笔记.md');
  assert.ok(body.includes('第一版内容'), '旧内容不应被改动');
  assert.ok(!body.includes('第二版内容'));
});

test('save_doc mode=append 追加而非覆盖，并为旧版留一份快照', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };
  await toolSaveDoc(env, 'c1', { title: '运维手册', content: '第一章：安装' });
  const out = await toolSaveDoc(env, 'c1', { title: '运维手册', content: '第二章：升级', mode: 'append' });
  assert.ok(out.includes('已追加'), out);
  assert.ok(out.includes('旧版已存档'), out);

  const body = r2.data.get('kb/docs/运维手册.md');
  assert.ok(body.includes('第一章：安装'));
  assert.ok(body.includes('第二章：升级'));
  assert.ok(body.indexOf('第一章') < body.indexOf('第二章'), '新内容应在旧正文之后');

  const versions = [...r2.data.keys()].filter(k => k.startsWith('kb/versions/运维手册/'));
  assert.equal(versions.length, 1);
  assert.ok(r2.data.get(versions[0]).includes('第一章：安装'), '快照应保存覆盖前的完整旧版');
  assert.equal(JSON.parse(r2.data.get('kb/docs/registry.json'))[0].version, 2);
});

test('save_doc mode=prepend 把整理大纲放到原文之前，snapshot:false 不占版本槽位', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };
  await toolSaveDoc(env, 'c1', { title: '会议纪要', content: '原始正文：讨论了三个方案' });
  const out = await toolSaveDoc(env, 'c1', {
    title: '会议纪要',
    content: '【核心摘要】一句话总结',
    mode: 'prepend',
    snapshot: false,
  });
  assert.ok(out.includes('已前置整理大纲'), out);
  const body = r2.data.get('kb/docs/会议纪要.md');
  assert.ok(body.indexOf('【核心摘要】') < body.indexOf('原始正文'));
  assert.equal([...r2.data.keys()].filter(k => k.startsWith('kb/versions/')).length, 0);
});

test('旧正文读取失败时中止覆盖，正文与索引均保持不变', async () => {
  const oldBody = docBody('读旧失败', '不能丢失的旧正文');
  const oldReg = [{ file: '读旧失败.md', title: '读旧失败', source: '', size: oldBody.length }];
  const r2 = makeR2({
    'kb/docs/读旧失败.md': oldBody,
    'kb/docs/registry.json': JSON.stringify(oldReg),
  });
  const originalGet = r2.get.bind(r2);
  r2.get = async (key) => {
    if (key === 'kb/docs/读旧失败.md') throw new Error('old body unavailable');
    return await originalGet(key);
  };

  const out = await toolSaveDoc({ R2: r2 }, 'c1', { title: '读旧失败', content: '危险的新正文' });
  assert.ok(out.includes('旧正文读取失败'), out);
  assert.ok(out.includes('未覆盖原文'), out);
  assert.equal(r2.data.get('kb/docs/读旧失败.md'), oldBody);
  assert.deepEqual(JSON.parse(r2.data.get('kb/docs/registry.json')), oldReg);
  assert.equal([...r2.data.keys()].some(k => k.startsWith('kb/versions/')), false);
});

test('要求的版本快照写入失败时中止覆盖', async () => {
  const oldBody = docBody('快照失败', '需要先快照的旧正文');
  const oldReg = [{ file: '快照失败.md', title: '快照失败', source: '', size: oldBody.length }];
  const r2 = makeR2({
    'kb/docs/快照失败.md': oldBody,
    'kb/docs/registry.json': JSON.stringify(oldReg),
  });
  r2.put = async (key, value) => {
    if (key.startsWith('kb/versions/')) throw new Error('snapshot put failed');
    r2.data.set(key, String(value));
  };

  const out = await toolSaveDoc({ R2: r2 }, 'c1', { title: '快照失败', content: '不应落盘的新正文' });
  assert.ok(out.includes('旧版快照保存失败'), out);
  assert.ok(out.includes('未覆盖原文'), out);
  assert.equal(r2.data.get('kb/docs/快照失败.md'), oldBody);
  assert.deepEqual(JSON.parse(r2.data.get('kb/docs/registry.json')), oldReg);
});

test('append 与 prepend 的注册表和 frontmatter 指纹均按最终正文计算', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };
  await toolSaveDoc(env, 'c1', { title: '最终指纹', content: '原始正文' });

  const appendedDelta = '追加部分';
  await toolSaveDoc(env, 'c1', { title: '最终指纹', content: appendedDelta, mode: 'append' });
  let full = r2.data.get('kb/docs/最终指纹.md');
  let finalBody = storedBody(full);
  let fp = JSON.parse(r2.data.get('kb/docs/registry.json'))[0].fp;
  assert.equal(fp, expectedFingerprint(finalBody));
  assert.notEqual(fp, expectedFingerprint(appendedDelta), '不能只对追加增量取指纹');
  assert.equal(full.match(/^fp: (.+)$/m)[1], fp);

  const prependedDelta = '前置大纲';
  const beforePrepend = finalBody;
  await toolSaveDoc(env, 'c1', {
    title: '最终指纹', content: prependedDelta, mode: 'prepend', snapshot: false,
  });
  full = r2.data.get('kb/docs/最终指纹.md');
  finalBody = storedBody(full);
  fp = JSON.parse(r2.data.get('kb/docs/registry.json'))[0].fp;
  assert.equal(finalBody, prependedDelta + '\n\n---\n\n' + beforePrepend);
  assert.equal(fp, expectedFingerprint(finalBody));
  assert.notEqual(fp, expectedFingerprint(prependedDelta), '不能只对前置增量取指纹');
  assert.equal(full.match(/^fp: (.+)$/m)[1], fp);
});

test('版本快照最多保留最近 3 份，旧快照自动清理', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };
  await toolSaveDoc(env, 'c1', { title: '反复覆盖', content: 'v0 初始内容' });
  for (let i = 1; i <= 5; i++) {
    await toolSaveDoc(env, 'c1', { title: '反复覆盖', content: 'v' + i + ' 内容各不同' + i });
  }
  const versions = [...r2.data.keys()].filter(k => k.startsWith('kb/versions/'));
  assert.equal(versions.length, 3);
});

test('save_doc 用内容指纹挡住「同一篇资料换个标题重复入库」', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };
  await toolSaveDoc(env, 'c1', { title: '甲文档', content: '同一段资料内容 abc' });
  // 只差空白，指纹应一致
  const out = await toolSaveDoc(env, 'c1', { title: '乙文档', content: '同一段资料内容    abc' });
  assert.ok(out.includes('内容指纹一致'), out);
  assert.equal(r2.data.has('kb/docs/乙文档.md'), false);
});

test('save_doc 拒绝把 404 / 人机校验页存成知识文档，长文里的引用不受影响', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };
  const bad = await toolSaveDoc(env, 'c1', { title: '抓取失败', content: '404 Not Found\nnginx/1.20' });
  assert.ok(bad.includes('已拒绝'), bad);
  assert.equal(r2.data.has('kb/docs/抓取失败.md'), false);

  const long = '正文内容'.repeat(400) + '\n404 Not Found 只是引用';
  const ok = await toolSaveDoc(env, 'c1', { title: '长文引用', content: long });
  assert.ok(ok.startsWith('已保存为知识库文档'), ok);
});

test('tags 写进 frontmatter，注册表自愈重建后仍能解析并按标签读取', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };
  await toolSaveDoc(env, 'c1', {
    title: 'K8s 入门',
    content: 'Pod 与 Service 的关系',
    tags: 'Kubernetes, 容器、#运维',
  });
  assert.deepEqual(JSON.parse(r2.data.get('kb/docs/registry.json'))[0].tags, ['Kubernetes', '容器', '运维']);
  assert.ok(r2.data.get('kb/docs/K8s入门.md').includes('tags: Kubernetes, 容器, 运维'));

  const read = await toolReadDoc(env, { query: '容器' });
  assert.ok(read.includes('【知识库文档《K8s 入门》'), read.slice(0, 120));
  assert.ok(read.includes('标签：Kubernetes、容器、运维'), read.slice(0, 160));

  // 注册表丢失时按 frontmatter 重建，tags 不能丢
  const r2b = makeR2({ 'kb/docs/带标签.md': docBody('带标签文档', '正文', 'tags: 部署, 缓存') });
  const rebuilt = await kbGetRegistry({ R2: r2b });
  assert.deepEqual(rebuilt[0].tags, ['部署', '缓存']);
});

test('kbFindRegEntry 支持按标签命中，但标题命中优先', () => {
  const reg = [
    { file: 'a.md', title: '甲文档', tags: ['Kubernetes'] },
    { file: 'b.md', title: 'Kubernetes 实战', tags: [] },
  ];
  assert.equal(kbFindRegEntry(reg, 'Kubernetes').file, 'b.md');

  const reg2 = [
    { file: 'a.md', title: '甲文档', tags: ['Kubernetes', '容器'] },
    { file: 'c.md', title: '丙文档', tags: [] },
  ];
  assert.equal(kbFindRegEntry(reg2, '容器').file, 'a.md');
  assert.equal(kbFindRegEntry(reg2, '不存在的词'), null);
});

test('并发保存多篇文档时注册表不丢条目（写操作已串行化）', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };
  await Promise.all([1, 2, 3, 4, 5].map(i => toolSaveDoc(env, 'c1', { title: '并发' + i, content: '各自内容' + i })));
  const reg = JSON.parse(r2.data.get('kb/docs/registry.json'));
  assert.equal(reg.length, 5);
});

test('并发追加与删除共用全局写锁，不丢正文或注册表条目', async () => {
  const original = docBody('并发追加', '初始正文', 'version: 1');
  const r2 = makeR2({
    'kb/docs/并发追加.md': original,
    'kb/docs/registry.json': JSON.stringify([
      { file: '并发追加.md', title: '并发追加', source: '', size: original.length, version: 1 },
      { file: '待删.md', title: '待删', source: '', size: 20 },
    ]),
    'kb/docs/待删.md': docBody('待删', '删除我'),
  });
  const originalGet = r2.get.bind(r2);
  r2.get = async (key) => {
    await new Promise(resolve => setTimeout(resolve, 2));
    return await originalGet(key);
  };
  const env = { R2: r2 };
  const appends = [1, 2, 3, 4].map(i => toolSaveDoc(env, 'c1', {
    title: '并发追加', content: '增量' + i, mode: 'append', snapshot: false,
  }));
  const results = await Promise.all([...appends, toolDeleteDoc(env, { query: '待删' })]);
  assert.ok(results.every(x => x.startsWith('已保存') || x.startsWith('已删除')), results.join('\n'));

  const full = r2.data.get('kb/docs/并发追加.md');
  for (let i = 1; i <= 4; i++) assert.ok(full.includes('增量' + i), '并发追加不能丢增量' + i);
  const reg = JSON.parse(r2.data.get('kb/docs/registry.json'));
  assert.deepEqual(reg.map(e => e.file), ['并发追加.md']);
  assert.equal(reg[0].version, 5);
  assert.equal(reg[0].fp, expectedFingerprint(storedBody(full)));
  assert.equal(r2.data.has('kb/docs/待删.md'), false);
});

test('extractTagLine 从 AI 整理结果里抽出检索标签', () => {
  const s = '1. 【📌 核心摘要】略\n4. 【🏷️ 检索关键词标签】：#R2, 部署、缓存; 成本';
  assert.equal(extractTagLine(s), 'R2, 部署, 缓存, 成本');
  assert.equal(extractTagLine('没有标签段落'), '');
  const many = '【检索关键词标签】' + Array.from({ length: 12 }, (_, i) => 'k' + i).join(',');
  assert.equal(extractTagLine(many).split(', ').length, 8);
});

test('deriveFileDocTitle 从附言反推标题，推不出则退回文件名', () => {
  assert.equal(deriveFileDocTitle('把《部署笔记》存进知识库', 'a.txt'), '部署笔记');
  assert.equal(deriveFileDocTitle('将 周报 保存到知识库', 'b.txt'), '周报');
  assert.equal(deriveFileDocTitle('', 'R2配置.md'), 'R2配置');
  assert.equal(deriveFileDocTitle('存进知识库', 'notes.md'), 'notes');
  assert.equal(deriveFileDocTitle(null, null), '未命名文档');
});

test('cleanDocTitle 折叠换行并给出兜底标题', () => {
  assert.equal(cleanDocTitle('  多行\n标题  '), '多行 标题');
  assert.equal(cleanDocTitle(''), '未命名知识文档');
  assert.equal(cleanDocTitle(null), '未命名知识文档');
});

// ==================== v7.11.0：自动整理入库（原文 + 大纲两步写入） ====================

function organizeEnv(r2) {
  return {
    R2: r2,
    API_URL_1: 'https://api.example.com/v1/chat/completions',
    API_KEY_1: 'sk-test',
    MODEL_1: 'test-model:测试模型',
  };
}

function stubSummary(summary) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ choices: [{ message: { content: summary } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
  return () => { globalThis.fetch = orig; };
}

test('整理入库：首次写入原文并把大纲前置，重复上传不再叠加', async () => {
  const r2 = makeR2();
  const env = organizeEnv(r2);
  const raw = '这是原始文档的正文内容，用来测试自动整理入库流程。'.repeat(3);
  const summary = '1. 【📌 核心摘要】这是一段用于测试的核心摘要文本。\n4. 【🏷️ 检索关键词标签】测试, 入库';
  const restore = stubSummary(summary);
  try {
    const first = await autoOrganizeAndSaveKbDoc(env, 'c1', 'test-model', '整理测试', raw, 'test');
    assert.equal(first.ok, true, first.saveResult);
    let body = r2.data.get('kb/docs/整理测试.md');
    assert.ok(body.includes('核心摘要'));
    assert.ok(body.includes('这是原始文档的正文内容'));
    assert.ok(body.indexOf('核心摘要') < body.indexOf('这是原始文档'), '大纲应在原文之前');
    assert.deepEqual(JSON.parse(r2.data.get('kb/docs/registry.json'))[0].tags, ['测试', '入库']);

    const again = await autoOrganizeAndSaveKbDoc(env, 'c1', 'test-model', '整理测试', raw, 'test');
    assert.equal(again.skippedDup, true, again.saveResult);
    body = r2.data.get('kb/docs/整理测试.md');
    assert.equal(body.split('【📌 核心摘要】').length - 1, 1, '大纲不应被重复前置');
    assert.ok(body.includes('这是原始文档的正文内容'), '原文不应被这次覆盖冲掉');
  } finally {
    restore();
  }
});

test('整理入库：原文被指纹挡下时不会建出只有摘要的孤儿文档', async () => {
  const r2 = makeR2();
  const env = organizeEnv(r2);
  const raw = '同一份资料的内容，先存一篇原始资料。'.repeat(2);
  await toolSaveDoc(env, 'c1', { title: '原始资料', content: raw });
  const restore = stubSummary('1. 【📌 核心摘要】另一个标题下的摘要。\n4. 【🏷️ 检索关键词标签】x');
  try {
    const res = await autoOrganizeAndSaveKbDoc(env, 'c1', 'test-model', '换个标题', raw, 'test');
    assert.equal(r2.data.has('kb/docs/换个标题.md'), false, '不应建出孤儿文档');
    assert.ok(res.saveResult.includes('未重复保存'), res.saveResult);
    assert.equal(res.ok, true, '内容确实在库里，应算成功');
  } finally {
    restore();
  }
});

// ==================== v7.11.1：索引与真实文件脱节（「已保存但库里没有」） ====================

// 模拟另一个 Worker 实例直接往 R2 写一篇文档 + 索引条目（本实例的内存缓存不会知道）
function externalAddDoc(r2, file, title, content) {
  r2.data.set('kb/docs/' + file, docBody(title, content));
  const list = JSON.parse(r2.data.get('kb/docs/registry.json') || '[]');
  list.push({
    file: file,
    title: title,
    source: '',
    tags: [],
    size: 40,
    updated_at: '2026-01-02T00:00:00.000Z',
  });
  r2.data.set('kb/docs/registry.json', JSON.stringify(list));
}

test('保存时读最新索引，不会覆盖别的实例刚写入的条目', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };
  await toolSaveDoc(env, 'c1', { title: '甲', content: '甲的内容' });
  // 另一个实例写入乙（本实例缓存里只有甲）
  externalAddDoc(r2, '乙.md', '乙', '乙的内容');
  // 本实例再保存丙：必须保留乙，否则乙的正文还在 R2 里却从列表消失
  await toolSaveDoc(env, 'c1', { title: '丙', content: '丙的内容' });
  const files = JSON.parse(r2.data.get('kb/docs/registry.json')).map(e => e.file).sort();
  assert.deepEqual(files, ['丙.md', '乙.md', '甲.md'].sort());
});

test('索引落后于实际文件时，/kb 列表自动修复并说明补回了几篇', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };
  await toolSaveDoc(env, 'c1', { title: '甲', content: '甲的内容' });
  externalAddDoc(r2, '乙.md', '乙', '乙的内容');

  // 默认缓存路径：本实例还不知道乙
  const stale = await toolListDocs(env);
  assert.ok(!stale.includes('乙'), '缓存路径不应凭空变出文档');

  const out = await toolListDocs(env, { verify: true });
  assert.ok(out.includes('共2篇'), out);
  assert.ok(out.includes('乙'), out);
  assert.ok(out.includes('补回 1 篇'), out);
  // 修复结果已写回 R2
  assert.equal(JSON.parse(r2.data.get('kb/docs/registry.json')).length, 2);
});

// 修复计数必须是「本次调用自己的」，不能是模块级全局量 ——
// Worker 一个 isolate 服务所有用户，全局计数器会被并发请求取走，
// 结果就是 A 触发的修复数字显示在 B 的面板上，A 自己什么都看不到。
test('索引修复计数按调用返回，不会串到别的请求', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };
  await toolSaveDoc(env, 'c1', { title: '甲', content: '甲的内容' });
  externalAddDoc(r2, '乙.md', '乙', '乙的内容');

  const first = await kbGetRegistryWithMeta(env, { verify: true });
  assert.equal(first.repaired, 1, '本次调用补回 1 篇');
  assert.equal(first.reg.length, 2);

  // 索引已经修好了，再查一次就没有可补的
  const second = await kbGetRegistryWithMeta(env, { verify: true });
  assert.equal(second.repaired, 0, '第二次调用不应再报修复数');
  assert.equal(second.reg.length, 2);

  // 另一个"请求"（不同 env 但同 isolate）拿到的也是自己的 0，而不是残留的 1
  const r2b = makeR2();
  await toolSaveDoc({ R2: r2b }, 'c2', { title: '丙', content: '丙的内容' });
  const other = await kbGetRegistryWithMeta({ R2: r2b }, { verify: true });
  assert.equal(other.repaired, 0, '索引本来就是对的，不该报修复');
});

test('read_doc 标题未命中时先核对索引，不把库里的文档报成未找到', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };  await toolSaveDoc(env, 'c1', { title: '甲', content: '甲的内容' });
  externalAddDoc(r2, '乙.md', '乙文档', '乙的正文内容');

  const out = await toolReadDoc(env, { query: '乙文档' });
  assert.ok(out.includes('【知识库文档《乙文档》】'), out.slice(0, 120));
  assert.ok(out.includes('乙的正文内容'), out);
});

test('索引丢失后重建仍保留 fp，重复内容依旧挡得住', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };
  const content = '这是一段会被指纹记住的资料内容，用来验证重建后的去重能力。';
  await toolSaveDoc(env, 'c1', { title: '甲', content });
  // 模拟索引被删（只剩 .md 文件）
  r2.data.delete('kb/docs/registry.json');
  // 重建由下一次写路径触发：换标题存同一份内容应被 fp 挡住
  const out = await toolSaveDoc(env, 'c1', { title: '乙', content });
  assert.ok(out.includes('内容指纹一致'), out);
  assert.equal(r2.data.has('kb/docs/乙.md'), false);
});

test('frontmatter 记录 fp 与 version，重建后版本号不倒退', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };
  await toolSaveDoc(env, 'c1', { title: '版本测试', content: '第一版' });
  await toolSaveDoc(env, 'c1', { title: '版本测试', content: '第二版内容' });
  const body = r2.data.get('kb/docs/版本测试.md');
  assert.ok(/^fp: [0-9a-z]+-[0-9a-z]+$/m.test(body), body.slice(0, 200));
  assert.ok(body.includes('version: 2'));

  r2.data.delete('kb/docs/registry.json');
  const list = await kbGetRegistry(env, { fresh: true });
  const entry = list.find(e => e.file === '版本测试.md');
  assert.equal(entry.version, 2);
  assert.ok(entry.fp, '重建后 fp 应保留');
});
