// 知识库检索内核（一）：文本切分、轻量分词与块级词向量
// 纯确定性计算，不依赖任何外部 API / 模型，可在 Worker 冷启动下毫秒级完成。

// ==================== 停用词表 ====================
// 中英文高频虚词不参与相关性打分：既压低索引体积，也避免"的 / 是 / the"把无关片段顶到前面。
const KB_STOPWORDS = new Set([
  // 中文
  '的', '了', '和', '是', '在', '我', '有', '就', '不', '人', '都', '一', '上', '也', '很', '到',
  '说', '要', '去', '你', '会', '着', '看', '好', '这', '那', '与', '及', '或', '等', '被', '把',
  '让', '从', '对', '为', '以', '之', '其', '而', '但', '并', '且', '中', '内', '时', '后', '前',
  '可', '能', '一个', '我们', '你们', '他们', '这个', '那个', '这些', '那些', '什么', '怎么',
  '如何', '为什么', '是否', '可以', '以及', '如果', '因为', '所以', '但是', '然后', '还是',
  '已经', '进行', '通过', '根据', '由于', '对于', '关于', '一些', '一下', '自己', '没有',
  '需要', '应该', '表示', '目前', '现在', '一个', '没有', '还是', '这样', '那样', '知道',
  // 英文
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'this', 'that', 'these', 'those', 'it', 'its', 'as',
  'by', 'from', 'not', 'no', 'but', 'if', 'then', 'than', 'so', 'such', 'can', 'could',
  'should', 'would', 'will', 'may', 'might', 'must', 'have', 'has', 'had', 'do', 'does',
  'did', 'we', 'you', 'they', 'he', 'she', 'i', 'me', 'my', 'our', 'your', 'their', 'what',
  'how', 'why', 'when', 'which', 'who', 'there', 'here', 'about', 'into', 'over', 'more'
]);

const CJK_RE = /[\u4e00-\u9fff]/;

// 分块边界优先级：段落 > 句末 > 分号/换行 > 逗号/空格。
// 让切出来的块尽量是完整语义单元，模型读到的片段不会断在半句话上。
const KB_BREAK_MARKS = ['\n\n', '\n', '。', '！', '？', '；', '. ', '! ', '? ', '; ', '，', ', ', '、', ' '];

// ==================== 分词 ====================
// 中文按 2-gram 切分（"知识库" → 知识 / 识库），4 字以上连续中文额外保留整词（权重更高）；
// 英文与数字按词切分，长度 >= 2 才入索引。
function kbTokenize(input) {
  const s = String(input == null ? '' : input).toLowerCase();
  const out = [];
  if (!s) return out;
  const segs = s.split(/[^a-z0-9\u4e00-\u9fff]+/);
  for (const seg of segs) {
    if (!seg) continue;
    if (CJK_RE.test(seg)) {
      if (seg.length === 1) { out.push(seg); continue; }
      for (let i = 0; i + 1 < seg.length; i++) out.push(seg.slice(i, i + 2));
      if (seg.length >= 4) out.push(seg);
    } else if (seg.length >= 2) {
      out.push(seg);
    }
  }
  return out;
}

// 查询侧分词：去停用词 + 去重（保留首次出现顺序），用于打分与覆盖率计算。
function kbQueryTokens(query) {
  const seen = new Set();
  const out = [];
  for (const t of kbTokenize(query)) {
    if (KB_STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// ==================== 块级词向量 ====================
// 每块只保留权重最高的 maxTerms 个词（"词:词频" 紧凑编码），把索引体积压到
// 每 700 字约 200~400 字节，同时保留足够召回率。打分时再按 IDF 加权。
function kbTermVector(text, maxTerms) {
  const limit = maxTerms > 0 ? maxTerms : 40;
  const tf = new Map();
  for (const t of kbTokenize(text)) {
    if (KB_STOPWORDS.has(t)) continue;
    tf.set(t, (tf.get(t) || 0) + 1);
  }
  if (!tf.size) return '';
  const scored = [];
  for (const [term, count] of tf) {
    const lenWeight = term.length >= 2 ? Math.min(3, term.length) : 0.5;
    scored.push([term, count, lenWeight * (1 + Math.log(count))]);
  }
  scored.sort((a, b) => (b[2] - a[2]) || (a[0] < b[0] ? -1 : 1));
  const kept = scored.slice(0, limit);
  return kept.map(x => x[0] + ':' + x[1]).join(',');
}

function kbParseTermVector(w) {
  const out = [];
  const s = String(w || '');
  if (!s) return out;
  for (const seg of s.split(',')) {
    const i = seg.lastIndexOf(':');
    if (i <= 0) continue;
    const count = parseInt(seg.slice(i + 1), 10);
    out.push([seg.slice(0, i), count > 0 ? count : 1]);
  }
  return out;
}

// ==================== 分块 ====================
// 返回相对正文的 [{o, l}] 区间数组。块尾尽量落在段落/句末，下一块与上一块保留
// overlap 字符重叠，避免答案恰好被切断在两块之间。
function kbChunkRanges(text, size, overlap) {
  const s = String(text == null ? '' : text);
  let win = size > 0 ? size : 700;
  let ov = overlap >= 0 ? overlap : 120;
  if (ov >= win) ov = Math.floor(win / 4);
  const ranges = [];
  if (!s.length) return ranges;
  let pos = 0;
  let guard = 0;
  while (pos < s.length && guard++ < 5000) {
    let end = Math.min(s.length, pos + win);
    if (end < s.length) {
      const minEnd = pos + Math.floor(win * 0.55);
      let best = -1;
      for (const mark of KB_BREAK_MARKS) {
        const idx = s.lastIndexOf(mark, end);
        if (idx > minEnd) {
          const cut = idx + mark.length;
          if (cut > best) best = cut;
        }
      }
      if (best > 0 && best <= end) end = best;
    }
    if (end <= pos) end = Math.min(s.length, pos + win);
    ranges.push({ o: pos, l: end - pos });
    if (end >= s.length) break;
    let next = end - ov;
    if (next <= pos) next = end;
    pos = next;
  }
  return ranges;
}

// 剥离 frontmatter（save_doc 写入的 --- 头），返回正文与其在原文中的起始偏移。
// 索引偏移必须相对"整篇原文"，这样 read_doc 的 offset 与检索片段能直接对齐。
function kbSplitFrontmatter(text) {
  const s = String(text == null ? '' : text);
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(s);
  if (!m) return { head: '', body: s, offset: 0 };
  return { head: m[0], body: s.slice(m[0].length), offset: m[0].length };
}

// 把整篇文档切成索引块：[offset, length, 词向量]
function kbChunkDocument(text, chunkSize, chunkOverlap, maxTerms) {
  const parts = kbSplitFrontmatter(text);
  const ranges = kbChunkRanges(parts.body, chunkSize, chunkOverlap);
  const out = [];
  for (const r of ranges) {
    const slice = parts.body.slice(r.o, r.o + r.l);
    if (!slice.trim()) continue;
    out.push([r.o + parts.offset, r.l, kbTermVector(slice, maxTerms)]);
  }
  return out;
}

export {
  KB_STOPWORDS,
  CJK_RE,
  kbTokenize,
  kbQueryTokens,
  kbTermVector,
  kbParseTermVector,
  kbChunkRanges,
  kbSplitFrontmatter,
  kbChunkDocument,
};
