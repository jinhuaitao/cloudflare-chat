import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Coordination,
  acquireCoordinationLease,
  renewCoordinationLease,
  releaseCoordinationLease,
  withCoordinationLock,
} from '../src/coordination.js';

function request(action, owner, leaseMs = 30000) {
  return new Request('https://coordination.internal/lease', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, owner, leaseMs }),
  });
}

function fakeState() {
  const values = new Map();
  let tail = Promise.resolve();
  return {
    storage: {
      async get(key) { return values.get(key); },
      async put(key, value) {
        await new Promise(resolve => setTimeout(resolve, 2));
        values.set(key, value);
      },
      async delete(key) { values.delete(key); },
    },
    blockConcurrencyWhile(fn) {
      const result = tail.then(fn, fn);
      tail = result.then(() => {}, () => {});
      return result;
    },
  };
}

test('Durable Object 租约只允许一个持有者，续租和释放校验 owner', async () => {
  const coordination = new Coordination(fakeState());
  const first = await (await coordination.fetch(request('acquire', 'owner-a'))).json();
  const second = await (await coordination.fetch(request('acquire', 'owner-b'))).json();
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.owner, 'owner-a');

  assert.equal((await (await coordination.fetch(request('renew', 'owner-b'))).json()).ok, false);
  assert.equal((await (await coordination.fetch(request('release', 'owner-b'))).json()).ok, false);
  assert.equal((await (await coordination.fetch(request('renew', 'owner-a'))).json()).ok, true);
  assert.equal((await (await coordination.fetch(request('release', 'owner-a'))).json()).ok, true);
  assert.equal((await (await coordination.fetch(request('acquire', 'owner-b'))).json()).ok, true);
});

test('Durable Object 串行化并发 acquire，不发生双持锁', async () => {
  const coordination = new Coordination(fakeState());
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    coordination.fetch(request('acquire', `owner-${i}`)).then(r => r.json())));
  assert.equal(results.filter(r => r.ok).length, 1);
});

test('过期租约可以被新持有者接管', async () => {
  const state = fakeState();
  await state.storage.put('lease', { owner: 'expired', expires: Date.now() - 1 });
  const coordination = new Coordination(state);
  const result = await (await coordination.fetch(request('acquire', 'next'))).json();
  assert.equal(result.ok, true);
  assert.equal(result.owner, 'next');
});

test('本地回退锁互斥执行且可重入获取同一 owner', async () => {
  const name = `local-${Date.now()}-${Math.random()}`;
  let active = 0;
  let maxActive = 0;
  await Promise.all(Array.from({ length: 5 }, () => withCoordinationLock({}, name, async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
  })));
  assert.equal(maxActive, 1);

  const lease = await acquireCoordinationLease({}, name, 'owner');
  assert.equal(lease.ok, true);
  assert.equal((await acquireCoordinationLease({}, name, 'owner')).ok, true);
  assert.equal(await renewCoordinationLease({}, name, 'other'), false);
  assert.equal(await releaseCoordinationLease({}, name, 'other'), false);
  assert.equal(await releaseCoordinationLease({}, name, 'owner'), true);
});

test('等待锁超时返回明确错误', async () => {
  const name = `timeout-${Date.now()}-${Math.random()}`;
  await acquireCoordinationLease({}, name, 'holder');
  await assert.rejects(
    withCoordinationLock({}, name, async () => {}, { waitMs: 0 }),
    /等待协调锁超时/,
  );
  await releaseCoordinationLease({}, name, 'holder');
});
