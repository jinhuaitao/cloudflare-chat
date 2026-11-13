// 跨模块一致性回归（v7.15.1）
//
// 为什么单独一个文件：人格从 7 位扩到 12 位时，代码本身没问题，但 Telegram 帮助、
// 微信菜单、网页按钮提示、README 表格、package.json 描述各自留着一份手写枚举，
// 于是出现了「后端 12 位、页面写 7 位」「README 用 👀、机器人显示 🧐」这类
// 既不影响测试也不报错、但用户一眼就能看出的错位。
//
// 这里把「同一件事只应有一个来源」钉成断言：
//   1) 短名表必须是注册表的完整映射（新增角色漏写会红）；
//   2) 三端文案函数必须覆盖全部角色；
//   3) README 的人格表必须与注册表逐行一致（emoji / 名称 / id / 步数 / 预算）；
//   4) 源码与元数据里不再出现写死的过期数量。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PERSONAS, PERSONA_IDS, PERSONA_COUNT, PERSONA_SHORT, DEFAULT_PERSONA_ID,
  specialistPersonas, personaCatalogText, personaIdListText, personaFullListText, formatPersonaList,
} from '../src/agent/personas.js';
import { AGENT_TOOL_COUNT, getAgentTools } from '../src/agent/tools.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function walkJs(dir) {
  const out = [];
  for (const f of fs.readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, f);
    const st = fs.statSync(path.join(ROOT, rel));
    if (st.isDirectory()) out.push(...walkJs(rel));
    else if (f.endsWith('.js')) out.push(rel);
  }
  return out;
}

// ==================== 注册表自身的完整性 ====================

test('短名表与注册表严格对齐：不漏角色、不多条目、不重名', () => {
  assert.equal(PERSONA_COUNT, PERSONAS.length);
  assert.equal(PERSONA_COUNT, PERSONA_IDS.length);

  const shortKeys = Object.keys(PERSONA_SHORT).sort();
  assert.deepEqual(shortKeys, PERSONA_IDS.slice().sort(),
    '短名表的 key 必须恰好等于人格 id 集合（新增角色时记得补短名）');

  const values = Object.values(PERSONA_SHORT);
  assert.equal(new Set(values).size, values.length, '短名不能重复，否则列表里两个角色长得一样');
  for (const [id, short] of Object.entries(PERSONA_SHORT)) {
    assert.ok(String(short).trim().length >= 2, id + ' 的短名太短，无法用于文案');
    assert.ok(String(short).length <= 4, id + ' 的短名过长，会撑坏一行式提示');
  }
});

test('通用人格是回落项，不混进「可选专家」枚举', () => {
  const specialists = specialistPersonas();
  assert.equal(specialists.length, PERSONA_COUNT - 1);
  assert.ok(!specialists.some(p => p.id === DEFAULT_PERSONA_ID));
});

// ==================== 派生文案覆盖全量 ====================

test('三端共用的文案函数覆盖全部角色', () => {
  const catalog = personaCatalogText('/');
  for (const p of specialistPersonas()) {
    assert.ok(catalog.includes(PERSONA_SHORT[p.id]), '目录短名缺少 ' + p.id);
  }
  assert.ok(!catalog.includes(PERSONA_SHORT[DEFAULT_PERSONA_ID]), '通用助手不该出现在可选目录里');

  const ids = personaIdListText('｜');
  for (const p of specialistPersonas()) {
    assert.ok(ids.includes(p.id), '/agent <id> 取值说明缺少 ' + p.id);
  }

  const full = personaFullListText(' / ');
  for (const p of PERSONAS) {
    assert.ok(full.includes(p.emoji + ' ' + p.name), '完整列表缺少 ' + p.id);
  }
});

test('formatPersonaList 报出的总数与实际角色数一致', () => {
  const text = formatPersonaList('auto');
  assert.ok(text.includes('共 ' + PERSONA_COUNT + ' 个'), '列表标题的计数没有跟着注册表走');
  for (const p of PERSONAS) {
    assert.ok(text.includes(p.name), '列表缺少 ' + p.id);
  }
  // 固定态要有 ✅ 标记，且只标记一个
  const pinned = formatPersonaList('ops');
  assert.equal((pinned.match(/✅/g) || []).length, 1);
  assert.ok(pinned.includes('🛠️ 运维排障'));
});

// ==================== 工具数量同源 ====================

test('工具总数由定义表派生，且通用人格拿到全量', () => {
  const all = getAgentTools(false);
  assert.equal(all.length, AGENT_TOOL_COUNT, 'AGENT_TOOL_COUNT 与真实工具数脱节');
  assert.equal(getAgentTools(false, { persona: PERSONAS.find(p => p.id === DEFAULT_PERSONA_ID) }).length,
    AGENT_TOOL_COUNT, '通用人格不应被裁剪');
  assert.ok(AGENT_TOOL_COUNT >= 19, '工具被意外删减：' + AGENT_TOOL_COUNT);
});

// ==================== README 与注册表逐行一致 ====================

// | 🔬 研究员 | `research` | 适合 | 工作方式 | 8 / 32K |
const ROW_RE = /^\|\s*([^|]+?)\s*\|\s*`([a-z]+)`\s*\|[^|]*\|[^|]*\|\s*(\d+)\s*\/\s*(\d+)K\s*\|$/;

test('README 人格表与注册表逐行一致（emoji / 名称 / id / 步数 / 预算）', () => {
  const rows = read('README.md').split('\n')
    .map(line => line.match(ROW_RE))
    .filter(Boolean)
    .map(m => ({ label: m[1].trim(), id: m[2], steps: Number(m[3]), ctxK: Number(m[4]) }));

  assert.equal(rows.length, PERSONA_COUNT, 'README 人格表行数与实际角色数不一致');
  // 表格把通用助手放在最后一行（回落项），专业角色的顺序必须与注册表一致
  assert.deepEqual(rows.map(r => r.id).filter(id => id !== DEFAULT_PERSONA_ID),
    specialistPersonas().map(p => p.id), 'README 人格表的角色顺序与注册表不一致');
  assert.deepEqual(rows.map(r => r.id).slice().sort(), PERSONA_IDS.slice().sort(),
    'README 人格表缺少或多出了角色');

  for (const row of rows) {
    const p = PERSONAS.find(x => x.id === row.id);
    // emoji 差一个字符，用户在文档与机器人之间就会看到两个不同的角色
    assert.equal(row.label, p.emoji + ' ' + p.name, row.id + ' 的 emoji/名称与注册表不一致');
    assert.equal(row.steps, p.maxSteps, row.id + ' 的步数与注册表不一致');
    assert.equal(row.ctxK * 1000, p.ctxBudget, row.id + ' 的上下文预算与注册表不一致');
  }
});

test('README 核心特性行的角色目录与注册表一致', () => {
  // 这一行曾经是一份独立的 emoji 枚举（🧩 产品 / 👀 审查 / 🌐 翻译 / 📅 规划），
  // 扩容后没跟着注册表走。现在改成纯短名列表，并由测试比对顺序与内容。
  const line = read('README.md').split('\n').find(l => l.startsWith('| 🧭 **专家人格'));
  assert.ok(line, 'README 缺少「专家人格」核心特性行');
  const cell = line.split('|')[2] || '';
  const list = cell.split('；')[0].trim().split(' / ').map(s => s.trim());
  const expected = [...specialistPersonas().map(p => PERSONA_SHORT[p.id]), PERSONA_SHORT[DEFAULT_PERSONA_ID]];
  assert.deepEqual(list, expected, '核心特性行的角色目录与注册表不一致');
});

// ==================== 不留写死的过期数量 ====================

test('源码与元数据里的数量文案都与注册表一致', () => {
  const targets = [...walkJs('src'), '_worker.js', 'package.json', 'README.md'];
  const personaRe = /(\d+)\s*位(?:专家|人格)/g;
  const toolRe = /(\d+)\s*项[^，。\n]{0,12}?工具/g;
  const stale = [];

  for (const rel of targets) {
    const text = read(rel);
    for (const [re, expected] of [[personaRe, PERSONA_COUNT], [toolRe, AGENT_TOOL_COUNT]]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (Number(m[1]) !== expected) stale.push(rel + ' → 「' + m[0] + '」（应为 ' + expected + '）');
      }
    }
  }
  assert.deepEqual(stale, [], '这些文案里的数字已经过期，改成从注册表派生：\n' + stale.join('\n'));
});
