// 统一解析多通道配置（带内存缓存）并构建上游 AI 请求（v7.1.0：支持多 Key 轮询与故障切换池）

import { parseCommaSeparated } from './utils.js';

let cachedConfig = null;
const keyRoundRobinIdx = new Map();

// ======= 统一解析通道配置（带内存缓存） =======
// 每条模型拆成四个字段：
//   id       —— 发给上游的 model 名（第一个冒号之前的部分）
//   name     —— 下拉框 / TG / 微信列表里的显示名（第一个冒号之后的部分），仅用于展示
//   original —— 环境变量里的原始串（id:name）
//   key      —— 选择键。id 全局唯一时等于 id；同一 id 被多个供应商复用时取 original，
//               这样「同一个上游模型名 + 不同 API_URL/API_KEY」的多条通道可以并存，互不覆盖。
//               若连 original 也相同（两个通道声明了完全一样的 "id:name"），再追加 #2/#3 后缀。
//               下游（前端、TG、微信、断点续做）统一保存 key，转发上游时用 id。
function getChannelConfig(env) {
  if (cachedConfig) {
    return cachedConfig;
  }

  const pending = [];
  // 去重范围是「单个通道内」而不是全局：同一条 MODEL_1 里写两遍同一个模型是笔误，应当合并；
  // 但 API_URL_1 与 API_URL_2 各声明一次 gpt-4o 是主备双通道，两条都必须保留 ——
  // 旧版用全局 seenOriginal 去重，会把第二条通道整个吞掉（配了备用线路却永远打不到）。
  const seenInChannel = new Set();

  const addModels = (modelStr, url, keys, channelTag) => {
    if (!modelStr) return;
    const arr = modelStr.split(',');
    for (let i = 0; i < arr.length; i++) {
      const raw = arr[i].trim();
      if (!raw) continue;
      const dedupeKey = channelTag + '|' + raw;
      if (seenInChannel.has(dedupeKey)) continue;
      seenInChannel.add(dedupeKey);

      const colonIdx = raw.indexOf(':');
      const id = colonIdx > 0 ? raw.substring(0, colonIdx).trim() : raw;
      const name = colonIdx > 0 ? raw.substring(colonIdx + 1).trim() : raw;
      pending.push({ id, name, original: raw, url, keys });
    }
  };

  let parsedApiConfig = false;
  if (env.API_CONFIG) {
    try {
      const channels = JSON.parse(env.API_CONFIG);
      channels.forEach((ch, ci) => {
        const url = ch.url;
        const keys = Array.isArray(ch.keys) ? ch.keys : parseCommaSeparated(ch.keys);
        const modelStr = Array.isArray(ch.models) ? ch.models.join(',') : ch.models;
        if (url && modelStr) addModels(modelStr, url, keys, 'cfg' + ci);
      });
      if (pending.length > 0) parsedApiConfig = true;
    } catch (e) {
      console.log("API_CONFIG 解析失败:", e);
    }
  }

  if (!parsedApiConfig) {
    let hasIndexed = false;
    for (let i = 1; i <= 20; i++) {
      const url = env[`API_URL_${i}`];
      const modelStr = env[`MODEL_${i}`];
      if (url && modelStr) {
        hasIndexed = true;
        addModels(modelStr, url, parseCommaSeparated(env[`API_KEY_${i}`]), 'idx' + i);
      }
    }
    if (!hasIndexed || pending.length === 0) {
      const fallbackUrl = env.API_URL || "";
      const fallbackModelStr = env.MODEL || "";
      if (fallbackUrl && fallbackModelStr) {
        addModels(fallbackModelStr, fallbackUrl, parseCommaSeparated(env.API_KEY), 'base');
      }
    }
  }

  // 先统计每个上游模型名出现次数，再决定选择键：唯一 → 沿用 id（保持与旧版存储兼容）；
  // 重复 → 用完整配置串 original，让同名模型的多个供应商各自成为独立选项。
  const models = [];
  const modelMap = new Map();
  const idCount = new Map();
  for (const e of pending) {
    idCount.set(e.id, (idCount.get(e.id) || 0) + 1);
  }
  for (const e of pending) {
    const duplicated = idCount.get(e.id) > 1;
    let key = duplicated ? e.original : e.id;
    if (modelMap.has(key)) {
      // original 也撞了（两个通道写了完全相同的 "id:name"）：补一个稳定后缀。
      // 用递增序号而不是 models.length，避免中间有被跳过的条目时序号跳号。
      let n = 2;
      while (modelMap.has(e.original + '#' + n)) n++;
      key = e.original + '#' + n;
    }
    // 下拉框里的显示名：同名模型来自不同通道时补上主机名，否则用户看到两个一模一样的选项
    const channelHint = duplicated ? hostOf(e.url) : '';
    const meta = { key, id: e.id, name: e.name, channelHint, original: e.original };
    models.push(meta);
    modelMap.set(key, { ...meta, url: e.url, keys: e.keys });
  }

  cachedConfig = { models, modelMap };
  return cachedConfig;
}

// 从 API_URL 里取主机名，只用于显示。取不到就退回空串，调用方会退回 name。
function hostOf(url) {
  try {
    return new URL(String(url)).host || '';
  } catch (e) {
    return '';
  }
}

// 清掉解析缓存。生产环境不需要（同一个 isolate 里 env 不会变），
// 但测试要在同一进程里反复用不同 env 验证配置解析，必须能重置。
function resetChannelConfigCache() {
  cachedConfig = null;
  keyRoundRobinIdx.clear();
}

// 把各种历史 / 外部传入的模型标识统一解析成当前模型的元信息：
// 依次匹配 key（选择键）→ id（旧版前端 localStorage、TG / 微信 / 断点续做里的裸模型名）→ name（显示名）
function findModelEntry(models, value) {
  if (value == null || value === '') return null;
  const v = String(value);
  return models.find(m => m.key === v)
    || models.find(m => m.id === v)
    || models.find(m => m.name === v)
    || null;
}

function resolveModelKey(models, value) {
  const entry = findModelEntry(models, value);
  return entry ? entry.key : null;
}

// 提取共用的 AI 请求构建逻辑 (DRY原则)
// v7.1.0：采用 Round-Robin 均匀轮询多 Key，并暴露 channelKeys 供上游 429/5xx 时自动切 Key 重试
function buildAIRequest(env, requestedModel, messagesArray, isStream, tools) {
  const { models, modelMap } = getChannelConfig(env);

  if (models.length === 0) {
    return { error: "未配置任何可用模型。请在 Worker 的环境变量中设置 API_URL_1 / API_KEY_1 / MODEL_1（或 API_URL / API_KEY / MODEL），保存后重新部署一次。" };
  }

  const found = findModelEntry(models, requestedModel) || models[0];
  const channel = modelMap.get(found.key);
  if (!channel || !channel.url) return { error: `模型 ${found.id} 对应的 API_URL 未配置或异常` };

  const selectedKey = channel.key;
  const upstreamModel = channel.id;

  const keys = Array.isArray(channel.keys) ? channel.keys : [];
  let currentApiKey = "";
  if (keys.length === 1) {
    currentApiKey = keys[0];
  } else if (keys.length > 1) {
    const cur = (keyRoundRobinIdx.get(selectedKey) || 0) % keys.length;
    currentApiKey = keys[cur];
    keyRoundRobinIdx.set(selectedKey, (cur + 1) % keys.length);
  }

  const apiUrl = channel.url;
  const isImageAPI = apiUrl.includes('images/generations');

  let maxTokens = parseInt(env.MAX_TOKENS || '4096', 10);
  if (!(maxTokens > 0)) maxTokens = 16384;
  if (maxTokens > 32000) maxTokens = 32000;

  let lastPrompt = '';
  const lastMsg = messagesArray[messagesArray.length - 1];
  if (lastMsg) {
    if (typeof lastMsg.content === 'string') {
      lastPrompt = lastMsg.content;
    } else if (Array.isArray(lastMsg.content)) {
      const seg = lastMsg.content.find(s => s && s.type === 'text' && typeof s.text === 'string');
      lastPrompt = seg ? seg.text : '';
    }
  }

  let payload;
  if (isImageAPI) {
    payload = {
      model: upstreamModel,
      prompt: lastPrompt,
      n: 1,
      size: "auto",
      output_format: "png",
      response_format: "url"
    };
    if (upstreamModel.includes('sensenova')) {
      payload.watermark = false;
    }
  } else {
    payload = {
      model: upstreamModel,
      messages: messagesArray.map(m => {
        const o = { role: m.role, content: m.content };
        if (m.tool_calls) o.tool_calls = m.tool_calls;
        if (m.tool_call_id) { o.tool_call_id = m.tool_call_id; if (m.name) o.name = m.name; }
        if (m.reasoning_content) o.reasoning_content = m.reasoning_content;
        return o;
      }),
      stream: isStream,
      max_tokens: maxTokens,
    };
    if (tools && tools.length) payload.tools = tools;
    // v7.12.1 准确率：Agent 步骤（带 tools 的请求，含收尾作答传 []）可选低温采样。
    // 采样温度越低，工具选择与 JSON 参数生成越确定，误选工具 / 参数畸形率显著下降。
    // 默认不发送（沿用上游默认值，避免 o1 等对 temperature 有硬性要求的模型报错），
    // 通过 AGENT_TEMPERATURE=0.2~0.6 显式开启；仅对带 tools 的请求生效，普通对话不受影响。
    if (tools) {
      const temp = parseFloat(env.AGENT_TEMPERATURE);
      if (Number.isFinite(temp) && temp >= 0 && temp <= 2) payload.temperature = temp;
    }
  }

  return { apiUrl, currentApiKey, channelKeys: keys, payload, isImageAPI };
}

export {
  getChannelConfig,
  resolveModelKey,
  buildAIRequest,
  resetChannelConfigCache,
};
