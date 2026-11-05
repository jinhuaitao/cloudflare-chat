// 知识库「自动整理入库」：把原始文档交给模型提炼成结构化档案，再与原文合并入库存档。
//
// 为什么单独抽一个模块：
// 这段逻辑原来只存在于 src/wechat/handler.js（微信上传文件时触发），Telegram 端完全用不了——
// 用户在 Telegram 发一句「整理知识库」没有任何反应。抽出来之后两端共用同一条链路，
// 也避免以后改一处忘另一处。

import { buildAIRequest } from '../channel.js';
import { toolSaveDoc, kbReadDocTextCached } from './doc-tools.js';
import { KB_DOCS_PREFIX, kbDocSlug } from './registry.js';

const ORGANIZE_MAX_INPUT = 42000;

function cleanDocTitle(docTitle) {
  return String(docTitle || '未命名知识文档').replace(/[\r\n]+/g, ' ').trim().slice(0, 75) || '未命名知识文档';
}

// 从「把《XXX》存进知识库」这类附言里反推文档标题，推不出来就退回文件名。
// 放在这里而不是各端 handler 里，是为了两端行为一致、也能被单测覆盖。
function deriveFileDocTitle(caption, fileName) {
  let t = String(caption || '').trim()
    .replace(/^[\s\S]*?(?:把|将)\s*/, '')
    .replace(/(?:保存|存进|存入|存到|存|收藏|入库|放到|加入)[\s\S]*$/, '')
    .replace(/[《》"'“”]/g, '')
    .trim();
  if (!t || t.length < 2) t = String(fileName || '未命名文档').replace(/\.[^.]+$/, '').trim();
  return t.replace(/[\r\n]+/g, ' ').slice(0, 60) || '未命名文档';
}

/**
 * 自动整理并保存知识库文档。
 *
 * @param {object} env Worker 环境
 * @param {string} chatId 会话 ID（写进 frontmatter，便于追溯来源）
 * @param {string} activeModelId 用于整理的模型
 * @param {string} docTitle 文档标题
 * @param {string} rawContent 原始全文
 * @param {string} sourceLabel 来源标记（如 wechat_file:xxx.txt）
 * @param {string} userNote 用户附加说明
 */
async function autoOrganizeAndSaveKbDoc(env, chatId, activeModelId, docTitle, rawContent, sourceLabel, userNote = '') {
  const cleanTitle = cleanDocTitle(docTitle);
  const fullText = String(rawContent || '').trim();
  if (!fullText) return { ok: false, error: '文档内容为空' };

  const docKey = KB_DOCS_PREFIX + kbDocSlug(cleanTitle) + '.md';

  // 第一步之前先留一份旧正文：既用来判断「原文/大纲是不是已经在了」，
  // 也避免第二步 AI 调用期间文档被别的请求改掉导致判重失准。
  const prevBody = (env && env.R2) ? await kbReadDocTextCached(env, docKey) : null;
  const rawAlready = prevBody ? bodyHasRaw(prevBody, fullText) : false;

  // 第一步：先把原始全文安全落盘（防止 AI 整理期间超时/异常导致整篇丢失）。
  // 原文一字不差已经在库里时跳过这一步 —— 否则这次覆盖会把上一篇的大纲冲掉，
  // 后面又因为「大纲已存在」而不再前置，文档反而退化成只有原文。
  let saveResult = '';
  if (env && env.R2) {
    saveResult = rawAlready
      ? '原文已在知识库中（内容未变化）'
      : await toolSaveDoc(env, chatId, {
        title: cleanTitle,
        content: fullText,
        source: sourceLabel || 'upload',
        tags: '原文归档',
      });
  }
  // 原文是否真的落地了：被内容指纹挡住时说明库里已有同一篇，
  // 此时绝不能再去 prepend 大纲 —— 那会在新标题下建出一篇只有摘要、没有原文的孤儿文档。
  const bodySaved = rawAlready || /^已保存为知识库文档/.test(saveResult);

  // 第二步：调用 AI 提炼结构化大纲、要点、关键数据与检索标签
  const excerpt = fullText.length > ORGANIZE_MAX_INPUT
    ? fullText.slice(0, ORGANIZE_MAX_INPUT) + '\n\n…（原文较长，以上为前 ' + ORGANIZE_MAX_INPUT + ' 字符）'
    : fullText;
  const kbMessages = [
    {
      role: 'system',
      content: '你是一位专业的知识库架构师。请将用户提供的文档或资料自动整理成结构严谨、高信息密度的知识库档案。必须完整保留原文中的关键数据、核心定义、流程步骤、条款规则与结论，切勿遗漏重要细节。',
    },
    {
      role: 'user',
      content: `请将以下资料《${cleanTitle}》自动整理为结构化知识库档案，严格包含以下四个部分：\n`
        + `1. 【📌 核心摘要】：用 2~4 句话高度概括文档主旨与用途；\n`
        + `2. 【🗂️ 结构化知识大纲】：按逻辑模块或章节详细提炼所有核心知识点、规则、公式、接口或流程；\n`
        + `3. 【📊 关键数据与结论速查】：提取文中的关键参数、数字指标、表格结论或时间节点；\n`
        + `4. 【🏷️ 检索关键词标签】：列出 5~10 个核心检索词，用逗号分隔。\n`
        + (userNote ? `\n用户附加说明：${userNote}\n` : '')
        + `\n原始资料内容如下：\n\`\`\`\n${excerpt}\n\`\`\``,
    },
  ];

  let organizedSummary = '';
  const aiCfg = buildAIRequest(env, activeModelId, kbMessages, false);
  if (!aiCfg.error) {
    try {
      const resp = await fetch(aiCfg.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + aiCfg.currentApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(aiCfg.payload),
        signal: AbortSignal.timeout(55000),
      });
      if (resp.ok) {
        const d = await resp.json();
        if (d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) {
          organizedSummary = String(d.choices[0].message.content).trim();
        }
      } else {
        try { await resp.body.cancel(); } catch (e) {}
      }
    } catch (e) {}
  }

  // 第三步：整理成功就用 prepend 把大纲插到原文前面（不再重复传一遍全文，
  // 也不会把刚落盘的原文覆盖掉）。整理失败则保留第一步的原文，数据不丢。
  let skippedDup = false;
  if (organizedSummary && env && env.R2 && bodySaved) {
    if (prevBody && sameSummaryExists(prevBody, organizedSummary)) {
      // 同一个文件重复上传、或对同一段对话重复整理：大纲已经在文档里，不再前置一遍
      skippedDup = true;
    } else {
      const tagLine = extractTagLine(organizedSummary);
      saveResult = await toolSaveDoc(env, chatId, {
        title: cleanTitle,
        content: organizedSummary,
        source: sourceLabel || 'upload',
        mode: 'prepend',
        // 两步写入同一次入库，不再额外占一个版本槽位
        snapshot: false,
        tags: tagLine ? tagLine : '原文归档',
      });
    }
  }

  // 重复整理时给一句人话，别让用户以为「已保存」其实是白存了一遍
  if (skippedDup) saveResult = '原文与整理大纲均已在库中，本次未重复写入';

  return {
    // 「原文未变化」与「未重复保存」都算成功：内容确实在库里，只是这次没有新写
    ok: !!(env && env.R2 && (bodySaved || /未重复保存/.test(saveResult))),
    title: cleanTitle,
    skippedDup: skippedDup,
    organizedSummary: organizedSummary || ('（已提取原文共 ' + fullText.length + ' 字符）\n' + fullText.slice(0, 1200)),
    saveResult: saveResult || (env && env.R2 ? '已保存' : '⚠️ 当前未绑定持久化存储 (R2/Blob/KV)，仅在当前会话生效'),
    charCount: fullText.length,
  };
}

// 原文是否已经在文档里：比对前 400 个非空白字符（prepend 会把大纲放在前面，
// 所以不能用「以原文开头」判断，只能做包含判断）。
function bodyHasRaw(body, raw) {
  const probe = String(raw || '').replace(/\s+/g, '').slice(0, 400);
  if (probe.length < 20) return false;
  return String(body || '').replace(/\s+/g, '').indexOf(probe) !== -1;
}

// 判断文档里是否已经有这次整理出来的大纲：比对摘要首段的 30 字归一化指纹。
// 用前缀而不是全文哈希，是因为同一份原文两次整理出来的措辞会有细微差异，
// 但「核心摘要」的第一句几乎总是一样的。
function sameSummaryExists(body, summary) {
  const probe = String(summary || '').replace(/[\s*_~`>#-]+/g, '').slice(0, 30);
  if (probe.length < 12) return false;
  const flat = String(body || '').replace(/[\s*_~`>#-]+/g, '');
  return flat.indexOf(probe) !== -1;
}

// 从 AI 输出的「检索关键词标签」段落里抽出标签串，直接当成知识库 tags 用
function extractTagLine(summary) {
  const s = String(summary || '');
  const m = /【[^】]*检索[^】]*标签[^】]*】[：:]?\s*([^\n]+)/.exec(s);
  if (!m) return '';
  return String(m[1])
    .replace(/^[-*\s]+/, '')
    .split(/[,，、;；]/)
    .map(x => x.replace(/^#/, '').trim())
    .filter(Boolean)
    .slice(0, 8)
    .join(', ');
}

export {
  autoOrganizeAndSaveKbDoc,
  cleanDocTitle,
  deriveFileDocTitle,
  extractTagLine,
};
