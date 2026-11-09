// 网页端「📚 知识库」只读清单接口：GET /api/kb/list
//
// 为什么单独开一个接口而不是让 Agent 在对话里回答：知识库文档全部落在 R2 的 kb/docs/ 下，
// 写入入口只有 Telegram 与微信 ClawBot。网页端如果只能靠模型"说"库里有几篇，
// 一旦模型答错（或压根没存进去），用户无从核对 —— 这就是「提示已保存、知识库里却没有」的来源。
// 这里直接把真实清单摊开：标题 / 大小 / 字符数 / 更新时间 / 标签。
//
// 两点设计取舍：
// 1) 固定 verify:true。这是用户主动点开面板触发的低频请求（不是 Agent 每轮的 list_docs），
//    顺手核对索引与 kb/docs/ 实际文件，才能保证"显示的就是 R2 里真实存在的"。
// 2) R2 未绑定时返回 ok:true + r2Bound:false，而不是 ok:false —— 前端对这两种情况
//    有各自的文案（前者指向"去控制台绑 R2"，后者才是"读取失败"），不要混成一条。
import { denyUnauthorized } from '../auth.js';
import { CORS_HEADERS } from '../constants.js';
import { kbGetRegistry, kbTakeRepairCount } from './registry.js';

// 与 toolListDocs 的上限保持一致：按更新时间倒序取最近 60 篇。
// 前端会显示"共 N 篇（按更新时间显示最近 60 篇）"，不会让人误以为库里只有这些。
const KB_LIST_MAX = 60;

function kbJson(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({}, CORS_HEADERS, { 'Cache-Control': 'no-store' }),
  });
}

function kbListEntry(e) {
  return {
    title: String(e.title || e.file || ''),
    file: String(e.file || ''),
    size: Number(e.size) || 0,
    chars: Number(e.chars) || 0,
    updated_at: String(e.updated_at || ''),
    tags: Array.isArray(e.tags) ? e.tags.slice(0, 8) : [],
  };
}

async function handleKbList(request, env) {
  const denied = denyUnauthorized(env, request);
  if (denied) return denied;

  if (!env || !env.R2) {
    return kbJson({ ok: true, r2Bound: false, count: 0, docs: [], repaired: 0 });
  }

  let reg = [];
  try {
    reg = await kbGetRegistry(env, { verify: true });
  } catch (e) {
    return kbJson({ ok: false, error: (e && e.message) || '读取知识库索引失败' }, 500);
  }
  const repaired = kbTakeRepairCount();

  const ordered = reg.slice().sort((a, b) => {
    const ta = Date.parse(a.updated_at || '') || 0;
    const tb = Date.parse(b.updated_at || '') || 0;
    return tb - ta;
  });

  return kbJson({
    ok: true,
    r2Bound: true,
    count: reg.length,
    repaired: repaired,
    docs: ordered.slice(0, KB_LIST_MAX).map(kbListEntry),
  });
}

export { handleKbList, KB_LIST_MAX };
