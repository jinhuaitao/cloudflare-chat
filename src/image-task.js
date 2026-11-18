// ModelScope 魔搭生图异步任务处理。
// 魔搭 API-Inference 的 /v1/images/generations 是异步接口：
//   1) POST（带 X-ModelScope-Async-Mode: true）→ { task_id }
//   2) GET /v1/tasks/{task_id}（带 X-ModelScope-Task-Type: image_generation）
//      → { task_status: 'SUCCEED'|'FAILED'|..., output_images: ['https://...'] }
//   3) 下载 output_images[0]（本模块只返回 URL，下载/渲染交给上层）
// 其它文生图通道（同步返回 data[] 的）不走这里。

// ⚠️ Cloudflare Workers 子请求上限：免费版 50/请求、付费版 1000/请求。
// 每次轮询算 1 个子请求，故 间隔×次数 必须留余量。默认 8 秒 × 约 37 次（5 分钟）适合免费版；
// 付费版可用 IMAGE_TASK_INTERVAL_MS / IMAGE_TASK_MAX_WAIT_MS 自行放宽。
const DEFAULT_INTERVAL_MS = 8000;
const DEFAULT_MAX_WAIT_MS = 300000; // 5 分钟：约 37 次轮询，免费版 50 次上限内留余量。
                                     // Qwen-Image 冷启动多为 1~3 分钟；仍不够时用 IMAGE_TASK_MAX_WAIT_MS 调大
                                     // （付费版可调到 600000，免费版需同步调大间隔以免超子请求数）。

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 从 API 基址（.../v1/images/generations）推导任务查询地址（.../v1/tasks/{id}）
export function buildTaskQueryUrl(apiUrl, taskId) {
  const base = String(apiUrl).replace(/\/v1\/images\/generations.*$/i, '');
  return `${base}/v1/tasks/${encodeURIComponent(taskId)}`;
}

/**
 * 轮询 ModelScope 异步任务，成功后返回第一张图片的 URL。
 * @param {object} opts
 * @param {string} opts.apiUrl        原始 images/generations 地址，用于推导 tasks 地址
 * @param {string} opts.apiKey        访问令牌
 * @param {string} opts.taskId        提交阶段返回的 task_id
 * @param {number} [opts.intervalMs]  轮询间隔，默认 3000
 * @param {number} [opts.maxWaitMs]   总等待上限，默认 180000
 * @param {string[]} [opts.outputImages] 若提交响应已带图片链接，直接返回，无需轮询
 * @returns {Promise<{url?: string, error?: string}>}
 */
export async function pollModelScopeTask(opts) {
  const {
    apiUrl, apiKey, taskId,
    intervalMs = DEFAULT_INTERVAL_MS,
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
    outputImages,
    fetchImpl,
  } = opts || {};
  const doFetch = fetchImpl || fetch;

  // 少数情况下提交响应可能直接带图（同步兜底），省去轮询
  if (Array.isArray(outputImages) && outputImages.length && typeof outputImages[0] === 'string') {
    return { url: outputImages[0] };
  }
  if (!taskId) return { error: 'ModelScope 未返回 task_id，无法查询生成结果' };

  const queryUrl = buildTaskQueryUrl(apiUrl, taskId);
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'X-ModelScope-Task-Type': 'image_generation',
  };
  const deadline = Date.now() + Math.max(1000, maxWaitMs);
  let lastStatus = '';

  while (Date.now() < deadline) {
    let data;
    try {
      const resp = await doFetch(queryUrl, { headers });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        return { error: `查询生成任务失败 (${resp.status}): ${String(text).slice(0, 300)}` };
      }
      data = await resp.json();
    } catch (e) {
      return { error: `查询生成任务异常: ${e && e.message ? e.message : String(e)}` };
    }

    lastStatus = data && data.task_status ? String(data.task_status) : '';
    const imgs = data && Array.isArray(data.output_images) ? data.output_images : [];
    if (lastStatus === 'SUCCEED') {
      const url = imgs.find(u => typeof u === 'string' && /^https?:\/\//i.test(u))
        || imgs.find(u => typeof u === 'string' && u.startsWith('data:image/'));
      if (url) return { url };
      return { error: '生成成功但未返回图片链接（output_images 为空）' };
    }
    if (lastStatus === 'FAILED' || lastStatus === 'CANCELED') {
      const msg = data && (data.message || data.error) || '';
      return { error: `图片生成${lastStatus === 'FAILED' ? '失败' : '已取消'}${msg ? '：' + msg : ''}` };
    }
    // 排队中 / 处理中等其它状态，继续轮询
    await sleep(Math.max(200, intervalMs));
  }

  return { error: `图片生成超时（最后状态：${lastStatus || '未知'}，已等待 ${Math.round(maxWaitMs / 1000)} 秒。可用 IMAGE_TASK_MAX_WAIT_MS 调大）` };
}

// 统一的图片响应解析（供三端复用，避免各自维护一套结构判断）
function pickImageUrl(data) {
  if (!data || typeof data !== 'object') return '';
  // OpenAI data[] / images[]
  for (const key of ['data', 'images', 'output_images']) {
    const arr = data[key];
    if (Array.isArray(arr)) {
      for (const it of arr) {
        if (typeof it === 'string' && /^(https?:\/\/|data:image\/)/i.test(it)) return it;
        if (it && typeof it === 'object') {
          const u = it.url || it.image_url || it.image;
          if (typeof u === 'string' && /^(https?:\/\/|data:image\/)/i.test(u)) return u;
          if (it.b64_json) return 'data:image/png;base64,' + it.b64_json;
        }
      }
    }
  }
  if (typeof data.url === 'string' && /^(https?:\/\/|data:image\/)/i.test(data.url)) return data.url;
  return '';
}

/**
 * 提交生图请求并（按需）轮询，返回 { url } 或 { error }。Web / 微信 / Agent 三端共用。
 * @param {object} opts
 *   cfg      —— buildAIRequest 的返回值（含 apiUrl/currentApiKey/payload/isImageAPI/isModelScope）
 *   env      —— 环境变量（读取 IMAGE_TASK_MAX_WAIT_MS）
 *   fetchImpl—— 可选 fetch 实现（便于测试注入）
 */
export async function runImageRequest(opts) {
  const { cfg, env, fetchImpl } = opts || {};
  const doFetch = fetchImpl || fetch;
  const headers = {
    'Authorization': `Bearer ${cfg.currentApiKey}`,
    'Content-Type': 'application/json',
  };
  if (cfg.isModelScope) headers['X-ModelScope-Async-Mode'] = 'true';

  let resp;
  try {
    resp = await doFetch(cfg.apiUrl, { method: 'POST', headers, body: JSON.stringify(cfg.payload) });
  } catch (e) {
    return { error: `生图请求失败：${e && e.message ? e.message : String(e)}` };
  }
  if (!resp.ok) {
    let detail = '';
    try { detail = String(await resp.text()).slice(0, 300); } catch (e) {}
    return { error: `生图接口报错 (${resp.status})：${detail}`, status: resp.status };
  }

  let data;
  try { data = await resp.json(); }
  catch (e) { return { error: '生图接口未返回有效 JSON' }; }

  // ModelScope 异步任务：先拿 task_id，再轮询
  if (cfg.isModelScope && data && data.task_id) {
    const configured = parseInt((env && env.IMAGE_TASK_MAX_WAIT_MS) || '', 10);
    const configuredInterval = parseInt((env && env.IMAGE_TASK_INTERVAL_MS) || '', 10);
    return await pollModelScopeTask({
      apiUrl: cfg.apiUrl,
      apiKey: cfg.currentApiKey,
      taskId: data.task_id,
      maxWaitMs: configured > 0 ? configured : undefined,
      intervalMs: configuredInterval > 0 ? configuredInterval : undefined,
      outputImages: data.output_images,
      fetchImpl: doFetch,
    });
  }

  const url = pickImageUrl(data);
  if (url) return { url };
  // 部分中转网关把图片塞进 choices[].message.content
  const ch = data && data.choices && data.choices[0];
  const content = ch && (ch.message || ch.delta) && (ch.message || ch.delta).content;
  if (typeof content === 'string' && content) return { text: content };
  return { error: '图片生成失败或未返回格式' };
}
