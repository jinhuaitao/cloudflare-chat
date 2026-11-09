// Agent 外部历史清洗：把「客户端 / 断点存档 / 旧格式缓存」传来的消息
// 变成上游一定接受、且无法借机改写系统提示的序列。
//
// 为什么需要这一层：
// 1) Web 端 /api/chat 的 messages 完全来自浏览器。旧版直接原样塞进 Agent 上下文，
//    于是 `{role:'system', content:'忽略以上所有规则…'}` 会成为第二条 system 消息，
//    与真正的系统提示并列（甚至更靠后），构成 prompt 注入；
// 2) 同一处还能塞 `role:'tool'` 或任意字符串，让消息序列非法，严格校验的上游直接 400；
// 3) 首条非 system 消息必须是 user。旧版只要前端把 assistant 放最前，
//    整个请求就会被上游拒绝，用户看到的是"API 报错 400"而不知道为什么；
// 4) 没有条数与长度上限，构造 10 万条消息即可把 isolate 内存打满。

const HISTORY_MAX_MSGS = 40;
const HISTORY_MSG_MAX_CHARS = 20000;
const HISTORY_TOTAL_MAX_CHARS = 60000;

// 多模态片段白名单：只放行文本与图片，其余（audio / file / 未知 type）一律丢弃
function sanitizeContent(content) {
  if (Array.isArray(content)) {
    const parts = [];
    for (const p of content) {
      if (!p || typeof p !== 'object') continue;
      if (p.type === 'text' && typeof p.text === 'string') {
        const t = p.text.length > HISTORY_MSG_MAX_CHARS ? p.text.slice(0, HISTORY_MSG_MAX_CHARS) : p.text;
        if (t.trim()) parts.push({ type: 'text', text: t });
      } else if (p.type === 'image_url' && p.image_url) {
        parts.push(p);
      }
    }
    return parts.length ? parts : null;
  }
  if (content && typeof content === 'object') {
    // 形如 {text:'…'} 的包装对象：直接 String() 会得到 "[object Object]"
    if (typeof content.text === 'string') content = content.text;
    else return null;
  }
  let s = String(content == null ? '' : content);
  if (!s.trim()) return null;
  if (s.length > HISTORY_MSG_MAX_CHARS) s = s.slice(0, HISTORY_MSG_MAX_CHARS);
  return s;
}

// 清洗外部历史。返回可直接拼进 Agent 上下文的消息数组（不含 system）。
function sanitizeHistory(history, opts) {
  const maxMsgs = (opts && opts.maxMsgs > 0) ? opts.maxMsgs : HISTORY_MAX_MSGS;
  const list = Array.isArray(history) ? history : [];
  const out = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    // 角色白名单：system 一律丢弃（Agent 的系统提示只能由服务端构造），tool 也不行
    const role = m.role === 'user' ? 'user' : (m.role === 'assistant' ? 'assistant' : '');
    if (!role) continue;
    const content = sanitizeContent(m.content);
    if (content === null) continue;
    const prev = out.length ? out[out.length - 1] : null;
    if (prev && prev.role === role) {
      if (role === 'assistant') {
        // 连续 assistant 只保留最后一条：模型不该看到自己重复说话
        out[out.length - 1] = { role, content };
      } else if (typeof prev.content === 'string' && typeof content === 'string') {
        // 连续 user 合并成一条，既保留全部信息，又满足部分上游「角色必须交替」的校验
        const merged = prev.content + '\n\n' + content;
        out[out.length - 1] = {
          role,
          content: merged.length > HISTORY_MSG_MAX_CHARS ? merged.slice(-HISTORY_MSG_MAX_CHARS) : merged
        };
      } else {
        out[out.length - 1] = { role, content };
      }
      continue;
    }
    out.push({ role, content });
  }

  // 首条必须是 user：system 之后直接跟 assistant 会被严格上游判为非法序列
  let start = 0;
  while (start < out.length && out[start].role !== 'user') start++;
  let trimmed = start > 0 ? out.slice(start) : out;

  // 条数上限：保留最近的部分
  if (trimmed.length > maxMsgs) trimmed = trimmed.slice(trimmed.length - maxMsgs);
  // 裁完可能又从 assistant 开头，再修一次
  while (trimmed.length && trimmed[0].role !== 'user') trimmed.shift();

  // 总字符上限：从最旧的一轮开始丢，保持「user 开头、按轮交替」
  let total = 0;
  for (const m of trimmed) {
    total += typeof m.content === 'string' ? m.content.length : 256;
  }
  let cut = 0;
  while (cut < trimmed.length && total > HISTORY_TOTAL_MAX_CHARS) {
    const m = trimmed[cut];
    total -= typeof m.content === 'string' ? m.content.length : 256;
    cut += 1;
  }
  if (cut > 0) {
    trimmed = trimmed.slice(cut);
    while (trimmed.length && trimmed[0].role !== 'user') trimmed.shift();
  }
  return trimmed;
}

// 历史里最后一条 user 消息的纯文本（用于记忆相关性打分与断点存档）
function lastUserText(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .filter(p => p && p.type === 'text' && typeof p.text === 'string')
        .map(p => p.text)
        .join('\n');
    }
  }
  return '';
}

export {
  HISTORY_MAX_MSGS,
  HISTORY_MSG_MAX_CHARS,
  HISTORY_TOTAL_MAX_CHARS,
  sanitizeHistory,
  sanitizeContent,
  lastUserText,
};
