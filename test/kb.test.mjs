// 知识库存读回归测试：假 R2 内存桶，验证注册表自愈重建、全库正文检索、
// offset 越界预检、列表限流与元数据（chars / 字节 size）。
// 不联网、不依赖 Cloudflare 运行时。

import test from 'node:test';
import assert from 'node:assert/strict';

import { kbGetRegistry, kbGetRegistryEx, kbSaveRegistry, kbMutateRegistry,
  kbRegistryVersion, kbFindRegEntry, kbParseTags, kbFmtTags } from '../src/kb/registry.js';
import { toolSaveDoc, toolReadDoc, toolListDocs, toolDeleteDoc,
  kbReadDocTextCached, kbSearchDocBodyEx } from '../src/kb/doc-tools.js';
import { extractTagLine, cleanDocTitle, deriveFileDocTitle, autoOrganizeAndSaveKbDoc } from '../src/kb/organize.js';

function makeR2(initial = {}) {
  const data = new Map(Object.entries(initial));
  const stats = { get: 0, put: 0, delete: 0, list: 0, getByKey: new Map() };
  const bytes = (s) => new TextEncoder().encode(String(s)).byteLength;
  return {
    stats,
    data,
    async get(key) {
      stats.get += 1;
      stats.getByKey.set(key, (stats.getByKey.get(key) || 0) + 1);
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

test('read_doc 标题未命中时先核对索引，不把库里的文档报成未找到', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };
  await toolSaveDoc(env, 'c1', { title: '甲', content: '甲的内容' });
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

// ==================== 自动核对、失败保护与正文缓存操作预算 ====================

function indexedR2(content = 'needle 原始正文', title = '说明') {
  const body = docBody(title, content);
  const entry = { file: title + '.md', title, updated_at: 'v1', chars: body.length, size: body.length };
  return makeR2({
    ['kb/docs/' + entry.file]: body,
    'kb/docs/registry.json': JSON.stringify([entry]),
  });
}

test('重复全文查询只核对一次：1 LIST、1 注册表 GET、1 正文 GET', async () => {
  const r2 = indexedR2('needle alpha beta gamma delta');
  const env = { R2: r2 };
  for (const query of ['needle', 'alpha', 'beta', 'gamma', 'delta', 'needle', 'alpha', 'beta']) {
    assert.match(await toolReadDoc(env, { query }), /【命中 1/);
  }
  assert.equal(r2.stats.list, 1);
  assert.equal(r2.stats.get, 2);
  assert.equal(r2.stats.getByKey.get('kb/docs/说明.md'), 1);
  assert.equal(r2.stats.put, 0);
});

test('空注册表多次读取及交替访问不同桶，每桶只 LIST 一次', async () => {
  const buckets = [makeR2({ 'kb/docs/registry.json': '[]' }), makeR2({ 'kb/docs/registry.json': '[]' })];
  for (let i = 0; i < 6; i++) {
    for (const r2 of buckets) {
      assert.match(await toolReadDoc({ R2: r2 }, { query: '不存在' }), /知识库文档为空/);
    }
  }
  for (const r2 of buckets) {
    assert.equal(r2.stats.list, 1);
    assert.equal(r2.stats.put, 0);
  }
});

test('缺失索引的空库只重建一次，后续读取不再 LIST', async () => {
  const r2 = makeR2();
  for (let i = 0; i < 6; i++) assert.deepEqual(await kbGetRegistry({ R2: r2 }), []);
  assert.equal(r2.stats.list, 1);
  assert.equal(r2.stats.get, 1);
  assert.equal(r2.stats.put, 1);
  assert.equal(r2.data.get('kb/docs/registry.json'), '[]');
});

test('verify:true 忽略成功核对窗口，立即补回外部文档且每次强制 LIST', async () => {
  const r2 = makeR2({ 'kb/docs/registry.json': '[]' });
  const env = { R2: r2 };
  assert.deepEqual(await kbGetRegistry(env), []);
  r2.data.set('kb/docs/外部.md', docBody('外部', '刚刚写入'));
  assert.deepEqual(await kbGetRegistry(env, { verify: 'auto' }), []);
  assert.equal(r2.stats.list, 1);
  assert.equal((await kbGetRegistry(env, { verify: true }))[0].title, '外部');
  assert.equal(r2.stats.list, 2);
  assert.equal(r2.stats.put, 1);
  await kbGetRegistry(env, { verify: true });
  assert.equal(r2.stats.list, 3);
  assert.equal(r2.stats.put, 1);
});

test('空库自动核对 TTL 到期发现只有正文、未登记的外部新增', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const r2 = makeR2({ 'kb/docs/registry.json': '[]' });
  const env = { R2: r2 };
  await kbGetRegistry(env);
  r2.data.set('kb/docs/外部.md', docBody('外部', '空库新增正文'));
  now += 29999;
  assert.deepEqual(await kbGetRegistry(env), []);
  assert.equal(r2.stats.list, 1);
  now += 2;
  assert.match(await toolReadDoc(env, { query: '外部' }), /空库新增正文/);
  assert.equal(r2.stats.list, 2);
  assert.equal(r2.stats.put, 1);
});

test('非空库 read_doc 自动核对 TTL 到期补回外部文档', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const r2 = indexedR2();
  const env = { R2: r2 };
  await toolReadDoc(env, { query: 'needle' });
  r2.data.set('kb/docs/外部.md', docBody('外部', '新文档完整正文'));
  assert.match(await toolReadDoc(env, { query: '外部' }), /未找到/);
  assert.equal(r2.stats.list, 1);
  now += 30001;
  assert.match(await toolReadDoc(env, { query: '外部' }), /新文档完整正文/);
  assert.equal(r2.stats.list, 2);
  assert.equal(r2.stats.put, 1);
  assert.equal(JSON.parse(r2.data.get('kb/docs/registry.json')).length, 2);
});

test('本地写入和删除使自动核对立即过期', async () => {
  const r2 = makeR2({ 'kb/docs/registry.json': '[]' });
  const env = { R2: r2 };
  await kbGetRegistry(env);
  assert.equal(r2.stats.list, 1);
  assert.match(await toolSaveDoc(env, 'c', { title: '本地', content: '本地内容' }), /已保存/);
  assert.equal(r2.stats.list, 1, '保存前 fresh 空索引复用成功核对');
  await kbGetRegistry(env, { verify: 'auto' });
  assert.equal(r2.stats.list, 2);
  assert.match(await toolDeleteDoc(env, { query: '本地' }), /已删除/);
  assert.equal(r2.stats.list, 3, '删除前仍强制核对');
  assert.deepEqual(await kbGetRegistry(env), []);
  assert.equal(r2.stats.list, 4, '删除后的空库必须重新核对一次');
  await kbGetRegistry(env);
  assert.equal(r2.stats.list, 4);
});

test('并发 auto / 强制核对合并为 1 LIST 和 1 次自愈写入', async () => {
  const r2 = indexedR2();
  const env = { R2: r2 };
  await kbGetRegistry(env);
  r2.data.set('kb/docs/补回.md', docBody('补回', '正文'));
  const gate = Promise.withResolvers();
  const originalList = r2.list;
  r2.list = async (opts) => { await gate.promise; return originalList(opts); };
  const pending = Array.from({ length: 8 }, (_, i) => kbGetRegistry(env, { verify: i % 2 ? true : 'auto' }));
  gate.resolve();
  const results = await Promise.all(pending);
  for (const reg of results) assert.deepEqual(reg.map(e => e.file).sort(), ['补回.md', '说明.md']);
  results[0].pop();
  assert.equal(results[1].length, 2, '合并核对后调用者仍各自拥有列表副本');
  assert.equal(r2.stats.list, 1);
  assert.equal(r2.stats.put, 1);
});

test('LIST 首页失败保留完整旧索引且不记为成功，下次 auto 仍能自愈', async () => {
  const r2 = indexedR2();
  const env = { R2: r2 };
  const original = await kbGetRegistry(env);
  const originalJson = r2.data.get('kb/docs/registry.json');
  r2.data.set('kb/docs/新增.md', docBody('新增', '正文'));
  const originalList = r2.list;
  r2.list = async () => { r2.stats.list += 1; throw new Error('permission denied'); };
  assert.deepEqual(await kbGetRegistry(env, { verify: 'auto' }), original);
  assert.equal(r2.stats.put, 0);
  assert.equal(r2.data.get('kb/docs/registry.json'), originalJson);
  r2.list = originalList;
  assert.equal((await kbGetRegistry(env, { verify: 'auto' })).length, 2);
  assert.equal(r2.stats.list, 2);
  assert.equal(r2.stats.put, 1);
});

test('LIST 后续页失败不能用部分对象覆盖旧索引，也不能重建缺失索引', async () => {
  for (const missing of [false, true]) {
    const r2 = indexedR2();
    if (missing) r2.data.delete('kb/docs/registry.json');
    const before = r2.data.get('kb/docs/registry.json');
    r2.list = async ({ cursor }) => {
      r2.stats.list += 1;
      if (cursor) throw new Error('permission denied');
      return { objects: [{ key: 'kb/docs/半页.md', size: 20 }], truncated: true, cursor: 'next-page' };
    };
    const result = await kbGetRegistryEx({ R2: r2 }, { verify: true });
    assert.equal(result.failed, true);
    assert.equal(result.reg.length, missing ? 0 : 1);
    assert.equal(r2.stats.list, 2);
    assert.equal(r2.stats.get, 1, '失败后不应读取部分列表的文档头');
    assert.equal(r2.stats.put, 0);
    assert.equal(r2.data.get('kb/docs/registry.json'), before);
  }
});

test('首次注册表 GET 失败无缓存，不 LIST、不重建、不允许后续写空', async () => {
  const r2 = indexedR2();
  const env = { R2: r2 };
  const before = r2.data.get('kb/docs/registry.json');
  const originalGet = r2.get;
  r2.get = async (key) => { await originalGet(key); throw new Error('permission denied'); };
  const result = await kbGetRegistryEx(env, { verify: true });
  assert.equal(result.failed, true);
  assert.deepEqual(result.reg, []);
  assert.equal((await kbMutateRegistry(env, () => [])).ok, false);
  assert.match(await toolSaveDoc(env, 'c', { title: '新文档', content: '正文' }), /注册表读取失败/);
  assert.equal(r2.stats.get, 3);
  assert.equal(r2.stats.list, 0);
  assert.equal(r2.stats.put, 0);
  assert.equal(r2.data.get('kb/docs/registry.json'), before);
});

test('注册表 GET 失败有缓存，fresh 强制核对也不因失败重建', async () => {
  const r2 = indexedR2();
  const env = { R2: r2 };
  const before = await kbGetRegistry(env);
  r2.get = async () => { throw new Error('permission denied'); };
  const result = await kbGetRegistryEx(env, { fresh: true, verify: true });
  assert.equal(result.failed, true);
  assert.deepEqual(result.reg, before);
  assert.equal(r2.stats.list, 0);
  assert.equal(r2.stats.put, 0);
});

test('200000 字符正文加 frontmatter 全文翻页只需 1 次正文 GET', async () => {
  const r2 = indexedR2('正'.repeat(199999) + '尾', '长文');
  const env = { R2: r2 };
  const body = r2.data.get('kb/docs/长文.md');
  assert.ok(body.length > 200000);
  for (let offset = 0; offset < body.length; offset += 8000) {
    const out = await toolReadDoc(env, { query: '长文', offset });
    assert.ok(out.includes(body.slice(offset, offset + 8000)), '每页必须保留完整正文片段');
  }
  assert.equal(r2.stats.getByKey.get('kb/docs/长文.md'), 1);
  assert.equal(r2.stats.get, 2);
  assert.equal(r2.stats.list, 0);
});

test('并发 10 页冷正文读取通过 storeGet 合并为 1 GET', async () => {
  const r2 = indexedR2('正'.repeat(200000), '长文');
  const env = { R2: r2 };
  await kbGetRegistry(env);
  const gate = Promise.withResolvers();
  const originalGet = r2.get;
  r2.get = async (key) => {
    const obj = await originalGet(key);
    if (key === 'kb/docs/长文.md') await gate.promise;
    return obj;
  };
  const pending = Array.from({ length: 10 }, (_, i) => toolReadDoc(env, { query: '长文', offset: i * 8000 }));
  gate.resolve();
  const pages = await Promise.all(pending);
  assert.equal(pages.length, 10);
  for (const page of pages) assert.match(page, /【知识库文档《长文》】/);
  assert.equal(r2.stats.getByKey.get('kb/docs/长文.md'), 1);
  assert.equal(r2.stats.get, 2);
});

test('保存 200000 字符后立即翻页命中穿透缓存，正文 GET 为零', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };
  assert.match(await toolSaveDoc(env, 'c', { title: '长文', content: '正'.repeat(200000) }), /200000 字符/);
  for (const offset of [0, 8000, 192000]) {
    assert.match(await toolReadDoc(env, { query: '长文', offset }), /正/);
  }
  assert.equal(r2.stats.getByKey.get('kb/docs/长文.md') || 0, 0);
});

test('回源发现外部注册表内容改变，旧命中和未命中搜索缓存及正文版本都失效', async () => {
  const r2 = indexedR2('needle OLD');
  const env = { R2: r2 };
  let reg = await kbGetRegistry(env);
  assert.match((await kbSearchDocBodyEx(env, reg, 'needle')).snippet, /OLD/);
  assert.equal((await kbSearchDocBodyEx(env, reg, 'needle')).cached, true);
  assert.equal((await kbSearchDocBodyEx(env, reg, 'freshword')).snippet, null);
  assert.equal((await kbSearchDocBodyEx(env, reg, 'freshword')).cached, true);
  const version = kbRegistryVersion();
  r2.data.set('kb/docs/说明.md', docBody('说明', 'needle NEW freshword'));
  r2.data.set('kb/docs/registry.json', JSON.stringify([{ ...reg[0], updated_at: 'v2', version: 2 }]));
  reg = await kbGetRegistry(env, { fresh: true });
  assert.ok(kbRegistryVersion() > version);
  const found = await kbSearchDocBodyEx(env, reg, 'needle');
  assert.notEqual(found.cached, true);
  assert.match(found.snippet, /NEW/);
  assert.doesNotMatch(found.snippet, /OLD/);
  assert.match((await kbSearchDocBodyEx(env, reg, 'freshword')).snippet, /freshword/);
  assert.equal(r2.stats.getByKey.get('kb/docs/说明.md'), 2);
  assert.equal(r2.stats.put, 0);
});

test('仅 etag 改变也使搜索缓存失效，CAS 成功缓存新 etag，未变回源不增版本', async () => {
  const r2 = indexedR2();
  const env = { R2: r2 };
  let etag = 'etag-1';
  const originalGet = r2.get;
  const originalPut = r2.put;
  r2.get = async (key) => {
    const obj = await originalGet(key);
    return obj ? { ...obj, etag } : null;
  };
  r2.put = async (key, value, opts) => {
    assert.equal(opts.onlyIf.etagMatches, etag);
    await originalPut(key, value);
    etag = 'etag-3';
    return { etag };
  };
  let cur = await kbGetRegistryEx(env);
  await kbSearchDocBodyEx(env, cur.reg, 'needle');
  assert.equal((await kbSearchDocBodyEx(env, cur.reg, 'needle')).cached, true);
  const version = kbRegistryVersion();
  etag = 'etag-2';
  cur = await kbGetRegistryEx(env, { fresh: true });
  assert.ok(kbRegistryVersion() > version);
  assert.notEqual((await kbSearchDocBodyEx(env, cur.reg, 'needle')).cached, true);
  assert.equal(await kbSaveRegistry(env, cur.reg, { expectEtag: cur.etag }), true);
  assert.equal((await kbGetRegistryEx(env)).etag, 'etag-3');
  const afterWrite = kbRegistryVersion();
  await kbGetRegistryEx(env, { fresh: true });
  assert.equal(kbRegistryVersion(), afterWrite);
  assert.equal(r2.stats.put, 1);
  assert.equal(r2.stats.getByKey.get('kb/docs/说明.md'), 1);
});

async function fillBodyCache(env, count, chars = 200000, at = 'v1') {
  for (let i = 0; i < count; i++) {
    const key = 'kb/docs/budget' + i + '.md';
    env.R2.data.set(key, 'A'.repeat(chars));
    assert.equal((await kbReadDocTextCached(env, key, at)).length, chars);
  }
}

test('总字符预算 400 万：21 篇各 20 万字符淘汰最旧一篇', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };
  await fillBodyCache(env, 21);
  assert.equal(r2.stats.get, 21);
  for (let i = 1; i < 21; i++) await kbReadDocTextCached(env, 'kb/docs/budget' + i + '.md', 'v1');
  assert.equal(r2.stats.get, 21, '预算内 20 篇仍命中');
  await kbReadDocTextCached(env, 'kb/docs/budget0.md', 'v1');
  assert.equal(r2.stats.get, 22, '超预算的最旧一篇已被淘汰');
});

test('400 万预算也计算搜索生成的小写副本', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };
  await fillBodyCache(env, 20);
  await kbSearchDocBodyEx(env, [{ file: 'budget19.md', updated_at: 'v1' }], 'absentword');
  assert.equal(r2.stats.get, 20, '搜索正文原已缓存');
  for (let i = 1; i < 20; i++) await kbReadDocTextCached(env, 'kb/docs/budget' + i + '.md', 'v1');
  assert.equal(r2.stats.get, 20);
  await kbReadDocTextCached(env, 'kb/docs/budget0.md', 'v1');
  assert.equal(r2.stats.get, 21, '小写副本占 20 万字符，应淘汰最旧正文');
});

test('缓存替换不重复占预算，版本不符重新 GET，超大新版本不保留旧缓存', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };
  await fillBodyCache(env, 20);
  const key = 'kb/docs/budget0.md';
  r2.data.set(key, 'B'.repeat(200000));
  assert.equal((await kbReadDocTextCached(env, key, 'v2'))[0], 'B');
  for (let i = 1; i < 20; i++) await kbReadDocTextCached(env, 'kb/docs/budget' + i + '.md', 'v1');
  assert.equal(r2.stats.get, 21, '替换后其他 19 篇不能被错误淘汰');
  r2.data.set(key, 'C'.repeat(210001));
  assert.equal((await kbReadDocTextCached(env, key, 'v3')).length, 210001);
  assert.equal((await kbReadDocTextCached(env, key))[0], 'C', '超大替换不能残留旧版本');
  assert.equal(r2.stats.get, 23);
});

test('插入时清除过期正文并回收字符预算，不误淘汰仍有效正文', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const r2 = makeR2();
  const env = { R2: r2 };
  await fillBodyCache(env, 1);
  now += 1000;
  await fillBodyCache(env, 20);
  now += 299001;
  r2.data.set('kb/docs/new.md', 'B'.repeat(200000));
  await kbReadDocTextCached(env, 'kb/docs/new.md', 'v1');
  for (let i = 1; i < 20; i++) await kbReadDocTextCached(env, 'kb/docs/budget' + i + '.md', 'v1');
  assert.equal(r2.stats.get, 21, '过期项释放预算后，19 篇仍有效正文应全部命中');
  await kbReadDocTextCached(env, 'kb/docs/budget0.md', 'v1');
  assert.equal(r2.stats.get, 22, 'TTL 到期正文必须重新 GET');
});

test('小文档仍受 64 篇容量限制，且各桶正文缓存隔离', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };
  await fillBodyCache(env, 65, 10);
  await kbReadDocTextCached(env, 'kb/docs/budget64.md', 'v1');
  assert.equal(r2.stats.get, 65);
  await kbReadDocTextCached(env, 'kb/docs/budget0.md', 'v1');
  assert.equal(r2.stats.get, 66);
  const other = makeR2({ 'kb/docs/budget0.md': '独立桶正文' });
  assert.equal(await kbReadDocTextCached({ R2: other }, 'kb/docs/budget0.md', 'v1'), '独立桶正文');
  assert.equal(other.stats.get, 1);
});
