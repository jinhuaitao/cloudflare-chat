const DEFAULT_LEASE_MS = 30000;
const DEFAULT_WAIT_MS = 15000;
const LOCAL_LEASE_MAX = 2000;
const localLeases = new Map();

function leaseOptions(options = {}) {
  const leaseMs = Math.min(10 * 60 * 1000, Math.max(1000, Number(options.leaseMs) || DEFAULT_LEASE_MS));
  const waitMs = Math.min(60000, Math.max(0, Number.isFinite(options.waitMs) ? options.waitMs : DEFAULT_WAIT_MS));
  return { leaseMs, waitMs };
}

function makeOwner() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function localAcquire(name, owner, leaseMs) {
  const now = Date.now();
  if (localLeases.size >= LOCAL_LEASE_MAX) {
    for (const [key, lease] of localLeases) {
      if (lease.expires <= now) localLeases.delete(key);
    }
  }
  const current = localLeases.get(name);
  if (current && current.expires > now && current.owner !== owner) {
    return { ok: false, owner: current.owner, expires: current.expires };
  }
  const lease = { ok: true, owner, expires: now + leaseMs };
  localLeases.set(name, lease);
  return lease;
}

function localRenew(name, owner, leaseMs) {
  const current = localLeases.get(name);
  if (!current || current.owner !== owner || current.expires <= Date.now()) return false;
  current.expires = Date.now() + leaseMs;
  return true;
}

function localRelease(name, owner) {
  const current = localLeases.get(name);
  if (!current || current.owner !== owner) return false;
  localLeases.delete(name);
  return true;
}

async function leaseRequest(env, name, action, owner, leaseMs) {
  const id = env.COORDINATOR.idFromName(name);
  const stub = env.COORDINATOR.get(id);
  const response = await stub.fetch('https://coordination.internal/lease', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, owner, leaseMs }),
  });
  if (!response.ok) throw new Error(`协调锁请求失败（HTTP ${response.status}）`);
  return await response.json();
}

async function acquireCoordinationLease(env, name, owner, options = {}) {
  if (!env || !env.COORDINATOR) return localAcquire(name, owner, leaseOptions(options).leaseMs);
  return await leaseRequest(env, name, 'acquire', owner, leaseOptions(options).leaseMs);
}

async function renewCoordinationLease(env, name, owner, options = {}) {
  if (!env || !env.COORDINATOR) return localRenew(name, owner, leaseOptions(options).leaseMs);
  const result = await leaseRequest(env, name, 'renew', owner, leaseOptions(options).leaseMs);
  return result.ok === true;
}

async function releaseCoordinationLease(env, name, owner) {
  if (!env || !env.COORDINATOR) return localRelease(name, owner);
  const result = await leaseRequest(env, name, 'release', owner, DEFAULT_LEASE_MS);
  return result.ok === true;
}

async function withCoordinationLock(env, name, fn, options = {}) {
  const { leaseMs, waitMs } = leaseOptions(options);
  const owner = options.owner || makeOwner();
  const deadline = Date.now() + waitMs;
  let lease;
  for (;;) {
    lease = await acquireCoordinationLease(env, name, owner, { leaseMs });
    if (lease.ok) break;
    if (Date.now() >= deadline) throw new Error(`等待协调锁超时：${name}`);
    await new Promise(resolve => setTimeout(resolve, 40 + Math.floor(Math.random() * 40)));
  }

  let lost = false;
  let stopped = false;
  let renewing = null;
  const heartbeat = setInterval(() => {
    if (stopped || renewing) return;
    renewing = (async () => {
      try {
        if (!await renewCoordinationLease(env, name, owner, { leaseMs })) lost = true;
      } catch (_) {
        lost = true;
      }
    })().finally(() => { renewing = null; });
  }, Math.max(500, Math.floor(leaseMs / 3)));
  try {
    const result = await fn(owner);
    if (renewing) await renewing;
    if (lost) throw new Error(`协调锁已丢失：${name}`);
    return result;
  } finally {
    stopped = true;
    clearInterval(heartbeat);
    if (renewing) await renewing;
    await releaseCoordinationLease(env, name, owner).catch(() => {});
  }
}

class Coordination {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    return await this.state.blockConcurrencyWhile(async () => {
      try {
        const body = await request.json();
        const owner = typeof body.owner === 'string' ? body.owner : '';
        const leaseMs = Math.min(10 * 60 * 1000, Math.max(1000, Number(body.leaseMs) || DEFAULT_LEASE_MS));
        if (!owner || owner.length > 128 || !['acquire', 'renew', 'release'].includes(body.action)) {
          return Response.json({ ok: false, error: 'invalid lease request' }, { status: 400 });
        }
        const now = Date.now();
        const current = await this.state.storage.get('lease');
        const held = current && current.owner !== owner && current.expires > now;

        if (body.action === 'acquire') {
          if (held) return Response.json({ ok: false, owner: current.owner, expires: current.expires });
          const lease = { owner, expires: now + leaseMs };
          await this.state.storage.put('lease', lease);
          return Response.json({ ok: true, ...lease });
        }

        const owns = current && current.owner === owner && current.expires > now;
        if (!owns) return Response.json({ ok: false, owner: current?.owner || null, expires: current?.expires || 0 });
        if (body.action === 'renew') {
          const lease = { owner, expires: now + leaseMs };
          await this.state.storage.put('lease', lease);
          return Response.json({ ok: true, ...lease });
        }
        await this.state.storage.delete('lease');
        return Response.json({ ok: true });
      } catch (_) {
        return Response.json({ ok: false, error: 'invalid lease request' }, { status: 400 });
      }
    });
  }
}

export {
  Coordination,
  acquireCoordinationLease,
  renewCoordinationLease,
  releaseCoordinationLease,
  withCoordinationLock,
};
