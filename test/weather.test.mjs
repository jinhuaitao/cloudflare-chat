// 天气卡片固定版式回归测试（v7.9.1）
// 目的：天气回答的排版一旦被改动就立刻发现 —— 用户要的是「固定、详细、好看」，
// 所以这里断言的是版式结构（分隔线、区块、字段），而不只是"能返回内容"。

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildWeatherCard, weatherIcon, weatherText, windDirName, dayLabel, weatherTips, isSnowCode } from '../src/agent/tools-local.js';

const LOC = { name: '北京', country: '中国' };
const SAMPLE = {
  current: {
    time: '2026-11-02T10:15',
    temperature_2m: 12.4, relative_humidity_2m: 38, apparent_temperature: 10.1,
    weather_code: 1, wind_speed_10m: 14.2, wind_direction_10m: 135, is_day: 1, precipitation: 0,
  },
  daily: {
    time: ['2026-11-02', '2026-11-03', '2026-11-04'],
    weather_code: [1, 2, 61],
    temperature_2m_max: [16.2, 18.9, 13.1],
    temperature_2m_min: [4.1, 6.8, 5.2],
    sunrise: ['2026-11-02T06:47', '2026-11-03T06:48', '2026-11-04T06:49'],
    sunset: ['2026-11-02T17:12', '2026-11-03T17:11', '2026-11-04T17:10'],
    precipitation_probability_max: [0, 10, 70],
    uv_index_max: [3.2, 3.5, 1.8],
  },
};

test('天气卡片包含固定区块：地点 / 更新时间 / 分隔线 / 实况 / 三天 / 提示', () => {
  const card = buildWeatherCard(LOC, SAMPLE);
  assert.ok(card.startsWith('🌤️ 北京 · 中国'), '首行应为图标 + 地点');
  assert.ok(card.includes('🕐 2026-11-02 10:15 更新'));
  assert.ok(card.includes('━━━━━━━━━━━━━━'), '缺少分隔线');
  assert.ok(card.includes('🌡️ 现在 12°C'), '缺少当前温度');
  assert.ok(card.includes('大致晴'), '缺少天气描述');
  assert.ok(card.includes('体感 10°C'));
  assert.ok(card.includes('💧 湿度 38%'));
  assert.ok(card.includes('东南风 14 km/h'), '风向应换算成中文方位');
  assert.ok(card.includes('☀️ 紫外线 3（中等）'));
  assert.ok(card.includes('🌅 日出 06:47'));
  assert.ok(card.includes('🌇 日落 17:12'));
  assert.ok(card.includes('📅 未来三天'));
  assert.ok(card.includes('💡 '), '缺少生活提示');
});

test('三天预报每天一行，含日期标签、温度区间与降水概率', () => {
  const card = buildWeatherCard(LOC, SAMPLE);
  const lines = card.split('\n');
  const start = lines.findIndex(l => l.includes('📅 未来三天'));
  assert.ok(start > 0);
  const days = lines.slice(start + 1).filter(l => /今天|明天|后天/.test(l));
  assert.equal(days.length, 3);
  assert.ok(days[0].includes('今天 11/02 周一'));
  assert.ok(days[0].includes('4° ~ 16°'));
  assert.ok(days[0].includes('降水 0%'));
  assert.ok(days[2].includes('后天 11/04 周三'));
  assert.ok(days[2].includes('降水 70%'));
});

test('有降水时在实况第二行补降水量，无降水则整段省略', () => {
  const wet = buildWeatherCard(LOC, {
    current: { ...SAMPLE.current, weather_code: 95, precipitation: 4.2, is_day: 0 },
    daily: SAMPLE.daily,
  });
  const line = wet.split('\n').find(l => l.includes('湿度'));
  assert.ok(line.includes('🌧️ 降水 4.2 mm'), '降水 > 0 时应显示降水量');
  assert.ok(wet.startsWith('⛈️ 北京 · 中国'), '夜间雷阵雨应用雷阵雨图标');

  // 0 降水不显示「降水 0 mm」，避免每张卡片都多一段噪音
  const dry = buildWeatherCard(LOC, SAMPLE);
  assert.equal(dry.includes('降水 0 mm'), false);
});

test('雪天用雪的图标与提示口径，「带伞」不用于下雪', () => {
  assert.equal(isSnowCode(75), true);
  assert.equal(isSnowCode(61), false);

  const snow = {
    current: { time: '2026-11-02T07:05', temperature_2m: -6.4, apparent_temperature: -11.2,
      relative_humidity_2m: 72, weather_code: 75, wind_speed_10m: 22,
      wind_direction_10m: 315, is_day: 1, precipitation: 1.8 },
    daily: { time: ['2026-11-02', '2026-11-03'], weather_code: [75, 71],
      temperature_2m_max: [-3, 1], temperature_2m_min: [-13, -9],
      precipitation_probability_max: [85, 40], uv_index_max: [1, 2],
      sunrise: ['2026-11-02T06:31'], sunset: ['2026-11-02T16:21'] },
  };
  const card = buildWeatherCard({ name: '哈尔滨' }, snow);
  assert.ok(card.includes('❄️ 降水 1.8 mm'), '降雪应使用雪花图标而非雨滴');
  assert.ok(card.includes('出门注意保暖防滑'));
  assert.equal(card.includes('带伞'), false);

  // 雨天仍然用雨滴图标与带伞提示
  const rain = buildWeatherCard(LOC, {
    current: { ...SAMPLE.current, weather_code: 63, precipitation: 3.1 },
    daily: { ...SAMPLE.daily, weather_code: [63, 61, 3], precipitation_probability_max: [80, 40, 10] },
  });
  assert.ok(rain.includes('🌧️ 降水 3.1 mm'));
  assert.ok(rain.includes('出门记得带伞'));
});

test('版式只用纯文本，不含 Markdown 表格或加粗符号（微信端会原样显示）', () => {
  const card = buildWeatherCard(LOC, SAMPLE);
  assert.equal(card.includes('**'), false);
  assert.equal(card.includes('|'), false);
  assert.equal(card.includes('---|'), false);
});

test('夜间用夜间图标，白天用日间图标', () => {
  assert.equal(weatherIcon(0, 1), '☀️');
  assert.equal(weatherIcon(0, 0), '🌙');
  assert.equal(weatherIcon(2, 0), '☁️');
  assert.equal(weatherIcon(999, 1), '🌡️', '未知天气码要有兜底图标');
});

test('天气码映射到中文描述', () => {
  assert.equal(weatherText(0), '晴');
  assert.equal(weatherText(61), '小雨');
  assert.equal(weatherText(95), '雷阵雨');
  assert.equal(weatherText(999), '未知天气');
});

test('风向度数换算成八方位', () => {
  assert.equal(windDirName(0), '北风');
  assert.equal(windDirName(45), '东北风');
  assert.equal(windDirName(135), '东南风');
  assert.equal(windDirName(180), '南风');
  assert.equal(windDirName(270), '西风');
  assert.equal(windDirName(359), '北风', '接近 360 度应回到北风');
  assert.equal(windDirName(undefined), '');
});

test('日期标签带今天/明天/后天与星期', () => {
  assert.equal(dayLabel('2026-11-02', 0), '今天 11/02 周一');
  assert.equal(dayLabel('2026-11-03', 1), '明天 11/03 周二');
  assert.equal(dayLabel('2026-11-04', 2), '后天 11/04 周三');
  assert.equal(dayLabel('2026-11-05', 3), '11/05 周四', '超出三天不加前缀');
});

test('生活提示按降水 / 温差 / 紫外线 / 极端温度生成', () => {
  const rain = weatherTips({ temperature_2m: 20 }, {
    temperature_2m_max: [22], temperature_2m_min: [18],
    precipitation_probability_max: [80], uv_index_max: [2],
  });
  assert.ok(rain[0].includes('带伞'));

  const swing = weatherTips({ temperature_2m: 15 }, {
    temperature_2m_max: [24], temperature_2m_min: [8],
    precipitation_probability_max: [0], uv_index_max: [2],
  });
  assert.ok(swing[0].includes('昼夜温差 16°'));

  const uv = weatherTips({ temperature_2m: 25 }, {
    temperature_2m_max: [28], temperature_2m_min: [22],
    precipitation_probability_max: [0], uv_index_max: [8.4],
  });
  assert.ok(uv[0].includes('防晒'));

  const hot = weatherTips({ temperature_2m: 36 }, {});
  assert.ok(hot[0].includes('补水'));

  const cold = weatherTips({ temperature_2m: -5 }, {});
  assert.ok(cold[0].includes('保暖'));

  // 最多两条，避免提示区喧宾夺主
  const many = weatherTips({ temperature_2m: 34 }, {
    temperature_2m_max: [38], temperature_2m_min: [26],
    precipitation_probability_max: [90], uv_index_max: [10],
  });
  assert.ok(many.length <= 2);
});

test('数据缺失时降级而不抛错', () => {
  // 连 current 都没有：只剩抬头、分隔线与兜底提示，不出现「现在 未知天气」这种怪句子
  const empty = buildWeatherCard({ name: '某地' }, {});
  assert.ok(empty.includes('某地'));
  assert.ok(empty.includes('━━━━━━━━━━━━━━'));
  assert.equal(empty.includes('现在'), false, '实况字段全缺时整行省略');
  assert.ok(empty.includes('💡 '), '仍应给出一句兜底提示');

  const noDaily = buildWeatherCard(LOC, { current: { temperature_2m: 5, weather_code: 3 } });
  assert.ok(noDaily.includes('5°C'));
  assert.ok(noDaily.includes('阴'));
  assert.equal(noDaily.includes('📅 未来三天'), false, '没有预报数据就不该出现三天区块');
});

test('多城市天气用空行分隔，每城一张卡片', async () => {
  // 直接验证卡片之间拼接方式（toolGetWeather 用 \n\n 连接）
  const a = buildWeatherCard({ name: '北京' }, SAMPLE);
  const b = buildWeatherCard({ name: '上海' }, SAMPLE);
  const joined = [a, b].join('\n\n');
  assert.equal(joined.split('\n\n').filter(s => s.includes('━━━━')).length, 2);
});
