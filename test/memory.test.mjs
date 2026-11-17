// 三层记忆回归测试：假 R2 内存桶（带 etag / onlyIf，真实 exercising CAS），验证
// L1 要点抽取 / 同话题合并 / 溢出沉淀 / TTL 过期 / 固定项，
// L2 主题覆盖 / 命中计数 / 旧格式迁移 / 容量淘汰，
// L3 归档去重与检索，以及统一检索、提示词渲染与统计报告。
// v7.20.0：三层合并单对象 kb/mem3/<chatId>.json（CAS 读改写 + 旧键迁移）。
// 不联网、不依赖 Cloudflare 运行时。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractTopic, extractGist, jaccard, memDecayScore, memTokens, memSubjectKey, memNorm,
  memKey, wmKey, ltKey, arKey, memLimits, memBudgets, WM_MAX_ITEMS, WM_PIN_MAX, LT_MAX_ITEMS
} from '../src/memory/layers.js';
import { memSnapshot, memMutate } from '../src/memory/store.js';
import { wmGet, wmRecordTurn, wmPin, wmUnpin, wmClear } from '../src/memory/working.js';
import { ltGet, ltSave, ltForget, ltTouch, rankLongterm } from '../src/memory/longterm.js';
import { arGet, arPush, rankArchive } from '../src/memory/archive.js';
import {
  memoryLoad, memoryPromptBlock, memorySearchText, memoryReport, memoryStatsText, pickLongterm
} from '../src/memory/index.js';
import { buildAgentSystemPrompt } from '../src/agent/prompt.js';
import { getAgentTools } from '../src/agent/tools.js';

function makeR2(initial = {}) {
  const data = new Map();
  const etags = new Map();
  const stats = { get: 0, put: 0, delete: 0, list: 0, casFail: 0 };
  let seq = 0;
  const bytes = (s) => new TextEncoder().encode(String(s)).byteLength;
  const bump = (key) => { seq += 1; etags.set(key, 'e' + seq); return etags.get(key); };
  for (const [k, v] of Object.entries(initial)) { data.set(k, String(v)); bump(k); }
  return {
    stats,
    data,
    etags,
    async get(key, opts) {
      stats.get += 1;
      if (!data.has(key)) return null;
      const etag = etags.get(key);
      if (opts && opts.onlyIf && opts.onlyIf.etagMatches && opts.onlyIf.etagMatches !== etag) return null;
      const text = String(data.get(key));
      return { key, size: bytes(text), etag, text: async () => text };
    },
    async put(key, value, opts) {
      stats.put += 1;
      if (opts && opts.onlyIf && ((opts.onlyIf.etagMatches && etags.get(key) !== opts.onlyIf.etagMatches)
        || (opts.onlyIf.etagDoesNotMatch === '*' && data.has(key)))) {
        stats.casFail += 1;
        return null;
      }
      data.set(key, String(value));
      return { key, etag: bump(key) };
    },
    async delete(key) {
      stats.delete += 1;
      if (Array.isArray(key)) key.forEach(k => { data.delete(k); etags.delete(k); });
      else { data.delete(key); etags.delete(key); }
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
  assert.ok(env.R2.data.has(memKey('legacy-kb')), '读到旧键应写一份到统一键');
  assert.ok(env.R2.data.has('kb/agent_mem_legacy-kb'), '旧键保留作回滚副本');

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

// ==================== v7.20.0 统一单对象存储 ====================

test('统一键：稳态冷读只有 1 次 GET，三层共享同一次加载', async () => {
  const now = Date.now();
  const unified = {
    v: 2, chatId: 'uni-read',
    work: { updatedAt: now, items: [{ t: '话题', g: '结论', ts: now }], pins: [] },
    long: [{ fact: '用户在杭州工作', ts: now, file: 'a.md', kind: 'fact', weight: 3, hits: 0, lastUsed: 0 }],
    archive: { items: [{ type: 'session', text: '旧话题', ts: 1 }] }
  };
  const env = { R2: makeR2({ [memKey('uni-read')]: JSON.stringify(unified) }) };
  const bundle = await memoryLoad(env, 'uni-read', '杭州');
  assert.equal(bundle.stats.l1Items, 1);
  assert.equal(bundle.stats.l2, 1);
  assert.equal(bundle.stats.l3, 1);
  assert.equal(env.R2.stats.get, 1, '三层同对象，冷读应只有 1 次 GET（实际 ' + env.R2.stats.get + '）');
  assert.equal(env.R2.stats.put, 0, '读路径不应触发写');
});

test('统一键：三个分层旧键一次性并行迁移合并，旧键保留回滚', async () => {
  const now = Date.now();
  const env = { R2: makeR2({
    [wmKey('uni-mig')]: JSON.stringify({ v: 1, chatId: 'uni-mig', updatedAt: now, items: [{ t: '旧话题', g: '旧结论', ts: now }], pins: [{ text: '用英文回答', ts: now }] }),
    [ltKey('uni-mig')]: JSON.stringify([{ fact: '用户在杭州工作', ts: now, file: 'a.md' }]),
    [arKey('uni-mig')]: JSON.stringify({ v: 1, chatId: 'uni-mig', items: [{ type: 'session', text: '归档话题', ts: 1 }] })
  }) };
  const bundle = await memoryLoad(env, 'uni-mig', '杭州');
  assert.equal(bundle.stats.l1Items, 1);
  assert.equal(bundle.stats.l1Pins, 1);
  assert.equal(bundle.stats.l2, 1);
  assert.equal(bundle.stats.l3, 1);
  assert.ok(env.R2.data.has(memKey('uni-mig')), '迁移应写入统一键');
  assert.ok(env.R2.data.has(wmKey('uni-mig')) && env.R2.data.has(ltKey('uni-mig')) && env.R2.data.has(arKey('uni-mig')), '旧键保留作回滚副本');
  assert.equal(env.R2.stats.get, 6, '统一键 1 次 + 旧键并行探测 5 次（一次性成本）');
  assert.equal(env.R2.stats.put, 1, '迁移只写一次统一键');
});

test('统一键：L1 溢出沉淀与本轮要点在同一次 PUT 里完成（原子）', async () => {
  const now = Date.now();
  const work = {
    updatedAt: now,
    items: Array.from({ length: WM_MAX_ITEMS }, (_, i) => ({ t: '历史话题' + i, g: '结论' + i, ts: now - (WM_MAX_ITEMS - i) * 60000 })),
    pins: []
  };
  const env = { R2: makeR2({ [memKey('uni-atomic')]: JSON.stringify({ v: 2, chatId: 'uni-atomic', work, long: [], archive: { items: [] } }) }) };
  const before = env.R2.stats.put;
  const r = await wmRecordTurn(env, 'uni-atomic', '一个全新的话题：如何配置 R2 生命周期', '按前缀配置。');
  assert.equal(r.spilled, 1);
  assert.equal(env.R2.stats.put - before, 1, '要点 + 沉淀只该有一次 PUT');
  const obj = JSON.parse(env.R2.data.get(memKey('uni-atomic')));
  assert.equal(obj.work.items.length, WM_MAX_ITEMS);
  assert.equal(obj.archive.items.length, 1);
  assert.ok(obj.archive.items[0].text.includes('历史话题0'));
});

test('统一键：跨 isolate CAS 冲突重读重算，两边记忆都不丢', async () => {
  const env = { R2: makeR2() };
  const id = 'uni-cas';
  await ltSave(env, id, '用户喜欢喝茶');
  // 另一个 isolate 抢先写入一条（直接改桶模拟，etag 随之变化）
  const obj = JSON.parse(env.R2.data.get(memKey(id)));
  obj.long.push({ fact: '用户在杭州工作', ts: Date.now(), file: 'other.md', kind: 'fact', weight: 3, hits: 0, lastUsed: 0 });
  await env.R2.put(memKey(id), JSON.stringify(obj));

  const msg = await ltSave(env, id, '用户养了一只猫');
  assert.ok(msg.includes('已记住'), msg);
  assert.ok(env.R2.stats.casFail >= 1, '应触发至少一次条件写冲突');
  const arr = await ltGet(env, id);
  assert.equal(arr.length, 3, '两个 isolate 的三条记忆都必须还在');
});

test('统一键：命中计数搭每轮 L1 写入免费落盘，重启不再清零', async () => {
  const env = { R2: makeR2() };
  const id = 'uni-hits';
  await ltSave(env, id, '用户的猫叫汤圆');
  await memoryLoad(env, id, '汤圆');
  await wmRecordTurn(env, id, '一个完全不相关的新话题：量子计算', '结论。');
  const obj = JSON.parse(env.R2.data.get(memKey(id)));
  assert.ok(obj.long[0].hits >= 1, 'hits 应随 L1 写入落盘（实际 ' + obj.long[0].hits + '）');
});

test('统一键：/clear 只清 work 段，L2/L3 保留且不 DELETE 统一键', async () => {
  const env = { R2: makeR2() };
  const id = 'uni-clear';
  await wmRecordTurn(env, id, '如何配置 R2 存储桶', '先建桶再绑定。');
  await ltSave(env, id, '用户在杭州工作');
  await arPush(env, id, [{ type: 'memory', text: '旧记忆：用户曾用 Notion', ts: 1 }]);
  await wmClear(env, id);
  assert.equal((await wmGet(env, id)).items.length, 0);
  assert.equal((await ltGet(env, id)).length, 1);
  assert.equal((await arGet(env, id)).items.length, 1);
  assert.ok(env.R2.data.has(memKey(id)), '绝不能 DELETE 整个统一键');
});

test('统一键：读失败时如实报错，绝不拿空快照覆盖已有数据', async () => {
  const r2 = makeR2({ [memKey('uni-fail')]: JSON.stringify({
    v: 2, chatId: 'uni-fail', work: { updatedAt: 0, items: [], pins: [] },
    long: [{ fact: '已有记忆', ts: 1, file: 'a.md', kind: 'fact', weight: 3, hits: 0, lastUsed: 0 }],
    archive: { items: [] }
  }) });
  r2.get = async () => { throw new Error('network connection lost'); };
  const msg = await ltSave({ R2: r2 }, 'uni-fail', '一条新事实');
  assert.ok(msg.includes('失败'), msg);
  assert.equal(r2.stats.put, 0, '读失败时不能盲写覆盖已有记忆');
});

test('L1 检索升级为分词打分：词序/插字查询不再漏检', async () => {
  const env = { R2: makeR2() };
  const id = 'l1-token-search';
  await wmRecordTurn(env, id, '帮我看下 R2 的生命周期规则怎么设', '在控制台按前缀配置。');
  const text = await memorySearchText(env, id, 'R2 生命周期');
  assert.ok(text.includes('L1 工作记忆'), '旧版纯子串匹配会漏掉该查询：' + text);
});

test('注入跨层去重：已被 L2 事实覆盖的归档不再重复注入', () => {
  const bundle = {
    working: { items: [], pins: [] },
    longterm: [{ fact: '用户的猫叫汤圆', ts: Date.now(), weight: 3, hits: 0, kind: 'fact' }],
    archive: { items: [
      { type: 'memory', text: '[事实] 用户的猫叫汤圆', ts: 1 },
      { type: 'session', text: '讨论过 R2 生命周期规则配置', ts: 2 }
    ] },
    budgets: { L1: 1600, L2: 3000, L3: 900 }
  };
  const block = memoryPromptBlock(bundle, '汤圆 R2 生命周期');
  assert.ok(block.includes('【三层记忆 · L2'));
  assert.ok(block.includes('讨论过 R2 生命周期规则配置'), '未被覆盖的归档应正常注入');
  const l3Section = block.split('【三层记忆 · L3')[1] || '';
  assert.equal(l3Section.includes('用户的猫叫汤圆'), false, '已被 L2 覆盖的归档不应重复出现');
});

test('同会话并发写串行复用快照：8 次写只有 1 GET、8 PUT、0 冲突', async () => {
  const id = 'queued-memory';
  const env = { R2: makeR2({ [memKey(id)]: JSON.stringify({ v: 2, work: {}, long: [], archive: {} }) }) };
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => memMutate(env, id, draft => {
    draft.long.push({ fact: '并发事实' + i, ts: i });
  })));
  assert.ok(results.every(r => r.ok));
  assert.equal(JSON.parse(env.R2.data.get(memKey(id))).long.length, 8);
  assert.equal(env.R2.stats.get, 1);
  assert.equal(env.R2.stats.put, 8);
  assert.equal(env.R2.stats.casFail, 0);
});

test('同名会话的缓存与写队列按桶隔离', async () => {
  const a = { R2: makeR2() };
  const b = { R2: makeR2() };
  await Promise.all([
    memMutate(a, 'same-bucket-id', s => { s.long.push({ fact: '甲桶' }); }),
    memMutate(b, 'same-bucket-id', s => { s.long.push({ fact: '乙桶' }); })
  ]);
  const [left, right] = await Promise.all([memSnapshot(a, 'same-bucket-id'), memSnapshot(b, 'same-bucket-id')]);
  assert.deepEqual(left.long.map(x => x.fact), ['甲桶']);
  assert.deepEqual(right.long.map(x => x.fact), ['乙桶']);
});

test('跨实例首次创建遇到竞争时重读，不覆盖抢先写入者', async () => {
  const r2 = makeR2();
  const env = { R2: r2 };
  const id = 'create-race';
  const put = r2.put;
  let first = true;
  r2.put = async (key, value, opts) => {
    if (key === memKey(id) && first) {
      first = false;
      await put(key, JSON.stringify({ v: 2, work: {}, long: [{ fact: '另一实例' }], archive: {} }));
    }
    return put(key, value, opts);
  };
  const result = await memMutate(env, id, s => { s.long.push({ fact: '本实例' }); });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(r2.data.get(memKey(id))).long.map(x => x.fact), ['另一实例', '本实例']);
  assert.equal(r2.stats.casFail, 1);
});

test('旧键读取失败不创建不完整统一快照，恢复后能重新迁移', async () => {
  const id = 'legacy-read-failed';
  const env = { R2: makeR2({ [ltKey(id)]: JSON.stringify([{ fact: '旧的事实', file: 'old.md' }]) }) };
  const get = env.R2.get;
  env.R2.get = async (key, opts) => {
    if (key === ltKey(id)) throw new Error('permission denied');
    return get(key, opts);
  };
  const failed = await memMutate(env, id, s => { s.long.push({ fact: '新事实' }); });
  assert.equal(failed.ok, false);
  assert.equal(env.R2.data.has(memKey(id)), false);
  env.R2.get = get;
  const recovered = await memMutate(env, id, s => { s.long.push({ fact: '新事实' }); });
  assert.equal(recovered.ok, true);
  assert.deepEqual(JSON.parse(env.R2.data.get(memKey(id))).long.map(x => x.fact), ['旧的事实', '新事实']);
});

test('损坏的统一对象不能当空数据覆盖', async () => {
  const id = 'invalid-json';
  const env = { R2: makeR2({ [memKey(id)]: '{incomplete' }) };
  const result = await memMutate(env, id, s => { s.long.push({ fact: '新事实' }); });
  assert.equal(result.ok, false);
  assert.equal(env.R2.stats.put, 0);
  assert.equal(env.R2.data.get(memKey(id)), '{incomplete');
});

test('写失败不会缓存成成功，重试相同 pin 会真实落盘', async () => {
  const env = { R2: makeR2() };
  const id = 'retry-pin';
  const put = env.R2.put;
  env.R2.put = async () => { throw new Error('permission denied'); };
  assert.equal((await wmPin(env, id, '本次使用中文')).ok, false);
  env.R2.put = put;
  const result = await wmPin(env, id, '本次使用中文');
  assert.equal(result.ok, true);
  assert.equal(result.persisted, true);
  assert.equal(JSON.parse(env.R2.data.get(memKey(id))).work.pins[0].text, '本次使用中文');
});

test('写队列异常后释放且不同会话不会互相阻塞', async () => {
  const env = { R2: makeR2() };
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const put = env.R2.put;
  env.R2.put = async (key, value, opts) => {
    if (key === memKey('slow-queue')) { started.resolve(); await release.promise; }
    return put(key, value, opts);
  };
  const slow = memMutate(env, 'slow-queue', s => { s.long.push({ fact: '慢写入' }); });
  try {
    await started.promise;
    const fast = await memMutate(env, 'fast-queue', s => { s.long.push({ fact: '快写入' }); });
    assert.equal(fast.ok, true);
  } finally { release.resolve(); await slow; }
  await assert.rejects(memMutate(env, 'fast-queue', () => { throw new Error('mutator failed'); }), /mutator failed/);
  assert.equal((await memMutate(env, 'fast-queue', s => { s.long.push({ fact: '恢复写入' }); })).ok, true);
});

test('迁移遇到别的实例先创建统一对象时保留新对象', async () => {
  const id = 'migration-create-race';
  const env = { R2: makeR2({ [ltKey(id)]: JSON.stringify([{ fact: '旧副本', file: 'old.md' }]) }) };
  const put = env.R2.put;
  let first = true;
  env.R2.put = async (key, value, opts) => {
    if (key === memKey(id) && first) {
      first = false;
      await put(key, JSON.stringify({ v: 2, work: {}, long: [{ fact: '最新记忆', file: 'new.md' }], archive: {} }));
    }
    return put(key, value, opts);
  };
  assert.deepEqual((await memSnapshot(env, id)).long.map(x => x.fact), ['最新记忆']);
  assert.equal(env.R2.stats.casFail, 1);
  assert.equal(env.R2.data.has(ltKey(id)), true);
});

test('PUT 期间新增命中保留到下一次写入，无额外 PUT', async () => {
  const id = 'touch-during-write';
  const env = { R2: makeR2() };
  await ltSave(env, id, '用户喜欢喝茶');
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const put = env.R2.put;
  env.R2.put = async (key, value, opts) => {
    if (key === memKey(id)) { started.resolve(); await release.promise; }
    return put(key, value, opts);
  };
  const writes = env.R2.stats.put;
  const pending = wmPin(env, id, '本次使用中文');
  try {
    await started.promise;
    await ltTouch(env, id, ['用户喜欢喝茶']);
  } finally { release.resolve(); await pending; }
  assert.equal((await memSnapshot(env, id)).long[0].hits, 1);
  assert.equal(env.R2.stats.put - writes, 1);
  await wmPin(env, id, '本次答案简洁');
  assert.equal(JSON.parse(env.R2.data.get(memKey(id))).long[0].hits, 1);
});

test('重复记忆更新失败也必须报告未保存', async () => {
  const env = { R2: makeR2() };
  const id = 'duplicate-failure';
  await ltSave(env, id, '用户喜欢喝茶');
  env.R2.put = async () => { throw new Error('permission denied'); };
  const result = await ltSave(env, id, '用户喜欢喝茶');
  assert.match(result, /失败/);
  assert.equal((await memSnapshot(env, id)).long[0].hits, 0);
});

test('PUT 期间过期的旧读取不会回填缓存或被写后读取复用', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });
  const id = 'late-memory-read';
  const env = { MEM_CACHE_TTL_MS: '5000', R2: makeR2({ [memKey(id)]: JSON.stringify({ v: 2, work: {}, long: [], archive: {} }) }) };
  await memSnapshot(env, id);
  const putStarted = Promise.withResolvers();
  const readStarted = Promise.withResolvers();
  const releasePut = Promise.withResolvers();
  const releaseRead = Promise.withResolvers();
  const put = env.R2.put;
  const get = env.R2.get;
  env.R2.put = async (key, value, opts) => {
    putStarted.resolve();
    await releasePut.promise;
    return put(key, value, opts);
  };
  env.R2.get = async (key, opts) => {
    const obj = await get(key, opts);
    readStarted.resolve();
    await releaseRead.promise;
    return obj;
  };
  const writing = wmPin(env, id, '已保存的新固定项');
  let oldRead;
  try {
    await putStarted.promise;
    t.mock.timers.setTime(1800000006000);
    oldRead = memSnapshot(env, id);
    await readStarted.promise;
    releasePut.resolve();
    assert.equal((await writing).persisted, true);
    const afterWrite = memSnapshot(env, id);
    releaseRead.resolve();
    assert.equal((await afterWrite).work.pins[0]?.text, '已保存的新固定项');
    await oldRead;
    assert.equal((await memSnapshot(env, id)).work.pins[0]?.text, '已保存的新固定项');
  } finally {
    releasePut.resolve();
    releaseRead.resolve();
    await writing;
    if (oldRead) await oldRead;
  }
});

test('forget 读取失败时报告存储失败而非无匹配', async () => {
  const env = { R2: makeR2() };
  env.R2.get = async () => { throw new Error('permission denied'); };
  const result = await ltForget(env, 'forget-read-failure', '喝茶');
  assert.match(result.persistError, /失败/);
  assert.equal(env.R2.stats.put, 0);
});

test('统一键同样防路径穿越', () => {
  assert.equal(memKey('a/../../b'), 'kb/mem3/ab.json');
  assert.ok(memKey('../../etc').indexOf('..') === -1);
});
