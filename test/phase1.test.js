// Phase 1 (pre-Vercel): preview tokens signed with a configured, shared
// PREVIEW_TOKEN_SECRET, and the failed-login limiter behind an async
// interface. Resend is a stubbed fetch — nothing leaves the machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { loadConfig, previewSecretProblem, PREVIEW_SECRET_MIN_LENGTH } from '../src/config.js';
import { makeTestStore } from './helpers/testStore.js';
import { createApp } from '../src/app.js';
import { hashPassword, MemoryLoginLimiter, LoginLimiter, LOGIN_POLICY, assertLoginLimiter, limiterKeys } from '../src/auth.js';

const ORIGIN = 'http://app.test';
const PASSWORD = 'correct horse battery staple';
const SECRET_A = randomBytes(32).toString('base64url');
const SECRET_B = randomBytes(32).toString('base64url');
const silent = { info() {}, error() {} };
const TEMPLATE = {
  name: 'Phase One', subject: 'Hello {{recipient_name}}',
  html: '<html><head></head><body><h1>Hello {{recipient_name}}</h1></body></html>', text: '',
};

let hash;
const adminHash = async () => (hash ??= await hashPassword(PASSWORD));

const baseEnv = (extra = {}) => ({ APP_ORIGIN: ORIGIN, EMAIL_DRY_RUN: 'true', EMAIL_FROM: 'Tangy Sessions <noreply@tangysessions.com>', ...extra });

// One "instance" = one createApp + HTTP server. Instances may share a db,
// exactly as serverless instances would share one database.
async function instance({ db, env = {}, now, loginLimiter, logs } = {}) {
  const config = loadConfig(baseEnv(env));
  // Default limiter: the store's (PgLoginLimiter on PostgreSQL), else the app default.
  loginLimiter ??= db.testLimiter?.(now);
  const log = logs ? { info: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) } : silent;
  const server = createServer(createApp({ config, db, log, ...(now ? { now } : {}), ...(loginLimiter ? { loginLimiter } : {}) }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, { cookie, csrf } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers, text };
  };
  const login = async (password = PASSWORD) => {
    const r = await call('POST', '/api/login', { email: 'admin@tangy.test', password });
    return r.status === 200 ? { cookie: r.headers.get('set-cookie').split(';')[0], csrf: r.data.csrf_token, status: 200 } : { status: r.status, data: r.data };
  };
  return { call, login, close: () => new Promise((r) => server.close(r)) };
}

const stores = [];
test.after(async () => { for (const s of stores) await s.close(); });

async function sharedDb() {
  const store = await makeTestStore();
  await store.db.createAdmin('admin@tangy.test', await adminHash());
  stores.push(store);
  // Each instance gets its own PgLoginLimiter on PostgreSQL (same database).
  return { ...store.db, testLimiter: store.runtime ? (now) => store.runtime.createLoginLimiter(now ? { now } : {}) : undefined };
}

async function configure(inst, s) {
  const r = await inst.call('PUT', '/api/sessions/s1', { ...TEMPLATE, expected_version: 0 }, s);
  assert.equal(r.status, 200, JSON.stringify(r.data));
}

const preview = (inst, s, { name = 'Arjun', email = 'arjun@example.com', test: isTest = false } = {}) =>
  inst.call('POST', '/api/preview', { session_id: 's1', source: 'saved', name, email, test: isTest }, s).then((r) => r.data);

const realBody = (p, extra = {}) => ({ session_id: 's1', name: 'Arjun', email: 'arjun@example.com', template_version: p.template_version, preview_token: p.preview_token, idempotency_key: randomUUID(), ...extra });

// ------------------------------------------------- secret configuration --
test('production refuses to start without PREVIEW_TOKEN_SECRET', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production', APP_ORIGIN: 'https://invite.example.test' }), /PREVIEW_TOKEN_SECRET is not set/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', APP_ORIGIN: 'https://invite.example.test', PREVIEW_TOKEN_SECRET: '' }), /not set/);
  const ok = loadConfig({ NODE_ENV: 'production', APP_ORIGIN: 'https://invite.example.test', PREVIEW_TOKEN_SECRET: SECRET_A, DB_BACKEND: 'sqlite', EMAIL_DRY_RUN: 'true' });
  assert.equal(ok.previewSecretSource, 'env');
  assert.ok(ok.previewSecret.equals(Buffer.from(SECRET_A)));
});

test('weak secrets are rejected in production AND development, and the value is never echoed', () => {
  const weak = {
    short: 'a1B2c3D4e5F6g7H8',
    repetitive: 'abababababababababababababababababababab',
    spaces: `${SECRET_A.slice(0, 20)} ${SECRET_A.slice(20)}`,
    padded: ` ${SECRET_A}`,
    placeholder: 'change-me-please-0123456789abcdefghijklmnop',
    placeholder2: 'my-super-secret-value-0123456789abcdefghijk',
  };
  for (const [label, value] of Object.entries(weak)) {
    for (const NODE_ENV of ['production', 'development']) {
      let err;
      try { loadConfig({ NODE_ENV, APP_ORIGIN: 'https://invite.example.test', PREVIEW_TOKEN_SECRET: value }); } catch (e) { err = e; }
      assert.ok(err, `${label} rejected in ${NODE_ENV}`);
      assert.ok(!err.message.includes(value.trim()), `${label}: error must not contain the value`);
    }
  }
  assert.match(previewSecretProblem('x'.repeat(PREVIEW_SECRET_MIN_LENGTH - 1)), /too short/);
});

test('randomly generated secrets are always accepted (no false rejections)', () => {
  for (let i = 0; i < 2000; i++) {
    const v = randomBytes(32).toString(i % 2 ? 'base64url' : 'hex');
    assert.equal(previewSecretProblem(v), null, 'a random secret must pass');
  }
});

test('development without a secret: one random key per process (not per request), flagged as ephemeral', () => {
  const c = loadConfig(baseEnv());
  assert.equal(c.previewSecretSource, 'ephemeral');
  assert.equal(c.previewSecret.length, 32);
  assert.ok(c.previewSecret.equals(c.previewSecret), 'stable for the life of the config');
});

test('the secret is not enumerable: JSON, inspect and spread copies never contain it', () => {
  const c = loadConfig(baseEnv({ PREVIEW_TOKEN_SECRET: SECRET_A }));
  assert.ok(!JSON.stringify(c).includes(SECRET_A));
  assert.ok(!inspect(c, { depth: 5 }).includes(SECRET_A));
  assert.equal({ ...c }.previewSecret, undefined);
});

// --------------------------------------------- tokens across instances --
test('a preview from one instance authorizes a send on another instance with the same secret', async () => {
  const db = await sharedDb();
  const a = await instance({ db, env: { PREVIEW_TOKEN_SECRET: SECRET_A } });
  const b = await instance({ db, env: { PREVIEW_TOKEN_SECRET: SECRET_A } });
  try {
    const s = await a.login();
    await configure(a, s);
    const p = await preview(a, s);
    const r = await b.call('POST', '/api/send', realBody(p), s); // login session also shared via the db
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.status, 'dry_run');
  } finally { await a.close(); await b.close(); }
});

test('a token signed with a different secret is rejected', async () => {
  const db = await sharedDb();
  const a = await instance({ db, env: { PREVIEW_TOKEN_SECRET: SECRET_A } });
  const b = await instance({ db, env: { PREVIEW_TOKEN_SECRET: SECRET_B } });
  try {
    const s = await a.login();
    await configure(a, s);
    const p = await preview(a, s);
    const r = await b.call('POST', '/api/send', realBody(p), s);
    assert.equal(r.status, 409);
    assert.equal(r.data.code, 'preview_required');
    assert.equal((await a.call('POST', '/api/send', realBody(p), s)).status, 200, 'the issuing secret still accepts it');
  } finally { await a.close(); await b.close(); }
});

test('expired, tampered, malformed and future-dated tokens are rejected', async () => {
  let clock = Date.now();
  const db = await sharedDb();
  const a = await instance({ db, env: { PREVIEW_TOKEN_SECRET: SECRET_A }, now: () => clock });
  try {
    const s = await a.login();
    await configure(a, s);
    const p = await preview(a, s);
    const [ts, mac] = p.preview_token.split('.');
    const flip = (c) => (c === 'A' ? 'B' : 'A');
    const bad = {
      tampered_signature: `${ts}.${mac.slice(0, -1)}${flip(mac.at(-1))}`,
      tampered_timestamp: `${Number(ts) + 1}.${mac}`,
      empty: '',
      no_dot: mac,
      garbage: 'x.y',
      future: `${clock + 5 * 60_000}.${mac}`,
      huge: `${ts}.${'A'.repeat(300)}`,
    };
    for (const [label, token] of Object.entries(bad)) {
      const r = await a.call('POST', '/api/send', realBody(p, { preview_token: token }), s);
      assert.equal(r.data.code, 'preview_required', label);
    }
    clock += 30 * 60_000 + 1000;
    assert.equal((await a.call('POST', '/api/send', realBody(p), s)).data.code, 'preview_required', 'expired after 30 minutes');
  } finally { await a.close(); }
});

test('test and real preview tokens are not interchangeable (across instances too)', async () => {
  const db = await sharedDb();
  const a = await instance({ db, env: { PREVIEW_TOKEN_SECRET: SECRET_A } });
  const b = await instance({ db, env: { PREVIEW_TOKEN_SECRET: SECRET_A } });
  try {
    const s = await a.login();
    await configure(a, s);
    const tp = await preview(a, s, { email: 'me@example.com', test: true });
    const asReal = await b.call('POST', '/api/send', realBody(tp, { name: 'Test Recipient', email: 'me@example.com' }), s);
    assert.equal(asReal.data.code, 'preview_required', 'test token refused for a real send');
    const rp = await preview(a, s, { name: 'Test Recipient', email: 'me@example.com' });
    const asTest = await b.call('POST', '/api/send-test', { session_id: 's1', email: 'me@example.com', template_version: rp.template_version, preview_token: rp.preview_token, idempotency_key: randomUUID() }, s);
    assert.equal(asTest.data.code, 'preview_required', 'real token refused for a test send');
    const ok = await b.call('POST', '/api/send-test', { session_id: 's1', email: 'me@example.com', template_version: tp.template_version, preview_token: tp.preview_token, idempotency_key: randomUUID() }, s);
    assert.equal(ok.status, 200, 'the matching test token works on the other instance');
  } finally { await a.close(); await b.close(); }
});

test('the secret never appears in API responses, page files or logs', async () => {
  const db = await sharedDb();
  const logs = [];
  const a = await instance({ db, env: { PREVIEW_TOKEN_SECRET: SECRET_A }, logs });
  try {
    const s = await a.login();
    await configure(a, s);
    const p = await preview(a, s);
    const out = [
      await a.call('GET', '/api/session', undefined, s), await a.call('GET', '/api/status', undefined, s),
      await a.call('GET', '/api/sessions', undefined, s), await a.call('GET', '/api/sessions/s1', undefined, s),
      await a.call('POST', '/api/send', realBody(p), s), await a.call('GET', '/api/sends', undefined, s),
      await a.call('POST', '/api/send', realBody(p, { preview_token: 'bad' }), s),
      await a.call('GET', '/'), await a.call('GET', '/app.js'),
    ];
    for (const r of out) assert.ok(!r.text.includes(SECRET_A));
    assert.ok(!JSON.stringify(p).includes(SECRET_A));
    assert.ok(!logs.join('\n').includes(SECRET_A));
  } finally { await a.close(); }
});

// ------------------------------------------------------- login limiter --
test('limiter policy is unchanged: 5 per email, 20 per IP, fixed 15-minute window', async () => {
  assert.deepEqual({ ...LOGIN_POLICY }, { perEmail: 5, perIp: 20, windowMs: 15 * 60 * 1000 });
  let clock = 1_000_000;
  const l = new MemoryLoginLimiter({ now: () => clock });

  for (let i = 0; i < 4; i++) await l.recordFailure('Ann@Example.com', '10.0.0.1');
  assert.equal(await l.isBlocked('ann@example.com', '10.0.0.9'), false, '4 failures: still allowed');
  await l.recordFailure('ann@example.com', '10.0.0.1');
  assert.equal(await l.isBlocked('ANN@example.com', '10.0.0.9'), true, '5th failure blocks that email (case-insensitive), from any IP');
  assert.equal(await l.isBlocked('bob@example.com', '10.0.0.2'), false, 'other emails/IPs unaffected');

  // Window: fixed from the first failure; exactly 15 min is still inside.
  clock += LOGIN_POLICY.windowMs;
  assert.equal(await l.isBlocked('ann@example.com', '10.0.0.9'), true, 'at exactly 15 min: still blocked');
  clock += 1;
  assert.equal(await l.isBlocked('ann@example.com', '10.0.0.9'), false, 'after 15 min: unblocked');

  // IP: 20 failures across different emails.
  for (let i = 0; i < 19; i++) await l.recordFailure(`u${i}@example.com`, '10.9.9.9');
  assert.equal(await l.isBlocked('fresh@example.com', '10.9.9.9'), false, '19 IP failures: allowed');
  await l.recordFailure('u19@example.com', '10.9.9.9');
  assert.equal(await l.isBlocked('fresh@example.com', '10.9.9.9'), true, '20th IP failure blocks the IP for every email');
});

test('success clears only that email\'s counter, not the IP\'s', async () => {
  const l = new MemoryLoginLimiter();
  for (let i = 0; i < 5; i++) await l.recordFailure('ann@example.com', '10.0.0.1');
  for (let i = 0; i < 15; i++) await l.recordFailure(`x${i}@example.com`, '10.0.0.1');
  assert.equal(await l.isBlocked('ann@example.com', '10.0.0.2'), true);
  await l.recordSuccess('ANN@example.com');
  assert.equal(await l.isBlocked('ann@example.com', '10.0.0.2'), false, 'email cleared');
  assert.equal(await l.isBlocked('ann@example.com', '10.0.0.1'), true, 'IP count (20) kept');
});

test('memory bound unchanged: counters reset once more than 10,000 keys exist', async () => {
  const l = new MemoryLoginLimiter({ maxKeys: 10 });
  for (let i = 0; i < 5; i++) await l.recordFailure('ann@example.com', '10.0.0.1');
  assert.equal(await l.isBlocked('ann@example.com', 'x'), true);
  for (let i = 0; i < 5; i++) await l.recordFailure(`k${i}@example.com`, `10.1.0.${i}`);
  assert.equal(await l.isBlocked('ann@example.com', 'x'), false, 'cleared when the bound is exceeded (same as before)');
  assert.equal(new MemoryLoginLimiter().maxKeys, 10_000);
});

test('interface: async methods, shared key format, validation, old name still exported', async () => {
  const l = new MemoryLoginLimiter();
  for (const m of ['isBlocked', 'recordFailure', 'recordSuccess']) assert.ok(l[m]('a@b.co', '1.1.1.1') instanceof Promise, `${m} returns a Promise`);
  assert.deepEqual(limiterKeys('A@B.co', '1.2.3.4'), { email: 'e:a@b.co', ip: 'i:1.2.3.4' });
  assert.throws(() => assertLoginLimiter({ isBlocked() {} }), /missing: recordFailure, recordSuccess/);
  assert.throws(() => assertLoginLimiter(null), /missing/);
  assert.equal(LoginLimiter, MemoryLoginLimiter);
});

test('the app uses an injected (async) limiter, checks it BEFORE verifying the password, and records outcomes', async () => {
  const calls = [];
  const delay = () => new Promise((r) => setTimeout(r, 5));
  let blocked = false;
  const fake = {
    async isBlocked(email, ip) { await delay(); calls.push(['isBlocked', email, ip]); return blocked; },
    async recordFailure(email, ip) { await delay(); calls.push(['recordFailure', email, ip]); },
    async recordSuccess(email) { await delay(); calls.push(['recordSuccess', email]); },
  };
  const db = await sharedDb();
  const a = await instance({ db, env: { PREVIEW_TOKEN_SECRET: SECRET_A }, loginLimiter: fake });
  try {
    assert.equal((await a.login('wrong-password-xyz')).status, 401);
    assert.equal((await a.login()).status, 200);
    assert.deepEqual(calls.map((c) => c[0]), ['isBlocked', 'recordFailure', 'isBlocked', 'recordSuccess']);
    assert.equal(calls[0][1], 'admin@tangy.test');
    assert.match(calls[0][2], /127\.0\.0\.1/, 'client IP comes from the socket (TRUST_PROXY off)');
    blocked = true;
    const r = await a.login();
    assert.equal(r.status, 429, 'blocked even with the correct password');
  } finally { await a.close(); }
});

test('a failing limiter makes sign-in fail closed (no session issued)', async () => {
  const broken = { async isBlocked() { throw new Error('store unavailable'); }, async recordFailure() {}, async recordSuccess() {} };
  const db = await sharedDb();
  const a = await instance({ db, env: { PREVIEW_TOKEN_SECRET: SECRET_A }, loginLimiter: broken });
  try {
    const r = await a.call('POST', '/api/login', { email: 'admin@tangy.test', password: PASSWORD });
    assert.equal(r.status, 500);
    assert.equal(r.headers.get('set-cookie'), null);
  } finally { await a.close(); }
});

test('createApp refuses an incomplete limiter', async () => {
  const db = await sharedDb();
  const config = loadConfig(baseEnv({ PREVIEW_TOKEN_SECRET: SECRET_A }));
  assert.throws(() => createApp({ config, db, log: silent, loginLimiter: { isBlocked() {} } }), /missing/);
});

test('default limiter end to end: 5 wrong passwords, then the right one is refused (429)', async () => {
  const db = await sharedDb();
  const a = await instance({ db, env: { PREVIEW_TOKEN_SECRET: SECRET_A } });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await a.login('wrong-password-xyz')).status, 401);
    assert.equal((await a.login()).status, 429);
  } finally { await a.close(); }
});
