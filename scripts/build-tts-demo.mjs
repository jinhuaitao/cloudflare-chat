// 生成 tts-demo.html：把 src/ui/speech.js 的朗读清洗实现注入演示页模板。
//
// 为什么需要这个脚本：tts-demo.html 曾经手抄了一份 cleanForSpeech，
// 于是规则一改，演示页与线上页面就各说各话。现在演示页是「产物」，
// 源码在 scripts/tts-demo.template.html，注入内容是 src/ui/speech.js 的原文。
// test/ui.test.mjs 会断言磁盘上的 tts-demo.html 与重新生成的结果一致 —— 忘记跑这个脚本会直接测试失败。
//
// 用法：npm run build:tts-demo

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { CLEAN_FOR_SPEECH_SRC, CONTAINS_CJK_SRC } from '../src/ui/speech.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_PATH = path.join(ROOT, 'scripts', 'tts-demo.template.html');
const OUTPUT_PATH = path.join(ROOT, 'tts-demo.html');
const PLACEHOLDER = '{{SPEECH_SRC}}';

// 纯函数：模板 + 源码 → 最终 HTML。测试直接用这个函数比对，不需要写盘。
function renderTtsDemo(template) {
  const src = CLEAN_FOR_SPEECH_SRC + '\n\n' + CONTAINS_CJK_SRC;
  return String(template).split(PLACEHOLDER).join(src);
}

async function build() {
  const template = await readFile(TEMPLATE_PATH, 'utf8');
  const html = renderTtsDemo(template);
  await writeFile(OUTPUT_PATH, html, 'utf8');
  return { path: OUTPUT_PATH, bytes: Buffer.byteLength(html) };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  build()
    .then(({ path: p, bytes }) => {
      console.log('已生成 ' + path.relative(ROOT, p) + '（' + bytes + ' 字节）');
    })
    .catch((e) => {
      console.error('生成失败：' + (e && e.message ? e.message : e));
      process.exitCode = 1;
    });
}

export { renderTtsDemo, build, TEMPLATE_PATH, OUTPUT_PATH, PLACEHOLDER };
