// Vercel adapter (src/vercel.js, api/handler.js, vercel.json). Requests go
// through the adapter exactly as Vercel would deliver them. With
// `npm run test:pg` the adapter opens a real PostgreSQL store from its own
// environment (DB_BACKEND=postgres, DATABASE_URL); otherwise an injected test
// store is used. Resend is stubbed; nothing leaves the machine.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { createVercelHandler, resolveApiUrl, FUNCTION_PATH } from '../src/vercel.js';
import { createApp, SECURITY_HEADERS, HSTS, STATIC_PATHS } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/auth.js';
import { makeTestStore, PG } from './helpers/testStore.js';

const ORIGIN = 'https://invite.example.test';
const PASSWORD = 'correct horse battery staple';
const SECRET = randomBytes(32).toString('base64url');
const DB_SECRET = 'Sup3rSecretDbPassword';
const TEMPLATE = { name: 'Vercel', subject: 'Hi {{recipient_name}}', html: '<html><head></head><body><p>Hi {{recipient_name}}</p></body></html>', text: '' };
let hash;
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c().catch(() => {}); });

const vercelEnv = (extra = {}) => ({
  VERCEL: '1', VERCEL_ENV: 'production', APP_ORIGIN: ORIGIN, DB_BACKEND: 'postgres',
  DATABASE_URL: `postgres://app_user:${DB_SECRET}@db.example.com:6543/postgres`, TRUST_PROXY: 'true',
  PREVIEW_TOKEN_SECRET: SECRET, EMAIL_DRY_RUN: 'true', EMAIL_FROM: 'Tangy Sessions <noreply@tangysessions.com>', ...extra,
});

function resendStub() {
  const calls = [];
  return { calls, fetch: async (url, init = {}) => { calls.push({ url: String(url), body: init.body }); return Response.json({ id: `msg_${calls.length}` }); } };
}

// A shared database plus N adapter "instances" (separate handlers and, on
// PostgreSQL, separate connection pools) — like separate function instances.
async function deployment({ instances = 1, env = {}, logs } = {}) {
  hash ??= await hashPassword(PASSWORD);
  const key = `vercel-${randomBytes(6).toString('hex')}`;
  const store = await makeTestStore({ dataDir: PG ? key : ':memory:' });
  cleanups.push(() => store.close());
  await store.db.createAdmin('admin@tangy.test', hash);
  const resend = resendStub();
  const log = logs ? { info: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) } : { info() {}, error() {} };
  const handlers = [];
  for (let i = 0; i < instances; i++) {
    const opts = PG
      ? { env: vercelEnv({ DATABASE_URL: store.info.runtimeUrl, DATABASE_SSL: 'disable', ...env }) } // real openStore
      : { env: vercelEnv(env), openStoreImpl: async () => ({ backend: 'test', db: store.db, loginLimiter: undefined, close: async () => {} }) };
    handlers.push(createVercelHandler({ ...opts, fetchImpl: resend.fetch, log }));
  }
  const servers = [];
  for (const h of handlers) {
    const server = createServer((req, res) => h(req, res));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    servers.push(`http://127.0.0.1:${server.address().port}`);
    cleanups.push(() => new Promise((r) => server.close(r)));
  }
  // `path` is the public path; `shape` picks how Vercel delivers it.
  const call = async (i, method, path, body, { s, shape = 'rewrite', origin = ORIGIN, headers = {} } = {}) => {
    const u = new URL(path, 'http://x');
    const target = shape === 'rewrite' && u.pathname.startsWith('/api/')
      ? `${FUNCTION_PATH}?route=${u.pathname.slice(5)}${u.search ? `&${u.search.slice(1)}` : ''}`
      : path;
    const res = await fetch(servers[i] + target, {
      method,
      headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}), ...(s ? { Cookie: s.cookie, 'X-CSRF-Token': s.csrf } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, text, headers: res.headers };
  };
  const login = async (i = 0, headers = {}) => {
    const r = await call(i, 'POST', '/api/login', { email: 'admin@tangy.test', password: PASSWORD }, { headers });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return { cookie: r.headers.get('set-cookie').split(';')[0], csrf: r.data.csrf_token, setCookie: r.headers.get('set-cookie') };
  };
  return { call, login, resend, store };
}

// ------------------------------------------------------------- routing --
test('resolveApiUrl: original and rewritten URLs map to the same app path; anything else is refused', () => {
  assert.equal(resolveApiUrl('/api/sessions/s1'), '/api/sessions/s1');
  assert.equal(resolveApiUrl('/api/status?refresh=1'), '/api/status?refresh=1');
  assert.equal(resolveApiUrl('/api/handler?route=sessions/s1'), '/api/sessions/s1');
  assert.equal(resolveApiUrl('/api/handler?route=status&refresh=1'), '/api/status?refresh=1');
  assert.equal(resolveApiUrl('/api/handler?refresh=1&route=status'), '/api/status?refresh=1');
  for (const bad of ['/api/handler', '/api/handler?route=', '/api/handler?route=../src/config.js', '/api/handler?route=sessions/../../x',
    '/api/handler?route=/etc/passwd', '/api/handler?route=a//b', '/api/handler?route=a%20b c', '/', '/index.html', '/src/config.js', '/api/', '/apix/login']) {
    assert.equal(resolveApiUrl(bad), null, bad);
  }
});

test('routes behave identically for both URL shapes', async () => {
  const d = await deployment();
  for (const shape of ['rewrite', 'original']) {
    const s = await d.login();
    const list = await d.call(0, 'GET', '/api/sessions', undefined, { s, shape });
    assert.equal(list.status, 200, shape);
    assert.deepEqual(list.data.sessions.map((x) => x.id), ['s1', 's2', 's3', 's4']);
    assert.equal((await d.call(0, 'GET', '/api/sessions/s3', undefined, { s, shape })).data.session.id, 's3');
    assert.equal((await d.call(0, 'GET', '/api/sessions/s9', undefined, { s, shape })).data.code, 'invalid_session');
    const st = await d.call(0, 'GET', '/api/status?refresh=1', undefined, { s, shape });
    assert.equal(st.status, 200);
    assert.equal(st.data.email.dryRun, true);
    assert.equal((await d.call(0, 'GET', '/api/nope', undefined, { s, shape })).status, 404);
  }
});

test('non-API paths and traversal attempts get 404 from the function (static files are CDN-only)', async () => {
  const d = await deployment();
  for (const p of ['/', '/index.html', '/app.js', '/src/config.js', '/.env', '/data/mailer.db', '/api/handler', '/api/handler?route=../.env']) {
    const r = await d.call(0, 'GET', p, undefined, { shape: 'original' });
    assert.equal(r.status, 404, p);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', `${p}: security headers on 404`);
  }
});

// ----------------------------------------------- cookies, headers, CSRF --
test('cookies, security headers, CSRF and origin checks through the adapter', async () => {
  const d = await deployment();
  const s = await d.login();
  assert.match(s.setCookie, /HttpOnly/);
  assert.match(s.setCookie, /SameSite=Strict/);
  assert.match(s.setCookie, /Secure/, 'https APP_ORIGIN → Secure cookie');
  const r = await d.call(0, 'GET', '/api/session', undefined, { s });
  assert.equal(r.status, 200);
  for (const [name, value] of [...SECURITY_HEADERS, HSTS]) assert.equal(r.headers.get(name), value, name);
  assert.equal(r.headers.get('cache-control'), 'no-store');

  const body = { ...TEMPLATE, expected_version: 0 };
  assert.equal((await d.call(0, 'PUT', '/api/sessions/s1', body, { s: { cookie: s.cookie } })).status, 403, 'missing CSRF token');
  assert.equal((await d.call(0, 'PUT', '/api/sessions/s1', body, { s, origin: 'https://evil.example' })).status, 403, 'foreign origin');
  assert.equal((await d.call(0, 'PUT', '/api/sessions/s1', body, { s, origin: 'https://tangy-invitations-git-x.vercel.app' })).status, 403, 'preview URL ≠ APP_ORIGIN');
  assert.equal((await d.call(0, 'PUT', '/api/sessions/s1', body, { s, origin: 'http://localhost:8787' })).status, 403, 'no loopback origins in production');
  assert.equal((await d.call(0, 'GET', '/api/sessions')).status, 401, 'no cookie');
  assert.equal((await d.call(0, 'PUT', '/api/sessions/s1', body, { s })).status, 200, 'valid request passes');
});

test('request-body limits are unchanged through the adapter', async () => {
  const d = await deployment();
  const s = await d.login();
  const r = await d.call(0, 'PUT', '/api/sessions/s1', { ...TEMPLATE, html: 'x'.repeat(1_100_000), expected_version: 0 }, { s });
  assert.equal(r.status, 413);
});

test('client IP comes from X-Forwarded-For (TRUST_PROXY): one visitor\'s failures do not lock out others', async () => {
  const d = await deployment();
  for (let i = 0; i < 20; i++) {
    const r = await d.call(0, 'POST', '/api/login', { email: `u${i}@example.com`, password: 'wrong-password-xyz' }, { headers: { 'X-Forwarded-For': '203.0.113.5, 10.0.0.1' } });
    assert.equal(r.status, 401);
  }
  const blocked = await d.call(0, 'POST', '/api/login', { email: 'admin@tangy.test', password: PASSWORD }, { headers: { 'X-Forwarded-For': '203.0.113.5' } });
  assert.equal(blocked.status, 429, 'the abusive address is blocked');
  const other = await d.call(0, 'POST', '/api/login', { email: 'admin@tangy.test', password: PASSWORD }, { headers: { 'X-Forwarded-For': '198.51.100.7' } });
  assert.equal(other.status, 200, 'a different visitor is not');
});

// ------------------------------------------------------ across instances --
test('two function instances: sessions and preview tokens work across them (shared secret + database)', async () => {
  const d = await deployment({ instances: 2 });
  const s = await d.login(0);
  assert.equal((await d.call(1, 'GET', '/api/session', undefined, { s })).status, 200, 'login on A, session valid on B');
  assert.equal((await d.call(0, 'PUT', '/api/sessions/s1', { ...TEMPLATE, expected_version: 0 }, { s })).status, 200);
  const p = (await d.call(0, 'POST', '/api/preview', { session_id: 's1', source: 'saved', name: 'Arjun', email: 'arjun@example.com' }, { s })).data;
  const send = await d.call(1, 'POST', '/api/send', { session_id: 's1', name: 'Arjun', email: 'arjun@example.com', template_version: p.template_version, preview_token: p.preview_token, idempotency_key: randomUUID() }, { s });
  assert.equal(send.status, 200, JSON.stringify(send.data));
  assert.equal(send.data.status, 'dry_run');
  assert.equal(d.resend.calls.length, 0, 'dry run: Resend never called');
});

// --------------------------------------------- production configuration --
test('Vercel production rules: misconfiguration → 503 with no details, the store is never opened, nothing falls back to SQLite', async () => {
  const bad = {
    'no DB_BACKEND': { DB_BACKEND: '' },
    'sqlite on Vercel': { DB_BACKEND: 'sqlite' },
    'no TRUST_PROXY': { TRUST_PROXY: '' },
    'no PREVIEW_TOKEN_SECRET': { PREVIEW_TOKEN_SECRET: '' },
    'weak PREVIEW_TOKEN_SECRET': { PREVIEW_TOKEN_SECRET: 'short' },
    'http APP_ORIGIN': { APP_ORIGIN: 'http://invite.example.test' },
    'no APP_ORIGIN': { APP_ORIGIN: '' },
    'no DATABASE_URL': { DATABASE_URL: '' },
    'preview env still production rules': { VERCEL_ENV: 'preview', DB_BACKEND: 'sqlite' },
  };
  for (const [label, override] of Object.entries(bad)) {
    let opened = 0;
    const logs = [];
    const h = createVercelHandler({
      env: vercelEnv(override),
      openStoreImpl: async () => { opened++; throw new Error('must not be called'); },
      log: { info() {}, error: (...a) => logs.push(a.join(' ')) },
    });
    const server = createServer((req, res) => h(req, res));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/handler?route=session`);
    const text = await res.text();
    await new Promise((r) => server.close(r));
    assert.equal(res.status, 503, label);
    assert.equal(opened, 0, `${label}: store not opened`);
    assert.match(text, /not available right now/);
    for (const out of [text, logs.join('\n')]) {
      assert.ok(!out.includes(DB_SECRET) && !out.includes(SECRET) && !out.includes('db.example.com'), `${label}: no secrets in response or logs`);
    }
    assert.ok(logs.some((l) => l.includes('[vercel] startup failed')), `${label}: logged (safely)`);
  }
});

test('outside Vercel too, the adapter refuses anything but PostgreSQL — before opening any store', async () => {
  for (const env of [{}, { DB_BACKEND: 'sqlite' }, { PREVIEW_TOKEN_SECRET: SECRET }, { NODE_ENV: 'production', DB_BACKEND: 'sqlite', APP_ORIGIN: ORIGIN, PREVIEW_TOKEN_SECRET: SECRET }]) {
    let opened = 0;
    const h = createVercelHandler({ env, openStoreImpl: async () => { opened++; throw new Error('must not be called'); }, log: { info() {}, error() {} } });
    const server = createServer((req, res) => h(req, res));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/handler?route=session`);
    await new Promise((r) => server.close(r));
    assert.equal(res.status, 503, JSON.stringify(env));
    assert.equal(opened, 0, 'no store opened');
  }
});

test('database unavailable: 503 (no fallback), safe logs, and the next request retries initialization', async () => {
  let attempts = 0;
  const logs = [];
  const h = createVercelHandler({
    env: vercelEnv(),
    openStoreImpl: async () => { attempts++; throw Object.assign(new Error(`connect ECONNREFUSED postgres://app_user:${DB_SECRET}@db.example.com:6543/postgres`), { code: 'ECONNREFUSED' }); },
    log: { info() {}, error: (...a) => logs.push(a.join(' ')) },
  });
  const server = createServer((req, res) => h(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const a = await fetch(`${base}/api/handler?route=session`);
  const b = await fetch(`${base}/api/handler?route=session`);
  await new Promise((r) => server.close(r));
  assert.deepEqual([a.status, b.status], [503, 503]);
  assert.equal(attempts, 2, 'retried, not cached as failed');
  assert.ok(!logs.join('\n').includes(DB_SECRET) && !logs.join('\n').includes('postgres://'));
});

test('config: production needs an explicit DB_BACKEND; Vercel forces production rules; local development unchanged', () => {
  const prod = { NODE_ENV: 'production', APP_ORIGIN: ORIGIN, PREVIEW_TOKEN_SECRET: SECRET, EMAIL_DRY_RUN: 'true' };
  assert.throws(() => loadConfig(prod), /DB_BACKEND must be set explicitly/);
  assert.equal(loadConfig({ ...prod, DB_BACKEND: 'sqlite' }).database.backend, 'sqlite', 'self-hosted SQLite still allowed when explicit');
  const v = loadConfig(vercelEnv({ NODE_ENV: 'development' }));
  assert.deepEqual([v.production, v.platform, v.database.backend, v.trustProxy, v.secureCookies], [true, 'vercel', 'postgres', true, true]);
  assert.ok(!v.allowedOrigins.has('http://localhost:8787'));
  const local = loadConfig({});
  assert.deepEqual([local.production, local.platform, local.database.backend], [false, 'node', 'sqlite'], 'local default unchanged');
  assert.equal(loadConfig({ VERCEL: '1', VERCEL_ENV: 'development' }).platform, 'node', '`vercel dev` keeps local rules');
});

test('createApp({ serveStatic: false }) answers only /api and never needs public/', async () => {
  const store = await makeTestStore();
  cleanups.push(() => store.close());
  const config = loadConfig({ PREVIEW_TOKEN_SECRET: SECRET });
  const app = createApp({ config, db: store.db, serveStatic: false, log: { info() {}, error() {} }, loginLimiter: store.loginLimiter });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const [root, js, api] = await Promise.all([fetch(`${base}/`), fetch(`${base}/app.js`), fetch(`${base}/api/session`)]);
  await new Promise((r) => server.close(r));
  assert.deepEqual([root.status, js.status, api.status], [404, 404, 401]);
});

// --------------------------------------------------------- vercel.json --
test('vercel.json: static output is public/ only, one rewrite to the function, headers identical to the app', () => {
  const cfg = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(cfg.outputDirectory, 'public');
  assert.deepEqual(readdirSync(new URL('../public/', import.meta.url)).sort(), ['app.css', 'app.js', 'favicon.svg', 'index.html'], 'nothing server-side in the static output');
  assert.deepEqual(cfg.rewrites, [{ source: '/api/:path*', destination: '/api/handler?route=:path*' }]);
  assert.ok(cfg.functions['api/handler.js'].maxDuration >= 30, 'longer than the 15 s Resend timeout plus database time');
  const all = cfg.headers.find((h) => h.source === '/(.*)');
  assert.deepEqual(all.headers.map((h) => [h.key, h.value]), [...SECURITY_HEADERS, HSTS], 'CDN headers = app headers');
  for (const p of STATIC_PATHS) assert.ok(cfg.headers.some((h) => h.source === p && h.headers.some((x) => x.key === 'Cache-Control' && x.value === 'no-cache')), `${p} revalidated`);
  assert.ok(!JSON.stringify(cfg).match(/re_[A-Za-z0-9]{8,}|postgres:\/\/|PREVIEW_TOKEN_SECRET=/), 'no secrets');
  const ignore = readFileSync(new URL('../.vercelignore', import.meta.url), 'utf8').split('\n');
  for (const entry of ['data/', '.env', '.env.*', '*.db']) assert.ok(ignore.includes(entry), `.vercelignore excludes ${entry}`);
  const handler = readFileSync(new URL('../api/handler.js', import.meta.url), 'utf8');
  assert.match(handler, /export default createVercelHandler\(\)/);
});
