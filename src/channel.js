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
//               下游（前端、TG、微信、断点续做）统一保存 key，转发上游时用 id。
function getChannelConfig(env) {
  if (cachedConfig) {
    return cachedConfig;
  }

  const pending = [];
  const seenOriginal = new Set();

  const addModels = (modelStr, url, keys) => {
    if (!modelStr) return;
    const arr = modelStr.split(',');
    for (let i = 0; i < arr.length; i++) {
      const raw = arr[i].trim();
      if (!raw || seenOriginal.has(raw)) continue;
      seenOriginal.add(raw);

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
      channels.forEach(ch => {
        const url = ch.url;
        const keys = Array.isArray(ch.keys) ? ch.keys : parseCommaSeparated(ch.keys);
        const modelStr = Array.isArray(ch.models) ? ch.models.join(',') : ch.models;
        if (url && modelStr) addModels(modelStr, url, keys);
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
        addModels(modelStr, url, parseCommaSeparated(env[`API_KEY_${i}`]));
      }
    }
    if (!hasIndexed || pending.length === 0) {
      const fallbackUrl = env.API_URL || "";
      const fallbackModelStr = env.MODEL || "";
      if (fallbackUrl && fallbackModelStr) {
        addModels(fallbackModelStr, fallbackUrl, parseCommaSeparated(env.API_KEY));
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
    let key = idCount.get(e.id) > 1 ? e.original : e.id;
    if (modelMap.has(key)) key = e.original + '#' + (models.length + 1);
    const meta = { key, id: e.id, name: e.name, original: e.original };
    models.push(meta);
    modelMap.set(key, { ...meta, url: e.url, keys: e.keys });
  }

  cachedConfig = { models, modelMap };
  return cachedConfig;
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
  }

  return { apiUrl, currentApiKey, channelKeys: keys, payload, isImageAPI };
}

export {
  getChannelConfig,
  resolveModelKey,
  buildAIRequest,
};
