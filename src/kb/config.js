// 知识库检索参数集中解析（全部可用环境变量覆盖，缺省即用生产默认值）

function kbInt(v, def, min, max) {
  let n = parseInt(v, 10);
  if (!(n > 0)) n = def;
  if (n < min) n = min;
  if (n > max) n = max;
  return n;
}

function kbConfig(env) {
  const e = env || {};
  const chunkSize = kbInt(e.KB_CHUNK_SIZE, 700, 300, 2000);
  let chunkOverlap = parseInt(e.KB_CHUNK_OVERLAP, 10);
  if (!(chunkOverlap >= 0)) chunkOverlap = 120;
  if (chunkOverlap >= chunkSize) chunkOverlap = Math.floor(chunkSize / 4);
  return {
    chunkSize,
    chunkOverlap,
    maxTerms: kbInt(e.KB_CHUNK_TERMS, 40, 12, 120),
    topK: kbInt(e.KB_TOP_K, 6, 1, 20),
    maxIndexDocs: kbInt(e.KB_MAX_INDEX_DOCS, 500, 10, 5000),
    // 预检索：回答前自动在知识库里定位相关原文并注入提示词，省掉一次工具往返
    preRetrieve: String(e.KB_PRE_RETRIEVE || '1') !== '0',
    preRetrieveChars: kbInt(e.KB_PRE_RETRIEVE_CHARS, 2600, 400, 12000),
    // 网页端知识库管理：写入必须持有管理员密钥（KB_ADMIN_SECRET 或 WX_ADMIN_SECRET）
    maxDocChars: kbInt(e.KB_MAX_DOC_CHARS, 200000, 5000, 900000),
  };
}

export { kbConfig, kbInt };
