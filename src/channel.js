// 统一解析多通道配置（带内存缓存）并构建上游 AI 请求（_worker.js 原第 19-20,1706-1821 行）

import { parseCommaSeparated } from './utils.js';

// 优化：不再校验 env 的引用，因为 Worker 生命周期内环境变量是恒定的
let cachedConfig = null; 
// ======= 统一解析通道配置（带内存缓存） =======
function getChannelConfig(env) {
  if (cachedConfig) {
    return cachedConfig;
  }

  const models = [];
  const modelMap = new Map();

  const addModels = (modelStr, url, keys) => {
    if (!modelStr) return;
    const arr = modelStr.split(',');
    for (let i = 0; i < arr.length; i++) {
      const raw = arr[i].trim();
      if (!raw) continue;
      
      // 用第一个冒号切分：模型 ID 本身不含冒号，显示名里允许出现冒号
      const colonIdx = raw.indexOf(':');
      const id = colonIdx > 0 ? raw.substring(0, colonIdx).trim() : raw;
      const name = colonIdx > 0 ? raw.substring(colonIdx + 1).trim() : raw;

      if (!modelMap.has(id)) {
        models.push({ id, name, original: raw });
        modelMap.set(id, { url, keys });
      }
    }
  };

  if (env.API_CONFIG) {
    try {
      const channels = JSON.parse(env.API_CONFIG);
      channels.forEach(ch => {
        const url = ch.url;
        const keys = Array.isArray(ch.keys) ? ch.keys : parseCommaSeparated(ch.keys);
        const modelStr = Array.isArray(ch.models) ? ch.models.join(',') : ch.models;
        if (url && modelStr) addModels(modelStr, url, keys);
      });
      if (models.length > 0) {
        cachedConfig = { models, modelMap };
        return cachedConfig;
      }
    } catch (e) {
      console.log("API_CONFIG 解析失败:", e);
    }
  }

  let hasIndexed = false;
  for (let i = 1; i <= 20; i++) {
    const url = env[`API_URL_${i}`];
    const modelStr = env[`MODEL_${i}`];
    if (url && modelStr) {
      hasIndexed = true;
      const keys = parseCommaSeparated(env[`API_KEY_${i}`]);
      addModels(modelStr, url, keys);
    }
  }
  if (hasIndexed && models.length > 0) {
    cachedConfig = { models, modelMap };
    return cachedConfig;
  }

  // 兜底：只使用环境变量中显式配置的模型，不再内置任何默认模型
  const fallbackUrl = env.API_URL || "";
  const fallbackKeys = parseCommaSeparated(env.API_KEY);
  const fallbackModelStr = env.MODEL || "";

  if (fallbackUrl && fallbackModelStr) {
    addModels(fallbackModelStr, fallbackUrl, fallbackKeys);
  }

  cachedConfig = { models, modelMap };
  return cachedConfig;
}

// 提取共用的 AI 请求构建逻辑 (DRY原则)
// tools: 可选，OpenAI 兼容的 tools 数组（Agent 模式用）；图片通道自动忽略
function buildAIRequest(env, requestedModel, messagesArray, isStream, tools) {
  const { models, modelMap } = getChannelConfig(env);

  if (models.length === 0) {
    return { error: "未配置任何可用模型。请在 Worker 的环境变量中设置 API_URL_1 / API_KEY_1 / MODEL_1（或 API_URL / API_KEY / MODEL），保存后重新部署一次。" };
  }

  let selectedModel = requestedModel || models[0].id;

  if (!modelMap.has(selectedModel)) {
    selectedModel = models[0].id;
  }

  const channel = modelMap.get(selectedModel);
  if (!channel || !channel.url) return { error: `模型 ${selectedModel} 对应的 API_URL 未配置或异常` };

  const currentApiKey = channel.keys.length > 0 ? channel.keys[Math.floor(Math.random() * channel.keys.length)] : "";
  const apiUrl = channel.url;
  // 图片模型只认 images/generations 接口地址，不再按模型名猜测，避免误伤
  const isImageAPI = apiUrl.includes('images/generations');

  // max_tokens 可配：环境变量 MAX_TOKENS，默认 4096，上限 32000
  let maxTokens = parseInt(env.MAX_TOKENS || '4096', 10);
  if (!(maxTokens > 0)) maxTokens = 16384;
  if (maxTokens > 32000) maxTokens = 32000;

  // v6.8.9：图片通道取最后一条消息的纯文本。之前直接
  // messagesArray[len-1].content —— 空数组会 TypeError，多模态 content（分片数组）
  // 会把整个对象塞进 prompt，上游必然报错
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
      model: selectedModel,
      prompt: lastPrompt,
      n: 1,
      size: "auto",
      output_format: "png",
      response_format: "url"
    };
    // 针对商汤生图模型显式关闭水印（公测免去水印）
    if (selectedModel.includes('sensenova')) {
      payload.watermark = false;
    }
  } else {
    payload = {
      model: selectedModel,
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

  return { apiUrl, currentApiKey, payload, isImageAPI };
}

export {
  getChannelConfig,
  buildAIRequest,
};
