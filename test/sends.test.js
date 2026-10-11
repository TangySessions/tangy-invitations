// Send claiming, idempotency and concurrency — run against SQLite by default
// and against PostgreSQL with `npm run test:pg` (same tests, same
// expectations). Resend is a stubbed fetch; nothing leaves the machine.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { existingDecision, sameAttempt, STALE_PENDING_MS } from '../src/store/sendClaim.js';
import { loadDatabaseConfig, poolOptions, safeDbError, parseDatabaseUrl } from '../src/store/pgConfig.js';
import { listMigrations, APPROVED_MIGRATION_VERSION } from '../src/store/pgMigrate.js';
import { MIN_SCHEMA_VERSION, MAX_SCHEMA_VERSION, CAMPAIGNS_SCHEMA_VERSION } from '../src/store/postgres.js';
import { makeTestStore, PG } from './helpers/testStore.js';

const ORIGIN = 'http://app.test';
const PASSWORD = 'correct horse battery staple';
const SECRET = randomBytes(32).toString('base64url');
const TEMPLATE = { name: 'Claims', subject: 'Hi {{recipient_name}}', html: '<html><head></head><body><p>Hi {{recipient_name}}</p></body></html>', text: '' };
const silent = { info() {}, error() {} };
let hash;
const stores = [];
after(async () => { for (const s of stores) await s.close(); });

// Resend stub whose responses can be held open to create real overlap.
function resendStub() {
  const calls = [];
  let gate = null;
  const stub = {
    calls,
    hold() { let release; gate = new Promise((r) => { release = r; }); return () => { gate = null; release(); }; },
    next: [],
    fetch: async (url, init = {}) => {
      if (String(url).endsWith('/domains')) return Response.json({ data: [{ name: 'tangysessions.com', status: 'verified' }] });
      calls.push({ headers: init.headers, body: JSON.parse(init.body) });
      if (gate) await gate;
      const fn = stub.next.shift();
      if (fn) return fn();
      return Response.json({ id: `msg_${calls.length}` });
    },
  };
  return stub;
}

async function env({ limit, now, completeSendFails = false, logs, t } = {}) {
  const store = await makeTestStore(now ? { now } : {});
  stores.push(store);
  // Close this test's connections as soon as the test ends.
  t?.after(() => store.close());
  hash ??= await hashPassword(PASSWORD);
  await store.db.createAdmin('admin@tangy.test', hash);
  await store.db.createAdmin('other@tangy.test', hash);
  const resend = resendStub();
  const config = loadConfig({
    APP_ORIGIN: ORIGIN, RESEND_API_KEY: 'test-resend-key-not-real-0000', EMAIL_DRY_RUN: 'false', EMAIL_FROM: 'Tangy Sessions <noreply@tangysessions.com>',
    PREVIEW_TOKEN_SECRET: SECRET, ...(limit ? { SEND_LIMIT_PER_10_MIN: String(limit) } : {}),
  });
  const db = completeSendFails ? { ...store.db, completeSend: async () => { throw new Error('connect ECONNREFUSED postgres://u:pw@db.example:5432/x'); } } : store.db;
  const log = logs ? { info: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) } : silent;
  // Two app instances on the same store: concurrent requests hit both.
  const servers = [];
  for (let i = 0; i < 2; i++) {
    const server = createServer(createApp({ config, db, fetchImpl: resend.fetch, log, loginLimiter: store.loginLimiter, ...(now ? { now } : {}) }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    servers.push(`http://127.0.0.1:${server.address().port}`);
    after(() => new Promise((r) => server.close(r)));
  }
  const call = async (i, method, path, body, s) => {
    const res = await fetch(servers[i % 2] + path, {
      method, headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...(s ? { Cookie: s.cookie, 'X-CSRF-Token': s.csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
  };
  const login = async (email = 'admin@tangy.test') => {
    const r = await call(0, 'POST', '/api/login', { email, password: PASSWORD });
    assert.equal(r.status, 200);
    return { cookie: r.headers.get('set-cookie').split(';')[0], csrf: r.data.csrf_token };
  };
  const s = await login();
  assert.equal((await call(0, 'PUT', '/api/sessions/s1', { ...TEMPLATE, expected_version: 0 }, s)).status, 200);
  const sendBody = async (sess = s, extra = {}) => {
    const p = (await call(0, 'POST', '/api/preview', { session_id: 's1', source: 'saved', name: 'Arjun', email: 'arjun@example.com' }, sess)).data;
    return { session_id: 's1', name: 'Arjun', email: 'arjun@example.com', template_version: p.template_version, preview_token: p.preview_token, idempotency_key: randomUUID(), ...extra };
  };
  return { store, resend, call, login, s, sendBody };
}

// --------------------------------------------------------------- unit --
test('claim rules: the decision table for an existing send id', () => {
  const fp = { adminId: 1, sessionId: 's1', email: 'a@b.co', subject: 'S', test: false, version: 2 };
  const row = (status, extra = {}) => ({ admin_id: 1, session_id: 's1', recipient_email: 'a@b.co', subject: 'S', is_test: 0, template_version: 2, status, ...extra });
  const at = { nowMs: 10_000_000, claimedAtMs: 10_000_000 - 1000 };
  assert.equal(existingDecision(row('accepted'), fp, at), 'done');
  assert.equal(existingDecision(row('dry_run'), fp, at), 'done');
  assert.equal(existingDecision(row('rejected'), fp, at), 'finished_error');
  assert.equal(existingDecision(row('failed'), fp, at), 'finished_error');
  assert.equal(existingDecision(row('ambiguous'), fp, at), 'reclaim');
  assert.equal(existingDecision(row('pending'), fp, at), 'in_progress', 'fresh pending');
  assert.equal(existingDecision(row('pending'), fp, { nowMs: at.nowMs, claimedAtMs: at.nowMs - STALE_PENDING_MS }), 'reclaim', 'abandoned pending');
  assert.equal(existingDecision(row('pending'), fp, { nowMs: at.nowMs, claimedAtMs: 0, inFlight: true }), 'in_progress', 'held in this process');
  for (const [k, v] of [['admin_id', 2], ['session_id', 's2'], ['recipient_email', 'x@b.co'], ['subject', 'T'], ['is_test', 1], ['template_version', 3]]) {
    assert.equal(existingDecision(row('accepted', { [k]: v }), fp, at), 'mismatch', k);
  }
  assert.ok(sameAttempt(row('pending', { is_test: false, admin_id: '1' }), fp), 'boolean/numeric-string forms from PostgreSQL compare equal');
});

test('database config: SQLite unless DB_BACKEND=postgres; URLs validated, hidden and never echoed', () => {
  const url = 'postgres://app_user:S3cretPassw0rd@db.example.com:6543/postgres?sslmode=no-verify&application_name=x';
  assert.equal(loadDatabaseConfig({}).backend, 'sqlite');
  assert.equal(loadDatabaseConfig({ DATABASE_URL: url }).backend, 'sqlite', 'a URL alone never switches backend');
  assert.equal(loadConfig({ DATABASE_URL: url }).database.backend, 'sqlite');
  assert.throws(() => loadDatabaseConfig({ DB_BACKEND: 'mysql' }), /DB_BACKEND/);
  assert.throws(() => loadDatabaseConfig({ DB_BACKEND: 'postgres' }), /requires DATABASE_URL/);
  for (const bad of ['mysql://x/y', 'not a url', 'postgres://']) {
    let err;
    try { loadDatabaseConfig({ DB_BACKEND: 'postgres', DATABASE_URL: bad }); } catch (e) { err = e; }
    assert.ok(err, `${bad} rejected`);
    assert.ok(!err.message.includes(bad), 'the value is not echoed');
  }
  assert.throws(() => loadDatabaseConfig({ DB_BACKEND: 'postgres', DATABASE_URL: url, DATABASE_SSL: 'disable' }), /only allowed for a database on localhost/);
  assert.throws(() => loadDatabaseConfig({ DB_BACKEND: 'postgres', DATABASE_URL: url, DATABASE_SSL: 'prefer' }), /DATABASE_SSL/);
  assert.throws(() => loadDatabaseConfig({ DB_BACKEND: 'postgres', DATABASE_URL: url, PG_POOL_MAX: '500' }), /PG_POOL_MAX/);

  const c = loadDatabaseConfig({ DB_BACKEND: 'postgres', DATABASE_URL: url, MIGRATION_DATABASE_URL: url.replace('app_user', 'owner') });
  assert.ok(!c.url.includes('sslmode'), 'TLS parameters are stripped; DATABASE_SSL is authoritative');
  assert.ok(c.url.includes('application_name=x'), 'other parameters kept');
  for (const out of [JSON.stringify(c), inspect(c, { depth: 5 }), JSON.stringify({ ...c }), JSON.stringify(loadConfig({ DB_BACKEND: 'postgres', DATABASE_URL: url }))]) {
    assert.ok(!out.includes('S3cretPassw0rd') && !out.includes('db.example.com'), 'URL never serialized');
  }
  const o = poolOptions(c);
  assert.equal(o.max, 3);
  assert.deepEqual(o.ssl, { rejectUnauthorized: true });
  assert.equal(o.connectionTimeoutMillis, 5000);
  assert.equal(o.query_timeout, 15000);
  assert.equal(o.statement_timeout, 10000);
  assert.throws(() => loadDatabaseConfig({ DB_BACKEND: 'postgres', DATABASE_URL: url, PG_STATEMENT_TIMEOUT_MS: '0' }), /use PG_STARTUP_PARAMS/);
  assert.equal(poolOptions(loadDatabaseConfig({ DB_BACKEND: 'postgres', DATABASE_URL: url, PG_STARTUP_PARAMS: 'none' })).statement_timeout, undefined);
  assert.equal(poolOptions(loadDatabaseConfig({ DB_BACKEND: 'postgres', DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x', DATABASE_SSL: 'disable' })).ssl, false);
  assert.equal(parseDatabaseUrl('postgresql://u:p@h/d', 'X').host, 'h');
});

test('safeDbError never returns connection strings or passwords', () => {
  const e = Object.assign(new Error('connect failed for postgres://admin:hunter2-secret@db.internal:5432/app; password authentication failed for user "admin"'), { code: 'ECONNREFUSED' });
  const out = safeDbError(e);
  assert.ok(!out.includes('hunter2') && !out.includes('db.internal') && !out.includes('postgres://'));
  assert.match(out, /ECONNREFUSED/);
});

test('migration files are versioned; the code runs on every version from the approved one to the latest file', () => {
  const m = listMigrations();
  assert.deepEqual(m.map((x) => x.version), m.map((_, i) => i + 1), 'contiguous 0001, 0002, …');
  // db:migrate applies files up to APPROVED_MIGRATION_VERSION (2: 0002 is
  // approved); the code also runs on version 1 (campaigns reported
  // unavailable) until 0002 has been applied to a database.
  assert.equal(MAX_SCHEMA_VERSION, m.at(-1).version);
  assert.ok(MIN_SCHEMA_VERSION <= APPROVED_MIGRATION_VERSION && APPROVED_MIGRATION_VERSION <= MAX_SCHEMA_VERSION);
  assert.equal(CAMPAIGNS_SCHEMA_VERSION, 2);
  assert.equal(m.find((x) => x.version === CAMPAIGNS_SCHEMA_VERSION).name, '0002_campaigns');
  for (const x of m) assert.ok(!/password\s+'/i.test(x.sql), `${x.name} contains no passwords`);
});

// --------------------------------------------------- concurrency (both) --
test(`[${PG ? 'postgres' : 'sqlite'}] concurrent requests with the same send id: exactly one Resend call`, async (t) => {
  const e = await env({ t });
  const body = await e.sendBody();
  const release = e.resend.hold();
  const inflight = Array.from({ length: 8 }, (_, i) => e.call(i, 'POST', '/api/send', body, e.s));
  await new Promise((r) => setTimeout(r, 300));
  release();
  const results = await Promise.all(inflight);
  assert.equal(e.resend.calls.length, 1, 'one provider call');
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.ok(results.every((r) => r.status === 200 || (r.status === 409 && /in progress/.test(r.data.error))), JSON.stringify(results.map((r) => [r.status, r.data?.error])));
  // Afterwards the same id returns the stored result without sending again.
  const again = await e.call(0, 'POST', '/api/send', body, e.s);
  assert.equal(again.data.duplicate, true);
  assert.equal(e.resend.calls.length, 1);
});

test(`[${PG ? 'postgres' : 'sqlite'}] concurrent retries of an uncertain send cannot both claim it`, async (t) => {
  const e = await env({ t });
  const body = await e.sendBody();
  e.resend.next.push(() => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); });
  assert.equal((await e.call(0, 'POST', '/api/send', body, e.s)).data.status, 'ambiguous');
  const release = e.resend.hold();
  const retries = Array.from({ length: 6 }, (_, i) => e.call(i, 'POST', '/api/send', body, e.s));
  await new Promise((r) => setTimeout(r, 300));
  release();
  const results = await Promise.all(retries);
  assert.equal(e.resend.calls.length, 2, 'the original + exactly one retry');
  assert.equal(e.resend.calls[1].headers['Idempotency-Key'], e.resend.calls[0].headers['Idempotency-Key']);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 5);
});

test(`[${PG ? 'postgres' : 'sqlite'}] concurrent sends cannot overshoot the per-admin rate limit`, async (t) => {
  const e = await env({ limit: 3, t });
  const bodies = await Promise.all(Array.from({ length: 10 }, () => e.sendBody()));
  const results = await Promise.all(bodies.map((b, i) => e.call(i, 'POST', '/api/send', b, e.s)));
  assert.equal(results.filter((r) => r.status === 200).length, 3);
  assert.equal(results.filter((r) => r.status === 429).length, 7);
  assert.equal(e.resend.calls.length, 3);
});

test(`[${PG ? 'postgres' : 'sqlite'}] the same send id used by another admin is refused, not a server error`, async (t) => {
  const e = await env({ t });
  const other = await e.login('other@tangy.test');
  const body = await e.sendBody();
  const otherBody = { ...(await e.sendBody(other)), idempotency_key: body.idempotency_key };
  const [a, b] = await Promise.all([e.call(0, 'POST', '/api/send', body, e.s), e.call(1, 'POST', '/api/send', otherBody, other)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.match([a, b].find((r) => r.status === 409).data.error, /different message/);
  assert.equal(e.resend.calls.length, 1);
});

test(`[${PG ? 'postgres' : 'sqlite'}] if the outcome cannot be recorded, the provider result is still reported (no false "nothing changed")`, async (t) => {
  const logs = [];
  const e = await env({ completeSendFails: true, logs, t });
  const r = await e.call(0, 'POST', '/api/send', await e.sendBody(), e.s);
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'accepted');
  assert.match(r.data.message_id, /^msg_/);
  assert.match(r.data.history_warning, /could not be updated/);
  assert.ok(!logs.join('\n').includes('pw@db.example'), 'logged error is sanitized');
});

test(`[${PG ? 'postgres' : 'sqlite'}] an unexpected exception while sending is recorded as uncertain, never retried`, async (t) => {
  const e = await env({ t });
  e.resend.next.push(() => { throw new TypeError('boom'); });
  const r = await e.call(0, 'POST', '/api/send', await e.sendBody(), e.s);
  assert.equal(r.status, 504);
  assert.equal(r.data.status, 'ambiguous');
  assert.equal(e.resend.calls.length, 1);
  const log = (await e.call(0, 'GET', '/api/sends', undefined, e.s)).data.sends;
  assert.equal(log[0].status, 'ambiguous');
});

test(`[${PG ? 'postgres' : 'sqlite'}] retries of an uncertain send OLDER than the stale window still cannot both claim it`, async (t) => {
  // The stale window used to be measured from created_at, which a retry does
  // not change: once the original attempt was >2 min old, a second retry
  // could re-claim a send whose first retry was still in flight.
  let clock = Date.now();
  const e = await env({ now: () => clock, t });
  const body = await e.sendBody();
  e.resend.next.push(() => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); });
  assert.equal((await e.call(0, 'POST', '/api/send', body, e.s)).data.status, 'ambiguous');
  clock += STALE_PENDING_MS + 60_000; // the original attempt is now 3 minutes old
  const fresh = (await e.call(0, 'POST', '/api/preview', { session_id: 's1', source: 'saved', name: 'Arjun', email: 'arjun@example.com' }, e.s)).data;
  const retryBody = { ...body, preview_token: fresh.preview_token };
  const release = e.resend.hold();
  const first = e.call(0, 'POST', '/api/send', retryBody, e.s);
  await new Promise((r) => setTimeout(r, 200)); // the first retry is now waiting on Resend
  // Bounded wait: if the second retry were (wrongly) sent to Resend it
  // would block on the held stub — fail the assertion instead of hanging.
  const secondCall = e.call(1, 'POST', '/api/send', retryBody, e.s);
  const second = await Promise.race([secondCall, new Promise((r) => setTimeout(() => r({ status: 'still waiting on Resend' }), 3000))]);
  release();
  await secondCall;
  const firstResult = await first;
  assert.equal(second.status, 409, 'second retry refused while the first is in flight');
  assert.match(second.data.error, /in progress/);
  assert.equal(firstResult.status, 200);
  assert.equal(e.resend.calls.length, 2, 'original + one retry, never two');
});
