// Web 对话 R2 同步回归测试：假 R2 内存桶（带 etag / onlyIf，真实 exercising CAS）。
// 覆盖：启用条件（未配口令不启用 / 显式关闭）、口令校验、存储键口令派生、
// 清洗上限、合并与墓碑语义、CAS 冲突 409、无 baseEtag 的服务端合并兜底、
// 删除、超大包拒绝，以及前端分片接线（拉取 / 推送 / 删除墓碑）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  handleWebSessions, webSessionsKeyForToken,
  sanitizeSyncSessions, sanitizeSyncDeleted, mergeSyncSessions, parseSyncEnvelope,
} from '../src/web-sessions.js';
import { HTML_CONTENT } from '../src/ui/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PW = 'test-password';

function makeR2(initial = {}) {
  const data = new Map();
  const etags = new Map();
  let seq = 0;
  const bytes = (s) => new TextEncoder().encode(String(s)).byteLength;
  const bump = (key) => { seq += 1; etags.set(key, 'e' + seq); return etags.get(key); };
  for (const [k, v] of Object.entries(initial)) { data.set(k, String(v)); bump(k); }
  return {
    data, etags,
    async get(key, opts) {
      if (!data.has(key)) return null;
      const etag = etags.get(key);
      if (opts && opts.onlyIf && opts.onlyIf.etagMatches && opts.onlyIf.etagMatches !== etag) return null;
      const text = String(data.get(key));
      return { key, size: bytes(text), etag, text: async () => text };
    },
    async put(key, value, opts) {
      if (opts && opts.onlyIf && ((opts.onlyIf.etagMatches && etags.get(key) !== opts.onlyIf.etagMatches)
        || (opts.onlyIf.etagDoesNotMatch === '*' && data.has(key)))) {
        return null;
      }
      data.set(key, String(value));
      return { key, etag: bump(key) };
    },
    async delete(key) { data.delete(key); etags.delete(key); },
    async list() { return { objects: [], truncated: false }; },
  };
}

function env(extra = {}) {
  return Object.assign({ R2: makeR2(), ACCESS_PASSWORD: PW }, extra);
}

function call(e, method, { token = PW, body } = {}) {
  const url = new URL('https://example.com/api/sessions');
  const headers = { 'Content-Type': 'application/json' };
  if (token !== null) headers['X-Access-Token'] = token;
  const req = new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return handleWebSessions(req, e, url);
}

function sess(id, updatedAt, texts) {
  return {
    id, title: '对话 ' + id, model: 'm1', updatedAt,
    messages: (texts || ['你好']).map((t, i) => ({ role: i % 2 ? 'assistant' : 'user', content: t, t: 1000 + i })),
  };
}

// ================= 纯函数 =================

test('webSessionsKeyForToken 由口令派生：同口令同键、异口令异键、键里不含明文口令', async () => {
  const k1 = await webSessionsKeyForToken(PW);
  const k2 = await webSessionsKeyForToken(PW);
  const k3 = await webSessionsKeyForToken('another-password');
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
  assert.match(k1, /^web_sessions\/shared_[0-9a-f]{64}\.json$/);
  assert.ok(!k1.includes(PW));
});

test('sanitizeSyncSessions 丢弃非法会话与非法消息，并执行条数上限', () => {
  const many = Array.from({ length: 60 }, (_, i) => sess('s' + i, 100 + i));
  const out = sanitizeSyncSessions([
    { id: '../bad', title: 'x', messages: [{ role: 'user', content: 'hi' }] },
    { id: 'ok1', title: 't', model: 'm', updatedAt: 5, messages: [
      { role: 'user', content: '问题' },
      { role: 'tool', content: '不该出现的 role' },
      { role: 'assistant', content: 42 },
      { role: 'assistant', content: '回答', personaTrace: 'trace' },
    ] },
    ...many,
  ]);
  assert.equal(out.length, 50);
  assert.equal(out[0].id, 'ok1');
  assert.deepEqual(out[0].messages.map(m => m.content), ['问题', '回答']);
  assert.equal(out[0].messages[1].personaTrace, 'trace');
});

test('sanitizeSyncDeleted 按 id 去重保留最新时间并倒序，上限 200', () => {
  const out = sanitizeSyncDeleted([
    { id: 'a', at: 10 }, { id: 'a', at: 30 }, { id: 'b', at: 20 }, { id: 'bad id!', at: 99 }, { id: 'c', at: 0 },
  ]);
  assert.deepEqual(out, [{ id: 'a', at: 30 }, { id: 'b', at: 20 }]);
});

test('mergeSyncSessions 新版优先、同分取消息多者、墓碑只删不比它新的', () => {
  const local = [sess('s1', 200, ['新版问题', '新版回答']), sess('s2', 100, ['q'])];
  const remote = [sess('s1', 100, ['旧版问题']), sess('s3', 300, ['q3'])];
  const merged = mergeSyncSessions(local, remote, []);
  assert.deepEqual(merged.map(s => s.id), ['s3', 's1', 's2']);
  assert.equal(merged[1].messages.length, 2);
  // 墓碑 at=250：s1(200) 被删，s3(300) 比墓碑新（删后又聊）保留
  const afterDel = mergeSyncSessions(local, remote, [{ id: 's1', at: 250 }, { id: 's3', at: 250 }]);
  assert.deepEqual(afterDel.map(s => s.id), ['s3', 's2']);
});

test('parseSyncEnvelope 坏 JSON 返回空信封，好信封做清洗', () => {
  assert.deepEqual(parseSyncEnvelope('not json'), { sessions: [], deleted: [], updatedAt: 0 });
  assert.deepEqual(parseSyncEnvelope(''), { sessions: [], deleted: [], updatedAt: 0 });
  const ok = parseSyncEnvelope(JSON.stringify({ v: 1, updatedAt: 9, sessions: [sess('s1', 9)], deleted: [{ id: 'x', at: 1 }] }));
  assert.equal(ok.sessions.length, 1);
  assert.equal(ok.updatedAt, 9);
});

// ================= 接口行为 =================

test('未配 ACCESS_PASSWORD 时 GET 报 enabled:false、PUT 403，绝不落 R2', async () => {
  const e = { R2: makeR2() };
  const g = await call(e, 'GET', { token: null });
  assert.equal(g.status, 200);
  assert.equal((await g.json()).enabled, false);
  const p = await call(e, 'PUT', { token: null, body: { sessions: [sess('s1', 1)] } });
  assert.equal(p.status, 403);
  assert.equal(e.R2.data.size, 0);
});

test('WEB_SESSION_SYNC=0 显式关闭时 GET 报 enabled:false', async () => {
  const g = await call(env({ WEB_SESSION_SYNC: '0' }), 'GET');
  assert.equal((await g.json()).enabled, false);
});

test('配了口令但 token 错误时 401', async () => {
  const e = env();
  const bad = await call(e, 'GET', { token: 'wrong' });
  assert.equal(bad.status, 401);
});

test('跨设备接续：同口令的另一台设备 GET 能看到，异口令看到的是另一份空对象', async () => {
  const e = env();
  // 设备 A（无任何设备标识，只带口令）写入
  await call(e, 'PUT', { body: { baseEtag: '', sessions: [sess('fromA', 100, ['手机上问的'])], deleted: [] } });
  // 设备 B：同口令再拉，能看到 A 的会话 —— 这是「换设备继续」成立的关键
  const bBody = await (await call(e, 'GET')).json();
  assert.equal(bBody.sessions.length, 1);
  assert.equal(bBody.sessions[0].messages[0].content, '手机上问的');
  // 异口令：派生键不同，看到的是自己那份空对象，且 R2 里是两个对象
  const other = await call(e, 'GET', { token: 'other-pw' });
  assert.equal(other.status, 401); // token 与 env 口令不一致先被鉴权挡下
  const e2 = env({ ACCESS_PASSWORD: 'other-pw' });
  e2.R2 = e.R2; // 同一个桶、不同口令
  const otherBody = await (await call(e2, 'GET', { token: 'other-pw' })).json();
  assert.equal(otherBody.sessions.length, 0);
  assert.equal(e.R2.data.size, 1); // 只有 A 那一份真正落了对象
});

test('PUT(baseEtag) + GET 往返：数据原样回来且带 etag', async () => {
  const e = env();
  const p = await call(e, 'PUT', { body: { baseEtag: '', sessions: [sess('s1', 111, ['在吗', '在'])], deleted: [] } });
  assert.equal(p.status, 200);
  const pBody = await p.json();
  assert.ok(pBody.etag);
  const g = await call(e, 'GET');
  const gBody = await g.json();
  assert.equal(gBody.enabled, true);
  assert.equal(gBody.etag, pBody.etag);
  assert.equal(gBody.sessions.length, 1);
  assert.equal(gBody.sessions[0].messages[1].content, '在');
});

test('CAS 冲突：拿旧 etag 再 PUT 返回 409 并附服务端现值，拿新 etag 成功', async () => {
  const e = env();
  const p1 = await call(e, 'PUT', { body: { baseEtag: '', sessions: [sess('s1', 1)], deleted: [] } });
  const etag1 = (await p1.json()).etag;
  const stale = await call(e, 'PUT', { body: { baseEtag: '', sessions: [sess('s2', 2)], deleted: [] } });
  assert.equal(stale.status, 409);
  const staleBody = await stale.json();
  assert.equal(staleBody.code, 'SYNC_CONFLICT');
  assert.deepEqual(staleBody.sessions.map(s => s.id), ['s1']);
  const p2 = await call(e, 'PUT', { body: { baseEtag: etag1, sessions: [sess('s1', 1), sess('s2', 2)], deleted: [] } });
  assert.equal(p2.status, 200);
});

test('PUT 不带 baseEtag 时服务端合并，不覆盖别的设备的新会话', async () => {
  const e = env();
  await call(e, 'PUT', { body: { baseEtag: '', sessions: [sess('fromA', 100)], deleted: [] } });
  const p = await call(e, 'PUT', { body: { sessions: [sess('fromB', 200)] } });
  assert.equal(p.status, 200);
  const gBody = await (await call(e, 'GET')).json();
  assert.deepEqual(gBody.sessions.map(s => s.id).sort(), ['fromA', 'fromB']);
});

test('DELETE 后 GET 为空；超大包 PUT 返回 413', async () => {
  const e = env();
  await call(e, 'PUT', { body: { baseEtag: '', sessions: [sess('s1', 1)], deleted: [] } });
  const d = await call(e, 'DELETE');
  assert.equal(d.status, 200);
  const gBody = await (await call(e, 'GET')).json();
  assert.equal(gBody.sessions.length, 0);
  const big = await call(e, 'PUT', { body: { sessions: [sess('big', 1, ['x'.repeat(4000001)])] } });
  assert.equal(big.status, 413);
});

// ================= 前端接线 =================

test('前端分片已接同步：启动拉取、保存防抖推送、删除记墓碑、设置页填口令后重试', () => {
  assert.ok(HTML_CONTENT.includes('pullSyncSessions()'), 'init 未调用 pullSyncSessions');
  assert.ok(HTML_CONTENT.includes("fetch('/api/sessions'"), '页面未引用 /api/sessions');
  assert.ok(!HTML_CONTENT.includes('cfchat_client_id'), '页面不应再生成 per-device clientId（会让每台设备写到不同对象）');
  const dialogs = fs.readFileSync(path.join(ROOT, 'src/ui/app-dialogs.js'), 'utf8');
  assert.ok(dialogs.includes('noteSessionDeleted(id)'), '删除会话未记墓碑');
  const settings = fs.readFileSync(path.join(ROOT, 'src/ui/app-settings.js'), 'utf8');
  assert.ok(settings.includes('pullSyncSessions'), '设置页保存口令后未重试同步');
});
