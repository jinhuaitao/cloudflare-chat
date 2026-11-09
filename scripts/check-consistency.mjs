// 发版前一致性检查（零依赖，纯 Node 内置模块）：
//   1) 版本号三处对齐：package.json ↔ src/constants.js(APP_VERSION) ↔ README.md 标题
//   2) 全量语法检查：node --check 扫过 _worker.js / src/**/*.js / scripts/*.mjs
//   3) tts-demo.html 与 scripts/tts-demo.template.html + src/ui/speech.js 重新生成的结果一致
//   4) README 宣称的用例数与 node --test 实际跑出的数量一致
//
// 背景：v7.12 曾出现 README 标 v7.13.0、宣称 283 用例，而代码与实测分别是 7.12.0 / 224 ——
// 文档与代码脱节只能靠人眼发现。这个脚本把它变成一条命令。
//
// 用法：npm run check（本地约 10 秒，其中 7 秒是第 4 项跑测试套件）

import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderTtsDemo } from './build-tts-demo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const failures = [];
function ok(msg) { console.log('  ✓ ' + msg); }
function fail(msg) { failures.push(msg); console.error('  ✗ ' + msg); }

async function readRoot(rel) {
  return readFile(path.join(ROOT, rel), 'utf8');
}

// ---------- 1) 版本号三处对齐 ----------
async function checkVersions() {
  console.log('[1/4] 版本号一致性');
  const pkg = JSON.parse(await readRoot('package.json'));
  const constantsSrc = await readRoot('src/constants.js');
  const readme = await readRoot('README.md');

  const appVersion = (constantsSrc.match(/APP_VERSION\s*=\s*'([^']+)'/) || [])[1];
  const readmeVersion = (readme.match(/# ⚡ Cloudflare-Chat `v(\d+\.\d+\.\d+)`/) || [])[1];

  if (!appVersion) return fail('src/constants.js 里没解析到 APP_VERSION（正则失配？）');
  if (!readmeVersion) return fail('README.md 标题里没解析到 vX.Y.Z 版本号');
  if (pkg.version !== appVersion) {
    fail(`package.json(${pkg.version}) 与 src/constants.js(${appVersion}) 版本号不一致`);
  } else {
    ok(`package.json = constants.js = ${pkg.version}`);
  }
  if (readmeVersion !== appVersion) {
    fail(`README.md(v${readmeVersion}) 与 src/constants.js(${appVersion}) 版本号不一致`);
  } else {
    ok(`README.md 标题同为 v${readmeVersion}`);
  }
}

// ---------- 2) 全量语法检查 ----------
async function checkSyntax() {
  console.log('[2/4] 语法检查（node --check）');
  const files = [path.join(ROOT, '_worker.js')];

  async function walk(dir) {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (ent.name.endsWith('.js') || ent.name.endsWith('.mjs')) files.push(p);
    }
  }

  await walk(path.join(ROOT, 'src'));
  await walk(path.join(ROOT, 'scripts'));

  let bad = 0;
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) {
      bad++;
      fail(`语法错误：${path.relative(ROOT, f)}\n${(r.stderr || '').trim()}`);
    }
  }
  if (!bad) ok(`${files.length} 个模块全部通过 node --check`);
}

// ---------- 3) tts-demo.html 同步 ----------
async function checkTtsDemo() {
  console.log('[3/4] tts-demo.html 与源码同步');
  const template = await readRoot('scripts/tts-demo.template.html');
  const expected = renderTtsDemo(template);
  const actual = await readRoot('tts-demo.html');
  if (expected === actual) {
    ok('演示页与 template + speech.js 一致');
  } else {
    fail('tts-demo.html 过期（改了 src/ui/speech.js 或模板后请跑 npm run build:tts-demo）');
  }
}

// ---------- 4) README 用例数 = 实测用例数 ----------
function checkTestCount() {
  console.log('[4/4] README 用例数与实测一致');
  return (async () => {
    const readme = await readRoot('README.md');
    const claimed = (readme.match(/npm test\s+# (\d+) 个用例/) || [])[1];
    if (!claimed) return fail('README 里没解析到「npm test  # N 个用例」');

    // 与 package.json 的 test 脚本同款调用，加 tap 报告器方便机器解析
    const r = spawnSync(
      process.execPath,
      ['--test', '--test-reporter=tap', 'test/**/*.test.mjs'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
    );
    const m = (r.stdout || '').match(/^# tests (\d+)$/m);
    const actual = m ? m[1] : null;
    if (r.status !== 0) return fail('测试套件未全部通过（先修失败用例，再核对用例数）');
    if (!actual) return fail('没从 tap 输出解析到用例总数（报告器格式变了？）');
    if (claimed !== actual) {
      fail(`README 宣称 ${claimed} 个用例，实测 ${actual} 个 —— 请更新 README`);
    } else {
      ok(`README 宣称与实测一致：${actual} 个用例`);
    }
  })();
}

const [v, s, t] = await Promise.all([checkVersions(), checkSyntax(), checkTtsDemo()]);
await checkTestCount();

console.log('');
if (failures.length) {
  console.error(`一致性检查未通过（${failures.length} 处问题）：`);
  for (const f of failures) console.error('  - ' + f.split('\n')[0]);
  process.exitCode = 1;
} else {
  console.log('一致性检查全部通过 ✓');
}
