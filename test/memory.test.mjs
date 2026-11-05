// 三层记忆回归测试：假 R2 内存桶，验证
// L1 要点抽取 / 同话题合并 / 溢出沉淀 / TTL 过期 / 固定项，
// L2 主题覆盖 / 命中计数 / 旧格式迁移 / 容量淘汰，
// L3 归档去重与检索，以及统一检索、提示词渲染与统计报告。
// 不联网、不依赖 Cloudflare 运行时。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractTopic, extractGist, jaccard, memDecayScore, memTokens, memSubjectKey, memNorm,
  wmKey, ltKey, arKey, memLimits, memBudgets, WM_MAX_ITEMS, WM_PIN_MAX, LT_MAX_ITEMS
} from '../src/memory/layers.js';
import { wmGet, wmRecordTurn, wmPin, wmUnpin, wmClear } from '../src/memory/working.js';
import { ltGet, ltSave, ltForget, rankLongterm } from '../src/memory/longterm.js';
import { arGet, arPush, rankArchive } from '../src/memory/archive.js';
import {
  memoryLoad, memoryPromptBlock, memorySearchText, memoryReport, memoryStatsText, pickLongterm
} from '../src/memory/index.js';
import { buildAgentSystemPrompt } from '../src/agent/prompt.js';
import { getAgentTools } from '../src/agent/tools.js';

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

const DAY = 86400000;

// ==================== 纯函数 ====================

test('extractTopic 去掉客套前缀与 Markdown 记号，只留问题主干', () => {
  assert.equal(extractTopic('帮我查一下北京明天的天气'), '查一下北京明天的天气');
  assert.equal(extractTopic('## 你好世界\n第二行内容'), '你好世界');
  assert.equal(extractTopic('- 对比 Workers 与 Lambda 冷启动'), '对比 Workers 与 Lambda 冷启动');
  assert.equal(extractTopic('嗯'), '', '过短的消息不应产生要点');
  assert.equal(extractTopic(''), '');
});

test('extractGist 跳过代码块与链接语法，取第一句结论', () => {
  const g = extractGist('```js\nconsole.log(1)\n```\n结论是 **Workers 冷启动更快**。补充说明。');
  assert.equal(g, '结论是 Workers 冷启动更快。');
  assert.equal(extractGist('[文档](https://a.example) 已保存'), '文档 已保存');
  assert.equal(extractGist(''), '');
});

test('jaccard 能识别重复话题，且不会把不同对象合并', () => {
  assert.ok(jaccard('北京今天天气怎么样', '北京今天天气怎么样？') > 0.6);
  assert.ok(jaccard('北京天气', '上海天气') < 0.3);
  assert.equal(jaccard('', 'x'), 0);
});

test('memDecayScore 随时间衰减、随权重与命中上升', () => {
  const now = Date.now();
  const fresh = { fact: 'a', ts: now, weight: 3, hits: 0 };
  const old = { fact: 'a', ts: now - 90 * DAY, weight: 3, hits: 0 };
  assert.ok(memDecayScore(fresh, now) > memDecayScore(old, now), '越久远分数越低');

  const heavy = { fact: 'a', ts: now, weight: 5, hits: 0 };
  assert.ok(memDecayScore(heavy, now) > memDecayScore(fresh, now), '权重越高分数越高');

  const hot = { fact: 'a', ts: now, weight: 3, hits: 20 };
  assert.ok(memDecayScore(hot, now) > memDecayScore(fresh, now), '命中越多分数越高');
  // 命中加成有上限，不会让一条老记忆永久霸榜
  assert.ok(memDecayScore({ fact: 'a', ts: now, weight: 3, hits: 9999 }, now) <= 3 + 1.5 + 1e-9);
});

test('memSubjectKey 只在「主语 + 是/为/:/=」结构上生效', () => {
  assert.equal(memSubjectKey('我的手机号是 13800000000'), '我的手机号');
  assert.equal(memSubjectKey('猫叫汤圆'), null, '没有分隔符时不做主题判断，宁可多存一条');
  assert.equal(memSubjectKey('我是程序员'), null, '单字主语太短，保守起见不做主题判断');
  assert.equal(memNorm('  我 养了 一只猫 '), '我养了一只猫');
});

// ==================== L1 工作记忆 ====================

test('L1 记录一轮问答后生成要点，同话题重复只保留一条', async () => {
  const env = { R2: makeR2() };
  const id = 'l1-basic';
  const r1 = await wmRecordTurn(env, id, '北京今天天气怎么样', '北京今天晴，12~20℃。');
  assert.equal(r1.added, true);
  assert.equal(r1.merged, false);

  const wm = await wmGet(env, id);
  assert.equal(wm.items.length, 1);
  assert.equal(wm.items[0].t, '北京今天天气怎么样');
  assert.ok(wm.items[0].g.includes('12~20℃'));

  // 同一句话再问一次：合并而不是新增
  const r2 = await wmRecordTurn(env, id, '北京今天天气怎么样？', '仍然晴，13~21℃。');
  assert.equal(r2.merged, true);
  const wm2 = await wmGet(env, id);
  assert.equal(wm2.items.length, 1, '重复话题不应占两个槽位');
  assert.ok(wm2.items[0].g.includes('13~21℃'), '合并后应保留最新结论');
});

test('L1 超过容量时最旧的一条沉淀进 L3 归档，而不是被丢弃', async () => {
  const seeded = {
    v: 1, chatId: 'l1-spill', updatedAt: Date.now(),
    items: Array.from({ length: WM_MAX_ITEMS }, (_, i) => ({ t: '历史话题' + i, g: '结论' + i, ts: Date.now() - (WM_MAX_ITEMS - i) * 60000 })),
    pins: []
  };
  const env = { R2: makeR2({ [wmKey('l1-spill')]: JSON.stringify(seeded) }) };

  const r = await wmRecordTurn(env, 'l1-spill', '一个全新的话题：如何配置 Cloudflare R2', '先建桶再绑定。');
  assert.equal(r.spilled, 1);

  const wm = await wmGet(env, 'l1-spill');
  assert.equal(wm.items.length, WM_MAX_ITEMS);
  assert.equal(wm.items[wm.items.length - 1].t, '一个全新的话题：如何配置 Cloudflare R2');
  assert.equal(wm.items[0].t, '历史话题1', '被挤掉的是最旧的那条');

  const ar = await arGet(env, 'l1-spill');
  assert.equal(ar.items.length, 1);
  assert.equal(ar.items[0].type, 'session');
  assert.ok(ar.items[0].text.includes('历史话题0'));
});

test('L1 超过 7 天无活动视为会话结束，读出来是空的', async () => {
  const stale = { v: 1, chatId: 'l1-ttl', updatedAt: Date.now() - 8 * DAY, items: [{ t: '旧话题内容', g: '旧结论', ts: Date.now() - 8 * DAY }], pins: [] };
  const env = { R2: makeR2({ [wmKey('l1-ttl')]: JSON.stringify(stale) }) };
  const wm = await wmGet(env, 'l1-ttl');
  assert.equal(wm.items.length, 0);
});

test('L1 固定项：pin 去重、上限裁剪、unpin 按关键词删除', async () => {
  const env = { R2: makeR2() };
  const id = 'l1-pin';
  const a = await wmPin(env, id, '这次都用英文回答');
  assert.equal(a.ok, true);
  assert.equal(a.count, 1);

  const b = await wmPin(env, id, '这次都用英文回答');
  assert.equal(b.duplicate, true);
  assert.equal(b.count, 1);

  for (let i = 0; i < WM_PIN_MAX + 2; i++) await wmPin(env, id, '约束' + i);
  const wm = await wmGet(env, id);
  assert.equal(wm.pins.length, WM_PIN_MAX, '固定项也要有上限，否则会挤占 L1 预算');

  const un = await wmUnpin(env, id, '约束5');
  assert.ok(un.removed >= 1);

  await wmClear(env, id);
  assert.equal((await wmGet(env, id)).pins.length, 0);
});

// ==================== L2 长期记忆 ====================

test('L2 保存事实：完全重复只提升命中次数，同主题改口自动覆盖', async () => {
  const env = { R2: makeR2() };
  const id = 'l2-save';

  const r1 = await ltSave(env, id, '我的手机号是 13800000000');
  assert.ok(r1.includes('已记住'));

  const dup = await ltSave(env, id, '我的手机号是 13800000000');
  assert.ok(dup.includes('已记住过'));
  const arr1 = await ltGet(env, id);
  assert.equal(arr1.length, 1);
  assert.equal(arr1[0].hits, 1, '重复保存应提升命中次数');

  const upd = await ltSave(env, id, '我的手机号是 13900000000');
  assert.ok(upd.includes('已自动更新记忆'));
  const arr2 = await ltGet(env, id);
  assert.equal(arr2.length, 1, '同主题只保留最新一条');
  assert.equal(arr2[0].fact, '我的手机号是 13900000000');
});

test('L2 保存带 kind 与 weight，并写进 md 镜像 frontmatter', async () => {
  const env = { R2: makeR2() };
  const id = 'l2-kind';
  await ltSave(env, id, '用户偏好用 TypeScript 写示例', { kind: 'pref', weight: 5 });
  const arr = await ltGet(env, id);
  assert.equal(arr.length, 1);
  assert.equal(arr[0].kind, 'pref');
  assert.equal(arr[0].weight, 5);

  const mdKey = [...env.R2.data.keys()].find(k => k.startsWith('kb/mem/' + id + '/'));
  assert.ok(mdKey, '应写入 md 镜像');
  const md = env.R2.data.get(mdKey);
  assert.ok(md.includes('kind: pref'));
  assert.ok(md.includes('weight: 5'));
});

test('L2 旧格式自动迁移：kb/agent_mem_ 与根目录 agent_mem_ 都能读出来', async () => {
  const legacyArr = [
    { fact: '用户在杭州工作', ts: Date.now() - 1000, file: 'a.md' },
    { fact: '用户喜欢手冲咖啡', ts: Date.now() - 2000, file: 'b.md' },
  ];
  const env = { R2: makeR2({ 'kb/agent_mem_legacy-kb': JSON.stringify(legacyArr) }) };
  const arr = await ltGet(env, 'legacy-kb');
  assert.equal(arr.length, 2);
  assert.equal(arr[0].kind, 'fact', '旧条目补齐默认字段');
  assert.equal(arr[0].weight, 3);
  assert.ok(env.R2.data.has(ltKey('legacy-kb')), '读到旧键应写一份到新键');

  const env2 = { R2: makeR2({ 'agent_mem_legacy-root': JSON.stringify(legacyArr) }) };
  const arr2 = await ltGet(env2, 'legacy-root');
  assert.equal(arr2.length, 2);
});

test('L2 容量到顶时淘汰最弱的一条并归档到 L3', async () => {
  const now = Date.now();
  const seed = [];
  for (let i = 0; i < LT_MAX_ITEMS - 1; i++) {
    seed.push({ fact: '重要事实' + i, ts: now - i * 1000, weight: 5, hits: 3, kind: 'fact', file: '' });
  }
  // 一条又老又低权重的事实，必然是被淘汰的那个
  seed.push({ fact: '很久以前随口提过的小事', ts: now - 400 * DAY, weight: 1, hits: 0, kind: 'fact', file: '' });

  const env = { R2: makeR2({ [ltKey('l2-evict')]: JSON.stringify(seed) }) };
  const msg = await ltSave(env, 'l2-evict', '一条新的重要事实');
  assert.ok(msg.includes('归档到 L3'), '淘汰必须在返回文案里如实说明：' + msg);

  const arr = await ltGet(env, 'l2-evict');
  assert.equal(arr.length, LT_MAX_ITEMS);
  assert.equal(arr.some(m => m.fact === '很久以前随口提过的小事'), false, '最弱的一条应被淘汰');
  assert.equal(arr.some(m => m.fact === '一条新的重要事实'), true);

  const ar = await arGet(env, 'l2-evict');
  assert.equal(ar.items.length, 1);
  assert.equal(ar.items[0].type, 'memory');
  assert.ok(ar.items[0].text.includes('很久以前随口提过的小事'));
});

test('L2 按关键词删除，并同步删除 md 镜像', async () => {
  const env = { R2: makeR2() };
  const id = 'l2-forget';
  await ltSave(env, id, '我养了一只猫叫汤圆');
  await ltSave(env, id, '我在杭州工作');
  const before = [...env.R2.data.keys()].filter(k => k.startsWith('kb/mem/' + id + '/'));
  assert.equal(before.length, 2);

  const rr = await ltForget(env, id, '汤圆');
  assert.equal(rr.removed, 1);
  const arr = await ltGet(env, id);
  assert.equal(arr.length, 1);
  assert.equal(arr[0].fact, '我在杭州工作');
  const after = [...env.R2.data.keys()].filter(k => k.startsWith('kb/mem/' + id + '/'));
  assert.equal(after.length, 1, '被删条目的 md 镜像也要清掉');
});

test('rankLongterm 相关性优先，无命中时按衰减分排序', () => {
  const now = Date.now();
  const arr = [
    { fact: '用户喜欢喝茶', ts: now, weight: 3, hits: 0 },
    { fact: '用户的猫叫汤圆', ts: now - DAY, weight: 3, hits: 0 },
  ];
  const hit = rankLongterm(arr, '汤圆', 5);
  assert.equal(hit[0].fact, '用户的猫叫汤圆');

  const byScore = rankLongterm(arr, '', 5);
  assert.equal(byScore[0].fact, '用户喜欢喝茶', '没有关键词时新且重要的排在前面');
});

// ==================== L3 归档 ====================

test('L3 归档按内容去重，只保留最新一份', async () => {
  const env = { R2: makeR2() };
  const id = 'l3-dedupe';
  await arPush(env, id, [{ type: 'session', text: '讨论过 R2 生命周期规则', ts: 1 }]);
  await arPush(env, id, [{ type: 'session', text: '讨论过  R2 生命周期规则', ts: 2 }]);
  const ar = await arGet(env, id);
  assert.equal(ar.items.length, 1);
  assert.equal(ar.items[0].ts, 2);
});

test('rankArchive 只返回命中项，并按命中强度排序', () => {
  const items = [
    { type: 'session', text: '讨论过 Cloudflare Workers 冷启动', ts: 1 },
    { type: 'memory', text: '用户喜欢手冲咖啡', ts: 2 },
  ];
  const hits = rankArchive(items, 'Workers 冷启动', 3);
  assert.equal(hits.length, 1);
  assert.ok(hits[0].text.includes('Workers'));
  assert.equal(rankArchive(items, '完全不相关的词', 3).length, 0);
});

// ==================== 统一编排 ====================

test('memoryLoad 并行加载三层，只读端跳过 L2/L3', async () => {
  const env = { R2: makeR2() };
  const id = 'load-1';
  await wmRecordTurn(env, id, '如何配置 Cloudflare R2 存储桶', '先建桶再绑定。');
  await ltSave(env, id, '用户在杭州工作');
  await arPush(env, id, [{ type: 'memory', text: '旧记忆：用户曾用 Notion', ts: 1 }]);

  const full = await memoryLoad(env, id, 'R2 存储桶');
  assert.equal(full.stats.l1Items, 1);
  assert.equal(full.stats.l2, 1);
  assert.equal(full.stats.l3, 1);

  const ro = await memoryLoad(env, id, 'R2 存储桶', { readOnly: true });
  assert.equal(ro.stats.l1Items, 1, '只读端仍读 L1');
  assert.equal(ro.stats.l2, 0, '只读端跳过 L2，省两次 R2 往返');
  assert.equal(ro.stats.l3, 0);
});

test('memoryPromptBlock 渲染三层标题、预算受控，并声明冲突取值规则', async () => {
  const env = { R2: makeR2() };
  const id = 'prompt-1';
  await wmRecordTurn(env, id, '如何配置 Cloudflare R2 存储桶', '先建桶再绑定。');
  await ltSave(env, id, '用户偏好用 TypeScript 写示例', { kind: 'pref', weight: 5 });
  await arPush(env, id, [{ type: 'memory', text: '旧记忆：R2 曾用来存图片，后来迁走了', ts: 1 }]);

  const bundle = await memoryLoad(env, id, 'R2 存储桶怎么配');
  const block = memoryPromptBlock(bundle, 'R2 存储桶怎么配');
  assert.ok(block.includes('【三层记忆 · L1 工作记忆'));
  assert.ok(block.includes('【三层记忆 · L2 用户长期记忆'));
  assert.ok(block.includes('【三层记忆 · L3 历史归档'));
  assert.ok(block.includes('[偏好·权重5]'));
  assert.ok(block.includes('L1（本会话最新）> L2 > L3'), '必须写明冲突取值顺序');

  const empty = memoryPromptBlock({ working: { items: [], pins: [] }, longterm: [], archive: { items: [] } }, 'x');
  assert.equal(empty, '', '三层全空时不应产生任何提示词开销');
});

test('提示词接入三层后，稳定前缀仍然不受动态内容影响', async () => {
  const bundleA = { working: { items: [{ t: '话题甲', g: '结论甲', ts: 1 }], pins: [] }, longterm: [], archive: { items: [] } };
  const bundleB = { working: { items: [{ t: '话题乙', g: '结论乙', ts: 2 }], pins: [] }, longterm: [], archive: { items: [] } };
  const a = buildAgentSystemPrompt([], '甲', [{ title: 'A' }], false, bundleA);
  const b = buildAgentSystemPrompt([], '乙', [{ title: 'B' }], false, bundleB);
  const firstDynamic = (s) => {
    const marks = ['【知识库文档列表】', '【三层记忆 · L1', '【当前时间】']
      .map(m => s.indexOf(m)).filter(i => i >= 0);
    return marks.length ? Math.min(...marks) : s.length;
  };
  assert.equal(a.slice(0, firstDynamic(a)), b.slice(0, firstDynamic(b)));
  assert.ok(a.includes('【三层记忆 · L1'));
  // 不传 bundle 时仍走旧版单层渲染，老调用方行为不变
  const legacy = buildAgentSystemPrompt([{ fact: '用户喜欢喝茶', ts: 1 }], '茶', [], false);
  assert.ok(legacy.includes('【关于用户的长期记忆】'));
});

test('memory 统一检索一次问三层，并标明来源层', async () => {
  const env = { R2: makeR2() };
  const id = 'search-1';
  await wmRecordTurn(env, id, '帮我看下 R2 的生命周期规则怎么设', '在控制台按前缀配置。');
  await ltSave(env, id, '用户的 R2 存储桶叫 chat-r2');
  await arPush(env, id, [{ type: 'memory', text: '旧记忆：R2 曾用于存放图片', ts: 1 }]);

  const text = await memorySearchText(env, id, 'R2');
  assert.ok(text.includes('L1 工作记忆'));
  assert.ok(text.includes('L2 长期记忆'));
  assert.ok(text.includes('L3 历史归档'));
  assert.ok(text.includes('不是实时信息'), '必须提醒记忆不是实时数据');

  const miss = await memorySearchText(env, id, '量子计算');
  assert.ok(miss.includes('都没有找到'));
});

test('memory 工具在只读端拒绝 pin，但允许 search / stats', async () => {
  const { execAgentTool } = await import('../src/agent/tools.js');
  const env = { R2: makeR2() };
  const id = 'tool-ro';

  const pin = await execAgentTool('memory', { action: 'pin', text: '这次都用英文' }, env, id, true, {});
  assert.ok(pin.includes('只读模式'));

  const stats = await execAgentTool('memory', { action: 'stats' }, env, id, true, {});
  assert.ok(stats.includes('L1 工作记忆'));

  const search = await execAgentTool('memory', { action: 'search', query: '咖啡' }, env, id, true, {});
  assert.ok(search.includes('都没有找到'));
});

test('memoryReport 输出三层视图与操作提示', async () => {
  const env = { R2: makeR2() };
  const id = 'report-1';
  await wmRecordTurn(env, id, '如何配置 Cloudflare R2 存储桶', '先建桶再绑定。');
  await ltSave(env, id, '用户在杭州工作');
  const text = await memoryReport(env, id);
  assert.ok(text.includes('▸ L1 工作记忆'));
  assert.ok(text.includes('▸ L2 长期记忆'));
  assert.ok(text.includes('▸ L3 归档'));
  assert.ok(text.includes('用户在杭州工作'));
  assert.ok(text.includes('/forget'));

  const stats = await memoryStatsText(env, id);
  assert.ok(stats.includes('L1 工作记忆'));
});

test('pickLongterm 遵守字符预算，不会把全部记忆硬塞进提示词', () => {
  const arr = Array.from({ length: 50 }, (_, i) => ({
    fact: '第' + i + '条记忆' + 'x'.repeat(80), ts: Date.now(), weight: 3, hits: 0
  }));
  const picked = pickLongterm(arr, '记忆', 300);
  assert.ok(picked.length > 0);
  const total = picked.reduce((s, m) => s + m.fact.length, 0);
  assert.ok(total <= 300, '注入内容必须落在预算内，实际 ' + total);
});

test('L2 在未绑定 R2 时退化为内存并如实告知', async () => {
  const env = {};
  const id = 'no-r2';
  const msg = await ltSave(env, id, '用户喜欢手冲咖啡');
  assert.ok(msg.includes('R2 未绑定'));
  const arr = await ltGet(env, id);
  assert.equal(arr.length, 1, '纯内存模式下同一 isolate 内仍可读到');
});

test('工具定义包含 memory 且只读端不暴露写入类工具', () => {
  const rw = getAgentTools(false, { hasKbDocs: true }).map(t => t.function.name);
  const ro = getAgentTools(true, { hasKbDocs: true }).map(t => t.function.name);
  assert.ok(rw.includes('memory'));
  assert.ok(ro.includes('memory'), '只读端也要能检索记忆');
  assert.equal(ro.includes('remember'), false);
  assert.equal(ro.includes('forget_memory'), false);
});

test('三层存储键按 chatId 隔离，非法字符不会造成路径穿越', async () => {
  assert.equal(wmKey('a/../../b'), 'kb/mem3/work/ab.json', '路径分隔符与点号全部剥离');
  assert.ok(wmKey('../../etc').indexOf('..') === -1);
  assert.ok(arKey('../../etc').indexOf('..') === -1);
  const env = { R2: makeR2() };
  await ltSave(env, 'userA', 'A 的事实');
  const b = await ltGet(env, 'userB');
  assert.equal(b.length, 0, '不同会话的记忆不能串档');
});

test('容量与提示词预算可通过环境变量调整，越界自动夹取', async () => {
  const env = { R2: makeR2(), MEM_L1_MAX_ITEMS: '4' };
  const topics = [
    '如何配置 Cloudflare R2 存储桶',
    '北京今天天气怎么样',
    '量子计算的物理原理',
    'Python 装饰器的执行顺序',
    '上海到杭州的高铁班次',
    '咖啡豆浅烘与深烘的区别',
  ];
  for (const t of topics) await wmRecordTurn(env, 'cfg-l1', t, '这是结论。');
  const wm = await wmGet(env, 'cfg-l1');
  assert.equal(wm.items.length, 4, 'MEM_L1_MAX_ITEMS=4 时应只保留 4 条');
  const ar = await arGet(env, 'cfg-l1');
  assert.equal(ar.items.length, 2, '溢出的 2 条应沉淀到 L3');

  // 越界值一律夹到安全范围，不会因为写错环境变量把记忆写爆或清空
  assert.equal(memLimits({ MEM_L1_MAX_ITEMS: '999' }).l1, 30);
  assert.equal(memLimits({ MEM_L1_MAX_ITEMS: '0' }).l1, 4);
  assert.equal(memLimits({ MEM_L2_MAX_ITEMS: 'abc' }).l2, LT_MAX_ITEMS);
  assert.equal(memLimits({ MEM_PROMPT_BUDGET: '100' }).promptBudget, 1500);

  const b = memBudgets(5500);
  assert.deepEqual(b, { L1: 1600, L2: 3000, L3: 900 });
  const small = memBudgets(2200);
  assert.equal(small.L1 + small.L2 + small.L3, 2200, '分层预算之和必须等于总预算');
});

test('用户明确在回忆但词面没命中时，L3 用最近归档兜底', () => {
  const bundle = {
    working: { items: [], pins: [] },
    longterm: [],
    archive: { items: [{ type: 'memory', text: '旧记忆：用户曾评估过 Vercel Edge Functions', ts: Date.now() - DAY }] },
    budgets: { L1: 1600, L2: 3000, L3: 900 }
  };
  const recall = memoryPromptBlock(bundle, '你还记得我之前评估过哪些边缘计算平台吗');
  assert.ok(recall.includes('【三层记忆 · L3 历史归档'), '带回忆意图时应给出最近归档');

  const plain = memoryPromptBlock(bundle, '帮我写个快速排序');
  assert.equal(plain.includes('【三层记忆 · L3'), false, '普通提问不应把无关归档塞进提示词');
});
