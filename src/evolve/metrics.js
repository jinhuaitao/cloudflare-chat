// 自我进化 · 观测层（v7.22.0）
//
// 只做一件事：把每一轮 Agent 的「结果」变成可聚合的数字，不存用户原文。
//   · 不存提问全文、不存回答全文、不存任何密钥与聊天记录；
//   · 只记：渠道 / 人格 / 路由裁决 / 结果（成功/暂停/失败/回落）/ 步数 /
//     每个工具的调用次数、失败次数、耗时 / 截断与纠正/重复信号；
//   · 近 miss 关键词只记「人格 + 候选词 + 次数」，候选词来自提问的分词，
//     长度 2~12 字符，停用词与纯数字已过滤，单日每类上限 100 条。
//
// 成本控制（沿用 v7.20/7.21 的 R2 节流思路）：
//   · 每轮只改 isolate 内存里的 buffer，零 R2 操作；
//   · 攒够 EVO_FLUSH_THRESHOLD 轮（默认 10，可配 1~100）或周期开始时，
//     才一次 CAS 写回当天的日聚合对象；isolate 回收会丢少量未落盘计数——
//     指标是尽力统计，不是审计账本，丢了不影响对话与记忆。

const EVO_STOPWORDS = new Set([
  '怎么', '什么', '为什么', '如何', '请问', '一下', '这个', '那个', '可以', '需要',
  '帮我', '给我', '一个', '我们', '你们', '他们', '如果', '但是', '然后', '以及',
  '是什么', '怎么办', '有没有', '怎么样', '请帮', '麻烦', '谢谢', '你好', '在吗',
  'the', 'and', 'for', 'with', 'what', 'how', 'why', 'when', 'please', 'can',
  'you', 'your', 'this', 'that', 'from', 'about', 'into', 'have', 'has',
]);

const CORRECTION_RE = /(不对|错了|不是这样|你理解错|理解错了|说错了|有误|搞错|不对，|错了，|重新回答|再想想|这不对)/;
const REPEAT_RE = /^(继续|接着|再说一遍|重新说|刚才说什么)/;

function evolveDayKey(d) {
  const t = d instanceof Date ? d : new Date(d || Date.now());
  return t.toISOString().slice(0, 10);
}

function newEvolveDay(date) {
  return {
    v: 1, date: date || evolveDayKey(new Date()),
    total: 0, ok: 0, paused: 0, error: 0, fallback: 0, truncated: 0,
    byChannel: {},
    byGroup: { evolve: { total: 0, paused: 0, error: 0 }, control: { total: 0, paused: 0, error: 0 } },
    // v7.41.0 按提案灰度计数：byProposal[提案 id] = { in: { total, paused, error },
    //   out: { total, paused, error } }——同一份日聚合对象落盘，不新增 R2 key。
    // 只记灰度中的提案（rolloutPercent < 100）；全量提案在/不在没有区别，
    // 不记。只记结果数字，不记提问/回答原文。
    byProposal: {},
    byPersona: {},
    byTool: {},
    // v7.33.0 人格+工具交叉计数（R12 失败聚类）：byPersonaTool[人格][工具]
    //   = { calls, fails }。只记数字，不记调用参数与结果文本；与 byTool
    //   同一份日聚合对象落盘，落盘次数不变。老数据没有该字段时读出来是
    //   undefined，各处一律按 {} 处理，规则回退到不提聚类提案。
    byPersonaTool: {},
    route: { manual: 0, matched: 0, low: 0, ambiguous: 0, chain: 0, followup: 0, tech: 0, review: 0 },
    signals: { correction: 0, repeat: 0, continue: 0 },
    outcomesByPersona: {},
    nearMiss: {},
    kbMissTopics: {},
  };
}

function pruneCounts(obj, max) {
  if (!obj || typeof obj !== 'object') return obj;
  const keys = Object.keys(obj);
  if (keys.length <= max) return obj;
  const sorted = keys.sort((a, b) => {
    const av = typeof obj[a] === 'object' ? (obj[a].total || 0) : obj[a];
    const bv = typeof obj[b] === 'object' ? (obj[b].total || 0) : obj[b];
    return bv - av;
  });
  for (const k of sorted.slice(max)) delete obj[k];
  return obj;
}

// v7.41.0：byProposal 的上限与 pruneCounts 同口径，但槽位是
// { in: { total }, out: { total } } 两层，按两组总量之和排，
// 超过 20 个提案的只留量最大的 20 条，日聚合对象不会无限膨胀。
function pruneProposalCounts(obj, max) {
  if (!obj || typeof obj !== 'object') return obj;
  const keys = Object.keys(obj);
  if (keys.length <= max) return obj;
  const totalOf = (v) => ((v && v.in && v.in.total) || 0) + ((v && v.out && v.out.total) || 0);
  const sorted = keys.sort((a, b) => totalOf(obj[b]) - totalOf(obj[a]));
  for (const k of sorted.slice(max)) delete obj[k];
  return obj;
}

// v7.27.0 工具耗时分位数：每个工具的日聚合槽位（byTool[name]）多一个
// `samples` 字段——最近 N 次单次调用耗时（毫秒整数），先进先出、只留
// 最近 N 条，有界，R2 对象不会无限膨胀。只记耗时数字，不记任何调用
// 参数与结果文本。
//   · 数据来源（v7.36.0 起是逐次实测）：loop.js 在每次真实执行工具
//     调用后就把单次耗时（毫秒整数）记进事件的 toolCalls[i].samples，
//     merge 时原样追加——p50/p95 是真分位数。v7.27.0 时 loop.js 只
//     上报每轮每工具的聚合（calls 次调用的总耗时 ms），单次耗时在
//     上报时已经丢了，所以每条聚合按 calls 展开成 calls 个样本，值
//     取轮内平均 ms/calls（四舍五入到毫秒）；那是旧事件（没有
//     samples 字段）的回退口径，样本数与真实调用数一致，但同一轮内
//     多次调用的方差被平均抹平，读数时按「轮内平均的分布」理解，
//     不要当成逐次实测。
//   · 空 samples 数组表示本轮该工具没有真实执行（记忆化短路 /
//     白名单拦截 / 参数解析失败 / 剩余时间不足），不补样本——p95 只
//     看真实执行的耗时，样本数因此可能小于 calls。
//   · 分位数算法固定为线性插值（type 7，与 numpy 默认一致）：样本升序
//     排好后，位置 pos = q * (n - 1)，在相邻两点之间线性插值；q=0 取
//     最小值，q=1 取最大值。p95 的含义：95% 的调用快于该值。
//   · 老数据兼容：没有 samples 字段的旧槽位读出来是 undefined，
//     toolLatencyStats 一律返回 { p50: null, p95: null }，规则层回退
//     到只看超时率；merge 时遇到旧槽位先补一个空数组再追加。
const EVO_TOOL_LATENCY_SAMPLES = 50;

function toolLatencyQuantile(samples, q) {
  const arr = (Array.isArray(samples) ? samples : [])
    .map(v => Number(v)).filter(v => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (!arr.length) return null;
  const qq = Math.min(1, Math.max(0, Number(q) || 0));
  const pos = qq * (arr.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  // 样本是整毫秒，插值结果四舍五入回整毫秒（也消掉 900+0.55*100 这类
  // 二进制浮点尾巴，p95 才能稳定地写进提案证据里比大小）。
  if (lo === hi) return arr[lo];
  return Math.round(arr[lo] + (arr[hi] - arr[lo]) * (pos - lo));
}

// slot: byTool[name] 槽位（或直接传样本数组）。无样本时 p50/p95 均为 null。
function toolLatencyStats(slot) {
  const samples = Array.isArray(slot) ? slot : (slot && Array.isArray(slot.samples) ? slot.samples : []);
  return { p50: toolLatencyQuantile(samples, 0.5), p95: toolLatencyQuantile(samples, 0.95) };
}

// 往一个工具槽位追加耗时样本：聚合条目按 calls 展开成 calls 份轮内平均，
// 追加后只留最近 EVO_TOOL_LATENCY_SAMPLES 条。单条聚合的 calls 再大也
// 最多推 N 份（再多也会被截掉，纯属浪费）。
//   · v7.36.0 起这只是旧事件的回退口径：没有 samples 字段的事件
//     （v7.36.0 之前的 loop.js 上报、或手工构造的事件）才走这里；
//     新事件带逐次实测 samples，走 pushToolLatencySampleValues。
function pushToolLatencySamples(slot, ms, calls) {
  if (!slot || typeof slot !== 'object') return;
  if (!Array.isArray(slot.samples)) slot.samples = [];
  const n = Math.max(1, Math.floor(Number(calls) || 1));
  const perCall = Math.max(0, Math.round((Math.max(0, Number(ms) || 0)) / n));
  const copies = Math.min(n, EVO_TOOL_LATENCY_SAMPLES);
  for (let i = 0; i < copies; i++) slot.samples.push(perCall);
  if (slot.samples.length > EVO_TOOL_LATENCY_SAMPLES) {
    slot.samples = slot.samples.slice(-EVO_TOOL_LATENCY_SAMPLES);
  }
}

// v7.36.0 逐次实测样本：把 loop.js 每次真实执行后上报的单次耗时
// （毫秒整数数组）原样追加进槽位，只留最近 EVO_TOOL_LATENCY_SAMPLES
// 条。只认合法值（有限、≥0 的数字，四舍五入回整毫秒），非法值直接
// 丢掉不报错；空数组表示本轮该工具没有真实执行，不补样本。
function pushToolLatencySampleValues(slot, samples) {
  if (!slot || typeof slot !== 'object') return;
  if (!Array.isArray(slot.samples)) slot.samples = [];
  if (!Array.isArray(samples) || !samples.length) return;
  for (const v of samples) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) continue;
    slot.samples.push(Math.round(n));
  }
  if (slot.samples.length > EVO_TOOL_LATENCY_SAMPLES) {
    slot.samples = slot.samples.slice(-EVO_TOOL_LATENCY_SAMPLES);
  }
}

// 合并两个样本数组（多天窗口 / flush 合并共用）：拼接后只留最近 N 条，
// 仍有界；任一侧缺字段都按空数组处理，老数据不报错。
function mergeToolLatencySamples(target, source) {
  const a = Array.isArray(target) ? target : [];
  const b = Array.isArray(source) ? source : [];
  const merged = a.concat(b);
  return merged.length > EVO_TOOL_LATENCY_SAMPLES
    ? merged.slice(-EVO_TOOL_LATENCY_SAMPLES) : merged;
}

// 从提问里抽候选词：中文按 2~6 字连续汉字、英文按词边界。
// 只用于「路由差一点就命中」时的提案候选，管理员审批时能看到原词。
function extractCandidateTokens(text, max) {
  const t = String(text || '');
  const limit = max > 0 ? max : 5;
  const out = [];
  const seen = new Set();
  const re = /[\u4e00-\u9fa5]{2,6}|[A-Za-z][A-Za-z0-9_+#.-]{1,11}/g;
  let m;
  while ((m = re.exec(t)) && out.length < limit) {
    let w = m[0];
    if (/^[A-Za-z]/.test(w)) w = w.toLowerCase();
    if (w.length < 2 || w.length > 12) continue;
    if (/^\d+$/.test(w)) continue;
    if (EVO_STOPWORDS.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

function isCorrectionText(text) {
  return CORRECTION_RE.test(String(text || ''));
}

function isRepeatText(text) {
  return REPEAT_RE.test(String(text || '').trim());
}

// event: { date, channel, personaId, routeSource, routeReason, outcome,
//   steps, tools, fails, ms, truncated, toolCalls:[{name,fails,ms,
//   samples:[单次实测 ms, …]（v7.36.0，缺字段时回退轮内平均展开）}],
//   query, nearMissPersonaId, nearMissTokens:[], correction, repeat }
function mergeEvolveDay(day, event) {
  const d = day && typeof day === 'object' ? day : newEvolveDay(event && event.date);
  if (!d.byChannel) d.byChannel = {};
  if (!d.byPersona) d.byPersona = {};
  if (!d.byTool) d.byTool = {};
  if (!d.byPersonaTool) d.byPersonaTool = {};
  if (!d.route) d.route = {};
  if (!d.signals) d.signals = { correction: 0, repeat: 0, continue: 0 };
  if (!d.outcomesByPersona) d.outcomesByPersona = {};
  if (!d.nearMiss) d.nearMiss = {};
  const e = event || {};
  d.total += 1;
  const outcome = e.outcome || 'ok';
  if (outcome === 'paused') d.paused += 1;
  else if (outcome === 'error') d.error += 1;
  else if (outcome === 'fallback') d.fallback += 1;
  else d.ok += 1;
  if (e.truncated) d.truncated += 1;
  const channel = e.channel || 'unknown';
  d.byChannel[channel] = (d.byChannel[channel] || 0) + 1;
  // 灰度对照组：evolve 组走了 overlay，control 组走原配置；两组分开计数，
  // 周期报告才能回答「overlay 到底有没有让结果变好」而不是只看总量。
  const group = e.group === 'control' ? 'control' : 'evolve';
  if (!d.byGroup) d.byGroup = { evolve: { total: 0, paused: 0, error: 0 }, control: { total: 0, paused: 0, error: 0 } };
  const gs = d.byGroup[group] || (d.byGroup[group] = { total: 0, paused: 0, error: 0 });
  gs.total += 1;
  if (outcome === 'paused') gs.paused += 1;
  if (outcome === 'error') gs.error += 1;
  // v7.41.0 按提案灰度计数：事件里 proposalRollout = { in: [灰度内提案 id],
  //   out: [灰度外提案 id] }（loop.js 每轮算好，只含灰度中的提案）。
  // 生效组 vs 未生效组的暂停率才能回答「这条提案到底有没有让事情变好」。
  // 老事件没有该字段时按无灰度提案处理，不报错。
  if (e.proposalRollout && typeof e.proposalRollout === 'object') {
    if (!d.byProposal) d.byProposal = {};
    for (const side of ['in', 'out']) {
      const ids = e.proposalRollout[side];
      if (!Array.isArray(ids)) continue;
      for (const rawId of ids) {
        const id = String(rawId || '').slice(0, 80);
        if (!id) continue;
        const slot = d.byProposal[id] || (d.byProposal[id] = {
          in: { total: 0, paused: 0, error: 0 },
          out: { total: 0, paused: 0, error: 0 },
        });
        const s = slot[side] || (slot[side] = { total: 0, paused: 0, error: 0 });
        s.total += 1;
        if (outcome === 'paused') s.paused += 1;
        if (outcome === 'error') s.error += 1;
      }
    }
    pruneProposalCounts(d.byProposal, 20);
  }
  const persona = e.personaId || 'general';
  d.byPersona[persona] = (d.byPersona[persona] || 0) + 1;
  const routeKey = e.routeReason || e.routeSource || 'matched';
  if (Object.prototype.hasOwnProperty.call(d.route, routeKey)) d.route[routeKey] += 1;
  else d.route[routeKey] = 1;
  const obp = d.outcomesByPersona[persona] || (d.outcomesByPersona[persona] = { total: 0, paused: 0, truncated: 0, error: 0 });
  obp.total += 1;
  if (outcome === 'paused') obp.paused += 1;
  if (outcome === 'error') obp.error += 1;
  if (e.truncated) obp.truncated += 1;
  if (e.correction) d.signals.correction += 1;
  if (e.repeat) d.signals.repeat += 1;
  if (e.continue) d.signals.continue += 1;
  for (const tc of Array.isArray(e.toolCalls) ? e.toolCalls : []) {
    const name = String((tc && tc.name) || 'unknown');
    const slot = d.byTool[name] || (d.byTool[name] = { calls: 0, fails: 0, ms: 0, timeouts: 0 });
    slot.calls += Math.max(1, tc.calls || 1);
    slot.fails += tc.fails || 0;
    slot.ms += Math.max(0, tc.ms || 0);
    slot.timeouts += tc.timeouts || 0;
    // v7.36.0：逐次实测样本优先——loop.js 每次真实执行后把单次 ms
    // 记进 tc.samples，原样追加；没有 samples 的事件（旧代码上报、
    // 或手工构造的事件）回退到 v7.27.0 的轮内平均展开；samples 为
    // 空数组表示本轮该工具没有真实执行（记忆化短路等），不补样本。
    // 聚合字段（calls/fails/ms 总和）照旧累加，不动。
    if (Array.isArray(tc.samples)) pushToolLatencySampleValues(slot, tc.samples);
    else pushToolLatencySamples(slot, tc.ms || 0, tc.calls || 1);
    // v7.33.0：同一轮的工具调用/失败按当轮人格再记一份交叉计数
    // （R12 的口径）。loop.js 上报的 event 里 personaId 与 toolCalls
    // 本来就是一起来的，这里只多记两个数字，不改上报结构、不记原文。
    const pt = d.byPersonaTool[persona] || (d.byPersonaTool[persona] = {});
    const cslot = pt[name] || (pt[name] = { calls: 0, fails: 0 });
    cslot.calls += Math.max(1, tc.calls || 1);
    cslot.fails += tc.fails || 0;
  }
  // KB 缺失主题：read_doc 没读到东西时记下用户要找的主题（只记主题词，
  // 不记提问原文），攒够 3 次就是一条「知识库缺这篇」的证据。
  if (Array.isArray(e.kbMissTopics)) {
    if (!d.kbMissTopics) d.kbMissTopics = {};
    for (const t of e.kbMissTopics) {
      const topic = String(t || '').trim().slice(0, 30);
      if (topic.length < 2) continue;
      d.kbMissTopics[topic] = (d.kbMissTopics[topic] || 0) + 1;
    }
    pruneCounts(d.kbMissTopics, 100);
  }
  // 近 miss：路由差一点（low/ambiguous）时，记录「差点命中的人格 + 候选词」
  if (e.nearMissPersonaId && Array.isArray(e.nearMissTokens)) {
    for (const token of e.nearMissTokens) {
      const key = e.nearMissPersonaId + ':' + token;
      d.nearMiss[key] = (d.nearMiss[key] || 0) + 1;
    }
  }
  pruneCounts(d.nearMiss, 100);
  return d;
}

// 灰度分组：按 chatId 做稳定哈希，同一会话永远在同一组，
// 不会因为 isolate 不同而今天走 overlay、明天走对照组。
function djb2Hash(text) {
  let h = 5381;
  const t = String(text || '');
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0;
  return h;
}

function evolveCohort(chatId, percent) {
  const p = Number(percent);
  if (!(p > 0)) return 'control';
  if (p >= 100) return 'evolve';
  return (djb2Hash(chatId) % 100) < p ? 'evolve' : 'control';
}

// v7.41.0 按提案灰度：同一提案在部分会话生效、其余会话走原配置。
// 与 evolveCohort 同一个 djb2 哈希，但把提案 id 拌进哈希输入——
// 同一会话对同一提案永远同一组（不随时间跳变），不同提案的分组彼此
// 独立（不会所有提案都在同一批会话上生效）。返回 'in'（生效组）
// 或 'out'（未生效组）；percent 缺失/非法按 100（全量）处理。
// 注意：不能直接对 djb2 结果取模——djb2 末尾差 1 个字符时哈希值只差 1，
// 'evo-x' 与 'evo-y' 的分组会几乎完全相同；这里用 murmur3 风格的
// finalizer 把低位打散后再取模，两条提案的分组才真正独立。
// evolveCohort 不动（改了它会打乱已有的全局灰度分组）。
function evolveProposalCohort(chatId, proposalId, percent) {
  const p = Number(percent);
  if (!Number.isFinite(p)) return 'in';
  if (p <= 0) return 'out';
  if (p >= 100) return 'in';
  let h = djb2Hash(String(chatId || '') + '\n' + String(proposalId || ''));
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return ((h >>> 0) % 100) < p ? 'in' : 'out';
}

function createEvolveBuffer() {
  return { days: new Map(), events: 0, lastFlushAt: 0 };
}

function recordEvolveEvent(buffer, event) {
  const buf = buffer || createEvolveBuffer();
  const date = (event && event.date) || evolveDayKey(new Date());
  let day = buf.days.get(date);
  if (!day) {
    day = newEvolveDay(date);
    buf.days.set(date, day);
  }
  mergeEvolveDay(day, event);
  buf.events += 1;
  return buf;
}

// 两份日聚合按计数相加（不逐轮重放，所以不会把 total 翻倍）。
// flush 时「本地快照 + 远端」与「失败放回 buffer」两处共用。
function addEvolveDayCounts(target, source) {
  const t = target || newEvolveDay((source && source.date) || undefined);
  const s = source || {};
  t.total = (t.total || 0) + (s.total || 0);
  t.ok = (t.ok || 0) + (s.ok || 0);
  t.paused = (t.paused || 0) + (s.paused || 0);
  t.error = (t.error || 0) + (s.error || 0);
  t.fallback = (t.fallback || 0) + (s.fallback || 0);
  t.truncated = (t.truncated || 0) + (s.truncated || 0);
  t.byChannel = { ...(t.byChannel || {}) };
  for (const [k, v] of Object.entries(s.byChannel || {})) t.byChannel[k] = (t.byChannel[k] || 0) + v;
  t.byGroup = { ...(t.byGroup || {}) };
  for (const [k, v] of Object.entries(s.byGroup || {})) {
    const slot = t.byGroup[k] || (t.byGroup[k] = { total: 0, paused: 0, error: 0 });
    slot.total += v.total || 0;
    slot.paused += v.paused || 0;
    slot.error += v.error || 0;
  }
  // v7.41.0：按提案灰度计数随日聚合一起按数相加；任一侧缺字段按空对象处理。
  t.byProposal = { ...(t.byProposal || {}) };
  for (const [k, v] of Object.entries(s.byProposal || {})) {
    if (!v || typeof v !== 'object') continue;
    const slot = t.byProposal[k] || (t.byProposal[k] = {
      in: { total: 0, paused: 0, error: 0 },
      out: { total: 0, paused: 0, error: 0 },
    });
    for (const side of ['in', 'out']) {
      const sv = v[side] || {};
      const tv = slot[side] || (slot[side] = { total: 0, paused: 0, error: 0 });
      tv.total += sv.total || 0;
      tv.paused += sv.paused || 0;
      tv.error += sv.error || 0;
    }
  }
  pruneProposalCounts(t.byProposal, 20);
  t.byPersona = { ...(t.byPersona || {}) };
  for (const [k, v] of Object.entries(s.byPersona || {})) t.byPersona[k] = (t.byPersona[k] || 0) + v;
  t.route = { ...(t.route || {}) };
  for (const [k, v] of Object.entries(s.route || {})) t.route[k] = (t.route[k] || 0) + v;
  t.signals = { ...(t.signals || {}) };
  for (const [k, v] of Object.entries(s.signals || {})) t.signals[k] = (t.signals[k] || 0) + v;
  t.byTool = { ...(t.byTool || {}) };
  for (const [k, v] of Object.entries(s.byTool || {})) {
    const slot = t.byTool[k] || (t.byTool[k] = { calls: 0, fails: 0, ms: 0, timeouts: 0 });
    slot.calls += v.calls || 0;
    slot.fails += v.fails || 0;
    slot.ms += v.ms || 0;
    slot.timeouts += v.timeouts || 0;
    slot.samples = mergeToolLatencySamples(slot.samples, v.samples);
  }
  // v7.33.0：交叉计数同样按数相加；任一侧缺字段都按空对象处理。
  t.byPersonaTool = { ...(t.byPersonaTool || {}) };
  for (const [pid, tools] of Object.entries(s.byPersonaTool || {})) {
    if (!tools || typeof tools !== 'object') continue;
    const pt = t.byPersonaTool[pid] || (t.byPersonaTool[pid] = {});
    for (const [name, v] of Object.entries(tools)) {
      if (!v || typeof v !== 'object') continue;
      const slot = pt[name] || (pt[name] = { calls: 0, fails: 0 });
      slot.calls += v.calls || 0;
      slot.fails += v.fails || 0;
    }
  }
  t.outcomesByPersona = { ...(t.outcomesByPersona || {}) };
  for (const [k, v] of Object.entries(s.outcomesByPersona || {})) {
    const slot = t.outcomesByPersona[k] || (t.outcomesByPersona[k] = { total: 0, paused: 0, truncated: 0, error: 0 });
    slot.total += v.total || 0;
    slot.paused += v.paused || 0;
    slot.truncated += v.truncated || 0;
    slot.error += v.error || 0;
  }
  t.nearMiss = { ...(t.nearMiss || {}) };
  for (const [k, v] of Object.entries(s.nearMiss || {})) t.nearMiss[k] = (t.nearMiss[k] || 0) + v;
  t.kbMissTopics = { ...(t.kbMissTopics || {}) };
  for (const [k, v] of Object.entries(s.kbMissTopics || {})) t.kbMissTopics[k] = (t.kbMissTopics[k] || 0) + v;
  return t;
}

// v7.33.0 人格+工具失败趋势：把窗口按日期对半分，前半与后半各算一次
//   每组合的失败次数。口径固定为「按日期排序后，前 floor(n/2) 天 vs
//   后 ceil(n/2) 天」——近 7 天就是前 3 天 vs 后 4 天；只有 1 天时前半
//   为 0 天，规则层据此写「无法分段对比」而不是硬编一个趋势。
// 返回 { firstDays, secondDays, fails: { '人格:工具': { first, second } } }。
// 只含失败次数（R12 趋势只要失败对比），不含调用次数；老数据没有
// byPersonaTool 时 fails 为空对象，不报错。
function personaToolTrend(days) {
  const list = (Array.isArray(days) ? days : [])
    .filter(d => d && typeof d === 'object')
    .slice()
    .sort((a, b) => {
      const da = String(a.date || ''), db = String(b.date || '');
      return da < db ? -1 : da > db ? 1 : 0;
    });
  const split = Math.floor(list.length / 2);
  const first = list.slice(0, split);
  const second = list.slice(split);
  const fails = {};
  const add = (arr, key) => {
    for (const d of arr) {
      for (const [pid, tools] of Object.entries(d.byPersonaTool || {})) {
        if (!tools || typeof tools !== 'object') continue;
        for (const [tool, slot] of Object.entries(tools)) {
          if (!slot || typeof slot !== 'object') continue;
          const k = pid + ':' + tool;
          const e = fails[k] || (fails[k] = { first: 0, second: 0 });
          e[key] += slot.fails || 0;
        }
      }
    }
  };
  add(first, 'first');
  add(second, 'second');
  return { firstDays: first.length, secondDays: second.length, fails };
}

// v7.42.0 影响分校准的趋势数据：把窗口按日期对半分（前 floor(n/2) 天
//   vs 后 ceil(n/2) 天，与 v7.33.0 的 personaToolTrend 同口径；近 7 天
//   就是前 3 天 vs 后 4 天），按证据键分别加总前后两段的证据量。
//   只用日聚合里已有的数据（近 miss、暂停/截断、工具失败/超时、
//   KB 缺失主题、纠正信号、总暂停），不新增 R2 读、不新增字段采集。
// 返回 { firstDays, secondDays,
//   nearMiss: { '人格:词': { first, second } },
//   pausedByPersona / truncatedByPersona: { 人格: { first, second } },
//   toolFails / toolTimeouts: { 工具: { first, second } },
//   kbMiss: { 主题: { first, second } },
//   correction / paused: { first, second } }。
// 老数据缺字段时按空对象/0 处理；乱序传入也按日期排。
// 窗口 <2 天时 firstDays 为 0（前段没有天），规则层据此不做趋势加权
// （因子取 1），不硬编趋势——与 R12「单天窗口写无法分段对比」同口径。
function evidenceTrend(days) {
  const list = (Array.isArray(days) ? days : [])
    .filter(d => d && typeof d === 'object')
    .slice()
    .sort((a, b) => {
      const da = String(a.date || ''), db = String(b.date || '');
      return da < db ? -1 : da > db ? 1 : 0;
    });
  const split = Math.floor(list.length / 2);
  const out = {
    firstDays: split,
    secondDays: list.length - split,
    nearMiss: {},
    pausedByPersona: {},
    truncatedByPersona: {},
    toolFails: {},
    toolTimeouts: {},
    kbMiss: {},
    correction: { first: 0, second: 0 },
    paused: { first: 0, second: 0 },
  };
  const add = (map, key, seg, n) => {
    const e = map[key] || (map[key] = { first: 0, second: 0 });
    e[seg] += Math.max(0, Number(n) || 0);
  };
  list.forEach((d, i) => {
    const seg = i < split ? 'first' : 'second';
    for (const [k, v] of Object.entries(d.nearMiss || {})) add(out.nearMiss, k, seg, v);
    for (const [pid, obp] of Object.entries(d.outcomesByPersona || {})) {
      if (!obp || typeof obp !== 'object') continue;
      add(out.pausedByPersona, pid, seg, obp.paused);
      add(out.truncatedByPersona, pid, seg, obp.truncated);
    }
    for (const [name, slot] of Object.entries(d.byTool || {})) {
      if (!slot || typeof slot !== 'object') continue;
      add(out.toolFails, name, seg, slot.fails);
      add(out.toolTimeouts, name, seg, slot.timeouts);
    }
    for (const [topic, c] of Object.entries(d.kbMissTopics || {})) add(out.kbMiss, topic, seg, c);
    out.correction[seg] += Math.max(0, Number((d.signals || {}).correction) || 0);
    out.paused[seg] += Math.max(0, Number(d.paused) || 0);
  });
  return out;
}

// 把多天日聚合加总成一个窗口（默认近 7 天），供规则层使用。
function summarizeEvolveDays(days) {
  const out = newEvolveDay('window');
  out.date = 'window';
  for (const day of Array.isArray(days) ? days : []) {
    if (!day || typeof day !== 'object') continue;
    out.total += day.total || 0;
    out.ok += day.ok || 0;
    out.paused += day.paused || 0;
    out.error += day.error || 0;
    out.fallback += day.fallback || 0;
    out.truncated += day.truncated || 0;
    for (const [k, v] of Object.entries(day.byChannel || {})) out.byChannel[k] = (out.byChannel[k] || 0) + v;
    for (const [k, v] of Object.entries(day.byGroup || {})) {
      const slot = out.byGroup[k] || (out.byGroup[k] = { total: 0, paused: 0, error: 0 });
      slot.total += v.total || 0;
      slot.paused += v.paused || 0;
      slot.error += v.error || 0;
    }
    // v7.41.0：按提案灰度计数随窗口一起加总（老数据缺字段按空对象处理）。
    for (const [k, v] of Object.entries(day.byProposal || {})) {
      if (!v || typeof v !== 'object') continue;
      const slot = out.byProposal[k] || (out.byProposal[k] = {
        in: { total: 0, paused: 0, error: 0 },
        out: { total: 0, paused: 0, error: 0 },
      });
      for (const side of ['in', 'out']) {
        const sv = v[side] || {};
        const tv = slot[side] || (slot[side] = { total: 0, paused: 0, error: 0 });
        tv.total += sv.total || 0;
        tv.paused += sv.paused || 0;
        tv.error += sv.error || 0;
      }
    }
    for (const [k, v] of Object.entries(day.byPersona || {})) out.byPersona[k] = (out.byPersona[k] || 0) + v;
    for (const [k, v] of Object.entries(day.route || {})) out.route[k] = (out.route[k] || 0) + v;
    for (const [k, v] of Object.entries(day.signals || {})) out.signals[k] = (out.signals[k] || 0) + v;
    for (const [k, v] of Object.entries(day.byTool || {})) {
      const slot = out.byTool[k] || (out.byTool[k] = { calls: 0, fails: 0, ms: 0, timeouts: 0 });
      slot.calls += v.calls || 0;
      slot.fails += v.fails || 0;
      slot.ms += v.ms || 0;
      slot.timeouts += v.timeouts || 0;
      slot.samples = mergeToolLatencySamples(slot.samples, v.samples);
    }
    // v7.33.0：交叉计数随窗口一起加总（老数据缺字段按空对象处理）。
    for (const [pid, tools] of Object.entries(day.byPersonaTool || {})) {
      if (!tools || typeof tools !== 'object') continue;
      const pt = out.byPersonaTool[pid] || (out.byPersonaTool[pid] = {});
      for (const [name, v] of Object.entries(tools)) {
        if (!v || typeof v !== 'object') continue;
        const slot = pt[name] || (pt[name] = { calls: 0, fails: 0 });
        slot.calls += v.calls || 0;
        slot.fails += v.fails || 0;
      }
    }
    for (const [k, v] of Object.entries(day.outcomesByPersona || {})) {
      const slot = out.outcomesByPersona[k] || (out.outcomesByPersona[k] = { total: 0, paused: 0, truncated: 0, error: 0 });
      slot.total += v.total || 0;
      slot.paused += v.paused || 0;
      slot.truncated += v.truncated || 0;
      slot.error += v.error || 0;
    }
    for (const [k, v] of Object.entries(day.nearMiss || {})) out.nearMiss[k] = (out.nearMiss[k] || 0) + v;
    for (const [k, v] of Object.entries(day.kbMissTopics || {})) out.kbMissTopics[k] = (out.kbMissTopics[k] || 0) + v;
  }
  // v7.33.0：窗口趋势随汇总一起算出（按日期对半分，见 personaToolTrend），
  // 规则层直接读，不用再传一份天列表。
  out.personaToolTrend = personaToolTrend(days);
  // v7.42.0：影响分校准用的证据趋势（同口径分段，见 evidenceTrend），
  // 规则层按证据键取前段/后段计数算趋势因子。
  out.evidenceTrend = evidenceTrend(days);
  pruneCounts(out.nearMiss, 100);
  pruneCounts(out.kbMissTopics, 100);
  pruneProposalCounts(out.byProposal, 20);
  return out;
}

export {
  EVO_STOPWORDS,
  EVO_TOOL_LATENCY_SAMPLES,
  toolLatencyQuantile,
  toolLatencyStats,
  pushToolLatencySamples,
  pushToolLatencySampleValues,
  mergeToolLatencySamples,
  evolveDayKey,
  newEvolveDay,
  extractCandidateTokens,
  isCorrectionText,
  isRepeatText,
  mergeEvolveDay,
  addEvolveDayCounts,
  evolveCohort,
  evolveProposalCohort,
  createEvolveBuffer,
  recordEvolveEvent,
  summarizeEvolveDays,
  personaToolTrend,
  evidenceTrend,
};
