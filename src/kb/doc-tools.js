// Agent 工具：知识库文档的保存 / 列表 / 读取 / 删除（_worker.js 原第 905-1034 行）

import { storePutChecked } from '../store/r2.js';
import { kbSafeChatId } from '../store/kb.js';
import { KB_DOCS_PREFIX, kbDocSlug, kbNormSource, kbDocTitleOf, kbGetRegistry,
  kbSaveRegistry, kbFindRegEntry, kbFmtSize, kbFmtDate } from './registry.js';

async function toolSaveDoc(env, chatId, args) {
  args = args || {};
  // v6.8.4：标题/source 去掉换行（换行会破坏 frontmatter 解析，导致重建注册表时标题丢失）
  const title = String(args.title || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
  const cleanSource = String(args.source || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
  let content = String(args.content || '');
  if (!title) return '标题为空，未保存';
  if (!content.trim()) return '内容为空，未保存';
  // v6.8.3：R2 未绑定时必须明确失败——之前会静默跳过写入却谎称"已保存"
  if (!env.R2) return 'R2 未绑定，知识库文档无法保存。请先按 README 第二步绑定 R2 存储桶后再试；本次内容未保存。';
  if (content.length > 100000) content = content.slice(0, 100000) + '\n\n> （内容过长，仅保存前 10 万字符）';
  const file = kbDocSlug(title) + '.md';
  const key = KB_DOCS_PREFIX + file;
  const reg = await kbGetRegistry(env);
  // 同链接去重（O(1) 查注册表）：已存为另一篇文档时拒绝
  const normSrc = kbNormSource(args.source);
  if (normSrc) {
    const dup = reg.find(e => kbNormSource(e.source) === normSrc);
    if (dup && dup.file !== file) {
      return '该链接已保存为知识库文档《' + (dup.title || dup.file) + '》，未重复保存。如需更新内容，请用标题"' + (dup.title || dup.file) + '"（或清洗后同名标题）重新保存以覆盖，或先用 delete_doc 删除旧文档。';
    }
  }
  const prevEntry = reg.find(e => e.file === file);
  const existed = !!prevEntry;
  const head = '---\ntitle: "' + title.replace(/"/g, '') + '"\nsaved_at: ' + new Date().toISOString()
    + '\nchat_id: "' + kbSafeChatId(chatId) + '"'
    + (cleanSource ? '\nsource: ' + cleanSource : '')
    + '\n---\n\n';
  const body = head + content;
  // v6.8.3：校验写入结果，R2 写入失败（如权限问题）不再谎称成功
  const okDoc = await storePutChecked(env, key, body);
  if (!okDoc) return '知识库文档写入 R2 失败（' + key + '），请检查 R2 绑定与权限后重试；本次内容未保存。';
  const entry = {
    file: file,
    title: title,
    source: cleanSource,
    size: body.length,
    updated_at: new Date().toISOString()
  };
  const idx = reg.findIndex(e => e.file === file);
  if (idx >= 0) reg[idx] = entry; else reg.push(entry);
  // v6.8.4：注册表写入失败必须如实返回——正文已落盘但列表查不到时，引导用户重试修复
  const okReg = await kbSaveRegistry(env, reg);
  if (!okReg) return '文档正文已写入 R2（' + key + '），但注册表更新失败，文档可能暂不出现在列表中；请稍后重新保存一次以修复注册表，本次内容未丢失。';
  let verNote = existed ? '，已覆盖旧版本' : '，新建';
  // v6.8.4：slug 碰撞提示——"A/B" 与 "AB" 会生成同一文件，覆盖时明确告知
  if (existed && prevEntry && prevEntry.title !== title) {
    verNote += '（注意：新标题清洗后与旧文档《' + prevEntry.title + '》同名，旧内容已被覆盖）';
  }
  return '已保存为知识库文档：' + key + '（' + content.length + ' 字符' + verNote + '）';
}
async function toolListDocs(env) {
  if (!env.R2) return 'R2 未绑定，无法读取知识库文档';
  const reg = await kbGetRegistry(env);
  if (!reg.length) return '知识库文档为空（kb/docs/ 下暂无文档，可用 save_doc 保存）';
  return '知识库文档（共' + reg.length + '篇）：\n' +
    reg.map((e, i) => (i + 1) + '. ' + (e.title || e.file) + '（' + kbFmtSize(e.size) + '，' + kbFmtDate(e.updated_at) + '）').join('\n');
}
async function toolReadDoc(env, args) {
  args = args || {};
  const query = String(args.query || '').trim();
  if (!query) return '请给出要读取的文档标题关键词';
  if (!env.R2) return 'R2 未绑定，无法读取知识库文档';
  const reg = await kbGetRegistry(env);
  if (!reg.length) return '知识库文档为空（kb/docs/ 下暂无文档）';
  const hit = kbFindRegEntry(reg, query);
  if (hit) {
    try {
      const obj = await env.R2.get(KB_DOCS_PREFIX + hit.file);
      if (!obj) return '文档读取失败：' + (hit.title || hit.file);
      let text = await obj.text();
      const MAX = 8000;
      let note = '';
      if (text.length > MAX) { text = text.slice(0, MAX); note = '\n\n> （文档过长，仅显示前 8000 字符）'; }
      return '【知识库文档《' + (hit.title || hit.file) + '》】\n' + text + note;
    } catch (e) { return '文档读取失败：' + (hit.title || hit.file); }
  }
  // 标题无命中 → 全文关键词检索（最多查 30 篇）
  const snippet = await kbSearchDocBody(env, reg.slice(0, 30).map(e => KB_DOCS_PREFIX + e.file), query);
  if (snippet) return snippet;
  return '未找到标题或正文包含"' + query + '"的文档。现有文档：\n' +
    reg.map(e => '- ' + (e.title || e.file)).join('\n');
}
// 全文关键词检索：分批并发读正文，返回首个命中的关键词上下文片段
// v6.8.4：原逐篇串行在文档多/正文大时易超时（工具超时 30s），改为每批 5 篇并发
async function kbSearchDocBody(env, keys, query) {
  const q = query.toLowerCase();
  const BATCH = 5;
  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (k) => {
      try {
        const obj = await env.R2.get(k);
        if (!obj) return null;
        const text = await obj.text();
        const idx = text.toLowerCase().indexOf(q);
        if (idx === -1) return null;
        return { k: k, text: text, idx: idx };
      } catch (e) { return null; }
    }));
    const hit = results.find(r => r);
    if (hit) {
      const start = Math.max(0, hit.idx - 600), end = Math.min(hit.text.length, hit.idx + query.length + 600);
      let frag = hit.text.slice(start, end);
      if (start > 0) frag = '…' + frag;
      if (end < hit.text.length) frag = frag + '…';
      return '【知识库文档《' + kbDocTitleOf(hit.k) + '》· 正文关键词命中】\n' + frag +
        '\n\n> （仅显示关键词附近片段；用 read_doc 以完整标题「' + kbDocTitleOf(hit.k) + '」可读全文）';
    }
  }
  return null;
}
async function toolDeleteDoc(env, args) {
  args = args || {};
  const query = String(args.query || '').trim();
  if (!query) return '请给出要删除的文档标题关键词';
  if (!env.R2) return 'R2 未绑定，无法删除知识库文档';
  const reg = await kbGetRegistry(env);
  if (!reg.length) return '知识库文档为空，无需删除';
  const hit = kbFindRegEntry(reg, query);
  if (!hit) {
    return '未找到标题包含"' + query + '"的文档。现有文档：\n' +
      reg.map(e => '- ' + (e.title || e.file)).join('\n');
  }
  try { await env.R2.delete(KB_DOCS_PREFIX + hit.file); } catch (e) { return '删除失败：' + (hit.title || hit.file); }
  // v6.8.4：注册表更新失败要如实告知，否则列表里会有"幽灵条目"导致读取失败
  const okReg = await kbSaveRegistry(env, reg.filter(e => e !== hit));
  if (!okReg) return '文档文件已删除，但注册表更新失败，列表可能仍显示旧条目；下次读取会自动重建注册表。《' + (hit.title || hit.file) + '》';
  return '已删除知识库文档《' + (hit.title || hit.file) + '》';
}

export {
  toolSaveDoc,
  toolListDocs,
  toolReadDoc,
  toolDeleteDoc,
};
