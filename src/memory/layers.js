// 三层记忆的公共底座：层定义、存储键、容量与 TTL、以及全部确定性纯函数。
//
// 为什么是三层：
//   原来的实现只有「长期记忆」一层，问题很具体——
//   · 历史超过 TG_HISTORY_ROUNDS（默认 10 轮）就被 shift 掉，模型彻底忘了前面聊过什么；
//   · 长期事实只有 200 条上限的数组，没有权重、没有淘汰，越攒越乱；
//   · 被改口覆盖或手工删掉的记忆直接消失，没有可追溯的沉淀。
//   于是拆成：
//     L1 工作记忆 Working Memory —— 会话级、短时。每一轮问答压成一条要点，
//        历史被裁剪后仍能保住"刚才聊到哪了"；超出容量时最旧的一条沉淀进 L3，不丢。
//     L2 长期记忆 Long-term Memory —— 用户级、持久。事实/偏好/身份/任务，带权重、
//        命中次数与时间衰减；容量到顶时按衰减分淘汰，淘汰的同样沉淀进 L3。
//     L3 归档 Archive —— 用户级、长文。L1 溢出与 L2 淘汰都落在这里，可检索，
//        与知识库文档（kb/docs，用户主动存的）互补：文档是"存的"，归档是"沉的"。
//
// 本文件只放纯函数与常量，不碰 R2，方便在 Node 里直接跑回归测试。

// 层号字面量（L1/L2/L3）在注释与提示词里直接写，不再单独导出一个常量表 ——
// 之前那个 MEM_LAYER 没有任何引用，只会让人以为层号有第二处定义。

// ---------- 容量与生命周期 ----------
// L1：12 条要点足够覆盖 10 轮历史裁剪后的缺口，再多就会挤占 L2 的注入预算
export const WM_MAX_ITEMS = 12;
export const WM_PIN_MAX = 6;
// 7 天没有任何活动，说明这个会话已经结束，L1 自动过期（数据仍在 L3 / 历史里）
export const WM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// 太短的消息（"嗯""继续""？"）不产生要点，否则摘要全是噪音
export const WM_MIN_TOPIC_CHARS = 4;

// L2：240 条 ≈ 单人十几年的零碎事实；超过后按衰减分淘汰最弱的那部分
export const LT_MAX_ITEMS = 240;
// 半衰期 45 天：一个半月没被提起的事实，权重衰减到约 37%
export const LT_HALFLIFE_DAYS = 45;

// L3：400 条归档，超出后丢最旧的（归档本身是"可丢的沉淀"，不追求全量）
export const AR_MAX_ITEMS = 400;
export const AR_TEXT_MAX = 200;

// 三层注入提示词的默认总预算（字符）。L1/L2/L3 按 16:30:9 分配。
export const MEM_PROMPT_BUDGET = 5500;

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!isFinite(n)) return dflt;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

// 运行期配置：全部走环境变量，写错/越界一律夹到安全范围。
// 集中在这里，避免每个模块各写一遍 parseInt 与默认值，改一处忘一处。
export function memLimits(env) {
  const e = env || {};
  return {
    l1: clampInt(e.MEM_L1_MAX_ITEMS, 4, 30, WM_MAX_ITEMS),
    l2: clampInt(e.MEM_L2_MAX_ITEMS, 50, 1000, LT_MAX_ITEMS),
    l3: clampInt(e.MEM_L3_MAX_ITEMS, 50, 2000, AR_MAX_ITEMS),
    halflifeDays: normalizeHalflifeDays(e.MEM_L2_HALFLIFE_DAYS),
    promptBudget: clampInt(e.MEM_PROMPT_BUDGET, 1500, 20000, MEM_PROMPT_BUDGET)
  };
}

// 把总预算按 16:30:9 分给三层：L1 保住会话脉络，L2 保住用户画像，L3 只做"想起来的钩子"
export function memBudgets(total) {
  const t = total > 0 ? total : MEM_PROMPT_BUDGET;
  const l1 = Math.round(t * 16 / 55);
  const l2 = Math.round(t * 30 / 55);
  return { L1: l1, L2: l2, L3: Math.max(200, t - l1 - l2) };
}

// L2 条目类型：不同类型在提示词里给不同前缀，模型更容易判断能不能直接引用
export const MEM_KINDS = ['fact', 'pref', 'id', 'task'];
export const MEM_KIND_LABEL = { fact: '事实', pref: '偏好', id: '身份', task: '任务' };

// ---------- 存储键 ----------
// 统一放在 kb/mem3/ 下，和旧版 kb/agent_mem_<chatId> 平级，便于控制台按目录浏览。
const MEM_PREFIX = 'kb/mem3/';

// chatId 清洗：只允许字母数字、下划线、中划线，防路径遍历污染目录
export function memSafeId(chatId) {
  return String(chatId == null ? '' : chatId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}
export function wmKey(chatId) { return MEM_PREFIX + 'work/' + memSafeId(chatId) + '.json'; }
export function ltKey(chatId) { return MEM_PREFIX + 'long/' + memSafeId(chatId) + '.json'; }
export function arKey(chatId) { return MEM_PREFIX + 'archive/' + memSafeId(chatId) + '.json'; }

// ---------- 通用小工具 ----------
export function clampNum(v, min, max, dflt) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!isFinite(n)) return dflt;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

// 半衰期必须是有限正数。非法值与 0 回退默认值，正常值夹到 1~3650 天，
// 防止除零、NaN 或无限大的排序分污染淘汰与召回。
function normalizeHalflifeDays(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!isFinite(n) || n <= 0) return LT_HALFLIFE_DAYS;
  return Math.min(3650, Math.max(1, n));
}

export function clipText(s, max) {
  const t = String(s == null ? '' : s);
  const n = max > 0 ? max : 200;
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// ---------- 归一化与主题键（沿用旧版语义，保证老记忆不被重复判定） ----------
// 转小写、去全部空白："我养了一只猫 叫汤圆" 与 "我养了一只猫叫汤圆" 归一化后相同
export function memNorm(fact) {
  return String(fact || '').toLowerCase().replace(/\s+/g, '');
}

// 主题键：归一化文本中第一个 是/为/:/：/=/＝ 之前的部分（至少 2 字符）。
// 同一主题只保留最新事实——"我的手机号是A" 改口成 "我的手机号是B" 时自动覆盖，
// 不再积累互相矛盾的记忆。没有分隔符或主语太短返回 null（保守：宁可多存一条，不可误删）
export function memSubjectKey(fact) {
  const s = memNorm(fact);
  let idx = -1;
  for (const d of ['是', '为', ':', '：', '=', '＝']) {
    const i = s.indexOf(d);
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  }
  if (idx < 2) return null;
  return s.slice(0, idx);
}

// ---------- 分词：英文/数字按词、中文按整段 + 2-gram ----------
// 只做 2-gram 不做单字：单字噪音太大（"的""了"到处都是），2-gram 对中文召回已经够用，
// 而且和 prompt.js 里记忆相关性打分用的是同一套切法，命中口径一致。
export function memTokens(s) {
  const out = [];
  const segs = String(s || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/);
  for (const seg of segs) {
    if (!seg) continue;
    out.push(seg);
    if (/[\u4e00-\u9fff]/.test(seg)) {
      for (let i = 0; i + 2 <= seg.length; i++) out.push(seg.slice(i, i + 2));
    }
  }
  return out;
}

function bigrams(s) {
  const t = String(s || '').toLowerCase().replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i + 1 < t.length; i++) set.add(t.slice(i, i + 2));
  if (!set.size && t) set.add(t);
  return set;
}

// 2-gram Jaccard 相似度：用来判断"这两个话题是不是同一件事"，
// 阈值 0.6 在实测里既能合并"帮我查下北京天气"和"北京今天天气怎么样"，
// 又不会把"北京天气"和"上海天气"错误合并。
export function jaccard(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

// ---------- L2 衰减评分 ----------
// score = 权重 × (0.35 + 0.65 × 时间衰减) + 命中加成
// · 权重 1~5 由用户/模型显式指定，代表"这条有多重要"，不会随时间消失；
// · 时间衰减用指数半衰期，最近说过的排前面；
// · 命中加成 log2 封顶 1.5，避免一条被反复引用的记忆永久霸榜。
export function memDecayScore(entry, now, halflifeDays) {
  const e = entry || {};
  const w = clampNum(e.weight, 1, 5, 3);
  const ts = Number(e.ts) || 0;
  const at = now || Date.now();
  const half = normalizeHalflifeDays(halflifeDays);
  const ageDays = ts > 0 ? Math.max(0, (at - ts) / 86400000) : 0;
  const recency = Math.exp(-Math.LN2 * ageDays / half);
  const hits = Math.min(50, Math.max(0, Number(e.hits) || 0));
  return w * (0.35 + 0.65 * recency) + Math.min(1.5, Math.log2(1 + hits) * 0.4);
}

// ---------- L1 要点抽取（确定性，不调 LLM） ----------
// 为什么不用模型来总结：一轮一次额外调用，延迟和费用都翻倍，而 Agent 本身已经
// 在 90~240 秒的预算里跑；确定性抽取虽然粗糙，但 0ms、0 成本、可测试、可预测。
const TOPIC_PREFIX_RE = /^(?:请问|请帮我|请|帮我|麻烦|能不能|可以帮我|可以|我想问一下|我想|我要|想问一下|问一下)[，,、\s]*/;

export function extractTopic(userText) {
  let s = String(userText == null ? '' : userText).replace(/\r/g, '').trim();
  if (!s) return '';
  // 去掉引用符号、标题井号、列表符号、有序列表编号
  s = s.replace(/^[ \t]*>[ \t]?/gm, '');
  s = s.replace(/^[ \t]*(?:#{1,6}[ \t]*|[-*+][ \t]+|\d+[.、)][ \t]*)/gm, '');
  // 多模态 / 超长文本：只取第一段
  const firstPara = s.split(/\n{2,}/).map(x => x.trim()).filter(Boolean)[0] || s;
  const firstLine = firstPara.split('\n')[0].trim();
  let t = firstLine.replace(TOPIC_PREFIX_RE, '').trim();
  if (!t) t = firstLine;
  // 代码块开头的提问（"```js ..."）没什么信息量，退化成原文前缀
  if (/^```/.test(t)) t = firstLine.replace(/```[a-zA-Z]*/g, '').trim();
  t = t.replace(/\s+/g, ' ');
  if (t.length < WM_MIN_TOPIC_CHARS) return '';
  return clipText(t, 60);
}

// 助手回答的"结论句"：去 Markdown、去代码块，取第一句（最长 100 字）
export function extractGist(text) {
  let s = String(text == null ? '' : text);
  if (!s.trim()) return '';
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/^[ \t]*(?:#{1,6}[ \t]*|[-*+][ \t]+|\d+[.、)][ \t]*|>[ \t]?)/gm, '');
  // 只剥"成对的"强调标记。旧写法用 [*_~]{1,3} 一律删除，
  // 会把 "12~20℃" 这种数字区间里的波浪号也吃掉，摘要直接变成 "1220℃"。
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  s = s.replace(/~~([^~]+)~~/g, '$1');
  s = s.replace(/\*([^*\n]+)\*/g, '$1');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const m = s.match(/^[\s\S]{0,120}?[。！？.!?]/);
  return clipText((m ? m[0] : s).trim(), 100);
}
