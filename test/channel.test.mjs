// 通道配置解析回归测试。
//
// 这块逻辑的坑很集中：环境变量有三种写法（API_CONFIG / API_URL_1..20 / API_URL）、
// 模型串是 `id:name` 形态、同一个上游模型名可能被多个供应商复用。
// 一旦选择键算错，表现是"下拉框选了 A 却打到了 B 的地址"，很难从日志上看出来。

import test from 'node:test';
import assert from 'node:assert/strict';

import { getChannelConfig, resolveModelKey, buildAIRequest, resetChannelConfigCache } from '../src/channel.js';

function withEnv(env) {
  resetChannelConfigCache();
  return getChannelConfig(env);
}

test('编号通道：解析 id / name / original 与选择键', () => {
  const { models, modelMap } = withEnv({
    API_URL_1: 'https://api.a.com/v1/chat/completions',
    API_KEY_1: 'k1,k2',
    MODEL_1: 'gpt-4o:GPT-4o,deepseek-chat:DeepSeek V3',
  });

  assert.equal(models.length, 2);
  assert.deepEqual(models[0], {
    key: 'gpt-4o', id: 'gpt-4o', name: 'GPT-4o', channelHint: '', original: 'gpt-4o:GPT-4o',
  });
  assert.equal(models[1].key, 'deepseek-chat');

  const ch = modelMap.get('gpt-4o');
  assert.equal(ch.url, 'https://api.a.com/v1/chat/completions');
  assert.deepEqual(ch.keys, ['k1', 'k2']);
});

test('没有冒号时 id 与显示名都取原文', () => {
  const { models } = withEnv({ API_URL_1: 'https://a.com', MODEL_1: 'qwen-max' });
  assert.equal(models[0].id, 'qwen-max');
  assert.equal(models[0].name, 'qwen-max');
  assert.equal(models[0].key, 'qwen-max');
});

test('同一通道内重复声明同一模型只保留一条', () => {
  const { models } = withEnv({ API_URL_1: 'https://a.com', MODEL_1: 'gpt-4o:GPT-4o,gpt-4o:GPT-4o' });
  assert.equal(models.length, 1);
});

test('不同通道声明同一模型串：两条都保留，选择键互不相同', () => {
  // 旧版用全局去重，第二条通道会被整个吞掉 —— 配了备用线路却永远打不到
  const { models, modelMap } = withEnv({
    API_URL_1: 'https://primary.example.com/v1',
    API_KEY_1: 'k1',
    MODEL_1: 'gpt-4o:GPT-4o',
    API_URL_2: 'https://backup.example.com/v1',
    API_KEY_2: 'k2',
    MODEL_2: 'gpt-4o:GPT-4o',
  });

  assert.equal(models.length, 2);
  const keys = models.map(m => m.key);
  assert.equal(new Set(keys).size, 2, '选择键必须唯一：' + keys.join(','));
  assert.equal(keys[0], 'gpt-4o:GPT-4o');
  assert.equal(keys[1], 'gpt-4o:GPT-4o#2');

  // 两条通道各自指向自己的 URL，没有互相覆盖
  assert.equal(modelMap.get(keys[0]).url, 'https://primary.example.com/v1');
  assert.equal(modelMap.get(keys[1]).url, 'https://backup.example.com/v1');
  assert.deepEqual(modelMap.get(keys[1]).keys, ['k2']);

  // 显示名补主机名，避免下拉框出现两个一模一样的选项
  assert.equal(models[0].channelHint, 'primary.example.com');
  assert.equal(models[1].channelHint, 'backup.example.com');
});

test('同一 id 不同 name：各自独立，选择键取 original', () => {
  const { models } = withEnv({
    API_URL_1: 'https://a.com',
    MODEL_1: 'gpt-4o:官方',
    API_URL_2: 'https://b.com',
    MODEL_2: 'gpt-4o:备用',
  });
  assert.deepEqual(models.map(m => m.key), ['gpt-4o:官方', 'gpt-4o:备用']);
  assert.deepEqual(models.map(m => m.id), ['gpt-4o', 'gpt-4o']);
});

test('API_CONFIG 优先于编号通道', () => {
  const { models } = withEnv({
    API_CONFIG: JSON.stringify([
      { url: 'https://cfg.com/v1', keys: ['ck'], models: ['m1:配置模型'] },
    ]),
    API_URL_1: 'https://idx.com/v1',
    MODEL_1: 'm2:编号模型',
  });
  assert.deepEqual(models.map(m => m.id), ['m1']);
  assert.equal(models[0].name, '配置模型');
});

test('API_CONFIG 解析失败时回退到编号通道', () => {
  const { models } = withEnv({
    API_CONFIG: '{ not json',
    API_URL_1: 'https://idx.com/v1',
    MODEL_1: 'm2:编号模型',
  });
  assert.deepEqual(models.map(m => m.id), ['m2']);
});

test('未配置编号通道时回退到 API_URL / API_KEY / MODEL', () => {
  const { models, modelMap } = withEnv({
    API_URL: 'https://single.com/v1',
    API_KEY: 'sk',
    MODEL: 'solo:单通道',
  });
  assert.equal(models.length, 1);
  assert.equal(models[0].key, 'solo');
  assert.deepEqual(modelMap.get('solo').keys, ['sk']);
});

test('resolveModelKey 兼容 key / id / name 三种历史写法', () => {
  const { models } = withEnv({
    API_URL_1: 'https://a.com', MODEL_1: 'gpt-4o:GPT-4o',
    API_URL_2: 'https://b.com', MODEL_2: 'gpt-4o:备用',
  });
  assert.equal(resolveModelKey(models, 'gpt-4o:GPT-4o'), 'gpt-4o:GPT-4o'); // key
  assert.equal(resolveModelKey(models, '备用'), 'gpt-4o:备用');             // name
  assert.equal(resolveModelKey(models, 'gpt-4o'), 'gpt-4o:GPT-4o');         // 裸 id → 命中第一条
  assert.equal(resolveModelKey(models, '不存在'), null);
  assert.equal(resolveModelKey(models, ''), null);
});

test('buildAIRequest 未配置任何模型时给出可操作的报错', () => {
  resetChannelConfigCache();
  const r = buildAIRequest({}, 'x', [{ role: 'user', content: 'hi' }], true);
  assert.match(r.error, /未配置任何可用模型/);
});

test('buildAIRequest 按选择键取到正确的 URL 与 Key，并轮询多 Key', () => {
  resetChannelConfigCache();
  const env = {
    API_URL_1: 'https://a.com/v1',
    API_KEY_1: 'k1,k2',
    MODEL_1: 'gpt-4o:GPT-4o',
  };
  const r1 = buildAIRequest(env, 'gpt-4o', [{ role: 'user', content: 'hi' }], true);
  assert.equal(r1.apiUrl, 'https://a.com/v1');
  assert.equal(r1.currentApiKey, 'k1');
  assert.deepEqual(r1.channelKeys, ['k1', 'k2']);
  assert.equal(r1.payload.model, 'gpt-4o');
  assert.equal(r1.payload.stream, true);

  const r2 = buildAIRequest(env, 'gpt-4o', [{ role: 'user', content: 'hi' }], true);
  assert.equal(r2.currentApiKey, 'k2', '第二个请求应当轮到第二个 Key');

  const r3 = buildAIRequest(env, 'gpt-4o', [{ role: 'user', content: 'hi' }], true);
  assert.equal(r3.currentApiKey, 'k1', '第三个请求回到第一个 Key');
});

test('buildAIRequest 识别文生图通道并改写 payload', () => {
  resetChannelConfigCache();
  const r = buildAIRequest({
    API_URL_1: 'https://img.com/v1/images/generations',
    API_KEY_1: 'k',
    MODEL_1: 'sensenova-x:文生图',
  }, 'sensenova-x', [{ role: 'user', content: '一只猫' }], false);

  assert.equal(r.isImageAPI, true);
  assert.equal(r.payload.prompt, '一只猫');
  assert.equal(r.payload.watermark, false);
  assert.equal(r.payload.messages, undefined);
});

test('buildAIRequest 对 MAX_TOKENS 做上下限收敛', () => {
  resetChannelConfigCache();
  const base = { API_URL_1: 'https://a.com', API_KEY_1: 'k', MODEL_1: 'm' };
  const msgs = [{ role: 'user', content: 'hi' }];

  // 未配置时用文档默认值 4096
  assert.equal(buildAIRequest(base, 'm', msgs, true).payload.max_tokens, 4096);
  assert.equal(buildAIRequest({ ...base, MAX_TOKENS: '100' }, 'm', msgs, true).payload.max_tokens, 100);
  assert.equal(buildAIRequest({ ...base, MAX_TOKENS: '999999' }, 'm', msgs, true).payload.max_tokens, 32000);
  // 非法值 / 0 / 负数：按「未设置上限」处理，落到 16384（历史行为，保持一致）
  assert.equal(buildAIRequest({ ...base, MAX_TOKENS: 'abc' }, 'm', msgs, true).payload.max_tokens, 16384);
  assert.equal(buildAIRequest({ ...base, MAX_TOKENS: '0' }, 'm', msgs, true).payload.max_tokens, 16384);
  assert.equal(buildAIRequest({ ...base, MAX_TOKENS: '-5' }, 'm', msgs, true).payload.max_tokens, 16384);
});

// v7.12.1 准确率：AGENT_TEMPERATURE 仅对 Agent 步骤（带 tools 参数，含收尾的空数组）生效
test('AGENT_TEMPERATURE 只在带 tools 的请求上生效', () => {
  resetChannelConfigCache();
  const base = { API_URL_1: 'https://a.com', API_KEY_1: 'k', MODEL_1: 'm' };
  const msgs = [{ role: 'user', content: 'hi' }];
  const tools = [{ type: 'function', function: { name: 'get_time', parameters: { type: 'object', properties: {} } } }];

  // 未配置：不发送 temperature（保持与上游默认兼容，o1 等模型不受影响）
  assert.equal(buildAIRequest(base, 'm', msgs, true, tools).payload.temperature, undefined);

  // 配置 0.3：带 tools 的请求携带
  const envT = { ...base, AGENT_TEMPERATURE: '0.3' };
  assert.equal(buildAIRequest(envT, 'm', msgs, true, tools).payload.temperature, 0.3);
  // 收尾作答（传空数组）：同样携带低温采样，但不附加 tools 字段
  const wrap = buildAIRequest(envT, 'm', msgs, true, []);
  assert.equal(wrap.payload.temperature, 0.3);
  assert.equal(wrap.payload.tools, undefined, '空数组不得附加 tools');

  // 普通对话（不传 tools）：不受影响
  assert.equal(buildAIRequest(envT, 'm', msgs, true).payload.temperature, undefined);
  assert.equal(buildAIRequest(envT, 'm', msgs, true, null).payload.temperature, undefined);

  // 非法值（NaN / 超范围）：忽略，不发送
  assert.equal(buildAIRequest({ ...base, AGENT_TEMPERATURE: 'abc' }, 'm', msgs, true, tools).payload.temperature, undefined);
  assert.equal(buildAIRequest({ ...base, AGENT_TEMPERATURE: '-1' }, 'm', msgs, true, tools).payload.temperature, undefined);
  assert.equal(buildAIRequest({ ...base, AGENT_TEMPERATURE: '3' }, 'm', msgs, true, tools).payload.temperature, undefined);
});
