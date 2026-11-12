// 微信 ClawBot 文本处理：长回复分段 + 中英双语口令解析。
//
// 从 src/wechat/handler.js 里抽出来的原因：这两段是纯函数（不碰网络、不碰 R2、不碰 env），
// 但此前混在 2200 行的通道处理器里，既不方便单测，也很难一眼看清"用户发的这句话会被当成什么"。
// 现在它们是独立模块，test/wechat.test.mjs 直接对拍；handler.js 原样 re-export，调用方无需改动。

// 微信单条文本消息有长度上限，超长回复必须切成多条依次发送。
// maxChunks 之外的内容不再发送，只在最后一段尾部注明已截断 ——
// 微信侧没有"重新生成"按钮，一次发 20 条比少发几条更糟。
function splitWechatText(text, maxLength = 3800, maxChunks = 5) {
  const chunks = [];
  let remaining = String(text || '').trim();
  while (remaining.length > 0) {
    if (remaining.length <= maxLength || chunks.length >= maxChunks - 1) {
      if (remaining.length > maxLength * 2) {
        chunks.push(remaining.slice(0, maxLength * 2) + '\n\n…（内容过长，已截断显示）');
      } else {
        chunks.push(remaining);
      }
      break;
    }
    let sliceLength = maxLength;
    // 只在换行位置足够靠后（超过 70%）时才按换行切 ——
    // 否则第一段会短得离谱（比如 maxLength=3800、换行在第 10 个字）
    const lastNewline = remaining.lastIndexOf('\n', maxLength);
    if (lastNewline > Math.floor(maxLength * 0.7)) {
      sliceLength = lastNewline;
    }
    const chunk = remaining.slice(0, sliceLength).trim();
    remaining = remaining.slice(sliceLength).trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks.length ? chunks : [''];
}

// 把用户输入解析成命令。返回 null 表示"不是命令"，交给 Agent 正常对话。
// 设计原则：宁可漏判也不误判 —— 中文口令全部用整串精确匹配，
// 带参形式才用前缀正则，避免「画」这种单字把普通对话吃掉。
function parseWxCommand(text) {
  const s = String(text || '').trim();
  if (!s) return null;

  const slash = /^(\/[a-zA-Z]+)(?:\s+([\s\S]*))?$/.exec(s);
  if (slash) {
    const rawCmd = slash[1].toLowerCase();
    const rest = (slash[2] || '').trim();
    if (rawCmd === '/menu') return { cmd: '/help', rest };
    if (rawCmd === '/img' || rawCmd === '/image' || rawCmd === '/paint') return { cmd: '/draw', rest };
    return { cmd: rawCmd, rest };
  }

  if (/^(菜单|帮助|指令|功能|命令|使用说明)$/.test(s)) {
    return { cmd: '/help', rest: '' };
  }
  if (/^(模型|模型列表|切换模型|换模型|查看模型)$/.test(s)) {
    return { cmd: '/model', rest: '' };
  }
  const modelMatch = /^(?:切换模型|换模型|模型)\s+(.+)$/.exec(s);
  if (modelMatch) {
    return { cmd: '/model', rest: modelMatch[1].trim() };
  }
  if (/^(模式|切换模式|智能体|智能体模式|普通模式)$/.test(s)) {
    return { cmd: '/agent', rest: '' };
  }
  // 专家人格（v7.13.0）：单独口令查看列表，带参口令切换角色。
  // 「专家」整串单独出现时给列表而不是切模式——用户说专家，想看的肯定是角色清单。
  if (/^(专家|专家列表|角色|角色列表|人格|人格列表)$/.test(s)) {
    return { cmd: '/agent', rest: 'list' };
  }
  const expertMatch = /^(?:切换专家|使用专家|换个专家|专家切换|切换角色)[:：\s]+(.+)$/.exec(s);
  if (expertMatch && expertMatch[1].trim()) {
    return { cmd: '/agent', rest: expertMatch[1].trim() };
  }
  if (/^(自动选择专家|专家自动选择|专家自动|自动选专家)$/.test(s)) {
    return { cmd: '/agent', rest: 'auto' };
  }
  if (/^(清空|清空上下文|新对话|重置|重置对话|清空记忆上下文)$/.test(s)) {
    return { cmd: '/clear', rest: '' };
  }
  if (/^(记忆|查看记忆|长期记忆)$/.test(s)) {
    return { cmd: '/memory', rest: '' };
  }
  const forgetMatch = /^(?:忘掉|删除记忆|清除记忆)\s+(.+)$/.exec(s);
  if (forgetMatch) {
    return { cmd: '/forget', rest: forgetMatch[1].trim() };
  }
  if (/^(知识库|查看知识库|文档列表)$/.test(s)) {
    return { cmd: '/kb', rest: '' };
  }
  if (/^(整理知识库|存入知识库|整理成知识库|保存到知识库|入库)$/.test(s)) {
    return { cmd: '/savekb', rest: '' };
  }
  const saveKbMatch = /^(?:整理知识库|存入知识库|整理成知识库|保存到知识库|保存知识库)[:：\s]+(.+)$/.exec(s);
  if (saveKbMatch) {
    return { cmd: '/savekb', rest: saveKbMatch[1].trim() };
  }
  const readKbMatch = /^(?:读取文档|查看文档|精读文档|打开文档)[:：\s]+(.+)$/.exec(s);
  if (readKbMatch) {
    return { cmd: '/readdoc', rest: readKbMatch[1].trim() };
  }
  const delKbMatch = /^(?:删除文档|删除知识库|删除知识库文档)[:：\s]+(.+)$/.exec(s);
  if (delKbMatch) {
    return { cmd: '/deldoc', rest: delKbMatch[1].trim() };
  }
  if (/^(状态|连接状态|运行状态|系统状态)$/.test(s)) {
    return { cmd: '/status', rest: '' };
  }
  const drawMatch = /^(?:画一张|画一幅|画个|画|生成图片|生图)[:：\s]+([\s\S]+)$/.exec(s);
  if (drawMatch && drawMatch[1].trim()) {
    return { cmd: '/draw', rest: drawMatch[1].trim() };
  }

  return null;
}

export { splitWechatText, parseWxCommand };
