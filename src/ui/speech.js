// 朗读文本清洗：全项目唯一实现。
//
// 历史包袱：这段逻辑原本直接写在 src/ui/app-tts.js 的模板字符串分片里，
// 而分片存在「两层转义」—— 模板字符串先吃一层反斜杠，浏览器解析 JS 时再吃一层，
// 于是源码里一个反斜杠都不敢写，只能用 String.fromCharCode(92) + '@' 占位拼正则。
// 同一段逻辑又被复制进了 tts-demo.html，两份实现从此各自漂移。
//
// 现在的做法：把函数写在普通 .js 模块里（可以正常写正则字面量），
// 再用 Function.prototype.toString() 导出源码文本，供两处消费：
//   1) src/ui/app-tts.js  —— `${CLEAN_FOR_SPEECH_SRC}` 插进页面内联脚本
//   2) tts-demo.html      —— 由 scripts/build-tts-demo.mjs 生成
// 注入是「值插入」而不是「文本重新解析」，所以源码里的反斜杠、反引号都能原样落地。
// test/ui.test.mjs 会断言 tts-demo.html 与当前源码一致，防止再次分叉。

// 把 Markdown / 代码块清理成适合朗读的纯文本。
// 规则顺序有意义：先摘掉代码块与行内代码（否则里面的 ** 会被当成加粗），
// 再处理图片/链接（否则链接地址会被念出来），最后才是强调、列表、空行。
function cleanForSpeech(text) {
  if (!text) return '';

  const rules = [
    // 代码块整体省略 —— 朗读代码没有意义，念出来全是符号
    [/```[\s\S]*?```/g, ' （代码块已省略） '],
    // 行内代码保留文字本身
    [/`([^`]*)`/g, '$1'],
    // 图片只留「（图片）」，链接只念标题，地址不念
    [/!\[[^\]]*\]\(([^)]*)\)/g, ' （图片） '],
    [/\[([^\]]*)\]\(([^)]*)\)/g, '$1'],
    // 标题、引用、列表、有序列表的标记符号
    [/^\s{0,3}#{1,6}\s*/gm, ''],
    [/^\s{0,3}>\s?/gm, ''],
    [/(\*\*|__)(.*?)\1/g, '$2'],
    [/(\*|_)(.*?)\1/g, '$2'],
    [/^\s*[-*+]\s+/gm, ''],
    [/^\s*\d+\.\s+/gm, ''],
    // 表格竖线念不出来，换成空格
    [/\|/g, ' '],
    [/^[-=]{3,}$/gm, ' '],
    [/^[\s:-]*[-:][\s:-]*$/gm, ''],
    [/[ \t]{2,}/g, ' '],
    [/\n{3,}/g, '\n\n'],
  ];

  let out = String(text);
  for (let i = 0; i < rules.length; i++) {
    try {
      out = out.replace(rules[i][0], rules[i][1]);
    } catch (e) { /* 单条规则异常不影响其余 */ }
  }
  return out.trim();
}

// 是否包含中日韩字符（用于选择朗读语言 zh-CN / en-US）
function containsCJK(text) {
  return /[\u4e00-\u9fff]/.test(String(text == null ? '' : text));
}

// 注入到页面脚本里的源码文本。toString() 返回的就是文件里的原文，
// 所以这里改规则 → 页面与演示页同时生效。
const CLEAN_FOR_SPEECH_SRC = cleanForSpeech.toString();
const CONTAINS_CJK_SRC = containsCJK.toString();

export { cleanForSpeech, containsCJK, CLEAN_FOR_SPEECH_SRC, CONTAINS_CJK_SRC };
