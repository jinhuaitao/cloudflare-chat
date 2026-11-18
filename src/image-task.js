// ModelScope 魔搭生图异步任务处理。
// 魔搭 API-Inference 的 /v1/images/generations 是异步接口：
//   1) POST（带 X-ModelScope-Async-Mode: true）→ { task_id }
//   2) GET /v1/tasks/{task_id}（带 X-ModelScope-Task-Type: image_generation）
//      → { task_status: 'SUCCEED'|'FAILED'|..., output_images: ['https://...'] }
//   3) 下载 output_images[0]（本模块只返回 URL，下载/渲染交给上层）
// 其它文生图通道（同步返回 data[] 的）不走这里。

const DEFAULT_INTERVAL_MS = 3000;   // 轮询间隔
const DEFAULT_MAX_WAIT_MS = 180000; // 总等待上限（3 分钟），避免 Worker 无限挂起

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
  } = opts || {};

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
      const resp = await fetch(queryUrl, { headers });
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

  return { error: `图片生成超时（最后状态：${lastStatus || '未知'}）` };
}
